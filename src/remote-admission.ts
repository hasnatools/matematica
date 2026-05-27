import { ArtifactStore } from "./artifacts";
import type { MatematicaConfig, ProviderName } from "./config";
import { emptyUsage, type BudgetHardCaps, type BudgetUsage } from "./budget";
import type { GoalRun, LedgerEvent } from "./domain";
import { stableHash } from "./idempotency";
import type { Ledger } from "./ledger";
import { remoteCostPreflight, type RemoteCostPreflightInput, type RemoteCostPreflight } from "./oss-safety";
import { isRemoteProvider } from "./privacy";
import {
  checkProviderLegalPrivacyGate,
  providerCapabilityByName,
  type ProviderLegalPrivacyGateCheck
} from "./provider-capabilities";
import { redactJson } from "./redaction";
import { providerCostReconciliation } from "./report";

export type RemoteComputeCommand = RemoteCostPreflightInput["command"] | "ai.generateText";

export type RemoteComputeAdmissionInput = {
  runId: string;
  ledger: Ledger;
  artifacts: ArtifactStore;
  command: RemoteComputeCommand;
  provider: ProviderName;
  modelId: string;
  localOnly: boolean;
  maxWorkers?: number;
  maxAttempts?: number;
  runMaxUsd?: number;
  runMaxTokens?: number;
  maxCallUsd?: number;
  maxOutputTokens?: number;
  providerTimeoutMs?: number;
  maxToolLoopStepsPerWorker?: number;
  maxProviderRetriesPerCall?: number;
  maxSubagentCallsPerStep?: number;
  maxToolCallsPerStep?: number;
  maxArxivCallsPerRun?: number;
  maxVerifierCallsPerRun?: number;
  budgetCaps?: BudgetHardCaps;
  explicitRemoteConsent: boolean;
  unledgeredCall?: boolean;
  providerAllowlist?: ProviderName[];
  now?: Date;
};

export type RemoteComputeAdmission = Omit<RemoteCostPreflight, "command"> & {
  command: RemoteComputeCommand;
  providerAllowlist: ProviderName[];
  providerAllowed: boolean;
  networkMode: "local-only" | "remote-provider-api";
  hardBudgetCapPresent: boolean;
  providerLegalPrivacy?: ProviderLegalPrivacyGateCheck;
  providerModelCatalog?: ReturnType<typeof providerCapabilityByName>["modelCatalog"];
  consentArtifactId?: string;
  envelopeArtifactId?: string;
  envelopeHash?: string;
  machineAdmissionReservationId?: string;
  machineAdmissionReused?: boolean;
  admissionEventId?: string;
  admissionArtifactIds?: string[];
};

