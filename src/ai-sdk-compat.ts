import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type AiSdkCompatStatus = "pass" | "fail";

export type AiSdkCompatCheck = {
  id: string;
  status: AiSdkCompatStatus;
  evidence: string[];
  issues: string[];
};

export type AiSdkPackageInfo = {
  name: string;
  version: string;
  peerDependencies: Record<string, string>;
};

export type AiSdkCompatibilityReport = {
  format: "matematica.ai-sdk-compatibility";
  version: 1;
  ok: boolean;
  packages: AiSdkPackageInfo[];
  checks: AiSdkCompatCheck[];
};

type BuildAiSdkCompatibilityInput = {
  runtimeExports?: Record<string, unknown>;
  packages?: AiSdkPackageInfo[];
  typeDefinitionText?: string;
};

const REQUIRED_EXPORTS = [
  "generateText",
  "streamText",
  "tool",
  "stepCountIs",
  "ToolLoopAgent"
];

const REQUIRED_AGENT_METHODS = [
  "generate",
  "stream",
  "prepareCall",
  "mergeOnStepFinishCallbacks"
];

const REQUIRED_PACKAGES = [
  "ai",
  "@ai-sdk/openai",
  "@ai-sdk/anthropic",
  "@ai-sdk/cerebras",
  "@ai-sdk/openai-compatible",
  "@openrouter/ai-sdk-provider"
];

const requireFromHere = createRequire(import.meta.url);

export function buildAiSdkCompatibilityReport(input: BuildAiSdkCompatibilityInput = {}): AiSdkCompatibilityReport {
  const packages = input.packages ?? REQUIRED_PACKAGES.map(readInstalledPackageInfo);
  const runtimeExports = input.runtimeExports ?? requireFromHere("ai") as Record<string, unknown>;
  const typeDefinitionText = input.typeDefinitionText ?? readAiCompatibilitySurfaceText();
  const checks = [
    packageVersionCheck(packages),
    runtimeExportsCheck(runtimeExports),
    toolLoopAgentShapeCheck(runtimeExports),
    typeSurfaceCheck(typeDefinitionText),
    providerPeerAlignmentCheck(packages)
  ];
  return {
    format: "matematica.ai-sdk-compatibility",
    version: 1,
    ok: checks.every((check) => check.status === "pass"),
    packages,
    checks
  };
}

export function formatAiSdkCompatibilityReport(report: AiSdkCompatibilityReport): string {
  const lines = [
    `AI SDK compatibility: ${report.ok ? "pass" : "fail"}`,
    `Packages: ${report.packages.map((item) => `${item.name}@${item.version}`).join(", ")}`
  ];
  for (const check of report.checks) {
    lines.push(`${check.status.toUpperCase()} ${check.id}`);
    for (const evidence of check.evidence) lines.push(`  evidence: ${evidence}`);
    for (const issue of check.issues) lines.push(`  issue: ${issue}`);
  }
  return lines.join("\n");
}

function packageVersionCheck(packages: AiSdkPackageInfo[]): AiSdkCompatCheck {
  const issues: string[] = [];
  const byName = new Map(packages.map((item) => [item.name, item]));
  const aiPackage = byName.get("ai");
  if (!aiPackage) {
    issues.push("ai package is missing");
  } else if (majorVersion(aiPackage.version) !== 6) {
    issues.push(`ai major version must be 6 for ToolLoopAgent compatibility, got ${aiPackage.version}`);
  }
  for (const name of REQUIRED_PACKAGES.slice(1)) {
    if (!byName.has(name)) issues.push(`${name} package is missing`);
  }
  return {
    id: "ai-sdk-package-versions",
    status: issues.length === 0 ? "pass" : "fail",
    evidence: packages.map((item) => `${item.name}@${item.version}`),
    issues
  };
}

function runtimeExportsCheck(runtimeExports: Record<string, unknown>): AiSdkCompatCheck {
  const issues = REQUIRED_EXPORTS
    .filter((name) => typeof runtimeExports[name] !== "function")
    .map((name) => `ai export ${name} must be available as a function`);
  if ("Experimental_Agent" in runtimeExports && runtimeExports.Experimental_Agent !== runtimeExports.ToolLoopAgent) {
    issues.push("Experimental_Agent alias no longer points at ToolLoopAgent");
  }
  return {
    id: "ai-sdk-runtime-exports",
    status: issues.length === 0 ? "pass" : "fail",
    evidence: REQUIRED_EXPORTS.map((name) => `${name}:${typeof runtimeExports[name]}`),
    issues
  };
}

