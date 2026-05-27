import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  writeSync
} from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import type { Artifact } from "./domain";
import { artifactContentAddress, artifactStorageKey, makeId, nowIso } from "./domain";
import type { Ledger } from "./ledger";
import { redactText } from "./redaction";
import { encryptArtifactContent, STORAGE_ENCRYPTION_FORMAT } from "./storage-encryption";

export const ARTIFACT_REDACTION_POLICY_VERSION = "redactText-v1";
export const DEFAULT_MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
export const DEFAULT_TEXT_ARTIFACT_MEDIA_TYPE = "text/plain; charset=utf-8";
export const JSON_ARTIFACT_MEDIA_TYPE = "application/json";

export type ArtifactCreateFault =
  | "after_temp_write"
  | "after_temp_fsync"
  | "after_rename"
  | "after_artifact_insert";

export type ArtifactReconciliationResult = {
  removedTempFiles: string[];
  removedOrphanFiles: string[];
  removedOrphanArtifactRows: string[];
};

export class ArtifactStore {
  constructor(
    private readonly rootDir: string,
    private readonly ledger: Ledger
  ) {}

  create(runId: string, kind: string, content: string, options: { fault?: ArtifactCreateFault; id?: string } = {}): Artifact {
    const run = this.ledger.requireRun(runId);
    const redactedContent = redactText(content);
    const rawSha256 = createHash("sha256").update(content).digest("hex");
    const sha256 = createHash("sha256").update(redactedContent).digest("hex");
    const bytes = Buffer.byteLength(redactedContent);
    const maxBytes = artifactSizeLimit(run.budget.maxArtifactBytes);
    if (bytes > maxBytes) {
      throw new Error(`Artifact ${kind} is ${bytes} bytes after redaction, exceeding the ${maxBytes} byte artifact size limit.`);
    }
    const contentAddress = artifactContentAddress(sha256);
    const storageKey = artifactStorageKey(runId, sha256);
    const mediaType = inferArtifactMediaType(redactedContent);
    const runDir = join(this.rootDir, runId);
    mkdirSync(runDir, { recursive: true });
    const path = join(runDir, `${sha256}.txt`);
    const encrypted = encryptArtifactContent(dirname(this.rootDir), { runId, kind, sha256 }, redactedContent);
    writeArtifactFileAtomically(path, encrypted.content, options.fault);

    const artifact: Artifact = {
      id: options.id ?? makeId("art"),
      runId,
      kind,
      sha256,
      contentAddress,
      mediaType,
      storageKey,
      path,
      bytes,
      createdAt: nowIso(),
      provenance: {
        version: 1,
        redactionPolicyVersion: ARTIFACT_REDACTION_POLICY_VERSION,
        contentAddress,
        mediaType,
        storageKey,
        raw: {
          sha256: rawSha256,
          persisted: false,
          unavailableReason: "Raw artifact content is redacted before local persistence."
        },
        redacted: {
          sha256,
          bytes,
          contentAddress,
          mediaType
        },
        storageEncryption: encrypted.encrypted
          ? {
              enabled: true,
              format: STORAGE_ENCRYPTION_FORMAT,
              keyPersistence: "external-env-only",
              plaintextHash: sha256,
              ciphertextPersisted: true
            }
          : {
              enabled: false
            }
      }
    };

    this.ledger.recordArtifactCreated(artifact, {
      fault: options.fault === "after_artifact_insert" ? "after_artifact_insert" : undefined
    });

    return artifact;
  }

  reconcileRun(runId: string, reason = "artifact store recovery"): ArtifactReconciliationResult {
    const runDir = join(this.rootDir, runId);
    mkdirSync(runDir, { recursive: true });
    const removedOrphanArtifactRows = this.ledger.reconcileOrphanArtifactRows(runId, reason);
    const trackedPaths = new Set(this.ledger.listArtifacts(runId).map((artifact) => artifact.path));
    const removedTempFiles: string[] = [];
    const removedOrphanFiles: string[] = [];

    for (const entry of readdirSync(runDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const path = join(runDir, entry.name);
      if (entry.name.endsWith(".tmp")) {
        rmSync(path, { force: true });
        removedTempFiles.push(path);
        continue;
      }
      if (!trackedPaths.has(path)) {
        rmSync(path, { force: true });
        removedOrphanFiles.push(path);
      }
    }

    return {
      removedTempFiles,
      removedOrphanFiles,
      removedOrphanArtifactRows
    };
  }
}

function artifactSizeLimit(runMaxArtifactBytes: number | undefined): number {
  const envLimit = process.env.MATEMATICA_MAX_ARTIFACT_BYTES;
  const parsedEnvLimit = envLimit === undefined ? undefined : Number(envLimit);
  const configuredLimit = parsedEnvLimit !== undefined && Number.isFinite(parsedEnvLimit) && parsedEnvLimit > 0
    ? Math.floor(parsedEnvLimit)
    : DEFAULT_MAX_ARTIFACT_BYTES;
  if (runMaxArtifactBytes !== undefined && runMaxArtifactBytes > 0) {
    return Math.min(configuredLimit, Math.floor(runMaxArtifactBytes));
  }
  return configuredLimit;
}

function inferArtifactMediaType(content: string): string {
  try {
    JSON.parse(content);
    return JSON_ARTIFACT_MEDIA_TYPE;
  } catch {
    return DEFAULT_TEXT_ARTIFACT_MEDIA_TYPE;
  }
}

function writeArtifactFileAtomically(path: string, content: string, fault: ArtifactCreateFault | undefined): void {
  const tempPath = `${path}.${makeId("tmp")}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(tempPath, "wx", 0o600);
    writeSync(fd, content);
    if (fault === "after_temp_write") {
      closeSync(fd);
      fd = undefined;
      throw new Error("Injected artifact persistence fault after temp file write.");
    }
    fsyncSync(fd);
    if (fault === "after_temp_fsync") {
      closeSync(fd);
      fd = undefined;
      throw new Error("Injected artifact persistence fault after temp file fsync.");
    }
    closeSync(fd);
    fd = undefined;
    renameSync(tempPath, path);
    fsyncDirectory(dirname(path));
    if (fault === "after_rename") {
      throw new Error("Injected artifact persistence fault after atomic rename.");
    }
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (!isInjectedFault(error) && existsSync(tempPath)) rmSync(tempPath, { force: true });
    throw error;
  }
}

function fsyncDirectory(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error
      ? String((error as { code: unknown }).code)
      : "";
    if (code !== "EINVAL" && code !== "EISDIR" && code !== "ENOTSUP") throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function isInjectedFault(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("Injected artifact persistence fault");
}
