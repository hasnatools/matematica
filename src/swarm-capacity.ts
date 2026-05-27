import type { ArtifactStore } from "./artifacts";
import type { Budget, LedgerEvent } from "./domain";
import { stableHash } from "./idempotency";
import type { Ledger } from "./ledger";

export const SWARM_CAPACITY_POLICY_VERSION = 1;

export type SwarmCapacityScope = "admission" | "scheduler_lease" | "phase_fanout";
export type SwarmCapacityLimitKind =
  | "worker_cap"
  | "attempt_budget"
  | "token_budget"
  | "usd_budget"
  | "wall_time_budget"
  | "provider_concurrency"
  | "subagent_thread_limit"
  | "available_jobs";

export type SwarmCapacityLimit = {
  kind: SwarmCapacityLimitKind;
  requested: number;
  admitted: number;
  reason: string;
};

export type SwarmCapacityPlan = {
  format: "matematica.swarm-capacity-plan";
  version: 1;
  runId: string;
  scope: SwarmCapacityScope;
  requestedWorkers: number;
  effectiveWorkers: number;
  degraded: boolean;
  mode: "full" | "degraded" | "blocked";
  limits: SwarmCapacityLimit[];
  capacityInputs: {
    budget: Budget;
    usage?: {
      attempts: number;
      tokens: number;
      usd: number;
      elapsedMs: number;
    };
    reservePerWorker?: {
      attempts?: number;
      tokens?: number;
      usd?: number;
      elapsedMs?: number;
    };
    availableJobs?: number;
    providerConcurrency?: number;
    subagentThreadLimit?: number;
  };
  degradedPlan: {
    deterministicOrder: string[];
    admitted: string[];
    deferred: string[];
    obligationsPreserved: boolean;
    operatorStatus: string;
  };
  reason: string;
  planHash: string;
};

export function buildSwarmCapacityPlan(input: {
  runId: string;
  scope: SwarmCapacityScope;
  requestedWorkers: number;
  budget: Budget;
  usage?: SwarmCapacityPlan["capacityInputs"]["usage"];
  reservePerWorker?: SwarmCapacityPlan["capacityInputs"]["reservePerWorker"];
  availableJobs?: number;
  providerConcurrency?: number;
  subagentThreadLimit?: number;
  deterministicOrder?: string[];
}): SwarmCapacityPlan {
  const requestedWorkers = Math.max(0, Math.floor(input.requestedWorkers));
  const deterministicOrder = input.deterministicOrder ?? Array.from({ length: requestedWorkers }, (_, index) => `worker-${index + 1}`);
  const limits = capacityLimits({
    requestedWorkers,
    budget: input.budget,
    usage: input.usage,
    reservePerWorker: input.reservePerWorker,
    availableJobs: input.availableJobs,
    providerConcurrency: input.providerConcurrency,
    subagentThreadLimit: input.subagentThreadLimit
  });
  const effectiveWorkers = Math.max(0, Math.min(requestedWorkers, ...limits.map((limit) => limit.admitted)));
  const degraded = effectiveWorkers < requestedWorkers;
  const mode: SwarmCapacityPlan["mode"] = effectiveWorkers === 0 ? "blocked" : degraded ? "degraded" : "full";
  const admitted = deterministicOrder.slice(0, effectiveWorkers);
  const deferred = deterministicOrder.slice(effectiveWorkers);
  const reason = degraded
    ? `Capacity degraded from ${requestedWorkers} to ${effectiveWorkers}: ${limits.filter((limit) => limit.admitted < requestedWorkers).map((limit) => limit.reason).join("; ")}`
    : `Capacity admits requested ${requestedWorkers} workers.`;
  const unsigned = {
    format: "matematica.swarm-capacity-plan" as const,
    version: SWARM_CAPACITY_POLICY_VERSION as 1,
    runId: input.runId,
    scope: input.scope,
    requestedWorkers,
    effectiveWorkers,
    degraded,
    mode,
    limits,
    capacityInputs: {
      budget: input.budget,
      usage: input.usage,
      reservePerWorker: input.reservePerWorker,
      availableJobs: input.availableJobs,
      providerConcurrency: input.providerConcurrency,
      subagentThreadLimit: input.subagentThreadLimit
    },
    degradedPlan: {
      deterministicOrder,
      admitted,
      deferred,
      obligationsPreserved: true,
      operatorStatus: degraded
        ? "degraded fanout; deferred workers remain explicit obligations"
        : "full requested fanout admitted"
    },
    reason
  };
  return {
    ...unsigned,
    planHash: stableHash(unsigned)
  };
}

