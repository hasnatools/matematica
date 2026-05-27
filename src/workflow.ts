import type { Artifact, LedgerEvent, Workflow, WorkerJob } from "./domain";
import { stableHash } from "./idempotency";
import type { Ledger } from "./ledger";
import type { HardMathStrategySelection } from "./math-strategy";
import { readArtifactText } from "./storage-encryption";

export type WorkflowPhase = {
  name: string;
  order: number;
  fanout: boolean;
};

export type WorkflowPhaseName =
  | "problem"
  | "feedback"
  | "loophole"
  | "knowledge"
  | "gather"
  | "refine"
  | "experiment"
  | "evolve";

export type WorkflowPhaseContract = WorkflowPhase & {
  version: "workflow-phase-contract-v1";
  workflow: Workflow;
  inputs: string[];
  requiredArtifactKinds: string[];
  allowedTools: string[];
  verifierChecks: string[];
  budgetUse: Array<"attempt" | "tokens" | "usd" | "elapsedMs" | "none">;
  allowedNextPhases: string[];
  failureStates: string[];
  gates: string[];
  outputRequirements: string[];
};

export type PhaseContractValidation = {
  ok: boolean;
  failures: string[];
};

export type WorkflowPhaseReleaseAudit = {
  format: "matematica.workflow-phase-release-audit";
  version: 1;
  runId: string;
  workflow: Workflow;
  ok: boolean;
  phaseEventCount: number;
  checkedPhases: Array<{
    eventId: string;
    phase: string;
    cycle: number;
    artifactIds: string[];
    ok: boolean;
    failures: string[];
  }>;
  issues: string[];
};

export type ReconstructedWorkflowState = {
  workflow: Workflow;
  completedByCycle: Record<number, string[]>;
  lastCycle: number;
  lastCompletedPhase?: string;
  nextExpectedPhase?: string;
  invalidTransitions: string[];
};

export type PhaseJobPayload = {
  workflow: Workflow;
  phase: string;
  order: number;
  fanout: boolean;
  cycle?: number;
  contextCompactionEventId?: string;
  contextCompactionReviewHash?: string;
  nextCyclePlanArtifactId?: string;
  nextCyclePlanHash?: string;
  nextCyclePlan?: Record<string, unknown>;
};

export type BranchJobPayload = {
  workflow: Workflow;
  phase: string;
  branch: number;
  role: string;
  cycle?: number;
  parentPhaseJobId?: string;
  contextCompactionEventId?: string;
  contextCompactionReviewHash?: string;
  strategySelection?: HardMathStrategySelection;
  nextCyclePlanArtifactId?: string;
  nextCyclePlanHash?: string;
  nextCyclePlan?: Record<string, unknown>;
  nextCycleMutation?: Record<string, unknown>;
  promptLineage?: Record<string, unknown>;
  providerRoute?: Record<string, unknown>;
  fanoutPlanHash?: string;
  fanoutPlanArtifactId?: string;
  fanoutLineage?: Record<string, unknown>;
  capacityPlanHash?: string;
  capacityInitiallyAdmitted?: boolean;
  capacityMode?: "admitted" | "deferred";
};

export type ResearchJobPayload = {
  workflow: Workflow;
  phase: "feedback" | "gather";
  provider: "arxiv" | "mathlib";
  query: string;
  maxResults: number;
  cycle?: number;
  parentPhaseJobId?: string;
  contextCompactionEventId?: string;
  contextCompactionReviewHash?: string;
  promptLineage?: Record<string, unknown>;
  providerRoute?: Record<string, unknown>;
};

export function workflowPhases(workflow: Workflow): WorkflowPhase[] {
  return workflowPhaseContracts(workflow).map(({ name, order, fanout }) => ({ name, order, fanout }));
}

export function workflowPhaseContracts(workflow: Workflow): WorkflowPhaseContract[] {
  return workflow === "pflk" ? PFLK_CONTRACTS : GREE_CONTRACTS;
}

