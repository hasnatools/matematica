import type { ArtifactStore } from "./artifacts";
import { latestAdversarialQuorumForTarget } from "./adversarial-quorum";
import type { Artifact, EvidenceGrade, GoalRun, LedgerEvent } from "./domain";
import type { GoalSuccessEvaluation } from "./goal-success";
import { stableHash } from "./idempotency";
import type { Ledger } from "./ledger";
import { classificationForRun } from "./problem-classifier";

export const NO_FALSE_SOLVED_FINALIZATION_VERSION = 1;

export type FinalizationCheckStatus = "passed" | "failed" | "not_required";

export type NoFalseSolvedCheck = {
  id:
    | "goal_success_decision"
    | "problem_classification"
    | "independent_adversarial_review"
    | "citation_support"
    | "proof_support"
    | "proof_certificate"
    | "adversarial_planning_quorum"
    | "verification_artifacts"
    | "budget_ledger_consistency"
    | "explicit_failure_reasons";
  status: FinalizationCheckStatus;
  reason: string;
  artifactIds: string[];
};

export type NoFalseSolvedFinalization = {
  format: "matematica.no-false-solved-finalization";
  version: 1;
  runId: string;
  goalSuccessEventId: string;
  status: "passed" | "failed";
  canMarkGoalMet: boolean;
  claimId: string;
  verifierId: string;
  evidenceGrade: EvidenceGrade;
  finalState: string;
  canClaimSolved: boolean;
  problemClassification: ReturnType<typeof classificationForRun>;
  checks: NoFalseSolvedCheck[];
  failureReasons: string[];
  satisfyingArtifactIds: string[];
  reviewHash: string;
};

export function persistNoFalseSolvedFinalization(input: {
  runId: string;
  ledger: Ledger;
  artifacts: ArtifactStore;
  goalSuccessEvent: LedgerEvent;
  successEvaluation: GoalSuccessEvaluation;
}): { review: NoFalseSolvedFinalization; artifact: Artifact; event: LedgerEvent } {
  const run = input.ledger.requireRun(input.runId);
  const events = input.ledger.listEvents(input.runId);
  const artifacts = input.ledger.listArtifacts(input.runId);
  const review = evaluateNoFalseSolvedFinalization({
    run,
    events,
    artifacts,
    externalOperations: input.ledger.listExternalOperations(input.runId),
    goalSuccessEvent: input.goalSuccessEvent,
    successEvaluation: input.successEvaluation
  });
  const artifact = input.artifacts.create(input.runId, "goal.finalization.no-false-solved", JSON.stringify(review, null, 2));
  const event = input.ledger.appendEvent(input.runId, "goal.finalization.checked", {
    ...review,
    artifactId: artifact.id
  }, [artifact.id, ...review.satisfyingArtifactIds]);
  return { review, artifact, event };
}

export function evaluateNoFalseSolvedFinalization(input: {
  run: GoalRun;
  events: LedgerEvent[];
  artifacts: Artifact[];
  externalOperations?: Array<{ status: string }>;
  goalSuccessEvent: LedgerEvent;
  successEvaluation: GoalSuccessEvaluation;
}): NoFalseSolvedFinalization {
  const checks: NoFalseSolvedCheck[] = [
    goalSuccessDecisionCheck(input.goalSuccessEvent, input.successEvaluation),
    problemClassificationCheck(input.run, input.events, input.successEvaluation),
    independentAdversarialReviewCheck(input.events, input.successEvaluation),
    citationSupportCheck(input.events),
    proofSupportCheck(input.events),
    proofCertificateCheck(input.events),
    adversarialPlanningQuorumCheck(input.events, input.goalSuccessEvent),
    verificationArtifactsCheck(input.artifacts, input.events, input.successEvaluation),
    budgetLedgerConsistencyCheck(input.events, input.externalOperations ?? []),
  ];
  const failed = checks.filter((check) => check.status === "failed");
  const failureReasons = failed.map((check) => `${check.id}:${check.reason}`);
  checks.push({
    id: "explicit_failure_reasons",
    status: failed.length === 0 || failureReasons.length > 0 ? "passed" : "failed",
    reason: failed.length === 0
      ? "No unsupported finalization claims were found."
      : "Unsupported finalization claims have explicit failure reasons.",
    artifactIds: []
  });

  const unsigned = {
    format: "matematica.no-false-solved-finalization" as const,
    version: NO_FALSE_SOLVED_FINALIZATION_VERSION as 1,
    runId: input.run.id,
    goalSuccessEventId: input.goalSuccessEvent.id,
    status: failed.length === 0 ? "passed" as const : "failed" as const,
    canMarkGoalMet: failed.length === 0 && input.successEvaluation.status === "goal_met",
    claimId: input.successEvaluation.claimId,
    verifierId: input.successEvaluation.verifierId,
    evidenceGrade: input.successEvaluation.evidenceGrade,
    finalState: input.successEvaluation.finalState,
    canClaimSolved: failed.length === 0 && input.successEvaluation.canClaimSolved,
    problemClassification: classificationForRun(input.run, input.events),
    checks,
    failureReasons,
    satisfyingArtifactIds: input.successEvaluation.satisfyingArtifactIds
  };

  return {
    ...unsigned,
    reviewHash: stableHash(unsigned)
  };
}

