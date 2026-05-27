import { expect, test } from "bun:test";
import type { GoalRun } from "../src/domain";
import type { EvidenceDecision, FormalClaimContract } from "../src/evidence";
import {
  buildFinalClaimAcceptance,
  buildGoalContract,
  CandidateClaimSchema,
  CounterexampleContractSchema,
  DependencyLemmaSchema,
  evaluateFinalOutcomeContract,
  FinalClaimAcceptanceSchema,
  MathematicalAssumptionSchema,
  MathematicalGoalContractSchema,
  SuccessPredicateSchema
} from "../src/goal-contract";
import { evaluateGoalSuccess } from "../src/goal-success";

test("goal success evaluator returns exact satisfying artifact ids for accepted verified evidence", () => {
  const decision = evaluateGoalSuccess({
    run: runWithCriteria(["Produce verifier-backed evidence"]),
    claim: claimWithGrade("verified_computation"),
    gate: acceptedGate(["artifact-primary", "artifact-independent"]),
    problemClassification: { class: "standard_problem", triggers: [] },
    candidateArtifactIds: ["artifact-primary", "artifact-proof-obligations"]
  });

  expect(decision.status).toBe("goal_met");
  expect(decision.canClaimSolved).toBe(true);
  expect(decision.satisfyingArtifactIds).toEqual([
    "artifact-primary",
    "artifact-proof-obligations",
    "artifact-independent"
  ]);
  expect(decision.criteria.every((criterion) => criterion.ok)).toBe(true);
  expect(decision.finalClaimAcceptance).toEqual([
    expect.objectContaining({
      sourceClaimId: "claim-test",
      status: "accepted_computational_proof",
      canClaimSolved: true
    })
  ]);
  expect(decision.finalOutcomeContract.canClaimSolved).toBe(true);
});

test("goal success evaluator blocks criteria drift before terminal goal status", () => {
  const decision = evaluateGoalSuccess({
    run: runWithCriteria(["Produce a formal Lean proof"]),
    claim: claimWithGrade("verified_computation"),
    gate: acceptedGate(["artifact-primary", "artifact-independent"]),
    problemClassification: { class: "standard_problem", triggers: [] },
    candidateArtifactIds: ["artifact-primary"]
  });

  expect(decision.status).toBe("needs_human_review");
  expect(decision.finalState).toBe("partial");
  expect(decision.canClaimSolved).toBe(false);
  expect(decision.reason).toContain("requires formal_proof");
});

test("goal success evaluator applies stricter open-problem solve policy", () => {
  const decision = evaluateGoalSuccess({
    run: runWithCriteria(["Produce verifier-backed evidence"]),
    claim: claimWithGrade("verified_computation"),
    gate: acceptedGate(["artifact-primary", "artifact-independent"]),
    problemClassification: { class: "open_problem", triggers: ["erdos"] },
    candidateArtifactIds: ["artifact-primary"]
  });

  expect(decision.status).toBe("needs_human_review");
  expect(decision.finalState).toBe("partial");
  expect(decision.reason).toContain("Open-problem policy");
  expect(decision.finalClaimAcceptance[0].status).toBe("accepted_computational_proof");
  expect(decision.finalOutcomeContract.canClaimSolved).toBe(false);
});

test("structured success contract rejects nearby theorem conclusions", () => {
  const decision = evaluateGoalSuccess({
    run: {
      ...runWithCriteria(["Produce verifier-backed evidence"]),
      problem: "Prove 1 + 1 = 2"
    },
    claim: claimWithGrade("verified_computation", {
      conclusion: "The arithmetic identity 1 + 1 = 3 is verified by the local deterministic verifier."
    }),
    gate: acceptedGate(["artifact-primary", "artifact-independent"]),
    problemClassification: { class: "standard_problem", triggers: [] },
    candidateArtifactIds: ["artifact-primary"]
  });

  expect(decision.status).toBe("needs_human_review");
  expect(decision.criteria).toContainEqual(expect.objectContaining({
    obligation: "targetStatement",
    ok: false
  }));
  expect(decision.reason).toContain("target");
});

