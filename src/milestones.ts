export type MilestoneStatus = "planned" | "in_progress" | "gated" | "ready";

export type MilestoneGate = {
  id: string;
  title: string;
  required: boolean;
  evidence: string[];
  commands: string[];
  blocks: string[];
};

export type ReleaseMilestone = {
  id: string;
  order: number;
  title: string;
  status: MilestoneStatus;
  releaseTarget: string;
  objective: string;
  gates: MilestoneGate[];
  unlocks: string[];
};

export type MilestonePlan = {
  format: "matematica.release-milestone-plan";
  version: 1;
  orderingRule: string;
  milestones: ReleaseMilestone[];
};

export type MilestoneReadinessIssue = {
  code:
    | "milestone_plan_invalid"
    | "milestone_command_uncovered";
  milestoneId?: string;
  gateId?: string;
  command?: string;
  message: string;
};

export type MilestoneReadinessValidation = {
  ok: boolean;
  requiredCommandCount: number;
  freshEvidenceCommandCount: number;
  executableCommandCount: number;
  gatedOrPlannedMilestoneCount: number;
  issues: MilestoneReadinessIssue[];
};

export const RELEASE_MILESTONE_PLAN: MilestonePlan = {
  format: "matematica.release-milestone-plan",
  version: 1,
  orderingRule: "A milestone can be treated as ready only when every required gate in all earlier milestones is satisfied.",
  milestones: [
    {
      id: "m0-local-core",
      order: 0,
      title: "Local deterministic core",
      status: "ready",
      releaseTarget: "developer preview",
      objective: "Run a Bun/TypeScript CLI goal loop locally with persisted ledger, artifacts, reports, replay, and zero bundled provider keys.",
      gates: [
        gate("m0-tests", "Typecheck and local test suite", ["bunx tsc --noEmit", "bun test"], ["TypeScript errors", "failing tests"]),
        gate("m0-zero-network", "Zero-network default and free OSS boundary", ["bun test tests/oss-release.test.ts tests/cli.test.ts"], ["network-by-default behavior", "provider key leakage"]),
        gate("m0-terminal-honesty", "Goal terminal states use verifier-backed vocabulary", ["bun test tests/goal-success.test.ts tests/problem-classifier.test.ts"], ["solved wording without verifier-backed evidence"])
      ],
      unlocks: ["m1-replay-verifier"]
    },
    {
      id: "m1-replay-verifier",
      order: 1,
      title: "Replayable verifier trust boundary",
      status: "ready",
      releaseTarget: "alpha",
      objective: "Fail closed unless formal proof, verified counterexample, or verified computation survives evidence, proof-obligation, claim-graph, and offline replay checks.",
      gates: [
        gate("m1-verifier-conformance", "Verifier conformance corpus", ["bun test tests/verifier-conformance.test.ts tests/evidence.test.ts tests/proof-obligations.test.ts"], ["sorry/admit/axiom acceptance", "formalization drift", "bogus counterexample"]),
        gate("m1-replay", "Offline replay final verification", ["bun test tests/replay-persistence.test.ts"], ["terminal event payload trust", "missing proof-obligation review", "forged support artifact"]),
        gate("m1-claim-graph", "Claim graph conflict and retraction review", ["bun test tests/claim-graph.test.ts"], ["retracted target claim", "active counterexample conflict"])
      ],
      unlocks: ["m2-research-security"]
    },
    {
      id: "m2-research-security",
      order: 2,
      title: "Hostile research ingestion",
      status: "gated",
      releaseTarget: "research alpha",
      objective: "Treat arXiv and source text as hostile input while preserving citation, source-quality, cache, and redistribution evidence.",
      gates: [
        gate("m2-research-firewall", "Retrieval prompt firewall and untrusted-source policy", ["bun test tests/research-security.test.ts tests/retrieval-evaluation.test.ts"], ["prompt injection through retrieved text", "trusted-looking source payloads"]),
        gate("m2-citations", "Citation provenance and quality", ["bun test tests/citations.test.ts tests/research-enrichment.test.ts"], ["fake citations", "stale or duplicate source promotion"]),
        gate("m2-cache-throttle", "Cross-process arXiv cache and throttle", ["bun test tests/arxiv.test.ts"], ["polite-use violations", "network access in offline mode"])
      ],
      unlocks: ["m3-provider-byok"]
    },
    {
      id: "m3-provider-byok",
      order: 3,
      title: "BYOK provider admission",
      status: "gated",
      releaseTarget: "BYOK beta",
      objective: "Allow OpenAI, Anthropic, OpenRouter, Cerebras, and local providers only through explicit BYOK admission, finite per-call caps, redaction, and replayable provider metadata.",
      gates: [
        gate("m3-provider-admission", "Remote provider admission and cost caps", ["bun test tests/providers.test.ts tests/cli.test.ts"], ["unledgered paid call", "missing max-call USD cap", "provider outside allowlist"]),
        gate("m3-provider-route-smoke", "AI SDK provider route smoke matrix", ["bun test tests/provider-route-smoke.test.ts tests/release-doctor.test.ts"], ["requested/observed provider drift", "missing OpenRouter upstream provenance", "paid provider call during free OSS smoke"]),
        gate("m3-provider-resilience", "Provider error taxonomy and circuit behavior", ["bun test tests/providers.test.ts"], ["retry storms", "missing usage accounting", "429 retry-after bypass"]),
        gate("m3-privacy", "Provider privacy and redaction", ["bun test tests/redaction.test.ts tests/secret-canary.test.ts"], ["secret persistence", "local path egress"])
      ],
      unlocks: ["m4-swarm-scale"]
    },
    {
      id: "m4-swarm-scale",
      order: 4,
      title: "Controlled swarm scale",
      status: "gated",
      releaseTarget: "swarm beta",
      objective: "Scale branch workers only after lease, budget, attestation, kill switch, and terminal-stop races are proven under contention.",
      gates: [
        gate("m4-scheduler", "Scheduler and lease invariants", ["bun test tests/scheduler.test.ts"], ["duplicate leases", "double debit", "work after terminal status"]),
        gate("m4-boundary", "AI SDK swarm boundary and remote worker control plane", ["bun test tests/swarm-boundary.test.ts"], ["stale remote mutation", "missing worker attestation", "remote budget ownership"]),
        gate("m4-kill-drill", "Swarm kill-drill matrix", ["bun test tests/swarm-kill-drill.test.ts", "bun run src/bin/matematica.ts drills swarm-kill --worker-counts 1,4,16,100"], ["open reservations after stop", "provider 429 storm", "100-worker contention regression"]),
        gate("m4-stress-gate", "100-worker mock-provider stress gate", ["bun test tests/swarm-stress-gate.test.ts", "bun run src/bin/matematica.ts drills swarm-stress --workers 100 --provider-concurrency 8"], ["PFLK/GREE phase fanout regression", "budget refund leak", "crash resume duplicate lease", "unbounded CPU or memory"])
      ],
      unlocks: ["m5-public-release"]
    },
    {
      id: "m5-public-release",
      order: 5,
      title: "Public OSS release",
      status: "planned",
      releaseTarget: "public release",
      objective: "Publish a free open-source CLI with docs, runbooks, acceptance tests, release doctor, and no hidden hosted compute dependency.",
      gates: [
        gate("m5-acceptance", "Free OSS acceptance suite", ["bun test tests/oss-release.test.ts tests/reliability-integration.test.ts"], ["non-portable package", "private paths", "secret-looking literals"]),
        gate("m5-hard-math-ladder", "Hard-math usefulness benchmark ladder", ["bun test tests/benchmarks.test.ts", "bun run src/bin/matematica.ts benchmarks ladder --json"], ["toy-only benchmark coverage", "missing open-problem honesty promotion criteria"]),
        gate("m5-doctor", "Release doctor and operator runbook", ["bun run src/bin/matematica.ts doctor"], ["ambiguous BYOK contract", "missing zero-network readiness"]),
        gate("m5-docs", "Roadmap and command documentation", ["bun test tests/cli.test.ts"], ["undocumented command surface", "missing release gate ordering"])
      ],
      unlocks: []
    }
  ]
};

