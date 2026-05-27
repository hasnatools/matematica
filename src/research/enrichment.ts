import { createHash } from "node:crypto";
import {
  canonicalizeArxivId,
  type CitationValidationResult,
  type GroundedSourceRecord
} from "./citations";
import type { QuarantinedArxivPaper } from "./security";

export type SemanticDedupeGroup = {
  groupId: string;
  representativeSourceId: string;
  sourceIds: string[];
  canonicalIds: string[];
  reason: "canonical_id" | "normalized_title" | "semantic_overlap";
  similarity: number;
};

export type SemanticDedupeResult = {
  originalCount: number;
  uniqueCount: number;
  duplicateCount: number;
  groups: SemanticDedupeGroup[];
  duplicateSourceIds: string[];
};

export type CitationGraphNode = {
  sourceId: string;
  canonicalId: string;
  title: string;
};

export type CitationGraphEdge = {
  fromSourceId: string;
  toCanonicalId: string;
  evidence: "arxiv_id_in_source_text";
};

export type CitationGraph = {
  nodes: CitationGraphNode[];
  edges: CitationGraphEdge[];
  graphHash: string;
};

export type SourceSnapshot = {
  sourceId: string;
  canonicalId: string;
  absUrl?: string;
  pdfUrl?: string;
  sourceUrl: string;
  stored: false;
  storagePolicy: "metadata_only_not_exported";
  redistribution: string;
  rawMetadataHash?: string;
  metadataHash: string;
};

export type CitationLicenseManifestEntry = {
  provider: "arxiv";
  sourceId: string;
  canonicalId: string;
  version?: number;
  retrievalTimestamp: string;
  contentHash: string;
  citationFormat: string;
  license: {
    metadataRedistribution: string;
    pdfAndSourceRedistribution: string;
    termsUrl: string;
  };
  staleStatus: {
    status: "fresh" | "stale" | "unknown";
    staleBefore?: string;
    updated?: string;
  };
  copiedTextPolicy: {
    policy: "metadata_and_abstract_excerpt_only";
    pdfExported: false;
    sourceExported: false;
    fullTextExported: false;
    supportTextIsProofSupport: false;
  };
  verifiedSupport: {
    status: "citation_metadata_and_support_verified" | "citation_metadata_only" | "citation_grounding_failed";
    proofSupport: "not_proof_support";
    canSupportSolvedClaim: false;
    findingStatuses: string[];
  };
  hostileSource: {
    flagged: boolean;
    flags: string[];
  };
  storagePolicy: "metadata_only_not_exported";
  manifestHash: string;
};

export type CitationLicenseManifest = {
  format: "matematica.citation-license-manifest";
  version: 1;
  provider: "arxiv";
  entries: CitationLicenseManifestEntry[];
  summary: {
    count: number;
    staleCount: number;
    hostileCount: number;
    pdfOrSourceContentExported: false;
    copiedTextPolicy: "metadata_and_abstract_excerpt_only";
    proofSupportPolicy: "citation_metadata_is_not_proof_support";
  };
  manifestHash: string;
};

export type SourceQualityFinding = {
  sourceId: string;
  canonicalId: string;
  score: number;
  band: "high" | "medium" | "low";
  factors: string[];
  penalties: string[];
};

export type SourceQualityReport = {
  averageScore: number;
  highQualityCount: number;
  mediumQualityCount: number;
  lowQualityCount: number;
  findings: SourceQualityFinding[];
};

export type ArxivResearchEnrichment = {
  semanticDedupe: SemanticDedupeResult;
  citationGraph: CitationGraph;
  snapshots: SourceSnapshot[];
  sourceQuality: SourceQualityReport;
  citationLicenseManifest: CitationLicenseManifest;
};

