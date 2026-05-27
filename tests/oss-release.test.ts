import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../src/ledger";

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

test("public package metadata locks the free OSS release boundary", () => {
  const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
  expect(packageJson).toMatchObject({
    name: "@hasna/matematica",
    license: "MIT",
    publishConfig: { access: "public" },
    bin: { matematica: "./src/bin/matematica.ts" },
    repository: {
      type: "git",
      url: "https://github.com/hasna/matematica.git"
    }
  });
  expect(packageJson.private).toBeUndefined();
  expect(packageJson.files).toEqual(expect.arrayContaining(["src", "docs", "README.md", "LICENSE", "NOTICE"]));
  expect(existsSync(join(process.cwd(), "LICENSE"))).toBe(true);
  expect(existsSync(join(process.cwd(), "NOTICE"))).toBe(true);
});

test("packed tarball installs cleanly with zero provider keys and no private paths", () => {
  const { tarball } = packPackage();

  const listing = run("tar", ["-tzf", tarball], process.cwd());
  expect(listing.status).toBe(0);
  const files = listing.stdout.trim().split("\n").sort();
  expect(files).toContain("package/package.json");
  expect(files).toContain("package/LICENSE");
  expect(files).toContain("package/NOTICE");
  expect(files).toContain("package/README.md");
  expect(files).toContain("package/docs/adr/0001-ai-sdk-swarm-boundary.md");
  expect(files).toContain("package/docs/operator-runbook.md");
  expect(files).toContain("package/src/bin/matematica.ts");
  expect(files.some((file) => file.includes(".matematica/"))).toBe(false);
  expect(files.some((file) => file.includes("node_modules/"))).toBe(false);
  expect(files.some((file) => file.startsWith("package/tests/"))).toBe(false);

  const extractDir = tempDir("matematica-extract-");
  const extract = run("tar", ["-xzf", tarball, "-C", extractDir], process.cwd());
  expect(extract.status).toBe(0);
  const packedText = readPackedText(join(extractDir, "package"));
  expect(packedText).not.toContain("@hasnatools");
  expect(packedText).not.toContain("/home/hasna/");
  expect(packedText).not.toContain("workspace/hasnatools");
  expect(packedText).not.toMatch(/sk-[A-Za-z0-9_-]{12,}/);

  const { installDir, env } = installPackedPackage(tarball, "matematica-install-");
  const doctor = run("bun", ["run", "matematica", "doctor"], installDir, env);
  expect(doctor.status).toBe(0);
  expect(doctor.stdout).toContain("Matematica doctor");
  expect(doctor.stdout).toContain("Free local-only baseline");
  expect(doctor.stdout).toContain("zero API keys");
  expect(doctor.stdout).not.toContain("/home/hasna/");
  const releaseDoctor = run("bun", ["run", "matematica", "doctor", "--release", "--json"], installDir, env);
  expect(releaseDoctor.status).toBe(0);
  const releaseReport = JSON.parse(releaseDoctor.stdout);
  expect(releaseReport).toMatchObject({
    format: "matematica.release-doctor",
    ok: true,
    zeroNetworkReady: true,
    packageReady: true
  });
  expect(releaseDoctor.stdout).not.toContain("/home/hasna/");
});

