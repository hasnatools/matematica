import { checkBudget, type BudgetUsage } from "./budget";
import type { ArtifactStore } from "./artifacts";
import type { Budget, GoalStatus, WorkerJob } from "./domain";
import { stableHash } from "./idempotency";
import type { Ledger } from "./ledger";
import { buildSwarmCapacityPlan, persistSwarmCapacityPlan } from "./swarm-capacity";
import { workerLeaseTransitionPayload } from "./worker-lease-state-machine";

export type WorkerExecutionContext = {
  signal: AbortSignal;
  isCancelled: () => boolean;
  isStopped: () => boolean;
};

export type WorkerExecutor = (job: WorkerJob, context: WorkerExecutionContext) => Promise<Record<string, unknown> | void>;

export type SchedulerOptions = {
  runId: string;
  ledger: Ledger;
  workerId: string;
  maxWorkers: number;
  leaseMs?: number;
  executor: WorkerExecutor;
  artifacts?: ArtifactStore;
  providerConcurrency?: number;
  subagentThreadLimit?: number;
  reservePerJob?: {
    attempts?: number;
    tokens?: number;
    usd?: number;
    elapsedMs?: number;
    artifactBytes?: number;
    sourceQueries?: number;
    retries?: number;
    sandboxMs?: number;
  };
  cancellationPollMs?: number;
  heartbeatMs?: number;
  reaperId?: string;
};

export type SchedulerResult = {
  committed: number;
  failed: number;
  cancelled: number;
  budgetExhausted: boolean;
};

export type WorkerTournamentRanking = {
  jobId: string;
  rank: number;
  score: number;
  baseScore: number;
  attempts: number;
  kind: string;
  payload: Record<string, unknown>;
  result: Record<string, unknown>;
  outputFingerprint: string;
  duplicateOfJobId?: string;
  suppressed: boolean;
  reasons: string[];
};