export function workflowPhaseContract(workflow: Workflow, phase: string): WorkflowPhaseContract {
  const contract = workflowPhaseContracts(workflow).find((item) => item.name === phase);
  if (!contract) throw new Error(`Unknown ${workflow} phase "${phase}".`);
  return contract;
}

export function validateWorkflowTransition(
  workflow: Workflow,
  previousPhase: string | undefined,
  nextPhase: string
): PhaseContractValidation {
  const contracts = workflowPhaseContracts(workflow);
  const next = contracts.find((item) => item.name === nextPhase);
  if (!next) return fail(`phase "${nextPhase}" is not part of ${workflow}`);
  if (!previousPhase) {
    return next.order === 1 ? pass() : fail(`phase "${nextPhase}" cannot start before ${contracts[0].name}`);
  }
  const previous = workflowPhaseContract(workflow, previousPhase);
  return previous.allowedNextPhases.includes(nextPhase)
    ? pass()
    : fail(`invalid ${workflow} transition ${previousPhase} -> ${nextPhase}`);
}

export function validatePhaseCompletion(input: {
  ledger: Ledger;
  runId: string;
  workflow: Workflow;
  phase: string;
  cycle: number;
  payload: Record<string, unknown>;
  artifactIds: string[];
}): PhaseContractValidation {
  const contract = workflowPhaseContract(input.workflow, input.phase);
  const failures: string[] = [];
  const artifacts = input.ledger.listArtifacts(input.runId);
  const artifactKinds = new Set(
    artifacts
      .filter((artifact) => input.artifactIds.includes(artifact.id))
      .map((artifact) => artifact.kind)
  );
  for (const requiredKind of contract.requiredArtifactKinds) {
    if (!artifactKinds.has(requiredKind)) failures.push(`phase ${input.phase} missing required artifact kind ${requiredKind}`);
  }
  failures.push(...validatePhaseOutputManifest({
    workflow: input.workflow,
    phase: input.phase,
    cycle: input.cycle,
    contract,
    payload: input.payload,
    artifacts: artifacts.filter((artifact) => input.artifactIds.includes(artifact.id))
  }));
  const previousPhase = previousCompletedPhase(input.ledger.listEvents(input.runId), input.workflow, input.cycle, contract.order);
  failures.push(...validateWorkflowTransition(input.workflow, previousPhase, input.phase).failures);

  if (contract.fanout) {
    const branchJobs = scheduledWorkerJobsForPhase(input.ledger, input.runId, "workflow.branch", input.phase, input.cycle);
    if (branchJobs.length === 0) failures.push(`phase ${input.phase} must schedule branch jobs`);
    for (const job of branchJobs) {
      if (job.payload.parentPhaseJobId !== input.payload.jobId) {
        failures.push(`phase ${input.phase} branch job ${job.id} is not linked to phase job ${String(input.payload.jobId)}`);
      }
      if (!isRecord(job.payload.promptLineage)) failures.push(`phase ${input.phase} branch job ${job.id} missing prompt lineage`);
      if (!isRecord(job.payload.providerRoute)) failures.push(`phase ${input.phase} branch job ${job.id} missing provider route`);
      if (typeof job.payload.role !== "string" || job.payload.role.length === 0) {
        failures.push(`phase ${input.phase} branch job ${job.id} missing worker role`);
      }
    }
    if (!Array.isArray(input.payload.nextTasks) || input.payload.nextTasks.length === 0) {
      failures.push(`phase ${input.phase} must record branch task ids`);
    }
  }
  if (input.phase === "feedback" || input.phase === "gather") {
    const arxivJobs = scheduledWorkerJobsForPhase(input.ledger, input.runId, "research.arxiv", input.phase, input.cycle);
    const mathlibJobs = scheduledWorkerJobsForPhase(input.ledger, input.runId, "research.mathlib", input.phase, input.cycle);
    const researchJobs = [...arxivJobs, ...mathlibJobs];
    if (arxivJobs.length === 0) failures.push(`phase ${input.phase} must schedule arXiv research`);
    if (mathlibJobs.length === 0) failures.push(`phase ${input.phase} must schedule mathlib theorem research`);
    for (const job of researchJobs) {
      if (job.payload.parentPhaseJobId !== input.payload.jobId) {
        failures.push(`phase ${input.phase} research job ${job.id} is not linked to phase job ${String(input.payload.jobId)}`);
      }
      if (!isRecord(job.payload.promptLineage)) failures.push(`phase ${input.phase} research job ${job.id} missing prompt lineage`);
      if (!isRecord(job.payload.providerRoute)) failures.push(`phase ${input.phase} research job ${job.id} missing provider route`);
    }
    if (!Array.isArray(input.payload.researchTasks) || input.payload.researchTasks.length === 0) {
      failures.push(`phase ${input.phase} must record research task ids`);
    }
  }
  if ((input.phase === "knowledge" || input.phase === "evolve") && input.payload.terminalSuccessAllowed !== false) {
    failures.push(`phase ${input.phase} must not mark success from conjectural or rejected evidence`);
  }
  return failures.length === 0 ? pass() : { ok: false, failures };
}

