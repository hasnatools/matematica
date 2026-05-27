import type { ArtifactStore } from "./artifacts";
import type { Artifact, LedgerEvent } from "./domain";
import type { FormalClaimContract } from "./evidence";
import type { Ledger } from "./ledger";

export type ClaimNodeStatus = "active" | "retracted" | "conflicted";

export type ClaimGraphRetraction = {
  claimId: string;
  reason: string;
  retractedByClaimId?: string;
  artifactIds: string[];
  eventId?: string;
};

export type ClaimGraphNode = {
  claimId: string;
  claimType: FormalClaimContract["claimType"];
  verifierId: string;
  evidenceGrade: FormalClaimContract["evidenceGrade"];
  verifierStatus: FormalClaimContract["verifierStatus"];
  conclusion: string;
  normalizedConclusion: string;
  assumptions: string[];
  dependencies: string[];
  status: ClaimNodeStatus;
  artifactIds: string[];
  eventId?: string;
  retraction?: ClaimGraphRetraction;
};

export type ClaimGraphConflictKind =
  | "counterexample_refutes_claim"
  | "contradiction_refutes_claim"
  | "incompatible_equivalent_claims";

export type ClaimGraphConflict = {
  kind: ClaimGraphConflictKind;
  claimId: string;
  conflictingClaimId: string;
  reason: string;
  artifactIds: string[];
};

export type ClaimGraphDecision = {
  format: "matematica.claim-graph.review";
  version: 1;
  ok: boolean;
  targetClaimId?: string;
  nodes: ClaimGraphNode[];
  conflicts: ClaimGraphConflict[];
  retractions: ClaimGraphRetraction[];
  blockingClaimIds: string[];
  reason: string;
};

export type ClaimGraphClaimInput = {
  claim: FormalClaimContract;
  eventId?: string;
  artifactIds?: string[];
};

export function evaluateClaimGraph(input: {
  claims: ClaimGraphClaimInput[];
  targetClaimId?: string;
  retractions?: ClaimGraphRetraction[];
}): ClaimGraphDecision {
  const retractions = input.retractions ?? [];
  const retractionByClaimId = new Map(retractions.map((retraction) => [retraction.claimId, retraction]));
  const nodes = input.claims.map((item) => claimNodeFor(item, retractionByClaimId.get(item.claim.id)));
  const claimById = new Map(nodes.map((node) => [node.claimId, node]));
  const conflicts = detectConflicts(nodes);
  const conflictedIds = new Set(conflicts.flatMap((conflict) => [conflict.claimId, conflict.conflictingClaimId]));

  const updatedNodes = nodes.map((node) => {
    if (node.status === "retracted") return node;
    return conflictedIds.has(node.claimId) ? { ...node, status: "conflicted" as const } : node;
  });
  const blockingClaimIds = input.targetClaimId
    ? blockingClaimIdsFor(input.targetClaimId, updatedNodes, conflicts, retractionByClaimId)
    : [];
  const ok = blockingClaimIds.length === 0;
  return {
    format: "matematica.claim-graph.review",
    version: 1,
    ok,
    targetClaimId: input.targetClaimId,
    nodes: updatedNodes,
    conflicts,
    retractions,
    blockingClaimIds,
    reason: ok
      ? "claim graph has no active conflicts or retractions blocking the target claim"
      : `target claim is blocked by claim graph: ${(blockingClaimIds.join(", ") || (input.targetClaimId ? claimById.get(input.targetClaimId)?.status : undefined)) ?? "unknown"}`
  };
}

export function buildClaimRetraction(input: {
  claimId: string;
  reason: string;
  retractedByClaimId?: string;
  artifactIds?: string[];
  eventId?: string;
}): ClaimGraphRetraction {
  if (!input.claimId.trim()) throw new Error("Retraction requires a claim id.");
  if (!input.reason.trim()) throw new Error("Retraction requires a reason.");
  return {
    claimId: input.claimId,
    reason: input.reason,
    retractedByClaimId: input.retractedByClaimId,
    artifactIds: input.artifactIds ?? [],
    eventId: input.eventId
  };
}

export function persistClaimGraphReview(input: {
  runId: string;
  ledger: Ledger;
  artifacts: ArtifactStore;
  claims: ClaimGraphClaimInput[];
  targetClaimId?: string;
  retractions?: ClaimGraphRetraction[];
}): { decision: ClaimGraphDecision; artifact: Artifact; event: LedgerEvent } {
  const decision = evaluateClaimGraph({
    claims: input.claims,
    targetClaimId: input.targetClaimId,
    retractions: input.retractions
  });
  const artifact = input.artifacts.create(input.runId, "claim.graph.review", JSON.stringify(decision, null, 2));
  const event = input.ledger.appendEvent(input.runId, "claim.graph.reviewed", {
    targetClaimId: input.targetClaimId,
    decision,
    artifactId: artifact.id
  }, [artifact.id, ...uniqueStrings(input.claims.flatMap((claim) => claim.artifactIds ?? []))]);
  return { decision, artifact, event };
}

