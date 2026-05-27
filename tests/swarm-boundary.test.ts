import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "../src/artifacts";
import { generateInstrumentedText } from "../src/ai/instrumented";
import { Ledger } from "../src/ledger";
import { getAppPaths } from "../src/paths";
import {
  AI_SDK_SWARM_BOUNDARY_CONTRACT,
  assertAiSdkDynamicBoundaryContext,
  attachAiSdkDynamicBoundaryContext,
  authorizeRemoteWorkerMutation,
  classifyAiSdkSummaryEvidence,
  compareRemoteDispatchReplay,
  persistRemoteWorkerAttestation,
  requireAcceptedRemoteWorkerAttestation,
  signRemoteWorkerLeaseCommand,
  type RemoteWorkerCapabilityAttestation,
  type RemoteWorkerCapabilityRequirement,
  type RemoteWorkerLeaseCommand
} from "../src/swarm-boundary";
import { buildReplayManifest } from "../src/replay";

test("AI SDK swarm boundary assigns global authority to CLI ledger", () => {
  expect(AI_SDK_SWARM_BOUNDARY_CONTRACT.aiSdkOwns).toContain("worker-local model/tool loop execution");
  expect(AI_SDK_SWARM_BOUNDARY_CONTRACT.cliLedgerOwns).toContain("global worker leases");
  expect(AI_SDK_SWARM_BOUNDARY_CONTRACT.cliLedgerOwns).toContain("budget reservation, debit, release, and kill switches");
  expect(AI_SDK_SWARM_BOUNDARY_CONTRACT.cliLedgerOwns).toContain("goal success and evidence gates");
  expect(AI_SDK_SWARM_BOUNDARY_CONTRACT.remoteControlPlane.authority).toBe("cli-ledger");
  expect(AI_SDK_SWARM_BOUNDARY_CONTRACT.remoteControlPlane.commandAuth).toContain("coordinator signs every remote worker lease command");
  expect(AI_SDK_SWARM_BOUNDARY_CONTRACT.remoteControlPlane.idempotency).toContain("duplicate dispatch with different signed payload is rejected");
  expect(AI_SDK_SWARM_BOUNDARY_CONTRACT.remoteControlPlane.budgetOwnership).toContain("the CLI ledger owns all budget reservation, debit, release, and kill-switch decisions");

  const decision = classifyAiSdkSummaryEvidence({
    toModelOutput: "This summary claims the theorem is solved."
  });
  expect(decision.canMarkGoalMet).toBe(false);
  expect(decision.evidenceGrade).toBe("heuristic_evidence");
  expect(decision.reason).toContain("lossy heuristic");
});

test("dynamic AI SDK guard fails monkeypatched generateText and streamText without ledger context", () => {
  const controller = new AbortController();
  const baseContext = {
    format: "matematica.ai-sdk.dynamic-boundary-context" as const,
    schemaVersion: 1 as const,
    surface: "generateText" as const,
    scope: "standalone" as const,
    runId: "run-sdk-boundary",
    externalOperationId: "op-sdk-boundary",
    providerRuntimeLeaseId: "provider-lease-sdk-boundary",
    budgetReservationId: "budget-reservation-sdk-boundary",
    requestArtifactId: "art-request-sdk-boundary",
    transcriptArtifactId: "art-transcript-plan-sdk-boundary",
    provider: "local",
    modelId: "local-sdk-boundary-model",
    providerMetadata: {
      requestedProvider: "local",
      requestedModel: "local-sdk-boundary-model"
    },
    abortSignal: controller.signal
  };
  const fakeGenerateText = (options: unknown) => {
    const context = assertAiSdkDynamicBoundaryContext(options, { surface: "generateText" });
    return { text: context.externalOperationId };
  };
  const fakeStreamText = (options: unknown) => {
    const context = assertAiSdkDynamicBoundaryContext(options, { surface: "streamText" });
    return { stream: context.transcriptArtifactId };
  };

  expect(fakeGenerateText(attachAiSdkDynamicBoundaryContext({
    model: {} as never,
    prompt: "ok",
    abortSignal: controller.signal
  }, baseContext))).toEqual({ text: "op-sdk-boundary" });
  expect(fakeStreamText(attachAiSdkDynamicBoundaryContext({
    model: {} as never,
    prompt: "ok",
    abortSignal: controller.signal
  }, { ...baseContext, surface: "streamText" }))).toEqual({ stream: "art-transcript-plan-sdk-boundary" });
  expect(() => fakeGenerateText({
    model: {} as never,
    prompt: "missing context",
    abortSignal: controller.signal
  })).toThrow("dynamic boundary context");
  expect(() => fakeStreamText(attachAiSdkDynamicBoundaryContext({
    model: {} as never,
    prompt: "wrong signal",
    abortSignal: new AbortController().signal
  }, { ...baseContext, surface: "streamText" }))).toThrow("AbortSignal does not match");
});

