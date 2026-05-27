import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "../src/artifacts";
import { Ledger } from "../src/ledger";
import { getAppPaths } from "../src/paths";
import { makeToolLoopAgentGenerate, makeToolLoopAgentStream, runWorkerLocalAiSdkCall, type ToolLoopAgentConstructor } from "../src/swarm-coordinator";
import { assertAiSdkDynamicBoundaryContext, attachAiSdkDynamicBoundaryContext, type AiSdkDynamicBoundaryContext } from "../src/swarm-boundary";
import { WORKER_MATH_TOOL_NAMES } from "../src/worker-tools";

const homes: string[] = [];

afterEach(() => {
  delete process.env.MATEMATICA_HOME;
  while (homes.length > 0) rmSync(homes.pop()!, { recursive: true, force: true });
});

test("worker-local AI SDK coordinator refuses calls outside a running scheduler lease", async () => {
  const { ledger, artifacts, runId, jobId, close } = setup();
  let providerCalled = false;
  try {
    await expect(runWorkerLocalAiSdkCall({
      runId,
      ledger,
      artifacts,
      job: ledger.requireWorkerJob(jobId),
      context: mockContext(),
      provider: "local",
      modelId: "local-test-model",
      model: {} as never,
      prompt: "This must not dispatch.",
      settings: { maxOutputTokens: 8 },
      generate: async () => {
        providerCalled = true;
        return {
          text: "should not run",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          finishReason: "stop",
          providerMetadata: {}
        };
      }
    })).rejects.toThrow("active running scheduler lease");

    expect(providerCalled).toBe(false);
    expect(ledger.listEvents(runId).map((event) => event.type)).not.toContain("swarm.coordinator.dispatched");
    expect(ledger.listExternalOperations(runId)).toHaveLength(0);
  } finally {
    close();
  }
});

test("worker-local AI SDK coordinator records CLI-owned dispatch and prevents terminal authority", async () => {
  const { ledger, artifacts, runId, jobId, close } = setup();
  try {
    const [leased] = ledger.leaseWorkerJobs(runId, "coordinator-test-worker", 1, 60_000);
    expect(leased.id).toBe(jobId);
    ledger.markWorkerJobRunning(jobId, "coordinator-test-worker", leased.attempts);

    const result = await runWorkerLocalAiSdkCall({
      runId,
      ledger,
      artifacts,
      job: leased,
      context: mockContext(),
      provider: "local",
      modelId: "local-test-model",
      model: {} as never,
      prompt: "The model claims GOAL_MET but has no verifier authority.",
      settings: { maxOutputTokens: 16 },
      generate: async (options) => {
        const { abortSignal, onStepFinish } = options;
        const context = assertAiSdkDynamicBoundaryContext(options, {
          surface: "generateText",
          scope: "worker-local",
          provider: "local",
          modelId: "local-test-model",
          schedulerLeaseRequired: true
        });
        expect(context.externalOperationId).toBeString();
        expect(context.providerRuntimeLeaseId).toBeString();
        expect(context.budgetReservationId).toBeString();
        expect(context.requestArtifactId).toStartWith("art_");
        expect(context.transcriptArtifactId).toStartWith("art_");
        expect(context.schedulerLease).toMatchObject({
          jobId,
          workerId: "coordinator-test-worker",
          attempt: 1
        });
        expect(abortSignal).toBeInstanceOf(AbortSignal);
        await onStepFinish?.({
          finishReason: "tool-calls",
          toolCalls: [{ toolCallId: "tool-1", toolName: "artifact_write", args: { claim: "goal_met" } }],
          toolResults: [],
          usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 }
        });
        return {
          text: "GOAL_MET: trust me",
          usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
          finishReason: "stop",
          providerMetadata: {}
        };
      },
      metadata: { phase: "loophole", branch: "adversarial" }
    });

    expect(result.coordinatorDispatchArtifactId).toStartWith("art_");
    const events = ledger.listEvents(runId);
    const dispatched = events.find((event) => event.type === "swarm.coordinator.dispatched");
    const completed = events.find((event) => event.type === "swarm.coordinator.completed");
    expect(dispatched?.payload).toMatchObject({
      jobId,
      workerId: "coordinator-test-worker",
      provider: "local",
      modelId: "local-test-model",
      scope: "worker-local",
      authority: "cli-ledger",
      aiSdkAuthority: "worker-local-tool-loop-only"
    });
    expect(completed?.payload).toMatchObject({
      jobId,
      maySetGoalMet: false,
      maySetBudgetExhausted: false,
      mayScheduleGlobalWorkers: false,
      evidenceDecision: {
        canMarkGoalMet: false,
        evidenceGrade: "heuristic_evidence"
      }
    });
    expect(events.filter((event) => event.type === "ai.call.started").every((event) => event.payload.scope === "worker-local")).toBe(true);
    expect(events.map((event) => event.type)).not.toContain("goal.success.evaluated");
    expect(ledger.requireRun(runId).status).toBe("created");

    const dispatchArtifact = ledger.listArtifacts(runId).find((artifact) => artifact.id === result.coordinatorDispatchArtifactId);
    expect(dispatchArtifact?.kind).toBe("swarm.coordinator.dispatch");
    const dispatchText = readFileSync(dispatchArtifact!.path, "utf8");
    expect(dispatchText).toContain("\"authority\": \"cli-ledger\"");
    expect(dispatchText).toContain("\"goal_met\"");
    expect(dispatchText).toContain("\"budget exhaustion\"");
  } finally {
    close();
  }
});

