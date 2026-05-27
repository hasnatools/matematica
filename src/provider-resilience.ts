import type { ProviderName } from "./config";
import { redactText } from "./redaction";

export type ProviderFailureKind =
  | "rate_limit"
  | "server_error"
  | "auth"
  | "quota"
  | "content_filter"
  | "timeout"
  | "malformed_usage"
  | "model_substitution"
  | "stream_abort"
  | "schema_tool_violation"
  | "network"
  | "unknown";

export type ProviderFailureClassification = {
  kind: ProviderFailureKind;
  retryable: boolean;
  statusCode?: number;
  retryAfterMs?: number;
  message: string;
  circuitBreakerFailure: boolean;
};

export type ProviderResilienceSettings = {
  maxRetries?: number;
  retryBackoffMs?: number;
  maxRetryAfterMs?: number;
  maxConcurrency?: number;
  circuitBreaker?: {
    failureThreshold?: number;
    cooldownMs?: number;
  };
  sleep?: (ms: number) => Promise<void>;
};

export type ProviderAdmission =
  | {
      ok: true;
      activeBeforeAcquire: number;
      maxConcurrency: number;
      release: () => void;
    }
  | {
      ok: false;
      reason: string;
      kind: "concurrency" | "circuit_open";
      retryAfterMs?: number;
      activeBeforeAcquire: number;
      maxConcurrency: number;
    };

export type ProviderRetryDecision =
  | {
      retry: true;
      delayMs: number;
      reason: string;
    }
  | {
      retry: false;
      reason: string;
    };

type ProviderCircuitState = {
  active: number;
  consecutiveFailures: number;
  openedUntil?: number;
};

export type NormalizedProviderResiliencePolicy = {
  maxRetries: number;
  retryBackoffMs: number;
  maxRetryAfterMs: number;
  maxConcurrency: number;
  failureThreshold: number;
  cooldownMs: number;
  sleep: (ms: number) => Promise<void>;
};

const DEFAULT_PROVIDER_CONCURRENCY: Record<ProviderName, number> = {
  openai: 8,
  anthropic: 4,
  openrouter: 6,
  cerebras: 8,
  local: 2
};

const states = new Map<ProviderName, ProviderCircuitState>();

export function normalizeProviderResiliencePolicy(
  provider: ProviderName,
  settings: ProviderResilienceSettings | undefined
): NormalizedProviderResiliencePolicy {
  return {
    maxRetries: finiteInteger(settings?.maxRetries, 0),
    retryBackoffMs: finiteInteger(settings?.retryBackoffMs, 250),
    maxRetryAfterMs: finiteInteger(settings?.maxRetryAfterMs, 60_000),
    maxConcurrency: finiteInteger(settings?.maxConcurrency, DEFAULT_PROVIDER_CONCURRENCY[provider]),
    failureThreshold: finiteInteger(settings?.circuitBreaker?.failureThreshold, 3),
    cooldownMs: finiteInteger(settings?.circuitBreaker?.cooldownMs, 30_000),
    sleep: settings?.sleep ?? defaultSleep
  };
}

export function acquireProviderAdmission(
  provider: ProviderName,
  policy: NormalizedProviderResiliencePolicy,
  now = Date.now()
): ProviderAdmission {
  const state = providerState(provider);
  if (state.openedUntil !== undefined && state.openedUntil > now) {
    return {
      ok: false,
      kind: "circuit_open",
      reason: `provider circuit breaker is open for ${provider}`,
      retryAfterMs: state.openedUntil - now,
      activeBeforeAcquire: state.active,
      maxConcurrency: policy.maxConcurrency
    };
  }
  if (state.openedUntil !== undefined && state.openedUntil <= now) {
    state.openedUntil = undefined;
    state.consecutiveFailures = 0;
  }
  if (state.active >= policy.maxConcurrency) {
    return {
      ok: false,
      kind: "concurrency",
      reason: `provider concurrency cap exceeded for ${provider} (${state.active}/${policy.maxConcurrency})`,
      activeBeforeAcquire: state.active,
      maxConcurrency: policy.maxConcurrency
    };
  }
  const activeBeforeAcquire = state.active;
  state.active += 1;
  let released = false;
  return {
    ok: true,
    activeBeforeAcquire,
    maxConcurrency: policy.maxConcurrency,
    release: () => {
      if (released) return;
      released = true;
      state.active = Math.max(0, state.active - 1);
    }
  };
}

export function recordProviderSuccess(provider: ProviderName): void {
  const state = providerState(provider);
  state.consecutiveFailures = 0;
  state.openedUntil = undefined;
}

export function recordProviderFailure(
  provider: ProviderName,
  classification: ProviderFailureClassification,
  policy: NormalizedProviderResiliencePolicy,
  now = Date.now()
): { circuitOpened: boolean; openedUntil?: number } {
  const state = providerState(provider);
  if (!classification.circuitBreakerFailure) {
    return { circuitOpened: false };
  }
  state.consecutiveFailures += 1;
  if (state.consecutiveFailures < policy.failureThreshold) {
    return { circuitOpened: false };
  }
  state.openedUntil = now + policy.cooldownMs;
  return { circuitOpened: true, openedUntil: state.openedUntil };
}

