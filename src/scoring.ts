import type { EvidenceGrade } from "./domain";
import type { ClaimType, FormalizationAssessment, VerifierStatus } from "./evidence";

export type EvidenceScoreDimensions = {
  statementEquivalence: number;
  proofValidity: number;
  sourceSupport: number;
  verifierTrust: number;
  noveltyRisk: number;
  counterexamplePressure: number;
  reproducibility: number;
};

export type EvidenceScoreInput = {
  evidenceGrade: EvidenceGrade;
  claimType: ClaimType;
  verifierStatus: VerifierStatus;
  verifierTrusted: boolean;
  formalizationStatus?: FormalizationAssessment["status"];
  sourceSupport?: "none" | "uncorroborated" | "cited" | "verified";
  counterexampleSearch?: "not_run" | "attempted" | "passed" | "found";
  reproducibility?: "none" | "partial" | "manifest" | "deterministic";
  modelAgreementOnly?: boolean;
};

export type EvidenceScore = {
  aggregate: number;
  confidenceClass: "low" | "medium" | "high";
  modelAgreementCeilingApplied: boolean;
  dimensions: EvidenceScoreDimensions;
  reasons: string[];
};

const MODEL_AGREEMENT_CEILING = 0.24;

export function scoreEvidence(input: EvidenceScoreInput): EvidenceScore {
  const dimensions: EvidenceScoreDimensions = {
    statementEquivalence: scoreStatementEquivalence(input),
    proofValidity: scoreProofValidity(input),
    sourceSupport: scoreSourceSupport(input.sourceSupport ?? "none"),
    verifierTrust: input.verifierTrusted ? 1 : 0,
    noveltyRisk: scoreNoveltyRisk(input),
    counterexamplePressure: scoreCounterexamplePressure(input.counterexampleSearch ?? "not_run"),
    reproducibility: scoreReproducibility(input.reproducibility ?? "none")
  };
  const reasons = explainScore(input, dimensions);
  let aggregate = weightedAggregate(dimensions);
  let modelAgreementCeilingApplied = false;
  if (input.modelAgreementOnly && aggregate > MODEL_AGREEMENT_CEILING) {
    aggregate = MODEL_AGREEMENT_CEILING;
    modelAgreementCeilingApplied = true;
    reasons.push("model agreement alone is capped below verifier-backed confidence");
  }

  return {
    aggregate,
    confidenceClass: aggregate >= 0.8 ? "high" : aggregate >= 0.5 ? "medium" : "low",
    modelAgreementCeilingApplied,
    dimensions,
    reasons
  };
}

function scoreStatementEquivalence(input: EvidenceScoreInput): number {
  if (input.claimType === "counterexample") return 1;
  if (input.formalizationStatus === "equivalent" || input.formalizationStatus === "not_required") return 1;
  if (input.formalizationStatus === "partial") return 0.35;
  if (input.formalizationStatus === "not_assessed" || input.formalizationStatus === undefined) return 0.2;
  return 0;
}

function scoreProofValidity(input: EvidenceScoreInput): number {
  if (input.verifierStatus === "verified") {
    if (input.evidenceGrade === "formal_proof" || input.evidenceGrade === "verified_computation" || input.evidenceGrade === "verified_counterexample") {
      return 1;
    }
    return 0.45;
  }
  if (input.verifierStatus === "failed") return 0;
  return input.modelAgreementOnly ? 0.2 : 0.1;
}

function scoreSourceSupport(sourceSupport: EvidenceScoreInput["sourceSupport"]): number {
  if (sourceSupport === "verified") return 1;
  if (sourceSupport === "cited") return 0.75;
  if (sourceSupport === "uncorroborated") return 0.25;
  return 0;
}

function scoreNoveltyRisk(input: EvidenceScoreInput): number {
  if (input.evidenceGrade === "formal_proof" || input.evidenceGrade === "verified_counterexample") return 0.9;
  if (input.evidenceGrade === "verified_computation") return 0.75;
  if (input.evidenceGrade === "literature_backed_reduction") return 0.6;
  if (input.modelAgreementOnly) return 0.15;
  return 0.3;
}

function scoreCounterexamplePressure(counterexampleSearch: EvidenceScoreInput["counterexampleSearch"]): number {
  if (counterexampleSearch === "found") return 0;
  if (counterexampleSearch === "passed") return 1;
  if (counterexampleSearch === "attempted") return 0.55;
  return 0.15;
}

function scoreReproducibility(reproducibility: EvidenceScoreInput["reproducibility"]): number {
  if (reproducibility === "deterministic") return 1;
  if (reproducibility === "manifest") return 0.8;
  if (reproducibility === "partial") return 0.4;
  return 0.1;
}

function weightedAggregate(dimensions: EvidenceScoreDimensions): number {
  return roundScore(
    dimensions.statementEquivalence * 0.2 +
    dimensions.proofValidity * 0.25 +
    dimensions.sourceSupport * 0.1 +
    dimensions.verifierTrust * 0.15 +
    dimensions.noveltyRisk * 0.1 +
    dimensions.counterexamplePressure * 0.1 +
    dimensions.reproducibility * 0.1
  );
}

function explainScore(input: EvidenceScoreInput, dimensions: EvidenceScoreDimensions): string[] {
  const reasons: string[] = [];
  if (dimensions.statementEquivalence < 1) reasons.push(`statement equivalence is not clean (${input.formalizationStatus ?? "not_assessed"})`);
  if (dimensions.proofValidity < 1) reasons.push(`proof validity is limited by verifier status ${input.verifierStatus}`);
  if (!input.verifierTrusted) reasons.push("verifier is not trusted");
  if ((input.sourceSupport ?? "none") !== "verified") reasons.push(`source support is ${input.sourceSupport ?? "none"}`);
  if ((input.counterexampleSearch ?? "not_run") !== "passed") reasons.push(`counterexample pressure is ${input.counterexampleSearch ?? "not_run"}`);
  if ((input.reproducibility ?? "none") !== "deterministic") reasons.push(`reproducibility is ${input.reproducibility ?? "none"}`);
  if (input.evidenceGrade === "conjectural_solution" || input.evidenceGrade === "heuristic_evidence") {
    reasons.push(`${input.evidenceGrade} cannot be treated as solved mathematics`);
  }
  return reasons.length > 0 ? reasons : ["all conservative evidence dimensions are satisfied"];
}

function roundScore(value: number): number {
  return Math.round(value * 1000) / 1000;
}
