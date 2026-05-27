import { expect, test } from "bun:test";
import { scoreEvidence } from "../src/scoring";

test("scoreEvidence caps model agreement below verifier-backed confidence", () => {
  const score = scoreEvidence({
    evidenceGrade: "conjectural_solution",
    claimType: "proof_sketch",
    verifierStatus: "not_checked",
    verifierTrusted: false,
    sourceSupport: "cited",
    counterexampleSearch: "attempted",
    reproducibility: "partial",
    modelAgreementOnly: true
  });

  expect(score.aggregate).toBeLessThanOrEqual(0.24);
  expect(score.confidenceClass).toBe("low");
  expect(score.modelAgreementCeilingApplied).toBe(true);
  expect(score.reasons.join("\n")).toContain("model agreement alone is capped");
});

test("scoreEvidence produces high confidence for clean verifier-backed formal proof", () => {
  const score = scoreEvidence({
    evidenceGrade: "formal_proof",
    claimType: "lean_checked_theorem",
    verifierStatus: "verified",
    verifierTrusted: true,
    formalizationStatus: "equivalent",
    sourceSupport: "verified",
    counterexampleSearch: "passed",
    reproducibility: "deterministic"
  });

  expect(score.aggregate).toBeGreaterThanOrEqual(0.8);
  expect(score.confidenceClass).toBe("high");
  expect(score.reasons).toEqual(["all conservative evidence dimensions are satisfied"]);
});
