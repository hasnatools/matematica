import type { MatematicaConfig, ProviderConfig, ProviderName } from "./config";
import type { ArtifactStore } from "./artifacts";
import type { Ledger } from "./ledger";
import type { LedgerEvent } from "./domain";
import { buildProviderPolicyFreshnessSnapshots, type FreshnessSnapshot } from "./freshness";
import { stableHash } from "./idempotency";
import { providerPricingHash } from "./provider-pricing";
import { redactJson } from "./redaction";

export type ProviderCapabilityRecord = {
  provider: ProviderName;
  configured: boolean;
  requestedModel: string;
  actualUpstreamModel?: string;
  actualUpstreamProvider?: string;
  modelCatalog: ProviderModelCatalog;
  apiPackage: {
    packageName: string;
    adapter: string;
    notes: string;
  };
  supportedModelIds: {
    source: "provider_documentation" | "operator_config" | "gateway_catalog" | "unknown";
    patterns: string[];
    notes: string;
  };
  tools: "supported" | "unknown" | "unsupported";
  streaming: "supported" | "unknown" | "unsupported";
  structuredOutput: "supported" | "unknown" | "unsupported";
  toolCallBehavior: {
    source: "ai_sdk_adapter" | "provider_documentation" | "operator_config" | "unknown";
    parallelToolCalls: "supported" | "unknown" | "unsupported";
    notes: string;
  };
  streamingUsageMetadata: {
    source: "ai_sdk_adapter" | "provider_documentation" | "operator_config" | "unknown";
    usageInStream: "supported" | "unknown" | "unsupported";
    notes: string;
  };
  tokenLimit: {
    source: "operator_config" | "provider_documentation" | "unknown";
    maxInputTokens?: number;
    maxOutputTokens?: number;
    notes: string;
  };
  costSource: {
    source: "provider_billing_page" | "openrouter_generation_metadata" | "local_operator_config" | "unknown";
    notes: string;
  };
  pricingReview: {
    reviewedAt: string;
    expiresAt: string;
    reviewer: "matematica-maintainers";
    sourceUrls: string[];
    pricingHash?: string;
  };
  retrySemantics: {
    safeToRetryWithSameIdempotencyKey: boolean;
    retryableFailures: string[];
    notes: string;
  };
  rateLimits: {
    source: "provider_dashboard" | "local_runtime" | "unknown";
    policy: string;
  };
  privacy: {
    source: "provider_policy" | "local_operator_config" | "unknown";
    dataRetention: string;
    trainingUse: string;
    zeroDataRetentionAvailable: boolean | "unknown";
    notes: string;
  };
  legal: {
    source: "provider_terms" | "local_operator_config" | "unknown";
    termsOfService: string;
    license: string;
    redistribution: string;
    notes: string;
  };
  byokEnvVars: string[];
  policyReview: {
    reviewedAt: string;
    expiresAt: string;
    reviewer: "matematica-maintainers";
    sourceUrls: string[];
    policyHash?: string;
  };
  unsupportedSettings: string[];
  updatedAt: string;
};

export type ProviderModelCatalogSelectionSource = "default_config" | "operator_override" | "operator_config";

export type ProviderModelCatalogEntry = {
  modelId: string;
  status: "known" | "deprecated" | "unknown";
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  toolCalling: "supported" | "unknown" | "unsupported";
  structuredOutput: "supported" | "unknown" | "unsupported";
  streaming: "supported" | "unknown" | "unsupported";
  usageMetadata: "supported" | "unknown" | "unsupported";
  pricingSource: ProviderCapabilityRecord["costSource"]["source"];
  providerOptions: string[];
  notes: string;
};

export type ProviderModelCatalog = {
  format: "matematica.provider-model-catalog";
  version: 1;
  source: "provider_documentation" | "operator_config" | "gateway_catalog";
  refreshedAt: string;
  expiresAt: string;
  catalogHash: string;
  knownModels: ProviderModelCatalogEntry[];
  selected: ProviderModelCatalogEntry & {
    selectionSource: ProviderModelCatalogSelectionSource;
    catalogMatch: "exact" | "pattern" | "operator_config";
  };
};

export type ProviderRequiredCapabilities = {
  tools?: boolean;
  streaming?: boolean;
  structuredOutput?: boolean;
};

export type ProviderMatrixSnapshot = {
  format: "matematica.provider-capability-matrix";
  version: 1;
  routingPolicyVersion: "provider-routing-v1";
  generatedAt: string;
  source: string;
  providerAllowlist: ProviderName[];
  requiredCapabilities: ProviderRequiredCapabilities;
  fallbackPolicy: {
    automaticProviderFallback: false;
    silentModelSubstitution: false;
    explicitFallbackRequiresRoutingEvent: true;
  };
  providers: ProviderCapabilityRecord[];
  freshnessSnapshots: FreshnessSnapshot[];
  matrixHash: string;
};

export type ProviderMatrixPin = {
  artifactId: string;
  eventId: string;
  matrixHash: string;
  snapshot: ProviderMatrixSnapshot;
};

export type ProviderLegalPrivacyGateCheck = {
  ok: boolean;
  provider: ProviderName;
  modelId: string;
  checkedAt: string;
  reviewedAt: string;
  expiresAt: string;
  policyHash: string;
  expectedPolicyHash?: string;
  stale: boolean;
  reviewAgeDays?: number;
  issues: string[];
};

export type ProviderLegalPrivacyGateReport = {
  format: "matematica.provider-legal-privacy-gate";
  version: 1;
  ok: boolean;
  checkedAt: string;
  maxAgeDays: number;
  checks: ProviderLegalPrivacyGateCheck[];
};

const CAPABILITY_UPDATED_AT = "2026-05-25";
const CAPABILITY_EXPIRES_AT = "2026-08-23";
export const PROVIDER_POLICY_MAX_AGE_DAYS = 90;
const MODEL_CATALOG_REFRESHED_AT = "2026-05-26";
const MODEL_CATALOG_EXPIRES_AT = "2026-08-24";

