export type AssumptionDeltaKind =
  | "none"
  | "divide_by_zero"
  | "changed_quantifier"
  | "weakened_domain"
  | "hidden_assumption"
  | "nearby_theorem"
  | "added_assumption"
  | "changed_conclusion";

export type AssumptionDelta = {
  kind: AssumptionDeltaKind;
  description: string;
  original?: string;
  proposed?: string;
  blocksOriginalGoal: boolean;
};

export type AssumptionDeltaReview = {
  version: "assumption-delta-v1";
  phase: "loophole" | "formalization" | "verification";
  role?: string;
  originalProblem: string;
  originalGoal: string;
  proposedStatement: string;
  originalAssumptions: string[];
  proposedAssumptions: string[];
  deltas: AssumptionDelta[];
  affectedGoalCandidateIds: string[];
  createsAlternateGoalCandidate: boolean;
  canSolveOriginalGoal: boolean;
  verifierImpact: string;
  reportLabel: "original_goal_preserved" | "alternate_goal_candidate" | "weakened_or_changed_statement";
};

export function reviewLoopholeAssumptionDelta(input: {
  role: string;
  problem: string;
  goal: string;
  proposedStatement?: string;
}): AssumptionDeltaReview {
  const proposedStatement = normalizeWhitespace(input.proposedStatement ?? `${input.role} candidate for ${input.goal}`);
  const deltas = inferDeltas(input.problem, input.goal, proposedStatement);
  if (deltas.length === 0 && input.role === "loophole-search") {
    deltas.push({
      kind: "hidden_assumption",
      description: "Loophole search must treat any shortcut as a candidate hidden-assumption attack until independently discharged.",
      original: "original problem assumptions",
      proposed: "shortcut proof route",
      blocksOriginalGoal: true
    });
  }
  if (deltas.length === 0) {
    deltas.push({
      kind: "none",
      description: "No assumption, quantifier, domain, or conclusion delta was detected for this branch.",
      blocksOriginalGoal: false
    });
  }

  const blocksOriginalGoal = deltas.some((delta) => delta.blocksOriginalGoal);
  const candidateId = `candidate_${stableSlug(input.role)}_${stableSlug(proposedStatement).slice(0, 32)}`;
  return {
    version: "assumption-delta-v1",
    phase: "loophole",
    role: input.role,
    originalProblem: input.problem,
    originalGoal: input.goal,
    proposedStatement,
    originalAssumptions: inferAssumptions(input.problem),
    proposedAssumptions: inferAssumptions(proposedStatement),
    deltas,
    affectedGoalCandidateIds: blocksOriginalGoal ? [candidateId] : [],
    createsAlternateGoalCandidate: blocksOriginalGoal,
    canSolveOriginalGoal: !blocksOriginalGoal,
    verifierImpact: blocksOriginalGoal
      ? "Changed assumptions, quantifiers, domains, or conclusions must be verified only as alternate goal candidates and cannot satisfy the original goal."
      : "No detected assumption delta; verifier may assess this branch against the original goal.",
    reportLabel: blocksOriginalGoal
      ? deltas.some((delta) => delta.kind === "nearby_theorem" || delta.kind === "changed_conclusion")
        ? "alternate_goal_candidate"
        : "weakened_or_changed_statement"
      : "original_goal_preserved"
  };
}

export function assumptionDeltaBlocksOriginalGoal(review?: AssumptionDeltaReview): boolean {
  return Boolean(review && (!review.canSolveOriginalGoal || review.deltas.some((delta) => delta.blocksOriginalGoal)));
}

export function assumptionDeltaReason(review: AssumptionDeltaReview): string {
  const blocking = review.deltas.filter((delta) => delta.blocksOriginalGoal);
  const deltas = blocking.length > 0 ? blocking : review.deltas;
  return deltas.map((delta) => `${delta.kind}: ${delta.description}`).join("; ");
}

function inferDeltas(problem: string, goal: string, proposed: string): AssumptionDelta[] {
  const combinedOriginal = `${problem} ${goal}`;
  const original = combinedOriginal.toLowerCase();
  const candidate = proposed.toLowerCase();
  const deltas: AssumptionDelta[] = [];

  if (/\bdivide by zero\b|\bdivision by zero\b|\bdenominator\s+(?:is\s+)?nonzero\b|\bnonzero denominator\b/.test(candidate)) {
    deltas.push({
      kind: "divide_by_zero",
      description: "Candidate relies on excluding or manipulating a zero denominator.",
      original: "no nonzero-denominator assumption",
      proposed: "denominator is nonzero or division by zero is used",
      blocksOriginalGoal: true
    });
  }
  if (/\bexists\b|\bsome\b|\bat least one\b/.test(candidate) && /\b(for all|forall|∀|every|all)\b/.test(original)) {
    deltas.push({
      kind: "changed_quantifier",
      description: "Candidate changes a universal statement into an existential or example-level statement.",
      original: "universal quantifier",
      proposed: "existential/example quantifier",
      blocksOriginalGoal: true
    });
  }
  if (/\bpositive\b|\bnonzero\b|\bprime\b|\bodd\b|\beven\b/.test(candidate) &&
    /\b(natural|integer|number|nat|int|all)\b/.test(original)) {
    deltas.push({
      kind: "weakened_domain",
      description: "Candidate restricts the original domain.",
      original: "original domain",
      proposed: "restricted domain",
      blocksOriginalGoal: true
    });
  }
  if (/\bassum(?:e|ing|ption)|\bprovided that\b|\bregularity\b|\bsmooth\b|\bcontinuous\b/.test(candidate)) {
    deltas.push({
      kind: "hidden_assumption",
      description: "Candidate introduces an assumption that is not discharged by the original statement.",
      original: "no extra assumption",
      proposed: "extra assumption",
      blocksOriginalGoal: true
    });
  }
  if (/\bnearby theorem\b|\bweaker theorem\b|\bvariant\b|\banalog\b|\brelated lemma\b/.test(candidate)) {
    deltas.push({
      kind: "nearby_theorem",
      description: "Candidate proves a nearby or related statement instead of the requested theorem.",
      original: "requested theorem",
      proposed: "nearby theorem",
      blocksOriginalGoal: true
    });
  }
  if (/\btrue\b/.test(candidate) && !/\btrue\b/.test(original)) {
    deltas.push({
      kind: "changed_conclusion",
      description: "Candidate replaces the requested conclusion with a vacuous truth.",
      original: "requested conclusion",
      proposed: "True",
      blocksOriginalGoal: true
    });
  }
  return uniqueDeltas(deltas);
}

function inferAssumptions(statement: string): string[] {
  const assumptions: string[] = [];
  const conditional = statement.match(/\b(if|assuming|given|where|provided that)\b([\s\S]*?)(?:,|\bthen\b|$)/i);
  if (conditional?.[2]) assumptions.push(normalizeWhitespace(conditional[2]));
  if (/\bpositive\b/i.test(statement)) assumptions.push("domain restricted to positive values");
  if (/\bnonzero\b/i.test(statement)) assumptions.push("nonzero condition");
  if (/\bregularity|smooth|continuous\b/i.test(statement)) assumptions.push("regularity condition");
  return [...new Set(assumptions)];
}

function uniqueDeltas(deltas: AssumptionDelta[]): AssumptionDelta[] {
  const seen = new Set<string>();
  return deltas.filter((delta) => {
    const key = `${delta.kind}:${delta.description}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function stableSlug(value: string): string {
  return normalizeWhitespace(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64) || "candidate";
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
