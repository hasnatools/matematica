import type { ArtifactStore } from "./artifacts";
import { auditRun } from "./audit";
import type { BudgetUsage } from "./budget";
import type { Artifact, Budget, GoalRun, Workflow } from "./domain";
import { stableHash } from "./idempotency";
import type { Ledger } from "./ledger";
import { runWorkerQueue } from "./scheduler";
import { readArtifactText } from "./storage-encryption";

export type SwarmStressPhase = "loophole" | "experiment";
export type SwarmStressScenario =
  | "pflk-loophole-full"
  | "gree-experiment-full"
  | "gree-experiment-cancel"
  | "pflk-loophole-crash-resume"
  | "gree-experiment-budget-exhaustion";

export type SwarmStressGateOptions = {
  ledger: Ledger;
  artifacts: ArtifactStore;
  workerCount?: number;
  providerConcurrency?: number;
  memoryLimitBytes?: number;
  cpuLimitMicros?: number;
};

export type SwarmStressGateResult = {
  format: "matematica.swarm-stress-gate";
  version: 1;
  ok: boolean;
  workerCount: number;
  providerConcurrency: number;
  memoryLimitBytes: number;
  cpuLimitMicros: number;
  scenarios: SwarmStressScenarioResult[];
  summary: {
    committed: number;
    failed: number;
    cancelled: number;
    maxObservedConcurrency: number;
    totalDurationMs: number;
    maxMemoryDeltaBytes: number;
    totalCpuMicros: number;
  };
};

export type SwarmStressScenarioResult = {
  scenario: SwarmStressScenario;
  workflow: Workflow;
  phase: SwarmStressPhase;
  runId: string;
  ok: boolean;
  requestedWorkers: number;
  providerConcurrency: number;
  scheduler: {
    committed: number;
    failed: number;
    cancelled: number;
    budgetExhausted: boolean;
  };
  observed: {
    maxConcurrency: number;
    startedWorkers: number;
    completedWorkers: number;
    cancellationObserved: boolean;
    resumedStaleLeases: number;
    durationMs: number;
    memoryDeltaBytes: number;
    cpuMicros: number;
  };
  invariants: SwarmStressInvariantReport;
};

export type SwarmStressInvariantReport = {
  ok: boolean;
  openReservations: number;
  duplicateLeases: string[];
  duplicateExternalOperations: string[];
  eventOrderingViolations: string[];
  overspend: string[];
  secretLeaks: string[];
  auditOk: boolean;
  auditIssues: string[];
  resourceBounds: {
    memoryOk: boolean;
    cpuOk: boolean;
  };
};

const DEFAULT_WORKER_COUNT = 100;
const DEFAULT_PROVIDER_CONCURRENCY = 8;
const DEFAULT_MEMORY_LIMIT_BYTES = 512 * 1024 * 1024;
const DEFAULT_CPU_LIMIT_MICROS = 30_000_000;
const STRESS_SECRET_CANARY = ["sk", "swarmstresssecretcanary"].join("-");