export function buildArxivResearchEnrichment(input: {
  query: string;
  papers: QuarantinedArxivPaper[];
  sourceRecords: GroundedSourceRecord[];
  redistribution: string;
  metadataRedistribution?: string;
  termsUrl?: string;
  staleBefore?: string;
  citationGrounding?: CitationValidationResult;
}): ArxivResearchEnrichment {
  const semanticDedupe = deduplicateArxivPapers(input.papers);
  const citationGraph = buildCitationGraph(input.sourceRecords);
  const snapshots = buildSourceSnapshots(input.papers, input.redistribution);
  const sourceQuality = gradeSourceQuality({
    query: input.query,
    papers: input.papers,
    sourceRecords: input.sourceRecords,
    duplicateSourceIds: new Set(semanticDedupe.duplicateSourceIds),
    staleBefore: input.staleBefore
  });
  const citationLicenseManifest = buildCitationLicenseManifest({
    papers: input.papers,
    sourceRecords: input.sourceRecords,
    redistribution: input.redistribution,
    metadataRedistribution: input.metadataRedistribution,
    termsUrl: input.termsUrl,
    staleBefore: input.staleBefore,
    citationGrounding: input.citationGrounding
  });
  return {
    semanticDedupe,
    citationGraph,
    snapshots,
    sourceQuality,
    citationLicenseManifest
  };
}

export function deduplicateArxivPapers(papers: QuarantinedArxivPaper[]): SemanticDedupeResult {
  const groups: SemanticDedupeGroup[] = [];
  const assigned = new Set<number>();
  for (let index = 0; index < papers.length; index += 1) {
    if (assigned.has(index)) continue;
    const paper = papers[index];
    const groupIndexes = [index];
    let groupReason: SemanticDedupeGroup["reason"] = "canonical_id";
    let groupSimilarity = 1;
    for (let candidateIndex = index + 1; candidateIndex < papers.length; candidateIndex += 1) {
      if (assigned.has(candidateIndex)) continue;
      const candidate = papers[candidateIndex];
      const match = duplicateMatch(paper, candidate);
      if (!match) continue;
      groupIndexes.push(candidateIndex);
      assigned.add(candidateIndex);
      if (match.reason === "semantic_overlap") {
        groupReason = "semantic_overlap";
        groupSimilarity = Math.min(groupSimilarity, match.similarity);
      } else if (groupReason !== "semantic_overlap" && match.reason === "normalized_title") {
        groupReason = "normalized_title";
      }
    }
    if (groupIndexes.length > 1) {
      const groupPapers = groupIndexes.map((groupIndex) => papers[groupIndex]);
      groups.push({
        groupId: hashJson(groupPapers.map((item) => item.id)).slice(0, 16),
        representativeSourceId: paper.id,
        sourceIds: groupPapers.map((item) => item.id),
        canonicalIds: [...new Set(groupPapers.map((item) => canonicalizeArxivId(item.id)))],
        reason: groupReason,
        similarity: Number(groupSimilarity.toFixed(3))
      });
    }
    assigned.add(index);
  }
  const duplicateSourceIds = groups.flatMap((group) => group.sourceIds.filter((sourceId) => sourceId !== group.representativeSourceId));
  return {
    originalCount: papers.length,
    uniqueCount: papers.length - duplicateSourceIds.length,
    duplicateCount: duplicateSourceIds.length,
    groups,
    duplicateSourceIds
  };
}

export function buildCitationGraph(records: GroundedSourceRecord[]): CitationGraph {
  const nodes = records.map((record) => ({
    sourceId: record.sourceId,
    canonicalId: record.canonicalId,
    title: record.title
  }));
  const edges = records.flatMap((record) =>
    extractedArxivIds(record.supportText)
      .filter((target) => target !== record.canonicalId)
      .map((target) => ({
        fromSourceId: record.sourceId,
        toCanonicalId: target,
        evidence: "arxiv_id_in_source_text" as const
      }))
  );
  const uniqueEdges = uniqueBy(edges, (edge) => `${edge.fromSourceId}->${edge.toCanonicalId}`);
  return {
    nodes,
    edges: uniqueEdges,
    graphHash: hashJson({ nodes, edges: uniqueEdges })
  };
}

export function buildSourceSnapshots(papers: QuarantinedArxivPaper[], redistribution: string): SourceSnapshot[] {
  return papers.map((paper) => {
    const canonicalId = canonicalizeArxivId(paper.id);
    const snapshot = {
      sourceId: paper.id,
      canonicalId,
      absUrl: paper.absUrl,
      pdfUrl: paper.pdfUrl,
      sourceUrl: `https://arxiv.org/e-print/${canonicalId}`,
      stored: false as const,
      storagePolicy: "metadata_only_not_exported" as const,
      redistribution,
      rawMetadataHash: paper.rawMetadataHash
    };
    return {
      ...snapshot,
      metadataHash: hashJson(snapshot)
    };
  });
}