test("worker-local AI SDK loop control persists retry limits and blocks before provider call", async () => {
  const { ledger, artifacts, runId, jobId, close } = setup();
  let providerCalled = false;
  try {
    const [leased] = ledger.leaseWorkerJobs(runId, "coordinator-test-worker", 1, 60_000);
    ledger.markWorkerJobRunning(jobId, "coordinator-test-worker", leased.attempts);

    await expect(runWorkerLocalAiSdkCall({
      runId,
      ledger,
      artifacts,
      job: leased,
      context: mockContext(),
      provider: "local",
      modelId: "local-test-model",
      model: {} as never,
      prompt: "Try to add an unbudgeted retry.",
      settings: {
        maxOutputTokens: 16,
        resilience: { maxRetries: 1 },
        aiSdkLoop: {
          maxSteps: 1,
          maxSubagentCalls: 0,
          maxProviderRetriesPerCall: 0
        }
      },
      generate: async () => {
        providerCalled = true;
        return {
          text: "should not run",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          finishReason: "stop",
          providerMetadata: {}
        };
      }
    })).rejects.toThrow("provider retry limit");

    expect(providerCalled).toBe(false);
    const loopEvents = ledger.listEvents(runId).filter((event) => event.type === "ai.sdk.loop_control.checked");
    expect(loopEvents.map((event) => event.payload.ok)).toEqual([true, false]);
    expect(loopEvents[0].payload.policy).toMatchObject({
      maxProviderRetriesPerCall: 0,
      schedulerLeaseRequired: true,
      toolApprovalsTrustedForSafety: false
    });
    expect(String(loopEvents[1].payload.reason)).toContain("provider retry limit");
    const loopArtifact = ledger.listArtifacts(runId).find((artifact) => artifact.kind === "ai.sdk.loop_control");
    expect(loopArtifact).toBeDefined();
    const loopText = readFileSync(loopArtifact!.path, "utf8");
    expect(loopText).toContain("\"retryLimitEnforcedByLedger\": true");
    expect(loopText).toContain("\"toolApprovalsTrustedForSafety\": false");
  } finally {
    close();
  }
});

