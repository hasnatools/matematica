import { createHmac, createHash } from "node:crypto";
import type { ArtifactStore } from "./artifacts";
import type { LedgerEvent } from "./domain";
import type { Ledger } from "./ledger";

export type AiSdkCallScope = "standalone" | "worker-local";

export type SwarmBoundaryContract = {
  aiSdkOwns: string[];
  cliLedgerOwns: string[];
  evidencePolicy: string;
  remoteControlPlane: RemoteSwarmControlPlaneContract;
};

export type RemoteSwarmControlPlaneContract = {
  authority: "cli-ledger";
  commandAuth: string[];
  workerLease: string[];
  heartbeat: string[];
  revocation: string[];
  idempotency: string[];
  replay: string[];
  budgetOwnership: string[];
};

export type WorkerLocalAiCallBoundaryInput = {
  runId?: string;
  ledger?: Ledger;
  scope?: AiSdkCallScope;
  abortSignal?: AbortSignal;
  persistsSteps: boolean;
  usesExternalOperationOutbox: boolean;
  schedulerLease?: WorkerLocalAiCallLease;
};

export type WorkerLocalAiCallLease = {
  jobId: string;
  workerId: string;
  attempt: number;
};

export type AiSdkSummaryEvidenceDecision = {
  canMarkGoalMet: false;
  evidenceGrade: "heuristic_evidence";
  reason: string;
};

export const MATEMATICA_AI_SDK_BOUNDARY_CONTEXT = Symbol.for("matematica.ai-sdk.dynamic-boundary-context");

export type AiSdkDynamicBoundarySurface =
  | "generateText"
  | "streamText"
  | "ToolLoopAgent.generate"
  | "ToolLoopAgent.stream";

export type AiSdkDynamicBoundaryContext = {
  format: "matematica.ai-sdk.dynamic-boundary-context";
  schemaVersion: 1;
  surface: AiSdkDynamicBoundarySurface;
  scope: AiSdkCallScope;
  runId: string;
  externalOperationId: string;
  providerRuntimeLeaseId: string;
  budgetReservationId: string;
  requestArtifactId: string;
  transcriptArtifactId: string;
  provider: string;
  modelId: string;
  providerMetadata: {
    requestedProvider: string;
    requestedModel: string;
  };
  abortSignal: AbortSignal;
  schedulerLease?: WorkerLocalAiCallLease & {
    leaseExpiresAt?: string;
  };
};

export type AiSdkDynamicBoundaryAssertion = {
  surface?: AiSdkDynamicBoundarySurface;
  scope?: AiSdkCallScope;
  runId?: string;
  externalOperationId?: string;
  providerRuntimeLeaseId?: string;
  budgetReservationId?: string;
  requestArtifactId?: string;
  transcriptArtifactId?: string;
  provider?: string;
  modelId?: string;
  schedulerLeaseRequired?: boolean;
};

export type RemoteWorkerLeaseCommand = {
  commandType: "worker.lease";
  protocolVersion: 1;
  commandId: string;
  dispatchId: string;
  runId: string;
  jobId: string;
  workerId: string;
  attempt: number;
  issuedAt: string;
  leaseExpiresAt: string;
  heartbeatTtlMs: number;
  budgetReservationId: string;
  budgetOwner: "cli-ledger";
  providerAllowlist: string[];
  networkMode: "local-only" | "remote-provider-api";
  payloadHash: string;
  signature: string;
};

export type RemoteWorkerLeaseCommandInput = Omit<RemoteWorkerLeaseCommand, "commandType" | "protocolVersion" | "signature">;

export type RemoteWorkerMutation = {
  commandType: "worker.started" | "worker.heartbeat" | "worker.committed" | "worker.failed" | "worker.cancelled";
  dispatchId: string;
  runId: string;
  jobId: string;
  workerId: string;
  attempt: number;
  budgetReservationId?: string;
};

