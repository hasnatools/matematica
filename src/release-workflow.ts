import { spawnSync } from "node:child_process";

export type ReleaseWorkflowStepId =
  | "typecheck"
  | "full-tests"
  | "packed-clean-install"
  | "zero-network-smoke"
  | "provider-key-scrubbed-doctor"
  | "mocked-byok-dry-run"
  | "lean-verification-smoke"
  | "hidden-hostile-evals"
  | "hard-math-benchmark-ladder"
  | "public-claims-audit"
  | "license-scan"
  | "secret-scan"
  | "artifact-privacy-scan"
  | "swarm-kill-drill"
  | "swarm-stress-gate";

export type ReleaseWorkflowStep = {
  id: ReleaseWorkflowStepId;
  title: string;
  command: string[];
  env?: Record<string, string | undefined>;
  proves: string[];
};

export type ReleaseWorkflowStepResult = ReleaseWorkflowStep & {
  status: "pending" | "passed" | "failed";
  exitCode?: number;
  durationMs?: number;
  stdout?: string;
  stderr?: string;
};

export type ReleaseWorkflowReport = {
  format: "matematica.release-workflow";
  version: 1;
  ok: boolean;
  dryRun: boolean;
  cwd: string;
  steps: ReleaseWorkflowStepResult[];
};

const PROVIDER_KEYS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENROUTER_API_KEY",
  "CEREBRAS_API_KEY"
];

export function buildReleaseWorkflowSteps(): ReleaseWorkflowStep[] {
  return [
    {
      id: "typecheck",
      title: "TypeScript typecheck",
      command: ["bunx", "tsc", "--noEmit"],
      proves: ["typecheck"]
    },
    {
      id: "full-tests",
      title: "Full Bun test suite",
      command: ["bun", "test", "--timeout", "120000"],
      proves: ["full bun test"]
    },
    {
      id: "packed-clean-install",
      title: "Packed clean install",
      command: ["bun", "test", "tests/oss-release.test.ts", "--timeout", "120000", "--test-name-pattern", "packed tarball installs cleanly"],
      proves: ["packed clean install", "package file allowlist", "private path scan"]
    },
    {
      id: "zero-network-smoke",
      title: "Zero-network local solve/report/audit/offline replay",
      command: ["bun", "test", "tests/oss-release.test.ts", "--timeout", "120000", "--test-name-pattern", "free OSS zero-network acceptance smoke"],
      proves: ["zero-network local solve", "report", "saved-everything audit", "offline replay", "offline resume"]
    },
    {
      id: "provider-key-scrubbed-doctor",
      title: "Provider-key-scrubbed release doctor",
      command: ["bun", "run", "src/bin/matematica.ts", "doctor", "--release", "--clean-home", "--json"],
      env: Object.fromEntries(PROVIDER_KEYS.map((key) => [key, undefined])),
      proves: ["provider-key-scrubbed doctor", "release doctor"]
    },
    {
      id: "mocked-byok-dry-run",
      title: "Mocked BYOK hostile provider dry run",
      command: ["bun", "test", "tests/cli.test.ts", "--timeout", "120000", "--test-name-pattern", "providers hostile-dry-run persists adversarial review"],
      proves: ["mocked BYOK dry run", "hostile provider dry run", "provider secret redaction"]
    },
    {
      id: "lean-verification-smoke",
      title: "Lean verification smoke",
      command: ["bun", "test", "tests/lean.test.ts", "tests/verifier-conformance.test.ts", "--timeout", "120000"],
      proves: ["Lean verification smoke", "verifier conformance"]
    },
    {
      id: "hidden-hostile-evals",
      title: "Hidden hostile evals",
      command: ["bun", "run", "src/bin/matematica.ts", "benchmarks", "release-gate"],
      proves: ["hidden hostile evals", "zero false-solved"]
    },
    {
      id: "hard-math-benchmark-ladder",
      title: "Hard-math benchmark ladder",
      command: ["bun", "run", "src/bin/matematica.ts", "benchmarks", "ladder", "--json"],
      proves: ["hard-math benchmark ladder", "benchmark promotion evidence"]
    },
    {
      id: "public-claims-audit",
      title: "Public claims audit",
      command: ["bun", "test", "tests/release-doctor.test.ts", "tests/public-language.test.ts", "--timeout", "120000"],
      proves: ["public claims audit", "public claim-language guardrail"]
    },
    {
      id: "license-scan",
      title: "License and NOTICE scan",
      command: ["bun", "test", "tests/oss-release.test.ts", "--timeout", "120000", "--test-name-pattern", "public package metadata locks"],
      proves: ["license scan", "NOTICE scan", "package metadata"]
    },
    {
      id: "secret-scan",
      title: "Secret scan",
      command: ["bun", "test", "tests/secret-canary.test.ts", "tests/redaction.test.ts", "--timeout", "120000"],
      proves: ["secret scan", "redaction"]
    },
    {
      id: "artifact-privacy-scan",
      title: "Artifact privacy scan",
      command: ["bun", "test", "tests/storage-encryption.test.ts", "tests/oss-release.test.ts", "--timeout", "120000"],
      proves: ["artifact privacy scan", "encrypted storage", "packed artifact scan"]
    },
    {
      id: "swarm-kill-drill",
      title: "Swarm kill-switch drill",
      command: ["bun", "run", "src/bin/matematica.ts", "drills", "swarm-kill", "--worker-counts", "1,4,16,100"],
      proves: ["swarm kill-switch drill", "terminal-stop races", "reservation cleanup", "post-terminal mutation guard"]
    },
    {
      id: "swarm-stress-gate",
      title: "100-worker stress gate",
      command: ["bun", "run", "src/bin/matematica.ts", "drills", "swarm-stress", "--workers", "100", "--provider-concurrency", "8"],
      proves: ["100-worker stress gate", "swarm stress gate"]
    }
  ];
}

