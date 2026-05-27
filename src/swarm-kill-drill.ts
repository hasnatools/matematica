import type { ArtifactStore } from "./artifacts";
import { buildBlindFinalizationCriticReviews, persistAdversarialQuorumReview } from "./adversarial-quorum";
import { auditRun } from "./audit";
import type { BudgetUsage } from "./budget";
import { loadConfig, type MatematicaConfig } from "./config";
import type { Artifact, Budget, GoalRun } from "./domain";
import { buildGoalSuccessDecisionToken } from "./goal-success";
import { stableHash } from "./idempotency";
import type { Ledger } from "./ledger";
import { replayOffline } from "./replay";
import { reconcileGoalRunForResume } from "./resume";
import { runWorkerQueue } from "./scheduler";
import { readArtifactText } from "./storage-encryption";

export type SwarmKillDrillName =
  | "sigint-cancel"
  | "hung-workers"
  | "stale-leases"
  | "sqlite-contention"
  | "provider-429-storm"
  | "active-budget-exhaustion"
  | "goal-met-while-running"
  | "reserve-crash-window"
  | "lease-crash-window"
  | "reservation-bind-crash-window";

export type SwarmKillDrillOptions = {
  ledger: Ledger;
  artifacts: ArtifactStore;
  workerCounts?: number[];
  secretCanary?: string;
  cwd?: string;
  config?: MatematicaConfig;
};

export type SwarmKillDrillCaseResult = {
  name: SwarmKillDrillName;
  workerCount: number;
  runId: string;
  ok: boolean;
  invariants: SwarmKillDrillInvariantReport;
};

export type SwarmKillDrillInvariantReport = {
  openReservations: number;
  activeJobs: string[];
  postTerminalMutations: string[];
  duplicateExternalOperations: string[];
  duplicateWorkerLeases: string[];
  reservationBindingIssues: string[];
  budgetSettlementIssues: string[];
  overspend: string[];
  secretLeaks: string[];
  auditOk: boolean;
  auditIssues: string[];
  replayOk: boolean;
  replayIssues: string[];
  failureReportHash: string;
};

export type SwarmKillDrillSuiteResult = {
  ok: boolean;
  workerCounts: number[];
  cases: SwarmKillDrillCaseResult[];
};

const DEFAULT_WORKER_COUNTS = [1, 4, 16, 100];
const DEFAULT_SECRET_CANARY = ["sk", "killdrillsecretcanary"].join("-");

export async function runSwarmKillDrillSuite(options: SwarmKillDrillOptions): Promise<SwarmKillDrillSuiteResult> {
  const workerCounts = options.workerCounts ?? DEFAULT_WORKER_COUNTS;
  const cases: SwarmKillDrillCaseResult[] = [];
  for (const workerCount of workerCounts) {
    cases.push(await runSigintCancelDrill(options, workerCount));
    cases.push(await runHungWorkersDrill(options, workerCount));
    cases.push(await runStaleLeasesDrill(options, workerCount));
    cases.push(await runSqliteContentionDrill(options, workerCount));
    cases.push(await runProvider429StormDrill(options, workerCount));
    cases.push(await runActiveBudgetExhaustionDrill(options, workerCount));
    cases.push(await runGoalMetWhileRunningDrill(options, workerCount));
    cases.push(await runReserveCrashWindowDrill(options, workerCount));
    cases.push(await runLeaseCrashWindowDrill(options, workerCount));
    cases.push(await runReservationBindCrashWindowDrill(options, workerCount));
  }
  return {
    ok: cases.every((item) => item.ok),
    workerCounts,
    cases
  };
}

async function runSigintCancelDrill(options: SwarmKillDrillOptions, workerCount: number): Promise<SwarmKillDrillCaseResult> {
  const run = createDrillRun(options.ledger, "sigint-cancel", workerCount, { maxAttempts: workerCount, maxWorkers: workerCount });
  enqueueJobs(options.ledger, run.id, workerCount);
  await runWorkerQueue({
    runId: run.id,
    ledger: options.ledger,
    workerId: `kill-drill-sigint-${workerCount}`,
    maxWorkers: workerCount,
    cancellationPollMs: 25,
    executor: async (_job, context) => {
      options.ledger.updateRunStatus(run.id, "cancelled");
      if (!context.isStopped()) {
        await waitForAbort(context.signal);
      }
      return { ignored: true, canary: secretCanary(options) };
    }
  });
  return drillResult(options, "sigint-cancel", workerCount, run);
}

