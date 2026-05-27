import { auditRun } from "./audit";
import { type Ledger } from "./ledger";
import { replayOffline } from "./replay";
import type { MatematicaConfig } from "./config";
import type { GoalStatus } from "./domain";

export type ResumeReconciliationResult = {
  runId: string;
  staleWorkersReconciled: Array<{
    id: string;
    status: string;
    attempts: number;
    maxAttempts: number;
  }>;
  releasedExternalOperations: number;
  releasedBudgetReservations: number;
  unknownExternalOperations: Array<{
    id: string;
    operationType: string;
    provider?: string;
    idempotencyKey: string;
    reservationId: string;
  }>;
  deadLetterExternalOperations: Array<{
    id: string;
    operationType: string;
    provider?: string;
    idempotencyKey: string;
    reservationId: string;
  }>;
  reopenedRun: boolean;
  terminalReopen: {
    requested: boolean;
    fromStatus: GoalStatus;
    reopened: boolean;
    reason: string;
  };
  auditOk: boolean;
  deterministicReplayOk: boolean;
  eventLogHash?: string;
  artifactManifestHash?: string;
};

export function reconcileGoalRunForResume(input: {
  runId: string;
  ledger: Ledger;
  cwd: string;
  config: MatematicaConfig;
  reason: string;
  reopenTerminal?: boolean;
}): ResumeReconciliationResult {
  const staleWorkers = input.ledger.reconcileStaleWorkerJobs(input.runId, undefined, "goal-resume-reaper");
  const releasedExternalOperations = input.ledger.reconcileOpenExternalOperations(input.runId, input.reason);
  const releasedBudgetReservations = input.ledger.reconcileOpenBudgetReservations(input.runId, input.reason);
  const unknownExternalOperations = input.ledger.listExternalOperations(input.runId)
    .filter((operation) => operation.status === "unknown_remote_outcome")
    .map((operation) => ({
      id: operation.id,
      operationType: operation.operationType,
      provider: operation.provider,
      idempotencyKey: operation.idempotencyKey,
      reservationId: operation.reservationId
    }));
  const deadLetterExternalOperations = input.ledger.listExternalOperations(input.runId)
    .filter((operation) => operation.status === "dead_lettered")
    .map((operation) => ({
      id: operation.id,
      operationType: operation.operationType,
      provider: operation.provider,
      idempotencyKey: operation.idempotencyKey,
      reservationId: operation.reservationId
    }));
  const run = input.ledger.requireRun(input.runId);
  const terminalReopen = terminalReopenDecision(run.status, input.reopenTerminal === true);
  const reopenedRun = terminalReopen.reopened;
  if (input.reopenTerminal === true && isTerminalStatus(run.status)) {
    input.ledger.appendEvent(input.runId, "goal.terminal_reopen.requested", {
      reason: input.reason,
      fromStatus: run.status,
      reopened: terminalReopen.reopened,
      decision: terminalReopen.reason
    });
  }
  if (reopenedRun) {
    input.ledger.updateRunStatus(input.runId, "created", "none");
  }
  const audit = auditRun(input.runId, input.ledger);
  const deterministic = replayOffline({
    runId: input.runId,
    ledger: input.ledger,
    cwd: input.cwd,
    config: input.config,
    verifyFinal: true,
    deterministic: true
  });
  const result: ResumeReconciliationResult = {
    runId: input.runId,
    staleWorkersReconciled: staleWorkers.map((job) => ({
      id: job.id,
      status: job.status,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts
    })),
    releasedExternalOperations,
    releasedBudgetReservations,
    unknownExternalOperations,
    deadLetterExternalOperations,
    reopenedRun,
    terminalReopen,
    auditOk: audit.ok,
    deterministicReplayOk: deterministic.ok,
    eventLogHash: deterministic.deterministic?.eventLogHash,
    artifactManifestHash: deterministic.deterministic?.artifactManifestHash
  };
  input.ledger.appendEvent(input.runId, "goal.resume.reconciled", {
    reason: input.reason,
    ...result
  });
  return result;
}

function terminalReopenDecision(status: GoalStatus, requested: boolean): ResumeReconciliationResult["terminalReopen"] {
  if (!isTerminalStatus(status)) {
    return {
      requested,
      fromStatus: status,
      reopened: false,
      reason: "run is not terminal"
    };
  }
  if (!requested) {
    return {
      requested,
      fromStatus: status,
      reopened: false,
      reason: "terminal run preserved because --reopen-terminal was not provided"
    };
  }
  if (status === "goal_met") {
    return {
      requested,
      fromStatus: status,
      reopened: false,
      reason: "goal_met is immutable; create a new run instead of reopening verifier-backed success"
    };
  }
  return {
    requested,
    fromStatus: status,
    reopened: true,
    reason: `operator requested terminal reopen from ${status}`
  };
}

function isTerminalStatus(status: GoalStatus): boolean {
  return status === "goal_met" ||
    status === "budget_exhausted" ||
    status === "needs_human_review" ||
    status === "cancelled" ||
    status === "failed";
}
