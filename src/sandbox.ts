import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { abortErrorFromSignal, throwIfAborted, type CancellationSettlement } from "./cancellation";
import { stableHash } from "./idempotency";

export const SANDBOX_POLICY_VERSION = "sandbox-policy-v1";
export const SANDBOX_DEFAULT_MEMORY_BYTES = 1_073_741_824;
export const SANDBOX_DEFAULT_MAX_PROCESSES = 64;

export type SandboxPurpose = "verifier" | "generated-experiment";

export type SandboxPolicy = {
  version: typeof SANDBOX_POLICY_VERSION;
  purpose: SandboxPurpose;
  command: string[];
  cwd: string;
  timeoutMs: number;
  resourceLimits: {
    wallTimeMs: number;
    cpuTimeSeconds: number;
    memoryBytes: number;
    maxProcesses: number;
  };
  isolation: {
    environment: "allowlist";
    filesystem: "sandbox-home-and-tmp";
    network: "blocked-by-kernel" | "network_unenforced";
    shell: "disabled";
    resourceLimits: "prlimit" | "portable-timeout";
    wallTime: "gnu-timeout" | "bun-timer";
  };
  evidence: {
    verifierBackedEvidence: "allowed" | "barred_network_unenforced" | "not_applicable";
  };
  environment: {
    allowedKeys: string[];
    forcedKeys: string[];
    blockedSecretPatterns: string[];
  };
  filesystem: {
    sandboxHome: string;
    sandboxTmp: string;
    workingDirectory: string;
    allowedWritableRoots: string[];
  };
  unsupportedKernelFeatures: string[];
  policyHash: string;
};

export type SandboxCommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  cancellationSettlement?: CancellationSettlement;
  policy: SandboxPolicy;
  effectiveCommand: string[];
};

export type SandboxRunOptions = {
  purpose: SandboxPurpose;
  command: string[];
  cwd: string;
  timeoutMs: number;
  memoryBytes?: number;
  cpuTimeSeconds?: number;
  maxProcesses?: number;
  env?: Record<string, string | undefined>;
  extraAllowedEnv?: Record<string, string>;
  forbiddenExecutableNames?: string[];
  abortSignal?: AbortSignal;
};

const DEFAULT_SAFE_PATH = "/usr/local/bin:/usr/bin:/bin";
const BLOCKED_SECRET_PATTERNS = [
  "API_KEY",
  "ACCESS_TOKEN",
  "AUTH_TOKEN",
  "BEARER_TOKEN",
  "SECRET",
  "PASSWORD",
  "CREDENTIAL",
  "PRIVATE_KEY",
  "OPENAI_",
  "ANTHROPIC_",
  "OPENROUTER_",
  "CEREBRAS_"
];

const DEFAULT_ALLOWED_ENV_KEYS = ["PATH", "LANG", "LC_ALL", "TZ"];
const DEFAULT_FORBIDDEN_EXECUTABLE_NAMES = new Set([
  "bash",
  "dash",
  "fish",
  "sh",
  "zsh"
]);