export async function runWorkerQueue(options: SchedulerOptions): Promise<SchedulerResult> {
  const requestedMaxWorkers = Math.max(1, Math.floor(options.maxWorkers));
  const leaseMs = options.leaseMs ?? 60_000;
  const reservePerJob: BudgetUsage = {
    attempts: options.reservePerJob?.attempts ?? 1,
    tokens: options.reservePerJob?.tokens ?? 0,
    usd: options.reservePerJob?.usd ?? 0,
    elapsedMs: options.reservePerJob?.elapsedMs ?? 0,
    artifactBytes: options.reservePerJob?.artifactBytes ?? 0,
    sourceQueries: options.reservePerJob?.sourceQueries ?? 0,
    retries: options.reservePerJob?.retries ?? 0,
    sandboxMs: options.reservePerJob?.sandboxMs ?? 0
  };
  if (isZeroBudgetUsage(reservePerJob)) {
    throw new Error("Worker jobs require a non-zero budget reservation; refusing zero-cost local swarm work.");
  }
  const result: SchedulerResult = {
    committed: 0,
    failed: 0,
    cancelled: 0,
    budgetExhausted: false
  };

  while (true) {
    options.ledger.reconcileStaleWorkerJobs(options.runId, undefined, options.reaperId ?? `${options.workerId}:lease-reaper`);
    const run = options.ledger.requireRun(options.runId);
    if (run.status === "cancelled") {
      const cancelled = options.ledger.cancelPendingWorkerJobs(options.runId, "goal run cancelled");
      result.cancelled += cancelled.length;
      break;
    }
    if (run.status === "budget_exhausted" || run.status === "failed" || run.status === "goal_met") {
      break;
    }

    const usage = options.ledger.getBudgetUsage(options.runId);
    const wallClockExhausted = markBudgetExhaustedIfWallClockSpent(options, usage);
    if (wallClockExhausted) {
      result.budgetExhausted = true;
      result.cancelled += wallClockExhausted.cancelled;
      break;
    }
    const budgetCheck = checkBudget(run, usage, reservePerJob);
    options.ledger.appendEvent(options.runId, "budget.checked", {
      ok: budgetCheck.ok,
      reason: budgetCheck.reason ?? null,
      reserve: reservePerJob,
      budget: run.budget,
      usage
    });
    if (!budgetCheck.ok) {
      result.budgetExhausted = true;
      const cancelled = options.ledger.cancelQueuedWorkerJobs(options.runId, budgetCheck.reason ?? "budget exhausted");
      result.cancelled += cancelled.length;
      options.ledger.updateRunStatus(options.runId, "budget_exhausted", "budget_exhausted");
      options.ledger.appendEvent(options.runId, "goal.completed", {
        status: "budget_exhausted",
        evidenceGrade: "budget_exhausted",
        finalState: "budget_exhausted",
        canClaimSolved: false,
        reason: budgetCheck.reason
      });
      break;
    }

    const availableJobs = options.ledger.countLeasableWorkerJobs(options.runId);
    if (availableJobs < 1) break;

    const capacityPlan = buildSwarmCapacityPlan({
      runId: options.runId,
      scope: "scheduler_lease",
      requestedWorkers: requestedMaxWorkers,
      budget: run.budget,
      usage,
      reservePerWorker: reservePerJob,
      availableJobs,
      providerConcurrency: options.providerConcurrency,
      subagentThreadLimit: options.subagentThreadLimit,
      deterministicOrder: Array.from({ length: requestedMaxWorkers }, (_, index) => `lease-slot-${index + 1}`)
    });
    if (options.artifacts && capacityPlan.degraded) {
      persistSwarmCapacityPlan({
        runId: options.runId,
        ledger: options.ledger,
        artifacts: options.artifacts,
        plan: capacityPlan
      });
    }

    const leaseLimit = capacityPlan.effectiveWorkers;
    if (leaseLimit < 1) {
      result.budgetExhausted = true;
      const cancelled = options.ledger.cancelQueuedWorkerJobs(options.runId, "budget exhausted before next worker lease");
      result.cancelled += cancelled.length;
      options.ledger.updateRunStatus(options.runId, "budget_exhausted", "budget_exhausted");
      options.ledger.appendEvent(options.runId, "goal.completed", {
        status: "budget_exhausted",
        evidenceGrade: "budget_exhausted",
        finalState: "budget_exhausted",
        canClaimSolved: false,
        reason: "budget exhausted before next worker lease"
      });
      break;
    }

    const reservations = reserveLeaseSlots(options, leaseLimit, reservePerJob);
    if (reservations.length === 0) {
      result.budgetExhausted = true;
      const cancelled = options.ledger.cancelQueuedWorkerJobs(options.runId, "budget exhausted before reservation");
      result.cancelled += cancelled.length;
      options.ledger.updateRunStatus(options.runId, "budget_exhausted", "budget_exhausted");
      options.ledger.appendEvent(options.runId, "goal.completed", {
        status: "budget_exhausted",
        evidenceGrade: "budget_exhausted",
        finalState: "budget_exhausted",
        canClaimSolved: false,
        reason: "budget exhausted before reservation"
      });
      break;
    }
    const jobs = options.ledger.leaseWorkerJobs(options.runId, options.workerId, reservations.length, leaseMs, reservations);
    if (jobs.length === 0) {
      for (const reservationId of reservations) releaseReservation(options, reservationId, reservePerJob, "no job leased");
      break;
    }
    for (const reservationId of reservations.slice(jobs.length)) {
      releaseReservation(options, reservationId, reservePerJob, "unused lease reservation");
    }
    bindLeaseReservations(options, jobs, reservations);

    const settled = await Promise.all(jobs.map(async (job, index) => executeJob(options, job, leaseMs, reservations[index])));
    for (const item of settled) {
      if (item === "committed") result.committed += 1;
      if (item === "failed") result.failed += 1;
      if (item === "cancelled") result.cancelled += 1;
    }
  }

  return result;
}

export function effectiveMaxWorkers(budget: Budget, requested: number): number {
  const normalized = Math.max(1, Math.floor(requested));
  if (budget.maxWorkers === undefined) return normalized;
  return Math.max(1, Math.min(normalized, Math.floor(budget.maxWorkers)));
}

