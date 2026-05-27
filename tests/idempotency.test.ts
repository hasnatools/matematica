import { expect, test } from "bun:test";
import { externalOperationIdempotencyKey, stableHash } from "../src/idempotency";

test("external operation idempotency keys are stable canonical and operation scoped", () => {
  const firstHash = stableHash({ b: 2, a: 1, skipped: undefined });
  const secondHash = stableHash({ a: 1, b: 2 });
  expect(firstHash).toBe(secondHash);

  const aiKey = externalOperationIdempotencyKey({
    runId: "run_1",
    operationType: "ai.generateText",
    requestHash: firstHash
  });
  const aiKeyAgain = externalOperationIdempotencyKey({
    runId: "run_1",
    operationType: "ai.generateText",
    requestHash: firstHash
  });
  const arxivKey = externalOperationIdempotencyKey({
    runId: "run_1",
    operationType: "source.arxiv",
    requestHash: firstHash
  });
  const otherRunKey = externalOperationIdempotencyKey({
    runId: "run_2",
    operationType: "ai.generateText",
    requestHash: firstHash
  });

  expect(aiKey).toBe(aiKeyAgain);
  expect(aiKey).toMatch(/^extop_ai_generatetext_[a-f0-9]{32}$/);
  expect(arxivKey).toMatch(/^extop_source_arxiv_[a-f0-9]{32}$/);
  expect(aiKey).not.toBe(arxivKey);
  expect(aiKey).not.toBe(otherRunKey);
});

test("external operation retry keys record explicit retry lineage", () => {
  const requestHash = stableHash({ query: "abc" });
  const original = externalOperationIdempotencyKey({
    runId: "run_1",
    operationType: "source.arxiv",
    requestHash
  });
  const retry = externalOperationIdempotencyKey({
    runId: "run_1",
    operationType: "source.arxiv",
    requestHash,
    retryOfOperationId: "extop_original"
  });

  expect(retry).toMatch(/^extop_source_arxiv_[a-f0-9]{32}$/);
  expect(retry).not.toBe(original);
});
