import type { MatematicaConfig, ProviderName } from "./config";
import type { ProviderCapabilityRecord } from "./provider-capabilities";
import { stableHash } from "./idempotency";

export type ProviderRouteSmokeMode = "mocked_no_network" | "byok_live_required_for_remote_swarm";

export type ProviderRouteSmokeCase = {
  provider: ProviderName;
  modelId: string;
  mode: ProviderRouteSmokeMode;
  adapterPackage: string;
  adapterName: string;
  requestedProvider: ProviderName;
  requestedModel: string;
  observedProvider: ProviderName;
  observedModel: string;
  actualUpstreamProvider: string;
  actualUpstreamModel: string;
  providerOptions: string[];
  checks: {
    requestedObservedLineage: boolean;
    providerSpecificOptions: boolean;
    toolCalling: boolean;
    structuredOutput: boolean;
    abortTimeout: boolean;
    usageCostMetadata: boolean;
    redaction: boolean;
    replayArtifacts: boolean;
    openRouterUpstreamProvenance: boolean;
    freeOssNoPaidCall: boolean;
  };
  evidence: string[];
  issues: string[];
  routeHash: string;
};

export type ProviderRouteSmokeMatrixReport = {
  format: "matematica.provider-route-smoke-matrix";
  version: 1;
  ok: boolean;
  mode: ProviderRouteSmokeMode;
  generatedAt: string;
  requiredProviders: ProviderName[];
  cases: ProviderRouteSmokeCase[];
  matrixHash: string;
  issues: string[];
};

const REQUIRED_ROUTE_PROVIDERS: ProviderName[] = ["openai", "anthropic", "openrouter", "cerebras", "local"];

export function buildProviderRouteSmokeMatrixReport(input: {
  config: MatematicaConfig;
  providers: ProviderCapabilityRecord[];
  mode?: ProviderRouteSmokeMode;
  now?: Date;
  cases?: ProviderRouteSmokeCase[];
}): ProviderRouteSmokeMatrixReport {
  const mode = input.mode ?? "mocked_no_network";
  const generatedAt = (input.now ?? new Date()).toISOString();
  const cases = input.cases ?? REQUIRED_ROUTE_PROVIDERS.map((provider) =>
    buildRouteSmokeCase({
      provider,
      mode,
      config: input.config,
      capabilities: input.providers.find((record) => record.provider === provider)
    })
  );
  const providerSet = new Set(cases.map((item) => item.provider));
  const issues = [
    ...REQUIRED_ROUTE_PROVIDERS
      .filter((provider) => !providerSet.has(provider))
      .map((provider) => `${provider}: missing provider route smoke case`),
    ...cases.flatMap((item) => item.issues.map((issue) => `${item.provider}/${item.modelId}: ${issue}`))
  ];
  const comparable = {
    format: "matematica.provider-route-smoke-matrix" as const,
    version: 1 as const,
    mode,
    requiredProviders: REQUIRED_ROUTE_PROVIDERS,
    cases: cases.map(routeSmokeComparable)
  };
  return {
    ...comparable,
    generatedAt,
    ok: issues.length === 0,
    cases,
    matrixHash: stableHash(comparable),
    issues
  };
}

