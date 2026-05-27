import { expect, test } from "bun:test";
import {
  EXTERNAL_FRESHNESS_SCHEMA_VERSION,
  buildArxivFreshnessSnapshot,
  buildDefaultExternalFreshnessSnapshots,
  buildExternalFreshnessGateReport
} from "../src/freshness";
import { loadConfig } from "../src/config";
import { providerCapabilityMatrix } from "../src/provider-capabilities";

test("default external freshness snapshots cover arxiv ai sdk and provider policy surfaces", () => {
  const config = loadConfig(process.cwd(), {
    OPENAI_API_KEY: "sk-test-openai",
    ANTHROPIC_API_KEY: "sk-test-anthropic",
    OPENROUTER_API_KEY: "sk-test-openrouter",
    CEREBRAS_API_KEY: "sk-test-cerebras",
    MATEMATICA_LOCAL_BASE_URL: "http://localhost:11434/v1",
    MATEMATICA_LOCAL_MODEL: "local-model"
  });
  const snapshots = buildDefaultExternalFreshnessSnapshots({
    providers: providerCapabilityMatrix(config),
    aiSdkPackages: [
      { name: "ai", version: "6.0.0", peerDependencies: {} },
      { name: "@ai-sdk/openai", version: "6.0.0", peerDependencies: { ai: "^6.0.0" } },
      { name: "@ai-sdk/anthropic", version: "6.0.0", peerDependencies: { ai: "^6.0.0" } },
      { name: "@ai-sdk/cerebras", version: "6.0.0", peerDependencies: { ai: "^6.0.0" } },
      { name: "@ai-sdk/openai-compatible", version: "6.0.0", peerDependencies: { ai: "^6.0.0" } },
      { name: "@openrouter/ai-sdk-provider", version: "1.0.0", peerDependencies: { ai: "^6.0.0" } }
    ]
  });

  expect(snapshots.map((snapshot) => snapshot.surface).sort()).toEqual([
    "ai-sdk-anthropic",
    "ai-sdk-cerebras",
    "ai-sdk-core",
    "ai-sdk-openai",
    "ai-sdk-openai-compatible",
    "anthropic-provider-policy",
    "arxiv-api",
    "cerebras-provider-policy",
    "local-provider-policy",
    "openai-provider-policy",
    "openrouter-ai-sdk-provider",
    "openrouter-provider-policy"
  ]);
  expect(snapshots.every((snapshot) => snapshot.format === "matematica.external-freshness-snapshot")).toBe(true);
  expect(snapshots.every((snapshot) => snapshot.version === 1)).toBe(true);
  expect(snapshots.every((snapshot) => snapshot.schemaVersion === EXTERNAL_FRESHNESS_SCHEMA_VERSION)).toBe(true);
  expect(snapshots.every((snapshot) => snapshot.sourceUrls.length > 0)).toBe(true);
  expect(snapshots.every((snapshot) => snapshot.snapshotHash.length > 0)).toBe(true);
  expect(JSON.stringify(snapshots)).not.toContain("sk-test");
});

test("external freshness gate fails stale and schema drifted snapshots without network calls", () => {
  const stale = {
    ...buildArxivFreshnessSnapshot({ retrievedAt: "2026-01-01T00:00:00.000Z", maxAgeDays: 30 }),
    schemaVersion: "external-freshness-v0"
  };
  const report = buildExternalFreshnessGateReport({
    snapshots: [stale],
    now: new Date("2026-05-25T00:00:00.000Z"),
    maxAgeDays: 30,
    expectedSchemaVersions: {
      "arxiv-api": EXTERNAL_FRESHNESS_SCHEMA_VERSION
    }
  });

  expect(report.ok).toBe(false);
  expect(report.checks[0].stale).toBe(true);
  expect(report.checks[0].issues.join("\n")).toContain("freshness snapshot is stale");
  expect(report.checks[0].issues.join("\n")).toContain("freshness schema drift");
});
