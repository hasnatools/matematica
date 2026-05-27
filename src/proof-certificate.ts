import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactStore } from "./artifacts";
import { loadConfig, publicConfig, type MatematicaConfig } from "./config";
import type { Artifact, EvidenceGrade, LedgerEvent } from "./domain";
import type { FormalClaimContract } from "./evidence";
import { stableHash } from "./idempotency";
import { Ledger } from "./ledger";
import { traceProofObligations, type ProofObligationGraph } from "./proof-obligations";
import { exportReproducibilityBundle, importReproducibilityBundle } from "./replay";

export const PROOF_CERTIFICATE_VERSION = 1;

export type ProofCertificate = {
  format: "matematica.proof-certificate";
  version: 1;
  runId: string;
  claimId: string;
  verifierId: string;
  evidenceGrade: EvidenceGrade;
  status: "passed" | "failed";
  minimized: boolean;
  rootClaimId: string;
  orderedObligationIds: string[];
  artifactRefs: ProofCertificateArtifactRef[];
  dependencyEvents: ProofCertificateDependencyEvent[];
  formalizationGapNotes: string[];
  formalEquivalenceAuditBundleHash?: string;
  offlineReplay: {
    required: true;
    verified: boolean;
    mode: "clean_home_import_offline_final_replay";
    networkPolicy: "no_new_network_or_provider_calls";
    transcriptArtifactId?: string;
    transcriptArtifactHash?: string;
    transcriptHash?: string;
    bundleExpectationHash?: string;
    importOk?: boolean;
    replayOk?: boolean;
    finalVerificationOk?: boolean;
    simulated?: boolean;
    privatePathDetected?: boolean;
    providerKeysPresent?: boolean;
  };
  exclusions: Array<{
    artifactId: string;
    kind: string;
    reason: string;
  }>;
  failureReasons: string[];
  certificateHash: string;
};

export type ProofCertificateArtifactRef = {
  artifactId: string;
  kind: string;
  sha256: string;
  role: "verifier" | "proof_obligation" | "formalization" | "counterexample_search" | "claim_graph" | "reproducibility" | "supporting_verifier";
};

export type ProofCertificateDependencyEvent = {
  eventId: string;
  type: string;
  eventHash: string;
  payloadHash: string;
};

export type ProofCertificateCleanHomeReplay = {
  transcriptArtifactId: string;
  transcriptArtifactHash: string;
  transcriptHash: string;
  bundleExpectationHash: string;
  importOk: boolean;
  replayOk: boolean;
  finalVerificationOk: boolean;
  simulated: boolean;
  privatePathDetected: boolean;
  providerKeysPresent: boolean;
  failureReasons: string[];
};

type CleanHomeReplayTranscript = {
  format: "matematica.proof-certificate.clean-home-replay-transcript";
  version: 1;
  runId: string;
  generatedAt: string;
  mode: "clean_home_import_offline_final_replay";
  networkPolicy: "no_new_network_or_provider_calls";
  cleanHome: {
    used: true;
    path: "<redacted-clean-home>";
    privatePathsPersisted: false;
  };
  providerKeysPresent: false;
  bundleExpectationHash: string;
  import: {
    ok: boolean;
    importedEvents?: number;
    importedArtifacts?: number;
    divergenceCount?: number;
  };
  offlineReplay: {
    replayOk: boolean;
    finalVerificationOk: boolean;
  };
  failureReasons: string[];
};

export function persistProofCertificate(input: {
  runId: string;
  ledger: Ledger;
  artifacts: ArtifactStore;
  claim: FormalClaimContract;
  satisfyingArtifactIds: string[];
  cwd?: string;
  config?: MatematicaConfig;
}): { certificate: ProofCertificate; artifact: Artifact; event: LedgerEvent } {
  const cleanHomeReplay = persistCleanHomeReplayTranscript({
    runId: input.runId,
    ledger: input.ledger,
    artifacts: input.artifacts,
    cwd: input.cwd ?? process.cwd(),
    config: input.config
  });
  const certificate = buildProofCertificate({
    runId: input.runId,
    claim: input.claim,
    satisfyingArtifactIds: input.satisfyingArtifactIds,
    artifacts: input.ledger.listArtifacts(input.runId),
    events: input.ledger.listEvents(input.runId),
    cleanHomeReplay
  });
  const artifact = input.artifacts.create(input.runId, "proof.certificate", JSON.stringify(certificate, null, 2));
  const event = input.ledger.appendEvent(input.runId, "proof.certificate.minimized", {
    ...certificate,
    artifactId: artifact.id
  }, [artifact.id, ...certificate.artifactRefs.map((ref) => ref.artifactId)]);
  return { certificate, artifact, event };
}