function goalSuccessDecisionCheck(
  event: LedgerEvent,
  successEvaluation: GoalSuccessEvaluation
): NoFalseSolvedCheck {
  const failures: string[] = [];
  if (event.type !== "goal.success.evaluated") failures.push("event is not goal.success.evaluated");
  if (event.payload.status !== "goal_met") failures.push("goal success event does not approve goal_met");
  if (event.payload.claimId !== successEvaluation.claimId) failures.push("claim id mismatch");
  if (event.payload.verifierId !== successEvaluation.verifierId) failures.push("verifier id mismatch");
  if (event.payload.evidenceGrade !== successEvaluation.evidenceGrade) failures.push("evidence grade mismatch");
  if (!sameStrings(stringArray(event.payload.satisfyingArtifactIds), successEvaluation.satisfyingArtifactIds)) {
    failures.push("satisfying artifact ids mismatch");
  }
  return checkResult("goal_success_decision", failures, stringArray(event.artifactIds), "Persisted goal success decision matches the finalization candidate.");
}

function problemClassificationCheck(
  run: GoalRun,
  events: LedgerEvent[],
  successEvaluation: GoalSuccessEvaluation
): NoFalseSolvedCheck {
  const review = events.findLast((event) => event.type === "problem.classification.reviewed");
  if (!review) {
    return failedCheck("problem_classification", "missing problem classification review; unknown classification defaults to not solved", []);
  }
  const classification = classificationForRun(run, events);
  if (classification.class === "open_problem" && successEvaluation.canClaimSolved && successEvaluation.evidenceGrade !== "formal_proof") {
    return failedCheck(
      "problem_classification",
      `open-problem classification cannot claim solved from ${successEvaluation.evidenceGrade}`,
      review.artifactIds
    );
  }
  return passedCheck(
    "problem_classification",
    `Problem classification is ${classification.class}; unknown/open-problem cases cannot silently claim solved.`,
    review.artifactIds
  );
}

function independentAdversarialReviewCheck(
  events: LedgerEvent[],
  successEvaluation: GoalSuccessEvaluation
): NoFalseSolvedCheck {
  const verifier = events.findLast((event) =>
    event.type === "verifier.completed" &&
    event.payload.verifier === "evidence-gate"
  );
  const proof = events.findLast((event) => event.type === "proof.obligations.reviewed");
  const counterexample = events.findLast((event) => event.type === "counterexample.search.reviewed");
  const claimGraph = events.findLast((event) => event.type === "claim.graph.reviewed");
  const failures: string[] = [];

  const quorum = recordValue(recordValue(verifier?.payload.gate).quorum);
  const satisfiedBy = arrayValue(quorum.satisfiedBy).map(recordValue);
  const independentRoles = satisfiedBy
    .map((item) => stringValue(item.role))
    .filter((role) => role && role !== "primary_verifier");
  if (independentRoles.length === 0) failures.push("missing independent verifier or reviewer quorum");

  const proofDecision = recordValue(proof?.payload.decision);
  if (!proof || proofDecision.ok !== true) failures.push("missing passing proof-obligation review");
  if (!counterexample) failures.push("missing counterexample/adversarial pressure review");
  if (claimGraph) {
    const decision = recordValue(claimGraph.payload.decision);
    if (decision.ok === false) failures.push("claim graph review blocks the target claim");
  } else {
    failures.push("missing claim graph review");
  }
  if (successEvaluation.finalClaimAcceptance.some((claim) => claim.status !== "accepted_formal_proof" && claim.status !== "accepted_computational_proof" && claim.status !== "accepted_counterexample")) {
    failures.push("final claim acceptance is not fully accepted");
  }

  return checkResult(
    "independent_adversarial_review",
    failures,
    uniqueStrings([
      ...stringArray(verifier?.artifactIds),
      ...stringArray(proof?.artifactIds),
      ...stringArray(counterexample?.artifactIds),
      ...stringArray(claimGraph?.artifactIds)
    ]),
    "Independent verifier quorum, proof-obligation review, counterexample pressure, and claim graph review are present."
  );
}