test("operator runbook ships with executable clean-install guidance", () => {
  const { tarball } = packPackage();
  const extractDir = tempDir("matematica-runbook-extract-");
  const extract = run("tar", ["-xzf", tarball, "-C", extractDir], process.cwd());
  expect(extract.status).toBe(0);
  const runbook = readFileSync(join(extractDir, "package", "docs", "operator-runbook.md"), "utf8");
  const readme = readFileSync(join(extractDir, "package", "README.md"), "utf8");

  for (const required of [
    "export MATEMATICA_LOCAL_ONLY=true",
    "unset OPENAI_API_KEY ANTHROPIC_API_KEY OPENROUTER_API_KEY CEREBRAS_API_KEY",
    "bun run matematica doctor",
    "bun run matematica solve --problem \"Prove 1 + 1 = 2\"",
    "bun run matematica goal watch \"$RUN_ID\" --json",
    "bun run matematica goal report \"$RUN_ID\"",
    "bun run matematica goal audit \"$RUN_ID\" --saved-everything",
    "bun run matematica goal replay \"$RUN_ID\" --offline --verify-final",
    "bun run matematica goal resume \"$RUN_ID\" --offline",
    "bun run matematica goal stop \"$RUN_ID\"",
    "bun run matematica goal replay \"$RUN_ID\" --archive run.bundle.json.gz --redacted-export",
    "bun run matematica storage prune-caches --older-than-hours 168 --dry-run",
    "bun run matematica goal admission \"$RUN_ID\" --allow-network",
    "bun run matematica research arxiv --query",
    "bun run matematica doctor --lean-bin lean --lake-bin lake --elan-bin elan",
    "bun run matematica goal verify-lean \"$RUN_ID\" --file proof.lean --project-root .",
    "bun run matematica doctor --release --json",
    "bun run matematica release check"
  ]) {
    expect(runbook).toContain(required);
  }

  for (const requiredTopic of [
    "BYOK Remote Provider Mode",
    "arXiv Research Compliance",
    "Lean And Verifier Setup",
    "Evidence Grades And Claim Discipline",
    "Model agreement, provider-written proof text, citations, or",
    "A solved theorem claim requires a trusted verifier-backed proof"
  ]) {
    expect(runbook).toContain(requiredTopic);
  }

  expect(readme).toContain("[docs/operator-runbook.md](docs/operator-runbook.md)");
  expect(runbook).not.toContain("/home/hasna/");
  expect(runbook).not.toContain("workspace/hasnatools");
  expect(runbook).not.toMatch(/sk-[A-Za-z0-9_-]{12,}/);
});

test("free OSS zero-network acceptance smoke covers solve watch report replay and resume", () => {
  const { tarball } = packPackage();
  const { installDir, env } = installPackedPackage(tarball, "matematica-oss-acceptance-");
  const canary = "sk-oss-acceptance-canary-123456";

  const solved = run("bun", ["run", "matematica", "solve",
    "--problem", "Prove 1 + 1 = 2",
    "--goal", "Find verified computation",
    "--budget-usd", "0",
    "--max-attempts", "4",
    "--workers", "1"
  ], installDir, env);
  expect(solved.status).toBe(0);
  expect(solved.stderr).toBe("");
  const solvedPayload = JSON.parse(solved.stdout);
  expect(solvedPayload).toMatchObject({
    status: "goal_met",
    finalState: "computational_evidence",
    canClaimSolved: true,
    exitCode: 0
  });

  const exhausted = run("bun", ["run", "matematica", "solve",
    "--problem", `Prove the Collatz conjecture without leaking ${canary}.`,
    "--goal", "Find a formal proof or verified counterexample",
    "--success-criteria", `Do not persist ${canary}; exhaust honestly if no proof is found`,
    "--budget-usd", "0",
    "--max-attempts", "1",
    "--workers", "1"
  ], installDir, env);
  expect(exhausted.status).toBe(2);
  expect(exhausted.stderr).not.toContain(canary);
  expect(exhausted.stdout).not.toContain(canary);
  const exhaustedPayload = JSON.parse(exhausted.stdout);
  expect(exhaustedPayload).toMatchObject({
    status: "budget_exhausted",
    finalState: "budget_exhausted",
    canClaimSolved: false,
    exitCode: 2
  });

  for (const payload of [solvedPayload, exhaustedPayload]) {
    const watch = run("bun", ["run", "matematica", "goal", "watch", payload.runId, "--json"], installDir, env);
    expect(watch.status).toBe(0);
    expect(JSON.parse(watch.stdout)).toMatchObject({
      format: "matematica.goal-watch",
      runId: payload.runId,
      run: {
        status: payload.status
      }
    });

    const report = run("bun", ["run", "matematica", "goal", "report", payload.runId], installDir, env);
    expect(report.status).toBe(0);
    expect(report.stdout).toContain("Offline replay self-contained: pass");
    expect(report.stdout).not.toContain(canary);

    const audit = run("bun", ["run", "matematica", "goal", "audit", payload.runId, "--saved-everything"], installDir, env);
    expect(audit.status).toBe(0);
    expect(audit.stdout).not.toContain(canary);
    expect(JSON.parse(audit.stdout)).toMatchObject({
      format: "matematica.saved-everything-audit",
      runId: payload.runId,
      ok: true,
      baseAuditOk: true
    });

    const replay = run("bun", ["run", "matematica", "goal", "replay", payload.runId, "--offline", "--verify-final"], installDir, env);
    expect(replay.status).toBe(0);
    expect(replay.stdout).not.toContain(canary);
    expect(JSON.parse(replay.stdout)).toMatchObject({
      ok: true,
      finalVerification: {
        ok: true
      }
    });

    const resume = run("bun", ["run", "matematica", "goal", "resume", payload.runId, "--offline"], installDir, env);
    expect(resume.status).toBe(payload.status === "goal_met" ? 0 : 2);
    expect(resume.stderr).not.toContain(canary);
    expect(resume.stdout).not.toContain(canary);
    expect(JSON.parse(resume.stdout)).toMatchObject({
      runId: payload.runId,
      status: payload.status,
      canClaimSolved: payload.canClaimSolved
    });
  }

  const ledger = new Ledger(join(String(env.MATEMATICA_HOME), "matematica.sqlite"));
  try {
    for (const runId of [solvedPayload.runId, exhaustedPayload.runId]) {
      const events = ledger.listEvents(runId);
      expect(events.map((event) => event.type)).not.toContain("external.operation.started");
      expect(JSON.stringify(events)).not.toContain(canary);
      expect(JSON.stringify(events)).not.toContain("\"liveNetworkUsed\":true");
      expect(JSON.stringify(events)).toContain("\"networkMode\":\"offline\"");
    }
    expect(ledger.listExternalOperations(solvedPayload.runId)).toHaveLength(0);
    expect(ledger.listExternalOperations(exhaustedPayload.runId)).toHaveLength(0);
  } finally {
    ledger.close();
  }

  const homeText = readPackedText(String(env.MATEMATICA_HOME));
  expect(homeText).not.toContain(canary);
  expect(homeText).not.toMatch(/sk-[A-Za-z0-9_-]{12,}/);

  const readme = readFileSync(join(process.cwd(), "README.md"), "utf8");
  for (const command of [
    "export MATEMATICA_LOCAL_ONLY=true",
    "unset OPENAI_API_KEY ANTHROPIC_API_KEY OPENROUTER_API_KEY CEREBRAS_API_KEY",
    "bun run matematica solve --problem \"Prove 1 + 1 = 2\"",
    "bun run matematica solve --problem \"Prove the Collatz conjecture.\"",
    "bun run matematica goal watch \"$RUN_ID\" --json",
    "bun run matematica goal report \"$RUN_ID\"",
    "bun run matematica goal audit \"$RUN_ID\" --saved-everything",
    "bun run matematica goal replay \"$RUN_ID\" --offline --verify-final",
    "bun run matematica goal resume \"$RUN_ID\" --offline"
  ]) {
    expect(readme).toContain(command);
  }
});

