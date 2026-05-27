import { ToolLoopAgent, type LanguageModel } from "ai";
import type { ArtifactStore } from "./artifacts";
import type { ProviderName } from "./config";
import type { WorkerJob } from "./domain";
import { stableHash } from "./idempotency";
import { generateInstrumentedText, type GenerateTextFunction, type InstrumentedTextCall, type InstrumentedTextResult } from "./ai/instrumented";
import type { Ledger } from "./ledger";
import type { WorkerExecutionContext } from "./scheduler";
import {
  assertAiSdkDynamicBoundaryContext,
  attachAiSdkDynamicBoundaryContext,
  classifyAiSdkSummaryEvidence
} from "./swarm-boundary";
import { buildWorkerMathTools, workerToolNames, type WorkerToolSet } from "./worker-tools";

export type WorkerLocalAiSdkCoordinatorInput = {
  runId: string;
  ledger: Ledger;
  artifacts: ArtifactStore;
  job: WorkerJob;
  context: WorkerExecutionContext;
  provider: ProviderName;
  modelId: string;
  model: LanguageModel;
  prompt: string;
  settings?: InstrumentedTextCall["settings"];
  generate?: GenerateTextFunction;
  metadata?: Record<string, unknown>;
  tools?: WorkerToolSet;
};

export type WorkerLocalAiSdkCoordinatorResult = InstrumentedTextResult & {
  coordinatorDispatchArtifactId: string;
  coordinatorDispatchEventId: string;
  coordinatorTerminalEventId: string;
};

type ToolLoopAgentLike = {
  generate: (options: Omit<Parameters<GenerateTextFunction>[0], "model">) => ReturnType<GenerateTextFunction>;
  stream?: (options: Omit<Parameters<GenerateTextFunction>[0], "model">) => unknown;
};

export type ToolLoopAgentConstructor = new (settings: {
  model: LanguageModel;
  tools: never;
  instructions: string;
}) => ToolLoopAgentLike;