function citationSupportCheck(events: LedgerEvent[]): NoFalseSolvedCheck {
  const sourceEvents = events.filter((event) =>
    event.type === "source.citations.reviewed" ||
    event.type === "source.retrieval.evaluated" ||
    event.type === "source.license.manifest.reviewed"
  );
  if (sourceEvents.length === 0) {
    return {
      id: "citation_support",
      status: "not_required",
      reason: "No source-derived final support was used for this finalization candidate.",
      artifactIds: []
    };
  }

  const failures: string[] = [];
  for (const event of sourceEvents) {
    if (event.type === "source.citations.reviewed" && event.payload.ok !== true) {
      failures.push("citation grounding failed");
    }
    if (event.type === "source.retrieval.evaluated" && event.payload.trustImpact === "adversarial_review_required") {
      failures.push("retrieval evaluation requires adversarial review");
    }
    if (event.type === "source.license.manifest.reviewed" && event.payload.ok === false) {
      failures.push("source license manifest failed");
    }
  }
  return checkResult(
    "citation_support",
    uniqueStrings(failures),
    uniqueStrings(sourceEvents.flatMap((event) => event.artifactIds)),
    "Source citation, retrieval, and license reviews do not support a false solved claim."
  );
}

function proofSupportCheck(events: LedgerEvent[]): NoFalseSolvedCheck {
  const proof = events.findLast((event) => event.type === "proof.obligations.reviewed");
  if (!proof) return failedCheck("proof_support", "missing proof-obligation review", []);
  const decision = recordValue(proof.payload.decision);
  const trace = recordValue(proof.payload.trace);
  const failures: string[] = [];
  if (decision.ok !== true) failures.push("proof-obligation decision is not ok");
  if (trace.cycleDetected === true) failures.push("proof-obligation trace has a cycle");
  if (arrayValue(trace.unresolvedObligationIds).length > 0) failures.push("proof-obligation trace has unresolved obligations");
  if (!stringValue(proof.payload.artifactId)) failures.push("proof-obligation artifact id is missing");
  return checkResult("proof_support", failures, proof.artifactIds, "Proof support is reviewed, acyclic, artifact-backed, and fully discharged.");
}

function proofCertificateCheck(events: LedgerEvent[]): NoFalseSolvedCheck {
  const certificate = events.findLast((event) => event.type === "proof.certificate.minimized");
  if (!certificate) return failedCheck("proof_certificate", "missing minimized proof certificate", []);
  const failures: string[] = [];
  if (certificate.payload.status !== "passed") failures.push("proof certificate did not pass");
  if (certificate.payload.minimized !== true) failures.push("proof certificate is not minimized");
  const offlineReplay = recordValue(certificate.payload.offlineReplay);
  if (offlineReplay.verified !== true) failures.push("proof certificate is not offline replay verified");
  if (offlineReplay.mode !== "clean_home_import_offline_final_replay") failures.push("proof certificate is not backed by clean-home offline replay");
  if (offlineReplay.networkPolicy !== "no_new_network_or_provider_calls") failures.push("proof certificate has unsafe replay network policy");
  if (!stringValue(offlineReplay.transcriptArtifactId)) failures.push("proof certificate clean-home replay transcript artifact is missing");
  if (!stringValue(offlineReplay.transcriptArtifactHash) || !stringValue(offlineReplay.transcriptHash)) failures.push("proof certificate clean-home replay transcript hash is missing");
  if (!stringValue(offlineReplay.bundleExpectationHash)) failures.push("proof certificate clean-home replay bundle expectation hash is missing");
  if (offlineReplay.importOk !== true) failures.push("proof certificate clean-home replay import did not pass");
  if (offlineReplay.replayOk !== true) failures.push("proof certificate clean-home replay did not pass");
  if (offlineReplay.finalVerificationOk !== true) failures.push("proof certificate clean-home replay final verification did not pass");
  if (offlineReplay.simulated === true) failures.push("proof certificate clean-home replay is simulated");
  if (offlineReplay.privatePathDetected === true) failures.push("proof certificate clean-home replay contains private paths");
  if (offlineReplay.providerKeysPresent === true) failures.push("proof certificate clean-home replay used provider keys");
  if (!stringValue(certificate.payload.certificateHash)) failures.push("proof certificate hash is missing");
  const artifactRefs = arrayValue(certificate.payload.artifactRefs).map(recordValue);
  if (artifactRefs.length === 0) failures.push("proof certificate has no artifact refs");
  for (const ref of artifactRefs) {
    const kind = stringValue(ref.kind) ?? "";
    if (kind.startsWith("ai.") || kind.startsWith("source.")) {
      failures.push(`proof certificate includes non-proof artifact ${stringValue(ref.artifactId) ?? "unknown"}:${kind}`);
    }
    if (!stringValue(ref.sha256)) failures.push(`proof certificate artifact ${stringValue(ref.artifactId) ?? "unknown"} is missing hash`);
  }
  const replayTranscriptRef = artifactRefs.find((ref) => stringValue(ref.artifactId) === stringValue(offlineReplay.transcriptArtifactId));
  if (!replayTranscriptRef) {
    failures.push("proof certificate clean-home replay transcript is not in artifact refs");
  } else if (
    stringValue(replayTranscriptRef.sha256) !== stringValue(offlineReplay.transcriptArtifactHash) ||
    stringValue(replayTranscriptRef.sha256) !== stringValue(offlineReplay.transcriptHash)
  ) {
    failures.push("proof certificate clean-home replay transcript hash drifted");
  }
  const dependencyEvents = arrayValue(certificate.payload.dependencyEvents).map(recordValue);
  if (dependencyEvents.length === 0) failures.push("proof certificate has no dependency event hashes");
  for (const event of dependencyEvents) {
    if (!stringValue(event.eventHash) || !stringValue(event.payloadHash)) {
      failures.push(`proof certificate dependency event ${stringValue(event.eventId) ?? "unknown"} is missing replay hashes`);
    }
  }
  return checkResult("proof_certificate", uniqueStrings(failures), certificate.artifactIds, "A compact proof certificate with dependency hashes and offline replay policy is persisted.");
}

