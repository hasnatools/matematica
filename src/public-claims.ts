import type { ReleaseDoctorCheck } from "./release-doctor";

export type PublicClaimSource = string;

export type PublicClaimSurfaceKind =
  | "readme"
  | "cli-help"
  | "package-metadata"
  | "notice"
  | "license"
  | "docs"
  | "example"
  | "benchmark-summary";

export type PublicClaimSurface = {
  id: string;
  kind: PublicClaimSurfaceKind;
  text: string;
};

export type PublicReleaseClaim = {
  id: string;
  source: PublicClaimSource;
  claim: string;
  textNeedles: string[];
  requiredCheckIds: string[];
};

export type PublicClaimReleaseMatrixReport = {
  format: "matematica.public-claim-release-matrix";
  version: 1;
  ok: boolean;
  claimCount: number;
  claims: Array<PublicReleaseClaim & {
    sourcePresent: boolean;
    checksPresent: string[];
    checksMissing: string[];
    checksFailing: string[];
  }>;
  issues: string[];
};

export type PublicClaimSurfaceAuditIssue = {
  surfaceId: string;
  kind: PublicClaimSurfaceKind;
  code:
    | "unsupported_autonomous_proof_guarantee"
    | "unsupported_absolute_privacy_guarantee"
    | "unsupported_free_remote_compute_claim"
    | "unsupported_provider_neutrality_claim"
    | "unsupported_unqualified_save_everything_claim"
    | "unsupported_open_problem_solved_claim";
  phrase: string;
  reason: string;
};

export type PublicClaimSurfaceAuditReport = {
  format: "matematica.public-claim-surface-audit";
  version: 1;
  ok: boolean;
  surfaceCount: number;
  surfaces: Array<Pick<PublicClaimSurface, "id" | "kind">>;
  issues: PublicClaimSurfaceAuditIssue[];
};

