import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "../src/artifacts";
import { auditRun } from "../src/audit";
import { runCli } from "../src/cli";
import { Ledger } from "../src/ledger";
import { getAppPaths } from "../src/paths";
import { readArtifactText } from "../src/storage-encryption";

const homes: string[] = [];
const filesToRemove: string[] = [];

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "matematica-encrypted-storage-test-"));
  homes.push(home);
  process.env.MATEMATICA_HOME = home;
  return home;
}

afterEach(() => {
  delete process.env.MATEMATICA_HOME;
  delete process.env.MATEMATICA_STORAGE_KEY;
  delete process.env.MATEMATICA_STORAGE_KEY_ENV;
  delete process.env.MATEMATICA_STORAGE_ENCRYPTION;
  while (filesToRemove.length > 0) {
    rmSync(filesToRemove.pop()!, { recursive: true, force: true });
  }
  while (homes.length > 0) {
    rmSync(homes.pop()!, { recursive: true, force: true });
  }
});

test("storage init-encrypted persists only key environment metadata", async () => {
  const home = tempHome();
  process.env.MATEMATICA_STORAGE_KEY = "matematica-test-key-never-persisted";

  const output = JSON.parse(await runCli(["storage", "init-encrypted"]));
  const configText = readFileSync(join(home, "config.json"), "utf8");

  expect(output).toMatchObject({
    storageEncryption: {
      enabled: true,
      keyEnv: "MATEMATICA_STORAGE_KEY",
      keyPersistence: "external-env-only"
    },
    home
  });
  expect(configText).toContain("\"enabled\": true");
  expect(configText).toContain("\"keyEnv\": \"MATEMATICA_STORAGE_KEY\"");
  expect(configText).not.toContain("matematica-test-key-never-persisted");
});

test("encrypted home keeps run ledger, witness, jobs, and artifacts free of plaintext canaries", async () => {
  const home = tempHome();
  process.env.MATEMATICA_STORAGE_KEY = "matematica-storage-key-canary-123";
  await runCli(["storage", "init-encrypted"]);

  const paths = getAppPaths();
  const ledger = new Ledger(paths.dbPath);
  const artifacts = new ArtifactStore(paths.artifactsDir, ledger);
  let runId = "";
  let artifactId = "";
  try {
    const run = ledger.createRun({
      problem: "problem plaintext canary ENCRYPTED_PROBLEM_CANARY",
      goal: "goal plaintext canary ENCRYPTED_GOAL_CANARY",
      successCriteria: ["success plaintext canary ENCRYPTED_SUCCESS_CANARY"],
      workflow: "pflk",
      budget: { maxAttempts: 1 }
    });
    runId = run.id;
    const artifact = artifacts.create(run.id, "test.encrypted", "artifact plaintext canary ENCRYPTED_ARTIFACT_CANARY");
    artifactId = artifact.id;
    ledger.appendEvent(run.id, "cycle.started", {
      eventCanary: "ENCRYPTED_EVENT_CANARY"
    });
    ledger.enqueueWorkerJob({
      runId: run.id,
      kind: "encrypted.worker",
      payload: { workerCanary: "ENCRYPTED_WORKER_CANARY" }
    });
    ledger.refreshLedgerWitness(run.id);

    expect(readArtifactText(artifact)).toContain("ENCRYPTED_ARTIFACT_CANARY");
    expect(auditRun(run.id, ledger).ok).toBe(true);
  } finally {
    ledger.close();
  }

  const raw = readAllFiles(home).join("\n");
  for (const canary of [
    "matematica-storage-key-canary-123",
    "ENCRYPTED_PROBLEM_CANARY",
    "ENCRYPTED_GOAL_CANARY",
    "ENCRYPTED_SUCCESS_CANARY",
    "ENCRYPTED_ARTIFACT_CANARY",
    "ENCRYPTED_EVENT_CANARY",
    "ENCRYPTED_WORKER_CANARY"
  ]) {
    expect(raw).not.toContain(canary);
  }
  expect(raw).toContain("matematica.enc.v1:");

  const exportPath = join(tmpdir(), `${runId}-encrypted-bundle.json`);
  filesToRemove.push(exportPath);
  const exported = JSON.parse(await runCli(["goal", "replay", runId, "--export", exportPath]));
  expect(exported.ok).toBe(true);
  expect(exported.artifacts).toBeGreaterThan(0);

  const unlockedLedger = new Ledger(paths.dbPath);
  try {
    const artifact = unlockedLedger.listArtifacts(runId).find((item) => item.id === artifactId);
    expect(artifact).toBeDefined();
    expect(readArtifactText(artifact!)).toContain("ENCRYPTED_ARTIFACT_CANARY");
  } finally {
    unlockedLedger.close();
  }
});

test("encrypted storage fails closed for wrong keys and corrupted artifact envelopes", async () => {
  tempHome();
  process.env.MATEMATICA_STORAGE_KEY = "correct-storage-key";
  await runCli(["storage", "init-encrypted"]);

  const created = JSON.parse(await runCli([
    "goal",
    "create",
    "--problem",
    "wrong key should not reveal this ENCRYPTED_WRONG_KEY_CANARY",
    "--goal",
    "prove fail closed",
    "--max-attempts",
    "1"
  ]));

  process.env.MATEMATICA_STORAGE_KEY = "wrong-storage-key";
  await expect(runCli(["goal", "status", created.id])).rejects.toThrow("Encrypted storage key check failed");

  process.env.MATEMATICA_STORAGE_KEY = "correct-storage-key";
  const paths = getAppPaths();
  const ledger = new Ledger(paths.dbPath);
  try {
    const artifact = ledger.listArtifacts(created.id)[0];
    const encrypted = readFileSync(artifact.path, "utf8");
    writeFileSync(artifact.path, encrypted.replace(/.$/, encrypted.endsWith("A") ? "B" : "A"));
    expect(() => auditRun(created.id, ledger)).toThrow();
  } finally {
    ledger.close();
  }
});

function readAllFiles(root: string): string[] {
  const values: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      values.push(...readAllFiles(path));
      continue;
    }
    if (entry.isFile()) values.push(readFileSync(path).toString("utf8"));
  }
  return values;
}