export function auditWorkflowPhaseReleaseReadiness(
  ledger: Ledger,
  runId: string
): WorkflowPhaseReleaseAudit {
  const run = ledger.requireRun(runId);
  const events = ledger.listEvents(runId);
  const phaseEvents = events.filter((event) => event.type === "phase.completed");
  const checkedPhases = phaseEvents.map((event) => {
    const phase = stringValue(event.payload.phase) ?? "unknown";
    const workflow = stringValue(event.payload.workflow) === "gree" ? "gree" : stringValue(event.payload.workflow) === "pflk" ? "pflk" : run.workflow;
    const cycle = Number(event.payload.cycle ?? 1);
    const validation = validatePhaseCompletionSafely({
      ledger,
      runId,
      workflow,
      phase,
      cycle: Number.isFinite(cycle) ? cycle : 1,
      payload: isRecord(event.payload) ? event.payload : {},
      artifactIds: event.artifactIds
    });
    return {
      eventId: event.id,
      phase,
      cycle: Number.isFinite(cycle) ? cycle : 1,
      artifactIds: event.artifactIds,
      ok: validation.ok,
      failures: validation.failures
    };
  });
  const issues = checkedPhases.flatMap((phase) =>
    phase.failures.map((failure) => `${phase.eventId}:${phase.phase}: ${failure}`)
  );
  return {
    format: "matematica.workflow-phase-release-audit",
    version: 1,
    runId,
    workflow: run.workflow,
    ok: issues.length === 0,
    phaseEventCount: phaseEvents.length,
    checkedPhases,
    issues
  };
}

function scheduledWorkerJobsForPhase(
  ledger: Ledger,
  runId: string,
  kind: string,
  phase: string,
  cycle: number
): Array<{ id: string; kind: string; payload: Record<string, unknown> }> {
  const sideTableJobs = ledger.listWorkerJobs(runId)
    .filter((job) =>
      job.kind === kind &&
      job.payload.phase === phase &&
      Number(job.payload.cycle ?? 1) === cycle
    )
    .map((job) => ({ id: job.id, kind: job.kind, payload: job.payload }));
  if (sideTableJobs.length > 0) return sideTableJobs;

  return ledger.listEvents(runId)
    .filter((event) => event.type === "worker.enqueued" && event.payload.kind === kind)
    .map((event) => {
      const payload = isRecord(event.payload.payload) ? event.payload.payload : {};
      return {
        id: stringValue(event.payload.jobId) ?? event.id,
        kind,
        payload
      };
    })
    .filter((job) => job.payload.phase === phase && Number(job.payload.cycle ?? 1) === cycle);
}