function packPackage(): { packDir: string; tarball: string } {
  const packDir = tempDir("matematica-pack-");
  const tarball = join(packDir, "hasna-matematica-0.0.1.tgz");
  const pack = run("bun", ["pm", "pack", "--destination", packDir, "--quiet"], process.cwd());
  expect(pack.status).toBe(0);
  expect(existsSync(tarball)).toBe(true);
  return { packDir, tarball };
}

function installPackedPackage(tarball: string, prefix: string): { installDir: string; env: NodeJS.ProcessEnv } {
  const installDir = tempDir(prefix);
  writeFileSync(join(installDir, "package.json"), JSON.stringify({
    private: true,
    type: "module",
    dependencies: {
      "@hasna/matematica": `file:${tarball}`
    }
  }, null, 2));
  const env = zeroProviderEnv({
    MATEMATICA_HOME: join(installDir, ".matematica"),
    MATEMATICA_LOCAL_ONLY: "true"
  });
  const install = run("bun", ["install", "--offline"], installDir, env);
  expect(install.status).toBe(0);
  return { installDir, env };
}

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = zeroProviderEnv()): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8"
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

function zeroProviderEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/(API|TOKEN|SECRET|CREDENTIAL|AUTH|KEY)/i.test(key)) continue;
    env[key] = value;
  }
  return {
    ...env,
    OPENAI_API_KEY: "",
    ANTHROPIC_API_KEY: "",
    OPENROUTER_API_KEY: "",
    CEREBRAS_API_KEY: "",
    ...extra
  };
}

function readPackedText(root: string): string {
  const chunks: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (/\.(ts|json|md|txt)$/.test(entry.name) || entry.name === "LICENSE" || entry.name === "NOTICE") {
        chunks.push(readFileSync(path, "utf8"));
      }
    }
  };
  visit(root);
  return chunks.join("\n");
}