test("structured success contract rejects changed quantifiers", () => {
  const decision = evaluateGoalSuccess({
    run: {
      ...runWithCriteria(["Produce a formal Lean proof"]),
      problem: "Prove forall n : Nat, P n"
    },
    claim: claimWithGrade("formal_proof", {
      conclusion: "theorem only_zero : P 0"
    }),
    gate: acceptedGate(["artifact-primary", "artifact-independent"]),
    problemClassification: { class: "standard_problem", triggers: [] },
    candidateArtifactIds: ["artifact-primary"]
  });

  expect(decision.status).toBe("needs_human_review");
  expect(decision.criteria).toContainEqual(expect.objectContaining({
    obligation: "quantifiers",
    ok: false
  }));
});

test("structured success contract rejects hidden assumptions", () => {
  const decision = evaluateGoalSuccess({
    run: {
      ...runWithCriteria(["Produce verifier-backed evidence"]),
      problem: "Prove P n"
    },
    claim: claimWithGrade("formal_proof", {
      conclusion: "theorem hidden : P n",
      assumptions: ["n > 0"]
    }),
    gate: acceptedGate(["artifact-primary", "artifact-independent"]),
    problemClassification: { class: "standard_problem", triggers: [] },
    candidateArtifactIds: ["artifact-primary"]
  });

  expect(decision.status).toBe("needs_human_review");
  expect(decision.criteria).toContainEqual(expect.objectContaining({
    obligation: "allowedAssumptions",
    ok: false
  }));
});

test("goal contract pins answer types proof standard verifier policy and stop states", () => {
  const contract = buildGoalContract(runWithCriteria(["Produce verifier-backed evidence"]), {
    class: "open_problem",
    triggers: ["erdos"]
  });

  expect(contract).toMatchObject({
    format: "matematica.goal-contract",
    version: 1,
    allowedAnswerTypes: [
      "formal_proof",
      "counterexample",
      "verified_computation",
      "heuristic",
      "partial",
      "inconclusive"
    ],
    proofStandard: {
      solvedRequires: ["formal_proof"],
      counterexampleRequires: ["verified_counterexample"],
      computationRequires: ["verified_computation"],
      openProblemSolvedRequires: ["formal_proof", "verified_counterexample"]
    },
    verifierPolicy: {
      independentVerifierRequired: true,
      modelSelfGradingCountsAs: "heuristic",
      literatureCountsAs: "partial"
    },
    successContract: {
      format: "matematica.structured-success-contract",
      version: 1,
      requiredEvidenceGrades: ["verified_computation", "formal_proof"]
    },
    stopConditions: ["goal_met", "budget_exhausted", "cancelled", "failed", "needs_human_review"]
  });
  expect(contract.finalStates).toContain("heuristic");
  expect(contract.finalStates).toContain("partial");
  expect(contract.finalStates).toContain("inconclusive");
  expect(contract.claimAcceptance).toMatchObject({
    finalClaimRule: "every_final_claim_must_be_accepted_or_downgraded",
    conjecturalRequiresReviewerSignoff: true,
    unsupportedClaimsBlockSolved: true
  });
  expect(() => MathematicalGoalContractSchema.parse(contract)).not.toThrow();
  expect(() => SuccessPredicateSchema.parse(contract.successPredicate)).not.toThrow();
});

test("zod contracts validate assumptions claims lemmas counterexamples and final outcomes", () => {
  const assumption = MathematicalAssumptionSchema.parse({
    id: "assumption-problem",
    statement: "n is a natural number",
    source: "problem",
    allowedForOriginalGoal: true
  });
  const claim = CandidateClaimSchema.parse(claimWithGrade("formal_proof"));
  const lemma = DependencyLemmaSchema.parse({
    id: "lemma-1",
    statement: "1 + 1 = 2",
    dischargedByClaimId: claim.id,
    requiredForClaimIds: [claim.id],
    status: "verified"
  });
  const counterexample = CounterexampleContractSchema.parse({
    claimId: claim.id,
    validatorId: "validator-independent",
    artifactIds: ["artifact-counterexample"],
    status: "not_found"
  });
  const finalClaim = buildFinalClaimAcceptance({
    claim: claimWithGrade("formal_proof"),
    gateAccepted: true,
    artifactIds: ["artifact-primary"]
  });
  const finalOutcome = evaluateFinalOutcomeContract({
    finalState: "formal_proof",
    canClaimSolved: true,
    finalClaims: [finalClaim],
    reason: "accepted formal proof"
  });

  expect(assumption.allowedForOriginalGoal).toBe(true);
  expect(lemma.status).toBe("verified");
  expect(counterexample.status).toBe("not_found");
  expect(finalOutcome.canClaimSolved).toBe(true);
  expect(finalOutcome.unsupportedClaimIds).toEqual([]);
});

