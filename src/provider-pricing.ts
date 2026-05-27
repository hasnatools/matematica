import type { BudgetUsage } from "./budget";
import type { ProviderName } from "./config";
import type { ProviderCapabilityRecord } from "./provider-capabilities";
import { stableHash } from "./idempotency";
import { isRemoteProvider } from "./privacy";

export type ProviderPricingMetadataGateCheck = {
  ok: boolean;
  provider: ProviderName;
  modelId: string;
  checkedAt: string;
  reviewedAt: string;
  expiresAt: string;
  pricingHash: string;
  expectedPricingHash?: string;
  pricingStale: boolean;
  modelCatalogHash: string;
  modelCatalogRefreshedAt: string;
  modelCatalogExpiresAt: string;
  modelCatalogStale: boolean;
  modelCatalogAgeDays?: number;
  reviewAgeDays?: number;
  costSource: ProviderCapabilityRecord["costSource"];
  issues: string[];
};

export type ProviderPricingMetadataGateReport = {
  format: "matematica.provider-pricing-metadata-gate";
  version: 1;
  ok: boolean;
  checkedAt: string;
  maxAgeDays: number;
  checks: ProviderPricingMetadataGateCheck[];
};

export type ProviderPricingCheck = {
  ok: boolean;
  issueCode?: string;
  provider: ProviderName;
  modelId: string;
  remote: boolean;
  costSource: ProviderCapabilityRecord["costSource"];
  pricingHash: string;
  expectedPricingHash?: string;
  pricingUpdatedAt: string;
  pricingExpiresAt: string;
  pricingStale: boolean;
  modelCatalogHash: string;
  modelCatalogRefreshedAt: string;
  modelCatalogExpiresAt: string;
  modelCatalogStale: boolean;
  explicitOperatorCapUsd?: number;
  settlementPolicy: "not_required" | "actual_provider_cost_or_operator_cap";
  reason?: string;
};

const PRICING_MAX_AGE_DAYS = 90;

export function checkProviderPricing(input: {
  provider: ProviderName;
  modelId: string;
  capabilities: ProviderCapabilityRecord;
  maxUsd?: number;
  expectedPricingHash?: string;
  now?: Date;
}): ProviderPricingCheck {
  const remote = isRemoteProvider(input.provider);
  const explicitOperatorCapUsd = normalizeUsd(input.maxUsd);
  const pricingMetadata = checkProviderPricingMetadata({
    provider: input.provider,
    modelId: input.modelId,
    capabilities: input.capabilities,
    expectedPricingHash: input.expectedPricingHash,
    now: input.now
  });
  const base: ProviderPricingCheck = {
    ok: pricingMetadata.ok,
    provider: input.provider,
    modelId: input.modelId,
    remote,
    costSource: input.capabilities.costSource,
    pricingHash: pricingMetadata.pricingHash,
    expectedPricingHash: input.expectedPricingHash,
    pricingUpdatedAt: pricingMetadata.reviewedAt,
    pricingExpiresAt: pricingMetadata.expiresAt,
    pricingStale: pricingMetadata.pricingStale,
    modelCatalogHash: pricingMetadata.modelCatalogHash,
    modelCatalogRefreshedAt: pricingMetadata.modelCatalogRefreshedAt,
    modelCatalogExpiresAt: pricingMetadata.modelCatalogExpiresAt,
    modelCatalogStale: pricingMetadata.modelCatalogStale,
    explicitOperatorCapUsd,
    settlementPolicy: remote ? "actual_provider_cost_or_operator_cap" : "not_required"
  };

  if (!pricingMetadata.ok) {
    return {
      ...base,
      ok: false,
      issueCode: pricingMetadata.issues.some((issue) => issue.includes("drift"))
        ? "provider_pricing_metadata_drift"
        : "provider_pricing_metadata_invalid",
      reason: pricingMetadata.issues.join("; ")
    };
  }

  if (!remote) return base;

  if (input.capabilities.costSource.source === "unknown" && explicitOperatorCapUsd === undefined) {
    return {
      ...base,
      ok: false,
      issueCode: "provider_pricing_unknown_without_operator_cap",
      reason: "Remote provider pricing source is unknown and no explicit pessimistic per-call USD cap was recorded."
    };
  }

  if (pricingMetadata.pricingStale && explicitOperatorCapUsd === undefined) {
    return {
      ...base,
      ok: false,
      issueCode: "provider_pricing_stale_without_operator_cap",
      reason: "Remote provider pricing metadata is stale and no explicit pessimistic per-call USD cap was recorded."
    };
  }

  if (explicitOperatorCapUsd === undefined) {
    return {
      ...base,
      ok: false,
      issueCode: "provider_pricing_missing_operator_cap",
      reason: "Remote provider calls require settings.maxUsd as an explicit pessimistic per-call USD cap before provider egress."
    };
  }

  return base;
}

