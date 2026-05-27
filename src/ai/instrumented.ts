import { generateText, type LanguageModel } from "ai";
import { ArtifactStore } from "../artifacts";
import type { BudgetDimension, BudgetHardCaps, BudgetUsage } from "../budget";
import type { ProviderName } from "../config";
import { makeId, type Artifact } from "../domain";
import { externalOperationIdempotencyKey, stableHash } from "../idempotency";
import { providerPrivacy } from "../privacy";
import type { ExternalOperation, Ledger } from "../ledger";
import {
  assertProviderLegalPrivacyGate,
  assertNoSilentModelSubstitution,
  ensureProviderRoutePinned,
  providerCapabilityByName,
  type ProviderRequiredCapabilities
} from "../provider-capabilities";
import { prepareProviderEgress, type ProviderEgressCheck } from "../provider-egress";
import { checkProviderPricing, settleUsdUsage, type ProviderPricingCheck } from "../provider-pricing";
import {
  classifyProviderError,
  normalizeProviderResiliencePolicy,
  providerRetryDecision,
  type ProviderFailureClassification,
  type ProviderResilienceSettings
} from "../provider-resilience";
import { redactJson, redactText } from "../redaction";
import { assertRemoteComputeAdmitted, type RemoteComputeAdmission } from "../remote-admission";
import { readArtifactText } from "../storage-encryption";
import {
  assertAiSdkDynamicBoundaryContext,
  assertWorkerLocalAiCallBoundary,
  attachAiSdkDynamicBoundaryContext,
  type AiSdkCallScope,
  type WorkerLocalAiCallLease
} from "../swarm-boundary";

export type AiSdkLoopControlSettings = {
  stopWhen?: string;
  maxSteps?: number;
  maxSubagentCalls?: number;
  maxProviderRetriesPerCall?: number;
};

export type InstrumentedTextCall = {
  runId: string;
  ledger: Ledger;
  artifacts: ArtifactStore;
  provider: ProviderName;
  modelId: string;
  model: LanguageModel;
  prompt: string;
  scope?: AiSdkCallScope;
  settings?: {
    temperature?: number;
    maxOutputTokens?: number;
    maxUsd?: number;
    budgetCaps?: BudgetHardCaps;
    resilience?: ProviderResilienceSettings;
    abortSignal?: AbortSignal;
    timeout?: number;
    aiSdkLoop?: AiSdkLoopControlSettings;
  };
  requiredCapabilities?: ProviderRequiredCapabilities;
  idempotencyKey?: string;
  retryOfOperationId?: string;
  generate?: GenerateTextFunction;
  schedulerLease?: WorkerLocalAiCallLease;
  tools?: Record<string, unknown>;
};

export type InstrumentedTextResult = {
  text: string;
  usage: Record<string, unknown>;
  finishReason?: string;
  requestArtifactId: string;
  responseArtifactId: string;
  transcriptArtifactId?: string;
  stepArtifactIds: string[];
  streamChunkArtifactIds: string[];
  externalOperationId: string;
  replayedFromOutbox: boolean;
};

export type GenerateTextFunction = (options: {
  model: LanguageModel;
  prompt: string;
  temperature?: number;
  maxOutputTokens?: number;
  abortSignal?: AbortSignal;
  timeout?: number;
  onStepFinish?: (step: unknown) => void | Promise<void>;
  tools?: Record<string, unknown>;
}) => Promise<{
  text: string;
  usage?: unknown;
  finishReason?: string;
  providerMetadata?: unknown;
  steps?: unknown[];
  streamChunks?: unknown[];
  stopCondition?: unknown;
  toolCalls?: unknown[];
  toolResults?: unknown[];
}>;

