import { expect, test } from "bun:test";
import {
  CANONICAL_MATEMATICA_PLAN_ID,
  CANONICAL_RELEASE_PLAN,
  type CanonicalReleasePlan
} from "../src/release-plan";
import {
  readReleaseLiveTodosSnapshot,
  validateReleaseLiveTodos,
  type ReleaseLiveTodosSnapshot,
  type ReleaseLiveTodoTask
} from "../src/release-todos";

test("live todos validation rejects low-entropy duplicated placeholder release work", () => {
  const repeatedPricingTasks = Array.from({ length: 8 }, (_, index): ReleaseLiveTodoTask => ({
    id: `pricing-${index.toString().padStart(4, "0")}-0000-0000-000000000000`,
    title: "Extract pricing [browser-task]",
    status: "pending",
    priority: "critical",
    plan_id: CANONICAL_MATEMATICA_PLAN_ID,
    tags: ["browser-task"]
  }));

  const validation = validateReleaseLiveTodos({
    snapshot: liveTodosSnapshot(repeatedPricingTasks)
  });

  expect(validation.ok).toBe(false);
  expect(validation.duplicateTitleGroupCount).toBe(1);
  expect(validation.placeholderTaskCount).toBe(8);
  expect(validation.entropyScorePermille).toBeLessThan(600);
  expect(validation.issues.map((issue) => issue.code)).toContain("live_todo_duplicate_title");
  expect(validation.issues.map((issue) => issue.code)).toContain("live_todo_placeholder");
  expect(validation.issues.map((issue) => issue.code)).toContain("live_todos_low_entropy");
});

test("live todos validation rejects active tasks superseded by the canonical plan", () => {
  const validation = validateReleaseLiveTodos({
    snapshot: liveTodosSnapshot([{
      id: "bbdd53b9-0000-0000-0000-000000000000",
      title: "Add OSS licensing citation and source-cache hygiene",
      status: "pending",
      priority: "medium",
      plan_id: CANONICAL_MATEMATICA_PLAN_ID,
      tags: ["math-cli", "oss", "licensing", "citations"]
    }])
  });

  expect(validation.ok).toBe(false);
  expect(validation.supersededActiveTaskCount).toBe(1);
  expect(validation.issues).toContainEqual(expect.objectContaining({
    code: "live_todo_superseded_still_active",
    taskId: "bbdd53b9"
  }));
});

test("live todos validation rejects canonical active critical blockers missing from real live todos", () => {
  const plan: CanonicalReleasePlan = {
    ...CANONICAL_RELEASE_PLAN,
    releaseBlockers: [{
      taskId: "abcd1234",
      title: "Represented release blocker",
      status: "pending",
      priority: "critical",
      owner: "cato",
      milestoneId: "m0-local-core",
      requiredCheckIds: ["canonical-release-plan"],
      acceptanceCriteria: ["Must appear in live todos-cli snapshots while active."]
    }]
  };

  const validation = validateReleaseLiveTodos({
    plan,
    snapshot: {
      ...liveTodosSnapshot([{
        id: "foreign-0000-0000-0000-000000000000",
        title: "Unrelated backlog",
        status: "pending",
        priority: "medium",
        plan_id: "foreign-plan",
        tags: ["foreign"]
      }]),
      source: "todos-cli"
    }
  });

  expect(validation.ok).toBe(false);
  expect(validation.missingActivePlanBlockerCount).toBe(1);
  expect(validation.issues).toContainEqual(expect.objectContaining({
    code: "live_plan_blocker_missing",
    taskId: "abcd1234"
  }));
});

test("live todos validation accepts empty todos-cli snapshots after all canonical blockers close", () => {
  const validation = validateReleaseLiveTodos({
    snapshot: {
      ...liveTodosSnapshot([]),
      source: "todos-cli"
    }
  });

  expect(validation.ok).toBe(true);
  expect(validation.releaseRelevantTaskCount).toBe(0);
  expect(validation.liveCriticalTaskCount).toBe(0);
  expect(validation.missingActivePlanBlockerCount).toBe(0);
});

test("live todos snapshot override rejects empty release workflow values", () => {
  const snapshot = readReleaseLiveTodosSnapshot({
    cwd: process.cwd(),
    env: {
      ...process.env,
      MATEMATICA_RELEASE_TODOS_SNAPSHOT_JSON: ""
    }
  });

  expect(snapshot).toEqual({
    error: expect.objectContaining({
      code: "live_todos_malformed"
    })
  });
});

test("live todos validation tolerates large project-wide snapshots when canonical release work is high entropy", () => {
  const unrelatedBacklog = Array.from({ length: 220 }, (_, index): ReleaseLiveTodoTask => ({
    id: `foreign-${index.toString().padStart(4, "0")}-0000-0000-000000000000`,
    title: `TAS${index}-00001: placeholder`,
    status: "pending",
    priority: "medium",
    plan_id: "not-the-matematica-plan",
    working_dir: "/tmp/other-project",
    tags: ["foreign"]
  }));
  const representedCritical: ReleaseLiveTodoTask[] = [];
  const validation = validateReleaseLiveTodos({
    snapshot: liveTodosSnapshot([...unrelatedBacklog, ...representedCritical])
  });

  expect(JSON.stringify(liveTodosSnapshot([...unrelatedBacklog, ...representedCritical])).length).toBeGreaterThan(8192);
  expect(validation.ok).toBe(true);
  expect(validation.liveCriticalTaskCount).toBe(0);
  expect(validation.releaseRelevantTaskCount).toBe(0);
});

function liveTodosSnapshot(tasks: ReleaseLiveTodoTask[]): ReleaseLiveTodosSnapshot {
  return {
    format: "matematica.release-live-todos",
    version: 1,
    source: "unit-test-fixture:release-todos",
    tasks
  };
}