const MODEL_CATALOGS: Record<ProviderName, {
  source: ProviderModelCatalog["source"];
  knownModels: ProviderModelCatalogEntry[];
}> = {
  openai: {
    source: "provider_documentation",
    knownModels: [
      modelEntry("gpt-5.2", "known", 400_000, 128_000, "supported", "supported", "supported", "provider_billing_page", ["reasoning.effort", "service_tier"], "Current OpenAI frontier coding and agentic model."),
      modelEntry("gpt-5.2-pro", "known", 400_000, 128_000, "supported", "supported", "supported", "provider_billing_page", ["reasoning.effort"], "Higher-compute GPT-5.2 variant."),
      modelEntry("gpt-5.2-codex", "known", 400_000, 128_000, "supported", "supported", "supported", "provider_billing_page", ["reasoning.effort"], "GPT-5.2 variant optimized for long-horizon coding."),
      modelEntry("gpt-5.1", "known", 400_000, 128_000, "supported", "supported", "supported", "provider_billing_page", ["reasoning.effort", "service_tier"], "Previous GPT-5.1 frontier model."),
      modelEntry("gpt-5", "known", 400_000, 128_000, "supported", "supported", "supported", "provider_billing_page", ["reasoning.effort", "service_tier"], "Previous GPT-5 reasoning model.")
    ]
  },
  anthropic: {
    source: "provider_documentation",
    knownModels: [
      modelEntry("claude-opus-4-1-20250805", "known", 200_000, 32_000, "supported", "supported", "supported", "provider_billing_page", ["thinking", "tool_choice"], "Pinned Anthropic Opus 4.1 snapshot."),
      modelEntry("claude-opus-4-20250514", "known", 200_000, 32_000, "supported", "supported", "supported", "provider_billing_page", ["thinking", "tool_choice"], "Pinned Anthropic Opus 4 snapshot."),
      modelEntry("claude-sonnet-4-20250514", "known", 200_000, 64_000, "supported", "supported", "supported", "provider_billing_page", ["thinking", "tool_choice", "context-1m-beta"], "Pinned Anthropic Sonnet 4 snapshot."),
      modelEntry("claude-3-5-sonnet-20241022", "deprecated", 200_000, 8192, "supported", "supported", "supported", "provider_billing_page", ["tool_choice"], "Deprecated Claude 3.5 Sonnet snapshot.")
    ]
  },
  openrouter: {
    source: "gateway_catalog",
    knownModels: [
      modelEntry("openai/gpt-5.2", "known", 400_000, 128_000, "supported", "supported", "supported", "openrouter_generation_metadata", ["provider.order", "provider.require_parameters", "provider.max_price"], "OpenRouter route for OpenAI GPT-5.2 with upstream provenance required."),
      modelEntry("openai/gpt-5.1", "known", 400_000, 128_000, "supported", "supported", "supported", "openrouter_generation_metadata", ["provider.order", "provider.require_parameters", "provider.max_price"], "OpenRouter route for OpenAI GPT-5.1 with upstream provenance required."),
      modelEntry("anthropic/claude-opus-4.1", "known", 200_000, 32_000, "supported", "supported", "supported", "openrouter_generation_metadata", ["provider.order", "provider.require_parameters", "provider.max_price"], "OpenRouter route for Claude Opus 4.1 with upstream provenance required."),
      modelEntry("anthropic/claude-sonnet-4", "known", 200_000, 64_000, "supported", "supported", "supported", "openrouter_generation_metadata", ["provider.order", "provider.require_parameters", "provider.max_price"], "OpenRouter route for Claude Sonnet 4 with upstream provenance required.")
    ]
  },
  cerebras: {
    source: "provider_documentation",
    knownModels: [
      modelEntry("gpt-oss-120b", "known", 128_000, 65_536, "supported", "supported", "supported", "provider_billing_page", ["service_tier", "reasoning_effort"], "Cerebras-hosted GPT OSS 120B reasoning model."),
      modelEntry("llama3.1-8b", "known", 128_000, 8192, "supported", "supported", "supported", "provider_billing_page", ["service_tier"], "Cerebras-hosted Llama 3.1 8B model.")
    ]
  },
  local: {
    source: "operator_config",
    knownModels: []
  }
};