export function reconstructWorkflowState(
  ledger: Ledger,
  runId: string,
  workflow: Workflow
): ReconstructedWorkflowState {
  const completedByCycle: Record<number, string[]> = {};
  const invalidTransitions: string[] = [];
  for (const event of ledger.listEvents(runId)) {
    if (event.type !== "phase.completed" || event.payload.workflow !== workflow || typeof event.payload.phase !== "string") continue;
    if (!workflowPhaseContracts(workflow).some((contract) => contract.name === event.payload.phase)) continue;
    const cycle = Number(event.payload.cycle ?? 1);
    const completed = completedByCycle[cycle] ?? [];
    const previous = completed.at(-1);
    const transition = validateWorkflowTransition(workflow, previous, event.payload.phase);
    if (!transition.ok) invalidTransitions.push(...transition.failures);
    completed.push(event.payload.phase);
    completedByCycle[cycle] = completed;
  }
  const cycles = Object.keys(completedByCycle).map(Number).sort((a, b) => a - b);
  const lastCycle = cycles.at(-1) ?? 0;
  const lastCompletedPhase = lastCycle > 0 ? completedByCycle[lastCycle]?.at(-1) : undefined;
  const nextExpectedPhase = nextPhaseAfter(workflow, lastCompletedPhase);
  return {
    workflow,
    completedByCycle,
    lastCycle,
    lastCompletedPhase,
    nextExpectedPhase,
    invalidTransitions
  };
}

function validatePhaseCompletionSafely(input: {
  ledger: Ledger;
  runId: string;
  workflow: Workflow;
  phase: string;
  cycle: number;
  payload: Record<string, unknown>;
  artifactIds: string[];
}): PhaseContractValidation {
  try {
    return validatePhaseCompletion(input);
  } catch (error) {
    return {
      ok: false,
      failures: [error instanceof Error ? error.message : String(error)]
    };
  }
}

export function isPhaseJob(job: WorkerJob): job is WorkerJob<PhaseJobPayload> {
  return job.kind === "workflow.phase" && typeof job.payload.phase === "string";
}

export function isBranchJob(job: WorkerJob): job is WorkerJob<BranchJobPayload> {
  return job.kind === "workflow.branch" && typeof job.payload.phase === "string";
}

export function isResearchJob(job: WorkerJob): job is WorkerJob<ResearchJobPayload> {
  return (
    (job.kind === "research.arxiv" && job.payload.provider === "arxiv") ||
    (job.kind === "research.mathlib" && job.payload.provider === "mathlib")
  ) && typeof job.payload.query === "string";
}

const PFLK_CONTRACTS: WorkflowPhaseContract[] = [
  phase("pflk", "problem", 1, false, {
    inputs: ["run.problem", "run.goal", "successCriteria"],
    tools: ["artifact-store"],
    checks: ["problem-classification"],
    budget: ["none"],
    next: ["feedback"],
    gates: ["problem statement persisted"],
    outputs: ["normalized problem statement"]
  }),
  phase("pflk", "feedback", 2, false, {
    inputs: ["problem.summary"],
    tools: ["arxiv"],
    checks: ["citation-validation", "retrieval-evaluation"],
    budget: ["elapsedMs"],
    next: ["loophole"],
    gates: ["arXiv research job scheduled"],
    outputs: ["source query", "citation provenance"]
  }),
  phase("pflk", "loophole", 3, true, {
    inputs: ["problem.summary", "feedback.sources"],
    tools: ["ai-sdk", "sandbox", "counterexample-search"],
    checks: ["falsifiable-claim-required", "counterexample-pressure"],
    budget: ["attempt", "tokens", "usd", "elapsedMs"],
    next: ["knowledge"],
    gates: ["branch jobs scheduled", "falsifiable claims required from branches", "assumption-delta review required"],
    outputs: ["falsifiable claim candidates", "explicit assumption/quantifier/domain deltas", "counterexample search plan"]
  }),
  phase("pflk", "knowledge", 4, false, {
    inputs: ["loophole.branch.results", "rejected evidence", "conjectural evidence"],
    tools: ["artifact-store"],
    checks: ["nonterminal-evidence-policy"],
    budget: ["none"],
    next: [],
    gates: ["conjectural and rejected evidence consolidated without goal success"],
    outputs: ["knowledge consolidation"]
  })
];

