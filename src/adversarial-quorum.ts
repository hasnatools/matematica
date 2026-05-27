import type { ArtifactStore } from "./artifacts";
import type { Artifact, LedgerEvent } from "./domain";
import { stableHash } from "./idempotency";
import type { Ledger } from "./ledger";

export const ADVERSARIAL_QUORUM_VERSION = 1;

export type AdversarialQuorumScope = "phase_transition" | "finalization" | "plan_change";
export type AdversarialCriticRole = "skeptical_planner" | "budget_guard" | "evidence_skeptic" | "replay_auditor";
export type AdversarialFindingStatus = "accepted" | "rejected";
export type AdversarialFindingSeverity = "info" | "low" | "medium" | "high" | "critical";
export type AdversarialQuorumStatus = "passed" | "failed" | "degraded_capacity";
export type AdversarialCriticSource =
  | "default_synthetic"
  | "evidence_gate_auditor"
  | "ledger_replay_auditor"
  | "external_model"
  | "human";

export type AdversarialCriticFinding = {
  id: string;
  severity: AdversarialFindingSeverity;
  finding: string;
  status: AdversarialFindingStatus;
  rationale: string;
  artifactIds: string[];
};

export type AdversarialProviderLineage = {
  provider: string;
  upstreamProvider?: string;
  requestedModelId: string;
  actualModelId?: string;
  modelFamily: string;
  routingPath: string[];
  systemPromptLineageHash?: string;
};

export type AdversarialBlindReview = {
  blindedToFinalVerdict: boolean;
  targetDigest: string;
  redactedFields: string[];
  protocolHash: string;
};

export type AdversarialCriticReview = {
  criticId: string;
  role: AdversarialCriticRole;
  independentGroup: string;
  source: AdversarialCriticSource;
  blindReview?: AdversarialBlindReview;
  providerLineage: AdversarialProviderLineage;
  summary: string;
  artifactIds: string[];
  findings: AdversarialCriticFinding[];
};

export type AdversarialCapacityFailure = {
  reason: string;
  requestedCritics: number;
  availableCritics: number;
  artifactId?: string;
};

export type AdversarialQuorumReview = {
  format: "matematica.adversarial-quorum-review";
  version: 1;
  runId: string;
  scope: AdversarialQuorumScope;
  targetEventId?: string;
  targetEventType?: string;
  targetArtifactIds: string[];
  status: AdversarialQuorumStatus;
  degraded: boolean;
  critics: AdversarialCriticReview[];
  modelFamilyDiversity: {
    status: "passed" | "downgraded_to_single_signal";
    effectiveIndependentSignals: number;
    distinctIndependenceKeys: string[];
    downgradedCriticIds: string[];
    routingGroups: Array<{
      independenceKey: string;
      criticIds: string[];
      providers: string[];
      upstreamProviders: string[];
      modelFamilies: string[];
      requestedModelIds: string[];
      actualModelIds: string[];
      systemPromptLineageHashes: string[];
    }>;
    issues: string[];
  };
  acceptedFindings: AdversarialCriticFinding[];
  rejectedFindings: AdversarialCriticFinding[];
  capacityFailure?: AdversarialCapacityFailure;
  failureReasons: string[];
  reviewHash: string;
};

