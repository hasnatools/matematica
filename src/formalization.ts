import type { ArtifactStore } from "./artifacts";
import type { Ledger } from "./ledger";
import { classifyFormalizationGap, type FormalEquivalenceAuditBundle, type FormalizationAssessment, type FormalizationGapClassification, type TheoremEquivalenceReview } from "./evidence";
import { stableHash } from "./idempotency";

export type FormalizationReviewInput = {
  informalProblem: string;
  formalStatement: string;
  assumptions: string[];
  definitions: string[];
  scopeChanges: string[];
  knownGaps: string[];
  missingDefinitions?: string[];
  missingLemmas?: string[];
  missingAssumptions?: string[];
  status: FormalizationAssessment["status"];
  reviewer: string;
  normalizedStatement?: string;
  conclusion?: string;
  ambiguityNotes?: string[];
  statementDiffs?: string[];
  reviewerDisagreement?: boolean;
};

export type RecordedFormalizationAssessment = FormalizationAssessment & {
  artifactId: string;
};

export function recordFormalizationAssessment(
  runId: string,
  ledger: Ledger,
  artifacts: ArtifactStore,
  input: FormalizationReviewInput
): RecordedFormalizationAssessment {
  const equivalenceReview = buildEquivalenceReview(input);
  const gap = classifyFormalizationGap({
    status: input.status,
    equivalenceReview,
    knownGaps: input.knownGaps,
    missingDefinitions: input.missingDefinitions,
    missingLemmas: input.missingLemmas,
    missingAssumptions: input.missingAssumptions,
    scopeChanges: input.scopeChanges,
    statementDiffs: input.statementDiffs ?? [],
    ambiguityNotes: input.ambiguityNotes ?? []
  });
  const equivalenceAuditBundle = equivalenceReview
    ? buildEquivalenceAuditBundle({
        status: input.status,
        equivalenceReview,
        gap,
        reviewerIndependent: input.reviewer !== "lean4"
      })
    : undefined;
  const artifact = artifacts.create(runId, "formalization.assessment", JSON.stringify({
    informalProblem: input.informalProblem,
    normalizedStatement: input.normalizedStatement,
    formalStatement: input.formalStatement,
    assumptions: input.assumptions,
    definitions: input.definitions,
    missingDefinitions: gap.missingDefinitions,
    missingLemmas: gap.missingLemmas,
    missingAssumptions: gap.missingAssumptions,
    conclusion: input.conclusion,
    scopeChanges: input.scopeChanges,
    knownGaps: input.knownGaps,
    ambiguityNotes: input.ambiguityNotes ?? [],
    statementDiffs: input.statementDiffs ?? [],
    reviewerDisagreement: input.reviewerDisagreement ?? false,
    status: input.status,
    reviewer: input.reviewer,
    equivalenceReview,
    equivalenceAuditBundle,
    gap
  }, null, 2));
  const persistedBundle = equivalenceAuditBundle
    ? withPersistedBundleMetadata(equivalenceAuditBundle, artifact.id)
    : undefined;

  ledger.appendEvent(runId, "formalization.assessed", {
    status: input.status,
    reviewer: input.reviewer,
    normalizedStatement: input.normalizedStatement,
    formalStatement: input.formalStatement,
    assumptions: input.assumptions,
    conclusion: input.conclusion,
    missingDefinitions: gap.missingDefinitions,
    missingLemmas: gap.missingLemmas,
    missingAssumptions: gap.missingAssumptions,
    scopeChanges: input.scopeChanges,
    knownGaps: input.knownGaps,
    ambiguityNotes: input.ambiguityNotes ?? [],
    statementDiffs: input.statementDiffs ?? [],
    reviewerDisagreement: input.reviewerDisagreement ?? false,
    equivalenceAuditBundle: persistedBundle,
    gap,
    artifactId: artifact.id
  }, [artifact.id]);

  return {
    status: input.status,
    artifactId: artifact.id,
    equivalenceReview,
    equivalenceAuditBundle: persistedBundle,
    gap,
    knownGaps: input.knownGaps,
    missingDefinitions: gap.missingDefinitions,
    missingLemmas: gap.missingLemmas,
    missingAssumptions: gap.missingAssumptions,
    scopeChanges: input.scopeChanges,
    statementDiffs: input.statementDiffs ?? [],
    ambiguityNotes: input.ambiguityNotes ?? []
  };
}