export async function runSwarmStressGate(options: SwarmStressGateOptions): Promise<SwarmStressGateResult> {
  const workerCount = options.workerCount ?? DEFAULT_WORKER_COUNT;
  const providerConcurrency = options.providerConcurrency ?? DEFAULT_PROVIDER_CONCURRENCY;
  const memoryLimitBytes = options.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT_BYTES;
  const cpuLimitMicros = options.cpuLimitMicros ?? DEFAULT_CPU_LIMIT_MICROS;
  const scenarios: SwarmStressScenarioResult[] = [];
  scenarios.push(await runFullPhaseScenario(options, "pflk-loophole-full", "pflk", "loophole", workerCount, providerConcurrency, memoryLimitBytes, cpuLimitMicros));
  scenarios.push(await runFullPhaseScenario(options, "gree-experiment-full", "gree", "experiment", workerCount, providerConcurrency, memoryLimitBytes, cpuLimitMicros));
  scenarios.push(await runCancellationScenario(options, workerCount, providerConcurrency, memoryLimitBytes, cpuLimitMicros));
  scenarios.push(await runCrashResumeScenario(options, workerCount, providerConcurrency, memoryLimitBytes, cpuLimitMicros));
  scenarios.push(await runBudgetExhaustionScenario(options, workerCount, providerConcurrency, memoryLimitBytes, cpuLimitMicros));

  const summary = {
    committed: scenarios.reduce((sum, scenario) => sum + scenario.scheduler.committed, 0),
    failed: scenarios.reduce((sum, scenario) => sum + scenario.scheduler.failed, 0),
    cancelled: scenarios.reduce((sum, scenario) => sum + scenario.scheduler.cancelled, 0),
    maxObservedConcurrency: Math.max(...scenarios.map((scenario) => scenario.observed.maxConcurrency)),
    totalDurationMs: scenarios.reduce((sum, scenario) => sum + scenario.observed.durationMs, 0),
    maxMemoryDeltaBytes: Math.max(...scenarios.map((scenario) => scenario.observed.memoryDeltaBytes)),
    totalCpuMicros: scenarios.reduce((sum, scenario) => sum + scenario.observed.cpuMicros, 0)
  };
  return {
    format: "matematica.swarm-stress-gate",
    version: 1,
    ok: scenarios.every((scenario) => scenario.ok),
    workerCount,
    providerConcurrency,
    memoryLimitBytes,
    cpuLimitMicros,
    scenarios,
    summary
  };
}

async function runFullPhaseScenario(
  options: SwarmStressGateOptions,
  scenario: SwarmStressScenario,
  workflow: Workflow,
  phase: SwarmStressPhase,
  workerCount: number,
  providerConcurrency: number,
  memoryLimitBytes: number,
  cpuLimitMicros: number
): Promise<SwarmStressScenarioResult> {
  const run = createStressRun(options.ledger, scenario, workflow, phase, workerCount, {
    maxAttempts: workerCount,
    maxWorkers: workerCount,
    maxTokens: workerCount * 10,
    maxUsd: workerCount
  });
  enqueueStressJobs(options.ledger, run.id, scenario, workflow, phase, workerCount);
  const tracker = createResourceTracker();
  const concurrency = createConcurrencyTracker();
  const scheduler = await runWorkerQueue({
    runId: run.id,
    ledger: options.ledger,
    artifacts: options.artifacts,
    workerId: `stress-${scenario}`,
    maxWorkers: workerCount,
    providerConcurrency,
    reservePerJob: { attempts: 1, tokens: 2, usd: 0.001 },
    executor: async (job) => {
      const done = concurrency.enter();
      try {
        const output = options.artifacts.create(run.id, "swarm.stress.worker-output", JSON.stringify({
          scenario,
          workflow,
          phase,
          jobId: job.id,
          index: job.payload.index,
          provider: "mock-provider",
          modelId: "mock-stress-model",
          canary: STRESS_SECRET_CANARY
        }));
        return {
          scenario,
          workflow,
          phase,
          score: Number(job.payload.index) % 10 / 10,
          evidenceGrade: phase === "experiment" ? "heuristic_evidence" : "conjectural_solution",
          artifactId: output.id,
          providerCallHash: stableHash({ scenario, jobId: job.id, phase })
        };
      } finally {
        done();
      }
    }
  });
  return scenarioResult({
    options,
    scenario,
    workflow,
    phase,
    run,
    scheduler,
    tracker,
    concurrency,
    providerConcurrency,
    memoryLimitBytes,
    cpuLimitMicros
  });
}

