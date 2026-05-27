import { afterEach, expect, test } from "bun:test";
import * as dns from "node:dns";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tls from "node:tls";
import { ArtifactStore } from "../src/artifacts";
import { auditRun, auditSavedEverything, type SavedEverythingCategory } from "../src/audit";
import { generateInstrumentedText } from "../src/ai/instrumented";
import { loadConfig } from "../src/config";
import { defaultTrustedVerifiers } from "../src/evidence";
import { stableHash } from "../src/idempotency";
import { computeLedgerEventHash, Ledger } from "../src/ledger";
import { getAppPaths } from "../src/paths";
import { admitRemoteCompute } from "../src/remote-admission";
import { reconcileGoalRunForResume } from "../src/resume";
import { buildFinalAnswerProvenance, persistRunReport, renderReport } from "../src/report";
import { buildReplayManifest, exportReproducibilityBundle, importReproducibilityBundle, replayOffline } from "../src/replay";
import { runGoal } from "../src/runner";
import { buildVerifierPolicyManifest } from "../src/verifier-policy";

const homes: string[] = [];

function setup() {
  const home = mkdtempSync(join(tmpdir(), "matematica-replay-persistence-test-"));
  homes.push(home);
  process.env.MATEMATICA_HOME = home;
  process.env.OPENAI_API_KEY = "sk-test-replay-persistence-secret";
  const paths = getAppPaths();
  const ledger = new Ledger(paths.dbPath);
  const artifacts = new ArtifactStore(paths.artifactsDir, ledger);
  const run = ledger.createRun({
    problem: "Prove 1 + 1 = 2",
    goal: "Find verified computation",
    successCriteria: ["Produce verifier-backed evidence"],
    workflow: "pflk",
    budget: { maxAttempts: 8, maxTokens: 3_000, maxWorkers: 4 }
  });
  return { home, ledger, artifacts, run };
}

async function runProviderBackedFixture(ledger: Ledger, artifacts: ArtifactStore, runId: string): Promise<void> {
  await runGoal(runId, ledger, artifacts, {
    arxivSearch: async () => [{
      id: "http://arxiv.org/abs/2401.00001v1",
      title: "Replay No Network Source",
      summary: "A source persisted so offline replay never needs retrieval.",
      authors: ["Ada"],
      published: "2024-01-01T00:00:00Z",
      updated: "2024-01-02T00:00:00Z",
      absUrl: "http://arxiv.org/abs/2401.00001v1",
      categories: ["math.NT"]
    }],
    branchModel: {
      provider: "openai",
      modelId: "fake-hostile-replay-model",
      model: {} as never,
      settings: { maxOutputTokens: 64, maxUsd: 0.02 },
      remoteAdmission: { explicitRemoteConsent: true, providerAllowlist: ["openai"] },
      generate: async () => ({
        text: "provider response persisted for offline replay",
        usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 },
        finishReason: "stop",
        providerMetadata: {}
      })
    }
  });
}

function withHostileNetworkHarness<T>(fn: () => T): T {
  const harness = installHostileNetworkHarness();
  try {
    const result = fn();
    expect(harness.calls).toEqual([]);
    return result;
  } finally {
    harness.restore();
  }
}

function installHostileNetworkHarness(): { calls: string[]; restore: () => void } {
  const calls: string[] = [];
  const originals: Array<{ target: Record<string, unknown>; key: string; value: unknown }> = [];
  const fail = (surface: string) => {
    return (..._args: unknown[]) => {
      calls.push(surface);
      throw new Error(`offline replay attempted network/provider access through ${surface}`);
    };
  };
  const patch = (target: unknown, key: string, surface: string): void => {
    if (!target || typeof target !== "object") return;
    const record = target as Record<string, unknown>;
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor?.writable || typeof record[key] !== "function") return;
    const original = record[key];
    try {
      record[key] = fail(surface);
      originals.push({ target: record, key, value: original });
    } catch {
      // Bun exposes some Node namespace bindings as writable descriptors while
      // still rejecting assignment. Keep the harness active for patchable
      // network surfaces instead of making the test depend on that quirk.
    }
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = fail("global.fetch") as unknown as typeof fetch;

  patch(http, "request", "node:http.request");
  patch(http, "get", "node:http.get");
  patch(https, "request", "node:https.request");
  patch(https, "get", "node:https.get");
  patch(dns, "lookup", "node:dns.lookup");
  patch(dns, "resolve", "node:dns.resolve");
  patch(dns, "resolve4", "node:dns.resolve4");
  patch((dns as unknown as { promises?: unknown }).promises, "lookup", "node:dns.promises.lookup");
  patch((dns as unknown as { promises?: unknown }).promises, "resolve", "node:dns.promises.resolve");
  patch(net, "connect", "node:net.connect");
  patch(net, "createConnection", "node:net.createConnection");
  patch(tls, "connect", "node:tls.connect");
  patch(Bun, "connect", "Bun.connect");

  return {
    calls,
    restore: () => {
      globalThis.fetch = originalFetch;
      for (const original of originals.reverse()) {
        original.target[original.key] = original.value;
      }
    }
  };
}

function updateEventPayload(ledger: Ledger, eventId: string, payload: Record<string, unknown>): void {
  ledger.db.query("UPDATE ledger_events SET payload_json = ? WHERE id = ?").run(JSON.stringify(payload), eventId);
}

function updateEventPayloadAndRehash(ledger: Ledger, runId: string, eventId: string, payload: Record<string, unknown>): void {
  updateEventPayload(ledger, eventId, payload);
  rehashEventChain(ledger, runId);
  ledger.refreshLedgerWitness(runId);
}