export const PUBLIC_RELEASE_CLAIMS: PublicReleaseClaim[] = [
  claim({
    id: "public-package-identity",
    source: "README.md",
    claim: "The public package is @hasna/matematica, command matematica, MIT licensed, and ships required public docs.",
    textNeedles: ["The public package name is `@hasna/matematica`", "MIT licensed and ships `LICENSE` and `NOTICE` files"],
    requiredCheckIds: ["package-metadata", "package-files"]
  }),
  claim({
    id: "package-json-public-metadata",
    source: "package.json",
    claim: "package.json metadata identifies the public package, command, license, repository, and Bun CLI boundary.",
    textNeedles: ["\"name\": \"@hasna/matematica\"", "\"license\": \"MIT\"", "\"mathematics\""],
    requiredCheckIds: ["package-metadata", "package-files", "public-claims-surface-audit"]
  }),
  claim({
    id: "notice-no-hosted-compute",
    source: "NOTICE",
    claim: "NOTICE states the free OSS package does not include hosted compute, credits, API keys, private infrastructure, or telemetry.",
    textNeedles: ["does not include hosted compute", "Remote model use is bring-your-own-key"],
    requiredCheckIds: ["zero-network", "byok-boundary", "package-files", "public-claims-surface-audit"]
  }),
  claim({
    id: "free-oss-no-bundled-compute",
    source: "README.md",
    claim: "The CLI is free/open source and does not include hosted compute, bundled credits, API keys, or provider accounts.",
    textNeedles: ["The CLI is free and open source", "It does not include bundled model credits"],
    requiredCheckIds: ["zero-network", "byok-boundary", "package-files"]
  }),
  claim({
    id: "zero-key-local-baseline",
    source: "README.md",
    claim: "A clean zero-key, zero-network local install can run doctor, create/run goals, report, audit, and replay.",
    textNeedles: ["A clean install with zero provider keys and", "zero network permissions can run `matematica doctor`"],
    requiredCheckIds: ["zero-network", "package-files", "saved-everything-release-coverage", "zero-false-solved-evals"]
  }),
  claim({
    id: "remote-byok-explicit-costs",
    source: "README.md",
    claim: "Remote provider use is BYOK, explicit, allowlisted, and requires per-call USD caps.",
    textNeedles: ["Remote provider use is explicit", "Every\nremote provider call requires `--max-call-usd`"],
    requiredCheckIds: ["byok-boundary", "provider-legal-privacy", "provider-model-pricing"]
  }),
  claim({
    id: "provider-egress-firewall",
    source: "README.md",
    claim: "Provider egress is firewalled and redacts secret-looking values and local paths before remote calls.",
    textNeedles: ["Provider egress is firewalled before the AI SDK call", "Secret-looking values and local\nfilesystem paths are redacted"],
    requiredCheckIds: ["byok-boundary", "ai-sdk-provider-boundary-static-audit", "zero-false-solved-evals", "hostile-live-provider-dry-run"]
  }),
  claim({
    id: "offline-source-default",
    source: "README.md",
    claim: "Default/offline/local-only arXiv research does not call network fetchers and uses cache miss/hit provenance.",
    textNeedles: ["In default/offline/local-only mode, arXiv research does not call fetchers", "`source.offline_cache.missed`"],
    requiredCheckIds: ["zero-network", "external-freshness-snapshots", "research-legal-privacy-citations", "zero-false-solved-evals"]
  }),
  claim({
    id: "untrusted-source-firewall",
    source: "README.md",
    claim: "Retrieved source text is quarantined and cannot change tool, provider, budget, verifier, or success policy.",
    textNeedles: ["Retrieved source text is untrusted data", "cannot change tool, provider, budget, verifier, or success policy"],
    requiredCheckIds: ["research-legal-privacy-citations", "zero-false-solved-evals", "workflow-phase-release-audit"]
  }),
  claim({
    id: "ai-sdk-worker-local-boundary",
    source: "README.md",
    claim: "AI SDK tool loops are worker-local and the CLI ledger owns global orchestration.",
    textNeedles: ["AI SDK tool loops are worker-local only", "The CLI ledger owns global worker leases"],
    requiredCheckIds: ["ai-sdk-provider-boundary-static-audit", "ai-sdk-compatibility", "workflow-phase-release-audit", "zero-false-solved-evals"]
  }),
  claim({
    id: "docs-ai-sdk-boundary",
    source: "docs/adr/0001-ai-sdk-swarm-boundary.md",
    claim: "The AI SDK ADR keeps worker-local model loops separate from CLI-owned global swarm and proof authority.",
    textNeedles: ["The CLI ledger is the swarm coordinator", "AI SDK text, tool summaries"],
    requiredCheckIds: ["ai-sdk-provider-boundary-static-audit", "ai-sdk-compatibility", "workflow-phase-release-audit", "public-claims-surface-audit"]
  }),
  claim({
    id: "remote-swarm-control-plane",
    source: "README.md",
    claim: "Remote swarm execution is coordinated by signed CLI ledger leases and replayable dispatch ids.",
    textNeedles: ["Remote swarm execution is coordinated by the CLI ledger", "Each remote dispatch id is an idempotency key"],
    requiredCheckIds: ["workflow-phase-release-audit", "milestone-gates", "hostile-live-provider-dry-run"]
  }),
  claim({
    id: "no-false-solved-release",
    source: "README.md",
    claim: "Collatz/open-problem smoke must end budget_exhausted without solved claims.",
    textNeedles: ["The Collatz/open-problem smoke must end `budget_exhausted` without a", "solved claim"],
    requiredCheckIds: ["zero-false-solved-evals", "public-claim-language-guardrail"]
  }),
  claim({
    id: "benchmark-copy-open-problem-honesty",
    source: "hard-math-benchmark-ladder",
    claim: "Benchmark copy advertises false-solved prevention and open-problem honesty as release gates.",
    textNeedles: ["false-solved rate target 0", "public release minimum t5-open-problem-honesty"],
    requiredCheckIds: ["zero-false-solved-evals", "milestone-gates", "public-claims-surface-audit"]
  }),
  claim({
    id: "release-milestone-ordering",
    source: "README.md",
    claim: "Release milestones are ordered and backed by machine-readable gates.",
    textNeedles: ["`matematica milestones list --json` exposes the release ordering", "A milestone is ready only when all required gates"],
    requiredCheckIds: ["milestone-gates", "release-evidence-freshness", "shared-implementation-plan-registry", "canonical-release-plan"]
  }),
  claim({
    id: "release-doctor-readiness-report",
    source: "README.md",
    claim: "doctor --release --json emits release readiness for package, zero-network, BYOK, and milestones.",
    textNeedles: ["`matematica doctor --release --json` emits the matching release-readiness report"],
    requiredCheckIds: ["package-metadata", "package-files", "zero-network", "byok-boundary", "milestone-gates", "release-evidence-freshness", "shared-implementation-plan-registry", "canonical-release-plan"]
  }),
  claim({
    id: "help-budget-and-remote-cost-contract",
    source: "cli-help",
    claim: "CLI help documents budget, provider, max-call USD, and explicit remote-cost consent surfaces.",
    textNeedles: ["--max-call-usd <number>", "--i-understand-remote-costs", "matematica goal run <run-id>"],
    requiredCheckIds: ["byok-boundary", "provider-model-pricing"]
  }),
  claim({
    id: "help-replay-and-audit-contract",
    source: "cli-help",
    claim: "CLI help documents replay, offline final verification, deterministic replay, export/import, and audit.",
    textNeedles: ["matematica goal replay <run-id> --offline --verify-final", "matematica goal audit <run-id>"],
    requiredCheckIds: ["saved-everything-release-coverage", "zero-false-solved-evals", "workflow-phase-release-audit"]
  }),
  claim({
    id: "help-release-gates-contract",
    source: "cli-help",
    claim: "CLI help documents hostile benchmarks, release gate, milestone gates, and release doctor.",
    textNeedles: ["matematica benchmarks release-gate", "matematica milestones list [--json]", "matematica release-plan show [--json]", "matematica release-plan registry [--json]", "matematica release-plan evidence [--json]", "matematica doctor --release"],
    requiredCheckIds: ["zero-false-solved-evals", "milestone-gates", "release-evidence-freshness", "shared-implementation-plan-registry", "canonical-release-plan"]
  })
];