export function admitRemoteCompute(input: RemoteComputeAdmissionInput): RemoteComputeAdmission {
  const remote = isRemoteProvider(input.provider);
  const run = input.ledger.requireRun(input.runId);
  const providerAllowlist = input.providerAllowlist ?? [input.provider];
  const providerAllowed = providerAllowlist.includes(input.provider);
  const hardBudgetCapPresent = hasHardBudgetCap(run, input);
  const providerCapabilities = providerCapabilityByName(input.provider, input.modelId);
  const providerLegalPrivacy = checkProviderLegalPrivacyGate({
    provider: input.provider,
    modelId: input.modelId,
    capabilities: providerCapabilities,
    now: input.now
  });
  const preflight = remoteCostPreflight({
    command: preflightCommand(input.command),
    provider: input.provider,
    modelId: input.modelId,
    localOnly: input.localOnly,
    maxWorkers: input.maxWorkers,
    maxAttempts: input.maxAttempts,
    runMaxUsd: input.runMaxUsd,
    runMaxTokens: input.runMaxTokens,
    maxCallUsd: input.maxCallUsd,
    maxOutputTokens: input.maxOutputTokens,
    providerTimeoutMs: input.providerTimeoutMs,
    maxToolLoopStepsPerWorker: input.maxToolLoopStepsPerWorker,
    maxProviderRetriesPerCall: input.maxProviderRetriesPerCall,
    maxSubagentCallsPerStep: input.maxSubagentCallsPerStep,
    maxToolCallsPerStep: input.maxToolCallsPerStep,
    maxArxivCallsPerRun: input.maxArxivCallsPerRun,
    maxVerifierCallsPerRun: input.maxVerifierCallsPerRun,
    runMaxWallTimeMs: run.budget.maxWallTimeMs,
    inFlightReservations: summarizeOpenReservations(input.ledger.listOpenBudgetReservations(input.runId)),
    explicitRemoteConsent: input.explicitRemoteConsent,
    unledgeredCall: input.unledgeredCall
  });
  const admission: RemoteComputeAdmission = {
    ...preflight,
    command: input.command,
    providerAllowlist,
    providerAllowed,
    networkMode: remote ? "remote-provider-api" : "local-only",
    hardBudgetCapPresent,
    providerLegalPrivacy,
    providerModelCatalog: providerCapabilities.modelCatalog
  };

  if (!remote) return admission;
  if (!providerLegalPrivacy.ok) {
    return persistAdmission(input, {
      ...admission,
      ok: false,
      reason: `Provider legal/privacy gate failed for ${input.provider}/${input.modelId}: ${providerLegalPrivacy.issues.join("; ")}.`
    });
  }
  const maxOutputTokens = providerCapabilities.modelCatalog.selected.maxOutputTokens;
  if (maxOutputTokens !== undefined && input.maxOutputTokens !== undefined && input.maxOutputTokens > maxOutputTokens) {
    return persistAdmission(input, {
      ...admission,
      ok: false,
      reason: `Requested max output tokens ${input.maxOutputTokens} exceed catalog limit ${maxOutputTokens} for ${input.provider}/${input.modelId}.`
    });
  }
  if (input.localOnly) {
    return persistAdmission(input, {
      ...admission,
      ok: false,
      reason: "Offline/local-only mode blocks remote provider compute."
    });
  }
  if (!providerAllowed) {
    return persistAdmission(input, {
      ...admission,
      ok: false,
      reason: `Remote provider ${input.provider} is not in the run provider allowlist.`
    });
  }
  if (!hardBudgetCapPresent) {
    return persistAdmission(input, {
      ...admission,
      ok: false,
      reason: "Remote compute requires a hard budget cap before the first external operation."
    });
  }
  if (admission.ok) {
    const spendReconciliation = checkPriorProviderSpendReconciliation(input);
    if (!spendReconciliation.ok) {
      return persistAdmission(input, {
        ...admission,
        ok: false,
        reason: spendReconciliation.reason
      });
    }
    const machineAdmission = input.ledger.reserveMachineAdmission({
      runId: input.runId,
      reserve: prospectiveRunReserve(admission),
      budgetCaps: input.budgetCaps,
      operationType: "remote.compute.admission",
      operationId: `${input.command}:${input.provider}:${input.modelId}`,
      provider: input.provider,
      modelId: input.modelId,
      command: input.command
    });
    if (!machineAdmission.ok) {
      return persistAdmission(input, {
        ...admission,
        ok: false,
        reason: machineAdmission.reason
      });
    }
    admission.machineAdmissionReservationId = machineAdmission.reservationId;
    admission.machineAdmissionReused = machineAdmission.reused === true;
  }
  return persistAdmission(input, admission);
}

function checkPriorProviderSpendReconciliation(input: RemoteComputeAdmissionInput): { ok: true } | { ok: false; reason: string } {
  const failedRows = providerCostReconciliation(input.runId, input.ledger)
    .filter((row) =>
      row.provider === input.provider &&
      row.modelId === input.modelId &&
      row.phase !== "preflight" &&
      row.reconciliation.issues.some((issue) =>
        issue.startsWith("observed_") ||
        issue === "missing_remote_cost_preflight_estimate" ||
        row.unknownOperations > 0 ||
        row.deadLetterOperations > 0
      )
    );
  if (failedRows.length === 0) return { ok: true };
  return {
    ok: false,
    reason: `Remote provider spend reconciliation failed for ${input.provider}/${input.modelId}: ${failedRows.map((row) => row.reconciliation.issues.join(", ")).join("; ")}.`
  };
}