export function remainingBudgetJobCapacity(
  budget: Budget,
  usage: BudgetUsage,
  reservePerJob: Partial<BudgetUsage>
): number {
  let capacity = Number.POSITIVE_INFINITY;
  capacity = constrainCapacity(capacity, budget.maxAttempts, usage.attempts, reservePerJob.attempts);
  capacity = constrainCapacity(capacity, budget.maxTokens, usage.tokens, reservePerJob.tokens);
  capacity = constrainCapacity(capacity, budget.maxUsd, usage.usd, reservePerJob.usd);
  capacity = constrainCapacity(capacity, budget.maxWallTimeMs, usage.elapsedMs, reservePerJob.elapsedMs);
  capacity = constrainCapacity(capacity, budget.maxArtifactBytes, usage.artifactBytes, reservePerJob.artifactBytes);
  capacity = constrainCapacity(capacity, budget.maxSourceQueries, usage.sourceQueries, reservePerJob.sourceQueries);
  capacity = constrainCapacity(capacity, budget.maxRetries, usage.retries, reservePerJob.retries);
  capacity = constrainCapacity(capacity, budget.maxSandboxMs, usage.sandboxMs, reservePerJob.sandboxMs);
  return Number.isFinite(capacity) ? Math.max(0, Math.floor(capacity)) : Number.MAX_SAFE_INTEGER;
}

export function rankWorkerTournament(options: {
  ledger: Ledger;
  runId: string;
  kind?: string;
  phase?: string;
}): WorkerTournamentRanking[] {
  const commitResults = new Map<string, Record<string, unknown>>();
  for (const event of options.ledger.listEvents(options.runId)) {
    if (event.type !== "worker.committed") continue;
    const jobId = typeof event.payload.jobId === "string" ? event.payload.jobId : undefined;
    if (!jobId) continue;
    commitResults.set(jobId, recordValue(event.payload.result));
  }

  const scored = options.ledger.listWorkerJobs(options.runId)
    .filter((job) => job.status === "committed")
    .filter((job) => options.kind === undefined || job.kind === options.kind)
    .filter((job) => options.phase === undefined || job.payload.phase === options.phase)
    .map((job) => {
      const result = commitResults.get(job.id) ?? {};
      const scoring = scoreWorkerTournamentEntry(job, result);
      return {
        jobId: job.id,
        rank: 0,
        score: scoring.score,
        baseScore: scoring.score,
        attempts: job.attempts,
        kind: job.kind,
        payload: job.payload,
        result,
        outputFingerprint: workerOutputFingerprint(job, result),
        duplicateOfJobId: undefined,
        suppressed: false,
        reasons: scoring.reasons
      };
    })
    .sort((left, right) =>
      right.score - left.score ||
      left.attempts - right.attempts ||
      left.jobId.localeCompare(right.jobId)
    );
  const ranked = applyDiversitySuppression(scored)
    .sort((left, right) =>
      right.score - left.score ||
      left.attempts - right.attempts ||
      left.jobId.localeCompare(right.jobId)
    )
    .map((entry, index) => ({
      ...entry,
      rank: index + 1
    }));

  options.ledger.appendEvent(options.runId, "worker.ranked", {
    kind: options.kind,
    phase: options.phase,
    rankedJobs: ranked.map((entry) => ({
      jobId: entry.jobId,
      rank: entry.rank,
      score: entry.score,
      baseScore: entry.baseScore,
      attempts: entry.attempts,
      outputFingerprint: entry.outputFingerprint,
      duplicateOfJobId: entry.duplicateOfJobId,
      suppressed: entry.suppressed,
      reasons: entry.reasons
    }))
  });
  return ranked;
}

function applyDiversitySuppression<T extends WorkerTournamentRanking>(entries: T[]): T[] {
  const representatives: T[] = [];
  return entries.map((entry) => {
    const duplicate = representatives.find((representative) =>
      entry.outputFingerprint === representative.outputFingerprint ||
      normalizedOutputSimilarity(entry.result, representative.result) >= 0.92
    );
    if (!duplicate) {
      representatives.push(entry);
      return entry;
    }
    return {
      ...entry,
      score: entry.score - 75,
      duplicateOfJobId: duplicate.jobId,
      suppressed: true,
      reasons: [...entry.reasons, `duplicate-output-suppressed:${duplicate.jobId}`]
    };
  });
}

