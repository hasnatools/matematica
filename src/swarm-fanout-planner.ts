import type { ArtifactStore } from "./artifacts";
import type { ProviderName } from "./config";
import type { Budget, LedgerEvent, Workflow } from "./domain";
import { stableHash } from "./idempotency";
import type { Ledger } from "./ledger";
import { buildSwarmCapacityPlan, type SwarmCapacityPlan } from "./swarm-capacity";

export const SWARM_FANOUT_PLANNER_VERSION = 1;

export type SwarmFanoutProviderRoute = {
  provider: ProviderName | "local" | "deferred";
  modelId: string;
  mode: "ai-sdk" | "local-deterministic" | "deferred";
  providerConcurrency?: number;
};

export type SwarmFanoutBranchPlan = {
  branch: number;
  role: string;
  roleFamily: string;
  promptMutationHash: string;
  promptMutation: {
    mutationId: string;
    mutationHash: string;
    roleFamily: string;
    providerModelKey: string;
  };
  lineage: {
    workflow: Workflow;
    phase: string;
    cycle: number;
    parentPhaseJobId: string;
    sourcePlanHash?: string;
    sourcePlanArtifactId?: string;
    mutationId: string;
  };
  dedupeKey: string;
  providerRoute: SwarmFanoutProviderRoute;
  capacityMode: "admitted";
};

export type SwarmFanoutDeferredBranchPlan = Omit<SwarmFanoutBranchPlan, "capacityMode"> & {
  capacityMode: "deferred";
  reason: string;
};

export type DynamicSwarmFanoutPlan = {
  format: "matematica.dynamic-swarm-fanout-plan";
  version: 1;
  runId: string;
  workflow: Workflow;
  phase: string;
  cycle: number;
  parentPhaseJobId: string;
  requestedWorkers: number;
  effectiveWorkers: number;
  capacityPlan: SwarmCapacityPlan;
  branches: SwarmFanoutBranchPlan[];
  deferredBranches: SwarmFanoutDeferredBranchPlan[];
  roleCatalog: string[];
  providerRoute: SwarmFanoutProviderRoute;
  diversityPolicy: {
    highFanoutThreshold: number;
    roleFamilyQuotas: Array<{ roleFamily: string; maxBranches: number }>;
    minPromptMutationHashes: number;
    providerModelConstraint: {
      minUniqueProviderModelKeys: number;
      providerModelQuotas: Array<{ providerModelKey: string; maxBranches: number }>;
      explicitHeterogeneousRoutes: boolean;
      remoteProviderModelDiversityRequired?: boolean;
      waiverAccepted?: boolean;
      waiverHash?: string;
    };
  };
  diversityReport: {
    ok: boolean;
    uniqueRoleFamilies: number;
    uniquePromptMutationHashes: number;
    uniqueProviderModelKeys: number;
    roleFamilyCounts: Array<{ roleFamily: string; count: number; maxBranches: number; ok: boolean }>;
    providerModelCounts: Array<{ providerModelKey: string; count: number; maxBranches: number; ok: boolean }>;
    issues: string[];
  };
  dedupeScope: string;
  localRemoteConstraint: {
    localOnly: boolean;
    remoteProviderConfigured: boolean;
    providerConcurrency?: number;
  };
  providerDiversityWaiver?: {
    reason: string;
    actor?: string;
    waiverHash: string;
  };
  planHash: string;
};