export function buildCitationLicenseManifest(input: {
  papers: QuarantinedArxivPaper[];
  sourceRecords: GroundedSourceRecord[];
  redistribution: string;
  metadataRedistribution?: string;
  termsUrl?: string;
  staleBefore?: string;
  citationGrounding?: CitationValidationResult;
}): CitationLicenseManifest {
  const paperByCanonicalId = new Map(input.papers.map((paper) => [canonicalizeArxivId(paper.id), paper]));
  const entries = input.sourceRecords.map((record) => {
    const paper = paperByCanonicalId.get(record.canonicalId);
    const findingStatuses = input.citationGrounding?.findings
      .filter((finding) => canonicalizeArxivId(finding.matchedSourceId ?? finding.citation.sourceId) === record.canonicalId)
      .map((finding) => finding.status) ?? [];
    const staleStatus = sourceStaleStatus(record.updated, input.staleBefore);
    const entryBase = {
      provider: "arxiv" as const,
      sourceId: record.sourceId,
      canonicalId: record.canonicalId,
      version: record.version,
      retrievalTimestamp: record.retrievedAt,
      contentHash: record.contentHash,
      citationFormat: citationFormat(record),
      license: {
        metadataRedistribution: input.metadataRedistribution ?? "allowed" as const,
        pdfAndSourceRedistribution: input.redistribution,
        termsUrl: input.termsUrl ?? "https://info.arxiv.org/help/api/tou.html"
      },
      staleStatus,
      copiedTextPolicy: {
        policy: "metadata_and_abstract_excerpt_only" as const,
        pdfExported: false as const,
        sourceExported: false as const,
        fullTextExported: false as const,
        supportTextIsProofSupport: false as const
      },
      verifiedSupport: {
        status: verifiedSupportStatus(findingStatuses, input.citationGrounding),
        proofSupport: "not_proof_support" as const,
        canSupportSolvedClaim: false as const,
        findingStatuses
      },
      hostileSource: {
        flagged: (paper?.trust.flags.length ?? 0) > 0,
        flags: paper?.trust.flags ?? []
      },
      storagePolicy: "metadata_only_not_exported" as const
    };
    return {
      ...entryBase,
      manifestHash: hashJson(entryBase)
    };
  });
  const summary = {
    count: entries.length,
    staleCount: entries.filter((entry) => entry.staleStatus.status === "stale").length,
    hostileCount: entries.filter((entry) => entry.hostileSource.flagged).length,
    pdfOrSourceContentExported: false as const,
    copiedTextPolicy: "metadata_and_abstract_excerpt_only" as const,
    proofSupportPolicy: "citation_metadata_is_not_proof_support" as const
  };
  const manifestBase = {
    format: "matematica.citation-license-manifest" as const,
    version: 1 as const,
    provider: "arxiv" as const,
    entries,
    summary
  };
  return {
    ...manifestBase,
    manifestHash: hashJson(manifestBase)
  };
}

export function gradeSourceQuality(input: {
  query: string;
  papers: QuarantinedArxivPaper[];
  sourceRecords: GroundedSourceRecord[];
  duplicateSourceIds?: Set<string>;
  staleBefore?: string;
}): SourceQualityReport {
  const duplicateSourceIds = input.duplicateSourceIds ?? new Set<string>();
  const categoryTerms = queryCategories(input.query);
  const findings = input.papers.map((paper) => {
    const record = input.sourceRecords.find((item) => canonicalizeArxivId(item.sourceId) === canonicalizeArxivId(paper.id));
    let score = 0;
    const factors: string[] = [];
    const penalties: string[] = [];

    if (record?.title && record.authors.length > 0 && record.published && record.updated) {
      score += 0.25;
      factors.push("complete_metadata");
    } else {
      penalties.push("incomplete_metadata");
    }
    if (paper.absUrl && paper.pdfUrl) {
      score += 0.2;
      factors.push("abs_and_pdf_available");
    } else {
      penalties.push("missing_abs_or_pdf_url");
    }
    if (categoryTerms.length === 0 || categoryTerms.some((category) => paper.categories.includes(category))) {
      score += 0.2;
      factors.push("category_aligned");
    } else {
      penalties.push("category_mismatch");
    }
    if (!input.staleBefore || !paper.updated || paper.updated >= input.staleBefore) {
      score += 0.15;
      factors.push("fresh_enough");
    } else {
      penalties.push("stale_metadata");
    }
    if (paper.trust.flags.length === 0) {
      score += 0.15;
      factors.push("no_prompt_injection_flags");
    } else {
      penalties.push("hostile_source_flags");
    }
    if (!duplicateSourceIds.has(paper.id)) {
      score += 0.05;
      factors.push("not_duplicate");
    } else {
      penalties.push("duplicate_result");
    }

    const roundedScore = Number(score.toFixed(2));
    return {
      sourceId: paper.id,
      canonicalId: canonicalizeArxivId(paper.id),
      score: roundedScore,
      band: qualityBand(roundedScore),
      factors,
      penalties
    };
  });
  const averageScore = findings.length === 0
    ? 0
    : Number((findings.reduce((sum, finding) => sum + finding.score, 0) / findings.length).toFixed(2));
  return {
    averageScore,
    highQualityCount: findings.filter((finding) => finding.band === "high").length,
    mediumQualityCount: findings.filter((finding) => finding.band === "medium").length,
    lowQualityCount: findings.filter((finding) => finding.band === "low").length,
    findings
  };
}

