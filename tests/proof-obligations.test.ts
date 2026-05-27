import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Artifact } from "../src/domain";
import type { LedgerEvent } from "../src/domain";
import { evaluateProofObligationGraph, makeProofObligationGraph, traceProofObligations } from "../src/proof-obligations";

test("proof obligation graph accepts verified dependency DAG", () => {
  const rootArtifact = makeArtifact("art-root", "root proof");
  const lemmaArtifact = makeArtifact("art-lemma", "lemma proof");
  try {
    const graph = makeProofObligationGraph({
      rootClaimId: "claim-root",
      obligations: [
        {
          id: "lemma-1",
          statement: "lemma one",
          assumptions: [],
          conclusion: "lemma conclusion",
          dependencies: [],
          dependencyEventIds: ["evt-lemma"],
          status: "lean_checked",
          verifierId: "lean4",
          artifactIds: [lemmaArtifact.id],
          counterexampleSearch: "passed"
        },
        {
          id: "claim-root",
          statement: "root theorem",
          assumptions: [],
          conclusion: "root conclusion",
          dependencies: ["lemma-1"],
          dependencyEventIds: ["evt-root"],
          status: "semantic",
          verifierId: "semantic-checker",
          artifactIds: [rootArtifact.id],
          counterexampleSearch: "passed"
        }
      ]
    });

    const decision = evaluateProofObligationGraph(graph, [rootArtifact, lemmaArtifact], {
      requireCounterexampleSearch: true,
      events: [event("evt-lemma"), event("evt-root")]
    });
    expect(decision.ok).toBe(true);
    expect(decision.unresolvedObligations).toHaveLength(0);
    expect(decision.missingDependencyEvents).toHaveLength(0);
    expect(traceProofObligations(graph).orderedObligationIds).toEqual(["lemma-1", "claim-root"]);
  } finally {
    cleanupArtifact(rootArtifact);
    cleanupArtifact(lemmaArtifact);
  }
});

test("proof obligation graph requires method-level counterexample pressure", () => {
  const proofArtifact = makeArtifact("art-method-proof", "root proof");
  const numericArtifact = makeArtifact("art-method-numeric", "checked small numeric cases");
  const symbolicArtifact = makeArtifact("art-method-symbolic", "symbolic simplification found no contradiction");
  const randomArtifact = makeArtifact("art-method-random", "random search seed 123 found no counterexample");
  const domainArtifact = makeArtifact("art-method-domain", "domain-specific boundary cases passed");
  try {
    const graph = makeProofObligationGraph({
      rootClaimId: "claim-methods",
      obligations: [{
        id: "claim-methods",
        statement: "forall n : Nat, P n",
        assumptions: [],
        conclusion: "P n",
        dependencies: [],
        dependencyEventIds: ["evt-methods"],
        status: "semantic",
        verifierId: "semantic-checker",
        artifactIds: [proofArtifact.id],
        counterexampleSearches: [
          { method: "numeric", outcome: "passed", checkedCases: 100, artifactIds: [numericArtifact.id] },
          { method: "symbolic", outcome: "passed", artifactIds: [symbolicArtifact.id] },
          { method: "random", outcome: "passed", seed: "123", checkedCases: 1000, artifactIds: [randomArtifact.id] },
          { method: "domain_specific", outcome: "passed", domain: "Nat boundary cases", artifactIds: [domainArtifact.id] }
        ]
      }]
    });

    const decision = evaluateProofObligationGraph(graph, [
      proofArtifact,
      numericArtifact,
      symbolicArtifact,
      randomArtifact,
      domainArtifact
    ], {
      requireCounterexampleSearch: true,
      events: [event("evt-methods")]
    });

    expect(decision.ok).toBe(true);
    expect(decision.counterexampleGaps).toHaveLength(0);
    expect(decision.missingCounterexampleMethods).toHaveLength(0);
    expect(decision.foundCounterexamples).toHaveLength(0);
  } finally {
    cleanupArtifact(proofArtifact);
    cleanupArtifact(numericArtifact);
    cleanupArtifact(symbolicArtifact);
    cleanupArtifact(randomArtifact);
    cleanupArtifact(domainArtifact);
  }
});

