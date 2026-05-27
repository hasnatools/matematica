import { readFileSync } from "node:fs";
import type { ArtifactStore } from "./artifacts";
import { auditRun, type AuditResult } from "./audit";
import type { Artifact, LedgerEvent } from "./domain";
import { buildExternalOutcomeReconciliationReport } from "./external-reconciliation";
import { stableHash } from "./idempotency";
import type { Ledger } from "./ledger";
import {
  buildOfflineReplayGateManifest,
  buildOfflineReplayNonReplayableSteps,
  evaluateOfflineSelfContainedGate,
  type OfflineSelfContainedGate
} from "./offline-replay-gate";
import { buildOutputTrustContract, followUpReplayCommand } from "./output-trust";
import { ALLOWED_FINAL_ANSWER_STATES, classifyFinalOutcome } from "./outcome";
import { classificationForRun, latestProblemClassificationReview } from "./problem-classifier";
import { buildReplayTrustContract, type ReplayTrustContract } from "./replay-trust";

export type FinalAnswerProvenance = {
  format: "matematica.final-answer.provenance";
  version: 1;
  runId: string;
  reportIdempotencyKey: string;
  terminalLedger: {
    eventId?: string;
    eventType?: string;
    sequence?: number;
    eventHash?: string;
    previousEventHash?: string;
    payloadHash?: string;
    witnessPath: string;
    witnessOk: boolean;
    witnessCheckpointHash?: string;
    witnessHeadEventHash?: string;
    witnessEventLogHash?: string;
    witnessEventCount?: number;
    witnessIssues: string[];
  };
  outcome: {
    status: string;
    evidenceGrade: string;
    finalState: string;
    canClaimSolved: boolean;
    outputTrustLabel: string;
    failClosedReasons: string[];
  };
  verifier: {
    status: "verified" | "missing" | "not_required_for_terminal_state" | "audit_failed";
    verifierIds: string[];
    quorumEventId?: string;
    proofObligationEventId?: string;
    counterexampleSearchEventId?: string;
  };
  finalization: {
    status: "passed" | "failed" | "missing" | "not_required";
    eventId?: string;
    artifactId?: string;
    reviewHash?: string;
    checkIds: string[];
    failureReasons: string[];
  };
  adversarialQuorum: {
    status: "passed" | "failed" | "degraded_capacity" | "missing" | "not_required";
    eventId?: string;
    artifactId?: string;
    reviewHash?: string;
    scope?: string;
    criticIds: string[];
    criticRoles: string[];
    acceptedFindings: number;
    rejectedFindings: Array<{ id?: string; severity?: string; rationale?: string }>;
    degraded: boolean;
    capacityFailureReason?: string;
    artifactIds: string[];
  };
  audit: {
    ok: boolean;
    issueCodes: string[];
  };
  replay: {
    requiredForSolvedClaim: true;
    selfContainedOk: boolean;
    networkPolicy: OfflineSelfContainedGate["networkPolicy"];
    checked: OfflineSelfContainedGate["checked"];
    issueCodes: string[];
    trust: ReplayTrustContract;
  };
  budget: {
    reserved: CostUsage;
    debited: CostUsage;
    released: CostUsage;
    inFlight: CostUsage;
  };
  providerMatrix: {
    eventId?: string;
    artifactId?: string;
    matrixHash?: string;
    providerAllowlist: string[];
  };
  privacy: {
    localArtifactPersistence: "redacted_artifacts_only";
    localArtifactPathMode: "content_addressed_relative_to_matematica_home";
    rawPromptTextPersisted: false;
    rawProviderTextIncludedInReports: false;
    rawSourceTextIncludedInReports: false;
    defaultExportPolicy: "redacted_portable_bundle";
    rawExportRequiresExplicitConsent: true;
    retentionPolicy: {
      localRedactedArtifacts: "retain_until_operator_prunes_or_deletes_matematica_home";
      rawArtifacts: "not_persisted";
      portableExports: "operator_managed_files";
    };
  };
  bundles: {
    replayCommand: string;
    artifactBundlePaths: Array<{ artifactId: string; kind: string; sha256: string; contentAddress: string; mediaType: string; storageKey: string; bundlePath: string; localRelativePath: string }>;
    proofBundlePaths: Array<{ artifactId: string; kind: string; sha256: string; bundlePath: string; localRelativePath: string }>;
    sourceBundlePaths: Array<{ artifactId: string; kind: string; sha256: string; bundlePath: string; localRelativePath: string }>;
    replayBundleCommand: string;
  };
};

export type RunReportSnapshot = {
  format: "matematica.run-report-snapshot";
  version: 1;
  runId: string;
  sourceEventRange: {
    firstSequence?: number;
    lastSequence?: number;
    firstEventId?: string;
    lastEventId?: string;
  };
  ledgerHeadEventHash?: string;
  eventCount: number;
  sourceEvents: Array<{
    id: string;
    type: string;
    sequence?: number;
    eventHash?: string;
    payloadHash?: string;
    artifactIds: string[];
  }>;
  artifactManifest: Array<{
    id: string;
    kind: string;
    sha256: string;
    contentAddress: string;
    mediaType: string;
    storageKey: string;
    bytes: number;
  }>;
  artifactManifestHash: string;
  externalOperations: Array<{
    id: string;
    operationType: string;
    provider?: string;
    idempotencyKey: string;
    requestHash: string;
    status: string;
    reservationId: string;
    retryOfOperationId?: string;
    attempt: number;
  }>;
  budgetSettlement: {
    eventCounts: Record<string, number>;
    openReservations: Array<{
      reservationId: string;
      settled: "open";
      reserve: CostUsage;
    }>;
  };
  replayMode: "forensic_deterministic";
  regenerated: false;
  reportInputHash: string;
  reportHash: string;
};

export type PersistedRunReport = {
  reportId: string;
  reportText: string;
  reportHash: string;
  reportInputHash: string;
  snapshot: RunReportSnapshot;
  snapshotHash: string;
  snapshotArtifact: Artifact;
  reportArtifact: Artifact;
  event: LedgerEvent;
};