export async function generateInstrumentedText(call: InstrumentedTextCall): Promise<InstrumentedTextResult> {
  assertWorkerLocalAiCallBoundary({
    runId: call.runId,
    ledger: call.ledger,
    scope: call.scope,
    abortSignal: call.settings?.abortSignal,
    persistsSteps: true,
    usesExternalOperationOutbox: true,
    schedulerLease: call.schedulerLease
  });
  const run = call.ledger.requireRun(call.runId);
  const remoteAdmission = assertRemoteComputeAdmitted({
    runId: call.runId,
    ledger: call.ledger,
    provider: call.provider,
    modelId: call.modelId
  });
  const loopControl = normalizeAiSdkLoopControl(call, remoteAdmission);
  const budgetPreflight = makeAiCallBudgetPreflight({
    prompt: call.prompt,
    maxOutputTokens: call.settings?.maxOutputTokens,
    maxUsd: call.settings?.maxUsd,
    runMaxUsd: run.budget.maxUsd
  });
  const privacy = providerPrivacy(call.provider);
  const requestSettings = providerRequestSettings(call.settings);
  const requestCapabilities = providerCapabilityByName(call.provider, call.modelId);
  const legalPrivacy = assertProviderLegalPrivacyGate({
    provider: call.provider,
    modelId: call.modelId,
    capabilities: requestCapabilities
  });
  call.ledger.appendEvent(call.runId, "provider.legal_privacy.checked", legalPrivacy);
  const legalPrivacyRequestProof = stableProviderLegalPrivacyProof(legalPrivacy);
  const providerMatrixPin = ensureProviderRoutePinned({
    runId: call.runId,
    ledger: call.ledger,
    artifacts: call.artifacts,
    provider: call.provider,
    modelId: call.modelId,
    requiredCapabilities: call.requiredCapabilities
  });
  const pricing = checkProviderPricing({
    provider: call.provider,
    modelId: call.modelId,
    capabilities: requestCapabilities,
    maxUsd: call.settings?.maxUsd
  });
  call.ledger.appendEvent(call.runId, "provider.pricing.checked", pricing);
  if (!pricing.ok) {
    throw new Error(pricing.reason ?? `Provider pricing check failed for ${call.provider}/${call.modelId}.`);
  }
  const egress = prepareProviderEgress({
    provider: call.provider,
    modelId: call.modelId,
    prompt: call.prompt,
    settings: requestSettings
  });
  if (!egress.ok) {
    throw new Error(`Provider egress blocked for ${call.provider}/${call.modelId}: ledger internals are not allowed in remote provider prompts.`);
  }
  const requestPayload = {
    provider: call.provider,
    modelId: call.modelId,
    scope: call.scope ?? "standalone",
    prompt: egress.sanitizedPrompt,
    settings: requestSettings,
    fallbackPolicy: {
      automaticProviderFallback: false,
      reason: "Provider fallback is disabled unless a future explicit routing policy records the chosen alternate provider before execution."
    },
    providerMatrix: {
      eventId: providerMatrixPin.eventId,
      artifactId: providerMatrixPin.artifactId,
      matrixHash: providerMatrixPin.matrixHash,
      requiredCapabilities: call.requiredCapabilities ?? providerMatrixPin.snapshot.requiredCapabilities
    },
    budgetPreflight,
    pricing,
    aiSdkLoopControl: loopControl.requestSummary,
    tools: call.tools ? {
      names: Object.keys(call.tools).sort(),
      executeFunctionsStayLocal: true,
      modelVisibleToolOutputCountsAsEvidence: false
    } : undefined,
    legalPrivacy: legalPrivacyRequestProof,
    privacy
  };
  const requestHash = stableHash(requestPayload);
  const callId = call.idempotencyKey ?? externalOperationIdempotencyKey({
    runId: call.runId,
    operationType: "ai.generateText",
    requestHash,
    retryOfOperationId: call.retryOfOperationId
  });
  const startedAt = Date.now();
  const reserve = budgetPreflight.reserve;
  const requestArtifact = call.artifacts.create(call.runId, "ai.request", JSON.stringify({
    callId,
    requestHash,
    ...requestPayload
  }, null, 2));

  const prepared = call.ledger.prepareExternalOperation({
    runId: call.runId,
    operationType: "ai.generateText",
    provider: call.provider,
    idempotencyKey: callId,
    requestHash,
    reserve,
    budgetCaps: call.settings?.budgetCaps,
    requestArtifactId: requestArtifact.id,
    remoteAdmissionEventId: remoteAdmission?.admissionEventId,
    admissionArtifactIds: remoteAdmission?.admissionArtifactIds,
    requiresRemoteAdmission: remoteAdmission?.remote === true,
    retryOfOperationId: call.retryOfOperationId
  });
  if (!prepared.ok) {
    throw new Error(`Budget exhausted before AI call: ${prepared.reason}`);
  }
  if (!prepared.created) {
    if (prepared.operation.status === "succeeded" && prepared.operation.responseArtifactId) {
      return cachedInstrumentedTextResult(prepared.operation, call.ledger);
    }
    throw new Error(`External operation ${prepared.operation.id} already exists in status ${prepared.operation.status}; refusing duplicate provider call.`);
  }
  const operation = call.ledger.startExternalOperation(prepared.operation.id);
  const transcriptPlanArtifact = persistAiTranscriptPlan({
    runId: call.runId,
    callId,
    externalOperationId: operation.id,
    ledger: call.ledger,
    artifacts: call.artifacts,
    provider: call.provider,
    modelId: call.modelId,
    scope: call.scope ?? "standalone",
    budgetReservationId: operation.reservationId,
    requestArtifactId: requestArtifact.id,
    requestHash,
    schedulerLease: call.schedulerLease
  });
  const stepArtifactIds: string[] = [];
  const streamChunkArtifactIds: string[] = [];
  const capturedStepFingerprints = new Set<string>();

  call.ledger.appendEvent(call.runId, "ai.call.started", {
    callId,
    externalOperationId: operation.id,
    scope: call.scope ?? "standalone",
    provider: call.provider,
    modelId: call.modelId,
    settings: requestSettings,
    fallbackPolicy: requestPayload.fallbackPolicy,
    providerMatrix: requestPayload.providerMatrix,
    privacy,
    reservationId: operation.reservationId,
    transcriptPlanArtifactId: transcriptPlanArtifact.id,
    requestArtifactId: requestArtifact.id,
    requestHash
  }, [requestArtifact.id, transcriptPlanArtifact.id]);
  const loopControlRuntime = persistAiSdkLoopControl({
    call,
    operationId: operation.id,
    callId,
    requestHash,
    requestArtifactId: requestArtifact.id,
    loopControl
  });
  if (privacy.remote) {
    call.ledger.appendEvent(call.runId, "privacy.remote_provider.used", {
      callId,
      externalOperationId: operation.id,
      provider: call.provider,
      modelId: call.modelId,
      scope: call.scope ?? "standalone",
      explicitRemoteUse: privacy.explicitRemoteUse,
      promptPersistence: privacy.promptPersistence,
      responsePersistence: privacy.responsePersistence,
      requestArtifactId: requestArtifact.id,
      requestHash
    }, [requestArtifact.id]);
  }

  try {
    const generate = call.generate ?? defaultGenerateText;
    const result = await generateTextWithProviderResilience({
      call,
      egress,
      egressPrompt: egress.sanitizedPrompt,
      operation,
      callId,
      requestArtifactId: requestArtifact.id,
      transcriptPlanArtifactId: transcriptPlanArtifact.id,
      requestHash,
      retryReserve: reserve,
      generate,
      remoteAdmission,
      loopControl: loopControlRuntime,
      startedAt,
      stepArtifactIds,
      streamChunkArtifactIds,
      capturedStepFingerprints
    });
    const latencyMs = Date.now() - startedAt;
    const usage = usageToRecord(result.usage);
    const tokenUsage = tokenUsageFromRecord(usage);
    if (tokenUsage <= 0) {
      throw new Error("AI provider response did not include token usage; refusing to settle without usage.");
    }
    const usageAccounting = providerUsageAccountingFloor(usage);
    if (usageAccounting.underreported) {
      throw new ProviderAccountingFraudError(
        `AI provider returned underreported usage: totalTokens=${usageAccounting.reportedTotalTokens} is below input/output token floor ${usageAccounting.minimumActualTokens}.`,
        {
          attempts: 1,
          tokens: Math.max(usageAccounting.minimumActualTokens, reserve.tokens),
          usd: reserve.usd,
          elapsedMs: Math.max(1, latencyMs)
        }
      );
    }
    const redactedText = redactText(result.text);
    const providerMetadata = redactJson(result.providerMetadata ?? {});
    const providerMetadataHash = stableHash(providerMetadata);
    const capabilities = providerCapabilityByName(call.provider, call.modelId, providerMetadata);
    assertNoSilentModelSubstitution({
      provider: call.provider,
      requestedModel: call.modelId,
      capabilities
    });
    const postCallPricing = checkProviderPricing({
      provider: call.provider,
      modelId: call.modelId,
      capabilities,
      maxUsd: call.settings?.maxUsd,
      expectedPricingHash: pricing.pricingHash
    });
    if (!postCallPricing.ok) {
      call.ledger.appendEvent(call.runId, "provider.pricing.checked", {
        ...postCallPricing,
        postCall: true,
        inFlightSettlementPolicy: "debit_higher_of_actual_or_operator_cap"
      });
    }
    const providerProvenance = {
      requestedProvider: call.provider,
      requestedModel: call.modelId,
      actualUpstreamProvider: capabilities.actualUpstreamProvider ?? call.provider,
      actualUpstreamModel: capabilities.actualUpstreamModel ?? call.modelId,
      providerMetadataHash,
      pricingSource: pricing.costSource.source,
      pricingHash: pricing.pricingHash,
      silentFallbackAllowed: false
    };
    const usdUsage = usdUsageFromResult(usage, providerMetadata);
    const usdSettlement = settleUsdUsage({
      actualUsd: usdUsage,
      pricing,
      reserve,
      pricingDrifted: !postCallPricing.ok
    });
    if (tokenUsage > budgetPreflight.reservedTokens) {
      throw new UsageReservationExceededError(
        `AI provider used ${tokenUsage} tokens, exceeding reserved token budget ${budgetPreflight.reservedTokens}.`,
        {
          attempts: 1,
          tokens: tokenUsage,
          usd: usdSettlement.usd,
          elapsedMs: Math.max(1, latencyMs)
        }
      );
    }
    if (budgetPreflight.reservedUsd !== undefined && usdSettlement.usd > budgetPreflight.reservedUsd) {
      throw new UsageReservationExceededError(
        `AI provider used $${usdSettlement.usd}, exceeding reserved USD budget $${budgetPreflight.reservedUsd}.`,
        {
          attempts: 1,
          tokens: tokenUsage,
          usd: usdSettlement.usd,
          elapsedMs: Math.max(1, latencyMs)
        }
      );
    }
    for (const step of Array.isArray(result.steps) ? result.steps : []) {
      const fingerprint = stableHash(redactJson(step));
      if (capturedStepFingerprints.has(fingerprint)) continue;
      const stepArtifactId = persistAiStepTrace({
        runId: call.runId,
        callId,
        externalOperationId: operation.id,
        ledger: call.ledger,
        artifacts: call.artifacts,
        step,
        stepIndex: stepArtifactIds.length,
        source: "result.steps",
        startedAt
      });
      stepArtifactIds.push(stepArtifactId);
      capturedStepFingerprints.add(fingerprint);
      recordAiSdkLoopStep(loopControlRuntime, {
        step,
        stepArtifactId
      });
    }
    for (const [chunkIndex, chunk] of (Array.isArray(result.streamChunks) ? result.streamChunks : []).entries()) {
      streamChunkArtifactIds.push(persistAiStreamChunkTrace({
        runId: call.runId,
        callId,
        externalOperationId: operation.id,
        ledger: call.ledger,
        artifacts: call.artifacts,
        chunk,
        chunkIndex,
        startedAt
      }));
    }
    enforceAiSdkLoopTerminalResult(loopControlRuntime, result);
    const responseArtifact = call.artifacts.create(call.runId, "ai.response", JSON.stringify({
      callId,
      externalOperationId: operation.id,
      scope: call.scope ?? "standalone",
      text: redactedText,
      usage,
      finishReason: result.finishReason,
      providerMetadata,
      providerMetadataHash,
      providerProvenance,
      capabilities,
      providerMatrix: requestPayload.providerMatrix,
      budgetPreflight,
      pricing,
      legalPrivacy: legalPrivacyRequestProof,
      usdSettlement,
      privacy,
      stepArtifactIds,
      streamChunkArtifactIds,
      stopCondition: redactJson(result.stopCondition ?? result.finishReason ?? null),
      toolCalls: redactJson(result.toolCalls ?? []),
      toolResults: redactJson(result.toolResults ?? [])
    }, null, 2));
    const transcriptArtifact = persistAiTranscript({
      runId: call.runId,
      callId,
      externalOperationId: operation.id,
      ledger: call.ledger,
      artifacts: call.artifacts,
      provider: call.provider,
      modelId: call.modelId,
      status: "completed",
      requestArtifact,
      responseArtifact,
      stepArtifactIds,
      streamChunkArtifactIds,
      settings: requestSettings,
      budgetPreflight,
      pricing,
      privacy,
      usage,
      finishReason: result.finishReason,
      stopCondition: result.stopCondition ?? result.finishReason,
      toolCalls: result.toolCalls ?? [],
      toolResults: result.toolResults ?? []
    });

    call.ledger.appendEvent(call.runId, "ai.call.completed", {
      callId,
      externalOperationId: operation.id,
      scope: call.scope ?? "standalone",
      provider: call.provider,
      modelId: call.modelId,
      latencyMs,
      usage,
      finishReason: result.finishReason,
      capabilities,
      providerMetadataHash,
      providerProvenance,
      providerMatrix: requestPayload.providerMatrix,
      budgetPreflight,
      pricing,
      usdSettlement,
      privacy,
      stepArtifactIds,
      streamChunkArtifactIds,
      transcriptArtifactId: transcriptArtifact.id,
      toolCallCount: Array.isArray(result.toolCalls) ? result.toolCalls.length : undefined,
      toolResultCount: Array.isArray(result.toolResults) ? result.toolResults.length : undefined,
      requestArtifactId: requestArtifact.id,
      responseArtifactId: responseArtifact.id,
      reservationId: operation.reservationId,
      requestHash
    }, [requestArtifact.id, responseArtifact.id, transcriptArtifact.id, ...stepArtifactIds, ...streamChunkArtifactIds]);
    call.ledger.completeExternalOperation({
      operationId: operation.id,
      responseArtifactId: responseArtifact.id,
      debit: {
        attempts: 1,
        tokens: tokenUsage,
        usd: usdSettlement.usd,
        elapsedMs: Math.max(1, latencyMs)
      },
      overReservationPolicy: {
        allowedDimensions: ["elapsedMs"],
        reason: "Provider success debits measured elapsed time above the minimum preflight estimate."
      },
      provider: call.provider
    });

    return {
      text: redactedText,
      usage,
      finishReason: result.finishReason,
      requestArtifactId: requestArtifact.id,
      responseArtifactId: responseArtifact.id,
      transcriptArtifactId: transcriptArtifact.id,
      stepArtifactIds,
      streamChunkArtifactIds,
      externalOperationId: operation.id,
      replayedFromOutbox: false
    };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const classification = classifyProviderError(error);
    const errorArtifact = call.artifacts.create(call.runId, "ai.error", JSON.stringify({
      callId,
      externalOperationId: operation.id,
      scope: call.scope ?? "standalone",
      errorName: error instanceof Error ? error.name : "UnknownError",
      errorMessage: redactText(error instanceof Error ? error.message : String(error)),
      providerFailure: classification,
      aborted: isAbortError(error),
      stepArtifactIds
    }, null, 2));
    const transcriptArtifact = persistAiTranscript({
      runId: call.runId,
      callId,
      externalOperationId: operation.id,
      ledger: call.ledger,
      artifacts: call.artifacts,
      provider: call.provider,
      modelId: call.modelId,
      status: isAbortError(error) ? "aborted" : "failed",
      requestArtifact,
      errorArtifact,
      stepArtifactIds,
      streamChunkArtifactIds,
      settings: requestSettings,
      budgetPreflight,
      pricing,
      privacy,
      providerFailure: classification,
      errorName: error instanceof Error ? error.name : "UnknownError",
      errorMessage: error instanceof Error ? error.message : String(error)
    });
    const settlement = failureSettlement(error, reserve, Math.max(1, latencyMs));
    const cancellationSettlement = hasNonZeroBudgetUsage(settlement.debit)
      ? "debited"
      : "released";
    call.ledger.failExternalOperation({
      operationId: operation.id,
      errorMessage: error instanceof Error ? error.message : String(error),
      debit: settlement.debit,
      overReservationPolicy: settlement.overReservationPolicy,
      releaseReason: settlement.releaseReason,
      provider: call.provider
    });
    call.ledger.appendEvent(call.runId, "ai.call.failed", {
      callId,
      externalOperationId: operation.id,
      scope: call.scope ?? "standalone",
      provider: call.provider,
      modelId: call.modelId,
      latencyMs,
      errorName: error instanceof Error ? error.name : "UnknownError",
      errorMessage: redactText(error instanceof Error ? error.message : String(error)),
      providerFailure: classification,
      aborted: isAbortError(error),
      providerMatrix: requestPayload.providerMatrix,
      budgetPreflight,
      pricing,
      privacy,
      reservationId: operation.reservationId,
      requestArtifactId: requestArtifact.id,
      requestHash,
      errorArtifactId: errorArtifact.id,
      transcriptArtifactId: transcriptArtifact.id,
      stepArtifactIds,
      cancellationSettlement
    }, [requestArtifact.id, errorArtifact.id, transcriptArtifact.id, ...stepArtifactIds, ...streamChunkArtifactIds]);
    if (isAbortError(error)) {
      call.ledger.appendEvent(call.runId, "ai.call.aborted", {
        callId,
        externalOperationId: operation.id,
        provider: call.provider,
        modelId: call.modelId,
        latencyMs,
        errorArtifactId: errorArtifact.id,
        transcriptArtifactId: transcriptArtifact.id,
        stepArtifactIds,
        streamChunkArtifactIds,
        cancellationSettlement
      }, [requestArtifact.id, errorArtifact.id, transcriptArtifact.id, ...stepArtifactIds, ...streamChunkArtifactIds]);
    }
    if (error instanceof Error) {
      throw new Error(redactText(error.message), { cause: error });
    }
    throw new Error(redactText(String(error)));
  }
}