export async function runSandboxedCommand(options: SandboxRunOptions): Promise<SandboxCommandResult> {
  throwIfAborted(options.abortSignal, "Sandbox command aborted before start.");
  if (options.command.length === 0 || !options.command[0]) {
    throw new Error("Sandbox command cannot be empty.");
  }
  assertVerifierCommandIsNotShell(options.command, options.forbiddenExecutableNames);

  const timeoutMs = Math.max(1, Math.trunc(options.timeoutMs));
  const resourceLimits = {
    wallTimeMs: timeoutMs,
    cpuTimeSeconds: options.cpuTimeSeconds ?? Math.max(1, Math.ceil(timeoutMs / 1000)),
    memoryBytes: options.memoryBytes ?? SANDBOX_DEFAULT_MEMORY_BYTES,
    maxProcesses: options.maxProcesses ?? SANDBOX_DEFAULT_MAX_PROCESSES
  };
  const sandboxRoot = mkdtempSync(join(tmpdir(), "matematica-sandbox-"));
  const sandboxHome = join(sandboxRoot, "home");
  const sandboxTmp = join(sandboxRoot, "tmp");
  mkdirSync(sandboxHome, { recursive: true });
  mkdirSync(sandboxTmp, { recursive: true });
  const prlimit = findExecutable(["/usr/bin/prlimit", "/bin/prlimit"]);
  const timeoutBin = findExecutable(["/usr/bin/timeout", "/bin/timeout"]);
  const env = buildSandboxEnv({
    sourceEnv: options.env ?? process.env,
    sandboxHome,
    sandboxTmp,
    extraAllowedEnv: options.extraAllowedEnv
  });
  const resourceCommand = prlimit
    ? [
        prlimit,
        `--as=${resourceLimits.memoryBytes}`,
        `--cpu=${resourceLimits.cpuTimeSeconds}`,
        "--",
        ...options.command
      ]
    : options.command;
  const effectiveCommand = timeoutBin
    ? [
        timeoutBin,
        "--kill-after=1s",
        `${timeoutMs / 1000}s`,
        ...resourceCommand
      ]
    : resourceCommand;
  const policy = buildSandboxPolicy({
    purpose: options.purpose,
    command: options.command,
    cwd: options.cwd,
    timeoutMs,
    resourceLimits,
    sandboxHome,
    sandboxTmp,
    resourceLimitBackend: prlimit ? "prlimit" : "portable-timeout",
    wallTimeBackend: timeoutBin ? "gnu-timeout" : "bun-timer"
  });

  if (options.command[0].includes("/") && !existsSync(options.command[0])) {
    return {
      stdout: "",
      stderr: `Executable not found: ${options.command[0]}`,
      exitCode: null,
      timedOut: false,
      aborted: false,
      policy,
      effectiveCommand
    };
  }

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(effectiveCommand, {
      cwd: options.cwd,
      stdout: "pipe",
      stderr: "pipe",
      env
    });
  } catch (error) {
    return {
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      exitCode: null,
      timedOut: false,
      aborted: false,
      policy,
      effectiveCommand
    };
  }
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutBin ? timeoutMs + 1_500 : timeoutMs);
  let removeAbortListener: (() => void) | undefined;
  const abortPromise = new Promise<never>((_, reject) => {
    const signal = options.abortSignal;
    if (!signal) return;
    const onAbort = () => {
      proc.kill();
      reject(abortErrorFromSignal(signal, "Sandbox command aborted."));
    };
    if (signal.aborted) onAbort();
    else {
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    }
  });
  const outputPromise = Promise.all([
    new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
    new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
    proc.exited
  ]);
  outputPromise.catch(() => undefined);
  try {
    const [stdout, stderr, exitCode] = await Promise.race([outputPromise, abortPromise]);
    const commandTimedOut = timedOut || exitCode === 124 || exitCode === 137;
    return {
      stdout,
      stderr: commandTimedOut ? `${stderr}\ntimeout`.trim() : stderr,
      exitCode,
      timedOut: commandTimedOut,
      aborted: false,
      policy,
      effectiveCommand
    };
  } finally {
    clearTimeout(timeout);
    removeAbortListener?.();
  }
}

export function sandboxAllowsVerifierBackedEvidence(policy: SandboxPolicy): boolean {
  return policy.evidence.verifierBackedEvidence === "allowed";
}