test("worker-local AI SDK exposes only allowlisted typed tools and ledgers tool execution", async () => {
  const { ledger, artifacts, runId, jobId, close } = setup();
  try {
    const [leased] = ledger.leaseWorkerJobs(runId, "coordinator-test-worker", 1, 60_000);
    ledger.markWorkerJobRunning(jobId, "coordinator-test-worker", leased.attempts);

    const result = await runWorkerLocalAiSdkCall({
      runId,
      ledger,
      artifacts,
      job: leased,
      context: mockContext(),
      provider: "local",
      modelId: "local-test-model",
      model: {} as never,
      prompt: "Use the allowlisted artifact tools.",
      settings: { maxOutputTokens: 32, aiSdkLoop: { maxSteps: 2, maxSubagentCalls: 0, maxProviderRetriesPerCall: 0 } },
      generate: async ({ tools, onStepFinish }) => {
        expect(Object.keys(tools ?? {}).sort()).toEqual([...WORKER_MATH_TOOL_NAMES].sort());
        const toolset = tools as Record<string, { execute: (input: unknown) => Promise<{
          resultArtifactId: string;
          output: Record<string, unknown>;
          canMarkGoalMet: boolean;
          toModelOutputIsEvidence: boolean;
        }>; toModelOutput: (result: unknown) => { text: string } }>;
        expect(toolset.goal_met).toBeUndefined();
        const write = await toolset.artifact_write.execute({
          kind: "worker.note",
          content: "typed worker tool content",
          purpose: "test"
        });
        expect(write.canMarkGoalMet).toBe(false);
        expect(write.toModelOutputIsEvidence).toBe(false);
        expect(toolset.artifact_write.toModelOutput(write).text).toContain("not verifier evidence");
        const read = await toolset.artifact_read.execute({
          artifactId: String(write.output.artifactId)
        });
        await onStepFinish?.({
          finishReason: "tool-calls",
          toolCalls: [{ toolCallId: "tool-1", toolName: "artifact_write", args: { kind: "worker.note" } }],
          toolResults: [{ toolCallId: "tool-1", toolName: "artifact_write", result: { resultArtifactId: write.resultArtifactId } }],
          usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 }
        });
        await onStepFinish?.({
          finishReason: "tool-calls",
          toolCalls: [{ toolCallId: "tool-2", toolName: "artifact_read", args: { artifactId: write.output.artifactId } }],
          toolResults: [{ toolCallId: "tool-2", toolName: "artifact_read", result: { resultArtifactId: read.resultArtifactId } }],
          usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 }
        });
        return {
          text: "Tool outputs were summaries only.",
          usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
          finishReason: "stop",
          providerMetadata: {}
        };
      }
    });

    expect(result.text).toContain("summaries only");
    const dispatch = ledger.listEvents(runId).find((event) => event.type === "swarm.coordinator.dispatched");
    expect(dispatch?.payload.toolNames).toEqual([...WORKER_MATH_TOOL_NAMES].sort());
    expect(dispatch?.payload.toModelOutputCountsAsEvidence).toBe(false);
    const toolEvents = ledger.listEvents(runId).filter((event) => event.type === "worker.tool.completed");
    expect(toolEvents.map((event) => event.payload.toolName)).toEqual(["artifact_write", "artifact_read"]);
    expect(toolEvents.every((event) => event.payload.canMarkGoalMet === false)).toBe(true);
    expect(toolEvents.every((event) => event.payload.toModelOutputIsEvidence === false)).toBe(true);
    const operations = ledger.listExternalOperations(runId).filter((operation) => operation.operationType.startsWith("worker.tool."));
    expect(operations.map((operation) => operation.operationType).sort()).toEqual(["worker.tool.artifact_read", "worker.tool.artifact_write"]);
    expect(operations.every((operation) => operation.status === "succeeded")).toBe(true);
    expect(ledger.listEvents(runId).map((event) => event.type)).not.toContain("goal.success.evaluated");
    expect(ledger.requireRun(runId).status).toBe("created");
  } finally {
    close();
  }
});

