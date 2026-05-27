import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AdversarialCriticFinding,
  AdversarialProviderLineage,
  AdversarialQuorumStatus
} from "./adversarial-quorum";
import { stableHash } from "./idempotency";
import { CANONICAL_MATEMATICA_PLAN_ID } from "./release-plan";

export const PLAN_CHANGE_REVIEW_MANIFEST_RELATIVE_PATH = "docs/release/adversarial-plan-change-reviews.json";

export type PlanChangeReviewManifest = {
  format: "matematica.adversarial-plan-change-review-manifest";
  version: 1;
  planId: string;
  records: PlanChangeReviewRecord[];
};

export type PlanChangeReviewRecord = {
  mutationId: string;
  material: boolean;
  changedTaskIds: string[];
  rationale: string;
  taskEvidence: Array<{
    taskId: string;
    evidenceType: "todo-comment" | "todo-task" | "release-plan-registry" | "conversation-message";
    evidenceRef: string;
  }>;
  review: PlanChangeAdversarialReview;
};

export type PlanChangeAdversarialReview = {
  scope: "plan_change";
  status: AdversarialQuorumStatus;
  reviewHash: string;
  artifactIds: string[];
  critics: Array<{
    criticId: string;
    independentGroup: string;
    providerLineage: AdversarialProviderLineage;
    findings: AdversarialCriticFinding[];
  }>;
  capacityFailure?: {
    reason: string;
      requestedCritics: number;
      availableCritics: number;
      artifactId: string;
  };
  riskAcceptance?: PlanChangeReviewRiskAcceptance;
};

export type PlanChangeReviewRiskAcceptance = {
  releaseOwner: string;
  acceptedAt: string;
  expiresAt: string;
  changedTaskIds: string[];
  reviewerDeficit: {
    requestedCritics: number;
    availableCritics: number;
    missingCritics: number;
    reason: string;
  };
  rollbackPlan: string;
  artifactId: string;
};

export type PlanChangeReviewIssue = {
  code:
    | "manifest_missing"
    | "manifest_unreadable"
    | "wrong_format"
    | "wrong_plan_id"
    | "no_records"
    | "mutation_id_missing"
    | "changed_tasks_missing"
    | "task_evidence_missing"
    | "review_missing"
    | "review_scope_invalid"
    | "review_artifact_missing"
    | "review_hash_missing"
    | "review_hash_mismatch"
    | "capacity_failure_invalid"
    | "risk_acceptance_missing"
    | "risk_acceptance_invalid"
    | "risk_acceptance_expired"
    | "critic_count_low"
    | "critic_independence_low"
    | "critic_provider_independence_low"
    | "critic_upstream_independence_low"
    | "critic_model_family_independence_low"
    | "critic_execution_root_independence_low"
    | "critic_artifact_missing"
    | "critic_finding_missing"
    | "critic_rationale_missing";
  mutationId?: string;
  message: string;
};

export type PlanChangeReviewValidation = {
  ok: boolean;
  recordCount: number;
  materialRecordCount: number;
  reviewedMaterialRecordCount: number;
  capacityFailureCount: number;
  riskAcceptedMaterialRecordCount: number;
  issues: PlanChangeReviewIssue[];
};

export function readPlanChangeReviewManifest(packageRoot = process.cwd()): PlanChangeReviewManifest | { error: PlanChangeReviewIssue } {
  const path = join(packageRoot, PLAN_CHANGE_REVIEW_MANIFEST_RELATIVE_PATH);
  if (!existsSync(path)) {
    return {
      error: {
        code: "manifest_missing",
        message: `${PLAN_CHANGE_REVIEW_MANIFEST_RELATIVE_PATH} is missing`
      }
    };
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PlanChangeReviewManifest;
  } catch (error) {
    return {
      error: {
        code: "manifest_unreadable",
        message: `${PLAN_CHANGE_REVIEW_MANIFEST_RELATIVE_PATH} could not be parsed: ${error instanceof Error ? error.message : String(error)}`
      }
    };
  }
}

