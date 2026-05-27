import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "../src/artifacts";
import { Ledger } from "../src/ledger";
import { getAppPaths } from "../src/paths";
import { runSwarmKillDrillSuite } from "../src/swarm-kill-drill";

const homes: string[] = [];

afterEach(() => {
  delete process.env.MATEMATICA_HOME;
  while (homes.length > 0) {
    rmSync(homes.pop()!, { recursive: true, force: true });
  }
});

test("swarm kill-drill harness covers 1 4 16 and 100 worker stop paths", async () => {
  const home = mkdtempSync(join(tmpdir(), "matematica-swarm-kill-drill-"));
  homes.push(home);
  process.env.MATEMATICA_HOME = home;
  const paths = getAppPaths();
  const ledger = new Ledger(paths.dbPath);
  const artifacts = new ArtifactStore(paths.artifactsDir, ledger);
  try {
    const result = await runSwarmKillDrillSuite({ ledger, artifacts });
    const failed = result.cases.filter((item) => !item.ok);

    expect(result.workerCounts).toEqual([1, 4, 16, 100]);
    expect(result.ok).toBe(true);
    expect(failed).toEqual([]);
    expect(result.cases).toHaveLength(40);
    expect(new Set(result.cases.map((item) => item.name))).toEqual(new Set([
      "sigint-cancel",
      "hung-workers",
      "stale-leases",
      "sqlite-contention",
      "provider-429-storm",
      "active-budget-exhaustion",
      "goal-met-while-running",
      "reserve-crash-window",
      "lease-crash-window",
      "reservation-bind-crash-window"
    ]));
    expect(new Set(result.cases.map((item) => item.workerCount))).toEqual(new Set([1, 4, 16, 100]));
    expect(result.cases.every((item) => item.invariants.openReservations === 0)).toBe(true);
    expect(result.cases.every((item) => item.invariants.activeJobs.length === 0)).toBe(true);
    expect(result.cases.every((item) => item.invariants.postTerminalMutations.length === 0)).toBe(true);
    expect(result.cases.every((item) => item.invariants.duplicateExternalOperations.length === 0)).toBe(true);
    expect(result.cases.every((item) => item.invariants.duplicateWorkerLeases.length === 0)).toBe(true);
    expect(result.cases.every((item) => item.invariants.reservationBindingIssues.length === 0)).toBe(true);
    expect(result.cases.every((item) => item.invariants.budgetSettlementIssues.length === 0)).toBe(true);
    expect(result.cases.every((item) => item.invariants.overspend.length === 0)).toBe(true);
    expect(result.cases.every((item) => item.invariants.secretLeaks.length === 0)).toBe(true);
    expect(result.cases.every((item) => item.invariants.auditOk)).toBe(true);
    expect(result.cases.every((item) => item.invariants.replayOk)).toBe(true);
    expect(result.cases.every((item) => /^[a-f0-9]{64}$/.test(item.invariants.failureReportHash))).toBe(true);
  } finally {
    ledger.close();
  }
}, 30_000);
