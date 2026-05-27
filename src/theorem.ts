import { stableHash } from "./idempotency";
import type { FormalizationAssessment } from "./evidence";

export type TheoremNormalization = {
  originalProblem: string;
  normalizedStatement: string;
  formalStatement: string;
  assumptions: string[];
  conclusion: string;
  ambiguityNotes: string[];
  statementDiffs: string[];
  status: FormalizationAssessment["status"];
  reviewerDisagreement: boolean;
};

export type MathlibTheoremTrustGrade =
  | "formal_statement_index_metadata"
  | "metadata_only_unverified_for_goal";

export type MathlibTheoremIndexEntry = {
  name: string;
  module: string;
  namespace: string;
  kind: "theorem" | "lemma";
  statement: string;
  summary: string;
  tags: string[];
  provenance: {
    source: "pinned-mathlib-index";
    mathlibRevision: string;
    lakeManifestHash: string;
  };
};

export type MathlibTheoremIndexSnapshot = {
  format: "matematica.mathlib-theorem-index";
  version: 1;
  indexVersion: string;
  mathlibRevision: string;
  lakeManifestHash: string;
  generatedAt: string;
  entries: Array<MathlibTheoremIndexEntry & { statementHash: string }>;
  indexHash: string;
};

export type MathlibLemmaSearchResult = {
  name: string;
  module: string;
  namespace: string;
  kind: "theorem" | "lemma";
  statementHash: string;
  summary: string;
  tags: string[];
  relevanceScore: number;
  trustGrade: MathlibTheoremTrustGrade;
  provenance: {
    source: "pinned-mathlib-index";
    indexVersion: string;
    indexHash: string;
    mathlibRevision: string;
    lakeManifestHash: string;
  };
  promptSummary: {
    theoremName: string;
    module: string;
    statementHash: string;
    summary: string;
    trustGrade: MathlibTheoremTrustGrade;
    proofSupport: false;
  };
};

export type MathlibLemmaRetrieval = {
  format: "matematica.mathlib-lemma-retrieval";
  version: 1;
  query: string;
  queryHash: string;
  indexVersion: string;
  indexHash: string;
  mathlibRevision: string;
  lakeManifestHash: string;
  retrievedAt: string;
  maxResults: number;
  count: number;
  trust: {
    sourceTextTrusted: false;
    quarantine: true;
    proofSupport: false;
    controlsAffected: false;
  };
  results: MathlibLemmaSearchResult[];
};

const DEFAULT_MATHLIB_INDEX_VERSION = "mathlib-index-2026-05-25-v1";
const DEFAULT_MATHLIB_REVISION = "mathlib4-pinned-2026-05-25";
const DEFAULT_LAKE_MANIFEST_HASH = "lake-manifest-mathlib-pinned-2026-05-25";

const DEFAULT_MATHLIB_ENTRIES: MathlibTheoremIndexEntry[] = [
  entry({
    name: "Nat.add_comm",
    module: "Mathlib.Data.Nat.Basic",
    namespace: "Nat",
    kind: "theorem",
    statement: "theorem Nat.add_comm (n m : Nat) : n + m = m + n",
    summary: "Addition on natural numbers is commutative.",
    tags: ["natural", "nat", "addition", "commutative", "arithmetic"]
  }),
  entry({
    name: "Nat.add_assoc",
    module: "Mathlib.Data.Nat.Basic",
    namespace: "Nat",
    kind: "theorem",
    statement: "theorem Nat.add_assoc (a b c : Nat) : (a + b) + c = a + (b + c)",
    summary: "Addition on natural numbers is associative.",
    tags: ["natural", "nat", "addition", "associative", "arithmetic"]
  }),
  entry({
    name: "Nat.mul_comm",
    module: "Mathlib.Data.Nat.Basic",
    namespace: "Nat",
    kind: "theorem",
    statement: "theorem Nat.mul_comm (n m : Nat) : n * m = m * n",
    summary: "Multiplication on natural numbers is commutative.",
    tags: ["natural", "nat", "multiplication", "commutative", "arithmetic"]
  }),
  entry({
    name: "Nat.succ_eq_add_one",
    module: "Mathlib.Data.Nat.Basic",
    namespace: "Nat",
    kind: "theorem",
    statement: "theorem Nat.succ_eq_add_one (n : Nat) : Nat.succ n = n + 1",
    summary: "The successor of a natural number is adding one.",
    tags: ["natural", "nat", "successor", "one", "addition"]
  }),
  entry({
    name: "Nat.one_add_one_eq_two",
    module: "Mathlib.Data.Nat.Basic",
    namespace: "Nat",
    kind: "theorem",
    statement: "theorem Nat.one_add_one_eq_two : (1 : Nat) + 1 = 2",
    summary: "The canonical natural-number computation one plus one equals two.",
    tags: ["natural", "nat", "one", "two", "addition", "computation"]
  }),
  entry({
    name: "Int.add_comm",
    module: "Mathlib.Data.Int.Basic",
    namespace: "Int",
    kind: "theorem",
    statement: "theorem Int.add_comm (a b : Int) : a + b = b + a",
    summary: "Addition on integers is commutative.",
    tags: ["integer", "int", "addition", "commutative", "arithmetic"]
  })
];