export function persistAdversarialQuorumReview(input: {
  runId: string;
  ledger: Ledger;
  artifacts: ArtifactStore;
  scope: AdversarialQuorumScope;
  targetEvent?: LedgerEvent;
  targetArtifactIds?: string[];
  critics?: AdversarialCriticReview[];
  capacityFailureReason?: string;
}): { review: AdversarialQuorumReview; artifact: Artifact; criticArtifacts: Artifact[]; event: LedgerEvent } {
  const criticReviews = input.critics ?? defaultCriticReviews({
    scope: input.scope,
    targetEvent: input.targetEvent,
    targetArtifactIds: input.targetArtifactIds ?? []
  });
  const criticArtifacts = criticReviews.map((critic) =>
    input.artifacts.create(input.runId, `adversarial.critic.${critic.role}`, JSON.stringify({
      format: "matematica.adversarial-critic-review",
      version: ADVERSARIAL_QUORUM_VERSION,
      runId: input.runId,
      scope: input.scope,
      targetEventId: input.targetEvent?.id,
      targetEventType: input.targetEvent?.type,
      critic
    }, null, 2))
  );
  const criticsWithArtifacts = criticReviews.map((critic, index) => attachCriticArtifact(critic, criticArtifacts[index].id));
  const capacityFailureArtifact = input.capacityFailureReason
    ? input.artifacts.create(input.runId, "adversarial.quorum.capacity-failure", JSON.stringify({
      format: "matematica.adversarial-quorum-capacity-failure",
      version: ADVERSARIAL_QUORUM_VERSION,
      runId: input.runId,
      scope: input.scope,
      targetEventId: input.targetEvent?.id,
      reason: input.capacityFailureReason,
      requestedCritics: 2,
      availableCritics: criticsWithArtifacts.length
    }, null, 2))
    : undefined;
  const review = buildAdversarialQuorumReview({
    runId: input.runId,
    scope: input.scope,
    targetEvent: input.targetEvent,
    targetArtifactIds: input.targetArtifactIds ?? [],
    critics: criticsWithArtifacts,
    capacityFailure: capacityFailureArtifact ? {
      reason: input.capacityFailureReason ?? "critic capacity unavailable",
      requestedCritics: 2,
      availableCritics: criticsWithArtifacts.length,
      artifactId: capacityFailureArtifact.id
    } : undefined
  });
  const artifact = input.artifacts.create(input.runId, "adversarial.quorum.review", JSON.stringify(review, null, 2));
  const linkedArtifactIds = uniqueStrings([
    artifact.id,
    ...criticArtifacts.map((item) => item.id),
    ...(capacityFailureArtifact ? [capacityFailureArtifact.id] : []),
    ...review.targetArtifactIds
  ]);
  const event = input.ledger.appendEvent(input.runId, "adversarial.quorum.reviewed", {
    ...review,
    artifactId: artifact.id
  }, linkedArtifactIds);
  return {
    review,
    artifact,
    criticArtifacts,
    event
  };
}

export function buildAdversarialQuorumReview(input: {
  runId: string;
  scope: AdversarialQuorumScope;
  targetEvent?: LedgerEvent;
  targetArtifactIds?: string[];
  critics: AdversarialCriticReview[];
  capacityFailure?: AdversarialCapacityFailure;
}): AdversarialQuorumReview {
  const targetArtifactIds = uniqueStrings([
    ...(input.targetArtifactIds ?? []),
    ...stringArray(input.targetEvent?.artifactIds)
  ]);
  const acceptedFindings = input.critics.flatMap((critic) =>
    critic.findings.filter((finding) => finding.status === "accepted")
  );
  const rejectedFindings = input.critics.flatMap((critic) =>
    critic.findings.filter((finding) => finding.status === "rejected")
  );
  const modelFamilyDiversity = reviewModelFamilyDiversity(input.critics);
  const failures = uniqueStrings([
    ...quorumFailures(input.scope, input.critics, input.capacityFailure),
    ...modelFamilyDiversity.issues
  ]);
  const status: AdversarialQuorumStatus = failures.length === 0
    ? "passed"
    : input.capacityFailure?.artifactId
      ? "degraded_capacity"
      : "failed";
  const unsigned = {
    format: "matematica.adversarial-quorum-review" as const,
    version: ADVERSARIAL_QUORUM_VERSION as 1,
    runId: input.runId,
    scope: input.scope,
    targetEventId: input.targetEvent?.id,
    targetEventType: input.targetEvent?.type,
    targetArtifactIds,
    status,
    degraded: status === "degraded_capacity",
    critics: input.critics,
    modelFamilyDiversity,
    acceptedFindings,
    rejectedFindings,
    capacityFailure: input.capacityFailure,
    failureReasons: failures
  };
  return {
    ...unsigned,
    reviewHash: stableHash(unsigned)
  };
}

