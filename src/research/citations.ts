import { createHash } from "node:crypto";
import { nowIso } from "../domain";
import type { QuarantinedArxivPaper } from "./security";

export type GroundedSourceRecord = {
  provider: "arxiv";
  query?: string;
  sourceId: string;
  canonicalId: string;
  version?: number;
  title: string;
  authors: string[];
  published: string;
  updated: string;
  url?: string;
  retrievedAt: string;
  ranking: number;
  abstractHash: string;
  snapshotHash: string;
  rawMetadataHash?: string;
  extractedClaims: string[];
  contentHash: string;
  supportText: string;
  sourceFieldTaint: Array<{
    field: string;
    index?: number;
    valueHash: string;
    flags: string[];
    taint: "untrusted_retrieved_data";
    promotionRequired: "typed_citation_or_lemma_or_claim_artifact";
  }>;
};

export type ClaimedCitation = {
  sourceId?: string;
  title?: string;
  supportText?: string;
  claimText?: string;
  snapshotHash?: string;
  staleBefore?: string;
  entailmentReview?: {
    reviewerId: string;
    independent: boolean;
  };
};

export type CitationFinding = {
  status:
    | "grounded"
    | "missing_source"
    | "version_mismatch"
    | "title_mismatch"
    | "snapshot_mismatch"
    | "missing_quoted_span"
    | "substring_only_support"
    | "unsupported_attribution"
    | "non_entailing"
    | "stale_version"
    | "withdrawn_source"
    | "missing_license_provenance"
    | "missing_independent_entailment";
  citation: ClaimedCitation;
  matchedSourceId?: string;
  matchedSnapshotHash?: string;
  supportReview?: CitationSupportReview;
  reason: string;
};

export type CitationValidationResult = {
  ok: boolean;
  findings: CitationFinding[];
  supportPolicy: {
    sourceExistenceIsNotMathematicalSupport: true;
    exactArxivVersionRequired: true;
    snapshotHashRequired: true;
    quotedSpanRequired: true;
    independentEntailmentRequired: true;
    licenseAndProvenanceRequired: true;
    canSupportSolvedClaim: false;
  };
  trustImpact: "none" | "lower_trust" | "adversarial_review_required";
  requiresAdversarialReview: boolean;
};

export type CitationSupportReview = {
  format: "matematica.citation-support-review";
  version: 1;
  sourceExists: boolean;
  exactArxivVersion: boolean;
  snapshotHashMatches: boolean;
  quotedSpanLocated: boolean;
  quotedSpanHash?: string;
  quotedSpan?: string;
  licenseAndProvenancePresent: boolean;
  staleStatus: "fresh" | "stale" | "unknown";
  withdrawn: boolean;
  entailment: {
    reviewerId: string;
    independent: boolean;
    status: "entailed" | "not_entailed" | "not_reviewed";
    claimText?: string;
    reason: string;
  };
  canSupportMathematicalClaim: boolean;
  canSupportSolvedClaim: false;
  proofSupport: "not_proof_support";
};

export function buildArxivSourceRecords(
  papers: QuarantinedArxivPaper[],
  options: string | { retrievedAt?: string; query?: string } = {}
): GroundedSourceRecord[] {
  const retrievedAt = typeof options === "string" ? options : options.retrievedAt ?? nowIso();
  const query = typeof options === "string" ? undefined : options.query;
  return papers.map((paper, index) => {
    const supportText = paper.untrustedSummary ?? paper.summaryPreview ?? "";
    const abstractHash = hashText(supportText);
    const record = {
      provider: "arxiv" as const,
      query,
      sourceId: paper.id,
      canonicalId: canonicalizeArxivId(paper.id),
      version: arxivVersion(paper.id),
      title: paper.title,
      authors: paper.authors,
      published: paper.published,
      updated: paper.updated,
      url: paper.absUrl ?? paper.pdfUrl,
      retrievedAt,
      ranking: index + 1,
      abstractHash,
      rawMetadataHash: paper.rawMetadataHash,
      snapshotHash: hashSourceSnapshot({
        sourceId: paper.id,
        title: paper.title,
        authors: paper.authors,
        published: paper.published,
        updated: paper.updated,
        absUrl: paper.absUrl,
        pdfUrl: paper.pdfUrl,
        categories: paper.categories,
        rawMetadataHash: paper.rawMetadataHash,
        abstractHash,
        sourceFieldTaint: paper.sourceFieldTaint.map((field) => ({
          field: field.field,
          index: field.index,
          valueHash: field.valueHash,
          flags: field.flags,
          taint: field.taint,
          promotionRequired: field.promotionRequired
        }))
      }),
      extractedClaims: extractSourceClaims(supportText),
      supportText,
      sourceFieldTaint: paper.sourceFieldTaint.map((field) => ({
        field: field.field,
        index: field.index,
        valueHash: field.valueHash,
        flags: field.flags,
        taint: field.taint,
        promotionRequired: field.promotionRequired
      }))
    };
    return {
      ...record,
      contentHash: hashSourceRecord(record)
    };
  });
}

