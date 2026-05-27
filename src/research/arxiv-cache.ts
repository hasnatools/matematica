import { createHash } from "node:crypto";
import { abortableSleep, throwIfAborted } from "../cancellation";
import type { Ledger } from "../ledger";
import { makeId, nowIso } from "../domain";
import { stableHash } from "../idempotency";
import { redactText } from "../redaction";
import { searchArxiv, type ArxivPaper } from "./arxiv";

export const ARXIV_CACHE_DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const ARXIV_SQLITE_LOCK_TTL_MS = 30_000;
const UNTRUSTED_CACHE_SECRET_PATTERNS = [
  /\b[A-Za-z0-9_-]*(?:token|secret|password|credential)[A-Za-z0-9_-]*-[A-Za-z0-9_-]{6,}\b/gi
];

export type ArxivCachePolicy = {
  cacheKey: string;
  query: string;
  maxResults: number;
  sortBy: "submittedDate";
  sortOrder: "descending";
  maxAgeMs: number;
};

export type ArxivCacheReadResult =
  | {
      status: "hit" | "stale";
      cacheKey: string;
      papers: ArxivPaper[];
      fetchedAt: string;
      staleAt: string;
      resultHash: string;
      freshness: Record<string, unknown>;
      queryExpansion: Record<string, unknown>;
      sourceSnapshotHashes: string[];
      retrievalQuality: Record<string, unknown>;
    }
  | {
      status: "miss";
      cacheKey: string;
    }
  | {
      status: "malformed";
      cacheKey: string;
      reason: string;
    };

export type ArxivFetchWithCacheResult = {
  papers: ArxivPaper[];
  cache: {
    cacheKey: string;
    status: "hit" | "stale" | "miss" | "malformed" | "refreshed";
    usedCache: boolean;
    liveNetworkUsed: boolean;
    stale: boolean;
    fetchedAt?: string;
    staleAt?: string;
    resultHash?: string;
    reason?: string;
    throttle?: ArxivThrottleAdmission;
  };
};

export type ArxivThrottleAdmission = {
  lockId: string;
  waitedMs: number;
  admittedAtMs: number;
  nextRequestAtMs: number;
  minIntervalMs: number;
};

export type ArxivCachePruneResult = {
  cache: "arxiv_query_cache";
  dryRun: boolean;
  cutoff: string;
  removedRows: number;
  removedCacheKeys: string[];
  policy: {
    scope: "stale_before_cutoff";
    preservesLedgerEventsAndArtifacts: true;
  };
};

type ArxivCacheRow = {
  cache_key: string;
  query: string;
  max_results: number;
  sort_by: string;
  sort_order: string;
  papers_json: string;
  result_hash: string;
  fetched_at: string;
  stale_at: string;
  freshness_json: string;
  query_expansion_json: string;
  source_snapshot_hashes_json: string;
  retrieval_quality_json: string;
};

type ArxivRuntimeStateRow = {
  next_request_at_ms: number;
  in_flight_lock_id: string | null;
  lock_expires_at_ms: number | null;
};

export function buildArxivCachePolicy(input: {
  query: string;
  maxResults: number;
  maxAgeMs?: number;
}): ArxivCachePolicy {
  const maxResults = Math.max(0, Math.floor(input.maxResults));
  const unsigned = {
    provider: "arxiv",
    query: input.query,
    maxResults,
    sortBy: "submittedDate" as const,
    sortOrder: "descending" as const
  };
  return {
    ...unsigned,
    maxAgeMs: input.maxAgeMs ?? ARXIV_CACHE_DEFAULT_MAX_AGE_MS,
    cacheKey: `arxiv_${stableHash(unsigned).slice(0, 40)}`
  };
}

