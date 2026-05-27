import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Artifact } from "../src/domain";
import {
  defaultTrustedVerifiers,
  makeClaimContract,
  type FormalizationAssessment,
  type TheoremEquivalenceReview
} from "../src/evidence";
import type { ProofObligationGraph, ProofObligationStatus } from "../src/proof-obligations";
import {
  evaluateVerifierConformanceCase,
  scanLeanConformanceSource,
  VERIFIER_CONFORMANCE_CORPUS,
  type VerifierConformanceFixture,
  type VerifierConformanceFixtureId
} from "../src/verifier-conformance";

const artifactsToClean: Artifact[] = [];

afterEach(() => {
  while (artifactsToClean.length > 0) {
    rmSync(dirname(artifactsToClean.pop()!.path), { recursive: true, force: true });
  }
});

test("verifier conformance corpus contains required adversarial fixtures", () => {
  expect(VERIFIER_CONFORMANCE_CORPUS.map((item) => item.id)).toEqual([
    "valid_exact_formal_statement",
    "lean_sorry",
    "lean_admit",
    "lean_axiom",
    "unsafe_import",
    "unpinned_mathlib",
    "weakened_theorem",
    "changed_quantifier",
    "hidden_assumption",
    "bogus_counterexample",
    "formalization_gap",
    "verifier_timeout"
  ]);
});

test("Lean conformance scan blocks sorry admit axiom and unsafe imports", () => {
  expect(scanLeanConformanceSource("theorem bad : True := by sorry").map((issue) => issue.code)).toContain("sorry");
  expect(scanLeanConformanceSource("theorem bad : True := by admit").map((issue) => issue.code)).toContain("admit");
  expect(scanLeanConformanceSource("axiom impossible : False").map((issue) => issue.code)).toContain("axiom");
  expect(scanLeanConformanceSource("import Lean\nunsafe def bad : Nat := 0").map((issue) => issue.code)).toContain("unsafe_import");
});

test("verifier conformance corpus only accepts exact formal proof with independent equivalence review", () => {
  const evaluations = VERIFIER_CONFORMANCE_CORPUS.map((fixture) => {
    const built = buildCase(fixture);
    return evaluateVerifierConformanceCase({
      fixture,
      claim: built.claim,
      context: {
        trustedVerifiers: defaultTrustedVerifiers(),
        artifacts: built.artifacts
      },
      leanFailureOutput: built.leanFailureOutput
    });
  });

  for (const fixture of VERIFIER_CONFORMANCE_CORPUS) {
    const evaluation = evaluations.find((item) => item.fixtureId === fixture.id);
    expect(evaluation, fixture.id).toBeTruthy();
    expect(evaluation!.canMarkGoalMet, fixture.id).toBe(fixture.expectedCanMarkGoalMet);
    expect(evaluation!.reason, fixture.id).toContain(fixture.expectedReasonIncludes);
    if (fixture.expectedLeanFailureKind) {
      expect(evaluation!.leanFailureKind, fixture.id).toBe(fixture.expectedLeanFailureKind);
    }
  }

  const accepted = evaluations.find((item) => item.fixtureId === "valid_exact_formal_statement")!;
  expect(accepted.evidenceDecision?.quorum.satisfiedBy.map((item) => item.role)).toContain("equivalence_reviewer");
  expect(evaluations.filter((item) => item.canMarkGoalMet)).toHaveLength(1);
});

