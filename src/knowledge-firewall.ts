import type { Artifact, LedgerEvent } from "./domain";
import { stableHash } from "./idempotency";

export type KnowledgePromotionFirewallIssue = {
  eventId: string;
  eventType: string;
  code: string;
  message: string;
};

export type KnowledgeTruthLevel =
  | "raw_source"
  | "candidate"
  | "checked_lemma"
  | "formalized"
  | "refuted"
  | "obsolete";

export type KnowledgePromotionFirewallItem = {
  eventId: string;
  eventType: string;
  role:
    | "typed_phase_output"
    | "typed_branch_candidate"
    | "typed_knowledge_artifact"
    | "proof_obligation_review"
    | "counterexample_review"
    | "source_context_only"
    | "ranking_metadata"
    | "goal_success_review";
  artifactIds: string[];
  sourceLineage?: Record<string, unknown>;
  evidenceGrade?: string;
  status?: string;
  truthLevel: KnowledgeTruthLevel;
  trustedAsEvidence: boolean;
};

export type KnowledgePromotionFirewallReview = {
  format: "matematica.knowledge-promotion-firewall";
  version: 1;
  ok: boolean;
  targetCycle: number;
  reviewedAt: string;
  inputEventIds: string[];
  accepted: KnowledgePromotionFirewallItem[];
  rejected: KnowledgePromotionFirewallIssue[];
  policy: {
    modelTextTrusted: false;
    sourceTextTrusted: false;
    sourceMetadataIsProofSupport: false;
    knowledgeTextTrusted: false;
    controlsAffected: false;
    verifiedTruthLevels: ["checked_lemma", "formalized", "refuted"];
    unverifiedTruthLevels: ["raw_source", "candidate", "obsolete"];
    hardEvidenceRequiresSchemaValidTypedArtifacts: true;
    loopholeBranchesRequireAssumptionDeltaReview: true;
    knowledgeRequiresExplicitPromotion: true;
    unverifiedKnowledgeCannotMutateControls: true;
    sourceDerivedKnowledgeCannotBeProofSupport: true;
  };
  reviewHash: string;
};

export function reviewKnowledgePromotionFirewall(input: {
  targetCycle: number;
  inputEvents: LedgerEvent[];
  artifacts: Artifact[];
}): KnowledgePromotionFirewallReview {
  const artifactIds = new Set(input.artifacts.map((artifact) => artifact.id));
  const accepted: KnowledgePromotionFirewallItem[] = [];
  const rejected: KnowledgePromotionFirewallIssue[] = [];
  for (const event of input.inputEvents) {
    const item = reviewEvent(event, artifactIds);
    if ("code" in item) {
      rejected.push(item);
    } else {
      accepted.push(item);
    }
  }
  const base = {
    format: "matematica.knowledge-promotion-firewall" as const,
    version: 1 as const,
    ok: rejected.length === 0,
    targetCycle: input.targetCycle,
    reviewedAt: new Date().toISOString(),
    inputEventIds: input.inputEvents.map((event) => event.id),
    accepted,
    rejected,
    policy: {
      modelTextTrusted: false as const,
      sourceTextTrusted: false as const,
      sourceMetadataIsProofSupport: false as const,
      knowledgeTextTrusted: false as const,
      controlsAffected: false as const,
      verifiedTruthLevels: ["checked_lemma", "formalized", "refuted"] as ["checked_lemma", "formalized", "refuted"],
      unverifiedTruthLevels: ["raw_source", "candidate", "obsolete"] as ["raw_source", "candidate", "obsolete"],
      hardEvidenceRequiresSchemaValidTypedArtifacts: true as const,
      loopholeBranchesRequireAssumptionDeltaReview: true as const,
      knowledgeRequiresExplicitPromotion: true as const,
      unverifiedKnowledgeCannotMutateControls: true as const,
      sourceDerivedKnowledgeCannotBeProofSupport: true as const
    }
  };
  return {
    ...base,
    reviewHash: stableHash(base)
  };
}

