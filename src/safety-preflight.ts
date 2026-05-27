import { ArtifactStore } from "./artifacts";
import { auditRun } from "./audit";
import { checkBudget } from "./budget";
import type { ProviderName } from "./config";
import type { GoalRun } from "./domain";
import { stableHash } from "./idempotency";
import type { Ledger } from "./ledger";
import type { NetworkPolicy } from "./network-policy";
import { hasApprovedRemoteComputeAdmission } from "./remote-admission";
import { arxivCompliancePolicy, ARXIV_POLITE_MIN_INTERVAL_MS } from "./research/arxiv";
import { runSandboxedCommand, SANDBOX_POLICY_VERSION } from "./sandbox";

export type RunSafetyPreflightCheck = {
  id: string;
  ok: boolean;
  severity: "error" | "warning";
  detail: string;
};

export type RunSafetyBranchModel = {
  provider: ProviderName;
  modelId: string;
  providerConfigured?: boolean;
  settings?: {
    maxOutputTokens?: number;
    maxUsd?: number;
    timeout?: number;
    resilience?: {
      maxConcurrency?: number;
    };
    budgetCaps?: unknown;
  };
  remoteAdmission?: {
    localOnly?: boolean;
    explicitRemoteConsent?: boolean;
    providerAllowlist?: ProviderName[];
  };
};

export type RunSafetyPreflightInput = {
  run: GoalRun;
  ledger: Ledger;
  artifacts: ArtifactStore;
  command: "goal run" | "goal resume";
  sourceNetworkPolicy: NetworkPolicy;
  branchModel?: RunSafetyBranchModel;
  branchModels?: RunSafetyBranchModel[];
};

export type RunSafetyPreflightResult = {
  version: "run-safety-preflight-v1";
  ok: boolean;
  command: "goal run" | "goal resume";
  runId: string;
  workflow: string;
  remoteProvider: boolean;
  swarmRequested: boolean;
  sourceNetworkMode: string;
  checks: RunSafetyPreflightCheck[];
  artifactId: string;
  preflightHash: string;
};

export async function runSafetyPreflight(input: RunSafetyPreflightInput): Promise<RunSafetyPreflightResult> {
  const branchModels = branchModelsForInput(input);
  const remoteProvider = branchModels.some((model) => model.provider !== "local");
  const swarmRequested = Math.trunc(input.run.budget.maxWorkers ?? 1) > 1;
  const checks: RunSafetyPreflightCheck[] = [
    ledgerIntegrityCheck(input),
    sqliteReadinessCheck(input),
    hardBudgetCheck(input, remoteProvider, swarmRequested),
    providerConsentCheck(input, remoteProvider),
    providerRuntimeCheck(input, remoteProvider),
    arxivReadinessCheck(input),
    await sandboxReadinessCheck(),
    leanPolicyPinningCheck(input),
    cancellationPathCheck(input),
    inFlightBudgetCheck(input),
    resourceLimitCheck(input),
    killSwitchCheck(input)
  ];
  const ok = checks.every((check) => check.ok || check.severity === "warning");
  const payload = {
    version: "run-safety-preflight-v1" as const,
    ok,
    command: input.command,
    runId: input.run.id,
    workflow: input.run.workflow,
    remoteProvider,
    swarmRequested,
    sourceNetworkMode: input.sourceNetworkPolicy.mode,
    checks
  };
  const artifact = input.artifacts.create(input.run.id, "run.safety.preflight", JSON.stringify(payload, null, 2));
  const result = {
    ...payload,
    artifactId: artifact.id,
    preflightHash: stableHash(payload)
  };
  input.ledger.appendEvent(input.run.id, "run.safety.preflight", result, [artifact.id]);
  return result;
}

export async function requireRunSafetyPreflight(input: RunSafetyPreflightInput): Promise<RunSafetyPreflightResult> {
  const result = await runSafetyPreflight(input);
  if (!result.ok) {
    const errors = result.checks
      .filter((check) => !check.ok && check.severity === "error")
      .map((check) => `${check.id}: ${check.detail}`);
    throw new Error(`Run safety preflight failed: ${errors.join("; ")}`);
  }
  return result;
}

