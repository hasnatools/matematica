import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "../src/artifacts";
import { runCli } from "../src/cli";
import { checkLeanToolchain, classifyLeanFailure, verifyLeanFile } from "../src/lean";
import { Ledger } from "../src/ledger";
import { getAppPaths } from "../src/paths";

const homes: string[] = [];

function setup() {
  const home = mkdtempSync(join(tmpdir(), "matematica-lean-test-"));
  homes.push(home);
  process.env.MATEMATICA_HOME = home;
  const paths = getAppPaths();
  const ledger = new Ledger(paths.dbPath);
  const artifacts = new ArtifactStore(paths.artifactsDir, ledger);
  const run = ledger.createRun({
    problem: "Prove True",
    goal: "Lean verifies theorem",
    successCriteria: ["Lean verifier persists artifacts"],
    workflow: "pflk",
    budget: { maxAttempts: 1 }
  });
  return { home, ledger, artifacts, run };
}

afterEach(() => {
  delete process.env.MATEMATICA_HOME;
  while (homes.length > 0) {
    rmSync(homes.pop()!, { recursive: true, force: true });
  }
});

test("verifyLeanFile bars verifier-backed evidence when network isolation is unenforced", async () => {
  const { home, ledger, artifacts, run } = setup();
  const leanFile = join(home, "Proof.lean");
  const leanBin = fakeExecutable(home, "lean-ok", "echo verified");
  writeFileSync(leanFile, "theorem trivial : True := by trivial");

  try {
    const result = await verifyLeanFile({ runId: run.id, ledger, artifacts, leanFilePath: leanFile, leanBin });
    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(0);
    expect(result.failureKind).toBe("sandbox_network_unenforced");
    const artifactKinds = ledger.listArtifacts(run.id).map((artifact) => artifact.kind);
    expect(artifactKinds).toContain("lean.input");
    expect(artifactKinds).toContain("lean.stdout");
    expect(artifactKinds).toContain("lean.stderr");
    expect(artifactKinds).toContain("sandbox.policy");
    expect(artifactKinds).toContain("lean.result");
    expect(ledger.listEvents(run.id).map((event) => event.type)).toContain("verifier.completed");
    const completed = ledger.listEvents(run.id).find((event) => event.type === "verifier.completed");
    expect(completed?.payload.sandboxPolicyArtifactId).toStartWith("art_");
    expect(typeof completed?.payload.sandboxPolicyHash).toBe("string");
    const policyArtifact = ledger.listArtifacts(run.id).find((artifact) => artifact.id === completed?.payload.sandboxPolicyArtifactId);
    expect(policyArtifact?.kind).toBe("sandbox.policy");
    const policy = JSON.parse(readFileSync(policyArtifact!.path, "utf8"));
    expect(policy.isolation.environment).toBe("allowlist");
    expect(policy.isolation.shell).toBe("disabled");
    expect(policy.isolation.network).toBe("network_unenforced");
    expect(policy.evidence.verifierBackedEvidence).toBe("barred_network_unenforced");
    expect(policy.environment.allowedKeys).not.toContain("OPENAI_API_KEY");
    const operations = ledger.listExternalOperations(run.id);
    expect(operations).toHaveLength(1);
    expect(operations[0].operationType).toBe("verifier.lean4");
    expect(operations[0].idempotencyKey).toMatch(/^extop_verifier_lean4_[a-f0-9]{32}$/);
    expect(operations[0].status).toBe("succeeded");
    expect(operations[0].responseArtifactId).toBe(result.resultArtifactId);
  } finally {
    ledger.close();
  }
});

test("goal verify-lean records classified Lean failure", async () => {
  const { home, ledger, run } = setup();
  const leanFile = join(home, "Bad.lean");
  const leanBin = fakeExecutable(home, "lean-fail", "echo 'unknown identifier foo' >&2\nexit 1");
  writeFileSync(leanFile, "theorem bad : True := by exact foo");
  ledger.close();

  const result = JSON.parse(await runCli([
    "goal",
    "verify-lean",
    run.id,
    "--file",
    leanFile,
    "--lean-bin",
    leanBin
  ]));

  expect(result.status).toBe("failed");
  expect(result.failureKind).toBe("missing_definition");
});