function reviewEvent(
  event: LedgerEvent,
  artifactIds: Set<string>
): KnowledgePromotionFirewallItem | KnowledgePromotionFirewallIssue {
  if (event.type === "phase.completed" && event.payload.phase === "evolve.ranking") return reviewRanking(event);
  if (event.type === "phase.completed") return reviewPhaseCompleted(event, artifactIds);
  if (event.type === "branch.candidate_claim.reviewed") return reviewBranchCandidate(event, artifactIds);
  if (event.type === "proof.obligations.reviewed" || event.type === "branch.proof_obligations.reviewed") {
    return reviewProofObligations(event, artifactIds);
  }
  if (event.type === "counterexample.search.reviewed") return reviewCounterexample(event, artifactIds);
  if (event.type === "source.results") return reviewSourceResults(event, artifactIds);
  if (event.type === "knowledge.conjecture.saved") return reviewKnowledgeConjecture(event, artifactIds);
  if (event.type === "worker.ranked") return reviewRanking(event);
  if (event.type === "goal.success.evaluated") return reviewGoalSuccess(event, artifactIds);
  return issue(event, "unsupported_knowledge_input", `${event.type} is not an allowed trusted knowledge-promotion input.`);
}

function reviewKnowledgeConjecture(event: LedgerEvent, artifactIds: Set<string>): KnowledgePromotionFirewallItem | KnowledgePromotionFirewallIssue {
  const artifactId = stringValue(event.payload.artifactId);
  if (!linkedArtifact(event, artifactIds, artifactId)) {
    return issue(event, "knowledge_artifact_missing", "knowledge conjecture must link its typed knowledge artifact.");
  }
  const provenance = recordValue(event.payload.provenance);
  if (!provenance) {
    return issue(event, "knowledge_provenance_missing", "knowledge conjecture requires provenance before promotion.");
  }
  if (!stringValue(event.payload.trustGrade)) {
    return issue(event, "knowledge_trust_grade_missing", "knowledge conjecture requires an explicit trust grade.");
  }
  const sourceTaint = recordValue(event.payload.sourceTaint);
  if (!sourceTaint) {
    return issue(event, "knowledge_source_taint_missing", "knowledge conjecture requires source taint metadata.");
  }
  const verifierStatus = recordValue(event.payload.verifierStatus);
  if (!verifierStatus || typeof verifierStatus.verified !== "boolean") {
    return issue(event, "knowledge_verifier_status_missing", "knowledge conjecture requires typed verifier status.");
  }
  if (!recordValue(event.payload.dependencyGraph)) {
    return issue(event, "knowledge_dependency_graph_missing", "knowledge conjecture requires a dependency graph.");
  }
  if (!recordValue(event.payload.contradictionReview)) {
    return issue(event, "knowledge_contradiction_review_missing", "knowledge conjecture requires contradiction and retraction review.");
  }
  if (!recordValue(event.payload.supersession)) {
    return issue(event, "knowledge_supersession_missing", "knowledge conjecture requires supersession metadata.");
  }
  const freshness = recordValue(event.payload.freshness);
  if (!freshness || !stringValue(freshness.policy)) {
    return issue(event, "knowledge_freshness_policy_missing", "knowledge conjecture requires expiry or freshness policy.");
  }
  const promotion = recordValue(event.payload.promotion);
  if (!promotion || promotion.explicit !== true) {
    return issue(event, "knowledge_explicit_promotion_missing", "knowledge conjecture requires explicit typed artifact promotion.");
  }
  if (promotion.promptFirewallRequired !== true || promotion.promptFirewallReviewed !== true) {
    return issue(event, "knowledge_prompt_firewall_missing", "knowledge conjecture cannot be promoted without prompt firewall review.");
  }
  const controlKeys = [
    "controlsAffected",
    "providerPolicyMutationAllowed",
    "budgetMutationAllowed",
    "toolPolicyMutationAllowed",
    "goalContractMutationAllowed"
  ] as const;
  if (controlKeys.some((key) => promotion[key] !== false)) {
    return issue(event, "knowledge_control_mutation_attempt", "knowledge conjecture cannot alter provider, budget, tool, verifier, or goal-contract controls.");
  }
  const truthLevel = knowledgeTruthLevel(event);
  const sourceDerived = sourceTaint.sourceDerived === true || arrayValue(sourceTaint.taintedSourceEventIds).length > 0;
  const verifierBacked = verifierStatus.verified === true && verifiedTruthLevel(truthLevel);
  if ((sourceDerived || !verifierBacked) && promotion.proofSupportAllowed !== false) {
    return issue(event, "knowledge_proof_support_attempt", "unverified or source-derived knowledge cannot become proof support.");
  }
  if (stringValue(promotion.promotedAs) !== "context_only") {
    return issue(event, "knowledge_promotion_scope_invalid", "knowledge conjecture promotion must be context_only.");
  }
  return {
    eventId: event.id,
    eventType: event.type,
    role: "typed_knowledge_artifact",
    artifactIds: [artifactId!],
    sourceLineage: {
      provenance,
      sourceTaint,
      verifierStatus,
      promotion
    },
    evidenceGrade: stringValue(event.payload.evidenceGrade),
    status: stringValue(promotion.promotedAs),
    truthLevel,
    trustedAsEvidence: false
  };
}