export function buildPublicClaimReleaseMatrixReport(input: {
  readmeText: string;
  cliHelpText: string;
  releaseChecks: ReleaseDoctorCheck[];
  claims?: PublicReleaseClaim[];
  surfaces?: PublicClaimSurface[];
}): PublicClaimReleaseMatrixReport {
  const checksById = new Map(input.releaseChecks.map((check) => [check.id, check]));
  const surfaceTextById = buildSurfaceTextById(input);
  const claims = (input.claims ?? PUBLIC_RELEASE_CLAIMS).map((item) => {
    const sourceText = surfaceTextById.get(item.source) ?? "";
    const sourcePresent = item.textNeedles.every((needle) => sourceText.includes(needle));
    const checksPresent = item.requiredCheckIds.filter((id) => checksById.has(id));
    const checksMissing = item.requiredCheckIds.filter((id) => !checksById.has(id));
    const checksFailing = item.requiredCheckIds.filter((id) => checksById.get(id)?.status === "fail");
    return {
      ...item,
      sourcePresent,
      checksPresent,
      checksMissing,
      checksFailing
    };
  });
  const issues = claims.flatMap((item) => [
    item.sourcePresent ? undefined : `${item.id}: public source no longer contains expected claim text`,
    item.requiredCheckIds.length > 0 ? undefined : `${item.id}: claim has no release-blocking checks`,
    ...item.checksMissing.map((id) => `${item.id}: missing release check ${id}`),
    ...item.checksFailing.map((id) => `${item.id}: release check ${id} is failing`)
  ].filter((issue): issue is string => Boolean(issue)));
  return {
    format: "matematica.public-claim-release-matrix",
    version: 1,
    ok: issues.length === 0,
    claimCount: claims.length,
    claims,
    issues
  };
}

export function buildPublicClaimSurfaceAuditReport(
  surfaces: PublicClaimSurface[]
): PublicClaimSurfaceAuditReport {
  const issues = surfaces.flatMap(validatePublicClaimSurface);
  return {
    format: "matematica.public-claim-surface-audit",
    version: 1,
    ok: issues.length === 0,
    surfaceCount: surfaces.length,
    surfaces: surfaces.map((surface) => ({ id: surface.id, kind: surface.kind })),
    issues
  };
}

export function validatePublicClaimSurface(surface: PublicClaimSurface): PublicClaimSurfaceAuditIssue[] {
  const findings: PublicClaimSurfaceAuditIssue[] = [];
  for (const rule of UNSUPPORTED_PUBLIC_CLAIM_RULES) {
    for (const pattern of rule.patterns) {
      const match = surface.text.match(pattern);
      if (!match) continue;
      if (rule.code === "unsupported_open_problem_solved_claim" && hasOpenProblemHonestyMarker(match[0])) continue;
      findings.push({
        surfaceId: surface.id,
        kind: surface.kind,
        code: rule.code,
        phrase: compact(match[0]),
        reason: rule.reason
      });
      break;
    }
  }
  return uniqueSurfaceIssues(findings);
}

function claim(input: PublicReleaseClaim): PublicReleaseClaim {
  return input;
}