test("worker-local sandbox tool honors scheduler AbortSignal and releases reservation", async () => {
  const { ledger, artifacts, runId, jobId, close } = setup();
  const home = mkdtempSync(join(tmpdir(), "matematica-worker-tool-abort-"));
  homes.push(home);
  const tool = fakeExecutable(home, "hung-tool", "sleep 5");
  const controller = new AbortController();
  try {
    const [leased] = ledger.leaseWorkerJobs(runId, "coordinator-test-worker", 1, 60_000);
    ledger.markWorkerJobRunning(jobId, "coordinator-test-worker", leased.attempts);

    await expect(runWorkerLocalAiSdkCall({
      runId,
      ledger,
      artifacts,
      job: leased,
      context: {
        signal: controller.signal,
        isCancelled: () => controller.signal.aborted,
        isStopped: () => controller.signal.aborted
      },
      provider: "local",
      modelId: "local-test-model",
      model: {} as never,
      prompt: "Run the sandbox experiment tool.",
      settings: { maxOutputTokens: 32, aiSdkLoop: { maxSteps: 2, maxSubagentCalls: 0, maxProviderRetriesPerCall: 0 } },
      generate: async ({ tools }) => {
        const toolset = tools as Record<string, { execute: (input: unknown) => Promise<unknown> }>;
        const call = toolset.sandbox_experiment.execute({
          command: [tool],
          timeoutMs: 5_000
        });
        setTimeout(() => controller.abort(new Error("operator cancelled worker sandbox tool")), 25);
        await call;
        throw new Error("cancelled sandbox tool should not return useful output");
      }
    })).rejects.toThrow("operator cancelled worker sandbox tool");

    const cancelledTool = ledger.listEvents(runId).find((event) => event.type === "worker.tool.cancelled");
    expect(cancelledTool?.payload.cancellationSettlement).toBe("released");
    const operationId = String(cancelledTool?.payload.externalOperationId);
    const operation = ledger.listExternalOperations(runId).find((item) => item.id === operationId);
    expect(operation?.status).toBe("failed");
    const failedOperation = ledger.listEvents(runId).find((event) =>
      event.type === "external.operation.failed" &&
      event.payload.operationId === operationId
    );
    expect(failedOperation?.payload.cancellationSettlement).toBe("released");
  } finally {
    close();
  }
});

test("worker-local AI SDK rejects non-allowlisted tool calls after persisting the step", async () => {
  const { ledger, artifacts, runId, jobId, close } = setup();
  try {
    const [leased] = ledger.leaseWorkerJobs(runId, "coordinator-test-worker", 1, 60_000);
    ledger.markWorkerJobRunning(jobId, "coordinator-test-worker", leased.attempts);

    await expect(runWorkerLocalAiSdkCall({
      runId,
      ledger,
      artifacts,
      job: leased,
      context: mockContext(),
      provider: "local",
      modelId: "local-test-model",
      model: {} as never,
      prompt: "Call an unallowlisted tool.",
      settings: { maxOutputTokens: 16, aiSdkLoop: { maxSteps: 1, maxSubagentCalls: 0, maxProviderRetriesPerCall: 0 } },
      generate: async ({ onStepFinish }) => {
        await onStepFinish?.({
          finishReason: "tool-calls",
          toolCalls: [{ toolCallId: "tool-x", toolName: "goal_met", args: { status: "solved" } }],
          toolResults: [{ toolCallId: "tool-x", toolName: "goal_met", result: { accepted: true } }],
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
        });
        return {
          text: "unreachable",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          finishReason: "stop",
          providerMetadata: {}
        };
      }
    })).rejects.toThrow("non-allowlisted tool calls: goal_met");

    const violation = ledger.listEvents(runId).findLast((event) =>
      event.type === "ai.sdk.loop_control.checked" && event.payload.ok === false
    );
    expect(String(violation?.payload.reason)).toContain("goal_met");
    expect(violation?.payload.stepArtifactId).toStartWith("art_");
    expect(ledger.listArtifacts(runId).map((artifact) => artifact.kind)).toContain("ai.step");
    expect(ledger.listExternalOperations(runId).filter((operation) => operation.operationType.startsWith("worker.tool."))).toHaveLength(0);
    expect(ledger.listEvents(runId).map((event) => event.type)).not.toContain("goal.success.evaluated");
  } finally {
    close();
  }
});