async function executeJob(options: SchedulerOptions, job: WorkerJob, leaseMs: number, reservationId: string): Promise<"committed" | "failed" | "cancelled"> {
  const reserve = {
    attempts: options.reservePerJob?.attempts ?? 1,
    tokens: options.reservePerJob?.tokens ?? 0,
    usd: options.reservePerJob?.usd ?? 0,
    elapsedMs: options.reservePerJob?.elapsedMs ?? 0,
    artifactBytes: options.reservePerJob?.artifactBytes ?? 0,
    sourceQueries: options.reservePerJob?.sourceQueries ?? 0,
    retries: options.reservePerJob?.retries ?? 0,
    sandboxMs: options.reservePerJob?.sandboxMs ?? 0
  };
  const owner = options.workerId;
  const attempt = job.attempts;
  const abortController = new AbortController();
  const startedAt = Date.now();
  const runStatus = () => options.ledger.requireRun(options.runId).status;
  const isCancelled = () => runStatus() === "cancelled";
  const isStopped = () => isTerminalWorkerStop(runStatus());
  const pollMs = Math.max(25, options.cancellationPollMs ?? 1_000);
  const heartbeatMs = Math.max(25, Math.min(options.heartbeatMs ?? Math.floor(leaseMs / 2), Math.max(25, leaseMs - 1)));
  const remainingWallTimeMs = remainingRunWallTimeMs(options);
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let deadlineExpired = false;
  const cancellationPoll = setInterval(() => {
    if (isStopped()) abortWorker(abortController, `goal run stopped: ${runStatus()}`);
  }, pollMs);
  cancellationPoll.unref?.();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  if (remainingWallTimeMs !== undefined) {
    deadlineTimer = setTimeout(() => {
      deadlineExpired = true;
      abortWorker(abortController, `wall-time budget exhausted after ${remainingWallTimeMs}ms`);
    }, remainingWallTimeMs);
    deadlineTimer.unref?.();
  }

  try {
    if (isStopped()) {
      cancelWorkerBeforeStart(options, job, owner, attempt, reservationId, reserve, `goal run stopped before worker start: ${runStatus()}`);
      return "cancelled";
    }
    options.ledger.markWorkerJobRunning(job.id, owner, attempt);
    options.ledger.heartbeatWorkerJob(job.id, owner, attempt, leaseMs);
    heartbeat = setInterval(() => {
      if (abortController.signal.aborted) return;
      try {
        options.ledger.heartbeatWorkerJob(job.id, owner, attempt, leaseMs);
      } catch (error) {
        abortWorker(abortController, error instanceof Error ? error.message : String(error));
      }
    }, heartbeatMs);
    heartbeat.unref?.();
    if (isStopped()) abortWorker(abortController, `goal run stopped: ${runStatus()}`);
    const output = await abortableWorkerExecution(abortController.signal, () => options.executor(job, {
      signal: abortController.signal,
      isCancelled,
      isStopped
    }));
    const stoppedStatus = runStatus();
    if (isTerminalWorkerStop(stoppedStatus)) {
      options.ledger.cancelWorkerJob(job.id, `goal run stopped: ${stoppedStatus}`, owner, attempt);
      debitWorkerAttempt(options, measuredWorkerDebit(reserve, startedAt), reservationId);
      return "failed";
    }
    options.ledger.commitWorkerJob(job.id, owner, attempt, output ?? {});
    debitWorkerAttempt(options, measuredWorkerDebit(reserve, startedAt), reservationId);
    return "committed";
  } catch (error) {
    if (deadlineExpired) {
      const reason = abortReason(abortController.signal) ?? "wall-time budget exhausted during worker execution";
      options.ledger.cancelWorkerJob(job.id, reason, owner, attempt);
      options.ledger.cancelQueuedWorkerJobs(options.runId, reason);
      options.ledger.updateRunStatus(options.runId, "budget_exhausted", "budget_exhausted");
      options.ledger.appendEvent(options.runId, "goal.completed", {
        status: "budget_exhausted",
        evidenceGrade: "budget_exhausted",
        finalState: "budget_exhausted",
        canClaimSolved: false,
        reason
      });
      debitWorkerAttempt(options, measuredWorkerDebit(reserve, startedAt), reservationId);
      return "failed";
    }
    const stoppedStatus = runStatus();
    if (isTerminalWorkerStop(stoppedStatus)) {
      options.ledger.cancelWorkerJob(job.id, `goal run stopped: ${stoppedStatus}`, owner, attempt);
    } else {
      options.ledger.failWorkerJob(job.id, owner, attempt, error instanceof Error ? error.message : String(error), true);
    }
    debitWorkerAttempt(options, measuredWorkerDebit(reserve, startedAt), reservationId);
    return "failed";
  } finally {
    clearInterval(cancellationPoll);
    if (deadlineTimer) clearTimeout(deadlineTimer);
    if (heartbeat) clearInterval(heartbeat);
  }
}