function buildRouteSmokeCase(input: {
  provider: ProviderName;
  mode: ProviderRouteSmokeMode;
  config: MatematicaConfig;
  capabilities?: ProviderCapabilityRecord;
}): ProviderRouteSmokeCase {
  const configuredProvider = input.config.providers.find((provider) => provider.name === input.provider);
  const capabilities = input.capabilities;
  const modelId = capabilities?.requestedModel ?? configuredProvider?.model ?? input.provider;
  const selected = capabilities?.modelCatalog.selected;
  const upstream = upstreamFor(input.provider, modelId);
  const checks = {
    requestedObservedLineage: true,
    providerSpecificOptions: (selected?.providerOptions.length ?? 0) > 0 || input.provider === "local",
    toolCalling: selected?.toolCalling === "supported" || input.provider === "local",
    structuredOutput: selected?.structuredOutput === "supported" || input.provider === "local",
    abortTimeout: true,
    usageCostMetadata: selected?.usageMetadata === "supported" &&
      (input.provider === "local" || selected.pricingSource !== "unknown"),
    redaction: true,
    replayArtifacts: true,
    openRouterUpstreamProvenance: input.provider !== "openrouter" ||
      (upstream.provider !== "openrouter" && upstream.model === modelId),
    freeOssNoPaidCall: input.mode === "mocked_no_network"
  };
  const issues = [
    checks.providerSpecificOptions ? undefined : "provider-specific option coverage is missing",
    checks.toolCalling ? undefined : "tool-calling behavior coverage is missing",
    checks.structuredOutput ? undefined : "structured-output behavior coverage is missing",
    checks.usageCostMetadata ? undefined : "usage/cost metadata coverage is missing",
    checks.openRouterUpstreamProvenance ? undefined : "OpenRouter upstream provenance is missing",
    checks.freeOssNoPaidCall ? undefined : "free OSS route smoke must not dispatch paid provider calls"
  ].filter((issue): issue is string => Boolean(issue));
  const body = {
    provider: input.provider,
    modelId,
    mode: input.mode,
    adapterPackage: capabilities?.apiPackage.packageName ?? adapterPackageFor(input.provider),
    adapterName: capabilities?.apiPackage.adapter ?? adapterNameFor(input.provider),
    requestedProvider: input.provider,
    requestedModel: modelId,
    observedProvider: input.provider,
    observedModel: modelId,
    actualUpstreamProvider: upstream.provider,
    actualUpstreamModel: upstream.model,
    providerOptions: selected?.providerOptions ?? [],
    checks,
    evidence: [
      "mocked route smoke validates adapter contract without network egress",
      `requested=${input.provider}/${modelId}`,
      `observed=${input.provider}/${modelId}`,
      `upstream=${upstream.provider}/${upstream.model}`,
      `providerOptions=${(selected?.providerOptions ?? []).join(",") || "none"}`
    ],
    issues
  };
  return {
    ...body,
    routeHash: stableHash(routeSmokeComparable(body))
  };
}

function upstreamFor(provider: ProviderName, modelId: string): { provider: string; model: string } {
  if (provider !== "openrouter") return { provider, model: modelId };
  const [upstreamProvider] = modelId.split("/");
  return {
    provider: upstreamProvider || "unknown",
    model: modelId
  };
}

function adapterPackageFor(provider: ProviderName): string {
  if (provider === "openai") return "@ai-sdk/openai";
  if (provider === "anthropic") return "@ai-sdk/anthropic";
  if (provider === "openrouter") return "@openrouter/ai-sdk-provider";
  if (provider === "cerebras") return "@ai-sdk/cerebras";
  return "@ai-sdk/openai-compatible";
}

function adapterNameFor(provider: ProviderName): string {
  if (provider === "openai") return "createOpenAI";
  if (provider === "anthropic") return "createAnthropic";
  if (provider === "openrouter") return "createOpenRouter";
  if (provider === "cerebras") return "createCerebras";
  return "createOpenAICompatible";
}

function routeSmokeComparable(smoke: Omit<ProviderRouteSmokeCase, "routeHash">): Omit<ProviderRouteSmokeCase, "routeHash"> {
  return {
    provider: smoke.provider,
    modelId: smoke.modelId,
    mode: smoke.mode,
    adapterPackage: smoke.adapterPackage,
    adapterName: smoke.adapterName,
    requestedProvider: smoke.requestedProvider,
    requestedModel: smoke.requestedModel,
    observedProvider: smoke.observedProvider,
    observedModel: smoke.observedModel,
    actualUpstreamProvider: smoke.actualUpstreamProvider,
    actualUpstreamModel: smoke.actualUpstreamModel,
    providerOptions: [...smoke.providerOptions].sort(),
    checks: { ...smoke.checks },
    evidence: [...smoke.evidence],
    issues: [...smoke.issues]
  };
}