export function estimatePromptTokens(prompt: string): number {
  return Math.max(1, Math.ceil(prompt.length / 4));
}

type AiSdkLoopControlPolicy = {
  required: boolean;
  scope: AiSdkCallScope;
  stopWhen?: string;
  maxSteps?: number;
  maxSubagentCalls?: number;
  maxProviderRetriesPerCall?: number;
  abortSignalRequired: boolean;
  schedulerLeaseRequired: boolean;
  toolApprovalsTrustedForSafety: false;
  allowedTools?: string[];
  source: string[];
  workerLease?: WorkerLocalAiCallLease;
};

type AiSdkLoopControlRuntime = {
  policy: AiSdkLoopControlPolicy;
  artifactId?: string;
  call: InstrumentedTextCall;
  callId: string;
  externalOperationId: string;
  requestHash: string;
  requestArtifactId: string;
  stepCount: number;
  subagentCallCount: number;
  violationRecorded: boolean;
};

function normalizeAiSdkLoopControl(
  call: InstrumentedTextCall,
  remoteAdmission: RemoteComputeAdmission | undefined
): { policy: AiSdkLoopControlPolicy; requestSummary?: Record<string, unknown> } {
  const scope = call.scope ?? "standalone";
  const settings = call.settings?.aiSdkLoop;
  const required = scope === "worker-local" || settings !== undefined;
  const source = [
    settings ? "call.settings.aiSdkLoop" : undefined,
    remoteAdmission ? "remote.compute.admission.envelope.aiSdkToolLoop" : undefined,
    scope === "worker-local" ? "worker-local-defaults" : undefined
  ].filter((item): item is string => Boolean(item));
  const maxSteps = finiteControlInteger(settings?.maxSteps);
  const remoteSubagentLimit = remoteAdmission && maxSteps !== undefined
    ? remoteAdmission.envelope.aiSdkToolLoop.maxSubagentCallsPerStep * maxSteps
    : undefined;
  const maxSubagentCalls = finiteNonNegativeControlInteger(settings?.maxSubagentCalls)
    ?? remoteSubagentLimit
    ?? (scope === "worker-local" ? 0 : undefined);
  const maxProviderRetriesPerCall = finiteNonNegativeControlInteger(settings?.maxProviderRetriesPerCall)
    ?? remoteAdmission?.envelope.aiSdkToolLoop.maxProviderRetriesPerCall
    ?? (scope === "worker-local" ? 0 : undefined);
  const policy: AiSdkLoopControlPolicy = {
    required,
    scope,
    stopWhen: settings?.stopWhen,
    maxSteps,
    maxSubagentCalls,
    maxProviderRetriesPerCall,
    abortSignalRequired: scope === "worker-local",
    schedulerLeaseRequired: scope === "worker-local",
    toolApprovalsTrustedForSafety: false,
    allowedTools: call.tools ? Object.keys(call.tools).sort() : undefined,
    source,
    workerLease: call.schedulerLease
  };
  return {
    policy,
    requestSummary: required ? aiSdkLoopControlSummary(policy) : undefined
  };
}

function persistAiSdkLoopControl(input: {
  call: InstrumentedTextCall;
  operationId: string;
  callId: string;
  requestHash: string;
  requestArtifactId: string;
  loopControl: { policy: AiSdkLoopControlPolicy };
}): AiSdkLoopControlRuntime | undefined {
  if (!input.loopControl.policy.required) return undefined;
  const artifact = input.call.artifacts.create(input.call.runId, "ai.sdk.loop_control", JSON.stringify({
    format: "matematica.ai-sdk-loop-control",
    version: 1,
    authority: "cli-ledger",
    callId: input.callId,
    externalOperationId: input.operationId,
    requestHash: input.requestHash,
    policy: input.loopControl.policy,
    enforcement: {
      stopWhenEnforcedByLedger: Boolean(input.loopControl.policy.stopWhen),
      stepLimitEnforcedByLedger: input.loopControl.policy.maxSteps !== undefined,
      subagentCallLimitEnforcedByLedger: input.loopControl.policy.maxSubagentCalls !== undefined,
      retryLimitEnforcedByLedger: input.loopControl.policy.maxProviderRetriesPerCall !== undefined,
      abortSignalRequired: input.loopControl.policy.abortSignalRequired,
      schedulerLeaseRequired: input.loopControl.policy.schedulerLeaseRequired,
      toolApprovalsTrustedForSafety: false
    }
  }, null, 2));
  input.call.ledger.appendEvent(input.call.runId, "ai.sdk.loop_control.checked", {
    ok: true,
    phase: "preflight",
    callId: input.callId,
    externalOperationId: input.operationId,
    scope: input.loopControl.policy.scope,
    requestHash: input.requestHash,
    artifactId: artifact.id,
    policy: aiSdkLoopControlSummary(input.loopControl.policy)
  }, [input.requestArtifactId, artifact.id]);
  return {
    policy: input.loopControl.policy,
    artifactId: artifact.id,
    call: input.call,
    callId: input.callId,
    externalOperationId: input.operationId,
    requestHash: input.requestHash,
    requestArtifactId: input.requestArtifactId,
    stepCount: 0,
    subagentCallCount: 0,
    violationRecorded: false
  };
}