function buildCase(fixture: VerifierConformanceFixture): {
  claim: ReturnType<typeof makeClaimContract>;
  artifacts: Artifact[];
  leanFailureOutput?: string;
} {
  if (fixture.id === "bogus_counterexample") {
    const artifact = trackedArtifact("art-bogus-counterexample", JSON.stringify({ claimedCounterexample: "n = 0", valid: false }));
    return {
      artifacts: [artifact],
      claim: makeClaimContract({
        id: "claim-bogus-counterexample",
        claimType: "counterexample",
        verifierId: "counterexample-checker",
        conclusion: "n = 0 is a counterexample",
        verifierStatus: "verified",
        evidenceGrade: "verified_counterexample",
        verifierArtifactIds: [artifact.id],
        proofObligationGraph: verifiedObligationGraph("claim-bogus-counterexample", [artifact.id], "computational_evidence")
      })
    };
  }

  const formalization = trackedArtifact(`art-formalization-${fixture.id}`, `formalization for ${fixture.id}`);
  const leanResult = trackedLeanResult(`art-lean-${fixture.id}`, {
    theoremName: theoremNameFor(fixture.id),
    projectPinned: fixture.id !== "unpinned_mathlib",
    proofObligationArtifactIds: [`art-lean-${fixture.id}`, formalization.id]
  });
  const artifacts = [leanResult, formalization];
  const formalizationAssessment = formalizationForFixture(fixture.id, formalization);
  const verifierStatus = fixture.id === "verifier_timeout" ? "failed" : "verified";
  const formalStatement = formalizationAssessment.equivalenceReview?.formalStatement ?? "theorem one_plus_one : 1 + 1 = 2";
  const tcb = leanTcb(theoremNameFor(fixture.id), formalStatement);
  return {
    artifacts,
    leanFailureOutput: fixture.id === "verifier_timeout" ? "Lean verifier timed out after 10ms" : failureOutputForStaticFixture(fixture.id),
    claim: makeClaimContract({
      id: `claim-${fixture.id}`,
      claimType: "lean_checked_theorem",
      verifierId: "lean4",
      assumptions: [],
      conclusion: formalStatement,
      dependencies: [],
      verifierStatus,
      evidenceGrade: "formal_proof",
      verifierArtifactIds: [leanResult.id],
      machineCheck: {
        verifier: "lean4",
        resultArtifactId: leanResult.id,
        sourceHash: "source-hash-test",
        theoremName: theoremNameFor(fixture.id),
        toolchainHash: "toolchain-hash-test",
        sandboxPolicyHash: "sandbox-policy-hash-test",
        projectPinned: fixture.id !== "unpinned_mathlib",
        proofObligationArtifactIds: [leanResult.id, formalization.id],
        tcb
      },
      proofObligationGraph: verifiedObligationGraph(`claim-${fixture.id}`, [leanResult.id, formalization.id], "lean_checked"),
      formalization: formalizationAssessment
    })
  };
}

function formalizationForFixture(id: VerifierConformanceFixtureId, artifact: Artifact): FormalizationAssessment {
  if (id === "weakened_theorem") {
    return {
      status: "weakened",
      artifactId: artifact.id,
      statementDiffs: ["weakened theorem: proves only n = n for one case"],
      equivalenceReview: equivalentReview({
        statementDiffs: ["weakened theorem: proves only n = n for one case"]
      })
    };
  }
  if (id === "changed_quantifier") {
    return {
      status: "mismatch",
      artifactId: artifact.id,
      statementDiffs: ["changed quantifier: forall became exists"],
      equivalenceReview: equivalentReview({
        statementDiffs: ["changed quantifier: forall became exists"]
      })
    };
  }
  if (id === "hidden_assumption") {
    return {
      status: "mismatch",
      artifactId: artifact.id,
      knownGaps: ["hidden assumption: assumes h : True"],
      missingAssumptions: ["h : True"],
      equivalenceReview: equivalentReview({
        assumptions: ["h : True"],
        statementDiffs: ["hidden assumption: assumes h : True"]
      })
    };
  }
  if (id === "formalization_gap") {
    return {
      status: "not_formalized",
      artifactId: artifact.id,
      knownGaps: ["formalization missing original target theorem"],
      equivalenceReview: equivalentReview({
        statementDiffs: ["formalization missing original target theorem"]
      })
    };
  }
  return {
    status: "equivalent",
    artifactId: artifact.id,
    equivalenceReview: equivalentReview()
  };
}

function failureOutputForStaticFixture(id: VerifierConformanceFixtureId): string | undefined {
  if (id === "lean_sorry") return "declaration uses sorry";
  if (id === "lean_admit") return "admit is not allowed";
  return undefined;
}

function theoremNameFor(id: VerifierConformanceFixtureId): string {
  if (id === "changed_quantifier") return "exists_case";
  if (id === "hidden_assumption") return "with_hidden_assumption";
  if (id === "formalization_gap") return "gap";
  return "one_plus_one";
}

function trackedArtifact(id: string, content: string, kind = "verifier.conformance"): Artifact {
  const dir = mkdtempSync(join(tmpdir(), "matematica-verifier-conformance-"));
  const path = join(dir, `${id}.json`);
  writeFileSync(path, content);
  const sha256 = createHash("sha256").update(content).digest("hex");
  const artifact = {
    id,
    runId: "run-verifier-conformance",
    kind,
    sha256,
    contentAddress: `sha256:${sha256}`,
    mediaType: "application/json",
    storageKey: `run-verifier-conformance/${sha256}.txt`,
    path,
    bytes: Buffer.byteLength(content),
    createdAt: new Date().toISOString()
  };
  artifactsToClean.push(artifact);
  return artifact;
}

