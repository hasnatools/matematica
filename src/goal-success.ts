import type { EvidenceGrade, GoalRun, LedgerEvent } from "./domain";
import type { ClaimGraphDecision } from "./claim-graph";
import type { EvidenceDecision, FormalClaimContract } from "./evidence";
import { isVerifierBackedSuccessGrade } from "./evidence";
import {
  buildFinalClaimAcceptance,
  evaluateFinalOutcomeContract,
  type FinalClaimAcceptance,
  type ReviewerSignoff
} from "./goal-contract";
import { stableHash } from "./idempotency";
import { goalMetOutcome, type FinalAnswerState } from "./outcome";
import type { ProblemClassification } from "./problem-classifier";
import { canClaimSolvedForProblemClass } from "./problem-classifier";

export type GoalSuccessEvaluation = {
  status: "goal_met" | "not_met" | "needs_human_review";
  evidenceGrade: EvidenceGrade;
  finalState: FinalAnswerState;
  canClaimSolved: boolean;
  reason: string;
  satisfyingArtifactIds: string[];
  criteria: SuccessCriteriaEvaluation[];
  structuredContract: StructuredSuccessContract;
  problemClassification: ProblemClassification;
  claimId: string;
  verifierId: string;
  claimGraph?: ClaimGraphDecision;
  finalClaimAcceptance: FinalClaimAcceptance[];
  finalOutcomeContract: ReturnType<typeof evaluateFinalOutcomeContract>;
};

export type SuccessCriteriaEvaluation = {
  criterion: string;
  ok: boolean;
  reason: string;
  obligation: keyof StructuredSuccessContract | "gate";
};

export type StructuredSuccessContract = {
  format: "matematica.structured-success-contract";
  version: 1;
  sourceCriteria: string[];
  targetStatement?: string;
  normalizedTarget?: string;
  requiredEvidenceGrades: EvidenceGrade[];
  quantifiers: string[];
  allowedAssumptions: string[];
  requiresFormalizationEquivalence: boolean;
  requiresCounterexample: boolean;
  requiresVerifiedComputation: boolean;
};

export type GoalSuccessDecisionToken = {
  format: "matematica.goal-success-decision-token";
  version: 1;
  runId: string;
  eventId: string;
  eventHash: string;
  payloadHash: string;
  decisionHash: string;
  status: "goal_met";
  evidenceGrade: EvidenceGrade;
  claimId: string;
  verifierId: string;
  satisfyingArtifactIds: string[];
};