export async function runWorkerLocalAiSdkCall(
  input: WorkerLocalAiSdkCoordinatorInput
): Promise<WorkerLocalAiSdkCoordinatorResult> {
  const liveJob = input.ledger.requireWorkerJob(input.job.id);
  if (liveJob.runId !== input.runId) {
    throw new Error(`Worker-local AI SDK coordinator received job ${liveJob.id} from another run.`);
  }
  if (liveJob.status !== "running") {
    throw new Error(`Worker-local AI SDK calls require an active running scheduler lease; job ${liveJob.id} is ${liveJob.status}.`);
  }
  if (!liveJob.leaseOwner) {
    throw new Error(`Worker-local AI SDK calls require a scheduler-owned lease for job ${liveJob.id}.`);
  }
  if (input.context.isStopped()) {
    throw new Error("Worker-local AI SDK coordinator refuses dispatch after the run reached a terminal state.");
  }
  if (input.context.signal.aborted) {
    throw new Error("Worker-local AI SDK coordinator refuses dispatch with an already-aborted scheduler signal.");
  }

  const promptHash = stableHash({ prompt: input.prompt });
  const workerTools = input.tools ?? buildWorkerMathTools({
    runId: input.runId,
    ledger: input.ledger,
    artifacts: input.artifacts,
    job: liveJob,
    workerId: liveJob.leaseOwner,
    attempt: liveJob.attempts,
    signal: input.context.signal
  });
  const toolNames = workerToolNames(workerTools);
  const dispatchArtifact = input.artifacts.create(input.runId, "swarm.coordinator.dispatch", JSON.stringify({
    format: "matematica.swarm-coordinator.worker-local-ai-sdk-call",
    version: 1,
    authority: "cli-ledger",
    aiSdkAuthority: "worker-local-tool-loop-only",
    forbiddenAiSdkAuthorities: [
      "global worker scheduling",
      "worker lease ownership",
      "budget reservation",
      "budget exhaustion",
      "provider admission",
      "goal_met",
      "evidence grade promotion",
      "terminal run status"
    ],
    workerLease: {
      runId: liveJob.runId,
      jobId: liveJob.id,
      kind: liveJob.kind,
      workerId: liveJob.leaseOwner,
      attempt: liveJob.attempts,
      leaseExpiresAt: liveJob.leaseExpiresAt
    },
    providerRoute: {
      provider: input.provider,
      modelId: input.modelId
    },
    workerTools: {
      allowlisted: toolNames,
      authority: "cli-ledger",
      executeThroughExternalOperations: true,
      toModelOutputCountsAsEvidence: false,
      forbiddenToolAuthorities: [
        "budget mutation",
        "global worker scheduling",
        "provider admission",
        "evidence grade promotion",
        "terminal run status"
      ]
    },
    promptHash,
    schedulerSignal: {
      required: true,
      abortedAtDispatch: input.context.signal.aborted
    },
    metadata: input.metadata ?? {}
  }, null, 2));
  const dispatchEvent = input.ledger.appendEvent(input.runId, "swarm.coordinator.dispatched", {
    jobId: liveJob.id,
    kind: liveJob.kind,
    workerId: liveJob.leaseOwner,
    attempt: liveJob.attempts,
    provider: input.provider,
    modelId: input.modelId,
    scope: "worker-local",
    authority: "cli-ledger",
    aiSdkAuthority: "worker-local-tool-loop-only",
    promptHash,
    dispatchArtifactId: dispatchArtifact.id,
    toolNames,
    toolAuthority: "cli-ledger-external-operations",
    toModelOutputCountsAsEvidence: false,
    metadata: input.metadata ?? {}
  }, [dispatchArtifact.id]);

  try {
    const output = await generateInstrumentedText({
      runId: input.runId,
      ledger: input.ledger,
      artifacts: input.artifacts,
      provider: input.provider,
      modelId: input.modelId,
      model: input.model,
      prompt: input.prompt,
      scope: "worker-local",
      settings: {
        ...(input.settings ?? { maxOutputTokens: 800 }),
        abortSignal: input.context.signal
      },
      tools: workerTools,
      schedulerLease: {
        jobId: liveJob.id,
        workerId: liveJob.leaseOwner,
        attempt: liveJob.attempts
      },
      generate: input.generate ?? makeToolLoopAgentGenerate()
    });
    const evidenceDecision = classifyAiSdkSummaryEvidence(output.text);
    const terminalEvent = input.ledger.appendEvent(input.runId, "swarm.coordinator.completed", {
      jobId: liveJob.id,
      workerId: liveJob.leaseOwner,
      attempt: liveJob.attempts,
      provider: input.provider,
      modelId: input.modelId,
      scope: "worker-local",
      authority: "cli-ledger",
      aiSdkAuthority: "worker-local-tool-loop-only",
      requestArtifactId: output.requestArtifactId,
      responseArtifactId: output.responseArtifactId,
      transcriptArtifactId: output.transcriptArtifactId,
      stepArtifactIds: output.stepArtifactIds,
      streamChunkArtifactIds: output.streamChunkArtifactIds,
      toolNames,
      evidenceDecision,
      toModelOutputCountsAsEvidence: false,
      maySetGoalMet: false,
      maySetBudgetExhausted: false,
      mayScheduleGlobalWorkers: false
    }, [
      dispatchArtifact.id,
      output.requestArtifactId,
      output.responseArtifactId,
      ...(output.transcriptArtifactId ? [output.transcriptArtifactId] : []),
      ...output.stepArtifactIds,
      ...output.streamChunkArtifactIds
    ]);
    return {
      ...output,
      coordinatorDispatchArtifactId: dispatchArtifact.id,
      coordinatorDispatchEventId: dispatchEvent.id,
      coordinatorTerminalEventId: terminalEvent.id
    };
  } catch (error) {
    const terminalEvent = input.ledger.appendEvent(input.runId, "swarm.coordinator.failed", {
      jobId: liveJob.id,
      workerId: liveJob.leaseOwner,
      attempt: liveJob.attempts,
      provider: input.provider,
      modelId: input.modelId,
      scope: "worker-local",
      authority: "cli-ledger",
      aiSdkAuthority: "worker-local-tool-loop-only",
      errorName: error instanceof Error ? error.name : "UnknownError",
      errorMessage: error instanceof Error ? error.message : String(error),
      maySetGoalMet: false,
      maySetBudgetExhausted: false,
      mayScheduleGlobalWorkers: false
    }, [dispatchArtifact.id]);
    void terminalEvent;
    throw error;
  }
}

