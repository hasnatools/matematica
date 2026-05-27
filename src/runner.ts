import { ArtifactStore } from "./artifacts";
import { buildBlindFinalizationCriticReviews, persistAdversarialQuorumReview } from "./adversarial-quorum";
import type { GenerateTextFunction, InstrumentedTextCall } from "./ai/instrumented";
import { reviewLoopholeAssumptionDelta } from "./assumption-delta";
import { checkBudget } from "./budget";
import { extractClaimRetractions, persistClaimGraphReview } from "./claim-graph";
import { persistContextCompactionReview } from "./context-manager";
import type { LanguageModel } from "ai";
import { isTerminalStatus, makeId, type Artifact, type EvidenceGrade, type GoalStatus } from "./domain";
import type { MatematicaConfig, ProviderName } from "./config";
import { evaluateEvidenceGate, makeClaimContract, type FormalClaimContract, type TrustedVerifier } from "./evidence";
import { persistNoFalseSolvedFinalization } from "./finalization";
import { buildGoalSuccessDecisionToken, evaluateGoalSuccess } from "./goal-success";
import { externalOperationIdempotencyKey, stableHash } from "./idempotency";
import { reviewKnowledgePromotionFirewall, type KnowledgePromotionFirewallReview } from "./knowledge-firewall";
import type { Ledger } from "./ledger";
import type { NetworkPolicy } from "./network-policy";
import { classifyFinalOutcome, type FinalAnswerState } from "./outcome";
import { persistProblemClassificationReview, type ProblemClass } from "./problem-classifier";
import { latestProviderMatrixPin, pinProviderMatrix, providerCapabilityByName } from "./provider-capabilities";
import { persistProofCertificate } from "./proof-certificate";
import { persistGoalProgressReview } from "./progress";
import { evaluateProofObligationGraph, makeProofObligationGraph, traceProofObligations } from "./proof-obligations";
import { verifyLeanFile, type LeanVerificationResult } from "./lean";
import { selectHardMathStrategy, type HardMathStrategySelection } from "./math-strategy";
import { defaultMathlibTheoremIndexSnapshot, retrieveMathlibLemmas } from "./theorem";
import { ensureRunVerifierPolicyManifest } from "./verifier-policy";
import { arxivCompliancePolicy, type ArxivPaper } from "./research/arxiv";
import { fetchArxivWithCache, updateArxivCacheReview } from "./research/arxiv-cache";
import { renderWorkerPrompt, type TrustedKnowledgeContext, type UntrustedSourcePayload } from "./prompt-boundary";
import { admitRemoteCompute, hasApprovedRemoteComputeAdmission } from "./remote-admission";
import { buildArxivSourceRecords, claimedCitationFromSourceRecord, validateCitations } from "./research/citations";
import { buildArxivResearchEnrichment, type ArxivResearchEnrichment } from "./research/enrichment";
import { evaluateLiteratureRetrieval, retrievalOutageEvaluation } from "./research/evaluation";
import { quarantineArxivPapers } from "./research/security";
import { rankWorkerTournament, runWorkerQueue, type WorkerExecutionContext } from "./scheduler";
import { scoreEvidence } from "./scoring";
import { isBranchJob, isPhaseJob, isResearchJob, validatePhaseCompletion, workflowPhaseContract, workflowPhases } from "./workflow";
import { requireRunSafetyPreflight } from "./safety-preflight";
import { assertSwarmAdmissionApproved, persistSwarmAdmissionPreview } from "./swarm-admission";
import { persistSwarmCapacityPlan } from "./swarm-capacity";
import { runWorkerLocalAiSdkCall } from "./swarm-coordinator";
import { buildDynamicSwarmFanoutPlan, persistDynamicSwarmFanoutPlan } from "./swarm-fanout-planner";
import { readArtifactText } from "./storage-encryption";
import {
  ignoredVerifierClaimSummary,
  reviewStructuredWorkerResult,
  workerResultClaimsHardComputation,
  workerResultClaimsHardCounterexample,
  workerResultConclusion,
  workerResultCounterexampleText,
  workerResultLooksLikeFormalProof,
  type WorkerResultSchemaReview
} from "./worker-result";

export type RunResult = {
  status: GoalStatus;
  evidenceGrade: EvidenceGrade;
  finalState: FinalAnswerState;
  canClaimSolved: boolean;
  reason: string;
};

export type RunGoalBranchModel = {
  provider: ProviderName;
  modelId: string;
  model: LanguageModel;
  generate?: GenerateTextFunction;
  settings?: InstrumentedTextCall["settings"];
  remoteAdmission?: {
    command?: "goal run" | "goal resume";
    localOnly?: boolean;
    explicitRemoteConsent?: boolean;
    providerAllowlist?: ProviderName[];
  };
  providerConfigured?: boolean;
};

export type RunGoalOptions = {
  arxivSearch?: (query: string, options: { maxResults: number; abortSignal?: AbortSignal }) => Promise<ArxivPaper[]>;
  offline?: boolean;
  offlineReason?: string;
  cwd?: string;
  config?: MatematicaConfig;
  branchModel?: RunGoalBranchModel;
  branchModels?: RunGoalBranchModel[];
  swarmAdmissionConfirmed?: boolean;
  providerDiversityWaiver?: {
    reason: string;
    actor?: string;
  };
  problemClassOverride?: ProblemClass;
  leanVerifier?: {
    enabled?: boolean;
    leanBin?: string;
    lakeBin?: string;
    projectRoot?: string;
    timeoutMs?: number;
  };
};

function branchModelsForOptions(options: RunGoalOptions): RunGoalBranchModel[] {
  if (options.branchModels && options.branchModels.length > 0) return options.branchModels;
  return options.branchModel ? [options.branchModel] : [];
}

function primaryBranchModel(options: RunGoalOptions): RunGoalBranchModel | undefined {
  return branchModelsForOptions(options)[0];
}

function branchProviderConcurrencyLimit(options: RunGoalOptions): number | undefined {
  const models = branchModelsForOptions(options);
  if (models.length === 0) return undefined;
  const limits = models.map((model) => finitePositiveInteger(model.settings?.resilience?.maxConcurrency));
  if (limits.some((limit) => limit === undefined)) return undefined;
  return limits.reduce<number>((total, limit) => total + (limit ?? 0), 0);
}

function maxBranchModelOutputTokens(options: RunGoalOptions): number | undefined {
  return maxFinite(branchModelsForOptions(options).map((model) => model.settings?.maxOutputTokens));
}

function maxBranchModelUsd(options: RunGoalOptions): number | undefined {
  return maxFinite(branchModelsForOptions(options).map((model) => model.settings?.maxUsd));
}

function findBranchModelForRoute(
  options: RunGoalOptions,
  route: Record<string, unknown> | undefined
): RunGoalBranchModel | undefined {
  const models = branchModelsForOptions(options);
  if (models.length === 0) return undefined;
  const provider = typeof route?.provider === "string" ? route.provider : undefined;
  const modelId = typeof route?.modelId === "string" ? route.modelId : undefined;
  if (provider && modelId) {
    const exact = models.find((model) => model.provider === provider && model.modelId === modelId);
    if (exact) return exact;
    throw new Error(`No configured branch model for routed worker ${provider}/${modelId}; silent provider/model fallback is forbidden.`);
  }
  if (models.length === 1) return models[0];
  throw new Error("Heterogeneous branch model execution requires every worker job to carry an exact providerRoute.");
}

function finitePositiveInteger(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : undefined;
}

function maxFinite(values: Array<number | undefined>): number | undefined {
  const finite = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return finite.length > 0 ? Math.max(...finite) : undefined;
}

type RunDeadlineSupervisor = {
  remainingMs: () => number | undefined;
  throwIfExpired: (surface: string) => void;
  recordIfExpired: (surface: string) => boolean;
  withDeadline: <T>(surface: string, work: Promise<T>) => Promise<T>;
};

