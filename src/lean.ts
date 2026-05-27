import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "./artifacts";
import { isAbortError } from "./cancellation";
import { externalOperationIdempotencyKey, stableHash } from "./idempotency";
import type { Ledger } from "./ledger";
import { SANDBOX_POLICY_VERSION, type SandboxPolicy, runSandboxedCommand, sandboxAllowsVerifierBackedEvidence } from "./sandbox";
import { readArtifactText } from "./storage-encryption";
import type { LeanTrustedComputingBase } from "./evidence";

export type LeanVerificationStatus = "verified" | "failed";

export type LeanFailureKind =
  | "missing_definition"
  | "missing_theorem"
  | "wrong_formulation"
  | "import_issue"
  | "universe_or_typeclass"
  | "tactic_failure"
  | "timeout"
  | "sandbox_network_unenforced"
  | "contradiction"
  | "unknown";

export type LeanVerificationResult = {
  status: LeanVerificationStatus;
  exitCode: number | null;
  elapsedMs: number;
  failureKind?: LeanFailureKind;
  executionMode: "lean-direct" | "lake-env-lean";
  sourceHash: string;
  theoremNames: string[];
  toolchainHash: string;
  projectPinned?: boolean;
  leanToolchain?: string;
  mathlibRevision?: string;
  theoremStatements: Record<string, string>;
  theoremStatementHashes: Record<string, string>;
  leanBinaryHash?: string;
  lakeBinaryHash?: string;
  lakeManifestHash?: string;
  lakefileHash?: string;
  verifierCommand: string[];
  verifierCommandHash: string;
  exactExitResultHash?: string;
  tcb?: LeanTrustedComputingBase;
  inputArtifactId: string;
  projectArtifactId?: string;
  sandboxPolicyArtifactId?: string;
  sandboxPolicyHash?: string;
  stdoutArtifactId: string;
  stderrArtifactId: string;
  resultArtifactId: string;
};

export type LeanVerifyOptions = {
  runId: string;
  leanFilePath: string;
  ledger: Ledger;
  artifacts: ArtifactStore;
  leanBin?: string;
  lakeBin?: string;
  projectRoot?: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
};

export type LeanProjectInfo = {
  rootDir: string;
  pinned: boolean;
  leanToolchain?: string;
  lakeManifestPath?: string;
  lakefilePath?: string;
  mathlibVersion?: string;
  missing: string[];
};

export type LeanToolStatus = "ok" | "missing" | "failed";
export type LeanMathlibStatus = "ok" | "failed" | "skipped";

export type LeanToolProbe = {
  bin: string;
  status: LeanToolStatus;
  version?: string;
  exitCode?: number | null;
  error?: string;
};

export type LeanMathlibProbe = {
  status: LeanMathlibStatus;
  method: "lake-env-lean" | "lean-direct" | "none";
  cachePath: string;
  version?: string;
  exitCode?: number | null;
  error?: string;
};

export type LeanToolchainReport = {
  lean: LeanToolProbe;
  lake: LeanToolProbe;
  elan: LeanToolProbe;
  mathlib: LeanMathlibProbe;
};

export type LeanToolchainOptions = {
  rootDir?: string;
  leanBin?: string;
  lakeBin?: string;
  elanBin?: string;
  timeoutMs?: number;
};

export async function checkLeanToolchain(options: LeanToolchainOptions = {}): Promise<LeanToolchainReport> {
  const rootDir = options.rootDir ?? process.cwd();
  const timeoutMs = options.timeoutMs ?? 10_000;
  const leanBin = options.leanBin ?? "lean";
  const lakeBin = options.lakeBin ?? "lake";
  const elanBin = options.elanBin ?? "elan";

  const [lean, lake, elan] = await Promise.all([
    probeTool(leanBin, ["--version"], rootDir, timeoutMs),
    probeTool(lakeBin, ["--version"], rootDir, timeoutMs),
    probeTool(elanBin, ["--version"], rootDir, timeoutMs)
  ]);

  const mathlib = await probeMathlibImport({
    rootDir,
    leanBin,
    lakeBin,
    leanAvailable: lean.status === "ok",
    lakeAvailable: lake.status === "ok",
    timeoutMs
  });

  return { lean, lake, elan, mathlib };
}

