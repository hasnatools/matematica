import type { ProviderName } from "./config";
import { isRemoteProvider } from "./privacy";

export type RemoteCostPreflightInput = {
  command: "goal run" | "goal resume" | "providers smoke" | "providers hostile-dry-run";
  provider: ProviderName;
  modelId: string;
  localOnly: boolean;
  maxWorkers?: number;
  maxAttempts?: number;
  runMaxUsd?: number;
  runMaxTokens?: number;
  maxCallUsd?: number;
  maxOutputTokens?: number;
  providerTimeoutMs?: number;
  maxToolLoopStepsPerWorker?: number;
  maxProviderRetriesPerCall?: number;
  maxSubagentCallsPerStep?: number;
  maxToolCallsPerStep?: number;
  maxArxivCallsPerRun?: number;
  maxVerifierCallsPerRun?: number;
  runMaxWallTimeMs?: number;
  inFlightReservations?: {
    attempts: number;
    tokens: number;
    usd: number;
    elapsedMs: number;
    artifactBytes: number;
    sourceQueries: number;
    retries: number;
    sandboxMs: number;
    count: number;
  };
  explicitRemoteConsent: boolean;
  unledgeredCall?: boolean;
};

export type RemoteSwarmBudgetEnvelope = {
  version: "remote-swarm-budget-envelope-v1";
  bounded: boolean;
  command: RemoteCostPreflightInput["command"];
  workerFanout: {
    maxWorkers: number;
    maxAttempts: number;
    maxWorkerAttempts: number;
  };
  aiSdkToolLoop: {
    maxStepsPerWorker: number;
    maxProviderRetriesPerCall: number;
    maxSubagentCallsPerStep: number;
    maxToolCallsPerStep: number;
    maxProviderCalls: number;
    maxSubagentCalls: number;
    maxToolCalls: number;
  };
  sideEffects: {
    maxArxivCalls: number;
    maxVerifierCalls: number;
    maxExternalEffects: number;
  };
  upperBounds: {
    attempts: number;
    usd?: number;
    tokens?: number;
    wallTimeMs: number;
  };
  caps: {
    runMaxUsd?: number;
    runMaxTokens?: number;
    runMaxWallTimeMs?: number;
    maxCallUsd?: number;
    maxOutputTokens?: number;
    providerTimeoutMs: number;
  };
  inFlightReservations: {
    attempts: number;
    tokens: number;
    usd: number;
    elapsedMs: number;
    artifactBytes: number;
    sourceQueries: number;
    retries: number;
    sandboxMs: number;
    count: number;
  };
  refusals: string[];
};

export type RemoteCostPreflight = {
  ok: boolean;
  reason?: string;
  command: RemoteCostPreflightInput["command"];
  provider: ProviderName;
  modelId: string;
  remote: boolean;
  localOnly: boolean;
  byok: boolean;
  bundledCompute: boolean;
  explicitRemoteConsent: boolean;
  unledgeredCall: boolean;
  maxWorkers: number;
  maxAttempts: number;
  estimatedMaxProviderCalls: number;
  runMaxUsd?: number;
  runMaxTokens?: number;
  maxCallUsd?: number;
  maxOutputTokens?: number;
  usdCapPresent: boolean;
  tokenCapPresent: boolean;
  estimate: {
    usdUpperBound?: number;
    tokenUpperBound?: number;
    source: "max-call-usd" | "budget-usd" | "max-output-tokens" | "uncapped";
  };
  envelope: RemoteSwarmBudgetEnvelope;
  warning?: string;
};

const DEFAULT_PROVIDER_TIMEOUT_MS = 60_000;
const DEFAULT_TOOL_LOOP_STEPS_PER_WORKER = 1;
const DEFAULT_PROVIDER_RETRIES_PER_CALL = 0;
const DEFAULT_SUBAGENT_CALLS_PER_STEP = 0;
const DEFAULT_TOOL_CALLS_PER_STEP = 0;
const DEFAULT_ARXIV_CALLS_PER_RUN = 1;
const DEFAULT_VERIFIER_CALLS_PER_RUN = 3;