export type RemoteWorkerRevocation = {
  revokedWorkerIds?: string[];
  revokedCommandIds?: string[];
  revokedDispatchIds?: string[];
};

export type RemoteWorkerAuthorizationInput = {
  command: RemoteWorkerLeaseCommand;
  mutation: RemoteWorkerMutation;
  signingKey: string;
  now?: string;
  revocation?: RemoteWorkerRevocation;
};

export type RemoteWorkerAuthorizationDecision = {
  ok: boolean;
  reason?: string;
};

export type RemoteDispatchReplayDecision = {
  ok: boolean;
  duplicate: boolean;
  reason?: string;
};

export type RemoteWorkerCapabilityAttestation = {
  format: "matematica.remote.worker.attestation";
  schemaVersion: 1;
  workerId: string;
  cliVersion: string;
  protocolVersion: 1;
  runtime: {
    name: "bun";
    version: string;
  };
  platform: {
    os: string;
    arch: string;
  };
  allowedProviders: string[];
  networkMode: "local-only" | "remote-provider-api";
  sandboxMode: "isolated" | "unenforced";
  budgetEnvelopeHash: string;
  clock: {
    source: "system" | "monotonic";
    observedAt: string;
    maxDriftMs: number;
  };
  verifierToolchain: {
    lean4: boolean;
    mathlib: boolean;
    sage?: boolean;
    sympy?: boolean;
  };
  codeIdentity: {
    packageName: string;
    packageVersion: string;
    sourceRevision?: string;
  };
  features: string[];
};

export type RemoteWorkerCapabilityRequirement = {
  schemaVersion: 1;
  cliVersion: string;
  protocolVersion: 1;
  requiredProviders: string[];
  networkMode: "local-only" | "remote-provider-api";
  sandboxMode?: "isolated" | "unenforced";
  budgetEnvelopeHash: string;
  requireLean4?: boolean;
  requireMathlib?: boolean;
  maxClockDriftMs?: number;
  now?: string;
};

export type RemoteWorkerAttestationDecision = {
  ok: boolean;
  issues: string[];
};

export type PersistRemoteWorkerAttestationResult = RemoteWorkerAttestationDecision & {
  artifactId: string;
  attestationHash: string;
  eventId: string;
};

export const AI_SDK_SWARM_BOUNDARY_CONTRACT: SwarmBoundaryContract = {
  aiSdkOwns: [
    "worker-local model/tool loop execution",
    "tool-call sequencing inside one leased worker attempt",
    "provider-specific step metadata capture"
  ],
  cliLedgerOwns: [
    "global worker leases",
    "budget reservation, debit, release, and kill switches",
    "cancellation AbortSignal propagation",
    "external operation idempotency and retry lineage",
    "artifact persistence and deterministic replay provenance",
    "goal success and evidence gates"
  ],
  evidencePolicy: "AI SDK tool-loop text, toModelOutput summaries, and model-visible tool summaries are lossy heuristic material; they are never verifier-backed evidence and cannot mark goal_met.",
  remoteControlPlane: {
    authority: "cli-ledger",
    commandAuth: [
      "coordinator signs every remote worker lease command",
      "worker mutations must echo the signed command dispatch id, job id, worker id, attempt, and budget reservation",
      "remote workers never mint leases, budgets, success decisions, or verifier authority"
    ],
    workerLease: [
      "leases are scoped to one run, one job, one worker id, and one attempt",
      "leases carry an absolute expiry and heartbeat TTL",
      "leases bind to a coordinator-owned budget reservation"
    ],
    heartbeat: [
      "heartbeats are accepted only before lease expiry",
      "stale leases are reconciled by the coordinator and retried or quarantined through the ledger"
    ],
    revocation: [
      "revoked worker ids, command ids, and dispatch ids fail closed",
      "a kill switch is represented as revocation plus coordinator cancellation of queued and leased jobs"
    ],
    idempotency: [
      "dispatch ids are idempotency keys for remote lease delivery",
      "duplicate dispatch with the same signed payload is a replayable no-op",
      "duplicate dispatch with different signed payload is rejected"
    ],
    replay: [
      "signed lease commands and accepted mutations must be persisted as artifacts/events before remote effects are trusted",
      "offline replay recomputes signatures, TTL decisions, revocation decisions, and idempotency decisions from persisted inputs"
    ],
    budgetOwnership: [
      "the CLI ledger owns all budget reservation, debit, release, and kill-switch decisions",
      "remote workers may spend only against the signed reservation id and cannot increase caps"
    ]
  }
};