export async function verifyLeanFile(options: LeanVerifyOptions): Promise<LeanVerificationResult> {
  const leanBin = options.leanBin ?? "lean";
  const lakeBin = options.lakeBin ?? "lake";
  const timeoutMs = options.timeoutMs ?? 30_000;
  const source = readFileSync(options.leanFilePath, "utf8");
  const sourceHash = createHash("sha256").update(source).digest("hex");
  const theoremNames = extractLeanDeclarationNames(source);
  const theoremStatements = extractLeanTheoremStatements(source);
  const theoremStatementHashes = Object.fromEntries(
    Object.entries(theoremStatements).map(([name, statement]) => [name, sha256Text(statement)])
  );
  const inputArtifact = options.artifacts.create(options.runId, "lean.input", source);
  const workDir = mkdtempSync(join(tmpdir(), "matematica-lean-"));
  const workFile = join(workDir, "Main.lean");
  writeFileSync(workFile, source);
  const projectInfo = options.projectRoot ? inspectLeanProject(options.projectRoot) : undefined;
  const projectArtifact = projectInfo
    ? options.artifacts.create(options.runId, "lean.project", JSON.stringify(projectInfo, null, 2))
    : undefined;
  const executionMode = projectInfo ? "lake-env-lean" : "lean-direct";
  const leanBinaryHash = hashExistingFile(leanBin);
  const lakeBinaryHash = projectInfo ? hashExistingFile(lakeBin) : undefined;
  const lakeManifestHash = projectInfo?.lakeManifestPath ? sha256File(projectInfo.lakeManifestPath) : undefined;
  const lakefileHash = projectInfo?.lakefilePath ? sha256File(projectInfo.lakefilePath) : undefined;
  const verifierCommand = projectInfo ? [lakeBin, "env", leanBin, "Main.lean"] : [leanBin, "Main.lean"];
  const verifierCommandHash = stableHash(verifierCommand);
  const toolchainHash = stableHash({
    leanBin,
    leanBinaryHash,
    lakeBin: projectInfo ? lakeBin : undefined,
    lakeBinaryHash,
    executionMode,
    leanToolchain: projectInfo?.leanToolchain,
    lakeManifestHash,
    lakefileHash,
    mathlibVersion: projectInfo?.mathlibVersion,
    projectPinned: projectInfo?.pinned ?? false
  });
  const request = {
    verifier: "lean4",
    sourceHash,
    theoremNames,
    toolchainHash,
    leanBin,
    leanBinaryHash,
    lakeBin: projectInfo ? lakeBin : undefined,
    lakeBinaryHash,
    executionMode,
    projectRoot: projectInfo?.rootDir,
    projectPinned: projectInfo?.pinned,
    leanToolchain: projectInfo?.leanToolchain,
    lakeManifestHash,
    lakefileHash,
    mathlibRevision: projectInfo?.mathlibVersion,
    theoremStatementHashes,
    verifierCommand,
    verifierCommandHash,
    sandboxPolicyVersion: SANDBOX_POLICY_VERSION,
    timeoutMs
  };
  const requestHash = stableHash(request);
  const prepared = options.ledger.prepareExternalOperation({
    runId: options.runId,
    operationType: "verifier.lean4",
    provider: "lean4",
    idempotencyKey: externalOperationIdempotencyKey({
      runId: options.runId,
      operationType: "verifier.lean4",
      requestHash
    }),
    requestHash,
    reserve: { attempts: 1, elapsedMs: 1 },
    requestArtifactId: inputArtifact.id
  });
  if (!prepared.ok) {
    throw new Error(`Budget exhausted before Lean verification: ${prepared.reason}`);
  }
  if (!prepared.created) {
    if (prepared.operation.status === "succeeded" && prepared.operation.responseArtifactId) {
      return cachedLeanResult(prepared.operation.responseArtifactId, options.ledger, options.runId);
    }
    throw new Error(`External operation ${prepared.operation.id} already exists in status ${prepared.operation.status}; refusing duplicate Lean verifier run.`);
  }
  const operation = options.ledger.startExternalOperation(prepared.operation.id);

  options.ledger.appendEvent(options.runId, "verifier.started", {
    verifier: "lean4",
    externalOperationId: operation.id,
    leanBin,
    leanBinaryHash,
    lakeBin: projectInfo ? lakeBin : undefined,
    lakeBinaryHash,
    executionMode,
    projectRoot: projectInfo?.rootDir,
    projectPinned: projectInfo?.pinned,
    leanToolchain: projectInfo?.leanToolchain,
    lakeManifestHash,
    lakefileHash,
    mathlibRevision: projectInfo?.mathlibVersion,
    theoremStatementHashes,
    verifierCommand,
    verifierCommandHash,
    reservationId: operation.reservationId,
    requestHash,
    inputArtifactId: inputArtifact.id,
    projectArtifactId: projectArtifact?.id,
    timeoutMs
  }, [inputArtifact.id, projectArtifact?.id].filter((id): id is string => Boolean(id)));

  if (projectInfo && !projectInfo.pinned) {
    const elapsedMs = 0;
    const stdoutArtifact = options.artifacts.create(options.runId, "lean.stdout", "");
    const stderrArtifact = options.artifacts.create(
      options.runId,
      "lean.stderr",
      `Lean project is not pinned. Missing: ${projectInfo.missing.join(", ")}`
    );
    const resultArtifact = options.artifacts.create(options.runId, "lean.result", JSON.stringify({
      status: "failed",
      verifier: "lean4",
      exitCode: null,
      elapsedMs,
      failureKind: "import_issue",
      sourceHash,
      theoremNames,
      theoremStatements,
      theoremStatementHashes,
      toolchainHash,
      leanBin,
      leanBinaryHash,
      lakeBin,
      lakeBinaryHash,
      executionMode,
      projectRoot: projectInfo.rootDir,
      projectPinned: projectInfo.pinned,
      leanToolchain: projectInfo.leanToolchain,
      lakeManifestHash,
      lakefileHash,
      mathlibRevision: projectInfo.mathlibVersion,
      verifierCommand,
      verifierCommandHash,
      sandboxPolicyVersion: SANDBOX_POLICY_VERSION,
      inputArtifactId: inputArtifact.id,
      projectArtifactId: projectArtifact?.id,
      stdoutArtifactId: stdoutArtifact.id,
      stderrArtifactId: stderrArtifact.id
    }, null, 2));
    options.ledger.appendEvent(options.runId, "verifier.completed", {
      verifier: "lean4",
      externalOperationId: operation.id,
      status: "failed",
      exitCode: null,
      elapsedMs,
      failureKind: "import_issue",
      executionMode,
      sourceHash,
      theoremNames,
      theoremStatementHashes,
      toolchainHash,
      projectRoot: projectInfo.rootDir,
      projectPinned: projectInfo.pinned,
      leanToolchain: projectInfo.leanToolchain,
      lakeManifestHash,
      lakefileHash,
      mathlibRevision: projectInfo.mathlibVersion,
      verifierCommand,
      verifierCommandHash,
      sandboxPolicyVersion: SANDBOX_POLICY_VERSION,
      reservationId: operation.reservationId,
      requestHash,
      inputArtifactId: inputArtifact.id,
      projectArtifactId: projectArtifact?.id,
      stdoutArtifactId: stdoutArtifact.id,
      stderrArtifactId: stderrArtifact.id,
      resultArtifactId: resultArtifact.id
    }, [inputArtifact.id, projectArtifact?.id, stdoutArtifact.id, stderrArtifact.id, resultArtifact.id].filter((id): id is string => Boolean(id)));
    options.ledger.failExternalOperation({
      operationId: operation.id,
      errorMessage: "Lean project is not pinned",
      releaseReason: "Lean project is not pinned",
      provider: "lean4"
    });
    return {
      status: "failed",
      exitCode: null,
      elapsedMs,
      failureKind: "import_issue",
      executionMode,
      sourceHash,
      theoremNames,
      theoremStatements,
      theoremStatementHashes,
      toolchainHash,
      projectPinned: projectInfo.pinned,
      leanToolchain: projectInfo.leanToolchain,
      mathlibRevision: projectInfo.mathlibVersion,
      leanBinaryHash,
      lakeBinaryHash,
      lakeManifestHash,
      lakefileHash,
      verifierCommand,
      verifierCommandHash,
      inputArtifactId: inputArtifact.id,
      projectArtifactId: projectArtifact?.id,
      stdoutArtifactId: stdoutArtifact.id,
      stderrArtifactId: stderrArtifact.id,
      resultArtifactId: resultArtifact.id
    };
  }

  const startedAt = Date.now();
  let stdout = "";
  let stderr = "";
  let exitCode: number | null = null;
  let sandboxPolicy: SandboxPolicy | undefined;
  try {
    const result = await runCommand(
      projectInfo ? [lakeBin, "env", leanBin, workFile] : [leanBin, workFile],
      projectInfo?.rootDir ?? workDir,
      timeoutMs,
      options.abortSignal
    );
    stdout = result.stdout;
    stderr = result.stderr;
    exitCode = result.exitCode;
    sandboxPolicy = result.sandboxPolicy;
  } catch (error) {
    stderr = error instanceof Error ? error.message : String(error);
  }
  const elapsedMs = Date.now() - startedAt;
  let status: LeanVerificationStatus = exitCode === 0 ? "verified" : "failed";
  let failureKind = status === "failed" ? classifyLeanFailure(`${stdout}\n${stderr}`) : undefined;
  if (isAbortError(new Error(stderr))) failureKind = "timeout";
  if (status === "verified" && sandboxPolicy && !sandboxAllowsVerifierBackedEvidence(sandboxPolicy)) {
    status = "failed";
    failureKind = "sandbox_network_unenforced";
    stderr = `${stderr}\nSandbox network isolation is unenforced; verifier-backed evidence is barred.`.trim();
  }
  const stdoutArtifact = options.artifacts.create(options.runId, "lean.stdout", stdout);
  const stderrArtifact = options.artifacts.create(options.runId, "lean.stderr", stderr);
  const sandboxPolicyArtifact = sandboxPolicy
    ? options.artifacts.create(options.runId, "sandbox.policy", JSON.stringify(sandboxPolicy, null, 2))
    : undefined;
  const stdoutHash = sha256Text(stdout);
  const stderrHash = sha256Text(stderr);
  const selectedTheoremName = theoremNames[0];
  const exactExitResultHash = stableHash({
    status,
    exitCode,
    failureKind,
    stdoutHash,
    stderrHash,
    sandboxPolicyHash: sandboxPolicy?.policyHash,
    theoremNames
  });
  const tcb = status === "verified" &&
    selectedTheoremName &&
    projectInfo?.pinned === true &&
    leanBinaryHash &&
    lakeBinaryHash &&
    projectInfo.leanToolchain &&
    lakeManifestHash &&
    lakefileHash &&
    projectInfo.mathlibVersion &&
    sandboxPolicy?.policyHash &&
    sandboxPolicyArtifact
    ? {
        format: "matematica.lean-tcb" as const,
        version: 1 as const,
        theoremName: selectedTheoremName,
        theoremStatementHash: theoremStatementHashes[selectedTheoremName] ?? "",
        proofFileHash: sourceHash,
        leanBinaryHash,
        lakeBinaryHash,
        leanToolchain: projectInfo.leanToolchain,
        lakeManifestHash,
        lakefileHash,
        mathlibRevision: projectInfo.mathlibVersion,
        verifierCommand,
        verifierCommandHash,
        sandboxPolicyHash: sandboxPolicy.policyHash,
        sandboxPolicyArtifactId: sandboxPolicyArtifact.id,
        exactExitResultHash,
        stdoutHash,
        stderrHash,
        exitCode: exitCode ?? -1
      }
    : undefined;
  const resultArtifact = options.artifacts.create(options.runId, "lean.result", JSON.stringify({
    status,
    verifier: "lean4",
    exitCode,
    elapsedMs,
    failureKind,
    sourceHash,
    theoremNames,
    theoremStatements,
    theoremStatementHashes,
    toolchainHash,
    leanBin,
    leanBinaryHash,
    lakeBin: projectInfo ? lakeBin : undefined,
    lakeBinaryHash,
    executionMode,
    projectRoot: projectInfo?.rootDir,
    projectPinned: projectInfo?.pinned,
    leanToolchain: projectInfo?.leanToolchain,
    lakeManifestHash,
    lakefileHash,
    mathlibRevision: projectInfo?.mathlibVersion,
    verifierCommand,
    verifierCommandHash,
    sandboxPolicyArtifactId: sandboxPolicyArtifact?.id,
    sandboxPolicyHash: sandboxPolicy?.policyHash,
    exactExitResultHash,
    tcb,
    inputArtifactId: inputArtifact.id,
    projectArtifactId: projectArtifact?.id,
    stdoutArtifactId: stdoutArtifact.id,
    stderrArtifactId: stderrArtifact.id
  }, null, 2));

  options.ledger.appendEvent(options.runId, "verifier.completed", {
    verifier: "lean4",
    externalOperationId: operation.id,
    status,
    exitCode,
    elapsedMs,
    failureKind,
    executionMode,
    sourceHash,
    theoremNames,
    theoremStatementHashes,
    toolchainHash,
    projectRoot: projectInfo?.rootDir,
    projectPinned: projectInfo?.pinned,
    leanToolchain: projectInfo?.leanToolchain,
    lakeManifestHash,
    lakefileHash,
    mathlibRevision: projectInfo?.mathlibVersion,
    verifierCommand,
    verifierCommandHash,
    sandboxPolicyArtifactId: sandboxPolicyArtifact?.id,
    sandboxPolicyHash: sandboxPolicy?.policyHash,
    sandboxPolicyVersion: SANDBOX_POLICY_VERSION,
    reservationId: operation.reservationId,
    requestHash,
    inputArtifactId: inputArtifact.id,
    projectArtifactId: projectArtifact?.id,
    stdoutArtifactId: stdoutArtifact.id,
    stderrArtifactId: stderrArtifact.id,
    resultArtifactId: resultArtifact.id
  }, [inputArtifact.id, projectArtifact?.id, sandboxPolicyArtifact?.id, stdoutArtifact.id, stderrArtifact.id, resultArtifact.id].filter((id): id is string => Boolean(id)));
  options.ledger.completeExternalOperation({
    operationId: operation.id,
    responseArtifactId: resultArtifact.id,
    debit: { attempts: 1, elapsedMs: Math.max(1, elapsedMs) },
    overReservationPolicy: {
      allowedDimensions: ["elapsedMs"],
      reason: "Lean verifier debits measured process elapsed time after reserving the verifier attempt."
    },
    provider: "lean4"
  });

  return {
    status,
    exitCode,
    elapsedMs,
    failureKind,
    executionMode,
    sourceHash,
    theoremNames,
    theoremStatements,
    theoremStatementHashes,
    toolchainHash,
    projectPinned: projectInfo?.pinned,
    leanToolchain: projectInfo?.leanToolchain,
    mathlibRevision: projectInfo?.mathlibVersion,
    leanBinaryHash,
    lakeBinaryHash,
    lakeManifestHash,
    lakefileHash,
    verifierCommand,
    verifierCommandHash,
    exactExitResultHash,
    tcb,
    inputArtifactId: inputArtifact.id,
    projectArtifactId: projectArtifact?.id,
    sandboxPolicyArtifactId: sandboxPolicyArtifact?.id,
    sandboxPolicyHash: sandboxPolicy?.policyHash,
    stdoutArtifactId: stdoutArtifact.id,
    stderrArtifactId: stderrArtifact.id,
    resultArtifactId: resultArtifact.id
  };
}

