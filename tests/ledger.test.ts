import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBlindFinalizationCriticReviews, persistAdversarialQuorumReview } from "../src/adversarial-quorum";
import { ArtifactStore } from "../src/artifacts";
import { auditRun } from "../src/audit";
import { buildBudgetContract, checkBudget, emptyUsage } from "../src/budget";
import type { EvidenceGrade } from "../src/domain";
import { buildExternalOutcomeReconciliationReport } from "../src/external-reconciliation";
import { buildGoalSuccessDecisionToken, type GoalSuccessDecisionToken } from "../src/goal-success";
import { Ledger, type ExternalOperationPrepareFault } from "../src/ledger";
import { getAppPaths } from "../src/paths";
import { renderReport } from "../src/report";

const homes: string[] = [];

function setup() {
  const home = mkdtempSync(join(tmpdir(), "matematica-ledger-test-"));
  homes.push(home);
  process.env.MATEMATICA_HOME = home;
  const paths = getAppPaths();
  const ledger = new Ledger(paths.dbPath);
  const artifacts = new ArtifactStore(paths.artifactsDir, ledger);
  const run = ledger.createRun({
    problem: "Prove 1 + 1 = 2",
    goal: "Find verified computation",
    successCriteria: ["verified evidence only"],
    workflow: "pflk",
    budget: { maxAttempts: 1 }
  });
  return { ledger, artifacts, run };
}

test("budget contract covers every bounded resource dimension with exact exhaustion names", () => {
  const { ledger, run } = setup();
  try {
    const budget = {
      maxUsd: 1,
      maxTokens: 10,
      maxWallTimeMs: 100,
      maxAttempts: 2,
      maxWorkers: 3,
      maxArtifactBytes: 4,
      maxSourceQueries: 5,
      maxRetries: 1,
      maxSandboxMs: 50
    };
    const contract = buildBudgetContract(budget);
    expect(contract.run).toMatchObject(budget);
    expect(contract.dimensions).toEqual([
      "attempts",
      "tokens",
      "usd",
      "elapsedMs",
      "artifactBytes",
      "sourceQueries",
      "retries",
      "sandboxMs"
    ]);

    const checkedRun = { ...run, budget };
    expect(checkBudget(checkedRun, { ...emptyUsage(), attempts: 3 }).reason).toContain("attempts budget exceeded");
    expect(checkBudget(checkedRun, { ...emptyUsage(), tokens: 11 }).reason).toContain("tokens budget exceeded");
    expect(checkBudget(checkedRun, { ...emptyUsage(), usd: 2 }).reason).toContain("usd budget exceeded");
    expect(checkBudget(checkedRun, { ...emptyUsage(), elapsedMs: 101 }).reason).toContain("elapsedMs budget exceeded");
    expect(checkBudget(checkedRun, { ...emptyUsage(), artifactBytes: 5 }).reason).toContain("artifactBytes budget exceeded");
    expect(checkBudget(checkedRun, { ...emptyUsage(), sourceQueries: 6 }).reason).toContain("sourceQueries budget exceeded");
    expect(checkBudget(checkedRun, { ...emptyUsage(), retries: 2 }).reason).toContain("retries budget exceeded");
    expect(checkBudget(checkedRun, { ...emptyUsage(), sandboxMs: 51 }).reason).toContain("sandboxMs budget exceeded");
  } finally {
    ledger.close();
  }
});

test("ledger accounts artifact source retry and sandbox resource budget usage", () => {
  const { ledger, artifacts, run } = setup();
  try {
    const artifact = artifacts.create(run.id, "resource.sample", "abcd");
    ledger.appendEvent(run.id, "source.query", {
      provider: "arxiv",
      query: "bounded search",
      externalOperationId: "source-op",
      requestArtifactId: artifact.id
    }, [artifact.id]);
    ledger.appendEvent(run.id, "provider.retry.scheduled", {
      provider: "openai",
      operationType: "ai.generateText",
      externalOperationId: "provider-op",
      retryAttemptOperationId: "provider-op-retry",
      requestArtifactId: artifact.id
    }, [artifact.id]);
    const reservation = ledger.reserveBudget({
      runId: run.id,
      reserve: { attempts: 1, sandboxMs: 10 },
      operationType: "sandbox.experiment",
      operationId: "sandbox-budget-test",
      provider: "local-sandbox"
    });
    expect(reservation.ok).toBe(true);
    if (!reservation.ok) throw new Error("sandbox reservation unexpectedly failed");
    expect(ledger.getBudgetUsage(run.id)).toMatchObject({
      attempts: 1,
      artifactBytes: artifact.bytes,
      sourceQueries: 1,
      retries: 1,
      sandboxMs: 10
    });
    ledger.debitBudget({
      runId: run.id,
      reservationId: reservation.reservationId,
      debit: { attempts: 1, sandboxMs: 7 },
      provider: "local-sandbox"
    });
    expect(ledger.getBudgetUsage(run.id)).toMatchObject({
      attempts: 1,
      artifactBytes: artifact.bytes,
      sourceQueries: 1,
      retries: 1,
      sandboxMs: 7
    });
  } finally {
    ledger.close();
  }
});

function persistGoalSuccessDecision(input: {
  ledger: Ledger;
  artifacts: ArtifactStore;
  runId: string;
  evidenceGrade: EvidenceGrade;
  artifactIds: string[];
  claimId?: string;
  verifierId?: string;
  reason?: string;
}): GoalSuccessDecisionToken {
  const claimId = input.claimId ?? "claim-test";
  const verifierId = input.verifierId ?? "local-deterministic-v0";
  const event = input.ledger.appendEvent(input.runId, "goal.success.evaluated", {
    status: "goal_met",
    evidenceGrade: input.evidenceGrade,
    finalState: input.evidenceGrade === "verified_counterexample" ? "counterexample" : "computational_evidence",
    canClaimSolved: input.evidenceGrade !== "verified_counterexample",
    reason: input.reason ?? "verifier-backed success",
    criteria: [{ criterion: "verified evidence only", ok: true, reason: "accepted" }],
    problemClassification: { class: "standard_problem", triggers: [] },
    claimId,
    verifierId,
    satisfyingArtifactIds: input.artifactIds
  }, input.artifactIds);
  const adversarialQuorum = persistAdversarialQuorumReview({
    runId: input.runId,
    ledger: input.ledger,
    artifacts: input.artifacts,
    scope: "finalization",
    targetEvent: event,
    targetArtifactIds: input.artifactIds,
    critics: buildBlindFinalizationCriticReviews({
      runId: input.runId,
      targetEvent: event,
      targetArtifactIds: input.artifactIds
    })
  });
  input.ledger.appendEvent(input.runId, "goal.finalization.checked", {
    format: "matematica.no-false-solved-finalization",
    version: 1,
    runId: input.runId,
    goalSuccessEventId: event.id,
    status: "passed",
    canMarkGoalMet: true,
    claimId,
    verifierId,
    evidenceGrade: input.evidenceGrade,
    finalState: input.evidenceGrade === "verified_counterexample" ? "counterexample" : "computational_evidence",
    canClaimSolved: input.evidenceGrade !== "verified_counterexample",
    problemClassification: { class: "standard_problem", triggers: [] },
    checks: [{
      id: "proof_certificate",
      status: "passed",
      reason: "test proof certificate accepted",
      artifactIds: input.artifactIds
    }, {
      id: "adversarial_planning_quorum",
      status: "passed",
      reason: "test adversarial quorum accepted",
      artifactIds: [adversarialQuorum.artifact.id]
    }],
    failureReasons: [],
    satisfyingArtifactIds: input.artifactIds,
    reviewHash: "test-finalization-review"
  }, [adversarialQuorum.artifact.id, ...input.artifactIds]);
  return buildGoalSuccessDecisionToken({
    runId: input.runId,
    event
  });
}