export function assertWorkerLocalAiCallBoundary(input: WorkerLocalAiCallBoundaryInput): void {
  if ((input.scope ?? "standalone") !== "worker-local") return;
  if (!input.abortSignal) {
    throw new Error("Worker-local AI SDK calls must receive the scheduler AbortSignal.");
  }
  if (!input.persistsSteps) {
    throw new Error("Worker-local AI SDK calls must persist step-level traces.");
  }
  if (!input.usesExternalOperationOutbox) {
    throw new Error("Worker-local AI SDK calls must use the external operation outbox.");
  }
  if (!input.runId || !input.ledger || !input.schedulerLease) {
    throw new Error("Worker-local AI SDK calls require an active scheduler-owned lease.");
  }
  const job = input.ledger.requireWorkerJob(input.schedulerLease.jobId);
  if (job.runId !== input.runId) {
    throw new Error(`Worker-local AI SDK call lease job ${job.id} belongs to another run.`);
  }
  if (job.status !== "running") {
    throw new Error(`Worker-local AI SDK calls require an active running scheduler lease; job ${job.id} is ${job.status}.`);
  }
  if (job.leaseOwner !== input.schedulerLease.workerId) {
    throw new Error(`Worker-local AI SDK call lease owner mismatch for job ${job.id}.`);
  }
  if (job.attempts !== input.schedulerLease.attempt) {
    throw new Error(`Worker-local AI SDK call lease attempt mismatch for job ${job.id}.`);
  }
  if (!job.leaseExpiresAt) {
    throw new Error(`Worker-local AI SDK call lease is missing expiry for job ${job.id}.`);
  }
  if (Date.parse(job.leaseExpiresAt) <= Date.now()) {
    throw new Error(`Worker-local AI SDK call lease expired for job ${job.id}.`);
  }
}

export function attachAiSdkDynamicBoundaryContext<T extends object>(
  options: T,
  context: AiSdkDynamicBoundaryContext
): T {
  assertCompleteAiSdkDynamicBoundaryContext(context);
  Object.defineProperty(options, MATEMATICA_AI_SDK_BOUNDARY_CONTEXT, {
    value: context,
    enumerable: false,
    configurable: false,
    writable: false
  });
  return options;
}

export function getAiSdkDynamicBoundaryContext(options: unknown): AiSdkDynamicBoundaryContext | undefined {
  if (!options || typeof options !== "object") return undefined;
  return (options as Record<PropertyKey, unknown>)[MATEMATICA_AI_SDK_BOUNDARY_CONTEXT] as
    | AiSdkDynamicBoundaryContext
    | undefined;
}

export function assertAiSdkDynamicBoundaryContext(
  options: unknown,
  expected: AiSdkDynamicBoundaryAssertion = {}
): AiSdkDynamicBoundaryContext {
  const context = getAiSdkDynamicBoundaryContext(options);
  if (!context) {
    throw new Error("AI SDK call is missing Matematica dynamic boundary context.");
  }
  assertCompleteAiSdkDynamicBoundaryContext(context);
  const optionSignal = options && typeof options === "object"
    ? (options as { abortSignal?: AbortSignal }).abortSignal
    : undefined;
  if (!(optionSignal instanceof AbortSignal)) {
    throw new Error("AI SDK call is missing scheduler/provider AbortSignal on options.");
  }
  if (optionSignal !== context.abortSignal) {
    throw new Error("AI SDK boundary AbortSignal does not match the dispatched options.");
  }
  if (expected.schedulerLeaseRequired && !context.schedulerLease) {
    throw new Error("AI SDK worker-local boundary context is missing scheduler lease id.");
  }
  for (const [key, value] of Object.entries(expected) as [keyof AiSdkDynamicBoundaryAssertion, unknown][]) {
    if (key === "schedulerLeaseRequired" || value === undefined) continue;
    if (context[key as keyof AiSdkDynamicBoundaryContext] !== value) {
      throw new Error(`AI SDK dynamic boundary context mismatch for ${key}.`);
    }
  }
  return context;
}

