import { expect, test } from "bun:test";
import { buildAiSdkCompatibilityReport, formatAiSdkCompatibilityReport } from "../src/ai-sdk-compat";
import { buildProviderBoundaryStaticAuditReport } from "../src/provider-boundary-audit";

test("AI SDK compatibility gate accepts installed ToolLoopAgent surface", () => {
  const report = buildAiSdkCompatibilityReport();

  expect(report.ok).toBe(true);
  expect(report.packages.map((item) => item.name)).toContain("ai");
  expect(report.packages.find((item) => item.name === "ai")?.version).toStartWith("6.");
  expect(report.checks.every((check) => check.status === "pass")).toBe(true);
  expect(JSON.stringify(report)).toContain("ToolLoopAgent");
  expect(JSON.stringify(report)).toContain("step-finish callback");
  expect(JSON.stringify(report)).toContain("AI SDK retry control");
  expect(JSON.stringify(report)).toContain("timeout control");
  expect(JSON.stringify(report)).toContain("loop stop condition");
  expect(JSON.stringify(report)).toContain("per-step preparation hook");
  expect(JSON.stringify(report)).toContain("tool-call repair hook");
  expect(JSON.stringify(report)).toContain("telemetry hook");
  expect(JSON.stringify(report)).toContain("tool-result model-output summary");
});

test("AI SDK compatibility gate fails closed on ToolLoopAgent API drift", () => {
  const report = buildAiSdkCompatibilityReport({
    runtimeExports: {
      generateText: () => undefined,
      streamText: () => undefined,
      tool: () => undefined,
      stepCountIs: () => undefined,
      ToolLoopAgent: function ToolLoopAgent() {}
    },
    packages: [{
      name: "ai",
      version: "6.0.191",
      peerDependencies: { zod: "^3.25.76 || ^4.1.8" }
    }, {
      name: "@openrouter/ai-sdk-provider",
      version: "2.9.0",
      peerDependencies: { ai: "^5.0.0", zod: "^3.25.0 || ^4.0.0" }
    }],
    typeDefinitionText: "generateText streamText"
  });

  expect(report.ok).toBe(false);
  expect(JSON.stringify(report)).toContain("ToolLoopAgent prototype is missing generate");
  expect(JSON.stringify(report)).toContain("AI SDK type surface is missing AbortSignal cancellation (abortSignal)");
  expect(JSON.stringify(report)).toContain("AI SDK type surface is missing AI SDK retry control (maxRetries)");
  expect(JSON.stringify(report)).toContain("AI SDK type surface is missing timeout control (timeout)");
  expect(JSON.stringify(report)).toContain("AI SDK type surface is missing loop stop condition (stopWhen)");
  expect(JSON.stringify(report)).toContain("AI SDK type surface is missing per-step preparation hook (prepareStep)");
  expect(JSON.stringify(report)).toContain("AI SDK type surface is missing telemetry hook (experimental_telemetry)");
  expect(JSON.stringify(report)).toContain("AI SDK type surface is missing tool-call repair hook (experimental_repairToolCall)");
  expect(JSON.stringify(report)).toContain("does not allow installed major 6");
  expect(formatAiSdkCompatibilityReport(report)).toContain("AI SDK compatibility: fail");
});

test("AI SDK provider boundary audit accepts the current source tree", () => {
  const report = buildProviderBoundaryStaticAuditReport({ packageRoot: process.cwd() });

  expect(report.ok).toBe(true);
  expect(report.filesScanned).toBeGreaterThan(0);
  expect(report.issues).toEqual([]);
  expect(report.approvedBoundaries.map((boundary) => boundary.file)).toEqual(expect.arrayContaining([
    "src/ai/instrumented.ts",
    "src/providers.ts"
  ]));
  expect(report.approvedBoundaries.map((boundary) => boundary.file)).not.toContain("src/cli.ts");
});

test("AI SDK provider boundary audit rejects direct model and vendor SDK calls outside approved files", () => {
  const report = buildProviderBoundaryStaticAuditReport({
    files: [{
      path: "src/bad-model-call.ts",
      text: 'import { generateText } from "ai";\nawait generateText({} as never);\n'
    }, {
      path: "src/bad-vendor-sdk.ts",
      text: 'import OpenAI from "openai";\nconst client = new OpenAI();\n'
    }, {
      path: "src/bad-provider-factory.ts",
      text: 'const { createOpenAI } = require("@ai-sdk/openai");\ncreateOpenAI({ apiKey: "x" });\n'
    }, {
      path: "src/cli.ts",
      text: 'const { generateText } = await import("ai");\nawait generateText({} as never);\n'
    }]
  });

  expect(report.ok).toBe(false);
  expect(report.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
    "restricted_import",
    "restricted_require",
    "direct_model_call"
  ]));
  expect(report.issues.map((issue) => issue.file)).toEqual(expect.arrayContaining([
    "src/bad-model-call.ts",
    "src/bad-vendor-sdk.ts",
    "src/bad-provider-factory.ts",
    "src/cli.ts"
  ]));
});

test("AI SDK provider boundary audit allows approved adapter imports and direct calls only in boundary files", () => {
  const report = buildProviderBoundaryStaticAuditReport({
    files: [{
      path: "src/providers.ts",
      text: 'import type { LanguageModel } from "ai";\nimport { createOpenAI } from "@ai-sdk/openai";\ncreateOpenAI({ apiKey: "x" });\n'
    }, {
      path: "src/ai/instrumented.ts",
      text: 'import { generateText, streamText } from "ai";\ngenerateText({} as never);\nstreamText({} as never);\n'
    }, {
      path: "src/runner.ts",
      text: 'import type { LanguageModel } from "ai";\nexport type Model = LanguageModel;\n'
    }]
  });

  expect(report.ok).toBe(true);
  expect(report.issues).toEqual([]);
});