test("AI SDK swarm boundary ADR preserves provider surface and authority split", () => {
  const adr = readFileSync("docs/adr/0001-ai-sdk-swarm-boundary.md", "utf8");

  expect(adr).toContain("Status: accepted");
  expect(adr).toContain("The CLI ledger is the swarm coordinator and source of authority.");
  expect(adr).toContain("AI SDK owns:");
  expect(adr).toContain("The CLI ledger owns:");
  expect(adr).toContain("Worker-local model and tool loop execution.");
  expect(adr).toContain("Budget reservation, debit, release, and kill switches.");
  expect(adr).toContain("Remote workers never mint leases, budgets, success decisions, verifier authority, or final outcomes.");
  expect(adr).toContain("Every model request, response, step trace, tool call, tool result, usage object, retry, failure, and cancellation");
  expect(adr).toContain("`ai`: `^6.0.191`");
  expect(adr).toContain("`@ai-sdk/openai`: `^3.0.65`");
  expect(adr).toContain("`@ai-sdk/anthropic`: `^3.0.79`");
  expect(adr).toContain("`@ai-sdk/cerebras`: `^2.0.54`");
  expect(adr).toContain("`@openrouter/ai-sdk-provider`: `^2.9.0`");
  expect(adr).toContain("Current AI SDK documentation checked on 2026-05-26");
  expect(adr).toContain("`stopWhen`");
  expect(adr).toContain("`prepareStep`");
  expect(adr).toContain("`maxRetries`");
  expect(adr).toContain("`timeout`");
  expect(adr).toContain("`abortSignal`");
  expect(adr).toContain("step callbacks");
  expect(adr).toContain("tool-call repair hooks");
  expect(adr).toContain("AI SDK subagents are model-callable tools");
  expect(adr).toContain("https://ai-sdk.dev/docs/reference/ai-sdk-core/tool-loop-agent");
});

test("remote worker control plane authorizes only signed matching lease mutations", () => {
  const command = leaseCommand();
  const decision = authorizeRemoteWorkerMutation({
    command,
    signingKey: "test-signing-key",
    now: "2026-05-25T12:00:10.000Z",
    mutation: {
      commandType: "worker.heartbeat",
      dispatchId: command.dispatchId,
      runId: command.runId,
      jobId: command.jobId,
      workerId: command.workerId,
      attempt: command.attempt,
      budgetReservationId: command.budgetReservationId
    }
  });

  expect(decision).toEqual({ ok: true });
});

test("remote worker control plane rejects revoked workers before mutation", () => {
  const command = leaseCommand();
  const decision = authorizeRemoteWorkerMutation({
    command,
    signingKey: "test-signing-key",
    now: "2026-05-25T12:00:10.000Z",
    revocation: { revokedWorkerIds: [command.workerId] },
    mutation: {
      commandType: "worker.committed",
      dispatchId: command.dispatchId,
      runId: command.runId,
      jobId: command.jobId,
      workerId: command.workerId,
      attempt: command.attempt,
      budgetReservationId: command.budgetReservationId
    }
  });

  expect(decision.ok).toBe(false);
  expect(decision.reason).toContain("revoked");
});

