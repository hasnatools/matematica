import type { ArtifactStore } from "./artifacts";
import type { ProviderName } from "./config";
import type { GoalRun, Workflow } from "./domain";
import { stableHash } from "./idempotency";
import type { Ledger } from "./ledger";
import { ARXIV_POLITE_MIN_INTERVAL_MS, arxivCompliancePolicy } from "./research/arxiv";
import { SANDBOX_DEFAULT_MAX_PROCESSES, SANDBOX_DEFAULT_MEMORY_BYTES, SANDBOX_POLICY_VERSION } from "./sandbox";
import { buildSwarmCapacityPlan, persistSwarmCapacityPlan, type SwarmCapacityPlan } from "./swarm-capacity";

export type SwarmAdmissionPreview = {
  format: "matematica.swarm-admission-preview";
  version: 1;
  runId: string;
  command: "goal run" | "goal resume" | "goal admission";
  workflow: Workflow;
  requestedWorkers: number;
  budgetedWorkers: number;
  capacityPlan: SwarmCapacityPlan;
  defaultParallelismConservative: boolean;
  requiresExplicitYes: boolean;
  explicitYes: boolean;
  admission: {
    ok: boolean;
    reason?: string;
  };
  providerModelMix: Array<{
    provider: ProviderName | "local";
    modelId: string;
    plannedWorkers: number;
    remote: boolean;
    requestedUpstreamProvider?: string;
    requestedUpstreamModel?: string;
  }>;
  providerDiversity: {
    highFanoutThreshold: number;
    required: boolean;
    waiverAccepted: boolean;
    waiverReason?: string;
    waiverHash?: string;
    uniqueRemoteProviderModelKeys: number;
    minUniqueRemoteProviderModelKeys: number;
    routeLineage: Array<{
      provider: ProviderName | "local";
      modelId: string;
      providerModelKey: string;
      plannedWorkers: number;
      remote: boolean;
      requestedUpstreamProvider?: string;
      requestedUpstreamModel?: string;
    }>;
    ok: boolean;
    issues: string[];
  };
  requiredCapabilities: string[];
  worstCase: {
    workers: number;
    attempts: number | null;
    tokens: number | null;
    usd: number | null;
    wallTimeMs: number | null;
    providerCalls: number | null;
    retries: number | null;
    sourceQueries: number | null;
    sandboxMs: number | null;
    artifactBytes: number | null;
    source: string;
  };
  operatorConfirmation: {
    envelopeHash: string;
    confirmedEnvelopeHash?: string;
    bindsToExactEnvelope: boolean;
    instructions: string;
  };
  rateLimitRisks: string[];
  opsGuard: {
    ok: boolean;
    checks: Array<{
      id: string;
      ok: boolean;
      severity: "error" | "warning";
      detail: string;
    }>;
  };
  networkMode: "offline" | "online" | "local-only" | "remote-provider-api";
  workerRoles: Array<{
    role: string;
    contribution: string;
  }>;
  outputPolicy: {
    persisted: string;
    terminal: string;
  };
  warnings: string[];
};

export type SwarmAdmissionBranchModel = {
  provider: ProviderName;
  modelId: string;
  settings?: {
    maxUsd?: number;
    maxOutputTokens?: number;
    resilience?: {
      maxConcurrency?: number;
    };
  };
  remoteAdmission?: {
    explicitRemoteConsent?: boolean;
  };
};

export type SwarmAdmissionInput = {
  run: GoalRun;
  ledger: Ledger;
  artifacts: ArtifactStore;
  command: "goal run" | "goal resume" | "goal admission";
  sourceNetworkMode: "offline" | "online";
  explicitYes: boolean;
  branchModel?: SwarmAdmissionBranchModel;
  branchModels?: SwarmAdmissionBranchModel[];
  providerDiversityWaiver?: {
    reason: string;
    actor?: string;
  };
};