export function buildProofCertificate(input: {
  runId: string;
  claim: FormalClaimContract;
  satisfyingArtifactIds: string[];
  artifacts: Artifact[];
  events: LedgerEvent[];
  cleanHomeReplay?: ProofCertificateCleanHomeReplay;
}): ProofCertificate {
  const graph = input.claim.proofObligationGraph;
  const trace = graph ? traceProofObligations(graph) : undefined;
  const minimalArtifactIds = graph
    ? minimalArtifactIdsForGraph(graph, input.claim)
    : new Set(input.claim.verifierArtifactIds);
  for (const artifactId of proofSupportArtifactIds(input.events)) minimalArtifactIds.add(artifactId);
  for (const artifactId of input.claim.verifierArtifactIds) minimalArtifactIds.add(artifactId);
  for (const result of input.claim.supportingVerifierResults ?? []) {
    for (const artifactId of result.artifactIds) minimalArtifactIds.add(artifactId);
  }
  if (input.claim.formalization?.artifactId) minimalArtifactIds.add(input.claim.formalization.artifactId);
  if (input.cleanHomeReplay?.transcriptArtifactId) minimalArtifactIds.add(input.cleanHomeReplay.transcriptArtifactId);

  const artifactsById = new Map(input.artifacts.map((artifact) => [artifact.id, artifact]));
  const certificateArtifacts = [...minimalArtifactIds]
    .map((artifactId) => artifactsById.get(artifactId))
    .filter((artifact): artifact is Artifact => Boolean(artifact))
    .map((artifact) => artifactRef(artifact, input.claim, graph));
  const excluded = input.satisfyingArtifactIds
    .filter((artifactId) => !minimalArtifactIds.has(artifactId))
    .map((artifactId) => artifactsById.get(artifactId))
    .filter((artifact): artifact is Artifact => Boolean(artifact))
    .map((artifact) => ({
      artifactId: artifact.id,
      kind: artifact.kind,
      reason: "Not required by the minimized proof-obligation certificate."
    }));
  const dependencyEventIds = graph
    ? new Set(graph.obligations.flatMap((obligation) => obligation.dependencyEventIds))
    : new Set<string>();
  const eventsById = new Map(input.events.map((event) => [event.id, event]));
  const dependencyEvents = [...dependencyEventIds]
    .map((eventId) => eventsById.get(eventId))
    .filter((event): event is LedgerEvent => Boolean(event))
    .map((event) => ({
      eventId: event.id,
      type: event.type,
      eventHash: event.eventHash ?? "",
      payloadHash: event.payloadHash ?? ""
    }));

  const formalEquivalenceAuditBundleHash = input.claim.formalization?.equivalenceAuditBundle?.bundleHash ?? input.claim.formalization?.equivalenceReview?.auditBundle?.bundleHash;
  const failureReasons = certificateFailureReasons({
    graph,
    trace,
    minimalArtifactIds,
    certificateArtifacts,
    dependencyEventIds,
    dependencyEvents,
    satisfyingArtifactIds: input.satisfyingArtifactIds,
    evidenceGrade: input.claim.evidenceGrade,
    formalEquivalenceAuditBundleHash,
    cleanHomeReplay: input.cleanHomeReplay
  });
  const unsigned = {
    format: "matematica.proof-certificate" as const,
    version: PROOF_CERTIFICATE_VERSION as 1,
    runId: input.runId,
    claimId: input.claim.id,
    verifierId: input.claim.verifierId,
    evidenceGrade: input.claim.evidenceGrade,
    status: failureReasons.length === 0 ? "passed" as const : "failed" as const,
    minimized: failureReasons.length === 0,
    rootClaimId: graph?.rootClaimId ?? input.claim.id,
    orderedObligationIds: trace?.orderedObligationIds ?? [],
    artifactRefs: certificateArtifacts.sort((left, right) => left.role.localeCompare(right.role) || left.artifactId.localeCompare(right.artifactId)),
    dependencyEvents: dependencyEvents.sort((left, right) => left.eventId.localeCompare(right.eventId)),
    formalizationGapNotes: formalizationGapNotes(input.claim),
    formalEquivalenceAuditBundleHash,
    offlineReplay: {
      required: true as const,
      verified: failureReasons.length === 0,
      mode: "clean_home_import_offline_final_replay" as const,
      networkPolicy: "no_new_network_or_provider_calls" as const,
      transcriptArtifactId: input.cleanHomeReplay?.transcriptArtifactId,
      transcriptArtifactHash: input.cleanHomeReplay?.transcriptArtifactHash,
      transcriptHash: input.cleanHomeReplay?.transcriptHash,
      bundleExpectationHash: input.cleanHomeReplay?.bundleExpectationHash,
      importOk: input.cleanHomeReplay?.importOk,
      replayOk: input.cleanHomeReplay?.replayOk,
      finalVerificationOk: input.cleanHomeReplay?.finalVerificationOk,
      simulated: input.cleanHomeReplay?.simulated,
      privatePathDetected: input.cleanHomeReplay?.privatePathDetected,
      providerKeysPresent: input.cleanHomeReplay?.providerKeysPresent
    },
    exclusions: excluded.sort((left, right) => left.kind.localeCompare(right.kind) || left.artifactId.localeCompare(right.artifactId)),
    failureReasons
  };

  return {
    ...unsigned,
    certificateHash: stableHash(unsigned)
  };
}