afterEach(() => {
  delete process.env.MATEMATICA_HOME;
  while (homes.length > 0) {
    rmSync(homes.pop()!, { recursive: true, force: true });
  }
});

test("goal_met cannot be set through generic status update", () => {
  const { ledger, run } = setup();
  try {
    expect(() => ledger.updateRunStatus(run.id, "goal_met", "verified_computation"))
      .toThrow("Use markGoalMet");
  } finally {
    ledger.close();
  }
});

test("needs_human_review is a durable terminal run state", () => {
  const { ledger, run } = setup();
  try {
    const updated = ledger.updateRunStatus(run.id, "needs_human_review", "heuristic_evidence");
    expect(updated.status).toBe("needs_human_review");
    expect(updated.evidenceGrade).toBe("heuristic_evidence");
    expect(updated.completedAt).toBeString();
    const statusEvent = ledger.listEvents(run.id).findLast((event) => event.type === "goal.status_changed");
    expect(statusEvent?.payload).toMatchObject({
      from: "created",
      to: "needs_human_review",
      evidenceGrade: "heuristic_evidence",
      terminalArbiter: {
        authority: "ledger.terminal-state-arbiter",
        transition: "applied",
        compareAndSet: {
          expectedFrom: "created",
          applied: true
        }
      }
    });
    expect((statusEvent?.payload.terminalArbiter as { priority?: number } | undefined)?.priority).toBeGreaterThan(0);
  } finally {
    ledger.close();
  }
});

test("terminal-state arbiter records ignored lower-priority terminal races", () => {
  const { ledger, run } = setup();
  try {
    ledger.updateRunStatus(run.id, "budget_exhausted", "budget_exhausted");

    expect(() => ledger.updateRunStatus(run.id, "cancelled"))
      .toThrow("Cannot change terminal run");
    const ignored = ledger.listEvents(run.id).findLast((event) => event.type === "goal.terminal_transition.ignored");
    expect(ignored?.payload).toMatchObject({
      from: "budget_exhausted",
      to: "cancelled",
      terminalArbiter: {
        authority: "ledger.terminal-state-arbiter",
        transition: "ignored",
        reason: "run_already_terminal",
        compareAndSet: {
          expectedFrom: "budget_exhausted",
          applied: false
        }
      }
    });
    expect(ledger.listEvents(run.id).filter((event) => event.type === "goal.status_changed")).toHaveLength(1);
  } finally {
    ledger.close();
  }
});

test("terminal run states are immutable without explicit reopen intent", () => {
  const { ledger, run } = setup();
  try {
    ledger.updateRunStatus(run.id, "budget_exhausted", "budget_exhausted");

    expect(() => ledger.updateRunStatus(run.id, "running"))
      .toThrow("Cannot change terminal run");
    expect(() => ledger.updateRunStatus(run.id, "failed"))
      .toThrow("Cannot change terminal run");
    expect(ledger.requireRun(run.id).status).toBe("budget_exhausted");
    expect(ledger.listEvents(run.id).filter((event) => event.type === "goal.status_changed")).toHaveLength(1);
  } finally {
    ledger.close();
  }
});

test("non-goal_met terminal run can reopen only after fresh operator intent", () => {
  const { ledger, run } = setup();
  try {
    ledger.updateRunStatus(run.id, "cancelled");
    ledger.appendEvent(run.id, "goal.terminal_reopen.requested", {
      reason: "operator retry",
      fromStatus: "cancelled",
      reopened: true,
      decision: "operator requested terminal reopen from cancelled"
    });
    const reopened = ledger.updateRunStatus(run.id, "created", "none");
    expect(reopened.status).toBe("created");

    ledger.updateRunStatus(run.id, "cancelled");
    expect(() => ledger.updateRunStatus(run.id, "created", "none"))
      .toThrow("Cannot change terminal run");
  } finally {
    ledger.close();
  }
});

test("goal_met remains immutable even with terminal reopen intent", () => {
  const { ledger, artifacts, run } = setup();
  try {
    const artifact = artifacts.create(run.id, "verifier.local.result", "verified computation");
    const decision = persistGoalSuccessDecision({
      ledger,
      artifacts,
      runId: run.id,
      evidenceGrade: "verified_computation",
      artifactIds: [artifact.id]
    });
    ledger.markGoalMet(run.id, "verified_computation", {
      reason: "verified computation",
      claimId: "claim-test",
      verifierId: "local-deterministic-v0"
    }, [artifact.id], decision);
    ledger.appendEvent(run.id, "goal.terminal_reopen.requested", {
      reason: "operator retry",
      fromStatus: "goal_met",
      reopened: true,
      decision: "goal_met is immutable"
    });

    expect(() => ledger.updateRunStatus(run.id, "created", "none"))
      .toThrow("Cannot change terminal run");
    expect(ledger.requireRun(run.id).status).toBe("goal_met");
  } finally {
    ledger.close();
  }
});

test("goal_met racing budget exhaustion is arbitrated by first terminal compare-and-set", () => {
  const { ledger, artifacts, run } = setup();
  try {
    const artifact = artifacts.create(run.id, "verifier.local.result", "verified computation");
    const decision = persistGoalSuccessDecision({
      ledger,
      artifacts,
      runId: run.id,
      evidenceGrade: "verified_computation",
      artifactIds: [artifact.id]
    });
    ledger.markGoalMet(run.id, "verified_computation", {
      reason: "verified computation",
      claimId: "claim-test",
      verifierId: "local-deterministic-v0"
    }, [artifact.id], decision);

    expect(() => ledger.updateRunStatus(run.id, "budget_exhausted", "budget_exhausted"))
      .toThrow("Cannot change terminal run");
    expect(ledger.requireRun(run.id).status).toBe("goal_met");
    expect(ledger.listEvents(run.id).filter((event) => event.type === "goal.status_changed")).toHaveLength(1);
    expect(ledger.listEvents(run.id).findLast((event) => event.type === "goal.terminal_transition.ignored")?.payload)
      .toMatchObject({
        from: "goal_met",
        to: "budget_exhausted",
        terminalArbiter: {
          transition: "ignored",
          reason: "run_already_terminal"
        }
      });
  } finally {
    ledger.close();
  }
});

test("fresh and repeated ledger init apply idempotent migrations", () => {
  const home = mkdtempSync(join(tmpdir(), "matematica-migration-test-"));
  homes.push(home);
  process.env.MATEMATICA_HOME = home;
  const paths = getAppPaths();
  const first = new Ledger(paths.dbPath);
  const firstMigrations = first.appliedMigrations();
  first.close();

  const second = new Ledger(paths.dbPath);
  try {
    expect(second.appliedMigrations()).toEqual(firstMigrations);
    expect(second.schemaVersion()).toBe(firstMigrations.length);
    for (const table of [
      "goal_runs",
      "ledger_events",
      "artifacts",
      "worker_jobs",
      "worker_attempts",
      "source_records",
      "verifier_runs",
      "budget_debits",
      "external_operations",
      "scores",
      "reports",
      "run_event_counters",
      "schema_migrations"
    ]) {
      const row = second.db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
      expect(row).toBeTruthy();
    }
  } finally {
    second.close();
  }
});

