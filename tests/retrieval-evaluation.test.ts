import { expect, test } from "bun:test";
import { buildArxivSourceRecords, claimedCitationFromSourceRecord, validateCitations } from "../src/research/citations";
import {
  evaluateLiteratureRetrieval,
  findGoldenQuery,
  GOLDEN_ARXIV_RETRIEVAL_QUERIES,
  retrievalOutageEvaluation
} from "../src/research/evaluation";
import { quarantineArxivPapers } from "../src/research/security";

test("golden arXiv retrieval suite declares expected relevant papers", () => {
  expect(GOLDEN_ARXIV_RETRIEVAL_QUERIES.length).toBeGreaterThanOrEqual(2);
  for (const golden of GOLDEN_ARXIV_RETRIEVAL_QUERIES) {
    expect(golden.query.length).toBeGreaterThan(0);
    expect(golden.expectedRelevantIds.length).toBeGreaterThan(0);
    expect(golden.expectedTerms.length).toBeGreaterThan(0);
    expect(findGoldenQuery(golden.query)?.id).toBe(golden.id);
  }
});

test("evaluateLiteratureRetrieval measures precision recall citation validity and source use", () => {
  const papers = quarantineArxivPapers([
    paper({
      id: "http://arxiv.org/abs/1306.6074v1",
      title: "Small gaps between primes",
      summary: "We prove bounded gaps between primes using a sieve argument with enough detail for citation support.",
      updated: "2013-06-25T00:00:00Z"
    }),
    paper({
      id: "http://arxiv.org/abs/2401.99999v1",
      title: "Prime keyword survey",
      summary: "This survey repeats the word primes but discusses unrelated heuristics.",
      updated: "2024-01-01T00:00:00Z"
    })
  ]);
  const records = buildArxivSourceRecords(papers, "2026-01-01T00:00:00Z");
  const citations = validateCitations([claimedCitationFromSourceRecord(records[0])], records);
  const result = evaluateLiteratureRetrieval({
    query: "all:\"bounded gaps\" AND all:primes",
    papers,
    sourceRecords: records,
    citationGrounding: citations,
    usedSourceIds: ["1306.6074"]
  });

  expect(result.precision).toBe(0.5);
  expect(result.recall).toBe(0.5);
  expect(result.citationValidity).toBe(1);
  expect(result.sourceUseRate).toBe(0.5);
  expect(result.failures).toContain("low_precision");
  expect(result.failures).toContain("low_recall");
  expect(result.failures).toContain("irrelevant_results");
  expect(result.failures).toContain("keyword_overfit");
  expect(result.trustImpact).toBe("lower_trust");
  expect(result.canPromoteResearchBackedClaims).toBe(false);
});

test("evaluateLiteratureRetrieval detects stale results and invalid citations", () => {
  const papers = quarantineArxivPapers([
    paper({
      id: "http://arxiv.org/abs/1910.09336v1",
      title: "The Lean Mathematical Library",
      summary: "Lean mathlib formalization library.",
      updated: "2019-10-21T00:00:00Z"
    })
  ]);
  const records = buildArxivSourceRecords(papers, "2026-01-01T00:00:00Z");
  const citations = validateCitations([{
    sourceId: "arXiv:1910.09336",
    title: "The Lean Mathematical Library",
    supportText: "proves the Riemann hypothesis"
  }], records);
  const result = evaluateLiteratureRetrieval({
    query: "all:Lean AND all:mathlib AND cat:cs.LO",
    papers,
    sourceRecords: records,
    citationGrounding: citations,
    staleBefore: "2020-01-01T00:00:00Z",
    usedSourceIds: []
  });

  expect(result.citationValidity).toBe(0);
  expect(result.staleResultCount).toBe(1);
  expect(result.sourceUseRate).toBe(0);
  expect(result.failures).toContain("invalid_citations");
  expect(result.failures).toContain("stale_results");
  expect(result.failures).toContain("low_source_use");
  expect(result.trustImpact).toBe("adversarial_review_required");
  expect(result.canPromoteResearchBackedClaims).toBe(false);
});

test("evaluateLiteratureRetrieval detects title abstract mismatch and statement equivalence traps", () => {
  const papers = quarantineArxivPapers([
    paper({
      id: "http://arxiv.org/abs/2501.00001v1",
      title: "A Proof of Prime Gap Collapse",
      summary: "This numerical experiment suggests a bounded finite analogue for graph coloring.",
      updated: "2025-01-01T00:00:00Z"
    })
  ]);
  const records = buildArxivSourceRecords(papers, "2026-01-01T00:00:00Z");
  const citations = validateCitations([claimedCitationFromSourceRecord(records[0])], records);
  const result = evaluateLiteratureRetrieval({
    query: "prove prime gaps",
    papers,
    sourceRecords: records,
    citationGrounding: citations,
    expectedRelevantIds: ["2501.00001"],
    expectedTerms: ["prime gaps"],
    usedSourceIds: ["2501.00001"]
  });

  expect(result.titleAbstractMismatchCount).toBe(1);
  expect(result.statementEquivalenceTrapCount).toBe(1);
  expect(result.failures).toContain("title_abstract_mismatch");
  expect(result.failures).toContain("statement_equivalence_trap");
  expect(result.canPromoteResearchBackedClaims).toBe(false);
});

test("retrievalOutageEvaluation degrades to partial inconclusive without novelty promotion", () => {
  const result = retrievalOutageEvaluation({
    query: "all:novel approach",
    message: "arXiv timed out",
    evaluatedAt: "2026-05-25T00:00:00.000Z"
  });

  expect(result.retrievedCount).toBe(0);
  expect(result.failures).toContain("search_outage");
  expect(result.outage).toMatchObject({
    provider: "arxiv",
    degradedTo: "partial_inconclusive"
  });
  expect(result.trustImpact).toBe("adversarial_review_required");
  expect(result.canPromoteResearchBackedClaims).toBe(false);
});

function paper(overrides: Partial<ReturnType<typeof basePaper>>): ReturnType<typeof basePaper> {
  return {
    ...basePaper(),
    ...overrides
  };
}

function basePaper() {
  return {
    id: "http://arxiv.org/abs/0000.00000v1",
    title: "Placeholder",
    summary: "Placeholder summary.",
    authors: ["Ada"],
    published: "2024-01-01T00:00:00Z",
    updated: "2024-01-01T00:00:00Z",
    absUrl: "http://arxiv.org/abs/0000.00000v1",
    pdfUrl: "http://arxiv.org/pdf/0000.00000v1",
    categories: ["math.NT"]
  };
}
