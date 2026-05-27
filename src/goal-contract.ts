import { z } from "zod";
import type { EvidenceGrade, GoalRun, Workflow } from "./domain";
import { buildStructuredSuccessContract, type StructuredSuccessContract } from "./goal-success";
import type { ClaimType, FormalClaimContract } from "./evidence";
import type { ProblemClassification } from "./problem-classifier";
import { classifyProblem } from "./problem-classifier";
import { ALLOWED_FINAL_ANSWER_STATES, type FinalAnswerState } from "./outcome";

export const EvidenceGradeSchema = z.enum([
  "formal_proof",
  "verified_counterexample",
  "verified_computation",
  "literature_backed_reduction",
  "conjectural_solution",
  "heuristic_evidence",
  "unsupported",
  "contradicted",
  "budget_exhausted",
  "none"
] satisfies [EvidenceGrade, ...EvidenceGrade[]]);

export const WorkflowSchema = z.enum(["pflk", "gree"] satisfies [Workflow, ...Workflow[]]);

export const FinalAnswerStateSchema = z.enum(ALLOWED_FINAL_ANSWER_STATES as [FinalAnswerState, ...FinalAnswerState[]]);

export type GoalAnswerType =
  | "formal_proof"
  | "counterexample"
  | "verified_computation"
  | "heuristic"
  | "partial"
  | "inconclusive";

export const GoalAnswerTypeSchema = z.enum([
  "formal_proof",
  "counterexample",
  "verified_computation",
  "heuristic",
  "partial",
  "inconclusive"
] satisfies [GoalAnswerType, ...GoalAnswerType[]]);

export const MathematicalAssumptionSchema = z.object({
  id: z.string().min(1),
  statement: z.string().min(1),
  source: z.enum(["problem", "operator", "derived", "loophole"]),
  allowedForOriginalGoal: z.boolean()
});

export const SuccessPredicateSchema = z.object({
  format: z.literal("matematica.success-predicate"),
  version: z.literal(1),
  targetStatement: z.string().min(1).optional(),
  requiredEvidenceGrades: z.array(EvidenceGradeSchema),
  allowedAssumptionIds: z.array(z.string().min(1)),
  finalStates: z.array(FinalAnswerStateSchema),
  canClaimSolvedStates: z.array(z.enum(["formal_proof", "computational_evidence"]))
});

export const CandidateClaimSchema = z.object({
  id: z.string().min(1),
  claimType: z.enum([
    "conjecture",
    "proof_sketch",
    "lean_checked_theorem",
    "literature_backed_lemma",
    "numerical_evidence",
    "counterexample",
    "failed_attempt",
    "contradiction"
  ] satisfies [ClaimType, ...ClaimType[]]),
  conclusion: z.string().min(1),
  assumptions: z.array(z.string()),
  dependencies: z.array(z.string()),
  evidenceGrade: EvidenceGradeSchema,
  verifierId: z.string().min(1),
  verifierArtifactIds: z.array(z.string().min(1))
});

export const DependencyLemmaSchema = z.object({
  id: z.string().min(1),
  statement: z.string().min(1),
  dischargedByClaimId: z.string().min(1).optional(),
  requiredForClaimIds: z.array(z.string().min(1)),
  status: z.enum(["open", "verified", "rejected", "conjectural"])
});

export const CounterexampleContractSchema = z.object({
  claimId: z.string().min(1),
  validatorId: z.string().min(1),
  artifactIds: z.array(z.string().min(1)),
  status: z.enum(["verified_counterexample", "rejected", "not_found"])
});

export const ReviewerSignoffSchema = z.object({
  reviewerId: z.string().min(1),
  signedAt: z.string().min(1),
  reason: z.string().min(1)
});

export const FinalClaimAcceptanceSchema = z.object({
  finalClaimId: z.string().min(1),
  sourceClaimId: z.string().min(1),
  evidenceGrade: EvidenceGradeSchema,
  status: z.enum([
    "accepted_formal_proof",
    "accepted_computational_proof",
    "accepted_counterexample",
    "downgraded_conjectural",
    "rejected"
  ]),
  artifactIds: z.array(z.string().min(1)),
  canClaimSolved: z.boolean(),
  reviewerSignoff: ReviewerSignoffSchema.optional(),
  reason: z.string().min(1)
}).superRefine((value, ctx) => {
  if (value.status === "downgraded_conjectural" && !value.reviewerSignoff) {
    ctx.addIssue({
      code: "custom",
      path: ["reviewerSignoff"],
      message: "downgraded conjectural final claims require reviewer signoff"
    });
  }
  if (
    (value.status === "accepted_formal_proof" || value.status === "accepted_computational_proof") &&
    !value.canClaimSolved
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["canClaimSolved"],
      message: "accepted proof/computation final claims must be allowed to claim solved"
    });
  }
  if (value.status === "downgraded_conjectural" && value.canClaimSolved) {
    ctx.addIssue({
      code: "custom",
      path: ["canClaimSolved"],
      message: "downgraded conjectural final claims cannot claim solved"
    });
  }
});