const GREE_CONTRACTS: WorkflowPhaseContract[] = [
  phase("gree", "gather", 1, false, {
    inputs: ["run.problem", "run.goal"],
    tools: ["arxiv"],
    checks: ["citation-validation", "retrieval-evaluation"],
    budget: ["elapsedMs"],
    next: ["refine"],
    gates: ["arXiv research job scheduled"],
    outputs: ["source query", "citation provenance"]
  }),
  phase("gree", "refine", 2, false, {
    inputs: ["gather.sources", "run.goal"],
    tools: ["artifact-store"],
    checks: ["problem-refinement"],
    budget: ["none"],
    next: ["experiment"],
    gates: ["refined hypothesis persisted"],
    outputs: ["refined problem frame"]
  }),
  phase("gree", "experiment", 3, true, {
    inputs: ["refined problem frame"],
    tools: ["ai-sdk", "sandbox", "verifier"],
    checks: ["executable-experiment-required", "reproducibility-manifest"],
    budget: ["attempt", "tokens", "usd", "elapsedMs"],
    next: ["evolve"],
    gates: ["branch jobs scheduled", "executable experiments required from branches"],
    outputs: ["executable experiment candidates", "reproducibility manifest"]
  }),
  phase("gree", "evolve", 4, false, {
    inputs: ["experiment.branch.results", "rejected evidence", "conjectural evidence"],
    tools: ["tournament-ranking", "artifact-store"],
    checks: ["nonterminal-evidence-policy"],
    budget: ["none"],
    next: [],
    gates: ["experiment ranking persisted without goal success"],
    outputs: ["evolution ranking", "next mutations"]
  })
];

function phase(
  workflow: Workflow,
  name: WorkflowPhaseName,
  order: number,
  fanout: boolean,
  spec: {
    inputs: string[];
    tools: string[];
    checks: string[];
    budget: WorkflowPhaseContract["budgetUse"];
    next: string[];
    gates: string[];
    outputs: string[];
  }
): WorkflowPhaseContract {
  return {
    version: "workflow-phase-contract-v1",
    workflow,
    name,
    order,
    fanout,
    inputs: spec.inputs,
    requiredArtifactKinds: [`phase.${name}.summary`],
    allowedTools: spec.tools,
    verifierChecks: spec.checks,
    budgetUse: spec.budget,
    allowedNextPhases: spec.next,
    failureStates: ["blocked", "budget_exhausted", "needs_human_review"],
    gates: spec.gates,
    outputRequirements: spec.outputs
  };
}

function previousCompletedPhase(events: LedgerEvent[], workflow: Workflow, cycle: number, order: number): string | undefined {
  const completed = events
    .filter((event) =>
      event.type === "phase.completed" &&
      event.payload.workflow === workflow &&
      Number(event.payload.cycle ?? 1) === cycle &&
      typeof event.payload.phase === "string"
    )
    .filter((event) => workflowPhaseContract(workflow, String(event.payload.phase)).order < order)
    .sort((a, b) =>
      workflowPhaseContract(workflow, String(a.payload.phase)).order -
      workflowPhaseContract(workflow, String(b.payload.phase)).order
    );
  return completed.at(-1)?.payload.phase as string | undefined;
}

function nextPhaseAfter(workflow: Workflow, phaseName: string | undefined): string | undefined {
  if (!phaseName) return workflowPhaseContracts(workflow)[0]?.name;
  return workflowPhaseContract(workflow, phaseName).allowedNextPhases[0];
}

function pass(): PhaseContractValidation {
  return { ok: true, failures: [] };
}

function fail(reason: string): PhaseContractValidation {
  return { ok: false, failures: [reason] };
}

