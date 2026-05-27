import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "../src/artifacts";
import { Ledger } from "../src/ledger";
import { getAppPaths } from "../src/paths";
import { runSwarmStressGate } from "../src/swarm-stress-gate";

const homes: string[] = [];

afterEach(() => {
  delete process.env.MATEMATICA_HOME;
  while (homes.length > 0) rmSync(homes.pop()!, { recursive: true, force: true });
});

test("100-worker swarm stress gate covers PFLK and GREE mock-provider fanout", async () => {
  const home = mkdtempSync(join(tmpdir(), "matematica-swarm-stress-gate-"));
  homes.push(home);
  process.env.MATEMATICA_HOME = home;
  const paths = getAppPaths();
  const ledger = new Ledger(paths.dbPath);
  const artifacts = new ArtifactStore(paths.artifactsDir, ledger);
  try {
    const result = await runSwarmStressGate({
      ledger,
      artifacts,
      workerCount: 100,
      providerConcurrency: 8
    });
    const scenarios = new Map(result.scenarios.map((scenario) => [scenario.scenario, scenario]));

    expect(result.format).toBe("matematica.swarm-stress-gate");
    expect(result.ok).toBe(true);
    expect(result.workerCount).toBe(100);
    expect(result.providerConcurrency).toBe(8);
    expect(result.scenarios).toHaveLength(5);
    expect(result.summary.maxObservedConcurrency).toBeLessThanOrEqual(8);
    expect(result.summary.maxMemoryDeltaBytes).toBeLessThanOrEqual(result.memoryLimitBytes);
    expect(result.summary.totalCpuMicros).toBeLessThanOrEqual(result.cpuLimitMicros * result.scenarios.length);

    expect(scenarios.get("pflk-loophole-full")?.scheduler.committed).toBe(100);
    expect(scenarios.get("gree-experiment-full")?.scheduler.committed).toBe(100);
    expect(scenarios.get("gree-experiment-cancel")?.observed.cancellationObserved).toBe(true);
    expect(scenarios.get("gree-experiment-cancel")?.scheduler.cancelled).toBeGreaterThan(0);
    expect(scenarios.get("pflk-loophole-crash-resume")?.observed.resumedStaleLeases).toBe(100);
    expect(scenarios.get("pflk-loophole-crash-resume")?.scheduler.committed).toBe(100);
    expect(scenarios.get("gree-experiment-budget-exhaustion")?.scheduler.budgetExhausted).toBe(true);
    expect(scenarios.get("gree-experiment-budget-exhaustion")?.scheduler.committed).toBe(25);

    for (const scenario of result.scenarios) {
      expect(scenario.invariants.ok).toBe(true);
      expect(scenario.invariants.openReservations).toBe(0);
      expect(scenario.invariants.duplicateLeases).toEqual([]);
      expect(scenario.invariants.duplicateExternalOperations).toEqual([]);
      expect(scenario.invariants.eventOrderingViolations).toEqual([]);
      expect(scenario.invariants.overspend).toEqual([]);
      expect(scenario.invariants.secretLeaks).toEqual([]);
      expect(scenario.invariants.auditOk).toBe(true);
      expect(scenario.observed.maxConcurrency).toBeLessThanOrEqual(scenario.providerConcurrency);
    }
    for (const runId of result.scenarios.map((scenario) => scenario.runId)) {
      expect(ledger.listEvents(runId).some((event) => event.type === "swarm.stress_gate.reviewed")).toBe(true);
      expect(ledger.listArtifacts(runId).map((artifact) => artifact.kind)).toContain("swarm.stress.report");
    }
  } finally {
    ledger.close();
  }
}, 60_000);