async function runCancellationScenario(
  options: SwarmStressGateOptions,
  workerCount: number,
  providerConcurrency: number,
  memoryLimitBytes: number,
  cpuLimitMicros: number
): Promise<SwarmStressScenarioResult> {
  const scenario = "gree-experiment-cancel" as const;
  const run = createStressRun(options.ledger, scenario, "gree", "experiment", workerCount, {
    maxAttempts: workerCount,
    maxWorkers: workerCount,
    maxTokens: workerCount * 10
  });
  enqueueStressJobs(options.ledger, run.id, scenario, "gree", "experiment", workerCount);
  const tracker = createResourceTracker();
  const concurrency = createConcurrencyTracker();
  let cancelTriggered = false;
  let cancellationObserved = false;
  const scheduler = await runWorkerQueue({
    runId: run.id,
    ledger: options.ledger,
    artifacts: options.artifacts,
    workerId: "stress-gree-experiment-cancel",
    maxWorkers: workerCount,
    providerConcurrency,
    cancellationPollMs: 25,
    reservePerJob: { attempts: 1, tokens: 1 },
    executor: async (_job, context) => {
      const done = concurrency.enter();
      try {
        if (!cancelTriggered) {
          cancelTriggered = true;
          options.ledger.updateRunStatus(run.id, "cancelled");
        }
        if (!context.signal.aborted) await waitForAbort(context.signal);
        cancellationObserved = cancellationObserved || context.signal.aborted || context.isStopped();
        return { ignored: true, canary: STRESS_SECRET_CANARY };
      } finally {
        done();
      }
    }
  });
  const result = scenarioResult({
    options,
    scenario,
    workflow: "gree",
    phase: "experiment",
    run,
    scheduler,
    tracker,
    concurrency,
    providerConcurrency,
    memoryLimitBytes,
    cpuLimitMicros,
    cancellationObserved
  });
  return {
    ...result,
    ok: result.ok && result.scheduler.cancelled > 0 && result.observed.cancellationObserved,
    invariants: {
      ...result.invariants,
      ok: result.invariants.ok && result.scheduler.cancelled > 0 && result.observed.cancellationObserved
    }
  };
}

async function runCrashResumeScenario(
  options: SwarmStressGateOptions,
  workerCount: number,
  providerConcurrency: number,
  memoryLimitBytes: number,
  cpuLimitMicros: number
): Promise<SwarmStressScenarioResult> {
  const scenario = "pflk-loophole-crash-resume" as const;
  const run = createStressRun(options.ledger, scenario, "pflk", "loophole", workerCount, {
    maxAttempts: workerCount * 2,
    maxWorkers: workerCount,
    maxTokens: workerCount * 10
  });
  enqueueStressJobs(options.ledger, run.id, scenario, "pflk", "loophole", workerCount, 2);
  options.ledger.leaseWorkerJobs(run.id, "stress-dead-worker", workerCount, -1);
  const tracker = createResourceTracker();
  const concurrency = createConcurrencyTracker();
  const scheduler = await runWorkerQueue({
    runId: run.id,
    ledger: options.ledger,
    artifacts: options.artifacts,
    workerId: "stress-crash-rescuer",
    reaperId: "stress-crash-reaper",
    maxWorkers: workerCount,
    providerConcurrency,
    reservePerJob: { attempts: 1, tokens: 1 },
    executor: async (job) => {
      const done = concurrency.enter();
      try {
        const output = options.artifacts.create(run.id, "swarm.stress.resume-output", JSON.stringify({
          scenario,
          jobId: job.id,
          index: job.payload.index,
          recovered: true,
          canary: STRESS_SECRET_CANARY
        }));
        return { artifactId: output.id, recovered: true, score: 0.5 };
      } finally {
        done();
      }
    }
  });
  return scenarioResult({
    options,
    scenario,
    workflow: "pflk",
    phase: "loophole",
    run,
    scheduler,
    tracker,
    concurrency,
    providerConcurrency,
    memoryLimitBytes,
    cpuLimitMicros,
    resumedStaleLeases: options.ledger.listEvents(run.id).filter((event) => event.type === "worker.reconciled").length
  });
}

