import { expect, test } from "bun:test";
import { detectMathProblemFeatures, selectHardMathStrategy } from "../src/math-strategy";

test("hard-math strategy selector detects problem classes and chooses distinct tactic contracts", () => {
  const numberTheory = selectHardMathStrategy({
    problem: "Prove a theorem about prime gaps using congruences.",
    goal: "Find a proof route",
    workflow: "pflk",
    phase: "loophole",
    role: "loophole-search"
  });
  const combinatorics = selectHardMathStrategy({
    problem: "Prove every graph coloring has an extremal matching property.",
    goal: "Find a proof route",
    workflow: "pflk",
    phase: "loophole",
    role: "loophole-search"
  });

  expect(numberTheory.problemFeatures).toContain("number_theory");
  expect(numberTheory.selectedStrategyId).toBe("number-theory-modular-descent");
  expect(numberTheory.selectedTacticIds).toContain("modular-obstruction");
  expect(combinatorics.problemFeatures).toContain("combinatorics");
  expect(combinatorics.selectedStrategyId).toBe("combinatorics-extremal-invariant");
  expect(combinatorics.selectedTacticIds).toContain("extremal-object");
  expect(numberTheory.selectionHash).toMatch(/^[a-f0-9]{64}$/);
  expect(combinatorics.selectionHash).not.toBe(numberTheory.selectionHash);

  const geometry = selectHardMathStrategy({
    problem: "Prove a triangle angle chasing theorem with a concyclic configuration.",
    goal: "Find a proof route",
    workflow: "pflk",
    phase: "loophole",
    role: "loophole-search"
  });
  expect(geometry.problemFeatures).toContain("geometry");
  expect(geometry.selectedStrategyId).toBe("geometry-configuration-invariant");
  expect(geometry.selectedTacticIds).toContain("diagram-free-incidence");
});

test("open problem and experiment roles prefer honest-progress and exact-computation tactics", () => {
  expect(detectMathProblemFeatures("Resolve an Erdos open conjecture about primes", "solve it")).toEqual([
    "open_problem",
    "number_theory"
  ]);

  const openProblem = selectHardMathStrategy({
    problem: "Resolve an Erdos open conjecture about primes.",
    goal: "Find useful progress without false solved claims",
    workflow: "pflk",
    phase: "loophole",
    role: "loophole-search"
  });
  const experiment = selectHardMathStrategy({
    problem: "Enumerate all finite counterexamples for an exact arithmetic claim.",
    goal: "Find a verified counterexample",
    workflow: "gree",
    phase: "experiment",
    role: "experiment-search"
  });

  expect(openProblem.selectedStrategyId).toBe("open-problem-honest-progress");
  expect(openProblem.failureConsolidation.retainAs).toContain("nearby theorem drift");
  expect(experiment.selectedStrategyId).toBe("computational-exact-search");
  expect(experiment.failureConsolidation.knowledgeKind).toBe("experiment_observation");
  expect(experiment.selectedTacticIds).toContain("finite-domain-boundary");
});
