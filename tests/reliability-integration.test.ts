import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditRun } from "../src/audit";
import { Ledger } from "../src/ledger";
import { getAppPaths } from "../src/paths";

const homes: string[] = [];

type CliProcessResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "matematica-reliability-integration-"));
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

async function runMatematicaProcess(args: string[], home: string): Promise<CliProcessResult> {
  return await new Promise((resolve) => {
    const child = spawn("bun", ["src/bin/matematica.ts", ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MATEMATICA_HOME: home,
        MATEMATICA_LOCAL_ONLY: "true"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (exitCode) => {
      resolve({ exitCode, stdout, stderr });
    });
  });
}

test("CLI process solve exits 0 for verified local success and leaves auditable replayable state", async () => {
  const home = tempHome();
  const result = await runMatematicaProcess([
    "solve",
    "--problem",
    "Prove 1 + 1 = 2",
    "--goal",
    "Find verified computation",
    "--budget-usd",
    "0",
    "--max-attempts",
    "4",
    "--workers",
    "1"
  ], home);

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  const payload = JSON.parse(result.stdout);
  expect(payload).toMatchObject({
    status: "goal_met",
    finalState: "computational_evidence",
    exitCode: 0
  });
  expect(payload.commands.replay).toBe(`matematica goal replay ${payload.runId} --offline --verify-final`);

  const ledger = new Ledger(getAppPaths().dbPath);
  try {
    expect(auditRun(payload.runId, ledger).ok).toBe(true);
    const replay = await runMatematicaProcess(["goal", "replay", payload.runId, "--offline", "--verify-final"], home);
    expect(replay.exitCode).toBe(0);
    expect(JSON.parse(replay.stdout)).toMatchObject({
      ok: true,
      finalVerification: {
        ok: true,
        recomputed: {
          finalOutcome: {
            state: "computational_evidence",
            canClaimSolved: true
          }
        }
      }
    });
  } finally {
    ledger.close();
  }
});

test("CLI process solve exits 2 for honest budget exhaustion without solved claims or secret leakage", async () => {
  const home = tempHome();
  const canary = "sk-reliability-process-canary-123456";
  const result = await runMatematicaProcess([
    "solve",
    "--problem",
    `Prove the Collatz conjecture without leaking ${canary}.`,
    "--goal",
    "Find a formal proof or verified counterexample",
    "--success-criteria",
    `Do not persist ${canary}; exhaust honestly if no proof is found`,
    "--budget-usd",
    "0",
    "--max-attempts",
    "1",
    "--workers",
    "1"
  ], home);

  expect(result.exitCode).toBe(2);
  expect(result.stderr).toBe("");
  expect(result.stdout).not.toContain(canary);
  const payload = JSON.parse(result.stdout);
  expect(payload).toMatchObject({
    status: "budget_exhausted",
    finalState: "budget_exhausted",
    canClaimSolved: false,
    exitCode: 2
  });

  const replay = await runMatematicaProcess(["goal", "replay", payload.runId, "--offline", "--verify-final"], home);
  expect(replay.exitCode).toBe(0);
  expect(replay.stdout).not.toContain(canary);
  expect(JSON.parse(replay.stdout)).toMatchObject({
    ok: true,
    finalVerification: {
      ok: true,
      recomputed: {
        finalOutcome: {
          state: "budget_exhausted",
          canClaimSolved: false
        }
      }
    }
  });
});