test("final claim acceptance downgrades conjectural claims only with reviewer signoff", () => {
  expect(() => FinalClaimAcceptanceSchema.parse({
    finalClaimId: "final:claim-conjecture",
    sourceClaimId: "claim-conjecture",
    evidenceGrade: "conjectural_solution",
    status: "downgraded_conjectural",
    artifactIds: ["artifact-note"],
    canClaimSolved: false,
    reason: "missing signoff"
  })).toThrow();

  const acceptance = buildFinalClaimAcceptance({
    claim: claimWithGrade("conjectural_solution"),
    gateAccepted: false,
    artifactIds: ["artifact-note"],
    reviewerSignoff: {
      reviewerId: "human-reviewer",
      signedAt: "2026-05-25T00:00:00.000Z",
      reason: "explicitly downgraded; not a solved claim"
    }
  });

  expect(acceptance).toMatchObject({
    status: "downgraded_conjectural",
    canClaimSolved: false,
    reviewerSignoff: {
      reviewerId: "human-reviewer"
    }
  });
  expect(() => evaluateFinalOutcomeContract({
    finalState: "conjecture",
    canClaimSolved: true,
    finalClaims: [acceptance],
    reason: "attempted solved claim from downgraded conjecture"
  })).toThrow();
});

test("goal success blocks unsupported final claims before terminal solved status", () => {
  const decision = evaluateGoalSuccess({
    run: runWithCriteria(["Produce verifier-backed evidence"]),
    claim: claimWithGrade("heuristic_evidence"),
    gate: acceptedGate(["artifact-primary"]),
    problemClassification: { class: "standard_problem", triggers: [] },
    candidateArtifactIds: ["artifact-primary"]
  });

  expect(decision.status).toBe("not_met");
  expect(decision.canClaimSolved).toBe(false);
  expect(decision.finalClaimAcceptance[0]).toMatchObject({
    status: "rejected",
    canClaimSolved: false
  });
  expect(decision.finalOutcomeContract.unsupportedClaimIds).toEqual(["claim-test"]);
});

function runWithCriteria(successCriteria: string[]): GoalRun {
  return {
    id: "run-test",
    problem: "Prove 1 + 1 = 2",
    goal: "Find verified computation",
    successCriteria,
    workflow: "pflk",
    budget: { maxAttempts: 1 },
    status: "running",
    evidenceGrade: "none",
    createdAt: "2026-05-25T00:00:00.000Z",
    updatedAt: "2026-05-25T00:00:00.000Z"
  };
}

function claimWithGrade(
  evidenceGrade: FormalClaimContract["evidenceGrade"],
  overrides: Partial<Pick<FormalClaimContract, "assumptions" | "conclusion">> = {}
): FormalClaimContract {
  return {
    id: "claim-test",
    claimType: claimTypeForGrade(evidenceGrade),
    verifierId: evidenceGrade === "formal_proof" ? "lean4" : "local-deterministic-v0",
    assumptions: overrides.assumptions ?? [],
    conclusion: overrides.conclusion ?? "1 + 1 = 2",
    dependencies: [],
    verifierStatus: "verified",
    evidenceGrade,
    verifierArtifactIds: ["artifact-primary"]
  };
}

function claimTypeForGrade(evidenceGrade: FormalClaimContract["evidenceGrade"]): FormalClaimContract["claimType"] {
  if (evidenceGrade === "formal_proof") return "lean_checked_theorem";
  if (evidenceGrade === "verified_counterexample") return "counterexample";
  if (evidenceGrade === "conjectural_solution") return "conjecture";
  if (evidenceGrade === "literature_backed_reduction") return "literature_backed_lemma";
  if (evidenceGrade === "heuristic_evidence") return "proof_sketch";
  return "numerical_evidence";
}

function acceptedGate(artifactIds: string[]): EvidenceDecision {
  return {
    canMarkGoalMet: true,
    reason: "verifier-backed success with independent quorum",
    quorum: {
      required: ["primary_verifier"],
      satisfiedBy: [{
        verifierId: "local-deterministic-v0",
        role: "primary_verifier",
        artifactIds,
        artifactHashes: artifactIds.map((id) => `hash-${id}`)
      }],
      disagreements: []
    }
  };
}
