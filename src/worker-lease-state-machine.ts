import type { WorkerJobStatus } from "./domain";

export const WORKER_LEASE_STATE_MACHINE_VERSION = "worker-lease-state-machine-v1";

export type WorkerLeaseState =
  | "queued"
  | "leased"
  | "running"
  | "committed"
  | "failed"
  | "cancelled"
  | "revoked"
  | "stale";

export function workerLeaseStateFromStatus(status: WorkerJobStatus): WorkerLeaseState {
  if (status === "pending" || status === "failed_retryable") return "queued";
  if (status === "leased") return "leased";
  if (status === "running") return "running";
  if (status === "committed") return "committed";
  if (status === "failed_terminal") return "failed";
  return "cancelled";
}

export function workerLeaseTransitionPayload(input: {
  jobId: string;
  actor: string;
  reason: string;
  priorStatus?: WorkerJobStatus;
  nextStatus?: WorkerJobStatus;
  priorState?: WorkerLeaseState;
  nextState?: WorkerLeaseState;
  attempt?: number;
  maxAttempts?: number;
  leaseExpiresAt?: string;
  reservationId?: string;
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    workerLeaseStateMachine: {
      version: WORKER_LEASE_STATE_MACHINE_VERSION,
      jobId: input.jobId
    },
    actor: input.actor,
    reason: input.reason,
    priorState: input.priorState ?? (input.priorStatus ? workerLeaseStateFromStatus(input.priorStatus) : "queued"),
    nextState: input.nextState ?? (input.nextStatus ? workerLeaseStateFromStatus(input.nextStatus) : "queued"),
    reservationId: input.reservationId ?? "unbound"
  };

  if (input.priorStatus) payload.previousStatus = input.priorStatus;
  if (input.nextStatus) payload.status = input.nextStatus;
  if (input.attempt !== undefined) {
    payload.attempt = input.attempt;
    payload.attempts = input.attempt;
  }
  if (input.maxAttempts !== undefined) payload.maxAttempts = input.maxAttempts;
  if (input.leaseExpiresAt !== undefined) payload.leaseExpiresAt = input.leaseExpiresAt;
  return payload;
}
