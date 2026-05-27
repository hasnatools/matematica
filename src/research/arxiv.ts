import { createHash } from "node:crypto";
import { abortableSleep, abortableWait, throwIfAborted } from "../cancellation";
import { matematicaPackageVersion } from "../package-info";

export type ArxivPaper = {
  id: string;
  title: string;
  summary: string;
  authors: string[];
  published: string;
  updated: string;
  pdfUrl?: string;
  absUrl?: string;
  categories: string[];
  citations?: string[];
  bibtex?: string;
  pdfText?: string;
  theoremStatements?: string[];
  toolOutputSummaries?: string[];
  crossAgentSummaries?: string[];
  rawMetadataHash?: string;
};

export type ArxivSearchOptions = {
  maxResults?: number;
  start?: number;
  fetcher?: (url: string, init?: RequestInit) => Promise<Response>;
  minIntervalMs?: number;
  contact?: string;
  maxResponseBytes?: number;
  fieldLimits?: Partial<ArxivFieldLimits>;
  abortSignal?: AbortSignal;
};

const ARXIV_API = "https://export.arxiv.org/api/query";
export const ARXIV_POLITE_MIN_INTERVAL_MS = 3_000;
export const ARXIV_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
let arxivQueue: Promise<void> = Promise.resolve();
let lastArxivRequestAt = 0;

export type ArxivFieldLimits = {
  id: number;
  title: number;
  summary: number;
  author: number;
  authors: number;
  url: number;
  date: number;
  categories: number;
  category: number;
  entries: number;
};

const DEFAULT_FIELD_LIMITS: ArxivFieldLimits = {
  id: 512,
  title: 1_024,
  summary: 12_000,
  author: 256,
  authors: 64,
  url: 2_048,
  date: 128,
  categories: 64,
  category: 128,
  entries: 100
};

export function buildArxivSearchUrl(query: string, options: ArxivSearchOptions = {}): string {
  const url = new URL(ARXIV_API);
  url.searchParams.set("search_query", query);
  url.searchParams.set("start", String(options.start ?? 0));
  url.searchParams.set("max_results", String(options.maxResults ?? 10));
  url.searchParams.set("sortBy", "submittedDate");
  url.searchParams.set("sortOrder", "descending");
  return url.toString();
}

export async function searchArxiv(query: string, options: ArxivSearchOptions = {}): Promise<ArxivPaper[]> {
  throwIfAborted(options.abortSignal, "arXiv search aborted before request.");
  const url = buildArxivSearchUrl(query, options);
  const fetcher = options.fetcher ?? fetch;
  const response = await withArxivPoliteSlot(async () => fetcher(url, {
    headers: {
      "User-Agent": arxivUserAgent(options.contact)
    },
    signal: options.abortSignal
  }), options.minIntervalMs ?? ARXIV_POLITE_MIN_INTERVAL_MS, options.abortSignal);

  if (!response.ok) {
    throw new Error(`arXiv search failed: HTTP ${response.status}`);
  }

  const xml = await boundedResponseText(response, options.maxResponseBytes ?? ARXIV_MAX_RESPONSE_BYTES);
  return parseArxivFeed(xml, {
    maxEntries: options.maxResults,
    fieldLimits: options.fieldLimits
  });
}

export function arxivUserAgent(contact = process.env.MATEMATICA_ARXIV_CONTACT): string {
  const defaultUserAgent = `matematica-cli/${matematicaPackageVersion()}`;
  return contact ? `${defaultUserAgent} (${contact})` : defaultUserAgent;
}

export function arxivCompliancePolicy(options: { contact?: string; minIntervalMs?: number } = {}) {
  return {
    source: "arxiv_api_terms_of_use",
    termsUrl: "https://info.arxiv.org/help/api/tou.html",
    maxConnections: 1,
    minIntervalMs: options.minIntervalMs ?? ARXIV_POLITE_MIN_INTERVAL_MS,
    userAgent: arxivUserAgent(options.contact),
    metadataRedistribution: "allowed",
    pdfAndSourceRedistribution: "not_exported_without_license"
  };
}

export function resetArxivPoliteState(): void {
  arxivQueue = Promise.resolve();
  lastArxivRequestAt = 0;
}