export function renderReport(runId: string, ledger: Ledger): string {
  const run = ledger.requireRun(runId);
  const events = reportSourceEvents(ledger.listEvents(runId));
  const artifacts = reportSourceArtifacts(ledger.listArtifacts(runId));
  const scores = ledger.listScores(runId);
  const terminalEvent = events.findLast((event) => event.type === "goal.completed");
  const formalizationEvent = events.findLast((event) => event.type === "formalization.assessed");
  const normalizationEvent = events.findLast((event) => event.type === "theorem.normalized");
  const equivalenceEvent = events.findLast((event) => event.type === "theorem.equivalence.reviewed");
  const citationEvent = events.findLast((event) => event.type === "source.citations.reviewed");
  const sourceResultEvent = events.findLast((event) => event.type === "source.results");
  const sourceLicenseEvent = events.findLast((event) => event.type === "source.license.manifest.reviewed");
  const retrievalEvaluationEvent = events.findLast((event) => event.type === "source.retrieval.evaluated");
  const counterexampleSearchEvent = events.findLast((event) => event.type === "counterexample.search.reviewed");
  const proofObligationEvent = events.findLast((event) => event.type === "proof.obligations.reviewed");
  const claimGraphEvent = events.findLast((event) => event.type === "claim.graph.reviewed");
  const progressEvents = events.filter((event) => event.type === "goal.progress.reviewed");
  const assumptionDeltaEvents = events.filter((event) => event.type === "loophole.assumption_delta.reviewed");
  const providerMatrixEvent = events.findLast((event) => event.type === "provider.matrix.pinned");
  const conjectureEvents = events.filter((event) => event.type === "knowledge.conjecture.saved");
  const costReconciliation = providerCostReconciliation(runId, ledger);
  const providerRuntimeIssues = buildProviderRuntimeIssues(events);
  const budgetExhaustedDiagnostics = buildBudgetExhaustedDiagnostics(runId, ledger, costReconciliation);
  const problemClassificationReview = latestProblemClassificationReview(events);
  const problemClassification = classificationForRun(run, events);
  const audit = auditRun(runId, ledger);
  const formalizationGap = formalizationEvent?.payload && typeof formalizationEvent.payload === "object"
    ? (formalizationEvent.payload as Record<string, unknown>).gap
    : undefined;
  const formalEquivalenceAuditBundle = recordValue(formalizationEvent?.payload).equivalenceAuditBundle ?? recordValue(equivalenceEvent?.payload).equivalenceAuditBundle;
  const formalizationGapBlocks = formalizationGap &&
    typeof formalizationGap === "object" &&
    (formalizationGap as Record<string, unknown>).blocksGoal === true;
  const quorumEvent = events.findLast((event) =>
    event.type === "verifier.completed" &&
    event.payload.verifier === "evidence-gate" &&
    typeof event.payload.gate === "object" &&
    event.payload.gate !== null
  );
  const outcome = classifyFinalOutcome(run, events);
  const reportKey = reportGenerationIdempotencyKey(runId, ledger);
  const finalAnswerProvenance = buildFinalAnswerProvenance(runId, ledger, { audit, reportKey });
  const replayTrust = finalAnswerProvenance.replay.trust;
  const outputTrust = buildOutputTrustContract({
    run,
    events,
    replayCommand: followUpReplayCommand(run.id),
    integrityOk: audit.ok && finalAnswerProvenance.terminalLedger.witnessOk && finalAnswerProvenance.replay.selfContainedOk
  });
  const canClaimSolved = finalAnswerProvenance.outcome.canClaimSolved;
  const externalOutcomeReconciliation = buildExternalOutcomeReconciliationReport(runId, ledger);

  const lines = [
    `# Matematica Goal Report`,
    "",
    `Run: ${run.id}`,
    `Report idempotency key: ${reportKey}`,
    `Status: ${run.status}`,
    `Evidence grade: ${run.evidenceGrade}`,
    `Final outcome: ${outcome.state}`,
    `Can claim solved: ${canClaimSolved ? "yes" : "no"}`,
    `Output trust label: ${outputTrust.labelText}`,
    `Workflow: ${run.workflow}`,
    `Audit integrity: ${audit.ok ? "pass" : "fail"}`,
    `Offline replay self-contained: ${finalAnswerProvenance.replay.selfContainedOk ? "pass" : "fail"}`,
    `Terminal ledger head: ${finalAnswerProvenance.terminalLedger.eventHash ?? "missing"}`,
    `Ledger witness checkpoint: ${finalAnswerProvenance.terminalLedger.witnessCheckpointHash ?? "missing"} (${finalAnswerProvenance.terminalLedger.witnessOk ? "pass" : "fail"})`,
    "",
    `## Final Answer Provenance`,
    "",
    "```json",
    JSON.stringify(finalAnswerProvenance, null, 2),
    "```",
    "",
    `## Output Trust Contract`,
    "",
    `Label: ${outputTrust.labelText}`,
    `Evidence grade: ${outputTrust.evidenceGrade}`,
    `Verifier IDs: ${outputTrust.verifierIds.length > 0 ? outputTrust.verifierIds.join(", ") : "none"}`,
    `Replay command: ${outputTrust.replayCommand}`,
    `Next action: ${outputTrust.nextAction}`,
    "Limitations:",
    ...outputTrust.limitations.map((limitation) => `- ${limitation}`),
    "",
    `## Replay Trust Modes`,
    "",
    ...replayTrust.modes.flatMap((mode) => [
      `### ${mode.label}`,
      `Mode: ${mode.mode}`,
      `Available: ${mode.available ? "yes" : "no"}`,
      `Scope: ${mode.scope}`,
      `Raw prompt text included: ${mode.includesRawPromptText ? "yes" : "no"}`,
      `Raw provider response text included: ${mode.includesRawProviderText ? "yes" : "no"}`,
      `Raw source text included: ${mode.includesRawSourceText ? "yes" : "no"}`,
      `Proof may depend on model/provider/source text: ${mode.proofClaimsMayDependOnModelText || mode.proofClaimsMayDependOnProviderResponseText || mode.proofClaimsMayDependOnSourceText ? "yes" : "no"}`,
      `Independently reproducible claims: ${mode.independentlyReproducibleClaims.length > 0 ? mode.independentlyReproducibleClaims.join(", ") : "none"}`,
      "Limitations:",
      ...mode.limitations.map((limitation) => `- ${limitation}`),
      ""
    ]),
    "",
    `## Audit Integrity`,
    "",
    audit.ok
      ? "Ledger and artifact integrity audit passed."
      : "Ledger or artifact integrity audit failed; this report is fail-closed and must not be treated as a solved claim.",
    audit.issues.length > 0 ? "```json" : "",
    audit.issues.length > 0 ? JSON.stringify(audit.issues, null, 2) : "",
    audit.issues.length > 0 ? "```" : "",
    "",
    `## Outcome Honesty`,
    "",
    outcome.reason,
    `Allowed final answer states: ${ALLOWED_FINAL_ANSWER_STATES.join(", ")}`,
    "",
    `## Problem`,
    "",
    run.problem,
    "",
    `## Goal`,
    "",
    run.goal,
    "",
    `## Success Criteria`,
    "",
    ...run.successCriteria.map((criterion) => `- ${criterion}`),
    "",
    `## Problem Classification`,
    "",
    "```json",
    JSON.stringify({
      classification: problemClassification,
      review: problemClassificationReview ?? {
        persisted: false,
        reason: "No persisted problem.classification.reviewed event found; report used deterministic fallback classification."
      }
    }, null, 2),
    "```",
    "",
    `## Budget`,
    "",
    "```json",
    JSON.stringify({
      contract: run.budget,
      accounting: finalAnswerProvenance.budget
    }, null, 2),
    "```",
    "",
    `## Budget Exhausted Diagnostics`,
    "",
    budgetExhaustedDiagnostics ? "```json" : "Run is not budget_exhausted.",
    budgetExhaustedDiagnostics ? JSON.stringify(budgetExhaustedDiagnostics, null, 2) : "",
    budgetExhaustedDiagnostics ? "```" : "",
    "",
    `## Provider Cost Reconciliation`,
    "",
    costReconciliation.length > 0 ? "```json" : "No provider cost activity recorded.",
    costReconciliation.length > 0 ? JSON.stringify(costReconciliation, null, 2) : "",
    costReconciliation.length > 0 ? "```" : "",
    "",
    `## External Outcome Reconciliation`,
    "",
    externalOutcomeReconciliation.ok
      ? "No unknown external outcomes or open external reservations recorded."
      : "Unknown or open external operations require operator reconciliation before release.",
    "```json",
    JSON.stringify(externalOutcomeReconciliation, null, 2),
    "```",
    "",
    `## Provider Runtime Issues`,
    "",
    providerRuntimeIssues.length > 0 ? "```json" : "No provider runtime issues recorded.",
    providerRuntimeIssues.length > 0 ? JSON.stringify(providerRuntimeIssues, null, 2) : "",
    providerRuntimeIssues.length > 0 ? "```" : "",
    "",
    `## Provider Matrix`,
    "",
    providerMatrixEvent ? "```json" : "No provider matrix pinned.",
    providerMatrixEvent ? JSON.stringify({
      eventId: providerMatrixEvent.id,
      artifactId: providerMatrixEvent.payload.artifactId,
      matrixHash: providerMatrixEvent.payload.matrixHash,
      providerAllowlist: providerMatrixEvent.payload.providerAllowlist,
      fallbackPolicy: providerMatrixEvent.payload.fallbackPolicy,
      providers: providerMatrixEvent.payload.providers
    }, null, 2) : "",
    providerMatrixEvent ? "```" : "",
    "",
    `## Terminal Evidence`,
    "",
    terminalEvent ? "```json" : "No terminal event recorded.",
    terminalEvent ? JSON.stringify(terminalEvent.payload, null, 2) : "",
    terminalEvent ? "```" : "",
    "",
    `## Formalization Assessment`,
    "",
    formalizationEvent ? "```json" : "No formalization assessment recorded.",
    formalizationEvent ? JSON.stringify(formalizationEvent.payload, null, 2) : "",
    formalizationEvent ? "```" : "",
    "",
    `## Formalization Blockers`,
    "",
    formalizationGapBlocks ? "```json" : "No blocking formalization gap recorded.",
    formalizationGapBlocks ? JSON.stringify(formalizationGap, null, 2) : "",
    formalizationGapBlocks ? "```" : "",
    "",
    `## Theorem Normalization`,
    "",
    normalizationEvent ? "```json" : "No theorem normalization recorded.",
    normalizationEvent ? JSON.stringify(normalizationEvent.payload, null, 2) : "",
    normalizationEvent ? "```" : "",
    "",
    `## Proof Equivalence Review`,
    "",
    equivalenceEvent ? "```json" : "No theorem-equivalence review recorded.",
    equivalenceEvent ? JSON.stringify(equivalenceEvent.payload, null, 2) : "",
    equivalenceEvent ? "```" : "",
    "",
    `## Formal Equivalence Audit Bundle`,
    "",
    formalEquivalenceAuditBundle ? "```json" : "No formal equivalence audit bundle recorded.",
    formalEquivalenceAuditBundle ? JSON.stringify(formalEquivalenceAuditBundle, null, 2) : "",
    formalEquivalenceAuditBundle ? "```" : "",
    "",
    `## Citation Grounding`,
    "",
    citationEvent ? "```json" : "No citation grounding review recorded.",
    citationEvent ? JSON.stringify(citationEvent.payload, null, 2) : "",
    citationEvent ? "```" : "",
    "",
    `## Citation Mathematical Support`,
    "",
    citationEvent ? "```json" : "No citation support-boundary review recorded.",
    citationEvent ? JSON.stringify({
      sourceExistenceIsMathematicalSupport: false,
      sourceExistenceCanSupportSolvedClaim: false,
      mathematicalSupportRequires: [
        "exact_arxiv_version",
        "snapshot_hash",
        "quoted_support_span",
        "license_and_provenance_manifest",
        "independent_entailment_review"
      ],
      proofSupport: "citations are literature provenance only; final solved claims require verifier-backed proof evidence",
      supportPolicy: citationEvent.payload.supportPolicy,
      supportFindings: Array.isArray(citationEvent.payload.findings)
        ? citationEvent.payload.findings.map((finding) => ({
          status: finding.status,
          matchedSourceId: finding.matchedSourceId,
          supportReview: finding.supportReview
        }))
        : []
    }, null, 2) : "",
    citationEvent ? "```" : "",
    "",
    `## Citation License And Proof Boundary`,
    "",
    sourceLicenseEvent || sourceResultEvent ? "```json" : "No citation license manifest recorded.",
    sourceLicenseEvent || sourceResultEvent ? JSON.stringify({
      manifest: sourceLicenseEvent?.payload ?? sourceResultEvent?.payload.citationLicenseManifest,
      boundary: {
        citationMetadataIsProofSupport: false,
        reportPolicy: "arXiv citation metadata can support literature provenance; it is not proof support for solved mathematical claims.",
        sourceExportPolicy: "arXiv PDF/source content is not exported unless an explicit license permits redistribution."
      }
    }, null, 2) : "",
    sourceLicenseEvent || sourceResultEvent ? "```" : "",
    "",
    `## Retrieval Evaluation`,
    "",
    retrievalEvaluationEvent ? "```json" : "No retrieval evaluation recorded.",
    retrievalEvaluationEvent ? JSON.stringify(retrievalEvaluationEvent.payload, null, 2) : "",
    retrievalEvaluationEvent ? "```" : "",
    "",
    `## Counterexample Search`,
    "",
    counterexampleSearchEvent ? "```json" : "No counterexample search recorded.",
    counterexampleSearchEvent ? JSON.stringify(counterexampleSearchEvent.payload, null, 2) : "",
    counterexampleSearchEvent ? "```" : "",
    "",
    `## Proof Obligations`,
    "",
    proofObligationEvent ? "```json" : "No proof-obligation review recorded.",
    proofObligationEvent ? JSON.stringify(proofObligationEvent.payload, null, 2) : "",
    proofObligationEvent ? "```" : "",
    "",
    `## Claim Graph Review`,
    "",
    claimGraphEvent ? "```json" : "No claim graph review recorded.",
    claimGraphEvent ? JSON.stringify(claimGraphEvent.payload, null, 2) : "",
    claimGraphEvent ? "```" : "",
    "",
    `## Progress And Stagnation`,
    "",
    progressEvents.length > 0 ? "```json" : "No progress review recorded.",
    progressEvents.length > 0 ? JSON.stringify(progressEvents.map((event) => event.payload.review), null, 2) : "",
    progressEvents.length > 0 ? "```" : "",
    "",
    `## Loophole Assumption Deltas`,
    "",
    assumptionDeltaEvents.length > 0 ? "```json" : "No loophole assumption-delta reviews recorded.",
    assumptionDeltaEvents.length > 0 ? JSON.stringify(assumptionDeltaEvents.map((event) => event.payload), null, 2) : "",
    assumptionDeltaEvents.length > 0 ? "```" : "",
    "",
    `## Conjectural Knowledge`,
    "",
    conjectureEvents.length > 0 ? "```json" : "No conjectural knowledge carried forward.",
    conjectureEvents.length > 0 ? JSON.stringify(conjectureEvents.map((event) => event.payload), null, 2) : "",
    conjectureEvents.length > 0 ? "```" : "",
    "",
    `## Conservative Evidence Scores`,
    "",
    scores.length > 0 ? "```json" : "No conservative evidence scores recorded.",
    scores.length > 0 ? JSON.stringify(scores, null, 2) : "",
    scores.length > 0 ? "```" : "",
    "",
    `## Verification Quorum`,
    "",
    quorumEvent ? "```json" : "No verification quorum decision recorded.",
    quorumEvent ? JSON.stringify((quorumEvent.payload.gate as Record<string, unknown>).quorum ?? quorumEvent.payload.gate, null, 2) : "",
    quorumEvent ? "```" : "",
    "",
    `## Artifacts`,
    "",
    ...artifacts.map((artifact) => `- ${artifact.id} ${artifact.kind} ${artifact.contentAddress} media=${artifact.mediaType} bytes=${artifact.bytes}`),
    "",
    `## Event Trace`,
    "",
    ...events.map((event, index) => `${index + 1}. ${event.createdAt} ${event.type} ${event.id}`)
  ];

  return lines.filter((line, index, array) => !(line === "" && array[index - 1] === "")).join("\n");
}

