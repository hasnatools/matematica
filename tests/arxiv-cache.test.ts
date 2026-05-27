import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../src/ledger";
import { getAppPaths } from "../src/paths";
import type { ArxivPaper } from "../src/research/arxiv";
import {
  buildArxivCachePolicy,
  fetchArxivWithCache,
  readArxivCache,
  releaseArxivSqliteSlot,
  updateArxivCacheReview,
  waitForArxivSqliteSlot,
  writeArxivCache
} from "../src/research/arxiv-cache";

const homes: string[] = [];

function setupLedger(): Ledger {
  const home = mkdtempSync(join(tmpdir(), "matematica-arxiv-cache-test-"));
  homes.push(home);
  process.env.MATEMATICA_HOME = home;
  return new Ledger(getAppPaths().dbPath);
}

afterEach(() => {
  delete process.env.MATEMATICA_HOME;
  while (homes.length > 0) {
    rmSync(homes.pop()!, { recursive: true, force: true });
  }
});

test("arXiv latest cache hit avoids live network even when online is allowed", async () => {
  const ledger = setupLedger();
  try {
    let calls = 0;
    const first = await fetchArxivWithCache({
      ledger,
      query: "all:lean",
      maxResults: 2,
      allowNetwork: true,
      minIntervalMs: 1,
      search: async () => {
        calls += 1;
        return [paper("http://arxiv.org/abs/2401.00001v1", "Lean paper")];
      }
    });
    const second = await fetchArxivWithCache({
      ledger,
      query: "all:lean",
      maxResults: 2,
      allowNetwork: true,
      search: async () => {
        calls += 1;
        throw new Error("fresh cache should avoid live arXiv search");
      }
    });

    expect(calls).toBe(1);
    expect(first.cache.status).toBe("refreshed");
    expect(first.cache.liveNetworkUsed).toBe(true);
    expect(second.cache.status).toBe("hit");
    expect(second.cache.usedCache).toBe(true);
    expect(second.cache.liveNetworkUsed).toBe(false);
    expect(second.papers[0].title).toBe("Lean paper");
  } finally {
    ledger.close();
  }
});

test("stale arXiv cache is used offline with explicit stale provenance", async () => {
  const ledger = setupLedger();
  try {
    const policy = buildArxivCachePolicy({ query: "all:old", maxResults: 1, maxAgeMs: 1 });
    writeArxivCache({
      ledger,
      policy,
      fetchedAt: "2024-01-01T00:00:00.000Z",
      papers: [paper("http://arxiv.org/abs/2401.00002v1", "Old paper")]
    });

    const result = await fetchArxivWithCache({
      ledger,
      query: "all:old",
      maxResults: 1,
      allowNetwork: false,
      maxAgeMs: 1,
      search: async () => {
        throw new Error("offline cache fallback must not call live search");
      }
    });

    expect(result.cache.status).toBe("stale");
    expect(result.cache.usedCache).toBe(true);
    expect(result.cache.stale).toBe(true);
    expect(result.cache.liveNetworkUsed).toBe(false);
    expect(result.papers[0].title).toBe("Old paper");
  } finally {
    ledger.close();
  }
});

test("malformed arXiv cache is refused offline and never treated as usable research", async () => {
  const ledger = setupLedger();
  try {
    const policy = buildArxivCachePolicy({ query: "all:broken", maxResults: 1 });
    writeArxivCache({
      ledger,
      policy,
      papers: [paper("http://arxiv.org/abs/2401.00003v1", "Broken paper")]
    });
    ledger.db.query("UPDATE arxiv_query_cache SET result_hash = ? WHERE cache_key = ?")
      .run("not-the-real-hash", policy.cacheKey);

    expect(readArxivCache(ledger, policy)).toMatchObject({
      status: "malformed",
      cacheKey: policy.cacheKey
    });

    const result = await fetchArxivWithCache({
      ledger,
      query: "all:broken",
      maxResults: 1,
      allowNetwork: false,
      search: async () => {
        throw new Error("offline malformed cache must not call live search");
      }
    });

    expect(result.papers).toEqual([]);
    expect(result.cache.status).toBe("malformed");
    expect(result.cache.usedCache).toBe(false);
    expect(result.cache.liveNetworkUsed).toBe(false);
    expect(result.cache.reason).toContain("hash");
  } finally {
    ledger.close();
  }
});