test("proof obligation graph blocks found counterexamples and incomplete search methods", () => {
  const proofArtifact = makeArtifact("art-counterexample-proof", "root proof");
  const numericArtifact = makeArtifact("art-counterexample-numeric", "n = 0 violates P");
  try {
    const graph = makeProofObligationGraph({
      rootClaimId: "claim-counterexample-found",
      obligations: [{
        id: "claim-counterexample-found",
        statement: "forall n : Nat, P n",
        assumptions: [],
        conclusion: "P n",
        dependencies: [],
        dependencyEventIds: ["evt-counterexample"],
        status: "semantic",
        verifierId: "semantic-checker",
        artifactIds: [proofArtifact.id],
        counterexampleSearches: [
          { method: "numeric", outcome: "found", counterexample: "n = 0", checkedCases: 1, artifactIds: [numericArtifact.id] },
          { method: "symbolic", outcome: "attempted", artifactIds: [] },
          { method: "random", outcome: "not_run", artifactIds: [] },
          { method: "domain_specific", outcome: "not_applicable", artifactIds: [] }
        ]
      }]
    });

    const decision = evaluateProofObligationGraph(graph, [proofArtifact, numericArtifact], {
      requireCounterexampleSearch: true,
      events: [event("evt-counterexample")]
    });

    expect(decision.ok).toBe(false);
    expect(decision.foundCounterexamples).toEqual([{
      obligationId: "claim-counterexample-found",
      method: "numeric",
      counterexample: "n = 0",
      artifactIds: [numericArtifact.id]
    }]);
    expect(decision.counterexampleGaps.map((item) => item.id)).toContain("claim-counterexample-found");
    expect(decision.missingCounterexampleMethods).toEqual([
      { obligationId: "claim-counterexample-found", method: "numeric" },
      { obligationId: "claim-counterexample-found", method: "symbolic" },
      { obligationId: "claim-counterexample-found", method: "random" }
    ]);
  } finally {
    cleanupArtifact(proofArtifact);
    cleanupArtifact(numericArtifact);
  }
});

test("proof obligation graph blocks open invalid missing and counterexample-gap obligations", () => {
  const artifact = makeArtifact("art-root-open", "root proof");
  try {
    const graph = makeProofObligationGraph({
      rootClaimId: "claim-root",
      obligations: [{
        id: "claim-root",
        statement: "root theorem",
        assumptions: ["unproven assumption"],
        conclusion: "root conclusion",
        dependencies: ["missing-lemma"],
        dependencyEventIds: ["missing-event"],
        status: "unchecked",
        artifactIds: ["missing-artifact"],
        counterexampleSearch: "not_run"
      }, {
        id: "bad-lemma",
        statement: "bad lemma",
        assumptions: [],
        conclusion: "false",
        dependencies: [],
        dependencyEventIds: ["evt-bad"],
        status: "contradicted",
        artifactIds: [artifact.id],
        counterexampleSearch: "found"
      }]
    });

    const decision = evaluateProofObligationGraph(graph, [artifact], {
      requireCounterexampleSearch: true,
      events: [event("evt-bad")]
    });
    expect(decision.ok).toBe(false);
    expect(decision.unresolvedObligations.map((item) => item.id)).toContain("claim-root");
    expect(decision.invalidObligations.map((item) => item.id)).toContain("bad-lemma");
    expect(decision.missingDependencies).toEqual([{ obligationId: "claim-root", dependencyId: "missing-lemma" }]);
    expect(decision.missingDependencyEvents).toEqual([{ obligationId: "claim-root", eventId: "missing-event" }]);
    expect(decision.missingArtifacts).toEqual([{ obligationId: "claim-root", artifactId: "missing-artifact" }]);
    expect(decision.counterexampleGaps.map((item) => item.id)).toContain("claim-root");
    const trace = traceProofObligations(graph);
    expect(trace.ok).toBe(false);
    expect(trace.missingDependencyIds).toEqual(["missing-lemma"]);
  } finally {
    cleanupArtifact(artifact);
  }
});