export function persistSwarmAdmissionPreview(input: SwarmAdmissionInput): SwarmAdmissionPreview {
  const preview = buildSwarmAdmissionPreview(input);
  const artifact = input.artifacts.create(input.run.id, "swarm.admission.preview", JSON.stringify(preview, null, 2));
  const event = input.ledger.appendEvent(input.run.id, "swarm.admission.preview", {
    ...preview,
    artifactId: artifact.id,
    previewHash: stableHash(preview)
  }, [artifact.id]);
  persistSwarmCapacityPlan({
    runId: input.run.id,
    ledger: input.ledger,
    artifacts: input.artifacts,
    plan: preview.capacityPlan,
    targetEvent: event
  });
  return preview;
}

export function assertSwarmAdmissionApproved(preview: SwarmAdmissionPreview): void {
  if (preview.admission.ok) return;
  throw new Error([
    preview.admission.reason ?? "Swarm admission was rejected.",
    "Admission preview:",
    JSON.stringify(preview, null, 2)
  ].join("\n"));
}

function buildSwarmAdmissionPreview(input: SwarmAdmissionInput): SwarmAdmissionPreview {
  const requestedWorkers = Math.max(1, Math.trunc(input.run.budget.maxWorkers ?? 1));
  const branchModels = branchModelsForInput(input);
  const remote = branchModels.some((model) => model.provider !== "local");
  const providerConcurrency = aggregateProviderConcurrency({ branchModels });
  const capacityPlan = buildSwarmCapacityPlan({
    runId: input.run.id,
    scope: "admission",
    requestedWorkers,
    budget: input.run.budget,
    reservePerWorker: {
      attempts: 1,
      tokens: maxFinite(branchModels.map((model) => model.settings?.maxOutputTokens)),
      usd: maxFinite(branchModels.map((model) => model.settings?.maxUsd)),
      elapsedMs: input.run.budget.maxWallTimeMs === undefined ? undefined : 1
    },
    usage: { attempts: 0, tokens: 0, usd: 0, elapsedMs: 0 },
    providerConcurrency,
    deterministicOrder: Array.from({ length: requestedWorkers }, (_, index) => `admission-worker-${index + 1}`)
  });
  const budgetedWorkers = Math.max(1, capacityPlan.effectiveWorkers);
  const mix = providerModelMix(branchModels, budgetedWorkers);
  const providerDiversity = buildProviderDiversity({
    requestedWorkers,
    branchModels,
    providerModelMix: mix,
    waiver: input.providerDiversityWaiver
  });
  const missingRemoteCostConsent = branchModels.some((model) => model.provider !== "local" && model.remoteAdmission?.explicitRemoteConsent !== true);
  const requiresExplicitYes = requestedWorkers >= 100 && !missingRemoteCostConsent;
  const rateLimitRisks = rateLimitRisk(input, requestedWorkers, budgetedWorkers);
  const opsGuard = buildSwarmOpsGuard({
    input,
    requestedWorkers,
    budgetedWorkers,
    remote,
    providerConcurrency,
    capacityPlan,
    providerDiversity,
    enforceHighFanoutOps: !missingRemoteCostConsent
  });
  const warnings = [
    requestedWorkers > budgetedWorkers
      ? `requested ${requestedWorkers} workers, but current budget admits at most ${budgetedWorkers} before execution`
      : undefined,
    requestedWorkers >= 100
      ? "100-worker fanout is a high-parallelism run and requires --yes before dispatch"
      : undefined,
    remote && branchModels.some((model) => model.provider !== "local" && model.settings?.maxUsd === undefined)
      ? "remote provider selected without --max-call-usd; remote cost admission will fail closed"
      : undefined,
    ...rateLimitRisks
  ].filter((item): item is string => Boolean(item));
  const explicitYesOk = !requiresExplicitYes || input.explicitYes;
  const worstCaseEnvelope = worstCase(input, budgetedWorkers);
  const envelopeHash = stableHash({
    requestedWorkers,
    budgetedWorkers,
    capacityPlanHash: stableHash(capacityPlan),
    providerModelMix: mix,
    providerDiversity,
    networkMode: remote ? "remote-provider-api" : input.sourceNetworkMode === "offline" ? "offline" : "local-only",
    worstCase: worstCaseEnvelope,
    opsGuard
  });
  const admissionOk = explicitYesOk && opsGuard.ok;
  const admissionReason = !explicitYesOk
    ? "100-worker swarm admission requires explicit confirmation; rerun with --yes after reviewing the preview."
    : !opsGuard.ok
      ? `Swarm admission ops guard failed: ${opsGuard.checks.filter((check) => !check.ok && check.severity === "error").map((check) => `${check.id}: ${check.detail}`).join("; ")}`
      : undefined;

  return {
    format: "matematica.swarm-admission-preview",
    version: 1,
    runId: input.run.id,
    command: input.command,
    workflow: input.run.workflow,
    requestedWorkers,
    budgetedWorkers,
    capacityPlan,
    defaultParallelismConservative: requestedWorkers === 1 || input.run.budget.maxWorkers !== undefined,
    requiresExplicitYes,
    explicitYes: input.explicitYes,
    admission: admissionOk
      ? { ok: true }
      : {
          ok: false,
          reason: admissionReason ?? "Swarm admission was rejected."
        },
    providerModelMix: mix,
    providerDiversity,
    requiredCapabilities: requiredCapabilities(input, remote),
    worstCase: worstCaseEnvelope,
    operatorConfirmation: {
      envelopeHash,
      confirmedEnvelopeHash: input.explicitYes ? envelopeHash : undefined,
      bindsToExactEnvelope: input.explicitYes,
      instructions: "Review this exact envelope hash before passing --yes; any budget, provider, route, or worker change produces a different hash."
    },
    rateLimitRisks,
    opsGuard,
    networkMode: remote ? "remote-provider-api" : input.sourceNetworkMode === "offline" ? "offline" : "local-only",
    workerRoles: workerRoles(input.run.workflow),
    outputPolicy: {
      persisted: "worker prompts, model/tool steps, artifacts, scores, and ranked findings must be saved to the append-only ledger before they affect the goal",
      terminal: "large worker output is summarized into ranked findings; raw chatter stays in artifacts and replay"
    },
    warnings
  };
}