export function buildDynamicSwarmFanoutPlan(input: {
  runId: string;
  workflow: Workflow;
  phase: string;
  cycle: number;
  parentPhaseJobId: string;
  budget: Budget;
  usage?: SwarmCapacityPlan["capacityInputs"]["usage"];
  requestedWorkers?: number;
  reservePerWorker?: SwarmCapacityPlan["capacityInputs"]["reservePerWorker"];
  providerRoute?: Partial<SwarmFanoutProviderRoute>;
  providerRoutes?: Array<Partial<SwarmFanoutProviderRoute>>;
  providerConcurrency?: number;
  providerDiversityWaiver?: {
    reason: string;
    actor?: string;
  };
  nextCyclePlan?: Record<string, unknown>;
}): DynamicSwarmFanoutPlan {
  const requestedWorkers = Math.max(0, Math.floor(input.requestedWorkers ?? input.budget.maxWorkers ?? 1));
  const roleCatalog = buildRoleCatalog(input.workflow, input.phase, requestedWorkers, input.nextCyclePlan);
  const providerRoutes = normalizeProviderRoutes(input.providerRoutes ?? (input.providerRoute ? [input.providerRoute] : undefined), input.providerConcurrency);
  const providerConcurrency = input.providerConcurrency ?? aggregateProviderConcurrency(providerRoutes);
  const providerRouteSlots = buildProviderRouteSlots(providerRoutes);
  const providerRoute = providerRoutes[0];
  const capacityPlan = buildSwarmCapacityPlan({
    runId: input.runId,
    scope: "phase_fanout",
    requestedWorkers,
    budget: input.budget,
    usage: input.usage,
    reservePerWorker: input.reservePerWorker,
    providerConcurrency,
    deterministicOrder: roleCatalog
  });
  const branchRecords = roleCatalog.map((role, index) => {
    const branch = index + 1;
    const sourcePlanHash = stringValue(input.nextCyclePlan?.planHash);
    const sourcePlanArtifactId = stringValue(input.nextCyclePlan?.artifactId);
    const mutationId = `${input.phase}-${branch}-${stableHash({
      sourcePlanHash,
      workflow: input.workflow,
      role
    }).slice(0, 12)}`;
    const branchProviderRoute = providerRouteSlots[index % providerRouteSlots.length];
    const providerModelKey = providerModelKeyFor(branchProviderRoute);
    const promptMutationHash = stableHash({
      runId: input.runId,
      workflow: input.workflow,
      phase: input.phase,
      cycle: input.cycle,
      branch,
      role,
      roleFamily: roleFamily(role),
      providerModelKey,
      sourcePlanHash
    });
    const lineage = {
      workflow: input.workflow,
      phase: input.phase,
      cycle: input.cycle,
      parentPhaseJobId: input.parentPhaseJobId,
      sourcePlanHash,
      sourcePlanArtifactId,
      mutationId
    };
    const dedupeKey = stableHash({
      kind: "workflow.branch",
      runId: input.runId,
      workflow: input.workflow,
      phase: input.phase,
      cycle: input.cycle,
      parentPhaseJobId: input.parentPhaseJobId,
      branch,
      role,
      sourcePlanHash
    });
    return {
      branch,
      role,
      roleFamily: roleFamily(role),
      promptMutationHash,
      promptMutation: {
        mutationId,
        mutationHash: promptMutationHash,
        roleFamily: roleFamily(role),
        providerModelKey
      },
      lineage,
      dedupeKey,
      providerRoute: branchProviderRoute
    };
  });
  const branches = branchRecords.slice(0, capacityPlan.effectiveWorkers)
    .map((branch): SwarmFanoutBranchPlan => ({ ...branch, capacityMode: "admitted" }));
  const deferredBranches = branchRecords.slice(capacityPlan.effectiveWorkers)
    .map((branch): SwarmFanoutDeferredBranchPlan => ({
      ...branch,
      capacityMode: "deferred",
      reason: capacityPlan.reason
    }));
  const diversityPolicy = buildDiversityPolicy({
    requestedWorkers,
    effectiveWorkers: branches.length,
    roleCatalog,
    providerRoutes,
    waiver: input.providerDiversityWaiver
  });
  const diversityReport = buildDiversityReport({
    branches,
    policy: diversityPolicy
  });
  const unsigned = {
    format: "matematica.dynamic-swarm-fanout-plan" as const,
    version: SWARM_FANOUT_PLANNER_VERSION as 1,
    runId: input.runId,
    workflow: input.workflow,
    phase: input.phase,
    cycle: input.cycle,
    parentPhaseJobId: input.parentPhaseJobId,
    requestedWorkers,
    effectiveWorkers: branches.length,
    capacityPlan,
    branches,
    deferredBranches,
    roleCatalog,
    providerRoute,
    diversityPolicy,
    diversityReport,
    dedupeScope: stableHash({
      runId: input.runId,
      workflow: input.workflow,
      phase: input.phase,
      cycle: input.cycle,
      parentPhaseJobId: input.parentPhaseJobId
    }),
    localRemoteConstraint: {
      localOnly: providerRoute.provider === "local",
      remoteProviderConfigured: providerRoute.provider !== "local" && providerRoute.provider !== "deferred",
      providerConcurrency
    },
    providerDiversityWaiver: diversityPolicy.providerModelConstraint.waiverAccepted && input.providerDiversityWaiver
      ? {
          reason: input.providerDiversityWaiver.reason,
          actor: input.providerDiversityWaiver.actor,
          waiverHash: diversityPolicy.providerModelConstraint.waiverHash ?? stableHash(input.providerDiversityWaiver)
        }
      : undefined
  };
  return {
    ...unsigned,
    planHash: stableHash(unsigned)
  };
}

export function persistDynamicSwarmFanoutPlan(input: {
  runId: string;
  ledger: Ledger;
  artifacts: ArtifactStore;
  plan: DynamicSwarmFanoutPlan;
  targetEvent?: LedgerEvent;
}): { artifactId: string; event: LedgerEvent } {
  const artifact = input.artifacts.create(input.runId, "swarm.fanout.plan", JSON.stringify(input.plan, null, 2));
  const event = input.ledger.appendEvent(input.runId, "swarm.fanout.planned", {
    ...input.plan,
    artifactId: artifact.id,
    targetEventId: input.targetEvent?.id,
    targetEventType: input.targetEvent?.type
  }, [artifact.id, ...stringArray(input.targetEvent?.artifactIds)]);
  return { artifactId: artifact.id, event };
}