function assertCompleteAiSdkDynamicBoundaryContext(context: AiSdkDynamicBoundaryContext): void {
  const requiredStringFields: (keyof AiSdkDynamicBoundaryContext)[] = [
    "format",
    "surface",
    "scope",
    "runId",
    "externalOperationId",
    "providerRuntimeLeaseId",
    "budgetReservationId",
    "requestArtifactId",
    "transcriptArtifactId",
    "provider",
    "modelId"
  ];
  for (const field of requiredStringFields) {
    if (typeof context[field] !== "string" || context[field].length === 0) {
      throw new Error(`AI SDK dynamic boundary context is missing ${field}.`);
    }
  }
  if (context.format !== "matematica.ai-sdk.dynamic-boundary-context") {
    throw new Error("AI SDK dynamic boundary context has an invalid format.");
  }
  if (context.schemaVersion !== 1) {
    throw new Error("AI SDK dynamic boundary context has an unsupported schema version.");
  }
  if (!(context.abortSignal instanceof AbortSignal)) {
    throw new Error("AI SDK dynamic boundary context is missing AbortSignal.");
  }
  if (!context.providerMetadata || typeof context.providerMetadata !== "object") {
    throw new Error("AI SDK dynamic boundary context is missing provider/model metadata.");
  }
  if (context.providerMetadata.requestedProvider !== context.provider) {
    throw new Error("AI SDK dynamic boundary provider metadata does not match provider.");
  }
  if (context.providerMetadata.requestedModel !== context.modelId) {
    throw new Error("AI SDK dynamic boundary provider metadata does not match model.");
  }
  if (context.scope === "worker-local") {
    if (!context.schedulerLease?.jobId) {
      throw new Error("AI SDK worker-local boundary context is missing scheduler lease id.");
    }
    if (!context.schedulerLease.workerId) {
      throw new Error("AI SDK worker-local boundary context is missing scheduler worker id.");
    }
    if (!Number.isInteger(context.schedulerLease.attempt) || context.schedulerLease.attempt <= 0) {
      throw new Error("AI SDK worker-local boundary context is missing scheduler lease attempt.");
    }
  }
}

export function classifyAiSdkSummaryEvidence(summary: unknown): AiSdkSummaryEvidenceDecision {
  void summary;
  return {
    canMarkGoalMet: false,
    evidenceGrade: "heuristic_evidence",
    reason: AI_SDK_SWARM_BOUNDARY_CONTRACT.evidencePolicy
  };
}

export function signRemoteWorkerLeaseCommand(
  input: RemoteWorkerLeaseCommandInput,
  signingKey: string
): RemoteWorkerLeaseCommand {
  const command: Omit<RemoteWorkerLeaseCommand, "signature"> = {
    ...input,
    commandType: "worker.lease",
    protocolVersion: 1
  };
  return {
    ...command,
    signature: signCanonical(command, signingKey)
  };
}

