import { canonicalizeArxivId, type CitationValidationResult, type GroundedSourceRecord } from "./citations";
import type { QuarantinedArxivPaper } from "./security";

export type RetrievalGoldenQuery = {
  id: string;
  query: string;
  expectedRelevantIds: string[];
  expectedTerms: string[];
  staleBefore?: string;
};

export type RetrievalEvaluationInput = {
  query: string;
  papers: QuarantinedArxivPaper[];
  sourceRecords: GroundedSourceRecord[];
  citationGrounding: CitationValidationResult;
  expectedRelevantIds?: string[];
  expectedTerms?: string[];
  staleBefore?: string;
  usedSourceIds?: string[];
  precisionThreshold?: number;
  recallThreshold?: number;
  sourceUseThreshold?: number;
};

export type RetrievalJudgment = {
  sourceId: string;
  canonicalId: string;
  title: string;
  relevant: boolean;
  stale: boolean;
  keywordOverfit: boolean;
  titleAbstractMismatch: boolean;
  statementEquivalenceTrap: boolean;
  reasons: string[];
};

export type RetrievalEvaluationResult = {
  query: string;
  evaluatedAt: string;
  expectedRelevantIds: string[];
  expectedTerms: string[];
  staleBefore?: string;
  retrievedCount: number;
  relevantRetrieved: number;
  expectedRetrieved: number;
  precision: number;
  recall: number;
  citationValidity: number;
  sourceUseRate: number;
  staleResultCount: number;
  irrelevantResultCount: number;
  keywordOverfitCount: number;
  titleAbstractMismatchCount: number;
  statementEquivalenceTrapCount: number;
  judgments: RetrievalJudgment[];
  failures: RetrievalEvaluationFailure[];
  trustImpact: "none" | "lower_trust" | "adversarial_review_required";
  canPromoteResearchBackedClaims: boolean;
  outage?: {
    provider: "arxiv";
    message: string;
    degradedTo: "partial_inconclusive";
  };
};

export type RetrievalEvaluationFailure =
  | "search_outage"
  | "low_precision"
  | "low_recall"
  | "invalid_citations"
  | "low_source_use"
  | "stale_results"
  | "irrelevant_results"
  | "keyword_overfit"
  | "title_abstract_mismatch"
  | "statement_equivalence_trap";

export const GOLDEN_ARXIV_RETRIEVAL_QUERIES: RetrievalGoldenQuery[] = [
  {
    id: "bounded-prime-gaps",
    query: "all:\"bounded gaps\" AND all:primes",
    expectedRelevantIds: ["1306.6074", "1311.4600"],
    expectedTerms: ["bounded gaps", "prime"]
  },
  {
    id: "lean-mathlib-formalization",
    query: "all:Lean AND all:mathlib AND cat:cs.LO",
    expectedRelevantIds: ["1910.09336"],
    expectedTerms: ["lean", "mathlib"]
  }
];