function buildSwarmOpsGuard(input: {
  input: SwarmAdmissionInput;
  requestedWorkers: number;
  budgetedWorkers: number;
  remote: boolean;
  providerConcurrency?: number;
  capacityPlan: SwarmCapacityPlan;
  providerDiversity: SwarmAdmissionPreview["providerDiversity"];
  enforceHighFanoutOps: boolean;
}): SwarmAdmissionPreview["opsGuard"] {
  const highFanout = input.enforceHighFanoutOps && input.requestedWorkers >= 100;
  const highFanoutCheck = (ok: boolean, id: string, detail: string) => ({
    id,
    ok: highFanout ? ok : true,
    severity: highFanout ? "error" as const : "warning" as const,
    detail: ok ? detail : `${detail}${highFanout ? "" : " (required for 100-worker fanout)"}`
  });
  const blockingBudgetLimits = input.capacityPlan.limits
    .filter((limit) => limit.admitted < input.requestedWorkers)
    .filter((limit) => ["worker_cap", "attempt_budget", "token_budget", "usd_budget", "wall_time_budget"].includes(limit.kind));
  const sqlite = input.input.ledger.sqliteConcurrencyConfig();
  const sqliteOk = sqlite.journalMode.toLowerCase() === "wal" && sqlite.busyTimeoutMs >= 10_000;
  const arxivPolicy = arxivCompliancePolicy();
  const arxivOk = arxivPolicy.maxConnections === 1 && arxivPolicy.minIntervalMs >= ARXIV_POLITE_MIN_INTERVAL_MS;
  const branchModels = branchModelsForInput(input.input);
  const remoteBranchModels = branchModels.filter((model) => model.provider !== "local");
  const providerRateLimitExplicit = !input.remote || remoteBranchModels.every((model) => model.settings?.resilience?.maxConcurrency !== undefined);
  const providerRateLimitOk = !input.remote || (
    providerRateLimitExplicit &&
    input.providerConcurrency !== undefined &&
    input.providerConcurrency >= 1 &&
    input.providerConcurrency <= 32
  );
  const hardBudgetOk = input.input.run.budget.maxAttempts !== undefined &&
    input.input.run.budget.maxWorkers !== undefined &&
    (!highFanout || (
      input.input.run.budget.maxWallTimeMs !== undefined &&
      input.input.run.budget.maxArtifactBytes !== undefined &&
      input.input.run.budget.maxSourceQueries !== undefined &&
      input.input.run.budget.maxRetries !== undefined &&
      input.input.run.budget.maxSandboxMs !== undefined
    )) &&
    (!input.remote || remoteBranchModels.every((model) => model.settings?.maxUsd !== undefined)) &&
    (!input.remote || remoteBranchModels.every((model) => model.settings?.maxOutputTokens !== undefined));
  const checks: SwarmAdmissionPreview["opsGuard"]["checks"] = [
    highFanoutCheck(hardBudgetOk, "hard_budget_governors", "maxAttempts/maxWorkers plus high-fanout wall-time and remote per-call caps are configured"),
    highFanoutCheck(blockingBudgetLimits.length === 0, "budget_capacity", blockingBudgetLimits.length === 0
      ? `run budget admits requested ${input.requestedWorkers} worker fanout before dispatch`
      : `run budget degrades requested ${input.requestedWorkers} workers to ${input.budgetedWorkers}: ${blockingBudgetLimits.map((limit) => `${limit.kind} admitted ${limit.admitted}`).join(", ")}`),
    {
      id: "sqlite_mode",
      ok: sqliteOk,
      severity: highFanout ? "error" : "warning",
      detail: sqliteOk
        ? `SQLite WAL and busy_timeout=${sqlite.busyTimeoutMs}ms are configured`
        : `SQLite concurrency config unsafe for swarm fanout: journal=${sqlite.journalMode}, busy_timeout=${sqlite.busyTimeoutMs}ms`
    },
    highFanoutCheck(arxivOk, "arxiv_rate_limit", arxivOk
      ? `arXiv limiter configured for ${arxivPolicy.maxConnections} connection and ${arxivPolicy.minIntervalMs}ms spacing`
      : "arXiv limiter is below polite-use threshold"),
    highFanoutCheck(providerRateLimitOk, "provider_rate_limit", providerRateLimitOk
      ? (input.remote ? `remote provider maxConcurrency=${input.providerConcurrency} explicitly configured` : "local deterministic workers do not use remote provider rate limits")
      : "remote high-fanout runs require explicit settings.resilience.maxConcurrency in 1..32"),
    {
      id: "provider_model_diversity",
      ok: !input.enforceHighFanoutOps || input.providerDiversity.ok,
      severity: input.enforceHighFanoutOps && input.providerDiversity.required ? "error" : "warning",
      detail: !input.enforceHighFanoutOps
        ? `${input.providerDiversity.issues.join("; ") || "remote provider/model diversity check deferred"} (required after remote cost consent)`
        : input.providerDiversity.ok
        ? (input.providerDiversity.waiverAccepted
          ? `remote provider/model diversity collapse has explicit waiver ${input.providerDiversity.waiverHash}`
          : `remote high-fanout provider/model diversity has ${input.providerDiversity.uniqueRemoteProviderModelKeys} unique route(s)`)
        : input.providerDiversity.issues.join("; ")
    },
    {
      id: "worker_heartbeat",
      ok: true,
      severity: "error",
      detail: "scheduler leases include heartbeat renewal, stale lease reconciliation, and terminal cancellation polling"
    },
    {
      id: "replay_mode",
      ok: true,
      severity: "error",
      detail: "admission preview, capacity plan, worker events, artifacts, and terminal state are persisted for offline replay before dispatch"
    },
    {
      id: "sandbox_resource_limits",
      ok: true,
      severity: "error",
      detail: `${SANDBOX_POLICY_VERSION} caps generated experiments at memory=${SANDBOX_DEFAULT_MEMORY_BYTES} bytes and maxProcesses=${SANDBOX_DEFAULT_MAX_PROCESSES}`
    },
    {
      id: "retention_policy",
      ok: true,
      severity: "error",
      detail: "ledger events and artifacts are retained in MATEMATICA_HOME with no automatic TTL deletion"
    }
  ];
  return {
    ok: checks.every((check) => check.ok || check.severity === "warning"),
    checks
  };
}

