import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBlindFinalizationCriticReviews, persistAdversarialQuorumReview } from "../src/adversarial-quorum";
import { ArtifactStore } from "../src/artifacts";
import { emptyUsage, type BudgetUsage } from "../src/budget";
import { buildGoalSuccessDecisionToken } from "../src/goal-success";
import { Ledger } from "../src/ledger";
import { getAppPaths } from "../src/paths";
import { effectiveMaxWorkers, rankWorkerTournament, remainingBudgetJobCapacity, runWorkerQueue } from "../src/scheduler";

const homes: string[] = [];

function budgetUsage(overrides: Partial<BudgetUsage>): BudgetUsage {
  return { ...emptyUsage(), ...overrides };
}

function setup() {
  const home = mkdtempSync(join(tmpdir(), "matematica-scheduler-test-"));
  homes.push(home);
  process.env.MATEMATICA_HOME = home;
  const paths = getAppPaths();
  const ledger = new Ledger(paths.dbPath);
  const run = ledger.createRun({
    problem: "Explore a finite problem",
    goal: "Run workers until budget is met",
    successCriteria: ["workers are durable"],
    workflow: "gree",
    budget: { maxAttempts: 10, maxWorkers: 4 }
  });
  return { ledger, run };
}

afterEach(() => {
  delete process.env.MATEMATICA_HOME;
  while (homes.length > 0) {
    rmSync(homes.pop()!, { recursive: true, force: true });
  }
});

type WorkerProcessResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