async function runBudgetExhaustionScenario(
  options: SwarmStressGateOptions,
  workerCount: number,
  providerConcurrency: number,
  memoryLimitBytes: number,
  cpuLimitMicros: number
): Promise<SwarmStressScenarioResult> {
  const scenario = "gree-experiment-budget-exhaustion" as const;
  const admittedAttempts = Math.max(1, Math.floor(workerCount / 4));
  const run = createStressRun(options.ledger, scenario, "gree", "experiment", workerCount, {
    maxAttempts: admittedAttempts,
    maxWorkers: workerCount,
    maxTokens: workerCount
  });
  enqueueStressJobs(options.ledger, run.id, scenario, "gree", "experiment", workerCount);
  const tracker = createResourceTracker();
  const concurrency = createConcurrencyTracker();
  const scheduler = await runWorkerQueue({
    runId: run.id,
    ledger: options.ledger,
    artifacts: options.artifacts,
    workerId: "stress-budget-exhaustion",
    maxWorkers: workerCount,
    providerConcurrency,
    reservePerJob: { attempts: 1, tokens: 1 },
    executor: async (job) => {
      const done = concurrency.enter();
      try {
        return { index: job.payload.index, score: 0.1 };
      } finally {
        done();
      }
    }
  });
  const result = scenarioResult({
    options,
    scenario,
    workflow: "gree",
    phase: "experiment",
    run,
    scheduler,
    tracker,
    concurrency,
    providerConcurrency,
    memoryLimitBytes,
    cpuLimitMicros
  });
  return {
    ...result,
    ok: result.ok && result.scheduler.budgetExhausted && result.scheduler.committed === admittedAttempts,
    invariants: {
      ...result.invariants,
      ok: result.invariants.ok && result.scheduler.budgetExhausted && result.scheduler.committed === admittedAttempts
    }
  };
}

function scenarioResult(input: {
  options: SwarmStressGateOptions;
  scenario: SwarmStressScenario;
  workflow: Workflow;
  phase: SwarmStressPhase;
  run: GoalRun;
  scheduler: SwarmStressScenarioResult["scheduler"];
  tracker: ReturnType<typeof createResourceTracker>;
  concurrency: ReturnType<typeof createConcurrencyTracker>;
  providerConcurrency: number;
  memoryLimitBytes: number;
  cpuLimitMicros: number;
  cancellationObserved?: boolean;
  resumedStaleLeases?: number;
}): SwarmStressScenarioResult {
  const resource = input.tracker.finish();
  const invariants = evaluateStressInvariants({
    ...input,
    memoryDeltaBytes: resource.memoryDeltaBytes,
    cpuMicros: resource.cpuMicros
  });
  const completedWorkers = input.options.ledger.listWorkerJobs(input.run.id)
    .filter((job) => job.status === "committed" || job.status === "cancelled" || job.status === "failed_terminal")
    .length;
  const result: SwarmStressScenarioResult = {
    scenario: input.scenario,
    workflow: input.workflow,
    phase: input.phase,
    runId: input.run.id,
    ok: invariants.ok,
    requestedWorkers: input.run.budget.maxWorkers ?? DEFAULT_WORKER_COUNT,
    providerConcurrency: input.providerConcurrency,
    scheduler: input.scheduler,
    observed: {
      maxConcurrency: input.concurrency.max,
      startedWorkers: input.concurrency.entries,
      completedWorkers,
      cancellationObserved: input.cancellationObserved ?? false,
      resumedStaleLeases: input.resumedStaleLeases ?? 0,
      durationMs: resource.durationMs,
      memoryDeltaBytes: resource.memoryDeltaBytes,
      cpuMicros: resource.cpuMicros
    },
    invariants
  };
  const artifact = input.options.artifacts.create(input.run.id, "swarm.stress.report", JSON.stringify(result, null, 2));
  input.options.ledger.appendEvent(input.run.id, "swarm.stress_gate.reviewed", {
    ...result,
    artifactId: artifact.id,
    reportHash: stableHash(result)
  }, [artifact.id]);
  return result;
}