export function persistSwarmCapacityPlan(input: {
  runId: string;
  ledger: Ledger;
  artifacts: ArtifactStore;
  plan: SwarmCapacityPlan;
  targetEvent?: LedgerEvent;
}): { artifactId: string; event: LedgerEvent } {
  const artifact = input.artifacts.create(input.runId, "swarm.capacity.plan", JSON.stringify(input.plan, null, 2));
  const event = input.ledger.appendEvent(input.runId, "swarm.capacity.reviewed", {
    ...input.plan,
    artifactId: artifact.id,
    targetEventId: input.targetEvent?.id,
    targetEventType: input.targetEvent?.type
  }, [artifact.id, ...stringArray(input.targetEvent?.artifactIds)]);
  return { artifactId: artifact.id, event };
}

function capacityLimits(input: {
  requestedWorkers: number;
  budget: Budget;
  usage?: SwarmCapacityPlan["capacityInputs"]["usage"];
  reservePerWorker?: SwarmCapacityPlan["capacityInputs"]["reservePerWorker"];
  availableJobs?: number;
  providerConcurrency?: number;
  subagentThreadLimit?: number;
}): SwarmCapacityLimit[] {
  const limits: SwarmCapacityLimit[] = [];
  const requested = input.requestedWorkers;
  limits.push(limit("worker_cap", requested, finiteFloor(input.budget.maxWorkers) ?? requested, "run maxWorkers cap"));
  if (input.availableJobs !== undefined) {
    limits.push(limit("available_jobs", requested, Math.max(0, Math.floor(input.availableJobs)), "currently leasable jobs"));
  }
  if (input.providerConcurrency !== undefined) {
    limits.push(limit("provider_concurrency", requested, Math.max(0, Math.floor(input.providerConcurrency)), "provider concurrency limit"));
  }
  if (input.subagentThreadLimit !== undefined) {
    limits.push(limit("subagent_thread_limit", requested, Math.max(0, Math.floor(input.subagentThreadLimit)), "sub-agent thread capacity limit"));
  }
  const usage = input.usage;
  const reserve = input.reservePerWorker;
  if (usage && reserve) {
    const attemptCapacity = budgetCapacity(input.budget.maxAttempts, usage.attempts, reserve.attempts);
    if (attemptCapacity !== undefined) limits.push(limit("attempt_budget", requested, attemptCapacity, "remaining attempt budget"));
    const tokenCapacity = budgetCapacity(input.budget.maxTokens, usage.tokens, reserve.tokens);
    if (tokenCapacity !== undefined) limits.push(limit("token_budget", requested, tokenCapacity, "remaining token budget"));
    const usdCapacity = budgetCapacity(input.budget.maxUsd, usage.usd, reserve.usd);
    if (usdCapacity !== undefined) limits.push(limit("usd_budget", requested, usdCapacity, "remaining USD budget"));
    const wallTimeCapacity = budgetCapacity(input.budget.maxWallTimeMs, usage.elapsedMs, reserve.elapsedMs);
    if (wallTimeCapacity !== undefined) limits.push(limit("wall_time_budget", requested, wallTimeCapacity, "remaining wall-time budget"));
  }
  if (limits.length === 0) limits.push(limit("worker_cap", requested, requested, "no explicit capacity limit"));
  return limits;
}

function budgetCapacity(limitValue: number | undefined, used: number, reserve: number | undefined): number | undefined {
  if (limitValue === undefined || reserve === undefined || reserve <= 0) return undefined;
  return Math.max(0, Math.floor((limitValue - used) / reserve));
}

function limit(kind: SwarmCapacityLimitKind, requested: number, admitted: number, reason: string): SwarmCapacityLimit {
  return {
    kind,
    requested,
    admitted: Math.max(0, Math.min(requested, admitted)),
    reason
  };
}

function finiteFloor(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.floor(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}