function requiredCapabilities(input: SwarmAdmissionInput, remote: boolean): string[] {
  const capabilities = [
    "append-only SQLite ledger",
    "artifact persistence for every worker step",
    "budget reservations before worker/tool execution",
    "durable cancellation and budget-exhaustion kill switch",
    "deterministic local verifier gate",
    "sandboxed experiment execution"
  ];
  if (input.sourceNetworkMode === "online") capabilities.push("arXiv polite-cache network gate");
  if (remote) capabilities.push("BYOK provider key", "remote cost admission", "AI SDK worker-local tool loop instrumentation");
  return capabilities;
}

function worstCase(input: SwarmAdmissionInput, budgetedWorkers: number): SwarmAdmissionPreview["worstCase"] {
  const branchModels = branchModelsForInput(input);
  const maxCallUsd = maxFinite(branchModels.map((model) => model.settings?.maxUsd));
  const maxOutputTokens = maxFinite(branchModels.map((model) => model.settings?.maxOutputTokens));
  const maxAttempts = Math.max(1, finiteFloor(input.run.budget.maxAttempts) ?? 1);
  const providerCalls = branchModels.length > 0 ? budgetedWorkers * maxAttempts : null;
  return {
    workers: budgetedWorkers,
    attempts: input.run.budget.maxAttempts ?? null,
    tokens: input.run.budget.maxTokens ?? (maxOutputTokens === undefined ? null : maxOutputTokens * budgetedWorkers),
    usd: input.run.budget.maxUsd ?? (maxCallUsd === undefined ? null : maxCallUsd * budgetedWorkers),
    wallTimeMs: input.run.budget.maxWallTimeMs ?? null,
    providerCalls,
    retries: input.run.budget.maxRetries ?? null,
    sourceQueries: input.run.budget.maxSourceQueries ?? null,
    sandboxMs: input.run.budget.maxSandboxMs ?? null,
    artifactBytes: input.run.budget.maxArtifactBytes ?? null,
    source: "run budget caps plus provider per-call caps when configured; null means the dimension is not capped and high-fanout admission fails"
  };
}