export type FinalClaimAcceptance = z.infer<typeof FinalClaimAcceptanceSchema>;
export type ReviewerSignoff = z.infer<typeof ReviewerSignoffSchema>;

export const FinalOutcomeContractSchema = z.object({
  finalState: FinalAnswerStateSchema,
  canClaimSolved: z.boolean(),
  finalClaims: z.array(FinalClaimAcceptanceSchema),
  unsupportedClaimIds: z.array(z.string().min(1)),
  reason: z.string().min(1)
}).superRefine((value, ctx) => {
  const allClaimsAccepted = value.finalClaims.every((claim) =>
    claim.status === "accepted_formal_proof" ||
    claim.status === "accepted_computational_proof" ||
    claim.status === "accepted_counterexample"
  );
  if (value.canClaimSolved && !allClaimsAccepted) {
    ctx.addIssue({
      code: "custom",
      path: ["finalClaims"],
      message: "canClaimSolved requires every final claim to be accepted by proof, computation, or counterexample evidence"
    });
  }
  if (value.canClaimSolved && value.unsupportedClaimIds.length > 0) {
    ctx.addIssue({
      code: "custom",
      path: ["unsupportedClaimIds"],
      message: "canClaimSolved requires zero unsupported final claims"
    });
  }
});

export type GoalContract = {
  format: "matematica.goal-contract";
  version: 1;
  problem: {
    normalizedStatement: string;
    goal: string;
    successCriteria: string[];
    classification: ProblemClassification;
    workflow: Workflow;
  };
  allowedAnswerTypes: GoalAnswerType[];
  proofStandard: {
    solvedRequires: ["formal_proof"];
    counterexampleRequires: ["verified_counterexample"];
    computationRequires: ["verified_computation"];
    openProblemSolvedRequires: ["formal_proof", "verified_counterexample"];
  };
  verifierPolicy: {
    independentVerifierRequired: true;
    modelSelfGradingCountsAs: "heuristic";
    literatureCountsAs: "partial";
  };
  claimAcceptance: {
    finalClaimRule: "every_final_claim_must_be_accepted_or_downgraded";
    acceptedSolvedStatuses: ["accepted_formal_proof", "accepted_computational_proof"];
    acceptedCounterexampleStatuses: ["accepted_counterexample"];
    conjecturalRequiresReviewerSignoff: true;
    unsupportedClaimsBlockSolved: true;
  };
  successContract: StructuredSuccessContract;
  successPredicate: z.infer<typeof SuccessPredicateSchema>;
  finalStates: FinalAnswerState[];
  stopConditions: Array<"goal_met" | "budget_exhausted" | "cancelled" | "failed" | "needs_human_review">;
};

export const MathematicalGoalContractSchema = z.object({
  format: z.literal("matematica.goal-contract"),
  version: z.literal(1),
  problem: z.object({
    normalizedStatement: z.string().min(1),
    goal: z.string().min(1),
    successCriteria: z.array(z.string().min(1)),
    classification: z.object({
      class: z.enum(["standard_problem", "open_problem", "unknown"]),
      triggers: z.array(z.string())
    }),
    workflow: WorkflowSchema
  }),
  allowedAnswerTypes: z.array(GoalAnswerTypeSchema),
  proofStandard: z.object({
    solvedRequires: z.tuple([z.literal("formal_proof")]),
    counterexampleRequires: z.tuple([z.literal("verified_counterexample")]),
    computationRequires: z.tuple([z.literal("verified_computation")]),
    openProblemSolvedRequires: z.tuple([z.literal("formal_proof"), z.literal("verified_counterexample")])
  }),
  verifierPolicy: z.object({
    independentVerifierRequired: z.literal(true),
    modelSelfGradingCountsAs: z.literal("heuristic"),
    literatureCountsAs: z.literal("partial")
  }),
  claimAcceptance: z.object({
    finalClaimRule: z.literal("every_final_claim_must_be_accepted_or_downgraded"),
    acceptedSolvedStatuses: z.tuple([z.literal("accepted_formal_proof"), z.literal("accepted_computational_proof")]),
    acceptedCounterexampleStatuses: z.tuple([z.literal("accepted_counterexample")]),
    conjecturalRequiresReviewerSignoff: z.literal(true),
    unsupportedClaimsBlockSolved: z.literal(true)
  }),
  successContract: z.object({
    format: z.literal("matematica.structured-success-contract"),
    version: z.literal(1)
  }).passthrough(),
  successPredicate: SuccessPredicateSchema,
  finalStates: z.array(FinalAnswerStateSchema),
  stopConditions: z.array(z.enum(["goal_met", "budget_exhausted", "cancelled", "failed", "needs_human_review"]))
});

