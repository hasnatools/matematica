import { expect, test } from "bun:test";
import type { Artifact, LedgerEvent } from "../src/domain";
import type { FormalClaimContract } from "../src/evidence";
import { buildProofCertificate } from "../src/proof-certificate";

test("proof certificate minimizes verified computation support to replayable artifacts and event hashes", () => {
  const artifacts = [
    artifact("art-executable", "computation.executable"),
    artifact("art-primary", "verifier.local.result"),
    artifact("art-independent", "verifier.local.independent-checker.result"),
    artifact("art-counterexample", "counterexample.search"),
    artifact("art-proof", "proof.obligations"),
    artifact("art-claim-graph", "claim.graph.review"),
    artifact("art-clean-home-replay", "proof.replay.transcript"),
    artifact("art-extra-transcript", "ai.transcript")
  ];
  const events = [
    event("evt-primary", "verifier.completed", ["art-primary"]),
    event("evt-independent", "verifier.completed", ["art-independent"]),
    event("evt-counterexample", "counterexample.search.reviewed", ["art-counterexample"]),
    event("evt-proof", "proof.obligations.reviewed", ["art-proof"]),
    event("evt-claim-graph", "claim.graph.reviewed", ["art-claim-graph"])
  ];

  const certificate = buildProofCertificate({
    runId: "run-cert",
    claim: computationClaim(),
    satisfyingArtifactIds: artifacts.map((item) => item.id),
    artifacts,
    events,
    cleanHomeReplay: cleanHomeReplay()
  });

  expect(certificate.status).toBe("passed");
  expect(certificate.minimized).toBe(true);
  expect(certificate.offlineReplay).toMatchObject({
    verified: true,
    mode: "clean_home_import_offline_final_replay",
    transcriptArtifactId: "art-clean-home-replay",
    transcriptArtifactHash: "sha-art-clean-home-replay",
    transcriptHash: "sha-art-clean-home-replay",
    bundleExpectationHash: "bundle-hash",
    importOk: true,
    replayOk: true,
    finalVerificationOk: true,
    simulated: false,
    privatePathDetected: false,
    providerKeysPresent: false,
    networkPolicy: "no_new_network_or_provider_calls"
  });
  expect(certificate.dependencyEvents).toEqual([
    expect.objectContaining({ eventId: "evt-counterexample", eventHash: "hash-evt-counterexample", payloadHash: "payload-evt-counterexample" }),
    expect.objectContaining({ eventId: "evt-independent", eventHash: "hash-evt-independent", payloadHash: "payload-evt-independent" }),
    expect.objectContaining({ eventId: "evt-primary", eventHash: "hash-evt-primary", payloadHash: "payload-evt-primary" })
  ]);
  expect(certificate.artifactRefs.map((ref) => ref.artifactId)).toEqual([
    "art-claim-graph",
    "art-counterexample",
    "art-proof",
    "art-clean-home-replay",
    "art-executable",
    "art-independent",
    "art-primary"
  ]);
  expect(certificate.exclusions).toEqual([{
    artifactId: "art-extra-transcript",
    kind: "ai.transcript",
    reason: "Not required by the minimized proof-obligation certificate."
  }]);
  expect(certificate.certificateHash).toMatch(/^[a-f0-9]{64}$/);
});

test("proof certificate rejects non-proof artifacts and missing dependency hashes", () => {
  const artifacts = [
    artifact("art-executable", "computation.executable"),
    artifact("art-primary", "ai.response"),
    artifact("art-independent", "verifier.local.independent-checker.result"),
    artifact("art-counterexample", "counterexample.search"),
    artifact("art-clean-home-replay", "proof.replay.transcript", { sha256: "actual-transcript-hash" })
  ];
  const events = [
    event("evt-primary", "verifier.completed", ["art-primary"], { eventHash: "", payloadHash: "" }),
    event("evt-independent", "verifier.completed", ["art-independent"]),
    event("evt-counterexample", "counterexample.search.reviewed", ["art-counterexample"])
  ];

  const certificate = buildProofCertificate({
    runId: "run-cert",
    claim: computationClaim(),
    satisfyingArtifactIds: artifacts.map((item) => item.id),
    artifacts,
    events,
    cleanHomeReplay: {
      ...cleanHomeReplay(),
      transcriptArtifactHash: "expected-transcript-hash",
      transcriptHash: "expected-transcript-hash",
      replayOk: false,
      simulated: true,
      privatePathDetected: true,
      failureReasons: ["clean-home replay divergence: reportHash diverged during clean-home bundle import"]
    }
  });

  expect(certificate.status).toBe("failed");
  expect(certificate.offlineReplay.verified).toBe(false);
  expect(certificate.failureReasons).toContain("certificate contains non-proof artifact art-primary:ai.response");
  expect(certificate.failureReasons).toContain("dependency event evt-primary is missing replay hashes");
  expect(certificate.failureReasons).toContain("clean-home offline replay transcript is simulated");
  expect(certificate.failureReasons).toContain("clean-home offline replay failed");
  expect(certificate.failureReasons).toContain("clean-home offline replay transcript contains private paths");
  expect(certificate.failureReasons).toContain("clean-home replay transcript hash drifted from certificate artifact");
  expect(certificate.failureReasons).toContain("clean-home replay divergence: reportHash diverged during clean-home bundle import");
});