function cachedLeanResult(artifactId: string, ledger: Ledger, runId: string): LeanVerificationResult {
  const artifact = ledger.listArtifacts(runId).find((item) => item.id === artifactId);
  if (!artifact) throw new Error(`Cached Lean operation is missing artifact ${artifactId}.`);
  const parsed = JSON.parse(readArtifactText(artifact)) as Partial<LeanVerificationResult> & {
    status?: LeanVerificationStatus;
    exitCode?: number | null;
    elapsedMs?: number;
    executionMode?: "lean-direct" | "lake-env-lean";
    sourceHash?: string;
    theoremNames?: string[];
    theoremStatements?: Record<string, string>;
    theoremStatementHashes?: Record<string, string>;
    toolchainHash?: string;
    projectPinned?: boolean;
    leanToolchain?: string;
    mathlibRevision?: string;
    leanBinaryHash?: string;
    lakeBinaryHash?: string;
    lakeManifestHash?: string;
    lakefileHash?: string;
    verifierCommand?: string[];
    verifierCommandHash?: string;
    exactExitResultHash?: string;
    tcb?: LeanTrustedComputingBase;
    inputArtifactId?: string;
    sandboxPolicyArtifactId?: string;
    sandboxPolicyHash?: string;
    stdoutArtifactId?: string;
    stderrArtifactId?: string;
  };
  if (
    !parsed.status ||
    parsed.exitCode === undefined ||
    typeof parsed.elapsedMs !== "number" ||
    !parsed.executionMode ||
    !parsed.sourceHash ||
    !Array.isArray(parsed.theoremNames) ||
    !parsed.toolchainHash ||
    !parsed.inputArtifactId ||
    !parsed.stdoutArtifactId ||
    !parsed.stderrArtifactId
  ) {
    throw new Error(`Cached Lean result artifact ${artifactId} is incomplete.`);
  }
  return {
    status: parsed.status,
    exitCode: parsed.exitCode,
    elapsedMs: parsed.elapsedMs,
    failureKind: parsed.failureKind,
    executionMode: parsed.executionMode,
    sourceHash: parsed.sourceHash,
    theoremNames: parsed.theoremNames,
    theoremStatements: parsed.theoremStatements ?? {},
    theoremStatementHashes: parsed.theoremStatementHashes ?? {},
    toolchainHash: parsed.toolchainHash,
    projectPinned: parsed.projectPinned,
    leanToolchain: parsed.leanToolchain,
    mathlibRevision: parsed.mathlibRevision,
    leanBinaryHash: parsed.leanBinaryHash,
    lakeBinaryHash: parsed.lakeBinaryHash,
    lakeManifestHash: parsed.lakeManifestHash,
    lakefileHash: parsed.lakefileHash,
    verifierCommand: parsed.verifierCommand ?? [],
    verifierCommandHash: parsed.verifierCommandHash ?? "",
    exactExitResultHash: parsed.exactExitResultHash,
    tcb: parsed.tcb,
    inputArtifactId: parsed.inputArtifactId,
    projectArtifactId: parsed.projectArtifactId,
    sandboxPolicyArtifactId: parsed.sandboxPolicyArtifactId,
    sandboxPolicyHash: parsed.sandboxPolicyHash,
    stdoutArtifactId: parsed.stdoutArtifactId,
    stderrArtifactId: parsed.stderrArtifactId,
    resultArtifactId: artifactId
  };
}