export function remoteCostPreflight(input: RemoteCostPreflightInput): RemoteCostPreflight {
  const remote = isRemoteProvider(input.provider);
  const maxWorkers = Math.max(1, Math.trunc(input.maxWorkers ?? 1));
  const maxAttempts = Math.max(1, Math.trunc(input.maxAttempts ?? 1));
  const usdCapPresent = input.runMaxUsd !== undefined || input.maxCallUsd !== undefined;
  const tokenCapPresent = input.runMaxTokens !== undefined || input.maxOutputTokens !== undefined;
  const envelope = compileRemoteSwarmBudgetEnvelope(input, maxWorkers, maxAttempts);
  const estimatedMaxProviderCalls = envelope.aiSdkToolLoop.maxProviderCalls;
  const estimate = estimateRemoteCost(input, envelope.aiSdkToolLoop.maxProviderCalls);
  const base = {
    ok: true,
    command: input.command,
    provider: input.provider,
    modelId: input.modelId,
    remote,
    localOnly: input.localOnly,
    byok: remote,
    bundledCompute: false,
    explicitRemoteConsent: input.explicitRemoteConsent,
    unledgeredCall: Boolean(input.unledgeredCall),
    maxWorkers,
    maxAttempts,
    estimatedMaxProviderCalls,
    runMaxUsd: input.runMaxUsd,
    runMaxTokens: input.runMaxTokens,
    maxCallUsd: input.maxCallUsd,
    maxOutputTokens: input.maxOutputTokens,
    usdCapPresent,
    tokenCapPresent,
    estimate,
    envelope
  } satisfies Omit<RemoteCostPreflight, "reason" | "warning">;

  if (!remote) return base;

  if (input.unledgeredCall && !input.explicitRemoteConsent) {
    return {
      ...base,
      ok: false,
      reason: "Remote provider smoke tests can spend BYOK provider credits; pass --i-understand-remote-costs to run an unledgered smoke call."
    };
  }

  if (maxWorkers > 1 && !input.explicitRemoteConsent) {
    return {
      ...base,
      ok: false,
      reason: `Remote provider fanout may make up to ${estimatedMaxProviderCalls} BYOK provider calls; pass --i-understand-remote-costs to acknowledge paid remote compute.`
    };
  }

  if (input.maxCallUsd === undefined) {
    return {
      ...base,
      ok: false,
      reason: "Remote provider calls require --max-call-usd as an explicit pessimistic per-call USD cap."
    };
  }

  if (input.maxOutputTokens === undefined) {
    return {
      ...base,
      ok: false,
      reason: "Remote provider calls require --max-output-tokens so the swarm token envelope is finite."
    };
  }

  if (!envelope.bounded) {
    return {
      ...base,
      ok: false,
      reason: `Remote swarm budget envelope is unbounded: ${envelope.refusals.join("; ")}.`
    };
  }

  if (input.runMaxUsd !== undefined && envelope.upperBounds.usd !== undefined && envelope.upperBounds.usd > input.runMaxUsd) {
    return {
      ...base,
      ok: false,
      reason: `Remote swarm USD envelope ${envelope.upperBounds.usd} exceeds run budget ${input.runMaxUsd}.`
    };
  }

  if (input.runMaxTokens !== undefined && envelope.upperBounds.tokens !== undefined && envelope.upperBounds.tokens > input.runMaxTokens) {
    return {
      ...base,
      ok: false,
      reason: `Remote swarm token envelope ${envelope.upperBounds.tokens} exceeds run budget ${input.runMaxTokens}.`
    };
  }

  if (maxWorkers > 1 && !usdCapPresent) {
    return {
      ...base,
      warning: "Remote fanout has no USD cap; configure --budget-usd on the run or --max-call-usd on the command to bound provider spend."
    };
  }

  return base;
}