function cancelWorkerBeforeStart(
  options: SchedulerOptions,
  job: WorkerJob,
  owner: string,
  attempt: number,
  reservationId: string,
  reserve: BudgetUsage,
  reason: string
): void {
  options.ledger.cancelWorkerJob(job.id, reason, owner, attempt);
  releaseReservation(options, reservationId, reserve, reason);
}

function isTerminalWorkerStop(status: GoalStatus): boolean {
  return status === "cancelled" ||
    status === "budget_exhausted" ||
    status === "failed" ||
    status === "goal_met";
}

function reserveLeaseSlots(options: SchedulerOptions, count: number, reservePerJob: BudgetUsage): string[] {
  const reservationIds: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const reservation = options.ledger.reserveBudget({
      runId: options.runId,
      reserve: reservePerJob,
      operationType: "worker.job",
      operationId: `${options.workerId}:${index}`,
      workerId: options.workerId
    });
    if (!reservation.ok) break;
    reservationIds.push(reservation.reservationId);
  }
  return reservationIds;
}

function bindLeaseReservations(options: SchedulerOptions, jobs: WorkerJob[], reservations: string[]): void {
  const events = jobs.map((job, index) => ({
    type: "worker.reservation_bound" as const,
    payload: {
      ...workerLeaseTransitionPayload({
        jobId: job.id,
        actor: options.workerId,
        reason: "worker lease bound to budget reservation",
        priorStatus: job.status,
        nextStatus: job.status,
        attempt: job.attempts,
        maxAttempts: job.maxAttempts,
        leaseExpiresAt: job.leaseExpiresAt,
        reservationId: reservations[index]
      }),
      jobId: job.id,
      owner: options.workerId,
      attempts: job.attempts,
      reservationId: reservations[index]
    }
  }));
  options.ledger.appendEventsBatch(options.runId, events);
}

function releaseReservation(options: SchedulerOptions, reservationId: string, reserve: BudgetUsage, reason: string): void {
  void reserve;
  options.ledger.releaseBudget({
    runId: options.runId,
    reservationId,
    reason
  });
}

function debitWorkerAttempt(options: SchedulerOptions, debit: BudgetUsage, reservationId: string): void {
  options.ledger.debitBudget({
    runId: options.runId,
    reservationId,
    debit,
    overReservationPolicy: {
      allowedDimensions: ["elapsedMs"],
      reason: "Worker execution debits measured elapsed time above the minimum lease estimate."
    },
    workerId: options.workerId
  });
}

function markBudgetExhaustedIfWallClockSpent(
  options: SchedulerOptions,
  usage: BudgetUsage
): { cancelled: number } | undefined {
  const budget = options.ledger.requireRun(options.runId).budget;
  if (budget.maxWallTimeMs === undefined || usage.elapsedMs < budget.maxWallTimeMs) return undefined;
  const reason = `elapsedMs budget exhausted (${usage.elapsedMs}/${budget.maxWallTimeMs})`;
  const cancelled = options.ledger.cancelQueuedWorkerJobs(options.runId, reason);
  options.ledger.updateRunStatus(options.runId, "budget_exhausted", "budget_exhausted");
  options.ledger.appendEvent(options.runId, "goal.completed", {
    status: "budget_exhausted",
    evidenceGrade: "budget_exhausted",
    finalState: "budget_exhausted",
    canClaimSolved: false,
    reason
  });
  return { cancelled: cancelled.length };
}

function remainingRunWallTimeMs(options: SchedulerOptions): number | undefined {
  const run = options.ledger.requireRun(options.runId);
  if (run.budget.maxWallTimeMs === undefined) return undefined;
  const usage = options.ledger.getBudgetUsage(options.runId);
  return Math.max(1, Math.floor(run.budget.maxWallTimeMs - usage.elapsedMs));
}