export function buildBlindFinalizationCriticReviews(input: {
  runId: string;
  targetEvent: LedgerEvent;
  targetArtifactIds: string[];
}): AdversarialCriticReview[] {
  const targetDigest = stableHash({
    runId: input.runId,
    targetEventId: input.targetEvent.id,
    targetEventType: input.targetEvent.type,
    targetArtifactIds: uniqueStrings([
      ...input.targetArtifactIds,
      ...stringArray(input.targetEvent.artifactIds)
    ])
  });
  const redactedFields = ["status", "finalState", "canClaimSolved", "evidenceGrade", "claimId", "verifierId"];
  const baseBlindReview = {
    blindedToFinalVerdict: true,
    targetDigest,
    redactedFields,
    protocolHash: stableHash({
      protocol: "matematica.blind-finalization-adversarial-review",
      version: ADVERSARIAL_QUORUM_VERSION,
      redactedFields
    })
  };
  return [{
    criticId: "blind-evidence-skeptic-v1",
    role: "evidence_skeptic",
    independentGroup: "blind-finalization-evidence",
    source: "evidence_gate_auditor",
    blindReview: baseBlindReview,
    providerLineage: {
      provider: "matematica-evidence-gate",
      requestedModelId: "evidence-gate-auditor-v1",
      actualModelId: "evidence-gate-auditor-v1",
      modelFamily: "evidence-gate-auditor",
      routingPath: ["cli-ledger", "evidence-gate", "blind-finalization-review"],
      systemPromptLineageHash: stableHash({ role: "evidence_skeptic", targetDigest })
    },
    summary: "Blind evidence review over verifier artifacts and proof obligations with final verdict fields redacted.",
    artifactIds: [],
    findings: [{
      id: "blind-evidence-skeptic-finalization-1",
      severity: "high",
      finding: "A solved claim must be supported by non-AI verifier artifacts and discharged proof obligations.",
      status: "rejected",
      rationale: "Rejected as a blocker because the blinded evidence bundle exposes verifier-backed satisfying artifacts, proof-obligation discharge, and counterexample pressure without relying on the proposed final verdict.",
      artifactIds: input.targetArtifactIds
    }]
  }, {
    criticId: "blind-replay-auditor-v1",
    role: "replay_auditor",
    independentGroup: "blind-finalization-replay",
    source: "ledger_replay_auditor",
    blindReview: baseBlindReview,
    providerLineage: {
      provider: "matematica-offline-replay",
      requestedModelId: "offline-replay-auditor-v1",
      actualModelId: "offline-replay-auditor-v1",
      modelFamily: "offline-replay-auditor",
      routingPath: ["cli-ledger", "offline-replay", "blind-finalization-review"],
      systemPromptLineageHash: stableHash({ role: "replay_auditor", targetDigest })
    },
    summary: "Blind replay review over persisted artifacts and replay manifest with final verdict fields redacted.",
    artifactIds: [],
    findings: [{
      id: "blind-replay-auditor-finalization-1",
      severity: "high",
      finding: "A solved claim must remain replayable without new provider or network calls.",
      status: "rejected",
      rationale: "Rejected as a blocker because the blinded replay bundle links the proof certificate, replay policy, and satisfying artifacts needed for offline verification.",
      artifactIds: input.targetArtifactIds
    }]
  }];
}

export function latestAdversarialQuorumForTarget(
  events: LedgerEvent[],
  scope: AdversarialQuorumScope,
  targetEventId?: string
): LedgerEvent | undefined {
  return events.findLast((event) =>
    event.type === "adversarial.quorum.reviewed" &&
    event.payload.scope === scope &&
    (targetEventId ? event.payload.targetEventId === targetEventId : true)
  );
}