function evaluateStressInvariants(input: {
  options: SwarmStressGateOptions;
  run: GoalRun;
  concurrency: ReturnType<typeof createConcurrencyTracker>;
  providerConcurrency: number;
  memoryLimitBytes: number;
  cpuLimitMicros: number;
  memoryDeltaBytes: number;
  cpuMicros: number;
}): SwarmStressInvariantReport {
  const events = input.options.ledger.listEvents(input.run.id);
  const artifacts = input.options.ledger.listArtifacts(input.run.id);
  const externalOperations = input.options.ledger.listExternalOperations(input.run.id);
  const audit = auditRun(input.run.id, input.options.ledger);
  const resourceBounds = {
    memoryOk: input.memoryDeltaBytes <= input.memoryLimitBytes,
    cpuOk: input.cpuMicros <= input.cpuLimitMicros
  };
  const report = {
    ok: false,
    openReservations: input.options.ledger.listOpenBudgetReservations(input.run.id).length,
    duplicateLeases: unreconciledDuplicateLeases(events),
    duplicateExternalOperations: duplicateValues(externalOperations.map((operation) => operation.idempotencyKey)),
    eventOrderingViolations: workerEventOrderingViolations(events),
    overspend: budgetOverspend(input.run.budget, input.options.ledger.getBudgetUsage(input.run.id)),
    secretLeaks: secretLeaks(STRESS_SECRET_CANARY, events, artifacts),
    auditOk: audit.ok,
    auditIssues: audit.issues.map((issue) => `${issue.code}: ${issue.message}`),
    resourceBounds
  };
  return {
    ...report,
    ok: report.openReservations === 0 &&
      report.duplicateLeases.length === 0 &&
      report.duplicateExternalOperations.length === 0 &&
      report.eventOrderingViolations.length === 0 &&
      report.overspend.length === 0 &&
      report.secretLeaks.length === 0 &&
      report.auditOk &&
      report.resourceBounds.memoryOk &&
      report.resourceBounds.cpuOk &&
      input.concurrency.max <= input.providerConcurrency
  };
}

function createStressRun(
  ledger: Ledger,
  scenario: SwarmStressScenario,
  workflow: Workflow,
  phase: SwarmStressPhase,
  workerCount: number,
  budget: Budget
): GoalRun {
  return ledger.createRun({
    problem: `100-worker swarm stress gate ${scenario}`,
    goal: `Exercise ${workflow.toUpperCase()} ${phase} fanout with deterministic mock-provider workers.`,
    successCriteria: [
      "concurrency caps are honored",
      "budget reservations settle or refund",
      "cancellation propagates",
      "worker event ordering is valid",
      "crash resume avoids duplicate leases",
      "memory and CPU stay bounded"
    ],
    workflow,
    budget: {
      maxWorkers: workerCount,
      ...budget
    }
  });
}

function enqueueStressJobs(
  ledger: Ledger,
  runId: string,
  scenario: SwarmStressScenario,
  workflow: Workflow,
  phase: SwarmStressPhase,
  workerCount: number,
  maxAttempts = 1
): void {
  for (let index = 0; index < workerCount; index += 1) {
    ledger.enqueueWorkerJob({
      runId,
      kind: "swarm.stress.worker",
      payload: {
        scenario,
        workflow,
        phase,
        index,
        prompt: `${workflow}:${phase}:mock-worker:${index}`
      },
      maxAttempts
    });
  }
}

function createConcurrencyTracker(): {
  current: number;
  max: number;
  entries: number;
  enter: () => () => void;
} {
  return {
    current: 0,
    max: 0,
    entries: 0,
    enter() {
      this.current += 1;
      this.entries += 1;
      this.max = Math.max(this.max, this.current);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        this.current -= 1;
      };
    }
  };
}