async function runHungWorkersDrill(options: SwarmKillDrillOptions, workerCount: number): Promise<SwarmKillDrillCaseResult> {
  const run = createDrillRun(options.ledger, "hung-workers", workerCount, { maxAttempts: workerCount, maxWorkers: workerCount });
  enqueueJobs(options.ledger, run.id, workerCount);
  const queue = runWorkerQueue({
    runId: run.id,
    ledger: options.ledger,
    workerId: `kill-drill-hung-${workerCount}`,
    maxWorkers: workerCount,
    cancellationPollMs: 25,
    heartbeatMs: 25,
    executor: async (_job, context) => {
      await waitForAbort(context.signal);
      return { ignored: true, canary: secretCanary(options) };
    }
  });
  await sleep(25);
  options.ledger.updateRunStatus(run.id, "cancelled");
  await queue;
  return drillResult(options, "hung-workers", workerCount, run);
}

async function runStaleLeasesDrill(options: SwarmKillDrillOptions, workerCount: number): Promise<SwarmKillDrillCaseResult> {
  const run = createDrillRun(options.ledger, "stale-leases", workerCount, { maxAttempts: workerCount * 2, maxWorkers: workerCount });
  enqueueJobs(options.ledger, run.id, workerCount, 2);
  options.ledger.leaseWorkerJobs(run.id, `kill-drill-dead-${workerCount}`, workerCount, -1);
  await runWorkerQueue({
    runId: run.id,
    ledger: options.ledger,
    workerId: `kill-drill-rescuer-${workerCount}`,
    reaperId: `kill-drill-reaper-${workerCount}`,
    maxWorkers: workerCount,
    executor: async (job) => ({ rescued: job.id })
  });
  return drillResult(options, "stale-leases", workerCount, run);
}

async function runSqliteContentionDrill(options: SwarmKillDrillOptions, workerCount: number): Promise<SwarmKillDrillCaseResult> {
  const run = createDrillRun(options.ledger, "sqlite-contention", workerCount, { maxAttempts: workerCount, maxWorkers: workerCount });
  enqueueJobs(options.ledger, run.id, workerCount);
  await runWorkerQueue({
    runId: run.id,
    ledger: options.ledger,
    workerId: `kill-drill-contention-${workerCount}`,
    maxWorkers: workerCount,
    executor: async (job) => {
      const artifact = options.artifacts.create(run.id, "kill-drill.worker-output", JSON.stringify({
        jobId: job.id,
        index: job.payload.index,
        canary: secretCanary(options)
      }));
      return { artifactId: artifact.id, index: job.payload.index };
    }
  });
  return drillResult(options, "sqlite-contention", workerCount, run);
}

async function runProvider429StormDrill(options: SwarmKillDrillOptions, workerCount: number): Promise<SwarmKillDrillCaseResult> {
  const run = createDrillRun(options.ledger, "provider-429-storm", workerCount, { maxAttempts: workerCount, maxWorkers: workerCount, maxUsd: workerCount });
  for (let index = 0; index < workerCount; index += 1) {
    const request = options.artifacts.create(run.id, "kill-drill.provider-request", JSON.stringify({
      provider: "openai",
      index,
      canary: secretCanary(options)
    }));
    const prepared = options.ledger.prepareExternalOperation({
      runId: run.id,
      operationType: "ai.generateText",
      provider: "openai",
      idempotencyKey: `kill-drill-429-${run.id}-${index}`,
      requestHash: stableHash({ runId: run.id, index, scenario: "provider-429-storm" }),
      reserve: { attempts: 1, usd: 0.01 },
      requestArtifactId: request.id
    });
    if (!prepared.ok) throw new Error(`provider 429 drill reservation unexpectedly failed: ${prepared.reason}`);
    if (!prepared.created) continue;
    const operation = options.ledger.startExternalOperation(prepared.operation.id);
    const error = options.artifacts.create(run.id, "kill-drill.provider-error", JSON.stringify({
      status: 429,
      retryAfterMs: 1_000,
      canary: secretCanary(options)
    }));
    options.ledger.failExternalOperation({
      operationId: operation.id,
      errorMessage: "provider rate limited the drill request",
      releaseReason: "provider 429 storm drill releases failed call reservation",
      provider: "openai",
      errorArtifactId: error.id
    });
  }
  return drillResult(options, "provider-429-storm", workerCount, run);
}