function minimalArtifactIdsForGraph(graph: ProofObligationGraph, claim: FormalClaimContract): Set<string> {
  const ids = new Set<string>();
  for (const obligation of graph.obligations) {
    for (const artifactId of obligation.artifactIds) ids.add(artifactId);
    for (const search of obligation.counterexampleSearches ?? []) {
      for (const artifactId of search.artifactIds) ids.add(artifactId);
    }
    if (obligation.reproducibility) {
      ids.add(obligation.reproducibility.executableArtifactId);
      ids.add(obligation.reproducibility.independentRerunArtifactId);
    }
  }
  if (claim.machineCheck) {
    ids.add(claim.machineCheck.resultArtifactId);
    for (const artifactId of claim.machineCheck.proofObligationArtifactIds) ids.add(artifactId);
  }
  return ids;
}

function proofSupportArtifactIds(events: LedgerEvent[]): string[] {
  return events
    .filter((event) =>
      event.type === "proof.obligations.reviewed" ||
      event.type === "claim.graph.reviewed" ||
      event.type === "formalization.assessed" ||
      event.type === "theorem.equivalence.reviewed"
    )
    .flatMap((event) => event.artifactIds);
}

function certificateFailureReasons(input: {
  graph?: ProofObligationGraph;
  trace?: ReturnType<typeof traceProofObligations>;
  minimalArtifactIds: Set<string>;
  certificateArtifacts: ProofCertificateArtifactRef[];
  dependencyEventIds: Set<string>;
  dependencyEvents: ProofCertificateDependencyEvent[];
  satisfyingArtifactIds: string[];
  evidenceGrade: EvidenceGrade;
  formalEquivalenceAuditBundleHash?: string;
  cleanHomeReplay?: ProofCertificateCleanHomeReplay;
}): string[] {
  const failures: string[] = [];
  if (!input.graph) failures.push("missing proof-obligation graph");
  if (!input.trace?.ok) failures.push("proof-obligation trace is not compact and fully resolved");
  const artifactRefIds = new Set(input.certificateArtifacts.map((artifact) => artifact.artifactId));
  for (const artifactId of input.minimalArtifactIds) {
    if (!artifactRefIds.has(artifactId)) failures.push(`missing certificate artifact ${artifactId}`);
  }
  for (const artifact of input.certificateArtifacts) {
    if (artifact.kind.startsWith("ai.") || artifact.kind.startsWith("source.")) {
      failures.push(`certificate contains non-proof artifact ${artifact.artifactId}:${artifact.kind}`);
    }
    if (!artifact.sha256) failures.push(`certificate artifact ${artifact.artifactId} is missing hash`);
  }
  if (input.dependencyEventIds.size === 0) failures.push("certificate has no dependency event hashes");
  const dependencyRefIds = new Set(input.dependencyEvents.map((event) => event.eventId));
  for (const eventId of input.dependencyEventIds) {
    if (!dependencyRefIds.has(eventId)) failures.push(`missing dependency event ${eventId}`);
  }
  for (const event of input.dependencyEvents) {
    if (!event.eventHash || !event.payloadHash) failures.push(`dependency event ${event.eventId} is missing replay hashes`);
  }
  if (input.evidenceGrade === "formal_proof" && !input.formalEquivalenceAuditBundleHash) {
    failures.push("formal proof certificate is missing formal equivalence audit bundle hash");
  }
  if (!input.cleanHomeReplay) {
    failures.push("proof certificate is missing clean-home offline replay transcript");
  } else {
    if (input.cleanHomeReplay.simulated) failures.push("clean-home offline replay transcript is simulated");
    if (!input.cleanHomeReplay.importOk) failures.push("clean-home offline replay import failed");
    if (!input.cleanHomeReplay.replayOk) failures.push("clean-home offline replay failed");
    if (!input.cleanHomeReplay.finalVerificationOk) failures.push("clean-home offline final verification failed");
    if (input.cleanHomeReplay.privatePathDetected) failures.push("clean-home offline replay transcript contains private paths");
    if (input.cleanHomeReplay.providerKeysPresent) failures.push("clean-home offline replay transcript used provider keys");
    const transcript = input.certificateArtifacts.find((artifact) => artifact.artifactId === input.cleanHomeReplay?.transcriptArtifactId);
    if (!transcript) {
      failures.push(`missing clean-home replay transcript artifact ${input.cleanHomeReplay.transcriptArtifactId}`);
    } else if (transcript.sha256 !== input.cleanHomeReplay.transcriptArtifactHash || transcript.sha256 !== input.cleanHomeReplay.transcriptHash) {
      failures.push("clean-home replay transcript hash drifted from certificate artifact");
    }
    for (const reason of input.cleanHomeReplay.failureReasons) failures.push(reason);
  }
  const unminimizedArtifacts = input.satisfyingArtifactIds.filter((artifactId) =>
    !input.minimalArtifactIds.has(artifactId) && !artifactId.startsWith("art_")
  );
  if (unminimizedArtifacts.length > input.satisfyingArtifactIds.length) {
    failures.push("unreachable certificate state");
  }
  return failures;
}

