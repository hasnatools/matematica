import type { EvidenceGrade, GoalRun, LedgerEvent } from "./domain";

export type FinalAnswerState =
  | "formal_proof"
  | "counterexample"
  | "computational_evidence"
  | "conjecture"
  | "heuristic"
  | "partial"
  | "inconclusive"
  | "budget_exhausted"
  | "cancelled"
  | "failed";

export const ALLOWED_FINAL_ANSWER_STATES: FinalAnswerState[] = [
  "formal_proof",
  "counterexample",
  "computational_evidence",
  "conjecture",
  "heuristic",
  "partial",
  "inconclusive",
  "budget_exhausted",
  "cancelled",
  "failed"
];

export type FinalOutcome = {
  state: FinalAnswerState;
  canClaimSolved: boolean;
  reason: string;
};

export function classifyFinalOutcome(run: GoalRun, events: LedgerEvent[] = []): FinalOutcome {
  const terminalEvent = [...events].reverse().find((event) => event.type === "goal.completed" || event.type === "goal.failed");
  const disputedEquivalence = [...events].reverse().find((event) =>
    event.type === "theorem.equivalence.reviewed" &&
    (event.payload.reviewerDisagreement === true || hasStatementDiffs(event.payload.statementDiffs))
  );
  if (disputedEquivalence && run.status !== "goal_met") {
    return {
      state: "partial",
      canClaimSolved: false,
      reason: "The theorem-equivalence review has reviewer disagreement or unresolved statement diffs."
    };
  }
  const persistedState = parseFinalState(terminalEvent?.payload.finalState, run.evidenceGrade);
  if (persistedState) {
    const fallbackReason = defaultReason(persistedState, run.evidenceGrade);
    const terminalReason = stringValue(terminalEvent?.payload.reason);
    return {
      state: persistedState,
      canClaimSolved: run.status === "goal_met" && (persistedState === "formal_proof" || persistedState === "computational_evidence"),
      reason: terminalReason ? `${fallbackReason} Terminal reason: ${terminalReason}` : fallbackReason
    };
  }

  if (run.status === "goal_met") {
    return goalMetOutcome(run.evidenceGrade);
  }
  if (run.status === "budget_exhausted") {
    return {
      state: "budget_exhausted",
      canClaimSolved: false,
      reason: "The configured budget was exhausted before verifier-backed success was established."
    };
  }
  if (run.status === "cancelled") {
    return {
      state: "cancelled",
      canClaimSolved: false,
      reason: "The run was cancelled before verifier-backed success was established."
    };
  }
  if (run.status === "needs_human_review") {
    return {
      state: "partial",
      canClaimSolved: false,
      reason: "The run reached a terminal human-review state before verifier-backed success was established."
    };
  }
  if (run.status === "failed") {
    return {
      state: "failed",
      canClaimSolved: false,
      reason: "The run failed before verifier-backed success was established."
    };
  }
  return {
    state: "inconclusive",
    canClaimSolved: false,
    reason: "The run is still in progress or has not produced terminal verifier-backed evidence."
  };
}

export function goalMetOutcome(evidenceGrade: EvidenceGrade): FinalOutcome {
  if (evidenceGrade === "verified_counterexample") {
    return {
      state: "counterexample",
      canClaimSolved: false,
      reason: "A verifier-backed counterexample was found; this disproves the proposed statement rather than proving it."
    };
  }
  if (evidenceGrade === "formal_proof") {
    return {
      state: "formal_proof",
      canClaimSolved: true,
      reason: "Verifier-backed evidence satisfies the goal."
    };
  }
  if (evidenceGrade === "verified_computation") {
    return {
      state: "computational_evidence",
      canClaimSolved: true,
      reason: "Verifier-backed computational evidence satisfies the goal."
    };
  }
  if (evidenceGrade === "conjectural_solution" || evidenceGrade === "literature_backed_reduction") {
    return {
      state: "partial",
      canClaimSolved: false,
      reason: "The run has an informal answer, but not verifier-backed proof."
    };
  }
  if (evidenceGrade === "heuristic_evidence") {
    return {
      state: "heuristic",
      canClaimSolved: false,
      reason: "The run has heuristic evidence only, not verifier-backed proof."
    };
  }
  if (evidenceGrade === "unsupported" || evidenceGrade === "none" || evidenceGrade === "budget_exhausted") {
    return {
      state: "inconclusive",
      canClaimSolved: false,
      reason: `Evidence grade ${evidenceGrade} is inconclusive.`
    };
  }
  if (evidenceGrade === "contradicted") {
    return {
      state: "counterexample",
      canClaimSolved: false,
      reason: "The available evidence contradicts the proposed statement."
    };
  }
  return {
    state: "inconclusive",
    canClaimSolved: false,
    reason: `Goal-met status has non-final evidence grade ${evidenceGrade}; human review is required.`
  };
}

export function parseFinalState(value: unknown, evidenceGrade?: EvidenceGrade): FinalAnswerState | undefined {
  if (
    value === "formal_proof" ||
    value === "counterexample" ||
    value === "computational_evidence" ||
    value === "conjecture" ||
    value === "heuristic" ||
    value === "partial" ||
    value === "inconclusive" ||
    value === "budget_exhausted" ||
    value === "cancelled" ||
    value === "failed"
  ) {
    return value;
  }
  if (value === "solved_verified") {
    return evidenceGrade === "formal_proof" ? "formal_proof" : "computational_evidence";
  }
  if (value === "disproved") return "counterexample";
  if (value === "solved_informal" || value === "promising_unverified") return "heuristic";
  if (value === "needs_human_review") return "inconclusive";
  return undefined;
}

function defaultReason(state: FinalAnswerState, evidenceGrade: EvidenceGrade): string {
  if (state === "formal_proof") return "Machine-checkable formal proof satisfies the goal.";
  if (state === "computational_evidence") return "Verifier-backed computational evidence satisfies the goal.";
  if (state === "counterexample") return "Verifier-backed evidence disproves the proposed statement.";
  if (state === "budget_exhausted") return "The configured budget was exhausted.";
  if (state === "cancelled") return "The run was cancelled.";
  if (state === "failed") return "The run failed.";
  if (state === "conjecture") return "An informal or unresolved answer exists, but verifier-backed proof is missing.";
  if (state === "heuristic") return "Only heuristic evidence is available.";
  if (state === "partial") return "Partial progress exists, but the original goal is not fully satisfied.";
  if (state === "inconclusive") return "The run is inconclusive.";
  return `Evidence grade ${evidenceGrade} requires human review.`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function hasStatementDiffs(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}