function validatePhaseOutputManifest(input: {
  workflow: Workflow;
  phase: string;
  cycle: number;
  contract: WorkflowPhaseContract;
  payload: Record<string, unknown>;
  artifacts: Artifact[];
}): string[] {
  const failures: string[] = [];
  const summaryArtifactId = stringValue(input.payload.summaryArtifactId);
  if (!summaryArtifactId) failures.push(`phase ${input.phase} missing summaryArtifactId`);
  const summaryArtifact = summaryArtifactId
    ? input.artifacts.find((artifact) => artifact.id === summaryArtifactId)
    : input.artifacts.find((artifact) => artifact.kind === `phase.${input.phase}.summary`);
  if (!summaryArtifact) {
    failures.push(`phase ${input.phase} missing linked summary artifact`);
    return failures;
  }

  const artifactRecord = readJsonArtifact(summaryArtifact, failures);
  const artifactManifest = isRecord(artifactRecord?.outputManifest) ? artifactRecord.outputManifest : undefined;
  const payloadManifest = isRecord(input.payload.outputManifest) ? input.payload.outputManifest : undefined;
  if (!artifactManifest || !payloadManifest) {
    failures.push(`phase ${input.phase} missing outputManifest`);
    return failures;
  }
  if (stableHash(artifactManifest) !== stableHash(payloadManifest)) {
    failures.push(`phase ${input.phase} artifact outputManifest drift`);
  }

  for (const [source, manifest] of [["payload", payloadManifest], ["artifact", artifactManifest]] as const) {
    if (manifest.schemaVersion !== "workflow-phase-output-v1") {
      failures.push(`phase ${input.phase} ${source} outputManifest has invalid schemaVersion`);
    }
    if (manifest.workflow !== input.workflow) failures.push(`phase ${input.phase} ${source} outputManifest workflow drift`);
    if (manifest.phase !== input.phase) failures.push(`phase ${input.phase} ${source} outputManifest phase drift`);
    if (Number(manifest.cycle) !== input.cycle) failures.push(`phase ${input.phase} ${source} outputManifest cycle drift`);
    if (!stringValue(manifest.phaseJobId)) failures.push(`phase ${input.phase} ${source} outputManifest missing phaseJobId`);
    if (!stringValue(manifest.workerRole)) failures.push(`phase ${input.phase} ${source} outputManifest missing workerRole`);
    if (!isPromptLineage(manifest.promptLineage)) failures.push(`phase ${input.phase} ${source} outputManifest missing prompt lineage`);
    if (!isProviderRoute(manifest.providerRoute)) failures.push(`phase ${input.phase} ${source} outputManifest missing provider route`);
    failures.push(...validatePhaseProgression({
      workflow: input.workflow,
      phase: input.phase,
      cycle: input.cycle,
      source,
      contract: input.contract,
      progression: manifest.progression
    }));
    const artifactIds = Array.isArray(manifest.artifactIds) ? manifest.artifactIds : [];
    if (!artifactIds.includes(summaryArtifact.id)) {
      failures.push(`phase ${input.phase} ${source} outputManifest does not link summary artifact`);
    }
    const decision = isRecord(manifest.nextCycleDecision) ? manifest.nextCycleDecision : undefined;
    if (!decision) {
      failures.push(`phase ${input.phase} ${source} outputManifest missing next-cycle decision`);
    } else if (input.contract.allowedNextPhases.length > 0) {
      if (decision.action !== "next_phase" || !input.contract.allowedNextPhases.includes(String(decision.nextPhase))) {
        failures.push(`phase ${input.phase} ${source} outputManifest has invalid next phase decision`);
      }
    } else if (decision.action !== "next_cycle") {
      failures.push(`phase ${input.phase} ${source} outputManifest must link to next cycle`);
    }
  }
  return failures;
}