export function releaseMilestones(): ReleaseMilestone[] {
  return RELEASE_MILESTONE_PLAN.milestones.map((milestone) => ({
    ...milestone,
    gates: milestone.gates.map((gate) => ({ ...gate, evidence: [...gate.evidence], commands: [...gate.commands], blocks: [...gate.blocks] })),
    unlocks: [...milestone.unlocks]
  }));
}

export function validateMilestonePlan(plan: MilestonePlan = RELEASE_MILESTONE_PLAN): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  const ids = new Set<string>();
  const orders = new Set<number>();
  for (const milestone of plan.milestones) {
    if (ids.has(milestone.id)) issues.push(`duplicate milestone id: ${milestone.id}`);
    ids.add(milestone.id);
    if (orders.has(milestone.order)) issues.push(`duplicate milestone order: ${milestone.order}`);
    orders.add(milestone.order);
    if (milestone.gates.length === 0) issues.push(`milestone ${milestone.id} has no gates`);
    for (const gate of milestone.gates) {
      if (gate.required && gate.commands.length === 0) issues.push(`required gate ${gate.id} has no verification command`);
      if (gate.required && gate.evidence.length === 0) issues.push(`required gate ${gate.id} has no evidence contract`);
      if (gate.required && gate.blocks.length === 0) issues.push(`required gate ${gate.id} has no blocking condition`);
    }
  }
  const sortedOrders = [...orders].sort((left, right) => left - right);
  sortedOrders.forEach((order, index) => {
    if (order !== index) issues.push(`milestone order must be contiguous from 0; found ${order} at position ${index}`);
  });
  for (const milestone of plan.milestones) {
    for (const unlock of milestone.unlocks) {
      if (!ids.has(unlock)) issues.push(`milestone ${milestone.id} unlocks missing milestone ${unlock}`);
    }
  }
  return { ok: issues.length === 0, issues };
}