function reviewPhaseCompleted(event: LedgerEvent, artifactIds: Set<string>): KnowledgePromotionFirewallItem | KnowledgePromotionFirewallIssue {
  const manifest = recordValue(event.payload.outputManifest);
  if (manifest?.schemaVersion !== "workflow-phase-output-v1") {
    return issue(event, "phase_output_schema_missing", "phase.completed input must include workflow-phase-output-v1 outputManifest.");
  }
  const summaryArtifactId = stringValue(event.payload.summaryArtifactId);
  if (!summaryArtifactId || !event.artifactIds.includes(summaryArtifactId) || !artifactIds.has(summaryArtifactId)) {
    return issue(event, "phase_output_artifact_missing", "phase.completed input must link its typed phase summary artifact.");
  }
  if (event.payload.terminalSuccessAllowed === true) {
    return issue(event, "phase_output_terminal_authority", "phase output cannot grant terminal success authority to knowledge promotion.");
  }
  return {
    eventId: event.id,
    eventType: event.type,
    role: "typed_phase_output",
    artifactIds: [summaryArtifactId],
    status: stringValue(event.payload.phase),
    truthLevel: "candidate",
    trustedAsEvidence: false
  };
}

function reviewBranchCandidate(event: LedgerEvent, artifactIds: Set<string>): KnowledgePromotionFirewallItem | KnowledgePromotionFirewallIssue {
  const required = [
    "candidateArtifactId",
    "sourceBranchArtifactId",
    "workerResultSchemaReviewArtifactId",
    "proofObligationArtifactId"
  ] as const;
  const missing = required.filter((key) => !linkedArtifact(event, artifactIds, stringValue(event.payload[key])));
  if (missing.length > 0) {
    return issue(event, "branch_candidate_typed_artifacts_missing", `branch candidate missing linked typed artifacts: ${missing.join(", ")}.`);
  }
  const claim = recordValue(event.payload.claim);
  const evidenceGrade = stringValue(event.payload.evidenceGrade) ?? stringValue(claim?.evidenceGrade);
  if (!evidenceGrade) {
    return issue(event, "branch_candidate_evidence_grade_missing", "branch candidate must expose an evidence grade before promotion.");
  }
  const schemaReview = recordValue(event.payload.workerResultSchemaReview);
  if (!schemaReview || !["valid", "invalid", "absent"].includes(String(schemaReview.status))) {
    return issue(event, "branch_candidate_schema_review_missing", "branch candidate must include a persisted structured worker-result schema review.");
  }
  const sourceLineage = recordValue(event.payload.sourceLineage);
  if (!sourceLineage || sourceLineage.modelTextTrusted !== false || sourceLineage.controlsAffected !== false) {
    return issue(event, "branch_candidate_source_lineage_missing", "branch candidate must include source lineage proving model text cannot affect controls.");
  }
  const phase = stringValue(event.payload.phase);
  if (phase === "loophole" && !linkedArtifact(event, artifactIds, stringValue(event.payload.assumptionDeltaArtifactId))) {
    return issue(event, "loophole_assumption_delta_missing", "loophole branch candidates require linked assumption-delta review artifacts.");
  }
  return {
    eventId: event.id,
    eventType: event.type,
    role: "typed_branch_candidate",
    artifactIds: uniqueStrings(required.map((key) => stringValue(event.payload[key])).filter(isString)),
    sourceLineage,
    evidenceGrade,
    status: stringValue(event.payload.status),
    truthLevel: truthLevelForEvidenceGrade(evidenceGrade, event.payload.status),
    trustedAsEvidence: event.payload.status === "accepted" && verifiedTruthLevel(truthLevelForEvidenceGrade(evidenceGrade, event.payload.status))
  };
}