const BASE_CAPABILITIES: Record<ProviderName, Omit<ProviderCapabilityRecord, "configured" | "requestedModel" | "actualUpstreamModel" | "actualUpstreamProvider" | "modelCatalog">> = {
  openai: {
    provider: "openai",
    apiPackage: {
      packageName: "@ai-sdk/openai",
      adapter: "createOpenAI",
      notes: "Official AI SDK OpenAI adapter; BYOK only."
    },
    supportedModelIds: {
      source: "provider_documentation",
      patterns: ["gpt-*", "o*", "chatgpt-*"],
      notes: "Model ids are selected by the operator and must be valid for the configured OpenAI account."
    },
    tools: "supported",
    streaming: "supported",
    structuredOutput: "supported",
    toolCallBehavior: {
      source: "ai_sdk_adapter",
      parallelToolCalls: "supported",
      notes: "Tool-call traces must be persisted through the CLI ledger before any claim can be trusted."
    },
    streamingUsageMetadata: {
      source: "ai_sdk_adapter",
      usageInStream: "supported",
      notes: "Streaming chunks are saved as local redacted artifacts; final usage remains mandatory."
    },
    tokenLimit: {
      source: "provider_documentation",
      notes: "Model-specific context and output limits must be checked against the selected OpenAI model."
    },
    costSource: {
      source: "provider_billing_page",
      notes: "Use current OpenAI pricing for the selected model; persisted usage is authoritative for token debit."
    },
    pricingReview: {
      reviewedAt: CAPABILITY_UPDATED_AT,
      expiresAt: CAPABILITY_EXPIRES_AT,
      reviewer: "matematica-maintainers",
      sourceUrls: ["https://openai.com/api/pricing/"]
    },
    retrySemantics: {
      safeToRetryWithSameIdempotencyKey: true,
      retryableFailures: ["rate_limit", "timeout", "server_error", "network_error"],
      notes: "Retry through the CLI external-operation outbox; never duplicate an in-flight idempotency key."
    },
    rateLimits: {
      source: "provider_dashboard",
      policy: "Account/model tier dependent; scheduler must enforce local budget and provider backoff."
    },
    privacy: {
      source: "provider_policy",
      dataRetention: "Provider-account policy dependent; prompts and responses are sent to OpenAI only after explicit BYOK consent.",
      trainingUse: "Provider-account policy dependent; do not rely on provider-side training opt-outs for secrecy.",
      zeroDataRetentionAvailable: "unknown",
      notes: "The CLI stores only local redacted artifacts and treats remote provider egress as explicit."
    },
    legal: {
      source: "provider_terms",
      termsOfService: "Operator must comply with current OpenAI service terms and usage policies.",
      license: "Provider output rights are governed by the operator's OpenAI terms.",
      redistribution: "Do not redistribute provider docs or proprietary model metadata in replay bundles.",
      notes: "This matrix is a freshness gate, not legal advice."
    },
    byokEnvVars: ["OPENAI_API_KEY", "MATEMATICA_OPENAI_MODEL"],
    policyReview: {
      reviewedAt: CAPABILITY_UPDATED_AT,
      expiresAt: CAPABILITY_EXPIRES_AT,
      reviewer: "matematica-maintainers",
      sourceUrls: ["https://ai-sdk.dev/providers/ai-sdk-providers/openai", "https://openai.com/policies/"]
    },
    unsupportedSettings: [],
    updatedAt: CAPABILITY_UPDATED_AT
  },
  anthropic: {
    provider: "anthropic",
    apiPackage: {
      packageName: "@ai-sdk/anthropic",
      adapter: "createAnthropic",
      notes: "Official AI SDK Anthropic adapter; BYOK only."
    },
    supportedModelIds: {
      source: "provider_documentation",
      patterns: ["claude-*"],
      notes: "Model ids are selected by the operator and must be valid for the configured Anthropic workspace."
    },
    tools: "supported",
    streaming: "supported",
    structuredOutput: "supported",
    toolCallBehavior: {
      source: "ai_sdk_adapter",
      parallelToolCalls: "unknown",
      notes: "Tool-use behavior can vary by Claude model; persist every tool call and result locally."
    },
    streamingUsageMetadata: {
      source: "ai_sdk_adapter",
      usageInStream: "supported",
      notes: "Final usage remains mandatory even when streaming chunks are present."
    },
    tokenLimit: {
      source: "provider_documentation",
      notes: "Model-specific context and output limits must be checked against the selected Anthropic model."
    },
    costSource: {
      source: "provider_billing_page",
      notes: "Use current Anthropic pricing for the selected model; persisted usage is authoritative for token debit."
    },
    pricingReview: {
      reviewedAt: CAPABILITY_UPDATED_AT,
      expiresAt: CAPABILITY_EXPIRES_AT,
      reviewer: "matematica-maintainers",
      sourceUrls: ["https://docs.anthropic.com/en/docs/about-claude/pricing"]
    },
    retrySemantics: {
      safeToRetryWithSameIdempotencyKey: true,
      retryableFailures: ["rate_limit", "timeout", "overloaded", "server_error", "network_error"],
      notes: "Retry through the CLI external-operation outbox; preserve request hash and retry lineage."
    },
    rateLimits: {
      source: "provider_dashboard",
      policy: "Workspace/model tier dependent; scheduler must enforce local budget and provider backoff."
    },
    privacy: {
      source: "provider_policy",
      dataRetention: "Provider-workspace policy dependent; prompts and responses are sent to Anthropic only after explicit BYOK consent.",
      trainingUse: "Provider-workspace policy dependent; do not rely on provider-side training opt-outs for secrecy.",
      zeroDataRetentionAvailable: "unknown",
      notes: "The CLI redacts local persistence and treats remote Anthropic egress as explicit."
    },
    legal: {
      source: "provider_terms",
      termsOfService: "Operator must comply with current Anthropic commercial terms and usage policies.",
      license: "Provider output rights are governed by the operator's Anthropic terms.",
      redistribution: "Do not redistribute provider docs or proprietary model metadata in replay bundles.",
      notes: "This matrix is a freshness gate, not legal advice."
    },
    byokEnvVars: ["ANTHROPIC_API_KEY", "MATEMATICA_ANTHROPIC_MODEL"],
    policyReview: {
      reviewedAt: CAPABILITY_UPDATED_AT,
      expiresAt: CAPABILITY_EXPIRES_AT,
      reviewer: "matematica-maintainers",
      sourceUrls: ["https://ai-sdk.dev/providers/ai-sdk-providers/anthropic", "https://www.anthropic.com/legal"]
    },
    unsupportedSettings: [],
    updatedAt: CAPABILITY_UPDATED_AT
  },
  openrouter: {
    provider: "openrouter",
    apiPackage: {
      packageName: "@openrouter/ai-sdk-provider",
      adapter: "createOpenRouter",
      notes: "OpenRouter AI SDK adapter; BYOK gateway over upstream model providers."
    },
    supportedModelIds: {
      source: "gateway_catalog",
      patterns: ["*/*", "openai/*", "anthropic/*", "google/*", "meta-llama/*"],
      notes: "Gateway catalog and upstream provider capabilities can change; actual upstream model provenance is mandatory."
    },
    tools: "unknown",
    streaming: "supported",
    structuredOutput: "unknown",
    toolCallBehavior: {
      source: "unknown",
      parallelToolCalls: "unknown",
      notes: "Tool and structured-output support varies by routed upstream model; require explicit capability checks."
    },
    streamingUsageMetadata: {
      source: "ai_sdk_adapter",
      usageInStream: "unknown",
      notes: "Persist generation/provider metadata when exposed and settle unknown costs at the operator cap."
    },
    tokenLimit: {
      source: "provider_documentation",
      notes: "Capabilities and token limits depend on the routed upstream model."
    },
    costSource: {
      source: "openrouter_generation_metadata",
      notes: "Use OpenRouter generation/provider metadata when exposed; otherwise use current OpenRouter model pricing."
    },
    pricingReview: {
      reviewedAt: CAPABILITY_UPDATED_AT,
      expiresAt: CAPABILITY_EXPIRES_AT,
      reviewer: "matematica-maintainers",
      sourceUrls: ["https://openrouter.ai/pricing"]
    },
    retrySemantics: {
      safeToRetryWithSameIdempotencyKey: true,
      retryableFailures: ["rate_limit", "timeout", "upstream_error", "server_error", "network_error"],
      notes: "Actual upstream may change by route; persist actualUpstreamModel when provider metadata exposes it."
    },
    rateLimits: {
      source: "provider_dashboard",
      policy: "OpenRouter account and upstream-model dependent; use local admission control plus provider backoff."
    },
    privacy: {
      source: "provider_policy",
      dataRetention: "Gateway and upstream-provider policy dependent; prompts may be routed to an upstream provider after explicit BYOK consent.",
      trainingUse: "Gateway and upstream-provider policy dependent; do not use for private prompts unless operator accepts upstream routing risk.",
      zeroDataRetentionAvailable: "unknown",
      notes: "Replay requires actual upstream provenance and no silent substitution."
    },
    legal: {
      source: "provider_terms",
      termsOfService: "Operator must comply with current OpenRouter terms and the routed upstream provider terms.",
      license: "Provider output rights are governed by the operator's OpenRouter and upstream-provider terms.",
      redistribution: "Do not redistribute gateway catalog snapshots beyond metadata needed for replay provenance.",
      notes: "Gateway behavior drift is fail-closed when upstream provenance is missing or substituted."
    },
    byokEnvVars: ["OPENROUTER_API_KEY", "MATEMATICA_OPENROUTER_MODEL"],
    policyReview: {
      reviewedAt: CAPABILITY_UPDATED_AT,
      expiresAt: CAPABILITY_EXPIRES_AT,
      reviewer: "matematica-maintainers",
      sourceUrls: ["https://ai-sdk.dev/providers/community-providers/openrouter", "https://openrouter.ai/terms"]
    },
    unsupportedSettings: ["provider-specific unsupported settings vary by upstream model"],
    updatedAt: CAPABILITY_UPDATED_AT
  },
  cerebras: {
    provider: "cerebras",
    apiPackage: {
      packageName: "@ai-sdk/cerebras",
      adapter: "createCerebras",
      notes: "Official AI SDK Cerebras adapter; BYOK only."
    },
    supportedModelIds: {
      source: "provider_documentation",
      patterns: ["llama-*", "qwen-*", "gpt-oss-*"],
      notes: "Model ids are selected by the operator and must be valid for the configured Cerebras account."
    },
    tools: "unknown",
    streaming: "supported",
    structuredOutput: "unknown",
    toolCallBehavior: {
      source: "unknown",
      parallelToolCalls: "unknown",
      notes: "Tool and structured-output support must be treated as unknown unless a model-specific conformance test proves otherwise."
    },
    streamingUsageMetadata: {
      source: "ai_sdk_adapter",
      usageInStream: "unknown",
      notes: "Fast-worker streaming must still return final usage before budget settlement."
    },
    tokenLimit: {
      source: "provider_documentation",
      notes: "Model-specific limits depend on the selected Cerebras model."
    },
    costSource: {
      source: "provider_billing_page",
      notes: "Use current Cerebras pricing/rate-card for the selected model."
    },
    pricingReview: {
      reviewedAt: CAPABILITY_UPDATED_AT,
      expiresAt: CAPABILITY_EXPIRES_AT,
      reviewer: "matematica-maintainers",
      sourceUrls: ["https://www.cerebras.ai/pricing"]
    },
    retrySemantics: {
      safeToRetryWithSameIdempotencyKey: true,
      retryableFailures: ["rate_limit", "timeout", "server_error", "network_error"],
      notes: "Fast-worker retries must still pass through the CLI outbox and budget reservations."
    },
    rateLimits: {
      source: "provider_dashboard",
      policy: "Account/model tier dependent; use local admission control plus provider backoff."
    },
    privacy: {
      source: "provider_policy",
      dataRetention: "Provider-account policy dependent; prompts and responses are sent to Cerebras only after explicit BYOK consent.",
      trainingUse: "Provider-account policy dependent; do not rely on provider-side training opt-outs for secrecy.",
      zeroDataRetentionAvailable: "unknown",
      notes: "Use Cerebras primarily for bounded fast-worker experiments with local redacted persistence."
    },
    legal: {
      source: "provider_terms",
      termsOfService: "Operator must comply with current Cerebras terms and model usage policies.",
      license: "Provider output rights are governed by the operator's Cerebras terms.",
      redistribution: "Do not redistribute provider docs or proprietary model metadata in replay bundles.",
      notes: "This matrix is a freshness gate, not legal advice."
    },
    byokEnvVars: ["CEREBRAS_API_KEY", "MATEMATICA_CEREBRAS_MODEL"],
    policyReview: {
      reviewedAt: CAPABILITY_UPDATED_AT,
      expiresAt: CAPABILITY_EXPIRES_AT,
      reviewer: "matematica-maintainers",
      sourceUrls: ["https://ai-sdk.dev/providers/ai-sdk-providers/cerebras", "https://www.cerebras.ai/terms-of-use"]
    },
    unsupportedSettings: ["some OpenAI-compatible tool/structured-output settings may be unsupported by model"],
    updatedAt: CAPABILITY_UPDATED_AT
  },
  local: {
    provider: "local",
    apiPackage: {
      packageName: "@ai-sdk/openai-compatible",
      adapter: "createOpenAICompatible",
      notes: "Local OpenAI-compatible adapter; no remote provider API is used by default."
    },
    supportedModelIds: {
      source: "operator_config",
      patterns: ["*"],
      notes: "Operator-defined local runtime model ids."
    },
    tools: "unknown",
    streaming: "unknown",
    structuredOutput: "unknown",
    toolCallBehavior: {
      source: "operator_config",
      parallelToolCalls: "unknown",
      notes: "Local runtime behavior must be proven by local conformance tests before requiring tools."
    },
    streamingUsageMetadata: {
      source: "operator_config",
      usageInStream: "unknown",
      notes: "Local runtime must still produce final usage or the call fails closed."
    },
    tokenLimit: {
      source: "operator_config",
      notes: "Local OpenAI-compatible runtimes must declare or enforce their own model limits."
    },
    costSource: {
      source: "local_operator_config",
      notes: "Local runtime cost is operator-defined; token budget still applies."
    },
    pricingReview: {
      reviewedAt: CAPABILITY_UPDATED_AT,
      expiresAt: CAPABILITY_EXPIRES_AT,
      reviewer: "matematica-maintainers",
      sourceUrls: ["https://ai-sdk.dev/providers/openai-compatible-providers"]
    },
    retrySemantics: {
      safeToRetryWithSameIdempotencyKey: true,
      retryableFailures: ["timeout", "server_error", "network_error"],
      notes: "Retries are safe only through the CLI outbox; local runtime side effects must be avoided."
    },
    rateLimits: {
      source: "local_runtime",
      policy: "Operator-defined local concurrency and memory pressure limits."
    },
    privacy: {
      source: "local_operator_config",
      dataRetention: "Local operator controlled.",
      trainingUse: "Local operator controlled.",
      zeroDataRetentionAvailable: true,
      notes: "No remote provider egress is performed by the CLI for local model calls."
    },
    legal: {
      source: "local_operator_config",
      termsOfService: "Operator is responsible for local model license and runtime terms.",
      license: "Operator-provided model license.",
      redistribution: "Replay bundles must not include local model weights or proprietary runtime assets.",
      notes: "Local runtime policy is outside remote BYOK provider terms."
    },
    byokEnvVars: ["MATEMATICA_LOCAL_BASE_URL", "MATEMATICA_LOCAL_MODEL", "MATEMATICA_LOCAL_API_KEY"],
    policyReview: {
      reviewedAt: CAPABILITY_UPDATED_AT,
      expiresAt: CAPABILITY_EXPIRES_AT,
      reviewer: "matematica-maintainers",
      sourceUrls: ["https://ai-sdk.dev/providers/openai-compatible-providers"]
    },
    unsupportedSettings: ["unknown model-specific settings"],
    updatedAt: CAPABILITY_UPDATED_AT
  }
};