test("proof obligation graph treats informal and independently rejected obligations as blocking", () => {
  const artifact = makeArtifact("art-explicit-status", "reviewed obligation");
  try {
    const graph = makeProofObligationGraph({
      rootClaimId: "claim-explicit-status",
      obligations: [{
        id: "claim-explicit-status",
        statement: "root theorem",
        assumptions: [],
        conclusion: "root conclusion",
        dependencies: ["informal-lemma", "rejected-lemma"],
        dependencyEventIds: [],
        status: "computational_evidence",
        verifierId: "computational-checker",
        artifactIds: [artifact.id],
        counterexampleSearch: "passed"
      }, {
        id: "informal-lemma",
        statement: "informal lemma",
        assumptions: [],
        conclusion: "not machine checked",
        dependencies: [],
        dependencyEventIds: [],
        status: "informal_unverified",
        artifactIds: [artifact.id],
        counterexampleSearch: "attempted"
      }, {
        id: "rejected-lemma",
        statement: "rejected lemma",
        assumptions: [],
        conclusion: "false lemma",
        dependencies: [],
        dependencyEventIds: [],
        status: "independently_rejected",
        verifierId: "adversarial-reviewer",
        artifactIds: [artifact.id],
        counterexampleSearch: "found"
      }]
    });

    const decision = evaluateProofObligationGraph(graph, [artifact]);
    expect(decision.ok).toBe(false);
    expect(decision.unresolvedObligations.map((item) => item.id)).toContain("informal-lemma");
    expect(decision.invalidObligations.map((item) => item.id)).toContain("rejected-lemma");
    const trace = traceProofObligations(graph);
    expect(trace.unresolvedObligationIds).toContain("informal-lemma");
  } finally {
    cleanupArtifact(artifact);
  }
});

test("proof obligation graph rejects cyclic verified-looking dependencies", () => {
  const rootArtifact = makeArtifact("art-cycle-root", "root proof");
  const lemmaArtifact = makeArtifact("art-cycle-lemma", "lemma proof");
  try {
    const graph = makeProofObligationGraph({
      rootClaimId: "claim-cycle-root",
      obligations: [{
        id: "claim-cycle-root",
        statement: "root theorem",
        assumptions: [],
        conclusion: "root conclusion",
        dependencies: ["cycle-lemma"],
        dependencyEventIds: ["evt-root"],
        status: "lean_checked",
        verifierId: "lean4",
        artifactIds: [rootArtifact.id],
        counterexampleSearch: "passed"
      }, {
        id: "cycle-lemma",
        statement: "cyclic lemma",
        assumptions: [],
        conclusion: "lemma conclusion",
        dependencies: ["claim-cycle-root"],
        dependencyEventIds: ["evt-lemma"],
        status: "lean_checked",
        verifierId: "lean4",
        artifactIds: [lemmaArtifact.id],
        counterexampleSearch: "passed"
      }]
    });

    const decision = evaluateProofObligationGraph(graph, [rootArtifact, lemmaArtifact], {
      events: [event("evt-root"), event("evt-lemma")]
    });
    expect(decision.ok).toBe(false);
    expect(decision.cyclicDependencies).toEqual([{
      obligationId: "cycle-lemma",
      dependencyId: "claim-cycle-root"
    }]);
    expect(decision.structuralGaps.some((gap) => gap.reason.includes("cyclic dependency"))).toBe(true);
    expect(traceProofObligations(graph).cycleDetected).toBe(true);
  } finally {
    cleanupArtifact(rootArtifact);
    cleanupArtifact(lemmaArtifact);
  }
});

