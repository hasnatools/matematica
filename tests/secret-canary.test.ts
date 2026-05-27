import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli";
import { Ledger } from "../src/ledger";
import { getAppPaths } from "../src/paths";

const homes: string[] = [];

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "matematica-secret-canary-"));
  homes.push(home);
  process.env.MATEMATICA_HOME = home;
  return home;
}

afterEach(() => {
  delete process.env.MATEMATICA_HOME;
  delete process.env.OPENAI_API_KEY;
  delete process.env.HASNA_TEST_TOKEN;
  delete process.env.MATEMATICA_LOCAL_BASE_URL;
  delete process.env.MATEMATICA_LOCAL_MODEL;
  while (homes.length > 0) {
    rmSync(homes.pop()!, { recursive: true, force: true });
  }
});

test("whole-run secret canary scan covers DB artifacts replay report and config", async () => {
  const home = tempHome();
  const envSecret = "sk-test-end-to-end-canary-123456";
  const envToken = "env-token-canary-123456789";
  const bearerSecret = "Bearer bearer-canary-token-123456";
  const urlToken = "url-token-canary-123456789";
  const urlPassword = "url-password-canary-123456789";
  process.env.OPENAI_API_KEY = envSecret;
  process.env.HASNA_TEST_TOKEN = envToken;
  process.env.MATEMATICA_LOCAL_BASE_URL = `http://user:${urlPassword}@localhost:11434/v1?api_key=${urlToken}`;
  process.env.MATEMATICA_LOCAL_MODEL = "local-canary";

  const createdOutput = await runCli([
    "goal",
    "create",
    "--problem",
    `Do not persist ${envSecret} ${envToken} ${bearerSecret}`,
    "--goal",
    `Keep ${envToken} out of every stored surface`,
    "--success-criteria",
    `redact ${envSecret}; redact ${bearerSecret}`,
    "--max-attempts",
    "10",
    "--max-tokens",
    "500"
  ]);
  const created = JSON.parse(createdOutput);

  const researchOutput = await runCli([
    "research",
    "arxiv",
    "--query",
    `all:${envToken}`,
    "--run-id",
    created.id,
    "--allow-network"
  ], process.cwd(), {
    arxivSearch: async () => [{
      id: "paper-secret-canary",
      title: `Title with ${envSecret}`,
      summary: `Abstract with ${envToken} and ${bearerSecret}`,
      authors: ["Ada"],
      published: "2024-01-01T00:00:00Z",
      updated: "2024-01-01T00:00:00Z",
      absUrl: `https://example.test/abs?token=${urlToken}`,
      pdfUrl: `https://example.test/pdf?api_key=${urlToken}`,
      categories: ["math.LO"]
    }]
  });

  await runCli([
    "providers",
    "smoke",
    "--provider",
    "openai",
    "--run-id",
    created.id,
    "--max-call-usd",
    "0.02",
    "--prompt",
    `Provider prompt includes ${envToken}`
  ], process.cwd(), {
    generateText: async () => ({
      text: `generated code output includes ${envSecret} and ${envToken}`,
      usage: { inputTokens: 7, outputTokens: 5, totalTokens: 12 },
      finishReason: "stop",
      providerMetadata: {
        debug: `metadata ${envToken}`,
        callbackUrl: `https://example.test/callback?access_token=${urlToken}`
      }
    })
  });

  await expect(runCli([
    "providers",
    "smoke",
    "--provider",
    "openai",
    "--run-id",
    created.id,
    "--max-call-usd",
    "0.02",
    "--prompt",
    "fail with secret"
  ], process.cwd(), {
    generateText: async () => {
      throw new Error(`provider error leaked ${envSecret} ${envToken}`);
    }
  })).rejects.toThrow("<redacted>");

  const leanFile = join(home, "Canary.lean");
  writeFileSync(leanFile, `#eval "${envToken}"\n`);
  const leanBin = join(home, "fake-lean.sh");
  writeFileSync(leanBin, [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `echo "stdout ${envToken}"`,
    `echo "stderr ${envSecret}" >&2`,
    "exit 0"
  ].join("\n"));
  chmodSync(leanBin, 0o755);
  await runCli([
    "goal",
    "verify-lean",
    created.id,
    "--file",
    leanFile,
    "--lean-bin",
    leanBin
  ]);

  const replay = await runCli(["goal", "replay", created.id]);
  const report = await runCli(["goal", "report", created.id]);
  const config = await runCli(["config", "show"]);
  const providers = await runCli(["providers", "list"]);
  const paths = getAppPaths();
  const ledger = new Ledger(paths.dbPath);
  let persisted = "";
  try {
    persisted = [
      createdOutput,
      researchOutput,
      replay,
      report,
      config,
      providers,
      readFileSync(paths.dbPath, "utf8"),
      ...ledger.listArtifacts(created.id).map((artifact) => readFileSync(artifact.path, "utf8"))
    ].join("\n");
  } finally {
    ledger.close();
  }

  for (const secret of [envSecret, envToken, bearerSecret, urlToken, urlPassword]) {
    expect(persisted).not.toContain(secret);
  }
  expect(persisted).toContain("<redacted>");
});