function recordAiSdkLoopStep(
  runtime: AiSdkLoopControlRuntime | undefined,
  input: { step: unknown; stepArtifactId: string }
): void {
  if (!runtime) return;
  runtime.stepCount += 1;
  runtime.subagentCallCount += countSubagentCalls(input.step);
  if (runtime.policy.maxSteps !== undefined && runtime.stepCount > runtime.policy.maxSteps) {
    throw aiSdkLoopViolation(runtime, `AI SDK loop control exceeded step limit (${runtime.stepCount}/${runtime.policy.maxSteps}).`, input.stepArtifactId);
  }
  if (runtime.policy.maxSubagentCalls !== undefined && runtime.subagentCallCount > runtime.policy.maxSubagentCalls) {
    throw aiSdkLoopViolation(runtime, `AI SDK loop control exceeded subagent call limit (${runtime.subagentCallCount}/${runtime.policy.maxSubagentCalls}).`, input.stepArtifactId);
  }
  const disallowedTools = disallowedToolCalls(input.step, runtime.policy.allowedTools);
  if (disallowedTools.length > 0) {
    throw aiSdkLoopViolation(runtime, `AI SDK loop control observed non-allowlisted tool calls: ${disallowedTools.join(", ")}.`, input.stepArtifactId);
  }
}

function enforceAiSdkLoopRetryControl(
  runtime: AiSdkLoopControlRuntime | undefined,
  configuredRetries: number
): void {
  if (!runtime?.policy.required) return;
  const maxRetries = runtime.policy.maxProviderRetriesPerCall;
  if (maxRetries === undefined || configuredRetries <= maxRetries) return;
  throw aiSdkLoopViolation(runtime, `AI SDK loop control exceeded provider retry limit (${configuredRetries}/${maxRetries}).`);
}

function enforceAiSdkLoopTerminalResult(
  runtime: AiSdkLoopControlRuntime | undefined,
  result: Awaited<ReturnType<GenerateTextFunction>>
): void {
  if (!runtime?.policy.required || !runtime.policy.stopWhen) return;
  const actual = stopWhenValue(result.stopCondition);
  if (actual === runtime.policy.stopWhen) return;
  throw aiSdkLoopViolation(runtime, `AI SDK loop control stopWhen mismatch (${actual ?? "missing"}/${runtime.policy.stopWhen}).`);
}

function aiSdkLoopViolation(runtime: AiSdkLoopControlRuntime, reason: string, stepArtifactId?: string): Error {
  if (!runtime.violationRecorded) {
    runtime.violationRecorded = true;
    runtime.call.ledger.appendEvent(runtime.call.runId, "ai.sdk.loop_control.checked", {
      ok: false,
      phase: "enforcement",
      callId: runtime.callId,
      externalOperationId: runtime.externalOperationId,
      scope: runtime.policy.scope,
      requestHash: runtime.requestHash,
      artifactId: runtime.artifactId,
      stepArtifactId,
      reason,
      observed: {
        stepCount: runtime.stepCount,
        subagentCallCount: runtime.subagentCallCount
      },
      policy: aiSdkLoopControlSummary(runtime.policy)
    }, [
      runtime.requestArtifactId,
      ...(runtime.artifactId ? [runtime.artifactId] : []),
      ...(stepArtifactId ? [stepArtifactId] : [])
    ]);
  }
  const error = new Error(reason);
  error.name = "AiSdkLoopControlViolationError";
  return error;
}

function aiSdkLoopControlSummary(policy: AiSdkLoopControlPolicy): Record<string, unknown> {
  return {
    scope: policy.scope,
    stopWhen: policy.stopWhen,
    maxSteps: policy.maxSteps,
    maxSubagentCalls: policy.maxSubagentCalls,
    maxProviderRetriesPerCall: policy.maxProviderRetriesPerCall,
    abortSignalRequired: policy.abortSignalRequired,
    schedulerLeaseRequired: policy.schedulerLeaseRequired,
    toolApprovalsTrustedForSafety: false,
    allowedTools: policy.allowedTools,
    workerLease: policy.workerLease,
    source: policy.source
  };
}

function finiteControlInteger(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.max(1, Math.floor(value));
}

function finiteNonNegativeControlInteger(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.floor(value));
}

function countSubagentCalls(value: unknown): number {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return countSubagentToolCalls(record.toolCalls) +
    countSubagentToolCalls(record.tool_calls) +
    countSubagentToolCalls(record.toolResults) +
    countSubagentToolCalls(record.tool_results);
}

function countSubagentToolCalls(value: unknown): number {
  if (!Array.isArray(value)) return 0;
  return value.filter((item) => {
    if (!item || typeof item !== "object") return false;
    const record = item as Record<string, unknown>;
    const toolName = String(record.toolName ?? record.tool_name ?? record.name ?? "");
    return /subagent|sub_agent|delegate|critic|worker/i.test(toolName);
  }).length;
}

function disallowedToolCalls(value: unknown, allowedTools: string[] | undefined): string[] {
  if (!allowedTools) return [];
  const allowed = new Set(allowedTools);
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return [...new Set([
    ...toolNamesFromStepPart(record.toolCalls),
    ...toolNamesFromStepPart(record.tool_calls),
    ...toolNamesFromStepPart(record.toolResults),
    ...toolNamesFromStepPart(record.tool_results)
  ].filter((toolName) => !allowed.has(toolName)))].sort();
}

function toolNamesFromStepPart(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== "object") return undefined;
      const record = item as Record<string, unknown>;
      const toolName = record.toolName ?? record.tool_name ?? record.name;
      return typeof toolName === "string" && toolName.length > 0 ? toolName : undefined;
    })
    .filter((item): item is string => Boolean(item));
}

function stopWhenValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  return typeof record.stopWhen === "string" ? record.stopWhen : undefined;
}

function providerRequestSettings(settings: InstrumentedTextCall["settings"]): Record<string, unknown> {
  return {
    temperature: settings?.temperature,
    maxOutputTokens: settings?.maxOutputTokens,
    timeout: settings?.timeout,
    resilience: settings?.resilience ? {
      maxRetries: settings.resilience.maxRetries,
      retryBackoffMs: settings.resilience.retryBackoffMs,
      maxRetryAfterMs: settings.resilience.maxRetryAfterMs,
      maxConcurrency: settings.resilience.maxConcurrency,
      circuitBreaker: settings.resilience.circuitBreaker
    } : undefined,
    aiSdkLoop: settings?.aiSdkLoop ? {
      stopWhen: settings.aiSdkLoop.stopWhen,
      maxSteps: settings.aiSdkLoop.maxSteps,
      maxSubagentCalls: settings.aiSdkLoop.maxSubagentCalls,
      maxProviderRetriesPerCall: settings.aiSdkLoop.maxProviderRetriesPerCall
    } : undefined
  };
}

function stableProviderLegalPrivacyProof(check: {
  ok: boolean;
  provider: ProviderName;
  modelId: string;
  reviewedAt: string;
  expiresAt: string;
  policyHash: string;
  expectedPolicyHash?: string;
  stale: boolean;
  issues: string[];
}): Record<string, unknown> {
  return {
    ok: check.ok,
    provider: check.provider,
    modelId: check.modelId,
    reviewedAt: check.reviewedAt,
    expiresAt: check.expiresAt,
    policyHash: check.policyHash,
    expectedPolicyHash: check.expectedPolicyHash,
    stale: check.stale,
    issues: [...check.issues]
  };
}

function makeAiCallBudgetPreflight(input: {
  prompt: string;
  maxOutputTokens?: number;
  maxUsd?: number;
  runMaxUsd?: number;
}): {
  estimatedInputTokens: number;
  reservedOutputTokens: number;
  reservedTokens: number;
  reservedUsd?: number;
  requiresUsdSettlement: boolean;
  reserve: BudgetUsage;
} {
  if (input.maxOutputTokens === undefined) {
    throw new Error("AI calls require settings.maxOutputTokens so budget can be reserved before provider execution.");
  }
  const reservedOutputTokens = Math.floor(input.maxOutputTokens);
  if (!Number.isFinite(reservedOutputTokens) || reservedOutputTokens <= 0) {
    throw new Error("AI calls require settings.maxOutputTokens to be a positive finite number.");
  }
  if (input.runMaxUsd !== undefined && input.maxUsd === undefined) {
    throw new Error("USD-capped runs require settings.maxUsd for each AI call so cost can be reserved before provider execution.");
  }
  const reservedUsd = input.maxUsd === undefined ? undefined : Number(input.maxUsd);
  if (reservedUsd !== undefined && (!Number.isFinite(reservedUsd) || reservedUsd <= 0)) {
    throw new Error("AI calls require settings.maxUsd to be a positive finite number when provided.");
  }
  const estimatedInputTokens = estimatePromptTokens(input.prompt);
  const reservedTokens = estimatedInputTokens + reservedOutputTokens;
  return {
    estimatedInputTokens,
    reservedOutputTokens,
    reservedTokens,
    reservedUsd,
    requiresUsdSettlement: input.runMaxUsd !== undefined || reservedUsd !== undefined,
    reserve: {
      attempts: 1,
      tokens: reservedTokens,
      usd: reservedUsd ?? 0,
      elapsedMs: 1,
      artifactBytes: 0,
      sourceQueries: 0,
      retries: 0,
      sandboxMs: 0
    }
  };
}