test("proof obligation graph rejects duplicate ids missing roots and blocking orphans", () => {
  const artifact = makeArtifact("art-structure", "proof");
  try {
    const missingRootGraph = makeProofObligationGraph({
      rootClaimId: "missing-root",
      obligations: [{
        id: "orphan",
        statement: "orphan theorem",
        assumptions: [],
        conclusion: "orphan conclusion",
        dependencies: [],
        dependencyEventIds: [],
        status: "lean_checked",
        verifierId: "lean4",
        artifactIds: [artifact.id],
        counterexampleSearch: "passed"
      }]
    });
    const missingRoot = evaluateProofObligationGraph(missingRootGraph, [artifact]);
    expect(missingRoot.ok).toBe(false);
    expect(missingRoot.structuralGaps.map((gap) => gap.reason)).toContain("root claim is missing from obligations");
    expect(missingRoot.unreachableObligations.map((item) => item.id)).toEqual(["orphan"]);

    const duplicateGraph = makeProofObligationGraph({
      rootClaimId: "claim-root",
      obligations: [{
        id: "claim-root",
        statement: "root theorem",
        assumptions: [],
        conclusion: "root conclusion",
        dependencies: ["dup"],
        dependencyEventIds: [],
        status: "lean_checked",
        verifierId: "lean4",
        artifactIds: [artifact.id],
        counterexampleSearch: "passed"
      }, {
        id: "dup",
        statement: "first duplicate",
        assumptions: [],
        conclusion: "dup conclusion",
        dependencies: [],
        dependencyEventIds: [],
        status: "lean_checked",
        verifierId: "lean4",
        artifactIds: [artifact.id],
        counterexampleSearch: "passed"
      }, {
        id: "dup",
        statement: "second duplicate",
        assumptions: [],
        conclusion: "dup conclusion",
        dependencies: [],
        dependencyEventIds: [],
        status: "lean_checked",
        verifierId: "lean4",
        artifactIds: [artifact.id],
        counterexampleSearch: "passed"
      }, {
        id: "nonblocking-note",
        statement: "background note",
        assumptions: [],
        conclusion: "not needed for root",
        dependencies: [],
        dependencyEventIds: [],
        status: "informal_unverified",
        artifactIds: [],
        nonblocking: true
      }]
    });
    const duplicate = evaluateProofObligationGraph(duplicateGraph, [artifact]);
    expect(duplicate.ok).toBe(false);
    expect(duplicate.duplicateObligationIds).toEqual(["dup"]);
    expect(duplicate.unreachableObligations.map((item) => item.id)).not.toContain("nonblocking-note");
  } finally {
    cleanupArtifact(artifact);
  }
});

test("proof obligation graph rejects verified obligations without verifier output integrity", () => {
  const artifact = makeArtifact("art-event-type", "proof");
  try {
    const graph = makeProofObligationGraph({
      rootClaimId: "claim-missing-verifier",
      obligations: [{
        id: "claim-missing-verifier",
        statement: "root theorem",
        assumptions: [],
        conclusion: "root conclusion",
        dependencies: [],
        dependencyEventIds: ["evt-wrong-type"],
        status: "lean_checked",
        artifactIds: [],
        counterexampleSearch: "passed"
      }]
    });

    const decision = evaluateProofObligationGraph(graph, [artifact], {
      events: [event("evt-wrong-type", "goal.created")]
    });
    expect(decision.ok).toBe(false);
    expect(decision.structuralGaps).toEqual(expect.arrayContaining([
      { obligationId: "claim-missing-verifier", field: "verifierId", reason: "verified obligation is missing verifier id" },
      { obligationId: "claim-missing-verifier", field: "artifactIds", reason: "verified obligation is missing verifier output artifact" }
    ]));
    expect(decision.invalidDependencyEvents).toEqual([{
      obligationId: "claim-missing-verifier",
      eventId: "evt-wrong-type",
      eventType: "goal.created",
      reason: "dependency event type does not record proof-supporting evidence"
    }]);
  } finally {
    cleanupArtifact(artifact);
  }
});

