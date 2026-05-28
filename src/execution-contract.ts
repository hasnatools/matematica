export type ExecutionModeId = "free-local-oss" | "paid-byok-remote";

export type ExecutionModeContract = {
  id: ExecutionModeId;
  title: string;
  costToMatematicaUser: "free" | "provider-billed-byok";
  networkDefault: "zero-network" | "explicit-remote-provider";
  computeSource: string;
  allowedByDefault: string[];
  requires: string[];
  forbidden: string[];
  ledgerEvidence: string[];
};

export type ExecutionContract = {
  format: "matematica.execution-contract";
  version: 1;
  package: {
    npmName: "@hasna/matematica";
    cli: "matematica";
    license: "MIT";
    repository: "hasnatools/matematica";
  };
  invariants: string[];
  modes: ExecutionModeContract[];
};

export const EXECUTION_CONTRACT: ExecutionContract = {
  format: "matematica.execution-contract",
  version: 1,
  package: {
    npmName: "@hasna/matematica",
    cli: "matematica",
    license: "MIT",
    repository: "hasnatools/matematica"
  },
  invariants: [
    "The public CLI is free open-source software and ships no hosted compute, provider account, bundled model credits, or API keys.",
    "Every action that affects a run must be persisted in the local ledger and artifact store before it can affect terminal state.",
    "Remote provider usage is optional BYOK and is charged by the selected provider to the operator's account.",
    "A remote model call is never verifier-backed mathematical evidence by itself.",
    "Offline replay and reports must not need provider keys or new network access."
  ],
  modes: [
    {
      id: "free-local-oss",
      title: "Free local OSS baseline",
      costToMatematicaUser: "free",
      networkDefault: "zero-network",
      computeSource: "local deterministic code, local filesystem ledger/artifacts, cached source metadata, and optional local proof tools",
      allowedByDefault: [
        "doctor and doctor --release",
        "goal create",
        "goal run with deterministic local workers",
        "goal report",
        "goal audit",
        "goal replay and offline final verification",
        "cache-only arXiv/source lookup"
      ],
      requires: [
        "Bun runtime",
        "local filesystem write access to MATEMATICA_HOME",
        "no provider keys",
        "no remote network permission"
      ],
      forbidden: [
        "remote model dispatch",
        "hosted Hasna compute",
        "bundled provider credits",
        "secret persistence",
        "unprompted network fetch"
      ],
      ledgerEvidence: [
        "goal.created",
        "budget.checked",
        "artifact.created",
        "source.offline_cache.used or source.offline_cache.missed",
        "goal.completed",
        "report.generated"
      ]
    },
    {
      id: "paid-byok-remote",
      title: "Paid BYOK remote provider mode",
      costToMatematicaUser: "provider-billed-byok",
      networkDefault: "explicit-remote-provider",
      computeSource: "operator-selected remote AI provider using operator-owned credentials",
      allowedByDefault: [
        "OpenAI provider adapter",
        "Anthropic provider adapter",
        "OpenRouter provider adapter",
        "Cerebras provider adapter",
        "local OpenAI-compatible endpoint when configured"
      ],
      requires: [
        "--provider <name>",
        "--allow-network or non-offline run policy",
        "--max-call-usd",
        "--max-output-tokens",
        "ledgered remote compute admission",
        "provider allowlist match",
        "--i-understand-remote-costs for multi-worker remote fanout"
      ],
      forbidden: [
        "unledgered paid remote call",
        "remote dispatch in MATEMATICA_LOCAL_ONLY=true",
        "remote dispatch without a hard budget cap",
        "provider outside run allowlist",
        "treating model output as verifier-backed final evidence"
      ],
      ledgerEvidence: [
        "provider.matrix.pinned",
        "remote.cost.preflight",
        "privacy.remote_provider.used",
        "provider.egress.checked",
        "external.operation.reserved",
        "ai.call.started",
        "ai.call.completed or ai.call.failed",
        "budget.debited"
      ]
    }
  ]
};

export function formatExecutionContract(contract: ExecutionContract = EXECUTION_CONTRACT): string {
  const lines = [
    "Matematica execution contract",
    `Package: ${contract.package.npmName}`,
    `CLI: ${contract.package.cli}`,
    `License: ${contract.package.license}`,
    `Repository: ${contract.package.repository}`,
    "",
    "Invariants:",
    ...contract.invariants.map((invariant) => `- ${invariant}`)
  ];
  for (const mode of contract.modes) {
    lines.push("");
    lines.push(`${mode.id}: ${mode.title}`);
    lines.push(`  Cost: ${mode.costToMatematicaUser}`);
    lines.push(`  Network: ${mode.networkDefault}`);
    lines.push(`  Compute: ${mode.computeSource}`);
    lines.push(`  Requires: ${mode.requires.join("; ")}`);
    lines.push(`  Forbidden: ${mode.forbidden.join("; ")}`);
    lines.push(`  Ledger evidence: ${mode.ledgerEvidence.join(", ")}`);
  }
  return lines.join("\n");
}

export function validateExecutionContract(contract: ExecutionContract = EXECUTION_CONTRACT): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  const free = contract.modes.find((mode) => mode.id === "free-local-oss");
  const byok = contract.modes.find((mode) => mode.id === "paid-byok-remote");
  if (!free) issues.push("free-local-oss mode is missing");
  if (!byok) issues.push("paid-byok-remote mode is missing");
  if (free && free.costToMatematicaUser !== "free") issues.push("free-local-oss must be free");
  if (free && free.networkDefault !== "zero-network") issues.push("free-local-oss must default to zero-network");
  if (free && !free.forbidden.includes("remote model dispatch")) issues.push("free-local-oss must forbid remote model dispatch");
  if (byok && byok.costToMatematicaUser !== "provider-billed-byok") issues.push("paid-byok-remote must be provider-billed BYOK");
  if (byok && !byok.requires.includes("--max-call-usd")) issues.push("paid-byok-remote must require --max-call-usd");
  if (byok && !byok.requires.includes("ledgered remote compute admission")) issues.push("paid-byok-remote must require ledgered remote compute admission");
  if (byok && !byok.forbidden.includes("unledgered paid remote call")) issues.push("paid-byok-remote must forbid unledgered paid remote calls");
  for (const mode of contract.modes) {
    if (mode.ledgerEvidence.length === 0) issues.push(`${mode.id} has no ledger evidence contract`);
    if (mode.requires.length === 0) issues.push(`${mode.id} has no requirements`);
    if (mode.forbidden.length === 0) issues.push(`${mode.id} has no forbidden behavior`);
  }
  return { ok: issues.length === 0, issues };
}