export function validateCitations(
  citations: ClaimedCitation[],
  records: GroundedSourceRecord[]
): CitationValidationResult {
  const findings = citations.map((citation) => validateCitation(citation, records));
  const ok = findings.every((finding) => finding.status === "grounded");
  return {
    ok,
    findings,
    supportPolicy: {
      sourceExistenceIsNotMathematicalSupport: true,
      exactArxivVersionRequired: true,
      snapshotHashRequired: true,
      quotedSpanRequired: true,
      independentEntailmentRequired: true,
      licenseAndProvenanceRequired: true,
      canSupportSolvedClaim: false
    },
    trustImpact: ok ? "none" : "adversarial_review_required",
    requiresAdversarialReview: !ok
  };
}

export function claimedCitationFromSourceRecord(record: GroundedSourceRecord): ClaimedCitation {
  const supportText = record.extractedClaims[0] ?? record.supportText;
  return {
    sourceId: record.version ? `arXiv:${record.canonicalId}v${record.version}` : record.sourceId,
    title: record.title,
    supportText,
    claimText: supportText,
    snapshotHash: record.snapshotHash,
    entailmentReview: {
      reviewerId: "deterministic-citation-entailment-v1",
      independent: true
    }
  };
}

export function canonicalizeArxivId(value: string | undefined): string {
  if (!value) return "";
  const trimmed = value.trim();
  const match = trimmed.match(/(?:arxiv\.org\/abs\/|arXiv:)?([0-9]{4}\.[0-9]{4,5})(?:v[0-9]+)?/i);
  if (match) return match[1].toLowerCase();
  return trimmed.toLowerCase();
}

export function arxivVersion(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = value.match(/(?:[0-9]{4}\.[0-9]{4,5})v([0-9]+)/i);
  if (!match) return undefined;
  const version = Number(match[1]);
  return Number.isInteger(version) && version > 0 ? version : undefined;
}

