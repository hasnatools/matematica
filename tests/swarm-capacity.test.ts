import { expect, test } from "bun:test";
import { buildSwarmCapacityPlan } from "../src/swarm-capacity";

test("swarm capacity plan deterministically degrades fanout from run budgets", () => {
  const plan = buildSwarmCapacityPlan({
    runId: "run-capacity",
    scope: "admission",
    requestedWorkers: 100,
    budget: { maxAttempts: 3, maxWorkers: 100, maxUsd: 1 },
    usage: { attempts: 0, tokens: 0, usd: 0, elapsedMs: 0 },
    reservePerWorker: { attempts: 1, usd: 0.4 },
    deterministicOrder: Array.from({ length: 100 }, (_, index) => `worker-${index + 1}`)
  });

  expect(plan.mode).toBe("degraded");
  expect(plan.degraded).toBe(true);
  expect(plan.requestedWorkers).toBe(100);
  expect(plan.effectiveWorkers).toBe(2);
  expect(plan.limits.map((limit) => limit.kind)).toContain("attempt_budget");
  expect(plan.limits.map((limit) => limit.kind)).toContain("usd_budget");
  expect(plan.degradedPlan.admitted).toEqual(["worker-1", "worker-2"]);
  expect(plan.degradedPlan.deferred).toHaveLength(98);
  expect(plan.degradedPlan.obligationsPreserved).toBe(true);
  expect(plan.planHash).toMatch(/^[a-f0-9]{64}$/);
});

test("swarm capacity plan records provider and sub-agent capacity as first-class blockers", () => {
  const plan = buildSwarmCapacityPlan({
    runId: "run-capacity",
    scope: "scheduler_lease",
    requestedWorkers: 8,
    budget: { maxAttempts: 20, maxWorkers: 8 },
    usage: { attempts: 0, tokens: 0, usd: 0, elapsedMs: 0 },
    reservePerWorker: { attempts: 1 },
    availableJobs: 6,
    providerConcurrency: 2,
    subagentThreadLimit: 1
  });

  expect(plan.mode).toBe("degraded");
  expect(plan.effectiveWorkers).toBe(1);
  expect(plan.limits).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: "available_jobs", admitted: 6 }),
    expect.objectContaining({ kind: "provider_concurrency", admitted: 2 }),
    expect.objectContaining({ kind: "subagent_thread_limit", admitted: 1 })
  ]));
  expect(plan.reason).toContain("sub-agent thread capacity limit");
});