export function evaluateLiteratureRetrieval(input: RetrievalEvaluationInput): RetrievalEvaluationResult {
  const golden = findGoldenQuery(input.query);
  const expectedRelevantIds = uniqueCanonicalIds(input.expectedRelevantIds ?? golden?.expectedRelevantIds ?? []);
  const expectedTerms = uniqueStrings(input.expectedTerms ?? golden?.expectedTerms ?? []);
  const staleBefore = input.staleBefore ?? golden?.staleBefore;
  const queryTerms = queryTokens(input.query);
  const judgments = input.sourceRecords.map((record) => judgeRecord({
    record,
    paper: input.papers.find((paper) => canonicalizeArxivId(paper.id) === record.canonicalId),
    expectedRelevantIds,
    expectedTerms,
    queryTerms,
    staleBefore
  }));
  const retrievedCount = judgments.length;
  const relevantRetrieved = judgments.filter((judgment) => judgment.relevant).length;
  const expectedRetrieved = expectedRelevantIds.filter((expectedId) =>
    judgments.some((judgment) => judgment.canonicalId === expectedId && judgment.relevant)
  ).length;
  const precision = retrievedCount === 0 ? 0 : relevantRetrieved / retrievedCount;
  const recall = expectedRelevantIds.length === 0 ? (retrievedCount > 0 ? 1 : 0) : expectedRetrieved / expectedRelevantIds.length;
  const citationValidity = input.citationGrounding.findings.length === 0
    ? 1
    : input.citationGrounding.findings.filter((finding) => finding.status === "grounded").length / input.citationGrounding.findings.length;
  const usedSourceIds = new Set((input.usedSourceIds ?? groundedCitationSourceIds(input.citationGrounding)).map(canonicalizeArxivId));
  const sourceUseRate = retrievedCount === 0
    ? 0
    : judgments.filter((judgment) => usedSourceIds.has(judgment.canonicalId) || usedSourceIds.has(judgment.sourceId.toLowerCase())).length / retrievedCount;
  const staleResultCount = judgments.filter((judgment) => judgment.stale).length;
  const irrelevantResultCount = judgments.filter((judgment) => !judgment.relevant).length;
  const keywordOverfitCount = judgments.filter((judgment) => judgment.keywordOverfit).length;
  const titleAbstractMismatchCount = judgments.filter((judgment) => judgment.titleAbstractMismatch).length;
  const statementEquivalenceTrapCount = judgments.filter((judgment) => judgment.statementEquivalenceTrap).length;
  const failures = retrievalFailures({
    precision,
    recall,
    citationValidity,
    sourceUseRate,
    staleResultCount,
    irrelevantResultCount,
    keywordOverfitCount,
    titleAbstractMismatchCount,
    statementEquivalenceTrapCount,
    hasExpectations: expectedRelevantIds.length > 0 || expectedTerms.length > 0,
    precisionThreshold: input.precisionThreshold ?? 0.6,
    recallThreshold: input.recallThreshold ?? 0.6,
    sourceUseThreshold: input.sourceUseThreshold ?? 0.5
  });
  return {
    query: input.query,
    evaluatedAt: new Date().toISOString(),
    expectedRelevantIds,
    expectedTerms,
    staleBefore,
    retrievedCount,
    relevantRetrieved,
    expectedRetrieved,
    precision,
    recall,
    citationValidity,
    sourceUseRate,
    staleResultCount,
    irrelevantResultCount,
    keywordOverfitCount,
    titleAbstractMismatchCount,
    statementEquivalenceTrapCount,
    judgments,
    failures,
    trustImpact: failures.length === 0 ? "none" : input.citationGrounding.ok ? "lower_trust" : "adversarial_review_required",
    canPromoteResearchBackedClaims: failures.length === 0
  };
}

export function retrievalOutageEvaluation(input: {
  query: string;
  provider?: "arxiv";
  message: string;
  evaluatedAt?: string;
}): RetrievalEvaluationResult {
  return {
    query: input.query,
    evaluatedAt: input.evaluatedAt ?? new Date().toISOString(),
    expectedRelevantIds: [],
    expectedTerms: [],
    retrievedCount: 0,
    relevantRetrieved: 0,
    expectedRetrieved: 0,
    precision: 0,
    recall: 0,
    citationValidity: 0,
    sourceUseRate: 0,
    staleResultCount: 0,
    irrelevantResultCount: 0,
    keywordOverfitCount: 0,
    titleAbstractMismatchCount: 0,
    statementEquivalenceTrapCount: 0,
    judgments: [],
    failures: ["search_outage"],
    trustImpact: "adversarial_review_required",
    canPromoteResearchBackedClaims: false,
    outage: {
      provider: input.provider ?? "arxiv",
      message: input.message,
      degradedTo: "partial_inconclusive"
    }
  };
}

export function findGoldenQuery(query: string): RetrievalGoldenQuery | undefined {
  const normalized = normalizeQuery(query);
  return GOLDEN_ARXIV_RETRIEVAL_QUERIES.find((golden) => normalizeQuery(golden.query) === normalized);
}