test("proof certificate rejects missing clean-home replay transcript", () => {
  const certificate = buildProofCertificate({
    runId: "run-cert",
    claim: computationClaim(),
    satisfyingArtifactIds: ["art-primary"],
    artifacts: [artifact("art-primary", "verifier.local.result")],
    events: [event("evt-primary", "verifier.completed", ["art-primary"])]
  });

  expect(certificate.status).toBe("failed");
  expect(certificate.failureReasons).toContain("proof certificate is missing clean-home offline replay transcript");
});

function computationClaim(): FormalClaimContract {
  return {
    id: "claim-cert",
    claimType: "numerical_evidence",
    verifierId: "local-deterministic-v0",
    assumptions: [],
    conclusion: "1 + 1 = 2",
    dependencies: [],
    verifierStatus: "verified",
    evidenceGrade: "verified_computation",
    verifierArtifactIds: ["art-primary"],
    supportingVerifierResults: [{
      verifierId: "arithmetic-independent-checker",
      role: "independent_checker",
      claimType: "numerical_evidence",
      verifierStatus: "verified",
      evidenceGrade: "verified_computation",
      artifactIds: ["art-independent"]
    }],
    formalization: { status: "not_required" },
    proofObligationGraph: {
      rootClaimId: "claim-cert",
      obligations: [{
        id: "claim-cert",
        statement: "Check exact arithmetic",
        assumptions: [],
        conclusion: "1 + 1 = 2",
        dependencies: [],
        dependencyEventIds: ["evt-primary", "evt-independent", "evt-counterexample"],
        status: "computational_evidence",
        verifierId: "local-deterministic-v0",
        artifactIds: ["art-executable", "art-primary", "art-independent", "art-counterexample"],
        counterexampleSearch: "passed",
        counterexampleSearches: [{
          method: "numeric",
          outcome: "passed",
          artifactIds: ["art-counterexample"]
        }],
        reproducibility: {
          executableArtifactId: "art-executable",
          command: "bun run check",
          seed: "deterministic",
          environmentHash: "env-hash",
          inputDomain: "finite arithmetic",
          boundsStatement: "closed expression",
          outputHash: "output-hash",
          independentRerunArtifactId: "art-independent",
          failureClassification: "none"
        }
      }]
    }
  };
}

function cleanHomeReplay() {
  return {
    transcriptArtifactId: "art-clean-home-replay",
    transcriptArtifactHash: "sha-art-clean-home-replay",
    transcriptHash: "sha-art-clean-home-replay",
    bundleExpectationHash: "bundle-hash",
    importOk: true,
    replayOk: true,
    finalVerificationOk: true,
    simulated: false,
    privatePathDetected: false,
    providerKeysPresent: false,
    failureReasons: []
  };
}

function artifact(id: string, kind: string, overrides: Partial<Artifact> = {}): Artifact {
  const sha256 = `sha-${id}`;
  return {
    id,
    runId: "run-cert",
    kind,
    sha256,
    contentAddress: `sha256:${sha256}`,
    mediaType: "text/plain; charset=utf-8",
    storageKey: `run-cert/${sha256}.txt`,
    path: `/tmp/${id}`,
    bytes: 10,
    createdAt: "2026-05-25T00:00:00.000Z",
    ...overrides
  };
}

function event(
  id: string,
  type: LedgerEvent["type"],
  artifactIds: string[],
  hashes: { eventHash?: string; payloadHash?: string } = {}
): LedgerEvent {
  return {
    id,
    runId: "run-cert",
    type,
    payload: {},
    artifactIds,
    createdAt: "2026-05-25T00:00:00.000Z",
    eventHash: hashes.eventHash ?? `hash-${id}`,
    payloadHash: hashes.payloadHash ?? `payload-${id}`
  };
}
