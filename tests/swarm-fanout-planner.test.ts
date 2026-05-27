import { expect, test } from "bun:test";
import { buildDynamicSwarmFanoutPlan } from "../src/swarm-fanout-planner";

const usage = { attempts: 0, tokens: 0, usd: 0, elapsedMs: 0 };

test("dynamic fanout planner admits one PFLK loophole branch", () => {
  const plan = buildDynamicSwarmFanoutPlan({
    runId: "run_one",
    workflow: "pflk",
    phase: "loophole",
    cycle: 1,
    parentPhaseJobId: "job_phase",
    budget: { maxWorkers: 1, maxWallTimeMs: 10 },
    usage,
    reservePerWorker: { elapsedMs: 1 }
  });

  expect(plan.requestedWorkers).toBe(1);
  expect(plan.effectiveWorkers).toBe(1);
  expect(plan.branches).toHaveLength(1);
  expect(plan.branches[0]).toMatchObject({
    branch: 1,
    role: "loophole-search",
    capacityMode: "admitted"
  });
  expect(plan.deferredBranches).toHaveLength(0);
});

test("dynamic fanout planner diversifies four PFLK loophole branches", () => {
  const plan = buildDynamicSwarmFanoutPlan({
    runId: "run_four",
    workflow: "pflk",
    phase: "loophole",
    cycle: 1,
    parentPhaseJobId: "job_phase",
    budget: { maxWorkers: 4, maxWallTimeMs: 10 },
    usage,
    reservePerWorker: { elapsedMs: 1 }
  });

  expect(plan.branches.map((branch) => branch.role)).toEqual([
    "loophole-search",
    "counterexample-search",
    "assumption-auditor",
    "proof-obligation-mapper"
  ]);
  expect(new Set(plan.branches.map((branch) => branch.dedupeKey)).size).toBe(4);
  expect(plan.branches.every((branch) => branch.lineage.parentPhaseJobId === "job_phase")).toBe(true);
});

test("dynamic fanout planner diversifies sixteen GREE experiment branches", () => {
  const plan = buildDynamicSwarmFanoutPlan({
    runId: "run_sixteen",
    workflow: "gree",
    phase: "experiment",
    cycle: 1,
    parentPhaseJobId: "job_phase",
    budget: { maxWorkers: 16, maxWallTimeMs: 32 },
    usage,
    reservePerWorker: { elapsedMs: 1 }
  });

  expect(plan.requestedWorkers).toBe(16);
  expect(plan.effectiveWorkers).toBe(16);
  expect(plan.deferredBranches).toHaveLength(0);
  expect(plan.branches.map((branch) => branch.role).slice(0, 8)).toEqual([
    "experiment-search",
    "evolution-candidate",
    "counterexample-sweep",
    "parameter-sweeper",
    "proof-sketch-tester",
    "computational-verifier",
    "invariant-miner",
    "failure-reproducer"
  ]);
  expect(new Set(plan.branches.map((branch) => branch.role)).size).toBe(16);
  expect(new Set(plan.branches.map((branch) => branch.promptMutationHash)).size).toBe(16);
  expect(plan.diversityReport.ok).toBe(true);
});

test("high-fanout planner persists role quotas prompt mutations and provider model diversity constraints", () => {
  const plan = buildDynamicSwarmFanoutPlan({
    runId: "run_diversity",
    workflow: "pflk",
    phase: "loophole",
    cycle: 1,
    parentPhaseJobId: "job_phase",
    requestedWorkers: 32,
    budget: { maxWorkers: 32, maxWallTimeMs: 64 },
    usage,
    reservePerWorker: { elapsedMs: 1 },
    providerRoutes: [
      { provider: "openai", modelId: "gpt-5.5", mode: "ai-sdk" },
      { provider: "anthropic", modelId: "claude-opus-4.6", mode: "ai-sdk" },
      { provider: "cerebras", modelId: "llama3.1-8b", mode: "ai-sdk" },
      { provider: "local", modelId: "deterministic-branch", mode: "local-deterministic" }
    ],
    providerConcurrency: 32
  });

  expect(plan.effectiveWorkers).toBe(32);
  expect(plan.diversityPolicy.highFanoutThreshold).toBe(16);
  expect(plan.diversityPolicy.providerModelConstraint.explicitHeterogeneousRoutes).toBe(true);
  expect(plan.diversityReport.ok).toBe(true);
  expect(plan.diversityReport.uniqueRoleFamilies).toBe(8);
  expect(plan.diversityReport.uniqueProviderModelKeys).toBe(4);
  expect(plan.diversityReport.uniquePromptMutationHashes).toBe(32);
  expect(plan.diversityReport.roleFamilyCounts.every((item) => item.count <= item.maxBranches)).toBe(true);
  expect(plan.diversityReport.providerModelCounts.every((item) => item.count <= item.maxBranches)).toBe(true);
  expect(new Set(plan.branches.map((branch) => branch.promptMutation.mutationHash)).size).toBe(32);
  expect(new Set(plan.branches.map((branch) => `${branch.providerRoute.provider}/${branch.providerRoute.modelId}`)).size).toBe(4);
});

