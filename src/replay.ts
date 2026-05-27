import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { auditRun, type AuditResult } from "./audit";
import { evaluateClaimGraph, extractClaimRetractions, type ClaimGraphDecision } from "./claim-graph";
import type { MatematicaConfig } from "./config";
import { publicConfig } from "./config";
import type { Artifact, EvidenceGrade, GoalRun, LedgerEvent } from "./domain";
import { artifactContentAddress, artifactStorageKey, evidenceSatisfiesGoal } from "./domain";
import { evaluateEvidenceGate, type FormalClaimContract } from "./evidence";
import { evaluateGoalSuccess, goalSuccessComparable } from "./goal-success";
import { stableHash } from "./idempotency";
import { isRemoteProvider } from "./privacy";
import {
  buildOfflineReplayNonReplayableSteps,
  evaluateOfflineSelfContainedGate,
  type OfflineSelfContainedGate
} from "./offline-replay-gate";
import { type FinalOutcome } from "./outcome";
import { classificationForRun } from "./problem-classifier";
import { evaluateProofObligationGraph, traceProofObligations, type ProofObligationGraph } from "./proof-obligations";
import { buildArxivSearchUrl } from "./research/arxiv";
import { defaultMathlibTheoremIndexSnapshot } from "./theorem";
import { computeLedgerEventHash, Ledger, type ExternalOperation, type StoredScore } from "./ledger";
import { matematicaPackageLockHash, matematicaPackageVersion } from "./package-info";
import { reportGenerationIdempotencyKey, renderReport } from "./report";
import { redactJson, redactText } from "./redaction";
import { buildReplayTrustContract, type ReplayTrustContract } from "./replay-trust";
import { readArtifactText } from "./storage-encryption";
import {
  buildVerifierPolicyManifest,
  EVIDENCE_GATE_VERSION,
  FINAL_OUTCOME_MAPPING_VERSION,
  loadRunVerifierPolicyManifest,
  PROBLEM_CLASSIFIER_VERSION,
  PROOF_OBLIGATION_RULES_VERSION,
  type VerifierPolicyManifest
} from "./verifier-policy";

export type ReplayManifest = {
  runId: string;
  cliVersion: string;
  bunVersion: string;
  packageLockHash?: string;
  config: MatematicaConfig;
  schemaVersion: number;
  migrations: string[];
  promptTemplateVersions: Record<string, string>;
  verifierPolicy: {
    artifactId?: string;
    policyHash?: string;
    currentPolicyHash: string;
    drift: boolean;
    policyVersion?: string;
    evidenceGateVersion?: string;
    proofObligationRulesVersion?: string;
    problemClassifierVersion?: string;
    finalOutcomeMappingVersion?: string;
    trustedVerifierIds: string[];
  };
  externalOperations: Array<{
    id: string;
    operationType: string;
    provider?: string;
    idempotencyKey: string;
    requestHash: string;
    requestArtifactId?: string;
    requestArtifactHash?: string;
    responseArtifactId?: string;
    responseArtifactHash?: string;
    errorArtifactId?: string;
    errorArtifactHash?: string;
    reservationId: string;
    status: string;
    retryOfOperationId?: string;
    attempt: number;
  }>;
  providers: Array<{
    callId?: string;
    provider?: string;
    modelId?: string;
    actualUpstreamProvider?: string;
    actualUpstreamModel?: string;
    providerMetadataHash?: string;
    pricingSource?: string;
    pricingHash?: string;
    silentFallbackAllowed?: boolean;
    settings?: unknown;
    requestArtifactId?: string;
    requestArtifactHash?: string;
    responseArtifactId?: string;
    responseArtifactHash?: string;
    transcriptArtifactId?: string;
    transcriptArtifactHash?: string;
    stepArtifactIds?: string[];
    stepArtifactHashes?: string[];
    streamChunkArtifactIds?: string[];
    streamChunkArtifactHashes?: string[];
    usage?: unknown;
  }>;
  aiSdkLoopModes: AiSdkLoopReplayHarness;
  providerMatrix?: {
    eventId: string;
    artifactId?: string;
    artifactHash?: string;
    matrixHash?: string;
    providerAllowlist: string[];
    providers: Array<{
      provider?: string;
      requestedModel?: string;
      actualUpstreamProvider?: string;
      actualUpstreamModel?: string;
      tools?: string;
      streaming?: string;
      structuredOutput?: string;
      configured?: boolean;
    }>;
    fallbackPolicy?: unknown;
    requiredCapabilities?: unknown;
  };
  privacy: {
    localOnly: boolean;
    artifactStorage: "local-filesystem";
    redaction: "enabled";
    remoteProviderCalls: number;
    remoteProviders: string[];
    remoteProviderUseIsExplicit: boolean;
  };
  replayTrust: ReplayTrustContract;
  lean: Array<Record<string, unknown>>;
  arxiv: Array<{
    query?: string;
    maxResults?: number;
    url?: string;
    artifactId?: string;
    sourceHashes: string[];
    licenseManifestHash?: string;
    redistribution?: string;
    pdfOrSourceContentExported?: boolean;
  }>;
  mathlib: Array<{
    artifactId?: string;
    artifactHash?: string;
    indexVersion?: string;
    indexHash?: string;
    currentIndexHash: string;
    drift: boolean;
    mathlibRevision?: string;
    lakeManifestHash?: string;
    theoremHandles: Array<{
      name?: string;
      module?: string;
      statementHash?: string;
      trustGrade?: string;
      proofSupport?: boolean;
    }>;
  }>;
  remoteWorkers: Array<{
    eventId: string;
    workerId?: string;
    artifactId?: string;
    artifactHash?: string;
    accepted: boolean;
    issues: string[];
    cliVersion?: string;
    protocolVersion?: number;
    runtime?: unknown;
    platform?: unknown;
    allowedProviders: string[];
    networkMode?: string;
    sandboxMode?: string;
    budgetEnvelopeHash?: string;
    verifierToolchain?: unknown;
    codeIdentity?: unknown;
  }>;
  artifacts: Array<{
    id: string;
    kind: string;
    sha256: string;
    contentAddress: string;
    mediaType: string;
    storageKey: string;
    bytes: number;
  }>;
  actionPersistence: Array<{
    eventId: string;
    type: string;
    externalOperationId?: string;
    jobId?: string;
    artifactIds: string[];
    artifactHashes: string[];
    replayable: boolean;
  }>;
  eventCount: number;
  generatedAt: string;
};

export type OfflineReplayResult = {
  ok: boolean;
  runId: string;
  manifest: ReplayManifest;
  audit: AuditResult;
  selfContained: OfflineSelfContainedGate;
  finalVerification?: FinalReplayVerification;
  deterministic?: DeterministicReplayContract;
  replayedEvents: number;
  nonReplayableSteps: Array<{
    eventId: string;
    type: string;
    reason: string;
  }>;
};

export type DeterministicReplayContract = {
  mode: "forensic_deterministic";
  semantics: string;
  networkPolicy: "no_new_network_or_provider_calls";
  redactionPolicy: "persisted_redacted_artifacts_only";
  finalDecisionRecomputed: boolean;
  eventLogHash: string;
  artifactManifestHash: string;
  stateTransitions: Array<{
    sequence?: number;
    eventId: string;
    type: string;
    payloadHash: string;
    artifactIds: string[];
    linkedArtifactHashes?: Array<{ artifactId: string; sha256?: string }>;
    schemaVersion?: number;
    previousEventHash?: string;
    eventHash?: string;
  }>;
  externalEffects: Array<{
    eventId: string;
    type: string;
    reason: string;
    provider?: string;
    modelId?: string;
    requestHash?: string;
    requestArtifactId?: string;
    requestArtifactHash?: string;
    responseArtifactId?: string;
    responseArtifactHash?: string;
    transcriptArtifactId?: string;
    transcriptArtifactHash?: string;
    stepArtifactIds?: string[];
    stepArtifactHashes?: string[];
    streamChunkArtifactIds?: string[];
    streamChunkArtifactHashes?: string[];
    idempotencyKey?: string;
    retryOfOperationId?: string;
    retryAttemptOperationId?: string;
    retryReservationId?: string;
    failedAttempt?: number;
    nextAttempt?: number;
    attempt?: number;
  }>;
  aiSdkLoopModes: AiSdkLoopReplayHarness;
};

export type AiSdkLoopReplayHarness = {
  format: "matematica.ai-sdk-loop-replay-harness";
  version: 1;
  calls: AiSdkLoopReplayCall[];
  canonicalShapeHashes: string[];
  equivalentCanonicalShape: boolean;
};

export type AiSdkLoopReplayCall = {
  callId?: string;
  externalOperationId?: string;
  provider?: string;
  modelId?: string;
  terminalStatus: "completed" | "failed" | "aborted" | "started_only" | "unknown";
  requestArtifactHash?: string;
  responseArtifactHash?: string;
  transcriptArtifactHash?: string;
  errorArtifactHash?: string;
  stepArtifactHashes: string[];
  streamChunkArtifactHashes: string[];
  canonicalShape: {
    started: boolean;
    terminalStatus: string;
    terminalEventType?: string;
    stepCount: number;
    streamChunkCount: number;
    finishReason?: string;
    stopConditionHash?: string;
    usageKeys: string[];
    usageTotalTokens?: number;
    toolCallCount: number;
    toolResultCount: number;
    steps: Array<{
      index: number;
      finishReason?: string;
      stopReason?: string;
      toolCallCount: number;
      toolResultCount: number;
      hasMessages: boolean;
      hasPrepareStepChanges: boolean;
    }>;
    streamChunks: Array<{
      index: number;
      chunkType?: string;
      hasTextDelta: boolean;
      finishReason?: string;
      stopReason?: string;
      toolCallDeltaCount: number;
      toolResultDeltaCount: number;
    }>;
    errorName?: string;
    providerFailureKind?: string;
  };
  canonicalShapeHash: string;
};

export type ReproducibilityBundle = {
  format: "matematica.reproducibility.bundle";
  version: 1;
  exportedAt: string;
  run: GoalRun;
  redaction: {
    policy: "portable_no_secret_no_private_paths";
    pathPlaceholders: string[];
    artifactPathsIncluded: false;
    eventHashChain: "recomputed_after_redaction";
    rawPromptTextIncluded: false;
    rawProviderTextIncluded: false;
    rawSourceTextIncluded: false;
    rawExportRequiresExplicitConsent: true;
    retentionPolicy: {
      localRedactedArtifacts: "retain_until_operator_prunes_or_deletes_matematica_home";
      rawArtifacts: "not_persisted";
      portableExports: "operator_managed_files";
    };
  };
  replayTrust: ReplayTrustContract;
  manifest: ReplayManifest;
  expected: ReproducibilityBundleExpectation;
  events: Array<{
    id: string;
    runId: string;
    type: LedgerEvent["type"];
    payload: Record<string, unknown>;
    artifactIds: string[];
    createdAt: string;
    sequence: number;
    payloadHash: string;
    linkedArtifactHashes: Array<{ artifactId: string; sha256?: string }>;
    schemaVersion: number;
    previousEventHash?: string;
    eventHash: string;
  }>;
  artifacts: Array<{
    id: string;
    runId: string;
    kind: string;
    sha256: string;
    contentAddress: string;
    mediaType: string;
    storageKey: string;
    bytes: number;
    createdAt: string;
    provenance: Record<string, unknown>;
    contentBase64: string;
  }>;
  externalOperations: ExternalOperation[];
  scores: StoredScore[];
};

export type ReproducibilityBundleExpectation = {
  reportHash: string;
  finalDecisionHash?: string;
  policyHash?: string;
  artifactManifestHash: string;
  providerCallManifestHash: string;
  citationManifestHash: string;
  nonReplayableStepsHash: string;
  eventLogHash?: string;
  finalVerification?: FinalReplayVerification;
};

export type ReproducibilityImportResult = {
  ok: boolean;
  runId: string;
  imported: {
    events: number;
    artifacts: number;
    externalOperations: number;
    scores: number;
  };
  verification: {
    replayOk: boolean;
    expected: ReproducibilityBundleExpectation;
    actual: ReproducibilityBundleExpectation;
    divergences: Array<{
      field: keyof ReproducibilityBundleExpectation | "manifest";
      expected?: unknown;
      actual?: unknown;
      reason: string;
    }>;
  };
};

export type FinalReplayVerification = {
  ok: boolean;
  divergences: ReplayDivergence[];
  recomputed: {
    finalOutcome: {
      state: string;
      canClaimSolved: boolean;
      reason: string;
    };
    evidenceGateHash?: string;
    goalSuccessHash?: string;
    proofObligationDecisionHash?: string;
    proofObligationTraceHash?: string;
    reportIdempotencyKey: string;
    reportHash: string;
    budgetUsage: BudgetUsage;
    oracle: ReplayOracleSummary;
    policy: {
      artifactId?: string;
      pinnedPolicyHash?: string;
      currentPolicyHash: string;
      drift: boolean;
      trustedVerifierIds: string[];
    };
  };
  persisted: {
    terminal?: Record<string, unknown>;
    evidenceGateHash?: string;
    goalSuccessHash?: string;
    proofObligationDecisionHash?: string;
    proofObligationTraceHash?: string;
    budgetUsage: BudgetUsage;
  };
};

export type ReplayDivergence = {
  kind:
    | "audit"
    | "final_outcome"
    | "evidence_gate"
    | "goal_success"
    | "claim_graph"
    | "proof_obligations"
    | "policy_manifest"
    | "report_summary"
    | "budget_totals"
    | "ledger_hash_chain"
    | "artifact_hash"
    | "terminal_order"
    | "worker_lease"
    | "provider_routing"
    | "proof_certificate"
    | "missing_artifact"
    | "invalid_artifact";
  expected?: unknown;
  actual?: unknown;
  reason: string;
};

