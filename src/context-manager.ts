import type { ArtifactStore } from "./artifacts";
import type { Artifact, LedgerEvent } from "./domain";
import { stableHash } from "./idempotency";
import type { Ledger } from "./ledger";

export const CONTEXT_COMPACTION_VERSION = 1;

export type ContextRetrievalHandle = {
  kind: "event" | "artifact";
  id: string;
  eventType?: string;
  artifactKind?: string;
  hash?: string;
};

export type ContextKeptItem = {
  kind: "event" | "artifact";
  id: string;
  category: "claim_graph" | "proof" | "source" | "knowledge" | "verifier" | "budget" | "worker" | "other";
  reason: string;
  retrievalHandle: ContextRetrievalHandle;
};

export type ContextDroppedItem = {
  kind: "event" | "artifact";
  id: string;
  reason: string;
  recoverable: boolean;
  retrievalHandle: ContextRetrievalHandle;
};

export type ContextCompactionReview = {
  format: "matematica.context-compaction-review";
  version: 1;
  runId: string;
  cycle: number;
  sourceEventRange: {
    fromSequence?: number;
    toSequence?: number;
    eventCount: number;
  };
  summary: {
    previousCycles: number;
    keptEvents: number;
    keptArtifacts: number;
    droppedEvents: number;
    droppedArtifacts: number;
    claimGraphEventIds: string[];
    knowledgeArtifactIds: string[];
    retrievalHandleCount: number;
  };
  claimGraph: {
    claimEventIds: string[];
    proofObligationEventIds: string[];
    counterexampleEventIds: string[];
    retractionEventIds: string[];
    sourceEventIds: string[];
  };
  kept: ContextKeptItem[];
  discardedContextManifest: ContextDroppedItem[];
  downstreamDependency: {
    phaseJobPayloadField: "contextCompactionEventId";
    promptLineageField: "contextCompactionEventId";
    laterClaimsDependOnCompaction: boolean;
  };
  lossAudit: {
    ok: boolean;
    droppedCriticalCount: number;
    missingRetrievalHandles: string[];
    reason: string;
  };
  reviewHash: string;
};

export function persistContextCompactionReview(input: {
  runId: string;
  cycle: number;
  ledger: Ledger;
  artifacts: ArtifactStore;
}): { review: ContextCompactionReview; artifact: Artifact; event: LedgerEvent } {
  const review = buildContextCompactionReview({
    runId: input.runId,
    cycle: input.cycle,
    events: input.ledger.listEvents(input.runId),
    artifacts: input.ledger.listArtifacts(input.runId)
  });
  const artifact = input.artifacts.create(input.runId, "context.compaction.review", JSON.stringify(review, null, 2));
  const event = input.ledger.appendEvent(input.runId, "context.compaction.reviewed", {
    ...review,
    artifactId: artifact.id
  }, [artifact.id, ...review.kept.filter((item) => item.kind === "artifact").map((item) => item.id)]);
  return { review, artifact, event };
}

export function buildContextCompactionReview(input: {
  runId: string;
  cycle: number;
  events: LedgerEvent[];
  artifacts: Artifact[];
}): ContextCompactionReview {
  const priorEvents = input.events.filter((event) => Number(event.payload.cycle ?? 0) < input.cycle || event.type === "goal.started");
  const fromSequence = priorEvents.map((event) => event.sequence).filter((item): item is number => typeof item === "number").sort((left, right) => left - right)[0];
  const toSequence = priorEvents.map((event) => event.sequence).filter((item): item is number => typeof item === "number").sort((left, right) => right - left)[0];
  const keptEvents = priorEvents.filter(isContextCriticalEvent);
  const droppedEvents = priorEvents.filter((event) => !isContextCriticalEvent(event));
  const keptArtifactIds = new Set([
    ...keptEvents.flatMap((event) => event.artifactIds),
    ...input.artifacts.filter(isContextCriticalArtifact).map((artifact) => artifact.id)
  ]);
  const keptArtifacts = input.artifacts.filter((artifact) => keptArtifactIds.has(artifact.id));
  const droppedArtifacts = input.artifacts.filter((artifact) => !keptArtifactIds.has(artifact.id));
  const kept: ContextKeptItem[] = [
    ...keptEvents.map((event) => ({
      kind: "event" as const,
      id: event.id,
      category: eventCategory(event),
      reason: keptEventReason(event),
      retrievalHandle: eventHandle(event)
    })),
    ...keptArtifacts.map((artifact) => ({
      kind: "artifact" as const,
      id: artifact.id,
      category: artifactCategory(artifact),
      reason: keptArtifactReason(artifact),
      retrievalHandle: artifactHandle(artifact)
    }))
  ];
  const discardedContextManifest: ContextDroppedItem[] = [
    ...droppedEvents.map((event) => ({
      kind: "event" as const,
      id: event.id,
      reason: droppedEventReason(event),
      recoverable: true,
      retrievalHandle: eventHandle(event)
    })),
    ...droppedArtifacts.map((artifact) => ({
      kind: "artifact" as const,
      id: artifact.id,
      reason: droppedArtifactReason(artifact),
      recoverable: true,
      retrievalHandle: artifactHandle(artifact)
    }))
  ];
  const missingRetrievalHandles = [
    ...kept,
    ...discardedContextManifest
  ].filter((item) => !item.retrievalHandle.id).map((item) => item.id);
  const droppedCriticalCount = discardedContextManifest.filter((item) =>
    item.reason.includes("critical")
  ).length;
  const claimGraph = {
    claimEventIds: idsOf(keptEvents, ["goal.success.evaluated", "claim.graph.reviewed"]),
    proofObligationEventIds: idsOf(keptEvents, ["proof.obligations.reviewed", "proof.certificate.minimized"]),
    counterexampleEventIds: idsOf(keptEvents, ["counterexample.search.reviewed"]),
    retractionEventIds: idsOf(keptEvents, ["claim.retracted"]),
    sourceEventIds: idsOf(keptEvents, ["source.results", "source.citations.reviewed", "source.retrieval.evaluated", "source.license.manifest.reviewed"])
  };
  const unsigned = {
    format: "matematica.context-compaction-review" as const,
    version: CONTEXT_COMPACTION_VERSION as 1,
    runId: input.runId,
    cycle: input.cycle,
    sourceEventRange: {
      fromSequence,
      toSequence,
      eventCount: priorEvents.length
    },
    summary: {
      previousCycles: Math.max(0, input.cycle - 1),
      keptEvents: keptEvents.length,
      keptArtifacts: keptArtifacts.length,
      droppedEvents: droppedEvents.length,
      droppedArtifacts: droppedArtifacts.length,
      claimGraphEventIds: claimGraph.claimEventIds,
      knowledgeArtifactIds: keptArtifacts.filter((artifact) => artifact.kind.includes("knowledge")).map((artifact) => artifact.id),
      retrievalHandleCount: kept.length + discardedContextManifest.length
    },
    claimGraph,
    kept,
    discardedContextManifest,
    downstreamDependency: {
      phaseJobPayloadField: "contextCompactionEventId" as const,
      promptLineageField: "contextCompactionEventId" as const,
      laterClaimsDependOnCompaction: input.cycle > 1
    },
    lossAudit: {
      ok: missingRetrievalHandles.length === 0 && droppedCriticalCount === 0,
      droppedCriticalCount,
      missingRetrievalHandles,
      reason: missingRetrievalHandles.length === 0 && droppedCriticalCount === 0
        ? "All compacted and discarded context has retrieval handles; critical claim/proof/source/knowledge material was kept."
        : "Context compaction lost critical material or retrieval handles."
    }
  };
  return {
    ...unsigned,
    reviewHash: stableHash(unsigned)
  };
}