test("fanout planner respects explicit per-provider route caps before deferring overflow", () => {
  const plan = buildDynamicSwarmFanoutPlan({
    runId: "run_provider_caps",
    workflow: "pflk",
    phase: "loophole",
    cycle: 1,
    parentPhaseJobId: "job_phase",
    requestedWorkers: 10,
    budget: { maxWorkers: 10, maxWallTimeMs: 20 },
    usage,
    reservePerWorker: { elapsedMs: 1 },
    providerRoutes: [
      { provider: "openrouter", modelId: "openai/gpt-5.5", mode: "ai-sdk", providerConcurrency: 1 },
      { provider: "cerebras", modelId: "gpt-oss-120b", mode: "ai-sdk", providerConcurrency: 2 },
      { provider: "openai", modelId: "gpt-5.5", mode: "ai-sdk", providerConcurrency: 1 },
      { provider: "anthropic", modelId: "claude-opus-4-5", mode: "ai-sdk", providerConcurrency: 1 },
      { provider: "local", modelId: "deterministic-branch", mode: "local-deterministic", providerConcurrency: 1 }
    ]
  });

  expect(plan.effectiveWorkers).toBe(6);
  expect(plan.deferredBranches).toHaveLength(4);
  expect(plan.localRemoteConstraint.providerConcurrency).toBe(6);
  const counts = new Map<string, number>();
  for (const branch of plan.branches) {
    const key = `${branch.providerRoute.provider}/${branch.providerRoute.modelId}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  expect(counts.get("openrouter/openai/gpt-5.5")).toBe(1);
  expect(counts.get("cerebras/gpt-oss-120b")).toBe(2);
  expect(counts.get("openai/gpt-5.5")).toBe(1);
  expect(counts.get("anthropic/claude-opus-4-5")).toBe(1);
  expect(counts.get("local/deterministic-branch")).toBe(1);
});

test("high remote fanout requires heterogeneous provider model routes or waiver", () => {
  const collapsed = buildDynamicSwarmFanoutPlan({
    runId: "run_remote_collapse",
    workflow: "pflk",
    phase: "loophole",
    cycle: 1,
    parentPhaseJobId: "job_phase",
    requestedWorkers: 16,
    budget: { maxWorkers: 16, maxWallTimeMs: 32 },
    usage,
    reservePerWorker: { elapsedMs: 1 },
    providerRoutes: [
      { provider: "openrouter", modelId: "openai/gpt-5.5", mode: "ai-sdk", providerConcurrency: 16 }
    ]
  });

  expect(collapsed.diversityPolicy.providerModelConstraint).toMatchObject({
    minUniqueProviderModelKeys: 2,
    remoteProviderModelDiversityRequired: true,
    waiverAccepted: false
  });
  expect(collapsed.diversityReport.ok).toBe(false);
  expect(collapsed.diversityReport.issues.join("\n")).toContain("provider/model diversity below constraint 1/2");

  const waived = buildDynamicSwarmFanoutPlan({
    runId: "run_remote_waiver",
    workflow: "pflk",
    phase: "loophole",
    cycle: 1,
    parentPhaseJobId: "job_phase",
    requestedWorkers: 16,
    budget: { maxWorkers: 16, maxWallTimeMs: 32 },
    usage,
    reservePerWorker: { elapsedMs: 1 },
    providerRoutes: [
      { provider: "openrouter", modelId: "openai/gpt-5.5", mode: "ai-sdk", providerConcurrency: 16 }
    ],
    providerDiversityWaiver: {
      reason: "Only one paid provider has live approval for this bounded smoke run.",
      actor: "operator-cli"
    }
  });

  expect(waived.diversityReport.ok).toBe(true);
  expect(waived.providerDiversityWaiver?.waiverHash).toMatch(/^[a-f0-9]{64}$/);
});

test("dynamic fanout planner refuses dispatch for blocked one hundred worker plans", () => {
  const plan = buildDynamicSwarmFanoutPlan({
    runId: "run_hundred",
    workflow: "gree",
    phase: "experiment",
    cycle: 1,
    parentPhaseJobId: "job_phase",
    requestedWorkers: 100,
    budget: { maxWorkers: 100, maxAttempts: 0 },
    usage,
    reservePerWorker: { attempts: 1 }
  });

  expect(plan.capacityPlan.mode).toBe("blocked");
  expect(plan.effectiveWorkers).toBe(0);
  expect(plan.branches).toHaveLength(0);
  expect(plan.deferredBranches).toHaveLength(100);
});
