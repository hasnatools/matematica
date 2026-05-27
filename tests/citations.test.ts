import { expect, test } from "bun:test";
import {
  buildArxivSourceRecords,
  canonicalizeArxivId,
  claimedCitationFromSourceRecord,
  validateCitations
} from "../src/research/citations";
import { quarantineArxivPapers } from "../src/research/security";

const [paper] = quarantineArxivPapers([{
  id: "http://arxiv.org/abs/2401.00001v2",
  title: "A Proof About Primes",
  summary: "We prove a prime-gap lemma using a Lean formalization of theorem alpha.",
  authors: ["Ada Lovelace", "Emmy Noether"],
  published: "2024-01-01T00:00:00Z",
  updated: "2024-01-02T00:00:00Z",
  absUrl: "http://arxiv.org/abs/2401.00001v2",
  pdfUrl: "http://arxiv.org/pdf/2401.00001v2",
  categories: ["math.NT"],
  rawMetadataHash: "a".repeat(64)
}]);

test("buildArxivSourceRecords records normalized ids metadata and content hashes", () => {
  const [record] = buildArxivSourceRecords([paper], {
    retrievedAt: "2026-05-25T00:00:00.000Z",
    query: "all:prime"
  });

  expect(record.query).toBe("all:prime");
  expect(record.canonicalId).toBe("2401.00001");
  expect(record.version).toBe(2);
  expect(record.title).toBe("A Proof About Primes");
  expect(record.authors).toEqual(["Ada Lovelace", "Emmy Noether"]);
  expect(record.published).toBe("2024-01-01T00:00:00Z");
  expect(record.updated).toBe("2024-01-02T00:00:00Z");
  expect(record.retrievedAt).toBe("2026-05-25T00:00:00.000Z");
  expect(record.ranking).toBe(1);
  expect(record.abstractHash).toMatch(/^[a-f0-9]{64}$/);
  expect(record.snapshotHash).toMatch(/^[a-f0-9]{64}$/);
  expect(record.rawMetadataHash).toBe("a".repeat(64));
  expect(record.contentHash).toMatch(/^[a-f0-9]{64}$/);
  expect(record.extractedClaims).toContain("We prove a prime-gap lemma using a Lean formalization of theorem alpha.");
  expect(record.supportText).toContain("prime-gap lemma");
});

test("validateCitations grounds located source support", () => {
  const records = buildArxivSourceRecords([paper]);
  const result = validateCitations([claimedCitationFromSourceRecord(records[0])], records);

  expect(result.ok).toBe(true);
  expect(result.requiresAdversarialReview).toBe(false);
  expect(result.findings[0].status).toBe("grounded");
  expect(result.supportPolicy).toMatchObject({
    sourceExistenceIsNotMathematicalSupport: true,
    exactArxivVersionRequired: true,
    snapshotHashRequired: true,
    quotedSpanRequired: true,
    independentEntailmentRequired: true,
    licenseAndProvenanceRequired: true,
    canSupportSolvedClaim: false
  });
  expect(result.findings[0].supportReview).toMatchObject({
    sourceExists: true,
    exactArxivVersion: true,
    snapshotHashMatches: true,
    quotedSpanLocated: true,
    licenseAndProvenancePresent: true,
    canSupportMathematicalClaim: true,
    canSupportSolvedClaim: false,
    proofSupport: "not_proof_support",
    entailment: {
      independent: true,
      status: "entailed"
    }
  });
});

test("validateCitations flags fake citations mismatched titles and unsupported attributions", () => {
  const records = buildArxivSourceRecords([paper]);
  const unsupported = claimedCitationFromSourceRecord(records[0]);
  const result = validateCitations([
    { sourceId: "arXiv:2501.99999", title: "Fake Citation" },
    { sourceId: "arXiv:2401.00001", title: "A Different Paper" },
    {
      ...unsupported,
      supportText: "This quoted text is not present in the fetched source.",
      claimText: "This quoted text is not present in the fetched source."
    }
  ], records);

  expect(result.ok).toBe(false);
  expect(result.trustImpact).toBe("adversarial_review_required");
  expect(result.requiresAdversarialReview).toBe(true);
  expect(result.findings.map((finding) => finding.status)).toEqual([
    "missing_source",
    "title_mismatch",
    "unsupported_attribution"
  ]);
});