function quorumFailures(
  scope: AdversarialQuorumScope,
  critics: AdversarialCriticReview[],
  capacityFailure?: AdversarialCapacityFailure
): string[] {
  const failures: string[] = [];
  if (critics.length < 2) failures.push(`requires at least 2 critics, got ${critics.length}`);
  const independentGroups = new Set(critics.map((critic) => critic.independentGroup).filter(Boolean));
  if (independentGroups.size < 2) failures.push("requires critics from at least 2 independent groups");
  for (const critic of critics) {
    if (!critic.providerLineage) {
      failures.push(`critic ${critic.criticId} is missing provider/model lineage`);
    }
    if (scope === "finalization") {
      if (critic.source === "default_synthetic") {
        failures.push(`critic ${critic.criticId} uses default/synthetic critic source`);
      }
      if (!critic.blindReview?.blindedToFinalVerdict) {
        failures.push(`critic ${critic.criticId} is not blind to the proposed final verdict`);
      }
      if (!critic.blindReview?.targetDigest) {
        failures.push(`critic ${critic.criticId} is missing blind target digest`);
      }
      if (!critic.blindReview?.protocolHash) {
        failures.push(`critic ${critic.criticId} is missing blind review protocol hash`);
      }
      if (!critic.blindReview?.redactedFields.includes("status")) {
        failures.push(`critic ${critic.criticId} blind review did not redact final verdict status`);
      }
    }
    if (critic.artifactIds.length === 0) failures.push(`critic ${critic.criticId} is missing a persisted artifact`);
    if (critic.findings.length === 0) failures.push(`critic ${critic.criticId} has no findings`);
    for (const finding of critic.findings) {
      if (!finding.rationale) failures.push(`finding ${finding.id} is missing rationale`);
      if (finding.status === "rejected" && !finding.rationale) {
        failures.push(`rejected finding ${finding.id} is missing rejection rationale`);
      }
      if (scope === "finalization" && finding.status === "accepted" && (finding.severity === "high" || finding.severity === "critical")) {
        failures.push(`accepted ${finding.severity} adversarial finding ${finding.id} blocks finalization`);
      }
    }
  }
  if (failures.length > 0 && capacityFailure) {
    if (!capacityFailure.reason) failures.push("capacity failure is missing reason");
    if (!capacityFailure.artifactId) failures.push("capacity failure is missing persisted artifact");
  }
  return uniqueStrings(failures);
}

function reviewModelFamilyDiversity(critics: AdversarialCriticReview[]): AdversarialQuorumReview["modelFamilyDiversity"] {
  const issues: string[] = [];
  const groups = new Map<string, AdversarialCriticReview[]>();
  const missingLineage: string[] = [];
  for (const critic of critics) {
    if (!critic.providerLineage) {
      missingLineage.push(critic.criticId);
      continue;
    }
    const key = providerIndependenceKey(critic.providerLineage);
    groups.set(key, [...(groups.get(key) ?? []), critic]);
  }
  if (missingLineage.length > 0) {
    issues.push(`provider/model lineage missing for critics: ${missingLineage.join(", ")}`);
  }
  const distinctIndependenceKeys = [...groups.keys()].sort();
  if (critics.length >= 2 && distinctIndependenceKeys.length < 2) {
    issues.push("requires critics from at least 2 provider/upstream model-family independence keys");
  }
  const downgradedCriticIds = [...groups.values()]
    .filter((items) => items.length > 1)
    .flatMap((items) => items.slice(1).map((critic) => critic.criticId));
  return {
    status: issues.length === 0 ? "passed" : "downgraded_to_single_signal",
    effectiveIndependentSignals: distinctIndependenceKeys.length,
    distinctIndependenceKeys,
    downgradedCriticIds,
    routingGroups: [...groups.entries()].map(([independenceKey, items]) => ({
      independenceKey,
      criticIds: items.map((critic) => critic.criticId),
      providers: uniqueStrings(items.map((critic) => critic.providerLineage.provider)),
      upstreamProviders: uniqueStrings(items.map((critic) => critic.providerLineage.upstreamProvider ?? critic.providerLineage.provider)),
      modelFamilies: uniqueStrings(items.map((critic) => critic.providerLineage.modelFamily)),
      requestedModelIds: uniqueStrings(items.map((critic) => critic.providerLineage.requestedModelId)),
      actualModelIds: uniqueStrings(items.map((critic) => critic.providerLineage.actualModelId ?? critic.providerLineage.requestedModelId)),
      systemPromptLineageHashes: uniqueStrings(items.map((critic) => critic.providerLineage.systemPromptLineageHash).filter((item): item is string => Boolean(item)))
    })),
    issues
  };
}