export type ReplayOracleSummary = {
  eventCount: number;
  artifactCount: number;
  terminalEventCount: number;
  workerMutationCount: number;
  providerRouteCount: number;
  proofCertificateCount: number;
  ledgerHeadHash?: string;
  artifactRootHash: string;
};

type BudgetUsage = {
  attempts: number;
  tokens: number;
  usd: number;
  elapsedMs: number;
  artifactBytes: number;
  sourceQueries: number;
  retries: number;
  sandboxMs: number;
};

const PROMPT_TEMPLATE_VERSIONS = {
  workerPrompt: "prompt-boundary-v1",
  localVerifier: "local-deterministic-v0",
  evidenceGate: EVIDENCE_GATE_VERSION,
  proofObligations: PROOF_OBLIGATION_RULES_VERSION,
  problemClassifier: PROBLEM_CLASSIFIER_VERSION,
  finalOutcomeMapping: FINAL_OUTCOME_MAPPING_VERSION
};

export function buildReplayManifest(input: {
  runId: string;
  ledger: Ledger;
  cwd: string;
  config: MatematicaConfig;
  currentPolicyManifest?: VerifierPolicyManifest;
}): ReplayManifest {
  const run = input.ledger.requireRun(input.runId);
  const events = input.ledger.listEvents(input.runId);
  const artifacts = input.ledger.listArtifacts(input.runId);
  const artifactById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const pinnedPolicy = loadRunVerifierPolicyManifest(input.runId, input.ledger);
  const currentPolicy = input.currentPolicyManifest ?? buildVerifierPolicyManifest();
  return {
    runId: input.runId,
    cliVersion: matematicaPackageVersion(input.cwd),
    bunVersion: Bun.version,
    packageLockHash: matematicaPackageLockHash(input.cwd),
    config: publicConfig(input.config),
    schemaVersion: input.ledger.schemaVersion(),
    migrations: input.ledger.appliedMigrations(),
    promptTemplateVersions: PROMPT_TEMPLATE_VERSIONS,
    verifierPolicy: {
      artifactId: pinnedPolicy?.artifactId,
      policyHash: pinnedPolicy?.manifest.policyHash,
      currentPolicyHash: currentPolicy.policyHash,
      drift: Boolean(pinnedPolicy && pinnedPolicy.manifest.policyHash !== currentPolicy.policyHash),
      policyVersion: pinnedPolicy?.manifest.policyVersion,
      evidenceGateVersion: pinnedPolicy?.manifest.evidenceGateVersion,
      proofObligationRulesVersion: pinnedPolicy?.manifest.proofObligationRulesVersion,
      problemClassifierVersion: pinnedPolicy?.manifest.problemClassifierVersion,
      finalOutcomeMappingVersion: pinnedPolicy?.manifest.finalOutcomeMappingVersion,
      trustedVerifierIds: pinnedPolicy?.manifest.trustedVerifiers.map((verifier) => verifier.id) ?? []
    },
    externalOperations: input.ledger.listExternalOperations(input.runId).map((operation) => {
      const failureEvent = operation.status === "failed"
        ? events.findLast((event) =>
            event.type === "external.operation.failed" &&
            event.payload.operationId === operation.id
          )
        : undefined;
      const errorArtifactId = stringValue(failureEvent?.payload.errorArtifactId);
      return {
      id: operation.id,
      operationType: operation.operationType,
      provider: operation.provider,
      idempotencyKey: operation.idempotencyKey,
      requestHash: operation.requestHash,
      requestArtifactId: operation.requestArtifactId,
      requestArtifactHash: artifactHash(artifactById, operation.requestArtifactId),
      responseArtifactId: operation.responseArtifactId,
      responseArtifactHash: artifactHash(artifactById, operation.responseArtifactId),
      errorArtifactId,
      errorArtifactHash: artifactHash(artifactById, errorArtifactId),
      reservationId: operation.reservationId,
      status: operation.status,
      retryOfOperationId: operation.retryOfOperationId,
      attempt: operation.attempt
    };
    }),
    providers: events
      .filter((event) => event.type === "ai.call.started" || event.type === "ai.call.completed")
      .map((event) => {
        const stepArtifactIds = stringArrayValue(event.payload.stepArtifactIds);
        const streamChunkArtifactIds = stringArrayValue(event.payload.streamChunkArtifactIds);
        return {
          callId: stringValue(event.payload.callId),
          provider: stringValue(event.payload.provider),
          modelId: stringValue(event.payload.modelId),
          actualUpstreamProvider: stringValue(recordValue(event.payload.providerProvenance).actualUpstreamProvider),
          actualUpstreamModel: stringValue(recordValue(event.payload.providerProvenance).actualUpstreamModel),
          providerMetadataHash: stringValue(event.payload.providerMetadataHash) ?? stringValue(recordValue(event.payload.providerProvenance).providerMetadataHash),
          pricingSource: stringValue(recordValue(event.payload.providerProvenance).pricingSource),
          pricingHash: stringValue(recordValue(event.payload.providerProvenance).pricingHash),
          silentFallbackAllowed: recordValue(event.payload.providerProvenance).silentFallbackAllowed === true,
          settings: event.payload.settings,
          requestArtifactId: stringValue(event.payload.requestArtifactId),
          requestArtifactHash: artifactHash(artifactById, stringValue(event.payload.requestArtifactId)),
          responseArtifactId: stringValue(event.payload.responseArtifactId),
          responseArtifactHash: artifactHash(artifactById, stringValue(event.payload.responseArtifactId)),
          transcriptArtifactId: stringValue(event.payload.transcriptArtifactId),
          transcriptArtifactHash: artifactHash(artifactById, stringValue(event.payload.transcriptArtifactId)),
          stepArtifactIds,
          stepArtifactHashes: stepArtifactIds
            ?.map((artifactId) => artifactHash(artifactById, artifactId))
            .filter((hash): hash is string => Boolean(hash)),
          streamChunkArtifactIds,
          streamChunkArtifactHashes: streamChunkArtifactIds
            ?.map((artifactId) => artifactHash(artifactById, artifactId))
            .filter((hash): hash is string => Boolean(hash)),
          usage: event.payload.usage
        };
      }),
    aiSdkLoopModes: buildAiSdkLoopReplayHarness(events, artifacts),
    providerMatrix: (() => {
      const event = events.findLast((item) => item.type === "provider.matrix.pinned");
      if (!event) return undefined;
      const artifactId = stringValue(event.payload.artifactId);
      return {
        eventId: event.id,
        artifactId,
        artifactHash: artifactHash(artifactById, artifactId),
        matrixHash: stringValue(event.payload.matrixHash),
        providerAllowlist: stringArrayValue(event.payload.providerAllowlist) ?? [],
        providers: Array.isArray(event.payload.providers)
          ? event.payload.providers.map((provider) => {
              const record = provider && typeof provider === "object" ? provider as Record<string, unknown> : {};
              return {
                provider: stringValue(record.provider),
                requestedModel: stringValue(record.requestedModel),
                actualUpstreamProvider: stringValue(record.actualUpstreamProvider),
                actualUpstreamModel: stringValue(record.actualUpstreamModel),
                tools: stringValue(record.tools),
                streaming: stringValue(record.streaming),
                structuredOutput: stringValue(record.structuredOutput),
                configured: typeof record.configured === "boolean" ? record.configured : undefined
              };
            })
          : [],
        fallbackPolicy: event.payload.fallbackPolicy,
        requiredCapabilities: event.payload.requiredCapabilities
      };
    })(),
    privacy: {
      localOnly: input.config.localOnly,
      artifactStorage: "local-filesystem",
      redaction: "enabled",
      remoteProviderCalls: events.filter((event) =>
        event.type === "privacy.remote_provider.used" && isRemoteProvider(stringValue(event.payload.provider))
      ).length,
      remoteProviders: [...new Set(events
        .filter((event) => event.type === "privacy.remote_provider.used")
        .map((event) => stringValue(event.payload.provider))
        .filter((provider): provider is string => isRemoteProvider(provider)))].sort(),
      remoteProviderUseIsExplicit: events
        .filter((event) => event.type === "privacy.remote_provider.used")
        .every((event) => event.payload.explicitRemoteUse === true)
    },
    replayTrust: buildReplayTrustContract({ run, events, artifacts }),
    lean: events
      .filter((event) => event.type === "verifier.started" || event.type === "verifier.completed")
      .filter((event) => event.payload.verifier === "lean4")
      .map((event) => ({
        eventId: event.id,
        type: event.type,
        leanBin: event.payload.leanBin,
        lakeBin: event.payload.lakeBin,
        executionMode: event.payload.executionMode,
        projectRoot: event.payload.projectRoot,
        projectPinned: event.payload.projectPinned,
        sourceHash: event.payload.sourceHash,
        theoremStatementHashes: event.payload.theoremStatementHashes,
        toolchainHash: event.payload.toolchainHash,
        leanBinaryHash: event.payload.leanBinaryHash,
        lakeBinaryHash: event.payload.lakeBinaryHash,
        leanToolchain: event.payload.leanToolchain,
        lakeManifestHash: event.payload.lakeManifestHash,
        lakefileHash: event.payload.lakefileHash,
        mathlibRevision: event.payload.mathlibRevision,
        verifierCommandHash: event.payload.verifierCommandHash,
        sandboxPolicyHash: event.payload.sandboxPolicyHash,
        failureKind: event.payload.failureKind,
        artifactIds: event.artifactIds
      })),
    arxiv: events
      .filter((event) => event.type === "source.results" && event.payload.provider === "arxiv")
      .map((event) => {
        const query = stringValue(event.payload.query);
        const maxResults = numberValue(event.payload.maxResults) ?? numberValue(event.payload.count);
        return {
          query,
          maxResults,
          url: query ? buildArxivSearchUrl(query, { maxResults: maxResults ?? undefined }) : undefined,
          artifactId: stringValue(event.payload.artifactId),
          sourceHashes: sourceHashes(event.payload.sourceRecords),
          licenseManifestHash: stringValue(recordValue(event.payload.citationLicenseManifest).manifestHash),
          redistribution: stringValue(recordValue(event.payload.compliance).pdfAndSourceRedistribution),
          pdfOrSourceContentExported: recordValue(recordValue(event.payload.citationLicenseManifest).summary).pdfOrSourceContentExported === true
        };
      }),
    mathlib: (() => {
      const currentIndexHash = defaultMathlibTheoremIndexSnapshot().indexHash;
      return events
        .filter((event) => event.type === "source.results" && event.payload.provider === "mathlib")
        .map((event) => {
          const artifactId = stringValue(event.payload.artifactId);
          const indexHash = stringValue(event.payload.indexHash);
          return {
            artifactId,
            artifactHash: artifactHash(artifactById, artifactId),
            indexVersion: stringValue(event.payload.indexVersion),
            indexHash,
            currentIndexHash,
            drift: Boolean(indexHash && indexHash !== currentIndexHash),
            mathlibRevision: stringValue(event.payload.mathlibRevision),
            lakeManifestHash: stringValue(event.payload.lakeManifestHash),
            theoremHandles: arrayValue(event.payload.retrievedLemmas)
              .map((lemma) => recordValue(lemma))
              .filter((lemma): lemma is Record<string, unknown> => Boolean(lemma))
              .map((lemma) => ({
                name: stringValue(lemma.name),
                module: stringValue(lemma.module),
                statementHash: stringValue(lemma.statementHash),
                trustGrade: stringValue(lemma.trustGrade),
                proofSupport: recordValue(lemma.promptSummary)?.proofSupport === false ? false : undefined
              }))
          };
        });
    })(),
    remoteWorkers: events
      .filter((event) => event.type === "remote.worker.attested")
      .map((event) => {
        const artifactId = stringValue(event.payload.artifactId);
        return {
          eventId: event.id,
          workerId: stringValue(event.payload.workerId),
          artifactId,
          artifactHash: artifactHash(artifactById, artifactId),
          accepted: event.payload.ok === true,
          issues: stringArrayValue(event.payload.issues) ?? [],
          cliVersion: stringValue(event.payload.cliVersion),
          protocolVersion: numberValue(event.payload.protocolVersion),
          runtime: event.payload.runtime,
          platform: event.payload.platform,
          allowedProviders: stringArrayValue(event.payload.allowedProviders) ?? [],
          networkMode: stringValue(event.payload.networkMode),
          sandboxMode: stringValue(event.payload.sandboxMode),
          budgetEnvelopeHash: stringValue(event.payload.budgetEnvelopeHash),
          verifierToolchain: event.payload.verifierToolchain,
          codeIdentity: event.payload.codeIdentity
        };
      }),
    artifacts: artifacts.map((artifact) => ({
      id: artifact.id,
      kind: artifact.kind,
      sha256: artifact.sha256,
      contentAddress: artifact.contentAddress,
      mediaType: artifact.mediaType,
      storageKey: artifact.storageKey,
      bytes: artifact.bytes
    })),
    actionPersistence: buildActionPersistenceManifest(events, artifactById),
    eventCount: events.length,
    generatedAt: new Date().toISOString()
  };
}

function buildActionPersistenceManifest(
  events: LedgerEvent[],
  artifactById: Map<string, Artifact>
): ReplayManifest["actionPersistence"] {
  return events
    .filter((event) => ACTION_PERSISTENCE_EVENT_TYPES.has(event.type))
    .map((event) => {
      const externalOperationId = stringValue(event.payload.externalOperationId) ?? stringValue(event.payload.operationId);
      return {
        eventId: event.id,
        type: event.type,
        externalOperationId,
        jobId: stringValue(event.payload.jobId),
        artifactIds: event.artifactIds,
        artifactHashes: event.artifactIds
          .map((artifactId) => artifactHash(artifactById, artifactId))
          .filter((hash): hash is string => Boolean(hash)),
        replayable: event.artifactIds.every((artifactId) => Boolean(artifactById.get(artifactId))) &&
          (!requiresExternalOperationManifest(event.type) || Boolean(externalOperationId))
      };
    });
}