async function generateTextWithProviderResilience(input: {
  call: InstrumentedTextCall;
  egress: ProviderEgressCheck;
  egressPrompt: string;
  operation: ExternalOperation;
  callId: string;
  requestArtifactId: string;
  transcriptPlanArtifactId: string;
  requestHash: string;
  retryReserve: BudgetUsage;
  generate: GenerateTextFunction;
  remoteAdmission?: RemoteComputeAdmission;
  loopControl?: AiSdkLoopControlRuntime;
  startedAt: number;
  stepArtifactIds: string[];
  streamChunkArtifactIds: string[];
  capturedStepFingerprints: Set<string>;
}): ReturnType<GenerateTextFunction> {
  const policy = normalizeProviderResiliencePolicy(input.call.provider, input.call.settings?.resilience);
  enforceRetryEnvelope(input, policy);
  enforceAiSdkLoopRetryControl(input.loopControl, policy.maxRetries);
  let providerAttempt = 0;
  while (true) {
    const runBlock = findProviderRunBlock(input.call.ledger.listEvents(input.call.runId), input.call.provider);
    if (runBlock) {
      input.call.ledger.appendEvent(input.call.runId, "provider.resilience.checked", {
        ok: false,
        provider: input.call.provider,
        modelId: input.call.modelId,
        callId: input.callId,
        externalOperationId: input.operation.id,
        requestHash: input.requestHash,
        requestArtifactId: input.requestArtifactId,
        activeBeforeAcquire: 0,
        maxConcurrency: policy.maxConcurrency,
        reason: runBlock.reason,
        kind: "provider_run_blocked",
        retryAfterMs: null
      }, [input.requestArtifactId]);
      throw new ProviderAdmissionRejectedError(runBlock.reason);
    }
    const admission = input.call.ledger.acquireProviderRuntimeSlot({
      runId: input.call.runId,
      provider: input.call.provider,
      modelId: input.call.modelId,
      operationId: input.operation.id,
      maxConcurrency: policy.maxConcurrency,
      leaseMs: providerRuntimeLeaseMs(input.call.settings)
    });
    input.call.ledger.appendEvent(input.call.runId, "provider.resilience.checked", {
      ok: admission.ok,
      provider: input.call.provider,
      modelId: input.call.modelId,
      callId: input.callId,
      externalOperationId: input.operation.id,
      requestHash: input.requestHash,
      requestArtifactId: input.requestArtifactId,
      activeBeforeAcquire: admission.activeBeforeAcquire,
      maxConcurrency: admission.maxConcurrency,
      lockId: admission.ok ? admission.lockId : null,
      leaseExpiresAt: admission.ok ? admission.expiresAt : null,
      reason: admission.ok ? null : admission.reason,
      kind: admission.ok ? null : admission.kind,
      retryAfterMs: admission.ok ? null : admission.retryAfterMs ?? null
    }, [input.requestArtifactId]);
    if (!admission.ok) {
      throw new ProviderAdmissionRejectedError(admission.reason);
    }

    providerAttempt += 1;
    try {
      const egressPayloadArtifact = input.call.artifacts.create(input.call.runId, "provider.egress.payload", JSON.stringify({
        format: "matematica.provider-egress-payload",
        version: 1,
        provider: input.call.provider,
        modelId: input.call.modelId,
        callId: input.callId,
        externalOperationId: input.operation.id,
        requestHash: input.requestHash,
        requestArtifactId: input.requestArtifactId,
        allowedFields: input.egress.allowedFields,
        outboundPayload: {
          model: {
            passedToAdapter: true,
            provider: input.call.provider,
            modelId: input.call.modelId
          },
          prompt: input.egressPrompt,
          temperature: input.call.settings?.temperature,
          maxOutputTokens: input.call.settings?.maxOutputTokens,
          abortSignal: Boolean(input.call.settings?.abortSignal || input.call.settings?.timeout),
          timeout: input.call.settings?.timeout,
          onStepFinish: true,
          tools: input.call.tools ? Object.keys(input.call.tools).sort() : undefined
        },
        blockedFields: [
          "apiKey",
          "authorization",
          "headers",
          "ledger",
          "database",
          "budgetPolicy",
          "providerMatrix",
          "legalPrivacy",
          "pricing",
          "systemPrompt"
        ],
        policy: {
          providerAdapterReceivesOnlySanitizedPromptAndRuntimeControls: true,
          providerKeysNeverPassedThroughGenerateOptions: true,
          hiddenBudgetPolicyNotSentToProvider: true,
          ledgerInternalsNotSentToProvider: true
        },
        payloadHash: stableHash({
          provider: input.call.provider,
          modelId: input.call.modelId,
          prompt: input.egressPrompt,
          temperature: input.call.settings?.temperature,
          maxOutputTokens: input.call.settings?.maxOutputTokens,
          timeout: input.call.settings?.timeout
        })
      }, null, 2));
      input.call.ledger.appendEvent(input.call.runId, "provider.egress.checked", {
        provider: input.call.provider,
        modelId: input.call.modelId,
        remote: input.egress.remote,
        allowedFields: input.egress.allowedFields,
        egressPayloadArtifactId: egressPayloadArtifact.id,
        egressPayloadHash: egressPayloadArtifact.sha256,
        redactedSecretCount: input.egress.redactedSecretCount,
        redactedLocalPathCount: input.egress.redactedLocalPathCount,
        blockedLedgerInternals: input.egress.blockedLedgerInternals,
        promptChanged: input.egressPrompt !== input.call.prompt,
        promptBytes: input.egressPrompt.length,
        settings: providerRequestSettings(input.call.settings)
      }, [input.requestArtifactId, egressPayloadArtifact.id]);
      const executionGuard = providerExecutionGuard(input.call.settings?.abortSignal, input.call.settings?.timeout);
      try {
        const generateOptions: Parameters<GenerateTextFunction>[0] = {
          model: input.call.model,
          prompt: input.egressPrompt,
          temperature: input.call.settings?.temperature,
          maxOutputTokens: input.call.settings?.maxOutputTokens,
          abortSignal: executionGuard.signal,
          timeout: input.call.settings?.timeout,
          onStepFinish: async (step) => {
            const stepArtifactId = persistAiStepTrace({
              runId: input.call.runId,
              callId: input.callId,
              externalOperationId: input.operation.id,
              ledger: input.call.ledger,
              artifacts: input.call.artifacts,
              step,
              stepIndex: input.stepArtifactIds.length,
              source: "onStepFinish",
              startedAt: input.startedAt
            });
            input.stepArtifactIds.push(stepArtifactId);
            input.capturedStepFingerprints.add(stableHash(redactJson(step)));
            recordAiSdkLoopStep(input.loopControl, {
              step,
              stepArtifactId
            });
          }
        };
        if (input.call.tools) generateOptions.tools = input.call.tools;
        attachAiSdkDynamicBoundaryContext(generateOptions, {
          format: "matematica.ai-sdk.dynamic-boundary-context",
          schemaVersion: 1,
          surface: "generateText",
          scope: input.call.scope ?? "standalone",
          runId: input.call.runId,
          externalOperationId: input.operation.id,
          providerRuntimeLeaseId: admission.lockId,
          budgetReservationId: input.operation.reservationId,
          requestArtifactId: input.requestArtifactId,
          transcriptArtifactId: input.transcriptPlanArtifactId,
          provider: input.call.provider,
          modelId: input.call.modelId,
          providerMetadata: {
            requestedProvider: input.call.provider,
            requestedModel: input.call.modelId
          },
          abortSignal: executionGuard.signal,
          schedulerLease: input.call.schedulerLease
            ? {
                ...input.call.schedulerLease,
                leaseExpiresAt: input.call.ledger.requireWorkerJob(input.call.schedulerLease.jobId).leaseExpiresAt
              }
            : undefined
        });
        assertAiSdkDynamicBoundaryContext(generateOptions, {
          surface: "generateText",
          scope: input.call.scope ?? "standalone",
          runId: input.call.runId,
          externalOperationId: input.operation.id,
          providerRuntimeLeaseId: admission.lockId,
          budgetReservationId: input.operation.reservationId,
          requestArtifactId: input.requestArtifactId,
          transcriptArtifactId: input.transcriptPlanArtifactId,
          provider: input.call.provider,
          modelId: input.call.modelId,
          schedulerLeaseRequired: input.call.scope === "worker-local"
        });
        const generatePromise = input.generate(generateOptions);
        const result = executionGuard.timeout
          ? await Promise.race([generatePromise, executionGuard.timeout])
          : await generatePromise;
        executionGuard.cleanup();
        input.call.ledger.recordProviderRuntimeSuccess(input.call.provider);
        return result;
      } catch (error) {
        executionGuard.cleanup();
        throw error;
      }
    } catch (error) {
      const classification = classifyProviderError(error);
      const circuit = input.call.ledger.recordProviderRuntimeFailure({
        provider: input.call.provider,
        circuitBreakerFailure: classification.circuitBreakerFailure,
        failureThreshold: policy.failureThreshold,
        cooldownMs: policy.cooldownMs,
        retryAfterMs: classification.retryAfterMs,
        retryAfterOperationId: input.operation.id
      });
      input.call.ledger.appendEvent(input.call.runId, "provider.call.failed", {
        provider: input.call.provider,
        modelId: input.call.modelId,
        callId: input.callId,
        externalOperationId: input.operation.id,
        requestHash: input.requestHash,
        requestArtifactId: input.requestArtifactId,
        providerAttempt,
        classification,
        errorName: error instanceof Error ? error.name : "UnknownError",
        errorMessage: redactText(error instanceof Error ? error.message : String(error))
      }, [input.requestArtifactId, ...input.stepArtifactIds]);
      if (circuit.circuitOpened) {
        input.call.ledger.appendEvent(input.call.runId, "provider.circuit.opened", {
          provider: input.call.provider,
          modelId: input.call.modelId,
          callId: input.callId,
          externalOperationId: input.operation.id,
          providerAttempt,
          openedUntil: circuit.openedUntil ? new Date(circuit.openedUntil).toISOString() : undefined,
          classification
        }, [input.requestArtifactId]);
      }
      const terminalBlockReason = terminalProviderRunBlockReason(input.call.provider, classification);
      if (terminalBlockReason) {
        input.call.ledger.appendEvent(input.call.runId, "provider.run.blocked", {
          provider: input.call.provider,
          modelId: input.call.modelId,
          callId: input.callId,
          externalOperationId: input.operation.id,
          requestHash: input.requestHash,
          requestArtifactId: input.requestArtifactId,
          providerAttempt,
          reason: terminalBlockReason,
          classification
        }, [input.requestArtifactId, ...input.stepArtifactIds]);
      }
      const retry = providerRetryDecision({ classification, attempt: providerAttempt, policy });
      if (!retry.retry) {
        throw error;
      }
      const retryAttempt = recordFailedProviderAttemptExternalOperation({
        ...input,
        providerAttempt,
        nextProviderAttempt: providerAttempt + 1,
        delayMs: retry.delayMs,
        retryReason: retry.reason,
        classification,
        error
      });
      input.call.ledger.appendEvent(input.call.runId, "provider.retry.scheduled", {
        provider: input.call.provider,
        modelId: input.call.modelId,
        callId: input.callId,
        externalOperationId: input.operation.id,
        retryAttemptOperationId: retryAttempt.operationId,
        requestHash: input.requestHash,
        requestArtifactId: input.requestArtifactId,
        failedAttempt: providerAttempt,
        nextAttempt: providerAttempt + 1,
        delayMs: retry.delayMs,
        reason: retry.reason,
        classification,
        retryReservationId: retryAttempt.reservationId,
        retryDebit: retryAttempt.debit,
        retryRequestArtifactId: retryAttempt.requestArtifactId,
        retryErrorArtifactId: retryAttempt.errorArtifactId
      }, [input.requestArtifactId, retryAttempt.requestArtifactId, retryAttempt.errorArtifactId, ...input.stepArtifactIds]);
      await abortableProviderSleep(policy.sleep, retry.delayMs, input.call.settings?.abortSignal);
    } finally {
      if (admission.ok) input.call.ledger.releaseProviderRuntimeSlot(admission.lockId);
    }
  }
}

