import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { providerCapabilityMatrix } from "../src/provider-capabilities";
import { buildProviderRouteSmokeMatrixReport } from "../src/provider-route-smoke";

function withConfig<T>(fn: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), "matematica-provider-route-smoke-test-"));
  try {
    return fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("provider route smoke matrix covers all supported AI SDK routes without network egress", () => {
  withConfig((home) => {
    const config = loadConfig(home, {});
    const providers = providerCapabilityMatrix(config);
    const report = buildProviderRouteSmokeMatrixReport({
      config,
      providers,
      now: new Date("2026-05-26T00:00:00.000Z")
    });

    expect(report.ok).toBe(true);
    expect(report.mode).toBe("mocked_no_network");
    expect(report.requiredProviders).toEqual(["openai", "anthropic", "openrouter", "cerebras", "local"]);
    expect(report.cases.map((item) => item.provider)).toEqual(report.requiredProviders);
    expect(report.issues).toEqual([]);
    expect(report.matrixHash).toMatch(/^[a-f0-9]{64}$/);

    const openrouter = report.cases.find((item) => item.provider === "openrouter");
    expect(openrouter?.actualUpstreamProvider).toBe("openai");
    expect(openrouter?.actualUpstreamModel).toBe("openai/gpt-5.2");
    expect(openrouter?.checks.openRouterUpstreamProvenance).toBe(true);

    for (const smoke of report.cases) {
      expect(smoke.requestedProvider).toBe(smoke.provider);
      expect(smoke.observedProvider).toBe(smoke.provider);
      expect(smoke.requestedModel).toBe(smoke.modelId);
      expect(smoke.observedModel).toBe(smoke.modelId);
      expect(smoke.checks.requestedObservedLineage).toBe(true);
      expect(smoke.checks.providerSpecificOptions).toBe(true);
      expect(smoke.checks.toolCalling).toBe(true);
      expect(smoke.checks.structuredOutput).toBe(true);
      expect(smoke.checks.abortTimeout).toBe(true);
      expect(smoke.checks.usageCostMetadata).toBe(true);
      expect(smoke.checks.redaction).toBe(true);
      expect(smoke.checks.replayArtifacts).toBe(true);
      expect(smoke.checks.freeOssNoPaidCall).toBe(true);
      expect(smoke.routeHash).toMatch(/^[a-f0-9]{64}$/);
      expect(smoke.evidence.join("\n")).toContain("without network egress");
    }
  });
});

test("provider route smoke matrix fails closed for missing providers and broken checks", () => {
  withConfig((home) => {
    const config = loadConfig(home, {});
    const providers = providerCapabilityMatrix(config);
    const base = buildProviderRouteSmokeMatrixReport({
      config,
      providers,
      now: new Date("2026-05-26T00:00:00.000Z")
    });
    const brokenCase = {
      ...base.cases[0],
      checks: {
        ...base.cases[0].checks,
        usageCostMetadata: false
      },
      issues: ["usage/cost metadata coverage is missing"]
    };
    const report = buildProviderRouteSmokeMatrixReport({
      config,
      providers,
      now: new Date("2026-05-26T00:00:00.000Z"),
      cases: [brokenCase]
    });

    expect(report.ok).toBe(false);
    expect(report.issues).toEqual(expect.arrayContaining([
      "anthropic: missing provider route smoke case",
      "openrouter: missing provider route smoke case",
      "cerebras: missing provider route smoke case",
      "local: missing provider route smoke case",
      `${brokenCase.provider}/${brokenCase.modelId}: usage/cost metadata coverage is missing`
    ]));
  });
});