test("SQLite concurrency config enables WAL busy timeout and monotonic event ordering", async () => {
  const home = mkdtempSync(join(tmpdir(), "matematica-sqlite-concurrency-test-"));
  homes.push(home);
  process.env.MATEMATICA_HOME = home;
  const paths = getAppPaths();
  const ledger = new Ledger(paths.dbPath);
  const run = ledger.createRun({
    problem: "Concurrent event writes",
    goal: "No locked database errors or corrupt ordering",
    successCriteria: ["monotonic sequence"],
    workflow: "gree",
    budget: { maxAttempts: 1 }
  });
  const config = ledger.sqliteConcurrencyConfig();
  expect(config.journalMode.toLowerCase()).toBe("wal");
  expect(config.busyTimeoutMs).toBeGreaterThanOrEqual(10_000);
  expect(config.synchronous).toBe(1);
  expect(config.walAutocheckpoint).toBe(1000);
  ledger.close();

  try {
    const writers = Array.from({ length: 8 }, (_, writer) => writer);
    await Promise.all(writers.map(async (writer) => {
      const writerLedger = new Ledger(paths.dbPath);
      try {
        for (let batch = 0; batch < 5; batch += 1) {
          writerLedger.appendEventsBatch(run.id, Array.from({ length: 5 }, (_, index) => ({
            type: "phase.completed",
            payload: {
              writer,
              batch,
              index,
              marker: `writer-${writer}-batch-${batch}-event-${index}`
            }
          })));
          await Bun.sleep(0);
        }
      } finally {
        writerLedger.close();
      }
    }));

    const reader = new Ledger(paths.dbPath);
    try {
      const events = reader.listEvents(run.id);
      expect(events).toHaveLength(1 + 8 * 5 * 5);
      expect(events[0].type).toBe("goal.created");
      const sequences = events.map((event) => event.sequence);
      expect(sequences.every((sequence): sequence is number => typeof sequence === "number")).toBe(true);
      const numericSequences = sequences as number[];
      expect(new Set(numericSequences).size).toBe(numericSequences.length);
      expect(numericSequences).toEqual([...numericSequences].sort((a, b) => a - b));
      let previousEventHash: string | undefined;
      for (const event of events) {
        expect(event.eventHash).toBeString();
        expect(event.previousEventHash).toBe(previousEventHash);
        previousEventHash = event.eventHash;
      }
      expect(events.at(-1)?.payload.marker).toBeString();
    } finally {
      reader.close();
    }
  } finally {
    process.env.MATEMATICA_HOME = home;
  }
});

test("ledger maintenance snapshot pins query indexes compaction and retention policy", () => {
  const { ledger, run } = setup();
  try {
    const first = ledger.appendEvent(run.id, "phase.completed", {
      phase: "feedback",
      status: "done",
      marker: "oldest"
    });
    const second = ledger.appendEvent(run.id, "phase.completed", {
      phase: "loophole",
      status: "done",
      marker: "middle"
    });
    const third = ledger.appendEvent(run.id, "phase.completed", {
      phase: "knowledge",
      status: "done",
      marker: "newest"
    });

    ledger.db.query("UPDATE ledger_events SET created_at = ? WHERE id = ?")
      .run("2026-05-24T00:00:00.000Z", first.id);
    ledger.db.query("UPDATE ledger_events SET created_at = ? WHERE id = ?")
      .run("2026-05-25T00:00:00.000Z", second.id);
    ledger.db.query("UPDATE ledger_events SET created_at = ? WHERE id = ?")
      .run("2026-05-26T00:00:00.000Z", third.id);
    ledger.db.query("UPDATE ledger_events SET created_at = ? WHERE id = ?")
      .run("2026-05-23T00:00:00.000Z", ledger.listEvents(run.id)[0]!.id);

    const snapshot = ledger.maintenanceSnapshot();
    expect(snapshot).toMatchObject({
      format: "matematica.ledger.maintenance",
      version: 1,
      schemaVersion: ledger.schemaVersion(),
      compactionPolicy: {
        sqliteWalCheckpoint: "automatic_wal_autocheckpoint_1000_pages",
        witnessCheckpoint: "refresh_after_every_event_append",
        vacuum: "operator_after_large_cache_prune_or_home_rotation"
      },
      retentionPolicy: {
        ledgerEvents: "retain_until_operator_deletes_matematica_home",
        runArtifacts: "retain_until_operator_deletes_matematica_home",
        researchCaches: "prune_with_storage_prune_caches"
      }
    });
    expect(snapshot.integrity.requiredIndexesPresent).toBe(true);
    expect(snapshot.requiredIndexes.every((index) => index.present)).toBe(true);
    expect(snapshot.requiredIndexes.map((index) => index.name)).toContain("idx_ledger_events_run_created_sequence");
    expect(snapshot.requiredIndexes.map((index) => index.name)).toContain("idx_ledger_events_run_sequence");
    expect(snapshot.tables.ledgerEvents.rows).toBeGreaterThanOrEqual(4);
    expect(snapshot.tables.ledgerEvents.oldestCreatedAt).toBe("2026-05-23T00:00:00.000Z");
    expect(snapshot.tables.ledgerEvents.newestCreatedAt).toBe("2026-05-26T00:00:00.000Z");
    expect(ledger.listEvents(run.id).map((event) => event.id)).toEqual([
      ledger.listEvents(run.id)[0]!.id,
      first.id,
      second.id,
      third.id
    ]);
  } finally {
    ledger.close();
  }
});

test("score row and evidence.scored event roll back together when commit is interrupted", () => {
  const { ledger, run } = setup();
  try {
    expect(() => ledger.insertScore({
      runId: run.id,
      subjectId: "claim-test",
      scorer: "test-scorer",
      score: 0.75,
      rubric: { dimensions: { verification: 1 } },
      faultAfter: "after_score_insert"
    })).toThrow("Injected score persistence fault");

    expect(ledger.listScores(run.id)).toHaveLength(0);
    expect(ledger.listEvents(run.id).some((event) =>
      event.type === "evidence.scored" &&
      event.payload.subjectId === "claim-test"
    )).toBe(false);
  } finally {
    ledger.close();
  }
});

test("goal creation pins a typed hard budget contract", () => {
  const { ledger, run } = setup();
  try {
    const created = ledger.listEvents(run.id).find((event) => event.type === "goal.created");
    expect(created?.payload.budgetContract).toMatchObject({
      format: "matematica.budget-contract",
      version: 1,
      run: { maxAttempts: 1 },
      dimensions: ["attempts", "tokens", "usd", "elapsedMs", "artifactBytes", "sourceQueries", "retries", "sandboxMs"],
      settlementStates: ["reserved", "committed", "released", "failed", "estimated"]
    });
    expect(created?.payload.budgetContract).toHaveProperty("requiredLeaseBefore");
    expect(created?.payload.goalContract).toMatchObject({
      format: "matematica.goal-contract",
      version: 1,
      allowedAnswerTypes: [
        "formal_proof",
        "counterexample",
        "verified_computation",
        "heuristic",
        "partial",
        "inconclusive"
      ],
      verifierPolicy: {
        independentVerifierRequired: true,
        modelSelfGradingCountsAs: "heuristic",
        literatureCountsAs: "partial"
      }
    });
  } finally {
    ledger.close();
  }
});

