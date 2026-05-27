import type { EvidenceGrade, GoalRun, LedgerEvent } from "./domain";
import { classifyFinalOutcome, type FinalAnswerState } from "./outcome";
import { classificationForRun } from "./problem-classifier";

export type OutputTrustLabel =
  | "solved"
  | "not_solved"
  | "counterexample"
  | "computation_only"
  | "needs_human_review";

export type OutputTrustContract = {
  label: OutputTrustLabel;
  labelText: "solved" | "not solved" | "counterexample" | "computation only" | "needs human review";
  finalState: FinalAnswerState;
  evidenceGrade: EvidenceGrade;
  canClaimSolved: boolean;
  verifierIds: string[];
  limitations: string[];
  replayCommand: string;
  nextAction: string;
};

export function buildOutputTrustContract(input: {
  run: GoalRun;
  events: LedgerEvent[];
  replayCommand?: string;
  integrityOk?: boolean;
}): OutputTrustContract {
  const outcome = classifyFinalOutcome(input.run, input.events);
  const problemClassification = classificationForRun(input.run, input.events);
  const integrityOk = input.integrityOk ?? true;
  const label = integrityOk
    ? trustLabel(input.run.status, outcome.state, input.run.evidenceGrade)
    : "needs_human_review";
  const verifierIds = verifierIdsFromEvents(input.events);
  const limitations = limitationsFor({
    label,
    finalState: outcome.state,
    evidenceGrade: input.run.evidenceGrade,
    problemClass: problemClassification.class,
    hasVerifiers: verifierIds.length > 0,
    integrityOk
  });
  return {
    label,
    labelText: labelText(label),
    finalState: outcome.state,
    evidenceGrade: input.run.evidenceGrade,
    canClaimSolved: integrityOk ? outcome.canClaimSolved : false,
    verifierIds,
    limitations,
    replayCommand: input.replayCommand ?? followUpReplayCommand(input.run.id),
    nextAction: integrityOk
      ? nextActionFor(label, outcome.state)
      : "Run goal audit/replay and investigate ledger or artifact tampering before trusting this report."
  };
}

export function followUpReplayCommand(runId: string): string {
  return `matematica goal replay ${runId} --offline --verify-final`;
}

function trustLabel(
  status: GoalRun["status"],
  finalState: FinalAnswerState,
  evidenceGrade: EvidenceGrade
): OutputTrustLabel {
  if (status === "failed" && isHumanReviewState(finalState)) return "needs_human_review";
  if (finalState === "formal_proof" && evidenceGrade === "formal_proof") return "solved";
  if (finalState === "counterexample" || evidenceGrade === "verified_counterexample") return "counterexample";
  if (finalState === "computational_evidence" || evidenceGrade === "verified_computation") return "computation_only";
  if (isHumanReviewState(finalState)) return "needs_human_review";
  return "not_solved";
}

function labelText(label: OutputTrustLabel): OutputTrustContract["labelText"] {
  if (label === "not_solved") return "not solved";
  if (label === "computation_only") return "computation only";
  if (label === "needs_human_review") return "needs human review";
  return label;
}

function verifierIdsFromEvents(events: LedgerEvent[]): string[] {
  const ids = new Set<string>();
  for (const event of events) {
    const verifier = stringValue(event.payload.verifier) ?? stringValue(event.payload.verifierId);
    if (verifier) ids.add(verifier);
    const claim = event.payload.claim;
    if (isRecord(claim)) {
      const claimVerifier = stringValue(claim.verifierId);
      if (claimVerifier) ids.add(claimVerifier);
    }
  }
  return [...ids].sort();
}

function limitationsFor(input: {
  label: OutputTrustLabel;
  finalState: FinalAnswerState;
  evidenceGrade: EvidenceGrade;
  problemClass: string;
  hasVerifiers: boolean;
  integrityOk: boolean;
}): string[] {
  const limitations: string[] = [];
  if (!input.integrityOk) {
    limitations.push("Ledger or artifact audit failed; final-answer trust claims are disabled until replay integrity is restored.");
  }
  if (!input.hasVerifiers) limitations.push("No verifier completion events are recorded for this run.");
  if (input.label === "solved") {
    limitations.push("Solved claim depends on replaying the recorded verifier-backed formal evidence.");
  }
  if (input.label === "computation_only") {
    limitations.push("Computation-only evidence is not a general mathematical proof unless the goal is explicitly computational.");
    limitations.push("Do not phrase this as a theorem proof without a formal_proof outcome.");
  }
  if (input.label === "counterexample") {
    limitations.push("Counterexample evidence disproves the target statement; it is not a proof of the original claim.");
  }
  if (input.label === "not_solved") {
    limitations.push("The run ended without verifier-backed evidence that satisfies the goal.");
  }
  if (input.label === "needs_human_review") {
    limitations.push("The run contains unresolved or conjectural evidence that requires human mathematical review.");
  }
  if (input.problemClass === "open_problem" && input.label !== "solved" && input.label !== "counterexample") {
    limitations.push("Open-problem policy requires formal_proof or verified_counterexample before any solved claim.");
  }
  if (input.finalState === "budget_exhausted") {
    limitations.push("Budget was exhausted before the success policy accepted the evidence.");
  }
  if (input.finalState === "heuristic") {
    limitations.push("Heuristic evidence is exploratory only and cannot support a solved claim.");
  }
  if (input.finalState === "partial") {
    limitations.push("Partial progress does not satisfy the full original goal.");
  }
  if (input.finalState === "inconclusive") {
    limitations.push("The run is inconclusive and needs stronger evidence or more budget.");
  }
  if (input.evidenceGrade === "none" || input.evidenceGrade === "unsupported") {
    limitations.push(`Evidence grade ${input.evidenceGrade} cannot support a solved claim.`);
  }
  return [...new Set(limitations)];
}

function nextActionFor(label: OutputTrustLabel, finalState: FinalAnswerState): string {
  if (label === "solved") return "Replay the run and inspect the formal proof artifacts before publication.";
  if (label === "counterexample") return "Replay the run and inspect the counterexample validator before reporting the statement as disproved.";
  if (label === "computation_only") return "Replay the run; request a formal proof if the intended claim is a theorem.";
  if (label === "needs_human_review") return "Review the unresolved obligations and resume with more budget or stronger verifiers.";
  if (finalState === "budget_exhausted") return "Inspect the strongest failed branch and resume with a justified budget envelope.";
  return "Inspect the report and replay manifest before deciding whether to resume.";
}

function isHumanReviewState(finalState: FinalAnswerState): boolean {
  return finalState === "conjecture" ||
    finalState === "heuristic" ||
    finalState === "partial" ||
    finalState === "inconclusive";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
