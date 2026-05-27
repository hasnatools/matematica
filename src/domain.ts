export type Workflow = "pflk" | "gree";

export type GoalStatus =
  | "created"
  | "running"
  | "goal_met"
  | "budget_exhausted"
  | "needs_human_review"
  | "cancelled"
  | "failed";

export type WorkerJobStatus =
  | "pending"
  | "leased"
  | "running"
  | "committed"
  | "failed_retryable"
  | "failed_terminal"
  | "cancelled";

export type EvidenceGrade =
  | "formal_proof"
  | "verified_counterexample"
  | "verified_computation"
  | "literature_backed_reduction"
  | "conjectural_solution"
  | "heuristic_evidence"
  | "unsupported"
  | "contradicted"
  | "budget_exhausted"
  | "none";

export type Budget = {
  maxUsd?: number;
  maxTokens?: number;
  maxWallTimeMs?: number;
  maxAttempts?: number;
  maxWorkers?: number;
  maxArtifactBytes?: number;
  maxSourceQueries?: number;
  maxRetries?: number;
  maxSandboxMs?: number;
};

export type GoalRun = {
  id: string;
  problem: string;
  goal: string;
  successCriteria: string[];
  workflow: Workflow;
  budget: Budget;
  status: GoalStatus;
  evidenceGrade: EvidenceGrade;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
};

export type EventType =
  | "goal.created"
  | "goal.started"
  | "goal.cancelled"
  | "goal.terminal_reopen.requested"
  | "goal.resume.reconciled"
  | "goal.status_changed"
  | "goal.terminal_transition.ignored"
  | "problem.classification.reviewed"
  | "policy.manifest.pinned"
  | "cycle.started"
  | "cycle.completed"
  | "phase.started"
  | "phase.completed"
  | "workflow.next_cycle.planned"
  | "knowledge.promotion.reviewed"
  | "artifact.created"
  | "artifact.reconciled"
  | "source.query"
  | "source.results"
  | "source.offline_cache.used"
  | "source.offline_cache.missed"
  | "source.citations.reviewed"
  | "source.citation_graph.extracted"
  | "source.dedupe.reviewed"
  | "source.quality.reviewed"
  | "source.retrieval.evaluated"
  | "source.snapshots.planned"
  | "source.license.manifest.reviewed"
  | "counterexample.search.reviewed"
  | "claim.graph.reviewed"
  | "claim.retracted"
  | "formalization.assessed"
  | "theorem.normalized"
  | "theorem.equivalence.reviewed"
  | "proof.obligations.reviewed"
  | "proof.certificate.minimized"
  | "adversarial.quorum.reviewed"
  | "context.compaction.reviewed"
  | "loophole.assumption_delta.reviewed"
  | "evidence.scored"
  | "ai.call.started"
  | "ai.call.stream_chunk"
  | "ai.call.step"
  | "ai.call.transcript.plan.persisted"
  | "ai.call.transcript.persisted"
  | "ai.call.completed"
  | "ai.call.failed"
  | "ai.call.aborted"
  | "external.operation.reserved"
  | "external.operation.started"
  | "external.operation.completed"
  | "external.operation.failed"
  | "external.operation.unknown"
  | "external.operation.dead_lettered"
  | "external.operation.released"
  | "external.operation.ignored"
  | "budget.checked"
  | "budget.reserved"
  | "budget.released"
  | "budget.debited"
  | "machine.admission.checked"
  | "machine.admission.reserved"
  | "machine.admission.released"
  | "worker.started"
  | "worker.enqueued"
  | "worker.leased"
  | "worker.heartbeat"
  | "worker.committed"
  | "worker.deduplicated"
  | "worker.reservation_bound"
  | "worker.failed"
  | "worker.cancelled"
  | "worker.completed"
  | "worker.mutation.ignored"
  | "worker.reconciled"
  | "worker.revoked"
  | "worker.stale"
  | "worker.quarantined"
  | "worker.ranked"
  | "worker.tool.started"
  | "worker.tool.completed"
  | "worker.tool.cancelled"
  | "worker.tool.failed"
  | "branch.candidate_claim.reviewed"
  | "branch.proof_obligations.reviewed"
  | "branch.worker_result.schema.reviewed"
  | "swarm.admission.preview"
  | "swarm.capacity.reviewed"
  | "swarm.fanout.planned"
  | "swarm.coordinator.dispatched"
  | "swarm.coordinator.completed"
  | "swarm.coordinator.failed"
  | "swarm.stress_gate.reviewed"
  | "remote.worker.attested"
  | "verifier.started"
  | "verifier.completed"
  | "report.generated"
  | "goal.completed"
  | "goal.success.evaluated"
  | "goal.finalization.checked"
  | "goal.progress.reviewed"
  | "knowledge.conjecture.saved"
  | "run.safety.preflight"
  | "run.deadline.checked"
  | "privacy.mode.selected"
  | "retention.cache.pruned"
  | "ledger.maintenance.snapshotted"
  | "remote.cost.preflight"
  | "privacy.remote_provider.used"
  | "provider.matrix.pinned"
  | "provider.legal_privacy.checked"
  | "provider.pricing.checked"
  | "provider.resilience.checked"
  | "provider.egress.checked"
  | "provider.routing.pinned"
  | "provider.hostile_live_dry_run.reviewed"
  | "ai.sdk.loop_control.checked"
  | "provider.call.failed"
  | "provider.retry.scheduled"
  | "provider.run.blocked"
  | "provider.circuit.opened"
  | "goal.failed";