function sqliteReadinessCheck(input: RunSafetyPreflightInput): RunSafetyPreflightCheck {
  const config = input.ledger.sqliteConcurrencyConfig();
  const journalOk = config.journalMode.toLowerCase() === "wal";
  const busyOk = config.busyTimeoutMs >= 10_000;
  const ok = journalOk && busyOk;
  return {
    id: "sqlite_readiness",
    ok,
    severity: "error",
    detail: ok
      ? `SQLite WAL and busy_timeout live at ${config.busyTimeoutMs}ms`
      : `SQLite concurrency config unsafe: journal=${config.journalMode}, busy_timeout=${config.busyTimeoutMs}ms`
  };
}

function ledgerIntegrityCheck(input: RunSafetyPreflightInput): RunSafetyPreflightCheck {
  const audit = auditRun(input.run.id, input.ledger);
  return {
    id: "ledger_integrity",
    ok: audit.ok,
    severity: "error",
    detail: audit.ok ? "ledger audit passed" : audit.issues.map((issue) => `${issue.code}:${issue.message}`).join("; ")
  };
}

function hardBudgetCheck(input: RunSafetyPreflightInput, remoteProvider: boolean, swarmRequested: boolean): RunSafetyPreflightCheck {
  const budget = input.run.budget;
  const remoteModels = branchModelsForInput(input).filter((model) => model.provider !== "local");
  const missing = [
    budget.maxAttempts === undefined ? "maxAttempts" : undefined,
    swarmRequested && budget.maxWorkers === undefined ? "maxWorkers" : undefined,
    remoteProvider && remoteModels.some((model) => model.settings?.maxUsd === undefined) ? "settings.maxUsd" : undefined,
    remoteProvider && remoteModels.some((model) => model.settings?.maxOutputTokens === undefined) ? "settings.maxOutputTokens" : undefined
  ].filter((item): item is string => Boolean(item));
  const ok = missing.length === 0;
  return {
    id: "hard_budget_caps",
    ok,
    severity: "error",
    detail: ok ? "run and provider budgets are bounded" : `missing/failed budget caps: ${missing.join(", ")}`
  };
}

function providerConsentCheck(input: RunSafetyPreflightInput, remoteProvider: boolean): RunSafetyPreflightCheck {
  const branchModels = branchModelsForInput(input);
  if (branchModels.length === 0) {
    return { id: "provider_consent", ok: true, severity: "error", detail: "no provider requested" };
  }
  let anyPersistedConsent = false;
  const missing = branchModels.flatMap((model) => {
    const remote = model.provider !== "local";
    const persistedConsent = remote
      ? hasApprovedRemoteComputeAdmission({
        runId: input.run.id,
        ledger: input.ledger,
        provider: model.provider,
        modelId: model.modelId
      })
      : false;
    if (persistedConsent) anyPersistedConsent = true;
    const localOnly = input.sourceNetworkPolicy.offline || model.remoteAdmission?.localOnly === true;
    return [
      model.providerConfigured === false ? `${model.provider}/${model.modelId}: provider key missing` : undefined,
      remote && localOnly ? `${model.provider}/${model.modelId}: Offline/local-only mode blocks remote provider compute.` : undefined,
      remote &&
      !persistedConsent &&
      model.remoteAdmission?.explicitRemoteConsent !== true
        ? `${model.provider}/${model.modelId}: explicit BYOK remote cost consent missing; pass --i-understand-remote-costs`
      : undefined,
      remote && model.remoteAdmission?.providerAllowlist && !model.remoteAdmission.providerAllowlist.includes(model.provider)
        ? `${model.provider}/${model.modelId}: provider not in allowlist`
        : undefined
    ];
  }).filter((item): item is string => Boolean(item));
  return {
    id: "provider_consent",
    ok: missing.length === 0,
    severity: "error",
    detail: missing.length === 0
      ? (anyPersistedConsent ? "persisted provider consent and allowlists are valid" : "provider consent and allowlists are valid")
      : missing.join("; ")
  };
}