function workerRoles(workflow: Workflow): SwarmAdmissionPreview["workerRoles"] {
  if (workflow === "gree") {
    return [
      { role: "gather", contribution: "collect candidate facts, examples, and relevant prior work" },
      { role: "refine", contribution: "turn gathered material into sharper claims and attack surfaces" },
      { role: "experiment", contribution: "run bounded computational/proof-search probes" },
      { role: "evolve", contribution: "rank, consolidate, and select the next branch set" }
    ];
  }
  return [
    { role: "problem", contribution: "normalize the statement, goal, assumptions, and evidence target" },
    { role: "feedback", contribution: "retrieve and critique relevant literature and prior attempts" },
    { role: "loophole", contribution: "search for reductions, counterexamples, and hidden assumptions" },
    { role: "knowledge", contribution: "persist verified claims, gaps, obligations, and next prompts" }
  ];
}

function rateLimitRisk(input: SwarmAdmissionInput, requestedWorkers: number, budgetedWorkers: number): string[] {
  const branchModels = branchModelsForInput(input).filter((model) => model.provider !== "local");
  if (branchModels.length === 0) return [];
  const maxConcurrency = aggregateProviderConcurrency({ branchModels }) ?? branchModels.length;
  if (budgetedWorkers > maxConcurrency) {
    return [`aggregate provider concurrency cap ${maxConcurrency} is below budgeted worker fanout ${budgetedWorkers}; scheduler must queue instead of retry-storming`];
  }
  if (requestedWorkers > maxConcurrency) {
    return [`requested worker fanout ${requestedWorkers} exceeds aggregate provider concurrency cap ${maxConcurrency}; admission relies on budget/concurrency throttling`];
  }
  return [];
}

function branchModelsForInput(input: Pick<SwarmAdmissionInput, "branchModel" | "branchModels">): SwarmAdmissionBranchModel[] {
  if (input.branchModels && input.branchModels.length > 0) return input.branchModels;
  return input.branchModel ? [input.branchModel] : [];
}

function aggregateProviderConcurrency(input: Pick<SwarmAdmissionInput, "branchModel" | "branchModels">): number | undefined {
  const models = branchModelsForInput(input);
  if (models.length === 0) return undefined;
  const limits = models.map((model) => finiteFloor(model.settings?.resilience?.maxConcurrency));
  if (limits.some((limit) => limit === undefined || limit < 1)) return undefined;
  return limits.reduce<number>((total, limit) => total + (limit ?? 0), 0);
}