export function buildGoalContract(run: GoalRun, classification = classifyProblem(run.problem, run.goal)): GoalContract {
  const successContract = buildStructuredSuccessContract(run);
  const contract: GoalContract = {
    format: "matematica.goal-contract",
    version: 1,
    problem: {
      normalizedStatement: normalizeStatement(run.problem),
      goal: run.goal,
      successCriteria: run.successCriteria,
      classification,
      workflow: run.workflow
    },
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
    claimAcceptance: {
      finalClaimRule: "every_final_claim_must_be_accepted_or_downgraded",
      acceptedSolvedStatuses: ["accepted_formal_proof", "accepted_computational_proof"],
      acceptedCounterexampleStatuses: ["accepted_counterexample"],
      conjecturalRequiresReviewerSignoff: true,
      unsupportedClaimsBlockSolved: true
    },
    successContract,
    successPredicate: {
      format: "matematica.success-predicate",
      version: 1,
      targetStatement: successContract.targetStatement,
      requiredEvidenceGrades: successContract.requiredEvidenceGrades,
      allowedAssumptionIds: successContract.allowedAssumptions.map((assumption) => assumptionId(assumption)),
      finalStates: ALLOWED_FINAL_ANSWER_STATES,
      canClaimSolvedStates: ["formal_proof", "computational_evidence"]
    },
    finalStates: ALLOWED_FINAL_ANSWER_STATES,
    stopConditions: ["goal_met", "budget_exhausted", "cancelled", "failed", "needs_human_review"]
  };
  return MathematicalGoalContractSchema.parse(contract) as GoalContract;
}

export function buildFinalClaimAcceptance(input: {
  claim: FormalClaimContract;
  gateAccepted: boolean;
  artifactIds: string[];
  reviewerSignoff?: ReviewerSignoff;
}): FinalClaimAcceptance {
  const artifactIds = [...new Set(input.artifactIds.filter((artifactId) => artifactId.length > 0))];
  const base = {
    finalClaimId: `final:${input.claim.id}`,
    sourceClaimId: input.claim.id,
    evidenceGrade: input.claim.evidenceGrade,
    artifactIds
  };
  if (input.gateAccepted && input.claim.evidenceGrade === "formal_proof") {
    return FinalClaimAcceptanceSchema.parse({
      ...base,
      status: "accepted_formal_proof",
      canClaimSolved: true,
      reason: "final claim maps to accepted formal proof evidence"
    });
  }
  if (input.gateAccepted && input.claim.evidenceGrade === "verified_computation") {
    return FinalClaimAcceptanceSchema.parse({
      ...base,
      status: "accepted_computational_proof",
      canClaimSolved: true,
      reason: "final claim maps to accepted verifier-backed computational proof evidence"
    });
  }
  if (input.gateAccepted && input.claim.evidenceGrade === "verified_counterexample") {
    return FinalClaimAcceptanceSchema.parse({
      ...base,
      status: "accepted_counterexample",
      canClaimSolved: false,
      reason: "final claim maps to an accepted verifier-backed counterexample"
    });
  }
  if (
    input.reviewerSignoff &&
    (input.claim.evidenceGrade === "conjectural_solution" || input.claim.evidenceGrade === "literature_backed_reduction")
  ) {
    return FinalClaimAcceptanceSchema.parse({
      ...base,
      status: "downgraded_conjectural",
      canClaimSolved: false,
      reviewerSignoff: input.reviewerSignoff,
      reason: "final claim is explicitly downgraded to conjectural evidence with reviewer signoff"
    });
  }
  return FinalClaimAcceptanceSchema.parse({
    ...base,
    status: "rejected",
    canClaimSolved: false,
    reason: `final claim is unsupported for terminal solved status: gateAccepted=${input.gateAccepted}, evidenceGrade=${input.claim.evidenceGrade}`
  });
}

export function evaluateFinalOutcomeContract(input: {
  finalState: FinalAnswerState;
  canClaimSolved: boolean;
  finalClaims: FinalClaimAcceptance[];
  reason: string;
}): z.infer<typeof FinalOutcomeContractSchema> {
  const unsupportedClaimIds = input.finalClaims
    .filter((claim) => claim.status === "rejected")
    .map((claim) => claim.sourceClaimId);
  return {
    ...FinalOutcomeContractSchema.parse({
      finalState: input.finalState,
      canClaimSolved: input.canClaimSolved,
      finalClaims: input.finalClaims,
      unsupportedClaimIds,
      reason: input.reason
    })
  };
}

function normalizeStatement(problem: string): string {
  return problem.trim().replace(/\s+/g, " ");
}

function assumptionId(statement: string): string {
  return statement.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "assumption";
}