async function runActiveBudgetExhaustionDrill(options: SwarmKillDrillOptions, workerCount: number): Promise<SwarmKillDrillCaseResult> {
  const run = createDrillRun(options.ledger, "active-budget-exhaustion", workerCount, { maxAttempts: workerCount, maxWorkers: workerCount });
  enqueueJobs(options.ledger, run.id, workerCount);
  await runWorkerQueue({
    runId: run.id,
    ledger: options.ledger,
    workerId: `kill-drill-active-budget-${workerCount}`,
    maxWorkers: workerCount,
    cancellationPollMs: 25,
    executor: async (_job, context) => {
      options.ledger.updateRunStatus(run.id, "budget_exhausted", "budget_exhausted");
      if (!context.isStopped()) {
        await waitForAbort(context.signal);
      }
      return { ignored: true, canary: secretCanary(options) };
    }
  });
  return drillResult(options, "active-budget-exhaustion", workerCount, run);
}

async function runGoalMetWhileRunningDrill(options: SwarmKillDrillOptions, workerCount: number): Promise<SwarmKillDrillCaseResult> {
  const run = createDrillRun(options.ledger, "goal-met-while-running", workerCount, { maxAttempts: workerCount, maxWorkers: workerCount });
  enqueueJobs(options.ledger, run.id, workerCount);
  let attempted = false;
  await runWorkerQueue({
    runId: run.id,
    ledger: options.ledger,
    workerId: `kill-drill-goal-met-${workerCount}`,
    maxWorkers: workerCount,
    cancellationPollMs: 25,
    executor: async (_job, context) => {
      if (!attempted) {
        attempted = true;
        const blocked = tryMarkGoalMetForDrill(options, run);
        if (!blocked) {
          throw new Error("goal_met while workers were running was not blocked by open budget reservations");
        }
        options.ledger.updateRunStatus(run.id, "cancelled");
      }
      if (!context.isStopped()) {
        await waitForAbort(context.signal);
      }
      return { ignored: true, canary: secretCanary(options) };
    }
  });
  return drillResult(options, "goal-met-while-running", workerCount, run);
}

async function runReserveCrashWindowDrill(options: SwarmKillDrillOptions, workerCount: number): Promise<SwarmKillDrillCaseResult> {
  const run = createDrillRun(options.ledger, "reserve-crash-window", workerCount, { maxAttempts: workerCount, maxWorkers: workerCount });
  for (let index = 0; index < workerCount; index += 1) {
    const reserved = options.ledger.reserveBudget({
      runId: run.id,
      reserve: { attempts: 1 },
      operationType: "worker.job",
      operationId: `kill-drill-reserve-crash-${workerCount}:${index}`,
      workerId: `kill-drill-reserve-crash-${workerCount}`
    });
    if (!reserved.ok) throw new Error(`reserve crash drill unexpectedly failed reservation: ${reserved.reason}`);
  }
  persistCrashWindowArtifact(options, run.id, "after reserveBudget before leaseWorkerJobs", workerCount);
  recoverCrashWindowRun(options, run.id, "kill drill resume after reserveBudget crash window");
  return drillResult(options, "reserve-crash-window", workerCount, run);
}

async function runLeaseCrashWindowDrill(options: SwarmKillDrillOptions, workerCount: number): Promise<SwarmKillDrillCaseResult> {
  const run = createDrillRun(options.ledger, "lease-crash-window", workerCount, { maxAttempts: workerCount, maxWorkers: workerCount });
  enqueueJobs(options.ledger, run.id, workerCount);
  for (let index = 0; index < workerCount; index += 1) {
    const reserved = options.ledger.reserveBudget({
      runId: run.id,
      reserve: { attempts: 1 },
      operationType: "worker.job",
      operationId: `kill-drill-lease-crash-${workerCount}:${index}`,
      workerId: `kill-drill-lease-crash-${workerCount}`
    });
    if (!reserved.ok) throw new Error(`lease crash drill unexpectedly failed reservation: ${reserved.reason}`);
  }
  options.ledger.leaseWorkerJobs(run.id, `kill-drill-lease-crash-${workerCount}`, workerCount, -1);
  persistCrashWindowArtifact(options, run.id, "after leaseWorkerJobs before worker.reservation_bound", workerCount);
  recoverCrashWindowRun(options, run.id, "kill drill resume after leaseWorkerJobs crash window");
  return drillResult(options, "lease-crash-window", workerCount, run);
}