export function persistRunReport(runId: string, ledger: Ledger, artifacts: ArtifactStore): PersistedRunReport {
  ledger.requireRun(runId);
  const reportText = renderReport(runId, ledger);
  const reportHash = stableHash(reportText);
  const snapshot = buildRunReportSnapshot(runId, ledger, reportHash);
  const snapshotHash = stableHash(snapshot);
  const snapshotArtifact = artifacts.create(runId, "report.run_snapshot", JSON.stringify(snapshot, null, 2));
  const reportArtifact = artifacts.create(runId, "report.final", reportText);
  const reportId = reportGenerationIdempotencyKey(runId, ledger);
  const event = ledger.appendEvent(runId, "report.generated", {
    reportId,
    kind: "final",
    reportArtifactId: reportArtifact.id,
    artifactId: reportArtifact.id,
    snapshotArtifactId: snapshotArtifact.id,
    snapshotHash,
    snapshotArtifactSha256: snapshotArtifact.sha256,
    reportInputHash: snapshot.reportInputHash,
    sourceEventRange: snapshot.sourceEventRange,
    sourceEventCount: snapshot.eventCount,
    ledgerHeadEventHash: snapshot.ledgerHeadEventHash,
    reportHash,
    regenerated: false
  }, [snapshotArtifact.id, reportArtifact.id]);

  return {
    reportId,
    reportText,
    reportHash,
    reportInputHash: snapshot.reportInputHash,
    snapshot,
    snapshotHash,
    snapshotArtifact,
    reportArtifact,
    event
  };
}

export function buildRunReportSnapshot(runId: string, ledger: Ledger, reportHash: string): RunReportSnapshot {
  ledger.requireRun(runId);
  const sourceEvents = reportSourceEvents(ledger.listEvents(runId));
  const sourceArtifacts = reportSourceArtifacts(ledger.listArtifacts(runId));
  const eventManifest = sourceEvents.map((event) => ({
    id: event.id,
    type: event.type,
    sequence: event.sequence,
    eventHash: event.eventHash,
    payloadHash: event.payloadHash,
    artifactIds: [...event.artifactIds]
  }));
  const artifactManifest = sourceArtifacts.map((artifact) => ({
    id: artifact.id,
    kind: artifact.kind,
    sha256: artifact.sha256,
    contentAddress: artifact.contentAddress,
    mediaType: artifact.mediaType,
    storageKey: artifact.storageKey,
    bytes: artifact.bytes
  }));
  const sourceEventRange = {
    firstSequence: sourceEvents[0]?.sequence,
    lastSequence: sourceEvents[sourceEvents.length - 1]?.sequence,
    firstEventId: sourceEvents[0]?.id,
    lastEventId: sourceEvents[sourceEvents.length - 1]?.id
  };
  const ledgerHeadEventHash = sourceEvents[sourceEvents.length - 1]?.eventHash;
  const budgetSettlement = {
    eventCounts: countBy(sourceEvents
      .filter((event) => event.type.startsWith("budget.") || event.type.startsWith("external.operation."))
      .map((event) => event.type)),
    openReservations: ledger.listOpenBudgetReservations(runId).map((reservation) => ({
      reservationId: reservation.reservationId,
      settled: "open" as const,
      reserve: reservation.reserve
    }))
  };
  const externalOperations = ledger.listExternalOperations(runId).map((operation) => ({
    id: operation.id,
    operationType: operation.operationType,
    provider: operation.provider,
    idempotencyKey: operation.idempotencyKey,
    requestHash: operation.requestHash,
    status: operation.status,
    reservationId: operation.reservationId,
    retryOfOperationId: operation.retryOfOperationId,
    attempt: operation.attempt
  }));
  const reportInput = {
    runId,
    sourceEventRange,
    ledgerHeadEventHash,
    eventCount: sourceEvents.length,
    sourceEvents: eventManifest,
    artifactManifest,
    artifactManifestHash: stableHash(artifactManifest),
    externalOperations,
    budgetSettlement,
    replayMode: "forensic_deterministic" as const,
    regenerated: false as const
  };

  return {
    format: "matematica.run-report-snapshot",
    version: 1,
    ...reportInput,
    reportInputHash: stableHash(reportInput),
    reportHash
  };
}