export function readArxivCache(
  ledger: Ledger,
  policy: ArxivCachePolicy,
  nowMs = Date.now()
): ArxivCacheReadResult {
  const row = ledger.db.query("SELECT * FROM arxiv_query_cache WHERE cache_key = ?").get(policy.cacheKey) as ArxivCacheRow | null;
  if (!row) return { status: "miss", cacheKey: policy.cacheKey };
  try {
    const papers = parsePapers(row.papers_json);
    const resultHash = hashJson(papers);
    if (resultHash !== row.result_hash) {
      return {
        status: "malformed",
        cacheKey: policy.cacheKey,
        reason: "cached arXiv result hash does not match papers_json"
      };
    }
    const staleAtMs = Date.parse(row.stale_at);
    const base = {
      cacheKey: policy.cacheKey,
      papers,
      fetchedAt: row.fetched_at,
      staleAt: row.stale_at,
      resultHash: row.result_hash,
      freshness: parseRecord(row.freshness_json),
      queryExpansion: parseRecord(row.query_expansion_json),
      sourceSnapshotHashes: parseStringArray(row.source_snapshot_hashes_json),
      retrievalQuality: parseRecord(row.retrieval_quality_json)
    };
    return Number.isFinite(staleAtMs) && staleAtMs > nowMs
      ? { ...base, status: "hit" }
      : { ...base, status: "stale" };
  } catch (error) {
    return {
      status: "malformed",
      cacheKey: policy.cacheKey,
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}

export function writeArxivCache(input: {
  ledger: Ledger;
  policy: ArxivCachePolicy;
  papers: ArxivPaper[];
  fetchedAt?: string;
  queryExpansion?: Record<string, unknown>;
  sourceSnapshotHashes?: string[];
  retrievalQuality?: Record<string, unknown>;
}): ArxivCacheReadResult & { status: "hit" } {
  const fetchedAt = input.fetchedAt ?? nowIso();
  const staleAt = new Date(Date.parse(fetchedAt) + input.policy.maxAgeMs).toISOString();
  const papers = sanitizeArxivPapersForCache(input.papers);
  const resultHash = hashJson(papers);
  const freshness = {
    provider: "arxiv",
    fetchedAt,
    staleAt,
    maxAgeMs: input.policy.maxAgeMs,
    stale: false,
    policy: "latest-research-cache"
  };
  const redactedQuery = redactUntrustedCacheText(input.policy.query);
  const queryExpansion = input.queryExpansion ?? buildQueryExpansion(redactedQuery);
  const sourceSnapshotHashes = input.sourceSnapshotHashes ?? papers.map((paper) => paper.rawMetadataHash).filter(isString);
  const retrievalQuality = input.retrievalQuality ?? {
    status: "not_evaluated_at_cache_write",
    reason: "retrieval quality is persisted on source.results after quarantine and citation validation"
  };
  const now = nowIso();
  input.ledger.db.query(`
    INSERT INTO arxiv_query_cache (
      cache_key, query, max_results, sort_by, sort_order, papers_json, result_hash,
      fetched_at, stale_at, freshness_json, query_expansion_json,
      source_snapshot_hashes_json, retrieval_quality_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(cache_key) DO UPDATE SET
      papers_json = excluded.papers_json,
      result_hash = excluded.result_hash,
      fetched_at = excluded.fetched_at,
      stale_at = excluded.stale_at,
      freshness_json = excluded.freshness_json,
      query_expansion_json = excluded.query_expansion_json,
      source_snapshot_hashes_json = excluded.source_snapshot_hashes_json,
      retrieval_quality_json = excluded.retrieval_quality_json,
      updated_at = excluded.updated_at
  `).run(
    input.policy.cacheKey,
    redactedQuery,
    input.policy.maxResults,
    input.policy.sortBy,
    input.policy.sortOrder,
    JSON.stringify(papers),
    resultHash,
    fetchedAt,
    staleAt,
    JSON.stringify(freshness),
    JSON.stringify(queryExpansion),
    JSON.stringify(sourceSnapshotHashes),
    JSON.stringify(retrievalQuality),
    now,
    now
  );
  return {
    status: "hit",
    cacheKey: input.policy.cacheKey,
    papers,
    fetchedAt,
    staleAt,
    resultHash,
    freshness,
    queryExpansion,
    sourceSnapshotHashes,
    retrievalQuality
  };
}

export function updateArxivCacheReview(input: {
  ledger: Ledger;
  cacheKey: string;
  sourceSnapshotHashes?: string[];
  retrievalQuality?: Record<string, unknown>;
}): boolean {
  const row = input.ledger.db.query(`
    SELECT source_snapshot_hashes_json, retrieval_quality_json
    FROM arxiv_query_cache
    WHERE cache_key = ?
  `).get(input.cacheKey) as Pick<ArxivCacheRow, "source_snapshot_hashes_json" | "retrieval_quality_json"> | null;
  if (!row) return false;
  const sourceSnapshotHashes = input.sourceSnapshotHashes ?? parseStringArray(row.source_snapshot_hashes_json);
  const retrievalQuality = input.retrievalQuality ?? parseRecord(row.retrieval_quality_json);
  input.ledger.db.query(`
    UPDATE arxiv_query_cache
    SET source_snapshot_hashes_json = ?,
        retrieval_quality_json = ?,
        updated_at = ?
    WHERE cache_key = ?
  `).run(
    JSON.stringify(sourceSnapshotHashes),
    JSON.stringify(retrievalQuality),
    nowIso(),
    input.cacheKey
  );
  return true;
}

export function pruneArxivCache(input: {
  ledger: Ledger;
  olderThanHours: number;
  dryRun?: boolean;
  now?: Date;
}): ArxivCachePruneResult {
  if (!Number.isFinite(input.olderThanHours) || input.olderThanHours < 0) {
    throw new Error("--older-than-hours must be a non-negative number.");
  }
  const now = input.now ?? new Date();
  const cutoffMs = now.getTime() - input.olderThanHours * 60 * 60 * 1000;
  const cutoff = new Date(cutoffMs).toISOString();
  const rows = input.ledger.db.query(`
    SELECT cache_key
    FROM arxiv_query_cache
    WHERE stale_at <= ?
    ORDER BY stale_at, cache_key
  `).all(cutoff) as Array<{ cache_key: string }>;
  const removedCacheKeys = rows.map((row) => row.cache_key);
  if (!input.dryRun && removedCacheKeys.length > 0) {
    input.ledger.db.query(`
      DELETE FROM arxiv_query_cache
      WHERE stale_at <= ?
    `).run(cutoff);
  }
  return {
    cache: "arxiv_query_cache",
    dryRun: input.dryRun === true,
    cutoff,
    removedRows: removedCacheKeys.length,
    removedCacheKeys,
    policy: {
      scope: "stale_before_cutoff",
      preservesLedgerEventsAndArtifacts: true
    }
  };
}

export async function fetchArxivWithCache(input: {
  ledger: Ledger;
  query: string;
  maxResults: number;
  allowNetwork: boolean;
  search?: (query: string, options: { maxResults: number; abortSignal?: AbortSignal }) => Promise<ArxivPaper[]>;
  minIntervalMs?: number;
  maxAgeMs?: number;
  sleep?: (ms: number) => Promise<void>;
  abortSignal?: AbortSignal;
}): Promise<ArxivFetchWithCacheResult> {
  throwIfAborted(input.abortSignal, "arXiv cache fetch aborted before lookup.");
  const policy = buildArxivCachePolicy({
    query: input.query,
    maxResults: input.maxResults,
    maxAgeMs: input.maxAgeMs
  });
  const cached = readArxivCache(input.ledger, policy);
  if (cached.status === "hit" || (cached.status === "stale" && !input.allowNetwork)) {
    return {
      papers: cached.papers,
      cache: {
        cacheKey: policy.cacheKey,
        status: cached.status,
        usedCache: true,
        liveNetworkUsed: false,
        stale: cached.status === "stale",
        fetchedAt: cached.fetchedAt,
        staleAt: cached.staleAt,
        resultHash: cached.resultHash
      }
    };
  }
  if (!input.allowNetwork) {
    return {
      papers: [],
      cache: {
        cacheKey: policy.cacheKey,
        status: cached.status,
        usedCache: false,
        liveNetworkUsed: false,
        stale: cached.status === "stale",
        reason: cached.status === "malformed" ? cached.reason : "offline/local-only mode and no usable arXiv cache entry"
      }
    };
  }
  const throttle = await waitForArxivSqliteSlot(input.ledger, {
    minIntervalMs: input.minIntervalMs,
    sleep: input.sleep,
    abortSignal: input.abortSignal
  });
  try {
    throwIfAborted(input.abortSignal, "arXiv cache fetch aborted before live search.");
    const search = input.search ?? ((query, options) => searchArxiv(query, {
      maxResults: options.maxResults,
      minIntervalMs: 0,
      abortSignal: options.abortSignal
    }));
    const papers = await search(input.query, { maxResults: input.maxResults, abortSignal: input.abortSignal });
    const written = writeArxivCache({
      ledger: input.ledger,
      policy,
      papers
    });
    return {
      papers: written.papers,
      cache: {
        cacheKey: policy.cacheKey,
        status: "refreshed",
        usedCache: false,
        liveNetworkUsed: true,
        stale: false,
        fetchedAt: written.fetchedAt,
        staleAt: written.staleAt,
        resultHash: written.resultHash,
        throttle
      }
    };
  } finally {
    releaseArxivSqliteSlot(input.ledger, throttle.lockId);
  }
}

export async function waitForArxivSqliteSlot(inputLedger: Ledger, options: {
  minIntervalMs?: number;
  lockTtlMs?: number;
  sleep?: (ms: number) => Promise<void>;
  abortSignal?: AbortSignal;
} = {}): Promise<ArxivThrottleAdmission> {
  const minIntervalMs = options.minIntervalMs ?? 3_000;
  const lockTtlMs = options.lockTtlMs ?? ARXIV_SQLITE_LOCK_TTL_MS;
  const sleep = options.sleep ?? defaultSleep;
  const lockId = makeId("arxivlock");
  const startedAt = Date.now();
  while (true) {
    throwIfAborted(options.abortSignal, "arXiv throttle admission aborted.");
    const nowMs = Date.now();
    const admission = tryAcquireArxivSqliteSlot(inputLedger, {
      lockId,
      nowMs,
      minIntervalMs,
      lockTtlMs
    });
    if (admission.ok) {
      return {
        lockId,
        waitedMs: Math.max(0, nowMs - startedAt),
        admittedAtMs: nowMs,
        nextRequestAtMs: admission.nextRequestAtMs,
        minIntervalMs
      };
    }
    const waitMs = Math.max(1, Math.min(admission.waitMs, 250));
    if (options.abortSignal) await abortableSleep(waitMs, options.abortSignal);
    else await sleep(waitMs);
  }
}

export function releaseArxivSqliteSlot(ledger: Ledger, lockId: string): void {
  ledger.db.query(`
    UPDATE arxiv_runtime_state
    SET in_flight_lock_id = NULL,
        lock_expires_at_ms = NULL,
        updated_at = ?
    WHERE id = 'global' AND in_flight_lock_id = ?
  `).run(nowIso(), lockId);
}

function tryAcquireArxivSqliteSlot(
  ledger: Ledger,
  input: { lockId: string; nowMs: number; minIntervalMs: number; lockTtlMs: number }
): { ok: true; nextRequestAtMs: number } | { ok: false; waitMs: number } {
  return ledger.db.transaction(() => {
    ledger.db.query(`
      INSERT OR IGNORE INTO arxiv_runtime_state (
        id, next_request_at_ms, in_flight_lock_id, lock_expires_at_ms, updated_at
      ) VALUES ('global', 0, NULL, NULL, ?)
    `).run(nowIso());
    const row = ledger.db.query("SELECT next_request_at_ms, in_flight_lock_id, lock_expires_at_ms FROM arxiv_runtime_state WHERE id = 'global'")
      .get() as ArxivRuntimeStateRow;
    const lockActive = row.in_flight_lock_id && row.lock_expires_at_ms && row.lock_expires_at_ms > input.nowMs;
    if (lockActive) return { ok: false as const, waitMs: row.lock_expires_at_ms! - input.nowMs };
    const rateWaitMs = Math.max(0, row.next_request_at_ms - input.nowMs);
    if (rateWaitMs > 0) return { ok: false as const, waitMs: rateWaitMs };
    const nextRequestAtMs = input.nowMs + input.minIntervalMs;
    ledger.db.query(`
      UPDATE arxiv_runtime_state
      SET next_request_at_ms = ?,
          in_flight_lock_id = ?,
          lock_expires_at_ms = ?,
          updated_at = ?
      WHERE id = 'global'
    `).run(nextRequestAtMs, input.lockId, input.nowMs + input.lockTtlMs, nowIso());
    return { ok: true as const, nextRequestAtMs };
  })();
}

function buildQueryExpansion(query: string): Record<string, unknown> {
  const terms = query
    .split(/\s+/)
    .map((term) => term.replace(/^all:/, "").replace(/[()]/g, "").trim())
    .filter(Boolean);
  return {
    format: "matematica.arxiv-query-expansion",
    version: 1,
    originalQuery: query,
    normalizedTerms: [...new Set(terms)].slice(0, 64)
  };
}

function parsePapers(value: string): ArxivPaper[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) throw new Error("cached arXiv papers_json is not an array");
  return parsed.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`cached arXiv paper ${index + 1} is not an object`);
    }
    const record = item as Record<string, unknown>;
    if (!isString(record.id) || !isString(record.title) || !isString(record.summary)) {
      throw new Error(`cached arXiv paper ${index + 1} is missing id title or summary`);
    }
    return {
      id: record.id,
      title: record.title,
      summary: record.summary,
      authors: parseStringArrayValue(record.authors),
      published: isString(record.published) ? record.published : "",
      updated: isString(record.updated) ? record.updated : "",
      pdfUrl: isString(record.pdfUrl) ? record.pdfUrl : undefined,
      absUrl: isString(record.absUrl) ? record.absUrl : undefined,
      categories: parseStringArrayValue(record.categories),
      rawMetadataHash: isString(record.rawMetadataHash) ? record.rawMetadataHash : undefined
    };
  });
}