async function runReservationBindCrashWindowDrill(options: SwarmKillDrillOptions, workerCount: number): Promise<SwarmKillDrillCaseResult> {
  const run = createDrillRun(options.ledger, "reservation-bind-crash-window", workerCount, { maxAttempts: workerCount, maxWorkers: workerCount });
  enqueueJobs(options.ledger, run.id, workerCount);
  const reservationIds: string[] = [];
  const workerId = `kill-drill-bind-crash-${workerCount}`;
  for (let index = 0; index < workerCount; index += 1) {
    const reserved = options.ledger.reserveBudget({
      runId: run.id,
      reserve: { attempts: 1 },
      operationType: "worker.job",
      operationId: `${workerId}:${index}`,
      workerId
    });
    if (!reserved.ok) throw new Error(`reservation bind crash drill unexpectedly failed reservation: ${reserved.reason}`);
    reservationIds.push(reserved.reservationId);
  }
  const jobs = options.ledger.leaseWorkerJobs(run.id, workerId, workerCount, -1);
  const boundCount = Math.max(0, Math.floor(jobs.length / 2));
  options.ledger.appendEventsBatch(run.id, jobs.slice(0, boundCount).map((job, index) => ({
    type: "worker.reservation_bound" as const,
    payload: {
      jobId: job.id,
      owner: workerId,
      attempts: job.attempts,
      reservationId: reservationIds[index],
      crashWindow: "partial-bind-before-batch-completed"
    }
  })));
  persistCrashWindowArtifact(options, run.id, "during worker.reservation_bound batch", workerCount);
  recoverCrashWindowRun(options, run.id, "kill drill resume after worker.reservation_bound crash window");
  return drillResult(options, "reservation-bind-crash-window", workerCount, run);
}

function drillResult(
  options: SwarmKillDrillOptions,
  name: SwarmKillDrillName,
  workerCount: number,
  run: GoalRun
): SwarmKillDrillCaseResult {
  const invariants = evaluateKillDrillInvariants(options, run.id);
  return {
    name,
    workerCount,
    runId: run.id,
    ok: invariants.openReservations === 0 &&
      invariants.activeJobs.length === 0 &&
      invariants.postTerminalMutations.length === 0 &&
      invariants.duplicateExternalOperations.length === 0 &&
      invariants.duplicateWorkerLeases.length === 0 &&
      invariants.reservationBindingIssues.length === 0 &&
      invariants.budgetSettlementIssues.length === 0 &&
      invariants.overspend.length === 0 &&
      invariants.secretLeaks.length === 0 &&
      invariants.auditOk &&
      invariants.replayOk,
    invariants
  };
}

export function evaluateKillDrillInvariants(options: SwarmKillDrillOptions, runId: string): SwarmKillDrillInvariantReport {
  const run = options.ledger.requireRun(runId);
  const events = options.ledger.listEvents(runId);
  const artifacts = options.ledger.listArtifacts(runId);
  const externalOperations = options.ledger.listExternalOperations(runId);
  const audit = auditRun(runId, options.ledger);
  const replay = replayOffline({
    runId,
    ledger: options.ledger,
    cwd: options.cwd ?? process.cwd(),
    config: options.config ?? loadConfig(process.env.MATEMATICA_HOME ?? process.cwd()),
    deterministic: true
  });
  const report = {
    openReservations: options.ledger.listOpenBudgetReservations(runId).length,
    activeJobs: activeWorkerJobs(options.ledger.listWorkerJobs(runId)),
    postTerminalMutations: postTerminalMutations(events),
    duplicateExternalOperations: duplicateOperationKeys(externalOperations.map((operation) => operation.idempotencyKey)),
    duplicateWorkerLeases: duplicateWorkerLeases(events),
    reservationBindingIssues: reservationBindingIssues(events),
    budgetSettlementIssues: budgetSettlementIssues(events),
    overspend: budgetOverspend(run.budget, options.ledger.getBudgetUsage(runId)),
    secretLeaks: secretLeaks(secretCanary(options), events, artifacts),
    auditOk: audit.ok,
    auditIssues: audit.issues.map((issue) => `${issue.code}: ${issue.message}`),
    replayOk: replay.ok,
    replayIssues: replayIssues(replay),
    failureReportHash: ""
  };
  report.failureReportHash = stableHash({
    openReservations: report.openReservations,
    activeJobs: report.activeJobs,
    postTerminalMutations: report.postTerminalMutations,
    duplicateExternalOperations: report.duplicateExternalOperations,
    duplicateWorkerLeases: report.duplicateWorkerLeases,
    reservationBindingIssues: report.reservationBindingIssues,
    budgetSettlementIssues: report.budgetSettlementIssues,
    overspend: report.overspend,
    secretLeaks: report.secretLeaks,
    auditOk: report.auditOk,
    auditIssueCodes: audit.issues.map((issue) => issue.code).sort(),
    replayOk: report.replayOk,
    replayIssues: report.replayIssues
  });
  return report;
}