export function providerCapabilityMatrix(
  config: MatematicaConfig,
  options: { modelOverrides?: Partial<Record<ProviderName, string>> } = {}
): ProviderCapabilityRecord[] {
  return config.providers.map((provider) => providerCapabilityFor(provider, {
    requestedModel: options.modelOverrides?.[provider.name]
  }));
}

export function providerCapabilityFor(
  provider: ProviderConfig,
  options: { requestedModel?: string; providerMetadata?: unknown } = {}
): ProviderCapabilityRecord {
  const base = BASE_CAPABILITIES[provider.name];
  const requestedModel = options.requestedModel ?? provider.model;
  return withProviderHashes({
    ...base,
    modelCatalog: selectProviderModelCatalog(provider.name, requestedModel, provider.name === "local"
      ? "operator_config"
      : requestedModel === provider.defaultModel ? "default_config" : "operator_override"),
    apiPackage: { ...base.apiPackage },
    supportedModelIds: {
      ...base.supportedModelIds,
      patterns: [...base.supportedModelIds.patterns]
    },
    toolCallBehavior: { ...base.toolCallBehavior },
    streamingUsageMetadata: { ...base.streamingUsageMetadata },
    tokenLimit: { ...base.tokenLimit },
    costSource: { ...base.costSource },
    pricingReview: {
      ...base.pricingReview,
      sourceUrls: [...base.pricingReview.sourceUrls]
    },
    retrySemantics: {
      ...base.retrySemantics,
      retryableFailures: [...base.retrySemantics.retryableFailures]
    },
    rateLimits: { ...base.rateLimits },
    privacy: { ...base.privacy },
    legal: { ...base.legal },
    byokEnvVars: [...base.byokEnvVars],
    policyReview: {
      ...base.policyReview,
      sourceUrls: [...base.policyReview.sourceUrls]
    },
    unsupportedSettings: [...base.unsupportedSettings],
    configured: provider.configured,
    requestedModel,
    actualUpstreamModel: extractActualUpstreamModel(options.providerMetadata),
    actualUpstreamProvider: extractActualUpstreamProvider(options.providerMetadata)
  });
}

