import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { stableHash } from "./idempotency";
import { arxivCompliancePolicy } from "./research/arxiv";
import type { AiSdkPackageInfo } from "./ai-sdk-compat";
import type { ProviderCapabilityRecord } from "./provider-capabilities";

export type FreshnessSurface =
  | "arxiv-api"
  | "ai-sdk-core"
  | "ai-sdk-openai"
  | "ai-sdk-anthropic"
  | "ai-sdk-cerebras"
  | "ai-sdk-openai-compatible"
  | "openrouter-ai-sdk-provider"
  | "openai-provider-policy"
  | "anthropic-provider-policy"
  | "openrouter-provider-policy"
  | "cerebras-provider-policy"
  | "local-provider-policy";

export type FreshnessSnapshot = {
  format: "matematica.external-freshness-snapshot";
  version: 1;
  surface: FreshnessSurface;
  sourceUrls: string[];
  retrievedAt: string;
  expiresAt: string;
  schemaVersion: string;
  maxAgeDays: number;
  policyImpact: string[];
  replayFallback: string;
  evidence: Record<string, unknown>;
  snapshotHash: string;
};

export type FreshnessGateCheck = {
  ok: boolean;
  surface: FreshnessSurface;
  sourceUrls: string[];
  retrievedAt: string;
  expiresAt: string;
  schemaVersion: string;
  expectedSchemaVersion?: string;
  snapshotHash: string;
  stale: boolean;
  ageDays?: number;
  issues: string[];
};

export type FreshnessGateReport = {
  format: "matematica.external-freshness-gate";
  version: 1;
  ok: boolean;
  checkedAt: string;
  maxAgeDays: number;
  checks: FreshnessGateCheck[];
};

export const EXTERNAL_FRESHNESS_SCHEMA_VERSION = "external-freshness-v1";
export const EXTERNAL_FRESHNESS_RETRIEVED_AT = "2026-05-25T00:00:00.000Z";
export const EXTERNAL_FRESHNESS_MAX_AGE_DAYS = 90;

const requireFromHere = createRequire(import.meta.url);

const AI_SDK_SOURCES: Record<Extract<FreshnessSurface,
  | "ai-sdk-core"
  | "ai-sdk-openai"
  | "ai-sdk-anthropic"
  | "ai-sdk-cerebras"
  | "ai-sdk-openai-compatible"
  | "openrouter-ai-sdk-provider">, { packageName: string; sourceUrls: string[] }> = {
  "ai-sdk-core": {
    packageName: "ai",
    sourceUrls: ["https://ai-sdk.dev/docs/introduction", "https://ai-sdk.dev/docs/ai-sdk-core"]
  },
  "ai-sdk-openai": {
    packageName: "@ai-sdk/openai",
    sourceUrls: ["https://ai-sdk.dev/providers/ai-sdk-providers/openai"]
  },
  "ai-sdk-anthropic": {
    packageName: "@ai-sdk/anthropic",
    sourceUrls: ["https://ai-sdk.dev/providers/ai-sdk-providers/anthropic"]
  },
  "ai-sdk-cerebras": {
    packageName: "@ai-sdk/cerebras",
    sourceUrls: ["https://ai-sdk.dev/providers/ai-sdk-providers/cerebras"]
  },
  "ai-sdk-openai-compatible": {
    packageName: "@ai-sdk/openai-compatible",
    sourceUrls: ["https://ai-sdk.dev/providers/openai-compatible-providers"]
  },
  "openrouter-ai-sdk-provider": {
    packageName: "@openrouter/ai-sdk-provider",
    sourceUrls: ["https://ai-sdk.dev/providers/community-providers/openrouter"]
  }
};

const PROVIDER_POLICY_SURFACES: Record<string, FreshnessSurface> = {
  openai: "openai-provider-policy",
  anthropic: "anthropic-provider-policy",
  openrouter: "openrouter-provider-policy",
  cerebras: "cerebras-provider-policy",
  local: "local-provider-policy"
};

export function buildDefaultExternalFreshnessSnapshots(input: {
  providers?: ProviderCapabilityRecord[];
  aiSdkPackages?: AiSdkPackageInfo[];
  retrievedAt?: string;
  maxAgeDays?: number;
} = {}): FreshnessSnapshot[] {
  return [
    buildArxivFreshnessSnapshot({
      retrievedAt: input.retrievedAt,
      maxAgeDays: input.maxAgeDays
    }),
    ...buildAiSdkFreshnessSnapshots({
      packages: input.aiSdkPackages,
      retrievedAt: input.retrievedAt,
      maxAgeDays: input.maxAgeDays
    }),
    ...buildProviderPolicyFreshnessSnapshots({
      providers: input.providers ?? [],
      retrievedAt: input.retrievedAt,
      maxAgeDays: input.maxAgeDays
    })
  ].sort((left, right) => left.surface.localeCompare(right.surface));
}

