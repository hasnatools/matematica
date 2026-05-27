import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { ArtifactStore } from "./artifacts";
import { buildAiSdkCompatibilityReport } from "./ai-sdk-compat";
import type { GenerateTextFunction } from "./ai/instrumented";
import { auditRun, auditSavedEverything } from "./audit";
import type { BudgetUsage } from "./budget";
import { buildHardMathBenchmarkLadder, formatHardMathBenchmarkLadder, runHostileMathBenchmarkGate, runZeroFalseSolvedReleaseGate, validateHardMathBenchmarkLadder } from "./benchmarks";
import { loadConfig, providerSummary, publicConfig, type ProviderName } from "./config";
import { defaultBudget, isTerminalStatus, normalizeBudget, parseWorkflow, type Artifact, type GoalRun, type LedgerEvent, type EvidenceGrade, type WorkerJob } from "./domain";
import type { ClaimType, FormalizationAssessment, VerifierStatus } from "./evidence";
import { EXECUTION_CONTRACT, formatExecutionContract, validateExecutionContract } from "./execution-contract";
import { recordFormalizationAssessment, recordTheoremEquivalenceReview } from "./formalization";
import { generateInstrumentedText } from "./ai/instrumented";
import {
  formatSharedImplementationPlanRegistryMirror,
  readSharedImplementationPlanRegistryMirror,
  validateSharedImplementationPlanRegistryMirror
} from "./implementation-plan-registry";
import { externalOperationIdempotencyKey, stableHash } from "./idempotency";
import { Ledger, type ExternalOperation } from "./ledger";
import { formatMilestonePlan, RELEASE_MILESTONE_PLAN, validateMilestonePlan } from "./milestones";
import { networkPolicy } from "./network-policy";
import { buildOutputTrustContract, followUpReplayCommand } from "./output-trust";
import { hostileProviderDryRunPrompt, persistHostileLiveProviderDryRunReview } from "./provider-dry-run";
import { checkLeanToolchain, type LeanMathlibProbe, type LeanToolProbe, verifyLeanFile } from "./lean";
import { getAppPaths } from "./paths";
import { persistProblemClassificationReview, type ProblemClass } from "./problem-classifier";
import { buildReleaseDoctorReport, formatReleaseDoctorReport } from "./release-doctor";
import { readReleaseLiveTodosSnapshot } from "./release-todos";
import {
  readReleaseEvidenceFreshnessManifest,
  validateReleaseEvidenceFreshness
} from "./release-evidence";
import { formatReleaseWorkflowReport, runReleaseWorkflow } from "./release-workflow";
import { CANONICAL_RELEASE_PLAN, formatCanonicalReleasePlan, validateCanonicalReleasePlan } from "./release-plan";
import { resolveModel } from "./providers";
import { arxivCompliancePolicy, searchArxiv, type ArxivPaper } from "./research/arxiv";
import { fetchArxivWithCache, pruneArxivCache, updateArxivCacheReview } from "./research/arxiv-cache";
import { buildArxivSourceRecords, claimedCitationFromSourceRecord, validateCitations } from "./research/citations";
import { buildArxivResearchEnrichment, type ArxivResearchEnrichment } from "./research/enrichment";
import { evaluateLiteratureRetrieval } from "./research/evaluation";
import { quarantineArxivPapers } from "./research/security";
import { persistRunReport } from "./report";
import { admitRemoteCompute } from "./remote-admission";
import { buildReplayManifest, exportReproducibilityBundle, importReproducibilityBundle, replayOffline } from "./replay";
import { reconcileGoalRunForResume } from "./resume";
import { runGoal } from "./runner";
import { scoreEvidence } from "./scoring";
import { redactJson, redactText } from "./redaction";
import { initializeEncryptedHome, readArtifactText } from "./storage-encryption";
import { normalizeTheoremCandidate } from "./theorem";
import {
  buildProviderLegalPrivacyGateReport,
  pinProviderMatrix,
  providerCapabilityMatrix
} from "./provider-capabilities";
import { runSwarmKillDrillSuite } from "./swarm-kill-drill";
import { runSwarmStressGate } from "./swarm-stress-gate";
import { persistSwarmAdmissionPreview } from "./swarm-admission";

export type RunCliOptions = {
  generateText?: GenerateTextFunction;
  arxivSearch?: (query: string, options: { maxResults: number; abortSignal?: AbortSignal }) => Promise<ArxivPaper[]>;
};

type ParsedArgs = {
  positional: string[];
  flags: Map<string, string | boolean>;
};