function reviewProofObligations(event: LedgerEvent, artifactIds: Set<string>): KnowledgePromotionFirewallItem | KnowledgePromotionFirewallIssue {
  const artifactId = stringValue(event.payload.artifactId);
  if (!linkedArtifact(event, artifactIds, artifactId)) {
    return issue(event, "proof_obligation_artifact_missing", "proof-obligation review must link its artifact.");
  }
  if (!recordValue(event.payload.decision)) {
    return issue(event, "proof_obligation_decision_missing", "proof-obligation review must include a typed decision.");
  }
  return {
    eventId: event.id,
    eventType: event.type,
    role: "proof_obligation_review",
    artifactIds: [artifactId!],
    status: stringValue(event.payload.claimId),
    truthLevel: "candidate",
    trustedAsEvidence: false
  };
}

function reviewCounterexample(event: LedgerEvent, artifactIds: Set<string>): KnowledgePromotionFirewallItem | KnowledgePromotionFirewallIssue {
  const artifactId = stringValue(event.payload.artifactId);
  if (!linkedArtifact(event, artifactIds, artifactId)) {
    return issue(event, "counterexample_artifact_missing", "counterexample review must link its artifact.");
  }
  return {
    eventId: event.id,
    eventType: event.type,
    role: "counterexample_review",
    artifactIds: [artifactId!],
    status: stringValue(event.payload.status),
    truthLevel: stringValue(event.payload.status) === "found" ? "refuted" : "candidate",
    trustedAsEvidence: false
  };
}

function reviewSourceResults(event: LedgerEvent, artifactIds: Set<string>): KnowledgePromotionFirewallItem | KnowledgePromotionFirewallIssue {
  const artifactId = stringValue(event.payload.artifactId);
  if (!linkedArtifact(event, artifactIds, artifactId)) {
    return issue(event, "source_artifact_missing", "source result must link its quarantined source artifact.");
  }
  if (!recordValue(event.payload.retrievalEvaluation)) {
    return issue(event, "source_retrieval_review_missing", "source result must include retrieval evaluation before context promotion.");
  }
  const sourceGateIssue = sourceContextGateIssue(event);
  if (sourceGateIssue) return sourceGateIssue;
  return {
    eventId: event.id,
    eventType: event.type,
    role: "source_context_only",
    artifactIds: [artifactId!],
    sourceLineage: {
      provider: event.payload.provider,
      phase: event.payload.phase,
      cycle: event.payload.cycle,
      citationOnly: true,
      sourceTextTrusted: false,
      citationMetadataIsProofSupport: false,
      truthLevel: "raw_source"
    },
    status: stringValue(recordValue(event.payload.retrievalEvaluation)?.trustImpact),
    truthLevel: "raw_source",
    trustedAsEvidence: false
  };
}

function reviewRanking(event: LedgerEvent): KnowledgePromotionFirewallItem {
  return {
    eventId: event.id,
    eventType: event.type,
    role: "ranking_metadata",
    artifactIds: event.artifactIds,
    status: stringValue(event.payload.phase),
    truthLevel: "candidate",
    trustedAsEvidence: false
  };
}