function judgeRecord(input: {
  record: GroundedSourceRecord;
  paper?: QuarantinedArxivPaper;
  expectedRelevantIds: string[];
  expectedTerms: string[];
  queryTerms: string[];
  staleBefore?: string;
}): RetrievalJudgment {
  const text = normalizeText([
    input.record.title,
    input.record.supportText,
    input.paper?.summaryPreview,
    input.paper?.categories.join(" ")
  ].filter(Boolean).join(" "));
  const idRelevant = input.expectedRelevantIds.includes(input.record.canonicalId);
  const termRelevant = input.expectedTerms.length > 0 && input.expectedTerms.every((term) => text.includes(normalizeText(term)));
  const stale = Boolean(input.staleBefore && input.record.updated && input.record.updated < input.staleBefore);
  const titleAbstractMismatch = Boolean(input.paper && titleAbstractMismatchDetected(input.record.title, input.paper.summaryPreview ?? input.record.supportText));
  const statementEquivalenceTrap = statementEquivalenceTrapDetected(input.record.supportText, input.queryTerms);
  const relevant = (idRelevant || termRelevant) && !stale && !titleAbstractMismatch && !statementEquivalenceTrap;
  const keywordOverlap = input.queryTerms.filter((term) => text.includes(term)).length;
  const keywordOverfit = !relevant && keywordOverlap > 0;
  const reasons = [
    idRelevant ? "matched expected arXiv id" : undefined,
    termRelevant ? "matched expected relevance terms" : undefined,
    stale ? `updated before stale cutoff ${input.staleBefore}` : undefined,
    titleAbstractMismatch ? "title and abstract/support text point to different mathematical subjects" : undefined,
    statementEquivalenceTrap ? "support text weakens the requested proof statement or scope" : undefined,
    keywordOverfit ? "matched query keywords without expected relevance" : undefined,
    !relevant && !keywordOverfit && !stale ? "did not match expected relevance evidence" : undefined
  ].filter((reason): reason is string => Boolean(reason));
  return {
    sourceId: input.record.sourceId,
    canonicalId: input.record.canonicalId,
    title: input.record.title,
    relevant,
    stale,
    keywordOverfit,
    titleAbstractMismatch,
    statementEquivalenceTrap,
    reasons
  };
}

function retrievalFailures(input: {
  precision: number;
  recall: number;
  citationValidity: number;
  sourceUseRate: number;
  staleResultCount: number;
  irrelevantResultCount: number;
  keywordOverfitCount: number;
  titleAbstractMismatchCount: number;
  statementEquivalenceTrapCount: number;
  hasExpectations: boolean;
  precisionThreshold: number;
  recallThreshold: number;
  sourceUseThreshold: number;
}): RetrievalEvaluationFailure[] {
  const failures: RetrievalEvaluationFailure[] = [];
  if (input.hasExpectations && input.precision < input.precisionThreshold) failures.push("low_precision");
  if (input.hasExpectations && input.recall < input.recallThreshold) failures.push("low_recall");
  if (input.citationValidity < 1) failures.push("invalid_citations");
  if (input.sourceUseRate < input.sourceUseThreshold) failures.push("low_source_use");
  if (input.staleResultCount > 0) failures.push("stale_results");
  if (input.hasExpectations && input.irrelevantResultCount > 0) failures.push("irrelevant_results");
  if (input.hasExpectations && input.keywordOverfitCount > 0) failures.push("keyword_overfit");
  if (input.titleAbstractMismatchCount > 0) failures.push("title_abstract_mismatch");
  if (input.statementEquivalenceTrapCount > 0) failures.push("statement_equivalence_trap");
  return failures;
}

function titleAbstractMismatchDetected(title: string, supportText: string): boolean {
  if (/^result for\b/i.test(title.trim())) return false;
  const titleTokens = meaningfulTokens(title);
  const supportTokens = meaningfulTokens(supportText);
  if (titleTokens.size < 2 || supportTokens.size < 4) return false;
  const overlap = [...titleTokens].filter((token) => supportTokens.has(token)).length;
  return overlap / titleTokens.size < 0.25;
}

function statementEquivalenceTrapDetected(supportText: string, queryTerms: string[]): boolean {
  const normalized = normalizeText(supportText);
  const asksForProof = queryTerms.some((term) => term === "prove" || term === "proof" || term === "solve" || term === "settle");
  if (!asksForProof) return false;
  return /\b(suggests?|heuristic|partial|analog(?:ue)?|assuming|conditional|experiment|numerical evidence)\b/.test(normalized) ||
    /\b(bounded|finite)\b.{0,40}\b(computation|search|experiment|analogue|analog)\b/.test(normalized);
}

function groundedCitationSourceIds(citationGrounding: CitationValidationResult): string[] {
  return citationGrounding.findings
    .filter((finding) => finding.status === "grounded" && finding.matchedSourceId)
    .map((finding) => finding.matchedSourceId!);
}

function queryTokens(query: string): string[] {
  return uniqueStrings(query
    .replace(/cat:[^\s]+/g, " ")
    .replace(/[^\w\s]+/g, " ")
    .split(/\s+/)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length >= 4 && token !== "all" && token !== "and"));
}

function normalizeQuery(query: string): string {
  return query.toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function meaningfulTokens(value: string): Set<string> {
  return new Set(normalizeText(value)
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter((token) =>
      token.length >= 4 &&
      !["theorem", "lemma", "paper", "proof", "using", "with", "between", "about"].includes(token)
    ));
}

function uniqueCanonicalIds(ids: string[]): string[] {
  return uniqueStrings(ids.map(canonicalizeArxivId).filter(Boolean));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}