export function buildArxivFreshnessSnapshot(input: {
  retrievedAt?: string;
  maxAgeDays?: number;
} = {}): FreshnessSnapshot {
  const policy = arxivCompliancePolicy();
  return createFreshnessSnapshot({
    surface: "arxiv-api",
    sourceUrls: [policy.termsUrl],
    retrievedAt: input.retrievedAt,
    maxAgeDays: input.maxAgeDays,
    policyImpact: [
      "feedback and gather phases may use latest arXiv metadata only through the polite cache",
      "replay bundles may include metadata but not PDFs or source archives without a license manifest"
    ],
    replayFallback: "Use the saved arXiv response artifact and citation snapshot; do not re-query arXiv during offline replay.",
    evidence: {
      source: policy.source,
      maxConnections: policy.maxConnections,
      minIntervalMs: policy.minIntervalMs,
      userAgent: policy.userAgent,
      metadataRedistribution: policy.metadataRedistribution,
      pdfAndSourceRedistribution: policy.pdfAndSourceRedistribution
    }
  });
}

export function buildAiSdkFreshnessSnapshots(input: {
  packages?: AiSdkPackageInfo[];
  retrievedAt?: string;
  maxAgeDays?: number;
} = {}): FreshnessSnapshot[] {
  const packageByName = new Map((input.packages ?? readAiSdkPackageInfos()).map((pkg) => [pkg.name, pkg]));
  return (Object.entries(AI_SDK_SOURCES) as Array<[keyof typeof AI_SDK_SOURCES, typeof AI_SDK_SOURCES[keyof typeof AI_SDK_SOURCES]]>)
    .map(([surface, source]) => {
      const pkg = packageByName.get(source.packageName);
      return createFreshnessSnapshot({
        surface,
        sourceUrls: source.sourceUrls,
        retrievedAt: input.retrievedAt,
        maxAgeDays: input.maxAgeDays,
        policyImpact: [
          "AI SDK provider/tool-loop compatibility controls swarm worker adapter behavior",
          "package and docs drift must fail release gates before live model routing is claimed"
        ],
        replayFallback: "Use pinned package versions and recorded tool-loop transcripts; do not infer current AI SDK behavior during replay.",
        evidence: {
          packageName: source.packageName,
          installedVersion: pkg?.version ?? "missing",
          peerDependencies: pkg?.peerDependencies ?? {},
          sourceKind: source.packageName === "@openrouter/ai-sdk-provider" ? "community-provider" : "official-ai-sdk-provider"
        }
      });
    });
}

export function buildProviderPolicyFreshnessSnapshots(input: {
  providers: ProviderCapabilityRecord[];
  retrievedAt?: string;
  maxAgeDays?: number;
}): FreshnessSnapshot[] {
  return input.providers.map((provider) => createFreshnessSnapshot({
    surface: PROVIDER_POLICY_SURFACES[provider.provider] ?? "local-provider-policy",
    sourceUrls: provider.policyReview.sourceUrls,
    retrievedAt: input.retrievedAt ?? dateToIsoStart(provider.policyReview.reviewedAt),
    expiresAt: dateToIsoStart(provider.policyReview.expiresAt),
    maxAgeDays: input.maxAgeDays,
    policyImpact: [
      "remote provider admission depends on legal/privacy freshness",
      "routing must use pinned package, policy, model, privacy, and cost provenance"
    ],
    replayFallback: "Use the pinned provider matrix and provider policy hash; block live routing if the current policy hash drifts.",
    evidence: {
      provider: provider.provider,
      packageName: provider.apiPackage.packageName,
      requestedModel: provider.requestedModel,
      policyHash: provider.policyReview.policyHash,
      privacySource: provider.privacy.source,
      legalSource: provider.legal.source,
      modelIdSource: provider.supportedModelIds.source
    }
  }));
}

export function buildExternalFreshnessGateReport(input: {
  snapshots: FreshnessSnapshot[];
  now?: Date;
  maxAgeDays?: number;
  expectedSchemaVersions?: Partial<Record<FreshnessSurface, string>>;
}): FreshnessGateReport {
  const now = input.now ?? freshnessNowFromEnv();
  const maxAgeDays = input.maxAgeDays ?? EXTERNAL_FRESHNESS_MAX_AGE_DAYS;
  const checks = input.snapshots.map((snapshot) => checkFreshnessSnapshot({
    snapshot,
    now,
    maxAgeDays,
    expectedSchemaVersion: input.expectedSchemaVersions?.[snapshot.surface]
  }));
  return {
    format: "matematica.external-freshness-gate",
    version: 1,
    ok: checks.every((check) => check.ok),
    checkedAt: now.toISOString(),
    maxAgeDays,
    checks
  };
}

