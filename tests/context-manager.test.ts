import { expect, test } from "bun:test";
import type { Artifact, LedgerEvent } from "../src/domain";
import { buildContextCompactionReview } from "../src/context-manager";

test("context compaction keeps claim proof source and knowledge handles while manifesting dropped chatter", () => {
  const events = [
    event("evt-cycle", "cycle.completed", { cycle: 1 }),
    event("evt-proof", "proof.obligations.reviewed", { cycle: 1 }, ["art-proof"]),
    event("evt-claim", "claim.graph.reviewed", { cycle: 1 }, ["art-claim"]),
    event("evt-source", "source.results", { cycle: 1 }, ["art-source"]),
    event("evt-knowledge", "knowledge.conjecture.saved", { cycle: 1, artifactId: "art-knowledge" }, ["art-knowledge"]),
    event("evt-ai-chunk", "ai.call.stream_chunk", { cycle: 1 }, ["art-ai"])
  ];
  const artifacts = [
    artifact("art-proof", "proof.obligations"),
    artifact("art-claim", "claim.graph.review"),
    artifact("art-source", "source.arxiv.results"),
    artifact("art-knowledge", "knowledge.conjecture"),
    artifact("art-ai", "ai.call.stream_chunk")
  ];

  const review = buildContextCompactionReview({
    runId: "run-context",
    cycle: 2,
    events,
    artifacts
  });

  expect(review.format).toBe("matematica.context-compaction-review");
  expect(review.lossAudit.ok).toBe(true);
  expect(review.summary.previousCycles).toBe(1);
  expect(review.claimGraph).toMatchObject({
    claimEventIds: ["evt-claim"],
    proofObligationEventIds: ["evt-proof"],
    sourceEventIds: ["evt-source"]
  });
  expect(review.summary.knowledgeArtifactIds).toEqual(["art-knowledge"]);
  expect(review.kept.map((item) => item.id)).toEqual(expect.arrayContaining([
    "evt-proof",
    "evt-claim",
    "evt-source",
    "evt-knowledge",
    "art-proof",
    "art-claim",
    "art-source",
    "art-knowledge"
  ]));
  expect(review.discardedContextManifest.map((item) => item.id)).toEqual(expect.arrayContaining([
    "evt-cycle",
    "evt-ai-chunk",
    "art-ai"
  ]));
  expect(review.discardedContextManifest.every((item) => item.recoverable && item.retrievalHandle.id)).toBe(true);
  expect(review.downstreamDependency).toMatchObject({
    phaseJobPayloadField: "contextCompactionEventId",
    promptLineageField: "contextCompactionEventId",
    laterClaimsDependOnCompaction: true
  });
  expect(review.reviewHash).toMatch(/^[a-f0-9]{64}$/);
});

function event(
  id: string,
  type: LedgerEvent["type"],
  payload: Record<string, unknown>,
  artifactIds: string[] = []
): LedgerEvent {
  return {
    id,
    runId: "run-context",
    type,
    payload,
    artifactIds,
    createdAt: "2026-05-25T00:00:00.000Z",
    sequence: Number(id.replace(/\D/g, "")) || undefined,
    eventHash: `hash-${id}`,
    payloadHash: `payload-${id}`
  };
}

function artifact(id: string, kind: string): Artifact {
  const sha256 = `sha-${id}`;
  return {
    id,
    runId: "run-context",
    kind,
    sha256,
    contentAddress: `sha256:${sha256}`,
    mediaType: "text/plain; charset=utf-8",
    storageKey: `run-context/${sha256}.txt`,
    path: `/tmp/${id}.txt`,
    bytes: 10,
    createdAt: "2026-05-25T00:00:00.000Z"
  };
}