export async function main(argv: string[]): Promise<void> {
  try {
    const output = await runCli(argv);
    if (output) console.log(output);
    const exitCode = exitCodeForTerminalCommand(argv, output);
    if (exitCode !== undefined) process.exitCode = exitCode;
  } catch (error) {
    console.error(redactText(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  }
}

export async function runCli(argv: string[], cwd = process.cwd(), options: RunCliOptions = {}): Promise<string> {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    return help();
  }

  const [command, subcommand, ...rest] = argv;
  const paths = getAppPaths(cwd);
  const config = loadConfig(paths.root);
  const ledger = new Ledger(paths.dbPath);
  const artifacts = new ArtifactStore(paths.artifactsDir, ledger);

  try {
    if (command === "solve") {
      const parsed = parseArgs(argv.slice(1));
      const problem = redactPrivateCliText(readProblem(parsed), parsed);
      const goal = redactPrivateCliText(requiredString(parsed, "goal"), parsed);
      const workflow = parseWorkflow(optionalString(parsed, "workflow") ?? config.defaultWorkflow);
      const successCriteria = optionalString(parsed, "success-criteria")
        ?.split(";")
        .map((item) => item.trim())
        .filter(Boolean) ?? ["Produce verifier-backed evidence or exhaust the configured budget."];
      const redactedSuccessCriteria = successCriteria.map((item) => redactPrivateCliText(item, parsed));
      const budget = normalizeBudget({
        ...defaultBudget(),
        maxUsd: requiredNumberAlias(parsed, "budget-usd", ["usd"]),
        maxTokens: optionalNumber(parsed, "max-tokens"),
        maxWallTimeMs: optionalHours(parsed, "max-hours"),
        maxAttempts: optionalNumber(parsed, "max-attempts"),
        maxWorkers: optionalNumberAlias(parsed, "workers", ["agents"]) ?? config.defaultMaxWorkers,
        maxArtifactBytes: optionalNumber(parsed, "max-artifact-bytes"),
        maxSourceQueries: optionalNumber(parsed, "max-source-queries"),
        maxRetries: optionalNumber(parsed, "max-retries"),
        maxSandboxMs: optionalNumber(parsed, "max-sandbox-ms")
      });
      const run = ledger.createRun({ problem, goal, successCriteria: redactedSuccessCriteria, workflow, budget });
      artifacts.create(run.id, "problem.input", problem);

      const maxOutputTokens = optionalNumber(parsed, "max-output-tokens") ?? 800;
      const maxCallUsd = optionalNumber(parsed, "max-call-usd");
      const policy = networkPolicy({ config, offlineRequested: hasPrivacyOffline(parsed), networkRequested: hasNetworkOptIn(parsed) });
      recordCliPrivacyPolicy({ runId: run.id, command: "solve", parsed, ledger, artifacts });
      const branchModels = buildBranchModels({
        command: "goal run",
        parsed,
        config,
        localOnly: policy.offline,
        ledger,
        artifacts,
        runId: run.id,
        maxOutputTokens,
        maxCallUsd,
        temperature: optionalNumber(parsed, "temperature"),
        providerConcurrency: optionalNumber(parsed, "provider-concurrency"),
        explicitRemoteConsent: hasRemoteCostConsent(parsed),
        generate: options.generateText
      });
      const result = await runGoal(run.id, ledger, artifacts, {
        arxivSearch: options.arxivSearch,
        offline: policy.offline,
        offlineReason: policy.reason,
        cwd,
        config,
        branchModels,
        swarmAdmissionConfirmed: hasSwarmAdmissionConfirmation(parsed),
        providerDiversityWaiver: providerDiversityWaiver(parsed),
        problemClassOverride: optionalProblemClass(parsed)
      });
      const exitCode = exitCodeForRunStatus(result.status);
      const completedRun = ledger.requireRun(run.id);
      return JSON.stringify({
        runId: run.id,
        createdAt: run.createdAt,
        workflow: run.workflow,
        budget: run.budget,
        ...result,
        outputTrust: buildOutputTrustContract({
          run: completedRun,
          events: ledger.listEvents(run.id),
          replayCommand: followUpReplayCommand(run.id)
        }),
        exitCode,
        commands: followUpCommands(run.id)
      }, null, 2);
    }

    if (command === "doctor") {
      const parsed = parseArgs(argv.slice(1));
      if (hasFlag(parsed, "release")) {
        const report = buildReleaseDoctorReport({
          cwd,
          config,
          requireRemoteSwarmLiveDryRun: hasFlag(parsed, "remote-swarm"),
          ledgerMode: hasFlag(parsed, "clean-home") ? "clean-home" : "current-home",
          liveTodosSnapshot: readReleaseLiveTodosSnapshot({ cwd })
        });
        if (!report.ok) {
          throw new Error(`Matematica release doctor failed:\n${formatReleaseDoctorReport(report)}`);
        }
        if (hasFlag(parsed, "json")) return JSON.stringify(report, null, 2);
        return formatReleaseDoctorReport(report);
      }
      const providerPolicyGate = buildProviderLegalPrivacyGateReport({
        providers: providerCapabilityMatrix(config)
      });
      const aiSdkCompatibility = buildAiSdkCompatibilityReport();
      if (!aiSdkCompatibility.ok) {
        const issues = aiSdkCompatibility.checks.flatMap((check) => check.issues.map((issue) => `${check.id}: ${issue}`));
        throw new Error(`AI SDK compatibility gate failed:\n${issues.join("\n")}`);
      }
      if (!providerPolicyGate.ok) {
        throw new Error(formatProviderLegalPrivacyGate(providerPolicyGate));
      }
      const leanToolchain = await checkLeanToolchain({
        rootDir: cwd,
        leanBin: optionalString(parsed, "lean-bin") ?? process.env.MATEMATICA_LEAN_BIN,
        lakeBin: optionalString(parsed, "lake-bin") ?? process.env.MATEMATICA_LAKE_BIN,
        elanBin: optionalString(parsed, "elan-bin") ?? process.env.MATEMATICA_ELAN_BIN,
        timeoutMs: optionalNumber(parsed, "timeout-ms")
      });
      return [
        "Matematica doctor",
        `Bun: ${Bun.version}`,
        `Home: ${paths.root}`,
        `Database: ${paths.dbPath}`,
        `Artifacts: ${paths.artifactsDir}`,
        `SQLite: ok`,
        "Lean toolchain:",
        `  ${formatToolProbe("lean", leanToolchain.lean)}`,
        `  ${formatToolProbe("lake", leanToolchain.lake)}`,
        `  ${formatToolProbe("elan", leanToolchain.elan)}`,
        `  ${formatMathlibProbe(leanToolchain.mathlib)}`,
        "Free local-only baseline:",
        "  zero API keys: supported for deterministic goal runs, cached research replay, reports, audits, and local proof checks",
        "  zero-network default: research and goal runs use cache-only source access unless --allow-network is passed",
        "  offline lock: pass --offline or set MATEMATICA_LOCAL_ONLY=true to reject remote network calls even when provider flags are present",
        "  optional local model: configure MATEMATICA_LOCAL_BASE_URL and MATEMATICA_LOCAL_MODEL for a local OpenAI-compatible runtime",
        "  remote upgrade: BYOK opt-in via --provider plus required --max-call-usd; no bundled model credits or hosted compute",
        `AI SDK compatibility: ${aiSdkCompatibility.ok ? "pass" : "fail"} (${aiSdkCompatibility.packages.map((item) => `${item.name}@${item.version}`).join(", ")})`,
        `Provider legal/privacy gate: ${providerPolicyGate.ok ? "pass" : "fail"} (checked=${providerPolicyGate.checkedAt}, maxAgeDays=${providerPolicyGate.maxAgeDays})`,
        "Providers:",
        ...providerSummary(config).map((line) => `  ${line}`)
      ].join("\n");
    }

    if (command === "config") {
      if (subcommand === "show") {
        return JSON.stringify(publicConfig(config), null, 2);
      }
      throw new Error(`Unknown config subcommand "${subcommand ?? ""}". Run matematica --help.`);
    }

    if (command === "storage") {
      if (subcommand === "init-encrypted") {
        const parsed = parseArgs(rest);
        const initialized = initializeEncryptedHome(paths.root, {
          keyEnv: optionalString(parsed, "key-env")
        });
        return JSON.stringify({
          storageEncryption: {
            enabled: initialized.enabled,
            keyEnv: initialized.keyEnv,
            keyPersistence: "external-env-only"
          },
          home: paths.root
        }, null, 2);
      }
      if (subcommand === "prune-caches") {
        const parsed = parseArgs(rest);
        const olderThanHours = optionalNumber(parsed, "older-than-hours") ?? 24 * 7;
        const prune = pruneArxivCache({
          ledger,
          olderThanHours,
          dryRun: hasFlag(parsed, "dry-run")
        });
        const runId = optionalString(parsed, "run-id");
        if (runId && !prune.dryRun) {
          ledger.requireRun(runId);
          const artifact = artifacts.create(runId, "retention.cache.prune", JSON.stringify(prune, null, 2));
          ledger.appendEvent(runId, "retention.cache.pruned", {
            ...prune,
            artifactId: artifact.id,
            artifactHash: artifact.sha256
          }, [artifact.id]);
        }
        return JSON.stringify({
          format: "matematica.retention.prune-caches",
          version: 1,
          ...prune
        }, null, 2);
      }
      if (subcommand === "maintenance") {
        const parsed = parseArgs(rest);
        const runId = optionalString(parsed, "run-id");
        const snapshot = ledger.maintenanceSnapshot();
        let evidence: { artifactId: string; artifactHash: string; eventId: string } | undefined;
        if (runId) {
          ledger.requireRun(runId);
          const artifact = artifacts.create(runId, "ledger.maintenance.snapshot", JSON.stringify(snapshot, null, 2));
          const event = ledger.appendEvent(runId, "ledger.maintenance.snapshotted", {
            format: snapshot.format,
            version: snapshot.version,
            schemaVersion: snapshot.schemaVersion,
            requiredIndexesPresent: snapshot.integrity.requiredIndexesPresent,
            concurrencyConfigOk: snapshot.integrity.concurrencyConfigOk,
            compactionPolicy: snapshot.compactionPolicy,
            retentionPolicy: snapshot.retentionPolicy,
            artifactId: artifact.id,
            artifactHash: artifact.sha256
          }, [artifact.id]);
          evidence = {
            artifactId: artifact.id,
            artifactHash: artifact.sha256,
            eventId: event.id
          };
        }
        return JSON.stringify({
          ...snapshot,
          evidence
        }, null, 2);
      }
      throw new Error(`Unknown storage subcommand "${subcommand ?? ""}". Run matematica --help.`);
    }

    if (command === "contract") {
      if (subcommand === "show") {
        const parsed = parseArgs(rest);
        const validation = validateExecutionContract();
        if (!validation.ok) throw new Error(`Execution contract is invalid: ${validation.issues.join("; ")}`);
        if (hasFlag(parsed, "json")) return JSON.stringify(EXECUTION_CONTRACT, null, 2);
        return formatExecutionContract();
      }
      throw new Error(`Unknown contract subcommand "${subcommand ?? ""}". Run matematica --help.`);
    }

    if (command === "providers") {
      if (subcommand === "list") {
        const parsed = parseArgs(rest);
        if (hasFlag(parsed, "json")) {
          return JSON.stringify(providerCapabilityMatrix(config), null, 2);
        }
        return providerSummary(config).join("\n");
      }
      if (subcommand === "smoke") {
        const parsed = parseArgs(rest);
        const provider = requiredString(parsed, "provider") as never;
        const modelId = optionalString(parsed, "model");
        const runId = optionalString(parsed, "run-id");
        const prompt = optionalString(parsed, "prompt") ?? "Return exactly: matematica-ok";
        if (!runId) {
          throw new Error("Provider smoke tests require --run-id so the model request, response, usage, budget reservation, egress decision, and replay metadata are persisted before any provider call.");
        }
        const resolved = resolveModel(config, { provider, modelId });
        pinProviderMatrix({
          runId,
          ledger,
          artifacts,
          providers: providerCapabilityMatrix(config, {
            modelOverrides: { [resolved.provider]: resolved.modelId }
          }),
          providerAllowlist: [resolved.provider],
          source: "providers smoke",
          reason: "Provider smoke route pinned before ledgered provider dispatch."
        });
        const preflight = admitRemoteCompute({
          runId,
          ledger,
          artifacts,
          command: "providers smoke",
          provider: resolved.provider,
          modelId: resolved.modelId,
          localOnly: config.localOnly,
          maxWorkers: 1,
          maxAttempts: 1,
          maxCallUsd: optionalNumber(parsed, "max-call-usd"),
          maxOutputTokens: 32,
          explicitRemoteConsent: hasRemoteCostConsent(parsed),
          unledgeredCall: false
        });
        if (!preflight.ok) throw new Error(preflight.reason);
        const output = await generateInstrumentedText({
          runId,
          ledger,
          artifacts,
          provider: resolved.provider,
          modelId: resolved.modelId,
          model: resolved.model,
          prompt,
          settings: { maxOutputTokens: 32, maxUsd: optionalNumber(parsed, "max-call-usd") },
          generate: options.generateText
        });
        return JSON.stringify({
          provider: resolved.provider,
          modelId: resolved.modelId,
          text: output.text,
          usage: output.usage,
          artifacts: [output.requestArtifactId, output.responseArtifactId]
        }, null, 2);
      }
      if (subcommand === "hostile-dry-run") {
        const parsed = parseArgs(rest);
        const provider = requiredString(parsed, "provider") as never;
        const modelId = optionalString(parsed, "model");
        const runId = requiredString(parsed, "run-id");
        const maxOutputTokens = optionalNumber(parsed, "max-output-tokens") ?? 32;
        const maxCallUsd = optionalNumber(parsed, "max-call-usd");
        const timeoutMs = optionalNumber(parsed, "timeout-ms") ?? 30_000;
        const maxProviderRetriesPerCall = optionalNonNegativeInteger(parsed, "max-provider-retries") ?? 0;
        const resolved = resolveModel(config, { provider, modelId });
        if (resolved.provider === "local") {
          throw new Error("Hostile live-provider dry runs are for remote BYOK providers; use providers smoke for local endpoints.");
        }
        const canary = ["sk", "hostile-live-provider-dry-run", runId, resolved.provider].join("-");
        const prompt = optionalString(parsed, "prompt") ?? hostileProviderDryRunPrompt(canary);
        pinProviderMatrix({
          runId,
          ledger,
          artifacts,
          providers: providerCapabilityMatrix(config, {
            modelOverrides: { [resolved.provider]: resolved.modelId }
          }),
          providerAllowlist: [resolved.provider],
          source: "providers hostile-dry-run",
          reason: "Hostile live-provider dry run route pinned before BYOK provider dispatch."
        });
        const preflight = admitRemoteCompute({
          runId,
          ledger,
          artifacts,
          command: "providers hostile-dry-run",
          provider: resolved.provider,
          modelId: resolved.modelId,
          localOnly: config.localOnly,
          maxWorkers: 1,
          maxAttempts: 1,
          maxCallUsd,
          maxOutputTokens,
          providerTimeoutMs: timeoutMs,
          maxProviderRetriesPerCall,
          explicitRemoteConsent: hasRemoteCostConsent(parsed),
          unledgeredCall: false
        });
        if (!preflight.ok) throw new Error(preflight.reason);
        const controller = new AbortController();
        const output = await generateInstrumentedText({
          runId,
          ledger,
          artifacts,
          provider: resolved.provider,
          modelId: resolved.modelId,
          model: resolved.model,
          prompt,
          settings: {
            maxOutputTokens,
            maxUsd: maxCallUsd,
            timeout: timeoutMs,
            abortSignal: controller.signal,
            resilience: { maxRetries: maxProviderRetriesPerCall },
            aiSdkLoop: {
              maxSteps: 1,
              maxProviderRetriesPerCall,
              maxSubagentCalls: 0
            }
          },
          generate: options.generateText
        });
        const review = persistHostileLiveProviderDryRunReview({
          runId,
          ledger,
          artifacts,
          provider: resolved.provider,
          modelId: resolved.modelId,
          executionMode: options.generateText ? "test_injected" : "byok_live",
          canary,
          externalOperationId: output.externalOperationId,
          requestArtifactId: output.requestArtifactId,
          responseArtifactId: output.responseArtifactId,
          transcriptArtifactId: output.transcriptArtifactId,
          timeoutMs,
          maxProviderRetriesPerCall
        });
        return JSON.stringify({
          provider: resolved.provider,
          modelId: resolved.modelId,
          externalOperationId: output.externalOperationId,
          requestArtifactId: output.requestArtifactId,
          responseArtifactId: output.responseArtifactId,
          review
        }, null, 2);
      }
      throw new Error(`Unknown providers subcommand "${subcommand ?? ""}". Run matematica --help.`);
    }

    if (command === "benchmarks") {
      if (subcommand === "hostile") {
        const report = runHostileMathBenchmarkGate();
        return JSON.stringify(report, null, 2);
      }
      if (subcommand === "release-gate") {
        const report = runZeroFalseSolvedReleaseGate();
        return JSON.stringify(report, null, 2);
      }
      if (subcommand === "ladder") {
        const parsed = parseArgs(rest);
        const ladder = buildHardMathBenchmarkLadder();
        const validation = validateHardMathBenchmarkLadder(ladder);
        if (!validation.ok) {
          throw new Error(`Hard-math benchmark ladder is invalid: ${validation.issues.join("; ")}`);
        }
        if (hasFlag(parsed, "json")) return JSON.stringify(ladder, null, 2);
        return formatHardMathBenchmarkLadder(ladder);
      }
      throw new Error(`Unknown benchmarks subcommand "${subcommand ?? ""}". Run matematica --help.`);
    }

    if (command === "milestones") {
      if (subcommand === "list") {
        const parsed = parseArgs(rest);
        const validation = validateMilestonePlan();
        if (!validation.ok) {
          throw new Error(`Milestone plan is invalid: ${validation.issues.join("; ")}`);
        }
        if (hasFlag(parsed, "json")) {
          return JSON.stringify(RELEASE_MILESTONE_PLAN, null, 2);
        }
        return formatMilestonePlan();
      }
      throw new Error(`Unknown milestones subcommand "${subcommand ?? ""}". Run matematica --help.`);
    }

    if (command === "release-plan") {
      if (subcommand === "show") {
        const parsed = parseArgs(rest);
        const validation = validateCanonicalReleasePlan();
        if (!validation.ok) {
          throw new Error(`Canonical release plan is invalid: ${validation.issues.map((issue) => issue.message).join("; ")}`);
        }
        if (hasFlag(parsed, "json")) return JSON.stringify(CANONICAL_RELEASE_PLAN, null, 2);
        return formatCanonicalReleasePlan();
      }
      if (subcommand === "registry") {
        const parsed = parseArgs(rest);
        const mirror = readSharedImplementationPlanRegistryMirror();
        const validation = validateSharedImplementationPlanRegistryMirror({ mirror });
        if (!validation.ok) {
          throw new Error(`Shared implementation-plan registry mirror is invalid: ${validation.issues.map((issue) => issue.message).join("; ")}`);
        }
        if ("error" in mirror) throw new Error(mirror.error.message);
        if (hasFlag(parsed, "json")) return JSON.stringify(mirror, null, 2);
        return formatSharedImplementationPlanRegistryMirror(mirror);
      }
      if (subcommand === "evidence") {
        const parsed = parseArgs(rest);
        const manifest = readReleaseEvidenceFreshnessManifest();
        const validation = validateReleaseEvidenceFreshness({ manifest });
        if (!validation.ok) {
          throw new Error(`Release evidence freshness manifest is invalid: ${validation.issues.map((issue) => issue.message).join("; ")}`);
        }
        if ("error" in manifest) throw new Error(manifest.error.message);
        if (hasFlag(parsed, "json")) return JSON.stringify(manifest, null, 2);
        return [
          "Matematica release evidence freshness manifest",
          `Plan: ${manifest.planId}`,
          `Completed evidence records: ${manifest.completedTaskEvidence.length}`,
          `Supersession records: ${manifest.supersessionEvidence.length}`,
          `Generated: ${manifest.generatedAt}`
        ].join("\n");
      }
      throw new Error(`Unknown release-plan subcommand "${subcommand ?? ""}". Run matematica --help.`);
    }

    if (command === "release") {
      if (subcommand === "check") {
        const parsed = parseArgs(rest);
        const report = runReleaseWorkflow({
          cwd,
          dryRun: hasFlag(parsed, "dry-run")
        });
        if (!report.dryRun && !report.ok) {
          throw new Error(`Matematica release workflow failed:\n${formatReleaseWorkflowReport(report)}`);
        }
        if (hasFlag(parsed, "json")) return JSON.stringify(report, null, 2);
        return formatReleaseWorkflowReport(report);
      }
      throw new Error(`Unknown release subcommand "${subcommand ?? ""}". Run matematica --help.`);
    }

    if (command === "drills") {
      if (subcommand === "swarm-kill") {
        const parsed = parseArgs(rest);
        const result = await runSwarmKillDrillSuite({
          ledger,
          artifacts,
          workerCounts: parseWorkerCounts(optionalString(parsed, "worker-counts"))
        });
        return JSON.stringify(result, null, 2);
      }
      if (subcommand === "swarm-stress") {
        const parsed = parseArgs(rest);
        const result = await runSwarmStressGate({
          ledger,
          artifacts,
          workerCount: optionalNumber(parsed, "workers"),
          providerConcurrency: optionalNumber(parsed, "provider-concurrency"),
          memoryLimitBytes: optionalNumber(parsed, "memory-limit-bytes"),
          cpuLimitMicros: optionalNumber(parsed, "cpu-limit-micros")
        });
        return JSON.stringify(result, null, 2);
      }
      throw new Error(`Unknown drills subcommand "${subcommand ?? ""}". Run matematica --help.`);
    }

    if (command === "research") {
      if (subcommand === "arxiv") {
        const parsed = parseArgs(rest);
        const policy = networkPolicy({ config, offlineRequested: hasPrivacyOffline(parsed), networkRequested: hasNetworkOptIn(parsed) });
        const query = requiredString(parsed, "query");
        const maxResults = optionalNumber(parsed, "max-results") ?? 10;
        const maxAgeDays = optionalNumber(parsed, "max-age-days");
        const staleBefore = optionalString(parsed, "stale-before") ?? staleBeforeFromMaxAge(maxAgeDays);
        const compliance = arxivCompliancePolicy();
        const runId = optionalString(parsed, "run-id");
        let externalOperationId: string | undefined;
        let reservationId: string | undefined;
        const startedAt = Date.now();
        const request = {
          provider: "arxiv",
          query,
          maxResults,
          citationOnly: !hasFlag(parsed, "include-abstracts"),
          sortBy: "submittedDate",
          sortOrder: "descending",
          requestedAt: new Date().toISOString(),
          maxAgeDays
        };
        const requestHash = stableHash(request);
        const idempotencyKey = runId
          ? externalOperationIdempotencyKey({
              runId,
              operationType: "source.arxiv",
              requestHash
            })
          : `extop_source_arxiv_${requestHash.slice(0, 32)}`;
        let requestArtifactId: string | undefined;
        if (policy.offline) {
          if (!runId) {
            throw new Error("Offline arXiv research requires --run-id so cached metadata provenance can be checked.");
          }
          ledger.requireRun(runId);
          const cached = ledger.listExternalOperations(runId)
            .find((operation) =>
              operation.operationType === "source.arxiv" &&
              operation.provider === "arxiv" &&
              operation.idempotencyKey === idempotencyKey &&
              operation.status === "succeeded" &&
              operation.responseArtifactId
            );
          if (cached?.responseArtifactId) {
            const artifact = ledger.listArtifacts(runId).find((item) => item.id === cached.responseArtifactId);
            if (!artifact) throw new Error(`Cached arXiv operation is missing artifact ${cached.responseArtifactId}.`);
            ledger.appendEvent(runId, "source.offline_cache.used", {
              provider: "arxiv",
              query,
              maxResults,
              offlineCacheOnly: true,
              networkMode: policy.mode,
              reason: policy.reason,
              compliance,
              requestHash,
              idempotencyKey,
              externalOperationId: cached.id,
              artifactId: cached.responseArtifactId
            }, [cached.responseArtifactId]);
            return JSON.stringify(redactJson(JSON.parse(readArtifactText(artifact)).papers ?? []), null, 2);
          }
          const sharedCache = await fetchArxivWithCache({
            ledger,
            query,
            maxResults,
            allowNetwork: false
          });
          if (sharedCache.cache.usedCache) {
            const quarantined = quarantineArxivPapers(sharedCache.papers, { citationOnly: request.citationOnly });
            ledger.appendEvent(runId, "source.offline_cache.used", {
              provider: "arxiv",
              query,
              maxResults,
              offlineCacheOnly: true,
              networkMode: policy.mode,
              reason: policy.reason,
              compliance,
              requestHash,
              idempotencyKey,
              cache: sharedCache.cache
            });
            return JSON.stringify(redactJson(quarantined), null, 2);
          }
          ledger.appendEvent(runId, "source.offline_cache.missed", {
            provider: "arxiv",
            query,
            maxResults,
            offlineCacheOnly: true,
            networkMode: policy.mode,
            reason: policy.reason,
            compliance,
            requestHash,
            idempotencyKey,
            cache: sharedCache.cache
          });
          throw new Error(sharedCache.cache.status === "malformed"
            ? `Offline/local-only mode blocks arXiv network fetch and cached metadata is malformed: ${sharedCache.cache.reason}`
            : "Offline/local-only mode blocks arXiv network fetch and no cached metadata exists for this query.");
        }
        if (runId) {
          ledger.requireRun(runId);
          const requestArtifact = artifacts.create(runId, "source.arxiv.request", JSON.stringify(request, null, 2));
          requestArtifactId = requestArtifact.id;
          const prepared = ledger.prepareExternalOperation({
            runId,
            operationType: "source.arxiv",
            provider: "arxiv",
            idempotencyKey,
            requestHash,
            reserve: { elapsedMs: 1 },
            requestArtifactId: requestArtifact.id
          });
          if (!prepared.ok) {
            throw new Error(`Budget exhausted before arXiv fetch: ${prepared.reason}`);
          }
          if (!prepared.created) {
            if (prepared.operation.status === "succeeded" && prepared.operation.responseArtifactId) {
              const artifact = ledger.listArtifacts(runId).find((item) => item.id === prepared.operation.responseArtifactId);
              if (!artifact) throw new Error(`Cached arXiv operation is missing artifact ${prepared.operation.responseArtifactId}.`);
              return JSON.stringify(redactJson(JSON.parse(readArtifactText(artifact)).papers ?? []), null, 2);
            }
            throw new Error(`External operation ${prepared.operation.id} already exists in status ${prepared.operation.status}; refusing duplicate arXiv fetch.`);
          }
          const operation = ledger.startExternalOperation(prepared.operation.id);
          externalOperationId = operation.id;
          reservationId = operation.reservationId;
          ledger.appendEvent(runId, "source.query", {
            provider: "arxiv",
            query,
            maxResults,
            externalOperationId,
            reservationId,
            requestHash,
            requestArtifactId,
            sortBy: "submittedDate",
            sortOrder: "descending",
            requestedAt: request.requestedAt,
            maxAgeDays,
            compliance
          }, [requestArtifact.id]);
        }
        let papers: ArxivPaper[];
        let arxivCache: Awaited<ReturnType<typeof fetchArxivWithCache>>["cache"] | undefined;
        try {
          const fetched = await fetchArxivWithCache({
            ledger,
            query,
            maxResults,
            allowNetwork: true,
            search: options.arxivSearch ?? ((searchQuery, fetchOptions) => searchArxiv(searchQuery, {
              maxResults: fetchOptions.maxResults,
              minIntervalMs: 0,
              abortSignal: fetchOptions.abortSignal
            })),
            minIntervalMs: compliance.minIntervalMs
          });
          papers = fetched.papers;
          arxivCache = fetched.cache;
        } catch (error) {
          if (externalOperationId) {
            ledger.failExternalOperation({
              operationId: externalOperationId,
              errorMessage: error instanceof Error ? error.message : String(error),
              releaseReason: error instanceof Error ? error.message : String(error),
              provider: "arxiv"
            });
          }
          throw error;
        }
        const citationOnly = request.citationOnly;
        const quarantinedPapers = quarantineArxivPapers(papers, { citationOnly });
        const sourceRecords = buildArxivSourceRecords(quarantinedPapers, { query });
        const citationGrounding = validateCitations(
          sourceRecords.map((record) => ({
            ...claimedCitationFromSourceRecord(record),
            staleBefore
          })),
          sourceRecords
        );
        const retrievalEvaluation = evaluateLiteratureRetrieval({
          query,
          papers: quarantinedPapers,
          sourceRecords,
          citationGrounding,
          expectedRelevantIds: listFlag(parsed, "expected-relevant-ids"),
          expectedTerms: listFlag(parsed, "expected-terms"),
          staleBefore,
          usedSourceIds: listFlag(parsed, "used-source-ids")
        });
        const enrichment = buildArxivResearchEnrichment({
          query,
          papers: quarantinedPapers,
          sourceRecords,
          redistribution: compliance.pdfAndSourceRedistribution,
          metadataRedistribution: compliance.metadataRedistribution,
          termsUrl: compliance.termsUrl,
          staleBefore,
          citationGrounding
        });
        if (arxivCache?.cacheKey) {
          updateArxivCacheReview({
            ledger,
            cacheKey: arxivCache.cacheKey,
            sourceSnapshotHashes: sourceRecords.map((record) => record.snapshotHash),
            retrievalQuality: {
              retrievedCount: retrievalEvaluation.retrievedCount,
              relevantRetrieved: retrievalEvaluation.relevantRetrieved,
              expectedRetrieved: retrievalEvaluation.expectedRetrieved,
              precision: retrievalEvaluation.precision,
              recall: retrievalEvaluation.recall,
              citationValidity: retrievalEvaluation.citationValidity,
              sourceUseRate: retrievalEvaluation.sourceUseRate,
              irrelevantResultCount: retrievalEvaluation.irrelevantResultCount,
              keywordOverfitCount: retrievalEvaluation.keywordOverfitCount,
              failures: retrievalEvaluation.failures,
              trustImpact: retrievalEvaluation.trustImpact,
              canPromoteResearchBackedClaims: retrievalEvaluation.canPromoteResearchBackedClaims,
              staleResultCount: retrievalEvaluation.staleResultCount,
              incompleteResearch: retrievalEvaluation.failures.length > 0,
              reviewedAt: new Date().toISOString()
            }
          });
        }
        if (runId) {
          const artifact = artifacts.create(runId, "source.arxiv.results", JSON.stringify({
            query,
            citationOnly,
            trust: {
              sourceTextTrusted: false,
              quarantine: true,
              hostileFlags: quarantinedPapers.flatMap((paper) => paper.trust.flags),
              redistribution: compliance.pdfAndSourceRedistribution
            },
            compliance,
            cache: arxivCache,
            sourceRecords,
            citationGrounding,
            retrievalEvaluation,
            semanticDedupe: enrichment.semanticDedupe,
            citationGraph: enrichment.citationGraph,
            snapshots: enrichment.snapshots,
            sourceQuality: enrichment.sourceQuality,
            citationLicenseManifest: enrichment.citationLicenseManifest,
            papers: quarantinedPapers
          }, null, 2));
          ledger.appendEvent(runId, "source.results", {
            provider: "arxiv",
            query,
            count: papers.length,
            externalOperationId,
            quarantined: true,
            citationOnly,
            reservationId,
            requestHash,
            requestedAt: request.requestedAt,
            maxAgeDays,
            staleBefore,
            compliance,
            cache: arxivCache,
            hostileFlags: quarantinedPapers.flatMap((paper) => paper.trust.flags),
            sourceRecords: sourceRecords.map((record) => ({
              query: record.query,
              sourceId: record.sourceId,
              canonicalId: record.canonicalId,
              version: record.version,
              title: record.title,
              authors: record.authors,
              published: record.published,
              updated: record.updated,
              retrievedAt: record.retrievedAt,
              ranking: record.ranking,
              abstractHash: record.abstractHash,
              snapshotHash: record.snapshotHash,
              rawMetadataHash: record.rawMetadataHash,
              extractedClaims: record.extractedClaims,
              sourceFieldTaint: record.sourceFieldTaint,
              contentHash: record.contentHash,
              url: record.url
            })),
            citationGrounding,
            retrievalEvaluation: {
              precision: retrievalEvaluation.precision,
              recall: retrievalEvaluation.recall,
              citationValidity: retrievalEvaluation.citationValidity,
              sourceUseRate: retrievalEvaluation.sourceUseRate,
              failures: retrievalEvaluation.failures,
              trustImpact: retrievalEvaluation.trustImpact,
              canPromoteResearchBackedClaims: retrievalEvaluation.canPromoteResearchBackedClaims,
              staleResultCount: retrievalEvaluation.staleResultCount,
              incompleteResearch: retrievalEvaluation.failures.length > 0
            },
            citationLicenseManifest: enrichment.citationLicenseManifest,
            ...researchEnrichmentEventPayload(enrichment),
            artifactId: artifact.id
          }, [artifact.id]);
          ledger.appendEvent(runId, "source.citations.reviewed", {
            provider: "arxiv",
            query,
            externalOperationId,
            cache: arxivCache,
            ...citationGrounding
          }, [artifact.id]);
          ledger.appendEvent(runId, "source.retrieval.evaluated", {
            provider: "arxiv",
            externalOperationId,
            artifactId: artifact.id,
            cache: arxivCache,
            ...retrievalEvaluation
          }, [artifact.id]);
          appendResearchEnrichmentEvents(ledger, runId, {
            query,
            externalOperationId,
            artifactId: artifact.id,
            enrichment
          });
          ledger.completeExternalOperation({
            operationId: externalOperationId!,
            responseArtifactId: artifact.id,
            debit: { elapsedMs: Math.max(1, Date.now() - startedAt) },
            overReservationPolicy: {
              allowedDimensions: ["elapsedMs"],
              reason: "CLI arXiv research debits measured elapsed time after reserving the source operation."
            },
            provider: "arxiv"
          });
        }
        return JSON.stringify(redactJson(quarantinedPapers), null, 2);
      }
      throw new Error(`Unknown research subcommand "${subcommand ?? ""}". Run matematica --help.`);
    }

    if (command !== "goal") {
      throw new Error(`Unknown command "${command}". Run matematica --help.`);
    }

    if (subcommand === "create") {
      const parsed = parseArgs(rest);
      const problem = redactPrivateCliText(readProblem(parsed), parsed);
      const goal = redactPrivateCliText(requiredString(parsed, "goal"), parsed);
      const workflow = parseWorkflow(optionalString(parsed, "workflow") ?? config.defaultWorkflow);
      const successCriteria = optionalString(parsed, "success-criteria")
        ?.split(";")
        .map((item) => item.trim())
        .filter(Boolean) ?? ["Produce verifier-backed evidence or exhaust the configured budget."];
      const redactedSuccessCriteria = successCriteria.map((item) => redactPrivateCliText(item, parsed));
      const budget = normalizeBudget({
        ...defaultBudget(),
        maxUsd: optionalNumberAlias(parsed, "budget-usd", ["usd"]),
        maxTokens: optionalNumber(parsed, "max-tokens"),
        maxWallTimeMs: optionalHours(parsed, "max-hours"),
        maxAttempts: optionalNumber(parsed, "max-attempts"),
        maxWorkers: optionalNumberAlias(parsed, "workers", ["agents"]) ?? config.defaultMaxWorkers,
        maxArtifactBytes: optionalNumber(parsed, "max-artifact-bytes"),
        maxSourceQueries: optionalNumber(parsed, "max-source-queries"),
        maxRetries: optionalNumber(parsed, "max-retries"),
        maxSandboxMs: optionalNumber(parsed, "max-sandbox-ms")
      });
      const run = ledger.createRun({ problem, goal, successCriteria: redactedSuccessCriteria, workflow, budget });
      artifacts.create(run.id, "problem.input", problem);
      recordCliPrivacyPolicy({ runId: run.id, command: "goal create", parsed, ledger, artifacts });
      const problemClassOverride = optionalProblemClass(parsed);
      if (problemClassOverride) {
        persistProblemClassificationReview({
          run,
          ledger,
          artifacts,
          override: problemClassOverride,
          reviewer: "operator-override"
        });
      }
      return JSON.stringify(run, null, 2);
    }

    if (subcommand === "run") {
      const parsed = parseArgs(rest);
      const runId = requiredRunId(rest);
      const maxOutputTokens = optionalNumber(parsed, "max-output-tokens") ?? 800;
      const maxCallUsd = optionalNumber(parsed, "max-call-usd");
      const policy = networkPolicy({ config, offlineRequested: hasPrivacyOffline(parsed), networkRequested: hasNetworkOptIn(parsed) });
      recordCliPrivacyPolicy({ runId, command: "goal run", parsed, ledger, artifacts });
      const branchModels = buildBranchModels({
        command: "goal run",
        parsed,
        config,
        localOnly: policy.offline,
        ledger,
        artifacts,
        runId,
        maxOutputTokens,
        maxCallUsd,
        temperature: optionalNumber(parsed, "temperature"),
        providerConcurrency: optionalNumber(parsed, "provider-concurrency"),
        explicitRemoteConsent: hasRemoteCostConsent(parsed),
        generate: options.generateText
      });
      const result = await runGoal(runId, ledger, artifacts, {
        arxivSearch: options.arxivSearch,
        offline: policy.offline,
        offlineReason: policy.reason,
        cwd,
        config,
        branchModels,
        swarmAdmissionConfirmed: hasSwarmAdmissionConfirmation(parsed),
        problemClassOverride: optionalProblemClass(parsed)
      });
      return JSON.stringify({
        runId,
        ...result,
        outputTrust: buildOutputTrustContract({
          run: ledger.requireRun(runId),
          events: ledger.listEvents(runId),
          replayCommand: followUpReplayCommand(runId)
        })
      }, null, 2);
    }

    if (subcommand === "admission") {
      const parsed = parseArgs(rest);
      const runId = requiredRunId(rest);
      const run = ledger.requireRun(runId);
      const maxOutputTokens = optionalNumber(parsed, "max-output-tokens") ?? 800;
      const maxCallUsd = optionalNumber(parsed, "max-call-usd");
      const policy = networkPolicy({ config, offlineRequested: hasPrivacyOffline(parsed), networkRequested: hasNetworkOptIn(parsed) });
      recordCliPrivacyPolicy({ runId, command: "goal admission", parsed, ledger, artifacts });
      const branchModels = buildBranchModels({
        command: "goal run",
        parsed,
        config,
        localOnly: policy.offline,
        ledger,
        artifacts,
        runId,
        maxOutputTokens,
        maxCallUsd,
        temperature: optionalNumber(parsed, "temperature"),
        providerConcurrency: optionalNumber(parsed, "provider-concurrency"),
        explicitRemoteConsent: hasRemoteCostConsent(parsed),
        generate: options.generateText
      });
      const preview = persistSwarmAdmissionPreview({
        run,
        ledger,
        artifacts,
        command: "goal admission",
        sourceNetworkMode: policy.mode,
        explicitYes: hasSwarmAdmissionConfirmation(parsed),
        branchModels,
        providerDiversityWaiver: providerDiversityWaiver(parsed)
      });
      return JSON.stringify(preview, null, 2);
    }

    if (subcommand === "status") {
      const run = ledger.requireRun(requiredRunId(rest));
      return JSON.stringify(run, null, 2);
    }

    if (subcommand === "replay") {
      const parsed = parseArgs(rest);
      const importPath = optionalString(parsed, "import");
      if (importPath) {
        const bundle = readPortableBundle(importPath);
        return JSON.stringify(importReproducibilityBundle({
          bundle,
          ledger,
          artifactsDir: paths.artifactsDir,
          cwd,
          config
        }), null, 2);
      }
      const runId = requiredRunId(rest);
      const archivePath = optionalString(parsed, "archive");
      if (archivePath) {
        if (hasFlag(parsed, "raw-export")) {
          throw new Error("Raw reproducibility archives are not supported by the public CLI; archives are redacted portable bundles.");
        }
        recordCliPrivacyPolicy({ runId, command: "goal replay --archive", parsed, ledger, artifacts, forceRedactedExport: true });
        const bundle = exportReproducibilityBundle({ runId, ledger, cwd, config });
        const uncompressed = Buffer.from(`${JSON.stringify(bundle, null, 2)}\n`, "utf8");
        const compressed = gzipSync(uncompressed, { level: 9 });
        writeFileSync(archivePath, compressed, { mode: 0o600 });
        return JSON.stringify({
          ok: true,
          runId,
          path: archivePath,
          format: "matematica.reproducibility.archive",
          bundleFormat: bundle.format,
          version: 1,
          compression: "gzip",
          exportPolicy: "redacted_portable_bundle",
          rawExportSupported: false,
          rawExportRequiresExplicitConsent: true,
          sha256: sha256Hex(compressed),
          uncompressedBytes: uncompressed.byteLength,
          compressedBytes: compressed.byteLength,
          events: bundle.events.length,
          artifacts: bundle.artifacts.length,
          reportHash: bundle.expected.reportHash,
          artifactManifestHash: bundle.expected.artifactManifestHash
        }, null, 2);
      }
      const exportPath = optionalString(parsed, "export");
      if (exportPath) {
        if (hasFlag(parsed, "raw-export")) {
          throw new Error("Raw reproducibility exports are not supported by the public CLI; use the default redacted portable bundle or pass --redacted-export explicitly.");
        }
        recordCliPrivacyPolicy({ runId, command: "goal replay --export", parsed, ledger, artifacts, forceRedactedExport: true });
        const bundle = exportReproducibilityBundle({ runId, ledger, cwd, config });
        writeFileSync(exportPath, `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o600 });
        return JSON.stringify({
          ok: true,
          runId,
          path: exportPath,
          exportPolicy: "redacted_portable_bundle",
          rawExportSupported: false,
          rawExportRequiresExplicitConsent: true,
          format: bundle.format,
          version: bundle.version,
          reportHash: bundle.expected.reportHash,
          artifactManifestHash: bundle.expected.artifactManifestHash,
          providerCallManifestHash: bundle.expected.providerCallManifestHash,
          citationManifestHash: bundle.expected.citationManifestHash,
          nonReplayableStepsHash: bundle.expected.nonReplayableStepsHash,
          events: bundle.events.length,
          artifacts: bundle.artifacts.length
        }, null, 2);
      }
      if (hasFlag(parsed, "deterministic")) {
        return JSON.stringify(replayOffline({ runId, ledger, cwd, config, verifyFinal: true, deterministic: true }), null, 2);
      }
      if (hasFlag(parsed, "offline")) {
        return JSON.stringify(replayOffline({ runId, ledger, cwd, config, verifyFinal: hasFlag(parsed, "verify-final") }), null, 2);
      }
      if (hasFlag(parsed, "manifest")) {
        return JSON.stringify(buildReplayManifest({ runId, ledger, cwd, config }), null, 2);
      }
      const events = ledger.listEvents(runId);
      return events.map((event, index) => {
        return `${index + 1}. ${event.createdAt} ${event.type} ${event.id} ${JSON.stringify(event.payload)}`;
      }).join("\n");
    }

    if (subcommand === "report") {
      return persistRunReport(requiredRunId(rest), ledger, artifacts).reportText;
    }

    if (subcommand === "formalization") {
      const runId = requiredRunId(rest);
      const parsed = parseArgs(rest);
      const run = ledger.requireRun(runId);
      const assessment = recordFormalizationAssessment(runId, ledger, artifacts, {
        informalProblem: run.problem,
        formalStatement: requiredString(parsed, "formal-statement"),
        normalizedStatement: optionalString(parsed, "normalized-statement"),
        assumptions: listFlag(parsed, "assumptions"),
        definitions: listFlag(parsed, "definitions"),
        missingDefinitions: listFlag(parsed, "missing-definitions"),
        missingLemmas: listFlag(parsed, "missing-lemmas"),
        missingAssumptions: listFlag(parsed, "missing-assumptions"),
        conclusion: optionalString(parsed, "conclusion"),
        scopeChanges: listFlag(parsed, "scope-changes"),
        knownGaps: listFlag(parsed, "known-gaps"),
        ambiguityNotes: listFlag(parsed, "ambiguities"),
        statementDiffs: listFlag(parsed, "statement-diffs"),
        reviewerDisagreement: hasFlag(parsed, "disagreement"),
        status: parseFormalizationStatus(requiredString(parsed, "status")),
        reviewer: optionalString(parsed, "reviewer") ?? "manual-review"
      });
      return JSON.stringify(assessment, null, 2);
    }

    if (subcommand === "equivalence") {
      const runId = requiredRunId(rest);
      const parsed = parseArgs(rest);
      const run = ledger.requireRun(runId);
      const review = recordTheoremEquivalenceReview(runId, ledger, artifacts, {
        originalProblem: run.problem,
        normalizedStatement: requiredString(parsed, "normalized-statement"),
        formalStatement: requiredString(parsed, "formal-statement"),
        assumptions: listFlag(parsed, "assumptions"),
        conclusion: requiredString(parsed, "conclusion"),
        ambiguityNotes: listFlag(parsed, "ambiguities"),
        statementDiffs: listFlag(parsed, "statement-diffs"),
        knownGaps: listFlag(parsed, "known-gaps"),
        missingDefinitions: listFlag(parsed, "missing-definitions"),
        missingLemmas: listFlag(parsed, "missing-lemmas"),
        missingAssumptions: listFlag(parsed, "missing-assumptions"),
        scopeChanges: listFlag(parsed, "scope-changes"),
        status: parseFormalizationStatus(requiredString(parsed, "status")),
        reviewer: optionalString(parsed, "reviewer") ?? "manual-review",
        reviewerDisagreement: hasFlag(parsed, "disagreement")
      });
      return JSON.stringify(review, null, 2);
    }

    if (subcommand === "normalize") {
      const runId = requiredRunId(rest);
      const parsed = parseArgs(rest);
      const run = ledger.requireRun(runId);
      const normalization = normalizeTheoremCandidate({
        originalProblem: run.problem,
        formalStatement: requiredString(parsed, "formal-statement")
      });
      const normalizationArtifact = artifacts.create(runId, "theorem.normalization", JSON.stringify(normalization, null, 2));
      ledger.appendEvent(runId, "theorem.normalized", {
        ...normalization,
        artifactId: normalizationArtifact.id
      }, [normalizationArtifact.id]);
      const review = recordTheoremEquivalenceReview(runId, ledger, artifacts, {
        originalProblem: normalization.originalProblem,
        normalizedStatement: normalization.normalizedStatement,
        formalStatement: normalization.formalStatement,
        assumptions: normalization.assumptions,
        conclusion: normalization.conclusion,
        ambiguityNotes: normalization.ambiguityNotes,
        statementDiffs: normalization.statementDiffs,
        status: normalization.status,
        reviewer: optionalString(parsed, "reviewer") ?? "deterministic-normalizer-v0",
        reviewerDisagreement: normalization.reviewerDisagreement
      });
      return JSON.stringify({
        normalization,
        normalizationArtifactId: normalizationArtifact.id,
        review
      }, null, 2);
    }

    if (subcommand === "score") {
      const runId = requiredRunId(rest);
      const parsed = parseArgs(rest);
      ledger.requireRun(runId);
      const subjectId = optionalString(parsed, "subject") ?? "manual-candidate";
      const score = scoreEvidence({
        evidenceGrade: parseEvidenceGrade(requiredString(parsed, "evidence-grade")),
        claimType: parseClaimType(requiredString(parsed, "claim-type")),
        verifierStatus: parseVerifierStatus(optionalString(parsed, "verifier-status") ?? "not_checked"),
        verifierTrusted: parseBooleanFlag(parsed, "verifier-trusted"),
        formalizationStatus: optionalString(parsed, "formalization-status")
          ? parseFormalizationStatus(requiredString(parsed, "formalization-status"))
          : undefined,
        sourceSupport: parseSourceSupport(optionalString(parsed, "source-support") ?? "none"),
        counterexampleSearch: parseCounterexampleSearch(optionalString(parsed, "counterexample-search") ?? "not_run"),
        reproducibility: parseReproducibility(optionalString(parsed, "reproducibility") ?? "none"),
        modelAgreementOnly: hasFlag(parsed, "model-agreement-only")
      });
      const stored = ledger.insertScore({
        runId,
        subjectId,
        scorer: optionalString(parsed, "scorer") ?? "manual-score",
        score: score.aggregate,
        rubric: score
      });
      return JSON.stringify(stored, null, 2);
    }

    if (subcommand === "verify-lean") {
      const runId = requiredRunId(rest);
      const parsed = parseArgs(rest);
      const result = await verifyLeanFile({
        runId,
        ledger,
        artifacts,
        leanFilePath: requiredString(parsed, "file"),
        leanBin: optionalString(parsed, "lean-bin"),
        lakeBin: optionalString(parsed, "lake-bin"),
        projectRoot: optionalString(parsed, "project-root"),
        timeoutMs: optionalNumber(parsed, "timeout-ms")
      });
      return JSON.stringify(result, null, 2);
    }

    if (subcommand === "audit") {
      const parsed = parseArgs(rest);
      const result = hasFlag(parsed, "saved-everything")
        ? auditSavedEverything(requiredRunId(rest), ledger)
        : auditRun(requiredRunId(rest), ledger);
      return JSON.stringify(result, null, 2);
    }

    if (subcommand === "stop") {
      const runId = requiredRunId(rest);
      const cancellableBeforeStop = ledger.listWorkerJobs(runId)
        .filter((job) => job.status === "pending" || job.status === "leased" || job.status === "running" || job.status === "failed_retryable");
      const cancelledJobs = ledger.cancelPendingWorkerJobs(runId, "goal stop requested");
      const run = ledger.updateRunStatus(runId, "cancelled");
      const cancellationSettlement = cancellableBeforeStop.every((job) => job.status === "pending" || job.status === "failed_retryable")
        ? "avoided"
        : "unknown";
      ledger.appendEvent(runId, "goal.cancelled", {
        reason: "goal stop requested",
        cancelledJobs: cancelledJobs.map((job) => job.id),
        cancellationSettlement
      });
      return JSON.stringify(run, null, 2);
    }

    if (subcommand === "resume") {
      const runId = requiredRunId(rest);
      const parsed = parseArgs(rest);
      const reconciliation = reconcileGoalRunForResume({
        runId,
        ledger,
        cwd,
        config,
        reason: "goal resume requested",
        reopenTerminal: hasFlag(parsed, "reopen-terminal")
      });
      if (reconciliation.unknownExternalOperations.length > 0) {
        const run = ledger.requireRun(runId);
        return JSON.stringify({
          runId,
          reconciliation,
          status: run.status,
          evidenceGrade: run.evidenceGrade,
          finalState: "needs_human_review",
          canClaimSolved: false,
          reason: "Resume stopped because one or more external operations have unknown remote outcomes; explicit retry lineage is required before continuing.",
          outputTrust: buildOutputTrustContract({
            run,
            events: ledger.listEvents(runId),
            replayCommand: followUpReplayCommand(runId)
          })
        }, null, 2);
      }
      const maxOutputTokens = optionalNumber(parsed, "max-output-tokens") ?? 800;
      const maxCallUsd = optionalNumber(parsed, "max-call-usd");
      const policy = networkPolicy({ config, offlineRequested: hasPrivacyOffline(parsed), networkRequested: hasNetworkOptIn(parsed) });
      recordCliPrivacyPolicy({ runId, command: "goal resume", parsed, ledger, artifacts });
      const branchModels = buildBranchModels({
        command: "goal resume",
        parsed,
        config,
        localOnly: policy.offline,
        ledger,
        artifacts,
        runId,
        maxOutputTokens,
        maxCallUsd,
        temperature: optionalNumber(parsed, "temperature"),
        providerConcurrency: optionalNumber(parsed, "provider-concurrency"),
        explicitRemoteConsent: hasRemoteCostConsent(parsed),
        generate: options.generateText
      });
      const result = await runGoal(runId, ledger, artifacts, {
        arxivSearch: options.arxivSearch,
        offline: policy.offline,
        offlineReason: policy.reason,
        cwd,
        config,
        branchModels,
        swarmAdmissionConfirmed: hasSwarmAdmissionConfirmation(parsed),
        providerDiversityWaiver: providerDiversityWaiver(parsed),
        problemClassOverride: optionalProblemClass(parsed)
      });
      return JSON.stringify({
        runId,
        reconciliation,
        ...result,
        outputTrust: buildOutputTrustContract({
          run: ledger.requireRun(runId),
          events: ledger.listEvents(runId),
          replayCommand: followUpReplayCommand(runId)
        })
      }, null, 2);
    }

    if (subcommand === "resume-workers") {
      const runId = requiredRunId(rest);
      const reconciliation = reconcileGoalRunForResume({
        runId,
        ledger,
        cwd,
        config,
        reason: "worker resume reconciliation"
      });
      return JSON.stringify({
        runId,
        releasedExternalOperations: reconciliation.releasedExternalOperations,
        releasedBudgetReservations: reconciliation.releasedBudgetReservations,
        reconciled: reconciliation.staleWorkersReconciled,
        auditOk: reconciliation.auditOk,
        deterministicReplayOk: reconciliation.deterministicReplayOk,
        eventLogHash: reconciliation.eventLogHash,
        artifactManifestHash: reconciliation.artifactManifestHash
      }, null, 2);
    }

    if (subcommand === "watch") {
      const runId = requiredRunId(rest);
      const parsed = parseArgs(rest);
      const json = hasFlag(parsed, "json");
      const ticks = optionalPositiveInteger(parsed, "ticks");
      const intervalMs = optionalNonNegativeInteger(parsed, "interval-ms") ?? 1000;
      const follow = hasFlag(parsed, "follow") || hasFlag(parsed, "live");
      const frames = await pollGoalWatchSnapshots(ledger, runId, {
        intervalMs,
        ticks: ticks ?? (follow ? undefined : 1)
      });
      if (json) {
        return frames.length === 1
          ? JSON.stringify(frames[0], null, 2)
          : JSON.stringify({
              format: "matematica.goal-watch-stream",
              version: 1,
              runId,
              frames
            }, null, 2);
      }
      return frames.map((frame, index) =>
        frames.length === 1
          ? formatGoalWatchSnapshot(frame)
          : [`--- update ${index + 1} ---`, formatGoalWatchSnapshot(frame)].join("\n")
      ).join("\n\n");
    }

    throw new Error(`Unknown goal subcommand "${subcommand ?? ""}". Run matematica --help.`);
  } finally {
    ledger.close();
  }
}

function parseArgs(args: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }

    const key = arg.slice(2);
    const next = args[index + 1];
    if (next === undefined || next.startsWith("--")) {
      flags.set(key, true);
    } else {
      flags.set(key, next);
      index += 1;
    }
  }

  return { positional, flags };
}

function buildBranchModels(input: {
  command: "goal run" | "goal resume";
  parsed: ParsedArgs;
  config: ReturnType<typeof loadConfig>;
  localOnly: boolean;
  ledger: Ledger;
  artifacts: ArtifactStore;
  runId: string;
  maxOutputTokens: number;
  maxCallUsd?: number;
  temperature?: number;
  providerConcurrency?: number;
  explicitRemoteConsent: boolean;
  generate?: GenerateTextFunction;
}) {
  const routeSpecs = parseProviderRouteSpecs(input.parsed);
  if (routeSpecs.length === 0) return undefined;
  const resolvedRoutes = routeSpecs.map((route) =>
    resolveModel(input.config, { provider: route.provider, modelId: route.modelId })
  );
  const providerAllowlist = uniqueProviders(resolvedRoutes.map((route) => route.provider));
  const contractComparable = {
    format: "matematica.provider-routing-contract" as const,
    version: 1,
    routingPolicyVersion: "provider-routing-v1",
    command: input.command,
    runId: input.runId,
    providerAllowlist,
    fallbackPolicy: {
      automaticProviderFallback: false,
      silentModelSubstitution: false,
      explicitFallbackRequiresRoutingEvent: true
    },
    routeSelection: optionalString(input.parsed, "provider-routes") || optionalString(input.parsed, "provider-route")
      ? "--provider-routes"
      : "--provider/--model",
    routes: resolvedRoutes.map((route, index) => ({
      index,
      provider: route.provider,
      modelId: route.modelId,
      mode: route.provider === "local" ? "local-deterministic" : "ai-sdk",
      configured: true,
      remote: route.provider !== "local",
      maxOutputTokens: input.maxOutputTokens,
      maxUsd: input.maxCallUsd ?? null,
      providerConcurrency: input.providerConcurrency ?? null,
      explicitRemoteConsent: input.explicitRemoteConsent,
      capabilityRouteHash: stableHash(route.capabilities)
    }))
  };
  const routingContract = {
    ...contractComparable,
    routeHash: stableHash(contractComparable)
  };
  const routingArtifact = input.artifacts.create(input.runId, "provider.routing.contract", JSON.stringify(routingContract, null, 2));
  input.ledger.appendEvent(input.runId, "provider.routing.pinned", {
    ...routingContract,
    artifactId: routingArtifact.id
  }, [routingArtifact.id]);
  const modelOverrides = Object.fromEntries(resolvedRoutes.map((route) => [route.provider, route.modelId]));
  pinProviderMatrix({
    runId: input.runId,
    ledger: input.ledger,
    artifacts: input.artifacts,
    providers: providerCapabilityMatrix(input.config, { modelOverrides }),
    providerAllowlist,
    source: `${input.command}:branch-model-routing`,
    reason: "CLI provider route pinned before goal execution dispatch."
  });
  return resolvedRoutes.map((resolved) => ({
    ...resolved,
    generate: input.generate,
    settings: {
      temperature: input.temperature,
      maxOutputTokens: input.maxOutputTokens,
      maxUsd: input.maxCallUsd,
      resilience: input.providerConcurrency === undefined ? undefined : {
        maxConcurrency: input.providerConcurrency
      }
    },
    providerConfigured: true,
    remoteAdmission: {
      command: input.command,
      localOnly: input.localOnly,
      explicitRemoteConsent: input.explicitRemoteConsent,
      providerAllowlist
    }
  }));
}

function parseProviderRouteSpecs(parsed: ParsedArgs): Array<{ provider: ProviderName; modelId?: string }> {
  const routeList = optionalString(parsed, "provider-routes") ?? optionalString(parsed, "provider-route");
  const provider = optionalString(parsed, "provider");
  const modelId = optionalString(parsed, "model");
  if (routeList && provider) {
    throw new Error("Use either --provider/--model or --provider-routes, not both.");
  }
  if (!routeList) {
    return provider ? [{ provider: parseProviderName(provider), modelId }] : [];
  }
  const routes = routeList
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const separator = item.indexOf(":");
      const providerValue = separator === -1 ? item : item.slice(0, separator);
      const routeModelId = separator === -1 ? undefined : item.slice(separator + 1);
      if (routeModelId !== undefined && routeModelId.trim().length === 0) {
        throw new Error(`Provider route "${item}" is missing a model id after ":".`);
      }
      return {
        provider: parseProviderName(providerValue),
        modelId: routeModelId
      };
    });
  if (routes.length === 0) throw new Error("--provider-routes must include at least one provider route.");
  const seenProviders = new Set<ProviderName>();
  for (const route of routes) {
    if (seenProviders.has(route.provider)) {
      throw new Error(`Duplicate provider route for ${route.provider}; use one explicit route per provider to avoid ambiguous fallback.`);
    }
    seenProviders.add(route.provider);
  }
  return routes;
}

function parseProviderName(value: string): ProviderName {
  if (value === "openai" || value === "anthropic" || value === "openrouter" || value === "cerebras" || value === "local") {
    return value;
  }
  throw new Error(`Unknown provider "${value}". Expected openai, anthropic, openrouter, cerebras, or local.`);
}

function uniqueProviders(values: ProviderName[]): ProviderName[] {
  return [...new Set(values)];
}

function readProblem(parsed: ParsedArgs): string {
  const inline = optionalString(parsed, "problem");
  if (inline) return inline;

  const file = optionalString(parsed, "problem-file") ?? parsed.positional[0];
  if (!file) throw new Error("Missing problem. Use --problem text or --problem-file path.");
  if (!existsSync(file)) throw new Error(`Problem file not found: ${file}`);
  return readFileSync(file, "utf8").trim();
}

function requiredString(parsed: ParsedArgs, key: string): string {
  const value = optionalString(parsed, key);
  if (!value) throw new Error(`Missing required flag --${key}.`);
  return value;
}

function requiredNumber(parsed: ParsedArgs, key: string): number {
  const value = optionalNumber(parsed, key);
  if (value === undefined) throw new Error(`Missing required numeric flag --${key}.`);
  return value;
}

function requiredNumberAlias(parsed: ParsedArgs, key: string, aliases: string[]): number {
  const value = optionalNumberAlias(parsed, key, aliases);
  if (value === undefined) throw new Error(`Missing required numeric flag --${key}.`);
  return value;
}

function optionalNumberAlias(parsed: ParsedArgs, key: string, aliases: string[]): number | undefined {
  for (const candidate of [key, ...aliases]) {
    const value = optionalNumber(parsed, candidate);
    if (value !== undefined) return value;
  }
  return undefined;
}

function optionalString(parsed: ParsedArgs, key: string): string | undefined {
  const value = parsed.flags.get(key);
  if (typeof value === "string") return value;
  return undefined;
}

function hasFlag(parsed: ParsedArgs, key: string): boolean {
  return parsed.flags.get(key) === true;
}

function hasRemoteCostConsent(parsed: ParsedArgs): boolean {
  return hasFlag(parsed, "i-understand-remote-costs") || hasFlag(parsed, "allow-remote-costs");
}

function hasNetworkOptIn(parsed: ParsedArgs): boolean {
  return hasFlag(parsed, "allow-network") || hasFlag(parsed, "online");
}

function hasPrivacyOffline(parsed: ParsedArgs): boolean {
  return hasFlag(parsed, "offline") || hasFlag(parsed, "private");
}

function redactPrivateCliText(input: string, parsed: ParsedArgs): string {
  if (!hasFlag(parsed, "private")) return input;
  return input
    .replace(/\/home\/[^\s"'<>]+/g, "<redacted-local-path>")
    .replace(/\/Users\/[^\s"'<>]+/g, "<redacted-local-path>")
    .replace(/\/tmp\/[^\s"'<>]+/g, "<redacted-local-path>")
    .replace(/file:\/\/[^\s"'<>]+/g, "<redacted-local-path>");
}

function recordCliPrivacyPolicy(input: {
  runId: string;
  command: string;
  parsed: ParsedArgs;
  ledger: Ledger;
  artifacts: ArtifactStore;
  forceRedactedExport?: boolean;
}): void {
  const privateMode = hasFlag(input.parsed, "private");
  const redactedExport = input.forceRedactedExport === true || hasFlag(input.parsed, "redacted-export");
  if (!privateMode && !redactedExport) return;

  const policy = {
    format: "matematica.cli-privacy-policy",
    version: 1,
    command: input.command,
    privateMode,
    mode: privateMode ? "private-redacted-local-only" : "standard-redacted",
    networkPolicy: privateMode ? "local-only" : "default-zero-network-or-explicit-remote",
    providerEgress: privateMode ? "remote-provider-calls-blocked" : "sanitized-explicit-remote-only",
    promptPersistence: "local-redacted-artifact",
    responsePersistence: "local-redacted-artifact",
    rawPromptTextPersisted: false,
    rawProviderTextPersisted: false,
    rawSourceTextPersisted: false,
    privateFilesystemPathsPersisted: false,
    artifactRetention: {
      localRedactedArtifacts: "retain_until_operator_prunes_or_deletes_matematica_home",
      rawArtifacts: "not_persisted",
      portableExports: "operator_managed_files"
    },
    exportPolicy: {
      defaultPolicy: "redacted_portable_bundle",
      requestedRedactedExport: redactedExport,
      rawExportSupported: false,
      rawExportRequiresExplicitConsent: true,
      localPathMode: "relative_to_matematica_home"
    }
  };
  const artifact = input.artifacts.create(input.runId, "privacy.cli-policy", JSON.stringify(policy, null, 2));
  input.ledger.appendEvent(input.runId, "privacy.mode.selected", {
    ...policy,
    artifactId: artifact.id,
    policyHash: artifact.sha256
  }, [artifact.id]);
}

function readPortableBundle(path: string): Parameters<typeof importReproducibilityBundle>[0]["bundle"] {
  const bytes = readFileSync(path);
  const content = bytes[0] === 0x1f && bytes[1] === 0x8b
    ? gunzipSync(bytes).toString("utf8")
    : bytes.toString("utf8");
  return JSON.parse(content) as Parameters<typeof importReproducibilityBundle>[0]["bundle"];
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function hasSwarmAdmissionConfirmation(parsed: ParsedArgs): boolean {
  return hasFlag(parsed, "yes") || hasFlag(parsed, "confirm-swarm");
}

function providerDiversityWaiver(parsed: ParsedArgs): { reason: string; actor: string } | undefined {
  const reason = optionalString(parsed, "provider-diversity-waiver") ?? optionalString(parsed, "allow-provider-collapse-waiver");
  return reason ? { reason, actor: "operator-cli" } : undefined;
}

function optionalProblemClass(parsed: ParsedArgs): ProblemClass | undefined {
  const value = optionalString(parsed, "problem-class");
  if (value === undefined) return undefined;
  if (value === "open_problem" || value === "standard_problem") return value;
  throw new Error(`Invalid --problem-class "${value}". Expected open_problem or standard_problem.`);
}

function optionalNumber(parsed: ParsedArgs, key: string): number | undefined {
  const value = optionalString(parsed, key);
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`--${key} must be a number.`);
  return number;
}

function listFlag(parsed: ParsedArgs, key: string): string[] {
  return optionalString(parsed, key)
    ?.split(";")
    .map((item) => item.trim())
    .filter(Boolean) ?? [];
}

function parseFormalizationStatus(value: string): FormalizationAssessment["status"] {
  if (
    value === "not_required" ||
    value === "equivalent" ||
    value === "not_assessed" ||
    value === "mismatch" ||
    value === "not_formalized" ||
    value === "partial" ||
    value === "weakened" ||
    value === "unknown" ||
    value === "contradictory"
  ) {
    return value;
  }
  throw new Error(`Invalid formalization status "${value}".`);
}

function parseEvidenceGrade(value: string): EvidenceGrade {
  if (
    value === "formal_proof" ||
    value === "verified_counterexample" ||
    value === "verified_computation" ||
    value === "literature_backed_reduction" ||
    value === "conjectural_solution" ||
    value === "heuristic_evidence" ||
    value === "unsupported" ||
    value === "contradicted" ||
    value === "budget_exhausted" ||
    value === "none"
  ) {
    return value;
  }
  throw new Error(`Invalid evidence grade "${value}".`);
}

function parseClaimType(value: string): ClaimType {
  if (
    value === "conjecture" ||
    value === "proof_sketch" ||
    value === "lean_checked_theorem" ||
    value === "literature_backed_lemma" ||
    value === "numerical_evidence" ||
    value === "counterexample" ||
    value === "failed_attempt" ||
    value === "contradiction"
  ) {
    return value;
  }
  throw new Error(`Invalid claim type "${value}".`);
}

function parseVerifierStatus(value: string): VerifierStatus {
  if (value === "not_checked" || value === "verified" || value === "failed" || value === "inapplicable") return value;
  throw new Error(`Invalid verifier status "${value}".`);
}

function parseSourceSupport(value: string): "none" | "uncorroborated" | "cited" | "verified" {
  if (value === "none" || value === "uncorroborated" || value === "cited" || value === "verified") return value;
  throw new Error(`Invalid source support "${value}".`);
}

function parseCounterexampleSearch(value: string): "not_run" | "attempted" | "passed" | "found" {
  if (value === "not_run" || value === "attempted" || value === "passed" || value === "found") return value;
  throw new Error(`Invalid counterexample search "${value}".`);
}

function parseReproducibility(value: string): "none" | "partial" | "manifest" | "deterministic" {
  if (value === "none" || value === "partial" || value === "manifest" || value === "deterministic") return value;
  throw new Error(`Invalid reproducibility "${value}".`);
}

function parseBooleanFlag(parsed: ParsedArgs, key: string): boolean {
  const value = parsed.flags.get(key);
  if (value === true) return true;
  if (typeof value === "string") return value === "true" || value === "1" || value === "yes";
  return false;
}

function formatToolProbe(name: string, probe: LeanToolProbe): string {
  if (probe.status === "ok") return `${name}: ok (${probe.version ?? probe.bin})`;
  if (probe.status === "missing") return `${name}: missing (${probe.bin})`;
  return `${name}: failed (${probe.error ?? probe.version ?? probe.bin})`;
}

function formatMathlibProbe(probe: LeanMathlibProbe): string {
  const version = probe.version ?? "unknown";
  const details = [
    `version: ${version}`,
    `cache: ${probe.cachePath}`,
    `method: ${probe.method}`
  ];
  if (probe.error) details.push(`detail: ${probe.error}`);
  return `mathlib import: ${probe.status} (${details.join("; ")})`;
}

function formatProviderLegalPrivacyGate(report: ReturnType<typeof buildProviderLegalPrivacyGateReport>): string {
  const lines = [
    `Provider legal/privacy gate: ${report.ok ? "pass" : "fail"} (checked=${report.checkedAt}, maxAgeDays=${report.maxAgeDays})`
  ];
  for (const check of report.checks) {
    lines.push(`  ${check.provider}/${check.modelId}: ${check.ok ? "pass" : "fail"} policyHash=${check.policyHash} reviewed=${check.reviewedAt} expires=${check.expiresAt}`);
    for (const issue of check.issues) lines.push(`    issue: ${issue}`);
  }
  return lines.join("\n");
}

function optionalHours(parsed: ParsedArgs, key: string): number | undefined {
  const hours = optionalNumber(parsed, key);
  return hours === undefined ? undefined : hours * 60 * 60 * 1000;
}

function staleBeforeFromMaxAge(maxAgeDays: number | undefined): string | undefined {
  if (maxAgeDays === undefined) return undefined;
  return new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
}

function researchEnrichmentEventPayload(enrichment: ArxivResearchEnrichment) {
  return {
    semanticDedupe: {
      originalCount: enrichment.semanticDedupe.originalCount,
      uniqueCount: enrichment.semanticDedupe.uniqueCount,
      duplicateCount: enrichment.semanticDedupe.duplicateCount,
      groups: enrichment.semanticDedupe.groups
    },
    citationGraph: {
      nodeCount: enrichment.citationGraph.nodes.length,
      edgeCount: enrichment.citationGraph.edges.length,
      graphHash: enrichment.citationGraph.graphHash
    },
    snapshots: {
      count: enrichment.snapshots.length,
      storagePolicy: "metadata_only_not_exported",
      manifestHash: stableHash(enrichment.snapshots)
    },
    citationLicenseManifestSummary: {
      count: enrichment.citationLicenseManifest.summary.count,
      staleCount: enrichment.citationLicenseManifest.summary.staleCount,
      hostileCount: enrichment.citationLicenseManifest.summary.hostileCount,
      pdfOrSourceContentExported: false,
      proofSupportPolicy: enrichment.citationLicenseManifest.summary.proofSupportPolicy,
      manifestHash: enrichment.citationLicenseManifest.manifestHash
    },
    sourceQuality: {
      averageScore: enrichment.sourceQuality.averageScore,
      highQualityCount: enrichment.sourceQuality.highQualityCount,
      mediumQualityCount: enrichment.sourceQuality.mediumQualityCount,
      lowQualityCount: enrichment.sourceQuality.lowQualityCount
    }
  };
}

function appendResearchEnrichmentEvents(
  ledger: Ledger,
  runId: string,
  input: {
    query: string;
    externalOperationId?: string;
    artifactId: string;
    enrichment: ArxivResearchEnrichment;
  }
): void {
  const base = {
    provider: "arxiv",
    query: input.query,
    externalOperationId: input.externalOperationId,
    artifactId: input.artifactId
  };
  ledger.appendEvent(runId, "source.dedupe.reviewed", {
    ...base,
    ...input.enrichment.semanticDedupe
  }, [input.artifactId]);
  ledger.appendEvent(runId, "source.citation_graph.extracted", {
    ...base,
    ...input.enrichment.citationGraph
  }, [input.artifactId]);
  ledger.appendEvent(runId, "source.snapshots.planned", {
    ...base,
    snapshots: input.enrichment.snapshots,
    manifestHash: stableHash(input.enrichment.snapshots)
  }, [input.artifactId]);
  ledger.appendEvent(runId, "source.license.manifest.reviewed", {
    ...base,
    ...input.enrichment.citationLicenseManifest
  }, [input.artifactId]);
  ledger.appendEvent(runId, "source.quality.reviewed", {
    ...base,
    ...input.enrichment.sourceQuality
  }, [input.artifactId]);
}

type GoalWatchSnapshot = {
  format: "matematica.goal-watch";
  version: 1;
  runId: string;
  generatedAt: string;
  terminal: boolean;
  run: {
    status: GoalRun["status"];
    evidenceGrade: EvidenceGrade;
    workflow: GoalRun["workflow"];
    createdAt: string;
    startedAt?: string;
    completedAt?: string;
  };
  phase: {
    current?: string;
    latest?: string;
    started?: string;
    completed?: string;
  };
  cycle: {
    current?: number;
    latest?: number;
  };
  workers: {
    total: number;
    byStatus: Record<string, number>;
    active: GoalWatchWorker[];
    latest: GoalWatchWorker[];
  };
  budget: {
    configured: GoalRun["budget"];
    used: BudgetUsage;
    remaining: BudgetRemaining;
  };
  providerSpend: Array<{
    provider: string;
    used: BudgetUsage;
    operations: number;
    byStatus: Record<string, number>;
  }>;
  latestArtifacts: Array<Pick<Artifact, "id" | "kind" | "bytes" | "createdAt" | "sha256">>;
  currentBestClaim?: {
    claimId?: string;
    evidenceGrade?: string;
    status?: string;
    canMarkGoalMet?: boolean;
    conclusion?: string;
    sourceEventId: string;
  };
  warnings: string[];
  terminalReason?: string;
  latestEvent?: {
    id: string;
    type: string;
    createdAt: string;
  };
  counts: {
    events: number;
    artifacts: number;
    externalOperations: number;
  };
};

type GoalWatchWorker = {
  id: string;
  kind: string;
  status: WorkerJob["status"];
  attempts: number;
  maxAttempts: number;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  updatedAt: string;
};

type BudgetRemaining = {
  attempts: number | null;
  tokens: number | null;
  usd: number | null;
  elapsedMs: number | null;
  artifactBytes: number | null;
  sourceQueries: number | null;
  retries: number | null;
  sandboxMs: number | null;
};

async function pollGoalWatchSnapshots(
  ledger: Ledger,
  runId: string,
  input: { intervalMs: number; ticks?: number }
): Promise<GoalWatchSnapshot[]> {
  const frames: GoalWatchSnapshot[] = [];
  let tick = 0;
  while (true) {
    const snapshot = buildGoalWatchSnapshot(ledger, runId);
    frames.push(snapshot);
    tick += 1;
    if (input.ticks !== undefined && tick >= input.ticks) break;
    if (input.ticks === undefined && snapshot.terminal) break;
    await sleep(input.intervalMs);
  }
  return frames;
}

function buildGoalWatchSnapshot(ledger: Ledger, runId: string): GoalWatchSnapshot {
  const run = ledger.requireRun(runId);
  const events = ledger.listEvents(runId);
  const artifacts = ledger.listArtifacts(runId);
  const operations = ledger.listExternalOperations(runId);
  const jobs = ledger.listWorkerJobs(runId);
  const used = ledger.getBudgetUsage(runId);
  const latestEvent = events.at(-1);
  return {
    format: "matematica.goal-watch",
    version: 1,
    runId,
    generatedAt: new Date().toISOString(),
    terminal: isTerminalStatus(run.status),
    run: {
      status: run.status,
      evidenceGrade: run.evidenceGrade,
      workflow: run.workflow,
      createdAt: run.createdAt,
      startedAt: run.startedAt,
      completedAt: run.completedAt
    },
    phase: phaseSnapshot(events),
    cycle: cycleSnapshot(events),
    workers: workerSnapshot(jobs),
    budget: {
      configured: run.budget,
      used,
      remaining: remainingBudget(run, used)
    },
    providerSpend: providerSpendSnapshot(ledger, runId, operations),
    latestArtifacts: artifacts.slice(-5).reverse().map((artifact) => ({
      id: artifact.id,
      kind: artifact.kind,
      bytes: artifact.bytes,
      createdAt: artifact.createdAt,
      sha256: artifact.sha256
    })),
    currentBestClaim: currentBestClaim(events),
    warnings: watchWarnings(run, events, operations, jobs),
    terminalReason: terminalReason(events, run),
    latestEvent: latestEvent ? {
      id: latestEvent.id,
      type: latestEvent.type,
      createdAt: latestEvent.createdAt
    } : undefined,
    counts: {
      events: events.length,
      artifacts: artifacts.length,
      externalOperations: operations.length
    }
  };
}

function phaseSnapshot(events: LedgerEvent[]): GoalWatchSnapshot["phase"] {
  const started = events.filter((event) => event.type === "phase.started").at(-1);
  const completed = events.filter((event) => event.type === "phase.completed").at(-1);
  const latest = [...events].reverse().find((event) =>
    (event.type === "phase.started" || event.type === "phase.completed") && typeof event.payload.phase === "string"
  );
  return {
    current: stringValue(started?.payload.phase),
    latest: stringValue(latest?.payload.phase),
    started: stringValue(started?.payload.phase),
    completed: stringValue(completed?.payload.phase)
  };
}

function cycleSnapshot(events: LedgerEvent[]): GoalWatchSnapshot["cycle"] {
  const started = [...events].reverse().find((event) => event.type === "cycle.started");
  const latest = [...events].reverse().find((event) =>
    (event.type === "cycle.started" || event.type === "cycle.completed") && numberValue(event.payload.cycle) !== undefined
  );
  return {
    current: numberValue(started?.payload.cycle),
    latest: numberValue(latest?.payload.cycle)
  };
}

function workerSnapshot(jobs: WorkerJob[]): GoalWatchSnapshot["workers"] {
  const byStatus: Record<string, number> = {};
  for (const job of jobs) byStatus[job.status] = (byStatus[job.status] ?? 0) + 1;
  const mapped = jobs.map(watchWorker);
  return {
    total: jobs.length,
    byStatus,
    active: mapped.filter((job) => job.status === "pending" || job.status === "leased" || job.status === "running" || job.status === "failed_retryable"),
    latest: [...mapped].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, 5)
  };
}

function watchWorker(job: WorkerJob): GoalWatchWorker {
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    leaseOwner: job.leaseOwner,
    leaseExpiresAt: job.leaseExpiresAt,
    updatedAt: job.updatedAt
  };
}

function remainingBudget(run: GoalRun, used: BudgetUsage): BudgetRemaining {
  return {
    attempts: remaining(run.budget.maxAttempts, used.attempts),
    tokens: remaining(run.budget.maxTokens, used.tokens),
    usd: remaining(run.budget.maxUsd, used.usd),
    elapsedMs: remaining(run.budget.maxWallTimeMs, used.elapsedMs),
    artifactBytes: remaining(run.budget.maxArtifactBytes, used.artifactBytes),
    sourceQueries: remaining(run.budget.maxSourceQueries, used.sourceQueries),
    retries: remaining(run.budget.maxRetries, used.retries),
    sandboxMs: remaining(run.budget.maxSandboxMs, used.sandboxMs)
  };
}

function remaining(cap: number | undefined, used: number): number | null {
  return cap === undefined ? null : Math.max(0, cap - used);
}

function providerSpendSnapshot(
  ledger: Ledger,
  runId: string,
  operations: ExternalOperation[]
): GoalWatchSnapshot["providerSpend"] {
  const groups = new Map<string, { operations: ExternalOperation[]; byStatus: Record<string, number> }>();
  for (const operation of operations) {
    const provider = operation.provider ?? operation.operationType;
    const group = groups.get(provider) ?? { operations: [], byStatus: {} };
    group.operations.push(operation);
    group.byStatus[operation.status] = (group.byStatus[operation.status] ?? 0) + 1;
    groups.set(provider, group);
  }
  return [...groups.entries()]
    .map(([provider, group]) => ({
      provider,
      used: ledger.getBudgetUsage(runId, { provider }),
      operations: group.operations.length,
      byStatus: group.byStatus
    }))
    .sort((left, right) => left.provider.localeCompare(right.provider));
}

function currentBestClaim(events: LedgerEvent[]): GoalWatchSnapshot["currentBestClaim"] | undefined {
  const event = [...events].reverse().find((candidate) =>
    candidate.type === "goal.success.evaluated" ||
    candidate.type === "branch.candidate_claim.reviewed" ||
    candidate.type === "verifier.completed"
  );
  if (!event) return undefined;
  return {
    claimId: stringValue(event.payload.claimId) ?? stringValue(event.payload.subjectId) ?? stringValue(event.payload.verifierId),
    evidenceGrade: stringValue(event.payload.evidenceGrade),
    status: stringValue(event.payload.status),
    canMarkGoalMet: booleanValue(event.payload.canMarkGoalMet) ?? booleanValue(event.payload.canClaimSolved),
    conclusion: stringValue(event.payload.conclusion) ?? stringValue(event.payload.reason),
    sourceEventId: event.id
  };
}

function watchWarnings(
  run: GoalRun,
  events: LedgerEvent[],
  operations: ExternalOperation[],
  jobs: WorkerJob[]
): string[] {
  const warnings: string[] = [];
  const unknownOperations = operations.filter((operation) => operation.status === "unknown_remote_outcome");
  const deadLetterOperations = operations.filter((operation) => operation.status === "dead_lettered");
  const openOperations = operations.filter((operation) => operation.status === "reserved" || operation.status === "running");
  const failedWorkers = jobs.filter((job) => job.status === "failed_terminal");
  const staleWorkers = jobs.filter((job) =>
    (job.status === "leased" || job.status === "running") &&
    job.leaseExpiresAt !== undefined &&
    job.leaseExpiresAt < new Date().toISOString()
  );
  if (unknownOperations.length > 0) warnings.push(`${unknownOperations.length} external operation(s) need explicit remote outcome review.`);
  if (deadLetterOperations.length > 0) warnings.push(`${deadLetterOperations.length} remote dispatch operation(s) are dead-lettered and require operator settlement.`);
  if (openOperations.length > 0) warnings.push(`${openOperations.length} external operation(s) are still reserved or running.`);
  if (failedWorkers.length > 0) warnings.push(`${failedWorkers.length} worker job(s) failed terminally.`);
  if (staleWorkers.length > 0) warnings.push(`${staleWorkers.length} active worker lease(s) are stale.`);
  if (latestIncompleteResearch(events)) warnings.push("Latest research retrieval is incomplete; treat feedback evidence as provisional.");
  if (isTerminalStatus(run.status) && run.status !== "goal_met") warnings.push(`Run ended with terminal status ${run.status}.`);
  return warnings;
}

function latestIncompleteResearch(events: LedgerEvent[]): boolean {
  const event = [...events].reverse().find((candidate) =>
    candidate.type === "source.results" || candidate.type === "source.retrieval.evaluated"
  );
  if (!event) return false;
  return booleanValue(event.payload.incompleteResearch) ??
    booleanValue(recordValue(event.payload.retrievalEvaluation)?.incompleteResearch) ??
    false;
}

function terminalReason(events: LedgerEvent[], run: GoalRun): string | undefined {
  const event = [...events].reverse().find((candidate) =>
    candidate.type === "goal.completed" ||
    candidate.type === "goal.failed" ||
    candidate.type === "goal.cancelled" ||
    candidate.type === "cycle.completed"
  );
  return stringValue(event?.payload.reason) ?? (isTerminalStatus(run.status) ? run.status : undefined);
}

function formatGoalWatchSnapshot(snapshot: GoalWatchSnapshot): string {
  return [
    `Run: ${snapshot.runId}`,
    `Status: ${snapshot.run.status}`,
    `Evidence grade: ${snapshot.run.evidenceGrade}`,
    `Workflow: ${snapshot.run.workflow}`,
    `Phase: ${snapshot.phase.current ?? snapshot.phase.latest ?? "none"}`,
    `Cycle: ${snapshot.cycle.current ?? snapshot.cycle.latest ?? "none"}`,
    `Workers: ${snapshot.workers.total} total ${formatCounts(snapshot.workers.byStatus)}`,
    `Budget used: ${formatBudgetUsage(snapshot.budget.used)}`,
    `Budget remaining: ${formatBudgetRemaining(snapshot.budget.remaining)}`,
    `Provider spend: ${formatProviderSpend(snapshot.providerSpend)}`,
    `Latest artifacts: ${snapshot.latestArtifacts.length === 0 ? "none" : snapshot.latestArtifacts.map((artifact) => `${artifact.kind}:${artifact.id} (${artifact.bytes} bytes)`).join(", ")}`,
    `Current best claim: ${formatCurrentBestClaim(snapshot.currentBestClaim)}`,
    `Warnings: ${snapshot.warnings.length === 0 ? "none" : snapshot.warnings.join(" | ")}`,
    `Terminal reason: ${snapshot.terminalReason ?? "none"}`,
    `Latest event: ${snapshot.latestEvent?.type ?? "none"}`
  ].join("\n");
}

function formatCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts).sort(([left], [right]) => left.localeCompare(right));
  return entries.length === 0 ? "(none)" : `(${entries.map(([status, count]) => `${status}=${count}`).join(", ")})`;
}

function formatBudgetUsage(usage: BudgetUsage): string {
  return `attempts=${usage.attempts}, tokens=${usage.tokens}, usd=${usage.usd}, elapsedMs=${usage.elapsedMs}, artifactBytes=${usage.artifactBytes}, sourceQueries=${usage.sourceQueries}, retries=${usage.retries}, sandboxMs=${usage.sandboxMs}`;
}

function formatBudgetRemaining(remainingUsage: BudgetRemaining): string {
  return `attempts=${formatRemaining(remainingUsage.attempts)}, tokens=${formatRemaining(remainingUsage.tokens)}, usd=${formatRemaining(remainingUsage.usd)}, elapsedMs=${formatRemaining(remainingUsage.elapsedMs)}, artifactBytes=${formatRemaining(remainingUsage.artifactBytes)}, sourceQueries=${formatRemaining(remainingUsage.sourceQueries)}, retries=${formatRemaining(remainingUsage.retries)}, sandboxMs=${formatRemaining(remainingUsage.sandboxMs)}`;
}

function formatRemaining(value: number | null): string {
  return value === null ? "uncapped" : String(value);
}

function formatProviderSpend(spend: GoalWatchSnapshot["providerSpend"]): string {
  if (spend.length === 0) return "none";
  return spend.map((provider) =>
    `${provider.provider} ${formatBudgetUsage(provider.used)} operations=${provider.operations} ${formatCounts(provider.byStatus)}`
  ).join("; ");
}

function formatCurrentBestClaim(claim: GoalWatchSnapshot["currentBestClaim"]): string {
  if (!claim) return "none";
  const parts = [
    claim.claimId ? `id=${claim.claimId}` : undefined,
    claim.status ? `status=${claim.status}` : undefined,
    claim.evidenceGrade ? `evidence=${claim.evidenceGrade}` : undefined,
    claim.canMarkGoalMet !== undefined ? `canMarkGoalMet=${claim.canMarkGoalMet}` : undefined,
    claim.conclusion ? `conclusion=${claim.conclusion}` : undefined
  ].filter((item): item is string => item !== undefined);
  return parts.length === 0 ? `event=${claim.sourceEventId}` : parts.join(", ");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function optionalPositiveInteger(parsed: ParsedArgs, key: string): number | undefined {
  const value = optionalNumber(parsed, key);
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value <= 0) throw new Error(`--${key} must be a positive integer.`);
  return value;
}

function optionalNonNegativeInteger(parsed: ParsedArgs, key: string): number | undefined {
  const value = optionalNumber(parsed, key);
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 0) throw new Error(`--${key} must be a non-negative integer.`);
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requiredRunId(args: string[]): string {
  const runId = args.find((arg) => !arg.startsWith("--"));
  if (!runId) throw new Error("Missing run id.");
  return runId;
}

function help(): string {
  return [
    "matematica",
    "",
    "Usage:",
    "  matematica solve --problem <text> --goal <text> --budget-usd <number> [--workflow pflk|gree] [--max-attempts <number>] [--max-hours <number>] [--workers <number>] [--private]",
    "  matematica solve --problem-file <path> --goal <text> --budget-usd <number> [--workflow pflk|gree]",
    "  matematica doctor [--lean-bin <path>] [--lake-bin <path>] [--elan-bin <path>]",
    "  matematica doctor --release [--json] [--remote-swarm] [--clean-home]",
    "  matematica config show",
    "  matematica storage init-encrypted [--key-env MATEMATICA_STORAGE_KEY]",
    "  matematica storage prune-caches [--older-than-hours <number>] [--run-id <run-id>] [--dry-run]",
    "  matematica storage maintenance [--run-id <run-id>]",
    "  matematica contract show [--json]",
    "  matematica providers list [--json]",
    "  matematica providers smoke --provider <name> --run-id <run-id> [--model <id>] [--max-call-usd <number>] [--i-understand-remote-costs]",
    "  matematica providers hostile-dry-run --provider <name> --run-id <run-id> --max-call-usd <number> [--model <id>] [--max-output-tokens <number>] [--timeout-ms <number>] [--i-understand-remote-costs]",
    "  matematica benchmarks hostile",
    "  matematica benchmarks release-gate",
    "  matematica benchmarks ladder [--json]",
    "  matematica milestones list [--json]",
    "  matematica release-plan show [--json]",
    "  matematica release-plan registry [--json]",
    "  matematica release-plan evidence [--json]",
    "  matematica release check [--json] [--dry-run]",
    "  matematica drills swarm-kill [--worker-counts 1,4,16,100]",
    "  matematica drills swarm-stress [--workers 100] [--provider-concurrency 8]",
    "  matematica research arxiv --query <query> [--run-id <run-id>] [--allow-network|--offline|--private] [--include-abstracts] [--expected-relevant-ids <list>] [--expected-terms <list>]",
    "  matematica goal create --problem <text> --goal <text> [--workflow pflk|gree] [--private]",
    "  matematica goal create --problem-file <path> --goal <text>",
    "  matematica goal run <run-id> [--allow-network|--offline|--private] [--provider <name>] [--model <id>] [--provider-routes <provider:model;...>] [--max-output-tokens <number>] [--max-call-usd <number>] [--i-understand-remote-costs] [--provider-diversity-waiver <reason>]",
    "  matematica goal admission <run-id> [--private] [--provider <name>] [--model <id>] [--provider-routes <provider:model;...>] [--max-call-usd <number>] [--yes] [--provider-diversity-waiver <reason>]",
    "  matematica goal status <run-id>",
    "  matematica goal watch <run-id> [--json] [--follow|--live] [--interval-ms <number>] [--ticks <number>]",
    "  matematica goal replay <run-id>",
    "  matematica goal replay <run-id> --manifest",
    "  matematica goal replay <run-id> --offline",
    "  matematica goal replay <run-id> --offline --verify-final",
    "  matematica goal replay <run-id> --deterministic",
    "  matematica goal replay <run-id> --export <bundle.json> [--redacted-export]",
    "  matematica goal replay <run-id> --archive <bundle.json.gz> [--redacted-export]",
    "  matematica goal replay --import <bundle.json>",
    "  matematica goal report <run-id>",
    "  matematica goal formalization <run-id> --status equivalent|not_assessed|mismatch|not_required|not_formalized|partial|weakened|unknown|contradictory --formal-statement <text> [--missing-definitions <list>] [--missing-lemmas <list>] [--missing-assumptions <list>]",
    "  matematica goal equivalence <run-id> --status equivalent|weakened|mismatch|partial|unknown|contradictory --normalized-statement <text> --formal-statement <text> --conclusion <text> [--statement-diffs <list>] [--known-gaps <list>]",
    "  matematica goal normalize <run-id> --formal-statement <text>",
    "  matematica goal score <run-id> --subject <id> --evidence-grade <grade> --claim-type <type> [--model-agreement-only]",
    "  matematica goal verify-lean <run-id> --file <path> [--project-root <path>] [--lean-bin <path>] [--lake-bin <path>] [--timeout-ms <number>]",
    "  matematica goal audit <run-id> [--saved-everything]",
    "  matematica goal stop <run-id>",
    "  matematica goal resume <run-id> [--reopen-terminal] [--allow-network|--offline|--private] [--provider <name>] [--model <id>] [--provider-routes <provider:model;...>] [--max-output-tokens <number>] [--max-call-usd <number>] [--provider-concurrency <number>] [--i-understand-remote-costs] [--provider-diversity-waiver <reason>]",
    "  matematica goal resume-workers <run-id>",
    "",
    "Budget flags:",
    "  --offline",
    "  --private                    force local-only private mode and ledger a redacted retention/export policy",
    "  --redacted-export            make portable replay export intent explicit; raw exports are not supported in the public CLI",
    "  --budget-usd <number>",
    "  --usd <number>              alias for --budget-usd",
    "  --max-tokens <number>",
    "  --max-output-tokens <number>",
    "  --max-call-usd <number>       required for remote provider calls; used as pessimistic per-call USD cap",
    "  --provider-routes <routes>     semicolon-separated explicit routes, e.g. openai:gpt-5.2;anthropic:claude-opus-4-1-20250805;openrouter:openai/gpt-5.2;cerebras:gpt-oss-120b",
    "  --provider-diversity-waiver <reason>  persist an operator waiver when high-fanout remote routes intentionally collapse to one provider/model",
    "  --provider-concurrency <number> explicit remote provider rate-limit cap for high-fanout runs",
    "  --max-hours <number>",
    "  --max-attempts <number>",
    "  --max-artifact-bytes <number>",
    "  --max-source-queries <number>",
    "  --max-retries <number>",
    "  --max-sandbox-ms <number>",
    "  --workers <number>",
    "  --agents <number>           alias for --workers",
    "  --yes                       confirm reviewed swarm admission for 100-worker fanout",
    "  --problem-class <class>      optional audited override: open_problem or standard_problem; cannot relax open-problem verifier policy",
    "  --i-understand-remote-costs  required before paid BYOK multi-worker remote fanout",
    "  --allow-remote-costs         alias for --i-understand-remote-costs",
    "",
    "Command contract:",
    "  solve        one-shot create+run entry point for prompt+budget runs with follow-up watch/report/replay/resume commands",
    "  goal create  persist problem, goal, workflow, success criteria, and budget caps without executing workers",
    "  goal run     continue until goal_met, budget_exhausted, cancelled, failed, or needs_human_review",
    "  goal watch   monitor phase, cycle, workers, budget, provider spend, artifacts, warnings, and terminal reason",
    "  goal resume  reconcile crash state, preserve terminal states unless --reopen-terminal is provided, then continue the run",
    "  goal report  human-readable final report from persisted ledger and artifacts",
    "  goal replay  event log, manifest, deterministic replay, offline final verification, or redacted clean-home export/archive/import",
    "  goal audit   ledger/artifact integrity check for a run; --saved-everything reports action-category persistence coverage",
    "  contract     free OSS versus paid BYOK execution contract",
    "  benchmarks   hostile math gates and hard-math usefulness ladder",
    "  milestones   ordered release gates from local core through public OSS release",
    "  release-plan canonical task registry and shared implementation-plan mirror for the Matematica release-critical path",
    "  drills       reliability harnesses such as the swarm kill-drill matrix",
    "  doctor       local environment, provider, Lean, zero-network, BYOK, and release readiness diagnostics",
    "  storage      opt-in encrypted-at-rest local run ledger/artifacts plus retention cache pruning controls",
    "",
    "Exit code contract:",
    "  0  command succeeded; for solve/run/resume this means goal_met",
    "  1  operational or validation failure; no successful terminal run result was produced",
    "  2  solve/run/resume reached an honest budget_exhausted terminal report",
    "  3  solve/run/resume ended cancelled",
    "  4  solve/run/resume ended needs_human_review or failed evidence gates"
  ].join("\n");
}

function followUpCommands(runId: string): Record<string, string> {
  return {
    watch: `matematica goal watch ${runId}`,
    report: `matematica goal report ${runId}`,
    replay: followUpReplayCommand(runId),
    resume: `matematica goal resume ${runId}`
  };
}

function parseWorkerCounts(value: string | undefined): number[] | undefined {
  if (!value) return undefined;
  const counts = value.split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item) && item > 0)
    .map((item) => Math.floor(item));
  if (counts.length === 0) throw new Error("--worker-counts must include at least one positive integer.");
  return counts;
}

function exitCodeForTerminalCommand(argv: string[], output: string): number | undefined {
  const [command, subcommand] = argv;
  if (command !== "solve" && !(command === "goal" && (subcommand === "run" || subcommand === "resume"))) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(output) as { exitCode?: unknown; status?: unknown };
    if (typeof parsed.exitCode === "number") return parsed.exitCode;
    if (typeof parsed.status === "string") return exitCodeForRunStatus(parsed.status);
  } catch {
    return undefined;
  }
  return undefined;
}

function exitCodeForRunStatus(status: string): number {
  if (status === "goal_met") return 0;
  if (status === "budget_exhausted") return 2;
  if (status === "cancelled") return 3;
  return 4;
}