export function runReleaseWorkflow(input: {
  cwd: string;
  dryRun?: boolean;
  env?: NodeJS.ProcessEnv;
}): ReleaseWorkflowReport {
  const steps = buildReleaseWorkflowSteps();
  const results: ReleaseWorkflowStepResult[] = [];
  const dryRun = input.dryRun === true;
  const baseEnv = input.env ?? process.env;

  for (const step of steps) {
    if (dryRun) {
      results.push({ ...step, status: "pending" });
      continue;
    }
    const startedAt = Date.now();
    const result = spawnSync(step.command[0], step.command.slice(1), {
      cwd: input.cwd,
      env: releaseStepEnv(baseEnv, step.env),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stepResult: ReleaseWorkflowStepResult = {
      ...step,
      status: result.status === 0 ? "passed" : "failed",
      exitCode: result.status ?? 1,
      durationMs: Date.now() - startedAt,
      stdout: result.stdout,
      stderr: result.stderr
    };
    results.push(stepResult);
    if (stepResult.status === "failed") break;
  }

  return {
    format: "matematica.release-workflow",
    version: 1,
    ok: !dryRun && results.length === steps.length && results.every((step) => step.status === "passed"),
    dryRun,
    cwd: input.cwd,
    steps: results
  };
}

export function formatReleaseWorkflowReport(report: ReleaseWorkflowReport): string {
  return [
    `Matematica release workflow: ${report.dryRun ? "dry-run" : report.ok ? "pass" : "fail"}`,
    `Steps: ${report.steps.length}`,
    ...report.steps.map((step) => [
      `${step.status.toUpperCase()} ${step.id}: ${step.title}`,
      `  command: ${step.command.join(" ")}`,
      step.durationMs === undefined ? undefined : `  durationMs: ${step.durationMs}`,
      step.exitCode === undefined ? undefined : `  exitCode: ${step.exitCode}`,
      `  proves: ${step.proves.join(", ")}`
    ].filter((line): line is string => line !== undefined).join("\n"))
  ].join("\n");
}

function releaseStepEnv(baseEnv: NodeJS.ProcessEnv, overrides: Record<string, string | undefined> | undefined): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...baseEnv };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value === undefined) {
      delete next[key];
    } else {
      next[key] = value;
    }
  }
  return next;
}
