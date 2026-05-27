import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export type ProviderBoundaryStaticAuditIssue = {
  file: string;
  code:
    | "restricted_import"
    | "restricted_require"
    | "restricted_dynamic_import"
    | "direct_model_call";
  detail: string;
};

export type ProviderBoundaryStaticAuditReport = {
  format: "matematica.provider-boundary-static-audit";
  version: 1;
  ok: boolean;
  filesScanned: number;
  approvedBoundaries: ProviderBoundaryApprovedBoundary[];
  issues: ProviderBoundaryStaticAuditIssue[];
};

export type ProviderBoundaryApprovedBoundary = {
  file: string;
  packages: string[];
  reason: string;
};

export type ProviderBoundaryStaticAuditFile = {
  path: string;
  text: string;
};

const RESTRICTED_PACKAGES = [
  "ai",
  "@ai-sdk/openai",
  "@ai-sdk/anthropic",
  "@ai-sdk/cerebras",
  "@ai-sdk/openai-compatible",
  "@openrouter/ai-sdk-provider",
  "openai",
  "@anthropic-ai/sdk",
  "anthropic",
  "@cerebras/cerebras_cloud_sdk",
  "cerebras"
];

const DIRECT_MODEL_CALLS = [
  "generateText",
  "streamText",
  "createOpenAI",
  "createAnthropic",
  "createOpenRouter",
  "createCerebras",
  "createOpenAICompatible"
];

const APPROVED_BOUNDARIES: ProviderBoundaryApprovedBoundary[] = [
  {
    file: "src/ai-sdk-compat.ts",
    packages: ["ai"],
    reason: "release doctor compatibility probe only; no provider request is dispatched"
  },
  {
    file: "src/ai/instrumented.ts",
    packages: ["ai"],
    reason: "single instrumented AI SDK model-call boundary with ledger, budget, privacy, pricing, and replay controls"
  },
  {
    file: "src/providers.ts",
    packages: [
      "ai",
      "@ai-sdk/openai",
      "@ai-sdk/anthropic",
      "@ai-sdk/cerebras",
      "@ai-sdk/openai-compatible",
      "@openrouter/ai-sdk-provider"
    ],
    reason: "provider adapter factory only; returns LanguageModel handles for the instrumented boundary"
  },
  {
    file: "src/runner.ts",
    packages: ["ai"],
    reason: "LanguageModel type threading only; provider calls are delegated to instrumented/coordinator paths"
  },
  {
    file: "src/swarm-coordinator.ts",
    packages: ["ai"],
    reason: "worker-local ToolLoopAgent coordination only; dispatch still calls generateInstrumentedText"
  }
];

export function buildProviderBoundaryStaticAuditReport(input: {
  packageRoot?: string;
  files?: ProviderBoundaryStaticAuditFile[];
} = {}): ProviderBoundaryStaticAuditReport {
  const packageRoot = input.packageRoot ?? defaultPackageRoot();
  const files = input.files ?? readSourceFiles(packageRoot);
  const issues = files.flatMap((file) => auditFile(file));
  return {
    format: "matematica.provider-boundary-static-audit",
    version: 1,
    ok: issues.length === 0,
    filesScanned: files.length,
    approvedBoundaries: APPROVED_BOUNDARIES,
    issues
  };
}

function auditFile(file: ProviderBoundaryStaticAuditFile): ProviderBoundaryStaticAuditIssue[] {
  const issues: ProviderBoundaryStaticAuditIssue[] = [];
  for (const specifier of importSpecifiers(file.text)) {
    if (!isRestrictedPackage(specifier)) continue;
    if (isPackageAllowed(file.path, specifier)) continue;
    issues.push({
      file: file.path,
      code: "restricted_import",
      detail: `${specifier} may only be imported by approved provider-boundary files`
    });
  }
  for (const specifier of requireSpecifiers(file.text)) {
    if (!isRestrictedPackage(specifier)) continue;
    if (isPackageAllowed(file.path, specifier)) continue;
    issues.push({
      file: file.path,
      code: "restricted_require",
      detail: `${specifier} may only be required by approved provider-boundary files`
    });
  }
  for (const specifier of dynamicImportSpecifiers(file.text)) {
    if (!isRestrictedPackage(specifier)) continue;
    if (isPackageAllowed(file.path, specifier)) continue;
    issues.push({
      file: file.path,
      code: "restricted_dynamic_import",
      detail: `${specifier} may only be dynamically imported by approved provider-boundary files`
    });
  }
  for (const call of DIRECT_MODEL_CALLS) {
    if (!containsCall(file.text, call)) continue;
    if (isDirectCallAllowed(file.path, call)) continue;
    issues.push({
      file: file.path,
      code: "direct_model_call",
      detail: `${call}() may only run inside the approved AI SDK provider boundary`
    });
  }
  return issues;
}

function isPackageAllowed(file: string, specifier: string): boolean {
  const boundary = APPROVED_BOUNDARIES.find((item) => item.file === file);
  return boundary?.packages.some((allowed) => specifier === allowed || specifier.startsWith(`${allowed}/`)) === true;
}

function isDirectCallAllowed(file: string, call: string): boolean {
  if (file === "src/ai/instrumented.ts" && (call === "generateText" || call === "streamText")) return true;
  if (file === "src/providers.ts" && call.startsWith("create")) return true;
  return false;
}

function importSpecifiers(text: string): string[] {
  return [
    ...text.matchAll(/\bimport\s+(?:type\s+)?(?:[^'"]+?\s+from\s+)?["']([^"']+)["']/g)
  ].map((match) => match[1]);
}

function requireSpecifiers(text: string): string[] {
  return [
    ...text.matchAll(/\brequire(?:FromHere)?\(\s*["']([^"']+)["']\s*\)/g)
  ].map((match) => match[1]);
}

function dynamicImportSpecifiers(text: string): string[] {
  return [
    ...text.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)
  ].map((match) => match[1]);
}

function containsCall(text: string, name: string): boolean {
  return new RegExp(`\\b${name}\\s*\\(`).test(text);
}

function isRestrictedPackage(specifier: string): boolean {
  return RESTRICTED_PACKAGES.some((restricted) =>
    specifier === restricted || specifier.startsWith(`${restricted}/`)
  );
}

function readSourceFiles(packageRoot: string): ProviderBoundaryStaticAuditFile[] {
  const srcRoot = join(packageRoot, "src");
  if (!existsSync(srcRoot)) return [];
  return listTypeScriptFiles(srcRoot).map((path) => ({
    path: normalizeRelativePath(relative(packageRoot, path)),
    text: readFileSync(path, "utf8")
  }));
}

function listTypeScriptFiles(root: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      result.push(...listTypeScriptFiles(path));
      continue;
    }
    if (stat.isFile() && path.endsWith(".ts")) result.push(path);
  }
  return result.sort();
}

function normalizeRelativePath(path: string): string {
  return path.split(sep).join("/");
}

function defaultPackageRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}