function recoverCrashWindowRun(options: SwarmKillDrillOptions, runId: string, reason: string): void {
  reconcileGoalRunForResume({
    runId,
    ledger: options.ledger,
    cwd: options.cwd ?? process.cwd(),
    config: options.config ?? loadConfig(process.env.MATEMATICA_HOME ?? process.cwd()),
    reason
  });
}

function persistCrashWindowArtifact(options: SwarmKillDrillOptions, runId: string, crashWindow: string, workerCount: number): void {
  const artifact = options.artifacts.create(runId, "kill-drill.crash-window", JSON.stringify({
    crashWindow,
    workerCount,
    canary: secretCanary(options)
  }));
  options.ledger.appendEvent(runId, "swarm.stress_gate.reviewed", {
    drill: "reserve-lease-bind-crash-window",
    crashWindow,
    workerCount,
    artifactId: artifact.id
  }, [artifact.id]);
}

function createDrillRun(ledger: Ledger, name: SwarmKillDrillName, workerCount: number, budget: Budget): GoalRun {
  return ledger.createRun({
    problem: `Swarm kill drill ${name} with ${workerCount} workers`,
    goal: "Prove swarm stop paths leave no leaked reservations, overspend, duplicate operations, or audit failures.",
    successCriteria: [
      "zero leaked reservations",
      "zero duplicate external operations",
      "no overspend",
      "no secret leakage",
      "passing replay/audit"
    ],
    workflow: "gree",
    budget
  });
}

function enqueueJobs(ledger: Ledger, runId: string, workerCount: number, maxAttempts = 1): void {
  for (let index = 0; index < workerCount; index += 1) {
    ledger.enqueueWorkerJob({
      runId,
      kind: "kill-drill.worker",
      payload: { index },
      maxAttempts
    });
  }
}

