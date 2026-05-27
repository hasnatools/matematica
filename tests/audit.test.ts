import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "../src/artifacts";
import {
  auditRun,
  auditSavedEverything,
  buildSavedEverythingReleaseCoverageReport,
  SAVED_EVERYTHING_RELEASE_REQUIREMENTS
} from "../src/audit";
import { stableHash } from "../src/idempotency";
import { computeLedgerEventHash, Ledger } from "../src/ledger";
import { getAppPaths } from "../src/paths";
import { buildFinalAnswerProvenance, persistRunReport, renderReport } from "../src/report";
import { runGoal } from "../src/runner";
import { readArtifactText } from "../src/storage-encryption";

const homes: string[] = [];

function setup() {
  const home = mkdtempSync(join(tmpdir(), "matematica-audit-test-"));
  homes.push(home);
  process.env.MATEMATICA_HOME = home;
  const paths = getAppPaths();
  const ledger = new Ledger(paths.dbPath);
  const artifacts = new ArtifactStore(paths.artifactsDir, ledger);
  const run = ledger.createRun({
    problem: "Prove 1 + 1 = 2",
    goal: "Find verified computation",
    successCriteria: ["audit passes"],
    workflow: "pflk",
    budget: { maxAttempts: 1 }
  });
  return { ledger, artifacts, run };
}

function completeSourceRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    query: "all:prime",
    sourceId: "http://arxiv.org/abs/2401.00001v2",
    canonicalId: "2401.00001",
    version: 2,
    title: "A Complete Source Record",
    authors: ["Ada"],
    published: "2024-01-01T00:00:00Z",
    updated: "2024-01-02T00:00:00Z",
    retrievedAt: "2026-05-25T00:00:00.000Z",
    ranking: 1,
    url: "http://arxiv.org/abs/2401.00001v2",
    contentHash: "content-hash",
    abstractHash: "abstract-hash",
    snapshotHash: "snapshot-hash",
    extractedClaims: ["We prove a complete source record."],
    ...overrides
  };
}

function updateEventPayload(ledger: Ledger, eventId: string, payload: Record<string, unknown>): void {
  ledger.db.query("UPDATE ledger_events SET payload_json = ? WHERE id = ?").run(JSON.stringify(payload), eventId);
}

function stripNoArtifactJustification(ledger: Ledger, runId: string, eventId: string): void {
  const event = ledger.listEvents(runId).find((item) => item.id === eventId);
  if (!event) throw new Error(`missing event ${eventId}`);
  const payload = { ...event.payload };
  delete payload.noArtifactJustification;
  updateEventPayload(ledger, eventId, payload);
}

function rehashEventChain(ledger: Ledger, runId: string): void {
  let previousEventHash: string | undefined;
  const artifactHashesById = new Map(ledger.listArtifacts(runId).map((artifact) => [artifact.id, artifact.sha256]));
  for (const [sequence, event] of ledger.listEvents(runId).entries()) {
    const linkedArtifactHashes = event.artifactIds.map((artifactId) => ({
      artifactId,
      sha256: artifactHashesById.get(artifactId)
    }));
    const payloadHash = stableHash(event.payload);
    const schemaVersion = ledger.schemaVersion();
    const eventHash = computeLedgerEventHash({
      runId,
      type: event.type,
      payload: event.payload,
      artifactIds: event.artifactIds,
      sequence,
      payloadHash,
      linkedArtifactHashes,
      schemaVersion,
      previousEventHash
    });
    ledger.db.query(`
      UPDATE ledger_events
      SET sequence = ?,
          payload_hash = ?,
          linked_artifact_hashes_json = ?,
          schema_version = ?,
          previous_event_hash = ?,
          event_hash = ?
      WHERE id = ?
    `).run(
      sequence,
      payloadHash,
      JSON.stringify(linkedArtifactHashes),
      schemaVersion,
      previousEventHash ?? null,
      eventHash,
      event.id
    );
    previousEventHash = eventHash;
  }
}

afterEach(() => {
  delete process.env.MATEMATICA_HOME;
  while (homes.length > 0) {
    rmSync(homes.pop()!, { recursive: true, force: true });
  }
});

test("auditRun passes for intact run artifacts and schema", () => {
  const { ledger, artifacts, run } = setup();
  try {
    artifacts.create(run.id, "test.artifact", "intact");
    const witness = ledger.verifyLedgerWitness(run.id);
    expect(witness.ok).toBe(true);
    expect(witness.actual?.eventCount).toBe(ledger.listEvents(run.id).length);
    const result = auditRun(run.id, ledger);
    expect(result.ok).toBe(true);
    expect(result.events).toBeGreaterThan(0);
    expect(result.artifacts).toBe(1);
    expect(result.issues.filter((issue) => issue.severity === "error")).toHaveLength(0);
  } finally {
    ledger.close();
  }
});