test("external operation outbox enforces idempotency and settles budget once", () => {
  const home = mkdtempSync(join(tmpdir(), "matematica-external-operation-test-"));
  homes.push(home);
  process.env.MATEMATICA_HOME = home;
  const paths = getAppPaths();
  const ledger = new Ledger(paths.dbPath);
  const artifacts = new ArtifactStore(paths.artifactsDir, ledger);
  const run = ledger.createRun({
    problem: "Persist external effects",
    goal: "Do not duplicate provider calls",
    successCriteria: ["idempotent outbox"],
    workflow: "pflk",
    budget: { maxTokens: 10 }
  });

  try {
    const request = artifacts.create(run.id, "ai.request", "{}");
    const prepared = ledger.prepareExternalOperation({
      runId: run.id,
      operationType: "ai.generateText",
      provider: "openai",
      idempotencyKey: "call-key-1",
      requestHash: "request-hash-1",
      requestArtifactId: request.id,
      reserve: { tokens: 4 }
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error("operation unexpectedly failed");
    expect(prepared.created).toBe(true);
    expect(ledger.getBudgetUsage(run.id).tokens).toBe(4);

    const duplicate = ledger.prepareExternalOperation({
      runId: run.id,
      operationType: "ai.generateText",
      provider: "openai",
      idempotencyKey: "call-key-1",
      requestHash: "request-hash-1",
      requestArtifactId: request.id,
      reserve: { tokens: 4 }
    });
    expect(duplicate.ok).toBe(true);
    if (!duplicate.ok) throw new Error("duplicate unexpectedly failed");
    expect(duplicate.created).toBe(false);
    expect(duplicate.operation.id).toBe(prepared.operation.id);
    expect(ledger.getBudgetUsage(run.id).tokens).toBe(4);

    const running = ledger.startExternalOperation(prepared.operation.id);
    expect(running.status).toBe("running");
    const response = artifacts.create(run.id, "ai.response", "{\"text\":\"ok\"}");
    const completed = ledger.completeExternalOperation({
      operationId: running.id,
      responseArtifactId: response.id,
      debit: { tokens: 3 },
      provider: "openai"
    });

    expect(completed.status).toBe("succeeded");
    expect(completed.responseArtifactId).toBe(response.id);
    expect(ledger.getBudgetUsage(run.id).tokens).toBe(3);
    expect(() => ledger.failExternalOperation({
      operationId: completed.id,
      errorMessage: "too late",
      releaseReason: "too late"
    })).toThrow("status succeeded");
  } finally {
    ledger.close();
  }
});

test("external operation prepare rolls back reservation and outbox writes on injected boundary failures", () => {
  const faults: ExternalOperationPrepareFault[] = [
    "after_budget_checked",
    "after_budget_reserved",
    "after_external_operation_inserted",
    "after_external_operation_reserved_event"
  ];

  for (const fault of faults) {
    const { ledger, artifacts, run } = setup();
    try {
      const request = artifacts.create(run.id, "ai.request", JSON.stringify({ fault }));
      expect(() => ledger.prepareExternalOperation({
        runId: run.id,
        operationType: "ai.generateText",
        provider: "openai",
        idempotencyKey: `call-key-${fault}`,
        requestHash: `request-hash-${fault}`,
        requestArtifactId: request.id,
        reserve: { tokens: 4 },
        faultAfter: fault
      })).toThrow(`Injected external operation prepare fault at ${fault}`);

      expect(ledger.listExternalOperations(run.id)).toHaveLength(0);
      expect(ledger.listOpenBudgetReservations(run.id)).toHaveLength(0);
      expect(ledger.getBudgetUsage(run.id)).toMatchObject({ attempts: 0, tokens: 0, usd: 0, elapsedMs: 0 });
      expect(ledger.listEvents(run.id).map((event) => event.type)).not.toContain("budget.reserved");
      expect(ledger.listEvents(run.id).map((event) => event.type)).not.toContain("external.operation.reserved");
    } finally {
      ledger.close();
    }
  }
});

test("external operation prepare refuses remote admission requirement without persisted admission artifacts", () => {
  const { ledger, artifacts, run } = setup();
  try {
    const request = artifacts.create(run.id, "ai.request", JSON.stringify({ prompt: "remote call" }));
    expect(() => ledger.prepareExternalOperation({
      runId: run.id,
      operationType: "ai.generateText",
      provider: "openai",
      idempotencyKey: "missing-admission-call",
      requestHash: "missing-admission-hash",
      requestArtifactId: request.id,
      reserve: { tokens: 4 },
      requiresRemoteAdmission: true
    })).toThrow("requires persisted remote admission artifacts");

    expect(ledger.listExternalOperations(run.id)).toHaveLength(0);
    expect(ledger.listOpenBudgetReservations(run.id)).toHaveLength(0);
    expect(ledger.getBudgetUsage(run.id)).toMatchObject({ attempts: 0, tokens: 0, usd: 0, elapsedMs: 0 });
  } finally {
    ledger.close();
  }
});

test("external operation reconciliation releases reserved budget without retrying the same key", () => {
  const home = mkdtempSync(join(tmpdir(), "matematica-external-operation-reconcile-"));
  homes.push(home);
  process.env.MATEMATICA_HOME = home;
  const paths = getAppPaths();
  const ledger = new Ledger(paths.dbPath);
  const artifacts = new ArtifactStore(paths.artifactsDir, ledger);
  const run = ledger.createRun({
    problem: "Recover external effects",
    goal: "Release stranded reservation",
    successCriteria: ["crash recovery"],
    workflow: "gree",
    budget: { maxTokens: 10 }
  });

  try {
    const request = artifacts.create(run.id, "source.request", "{}");
    const prepared = ledger.prepareExternalOperation({
      runId: run.id,
      operationType: "source.arxiv",
      provider: "arxiv",
      idempotencyKey: "arxiv-key-1",
      requestHash: "arxiv-request-hash-1",
      requestArtifactId: request.id,
      reserve: { tokens: 5 }
    });
    expect(prepared.ok).toBe(true);
    expect(ledger.getBudgetUsage(run.id).tokens).toBe(5);
    expect(ledger.reconcileOpenExternalOperations(run.id, "resume after crash")).toBe(1);
    expect(ledger.getBudgetUsage(run.id).tokens).toBe(0);

    const duplicate = ledger.prepareExternalOperation({
      runId: run.id,
      operationType: "source.arxiv",
      provider: "arxiv",
      idempotencyKey: "arxiv-key-1",
      requestHash: "arxiv-request-hash-1",
      requestArtifactId: request.id,
      reserve: { tokens: 5 }
    });
    expect(duplicate.ok).toBe(true);
    if (!duplicate.ok) throw new Error("duplicate unexpectedly failed");
    expect(duplicate.created).toBe(false);
    expect(duplicate.operation.status).toBe("released");
    expect(ledger.getBudgetUsage(run.id).tokens).toBe(0);
  } finally {
    ledger.close();
  }
});

test("running external operation reconciliation records unknown remote outcome without releasing budget", () => {
  const { ledger, artifacts, run } = setup();
  try {
    const request = artifacts.create(run.id, "ai.request", "{}");
    const prepared = ledger.prepareExternalOperation({
      runId: run.id,
      operationType: "ai.generateText",
      provider: "openai",
      idempotencyKey: "ai-running-crash-key",
      requestHash: "ai-running-crash-hash",
      requestArtifactId: request.id,
      reserve: { tokens: 5, attempts: 1 }
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok || !prepared.created) throw new Error("expected operation");
    ledger.startExternalOperation(prepared.operation.id);

    expect(ledger.reconcileOpenExternalOperations(run.id, "restart after provider send")).toBe(1);
    expect(ledger.reconcileOpenExternalOperations(run.id, "second pass")).toBe(0);
    expect(ledger.requireExternalOperation(prepared.operation.id).status).toBe("unknown_remote_outcome");
    expect(ledger.listOpenBudgetReservations(run.id).map((reservation) => reservation.reservationId))
      .toContain(prepared.operation.reservationId);
    expect(ledger.reconcileOpenBudgetReservations(run.id, "generic reservation cleanup")).toBe(0);
    expect(ledger.listOpenBudgetReservations(run.id)).toHaveLength(1);

    const duplicate = ledger.prepareExternalOperation({
      runId: run.id,
      operationType: "ai.generateText",
      provider: "openai",
      idempotencyKey: "ai-running-crash-key",
      requestHash: "ai-running-crash-hash",
      requestArtifactId: request.id,
      reserve: { tokens: 5, attempts: 1 }
    });
    expect(duplicate.ok).toBe(true);
    if (!duplicate.ok) throw new Error("duplicate unexpectedly failed");
    expect(duplicate.created).toBe(false);
    expect(duplicate.operation.status).toBe("unknown_remote_outcome");
  } finally {
    ledger.close();
  }
});

test("post-send external operation recovery quarantines provider source verifier and sandbox outcomes", () => {
  const home = mkdtempSync(join(tmpdir(), "matematica-external-operation-quarantine-"));
  homes.push(home);
  process.env.MATEMATICA_HOME = home;
  const paths = getAppPaths();
  const ledger = new Ledger(paths.dbPath);
  const artifacts = new ArtifactStore(paths.artifactsDir, ledger);
  const run = ledger.createRun({
    problem: "Recover unknown external side effects",
    goal: "Never trust post-send crash outcomes",
    successCriteria: ["quarantine every unknown external operation"],
    workflow: "gree",
    budget: { maxAttempts: 10, maxTokens: 10_000, maxUsd: 10, maxWallTimeMs: 10_000 }
  });
  const operationInputs = [
    { operationType: "ai.generateText", provider: "openai", reserve: { attempts: 1, tokens: 100, usd: 0.01 } },
    { operationType: "source.arxiv", provider: "arxiv", reserve: { elapsedMs: 1 } },
    { operationType: "verifier.lean4", provider: "lean4", reserve: { attempts: 1, elapsedMs: 1 } },
    { operationType: "sandbox.experiment", provider: "local-sandbox", reserve: { attempts: 1, elapsedMs: 1 } }
  ];

  try {
    const operationIds: string[] = [];
    for (const [index, input] of operationInputs.entries()) {
      const request = artifacts.create(run.id, `${input.operationType}.request`, JSON.stringify({ index }));
      const prepared = ledger.prepareExternalOperation({
        runId: run.id,
        operationType: input.operationType,
        provider: input.provider,
        idempotencyKey: `post-send-crash-${index}`,
        requestHash: `post-send-request-hash-${index}`,
        requestArtifactId: request.id,
        reserve: input.reserve
      });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok || !prepared.created) throw new Error("expected fresh operation");
      operationIds.push(prepared.operation.id);
      ledger.startExternalOperation(prepared.operation.id);
    }

    const before = ledger.getBudgetUsage(run.id);
    expect(ledger.reconcileOpenExternalOperations(run.id, "restart after post-send crash")).toBe(operationInputs.length);
    expect(ledger.getBudgetUsage(run.id)).toEqual(before);
    expect(ledger.reconcileOpenBudgetReservations(run.id, "generic resume cleanup")).toBe(0);

    const unknownEvents = ledger.listEvents(run.id).filter((event) => event.type === "external.operation.unknown");
    expect(unknownEvents).toHaveLength(operationInputs.length);
    for (const [index, operationId] of operationIds.entries()) {
      const operation = ledger.requireExternalOperation(operationId);
      expect(operation.status).toBe("unknown_remote_outcome");
      expect(ledger.listOpenBudgetReservations(run.id).map((reservation) => reservation.reservationId))
        .toContain(operation.reservationId);
      const event = unknownEvents.find((item) => item.payload.operationId === operationId);
      expect(event?.payload).toMatchObject({
        operationType: operationInputs[index].operationType,
        provider: operationInputs[index].provider,
        retryPolicy: "explicit_retry_required",
        quarantine: {
          status: "quarantined",
          canSatisfyGoalEvidence: false,
          reservationPolicy: "retained_until_operator_reconciliation"
        }
      });
      const duplicate = ledger.prepareExternalOperation({
        runId: run.id,
        operationType: operationInputs[index].operationType,
        provider: operationInputs[index].provider,
        idempotencyKey: `post-send-crash-${index}`,
        requestHash: `post-send-request-hash-${index}`,
        requestArtifactId: operation.requestArtifactId,
        reserve: operationInputs[index].reserve
      });
      expect(duplicate.ok).toBe(true);
      if (!duplicate.ok) throw new Error("duplicate unexpectedly failed");
      expect(duplicate.created).toBe(false);
      expect(duplicate.operation.status).toBe("unknown_remote_outcome");
    }
    const report = renderReport(run.id, ledger);
    expect(report).toContain("external_operation_unknown_remote_outcome");
    expect(report).not.toContain("canClaimSolved: true");
  } finally {
    ledger.close();
  }
});

test("remote dispatch reconciliation dead-letters lost acknowledgements and retains reservation", () => {
  const { ledger, artifacts, run } = setup();
  try {
    const request = artifacts.create(run.id, "remote.worker.dispatch.request", JSON.stringify({
      worker: "fast-experiment",
      promptHash: "prompt-hash-1"
    }));
    const prepared = ledger.prepareExternalOperation({
      runId: run.id,
      operationType: "remote.worker.dispatch",
      provider: "remote-worker",
      idempotencyKey: "remote-dispatch-crash-key",
      requestHash: "remote-dispatch-request-hash",
      requestArtifactId: request.id,
      reserve: { attempts: 1, elapsedMs: 100, usd: 0.01 }
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok || !prepared.created) throw new Error("expected fresh remote dispatch operation");
    ledger.startExternalOperation(prepared.operation.id);

    const before = ledger.getBudgetUsage(run.id);
    expect(ledger.reconcileOpenExternalOperations(run.id, "lost remote worker acknowledgement")).toBe(1);
    expect(ledger.getBudgetUsage(run.id)).toEqual(before);
    expect(ledger.requireExternalOperation(prepared.operation.id).status).toBe("dead_lettered");
    expect(ledger.listOpenBudgetReservations(run.id).map((reservation) => reservation.reservationId))
      .toContain(prepared.operation.reservationId);
    expect(ledger.reconcileOpenBudgetReservations(run.id, "generic resume cleanup")).toBe(0);

    const deadLetterEvent = ledger.listEvents(run.id).find((event) => event.type === "external.operation.dead_lettered");
    expect(deadLetterEvent?.payload).toMatchObject({
      operationId: prepared.operation.id,
      operationType: "remote.worker.dispatch",
      provider: "remote-worker",
      retryPolicy: "new_dispatch_required",
      deadLetter: {
        status: "dead_lettered",
        canSatisfyGoalEvidence: false,
        reservationPolicy: "retained_until_operator_reconciliation",
        acknowledgement: "lost_or_timed_out"
      }
    });

    const duplicate = ledger.prepareExternalOperation({
      runId: run.id,
      operationType: "remote.worker.dispatch",
      provider: "remote-worker",
      idempotencyKey: "remote-dispatch-crash-key",
      requestHash: "remote-dispatch-request-hash",
      requestArtifactId: request.id,
      reserve: { attempts: 1, elapsedMs: 100, usd: 0.01 }
    });
    expect(duplicate.ok).toBe(true);
    if (!duplicate.ok) throw new Error("duplicate unexpectedly failed");
    expect(duplicate.created).toBe(false);
    expect(duplicate.operation.status).toBe("dead_lettered");

    const reconciliation = buildExternalOutcomeReconciliationReport(run.id, ledger);
    expect(reconciliation.ok).toBe(false);
    expect(reconciliation.issueCodes).toContain("dead_lettered_dispatch");
    expect(reconciliation.deadLetterOperations).toHaveLength(1);
    expect(reconciliation.openReservations[0]).toMatchObject({
      retainedForUnknownOutcome: false,
      retainedForExternalOutcome: true
    });
    expect(auditRun(run.id, ledger).ok).toBe(true);
    const report = renderReport(run.id, ledger);
    expect(report).toContain("external_operation_dead_lettered_dispatch");
    expect(report).not.toContain("canClaimSolved: true");
  } finally {
    ledger.close();
  }
});

test("markGoalMet requires verifier-backed grade and satisfying artifacts", () => {
  const { ledger, run } = setup();
  try {
    expect(() => ledger.markGoalMet(run.id, "conjectural_solution", { reason: "model consensus" }, ["art-1"]))
      .toThrow("non-verifier-backed");
    expect(() => ledger.markGoalMet(run.id, "verified_computation", { reason: "missing evidence" }, []))
      .toThrow("satisfying artifact IDs");
  } finally {
    ledger.close();
  }
});

test("markGoalMet requires a persisted GoalSuccessDecision token", () => {
  const { ledger, artifacts, run } = setup();
  try {
    const artifact = artifacts.create(run.id, "verifier.local.result", "verified");
    expect(() => ledger.markGoalMet(run.id, "verified_computation", {
      reason: "verifier-backed success",
      verifierId: "local-deterministic-v0",
      claimId: "claim-test"
    }, [artifact.id])).toThrow("GoalSuccessDecision token");
  } finally {
    ledger.close();
  }
});

test("markGoalMet requires a passed no-false-solved finalization gate", () => {
  const { ledger, artifacts, run } = setup();
  try {
    const artifact = artifacts.create(run.id, "verifier.local.result", "verified");
    const event = ledger.appendEvent(run.id, "goal.success.evaluated", {
      status: "goal_met",
      evidenceGrade: "verified_computation",
      finalState: "computational_evidence",
      canClaimSolved: true,
      reason: "verifier-backed success",
      criteria: [{ criterion: "verified evidence only", ok: true, reason: "accepted" }],
      problemClassification: { class: "standard_problem", triggers: [] },
      claimId: "claim-test",
      verifierId: "local-deterministic-v0",
      satisfyingArtifactIds: [artifact.id]
    }, [artifact.id]);

    expect(() => ledger.markGoalMet(run.id, "verified_computation", {
      reason: "verifier-backed success",
      verifierId: "local-deterministic-v0",
      claimId: "claim-test"
    }, [artifact.id], buildGoalSuccessDecisionToken({ runId: run.id, event })))
      .toThrow("no-false-solved finalization");
  } finally {
    ledger.close();
  }
});

test("markGoalMet rejects default synthetic adversarial finalization quorum", () => {
  const { ledger, artifacts, run } = setup();
  try {
    const artifact = artifacts.create(run.id, "verifier.local.result", "verified");
    const event = ledger.appendEvent(run.id, "goal.success.evaluated", {
      status: "goal_met",
      evidenceGrade: "verified_computation",
      finalState: "computational_evidence",
      canClaimSolved: true,
      reason: "verifier-backed success",
      criteria: [{ criterion: "verified evidence only", ok: true, reason: "accepted" }],
      problemClassification: { class: "standard_problem", triggers: [] },
      claimId: "claim-test",
      verifierId: "local-deterministic-v0",
      satisfyingArtifactIds: [artifact.id]
    }, [artifact.id]);
    const syntheticQuorum = persistAdversarialQuorumReview({
      runId: run.id,
      ledger,
      artifacts,
      scope: "finalization",
      targetEvent: event,
      targetArtifactIds: [artifact.id]
    });
    ledger.appendEvent(run.id, "goal.finalization.checked", {
      format: "matematica.no-false-solved-finalization",
      version: 1,
      runId: run.id,
      goalSuccessEventId: event.id,
      status: "passed",
      canMarkGoalMet: true,
      claimId: "claim-test",
      verifierId: "local-deterministic-v0",
      evidenceGrade: "verified_computation",
      finalState: "computational_evidence",
      canClaimSolved: true,
      problemClassification: { class: "standard_problem", triggers: [] },
      checks: [{
        id: "proof_certificate",
        status: "passed",
        reason: "test proof certificate accepted",
        artifactIds: [artifact.id]
      }, {
        id: "adversarial_planning_quorum",
        status: "passed",
        reason: "forged finalization cannot override synthetic quorum",
        artifactIds: [syntheticQuorum.artifact.id]
      }],
      failureReasons: [],
      satisfyingArtifactIds: [artifact.id],
      reviewHash: "forged-finalization-review"
    }, [syntheticQuorum.artifact.id, artifact.id]);

    expect(() => ledger.markGoalMet(run.id, "verified_computation", {
      reason: "verifier-backed success",
      verifierId: "local-deterministic-v0",
      claimId: "claim-test"
    }, [artifact.id], buildGoalSuccessDecisionToken({ runId: run.id, event })))
      .toThrow("default/synthetic critic source");
  } finally {
    ledger.close();
  }
});

test("markGoalMet rejects tampered or mismatched GoalSuccessDecision tokens", () => {
  const { ledger, artifacts, run } = setup();
  try {
    const artifact = artifacts.create(run.id, "verifier.local.result", "verified");
    const token = persistGoalSuccessDecision({
      ledger,
      artifacts,
      runId: run.id,
      evidenceGrade: "verified_computation",
      artifactIds: [artifact.id],
      claimId: "claim-test",
      verifierId: "local-deterministic-v0"
    });

    expect(() => ledger.markGoalMet(run.id, "verified_computation", {
      reason: "verifier-backed success",
      verifierId: "local-deterministic-v0",
      claimId: "claim-test"
    }, [artifact.id], {
      ...token,
      decisionHash: "tampered"
    })).toThrow("hash");

    expect(() => ledger.markGoalMet(run.id, "verified_computation", {
      reason: "verifier-backed success",
      verifierId: "local-deterministic-v0",
      claimId: "other-claim"
    }, [artifact.id], token)).toThrow("claim");
  } finally {
    ledger.close();
  }
});

test("markGoalMet rejects GoalSuccessDecision tokens from another run", () => {
  const { ledger, artifacts, run } = setup();
  try {
    const otherRun = ledger.createRun({
      problem: "Other theorem",
      goal: "Find verified computation",
      successCriteria: ["verified evidence only"],
      workflow: "pflk",
      budget: { maxAttempts: 1 }
    });
    const artifact = artifacts.create(run.id, "verifier.local.result", "verified");
    const otherArtifact = artifacts.create(otherRun.id, "verifier.local.result", "verified");
    const token = persistGoalSuccessDecision({
      ledger,
      artifacts,
      runId: otherRun.id,
      evidenceGrade: "verified_computation",
      artifactIds: [otherArtifact.id],
      claimId: "claim-test",
      verifierId: "local-deterministic-v0"
    });

    expect(() => ledger.markGoalMet(run.id, "verified_computation", {
      reason: "verifier-backed success",
      verifierId: "local-deterministic-v0",
      claimId: "claim-test"
    }, [artifact.id], token)).toThrow("different run");
  } finally {
    ledger.close();
  }
});

test("markGoalMet records exact satisfying artifact ids", () => {
  const { ledger, artifacts, run } = setup();
  try {
    const artifact = artifacts.create(run.id, "verifier.local.result", "verified");
    const token = persistGoalSuccessDecision({
      ledger,
      artifacts,
      runId: run.id,
      evidenceGrade: "verified_computation",
      artifactIds: [artifact.id],
      claimId: "claim-test",
      verifierId: "local-deterministic-v0"
    });
    const completed = ledger.markGoalMet(run.id, "verified_computation", {
      reason: "verifier-backed success",
      verifierId: "local-deterministic-v0",
      claimId: "claim-test"
    }, [artifact.id], token);

    expect(completed.status).toBe("goal_met");
    expect(completed.evidenceGrade).toBe("verified_computation");
    const goalCompleted = ledger.listEvents(run.id).findLast((event) => event.type === "goal.completed");
    expect(goalCompleted?.artifactIds).toEqual([artifact.id]);
    expect(goalCompleted?.payload.finalState).toBe("computational_evidence");
    expect(goalCompleted?.payload.canClaimSolved).toBe(true);
    expect(goalCompleted?.payload.satisfyingArtifactIds).toEqual([artifact.id]);
  } finally {
    ledger.close();
  }
});

test("budget reservations must settle exactly once", () => {
  const home = mkdtempSync(join(tmpdir(), "matematica-budget-reservation-test-"));
  homes.push(home);
  process.env.MATEMATICA_HOME = home;
  const ledger = new Ledger(getAppPaths().dbPath);
  const run = ledger.createRun({
    problem: "Account for external calls",
    goal: "Reserve before execution",
    successCriteria: ["exactly once settlement"],
    workflow: "pflk",
    budget: { maxAttempts: 2, maxTokens: 10 }
  });

  try {
    const reservation = ledger.reserveBudget({
      runId: run.id,
      reserve: { attempts: 1, tokens: 3 },
      operationType: "ai.generateText",
      operationId: "call-1",
      provider: "openai"
    });
    expect(reservation.ok).toBe(true);
    if (!reservation.ok) throw new Error("reservation unexpectedly failed");
    expect(ledger.getBudgetUsage(run.id)).toMatchObject({ attempts: 1, tokens: 3, usd: 0, elapsedMs: 0 });

    ledger.debitBudget({
      runId: run.id,
      reservationId: reservation.reservationId,
      debit: { attempts: 1, tokens: 3 },
      provider: "openai"
    });
    expect(ledger.getBudgetUsage(run.id)).toMatchObject({ attempts: 1, tokens: 3, usd: 0, elapsedMs: 0 });
    expect(() => ledger.releaseBudget({
      runId: run.id,
      reservationId: reservation.reservationId,
      reason: "too late"
    })).toThrow("already debited");
    expect(() => ledger.debitBudget({
      runId: run.id,
      reservationId: "budgetres_missing",
      debit: { attempts: 1 }
    })).toThrow("unknown budget reservation");
  } finally {
    ledger.close();
  }
});

test("budget debit cannot exceed its atomic reservation", () => {
  const { ledger, run } = setup();
  try {
    const reservation = ledger.reserveBudget({
      runId: run.id,
      reserve: { attempts: 1, tokens: 3 },
      operationType: "ai.generateText",
      operationId: "over-debit-call",
      provider: "openai"
    });
    expect(reservation.ok).toBe(true);
    if (!reservation.ok) throw new Error("reservation unexpectedly failed");

    expect(() => ledger.debitBudget({
      runId: run.id,
      reservationId: reservation.reservationId,
      debit: { attempts: 1, tokens: 4 },
      provider: "openai"
    })).toThrow("exceeds reserved");
    expect(ledger.getBudgetUsage(run.id)).toMatchObject({ attempts: 1, tokens: 3, usd: 0, elapsedMs: 0 });

    ledger.releaseBudget({
      runId: run.id,
      reservationId: reservation.reservationId,
      reason: "over-debit rejected"
    });
    expect(ledger.getBudgetUsage(run.id)).toMatchObject({ attempts: 0, tokens: 0, usd: 0, elapsedMs: 0 });
  } finally {
    ledger.close();
  }
});

test("phase hard caps count open reservations before starting more work", () => {
  const home = mkdtempSync(join(tmpdir(), "matematica-phase-budget-cap-test-"));
  homes.push(home);
  process.env.MATEMATICA_HOME = home;
  const ledger = new Ledger(getAppPaths().dbPath);
  const run = ledger.createRun({
    problem: "Bound phase spending",
    goal: "Loophole cannot consume feedback budget",
    successCriteria: ["phase cap blocks before spend"],
    workflow: "pflk",
    budget: { maxTokens: 100 }
  });

  try {
    const first = ledger.reserveBudget({
      runId: run.id,
      reserve: { tokens: 6 },
      operationType: "ai.generateText",
      operationId: "feedback-worker-1",
      phase: "feedback",
      provider: "openai",
      budgetCaps: { phase: { tokens: 10 } }
    });
    expect(first.ok).toBe(true);

    const rejected = ledger.reserveBudget({
      runId: run.id,
      reserve: { tokens: 5 },
      operationType: "ai.generateText",
      operationId: "feedback-worker-2",
      phase: "feedback",
      provider: "openai",
      budgetCaps: { phase: { tokens: 10 } }
    });
    expect(rejected.ok).toBe(false);
    if (rejected.ok) throw new Error("phase cap unexpectedly allowed reservation");
    expect(rejected.reason).toContain("phase tokens budget exceeded");
    expect(ledger.getGlobalBudgetUsage({ phase: "feedback" }).tokens).toBe(6);
    expect(ledger.listOpenBudgetReservations(run.id)).toHaveLength(1);
  } finally {
    ledger.close();
  }
});

test("goal_met is blocked while budget reservations are still open", () => {
  const { ledger, artifacts, run } = setup();
  try {
    const reservation = ledger.reserveBudget({
      runId: run.id,
      reserve: { attempts: 1 },
      operationType: "worker.job",
      operationId: "in-flight-worker"
    });
    expect(reservation.ok).toBe(true);
    if (!reservation.ok) throw new Error("reservation unexpectedly failed");
    const artifact = artifacts.create(run.id, "verifier.local.result", "verified");

    expect(() => ledger.markGoalMet(run.id, "verified_computation", {
      reason: "verifier-backed success",
      verifierId: "local-deterministic-v0"
    }, [artifact.id])).toThrow("open budget reservations");

    ledger.releaseBudget({
      runId: run.id,
      reservationId: reservation.reservationId,
      reason: "worker finished elsewhere"
    });
    const token = persistGoalSuccessDecision({
      ledger,
      artifacts,
      runId: run.id,
      evidenceGrade: "verified_computation",
      artifactIds: [artifact.id],
      verifierId: "local-deterministic-v0"
    });
    expect(() => ledger.markGoalMet(run.id, "verified_computation", {
      reason: "verifier-backed success",
      verifierId: "local-deterministic-v0"
    }, [artifact.id], token)).not.toThrow();
  } finally {
    ledger.close();
  }
});

test("global budget usage aggregates matching debits and open reservations across runs", () => {
  const home = mkdtempSync(join(tmpdir(), "matematica-global-budget-test-"));
  homes.push(home);
  process.env.MATEMATICA_HOME = home;
  const ledger = new Ledger(getAppPaths().dbPath);
  const firstRun = ledger.createRun({
    problem: "Spend openai budget",
    goal: "Record provider debit",
    successCriteria: ["global usage includes debits"],
    workflow: "pflk",
    budget: { maxTokens: 100 }
  });
  const secondRun = ledger.createRun({
    problem: "Hold anthropic budget",
    goal: "Record open reservation",
    successCriteria: ["global usage includes open reservations"],
    workflow: "gree",
    budget: { maxTokens: 100 }
  });

  try {
    const openaiReservation = ledger.reserveBudget({
      runId: firstRun.id,
      reserve: { tokens: 5 },
      operationType: "ai.generateText",
      operationId: "openai-call",
      provider: "openai"
    });
    expect(openaiReservation.ok).toBe(true);
    if (!openaiReservation.ok) throw new Error("openai reservation unexpectedly failed");
    ledger.debitBudget({
      runId: firstRun.id,
      reservationId: openaiReservation.reservationId,
      debit: { tokens: 4 },
      provider: "openai"
    });

    const anthropicReservation = ledger.reserveBudget({
      runId: secondRun.id,
      reserve: { tokens: 7 },
      operationType: "ai.generateText",
      operationId: "anthropic-call",
      provider: "anthropic"
    });
    expect(anthropicReservation.ok).toBe(true);

    const releasedReservation = ledger.reserveBudget({
      runId: secondRun.id,
      reserve: { tokens: 9 },
      operationType: "source.arxiv",
      operationId: "released-source",
      provider: "arxiv"
    });
    expect(releasedReservation.ok).toBe(true);
    if (!releasedReservation.ok) throw new Error("released reservation unexpectedly failed");
    ledger.releaseBudget({
      runId: secondRun.id,
      reservationId: releasedReservation.reservationId,
      reason: "cancelled before fetch"
    });

    expect(ledger.getGlobalBudgetUsage()).toMatchObject({ attempts: 0, tokens: 11, usd: 0, elapsedMs: 0 });
    expect(ledger.getGlobalBudgetUsage({ provider: "openai" })).toMatchObject({ attempts: 0, tokens: 4, usd: 0, elapsedMs: 0 });
    expect(ledger.getGlobalBudgetUsage({ provider: "anthropic" })).toMatchObject({ attempts: 0, tokens: 7, usd: 0, elapsedMs: 0 });
    expect(ledger.getGlobalBudgetUsage({ operationType: "source.arxiv" })).toMatchObject({ attempts: 0, tokens: 0, usd: 0, elapsedMs: 0 });
  } finally {
    ledger.close();
  }
});

test("open budget reservations reconcile on resume", () => {
  const home = mkdtempSync(join(tmpdir(), "matematica-budget-reconcile-test-"));
  homes.push(home);
  process.env.MATEMATICA_HOME = home;
  const ledger = new Ledger(getAppPaths().dbPath);
  const run = ledger.createRun({
    problem: "Recover from crash",
    goal: "Release open reservations",
    successCriteria: ["resume does not strand budget"],
    workflow: "gree",
    budget: { maxTokens: 10 }
  });

  try {
    const reservation = ledger.reserveBudget({
      runId: run.id,
      reserve: { tokens: 5 },
      operationType: "source.arxiv",
      operationId: "fetch-1"
    });
    expect(reservation.ok).toBe(true);
    expect(ledger.listOpenBudgetReservations(run.id)).toHaveLength(1);
    expect(ledger.reconcileOpenBudgetReservations(run.id, "resume reconciliation")).toBe(1);
    expect(ledger.listOpenBudgetReservations(run.id)).toHaveLength(0);
    expect(ledger.getBudgetUsage(run.id)).toMatchObject({ attempts: 0, tokens: 0, usd: 0, elapsedMs: 0 });
  } finally {
    ledger.close();
  }
});

test("markGoalMet classifies verified counterexample as counterexample not solved", () => {
  const { ledger, artifacts, run } = setup();
  try {
    const artifact = artifacts.create(run.id, "verifier.counterexample.result", "counterexample verified");
    const token = persistGoalSuccessDecision({
      ledger,
      artifacts,
      runId: run.id,
      evidenceGrade: "verified_counterexample",
      artifactIds: [artifact.id],
      claimId: "claim-counterexample",
      verifierId: "counterexample-checker",
      reason: "counterexample-checker success"
    });
    const completed = ledger.markGoalMet(run.id, "verified_counterexample", {
      reason: "counterexample-checker success",
      verifierId: "counterexample-checker",
      claimId: "claim-counterexample"
    }, [artifact.id], token);

    expect(completed.status).toBe("goal_met");
    expect(completed.evidenceGrade).toBe("verified_counterexample");
    const goalCompleted = ledger.listEvents(run.id).findLast((event) => event.type === "goal.completed");
    expect(goalCompleted?.payload.finalState).toBe("counterexample");
    expect(goalCompleted?.payload.canClaimSolved).toBe(false);
  } finally {
    ledger.close();
  }
});

test("post-terminal worker commits are persisted as ignored mutations", () => {
  const { ledger, run } = setup();
  try {
    const job = ledger.enqueueWorkerJob({ runId: run.id, kind: "experiment", payload: { n: 1 } });
    const [leased] = ledger.leaseWorkerJobs(run.id, "worker-a", 1, 10_000);
    expect(leased.id).toBe(job.id);
    ledger.markWorkerJobRunning(job.id, "worker-a", leased.attempts);
    ledger.updateRunStatus(run.id, "cancelled");

    expect(() => ledger.commitWorkerJob(job.id, "worker-a", leased.attempts, { artifactId: "late" }))
      .toThrow("Cannot commit worker job after terminal run");
    expect(ledger.requireWorkerJob(job.id).status).toBe("running");
    expect(ledger.listEvents(run.id).findLast((event) => event.type === "worker.mutation.ignored")?.payload)
      .toMatchObject({
        jobId: job.id,
        action: "commit",
        runStatus: "cancelled",
        ignored: true,
        terminalArbiter: {
          authority: "ledger.terminal-state-arbiter",
          reason: "post_terminal_mutation"
        }
      });
    expect(ledger.listEvents(run.id).map((event) => event.type)).not.toContain("worker.committed");
  } finally {
    ledger.close();
  }
});

test("post-terminal provider completions are quarantined as ignored mutations", () => {
  const { ledger, artifacts, run } = setup();
  try {
    const request = artifacts.create(run.id, "ai.generateText.request", "request");
    const response = artifacts.create(run.id, "ai.generateText.response", "response");
    const prepared = ledger.prepareExternalOperation({
      runId: run.id,
      operationType: "ai.generateText",
      provider: "openai",
      idempotencyKey: "late-provider-completion",
      requestHash: "late-provider-completion-hash",
      requestArtifactId: request.id,
      reserve: { attempts: 1, tokens: 10 }
    });
    if (!prepared.ok) throw new Error("external operation prepare failed");
    const operation = ledger.startExternalOperation(prepared.operation.id);
    ledger.updateRunStatus(run.id, "cancelled");

    expect(() => ledger.completeExternalOperation({
      operationId: operation.id,
      responseArtifactId: response.id,
      debit: { attempts: 1, tokens: 10 },
      provider: "openai"
    })).toThrow("Cannot complete external operation after terminal run");
    expect(ledger.requireExternalOperation(operation.id).status).toBe("unknown_remote_outcome");
    expect(ledger.listEvents(run.id).findLast((event) => event.type === "external.operation.ignored")?.payload)
      .toMatchObject({
        operationId: operation.id,
        action: "complete",
        runStatus: "cancelled",
        ignored: true,
        quarantine: {
          status: "quarantined",
          reservationPolicy: "retained_until_operator_reconciliation"
        }
      });
    expect(ledger.listEvents(run.id).map((event) => event.type)).not.toContain("external.operation.completed");
  } finally {
    ledger.close();
  }
});