function tryMarkGoalMetForDrill(options: SwarmKillDrillOptions, run: GoalRun): boolean {
  const artifact = options.artifacts.create(run.id, "verifier.local.result", JSON.stringify({
    drill: "goal-met-while-running",
    verified: true,
    canary: secretCanary(options)
  }));
  const event = options.ledger.appendEvent(run.id, "goal.success.evaluated", {
    status: "goal_met",
    evidenceGrade: "verified_computation",
    finalState: "computational_evidence",
    canClaimSolved: true,
    reason: "kill drill verified local success",
    criteria: run.successCriteria.map((criterion) => ({ criterion, ok: true, reason: "drill invariant" })),
    problemClassification: { class: "standard_problem", triggers: [] },
    claimId: `kill-drill-${run.id}`,
    verifierId: "local-deterministic-v0",
    satisfyingArtifactIds: [artifact.id]
  }, [artifact.id]);
  const adversarialQuorum = persistAdversarialQuorumReview({
    runId: run.id,
    ledger: options.ledger,
    artifacts: options.artifacts,
    scope: "finalization",
    targetEvent: event,
    targetArtifactIds: [artifact.id],
    critics: buildBlindFinalizationCriticReviews({
      runId: run.id,
      targetEvent: event,
      targetArtifactIds: [artifact.id]
    })
  });
  options.ledger.appendEvent(run.id, "goal.finalization.checked", {
    format: "matematica.no-false-solved-finalization",
    version: 1,
    runId: run.id,
    goalSuccessEventId: event.id,
    status: "passed",
    canMarkGoalMet: true,
    claimId: `kill-drill-${run.id}`,
    verifierId: "local-deterministic-v0",
    evidenceGrade: "verified_computation",
    finalState: "computational_evidence",
    canClaimSolved: true,
    problemClassification: { class: "standard_problem", triggers: [] },
    checks: [{
      id: "proof_certificate",
      status: "passed",
      reason: "kill drill proof certificate accepted",
      artifactIds: [artifact.id]
    }, {
      id: "adversarial_planning_quorum",
      status: "passed",
      reason: "kill drill adversarial quorum accepted",
      artifactIds: [adversarialQuorum.artifact.id]
    }],
    failureReasons: [],
    satisfyingArtifactIds: [artifact.id],
    reviewHash: "kill-drill-finalization"
  }, [adversarialQuorum.artifact.id, artifact.id]);
  try {
    options.ledger.markGoalMet(run.id, "verified_computation", {
      reason: "kill drill verified local success",
      claimId: `kill-drill-${run.id}`,
      verifierId: "local-deterministic-v0"
    }, [artifact.id], buildGoalSuccessDecisionToken({ runId: run.id, event }));
    return false;
  } catch (error) {
    if (isGoalMetBlockedByOpenReservations(error)) return true;
    throw error;
  }
}

function isGoalMetBlockedByOpenReservations(error: unknown): boolean {
  return error instanceof Error && error.message.includes("open budget reservations");
}

function budgetOverspend(budget: Budget, usage: BudgetUsage): string[] {
  const issues: string[] = [];
  if (budget.maxAttempts !== undefined && usage.attempts > budget.maxAttempts) {
    issues.push(`attempts ${usage.attempts} exceeded ${budget.maxAttempts}`);
  }
  if (budget.maxTokens !== undefined && usage.tokens > budget.maxTokens) {
    issues.push(`tokens ${usage.tokens} exceeded ${budget.maxTokens}`);
  }
  if (budget.maxUsd !== undefined && usage.usd > budget.maxUsd) {
    issues.push(`usd ${usage.usd} exceeded ${budget.maxUsd}`);
  }
  if (budget.maxWallTimeMs !== undefined && usage.elapsedMs > budget.maxWallTimeMs) {
    issues.push(`elapsedMs ${usage.elapsedMs} exceeded ${budget.maxWallTimeMs}`);
  }
  return issues;
}

function activeWorkerJobs(jobs: ReturnType<Ledger["listWorkerJobs"]>): string[] {
  return jobs
    .filter((job) => job.status === "pending" || job.status === "leased" || job.status === "running" || job.status === "failed_retryable")
    .map((job) => `${job.id}:${job.status}`)
    .sort();
}

function postTerminalMutations(events: ReturnType<Ledger["listEvents"]>): string[] {
  const terminalIndex = events.findIndex((event) =>
    event.type === "goal.status_changed" &&
    typeof event.payload.to === "string" &&
    ["goal_met", "budget_exhausted", "needs_human_review", "cancelled", "failed"].includes(event.payload.to)
  );
  if (terminalIndex < 0) return [];
  const unsafePostTerminalTypes = new Set([
    "worker.started",
    "worker.committed",
    "worker.completed",
    "external.operation.started",
    "external.operation.completed",
    "goal.success.evaluated"
  ]);
  return events
    .slice(terminalIndex + 1)
    .filter((event) => unsafePostTerminalTypes.has(event.type))
    .map((event) => `${event.sequence}:${event.type}:${event.id}`)
    .sort();
}

function duplicateWorkerLeases(events: ReturnType<Ledger["listEvents"]>): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const event of events) {
    if (event.type !== "worker.leased") continue;
    const jobId = typeof event.payload.jobId === "string" ? event.payload.jobId : undefined;
    const attempts = typeof event.payload.attempts === "number" ? event.payload.attempts : undefined;
    if (!jobId || attempts === undefined) continue;
    const key = `${jobId}:${attempts}`;
    if (seen.has(key)) duplicates.add(key);
    seen.add(key);
  }
  return [...duplicates].sort();
}