test("formal proof target rejects semantic and externally cited obligation discharge", () => {
  const semanticArtifact = makeArtifact("art-semantic-only", "semantic review");
  const citationArtifact = makeArtifact("art-citation-only", "citation review");
  try {
    const graph = makeProofObligationGraph({
      rootClaimId: "claim-semantic-only",
      obligations: [{
        id: "claim-semantic-only",
        statement: "root theorem",
        assumptions: [],
        conclusion: "root conclusion",
        dependencies: ["cited-lemma"],
        dependencyEventIds: [],
        status: "semantic",
        verifierId: "semantic-reviewer",
        artifactIds: [semanticArtifact.id],
        counterexampleSearch: "passed"
      }, {
        id: "cited-lemma",
        statement: "cited lemma",
        assumptions: [],
        conclusion: "lemma conclusion",
        dependencies: [],
        dependencyEventIds: [],
        status: "externally_cited",
        verifierId: "citation-reviewer",
        artifactIds: [citationArtifact.id],
        counterexampleSearch: "passed"
      }]
    });

    const decision = evaluateProofObligationGraph(graph, [semanticArtifact, citationArtifact], {
      evidenceGrade: "formal_proof",
      requireCounterexampleSearch: true
    });
    expect(decision.ok).toBe(false);
    expect(decision.insufficientVerification).toEqual([
      {
        obligationId: "claim-semantic-only",
        status: "semantic",
        targetEvidenceGrade: "formal_proof",
        reason: "formal_proof obligations require lean_checked discharge; semantic can only support context or reductions"
      },
      {
        obligationId: "cited-lemma",
        status: "externally_cited",
        targetEvidenceGrade: "formal_proof",
        reason: "formal_proof obligations require lean_checked discharge; externally_cited can only support context or reductions"
      }
    ]);
    expect(decision.unresolvedObligations.map((item) => item.id)).toEqual(["claim-semantic-only", "cited-lemma"]);
  } finally {
    cleanupArtifact(semanticArtifact);
    cleanupArtifact(citationArtifact);
  }
});

test("hard proof obligations reject literature snapshots as verifier discharge", () => {
  const sourceArtifact = makeArtifact("art-source-proof-obligation", "citation snapshot", "source.arxiv.results");
  try {
    const graph = makeProofObligationGraph({
      rootClaimId: "claim-source-obligation",
      obligations: [{
        id: "claim-source-obligation",
        statement: "root theorem",
        assumptions: [],
        conclusion: "root conclusion",
        dependencies: [],
        dependencyEventIds: ["evt-source-citation"],
        status: "lean_checked",
        verifierId: "lean4",
        artifactIds: [sourceArtifact.id],
        counterexampleSearch: "passed"
      }]
    });

    const decision = evaluateProofObligationGraph(graph, [sourceArtifact], {
      evidenceGrade: "formal_proof",
      events: [event("evt-source-citation", "source.citations.reviewed")]
    });

    expect(decision.ok).toBe(false);
    expect(decision.untrustedLiteratureEvidence).toEqual([{
      obligationId: "claim-source-obligation",
      artifactId: sourceArtifact.id,
      artifactKind: "source.arxiv.results",
      reason: "literature and citation artifacts are untrusted context, not verifier evidence"
    }]);
    expect(decision.invalidDependencyEvents).toEqual([{
      obligationId: "claim-source-obligation",
      eventId: "evt-source-citation",
      eventType: "source.citations.reviewed",
      reason: "literature and citation events are provenance context, not proof-supporting evidence"
    }]);
  } finally {
    cleanupArtifact(sourceArtifact);
  }
});