test("arXiv SQLite throttle serializes admission across ledger connections", async () => {
  const firstLedger = setupLedger();
  const secondLedger = new Ledger(getAppPaths().dbPath);
  try {
    const first = await waitForArxivSqliteSlot(firstLedger, { minIntervalMs: 50 });
    const started = Date.now();
    const secondAdmission = waitForArxivSqliteSlot(secondLedger, { minIntervalMs: 50 });
    await sleep(5);
    releaseArxivSqliteSlot(firstLedger, first.lockId);
    const second = await secondAdmission;

    expect(second.lockId).not.toBe(first.lockId);
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
    releaseArxivSqliteSlot(secondLedger, second.lockId);
  } finally {
    firstLedger.close();
    secondLedger.close();
  }
});

test("arXiv SQLite throttle honors AbortSignal while waiting for admission", async () => {
  const firstLedger = setupLedger();
  const secondLedger = new Ledger(getAppPaths().dbPath);
  try {
    const first = await waitForArxivSqliteSlot(firstLedger, { minIntervalMs: 5_000 });
    const controller = new AbortController();
    const waiting = waitForArxivSqliteSlot(secondLedger, {
      minIntervalMs: 5_000,
      abortSignal: controller.signal
    });
    setTimeout(() => controller.abort(new Error("operator cancelled arXiv throttle wait")), 20);

    await expect(waiting).rejects.toThrow("operator cancelled arXiv throttle wait");
    releaseArxivSqliteSlot(firstLedger, first.lockId);
  } finally {
    firstLedger.close();
    secondLedger.close();
  }
});

test("fetchArxivWithCache propagates AbortSignal into injected live search", async () => {
  const ledger = setupLedger();
  try {
    const controller = new AbortController();
    const call = fetchArxivWithCache({
      ledger,
      query: "all:abort",
      maxResults: 1,
      allowNetwork: true,
      minIntervalMs: 1,
      abortSignal: controller.signal,
      search: async (_query, options) => {
        expect(options.abortSignal).toBe(controller.signal);
        if (controller.signal.aborted) throw controller.signal.reason;
        return await new Promise<ArxivPaper[]>((_resolve, reject) => {
          controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
        });
      }
    });

    setTimeout(() => controller.abort(new Error("operator cancelled cached arXiv fetch")), 20);
    await expect(call).rejects.toThrow("operator cancelled cached arXiv fetch");
  } finally {
    ledger.close();
  }
});

test("arXiv cache review metadata persists retrieval quality and source snapshots", () => {
  const ledger = setupLedger();
  try {
    const policy = buildArxivCachePolicy({ query: "all:quality", maxResults: 1 });
    writeArxivCache({
      ledger,
      policy,
      papers: [paper("http://arxiv.org/abs/2401.00004v1", "Quality paper")]
    });

    expect(updateArxivCacheReview({
      ledger,
      cacheKey: policy.cacheKey,
      sourceSnapshotHashes: ["snapshot-hash"],
      retrievalQuality: { precision: 1, recall: 1, canPromoteResearchBackedClaims: true }
    })).toBe(true);

    const cached = readArxivCache(ledger, policy);
    expect(cached.status).toBe("hit");
    if (cached.status === "hit") {
      expect(cached.sourceSnapshotHashes).toEqual(["snapshot-hash"]);
      expect(cached.retrievalQuality).toMatchObject({
        precision: 1,
        recall: 1,
        canPromoteResearchBackedClaims: true
      });
    }
  } finally {
    ledger.close();
  }
});

test("arXiv cache redacts token-shaped untrusted metadata without relying on process env", () => {
  const ledger = setupLedger();
  try {
    const token = "env-token-canary-123456789";
    const urlToken = "url-token-canary-123456789";
    const policy = buildArxivCachePolicy({ query: `all:${token}`, maxResults: 1 });
    writeArxivCache({
      ledger,
      policy,
      papers: [{
        ...paper("paper-secret-canary-123456", `Title ${token}`),
        summary: `Abstract ${token}`,
        absUrl: `https://example.test/abs?token=${urlToken}`,
        pdfUrl: `https://example.test/pdf?api_key=${urlToken}`
      }]
    });

    const row = ledger.db.query("SELECT query, papers_json, query_expansion_json FROM arxiv_query_cache WHERE cache_key = ?")
      .get(policy.cacheKey) as { query: string; papers_json: string; query_expansion_json: string };
    const persisted = JSON.stringify(row);
    expect(persisted).not.toContain(token);
    expect(persisted).not.toContain(urlToken);
    expect(persisted).toContain("<redacted>");
  } finally {
    ledger.close();
  }
});

function paper(id: string, title: string): ArxivPaper {
  return {
    id,
    title,
    summary: "A bounded metadata summary.",
    authors: ["Ada"],
    published: "2024-01-01T00:00:00Z",
    updated: "2024-01-01T00:00:00Z",
    absUrl: id.replace("http://", "https://"),
    categories: ["math.LO"],
    rawMetadataHash: `${title.toLowerCase().replace(/\W+/g, "-")}-raw`
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