function buildProviderRuntimeIssues(events: ReturnType<Ledger["listEvents"]>): Array<{
  eventId: string;
  type: string;
  code: string;
  provider?: string;
  modelId?: string;
  reason?: string;
}> {
  const issues: Array<{
    eventId: string;
    type: string;
    code: string;
    provider?: string;
    modelId?: string;
    reason?: string;
  }> = [];

  for (const event of events) {
    if (event.type === "provider.pricing.checked" && event.payload.ok === false) {
      issues.push({
        eventId: event.id,
        type: event.type,
        code: stringValue(event.payload.issueCode) ?? "provider_pricing_failed",
        provider: stringValue(event.payload.provider),
        modelId: stringValue(event.payload.modelId),
        reason: stringValue(event.payload.reason)
      });
    }

    if (event.type === "provider.call.failed") {
      const classification = event.payload.classification && typeof event.payload.classification === "object"
        ? event.payload.classification as Record<string, unknown>
        : {};
      issues.push({
        eventId: event.id,
        type: event.type,
        code: stringValue(classification.kind) ?? "provider_call_failed",
        provider: stringValue(event.payload.provider),
        modelId: stringValue(event.payload.modelId),
        reason: stringValue(event.payload.errorMessage)
      });
    }

    if (event.type === "ai.call.failed") {
      const classification = event.payload.providerFailure && typeof event.payload.providerFailure === "object"
        ? event.payload.providerFailure as Record<string, unknown>
        : {};
      issues.push({
        eventId: event.id,
        type: event.type,
        code: stringValue(classification.kind) ?? "ai_call_failed",
        provider: stringValue(event.payload.provider),
        modelId: stringValue(event.payload.modelId),
        reason: stringValue(event.payload.errorMessage)
      });
    }

    if (event.type === "ai.call.aborted") {
      issues.push({
        eventId: event.id,
        type: event.type,
        code: "ai_call_aborted",
        provider: stringValue(event.payload.provider),
        modelId: stringValue(event.payload.modelId)
      });
    }

    if (event.type === "external.operation.unknown") {
      issues.push({
        eventId: event.id,
        type: event.type,
        code: "external_operation_unknown_remote_outcome",
        provider: stringValue(event.payload.provider),
        reason: stringValue(event.payload.reason)
      });
    }

    if (event.type === "external.operation.dead_lettered") {
      issues.push({
        eventId: event.id,
        type: event.type,
        code: "external_operation_dead_lettered_dispatch",
        provider: stringValue(event.payload.provider),
        reason: stringValue(event.payload.reason)
      });
    }

    if (event.type === "worker.reconciled") {
      issues.push({
        eventId: event.id,
        type: event.type,
        code: "worker_stale_lease_reconciled",
        reason: stringValue(event.payload.reason)
      });
    }
  }

  return issues;
}

function buildBudgetExhaustedDiagnostics(
  runId: string,
  ledger: Ledger,
  costReconciliation: CostRow[]
): Record<string, unknown> | undefined {
  const run = ledger.requireRun(runId);
  if (run.status !== "budget_exhausted" && run.evidenceGrade !== "budget_exhausted") return undefined;

  const events = ledger.listEvents(runId);
  const workerJobs = ledger.listWorkerJobs(runId);
  const scores = ledger.listScores(runId);
  const proofObligationEvent = events.findLast((event) => event.type === "proof.obligations.reviewed");
  const counterexampleSearchEvent = events.findLast((event) => event.type === "counterexample.search.reviewed");
  const progressEvent = events.findLast((event) => event.type === "goal.progress.reviewed");
  const branch = strongestFailedBranch(events, workerJobs, scores);
  const budget = budgetAccounting(events);

  return {
    outcome: {
      status: run.status,
      evidenceGrade: run.evidenceGrade,
      canClaimSolved: false,
      reason: "Budget was exhausted before verifier-backed success was established."
    },
    whatWasTried: {
      cycles: uniqueNumbers(events.map((event) => numericValue(event.payload.cycle))),
      phases: summarizePhases(events),
      workers: {
        total: workerJobs.length,
        byStatus: countBy(workerJobs.map((job) => job.status)),
        byKind: countBy(workerJobs.map((job) => job.kind))
      },
      externalOperations: countBy(ledger.listExternalOperations(runId).map((operation) => operation.operationType)),
      verifierRuns: events
        .filter((event) => event.type === "verifier.completed")
        .map((event) => ({
          eventId: event.id,
          verifier: stringValue(event.payload.verifier) ?? stringValue(event.payload.verifierId) ?? "unknown",
          status: stringValue(event.payload.status) ?? stringValue(event.payload.evidenceGrade) ?? "unknown",
          artifactIds: event.artifactIds
        }))
    },
    strongestFailedBranch: branch ?? {
      available: false,
      reason: "No committed or scored branch was available before budget exhaustion."
    },
    knownGaps: knownBudgetExhaustedGaps(events),
    remainingProofObligations: proofObligationEvent ? summarizeProofObligations(proofObligationEvent.payload) : {
      available: false,
      reason: "No proof-obligation review was recorded before budget exhaustion."
    },
    counterexamplePressure: counterexampleSearchEvent ? summarizeCounterexamplePressure(counterexampleSearchEvent.payload) : {
      available: false,
      reason: "No counterexample search was recorded before budget exhaustion."
    },
    progress: progressEvent?.payload.review ?? {
      available: false,
      reason: "No progress review was recorded before budget exhaustion."
    },
    budgetUse: {
      contract: run.budget,
      accounting: budget,
      providerCostReconciliation: costReconciliation
    },
    nextResumeCommand: `matematica goal resume ${runId} --reopen-terminal`,
    additionalBudgetRecommendation: {
      recommended: false,
      reason: "No calibrated continuation envelope is estimated from the current evidence; this report does not recommend more spend."
    }
  };
}

function summarizePhases(events: LedgerEvent[]): Array<{
  cycle?: number;
  phase: string;
  status: "started" | "completed";
  artifactIds: string[];
}> {
  return events
    .filter((event) => event.type === "phase.started" || event.type === "phase.completed")
    .map((event) => ({
      cycle: numericValue(event.payload.cycle),
      phase: stringValue(event.payload.phase) ?? "unknown",
      status: event.type === "phase.started" ? "started" as const : "completed" as const,
      artifactIds: event.artifactIds
    }));
}

function strongestFailedBranch(
  events: LedgerEvent[],
  workerJobs: ReturnType<Ledger["listWorkerJobs"]>,
  scores: ReturnType<Ledger["listScores"]>
): Record<string, unknown> | undefined {
  const commitByJob = new Map<string, Record<string, unknown>>();
  for (const event of events) {
    if (event.type !== "worker.committed") continue;
    const jobId = stringValue(event.payload.jobId);
    if (!jobId) continue;
    commitByJob.set(jobId, recordValue(event.payload.result));
  }

  const candidates = workerJobs
    .filter((job) => job.status === "committed")
    .map((job) => {
      const result = commitByJob.get(job.id) ?? {};
      const score = numericValue(result.score) ??
        numericValue(result.confidence) ??
        numericValue(result.evidenceScore) ??
        scoreForSubject(scores, job.id) ??
        0;
      return {
        jobId: job.id,
        kind: job.kind,
        payload: job.payload,
        attempts: job.attempts,
        score,
        evidenceGrade: stringValue(result.evidenceGrade) ?? stringValue(result.grade) ?? "unknown",
        artifactId: stringValue(result.artifactId),
        reason: "best committed branch by explicit score/confidence/evidenceScore"
      };
    })
    .sort((left, right) => right.score - left.score || left.jobId.localeCompare(right.jobId));

  if (candidates.length > 0) return candidates[0];

  const topScore = [...scores]
    .sort((left, right) => right.score - left.score || left.subjectId.localeCompare(right.subjectId))[0];
  if (!topScore) return undefined;
  return {
    subjectId: topScore.subjectId,
    scorer: topScore.scorer,
    score: topScore.score,
    rubric: topScore.rubric,
    reason: "best scored candidate before budget exhaustion"
  };
}