export function evaluateGoalSuccess(input: {
  run: GoalRun;
  claim: FormalClaimContract;
  gate: EvidenceDecision;
  problemClassification: ProblemClassification;
  candidateArtifactIds: string[];
  claimGraph?: ClaimGraphDecision;
  reviewerSignoff?: ReviewerSignoff;
}): GoalSuccessEvaluation {
  const satisfyingArtifactIds = uniqueStrings([
    ...input.candidateArtifactIds,
    ...input.gate.quorum.satisfiedBy.flatMap((item) => item.artifactIds)
  ]);
  const structuredContract = buildStructuredSuccessContract(input.run);
  const criteria = evaluateSuccessCriteria(structuredContract, input.claim, input.gate.canMarkGoalMet);
  const finalClaimAcceptance = [buildFinalClaimAcceptance({
    claim: input.claim,
    gateAccepted: input.gate.canMarkGoalMet,
    artifactIds: satisfyingArtifactIds,
    reviewerSignoff: input.reviewerSignoff
  })];
  const finalClaimRejected = finalClaimAcceptance.find((claim) => claim.status === "rejected");
  const finalClaimDowngraded = finalClaimAcceptance.find((claim) => claim.status === "downgraded_conjectural");
  const base = {
    evidenceGrade: input.claim.evidenceGrade,
    satisfyingArtifactIds,
    criteria,
    structuredContract,
    problemClassification: input.problemClassification,
    claimId: input.claim.id,
    verifierId: input.claim.verifierId,
    claimGraph: input.claimGraph,
    finalClaimAcceptance
  };

  if (input.claimGraph && (!input.claimGraph.ok || input.claimGraph.blockingClaimIds.includes(input.claim.id))) {
    return {
      ...base,
      status: "not_met",
      finalState: "inconclusive",
      canClaimSolved: false,
      reason: `Claim graph blocks target claim: ${input.claimGraph.reason}`,
      finalOutcomeContract: evaluateFinalOutcomeContract({
        finalState: "inconclusive",
        canClaimSolved: false,
        finalClaims: finalClaimAcceptance,
        reason: `Claim graph blocks target claim: ${input.claimGraph.reason}`
      })
    };
  }

  if (finalClaimRejected) {
    const reason = finalClaimRejected.reason;
    return {
      ...base,
      status: "not_met",
      finalState: "inconclusive",
      canClaimSolved: false,
      reason,
      finalOutcomeContract: evaluateFinalOutcomeContract({
        finalState: "inconclusive",
        canClaimSolved: false,
        finalClaims: finalClaimAcceptance,
        reason
      })
    };
  }

  if (finalClaimDowngraded) {
    const reason = finalClaimDowngraded.reason;
    return {
      ...base,
      status: "needs_human_review",
      finalState: "conjecture",
      canClaimSolved: false,
      reason,
      finalOutcomeContract: evaluateFinalOutcomeContract({
        finalState: "conjecture",
        canClaimSolved: false,
        finalClaims: finalClaimAcceptance,
        reason
      })
    };
  }

  if (!input.gate.canMarkGoalMet) {
    const reason = input.gate.reason;
    return {
      ...base,
      status: "not_met",
      finalState: "inconclusive",
      canClaimSolved: false,
      reason,
      finalOutcomeContract: evaluateFinalOutcomeContract({
        finalState: "inconclusive",
        canClaimSolved: false,
        finalClaims: finalClaimAcceptance,
        reason
      })
    };
  }

  const failedCriterion = criteria.find((criterion) => !criterion.ok);
  if (failedCriterion) {
    const reason = `Success criterion not satisfied: ${failedCriterion.reason}`;
    return {
      ...base,
      status: "needs_human_review",
      finalState: "partial",
      canClaimSolved: false,
      reason,
      finalOutcomeContract: evaluateFinalOutcomeContract({
        finalState: "partial",
        canClaimSolved: false,
        finalClaims: finalClaimAcceptance,
        reason
      })
    };
  }

  if (!canClaimSolvedForProblemClass(input.problemClassification, input.claim.evidenceGrade)) {
    const reason = `Open-problem policy requires formal_proof or verified_counterexample; ${input.claim.evidenceGrade} is not enough to claim solved.`;
    return {
      ...base,
      status: "needs_human_review",
      finalState: "partial",
      canClaimSolved: false,
      reason,
      finalOutcomeContract: evaluateFinalOutcomeContract({
        finalState: "partial",
        canClaimSolved: false,
        finalClaims: finalClaimAcceptance,
        reason
      })
    };
  }

  const outcome = goalMetOutcome(input.claim.evidenceGrade);
  return {
    ...base,
    status: "goal_met",
    finalState: outcome.state,
    canClaimSolved: outcome.canClaimSolved,
    reason: input.gate.reason,
    finalOutcomeContract: evaluateFinalOutcomeContract({
      finalState: outcome.state,
      canClaimSolved: outcome.canClaimSolved,
      finalClaims: finalClaimAcceptance,
      reason: input.gate.reason
    })
  };
}

export function evaluateSuccessCriteria(
  contract: StructuredSuccessContract,
  claim: FormalClaimContract,
  gateAccepted: boolean
): SuccessCriteriaEvaluation[] {
  const criteria = contract.sourceCriteria.length > 0
    ? contract.sourceCriteria
    : ["Produce verifier-backed evidence or exhaust the configured budget."];
  const evaluations = criteria.map((criterion) => evaluateEvidenceCriterion(criterion, contract, claim, gateAccepted));
  evaluations.push(...evaluateStructuredObligations(contract, claim));
  return evaluations;
}

export function buildGoalSuccessDecisionToken(input: {
  runId: string;
  event: LedgerEvent;
}): GoalSuccessDecisionToken {
  if (input.event.runId !== input.runId) {
    throw new Error("GoalSuccessDecision event belongs to a different run.");
  }
  if (input.event.type !== "goal.success.evaluated") {
    throw new Error("GoalSuccessDecision token must be built from a goal.success.evaluated event.");
  }
  if (input.event.payload.status !== "goal_met") {
    throw new Error("GoalSuccessDecision token requires a goal_met evaluation.");
  }
  if (typeof input.event.payload.evidenceGrade !== "string") {
    throw new Error("GoalSuccessDecision event is missing evidenceGrade.");
  }
  if (typeof input.event.payload.claimId !== "string") {
    throw new Error("GoalSuccessDecision event is missing claimId.");
  }
  if (typeof input.event.payload.verifierId !== "string") {
    throw new Error("GoalSuccessDecision event is missing verifierId.");
  }
  if (!Array.isArray(input.event.payload.satisfyingArtifactIds)) {
    throw new Error("GoalSuccessDecision event is missing satisfyingArtifactIds.");
  }
  if (!input.event.eventHash || !input.event.payloadHash) {
    throw new Error("GoalSuccessDecision event is missing ledger integrity hashes.");
  }

  return {
    format: "matematica.goal-success-decision-token",
    version: 1,
    runId: input.runId,
    eventId: input.event.id,
    eventHash: input.event.eventHash,
    payloadHash: input.event.payloadHash,
    decisionHash: goalSuccessDecisionHash(input.event.payload),
    status: "goal_met",
    evidenceGrade: input.event.payload.evidenceGrade as EvidenceGrade,
    claimId: input.event.payload.claimId,
    verifierId: input.event.payload.verifierId,
    satisfyingArtifactIds: uniqueStrings(input.event.payload.satisfyingArtifactIds.filter((value) => typeof value === "string"))
  };
}