function toolLoopAgentShapeCheck(runtimeExports: Record<string, unknown>): AiSdkCompatCheck {
  const agent = runtimeExports.ToolLoopAgent;
  const prototype = typeof agent === "function"
    ? Object.getOwnPropertyNames(agent.prototype ?? {})
    : [];
  const issues = REQUIRED_AGENT_METHODS
    .filter((name) => !prototype.includes(name))
    .map((name) => `ToolLoopAgent prototype is missing ${name}`);
  return {
    id: "toolloopagent-shape",
    status: issues.length === 0 ? "pass" : "fail",
    evidence: [`ToolLoopAgent prototype methods: ${prototype.join(", ")}`],
    issues
  };
}

function typeSurfaceCheck(typeDefinitionText: string): AiSdkCompatCheck {
  const requiredSnippets: Array<{ snippet: string; label: string }> = [
    { snippet: "abortSignal", label: "AbortSignal cancellation" },
    { snippet: "timeout", label: "timeout control" },
    { snippet: "maxRetries", label: "AI SDK retry control" },
    { snippet: "stopWhen", label: "loop stop condition" },
    { snippet: "prepareStep", label: "per-step preparation hook" },
    { snippet: "onStepFinish", label: "step-finish callback" },
    { snippet: "onStepStart", label: "step-start callback" },
    { snippet: "experimental_telemetry", label: "telemetry hook" },
    { snippet: "experimental_repairToolCall", label: "tool-call repair hook" },
    { snippet: "ToolLoopAgentSettings", label: "ToolLoopAgent settings type" },
    { snippet: "toModelOutput", label: "tool-result model-output summary" },
    { snippet: "ToolLoopAgent as Experimental_Agent", label: "Experimental_Agent alias" }
  ];
  const issues = requiredSnippets
    .filter(({ snippet }) => !typeDefinitionText.includes(snippet))
    .map(({ snippet, label }) => `AI SDK type surface is missing ${label} (${snippet})`);
  return {
    id: "ai-sdk-type-surface",
    status: issues.length === 0 ? "pass" : "fail",
    evidence: [
      `type definitions expose ${requiredSnippets.map((item) => item.label).join(", ")}`
    ],
    issues
  };
}

function providerPeerAlignmentCheck(packages: AiSdkPackageInfo[]): AiSdkCompatCheck {
  const byName = new Map(packages.map((item) => [item.name, item]));
  const aiMajor = majorVersion(byName.get("ai")?.version ?? "0.0.0");
  const issues: string[] = [];
  for (const pkg of packages) {
    const aiPeer = pkg.peerDependencies.ai;
    if (aiPeer && !peerRangeMentionsMajor(aiPeer, aiMajor)) {
      issues.push(`${pkg.name} peer dependency on ai (${aiPeer}) does not allow installed major ${aiMajor}`);
    }
    const zodPeer = pkg.peerDependencies.zod;
    if (zodPeer && !zodPeer.includes("^4")) {
      issues.push(`${pkg.name} zod peer dependency does not allow zod v4`);
    }
  }
  return {
    id: "provider-peer-alignment",
    status: issues.length === 0 ? "pass" : "fail",
    evidence: packages.map((item) => {
      const peers = Object.entries(item.peerDependencies).map(([name, range]) => `${name}@${range}`).join(", ");
      return `${item.name} peers: ${peers || "none"}`;
    }),
    issues
  };
}

function readInstalledPackageInfo(name: string): AiSdkPackageInfo {
  const path = requireFromHere.resolve(`${name}/package.json`);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as {
    name?: unknown;
    version?: unknown;
    peerDependencies?: unknown;
  };
  return {
    name: typeof parsed.name === "string" ? parsed.name : name,
    version: typeof parsed.version === "string" ? parsed.version : "0.0.0",
    peerDependencies: isRecord(parsed.peerDependencies)
      ? Object.fromEntries(Object.entries(parsed.peerDependencies).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
      : {}
  };
}

function readAiCompatibilitySurfaceText(): string {
  const aiRoot = dirname(requireFromHere.resolve("ai/package.json"));
  return [
    readFileSync(join(aiRoot, "dist", "index.d.ts"), "utf8"),
    readOptionalFile(join(aiRoot, "docs", "03-agents", "06-subagents.mdx")),
    readOptionalFile(join(aiRoot, "docs", "03-ai-sdk-core", "15-tools-and-tool-calling.mdx"))
  ].join("\n");
}

function readOptionalFile(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function majorVersion(version: string): number {
  const major = Number(version.split(".")[0]);
  return Number.isFinite(major) ? major : 0;
}

function peerRangeMentionsMajor(range: string, major: number): boolean {
  return range.includes(`^${major}.`) || range.includes(`${major}.`) || range.includes(`>=${major}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
