import { createHash } from "node:crypto";

export type ExternalOperationKeyInput = {
  runId: string;
  operationType: string;
  requestHash: string;
  retryOfOperationId?: string;
};

export function externalOperationIdempotencyKey(input: ExternalOperationKeyInput): string {
  const scope = input.retryOfOperationId
    ? {
        runId: input.runId,
        operationType: input.operationType,
        requestHash: input.requestHash,
        retryOfOperationId: input.retryOfOperationId
      }
    : {
        runId: input.runId,
        operationType: input.operationType,
        requestHash: input.requestHash
      };
  return `extop_${sanitizeKeyPart(input.operationType)}_${stableHash(scope).slice(0, 32)}`;
}

export function stableHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function sanitizeKeyPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase();
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value)) ?? "undefined";
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => [key, canonicalize(entryValue)])
  );
}