export function persistClaimRetraction(input: {
  runId: string;
  ledger: Ledger;
  artifacts: ArtifactStore;
  claimId: string;
  reason: string;
  retractedByClaimId?: string;
  artifactIds?: string[];
}): { retraction: ClaimGraphRetraction; artifact: Artifact; event: LedgerEvent } {
  const retraction = buildClaimRetraction(input);
  const artifact = input.artifacts.create(input.runId, "claim.retraction", JSON.stringify({
    format: "matematica.claim-retraction",
    version: 1,
    ...retraction
  }, null, 2));
  const event = input.ledger.appendEvent(input.runId, "claim.retracted", {
    ...retraction,
    artifactId: artifact.id
  }, [artifact.id, ...uniqueStrings(input.artifactIds ?? [])]);
  return {
    retraction: { ...retraction, artifactIds: [artifact.id, ...uniqueStrings(input.artifactIds ?? [])], eventId: event.id },
    artifact,
    event
  };
}

export function extractClaimRetractions(events: LedgerEvent[]): ClaimGraphRetraction[] {
  return events
    .filter((event) => event.type === "claim.retracted")
    .map((event) => buildClaimRetraction({
      claimId: stringValue(event.payload.claimId) ?? "",
      reason: stringValue(event.payload.reason) ?? "claim retracted",
      retractedByClaimId: stringValue(event.payload.retractedByClaimId),
      artifactIds: uniqueStrings([...event.artifactIds, ...stringArray(event.payload.artifactIds)]),
      eventId: event.id
    }));
}

export function normalizeClaimConclusion(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.;:]+$/g, "")
    .trim();
}

function claimNodeFor(input: ClaimGraphClaimInput, retraction?: ClaimGraphRetraction): ClaimGraphNode {
  return {
    claimId: input.claim.id,
    claimType: input.claim.claimType,
    verifierId: input.claim.verifierId,
    evidenceGrade: input.claim.evidenceGrade,
    verifierStatus: input.claim.verifierStatus,
    conclusion: input.claim.conclusion,
    normalizedConclusion: normalizeClaimConclusion(input.claim.conclusion),
    assumptions: input.claim.assumptions,
    dependencies: input.claim.dependencies,
    status: retraction ? "retracted" : "active",
    artifactIds: uniqueStrings([...(input.artifactIds ?? []), ...input.claim.verifierArtifactIds]),
    eventId: input.eventId,
    retraction
  };
}

function detectConflicts(nodes: ClaimGraphNode[]): ClaimGraphConflict[] {
  const active = nodes.filter((node) => node.status === "active");
  const byId = new Map(active.map((node) => [node.claimId, node]));
  const conflicts: ClaimGraphConflict[] = [];
  for (const node of active) {
    for (const dependencyId of node.dependencies) {
      const dependency = byId.get(dependencyId);
      if (!dependency) continue;
      if (node.claimType === "counterexample") {
        conflicts.push({
          kind: "counterexample_refutes_claim",
          claimId: dependency.claimId,
          conflictingClaimId: node.claimId,
          reason: `counterexample claim ${node.claimId} refutes ${dependency.claimId}`,
          artifactIds: uniqueStrings([...dependency.artifactIds, ...node.artifactIds])
        });
      }
      if (node.claimType === "contradiction" || node.evidenceGrade === "contradicted") {
        conflicts.push({
          kind: "contradiction_refutes_claim",
          claimId: dependency.claimId,
          conflictingClaimId: node.claimId,
          reason: `contradiction claim ${node.claimId} refutes ${dependency.claimId}`,
          artifactIds: uniqueStrings([...dependency.artifactIds, ...node.artifactIds])
        });
      }
    }
  }
  for (const first of active) {
    for (const second of active) {
      if (first.claimId >= second.claimId) continue;
      if (first.normalizedConclusion !== second.normalizedConclusion) continue;
      if (sameStrings(first.assumptions, second.assumptions)) continue;
      conflicts.push({
        kind: "incompatible_equivalent_claims",
        claimId: first.claimId,
        conflictingClaimId: second.claimId,
        reason: `claims ${first.claimId} and ${second.claimId} have the same normalized conclusion but incompatible assumptions`,
        artifactIds: uniqueStrings([...first.artifactIds, ...second.artifactIds])
      });
    }
  }
  return conflicts;
}

function blockingClaimIdsFor(
  targetClaimId: string,
  nodes: ClaimGraphNode[],
  conflicts: ClaimGraphConflict[],
  retractionByClaimId: Map<string, ClaimGraphRetraction>
): string[] {
  const blocking = new Set<string>();
  const target = nodes.find((node) => node.claimId === targetClaimId);
  if (!target) {
    blocking.add(targetClaimId);
    return [...blocking];
  }
  if (target.status === "retracted" || retractionByClaimId.has(targetClaimId)) blocking.add(targetClaimId);
  for (const conflict of conflicts) {
    if (conflict.claimId === targetClaimId) blocking.add(conflict.conflictingClaimId);
    if (conflict.conflictingClaimId === targetClaimId) blocking.add(conflict.claimId);
  }
  return [...blocking].sort();
}

function sameStrings(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const normalizedLeft = left.map(normalizeClaimConclusion).sort();
  const normalizedRight = right.map(normalizeClaimConclusion).sort();
  return normalizedLeft.every((item, index) => item === normalizedRight[index]);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