export function assertRemoteComputeAdmitted(input: {
  runId: string;
  ledger: Ledger;
  provider: ProviderName;
  modelId: string;
}): RemoteComputeAdmission | undefined {
  if (!isRemoteProvider(input.provider)) return undefined;
  const admission = findLatestAdmission(input.ledger.listEvents(input.runId), input.provider, input.modelId);
  if (!admission) {
    throw new Error(`Remote compute admission missing for ${input.provider}/${input.modelId}; call admitRemoteCompute before the first external operation.`);
  }
  const payload = admission.payload as RemoteComputeAdmission;
  if (payload.ok !== true) {
    throw new Error(`Remote compute admission is not approved for ${input.provider}/${input.modelId}.`);
  }
  if (payload.providerAllowed !== true) {
    throw new Error(`Remote compute admission provider allowlist rejected ${input.provider}.`);
  }
  if (payload.hardBudgetCapPresent !== true) {
    throw new Error(`Remote compute admission is missing a hard budget cap for ${input.provider}/${input.modelId}.`);
  }
  if (payload.networkMode !== "remote-provider-api") {
    throw new Error(`Remote compute admission has invalid network mode for ${input.provider}/${input.modelId}.`);
  }
  if (!payload.providerLegalPrivacy?.ok) {
    throw new Error(`Remote compute admission is missing a passing provider legal/privacy gate for ${input.provider}/${input.modelId}.`);
  }
  if (typeof payload.consentArtifactId !== "string" || !admission.artifactIds.includes(payload.consentArtifactId)) {
    throw new Error(`Remote compute admission is missing a persisted consent artifact for ${input.provider}/${input.modelId}.`);
  }
  if (typeof payload.envelopeArtifactId !== "string" || !admission.artifactIds.includes(payload.envelopeArtifactId)) {
    throw new Error(`Remote compute admission is missing a persisted swarm budget envelope for ${input.provider}/${input.modelId}.`);
  }
  if (payload.envelopeHash !== stableHash(payload.envelope)) {
    throw new Error(`Remote compute admission envelope hash does not match persisted envelope for ${input.provider}/${input.modelId}.`);
  }
  return {
    ...payload,
    admissionEventId: admission.id,
    admissionArtifactIds: admission.artifactIds
  };
}

export function hasApprovedRemoteComputeAdmission(input: {
  runId: string;
  ledger: Ledger;
  provider: ProviderName;
  modelId: string;
}): boolean {
  try {
    assertRemoteComputeAdmitted(input);
    return true;
  } catch {
    return false;
  }
}

function persistAdmission(
  input: RemoteComputeAdmissionInput,
  admission: RemoteComputeAdmission
): RemoteComputeAdmission {
  const envelopeHash = stableHash(admission.envelope);
  const envelopeArtifact = input.artifacts.create(input.runId, "swarm.budget.envelope", JSON.stringify(redactJson(admission.envelope), null, 2));
  const artifact = input.artifacts.create(input.runId, "remote.compute.consent", JSON.stringify(redactJson({
    command: admission.command,
    provider: admission.provider,
    modelId: admission.modelId,
    remote: admission.remote,
    byok: admission.byok,
    bundledCompute: admission.bundledCompute,
    providerAllowlist: admission.providerAllowlist,
    providerAllowed: admission.providerAllowed,
    networkMode: admission.networkMode,
    hardBudgetCapPresent: admission.hardBudgetCapPresent,
    providerLegalPrivacy: admission.providerLegalPrivacy,
    providerModelCatalog: admission.providerModelCatalog,
    envelopeHash,
    confirmedEnvelopeHash: admission.explicitRemoteConsent ? envelopeHash : undefined,
    explicitRemoteConsent: admission.explicitRemoteConsent,
    unledgeredCall: admission.unledgeredCall,
    maxWorkers: admission.maxWorkers,
    maxAttempts: admission.maxAttempts,
    runMaxUsd: admission.runMaxUsd,
    runMaxTokens: admission.runMaxTokens,
    maxCallUsd: admission.maxCallUsd,
    maxOutputTokens: admission.maxOutputTokens,
    estimate: admission.estimate,
    envelopeArtifactId: envelopeArtifact.id,
    machineAdmissionReservationId: admission.machineAdmissionReservationId,
    machineAdmissionReused: admission.machineAdmissionReused,
    ok: admission.ok,
    reason: admission.reason,
    warning: admission.warning
  }), null, 2));
  const persisted = { ...admission, consentArtifactId: artifact.id, envelopeArtifactId: envelopeArtifact.id, envelopeHash };
  input.ledger.appendEvent(input.runId, "remote.cost.preflight", persisted, [envelopeArtifact.id, artifact.id]);
  return persisted;
}