function sanitizeArxivPapersForCache(papers: ArxivPaper[]): ArxivPaper[] {
  return papers.map((paper) => ({
    id: redactUntrustedCacheText(paper.id),
    title: redactUntrustedCacheText(paper.title),
    summary: redactUntrustedCacheText(paper.summary),
    authors: paper.authors.map((author) => redactUntrustedCacheText(author)),
    published: redactUntrustedCacheText(paper.published),
    updated: redactUntrustedCacheText(paper.updated),
    pdfUrl: paper.pdfUrl ? redactUntrustedCacheText(paper.pdfUrl) : undefined,
    absUrl: paper.absUrl ? redactUntrustedCacheText(paper.absUrl) : undefined,
    categories: paper.categories.map((category) => redactUntrustedCacheText(category)),
    rawMetadataHash: paper.rawMetadataHash ? redactUntrustedCacheText(paper.rawMetadataHash) : undefined
  }));
}

function redactUntrustedCacheText(input: string): string {
  let output = redactText(input);
  for (const pattern of UNTRUSTED_CACHE_SECRET_PATTERNS) {
    output = output.replace(pattern, "<redacted>");
  }
  return output;
}

function parseRecord(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

function parseStringArray(value: string): string[] {
  return parseStringArrayValue(JSON.parse(value) as unknown);
}

function parseStringArrayValue(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(isString) : [];
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