export function defaultMathlibTheoremIndexSnapshot(): MathlibTheoremIndexSnapshot {
  return buildMathlibTheoremIndexSnapshot({
    indexVersion: DEFAULT_MATHLIB_INDEX_VERSION,
    mathlibRevision: DEFAULT_MATHLIB_REVISION,
    lakeManifestHash: DEFAULT_LAKE_MANIFEST_HASH,
    generatedAt: "2026-05-25T00:00:00.000Z",
    entries: DEFAULT_MATHLIB_ENTRIES
  });
}

export function buildMathlibTheoremIndexSnapshot(input: {
  indexVersion: string;
  mathlibRevision: string;
  lakeManifestHash: string;
  generatedAt: string;
  entries: MathlibTheoremIndexEntry[];
}): MathlibTheoremIndexSnapshot {
  const entries = input.entries.map((item) => ({
    ...item,
    statementHash: stableHash({
      name: item.name,
      module: item.module,
      statement: item.statement,
      mathlibRevision: input.mathlibRevision
    })
  }));
  const indexForHash = {
    format: "matematica.mathlib-theorem-index",
    version: 1,
    indexVersion: input.indexVersion,
    mathlibRevision: input.mathlibRevision,
    lakeManifestHash: input.lakeManifestHash,
    generatedAt: input.generatedAt,
    entries
  } as const;
  return {
    ...indexForHash,
    indexHash: stableHash(indexForHash)
  };
}