export function providerCapabilityByName(
  provider: ProviderName,
  requestedModel: string,
  providerMetadata?: unknown
): ProviderCapabilityRecord {
  const base = BASE_CAPABILITIES[provider];
  return withProviderHashes({
    ...base,
    modelCatalog: selectProviderModelCatalog(provider, requestedModel, provider === "local" ? "operator_config" : "operator_override"),
    apiPackage: { ...base.apiPackage },
    supportedModelIds: {
      ...base.supportedModelIds,
      patterns: [...base.supportedModelIds.patterns]
    },
    toolCallBehavior: { ...base.toolCallBehavior },
    streamingUsageMetadata: { ...base.streamingUsageMetadata },
    tokenLimit: { ...base.tokenLimit },
    costSource: { ...base.costSource },
    pricingReview: {
      ...base.pricingReview,
      sourceUrls: [...base.pricingReview.sourceUrls]
    },
    retrySemantics: {
      ...base.retrySemantics,
      retryableFailures: [...base.retrySemantics.retryableFailures]
    },
    rateLimits: { ...base.rateLimits },
    privacy: { ...base.privacy },
    legal: { ...base.legal },
    byokEnvVars: [...base.byokEnvVars],
    policyReview: {
      ...base.policyReview,
      sourceUrls: [...base.policyReview.sourceUrls]
    },
    unsupportedSettings: [...base.unsupportedSettings],
    configured: true,
    requestedModel,
    actualUpstreamModel: extractActualUpstreamModel(providerMetadata),
    actualUpstreamProvider: extractActualUpstreamProvider(providerMetadata)
  });
}

export function providerCapabilitySummary(record: ProviderCapabilityRecord): string {
  const actual = record.actualUpstreamModel ? ` actual=${record.actualUpstreamModel}` : "";
  const unsupported = record.unsupportedSettings.length > 0
    ? ` unsupported=${record.unsupportedSettings.join("|")}`
    : "";
  return [
    `capabilities tools=${record.tools}`,
    `streaming=${record.streaming}`,
    `structured=${record.structuredOutput}`,
    `api=${record.apiPackage.packageName}`,
    `cost=${record.costSource.source}`,
    `catalog=${record.modelCatalog.selected.status}`,
    `catalogRefreshed=${record.modelCatalog.refreshedAt}`,
    `context=${record.modelCatalog.selected.contextWindowTokens ?? "unknown"}`,
    `maxOutput=${record.modelCatalog.selected.maxOutputTokens ?? "unknown"}`,
    `privacy=${record.privacy.source}`,
    `legal=${record.legal.source}`,
    `policyReviewed=${record.policyReview.reviewedAt}`,
    `policyExpires=${record.policyReview.expiresAt}`,
    `rateLimits=${record.rateLimits.source}`,
    `updated=${record.updatedAt}${actual}${unsupported}`
  ].join(" ");
}

export function buildProviderLegalPrivacyGateReport(input: {
  providers: ProviderCapabilityRecord[];
  now?: Date;
  expectedPolicyHashes?: Partial<Record<ProviderName, string>>;
  maxAgeDays?: number;
}): ProviderLegalPrivacyGateReport {
  const now = input.now ?? providerPolicyNowFromEnv();
  const checks = input.providers.map((provider) => checkProviderLegalPrivacyGate({
    provider: provider.provider,
    modelId: provider.requestedModel,
    capabilities: provider,
    now,
    expectedPolicyHash: input.expectedPolicyHashes?.[provider.provider],
    maxAgeDays: input.maxAgeDays
  }));
  return {
    format: "matematica.provider-legal-privacy-gate",
    version: 1,
    ok: checks.every((check) => check.ok),
    checkedAt: now.toISOString(),
    maxAgeDays: input.maxAgeDays ?? PROVIDER_POLICY_MAX_AGE_DAYS,
    checks
  };
}

export function checkProviderLegalPrivacyGate(input: {
  provider: ProviderName;
  modelId: string;
  capabilities: ProviderCapabilityRecord;
  now?: Date;
  expectedPolicyHash?: string;
  maxAgeDays?: number;
}): ProviderLegalPrivacyGateCheck {
  const now = input.now ?? providerPolicyNowFromEnv();
  const maxAgeDays = input.maxAgeDays ?? PROVIDER_POLICY_MAX_AGE_DAYS;
  const reviewedAt = input.capabilities.policyReview.reviewedAt;
  const expiresAt = input.capabilities.policyReview.expiresAt;
  const reviewed = new Date(reviewedAt);
  const expires = new Date(expiresAt);
  const policyHash = providerPolicyHash(input.capabilities);
  const issues: string[] = [];
  const reviewAgeDays = Number.isNaN(reviewed.getTime())
    ? undefined
    : Math.floor((now.getTime() - reviewed.getTime()) / (24 * 60 * 60 * 1000));
  const stale = Number.isNaN(reviewed.getTime()) ||
    Number.isNaN(expires.getTime()) ||
    expires.getTime() < now.getTime() ||
    (reviewAgeDays !== undefined && reviewAgeDays > maxAgeDays);

  if (stale) {
    issues.push(`provider legal/privacy review is stale for ${input.provider}; reviewed=${reviewedAt} expires=${expiresAt}`);
  }
  if (input.expectedPolicyHash && input.expectedPolicyHash !== policyHash) {
    issues.push(`provider legal/privacy policy drift for ${input.provider}; pinned=${input.expectedPolicyHash} current=${policyHash}`);
  }
  if (input.capabilities.apiPackage.packageName.length === 0) issues.push("provider API package is missing");
  if (input.capabilities.supportedModelIds.patterns.length === 0) issues.push("supported model id patterns are missing");
  if (input.capabilities.toolCallBehavior.source === "unknown" && input.capabilities.tools === "supported") {
    issues.push("tool calls are marked supported without a known behavior source");
  }
  if (input.capabilities.streamingUsageMetadata.source === "unknown" && input.capabilities.streaming === "supported") {
    issues.push("streaming is marked supported without a known usage metadata source");
  }
  if (input.provider !== "local") {
    if (input.capabilities.privacy.source === "unknown") issues.push("remote provider privacy source is unknown");
    if (input.capabilities.legal.source === "unknown") issues.push("remote provider legal source is unknown");
    if (input.capabilities.byokEnvVars.length === 0) issues.push("remote provider BYOK env vars are missing");
    if (input.capabilities.policyReview.sourceUrls.length === 0) issues.push("remote provider policy source URLs are missing");
  }

  return {
    ok: issues.length === 0,
    provider: input.provider,
    modelId: input.modelId,
    checkedAt: now.toISOString(),
    reviewedAt,
    expiresAt,
    policyHash,
    expectedPolicyHash: input.expectedPolicyHash,
    stale,
    reviewAgeDays,
    issues
  };
}

