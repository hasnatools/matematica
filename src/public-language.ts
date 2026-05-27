import type { EvidenceGrade } from "./domain";
import type { FinalAnswerState } from "./outcome";
import type { ProblemClass } from "./problem-classifier";

export type PublicLanguageSurfaceKind =
  | "readme"
  | "cli-help"
  | "package-metadata"
  | "notice"
  | "license"
  | "docs"
  | "example"
  | "report"
  | "watch-json"
  | "terminal-json"
  | "benchmark-summary";

export type PublicLanguageContext = {
  problemClass?: ProblemClass;
  finalState?: FinalAnswerState;
  evidenceGrade?: EvidenceGrade;
  canClaimSolved?: boolean;
};

export type PublicLanguageSurface = {
  id: string;
  kind: PublicLanguageSurfaceKind;
  text: string;
  context?: PublicLanguageContext;
};

export type PublicLanguageGuardrailIssue = {
  surfaceId: string;
  kind: PublicLanguageSurfaceKind;
  code:
    | "unsafe_affirmative_solved_claim"
    | "unsafe_open_problem_solved_wording"
    | "missing_open_problem_honesty_marker";
  phrase?: string;
  reason: string;
};

export type PublicLanguageGuardrailReport = {
  format: "matematica.public-language-guardrail";
  version: 1;
  ok: boolean;
  surfaceCount: number;
  issues: PublicLanguageGuardrailIssue[];
};

const AFFIRMATIVE_SOLVED_PATTERNS: RegExp[] = [
  /\bCan claim solved:\s*yes\b/i,
  /\bOutput trust label:\s*solved\b/i,
  /\bLabel:\s*solved\b/i,
  /"canClaimSolved"\s*:\s*true/i,
  /"label"\s*:\s*"solved"/i,
  /"labelText"\s*:\s*"solved"/i,
  /\bstatus\s*[:=]\s*solved\b/i,
  /\btheorem is solved\b/i,
  /\bproblem is solved\b/i
];

const OPEN_PROBLEM_TERMS = /\b(open problem|open-problem|conjecture|collatz|erd[oő]s|riemann|goldbach|twin prime|unsolved)\b/i;
const SOLVED_WORD = /\b(solved|solution|prove[ds]?|proof)\b/i;
const HONESTY_MARKERS = [
  "not solved",
  "non-solved",
  "without claiming solved",
  "without a solved claim",
  "cannot support a solved claim",
  "requires formal_proof or verified_counterexample",
  "formal proof or verified counterexample",
  "budget_exhausted",
  "no-false-solved",
  "false-solved",
  "open-problem-honesty",
  "useful progress"
];

export function buildPublicLanguageGuardrailReport(
  surfaces: PublicLanguageSurface[]
): PublicLanguageGuardrailReport {
  const issues = surfaces.flatMap(validatePublicLanguageSurface);
  return {
    format: "matematica.public-language-guardrail",
    version: 1,
    ok: issues.length === 0,
    surfaceCount: surfaces.length,
    issues
  };
}

export function validatePublicLanguageSurface(surface: PublicLanguageSurface): PublicLanguageGuardrailIssue[] {
  const issues: PublicLanguageGuardrailIssue[] = [];
  const text = surface.text;
  const context = surface.context;
  const allowsSolved = allowsAffirmativeSolvedLanguage(context);

  if (!allowsSolved) {
    for (const pattern of AFFIRMATIVE_SOLVED_PATTERNS) {
      const match = text.match(pattern);
      if (match) {
        issues.push({
          surfaceId: surface.id,
          kind: surface.kind,
          code: "unsafe_affirmative_solved_claim",
          phrase: match[0],
          reason: "Public output must not use affirmative solved wording for conjectural, heuristic, budget-exhausted, open-problem, or computation-only evidence."
        });
      }
    }
  }

  if (isPublicTextSurface(surface.kind)) {
    for (const window of openProblemWindows(text)) {
      if (SOLVED_WORD.test(window) && !hasHonestyMarker(window)) {
        issues.push({
          surfaceId: surface.id,
          kind: surface.kind,
          code: "unsafe_open_problem_solved_wording",
          phrase: compact(window),
          reason: "Open-problem public language mentioning proof or solved status must also state the no-false-solved boundary."
        });
      }
    }
    if (OPEN_PROBLEM_TERMS.test(text) && !hasHonestyMarker(text)) {
      issues.push({
        surfaceId: surface.id,
        kind: surface.kind,
        code: "missing_open_problem_honesty_marker",
        reason: "Public open-problem wording must include a clear honesty marker such as budget_exhausted, useful progress, or formal proof/verified counterexample requirements."
      });
    }
  }

  return uniqueIssues(issues);
}

function isPublicTextSurface(kind: PublicLanguageSurfaceKind): boolean {
  return kind === "readme" ||
    kind === "cli-help" ||
    kind === "package-metadata" ||
    kind === "notice" ||
    kind === "license" ||
    kind === "docs" ||
    kind === "example" ||
    kind === "benchmark-summary";
}

function allowsAffirmativeSolvedLanguage(context: PublicLanguageContext | undefined): boolean {
  if (!context) return false;
  if (context.problemClass === "open_problem") {
    return context.evidenceGrade === "formal_proof";
  }
  if (context.finalState === "formal_proof" && context.evidenceGrade === "formal_proof") return true;
  if (
    context.finalState === "computational_evidence" &&
    context.evidenceGrade === "verified_computation" &&
    context.canClaimSolved === true
  ) {
    return true;
  }
  return false;
}

function openProblemWindows(text: string): string[] {
  const windows: string[] = [];
  const normalized = text.replace(/\s+/g, " ");
  for (const match of normalized.matchAll(new RegExp(OPEN_PROBLEM_TERMS.source, "gi"))) {
    const start = Math.max(0, match.index - 120);
    const end = Math.min(normalized.length, match.index + 220);
    windows.push(normalized.slice(start, end));
  }
  return windows;
}

function hasHonestyMarker(text: string): boolean {
  const normalized = text.toLowerCase();
  return HONESTY_MARKERS.some((marker) => normalized.includes(marker));
}

function compact(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 240);
}

function uniqueIssues(issues: PublicLanguageGuardrailIssue[]): PublicLanguageGuardrailIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.surfaceId}:${issue.code}:${issue.phrase ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
