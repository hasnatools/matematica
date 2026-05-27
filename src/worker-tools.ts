import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { ArtifactStore } from "./artifacts";
import { isAbortError, throwIfAborted } from "./cancellation";
import type { WorkerJob } from "./domain";
import { externalOperationIdempotencyKey, stableHash } from "./idempotency";
import type { Ledger } from "./ledger";
import { redactJson } from "./redaction";
import { runSandboxedCommand } from "./sandbox";
import { readArtifactText } from "./storage-encryption";

export const WORKER_MATH_TOOL_NAMES = [
  "artifact_read",
  "artifact_write",
  "cached_arxiv_lookup",
  "mathlib_lookup",
  "sandbox_experiment",
  "lean_check",
  "verifier_handoff"
] as const;

export type WorkerMathToolName = typeof WORKER_MATH_TOOL_NAMES[number];

export type WorkerToolResult = {
  format: "matematica.worker-tool-result";
  version: 1;
  toolName: WorkerMathToolName;
  externalOperationId: string;
  requestArtifactId: string;
  resultArtifactId: string;
  artifactIds: string[];
  evidenceGrade: "heuristic_evidence";
  canMarkGoalMet: false;
  toModelOutputIsEvidence: false;
  summary: string;
  output: Record<string, unknown>;
};

export type WorkerToolDefinition = {
  description: string;
  inputSchema: z.ZodType;
  execute: (input: unknown) => Promise<WorkerToolResult>;
  toModelOutput: (result: WorkerToolResult) => {
    type: "text";
    text: string;
  };
};

export type WorkerToolSet = Record<WorkerMathToolName, WorkerToolDefinition>;

export type WorkerToolContext = {
  runId: string;
  ledger: Ledger;
  artifacts: ArtifactStore;
  job: WorkerJob;
  workerId: string;
  attempt: number;
  cwd?: string;
  signal?: AbortSignal;
};

const artifactReadInput = z.object({
  artifactId: z.string().min(1)
});

const artifactWriteInput = z.object({
  kind: z.string().min(1),
  content: z.string(),
  purpose: z.string().min(1).optional()
});

const cachedLookupInput = z.object({
  query: z.string().min(1),
  maxResults: z.number().int().min(1).max(20).optional()
});

const sandboxExperimentInput = z.object({
  command: z.array(z.string().min(1)).min(1).max(16),
  timeoutMs: z.number().int().min(1).max(30_000).optional()
});

const leanCheckInput = z.object({
  source: z.string().min(1),
  timeoutMs: z.number().int().min(1).max(30_000).optional()
});

const verifierHandoffInput = z.object({
  claim: z.string().min(1),
  artifactIds: z.array(z.string().min(1)).max(32).optional(),
  verifier: z.string().min(1).optional()
});