export function retrieveMathlibLemmas(input: {
  problem: string;
  goal: string;
  maxResults?: number;
  index?: MathlibTheoremIndexSnapshot;
  now?: Date;
}): MathlibLemmaRetrieval {
  const index = input.index ?? defaultMathlibTheoremIndexSnapshot();
  const maxResults = Math.max(1, Math.floor(input.maxResults ?? 5));
  const query = normalizeWhitespace(`${input.problem} ${input.goal}`);
  const queryTokens = importantTokens(query.toLowerCase());
  const results = index.entries
    .map((lemma) => ({
      lemma,
      score: lemmaScore(lemma, queryTokens, query.toLowerCase())
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.lemma.name.localeCompare(right.lemma.name))
    .slice(0, maxResults)
    .map(({ lemma, score }) => ({
      name: lemma.name,
      module: lemma.module,
      namespace: lemma.namespace,
      kind: lemma.kind,
      statementHash: lemma.statementHash,
      summary: lemma.summary,
      tags: lemma.tags,
      relevanceScore: score,
      trustGrade: "formal_statement_index_metadata" as const,
      provenance: {
        source: "pinned-mathlib-index" as const,
        indexVersion: index.indexVersion,
        indexHash: index.indexHash,
        mathlibRevision: index.mathlibRevision,
        lakeManifestHash: index.lakeManifestHash
      },
      promptSummary: {
        theoremName: lemma.name,
        module: lemma.module,
        statementHash: lemma.statementHash,
        summary: lemma.summary,
        trustGrade: "formal_statement_index_metadata" as const,
        proofSupport: false as const
      }
    }));

  return {
    format: "matematica.mathlib-lemma-retrieval",
    version: 1,
    query,
    queryHash: stableHash(query),
    indexVersion: index.indexVersion,
    indexHash: index.indexHash,
    mathlibRevision: index.mathlibRevision,
    lakeManifestHash: index.lakeManifestHash,
    retrievedAt: (input.now ?? new Date()).toISOString(),
    maxResults,
    count: results.length,
    trust: {
      sourceTextTrusted: false,
      quarantine: true,
      proofSupport: false,
      controlsAffected: false
    },
    results
  };
}

export function normalizeTheoremCandidate(input: {
  originalProblem: string;
  formalStatement: string;
}): TheoremNormalization {
  const originalProblem = normalizeWhitespace(input.originalProblem);
  const normalizedStatement = normalizeInformalStatement(originalProblem);
  const formalStatement = normalizeWhitespace(input.formalStatement);
  const formalParts = parseFormalStatement(formalStatement);
  const informalAssumptions = inferInformalAssumptions(normalizedStatement);
  const ambiguityNotes = inferAmbiguities(normalizedStatement, formalStatement, formalParts);
  const statementDiffs = inferStatementDiffs(normalizedStatement, informalAssumptions, formalParts);
  const status = classifyEquivalence(statementDiffs, ambiguityNotes);

  return {
    originalProblem,
    normalizedStatement,
    formalStatement,
    assumptions: [...informalAssumptions, ...formalParts.assumptions.map((item) => `formal: ${item}`)],
    conclusion: formalParts.conclusion || normalizedStatement,
    ambiguityNotes,
    statementDiffs,
    status,
    reviewerDisagreement: statementDiffs.length > 0 || status === "unknown"
  };
}

type ParsedFormalStatement = {
  kind?: string;
  name?: string;
  signature: string;
  assumptions: string[];
  conclusion: string;
};

function normalizeInformalStatement(problem: string): string {
  return problem
    .replace(/^\s*(prove|show|show that|find a proof of|find a proof that)\s+/i, "")
    .replace(/\.$/, "")
    .trim();
}

function parseFormalStatement(statement: string): ParsedFormalStatement {
  const header = statement.match(/\b(theorem|lemma|example)\s+([A-Za-z0-9_'.]+)?\s*:/);
  const signature = extractSignature(statement);
  const parts = signature
    .split(/\s*(?:->|→)\s*/u)
    .map((part) => normalizeWhitespace(part))
    .filter(Boolean);
  const assumptions = parts.length > 1 ? parts.slice(0, -1) : [];
  const conclusion = parts.at(-1) ?? signature;

  return {
    kind: header?.[1],
    name: header?.[2],
    signature,
    assumptions,
    conclusion
  };
}

function extractSignature(statement: string): string {
  const afterColon = statement.includes(":") ? statement.slice(statement.indexOf(":") + 1) : statement;
  return normalizeWhitespace(afterColon
    .replace(/\s*:=\s*[\s\S]*$/u, "")
    .replace(/\s+by\s+[\s\S]*$/u, ""));
}

function inferInformalAssumptions(statement: string): string[] {
  const assumptions: string[] = [];
  const conditional = statement.match(/\b(if|assuming|given|where)\b([\s\S]*?)(?:,|\bthen\b)/i);
  if (conditional?.[2]) assumptions.push(normalizeWhitespace(conditional[2]));
  const every = statement.match(/\b(every|all|for all)\s+([^,.;]+)/i);
  if (every?.[0]) assumptions.push(`universal: ${normalizeWhitespace(every[0])}`);
  return assumptions;
}

function inferAmbiguities(
  normalizedStatement: string,
  formalStatement: string,
  formalParts: ParsedFormalStatement
): string[] {
  const notes: string[] = [];
  if (!formalParts.kind) notes.push("formal statement is not introduced with theorem, lemma, or example");
  if (!formalParts.name) notes.push("formal statement has no parsed theorem name");
  if (!formalStatement.includes(":")) notes.push("formal statement has no explicit type signature");
  return notes;
}

function inferStatementDiffs(
  normalizedStatement: string,
  informalAssumptions: string[],
  formalParts: ParsedFormalStatement
): string[] {
  const diffs: string[] = [];
  const normalizedLower = normalizedStatement.toLowerCase();
  const signatureLower = formalParts.signature.toLowerCase();
  const conclusionLower = formalParts.conclusion.toLowerCase();

  if (conclusionLower === "true" && !/\btrue\b/i.test(normalizedStatement)) {
    diffs.push("formal statement proves True instead of the requested conclusion");
  }

  if (formalParts.assumptions.length > informalAssumptions.filter((item) => !item.startsWith("universal:")).length) {
    diffs.push(`formal statement adds assumptions: ${formalParts.assumptions.join("; ")}`);
  }

  if (/\b(every|all|for all)\b/i.test(normalizedStatement) && !/\b(forall|∀)\b/u.test(formalParts.signature)) {
    diffs.push("informal statement is universal but formal statement has no parsed universal quantifier");
  }

  if (/\bnatural number|nat\b/i.test(normalizedStatement) && !/\b(nat|ℕ)\b/iu.test(signatureLower)) {
    diffs.push("informal statement refers to natural numbers but formal statement has no parsed Nat domain");
  }

  const informalTokens = importantTokens(normalizedLower);
  const conclusionTokens = importantTokens(conclusionLower);
  const missingTokens = informalTokens.filter((token) => !signatureLower.includes(token) && !conclusionTokens.includes(token));
  if (missingTokens.length > 0) {
    diffs.push(`formal statement may omit key terms from problem: ${missingTokens.slice(0, 6).join(", ")}`);
  }

  return Array.from(new Set(diffs));
}

function classifyEquivalence(
  statementDiffs: string[],
  ambiguityNotes: string[]
): FormalizationAssessment["status"] {
  if (statementDiffs.length === 0 && ambiguityNotes.length === 0) return "equivalent";
  if (statementDiffs.some((diff) => diff.includes("adds assumptions") || diff.includes("proves True"))) return "weakened";
  if (statementDiffs.length > 0) return "mismatch";
  return "unknown";
}

function importantTokens(text: string): string[] {
  const stop = new Set([
    "a",
    "an",
    "and",
    "are",
    "be",
    "by",
    "every",
    "for",
    "has",
    "have",
    "if",
    "is",
    "it",
    "n",
    "natural",
    "number",
    "of",
    "or",
    "prove",
    "property",
    "show",
    "that",
    "the",
    "then",
    "to",
    "with"
  ]);
  return Array.from(new Set(text.match(/[a-z][a-z0-9_']*/gi) ?? []))
    .map((token) => token.toLowerCase())
    .filter((token) => token.length > 2 && !stop.has(token));
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function entry(input: Omit<MathlibTheoremIndexEntry, "provenance">): MathlibTheoremIndexEntry {
  return {
    ...input,
    provenance: {
      source: "pinned-mathlib-index",
      mathlibRevision: DEFAULT_MATHLIB_REVISION,
      lakeManifestHash: DEFAULT_LAKE_MANIFEST_HASH
    }
  };
}

function lemmaScore(lemma: MathlibTheoremIndexSnapshot["entries"][number], queryTokens: string[], queryLower: string): number {
  const haystack = [
    lemma.name,
    lemma.module,
    lemma.namespace,
    lemma.statement,
    lemma.summary,
    ...lemma.tags
  ].join(" ").toLowerCase();
  let score = 0;
  for (const token of queryTokens) {
    if (haystack.includes(token)) score += lemma.tags.includes(token) ? 3 : 1;
  }
  if (
    /1\s*\+\s*1\s*=\s*2/.test(queryLower) &&
    (lemma.name === "Nat.one_add_one_eq_two" || lemma.summary.toLowerCase().includes("one plus one equals two"))
  ) {
    score += 10;
  }
  if (queryTokens.some((token) => token === "prove" || token === "proof")) score += 0.25;
  return score;
}
