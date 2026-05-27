import type { Budget, GoalRun } from "./domain";

export type BudgetUsage = {
  attempts: number;
  tokens: number;
  usd: number;
  elapsedMs: number;
  artifactBytes: number;
  sourceQueries: number;
  retries: number;
  sandboxMs: number;
};

export type BudgetCheck = {
  ok: boolean;
  reason?: string;
};

export type BudgetHardCaps = {
  provider?: Partial<BudgetUsage>;
  phase?: Partial<BudgetUsage>;
  daily?: Partial<BudgetUsage>;
  global?: Partial<BudgetUsage>;
};

export type BudgetCapScope = keyof BudgetHardCaps;

export type BudgetDimension = keyof BudgetUsage;

export type BudgetSettlementState =
  | "reserved"
  | "committed"
  | "released"
  | "failed"
  | "estimated";

export type BudgetContract = {
  format: "matematica.budget-contract";
  version: 1;
  run: Budget;
  hardCaps: BudgetHardCaps;
  dimensions: BudgetDimension[];
  settlementStates: BudgetSettlementState[];
  requiredLeaseBefore: string[];
};

export const BUDGET_DIMENSIONS: BudgetDimension[] = [
  "attempts",
  "tokens",
  "usd",
  "elapsedMs",
  "artifactBytes",
  "sourceQueries",
  "retries",
  "sandboxMs"
];

export const BUDGET_SETTLEMENT_STATES: BudgetSettlementState[] = [
  "reserved",
  "committed",
  "released",
  "failed",
  "estimated"
];

export function buildBudgetContract(runBudget: Budget, hardCaps: BudgetHardCaps = {}): BudgetContract {
  return {
    format: "matematica.budget-contract",
    version: 1,
    run: runBudget,
    hardCaps,
    dimensions: BUDGET_DIMENSIONS,
    settlementStates: BUDGET_SETTLEMENT_STATES,
    requiredLeaseBefore: [
      "ai.generateText",
      "source.arxiv",
      "verifier.lean",
      "verifier.local",
      "worker.job",
      "sandbox.experiment",
      "tool.execution"
    ]
  };
}

export function checkBudget(run: GoalRun, usage: BudgetUsage, reserve: Partial<BudgetUsage> = {}): BudgetCheck {
  const budget: Budget = run.budget;
  const attempts = usage.attempts + (reserve.attempts ?? 0);
  const tokens = usage.tokens + (reserve.tokens ?? 0);
  const usd = usage.usd + (reserve.usd ?? 0);
  const elapsedMs = usage.elapsedMs + (reserve.elapsedMs ?? 0);
  const artifactBytes = usage.artifactBytes + (reserve.artifactBytes ?? 0);
  const sourceQueries = usage.sourceQueries + (reserve.sourceQueries ?? 0);
  const retries = usage.retries + (reserve.retries ?? 0);
  const sandboxMs = usage.sandboxMs + (reserve.sandboxMs ?? 0);

  if (budget.maxAttempts !== undefined && attempts > budget.maxAttempts) {
    return { ok: false, reason: `attempts budget exceeded (${attempts}/${budget.maxAttempts})` };
  }
  if (budget.maxTokens !== undefined && tokens > budget.maxTokens) {
    return { ok: false, reason: `tokens budget exceeded (${tokens}/${budget.maxTokens})` };
  }
  if (budget.maxUsd !== undefined && usd > budget.maxUsd) {
    return { ok: false, reason: `usd budget exceeded (${usd}/${budget.maxUsd})` };
  }
  if (budget.maxWallTimeMs !== undefined && elapsedMs > budget.maxWallTimeMs) {
    return { ok: false, reason: `elapsedMs budget exceeded (${elapsedMs}/${budget.maxWallTimeMs})` };
  }
  if (budget.maxArtifactBytes !== undefined && artifactBytes > budget.maxArtifactBytes) {
    return { ok: false, reason: `artifactBytes budget exceeded (${artifactBytes}/${budget.maxArtifactBytes})` };
  }
  if (budget.maxSourceQueries !== undefined && sourceQueries > budget.maxSourceQueries) {
    return { ok: false, reason: `sourceQueries budget exceeded (${sourceQueries}/${budget.maxSourceQueries})` };
  }
  if (budget.maxRetries !== undefined && retries > budget.maxRetries) {
    return { ok: false, reason: `retries budget exceeded (${retries}/${budget.maxRetries})` };
  }
  if (budget.maxSandboxMs !== undefined && sandboxMs > budget.maxSandboxMs) {
    return { ok: false, reason: `sandboxMs budget exceeded (${sandboxMs}/${budget.maxSandboxMs})` };
  }
  return { ok: true };
}

export function checkBudgetHardCap(
  scope: BudgetCapScope,
  cap: Partial<BudgetUsage> | undefined,
  usage: BudgetUsage,
  reserve: Partial<BudgetUsage> = {}
): BudgetCheck {
  if (!cap) return { ok: true };
  const attempts = usage.attempts + (reserve.attempts ?? 0);
  const tokens = usage.tokens + (reserve.tokens ?? 0);
  const usd = usage.usd + (reserve.usd ?? 0);
  const elapsedMs = usage.elapsedMs + (reserve.elapsedMs ?? 0);
  const artifactBytes = usage.artifactBytes + (reserve.artifactBytes ?? 0);
  const sourceQueries = usage.sourceQueries + (reserve.sourceQueries ?? 0);
  const retries = usage.retries + (reserve.retries ?? 0);
  const sandboxMs = usage.sandboxMs + (reserve.sandboxMs ?? 0);
  if (cap.attempts !== undefined && attempts > cap.attempts) {
    return { ok: false, reason: `${scope} attempts budget exceeded (${attempts}/${cap.attempts})` };
  }
  if (cap.tokens !== undefined && tokens > cap.tokens) {
    return { ok: false, reason: `${scope} tokens budget exceeded (${tokens}/${cap.tokens})` };
  }
  if (cap.usd !== undefined && usd > cap.usd) {
    return { ok: false, reason: `${scope} usd budget exceeded (${usd}/${cap.usd})` };
  }
  if (cap.elapsedMs !== undefined && elapsedMs > cap.elapsedMs) {
    return { ok: false, reason: `${scope} elapsedMs budget exceeded (${elapsedMs}/${cap.elapsedMs})` };
  }
  if (cap.artifactBytes !== undefined && artifactBytes > cap.artifactBytes) {
    return { ok: false, reason: `${scope} artifactBytes budget exceeded (${artifactBytes}/${cap.artifactBytes})` };
  }
  if (cap.sourceQueries !== undefined && sourceQueries > cap.sourceQueries) {
    return { ok: false, reason: `${scope} sourceQueries budget exceeded (${sourceQueries}/${cap.sourceQueries})` };
  }
  if (cap.retries !== undefined && retries > cap.retries) {
    return { ok: false, reason: `${scope} retries budget exceeded (${retries}/${cap.retries})` };
  }
  if (cap.sandboxMs !== undefined && sandboxMs > cap.sandboxMs) {
    return { ok: false, reason: `${scope} sandboxMs budget exceeded (${sandboxMs}/${cap.sandboxMs})` };
  }
  return { ok: true };
}

export function emptyUsage(): BudgetUsage {
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