test("verifyLeanFile runs through pinned Lake project when projectRoot is provided", async () => {
  const { home, ledger, artifacts, run } = setup();
  const projectRoot = join(home, "lean-project");
  mkdirProject(projectRoot);
  const leanFile = join(home, "Pinned.lean");
  const leanBin = fakeExecutable(home, "lean-pinned", `
if [[ "\${MATEMATICA_LAKE_ENV:-}" == "1" ]] && [[ -f "\${1:-}" ]]; then
  echo "verified in pinned project"
  exit 0
fi
echo "lean was not run through lake env" >&2
exit 1
`);
  const lakeBin = fakeExecutable(home, "lake-pinned", `
if [[ "\${1:-}" == "env" ]]; then
  shift
  MATEMATICA_LAKE_ENV=1 exec "$@"
fi
exit 2
`);
  writeFileSync(leanFile, "import Mathlib\ntheorem pinned_trivial : True := by trivial");

  try {
    const result = await verifyLeanFile({
      runId: run.id,
      ledger,
      artifacts,
      leanFilePath: leanFile,
      leanBin,
      lakeBin,
      projectRoot
    });

    expect(result.status).toBe("failed");
    expect(result.failureKind).toBe("sandbox_network_unenforced");
    expect(result.executionMode).toBe("lake-env-lean");
    expect(result.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.theoremNames).toEqual(["pinned_trivial"]);
    expect(result.theoremStatements.pinned_trivial).toBe("theorem pinned_trivial : True");
    expect(result.theoremStatementHashes.pinned_trivial).toMatch(/^[a-f0-9]{64}$/);
    expect(result.toolchainHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.projectPinned).toBe(true);
    expect(result.leanBinaryHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.lakeBinaryHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.lakeManifestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.lakefileHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.mathlibRevision).toBe("mathlib-project-rev");
    expect(result.verifierCommand).toEqual([lakeBin, "env", leanBin, "Main.lean"]);
    expect(result.verifierCommandHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.exactExitResultHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.tcb).toBeUndefined();
    expect(result.projectArtifactId).toStartWith("art_");
    expect(ledger.listArtifacts(run.id).map((artifact) => artifact.kind)).toContain("lean.project");
    const completed = ledger.listEvents(run.id).find((event) => event.type === "verifier.completed");
    expect(completed?.payload.executionMode).toBe("lake-env-lean");
    expect(completed?.payload.projectPinned).toBe(true);
    expect(completed?.payload.status).toBe("failed");
    expect(completed?.payload.theoremNames).toEqual(["pinned_trivial"]);
    const completedStatementHashes = completed?.payload.theoremStatementHashes as Record<string, string> | undefined;
    expect(completedStatementHashes?.pinned_trivial).toBe(result.theoremStatementHashes.pinned_trivial);
    expect(completed?.payload.toolchainHash).toBe(result.toolchainHash);
    expect(completed?.payload.mathlibRevision).toBe("mathlib-project-rev");
    expect(completed?.payload.verifierCommandHash).toBe(result.verifierCommandHash);
    const resultArtifact = ledger.listArtifacts(run.id).find((artifact) => artifact.id === result.resultArtifactId);
    const persisted = JSON.parse(readFileSync(resultArtifact!.path, "utf8"));
    expect(persisted.sourceHash).toBe(result.sourceHash);
    expect(persisted.theoremNames).toEqual(["pinned_trivial"]);
    expect(persisted.theoremStatementHashes.pinned_trivial).toBe(result.theoremStatementHashes.pinned_trivial);
    expect(persisted.toolchainHash).toBe(result.toolchainHash);
    expect(persisted.lakeManifestHash).toBe(result.lakeManifestHash);
    expect(persisted.lakefileHash).toBe(result.lakefileHash);
    expect(persisted.mathlibRevision).toBe("mathlib-project-rev");
    expect(persisted.verifierCommandHash).toBe(result.verifierCommandHash);
    expect(persisted.exactExitResultHash).toBe(result.exactExitResultHash);
  } finally {
    ledger.close();
  }
});

test("verifyLeanFile fails closed when requested projectRoot is not pinned", async () => {
  const { home, ledger, artifacts, run } = setup();
  const projectRoot = join(home, "unpinned-project");
  mkdirSync(projectRoot);
  const leanFile = join(home, "Unpinned.lean");
  const leanBin = fakeExecutable(home, "lean-unpinned", "echo should-not-run >&2\nexit 1");
  writeFileSync(leanFile, "theorem unpinned_trivial : True := by trivial");

  try {
    const result = await verifyLeanFile({
      runId: run.id,
      ledger,
      artifacts,
      leanFilePath: leanFile,
      leanBin,
      lakeBin: leanBin,
      projectRoot
    });

    expect(result.status).toBe("failed");
    expect(result.executionMode).toBe("lake-env-lean");
    expect(result.failureKind).toBe("import_issue");
    const completed = ledger.listEvents(run.id).find((event) => event.type === "verifier.completed");
    expect(completed?.payload.projectPinned).toBe(false);
    const operations = ledger.listExternalOperations(run.id);
    expect(operations).toHaveLength(1);
    expect(operations[0].status).toBe("failed");
    expect(ledger.listOpenBudgetReservations(run.id)).toHaveLength(0);
  } finally {
    ledger.close();
  }
});

test("verifyLeanFile persists failed verifier result when Lean binary is missing", async () => {
  const { home, ledger, artifacts, run } = setup();
  const leanFile = join(home, "MissingLean.lean");
  writeFileSync(leanFile, "theorem missing_lean_trivial : True := by trivial");

  try {
    const result = await verifyLeanFile({
      runId: run.id,
      ledger,
      artifacts,
      leanFilePath: leanFile,
      leanBin: join(home, "missing-lean")
    });

    expect(result.status).toBe("failed");
    expect(result.exitCode).toBeNull();
    expect(result.executionMode).toBe("lean-direct");
    expect(ledger.listArtifacts(run.id).map((artifact) => artifact.kind)).toContain("lean.result");
    const completed = ledger.listEvents(run.id).find((event) => event.type === "verifier.completed");
    expect(completed?.payload.status).toBe("failed");
  } finally {
    ledger.close();
  }
});