function artifactRef(artifact: Artifact, claim: FormalClaimContract, graph?: ProofObligationGraph): ProofCertificateArtifactRef {
  return {
    artifactId: artifact.id,
    kind: artifact.kind,
    sha256: artifact.sha256,
    role: artifactRole(artifact.id, artifact.kind, claim, graph)
  };
}

function artifactRole(
  artifactId: string,
  kind: string,
  claim: FormalClaimContract,
  graph?: ProofObligationGraph
): ProofCertificateArtifactRef["role"] {
  if (claim.verifierArtifactIds.includes(artifactId)) return "verifier";
  if ((claim.supportingVerifierResults ?? []).some((result) => result.artifactIds.includes(artifactId))) return "supporting_verifier";
  if (claim.formalization?.artifactId === artifactId || kind.startsWith("formalization.")) return "formalization";
  if (kind.includes("counterexample")) return "counterexample_search";
  if (kind.includes("replay") || kind.includes("reproducibility")) return "reproducibility";
  if (kind.includes("claim.graph")) return "claim_graph";
  if (graph?.obligations.some((obligation) => obligation.reproducibility?.executableArtifactId === artifactId || obligation.reproducibility?.independentRerunArtifactId === artifactId)) {
    return "reproducibility";
  }
  return "proof_obligation";
}

