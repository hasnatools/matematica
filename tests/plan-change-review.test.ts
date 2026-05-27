import { expect, test } from "bun:test";
import {
  planChangeReviewHash,
  readPlanChangeReviewManifest,
  validatePlanChangeReviewManifest,
  type PlanChangeReviewManifest
} from "../src/plan-change-review";
import { buildReleaseDoctorReport } from "../src/release-doctor";
import { loadConfig } from "../src/config";

test("adversarial plan-change review manifest validates material mutations", () => {
  const manifest = readPlanChangeReviewManifest();
  if ("error" in manifest) throw new Error(manifest.error.message);
  const validation = validatePlanChangeReviewManifest({ manifest });

  expect(validation.ok).toBe(true);
  expect(validation.materialRecordCount).toBe(3);
  expect(validation.reviewedMaterialRecordCount).toBe(3);
  expect(validation.capacityFailureCount).toBe(3);
  expect(validation.riskAcceptedMaterialRecordCount).toBe(3);
  for (const record of manifest.records) {
    expect(record.review.reviewHash).toBe(planChangeReviewHash(record.review));
  }
});

test("plan-change review rejects missing review and same-provider fake independence", () => {
  const manifest = readPlanChangeReviewManifest();
  if ("error" in manifest) throw new Error(manifest.error.message);
  const broken = cloneManifest(manifest);
  broken.records[0] = {
    ...broken.records[0],
    review: {
      ...broken.records[0].review,
      status: "passed",
      capacityFailure: undefined,
      critics: broken.records[0].review.critics.map((critic) => ({
        ...critic,
        providerLineage: {
          ...critic.providerLineage,
          provider: "local-codex",
          upstreamProvider: "local-codex",
          modelFamily: `synthetic-family-${critic.criticId}`
        }
      }))
    }
  };
  broken.records[0].review.reviewHash = planChangeReviewHash(broken.records[0].review);
  broken.records[1] = {
    ...broken.records[1],
    review: undefined as unknown as typeof broken.records[1]["review"]
  };

  const validation = validatePlanChangeReviewManifest({ manifest: broken });
  const codes = validation.issues.map((issue) => issue.code);

  expect(validation.ok).toBe(false);
  expect(codes).toContain("critic_provider_independence_low");
  expect(codes).toContain("critic_upstream_independence_low");
  expect(codes).toContain("critic_execution_root_independence_low");
  expect(codes).toContain("review_missing");
});

test("plan-change review rejects degraded capacity without scoped release-owner risk acceptance", () => {
  const manifest = readPlanChangeReviewManifest();
  if ("error" in manifest) throw new Error(manifest.error.message);
  const missingAcceptance = cloneManifest(manifest);
  delete missingAcceptance.records[0].review.riskAcceptance;
  missingAcceptance.records[0].review.reviewHash = planChangeReviewHash(missingAcceptance.records[0].review);

  const missingValidation = validatePlanChangeReviewManifest({ manifest: missingAcceptance });
  expect(missingValidation.ok).toBe(false);
  expect(missingValidation.issues.map((issue) => issue.code)).toContain("risk_acceptance_missing");

  const invalidAcceptance = cloneManifest(manifest);
  invalidAcceptance.records[0].review.riskAcceptance = {
    ...invalidAcceptance.records[0].review.riskAcceptance!,
    changedTaskIds: invalidAcceptance.records[0].changedTaskIds.slice(0, 1),
    reviewerDeficit: {
      ...invalidAcceptance.records[0].review.riskAcceptance!.reviewerDeficit,
      missingCritics: 0
    },
    rollbackPlan: ""
  };
  invalidAcceptance.records[0].review.reviewHash = planChangeReviewHash(invalidAcceptance.records[0].review);

  const invalidValidation = validatePlanChangeReviewManifest({ manifest: invalidAcceptance });
  expect(invalidValidation.ok).toBe(false);
  expect(invalidValidation.issues.map((issue) => issue.code)).toContain("risk_acceptance_invalid");
});

test("plan-change review rejects drifted reviewer evidence hashes", () => {
  const manifest = readPlanChangeReviewManifest();
  if ("error" in manifest) throw new Error(manifest.error.message);
  const broken = cloneManifest(manifest);
  broken.records[0].review.critics[0].findings[0].rationale = "tampered after review";

  const validation = validatePlanChangeReviewManifest({ manifest: broken });

  expect(validation.ok).toBe(false);
  expect(validation.issues.map((issue) => issue.code)).toContain("review_hash_mismatch");
});

test("release doctor fails when plan-change review evidence is missing", () => {
  const manifest = readPlanChangeReviewManifest();
  if ("error" in manifest) throw new Error(manifest.error.message);
  const broken = cloneManifest(manifest);
  broken.records = [];
  const report = buildReleaseDoctorReport({
    cwd: process.cwd(),
    config: loadConfig(process.cwd(), {}),
    planChangeReviewManifest: broken
  });
  const check = report.checks.find((item) => item.id === "adversarial-plan-change-review");

  expect(check).toBeDefined();
  expect(check!.status).toBe("fail");
  expect(check!.issues.join("\n")).toContain("no_records");
});

function cloneManifest(manifest: PlanChangeReviewManifest): PlanChangeReviewManifest {
  return JSON.parse(JSON.stringify(manifest)) as PlanChangeReviewManifest;
}