export function goalSuccessDecisionHash(value: unknown): string {
  return stableHash(goalSuccessComparable(value));
}

export function goalSuccessComparable(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return {
    status: value.status,
    evidenceGrade: value.evidenceGrade,
    finalState: value.finalState,
    canClaimSolved: value.canClaimSolved,
    reason: value.reason,
    satisfyingArtifactIds: value.satisfyingArtifactIds,
    criteria: value.criteria,
    structuredContract: value.structuredContract,
    problemClassification: value.problemClassification,
    claimId: value.claimId,
    verifierId: value.verifierId,
    claimGraph: value.claimGraph,
    finalClaimAcceptance: value.finalClaimAcceptance,
    finalOutcomeContract: value.finalOutcomeContract
  };
}

export function buildStructuredSuccessContract(run: GoalRun): StructuredSuccessContract {
  const sourceCriteria = run.successCriteria.length > 0
    ? run.successCriteria
    : ["Produce verifier-backed evidence or exhaust the configured budget."];
  const text = `${run.problem}\n${run.goal}\n${sourceCriteria.join("\n")}`;
  const normalizedText = normalizeMathText(text);
  const targetStatement = extractTargetStatement(run.problem);
  const requiredEvidenceGrades = requiredEvidenceGradesForText(normalizedText);
  return {
    format: "matematica.structured-success-contract",
    version: 1,
    sourceCriteria,
    targetStatement,
    normalizedTarget: targetStatement ? normalizeMathText(targetStatement) : undefined,
    requiredEvidenceGrades,
    quantifiers: targetStatement ? extractQuantifiers(targetStatement) : [],
    allowedAssumptions: extractAllowedAssumptions(text),
    requiresFormalizationEquivalence: /\b(formal|lean|machine\s*checked)\b/.test(normalizedText),
    requiresCounterexample: /\bcounterexample\b/.test(normalizedText),
    requiresVerifiedComputation: /\b(comput|calculat|numeric|arithmetic)\w*\b/.test(normalizedText)
  };
}

function evaluateEvidenceCriterion(
  criterion: string,
  contract: StructuredSuccessContract,
  claim: FormalClaimContract,
  gateAccepted: boolean
): SuccessCriteriaEvaluation {
  const normalized = criterion.toLowerCase();
  if (/(formal|lean|machine[-\s]?checked)/.test(normalized) && claim.evidenceGrade !== "formal_proof") {
    return { criterion, ok: false, reason: `"${criterion}" requires formal_proof evidence, got ${claim.evidenceGrade}.`, obligation: "requiredEvidenceGrades" };
  }
  if (/counterexample/.test(normalized) && claim.evidenceGrade !== "verified_counterexample") {
    return { criterion, ok: false, reason: `"${criterion}" requires verified_counterexample evidence, got ${claim.evidenceGrade}.`, obligation: "requiresCounterexample" };
  }
  if (/(comput|calculat|numeric)/.test(normalized) && claim.evidenceGrade !== "verified_computation" && claim.evidenceGrade !== "formal_proof") {
    return { criterion, ok: false, reason: `"${criterion}" requires verified computation or formal proof evidence, got ${claim.evidenceGrade}.`, obligation: "requiresVerifiedComputation" };
  }
  if (/(verifier|verified|proof|prove|solve|answer|evidence)/.test(normalized) && (!gateAccepted || !isVerifierBackedSuccessGrade(claim.evidenceGrade))) {
    return { criterion, ok: false, reason: `"${criterion}" requires verifier-backed success evidence, got ${claim.evidenceGrade}.`, obligation: "gate" };
  }
  if (contract.requiredEvidenceGrades.length > 0 && !contract.requiredEvidenceGrades.includes(claim.evidenceGrade)) {
    return {
      criterion,
      ok: false,
      reason: `"${criterion}" requires one of ${contract.requiredEvidenceGrades.join(", ")}, got ${claim.evidenceGrade}.`,
      obligation: "requiredEvidenceGrades"
    };
  }
  return { criterion, ok: true, reason: "criterion is compatible with verifier-backed evidence.", obligation: "gate" };
}