function enforceRetryEnvelope(
  input: {
    call: InstrumentedTextCall;
    callId: string;
    operation: ExternalOperation;
    requestArtifactId: string;
    requestHash: string;
    remoteAdmission?: RemoteComputeAdmission;
  },
  policy: ReturnType<typeof normalizeProviderResiliencePolicy>
): void {
  const admittedRetries = input.remoteAdmission?.envelope.aiSdkToolLoop.maxProviderRetriesPerCall;
  if (admittedRetries === undefined || policy.maxRetries <= admittedRetries) return;
  input.call.ledger.appendEvent(input.call.runId, "provider.resilience.checked", {
    ok: false,
    provider: input.call.provider,
    modelId: input.call.modelId,
    callId: input.callId,
    externalOperationId: input.operation.id,
    requestHash: input.requestHash,
    requestArtifactId: input.requestArtifactId,
    activeBeforeAcquire: 0,
    maxConcurrency: policy.maxConcurrency,
    reason: `provider retry policy exceeds admitted retry envelope (${policy.maxRetries}/${admittedRetries})`,
    kind: "retry_envelope_exceeded",
    retryAfterMs: null
  }, [input.requestArtifactId]);
  throw new ProviderAdmissionRejectedError(`Provider retry policy exceeds admitted retry envelope (${policy.maxRetries}/${admittedRetries}).`);
}

function findProviderRunBlock(
  events: ReturnType<Ledger["listEvents"]>,
  provider: ProviderName
): { reason: string } | undefined {
  const event = events.findLast((item) =>
    item.type === "provider.run.blocked" &&
    item.payload.provider === provider
  );
  if (!event) return undefined;
  const reason = typeof event.payload.reason === "string"
    ? event.payload.reason
    : `provider ${provider} is blocked for this run after a terminal provider failure`;
  return { reason };
}

function terminalProviderRunBlockReason(
  provider: ProviderName,
  classification: ProviderFailureClassification
): string | undefined {
  if (classification.kind !== "auth" && classification.kind !== "quota" && classification.kind !== "malformed_usage") {
    return undefined;
  }
  return `provider ${provider} is blocked for this run after terminal ${classification.kind} failure`;
}

function providerRuntimeLeaseMs(settings: InstrumentedTextCall["settings"]): number {
  const timeout = settings?.timeout;
  return Number.isFinite(timeout) && timeout !== undefined && timeout > 0
    ? Math.trunc(timeout)
    : 60_000;
}

function recordFailedProviderAttemptExternalOperation(input: {
  call: InstrumentedTextCall;
  operation: ExternalOperation;
  retryReserve: BudgetUsage;
  callId: string;
  requestHash: string;
  requestArtifactId: string;
  remoteAdmission?: RemoteComputeAdmission;
  providerAttempt: number;
  nextProviderAttempt: number;
  delayMs: number;
  retryReason: string;
  classification: ProviderFailureClassification;
  error: unknown;
}): {
  operationId: string;
  reservationId: string;
  debit: BudgetUsage;
  requestArtifactId: string;
  errorArtifactId: string;
} {
  const debit = {
    ...input.retryReserve,
    elapsedMs: input.retryReserve.elapsedMs + Math.max(0, Math.trunc(input.delayMs))
  };
  const attemptRequestPayload = {
    parentCallId: input.callId,
    parentExternalOperationId: input.operation.id,
    parentRequestHash: input.requestHash,
    parentRequestArtifactId: input.requestArtifactId,
    provider: input.call.provider,
    modelId: input.call.modelId,
    providerAttempt: input.providerAttempt,
    nextProviderAttempt: input.nextProviderAttempt,
    retryReason: input.retryReason,
    classification: input.classification,
    retryDelayMs: input.delayMs,
    reserve: debit
  };
  const attemptRequestHash = stableHash(attemptRequestPayload);
  const attemptIdempotencyKey = externalOperationIdempotencyKey({
    runId: input.call.runId,
    operationType: "ai.generateText.retry",
    requestHash: attemptRequestHash,
    retryOfOperationId: input.operation.id
  });
  const requestArtifact = input.call.artifacts.create(input.call.runId, "ai.retry.request", JSON.stringify({
    idempotencyKey: attemptIdempotencyKey,
    requestHash: attemptRequestHash,
    ...attemptRequestPayload
  }, null, 2));
  const prepared = input.call.ledger.prepareExternalOperation({
    runId: input.call.runId,
    operationType: "ai.generateText.retry",
    provider: input.call.provider,
    idempotencyKey: attemptIdempotencyKey,
    requestHash: attemptRequestHash,
    reserve: debit,
    budgetCaps: input.call.settings?.budgetCaps,
    requestArtifactId: requestArtifact.id,
    remoteAdmissionEventId: input.remoteAdmission?.admissionEventId,
    admissionArtifactIds: input.remoteAdmission?.admissionArtifactIds,
    requiresRemoteAdmission: input.remoteAdmission?.remote === true,
    retryOfOperationId: input.operation.id
  });
  if (!prepared.ok) {
    throw new Error(`Budget exhausted before provider retry: ${prepared.reason}`);
  }
  if (!prepared.created) {
    throw new Error(`Provider retry attempt ${prepared.operation.id} already exists in status ${prepared.operation.status}; refusing duplicate retry.`);
  }
  const attemptOperation = input.call.ledger.startExternalOperation(prepared.operation.id);
  const errorArtifact = input.call.artifacts.create(input.call.runId, "ai.retry.error", JSON.stringify({
    parentCallId: input.callId,
    parentExternalOperationId: input.operation.id,
    retryAttemptOperationId: attemptOperation.id,
    provider: input.call.provider,
    modelId: input.call.modelId,
    providerAttempt: input.providerAttempt,
    nextProviderAttempt: input.nextProviderAttempt,
    retryReason: input.retryReason,
    retryDelayMs: input.delayMs,
    errorName: input.error instanceof Error ? input.error.name : "UnknownError",
    errorMessage: redactText(input.error instanceof Error ? input.error.message : String(input.error)),
    classification: input.classification
  }, null, 2));
  input.call.ledger.failExternalOperation({
    operationId: attemptOperation.id,
    errorMessage: input.error instanceof Error ? input.error.message : String(input.error),
    debit,
    provider: input.call.provider,
    errorArtifactId: errorArtifact.id
  });
  return {
    operationId: attemptOperation.id,
    reservationId: attemptOperation.reservationId,
    debit,
    requestArtifactId: requestArtifact.id,
    errorArtifactId: errorArtifact.id
  };
}

class UsageReservationExceededError extends Error {
  readonly debit: Partial<BudgetUsage>;

  constructor(message: string, debit: Partial<BudgetUsage>) {
    super(message);
    this.name = "UsageReservationExceededError";
    this.debit = debit;
  }
}

class ProviderAccountingFraudError extends Error {
  readonly debit: Partial<BudgetUsage>;

  constructor(message: string, debit: Partial<BudgetUsage>) {
    super(message);
    this.name = "ProviderAccountingFraudError";
    this.debit = debit;
  }
}

class ProviderAdmissionRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderAdmissionRejectedError";
  }
}

