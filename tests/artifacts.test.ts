import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "../src/artifacts";
import { auditRun } from "../src/audit";
import type { Artifact } from "../src/domain";
import { makeId, nowIso } from "../src/domain";
import { Ledger } from "../src/ledger";
import { getAppPaths } from "../src/paths";

const homes: string[] = [];

function setup() {
  const home = mkdtempSync(join(tmpdir(), "matematica-artifacts-test-"));
  homes.push(home);
  process.env.MATEMATICA_HOME = home;
  const paths = getAppPaths();
  const ledger = new Ledger(paths.dbPath);
  const artifacts = new ArtifactStore(paths.artifactsDir, ledger);
  const run = ledger.createRun({
    problem: "Persist artifacts durably",
    goal: "Artifact rows and events commit together",
    successCriteria: ["crash-safe artifacts"],
    workflow: "pflk",
    budget: { maxAttempts: 1 }
  });
  return { ledger, artifacts, run, paths };
}

afterEach(() => {
  delete process.env.MATEMATICA_HOME;
  delete process.env.MATEMATICA_MAX_ARTIFACT_BYTES;
  while (homes.length > 0) {
    rmSync(homes.pop()!, { recursive: true, force: true });
  }
});

test("artifact creation atomically records file row and artifact event", () => {
  const { ledger, artifacts, run } = setup();
  try {
    const artifact = artifacts.create(run.id, "test.artifact", "durable content");
    expect(existsSync(artifact.path)).toBe(true);
    expect(artifact.contentAddress).toBe(`sha256:${artifact.sha256}`);
    expect(artifact.storageKey).toBe(`${run.id}/${artifact.sha256}.txt`);
    expect(ledger.listArtifacts(run.id).map((item) => item.id)).toContain(artifact.id);
    const event = ledger.listEvents(run.id).find((item) =>
      item.type === "artifact.created" && item.payload.artifactId === artifact.id
    );
    expect(event?.artifactIds).toEqual([artifact.id]);
    expect(event?.payload.contentAddress).toBe(artifact.contentAddress);
    expect(event?.payload.storageKey).toBe(artifact.storageKey);
    expect(auditRun(run.id, ledger).ok).toBe(true);
  } finally {
    ledger.close();
  }
});

test("artifact metadata uses immutable content addresses and media types", () => {
  const { ledger, artifacts, run } = setup();
  try {
    const artifact = artifacts.create(run.id, "test.json", JSON.stringify({ ok: true }, null, 2));
    const [persisted] = ledger.listArtifacts(run.id);
    expect(persisted.id).toBe(artifact.id);
    expect(persisted.contentAddress).toBe(`sha256:${persisted.sha256}`);
    expect(persisted.mediaType).toBe("application/json");
    expect(persisted.storageKey).toBe(`${run.id}/${persisted.sha256}.txt`);
    expect(persisted.provenance?.contentAddress).toBe(persisted.contentAddress);
    expect(persisted.provenance?.mediaType).toBe("application/json");
    expect((persisted.provenance?.redacted as Record<string, unknown>).contentAddress).toBe(persisted.contentAddress);
    expect(auditRun(run.id, ledger).ok).toBe(true);
  } finally {
    ledger.close();
  }
});

test("artifact creation rejects content beyond the configured byte limit", () => {
  process.env.MATEMATICA_MAX_ARTIFACT_BYTES = "8";
  const { ledger, artifacts, run } = setup();
  try {
    expect(() => artifacts.create(run.id, "test.artifact", "0123456789"))
      .toThrow("exceeding the 8 byte artifact size limit");
    expect(ledger.listArtifacts(run.id)).toHaveLength(0);
    expect(ledger.listEvents(run.id).filter((event) => event.type === "artifact.created")).toHaveLength(0);
    expect(auditRun(run.id, ledger).ok).toBe(true);
  } finally {
    ledger.close();
  }
});

test("audit rejects tampered content-address metadata", () => {
  const { ledger, artifacts, run } = setup();
  try {
    const artifact = artifacts.create(run.id, "test.artifact", "durable content");
    ledger.db.query("UPDATE artifacts SET content_address = ? WHERE id = ?").run("sha256:forged", artifact.id);
    const audit = auditRun(run.id, ledger);
    expect(audit.ok).toBe(false);
    expect(audit.issues.map((issue) => issue.code)).toContain("artifact_content_address_mismatch");
    expect(audit.issues.map((issue) => issue.code)).toContain("artifact_created_payload_mismatch");
  } finally {
    ledger.close();
  }
});

