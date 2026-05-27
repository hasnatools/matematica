import type { EvidenceGrade, GoalStatus } from "./domain";
import type { ProblemClassification } from "./problem-classifier";

export type SuccessSemanticState =
  | "proved"
  | "disproved"
  | "certified_computation"
  | "partial_progress"
  | "literature_reduction"
  | "conjecture"
  | "failed"
  | "budget_exhausted"
  | "needs_human_review";

export type RejectedSolvedClaimSource =
  | "prompt_assertion"
  | "model_consensus"
  | "citation_or_literature"
  | "numeric_experiment"
  | "informal_proof";

export type SuccessSemanticsDecision = {
  semanticState: SuccessSemanticState;
  canMarkGoalMet: boolean;
  canClaimSolved: boolean;
  reason: string;
};

export const SUCCESS_SEMANTICS_VERSION = 1;

export const SUCCESS_SEMANTIC_STATES: SuccessSemanticState[] = [
  "proved",
  "disproved",
  "certified_computation",
  "partial_progress",
  "literature_reduction",
  "conjecture",
  "failed",
  "budget_exhausted",
  "needs_human_review"
];

export const REJECTED_SOLVED_CLAIM_SOURCES: RejectedSolvedClaimSource[] = [
  "prompt_assertion",
  "model_consensus",
  "citation_or_literature",
  "numeric_experiment",
  "informal_proof"
];

export const SUCCESS_SEMANTICS_POLICY = {
  format: "matematica.success-semantics-policy",
  version: SUCCESS_SEMANTICS_VERSION,
  finalStates: SUCCESS_SEMANTIC_STATES,
  goalMetRequires: ["formal_proof", "verified_counterexample", "verified_computation"] as const,
  openProblemGoalMetRequires: ["formal_proof", "verified_counterexample"] as const,
  rejectedSolvedClaimSources: REJECTED_SOLVED_CLAIM_SOURCES,
  literatureCountsAs: "literature_reduction" as const,
  conjecturalCountsAs: "conjecture" as const,
  weakProgressCountsAs: "partial_progress" as const
};

export function canEvidenceMarkGoalMetUnderPolicy(
  classification: ProblemClassification,
  evidenceGrade: EvidenceGrade
): boolean {
  if (classification.class === "open_problem") {
    return evidenceGrade === "formal_proof" || evidenceGrade === "verified_counterexample";
  }
  return evidenceGrade === "formal_proof" ||
    evidenceGrade === "verified_counterexample" ||
    evidenceGrade === "verified_computation";
}

export function classifySuccessSemantics(input: {
  status?: GoalStatus;
  evidenceGrade: EvidenceGrade;
  problemClassification: ProblemClassification;
}): SuccessSemanticsDecision {
  if (input.status === "budget_exhausted" || input.evidenceGrade === "budget_exhausted") {
    return blocked("budget_exhausted", "The configured budget was exhausted before release-grade success evidence was accepted.");
  }
  if (input.status === "failed") {
    return blocked("failed", "The run failed before release-grade success evidence was accepted.");
  }
  if (input.status === "needs_human_review") {
    return blocked("needs_human_review", "The run requires human review before any solved or goal_met claim.");
  }
  if (input.evidenceGrade === "formal_proof") {
    return {
      semanticState: "proved",
      canMarkGoalMet: true,
      canClaimSolved: true,
      reason: "A machine-checkable formal proof may satisfy the goal."
    };
  }
  if (input.evidenceGrade === "verified_counterexample") {
    return {
      semanticState: "disproved",
      canMarkGoalMet: true,
      canClaimSolved: false,
      reason: "A verified counterexample may satisfy a counterexample goal, but it disproves the proposed statement."
    };
  }
  if (input.evidenceGrade === "verified_computation") {
    if (input.problemClassification.class === "open_problem") {
      return {
        semanticState: "partial_progress",
        canMarkGoalMet: false,
        canClaimSolved: false,
        reason: "Open-problem policy requires formal_proof or verified_counterexample; certified computation remains progress only."
      };
    }
    return {
      semanticState: "certified_computation",
      canMarkGoalMet: true,
      canClaimSolved: true,
      reason: "Exact certified computation may satisfy a standard computational goal."
    };
  }
  if (input.evidenceGrade === "literature_backed_reduction") {
    return blocked("literature_reduction", "Literature-backed reductions are research dossier evidence, not solved or goal_met evidence.");
  }
  if (input.evidenceGrade === "conjectural_solution") {
    return blocked("conjecture", "Conjectural solutions are saved as conjectures and cannot mark the goal solved.");
  }
  return blocked("partial_progress", `Evidence grade ${input.evidenceGrade} is weak progress and cannot mark the goal solved.`);
}

function blocked(semanticState: SuccessSemanticState, reason: string): SuccessSemanticsDecision {
  return {
    semanticState,
    canMarkGoalMet: false,
    canClaimSolved: false,
    reason
  };
}