function reviewGoalSuccess(event: LedgerEvent, artifactIds: Set<string>): KnowledgePromotionFirewallItem | KnowledgePromotionFirewallIssue {
  const satisfyingArtifactIds = arrayValue(event.payload.satisfyingArtifactIds).filter(isString);
  const missing = satisfyingArtifactIds.filter((artifactId) => !artifactIds.has(artifactId));
  if (satisfyingArtifactIds.length === 0 || missing.length > 0) {
    return issue(event, "goal_success_artifacts_missing", "goal success review must bind existing satisfying artifacts.");
  }
  const evidenceGrade = stringValue(event.payload.evidenceGrade);
  if (!evidenceGrade) return issue(event, "goal_success_evidence_grade_missing", "goal success review must include an evidence grade.");
  return {
    eventId: event.id,
    eventType: event.type,
    role: "goal_success_review",
    artifactIds: satisfyingArtifactIds,
    evidenceGrade,
    status: stringValue(event.payload.status),
    truthLevel: truthLevelForEvidenceGrade(evidenceGrade, event.payload.status),
    trustedAsEvidence: event.payload.status === "goal_met" && verifiedTruthLevel(truthLevelForEvidenceGrade(evidenceGrade, event.payload.status))
  };
}

function sourceContextGateIssue(event: LedgerEvent): KnowledgePromotionFirewallIssue | undefined {
  const retrieval = recordValue(event.payload.retrievalEvaluation)!;
  const canPromote = retrieval.canPromoteResearchBackedClaims === true;
  if (!canPromote) return undefined;
  const failures = arrayValue(retrieval.failures).filter(isString);
  if (failures.length > 0) {
    return issue(event, "source_retrieval_failures_present", `source results cannot be promoted while retrieval failures remain: ${failures.join(", ")}.`);
  }
  if ((numberValue(retrieval.staleResultCount) ?? 0) > 0) {
    return issue(event, "source_recency_failed", "source results cannot be promoted while stale sources are present.");
  }
  if ((numberValue(retrieval.citationValidity) ?? 0) < 1) {
    return issue(event, "source_citation_grounding_failed", "source results cannot be promoted without fully grounded citations.");
  }
  const manifest = recordValue(event.payload.citationLicenseManifest);
  const summary = recordValue(event.payload.citationLicenseManifestSummary) ?? recordValue(manifest?.summary);
  if (!summary) {
    return issue(event, "source_license_manifest_missing", "promoted source context requires a citation license manifest summary.");
  }
  if ((numberValue(summary.staleCount) ?? 0) > 0) {
    return issue(event, "source_license_recency_failed", "promoted source context requires fresh citation license manifest entries.");
  }
  if ((numberValue(summary.hostileCount) ?? 0) > 0) {
    return issue(event, "source_hostile_prompt_flags_present", "promoted source context cannot contain hostile prompt-injection source flags.");
  }
  if (summary.pdfOrSourceContentExported !== false) {
    return issue(event, "source_redistribution_policy_failed", "promoted source context must not export PDF, source, or fulltext content.");
  }
  if (summary.proofSupportPolicy !== "citation_metadata_is_not_proof_support") {
    return issue(event, "source_proof_support_policy_failed", "citation metadata must remain non-proof support.");
  }
  return undefined;
}

function truthLevelForEvidenceGrade(evidenceGrade: string | undefined, status: unknown): KnowledgeTruthLevel {
  if (status === "obsolete") return "obsolete";
  if (evidenceGrade === "formal_proof") return "formalized";
  if (evidenceGrade === "verified_counterexample" || evidenceGrade === "contradicted") return "refuted";
  if (evidenceGrade === "verified_computation") return "checked_lemma";
  return "candidate";
}

function knowledgeTruthLevel(event: LedgerEvent): KnowledgeTruthLevel {
  const truthLevel = stringValue(event.payload.truthLevel);
  if (truthLevel === "raw_source" || truthLevel === "candidate" || truthLevel === "checked_lemma" || truthLevel === "formalized" || truthLevel === "refuted" || truthLevel === "obsolete") {
    return truthLevel;
  }
  return truthLevelForEvidenceGrade(stringValue(event.payload.evidenceGrade), event.payload.status);
}

function verifiedTruthLevel(truthLevel: KnowledgeTruthLevel): boolean {
  return truthLevel === "checked_lemma" || truthLevel === "formalized" || truthLevel === "refuted";
}

function linkedArtifact(event: LedgerEvent, artifacts: Set<string>, artifactId: string | undefined): boolean {
  return Boolean(artifactId && event.artifactIds.includes(artifactId) && artifacts.has(artifactId));
}

function issue(event: LedgerEvent, code: string, message: string): KnowledgePromotionFirewallIssue {
  return { eventId: event.id, eventType: event.type, code, message };
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