const ACTION_PERSISTENCE_EVENT_TYPES = new Set<string>([
  "artifact.created",
  "source.query",
  "source.results",
  "source.offline_cache.used",
  "source.offline_cache.missed",
  "source.license.manifest.reviewed",
  "ai.call.started",
  "ai.call.stream_chunk",
  "ai.call.step",
  "ai.call.transcript.persisted",
  "ai.call.completed",
  "ai.call.failed",
  "ai.call.aborted",
  "provider.retry.scheduled",
  "external.operation.reserved",
  "external.operation.started",
  "external.operation.completed",
  "external.operation.failed",
  "external.operation.unknown",
  "external.operation.dead_lettered",
  "external.operation.ignored",
  "external.operation.released",
  "verifier.started",
  "verifier.completed",
  "proof.certificate.minimized",
  "adversarial.quorum.reviewed",
  "loophole.assumption_delta.reviewed",
  "worker.enqueued",
  "worker.leased",
  "worker.reservation_bound",
  "worker.started",
  "worker.heartbeat",
  "worker.committed",
  "worker.completed",
  "worker.tool.started",
  "worker.tool.completed",
  "worker.tool.cancelled",
  "worker.tool.failed",
  "worker.mutation.ignored",
  "worker.failed",
  "worker.cancelled",
  "worker.reconciled",
  "worker.stale",
  "worker.revoked",
  "worker.quarantined",
  "swarm.capacity.reviewed",
  "swarm.fanout.planned",
  "swarm.coordinator.dispatched",
  "swarm.coordinator.completed",
  "swarm.coordinator.failed",
  "context.compaction.reviewed",
  "remote.worker.attested"
]);

function requiresExternalOperationManifest(type: string): boolean {
  return type.startsWith("ai.call.") ||
    type === "provider.retry.scheduled" ||
    type === "source.query" ||
    type.startsWith("worker.tool.") ||
    type.startsWith("external.operation.");
}

export function exportReproducibilityBundle(input: {
  runId: string;
  ledger: Ledger;
  cwd: string;
  config: MatematicaConfig;
  currentPolicyManifest?: VerifierPolicyManifest;
  verifyFinal?: boolean;
}): ReproducibilityBundle {
  const run = input.ledger.requireRun(input.runId);
  const pathRedactions = buildPathRedactions(input.cwd);
  const sourceEvents = input.ledger.listEvents(input.runId);
  let artifacts = buildPortableArtifacts(input.ledger.listArtifacts(input.runId), pathRedactions);
  let artifactById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  let events = buildPortableEvents(sourceEvents, artifactById, pathRedactions);
  const reportRewrite = rewritePortableReportProvenance({
    sourceEvents,
    portableEvents: events,
    portableArtifacts: artifacts,
    pathRedactions
  });
  if (reportRewrite.changed) {
    artifacts = reportRewrite.artifacts;
    artifactById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
    events = buildPortableEvents(sourceEvents, artifactById, pathRedactions, reportRewrite.eventPayloadOverrides);
  }
  const bundleBase = {
    format: "matematica.reproducibility.bundle" as const,
    version: 1 as const,
    exportedAt: new Date().toISOString(),
    run,
    redaction: {
      policy: "portable_no_secret_no_private_paths" as const,
      pathPlaceholders: ["<redacted-path>"],
      artifactPathsIncluded: false as const,
      eventHashChain: "recomputed_after_redaction" as const,
      rawPromptTextIncluded: false as const,
      rawProviderTextIncluded: false as const,
      rawSourceTextIncluded: false as const,
      rawExportRequiresExplicitConsent: true as const,
      retentionPolicy: {
        localRedactedArtifacts: "retain_until_operator_prunes_or_deletes_matematica_home" as const,
        rawArtifacts: "not_persisted" as const,
        portableExports: "operator_managed_files" as const
      }
    },
    replayTrust: buildReplayTrustContract({
      run,
      events: input.ledger.listEvents(input.runId),
      artifacts: input.ledger.listArtifacts(input.runId),
      redactedPublicExport: true
    }),
    events,
    artifacts,
    externalOperations: input.ledger.listExternalOperations(input.runId),
    scores: input.ledger.listScores(input.runId)
  };

  const expected = calculatePortableBundleExpectation({
    bundleBase,
    cwd: input.cwd,
    config: input.config,
    currentPolicyManifest: input.currentPolicyManifest,
    verifyFinal: input.verifyFinal
  });

  return {
    ...bundleBase,
    manifest: expected.manifest,
    expected: expected.expectation
  };
}

export function importReproducibilityBundle(input: {
  bundle: ReproducibilityBundle;
  ledger: Ledger;
  artifactsDir: string;
  cwd: string;
  config: MatematicaConfig;
  currentPolicyManifest?: VerifierPolicyManifest;
  verifyFinal?: boolean;
}): ReproducibilityImportResult {
  if (input.bundle.format !== "matematica.reproducibility.bundle" || input.bundle.version !== 1) {
    throw new Error("Unsupported Matematica reproducibility bundle.");
  }
  materializeReproducibilityBundle({
    bundle: input.bundle,
    ledger: input.ledger,
    artifactsDir: input.artifactsDir
  });
  const actual = calculateBundleExpectation({
    runId: input.bundle.run.id,
    ledger: input.ledger,
    cwd: input.cwd,
    config: input.config,
    currentPolicyManifest: input.currentPolicyManifest,
    verifyFinal: input.verifyFinal
  });
  const divergences: ReproducibilityImportResult["verification"]["divergences"] = [];
  compareBundleField(divergences, "reportHash", input.bundle.expected.reportHash, actual.expectation.reportHash);
  compareBundleField(divergences, "finalDecisionHash", input.bundle.expected.finalDecisionHash, actual.expectation.finalDecisionHash);
  compareBundleField(divergences, "policyHash", input.bundle.expected.policyHash, actual.expectation.policyHash);
  compareBundleField(divergences, "artifactManifestHash", input.bundle.expected.artifactManifestHash, actual.expectation.artifactManifestHash);
  compareBundleField(divergences, "providerCallManifestHash", input.bundle.expected.providerCallManifestHash, actual.expectation.providerCallManifestHash);
  compareBundleField(divergences, "citationManifestHash", input.bundle.expected.citationManifestHash, actual.expectation.citationManifestHash);
  compareBundleField(divergences, "nonReplayableStepsHash", input.bundle.expected.nonReplayableStepsHash, actual.expectation.nonReplayableStepsHash);
  compareBundleField(divergences, "eventLogHash", input.bundle.expected.eventLogHash, actual.expectation.eventLogHash);
  if (stableHash(manifestComparable(input.bundle.manifest)) !== stableHash(manifestComparable(actual.manifest))) {
    divergences.push({
      field: "manifest",
      expected: stableHash(manifestComparable(input.bundle.manifest)),
      actual: stableHash(manifestComparable(actual.manifest)),
      reason: "imported clean-home replay manifest diverged from exported portable manifest"
    });
  }

  return {
    ok: actual.replay.ok && divergences.length === 0,
    runId: input.bundle.run.id,
    imported: {
      events: input.bundle.events.length,
      artifacts: input.bundle.artifacts.length,
      externalOperations: input.bundle.externalOperations.length,
      scores: input.bundle.scores.length
    },
    verification: {
      replayOk: actual.replay.ok,
      expected: input.bundle.expected,
      actual: actual.expectation,
      divergences
    }
  };
}

export function replayOffline(input: {
  runId: string;
  ledger: Ledger;
  cwd: string;
  config: MatematicaConfig;
  verifyFinal?: boolean;
  currentPolicyManifest?: VerifierPolicyManifest;
  deterministic?: boolean;
}): OfflineReplayResult {
  const manifest = buildReplayManifest(input);
  const audit = auditRun(input.runId, input.ledger);
  const events = input.ledger.listEvents(input.runId);
  const finalVerification = input.verifyFinal
    ? verifyFinalReplay({ ...input, audit })
    : undefined;
  const nonReplayableSteps = buildOfflineReplayNonReplayableSteps(events);
  const selfContained = evaluateOfflineSelfContainedGate({
    runId: input.runId,
    ledger: input.ledger,
    manifest,
    audit,
    events,
    nonReplayableSteps
  });
  const deterministic = input.deterministic
    ? buildDeterministicReplayContract({
        events,
        artifacts: input.ledger.listArtifacts(input.runId),
        manifest,
        nonReplayableSteps,
        finalDecisionRecomputed: Boolean(finalVerification)
      })
    : undefined;

  return {
    ok: audit.ok && selfContained.ok && (finalVerification?.ok ?? true),
    runId: input.runId,
    manifest,
    audit,
    selfContained,
    finalVerification,
    deterministic,
    replayedEvents: events.length,
    nonReplayableSteps
  };
}