function buildRoleCatalog(
  workflow: Workflow,
  phase: string,
  requestedWorkers: number,
  nextCyclePlan?: Record<string, unknown>
): string[] {
  const planRoles = rolesFromPlan(phase, nextCyclePlan);
  const base = planRoles.length > 0
    ? planRoles
    : workflow === "gree" || phase === "experiment"
      ? GREE_EXPERIMENT_ROLES
      : PFLK_LOOPHOLE_ROLES;
  const roles: string[] = [];
  let suffix = 1;
  while (roles.length < requestedWorkers) {
    for (const role of base) {
      const candidate = suffix === 1 ? role : `${role}-${suffix}`;
      if (!roles.includes(candidate)) roles.push(candidate);
      if (roles.length >= requestedWorkers) break;
    }
    suffix += 1;
  }
  return roles;
}

const PFLK_LOOPHOLE_ROLES = [
  "loophole-search",
  "counterexample-search",
  "assumption-auditor",
  "proof-obligation-mapper",
  "reduction-seeker",
  "boundary-case-builder",
  "formalization-gap-finder",
  "literature-analogy-hunter"
];

const GREE_EXPERIMENT_ROLES = [
  "experiment-search",
  "evolution-candidate",
  "counterexample-sweep",
  "parameter-sweeper",
  "proof-sketch-tester",
  "computational-verifier",
  "invariant-miner",
  "failure-reproducer"
];

function rolesFromPlan(phase: string, plan: Record<string, unknown> | undefined): string[] {
  if (!plan) return [];
  const directKey = phase === "experiment" ? "experimentRoleOrder" : "loopholeRoleOrder";
  const direct = uniqueStrings(arrayOfStrings(plan[directKey]));
  if (direct.length > 0) return direct;
  const mutationRoles = Array.isArray(plan.nextCycleMutations)
    ? plan.nextCycleMutations.flatMap((mutation) => arrayOfStrings(recordValue(mutation)?.roleOrder))
    : [];
  return uniqueStrings(mutationRoles);
}

function normalizeProviderRoutes(
  routes: Array<Partial<SwarmFanoutProviderRoute>> | undefined,
  providerConcurrency: number | undefined
): SwarmFanoutProviderRoute[] {
  const rawRoutes = routes && routes.length > 0 ? routes : [undefined];
  const normalized = rawRoutes
    .map((route) => normalizeProviderRoute(route, rawRoutes.length === 1 ? providerConcurrency : undefined));
  const unique = new Map<string, SwarmFanoutProviderRoute>();
  for (const route of normalized) {
    unique.set(providerModelKeyFor(route), route);
  }
  return [...unique.values()];
}

function normalizeProviderRoute(
  route: Partial<SwarmFanoutProviderRoute> | undefined,
  providerConcurrency: number | undefined
): SwarmFanoutProviderRoute {
  if (route?.provider && route.provider !== "deferred") {
    return {
      provider: route.provider,
      modelId: route.modelId ?? "configured-at-execution",
      mode: route.mode ?? (route.provider === "local" ? "local-deterministic" : "ai-sdk"),
      providerConcurrency: route.providerConcurrency ?? providerConcurrency
    };
  }
  return {
    provider: "local",
    modelId: "deterministic-branch",
    mode: "local-deterministic",
    providerConcurrency
  };
}

function aggregateProviderConcurrency(routes: SwarmFanoutProviderRoute[]): number | undefined {
  if (routes.length === 0) return undefined;
  const limits = routes.map((route) => finitePositiveInteger(route.providerConcurrency));
  if (limits.some((limit) => limit === undefined)) return undefined;
  return limits.reduce<number>((total, limit) => total + (limit ?? 0), 0);
}

function buildProviderRouteSlots(routes: SwarmFanoutProviderRoute[]): SwarmFanoutProviderRoute[] {
  const slots = routes.flatMap((route) => {
    const limit = finitePositiveInteger(route.providerConcurrency) ?? 1;
    return Array.from({ length: limit }, () => route);
  });
  return slots.length > 0 ? slots : routes;
}

function finitePositiveInteger(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : undefined;
}

