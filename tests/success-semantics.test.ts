import { expect, test } from "bun:test";
import {
  canEvidenceMarkGoalMetUnderPolicy,
  classifySuccessSemantics,
  REJECTED_SOLVED_CLAIM_SOURCES,
  SUCCESS_SEMANTICS_POLICY,
  SUCCESS_SEMANTIC_STATES
} from "../src/success-semantics";

test("formal success semantics define non-solved final states and rejected solved sources", () => {
  expect(SUCCESS_SEMANTIC_STATES).toEqual([
    "proved",
    "disproved",
    "certified_computation",
    "partial_progress",
    "literature_reduction",
    "conjecture",
    "failed",
    "budget_exhausted",
    "needs_human_review"
  ]);
  expect(SUCCESS_SEMANTIC_STATES.join(" ")).not.toContain("solved");
  expect(SUCCESS_SEMANTICS_POLICY.goalMetRequires).toEqual([
    "formal_proof",
    "verified_counterexample",
    "verified_computation"
  ]);
  expect(SUCCESS_SEMANTICS_POLICY.openProblemGoalMetRequires).toEqual([
    "formal_proof",
    "verified_counterexample"
  ]);
  expect(REJECTED_SOLVED_CLAIM_SOURCES).toEqual([
    "prompt_assertion",
    "model_consensus",
    "citation_or_literature",
    "numeric_experiment",
    "informal_proof"
  ]);
});

test("success semantics reject weak solved claims for standard and open problems", () => {
  const standard = { class: "standard_problem" as const, triggers: [] };
  const open = { class: "open_problem" as const, triggers: ["erdos"] };

  expect(canEvidenceMarkGoalMetUnderPolicy(standard, "formal_proof")).toBe(true);
  expect(canEvidenceMarkGoalMetUnderPolicy(standard, "verified_counterexample")).toBe(true);
  expect(canEvidenceMarkGoalMetUnderPolicy(standard, "verified_computation")).toBe(true);
  expect(canEvidenceMarkGoalMetUnderPolicy(standard, "literature_backed_reduction")).toBe(false);
  expect(canEvidenceMarkGoalMetUnderPolicy(standard, "conjectural_solution")).toBe(false);
  expect(canEvidenceMarkGoalMetUnderPolicy(standard, "heuristic_evidence")).toBe(false);

  expect(canEvidenceMarkGoalMetUnderPolicy(open, "formal_proof")).toBe(true);
  expect(canEvidenceMarkGoalMetUnderPolicy(open, "verified_counterexample")).toBe(true);
  expect(canEvidenceMarkGoalMetUnderPolicy(open, "verified_computation")).toBe(false);
});

test("success semantics classify open-problem computation as research progress only", () => {
  const open = { class: "open_problem" as const, triggers: ["collatz"] };

  expect(classifySuccessSemantics({
    evidenceGrade: "verified_computation",
    problemClassification: open
  })).toMatchObject({
    semanticState: "partial_progress",
    canMarkGoalMet: false,
    canClaimSolved: false
  });
  expect(classifySuccessSemantics({
    evidenceGrade: "literature_backed_reduction",
    problemClassification: open
  })).toMatchObject({
    semanticState: "literature_reduction",
    canMarkGoalMet: false,
    canClaimSolved: false
  });
  expect(classifySuccessSemantics({
    status: "needs_human_review",
    evidenceGrade: "formal_proof",
    problemClassification: open
  })).toMatchObject({
    semanticState: "needs_human_review",
    canMarkGoalMet: false,
    canClaimSolved: false
  });
});