function rehashEventChain(ledger: Ledger, runId: string): void {
  let previousEventHash: string | undefined;
  const artifactHashesById = new Map(ledger.listArtifacts(runId).map((artifact) => [artifact.id, artifact.sha256]));
  for (const [sequence, event] of ledger.listEvents(runId).entries()) {
    const linkedArtifactHashes = event.artifactIds.map((artifactId) => ({
      artifactId,
      sha256: artifactHashesById.get(artifactId)
    }));
    const schemaVersion = ledger.schemaVersion();
    const payload = event.type === "goal.completed" || event.type === "goal.failed"
      ? {
          ...event.payload,
          terminalIntegrity: {
            chainVersion: 1,
            previousEventHash: previousEventHash ?? null,
            artifactRoot: stableHash(linkedArtifactHashes),
            schemaVersion
          }
        }
      : event.payload;
    const payloadHash = stableHash(payload);
    const eventHash = computeLedgerEventHash({
      runId,
      type: event.type,
      payload,
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
          payload_json = ?,
          payload_hash = ?,
          linked_artifact_hashes_json = ?,
          schema_version = ?,
          previous_event_hash = ?,
          event_hash = ?
      WHERE id = ?
    `).run(
      sequence,
      JSON.stringify(payload),
      payloadHash,
      JSON.stringify(linkedArtifactHashes),
      schemaVersion,
      previousEventHash ?? null,
      eventHash,
      event.id
    );
    previousEventHash = eventHash;
  }
  ledger.db.query(`
    INSERT INTO run_event_counters (run_id, next_sequence)
    VALUES (?, ?)
    ON CONFLICT(run_id) DO UPDATE SET next_sequence = excluded.next_sequence
  `).run(runId, ledger.listEvents(runId).length);
}

afterEach(() => {
  delete process.env.MATEMATICA_HOME;
  delete process.env.OPENAI_API_KEY;
  while (homes.length > 0) {
    rmSync(homes.pop()!, { recursive: true, force: true });
  }
});

test("offline replay manifest covers AI tool loop research worker budget and verifier actions", async () => {
  const { home, ledger, artifacts, run } = setup();
  try {
    const planReviewArtifact = artifacts.create(run.id, "adversarial.plan.review", JSON.stringify({
      scope: "plan_change",
      reviewers: ["saved-everything-fixture-critic"],
      findings: ["canonical fixture must observe every saved-everything category"],
      accepted: true
    }));
    ledger.appendEvent(run.id, "adversarial.quorum.reviewed", {
      scope: "plan_change",
      decision: "accepted",
      artifactId: planReviewArtifact.id,
      reviewers: ["saved-everything-fixture-critic"],
      acceptedFindings: ["canonical fixture must observe every saved-everything category"]
    }, [planReviewArtifact.id]);
    const experimentRankingArtifact = artifacts.create(run.id, "experiment.ranking", JSON.stringify({
      kind: "experiment",
      rankedJobs: [{
        id: "canonical-experiment-fixture",
        score: 1,
        rationale: "exercise saved-everything experiment persistence"
      }]
    }));
    ledger.appendEvent(run.id, "worker.ranked", {
      kind: "experiment",
      rankedJobs: [{
        id: "canonical-experiment-fixture",
        score: 1,
        rationale: "exercise saved-everything experiment persistence"
      }],
      artifactId: experimentRankingArtifact.id
    }, [experimentRankingArtifact.id]);

    await runGoal(run.id, ledger, artifacts, {
      arxivSearch: async () => [{
        id: "http://arxiv.org/abs/2401.00001v1",
        title: "Replay Persistence Source",
        summary: "We prove a replay persistence lemma with enough detail for deterministic citation support.",
        authors: ["Ada"],
        published: "2024-01-01T00:00:00Z",
        updated: "2024-01-02T00:00:00Z",
        absUrl: "http://arxiv.org/abs/2401.00001v1",
        categories: ["math.NT"]
      }],
      branchModel: {
        provider: "openai",
        modelId: "fake-replay-persistence-model",
        model: {} as never,
        settings: { maxOutputTokens: 64, maxUsd: 0.02 },
      remoteAdmission: { explicitRemoteConsent: true, providerAllowlist: ["openai"] },
        generate: async ({ onStepFinish }) => {
          await onStepFinish?.({
            finishReason: "tool-calls",
            usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
            toolCalls: [{ toolCallId: "tool-1", toolName: "artifact_write", args: { n: 2 } }],
            toolResults: []
          });
          return {
            text: "branch evidence persisted",
            usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 },
            finishReason: "stop",
            streamChunks: [
              { type: "text-delta", textDelta: "branch evidence " },
              { type: "finish", finishReason: "stop", usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 } }
            ],
            providerMetadata: {},
            steps: [{
              finishReason: "stop",
              usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
              toolResults: [{ toolCallId: "tool-1", result: { ok: true } }]
            }]
          };
        }
      }
    });

    const failureAdmission = admitRemoteCompute({
      runId: run.id,
      ledger,
      artifacts,
      command: "ai.generateText",
      provider: "openai",
      modelId: "fake-replay-persistence-model",
      localOnly: false,
      maxWorkers: run.budget.maxWorkers,
      maxAttempts: run.budget.maxAttempts,
      runMaxUsd: run.budget.maxUsd,
      runMaxTokens: run.budget.maxTokens,
      maxCallUsd: 0.02,
      maxOutputTokens: 8,
      maxProviderRetriesPerCall: 0,
      explicitRemoteConsent: true
    });
    expect(failureAdmission.ok).toBe(true);
    await expect(generateInstrumentedText({
      runId: run.id,
      ledger,
      artifacts,
      provider: "openai",
      modelId: "fake-replay-persistence-model",
      model: {} as never,
      prompt: "Exercise canonical saved-everything provider failure path.",
      settings: {
        maxOutputTokens: 8,
        maxUsd: 0.02,
        resilience: { maxRetries: 0 }
      },
      generate: async () => {
        throw new Error("canonical saved-everything fixture provider failure");
      }
    })).rejects.toThrow("canonical saved-everything fixture provider failure");

    const sandboxRequestPayload = {
      format: "matematica.canonical-saved-everything.sandbox-request",
      command: "bounded generated experiment",
      sandboxMs: 10
    };
    const sandboxRequest = artifacts.create(run.id, "sandbox.experiment.request", JSON.stringify(sandboxRequestPayload, null, 2));
    const sandboxRequestHash = stableHash(sandboxRequestPayload);
    const sandboxPrepared = ledger.prepareExternalOperation({
      runId: run.id,
      operationType: "sandbox.experiment",
      provider: "local-sandbox",
      idempotencyKey: "canonical-saved-everything-sandbox-experiment",
      requestHash: sandboxRequestHash,
      reserve: { attempts: 1, sandboxMs: 10 },
      requestArtifactId: sandboxRequest.id
    });
    expect(sandboxPrepared.ok).toBe(true);
    if (!sandboxPrepared.ok) throw new Error(sandboxPrepared.reason);
    const sandboxOperation = ledger.startExternalOperation(sandboxPrepared.operation.id);
    const sandboxResult = artifacts.create(run.id, "sandbox.experiment.error", JSON.stringify({
      format: "matematica.canonical-saved-everything.sandbox-result",
      operationId: sandboxOperation.id,
      status: "failed",
      bounded: true
    }, null, 2));
    ledger.failExternalOperation({
      operationId: sandboxOperation.id,
      errorMessage: "canonical saved-everything sandbox failure fixture",
      errorArtifactId: sandboxResult.id,
      debit: { attempts: 1, sandboxMs: 7 },
      provider: "local-sandbox"
    });

    const cancellable = ledger.enqueueWorkerJob({
      runId: run.id,
      kind: "workflow.branch",
      payload: {
        phase: "experiment",
        kind: "experiment-cancellation-fixture"
      }
    });
    expect(cancellable.id).toStartWith("job_");
    expect(ledger.cancelPendingWorkerJobs(run.id, "canonical saved-everything cancellation fixture").map((job) => job.id))
      .toContain(cancellable.id);

    const config = loadConfig(home, { OPENAI_API_KEY: process.env.OPENAI_API_KEY });
    const resume = reconcileGoalRunForResume({
      runId: run.id,
      ledger,
      cwd: process.cwd(),
      config,
      reason: "canonical saved-everything resume fixture"
    });
    expect(resume.auditOk).toBe(true);
    expect(resume.terminalReopen.reopened).toBe(false);

    const persistedReport = persistRunReport(run.id, ledger, artifacts);
    expect(persistedReport.snapshot.regenerated).toBe(false);
    expect(persistedReport.snapshotArtifact.kind).toBe("report.run_snapshot");
    expect(persistedReport.event.artifactIds).toEqual([
      persistedReport.snapshotArtifact.id,
      persistedReport.reportArtifact.id
    ]);

    const audit = auditRun(run.id, ledger);
    expect(audit.ok).toBe(true);
    const requiredSavedEverythingCategories: SavedEverythingCategory["id"][] = [
      "ai_actions",
      "tool_calls",
      "search_research",
      "branch_decisions",
      "experiments",
      "verifiers",
      "budgets",
      "providers",
      "plan_mutations"
    ];
    const savedEverything = auditSavedEverything(run.id, ledger, {
      failOnNotObserved: true,
      requireObservedCategoryIds: requiredSavedEverythingCategories
    });
    expect(savedEverything.ok).toBe(true);
    expect(savedEverything.categories.filter((category) => requiredSavedEverythingCategories.includes(category.id)))
      .toEqual(expect.arrayContaining(requiredSavedEverythingCategories.map((id) =>
        expect.objectContaining({ id, status: "passed", observedEvents: expect.any(Number) })
      )));
    expect(savedEverything.categories.every((category) =>
      !requiredSavedEverythingCategories.includes(category.id) || category.observedEvents > 0
    )).toBe(true);

    const manifest = buildReplayManifest({ runId: run.id, ledger, cwd: process.cwd(), config });
    const offline = replayOffline({ runId: run.id, ledger, cwd: process.cwd(), config });
    const verifiedOffline = replayOffline({ runId: run.id, ledger, cwd: process.cwd(), config, verifyFinal: true });
    const events = ledger.listEvents(run.id);
    const eventTypes = events.map((event) => event.type);
    const artifactKinds = manifest.artifacts.map((artifact) => artifact.kind);

    for (const type of [
      "worker.enqueued",
      "worker.leased",
      "worker.started",
      "worker.heartbeat",
      "worker.committed",
      "worker.completed",
      "budget.reserved",
      "budget.debited",
      "source.query",
      "source.results",
      "ai.call.started",
      "ai.call.step",
      "ai.call.stream_chunk",
      "ai.call.transcript.persisted",
      "ai.call.completed",
      "ai.call.failed",
      "adversarial.quorum.reviewed",
      "worker.ranked",
      "worker.cancelled",
      "verifier.started",
      "verifier.completed",
      "external.operation.failed",
      "goal.resume.reconciled",
      "goal.success.evaluated",
      "goal.completed",
      "report.generated"
    ] as const) {
      expect(eventTypes).toContain(type);
    }

    for (const kind of [
      "source.arxiv.request",
      "source.arxiv.results",
      "source.mathlib.results",
      "ai.request",
      "ai.step",
      "ai.stream_chunk",
      "ai.transcript",
      "ai.response",
      "ai.error",
      "adversarial.plan.review",
      "experiment.ranking",
      "sandbox.experiment.request",
      "sandbox.experiment.error",
      "report.final",
      "verifier.local.result",
      "verifier.local.independent-checker.result",
      "policy.verifier.manifest",
      "proof.obligations"
    ]) {
      expect(artifactKinds).toContain(kind);
    }

    const completedProvider = manifest.providers.find((provider) =>
      provider.provider === "openai" &&
      provider.modelId === "fake-replay-persistence-model" &&
      Array.isArray(provider.stepArtifactIds) &&
      provider.stepArtifactIds.length > 0
    );
    expect(completedProvider?.requestArtifactId).toBeString();
    expect(completedProvider?.responseArtifactId).toBeString();
    expect(completedProvider?.transcriptArtifactId).toBeString();
    expect(completedProvider?.transcriptArtifactHash).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.externalOperations.some((operation) =>
      operation.operationType === "ai.generateText" &&
      operation.status === "succeeded" &&
      operation.requestArtifactId &&
      operation.responseArtifactId
    )).toBe(true);
    expect(manifest.externalOperations.some((operation) =>
      operation.operationType === "source.arxiv" &&
      operation.status === "succeeded" &&
      operation.requestArtifactId &&
      operation.responseArtifactId
    )).toBe(true);
    expect(manifest.externalOperations.some((operation) =>
      operation.operationType === "ai.generateText" &&
      operation.status === "failed" &&
      operation.requestArtifactId
    )).toBe(true);
    expect(manifest.externalOperations.some((operation) =>
      operation.operationType === "sandbox.experiment" &&
      operation.status === "failed" &&
      operation.requestArtifactId
    )).toBe(true);
    expect(manifest.arxiv[0].sourceHashes[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.mathlib).toHaveLength(1);
    expect(manifest.mathlib[0].indexVersion).toBeString();
    expect(manifest.mathlib[0].indexHash).toMatch(/^[a-f0-9]{64}$/);
    const mathlibIndexHash = manifest.mathlib[0].indexHash;
    if (!mathlibIndexHash) throw new Error("expected pinned mathlib index hash");
    expect(manifest.mathlib[0].currentIndexHash).toBe(mathlibIndexHash);
    expect(manifest.mathlib[0].drift).toBe(false);
    expect(manifest.mathlib[0].artifactHash).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.mathlib[0].theoremHandles.length).toBeGreaterThan(0);
    expect(manifest.mathlib[0].theoremHandles[0]).toMatchObject({
      name: "Nat.one_add_one_eq_two",
      proofSupport: false
    });
    const pinnedPolicyHash = manifest.verifierPolicy.policyHash;
    expect(pinnedPolicyHash).toMatch(/^[a-f0-9]{64}$/);
    if (!pinnedPolicyHash) throw new Error("expected pinned verifier policy hash");
    expect(manifest.verifierPolicy.currentPolicyHash).toBe(pinnedPolicyHash);
    expect(manifest.verifierPolicy.drift).toBe(false);
    expect(manifest.verifierPolicy.trustedVerifierIds).toContain("local-deterministic-v0");
    expect(manifest.eventCount).toBe(events.length);
    expect(manifest.actionPersistence.some((entry) => entry.type === "ai.call.started")).toBe(true);
    expect(manifest.actionPersistence.some((entry) => entry.type === "ai.call.step")).toBe(true);
    expect(manifest.actionPersistence.some((entry) => entry.type === "ai.call.stream_chunk")).toBe(true);
    expect(manifest.actionPersistence.some((entry) => entry.type === "ai.call.transcript.persisted")).toBe(true);
    expect(manifest.actionPersistence.some((entry) => entry.type === "source.query")).toBe(true);
    expect(manifest.actionPersistence.some((entry) => entry.type === "verifier.completed")).toBe(true);
    expect(manifest.actionPersistence.some((entry) => entry.type === "worker.committed")).toBe(true);
    expect(manifest.actionPersistence.every((entry) => entry.replayable)).toBe(true);

    expect(offline.ok).toBe(true);
    expect(offline.selfContained.ok).toBe(true);
    expect(offline.selfContained.networkPolicy).toBe("no_new_network_or_provider_calls");
    expect(offline.selfContained.issues).toEqual([]);
    expect(offline.manifest.providerMatrix?.matrixHash).toBeString();
    expect(offline.replayedEvents).toBe(events.length);
    expect(verifiedOffline.ok).toBe(true);
    expect(verifiedOffline.finalVerification?.ok).toBe(true);
    expect(verifiedOffline.finalVerification?.recomputed.finalOutcome.state).toBe("computational_evidence");
    expect(verifiedOffline.finalVerification?.recomputed.evidenceGateHash).toBeString();
    expect(verifiedOffline.finalVerification?.recomputed.goalSuccessHash).toBeString();
    expect(verifiedOffline.finalVerification?.recomputed.proofObligationDecisionHash).toBeString();
    expect(verifiedOffline.finalVerification?.recomputed.reportIdempotencyKey).toMatch(/^report_[a-f0-9]{32}$/);
    expect(verifiedOffline.finalVerification?.recomputed.budgetUsage).toEqual(verifiedOffline.finalVerification?.persisted.budgetUsage);
    expect(verifiedOffline.finalVerification?.recomputed.oracle).toMatchObject({
      eventCount: events.length,
      terminalEventCount: 1,
      proofCertificateCount: 1
    });
    expect(verifiedOffline.finalVerification?.recomputed.oracle.ledgerHeadHash).toMatch(/^[a-f0-9]{64}$/);
    expect(verifiedOffline.finalVerification?.recomputed.oracle.artifactRootHash).toMatch(/^[a-f0-9]{64}$/);
    expect(verifiedOffline.finalVerification?.recomputed.policy.pinnedPolicyHash).toBe(pinnedPolicyHash);
    expect(verifiedOffline.finalVerification?.recomputed.policy.drift).toBe(false);
    const nonReplayableTypes = offline.nonReplayableSteps.map((step) => step.type);
    for (const type of [
      "ai.call.started",
      "ai.call.step",
      "source.query",
      "external.operation.started",
      "verifier.started"
    ]) {
      expect(nonReplayableTypes).toContain(type);
    }
    expect(JSON.stringify(offline)).not.toContain("sk-test-replay-persistence-secret");

    for (const artifact of ledger.listArtifacts(run.id)) {
      expect(readFileSync(artifact.path, "utf8")).not.toContain("sk-test-replay-persistence-secret");
    }
  } finally {
    ledger.close();
  }
});

test("offline replay self-contained gate fails when provider matrix is missing", async () => {
  const { home, ledger, artifacts, run } = setup();
  try {
    await runGoal(run.id, ledger, artifacts, {
      arxivSearch: async () => [],
      branchModel: {
        provider: "openai",
        modelId: "fake-replay-provider-matrix-model",
        model: {} as never,
        settings: { maxOutputTokens: 32, maxUsd: 0.01 },
      remoteAdmission: { explicitRemoteConsent: true, providerAllowlist: ["openai"] },
        generate: async () => ({
          text: "provider matrix should be pinned",
          usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
          finishReason: "stop",
          providerMetadata: {}
        })
      }
    });
    expect(auditRun(run.id, ledger).ok).toBe(true);
    ledger.db.query("DELETE FROM ledger_events WHERE run_id = ? AND type = ?").run(run.id, "provider.matrix.pinned");
    rehashEventChain(ledger, run.id);
    ledger.refreshLedgerWitness(run.id);

    const config = loadConfig(home, { OPENAI_API_KEY: process.env.OPENAI_API_KEY });
    const offline = replayOffline({ runId: run.id, ledger, cwd: process.cwd(), config, verifyFinal: true });
    const issueCodes = offline.selfContained.issues.map((issue) => issue.code);
    expect(offline.ok).toBe(false);
    expect(offline.selfContained.ok).toBe(false);
    expect(issueCodes).toContain("provider_matrix_missing");
    const report = renderReport(run.id, ledger);
    expect(report).toContain("Offline replay self-contained: fail");
    expect(report).toContain("Can claim solved: no");
    expect(report).toContain("provider_matrix_missing");
    const provenance = buildFinalAnswerProvenance(run.id, ledger);
    expect(provenance.outcome.canClaimSolved).toBe(false);
    expect(provenance.outcome.failClosedReasons).toContain("offline_replay_self_contained_failed");
    expect(provenance.replay.selfContainedOk).toBe(false);
    expect(provenance.replay.issueCodes).toContain("provider_matrix_missing");
  } finally {
    ledger.close();
  }
});

test("offline replay self-contained gate fails when external operation budget reservation is missing", async () => {
  const { home, ledger, artifacts, run } = setup();
  try {
    await runGoal(run.id, ledger, artifacts, {
      arxivSearch: async () => [],
      branchModel: {
        provider: "openai",
        modelId: "fake-replay-budget-model",
        model: {} as never,
        settings: { maxOutputTokens: 32, maxUsd: 0.01 },
      remoteAdmission: { explicitRemoteConsent: true, providerAllowlist: ["openai"] },
        generate: async () => ({
          text: "budget reservation should be replayable",
          usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
          finishReason: "stop",
          providerMetadata: {}
        })
      }
    });
    expect(auditRun(run.id, ledger).ok).toBe(true);
    const operation = ledger.listExternalOperations(run.id).find((item) => item.operationType === "ai.generateText");
    expect(operation).toBeTruthy();
    ledger.db.query("DELETE FROM ledger_events WHERE run_id = ? AND type = ? AND json_extract(payload_json, '$.reservationId') = ?")
      .run(run.id, "budget.reserved", operation!.reservationId);
    rehashEventChain(ledger, run.id);
    ledger.refreshLedgerWitness(run.id);

    const config = loadConfig(home, { OPENAI_API_KEY: process.env.OPENAI_API_KEY });
    const offline = replayOffline({ runId: run.id, ledger, cwd: process.cwd(), config });
    const issueCodes = offline.selfContained.issues.map((issue) => issue.code);
    expect(offline.ok).toBe(false);
    expect(offline.selfContained.ok).toBe(false);
    expect(issueCodes).toContain("external_operation_budget_reservation_missing");
  } finally {
    ledger.close();
  }
});

test("offline replay self-contained gate fails when ledger witness is missing", async () => {
  const { home, ledger, artifacts, run } = setup();
  try {
    await runGoal(run.id, ledger, artifacts, {
      arxivSearch: async () => []
    });
    const witness = ledger.verifyLedgerWitness(run.id);
    expect(witness.ok).toBe(true);
    rmSync(witness.path, { force: true });

    const config = loadConfig(home, { OPENAI_API_KEY: process.env.OPENAI_API_KEY });
    const offline = replayOffline({ runId: run.id, ledger, cwd: process.cwd(), config });
    const issueCodes = offline.selfContained.issues.map((issue) => issue.code);
    expect(offline.ok).toBe(false);
    expect(offline.selfContained.ok).toBe(false);
    expect(issueCodes).toContain("ledger_witness_missing");
  } finally {
    ledger.close();
  }
});

test("offline replay succeeds under hostile network harness from clean bundle without provider keys", async () => {
  const { home, ledger, artifacts, run } = setup();
  try {
    await runProviderBackedFixture(ledger, artifacts, run.id);
    expect(auditRun(run.id, ledger).ok).toBe(true);

    const sourceConfig = loadConfig(home, { OPENAI_API_KEY: process.env.OPENAI_API_KEY });
    const bundle = exportReproducibilityBundle({
      runId: run.id,
      ledger,
      cwd: process.cwd(),
      config: sourceConfig
    });
    expect(bundle.manifest.arxiv[0]).toMatchObject({
      redistribution: "not_exported_without_license",
      pdfOrSourceContentExported: false
    });
    expect(bundle.manifest.arxiv[0].licenseManifestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(bundle.artifacts.map((artifact) => artifact.kind)).not.toContain("source.arxiv.pdf");
    expect(bundle.artifacts.map((artifact) => artifact.kind)).not.toContain("source.arxiv.source");

    delete process.env.OPENAI_API_KEY;
    const cleanHome = mkdtempSync(join(tmpdir(), "matematica-replay-clean-home-"));
    homes.push(cleanHome);
    process.env.MATEMATICA_HOME = cleanHome;
    const cleanPaths = getAppPaths();
    const cleanLedger = new Ledger(cleanPaths.dbPath);
    try {
      const cleanConfig = loadConfig(cleanHome, {});
      const imported = withHostileNetworkHarness(() => importReproducibilityBundle({
        bundle,
        ledger: cleanLedger,
        artifactsDir: cleanPaths.artifactsDir,
        cwd: process.cwd(),
        config: cleanConfig
      }));
      expect(imported.verification.replayOk).toBe(true);
      expect(imported.verification.divergences).toEqual([]);

      const offline = withHostileNetworkHarness(() => replayOffline({
        runId: run.id,
        ledger: cleanLedger,
        cwd: process.cwd(),
        config: cleanConfig,
        verifyFinal: true,
        deterministic: true
      }));
      expect(offline.ok).toBe(true);
      expect(offline.selfContained.ok).toBe(true);
      expect(offline.finalVerification?.ok).toBe(true);
      expect(offline.deterministic?.networkPolicy).toBe("no_new_network_or_provider_calls");
      expect(JSON.stringify(offline)).not.toContain("sk-test-replay-persistence-secret");
      expect(JSON.stringify(offline)).not.toContain(cleanHome);
    } finally {
      cleanLedger.close();
      process.env.MATEMATICA_HOME = home;
      process.env.OPENAI_API_KEY = "sk-test-replay-persistence-secret";
    }
  } finally {
    ledger.close();
  }
});

test("offline replay missing source artifact fails under hostile network harness without arXiv fallback", async () => {
  const { home, ledger, artifacts, run } = setup();
  try {
    await runProviderBackedFixture(ledger, artifacts, run.id);
    const sourceEvent = ledger.listEvents(run.id)
      .find((event) => event.type === "source.results" && event.payload.provider === "arxiv");
    expect(sourceEvent).toBeTruthy();
    const sourceArtifactId = String(sourceEvent!.payload.artifactId);
    ledger.db.query("DELETE FROM artifacts WHERE id = ?").run(sourceArtifactId);
    rehashEventChain(ledger, run.id);
    ledger.refreshLedgerWitness(run.id);

    const config = loadConfig(home, { OPENAI_API_KEY: process.env.OPENAI_API_KEY });
    const offline = withHostileNetworkHarness(() => replayOffline({
      runId: run.id,
      ledger,
      cwd: process.cwd(),
      config,
      verifyFinal: true
    }));
    const issueCodes = offline.selfContained.issues.map((issue) => issue.code);
    expect(offline.ok).toBe(false);
    expect(offline.selfContained.ok).toBe(false);
    expect(issueCodes).toContain("source_result_artifact_missing");
    expect(issueCodes).toContain("audit_failed");
  } finally {
    ledger.close();
  }
});

test("offline replay fails when pinned mathlib theorem index drifts", async () => {
  const { home, ledger, artifacts, run } = setup();
  try {
    await runProviderBackedFixture(ledger, artifacts, run.id);
    const mathlibEvent = ledger.listEvents(run.id)
      .find((event) => event.type === "source.results" && event.payload.provider === "mathlib");
    expect(mathlibEvent).toBeTruthy();
    updateEventPayloadAndRehash(ledger, run.id, mathlibEvent!.id, {
      ...mathlibEvent!.payload,
      indexHash: "0".repeat(64)
    });

    const config = loadConfig(home, { OPENAI_API_KEY: process.env.OPENAI_API_KEY });
    const offline = replayOffline({ runId: run.id, ledger, cwd: process.cwd(), config });
    expect(offline.ok).toBe(false);
    expect(offline.selfContained.ok).toBe(false);
    expect(offline.selfContained.issues.map((issue) => issue.code)).toContain("mathlib_theorem_index_drift");
    expect(offline.manifest.mathlib[0].drift).toBe(true);
  } finally {
    ledger.close();
  }
});

test("offline replay mutated provider response fails under hostile network harness without provider retry", async () => {
  const { home, ledger, artifacts, run } = setup();
  try {
    await runProviderBackedFixture(ledger, artifacts, run.id);
    const responseArtifactId = ledger.listEvents(run.id)
      .findLast((event) => event.type === "ai.call.completed")
      ?.payload.responseArtifactId;
    expect(responseArtifactId).toBeString();
    const responseArtifact = ledger.listArtifacts(run.id)
      .find((artifact) => artifact.id === responseArtifactId);
    expect(responseArtifact).toBeTruthy();
    const parsed = JSON.parse(readFileSync(responseArtifact!.path, "utf8"));
    parsed.text = "forged provider response after the run";
    writeFileSync(responseArtifact!.path, JSON.stringify(parsed, null, 2));

    const config = loadConfig(home, { OPENAI_API_KEY: process.env.OPENAI_API_KEY });
    const offline = withHostileNetworkHarness(() => replayOffline({
      runId: run.id,
      ledger,
      cwd: process.cwd(),
      config,
      verifyFinal: true
    }));
    expect(offline.ok).toBe(false);
    expect(offline.audit.ok).toBe(false);
    expect(offline.selfContained.ok).toBe(false);
    expect(offline.selfContained.issues.map((issue) => issue.code)).toContain("audit_failed");
  } finally {
    ledger.close();
  }
});

test("offline replay fails on upstream provider drift without explicit routing event", async () => {
  const { home, ledger, artifacts, run } = setup();
  try {
    await runProviderBackedFixture(ledger, artifacts, run.id);
    const completed = ledger.listEvents(run.id).findLast((event) => event.type === "ai.call.completed");
    expect(completed).toBeTruthy();
    updateEventPayloadAndRehash(ledger, run.id, completed!.id, {
      ...completed!.payload,
      provider: "openrouter",
      modelId: "openai/gpt-5.5",
      providerMetadataHash: "0".repeat(64),
      providerProvenance: {
        requestedProvider: "openrouter",
        requestedModel: "openai/gpt-5.5",
        actualUpstreamProvider: "anthropic",
        actualUpstreamModel: "anthropic/claude-opus-4.5",
        providerMetadataHash: "0".repeat(64),
        pricingSource: "openrouter_generation_metadata",
        silentFallbackAllowed: false
      }
    });

    const config = loadConfig(home, { OPENAI_API_KEY: process.env.OPENAI_API_KEY });
    const offline = replayOffline({
      runId: run.id,
      ledger,
      cwd: process.cwd(),
      config,
      verifyFinal: true
    });
    expect(offline.ok).toBe(false);
    expect(offline.selfContained.ok).toBe(false);
    expect(offline.selfContained.issues.map((issue) => issue.code)).toContain("openrouter_upstream_drift_without_routing_event");
  } finally {
    ledger.close();
  }
});

test("offline replay final verification fails on altered proof-obligation artifact", async () => {
  const { home, ledger, artifacts, run } = setup();
  try {
    await runGoal(run.id, ledger, artifacts, {
      arxivSearch: async () => []
    });
    const config = loadConfig(home, { OPENAI_API_KEY: process.env.OPENAI_API_KEY });
    const proofEvent = ledger.listEvents(run.id).find((event) => event.type === "proof.obligations.reviewed");
    const proofArtifact = ledger.listArtifacts(run.id).find((artifact) => artifact.id === proofEvent?.payload.artifactId);
    expect(proofArtifact).toBeTruthy();
    const parsed = JSON.parse(readFileSync(proofArtifact!.path, "utf8"));
    parsed.decision.ok = false;
    writeFileSync(proofArtifact!.path, JSON.stringify(parsed, null, 2));

    const offline = replayOffline({ runId: run.id, ledger, cwd: process.cwd(), config, verifyFinal: true });
    expect(offline.ok).toBe(false);
    expect(offline.audit.ok).toBe(false);
    expect(offline.finalVerification?.ok).toBe(false);
    expect(offline.finalVerification?.divergences.map((item) => item.kind)).toContain("audit");
    expect(offline.finalVerification?.divergences.map((item) => item.kind)).toContain("proof_obligations");
  } finally {
    ledger.close();
  }
});

test("offline replay final verification derives outcome without trusting terminal event payload", async () => {
  const { home, ledger, artifacts, run } = setup();
  try {
    await runGoal(run.id, ledger, artifacts, {
      arxivSearch: async () => []
    });
    const completed = ledger.listEvents(run.id).findLast((event) => event.type === "goal.completed");
    expect(completed).toBeTruthy();
    updateEventPayload(ledger, completed!.id, {
      ...completed!.payload,
      finalState: "conjecture",
      canClaimSolved: false
    });

    const config = loadConfig(home, { OPENAI_API_KEY: process.env.OPENAI_API_KEY });
    const offline = replayOffline({ runId: run.id, ledger, cwd: process.cwd(), config, verifyFinal: true });
    expect(offline.ok).toBe(false);
    expect(offline.audit.ok).toBe(false);
    expect(offline.finalVerification?.ok).toBe(false);
    expect(offline.finalVerification?.divergences.map((item) => item.kind)).toContain("audit");
    expect(offline.finalVerification?.recomputed.finalOutcome.state).toBe("computational_evidence");
    expect(offline.finalVerification?.divergences.map((item) => item.kind)).toContain("final_outcome");
  } finally {
    ledger.close();
  }
});

test("offline replay oracle rejects injected duplicate terminal outcome events", async () => {
  const { home, ledger, artifacts, run } = setup();
  try {
    await runGoal(run.id, ledger, artifacts, {
      arxivSearch: async () => []
    });
    const completed = ledger.listEvents(run.id).findLast((event) => event.type === "goal.completed");
    expect(completed).toBeTruthy();
    ledger.appendEvent(run.id, "goal.completed", {
      ...completed!.payload,
      reason: "counterfeit duplicate terminal event"
    }, completed!.artifactIds);

    const config = loadConfig(home, { OPENAI_API_KEY: process.env.OPENAI_API_KEY });
    const offline = replayOffline({ runId: run.id, ledger, cwd: process.cwd(), config, verifyFinal: true });
    expect(offline.ok).toBe(false);
    expect(offline.audit.ok).toBe(true);
    expect(offline.finalVerification?.ok).toBe(false);
    expect(offline.finalVerification?.divergences.map((item) => item.kind)).toContain("terminal_order");
    expect(offline.finalVerification?.recomputed.finalOutcome.state).toBe("computational_evidence");
  } finally {
    ledger.close();
  }
});

test("offline replay oracle rejects worker mutations that are not backed by replayed leases", async () => {
  const { home, ledger, artifacts, run } = setup();
  try {
    await runGoal(run.id, ledger, artifacts, {
      arxivSearch: async () => []
    });
    const started = ledger.listEvents(run.id).find((event) => event.type === "worker.started");
    expect(started).toBeTruthy();
    updateEventPayloadAndRehash(ledger, run.id, started!.id, {
      ...started!.payload,
      owner: "forged-worker-owner"
    });

    const config = loadConfig(home, { OPENAI_API_KEY: process.env.OPENAI_API_KEY });
    const offline = replayOffline({ runId: run.id, ledger, cwd: process.cwd(), config, verifyFinal: true });
    expect(offline.ok).toBe(false);
    expect(offline.audit.ok).toBe(true);
    expect(offline.finalVerification?.ok).toBe(false);
    expect(offline.finalVerification?.divergences.map((item) => item.kind)).toContain("worker_lease");
  } finally {
    ledger.close();
  }
});

test("offline replay rejects external-effect events without a persisted outbox operation", () => {
  const { home, ledger, artifacts, run } = setup();
  try {
    const request = artifacts.create(run.id, "source.arxiv.request", JSON.stringify({ query: "all:forged" }));
    ledger.appendEvent(run.id, "source.query", {
      provider: "arxiv",
      query: "all:forged",
      externalOperationId: "extop_missing_for_replay",
      reservationId: "budgetres_missing_for_replay",
      requestArtifactId: request.id
    }, [request.id]);

    const offline = replayOffline({
      runId: run.id,
      ledger,
      cwd: process.cwd(),
      config: loadConfig(home, { OPENAI_API_KEY: process.env.OPENAI_API_KEY })
    });

    expect(offline.ok).toBe(false);
    expect(offline.audit.issues.map((issue) => issue.code)).toContain("external_effect_missing_operation_row");
    expect(offline.selfContained.issues.map((issue) => issue.code)).toContain("external_effect_operation_missing");
  } finally {
    ledger.close();
  }
});

test("offline replay final verification recomputes open-problem success policy", async () => {
  const { home, ledger, artifacts, run } = setup();
  try {
    await runGoal(run.id, ledger, artifacts, {
      arxivSearch: async () => []
    });
    ledger.db.query("UPDATE goal_runs SET goal = ? WHERE id = ?")
      .run("Find verified computation for this open problem.", run.id);

    const config = loadConfig(home, { OPENAI_API_KEY: process.env.OPENAI_API_KEY });
    const offline = replayOffline({ runId: run.id, ledger, cwd: process.cwd(), config, verifyFinal: true });
    expect(offline.ok).toBe(false);
    expect(offline.audit.ok).toBe(true);
    expect(offline.finalVerification?.ok).toBe(false);
    expect(offline.finalVerification?.recomputed.finalOutcome.state).toBe("partial");
    expect(offline.finalVerification?.recomputed.finalOutcome.canClaimSolved).toBe(false);
    expect(offline.finalVerification?.divergences.map((item) => item.kind)).toContain("goal_success");
    expect(offline.finalVerification?.divergences.map((item) => item.kind)).toContain("final_outcome");
  } finally {
    ledger.close();
  }
});

test("offline replay final verification fails when terminal evidence-gate claim is missing", async () => {
  const { home, ledger, artifacts, run } = setup();
  try {
    await runGoal(run.id, ledger, artifacts, {
      arxivSearch: async () => []
    });
    const gate = ledger.listEvents(run.id)
      .findLast((event) => event.type === "verifier.completed" && event.payload.verifier === "evidence-gate");
    expect(gate).toBeTruthy();
    const payloadWithoutClaim = { ...gate!.payload };
    delete payloadWithoutClaim.claim;
    updateEventPayload(ledger, gate!.id, payloadWithoutClaim);

    const config = loadConfig(home, { OPENAI_API_KEY: process.env.OPENAI_API_KEY });
    const offline = replayOffline({ runId: run.id, ledger, cwd: process.cwd(), config, verifyFinal: true });
    expect(offline.ok).toBe(false);
    expect(offline.audit.ok).toBe(false);
    expect(offline.finalVerification?.ok).toBe(false);
    expect(offline.finalVerification?.divergences.map((item) => item.kind)).toContain("audit");
    expect(offline.finalVerification?.divergences.map((item) => item.kind)).toContain("evidence_gate");
    expect(offline.finalVerification?.recomputed.finalOutcome.state).toBe("inconclusive");
  } finally {
    ledger.close();
  }
});

test("offline replay final verification fails when terminal proof-obligation review is missing", async () => {
  const { home, ledger, artifacts, run } = setup();
  try {
    await runGoal(run.id, ledger, artifacts, {
      arxivSearch: async () => []
    });
    const proofEvent = ledger.listEvents(run.id).find((event) => event.type === "proof.obligations.reviewed");
    expect(proofEvent).toBeTruthy();
    ledger.db.query("UPDATE ledger_events SET type = ? WHERE id = ?").run("proof.obligations.hidden", proofEvent!.id);

    const config = loadConfig(home, { OPENAI_API_KEY: process.env.OPENAI_API_KEY });
    const offline = replayOffline({ runId: run.id, ledger, cwd: process.cwd(), config, verifyFinal: true });
    expect(offline.ok).toBe(false);
    expect(offline.audit.ok).toBe(false);
    expect(offline.finalVerification?.ok).toBe(false);
    expect(offline.finalVerification?.divergences.map((item) => item.kind)).toContain("audit");
    expect(offline.finalVerification?.divergences.map((item) => item.kind)).toContain("proof_obligations");
    expect(offline.finalVerification?.recomputed.finalOutcome.state).toBe("inconclusive");
  } finally {
    ledger.close();
  }
});

test("offline replay final verification uses run-pinned policy despite current policy drift", async () => {
  const { home, ledger, artifacts, run } = setup();
  try {
    await runGoal(run.id, ledger, artifacts, {
      arxivSearch: async () => []
    });
    const config = loadConfig(home, { OPENAI_API_KEY: process.env.OPENAI_API_KEY });
    const driftedCurrentPolicy = buildVerifierPolicyManifest({
      trustedVerifiers: defaultTrustedVerifiers().filter((verifier) => verifier.id !== "local-deterministic-v0")
    });

    const offline = replayOffline({
      runId: run.id,
      ledger,
      cwd: process.cwd(),
      config,
      verifyFinal: true,
      currentPolicyManifest: driftedCurrentPolicy
    });
    expect(offline.ok).toBe(true);
    expect(offline.finalVerification?.ok).toBe(true);
    expect(offline.finalVerification?.recomputed.finalOutcome.state).toBe("computational_evidence");
    expect(offline.finalVerification?.recomputed.policy.drift).toBe(true);
    expect(offline.finalVerification?.recomputed.policy.currentPolicyHash).toBe(driftedCurrentPolicy.policyHash);
    expect(offline.finalVerification?.recomputed.policy.trustedVerifierIds).toContain("local-deterministic-v0");
  } finally {
    ledger.close();
  }
});

test("offline replay final verification fails when terminal run is missing pinned policy manifest", async () => {
  const { home, ledger, artifacts, run } = setup();
  try {
    await runGoal(run.id, ledger, artifacts, {
      arxivSearch: async () => []
    });
    const pinned = ledger.listEvents(run.id).find((event) => event.type === "policy.manifest.pinned");
    expect(pinned).toBeTruthy();
    ledger.db.query("UPDATE ledger_events SET type = ? WHERE id = ?").run("policy.manifest.hidden", pinned!.id);

    const config = loadConfig(home, { OPENAI_API_KEY: process.env.OPENAI_API_KEY });
    const offline = replayOffline({ runId: run.id, ledger, cwd: process.cwd(), config, verifyFinal: true });
    expect(offline.ok).toBe(false);
    expect(offline.audit.ok).toBe(false);
    expect(offline.finalVerification?.ok).toBe(false);
    expect(offline.finalVerification?.divergences.map((item) => item.kind)).toContain("audit");
    expect(offline.finalVerification?.divergences.map((item) => item.kind)).toContain("policy_manifest");
  } finally {
    ledger.close();
  }
});

test("offline replay final verification fails when pinned policy event disagrees with policy artifact", async () => {
  const { home, ledger, artifacts, run } = setup();
  try {
    await runGoal(run.id, ledger, artifacts, {
      arxivSearch: async () => []
    });
    const pinned = ledger.listEvents(run.id).find((event) => event.type === "policy.manifest.pinned");
    expect(pinned).toBeTruthy();
    updateEventPayloadAndRehash(ledger, run.id, pinned!.id, {
      ...pinned!.payload,
      policyHash: "forged-policy-hash",
      trustedVerifierIds: ["forged-verifier"]
    });

    const config = loadConfig(home, { OPENAI_API_KEY: process.env.OPENAI_API_KEY });
    const offline = replayOffline({ runId: run.id, ledger, cwd: process.cwd(), config, verifyFinal: true });
    expect(offline.audit.ok).toBe(true);
    expect(offline.ok).toBe(false);
    expect(offline.finalVerification?.ok).toBe(false);
    expect(offline.finalVerification?.divergences.map((item) => item.kind)).toContain("policy_manifest");
  } finally {
    ledger.close();
  }
});

test("offline replay final verification fails when evidence claim graph diverges from proof artifact", async () => {
  const { home, ledger, artifacts, run } = setup();
  try {
    await runGoal(run.id, ledger, artifacts, {
      arxivSearch: async () => []
    });
    const gate = ledger.listEvents(run.id)
      .findLast((event) => event.type === "verifier.completed" && event.payload.verifier === "evidence-gate");
    expect(gate).toBeTruthy();
    const claim = structuredClone(gate!.payload.claim) as {
      proofObligationGraph: { obligations: Array<{ statement: string }> };
    };
    claim.proofObligationGraph.obligations[0].statement = "Forged source claim that was not persisted in the proof-obligation artifact.";
    updateEventPayloadAndRehash(ledger, run.id, gate!.id, {
      ...gate!.payload,
      claim
    });

    const config = loadConfig(home, { OPENAI_API_KEY: process.env.OPENAI_API_KEY });
    const offline = replayOffline({ runId: run.id, ledger, cwd: process.cwd(), config, verifyFinal: true });
    expect(offline.audit.ok).toBe(true);
    expect(offline.ok).toBe(false);
    expect(offline.finalVerification?.ok).toBe(false);
    expect(offline.finalVerification?.divergences.map((item) => item.kind)).toContain("proof_obligations");
  } finally {
    ledger.close();
  }
});

test("offline replay final verification fails when supporting verifier artifact is forged", async () => {
  const { home, ledger, artifacts, run } = setup();
  try {
    await runGoal(run.id, ledger, artifacts, {
      arxivSearch: async () => []
    });
    const gate = ledger.listEvents(run.id)
      .findLast((event) => event.type === "verifier.completed" && event.payload.verifier === "evidence-gate");
    expect(gate).toBeTruthy();
    const claim = structuredClone(gate!.payload.claim) as {
      verifierArtifactIds: string[];
      supportingVerifierResults: Array<{ artifactIds: string[] }>;
    };
    const forgedSupportingArtifactId = claim.verifierArtifactIds[0];
    const forgedSupportingArtifact = ledger.listArtifacts(run.id).find((artifact) => artifact.id === forgedSupportingArtifactId);
    expect(forgedSupportingArtifact).toBeTruthy();
    claim.supportingVerifierResults[0].artifactIds = [forgedSupportingArtifactId];
    const gateDecision = structuredClone(gate!.payload.gate) as {
      quorum: {
        satisfiedBy: Array<{
          role: string;
          artifactIds: string[];
          artifactHashes: string[];
        }>;
      };
    };
    const supportingQuorum = gateDecision.quorum.satisfiedBy.find((item) => item.role === "independent_checker");
    expect(supportingQuorum).toBeTruthy();
    supportingQuorum!.artifactIds = [forgedSupportingArtifactId];
    supportingQuorum!.artifactHashes = [forgedSupportingArtifact!.sha256];
    updateEventPayloadAndRehash(ledger, run.id, gate!.id, {
      ...gate!.payload,
      claim,
      gate: gateDecision
    });

    const config = loadConfig(home, { OPENAI_API_KEY: process.env.OPENAI_API_KEY });
    const offline = replayOffline({ runId: run.id, ledger, cwd: process.cwd(), config, verifyFinal: true });
    expect(offline.audit.ok).toBe(true);
    expect(offline.ok).toBe(false);
    expect(offline.finalVerification?.ok).toBe(false);
    expect(offline.finalVerification?.divergences.map((item) => item.kind)).toContain("evidence_gate");
  } finally {
    ledger.close();
  }
});

test("restart after mid-provider call conservatively debits reservations without double-spend", () => {
  const { home, ledger, artifacts, run } = setup();
  const paths = getAppPaths();
  const config = loadConfig(home, { OPENAI_API_KEY: process.env.OPENAI_API_KEY });
  const request = artifacts.create(run.id, "ai.request", JSON.stringify({ prompt: "crash before response" }));
  const prepared = ledger.prepareExternalOperation({
    runId: run.id,
    operationType: "ai.generateText",
    provider: "openai",
    idempotencyKey: "ai-crash-key-1",
    requestHash: "ai-crash-request-hash-1",
    requestArtifactId: request.id,
    reserve: { tokens: 25, attempts: 1 }
  });
  expect(prepared.ok).toBe(true);
  if (!prepared.ok || !prepared.created) throw new Error("expected new external operation");
  ledger.startExternalOperation(prepared.operation.id);
  expect(ledger.getBudgetUsage(run.id).tokens).toBe(25);
  expect(ledger.getBudgetUsage(run.id).attempts).toBe(1);
  ledger.close();

  const restarted = new Ledger(paths.dbPath);
  try {
    expect(restarted.reconcileOpenExternalOperations(run.id, "process restart after provider crash")).toBe(1);
    expect(restarted.reconcileOpenExternalOperations(run.id, "second restart pass")).toBe(0);
    expect(restarted.listOpenBudgetReservations(run.id)).toHaveLength(1);
    expect(restarted.getBudgetUsage(run.id)).toMatchObject({ attempts: 1, tokens: 25, usd: 0, elapsedMs: 0 });
    const operation = restarted.requireExternalOperation(prepared.operation.id);
    expect(operation.status).toBe("unknown_remote_outcome");
    expect(operation.responseArtifactId).toBeUndefined();

    const duplicate = restarted.prepareExternalOperation({
      runId: run.id,
      operationType: "ai.generateText",
      provider: "openai",
      idempotencyKey: "ai-crash-key-1",
      requestHash: "ai-crash-request-hash-1",
      requestArtifactId: request.id,
      reserve: { tokens: 25, attempts: 1 }
    });
    expect(duplicate.ok).toBe(true);
    if (!duplicate.ok) throw new Error("duplicate unexpectedly failed");
    expect(duplicate.created).toBe(false);
    expect(duplicate.operation.status).toBe("unknown_remote_outcome");
    expect(replayOffline({ runId: run.id, ledger: restarted, cwd: process.cwd(), config }).ok).toBe(true);
  } finally {
    restarted.close();
  }
});

test("restart after remote dispatch send dead-letters lost acknowledgement without releasing budget", () => {
  const { home, ledger, artifacts, run } = setup();
  const paths = getAppPaths();
  const config = loadConfig(home, { OPENAI_API_KEY: process.env.OPENAI_API_KEY });
  const request = artifacts.create(run.id, "remote.worker.dispatch.request", JSON.stringify({ payload: "remote work" }));
  const prepared = ledger.prepareExternalOperation({
    runId: run.id,
    operationType: "remote.worker.dispatch",
    provider: "remote-worker",
    idempotencyKey: "remote-dispatch-restart-key-1",
    requestHash: "remote-dispatch-restart-request-hash-1",
    requestArtifactId: request.id,
    reserve: { attempts: 1, elapsedMs: 50, usd: 0.01 }
  });
  expect(prepared.ok).toBe(true);
  if (!prepared.ok || !prepared.created) throw new Error("expected new remote dispatch operation");
  ledger.startExternalOperation(prepared.operation.id);
  expect(ledger.getBudgetUsage(run.id)).toMatchObject({ attempts: 1, elapsedMs: 50, usd: 0.01 });
  ledger.close();

  const restarted = new Ledger(paths.dbPath);
  try {
    expect(restarted.reconcileOpenExternalOperations(run.id, "process restart after remote dispatch send")).toBe(1);
    expect(restarted.reconcileOpenExternalOperations(run.id, "second restart pass")).toBe(0);
    expect(restarted.listOpenBudgetReservations(run.id)).toHaveLength(1);
    expect(restarted.getBudgetUsage(run.id)).toMatchObject({ attempts: 1, tokens: 0, usd: 0.01, elapsedMs: 50 });
    const operation = restarted.requireExternalOperation(prepared.operation.id);
    expect(operation.status).toBe("dead_lettered");
    expect(operation.responseArtifactId).toBeUndefined();

    const duplicate = restarted.prepareExternalOperation({
      runId: run.id,
      operationType: "remote.worker.dispatch",
      provider: "remote-worker",
      idempotencyKey: "remote-dispatch-restart-key-1",
      requestHash: "remote-dispatch-restart-request-hash-1",
      requestArtifactId: request.id,
      reserve: { attempts: 1, elapsedMs: 50, usd: 0.01 }
    });
    expect(duplicate.ok).toBe(true);
    if (!duplicate.ok) throw new Error("duplicate unexpectedly failed");
    expect(duplicate.created).toBe(false);
    expect(duplicate.operation.status).toBe("dead_lettered");
    expect(replayOffline({ runId: run.id, ledger: restarted, cwd: process.cwd(), config }).ok).toBe(true);
    expect(reconcileGoalRunForResume({
      runId: run.id,
      ledger: restarted,
      cwd: process.cwd(),
      config,
      reason: "resume after remote dispatch dead letter"
    }).deadLetterExternalOperations).toHaveLength(1);
  } finally {
    restarted.close();
  }
});

test("restart after mid-ledger reservation write is deterministic and releases budget once", () => {
  const { home, ledger, run } = setup();
  const paths = getAppPaths();
  const config = loadConfig(home, { OPENAI_API_KEY: process.env.OPENAI_API_KEY });
  const reservation = ledger.reserveBudget({
    runId: run.id,
    reserve: { tokens: 10 },
    operationType: "source.arxiv",
    operationId: "mid-ledger-reservation"
  });
  expect(reservation.ok).toBe(true);
  expect(ledger.listOpenBudgetReservations(run.id)).toHaveLength(1);
  const eventCountBeforeRestart = ledger.listEvents(run.id).length;
  ledger.close();

  const restarted = new Ledger(paths.dbPath);
  try {
    expect(restarted.listEvents(run.id)).toHaveLength(eventCountBeforeRestart);
    expect(restarted.reconcileOpenBudgetReservations(run.id, "restart after mid-ledger reservation")).toBe(1);
    expect(restarted.reconcileOpenBudgetReservations(run.id, "second restart pass")).toBe(0);
    expect(restarted.listOpenBudgetReservations(run.id)).toHaveLength(0);
    expect(restarted.getBudgetUsage(run.id).tokens).toBe(0);
    const offline = replayOffline({ runId: run.id, ledger: restarted, cwd: process.cwd(), config });
    expect(offline.ok).toBe(true);
    expect(offline.replayedEvents).toBe(restarted.listEvents(run.id).length);
  } finally {
    restarted.close();
  }
});

test("restart after mid-artifact write ignores orphan files and preserves manifest determinism", () => {
  const { home, ledger, run } = setup();
  const paths = getAppPaths();
  const config = loadConfig(home, { OPENAI_API_KEY: process.env.OPENAI_API_KEY });
  const runArtifactDir = join(paths.artifactsDir, run.id);
  mkdirSync(runArtifactDir, { recursive: true });
  const orphanPath = join(runArtifactDir, "orphan-mid-artifact-write.txt");
  writeFileSync(orphanPath, "file written before ledger insert");
  ledger.close();

  const restarted = new Ledger(paths.dbPath);
  try {
    const manifest = buildReplayManifest({ runId: run.id, ledger: restarted, cwd: process.cwd(), config });
    const offline = replayOffline({ runId: run.id, ledger: restarted, cwd: process.cwd(), config });
    expect(offline.ok).toBe(true);
    expect(manifest.artifacts.some((artifact) => artifact.sha256 === "orphan-mid-artifact-write")).toBe(false);
    expect(JSON.stringify(manifest)).not.toContain("orphan-mid-artifact-write.txt");
  } finally {
    restarted.close();
  }
});

test("restart after mid-worker task preserves committed outputs and reconciles stale leases", () => {
  const { home, ledger, artifacts, run } = setup();
  const paths = getAppPaths();
  const config = loadConfig(home, { OPENAI_API_KEY: process.env.OPENAI_API_KEY });
  const best = ledger.enqueueWorkerJob({
    runId: run.id,
    kind: "experiment",
    payload: { branch: "best" },
    maxAttempts: 1,
    dedupeKey: "experiment-best"
  });
  const [leasedBest] = ledger.leaseWorkerJobs(run.id, "worker-best", 1, 60_000);
  expect(leasedBest.id).toBe(best.id);
  ledger.markWorkerJobRunning(leasedBest.id, "worker-best", leasedBest.attempts);
  const bestArtifact = artifacts.create(run.id, "experiment.best", JSON.stringify({ branch: "best", score: 1 }));
  ledger.commitWorkerJob(leasedBest.id, "worker-best", leasedBest.attempts, { artifactId: bestArtifact.id, score: 1 });
  const crashed = ledger.enqueueWorkerJob({
    runId: run.id,
    kind: "experiment",
    payload: { branch: "crashed" },
    maxAttempts: 2,
    dedupeKey: "experiment-crashed"
  });
  const [leasedCrashed] = ledger.leaseWorkerJobs(run.id, "worker-crashed", 1, -1);
  expect(leasedCrashed.id).toBe(crashed.id);
  const reservation = ledger.reserveBudget({
    runId: run.id,
    reserve: { attempts: 1 },
    operationType: "worker.job",
    operationId: leasedCrashed.id,
    workerId: "worker-crashed"
  });
  expect(reservation.ok).toBe(true);
  ledger.close();

  const restarted = new Ledger(paths.dbPath);
  try {
    const reconciled = restarted.reconcileStaleWorkerJobs(run.id);
    expect(reconciled.map((job) => job.id)).toEqual([crashed.id]);
    expect(restarted.reconcileOpenBudgetReservations(run.id, "restart after worker crash")).toBe(1);
    expect(restarted.requireWorkerJob(best.id).status).toBe("committed");
    expect(restarted.requireWorkerJob(crashed.id).status).toBe("failed_retryable");
    expect(restarted.listOpenBudgetReservations(run.id)).toHaveLength(0);
    const manifest = buildReplayManifest({ runId: run.id, ledger: restarted, cwd: process.cwd(), config });
    expect(manifest.artifacts.some((artifact) => artifact.id === bestArtifact.id && artifact.kind === "experiment.best")).toBe(true);
    expect(replayOffline({ runId: run.id, ledger: restarted, cwd: process.cwd(), config }).ok).toBe(true);
  } finally {
    restarted.close();
  }
});