function buildDiversityPolicy(input: {
  requestedWorkers: number;
  effectiveWorkers: number;
  roleCatalog: string[];
  providerRoutes: SwarmFanoutProviderRoute[];
  waiver?: {
    reason: string;
    actor?: string;
  };
}): DynamicSwarmFanoutPlan["diversityPolicy"] {
  const roleFamilies = uniqueStrings(input.roleCatalog.map(roleFamily));
  const providerModelKeys = uniqueStrings(input.providerRoutes.map(providerModelKeyFor));
  const remoteProviderModelKeys = uniqueStrings(input.providerRoutes
    .filter((route) => route.provider !== "local" && route.provider !== "deferred")
    .map(providerModelKeyFor));
  const highRemoteFanout = input.requestedWorkers >= 16 && remoteProviderModelKeys.length > 0;
  const waiverReason = input.waiver?.reason.trim();
  const waiverAccepted = highRemoteFanout &&
    remoteProviderModelKeys.length < 2 &&
    waiverReason !== undefined &&
    waiverReason.length >= 20;
  return {
    highFanoutThreshold: 16,
    roleFamilyQuotas: roleFamilies.map((family) => ({
      roleFamily: family,
      maxBranches: Math.max(1, Math.ceil(Math.max(input.effectiveWorkers, 1) / Math.max(roleFamilies.length, 1)))
    })),
    minPromptMutationHashes: input.effectiveWorkers,
    providerModelConstraint: {
      minUniqueProviderModelKeys: highRemoteFanout ? 2 : 1,
      providerModelQuotas: providerModelKeys.map((providerModelKey) => ({
        providerModelKey,
        maxBranches: Math.max(1, Math.ceil(Math.max(input.effectiveWorkers, 1) / Math.max(providerModelKeys.length, 1)))
      })),
      explicitHeterogeneousRoutes: providerModelKeys.length > 1,
      remoteProviderModelDiversityRequired: highRemoteFanout,
      waiverAccepted,
      waiverHash: waiverAccepted ? stableHash({ reason: waiverReason, actor: input.waiver?.actor ?? "operator-cli" }) : undefined
    }
  };
}

function buildDiversityReport(input: {
  branches: SwarmFanoutBranchPlan[];
  policy: DynamicSwarmFanoutPlan["diversityPolicy"];
}): DynamicSwarmFanoutPlan["diversityReport"] {
  const roleFamilyCounts = input.policy.roleFamilyQuotas.map((quota) => {
    const count = input.branches.filter((branch) => branch.roleFamily === quota.roleFamily).length;
    return {
      ...quota,
      count,
      ok: count <= quota.maxBranches
    };
  });
  const providerModelCounts = input.policy.providerModelConstraint.providerModelQuotas.map((quota) => {
    const count = input.branches.filter((branch) => providerModelKeyFor(branch.providerRoute) === quota.providerModelKey).length;
    return {
      ...quota,
      count,
      ok: count <= quota.maxBranches
    };
  });
  const uniquePromptMutationHashes = uniqueStrings(input.branches.map((branch) => branch.promptMutationHash)).length;
  const uniqueProviderModelKeys = uniqueStrings(input.branches.map((branch) => providerModelKeyFor(branch.providerRoute))).length;
  const uniqueRemoteProviderModelKeys = uniqueStrings(input.branches
    .map((branch) => branch.providerRoute)
    .filter((route) => route.provider !== "local" && route.provider !== "deferred")
    .map(providerModelKeyFor)).length;
  const diversityKeyCount = input.policy.providerModelConstraint.remoteProviderModelDiversityRequired
    ? uniqueRemoteProviderModelKeys
    : uniqueProviderModelKeys;
  const issues = [
    ...roleFamilyCounts.filter((item) => !item.ok).map((item) => `role family ${item.roleFamily} exceeds quota ${item.count}/${item.maxBranches}`),
    ...providerModelCounts.filter((item) => !item.ok).map((item) => `provider model ${item.providerModelKey} exceeds quota ${item.count}/${item.maxBranches}`),
    uniquePromptMutationHashes < input.policy.minPromptMutationHashes
      ? `prompt mutation hashes are not unique ${uniquePromptMutationHashes}/${input.policy.minPromptMutationHashes}`
      : undefined,
    diversityKeyCount < input.policy.providerModelConstraint.minUniqueProviderModelKeys && !input.policy.providerModelConstraint.waiverAccepted
      ? `provider/model diversity below constraint ${diversityKeyCount}/${input.policy.providerModelConstraint.minUniqueProviderModelKeys}`
      : undefined
  ].filter((issue): issue is string => Boolean(issue));
  return {
    ok: issues.length === 0,
    uniqueRoleFamilies: uniqueStrings(input.branches.map((branch) => branch.roleFamily)).length,
    uniquePromptMutationHashes,
    uniqueProviderModelKeys,
    roleFamilyCounts,
    providerModelCounts,
    issues
  };
}

function providerModelKeyFor(route: SwarmFanoutProviderRoute): string {
  return `${route.provider}/${route.modelId}`;
}

function roleFamily(role: string): string {
  return role.replace(/-\d+$/, "");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}