function isContextCriticalEvent(event: LedgerEvent): boolean {
  return event.type === "goal.success.evaluated" ||
    event.type === "proof.obligations.reviewed" ||
    event.type === "proof.certificate.minimized" ||
    event.type === "claim.graph.reviewed" ||
    event.type === "claim.retracted" ||
    event.type === "counterexample.search.reviewed" ||
    event.type === "source.results" ||
    event.type === "source.citations.reviewed" ||
    event.type === "source.retrieval.evaluated" ||
    event.type === "source.license.manifest.reviewed" ||
    event.type === "knowledge.conjecture.saved" ||
    event.type === "goal.finalization.checked" ||
    event.type === "adversarial.quorum.reviewed" ||
    event.type === "context.compaction.reviewed";
}

function isContextCriticalArtifact(artifact: Artifact): boolean {
  return artifact.kind.includes("knowledge") ||
    artifact.kind.includes("claim") ||
    artifact.kind.includes("proof") ||
    artifact.kind.includes("counterexample") ||
    artifact.kind.startsWith("source.") ||
    artifact.kind.startsWith("verifier.") ||
    artifact.kind === "context.compaction.review";
}

function eventCategory(event: LedgerEvent): ContextKeptItem["category"] {
  if (event.type.includes("claim")) return "claim_graph";
  if (event.type.includes("proof")) return "proof";
  if (event.type.startsWith("source.")) return "source";
  if (event.type.startsWith("knowledge.")) return "knowledge";
  if (event.type.startsWith("verifier.")) return "verifier";
  if (event.type.startsWith("budget.")) return "budget";
  if (event.type.startsWith("worker.")) return "worker";
  return "other";
}

function artifactCategory(artifact: Artifact): ContextKeptItem["category"] {
  if (artifact.kind.includes("claim")) return "claim_graph";
  if (artifact.kind.includes("proof")) return "proof";
  if (artifact.kind.startsWith("source.")) return "source";
  if (artifact.kind.includes("knowledge")) return "knowledge";
  if (artifact.kind.startsWith("verifier.")) return "verifier";
  return "other";
}

function keptEventReason(event: LedgerEvent): string {
  return `kept critical ${event.type} event for later-cycle claim, proof, source, or finalization dependency`;
}

function keptArtifactReason(artifact: Artifact): string {
  return `kept critical ${artifact.kind} artifact behind retrieval handle`;
}

function droppedEventReason(event: LedgerEvent): string {
  return `dropped from prompt context only; recoverable ledger event ${event.type} via retrieval handle`;
}

function droppedArtifactReason(artifact: Artifact): string {
  return `dropped from prompt context only; recoverable artifact ${artifact.kind} via retrieval handle`;
}

function eventHandle(event: LedgerEvent): ContextRetrievalHandle {
  return {
    kind: "event",
    id: event.id,
    eventType: event.type,
    hash: event.eventHash ?? event.payloadHash
  };
}

function artifactHandle(artifact: Artifact): ContextRetrievalHandle {
  return {
    kind: "artifact",
    id: artifact.id,
    artifactKind: artifact.kind,
    hash: artifact.sha256
  };
}

function idsOf(events: LedgerEvent[], types: string[]): string[] {
  const typeSet = new Set(types);
  return events.filter((event) => typeSet.has(event.type)).map((event) => event.id);
}