export function makeToolLoopAgentGenerate(Agent: ToolLoopAgentConstructor = ToolLoopAgent as unknown as ToolLoopAgentConstructor): GenerateTextFunction {
  return async function generateWithToolLoopAgent(options: Parameters<GenerateTextFunction>[0]): ReturnType<GenerateTextFunction> {
    const parentContext = assertAiSdkDynamicBoundaryContext(options, {
      surface: "generateText",
      scope: "worker-local",
      schedulerLeaseRequired: true
    });
    const agent = new Agent({
      model: options.model,
      tools: (options.tools ?? {}) as never,
      instructions: workerLocalToolLoopInstructions()
    });
    const generateOptions: Omit<Parameters<GenerateTextFunction>[0], "model"> = {
      prompt: options.prompt,
      temperature: options.temperature,
      maxOutputTokens: options.maxOutputTokens,
      abortSignal: options.abortSignal,
      timeout: options.timeout,
      onStepFinish: options.onStepFinish
    };
    if (options.tools) generateOptions.tools = options.tools;
    attachAiSdkDynamicBoundaryContext(generateOptions, {
      ...parentContext,
      surface: "ToolLoopAgent.generate"
    });
    assertAiSdkDynamicBoundaryContext(generateOptions, {
      surface: "ToolLoopAgent.generate",
      scope: "worker-local",
      schedulerLeaseRequired: true
    });
    return await agent.generate(generateOptions);
  };
}

export function makeToolLoopAgentStream(Agent: ToolLoopAgentConstructor = ToolLoopAgent as unknown as ToolLoopAgentConstructor) {
  return async function streamWithToolLoopAgent(options: Parameters<GenerateTextFunction>[0]): Promise<unknown> {
    const parentContext = assertAiSdkDynamicBoundaryContext(options, {
      scope: "worker-local",
      schedulerLeaseRequired: true
    });
    const agent = new Agent({
      model: options.model,
      tools: (options.tools ?? {}) as never,
      instructions: workerLocalToolLoopInstructions()
    });
    if (!agent.stream) {
      throw new Error("ToolLoopAgent stream surface is unavailable.");
    }
    const streamOptions: Omit<Parameters<GenerateTextFunction>[0], "model"> = {
      prompt: options.prompt,
      temperature: options.temperature,
      maxOutputTokens: options.maxOutputTokens,
      abortSignal: options.abortSignal,
      timeout: options.timeout,
      onStepFinish: options.onStepFinish
    };
    if (options.tools) streamOptions.tools = options.tools;
    attachAiSdkDynamicBoundaryContext(streamOptions, {
      ...parentContext,
      surface: "ToolLoopAgent.stream"
    });
    assertAiSdkDynamicBoundaryContext(streamOptions, {
      surface: "ToolLoopAgent.stream",
      scope: "worker-local",
      schedulerLeaseRequired: true
    });
    return agent.stream(streamOptions);
  };
}

function workerLocalToolLoopInstructions(): string {
  return "Execute exactly one worker-local AI SDK tool loop for the leased Matematica worker. Do not make scheduling, budget, provider-admission, verifier, or terminal-status decisions.";
}