export type TheoremEquivalenceReviewInput = {
  originalProblem: string;
  normalizedStatement: string;
  formalStatement: string;
  assumptions: string[];
  conclusion: string;
  ambiguityNotes: string[];
  statementDiffs: string[];
  knownGaps?: string[];
  missingDefinitions?: string[];
  missingLemmas?: string[];
  missingAssumptions?: string[];
  scopeChanges?: string[];
  status: FormalizationAssessment["status"];
  reviewer: string;
  reviewerDisagreement: boolean;
};

export function recordTheoremEquivalenceReview(
  runId: string,
  ledger: Ledger,
  artifacts: ArtifactStore,
  input: TheoremEquivalenceReviewInput
): RecordedFormalizationAssessment {
  const equivalenceReview: TheoremEquivalenceReview = {
    originalProblem: input.originalProblem,
    normalizedStatement: input.normalizedStatement,
    formalStatement: input.formalStatement,
    assumptions: input.assumptions,
    conclusion: input.conclusion,
    ambiguityNotes: input.ambiguityNotes,
    statementDiffs: input.statementDiffs,
    reviewer: input.reviewer,
    reviewerDisagreement: input.reviewerDisagreement
  };
  const gap = classifyFormalizationGap({
    status: input.status,
    equivalenceReview,
    knownGaps: input.knownGaps ?? [],
    missingDefinitions: input.missingDefinitions,
    missingLemmas: input.missingLemmas,
    missingAssumptions: input.missingAssumptions,
    scopeChanges: input.scopeChanges ?? [],
    statementDiffs: input.statementDiffs,
    ambiguityNotes: input.ambiguityNotes
  });
  const equivalenceAuditBundle = buildEquivalenceAuditBundle({
    status: input.status,
    equivalenceReview,
    gap,
    reviewerIndependent: input.reviewer !== "lean4"
  });
  const artifact = artifacts.create(runId, "theorem.equivalence", JSON.stringify({
    status: input.status,
    ...equivalenceReview,
    knownGaps: input.knownGaps ?? [],
    missingDefinitions: gap.missingDefinitions,
    missingLemmas: gap.missingLemmas,
    missingAssumptions: gap.missingAssumptions,
    scopeChanges: input.scopeChanges ?? [],
    equivalenceAuditBundle,
    gap
  }, null, 2));
  const persistedBundle = withPersistedBundleMetadata(equivalenceAuditBundle, artifact.id);
  ledger.appendEvent(runId, "theorem.equivalence.reviewed", {
    status: input.status,
    artifactId: artifact.id,
    ...equivalenceReview,
    equivalenceAuditBundle: persistedBundle,
    knownGaps: input.knownGaps ?? [],
    missingDefinitions: gap.missingDefinitions,
    missingLemmas: gap.missingLemmas,
    missingAssumptions: gap.missingAssumptions,
    scopeChanges: input.scopeChanges ?? [],
    gap
  }, [artifact.id]);
  ledger.appendEvent(runId, "formalization.assessed", {
    status: input.status,
    reviewer: input.reviewer,
    normalizedStatement: input.normalizedStatement,
    formalStatement: input.formalStatement,
    assumptions: input.assumptions,
    conclusion: input.conclusion,
    ambiguityNotes: input.ambiguityNotes,
    statementDiffs: input.statementDiffs,
    knownGaps: input.knownGaps ?? [],
    missingDefinitions: gap.missingDefinitions,
    missingLemmas: gap.missingLemmas,
    missingAssumptions: gap.missingAssumptions,
    scopeChanges: input.scopeChanges ?? [],
    reviewerDisagreement: input.reviewerDisagreement,
    equivalenceAuditBundle: persistedBundle,
    gap,
    artifactId: artifact.id
  }, [artifact.id]);
  return {
    status: input.status,
    artifactId: artifact.id,
    equivalenceReview,
    equivalenceAuditBundle: persistedBundle,
    gap,
    knownGaps: input.knownGaps ?? [],
    missingDefinitions: gap.missingDefinitions,
    missingLemmas: gap.missingLemmas,
    missingAssumptions: gap.missingAssumptions,
    scopeChanges: input.scopeChanges ?? [],
    statementDiffs: input.statementDiffs,
    ambiguityNotes: input.ambiguityNotes
  };
}