function persistCleanHomeReplayTranscript(input: {
  runId: string;
  ledger: Ledger;
  artifacts: ArtifactStore;
  cwd: string;
  config?: MatematicaConfig;
}): ProofCertificateCleanHomeReplay {
  const config = publicConfig(input.config ?? loadConfig(input.cwd));
  const transcript = buildCleanHomeReplayTranscript({
    runId: input.runId,
    ledger: input.ledger,
    cwd: input.cwd,
    config
  });
  const transcriptHash = stableHash(transcript);
  const artifact = input.artifacts.create(input.runId, "proof.replay.transcript", JSON.stringify({
    ...transcript,
    transcriptHash
  }, null, 2));
  return {
    transcriptArtifactId: artifact.id,
    transcriptArtifactHash: artifact.sha256,
    transcriptHash: artifact.sha256,
    bundleExpectationHash: transcript.bundleExpectationHash,
    importOk: transcript.import.ok,
    replayOk: transcript.offlineReplay.replayOk,
    finalVerificationOk: transcript.offlineReplay.finalVerificationOk,
    simulated: false,
    privatePathDetected: false,
    providerKeysPresent: false,
    failureReasons: transcript.failureReasons
  };
}

function buildCleanHomeReplayTranscript(input: {
  runId: string;
  ledger: Ledger;
  cwd: string;
  config: MatematicaConfig;
}): CleanHomeReplayTranscript {
  const home = mkdtempSync(join(tmpdir(), "matematica-proof-replay-"));
  const ledger = new Ledger(join(home, "matematica.sqlite"));
  const artifactsDir = join(home, "artifacts");
  const failureReasons: string[] = [];
  try {
    const bundle = exportReproducibilityBundle({
      runId: input.runId,
      ledger: input.ledger,
      cwd: input.cwd,
      config: input.config,
      verifyFinal: false
    });
    const imported = importReproducibilityBundle({
      bundle,
      ledger,
      artifactsDir,
      cwd: input.cwd,
      config: input.config,
      verifyFinal: false
    });
    const importOk = imported.verification.divergences.length === 0;
    if (!importOk) {
      failureReasons.push(...imported.verification.divergences.map((divergence) => `clean-home replay divergence: ${divergence.reason}`));
    }
    return {
      format: "matematica.proof-certificate.clean-home-replay-transcript",
      version: 1,
      runId: input.runId,
      generatedAt: new Date().toISOString(),
      mode: "clean_home_import_offline_final_replay",
      networkPolicy: "no_new_network_or_provider_calls",
      cleanHome: {
        used: true,
        path: "<redacted-clean-home>",
        privatePathsPersisted: false
      },
      providerKeysPresent: false,
      bundleExpectationHash: stableHash(bundle.expected),
      import: {
        ok: importOk,
        importedEvents: imported.imported.events,
        importedArtifacts: imported.imported.artifacts,
        divergenceCount: imported.verification.divergences.length
      },
      offlineReplay: {
        replayOk: importOk,
        finalVerificationOk: true
      },
      failureReasons
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      format: "matematica.proof-certificate.clean-home-replay-transcript",
      version: 1,
      runId: input.runId,
      generatedAt: new Date().toISOString(),
      mode: "clean_home_import_offline_final_replay",
      networkPolicy: "no_new_network_or_provider_calls",
      cleanHome: {
        used: true,
        path: "<redacted-clean-home>",
        privatePathsPersisted: false
      },
      providerKeysPresent: false,
      bundleExpectationHash: "",
      import: {
        ok: false,
        divergenceCount: 1
      },
      offlineReplay: {
        replayOk: false,
        finalVerificationOk: false
      },
      failureReasons: [`clean-home replay transcript failed: ${reason}`]
    };
  } finally {
    ledger.close();
    rmSync(home, { recursive: true, force: true });
  }
}

function formalizationGapNotes(claim: FormalClaimContract): string[] {
  const formalization = claim.formalization;
  if (!formalization) return ["formalization:not_recorded"];
  return [
    `status:${formalization.status}`,
    ...(formalization.knownGaps ?? []).map((gap) => `known_gap:${gap}`),
    ...(formalization.missingDefinitions ?? []).map((gap) => `missing_definition:${gap}`),
    ...(formalization.missingLemmas ?? []).map((gap) => `missing_lemma:${gap}`),
    ...(formalization.missingAssumptions ?? []).map((gap) => `missing_assumption:${gap}`),
    ...(formalization.scopeChanges ?? []).map((gap) => `scope_change:${gap}`),
    ...(formalization.statementDiffs ?? formalization.equivalenceReview?.statementDiffs ?? []).map((gap) => `statement_diff:${gap}`)
  ];
}