export function buildProviderPricingMetadataGateReport(input: {
  providers: ProviderCapabilityRecord[];
  now?: Date;
  expectedPricingHashes?: Partial<Record<ProviderName, string>>;
  maxAgeDays?: number;
}): ProviderPricingMetadataGateReport {
  const now = input.now ?? providerPricingNowFromEnv();
  const maxAgeDays = input.maxAgeDays ?? PRICING_MAX_AGE_DAYS;
  const checks = input.providers.map((provider) => checkProviderPricingMetadata({
    provider: provider.provider,
    modelId: provider.requestedModel,
    capabilities: provider,
    now,
    expectedPricingHash: input.expectedPricingHashes?.[provider.provider],
    maxAgeDays
  }));
  return {
    format: "matematica.provider-pricing-metadata-gate",
    version: 1,
    ok: checks.every((check) => check.ok),
    checkedAt: now.toISOString(),
    maxAgeDays,
    checks
  };
}

export function checkProviderPricingMetadata(input: {
  provider: ProviderName;
  modelId: string;
  capabilities: ProviderCapabilityRecord;
  now?: Date;
  expectedPricingHash?: string;
  maxAgeDays?: number;
}): ProviderPricingMetadataGateCheck {
  const now = input.now ?? providerPricingNowFromEnv();
  const maxAgeDays = input.maxAgeDays ?? PRICING_MAX_AGE_DAYS;
  const reviewedAt = input.capabilities.pricingReview.reviewedAt;
  const expiresAt = input.capabilities.pricingReview.expiresAt;
  const reviewed = new Date(reviewedAt);
  const expires = new Date(expiresAt);
  const pricingHash = providerPricingHash(input.capabilities);
  const reviewAgeDays = Number.isNaN(reviewed.getTime())
    ? undefined
    : Math.floor((now.getTime() - reviewed.getTime()) / (24 * 60 * 60 * 1000));
  const pricingStale = Number.isNaN(reviewed.getTime()) ||
    Number.isNaN(expires.getTime()) ||
    expires.getTime() < now.getTime() ||
    (reviewAgeDays !== undefined && reviewAgeDays > maxAgeDays);
  const catalog = input.capabilities.modelCatalog;
  const catalogReviewed = new Date(catalog.refreshedAt);
  const catalogExpires = new Date(catalog.expiresAt);
  const modelCatalogAgeDays = Number.isNaN(catalogReviewed.getTime())
    ? undefined
    : Math.floor((now.getTime() - catalogReviewed.getTime()) / (24 * 60 * 60 * 1000));
  const modelCatalogStale = Number.isNaN(catalogReviewed.getTime()) ||
    Number.isNaN(catalogExpires.getTime()) ||
    catalogExpires.getTime() < now.getTime() ||
    (modelCatalogAgeDays !== undefined && modelCatalogAgeDays > maxAgeDays);
  const issues: string[] = [];

  if (pricingStale) {
    issues.push(`provider pricing metadata is stale for ${input.provider}; reviewed=${reviewedAt} expires=${expiresAt}`);
  }
  if (input.expectedPricingHash && input.expectedPricingHash !== pricingHash) {
    issues.push(`provider pricing metadata drift for ${input.provider}; pinned=${input.expectedPricingHash} current=${pricingHash}`);
  }
  if (input.capabilities.costSource.source === "unknown") issues.push("provider pricing source is unknown");
  if (input.capabilities.pricingReview.sourceUrls.length === 0) issues.push("provider pricing source URLs are missing");
  if (input.capabilities.supportedModelIds.source === "unknown") issues.push("provider model availability source is unknown");
  if (input.capabilities.supportedModelIds.patterns.length === 0) issues.push("provider model availability patterns are missing");
  if (modelCatalogStale) {
    issues.push(`provider model catalog is stale for ${input.provider}; refreshed=${catalog.refreshedAt} expires=${catalog.expiresAt}`);
  }
  if (catalog.selected.status === "unknown" && catalog.selected.selectionSource === "default_config") {
    issues.push(`default model ${input.provider}/${input.modelId} is not present in the refreshed provider model catalog`);
  }
  if (catalog.selected.status === "deprecated" && catalog.selected.selectionSource === "default_config") {
    issues.push(`default model ${input.provider}/${input.modelId} is deprecated in the refreshed provider model catalog`);
  }
  const selectedCatalogMustHaveProviderMetadata = input.provider !== "local" &&
    (catalog.selected.status === "known" || catalog.selected.selectionSource === "default_config");
  if (selectedCatalogMustHaveProviderMetadata && catalog.selected.contextWindowTokens === undefined) {
    issues.push(`provider model ${input.provider}/${input.modelId} is missing context window metadata`);
  }
  if (selectedCatalogMustHaveProviderMetadata && catalog.selected.maxOutputTokens === undefined) {
    issues.push(`provider model ${input.provider}/${input.modelId} is missing max output token metadata`);
  }
  if (selectedCatalogMustHaveProviderMetadata && catalog.selected.pricingSource === "unknown") {
    issues.push(`provider model ${input.provider}/${input.modelId} is missing pricing source metadata`);
  }

  return {
    ok: issues.length === 0,
    provider: input.provider,
    modelId: input.modelId,
    checkedAt: now.toISOString(),
    reviewedAt,
    expiresAt,
    pricingHash,
    expectedPricingHash: input.expectedPricingHash,
    pricingStale,
    modelCatalogHash: catalog.catalogHash,
    modelCatalogRefreshedAt: catalog.refreshedAt,
    modelCatalogExpiresAt: catalog.expiresAt,
    modelCatalogStale,
    modelCatalogAgeDays,
    reviewAgeDays,
    costSource: input.capabilities.costSource,
    issues
  };
}

