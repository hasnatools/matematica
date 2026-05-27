import type { EvidenceGrade } from "./domain";
import type { ArtifactStore } from "./artifacts";
import { nowIso, type GoalRun, type LedgerEvent } from "./domain";
import { stableHash } from "./idempotency";
import type { Ledger } from "./ledger";
import { canEvidenceMarkGoalMetUnderPolicy } from "./success-semantics";

export type ProblemClass =
  | "open_problem"
  | "standard_problem";

export const PROBLEM_CLASSIFICATION_REVIEW_VERSION = 1;

const OPEN_PROBLEM_PATTERNS: Array<{ id: string; pattern: RegExp }> = [
  { id: "explicit-open-problem", pattern: /\bopen problem\b/i },
  { id: "explicit-unsolved", pattern: /\bunsolved\b/i },
  { id: "explicit-conjecture", pattern: /\bconjecture\b/i },
  { id: "erdos", pattern: /\berd[oő]s\b/i },
  { id: "riemann-hypothesis", pattern: /\briemann hypothesis\b/i },
  { id: "goldbach", pattern: /\bgoldbach\b/i },
  { id: "collatz", pattern: /\bcollatz\b/i },
  { id: "twin-prime", pattern: /\btwin prime\b/i },
  { id: "p-vs-np", pattern: /\bp vs\.? np\b/i },
  { id: "birch-swinnerton-dyer", pattern: /\bbirch (and|&) swinnerton-dyer\b/i },
  { id: "hodge-conjecture", pattern: /\bhodge conjecture\b/i },
  { id: "navier-stokes", pattern: /\bnavier[-\s]stokes\b/i },
  { id: "disguised-goldbach", pattern: /\bevery even (integer|number)( greater than 2| > 2)?\b[\s\S]{0,160}\bsum of two primes\b/i },
  { id: "disguised-goldbach", pattern: /\bsum of two primes\b[\s\S]{0,160}\bevery even (integer|number)\b/i },
  { id: "disguised-collatz", pattern: /\b3\s*n\s*\+\s*1\b/i },
  { id: "disguised-collatz", pattern: /\bhailstone sequence\b/i },
  { id: "disguised-riemann", pattern: /\b(non[-\s]?trivial zeros?|zeros?)\b[\s\S]{0,120}\bzeta\b[\s\S]{0,160}\b(real part\s*(1\/2|one half)|critical line)\b/i },
  { id: "disguised-riemann", pattern: /\bzeta\b[\s\S]{0,120}\b(non[-\s]?trivial zeros?|zeros?)\b[\s\S]{0,160}\b(real part\s*(1\/2|one half)|critical line)\b/i },
  { id: "erdos-style", pattern: /\bdistinct distances problem\b/i },
  { id: "erdos-style", pattern: /\bunit distances problem\b/i },
  { id: "weak-open-language", pattern: /\b(no known proof|without known proof|open in the literature|appears open|seems open)\b/i },
  { id: "weak-open-language", pattern: /\b(long[-\s]?standing|research[-\s]?level|frontier|publishable|famous)\b[\s\S]{0,120}\b(problem|question|conjecture)\b/i },
  { id: "weak-open-language", pattern: /\b(problem|question|conjecture)\b[\s\S]{0,120}\b(long[-\s]?standing|research[-\s]?level|frontier|publishable|famous)\b/i },
  { id: "weak-open-language", pattern: /\bmake progress on\b[\s\S]{0,120}\b(problem|question|conjecture)\b/i }
];

export type ProblemClassification = {
  class: ProblemClass;
  triggers: string[];
};

export type ProblemClassificationOverride = {
  requestedClass: ProblemClass;
  accepted: boolean;
  reason: string;
};

export type ProblemClassificationReview = {
  format: "matematica.problem-classification-review";
  version: 1;
  runId?: string;
  problemHash: string;
  goalHash: string;
  reviewedAt: string;
  reviewer: string;
  heuristic: ProblemClassification;
  override?: ProblemClassificationOverride;
  classification: ProblemClassification;
  policy: {
    openProblemSolvedRequires: ["formal_proof", "verified_counterexample"];
    overrideCannotRelaxOpenProblem: true;
  };
  reviewHash: string;
};

export function classifyProblem(problem: string, goal = ""): ProblemClassification {
  const text = `${problem}\n${goal}`;
  const triggers = OPEN_PROBLEM_PATTERNS
    .filter(({ pattern }) => pattern.test(text))
    .map(({ id }) => id);
  return {
    class: triggers.length > 0 ? "open_problem" : "standard_problem",
    triggers: [...new Set(triggers)]
  };
}