function providerRuntimeCheck(input: RunSafetyPreflightInput, remoteProvider: boolean): RunSafetyPreflightCheck {
  const remoteModels = branchModelsForInput(input).filter((model) => model.provider !== "local");
  if (!remoteProvider || remoteModels.length === 0) {
    return { id: "provider_runtime", ok: true, severity: "error", detail: "no remote provider runtime needed" };
  }
  const lockIds: string[] = [];
  try {
    for (const model of remoteModels) {
      const maxConcurrency = Math.trunc(model.settings?.resilience?.maxConcurrency ?? 1);
      if (maxConcurrency < 1 || maxConcurrency > 32) {
        return {
          id: "provider_runtime",
          ok: false,
          severity: "error",
          detail: `${model.provider}/${model.modelId} maxConcurrency ${maxConcurrency} is outside preflight-probe bounds 1..32`
        };
      }
      for (let index = 0; index < maxConcurrency; index += 1) {
        const admission = input.ledger.acquireProviderRuntimeSlot({
          runId: input.run.id,
          provider: model.provider,
          modelId: model.modelId,
          operationId: `run-safety-preflight-provider-${model.provider}-${index}`,
          maxConcurrency,
          leaseMs: 10_000
        });
        if (!admission.ok) {
          return {
            id: "provider_runtime",
            ok: false,
            severity: "error",
            detail: `${model.provider}/${model.modelId} semaphore rejected slot ${index + 1}/${maxConcurrency}: ${admission.reason}`
          };
        }
        lockIds.push(admission.lockId);
      }
      const overflow = input.ledger.acquireProviderRuntimeSlot({
        runId: input.run.id,
        provider: model.provider,
        modelId: model.modelId,
        operationId: `run-safety-preflight-provider-overflow-${model.provider}`,
        maxConcurrency,
        leaseMs: 10_000
      });
      if (overflow.ok) {
        input.ledger.releaseProviderRuntimeSlot(overflow.lockId);
        return {
          id: "provider_runtime",
          ok: false,
          severity: "error",
          detail: `${model.provider}/${model.modelId} semaphore allowed a lock beyond maxConcurrency`
        };
      }
    }
    return {
      id: "provider_runtime",
      ok: true,
      severity: "error",
      detail: `SQLite-backed provider semaphores admitted configured slot(s) and refused overflow for ${remoteModels.length} remote route(s)`
    };
  } finally {
    for (const lockId of lockIds) input.ledger.releaseProviderRuntimeSlot(lockId);
  }
}

function arxivReadinessCheck(input: RunSafetyPreflightInput): RunSafetyPreflightCheck {
  const policy = arxivCompliancePolicy();
  const staticPolicyOk = policy.maxConnections === 1 && policy.minIntervalMs >= ARXIV_POLITE_MIN_INTERVAL_MS;
  if (!staticPolicyOk) {
    return {
      id: "arxiv_readiness",
      ok: false,
      severity: "error",
      detail: "arXiv polite limiter is below compliance threshold"
    };
  }
  const lock = input.ledger.acquireProviderRuntimeSlot({
    runId: input.run.id,
    provider: "arxiv",
    modelId: "api",
    operationId: "run-safety-preflight-arxiv-lock",
    maxConcurrency: policy.maxConnections,
    leaseMs: policy.minIntervalMs
  });
  if (!lock.ok) {
    return {
      id: "arxiv_readiness",
      ok: false,
      severity: "error",
      detail: `arXiv SQLite limiter unavailable: ${lock.reason}`
    };
  }
  try {
    const overflow = input.ledger.acquireProviderRuntimeSlot({
      runId: input.run.id,
      provider: "arxiv",
      modelId: "api",
      operationId: "run-safety-preflight-arxiv-overflow",
      maxConcurrency: policy.maxConnections,
      leaseMs: policy.minIntervalMs
    });
    if (overflow.ok) {
      input.ledger.releaseProviderRuntimeSlot(overflow.lockId);
      return {
        id: "arxiv_readiness",
        ok: false,
        severity: "error",
        detail: "arXiv SQLite limiter allowed more than one concurrent connection"
      };
    }
  } finally {
    input.ledger.releaseProviderRuntimeSlot(lock.lockId);
  }
  return {
    id: "arxiv_readiness",
    ok: true,
    severity: "error",
    detail: `arXiv polite limiter acquired one SQLite slot, refused overflow, and requires ${policy.minIntervalMs}ms spacing`
  };
}