test("verified computation target requires executable reproducibility manifest", () => {
  const primaryArtifact = makeArtifact("art-computation-primary", "computation output");
  const rerunArtifact = makeArtifact("art-computation-rerun", "independent rerun output");
  try {
    const missingManifestGraph = makeProofObligationGraph({
      rootClaimId: "claim-computation-missing-manifest",
      obligations: [{
        id: "claim-computation-missing-manifest",
        statement: "deterministic computation",
        assumptions: [],
        conclusion: "computed result",
        dependencies: [],
        dependencyEventIds: [],
        status: "computational_evidence",
        verifierId: "computational-checker",
        artifactIds: [primaryArtifact.id],
        counterexampleSearch: "passed"
      }]
    });
    const missingManifest = evaluateProofObligationGraph(missingManifestGraph, [primaryArtifact], {
      evidenceGrade: "verified_computation"
    });
    expect(missingManifest.ok).toBe(false);
    expect(missingManifest.missingReproducibilityManifests).toEqual([{
      obligationId: "claim-computation-missing-manifest",
      field: "reproducibility",
      reason: "computational evidence requires an executable reproducibility manifest"
    }]);

    const partialManifestGraph = makeProofObligationGraph({
      rootClaimId: "claim-computation-partial-manifest",
      obligations: [{
        id: "claim-computation-partial-manifest",
        statement: "deterministic computation",
        assumptions: [],
        conclusion: "computed result",
        dependencies: [],
        dependencyEventIds: [],
        status: "computational_evidence",
        verifierId: "computational-checker",
        artifactIds: [primaryArtifact.id, rerunArtifact.id],
        reproducibility: {
          executableArtifactId: primaryArtifact.id,
          command: "computation --replay",
          seed: "",
          environmentHash: "env-hash",
          inputDomain: "finite integer arithmetic",
          boundsStatement: "",
          outputHash: "output-hash",
          independentRerunArtifactId: rerunArtifact.id,
          failureClassification: "unknown"
        } as never,
        counterexampleSearch: "passed"
      }]
    });
    const partialManifest = evaluateProofObligationGraph(partialManifestGraph, [primaryArtifact, rerunArtifact], {
      evidenceGrade: "verified_computation"
    });
    expect(partialManifest.ok).toBe(false);
    expect(partialManifest.missingReproducibilityManifests).toEqual([
      {
        obligationId: "claim-computation-partial-manifest",
        field: "reproducibility.seed",
        reason: "computational reproducibility manifest field is missing"
      },
      {
        obligationId: "claim-computation-partial-manifest",
        field: "reproducibility.boundsStatement",
        reason: "computational reproducibility manifest field is missing"
      },
      {
        obligationId: "claim-computation-partial-manifest",
        field: "reproducibility.failureClassification",
        reason: "computational reproducibility failure classification is invalid"
      }
    ]);

    const validGraph = makeProofObligationGraph({
      rootClaimId: "claim-computation-valid",
      obligations: [{
        id: "claim-computation-valid",
        statement: "deterministic computation",
        assumptions: [],
        conclusion: "computed result",
        dependencies: [],
        dependencyEventIds: [],
        status: "computational_evidence",
        verifierId: "computational-checker",
        artifactIds: [primaryArtifact.id, rerunArtifact.id],
        reproducibility: {
          executableArtifactId: primaryArtifact.id,
          command: "computation --replay",
          seed: "seed-1",
          environmentHash: "env-hash",
          inputDomain: "finite integer arithmetic",
          boundsStatement: "checks integers in the closed finite input set",
          outputHash: "output-hash",
          independentRerunArtifactId: rerunArtifact.id,
          failureClassification: "none"
        },
        counterexampleSearch: "passed"
      }]
    });
    const valid = evaluateProofObligationGraph(validGraph, [primaryArtifact, rerunArtifact], {
      evidenceGrade: "verified_computation"
    });
    expect(valid.ok).toBe(true);
    expect(valid.missingReproducibilityManifests).toHaveLength(0);
  } finally {
    cleanupArtifact(primaryArtifact);
    cleanupArtifact(rerunArtifact);
  }
});

function makeArtifact(id: string, content: string, kind = "proof.test"): Artifact {
  const dir = mkdtempSync(join(tmpdir(), "matematica-proof-obligation-test-"));
  const path = join(dir, `${id}.txt`);
  writeFileSync(path, content);
  const sha256 = createHash("sha256").update(content).digest("hex");
  return {
    id,
    runId: "run-test",
    kind,
    sha256,
    contentAddress: `sha256:${sha256}`,
    mediaType: "text/plain; charset=utf-8",
    storageKey: `run-test/${sha256}.txt`,
    path,
    bytes: Buffer.byteLength(content),
    createdAt: new Date().toISOString()
  };
}

function event(id: string, type: LedgerEvent["type"] = "verifier.completed"): LedgerEvent {
  return {
    id,
    runId: "run-test",
    type,
    payload: {},
    artifactIds: [],
    createdAt: new Date().toISOString()
  };
}

function cleanupArtifact(artifact: Artifact): void {
  rmSync(dirname(artifact.path), { recursive: true, force: true });
}