async function runWorkerProcess(
  workerScript: string,
  home: string,
  runId: string,
  workerId: string
): Promise<WorkerProcessResult> {
  return await new Promise((resolve) => {
    const child = spawn("bun", [workerScript, runId, workerId], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MATEMATICA_HOME: home
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

test("worker queue leases commits and ledgers transitions", async () => {
  const { ledger, run } = setup();
  try {
    ledger.enqueueWorkerJob({ runId: run.id, kind: "experiment", payload: { n: 1 } });
    ledger.enqueueWorkerJob({ runId: run.id, kind: "experiment", payload: { n: 2 } });

    const result = await runWorkerQueue({
      runId: run.id,
      ledger,
      workerId: "tester",
      maxWorkers: 2,
      executor: async (job) => ({ seen: job.payload.n })
    });

    expect(result.committed).toBe(2);
    expect(ledger.listWorkerJobs(run.id).every((job) => job.status === "committed")).toBe(true);
    const eventTypes = ledger.listEvents(run.id).map((event) => event.type);
    expect(eventTypes).toContain("worker.enqueued");
    expect(eventTypes).toContain("worker.leased");
    expect(eventTypes).toContain("worker.started");
    expect(eventTypes).toContain("worker.heartbeat");
    expect(eventTypes).toContain("worker.committed");
    expect(eventTypes).toContain("budget.reserved");
    expect(eventTypes).toContain("budget.debited");
  } finally {
    ledger.close();
  }
});

test("worker lease state-machine events carry actor reason attempt expiry reservation and prior state", async () => {
  const { ledger, run } = setup();
  try {
    const job = ledger.enqueueWorkerJob({ runId: run.id, kind: "experiment", payload: { n: 1 } });

    await runWorkerQueue({
      runId: run.id,
      ledger,
      workerId: "state-machine-worker",
      maxWorkers: 1,
      leaseMs: 60_000,
      executor: async () => ({ ok: true })
    });

    const events = ledger.listEvents(run.id).filter((event) => event.payload.jobId === job.id);
    const byType = new Map(events.map((event) => [event.type, event]));
    for (const type of ["worker.enqueued", "worker.leased", "worker.reservation_bound", "worker.started", "worker.heartbeat", "worker.committed", "worker.completed"] as const) {
      expect(byType.get(type)?.payload.workerLeaseStateMachine).toMatchObject({
        version: "worker-lease-state-machine-v1",
        jobId: job.id
      });
      expect(byType.get(type)?.payload.actor).toBeString();
      expect(byType.get(type)?.payload.reason).toBeString();
      expect(byType.get(type)?.payload.priorState).toBeString();
      expect(byType.get(type)?.payload.nextState).toBeString();
      expect(byType.get(type)?.payload.attempt).toBeNumber();
      expect(byType.get(type)?.payload.reservationId).toBeString();
    }

    expect(byType.get("worker.enqueued")?.payload.nextState).toBe("queued");
    expect(byType.get("worker.leased")?.payload.nextState).toBe("leased");
    expect(byType.get("worker.started")?.payload.nextState).toBe("running");
    expect(byType.get("worker.committed")?.payload.nextState).toBe("committed");
    expect(byType.get("worker.completed")?.payload.nextState).toBe("committed");
    expect(byType.get("worker.leased")?.payload.leaseExpiresAt).toBeString();
    expect(byType.get("worker.heartbeat")?.payload.leaseExpiresAt).toBeString();
  } finally {
    ledger.close();
  }
});

test("worker queue deduplicates equivalent jobs before leasing", () => {
  const { ledger, run } = setup();
  try {
    const first = ledger.enqueueWorkerJob({ runId: run.id, kind: "experiment", payload: { n: 1, mode: "same" } });
    const second = ledger.enqueueWorkerJob({ runId: run.id, kind: "experiment", payload: { mode: "same", n: 1 } });

    expect(second.id).toBe(first.id);
    expect(ledger.listWorkerJobs(run.id)).toHaveLength(1);
    expect(ledger.listEvents(run.id).map((event) => event.type)).toContain("worker.deduplicated");
  } finally {
    ledger.close();
  }
});

test("worker tournament ranking orders committed jobs by evidence and score", async () => {
  const { ledger, run } = setup();
  try {
    ledger.enqueueWorkerJob({ runId: run.id, kind: "workflow.branch", payload: { phase: "experiment", branch: "weak" } });
    ledger.enqueueWorkerJob({ runId: run.id, kind: "workflow.branch", payload: { phase: "experiment", branch: "strong" } });
    ledger.enqueueWorkerJob({ runId: run.id, kind: "workflow.branch", payload: { phase: "feedback", branch: "ignored" } });

    await runWorkerQueue({
      runId: run.id,
      ledger,
      workerId: "tester",
      maxWorkers: 3,
      executor: async (job) => {
        if (job.payload.branch === "strong") {
          return { score: 0.8, evidenceGrade: "verified_computation", artifactId: "artifact-strong" };
        }
        if (job.payload.branch === "weak") {
          return { score: 0.9, evidenceGrade: "heuristic_evidence" };
        }
        return { score: 1, evidenceGrade: "formal_proof" };
      }
    });

    const ranked = rankWorkerTournament({
      ledger,
      runId: run.id,
      kind: "workflow.branch",
      phase: "experiment"
    });

    expect(ranked.map((entry) => entry.payload.branch)).toEqual(["strong", "weak"]);
    expect(ranked[0].rank).toBe(1);
    expect(ranked[0].reasons).toContain("evidence-grade:verified_computation");
    expect(ledger.listEvents(run.id).map((event) => event.type)).toContain("worker.ranked");
  } finally {
    ledger.close();
  }
});

test("worker tournament ranking suppresses duplicate branch outputs", async () => {
  const { ledger, run } = setup();
  try {
    ledger.enqueueWorkerJob({ runId: run.id, kind: "workflow.branch", payload: { phase: "experiment", branch: "first" } });
    ledger.enqueueWorkerJob({ runId: run.id, kind: "workflow.branch", payload: { phase: "experiment", branch: "duplicate" } });
    ledger.enqueueWorkerJob({ runId: run.id, kind: "workflow.branch", payload: { phase: "experiment", branch: "novel" } });

    await runWorkerQueue({
      runId: run.id,
      ledger,
      workerId: "tester",
      maxWorkers: 3,
      executor: async (job) => {
        if (job.payload.branch === "novel") {
          return { score: 0.65, evidenceGrade: "heuristic_evidence", text: "A distinct invariant search found a parity obstruction." };
        }
        return { score: 0.95, evidenceGrade: "heuristic_evidence", text: "Identical branch answer: try induction on n and close by algebra." };
      }
    });

    const ranked = rankWorkerTournament({
      ledger,
      runId: run.id,
      kind: "workflow.branch",
      phase: "experiment"
    });

    const suppressed = ranked.find((entry) => entry.suppressed);
    const novelRank = ranked.find((entry) => entry.payload.branch === "novel")?.rank;
    expect(["first", "duplicate"]).toContain(String(suppressed?.payload.branch));
    expect(suppressed?.duplicateOfJobId).toBeTruthy();
    expect(novelRank).toBeLessThan(suppressed!.rank);
    expect(suppressed?.reasons.some((reason) => reason.startsWith("duplicate-output-suppressed:"))).toBe(true);
    const rankingEvent = ledger.listEvents(run.id).findLast((event) => event.type === "worker.ranked");
    expect(JSON.stringify(rankingEvent?.payload)).toContain("duplicate-output-suppressed");
  } finally {
    ledger.close();
  }
});

test("worker mutations require matching lease owner and attempt", async () => {
  const { ledger, run } = setup();
  try {
    ledger.enqueueWorkerJob({ runId: run.id, kind: "experiment", payload: { n: 1 } });
    const [leased] = ledger.leaseWorkerJobs(run.id, "owner-a", 1, 60_000);

    expect(() => ledger.markWorkerJobRunning(leased.id, "owner-b", leased.attempts))
      .toThrow("lease owner mismatch");
    expect(() => ledger.commitWorkerJob(leased.id, "owner-b", leased.attempts, {}))
      .toThrow("lease owner mismatch");
    expect(() => ledger.failWorkerJob(leased.id, "owner-a", leased.attempts + 1, "bad"))
      .toThrow("attempt mismatch");
    expect(() => ledger.cancelWorkerJob(leased.id, "bad cancel", "owner-b", leased.attempts))
      .toThrow("lease owner mismatch");

    ledger.markWorkerJobRunning(leased.id, "owner-a", leased.attempts);
    ledger.heartbeatWorkerJob(leased.id, "owner-a", leased.attempts, 60_000);
    ledger.commitWorkerJob(leased.id, "owner-a", leased.attempts, { ok: true });
    expect(ledger.requireWorkerJob(leased.id).status).toBe("committed");
  } finally {
    ledger.close();
  }
});

test("duplicate lease heartbeat and late commit are auditable state-machine fixtures", async () => {
  const { ledger, run } = setup();
  try {
    const job = ledger.enqueueWorkerJob({ runId: run.id, kind: "experiment", payload: { n: 1 }, maxAttempts: 2 });
    const [leased] = ledger.leaseWorkerJobs(run.id, "owner-a", 1, 60_000, ["reservation-manual"]);
    expect(leased.id).toBe(job.id);
    expect(ledger.leaseWorkerJobs(run.id, "owner-b", 1, 60_000)).toEqual([]);

    ledger.heartbeatWorkerJob(leased.id, "owner-a", leased.attempts, 60_000);
    ledger.heartbeatWorkerJob(leased.id, "owner-a", leased.attempts, 60_000);
    expect(ledger.listEvents(run.id).filter((event) => event.type === "worker.heartbeat")).toHaveLength(2);

    const [stale] = ledger.reconcileStaleWorkerJobs(run.id, "9999-01-01T00:00:00.000Z", "test-reaper");
    expect(stale.id).toBe(job.id);
    expect(ledger.requireWorkerJob(job.id).status).toBe("failed_retryable");
    expect(() => ledger.commitWorkerJob(job.id, "owner-a", leased.attempts, { late: true }))
      .toThrow("lease owner mismatch");
    const ignored = ledger.listEvents(run.id).findLast((event) => event.type === "worker.mutation.ignored");
    expect(ignored?.payload).toMatchObject({
      jobId: job.id,
      action: "commit",
      reason: "lease_owner_mismatch",
      priorState: "queued",
      nextState: "queued",
      reservationId: "reservation-manual"
    });
  } finally {
    ledger.close();
  }
});

test("revoked worker leases become audited cancelled jobs and reject late commits", async () => {
  const { ledger, run } = setup();
  try {
    const job = ledger.enqueueWorkerJob({ runId: run.id, kind: "experiment", payload: { n: 1 } });
    const [leased] = ledger.leaseWorkerJobs(run.id, "revoked-worker", 1, 60_000, ["reservation-revoked"]);
    ledger.markWorkerJobRunning(leased.id, "revoked-worker", leased.attempts);

    const revoked = ledger.revokeWorkerJob(leased.id, "operator revoked compromised worker", "operator");

    expect(revoked.status).toBe("cancelled");
    const revokeEvent = ledger.listEvents(run.id).find((event) => event.type === "worker.revoked");
    expect(revokeEvent?.payload).toMatchObject({
      jobId: job.id,
      actor: "operator",
      reason: "operator revoked compromised worker",
      priorState: "running",
      nextState: "revoked",
      reservationId: "reservation-revoked"
    });
    expect(() => ledger.commitWorkerJob(leased.id, "revoked-worker", leased.attempts, { late: true }))
      .toThrow("lease owner mismatch");
    const ignored = ledger.listEvents(run.id).findLast((event) => event.type === "worker.mutation.ignored");
    expect(ignored?.payload.reason).toBe("lease_owner_mismatch");
  } finally {
    ledger.close();
  }
});

test("worker mutations reject expired leases", async () => {
  const { ledger, run } = setup();
  try {
    ledger.enqueueWorkerJob({ runId: run.id, kind: "experiment", payload: { n: 1 } });
    const [leased] = ledger.leaseWorkerJobs(run.id, "owner-a", 1, -1);

    expect(() => ledger.markWorkerJobRunning(leased.id, "owner-a", leased.attempts))
      .toThrow("lease expired");
  } finally {
    ledger.close();
  }
});

test("system cancellation can cancel leased jobs without worker ownership", async () => {
  const { ledger, run } = setup();
  try {
    ledger.enqueueWorkerJob({ runId: run.id, kind: "experiment", payload: { n: 1 } });
    ledger.leaseWorkerJobs(run.id, "owner-a", 1, 60_000);

    const cancelled = ledger.cancelPendingWorkerJobs(run.id, "operator stop");
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0].status).toBe("cancelled");
  } finally {
    ledger.close();
  }
});

test("stale leased jobs reconcile to retryable or terminal failure", async () => {
  const { ledger, run } = setup();
  try {
    ledger.enqueueWorkerJob({ runId: run.id, kind: "experiment", payload: { n: 1 }, maxAttempts: 2 });
    ledger.enqueueWorkerJob({ runId: run.id, kind: "experiment", payload: { n: 2 }, maxAttempts: 1 });
    ledger.leaseWorkerJobs(run.id, "owner-a", 2, -1);

    const reconciled = ledger.reconcileStaleWorkerJobs(run.id);
    const retryable = ledger.listWorkerJobs(run.id).find((job) => job.payload.n === 1)!;
    const terminal = ledger.listWorkerJobs(run.id).find((job) => job.payload.n === 2)!;
    expect(reconciled.map((job) => job.id).sort()).toEqual([retryable.id, terminal.id].sort());
    expect(ledger.requireWorkerJob(retryable.id).status).toBe("failed_retryable");
    expect(ledger.requireWorkerJob(terminal.id).status).toBe("failed_terminal");
    expect(ledger.listEvents(run.id).filter((event) => event.type === "worker.reconciled")).toHaveLength(2);
    expect(ledger.listEvents(run.id).filter((event) => event.type === "worker.quarantined")).toHaveLength(1);
  } finally {
    ledger.close();
  }
});

test("slow workers keep leases alive with periodic heartbeats", async () => {
  const { ledger, run } = setup();
  try {
    const job = ledger.enqueueWorkerJob({ runId: run.id, kind: "experiment", payload: { slow: true }, maxAttempts: 1 });

    const result = await runWorkerQueue({
      runId: run.id,
      ledger,
      workerId: "slow-worker",
      maxWorkers: 1,
      leaseMs: 50,
      heartbeatMs: 20,
      executor: async () => {
        await new Promise((resolve) => setTimeout(resolve, 125));
        return { ok: true };
      }
    });

    expect(result.committed).toBe(1);
    expect(ledger.requireWorkerJob(job.id).status).toBe("committed");
    expect(ledger.listEvents(run.id).filter((event) => event.type === "worker.heartbeat").length).toBeGreaterThan(1);
    expect(ledger.listEvents(run.id).filter((event) => event.type === "worker.reconciled")).toHaveLength(0);
  } finally {
    ledger.close();
  }
});

test("dead worker leases are reaped and retried by another worker", async () => {
  const { ledger, run } = setup();
  try {
    const job = ledger.enqueueWorkerJob({ runId: run.id, kind: "experiment", payload: { retry: true }, maxAttempts: 2 });
    const [leased] = ledger.leaseWorkerJobs(run.id, "dead-worker", 1, -1);
    expect(leased.id).toBe(job.id);

    const result = await runWorkerQueue({
      runId: run.id,
      ledger,
      workerId: "rescuer",
      reaperId: "test-reaper",
      maxWorkers: 1,
      executor: async () => ({ rescued: true })
    });

    const updated = ledger.requireWorkerJob(job.id);
    expect(result.committed).toBe(1);
    expect(updated.status).toBe("committed");
    expect(updated.attempts).toBe(2);
    const reconciled = ledger.listEvents(run.id).find((event) => event.type === "worker.reconciled");
    expect(reconciled?.payload).toMatchObject({
      jobId: job.id,
      status: "failed_retryable",
      reaperId: "test-reaper"
    });
  } finally {
    ledger.close();
  }
});

test("poison stale jobs quarantine when max attempts are exhausted", async () => {
  const { ledger, run } = setup();
  try {
    const job = ledger.enqueueWorkerJob({ runId: run.id, kind: "experiment", payload: { poison: true }, maxAttempts: 1 });
    ledger.leaseWorkerJobs(run.id, "dead-worker", 1, -1);

    const reconciled = ledger.reconcileStaleWorkerJobs(run.id, undefined, "poison-reaper");
    expect(reconciled).toHaveLength(1);
    expect(ledger.requireWorkerJob(job.id).status).toBe("failed_terminal");
    expect(ledger.countLeasableWorkerJobs(run.id)).toBe(0);
    const quarantine = ledger.listEvents(run.id).find((event) => event.type === "worker.quarantined");
    expect(quarantine?.payload).toMatchObject({
      jobId: job.id,
      attempts: 1,
      maxAttempts: 1,
      reaperId: "poison-reaper"
    });
  } finally {
    ledger.close();
  }
});

test("scheduler honors max worker cap", async () => {
  expect(effectiveMaxWorkers({ maxWorkers: 4 }, 16)).toBe(4);
  expect(effectiveMaxWorkers({}, 16)).toBe(16);
  expect(effectiveMaxWorkers({ maxWorkers: 0 }, 16)).toBe(1);
  expect(remainingBudgetJobCapacity({ maxAttempts: 3 }, budgetUsage({ attempts: 1 }), { attempts: 1 })).toBe(2);
});

test("scheduler does not lease more workers than remaining attempt budget", async () => {
  const home = mkdtempSync(join(tmpdir(), "matematica-lease-budget-test-"));
  homes.push(home);
  process.env.MATEMATICA_HOME = home;
  const ledger = new Ledger(getAppPaths().dbPath);
  const run = ledger.createRun({
    problem: "One attempt only",
    goal: "Avoid overspending parallel leases",
    successCriteria: ["only one worker runs"],
    workflow: "gree",
    budget: { maxAttempts: 1, maxWorkers: 8 }
  });
  try {
    for (let index = 0; index < 4; index += 1) {
      ledger.enqueueWorkerJob({ runId: run.id, kind: "experiment", payload: { index } });
    }

    const result = await runWorkerQueue({
      runId: run.id,
      ledger,
      workerId: "tester",
      maxWorkers: 4,
      executor: async (job) => ({ index: job.payload.index })
    });

    const jobs = ledger.listWorkerJobs(run.id);
    expect(result.committed).toBe(1);
    expect(result.budgetExhausted).toBe(true);
    expect(jobs.filter((job) => job.status === "committed")).toHaveLength(1);
    expect(jobs.filter((job) => job.status === "cancelled")).toHaveLength(3);
    expect(ledger.getBudgetUsage(run.id).attempts).toBe(1);
  } finally {
    ledger.close();
  }
});

test("scheduler caps 100 requested workers at remaining attempt budget", async () => {
  const home = mkdtempSync(join(tmpdir(), "matematica-100-worker-budget-test-"));
  homes.push(home);
  process.env.MATEMATICA_HOME = home;
  const ledger = new Ledger(getAppPaths().dbPath);
  const artifacts = new ArtifactStore(getAppPaths().artifactsDir, ledger);
  const run = ledger.createRun({
    problem: "Many parallel workers",
    goal: "Do not overspend attempts",
    successCriteria: ["attempt budget is hard"],
    workflow: "gree",
    budget: { maxAttempts: 7, maxWorkers: 100 }
  });
  try {
    for (let index = 0; index < 100; index += 1) {
      ledger.enqueueWorkerJob({ runId: run.id, kind: "experiment", payload: { index } });
    }

    const result = await runWorkerQueue({
      runId: run.id,
      ledger,
      artifacts,
      workerId: "tester",
      maxWorkers: 100,
      executor: async (job) => ({ index: job.payload.index })
    });

    const jobs = ledger.listWorkerJobs(run.id);
    expect(result.committed).toBe(7);
    expect(result.budgetExhausted).toBe(true);
    expect(jobs.filter((job) => job.status === "committed")).toHaveLength(7);
    expect(jobs.filter((job) => job.status === "cancelled")).toHaveLength(93);
    expect(ledger.getBudgetUsage(run.id).attempts).toBe(7);
    const capacity = ledger.listEvents(run.id)
      .find((event) => event.type === "swarm.capacity.reviewed" && event.payload.scope === "scheduler_lease");
    expect(capacity?.payload).toMatchObject({
      requestedWorkers: 100,
      effectiveWorkers: 7,
      degraded: true,
      mode: "degraded"
    });
    const capacityArtifact = ledger.listArtifacts(run.id)
      .find((artifact) => artifact.id === capacity?.payload.artifactId);
    expect(capacityArtifact?.kind).toBe("swarm.capacity.plan");
  } finally {
    ledger.close();
  }
});

test("100 independent worker processes contend without duplicate leases or double debits", async () => {
  const home = mkdtempSync(join(tmpdir(), "matematica-process-lease-race-"));
  homes.push(home);
  process.env.MATEMATICA_HOME = home;
  const ledger = new Ledger(getAppPaths().dbPath);
  const run = ledger.createRun({
    problem: "Many independent CLI workers",
    goal: "Lease every job exactly once",
    successCriteria: ["no duplicate commits", "no double debits", "no stale leases"],
    workflow: "gree",
    budget: { maxAttempts: 200, maxWorkers: 100 }
  });
  try {
    for (let index = 0; index < 100; index += 1) {
      ledger.enqueueWorkerJob({
        runId: run.id,
        kind: "experiment",
        payload: {
          index,
          delayMs: index % 3
        },
        maxAttempts: 1
      });
    }
    ledger.close();

    const workerScript = join(process.cwd(), "tests/fixtures/sqlite-lease-worker.ts");
    const results = await Promise.all(Array.from({ length: 100 }, (_, index) =>
      runWorkerProcess(workerScript, home, run.id, `worker-process-${index}`)
    ));

    expect(results.every((result) => result.exitCode === 0)).toBe(true);
    const reader = new Ledger(getAppPaths().dbPath);
    try {
      const jobs = reader.listWorkerJobs(run.id);
      expect(jobs).toHaveLength(100);
      expect(jobs.every((job) => job.status === "committed")).toBe(true);
      expect(jobs.every((job) => !job.leaseOwner && !job.leaseExpiresAt)).toBe(true);
      expect(reader.getBudgetUsage(run.id).attempts).toBe(100);
      expect(reader.listOpenBudgetReservations(run.id)).toHaveLength(0);

      const events = reader.listEvents(run.id);
      const committed = events.filter((event) => event.type === "worker.committed");
      const completed = events.filter((event) => event.type === "worker.completed");
      const debited = events.filter((event) => event.type === "budget.debited");
      expect(committed).toHaveLength(100);
      expect(completed).toHaveLength(100);
      expect(debited).toHaveLength(100);
      expect(new Set(committed.map((event) => event.payload.jobId)).size).toBe(100);
      expect(new Set(completed.map((event) => event.payload.jobId)).size).toBe(100);
      expect(events.filter((event) => event.type === "worker.failed")).toHaveLength(0);
      expect(events.filter((event) => event.type === "worker.reconciled")).toHaveLength(0);
      const sequences = events.map((event) => event.sequence);
      expect(sequences.every((sequence): sequence is number => typeof sequence === "number")).toBe(true);
      const numericSequences = sequences as number[];
      expect(new Set(numericSequences).size).toBe(numericSequences.length);
      expect(numericSequences).toEqual([...numericSequences].sort((a, b) => a - b));
    } finally {
      reader.close();
    }
  } finally {
    process.env.MATEMATICA_HOME = home;
  }
});

test("scheduler applies token usd and wall-time reservation caps", () => {
  expect(remainingBudgetJobCapacity(
    { maxTokens: 25 },
    budgetUsage({ tokens: 5 }),
    { tokens: 10 }
  )).toBe(2);
  expect(remainingBudgetJobCapacity(
    { maxUsd: 1 },
    budgetUsage({ usd: 0.4 }),
    { usd: 0.25 }
  )).toBe(2);
  expect(remainingBudgetJobCapacity(
    { maxWallTimeMs: 1_000 },
    budgetUsage({ elapsedMs: 250 }),
    { elapsedMs: 300 }
  )).toBe(2);
});

test("scheduler enforces token budget after preserving committed worker artifacts", async () => {
  const home = mkdtempSync(join(tmpdir(), "matematica-token-stop-test-"));
  homes.push(home);
  process.env.MATEMATICA_HOME = home;
  const paths = getAppPaths();
  const ledger = new Ledger(paths.dbPath);
  const artifacts = new ArtifactStore(paths.artifactsDir, ledger);
  const run = ledger.createRun({
    problem: "Token-limited worker run",
    goal: "Stop after best artifact",
    successCriteria: ["best artifact is preserved"],
    workflow: "gree",
    budget: { maxTokens: 5, maxWorkers: 1 }
  });
  try {
    ledger.enqueueWorkerJob({ runId: run.id, kind: "experiment", payload: { index: 0 } });
    ledger.enqueueWorkerJob({ runId: run.id, kind: "experiment", payload: { index: 1 } });

    const result = await runWorkerQueue({
      runId: run.id,
      ledger,
      workerId: "tester",
      maxWorkers: 1,
      reservePerJob: { tokens: 5 },
      executor: async (job) => {
        const artifact = artifacts.create(run.id, "experiment.best", JSON.stringify({ index: job.payload.index }));
        return { artifactId: artifact.id, index: job.payload.index };
      }
    });

    const jobs = ledger.listWorkerJobs(run.id);
    const committed = jobs.find((job) => job.status === "committed");
    const cancelled = jobs.find((job) => job.status === "cancelled");
    expect(result.committed).toBe(1);
    expect(result.budgetExhausted).toBe(true);
    expect(ledger.requireRun(run.id).status).toBe("budget_exhausted");
    expect(committed).toBeTruthy();
    expect(cancelled).toBeTruthy();
    expect(committed?.payload.index).not.toBe(cancelled?.payload.index);
    expect(ledger.listArtifacts(run.id).map((artifact) => artifact.kind)).toContain("experiment.best");
    expect(ledger.getBudgetUsage(run.id).tokens).toBe(5);
  } finally {
    ledger.close();
  }
});

test("scheduler enforces USD and wall-time budgets before leasing work", async () => {
  const usdHome = mkdtempSync(join(tmpdir(), "matematica-usd-stop-test-"));
  homes.push(usdHome);
  process.env.MATEMATICA_HOME = usdHome;
  const usdLedger = new Ledger(getAppPaths().dbPath);
  const usdRun = usdLedger.createRun({
    problem: "USD-limited worker run",
    goal: "Stop before paid work",
    successCriteria: ["USD cap stops worker"],
    workflow: "gree",
    budget: { maxUsd: 0.1, maxWorkers: 1 }
  });
  try {
    usdLedger.enqueueWorkerJob({ runId: usdRun.id, kind: "experiment", payload: { budget: "usd" } });
    let calls = 0;
    const result = await runWorkerQueue({
      runId: usdRun.id,
      ledger: usdLedger,
      workerId: "tester",
      maxWorkers: 1,
      reservePerJob: { usd: 0.11 },
      executor: async () => {
        calls += 1;
        return {};
      }
    });
    expect(calls).toBe(0);
    expect(result.budgetExhausted).toBe(true);
    expect(usdLedger.requireRun(usdRun.id).status).toBe("budget_exhausted");
  } finally {
    usdLedger.close();
  }

  const wallTimeHome = mkdtempSync(join(tmpdir(), "matematica-wall-time-stop-test-"));
  homes.push(wallTimeHome);
  process.env.MATEMATICA_HOME = wallTimeHome;
  const wallTimeLedger = new Ledger(getAppPaths().dbPath);
  const wallTimeRun = wallTimeLedger.createRun({
    problem: "Wall-time-limited worker run",
    goal: "Stop before slow work",
    successCriteria: ["wall-time cap stops worker"],
    workflow: "gree",
    budget: { maxWallTimeMs: 10, maxWorkers: 1 }
  });
  try {
    wallTimeLedger.enqueueWorkerJob({ runId: wallTimeRun.id, kind: "experiment", payload: { budget: "wall-time" } });
    let calls = 0;
    const result = await runWorkerQueue({
      runId: wallTimeRun.id,
      ledger: wallTimeLedger,
      workerId: "tester",
      maxWorkers: 1,
      reservePerJob: { elapsedMs: 11 },
      executor: async () => {
        calls += 1;
        return {};
      }
    });
    expect(calls).toBe(0);
    expect(result.budgetExhausted).toBe(true);
    expect(wallTimeLedger.requireRun(wallTimeRun.id).status).toBe("budget_exhausted");
  } finally {
    wallTimeLedger.close();
  }
});

test("scheduler refuses zero-cost local swarm reservations", async () => {
  const { ledger, run } = setup();
  try {
    ledger.enqueueWorkerJob({ runId: run.id, kind: "experiment", payload: { free: true } });

    await expect(runWorkerQueue({
      runId: run.id,
      ledger,
      workerId: "tester",
      maxWorkers: 2,
      reservePerJob: { attempts: 0, tokens: 0, usd: 0, elapsedMs: 0 },
      executor: async () => ({ shouldNotRun: true })
    })).rejects.toThrow("zero-cost local swarm work");

    expect(ledger.listWorkerJobs(run.id)[0].status).toBe("pending");
    expect(ledger.listEvents(run.id).map((event) => event.type)).not.toContain("worker.leased");
  } finally {
    ledger.close();
  }
});

test("scheduler debits measured worker elapsed time instead of only the reservation estimate", async () => {
  const { ledger, run } = setup();
  try {
    ledger.enqueueWorkerJob({ runId: run.id, kind: "experiment", payload: { slow: true } });

    const result = await runWorkerQueue({
      runId: run.id,
      ledger,
      workerId: "elapsed-worker",
      maxWorkers: 1,
      reservePerJob: { attempts: 1, elapsedMs: 1 },
      executor: async () => {
        await new Promise((resolve) => setTimeout(resolve, 35));
        return { ok: true };
      }
    });

    expect(result.committed).toBe(1);
    expect(ledger.getBudgetUsage(run.id).elapsedMs).toBeGreaterThanOrEqual(25);
    const debit = ledger.listEvents(run.id).find((event) => event.type === "budget.debited");
    expect(debit?.payload.overReservationPolicy).toMatchObject({
      allowedDimensions: ["elapsedMs"]
    });
  } finally {
    ledger.close();
  }
});

test("scheduler aborts hung workers at the remaining wall-time deadline", async () => {
  const home = mkdtempSync(join(tmpdir(), "matematica-hung-wall-time-test-"));
  homes.push(home);
  process.env.MATEMATICA_HOME = home;
  const ledger = new Ledger(getAppPaths().dbPath);
  const run = ledger.createRun({
    problem: "Hung worker",
    goal: "Deadline cancels in-flight work",
    successCriteria: ["wall-time budget is authoritative"],
    workflow: "gree",
    budget: { maxAttempts: 2, maxWorkers: 1, maxWallTimeMs: 45 }
  });
  try {
    const job = ledger.enqueueWorkerJob({ runId: run.id, kind: "experiment", payload: { hung: true } });
    let observedAbort = false;

    const result = await runWorkerQueue({
      runId: run.id,
      ledger,
      workerId: "deadline-worker",
      maxWorkers: 1,
      reservePerJob: { attempts: 1, elapsedMs: 1 },
      cancellationPollMs: 10,
      executor: async (_job, context) => {
        await new Promise<void>((resolve) => {
          context.signal.addEventListener("abort", () => {
            observedAbort = true;
            resolve();
          }, { once: true });
        });
        throw new Error("worker observed deadline abort");
      }
    });

    expect(result.failed).toBe(1);
    expect(observedAbort).toBe(true);
    expect(ledger.requireWorkerJob(job.id).status).toBe("cancelled");
    expect(ledger.requireRun(run.id).status).toBe("budget_exhausted");
    expect(ledger.getBudgetUsage(run.id).elapsedMs).toBeGreaterThanOrEqual(40);
    expect(ledger.listOpenBudgetReservations(run.id)).toHaveLength(0);
    expect(ledger.listEvents(run.id).find((event) => event.type === "goal.completed")?.payload.reason)
      .toContain("wall-time budget exhausted");
  } finally {
    ledger.close();
  }
});

test("scheduler cancels in-flight fanout when the run is cancelled", async () => {
  const { ledger, run } = setup();
  try {
    for (let index = 0; index < 3; index += 1) {
      ledger.enqueueWorkerJob({ runId: run.id, kind: "experiment", payload: { index } });
    }
    let enteredWorkers = 0;
    let abortedWorkers = 0;

    const result = await runWorkerQueue({
      runId: run.id,
      ledger,
      workerId: "fanout-cancel-worker",
      maxWorkers: 2,
      reservePerJob: { attempts: 1, elapsedMs: 1 },
      cancellationPollMs: 10,
      executor: async (_job, context) => {
        enteredWorkers += 1;
        if (enteredWorkers === 2) {
          ledger.updateRunStatus(run.id, "cancelled");
        }
        if (context.signal.aborted) {
          abortedWorkers += 1;
          return { shouldNotCommit: true };
        }
        await new Promise<void>((resolve) => {
          context.signal.addEventListener("abort", () => {
            abortedWorkers += 1;
            resolve();
          }, { once: true });
        });
        return { shouldNotCommit: true };
      }
    });

    expect(result.committed).toBe(0);
    expect(result.failed).toBe(2);
    expect(abortedWorkers).toBe(2);
    expect(ledger.requireRun(run.id).status).toBe("cancelled");
    expect(ledger.listWorkerJobs(run.id).every((job) => job.status === "cancelled")).toBe(true);
    expect(ledger.listEvents(run.id).map((event) => event.type)).not.toContain("worker.committed");
  } finally {
    ledger.close();
  }
});

test("scheduler does not start already leased siblings after terminal cancellation", async () => {
  const { ledger, run } = setup();
  try {
    for (let index = 0; index < 4; index += 1) {
      ledger.enqueueWorkerJob({ runId: run.id, kind: "experiment", payload: { index } });
    }
    let enteredWorkers = 0;

    const result = await runWorkerQueue({
      runId: run.id,
      ledger,
      workerId: "terminal-race-worker",
      maxWorkers: 4,
      reservePerJob: { attempts: 1, elapsedMs: 1 },
      cancellationPollMs: 10,
      executor: async (_job, context) => {
        enteredWorkers += 1;
        ledger.updateRunStatus(run.id, "cancelled");
        await new Promise<void>((resolve) => {
          context.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return { shouldNotCommit: true };
      }
    });

    const events = ledger.listEvents(run.id);
    const terminalIndex = events.findIndex((event) =>
      event.type === "goal.status_changed" &&
      event.payload.to === "cancelled"
    );
    const postTerminalStarted = events
      .slice(terminalIndex + 1)
      .filter((event) => event.type === "worker.started");

    expect(enteredWorkers).toBe(1);
    expect(result.committed).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.cancelled).toBe(3);
    expect(postTerminalStarted).toEqual([]);
    expect(ledger.listWorkerJobs(run.id).every((job) => job.status === "cancelled")).toBe(true);
    expect(ledger.listOpenBudgetReservations(run.id)).toHaveLength(0);
  } finally {
    ledger.close();
  }
});

test("scheduler does not lease queued work after goal_met terminal status", async () => {
  const home = mkdtempSync(join(tmpdir(), "matematica-goal-met-stop-test-"));
  homes.push(home);
  process.env.MATEMATICA_HOME = home;
  const paths = getAppPaths();
  const ledger = new Ledger(paths.dbPath);
  const artifacts = new ArtifactStore(paths.artifactsDir, ledger);
  const run = ledger.createRun({
    problem: "Already solved",
    goal: "Do not spend more work",
    successCriteria: ["terminal status stops scheduler"],
    workflow: "gree",
    budget: { maxAttempts: 10, maxWorkers: 4 }
  });
  try {
    const artifact = artifacts.create(run.id, "verifier.local.result", "verified");
    const decisionEvent = ledger.appendEvent(run.id, "goal.success.evaluated", {
      status: "goal_met",
      evidenceGrade: "verified_computation",
      finalState: "computational_evidence",
      canClaimSolved: true,
      reason: "already solved",
      criteria: [{ criterion: "terminal status stops scheduler", ok: true, reason: "accepted" }],
      problemClassification: { class: "standard_problem", triggers: [] },
      claimId: "claim-scheduler",
      verifierId: "local-deterministic-v0",
      satisfyingArtifactIds: [artifact.id]
    }, [artifact.id]);
    const adversarialQuorum = persistAdversarialQuorumReview({
      runId: run.id,
      ledger,
      artifacts,
      scope: "finalization",
      targetEvent: decisionEvent,
      targetArtifactIds: [artifact.id],
      critics: buildBlindFinalizationCriticReviews({
        runId: run.id,
        targetEvent: decisionEvent,
        targetArtifactIds: [artifact.id]
      })
    });
    ledger.appendEvent(run.id, "goal.finalization.checked", {
      format: "matematica.no-false-solved-finalization",
      version: 1,
      runId: run.id,
      goalSuccessEventId: decisionEvent.id,
      status: "passed",
      canMarkGoalMet: true,
      claimId: "claim-scheduler",
      verifierId: "local-deterministic-v0",
      evidenceGrade: "verified_computation",
      finalState: "computational_evidence",
      canClaimSolved: true,
      problemClassification: { class: "standard_problem", triggers: [] },
      checks: [{
        id: "proof_certificate",
        status: "passed",
        reason: "scheduler proof certificate accepted",
        artifactIds: [artifact.id]
      }, {
        id: "adversarial_planning_quorum",
        status: "passed",
        reason: "scheduler adversarial quorum accepted",
        artifactIds: [adversarialQuorum.artifact.id]
      }],
      failureReasons: [],
      satisfyingArtifactIds: [artifact.id],
      reviewHash: "scheduler-finalization"
    }, [adversarialQuorum.artifact.id, artifact.id]);
    ledger.markGoalMet(run.id, "verified_computation", {
      reason: "already solved",
      claimId: "claim-scheduler",
      verifierId: "local-deterministic-v0"
    }, [artifact.id], buildGoalSuccessDecisionToken({
      runId: run.id,
      event: decisionEvent
    }));
    ledger.enqueueWorkerJob({ runId: run.id, kind: "experiment", payload: { index: 0 } });
    let calls = 0;

    const result = await runWorkerQueue({
      runId: run.id,
      ledger,
      workerId: "tester",
      maxWorkers: 4,
      executor: async () => {
        calls += 1;
        return {};
      }
    });

    expect(calls).toBe(0);
    expect(result.committed).toBe(0);
    expect(result.budgetExhausted).toBe(false);
    expect(ledger.listWorkerJobs(run.id)[0].status).toBe("pending");
    expect(ledger.listEvents(run.id).map((event) => event.type)).not.toContain("worker.leased");
  } finally {
    ledger.close();
  }
});

test("scheduler reserves only actual leasable jobs before leasing", async () => {
  const { ledger, run } = setup();
  try {
    ledger.enqueueWorkerJob({ runId: run.id, kind: "experiment", payload: { n: 1 } });

    const result = await runWorkerQueue({
      runId: run.id,
      ledger,
      workerId: "tester",
      maxWorkers: 4,
      executor: async () => ({ ok: true })
    });

    expect(result.committed).toBe(1);
    const eventTypes = ledger.listEvents(run.id).map((event) => event.type);
    expect(eventTypes.filter((type) => type === "budget.reserved")).toHaveLength(1);
    expect(eventTypes.filter((type) => type === "budget.released")).toHaveLength(0);
    expect(ledger.getBudgetUsage(run.id).attempts).toBe(1);
  } finally {
    ledger.close();
  }
});

test("scheduler leases only successfully reserved jobs and binds reservations one-to-one", async () => {
  const { ledger, run } = setup();
  try {
    for (let index = 0; index < 3; index += 1) {
      ledger.enqueueWorkerJob({ runId: run.id, kind: "experiment", payload: { index } });
    }

    const originalReserveBudget = ledger.reserveBudget.bind(ledger);
    let workerReservationAttempts = 0;
    ledger.reserveBudget = ((input) => {
      if (input.operationType === "worker.job") {
        workerReservationAttempts += 1;
        if (workerReservationAttempts > 1) {
          return { ok: false, reason: "injected reservation failure after first slot" };
        }
      }
      return originalReserveBudget(input);
    }) as Ledger["reserveBudget"];

    const executedJobIds: string[] = [];
    const result = await runWorkerQueue({
      runId: run.id,
      ledger,
      workerId: "tester",
      maxWorkers: 3,
      executor: async (job) => {
        executedJobIds.push(job.id);
        return { index: job.payload.index };
      }
    });

    const jobs = ledger.listWorkerJobs(run.id);
    const events = ledger.listEvents(run.id);
    const reservationEvents = events.filter((event) => event.type === "budget.reserved");
    const leaseEvents = events.filter((event) => event.type === "worker.leased");
    const bindingEvents = events.filter((event) => event.type === "worker.reservation_bound");
    const debitEvents = events.filter((event) => event.type === "budget.debited");

    expect(workerReservationAttempts).toBeGreaterThanOrEqual(2);
    expect(result.committed).toBe(1);
    expect(result.budgetExhausted).toBe(true);
    expect(executedJobIds).toHaveLength(1);
    expect(jobs.filter((job) => job.status === "committed")).toHaveLength(1);
    expect(jobs.filter((job) => job.status === "cancelled")).toHaveLength(2);
    expect(reservationEvents).toHaveLength(1);
    expect(leaseEvents).toHaveLength(1);
    expect(bindingEvents).toHaveLength(1);
    expect(debitEvents).toHaveLength(1);
    expect(bindingEvents[0].payload.jobId).toBe(executedJobIds[0]);
    expect(bindingEvents[0].payload.reservationId).toBe(reservationEvents[0].payload.reservationId);
    expect(debitEvents[0].payload.reservationId).toBe(reservationEvents[0].payload.reservationId);
    expect(ledger.listOpenBudgetReservations(run.id)).toHaveLength(0);
  } finally {
    ledger.close();
  }
});

test("open budget reservations count against usage until released", async () => {
  const { ledger, run } = setup();
  try {
    ledger.appendEvent(run.id, "budget.reserved", {
      reservationId: "reservation-open",
      reserve: { attempts: 2, tokens: 10, usd: 0.5, elapsedMs: 100 },
      workerId: "tester"
    });

    expect(ledger.getBudgetUsage(run.id)).toMatchObject({ attempts: 2, tokens: 10, usd: 0.5, elapsedMs: 100 });
    ledger.appendEvent(run.id, "budget.released", {
      reservationId: "reservation-open",
      release: { attempts: 2, tokens: 10, usd: 0.5, elapsedMs: 100 },
      reason: "test release"
    });
    expect(ledger.getBudgetUsage(run.id)).toMatchObject({ attempts: 0, tokens: 0, usd: 0, elapsedMs: 0 });
  } finally {
    ledger.close();
  }
});

test("scheduler marks budget exhausted and cancels remaining jobs", async () => {
  const home = mkdtempSync(join(tmpdir(), "matematica-budget-test-"));
  homes.push(home);
  process.env.MATEMATICA_HOME = home;
  const ledger = new Ledger(getAppPaths().dbPath);
  const run = ledger.createRun({
    problem: "Budget limited",
    goal: "Stop before workers",
    successCriteria: ["budget stops"],
    workflow: "pflk",
    budget: { maxAttempts: 0, maxWorkers: 2 }
  });
  try {
    ledger.enqueueWorkerJob({ runId: run.id, kind: "experiment", payload: {} });
    const result = await runWorkerQueue({
      runId: run.id,
      ledger,
      workerId: "tester",
      maxWorkers: 2,
      executor: async () => ({ impossible: true })
    });

    expect(result.budgetExhausted).toBe(true);
    expect(ledger.requireRun(run.id).status).toBe("budget_exhausted");
    expect(ledger.listWorkerJobs(run.id)[0].status).toBe("cancelled");
  } finally {
    ledger.close();
  }
});

test("scheduler cancels queued jobs without leasing when run is already cancelled", async () => {
  const { ledger, run } = setup();
  try {
    ledger.enqueueWorkerJob({ runId: run.id, kind: "experiment", payload: { index: 0 } });
    ledger.enqueueWorkerJob({ runId: run.id, kind: "experiment", payload: { index: 1 } });
    ledger.updateRunStatus(run.id, "cancelled");

    const result = await runWorkerQueue({
      runId: run.id,
      ledger,
      workerId: "tester",
      maxWorkers: 2,
      executor: async () => ({ shouldNotRun: true })
    });

    expect(result.committed).toBe(0);
    expect(result.cancelled).toBe(2);
    expect(ledger.listWorkerJobs(run.id).every((job) => job.status === "cancelled")).toBe(true);
    expect(ledger.listEvents(run.id).map((event) => event.type)).not.toContain("worker.leased");
  } finally {
    ledger.close();
  }
});

test("scheduler aborts cooperative running worker when run is cancelled", async () => {
  const { ledger, run } = setup();
  try {
    const job = ledger.enqueueWorkerJob({ runId: run.id, kind: "experiment", payload: { index: 0 }, maxAttempts: 1 });
    let sawAbort = false;

    const result = await runWorkerQueue({
      runId: run.id,
      ledger,
      workerId: "tester",
      maxWorkers: 1,
      cancellationPollMs: 25,
      executor: async (_job, context) => {
        setTimeout(() => ledger.updateRunStatus(run.id, "cancelled"), 10);
        await new Promise<void>((resolve) => {
          context.signal.addEventListener("abort", () => {
            sawAbort = true;
            resolve();
          }, { once: true });
        });
        return { shouldNotCommit: true };
      }
    });

    expect(sawAbort).toBe(true);
    expect(result.failed).toBe(1);
    expect(ledger.requireWorkerJob(job.id).status).toBe("cancelled");
    expect(ledger.getBudgetUsage(run.id).attempts).toBe(1);
  } finally {
    ledger.close();
  }
});

test("scheduler aborts cooperative running worker when run reaches terminal budget_exhausted", async () => {
  const { ledger, run } = setup();
  try {
    const job = ledger.enqueueWorkerJob({ runId: run.id, kind: "experiment", payload: { index: 0 }, maxAttempts: 1 });
    let sawAbort = false;

    const result = await runWorkerQueue({
      runId: run.id,
      ledger,
      workerId: "tester",
      maxWorkers: 1,
      cancellationPollMs: 25,
      executor: async (_job, context) => {
        setTimeout(() => ledger.updateRunStatus(run.id, "budget_exhausted", "budget_exhausted"), 10);
        await new Promise<void>((resolve) => {
          context.signal.addEventListener("abort", () => {
            sawAbort = true;
            resolve();
          }, { once: true });
        });
        return { shouldNotCommit: true };
      }
    });

    expect(sawAbort).toBe(true);
    expect(result.failed).toBe(1);
    expect(ledger.requireRun(run.id).status).toBe("budget_exhausted");
    expect(ledger.requireWorkerJob(job.id).status).toBe("cancelled");
    expect(ledger.getBudgetUsage(run.id).attempts).toBe(1);
    expect(ledger.listOpenBudgetReservations(run.id)).toHaveLength(0);
  } finally {
    ledger.close();
  }
});

test("scheduler debits failed worker attempts before leasing more jobs", async () => {
  const home = mkdtempSync(join(tmpdir(), "matematica-failed-debit-test-"));
  homes.push(home);
  process.env.MATEMATICA_HOME = home;
  const ledger = new Ledger(getAppPaths().dbPath);
  const run = ledger.createRun({
    problem: "Failures cost budget",
    goal: "Stop retries after failed attempt exhausts budget",
    successCriteria: ["failed attempts are billed"],
    workflow: "gree",
    budget: { maxAttempts: 1, maxWorkers: 2 }
  });
  try {
    ledger.enqueueWorkerJob({ runId: run.id, kind: "experiment", payload: { index: 0 }, maxAttempts: 1 });
    ledger.enqueueWorkerJob({ runId: run.id, kind: "experiment", payload: { index: 1 }, maxAttempts: 1 });

    const result = await runWorkerQueue({
      runId: run.id,
      ledger,
      workerId: "tester",
      maxWorkers: 2,
      executor: async () => {
        throw new Error("failed attempt still consumes budget");
      }
    });

    expect(result.failed).toBe(1);
    expect(result.budgetExhausted).toBe(true);
    const statuses = ledger.listWorkerJobs(run.id).map((job) => job.status).sort();
    expect(statuses).toEqual(["cancelled", "failed_terminal"]);
    expect(ledger.getBudgetUsage(run.id).attempts).toBe(1);
  } finally {
    ledger.close();
  }
});

test("failed retryable job can be leased again until max attempts", async () => {
  const { ledger, run } = setup();
  try {
    const job = ledger.enqueueWorkerJob({ runId: run.id, kind: "experiment", payload: {}, maxAttempts: 2 });
    let calls = 0;

    await runWorkerQueue({
      runId: run.id,
      ledger,
      workerId: "tester",
      maxWorkers: 1,
      executor: async () => {
        calls += 1;
        if (calls === 1) throw new Error("retry me");
        return { ok: true };
      }
    });

    expect(ledger.requireWorkerJob(job.id).status).toBe("committed");
    expect(ledger.requireWorkerJob(job.id).attempts).toBe(2);
  } finally {
    ledger.close();
  }
});