function citationFormat(record: GroundedSourceRecord): string {
  return record.version ? `arXiv:${record.canonicalId}v${record.version}` : `arXiv:${record.canonicalId}`;
}

function sourceStaleStatus(updated: string | undefined, staleBefore: string | undefined): CitationLicenseManifestEntry["staleStatus"] {
  if (!updated) {
    return {
      status: "unknown",
      staleBefore,
      updated
    };
  }
  return {
    status: staleBefore && updated < staleBefore ? "stale" : "fresh",
    staleBefore,
    updated
  };
}

function verifiedSupportStatus(
  findingStatuses: string[],
  citationGrounding: CitationValidationResult | undefined
): CitationLicenseManifestEntry["verifiedSupport"]["status"] {
  if (findingStatuses.includes("grounded")) return "citation_metadata_and_support_verified";
  if (citationGrounding && findingStatuses.some((status) => status !== "grounded")) return "citation_grounding_failed";
  return "citation_metadata_only";
}

function duplicateMatch(
  left: QuarantinedArxivPaper,
  right: QuarantinedArxivPaper
): { reason: SemanticDedupeGroup["reason"]; similarity: number } | undefined {
  if (canonicalizeArxivId(left.id) && canonicalizeArxivId(left.id) === canonicalizeArxivId(right.id)) {
    return { reason: "canonical_id", similarity: 1 };
  }
  if (normalizeTitle(left.title) === normalizeTitle(right.title)) {
    return { reason: "normalized_title", similarity: 1 };
  }
  const titleSimilarity = jaccard(tokens(left.title), tokens(right.title));
  const summarySimilarity = jaccard(tokens(left.untrustedSummary ?? left.summaryPreview ?? ""), tokens(right.untrustedSummary ?? right.summaryPreview ?? ""));
  const similarity = (titleSimilarity + summarySimilarity) / 2;
  if (titleSimilarity >= 0.5 && summarySimilarity >= 0.82) {
    return { reason: "semantic_overlap", similarity };
  }
  return undefined;
}

function extractedArxivIds(text: string): string[] {
  const ids = Array.from(text.matchAll(/(?:arxiv\.org\/abs\/|arXiv:)?([0-9]{4}\.[0-9]{4,5})(?:v[0-9]+)?/gi))
    .map((match) => canonicalizeArxivId(match[1]))
    .filter(Boolean);
  return [...new Set(ids)];
}

function queryCategories(query: string): string[] {
  return Array.from(query.matchAll(/cat:([A-Za-z.-]+)/g)).map((match) => match[1]);
}

function qualityBand(score: number): SourceQualityFinding["band"] {
  if (score >= 0.8) return "high";
  if (score >= 0.55) return "medium";
  return "low";
}

function normalizeTitle(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function tokens(value: string): Set<string> {
  return new Set(value
    .toLowerCase()
    .replace(/[^a-z0-9.\s]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 4));
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 && right.size === 0) return 1;
  const intersection = [...left].filter((value) => right.has(value)).length;
  const union = new Set([...left, ...right]).size;
  return union === 0 ? 0 : intersection / union;
}

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const item of items) {
    const itemKey = key(item);
    if (seen.has(itemKey)) continue;
    seen.add(itemKey);
    unique.push(item);
  }
  return unique;
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