export type LedgerEvent<TPayload extends Record<string, unknown> = Record<string, unknown>> = {
  id: string;
  runId: string;
  type: EventType;
  payload: TPayload;
  artifactIds: string[];
  createdAt: string;
  sequence?: number;
  payloadHash?: string;
  linkedArtifactHashes?: Array<{ artifactId: string; sha256?: string }>;
  schemaVersion?: number;
  previousEventHash?: string;
  eventHash?: string;
};

export type WorkerJob<TPayload extends Record<string, unknown> = Record<string, unknown>> = {
  id: string;
  runId: string;
  kind: string;
  payload: TPayload;
  dedupeKey?: string;
  status: WorkerJobStatus;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
};

export type Artifact = {
  id: string;
  runId: string;
  kind: string;
  sha256: string;
  contentAddress: string;
  mediaType: string;
  storageKey: string;
  path: string;
  bytes: number;
  createdAt: string;
  provenance?: Record<string, unknown>;
};

export function artifactContentAddress(sha256: string): string {
  return `sha256:${sha256}`;
}

export function artifactStorageKey(runId: string, sha256: string): string {
  return `${runId}/${sha256}.txt`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function makeId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

export function parseWorkflow(value: string | undefined): Workflow {
  if (value === undefined || value === "pflk") return "pflk";
  if (value === "gree") return "gree";
  throw new Error(`Invalid workflow "${value}". Expected "pflk" or "gree".`);
}

export function isTerminalStatus(status: GoalStatus): boolean {
  return status === "goal_met" ||
    status === "budget_exhausted" ||
    status === "needs_human_review" ||
    status === "cancelled" ||
    status === "failed";
}

export function defaultBudget(): Budget {
  return {
    maxAttempts: 1,
    maxWorkers: 1
  };
}

export function normalizeBudget(input: Budget): Budget {
  const budget = { ...defaultBudget(), ...input };
  for (const [key, value] of Object.entries(budget)) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      throw new Error(`Budget field ${key} must be a non-negative finite number.`);
    }
  }
  return budget;
}

export function evidenceSatisfiesGoal(grade: EvidenceGrade): boolean {
  return grade === "formal_proof" || grade === "verified_counterexample" || grade === "verified_computation";
}