function buildEquivalenceAuditBundle(input: {
  status: FormalizationAssessment["status"];
  equivalenceReview: TheoremEquivalenceReview;
  gap: FormalizationGapClassification;
  reviewerIndependent: boolean;
}): FormalEquivalenceAuditBundle {
  const hiddenAssumptions = unique([
    ...input.gap.missingAssumptions,
    ...input.equivalenceReview.statementDiffs.filter((diff) => /hidden assumption|adds assumption|extra assumption|assumes/i.test(diff))
  ]);
  const addedAssumptions = unique([
    ...input.equivalenceReview.statementDiffs.filter((diff) => /adds assumption|extra assumption|assumes/i.test(diff)),
    ...input.gap.scopeChanges.filter((change) => /assumption|hypothesis/i.test(change))
  ]);
  const blockingReasons = unique([
    ...(input.status === "equivalent" ? [] : [`status:${input.status}`]),
    ...(input.equivalenceReview.reviewerDisagreement ? ["reviewer_disagreement"] : []),
    ...input.equivalenceReview.statementDiffs.map((diff) => `statement_diff:${diff}`),
    ...input.equivalenceReview.ambiguityNotes.map((note) => `ambiguity:${note}`),
    ...input.gap.knownGaps.map((gap) => `known_gap:${gap}`),
    ...hiddenAssumptions.map((assumption) => `hidden_assumption:${assumption}`),
    ...addedAssumptions.map((assumption) => `added_assumption:${assumption}`),
    ...(input.reviewerIndependent ? [] : ["reviewer_not_independent"])
  ]);
  const unsigned = {
    format: "matematica.formal-equivalence-audit-bundle" as const,
    version: 1 as const,
    originalProblem: input.equivalenceReview.originalProblem,
    normalizedTheorem: input.equivalenceReview.normalizedStatement,
    leanTheorem: input.equivalenceReview.formalStatement,
    assumptionDiff: {
      originalAssumptions: [],
      formalAssumptions: input.equivalenceReview.assumptions,
      addedAssumptions,
      removedAssumptions: [],
      hiddenAssumptions
    },
    allowedAssumptionPolicy: {
      allowAddedAssumptions: false as const,
      allowedAddedAssumptions: [],
      reason: "Formal proof candidates must prove the original statement exactly; added or hidden assumptions create a different theorem."
    },
    independentReview: stripAuditBundle(input.equivalenceReview),
    decision: {
      equivalent: input.status === "equivalent" && blockingReasons.length === 0,
      status: input.status,
      reviewer: input.equivalenceReview.reviewer,
      reviewerIndependent: input.reviewerIndependent,
      blockingReasons
    }
  };
  return {
    ...unsigned,
    bundleHash: stableHash(unsigned)
  };
}

function withPersistedBundleMetadata(
  bundle: FormalEquivalenceAuditBundle,
  artifactId: string
): FormalEquivalenceAuditBundle {
  const unsigned = {
    ...bundle,
    artifactId,
    bundleHash: undefined
  };
  return {
    ...bundle,
    artifactId,
    bundleHash: stableHash(unsigned)
  };
}

function stripAuditBundle(review: TheoremEquivalenceReview): Omit<TheoremEquivalenceReview, "auditBundle"> {
  const { auditBundle: _auditBundle, ...stripped } = review;
  return stripped;
}

function unique(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter((item) => item.length > 0))];
}

function buildEquivalenceReview(input: FormalizationReviewInput): TheoremEquivalenceReview | undefined {
  return {
    originalProblem: input.informalProblem,
    normalizedStatement: input.normalizedStatement ?? input.informalProblem,
    formalStatement: input.formalStatement,
    assumptions: input.assumptions,
    conclusion: input.conclusion ?? input.formalStatement,
    ambiguityNotes: input.ambiguityNotes ?? [],
    statementDiffs: input.statementDiffs ?? [],
    reviewer: input.reviewer,
    reviewerDisagreement: input.reviewerDisagreement ?? false
  };
}