export function verifyFinalReplay(input: {
  runId: string;
  ledger: Ledger;
  cwd: string;
  config: MatematicaConfig;
  audit?: AuditResult;
  currentPolicyManifest?: VerifierPolicyManifest;
}): FinalReplayVerification {
  const run = input.ledger.requireRun(input.runId);
  const events = input.ledger.listEvents(input.runId);
  const artifacts = input.ledger.listArtifacts(input.runId);
  const audit = input.audit ?? auditRun(input.runId, input.ledger);
  const pinnedPolicy = loadRunVerifierPolicyManifest(input.runId, input.ledger);
  const currentPolicy = input.currentPolicyManifest ?? buildVerifierPolicyManifest();
  const divergences: ReplayDivergence[] = [];
  if (!audit.ok) {
    divergences.push({
      kind: "audit",
      actual: audit,
      reason: "run audit failed before final replay verification"
    });
  }

  const terminalEvent = [...events].reverse().find((event) => event.type === "goal.completed" || event.type === "goal.failed");
  const strongTerminal = requiresVerifierBackedTerminalEvidence(run, terminalEvent);
  const policyEvent = [...events].reverse().find((event) => event.type === "policy.manifest.pinned");
  if (strongTerminal && !pinnedPolicy) {
    divergences.push({
      kind: "policy_manifest",
      expected: "policy.manifest.pinned event with valid policy.verifier.manifest artifact",
      actual: undefined,
      reason: "terminal verifier-backed answer is missing the run-pinned verifier policy manifest required for final replay"
    });
  }
  if (pinnedPolicy && policyEvent) {
    validatePinnedPolicyEvent({ policyEvent, pinnedPolicy, divergences });
  }
  const replayPolicy = pinnedPolicy?.manifest ?? currentPolicy;

  const evidenceGateEvent = [...events].reverse().find((event) =>
    event.type === "verifier.completed" &&
    event.payload.verifier === "evidence-gate"
  );
  if (strongTerminal && !evidenceGateEvent) {
    divergences.push({
      kind: "evidence_gate",
      expected: "verifier.completed evidence-gate event",
      actual: undefined,
      reason: "terminal verifier-backed answer is missing an evidence-gate event"
    });
  }
  if (strongTerminal && evidenceGateEvent && !isRecord(evidenceGateEvent.payload.claim)) {
    divergences.push({
      kind: "evidence_gate",
      expected: "persisted evidence-gate claim",
      actual: evidenceGateEvent.payload.claim,
      reason: "terminal verifier-backed answer is missing the persisted claim required for final replay"
    });
  }
  if (strongTerminal && evidenceGateEvent && !isRecord(evidenceGateEvent.payload.gate)) {
    divergences.push({
      kind: "evidence_gate",
      expected: "persisted evidence-gate decision",
      actual: evidenceGateEvent.payload.gate,
      reason: "terminal verifier-backed answer is missing the persisted evidence-gate decision required for final replay"
    });
  }

  const claim = evidenceGateEvent && isRecord(evidenceGateEvent.payload.claim)
    ? evidenceGateEvent.payload.claim as FormalClaimContract
    : undefined;
  if (claim && evidenceGateEvent) {
    validateClaimArtifactLinks({ claim, evidenceGateEvent, events, divergences });
  }
  const recomputedGate = claim
    ? evaluateEvidenceGate(claim, {
        trustedVerifiers: replayPolicy.trustedVerifiers,
        artifacts
      })
    : undefined;
  const persistedGateHash = evidenceGateEvent && isRecord(evidenceGateEvent.payload.gate)
    ? stableHash(evidenceEventComparable(evidenceGateEvent.payload.gate))
    : undefined;
  const recomputedGateHash = recomputedGate
    ? stableHash(evidenceEventComparable(recomputedGate))
    : undefined;
  if (evidenceGateEvent && persistedGateHash !== recomputedGateHash) {
    divergences.push({
      kind: "evidence_gate",
      expected: persistedGateHash,
      actual: recomputedGateHash,
      reason: "recomputed evidence gate decision diverged from persisted gate event"
    });
  }
  if (strongTerminal && recomputedGate && !recomputedGate.canMarkGoalMet) {
    divergences.push({
      kind: "evidence_gate",
      expected: true,
      actual: recomputedGate,
      reason: "terminal verifier-backed answer does not pass recomputed evidence gate"
    });
  }

  const goalSuccessEvent = [...events].reverse().find((event) => event.type === "goal.success.evaluated");
  const problemClassification = classificationForRun(run, events);
  const claimGraphEvent = [...events].reverse().find((event) => event.type === "claim.graph.reviewed");
  const candidateArtifactIds = evidenceGateEvent?.artifactIds
    .filter((artifactId) => artifactId !== evidenceGateEvent.payload.policyArtifactId)
    ?? [];
  const claimGraphArtifactId = claimGraphEvent ? stringValue(claimGraphEvent.payload.artifactId) : undefined;
  const replayCandidateArtifactIds = claimGraphArtifactId
    ? [...new Set([...candidateArtifactIds, claimGraphArtifactId])]
    : candidateArtifactIds;
  const replayedClaimGraph = claim && claimGraphEvent
    ? replayClaimGraphDecision({
        claim,
        claimGraphEvent,
        events,
        artifacts,
        divergences
      })
    : undefined;
  if (strongTerminal && !claimGraphEvent) {
    divergences.push({
      kind: "claim_graph",
      expected: "claim.graph.reviewed event",
      actual: undefined,
      reason: "terminal verifier-backed answer is missing a claim graph review"
    });
  }
  const recomputedGoalSuccess = claim && recomputedGate
    ? evaluateGoalSuccess({
        run,
        claim,
        gate: recomputedGate,
        problemClassification,
        candidateArtifactIds: replayCandidateArtifactIds,
        claimGraph: replayedClaimGraph
      })
    : undefined;
  const persistedGoalSuccessHash = goalSuccessEvent
    ? stableHash(goalSuccessComparable(goalSuccessEvent.payload))
    : undefined;
  const recomputedGoalSuccessHash = recomputedGoalSuccess
    ? stableHash(goalSuccessComparable(recomputedGoalSuccess))
    : undefined;
  if (strongTerminal && !goalSuccessEvent) {
    divergences.push({
      kind: "goal_success",
      expected: "goal.success.evaluated event",
      actual: undefined,
      reason: "terminal verifier-backed answer is missing the persisted goal success evaluation"
    });
  }
  if (goalSuccessEvent && persistedGoalSuccessHash !== recomputedGoalSuccessHash) {
    divergences.push({
      kind: "goal_success",
      expected: persistedGoalSuccessHash,
      actual: recomputedGoalSuccessHash,
      reason: "recomputed goal success policy diverged from persisted goal.success.evaluated event"
    });
  }
  if (strongTerminal && recomputedGoalSuccess && recomputedGoalSuccess.status !== "goal_met") {
    divergences.push({
      kind: "goal_success",
      expected: "goal_met",
      actual: recomputedGoalSuccess,
      reason: "terminal goal_met answer does not pass full recomputed goal success policy"
    });
  }
  if (strongTerminal && terminalEvent && recomputedGoalSuccess) {
    compareField(
      divergences,
      "goal_success",
      "terminal satisfyingArtifactIds",
      terminalEvent.payload.satisfyingArtifactIds,
      recomputedGoalSuccess.satisfyingArtifactIds
    );
  }

  const proofEvent = [...events].reverse().find((event) => event.type === "proof.obligations.reviewed");
  if (strongTerminal && !proofEvent) {
    divergences.push({
      kind: "proof_obligations",
      expected: "proof.obligations.reviewed event",
      actual: undefined,
      reason: "terminal verifier-backed answer is missing a proof-obligation review event"
    });
  }
  const proofArtifactId = proofEvent ? stringValue(proofEvent.payload.artifactId) : undefined;
  const proofArtifact = proofArtifactId ? artifacts.find((artifact) => artifact.id === proofArtifactId) : undefined;
  let persistedProofDecisionHash: string | undefined;
  let persistedProofTraceHash: string | undefined;
  let recomputedProofDecisionHash: string | undefined;
  let recomputedProofTraceHash: string | undefined;
  let recomputedProofDecisionOk: boolean | undefined;
  if (proofEvent && !proofArtifact) {
    divergences.push({
      kind: "missing_artifact",
      expected: proofArtifactId,
      reason: "proof-obligation review event references a missing artifact"
    });
  }
  if (proofArtifact) {
    try {
      const parsed = JSON.parse(readArtifactText(proofArtifact)) as {
        claimId?: string;
        graph?: ProofObligationGraph;
        decision?: unknown;
        trace?: unknown;
      };
      if (claim && parsed.claimId && parsed.claimId !== claim.id) {
        divergences.push({
          kind: "proof_obligations",
          expected: claim.id,
          actual: parsed.claimId,
          reason: "proof-obligation artifact claim id diverges from evidence-gate claim"
        });
      }
      if (!parsed.graph) {
        divergences.push({
          kind: "invalid_artifact",
          actual: proofArtifact.id,
        reason: "proof-obligation artifact is missing graph"
      });
      } else {
        if (claim?.proofObligationGraph && stableHash(claim.proofObligationGraph) !== stableHash(parsed.graph)) {
          divergences.push({
            kind: "proof_obligations",
            expected: stableHash(parsed.graph),
            actual: stableHash(claim.proofObligationGraph),
            reason: "evidence-gate claim proof-obligation graph diverges from persisted proof-obligation artifact graph"
          });
        }
        const evidenceGrade = claim?.evidenceGrade ?? run.evidenceGrade;
        const recomputedDecision = evaluateProofObligationGraph(parsed.graph, artifacts, {
          evidenceGrade,
          requireCounterexampleSearch: evidenceGrade === "formal_proof",
          events
        });
        const recomputedTrace = traceProofObligations(parsed.graph);
        recomputedProofDecisionOk = recomputedDecision.ok;
        persistedProofDecisionHash = stableHash(parsed.decision);
        persistedProofTraceHash = stableHash(parsed.trace);
        recomputedProofDecisionHash = stableHash(recomputedDecision);
        recomputedProofTraceHash = stableHash(recomputedTrace);
        if (persistedProofDecisionHash !== recomputedProofDecisionHash) {
          divergences.push({
            kind: "proof_obligations",
            expected: persistedProofDecisionHash,
            actual: recomputedProofDecisionHash,
            reason: "recomputed proof-obligation decision diverged from persisted proof artifact"
          });
        }
        if (persistedProofTraceHash !== recomputedProofTraceHash) {
          divergences.push({
            kind: "proof_obligations",
            expected: persistedProofTraceHash,
            actual: recomputedProofTraceHash,
            reason: "recomputed proof-obligation trace diverged from persisted proof artifact"
          });
        }
        if (strongTerminal && !recomputedDecision.ok) {
          divergences.push({
            kind: "proof_obligations",
            expected: true,
            actual: recomputedDecision,
            reason: "terminal verifier-backed answer does not pass recomputed proof-obligation review"
          });
        }
      }
    } catch (error) {
      divergences.push({
        kind: "invalid_artifact",
        actual: proofArtifact.id,
        reason: `proof-obligation artifact could not be parsed: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  }

  const independentBudgetUsage = budgetUsageFromEvents(events);
  const ledgerBudgetUsage = input.ledger.getBudgetUsage(input.runId);
  if (stableHash(independentBudgetUsage) !== stableHash(ledgerBudgetUsage)) {
    divergences.push({
      kind: "budget_totals",
      expected: ledgerBudgetUsage,
      actual: independentBudgetUsage,
      reason: "independently replayed budget totals diverged from ledger budget usage"
    });
  }
  const oracle = replayTerminalOutcomeOracle({
    run,
    events,
    artifacts,
    terminalEvent,
    strongTerminal,
    renderedReportText: renderReport(input.runId, input.ledger),
    schemaVersion: input.ledger.schemaVersion()
  });
  divergences.push(...oracle.divergences);

  const finalOutcome = run.status === "goal_met" && recomputedGoalSuccess && recomputedProofDecisionOk === true
    ? {
        state: recomputedGoalSuccess.finalState,
        canClaimSolved: recomputedGoalSuccess.canClaimSolved,
        reason: recomputedGoalSuccess.reason
      }
    : deriveFinalOutcomeForReplay({
        run,
        gate: recomputedGate,
        proofDecisionOk: recomputedProofDecisionOk,
        budgetUsage: independentBudgetUsage
      });
  if (terminalEvent) {
    compareField(divergences, "final_outcome", "terminal status", terminalEvent.payload.status, run.status);
    compareField(divergences, "final_outcome", "terminal evidenceGrade", terminalEvent.payload.evidenceGrade, run.evidenceGrade);
    compareField(divergences, "final_outcome", "terminal finalState", terminalEvent.payload.finalState, finalOutcome.state);
    compareField(divergences, "final_outcome", "terminal canClaimSolved", terminalEvent.payload.canClaimSolved, finalOutcome.canClaimSolved);
  } else if (run.status === "goal_met" || run.status === "budget_exhausted" || run.status === "needs_human_review" || run.status === "cancelled" || run.status === "failed") {
    divergences.push({
      kind: "final_outcome",
      expected: "goal.completed or goal.failed event",
      actual: undefined,
      reason: "terminal run is missing a terminal event"
    });
  }

  const reportIdempotencyKey = reportGenerationIdempotencyKey(input.runId, input.ledger);
  const reportText = oracle.renderedReportText;
  if (!reportText.includes(`Report idempotency key: ${reportIdempotencyKey}`)) {
    divergences.push({
      kind: "report_summary",
      expected: reportIdempotencyKey,
      reason: "rendered report does not include recomputed report idempotency key"
    });
  }
  if (!reportText.includes(`Final outcome: ${finalOutcome.state}`)) {
    divergences.push({
      kind: "report_summary",
      expected: finalOutcome.state,
      reason: "rendered report final outcome does not match recomputed final outcome"
    });
  }

  return {
    ok: divergences.length === 0,
    divergences,
    recomputed: {
      finalOutcome: {
        state: finalOutcome.state,
        canClaimSolved: finalOutcome.canClaimSolved,
        reason: finalOutcome.reason
      },
      evidenceGateHash: recomputedGateHash,
      goalSuccessHash: recomputedGoalSuccessHash,
      proofObligationDecisionHash: recomputedProofDecisionHash,
      proofObligationTraceHash: recomputedProofTraceHash,
      reportIdempotencyKey,
      reportHash: stableHash(reportText),
      budgetUsage: independentBudgetUsage,
      oracle: oracle.summary,
      policy: {
        artifactId: pinnedPolicy?.artifactId,
        pinnedPolicyHash: pinnedPolicy?.manifest.policyHash,
        currentPolicyHash: currentPolicy.policyHash,
        drift: Boolean(pinnedPolicy && pinnedPolicy.manifest.policyHash !== currentPolicy.policyHash),
        trustedVerifierIds: replayPolicy.trustedVerifiers.map((verifier) => verifier.id)
      }
    },
    persisted: {
      terminal: terminalEvent?.payload,
      evidenceGateHash: persistedGateHash,
      goalSuccessHash: persistedGoalSuccessHash,
      proofObligationDecisionHash: persistedProofDecisionHash,
      proofObligationTraceHash: persistedProofTraceHash,
      budgetUsage: ledgerBudgetUsage
    }
  };
}

function deriveFinalOutcomeForReplay(input: {
  run: GoalRun;
  gate?: { canMarkGoalMet: boolean };
  proofDecisionOk?: boolean;
  budgetUsage: BudgetUsage;
}): FinalOutcome {
  if (input.run.status === "goal_met") {
    if (
      evidenceSatisfiesGoal(input.run.evidenceGrade) &&
      input.gate?.canMarkGoalMet === true &&
      input.proofDecisionOk === true
    ) {
      if (input.run.evidenceGrade === "verified_counterexample") {
        return {
          state: "counterexample",
          canClaimSolved: false,
          reason: "A verifier-backed counterexample was independently replayed."
        };
      }
      if (input.run.evidenceGrade === "formal_proof") {
        return {
          state: "formal_proof",
          canClaimSolved: true,
          reason: "A formal proof passed independently replayed evidence-gate and proof-obligation checks."
        };
      }
      return {
        state: "computational_evidence",
        canClaimSolved: true,
        reason: "Verified computation passed independently replayed evidence-gate and proof-obligation checks."
      };
    }
    return {
      state: "inconclusive",
      canClaimSolved: false,
      reason: "Goal-met status is not supported by independently replayed verifier evidence."
    };
  }
  if (input.run.status === "budget_exhausted") {
    return {
      state: "budget_exhausted",
      canClaimSolved: false,
      reason: `Budget exhausted before replayed verifier-backed success; replayed usage ${stableHash(input.budgetUsage)}.`
    };
  }
  if (input.run.status === "cancelled") {
    return {
      state: "cancelled",
      canClaimSolved: false,
      reason: "The run was cancelled before verifier-backed success was established."
    };
  }
  if (input.run.status === "needs_human_review") {
    return {
      state: "partial",
      canClaimSolved: false,
      reason: "The run requires human review before any verifier-backed success claim can be made."
    };
  }
  if (input.run.status === "failed") {
    return {
      state: "failed",
      canClaimSolved: false,
      reason: "The run failed before verifier-backed success was established."
    };
  }
  return {
    state: "inconclusive",
    canClaimSolved: false,
    reason: "The run is not terminal or lacks independently replayed verifier-backed evidence."
  };
}

function requiresVerifierBackedTerminalEvidence(run: GoalRun, terminalEvent?: LedgerEvent): boolean {
  const finalState = terminalEvent?.payload.finalState;
  return (
    run.status === "goal_met" ||
    evidenceSatisfiesGoal(run.evidenceGrade) ||
    terminalEvent?.payload.status === "goal_met" ||
    finalState === "formal_proof" ||
    finalState === "computational_evidence" ||
    finalState === "counterexample" ||
    finalState === "solved_verified" ||
    finalState === "disproved"
  );
}

function replayTerminalOutcomeOracle(input: {
  run: GoalRun;
  events: LedgerEvent[];
  artifacts: Artifact[];
  terminalEvent?: LedgerEvent;
  strongTerminal: boolean;
  renderedReportText: string;
  schemaVersion: number;
}): {
  summary: ReplayOracleSummary;
  divergences: ReplayDivergence[];
  renderedReportText: string;
} {
  const divergences: ReplayDivergence[] = [];
  verifyEventHashChain(input, divergences);
  const artifactRootHash = verifyArtifactBytes(input.artifacts, divergences);
  verifyTerminalEventOrder(input, divergences);
  verifyProviderRoutingOracle(input, divergences);
  verifyWorkerLeaseOracle(input.events, divergences);
  verifyProofCertificateOracle(input, divergences);
  verifyReportGenerationOracle(input, divergences);
  return {
    renderedReportText: input.renderedReportText,
    divergences,
    summary: {
      eventCount: input.events.length,
      artifactCount: input.artifacts.length,
      terminalEventCount: terminalOutcomeEvents(input.events).length,
      workerMutationCount: input.events.filter((event) => event.type.startsWith("worker.")).length,
      providerRouteCount: input.events.filter((event) => event.type === "ai.call.completed").length,
      proofCertificateCount: input.events.filter((event) => event.type === "proof.certificate.minimized").length,
      ledgerHeadHash: input.events.at(-1)?.eventHash,
      artifactRootHash
    }
  };
}

function verifyEventHashChain(
  input: { run: GoalRun; events: LedgerEvent[]; schemaVersion: number },
  divergences: ReplayDivergence[]
): void {
  let previousEventHash: string | undefined;
  const seenSequences = new Set<number>();
  for (const [index, event] of input.events.entries()) {
    if (event.sequence !== undefined) {
      if (seenSequences.has(event.sequence)) {
        divergences.push({
          kind: "ledger_hash_chain",
          actual: event.sequence,
          reason: "ledger event sequence is duplicated during replay oracle recomputation"
        });
      }
      seenSequences.add(event.sequence);
      if (event.sequence !== index) {
        divergences.push({
          kind: "ledger_hash_chain",
          expected: index,
          actual: event.sequence,
          reason: "ledger event sequence is not contiguous during replay oracle recomputation"
        });
      }
    }
    if (event.previousEventHash !== previousEventHash) {
      divergences.push({
        kind: "ledger_hash_chain",
        expected: previousEventHash,
        actual: event.previousEventHash,
        reason: "ledger previous-event hash diverged during replay oracle recomputation"
      });
    }
    const payloadHash = stableHash(event.payload);
    if (event.payloadHash !== payloadHash) {
      divergences.push({
        kind: "ledger_hash_chain",
        expected: event.payloadHash,
        actual: payloadHash,
        reason: "ledger payload hash diverged during replay oracle recomputation"
      });
    }
    const recomputedHash = computeLedgerEventHash({
      runId: input.run.id,
      type: event.type,
      payload: event.payload,
      artifactIds: event.artifactIds,
      sequence: event.sequence ?? index,
      schemaVersion: event.schemaVersion ?? input.schemaVersion,
      linkedArtifactHashes: event.linkedArtifactHashes,
      previousEventHash
    });
    if (event.eventHash !== recomputedHash) {
      divergences.push({
        kind: "ledger_hash_chain",
        expected: event.eventHash,
        actual: recomputedHash,
        reason: "ledger event hash diverged during replay oracle recomputation"
      });
    }
    previousEventHash = recomputedHash;
  }
}

function verifyArtifactBytes(artifacts: Artifact[], divergences: ReplayDivergence[]): string {
  const hashes: Array<{ artifactId: string; sha256?: string }> = [];
  for (const artifact of artifacts) {
    if (!existsSync(artifact.path)) {
      divergences.push({
        kind: "missing_artifact",
        expected: artifact.id,
        actual: artifact.path,
        reason: "artifact file is missing during replay oracle recomputation"
      });
      hashes.push({ artifactId: artifact.id, sha256: artifact.sha256 });
      continue;
    }
    const actual = createHash("sha256").update(readFileSync(artifact.path)).digest("hex");
    hashes.push({ artifactId: artifact.id, sha256: actual });
    if (artifact.sha256 !== actual) {
      divergences.push({
        kind: "artifact_hash",
        expected: artifact.sha256,
        actual,
        reason: `artifact ${artifact.id} bytes diverged from ledger artifact hash`
      });
    }
  }
  return stableHash(hashes.sort((left, right) => left.artifactId.localeCompare(right.artifactId)));
}

function verifyTerminalEventOrder(
  input: { run: GoalRun; events: LedgerEvent[]; terminalEvent?: LedgerEvent; strongTerminal: boolean },
  divergences: ReplayDivergence[]
): void {
  const terminalEvents = terminalOutcomeEvents(input.events);
  if (terminalEvents.length > 1) {
    divergences.push({
      kind: "terminal_order",
      expected: 1,
      actual: terminalEvents.map((event) => ({ id: event.id, type: event.type, sequence: event.sequence })),
      reason: "terminal outcome oracle found multiple terminal outcome events"
    });
  }
  if (!input.terminalEvent) return;
  if (input.terminalEvent.runId !== input.run.id) {
    divergences.push({
      kind: "terminal_order",
      expected: input.run.id,
      actual: input.terminalEvent.runId,
      reason: "terminal event belongs to another run"
    });
  }
  const evidenceTypes = new Set([
    "verifier.completed",
    "goal.success.evaluated",
    "proof.obligations.reviewed",
    "claim.graph.reviewed",
    "proof.certificate.minimized"
  ]);
  const terminalSequence = input.terminalEvent.sequence ?? Number.POSITIVE_INFINITY;
  const lateEvidence = input.events.filter((event) =>
    evidenceTypes.has(event.type) &&
    (event.sequence ?? -1) > terminalSequence
  );
  if (lateEvidence.length > 0) {
    divergences.push({
      kind: "terminal_order",
      expected: "all terminal evidence before terminal outcome",
      actual: lateEvidence.map((event) => ({ id: event.id, type: event.type, sequence: event.sequence })),
      reason: "terminal evidence was injected or reordered after the terminal outcome event"
    });
  }
  if (input.strongTerminal) {
    for (const required of evidenceTypes) {
      if (!input.events.some((event) => event.type === required && (event.sequence ?? -1) < terminalSequence)) {
        divergences.push({
          kind: "terminal_order",
          expected: required,
          reason: `terminal verifier-backed outcome is missing prior ${required} evidence`
        });
      }
    }
  }
}

function verifyProviderRoutingOracle(input: { events: LedgerEvent[]; artifacts: Artifact[] }, divergences: ReplayDivergence[]): void {
  const artifactById = new Map(input.artifacts.map((artifact) => [artifact.id, artifact]));
  for (const event of input.events) {
    if (event.type !== "ai.call.completed") continue;
    const responseArtifactId = stringValue(event.payload.responseArtifactId);
    const responseArtifact = responseArtifactId ? artifactById.get(responseArtifactId) : undefined;
    if (!responseArtifact) {
      divergences.push({
        kind: "provider_routing",
        expected: responseArtifactId,
        reason: "provider completion event is missing its response artifact for route replay"
      });
      continue;
    }
    try {
      const response = JSON.parse(readArtifactText(responseArtifact));
      const provenance = recordValue(response.providerProvenance);
      compareField(divergences, "provider_routing", "provider route requested provider", provenance.requestedProvider, event.payload.provider);
      compareField(divergences, "provider_routing", "provider route requested model", provenance.requestedModel, event.payload.modelId);
      compareField(divergences, "provider_routing", "provider route silent fallback", provenance.silentFallbackAllowed, false);
      compareField(divergences, "provider_routing", "provider route matrix", recordValue(response.providerMatrix).matrixHash, recordValue(event.payload.providerMatrix).matrixHash);
    } catch (error) {
      divergences.push({
        kind: "provider_routing",
        actual: responseArtifact.id,
        reason: `provider response artifact could not be parsed for route replay: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  }
}

function verifyWorkerLeaseOracle(events: LedgerEvent[], divergences: ReplayDivergence[]): void {
  const jobs = new Map<string, { status: string; owner?: string; attempt: number }>();
  for (const event of events) {
    if (event.type === "worker.enqueued") {
      const jobId = stringValue(event.payload.jobId);
      if (jobId) jobs.set(jobId, { status: "pending", attempt: 0 });
      continue;
    }
    if (!event.type.startsWith("worker.")) continue;
    const jobId = stringValue(event.payload.jobId);
    if (!jobId) continue;
    const state = jobs.get(jobId) ?? { status: "unknown", attempt: 0 };
    if (event.type === "worker.leased") {
      const attempt = numberValue(event.payload.attempts) ?? state.attempt + 1;
      if (attempt !== state.attempt + 1) {
        divergences.push({
          kind: "worker_lease",
          expected: state.attempt + 1,
          actual: attempt,
          reason: "worker lease attempt does not advance from replayed worker state"
        });
      }
      jobs.set(jobId, { status: "leased", owner: stringValue(event.payload.owner), attempt });
      continue;
    }
    if (event.type === "worker.reservation_bound") {
      if (state.status !== "leased") {
        divergences.push({
          kind: "worker_lease",
          expected: "leased",
          actual: state,
          reason: "worker.reservation_bound is not backed by a replayed lease"
        });
      }
      continue;
    }
    if (event.type === "worker.started" || event.type === "worker.heartbeat") {
      const owner = stringValue(event.payload.owner);
      if ((state.status !== "leased" && state.status !== "running") || !state.owner || state.owner !== owner) {
        divergences.push({
          kind: "worker_lease",
          expected: state,
          actual: event.payload,
          reason: `${event.type} is not backed by an active replayed worker lease`
        });
      }
      jobs.set(jobId, { status: event.type === "worker.started" ? "running" : state.status, owner: state.owner, attempt: state.attempt });
      continue;
    }
    if (event.type === "worker.stale") {
      if (state.status !== "leased" && state.status !== "running") {
        divergences.push({
          kind: "worker_lease",
          expected: "leased|running",
          actual: state,
          reason: "worker.stale is not backed by an active replayed worker lease"
        });
      }
      jobs.set(jobId, { status: "stale", owner: state.owner, attempt: state.attempt });
      continue;
    }
    if (event.type === "worker.revoked" || event.type === "worker.cancelled" || event.type === "worker.reconciled") {
      jobs.set(jobId, { status: event.type === "worker.reconciled" ? "failed" : "cancelled", attempt: state.attempt });
      continue;
    }
    if (event.type === "worker.committed" || event.type === "worker.completed" || event.type === "worker.failed") {
      if (state.status !== "leased" && state.status !== "running" && !(event.type === "worker.completed" && state.status === "committed")) {
        divergences.push({
          kind: "worker_lease",
          expected: state,
          actual: event.payload,
          reason: `${event.type} is not backed by an active replayed worker lease`
        });
      }
      if (event.type === "worker.committed") jobs.set(jobId, { status: "committed", attempt: state.attempt });
      if (event.type === "worker.completed") jobs.set(jobId, { status: "completed", attempt: state.attempt });
      if (event.type === "worker.failed") jobs.set(jobId, { status: "failed", attempt: state.attempt });
    }
  }
}

function verifyProofCertificateOracle(
  input: { events: LedgerEvent[]; artifacts: Artifact[]; strongTerminal: boolean },
  divergences: ReplayDivergence[]
): void {
  const certificateEvents = input.events.filter((event) => event.type === "proof.certificate.minimized");
  if (input.strongTerminal && certificateEvents.length === 0) {
    divergences.push({
      kind: "proof_certificate",
      expected: "proof.certificate.minimized",
      reason: "strong terminal outcome is missing a minimized proof certificate"
    });
  }
  const artifactById = new Map(input.artifacts.map((artifact) => [artifact.id, artifact]));
  for (const event of certificateEvents) {
    const artifactId = stringValue(event.payload.artifactId) ?? event.artifactIds.find((id) => artifactById.get(id)?.kind === "proof.certificate");
    const artifact = artifactId ? artifactById.get(artifactId) : undefined;
    if (!artifact) {
      divergences.push({
        kind: "proof_certificate",
        expected: artifactId,
        reason: "proof certificate event references a missing certificate artifact"
      });
      continue;
    }
    try {
      const certificate = JSON.parse(readArtifactText(artifact)) as Record<string, unknown>;
      const certificateHash = stringValue(certificate.certificateHash);
      const unsigned = { ...certificate };
      delete unsigned.certificateHash;
      const recomputedHash = stableHash(unsigned);
      compareField(divergences, "proof_certificate", "proof certificate hash", certificateHash, recomputedHash);
      compareField(divergences, "proof_certificate", "proof certificate event hash", stringValue(event.payload.certificateHash), certificateHash);
      if (input.strongTerminal) {
        compareField(divergences, "proof_certificate", "proof certificate status", certificate.status, "passed");
        compareField(divergences, "proof_certificate", "proof certificate clean-home replay", recordValue(certificate.offlineReplay).verified, true);
      }
    } catch (error) {
      divergences.push({
        kind: "proof_certificate",
        actual: artifact.id,
        reason: `proof certificate artifact could not be parsed: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  }
}

function verifyReportGenerationOracle(
  input: { events: LedgerEvent[]; artifacts: Artifact[]; renderedReportText: string },
  divergences: ReplayDivergence[]
): void {
  const artifactById = new Map(input.artifacts.map((artifact) => [artifact.id, artifact]));
  const renderedReportHash = stableHash(input.renderedReportText);
  for (const event of input.events) {
    if (event.type !== "report.generated") continue;
    const snapshotArtifactId = stringValue(event.payload.snapshotArtifactId);
    const reportInputHash = stringValue(event.payload.reportInputHash);
    const snapshotHash = stringValue(event.payload.snapshotHash);
    if (!snapshotArtifactId || !snapshotHash || !reportInputHash) {
      divergences.push({
        kind: "report_summary",
        expected: "snapshotArtifactId, snapshotHash, and reportInputHash",
        actual: event.id,
        reason: "report.generated event is missing immutable run snapshot provenance"
      });
    }
    const snapshotArtifact = snapshotArtifactId ? artifactById.get(snapshotArtifactId) : undefined;
    if (snapshotArtifactId && !snapshotArtifact) {
      divergences.push({
        kind: "missing_artifact",
        expected: snapshotArtifactId,
        reason: "report.generated event references a missing run snapshot artifact"
      });
    }
    if (snapshotArtifact) {
      const snapshot = existsSync(snapshotArtifact.path)
        ? parseJsonObject(readArtifactText(snapshotArtifact))
        : {};
      compareField(divergences, "report_summary", "report snapshot hash", snapshotHash, stableHash(snapshot));
      compareField(divergences, "report_summary", "report snapshot input hash", reportInputHash, stringValue(snapshot.reportInputHash));
      compareField(divergences, "report_summary", "report snapshot regenerated flag", event.payload.regenerated, false);
      compareField(divergences, "report_summary", "report snapshot artifact sha256", event.payload.snapshotArtifactSha256, snapshotArtifact.sha256);
    }
    const eventReportHash = stringValue(event.payload.reportHash);
    if (eventReportHash && !snapshotArtifactId) {
      compareField(divergences, "report_summary", "report.generated reportHash", eventReportHash, renderedReportHash);
    }
    const artifactId = stringValue(event.payload.artifactId);
    if (!artifactId) continue;
    const artifact = artifactById.get(artifactId);
    if (!artifact) {
      divergences.push({
        kind: "missing_artifact",
        expected: artifactId,
        reason: "report.generated event references a missing report artifact"
      });
      continue;
    }
    const artifactHash = existsSync(artifact.path)
      ? stableHash(readArtifactText(artifact))
      : undefined;
    compareField(divergences, "report_summary", "persisted report artifact hash", artifactHash, eventReportHash ?? renderedReportHash);
  }
}

function terminalOutcomeEvents(events: LedgerEvent[]): LedgerEvent[] {
  return events.filter((event) => event.type === "goal.completed" || event.type === "goal.failed");
}

function compareField(
  divergences: ReplayDivergence[],
  kind: ReplayDivergence["kind"],
  label: string,
  expected: unknown,
  actual: unknown
): void {
  if (stableHash(expected) === stableHash(actual)) return;
  divergences.push({
    kind,
    expected,
    actual,
    reason: `${label} diverged during final replay verification`
  });
}

function replayClaimGraphDecision(input: {
  claim: FormalClaimContract;
  claimGraphEvent: LedgerEvent;
  events: LedgerEvent[];
  artifacts: Artifact[];
  divergences: ReplayDivergence[];
}): ClaimGraphDecision | undefined {
  const artifactId = stringValue(input.claimGraphEvent.payload.artifactId);
  const artifact = artifactId ? input.artifacts.find((item) => item.id === artifactId) : undefined;
  if (!artifact) {
    input.divergences.push({
      kind: "missing_artifact",
      expected: artifactId,
      reason: "claim graph review event references a missing artifact"
    });
    return undefined;
  }
  let persistedDecision: ClaimGraphDecision | undefined;
  try {
    persistedDecision = JSON.parse(readArtifactText(artifact)) as ClaimGraphDecision;
  } catch (error) {
    input.divergences.push({
      kind: "invalid_artifact",
      actual: artifact.id,
      reason: `claim graph review artifact could not be parsed: ${error instanceof Error ? error.message : String(error)}`
    });
    return undefined;
  }
  const recomputed = evaluateClaimGraph({
    claims: [{
      claim: input.claim,
      artifactIds: input.claimGraphEvent.artifactIds.filter((item) => item !== artifact.id)
    }],
    targetClaimId: stringValue(input.claimGraphEvent.payload.targetClaimId) ?? input.claim.id,
    retractions: extractClaimRetractions(input.events)
  });
  compareField(
    input.divergences,
    "claim_graph",
    "claim graph event decision",
    input.claimGraphEvent.payload.decision,
    persistedDecision
  );
  compareField(
    input.divergences,
    "claim_graph",
    "claim graph recomputation",
    persistedDecision,
    recomputed
  );
  return recomputed;
}

function validatePinnedPolicyEvent(input: {
  policyEvent: LedgerEvent;
  pinnedPolicy: {
    manifest: VerifierPolicyManifest;
    artifactId: string;
  };
  divergences: ReplayDivergence[];
}): void {
  compareField(
    input.divergences,
    "policy_manifest",
    "pinned policy artifactId",
    input.policyEvent.payload.artifactId,
    input.pinnedPolicy.artifactId
  );
  compareField(
    input.divergences,
    "policy_manifest",
    "pinned policy hash",
    input.policyEvent.payload.policyHash,
    input.pinnedPolicy.manifest.policyHash
  );
  compareField(
    input.divergences,
    "policy_manifest",
    "pinned policy version",
    input.policyEvent.payload.policyVersion,
    input.pinnedPolicy.manifest.policyVersion
  );
  compareField(
    input.divergences,
    "policy_manifest",
    "pinned evidence gate version",
    input.policyEvent.payload.evidenceGateVersion,
    input.pinnedPolicy.manifest.evidenceGateVersion
  );
  compareField(
    input.divergences,
    "policy_manifest",
    "pinned proof obligation rules version",
    input.policyEvent.payload.proofObligationRulesVersion,
    input.pinnedPolicy.manifest.proofObligationRulesVersion
  );
  compareField(
    input.divergences,
    "policy_manifest",
    "pinned problem classifier version",
    input.policyEvent.payload.problemClassifierVersion,
    input.pinnedPolicy.manifest.problemClassifierVersion
  );
  compareField(
    input.divergences,
    "policy_manifest",
    "pinned final outcome mapping version",
    input.policyEvent.payload.finalOutcomeMappingVersion,
    input.pinnedPolicy.manifest.finalOutcomeMappingVersion
  );
  compareField(
    input.divergences,
    "policy_manifest",
    "pinned trusted verifier ids",
    sortedStringArray(input.policyEvent.payload.trustedVerifierIds),
    input.pinnedPolicy.manifest.trustedVerifiers.map((verifier) => verifier.id).sort()
  );
}

function validateClaimArtifactLinks(input: {
  claim: FormalClaimContract;
  evidenceGateEvent: LedgerEvent;
  events: LedgerEvent[];
  divergences: ReplayDivergence[];
}): void {
  const linkedArtifactIds = new Set(input.evidenceGateEvent.artifactIds);
  for (const artifactId of claimArtifactIds(input.claim)) {
    if (!linkedArtifactIds.has(artifactId)) {
      input.divergences.push({
        kind: "evidence_gate",
        expected: [...linkedArtifactIds],
        actual: artifactId,
        reason: "evidence-gate claim references an artifact that is not linked to the evidence-gate event"
      });
    }
  }

  for (const artifactId of input.claim.verifierArtifactIds) {
    if (!hasVerifierCompletionEvent({
      events: input.events,
      verifierId: input.claim.verifierId,
      evidenceGrade: input.claim.evidenceGrade,
      artifactId
    })) {
      input.divergences.push({
        kind: "evidence_gate",
        expected: {
          verifier: input.claim.verifierId,
          evidenceGrade: input.claim.evidenceGrade,
          artifactId
        },
        reason: "primary verifier artifact is not backed by a matching verifier.completed event"
      });
    }
  }

  for (const supporting of input.claim.supportingVerifierResults ?? []) {
    for (const artifactId of supporting.artifactIds) {
      if (!hasVerifierCompletionEvent({
        events: input.events,
        verifierId: supporting.verifierId,
        evidenceGrade: supporting.evidenceGrade,
        artifactId,
        role: supporting.role
      })) {
        input.divergences.push({
          kind: "evidence_gate",
          expected: {
            verifier: supporting.verifierId,
            evidenceGrade: supporting.evidenceGrade,
            role: supporting.role,
            artifactId
          },
          reason: "supporting verifier artifact is not backed by a matching verifier.completed event"
        });
      }
    }
  }
}

function claimArtifactIds(claim: FormalClaimContract): string[] {
  const graphArtifactIds = claim.proofObligationGraph?.obligations.flatMap((obligation) => [
    ...obligation.artifactIds,
    ...(obligation.counterexampleSearches?.flatMap((search) => search.artifactIds) ?? []),
    obligation.reproducibility?.executableArtifactId,
    obligation.reproducibility?.independentRerunArtifactId
  ]) ?? [];
  return [...new Set([
    ...claim.verifierArtifactIds,
    ...(claim.supportingVerifierResults?.flatMap((result) => result.artifactIds) ?? []),
    claim.formalization?.artifactId,
    ...graphArtifactIds
  ].filter((item): item is string => typeof item === "string" && item.length > 0))];
}

function hasVerifierCompletionEvent(input: {
  events: LedgerEvent[];
  verifierId: string;
  evidenceGrade: EvidenceGrade;
  artifactId: string;
  role?: string;
}): boolean {
  return input.events.some((event) =>
    event.type === "verifier.completed" &&
    event.payload.verifier === input.verifierId &&
    event.payload.evidenceGrade === input.evidenceGrade &&
    event.payload.artifactId === input.artifactId &&
    event.artifactIds.includes(input.artifactId) &&
    (input.role === undefined || event.payload.role === input.role)
  );
}

function sortedStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").sort()
    : [];
}

function evidenceEventComparable(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return {
    canMarkGoalMet: value.canMarkGoalMet,
    reason: value.reason,
    quorum: value.quorum,
    proofObligations: value.proofObligations,
    formalizationGap: value.formalizationGap
  };
}

function budgetUsageFromEvents(events: LedgerEvent[]): BudgetUsage {
  const usage = emptyBudgetUsage();
  const openReservations = new Map<string, BudgetUsage>();
  const reservationMatches = new Map<string, boolean>();
  for (const event of events) {
    const reservationId = stringValue(event.payload.reservationId);
    if (event.type === "budget.reserved") {
      const reserve = budgetUsageFromPayload(event.payload.reserve);
      if (reservationId) {
        reservationMatches.set(reservationId, true);
        openReservations.set(reservationId, reserve);
      }
    }
    if (event.type === "budget.released") {
      if (reservationId) openReservations.delete(reservationId);
    }
    if (event.type === "budget.debited") {
      if (reservationId) openReservations.delete(reservationId);
      const matches = !reservationId || reservationMatches.get(reservationId) === true;
      if (matches) addBudgetUsage(usage, budgetUsageFromPayload(event.payload.debit));
    }
    if (event.type === "artifact.created") {
      usage.artifactBytes += numberValue(event.payload.bytes) ?? 0;
    }
    if (event.type === "source.query") {
      usage.sourceQueries += 1;
    }
    if (event.type === "provider.retry.scheduled") {
      usage.retries += 1;
    }
  }
  for (const reservation of openReservations.values()) addBudgetUsage(usage, reservation);
  return usage;
}

function budgetUsageFromPayload(value: unknown): BudgetUsage {
  if (!isRecord(value)) return emptyBudgetUsage();
  return {
    attempts: numberValue(value.attempts) ?? 0,
    tokens: numberValue(value.tokens) ?? 0,
    usd: numberValue(value.usd) ?? 0,
    elapsedMs: numberValue(value.elapsedMs) ?? 0,
    artifactBytes: numberValue(value.artifactBytes) ?? 0,
    sourceQueries: numberValue(value.sourceQueries) ?? 0,
    retries: numberValue(value.retries) ?? 0,
    sandboxMs: numberValue(value.sandboxMs) ?? 0
  };
}

function addBudgetUsage(target: BudgetUsage, usage: BudgetUsage): void {
  target.attempts += usage.attempts;
  target.tokens += usage.tokens;
  target.usd += usage.usd;
  target.elapsedMs += usage.elapsedMs;
  target.artifactBytes += usage.artifactBytes;
  target.sourceQueries += usage.sourceQueries;
  target.retries += usage.retries;
  target.sandboxMs += usage.sandboxMs;
}

function emptyBudgetUsage(): BudgetUsage {
  return {
    attempts: 0,
    tokens: 0,
    usd: 0,
    elapsedMs: 0,
    artifactBytes: 0,
    sourceQueries: 0,
    retries: 0,
    sandboxMs: 0
  };
}

function buildDeterministicReplayContract(input: {
  events: LedgerEvent[];
  artifacts: ReturnType<Ledger["listArtifacts"]>;
  manifest: ReplayManifest;
  nonReplayableSteps: Array<{ eventId: string; type: string; reason: string }>;
  finalDecisionRecomputed: boolean;
}): DeterministicReplayContract {
  const artifactById = new Map(input.artifacts.map((artifact) => [artifact.id, artifact]));
  const stateTransitions = input.events.map((event) => ({
    sequence: event.sequence,
    eventId: event.id,
    type: event.type,
    payloadHash: event.payloadHash ?? stableHash(event.payload),
    artifactIds: event.artifactIds,
    linkedArtifactHashes: event.linkedArtifactHashes,
    schemaVersion: event.schemaVersion,
    previousEventHash: event.previousEventHash,
    eventHash: event.eventHash
  }));
  const operationById = new Map(input.manifest.externalOperations.map((operation) => [operation.id, operation]));
  const externalEffects = input.nonReplayableSteps.map((step) => {
    const event = input.events.find((item) => item.id === step.eventId);
    const externalOperationId = stringValue(event?.payload.externalOperationId) ?? stringValue(event?.payload.operationId);
    const operation = externalOperationId ? operationById.get(externalOperationId) : undefined;
    const requestArtifactId = stringValue(event?.payload.requestArtifactId) ?? operation?.requestArtifactId;
    const responseArtifactId = stringValue(event?.payload.responseArtifactId) ?? operation?.responseArtifactId;
    const retryAttemptOperationId = stringValue(event?.payload.retryAttemptOperationId);
    const retryAttemptOperation = retryAttemptOperationId ? operationById.get(retryAttemptOperationId) : undefined;
    const transcriptArtifactId = stringValue(event?.payload.transcriptArtifactId);
    const stepArtifactIds = stringArrayValue(event?.payload.stepArtifactIds);
    const streamChunkArtifactIds = stringArrayValue(event?.payload.streamChunkArtifactIds);
    return {
      eventId: step.eventId,
      type: step.type,
      reason: step.reason,
      provider: stringValue(event?.payload.provider) ?? operation?.provider,
      modelId: stringValue(event?.payload.modelId),
      requestHash: stringValue(event?.payload.requestHash) ?? operation?.requestHash,
      requestArtifactId,
      requestArtifactHash: artifactHash(artifactById, requestArtifactId),
      responseArtifactId,
      responseArtifactHash: artifactHash(artifactById, responseArtifactId),
      transcriptArtifactId,
      transcriptArtifactHash: artifactHash(artifactById, transcriptArtifactId),
      stepArtifactIds,
      stepArtifactHashes: stepArtifactIds
        ?.map((artifactId) => artifactHash(artifactById, artifactId))
        .filter((hash): hash is string => Boolean(hash)),
      streamChunkArtifactIds,
      streamChunkArtifactHashes: streamChunkArtifactIds
        ?.map((artifactId) => artifactHash(artifactById, artifactId))
        .filter((hash): hash is string => Boolean(hash)),
      idempotencyKey: operation?.idempotencyKey,
      retryOfOperationId: operation?.retryOfOperationId,
      retryAttemptOperationId,
      retryReservationId: stringValue(event?.payload.retryReservationId) ?? retryAttemptOperation?.reservationId,
      failedAttempt: numberValue(event?.payload.failedAttempt),
      nextAttempt: numberValue(event?.payload.nextAttempt),
      attempt: operation?.attempt
    };
  });
  return {
    mode: "forensic_deterministic",
    semantics: "Replay reconstructs ledger state, artifacts, external-effect boundaries, and final decisions from persisted data; nondeterministic providers and network calls are not executed again.",
    networkPolicy: "no_new_network_or_provider_calls",
    redactionPolicy: "persisted_redacted_artifacts_only",
    finalDecisionRecomputed: input.finalDecisionRecomputed,
    eventLogHash: stableHash(stateTransitions),
    artifactManifestHash: stableHash(input.manifest.artifacts),
    stateTransitions,
    externalEffects,
    aiSdkLoopModes: buildAiSdkLoopReplayHarness(input.events, input.artifacts)
  };
}

export function buildAiSdkLoopReplayHarness(
  events: LedgerEvent[],
  artifacts: Artifact[]
): AiSdkLoopReplayHarness {
  const artifactById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const aiEvents = events.filter((event) => event.type.startsWith("ai.call."));
  const callIds = uniqueStrings(aiEvents.map((event) => stringValue(event.payload.callId)).filter((id): id is string => Boolean(id)));
  const calls = callIds.map((callId) => buildAiSdkLoopReplayCall(callId, aiEvents, artifactById));
  const canonicalShapeHashes = calls.map((call) => call.canonicalShapeHash);
  return {
    format: "matematica.ai-sdk-loop-replay-harness",
    version: 1,
    calls,
    canonicalShapeHashes,
    equivalentCanonicalShape: canonicalShapeHashes.length <= 1 || new Set(canonicalShapeHashes).size === 1
  };
}

function buildAiSdkLoopReplayCall(
  callId: string,
  aiEvents: LedgerEvent[],
  artifactById: Map<string, Artifact>
): AiSdkLoopReplayCall {
  const events = aiEvents.filter((event) => event.payload.callId === callId);
  const started = events.find((event) => event.type === "ai.call.started");
  const transcript = events.find((event) => event.type === "ai.call.transcript.persisted");
  const terminal = [...events].reverse().find((event) =>
    event.type === "ai.call.completed" ||
    event.type === "ai.call.failed" ||
    event.type === "ai.call.aborted"
  );
  const stepEvents = events
    .filter((event) => event.type === "ai.call.step")
    .sort((left, right) => numericValue(left.payload.stepIndex) - numericValue(right.payload.stepIndex));
  const streamEvents = events
    .filter((event) => event.type === "ai.call.stream_chunk")
    .sort((left, right) => numericValue(left.payload.chunkIndex) - numericValue(right.payload.chunkIndex));
  const stepArtifactIds = stepEvents.map((event) => stringValue(event.payload.stepArtifactId)).filter((id): id is string => Boolean(id));
  const streamChunkArtifactIds = streamEvents.map((event) => stringValue(event.payload.streamChunkArtifactId)).filter((id): id is string => Boolean(id));
  const requestArtifactId = stringValue(started?.payload.requestArtifactId) ?? stringValue(transcript?.payload.requestArtifactId) ?? stringValue(terminal?.payload.requestArtifactId);
  const responseArtifactId = stringValue(transcript?.payload.responseArtifactId) ?? stringValue(terminal?.payload.responseArtifactId);
  const errorArtifactId = stringValue(transcript?.payload.errorArtifactId) ?? stringValue(terminal?.payload.errorArtifactId);
  const transcriptArtifactId = stringValue(transcript?.payload.transcriptArtifactId) ?? stringValue(terminal?.payload.transcriptArtifactId);
  const canonicalShape = {
    started: Boolean(started),
    terminalStatus: terminalStatusFor(transcript, terminal),
    terminalEventType: terminal?.type,
    stepCount: stepEvents.length,
    streamChunkCount: streamEvents.length,
    finishReason: stringValue(transcript?.payload.finishReason) ?? stringValue(terminal?.payload.finishReason),
    stopConditionHash: stableHash(recordValue(transcript?.payload.stopCondition ?? terminal?.payload.stopCondition)),
    usageKeys: Object.keys(recordValue(transcript?.payload.usage ?? terminal?.payload.usage)).sort(),
    usageTotalTokens: numberValue(recordValue(transcript?.payload.usage ?? terminal?.payload.usage).totalTokens),
    toolCallCount: numericValue(transcript?.payload.toolCallCount ?? terminal?.payload.toolCallCount),
    toolResultCount: numericValue(transcript?.payload.toolResultCount ?? terminal?.payload.toolResultCount),
    steps: stepEvents.map((event, index) => ({
      index,
      finishReason: stringValue(event.payload.finishReason),
      stopReason: stringValue(event.payload.stopReason),
      toolCallCount: numericValue(event.payload.toolCallCount),
      toolResultCount: numericValue(event.payload.toolResultCount),
      hasMessages: event.payload.hasMessages === true,
      hasPrepareStepChanges: event.payload.hasPrepareStepChanges === true
    })),
    streamChunks: streamEvents.map((event, index) => ({
      index,
      chunkType: stringValue(event.payload.chunkType),
      hasTextDelta: event.payload.hasTextDelta === true,
      finishReason: stringValue(event.payload.finishReason),
      stopReason: stringValue(event.payload.stopReason),
      toolCallDeltaCount: numericValue(event.payload.toolCallDeltaCount),
      toolResultDeltaCount: numericValue(event.payload.toolResultDeltaCount)
    })),
    errorName: stringValue(transcript?.payload.errorName) ?? stringValue(terminal?.payload.errorName),
    providerFailureKind: stringValue(recordValue(transcript?.payload.providerFailure ?? terminal?.payload.providerFailure).kind)
  };
  return {
    callId,
    externalOperationId: stringValue(started?.payload.externalOperationId) ?? stringValue(transcript?.payload.externalOperationId) ?? stringValue(terminal?.payload.externalOperationId),
    provider: stringValue(started?.payload.provider) ?? stringValue(transcript?.payload.provider) ?? stringValue(terminal?.payload.provider),
    modelId: stringValue(started?.payload.modelId) ?? stringValue(transcript?.payload.modelId) ?? stringValue(terminal?.payload.modelId),
    terminalStatus: canonicalShape.terminalStatus as AiSdkLoopReplayCall["terminalStatus"],
    requestArtifactHash: artifactHash(artifactById, requestArtifactId),
    responseArtifactHash: artifactHash(artifactById, responseArtifactId),
    transcriptArtifactHash: artifactHash(artifactById, transcriptArtifactId),
    errorArtifactHash: artifactHash(artifactById, errorArtifactId),
    stepArtifactHashes: stepArtifactIds.map((artifactId) => artifactHash(artifactById, artifactId)).filter((hash): hash is string => Boolean(hash)),
    streamChunkArtifactHashes: streamChunkArtifactIds.map((artifactId) => artifactHash(artifactById, artifactId)).filter((hash): hash is string => Boolean(hash)),
    canonicalShape,
    canonicalShapeHash: stableHash(canonicalShape)
  };
}

function terminalStatusFor(transcript?: LedgerEvent, terminal?: LedgerEvent): AiSdkLoopReplayCall["terminalStatus"] {
  const status = stringValue(transcript?.payload.status);
  if (status === "completed" || status === "failed" || status === "aborted") return status;
  if (terminal?.type === "ai.call.completed") return "completed";
  if (terminal?.type === "ai.call.failed") return "failed";
  if (terminal?.type === "ai.call.aborted") return "aborted";
  if (!terminal && transcript === undefined) return "started_only";
  return "unknown";
}

function buildPortableArtifacts(artifacts: Artifact[], pathRedactions: string[]): ReproducibilityBundle["artifacts"] {
  return artifacts.map((artifact) => {
    assertPortableArtifactRedistributionAllowed(artifact);
    const redactedContent = redactPortableText(readArtifactText(artifact), pathRedactions);
    const sha256 = createHash("sha256").update(redactedContent).digest("hex");
    return {
      id: artifact.id,
      runId: artifact.runId,
      kind: artifact.kind,
      sha256,
      contentAddress: artifactContentAddress(sha256),
      mediaType: artifact.mediaType,
      storageKey: artifactStorageKey(artifact.runId, sha256),
      bytes: Buffer.byteLength(redactedContent),
      createdAt: artifact.createdAt,
      provenance: portableArtifactProvenance({
        sha256,
        bytes: Buffer.byteLength(redactedContent),
        contentAddress: artifactContentAddress(sha256),
        mediaType: artifact.mediaType,
        storageKey: artifactStorageKey(artifact.runId, sha256)
      }),
      contentBase64: Buffer.from(redactedContent, "utf8").toString("base64")
    };
  });
}

function assertPortableArtifactRedistributionAllowed(artifact: Artifact): void {
  const forbiddenArxivPayloadKinds = new Set([
    "source.arxiv.pdf",
    "source.arxiv.source",
    "source.arxiv.eprint",
    "source.arxiv.fulltext"
  ]);
  if (forbiddenArxivPayloadKinds.has(artifact.kind)) {
    throw new Error(`Refusing to export ${artifact.kind} artifact ${artifact.id}; arXiv PDF/source content is not portable without an explicit license grant.`);
  }
}

function buildPortableEvents(
  events: LedgerEvent[],
  artifactById: Map<string, ReproducibilityBundle["artifacts"][number]>,
  pathRedactions: string[],
  payloadOverrides: Map<string, Record<string, unknown>> = new Map()
): ReproducibilityBundle["events"] {
  let previousEventHash: string | undefined;
  return events.map((event, index) => {
    const sequence = index;
    const payload = payloadOverrides.get(event.id) ??
      redactPortableValue(event.payload, pathRedactions) as Record<string, unknown>;
    if (event.type === "artifact.created") {
      const artifactId = stringValue(payload.artifactId);
      const artifact = artifactId ? artifactById.get(artifactId) : undefined;
      if (artifact) {
        payload.sha256 = artifact.sha256;
        payload.contentAddress = artifact.contentAddress;
        payload.mediaType = artifact.mediaType;
        payload.storageKey = artifact.storageKey;
        payload.bytes = artifact.bytes;
        payload.provenance = artifact.provenance;
      }
      delete payload.path;
    }
    const linkedArtifactHashes = event.artifactIds.map((artifactId) => ({
      artifactId,
      sha256: artifactById.get(artifactId)?.sha256
    }));
    const schemaVersion = event.schemaVersion ?? 1;
    if (event.type === "goal.completed" || event.type === "goal.failed") {
      payload.terminalIntegrity = {
        chainVersion: 1,
        previousEventHash: previousEventHash ?? null,
        artifactRoot: stableHash(linkedArtifactHashes),
        schemaVersion
      };
    }
    const payloadHash = stableHash(payload);
    const eventHash = computeLedgerEventHash({
      runId: event.runId,
      type: event.type,
      payload,
      artifactIds: event.artifactIds,
      sequence,
      payloadHash,
      linkedArtifactHashes,
      schemaVersion,
      previousEventHash
    });
    const portable = {
      id: event.id,
      runId: event.runId,
      type: event.type,
      payload,
      artifactIds: event.artifactIds,
      createdAt: event.createdAt,
      sequence,
      payloadHash,
      linkedArtifactHashes,
      schemaVersion,
      previousEventHash,
      eventHash
    };
    previousEventHash = eventHash;
    return portable;
  });
}

function rewritePortableReportProvenance(input: {
  sourceEvents: LedgerEvent[];
  portableEvents: ReproducibilityBundle["events"];
  portableArtifacts: ReproducibilityBundle["artifacts"];
  pathRedactions: string[];
}): {
  changed: boolean;
  artifacts: ReproducibilityBundle["artifacts"];
  eventPayloadOverrides: Map<string, Record<string, unknown>>;
} {
  const portableEventById = new Map(input.portableEvents.map((event) => [event.id, event]));
  const artifacts = input.portableArtifacts.map((artifact) => ({ ...artifact }));
  const artifactById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const eventPayloadOverrides = new Map<string, Record<string, unknown>>();
  let changed = false;

  for (const event of input.sourceEvents) {
    if (event.type !== "report.generated") continue;
    const snapshotArtifactId = stringValue(event.payload.snapshotArtifactId);
    const reportArtifactId = stringValue(event.payload.reportArtifactId) ?? stringValue(event.payload.artifactId);
    if (!snapshotArtifactId || !reportArtifactId) continue;
    const snapshotArtifact = artifactById.get(snapshotArtifactId);
    const reportArtifact = artifactById.get(reportArtifactId);
    if (!snapshotArtifact || !reportArtifact) continue;

    const originalSnapshot = parseJsonObject(Buffer.from(snapshotArtifact.contentBase64, "base64").toString("utf8"));
    if (originalSnapshot.format !== "matematica.run-report-snapshot") continue;
    const reportText = Buffer.from(reportArtifact.contentBase64, "base64").toString("utf8");
    const reportHash = stableHash(reportText);
    const sourceEvents = recordArray(originalSnapshot.sourceEvents).map((sourceEvent) => {
      const portable = portableEventById.get(stringValue(sourceEvent.id) ?? "");
      return portable
        ? {
            id: portable.id,
            type: portable.type,
            sequence: portable.sequence,
            eventHash: portable.eventHash,
            payloadHash: portable.payloadHash,
            artifactIds: [...portable.artifactIds]
          }
        : sourceEvent;
    });
    const artifactManifest = recordArray(originalSnapshot.artifactManifest).map((manifestArtifact) => {
      const portable = artifactById.get(stringValue(manifestArtifact.id) ?? "");
      return portable
        ? {
            id: portable.id,
            kind: portable.kind,
            sha256: portable.sha256,
            contentAddress: portable.contentAddress,
            mediaType: portable.mediaType,
            storageKey: portable.storageKey,
            bytes: portable.bytes
          }
        : manifestArtifact;
    });
    const reportInput = {
      runId: originalSnapshot.runId,
      sourceEventRange: recordValue(originalSnapshot.sourceEventRange),
      ledgerHeadEventHash: stringValue(sourceEvents[sourceEvents.length - 1]?.eventHash),
      eventCount: sourceEvents.length,
      sourceEvents,
      artifactManifest,
      artifactManifestHash: stableHash(artifactManifest),
      externalOperations: recordArray(originalSnapshot.externalOperations),
      budgetSettlement: recordValue(originalSnapshot.budgetSettlement),
      replayMode: "forensic_deterministic" as const,
      regenerated: false as const
    };
    const snapshot = {
      format: "matematica.run-report-snapshot" as const,
      version: 1 as const,
      ...reportInput,
      reportInputHash: stableHash(reportInput),
      reportHash
    };
    const snapshotHash = stableHash(snapshot);
    const updatedSnapshotArtifact = rewritePortableArtifactContent(snapshotArtifact, JSON.stringify(snapshot, null, 2));
    artifactById.set(updatedSnapshotArtifact.id, updatedSnapshotArtifact);
    const artifactIndex = artifacts.findIndex((artifact) => artifact.id === updatedSnapshotArtifact.id);
    if (artifactIndex >= 0) artifacts[artifactIndex] = updatedSnapshotArtifact;

    const payload = redactPortableValue(event.payload, input.pathRedactions) as Record<string, unknown>;
    payload.snapshotHash = snapshotHash;
    payload.snapshotArtifactSha256 = updatedSnapshotArtifact.sha256;
    payload.reportInputHash = snapshot.reportInputHash;
    payload.reportHash = reportHash;
    payload.sourceEventRange = snapshot.sourceEventRange;
    payload.sourceEventCount = snapshot.eventCount;
    payload.ledgerHeadEventHash = snapshot.ledgerHeadEventHash;
    payload.regenerated = false;
    eventPayloadOverrides.set(event.id, payload);
    changed = true;
  }

  return { changed, artifacts, eventPayloadOverrides };
}

function rewritePortableArtifactContent(
  artifact: ReproducibilityBundle["artifacts"][number],
  content: string
): ReproducibilityBundle["artifacts"][number] {
  const sha256 = createHash("sha256").update(content).digest("hex");
  const bytes = Buffer.byteLength(content);
  const contentAddress = artifactContentAddress(sha256);
  const storageKey = artifactStorageKey(artifact.runId, sha256);
  return {
    ...artifact,
    sha256,
    contentAddress,
    storageKey,
    bytes,
    provenance: portableArtifactProvenance({
      sha256,
      bytes,
      contentAddress,
      mediaType: artifact.mediaType,
      storageKey
    }),
    contentBase64: Buffer.from(content, "utf8").toString("base64")
  };
}

function calculateBundleExpectation(input: {
  runId: string;
  ledger: Ledger;
  cwd: string;
  config: MatematicaConfig;
  currentPolicyManifest?: VerifierPolicyManifest;
  verifyFinal?: boolean;
}): {
  manifest: ReplayManifest;
  replay: OfflineReplayResult;
  expectation: ReproducibilityBundleExpectation;
} {
  const manifest = buildReplayManifest(input);
  const replay = replayOffline({
    ...input,
    verifyFinal: input.verifyFinal ?? true,
    deterministic: true
  });
  const finalDecision = replay.finalVerification?.recomputed.finalOutcome;
  const expectation: ReproducibilityBundleExpectation = {
    reportHash: replay.finalVerification?.recomputed.reportHash ?? stableHash(renderReport(input.runId, input.ledger)),
    finalDecisionHash: finalDecision ? stableHash(finalDecision) : undefined,
    policyHash: replay.finalVerification?.recomputed.policy.pinnedPolicyHash ?? manifest.verifierPolicy.policyHash,
    artifactManifestHash: stableHash(manifest.artifacts),
    providerCallManifestHash: stableHash({
      externalOperations: manifest.externalOperations,
      providers: manifest.providers
    }),
    citationManifestHash: stableHash({ arxiv: manifest.arxiv, mathlib: manifest.mathlib }),
    nonReplayableStepsHash: stableHash(replay.nonReplayableSteps),
    eventLogHash: replay.deterministic?.eventLogHash,
    finalVerification: replay.finalVerification
  };
  return { manifest, replay, expectation };
}

function materializeReproducibilityBundle(input: {
  bundle: Omit<ReproducibilityBundle, "manifest" | "expected"> | ReproducibilityBundle;
  ledger: Ledger;
  artifactsDir: string;
}): void {
  const run = input.bundle.run;
  if (input.ledger.getRun(run.id)) {
    throw new Error(`Goal run already exists in import ledger: ${run.id}`);
  }
  const artifactPaths = new Map<string, string>();
  const runArtifactDir = join(input.artifactsDir, run.id);
  mkdirSync(runArtifactDir, { recursive: true });
  for (const artifact of input.bundle.artifacts) {
    const content = Buffer.from(artifact.contentBase64, "base64");
    const sha256 = createHash("sha256").update(content).digest("hex");
    if (sha256 !== artifact.sha256) {
      throw new Error(`Bundle artifact ${artifact.id} hash mismatch before import.`);
    }
    const artifactPath = join(runArtifactDir, `${artifact.sha256}.txt`);
    writeFileSync(artifactPath, content, { mode: 0o600 });
    artifactPaths.set(artifact.id, artifactPath);
  }

  const insert = input.ledger.db.transaction(() => {
    input.ledger.db.query(`
      INSERT INTO goal_runs (
        id, problem, goal, success_criteria, workflow, budget_json,
        status, evidence_grade, created_at, updated_at, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      run.id,
      run.problem,
      run.goal,
      JSON.stringify(run.successCriteria),
      run.workflow,
      JSON.stringify(run.budget),
      run.status,
      run.evidenceGrade,
      run.createdAt,
      run.updatedAt,
      run.startedAt ?? null,
      run.completedAt ?? null
    );

    for (const artifact of input.bundle.artifacts) {
      const artifactPath = artifactPaths.get(artifact.id);
      if (!artifactPath) throw new Error(`Bundle artifact ${artifact.id} was not materialized before import.`);
      input.ledger.db.query(`
        INSERT INTO artifacts (
          id, run_id, kind, sha256, content_address, media_type, storage_key,
          path, bytes, created_at, provenance_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        artifact.id,
        artifact.runId,
        artifact.kind,
        artifact.sha256,
        artifact.contentAddress,
        artifact.mediaType,
        artifact.storageKey,
        artifactPath,
        artifact.bytes,
        artifact.createdAt,
        JSON.stringify(artifact.provenance)
      );
    }

    for (const event of input.bundle.events) {
      input.ledger.db.query(`
        INSERT INTO ledger_events (
          id, run_id, type, payload_json, artifact_ids_json, created_at, sequence,
          payload_hash, linked_artifact_hashes_json, schema_version,
          previous_event_hash, event_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        event.id,
        event.runId,
        event.type,
        JSON.stringify(event.payload),
        JSON.stringify(event.artifactIds),
        event.createdAt,
        event.sequence,
        event.payloadHash,
        JSON.stringify(event.linkedArtifactHashes),
        event.schemaVersion,
        event.previousEventHash ?? null,
        event.eventHash
      );
    }

    input.ledger.db.query(`
      INSERT INTO run_event_counters (run_id, next_sequence)
      VALUES (?, ?)
      ON CONFLICT(run_id) DO UPDATE SET next_sequence = excluded.next_sequence
    `).run(run.id, input.bundle.events.length);

    for (const operation of input.bundle.externalOperations) {
      input.ledger.db.query(`
        INSERT INTO external_operations (
          id, run_id, operation_type, provider, idempotency_key, request_hash,
          request_artifact_id, response_artifact_id, reservation_id, status,
          retry_of_operation_id, attempt, error_message, created_at, started_at,
          completed_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        operation.id,
        operation.runId,
        operation.operationType,
        operation.provider ?? null,
        operation.idempotencyKey,
        operation.requestHash,
        operation.requestArtifactId ?? null,
        operation.responseArtifactId ?? null,
        operation.reservationId,
        operation.status,
        operation.retryOfOperationId ?? null,
        operation.attempt,
        operation.errorMessage ?? null,
        operation.createdAt,
        operation.startedAt ?? null,
        operation.completedAt ?? null,
        operation.updatedAt
      );
    }

    for (const score of input.bundle.scores) {
      input.ledger.db.query(`
        INSERT INTO scores (id, run_id, subject_id, scorer, score, rubric_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        score.id,
        score.runId,
        score.subjectId,
        score.scorer,
        score.score,
        JSON.stringify(score.rubric),
        score.createdAt
      );
    }
  });
  insert();
  input.ledger.refreshLedgerWitness(run.id);
}

function calculatePortableBundleExpectation(input: {
  bundleBase: Omit<ReproducibilityBundle, "manifest" | "expected">;
  cwd: string;
  config: MatematicaConfig;
  currentPolicyManifest?: VerifierPolicyManifest;
  verifyFinal?: boolean;
}): { manifest: ReplayManifest; expectation: ReproducibilityBundleExpectation } {
  const home = mkdtempSync(join(tmpdir(), "matematica-repro-export-"));
  const dbPath = join(home, "matematica.sqlite");
  const artifactsDir = join(home, "artifacts");
  const ledger = new Ledger(dbPath);
  try {
    materializeReproducibilityBundle({
      bundle: input.bundleBase,
      ledger,
      artifactsDir
    });
    const calculated = calculateBundleExpectation({
      runId: input.bundleBase.run.id,
      ledger,
      cwd: input.cwd,
      config: input.config,
      currentPolicyManifest: input.currentPolicyManifest,
      verifyFinal: input.verifyFinal
    });
    return {
      manifest: calculated.manifest,
      expectation: calculated.expectation
    };
  } finally {
    ledger.close();
    rmSync(home, { recursive: true, force: true });
  }
}

function compareBundleField(
  divergences: ReproducibilityImportResult["verification"]["divergences"],
  field: keyof ReproducibilityBundleExpectation,
  expected: unknown,
  actual: unknown
): void {
  if (stableHash(expected) === stableHash(actual)) return;
  divergences.push({
    field,
    expected,
    actual,
    reason: `${String(field)} diverged during clean-home bundle import`
  });
}

function manifestComparable(manifest: ReplayManifest): Record<string, unknown> {
  const { generatedAt: _generatedAt, ...rest } = manifest;
  return {
    ...rest,
    config: {
      ...rest.config,
      providers: rest.config.providers.map((provider) => {
        const {
          configured: _configured,
          redactedApiKey: _redactedApiKey,
          baseUrl: _baseUrl,
          ...portableProvider
        } = provider;
        return portableProvider;
      })
    }
  };
}

function buildPathRedactions(cwd: string): string[] {
  return [
    process.env.MATEMATICA_HOME,
    cwd,
    homedir()
  ].filter((value): value is string => typeof value === "string" && value.length > 1);
}

function redactPortableValue(value: unknown, pathRedactions: string[]): unknown {
  const redacted = redactJson(value);
  if (typeof redacted === "string") return redactPortableText(redacted, pathRedactions);
  if (Array.isArray(redacted)) return redacted.map((item) => redactPortableValue(item, pathRedactions));
  if (!isRecord(redacted)) return redacted;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(redacted)) {
    if (key === "path") continue;
    output[key] = redactPortableValue(item, pathRedactions);
  }
  return output;
}

function redactPortableText(value: string, pathRedactions: string[]): string {
  let output = redactText(value);
  for (const path of pathRedactions) {
    output = output.split(path).join("<redacted-path>");
  }
  return output;
}

function portableArtifactProvenance(input: {
  sha256: string;
  bytes: number;
  contentAddress: string;
  mediaType: string;
  storageKey: string;
}): Record<string, unknown> {
  return {
    version: 1,
    redactionPolicyVersion: "portable-redacted-artifact-v1",
    contentAddress: input.contentAddress,
    mediaType: input.mediaType,
    storageKey: input.storageKey,
    raw: {
      persisted: false,
      unavailableReason: "Portable bundle includes redacted artifact bytes only."
    },
    redacted: {
      sha256: input.sha256,
      bytes: input.bytes,
      contentAddress: input.contentAddress,
      mediaType: input.mediaType
    }
  };
}

function artifactHash(
  artifactById: Map<string, ReturnType<Ledger["listArtifacts"]>[number]>,
  artifactId?: string
): string | undefined {
  return artifactId ? artifactById.get(artifactId)?.sha256 : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sourceHashes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => item && typeof item === "object" ? (item as Record<string, unknown>).contentHash : undefined)
    .filter((item): item is string => typeof item === "string" && item.length > 0);
}

function recordValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function recordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => isRecord(item))
    : [];
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function numericValue(value: unknown): number {
  return numberValue(value) ?? 0;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function stringArrayValue(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}