export function assertProviderLegalPrivacyGate(input: {
  provider: ProviderName;
  modelId: string;
  capabilities: ProviderCapabilityRecord;
  now?: Date;
  expectedPolicyHash?: string;
}): ProviderLegalPrivacyGateCheck {
  const check = checkProviderLegalPrivacyGate(input);
  if (!check.ok) {
    throw new Error(`Provider legal/privacy gate failed for ${input.provider}/${input.modelId}: ${check.issues.join("; ")}.`);
  }
  return check;
}

export function providerPolicyHash(record: ProviderCapabilityRecord): string {
  return stableHash(providerPolicyComparable(record));
}

export function providerRouteHash(record: ProviderCapabilityRecord): string {
  return stableHash(providerRouteComparable(record));
}

export function providerPolicyNowFromEnv(env: NodeJS.ProcessEnv = process.env): Date {
  const value = env.MATEMATICA_PROVIDER_POLICY_NOW;
  if (value) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

export function buildProviderMatrixSnapshot(input: {
  providers: ProviderCapabilityRecord[];
  providerAllowlist?: ProviderName[];
  requiredCapabilities?: ProviderRequiredCapabilities;
  source: string;
  generatedAt?: string;
}): ProviderMatrixSnapshot {
  const providerAllowlist = [...new Set(input.providerAllowlist ?? input.providers
    .filter((provider) => provider.configured)
    .map((provider) => provider.provider))]
    .sort();
  const requiredCapabilities = normalizeRequiredCapabilities(input.requiredCapabilities);
  const providers = input.providers
    .map((provider) => cloneProviderCapabilityRecord(provider))
    .sort((left, right) => `${left.provider}/${left.requestedModel}`.localeCompare(`${right.provider}/${right.requestedModel}`));
  const freshnessSnapshots = buildProviderPolicyFreshnessSnapshots({ providers })
    .sort((left, right) => left.surface.localeCompare(right.surface));
  const comparable = {
    format: "matematica.provider-capability-matrix" as const,
    version: 1 as const,
    routingPolicyVersion: "provider-routing-v1" as const,
    source: input.source,
    providerAllowlist,
    requiredCapabilities,
    fallbackPolicy: {
      automaticProviderFallback: false as const,
      silentModelSubstitution: false as const,
      explicitFallbackRequiresRoutingEvent: true as const
    },
    providers,
    freshnessSnapshots
  };
  return {
    ...comparable,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    matrixHash: stableHash(comparable)
  };
}

export function pinProviderMatrix(input: {
  runId: string;
  ledger: Ledger;
  artifacts: ArtifactStore;
  providers: ProviderCapabilityRecord[];
  providerAllowlist?: ProviderName[];
  requiredCapabilities?: ProviderRequiredCapabilities;
  source: string;
  reason?: string;
}): ProviderMatrixPin {
  const snapshot = buildProviderMatrixSnapshot(input);
  const existing = latestProviderMatrixPin(input.ledger, input.runId);
  if (existing) {
    if (existing.matrixHash !== snapshot.matrixHash) {
      throw new Error(`Provider matrix for run ${input.runId} is already pinned to ${existing.matrixHash}; refusing changed matrix ${snapshot.matrixHash}.`);
    }
    return existing;
  }

  const artifact = input.artifacts.create(input.runId, "provider.matrix", JSON.stringify(snapshot, null, 2));
  const event = input.ledger.appendEvent(input.runId, "provider.matrix.pinned", {
    artifactId: artifact.id,
    matrixHash: snapshot.matrixHash,
    routingPolicyVersion: snapshot.routingPolicyVersion,
    source: snapshot.source,
    reason: input.reason ?? "Provider capability matrix pinned before provider routing.",
    providerAllowlist: snapshot.providerAllowlist,
    requiredCapabilities: snapshot.requiredCapabilities,
    fallbackPolicy: snapshot.fallbackPolicy,
    providers: snapshot.providers,
    freshnessSnapshots: snapshot.freshnessSnapshots,
    providerCount: snapshot.providers.length,
    configuredProviderCount: snapshot.providers.filter((provider) => provider.configured).length
  }, [artifact.id]);

  return {
    artifactId: artifact.id,
    eventId: event.id,
    matrixHash: snapshot.matrixHash,
    snapshot
  };
}

export function ensureProviderRoutePinned(input: {
  runId: string;
  ledger: Ledger;
  artifacts: ArtifactStore;
  provider: ProviderName;
  modelId: string;
  requiredCapabilities?: ProviderRequiredCapabilities;
}): ProviderMatrixPin {
  const existing = latestProviderMatrixPin(input.ledger, input.runId);
  if (!existing) {
    const route = providerCapabilityByName(input.provider, input.modelId);
    assertProviderLegalPrivacyGate({
      provider: input.provider,
      modelId: input.modelId,
      capabilities: route
    });
    const pinned = pinProviderMatrix({
      runId: input.runId,
      ledger: input.ledger,
      artifacts: input.artifacts,
      providers: [route],
      providerAllowlist: [input.provider],
      requiredCapabilities: input.requiredCapabilities,
      source: "implicit-instrumented-provider-call",
      reason: "Instrumented provider call pinned its route before budget reservation and request dispatch."
    });
    assertProviderCapabilityRequirements(route, input.requiredCapabilities);
    return pinned;
  }

  const route = providerRouteFromSnapshot(existing.snapshot, input.provider, input.modelId);
  if (!route) {
    throw new Error(`Provider route ${input.provider}/${input.modelId} is not present in pinned provider matrix ${existing.matrixHash}.`);
  }
  const currentRoute = providerCapabilityByName(input.provider, input.modelId);
  assertProviderLegalPrivacyGate({
    provider: input.provider,
    modelId: input.modelId,
    capabilities: currentRoute,
    expectedPolicyHash: providerPolicyHash(route)
  });
  const pinnedRouteHash = providerRouteHash(route);
  const currentRouteHash = providerRouteHash(currentRoute);
  if (pinnedRouteHash !== currentRouteHash) {
    throw new Error(`Provider route drift for ${input.provider}/${input.modelId}; pinned=${pinnedRouteHash} current=${currentRouteHash}. Explicit audited routing changes are required before model or pricing substitution.`);
  }
  assertProviderCapabilityRequirements(route, input.requiredCapabilities ?? existing.snapshot.requiredCapabilities);
  return existing;
}

export function latestProviderMatrixPin(ledger: Ledger, runId: string): ProviderMatrixPin | undefined {
  const event = ledger.listEvents(runId).findLast((item) => item.type === "provider.matrix.pinned");
  if (!event) return undefined;
  return providerMatrixPinFromEvent(event);
}

export function assertProviderCapabilityRequirements(
  record: ProviderCapabilityRecord,
  requiredCapabilities: ProviderRequiredCapabilities = {}
): void {
  const missing: string[] = [];
  if (requiredCapabilities.tools && record.tools !== "supported") missing.push(`tools=${record.tools}`);
  if (requiredCapabilities.streaming && record.streaming !== "supported") missing.push(`streaming=${record.streaming}`);
  if (requiredCapabilities.structuredOutput && record.structuredOutput !== "supported") {
    missing.push(`structuredOutput=${record.structuredOutput}`);
  }
  if (record.modelCatalog.selected.status === "deprecated" &&
    record.modelCatalog.selected.selectionSource === "default_config") {
    missing.push("defaultModel=deprecated");
  }
  if (record.modelCatalog.selected.status !== "known" &&
    record.modelCatalog.selected.selectionSource === "default_config") {
    missing.push("defaultModel=not_in_catalog");
  }
  if (missing.length > 0) {
    throw new Error(`Required provider capability missing for ${record.provider}/${record.requestedModel}: ${missing.join(", ")}.`);
  }
}

export function assertNoSilentModelSubstitution(input: {
  provider: ProviderName;
  requestedModel: string;
  capabilities: ProviderCapabilityRecord;
}): void {
  if (input.provider !== "openrouter") return;
  const actual = input.capabilities.actualUpstreamModel;
  if (!actual) {
    throw new Error(`OpenRouter response for ${input.requestedModel} did not expose upstream model provenance.`);
  }
  if (actual !== input.requestedModel) {
    throw new Error(`OpenRouter returned upstream model ${actual} for requested model ${input.requestedModel}; silent model substitution is forbidden.`);
  }
  if (!input.capabilities.actualUpstreamProvider) {
    throw new Error(`OpenRouter response for ${input.requestedModel} did not expose upstream provider provenance.`);
  }
}

export function extractActualUpstreamModel(providerMetadata: unknown): string | undefined {
  const metadata = redactJson(providerMetadata);
  return firstStringAt(metadata, [
    ["model"],
    ["modelId"],
    ["actualModel"],
    ["actualUpstreamModel"],
    ["response", "model"],
    ["openrouter", "model"],
    ["openrouter", "provider", "model"],
    ["provider", "model"],
    ["anthropic", "model"],
    ["openai", "model"],
    ["cerebras", "model"]
  ]);
}

export function extractActualUpstreamProvider(providerMetadata: unknown): string | undefined {
  const metadata = redactJson(providerMetadata);
  const direct = firstStringAt(metadata, [
    ["actualUpstreamProvider"],
    ["upstreamProvider"],
    ["providerName"],
    ["openrouter", "provider"],
    ["openrouter", "upstreamProvider"],
    ["openrouter", "provider", "name"],
    ["provider", "name"]
  ]);
  if (direct) return direct;
  const model = extractActualUpstreamModel(providerMetadata);
  return model?.includes("/") ? model.split("/")[0] : undefined;
}

function providerMatrixPinFromEvent(event: LedgerEvent): ProviderMatrixPin {
  const providers = providerRecordsFromValue(event.payload.providers);
  const snapshot: ProviderMatrixSnapshot = {
    format: "matematica.provider-capability-matrix",
    version: 1,
    routingPolicyVersion: "provider-routing-v1",
    generatedAt: stringValue(event.payload.generatedAt) ?? event.createdAt,
    source: stringValue(event.payload.source) ?? "unknown",
    providerAllowlist: providerNameArray(event.payload.providerAllowlist),
    requiredCapabilities: normalizeRequiredCapabilities(event.payload.requiredCapabilities),
    fallbackPolicy: {
      automaticProviderFallback: false,
      silentModelSubstitution: false,
      explicitFallbackRequiresRoutingEvent: true
    },
    providers,
    freshnessSnapshots: freshnessSnapshotsFromValue(event.payload.freshnessSnapshots, providers),
    matrixHash: stringValue(event.payload.matrixHash) ?? ""
  };
  return {
    artifactId: stringValue(event.payload.artifactId) ?? "",
    eventId: event.id,
    matrixHash: snapshot.matrixHash,
    snapshot
  };
}

function providerRouteFromSnapshot(
  snapshot: ProviderMatrixSnapshot,
  provider: ProviderName,
  modelId: string
): ProviderCapabilityRecord | undefined {
  if (snapshot.providerAllowlist.length > 0 && !snapshot.providerAllowlist.includes(provider)) return undefined;
  return snapshot.providers.find((record) => record.provider === provider && record.requestedModel === modelId);
}

function normalizeRequiredCapabilities(value: unknown): ProviderRequiredCapabilities {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    tools: record.tools === true,
    streaming: record.streaming === true,
    structuredOutput: record.structuredOutput === true
  };
}

