import { createHash } from "node:crypto";
import type { ArxivPaper } from "./arxiv";

const HOSTILE_SOURCE_PATTERNS = [
  /ignore (all )?(previous|prior|system|developer) instructions/i,
  /ignore (all )?(previous|prior) (system|developer) instructions/i,
  /disregard (all )?(previous|prior|system|developer) instructions/i,
  /disregard (all )?(previous|prior) (system|developer) instructions/i,
  /reveal (the )?(api key|secret|token|system prompt)/i,
  /exfiltrate/i,
  /override (the )?(system|developer|safety)/i,
  /you are now/i,
  /set budget to unlimited/i,
  /use model:\s*[a-z0-9._/-]+/i,
  /approve provider admission/i,
  /enable tool:\s*[a-z0-9._/-]+/i,
  /verifier policy:\s*trust/i,
  /mark goal_met/i
];

export type RetrievedSourceFieldName =
  | "id"
  | "title"
  | "summary"
  | "author"
  | "category"
  | "absUrl"
  | "pdfUrl"
  | "citation"
  | "bibtex"
  | "pdfText"
  | "theoremStatement"
  | "toolOutputSummary"
  | "crossAgentSummary";

export type SourceFieldTaint = {
  field: RetrievedSourceFieldName;
  index?: number;
  valueHash: string;
  preview: string;
  flags: string[];
  taint: "untrusted_retrieved_data";
  promotionRequired: "typed_citation_or_lemma_or_claim_artifact";
};

export type SourceTrust = {
  trustLevel: "untrusted";
  quarantine: true;
  citationOnly: boolean;
  flags: string[];
  taintedFields?: SourceFieldTaint[];
};

export type QuarantinedArxivPaper = Omit<ArxivPaper, "summary"> & {
  untrustedSummary?: string;
  summaryPreview?: string;
  sourceFieldTaint: SourceFieldTaint[];
  trust: SourceTrust;
};

export function quarantineArxivPapers(papers: ArxivPaper[], options: { citationOnly?: boolean } = {}): QuarantinedArxivPaper[] {
  return papers.map((paper) => {
    const sourceFieldTaint = collectSourceFieldTaint(paper);
    const flags = unique(sourceFieldTaint.flatMap((field) => field.flags));
    const citationOnly = options.citationOnly !== false;
    const base = {
      id: paper.id,
      title: paper.title,
      authors: paper.authors,
      published: paper.published,
      updated: paper.updated,
      pdfUrl: paper.pdfUrl,
      absUrl: paper.absUrl,
      categories: paper.categories,
      citations: paper.citations,
      bibtex: paper.bibtex,
      theoremStatements: paper.theoremStatements,
      rawMetadataHash: paper.rawMetadataHash ?? hashJson({
        id: paper.id,
        title: paper.title,
        authors: paper.authors,
        published: paper.published,
        updated: paper.updated,
        pdfUrl: paper.pdfUrl,
        absUrl: paper.absUrl,
        categories: paper.categories,
        citations: paper.citations,
        bibtex: paper.bibtex,
        pdfTextHash: paper.pdfText ? hashText(paper.pdfText) : undefined,
        theoremStatements: paper.theoremStatements,
        toolOutputSummaryHashes: paper.toolOutputSummaries?.map(hashText),
        crossAgentSummaryHashes: paper.crossAgentSummaries?.map(hashText)
      }),
      sourceFieldTaint,
      trust: {
        trustLevel: "untrusted" as const,
        quarantine: true as const,
        citationOnly,
        flags,
        taintedFields: sourceFieldTaint
      }
    };
    if (citationOnly) {
      return {
        ...base,
        summaryPreview: preview(paper.summary)
      };
    }
    return {
      ...base,
      untrustedSummary: paper.summary,
      summaryPreview: preview(paper.summary)
    };
  });
}

export function detectPromptInjection(text: string): string[] {
  const flags: string[] = [];
  for (const pattern of HOSTILE_SOURCE_PATTERNS) {
    if (pattern.test(text)) flags.push(pattern.source);
  }
  return flags;
}

export function untrustedSourceTextForPrompt(paper: Pick<QuarantinedArxivPaper, "untrustedSummary" | "sourceFieldTaint">): string {
  return [
    paper.untrustedSummary,
    ...paper.sourceFieldTaint
      .filter((field) => field.field !== "summary")
      .map((field) => `[${field.field}${field.index !== undefined ? `#${field.index}` : ""}] ${field.preview}`)
  ].filter((value): value is string => typeof value === "string" && value.length > 0).join("\n");
}

function collectSourceFieldTaint(paper: ArxivPaper): SourceFieldTaint[] {
  const fields: Array<{ field: RetrievedSourceFieldName; value: string; index?: number }> = [
    { field: "id", value: paper.id },
    { field: "title", value: paper.title },
    { field: "summary", value: paper.summary },
    ...paper.authors.map((value, index) => ({ field: "author" as const, value, index })),
    ...paper.categories.map((value, index) => ({ field: "category" as const, value, index })),
    paper.absUrl ? { field: "absUrl", value: paper.absUrl } : undefined,
    paper.pdfUrl ? { field: "pdfUrl", value: paper.pdfUrl } : undefined,
    ...(paper.citations ?? []).map((value, index) => ({ field: "citation" as const, value, index })),
    paper.bibtex ? { field: "bibtex", value: paper.bibtex } : undefined,
    paper.pdfText ? { field: "pdfText", value: paper.pdfText } : undefined,
    ...(paper.theoremStatements ?? []).map((value, index) => ({ field: "theoremStatement" as const, value, index })),
    ...(paper.toolOutputSummaries ?? []).map((value, index) => ({ field: "toolOutputSummary" as const, value, index })),
    ...(paper.crossAgentSummaries ?? []).map((value, index) => ({ field: "crossAgentSummary" as const, value, index }))
  ].filter((field): field is { field: RetrievedSourceFieldName; value: string; index?: number } => Boolean(field));
  return fields.map(({ field, value, index }) => ({
    field,
    index,
    valueHash: hashText(value),
    preview: preview(value),
    flags: detectPromptInjection(value),
    taint: "untrusted_retrieved_data",
    promotionRequired: "typed_citation_or_lemma_or_claim_artifact"
  }));
}

function preview(text: string): string {
  return text.length <= 240 ? text : `${text.slice(0, 240)}...`;
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