function buildSurfaceTextById(input: {
  readmeText: string;
  cliHelpText: string;
  surfaces?: PublicClaimSurface[];
}): Map<string, string> {
  const result = new Map<string, string>();
  result.set("README.md", input.readmeText);
  result.set("cli-help", input.cliHelpText);
  for (const surface of input.surfaces ?? []) {
    result.set(surface.id, surface.text);
    if (surface.kind === "readme") result.set("README.md", surface.text);
    if (surface.kind === "cli-help") {
      result.set("cli-help", `${result.get("cli-help") ?? ""}\n${surface.text}`);
    }
  }
  return result;
}

const UNSUPPORTED_PUBLIC_CLAIM_RULES: Array<{
  code: PublicClaimSurfaceAuditIssue["code"];
  patterns: RegExp[];
  reason: string;
}> = [
  {
    code: "unsupported_autonomous_proof_guarantee",
    patterns: [
      /\b(solves?|proves?)\s+(any|all|every)\s+(math\s+)?(problem|theorem|conjecture)s?\b/i,
      /\bguarantee[sd]?\s+(a\s+)?(formal\s+)?proof\b/i,
      /\balways\s+(returns?|finds?|produces?)\s+(a\s+)?(formal\s+)?proof\b/i,
      /\bfully\s+autonomous\s+(proof|theorem|math)\s+(solver|prover)\b/i
    ],
    reason: "Public surfaces must not claim autonomous or guaranteed mathematical proof production."
  },
  {
    code: "unsupported_absolute_privacy_guarantee",
    patterns: [
      /\b100%\s+(private|privacy|confidential)\b/i,
      /\bguarantee[sd]?\s+(complete\s+)?privacy\b/i,
      /\bnever\s+sends?\s+(data|prompts?|anything)\b/i,
      /\bno\s+data\s+ever\s+leaves\b/i
    ],
    reason: "Public surfaces may describe concrete privacy controls, but must not make absolute privacy guarantees."
  },
  {
    code: "unsupported_free_remote_compute_claim",
    patterns: [
      /\bfree\s+(remote|hosted)\s+(compute|model|ai|workers?)\b/i,
      /\bfree\s+(openai|anthropic|openrouter|cerebras|provider)\s+(calls?|credits?|usage)\b/i,
      /\bunlimited\s+(free\s+)?(remote|provider|model)\s+(compute|calls?|usage)\b/i
    ],
    reason: "The OSS package has no bundled hosted compute, model credits, API keys, or provider accounts."
  },
  {
    code: "unsupported_provider_neutrality_claim",
    patterns: [
      /\bprovider[-\s]?neutral\b.{0,120}\b(privacy|cost|retention|policy|training)\b/i,
      /\b(all|every)\s+providers?\s+(have|use|offer)\s+the\s+same\s+(privacy|retention|cost|policy)\b/i,
      /\bproviders?\s+(never|do\s+not)\s+(train|store|log)\b/i
    ],
    reason: "Provider behavior varies by provider policy and must be covered by freshness and legal/privacy gates."
  },
  {
    code: "unsupported_unqualified_save_everything_claim",
    patterns: [
      /\b(save|saves|saved|saving)\s+everything\b(?![^.]{0,180}\b(redacted|local forensic|raw text not persisted|raw prompt|raw provider|raw source|verifier-only|portable bundle)\b)/i,
      /\bevery\s+(prompt|provider response|source text|model output)\s+is\s+(saved|persisted)\b(?![^.]{0,180}\b(redacted|raw text not persisted|raw export unsupported|local forensic)\b)/i
    ],
    reason: "Public surfaces must qualify saved-everything claims with the replay trust mode; redacted public exports and verifier-only replay do not persist raw prompts, provider responses, or source text."
  },
  {
    code: "unsupported_open_problem_solved_claim",
    patterns: [
      /\b(collatz|riemann|goldbach|twin\s+prime|erd[oő]s|open\s+problem|conjecture)\b.{0,160}\b(solved|proven|proved)\b/i,
      /\b(solved|proven|proved)\b.{0,160}\b(collatz|riemann|goldbach|twin\s+prime|erd[oő]s|open\s+problem|conjecture)\b/i
    ],
    reason: "Public surfaces must not claim open problems are solved unless backed by formal proof or verified counterexample release evidence."
  }
];

function compact(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 240);
}

function uniqueSurfaceIssues(issues: PublicClaimSurfaceAuditIssue[]): PublicClaimSurfaceAuditIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.surfaceId}:${issue.code}:${issue.phrase}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function hasOpenProblemHonestyMarker(text: string): boolean {
  const normalized = text.toLowerCase();
  return normalized.includes("without") ||
    normalized.includes("budget_exhausted") ||
    normalized.includes("not solved") ||
    normalized.includes("no-false-solved") ||
    normalized.includes("formal proof or verified counterexample");
}