function validateCitation(citation: ClaimedCitation, records: GroundedSourceRecord[]): CitationFinding {
  const record = findRecord(citation, records);
  if (!record) {
    return {
      status: "missing_source",
      citation,
      reason: "citation does not map to a fetched source record"
    };
  }
  const baseReview = buildSupportReview(citation, record);

  if (citation.title && normalizeTitle(citation.title) !== normalizeTitle(record.title)) {
    return {
      status: "title_mismatch",
      citation,
      matchedSourceId: record.sourceId,
      matchedSnapshotHash: record.snapshotHash,
      supportReview: baseReview,
      reason: "claimed title does not match fetched source title"
    };
  }

  if (!baseReview.exactArxivVersion) {
    return {
      status: "version_mismatch",
      citation,
      matchedSourceId: record.sourceId,
      matchedSnapshotHash: record.snapshotHash,
      supportReview: baseReview,
      reason: "citation must name the exact fetched arXiv version"
    };
  }

  if (!baseReview.snapshotHashMatches) {
    return {
      status: "snapshot_mismatch",
      citation,
      matchedSourceId: record.sourceId,
      matchedSnapshotHash: record.snapshotHash,
      supportReview: baseReview,
      reason: "citation snapshot hash does not match the fetched source record"
    };
  }

  if (!citation.supportText) {
    return {
      status: "missing_quoted_span",
      citation,
      matchedSourceId: record.sourceId,
      matchedSnapshotHash: record.snapshotHash,
      supportReview: baseReview,
      reason: "citation must include a quoted support span from the fetched source"
    };
  }

  if (!baseReview.quotedSpanLocated) {
    return {
      status: "unsupported_attribution",
      citation,
      matchedSourceId: record.sourceId,
      matchedSnapshotHash: record.snapshotHash,
      supportReview: baseReview,
      reason: "quoted support span was not located in the fetched source record"
    };
  }

  if (!isSubstantiveQuotedSpan(citation.supportText)) {
    return {
      status: "substring_only_support",
      citation,
      matchedSourceId: record.sourceId,
      matchedSnapshotHash: record.snapshotHash,
      supportReview: baseReview,
      reason: "citation support is only a short substring, not a substantive quoted span"
    };
  }

  if (!baseReview.licenseAndProvenancePresent) {
    return {
      status: "missing_license_provenance",
      citation,
      matchedSourceId: record.sourceId,
      matchedSnapshotHash: record.snapshotHash,
      supportReview: baseReview,
      reason: "citation source record is missing license/provenance fields required for source support"
    };
  }

  if (baseReview.staleStatus === "stale") {
    return {
      status: "stale_version",
      citation,
      matchedSourceId: record.sourceId,
      matchedSnapshotHash: record.snapshotHash,
      supportReview: baseReview,
      reason: "citation points to a stale source version for this review"
    };
  }

  if (baseReview.withdrawn) {
    return {
      status: "withdrawn_source",
      citation,
      matchedSourceId: record.sourceId,
      matchedSnapshotHash: record.snapshotHash,
      supportReview: baseReview,
      reason: "citation source appears withdrawn and cannot support the claim"
    };
  }

  if (!baseReview.entailment.independent) {
    return {
      status: "missing_independent_entailment",
      citation,
      matchedSourceId: record.sourceId,
      matchedSnapshotHash: record.snapshotHash,
      supportReview: baseReview,
      reason: "citation support requires an independent entailment review"
    };
  }

  if (baseReview.entailment.status !== "entailed") {
    return {
      status: "non_entailing",
      citation,
      matchedSourceId: record.sourceId,
      matchedSnapshotHash: record.snapshotHash,
      supportReview: baseReview,
      reason: "quoted support span does not entail the cited mathematical claim"
    };
  }

  return {
    status: "grounded",
    citation,
    matchedSourceId: record.sourceId,
    matchedSnapshotHash: record.snapshotHash,
    supportReview: baseReview,
    reason: "citation maps to exact fetched arXiv version, snapshot, quoted support span, and independent entailment review"
  };
}

function findRecord(citation: ClaimedCitation, records: GroundedSourceRecord[]): GroundedSourceRecord | undefined {
  const canonicalId = canonicalizeArxivId(citation.sourceId);
  if (canonicalId) {
    const byId = records.find((record) => record.canonicalId === canonicalId || record.sourceId.toLowerCase() === citation.sourceId?.toLowerCase());
    if (byId) return byId;
  }
  if (citation.title) {
    const normalizedTitle = normalizeTitle(citation.title);
    return records.find((record) => normalizeTitle(record.title) === normalizedTitle);
  }
  return undefined;
}

