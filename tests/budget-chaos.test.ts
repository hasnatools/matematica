import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "../src/artifacts";
import { generateInstrumentedText } from "../src/ai/instrumented";
import { Ledger } from "../src/ledger";
import { getAppPaths } from "../src/paths";
import { runWorkerQueue } from "../src/scheduler";

const homes: string[] = [];

afterEach(() => {
  delete process.env.MATEMATICA_HOME;
  while (homes.length > 0) rmSync(homes.pop()!, { recursive: true, force: true });
});

test("100-worker budget race closes reservations across retries and over-reservation failures", async () => {
  const home = mkdtempSync(join(tmpdir(), "matematica-budget-chaos-"));
  homes.push(home);
  process.env.MATEMATICA_HOME = home;
  const paths = getAppPaths();
  const ledger = new Ledger(paths.dbPath);
  const artifacts = new ArtifactStore(paths.artifactsDir, ledger);
  const run = ledger.createRun({
    problem: "100-worker provider budget race",
    goal: "Retries and actual-usage overruns must remain ledger-governed",
    successCriteria: ["no external operation starts without an open reservation"],
    workflow: "gree",
    budget: { maxAttempts: 300, maxWorkers: 100, maxTokens: 1_000 }
  });
  const callsByIndex = new Map<number, number>();
  const retryIndexes = new Set<number>();
  const overuseIndexes = new Set<number>();

  try {
    for (let index = 0; index < 100; index += 1) {
      ledger.enqueueWorkerJob({
        runId: run.id,
        kind: "budget.chaos.worker",
        payload: { index },
        maxAttempts: 1
      });
      if (index % 10 === 0) retryIndexes.add(index);
      if (index % 15 === 1) overuseIndexes.add(index);
    }

    const result = await runWorkerQueue({
      runId: run.id,
      ledger,
      artifacts,
      workerId: "budget-chaos-worker",
      maxWorkers: 100,
      providerConcurrency: 100,
      leaseMs: 180_000,
      reservePerJob: { attempts: 1, tokens: 1 },
      executor: async (job, context) => {
        const index = Number(job.payload.index);
        const maxRetries = retryIndexes.has(index) ? 1 : 0;
        const output = await generateInstrumentedText({
          runId: run.id,
          ledger,
          artifacts,
          provider: "local",
          modelId: "local-budget-chaos-model",
          model: {} as never,
          prompt: `w${index}`,
          scope: "worker-local",
          schedulerLease: {
            jobId: job.id,
            workerId: "budget-chaos-worker",
            attempt: job.attempts
          },
          settings: {
            maxOutputTokens: 4,
            abortSignal: context.signal,
            resilience: {
              maxRetries,
              retryBackoffMs: 0,
              maxConcurrency: 100,
              sleep: async () => undefined
            },
            aiSdkLoop: {
              maxSubagentCalls: 0,
              maxProviderRetriesPerCall: maxRetries
            }
          },
          generate: async () => {
            const calls = (callsByIndex.get(index) ?? 0) + 1;
            callsByIndex.set(index, calls);
            if (retryIndexes.has(index) && calls === 1) {
              throw Object.assign(new Error("deterministic retry chaos"), {
                statusCode: 429,
                responseHeaders: { "retry-after-ms": "0" }
              });
            }
            return {
              text: `ok-${index}`,
              usage: overuseIndexes.has(index)
                ? { inputTokens: 32, outputTokens: 32, totalTokens: 64 }
                : { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
              finishReason: "stop",
              providerMetadata: {}
            };
          }
        });
        return {
          index,
          responseArtifactId: output.responseArtifactId,
          externalOperationId: output.externalOperationId
        };
      }
    });

    expect(result.committed).toBe(100 - overuseIndexes.size);
    expect(result.failed).toBe(overuseIndexes.size);
    expect(result.budgetExhausted).toBe(true);
    expect(ledger.requireRun(run.id).status).toBe("budget_exhausted");
    expect(ledger.listOpenBudgetReservations(run.id)).toHaveLength(0);
    expect(ledger.getBudgetUsage(run.id).tokens).toBeGreaterThan(run.budget.maxTokens!);

    for (const index of retryIndexes) {
      expect(callsByIndex.get(index)).toBe(2);
    }
    for (const index of overuseIndexes) {
      expect(callsByIndex.get(index)).toBe(1);
    }

    const operations = ledger.listExternalOperations(run.id);
    expect(operations).toHaveLength(110);
    expect(operations.filter((operation) => operation.status === "succeeded")).toHaveLength(100 - overuseIndexes.size);
    expect(operations.filter((operation) => operation.status === "failed")).toHaveLength(retryIndexes.size + overuseIndexes.size);
    expect(operations.every((operation) => operation.status === "succeeded" || operation.status === "failed")).toBe(true);
    expect(externalStartsWithoutOpenReservation(ledger.listEvents(run.id))).toEqual([]);
    expect(providerReservationsExceedingTokenCap(ledger.listEvents(run.id), 5)).toEqual([]);

    const tokenOverrunDebits = ledger.listEvents(run.id).filter((event) =>
      event.type === "budget.debited" &&
      event.payload.operationType === "ai.generateText" &&
      Array.isArray((event.payload.overReservationPolicy as { allowedDimensions?: unknown[] } | undefined)?.allowedDimensions) &&
      ((event.payload.overReservationPolicy as { allowedDimensions: unknown[] }).allowedDimensions).includes("tokens")
    );
    expect(tokenOverrunDebits).toHaveLength(overuseIndexes.size);
    expect(ledger.listWorkerJobs(run.id).filter((job) => job.status === "pending" || job.status === "leased" || job.status === "running")).toEqual([]);
  } finally {
    ledger.close();
  }
}, 90_000);

function externalStartsWithoutOpenReservation(events: ReturnType<Ledger["listEvents"]>): string[] {
  const openReservations = new Set<string>();
  const violations: string[] = [];
  for (const event of events) {
    const reservationId = typeof event.payload.reservationId === "string" ? event.payload.reservationId : undefined;
    if (!reservationId) continue;
    if (event.type === "budget.reserved") openReservations.add(reservationId);
    if (event.type === "external.operation.started" && !openReservations.has(reservationId)) {
      violations.push(String(event.payload.operationId));
    }
    if (event.type === "budget.debited" || event.type === "budget.released") {
      openReservations.delete(reservationId);
    }
  }
  return violations;
}

function providerReservationsExceedingTokenCap(events: ReturnType<Ledger["listEvents"]>, cap: number): string[] {
  return events
    .filter((event) =>
      event.type === "budget.reserved" &&
      (event.payload.operationType === "ai.generateText" || event.payload.operationType === "ai.generateText.retry")
    )
    .filter((event) => Number((event.payload.reserve as { tokens?: number } | undefined)?.tokens ?? 0) > cap)
    .map((event) => String(event.payload.reservationId));
}
