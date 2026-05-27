import type { ArtifactStore } from "./artifacts";
import type { Artifact, LedgerEvent } from "./domain";
import type { Ledger, StoredScore } from "./ledger";

export type GoalProgressState = "improving" | "stagnating" | "terminal";

export type GoalProgressMetrics = {
  cycle: number;
  bestEvidenceScore: number;
  previousBestEvidenceScore: number;
  scoreDelta: number;
  distinctClaimIds: string[];
  newClaimIds: string[];
  distinctSourceHashes: string[];
  newSourceHashes: string[];
  proofReviewCount: number;
  knowledgeCount: number;
  artifactCount: number;
};

export type StagnationPolicy = {
  windowCycles: number;
  minScoreDelta: number;
  requireNewClaimOrSource: boolean;
  terminalAction: "continue_until_budget" | "diversify_or_escalate";
};

export type GoalProgressReview = {
  format: "matematica.goal-progress.review";
  version: 1;
  cycle: number;
  state: GoalProgressState;
  stagnantCycles: number;
  progressSignal: boolean;
  metrics: GoalProgressMetrics;
  policy: StagnationPolicy;
  nextAction: "continue" | "continue_until_budget" | "diversify_or_escalate" | "terminal_no_action";
  reason: string;
};

export const DEFAULT_STAGNATION_POLICY: StagnationPolicy = {
  windowCycles: 2,
  minScoreDelta: 0.01,
  requireNewClaimOrSource: true,
  terminalAction: "diversify_or_escalate"
};

export function reviewGoalProgress(input: {
  cycle: number;
  runStatus: string;
  events: LedgerEvent[];
  artifacts: Artifact[];
  scores: StoredScore[];
  policy?: Partial<StagnationPolicy>;
}): GoalProgressReview {
  const policy = { ...DEFAULT_STAGNATION_POLICY, ...input.policy };
  const previousReviews = input.events
    .filter((event) => event.type === "goal.progress.reviewed" && isRecord(event.payload.review))
    .map((event) => event.payload.review as GoalProgressReview);
  const previous = previousReviews.at(-1);
  const bestEvidenceScore = roundScore(Math.max(0, ...input.scores.map((score) => score.score)));
  const previousBestEvidenceScore = previous?.metrics.bestEvidenceScore ?? 0;
  const scoreDelta = roundScore(bestEvidenceScore - previousBestEvidenceScore);
  const distinctClaimIds = distinctStrings(input.events.flatMap((event) => claimIdsFromEvent(event)));
  const previousClaimIds = new Set(previous?.metrics.distinctClaimIds ?? []);
  const newClaimIds = distinctClaimIds.filter((claimId) => !previousClaimIds.has(claimId));
  const distinctSourceHashes = distinctStrings(input.events.flatMap((event) => sourceHashesFromEvent(event)));
  const previousSourceHashes = new Set(previous?.metrics.distinctSourceHashes ?? []);
  const newSourceHashes = distinctSourceHashes.filter((hash) => !previousSourceHashes.has(hash));
  const metrics: GoalProgressMetrics = {
    cycle: input.cycle,
    bestEvidenceScore,
    previousBestEvidenceScore,
    scoreDelta,
    distinctClaimIds,
    newClaimIds,
    distinctSourceHashes,
    newSourceHashes,
    proofReviewCount: input.events.filter((event) => event.type === "proof.obligations.reviewed").length,
    knowledgeCount: input.events.filter((event) => event.type === "knowledge.conjecture.saved").length,
    artifactCount: input.artifacts.length
  };
  const terminal = isTerminalStatus(input.runStatus);
  const progressSignal = terminal
    ? false
    : scoreDelta >= policy.minScoreDelta ||
      newClaimIds.length > 0 ||
      newSourceHashes.length > 0 ||
      previous === undefined;
  const stagnantCycles = terminal
    ? previous?.stagnantCycles ?? 0
    : progressSignal
      ? 0
      : (previous?.stagnantCycles ?? 0) + 1;
  const state: GoalProgressState = terminal
    ? "terminal"
    : progressSignal
      ? "improving"
      : "stagnating";
  const nextAction = terminal
    ? "terminal_no_action"
    : stagnantCycles >= policy.windowCycles
      ? policy.terminalAction
      : "continue";
  return {
    format: "matematica.goal-progress.review",
    version: 1,
    cycle: input.cycle,
    state,
    stagnantCycles,
    progressSignal,
    metrics,
    policy,
    nextAction,
    reason: progressReason({ state, stagnantCycles, metrics, policy, nextAction })
  };
}

export function persistGoalProgressReview(input: {
  runId: string;
  cycle: number;
  ledger: Ledger;
  artifacts: ArtifactStore;
  policy?: Partial<StagnationPolicy>;
}): { review: GoalProgressReview; artifact: Artifact; event: LedgerEvent } {
  const run = input.ledger.requireRun(input.runId);
  const review = reviewGoalProgress({
    cycle: input.cycle,
    runStatus: run.status,
    events: input.ledger.listEvents(input.runId),
    artifacts: input.ledger.listArtifacts(input.runId),
    scores: input.ledger.listScores(input.runId),
    policy: input.policy
  });
  const artifact = input.artifacts.create(input.runId, "goal.progress.review", JSON.stringify(review, null, 2));
  const event = input.ledger.appendEvent(input.runId, "goal.progress.reviewed", {
    cycle: input.cycle,
    review,
    artifactId: artifact.id
  }, [artifact.id]);
  return { review, artifact, event };
}

function claimIdsFromEvent(event: LedgerEvent): string[] {
  return distinctStrings([
    stringValue(event.payload.claimId),
    isRecord(event.payload.claim) ? stringValue(event.payload.claim.id) : undefined,
    isRecord(event.payload.decision) ? stringValue(event.payload.decision.targetClaimId) : undefined
  ].filter((value): value is string => Boolean(value)));
}

function sourceHashesFromEvent(event: LedgerEvent): string[] {
  if (event.type !== "source.results") return [];
  const hashes = event.payload.sourceHashes ?? event.payload.contentHashes;
  if (Array.isArray(hashes)) return hashes.filter((item): item is string => typeof item === "string");
  return [];
}

function progressReason(input: {
  state: GoalProgressState;
  stagnantCycles: number;
  metrics: GoalProgressMetrics;
  policy: StagnationPolicy;
  nextAction: GoalProgressReview["nextAction"];
}): string {
  if (input.state === "terminal") return "run is terminal; progress review is informational";
  if (input.state === "improving") {
    return `progress signal found: scoreDelta=${input.metrics.scoreDelta}, newClaims=${input.metrics.newClaimIds.length}, newSources=${input.metrics.newSourceHashes.length}`;
  }
  if (input.nextAction === "diversify_or_escalate") {
    return `stagnation window reached after ${input.stagnantCycles} cycle(s); planner should diversify or escalate while respecting the budget`;
  }
  return `no progress signal this cycle; stagnantCycles=${input.stagnantCycles}/${input.policy.windowCycles}`;
}

function isTerminalStatus(status: string): boolean {
  return status === "goal_met" || status === "budget_exhausted" || status === "cancelled" || status === "failed";
}

function distinctStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))].sort();
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function roundScore(value: number): number {
  return Math.round(value * 1000) / 1000;
}
