import { stableHash } from "./idempotency";

export const HARD_MATH_STRATEGY_VERSION = 1;

export type MathProblemFeature =
  | "number_theory"
  | "combinatorics"
  | "algebra"
  | "analysis"
  | "geometry"
  | "formal_proof"
  | "computation"
  | "open_problem"
  | "general";

export type StrategyTactic = {
  id: string;
  name: string;
  instruction: string;
  verifierHooks: string[];
  failureMode: string;
};

export type HardMathStrategy = {
  id: string;
  feature: MathProblemFeature;
  title: string;
  useWhen: string[];
  tactics: StrategyTactic[];
};

export type HardMathStrategySelection = {
  format: "matematica.hard-math-strategy-selection";
  version: 1;
  workflow: "pflk" | "gree";
  phase: string;
  role: string;
  problemFeatures: MathProblemFeature[];
  selectedStrategyId: string;
  selectedTacticIds: string[];
  tacticContract: StrategyTactic[];
  failureConsolidation: {
    knowledgeKind: "failed_tactic" | "counterexample_pressure" | "formalization_gap" | "experiment_observation";
    retainAs: string[];
  };
  selectionHash: string;
};

export const HARD_MATH_STRATEGIES: HardMathStrategy[] = [
  {
    id: "number-theory-modular-descent",
    feature: "number_theory",
    title: "Number theory modular obstruction and descent",
    useWhen: ["prime", "integer", "divisibility", "modular arithmetic", "Diophantine structure"],
    tactics: [
      {
        id: "modular-obstruction",
        name: "Search modular obstructions first",
        instruction: "Try small modulus classes, parity, residues, valuations, and congruence invariants before proposing a proof route.",
        verifierHooks: ["counterexample search", "finite modular computation", "Lean arithmetic lemma"],
        failureMode: "No discriminating modulus or valuation found."
      },
      {
        id: "descent-or-minimal-counterexample",
        name: "Attempt descent or minimal counterexample",
        instruction: "If direct proof stalls, assume a minimal counterexample and look for a strictly smaller one or a forced contradiction.",
        verifierHooks: ["proof obligation graph", "formalization equivalence review"],
        failureMode: "Minimal counterexample argument introduces an unverified well-founded measure."
      }
    ]
  },
  {
    id: "combinatorics-extremal-invariant",
    feature: "combinatorics",
    title: "Combinatorics extremal invariant search",
    useWhen: ["graph", "coloring", "matching", "Ramsey", "counting", "pigeonhole", "extremal"],
    tactics: [
      {
        id: "extremal-object",
        name: "Choose an extremal object",
        instruction: "Define a maximal or minimal object and derive forced local structure from the extremal choice.",
        verifierHooks: ["claim graph review", "counterexample pressure"],
        failureMode: "Extremal choice does not imply the claimed local structure."
      },
      {
        id: "invariant-or-potential",
        name: "Use invariant or potential",
        instruction: "Track a monotone invariant, potential function, or double count that must change under the proposed operation.",
        verifierHooks: ["finite search", "proof obligation graph"],
        failureMode: "Invariant is not preserved or does not strictly change."
      }
    ]
  },
  {
    id: "algebra-structure-normal-form",
    feature: "algebra",
    title: "Algebraic structure and normal form",
    useWhen: ["group", "ring", "field", "polynomial", "module", "linear algebra", "homomorphism"],
    tactics: [
      {
        id: "normal-form",
        name: "Reduce to normal form",
        instruction: "Identify generators, relations, canonical forms, or decompositions that make equality or obstruction checkable.",
        verifierHooks: ["symbolic computation", "Lean structure lemma"],
        failureMode: "Normal form is not unique or the reduction changes the theorem."
      },
      {
        id: "structure-preserving-map",
        name: "Construct a structure-preserving map",
        instruction: "Look for homomorphisms, quotient maps, invariants, or embeddings that preserve the target property.",
        verifierHooks: ["formalization equivalence review", "proof obligation graph"],
        failureMode: "Map fails to preserve the target predicate."
      }
    ]
  },
  {
    id: "analysis-estimate-compactness",
    feature: "analysis",
    title: "Analysis estimates and compactness",
    useWhen: ["limit", "continuous", "measure", "integral", "series", "inequality", "compact"],
    tactics: [
      {
        id: "epsilon-delta-estimate",
        name: "Make estimates explicit",
        instruction: "Turn qualitative claims into explicit bounds, quantified dependencies, and named convergence modes.",
        verifierHooks: ["formalization gap review", "proof obligation graph"],
        failureMode: "Quantifiers or dependencies are weaker than the original statement."
      },
      {
        id: "compactness-counterexample",
        name: "Probe compactness and counterexamples",
        instruction: "Check whether compactness, completeness, dominated convergence, or missing hypotheses are being used silently.",
        verifierHooks: ["counterexample search", "theorem equivalence review"],
        failureMode: "Argument depends on an unstated compactness or regularity assumption."
      }
    ]
  },
  {
    id: "geometry-configuration-invariant",
    feature: "geometry",
    title: "Geometry configuration and invariant chase",
    useWhen: ["triangle", "circle", "angle", "incidence", "projective", "synthetic geometry"],
    tactics: [
      {
        id: "diagram-free-incidence",
        name: "State diagram-free incidence facts",
        instruction: "Convert diagram intuition into explicit incidence, angle, orientation, and non-degeneracy assumptions.",
        verifierHooks: ["formalization gap review", "counterexample search"],
        failureMode: "The proof depends on a diagram-only or unstated non-degeneracy assumption."
      },
      {
        id: "invariant-transform",
        name: "Use invariant transformations",
        instruction: "Try coordinate, projective, inversion, or angle-chasing transforms while preserving the original statement.",
        verifierHooks: ["theorem equivalence review", "proof obligation graph"],
        failureMode: "Transformation changes the configuration or loses an exceptional case."
      }
    ]
  },
  {
    id: "formal-proof-lemma-ladder",
    feature: "formal_proof",
    title: "Formal proof lemma ladder",
    useWhen: ["Lean", "formalize", "theorem prover", "machine-checkable proof", "mathlib"],
    tactics: [
      {
        id: "statement-normalization",
        name: "Normalize the statement before proof search",
        instruction: "Extract definitions, quantifiers, assumptions, and conclusion; reject nearby theorem drift before proof attempts.",
        verifierHooks: ["theorem normalization", "formalization equivalence review"],
        failureMode: "Formal statement proves a nearby but non-equivalent theorem."
      },
      {
        id: "lemma-dependency-ladder",
        name: "Build a lemma dependency ladder",
        instruction: "Break the theorem into small lemmas with explicit dependency edges and no semantic-only discharges.",
        verifierHooks: ["proof obligation DAG", "Lean checker"],
        failureMode: "A lemma is assumed, cyclic, or discharged only semantically."
      }
    ]
  },
  {
    id: "computational-exact-search",
    feature: "computation",
    title: "Exact computational search and reproduction",
    useWhen: ["compute", "finite", "enumerate", "counterexample", "brute force", "exact"],
    tactics: [
      {
        id: "finite-domain-boundary",
        name: "Prove the finite search boundary",
        instruction: "Define the exact finite domain, pruning rule, and completeness argument before trusting a computation.",
        verifierHooks: ["reproducibility manifest", "independent checker quorum"],
        failureMode: "Search boundary is incomplete or not justified."
      },
      {
        id: "independent-rerun",
        name: "Require independent rerun",
        instruction: "Persist executable inputs, outputs, hashes, and an independent checker before promoting computational evidence.",
        verifierHooks: ["sandbox replay", "independent checker quorum"],
        failureMode: "Output cannot be reproduced independently."
      }
    ]
  },
  {
    id: "open-problem-honest-progress",
    feature: "open_problem",
    title: "Open problem honest progress",
    useWhen: ["Erdos", "Goldbach", "Collatz", "Riemann", "open conjecture", "unsolved"],
    tactics: [
      {
        id: "known-results-boundary",
        name: "Map known results and boundaries",
        instruction: "Separate known literature, partial reductions, heuristic evidence, and original claims; do not claim solved without formal proof or verified counterexample.",
        verifierHooks: ["citation grounding", "open-problem policy"],
        failureMode: "Claim overstates literature-backed or heuristic progress."
      },
      {
        id: "progress-artifact",
        name: "Persist useful progress only",
        instruction: "Record failed approaches, conjectures, reductions, counterexample pressure, and formalization gaps as knowledge, not solved evidence.",
        verifierHooks: ["knowledge consolidation", "no-false-solved finalization"],
        failureMode: "Progress is mislabeled as solved evidence."
      }
    ]
  }
];