async function sandboxReadinessCheck(): Promise<RunSafetyPreflightCheck> {
  const result = await runSandboxedCommand({
    purpose: "generated-experiment",
    command: [
      "/bin/echo",
      "matematica-safety-preflight"
    ],
    cwd: process.cwd(),
    timeoutMs: 1_000,
    memoryBytes: 128 * 1024 * 1024,
    maxProcesses: 8,
    env: {}
  });
  const outputOk = result.exitCode === 0 && result.stdout.trim() === "matematica-safety-preflight";
  const policyOk =
    result.policy.version === SANDBOX_POLICY_VERSION &&
    result.policy.isolation.environment === "allowlist" &&
    result.policy.isolation.shell === "disabled" &&
    result.policy.resourceLimits.wallTimeMs === 1_000 &&
    result.policy.resourceLimits.memoryBytes === 128 * 1024 * 1024 &&
    result.policy.resourceLimits.maxProcesses === 8;
  const ok = outputOk && policyOk && !result.timedOut;
  return {
    id: "sandbox_readiness",
    ok,
    severity: "error",
    detail: ok
      ? `sandbox dry-run passed with ${result.policy.isolation.resourceLimits}/${result.policy.isolation.wallTime} resource caps`
      : `sandbox dry-run failed: exit=${result.exitCode}, timedOut=${result.timedOut}, stderr=${result.stderr.slice(0, 160)}`
  };
}

function leanPolicyPinningCheck(input: RunSafetyPreflightInput): RunSafetyPreflightCheck {
  const pinned = input.ledger.listEvents(input.run.id).some((event) => event.type === "policy.manifest.pinned");
  return {
    id: "lean_policy_pinning",
    ok: pinned,
    severity: "error",
    detail: pinned ? "verifier policy manifest is pinned for replay" : "missing pinned verifier policy manifest"
  };
}

function cancellationPathCheck(input: RunSafetyPreflightInput): RunSafetyPreflightCheck {
  const probe = input.ledger.enqueueWorkerJob({
    runId: input.run.id,
    kind: "safety.preflight.cancellation",
    maxAttempts: 1,
    dedupeKey: `safety-preflight-cancellation-${input.command}-${input.ledger.listEvents(input.run.id).length}`,
    payload: {
      command: input.command,
      purpose: "prove scoped durable cancellation before swarm dispatch"
    }
  });
  const cancelled = input.ledger.cancelWorkerJobAsSystemForPreflight(
    probe.id,
    "run safety preflight cancellation probe"
  );
  const ok = cancelled.status === "cancelled";
  return {
    id: "durable_cancellation_path",
    ok,
    severity: "error",
    detail: ok
      ? `durable cancellation probe ${probe.id} was enqueued and cancelled through SQLite worker state`
      : `durable cancellation probe ${probe.id} ended in ${cancelled.status}`
  };
}

function inFlightBudgetCheck(input: RunSafetyPreflightInput): RunSafetyPreflightCheck {
  const usage = input.ledger.getBudgetUsage(input.run.id);
  const check = checkBudget(input.run, usage);
  return {
    id: "in_flight_budget_caps",
    ok: check.ok,
    severity: "error",
    detail: check.ok ? "open reservations are within run caps" : check.reason ?? "budget exceeded"
  };
}

function resourceLimitCheck(input: RunSafetyPreflightInput): RunSafetyPreflightCheck {
  const maxWorkers = Math.trunc(input.run.budget.maxWorkers ?? 1);
  const ok = maxWorkers > 0 && maxWorkers <= 100;
  return {
    id: "resource_limits",
    ok,
    severity: "error",
    detail: ok ? `worker fanout capped at ${maxWorkers}` : `worker fanout ${maxWorkers} is outside supported bounds`
  };
}

function killSwitchCheck(input: RunSafetyPreflightInput): RunSafetyPreflightCheck {
  const maxAttempts = Math.trunc(input.run.budget.maxAttempts ?? 0);
  const maxWorkers = Math.trunc(input.run.budget.maxWorkers ?? 1);
  const ok = maxAttempts >= 0 && maxWorkers > 0;
  return {
    id: "kill_switch",
    ok,
    severity: "error",
    detail: ok ? "budget exhaustion and goal stop use durable worker cancellation" : "missing maxWorkers kill-switch cap"
  };
}

function branchModelsForInput(input: Pick<RunSafetyPreflightInput, "branchModel" | "branchModels">): RunSafetyBranchModel[] {
  if (input.branchModels && input.branchModels.length > 0) return input.branchModels;
  return input.branchModel ? [input.branchModel] : [];
}