export function compileRemoteSwarmBudgetEnvelope(
  input: RemoteCostPreflightInput,
  maxWorkers = Math.max(1, Math.trunc(input.maxWorkers ?? 1)),
  maxAttempts = Math.max(1, Math.trunc(input.maxAttempts ?? 1))
): RemoteSwarmBudgetEnvelope {
  const providerSmoke = input.command === "providers smoke" || input.command === "providers hostile-dry-run";
  const workerAttempts = providerSmoke ? 1 : maxWorkers * maxAttempts;
  const maxToolLoopStepsPerWorker = boundedInteger(input.maxToolLoopStepsPerWorker, DEFAULT_TOOL_LOOP_STEPS_PER_WORKER);
  const maxProviderRetriesPerCall = boundedInteger(input.maxProviderRetriesPerCall, DEFAULT_PROVIDER_RETRIES_PER_CALL);
  const maxSubagentCallsPerStep = boundedInteger(input.maxSubagentCallsPerStep, DEFAULT_SUBAGENT_CALLS_PER_STEP);
  const maxToolCallsPerStep = boundedInteger(input.maxToolCallsPerStep, DEFAULT_TOOL_CALLS_PER_STEP);
  const providerTimeoutMs = boundedInteger(input.providerTimeoutMs, DEFAULT_PROVIDER_TIMEOUT_MS);
  const maxArxivCallsPerRun = boundedInteger(input.maxArxivCallsPerRun, DEFAULT_ARXIV_CALLS_PER_RUN);
  const maxVerifierCallsPerRun = boundedInteger(input.maxVerifierCallsPerRun, DEFAULT_VERIFIER_CALLS_PER_RUN);
  const toolLoopSteps = workerAttempts * maxToolLoopStepsPerWorker;
  const maxProviderCalls = providerSmoke
    ? 1
    : toolLoopSteps * (1 + maxProviderRetriesPerCall);
  const maxSubagentCalls = toolLoopSteps * maxSubagentCallsPerStep;
  const maxToolCalls = toolLoopSteps * maxToolCallsPerStep;
  const maxArxivCalls = providerSmoke ? 0 : maxAttempts * maxArxivCallsPerRun;
  const maxVerifierCalls = providerSmoke ? 0 : maxAttempts * maxVerifierCallsPerRun;
  const inFlightReservations = input.inFlightReservations ?? {
    attempts: 0,
    tokens: 0,
    usd: 0,
    elapsedMs: 0,
    artifactBytes: 0,
    sourceQueries: 0,
    retries: 0,
    sandboxMs: 0,
    count: 0
  };
  const usdUpperBound = input.maxCallUsd === undefined
    ? undefined
    : roundUsd((input.maxCallUsd * maxProviderCalls) + inFlightReservations.usd);
  const tokenUpperBound = input.maxOutputTokens === undefined
    ? undefined
    : (Math.trunc(input.maxOutputTokens) * maxProviderCalls) + inFlightReservations.tokens;
  const derivedWallTimeMs = maxProviderCalls * providerTimeoutMs;
  const wallTimeMs = input.runMaxWallTimeMs === undefined
    ? derivedWallTimeMs + inFlightReservations.elapsedMs
    : Math.min(input.runMaxWallTimeMs, derivedWallTimeMs + inFlightReservations.elapsedMs);
  const refusals = [
    finitePositive(maxWorkers) ? undefined : "maxWorkers is not finite",
    finitePositive(maxAttempts) ? undefined : "maxAttempts is not finite",
    finitePositive(maxToolLoopStepsPerWorker) ? undefined : "maxToolLoopStepsPerWorker is not finite",
    finiteNonNegative(maxProviderRetriesPerCall) ? undefined : "maxProviderRetriesPerCall is not finite",
    finiteNonNegative(maxSubagentCallsPerStep) ? undefined : "maxSubagentCallsPerStep is not finite",
    finiteNonNegative(maxToolCallsPerStep) ? undefined : "maxToolCallsPerStep is not finite",
    finitePositive(providerTimeoutMs) ? undefined : "providerTimeoutMs is not finite",
    input.maxCallUsd === undefined ? "maxCallUsd is required" : undefined,
    input.maxOutputTokens === undefined ? "maxOutputTokens is required" : undefined,
    finiteNonNegative(inFlightReservations.attempts) &&
      finiteNonNegative(inFlightReservations.tokens) &&
      finiteNonNegative(inFlightReservations.usd) &&
      finiteNonNegative(inFlightReservations.elapsedMs) &&
      finiteNonNegative(inFlightReservations.artifactBytes) &&
      finiteNonNegative(inFlightReservations.sourceQueries) &&
      finiteNonNegative(inFlightReservations.retries) &&
      finiteNonNegative(inFlightReservations.sandboxMs) &&
      finiteNonNegative(inFlightReservations.count)
      ? undefined
      : "inFlightReservations are not finite"
  ].filter((item): item is string => Boolean(item));
  return {
    version: "remote-swarm-budget-envelope-v1",
    bounded: refusals.length === 0,
    command: input.command,
    workerFanout: {
      maxWorkers,
      maxAttempts,
      maxWorkerAttempts: workerAttempts
    },
    aiSdkToolLoop: {
      maxStepsPerWorker: maxToolLoopStepsPerWorker,
      maxProviderRetriesPerCall,
      maxSubagentCallsPerStep,
      maxToolCallsPerStep,
      maxProviderCalls,
      maxSubagentCalls,
      maxToolCalls
    },
    sideEffects: {
      maxArxivCalls,
      maxVerifierCalls,
      maxExternalEffects: maxProviderCalls + maxSubagentCalls + maxToolCalls + maxArxivCalls + maxVerifierCalls
    },
    upperBounds: {
      attempts: maxProviderCalls + maxArxivCalls + maxVerifierCalls + inFlightReservations.attempts,
      usd: usdUpperBound,
      tokens: tokenUpperBound,
      wallTimeMs
    },
    caps: {
      runMaxUsd: input.runMaxUsd,
      runMaxTokens: input.runMaxTokens,
      runMaxWallTimeMs: input.runMaxWallTimeMs,
      maxCallUsd: input.maxCallUsd,
      maxOutputTokens: input.maxOutputTokens,
      providerTimeoutMs
    },
    inFlightReservations,
    refusals
  };
}

function estimateRemoteCost(
  input: RemoteCostPreflightInput,
  estimatedMaxProviderCalls: number
): RemoteCostPreflight["estimate"] {
  if (input.maxCallUsd !== undefined) {
    return {
      usdUpperBound: roundUsd(input.maxCallUsd * estimatedMaxProviderCalls),
      source: "max-call-usd"
    };
  }
  if (input.runMaxUsd !== undefined) {
    return {
      usdUpperBound: input.runMaxUsd,
      source: "budget-usd"
    };
  }
  if (input.maxOutputTokens !== undefined) {
    return {
      tokenUpperBound: Math.trunc(input.maxOutputTokens) * estimatedMaxProviderCalls,
      source: "max-output-tokens"
    };
  }
  return { source: "uncapped" };
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function boundedInteger(value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  return Number.isFinite(resolved) ? Math.trunc(resolved) : Number.NaN;
}

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function finiteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}