function adversarialPlanningQuorumCheck(events: LedgerEvent[], goalSuccessEvent: LedgerEvent): NoFalseSolvedCheck {
  const quorum = latestAdversarialQuorumForTarget(events, "finalization", goalSuccessEvent.id);
  if (!quorum) return failedCheck("adversarial_planning_quorum", "missing adversarial finalization quorum review", []);
  const failures: string[] = [];
  if (quorum.payload.status !== "passed") failures.push(`adversarial quorum status is ${String(quorum.payload.status)}`);
  if (quorum.payload.degraded === true) failures.push("adversarial quorum is degraded");
  const modelFamilyDiversity = recordValue(quorum.payload.modelFamilyDiversity);
  if (modelFamilyDiversity.status !== "passed") {
    failures.push(`adversarial model-family diversity is ${String(modelFamilyDiversity.status ?? "missing")}`);
  }
  if (typeof modelFamilyDiversity.effectiveIndependentSignals === "number" && modelFamilyDiversity.effectiveIndependentSignals < 2) {
    failures.push(`adversarial quorum has only ${modelFamilyDiversity.effectiveIndependentSignals} provider/model-family signal`);
  }
  const critics = arrayValue(quorum.payload.critics).map(recordValue);
  if (critics.length < 2) failures.push(`requires at least 2 persisted critics, got ${critics.length}`);
  const independentGroups = new Set(
    critics
      .map((critic) => stringValue(critic.independentGroup))
      .filter((group): group is string => Boolean(group))
  );
  if (independentGroups.size < 2) failures.push("critics are not independently grouped");
  const roles = new Set(
    critics
      .map((critic) => stringValue(critic.role))
      .filter((role): role is string => Boolean(role))
  );
  if (roles.size < 2) failures.push("adversarial quorum has fewer than two roles");
  for (const critic of critics) {
    const criticId = stringValue(critic.criticId) ?? "unknown";
    if (stringValue(critic.source) === "default_synthetic") {
      failures.push(`critic ${criticId} uses default/synthetic critic source`);
    }
    const blindReview = recordValue(critic.blindReview);
    if (blindReview.blindedToFinalVerdict !== true) {
      failures.push(`critic ${criticId} is not blind to the proposed final verdict`);
    }
    if (!stringValue(blindReview.targetDigest)) failures.push(`critic ${criticId} is missing blind target digest`);
    if (!stringValue(blindReview.protocolHash)) failures.push(`critic ${criticId} is missing blind review protocol hash`);
    if (!stringArray(blindReview.redactedFields).includes("status")) {
      failures.push(`critic ${criticId} blind review did not redact final verdict status`);
    }
    const providerLineage = recordValue(critic.providerLineage);
    if (!stringValue(providerLineage.provider)) failures.push(`critic ${criticId} is missing provider lineage`);
    if (!stringValue(providerLineage.modelFamily)) failures.push(`critic ${criticId} is missing model-family lineage`);
    if (stringArray(providerLineage.routingPath).length === 0) failures.push(`critic ${criticId} is missing routing path lineage`);
    if (stringArray(critic.artifactIds).length === 0) failures.push(`critic ${criticId} is missing artifact ids`);
    const findings = arrayValue(critic.findings).map(recordValue);
    if (findings.length === 0) failures.push(`critic ${criticId} is missing findings`);
    for (const finding of findings) {
      if (!stringValue(finding.rationale)) failures.push(`finding ${stringValue(finding.id) ?? "unknown"} is missing rationale`);
      const severity = stringValue(finding.severity);
      if (finding.status === "accepted" && (severity === "high" || severity === "critical")) {
        failures.push(`accepted ${severity} adversarial finding ${stringValue(finding.id) ?? "unknown"} blocks finalization`);
      }
    }
  }
  if (stringValue(quorum.payload.reviewHash) === undefined) failures.push("adversarial quorum review hash is missing");
  if (quorum.artifactIds.length === 0) failures.push("adversarial quorum event does not link artifacts");
  return checkResult(
    "adversarial_planning_quorum",
    failures,
    quorum.artifactIds,
    "A persisted independent adversarial quorum reviewed finalization and rejected findings include rationale."
  );
}