function createResourceTracker(): {
  finish: () => { durationMs: number; memoryDeltaBytes: number; cpuMicros: number };
} {
  const startedAt = Date.now();
  const startMemory = process.memoryUsage().rss;
  const startCpu = process.cpuUsage();
  return {
    finish() {
      const cpu = process.cpuUsage(startCpu);
      return {
        durationMs: Date.now() - startedAt,
        memoryDeltaBytes: Math.max(0, process.memoryUsage().rss - startMemory),
        cpuMicros: cpu.user + cpu.system
      };
    }
  };
}

function workerEventOrderingViolations(events: Array<{ type: string; payload: Record<string, unknown>; sequence?: number }>): string[] {
  const byJob = new Map<string, string[]>();
  for (const event of events) {
    if (!event.type.startsWith("worker.")) continue;
    const jobId = stringValue(event.payload.jobId);
    if (!jobId) continue;
    const list = byJob.get(jobId) ?? [];
    list.push(event.type);
    byJob.set(jobId, list);
  }
  const issues: string[] = [];
  for (const [jobId, types] of byJob) {
    const leased = types.indexOf("worker.leased");
    const started = types.indexOf("worker.started");
    const committed = types.indexOf("worker.committed");
    const cancelled = types.indexOf("worker.cancelled");
    const failed = types.indexOf("worker.failed");
    if (started >= 0 && (leased < 0 || leased > started)) issues.push(`${jobId}: worker.started before worker.leased`);
    if (committed >= 0 && (started < 0 || started > committed)) issues.push(`${jobId}: worker.committed before worker.started`);
    if (cancelled >= 0 && started >= 0 && started > cancelled) issues.push(`${jobId}: worker.cancelled before worker.started`);
    if (failed >= 0 && started >= 0 && started > failed) issues.push(`${jobId}: worker.failed before worker.started`);
  }
  return issues;
}

function unreconciledDuplicateLeases(events: Array<{ type: string; payload: Record<string, unknown> }>): string[] {
  const activeLease = new Set<string>();
  const duplicates = new Set<string>();
  for (const event of events) {
    const jobId = stringValue(event.payload.jobId);
    if (!jobId) continue;
    if (event.type === "worker.leased") {
      if (activeLease.has(jobId)) duplicates.add(jobId);
      activeLease.add(jobId);
    }
    if (
      event.type === "worker.reconciled" ||
      event.type === "worker.committed" ||
      event.type === "worker.cancelled" ||
      event.type === "worker.failed"
    ) {
      activeLease.delete(jobId);
    }
  }
  return [...duplicates].sort();
}

function budgetOverspend(budget: Budget, usage: BudgetUsage): string[] {
  const issues: string[] = [];
  if (budget.maxAttempts !== undefined && usage.attempts > budget.maxAttempts) issues.push(`attempts ${usage.attempts} exceeded ${budget.maxAttempts}`);
  if (budget.maxTokens !== undefined && usage.tokens > budget.maxTokens) issues.push(`tokens ${usage.tokens} exceeded ${budget.maxTokens}`);
  if (budget.maxUsd !== undefined && usage.usd > budget.maxUsd) issues.push(`usd ${usage.usd} exceeded ${budget.maxUsd}`);
  if (budget.maxWallTimeMs !== undefined && usage.elapsedMs > budget.maxWallTimeMs) issues.push(`elapsedMs ${usage.elapsedMs} exceeded ${budget.maxWallTimeMs}`);
  return issues;
}

function duplicateValues(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

function secretLeaks(secret: string, events: unknown[], artifacts: Artifact[]): string[] {
  const leaks: string[] = [];
  if (JSON.stringify(events).includes(secret)) leaks.push("ledger_events");
  for (const artifact of artifacts) {
    if (readArtifactText(artifact).includes(secret)) leaks.push(`artifact:${artifact.id}`);
  }
  return leaks;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