test("artifact recovery removes temp and final files left before ledger commit", () => {
  const { ledger, artifacts, run, paths } = setup();
  try {
    expect(() => artifacts.create(run.id, "test.artifact", "temp crash", { fault: "after_temp_fsync" }))
      .toThrow("Injected artifact persistence fault");
    const tempRecovery = artifacts.reconcileRun(run.id, "recover temp artifact write");
    expect(tempRecovery.removedTempFiles).toHaveLength(1);
    expect(tempRecovery.removedOrphanFiles).toHaveLength(0);
    expect(ledger.listArtifacts(run.id)).toHaveLength(0);
    expect(auditRun(run.id, ledger).ok).toBe(true);

    expect(() => artifacts.create(run.id, "test.artifact", "rename crash", { fault: "after_rename" }))
      .toThrow("Injected artifact persistence fault");
    const finalRecovery = artifacts.reconcileRun(run.id, "recover renamed artifact before ledger");
    expect(finalRecovery.removedTempFiles).toHaveLength(0);
    expect(finalRecovery.removedOrphanFiles).toHaveLength(1);
    expect(ledger.listArtifacts(run.id)).toHaveLength(0);
    expect(auditRun(run.id, ledger).ok).toBe(true);
  } finally {
    ledger.close();
  }
});

test("artifact row and created event roll back together when commit is interrupted", () => {
  const { ledger, artifacts, run } = setup();
  try {
    expect(() => artifacts.create(run.id, "test.artifact", "ledger crash", { fault: "after_artifact_insert" }))
      .toThrow("Injected artifact persistence fault");
    expect(ledger.listArtifacts(run.id)).toHaveLength(0);
    expect(ledger.listEvents(run.id).filter((event) => event.type === "artifact.created")).toHaveLength(0);
    const recovery = artifacts.reconcileRun(run.id, "recover file after rolled-back ledger write");
    expect(recovery.removedOrphanFiles).toHaveLength(1);
    expect(auditRun(run.id, ledger).ok).toBe(true);
  } finally {
    ledger.close();
  }
});

test("audit detects and recovery deletes orphan artifact rows", () => {
  const { ledger, artifacts, run, paths } = setup();
  try {
    const content = "row without event";
    const sha256 = createHash("sha256").update(content).digest("hex");
    mkdirSync(join(paths.artifactsDir, run.id), { recursive: true });
    const path = join(paths.artifactsDir, run.id, `${sha256}.txt`);
    writeFileSync(path, content);
    const artifact: Artifact = {
      id: makeId("art"),
      runId: run.id,
      kind: "test.artifact",
      sha256,
      contentAddress: `sha256:${sha256}`,
      mediaType: "text/plain; charset=utf-8",
      storageKey: `${run.id}/${sha256}.txt`,
      path,
      bytes: Buffer.byteLength(content),
      createdAt: nowIso(),
      provenance: {
        version: 1,
        redactionPolicyVersion: "test",
        contentAddress: `sha256:${sha256}`,
        mediaType: "text/plain; charset=utf-8",
        storageKey: `${run.id}/${sha256}.txt`,
        raw: {
          sha256,
          persisted: false
        },
        redacted: {
          sha256,
          bytes: Buffer.byteLength(content),
          contentAddress: `sha256:${sha256}`,
          mediaType: "text/plain; charset=utf-8"
        }
      }
    };
    ledger.insertArtifact(artifact);

    const failedAudit = auditRun(run.id, ledger);
    expect(failedAudit.ok).toBe(false);
    expect(failedAudit.issues.map((issue) => issue.code)).toContain("artifact_row_missing_created_event");

    const recovery = artifacts.reconcileRun(run.id, "recover orphan artifact row");
    expect(recovery.removedOrphanArtifactRows).toEqual([artifact.id]);
    expect(recovery.removedOrphanFiles).toEqual([path]);
    expect(ledger.listArtifacts(run.id)).toHaveLength(0);
    expect(auditRun(run.id, ledger).ok).toBe(true);
  } finally {
    ledger.close();
  }
});