export function buildWorkerMathTools(context: WorkerToolContext): WorkerToolSet {
  const makeTool = <Schema extends z.ZodType>(
    toolName: WorkerMathToolName,
    description: string,
    inputSchema: Schema,
    run: (input: z.infer<Schema>) => Promise<{ summary: string; output: Record<string, unknown>; artifactIds?: string[] }>
  ): WorkerToolDefinition => ({
    description,
    inputSchema,
    execute: async (rawInput: unknown) => executeWorkerTool({
      context,
      toolName,
      inputSchema,
      rawInput,
      run
    }),
    toModelOutput: (result) => ({
      type: "text",
      text: [
        `Tool ${result.toolName} completed.`,
        result.summary,
        `Result artifact: ${result.resultArtifactId}.`,
        "This tool summary is not verifier evidence and cannot mark the goal met."
      ].join(" ")
    })
  });

  return {
    artifact_read: makeTool(
      "artifact_read",
      "Read a same-run artifact by id through the CLI ledger.",
      artifactReadInput,
      async (input) => {
        const artifact = context.ledger.listArtifacts(context.runId).find((item) => item.id === input.artifactId);
        if (!artifact) throw new Error(`Artifact ${input.artifactId} is not available in this run.`);
        const text = readArtifactText(artifact);
        return {
          summary: `Read artifact ${artifact.id} (${artifact.kind}, ${text.length} bytes).`,
          output: {
            artifactId: artifact.id,
            kind: artifact.kind,
            sha256: artifact.sha256,
            bytes: text.length,
            preview: text.slice(0, 2_000)
          },
          artifactIds: [artifact.id]
        };
      }
    ),
    artifact_write: makeTool(
      "artifact_write",
      "Persist a worker-produced artifact in the append-only artifact store.",
      artifactWriteInput,
      async (input) => {
        const artifact = context.artifacts.create(context.runId, input.kind, input.content);
        return {
          summary: `Wrote artifact ${artifact.id} (${artifact.kind}).`,
          output: {
            artifactId: artifact.id,
            kind: artifact.kind,
            sha256: artifact.sha256,
            purpose: input.purpose
          },
          artifactIds: [artifact.id]
        };
      }
    ),
    cached_arxiv_lookup: makeTool(
      "cached_arxiv_lookup",
      "Record a cache-only arXiv lookup request for worker context. This tool never performs live network access.",
      cachedLookupInput,
      async (input) => ({
        summary: `Recorded cache-only arXiv lookup for "${input.query}".`,
        output: {
          query: input.query,
          maxResults: input.maxResults ?? 5,
          source: "cache-only",
          networkAccess: false,
          results: []
        }
      })
    ),
    mathlib_lookup: makeTool(
      "mathlib_lookup",
      "Record a mathlib lemma lookup request for later verified retrieval.",
      cachedLookupInput,
      async (input) => ({
        summary: `Recorded mathlib lookup for "${input.query}".`,
        output: {
          query: input.query,
          maxResults: input.maxResults ?? 5,
          source: "local-index-or-empty",
          networkAccess: false,
          results: []
        }
      })
    ),
    sandbox_experiment: makeTool(
      "sandbox_experiment",
      "Run a bounded local experiment command in the Matematica sandbox.",
      sandboxExperimentInput,
      async (input) => {
        const result = await runSandboxedCommand({
          purpose: "generated-experiment",
          command: input.command,
          cwd: context.cwd ?? process.cwd(),
          timeoutMs: input.timeoutMs ?? 5_000,
          abortSignal: context.signal
        });
        return {
          summary: `Sandbox experiment exited ${String(result.exitCode)}${result.timedOut ? " after timeout" : ""}.`,
          output: {
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            stdout: result.stdout.slice(0, 4_000),
            stderr: result.stderr.slice(0, 4_000),
            policyHash: result.policy.policyHash,
            verifierBackedEvidence: result.policy.evidence.verifierBackedEvidence
          }
        };
      }
    ),
    lean_check: makeTool(
      "lean_check",
      "Persist a Lean source handoff for verifier processing. The model-visible result is not proof evidence.",
      leanCheckInput,
      async (input) => {
        const dir = mkdtempSync(join(tmpdir(), "matematica-worker-lean-"));
        const file = join(dir, "Worker.lean");
        writeFileSync(file, input.source);
        const sourceArtifact = context.artifacts.create(context.runId, "worker.lean.source", input.source);
        return {
          summary: `Persisted Lean verifier handoff ${sourceArtifact.id}.`,
          output: {
            sourceArtifactId: sourceArtifact.id,
            sourceHash: stableHash(input.source),
            timeoutMs: input.timeoutMs ?? 30_000,
            handoff: "verifier-required-before-evidence"
          },
          artifactIds: [sourceArtifact.id]
        };
      }
    ),
    verifier_handoff: makeTool(
      "verifier_handoff",
      "Persist a candidate claim handoff for the CLI verifier pipeline.",
      verifierHandoffInput,
      async (input) => {
        const linkedArtifacts = (input.artifactIds ?? []).map((artifactId) => {
          const artifact = context.ledger.listArtifacts(context.runId).find((item) => item.id === artifactId);
          if (!artifact) throw new Error(`Artifact ${artifactId} is not available in this run.`);
          return artifact.id;
        });
        const handoffArtifact = context.artifacts.create(context.runId, "worker.verifier.handoff", JSON.stringify({
          claim: input.claim,
          verifier: input.verifier ?? "cli-verifier-pipeline",
          linkedArtifacts,
          evidenceGrade: "heuristic_evidence",
          requiresIndependentVerifier: true
        }, null, 2));
        return {
          summary: `Persisted verifier handoff ${handoffArtifact.id}.`,
          output: {
            handoffArtifactId: handoffArtifact.id,
            linkedArtifacts,
            verifier: input.verifier ?? "cli-verifier-pipeline",
            requiresIndependentVerifier: true
          },
          artifactIds: [handoffArtifact.id, ...linkedArtifacts]
        };
      }
    )
  };
}

export function workerToolNames(tools: Partial<Record<string, unknown>> | undefined): string[] {
  return Object.keys(tools ?? {}).sort();
}

