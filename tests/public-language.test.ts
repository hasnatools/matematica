import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatHardMathBenchmarkLadder } from "../src/benchmarks";
import { runCli } from "../src/cli";
import {
  buildPublicLanguageGuardrailReport,
  validatePublicLanguageSurface,
  type PublicLanguageSurface
} from "../src/public-language";

const homes: string[] = [];

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "matematica-public-language-test-"));
  homes.push(home);
  process.env.MATEMATICA_HOME = home;
  return home;
}

afterEach(() => {
  delete process.env.MATEMATICA_HOME;
  while (homes.length > 0) rmSync(homes.pop()!, { recursive: true, force: true });
});

test("public language guardrail rejects affirmative solved wording for weak or open-problem states", () => {
  const surfaces: PublicLanguageSurface[] = [{
    id: "bad-open-report",
    kind: "report",
    text: "Output trust label: solved\nCan claim solved: yes",
    context: {
      problemClass: "open_problem",
      finalState: "budget_exhausted",
      evidenceGrade: "budget_exhausted",
      canClaimSolved: false
    }
  }, {
    id: "bad-computation-json",
    kind: "terminal-json",
    text: JSON.stringify({ label: "solved", canClaimSolved: true, finalState: "computational_evidence" }),
    context: {
      problemClass: "open_problem",
      finalState: "computational_evidence",
      evidenceGrade: "verified_computation",
      canClaimSolved: true
    }
  }, {
    id: "bad-docs",
    kind: "readme",
    text: "This open problem is solved by the CLI."
  }];

  const report = buildPublicLanguageGuardrailReport(surfaces);

  expect(report.ok).toBe(false);
  expect(report.issues.map((issue) => issue.code)).toContain("unsafe_affirmative_solved_claim");
  expect(report.issues.map((issue) => issue.code)).toContain("unsafe_open_problem_solved_wording");
});

test("public README help and benchmark wording carry open-problem honesty markers", () => {
  const readme = readFileSync(join(process.cwd(), "README.md"), "utf8");
  const cliSource = readFileSync(join(process.cwd(), "src", "cli.ts"), "utf8");
  const benchmarkSummary = formatHardMathBenchmarkLadder();

  const report = buildPublicLanguageGuardrailReport([{
    id: "README.md",
    kind: "readme",
    text: readme
  }, {
    id: "cli-help-source",
    kind: "cli-help",
    text: cliSource
  }, {
    id: "hard-math-benchmark-ladder",
    kind: "benchmark-summary",
    text: benchmarkSummary
  }]);

  expect(report.ok).toBe(true);
});

test("open-problem and Erdos terminal public surfaces snapshot as non-solved with progress context", async () => {
  tempHome();
  const result = JSON.parse(await runCli([
    "solve",
    "--problem",
    "Resolve the Erdos discrepancy problem.",
    "--goal",
    "Find useful progress without false solved claims",
    "--budget-usd",
    "0",
    "--max-attempts",
    "1",
    "--workers",
    "1"
  ]));
  const watch = await runCli(["goal", "watch", result.runId, "--json"]);
  const report = await runCli(["goal", "report", result.runId]);

  expect(result.status).toBe("budget_exhausted");
  expect(result.canClaimSolved).toBe(false);
  expect(result.outputTrust.label).toBe("not_solved");
  expect(report).toContain("Can claim solved: no");
  expect(report).toContain("Output trust label: not solved");
  expect(report).toContain("Budget Exhausted Diagnostics");
  expect(report).toContain("\"knownGaps\"");
  expect(report).toContain("\"remainingProofObligations\"");
  expect(report).toContain("## Conjectural Knowledge");
  expect(report).not.toContain("Can claim solved: yes");
  expect(report).not.toContain("Output trust label: solved");

  const guardrail = buildPublicLanguageGuardrailReport([{
    id: "solve-json",
    kind: "terminal-json",
    text: JSON.stringify(result),
    context: {
      problemClass: "open_problem",
      finalState: result.finalState,
      evidenceGrade: result.evidenceGrade,
      canClaimSolved: result.canClaimSolved
    }
  }, {
    id: "watch-json",
    kind: "watch-json",
    text: watch,
    context: {
      problemClass: "open_problem",
      finalState: "budget_exhausted",
      evidenceGrade: "budget_exhausted",
      canClaimSolved: false
    }
  }, {
    id: "report",
    kind: "report",
    text: report,
    context: {
      problemClass: "open_problem",
      finalState: "budget_exhausted",
      evidenceGrade: "budget_exhausted",
      canClaimSolved: false
    }
  }]);

  expect(guardrail.ok).toBe(true);
});

test("standard verified computation may satisfy a computational goal without being labeled as theorem proof", () => {
  const issues = validatePublicLanguageSurface({
    id: "standard-computation",
    kind: "terminal-json",
    text: JSON.stringify({
      finalState: "computational_evidence",
      evidenceGrade: "verified_computation",
      canClaimSolved: true,
      labelText: "computation only",
      limitations: ["Do not phrase this as a theorem proof without a formal_proof outcome."]
    }),
    context: {
      problemClass: "standard_problem",
      finalState: "computational_evidence",
      evidenceGrade: "verified_computation",
      canClaimSolved: true
    }
  });

  expect(issues).toEqual([]);
});
