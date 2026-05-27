import { afterEach, expect, test } from "bun:test";
import {
  ARXIV_MAX_RESPONSE_BYTES,
  arxivCompliancePolicy,
  arxivUserAgent,
  buildArxivSearchUrl,
  parseArxivFeed,
  resetArxivPoliteState,
  searchArxiv
} from "../src/research/arxiv";
import { buildArxivFreshnessSnapshot } from "../src/freshness";

const sampleFeed = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2401.00001v1</id>
    <updated>2024-01-01T00:00:00Z</updated>
    <published>2024-01-01T00:00:00Z</published>
    <title> A  Proof  About  Primes </title>
    <summary>
      We prove A &amp; B using Lean.
    </summary>
    <author><name>Ada Lovelace</name></author>
    <author><name>Emmy Noether</name></author>
    <category term="math.NT" />
    <link href="http://arxiv.org/abs/2401.00001v1" rel="alternate" type="text/html"/>
    <link title="pdf" href="http://arxiv.org/pdf/2401.00001v1" rel="related" type="application/pdf"/>
  </entry>
</feed>`;

afterEach(() => {
  resetArxivPoliteState();
  delete process.env.MATEMATICA_ARXIV_CONTACT;
});

test("builds arXiv API URL with submitted-date sorting", () => {
  const url = buildArxivSearchUrl("cat:math.NT AND all:prime", { maxResults: 3, start: 2 });
  expect(url).toContain("search_query=cat%3Amath.NT+AND+all%3Aprime");
  expect(url).toContain("max_results=3");
  expect(url).toContain("start=2");
  expect(url).toContain("sortBy=submittedDate");
  expect(url).toContain("sortOrder=descending");
});

test("parses arXiv Atom feed entries", () => {
  const papers = parseArxivFeed(sampleFeed);
  expect(papers).toHaveLength(1);
  expect(papers[0].title).toBe("A Proof About Primes");
  expect(papers[0].summary).toBe("We prove A & B using Lean.");
  expect(papers[0].authors).toEqual(["Ada Lovelace", "Emmy Noether"]);
  expect(papers[0].categories).toEqual(["math.NT"]);
  expect(papers[0].pdfUrl).toBe("http://arxiv.org/pdf/2401.00001v1");
  expect(papers[0].rawMetadataHash).toMatch(/^[a-f0-9]{64}$/);
});

test("searchArxiv uses injectable fetcher", async () => {
  let userAgent = "";
  const papers = await searchArxiv("all:lean", {
    maxResults: 1,
    fetcher: async (_url, init) => {
      userAgent = new Headers(init?.headers).get("User-Agent") ?? "";
      return new Response(sampleFeed, { status: 200 });
    }
  });

  expect(papers[0].id).toBe("http://arxiv.org/abs/2401.00001v1");
  expect(userAgent).toBe("matematica-cli/0.0.1");
});

test("searchArxiv propagates AbortSignal into live fetches", async () => {
  const controller = new AbortController();
  const call = searchArxiv("all:abort", {
    maxResults: 1,
    abortSignal: controller.signal,
    fetcher: async (_url, init) => {
      expect(init?.signal).toBe(controller.signal);
      return await new Promise<Response>((_resolve, reject) => {
        controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
      });
    }
  });

  controller.abort(new Error("operator cancelled arXiv search"));
  await expect(call).rejects.toThrow("operator cancelled arXiv search");
});

test("searchArxiv rejects oversized responses before XML parsing", async () => {
  await expect(searchArxiv("all:oversized", {
    maxResults: 1,
    maxResponseBytes: 12,
    fetcher: async () => new Response(sampleFeed, { status: 200 })
  })).rejects.toThrow("max response bytes");
});

test("parseArxivFeed rejects XML entities declarations and malformed feeds", () => {
  const withEntity = `<?xml version="1.0"?><!DOCTYPE feed [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><feed />`;
  expect(() => parseArxivFeed(withEntity)).toThrow("DOCTYPE and ENTITY");
  expect(() => parseArxivFeed("<feed><entry><id>x</id></feed>")).toThrow("closing tag feed does not match entry");
  expect(() => parseArxivFeed("<not-feed />")).toThrow("missing feed root");
});

test("parseArxivFeed enforces max field sizes and typed required fields", () => {
  const longTitle = "A".repeat(16);
  const invalid = sampleFeed.replace(" A  Proof  About  Primes ", longTitle);
  expect(() => parseArxivFeed(invalid, { fieldLimits: { title: 8 } })).toThrow("title exceeds max field size");
  expect(() => parseArxivFeed(sampleFeed.replace("<id>http://arxiv.org/abs/2401.00001v1</id>", ""))).toThrow("missing required id");
});

test("parseArxivFeed handles namespaced Atom tags without regex feed matching", () => {
  const namespaced = sampleFeed
    .replace("<feed xmlns=\"http://www.w3.org/2005/Atom\">", "<atom:feed xmlns:atom=\"http://www.w3.org/2005/Atom\">")
    .replace("</feed>", "</atom:feed>")
    .replaceAll("<entry>", "<atom:entry>")
    .replaceAll("</entry>", "</atom:entry>");
  expect(parseArxivFeed(namespaced)[0].title).toBe("A Proof About Primes");
});

test("arxiv compliance policy includes user agent contact rate limit and redistribution boundaries", () => {
  process.env.MATEMATICA_ARXIV_CONTACT = "ops@example.test";
  expect(arxivUserAgent()).toBe("matematica-cli/0.0.1 (ops@example.test)");
  expect(arxivCompliancePolicy()).toMatchObject({
    termsUrl: "https://info.arxiv.org/help/api/tou.html",
    maxConnections: 1,
    minIntervalMs: 3000,
    userAgent: "matematica-cli/0.0.1 (ops@example.test)",
    metadataRedistribution: "allowed",
    pdfAndSourceRedistribution: "not_exported_without_license"
  });
});

test("arxiv freshness snapshot captures terms provenance and replay fallback", () => {
  const snapshot = buildArxivFreshnessSnapshot();

  expect(snapshot.surface).toBe("arxiv-api");
  expect(snapshot.sourceUrls).toContain("https://info.arxiv.org/help/api/tou.html");
  expect(snapshot.evidence.minIntervalMs).toBe(3000);
  expect(snapshot.replayFallback).toContain("saved arXiv response artifact");
  expect(snapshot.snapshotHash.length).toBeGreaterThan(0);
  expect(ARXIV_MAX_RESPONSE_BYTES).toBeGreaterThan(1024);
});

test("searchArxiv serializes requests through the polite-use limiter", async () => {
  let active = 0;
  let maxActive = 0;
  const startedAt: number[] = [];

  await Promise.all([
    searchArxiv("all:first", {
      maxResults: 1,
      minIntervalMs: 15,
      fetcher: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        startedAt.push(Date.now());
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return new Response(sampleFeed, { status: 200 });
      }
    }),
    searchArxiv("all:second", {
      maxResults: 1,
      minIntervalMs: 15,
      fetcher: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        startedAt.push(Date.now());
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return new Response(sampleFeed, { status: 200 });
      }
    })
  ]);

  expect(maxActive).toBe(1);
  expect(startedAt).toHaveLength(2);
  expect(startedAt[1] - startedAt[0]).toBeGreaterThanOrEqual(10);
});