test("validateCitations rejects title-only and substring-only support", () => {
  const records = buildArxivSourceRecords([paper]);
  const citation = claimedCitationFromSourceRecord(records[0]);
  const result = validateCitations([
    {
      sourceId: citation.sourceId,
      title: citation.title,
      snapshotHash: citation.snapshotHash,
      claimText: citation.claimText,
      entailmentReview: citation.entailmentReview
    },
    {
      ...citation,
      supportText: "prime-gap lemma",
      claimText: "prime-gap lemma"
    }
  ], records);

  expect(result.ok).toBe(false);
  expect(result.findings.map((finding) => finding.status)).toEqual([
    "missing_quoted_span",
    "substring_only_support"
  ]);
  expect(result.findings[0].supportReview?.sourceExists).toBe(true);
  expect(result.findings[0].supportReview?.canSupportMathematicalClaim).toBe(false);
  expect(result.findings[1].supportReview?.quotedSpanLocated).toBe(true);
  expect(result.findings[1].supportReview?.canSupportMathematicalClaim).toBe(false);
});

test("validateCitations requires exact arXiv version and snapshot hash", () => {
  const records = buildArxivSourceRecords([paper]);
  const citation = claimedCitationFromSourceRecord(records[0]);
  const result = validateCitations([
    {
      ...citation,
      sourceId: "arXiv:2401.00001v1"
    },
    {
      ...citation,
      snapshotHash: "b".repeat(64)
    }
  ], records);

  expect(result.ok).toBe(false);
  expect(result.findings.map((finding) => finding.status)).toEqual([
    "version_mismatch",
    "snapshot_mismatch"
  ]);
});

test("validateCitations rejects stale withdrawn non-entailing and non-independent support", () => {
  const records = buildArxivSourceRecords([paper]);
  const citation = claimedCitationFromSourceRecord(records[0]);
  const [withdrawnRecord] = buildArxivSourceRecords([{
    ...paper,
    id: "http://arxiv.org/abs/2401.00003v1",
    title: "Withdrawn: A Proof About Primes"
  }]);
  const withdrawnCitation = claimedCitationFromSourceRecord(withdrawnRecord);
  const result = validateCitations([
    {
      ...citation,
      claimText: "This paper proves the Riemann hypothesis for all zeta zeros."
    },
    {
      ...citation,
      staleBefore: "2025-01-01T00:00:00Z"
    },
    withdrawnCitation,
    {
      ...citation,
      entailmentReview: {
        reviewerId: "same-worker",
        independent: false
      }
    }
  ], [...records, withdrawnRecord]);

  expect(result.ok).toBe(false);
  expect(result.findings.map((finding) => finding.status)).toEqual([
    "non_entailing",
    "stale_version",
    "withdrawn_source",
    "missing_independent_entailment"
  ]);
  expect(result.findings[0].supportReview?.entailment.status).toBe("not_entailed");
  expect(result.findings[1].supportReview?.staleStatus).toBe("stale");
  expect(result.findings[2].supportReview?.withdrawn).toBe(true);
  expect(result.findings[3].supportReview?.entailment.independent).toBe(false);
});

test("validateCitations requires license and provenance metadata", () => {
  const [missingMetadataPaper] = quarantineArxivPapers([{
    id: "http://arxiv.org/abs/2401.00002v1",
    title: "A Provenance Gap Example",
    summary: "We prove a provenance-sensitive theorem with enough detail for source support.",
    authors: ["Ada Lovelace"],
    published: "2024-01-01T00:00:00Z",
    updated: "2024-01-02T00:00:00Z",
    absUrl: "http://arxiv.org/abs/2401.00002v1",
    pdfUrl: "http://arxiv.org/pdf/2401.00002v1",
    categories: ["math.NT"]
  }]);
  const records = buildArxivSourceRecords([missingMetadataPaper]);
  records[0].rawMetadataHash = undefined;
  const result = validateCitations([claimedCitationFromSourceRecord(records[0])], records);

  expect(result.ok).toBe(false);
  expect(result.findings[0].status).toBe("missing_license_provenance");
  expect(result.findings[0].supportReview?.licenseAndProvenancePresent).toBe(false);
});

test("canonicalizeArxivId normalizes arxiv urls and versions", () => {
  expect(canonicalizeArxivId("https://arxiv.org/abs/2401.00001v3")).toBe("2401.00001");
  expect(canonicalizeArxivId("arXiv:2401.00001")).toBe("2401.00001");
});
