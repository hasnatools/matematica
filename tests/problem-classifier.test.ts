import { expect, test } from "bun:test";
import { ALLOWED_FINAL_ANSWER_STATES } from "../src/outcome";
import { canClaimSolvedForProblemClass, classifyProblem, reviewProblemClassification } from "../src/problem-classifier";

test("classifyProblem detects open conjecture and Erdos-style prompts", () => {
  for (const problem of [
    "Prove the Riemann hypothesis",
    "Solve this open problem about Erdős discrepancy",
    "Find a proof of the Collatz conjecture",
    "Settle P vs NP"
  ]) {
    const classification = classifyProblem(problem, "Find a solution");
    expect(classification.class).toBe("open_problem");
    expect(classification.triggers.length).toBeGreaterThan(0);
  }
});

test("classifyProblem fails closed for disguised and weakly worded hard math prompts", () => {
  const prompts = [
    [
      "disguised-goldbach",
      "Show that every even integer greater than 2 can be written as the sum of two primes."
    ],
    [
      "disguised-collatz",
      "Prove the 3n + 1 process always reaches 1 for every positive integer."
    ],
    [
      "disguised-riemann",
      "Prove all nontrivial zeros of the zeta function have real part 1/2."
    ],
    [
      "erdos-style",
      "Make progress on the distinct distances problem in the plane."
    ],
    [
      "weak-open-language",
      "Can you make progress on a long-standing research-level question about prime gaps?"
    ]
  ] as const;

  for (const [expectedTrigger, problem] of prompts) {
    const classification = classifyProblem(problem, "Produce verified computation");
    expect(classification.class).toBe("open_problem");
    expect(classification.triggers).toContain(expectedTrigger);
    expect(canClaimSolvedForProblemClass(classification, "verified_computation")).toBe(false);
    expect(canClaimSolvedForProblemClass(classification, "formal_proof")).toBe(true);
    expect(canClaimSolvedForProblemClass(classification, "verified_counterexample")).toBe(true);
  }
});

test("open problem policy only accepts formal proof or verified counterexample", () => {
  const classification = classifyProblem("Open problem: prove a famous conjecture");
  expect(canClaimSolvedForProblemClass(classification, "verified_computation")).toBe(false);
  expect(canClaimSolvedForProblemClass(classification, "literature_backed_reduction")).toBe(false);
  expect(canClaimSolvedForProblemClass(classification, "conjectural_solution")).toBe(false);
  expect(canClaimSolvedForProblemClass(classification, "formal_proof")).toBe(true);
  expect(canClaimSolvedForProblemClass(classification, "verified_counterexample")).toBe(true);
});

test("standard problems can use ordinary verifier-backed evidence policy", () => {
  const classification = classifyProblem("Prove 1 + 1 = 2");
  expect(classification.class).toBe("standard_problem");
  expect(canClaimSolvedForProblemClass(classification, "verified_computation")).toBe(true);
  expect(canClaimSolvedForProblemClass(classification, "formal_proof")).toBe(true);
  expect(canClaimSolvedForProblemClass(classification, "verified_counterexample")).toBe(true);
  expect(canClaimSolvedForProblemClass(classification, "literature_backed_reduction")).toBe(false);
  expect(canClaimSolvedForProblemClass(classification, "conjectural_solution")).toBe(false);
  expect(canClaimSolvedForProblemClass(classification, "heuristic_evidence")).toBe(false);
});

test("classification review covers false positives false negatives and conservative overrides", () => {
  const toyExercise = reviewProblemClassification({
    problem: "Prove 1 + 1 = 2",
    goal: "Find verified computation",
    reviewedAt: "2026-05-25T00:00:00.000Z"
  });
  expect(toyExercise.classification.class).toBe("standard_problem");

  const knownConjecture = reviewProblemClassification({
    problem: "Find a proof of the Collatz conjecture",
    goal: "Solve it",
    reviewedAt: "2026-05-25T00:00:00.000Z"
  });
  expect(knownConjecture.classification.class).toBe("open_problem");

  const ambiguousTightened = reviewProblemClassification({
    problem: "Investigate a new recurrence pattern",
    goal: "Find verified computation",
    override: "open_problem",
    reviewedAt: "2026-05-25T00:00:00.000Z"
  });
  expect(ambiguousTightened.heuristic.class).toBe("standard_problem");
  expect(ambiguousTightened.classification.class).toBe("open_problem");
  expect(ambiguousTightened.override?.accepted).toBe(true);

  const rejectedRelaxation = reviewProblemClassification({
    problem: "Show that every even integer greater than 2 can be written as the sum of two primes.",
    goal: "Find verified computation",
    override: "standard_problem",
    reviewedAt: "2026-05-25T00:00:00.000Z"
  });
  expect(rejectedRelaxation.heuristic.class).toBe("open_problem");
  expect(rejectedRelaxation.classification.class).toBe("open_problem");
  expect(rejectedRelaxation.override).toMatchObject({
    requestedClass: "standard_problem",
    accepted: false
  });
  expect(rejectedRelaxation.reviewHash).toMatch(/^[a-f0-9]{64}$/);
});

test("final answer state vocabulary avoids solved language", () => {
  expect(ALLOWED_FINAL_ANSWER_STATES).toEqual([
    "formal_proof",
    "counterexample",
    "computational_evidence",
    "conjecture",
    "heuristic",
    "partial",
    "inconclusive",
    "budget_exhausted",
    "cancelled",
    "failed"
  ]);
  expect(ALLOWED_FINAL_ANSWER_STATES.join(" ")).not.toContain("solved");
});
