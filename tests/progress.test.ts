import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "../src/artifacts";
import type { LedgerEvent } from "../src/domain";
import { Ledger, type StoredScore } from "../src/ledger";
import { getAppPaths } from "../src/paths";
import { reviewGoalProgress } from "../src/progress";
import { renderReport } from "../src/report";
import { runGoal } from "../src/runner";

const homes: string[] = [];

afterEach(() => {
  delete process.env.MATEMATICA_HOME;
  while (homes.length > 0) {
    rmSync(homes.pop()!, { recursive: true, force: true });
  }
});

test("progress review marks repeated same-claim cycles as stagnating", () => {
  const first = reviewGoalProgress({
    cycle: 1,
    runStatus: "running",
    events: [
      event("goal.success.evaluated", { claimId: "claim-a" }),
      event("source.results", { sourceHashes: ["source-a"] })
    ],
    artifacts: [],
    scores: [score("claim-a", 0.4)]
  });
  const second = reviewGoalProgress({
    cycle: 2,
    runStatus: "running",
    events: [
      event("goal.progress.reviewed", { review: first }),
      event("goal.success.evaluated", { claimId: "claim-a" }),
      event("source.results", { sourceHashes: ["source-a"] })
    ],
    artifacts: [],
    scores: [score("claim-a", 0.4)]
  });

  expect(first.state).toBe("improving");
  expect(second.state).toBe("stagnating");
  expect(second.stagnantCycles).toBe(1);
  expect(second.nextAction).toBe("continue");
});

test("stagnation policy escalates after configured window without changing terminal contract", () => {
  const first = reviewGoalProgress({
    cycle: 1,
    runStatus: "running",
    events: [event("goal.success.evaluated", { claimId: "claim-a" })],
    artifacts: [],
    scores: [score("claim-a", 0.5)]
  });
  const second = reviewGoalProgress({
    cycle: 2,
    runStatus: "running",
    events: [event("goal.progress.reviewed", { review: first }), event("goal.success.evaluated", { claimId: "claim-a" })],
    artifacts: [],
    scores: [score("claim-a", 0.5)],
    policy: { windowCycles: 1 }
  });

  expect(second.state).toBe("stagnating");
  expect(second.nextAction).toBe("diversify_or_escalate");
  expect(second.reason).toContain("stagnation window reached");
});

test("goal run persists progress reviews and reports stagnation", async () => {
  const { ledger, artifacts, run } = setupOpenToyComputation();
  const result = await runGoal(run.id, ledger, artifacts, { arxivSearch: async () => [] });

  expect(result.status).toBe("budget_exhausted");
  const progressEvents = ledger.listEvents(run.id).filter((item) => item.type === "goal.progress.reviewed");
  expect(progressEvents).toHaveLength(4);
  expect(progressEvents[0].payload.review).toMatchObject({ state: "improving", stagnantCycles: 0 });
  expect(progressEvents[1].payload.review).toMatchObject({ state: "improving", stagnantCycles: 0 });
  expect(progressEvents[2].payload.review).toMatchObject({ state: "stagnating", stagnantCycles: 1 });
  expect(progressEvents[3].payload.review).toMatchObject({ state: "terminal", nextAction: "terminal_no_action" });
  expect(renderReport(run.id, ledger)).toContain("## Progress And Stagnation");
});

function setupOpenToyComputation() {
  const home = mkdtempSync(join(tmpdir(), "matematica-progress-test-"));
  homes.push(home);
  process.env.MATEMATICA_HOME = home;
  const paths = getAppPaths();
  const ledger = new Ledger(paths.dbPath);
  const artifacts = new ArtifactStore(paths.artifactsDir, ledger);
  const run = ledger.createRun({
    problem: "Prove 1 + 1 = 2",
    goal: "Find verified computation for this open problem.",
    successCriteria: ["Produce verifier-backed evidence"],
    workflow: "pflk",
    budget: { maxAttempts: 3, maxWorkers: 1 }
  });
  return { ledger, artifacts, run };
}

function event(type: LedgerEvent["type"], payload: Record<string, unknown>): LedgerEvent {
  return {
    id: `evt-${Math.random()}`,
    runId: "run-progress",
    type,
    payload,
    artifactIds: [],
    createdAt: new Date().toISOString()
  };
}

function score(subjectId: string, value: number): StoredScore {
  return {
    id: `score-${subjectId}`,
    runId: "run-progress",
    subjectId,
    scorer: "test",
    score: value,
    rubric: {},
    createdAt: new Date().toISOString()
  };
}