export function inspectLeanProject(rootDir: string): LeanProjectInfo {
  const leanToolchainPath = join(rootDir, "lean-toolchain");
  const lakeManifestPath = join(rootDir, "lake-manifest.json");
  const lakefileTomlPath = join(rootDir, "lakefile.toml");
  const lakefileLeanPath = join(rootDir, "lakefile.lean");
  const leanToolchain = existsSync(leanToolchainPath) ? readFileSync(leanToolchainPath, "utf8").trim() : undefined;
  const lakefilePath = existsSync(lakefileTomlPath)
    ? lakefileTomlPath
    : existsSync(lakefileLeanPath)
      ? lakefileLeanPath
      : undefined;
  const missing = [
    leanToolchain ? undefined : "lean-toolchain",
    existsSync(lakeManifestPath) ? undefined : "lake-manifest.json",
    lakefilePath ? undefined : "lakefile.toml or lakefile.lean"
  ].filter((item): item is string => Boolean(item));

  return {
    rootDir,
    pinned: missing.length === 0,
    leanToolchain,
    lakeManifestPath: existsSync(lakeManifestPath) ? lakeManifestPath : undefined,
    lakefilePath,
    mathlibVersion: detectMathlibVersion(rootDir),
    missing
  };
}

type CommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  sandboxPolicy: SandboxPolicy;
};