function knownBudgetExhaustedGaps(events: LedgerEvent[]): string[] {
  const gaps = new Set<string>();
  for (const event of events) {
    if (event.type === "formalization.assessed") {
      const gap = recordValue(event.payload.gap);
      if (gap.blocksGoal === true) gaps.add(`formalization:${stringValue(gap.kind) ?? "gap_blocks_goal"}`);
    }
    if (event.type === "theorem.equivalence.reviewed" && event.payload.status !== "equivalent") {
      gaps.add(`theorem_equivalence:${stringValue(event.payload.status) ?? "not_equivalent"}`);
    }
    if (event.type === "claim.graph.reviewed") {
      const decision = recordValue(event.payload.decision);
      const blocking = arrayValue(decision.blockingClaimIds);
      if (blocking.length > 0) gaps.add(`claim_graph_blocking_claims:${blocking.length}`);
    }
    if (event.type === "goal.progress.reviewed") {
      const review = recordValue(event.payload.review);
      if (review.state === "stagnating") gaps.add("progress:stagnating");
    }
    if (event.type === "ai.call.failed") {
      const failure = recordValue(event.payload.providerFailure);
      gaps.add(`provider_failure:${stringValue(failure.kind) ?? "unknown"}`);
    }
  }
  return [...gaps].sort();
}

function summarizeProofObligations(payload: Record<string, unknown>): Record<string, unknown> {
  const decision = recordValue(payload.decision);
  const graph = recordValue(payload.graph);
  const unresolved = arrayValue(decision.unresolvedObligations);
  const invalid = arrayValue(decision.invalidObligations);
  const insufficient = arrayValue(decision.insufficientVerification);
  const missingMethods = arrayValue(decision.missingCounterexampleMethods);
  const foundCounterexamples = arrayValue(decision.foundCounterexamples);
  const obligations = arrayValue(graph.obligations);
  return {
    ok: decision.ok === true,
    total: obligations.length,
    unresolved: unresolved.map(obligationSummary),
    invalid: invalid.map(obligationSummary),
    insufficientVerification: insufficient,
    missingCounterexampleMethods: missingMethods,
    foundCounterexamples,
    artifactId: stringValue(payload.artifactId)
  };
}

function summarizeCounterexamplePressure(payload: Record<string, unknown>): Record<string, unknown> {
  const searches = arrayValue(payload.searches);
  return {
    negativeEvidenceOnly: payload.negativeEvidenceOnly === true,
    totalMethods: searches.length,
    found: searches.filter((search) => recordValue(search).outcome === "found"),
    attemptedOrPassed: searches.filter((search) => {
      const outcome = recordValue(search).outcome;
      return outcome === "attempted" || outcome === "passed";
    }),
    notRunOrNotApplicable: searches.filter((search) => {
      const outcome = recordValue(search).outcome;
      return outcome === "not_run" || outcome === "not_applicable";
    }),
    artifactId: stringValue(payload.artifactId)
  };
}

function obligationSummary(value: unknown): Record<string, unknown> {
  const obligation = recordValue(value);
  return {
    id: stringValue(obligation.id) ?? "unknown",
    statement: stringValue(obligation.statement),
    status: stringValue(obligation.status),
    counterexampleSearch: stringValue(obligation.counterexampleSearch),
    artifactIds: arrayValue(obligation.artifactIds)
  };
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function numericValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function uniqueNumbers(values: Array<number | undefined>): number[] {
  return [...new Set(values.filter((value): value is number => value !== undefined))].sort((left, right) => left - right);
}

function uniqueStringArray(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))].sort();
}

