import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSandboxedCommand } from "../src/sandbox";

const homes: string[] = [];

afterEach(() => {
  while (homes.length > 0) {
    rmSync(homes.pop()!, { recursive: true, force: true });
  }
});

test("generated experiment sandbox strips provider secrets and hides caller HOME secrets", async () => {
  const home = mkdtempSync(join(tmpdir(), "matematica-sandbox-test-"));
  homes.push(home);
  const callerHome = join(home, "caller-home");
  mkdirSync(join(callerHome, ".secrets", "hasnaxyz", "openai"), { recursive: true });
  writeFileSync(join(callerHome, ".secrets", "hasnaxyz", "openai", "live.env"), "OPENAI_API_KEY=sk-live-secret\n");
  const tool = fakeExecutable(home, "generated-experiment", `
if [[ -n "\${OPENAI_API_KEY:-}" || -n "\${ANTHROPIC_API_KEY:-}" ]]; then
  echo "provider secret leaked" >&2
  exit 7
fi
if [[ -f "$HOME/.secrets/hasnaxyz/openai/live.env" ]]; then
  echo "caller home leaked" >&2
  exit 8
fi
echo "sandboxed"
`);

  const result = await runSandboxedCommand({
    purpose: "generated-experiment",
    command: [tool],
    cwd: home,
    timeoutMs: 1_000,
    env: {
      ...process.env,
      HOME: callerHome,
      OPENAI_API_KEY: "sk-test-secret",
      ANTHROPIC_API_KEY: "anthropic-test-secret"
    }
  });

  expect(result.exitCode).toBe(0);
  expect(result.stdout.trim()).toBe("sandboxed");
  expect(result.policy.environment.allowedKeys).not.toContain("OPENAI_API_KEY");
  expect(result.policy.environment.allowedKeys).not.toContain("ANTHROPIC_API_KEY");
  expect(result.policy.filesystem.sandboxHome).not.toBe(callerHome);
  expect(result.policy.isolation.environment).toBe("allowlist");
  expect(result.policy.isolation.shell).toBe("disabled");
  expect(result.policy.isolation.network).toBe("network_unenforced");
});

test("sandbox kills runaway generated experiments on wall-time budget", async () => {
  const home = mkdtempSync(join(tmpdir(), "matematica-sandbox-timeout-"));
  homes.push(home);
  const tool = fakeExecutable(home, "generated-timeout", "sleep 2");

  const result = await runSandboxedCommand({
    purpose: "generated-experiment",
    command: [tool],
    cwd: home,
    timeoutMs: 50
  });

  expect(result.timedOut).toBe(true);
  expect(result.stderr).toContain("timeout");
  expect(result.policy.resourceLimits.wallTimeMs).toBe(50);
});

test("sandbox abort signal kills hung generated experiments within bounded time", async () => {
  const home = mkdtempSync(join(tmpdir(), "matematica-sandbox-abort-"));
  homes.push(home);
  const tool = fakeExecutable(home, "generated-abort", "sleep 5");
  const controller = new AbortController();
  const startedAt = Date.now();

  const call = runSandboxedCommand({
    purpose: "generated-experiment",
    command: [tool],
    cwd: home,
    timeoutMs: 5_000,
    abortSignal: controller.signal
  });
  setTimeout(() => controller.abort(new Error("operator cancelled sandbox experiment")), 25);

  await expect(call).rejects.toThrow("operator cancelled sandbox experiment");
  expect(Date.now() - startedAt).toBeLessThan(1_000);
});

test("verifier sandbox rejects shell binaries", async () => {
  const home = mkdtempSync(join(tmpdir(), "matematica-sandbox-shell-"));
  homes.push(home);

  await expect(runSandboxedCommand({
    purpose: "verifier",
    command: ["/bin/sh", "-c", "echo unsafe"],
    cwd: home,
    timeoutMs: 1_000
  })).rejects.toThrow("forbidden verifier binary");
});

test("sandbox records network_unenforced for DNS fetch and socket attempts", async () => {
  const home = mkdtempSync(join(tmpdir(), "matematica-sandbox-network-"));
  homes.push(home);
  const script = join(home, "network_attempts.py");
  writeFileSync(script, `
import socket
import urllib.request

def attempt(name, fn):
    try:
        fn()
        print(name + ":ok")
    except Exception:
        print(name + ":blocked-or-failed")

attempt("dns", lambda: socket.getaddrinfo("example.com", 80))
attempt("fetch", lambda: urllib.request.urlopen("http://127.0.0.1:9", timeout=0.05).read())
attempt("socket", lambda: socket.create_connection(("127.0.0.1", 9), timeout=0.05).close())
`);

  const result = await runSandboxedCommand({
    purpose: "verifier",
    command: ["/usr/bin/python3", script],
    cwd: home,
    timeoutMs: 2_000
  });

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("dns:");
  expect(result.stdout).toContain("fetch:");
  expect(result.stdout).toContain("socket:");
  expect(result.policy.isolation.network).toBe("network_unenforced");
  expect(result.policy.unsupportedKernelFeatures).toContain("network_namespace");
  expect(result.policy.evidence.verifierBackedEvidence).toBe("barred_network_unenforced");
});

function fakeExecutable(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}