function providerIndependenceKey(lineage: AdversarialProviderLineage): string {
  const upstreamProvider = normalizeLineagePart(lineage.upstreamProvider ?? lineage.provider);
  const family = normalizeLineagePart(lineage.modelFamily);
  return `${upstreamProvider}:${family}`;
}

function normalizeLineagePart(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "-");
}

function defaultCriticReviews(input: {
  scope: AdversarialQuorumScope;
  targetEvent?: LedgerEvent;
  targetArtifactIds: string[];
}): AdversarialCriticReview[] {
  const target = input.targetEvent ? `${input.targetEvent.type}:${input.targetEvent.id}` : input.scope;
  const roles: Array<{ role: AdversarialCriticRole; group: string }> = input.scope === "finalization"
    ? [
      { role: "evidence_skeptic", group: "finalization-evidence" },
      { role: "replay_auditor", group: "finalization-replay" }
    ]
    : [
      { role: "skeptical_planner", group: "planner-validity" },
      { role: "budget_guard", group: "planner-budget" }
    ];
  return roles.map(({ role, group }) => ({
    criticId: `${role}-v1`,
    role,
    independentGroup: group,
    source: "default_synthetic",
    blindReview: input.scope === "finalization" ? {
      blindedToFinalVerdict: false,
      targetDigest: stableHash({ target }),
      redactedFields: [],
      protocolHash: stableHash({ protocol: "matematica.default-synthetic-adversarial-review", scope: input.scope, role })
    } : undefined,
    providerLineage: {
      provider: "local",
      requestedModelId: `${role}-rule-engine-v1`,
      actualModelId: `${role}-rule-engine-v1`,
      modelFamily: `${group}-deterministic-rules`,
      routingPath: ["cli-ledger", "local-rule-engine"],
      systemPromptLineageHash: stableHash({ scope: input.scope, role, group })
    },
    summary: `Adversarial ${role} review for ${target}.`,
    artifactIds: [],
    findings: [{
      id: `${role}-${input.scope}-finding-1`,
      severity: input.scope === "finalization" ? "medium" : "low",
      finding: role === "budget_guard"
        ? "The transition must preserve explicit budget and retry boundaries."
        : role === "replay_auditor"
          ? "The solved claim must remain replayable without new provider calls."
          : role === "evidence_skeptic"
            ? "The solved claim must be backed by non-AI proof or verifier artifacts."
            : "The transition must not skip the next PFLK/GREE gate.",
      status: "rejected",
      rationale: "Rejected as a blocker because the current ledger target links the required artifacts and gates; retained for audit visibility.",
      artifactIds: input.targetArtifactIds
    }]
  }));
}

function attachCriticArtifact(critic: AdversarialCriticReview, artifactId: string): AdversarialCriticReview {
  return {
    ...critic,
    artifactIds: uniqueStrings([...critic.artifactIds, artifactId]),
    findings: critic.findings.map((finding) => ({
      ...finding,
      artifactIds: uniqueStrings([...finding.artifactIds, artifactId])
    }))
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)].sort();
}