export function validateMilestoneReadiness(input: {
  plan?: MilestonePlan;
  freshEvidenceCommands?: string[];
  executableCommands?: string[];
} = {}): MilestoneReadinessValidation {
  const plan = input.plan ?? RELEASE_MILESTONE_PLAN;
  const freshEvidenceCommands = uniqueCommands(input.freshEvidenceCommands ?? []);
  const executableCommands = uniqueCommands(input.executableCommands ?? []);
  const structural = validateMilestonePlan(plan);
  const issues: MilestoneReadinessIssue[] = structural.issues.map((issue) => ({
    code: "milestone_plan_invalid",
    message: issue
  }));
  let requiredCommandCount = 0;

  for (const milestone of plan.milestones) {
    for (const gate of milestone.gates) {
      if (!gate.required) continue;
      for (const command of gate.commands) {
        requiredCommandCount += 1;
        const coveredByEvidence = freshEvidenceCommands.some((candidate) => commandCovers(candidate, command));
        const coveredByReleaseWorkflow = executableCommands.some((candidate) => commandCovers(candidate, command));
        if (!coveredByEvidence && !coveredByReleaseWorkflow) {
          issues.push({
            code: "milestone_command_uncovered",
            milestoneId: milestone.id,
            gateId: gate.id,
            command,
            message: `${milestone.id}/${gate.id} has no fresh passing evidence or executable release workflow command for: ${command}`
          });
        }
      }
    }
  }

  return {
    ok: issues.length === 0,
    requiredCommandCount,
    freshEvidenceCommandCount: freshEvidenceCommands.length,
    executableCommandCount: executableCommands.length,
    gatedOrPlannedMilestoneCount: plan.milestones.filter((milestone) =>
      milestone.status === "gated" || milestone.status === "planned"
    ).length,
    issues
  };
}

export function formatMilestonePlan(plan: MilestonePlan = RELEASE_MILESTONE_PLAN): string {
  const lines = [
    "Matematica release milestones",
    `Ordering: ${plan.orderingRule}`
  ];
  for (const milestone of [...plan.milestones].sort((left, right) => left.order - right.order)) {
    lines.push("");
    lines.push(`${milestone.order}. ${milestone.id} - ${milestone.title} [${milestone.status}]`);
    lines.push(`   Target: ${milestone.releaseTarget}`);
    lines.push(`   Objective: ${milestone.objective}`);
    lines.push(`   Unlocks: ${milestone.unlocks.length > 0 ? milestone.unlocks.join(", ") : "none"}`);
    lines.push("   Gates:");
    for (const gate of milestone.gates) {
      lines.push(`   - ${gate.id}: ${gate.title}`);
      lines.push(`     Commands: ${gate.commands.join(" && ")}`);
      lines.push(`     Blocks: ${gate.blocks.join("; ")}`);
    }
  }
  return lines.join("\n");
}

function gate(id: string, title: string, commands: string[], blocks: string[]): MilestoneGate {
  return {
    id,
    title,
    required: true,
    evidence: commands.map((command) => `passing command: ${command}`),
    commands,
    blocks
  };
}

function commandCovers(candidate: string, required: string): boolean {
  const candidateTokens = tokenizeCommand(candidate);
  const requiredTokens = tokenizeCommand(required);
  if (candidateTokens.join(" ") === requiredTokens.join(" ")) return true;
  if (coversBunTest(candidateTokens, requiredTokens)) return true;
  if (candidateTokens.length > requiredTokens.length &&
    requiredTokens.every((token, index) => candidateTokens[index] === token) &&
    candidateTokens.slice(requiredTokens.length).every((token) => token.startsWith("--"))) {
    return true;
  }
  return false;
}

function coversBunTest(candidateTokens: string[], requiredTokens: string[]): boolean {
  if (candidateTokens[0] !== "bun" || candidateTokens[1] !== "test") return false;
  if (requiredTokens[0] !== "bun" || requiredTokens[1] !== "test") return false;
  const candidateFiles = testFiles(candidateTokens);
  const requiredFiles = testFiles(requiredTokens);
  if (requiredFiles.length === 0) return candidateFiles.length === 0;
  if (candidateFiles.length === 0) return true;
  return requiredFiles.every((file) => candidateFiles.includes(file));
}

function testFiles(tokens: string[]): string[] {
  return tokens.slice(2).filter((token) => token.endsWith(".test.ts"));
}

function tokenizeCommand(command: string): string[] {
  return command.trim().split(/\s+/).filter(Boolean);
}

function uniqueCommands(commands: string[]): string[] {
  return [...new Set(commands.map((command) => tokenizeCommand(command).join(" ")).filter(Boolean))];
}