test("remote worker control plane rejects stale leases", () => {
  const command = leaseCommand({ leaseExpiresAt: "2026-05-25T12:00:05.000Z" });
  const decision = authorizeRemoteWorkerMutation({
    command,
    signingKey: "test-signing-key",
    now: "2026-05-25T12:00:06.000Z",
    mutation: {
      commandType: "worker.heartbeat",
      dispatchId: command.dispatchId,
      runId: command.runId,
      jobId: command.jobId,
      workerId: command.workerId,
      attempt: command.attempt,
      budgetReservationId: command.budgetReservationId
    }
  });

  expect(decision.ok).toBe(false);
  expect(decision.reason).toContain("stale");
});

test("remote worker control plane rejects unauthorized worker mutations", () => {
  const command = leaseCommand();
  const decision = authorizeRemoteWorkerMutation({
    command,
    signingKey: "test-signing-key",
    now: "2026-05-25T12:00:10.000Z",
    mutation: {
      commandType: "worker.failed",
      dispatchId: command.dispatchId,
      runId: command.runId,
      jobId: command.jobId,
      workerId: "worker-attacker",
      attempt: command.attempt,
      budgetReservationId: command.budgetReservationId
    }
  });

  expect(decision.ok).toBe(false);
  expect(decision.reason).toContain("owner mismatch");
});

test("remote worker control plane treats identical duplicate dispatch as replay and rejects divergent duplicate dispatch", () => {
  const command = leaseCommand();
  expect(compareRemoteDispatchReplay(command, command)).toEqual({ ok: true, duplicate: true });

  const divergent = leaseCommand({
    commandId: "cmd-divergent",
    dispatchId: command.dispatchId,
    jobId: "job-other"
  });
  const decision = compareRemoteDispatchReplay(command, divergent);
  expect(decision.ok).toBe(false);
  expect(decision.duplicate).toBe(true);
  expect(decision.reason).toContain("different signed payload");
});

test("remote worker attestation gate rejects missing attestations", () => {
  const decision = requireAcceptedRemoteWorkerAttestation({
    events: [],
    workerId: "remote-worker-1"
  });

  expect(decision.ok).toBe(false);
  expect(decision.issues[0]).toContain("missing accepted remote worker attestation");
});

test("remote worker attestation rejects CLI version mismatches", () => {
  const context = attestationContext();
  try {
    const result = persistRemoteWorkerAttestation({
      ...context,
      attestation: attestation({ cliVersion: "0.0.0-old" })
    });

    expect(result.ok).toBe(false);
    expect(result.issues).toContain("attestation CLI version mismatch");
    const event = context.ledger.listEvents(context.runId).find((item) => item.type === "remote.worker.attested");
    expect(event?.payload.ok).toBe(false);
    expect(event?.artifactIds).toContain(result.artifactId);
  } finally {
    context.close();
  }
});

test("remote worker attestation rejects provider mismatches", () => {
  const context = attestationContext();
  try {
    const result = persistRemoteWorkerAttestation({
      ...context,
      attestation: attestation({ allowedProviders: ["local"] })
    });

    expect(result.ok).toBe(false);
    expect(result.issues).toContain("attestation missing required provider openai");
  } finally {
    context.close();
  }
});

test("remote worker attestation rejects verifier mismatches", () => {
  const context = attestationContext({ requireLean4: true, requireMathlib: true });
  try {
    const result = persistRemoteWorkerAttestation({
      ...context,
      attestation: attestation({ verifierToolchain: { lean4: false, mathlib: false } })
    });

    expect(result.ok).toBe(false);
    expect(result.issues).toContain("attestation missing Lean 4 verifier");
    expect(result.issues).toContain("attestation missing mathlib");
  } finally {
    context.close();
  }
});