function providerModelMix(
  branchModels: SwarmAdmissionBranchModel[],
  budgetedWorkers: number
): SwarmAdmissionPreview["providerModelMix"] {
  if (branchModels.length === 0) {
    return [{
      provider: "local",
      modelId: "deterministic-local-v0",
      plannedWorkers: budgetedWorkers,
      remote: false
    }];
  }
  const slots = branchModels.flatMap((model) => {
    const limit = finiteFloor(model.settings?.resilience?.maxConcurrency) ?? 1;
    return Array.from({ length: Math.max(1, limit) }, () => model);
  });
  return branchModels.map((model) => ({
    provider: model.provider,
    modelId: model.modelId,
    plannedWorkers: Array.from({ length: budgetedWorkers }, (_, index) => slots[index % slots.length])
      .filter((slot) => slot.provider === model.provider && slot.modelId === model.modelId)
      .length,
    remote: model.provider !== "local",
    ...openRouterRequestedUpstream(model.provider, model.modelId)
  }));
}

function buildProviderDiversity(input: {
  requestedWorkers: number;
  branchModels: SwarmAdmissionBranchModel[];
  providerModelMix: SwarmAdmissionPreview["providerModelMix"];
  waiver?: SwarmAdmissionInput["providerDiversityWaiver"];
}): SwarmAdmissionPreview["providerDiversity"] {
  const highFanoutThreshold = 16;
  const remoteRoutes = input.branchModels.filter((model) => model.provider !== "local");
  const uniqueRemoteProviderModelKeys = uniqueStrings(remoteRoutes.map((model) => `${model.provider}/${model.modelId}`)).length;
  const required = input.requestedWorkers >= highFanoutThreshold && remoteRoutes.length > 0;
  const minUniqueRemoteProviderModelKeys = required ? 2 : 1;
  const waiverReason = input.waiver?.reason.trim();
  const waiverAccepted = required &&
    uniqueRemoteProviderModelKeys < minUniqueRemoteProviderModelKeys &&
    waiverReason !== undefined &&
    waiverReason.length >= 20;
  const issues = [
    required && uniqueRemoteProviderModelKeys < minUniqueRemoteProviderModelKeys && !waiverAccepted
      ? `remote high-fanout requires at least ${minUniqueRemoteProviderModelKeys} explicit provider/model routes or --provider-diversity-waiver`
      : undefined,
    input.waiver !== undefined && !waiverAccepted && required && uniqueRemoteProviderModelKeys < minUniqueRemoteProviderModelKeys
      ? "provider diversity waiver reason must be at least 20 characters"
      : undefined
  ].filter((issue): issue is string => Boolean(issue));
  return {
    highFanoutThreshold,
    required,
    waiverAccepted,
    waiverReason: waiverAccepted ? waiverReason : undefined,
    waiverHash: waiverAccepted ? stableHash({ reason: waiverReason, actor: input.waiver?.actor ?? "operator-cli" }) : undefined,
    uniqueRemoteProviderModelKeys,
    minUniqueRemoteProviderModelKeys,
    routeLineage: input.providerModelMix.map((route) => ({
      provider: route.provider,
      modelId: route.modelId,
      providerModelKey: `${route.provider}/${route.modelId}`,
      plannedWorkers: route.plannedWorkers,
      remote: route.remote,
      requestedUpstreamProvider: route.requestedUpstreamProvider,
      requestedUpstreamModel: route.requestedUpstreamModel
    })),
    ok: issues.length === 0,
    issues
  };
}

function openRouterRequestedUpstream(provider: ProviderName | "local", modelId: string): {
  requestedUpstreamProvider?: string;
  requestedUpstreamModel?: string;
} {
  if (provider !== "openrouter") return {};
  const separator = modelId.indexOf("/");
  return {
    requestedUpstreamProvider: separator > 0 ? modelId.slice(0, separator) : undefined,
    requestedUpstreamModel: modelId
  };
}

function maxFinite(values: Array<number | undefined>): number | undefined {
  const finite = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return finite.length > 0 ? Math.max(...finite) : undefined;
}

function finiteFloor(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.floor(value);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}