function validatePhaseProgression(input: {
  workflow: Workflow;
  phase: string;
  cycle: number;
  source: "payload" | "artifact";
  contract: WorkflowPhaseContract;
  progression: unknown;
}): string[] {
  const failures: string[] = [];
  const progression = isRecord(input.progression) ? input.progression : undefined;
  if (!progression) return [`phase ${input.phase} ${input.source} outputManifest missing progression record`];
  if (progression.schemaVersion !== "workflow-phase-progression-v1") {
    failures.push(`phase ${input.phase} ${input.source} progression has invalid schemaVersion`);
  }
  if (progression.workflow !== input.workflow) failures.push(`phase ${input.phase} ${input.source} progression workflow drift`);
  if (progression.phase !== input.phase) failures.push(`phase ${input.phase} ${input.source} progression phase drift`);
  if (Number(progression.cycle) !== input.cycle) failures.push(`phase ${input.phase} ${input.source} progression cycle drift`);
  if (!stringValue(progression.inputStateHash)) failures.push(`phase ${input.phase} ${input.source} progression missing inputStateHash`);
  if (!stringValue(progression.changedFromPriorCycle)) failures.push(`phase ${input.phase} ${input.source} progression missing changedFromPriorCycle`);
  if (arrayOfStrings(progression.changedDimensions).length === 0) {
    failures.push(`phase ${input.phase} ${input.source} progression must record changed dimensions`);
  }
  if (!Array.isArray(progression.promotionDecisions)) {
    failures.push(`phase ${input.phase} ${input.source} progression missing promotion decisions`);
  }
  if (!Array.isArray(progression.pruningDecisions)) {
    failures.push(`phase ${input.phase} ${input.source} progression missing pruning decisions`);
  }
  const suppressionRules = Array.isArray(progression.suppressionRules) ? progression.suppressionRules : [];
  if (suppressionRules.length === 0) {
    failures.push(`phase ${input.phase} ${input.source} progression must record dead-end suppression rules`);
  }
  const promptInfluence = isRecord(progression.promptInfluence) ? progression.promptInfluence : undefined;
  if (!promptInfluence) {
    failures.push(`phase ${input.phase} ${input.source} progression missing promptInfluence`);
  } else {
    const influenceSource = stringValue(promptInfluence.source);
    if (!influenceSource) failures.push(`phase ${input.phase} ${input.source} progression promptInfluence missing source`);
    if (!stringValue(promptInfluence.mutationId)) failures.push(`phase ${input.phase} ${input.source} progression promptInfluence missing mutationId`);
    if (arrayOfStrings(promptInfluence.appliedTo).length === 0) {
      failures.push(`phase ${input.phase} ${input.source} progression promptInfluence must name affected surfaces`);
    }
    if (input.cycle > 1) {
      const sourcePlanHash = stringValue(progression.sourcePlanHash);
      if (!sourcePlanHash) failures.push(`phase ${input.phase} ${input.source} progression missing sourcePlanHash for cycle ${input.cycle}`);
      if (influenceSource !== "workflow.next_cycle.planned") {
        failures.push(`phase ${input.phase} ${input.source} progression must be driven by workflow.next_cycle.planned after cycle 1`);
      }
      if (stringValue(promptInfluence.sourcePlanHash) !== sourcePlanHash) {
        failures.push(`phase ${input.phase} ${input.source} progression promptInfluence sourcePlanHash drift`);
      }
    }
  }
  if (input.contract.allowedNextPhases.length === 0) {
    const nextCycleImpact = isRecord(progression.nextCyclePlanImpact) ? progression.nextCyclePlanImpact : undefined;
    if (!nextCycleImpact || nextCycleImpact.required !== true || Number(nextCycleImpact.targetCycle) !== input.cycle + 1) {
      failures.push(`phase ${input.phase} ${input.source} progression must require a target next-cycle plan`);
    }
  }
  return failures;
}

function readJsonArtifact(artifact: Artifact, failures: string[]): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(readArtifactText(artifact)) as unknown;
    if (isRecord(value)) return value;
    failures.push(`artifact ${artifact.id} does not contain a JSON object`);
  } catch (error) {
    failures.push(`artifact ${artifact.id} is not readable JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return undefined;
}

function isPromptLineage(value: unknown): value is Record<string, unknown> {
  return isRecord(value) &&
    stringValue(value.source) !== undefined &&
    stringValue(value.problemHash) !== undefined &&
    stringValue(value.goalHash) !== undefined;
}

function isProviderRoute(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && stringValue(value.provider) !== undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}