function failureSettlement(error: unknown, reserve: BudgetUsage, elapsedMs: number): {
  debit?: Partial<BudgetUsage>;
  overReservationPolicy?: { allowedDimensions: BudgetDimension[]; reason: string };
  releaseReason?: string;
} {
  if (error instanceof ProviderAdmissionRejectedError) {
    return { releaseReason: error.message };
  }
  if (error instanceof UsageReservationExceededError) {
    return {
      debit: error.debit,
      overReservationPolicy: {
        allowedDimensions: ["tokens", "usd", "elapsedMs"],
        reason: "Provider returned actual usage above the reserved estimate; fail closed and debit actual usage."
      }
    };
  }
  if (error instanceof ProviderAccountingFraudError) {
    return {
      debit: error.debit,
      overReservationPolicy: {
        allowedDimensions: ["tokens", "usd", "elapsedMs"],
        reason: "Provider returned inconsistent or underreported usage; fail closed and debit the pessimistic accounting floor."
      }
    };
  }
  return {
    debit: {
      attempts: reserve.attempts,
      tokens: reserve.tokens,
      usd: reserve.usd,
      elapsedMs
    },
    overReservationPolicy: {
      allowedDimensions: ["elapsedMs"],
      reason: "Provider failure debits measured elapsed time above the minimum preflight estimate."
    }
  };
}

function hasNonZeroBudgetUsage(value: Partial<BudgetUsage> | undefined): boolean {
  if (!value) return false;
  return Object.values(value).some((item) => typeof item === "number" && item !== 0);
}

function cachedInstrumentedTextResult(
  operation: ExternalOperation,
  ledger: Ledger
): InstrumentedTextResult {
  const responseArtifact = ledger.listArtifacts(operation.runId)
    .find((artifact) => artifact.id === operation.responseArtifactId);
  if (!responseArtifact) {
    throw new Error(`External operation ${operation.id} is missing response artifact ${operation.responseArtifactId}.`);
  }
  const response = JSON.parse(readArtifactText(responseArtifact)) as {
    text?: string;
    usage?: Record<string, unknown>;
    finishReason?: string;
    stepArtifactIds?: string[];
    streamChunkArtifactIds?: string[];
    transcriptArtifactId?: string;
  };
  return {
    text: typeof response.text === "string" ? response.text : "",
    usage: response.usage ?? {},
    finishReason: response.finishReason,
    requestArtifactId: operation.requestArtifactId ?? "",
    responseArtifactId: responseArtifact.id,
    transcriptArtifactId: response.transcriptArtifactId,
    stepArtifactIds: response.stepArtifactIds ?? [],
    streamChunkArtifactIds: response.streamChunkArtifactIds ?? [],
    externalOperationId: operation.id,
    replayedFromOutbox: true
  };
}

function persistAiStepTrace(input: {
  runId: string;
  callId: string;
  externalOperationId: string;
  ledger: Ledger;
  artifacts: ArtifactStore;
  step: unknown;
  stepIndex: number;
  source: "onStepFinish" | "result.steps";
  startedAt: number;
}): string {
  const redactedStep = redactJson(input.step);
  const summary = summarizeStep(redactedStep);
  const artifact = input.artifacts.create(input.runId, "ai.step", JSON.stringify({
    callId: input.callId,
    externalOperationId: input.externalOperationId,
    stepIndex: input.stepIndex,
    source: input.source,
    elapsedMs: Math.max(1, Date.now() - input.startedAt),
    step: redactedStep,
    summary
  }, null, 2));
  input.ledger.appendEvent(input.runId, "ai.call.step", {
    callId: input.callId,
    externalOperationId: input.externalOperationId,
    stepIndex: input.stepIndex,
    source: input.source,
    stepArtifactId: artifact.id,
    elapsedMs: Math.max(1, Date.now() - input.startedAt),
    ...summary
  }, [artifact.id]);
  return artifact.id;
}

function persistAiStreamChunkTrace(input: {
  runId: string;
  callId: string;
  externalOperationId: string;
  ledger: Ledger;
  artifacts: ArtifactStore;
  chunk: unknown;
  chunkIndex: number;
  startedAt: number;
}): string {
  const redactedChunk = redactJson(input.chunk);
  const summary = summarizeStreamChunk(redactedChunk);
  const artifact = input.artifacts.create(input.runId, "ai.stream_chunk", JSON.stringify({
    callId: input.callId,
    externalOperationId: input.externalOperationId,
    chunkIndex: input.chunkIndex,
    elapsedMs: Math.max(1, Date.now() - input.startedAt),
    chunk: redactedChunk,
    summary
  }, null, 2));
  input.ledger.appendEvent(input.runId, "ai.call.stream_chunk", {
    callId: input.callId,
    externalOperationId: input.externalOperationId,
    chunkIndex: input.chunkIndex,
    streamChunkArtifactId: artifact.id,
    elapsedMs: Math.max(1, Date.now() - input.startedAt),
    ...summary
  }, [artifact.id]);
  return artifact.id;
}

function persistAiTranscriptPlan(input: {
  runId: string;
  callId: string;
  externalOperationId: string;
  ledger: Ledger;
  artifacts: ArtifactStore;
  provider: ProviderName;
  modelId: string;
  scope: AiSdkCallScope;
  budgetReservationId: string;
  requestArtifactId: string;
  requestHash: string;
  schedulerLease?: WorkerLocalAiCallLease;
}): Artifact {
  const artifact = input.artifacts.create(input.runId, "ai.transcript.plan", JSON.stringify({
    format: "matematica.ai-transcript-plan",
    version: 1,
    callId: input.callId,
    externalOperationId: input.externalOperationId,
    scope: input.scope,
    provider: input.provider,
    modelId: input.modelId,
    budgetReservationId: input.budgetReservationId,
    requestArtifactId: input.requestArtifactId,
    requestHash: input.requestHash,
    schedulerLease: input.schedulerLease,
    persistencePolicy: {
      finalTranscriptRequired: true,
      completionStatuses: ["completed", "failed", "aborted"],
      transcriptEventType: "ai.call.transcript.persisted",
      requestArtifactRetained: true,
      providerStepsRetained: true,
      streamChunksRetained: true
    }
  }, null, 2));
  input.ledger.appendEvent(input.runId, "ai.call.transcript.plan.persisted", {
    callId: input.callId,
    externalOperationId: input.externalOperationId,
    scope: input.scope,
    provider: input.provider,
    modelId: input.modelId,
    budgetReservationId: input.budgetReservationId,
    requestArtifactId: input.requestArtifactId,
    transcriptPlanArtifactId: artifact.id,
    requestHash: input.requestHash
  }, [input.requestArtifactId, artifact.id]);
  return artifact;
}

function persistAiTranscript(input: {
  runId: string;
  callId: string;
  externalOperationId: string;
  ledger: Ledger;
  artifacts: ArtifactStore;
  provider: ProviderName;
  modelId: string;
  status: "completed" | "failed" | "aborted";
  requestArtifact: Artifact;
  responseArtifact?: Artifact;
  errorArtifact?: Artifact;
  stepArtifactIds: string[];
  streamChunkArtifactIds: string[];
  settings: Record<string, unknown>;
  budgetPreflight: unknown;
  pricing: unknown;
  privacy: unknown;
  usage?: Record<string, unknown>;
  finishReason?: string;
  stopCondition?: unknown;
  toolCalls?: unknown[];
  toolResults?: unknown[];
  providerFailure?: ProviderFailureClassification;
  errorName?: string;
  errorMessage?: string;
}): Artifact {
  const transcript = {
    format: "matematica.ai-transcript",
    version: 1,
    callId: input.callId,
    externalOperationId: input.externalOperationId,
    provider: input.provider,
    modelId: input.modelId,
    status: input.status,
    request: artifactReference(input.requestArtifact),
    response: input.responseArtifact ? artifactReference(input.responseArtifact) : undefined,
    error: input.errorArtifact ? artifactReference(input.errorArtifact) : undefined,
    steps: input.stepArtifactIds.map((artifactId, index) => ({ artifactId, index })),
    streamChunks: input.streamChunkArtifactIds.map((artifactId, index) => ({ artifactId, index })),
    providerSettings: redactJson(input.settings),
    budgetPreflight: redactJson(input.budgetPreflight),
    pricing: redactJson(input.pricing),
    privacy: redactJson(input.privacy),
    usage: redactJson(input.usage ?? {}),
    finishReason: input.finishReason,
    stopCondition: redactJson(input.stopCondition ?? input.finishReason ?? null),
    toolCalls: redactJson(input.toolCalls ?? []),
    toolResults: redactJson(input.toolResults ?? []),
    providerFailure: redactJson(input.providerFailure ?? null),
	    errorName: input.errorName,
	    errorMessage: input.errorMessage ? redactText(input.errorMessage) : undefined,
	    transcriptHashInputs: {
	      requestRawHash: artifactRawSha256(input.requestArtifact),
	      requestRedactedHash: input.requestArtifact.sha256,
	      responseRawHash: input.responseArtifact ? artifactRawSha256(input.responseArtifact) : undefined,
	      responseRedactedHash: input.responseArtifact?.sha256,
	      errorRawHash: input.errorArtifact ? artifactRawSha256(input.errorArtifact) : undefined,
	      errorRedactedHash: input.errorArtifact?.sha256
	    }
	  };
  const artifact = input.artifacts.create(input.runId, "ai.transcript", JSON.stringify(transcript, null, 2));
  input.ledger.appendEvent(input.runId, "ai.call.transcript.persisted", {
    callId: input.callId,
    externalOperationId: input.externalOperationId,
    provider: input.provider,
    modelId: input.modelId,
    status: input.status,
    transcriptArtifactId: artifact.id,
    requestArtifactId: input.requestArtifact.id,
    responseArtifactId: input.responseArtifact?.id,
	    errorArtifactId: input.errorArtifact?.id,
	    stepArtifactIds: input.stepArtifactIds,
	    streamChunkArtifactIds: input.streamChunkArtifactIds,
	    requestRawHash: artifactRawSha256(input.requestArtifact),
	    requestRedactedHash: input.requestArtifact.sha256,
	    responseRawHash: input.responseArtifact ? artifactRawSha256(input.responseArtifact) : undefined,
	    responseRedactedHash: input.responseArtifact?.sha256,
	    errorRawHash: input.errorArtifact ? artifactRawSha256(input.errorArtifact) : undefined,
	    errorRedactedHash: input.errorArtifact?.sha256,
	    usage: redactJson(input.usage ?? {}),
    finishReason: input.finishReason,
    stopCondition: redactJson(input.stopCondition ?? input.finishReason ?? null),
    toolCallCount: Array.isArray(input.toolCalls) ? input.toolCalls.length : 0,
    toolResultCount: Array.isArray(input.toolResults) ? input.toolResults.length : 0,
    streamChunkCount: input.streamChunkArtifactIds.length,
    stepCount: input.stepArtifactIds.length,
    providerFailure: redactJson(input.providerFailure ?? null),
    errorName: input.errorName
  }, [
    input.requestArtifact.id,
    input.responseArtifact?.id,
    input.errorArtifact?.id,
    artifact.id,
    ...input.stepArtifactIds,
    ...input.streamChunkArtifactIds
  ].filter((artifactId): artifactId is string => Boolean(artifactId)));
  return artifact;
}