export function checkFreshnessSnapshot(input: {
  snapshot: FreshnessSnapshot;
  now?: Date;
  maxAgeDays?: number;
  expectedSchemaVersion?: string;
}): FreshnessGateCheck {
  const now = input.now ?? freshnessNowFromEnv();
  const maxAgeDays = input.maxAgeDays ?? input.snapshot.maxAgeDays;
  const retrieved = new Date(input.snapshot.retrievedAt);
  const expires = new Date(input.snapshot.expiresAt);
  const issues: string[] = [];
  const ageDays = Number.isNaN(retrieved.getTime())
    ? undefined
    : Math.floor((now.getTime() - retrieved.getTime()) / (24 * 60 * 60 * 1000));
  const stale = Number.isNaN(retrieved.getTime()) ||
    Number.isNaN(expires.getTime()) ||
    expires.getTime() < now.getTime() ||
    (ageDays !== undefined && ageDays > maxAgeDays);
  if (stale) {
    issues.push(`freshness snapshot is stale for ${input.snapshot.surface}; retrieved=${input.snapshot.retrievedAt} expires=${input.snapshot.expiresAt}`);
  }
  if (input.expectedSchemaVersion && input.expectedSchemaVersion !== input.snapshot.schemaVersion) {
    issues.push(`freshness schema drift for ${input.snapshot.surface}; expected=${input.expectedSchemaVersion} actual=${input.snapshot.schemaVersion}`);
  }
  if (input.snapshot.sourceUrls.length === 0) issues.push("freshness snapshot has no source URL");
  if (!input.snapshot.snapshotHash) issues.push("freshness snapshot hash is missing");
  return {
    ok: issues.length === 0,
    surface: input.snapshot.surface,
    sourceUrls: input.snapshot.sourceUrls,
    retrievedAt: input.snapshot.retrievedAt,
    expiresAt: input.snapshot.expiresAt,
    schemaVersion: input.snapshot.schemaVersion,
    expectedSchemaVersion: input.expectedSchemaVersion,
    snapshotHash: input.snapshot.snapshotHash,
    stale,
    ageDays,
    issues
  };
}

export function assertExternalFreshnessGate(input: Parameters<typeof buildExternalFreshnessGateReport>[0]): FreshnessGateReport {
  const report = buildExternalFreshnessGateReport(input);
  if (!report.ok) {
    throw new Error(`External freshness gate failed: ${report.checks.flatMap((check) => check.issues).join("; ")}.`);
  }
  return report;
}

export function freshnessNowFromEnv(env: NodeJS.ProcessEnv = process.env): Date {
  const value = env.MATEMATICA_EXTERNAL_FRESHNESS_NOW;
  if (value) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

function createFreshnessSnapshot(input: {
  surface: FreshnessSurface;
  sourceUrls: string[];
  retrievedAt?: string;
  expiresAt?: string;
  maxAgeDays?: number;
  policyImpact: string[];
  replayFallback: string;
  evidence: Record<string, unknown>;
}): FreshnessSnapshot {
  const retrievedAt = input.retrievedAt ?? EXTERNAL_FRESHNESS_RETRIEVED_AT;
  const maxAgeDays = input.maxAgeDays ?? EXTERNAL_FRESHNESS_MAX_AGE_DAYS;
  const comparable = {
    format: "matematica.external-freshness-snapshot" as const,
    version: 1 as const,
    surface: input.surface,
    sourceUrls: [...input.sourceUrls].sort(),
    retrievedAt,
    expiresAt: input.expiresAt ?? addDays(retrievedAt, maxAgeDays),
    schemaVersion: EXTERNAL_FRESHNESS_SCHEMA_VERSION,
    maxAgeDays,
    policyImpact: [...input.policyImpact],
    replayFallback: input.replayFallback,
    evidence: input.evidence
  };
  return {
    ...comparable,
    snapshotHash: stableHash(comparable)
  };
}

function addDays(iso: string, days: number): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function dateToIsoStart(date: string): string {
  return date.includes("T") ? new Date(date).toISOString() : `${date}T00:00:00.000Z`;
}

function readAiSdkPackageInfos(): AiSdkPackageInfo[] {
  return Object.values(AI_SDK_SOURCES).map((source) => {
    try {
      const path = requireFromHere.resolve(`${source.packageName}/package.json`);
      const parsed = JSON.parse(readFileSync(path, "utf8")) as {
        name?: unknown;
        version?: unknown;
        peerDependencies?: unknown;
      };
      return {
        name: typeof parsed.name === "string" ? parsed.name : source.packageName,
        version: typeof parsed.version === "string" ? parsed.version : "0.0.0",
        peerDependencies: isRecord(parsed.peerDependencies)
          ? Object.fromEntries(Object.entries(parsed.peerDependencies).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
          : {}
      };
    } catch {
      return {
        name: source.packageName,
        version: "missing",
        peerDependencies: {}
      };
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