function cloneProviderCapabilityRecord(record: ProviderCapabilityRecord): ProviderCapabilityRecord {
  const pricingReview = record.pricingReview ?? {
    reviewedAt: record.updatedAt,
    expiresAt: record.policyReview.expiresAt,
    reviewer: "matematica-maintainers" as const,
    sourceUrls: []
  };
  return withProviderHashes({
    ...record,
    modelCatalog: cloneProviderModelCatalog(record.modelCatalog),
    apiPackage: { ...record.apiPackage },
    supportedModelIds: {
      ...record.supportedModelIds,
      patterns: [...record.supportedModelIds.patterns]
    },
    toolCallBehavior: { ...record.toolCallBehavior },
    streamingUsageMetadata: { ...record.streamingUsageMetadata },
    tokenLimit: { ...record.tokenLimit },
    costSource: { ...record.costSource },
    pricingReview: {
      ...pricingReview,
      sourceUrls: [...pricingReview.sourceUrls]
    },
    retrySemantics: {
      ...record.retrySemantics,
      retryableFailures: [...record.retrySemantics.retryableFailures]
    },
    rateLimits: { ...record.rateLimits },
    privacy: { ...record.privacy },
    legal: { ...record.legal },
    byokEnvVars: [...record.byokEnvVars],
    policyReview: {
      ...record.policyReview,
      sourceUrls: [...record.policyReview.sourceUrls]
    },
    unsupportedSettings: [...record.unsupportedSettings]
  });
}

function withProviderHashes(record: ProviderCapabilityRecord): ProviderCapabilityRecord {
  return {
    ...record,
    pricingReview: {
      ...record.pricingReview,
      pricingHash: providerPricingHash(record)
    },
    policyReview: {
      ...record.policyReview,
      policyHash: providerPolicyHash(record)
    }
  };
}

function providerPolicyComparable(record: ProviderCapabilityRecord): Record<string, unknown> {
  return {
    provider: record.provider,
    apiPackage: record.apiPackage,
    supportedModelIds: record.supportedModelIds,
    modelCatalog: providerModelCatalogComparable(record.modelCatalog),
    tools: record.tools,
    streaming: record.streaming,
    structuredOutput: record.structuredOutput,
    toolCallBehavior: record.toolCallBehavior,
    streamingUsageMetadata: record.streamingUsageMetadata,
    tokenLimit: record.tokenLimit,
    costSource: record.costSource,
    rateLimits: record.rateLimits,
    privacy: record.privacy,
    legal: record.legal,
    byokEnvVars: record.byokEnvVars,
    unsupportedSettings: record.unsupportedSettings,
    updatedAt: record.updatedAt,
    policyReview: {
      reviewedAt: record.policyReview.reviewedAt,
      expiresAt: record.policyReview.expiresAt,
      reviewer: record.policyReview.reviewer,
      sourceUrls: record.policyReview.sourceUrls
    }
  };
}