test("verifyLeanFile honors AbortSignal and records debited cancellation settlement", async () => {
  const { home, ledger, artifacts, run } = setup();
  const leanFile = join(home, "AbortLean.lean");
  const leanBin = fakeExecutable(home, "lean-abort", "sleep 5");
  const controller = new AbortController();
  writeFileSync(leanFile, "theorem abort_trivial : True := by trivial");

  try {
    const call = verifyLeanFile({
      runId: run.id,
      ledger,
      artifacts,
      leanFilePath: leanFile,
      leanBin,
      timeoutMs: 5_000,
      abortSignal: controller.signal
    });
    setTimeout(() => controller.abort(new Error("operator cancelled Lean verifier")), 25);
    const result = await call;

    expect(result.status).toBe("failed");
    expect(result.failureKind).toBe("timeout");
    const completed = ledger.listEvents(run.id).find((event) => event.type === "external.operation.completed");
    expect(completed?.payload.cancellationSettlement).toBe("debited");
    expect(ledger.listOpenBudgetReservations(run.id)).toHaveLength(0);
  } finally {
    ledger.close();
  }
});

test("classifyLeanFailure distinguishes common formalization blockers", () => {
  expect(classifyLeanFailure("unknown module Mathlib")).toBe("import_issue");
  expect(classifyLeanFailure("failed to synthesize OfNat")).toBe("universe_or_typeclass");
  expect(classifyLeanFailure("unsolved goals")).toBe("tactic_failure");
  expect(classifyLeanFailure("type mismatch")).toBe("wrong_formulation");
});

test("checkLeanToolchain reports Lean Lake elan and mathlib import readiness", async () => {
  const { home, ledger } = setup();
  ledger.close();
  const leanBin = fakeExecutable(home, "lean-toolchain", `
if [[ "\${1:-}" == "--version" ]]; then
  echo "Lean version 4.10.0"
  exit 0
fi
if [[ -f "\${1:-}" ]] && grep -q "import Mathlib" "$1"; then
  echo "Mathlib import ok"
  exit 0
fi
echo "unexpected lean args: $*" >&2
exit 2
`);
  const lakeBin = fakeExecutable(home, "lake-toolchain", `
if [[ "\${1:-}" == "--version" ]]; then
  echo "Lake version 5.0.0"
  exit 0
fi
if [[ "\${1:-}" == "env" ]]; then
  shift
  exec "$@"
fi
echo "unexpected lake args: $*" >&2
exit 2
`);
  const elanBin = fakeExecutable(home, "elan-toolchain", `
if [[ "\${1:-}" == "--version" ]]; then
  echo "elan 4.1.0"
  exit 0
fi
exit 2
`);
  writeFileSync(join(home, "lake-manifest.json"), JSON.stringify({
    packages: [{ name: "mathlib", rev: "mathlib-rev-123" }]
  }));

  const report = await checkLeanToolchain({ rootDir: home, leanBin, lakeBin, elanBin });

  expect(report.lean.status).toBe("ok");
  expect(report.lean.version).toBe("Lean version 4.10.0");
  expect(report.lake.status).toBe("ok");
  expect(report.elan.status).toBe("ok");
  expect(report.mathlib.status).toBe("ok");
  expect(report.mathlib.method).toBe("lake-env-lean");
  expect(report.mathlib.version).toBe("mathlib-rev-123");
  expect(report.mathlib.cachePath).toBe(join(home, ".lake"));
});

test("checkLeanToolchain skips mathlib import when Lake is unavailable", async () => {
  const { home, ledger } = setup();
  ledger.close();
  const leanBin = fakeExecutable(home, "lean-no-lake", `
if [[ "\${1:-}" == "--version" ]]; then
  echo "Lean version 4.10.0"
  exit 0
fi
exit 0
`);

  const report = await checkLeanToolchain({
    rootDir: home,
    leanBin,
    lakeBin: join(home, "missing-lake"),
    elanBin: join(home, "missing-elan")
  });

  expect(report.lean.status).toBe("ok");
  expect(report.lake.status).toBe("missing");
  expect(report.elan.status).toBe("missing");
  expect(report.mathlib.status).toBe("skipped");
  expect(report.mathlib.error).toBe("lake unavailable");
});

function mkdirProject(projectRoot: string): void {
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(join(projectRoot, "lean-toolchain"), "leanprover/lean4:v4.10.0\n");
  writeFileSync(join(projectRoot, "lakefile.toml"), "name = \"matematica_check\"\n");
  writeFileSync(join(projectRoot, "lake-manifest.json"), JSON.stringify({
    packages: [{ name: "mathlib", rev: "mathlib-project-rev" }]
  }));
}

function fakeExecutable(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}