async function probeTool(bin: string, args: string[], cwd: string, timeoutMs: number): Promise<LeanToolProbe> {
  try {
    const result = await runCommand([bin, ...args], cwd, timeoutMs);
    const output = firstLine(`${result.stdout}\n${result.stderr}`);
    if (result.exitCode === null && result.stderr.startsWith("Executable not found:")) {
      return {
        bin,
        status: "missing",
        error: result.stderr
      };
    }
    if (result.exitCode === 0) {
      return {
        bin,
        status: "ok",
        version: output || "available",
        exitCode: result.exitCode
      };
    }
    return {
      bin,
      status: "failed",
      version: output || undefined,
      exitCode: result.exitCode,
      error: result.timedOut ? "timed out" : firstLine(result.stderr || result.stdout) || "non-zero exit"
    };
  } catch (error) {
    return {
      bin,
      status: "missing",
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function probeMathlibImport(options: {
  rootDir: string;
  leanBin: string;
  lakeBin: string;
  leanAvailable: boolean;
  lakeAvailable: boolean;
  timeoutMs: number;
}): Promise<LeanMathlibProbe> {
  const cachePath = join(options.rootDir, ".lake");
  const version = detectMathlibVersion(options.rootDir);
  if (!options.leanAvailable) {
    return {
      status: "skipped",
      method: "none",
      cachePath,
      version,
      error: "lean unavailable"
    };
  }
  if (!options.lakeAvailable) {
    return {
      status: "skipped",
      method: "none",
      cachePath,
      version,
      error: "lake unavailable"
    };
  }

  const workDir = mkdtempSync(join(tmpdir(), "matematica-mathlib-check-"));
  const proofFile = join(workDir, "MathlibCheck.lean");
  writeFileSync(proofFile, "import Mathlib\n#check Nat\n");

  try {
    const result = await runCommand([options.lakeBin, "env", options.leanBin, proofFile], options.rootDir, options.timeoutMs);
    if (result.exitCode === 0) {
      return {
        status: "ok",
        method: "lake-env-lean",
        cachePath,
        version,
        exitCode: result.exitCode
      };
    }
    return {
      status: "failed",
      method: "lake-env-lean",
      cachePath,
      version,
      exitCode: result.exitCode,
      error: result.timedOut ? "timed out" : firstLine(result.stderr || result.stdout) || "mathlib import failed"
    };
  } catch (error) {
    return {
      status: "failed",
      method: "lake-env-lean",
      cachePath,
      version,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function runCommand(command: string[], cwd: string, timeoutMs: number, abortSignal?: AbortSignal): Promise<CommandResult> {
  const result = await runSandboxedCommand({
    purpose: "verifier",
    command,
    cwd,
    timeoutMs,
    abortSignal
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut,
    sandboxPolicy: result.policy
  };
}

function detectMathlibVersion(rootDir: string): string | undefined {
  const manifestPath = join(rootDir, "lake-manifest.json");
  if (!existsSync(manifestPath)) return undefined;

  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
    const mathlib = findMathlibEntry(parsed);
    if (!mathlib) return undefined;
    if (typeof mathlib.rev === "string") return mathlib.rev;
    if (typeof mathlib.version === "string") return mathlib.version;
    if (typeof mathlib.url === "string") return mathlib.url;
    return JSON.stringify(mathlib);
  } catch {
    return undefined;
  }
}

function findMathlibEntry(value: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findMathlibEntry(item);
      if (found) return found;
    }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;

  const record = value as Record<string, unknown>;
  if (record.name === "mathlib") return record;
  for (const item of Object.values(record)) {
    const found = findMathlibEntry(item);
    if (found) return found;
  }
  return undefined;
}

function extractLeanDeclarationNames(source: string): string[] {
  const names = new Set<string>();
  const pattern = /^\s*(?:private\s+|protected\s+)?(?:theorem|lemma)\s+([A-Za-z_][A-Za-z0-9_'.]*)/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    names.add(match[1]);
  }
  return [...names].sort();
}

function extractLeanTheoremStatements(source: string): Record<string, string> {
  const statements: Record<string, string> = {};
  const pattern = /^\s*(?:private\s+|protected\s+)?(?:theorem|lemma)\s+([A-Za-z_][A-Za-z0-9_'.]*)/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const name = match[1];
    const start = match.index;
    const next = source.slice(pattern.lastIndex).search(/^\s*(?:private\s+|protected\s+)?(?:theorem|lemma)\s+[A-Za-z_]/m);
    const end = next === -1 ? source.length : pattern.lastIndex + next;
    const declaration = source.slice(start, end);
    const beforeBody = declaration.split(":=")[0]?.trim() ?? declaration.trim();
    statements[name] = beforeBody.replace(/\s+/g, " ");
  }
  return statements;
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}

function hashExistingFile(path: string): string | undefined {
  return existsSync(path) ? sha256File(path) : undefined;
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function classifyLeanFailure(output: string): LeanFailureKind {
  const text = output.toLowerCase();
  if (text.includes("timeout") || text.includes("timed out")) return "timeout";
  if (text.includes("sandbox network isolation is unenforced") || text.includes("network_unenforced")) return "sandbox_network_unenforced";
  if (text.includes("unknown package") || text.includes("unknown module") || text.includes("no such file") || text.includes("import")) return "import_issue";
  if (text.includes("unknown identifier") || text.includes("unknown constant")) return "missing_definition";
  if (text.includes("declaration uses sorry") || text.includes("admit") || text.includes("unsolved goals") || text.includes("tactic")) return "tactic_failure";
  if (text.includes("failed to synthesize") || text.includes("typeclass") || text.includes("universe")) return "universe_or_typeclass";
  if (text.includes("contradiction") || text.includes("false")) return "contradiction";
  if (text.includes("does not match") || text.includes("type mismatch")) return "wrong_formulation";
  if (text.includes("unknown theorem") || text.includes("theorem")) return "missing_theorem";
  return "unknown";
}