test("persistRunReport records immutable run snapshot provenance before report.generated", () => {
  const { ledger, artifacts, run } = setup();
  try {
    const sourceArtifact = artifacts.create(run.id, "test.artifact", "snapshot source");
    const persisted = persistRunReport(run.id, ledger, artifacts);
    const snapshot = JSON.parse(readArtifactText(persisted.snapshotArtifact)) as Record<string, unknown>;
    const reportEvent = ledger.listEvents(run.id).findLast((event) => event.type === "report.generated");

    expect(snapshot.format).toBe("matematica.run-report-snapshot");
    expect(snapshot.runId).toBe(run.id);
    expect(snapshot.regenerated).toBe(false);
    expect(snapshot.reportHash).toBe(persisted.reportHash);
    expect(snapshot.reportInputHash).toBe(persisted.reportInputHash);
    expect((snapshot.artifactManifest as Array<Record<string, unknown>>).map((item) => item.id)).toContain(sourceArtifact.id);
    expect((snapshot.artifactManifest as Array<Record<string, unknown>>).map((item) => item.id)).not.toContain(persisted.snapshotArtifact.id);
    expect(reportEvent?.payload).toMatchObject({
      snapshotArtifactId: persisted.snapshotArtifact.id,
      reportArtifactId: persisted.reportArtifact.id,
      reportInputHash: persisted.reportInputHash,
      reportHash: persisted.reportHash,
      regenerated: false
    });
    expect(reportEvent?.artifactIds).toEqual([persisted.snapshotArtifact.id, persisted.reportArtifact.id]);
    expect(auditRun(run.id, ledger).ok).toBe(true);
  } finally {
    ledger.close();
  }
});

test("auditRun rejects report.generated events without immutable snapshot links", () => {
  const { ledger, artifacts, run } = setup();
  try {
    const reportArtifact = artifacts.create(run.id, "report.final", renderReport(run.id, ledger));
    ledger.appendEvent(run.id, "report.generated", {
      reportId: "legacy-report",
      reportArtifactId: reportArtifact.id
    }, [reportArtifact.id]);

    const result = auditRun(run.id, ledger);
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("report_snapshot_provenance_missing");
  } finally {
    ledger.close();
  }
});

test("auditRun rejects run snapshot drift after source event mutation", () => {
  const { ledger, artifacts, run } = setup();
  try {
    const source = artifacts.create(run.id, "test.artifact", "source before report");
    persistRunReport(run.id, ledger, artifacts);
    const sourceEvent = ledger.listEvents(run.id).find((event) =>
      event.type === "artifact.created" &&
      event.artifactIds.includes(source.id)
    );
    if (!sourceEvent) throw new Error("missing source artifact event");
    updateEventPayload(ledger, sourceEvent.id, {
      ...sourceEvent.payload,
      bytes: 999
    });
    rehashEventChain(ledger, run.id);
    ledger.refreshLedgerWitness(run.id);

    const result = auditRun(run.id, ledger);
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("report_snapshot_source_event_drift");
  } finally {
    ledger.close();
  }
});

test("auditRun detects missing external ledger witness", () => {
  const { ledger, artifacts, run } = setup();
  try {
    artifacts.create(run.id, "test.artifact", "witness");
    const witness = ledger.verifyLedgerWitness(run.id);
    expect(witness.ok).toBe(true);
    rmSync(witness.path, { force: true });

    const result = auditRun(run.id, ledger);
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("ledger_witness_missing");
  } finally {
    ledger.close();
  }
});

test("ledger events persist integrity manifests and terminal roots", async () => {
  const { ledger, artifacts, run } = setup();
  try {
    await runGoal(run.id, ledger, artifacts, {
      arxivSearch: async () => []
    });
    const events = ledger.listEvents(run.id);
    expect(events.length).toBeGreaterThan(1);
    for (const [index, event] of events.entries()) {
      expect(event.sequence).toBe(index);
      expect(event.payloadHash).toBe(stableHash(event.payload));
      expect(event.linkedArtifactHashes).toEqual(event.artifactIds.map((artifactId) => {
        const artifact = ledger.listArtifacts(run.id).find((item) => item.id === artifactId);
        return { artifactId, sha256: artifact?.sha256 };
      }));
      expect(event.schemaVersion).toBe(ledger.schemaVersion());
      expect(event.eventHash).toBeString();
    }
    const terminal = events.findLast((event) => event.type === "goal.completed" || event.type === "goal.failed");
    expect(terminal).toBeTruthy();
    expect(terminal!.payload.terminalIntegrity).toEqual({
      chainVersion: 1,
      previousEventHash: terminal!.previousEventHash ?? null,
      artifactRoot: stableHash(terminal!.linkedArtifactHashes ?? []),
      schemaVersion: terminal!.schemaVersion
    });

    const result = auditRun(run.id, ledger);
    expect(result.ok).toBe(true);
  } finally {
    ledger.close();
  }
});

test("auditRun detects fully rehashed SQLite-only event forgery through external witness", () => {
  const { ledger, artifacts, run } = setup();
  try {
    const artifact = artifacts.create(run.id, "test.artifact", "witness-forgery");
    const event = ledger.appendEvent(run.id, "phase.completed", {
      phase: "feedback",
      status: "done"
    }, [artifact.id]);
    updateEventPayload(ledger, event.id, {
      phase: "feedback",
      status: "forged"
    });
    rehashEventChain(ledger, run.id);

    const result = auditRun(run.id, ledger);
    const codes = result.issues.map((issue) => issue.code);
    expect(result.ok).toBe(false);
    expect(codes).toContain("ledger_witness_event_log_mismatch");
    expect(codes).not.toContain("event_hash_mismatch");
    expect(codes).not.toContain("event_payload_hash_mismatch");
    const report = renderReport(run.id, ledger);
    expect(report).toContain("Audit integrity: fail");
    expect(report).toContain("Can claim solved: no");
  } finally {
    ledger.close();
  }
});

test("auditRun includes external operation idempotency keys", () => {
  const { ledger, artifacts, run } = setup();
  try {
    const request = artifacts.create(run.id, "ai.request", "{}");
    const prepared = ledger.prepareExternalOperation({
      runId: run.id,
      operationType: "ai.generateText",
      provider: "openai",
      idempotencyKey: "extop_ai_generatetext_1234567890abcdef1234567890abcdef",
      requestHash: "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      reserve: { tokens: 1 },
      requestArtifactId: request.id
    });
    expect(prepared.ok).toBe(true);

    const result = auditRun(run.id, ledger);
    expect(result.externalOperations).toHaveLength(1);
    expect(result.externalOperations[0]).toMatchObject({
      operationType: "ai.generateText",
      provider: "openai",
      idempotencyKey: "extop_ai_generatetext_1234567890abcdef1234567890abcdef",
      requestHash: "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      status: "reserved"
    });
  } finally {
    ledger.close();
  }
});