export function detectMathProblemFeatures(problem: string, goal: string): MathProblemFeature[] {
  const text = `${problem} ${goal}`.toLowerCase();
  const features: MathProblemFeature[] = [];
  if (/\b(erdos|goldbach|collatz|riemann|twin prime|open conjecture|unsolved|open problem)\b/.test(text)) features.push("open_problem");
  if (/\b(prime|primes|integer|integers|divisib|modular|modulo|congruence|diophantine|number theory|gcd|valuation)\b/.test(text)) features.push("number_theory");
  if (/\b(graph|color|matching|ramsey|counting|pigeonhole|combinator|extremal|partition)\b/.test(text)) features.push("combinatorics");
  if (/\b(group|ring|field|polynomial|module|matrix|linear|homomorphism|eigen)\b/.test(text)) features.push("algebra");
  if (/\b(limit|continuous|derivative|integral|measure|series|compact|topolog|inequality|converge)\b/.test(text)) features.push("analysis");
  if (/\b(triangle|circle|angle|incidence|projective|geometry|geometric|collinear|concyclic)\b/.test(text)) features.push("geometry");
  if (/\b(lean|formal|theorem prover|mathlib|machine[- ]check|formalize)\b/.test(text)) features.push("formal_proof");
  if (/\b(compute|finite|enumerate|brute force|algorithm|program|counterexample|exact arithmetic|search)\b/.test(text)) features.push("computation");
  return features.length > 0 ? unique(features) : ["general"];
}

