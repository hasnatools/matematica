import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditRun } from "../src/audit";
import { runCli } from "../src/cli";
import { Ledger } from "../src/ledger";
import { getAppPaths } from "../src/paths";

const homes: string[] = [];

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "matematica-solver-fixture-"));
  homes.push(home);
  process.env.MATEMATICA_HOME = home;
  return home;
}

afterEach(() => {
  delete process.env.MATEMATICA_HOME;
  while (homes.length > 0) {
    rmSync(homes.pop()!, { recursive: true, force: true });
  }
});

test("known exact arithmetic theorem emits verifier proof artifacts and replayable report", async () => {
  tempHome();
  const created = JSON.parse(await runCli([
    "goal",
    "create",
    "--problem",
    "Prove 1 + 1 = 2",
    "--goal",
    "Find verified computation",
    "--max-attempts",
    "1"
  ]));

  const result = JSON.parse(await runCli(["goal", "run", created.id]));
  expect(result.status).toBe("goal_met");
  expect(result.evidenceGrade).toBe("verified_computation");
  expect(result.canClaimSolved).toBe(true);

  const ledger = new Ledger(getAppPaths().dbPath);
  try {
    expect(auditRun(created.id, ledger).ok).toBe(true);
    const artifacts = ledger.listArtifacts(created.id);
    const executable = artifacts.find((artifact) => artifact.kind === "computation.executable");
    const verifier = artifacts.find((artifact) => artifact.kind === "verifier.local.result");
    const proof = artifacts.find((artifact) => artifact.kind === "proof.obligations");
    expect(executable).toBeTruthy();
    expect(verifier).toBeTruthy();
    expect(proof).toBeTruthy();
    expect(readFileSync(executable!.path, "utf8")).toContain("1 + 1 = 2");
    expect(readFileSync(verifier!.path, "utf8")).toContain("Recognized an exact closed integer-addition identity");
    expect(readFileSync(proof!.path, "utf8")).toContain("computational_evidence");
  } finally {
    ledger.close();
  }

  const report = await runCli(["goal", "report", created.id]);
  expect(report).toContain("Final outcome: computational_evidence");
  expect(report).toContain("Can claim solved: yes");
  const replay = JSON.parse(await runCli(["goal", "replay", created.id, "--offline", "--verify-final"]));
  expect(replay.ok).toBe(true);
  expect(replay.finalVerification.ok).toBe(true);
});

test("numerical computation fixture verifies exact finite arithmetic claims beyond one plus one", async () => {
  tempHome();
  const created = JSON.parse(await runCli([
    "goal",
    "create",
    "--problem",
    "Compute 2 + 2 = 4",
    "--goal",
    "Find verified computation",
    "--max-attempts",
    "1"
  ]));

  const result = JSON.parse(await runCli(["goal", "run", created.id]));
  expect(result.status).toBe("goal_met");
  expect(result.evidenceGrade).toBe("verified_computation");

  const ledger = new Ledger(getAppPaths().dbPath);
  try {
    const executable = ledger.listArtifacts(created.id).find((artifact) => artifact.kind === "computation.executable");
    expect(readFileSync(executable!.path, "utf8")).toContain("2 + 2 = 4");
  } finally {
    ledger.close();
  }
});

test("false arithmetic hidden-assumption and open-problem fixtures do not claim solved", async () => {
  for (const problem of [
    "Compute 1 + 1 = 3",
    "Prove x = y by cancelling x - y after assuming x = y.",
    "Resolve the Erdos discrepancy problem.",
    "Prove this hard theorem for all natural numbers; the introduction says 2 + 2 = 4."
  ]) {
    tempHome();
    const created = JSON.parse(await runCli([
      "goal",
      "create",
      "--problem",
      problem,
      "--goal",
      "Prove the requested statement exactly",
      "--max-attempts",
      "1"
    ]));

    const result = JSON.parse(await runCli(["goal", "run", created.id]));
    expect(result.status).toBe("budget_exhausted");
    expect(result.canClaimSolved).toBe(false);
    expect(result.evidenceGrade).toBe("budget_exhausted");

    const report = await runCli(["goal", "report", created.id]);
    expect(report).toContain("Can claim solved: no");
    expect(report).not.toContain("Can claim solved: yes");
  }
});