export function reviewProblemClassification(input: {
    problem: string;
    goal?: string;
    override?: ProblemClass;
    runId?: string;
  reviewer?: string;
  reviewedAt?: string;
}): ProblemClassificationReview {
  const heuristic = classifyProblem(input.problem, input.goal ?? "");
  const override = input.override ? evaluateOverride(heuristic, input.override) : undefined;
  const classification = override?.accepted
    ? { class: override.requestedClass, triggers: [...heuristic.triggers, `override:${override.requestedClass}`] }
    : heuristic;
  const unsigned = {
    format: "matematica.problem-classification-review" as const,
    version: PROBLEM_CLASSIFICATION_REVIEW_VERSION as 1,
    runId: input.runId,
    problemHash: stableHash(input.problem),
    goalHash: stableHash(input.goal ?? ""),
    reviewedAt: input.reviewedAt ?? nowIso(),
    reviewer: input.reviewer ?? "deterministic-problem-classifier-v2",
    heuristic,
    override,
    classification,
    policy: {
      openProblemSolvedRequires: ["formal_proof", "verified_counterexample"] as ["formal_proof", "verified_counterexample"],
      overrideCannotRelaxOpenProblem: true as const
    }
  };
  return {
    ...unsigned,
    reviewHash: stableHash(unsigned)
  };
}

export function persistProblemClassificationReview(input: {
  run: GoalRun;
  ledger: Ledger;
  artifacts: ArtifactStore;
  override?: ProblemClass;
  reviewer?: string;
}): ProblemClassificationReview {
  const existing = latestProblemClassificationReview(input.ledger.listEvents(input.run.id));
  if (existing && input.override === undefined) return existing;
  const review = reviewProblemClassification({
    problem: input.run.problem,
    goal: input.run.goal,
    override: input.override,
    runId: input.run.id,
    reviewer: input.reviewer
  });
  const artifact = input.artifacts.create(input.run.id, "problem.classification.review", JSON.stringify(review, null, 2));
  input.ledger.appendEvent(input.run.id, "problem.classification.reviewed", {
    ...review,
    artifactId: artifact.id
  }, [artifact.id]);
  return review;
}

export function latestProblemClassificationReview(events: LedgerEvent[]): ProblemClassificationReview | undefined {
  const event = [...events].reverse().find((item) => item.type === "problem.classification.reviewed");
  if (!event) return undefined;
  const payload = event.payload;
  if (!isProblemClassificationReview(payload)) return undefined;
  return {
    ...payload,
    runId: typeof payload.runId === "string" ? payload.runId : undefined
  };
}

export function classificationForRun(run: GoalRun, events: LedgerEvent[] = []): ProblemClassification {
  const review = latestProblemClassificationReview(events);
  if (review && review.problemHash === stableHash(run.problem) && review.goalHash === stableHash(run.goal)) {
    return review.classification;
  }
  return classifyProblem(run.problem, run.goal);
}

export function canClaimSolvedForProblemClass(classification: ProblemClassification, evidenceGrade: EvidenceGrade): boolean {
  return canEvidenceMarkGoalMetUnderPolicy(classification, evidenceGrade);
}

function evaluateOverride(heuristic: ProblemClassification, requestedClass: ProblemClass): ProblemClassificationOverride {
  if (heuristic.class === "open_problem" && requestedClass === "standard_problem") {
    return {
      requestedClass,
      accepted: false,
      reason: "override rejected because it would relax open-problem verifier requirements"
    };
  }
  if (heuristic.class === requestedClass) {
    return {
      requestedClass,
      accepted: true,
      reason: "override agrees with deterministic classification"
    };
  }
  return {
    requestedClass,
    accepted: true,
    reason: "override tightens verifier requirements for an ambiguous or standard prompt"
  };
}

function isProblemClassificationReview(value: unknown): value is ProblemClassificationReview {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const classification = record.classification as Record<string, unknown> | undefined;
  const heuristic = record.heuristic as Record<string, unknown> | undefined;
  return record.format === "matematica.problem-classification-review" &&
    record.version === PROBLEM_CLASSIFICATION_REVIEW_VERSION &&
    typeof record.problemHash === "string" &&
    typeof record.goalHash === "string" &&
    typeof record.reviewedAt === "string" &&
    typeof record.reviewer === "string" &&
    isClassification(heuristic) &&
    isClassification(classification) &&
    typeof record.reviewHash === "string";
}

function isClassification(value: unknown): value is ProblemClassification {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (record.class === "open_problem" || record.class === "standard_problem") &&
    Array.isArray(record.triggers) &&
    record.triggers.every((item) => typeof item === "string");
}