function buildSandboxPolicy(input: {
  purpose: SandboxPurpose;
  command: string[];
  cwd: string;
  timeoutMs: number;
  resourceLimits: SandboxPolicy["resourceLimits"];
  sandboxHome: string;
  sandboxTmp: string;
  resourceLimitBackend: SandboxPolicy["isolation"]["resourceLimits"];
  wallTimeBackend: SandboxPolicy["isolation"]["wallTime"];
}): SandboxPolicy {
  const networkBackend = detectNetworkIsolationBackend();
  const policyWithoutHash = {
    version: SANDBOX_POLICY_VERSION,
    purpose: input.purpose,
    command: input.command,
    cwd: input.cwd,
    timeoutMs: input.timeoutMs,
    resourceLimits: input.resourceLimits,
    isolation: {
      environment: "allowlist" as const,
      filesystem: "sandbox-home-and-tmp" as const,
      network: networkBackend,
      shell: "disabled" as const,
      resourceLimits: input.resourceLimitBackend,
      wallTime: input.wallTimeBackend
    },
    evidence: {
      verifierBackedEvidence: input.purpose === "verifier"
        ? networkBackend === "blocked-by-kernel"
          ? "allowed" as const
          : "barred_network_unenforced" as const
        : "not_applicable" as const
    },
    environment: {
      allowedKeys: [...DEFAULT_ALLOWED_ENV_KEYS, "HOME", "TMPDIR", "MATEMATICA_SANDBOX"].sort(),
      forcedKeys: ["HOME", "TMPDIR", "MATEMATICA_SANDBOX"].sort(),
      blockedSecretPatterns: [...BLOCKED_SECRET_PATTERNS].sort()
    },
    filesystem: {
      sandboxHome: input.sandboxHome,
      sandboxTmp: input.sandboxTmp,
      workingDirectory: input.cwd,
      allowedWritableRoots: [input.sandboxHome, input.sandboxTmp, input.cwd].sort()
    },
    unsupportedKernelFeatures: unsupportedKernelFeatures(input.resourceLimitBackend, networkBackend)
  } satisfies Omit<SandboxPolicy, "policyHash">;
  return {
    ...policyWithoutHash,
    policyHash: stableHash(policyWithoutHash)
  };
}

function detectNetworkIsolationBackend(): SandboxPolicy["isolation"]["network"] {
  return "network_unenforced";
}

function buildSandboxEnv(input: {
  sourceEnv: Record<string, string | undefined>;
  sandboxHome: string;
  sandboxTmp: string;
  extraAllowedEnv?: Record<string, string>;
}): Record<string, string> {
  const env: Record<string, string> = {
    PATH: input.sourceEnv.PATH || DEFAULT_SAFE_PATH,
    HOME: input.sandboxHome,
    TMPDIR: input.sandboxTmp,
    MATEMATICA_SANDBOX: "1"
  };
  for (const key of ["LANG", "LC_ALL", "TZ"]) {
    const value = input.sourceEnv[key];
    if (typeof value === "string" && !isSecretEnvName(key)) env[key] = value;
  }
  for (const [key, value] of Object.entries(input.extraAllowedEnv ?? {})) {
    if (isSecretEnvName(key)) {
      throw new Error(`Sandbox extra environment key ${key} is blocked by secret policy.`);
    }
    env[key] = value;
  }
  return env;
}

function assertVerifierCommandIsNotShell(command: string[], forbiddenExecutableNames?: string[]): void {
  const executable = basename(command[0] ?? "");
  const forbidden = new Set([
    ...DEFAULT_FORBIDDEN_EXECUTABLE_NAMES,
    ...(forbiddenExecutableNames ?? []).map((name) => basename(name))
  ]);
  if (forbidden.has(executable)) {
    throw new Error(`Sandbox refuses to execute forbidden verifier binary "${executable}".`);
  }
}

function isSecretEnvName(key: string): boolean {
  return BLOCKED_SECRET_PATTERNS.some((pattern) => key.toUpperCase().includes(pattern));
}

function findExecutable(paths: string[]): string | undefined {
  return paths.find((path) => existsSync(path));
}

function unsupportedKernelFeatures(
  resourceLimitBackend: SandboxPolicy["isolation"]["resourceLimits"],
  networkBackend: SandboxPolicy["isolation"]["network"]
): string[] {
  const unsupported = [
    networkBackend === "network_unenforced" ? "network_namespace" : undefined,
    "mount_namespace",
    "process_count_limit"
  ].filter((item): item is string => Boolean(item));
  if (resourceLimitBackend === "portable-timeout") unsupported.push("kernel_memory_cpu_limits");
  return unsupported;
}