async function withArxivPoliteSlot<T>(operation: () => Promise<T>, minIntervalMs: number, signal?: AbortSignal): Promise<T> {
  const previous = arxivQueue;
  let release!: () => void;
  arxivQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await abortableWait(previous, signal);
    throwIfAborted(signal, "arXiv search aborted before polite-use slot.");
    const waitMs = Math.max(0, lastArxivRequestAt + minIntervalMs - Date.now());
    if (waitMs > 0) await abortableSleep(waitMs, signal);
    lastArxivRequestAt = Date.now();
    return await operation();
  } finally {
    release();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseArxivFeed(
  xml: string,
  options: { maxEntries?: number; fieldLimits?: Partial<ArxivFieldLimits>; maxResponseBytes?: number } = {}
): ArxivPaper[] {
  const maxResponseBytes = options.maxResponseBytes ?? ARXIV_MAX_RESPONSE_BYTES;
  if (utf8Bytes(xml) > maxResponseBytes) {
    throw new Error(`arXiv feed exceeds max response bytes (${maxResponseBytes}).`);
  }
  rejectDangerousXml(xml);
  const limits = { ...DEFAULT_FIELD_LIMITS, ...(options.fieldLimits ?? {}) };
  const document = parseBoundedXml(xml, limits);
  const feed = firstChild(document, "feed");
  if (!feed) throw new Error("Malformed arXiv feed: missing feed root.");
  const maxEntries = Math.min(options.maxEntries ?? limits.entries, limits.entries);
  return children(feed, "entry").slice(0, maxEntries).map((entry, index) => paperFromEntry(entry, index + 1, limits));
}

async function boundedResponseText(response: Response, maxBytes: number): Promise<string> {
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > maxBytes) {
    throw new Error(`arXiv response exceeds max response bytes (${maxBytes}).`);
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

type XmlNode = {
  name: string;
  attributes: Record<string, string>;
  children: XmlNode[];
  text: string;
  start: number;
  end?: number;
  rawXml?: string;
};

function parseBoundedXml(xml: string, limits: ArxivFieldLimits): XmlNode {
  const document: XmlNode = { name: "#document", attributes: {}, children: [], text: "", start: 0 };
  const stack: XmlNode[] = [document];
  let index = 0;
  while (index < xml.length) {
    const open = xml.indexOf("<", index);
    if (open < 0) {
      appendText(stack.at(-1)!, decodeXmlStrict(xml.slice(index), limits.summary));
      break;
    }
    if (open > index) {
      appendText(stack.at(-1)!, decodeXmlStrict(xml.slice(index, open), limits.summary));
    }
    if (xml.startsWith("<!--", open)) {
      const close = xml.indexOf("-->", open + 4);
      if (close < 0) throw new Error("Malformed arXiv feed: unterminated XML comment.");
      index = close + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", open)) {
      const close = xml.indexOf("]]>", open + 9);
      if (close < 0) throw new Error("Malformed arXiv feed: unterminated CDATA.");
      appendText(stack.at(-1)!, xml.slice(open + 9, close));
      index = close + 3;
      continue;
    }
    if (xml.startsWith("<?", open)) {
      const close = xml.indexOf("?>", open + 2);
      if (close < 0) throw new Error("Malformed arXiv feed: unterminated processing instruction.");
      index = close + 2;
      continue;
    }
    if (xml.startsWith("<!", open)) {
      throw new Error("Unsafe arXiv feed: declarations and entities are not allowed.");
    }
    const close = findTagEnd(xml, open + 1);
    if (close < 0) throw new Error("Malformed arXiv feed: unterminated tag.");
    const rawTag = xml.slice(open + 1, close).trim();
    if (rawTag.startsWith("/")) {
      const name = rawTag.slice(1).trim();
      const current = stack.pop();
      if (!current || current === document) throw new Error(`Malformed arXiv feed: unexpected closing tag ${name}.`);
      if (localName(current.name) !== localName(name)) {
        throw new Error(`Malformed arXiv feed: closing tag ${name} does not match ${current.name}.`);
      }
      current.end = close + 1;
      current.rawXml = xml.slice(current.start, current.end);
      index = close + 1;
      continue;
    }
    const selfClosing = rawTag.endsWith("/");
    const tagContent = selfClosing ? rawTag.slice(0, -1).trim() : rawTag;
    const { name, attributes } = parseTag(tagContent, limits);
    const node: XmlNode = { name, attributes, children: [], text: "", start: open };
    stack.at(-1)!.children.push(node);
    if (selfClosing) {
      node.end = close + 1;
      node.rawXml = xml.slice(node.start, node.end);
    } else {
      stack.push(node);
    }
    index = close + 1;
  }
  if (stack.length !== 1) {
    throw new Error(`Malformed arXiv feed: unclosed tag ${stack.at(-1)!.name}.`);
  }
  return document;
}

function paperFromEntry(entry: XmlNode, index: number, limits: ArxivFieldLimits): ArxivPaper {
  const links = children(entry, "link").map((link) => link.attributes);
  const pdfUrl = boundedOptional(links.find((link) => link.title === "pdf")?.href, "pdf url", limits.url);
  const absUrl = boundedOptional(links.find((link) => link.rel === "alternate")?.href, "abs url", limits.url);
  const authors = children(entry, "author")
    .map((author) => normalizeWhitespace(textChild(author, "name")))
    .filter(Boolean)
    .slice(0, limits.authors)
    .map((author) => bounded(author, "author", limits.author));
  const categories = children(entry, "category")
    .map((category) => category.attributes.term)
    .filter((category): category is string => Boolean(category))
    .slice(0, limits.categories)
    .map((category) => bounded(category, "category", limits.category));
  const paper = {
    id: bounded(requiredText(entry, "id", index), "id", limits.id),
    title: bounded(normalizeWhitespace(requiredText(entry, "title", index)), "title", limits.title),
    summary: bounded(normalizeWhitespace(textChild(entry, "summary")), "summary", limits.summary),
    authors,
    published: bounded(requiredText(entry, "published", index), "published", limits.date),
    updated: bounded(requiredText(entry, "updated", index), "updated", limits.date),
    pdfUrl,
    absUrl,
    categories
  };
  return {
    ...paper,
    rawMetadataHash: hashJson({
      rawEntryHash: hashText(entry.rawXml ?? ""),
      id: paper.id,
      title: paper.title,
      authors: paper.authors,
      published: paper.published,
      updated: paper.updated,
      pdfUrl: paper.pdfUrl,
      absUrl: paper.absUrl,
      categories: paper.categories
    })
  };
}

function rejectDangerousXml(xml: string): void {
  const upper = xml.toUpperCase();
  if (upper.includes("<!DOCTYPE") || upper.includes("<!ENTITY")) {
    throw new Error("Unsafe arXiv feed: DOCTYPE and ENTITY declarations are not allowed.");
  }
}

function findTagEnd(xml: string, start: number): number {
  let quote: "\"" | "'" | undefined;
  for (let index = start; index < xml.length; index += 1) {
    const char = xml[index];
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (char === ">") return index;
  }
  return -1;
}

function parseTag(content: string, limits: ArxivFieldLimits): { name: string; attributes: Record<string, string> } {
  const nameEnd = content.search(/\s/);
  const name = nameEnd < 0 ? content : content.slice(0, nameEnd);
  if (!name) throw new Error("Malformed arXiv feed: missing tag name.");
  const attributes: Record<string, string> = {};
  let index = name.length;
  while (index < content.length) {
    while (/\s/.test(content[index] ?? "")) index += 1;
    if (index >= content.length) break;
    const attrStart = index;
    while (index < content.length && !/[\s=]/.test(content[index])) index += 1;
    const attrName = content.slice(attrStart, index);
    while (/\s/.test(content[index] ?? "")) index += 1;
    if (content[index] !== "=") throw new Error(`Malformed arXiv feed: attribute ${attrName} missing value.`);
    index += 1;
    while (/\s/.test(content[index] ?? "")) index += 1;
    const quote = content[index];
    if (quote !== "\"" && quote !== "'") throw new Error(`Malformed arXiv feed: attribute ${attrName} is not quoted.`);
    index += 1;
    const valueStart = index;
    while (index < content.length && content[index] !== quote) index += 1;
    if (index >= content.length) throw new Error(`Malformed arXiv feed: attribute ${attrName} is unterminated.`);
    attributes[attrName] = bounded(decodeXmlStrict(content.slice(valueStart, index), limits.url), attrName, limits.url);
    index += 1;
  }
  return { name, attributes };
}

function firstChild(node: XmlNode, name: string): XmlNode | undefined {
  return children(node, name)[0];
}

function children(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((child) => localName(child.name) === name);
}

function textChild(node: XmlNode, name: string): string {
  return firstChild(node, name)?.text.trim() ?? "";
}

function requiredText(node: XmlNode, name: string, entryIndex: number): string {
  const value = textChild(node, name);
  if (!value) throw new Error(`Malformed arXiv feed: entry ${entryIndex} missing required ${name}.`);
  return value;
}

function localName(name: string): string {
  return name.includes(":") ? name.split(":").at(-1)! : name;
}

function appendText(node: XmlNode, text: string): void {
  node.text += text;
}

function bounded(value: string, label: string, maxLength: number): string {
  if (value.length > maxLength) throw new Error(`arXiv ${label} exceeds max field size (${maxLength}).`);
  return value;
}

function boundedOptional(value: string | undefined, label: string, maxLength: number): string | undefined {
  return value === undefined ? undefined : bounded(value, label, maxLength);
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function decodeXmlStrict(value: string, maxDecodedLength: number): string {
  let entityCount = 0;
  const decoded = value.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (_match, entity: string) => {
    entityCount += 1;
    if (entityCount > 1_000) throw new Error("Unsafe arXiv feed: too many XML entities.");
    if (entity === "amp") return "&";
    if (entity === "lt") return "<";
    if (entity === "gt") return ">";
    if (entity === "quot") return "\"";
    if (entity === "apos") return "'";
    const codepoint = entity.toLowerCase().startsWith("#x")
      ? Number.parseInt(entity.slice(2), 16)
      : Number.parseInt(entity.slice(1), 10);
    if (!Number.isFinite(codepoint) || codepoint < 0 || codepoint > 0x10ffff) {
      throw new Error("Unsafe arXiv feed: invalid numeric XML entity.");
    }
    return String.fromCodePoint(codepoint);
  });
  if (/&[^;\s]{1,64};/.test(decoded)) {
    throw new Error("Unsafe arXiv feed: unsupported XML entity.");
  }
  if (decoded.length > maxDecodedLength * 4) {
    throw new Error(`arXiv decoded XML text exceeds max field size (${maxDecodedLength}).`);
  }
  return decoded;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function hashJson(value: unknown): string {
  return hashText(JSON.stringify(value));
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