export function validatePlanChangeReviewManifest(input: {
  manifest: PlanChangeReviewManifest | { error: PlanChangeReviewIssue };
}): PlanChangeReviewValidation {
  if ("error" in input.manifest) {
    return {
      ok: false,
      recordCount: 0,
      materialRecordCount: 0,
      reviewedMaterialRecordCount: 0,
      capacityFailureCount: 0,
      riskAcceptedMaterialRecordCount: 0,
      issues: [input.manifest.error]
    };
  }
  const manifest = input.manifest;
  const issues: PlanChangeReviewIssue[] = [];
  if (manifest.format !== "matematica.adversarial-plan-change-review-manifest" || manifest.version !== 1) {
    issues.push({
      code: "wrong_format",
      message: "plan-change review manifest must use matematica.adversarial-plan-change-review-manifest v1"
    });
  }
  if (manifest.planId !== CANONICAL_MATEMATICA_PLAN_ID) {
    issues.push({
      code: "wrong_plan_id",
      message: `plan-change review manifest must target canonical plan ${CANONICAL_MATEMATICA_PLAN_ID}`
    });
  }
  if (!Array.isArray(manifest.records) || manifest.records.length === 0) {
    issues.push({
      code: "no_records",
      message: "plan-change review manifest must include at least one material mutation record"
    });
  }
  for (const record of manifest.records ?? []) {
    issues.push(...validatePlanChangeReviewRecord(record));
  }
  const materialRecords = (manifest.records ?? []).filter((record) => record.material);
  return {
    ok: issues.length === 0,
    recordCount: manifest.records?.length ?? 0,
    materialRecordCount: materialRecords.length,
    reviewedMaterialRecordCount: materialRecords.filter((record) => hasReview(record)).length,
    capacityFailureCount: materialRecords.filter((record) => Boolean(record.review?.capacityFailure)).length,
    riskAcceptedMaterialRecordCount: materialRecords.filter((record) =>
      Boolean(record.review?.capacityFailure && record.review.riskAcceptance)
    ).length,
    issues
  };
}

export function validatePlanChangeReviewRecord(record: PlanChangeReviewRecord): PlanChangeReviewIssue[] {
  const mutationId = typeof record.mutationId === "string" && record.mutationId.length > 0 ? record.mutationId : undefined;
  const issues: PlanChangeReviewIssue[] = [];
  if (!mutationId) {
    issues.push({
      code: "mutation_id_missing",
      message: "material plan mutation record is missing mutationId"
    });
  }
  if (!record.material) return issues;
  if (!Array.isArray(record.changedTaskIds) || record.changedTaskIds.length === 0) {
    issues.push(issue("changed_tasks_missing", mutationId, "material plan mutation must name changed task ids"));
  }
  if (!Array.isArray(record.taskEvidence) || record.taskEvidence.length === 0) {
    issues.push(issue("task_evidence_missing", mutationId, "material plan mutation must link todo/conversation/release-plan evidence"));
  }
  if (!hasReview(record)) {
    issues.push(issue("review_missing", mutationId, "material plan mutation must include persisted adversarial plan-change review evidence"));
    return issues;
  }
  const review = record.review;
  if (review.scope !== "plan_change") issues.push(issue("review_scope_invalid", mutationId, "adversarial review scope must be plan_change"));
  if (!review.reviewHash) issues.push(issue("review_hash_missing", mutationId, "adversarial review hash is missing"));
  if (review.reviewHash && review.reviewHash !== planChangeReviewHash(review)) {
    issues.push(issue("review_hash_mismatch", mutationId, "adversarial review hash does not match persisted reviewer evidence"));
  }
  if (!Array.isArray(review.artifactIds) || review.artifactIds.length === 0) {
    issues.push(issue("review_artifact_missing", mutationId, "adversarial review must link persisted artifacts"));
  }
  if (review.capacityFailure) {
    if (
      !review.capacityFailure.reason ||
      !review.capacityFailure.artifactId ||
      review.status !== "degraded_capacity" ||
      review.capacityFailure.requestedCritics < 2 ||
      review.capacityFailure.availableCritics >= review.capacityFailure.requestedCritics
    ) {
      issues.push(issue("capacity_failure_invalid", mutationId, "capacity failure must be first-class, persisted, and explain unavailable reviewer capacity"));
    }
    issues.push(...validateRiskAcceptance({
      mutationId,
      changedTaskIds: record.changedTaskIds ?? [],
      capacityFailure: review.capacityFailure,
      riskAcceptance: review.riskAcceptance
    }));
    return issues;
  }
  if (!Array.isArray(review.critics) || review.critics.length < 2) {
    issues.push(issue("critic_count_low", mutationId, "plan-change review requires at least two critics or a first-class capacity failure"));
  }
  const independentGroups = new Set((review.critics ?? []).map((critic) => critic.independentGroup).filter(Boolean));
  if (independentGroups.size < 2) {
    issues.push(issue("critic_independence_low", mutationId, "plan-change review critics must come from at least two independent groups"));
  }
  const critics = review.critics ?? [];
  if (critics.length >= 2) {
    const providers = lineageSet(critics.map((critic) => critic.providerLineage), providerKey);
    const upstreamProviders = lineageSet(critics.map((critic) => critic.providerLineage), upstreamProviderKey);
    const modelFamilies = lineageSet(critics.map((critic) => critic.providerLineage), modelFamilyKey);
    const executionRoots = lineageSet(critics.map((critic) => critic.providerLineage), executionRootKey);
    const promptLineages = critics
      .map((critic) => critic.providerLineage?.systemPromptLineageHash)
      .filter((value): value is string => Boolean(value));
    if (providers.size < 2) {
      issues.push(issue("critic_provider_independence_low", mutationId, "same provider reviewers cannot count as independent plan-change critics"));
    }
    if (upstreamProviders.size < 2) {
      issues.push(issue("critic_upstream_independence_low", mutationId, "same upstream provider reviewers cannot count as independent plan-change critics"));
    }
    if (modelFamilies.size < 2) {
      issues.push(issue("critic_model_family_independence_low", mutationId, "same model-family reviewers cannot count as independent plan-change critics"));
    }
    if (executionRoots.size < 2) {
      issues.push(issue("critic_execution_root_independence_low", mutationId, "same execution-root reviewers cannot count as independent plan-change critics"));
    }
    if (promptLineages.length >= 2 && new Set(promptLineages.map(normalize)).size < 2) {
      issues.push(issue("critic_execution_root_independence_low", mutationId, "same system-prompt lineage reviewers cannot count as independent plan-change critics"));
    }
  }
  for (const critic of review.critics ?? []) {
    if (!critic.findings?.some((finding) => finding.artifactIds.length > 0)) {
      issues.push(issue("critic_artifact_missing", mutationId, `critic ${critic.criticId} must link persisted finding artifacts`));
    }
    if (!critic.findings || critic.findings.length === 0) {
      issues.push(issue("critic_finding_missing", mutationId, `critic ${critic.criticId} has no objections/findings`));
    }
    for (const finding of critic.findings ?? []) {
      if (!finding.rationale) issues.push(issue("critic_rationale_missing", mutationId, `finding ${finding.id} is missing reviewer rationale`));
    }
  }
  return issues;
}