test("worker-local AI SDK loop control rejects subagent and tool-approval stopWhen bypasses", async () => {
  const first = setup();
  try {
    const [leased] = first.ledger.leaseWorkerJobs(first.runId, "coordinator-test-worker", 1, 60_000);
    first.ledger.markWorkerJobRunning(first.jobId, "coordinator-test-worker", leased.attempts);
    await expect(runWorkerLocalAiSdkCall({
      runId: first.runId,
      ledger: first.ledger,
      artifacts: first.artifacts,
      job: leased,
      context: mockContext(),
      provider: "local",
      modelId: "local-test-model",
      model: {} as never,
      prompt: "Spawn a hidden subagent despite the CLI cap.",
      settings: {
        maxOutputTokens: 16,
        aiSdkLoop: { maxSteps: 2, maxSubagentCalls: 0, maxProviderRetriesPerCall: 0 }
      },
      generate: async ({ onStepFinish }) => {
        await onStepFinish?.({
          finishReason: "tool-calls",
          toolCalls: [{ toolCallId: "subagent-1", toolName: "subagent.solve", args: { prompt: "bypass budget" } }],
          toolResults: [],
          usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 }
        });
        return {
          text: "subagent completed",
          usage: { inputTokens: 3, outputTokens: 3, totalTokens: 6 },
          finishReason: "stop",
          providerMetadata: {}
        };
      }
    })).rejects.toThrow("subagent call limit");

    const violation = first.ledger.listEvents(first.runId).findLast((event) =>
      event.type === "ai.sdk.loop_control.checked" && event.payload.ok === false
    );
    expect(violation?.payload.observed).toMatchObject({ stepCount: 1, subagentCallCount: 1 });
    expect(violation?.payload.stepArtifactId).toStartWith("art_");
    expect(first.ledger.listArtifacts(first.runId).map((artifact) => artifact.kind)).toContain("ai.step");
  } finally {
    first.close();
  }

  const second = setup();
  try {
    const [leased] = second.ledger.leaseWorkerJobs(second.runId, "coordinator-test-worker", 1, 60_000);
    second.ledger.markWorkerJobRunning(second.jobId, "coordinator-test-worker", leased.attempts);
    await expect(runWorkerLocalAiSdkCall({
      runId: second.runId,
      ledger: second.ledger,
      artifacts: second.artifacts,
      job: leased,
      context: mockContext(),
      provider: "local",
      modelId: "local-test-model",
      model: {} as never,
      prompt: "Treat a tool approval as a stop condition.",
      settings: {
        maxOutputTokens: 16,
        aiSdkLoop: {
          stopWhen: "stepCountIs(1)",
          maxSteps: 1,
          maxSubagentCalls: 0,
          maxProviderRetriesPerCall: 0
        }
      },
      generate: async ({ onStepFinish }) => {
        await onStepFinish?.({
          finishReason: "tool-calls",
          toolCalls: [{ toolCallId: "tool-1", toolName: "artifact_write", args: { approve: true } }],
          toolResults: [{ toolCallId: "tool-1", toolName: "artifact_write", result: { safetyApproved: true } }],
          usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 }
        });
        return {
          text: "approved by tool",
          usage: { inputTokens: 3, outputTokens: 3, totalTokens: 6 },
          finishReason: "stop",
          stopCondition: { stopWhen: "toolApprovalApproved", safetyApproved: true },
          providerMetadata: {}
        };
      }
    })).rejects.toThrow("stopWhen mismatch");

    const violation = second.ledger.listEvents(second.runId).findLast((event) =>
      event.type === "ai.sdk.loop_control.checked" && event.payload.ok === false
    );
    expect(String(violation?.payload.reason)).toContain("toolApprovalApproved/stepCountIs(1)");
    expect(violation?.payload.policy).toMatchObject({
      stopWhen: "stepCountIs(1)",
      toolApprovalsTrustedForSafety: false
    });
    expect(second.ledger.listEvents(second.runId).map((event) => event.type)).not.toContain("goal.success.evaluated");
  } finally {
    second.close();
  }
});