test("auditRun detects hidden external operation state without action events", () => {
  const { ledger, artifacts, run } = setup();
  try {
    const request = artifacts.create(run.id, "ai.request", "{}");
    const response = artifacts.create(run.id, "ai.response", "{}");
    const prepared = ledger.prepareExternalOperation({
      runId: run.id,
      operationType: "ai.generateText",
      provider: "openai",
      idempotencyKey: "extop_ai_hidden_1234567890abcdef1234567890abcdef",
      requestHash: "hidden1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab",
      reserve: { tokens: 1 },
      requestArtifactId: request.id
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error("expected prepared operation");
    ledger.db.query(`
      UPDATE external_operations
      SET status = 'succeeded',
          response_artifact_id = ?,
          completed_at = updated_at
      WHERE id = ?
    `).run(response.id, prepared.operation.id);

    const result = auditRun(run.id, ledger);
    const codes = result.issues.map((issue) => issue.code);
    expect(result.ok).toBe(false);
    expect(codes).toContain("external_operation_missing_started_event");
    expect(codes).toContain("external_operation_missing_completed_event");
    expect(codes).toContain("external_operation_missing_domain_completion_event");
  } finally {
    ledger.close();
  }
});

test("auditRun detects hidden worker job state without lifecycle events", () => {
  const { ledger, run } = setup();
  try {
    const now = new Date().toISOString();
    ledger.db.query(`
      INSERT INTO worker_jobs (
        id, run_id, kind, payload_json, dedupe_key, status, lease_owner,
        lease_expires_at, attempts, max_attempts, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "job_hidden_action",
      run.id,
      "workflow.branch",
      JSON.stringify({ phase: "loophole", hidden: true }),
      "hidden-job-dedupe",
      "committed",
      null,
      null,
      1,
      1,
      now,
      now
    );

    const result = auditRun(run.id, ledger);
    const codes = result.issues.map((issue) => issue.code);
    expect(result.ok).toBe(false);
    expect(codes).toContain("worker_job_missing_enqueued_event");
    expect(codes).toContain("worker_job_missing_lease_event");
    expect(codes).toContain("worker_job_missing_committed_event");
    expect(codes).toContain("worker_job_missing_completed_event");
  } finally {
    ledger.close();
  }
});

test("auditRun detects artifact hash mismatch", () => {
  const { ledger, artifacts, run } = setup();
  try {
    const artifact = artifacts.create(run.id, "test.artifact", "original");
    writeFileSync(artifact.path, "tampered");
    const result = auditRun(run.id, ledger);
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.code === "artifact_hash_mismatch")).toBe(true);
  } finally {
    ledger.close();
  }
});

test("auditRun detects ledger event hash-chain tampering", () => {
  const { ledger, artifacts, run } = setup();
  try {
    const artifact = artifacts.create(run.id, "test.artifact", "hash-chain");
    const first = ledger.appendEvent(run.id, "phase.completed", {
      phase: "feedback",
      status: "done"
    }, [artifact.id]);
    const second = ledger.appendEvent(run.id, "worker.ranked", {
      kind: "experiment",
      rankedJobs: []
    });

    updateEventPayload(ledger, first.id, {
      phase: "feedback",
      status: "tampered"
    });
    let result = auditRun(run.id, ledger);
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("event_hash_mismatch");

    ledger.db.query("UPDATE ledger_events SET artifact_ids_json = ? WHERE id = ?")
      .run(JSON.stringify([]), first.id);
    result = auditRun(run.id, ledger);
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("event_hash_mismatch");

    ledger.db.query("DELETE FROM ledger_events WHERE id = ?").run(first.id);
    result = auditRun(run.id, ledger);
    const codes = result.issues.map((issue) => issue.code);
    expect(codes).toContain("event_sequence_gap");
    expect(codes).toContain("event_previous_hash_mismatch");
    expect(ledger.listEvents(run.id).some((event) => event.id === second.id)).toBe(true);
  } finally {
    ledger.close();
  }
});

test("auditRun detects missing event integrity manifest columns", () => {
  const { ledger, artifacts, run } = setup();
  try {
    const artifact = artifacts.create(run.id, "test.artifact", "manifest");
    const event = ledger.appendEvent(run.id, "phase.completed", {
      phase: "feedback",
      status: "done"
    }, [artifact.id]);

    ledger.db.query(`
      UPDATE ledger_events
      SET payload_hash = NULL,
          linked_artifact_hashes_json = NULL,
          schema_version = NULL
      WHERE id = ?
    `).run(event.id);

    const result = auditRun(run.id, ledger);
    expect(result.ok).toBe(false);
    const codes = result.issues.map((issue) => issue.code);
    expect(codes).toContain("event_payload_hash_missing");
    expect(codes).toContain("event_linked_artifact_hashes_missing");
    expect(codes).toContain("event_schema_version_missing");
    expect(codes).toContain("event_hash_mismatch");
  } finally {
    ledger.close();
  }
});

test("auditRun fails closed when required ledger maintenance indexes are missing", () => {
  const { ledger, run } = setup();
  try {
    ledger.appendEvent(run.id, "phase.completed", {
      phase: "feedback",
      status: "done"
    });
    ledger.db.exec("DROP INDEX IF EXISTS idx_ledger_events_run_created_sequence");

    const result = auditRun(run.id, ledger);
    expect(result.ok).toBe(false);
    expect(result.maintenance.integrity.requiredIndexesPresent).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("ledger_required_index_missing");
  } finally {
    ledger.close();
  }
});

test("auditRun detects artifact row and file swaps against linked event manifests", () => {
  const { ledger, artifacts, run } = setup();
  try {
    const artifact = artifacts.create(run.id, "test.artifact", "original");
    ledger.appendEvent(run.id, "phase.completed", {
      phase: "feedback",
      status: "done"
    }, [artifact.id]);

    const forgedContent = "forged";
    const forgedHash = createHash("sha256").update(forgedContent).digest("hex");
    writeFileSync(artifact.path, forgedContent);
    ledger.db.query("UPDATE artifacts SET sha256 = ?, bytes = ? WHERE id = ?")
      .run(forgedHash, Buffer.byteLength(forgedContent), artifact.id);

    const result = auditRun(run.id, ledger);
    expect(result.ok).toBe(false);
    const codes = result.issues.map((issue) => issue.code);
    expect(codes).toContain("event_linked_artifact_hash_mismatch");
    expect(codes).toContain("artifact_created_payload_mismatch");
    expect(codes).not.toContain("artifact_hash_mismatch");
  } finally {
    ledger.close();
  }
});

test("auditRun detects missing raw/redacted artifact provenance", () => {
  const { ledger, artifacts, run } = setup();
  try {
    const artifact = artifacts.create(run.id, "test.artifact", "provenance");
    ledger.db.query("UPDATE artifacts SET provenance_json = NULL WHERE id = ?").run(artifact.id);

    const result = auditRun(run.id, ledger);
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("artifact_provenance_missing");
    expect(result.issues.map((issue) => issue.code)).toContain("artifact_created_payload_mismatch");
  } finally {
    ledger.close();
  }
});

test("ledger reopen does not repair missing integrity evidence before audit", () => {
  const { ledger, artifacts, run } = setup();
  const dbPath = getAppPaths().dbPath;
  try {
    const artifact = artifacts.create(run.id, "test.artifact", "reopen");
    const event = ledger.appendEvent(run.id, "phase.completed", {
      phase: "feedback",
      status: "done"
    }, [artifact.id]);
    ledger.db.query("UPDATE ledger_events SET payload_hash = NULL WHERE id = ?").run(event.id);
    ledger.close();

    const reopened = new Ledger(dbPath);
    try {
      const result = auditRun(run.id, reopened);
      expect(result.ok).toBe(false);
      expect(result.issues.map((issue) => issue.code)).toContain("event_payload_hash_missing");
    } finally {
      reopened.close();
    }
  } finally {
    try {
      ledger.close();
    } catch {
      // The test closes and reopens the ledger deliberately.
    }
  }
});

test("auditRun detects forged terminal integrity roots even after event rehash", async () => {
  const { ledger, artifacts, run } = setup();
  try {
    await runGoal(run.id, ledger, artifacts, {
      arxivSearch: async () => []
    });
    const terminal = ledger.listEvents(run.id).findLast((event) => event.type === "goal.completed" || event.type === "goal.failed");
    expect(terminal).toBeTruthy();
    updateEventPayload(ledger, terminal!.id, {
      ...terminal!.payload,
      terminalIntegrity: {
        ...(terminal!.payload.terminalIntegrity as Record<string, unknown>),
        artifactRoot: "forged-artifact-root"
      }
    });
    rehashEventChain(ledger, run.id);

    const result = auditRun(run.id, ledger);
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("terminal_artifact_root_mismatch");
  } finally {
    ledger.close();
  }
});

test("renderReport disables solved trust claims when audit fails", async () => {
  const { ledger, artifacts, run } = setup();
  try {
    await runGoal(run.id, ledger, artifacts, {
      arxivSearch: async () => []
    });
    const terminal = ledger.listEvents(run.id).findLast((event) => event.type === "goal.completed");
    expect(terminal).toBeTruthy();
    updateEventPayload(ledger, terminal!.id, {
      ...terminal!.payload,
      canClaimSolved: true,
      finalState: "formal_proof"
    });

    const report = renderReport(run.id, ledger);
    expect(report).toContain("Audit integrity: fail");
    expect(report).toContain("Can claim solved: no");
    expect(report).toContain("Output trust label: needs human review");
    expect(report).toContain("Final Answer Provenance");
    const provenance = buildFinalAnswerProvenance(run.id, ledger);
    expect(provenance.outcome.canClaimSolved).toBe(false);
    expect(provenance.outcome.failClosedReasons).toContain("audit_failed");
    expect(provenance.audit.ok).toBe(false);
  } finally {
    ledger.close();
  }
});

test("auditRun detects action events that bypass persisted artifacts", () => {
  const { ledger, run } = setup();
  try {
    ledger.appendEvent(run.id, "ai.call.completed", {
      callId: "bypassed-ai-call",
      requestArtifactId: "missing-request",
      responseArtifactId: "missing-response",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
    });
    ledger.appendEvent(run.id, "source.results", {
      provider: "arxiv",
      artifactId: "missing-source-artifact"
    });
    ledger.appendEvent(run.id, "verifier.completed", {
      verifier: "lean4",
      status: "verified"
    });

    const result = auditRun(run.id, ledger);
    expect(result.ok).toBe(false);
    const codes = result.issues.map((issue) => issue.code);
    expect(codes).toContain("ai_call_missing_request_artifact");
    expect(codes).toContain("ai_call_missing_response_artifact");
    expect(codes).toContain("source_results_missing_artifact");
    expect(codes).toContain("verifier_missing_artifacts");
  } finally {
    ledger.close();
  }
});

test("auditRun detects external-effect events without a real outbox reservation", () => {
  const { ledger, artifacts, run } = setup();
  try {
    const request = artifacts.create(run.id, "source.arxiv.request", JSON.stringify({ query: "all:prime" }));
    ledger.appendEvent(run.id, "source.query", {
      provider: "arxiv",
      query: "all:prime",
      externalOperationId: "extop_forged_missing_row",
      reservationId: "budgetres_forged_missing_row",
      requestArtifactId: request.id
    }, [request.id]);

    const result = auditRun(run.id, ledger);

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("external_effect_missing_operation_row");
  } finally {
    ledger.close();
  }
});

test("auditRun detects settled external operations with duplicate budget settlements", () => {
  const { ledger, artifacts, run } = setup();
  try {
    const request = artifacts.create(run.id, "ai.request", JSON.stringify({ prompt: "settle once" }));
    const prepared = ledger.prepareExternalOperation({
      runId: run.id,
      operationType: "ai.generateText",
      provider: "openai",
      idempotencyKey: "duplicate-settlement-key",
      requestHash: "duplicate-settlement-request-hash",
      requestArtifactId: request.id,
      reserve: { attempts: 1, tokens: 10 }
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok || !prepared.created) throw new Error("expected operation");
    const operation = ledger.startExternalOperation(prepared.operation.id);
    const response = artifacts.create(run.id, "ai.response", JSON.stringify({ text: "ok", usage: { totalTokens: 4 } }));
    ledger.completeExternalOperation({
      operationId: operation.id,
      responseArtifactId: response.id,
      debit: { attempts: 1, tokens: 4 },
      provider: "openai"
    });
    ledger.appendEvent(run.id, "budget.released", {
      reservationId: operation.reservationId,
      release: { attempts: 0, tokens: 6, usd: 0, elapsedMs: 0, artifactBytes: 0, sourceQueries: 0, retries: 0, sandboxMs: 0 },
      reason: "forged second settlement",
      operationType: "ai.generateText",
      operationId: "duplicate-settlement-key"
    });

    const result = auditRun(run.id, ledger);

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("external_operation_budget_settlement_cardinality");
  } finally {
    ledger.close();
  }
});

test("auditRun rejects provider retry events with broken lineage", () => {
  const { ledger, artifacts } = setup();
  try {
    const run = ledger.createRun({
      problem: "Audit retry lineage",
      goal: "Reject malformed retry linkage",
      successCriteria: ["retry lineage is consistent"],
      workflow: "pflk",
      budget: { maxAttempts: 4, maxTokens: 50 }
    });
    const parentRequest = artifacts.create(run.id, "ai.request", JSON.stringify({ prompt: "retry parent" }));
    const parent = ledger.prepareExternalOperation({
      runId: run.id,
      operationType: "ai.generateText",
      provider: "openai",
      idempotencyKey: "retry-parent-key",
      requestHash: "retry-parent-request-hash",
      requestArtifactId: parentRequest.id,
      reserve: { attempts: 1, tokens: 5 }
    });
    expect(parent.ok).toBe(true);
    if (!parent.ok || !parent.created) throw new Error("expected parent operation");
    const parentOperation = ledger.startExternalOperation(parent.operation.id);

    const retryRequest = artifacts.create(run.id, "ai.retry.request", JSON.stringify({ prompt: "retry child" }));
    const retry = ledger.prepareExternalOperation({
      runId: run.id,
      operationType: "ai.generateText.retry",
      provider: "openai",
      idempotencyKey: "retry-child-key",
      requestHash: "retry-child-request-hash",
      requestArtifactId: retryRequest.id,
      reserve: { attempts: 1, tokens: 5 },
      retryOfOperationId: parentOperation.id
    });
    expect(retry.ok).toBe(true);
    if (!retry.ok || !retry.created) throw new Error("expected retry operation");
    const retryOperation = ledger.startExternalOperation(retry.operation.id);
    const retryError = artifacts.create(run.id, "ai.retry.error", JSON.stringify({ error: "rate limited" }));
    ledger.failExternalOperation({
      operationId: retryOperation.id,
      errorMessage: "rate limited",
      errorArtifactId: retryError.id,
      debit: { attempts: 1, tokens: 5 },
      provider: "openai"
    });
    ledger.failExternalOperation({
      operationId: parentOperation.id,
      errorMessage: "parent failed after retry",
      releaseReason: "parent failed after retry",
      provider: "openai"
    });
    ledger.appendEvent(run.id, "provider.retry.scheduled", {
      provider: "openai",
      modelId: "fake-audit-retry-model",
      callId: "call-audit-retry",
      externalOperationId: parentOperation.id,
      retryAttemptOperationId: retryOperation.id,
      requestHash: "retry-parent-request-hash",
      requestArtifactId: parentRequest.id,
      failedAttempt: 1,
      nextAttempt: 2,
      delayMs: 100,
      reason: "retry_after",
      classification: { kind: "rate_limit", retryable: true },
      retryReservationId: "budgetres_wrong_retry_reservation",
      retryDebit: { attempts: 1, tokens: 5, usd: 0, elapsedMs: 100, artifactBytes: 0, sourceQueries: 0, retries: 0, sandboxMs: 0 },
      retryRequestArtifactId: retryRequest.id,
      retryErrorArtifactId: retryError.id
    }, [parentRequest.id, retryRequest.id, retryError.id]);

    const result = auditRun(run.id, ledger);

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("retry_lineage_reservation_mismatch");
  } finally {
    ledger.close();
  }
});

test("auditRun rejects hallucinated source citations", () => {
  const { ledger, artifacts, run } = setup();
  try {
    const artifact = artifacts.create(run.id, "source.arxiv.results", JSON.stringify({ sourceRecords: [] }));
    ledger.appendEvent(run.id, "source.citations.reviewed", {
      provider: "arxiv",
      query: "all:fake",
      ok: false,
      requiresAdversarialReview: true,
      trustImpact: "adversarial_review_required",
      findings: [{
        status: "missing_source",
        citation: { sourceId: "arXiv:2501.99999", title: "Fake Citation" },
        reason: "citation does not map to a fetched source record"
      }]
    }, [artifact.id]);

    const result = auditRun(run.id, ledger);
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("source_citation_grounding_failed");
  } finally {
    ledger.close();
  }
});

test("auditRun rejects grounded citations without independent support review", () => {
  const { ledger, artifacts, run } = setup();
  try {
    const artifact = artifacts.create(run.id, "source.arxiv.results", JSON.stringify({ sourceRecords: [] }));
    ledger.appendEvent(run.id, "source.citations.reviewed", {
      provider: "arxiv",
      query: "all:prime",
      ok: true,
      requiresAdversarialReview: false,
      trustImpact: "none",
      supportPolicy: {
        sourceExistenceIsNotMathematicalSupport: true,
        exactArxivVersionRequired: true,
        snapshotHashRequired: true,
        quotedSpanRequired: true,
        independentEntailmentRequired: true,
        licenseAndProvenanceRequired: true,
        canSupportSolvedClaim: false
      },
      findings: [{
        status: "grounded",
        citation: {
          sourceId: "arXiv:2401.00001v2",
          title: "A Complete Source Record"
        },
        matchedSourceId: "http://arxiv.org/abs/2401.00001v2",
        matchedSnapshotHash: "snapshot-hash",
        reason: "source exists"
      }]
    }, [artifact.id]);

    const result = auditRun(run.id, ledger);
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("source_citation_support_review_missing");
  } finally {
    ledger.close();
  }
});

test("auditRun rejects incomplete source metadata", () => {
  const { ledger, artifacts, run } = setup();
  try {
    const artifact = artifacts.create(run.id, "source.arxiv.results", JSON.stringify({ sourceRecords: [] }));
    ledger.appendEvent(run.id, "source.results", {
      provider: "arxiv",
      query: "all:prime",
      count: 1,
      artifactId: artifact.id,
      sourceRecords: [{
        query: "all:prime",
        sourceId: "http://arxiv.org/abs/2401.00001v2",
        canonicalId: "2401.00001",
        title: "A Source Without Enough Metadata",
        authors: ["Ada"],
        updated: "2024-01-02T00:00:00Z",
        retrievedAt: "2026-05-25T00:00:00.000Z",
        ranking: 1,
        url: "http://arxiv.org/abs/2401.00001v2",
        contentHash: "abc"
      }]
    }, [artifact.id]);

    const result = auditRun(run.id, ledger);
    expect(result.ok).toBe(false);
    const issue = result.issues.find((item) => item.code === "source_record_incomplete_metadata");
    expect(issue?.message).toContain("version");
    expect(issue?.message).toContain("extractedClaims");
  } finally {
    ledger.close();
  }
});

test("auditRun requires source license redistribution manifest", () => {
  const { ledger, artifacts, run } = setup();
  try {
    const artifact = artifacts.create(run.id, "source.arxiv.results", JSON.stringify({ sourceRecords: [] }));
    ledger.appendEvent(run.id, "source.results", {
      provider: "arxiv",
      query: "all:prime",
      count: 1,
      artifactId: artifact.id,
      sourceRecords: [completeSourceRecord()]
    }, [artifact.id]);

    const result = auditRun(run.id, ledger);
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("source_license_manifest_missing");
  } finally {
    ledger.close();
  }
});

test("auditRun rejects source license manifests that export arXiv source content or hide stale hostile sources", () => {
  const { ledger, artifacts, run } = setup();
  try {
    const record = completeSourceRecord({ updated: "2019-01-01T00:00:00Z" });
    const manifestEntry = {
      provider: "arxiv",
      sourceId: record.sourceId,
      canonicalId: record.canonicalId,
      version: record.version,
      retrievalTimestamp: record.retrievedAt,
      contentHash: record.contentHash,
      citationFormat: "arXiv:2401.00001v2",
      license: {
        metadataRedistribution: "allowed",
        pdfAndSourceRedistribution: "not_exported_without_license",
        termsUrl: "https://info.arxiv.org/help/api/tou.html"
      },
      staleStatus: {
        status: "fresh",
        staleBefore: "2020-01-01T00:00:00Z",
        updated: record.updated
      },
      copiedTextPolicy: {
        policy: "metadata_and_abstract_excerpt_only",
        pdfExported: true,
        sourceExported: true,
        fullTextExported: false,
        supportTextIsProofSupport: false
      },
      verifiedSupport: {
        status: "citation_metadata_and_support_verified",
        proofSupport: "proof_support",
        canSupportSolvedClaim: true,
        findingStatuses: ["grounded"]
      },
      hostileSource: {
        flagged: false,
        flags: []
      },
      storagePolicy: "metadata_only_not_exported",
      manifestHash: "manifest-entry-hash"
    };
    const artifact = artifacts.create(run.id, "source.arxiv.results", JSON.stringify({ sourceRecords: [record] }));
    ledger.appendEvent(run.id, "source.results", {
      provider: "arxiv",
      query: "all:prime",
      count: 1,
      artifactId: artifact.id,
      staleBefore: "2020-01-01T00:00:00Z",
      hostileFlags: ["ignore instructions"],
      sourceRecords: [record],
      citationLicenseManifest: {
        format: "matematica.citation-license-manifest",
        version: 1,
        provider: "arxiv",
        entries: [manifestEntry],
        summary: {
          count: 1,
          staleCount: 0,
          hostileCount: 0,
          pdfOrSourceContentExported: true,
          copiedTextPolicy: "metadata_and_abstract_excerpt_only",
          proofSupportPolicy: "not_separated"
        },
        manifestHash: "manifest-hash"
      }
    }, [artifact.id]);

    const result = auditRun(run.id, ledger);
    const codes = result.issues.map((issue) => issue.code);
    expect(result.ok).toBe(false);
    expect(codes).toContain("source_pdf_or_source_exported_without_license");
    expect(codes).toContain("source_license_manifest_missing_proof_boundary");
    expect(codes).toContain("source_stale_status_not_flagged");
    expect(codes).toContain("source_hostile_status_not_flagged");
  } finally {
    ledger.close();
  }
});

test("renderReport fails audit when final source-derived claims lack citations", () => {
  const { ledger, artifacts, run } = setup();
  try {
    const artifact = artifacts.create(run.id, "final.source.claim", JSON.stringify({
      claim: "This is a novel route through gathered literature."
    }));
    ledger.appendEvent(run.id, "goal.completed", {
      status: "failed",
      evidenceGrade: "heuristic_evidence",
      finalState: "needs_human_review",
      canClaimSolved: false,
      sourceDerivedClaims: [{
        claim: "This is a novel route through gathered literature.",
        sourceDerived: true,
        noveltyClaim: true
      }]
    }, [artifact.id]);

    const result = auditRun(run.id, ledger);
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("source_derived_claim_missing_citation_artifacts");
    expect(result.issues.map((issue) => issue.code)).toContain("source_derived_claim_missing_source_ids");
    expect(result.issues.map((issue) => issue.code)).toContain("novelty_claim_missing_source_comparison");

    const report = renderReport(run.id, ledger);
    expect(report).toContain("Audit integrity: fail");
    expect(report).toContain("source_derived_claim_missing_citation_artifacts");
  } finally {
    ledger.close();
  }
});

test("auditRun detects side-table rows without matching ledger events", () => {
  const { ledger, run } = setup();
  try {
    const now = new Date().toISOString();
    ledger.db.query(`
      INSERT INTO scores (id, run_id, subject_id, scorer, score, rubric_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("score-hidden", run.id, "claim-hidden", "hidden-scorer", 0.5, JSON.stringify({ hidden: true }), now);
    ledger.db.query(`
      INSERT INTO reports (id, run_id, kind, artifact_id, generated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run("report-hidden", run.id, "final", null, now);
    ledger.db.query(`
      INSERT INTO source_records (id, run_id, provider, query, source_id, title, url, retrieved_at, artifact_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("source-hidden", run.id, "arxiv", "query", "2401.00001", "Hidden source", "https://arxiv.org/abs/2401.00001", now, null);
    ledger.db.query(`
      INSERT INTO verifier_runs (id, run_id, verifier_id, status, evidence_grade, started_at, completed_at, artifact_ids_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("verifier-hidden", run.id, "lean4", "verified", "formal_proof", now, now, JSON.stringify([]));

    const result = auditRun(run.id, ledger);
    expect(result.ok).toBe(false);
    const hiddenIssues = result.issues.filter((issue) => issue.code === "side_table_missing_event");
    expect(hiddenIssues.map((issue) => issue.message)).toEqual(expect.arrayContaining([
      expect.stringContaining("Score row score-hidden"),
      expect.stringContaining("Report row report-hidden"),
      expect.stringContaining("Source record row source-hidden"),
      expect.stringContaining("Verifier run row verifier-hidden")
    ]));
  } finally {
    ledger.close();
  }
});

test("auditRun detects score row mismatch against evidence.scored event", () => {
  const { ledger, run } = setup();
  try {
    const stored = ledger.insertScore({
      runId: run.id,
      subjectId: "claim-test",
      scorer: "test-scorer",
      score: 0.75,
      rubric: { dimensions: { verification: 1 } }
    });
    ledger.db.query("UPDATE scores SET score = ? WHERE id = ?").run(0.1, stored.id);

    const result = auditRun(run.id, ledger);
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) =>
      issue.code === "side_table_event_mismatch" &&
      issue.message.includes(stored.id)
    )).toBe(true);
  } finally {
    ledger.close();
  }
});

test("auditRun accepts state transitions with linked artifacts or explicit no-artifact justifications", async () => {
  const { ledger, artifacts, run } = setup();
  try {
    await runGoal(run.id, ledger, artifacts, {
      arxivSearch: async () => []
    });

    const result = auditRun(run.id, ledger);
    expect(result.ok).toBe(true);
    const events = ledger.listEvents(run.id);
    const budgetCheck = events.find((event) => event.type === "budget.checked");
    const phaseCompleted = events.find((event) => event.type === "phase.completed");
    const workerCommit = events.find((event) => event.type === "worker.committed");
    const terminal = events.findLast((event) => event.type === "goal.completed");

    expect(budgetCheck?.payload.noArtifactJustification).toBeString();
    expect(phaseCompleted?.artifactIds.length).toBeGreaterThan(0);
    expect(
      (workerCommit?.artifactIds.length ?? 0) > 0 ||
      typeof workerCommit?.payload.noArtifactJustification === "string"
    ).toBe(true);
    expect(
      (terminal?.artifactIds.length ?? 0) > 0 ||
      typeof terminal?.payload.noArtifactJustification === "string"
    ).toBe(true);
  } finally {
    ledger.close();
  }
});

test("auditRun fails malformed typed workflow phase completions", () => {
  const { ledger, artifacts, run } = setup();
  try {
    const summary = artifacts.create(run.id, "phase.feedback.summary", JSON.stringify({
      phase: "feedback",
      outputManifest: {
        schemaVersion: "workflow-phase-output-v1",
        workflow: "pflk",
        phase: "loophole",
        cycle: 1,
        phaseJobId: "job-feedback",
        workerRole: "phase-feedback",
        promptLineage: { source: "test", problemHash: "problem", goalHash: "goal" },
        providerRoute: { provider: "local" },
        artifactIds: [],
        nextCycleDecision: { action: "next_phase", nextPhase: "knowledge" }
      }
    }));
    ledger.appendEvent(run.id, "phase.completed", {
      workflow: "pflk",
      phase: "feedback",
      cycle: 1,
      jobId: "job-feedback",
      summaryArtifactId: summary.id,
      outputManifest: {
        schemaVersion: "workflow-phase-output-v1",
        workflow: "pflk",
        phase: "feedback",
        cycle: 1,
        phaseJobId: "job-feedback",
        workerRole: "phase-feedback",
        promptLineage: { source: "test", problemHash: "problem", goalHash: "goal" },
        providerRoute: { provider: "local" },
        artifactIds: [summary.id],
        nextCycleDecision: { action: "next_phase", nextPhase: "loophole" }
      }
    }, [summary.id]);

    const result = auditRun(run.id, ledger);
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) =>
      issue.code === "workflow_phase_release_audit_failed" &&
      issue.message.includes("artifact outputManifest drift")
    )).toBe(true);
  } finally {
    ledger.close();
  }
});

test("auditRun detects completeness-critical events without artifacts or justification", () => {
  const { ledger, run } = setup();
  try {
    const events = [
      ledger.appendEvent(run.id, "phase.completed", { phase: "feedback", status: "done" }),
      ledger.appendEvent(run.id, "budget.checked", { ok: true, reserve: {}, budget: {}, usage: {} }),
      ledger.appendEvent(run.id, "worker.committed", { jobId: "job-test", result: {}, attempts: 1 }),
      ledger.appendEvent(run.id, "worker.ranked", { kind: "experiment", rankedJobs: [] }),
      ledger.appendEvent(run.id, "goal.completed", {
        status: "budget_exhausted",
        evidenceGrade: "budget_exhausted",
        finalState: "budget_exhausted",
        canClaimSolved: false
      }),
      ledger.appendEvent(run.id, "report.generated", { reportId: "report-test" })
    ];
    for (const event of events) {
      stripNoArtifactJustification(ledger, run.id, event.id);
    }

    const result = auditRun(run.id, ledger);
    expect(result.ok).toBe(false);
    const completenessIssues = result.issues.filter((issue) => issue.code === "event_artifact_completeness_missing");
    expect(completenessIssues.length).toBeGreaterThanOrEqual(events.length);
    for (const type of ["phase.completed", "budget.checked", "worker.committed", "worker.ranked", "goal.completed", "report.generated"]) {
      expect(completenessIssues.some((issue) => issue.message.includes(type))).toBe(true);
    }
  } finally {
    ledger.close();
  }
});

test("saved-everything release coverage matrix covers every required operation surface", () => {
  const report = buildSavedEverythingReleaseCoverageReport();

  expect(report.ok).toBe(true);
  expect(report.strictNotObservedFails).toBe(true);
  expect(report.requiredOperations).toBe(SAVED_EVERYTHING_RELEASE_REQUIREMENTS.length);
  expect(report.requirements.map((requirement) => requirement.id)).toEqual([
    "ai_call",
    "tool_call",
    "source_retrieval",
    "verifier_attempt",
    "workflow_transition",
    "budget_accounting",
    "provider_operation",
    "retry_or_error",
    "experiment_execution",
    "final_claim",
    "plan_mutation"
  ]);
  expect(report.requirements.every((requirement) =>
    requirement.categoryPresent &&
    requirement.eventTypesCovered.length === requirement.eventTypes.length &&
    requirement.issuePrefixesCovered.length === requirement.requiredIssueCodePrefixes.length
  )).toBe(true);
});

test("saved-everything release coverage matrix fails missing event coverage", () => {
  const report = buildSavedEverythingReleaseCoverageReport({
    requirements: [{
      id: "ai_call",
      categoryId: "ai_actions",
      label: "unsupported direct call",
      eventTypes: ["unpersisted.ai.provider.call"],
      requiredIssueCodePrefixes: ["ai_call_"],
      replayEvidence: "must be covered"
    }]
  });

  expect(report.ok).toBe(false);
  expect(report.issues.join("\n")).toContain("unpersisted.ai.provider.call");
});

test("saved-everything strict fixture mode fails required categories that are not observed", () => {
  const { ledger, run } = setup();
  try {
    const audit = auditSavedEverything(run.id, ledger, {
      failOnNotObserved: true,
      requireObservedCategoryIds: ["ai_actions", "budgets"]
    });

    expect(audit.ok).toBe(false);
    const aiCategory = audit.categories.find((category) => category.id === "ai_actions");
    const budgetCategory = audit.categories.find((category) => category.id === "budgets");
    expect(aiCategory?.status).toBe("failed");
    expect(budgetCategory?.status).toBe("failed");
    expect(audit.issues.map((issue) => issue.code)).toContain("saved_everything_required_category_not_observed");
  } finally {
    ledger.close();
  }
});