export function authorizeRemoteWorkerMutation(input: RemoteWorkerAuthorizationInput): RemoteWorkerAuthorizationDecision {
  const signature = signCanonical(unsignedCommand(input.command), input.signingKey);
  if (signature !== input.command.signature) {
    return { ok: false, reason: "remote worker command signature mismatch" };
  }
  if (input.command.budgetOwner !== "cli-ledger") {
    return { ok: false, reason: "remote worker command budget owner must be cli-ledger" };
  }
  if (!input.command.budgetReservationId) {
    return { ok: false, reason: "remote worker command missing budget reservation" };
  }
  const revoked = input.revocation;
  if (revoked?.revokedWorkerIds?.includes(input.command.workerId)) {
    return { ok: false, reason: "remote worker is revoked" };
  }
  if (revoked?.revokedCommandIds?.includes(input.command.commandId)) {
    return { ok: false, reason: "remote worker command is revoked" };
  }
  if (revoked?.revokedDispatchIds?.includes(input.command.dispatchId)) {
    return { ok: false, reason: "remote dispatch is revoked" };
  }
  const nowMs = Date.parse(input.now ?? new Date().toISOString());
  const leaseExpiresMs = Date.parse(input.command.leaseExpiresAt);
  if (!Number.isFinite(nowMs) || !Number.isFinite(leaseExpiresMs) || nowMs > leaseExpiresMs) {
    return { ok: false, reason: "remote worker lease is stale" };
  }
  if (input.command.dispatchId !== input.mutation.dispatchId) {
    return { ok: false, reason: "remote worker mutation dispatch mismatch" };
  }
  if (input.command.runId !== input.mutation.runId) {
    return { ok: false, reason: "remote worker mutation run mismatch" };
  }
  if (input.command.jobId !== input.mutation.jobId) {
    return { ok: false, reason: "remote worker mutation job mismatch" };
  }
  if (input.command.workerId !== input.mutation.workerId) {
    return { ok: false, reason: "remote worker mutation owner mismatch" };
  }
  if (input.command.attempt !== input.mutation.attempt) {
    return { ok: false, reason: "remote worker mutation attempt mismatch" };
  }
  if (input.mutation.budgetReservationId !== undefined && input.mutation.budgetReservationId !== input.command.budgetReservationId) {
    return { ok: false, reason: "remote worker mutation budget reservation mismatch" };
  }
  return { ok: true };
}

export function compareRemoteDispatchReplay(
  previous: RemoteWorkerLeaseCommand,
  incoming: RemoteWorkerLeaseCommand
): RemoteDispatchReplayDecision {
  if (previous.dispatchId !== incoming.dispatchId) {
    return { ok: true, duplicate: false };
  }
  const previousHash = remoteWorkerCommandHash(previous);
  const incomingHash = remoteWorkerCommandHash(incoming);
  if (previousHash !== incomingHash) {
    return {
      ok: false,
      duplicate: true,
      reason: "duplicate remote dispatch id has different signed payload"
    };
  }
  return { ok: true, duplicate: true };
}

export function remoteWorkerCommandHash(command: RemoteWorkerLeaseCommand): string {
  return createHash("sha256").update(canonicalJson(command)).digest("hex");
}