function buildSupportReview(citation: ClaimedCitation, record: GroundedSourceRecord): CitationSupportReview {
  const citedVersion = arxivVersion(citation.sourceId);
  const quotedSpan = citation.supportText;
  const quotedSpanLocated = Boolean(quotedSpan && containsSupport(record.supportText, quotedSpan));
  const staleBefore = citation.staleBefore;
  const staleStatus = staleBefore && record.updated
    ? record.updated < staleBefore ? "stale" : "fresh"
    : "unknown";
  const withdrawn = /\bwithdrawn\b/i.test(`${record.title}\n${record.supportText}`);
  const independent = citation.entailmentReview?.independent === true && Boolean(citation.entailmentReview?.reviewerId);
  const reviewerId = citation.entailmentReview?.reviewerId ?? "deterministic-citation-entailment-v1";
  const entailment = reviewCitationEntailment(citation.claimText, quotedSpan, independent, reviewerId);
  const exactArxivVersion = record.version !== undefined && citedVersion === record.version;
  const snapshotHashMatches = typeof citation.snapshotHash === "string" && citation.snapshotHash === record.snapshotHash;
  const licenseAndProvenancePresent = Boolean(
    record.provider === "arxiv" &&
    record.sourceId &&
    record.canonicalId &&
    record.version !== undefined &&
    record.retrievedAt &&
    record.contentHash &&
    record.snapshotHash &&
    record.rawMetadataHash
  );
  const canSupportMathematicalClaim = exactArxivVersion &&
    snapshotHashMatches &&
    quotedSpanLocated &&
    isSubstantiveQuotedSpan(quotedSpan ?? "") &&
    licenseAndProvenancePresent &&
    staleStatus !== "stale" &&
    !withdrawn &&
    entailment.independent &&
    entailment.status === "entailed";
  return {
    format: "matematica.citation-support-review",
    version: 1,
    sourceExists: true,
    exactArxivVersion,
    snapshotHashMatches,
    quotedSpanLocated,
    quotedSpanHash: quotedSpan ? hashText(quotedSpan) : undefined,
    quotedSpan,
    licenseAndProvenancePresent,
    staleStatus,
    withdrawn,
    entailment,
    canSupportMathematicalClaim,
    canSupportSolvedClaim: false,
    proofSupport: "not_proof_support"
  };
}

function containsSupport(sourceText: string, claimedSupport: string): boolean {
  return normalizeSupport(sourceText).includes(normalizeSupport(claimedSupport));
}

function isSubstantiveQuotedSpan(value: string): boolean {
  const tokens = normalizeSupport(value).split(/\s+/).filter(Boolean);
  return tokens.length >= 7 && value.length >= 40;
}

function reviewCitationEntailment(
  claimText: string | undefined,
  quotedSpan: string | undefined,
  independent: boolean,
  reviewerId: string
): CitationSupportReview["entailment"] {
  if (!claimText || !quotedSpan) {
    return {
      reviewerId,
      independent,
      status: "not_reviewed",
      claimText,
      reason: "missing claim text or quoted support span"
    };
  }
  const claimTokens = meaningfulTokens(claimText);
  const quoteTokens = meaningfulTokens(quotedSpan);
  if (claimTokens.length === 0 || quoteTokens.length === 0) {
    return {
      reviewerId,
      independent,
      status: "not_entailed",
      claimText,
      reason: "claim or quote has no mathematical content tokens"
    };
  }
  const quoteSet = new Set(quoteTokens);
  const overlap = claimTokens.filter((token) => quoteSet.has(token));
  const ratio = overlap.length / Math.max(1, claimTokens.length);
  const status = ratio >= 0.6 ? "entailed" : "not_entailed";
  return {
    reviewerId,
    independent,
    status,
    claimText,
    reason: status === "entailed"
      ? `deterministic entailment accepted with token overlap ${overlap.length}/${claimTokens.length}`
      : `deterministic entailment rejected with token overlap ${overlap.length}/${claimTokens.length}`
  };
}

function normalizeTitle(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function normalizeSupport(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function meaningfulTokens(value: string): string[] {
  const stop = new Set(["the", "and", "that", "this", "with", "using", "from", "into", "about", "paper", "prove", "proves", "show", "shows", "establish", "establishes", "claim", "claimed"]);
  return normalizeSupport(value)
    .replace(/[^a-z0-9.\s-]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !stop.has(token));
}

function hashSourceRecord(record: Omit<GroundedSourceRecord, "contentHash">): string {
  return createHash("sha256").update(JSON.stringify(record)).digest("hex");
}

function hashSourceSnapshot(snapshot: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function extractSourceClaims(text: string): string[] {
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  const claimLike = sentences
    .filter((sentence) => /(^|\b)(we|this paper|the paper|our|prove|shows?|establish|construct|extends?|introduces?|formaliz)/i.test(sentence))
    .slice(0, 8);
  return claimLike.length > 0 ? claimLike : sentences.slice(0, 3);
}