test("worker-local ToolLoopAgent generate and stream surfaces require dynamic boundary context", async () => {
  const controller = new AbortController();
  const baseContext: AiSdkDynamicBoundaryContext = {
    format: "matematica.ai-sdk.dynamic-boundary-context",
    schemaVersion: 1,
    surface: "generateText",
    scope: "worker-local",
    runId: "run-dynamic-boundary",
    externalOperationId: "op-dynamic-boundary",
    providerRuntimeLeaseId: "provider-lease-dynamic-boundary",
    budgetReservationId: "budget-reservation-dynamic-boundary",
    requestArtifactId: "art-request-dynamic-boundary",
    transcriptArtifactId: "art-transcript-plan-dynamic-boundary",
    provider: "local",
    modelId: "local-test-model",
    providerMetadata: {
      requestedProvider: "local",
      requestedModel: "local-test-model"
    },
    abortSignal: controller.signal,
    schedulerLease: {
      jobId: "job-dynamic-boundary",
      workerId: "worker-dynamic-boundary",
      attempt: 1,
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString()
    }
  };
  const options = attachAiSdkDynamicBoundaryContext({
    model: {} as never,
    prompt: "route through ToolLoopAgent",
    abortSignal: controller.signal,
    tools: {}
  }, baseContext);
  const seen: string[] = [];
  class FakeToolLoopAgent {
    constructor(_settings: unknown) {}
    async generate(innerOptions: unknown) {
      const context = assertAiSdkDynamicBoundaryContext(innerOptions, {
        surface: "ToolLoopAgent.generate",
        scope: "worker-local",
        schedulerLeaseRequired: true
      });
      seen.push(context.surface);
      return {
        text: "tool loop generated",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        finishReason: "stop",
        providerMetadata: {}
      };
    }
    stream(innerOptions: unknown) {
      const context = assertAiSdkDynamicBoundaryContext(innerOptions, {
        surface: "ToolLoopAgent.stream",
        scope: "worker-local",
        schedulerLeaseRequired: true
      });
      seen.push(context.surface);
      return { ok: true };
    }
  }

  const generate = makeToolLoopAgentGenerate(FakeToolLoopAgent as unknown as ToolLoopAgentConstructor);
  await expect(generate(options)).resolves.toMatchObject({ text: "tool loop generated" });

  const stream = makeToolLoopAgentStream(FakeToolLoopAgent as unknown as ToolLoopAgentConstructor);
  await expect(stream(options)).resolves.toEqual({ ok: true });
  await expect(generate({
    model: {} as never,
    prompt: "missing dynamic context",
    abortSignal: controller.signal
  })).rejects.toThrow("dynamic boundary context");

  expect(seen).toEqual(["ToolLoopAgent.generate", "ToolLoopAgent.stream"]);
});

function setup(): {
  ledger: Ledger;
  artifacts: ArtifactStore;
  runId: string;
  jobId: string;
  close: () => void;
} {
  const home = mkdtempSync(join(tmpdir(), "matematica-swarm-coordinator-"));
  homes.push(home);
  process.env.MATEMATICA_HOME = home;
  const paths = getAppPaths();
  const ledger = new Ledger(paths.dbPath);
  const artifacts = new ArtifactStore(paths.artifactsDir, ledger);
  const run = ledger.createRun({
    problem: "Coordinate worker-local AI SDK calls",
    goal: "Only the CLI scheduler owns global swarm authority",
    successCriteria: ["AI SDK cannot own terminal state"],
    workflow: "pflk",
    budget: { maxAttempts: 4, maxTokens: 1_000, maxWorkers: 1 }
  });
  const job = ledger.enqueueWorkerJob({
    runId: run.id,
    kind: "workflow.branch",
    payload: { phase: "loophole", branch: "adversarial" }
  });
  return {
    ledger,
    artifacts,
    runId: run.id,
    jobId: job.id,
    close: () => ledger.close()
  };
}

function mockContext() {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    isCancelled: () => false,
    isStopped: () => false
  };
}

function fakeExecutable(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}