function countBy(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function scoreForSubject(scores: ReturnType<Ledger["listScores"]>, subjectId: string): number | undefined {
  return scores
    .filter((score) => score.subjectId === subjectId)
    .sort((left, right) => right.score - left.score)[0]?.score;
}

type CostUsage = {
  attempts: number;
  tokens: number;
  usd: number;
  elapsedMs: number;
};

type CostRow = {
  provider: string;
  modelId: string;
  stepType: string;
  phase: string;
  workerId: string;
  estimatedMax: CostUsage;
  reserved: CostUsage;
  committed: CostUsage;
  debited: CostUsage;
  refunded: CostUsage;
  released: CostUsage;
  failed: number;
  retried: number;
  unknown: CostUsage;
  unknownOperations: number;
  deadLetterOperations: number;
  wasted: CostUsage;
  actualAttributed: CostUsage;
  inFlight: CostUsage;
  reconciliation: {
    ok: boolean;
    tolerance: CostUsage;
    issues: string[];
  };
};

export function buildFinalAnswerProvenance(
  runId: string,
  ledger: Ledger,
  options: { audit?: AuditResult; reportKey?: string } = {}
): FinalAnswerProvenance {
  const run = ledger.requireRun(runId);
  const events = ledger.listEvents(runId);
  const artifacts = ledger.listArtifacts(runId);
  const audit = options.audit ?? auditRun(runId, ledger);
  const witness = ledger.verifyLedgerWitness(runId);
  const replayGate = evaluateOfflineSelfContainedGate({
    runId,
    ledger,
    manifest: buildOfflineReplayGateManifest({ runId, ledger, events }),
    audit,
    events,
    nonReplayableSteps: buildOfflineReplayNonReplayableSteps(events)
  });
  const terminalEvent = events.findLast((event) => event.type === "goal.completed" || event.type === "goal.failed");
  const finalizationEvent = events.findLast((event) => event.type === "goal.finalization.checked");
  const adversarialQuorumEvent = events.findLast((event) =>
    event.type === "adversarial.quorum.reviewed" &&
    event.payload.scope === "finalization" &&
    (!finalizationEvent || event.payload.targetEventId === finalizationEvent.payload.goalSuccessEventId)
  );
  const providerMatrixEvent = events.findLast((event) => event.type === "provider.matrix.pinned");
  const outcome = classifyFinalOutcome(run, events);
  const outputTrust = buildOutputTrustContract({
    run,
    events,
    replayCommand: followUpReplayCommand(run.id),
    integrityOk: audit.ok && witness.ok && replayGate.ok
  });
  const verifierIds = verifierIdsFromEvents(events);
  const failClosedReasons = finalAnswerFailClosedReasons({
    terminalEvent,
    audit,
    witnessOk: witness.ok,
    replayGateOk: replayGate.ok,
    outcomeCanClaimSolved: outcome.canClaimSolved,
    verifierIds,
    runStatus: run.status,
    finalizationEvent,
    adversarialQuorumEvent
  });
  const budget = budgetAccounting(events);
  const proofBundlePaths = artifactBundlePaths(artifacts.filter(isProofArtifact));
  const sourceBundlePaths = artifactBundlePaths(artifacts.filter(isSourceArtifact));
  const replayTrust = buildReplayTrustContract({ run, events, artifacts });

  return {
    format: "matematica.final-answer.provenance",
    version: 1,
    runId,
    reportIdempotencyKey: options.reportKey ?? reportGenerationIdempotencyKey(runId, ledger),
    terminalLedger: {
      eventId: terminalEvent?.id,
      eventType: terminalEvent?.type,
      sequence: terminalEvent?.sequence,
      eventHash: terminalEvent?.eventHash,
      previousEventHash: terminalEvent?.previousEventHash,
      payloadHash: terminalEvent?.payloadHash,
      witnessPath: `ledger-witness/${runId}.json`,
      witnessOk: witness.ok,
      witnessCheckpointHash: witness.actual?.checkpointHash,
      witnessHeadEventHash: witness.actual?.headEventHash,
      witnessEventLogHash: witness.actual?.eventLogHash,
      witnessEventCount: witness.actual?.eventCount,
      witnessIssues: witness.issues.map((issue) => issue.code)
    },
    outcome: {
      status: run.status,
      evidenceGrade: run.evidenceGrade,
      finalState: outcome.state,
      canClaimSolved: outputTrust.canClaimSolved && failClosedReasons.length === 0,
      outputTrustLabel: outputTrust.labelText,
      failClosedReasons
    },
    verifier: {
      status: verifierStatus({
        auditOk: audit.ok,
        finalState: outcome.state,
        verifierIds
      }),
      verifierIds,
      quorumEventId: events.findLast((event) =>
        event.type === "verifier.completed" &&
        event.payload.verifier === "evidence-gate"
      )?.id,
      proofObligationEventId: events.findLast((event) => event.type === "proof.obligations.reviewed")?.id,
      counterexampleSearchEventId: events.findLast((event) => event.type === "counterexample.search.reviewed")?.id
    },
    finalization: finalizationSummary(run.status, finalizationEvent),
    adversarialQuorum: adversarialQuorumSummary(run.status, adversarialQuorumEvent),
    audit: {
      ok: audit.ok,
      issueCodes: audit.issues.map((issue) => issue.code)
    },
    replay: {
      requiredForSolvedClaim: true,
      selfContainedOk: replayGate.ok,
      networkPolicy: replayGate.networkPolicy,
      checked: replayGate.checked,
      issueCodes: replayGate.issues.map((issue) => issue.code),
      trust: replayTrust
    },
    budget,
    providerMatrix: {
      eventId: providerMatrixEvent?.id,
      artifactId: stringValue(providerMatrixEvent?.payload.artifactId),
      matrixHash: stringValue(providerMatrixEvent?.payload.matrixHash),
      providerAllowlist: stringArrayValue(providerMatrixEvent?.payload.providerAllowlist)
    },
    privacy: {
      localArtifactPersistence: "redacted_artifacts_only",
      localArtifactPathMode: "content_addressed_relative_to_matematica_home",
      rawPromptTextPersisted: false,
      rawProviderTextIncludedInReports: false,
      rawSourceTextIncludedInReports: false,
      defaultExportPolicy: "redacted_portable_bundle",
      rawExportRequiresExplicitConsent: true,
      retentionPolicy: {
        localRedactedArtifacts: "retain_until_operator_prunes_or_deletes_matematica_home",
        rawArtifacts: "not_persisted",
        portableExports: "operator_managed_files"
      }
    },
    bundles: {
      replayCommand: followUpReplayCommand(run.id),
      artifactBundlePaths: artifactBundlePaths(artifacts),
      proofBundlePaths,
      sourceBundlePaths,
      replayBundleCommand: `matematica goal replay ${run.id} --export matematica-${run.id}.bundle.json`
    }
  };
}

export function providerCostReconciliation(runId: string, ledger: Ledger): CostRow[] {
  const events = ledger.listEvents(runId);
  const operationModels = new Map<string, { provider: string; modelId: string }>();
  const operationInfo = new Map<string, {
    operationType: string;
    status: string;
    attempt: number;
    retryOfOperationId?: string;
    reservationId: string;
  }>();
  const operationInfoByReservation = new Map<string, {
    operationType: string;
    status: string;
    attempt: number;
    retryOfOperationId?: string;
    reservationId: string;
  }>();
  const reservations = new Map<string, {
    key: string;
    reserve: CostUsage;
    settled: "open" | "debited" | "released";
    operationStatus?: string;
  }>();
  const rows = new Map<string, CostRow>();
  const estimatesByProviderModel = new Map<string, CostUsage>();
  const externalOperations = ledger.listExternalOperations(runId);

  for (const event of events) {
    if (event.type === "remote.cost.preflight" && event.payload.remote === true) {
      const provider = stringValue(event.payload.provider) ?? "unknown";
      const modelId = stringValue(event.payload.modelId) ?? "unknown";
      const estimate = usageFromRemoteCostPreflight(event.payload);
      const key = rowKey({
        provider,
        modelId,
        stepType: stringValue(event.payload.command) ?? "remote.cost.preflight",
        phase: "preflight",
        workerId: "all"
      });
      maxUsage(rowFor(rows, key).estimatedMax, estimate);
      maxUsageForKey(estimatesByProviderModel, providerModelKey(provider, modelId), estimate);
    }
    if ((event.type === "ai.call.started" || event.type === "ai.call.completed") && typeof event.payload.externalOperationId === "string") {
      operationModels.set(event.payload.externalOperationId, {
        provider: stringValue(event.payload.provider) ?? "unknown",
        modelId: stringValue(event.payload.modelId) ?? "unknown"
      });
    }
    if (event.type === "provider.retry.scheduled" && typeof event.payload.retryAttemptOperationId === "string") {
      operationModels.set(event.payload.retryAttemptOperationId, {
        provider: stringValue(event.payload.provider) ?? "unknown",
        modelId: stringValue(event.payload.modelId) ?? "unknown"
      });
    }
  }

  for (const operation of externalOperations) {
    const info = {
      operationType: operation.operationType,
      status: operation.status,
      attempt: operation.attempt,
      retryOfOperationId: operation.retryOfOperationId,
      reservationId: operation.reservationId
    };
    operationInfo.set(operation.id, info);
    operationInfo.set(operation.idempotencyKey, info);
    operationInfoByReservation.set(operation.reservationId, info);
    const model = operationModels.get(operation.id);
    if (model) operationModels.set(operation.idempotencyKey, model);
    const key = rowKey({
      provider: operation.provider ?? model?.provider ?? "unknown",
      modelId: model?.modelId ?? "unknown",
      stepType: operation.operationType,
      phase: "unknown",
      workerId: "unknown"
    });
    if (operation.status === "failed") rowFor(rows, key).failed += 1;
    if (operation.status === "unknown_remote_outcome") rowFor(rows, key).unknownOperations += 1;
    if (operation.status === "dead_lettered") rowFor(rows, key).deadLetterOperations += 1;
    if (operation.status === "running" || operation.status === "reserved") {
      rowFor(rows, key);
    }
  }

  for (const event of events) {
    if (event.type === "budget.reserved") {
      const reservationId = stringValue(event.payload.reservationId);
      if (!reservationId) continue;
      const key = costEventKey(event.payload, operationModels, operationInfo);
      const reserve = usageFromPayload(event.payload.reserve);
      addUsage(rowFor(rows, key).reserved, reserve);
      reservations.set(reservationId, {
        key,
        reserve,
        settled: "open",
        operationStatus: operationInfoByReservation.get(reservationId)?.status
      });
    }
    if (event.type === "budget.debited") {
      const reservationId = stringValue(event.payload.reservationId);
      const debit = usageFromPayload(event.payload.debit);
      const state = reservationId ? reservations.get(reservationId) : undefined;
      const key = state?.key ?? costEventKey(event.payload, operationModels, operationInfo);
      addUsage(rowFor(rows, key).debited, debit);
      addUsage(rowFor(rows, key).committed, debit);
      const operationStatus = state?.operationStatus ?? operationStatusForPayload(event.payload, operationInfo, operationInfoByReservation);
      if (operationStatus === "failed" || operationStatus === "unknown_remote_outcome" || operationStatus === "dead_lettered") {
        addUsage(rowFor(rows, key).wasted, debit);
      }
      if (state) state.settled = "debited";
    }
    if (event.type === "budget.released") {
      const reservationId = stringValue(event.payload.reservationId);
      const state = reservationId ? reservations.get(reservationId) : undefined;
      if (!state) continue;
      addUsage(rowFor(rows, state.key).released, state.reserve);
      addUsage(rowFor(rows, state.key).refunded, state.reserve);
      state.settled = "released";
    }
    if (event.type === "ai.call.completed") {
      const key = costEventKey(event.payload, operationModels, operationInfo);
      addUsage(rowFor(rows, key).actualAttributed, actualAttributedUsage(event.payload));
    }
    if (event.type === "provider.retry.scheduled") {
      rowFor(rows, costEventKey(event.payload, operationModels, operationInfo, {
        preferRetryAttempt: true
      })).retried += 1;
    }
  }

  for (const state of reservations.values()) {
    if (state.settled === "open") {
      addUsage(rowFor(rows, state.key).inFlight, state.reserve);
      addUsage(rowFor(rows, state.key).unknown, state.reserve);
      if (state.operationStatus === "unknown_remote_outcome" || state.operationStatus === "dead_lettered") {
        addUsage(rowFor(rows, state.key).wasted, state.reserve);
      }
    }
  }
  for (const row of rows.values()) {
    const estimate = estimatesByProviderModel.get(providerModelKey(row.provider, row.modelId));
    if (estimate && usageTotal(row.estimatedMax) === 0 && usageTotal(row.reserved) + usageTotal(row.committed) + usageTotal(row.unknown) > 0) {
      maxUsage(row.estimatedMax, estimate);
    }
  }

  return [...rows.values()]
    .map(finalizeCostRow)
    .filter((row) =>
      usageTotal(row.estimatedMax) > 0 ||
      usageTotal(row.reserved) > 0 ||
      usageTotal(row.committed) > 0 ||
      usageTotal(row.debited) > 0 ||
      usageTotal(row.refunded) > 0 ||
      usageTotal(row.released) > 0 ||
      usageTotal(row.unknown) > 0 ||
      usageTotal(row.wasted) > 0 ||
      usageTotal(row.actualAttributed) > 0 ||
      usageTotal(row.inFlight) > 0 ||
      row.failed > 0 ||
      row.retried > 0 ||
      row.unknownOperations > 0 ||
      row.deadLetterOperations > 0
    )
    .sort((a, b) =>
      a.provider.localeCompare(b.provider) ||
      a.modelId.localeCompare(b.modelId) ||
      a.stepType.localeCompare(b.stepType) ||
      a.phase.localeCompare(b.phase) ||
      a.workerId.localeCompare(b.workerId)
    );
}

function providerModelKey(provider: string, modelId: string): string {
  return `${provider}\0${modelId}`;
}

function maxUsageForKey(map: Map<string, CostUsage>, key: string, usage: CostUsage): void {
  const existing = map.get(key) ?? emptyUsage();
  maxUsage(existing, usage);
  map.set(key, existing);
}

function costEventKey(
  payload: Record<string, unknown>,
  operationModels: Map<string, { provider: string; modelId: string }>,
  operationInfo: Map<string, { operationType: string }>,
  options: { preferRetryAttempt?: boolean } = {}
): string {
  const operationId = options.preferRetryAttempt
    ? stringValue(payload.retryAttemptOperationId) ?? stringValue(payload.externalOperationId) ?? stringValue(payload.operationId)
    : stringValue(payload.externalOperationId) ?? stringValue(payload.operationId) ?? stringValue(payload.retryAttemptOperationId);
  const operationBaseId = operationId?.split(":retry:")[0];
  const model = operationBaseId ? operationModels.get(operationBaseId) : undefined;
  const operation = operationBaseId ? operationInfo.get(operationBaseId) : undefined;
  return rowKey({
    provider: stringValue(payload.provider) ?? model?.provider ?? "unknown",
    modelId: stringValue(payload.modelId) ?? model?.modelId ?? "unknown",
    stepType: stringValue(payload.operationType) ?? operation?.operationType ?? "unknown",
    phase: stringValue(payload.phase) ?? "unknown",
    workerId: stringValue(payload.workerId) ?? "unknown"
  });
}

function operationStatusForPayload(
  payload: Record<string, unknown>,
  operationInfo: Map<string, { status: string }>,
  operationInfoByReservation: Map<string, { status: string }>
): string | undefined {
  const operationId = stringValue(payload.externalOperationId) ?? stringValue(payload.operationId) ?? stringValue(payload.retryAttemptOperationId);
  const operationBaseId = operationId?.split(":retry:")[0];
  const reservationId = stringValue(payload.reservationId);
  return (operationBaseId ? operationInfo.get(operationBaseId)?.status : undefined) ??
    (reservationId ? operationInfoByReservation.get(reservationId)?.status : undefined);
}

function rowKey(input: { provider: string; modelId: string; stepType: string; phase: string; workerId: string }): string {
  return JSON.stringify(input);
}

function rowFor(rows: Map<string, CostRow>, key: string): CostRow {
  const existing = rows.get(key);
  if (existing) return existing;
  const parsed = JSON.parse(key) as { provider: string; modelId: string; stepType?: string; phase: string; workerId: string };
  const row: CostRow = {
    ...parsed,
    stepType: parsed.stepType ?? "unknown",
    estimatedMax: emptyUsage(),
    reserved: emptyUsage(),
    committed: emptyUsage(),
    debited: emptyUsage(),
    refunded: emptyUsage(),
    released: emptyUsage(),
    failed: 0,
    retried: 0,
    unknown: emptyUsage(),
    unknownOperations: 0,
    deadLetterOperations: 0,
    wasted: emptyUsage(),
    actualAttributed: emptyUsage(),
    inFlight: emptyUsage(),
    reconciliation: {
      ok: true,
      tolerance: reconciliationTolerance(),
      issues: []
    }
  };
  rows.set(key, row);
  return row;
}

function emptyUsage(): CostUsage {
  return { attempts: 0, tokens: 0, usd: 0, elapsedMs: 0 };
}

function usageFromPayload(value: unknown): CostUsage {
  if (!value || typeof value !== "object") return emptyUsage();
  const record = value as Record<string, unknown>;
  return {
    attempts: numberValue(record.attempts),
    tokens: numberValue(record.tokens),
    usd: numberValue(record.usd),
    elapsedMs: numberValue(record.elapsedMs)
  };
}

function usageFromRemoteCostPreflight(payload: Record<string, unknown>): CostUsage {
  const envelope = recordValue(payload.envelope);
  const upperBounds = recordValue(envelope.upperBounds);
  const estimate = recordValue(payload.estimate);
  return {
    attempts: numberValue(upperBounds.attempts ?? payload.estimatedMaxProviderCalls),
    tokens: numberValue(upperBounds.tokens ?? estimate.tokenUpperBound),
    usd: numberValue(upperBounds.usd ?? estimate.usdUpperBound),
    elapsedMs: numberValue(upperBounds.wallTimeMs)
  };
}

function actualAttributedUsage(payload: Record<string, unknown>): CostUsage {
  const usage = recordValue(payload.usage);
  const usdSettlement = recordValue(payload.usdSettlement);
  return {
    attempts: 1,
    tokens: numberValue(usage.totalTokens),
    usd: usdSettlement.source === "provider_metadata" ? numberValue(usdSettlement.usd) : 0,
    elapsedMs: numberValue(payload.latencyMs)
  };
}

function addUsage(target: CostUsage, usage: CostUsage): void {
  target.attempts += usage.attempts;
  target.tokens += usage.tokens;
  target.usd += usage.usd;
  target.elapsedMs += usage.elapsedMs;
}

function maxUsage(target: CostUsage, usage: CostUsage): void {
  target.attempts = Math.max(target.attempts, usage.attempts);
  target.tokens = Math.max(target.tokens, usage.tokens);
  target.usd = Math.max(target.usd, usage.usd);
  target.elapsedMs = Math.max(target.elapsedMs, usage.elapsedMs);
}

function usageTotal(usage: CostUsage): number {
  return usage.attempts + usage.tokens + usage.usd + usage.elapsedMs;
}

function finalizeCostRow(row: CostRow): CostRow {
  const tolerance = reconciliationTolerance();
  const issues: string[] = [];
  const remoteActivity = row.provider !== "local" && row.provider !== "unknown" && (
    usageTotal(row.reserved) > 0 ||
    usageTotal(row.committed) > 0 ||
    usageTotal(row.unknown) > 0 ||
    row.unknownOperations > 0 ||
    row.deadLetterOperations > 0
  );
  const hasEstimate = usageTotal(row.estimatedMax) > 0;
  if (remoteActivity && !hasEstimate) issues.push("missing_remote_cost_preflight_estimate");
  if (hasEstimate) {
    for (const dimension of ["attempts", "tokens", "usd", "elapsedMs"] as const) {
      const observed = row.committed[dimension] + row.unknown[dimension];
      const allowed = row.estimatedMax[dimension] + tolerance[dimension];
      if (observed > allowed) {
        issues.push(`observed_${dimension}_exceeds_estimate:${observed}/${row.estimatedMax[dimension]}`);
      }
    }
  }
  if (usageTotal(row.unknown) > 0 || row.unknownOperations > 0 || row.deadLetterOperations > 0) {
    issues.push("unknown_or_in_flight_provider_spend");
  }
  return {
    ...row,
    reconciliation: {
      ok: issues.length === 0,
      tolerance,
      issues
    }
  };
}

function reconciliationTolerance(): CostUsage {
  return {
    attempts: 0,
    tokens: 0,
    usd: 0.000001,
    elapsedMs: 1000
  };
}

function budgetAccounting(events: LedgerEvent[]): FinalAnswerProvenance["budget"] {
  const budget = {
    reserved: emptyUsage(),
    debited: emptyUsage(),
    released: emptyUsage(),
    inFlight: emptyUsage()
  };
  const reservations = new Map<string, { reserve: CostUsage; settled: "open" | "debited" | "released" }>();
  for (const event of events) {
    const reservationId = stringValue(event.payload.reservationId);
    if (event.type === "budget.reserved") {
      const reserve = usageFromPayload(event.payload.reserve);
      addUsage(budget.reserved, reserve);
      if (reservationId) reservations.set(reservationId, { reserve, settled: "open" });
    }
    if (event.type === "budget.debited") {
      addUsage(budget.debited, usageFromPayload(event.payload.debit));
      const reservation = reservationId ? reservations.get(reservationId) : undefined;
      if (reservation) reservation.settled = "debited";
    }
    if (event.type === "budget.released") {
      const reservation = reservationId ? reservations.get(reservationId) : undefined;
      const released = usageFromPayload(event.payload.release);
      addUsage(budget.released, usageTotal(released) > 0 ? released : reservation?.reserve ?? emptyUsage());
      if (reservation) reservation.settled = "released";
    }
  }
  for (const reservation of reservations.values()) {
    if (reservation.settled === "open") addUsage(budget.inFlight, reservation.reserve);
  }
  return budget;
}

function finalAnswerFailClosedReasons(input: {
  terminalEvent?: LedgerEvent;
  audit: AuditResult;
  witnessOk: boolean;
  replayGateOk: boolean;
  outcomeCanClaimSolved: boolean;
  verifierIds: string[];
  runStatus: string;
  finalizationEvent?: LedgerEvent;
  adversarialQuorumEvent?: LedgerEvent;
}): string[] {
  const reasons: string[] = [];
  if (!input.terminalEvent) reasons.push("missing_terminal_event");
  if (!input.audit.ok) reasons.push("audit_failed");
  if (!input.witnessOk) reasons.push("ledger_witness_failed");
  if (!input.replayGateOk) reasons.push("offline_replay_self_contained_failed");
  if (input.outcomeCanClaimSolved && input.verifierIds.length === 0) reasons.push("missing_verifier_evidence");
  if (input.runStatus === "goal_met" && !input.finalizationEvent) reasons.push("missing_no_false_solved_finalization");
  if (input.runStatus === "goal_met" && input.finalizationEvent && input.finalizationEvent.payload.status !== "passed") {
    reasons.push("no_false_solved_finalization_failed");
  }
  if (input.runStatus === "goal_met" && !input.adversarialQuorumEvent) reasons.push("missing_adversarial_quorum");
  if (input.runStatus === "goal_met" && input.adversarialQuorumEvent && input.adversarialQuorumEvent.payload.status !== "passed") {
    reasons.push("adversarial_quorum_not_passed");
  }
  return reasons;
}

function finalizationSummary(
  runStatus: string,
  event?: LedgerEvent
): FinalAnswerProvenance["finalization"] {
  if (!event) {
    return {
      status: runStatus === "goal_met" ? "missing" : "not_required",
      checkIds: [],
      failureReasons: runStatus === "goal_met" ? ["missing_no_false_solved_finalization"] : []
    };
  }
  return {
    status: event.payload.status === "passed" ? "passed" : "failed",
    eventId: event.id,
    artifactId: stringValue(event.payload.artifactId),
    reviewHash: stringValue(event.payload.reviewHash),
    checkIds: arrayValue(event.payload.checks)
      .map((check) => stringValue(recordValue(check).id))
      .filter((id): id is string => Boolean(id)),
    failureReasons: stringArrayValue(event.payload.failureReasons)
  };
}

function adversarialQuorumSummary(
  runStatus: string,
  event?: LedgerEvent
): FinalAnswerProvenance["adversarialQuorum"] {
  if (!event) {
    return {
      status: runStatus === "goal_met" ? "missing" : "not_required",
      criticIds: [],
      criticRoles: [],
      acceptedFindings: 0,
      rejectedFindings: [],
      degraded: false,
      artifactIds: []
    };
  }
  const critics = arrayValue(event.payload.critics).map(recordValue);
  const rejectedFindings = arrayValue(event.payload.rejectedFindings)
    .map(recordValue)
    .map((finding) => ({
      id: stringValue(finding.id),
      severity: stringValue(finding.severity),
      rationale: stringValue(finding.rationale)
    }));
  const capacityFailure = recordValue(event.payload.capacityFailure);
  const status = stringValue(event.payload.status);
  return {
    status: status === "passed" || status === "failed" || status === "degraded_capacity" ? status : "failed",
    eventId: event.id,
    artifactId: stringValue(event.payload.artifactId),
    reviewHash: stringValue(event.payload.reviewHash),
    scope: stringValue(event.payload.scope),
    criticIds: uniqueStringArray(critics.map((critic) => stringValue(critic.criticId))),
    criticRoles: uniqueStringArray(critics.map((critic) => stringValue(critic.role))),
    acceptedFindings: arrayValue(event.payload.acceptedFindings).length,
    rejectedFindings,
    degraded: event.payload.degraded === true,
    capacityFailureReason: stringValue(capacityFailure.reason),
    artifactIds: event.artifactIds
  };
}

function verifierIdsFromEvents(events: LedgerEvent[]): string[] {
  const ids = new Set<string>();
  for (const event of events) {
    const verifier = stringValue(event.payload.verifier) ?? stringValue(event.payload.verifierId);
    if (verifier) ids.add(verifier);
    const claim = event.payload.claim;
    if (claim && typeof claim === "object" && !Array.isArray(claim)) {
      const claimVerifier = stringValue((claim as Record<string, unknown>).verifierId);
      if (claimVerifier) ids.add(claimVerifier);
    }
  }
  return [...ids].sort();
}

function verifierStatus(input: {
  auditOk: boolean;
  finalState: string;
  verifierIds: string[];
}): FinalAnswerProvenance["verifier"]["status"] {
  if (!input.auditOk) return "audit_failed";
  if (input.verifierIds.length > 0) return "verified";
  if (input.finalState === "budget_exhausted" || input.finalState === "cancelled" || input.finalState === "failed") {
    return "not_required_for_terminal_state";
  }
  return "missing";
}

function artifactBundlePaths(artifacts: Artifact[]): Array<{ artifactId: string; kind: string; sha256: string; contentAddress: string; mediaType: string; storageKey: string; bundlePath: string; localRelativePath: string }> {
  return artifacts
    .map((artifact) => ({
      artifactId: artifact.id,
      kind: artifact.kind,
      sha256: artifact.sha256,
      contentAddress: artifact.contentAddress,
      mediaType: artifact.mediaType,
      storageKey: artifact.storageKey,
      bundlePath: `artifacts/${artifact.storageKey}`,
      localRelativePath: `artifacts/${artifact.storageKey}`
    }))
    .sort((left, right) => left.kind.localeCompare(right.kind) || left.artifactId.localeCompare(right.artifactId));
}

function reportSourceEvents(events: LedgerEvent[]): LedgerEvent[] {
  return events.filter((event) => event.type !== "report.generated");
}

function reportSourceArtifacts(artifacts: Artifact[]): Artifact[] {
  return artifacts.filter((artifact) => !artifact.kind.startsWith("report."));
}

function isProofArtifact(artifact: Artifact): boolean {
  return artifact.kind.includes("proof") ||
    artifact.kind.startsWith("verifier.") ||
    artifact.kind.startsWith("formalization.") ||
    artifact.kind === "computation.executable";
}

function isSourceArtifact(artifact: Artifact): boolean {
  return artifact.kind.startsWith("source.") || artifact.kind.includes("arxiv") || artifact.kind.includes("citation");
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function reportGenerationIdempotencyKey(runId: string, ledger: Ledger): string {
  const run = ledger.requireRun(runId);
  const events = reportSourceEvents(ledger.listEvents(runId));
  const artifacts = reportSourceArtifacts(ledger.listArtifacts(runId));
  return `report_${stableHash({
    runId,
    status: run.status,
    evidenceGrade: run.evidenceGrade,
    events: events.map((event) => ({
      id: event.id,
      type: event.type,
      sequence: event.sequence,
      artifactIds: event.artifactIds
    })),
    artifacts: artifacts.map((artifact) => ({
      id: artifact.id,
      kind: artifact.kind,
      sha256: artifact.sha256,
      contentAddress: artifact.contentAddress,
      mediaType: artifact.mediaType,
      storageKey: artifact.storageKey,
      bytes: artifact.bytes
    }))
  }).slice(0, 32)}`;
}

export function readArtifactPreview(path: string, maxChars = 1000): string {
  const content = readFileSync(path, "utf8");
  return content.length <= maxChars ? content : `${content.slice(0, maxChars)}\n...`;
}