function findLatestAdmission(
  events: Array<LedgerEvent<Record<string, unknown>>>,
  provider: ProviderName,
  modelId: string
): LedgerEvent<Record<string, unknown>> | undefined {
  return events
    .filter((event) =>
      event.type === "remote.cost.preflight" &&
      event.payload.provider === provider &&
      event.payload.modelId === modelId &&
      event.payload.remote === true
    )
    .at(-1);
}

function summarizeOpenReservations(reservations: ReturnType<Ledger["listOpenBudgetReservations"]>): BudgetUsage & { count: number } {
  return reservations.reduce<BudgetUsage & { count: number }>((usage, reservation) => ({
    attempts: usage.attempts + reservation.reserve.attempts,
    tokens: usage.tokens + reservation.reserve.tokens,
    usd: usage.usd + reservation.reserve.usd,
    elapsedMs: usage.elapsedMs + reservation.reserve.elapsedMs,
    artifactBytes: usage.artifactBytes + reservation.reserve.artifactBytes,
    sourceQueries: usage.sourceQueries + reservation.reserve.sourceQueries,
    retries: usage.retries + reservation.reserve.retries,
    sandboxMs: usage.sandboxMs + reservation.reserve.sandboxMs,
    count: usage.count + 1
  }), { ...emptyUsage(), count: 0 });
}

function prospectiveProviderReserve(admission: RemoteComputeAdmission): BudgetUsage {
  return {
    attempts: admission.envelope.aiSdkToolLoop.maxProviderCalls,
    tokens: prospectiveValue(admission.envelope.upperBounds.tokens, admission.envelope.inFlightReservations.tokens),
    usd: prospectiveValue(admission.envelope.upperBounds.usd, admission.envelope.inFlightReservations.usd),
    elapsedMs: prospectiveValue(admission.envelope.upperBounds.wallTimeMs, admission.envelope.inFlightReservations.elapsedMs),
    artifactBytes: prospectiveValue(undefined, admission.envelope.inFlightReservations.artifactBytes),
    sourceQueries: prospectiveValue(undefined, admission.envelope.inFlightReservations.sourceQueries),
    retries: prospectiveValue(undefined, admission.envelope.inFlightReservations.retries),
    sandboxMs: prospectiveValue(undefined, admission.envelope.inFlightReservations.sandboxMs)
  };
}

function prospectiveRunReserve(admission: RemoteComputeAdmission): BudgetUsage {
  return {
    ...prospectiveProviderReserve(admission),
    attempts: prospectiveValue(admission.envelope.upperBounds.attempts, admission.envelope.inFlightReservations.attempts)
  };
}

function prospectiveValue(total: number | undefined, alreadyReserved: number): number {
  if (total === undefined) return 0;
  return Math.max(0, total - alreadyReserved);
}

function hasHardBudgetCap(run: GoalRun, input: RemoteComputeAdmissionInput): boolean {
  return (
    run.budget.maxAttempts !== undefined ||
    run.budget.maxWorkers !== undefined ||
    run.budget.maxWallTimeMs !== undefined ||
    run.budget.maxUsd !== undefined ||
    run.budget.maxTokens !== undefined ||
    input.maxCallUsd !== undefined ||
    input.maxOutputTokens !== undefined
  );
}

function preflightCommand(command: RemoteComputeCommand): RemoteCostPreflightInput["command"] {
  return command === "ai.generateText" ? "goal run" : command;
}