export function evaluateRemoteWorkerAttestation(
  attestation: RemoteWorkerCapabilityAttestation,
  requirement: RemoteWorkerCapabilityRequirement
): RemoteWorkerAttestationDecision {
  const issues: string[] = [];
  if (attestation.format !== "matematica.remote.worker.attestation") {
    issues.push("attestation format mismatch");
  }
  if (attestation.schemaVersion !== requirement.schemaVersion) {
    issues.push("attestation schema version mismatch");
  }
  if (attestation.protocolVersion !== requirement.protocolVersion) {
    issues.push("attestation protocol version mismatch");
  }
  if (attestation.cliVersion !== requirement.cliVersion) {
    issues.push("attestation CLI version mismatch");
  }
  if (attestation.networkMode !== requirement.networkMode) {
    issues.push("attestation network mode mismatch");
  }
  if (requirement.sandboxMode && attestation.sandboxMode !== requirement.sandboxMode) {
    issues.push("attestation sandbox mode mismatch");
  }
  if (attestation.budgetEnvelopeHash !== requirement.budgetEnvelopeHash) {
    issues.push("attestation budget envelope mismatch");
  }
  const providerSet = new Set(attestation.allowedProviders);
  for (const provider of requirement.requiredProviders) {
    if (!providerSet.has(provider)) {
      issues.push(`attestation missing required provider ${provider}`);
    }
  }
  if (requirement.requireLean4 === true && attestation.verifierToolchain.lean4 !== true) {
    issues.push("attestation missing Lean 4 verifier");
  }
  if (requirement.requireMathlib === true && attestation.verifierToolchain.mathlib !== true) {
    issues.push("attestation missing mathlib");
  }
  if (requirement.maxClockDriftMs !== undefined && requirement.now) {
    const observedAt = Date.parse(attestation.clock.observedAt);
    const expectedNow = Date.parse(requirement.now);
    if (!Number.isFinite(observedAt) || !Number.isFinite(expectedNow)) {
      issues.push("attestation clock timestamp invalid");
    } else if (Math.abs(expectedNow - observedAt) > requirement.maxClockDriftMs) {
      issues.push("attestation clock drift exceeds requirement");
    }
  }
  return {
    ok: issues.length === 0,
    issues
  };
}

export function persistRemoteWorkerAttestation(input: {
  runId: string;
  ledger: Ledger;
  artifacts: ArtifactStore;
  attestation: RemoteWorkerCapabilityAttestation;
  requirement: RemoteWorkerCapabilityRequirement;
}): PersistRemoteWorkerAttestationResult {
  const decision = evaluateRemoteWorkerAttestation(input.attestation, input.requirement);
  const attestationHash = remoteWorkerAttestationHash(input.attestation);
  const artifact = input.artifacts.create(input.runId, "remote.worker.attestation", JSON.stringify({
    attestation: input.attestation,
    requirement: input.requirement,
    decision,
    attestationHash
  }, null, 2));
  const event = input.ledger.appendEvent(input.runId, "remote.worker.attested", {
    workerId: input.attestation.workerId,
    ok: decision.ok,
    issues: decision.issues,
    artifactId: artifact.id,
    attestationHash,
    cliVersion: input.attestation.cliVersion,
    protocolVersion: input.attestation.protocolVersion,
    runtime: input.attestation.runtime,
    platform: input.attestation.platform,
    allowedProviders: input.attestation.allowedProviders,
    networkMode: input.attestation.networkMode,
    sandboxMode: input.attestation.sandboxMode,
    budgetEnvelopeHash: input.attestation.budgetEnvelopeHash,
    verifierToolchain: input.attestation.verifierToolchain,
    codeIdentity: input.attestation.codeIdentity
  }, [artifact.id]);
  return {
    ...decision,
    artifactId: artifact.id,
    attestationHash,
    eventId: event.id
  };
}

export function requireAcceptedRemoteWorkerAttestation(input: {
  events: LedgerEvent[];
  workerId: string;
}): RemoteWorkerAttestationDecision {
  const event = input.events.findLast((item) =>
    item.type === "remote.worker.attested" &&
    item.payload.workerId === input.workerId &&
    item.payload.ok === true
  );
  if (!event) {
    return {
      ok: false,
      issues: [`missing accepted remote worker attestation for ${input.workerId}`]
    };
  }
  return { ok: true, issues: [] };
}

export function remoteWorkerAttestationHash(attestation: RemoteWorkerCapabilityAttestation): string {
  return createHash("sha256").update(canonicalJson(attestation)).digest("hex");
}

function unsignedCommand(command: RemoteWorkerLeaseCommand): Omit<RemoteWorkerLeaseCommand, "signature"> {
  const { signature, ...unsigned } = command;
  void signature;
  return unsigned;
}

function signCanonical(value: unknown, signingKey: string): string {
  return createHmac("sha256", signingKey).update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortCanonical(value));
}

function sortCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortCanonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortCanonical(entry)])
  );
}