test("remote worker accepted attestation is included in replay manifest without network", () => {
  const context = attestationContext();
  try {
    const result = persistRemoteWorkerAttestation({
      ...context,
      attestation: attestation()
    });
    expect(result.ok).toBe(true);

    const accepted = requireAcceptedRemoteWorkerAttestation({
      events: context.ledger.listEvents(context.runId),
      workerId: "remote-worker-1"
    });
    expect(accepted.ok).toBe(true);

    const manifest = buildReplayManifest({
      runId: context.runId,
      ledger: context.ledger,
      cwd: process.cwd(),
      config: {
        defaultWorkflow: "pflk",
        defaultMaxWorkers: 1,
        localOnly: true,
        providers: []
      }
    });
    expect(manifest.remoteWorkers).toHaveLength(1);
    expect(manifest.remoteWorkers[0]).toMatchObject({
      workerId: "remote-worker-1",
      accepted: true,
      artifactId: result.artifactId,
      cliVersion: "0.0.1",
      protocolVersion: 1,
      allowedProviders: ["openai"],
      networkMode: "remote-provider-api",
      budgetEnvelopeHash: "budget-envelope-hash"
    });
    expect(manifest.actionPersistence.some((action) =>
      action.type === "remote.worker.attested" &&
      action.replayable &&
      action.artifactIds.includes(result.artifactId)
    )).toBe(true);
  } finally {
    context.close();
  }
});

