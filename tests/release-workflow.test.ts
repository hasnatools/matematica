import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runCli } from "../src/cli";
import { buildReleaseWorkflowSteps } from "../src/release-workflow";

test("release workflow exposes one blocking command for every public release gate", async () => {
  const steps = buildReleaseWorkflowSteps();
  const ids = steps.map((step) => step.id);

  expect(ids).toEqual([
    "typecheck",
    "full-tests",
    "packed-clean-install",
    "zero-network-smoke",
    "provider-key-scrubbed-doctor",
    "mocked-byok-dry-run",
    "lean-verification-smoke",
    "hidden-hostile-evals",
    "hard-math-benchmark-ladder",
    "public-claims-audit",
    "license-scan",
    "secret-scan",
    "artifact-privacy-scan",
    "swarm-kill-drill",
    "swarm-stress-gate"
  ]);
  expect(steps.every((step) => step.command.length > 0 && step.proves.length > 0)).toBe(true);
  expect(steps.find((step) => step.id === "typecheck")?.command).toEqual(["bunx", "tsc", "--noEmit"]);
  expect(steps.find((step) => step.id === "full-tests")?.command).toEqual(["bun", "test", "--timeout", "120000"]);
  expect(steps.find((step) => step.id === "provider-key-scrubbed-doctor")?.env).toMatchObject({
    OPENAI_API_KEY: undefined,
    ANTHROPIC_API_KEY: undefined,
    OPENROUTER_API_KEY: undefined,
    CEREBRAS_API_KEY: undefined
  });
  expect(steps.find((step) => step.id === "provider-key-scrubbed-doctor")?.command)
    .toContain("--clean-home");
  expect(steps.find((step) => step.id === "swarm-kill-drill")?.command.join(" ")).toContain("swarm-kill --worker-counts 1,4,16,100");
  expect(steps.find((step) => step.id === "swarm-stress-gate")?.command.join(" ")).toContain("swarm-stress --workers 100");
  expect(steps.find((step) => step.id === "hard-math-benchmark-ladder")?.command.join(" ")).toContain("benchmarks ladder --json");

  const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
  expect(packageJson.scripts["release:check"]).toBe("bun run src/bin/matematica.ts release check");

  const dryRun = JSON.parse(await runCli(["release", "check", "--dry-run", "--json"]));
  expect(dryRun).toMatchObject({
    format: "matematica.release-workflow",
    dryRun: true,
    ok: false
  });
  expect(dryRun.steps.map((step: { id: string; status: string }) => step.id)).toEqual(ids);
  expect(dryRun.steps.every((step: { status: string }) => step.status === "pending")).toBe(true);
});