function reservationBindingIssues(events: ReturnType<Ledger["listEvents"]>): string[] {
  const leasedAttempts = new Set<string>();
  const reservations = new Set<string>();
  const boundJobs = new Set<string>();
  const boundReservations = new Set<string>();
  const issues: string[] = [];
  for (const event of events) {
    if (event.type === "worker.leased") {
      const jobId = typeof event.payload.jobId === "string" ? event.payload.jobId : undefined;
      const attempts = typeof event.payload.attempts === "number" ? event.payload.attempts : undefined;
      if (jobId && attempts !== undefined) leasedAttempts.add(`${jobId}:${attempts}`);
    }
    if (event.type === "budget.reserved" && event.payload.operationType === "worker.job") {
      const reservationId = typeof event.payload.reservationId === "string" ? event.payload.reservationId : undefined;
      if (reservationId) reservations.add(reservationId);
    }
    if (event.type !== "worker.reservation_bound") continue;
    const jobId = typeof event.payload.jobId === "string" ? event.payload.jobId : undefined;
    const attempts = typeof event.payload.attempts === "number" ? event.payload.attempts : undefined;
    const reservationId = typeof event.payload.reservationId === "string" ? event.payload.reservationId : undefined;
    if (!jobId || attempts === undefined || !reservationId) {
      issues.push(`${event.id}:malformed_binding`);
      continue;
    }
    const leaseKey = `${jobId}:${attempts}`;
    if (!leasedAttempts.has(leaseKey)) issues.push(`${event.id}:binding_without_lease:${leaseKey}`);
    if (!reservations.has(reservationId)) issues.push(`${event.id}:binding_without_reservation:${reservationId}`);
    if (boundJobs.has(leaseKey)) issues.push(`${event.id}:duplicate_job_binding:${leaseKey}`);
    if (boundReservations.has(reservationId)) issues.push(`${event.id}:duplicate_reservation_binding:${reservationId}`);
    boundJobs.add(leaseKey);
    boundReservations.add(reservationId);
  }
  return issues.sort();
}

function budgetSettlementIssues(events: ReturnType<Ledger["listEvents"]>): string[] {
  const reserved = new Set<string>();
  const settlements = new Map<string, string[]>();
  const issues: string[] = [];
  for (const event of events) {
    const reservationId = typeof event.payload.reservationId === "string" ? event.payload.reservationId : undefined;
    if (!reservationId) continue;
    if (event.type === "budget.reserved") reserved.add(reservationId);
    if (event.type === "budget.debited" || event.type === "budget.released") {
      const existing = settlements.get(reservationId) ?? [];
      existing.push(`${event.type}:${event.id}`);
      settlements.set(reservationId, existing);
    }
  }
  for (const reservationId of reserved) {
    const settled = settlements.get(reservationId) ?? [];
    if (settled.length === 0) issues.push(`${reservationId}:missing_settlement`);
    if (settled.length > 1) issues.push(`${reservationId}:multiple_settlements:${settled.join(",")}`);
  }
  for (const reservationId of settlements.keys()) {
    if (!reserved.has(reservationId)) issues.push(`${reservationId}:settlement_without_reservation`);
  }
  return issues.sort();
}

function replayIssues(replay: ReturnType<typeof replayOffline>): string[] {
  return [
    ...replay.audit.issues.map((issue) => `audit:${issue.code}:${issue.message}`),
    ...replay.selfContained.issues.map((issue) => `self-contained:${issue.code}:${issue.message}`),
    ...(replay.finalVerification?.divergences.map((issue) => `final:${issue.kind}:${issue.reason}`) ?? [])
  ].sort();
}

function duplicateOperationKeys(keys: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const key of keys) {
    if (seen.has(key)) duplicates.add(key);
    seen.add(key);
  }
  return [...duplicates].sort();
}

function secretLeaks(secret: string, events: unknown[], artifacts: Artifact[]): string[] {
  const leaks: string[] = [];
  if (JSON.stringify(events).includes(secret)) leaks.push("ledger_events");
  for (const artifact of artifacts) {
    if (readArtifactText(artifact).includes(secret)) {
      leaks.push(`artifact:${artifact.id}`);
    }
  }
  return leaks;
}

function secretCanary(options: SwarmKillDrillOptions): string {
  return options.secretCanary ?? DEFAULT_SECRET_CANARY;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