function trackedLeanResult(id: string, input: {
  theoremName: string;
  projectPinned: boolean;
  proofObligationArtifactIds: string[];
}): Artifact {
  const formalStatement = defaultFormalStatement(input.theoremName);
  const tcb = leanTcb(input.theoremName, formalStatement);
  return trackedArtifact(id, JSON.stringify({
    status: "verified",
    verifier: "lean4",
    sourceHash: "source-hash-test",
    theoremNames: [input.theoremName],
    theoremStatements: { [input.theoremName]: formalStatement },
    theoremStatementHashes: { [input.theoremName]: tcb.theoremStatementHash },
    toolchainHash: "toolchain-hash-test",
    sandboxPolicyHash: "sandbox-policy-hash-test",
    projectPinned: input.projectPinned,
    tcb,
    proofObligationArtifactIds: input.proofObligationArtifactIds,
    inputArtifactId: "art-lean-input",
    projectArtifactId: "art-lean-project",
    sandboxPolicyArtifactId: tcb.sandboxPolicyArtifactId,
    stdoutArtifactId: "art-lean-stdout",
    stderrArtifactId: "art-lean-stderr"
  }, null, 2), "lean.result");
}

function defaultFormalStatement(theoremName: string): string {
  if (theoremName === "one_plus_one") return "theorem one_plus_one : 1 + 1 = 2";
  return `theorem ${theoremName} : True`;
}

function leanTcb(theoremName: string, formalStatement: string) {
  return {
    format: "matematica.lean-tcb" as const,
    version: 1 as const,
    theoremName,
    theoremStatementHash: createHash("sha256").update(formalStatement).digest("hex"),
    proofFileHash: "source-hash-test",
    leanBinaryHash: "lean-binary-hash-test",
    lakeBinaryHash: "lake-binary-hash-test",
    leanToolchain: "leanprover/lean4:v4.10.0",
    lakeManifestHash: "lake-manifest-hash-test",
    lakefileHash: "lakefile-hash-test",
    mathlibRevision: "mathlib-rev-test",
    verifierCommand: ["lake", "env", "lean", "Main.lean"],
    verifierCommandHash: "verifier-command-hash-test",
    sandboxPolicyHash: "sandbox-policy-hash-test",
    sandboxPolicyArtifactId: "art-lean-sandbox-policy",
    exactExitResultHash: "exact-exit-result-hash-test",
    stdoutHash: "stdout-hash-test",
    stderrHash: "stderr-hash-test",
    exitCode: 0
  };
}

function equivalentReview(overrides: Partial<TheoremEquivalenceReview> = {}): TheoremEquivalenceReview {
  const review: Omit<TheoremEquivalenceReview, "auditBundle"> = {
    originalProblem: "Prove 1 + 1 = 2",
    normalizedStatement: "theorem one_plus_one : 1 + 1 = 2",
    formalStatement: "theorem one_plus_one : 1 + 1 = 2",
    assumptions: [],
    conclusion: "1 + 1 = 2",
    ambiguityNotes: [],
    statementDiffs: [],
    reviewer: "independent-equivalence-reviewer",
    reviewerDisagreement: false,
  };
  const merged = { ...review, ...overrides };
  return {
    ...merged,
    auditBundle: overrides.auditBundle ?? {
      format: "matematica.formal-equivalence-audit-bundle",
      version: 1,
      originalProblem: merged.originalProblem,
      normalizedTheorem: merged.normalizedStatement,
      leanTheorem: merged.formalStatement,
      assumptionDiff: {
        originalAssumptions: [],
        formalAssumptions: merged.assumptions,
        addedAssumptions: [],
        removedAssumptions: [],
        hiddenAssumptions: []
      },
      allowedAssumptionPolicy: {
        allowAddedAssumptions: false,
        allowedAddedAssumptions: [],
        reason: "conformance policy forbids added assumptions"
      },
      independentReview: merged,
      decision: {
        equivalent: merged.statementDiffs.length === 0 && !merged.reviewerDisagreement,
        status: merged.statementDiffs.length === 0 && !merged.reviewerDisagreement ? "equivalent" : "mismatch",
        reviewer: merged.reviewer,
        reviewerIndependent: merged.reviewer !== "lean4",
        blockingReasons: merged.statementDiffs
      },
      bundleHash: "conformance-formal-equivalence-audit-bundle"
    }
  };
}

function verifiedObligationGraph(
  claimId: string,
  artifactIds: string[],
  status: ProofObligationStatus
): ProofObligationGraph {
  return {
    rootClaimId: claimId,
    obligations: [{
      id: claimId,
      statement: `obligation for ${claimId}`,
      assumptions: [],
      conclusion: `conclusion for ${claimId}`,
      dependencies: [],
      dependencyEventIds: [],
      status,
      verifierId: status === "lean_checked" ? "lean4" : "counterexample-checker",
      artifactIds,
      counterexampleSearches: [
        { method: "numeric", outcome: "not_applicable", artifactIds },
        { method: "symbolic", outcome: "not_applicable", artifactIds },
        { method: "random", outcome: "not_applicable", artifactIds },
        { method: "domain_specific", outcome: "not_applicable", artifactIds }
      ]
    }]
  };
}