export function providerRetryDecision(input: {
  classification: ProviderFailureClassification;
  attempt: number;
  policy: NormalizedProviderResiliencePolicy;
}): ProviderRetryDecision {
  if (!input.classification.retryable) {
    return { retry: false, reason: `${input.classification.kind} is not retryable` };
  }
  if (input.attempt > input.policy.maxRetries) {
    return { retry: false, reason: `max retries exhausted (${input.policy.maxRetries})` };
  }
  const delayMs = Math.min(
    input.classification.retryAfterMs ?? input.policy.retryBackoffMs * 2 ** Math.max(0, input.attempt - 1),
    input.policy.maxRetryAfterMs
  );
  return {
    retry: true,
    delayMs,
    reason: input.classification.retryAfterMs === undefined ? "exponential_backoff" : "retry_after"
  };
}

export function classifyProviderError(error: unknown): ProviderFailureClassification {
  const statusCode = statusCodeFromError(error);
  const headers = headersFromError(error);
  const message = redactText(errorMessage(error));
  const lower = message.toLowerCase();
  const retryAfterMs = retryAfterMsFromHeaders(headers);
  const code = stringField(error, "code")?.toLowerCase();

  if (lower.includes("content_filter") || lower.includes("content filter") || lower.includes("safety") || lower.includes("policy violation")) {
    return failure("content_filter", false, false, message, statusCode, retryAfterMs);
  }
  if (statusCode === 402 || lower.includes("quota") || lower.includes("insufficient_quota") || lower.includes("billing") || lower.includes("credits")) {
    return failure("quota", false, true, message, statusCode, retryAfterMs);
  }
  if (lower.includes("silent model substitution") || lower.includes("upstream model")) {
    return failure("model_substitution", false, true, message, statusCode, retryAfterMs);
  }
  if (statusCode === 401 || statusCode === 403 || lower.includes("invalid api key") || lower.includes("unauthorized") || lower.includes("forbidden")) {
    return failure("auth", false, true, message, statusCode, retryAfterMs);
  }
  if (statusCode === 429) {
    return failure("rate_limit", true, true, message, statusCode, retryAfterMs);
  }
  if (statusCode !== undefined && statusCode >= 500) {
    return failure("server_error", true, true, message, statusCode, retryAfterMs);
  }
  if (lower.includes("did not include token usage") || lower.includes("missing usage") || lower.includes("malformed usage") || lower.includes("underreported usage")) {
    return failure("malformed_usage", false, false, message, statusCode, retryAfterMs);
  }
  if (lower.includes("schema") || lower.includes("tool-call") || lower.includes("tool call") || lower.includes("structured output")) {
    return failure("schema_tool_violation", false, false, message, statusCode, retryAfterMs);
  }
  if (lower.includes("timeout") || code === "etimedout") {
    return failure("timeout", true, true, message, statusCode, retryAfterMs);
  }
  if (isAbortError(error)) {
    return failure("stream_abort", false, false, message, statusCode, retryAfterMs);
  }
  if (["econnreset", "enotfound", "eai_again", "econnrefused"].includes(code ?? "")) {
    return failure("network", true, true, message, statusCode, retryAfterMs);
  }
  return failure("unknown", false, false, message, statusCode, retryAfterMs);
}

export function retryAfterMsFromHeaders(headers: Record<string, string | undefined>): number | undefined {
  const retryAfterMs = headers["retry-after-ms"];
  if (retryAfterMs !== undefined) {
    const parsed = Number(retryAfterMs);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  const retryAfter = headers["retry-after"];
  if (retryAfter === undefined) return undefined;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const dateDelay = Date.parse(retryAfter) - Date.now();
  return Number.isFinite(dateDelay) && dateDelay >= 0 ? dateDelay : undefined;
}

export function resetProviderResilienceState(): void {
  states.clear();
}

function failure(
  kind: ProviderFailureKind,
  retryable: boolean,
  circuitBreakerFailure: boolean,
  message: string,
  statusCode?: number,
  retryAfterMs?: number
): ProviderFailureClassification {
  return {
    kind,
    retryable,
    statusCode,
    retryAfterMs,
    message,
    circuitBreakerFailure
  };
}

function providerState(provider: ProviderName): ProviderCircuitState {
  let state = states.get(provider);
  if (!state) {
    state = { active: 0, consecutiveFailures: 0 };
    states.set(provider, state);
  }
  return state;
}

function headersFromError(error: unknown): Record<string, string | undefined> {
  const maybeHeaders = recordField(error, "responseHeaders") ?? recordField(error, "headers");
  const headers: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(maybeHeaders ?? {})) {
    if (typeof value === "string") headers[key.toLowerCase()] = value;
  }
  return headers;
}

function statusCodeFromError(error: unknown): number | undefined {
  const direct = numberField(error, "statusCode") ?? numberField(error, "status");
  if (direct !== undefined) return direct;
  const response = recordField(error, "response");
  return numberFromUnknown(response?.status) ?? numberFromUnknown(response?.statusCode);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return JSON.stringify(error);
}

function isAbortError(error: unknown): boolean {
  return stringField(error, "name") === "AbortError";
}

function stringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
}

function numberField(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  return numberFromUnknown((value as Record<string, unknown>)[key]);
}

function recordField(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const field = (value as Record<string, unknown>)[key];
  return field && typeof field === "object" && !Array.isArray(field) ? field as Record<string, unknown> : undefined;
}

function numberFromUnknown(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function finiteInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