export function selectHardMathStrategy(input: {
  problem: string;
  goal: string;
  workflow: "pflk" | "gree";
  phase: string;
  role: string;
}): HardMathStrategySelection {
  const problemFeatures = detectMathProblemFeatures(input.problem, input.goal);
  const strategy = chooseStrategy(problemFeatures, input.phase, input.role);
  const selectedTactics = tacticsForRole(strategy, input.role);
  const unsigned = {
    format: "matematica.hard-math-strategy-selection" as const,
    version: HARD_MATH_STRATEGY_VERSION as 1,
    workflow: input.workflow,
    phase: input.phase,
    role: input.role,
    problemFeatures,
    selectedStrategyId: strategy.id,
    selectedTacticIds: selectedTactics.map((tactic) => tactic.id),
    tacticContract: selectedTactics,
    failureConsolidation: failureConsolidationFor(input.phase, input.role)
  };
  return {
    ...unsigned,
    selectionHash: stableHash(unsigned)
  };
}

function chooseStrategy(features: MathProblemFeature[], phase: string, role: string): HardMathStrategy {
  const prioritized = [
    role.includes("counterexample") ? "computation" : undefined,
    phase === "experiment" ? "computation" : undefined,
    features.includes("open_problem") ? "open_problem" : undefined,
    features.includes("formal_proof") ? "formal_proof" : undefined,
    ...features
  ].filter((feature): feature is MathProblemFeature => Boolean(feature) && feature !== "general");
  for (const feature of prioritized) {
    const strategy = HARD_MATH_STRATEGIES.find((item) => item.feature === feature);
    if (strategy) return strategy;
  }
  return HARD_MATH_STRATEGIES.find((strategy) => strategy.feature === "formal_proof") ?? HARD_MATH_STRATEGIES[0];
}

function tacticsForRole(strategy: HardMathStrategy, role: string): StrategyTactic[] {
  if (role.includes("counterexample") || role.includes("experiment")) {
    const falsification = strategy.tactics.find((tactic) =>
      tactic.id.includes("counterexample") ||
      tactic.id.includes("obstruction") ||
      tactic.id.includes("finite") ||
      tactic.id.includes("independent")
    );
    return uniqueTactics([falsification ?? strategy.tactics[0], strategy.tactics.at(-1) ?? strategy.tactics[0]]);
  }
  if (role.includes("evolution")) return uniqueTactics([strategy.tactics.at(-1) ?? strategy.tactics[0]]);
  return strategy.tactics;
}

function failureConsolidationFor(phase: string, role: string): HardMathStrategySelection["failureConsolidation"] {
  if (role.includes("counterexample")) {
    return {
      knowledgeKind: "counterexample_pressure",
      retainAs: ["counterexample attempts", "failed falsifiers", "blocking proof obligations"]
    };
  }
  if (phase === "experiment") {
    return {
      knowledgeKind: "experiment_observation",
      retainAs: ["reproduction manifest", "failed runs", "boundary conditions"]
    };
  }
  if (phase === "loophole") {
    return {
      knowledgeKind: "formalization_gap",
      retainAs: ["assumption deltas", "nearby theorem drift", "failed tactic rationale"]
    };
  }
  return {
    knowledgeKind: "failed_tactic",
    retainAs: ["failed tactic", "reason", "next verifier hook"]
  };
}

function unique(features: MathProblemFeature[]): MathProblemFeature[] {
  return [...new Set(features)];
}

function uniqueTactics(tactics: StrategyTactic[]): StrategyTactic[] {
  const seen = new Set<string>();
  return tactics.filter((tactic) => {
    if (seen.has(tactic.id)) return false;
    seen.add(tactic.id);
    return true;
  });
}