function providerRouteComparable(record: ProviderCapabilityRecord): Record<string, unknown> {
  return {
    provider: record.provider,
    configured: record.configured,
    requestedModel: record.requestedModel,
    actualUpstreamModel: record.actualUpstreamModel,
    actualUpstreamProvider: record.actualUpstreamProvider,
    modelCatalog: providerModelCatalogComparable(record.modelCatalog),
    apiPackage: record.apiPackage,
    supportedModelIds: record.supportedModelIds,
    tools: record.tools,
    streaming: record.streaming,
    structuredOutput: record.structuredOutput,
    toolCallBehavior: record.toolCallBehavior,
    streamingUsageMetadata: record.streamingUsageMetadata,
    tokenLimit: record.tokenLimit,
    costSource: record.costSource,
    pricingReview: {
      reviewedAt: record.pricingReview.reviewedAt,
      expiresAt: record.pricingReview.expiresAt,
      reviewer: record.pricingReview.reviewer,
      sourceUrls: record.pricingReview.sourceUrls,
      pricingHash: providerPricingHash(record)
    },
    retrySemantics: record.retrySemantics,
    rateLimits: record.rateLimits,
    privacy: record.privacy,
    legal: record.legal,
    byokEnvVars: record.byokEnvVars,
    policyReview: {
      reviewedAt: record.policyReview.reviewedAt,
      expiresAt: record.policyReview.expiresAt,
      reviewer: record.policyReview.reviewer,
      sourceUrls: record.policyReview.sourceUrls,
      policyHash: providerPolicyHash(record)
    },
    unsupportedSettings: record.unsupportedSettings,
    updatedAt: record.updatedAt
  };
}

function providerModelCatalogComparable(catalog: ProviderModelCatalog): Record<string, unknown> {
  const { selected, catalogHash: _catalogHash, ...rest } = catalog;
  const { selectionSource: _selectionSource, ...selectedComparable } = selected;
  return {
    ...rest,
    selected: selectedComparable
  };
}

function providerRecordsFromValue(value: unknown): ProviderCapabilityRecord[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((record): record is ProviderCapabilityRecord =>
      Boolean(record) &&
      typeof record === "object" &&
      typeof (record as ProviderCapabilityRecord).provider === "string" &&
      typeof (record as ProviderCapabilityRecord).requestedModel === "string"
    )
    .map((record) => cloneProviderCapabilityRecord(record));
}

function freshnessSnapshotsFromValue(value: unknown, providers: ProviderCapabilityRecord[]): FreshnessSnapshot[] {
  if (Array.isArray(value)) {
    return value
      .filter((snapshot): snapshot is FreshnessSnapshot =>
        Boolean(snapshot) &&
        typeof snapshot === "object" &&
        (snapshot as FreshnessSnapshot).format === "matematica.external-freshness-snapshot" &&
        typeof (snapshot as FreshnessSnapshot).surface === "string" &&
        typeof (snapshot as FreshnessSnapshot).snapshotHash === "string"
      )
      .map((snapshot) => ({
        ...snapshot,
        sourceUrls: [...snapshot.sourceUrls],
        policyImpact: [...snapshot.policyImpact],
        evidence: { ...snapshot.evidence }
      }));
  }
  return buildProviderPolicyFreshnessSnapshots({ providers });
}

function modelEntry(
  modelId: string,
  status: ProviderModelCatalogEntry["status"],
  contextWindowTokens: number | undefined,
  maxOutputTokens: number | undefined,
  toolCalling: ProviderModelCatalogEntry["toolCalling"],
  structuredOutput: ProviderModelCatalogEntry["structuredOutput"],
  streaming: ProviderModelCatalogEntry["streaming"],
  pricingSource: ProviderModelCatalogEntry["pricingSource"],
  providerOptions: string[],
  notes: string
): ProviderModelCatalogEntry {
  return {
    modelId,
    status,
    contextWindowTokens,
    maxOutputTokens,
    toolCalling,
    structuredOutput,
    streaming,
    usageMetadata: streaming === "unsupported" ? "unknown" : "supported",
    pricingSource,
    providerOptions,
    notes
  };
}

function selectProviderModelCatalog(
  provider: ProviderName,
  requestedModel: string,
  selectionSource: ProviderModelCatalogSelectionSource
): ProviderModelCatalog {
  const base = MODEL_CATALOGS[provider];
  const knownModels = base.knownModels.map((entry) => ({ ...entry, providerOptions: [...entry.providerOptions] }));
  const exact = knownModels.find((entry) => entry.modelId === requestedModel);
  const selected = exact ?? modelEntry(
    requestedModel,
    provider === "local" ? "known" : "unknown",
    undefined,
    undefined,
    provider === "local" ? "unknown" : "unknown",
    provider === "local" ? "unknown" : "unknown",
    provider === "local" ? "unknown" : "supported",
    BASE_CAPABILITIES[provider].costSource.source,
    provider === "local" ? ["operator-defined"] : ["operator-override-required"],
    provider === "local"
        ? "Operator-configured local model; limits and feature behavior are enforced by the local runtime."
        : "Model id is not in the refreshed built-in catalog; using it requires explicit operator override and persisted provenance."
  );
  const comparable = {
    format: "matematica.provider-model-catalog" as const,
    version: 1 as const,
    provider,
    source: base.source,
    refreshedAt: MODEL_CATALOG_REFRESHED_AT,
    expiresAt: MODEL_CATALOG_EXPIRES_AT,
    knownModels,
    selected: {
      ...selected,
      selectionSource,
      catalogMatch: exact ? "exact" as const : provider === "local" ? "operator_config" as const : "pattern" as const
    }
  };
  return {
    ...comparable,
    catalogHash: stableHash(comparable)
  };
}

function cloneProviderModelCatalog(catalog: ProviderModelCatalog | undefined): ProviderModelCatalog {
  if (!catalog) {
    return selectProviderModelCatalog("local", "unknown", "operator_config");
  }
  return {
    ...catalog,
    knownModels: catalog.knownModels.map((entry) => ({ ...entry, providerOptions: [...entry.providerOptions] })),
    selected: { ...catalog.selected, providerOptions: [...catalog.selected.providerOptions] }
  };
}

function providerNameArray(value: unknown): ProviderName[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is ProviderName =>
    item === "openai" ||
    item === "anthropic" ||
    item === "openrouter" ||
    item === "cerebras" ||
    item === "local"
  );
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function firstStringAt(value: unknown, paths: string[][]): string | undefined {
  for (const path of paths) {
    const found = valueAtPath(value, path);
    if (typeof found === "string" && found.length > 0) return found;
  }
  return undefined;
}

function valueAtPath(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