async function executeWorkerTool<Schema extends z.ZodType>(input: {
  context: WorkerToolContext;
  toolName: WorkerMathToolName;
  inputSchema: Schema;
  rawInput: unknown;
  run: (input: z.infer<Schema>) => Promise<{ summary: string; output: Record<string, unknown>; artifactIds?: string[] }>;
}): Promise<WorkerToolResult> {
  const parsed = input.inputSchema.parse(input.rawInput) as z.infer<Schema>;
  const requestPayload = {
    format: "matematica.worker-tool-request",
    version: 1,
    toolName: input.toolName,
    runId: input.context.runId,
    jobId: input.context.job.id,
    workerId: input.context.workerId,
    attempt: input.context.attempt,
    input: redactJson(parsed),
    authority: "cli-ledger"
  };
  const requestHash = stableHash(requestPayload);
  const requestArtifact = input.context.artifacts.create(input.context.runId, `worker.tool.${input.toolName}.request`, JSON.stringify(requestPayload, null, 2));
  const prepared = input.context.ledger.prepareExternalOperation({
    runId: input.context.runId,
    operationType: `worker.tool.${input.toolName}`,
    provider: "worker-tool",
    idempotencyKey: externalOperationIdempotencyKey({
      runId: input.context.runId,
      operationType: `worker.tool.${input.toolName}`,
      requestHash
    }),
    requestHash,
    reserve: { elapsedMs: 1 },
    requestArtifactId: requestArtifact.id
  });
  if (!prepared.ok) {
    throw new Error(`Budget exhausted before worker tool ${input.toolName}: ${prepared.reason}`);
  }
  if (!prepared.created) {
    throw new Error(`Worker tool operation ${prepared.operation.id} already exists in status ${prepared.operation.status}; refusing duplicate execution.`);
  }
  const operation = input.context.ledger.startExternalOperation(prepared.operation.id);
  input.context.ledger.appendEvent(input.context.runId, "worker.tool.started", {
    toolName: input.toolName,
    externalOperationId: operation.id,
    requestArtifactId: requestArtifact.id,
    requestHash,
    jobId: input.context.job.id,
    workerId: input.context.workerId,
    attempt: input.context.attempt,
    authority: "cli-ledger",
    modelVisibleOutputCountsAsEvidence: false
  }, [requestArtifact.id]);

  const startedAt = Date.now();
  try {
    throwIfAborted(input.context.signal, `worker tool ${input.toolName} cancelled before execution`);
    const toolOutput = await input.run(parsed);
    const resultPayload: WorkerToolResult = {
      format: "matematica.worker-tool-result",
      version: 1,
      toolName: input.toolName,
      externalOperationId: operation.id,
      requestArtifactId: requestArtifact.id,
      resultArtifactId: "",
      artifactIds: toolOutput.artifactIds ?? [],
      evidenceGrade: "heuristic_evidence",
      canMarkGoalMet: false,
      toModelOutputIsEvidence: false,
      summary: toolOutput.summary,
      output: redactJson(toolOutput.output) as Record<string, unknown>
    };
    const resultArtifact = input.context.artifacts.create(input.context.runId, `worker.tool.${input.toolName}.result`, JSON.stringify({
      ...resultPayload,
      resultArtifactId: undefined
    }, null, 2));
    const completed: WorkerToolResult = {
      ...resultPayload,
      resultArtifactId: resultArtifact.id,
      artifactIds: [...new Set([...(toolOutput.artifactIds ?? []), resultArtifact.id])]
    };
    input.context.ledger.appendEvent(input.context.runId, "worker.tool.completed", {
      toolName: input.toolName,
      externalOperationId: operation.id,
      requestArtifactId: requestArtifact.id,
      resultArtifactId: resultArtifact.id,
      linkedArtifactIds: completed.artifactIds,
      jobId: input.context.job.id,
      workerId: input.context.workerId,
      attempt: input.context.attempt,
      evidenceGrade: completed.evidenceGrade,
      canMarkGoalMet: false,
      toModelOutputIsEvidence: false
    }, [requestArtifact.id, resultArtifact.id, ...completed.artifactIds]);
    input.context.ledger.completeExternalOperation({
      operationId: operation.id,
      responseArtifactId: resultArtifact.id,
      debit: { elapsedMs: Math.max(1, Date.now() - startedAt) },
      overReservationPolicy: {
        allowedDimensions: ["elapsedMs"],
        reason: "Worker tool success debits measured local execution time."
      },
      provider: "worker-tool",
      workerId: input.context.workerId,
      phase: String(input.context.job.payload.phase ?? "worker-tool")
    });
    return completed;
  } catch (error) {
    const errorArtifact = input.context.artifacts.create(input.context.runId, `worker.tool.${input.toolName}.error`, JSON.stringify({
      toolName: input.toolName,
      externalOperationId: operation.id,
      errorName: error instanceof Error ? error.name : "UnknownError",
      errorMessage: error instanceof Error ? error.message : String(error)
    }, null, 2));
    const cancelled = isAbortError(error);
    input.context.ledger.appendEvent(input.context.runId, cancelled ? "worker.tool.cancelled" : "worker.tool.failed", {
      toolName: input.toolName,
      externalOperationId: operation.id,
      requestArtifactId: requestArtifact.id,
      errorArtifactId: errorArtifact.id,
      jobId: input.context.job.id,
      workerId: input.context.workerId,
      attempt: input.context.attempt,
      canMarkGoalMet: false,
      cancellationSettlement: cancelled ? "released" : undefined
    }, [requestArtifact.id, errorArtifact.id]);
    input.context.ledger.failExternalOperation({
      operationId: operation.id,
      errorMessage: error instanceof Error ? error.message : String(error),
      errorArtifactId: errorArtifact.id,
      releaseReason: `worker tool ${input.toolName} failed before useful output`,
      provider: "worker-tool"
    });
    throw error;
  }
}