test("worker-local AI SDK calls require scheduler abort signal before external effects", async () => {
  const home = mkdtempSync(join(tmpdir(), "matematica-boundary-test-"));
  process.env.MATEMATICA_HOME = home;
  const ledger = new Ledger(getAppPaths().dbPath);
  const artifacts = new ArtifactStore(getAppPaths().artifactsDir, ledger);
  const run = ledger.createRun({
    problem: "Boundary",
    goal: "Reject unsignalled worker-local calls",
    successCriteria: ["abort signal required"],
    workflow: "pflk",
    budget: { maxTokens: 10 }
  });
  let providerCalled = false;

  try {
    await expect(generateInstrumentedText({
      runId: run.id,
      ledger,
      artifacts,
      provider: "openai",
      modelId: "fake-boundary-model",
      model: {} as never,
      prompt: "Run as worker-local without signal",
      scope: "worker-local",
      generate: async () => {
        providerCalled = true;
        return {
          text: "should not run",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          finishReason: "stop",
          providerMetadata: {}
        };
      }
    })).rejects.toThrow("scheduler AbortSignal");

    expect(providerCalled).toBe(false);
    expect(ledger.listExternalOperations(run.id)).toHaveLength(0);
    expect(ledger.listArtifacts(run.id)).toHaveLength(0);
  } finally {
    ledger.close();
    delete process.env.MATEMATICA_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});

test("worker-local AI SDK calls require scheduler-owned lease before external effects", async () => {
  const home = mkdtempSync(join(tmpdir(), "matematica-boundary-test-"));
  process.env.MATEMATICA_HOME = home;
  const ledger = new Ledger(getAppPaths().dbPath);
  const artifacts = new ArtifactStore(getAppPaths().artifactsDir, ledger);
  const run = ledger.createRun({
    problem: "Boundary",
    goal: "Reject unleased worker-local calls",
    successCriteria: ["scheduler lease required"],
    workflow: "pflk",
    budget: { maxTokens: 10 }
  });
  const controller = new AbortController();
  let providerCalled = false;

  try {
    await expect(generateInstrumentedText({
      runId: run.id,
      ledger,
      artifacts,
      provider: "local",
      modelId: "local-boundary-model",
      model: {} as never,
      prompt: "Run as worker-local without a scheduler lease",
      scope: "worker-local",
      settings: { maxOutputTokens: 4, abortSignal: controller.signal },
      generate: async () => {
        providerCalled = true;
        return {
          text: "should not run",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          finishReason: "stop",
          providerMetadata: {}
        };
      }
    })).rejects.toThrow("scheduler-owned lease");

    expect(providerCalled).toBe(false);
    expect(ledger.listExternalOperations(run.id)).toHaveLength(0);
    expect(ledger.listArtifacts(run.id)).toHaveLength(0);
  } finally {
    ledger.close();
    delete process.env.MATEMATICA_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});

function leaseCommand(overrides: Partial<RemoteWorkerLeaseCommand> = {}): RemoteWorkerLeaseCommand {
  return signRemoteWorkerLeaseCommand({
    commandId: overrides.commandId ?? "cmd-1",
    dispatchId: overrides.dispatchId ?? "dispatch-1",
    runId: overrides.runId ?? "run-1",
    jobId: overrides.jobId ?? "job-1",
    workerId: overrides.workerId ?? "worker-1",
    attempt: overrides.attempt ?? 1,
    issuedAt: overrides.issuedAt ?? "2026-05-25T12:00:00.000Z",
    leaseExpiresAt: overrides.leaseExpiresAt ?? "2026-05-25T12:01:00.000Z",
    heartbeatTtlMs: overrides.heartbeatTtlMs ?? 15_000,
    budgetReservationId: overrides.budgetReservationId ?? "reservation-1",
    budgetOwner: overrides.budgetOwner ?? "cli-ledger",
    providerAllowlist: overrides.providerAllowlist ?? ["openai"],
    networkMode: overrides.networkMode ?? "remote-provider-api",
    payloadHash: overrides.payloadHash ?? "payload-sha256"
  }, "test-signing-key");
}

function attestationContext(requirementOverrides: Partial<RemoteWorkerCapabilityRequirement> = {}): {
  runId: string;
  ledger: Ledger;
  artifacts: ArtifactStore;
  requirement: RemoteWorkerCapabilityRequirement;
  close: () => void;
} {
  const home = mkdtempSync(join(tmpdir(), "matematica-remote-attestation-test-"));
  const previousHome = process.env.MATEMATICA_HOME;
  process.env.MATEMATICA_HOME = home;
  const ledger = new Ledger(getAppPaths().dbPath);
  const artifacts = new ArtifactStore(getAppPaths().artifactsDir, ledger);
  const run = ledger.createRun({
    problem: "Remote attestation",
    goal: "Reject incompatible remote workers",
    successCriteria: ["worker attestation is accepted before dispatch"],
    workflow: "pflk",
    budget: { maxAttempts: 1, maxWorkers: 1, maxUsd: 1 }
  });
  return {
    runId: run.id,
    ledger,
    artifacts,
    requirement: {
      schemaVersion: 1,
      cliVersion: "0.0.1",
      protocolVersion: 1,
      requiredProviders: ["openai"],
      networkMode: "remote-provider-api",
      sandboxMode: "isolated",
      budgetEnvelopeHash: "budget-envelope-hash",
      maxClockDriftMs: 10_000,
      now: "2026-05-25T12:00:00.000Z",
      ...requirementOverrides
    },
    close: () => {
      ledger.close();
      if (previousHome === undefined) {
        delete process.env.MATEMATICA_HOME;
      } else {
        process.env.MATEMATICA_HOME = previousHome;
      }
      rmSync(home, { recursive: true, force: true });
    }
  };
}

function attestation(overrides: Partial<RemoteWorkerCapabilityAttestation> = {}): RemoteWorkerCapabilityAttestation {
  return {
    format: "matematica.remote.worker.attestation",
    schemaVersion: 1,
    workerId: "remote-worker-1",
    cliVersion: "0.0.1",
    protocolVersion: 1,
    runtime: { name: "bun", version: "1.3.13" },
    platform: { os: "linux", arch: "x64" },
    allowedProviders: ["openai"],
    networkMode: "remote-provider-api",
    sandboxMode: "isolated",
    budgetEnvelopeHash: "budget-envelope-hash",
    clock: {
      source: "system",
      observedAt: "2026-05-25T12:00:00.000Z",
      maxDriftMs: 5_000
    },
    verifierToolchain: {
      lean4: true,
      mathlib: true
    },
    codeIdentity: {
      packageName: "@hasna/matematica",
      packageVersion: "0.0.1",
      sourceRevision: "test"
    },
    features: ["remote-worker-attestation-v1"],
    ...overrides
  };
}