export function providerPricingHash(record: ProviderCapabilityRecord): string {
  return stableHash({
    provider: record.provider,
    requestedModel: record.requestedModel,
    supportedModelIds: record.supportedModelIds,
    modelCatalog: providerModelCatalogComparable(record.modelCatalog),
    costSource: record.costSource,
    pricingReview: {
      reviewedAt: record.pricingReview.reviewedAt,
      expiresAt: record.pricingReview.expiresAt,
      reviewer: record.pricingReview.reviewer,
      sourceUrls: record.pricingReview.sourceUrls
    },
    updatedAt: record.updatedAt
  });
}

function providerModelCatalogComparable(catalog: ProviderCapabilityRecord["modelCatalog"]): Record<string, unknown> {
  const { selected, catalogHash: _catalogHash, ...rest } = catalog;
  const { selectionSource: _selectionSource, ...selectedComparable } = selected;
  return {
    ...rest,
    selected: selectedComparable
  };
}

export function providerPricingNowFromEnv(env: NodeJS.ProcessEnv = process.env): Date {
  const value = env.MATEMATICA_PROVIDER_PRICING_NOW ?? env.MATEMATICA_PROVIDER_POLICY_NOW;
  if (value) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

export function settleUsdUsage(input: {
  actualUsd?: number;
  pricing: ProviderPricingCheck;
  reserve: BudgetUsage;
  pricingDrifted?: boolean;
}): { usd: number; source: "provider_metadata" | "operator_cap" | "pricing_drift_floor" | "not_required" } {
  if (input.actualUsd !== undefined) {
    if (
      input.pricingDrifted === true &&
      input.pricing.settlementPolicy === "actual_provider_cost_or_operator_cap" &&
      input.reserve.usd > input.actualUsd
    ) {
      return { usd: input.reserve.usd, source: "pricing_drift_floor" };
    }
    return { usd: input.actualUsd, source: "provider_metadata" };
  }
  if (input.pricing.settlementPolicy === "actual_provider_cost_or_operator_cap") {
    return { usd: input.reserve.usd, source: "operator_cap" };
  }
  return { usd: 0, source: "not_required" };
}

function normalizeUsd(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  return Number.isFinite(value) && value > 0 ? value : undefined;
}
