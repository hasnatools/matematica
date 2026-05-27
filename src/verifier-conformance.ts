import type { EvidenceDecision, EvidenceGateContext, FormalClaimContract } from "./evidence";
import { evaluateEvidenceGate } from "./evidence";
import { classifyLeanFailure, type LeanFailureKind } from "./lean";

export type VerifierConformanceFixtureId =
  | "valid_exact_formal_statement"
  | "lean_sorry"
  | "lean_admit"
  | "lean_axiom"
  | "unsafe_import"
  | "unpinned_mathlib"
  | "weakened_theorem"
  | "changed_quantifier"
  | "hidden_assumption"
  | "bogus_counterexample"
  | "formalization_gap"
  | "verifier_timeout";

export type VerifierConformanceFixture = {
  id: VerifierConformanceFixtureId;
  title: string;
  leanSource: string;
  expectedCanMarkGoalMet: boolean;
  expectedReasonIncludes: string;
  expectedLeanFailureKind?: LeanFailureKind;
};

export type LeanConformanceIssue = {
  code: "sorry" | "admit" | "axiom" | "unsafe_import";
  message: string;
};

export type VerifierConformanceEvaluation = {
  fixtureId: VerifierConformanceFixtureId;
  canMarkGoalMet: boolean;
  reason: string;
  leanIssues: LeanConformanceIssue[];
  leanFailureKind?: LeanFailureKind;
  evidenceDecision?: EvidenceDecision;
};

export const VERIFIER_CONFORMANCE_CORPUS: VerifierConformanceFixture[] = [
  {
    id: "valid_exact_formal_statement",
    title: "Exact theorem, pinned project, independent equivalence review",
    leanSource: "theorem one_plus_one : 1 + 1 = 2 := by norm_num",
    expectedCanMarkGoalMet: true,
    expectedReasonIncludes: "verifier-backed success"
  },
  {
    id: "lean_sorry",
    title: "Lean source contains sorry",
    leanSource: "theorem bad : True := by sorry",
    expectedCanMarkGoalMet: false,
    expectedReasonIncludes: "sorry",
    expectedLeanFailureKind: "tactic_failure"
  },
  {
    id: "lean_admit",
    title: "Lean source contains admit",
    leanSource: "theorem bad : True := by admit",
    expectedCanMarkGoalMet: false,
    expectedReasonIncludes: "admit",
    expectedLeanFailureKind: "tactic_failure"
  },
  {
    id: "lean_axiom",
    title: "Lean source introduces an axiom",
    leanSource: "axiom impossible : False\ntheorem bad : False := impossible",
    expectedCanMarkGoalMet: false,
    expectedReasonIncludes: "axiom"
  },
  {
    id: "unsafe_import",
    title: "Lean source imports unsafe/internal modules",
    leanSource: "import Lean\nunsafe def bad : Nat := 0\ntheorem ok : True := by trivial",
    expectedCanMarkGoalMet: false,
    expectedReasonIncludes: "unsafe"
  },
  {
    id: "unpinned_mathlib",
    title: "Lean result is from an unpinned Lake/mathlib project",
    leanSource: "import Mathlib\ntheorem one_plus_one : 1 + 1 = 2 := by norm_num",
    expectedCanMarkGoalMet: false,
    expectedReasonIncludes: "pinned"
  },
  {
    id: "weakened_theorem",
    title: "Formal theorem weakens the original theorem",
    leanSource: "theorem weak : 1 + 1 = 2 := by norm_num",
    expectedCanMarkGoalMet: false,
    expectedReasonIncludes: "weakened"
  },
  {
    id: "changed_quantifier",
    title: "Formal theorem changes the quantifier",
    leanSource: "theorem exists_case : Exists fun n : Nat => n = n := by exact Exists.intro 0 rfl",
    expectedCanMarkGoalMet: false,
    expectedReasonIncludes: "changed_quantifier"
  },
  {
    id: "hidden_assumption",
    title: "Formal theorem adds a hidden assumption",
    leanSource: "theorem with_hidden_assumption (h : True) : True := h",
    expectedCanMarkGoalMet: false,
    expectedReasonIncludes: "hidden_assumption"
  },
  {
    id: "bogus_counterexample",
    title: "Counterexample claim lacks independent validation",
    leanSource: "-- no Lean theorem; counterexample branch",
    expectedCanMarkGoalMet: false,
    expectedReasonIncludes: "counterexample"
  },
  {
    id: "formalization_gap",
    title: "Formalization is not equivalent to the original problem",
    leanSource: "theorem gap : True := by trivial",
    expectedCanMarkGoalMet: false,
    expectedReasonIncludes: "formalization"
  },
  {
    id: "verifier_timeout",
    title: "Verifier timeout cannot mark the goal met",
    leanSource: "theorem slow : True := by trivial",
    expectedCanMarkGoalMet: false,
    expectedReasonIncludes: "timeout",
    expectedLeanFailureKind: "timeout"
  }
];

export function scanLeanConformanceSource(source: string): LeanConformanceIssue[] {
  const issues: LeanConformanceIssue[] = [];
  if (/\bsorry\b/.test(source)) {
    issues.push({ code: "sorry", message: "Lean source contains sorry." });
  }
  if (/\badmit\b/.test(source)) {
    issues.push({ code: "admit", message: "Lean source contains admit." });
  }
  if (/^\s*axiom\s+/m.test(source)) {
    issues.push({ code: "axiom", message: "Lean source introduces an axiom." });
  }
  if (/^\s*unsafe\s+/m.test(source) || /^\s*import\s+(?:Lean|Std\.Internal|Init\.Prelude)/m.test(source)) {
    issues.push({ code: "unsafe_import", message: "Lean source uses unsafe declarations or unsafe/internal imports." });
  }
  return issues;
}

export function evaluateVerifierConformanceCase(input: {
  fixture: VerifierConformanceFixture;
  claim: FormalClaimContract;
  context: EvidenceGateContext;
  leanFailureOutput?: string;
}): VerifierConformanceEvaluation {
  const leanIssues = scanLeanConformanceSource(input.fixture.leanSource);
  const leanFailureKind = input.leanFailureOutput ? classifyLeanFailure(input.leanFailureOutput) : undefined;
  if (leanIssues.length > 0) {
    return {
      fixtureId: input.fixture.id,
      canMarkGoalMet: false,
      reason: leanIssues.map((issue) => issue.message).join(" "),
      leanIssues,
      leanFailureKind
    };
  }
  if (leanFailureKind) {
    return {
      fixtureId: input.fixture.id,
      canMarkGoalMet: false,
      reason: `Lean verifier failure kind ${leanFailureKind}`,
      leanIssues,
      leanFailureKind
    };
  }
  const evidenceDecision = evaluateEvidenceGate(input.claim, input.context);
  return {
    fixtureId: input.fixture.id,
    canMarkGoalMet: evidenceDecision.canMarkGoalMet,
    reason: evidenceDecision.reason,
    leanIssues,
    evidenceDecision
  };
}