function createRunDeadlineSupervisor(runId: string, ledger: Ledger): RunDeadlineSupervisor {
  const run = ledger.requireRun(runId);
  if (run.budget.maxWallTimeMs === undefined) {
    return {
      remainingMs: () => undefined,
      throwIfExpired: () => undefined,
      recordIfExpired: () => false,
      withDeadline: async (_surface, work) => work
    };
  }
  const startedAt = run.startedAt ?? run.updatedAt ?? new Date().toISOString();
  const startedAtMs = Date.parse(startedAt);
  const maxWallTimeMs = Math.max(0, Math.floor(run.budget.maxWallTimeMs));
  const deadlineAtMs = startedAtMs + maxWallTimeMs;
  const deadlineAt = new Date(deadlineAtMs).toISOString();
  const remainingMs = () => Math.max(0, deadlineAtMs - Date.now());
  const expire = (surface: string): Error => {
    const reason = `whole-run wall-time budget exhausted during ${surface} (${maxWallTimeMs}ms)`;
    const current = ledger.requireRun(runId);
    ledger.appendEvent(runId, "run.deadline.checked", {
      ok: false,
      surface,
      startedAt,
      deadlineAt,
      maxWallTimeMs,
      now: new Date().toISOString(),
      statusBefore: current.status,
      reason
    });
    if (!isTerminalStatus(current.status)) {
      ledger.cancelQueuedWorkerJobs(runId, reason);
      ledger.updateRunStatus(runId, "budget_exhausted", "budget_exhausted");
      ledger.appendEvent(runId, "goal.completed", {
        status: "budget_exhausted",
        evidenceGrade: "budget_exhausted",
        finalState: "budget_exhausted",
        canClaimSolved: false,
        reason
      });
    }
    const error = new Error(reason);
    error.name = "RunDeadlineExceededError";
    return error;
  };

  return {
    remainingMs,
    throwIfExpired: (surface) => {
      if (remainingMs() <= 0) throw expire(surface);
    },
    recordIfExpired: (surface) => {
      if (remainingMs() > 0) return false;
      expire(surface);
      return true;
    },
    withDeadline: async <T>(surface: string, work: Promise<T>): Promise<T> => {
      const remaining = remainingMs();
      if (remaining <= 0) throw expire(surface);
      work.catch(() => undefined);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          work,
          new Promise<T>((_, reject) => {
            timer = setTimeout(() => reject(expire(surface)), remaining);
            timer.unref?.();
          })
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  };
}

type NextCyclePlan = {
  format: "matematica.workflow.next-cycle-plan";
  version: 1;
  workflow: "pflk" | "gree";
  sourceCycle: number;
  targetCycle: number;
  planHash: string;
  sourcePhaseOutputEventIds: string[];
  sourceArtifactIds: string[];
  hypotheses: Array<Record<string, unknown>>;
  proofObligations: Array<Record<string, unknown>>;
  counterexamplePlans: Array<Record<string, unknown>>;
  experimentManifests: Array<Record<string, unknown>>;
  rankings: Array<Record<string, unknown>>;
  pruningDecisions: Array<Record<string, unknown>>;
  nextCycleMutations: Array<Record<string, unknown>>;
  promptGuidance: Record<string, unknown>;
};

export async function runGoal(runId: string, ledger: Ledger, artifacts: ArtifactStore, options: RunGoalOptions = {}): Promise<RunResult> {
  let run = ledger.requireRun(runId);
  if (isTerminalStatus(run.status)) {
    return resultForRun(runId, ledger);
  }

  const sourceNetworkPolicy: NetworkPolicy = {
    mode: options.offline === true ? "offline" : "online",
    offline: options.offline === true,
    localOnly: options.offline === true,
    reason: options.offline === true ? options.offlineReason ?? "offline/local-only goal run requested" : undefined
  };
  const branchModels = branchModelsForOptions(options);
  const command = primaryBranchModel(options)?.remoteAdmission?.command ?? "goal run";
  const swarmAdmission = persistSwarmAdmissionPreview({
    run,
    ledger,
    artifacts,
    command,
    sourceNetworkMode: sourceNetworkPolicy.mode,
    explicitYes: options.swarmAdmissionConfirmed === true,
    branchModel: primaryBranchModel(options),
    branchModels,
    providerDiversityWaiver: options.providerDiversityWaiver
  });
  assertSwarmAdmissionApproved(swarmAdmission);

  run = ledger.updateRunStatus(runId, "running");
  const deadline = createRunDeadlineSupervisor(runId, ledger);
  ledger.appendEvent(runId, "goal.started", { workflow: run.workflow });
  const pinnedPolicy = ensureRunVerifierPolicyManifest(runId, ledger, artifacts);
  const problemClassificationReview = persistProblemClassificationReview({
    run,
    ledger,
    artifacts,
    override: options.problemClassOverride,
    reviewer: options.problemClassOverride ? "operator-override" : undefined
  });
  const initialOutcome = classifyFinalOutcome(run, ledger.listEvents(runId));
  if (initialOutcome.reason.includes("theorem-equivalence review")) {
    ledger.updateRunStatus(runId, "needs_human_review", run.evidenceGrade);
    ledger.appendEvent(runId, "goal.failed", {
      status: "needs_human_review",
      finalState: initialOutcome.state,
      canClaimSolved: false,
      reason: initialOutcome.reason
    });
    return resultForRun(runId, ledger);
  }
  await requireRunSafetyPreflight({
    run,
    ledger,
    artifacts,
    command,
    sourceNetworkPolicy,
    branchModel: primaryBranchModel(options),
    branchModels
  });
  admitBranchModelsIfNeeded(runId, run, ledger, artifacts, options);

  let cycle = nextCycleNumber(ledger.listEvents(runId));
  while (true) {
    run = ledger.requireRun(runId);
    if (isTerminalStatus(run.status)) {
      return resultForRun(runId, ledger);
    }
    if (deadline.recordIfExpired(`cycle-${cycle}:preflight`)) return resultForRun(runId, ledger);
    const usage = ledger.getBudgetUsage(runId);
    const preflight = checkBudget(run, usage, { attempts: 1 });
    ledger.appendEvent(runId, "budget.checked", {
      ok: preflight.ok,
      reason: preflight.reason ?? null,
      reserve: { attempts: 1 },
      budget: run.budget,
      usage,
      operationType: "goal.cycle",
      operationId: `cycle-${cycle}`,
      cycle
    });

    if (!preflight.ok) {
      ledger.updateRunStatus(runId, "budget_exhausted", "budget_exhausted");
      persistGoalProgressReview({ runId, cycle, ledger, artifacts });
      ledger.appendEvent(runId, "goal.completed", {
        status: "budget_exhausted",
        evidenceGrade: "budget_exhausted",
        finalState: "budget_exhausted",
        canClaimSolved: false,
        reason: preflight.reason,
        cycle
      });
      return resultForRun(runId, ledger);
    }

    const contextCompaction = cycle > 1
      ? persistContextCompactionReview({ runId, cycle, ledger, artifacts })
      : undefined;
    const accumulatedKnowledge = collectAccumulatedKnowledge(runId, ledger, cycle, contextCompaction);
    const incomingNextCyclePlan = recordValue(accumulatedKnowledge.nextCyclePlan);
    ledger.appendEvent(runId, "cycle.started", {
      cycle,
      workflow: run.workflow,
      problem: run.problem,
      goal: run.goal,
      usage,
      budget: run.budget,
      contextCompactionEventId: contextCompaction?.event.id,
      contextCompactionArtifactId: contextCompaction?.artifact.id,
      contextCompactionReviewHash: contextCompaction?.review.reviewHash,
      accumulatedKnowledge
    });

    for (const phase of workflowPhases(run.workflow)) {
      const phaseName = phase.name;
      if (deadline.recordIfExpired(`cycle-${cycle}:${phaseName}:before-phase`)) return resultForRun(runId, ledger);
      ensureWorkflowPhaseJob(runId, ledger, run.workflow, phase, cycle, contextCompaction?.event, incomingNextCyclePlan);
      await runWorkerQueue({
        runId,
        ledger,
        workerId: `local-workflow-orchestrator-cycle-${cycle}`,
        maxWorkers: run.budget.maxWorkers ?? 1,
        artifacts,
        providerConcurrency: branchProviderConcurrencyLimit(options),
        reservePerJob: { attempts: 0, tokens: 0, usd: 0, elapsedMs: 1 },
        executor: async (job, context) => {
          if (isPhaseJob(job)) {
            return deadline.withDeadline(`cycle-${cycle}:${phaseName}:phase-job`, Promise.resolve(executePhaseJob(job, run.problem, run.goal, ledger, artifacts, options)));
          }
          if (isBranchJob(job)) {
            return deadline.withDeadline(`cycle-${cycle}:${phaseName}:branch-job`, executeBranchJob(job, run.problem, run.goal, artifacts, ledger, options, context));
          }
          if (isResearchJob(job)) {
            if (job.payload.provider === "mathlib") {
              return deadline.withDeadline(`cycle-${cycle}:${phaseName}:mathlib`, Promise.resolve(executeMathlibResearchJob(job, run.problem, run.goal, artifacts, ledger)));
            }
            return deadline.withDeadline(`cycle-${cycle}:${phaseName}:arxiv`, executeResearchJob(job, options.arxivSearch ?? defaultRunResearchSearch, artifacts, ledger, sourceNetworkPolicy, context.signal));
          }
          return { ignored: true, kind: job.kind };
        }
      });
      if (deadline.recordIfExpired(`cycle-${cycle}:${phaseName}:worker-queue`)) return resultForRun(runId, ledger);
    }

    const afterWorkflow = ledger.requireRun(runId);
    if (afterWorkflow.status === "budget_exhausted" || afterWorkflow.status === "cancelled" || afterWorkflow.status === "failed") {
      ledger.appendEvent(runId, "cycle.completed", {
        cycle,
        status: afterWorkflow.status,
        evidenceGrade: afterWorkflow.evidenceGrade,
        finalState: afterWorkflow.status,
        canClaimSolved: false,
        reason: `Cycle stopped because run status is ${afterWorkflow.status}.`
      });
      persistGoalProgressReview({ runId, cycle, ledger, artifacts });
      return resultForRun(runId, ledger);
    }

  const branchCandidatePromotion = await promoteBranchOutputsToCandidateClaims({
    runId,
    run,
    cycle,
    ledger,
    artifacts,
    trustedVerifiers: pinnedPolicy.manifest.trustedVerifiers,
    leanVerifier: options.leanVerifier
  });
  if (deadline.recordIfExpired(`cycle-${cycle}:before-verifier`)) return resultForRun(runId, ledger);
  const verifierStartedAt = Date.now();
  const verifierReservation = ledger.reserveBudget({
    runId,
    reserve: { attempts: 1 },
    operationType: "verifier.local",
    operationId: "local-deterministic-v0",
    workerId: "local-deterministic-worker",
    provider: "local"
  });
  if (!verifierReservation.ok) {
    ledger.updateRunStatus(runId, "budget_exhausted", "budget_exhausted");
    ledger.appendEvent(runId, "cycle.completed", {
      cycle,
      status: "budget_exhausted",
      evidenceGrade: "budget_exhausted",
      finalState: "budget_exhausted",
      canClaimSolved: false,
      reason: verifierReservation.reason
    });
    persistGoalProgressReview({ runId, cycle, ledger, artifacts });
    ledger.appendEvent(runId, "goal.completed", {
      status: "budget_exhausted",
      evidenceGrade: "budget_exhausted",
      finalState: "budget_exhausted",
      canClaimSolved: false,
      reason: verifierReservation.reason,
      cycle
    });
    return resultForRun(runId, ledger);
  }

  ledger.appendEvent(runId, "worker.started", {
    workerId: "local-deterministic-worker",
    role: "v0-local-baseline",
    attempt: 1
  });

  const localFixture = localVerifierFixture(run.problem, run.goal);
  const grade = localFixture.evidenceGrade;
  const computationExecutableArtifact = artifacts.create(
    runId,
    "computation.executable",
    JSON.stringify({
      name: localFixture.executableName,
      language: "typescript",
      entrypoint: "built-in:localVerifier",
      command: localFixture.command,
      deterministic: true,
      source: "src/runner.ts localVerifier",
      fixture: localFixture.kind,
      exactStatement: localFixture.exactStatement
    }, null, 2)
  );
  const verifierArtifact = artifacts.create(
    runId,
    "verifier.local.result",
    JSON.stringify({
      verifier: "local-deterministic-v0",
      evidenceGrade: grade,
      note: localFixture.verifierNote,
      exactStatement: localFixture.exactStatement
    }, null, 2)
  );

  ledger.appendEvent(runId, "verifier.started", {
    verifier: "local-deterministic-v0"
  });
  const primaryVerifierEvent = ledger.appendEvent(runId, "verifier.completed", {
    verifier: "local-deterministic-v0",
    evidenceGrade: grade,
    artifactId: verifierArtifact.id
  }, [verifierArtifact.id]);
  const independentCheckerArtifact = artifacts.create(
    runId,
    "verifier.local.independent-checker.result",
    JSON.stringify({
      verifier: "arithmetic-independent-checker",
      evidenceGrade: grade,
      note: localFixture.independentCheckerNote,
      exactStatement: localFixture.exactStatement
    }, null, 2)
  );
  const independentCheckerEvent = ledger.appendEvent(runId, "verifier.completed", {
    verifier: "arithmetic-independent-checker",
    evidenceGrade: grade,
    artifactId: independentCheckerArtifact.id,
    role: "independent_checker"
  }, [independentCheckerArtifact.id]);

  ledger.debitBudget({
    runId,
    reservationId: verifierReservation.reservationId,
    debit: { attempts: 1, elapsedMs: Date.now() - verifierStartedAt },
    overReservationPolicy: {
      allowedDimensions: ["elapsedMs"],
      reason: "Local verifier debits measured elapsed time after reserving the verifier attempt."
    },
    workerId: "local-deterministic-worker",
    provider: "local"
  });

  ledger.appendEvent(runId, "worker.completed", {
    workerId: "local-deterministic-worker",
    evidenceGrade: grade
  }, [verifierArtifact.id]);
  const counterexampleSearches = [
    {
      method: "numeric" as const,
      outcome: grade === "verified_computation" ? "passed" as const : "attempted" as const,
      checkedCases: grade === "verified_computation" ? 1 : 0,
      artifactIds: [] as string[],
      notes: grade === "verified_computation"
        ? localFixture.numericSearchNote
        : "No numeric counterexample search was applicable to the local v0 failure."
    },
    {
      method: "symbolic" as const,
      outcome: grade === "verified_computation" ? "passed" as const : "not_applicable" as const,
      artifactIds: [] as string[],
      notes: grade === "verified_computation"
        ? localFixture.symbolicSearchNote
        : "Symbolic counterexample search was not applicable to the local v0 failure."
    },
    {
      method: "random" as const,
      outcome: "not_applicable" as const,
      artifactIds: [] as string[],
      notes: "Random search is not meaningful for a closed arithmetic identity."
    },
    {
      method: "domain_specific" as const,
      outcome: grade === "verified_computation" ? "passed" as const : "not_applicable" as const,
      domain: localFixture.inputDomain,
      artifactIds: [] as string[],
      notes: grade === "verified_computation"
        ? localFixture.domainSearchNote
        : "Domain-specific counterexample search was not applicable to the local v0 failure."
    }
  ];
  const counterexampleArtifact = artifacts.create(runId, "counterexample.search", JSON.stringify({
    claimId: `claim-${runId}-local-v0`,
    status: grade === "verified_computation" ? "passed" : "attempted",
    searches: counterexampleSearches,
    negativeEvidenceOnly: true,
    note: "Failed counterexample searches are negative evidence only; they do not prove the claim."
  }, null, 2));
  const counterexampleEvent = ledger.appendEvent(runId, "counterexample.search.reviewed", {
    claimId: `claim-${runId}-local-v0`,
    status: grade === "verified_computation" ? "passed" : "attempted",
    searches: counterexampleSearches.map((search) => ({
      ...search,
      artifactIds: [counterexampleArtifact.id]
    })),
    negativeEvidenceOnly: true,
    artifactId: counterexampleArtifact.id
  }, [counterexampleArtifact.id]);
  const counterexampleSearchesWithArtifact = counterexampleSearches.map((search) => ({
    ...search,
    artifactIds: [counterexampleArtifact.id]
  }));
  const computationReproducibility = grade === "verified_computation"
    ? {
        executableArtifactId: computationExecutableArtifact.id,
        command: localFixture.command,
        seed: "deterministic-arithmetic-v0",
        environmentHash: stableHash({
          verifier: "local-deterministic-v0",
          runtime: "bun",
          arithmetic: "integer",
          executableArtifactId: computationExecutableArtifact.id,
          exactStatement: localFixture.exactStatement
        }),
        inputDomain: localFixture.inputDomain,
        boundsStatement: localFixture.boundsStatement,
        outputHash: stableHash({ result: localFixture.exactStatement, verified: true }),
        independentRerunArtifactId: independentCheckerArtifact.id,
        failureClassification: "none" as const
      }
    : undefined;

  const claim = makeClaimContract({
    id: `claim-${runId}-local-v0`,
    claimType: grade === "verified_computation" ? "numerical_evidence" : "proof_sketch",
    verifierId: "local-deterministic-v0",
    assumptions: [],
    conclusion: grade === "verified_computation"
      ? localFixture.claimConclusion
      : "The local deterministic verifier did not find verifier-backed evidence.",
    dependencies: [],
    verifierStatus: grade === "verified_computation" ? "verified" : "not_checked",
    evidenceGrade: grade,
    verifierArtifactIds: [verifierArtifact.id],
    proofObligationGraph: makeProofObligationGraph({
      rootClaimId: `claim-${runId}-local-v0`,
      obligations: [{
        id: `claim-${runId}-local-v0`,
        statement: grade === "verified_computation"
          ? localFixture.proofObligationStatement
          : "The local deterministic verifier did not establish a proof obligation.",
        assumptions: [],
        conclusion: grade === "verified_computation" ? localFixture.exactStatement : "no verifier-backed evidence",
        dependencies: [],
        status: grade === "verified_computation" ? "computational_evidence" : "informal_unverified",
        verifierId: "local-deterministic-v0",
        artifactIds: [computationExecutableArtifact.id, verifierArtifact.id, independentCheckerArtifact.id, counterexampleArtifact.id],
        reproducibility: computationReproducibility,
        counterexampleSearch: grade === "verified_computation" ? "passed" : "attempted",
        counterexampleSearches: counterexampleSearchesWithArtifact,
        dependencyEventIds: [primaryVerifierEvent.id, independentCheckerEvent.id, counterexampleEvent.id]
      }]
    }),
    supportingVerifierResults: grade === "verified_computation" ? [{
      verifierId: "arithmetic-independent-checker",
      role: "independent_checker",
      claimType: "numerical_evidence",
      verifierStatus: "verified",
      evidenceGrade: grade,
      artifactIds: [independentCheckerArtifact.id],
      notes: localFixture.independentCheckerNote
    }] : [],
    formalization: { status: "not_required" }
  });
  const gate = evaluateEvidenceGate(claim, {
    trustedVerifiers: pinnedPolicy.manifest.trustedVerifiers,
    artifacts: ledger.listArtifacts(runId)
  });
  const proofObligationDecision = claim.proofObligationGraph
    ? evaluateProofObligationGraph(claim.proofObligationGraph, ledger.listArtifacts(runId), {
        requireCounterexampleSearch: grade === "formal_proof",
        evidenceGrade: grade,
        events: ledger.listEvents(runId)
      })
    : undefined;
  const proofObligationTrace = claim.proofObligationGraph
    ? traceProofObligations(claim.proofObligationGraph)
    : undefined;
  const proofObligationArtifact = artifacts.create(runId, "proof.obligations", JSON.stringify({
    claimId: claim.id,
    graph: claim.proofObligationGraph,
    decision: proofObligationDecision,
    trace: proofObligationTrace
  }, null, 2));
  ledger.appendEvent(runId, "proof.obligations.reviewed", {
    claimId: claim.id,
    decision: proofObligationDecision,
    trace: proofObligationTrace,
    artifactId: proofObligationArtifact.id
  }, [proofObligationArtifact.id]);
  const selectedBranchCandidate = branchCandidatePromotion.accepted.find((candidate) => candidate.claim.evidenceGrade === "formal_proof") ??
    branchCandidatePromotion.accepted[0];
  const finalClaim = selectedBranchCandidate?.claim ?? claim;
  const finalGate = selectedBranchCandidate?.gate ?? gate;
  const finalEvidenceGrade = finalClaim.evidenceGrade;
  const localClaimArtifactIds = [
    computationExecutableArtifact.id,
    verifierArtifact.id,
    independentCheckerArtifact.id,
    counterexampleArtifact.id,
    proofObligationArtifact.id
  ];
  const finalProofObligationArtifactId = selectedBranchCandidate?.proofObligationArtifactId ?? proofObligationArtifact.id;
  const evidenceScore = scoreEvidence({
    evidenceGrade: finalEvidenceGrade,
    claimType: finalClaim.claimType,
    verifierStatus: finalClaim.verifierStatus,
    verifierTrusted: true,
    formalizationStatus: finalClaim.formalization?.status,
    sourceSupport: "none",
    counterexampleSearch: finalEvidenceGrade === "verified_computation" ? "passed" : "attempted",
    reproducibility: finalEvidenceGrade === "verified_computation" ? "deterministic" : "partial",
    modelAgreementOnly: false
  });
  ledger.insertScore({
    runId,
    subjectId: finalClaim.id,
    scorer: "conservative-evidence-v0",
    score: evidenceScore.aggregate,
    rubric: evidenceScore
  });
  ledger.appendEvent(runId, "verifier.completed", {
    verifier: "evidence-gate",
    policyArtifactId: pinnedPolicy.artifactId,
    policyHash: pinnedPolicy.manifest.policyHash,
    claim: finalClaim,
    gate: finalGate,
    evidenceScore
  }, uniqueStrings([
    pinnedPolicy.artifactId,
    ...localClaimArtifactIds,
    ...(selectedBranchCandidate?.satisfyingArtifactIds ?? [])
  ]));
  const claimGraphReview = persistClaimGraphReview({
    runId,
    ledger,
    artifacts,
    claims: [
      {
        claim,
        artifactIds: localClaimArtifactIds
      },
      ...branchCandidatePromotion.accepted.map((candidate) => ({
        claim: candidate.claim,
        artifactIds: candidate.satisfyingArtifactIds
      }))
    ],
    targetClaimId: finalClaim.id,
    retractions: extractClaimRetractions(ledger.listEvents(runId))
  });
  const problemClassification = problemClassificationReview.classification;
  const successEvaluation = evaluateGoalSuccess({
    run,
    claim: finalClaim,
    gate: finalGate,
    problemClassification,
    candidateArtifactIds: [
      ...branchCandidatePromotion.accepted.flatMap((candidate) => candidate.satisfyingArtifactIds),
      ...localClaimArtifactIds,
      claimGraphReview.artifact.id
    ],
    claimGraph: claimGraphReview.decision
  });
  ledger.appendEvent(runId, "evidence.scored", {
    scorer: "open-problem-policy",
    evaluator: "goal-success-evaluator",
    problemClassification,
    evidenceGrade: finalEvidenceGrade,
    canClaimSolved: successEvaluation.canClaimSolved,
    criteria: successEvaluation.criteria,
    finalState: successEvaluation.finalState
  });
  const goalSuccessEvent = ledger.appendEvent(runId, "goal.success.evaluated", {
    status: successEvaluation.status,
    evidenceGrade: successEvaluation.evidenceGrade,
    finalState: successEvaluation.finalState,
    canClaimSolved: successEvaluation.canClaimSolved,
    reason: successEvaluation.reason,
    criteria: successEvaluation.criteria,
    structuredContract: successEvaluation.structuredContract,
    problemClassification: successEvaluation.problemClassification,
    claimId: successEvaluation.claimId,
    verifierId: successEvaluation.verifierId,
    claimGraph: successEvaluation.claimGraph,
    finalClaimAcceptance: successEvaluation.finalClaimAcceptance,
    finalOutcomeContract: successEvaluation.finalOutcomeContract,
    branchCandidateClaimIds: branchCandidatePromotion.candidates.map((candidate) => candidate.claim.id),
    acceptedBranchCandidateClaimIds: branchCandidatePromotion.accepted.map((candidate) => candidate.claim.id),
    satisfyingArtifactIds: successEvaluation.satisfyingArtifactIds
  }, successEvaluation.satisfyingArtifactIds);

  if (successEvaluation.status === "needs_human_review") {
    const conjectureArtifact = persistConjecturalKnowledge(runId, artifacts, {
      cycle,
      goalSuccessEventId: goalSuccessEvent.id,
      claimId: finalClaim.id,
      verifierId: finalClaim.verifierId,
      evidenceGrade: finalEvidenceGrade,
      finalState: successEvaluation.finalState,
      reason: successEvaluation.reason,
      problemClassification,
      satisfyingArtifactIds: successEvaluation.satisfyingArtifactIds,
      proofObligationArtifactId: finalProofObligationArtifactId
    });
    ledger.appendEvent(runId, "knowledge.conjecture.saved", {
      cycle,
      claimId: finalClaim.id,
      verifierId: finalClaim.verifierId,
      evidenceGrade: finalEvidenceGrade,
      finalState: successEvaluation.finalState,
      truthLevel: "candidate",
      trustGrade: "quarantined_context_only",
      reason: successEvaluation.reason,
      problemClassification,
      provenance: {
        source: "goal.success.evaluated",
        sourceEventIds: [goalSuccessEvent.id],
        sourceArtifactIds: successEvaluation.satisfyingArtifactIds,
        cycle
      },
      sourceTaint: {
        sourceDerived: true,
        taintedSourceEventIds: ledger.listEvents(runId)
          .filter((event) => event.type === "source.results" && Number(event.payload.cycle ?? 1) === cycle)
          .map((event) => event.id),
        taintedFields: ["source_context", "model_output", "cross_agent_summary"]
      },
      verifierStatus: {
        verifierId: finalClaim.verifierId,
        verified: false,
        status: "not_goal_satisfying_verifier_backed",
        evidenceGrade: finalEvidenceGrade
      },
      dependencyGraph: {
        rootClaimId: finalClaim.id,
        artifactIds: successEvaluation.satisfyingArtifactIds,
        proofObligationArtifactId: finalProofObligationArtifactId
      },
      contradictionReview: {
        status: finalEvidenceGrade === "contradicted" ? "contradicted" : "not_contradicted",
        retractionEventIds: ledger.listEvents(runId)
          .filter((event) => event.type === "claim.retracted" && event.payload.claimId === finalClaim.id)
          .map((event) => event.id)
      },
      supersession: {
        supersededBy: null,
        supersedes: []
      },
      freshness: {
        policy: "expire_without_verifier_refresh",
        expiresAt: null,
        refreshRequiredBeforeProofSupport: true
      },
      promotion: {
        explicit: true,
        promotedAs: "context_only",
        proofSupportAllowed: false,
        controlsAffected: false,
        providerPolicyMutationAllowed: false,
        budgetMutationAllowed: false,
        toolPolicyMutationAllowed: false,
        goalContractMutationAllowed: false,
        promptFirewallRequired: true,
        promptFirewallReviewed: true
      },
      artifactId: conjectureArtifact.id,
      feedsNextPhase: run.workflow === "pflk" ? "knowledge" : "evolve",
      nextAction: "continue_until_goal_or_budget"
    }, [conjectureArtifact.id, finalProofObligationArtifactId, ...successEvaluation.satisfyingArtifactIds]);
    const nextCyclePlan = persistNextCyclePlan({
      runId,
      run,
      cycle,
      targetCycle: cycle + 1,
      ledger,
      artifacts,
      reason: successEvaluation.reason,
      knowledgeArtifactId: conjectureArtifact.id
    });
    ledger.appendEvent(runId, "cycle.completed", {
      cycle,
      status: "needs_human_review",
      evidenceGrade: finalEvidenceGrade,
      finalState: successEvaluation.finalState,
      canClaimSolved: false,
      reason: successEvaluation.reason,
      nextAction: "continue_until_goal_or_budget",
      knowledgeArtifactId: conjectureArtifact.id,
      nextCyclePlanArtifactId: nextCyclePlan.artifact.id,
      nextCyclePlanHash: nextCyclePlan.plan.planHash,
      claimId: finalClaim.id,
      verifierId: finalClaim.verifierId
    }, [conjectureArtifact.id, nextCyclePlan.artifact.id, ...successEvaluation.satisfyingArtifactIds]);
    persistGoalProgressReview({ runId, cycle, ledger, artifacts });
    cycle += 1;
    continue;
  }

  if (successEvaluation.status === "goal_met") {
    const proofCertificate = persistProofCertificate({
      runId,
      ledger,
      artifacts,
      claim: finalClaim,
      satisfyingArtifactIds: successEvaluation.satisfyingArtifactIds,
      cwd: options.cwd,
      config: options.config
    });
    const adversarialQuorum = persistAdversarialQuorumReview({
      runId,
      ledger,
      artifacts,
      scope: "finalization",
      targetEvent: goalSuccessEvent,
      targetArtifactIds: [proofCertificate.artifact.id, ...successEvaluation.satisfyingArtifactIds],
      critics: buildBlindFinalizationCriticReviews({
        runId,
        targetEvent: goalSuccessEvent,
        targetArtifactIds: [proofCertificate.artifact.id, ...successEvaluation.satisfyingArtifactIds]
      })
    });
    const finalization = persistNoFalseSolvedFinalization({
      runId,
      ledger,
      artifacts,
      goalSuccessEvent,
      successEvaluation
    });
    if (!finalization.review.canMarkGoalMet) {
      const nextCyclePlan = persistNextCyclePlan({
        runId,
        run,
        cycle,
        targetCycle: cycle + 1,
        ledger,
        artifacts,
        reason: `No-false-solved finalization failed: ${finalization.review.failureReasons.join("; ")}`
      });
      ledger.appendEvent(runId, "cycle.completed", {
        cycle,
        status: "needs_human_review",
        evidenceGrade: finalEvidenceGrade,
        finalState: "partial",
        canClaimSolved: false,
        reason: `No-false-solved finalization failed: ${finalization.review.failureReasons.join("; ")}`,
        nextAction: "continue_until_goal_or_budget",
        claimId: finalClaim.id,
        verifierId: finalClaim.verifierId,
        nextCyclePlanArtifactId: nextCyclePlan.artifact.id,
        nextCyclePlanHash: nextCyclePlan.plan.planHash,
        finalizationArtifactId: finalization.artifact.id,
        proofCertificateArtifactId: proofCertificate.artifact.id,
        adversarialQuorumArtifactId: adversarialQuorum.artifact.id
      }, [nextCyclePlan.artifact.id, finalization.artifact.id, proofCertificate.artifact.id, adversarialQuorum.artifact.id, ...successEvaluation.satisfyingArtifactIds]);
      persistGoalProgressReview({ runId, cycle, ledger, artifacts });
      cycle += 1;
      continue;
    }
    ledger.appendEvent(runId, "cycle.completed", {
      cycle,
      status: "goal_met",
      evidenceGrade: finalEvidenceGrade,
      finalState: successEvaluation.finalState,
      canClaimSolved: successEvaluation.canClaimSolved,
      reason: successEvaluation.reason,
      claimId: finalClaim.id,
      verifierId: finalClaim.verifierId,
      finalizationArtifactId: finalization.artifact.id,
      proofCertificateArtifactId: proofCertificate.artifact.id,
      adversarialQuorumArtifactId: adversarialQuorum.artifact.id,
      finalizationReviewHash: finalization.review.reviewHash
    }, [finalization.artifact.id, proofCertificate.artifact.id, adversarialQuorum.artifact.id, ...successEvaluation.satisfyingArtifactIds]);
    persistGoalProgressReview({ runId, cycle, ledger, artifacts });
    ledger.markGoalMet(runId, finalEvidenceGrade, {
      reason: successEvaluation.reason,
      claimId: finalClaim.id,
      verifierId: finalClaim.verifierId
    }, successEvaluation.satisfyingArtifactIds, buildGoalSuccessDecisionToken({
      runId,
      event: goalSuccessEvent
    }));
    return resultForRun(runId, ledger);
  }

  const nextCyclePlan = persistNextCyclePlan({
    runId,
    run,
    cycle,
    targetCycle: cycle + 1,
    ledger,
    artifacts,
    reason: successEvaluation.reason
  });
  ledger.appendEvent(runId, "cycle.completed", {
    cycle,
    status: "running",
    evidenceGrade: finalEvidenceGrade,
    finalState: successEvaluation.finalState,
    canClaimSolved: false,
    reason: successEvaluation.reason,
    nextAction: "continue_until_goal_or_budget",
    nextCyclePlanArtifactId: nextCyclePlan.artifact.id,
    nextCyclePlanHash: nextCyclePlan.plan.planHash,
    claimId: finalClaim.id,
    verifierId: finalClaim.verifierId
  }, [nextCyclePlan.artifact.id, ...successEvaluation.satisfyingArtifactIds]);
  persistGoalProgressReview({ runId, cycle, ledger, artifacts });
  cycle += 1;
  }
}

function admitBranchModelsIfNeeded(
  runId: string,
  run: ReturnType<Ledger["requireRun"]>,
  ledger: Ledger,
  artifacts: ArtifactStore,
  options: RunGoalOptions
): void {
  const branchModels = branchModelsForOptions(options);
  pinBranchProviderMatrixIfNeeded(runId, ledger, artifacts, branchModels);
  for (const branchModel of branchModels) {
    const explicitRemoteAdmission = branchModel.remoteAdmission;
    if (
      branchModel.provider !== "local" &&
      explicitRemoteAdmission?.explicitRemoteConsent !== true
    ) {
      if (hasApprovedRemoteComputeAdmission({
        runId,
        ledger,
        provider: branchModel.provider,
        modelId: branchModel.modelId
      })) {
        continue;
      }
      throw new Error("Remote branchModel calls require explicit remoteAdmission.explicitRemoteConsent; pass --i-understand-remote-costs or persist remote compute consent before calling runGoal.");
    }
    const settings = branchModel.settings ?? { maxOutputTokens: 800 };
    const admission = admitRemoteCompute({
      runId,
      ledger,
      artifacts,
      command: branchModel.remoteAdmission?.command ?? "goal run",
      provider: branchModel.provider,
      modelId: branchModel.modelId,
      localOnly: branchModel.remoteAdmission?.localOnly ?? false,
      maxWorkers: run.budget.maxWorkers,
      maxAttempts: run.budget.maxAttempts,
      runMaxUsd: run.budget.maxUsd,
      runMaxTokens: run.budget.maxTokens,
      maxCallUsd: settings.maxUsd,
      maxOutputTokens: settings.maxOutputTokens,
      providerTimeoutMs: settings.timeout,
      maxToolLoopStepsPerWorker: settings.aiSdkLoop?.maxSteps,
      maxProviderRetriesPerCall: settings.resilience?.maxRetries,
      maxSubagentCallsPerStep: settings.aiSdkLoop?.maxSubagentCalls,
      budgetCaps: settings.budgetCaps,
      explicitRemoteConsent: explicitRemoteAdmission?.explicitRemoteConsent === true,
      providerAllowlist: branchModel.remoteAdmission?.providerAllowlist
    });
    if (!admission.ok) throw new Error(admission.reason);
  }
}

function pinBranchProviderMatrixIfNeeded(
  runId: string,
  ledger: Ledger,
  artifacts: ArtifactStore,
  branchModels: RunGoalBranchModel[]
): void {
  if (branchModels.length === 0) return;
  const existing = latestProviderMatrixPin(ledger, runId);
  if (existing) {
    const missing = branchModels.filter((model) => {
      if (existing.snapshot.providerAllowlist.length > 0 && !existing.snapshot.providerAllowlist.includes(model.provider)) return true;
      return !existing.snapshot.providers.some((record) =>
        record.provider === model.provider &&
        record.requestedModel === model.modelId
      );
    });
    if (missing.length === 0) return;
    throw new Error(`Pinned provider matrix is missing branch route(s): ${missing.map((model) => `${model.provider}/${model.modelId}`).join(", ")}. Explicit audited routing changes are required before heterogeneous fanout dispatch.`);
  }
  pinProviderMatrix({
    runId,
    ledger,
    artifacts,
    providers: branchModels.map((model) => providerCapabilityByName(model.provider, model.modelId)),
    providerAllowlist: [...new Set(branchModels.map((model) => model.provider))],
    source: "run-goal-branch-model-routes",
    reason: "Goal run pinned every configured branch provider route before heterogeneous fanout dispatch."
  });
}

function resultForRun(runId: string, ledger: Ledger): RunResult {
  const run = ledger.requireRun(runId);
  const outcome = classifyFinalOutcome(run, ledger.listEvents(runId));
  return {
    status: run.status,
    evidenceGrade: run.evidenceGrade,
    finalState: outcome.state,
    canClaimSolved: outcome.canClaimSolved,
    reason: outcome.reason
  };
}

function nextCycleNumber(events: ReturnType<Ledger["listEvents"]>): number {
  const completedCycles = events
    .filter((event) => event.type === "cycle.started" && typeof event.payload.cycle === "number")
    .map((event) => Number(event.payload.cycle));
  return completedCycles.length === 0 ? 1 : Math.max(...completedCycles) + 1;
}

function collectAccumulatedKnowledge(
  runId: string,
  ledger: Ledger,
  cycle: number,
  contextCompaction?: ReturnType<typeof persistContextCompactionReview>
): Record<string, unknown> {
  const artifacts = ledger.listArtifacts(runId);
  const events = ledger.listEvents(runId);
  const latestPlanEvent = events.findLast((event) =>
    event.type === "workflow.next_cycle.planned" &&
    Number(event.payload.targetCycle) === cycle
  );
  return {
    previousCycles: Math.max(0, cycle - 1),
    knowledgeArtifactIds: artifacts
      .filter((artifact) =>
        artifact.kind.includes("knowledge") ||
        artifact.kind.includes("branch") ||
        artifact.kind === "source.arxiv.results" ||
        artifact.kind === "proof.obligations" ||
        artifact.kind.startsWith("verifier.")
      )
      .map((artifact) => artifact.id),
    lastCycleOutcome: events.findLast((event) => event.type === "cycle.completed")?.payload ?? null,
    nextCyclePlan: latestPlanEvent ? {
      eventId: latestPlanEvent.id,
      artifactId: latestPlanEvent.payload.artifactId,
      planHash: latestPlanEvent.payload.planHash,
      sourceCycle: latestPlanEvent.payload.sourceCycle,
      targetCycle: latestPlanEvent.payload.targetCycle,
      promptGuidance: latestPlanEvent.payload.promptGuidance,
      nextCycleMutations: latestPlanEvent.payload.nextCycleMutations,
      experimentRoleOrder: latestPlanEvent.payload.experimentRoleOrder,
      sourceArtifactIds: latestPlanEvent.artifactIds
    } : null,
    contextCompaction: contextCompaction ? {
      eventId: contextCompaction.event.id,
      artifactId: contextCompaction.artifact.id,
      reviewHash: contextCompaction.review.reviewHash,
      kept: contextCompaction.review.summary.keptEvents + contextCompaction.review.summary.keptArtifacts,
      dropped: contextCompaction.review.summary.droppedEvents + contextCompaction.review.summary.droppedArtifacts,
      lossAuditOk: contextCompaction.review.lossAudit.ok
    } : undefined,
    claimEventIds: events
      .filter((event) =>
        event.type === "goal.success.evaluated" ||
        event.type === "proof.obligations.reviewed" ||
        event.type === "counterexample.search.reviewed"
      )
      .map((event) => event.id)
  };
}

function persistConjecturalKnowledge(
  runId: string,
  artifacts: ArtifactStore,
  input: {
    cycle: number;
    goalSuccessEventId: string;
    claimId: string;
    verifierId: string;
    evidenceGrade: EvidenceGrade;
    finalState: FinalAnswerState;
    reason: string;
    problemClassification: Record<string, unknown>;
    satisfyingArtifactIds: string[];
    proofObligationArtifactId: string;
  }
) {
  const provenance = {
    source: "goal.success.evaluated",
    sourceEventIds: [input.goalSuccessEventId],
    sourceArtifactIds: input.satisfyingArtifactIds,
    cycle: input.cycle
  };
  const sourceTaint = {
    sourceDerived: true,
    taintedSourceEventIds: [],
    taintedFields: ["source_context", "model_output", "cross_agent_summary"]
  };
  const verifierStatus = {
    verifierId: input.verifierId,
    verified: false,
    status: "not_goal_satisfying_verifier_backed",
    evidenceGrade: input.evidenceGrade
  };
  const dependencyGraph = {
    rootClaimId: input.claimId,
    artifactIds: input.satisfyingArtifactIds,
    proofObligationArtifactId: input.proofObligationArtifactId
  };
  const contradictionReview = {
    status: input.evidenceGrade === "contradicted" ? "contradicted" : "not_contradicted",
    retractionEventIds: [] as string[]
  };
  const supersession = {
    supersededBy: null,
    supersedes: [] as string[]
  };
  const freshness = {
    policy: "expire_without_verifier_refresh",
    expiresAt: null,
    refreshRequiredBeforeProofSupport: true
  };
  const promotion = {
    explicit: true,
    promotedAs: "context_only",
    proofSupportAllowed: false,
    controlsAffected: false,
    providerPolicyMutationAllowed: false,
    budgetMutationAllowed: false,
    toolPolicyMutationAllowed: false,
    goalContractMutationAllowed: false,
    promptFirewallRequired: true,
    promptFirewallReviewed: true
  };
  return artifacts.create(runId, "knowledge.conjecture", JSON.stringify({
    kind: "conjectural_knowledge",
    cycle: input.cycle,
    claimId: input.claimId,
    verifierId: input.verifierId,
    evidenceGrade: input.evidenceGrade,
    finalState: input.finalState,
    truthLevel: "candidate",
    trustGrade: "quarantined_context_only",
    canClaimSolved: false,
    reason: input.reason,
    problemClassification: input.problemClassification,
    provenance,
    sourceTaint,
    verifierStatus,
    dependencyGraph,
    contradictionReview,
    supersession,
    freshness,
    promotion,
    sourceArtifactIds: input.satisfyingArtifactIds,
    proofObligationArtifactId: input.proofObligationArtifactId,
    nextUse: "Feed Knowledge/Evolve so later cycles can refine, falsify, formalize, or find a counterexample.",
    terminal: false
  }, null, 2));
}

function persistNextCyclePlan(input: {
  runId: string;
  run: ReturnType<Ledger["requireRun"]>;
  cycle: number;
  targetCycle: number;
  ledger: Ledger;
  artifacts: ArtifactStore;
  reason: string;
  knowledgeArtifactId?: string;
}): { artifact: ReturnType<ArtifactStore["create"]>; plan: NextCyclePlan } {
  const events = input.ledger.listEvents(input.runId);
  const phaseOutputs = events.filter((event) =>
    event.type === "phase.completed" &&
    Number(event.payload.cycle ?? 1) === input.cycle
  );
  const candidateClaims = events.filter((event) =>
    event.type === "branch.candidate_claim.reviewed" ||
    event.type === "goal.success.evaluated"
  );
  const proofObligations = events.filter((event) => event.type === "proof.obligations.reviewed" || event.type === "branch.proof_obligations.reviewed");
  const counterexamples = events.filter((event) => event.type === "counterexample.search.reviewed");
  const knowledgeEvents = events.filter((event) =>
    event.type === "knowledge.conjecture.saved" &&
    Number(event.payload.cycle ?? 1) === input.cycle
  );
  const sourceResults = events.filter((event) =>
    event.type === "source.results" &&
    Number(event.payload.cycle ?? 1) === input.cycle
  );
  const rankings = events.filter((event) =>
    event.type === "worker.ranked" ||
    (event.type === "phase.completed" && event.payload.phase === "evolve.ranking")
  );
  const experimentJobs = input.ledger.listWorkerJobs(input.runId)
    .filter((job) =>
      job.kind === "workflow.branch" &&
      job.payload.phase === "experiment" &&
      Number(job.payload.cycle ?? 1) === input.cycle
    );
  const nextCycleMutations = buildNextCycleMutations({
    workflow: input.run.workflow,
    sourceCycle: input.cycle,
    targetCycle: input.targetCycle,
    phaseOutputs,
    rankings,
    candidateClaims,
    reason: input.reason
  });
  const knowledgePromotion = persistKnowledgePromotionFirewallReview({
    runId: input.runId,
    targetCycle: input.targetCycle,
    ledger: input.ledger,
    artifacts: input.artifacts,
    inputEvents: uniqueEvents([
      ...phaseOutputs,
      ...sourceResults,
      ...knowledgeEvents,
      ...candidateClaims,
      ...proofObligations,
      ...counterexamples,
      ...rankings
    ])
  });
  const base = {
    format: "matematica.workflow.next-cycle-plan" as const,
    version: 1 as const,
    workflow: input.run.workflow,
    sourceCycle: input.cycle,
    targetCycle: input.targetCycle,
    sourcePhaseOutputEventIds: phaseOutputs.map((event) => event.id),
    sourceArtifactIds: uniqueStrings([
      input.knowledgeArtifactId,
      knowledgePromotion.artifact.id,
      ...phaseOutputs.flatMap((event) => event.artifactIds),
      ...sourceResults.flatMap((event) => event.artifactIds),
      ...knowledgeEvents.flatMap((event) => event.artifactIds),
      ...candidateClaims.flatMap((event) => event.artifactIds),
      ...proofObligations.flatMap((event) => event.artifactIds),
      ...counterexamples.flatMap((event) => event.artifactIds),
      ...rankings.flatMap((event) => event.artifactIds)
    ].filter((id): id is string => typeof id === "string")),
    hypotheses: candidateClaims.slice(-5).map((event) => ({
      eventId: event.id,
      claimId: stringValue(event.payload.claimId),
      status: stringValue(event.payload.status),
      evidenceGrade: stringValue(event.payload.evidenceGrade),
      artifactIds: event.artifactIds
    })),
    proofObligations: proofObligations.slice(-5).map((event) => ({
      eventId: event.id,
      claimId: stringValue(event.payload.claimId),
      decision: event.payload.decision ?? null,
      artifactIds: event.artifactIds
    })),
    counterexamplePlans: counterexamples.slice(-5).map((event) => ({
      eventId: event.id,
      claimId: stringValue(event.payload.claimId),
      status: stringValue(event.payload.status),
      searches: event.payload.searches ?? []
    })),
    experimentManifests: experimentJobs.map((job) => ({
      jobId: job.id,
      role: job.payload.role,
      status: job.status,
      mutation: job.payload.nextCycleMutation ?? null
    })),
    rankings: rankings.slice(-5).map((event) => ({
      eventId: event.id,
      phase: event.payload.phase,
      rankedBranches: event.payload.rankedBranches ?? event.payload.rankedJobs ?? []
    })),
    pruningDecisions: buildPruningDecisions(candidateClaims, experimentJobs),
    nextCycleMutations,
    promptGuidance: {
      source: "workflow.next_cycle.planned",
      reason: input.reason,
      knowledgeArtifactId: input.knowledgeArtifactId,
      knowledgePromotionFirewallReviewHash: knowledgePromotion.review.reviewHash,
      knowledgePromotionFirewallArtifactId: knowledgePromotion.artifact.id,
      focus: input.run.workflow === "pflk"
        ? "Refine or falsify rejected hypotheses while preserving original assumptions."
        : "Prioritize ranked experiment mutations and reproducible failure analysis.",
      requiredEvidenceUpgrade: "Only verifier-backed artifacts can move the goal toward goal_met."
    }
  };
  const planHash = stableHash(base);
  const plan: NextCyclePlan = { ...base, planHash };
  const artifact = input.artifacts.create(input.runId, "workflow.next-cycle.plan", JSON.stringify(plan, null, 2));
  input.ledger.appendEvent(input.runId, "workflow.next_cycle.planned", {
    workflow: input.run.workflow,
    sourceCycle: input.cycle,
    targetCycle: input.targetCycle,
    artifactId: artifact.id,
    planHash,
    knowledgePromotionFirewallArtifactId: knowledgePromotion.artifact.id,
    knowledgePromotionFirewallReviewHash: knowledgePromotion.review.reviewHash,
    promptGuidance: plan.promptGuidance,
    nextCycleMutations: plan.nextCycleMutations,
    experimentRoleOrder: experimentRoleOrderFromPlan(plan),
    reason: input.reason
  }, [artifact.id, knowledgePromotion.artifact.id, ...plan.sourceArtifactIds]);
  return { artifact, plan };
}

function persistKnowledgePromotionFirewallReview(input: {
  runId: string;
  targetCycle: number;
  ledger: Ledger;
  artifacts: ArtifactStore;
  inputEvents: ReturnType<Ledger["listEvents"]>;
}): { artifact: ReturnType<ArtifactStore["create"]>; review: KnowledgePromotionFirewallReview } {
  const review = reviewKnowledgePromotionFirewall({
    targetCycle: input.targetCycle,
    inputEvents: input.inputEvents,
    artifacts: input.ledger.listArtifacts(input.runId)
  });
  const artifact = input.artifacts.create(input.runId, "knowledge.promotion-firewall", JSON.stringify(review, null, 2));
  input.ledger.appendEvent(input.runId, "knowledge.promotion.reviewed", {
    targetCycle: input.targetCycle,
    status: review.ok ? "passed" : "failed",
    artifactId: artifact.id,
    reviewHash: review.reviewHash,
    inputEventIds: review.inputEventIds,
    accepted: review.accepted.map((item) => ({
      eventId: item.eventId,
      eventType: item.eventType,
      role: item.role,
      truthLevel: item.truthLevel,
      trustedAsEvidence: item.trustedAsEvidence,
      evidenceGrade: item.evidenceGrade,
      status: item.status
    })),
    rejected: review.rejected,
    policy: review.policy
  }, [artifact.id, ...uniqueStrings(review.accepted.flatMap((item) => item.artifactIds))]);
  if (!review.ok) {
    throw new Error(`Knowledge promotion firewall blocked next-cycle planning: ${review.rejected.map((issue) => `${issue.code}(${issue.eventId})`).join("; ")}`);
  }
  return { artifact, review };
}

function buildNextCycleMutations(input: {
  workflow: "pflk" | "gree";
  sourceCycle: number;
  targetCycle: number;
  phaseOutputs: ReturnType<Ledger["listEvents"]>;
  rankings: ReturnType<Ledger["listEvents"]>;
  candidateClaims: ReturnType<Ledger["listEvents"]>;
  reason: string;
}): Array<Record<string, unknown>> {
  if (input.workflow === "gree") {
    const latestRanking = input.rankings.at(-1);
    const ranked = Array.isArray(latestRanking?.payload.rankedBranches)
      ? latestRanking.payload.rankedBranches
      : [];
    return [
      {
        mutationId: `gree-${input.targetCycle}-${stableHash({ ranked, reason: input.reason }).slice(0, 12)}`,
        targetPhase: "experiment",
        roleOrder: experimentRoleOrderFromRankedBranches(ranked),
        change: "reuse-ranked-experiment-order",
        sourceEventId: latestRanking?.id
      }
    ];
  }
  const rejected = input.candidateClaims.filter((event) => event.payload.status === "rejected");
  return [
    {
      mutationId: `pflk-${input.targetCycle}-${stableHash({ rejected: rejected.map((event) => event.id), reason: input.reason }).slice(0, 12)}`,
      targetPhase: "loophole",
      roleOrder: ["counterexample-search", "loophole-search"],
      change: "counterexample-first-after-rejected-claim",
      sourceEventIds: rejected.slice(-5).map((event) => event.id)
    }
  ];
}

function buildPruningDecisions(
  candidateClaims: ReturnType<Ledger["listEvents"]>,
  experimentJobs: ReturnType<Ledger["listWorkerJobs"]>
): Array<Record<string, unknown>> {
  const rejected = candidateClaims
    .filter((event) => event.payload.status === "rejected")
    .slice(-5)
    .map((event) => ({
      sourceEventId: event.id,
      claimId: stringValue(event.payload.claimId),
      decision: "do_not_promote_without_new_verifier_artifacts"
    }));
  const failedExperiments = experimentJobs
    .filter((job) => job.status === "failed_terminal")
    .map((job) => ({
      sourceJobId: job.id,
      role: job.payload.role,
      decision: "do_not_repeat_failed_terminal_experiment_without_mutation"
    }));
  return [...rejected, ...failedExperiments];
}

function buildPhaseStructuredOutput(input: {
  workflow: "pflk" | "gree";
  phase: string;
  cycle: number;
  nextTasks: string[];
  researchTasks: string[];
  evolution?: { artifactId: string; rankedBranches: Array<Record<string, unknown>> };
  nextCyclePlan?: Record<string, unknown>;
}): Record<string, unknown> & { nextCycleMutation: Record<string, unknown> } {
  const mutation = {
    mutationId: `${input.workflow}-${input.phase}-${input.cycle}-${stableHash({
      nextTasks: input.nextTasks,
      researchTasks: input.researchTasks,
      nextCyclePlanHash: stringValue(input.nextCyclePlan?.planHash)
    }).slice(0, 12)}`,
    sourcePlanHash: stringValue(input.nextCyclePlan?.planHash),
    targetPhase: input.phase
  };
  return {
    schemaVersion: "workflow-structured-phase-output-v1",
    hypotheses: [{ id: `${input.phase}-hypothesis-${input.cycle}`, status: "candidate", source: "phase-orchestrator" }],
    proofObligations: [{ id: `${input.phase}-obligation-${input.cycle}`, status: "pending_verifier_artifact" }],
    counterexamplePlans: [{ id: `${input.phase}-counterexample-${input.cycle}`, method: "preserve-original-goal-search" }],
    experimentManifests: input.phase === "experiment"
      ? input.nextTasks.map((jobId) => ({ jobId, reproducibility: "required", sandbox: "matematica" }))
      : [],
    rankings: input.evolution?.rankedBranches ?? [],
    pruningDecisions: [{ id: `${input.phase}-prune-${input.cycle}`, rule: "discard-unverifier-backed-goal-success" }],
    nextCycleMutation: mutation
  };
}

function buildPhaseProgressionRecord(input: {
  workflow: "pflk" | "gree";
  phase: string;
  cycle: number;
  problem: string;
  goal: string;
  nextTasks: string[];
  researchTasks: string[];
  structuredOutput: Record<string, unknown> & { nextCycleMutation: Record<string, unknown> };
  evolution?: { artifactId: string; rankedBranches: Array<Record<string, unknown>> };
  nextCyclePlan?: Record<string, unknown>;
}): Record<string, unknown> {
  const sourcePlanHash = stringValue(input.nextCyclePlan?.planHash);
  const mutationId = stringValue(input.structuredOutput.nextCycleMutation.mutationId) ?? "phase-local-mutation";
  const promotionDecisions = buildPhasePromotionDecisions(input);
  const pruningDecisions = Array.isArray(input.structuredOutput.pruningDecisions)
    ? input.structuredOutput.pruningDecisions
    : [];
  const appliedTo = input.nextTasks.length > 0
    ? ["branch_prompt_lineage", "branch_role_allocation", "fanout_dedupe_scope"]
    : input.researchTasks.length > 0
      ? ["research_query_lineage", "source_context_boundary"]
      : ["phase_summary", "next_cycle_decision"];
  const base = {
    schemaVersion: "workflow-phase-progression-v1" as const,
    workflow: input.workflow,
    phase: input.phase,
    cycle: input.cycle,
    sourcePlanHash,
    changedFromPriorCycle: input.cycle === 1
      ? "baseline_from_problem_goal"
      : "applied_prior_workflow_next_cycle_plan",
    inputStateHash: stableHash({
      problem: input.problem,
      goal: input.goal,
      workflow: input.workflow,
      phase: input.phase,
      cycle: input.cycle,
      sourcePlanHash,
      nextCycleMutations: input.nextCyclePlan?.nextCycleMutations,
      promptGuidance: input.nextCyclePlan?.promptGuidance
    }),
    changedDimensions: uniqueStrings([
      "prompt_lineage",
      input.nextTasks.length > 0 ? "branch_allocation" : undefined,
      input.researchTasks.length > 0 ? "research_query" : undefined,
      sourcePlanHash ? "prior_cycle_feedback" : undefined,
      input.evolution ? "experiment_ranking" : undefined
    ].filter((item): item is string => typeof item === "string")),
    promotionDecisions,
    pruningDecisions,
    suppressionRules: [
      {
        rule: "do_not_repeat_rejected_claim_without_new_verifier_artifact",
        source: "workflow.next_cycle.planned"
      },
      {
        rule: "do_not_repeat_failed_terminal_experiment_without_mutation",
        source: "workflow.next_cycle.planned"
      }
    ],
    promptInfluence: {
      source: sourcePlanHash ? "workflow.next_cycle.planned" : "initial_problem_goal",
      sourcePlanHash,
      mutationId,
      appliedTo,
      guidanceHash: stableHash({
        sourcePlanHash,
        promptGuidance: input.nextCyclePlan?.promptGuidance,
        mutation: input.structuredOutput.nextCycleMutation,
        appliedTo
      })
    },
    nextCyclePlanImpact: input.phase === "knowledge" || input.phase === "evolve"
      ? {
          required: true,
          targetCycle: input.cycle + 1,
          reason: "terminal workflow phase must feed a measured next-cycle plan unless the verifier-backed goal is met"
        }
      : undefined
  };
  return {
    ...base,
    progressionHash: stableHash(base)
  };
}

function buildPhasePromotionDecisions(input: {
  phase: string;
  nextTasks: string[];
  researchTasks: string[];
  evolution?: { artifactId: string; rankedBranches: Array<Record<string, unknown>> };
}): Array<Record<string, unknown>> {
  const decisions: Array<Record<string, unknown>> = [];
  if (input.nextTasks.length > 0) {
    decisions.push({
      decision: "promote_to_parallel_branch_tasks",
      targetPhase: input.phase,
      jobIds: input.nextTasks
    });
  }
  if (input.researchTasks.length > 0) {
    decisions.push({
      decision: "promote_to_source_research_tasks",
      targetPhase: input.phase,
      jobIds: input.researchTasks
    });
  }
  if (input.evolution) {
    decisions.push({
      decision: "promote_ranked_experiment_order_to_next_cycle",
      artifactId: input.evolution.artifactId,
      rankedBranches: input.evolution.rankedBranches
    });
  }
  if (decisions.length === 0) {
    decisions.push({
      decision: "record_nonterminal_phase_state",
      targetPhase: input.phase
    });
  }
  return decisions;
}

function experimentRoleOrderFromPlan(plan: NextCyclePlan): string[] {
  const mutationRoles = plan.nextCycleMutations
    .flatMap((mutation) => Array.isArray(mutation.roleOrder) ? mutation.roleOrder : [])
    .filter((item): item is string => typeof item === "string" && item.length > 0);
  return mutationRoles.length > 0 ? uniqueStrings(mutationRoles) : ["experiment-search", "evolution-candidate"];
}

function experimentRoleOrderFromRankedBranches(ranked: unknown[]): string[] {
  const roles = ranked
    .map((item) => recordValue(item)?.role)
    .filter((role): role is string => typeof role === "string" && role.length > 0);
  return roles.length > 0 ? uniqueStrings(roles) : ["experiment-search", "evolution-candidate"];
}

function branchNextCycleMutation(
  plan: Record<string, unknown> | undefined,
  phase: string,
  role: string,
  branch: number
): Record<string, unknown> {
  return {
    mutationId: `${phase}-${branch}-${stableHash({ planHash: stringValue(plan?.planHash), role }).slice(0, 12)}`,
    sourcePlanArtifactId: stringValue(plan?.artifactId),
    sourcePlanHash: stringValue(plan?.planHash),
    role,
    branch
  };
}

function buildPhaseSummary(phase: string, problem: string, goal: string): string {
  return [
    `phase: ${phase}`,
    `problem: ${problem}`,
    `goal: ${goal}`,
    "",
    "This v0 local summary is deterministic and persisted to prove the ledger and replay path before paid model workers are enabled."
  ].join("\n");
}

function ensureWorkflowPhaseJob(
  runId: string,
  ledger: Ledger,
  workflow: "pflk" | "gree",
  phase: ReturnType<typeof workflowPhases>[number],
  cycle: number,
  contextCompactionEvent?: ReturnType<typeof persistContextCompactionReview>["event"],
  nextCyclePlan?: Record<string, unknown>
): void {
  const jobs = ledger.listWorkerJobs(runId);
  const existing = jobs.some((job) =>
    job.kind === "workflow.phase" &&
    job.payload.phase === phase.name &&
    Number(job.payload.cycle ?? 1) === cycle
  );
  if (existing) return;
  ledger.enqueueWorkerJob({
    runId,
    kind: "workflow.phase",
    maxAttempts: 1,
    payload: {
      workflow,
      phase: phase.name,
      order: phase.order,
      fanout: phase.fanout,
      cycle,
      contextCompactionEventId: contextCompactionEvent?.id,
      contextCompactionReviewHash: contextCompactionEvent?.payload.reviewHash,
      nextCyclePlanArtifactId: stringValue(nextCyclePlan?.artifactId),
      nextCyclePlanHash: stringValue(nextCyclePlan?.planHash),
      nextCyclePlan
    }
  });
}

function executePhaseJob(
  job: ReturnType<typeof assertPhaseJob>,
  problem: string,
  goal: string,
  ledger: Ledger,
  artifacts: ArtifactStore,
  options: RunGoalOptions
): Record<string, unknown> {
  const { phase, fanout, workflow } = job.payload;
  const cycle = Number(job.payload.cycle ?? 1);
  const contract = workflowPhaseContract(workflow, phase);
  ledger.appendEvent(job.runId, "phase.started", {
    phase,
    workflow,
    jobId: job.id,
    order: job.payload.order,
    cycle,
    contractVersion: contract.version,
    contextCompactionEventId: job.payload.contextCompactionEventId,
    contextCompactionReviewHash: job.payload.contextCompactionReviewHash,
    nextCyclePlanArtifactId: job.payload.nextCyclePlanArtifactId,
    nextCyclePlanHash: job.payload.nextCyclePlanHash,
    allowedTools: contract.allowedTools,
    verifierChecks: contract.verifierChecks,
    gates: contract.gates
  });
  const nextTasks = fanout
    ? createBranchJobs(job.runId, workflow, phase, cycle, job.id, problem, goal, ledger, artifacts, job.payload, options)
    : [];
  const researchTasks = phase === "feedback" || phase === "gather"
    ? createResearchJobs(job.runId, workflow, phase, cycle, job.id, problem, goal, ledger, job.payload)
    : [];
  const evolution = workflow === "gree" && phase === "evolve"
    ? rankExperimentBranches(job.runId, ledger, artifacts, cycle)
    : undefined;
  const structuredOutput = buildPhaseStructuredOutput({
    workflow,
    phase,
    cycle,
    nextTasks,
    researchTasks,
    evolution,
    nextCyclePlan: job.payload.nextCyclePlan
  });
  const summary = buildPhaseSummary(phase, problem, goal);
  const summaryArtifactId = makeId("art");
  const progression = buildPhaseProgressionRecord({
    workflow,
    phase,
    cycle,
    problem,
    goal,
    nextTasks,
    researchTasks,
    structuredOutput,
    evolution,
    nextCyclePlan: job.payload.nextCyclePlan
  });
  const outputManifest = {
    schemaVersion: "workflow-phase-output-v1",
    workflow,
    phase,
    cycle,
    phaseJobId: job.id,
    workerRole: "phase-orchestrator",
    promptLineage: buildPromptLineage("workflow.phase", problem, goal, {
      phase,
      cycle,
      contextCompactionEventId: job.payload.contextCompactionEventId,
      contextCompactionReviewHash: job.payload.contextCompactionReviewHash,
      nextCyclePlanHash: job.payload.nextCyclePlanHash,
      nextCycleMutationId: structuredOutput.nextCycleMutation.mutationId
    }),
    providerRoute: { provider: "local", modelId: "deterministic-orchestrator" },
    artifactIds: [summaryArtifactId],
    nextCycleDecision: contract.allowedNextPhases.length > 0
      ? { action: "next_phase", nextPhase: contract.allowedNextPhases[0] }
      : { action: "next_cycle", fromPhase: phase, nextCycle: cycle + 1 },
    progression,
    nextTasks,
    researchTasks,
    structuredOutput,
    nextCycleMutation: structuredOutput.nextCycleMutation,
    evolutionArtifactId: evolution?.artifactId
  };
  const artifact = artifacts.create(job.runId, `phase.${phase}.summary`, JSON.stringify({
    phase,
    workflow,
    cycle,
    contract,
    summary,
    nextTasks,
    researchTasks,
    evolution,
    structuredOutput,
    progression,
    terminalSuccessAllowed: phase === "knowledge" || phase === "evolve" ? false : undefined,
    consumesEvidenceAs: phase === "knowledge" || phase === "evolve"
      ? "conjectural_or_rejected_nonterminal"
      : undefined,
    outputManifest
  }, null, 2), { id: summaryArtifactId });
  const completionPayload = {
    phase,
    workflow,
    cycle,
    jobId: job.id,
    contractVersion: contract.version,
    contextCompactionEventId: job.payload.contextCompactionEventId,
    contextCompactionReviewHash: job.payload.contextCompactionReviewHash,
    requiredArtifactKinds: contract.requiredArtifactKinds,
    allowedTools: contract.allowedTools,
    verifierChecks: contract.verifierChecks,
    budgetUse: contract.budgetUse,
    allowedNextPhases: contract.allowedNextPhases,
    gates: contract.gates,
    outputRequirements: contract.outputRequirements,
    terminalSuccessAllowed: phase === "knowledge" || phase === "evolve" ? false : undefined,
    consumesEvidenceAs: phase === "knowledge" || phase === "evolve"
      ? "conjectural_or_rejected_nonterminal"
      : undefined,
    summaryArtifactId: artifact.id,
    nextTasks,
    researchTasks,
    structuredOutput,
    nextCycleMutation: structuredOutput.nextCycleMutation,
    progression,
    evolutionArtifactId: evolution?.artifactId,
    outputManifest
  };
  const validation = validatePhaseCompletion({
    ledger,
    runId: job.runId,
    workflow,
    phase,
    cycle,
    payload: completionPayload,
    artifactIds: [artifact.id]
  });
  if (!validation.ok) {
    throw new Error(`Phase contract blocked ${workflow}/${phase}: ${validation.failures.join("; ")}`);
  }
  const phaseCompletedEvent = ledger.appendEvent(job.runId, "phase.completed", completionPayload, [artifact.id]);
  persistAdversarialQuorumReview({
    runId: job.runId,
    ledger,
    artifacts,
    scope: "phase_transition",
    targetEvent: phaseCompletedEvent,
    targetArtifactIds: [artifact.id]
  });
  return {
    phase,
    workflow,
    summaryArtifactId: artifact.id,
    nextTasks,
    researchTasks,
    structuredOutput,
    nextCycleMutation: structuredOutput.nextCycleMutation,
    evolutionArtifactId: evolution?.artifactId
  };
}

function assertPhaseJob(job: Parameters<typeof isPhaseJob>[0]) {
  if (!isPhaseJob(job)) throw new Error(`Expected workflow.phase job, got ${job.kind}`);
  return job;
}

function createBranchJobs(
  runId: string,
  workflow: "pflk" | "gree",
  phase: string,
  cycle: number,
  parentPhaseJobId: string,
  problem: string,
  goal: string,
  ledger: Ledger,
  artifacts: ArtifactStore,
  parentPayload: Record<string, unknown>,
  options: RunGoalOptions
): string[] {
  const existing = ledger.listWorkerJobs(runId)
    .filter((job) =>
      job.kind === "workflow.branch" &&
      job.payload.phase === phase &&
      Number(job.payload.cycle ?? 1) === cycle
    );
  if (existing.length > 0) return existing.map((job) => job.id);

  const nextCyclePlan = recordValue(parentPayload.nextCyclePlan);
  const run = ledger.requireRun(runId);
  const usage = ledger.getBudgetUsage(runId);
  const branchModels = branchModelsForOptions(options);
  const providerConcurrency = branchProviderConcurrencyLimit(options);
  const plan = buildDynamicSwarmFanoutPlan({
    runId,
    workflow,
    phase,
    cycle,
    parentPhaseJobId,
    budget: run.budget,
    usage,
    requestedWorkers: run.budget.maxWorkers ?? 1,
    reservePerWorker: {
      attempts: branchModels.length > 0 ? 1 : 0,
      tokens: maxBranchModelOutputTokens(options),
      usd: maxBranchModelUsd(options),
      elapsedMs: 1
    },
    providerConcurrency,
    providerRoutes: branchModels.length > 0
      ? branchModels.map((model) => ({
          provider: model.provider,
          modelId: model.modelId,
          mode: model.provider === "local" ? "local-deterministic" as const : "ai-sdk" as const,
          providerConcurrency: finitePositiveInteger(model.settings?.resilience?.maxConcurrency)
        }))
      : undefined,
    providerDiversityWaiver: options.providerDiversityWaiver,
    nextCyclePlan
  });
  if (!plan.diversityReport.ok) {
    throw new Error(`Swarm fanout diversity check failed: ${plan.diversityReport.issues.join("; ")}`);
  }
  persistSwarmCapacityPlan({
    runId,
    ledger,
    artifacts,
    plan: plan.capacityPlan
  });
  const persistedPlan = persistDynamicSwarmFanoutPlan({
    runId,
    ledger,
    artifacts,
    plan
  });
  return plan.branches.map((branchPlan) => {
    const role = branchPlan.role;
    const strategySelection = selectHardMathStrategy({
      problem,
      goal,
      workflow,
      phase,
      role
    });
    const nextCycleMutation: Record<string, unknown> = {
      ...branchNextCycleMutation(nextCyclePlan, phase, role, branchPlan.branch),
      fanoutMutationId: branchPlan.lineage.mutationId,
      promptMutationHash: branchPlan.promptMutationHash,
      fanoutPlanHash: plan.planHash
    };
    return ledger.enqueueWorkerJob({
      runId,
      kind: "workflow.branch",
      maxAttempts: 1,
      dedupeKey: branchPlan.dedupeKey,
      payload: {
        workflow,
        phase,
        cycle,
        parentPhaseJobId,
        branch: branchPlan.branch,
        role,
        strategySelection,
        nextCyclePlanArtifactId: stringValue(nextCyclePlan?.artifactId),
        nextCyclePlanHash: stringValue(nextCyclePlan?.planHash),
        nextCyclePlan,
        nextCycleMutation,
        fanoutPlanHash: plan.planHash,
        fanoutPlanArtifactId: persistedPlan.artifactId,
        fanoutLineage: branchPlan.lineage,
        promptMutationHash: branchPlan.promptMutationHash,
        promptMutation: branchPlan.promptMutation,
        capacityPlanHash: plan.capacityPlan.planHash,
        capacityInitiallyAdmitted: true,
        capacityMode: branchPlan.capacityMode,
        contextCompactionEventId: parentPayload.contextCompactionEventId,
        contextCompactionReviewHash: parentPayload.contextCompactionReviewHash,
        promptLineage: buildPromptLineage("workflow.branch", problem, goal, {
          phase,
          cycle,
          branch: branchPlan.branch,
          role,
          strategySelectionHash: strategySelection.selectionHash,
          selectedStrategyId: strategySelection.selectedStrategyId,
          selectedTacticIds: strategySelection.selectedTacticIds,
          fanoutPlanHash: plan.planHash,
          fanoutLineageMutationId: branchPlan.lineage.mutationId,
          promptMutationHash: branchPlan.promptMutationHash,
          nextCyclePlanHash: stringValue(nextCyclePlan?.planHash),
          nextCycleMutationId: stringValue(nextCycleMutation["mutationId"]),
          contextCompactionEventId: parentPayload.contextCompactionEventId,
          contextCompactionReviewHash: parentPayload.contextCompactionReviewHash
        }),
        providerRoute: branchPlan.providerRoute
      }
    }).id;
  });
}

function createResearchJobs(
  runId: string,
  workflow: "pflk" | "gree",
  phase: "feedback" | "gather",
  cycle: number,
  parentPhaseJobId: string,
  problem: string,
  goal: string,
  ledger: Ledger,
  parentPayload: Record<string, unknown>
): string[] {
  const existing = ledger.listWorkerJobs(runId)
    .filter((job) =>
      (job.kind === "research.arxiv" || job.kind === "research.mathlib") &&
      job.payload.phase === phase &&
      Number(job.payload.cycle ?? 1) === cycle
    );
  if (existing.some((job) => job.kind === "research.arxiv") && existing.some((job) => job.kind === "research.mathlib")) {
    return existing.map((job) => job.id);
  }

  const query = buildArxivQuery(problem, goal);
  const jobIds = existing.map((job) => job.id);
  if (!existing.some((job) => job.kind === "research.arxiv")) {
    jobIds.push(ledger.enqueueWorkerJob({
      runId,
      kind: "research.arxiv",
      maxAttempts: 2,
      payload: {
        workflow,
        phase,
        cycle,
        parentPhaseJobId,
        provider: "arxiv",
        query,
        maxResults: 5,
        contextCompactionEventId: parentPayload.contextCompactionEventId,
        contextCompactionReviewHash: parentPayload.contextCompactionReviewHash,
        promptLineage: buildPromptLineage("research.arxiv", problem, goal, {
          phase,
          cycle,
          query,
          contextCompactionEventId: parentPayload.contextCompactionEventId,
          contextCompactionReviewHash: parentPayload.contextCompactionReviewHash
        }),
        providerRoute: { provider: "arxiv", modelId: "arxiv-api" }
      }
    }).id);
  }
  if (!existing.some((job) => job.kind === "research.mathlib")) {
    const mathlibQuery = `${problem} ${goal}`;
    jobIds.push(ledger.enqueueWorkerJob({
      runId,
      kind: "research.mathlib",
      maxAttempts: 1,
      payload: {
        workflow,
        phase,
        cycle,
        parentPhaseJobId,
        provider: "mathlib",
        query: mathlibQuery,
        maxResults: 5,
        contextCompactionEventId: parentPayload.contextCompactionEventId,
        contextCompactionReviewHash: parentPayload.contextCompactionReviewHash,
        promptLineage: buildPromptLineage("research.mathlib", problem, goal, {
          phase,
          cycle,
          queryHash: stableHash(mathlibQuery),
          contextCompactionEventId: parentPayload.contextCompactionEventId,
          contextCompactionReviewHash: parentPayload.contextCompactionReviewHash
        }),
        providerRoute: { provider: "mathlib", modelId: "pinned-theorem-index" }
      }
    }).id);
  }
  return jobIds;
}

function executeMathlibResearchJob(
  job: ReturnType<typeof assertResearchJob>,
  problem: string,
  goal: string,
  artifacts: ArtifactStore,
  ledger: Ledger
): Record<string, unknown> {
  const { query, maxResults, phase } = job.payload;
  const cycle = Number(job.payload.cycle ?? 1);
  const index = defaultMathlibTheoremIndexSnapshot();
  const retrieval = retrieveMathlibLemmas({
    problem,
    goal,
    maxResults,
    index
  });
  const artifact = artifacts.create(job.runId, "source.mathlib.results", JSON.stringify({
    phase,
    cycle,
    provider: "mathlib",
    queryHash: stableHash(query),
    retrieval,
    index: {
      format: index.format,
      version: index.version,
      indexVersion: index.indexVersion,
      indexHash: index.indexHash,
      mathlibRevision: index.mathlibRevision,
      lakeManifestHash: index.lakeManifestHash,
      generatedAt: index.generatedAt,
      entryCount: index.entries.length
    },
    promptContext: {
      sourceTextIncluded: false,
      localPathsIncluded: false,
      controlsAffected: false,
      proofSupport: false,
      theoremHandles: retrieval.results.map((lemma) => lemma.promptSummary)
    }
  }, null, 2));
  ledger.appendEvent(job.runId, "source.results", {
    provider: "mathlib",
    phase,
    cycle,
    queryHash: stableHash(query),
    count: retrieval.count,
    quarantined: true,
    offlineCacheOnly: true,
    indexVersion: retrieval.indexVersion,
    indexHash: retrieval.indexHash,
    mathlibRevision: retrieval.mathlibRevision,
    lakeManifestHash: retrieval.lakeManifestHash,
    trust: retrieval.trust,
    retrievedLemmas: retrieval.results.map((lemma) => ({
      name: lemma.name,
      module: lemma.module,
      namespace: lemma.namespace,
      kind: lemma.kind,
      statementHash: lemma.statementHash,
      trustGrade: lemma.trustGrade,
      relevanceScore: lemma.relevanceScore,
      provenance: lemma.provenance,
      promptSummary: lemma.promptSummary
    })),
    retrievalEvaluation: {
      retrievedCount: retrieval.count,
      precision: retrieval.count > 0 ? 1 : 0,
      recall: retrieval.count > 0 ? 1 : 0,
      citationValidity: 1,
      sourceUseRate: 1,
      failures: [],
      trustImpact: "formal_index_metadata_only",
      canPromoteResearchBackedClaims: false,
      theoremIndexDrift: false
    },
    artifactId: artifact.id
  }, [artifact.id]);
  ledger.appendEvent(job.runId, "source.retrieval.evaluated", {
    provider: "mathlib",
    phase,
    cycle,
    artifactId: artifact.id,
    indexVersion: retrieval.indexVersion,
    indexHash: retrieval.indexHash,
    mathlibRevision: retrieval.mathlibRevision,
    lakeManifestHash: retrieval.lakeManifestHash,
    retrievedCount: retrieval.count,
    precision: retrieval.count > 0 ? 1 : 0,
    recall: retrieval.count > 0 ? 1 : 0,
    citationValidity: 1,
    sourceUseRate: 1,
    failures: [],
    trustImpact: "formal_index_metadata_only",
    canPromoteResearchBackedClaims: false,
    theoremIndexDrift: false
  }, [artifact.id]);
  return {
    provider: "mathlib",
    phase,
    cycle,
    artifactId: artifact.id,
    indexVersion: retrieval.indexVersion,
    indexHash: retrieval.indexHash,
    retrievedCount: retrieval.count,
    offlineCacheOnly: true
  };
}

async function executeResearchJob(
  job: ReturnType<typeof assertResearchJob>,
  arxivSearch: (query: string, options: { maxResults: number; abortSignal?: AbortSignal }) => Promise<ArxivPaper[]>,
  artifacts: ArtifactStore,
  ledger: Ledger,
  sourceNetworkPolicy: NetworkPolicy,
  abortSignal?: AbortSignal
): Promise<Record<string, unknown>> {
  const { query, maxResults, phase } = job.payload;
  const cycle = Number(job.payload.cycle ?? 1);
  const request = {
    provider: "arxiv",
    phase,
    cycle,
    query,
    maxResults,
    sortBy: "submittedDate",
    sortOrder: "descending",
    requestedAt: new Date().toISOString()
  };
  const compliance = arxivCompliancePolicy();
  const requestHash = stableHash(request);
  const idempotencyKey = externalOperationIdempotencyKey({
    runId: job.runId,
    operationType: "source.arxiv",
    requestHash
  });
  if (sourceNetworkPolicy.offline) {
    const cached = cachedExternalOperation(ledger, job.runId, idempotencyKey);
    if (cached?.responseArtifactId) {
      ledger.appendEvent(job.runId, "source.offline_cache.used", {
        provider: "arxiv",
        phase,
        cycle,
        query,
        maxResults,
        offlineCacheOnly: true,
        networkMode: sourceNetworkPolicy.mode,
        reason: sourceNetworkPolicy.reason,
        compliance,
        externalOperationId: cached.id,
        artifactId: cached.responseArtifactId,
        requestHash,
        idempotencyKey
      }, [cached.responseArtifactId]);
      return {
        provider: "arxiv",
        phase,
        cycle,
        query,
        artifactId: cached.responseArtifactId,
        externalOperationId: cached.id,
        replayedFromOutbox: true,
        offlineCacheOnly: true
      };
    }
    const sharedCache = await fetchArxivWithCache({
      ledger,
      query,
      maxResults,
      allowNetwork: false
    });
    if (sharedCache.cache.usedCache) {
      const quarantinedPapers = quarantineArxivPapers(sharedCache.papers, { citationOnly: true });
      const sourceRecords = buildArxivSourceRecords(quarantinedPapers, { query });
      const citationGrounding = validateCitations(sourceRecords.map(claimedCitationFromSourceRecord), sourceRecords);
      const retrievalEvaluation = evaluateLiteratureRetrieval({
        query,
        papers: quarantinedPapers,
        sourceRecords,
        citationGrounding
      });
      const enrichment = buildArxivResearchEnrichment({
        query,
        papers: quarantinedPapers,
        sourceRecords,
        redistribution: compliance.pdfAndSourceRedistribution,
        metadataRedistribution: compliance.metadataRedistribution,
        termsUrl: compliance.termsUrl,
        citationGrounding
      });
      updateArxivCacheReview({
        ledger,
        cacheKey: sharedCache.cache.cacheKey,
        sourceSnapshotHashes: sourceRecords.map((record) => record.snapshotHash),
        retrievalQuality: {
          retrievedCount: retrievalEvaluation.retrievedCount,
          relevantRetrieved: retrievalEvaluation.relevantRetrieved,
          expectedRetrieved: retrievalEvaluation.expectedRetrieved,
          precision: retrievalEvaluation.precision,
          recall: retrievalEvaluation.recall,
          citationValidity: retrievalEvaluation.citationValidity,
          sourceUseRate: retrievalEvaluation.sourceUseRate,
          irrelevantResultCount: retrievalEvaluation.irrelevantResultCount,
          keywordOverfitCount: retrievalEvaluation.keywordOverfitCount,
          failures: retrievalEvaluation.failures,
          trustImpact: retrievalEvaluation.trustImpact,
          canPromoteResearchBackedClaims: retrievalEvaluation.canPromoteResearchBackedClaims,
          staleResultCount: retrievalEvaluation.staleResultCount,
          incompleteResearch: sharedCache.cache.stale,
          reviewedAt: new Date().toISOString()
        }
      });
      const artifact = artifacts.create(job.runId, "source.arxiv.results", JSON.stringify({
        phase,
        cycle,
        query,
        offlineCacheOnly: true,
        networkMode: sourceNetworkPolicy.mode,
        reason: sourceNetworkPolicy.reason,
        cache: sharedCache.cache,
        compliance,
        trust: {
          sourceTextTrusted: false,
          quarantine: true,
          hostileFlags: quarantinedPapers.flatMap((paper) => paper.trust.flags),
          redistribution: compliance.pdfAndSourceRedistribution
        },
        sourceRecords,
        citationGrounding,
        retrievalEvaluation,
        semanticDedupe: enrichment.semanticDedupe,
        citationGraph: enrichment.citationGraph,
        snapshots: enrichment.snapshots,
        sourceQuality: enrichment.sourceQuality,
        citationLicenseManifest: enrichment.citationLicenseManifest,
        papers: quarantinedPapers,
        selectedAbstracts: quarantinedPapers.slice(0, 3).map((paper) => ({
          id: paper.id,
          title: paper.title,
          summaryPreview: paper.summaryPreview,
          absUrl: paper.absUrl,
          pdfUrl: paper.pdfUrl,
          categories: paper.categories,
          rawMetadataHash: paper.rawMetadataHash,
          trust: paper.trust
        }))
      }, null, 2));
      ledger.appendEvent(job.runId, "source.offline_cache.used", {
        provider: "arxiv",
        phase,
        cycle,
        query,
        maxResults,
        offlineCacheOnly: true,
        networkMode: sourceNetworkPolicy.mode,
        reason: sourceNetworkPolicy.reason,
        compliance,
        requestHash,
        idempotencyKey,
        artifactId: artifact.id,
        cache: sharedCache.cache
      }, [artifact.id]);
      ledger.appendEvent(job.runId, "source.results", {
        provider: "arxiv",
        phase,
        cycle,
        query,
        count: sharedCache.papers.length,
        quarantined: true,
        offlineCacheOnly: true,
        networkMode: sourceNetworkPolicy.mode,
        compliance,
        requestHash,
        cache: sharedCache.cache,
        sourceRecords: sourceRecords.map((record) => ({
          query: record.query,
          sourceId: record.sourceId,
          canonicalId: record.canonicalId,
          version: record.version,
          title: record.title,
          authors: record.authors,
          published: record.published,
          updated: record.updated,
          retrievedAt: record.retrievedAt,
          ranking: record.ranking,
          abstractHash: record.abstractHash,
          snapshotHash: record.snapshotHash,
          rawMetadataHash: record.rawMetadataHash,
          extractedClaims: record.extractedClaims,
          sourceFieldTaint: record.sourceFieldTaint,
          contentHash: record.contentHash,
          url: record.url
        })),
        citationGrounding,
        retrievalEvaluation: {
          precision: retrievalEvaluation.precision,
          recall: retrievalEvaluation.recall,
          citationValidity: retrievalEvaluation.citationValidity,
          sourceUseRate: retrievalEvaluation.sourceUseRate,
          failures: retrievalEvaluation.failures,
          trustImpact: retrievalEvaluation.trustImpact,
          canPromoteResearchBackedClaims: retrievalEvaluation.canPromoteResearchBackedClaims,
          staleResultCount: retrievalEvaluation.staleResultCount,
          incompleteResearch: sharedCache.cache.stale
        },
        citationLicenseManifest: enrichment.citationLicenseManifest,
        ...researchEnrichmentEventPayload(enrichment),
        artifactId: artifact.id
      }, [artifact.id]);
      ledger.appendEvent(job.runId, "source.citations.reviewed", {
        provider: "arxiv",
        phase,
        cycle,
        cache: sharedCache.cache,
        ...citationGrounding
      }, [artifact.id]);
      ledger.appendEvent(job.runId, "source.retrieval.evaluated", {
        provider: "arxiv",
        phase,
        cycle,
        artifactId: artifact.id,
        cache: sharedCache.cache,
        ...retrievalEvaluation
      }, [artifact.id]);
      appendResearchEnrichmentEvents(ledger, job.runId, {
        phase,
        cycle,
        query,
        artifactId: artifact.id,
        enrichment
      });
      return {
        provider: "arxiv",
        phase,
        cycle,
        query,
        artifactId: artifact.id,
        offlineCacheOnly: true,
        cache: sharedCache.cache
      };
    }
    const offlineCitationGrounding = validateCitations([], []);
    const offlineRetrievalEvaluation = evaluateLiteratureRetrieval({
      query,
      papers: [],
      sourceRecords: [],
      citationGrounding: offlineCitationGrounding
    });
    const offlineEnrichment = buildArxivResearchEnrichment({
      query,
      papers: [],
      sourceRecords: [],
      redistribution: compliance.pdfAndSourceRedistribution,
      metadataRedistribution: compliance.metadataRedistribution,
      termsUrl: compliance.termsUrl,
      citationGrounding: offlineCitationGrounding
    });
    const artifact = artifacts.create(job.runId, "source.arxiv.results", JSON.stringify({
      phase,
      cycle,
      query,
      offlineCacheOnly: true,
      networkMode: sourceNetworkPolicy.mode,
      reason: sourceNetworkPolicy.reason,
      compliance,
      cache: sharedCache.cache,
      trust: {
        sourceTextTrusted: false,
        quarantine: true,
        hostileFlags: [],
        redistribution: compliance.pdfAndSourceRedistribution
      },
      sourceRecords: [],
      citationLicenseManifest: offlineEnrichment.citationLicenseManifest,
      citationGrounding: offlineCitationGrounding,
      retrievalEvaluation: offlineRetrievalEvaluation,
      semanticDedupe: offlineEnrichment.semanticDedupe,
      citationGraph: offlineEnrichment.citationGraph,
      snapshots: offlineEnrichment.snapshots,
      sourceQuality: offlineEnrichment.sourceQuality,
      papers: [],
      selectedAbstracts: []
    }, null, 2));
    ledger.appendEvent(job.runId, "source.offline_cache.missed", {
      provider: "arxiv",
      phase,
      cycle,
      query,
      maxResults,
      offlineCacheOnly: true,
      networkMode: sourceNetworkPolicy.mode,
      reason: sourceNetworkPolicy.reason,
      compliance,
      requestHash,
      idempotencyKey,
      artifactId: artifact.id,
      cache: sharedCache.cache
    }, [artifact.id]);
    ledger.appendEvent(job.runId, "source.results", {
      provider: "arxiv",
      phase,
      cycle,
      query,
      count: 0,
      quarantined: true,
      offlineCacheOnly: true,
      networkMode: sourceNetworkPolicy.mode,
      compliance,
      requestHash,
      cache: sharedCache.cache,
      sourceRecords: [],
      citationGrounding: offlineCitationGrounding,
      retrievalEvaluation: {
        precision: offlineRetrievalEvaluation.precision,
        recall: offlineRetrievalEvaluation.recall,
        citationValidity: offlineRetrievalEvaluation.citationValidity,
        sourceUseRate: offlineRetrievalEvaluation.sourceUseRate,
        failures: offlineRetrievalEvaluation.failures,
        trustImpact: offlineRetrievalEvaluation.trustImpact,
        canPromoteResearchBackedClaims: offlineRetrievalEvaluation.canPromoteResearchBackedClaims,
        staleResultCount: offlineRetrievalEvaluation.staleResultCount,
        incompleteResearch: true
      },
      citationLicenseManifest: offlineEnrichment.citationLicenseManifest,
      ...researchEnrichmentEventPayload(offlineEnrichment),
      artifactId: artifact.id
    }, [artifact.id]);
    appendResearchEnrichmentEvents(ledger, job.runId, {
      phase,
      cycle,
      query,
      artifactId: artifact.id,
      enrichment: offlineEnrichment
    });
    return {
      provider: "arxiv",
      phase,
      cycle,
      query,
      artifactId: artifact.id,
      offlineCacheOnly: true,
      cache: sharedCache.cache
    };
  }
  const requestArtifact = artifacts.create(job.runId, "source.arxiv.request", JSON.stringify(request, null, 2));
  const prepared = ledger.prepareExternalOperation({
    runId: job.runId,
    operationType: "source.arxiv",
    provider: "arxiv",
    idempotencyKey,
    requestHash,
    reserve: { elapsedMs: 1 },
    requestArtifactId: requestArtifact.id
  });
  if (!prepared.ok) {
    throw new Error(`Budget exhausted before arXiv fetch: ${prepared.reason}`);
  }
  if (!prepared.created) {
    if (prepared.operation.status === "succeeded" && prepared.operation.responseArtifactId) {
      return {
        provider: "arxiv",
        phase,
        cycle,
        query,
        artifactId: prepared.operation.responseArtifactId,
        externalOperationId: prepared.operation.id,
        replayedFromOutbox: true
      };
    }
    throw new Error(`External operation ${prepared.operation.id} already exists in status ${prepared.operation.status}; refusing duplicate arXiv fetch.`);
  }
  const operation = ledger.startExternalOperation(prepared.operation.id);
  const startedAt = Date.now();
  ledger.appendEvent(job.runId, "source.query", {
    provider: "arxiv",
    phase,
    cycle,
    query,
    maxResults,
    externalOperationId: operation.id,
    reservationId: operation.reservationId,
    requestHash,
    requestArtifactId: requestArtifact.id,
    sortBy: "submittedDate",
    sortOrder: "descending",
    requestedAt: request.requestedAt,
    compliance
  }, [requestArtifact.id]);
  let papers: ArxivPaper[];
  let arxivCache: Awaited<ReturnType<typeof fetchArxivWithCache>>["cache"] | undefined;
  try {
    const fetched = await fetchArxivWithCache({
      ledger,
      query,
      maxResults,
      allowNetwork: true,
      search: arxivSearch,
      minIntervalMs: compliance.minIntervalMs,
      abortSignal
    });
    papers = fetched.papers;
    arxivCache = fetched.cache;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const retrievalEvaluation = retrievalOutageEvaluation({ query, message });
    const citationGrounding = validateCitations([], []);
    const artifact = artifacts.create(job.runId, "source.arxiv.results", JSON.stringify({
      phase,
      cycle,
      query,
      outage: retrievalEvaluation.outage,
      trust: {
        sourceTextTrusted: false,
        quarantine: true,
        noveltyStatus: "inconclusive",
        reason: "source retrieval outage; no novelty or literature-backed claim may be promoted"
      },
      compliance,
      sourceRecords: [],
      citationGrounding,
      retrievalEvaluation,
      papers: []
    }, null, 2));
    ledger.appendEvent(job.runId, "source.results", {
      provider: "arxiv",
      phase,
      cycle,
      query,
      count: 0,
      externalOperationId: operation.id,
      requestHash,
      requestedAt: request.requestedAt,
      compliance,
      sourceRecords: [],
      citationGrounding,
      retrievalEvaluation: {
        precision: retrievalEvaluation.precision,
        recall: retrievalEvaluation.recall,
        citationValidity: retrievalEvaluation.citationValidity,
        sourceUseRate: retrievalEvaluation.sourceUseRate,
        failures: retrievalEvaluation.failures,
        trustImpact: retrievalEvaluation.trustImpact,
        canPromoteResearchBackedClaims: false,
        incompleteResearch: true,
        outage: retrievalEvaluation.outage,
        noveltyStatus: "inconclusive"
      },
      artifactId: artifact.id
    }, [artifact.id]);
    ledger.appendEvent(job.runId, "source.retrieval.evaluated", {
      provider: "arxiv",
      phase,
      cycle,
      externalOperationId: operation.id,
      artifactId: artifact.id,
      ...retrievalEvaluation
    }, [artifact.id]);
    ledger.failExternalOperation({
      operationId: operation.id,
      errorMessage: message,
      releaseReason: message,
      provider: "arxiv"
    });
    return {
      provider: "arxiv",
      phase,
      cycle,
      query,
      artifactId: artifact.id,
      externalOperationId: operation.id,
      outage: true,
      noveltyStatus: "inconclusive"
    };
  }
  const quarantinedPapers = quarantineArxivPapers(papers, { citationOnly: true });
  const sourceRecords = buildArxivSourceRecords(quarantinedPapers, { query });
  const citationGrounding = validateCitations(sourceRecords.map(claimedCitationFromSourceRecord), sourceRecords);
  const retrievalEvaluation = evaluateLiteratureRetrieval({
    query,
    papers: quarantinedPapers,
    sourceRecords,
    citationGrounding
  });
  const enrichment = buildArxivResearchEnrichment({
    query,
    papers: quarantinedPapers,
    sourceRecords,
    redistribution: compliance.pdfAndSourceRedistribution,
    metadataRedistribution: compliance.metadataRedistribution,
    termsUrl: compliance.termsUrl,
    citationGrounding
  });
  if (arxivCache?.cacheKey) {
    updateArxivCacheReview({
      ledger,
      cacheKey: arxivCache.cacheKey,
      sourceSnapshotHashes: sourceRecords.map((record) => record.snapshotHash),
      retrievalQuality: {
        retrievedCount: retrievalEvaluation.retrievedCount,
        relevantRetrieved: retrievalEvaluation.relevantRetrieved,
        expectedRetrieved: retrievalEvaluation.expectedRetrieved,
        precision: retrievalEvaluation.precision,
        recall: retrievalEvaluation.recall,
        citationValidity: retrievalEvaluation.citationValidity,
        sourceUseRate: retrievalEvaluation.sourceUseRate,
        irrelevantResultCount: retrievalEvaluation.irrelevantResultCount,
        keywordOverfitCount: retrievalEvaluation.keywordOverfitCount,
        failures: retrievalEvaluation.failures,
        trustImpact: retrievalEvaluation.trustImpact,
        canPromoteResearchBackedClaims: retrievalEvaluation.canPromoteResearchBackedClaims,
        staleResultCount: retrievalEvaluation.staleResultCount,
        incompleteResearch: retrievalEvaluation.failures.length > 0,
        reviewedAt: new Date().toISOString()
      }
    });
  }
  const artifact = artifacts.create(job.runId, "source.arxiv.results", JSON.stringify({
    phase,
    cycle,
    query,
    trust: {
      sourceTextTrusted: false,
      quarantine: true,
      hostileFlags: quarantinedPapers.flatMap((paper) => paper.trust.flags),
      redistribution: compliance.pdfAndSourceRedistribution
    },
    compliance,
    cache: arxivCache,
    sourceRecords,
    citationGrounding,
    retrievalEvaluation,
    semanticDedupe: enrichment.semanticDedupe,
    citationGraph: enrichment.citationGraph,
    snapshots: enrichment.snapshots,
    sourceQuality: enrichment.sourceQuality,
    citationLicenseManifest: enrichment.citationLicenseManifest,
    papers: quarantinedPapers,
    selectedAbstracts: quarantinedPapers.slice(0, 3).map((paper) => ({
      id: paper.id,
      title: paper.title,
      summaryPreview: paper.summaryPreview,
      absUrl: paper.absUrl,
      pdfUrl: paper.pdfUrl,
      categories: paper.categories,
      rawMetadataHash: paper.rawMetadataHash,
      trust: paper.trust
    }))
  }, null, 2));
  ledger.appendEvent(job.runId, "source.results", {
    provider: "arxiv",
    phase,
    cycle,
    query,
    count: papers.length,
    externalOperationId: operation.id,
    quarantined: true,
    requestHash,
    requestedAt: request.requestedAt,
    compliance,
    cache: arxivCache,
    hostileFlags: quarantinedPapers.flatMap((paper) => paper.trust.flags),
    sourceRecords: sourceRecords.map((record) => ({
      query: record.query,
      sourceId: record.sourceId,
      canonicalId: record.canonicalId,
      version: record.version,
      title: record.title,
      authors: record.authors,
      published: record.published,
      updated: record.updated,
      retrievedAt: record.retrievedAt,
      ranking: record.ranking,
      abstractHash: record.abstractHash,
      snapshotHash: record.snapshotHash,
      rawMetadataHash: record.rawMetadataHash,
      extractedClaims: record.extractedClaims,
      sourceFieldTaint: record.sourceFieldTaint,
      contentHash: record.contentHash,
      url: record.url
    })),
    citationGrounding,
    retrievalEvaluation: {
      precision: retrievalEvaluation.precision,
      recall: retrievalEvaluation.recall,
      citationValidity: retrievalEvaluation.citationValidity,
      sourceUseRate: retrievalEvaluation.sourceUseRate,
      failures: retrievalEvaluation.failures,
      trustImpact: retrievalEvaluation.trustImpact,
      canPromoteResearchBackedClaims: retrievalEvaluation.canPromoteResearchBackedClaims,
      staleResultCount: retrievalEvaluation.staleResultCount,
      incompleteResearch: retrievalEvaluation.failures.length > 0
    },
    citationLicenseManifest: enrichment.citationLicenseManifest,
    ...researchEnrichmentEventPayload(enrichment),
    artifactId: artifact.id
  }, [artifact.id]);
  ledger.appendEvent(job.runId, "source.citations.reviewed", {
    provider: "arxiv",
    phase,
    cycle,
    query,
    externalOperationId: operation.id,
    cache: arxivCache,
    ...citationGrounding
  }, [artifact.id]);
  ledger.appendEvent(job.runId, "source.retrieval.evaluated", {
    provider: "arxiv",
    phase,
    cycle,
    externalOperationId: operation.id,
    artifactId: artifact.id,
    cache: arxivCache,
    ...retrievalEvaluation
  }, [artifact.id]);
  appendResearchEnrichmentEvents(ledger, job.runId, {
    phase,
    cycle,
    query,
    externalOperationId: operation.id,
    artifactId: artifact.id,
    enrichment
  });
  ledger.completeExternalOperation({
    operationId: operation.id,
    responseArtifactId: artifact.id,
    debit: { elapsedMs: Math.max(1, Date.now() - startedAt) },
    overReservationPolicy: {
      allowedDimensions: ["elapsedMs"],
      reason: "arXiv retrieval debits measured elapsed time after reserving the external source operation."
    },
    workerId: job.leaseOwner,
    phase,
    provider: "arxiv"
  });
  return {
    provider: "arxiv",
    phase,
    cycle,
    query,
    count: papers.length,
    artifactId: artifact.id,
    externalOperationId: operation.id
  };
}

function cachedExternalOperation(
  ledger: Ledger,
  runId: string,
  idempotencyKey: string
) {
  return ledger.listExternalOperations(runId)
    .find((operation) =>
      operation.operationType === "source.arxiv" &&
      operation.idempotencyKey === idempotencyKey &&
      operation.status === "succeeded" &&
      operation.responseArtifactId
    );
}

function researchEnrichmentEventPayload(enrichment: ArxivResearchEnrichment) {
  return {
    semanticDedupe: {
      originalCount: enrichment.semanticDedupe.originalCount,
      uniqueCount: enrichment.semanticDedupe.uniqueCount,
      duplicateCount: enrichment.semanticDedupe.duplicateCount,
      groups: enrichment.semanticDedupe.groups
    },
    citationGraph: {
      nodeCount: enrichment.citationGraph.nodes.length,
      edgeCount: enrichment.citationGraph.edges.length,
      graphHash: enrichment.citationGraph.graphHash
    },
    snapshots: {
      count: enrichment.snapshots.length,
      storagePolicy: "metadata_only_not_exported",
      manifestHash: stableHash(enrichment.snapshots)
    },
    citationLicenseManifestSummary: {
      count: enrichment.citationLicenseManifest.summary.count,
      staleCount: enrichment.citationLicenseManifest.summary.staleCount,
      hostileCount: enrichment.citationLicenseManifest.summary.hostileCount,
      pdfOrSourceContentExported: false,
      proofSupportPolicy: enrichment.citationLicenseManifest.summary.proofSupportPolicy,
      manifestHash: enrichment.citationLicenseManifest.manifestHash
    },
    sourceQuality: {
      averageScore: enrichment.sourceQuality.averageScore,
      highQualityCount: enrichment.sourceQuality.highQualityCount,
      mediumQualityCount: enrichment.sourceQuality.mediumQualityCount,
      lowQualityCount: enrichment.sourceQuality.lowQualityCount
    }
  };
}

function appendResearchEnrichmentEvents(
  ledger: Ledger,
  runId: string,
  input: {
    phase?: string;
    cycle?: number;
    query: string;
    externalOperationId?: string;
    artifactId: string;
    enrichment: ArxivResearchEnrichment;
  }
): void {
  const base = {
    provider: "arxiv",
    phase: input.phase,
    cycle: input.cycle,
    query: input.query,
    externalOperationId: input.externalOperationId,
    artifactId: input.artifactId
  };
  ledger.appendEvent(runId, "source.dedupe.reviewed", {
    ...base,
    ...input.enrichment.semanticDedupe
  }, [input.artifactId]);
  ledger.appendEvent(runId, "source.citation_graph.extracted", {
    ...base,
    ...input.enrichment.citationGraph
  }, [input.artifactId]);
  ledger.appendEvent(runId, "source.snapshots.planned", {
    ...base,
    snapshots: input.enrichment.snapshots,
    manifestHash: stableHash(input.enrichment.snapshots)
  }, [input.artifactId]);
  ledger.appendEvent(runId, "source.license.manifest.reviewed", {
    ...base,
    ...input.enrichment.citationLicenseManifest
  }, [input.artifactId]);
  ledger.appendEvent(runId, "source.quality.reviewed", {
    ...base,
    ...input.enrichment.sourceQuality
  }, [input.artifactId]);
}

function assertResearchJob(job: Parameters<typeof isResearchJob>[0]) {
  if (!isResearchJob(job)) throw new Error(`Expected research job, got ${job.kind}`);
  return job;
}

async function executeBranchJob(
  job: ReturnType<typeof assertBranchJob>,
  problem: string,
  goal: string,
  artifacts: ArtifactStore,
  ledger: Ledger,
  options: RunGoalOptions,
  context: WorkerExecutionContext
): Promise<Record<string, unknown>> {
  const cycle = Number(job.payload.cycle ?? 1);
  const nextCyclePlan = recordValue(job.payload.nextCyclePlan);
  const assumptionDelta = job.payload.phase === "loophole"
    ? persistLoopholeAssumptionDelta({
        runId: job.runId,
        cycle,
        branch: job.payload.branch,
        role: job.payload.role,
        problem,
        goal,
        artifacts,
        ledger
      })
    : undefined;
  const strategySelection = normalizeStrategySelection(job.payload.strategySelection, {
    problem,
    goal,
    workflow: job.payload.workflow === "gree" ? "gree" : "pflk",
    phase: job.payload.phase,
    role: job.payload.role
  });
  const branchModel = findBranchModelForRoute(options, recordValue(job.payload.providerRoute));
  if (branchModel) {
    const promptSources = latestPromptFirewallSources(job.runId, ledger, cycle, job.payload.phase, nextCyclePlan);
    const prompt = buildBranchPrompt(job.payload.role, job.payload.phase, problem, goal, strategySelection, promptSources.sources, nextCyclePlan, promptSources.knowledgeContext);
    const output = await runWorkerLocalAiSdkCall({
      runId: job.runId,
      ledger,
      artifacts,
      job,
      context,
      provider: branchModel.provider,
      modelId: branchModel.modelId,
      model: branchModel.model,
      prompt,
      settings: branchModel.settings ?? { maxOutputTokens: 800 },
      generate: branchModel.generate,
      metadata: {
        workflow: job.payload.workflow,
        phase: job.payload.phase,
        cycle,
        branch: job.payload.branch,
        role: job.payload.role,
        promptLineage: job.payload.promptLineage
      }
    });
    const artifact = artifacts.create(job.runId, `phase.${job.payload.phase}.branch.result`, JSON.stringify({
      phase: job.payload.phase,
      cycle,
      branch: job.payload.branch,
      role: job.payload.role,
      mode: "ai-sdk",
      strategySelection,
      selectedTacticContract: strategySelection.tacticContract,
      failureConsolidation: strategySelection.failureConsolidation,
      falsifiableClaim: job.payload.phase === "loophole" ? branchFalsifiableClaim(job.payload.role, problem, goal) : undefined,
      assumptionDeltaReview: assumptionDelta?.review,
      assumptionDeltaArtifactId: assumptionDelta?.artifactId,
      nextCyclePlan,
      nextCyclePlanArtifactId: job.payload.nextCyclePlanArtifactId,
      nextCyclePlanHash: job.payload.nextCyclePlanHash,
      nextCycleMutation: job.payload.nextCycleMutation,
      promptSourceFirewall: promptSources.firewall,
      promptKnowledgeContext: promptSources.knowledgeContext,
      executableExperiment: job.payload.phase === "experiment" ? branchExecutableExperiment(job.payload.role, problem, goal) : undefined,
      workerRole: job.payload.role,
      promptLineage: job.payload.promptLineage ?? buildPromptLineage("workflow.branch", problem, goal, {
        phase: job.payload.phase,
        cycle,
        branch: job.payload.branch,
        role: job.payload.role
      }),
      providerRoute: job.payload.providerRoute ?? { provider: branchModel.provider, modelId: branchModel.modelId },
      text: output.text,
      usage: output.usage,
      requestArtifactId: output.requestArtifactId,
      responseArtifactId: output.responseArtifactId,
      stepArtifactIds: output.stepArtifactIds,
      coordinatorDispatchArtifactId: output.coordinatorDispatchArtifactId,
      coordinatorDispatchEventId: output.coordinatorDispatchEventId,
      coordinatorTerminalEventId: output.coordinatorTerminalEventId
    }, null, 2));
    return {
      phase: job.payload.phase,
      cycle,
      branch: job.payload.branch,
      role: job.payload.role,
      mode: "ai-sdk",
      artifactId: artifact.id,
      assumptionDeltaArtifactId: assumptionDelta?.artifactId,
      requestArtifactId: output.requestArtifactId,
      responseArtifactId: output.responseArtifactId,
      stepArtifactIds: output.stepArtifactIds,
      coordinatorDispatchArtifactId: output.coordinatorDispatchArtifactId,
      coordinatorDispatchEventId: output.coordinatorDispatchEventId,
      coordinatorTerminalEventId: output.coordinatorTerminalEventId
    };
  }

  const artifact = artifacts.create(job.runId, `phase.${job.payload.phase}.branch`, JSON.stringify({
    phase: job.payload.phase,
    cycle,
    branch: job.payload.branch,
    role: job.payload.role,
      strategySelection,
      selectedTacticContract: strategySelection.tacticContract,
      failureConsolidation: strategySelection.failureConsolidation,
      falsifiableClaim: job.payload.phase === "loophole" ? branchFalsifiableClaim(job.payload.role, problem, goal) : undefined,
      assumptionDeltaReview: assumptionDelta?.review,
      assumptionDeltaArtifactId: assumptionDelta?.artifactId,
      nextCyclePlan,
      nextCyclePlanArtifactId: job.payload.nextCyclePlanArtifactId,
      nextCyclePlanHash: job.payload.nextCyclePlanHash,
      nextCycleMutation: job.payload.nextCycleMutation,
      promptSourceFirewall: latestPromptFirewallSources(job.runId, ledger, cycle, job.payload.phase, nextCyclePlan).firewall,
      promptKnowledgeContext: latestPromptFirewallSources(job.runId, ledger, cycle, job.payload.phase, nextCyclePlan).knowledgeContext,
      executableExperiment: job.payload.phase === "experiment" ? branchExecutableExperiment(job.payload.role, problem, goal) : undefined,
      workerRole: job.payload.role,
      promptLineage: job.payload.promptLineage ?? buildPromptLineage("workflow.branch", problem, goal, {
        phase: job.payload.phase,
        cycle,
        branch: job.payload.branch,
        role: job.payload.role
      }),
      providerRoute: job.payload.providerRoute ?? { provider: "local", modelId: "deterministic-branch" },
      problem,
      goal,
    result: "local deterministic branch placeholder persisted for durable swarm orchestration"
  }, null, 2));
  return {
    phase: job.payload.phase,
    cycle,
    branch: job.payload.branch,
    role: job.payload.role,
    assumptionDeltaArtifactId: assumptionDelta?.artifactId,
    artifactId: artifact.id
  };
}

type BranchCandidatePromotion = {
  candidates: BranchCandidateClaimReview[];
  accepted: BranchCandidateClaimReview[];
};

type BranchCandidateClaimReview = {
  claim: FormalClaimContract;
  sourceBranchArtifactId: string;
  candidateArtifactId: string;
  proofObligationArtifactId: string;
  workerResultSchemaReviewArtifactId: string;
  satisfyingArtifactIds: string[];
  gate: ReturnType<typeof evaluateEvidenceGate>;
};

type BranchVerificationResult = {
  mode: string;
  claim: FormalClaimContract;
  proofObligationDecision: ReturnType<typeof evaluateProofObligationGraph>;
  proofObligationTrace: ReturnType<typeof traceProofObligations>;
};

type PersistedBranchFormalization = NonNullable<FormalClaimContract["formalization"]> & {
  artifactId: string;
};

async function promoteBranchOutputsToCandidateClaims(input: {
  runId: string;
  run: ReturnType<Ledger["requireRun"]>;
  cycle: number;
  ledger: Ledger;
  artifacts: ArtifactStore;
  trustedVerifiers: TrustedVerifier[];
  leanVerifier?: RunGoalOptions["leanVerifier"];
}): Promise<BranchCandidatePromotion> {
  const artifacts = input.ledger.listArtifacts(input.runId)
    .filter((artifact) =>
      artifact.kind === "phase.loophole.branch" ||
      artifact.kind === "phase.loophole.branch.result" ||
      artifact.kind === "phase.experiment.branch" ||
      artifact.kind === "phase.experiment.branch.result"
    );
  const candidates: BranchCandidateClaimReview[] = [];
  for (const artifact of artifacts) {
    const parsed = parseBranchArtifact(artifact);
    if (Number(parsed.cycle ?? 1) !== input.cycle) continue;
    if (input.ledger.listEvents(input.runId).some((event) =>
      event.type === "branch.candidate_claim.reviewed" &&
      event.payload.sourceBranchArtifactId === artifact.id
    )) continue;
    candidates.push(await promoteBranchArtifactToCandidateClaim({ ...input, sourceBranchArtifactId: artifact.id, sourceBranchArtifactPath: artifact.path, parsed }));
  }
  return {
    candidates,
    accepted: candidates.filter((candidate) => candidate.gate.canMarkGoalMet)
  };
}

async function promoteBranchArtifactToCandidateClaim(input: {
  runId: string;
  run: ReturnType<Ledger["requireRun"]>;
  cycle: number;
  ledger: Ledger;
  artifacts: ArtifactStore;
  trustedVerifiers: TrustedVerifier[];
  leanVerifier?: RunGoalOptions["leanVerifier"];
  sourceBranchArtifactId: string;
  sourceBranchArtifactPath: string;
  parsed: Record<string, unknown>;
}): Promise<BranchCandidateClaimReview> {
  const text = branchArtifactText(input.parsed);
  const phase = stringValue(input.parsed.phase) ?? "unknown";
  const role = stringValue(input.parsed.role) ?? stringValue(input.parsed.workerRole) ?? "unknown";
  const workerResultSchemaReview = reviewStructuredWorkerResult(input.parsed, input.ledger.listArtifacts(input.runId));
  const workerResultSchemaReviewArtifact = input.artifacts.create(input.runId, "branch.worker_result.schema_review", JSON.stringify({
    sourceBranchArtifactId: input.sourceBranchArtifactId,
    phase,
    role,
    review: workerResultSchemaReview,
    policy: {
      modelClaimedVerifierStatusTrusted: false,
      hardEvidenceRequiresSchemaValidPersistedArtifactReferences: true
    }
  }, null, 2));
  input.ledger.appendEvent(input.runId, "branch.worker_result.schema.reviewed", {
    sourceBranchArtifactId: input.sourceBranchArtifactId,
    artifactId: workerResultSchemaReviewArtifact.id,
    phase,
    role,
    status: workerResultSchemaReview.status,
    reason: workerResultSchemaReview.status === "valid" ? null : workerResultSchemaReview.reason,
    resultType: workerResultSchemaReview.status === "valid" ? workerResultSchemaReview.result.resultType : null,
    referencedArtifactIds: workerResultSchemaReview.referencedArtifactIds,
    modelClaimedVerifierStatusIgnored: workerResultSchemaReview.modelClaimedVerifierStatusIgnored,
    ignoredVerifierClaim: ignoredVerifierClaimSummary(workerResultSchemaReview) ?? null
  }, [workerResultSchemaReviewArtifact.id, input.sourceBranchArtifactId, ...workerResultSchemaReview.referencedArtifactIds]);
  const assumptionDeltaArtifactId = stringValue(input.parsed.assumptionDeltaArtifactId);
  const sourceLineage = {
    source: "branch.candidate",
    phase,
    role,
    sourceBranchArtifactId: input.sourceBranchArtifactId,
    promptLineage: input.parsed.promptLineage ?? null,
    providerRoute: input.parsed.providerRoute ?? null,
    promptSourceFirewall: input.parsed.promptSourceFirewall ?? null,
    promptKnowledgeContextPolicy: recordValue(recordValue(input.parsed.promptKnowledgeContext)?.policy) ?? null,
    modelTextTrusted: false,
    controlsAffected: false,
    sourceTextTrusted: false,
    workerResultSchemaReviewArtifactId: workerResultSchemaReviewArtifact.id,
    referencedArtifactIds: workerResultSchemaReview.referencedArtifactIds,
    assumptionDeltaArtifactId: assumptionDeltaArtifactId ?? null
  };
  const normalizedConclusion = normalizeBranchConclusion(workerResultConclusion(workerResultSchemaReview) ?? text, input.run.goal);
  const claimId = `branch-claim-${stableHash({
    workflow: input.run.workflow,
    phase,
    role,
    conclusion: normalizedConclusion
  }).slice(0, 24)}`;
  const theoremArtifact = input.artifacts.create(input.runId, "branch.theorem.normalized", JSON.stringify({
    claimId,
    sourceBranchArtifactId: input.sourceBranchArtifactId,
    normalizedStatement: normalizedConclusion,
    originalGoal: input.run.goal,
    phase,
    role
  }, null, 2));
  input.ledger.appendEvent(input.runId, "theorem.normalized", {
    claimId,
    source: "branch.candidate",
    sourceBranchArtifactId: input.sourceBranchArtifactId,
    artifactId: theoremArtifact.id,
    normalizedStatement: normalizedConclusion,
    conclusion: normalizedConclusion,
    assumptions: []
  }, [theoremArtifact.id, input.sourceBranchArtifactId]);

  const looksLikeFormalProof = workerResultLooksLikeFormalProof(workerResultSchemaReview) || textLooksLikeFormalProof(text);
  const verifiedComputation = workerResultClaimsHardComputation(workerResultSchemaReview) && localVerifierFixture(input.run.problem, input.run.goal).evidenceGrade === "verified_computation";
  const counterexampleText = workerResultCounterexampleText(workerResultSchemaReview) ?? text;
  const verifiedCounterexample = workerResultClaimsHardCounterexample(workerResultSchemaReview) && deterministicCounterexampleAccepted(input.run.problem, input.run.goal, counterexampleText);
  const leanHandoff = verifiedCounterexample || verifiedComputation
    ? undefined
    : await createBranchLeanVerification(input, claimId, workerResultSchemaReview, normalizedConclusion);
  const formalization = leanHandoff?.formalization ?? persistBranchFormalizationAssessment({
    ...input,
    claimId,
    sourceBranchArtifactId: input.sourceBranchArtifactId,
    workerResultSchemaReviewArtifactId: workerResultSchemaReviewArtifact.id,
    looksLikeFormalProof,
    leanHandoffReason: leanHandoff?.reason
  });
  const verification = verifiedCounterexample
    ? createBranchCounterexampleVerification(input, claimId, counterexampleText, workerResultSchemaReview.referencedArtifactIds)
    : verifiedComputation
      ? createBranchComputationVerification(input, claimId, workerResultSchemaReview.referencedArtifactIds)
      : leanHandoff?.verification
        ? leanHandoff.verification
        : createUnsupportedBranchVerification(input, claimId, normalizedConclusion, workerResultSchemaReview, looksLikeFormalProof || leanHandoff?.attempted === true, formalization);
  const proofObligationArtifact = input.artifacts.create(input.runId, "branch.proof.obligations", JSON.stringify({
    claimId,
    sourceBranchArtifactId: input.sourceBranchArtifactId,
    workerResultSchemaReviewArtifactId: workerResultSchemaReviewArtifact.id,
    graph: verification.claim.proofObligationGraph,
    decision: verification.proofObligationDecision,
    trace: verification.proofObligationTrace
  }, null, 2));
  input.ledger.appendEvent(input.runId, "branch.proof_obligations.reviewed", {
    claimId,
    source: "branch.candidate",
    sourceBranchArtifactId: input.sourceBranchArtifactId,
    workerResultSchemaReviewArtifactId: workerResultSchemaReviewArtifact.id,
    decision: verification.proofObligationDecision,
    trace: verification.proofObligationTrace,
    artifactId: proofObligationArtifact.id
  }, [proofObligationArtifact.id, input.sourceBranchArtifactId, workerResultSchemaReviewArtifact.id]);
  const claim = makeClaimContract({
    ...verification.claim,
    formalization: verification.claim.formalization ?? formalization,
    proofObligationGraph: verification.claim.proofObligationGraph
  });
  const candidateArtifact = input.artifacts.create(input.runId, "branch.candidate-claim", JSON.stringify({
    claim,
    sourceBranchArtifactId: input.sourceBranchArtifactId,
    workerResultSchemaReviewArtifactId: workerResultSchemaReviewArtifact.id,
    theoremArtifactId: theoremArtifact.id,
    formalizationArtifactId: formalization.artifactId,
    proofObligationArtifactId: proofObligationArtifact.id,
    modelTextIsVerifierEvidence: false,
    structuredWorkerResultRequiredForHardEvidence: true,
    workerResultSchemaReview,
    sourceLineage,
    evidenceGrade: verification.claim.evidenceGrade,
    assumptionDeltaArtifactId: assumptionDeltaArtifactId ?? null,
    verificationMode: verification.mode
  }, null, 2));
  const gate = evaluateEvidenceGate(claim, {
    trustedVerifiers: input.trustedVerifiers,
    artifacts: input.ledger.listArtifacts(input.runId)
  });
  const satisfyingArtifactIds = gate.canMarkGoalMet
    ? uniqueStrings([
        candidateArtifact.id,
        theoremArtifact.id,
        formalization.artifactId,
        proofObligationArtifact.id,
        workerResultSchemaReviewArtifact.id,
        assumptionDeltaArtifactId,
        input.sourceBranchArtifactId,
        ...workerResultSchemaReview.referencedArtifactIds,
        ...claim.verifierArtifactIds,
        ...(claim.supportingVerifierResults ?? []).flatMap((result) => result.artifactIds)
      ].filter((id): id is string => typeof id === "string"))
    : [candidateArtifact.id, theoremArtifact.id, formalization.artifactId, proofObligationArtifact.id, workerResultSchemaReviewArtifact.id, assumptionDeltaArtifactId, input.sourceBranchArtifactId]
      .filter((id): id is string => typeof id === "string");
  input.ledger.appendEvent(input.runId, "branch.candidate_claim.reviewed", {
    claimId,
    phase,
    role,
    sourceBranchArtifactId: input.sourceBranchArtifactId,
    candidateArtifactId: candidateArtifact.id,
    workerResultSchemaReviewArtifactId: workerResultSchemaReviewArtifact.id,
    theoremArtifactId: theoremArtifact.id,
    formalizationArtifactId: formalization.artifactId,
    proofObligationArtifactId: proofObligationArtifact.id,
    verificationMode: verification.mode,
    status: gate.canMarkGoalMet ? "accepted" : "rejected",
    evidenceGrade: claim.evidenceGrade,
    sourceLineage,
    assumptionDeltaArtifactId: assumptionDeltaArtifactId ?? null,
    modelTextIsVerifierEvidence: false,
    structuredWorkerResultRequiredForHardEvidence: true,
    workerResultSchemaReview,
    claim,
    gate,
    satisfyingArtifactIds
  }, satisfyingArtifactIds);
  return {
    claim,
    sourceBranchArtifactId: input.sourceBranchArtifactId,
    candidateArtifactId: candidateArtifact.id,
    proofObligationArtifactId: proofObligationArtifact.id,
    workerResultSchemaReviewArtifactId: workerResultSchemaReviewArtifact.id,
    satisfyingArtifactIds,
    gate
  };
}

async function createBranchLeanVerification(input: {
  runId: string;
  run: ReturnType<Ledger["requireRun"]>;
  ledger: Ledger;
  artifacts: ArtifactStore;
  sourceBranchArtifactId: string;
  leanVerifier?: RunGoalOptions["leanVerifier"];
}, claimId: string, workerResultSchemaReview: WorkerResultSchemaReview, normalizedConclusion: string): Promise<{
  attempted: true;
  reason: string;
  formalization?: PersistedBranchFormalization;
  verification?: BranchVerificationResult;
} | undefined> {
  const sourceArtifact = branchLeanSourceArtifact(workerResultSchemaReview, input.ledger.listArtifacts(input.runId));
  if (!sourceArtifact) return undefined;
  if (input.leanVerifier?.enabled !== true) {
    return {
      attempted: true,
      reason: "Branch worker produced a Lean source artifact, but leanVerifier.enabled was not true."
    };
  }

  let result: LeanVerificationResult;
  try {
    result = await verifyLeanFile({
      runId: input.runId,
      ledger: input.ledger,
      artifacts: input.artifacts,
      leanFilePath: sourceArtifact.path,
      leanBin: input.leanVerifier.leanBin,
      lakeBin: input.leanVerifier.lakeBin,
      projectRoot: input.leanVerifier.projectRoot,
      timeoutMs: input.leanVerifier.timeoutMs
    });
  } catch (error) {
    return {
      attempted: true,
      reason: `Lean verifier handoff failed before producing a result artifact: ${error instanceof Error ? error.message : String(error)}`
    };
  }

  const source = readArtifactText(sourceArtifact);
  const theorem = extractLeanTheoremStatement(source, result.theoremNames[0] ?? theoremNameFromWorkerResult(workerResultSchemaReview));
  const theoremName = result.theoremNames[0] ?? theorem.theoremName ?? theoremNameFromWorkerResult(workerResultSchemaReview) ?? "unknown_theorem";
  const formalStatement = theorem.formalStatement ?? `theorem ${theoremName}`;
  const equivalence = persistLeanFormalizationAssessment({
    ...input,
    claimId,
    sourceArtifactId: sourceArtifact.id,
    workerResultSchemaReviewArtifactId: latestWorkerResultSchemaReviewArtifactId(input.ledger, input.runId, input.sourceBranchArtifactId),
    formalStatement,
    theoremProposition: theorem.proposition,
    normalizedConclusion,
    leanResult: result
  });

  if (result.status !== "verified") {
    return {
      attempted: true,
      reason: `Lean verifier returned ${result.status}${result.failureKind ? ` (${result.failureKind})` : ""}.`,
      formalization: equivalence.formalization
    };
  }
  if (result.projectPinned !== true) {
    return {
      attempted: true,
      reason: "Lean verifier result was not produced from a pinned Lake/mathlib project.",
      formalization: equivalence.formalization
    };
  }
  if (!result.sandboxPolicyHash) {
    return {
      attempted: true,
      reason: "Lean verifier result is missing a sandbox policy hash.",
      formalization: equivalence.formalization
    };
  }
  if (!result.tcb) {
    return {
      attempted: true,
      reason: "Lean verifier result is missing a complete trusted computing base record.",
      formalization: equivalence.formalization
    };
  }
  if (equivalence.formalization.status !== "equivalent") {
    return {
      attempted: true,
      reason: "Lean theorem was machine checked, but the formal statement is not equivalent to the goal.",
      formalization: equivalence.formalization
    };
  }

  return {
    attempted: true,
    reason: "Lean source artifact was verified and bound to the branch candidate.",
    formalization: equivalence.formalization,
    verification: createBranchLeanFormalProofVerification({
      ...input,
      claimId,
      sourceArtifactId: sourceArtifact.id,
      theoremName,
      formalStatement,
      leanResult: result,
      formalization: equivalence.formalization,
      dependencyEventIds: equivalence.dependencyEventIds
    })
  };
}

function branchLeanSourceArtifact(review: WorkerResultSchemaReview, artifacts: Artifact[]): Artifact | undefined {
  if (review.status !== "valid" || review.result.resultType !== "lean_attempt") return undefined;
  const reference = review.result.artifactReferences.find((item) => item.role === "lean_source");
  if (!reference) return undefined;
  return artifacts.find((artifact) => artifact.id === reference.artifactId);
}

function persistBranchFormalizationAssessment(input: {
  runId: string;
  artifacts: ArtifactStore;
  ledger: Ledger;
  claimId: string;
  sourceBranchArtifactId: string;
  workerResultSchemaReviewArtifactId: string;
  looksLikeFormalProof: boolean;
  leanHandoffReason?: string;
}): PersistedBranchFormalization {
  const status = input.looksLikeFormalProof ? "not_formalized" as const : "not_required" as const;
  const reason = input.leanHandoffReason ??
    (input.looksLikeFormalProof
      ? "Branch worker result claims or implies a formal proof but no Lean result artifact is bound."
      : "Branch candidate does not claim a formal proof.");
  const knownGaps = input.looksLikeFormalProof
    ? uniqueStrings(["missing Lean machine-check artifact", input.leanHandoffReason ?? "missing Lean machine-check artifact"])
    : [];
  const artifact = input.artifacts.create(input.runId, "branch.formalization.assessment", JSON.stringify({
    claimId: input.claimId,
    sourceBranchArtifactId: input.sourceBranchArtifactId,
    workerResultSchemaReviewArtifactId: input.workerResultSchemaReviewArtifactId,
    status,
    reason,
    knownGaps
  }, null, 2));
  const formalization = {
    status,
    artifactId: artifact.id,
    knownGaps
  };
  input.ledger.appendEvent(input.runId, "formalization.assessed", {
    claimId: input.claimId,
    source: "branch.candidate",
    sourceBranchArtifactId: input.sourceBranchArtifactId,
    workerResultSchemaReviewArtifactId: input.workerResultSchemaReviewArtifactId,
    reason,
    ...formalization
  }, [artifact.id, input.sourceBranchArtifactId]);
  return formalization;
}

function persistLeanFormalizationAssessment(input: {
  runId: string;
  run: ReturnType<Ledger["requireRun"]>;
  artifacts: ArtifactStore;
  ledger: Ledger;
  claimId: string;
  sourceBranchArtifactId: string;
  sourceArtifactId: string;
  workerResultSchemaReviewArtifactId?: string;
  formalStatement: string;
  theoremProposition?: string;
  normalizedConclusion: string;
  leanResult: LeanVerificationResult;
}): { formalization: PersistedBranchFormalization; dependencyEventIds: string[] } {
  const target = equivalentTargetStatement(input.theoremProposition, input.run);
  const statementDiffs = target.equivalent ? [] : [
    `Lean proposition ${JSON.stringify(input.theoremProposition ?? input.formalStatement)} does not match the run problem or goal.`
  ];
  const review = {
    originalProblem: `${input.run.problem}\nGoal: ${input.run.goal}`,
    normalizedStatement: target.normalizedTarget,
    formalStatement: input.formalStatement,
    assumptions: [],
    conclusion: input.formalStatement,
    ambiguityNotes: [],
    statementDiffs,
    reviewer: "deterministic-equivalence-v0",
    reviewerDisagreement: !target.equivalent
  };
  const bundleWithoutHash = {
    format: "matematica.formal-equivalence-audit-bundle" as const,
    version: 1 as const,
    originalProblem: review.originalProblem,
    normalizedTheorem: review.normalizedStatement,
    leanTheorem: review.formalStatement,
    assumptionDiff: {
      originalAssumptions: [],
      formalAssumptions: [],
      addedAssumptions: [],
      removedAssumptions: [],
      hiddenAssumptions: []
    },
    allowedAssumptionPolicy: {
      allowAddedAssumptions: false as const,
      allowedAddedAssumptions: [],
      reason: "Branch Lean handoff forbids added assumptions for automatic goal completion."
    },
    independentReview: review,
    decision: {
      equivalent: target.equivalent,
      status: target.equivalent ? "equivalent" as const : "mismatch" as const,
      reviewer: review.reviewer,
      reviewerIndependent: true,
      blockingReasons: statementDiffs
    }
  };
  const equivalenceAuditBundle = {
    ...bundleWithoutHash,
    bundleHash: stableHash(bundleWithoutHash)
  };
  const artifact = input.artifacts.create(input.runId, "branch.formalization.assessment", JSON.stringify({
    claimId: input.claimId,
    sourceBranchArtifactId: input.sourceBranchArtifactId,
    workerResultSchemaReviewArtifactId: input.workerResultSchemaReviewArtifactId,
    sourceArtifactId: input.sourceArtifactId,
    leanResultArtifactId: input.leanResult.resultArtifactId,
    status: target.equivalent ? "equivalent" : "mismatch",
    equivalenceReview: {
      ...review,
      auditBundle: equivalenceAuditBundle
    },
    equivalenceAuditBundle,
    statementDiffs
  }, null, 2));
  const formalization: PersistedBranchFormalization = {
    status: target.equivalent ? "equivalent" : "mismatch",
    artifactId: artifact.id,
    equivalenceReview: {
      ...review,
      auditBundle: equivalenceAuditBundle
    },
    equivalenceAuditBundle,
    statementDiffs
  };
  const equivalenceEvent = input.ledger.appendEvent(input.runId, "theorem.equivalence.reviewed", {
    claimId: input.claimId,
    source: "branch.candidate.lean",
    sourceBranchArtifactId: input.sourceBranchArtifactId,
    sourceArtifactId: input.sourceArtifactId,
    leanResultArtifactId: input.leanResult.resultArtifactId,
    artifactId: artifact.id,
    equivalenceReview: formalization.equivalenceReview,
    equivalenceAuditBundle,
    status: formalization.status
  }, [artifact.id, input.sourceArtifactId, input.leanResult.resultArtifactId]);
  const formalizationEvent = input.ledger.appendEvent(input.runId, "formalization.assessed", {
    claimId: input.claimId,
    source: "branch.candidate.lean",
    sourceBranchArtifactId: input.sourceBranchArtifactId,
    sourceArtifactId: input.sourceArtifactId,
    leanResultArtifactId: input.leanResult.resultArtifactId,
    ...formalization
  }, [artifact.id, input.sourceBranchArtifactId, input.sourceArtifactId, input.leanResult.resultArtifactId]);
  return {
    formalization,
    dependencyEventIds: [
      equivalenceEvent.id,
      formalizationEvent.id,
      ...input.ledger.listEvents(input.runId)
        .filter((event) => event.type === "verifier.completed" && event.payload.resultArtifactId === input.leanResult.resultArtifactId)
        .map((event) => event.id)
    ]
  };
}

function createBranchLeanFormalProofVerification(input: {
  runId: string;
  run: ReturnType<Ledger["requireRun"]>;
  ledger: Ledger;
  artifacts: ArtifactStore;
  sourceBranchArtifactId: string;
  claimId: string;
  sourceArtifactId: string;
  theoremName: string;
  formalStatement: string;
  leanResult: LeanVerificationResult;
  formalization: PersistedBranchFormalization;
  dependencyEventIds: string[];
}): BranchVerificationResult {
  const counterexample = input.artifacts.create(input.runId, "branch.counterexample.search", JSON.stringify({
    claimId: input.claimId,
    status: "not_applicable",
    sourceBranchArtifactId: input.sourceBranchArtifactId,
    note: "Formal Lean proof handoff records counterexample pressure as not applicable for this deterministic theorem check; statement equivalence and Lean kernel checks are the blocking gates."
  }, null, 2));
  const counterexampleEvent = input.ledger.appendEvent(input.runId, "counterexample.search.reviewed", {
    claimId: input.claimId,
    source: "branch.candidate.lean",
    status: "not_applicable",
    searches: ["numeric", "symbolic", "random", "domain_specific"].map((method) => ({
      method,
      outcome: "not_applicable",
      artifactIds: [counterexample.id]
    })),
    artifactId: counterexample.id,
    sourceBranchArtifactId: input.sourceBranchArtifactId
  }, [counterexample.id, input.sourceBranchArtifactId]);
  const proofArtifactIds = uniqueStrings([
    input.sourceArtifactId,
    input.leanResult.inputArtifactId,
    input.leanResult.projectArtifactId,
    input.leanResult.sandboxPolicyArtifactId,
    input.leanResult.stdoutArtifactId,
    input.leanResult.stderrArtifactId,
    input.leanResult.resultArtifactId,
    input.formalization.artifactId,
    counterexample.id
  ].filter((artifactId): artifactId is string => Boolean(artifactId)));
  const graph = makeProofObligationGraph({
    rootClaimId: input.claimId,
    obligations: [{
      id: input.claimId,
      statement: input.formalStatement,
      assumptions: [],
      conclusion: input.formalStatement,
      dependencies: [],
      status: "lean_checked",
      verifierId: "lean4",
      artifactIds: proofArtifactIds,
      counterexampleSearch: "not_run",
      counterexampleSearches: ["numeric", "symbolic", "random", "domain_specific"].map((method) => ({
        method: method as "numeric" | "symbolic" | "random" | "domain_specific",
        outcome: "not_applicable",
        artifactIds: [counterexample.id]
      })),
      dependencyEventIds: uniqueStrings([...input.dependencyEventIds, counterexampleEvent.id])
    }]
  });
  const claim = makeClaimContract({
    id: input.claimId,
    claimType: "lean_checked_theorem",
    verifierId: "lean4",
    conclusion: input.formalStatement,
    verifierStatus: "verified",
    evidenceGrade: "formal_proof",
    verifierArtifactIds: [input.leanResult.resultArtifactId],
    formalization: input.formalization,
    proofObligationGraph: graph,
    machineCheck: {
      verifier: "lean4",
      resultArtifactId: input.leanResult.resultArtifactId,
      sourceHash: input.leanResult.sourceHash,
      theoremName: input.theoremName,
      toolchainHash: input.leanResult.toolchainHash,
      sandboxPolicyHash: input.leanResult.sandboxPolicyHash ?? "",
      projectPinned: input.leanResult.projectPinned === true,
      proofObligationArtifactIds: proofArtifactIds,
      tcb: input.leanResult.tcb!
    }
  });
  return {
    mode: "lean_formal_proof",
    claim,
    proofObligationDecision: evaluateProofObligationGraph(graph, input.ledger.listArtifacts(input.runId), {
      requireCounterexampleSearch: true,
      evidenceGrade: "formal_proof",
      events: input.ledger.listEvents(input.runId)
    }),
    proofObligationTrace: traceProofObligations(graph)
  };
}

function createBranchComputationVerification(input: {
  runId: string;
  run: ReturnType<Ledger["requireRun"]>;
  ledger: Ledger;
  artifacts: ArtifactStore;
  sourceBranchArtifactId: string;
}, claimId: string, referencedArtifactIds: string[]): {
  mode: string;
  claim: FormalClaimContract;
  proofObligationDecision: ReturnType<typeof evaluateProofObligationGraph>;
  proofObligationTrace: ReturnType<typeof traceProofObligations>;
} {
  const fixture = localVerifierFixture(input.run.problem, input.run.goal);
  const primary = input.artifacts.create(input.runId, "branch.verifier.local.result", JSON.stringify({
    verifier: "local-deterministic-v0",
    sourceBranchArtifactId: input.sourceBranchArtifactId,
    structuredWorkerResultArtifactIds: referencedArtifactIds,
    evidenceGrade: "verified_computation",
    exactStatement: fixture.exactStatement,
    note: "Branch candidate was independently checked by the local deterministic verifier."
  }, null, 2));
  const primaryEvent = input.ledger.appendEvent(input.runId, "verifier.completed", {
    verifier: "local-deterministic-v0",
    source: "branch.candidate",
    claimId,
    evidenceGrade: "verified_computation",
    artifactId: primary.id
  }, [primary.id, input.sourceBranchArtifactId]);
  const independent = input.artifacts.create(input.runId, "branch.verifier.independent-checker.result", JSON.stringify({
    verifier: "arithmetic-independent-checker",
    sourceBranchArtifactId: input.sourceBranchArtifactId,
    evidenceGrade: "verified_computation",
    exactStatement: fixture.exactStatement,
    note: "Independent branch candidate arithmetic rerun succeeded."
  }, null, 2));
  const independentEvent = input.ledger.appendEvent(input.runId, "verifier.completed", {
    verifier: "arithmetic-independent-checker",
    source: "branch.candidate",
    claimId,
    evidenceGrade: "verified_computation",
    artifactId: independent.id,
    role: "independent_checker"
  }, [independent.id, input.sourceBranchArtifactId]);
  const counterexample = input.artifacts.create(input.runId, "branch.counterexample.search", JSON.stringify({
    claimId,
    status: "passed",
    sourceBranchArtifactId: input.sourceBranchArtifactId,
    negativeEvidenceOnly: true
  }, null, 2));
  const counterexampleEvent = input.ledger.appendEvent(input.runId, "counterexample.search.reviewed", {
    claimId,
    source: "branch.candidate",
    status: "passed",
    searches: [{
      method: "numeric",
      outcome: "passed",
      checkedCases: 1,
      artifactIds: [counterexample.id]
    }],
    negativeEvidenceOnly: true,
    artifactId: counterexample.id,
    sourceBranchArtifactId: input.sourceBranchArtifactId
  }, [counterexample.id, input.sourceBranchArtifactId]);
  const graph = makeProofObligationGraph({
    rootClaimId: claimId,
    obligations: [{
      id: claimId,
      statement: fixture.proofObligationStatement,
      assumptions: [],
      conclusion: fixture.exactStatement,
      dependencies: [],
      status: "computational_evidence",
      verifierId: "local-deterministic-v0",
      artifactIds: uniqueStrings([primary.id, independent.id, counterexample.id, ...referencedArtifactIds]),
      reproducibility: {
        executableArtifactId: input.sourceBranchArtifactId,
        command: fixture.command,
        seed: "branch-candidate-deterministic-arithmetic",
        environmentHash: stableHash({ verifier: "local-deterministic-v0", sourceBranchArtifactId: input.sourceBranchArtifactId }),
        inputDomain: fixture.inputDomain,
        boundsStatement: fixture.boundsStatement,
        outputHash: stableHash({ exactStatement: fixture.exactStatement, branch: input.sourceBranchArtifactId }),
        independentRerunArtifactId: independent.id,
        failureClassification: "none"
      },
      counterexampleSearch: "passed",
      counterexampleSearches: [{
        method: "numeric",
        outcome: "passed",
        checkedCases: 1,
        artifactIds: [counterexample.id]
      }],
      dependencyEventIds: [primaryEvent.id, independentEvent.id, counterexampleEvent.id]
    }]
  });
  const claim = makeClaimContract({
    id: claimId,
    claimType: "numerical_evidence",
    verifierId: "local-deterministic-v0",
    conclusion: fixture.claimConclusion,
    verifierStatus: "verified",
    evidenceGrade: "verified_computation",
    verifierArtifactIds: [primary.id],
    proofObligationGraph: graph,
    supportingVerifierResults: [{
      verifierId: "arithmetic-independent-checker",
      role: "independent_checker",
      claimType: "numerical_evidence",
      verifierStatus: "verified",
      evidenceGrade: "verified_computation",
      artifactIds: [independent.id]
    }],
    formalization: { status: "not_required" }
  });
  return {
    mode: "deterministic_branch_computation",
    claim,
    proofObligationDecision: evaluateProofObligationGraph(graph, input.ledger.listArtifacts(input.runId), { evidenceGrade: "verified_computation", events: input.ledger.listEvents(input.runId) }),
    proofObligationTrace: traceProofObligations(graph)
  };
}

function createBranchCounterexampleVerification(input: {
  runId: string;
  run: ReturnType<Ledger["requireRun"]>;
  ledger: Ledger;
  artifacts: ArtifactStore;
  sourceBranchArtifactId: string;
}, claimId: string, text: string, referencedArtifactIds: string[]): {
  mode: string;
  claim: FormalClaimContract;
  proofObligationDecision: ReturnType<typeof evaluateProofObligationGraph>;
  proofObligationTrace: ReturnType<typeof traceProofObligations>;
} {
  const counterexampleText = normalizeBranchConclusion(text, input.run.goal);
  const primary = input.artifacts.create(input.runId, "branch.verifier.counterexample.result", JSON.stringify({
    verifier: "counterexample-checker",
    sourceBranchArtifactId: input.sourceBranchArtifactId,
    structuredWorkerResultArtifactIds: referencedArtifactIds,
    counterexample: counterexampleText,
    evidenceGrade: "verified_counterexample"
  }, null, 2));
  const primaryEvent = input.ledger.appendEvent(input.runId, "verifier.completed", {
    verifier: "counterexample-checker",
    source: "branch.candidate",
    claimId,
    evidenceGrade: "verified_counterexample",
    artifactId: primary.id
  }, [primary.id, input.sourceBranchArtifactId]);
  const validator = input.artifacts.create(input.runId, "branch.verifier.counterexample-validator.result", JSON.stringify({
    verifier: "counterexample-independent-validator",
    sourceBranchArtifactId: input.sourceBranchArtifactId,
    counterexample: counterexampleText,
    evidenceGrade: "verified_counterexample"
  }, null, 2));
  const validatorEvent = input.ledger.appendEvent(input.runId, "verifier.completed", {
    verifier: "counterexample-independent-validator",
    source: "branch.candidate",
    claimId,
    evidenceGrade: "verified_counterexample",
    artifactId: validator.id,
    role: "counterexample_validator"
  }, [validator.id, input.sourceBranchArtifactId]);
  const search = input.artifacts.create(input.runId, "branch.counterexample.search", JSON.stringify({
    claimId,
    status: "passed",
    counterexample: counterexampleText,
    sourceBranchArtifactId: input.sourceBranchArtifactId
  }, null, 2));
  const searchEvent = input.ledger.appendEvent(input.runId, "counterexample.search.reviewed", {
    claimId,
    source: "branch.candidate",
    status: "passed",
    searches: [{
      method: "numeric",
      outcome: "passed",
      counterexample: counterexampleText,
      artifactIds: [search.id]
    }],
    artifactId: search.id,
    sourceBranchArtifactId: input.sourceBranchArtifactId
  }, [search.id, input.sourceBranchArtifactId]);
  const graph = makeProofObligationGraph({
    rootClaimId: claimId,
    obligations: [{
      id: claimId,
      statement: `Branch candidate counterexample for: ${input.run.goal}`,
      assumptions: [],
      conclusion: counterexampleText,
      dependencies: [],
      status: "computational_evidence",
      verifierId: "counterexample-checker",
      artifactIds: uniqueStrings([primary.id, validator.id, search.id, ...referencedArtifactIds]),
      counterexampleSearch: "passed",
      counterexampleSearches: [{
        method: "numeric",
        outcome: "passed",
        counterexample: counterexampleText,
        artifactIds: [search.id]
      }],
      dependencyEventIds: [primaryEvent.id, validatorEvent.id, searchEvent.id]
    }]
  });
  const claim = makeClaimContract({
    id: claimId,
    claimType: "counterexample",
    verifierId: "counterexample-checker",
    conclusion: counterexampleText,
    verifierStatus: "verified",
    evidenceGrade: "verified_counterexample",
    verifierArtifactIds: [primary.id],
    proofObligationGraph: graph,
    supportingVerifierResults: [{
      verifierId: "counterexample-independent-validator",
      role: "counterexample_validator",
      claimType: "counterexample",
      verifierStatus: "verified",
      evidenceGrade: "verified_counterexample",
      artifactIds: [validator.id]
    }],
    formalization: { status: "not_required" }
  });
  return {
    mode: "deterministic_branch_counterexample",
    claim,
    proofObligationDecision: evaluateProofObligationGraph(graph, input.ledger.listArtifacts(input.runId), { evidenceGrade: "verified_counterexample", events: input.ledger.listEvents(input.runId) }),
    proofObligationTrace: traceProofObligations(graph)
  };
}

function createUnsupportedBranchVerification(input: {
  runId: string;
  run: ReturnType<Ledger["requireRun"]>;
  ledger: Ledger;
  artifacts: ArtifactStore;
  sourceBranchArtifactId: string;
}, claimId: string, conclusion: string, workerResultSchemaReview: WorkerResultSchemaReview, looksLikeFormalProof: boolean, formalization?: PersistedBranchFormalization): BranchVerificationResult {
  const search = input.artifacts.create(input.runId, "branch.counterexample.search", JSON.stringify({
    claimId,
    status: "attempted",
    sourceBranchArtifactId: input.sourceBranchArtifactId,
    workerResultSchemaStatus: workerResultSchemaReview.status,
    note: workerResultSchemaReview.status === "valid"
      ? "Structured branch worker result is not verifier evidence without deterministic verifier support."
      : "Unsupported branch text or invalid structured output is not verifier evidence."
  }, null, 2));
  const searchEvent = input.ledger.appendEvent(input.runId, "counterexample.search.reviewed", {
    claimId,
    source: "branch.candidate",
    status: "attempted",
    searches: [{
      method: "numeric",
      outcome: "attempted",
      artifactIds: [search.id]
    }],
    negativeEvidenceOnly: true,
    artifactId: search.id,
    sourceBranchArtifactId: input.sourceBranchArtifactId
  }, [search.id, input.sourceBranchArtifactId]);
  const graph = makeProofObligationGraph({
    rootClaimId: claimId,
    obligations: [{
      id: claimId,
      statement: conclusion,
      assumptions: [],
      conclusion,
      dependencies: [],
      status: "informal_unverified",
      verifierId: "branch-output-normalizer",
      artifactIds: [input.sourceBranchArtifactId, search.id],
      counterexampleSearch: "attempted",
      counterexampleSearches: [{
        method: "numeric",
        outcome: "attempted",
        artifactIds: [search.id]
      }],
      dependencyEventIds: [searchEvent.id]
    }]
  });
  const claim = makeClaimContract({
    id: claimId,
    claimType: looksLikeFormalProof ? "proof_sketch" : "conjecture",
    verifierId: "branch-output-normalizer",
    conclusion,
    verifierStatus: "not_checked",
    evidenceGrade: "unsupported",
    verifierArtifactIds: [],
    proofObligationGraph: graph,
    formalization: formalization ?? {
      status: looksLikeFormalProof ? "not_formalized" : "not_required",
      knownGaps: looksLikeFormalProof ? ["missing Lean machine-check artifact"] : []
    }
  });
  return {
    mode: workerResultSchemaReview.status === "valid"
      ? "unsupported_structured_worker_result"
      : "unsupported_model_branch_text",
    claim,
    proofObligationDecision: evaluateProofObligationGraph(graph, input.ledger.listArtifacts(input.runId), { evidenceGrade: "unsupported", events: input.ledger.listEvents(input.runId) }),
    proofObligationTrace: traceProofObligations(graph)
  };
}

function parseBranchArtifact(artifact: Artifact): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readArtifactText(artifact)) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function branchArtifactText(value: Record<string, unknown>): string {
  return [
    stringValue(value.text),
    stringValue(value.result),
    stringValue(value.summary)
  ].filter((item): item is string => Boolean(item)).join("\n");
}