function verificationArtifactsCheck(
  artifacts: Artifact[],
  events: LedgerEvent[],
  successEvaluation: GoalSuccessEvaluation
): NoFalseSolvedCheck {
  const artifactsById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const verifier = events.findLast((event) =>
    event.type === "verifier.completed" &&
    event.payload.verifier === "evidence-gate"
  );
  const gate = recordValue(verifier?.payload.gate);
  const quorum = recordValue(gate.quorum);
  const quorumArtifactIds = arrayValue(quorum.satisfiedBy)
    .flatMap((item) => stringArray(recordValue(item).artifactIds));
  const requiredArtifactIds = uniqueStrings([
    ...successEvaluation.satisfyingArtifactIds,
    ...quorumArtifactIds
  ]);
  const failures: string[] = [];
  if (!verifier || gate.canMarkGoalMet !== true) failures.push("evidence-gate verifier did not approve goal_met");
  for (const artifactId of requiredArtifactIds) {
    const artifact = artifactsById.get(artifactId);
    if (!artifact) {
      failures.push(`missing artifact ${artifactId}`);
      continue;
    }
    if (artifact.kind.startsWith("ai.")) {
      failures.push(`AI artifact ${artifactId} cannot support final solved status`);
    }
  }
  return checkResult("verification_artifacts", failures, requiredArtifactIds, "All final verifier and quorum artifacts exist and are not AI-provider artifacts.");
}

function budgetLedgerConsistencyCheck(
  events: LedgerEvent[],
  externalOperations: Array<{ status: string }>
): NoFalseSolvedCheck {
  const reservations = new Map<string, "open" | "debited" | "released">();
  for (const event of events) {
    const reservationId = stringValue(event.payload.reservationId);
    if (event.type === "budget.reserved" && reservationId) reservations.set(reservationId, "open");
    if (event.type === "budget.debited" && reservationId) reservations.set(reservationId, "debited");
    if (event.type === "budget.released" && reservationId) reservations.set(reservationId, "released");
  }
  const openReservationCount = [...reservations.values()].filter((status) => status === "open").length;
  const unsettledExternalCount = externalOperations.filter((operation) =>
    operation.status === "reserved" ||
    operation.status === "running" ||
    operation.status === "unknown_remote_outcome" ||
    operation.status === "dead_lettered"
  ).length;
  const failures: string[] = [];
  if (openReservationCount > 0) failures.push(`${openReservationCount} open budget reservations`);
  if (unsettledExternalCount > 0) failures.push(`${unsettledExternalCount} unsettled external operations`);
  return checkResult("budget_ledger_consistency", failures, [], "Budget reservations and external operations are settled before goal_met.");
}

function checkResult(
  id: NoFalseSolvedCheck["id"],
  failures: string[],
  artifactIds: string[],
  passedReason: string
): NoFalseSolvedCheck {
  return failures.length === 0
    ? passedCheck(id, passedReason, artifactIds)
    : failedCheck(id, failures.join("; "), artifactIds);
}

function passedCheck(id: NoFalseSolvedCheck["id"], reason: string, artifactIds: string[]): NoFalseSolvedCheck {
  return { id, status: "passed", reason, artifactIds };
}

function failedCheck(id: NoFalseSolvedCheck["id"], reason: string, artifactIds: string[]): NoFalseSolvedCheck {
  return { id, status: "failed", reason, artifactIds };
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}