function artifactReference(artifact: Artifact): Record<string, unknown> {
  return {
    artifactId: artifact.id,
    kind: artifact.kind,
    rawSha256: artifactRawSha256(artifact),
    redactedSha256: artifact.sha256,
    bytes: artifact.bytes
  };
}

function artifactRawSha256(artifact: Artifact): string | undefined {
  const provenance = artifact.provenance;
  if (!provenance || typeof provenance !== "object") return undefined;
  const raw = provenance.raw;
  if (!raw || typeof raw !== "object") return undefined;
  const sha256 = (raw as Record<string, unknown>).sha256;
  return typeof sha256 === "string" ? sha256 : undefined;
}

function summarizeStep(step: unknown): Record<string, unknown> {
  const record = step && typeof step === "object" ? step as Record<string, unknown> : {};
  const toolCalls = arrayLength(record.toolCalls ?? record.tool_calls);
  const toolResults = arrayLength(record.toolResults ?? record.tool_results);
  return {
    finishReason: stringValue(record.finishReason ?? record.finish_reason),
    stopReason: stringValue(record.stopReason ?? record.stop_reason),
    usage: record.usage,
    providerMetadata: record.providerMetadata,
    toolCallCount: toolCalls,
    toolResultCount: toolResults,
    hasMessages: Array.isArray(record.messages),
    hasPrepareStepChanges: Boolean(record.prepareStep || record.prepareStepResult || record.experimental_prepareStepResult || record.settings)
  };
}

function summarizeStreamChunk(chunk: unknown): Record<string, unknown> {
  const record = chunk && typeof chunk === "object" ? chunk as Record<string, unknown> : {};
  const textDelta = stringValue(record.textDelta ?? record.delta ?? record.text);
  const toolCallDeltaCount = arrayLength(record.toolCallDeltas ?? record.tool_calls ?? record.toolCalls);
  const toolResultDeltaCount = arrayLength(record.toolResultDeltas ?? record.tool_results ?? record.toolResults);
  return {
    chunkType: stringValue(record.type ?? record.event ?? record.kind),
    hasTextDelta: Boolean(textDelta),
    textDeltaHash: textDelta ? stableHash(redactText(textDelta)) : undefined,
    finishReason: stringValue(record.finishReason ?? record.finish_reason),
    stopReason: stringValue(record.stopReason ?? record.stop_reason),
    usage: record.usage,
    providerMetadata: record.providerMetadata,
    toolCallDeltaCount,
    toolResultDeltaCount
  };
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /abort/i.test(error.message));
}

function providerExecutionGuard(parentSignal: AbortSignal | undefined, timeoutMs: number | undefined): {
  signal: AbortSignal;
  timeout?: Promise<never>;
  cleanup: () => void;
} {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let removeParentAbort: (() => void) | undefined;
  let rejectInterrupted: ((error: Error) => void) | undefined;
  const hasTimeout = Number.isFinite(timeoutMs) && timeoutMs !== undefined && timeoutMs > 0;
  const interrupt = parentSignal || hasTimeout
    ? new Promise<never>((_, reject) => {
        rejectInterrupted = reject;
      })
    : undefined;
  const abort = (error: Error) => {
    if (!controller.signal.aborted) {
      controller.abort(error);
      rejectInterrupted?.(error);
    }
  };
  if (parentSignal) {
    if (parentSignal.aborted) {
      abort(abortErrorFromSignal(parentSignal));
    } else {
      const onAbort = () => abort(abortErrorFromSignal(parentSignal));
      parentSignal.addEventListener("abort", onAbort, { once: true });
      removeParentAbort = () => parentSignal.removeEventListener("abort", onAbort);
    }
  }
  if (hasTimeout) {
    timeout = setTimeout(() => {
      const error = Object.assign(new Error(`provider request timeout after ${Math.trunc(timeoutMs)}ms`), { code: "ETIMEDOUT" });
      abort(error);
    }, Math.trunc(timeoutMs));
    timeout.unref?.();
  }
  return {
    signal: controller.signal,
    timeout: interrupt,
    cleanup: () => {
      if (timeout) clearTimeout(timeout);
      removeParentAbort?.();
    }
  };
}

async function abortableProviderSleep(
  sleep: (ms: number) => Promise<void>,
  delayMs: number,
  signal: AbortSignal | undefined
): Promise<void> {
  if (!signal) {
    await sleep(delayMs);
    return;
  }
  if (signal.aborted) throw abortErrorFromSignal(signal);
  await Promise.race([
    sleep(delayMs),
    new Promise<never>((_, reject) => {
      signal.addEventListener("abort", () => reject(abortErrorFromSignal(signal)), { once: true });
    })
  ]);
}

function abortErrorFromSignal(signal: AbortSignal): Error {
  const reason = signal.reason;
  const error = new Error(reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "provider request aborted");
  error.name = "AbortError";
  return error;
}


async function defaultGenerateText(options: {
  model: LanguageModel;
  prompt: string;
  temperature?: number;
  maxOutputTokens?: number;
  abortSignal?: AbortSignal;
  timeout?: number;
  onStepFinish?: (step: unknown) => void | Promise<void>;
  tools?: Record<string, unknown>;
}) {
  const aiSdkOptions = {
    model: options.model,
    prompt: options.prompt,
    temperature: options.temperature,
    maxOutputTokens: options.maxOutputTokens,
    abortSignal: options.abortSignal,
    timeout: options.timeout,
    onStepFinish: options.onStepFinish,
    tools: options.tools as never
  };
  return generateText(aiSdkOptions);
}

function usageToRecord(usage: unknown): Record<string, unknown> {
  if (usage && typeof usage === "object") {
    return { ...(usage as Record<string, unknown>) };
  }
  return {};
}

function tokenUsageFromRecord(usage: Record<string, unknown>): number {
  const totalTokens = numericUsage(usage.totalTokens);
  if (totalTokens > 0) return totalTokens;
  const inputTokens = numericUsage(usage.inputTokens ?? usage.promptTokens);
  const outputTokens = numericUsage(usage.outputTokens ?? usage.completionTokens);
  return inputTokens + outputTokens;
}

function providerUsageAccountingFloor(usage: Record<string, unknown>): {
  underreported: boolean;
  reportedTotalTokens: number;
  minimumActualTokens: number;
} {
  const reportedTotalTokens = numericUsage(usage.totalTokens);
  const inputTokens = numericUsage(usage.inputTokens ?? usage.promptTokens);
  const outputTokens = numericUsage(usage.outputTokens ?? usage.completionTokens);
  const minimumActualTokens = inputTokens + outputTokens;
  return {
    underreported: reportedTotalTokens > 0 && minimumActualTokens > 0 && reportedTotalTokens < minimumActualTokens,
    reportedTotalTokens,
    minimumActualTokens
  };
}

function numericUsage(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function usdUsageFromResult(usage: Record<string, unknown>, providerMetadata: unknown): number | undefined {
  return firstUsdUsage([
    usage.totalUsd,
    usage.usd,
    usage.costUsd,
    usage.totalCostUsd,
    usage.totalCost,
    usage.cost,
    providerMetadata
  ]);
}

function firstUsdUsage(values: unknown[]): number | undefined {
  for (const value of values) {
    const found = findUsdUsage(value, 0);
    if (found !== undefined) return found;
  }
  return undefined;
}

function findUsdUsage(value: unknown, depth: number): number | undefined {
  if (depth > 4 || value === null || value === undefined) return undefined;
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findUsdUsage(item, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (typeof value !== "object") return undefined;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (/(usd|cost|price|total_cost|totalCost)/i.test(key)) {
      const found = findUsdUsage(nested, depth + 1);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}