function measuredWorkerDebit(reserve: BudgetUsage, startedAt: number): BudgetUsage {
  return {
    attempts: reserve.attempts,
    tokens: reserve.tokens,
    usd: reserve.usd,
    elapsedMs: Math.max(reserve.elapsedMs, Math.max(1, Date.now() - startedAt)),
    artifactBytes: reserve.artifactBytes,
    sourceQueries: reserve.sourceQueries,
    retries: reserve.retries,
    sandboxMs: reserve.sandboxMs
  };
}

function abortWorker(controller: AbortController, reason: string): void {
  if (controller.signal.aborted) return;
  controller.abort(new Error(reason));
}

async function abortableWorkerExecution<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  if (signal.aborted) throw abortSignalError(signal);
  return await Promise.race([
    run(),
    new Promise<T>((_, reject) => {
      signal.addEventListener("abort", () => reject(abortSignalError(signal)), { once: true });
    })
  ]);
}

function abortSignalError(signal: AbortSignal): Error {
  const reason = abortReason(signal);
  const error = new Error(reason ?? "Worker execution aborted.");
  error.name = "AbortError";
  return error;
}

function abortReason(signal: AbortSignal): string | undefined {
  const reason = signal.reason;
  if (reason instanceof Error) return reason.message;
  return typeof reason === "string" ? reason : undefined;
}

function isZeroBudgetUsage(value: BudgetUsage): boolean {
  return value.attempts === 0 &&
    value.tokens === 0 &&
    value.usd === 0 &&
    value.elapsedMs === 0 &&
    value.artifactBytes === 0 &&
    value.sourceQueries === 0 &&
    value.retries === 0 &&
    value.sandboxMs === 0;
}

function constrainCapacity(
  current: number,
  max: number | undefined,
  used: number,
  reserve: number | undefined
): number {
  if (max === undefined) return current;
  const perJob = reserve ?? 0;
  if (perJob <= 0) return current;
  return Math.min(current, (max - used) / perJob);
}

function scoreWorkerTournamentEntry(job: WorkerJob, result: Record<string, unknown>): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  const explicitScore = numericValue(result.score ?? result.confidence ?? result.evidenceScore);
  if (explicitScore !== undefined) {
    score += explicitScore * 100;
    reasons.push(`explicit-score:${explicitScore}`);
  }
  const grade = typeof result.evidenceGrade === "string" ? result.evidenceGrade : undefined;
  const gradeWeight = grade ? evidenceGradeWeight(grade) : 0;
  if (gradeWeight > 0) {
    score += gradeWeight;
    reasons.push(`evidence-grade:${grade}`);
  }
  if (typeof result.artifactId === "string" || typeof result.responseArtifactId === "string") {
    score += 5;
    reasons.push("artifact-backed");
  }
  if (job.attempts > 0) {
    score += Math.max(0, 3 - job.attempts);
    reasons.push(`attempts:${job.attempts}`);
  }
  if (reasons.length === 0) {
    reasons.push("stable-fifo-baseline");
  }
  return { score, reasons };
}

function workerOutputFingerprint(job: WorkerJob, result: Record<string, unknown>): string {
  return stableHash({
    kind: job.kind,
    phase: job.payload.phase,
    normalizedOutput: normalizedWorkerOutput(result)
  });
}

function normalizedOutputSimilarity(left: Record<string, unknown>, right: Record<string, unknown>): number {
  const leftTokens = tokenSet(normalizedWorkerOutput(left));
  const rightTokens = tokenSet(normalizedWorkerOutput(right));
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) intersection += 1;
  }
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union === 0 ? 0 : intersection / union;
}

function normalizedWorkerOutput(result: Record<string, unknown>): string {
  const candidate = [
    result.conclusion,
    result.summary,
    result.text,
    result.result,
    result.claim
  ].find((value) => typeof value === "string" && value.trim().length > 0);
  const text = typeof candidate === "string" ? candidate : JSON.stringify(result);
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenSet(text: string): Set<string> {
  return new Set(text.split(" ").filter((token) => token.length > 2));
}

function evidenceGradeWeight(grade: string): number {
  if (grade === "formal_proof") return 100;
  if (grade === "verified_counterexample") return 95;
  if (grade === "verified_computation") return 90;
  if (grade === "literature_backed_reduction") return 70;
  if (grade === "conjectural_solution") return 40;
  if (grade === "heuristic_evidence") return 20;
  return 0;
}

function numericValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