function evaluateStructuredObligations(
  contract: StructuredSuccessContract,
  claim: FormalClaimContract
): SuccessCriteriaEvaluation[] {
  const evaluations: SuccessCriteriaEvaluation[] = [];
  if (contract.normalizedTarget) {
    const normalizedConclusion = normalizeMathText(claim.conclusion);
    const targetCovered = normalizedConclusion.includes(contract.normalizedTarget) ||
      contract.normalizedTarget.includes(normalizedConclusion);
    evaluations.push({
      criterion: "structured target statement",
      ok: targetCovered,
      reason: targetCovered
        ? "claim conclusion covers the target statement"
        : `claim conclusion "${claim.conclusion}" does not match target "${contract.targetStatement}".`,
      obligation: "targetStatement"
    });
  }
  for (const quantifier of contract.quantifiers) {
    const conclusionQuantifiers = extractQuantifiers(claim.conclusion);
    const ok = conclusionQuantifiers.includes(quantifier);
    evaluations.push({
      criterion: `structured quantifier ${quantifier}`,
      ok,
      reason: ok
        ? `claim preserves required quantifier ${quantifier}`
        : `claim conclusion is missing required quantifier ${quantifier}.`,
      obligation: "quantifiers"
    });
  }
  const hiddenAssumptions = claim.assumptions.filter((assumption) =>
    !contract.allowedAssumptions.some((allowed) => normalizeMathText(assumption) === normalizeMathText(allowed))
  );
  evaluations.push({
    criterion: "structured assumptions",
    ok: hiddenAssumptions.length === 0,
    reason: hiddenAssumptions.length === 0
      ? "claim introduces no hidden assumptions"
      : `claim introduces hidden assumptions: ${hiddenAssumptions.join("; ")}`,
    obligation: "allowedAssumptions"
  });
  if (contract.requiresCounterexample) {
    evaluations.push({
      criterion: "structured counterexample evidence",
      ok: claim.evidenceGrade === "verified_counterexample",
      reason: claim.evidenceGrade === "verified_counterexample"
        ? "claim provides a verified counterexample"
        : `counterexample contract requires verified_counterexample, got ${claim.evidenceGrade}.`,
      obligation: "requiresCounterexample"
    });
  }
  if (contract.requiresVerifiedComputation) {
    evaluations.push({
      criterion: "structured computation evidence",
      ok: claim.evidenceGrade === "verified_computation" || claim.evidenceGrade === "formal_proof",
      reason: claim.evidenceGrade === "verified_computation" || claim.evidenceGrade === "formal_proof"
        ? "claim provides verified computation or stronger formal proof"
        : `computation contract requires verified_computation or formal_proof, got ${claim.evidenceGrade}.`,
      obligation: "requiresVerifiedComputation"
    });
  }
  return evaluations;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function requiredEvidenceGradesForText(normalizedText: string): EvidenceGrade[] {
  if (/\bcounterexample\b/.test(normalizedText)) return ["verified_counterexample"];
  if (/\b(formal|lean|machine\s*checked)\b/.test(normalizedText)) return ["formal_proof"];
  if (/\b(comput|calculat|numeric|arithmetic)\w*\b/.test(normalizedText)) return ["verified_computation", "formal_proof"];
  return [];
}

function extractTargetStatement(problem: string): string | undefined {
  const normalized = problem.trim().replace(/\s+/g, " ");
  const match = /^(?:prove|show|verify|compute|find a proof of|find verified computation for)\s+(.+?)(?:\.|$)/i.exec(normalized);
  return match?.[1]?.trim();
}

function extractQuantifiers(value: string): string[] {
  const normalized = normalizeMathText(value);
  const quantifiers: string[] = [];
  if (/\b(for all|forall|∀)\b/.test(normalized)) quantifiers.push("forall");
  if (/\b(there exists|exists|∃)\b/.test(normalized)) quantifiers.push("exists");
  return quantifiers;
}

function extractAllowedAssumptions(value: string): string[] {
  const assumptions: string[] = [];
  const pattern = /\b(?:assuming|given|under assumption(?:s)?(?: that)?)\s+([^.;\n]+)/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    assumptions.push(match[1].trim());
  }
  return assumptions;
}

function normalizeMathText(value: string): string {
  return value
    .toLowerCase()
    .replace(/^the\s+/, "")
    .replace(/\btheorem\s+\w+\s*:\s*/g, "")
    .replace(/[^a-z0-9∀∃=+\-*/^<>()\s:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
