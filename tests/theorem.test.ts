import { expect, test } from "bun:test";
import {
  defaultMathlibTheoremIndexSnapshot,
  normalizeTheoremCandidate,
  retrieveMathlibLemmas
} from "../src/theorem";

test("normalizeTheoremCandidate accepts matching universal Nat theorem shape", () => {
  const result = normalizeTheoremCandidate({
    originalProblem: "Prove every natural number has property P",
    formalStatement: "theorem original : forall n : Nat, P n := by sorry"
  });

  expect(result.normalizedStatement).toBe("every natural number has property P");
  expect(result.status).toBe("equivalent");
  expect(result.statementDiffs).toEqual([]);
  expect(result.reviewerDisagreement).toBe(false);
});

test("normalizeTheoremCandidate flags added assumptions and vacuous True theorem", () => {
  const result = normalizeTheoremCandidate({
    originalProblem: "Prove every natural number has property P",
    formalStatement: "theorem weakened : forall n : Nat, n > 0 -> True := by trivial"
  });

  expect(result.status).toBe("weakened");
  expect(result.reviewerDisagreement).toBe(true);
  expect(result.statementDiffs.join("\n")).toContain("formal statement proves True");
  expect(result.statementDiffs.join("\n")).toContain("formal statement adds assumptions");
});

test("mathlib lemma retrieval pins provenance and quarantines prompt summaries", () => {
  const index = defaultMathlibTheoremIndexSnapshot();
  const retrieval = retrieveMathlibLemmas({
    problem: "Prove 1 + 1 = 2 for natural numbers using addition",
    goal: "Find a Lean/mathlib lemma",
    now: new Date("2026-05-26T00:00:00.000Z")
  });

  expect(retrieval.indexVersion).toBe(index.indexVersion);
  expect(retrieval.indexHash).toBe(index.indexHash);
  expect(retrieval.mathlibRevision).toBe(index.mathlibRevision);
  expect(retrieval.lakeManifestHash).toBe(index.lakeManifestHash);
  expect(retrieval.queryHash).toMatch(/^[a-f0-9]{64}$/);
  expect(retrieval.trust).toEqual({
    sourceTextTrusted: false,
    quarantine: true,
    proofSupport: false,
    controlsAffected: false
  });
  expect(retrieval.results.length).toBeGreaterThan(0);
  expect(retrieval.results[0].name).toBe("Nat.one_add_one_eq_two");
  expect(retrieval.results[0].statementHash).toMatch(/^[a-f0-9]{64}$/);
  expect(retrieval.results[0].provenance).toMatchObject({
    source: "pinned-mathlib-index",
    indexVersion: index.indexVersion,
    indexHash: index.indexHash,
    mathlibRevision: index.mathlibRevision,
    lakeManifestHash: index.lakeManifestHash
  });
  expect(retrieval.results.every((lemma) => lemma.promptSummary.proofSupport === false)).toBe(true);
  expect(JSON.stringify(retrieval.results.map((lemma) => lemma.promptSummary))).not.toContain("theorem ");
});