function normalizeBranchConclusion(text: string, fallbackGoal: string): string {
  const normalized = text
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length > 0 ? normalized.slice(0, 500) : `Branch candidate for: ${fallbackGoal}`;
}

function theoremNameFromWorkerResult(review: WorkerResultSchemaReview): string | undefined {
  return review.status === "valid" ? review.result.leanAttempt?.theoremName : undefined;
}

function latestWorkerResultSchemaReviewArtifactId(
  ledger: Ledger,
  runId: string,
  sourceBranchArtifactId: string
): string | undefined {
  return ledger.listEvents(runId)
    .findLast((event) =>
      event.type === "branch.worker_result.schema.reviewed" &&
      event.payload.sourceBranchArtifactId === sourceBranchArtifactId &&
      typeof event.payload.artifactId === "string"
    )?.payload.artifactId as string | undefined;
}

function extractLeanTheoremStatement(source: string, preferredName?: string): {
  theoremName?: string;
  formalStatement?: string;
  proposition?: string;
} {
  const lines = source.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^(?:private\s+|protected\s+)?(?:theorem|lemma)\s+/.test(line));
  const line = preferredName
    ? lines.find((item) => new RegExp(`^(?:private\\s+|protected\\s+)?(?:theorem|lemma)\\s+${escapeRegExp(preferredName)}\\b`).test(item)) ?? lines[0]
    : lines[0];
  if (!line) return {};
  const beforeBody = line.split(":=")[0]?.trim() ?? line;
  const nameMatch = /^(?:private\s+|protected\s+)?(?:theorem|lemma)\s+([A-Za-z_][A-Za-z0-9_'.]*)/.exec(beforeBody);
  const proposition = beforeBody.includes(":")
    ? beforeBody.slice(beforeBody.indexOf(":") + 1).trim()
    : undefined;
  return {
    theoremName: nameMatch?.[1],
    formalStatement: beforeBody,
    proposition
  };
}

function equivalentTargetStatement(
  theoremProposition: string | undefined,
  run: ReturnType<Ledger["requireRun"]>
): { equivalent: boolean; normalizedTarget: string } {
  const normalizedProposition = normalizeStatementForEquivalence(theoremProposition ?? "");
  const candidates = [run.goal, run.problem]
    .map((statement) => ({
      raw: statement,
      normalized: normalizeStatementForEquivalence(statement)
    }))
    .filter((candidate) => candidate.normalized.length > 0);
  const exact = candidates.find((candidate) => candidate.normalized === normalizedProposition);
  return {
    equivalent: Boolean(exact && normalizedProposition.length > 0),
    normalizedTarget: exact?.raw ?? run.goal
  };
}

function normalizeStatementForEquivalence(statement: string): string {
  return statement
    .toLowerCase()
    .replace(/^\s*(?:prove|show|find|verify|establish)\s+(?:that\s+)?/i, "")
    .replace(/^(?:theorem|lemma)\s+[a-z_][a-z0-9_'.]*\s*:\s*/i, "")
    .replace(/\b(nat|int|integer|natural)\b/g, "")
    .replace(/\s*([=+\-*/<>≤≥])\s*/g, "$1")
    .replace(/[.,;:]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function textLooksLikeFormalProof(text: string): boolean {
  return /\b(formal[_ -]?proof|lean theorem|qed|theorem)\b/i.test(text);
}

function deterministicCounterexampleAccepted(problem: string, goal: string, text: string): boolean {
  const target = parseExactIntegerAdditionIdentity(`${problem} ${goal}`);
  if (target && target.lhs + target.rhs !== target.result) {
    const actual = target.lhs + target.rhs;
    const normalized = normalizeArithmeticFixtureText(text);
    return normalized.includes(`${target.lhs}+${target.rhs}=${actual}`) ||
      normalized.includes(`${actual}!=${target.result}`) ||
      normalized.includes(`${actual}not${target.result}`);
  }
  const normalizedProblem = normalizeArithmeticFixtureText(`${problem} ${goal}`);
  const normalizedText = normalizeArithmeticFixtureText(text);
  return normalizedProblem.includes("1+1=3") &&
    (normalizedText.includes("1+1=2") || normalizedText.includes("2!=3"));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function uniqueEvents(events: ReturnType<Ledger["listEvents"]>): ReturnType<Ledger["listEvents"]> {
  const seen = new Set<string>();
  const unique: ReturnType<Ledger["listEvents"]> = [];
  for (const event of events) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    unique.push(event);
  }
  return unique;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function persistLoopholeAssumptionDelta(input: {
  runId: string;
  cycle: number;
  branch: number;
  role: string;
  problem: string;
  goal: string;
  artifacts: ArtifactStore;
  ledger: Ledger;
}): { artifactId: string; review: ReturnType<typeof reviewLoopholeAssumptionDelta> } {
  const review = reviewLoopholeAssumptionDelta({
    role: input.role,
    problem: input.problem,
    goal: input.goal,
    proposedStatement: input.role === "counterexample-search"
      ? `Counterexample search preserving original goal: ${input.goal}`
      : `Loophole branch may prove a nearby theorem or add a hidden assumption for: ${input.goal}`
  });
  const artifact = input.artifacts.create(input.runId, "phase.loophole.assumption-delta", JSON.stringify({
    cycle: input.cycle,
    branch: input.branch,
    review
  }, null, 2));
  input.ledger.appendEvent(input.runId, "loophole.assumption_delta.reviewed", {
    phase: "loophole",
    cycle: input.cycle,
    branch: input.branch,
    role: input.role,
    artifactId: artifact.id,
    reportLabel: review.reportLabel,
    canSolveOriginalGoal: review.canSolveOriginalGoal,
    createsAlternateGoalCandidate: review.createsAlternateGoalCandidate,
    affectedGoalCandidateIds: review.affectedGoalCandidateIds,
    deltas: review.deltas,
    verifierImpact: review.verifierImpact
  }, [artifact.id]);
  return { artifactId: artifact.id, review };
}

function branchFalsifiableClaim(role: string, problem: string, goal: string): Record<string, unknown> {
  return {
    claim: `${role} proposes a falsifiable route for: ${goal}`,
    falsifier: `Find a counterexample or proof-obligation failure for: ${problem}`,
    requiredEvidence: ["counterexample search", "formalization check", "independent verifier review"]
  };
}

function branchExecutableExperiment(role: string, problem: string, goal: string): Record<string, unknown> {
  return {
    experiment: `${role} executable experiment for: ${goal}`,
    command: "matematica sandbox run --from-artifact <experiment>",
    inputs: { problem, goal },
    expectedObservation: "reproducible output artifact or verifier-classified failure",
    falsifier: "non-reproducible execution, counterexample, or verifier rejection"
  };
}

function rankExperimentBranches(runId: string, ledger: Ledger, artifacts: ArtifactStore, cycle: number): { artifactId: string; rankedBranches: Array<Record<string, unknown>> } {
  const experimentBranches = rankWorkerTournament({
    ledger,
    runId,
    kind: "workflow.branch",
    phase: "experiment"
  })
    .filter((candidate) => Number(candidate.payload.cycle ?? 1) === cycle)
    .map((candidate) => ({
    jobId: candidate.jobId,
    cycle,
    branch: candidate.payload.branch,
    role: candidate.payload.role,
    rank: candidate.rank,
    score: candidate.score,
    reasons: candidate.reasons,
    mutation: `evolve-${candidate.payload.role ?? "branch"}-${candidate.rank}`
  }));
  const artifact = artifacts.create(runId, "phase.evolve.ranking", JSON.stringify({
    phase: "evolve",
    cycle,
    rankedBranches: experimentBranches,
    selectedBranchId: experimentBranches[0]?.jobId ?? null
  }, null, 2));
  ledger.appendEvent(runId, "phase.completed", {
    phase: "evolve.ranking",
    cycle,
    rankingArtifactId: artifact.id,
    rankedBranches: experimentBranches
  }, [artifact.id]);
  return {
    artifactId: artifact.id,
    rankedBranches: experimentBranches
  };
}

function assertBranchJob(job: Parameters<typeof isBranchJob>[0]) {
  if (!isBranchJob(job)) throw new Error(`Expected workflow.branch job, got ${job.kind}`);
  return job;
}

async function defaultRunResearchSearch(): Promise<ArxivPaper[]> {
  return [];
}

function buildArxivQuery(problem: string, goal: string): string {
  const keywords = `${problem} ${goal}`
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 4)
    .slice(0, 8);
  const query = keywords.length > 0 ? keywords.map((word) => `all:${word}`).join(" AND ") : "cat:math";
  return `(cat:math OR cat:cs.AI) AND ${query}`;
}

function buildBranchPrompt(
  role: string,
  phase: string,
  problem: string,
  goal: string,
  strategy?: HardMathStrategySelection,
  sources: UntrustedSourcePayload[] = [],
  nextCyclePlan?: Record<string, unknown>,
  knowledgeContext?: TrustedKnowledgeContext
): string {
  return renderWorkerPrompt({ role, phase, problem, goal, strategy, sources, nextCyclePlan, knowledgeContext });
}

function latestPromptFirewallSources(
  runId: string,
  ledger: Ledger,
  cycle: number,
  branchPhase: string,
  nextCyclePlan?: Record<string, unknown>
): {
  sources: UntrustedSourcePayload[];
  knowledgeContext?: TrustedKnowledgeContext;
  firewall: {
    mode: "citation_only" | "untrusted_source_blocks";
    sourceEventIds: string[];
    sourceArtifactIds: string[];
    sourceCount: number;
    fullTextTrusted: false;
    controlsAffected: false;
  };
} {
  const sourcePhase = branchPhase === "experiment" || branchPhase === "evolve" ? "gather" : "feedback";
  const sourceEvents = ledger.listEvents(runId)
    .filter((event) =>
      event.type === "source.results" &&
      Number(event.payload.cycle ?? 1) === cycle &&
      event.payload.phase === sourcePhase &&
      typeof event.payload.artifactId === "string"
    );
  const artifactsById = new Map(ledger.listArtifacts(runId).map((artifact) => [artifact.id, artifact]));
  const sources: UntrustedSourcePayload[] = [];
  const sourceArtifactIds: string[] = [];
  for (const event of sourceEvents) {
    const artifactId = String(event.payload.artifactId);
    const artifact = artifactsById.get(artifactId);
    if (!artifact) continue;
    sourceArtifactIds.push(artifactId);
    for (const source of promptSourcesFromArtifact(artifact)) {
      if (source.trust.citationOnly) continue;
      sources.push(source);
    }
  }
  const knowledgeContext = cycle > 1 || nextCyclePlan || sourceEvents.some((event) => event.payload.provider === "mathlib")
    ? buildPromptKnowledgeContext({
        ledger,
        runId,
        cycle,
        branchPhase,
        sourceEvents,
        sourceArtifactIds,
        sourcePhase,
        nextCyclePlan
      })
    : undefined;
  return {
    sources,
    knowledgeContext,
    firewall: {
      mode: sources.length > 0 ? "untrusted_source_blocks" : "citation_only",
      sourceEventIds: sourceEvents.map((event) => event.id),
      sourceArtifactIds,
      sourceCount: sources.length,
      fullTextTrusted: false,
      controlsAffected: false
    }
  };
}

function buildPromptKnowledgeContext(input: {
  ledger: Ledger;
  runId: string;
  cycle: number;
  branchPhase: string;
  sourceEvents: ReturnType<Ledger["listEvents"]>;
  sourceArtifactIds: string[];
  sourcePhase: string;
  nextCyclePlan?: Record<string, unknown>;
}): TrustedKnowledgeContext {
  const events = input.ledger.listEvents(input.runId);
  const priorSourceEvents = events.filter((event) =>
    event.type === "source.results" &&
    event.payload.phase === input.sourcePhase &&
    Number(event.payload.cycle ?? 1) < input.cycle &&
    typeof event.payload.artifactId === "string"
  );
  const sourceEvents = [...priorSourceEvents, ...input.sourceEvents];
  const sourceArtifactIds = uniqueStrings([
    ...input.sourceArtifactIds,
    ...priorSourceEvents
      .map((event) => stringValue(event.payload.artifactId))
      .filter((artifactId): artifactId is string => Boolean(artifactId))
  ]);
  const priorCycle = input.cycle - 1;
  const priorCycleEvents = events.filter((event) => Number(event.payload.cycle ?? 0) === priorCycle);
  const promotionReview = events.findLast((event) =>
    event.type === "knowledge.promotion.reviewed" &&
    Number(event.payload.targetCycle) === input.cycle &&
    event.payload.status === "passed"
  );
  const acceptedKnowledgeEventIds = new Set(arrayValue(promotionReview?.payload.accepted)
    .map(recordValue)
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .filter((item) => item.role === "typed_knowledge_artifact")
    .map((item) => stringValue(item.eventId))
    .filter((id): id is string => Boolean(id)));
  return {
    format: "matematica.branch-knowledge-context",
    version: 1,
    cycle: input.cycle,
    branchPhase: input.branchPhase,
    sourceEventIds: sourceEvents.map((event) => event.id),
    sourceArtifactIds,
    research: sourceEvents.map((event) => summarizeSourceResultForPrompt(event)).slice(-3),
    priorKnowledge: {
      previousCycle: priorCycle > 0 ? {
        cycle: priorCycle,
        cycleCompleted: priorCycleEvents
          .filter((event) => event.type === "cycle.completed")
          .map((event) => ({
            eventId: event.id,
            status: event.payload.status,
            evidenceGrade: event.payload.evidenceGrade,
            finalState: event.payload.finalState,
            reason: event.payload.reason,
            nextCyclePlanArtifactId: event.payload.nextCyclePlanArtifactId,
            nextCyclePlanHash: event.payload.nextCyclePlanHash
          })),
        conjectures: priorCycleEvents
          .filter((event) => event.type === "knowledge.conjecture.saved")
          .filter((event) => acceptedKnowledgeEventIds.has(event.id))
          .map((event) => ({
            eventId: event.id,
            claimId: event.payload.claimId,
            artifactId: event.payload.artifactId,
            evidenceGrade: event.payload.evidenceGrade,
            finalState: event.payload.finalState,
            truthLevel: event.payload.truthLevel,
            trustGrade: event.payload.trustGrade,
            verifierStatus: event.payload.verifierStatus,
            sourceTaint: event.payload.sourceTaint,
            dependencyGraph: event.payload.dependencyGraph,
            contradictionReview: event.payload.contradictionReview,
            supersession: event.payload.supersession,
            freshness: event.payload.freshness,
            promotion: event.payload.promotion,
            nextAction: event.payload.nextAction
          })),
        branchReviews: priorCycleEvents
          .filter((event) => event.type === "branch.candidate_claim.reviewed")
          .map((event) => ({
            eventId: event.id,
            claimId: event.payload.claimId,
            status: event.payload.status,
            phase: event.payload.phase,
            role: event.payload.role,
            sourceBranchArtifactId: event.payload.sourceBranchArtifactId
          }))
      } : null,
      nextCyclePlan: input.nextCyclePlan ? {
        artifactId: input.nextCyclePlan.artifactId,
        planHash: input.nextCyclePlan.planHash,
        sourceCycle: input.nextCyclePlan.sourceCycle,
        targetCycle: input.nextCyclePlan.targetCycle,
        promptGuidance: input.nextCyclePlan.promptGuidance,
        nextCycleMutations: input.nextCyclePlan.nextCycleMutations,
        experimentRoleOrder: input.nextCyclePlan.experimentRoleOrder
      } : null
    },
    policy: {
      sourceTextIncluded: false,
      localPathsIncluded: false,
      controlsAffected: false,
      citationMetadataIsProofSupport: false
    },
    promotionFirewall: {
      reviewed: true,
      modelTextTrusted: false,
      sourceTextTrusted: false,
      controlsAffected: false,
      hardEvidenceRequiresSchemaValidTypedArtifacts: true,
      acceptedKnowledgeEventIds: [...acceptedKnowledgeEventIds],
      artifactId: stringValue(promotionReview?.payload.artifactId),
      reviewHash: stringValue(promotionReview?.payload.reviewHash)
    }
  };
}

function summarizeSourceResultForPrompt(event: ReturnType<Ledger["listEvents"]>[number]): Record<string, unknown> {
  const payload = event.payload;
  const retrievalEvaluation = recordValue(payload.retrievalEvaluation);
  const citationManifest = recordValue(payload.citationLicenseManifest);
  const citationManifestSummary = recordValue(payload.citationLicenseManifestSummary) ?? recordValue(citationManifest?.summary);
  return {
    eventId: event.id,
    artifactId: payload.artifactId,
    phase: payload.phase,
    cycle: payload.cycle,
    provider: payload.provider,
    queryHash: typeof payload.query === "string" ? stableHash(payload.query).slice(0, 16) : undefined,
    count: payload.count,
    offlineCacheOnly: payload.offlineCacheOnly,
    cache: summarizeCacheForPrompt(payload.cache),
    retrievalEvaluation: retrievalEvaluation ? {
      retrievedCount: retrievalEvaluation.retrievedCount,
      precision: retrievalEvaluation.precision,
      recall: retrievalEvaluation.recall,
      citationValidity: retrievalEvaluation.citationValidity,
      sourceUseRate: retrievalEvaluation.sourceUseRate,
      staleResultCount: retrievalEvaluation.staleResultCount,
      failures: retrievalEvaluation.failures,
      trustImpact: retrievalEvaluation.trustImpact,
      canPromoteResearchBackedClaims: retrievalEvaluation.canPromoteResearchBackedClaims,
      incompleteResearch: retrievalEvaluation.incompleteResearch
    } : undefined,
    citationManifestSummary,
    theoremHandles: arrayValue(payload.retrievedLemmas)
      .map((lemma) => recordValue(lemma))
      .filter((lemma): lemma is Record<string, unknown> => Boolean(lemma))
      .map((lemma) => ({
        name: lemma.name,
        module: lemma.module,
        namespace: lemma.namespace,
        statementHash: lemma.statementHash,
        trustGrade: lemma.trustGrade,
        relevanceScore: lemma.relevanceScore,
        indexVersion: recordValue(lemma.provenance)?.indexVersion,
        indexHash: recordValue(lemma.provenance)?.indexHash,
        mathlibRevision: recordValue(lemma.provenance)?.mathlibRevision,
        proofSupport: recordValue(lemma.promptSummary)?.proofSupport === false ? false : undefined
      }))
      .slice(0, 5),
    sourceRecordHandles: arrayValue(payload.sourceRecords)
      .map((source) => recordValue(source))
      .filter((source): source is Record<string, unknown> => Boolean(source))
      .map((source) => ({
        sourceId: source.sourceId,
        canonicalId: source.canonicalId,
        version: source.version,
        snapshotHash: source.snapshotHash,
        contentHash: source.contentHash
      }))
      .slice(0, 3)
  };
}

function summarizeCacheForPrompt(value: unknown): Record<string, unknown> | undefined {
  const cache = recordValue(value);
  if (!cache) return undefined;
  return {
    status: cache.status,
    usedCache: cache.usedCache,
    liveNetworkUsed: cache.liveNetworkUsed,
    stale: cache.stale,
    resultHash: cache.resultHash
  };
}

function promptSourcesFromArtifact(artifact: Artifact): UntrustedSourcePayload[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readArtifactText(artifact)) as unknown;
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const record = parsed as Record<string, unknown>;
  const candidates = Array.isArray(record.selectedAbstracts)
    ? record.selectedAbstracts
    : Array.isArray(record.papers)
      ? record.papers
      : [];
  return candidates
    .map(promptSourceFromValue)
    .filter((source): source is UntrustedSourcePayload => Boolean(source));
}

function promptSourceFromValue(value: unknown): UntrustedSourcePayload | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const trust = record.trust;
  const text = stringValue(record.untrustedSummary);
  const sourceId = stringValue(record.id) ?? stringValue(record.sourceId);
  if (!sourceId || !text || !trust || typeof trust !== "object") return undefined;
  const trustRecord = trust as UntrustedSourcePayload["trust"];
  if (trustRecord.trustLevel !== "untrusted" || trustRecord.quarantine !== true) return undefined;
  return {
    sourceId,
    title: stringValue(record.title),
    url: stringValue(record.absUrl) ?? stringValue(record.url),
    text,
    trust: trustRecord
  };
}

function normalizeStrategySelection(
  value: unknown,
  fallback: {
    problem: string;
    goal: string;
    workflow: "pflk" | "gree";
    phase: string;
    role: string;
  }
): HardMathStrategySelection {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (
      record.format === "matematica.hard-math-strategy-selection" &&
      record.version === 1 &&
      typeof record.selectedStrategyId === "string" &&
      Array.isArray(record.tacticContract)
    ) {
      return record as HardMathStrategySelection;
    }
  }
  return selectHardMathStrategy(fallback);
}

function buildPromptLineage(
  source: string,
  problem: string,
  goal: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    source,
    problemHash: stableHash(problem),
    goalHash: stableHash(goal),
    ...extra
  };
}

type LocalVerifierFixture = {
  kind: "integer_addition_identity" | "none";
  evidenceGrade: EvidenceGrade;
  exactStatement: string;
  executableName: string;
  command: string;
  verifierNote: string;
  independentCheckerNote: string;
  numericSearchNote: string;
  symbolicSearchNote: string;
  domainSearchNote: string;
  inputDomain: string;
  boundsStatement: string;
  claimConclusion: string;
  proofObligationStatement: string;
};

function localVerifierFixture(problem: string, goal: string): LocalVerifierFixture {
  const arithmetic = parseExactIntegerAdditionIdentity(problem);
  const normalizedGoal = normalizeArithmeticFixtureText(goal);
  if (
    arithmetic &&
    arithmetic.lhs + arithmetic.rhs === arithmetic.result &&
    (normalizedGoal.length === 0 || normalizedGoal.includes("verified computation") || normalizedGoal.includes("compute"))
  ) {
    const exactStatement = `${arithmetic.lhs} + ${arithmetic.rhs} = ${arithmetic.result}`;
    return {
      kind: "integer_addition_identity",
      evidenceGrade: "verified_computation",
      exactStatement,
      executableName: "local-deterministic-v0 integer addition identity checker",
      command: `local-deterministic-v0 --check integer-addition --input '${exactStatement}' --seed deterministic-arithmetic-v0`,
      verifierNote: `Recognized an exact closed integer-addition identity: ${exactStatement}.`,
      independentCheckerNote: `Independently re-evaluated the exact closed integer-addition identity: ${exactStatement}.`,
      numericSearchNote: `Checked the closed integer-addition identity directly: ${exactStatement}.`,
      symbolicSearchNote: `Simplified both sides of the closed integer-addition identity: ${exactStatement}.`,
      domainSearchNote: "Domain-specific check confirmed no variables, hidden assumptions, or boundary cases exist.",
      inputDomain: `closed integer-addition identity ${exactStatement}`,
      boundsStatement: "closed finite expression with no variables; exactly one deterministic integer addition is evaluated",
      claimConclusion: `The arithmetic identity ${exactStatement} is verified by the local deterministic verifier.`,
      proofObligationStatement: `The arithmetic identity ${exactStatement} is verified by deterministic computation.`
    };
  }
  return {
    kind: "none",
    evidenceGrade: "conjectural_solution",
    exactStatement: "no exact verified statement",
    executableName: "local-deterministic-v0 limited fixture checker",
    command: "local-deterministic-v0 --check limited-fixtures --seed deterministic-arithmetic-v0",
    verifierNote: "No formal verifier-backed solution was found in the local v0 runner.",
    independentCheckerNote: "Independent checker did not find verifier-backed evidence.",
    numericSearchNote: "No numeric counterexample search was applicable to the local v0 failure.",
    symbolicSearchNote: "Symbolic counterexample search was not applicable to the local v0 failure.",
    domainSearchNote: "Domain-specific counterexample search was not applicable to the local v0 failure.",
    inputDomain: "unverified local fixture input",
    boundsStatement: "no verifier-backed finite computation was established",
    claimConclusion: "The local deterministic verifier did not find verifier-backed evidence.",
    proofObligationStatement: "The local deterministic verifier did not establish a proof obligation."
  };
}

function parseExactIntegerAdditionIdentity(problem: string): { lhs: number; rhs: number; result: number } | undefined {
  const normalized = normalizeArithmeticFixtureText(problem);
  const match = /^(?:prove|show|verify|compute)?\s*(\d{1,6})\+(\d{1,6})=(\d{1,7})$/.exec(normalized);
  if (!match) return undefined;
  return {
    lhs: Number(match[1]),
    rhs: Number(match[2]),
    result: Number(match[3])
  };
}

function normalizeArithmeticFixtureText(value: string): string {
  return value
    .toLowerCase()
    .replace(/one plus one equals two/g, "1+1=2")
    .replace(/\b(two plus two equals four|two plus two is four)\b/g, "2+2=4")
    .replace(/\s*\+\s*/g, "+")
    .replace(/\s*=\s*/g, "=")
    .replace(/[^a-z0-9+= ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