function validateRiskAcceptance(input: {
  mutationId: string | undefined;
  changedTaskIds: string[];
  capacityFailure: NonNullable<PlanChangeAdversarialReview["capacityFailure"]>;
  riskAcceptance?: PlanChangeReviewRiskAcceptance;
}): PlanChangeReviewIssue[] {
  const issues: PlanChangeReviewIssue[] = [];
  const acceptance = input.riskAcceptance;
  if (!acceptance) {
    return [issue(
      "risk_acceptance_missing",
      input.mutationId,
      "degraded-capacity plan-change reviews cannot approve release gates without explicit release-owner risk acceptance"
    )];
  }
  const acceptanceTasks = new Set(acceptance.changedTaskIds ?? []);
  const missingTasks = input.changedTaskIds.filter((taskId) => !acceptanceTasks.has(taskId));
  const acceptedAtMs = Date.parse(acceptance.acceptedAt);
  const expiresAtMs = Date.parse(acceptance.expiresAt);
  const missingCritics = input.capacityFailure.requestedCritics - input.capacityFailure.availableCritics;
  const invalid =
    !acceptance.releaseOwner?.trim() ||
    !acceptance.artifactId?.trim() ||
    !acceptance.rollbackPlan?.trim() ||
    !acceptance.reviewerDeficit?.reason?.trim() ||
    !Number.isFinite(acceptedAtMs) ||
    !Number.isFinite(expiresAtMs) ||
    expiresAtMs <= acceptedAtMs ||
    missingTasks.length > 0 ||
    acceptance.reviewerDeficit.requestedCritics !== input.capacityFailure.requestedCritics ||
    acceptance.reviewerDeficit.availableCritics !== input.capacityFailure.availableCritics ||
    acceptance.reviewerDeficit.missingCritics !== missingCritics ||
    acceptance.reviewerDeficit.missingCritics <= 0;
  if (invalid) {
    issues.push(issue(
      "risk_acceptance_invalid",
      input.mutationId,
      "release-owner risk acceptance must name changed task ids, reviewer deficit, expiry, rollback plan, and persisted artifact evidence"
    ));
  }
  if (Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now()) {
    issues.push(issue(
      "risk_acceptance_expired",
      input.mutationId,
      "release-owner risk acceptance for degraded plan-change quorum has expired"
    ));
  }
  return issues;
}

export function planChangeReviewHash(review: PlanChangeAdversarialReview): string {
  return stableHash({
    ...review,
    reviewHash: undefined
  });
}

function hasReview(record: PlanChangeReviewRecord): boolean {
  return Boolean(record.review && typeof record.review === "object");
}

function lineageSet(
  lineages: Array<AdversarialProviderLineage | undefined>,
  select: (lineage: AdversarialProviderLineage) => string | undefined
): Set<string> {
  return new Set(lineages.map((lineage) => (lineage ? select(lineage) : undefined)).filter((value): value is string => Boolean(value)));
}

function providerKey(lineage: AdversarialProviderLineage): string {
  return normalize(lineage.provider);
}

function upstreamProviderKey(lineage: AdversarialProviderLineage): string {
  return normalize(lineage.upstreamProvider ?? lineage.provider);
}

function modelFamilyKey(lineage: AdversarialProviderLineage): string {
  return normalize(lineage.modelFamily);
}

function executionRootKey(lineage: AdversarialProviderLineage): string | undefined {
  return lineage.routingPath.length > 0 ? normalize(lineage.routingPath[0]) : providerKey(lineage);
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "-");
}

function issue(code: PlanChangeReviewIssue["code"], mutationId: string | undefined, message: string): PlanChangeReviewIssue {
  return { code, mutationId, message };
}
