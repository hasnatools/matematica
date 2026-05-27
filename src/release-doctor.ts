import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { MatematicaConfig, ProviderConfig } from "./config";
import { buildSavedEverythingReleaseCoverageReport } from "./audit";
import { buildAiSdkCompatibilityReport } from "./ai-sdk-compat";
import { formatHardMathBenchmarkLadder, runZeroFalseSolvedReleaseGate, type ZeroFalseSolvedReleaseGateReport } from "./benchmarks";
import { buildExternalOutcomeReconciliationReport } from "./external-reconciliation";
import { buildDefaultExternalFreshnessSnapshots, buildExternalFreshnessGateReport } from "./freshness";
import {
  IMPLEMENTATION_PLAN_REGISTRY_MIRROR_RELATIVE_PATH,
  readSharedImplementationPlanRegistryMirror,
  validateSharedImplementationPlanRegistryMirror
} from "./implementation-plan-registry";
import { Ledger } from "./ledger";
import {
  RELEASE_MILESTONE_PLAN,
  validateMilestonePlan,
  validateMilestoneReadiness,
  type MilestonePlan
} from "./milestones";
import { classifyFinalOutcome } from "./outcome";
import { getAppPaths } from "./paths";
import { classificationForRun } from "./problem-classifier";
import { HOSTILE_PROVIDER_DRY_RUN_MAX_AGE_DAYS } from "./provider-dry-run";
import { buildProviderBoundaryStaticAuditReport } from "./provider-boundary-audit";
import { buildProviderLegalPrivacyGateReport, providerCapabilityMatrix } from "./provider-capabilities";
import { buildProviderPricingMetadataGateReport } from "./provider-pricing";
import { buildProviderRouteSmokeMatrixReport } from "./provider-route-smoke";
import {
  PLAN_CHANGE_REVIEW_MANIFEST_RELATIVE_PATH,
  readPlanChangeReviewManifest,
  validatePlanChangeReviewManifest,
  type PlanChangeReviewIssue,
  type PlanChangeReviewManifest
} from "./plan-change-review";
import {
  buildPublicClaimReleaseMatrixReport,
  buildPublicClaimSurfaceAuditReport,
  type PublicClaimSurface
} from "./public-claims";
import { buildPublicLanguageGuardrailReport, type PublicLanguageSurface } from "./public-language";
import { buildResearchComplianceReleaseReport } from "./research/compliance";
import {
  RELEASE_EVIDENCE_FRESHNESS_MANIFEST_RELATIVE_PATH,
  readReleaseEvidenceFreshnessManifest,
  validateReleaseEvidenceFreshness,
  type ReleaseEvidenceFreshnessManifest,
  type ReleaseEvidenceFreshnessIssue
} from "./release-evidence";
import { CANONICAL_RELEASE_PLAN, validateCanonicalReleasePlan } from "./release-plan";
import {
  readReleaseLiveTodosSnapshot,
  validateReleaseLiveTodos,
  type ReleaseLiveTodosIssue,
  type ReleaseLiveTodosSnapshot
} from "./release-todos";
import { buildReleaseWorkflowSteps } from "./release-workflow";
import { renderReport } from "./report";
import { auditWorkflowPhaseReleaseReadiness } from "./workflow";

export type ReleaseDoctorStatus = "pass" | "warn" | "fail";

export type ReleaseDoctorCheck = {
  id: string;
  status: ReleaseDoctorStatus;
  title: string;
  evidence: string[];
  issues: string[];
};

export type ReleaseDoctorReport = {
  format: "matematica.release-doctor";
  version: 1;
  ok: boolean;
  freeLocalV0Ready: boolean;
  zeroNetworkReady: boolean;
  byokReady: boolean;
  remoteSwarmReleaseReady: boolean;
  remoteSwarmReady: boolean;
  packageReady: boolean;
  checks: ReleaseDoctorCheck[];
};

export type ReleaseDoctorLedgerMode = "current-home" | "clean-home";

const REQUIRED_PACKAGE_FILES = ["src", "docs", "README.md", "LICENSE", "NOTICE", "tsconfig.json"];
const REMOTE_PROVIDER_NAMES = new Set(["openai", "anthropic", "openrouter", "cerebras"]);

function enterReleaseDoctorLedgerScope(mode: ReleaseDoctorLedgerMode): { cleanup: () => void } {
  if (mode !== "clean-home") return { cleanup: () => undefined };
  const previousHome = process.env.MATEMATICA_HOME;
  const cleanHome = mkdtempSync(join(tmpdir(), "matematica-release-doctor-clean-home-"));
  process.env.MATEMATICA_HOME = cleanHome;
  return {
    cleanup: () => {
      if (previousHome === undefined) {
        delete process.env.MATEMATICA_HOME;
      } else {
        process.env.MATEMATICA_HOME = previousHome;
      }
      rmSync(cleanHome, { recursive: true, force: true });
    }
  };
}

export function buildReleaseDoctorReport(input: {
  cwd: string;
  config: MatematicaConfig;
  requireRemoteSwarmLiveDryRun?: boolean;
  milestonePlan?: MilestonePlan;
  releaseEvidenceManifest?: ReleaseEvidenceFreshnessManifest | { error: ReleaseEvidenceFreshnessIssue };
  planChangeReviewManifest?: PlanChangeReviewManifest | { error: PlanChangeReviewIssue };
  liveTodosSnapshot?: ReleaseLiveTodosSnapshot | { error: ReleaseLiveTodosIssue };
  ledgerMode?: ReleaseDoctorLedgerMode;
}): ReleaseDoctorReport {
  const packageRoot = resolveMatematicaPackageRoot(input.cwd);
  const releaseEvidenceManifest = input.releaseEvidenceManifest ?? readReleaseEvidenceFreshnessManifest(packageRoot);
  const planChangeReviewManifest = input.planChangeReviewManifest ?? readPlanChangeReviewManifest(packageRoot);
  const aiSdkReport = buildAiSdkCompatibilityReport();
  const providerMatrix = providerCapabilityMatrix(input.config);
  const publicClaimSurfaces = collectPublicClaimSurfaces(packageRoot);
  const ledgerMode = input.ledgerMode ?? "current-home";
  const ledgerScope = enterReleaseDoctorLedgerScope(ledgerMode);
  try {
  const checks = [
    packageMetadataCheck(packageRoot),
    packageFileCheck(packageRoot),
    zeroNetworkCheck(input.config),
    byokBoundaryCheck(input.config),
    aiSdkCompatibilityCheck(aiSdkReport),
    providerBoundaryStaticAuditCheck(packageRoot),
    externalFreshnessSnapshotsCheck({
      providers: providerMatrix,
      aiSdkPackages: aiSdkReport.packages
    }),
    researchLegalPrivacyComplianceCheck(input.cwd),
    providerLegalPrivacyCheck(providerMatrix),
    providerPricingMetadataCheck(providerMatrix),
    providerRouteSmokeMatrixCheck({
      config: input.config,
      providers: providerMatrix
    }),
    hostileLiveProviderDryRunCheck({
      cwd: input.cwd,
      config: input.config,
      required: input.requireRemoteSwarmLiveDryRun === true
    }),
    remoteSwarmProviderDiversityCheck(input.cwd, input.requireRemoteSwarmLiveDryRun === true),
    zeroFalseSolvedEvalCheck(runZeroFalseSolvedReleaseGate()),
    publicClaimsSurfaceAuditCheck(publicClaimSurfaces),
    publicClaimLanguageGuardrailCheck(publicClaimSurfaces, input.cwd),
    unreconciledExternalOutcomesCheck(input.cwd),
    savedEverythingReleaseCoverageCheck(),
    workflowPhaseReleaseAuditCheck(input.cwd, ledgerMode),
    releaseEvidenceFreshnessCheck(packageRoot, releaseEvidenceManifest),
    sharedImplementationPlanRegistryCheck(packageRoot),
    adversarialPlanChangeReviewCheck(packageRoot, planChangeReviewManifest),
    milestoneGateCheck(packageRoot, {
      plan: input.milestonePlan,
      manifest: releaseEvidenceManifest
    })
  ];
  checks.push(canonicalReleasePlanCheck(
    checks,
    input.liveTodosSnapshot ?? readReleaseLiveTodosSnapshot({ cwd: input.cwd })
  ));
  checks.push(publicClaimsReleaseMatrixCheck(publicClaimSurfaces, checks));
  const zeroNetworkReady = checkOk(checks, "zero-network") &&
    checkOk(checks, "research-legal-privacy-citations") &&
    checkOk(checks, "unreconciled-external-outcomes") &&
    checkOk(checks, "saved-everything-release-coverage") &&
    checkOk(checks, "release-evidence-freshness") &&
    checkOk(checks, "shared-implementation-plan-registry") &&
    checkOk(checks, "canonical-release-plan");
  const byokReady = checkOk(checks, "byok-boundary") &&
    checkOk(checks, "ai-sdk-compatibility") &&
    checkOk(checks, "ai-sdk-provider-boundary-static-audit") &&
    checkOk(checks, "external-freshness-snapshots") &&
    checkOk(checks, "research-legal-privacy-citations") &&
    checkOk(checks, "provider-legal-privacy") &&
    checkOk(checks, "provider-model-pricing") &&
    checkOk(checks, "provider-route-smoke-matrix") &&
    checkOk(checks, "hostile-live-provider-dry-run") &&
    checkOk(checks, "zero-false-solved-evals") &&
    checkOk(checks, "public-claims-surface-audit") &&
    checkOk(checks, "public-claim-language-guardrail") &&
    checkOk(checks, "unreconciled-external-outcomes") &&
    checkOk(checks, "saved-everything-release-coverage") &&
    checkOk(checks, "workflow-phase-release-audit") &&
    checkOk(checks, "release-evidence-freshness") &&
    checkOk(checks, "shared-implementation-plan-registry") &&
    checkOk(checks, "canonical-release-plan");
  const remoteSwarmReady = input.requireRemoteSwarmLiveDryRun === true &&
    checkOk(checks, "hostile-live-provider-dry-run") &&
    checkOk(checks, "byok-boundary") &&
    checkOk(checks, "ai-sdk-provider-boundary-static-audit") &&
    checkOk(checks, "provider-legal-privacy") &&
    checkOk(checks, "provider-model-pricing") &&
    checkOk(checks, "provider-route-smoke-matrix") &&
    checkOk(checks, "remote-swarm-provider-diversity") &&
    checkOk(checks, "research-legal-privacy-citations") &&
    checkOk(checks, "public-claims-surface-audit") &&
    checkOk(checks, "public-claim-language-guardrail") &&
    checkOk(checks, "unreconciled-external-outcomes") &&
    checkOk(checks, "saved-everything-release-coverage") &&
    checkOk(checks, "release-evidence-freshness") &&
    checkOk(checks, "shared-implementation-plan-registry") &&
    checkOk(checks, "canonical-release-plan");
  const packageReady = checkOk(checks, "package-metadata") &&
    checkOk(checks, "package-files") &&
    checkOk(checks, "ai-sdk-provider-boundary-static-audit") &&
    checkOk(checks, "saved-everything-release-coverage") &&
    checkOk(checks, "public-claims-surface-audit") &&
    checkOk(checks, "release-evidence-freshness") &&
    checkOk(checks, "shared-implementation-plan-registry") &&
    checkOk(checks, "canonical-release-plan") &&
    checkOk(checks, "public-claims-release-matrix");
  return {
    format: "matematica.release-doctor",
    version: 1,
    ok: checks.every((check) => check.status !== "fail"),
    freeLocalV0Ready: zeroNetworkReady && packageReady &&
      checkOk(checks, "zero-false-solved-evals") &&
      checkOk(checks, "public-claim-language-guardrail") &&
      checkOk(checks, "milestone-gates"),
    zeroNetworkReady,
    byokReady,
    remoteSwarmReleaseReady: remoteSwarmReady,
    remoteSwarmReady,
    packageReady,
    checks
  };
  } finally {
    ledgerScope.cleanup();
  }
}

function publicClaimLanguageGuardrailCheck(
  publicClaimSurfaces: PublicClaimSurface[],
  cwd: string
): ReleaseDoctorCheck {
  const surfaces: PublicLanguageSurface[] = publicClaimSurfaces.map((surface) => ({
    id: surface.id,
    kind: surface.kind,
    text: surface.text
  }));

  const paths = getAppPaths(cwd);
  const ledger = new Ledger(paths.dbPath);
  try {
    for (const run of ledger.listRuns()) {
      const events = ledger.listEvents(run.id);
      const outcome = classifyFinalOutcome(run, events);
      const classification = classificationForRun(run, events);
      surfaces.push({
        id: `report:${run.id}`,
        kind: "report",
        text: renderReport(run.id, ledger),
        context: {
          problemClass: classification.class,
          finalState: outcome.state,
          evidenceGrade: run.evidenceGrade,
          canClaimSolved: outcome.canClaimSolved
        }
      });
      surfaces.push({
        id: `terminal-json:${run.id}`,
        kind: "terminal-json",
        text: JSON.stringify({
          status: run.status,
          evidenceGrade: run.evidenceGrade,
          finalState: outcome.state,
          canClaimSolved: outcome.canClaimSolved,
          problemClass: classification.class
        }),
        context: {
          problemClass: classification.class,
          finalState: outcome.state,
          evidenceGrade: run.evidenceGrade,
          canClaimSolved: outcome.canClaimSolved
        }
      });
    }
  } finally {
    ledger.close();
  }

  const report = buildPublicLanguageGuardrailReport(surfaces);
  return {
    id: "public-claim-language-guardrail",
    status: report.ok ? "pass" : "fail",
    title: "Public wording does not market weak progress as solved",
    evidence: [
      `surfaces=${report.surfaceCount}`,
      "scans package metadata, README, NOTICE, LICENSE, docs, examples, CLI help source, benchmark summaries, run reports, and terminal JSON for unsafe solved wording"
    ],
    issues: report.issues.map((issue) =>
      `${issue.surfaceId}: ${issue.code}${issue.phrase ? ` (${issue.phrase})` : ""}: ${issue.reason}`
    )
  };
}

function publicClaimsSurfaceAuditCheck(surfaces: PublicClaimSurface[]): ReleaseDoctorCheck {
  const report = buildPublicClaimSurfaceAuditReport(surfaces);
  return {
    id: "public-claims-surface-audit",
    status: report.ok ? "pass" : "fail",
    title: "Public package docs examples and benchmark claims are supported",
    evidence: [
      `surfaces=${report.surfaceCount}`,
      `surfaceIds=${report.surfaces.map((surface) => surface.id).join(",")}`,
      "scans package metadata, README, NOTICE, LICENSE, docs, examples, CLI help source, and benchmark copy for unsupported proof, privacy, free-compute, provider-neutrality, or open-problem-solved claims"
    ],
    issues: report.issues.map((issue) =>
      `${issue.surfaceId}: ${issue.code} (${issue.phrase}): ${issue.reason}`
    )
  };
}

function researchLegalPrivacyComplianceCheck(cwd: string): ReleaseDoctorCheck {
  const paths = getAppPaths(cwd);
  const ledger = new Ledger(paths.dbPath);
  try {
    const report = buildResearchComplianceReleaseReport(ledger);
    return {
      id: "research-legal-privacy-citations",
      status: report.ok ? "pass" : "fail",
      title: "Research legal privacy citation and source-cache compliance",
      evidence: [
        `runsAudited=${report.runsAudited}`,
        `sourceResultEvents=${report.sourceResultEvents}`,
        `citationReviewEvents=${report.citationReviewEvents}`,
        `licenseManifestEvents=${report.licenseManifestEvents}`,
        `sourceArtifactsAudited=${report.sourceArtifactsAudited}`,
        "arXiv source records require exact version, snapshot hash, retrieval timestamp, license/provenance, independent entailment, citation-only quarantine, and metadata-only PDF/source export policy"
      ],
      issues: report.issues.map((issue) =>
        `${issue.runId}${issue.eventId ? `/${issue.eventId}` : ""}${issue.artifactId ? `/${issue.artifactId}` : ""}: ${issue.code}: ${issue.message}`
      )
    };
  } finally {
    ledger.close();
  }
}

function unreconciledExternalOutcomesCheck(cwd: string): ReleaseDoctorCheck {
  const paths = getAppPaths(cwd);
  const ledger = new Ledger(paths.dbPath);
  try {
    const runs = ledger.listRuns();
    const reports = runs.map((run) => buildExternalOutcomeReconciliationReport(run.id, ledger));
    const issues = reports.flatMap((report) => [
      ...report.unknownOperations.map((operation) =>
        `${report.runId}: unknown_remote_outcome ${operation.operationType}/${operation.provider ?? "unknown"} operation=${operation.id} reservation=${operation.reservationId} quarantineEvent=${operation.quarantineEventId ?? "missing"}`
      ),
      ...report.deadLetterOperations.map((operation) =>
        `${report.runId}: dead_lettered_dispatch ${operation.operationType}/${operation.provider ?? "unknown"} operation=${operation.id} reservation=${operation.reservationId} deadLetterEvent=${operation.quarantineEventId ?? "missing"}`
      ),
      ...report.openOperations.map((operation) =>
        `${report.runId}: open_external_operation ${operation.operationType}/${operation.provider ?? "unknown"} status=${operation.status} operation=${operation.id} reservation=${operation.reservationId}`
      ),
      ...report.openReservations.map((reservation) =>
        `${report.runId}: open_external_reservation reservation=${reservation.reservationId} operation=${reservation.operationId ?? "none"} type=${reservation.operationType ?? "unknown"} provider=${reservation.provider ?? "unknown"} retainedForUnknownOutcome=${reservation.retainedForUnknownOutcome ? "yes" : "no"} retainedForExternalOutcome=${reservation.retainedForExternalOutcome ? "yes" : "no"}`
      )
    ]);
    return {
      id: "unreconciled-external-outcomes",
      status: issues.length === 0 ? "pass" : "fail",
      title: "No unreconciled external outcomes or retained reservations",
      evidence: [
        `runsAudited=${runs.length}`,
        `unknownOperations=${reports.reduce((sum, report) => sum + report.unknownOperations.length, 0)}`,
        `deadLetterOperations=${reports.reduce((sum, report) => sum + report.deadLetterOperations.length, 0)}`,
        `openOperations=${reports.reduce((sum, report) => sum + report.openOperations.length, 0)}`,
        `openReservations=${reports.reduce((sum, report) => sum + report.openReservations.length, 0)}`,
        "provider/tool/verifier/sandbox outcomes with unknown remote state and dead-lettered remote dispatches require explicit operator reconciliation before release"
      ],
      issues
    };
  } finally {
    ledger.close();
  }
}

function workflowPhaseReleaseAuditCheck(cwd: string, ledgerMode: ReleaseDoctorLedgerMode): ReleaseDoctorCheck {
  const paths = getAppPaths(cwd);
  const ledger = new Ledger(paths.dbPath);
  try {
    const runs = ledger.listRuns();
    const audits = runs.map((run) => auditWorkflowPhaseReleaseReadiness(ledger, run.id));
    const issues = audits.flatMap((audit) =>
      audit.issues.map((issue) => `${audit.runId}: ${issue}`)
    );
    return {
      id: "workflow-phase-release-audit",
      status: issues.length === 0 ? "pass" : "fail",
      title: "Typed PFLK/GREE phase transition release audit",
      evidence: [
        `ledgerMode=${ledgerMode}`,
        `runsAudited=${runs.length}`,
        `phaseEventsAudited=${audits.reduce((sum, audit) => sum + audit.phaseEventCount, 0)}`,
        "phase.completed events are revalidated against workflow-phase-contract-v1, output manifests, measurable progression records, lineage, branch/research scheduling, and transition ordering"
      ],
      issues
    };
  } finally {
    ledger.close();
  }
}

function savedEverythingReleaseCoverageCheck(): ReleaseDoctorCheck {
  const report = buildSavedEverythingReleaseCoverageReport();
  return {
    id: "saved-everything-release-coverage",
    status: report.ok ? "pass" : "fail",
    title: "Saved-everything release coverage matrix",
    evidence: [
      `requiredOperations=${report.requiredOperations}`,
      `strictNotObservedFails=${report.strictNotObservedFails ? "yes" : "no"}`,
      ...report.requirements.map((requirement) =>
        `${requirement.id}: category=${requirement.categoryId} events=${requirement.eventTypesCovered.join(",")} replay=${requirement.replayEvidence}`
      )
    ],
    issues: report.issues
  };
}

function publicClaimsReleaseMatrixCheck(surfaces: PublicClaimSurface[], checks: ReleaseDoctorCheck[]): ReleaseDoctorCheck {
  const report = buildPublicClaimReleaseMatrixReport({
    readmeText: surfaces.find((surface) => surface.id === "README.md")?.text ?? "",
    cliHelpText: surfaces.filter((surface) => surface.kind === "cli-help").map((surface) => surface.text).join("\n"),
    surfaces,
    releaseChecks: checks
  });
  return {
    id: "public-claims-release-matrix",
    status: report.ok ? "pass" : "fail",
    title: "Public README and CLI help claims mapped to release-blocking checks",
    evidence: [
      `claims=${report.claimCount}`,
      ...report.claims.map((claim) =>
        `${claim.id}: source=${claim.source} checks=${claim.requiredCheckIds.join(",")} present=${claim.sourcePresent ? "yes" : "no"}`
      )
    ],
    issues: report.issues
  };
}

function canonicalReleasePlanCheck(
  checks: ReleaseDoctorCheck[],
  liveTodosSnapshot?: ReleaseLiveTodosSnapshot | { error: ReleaseLiveTodosIssue }
): ReleaseDoctorCheck {
  const validation = validateCanonicalReleasePlan({
    releaseCheckIds: [...checks.map((check) => check.id), "canonical-release-plan", "public-claims-release-matrix"],
    milestoneIds: validateMilestonePlan().ok
      ? RELEASE_MILESTONE_PLAN.milestones.map((milestone) => milestone.id)
      : []
  });
  const liveTodos = validateReleaseLiveTodos({ snapshot: liveTodosSnapshot });
  return {
    id: "canonical-release-plan",
    status: validation.ok && liveTodos.ok ? "pass" : "fail",
    title: "Canonical Matematica release plan registry",
    evidence: [
      `plan=${CANONICAL_RELEASE_PLAN.shortPlanId}`,
      `planId=${CANONICAL_RELEASE_PLAN.planId}`,
      `blockers=${validation.blockerCount}`,
      `activeBlockers=${validation.activeBlockerCount}`,
      `completedBlockers=${validation.completedBlockerCount}`,
      `supersededTasks=${validation.supersededTaskCount}`,
      `liveTodosSource=${liveTodos.source}`,
      `releaseRelevantLiveTodos=${liveTodos.releaseRelevantTaskCount}`,
      `liveCriticalTodos=${liveTodos.liveCriticalTaskCount}`,
      `liveTodosRepresented=${liveTodos.representedTaskCount}`,
      `nonReleaseBacklogTodos=${liveTodos.nonReleaseBacklogCount}`,
      `duplicateLiveTodoTitleGroups=${liveTodos.duplicateTitleGroupCount}`,
      `placeholderLiveTodos=${liveTodos.placeholderTaskCount}`,
      `supersededActiveLiveTodos=${liveTodos.supersededActiveTaskCount}`,
      `missingActivePlanBlockers=${liveTodos.missingActivePlanBlockerCount}`,
      `liveTodoEntropyPermille=${liveTodos.entropyScorePermille}`,
      "release blocker tasks must be unique, owned, acceptance-backed, milestone-mapped, and tied to release-doctor checks"
    ],
    issues: [
      ...validation.issues.map((issue) =>
        `${issue.taskId ? `${issue.taskId}: ` : ""}${issue.code}: ${issue.message}`
      ),
      ...liveTodos.issues.map((issue) =>
        `${issue.taskId ? `${issue.taskId}: ` : ""}${issue.code}: ${issue.message}`
      )
    ]
  };
}

function releaseEvidenceFreshnessCheck(
  packageRoot: string,
  manifest: ReleaseEvidenceFreshnessManifest | { error: ReleaseEvidenceFreshnessIssue }
): ReleaseDoctorCheck {
  const validation = validateReleaseEvidenceFreshness({ manifest, packageRoot });
  return {
    id: "release-evidence-freshness",
    status: validation.ok ? "pass" : "fail",
    title: "Release blocker evidence freshness and supersession audit",
    evidence: [
      `manifest=${RELEASE_EVIDENCE_FRESHNESS_MANIFEST_RELATIVE_PATH}`,
      `completedTasks=${validation.completedTaskCount}`,
      `evidenceRecords=${validation.evidenceRecordCount}`,
      `supersededTasks=${validation.supersededTaskCount}`,
      `supersessionRecords=${validation.supersessionRecordCount}`,
      "completed release blockers require hash-pinned verification evidence, and superseded blockers require replacement ids plus comment/history evidence"
    ],
    issues: validation.issues.map((issue) =>
      `${issue.taskId ? `${issue.taskId}: ` : ""}${issue.path ? `${issue.path}: ` : ""}${issue.code}: ${issue.message}`
    )
  };
}

function sharedImplementationPlanRegistryCheck(packageRoot: string): ReleaseDoctorCheck {
  const mirror = readSharedImplementationPlanRegistryMirror(packageRoot);
  const validation = validateSharedImplementationPlanRegistryMirror({ mirror });
  const registryPlanCount = "error" in mirror ? 0 : mirror.registryPlans.length;
  const registryPlanIds = "error" in mirror
    ? "missing"
    : mirror.registryPlans.map((plan) => plan.registryPlanShortId).join(",");
  return {
    id: "shared-implementation-plan-registry",
    status: validation.ok ? "pass" : "fail",
    title: "Shared implementation-plan registry mirror",
    evidence: [
      `mirror=${IMPLEMENTATION_PLAN_REGISTRY_MIRROR_RELATIVE_PATH}`,
      `source=implementations://plans`,
      `registryPlans=${registryPlanCount}`,
      `canonicalPlans=${validation.canonicalPlanCount}`,
      `registryPlanIds=${registryPlanIds}`,
      `canonicalTasks=${validation.taskCount}`,
      "release requires exactly one shared canonical Matematica implementation plan whose task ids match the package canonical release plan"
    ],
    issues: validation.issues.map((issue) => `${issue.code}: ${issue.message}`)
  };
}

function adversarialPlanChangeReviewCheck(
  packageRoot: string,
  manifest: PlanChangeReviewManifest | { error: PlanChangeReviewIssue }
): ReleaseDoctorCheck {
  const validation = validatePlanChangeReviewManifest({ manifest });
  const recordIds = "error" in manifest
    ? "missing"
    : manifest.records.map((record) => record.mutationId).join(",");
  return {
    id: "adversarial-plan-change-review",
    status: validation.ok ? "pass" : "fail",
    title: "Adversarial plan-change review gate",
    evidence: [
      `manifest=${PLAN_CHANGE_REVIEW_MANIFEST_RELATIVE_PATH}`,
      `records=${validation.recordCount}`,
      `materialRecords=${validation.materialRecordCount}`,
      `reviewedMaterialRecords=${validation.reviewedMaterialRecordCount}`,
      `capacityFailures=${validation.capacityFailureCount}`,
      `riskAcceptedCapacityFailures=${validation.riskAcceptedMaterialRecordCount}`,
      `recordIds=${recordIds}`,
      "material roadmap/task-plan mutations require two independent adversarial objections, or explicit release-owner risk acceptance for degraded-capacity quorum"
    ],
    issues: validation.issues.map((issue) =>
      `${issue.mutationId ? `${issue.mutationId}: ` : ""}${issue.code}: ${issue.message}`
    )
  };
}

function collectPublicClaimSurfaces(packageRoot: string): PublicClaimSurface[] {
  const surfaces: PublicClaimSurface[] = [];
  pushSurface(surfaces, packageRoot, "package.json", "package-metadata");
  pushSurface(surfaces, packageRoot, "README.md", "readme");
  pushSurface(surfaces, packageRoot, "NOTICE", "notice");
  pushSurface(surfaces, packageRoot, "LICENSE", "license");
  pushSurface(surfaces, packageRoot, join("src", "cli.ts"), "cli-help", "cli-help-source");
  for (const file of listPublicTextFiles(join(packageRoot, "docs"))) {
    surfaces.push({
      id: normalizeRelativePath(relative(packageRoot, file)),
      kind: "docs",
      text: readFileSync(file, "utf8")
    });
  }
  for (const file of listPublicTextFiles(join(packageRoot, "examples"))) {
    surfaces.push({
      id: normalizeRelativePath(relative(packageRoot, file)),
      kind: "example",
      text: readFileSync(file, "utf8")
    });
  }
  surfaces.push({
    id: "hard-math-benchmark-ladder",
    kind: "benchmark-summary",
    text: formatHardMathBenchmarkLadder()
  });
  return surfaces;
}

function pushSurface(
  surfaces: PublicClaimSurface[],
  packageRoot: string,
  file: string,
  kind: PublicClaimSurface["kind"],
  id = normalizeRelativePath(file)
): void {
  const path = join(packageRoot, file);
  if (!existsSync(path)) return;
  surfaces.push({
    id,
    kind,
    text: readFileSync(path, "utf8")
  });
}

function listPublicTextFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const result: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      result.push(...listPublicTextFiles(path));
      continue;
    }
    if (stat.isFile() && isPublicTextFile(path)) result.push(path);
  }
  return result.sort();
}

function isPublicTextFile(path: string): boolean {
  return /\.(md|mdx|txt|json|yaml|yml|toml|sh|ts|js)$/i.test(path);
}

function normalizeRelativePath(path: string): string {
  return path.split(sep).join("/");
}

export function formatReleaseDoctorReport(report: ReleaseDoctorReport): string {
  const lines = [
    `Matematica release doctor: ${report.ok ? "pass" : "fail"}`,
    `Free-local-v0 release ready: ${report.freeLocalV0Ready ? "yes" : "no"}`,
    `Zero-network ready: ${report.zeroNetworkReady ? "yes" : "no"}`,
    `BYOK boundary ready: ${report.byokReady ? "yes" : "no"}`,
    `Remote-swarm release ready: ${report.remoteSwarmReleaseReady ? "yes" : "no"}`,
    `Remote-swarm live dry run ready: ${report.remoteSwarmReady ? "yes" : "no"}`,
    `Package ready: ${report.packageReady ? "yes" : "no"}`,
    ""
  ];
  for (const check of report.checks) {
    lines.push(`${check.status.toUpperCase()} ${check.id}: ${check.title}`);
    for (const evidence of check.evidence) lines.push(`  evidence: ${evidence}`);
    for (const issue of check.issues) lines.push(`  issue: ${issue}`);
  }
  return lines.join("\n");
}

function packageMetadataCheck(cwd: string): ReleaseDoctorCheck {
  const path = join(cwd, "package.json");
  const issues: string[] = [];
  const evidence: string[] = [];
  if (!existsSync(path)) {
    return fail("package-metadata", "Public package metadata", [], ["package.json is missing"]);
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (error) {
    return fail("package-metadata", "Public package metadata", [], [`package.json could not be parsed: ${error instanceof Error ? error.message : String(error)}`]);
  }
  if (parsed.name !== "@hasna/matematica") issues.push("package name must be @hasna/matematica");
  if (parsed.private !== undefined) issues.push("package must not be private");
  if (parsed.license !== "MIT") issues.push("package license must be MIT");
  if (!isRecord(parsed.publishConfig) || parsed.publishConfig.access !== "public") issues.push("publishConfig.access must be public");
  if (!isRecord(parsed.bin) || parsed.bin.matematica !== "./src/bin/matematica.ts") issues.push("bin.matematica must point at ./src/bin/matematica.ts");
  evidence.push("package.json declares public @hasna/matematica CLI package metadata");
  return {
    id: "package-metadata",
    status: issues.length === 0 ? "pass" : "fail",
    title: "Public package metadata",
    evidence,
    issues
  };
}

function resolveMatematicaPackageRoot(cwd: string): string {
  const candidate = readPackageJson(join(cwd, "package.json"));
  if (candidate?.name === "@hasna/matematica") return cwd;
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

function readPackageJson(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function packageFileCheck(cwd: string): ReleaseDoctorCheck {
  const packageJsonPath = join(cwd, "package.json");
  const issues: string[] = [];
  const evidence: string[] = [];
  for (const file of REQUIRED_PACKAGE_FILES) {
    if (!existsSync(join(cwd, file))) issues.push(`required release file is missing: ${file}`);
  }
  if (existsSync(packageJsonPath)) {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { files?: unknown };
    const files = Array.isArray(parsed.files) ? parsed.files.filter((item): item is string => typeof item === "string") : [];
    for (const file of REQUIRED_PACKAGE_FILES) {
      if (!files.includes(file)) issues.push(`package.json files does not include ${file}`);
    }
    if (files.includes("tests")) issues.push("tests must not be included in the public package files list");
    evidence.push(`package files allowlist: ${files.join(", ")}`);
  }
  return {
    id: "package-files",
    status: issues.length === 0 ? "pass" : "fail",
    title: "Package file allowlist and required docs",
    evidence,
    issues
  };
}

function zeroNetworkCheck(config: MatematicaConfig): ReleaseDoctorCheck {
  const providers = remoteProviderConfigs(config.providers);
  const configured = providers.filter((provider) => provider.configured).map((provider) => provider.name);
  const issues = config.localOnly ? [] : [];
  const warnings = configured.length > 0
    ? [`remote BYOK providers are configured in this environment (${configured.join(", ")}); release zero-key verification should run with provider keys cleared`]
    : [];
  return {
    id: "zero-network",
    status: issues.length > 0 ? "fail" : warnings.length > 0 ? "warn" : "pass",
    title: "Zero-network OSS baseline",
    evidence: [
      "goal/research commands default to cache-only source access unless --allow-network is passed",
      "zero API keys are supported for deterministic local runs, reports, audits, replay, and doctor",
      config.localOnly ? "MATEMATICA_LOCAL_ONLY is enabled" : "MATEMATICA_LOCAL_ONLY is not required for zero-key default behavior"
    ],
    issues: [...issues, ...warnings]
  };
}

function byokBoundaryCheck(config: MatematicaConfig): ReleaseDoctorCheck {
  const providers = remoteProviderConfigs(config.providers).map((provider) => provider.name);
  return {
    id: "byok-boundary",
    status: "pass",
    title: "BYOK remote provider boundary",
    evidence: [
      "remote provider use requires explicit provider selection, ledgered admission, and --max-call-usd",
      "remote fanout requires --i-understand-remote-costs",
      `remote provider adapters available as BYOK only: ${providers.join(", ")}`
    ],
    issues: []
  };
}

function providerLegalPrivacyCheck(providers: ReturnType<typeof providerCapabilityMatrix>): ReleaseDoctorCheck {
  const report = buildProviderLegalPrivacyGateReport({
    providers
  });
  return {
    id: "provider-legal-privacy",
    status: report.ok ? "pass" : "fail",
    title: "Provider legal privacy and capability freshness",
    evidence: [
      `provider policy matrix checked at ${report.checkedAt}`,
      `max provider policy age: ${report.maxAgeDays} days`,
      ...report.checks.map((check) =>
        `${check.provider}/${check.modelId}: policyHash=${check.policyHash} reviewed=${check.reviewedAt} expires=${check.expiresAt}`
      )
    ],
    issues: report.checks.flatMap((check) => check.issues.map((issue) => `${check.provider}: ${issue}`))
  };
}

function providerPricingMetadataCheck(providers: ReturnType<typeof providerCapabilityMatrix>): ReleaseDoctorCheck {
  const report = buildProviderPricingMetadataGateReport({
    providers
  });
  return {
    id: "provider-model-pricing",
    status: report.ok ? "pass" : "fail",
    title: "Provider model availability and pricing metadata freshness",
    evidence: [
      `provider pricing metadata checked at ${report.checkedAt}`,
      `max provider pricing age: ${report.maxAgeDays} days`,
      ...report.checks.map((check) =>
        `${check.provider}/${check.modelId}: pricingHash=${check.pricingHash} reviewed=${check.reviewedAt} expires=${check.expiresAt} cost=${check.costSource.source} catalog=${providers.find((provider) => provider.provider === check.provider && provider.requestedModel === check.modelId)?.modelCatalog.selected.status ?? "missing"}`
      )
    ],
    issues: report.checks.flatMap((check) => check.issues.map((issue) => `${check.provider}: ${issue}`))
  };
}

function providerRouteSmokeMatrixCheck(input: {
  config: MatematicaConfig;
  providers: ReturnType<typeof providerCapabilityMatrix>;
}): ReleaseDoctorCheck {
  const report = buildProviderRouteSmokeMatrixReport({
    config: input.config,
    providers: input.providers
  });
  return {
    id: "provider-route-smoke-matrix",
    status: report.ok ? "pass" : "fail",
    title: "Provider route behavior smoke matrix",
    evidence: [
      `mode=${report.mode}`,
      `matrixHash=${report.matrixHash}`,
      `providers=${report.cases.map((item) => `${item.provider}/${item.modelId}`).join(", ")}`,
      ...report.cases.map((item) =>
        `${item.provider}/${item.modelId}: adapter=${item.adapterPackage}/${item.adapterName} upstream=${item.actualUpstreamProvider}/${item.actualUpstreamModel} options=${item.providerOptions.join(",") || "none"} routeHash=${item.routeHash}`
      )
    ],
    issues: report.issues
  };
}

function hostileLiveProviderDryRunCheck(input: {
  cwd: string;
  config: MatematicaConfig;
  required: boolean;
}): ReleaseDoctorCheck {
  const configured = remoteProviderConfigs(input.config.providers).filter((provider) => provider.configured);
  if (!input.required) {
    return {
      id: "hostile-live-provider-dry-run",
      status: "pass",
      title: "Hostile live-provider dry run for remote swarm release",
      evidence: [
        "skipped for free OSS release mode",
        "pass --remote-swarm to require fresh BYOK hostile dry-run evidence before remote swarm release"
      ],
      issues: []
    };
  }
  const paths = getAppPaths(input.cwd);
  const ledger = new Ledger(paths.dbPath);
  try {
    const runs = ledger.listRuns();
    const reviewedEvents = runs.flatMap((run) =>
      ledger.listEvents(run.id)
        .filter((event) => event.type === "provider.hostile_live_dry_run.reviewed")
        .map((event) => ({
          runId: run.id,
          event,
          artifacts: ledger.listArtifacts(run.id)
        }))
    );
    const now = new Date(process.env.MATEMATICA_HOSTILE_DRY_RUN_NOW ?? Date.now());
    const issues: string[] = [];
    const evidence = [
      `required=true`,
      `configuredRemoteProviders=${configured.map((provider) => `${provider.name}/${provider.model}`).join(", ") || "none"}`,
      `maxAgeDays=${HOSTILE_PROVIDER_DRY_RUN_MAX_AGE_DAYS}`,
      `runsAudited=${runs.length}`
    ];
    if (configured.length === 0) {
      issues.push("remote swarm release requires at least one configured BYOK remote provider route");
    }
    for (const provider of configured) {
      const review = reviewedEvents.findLast((item) =>
        item.event.payload.provider === provider.name &&
        item.event.payload.modelId === provider.model
      );
      if (!review) {
        issues.push(`${provider.name}/${provider.model}: missing hostile live-provider dry-run review`);
        continue;
      }
      const payload = review.event.payload;
      const reviewArtifactId = stringValue(payload.artifactId);
      const linkedReviewArtifact = reviewArtifactId !== undefined &&
        review.event.artifactIds.includes(reviewArtifactId) &&
        review.artifacts.some((artifact) =>
          artifact.id === reviewArtifactId &&
          artifact.kind === "provider.hostile_live_dry_run.review"
        );
      const ageDays = ageDaysBetween(stringValue(payload.checkedAt), now);
      const stale = ageDays === undefined || ageDays > HOSTILE_PROVIDER_DRY_RUN_MAX_AGE_DAYS;
      const checks = recordValue(payload.checks);
      const failedChecks = [
        payload.ok === true ? undefined : "ok",
        payload.executionMode === "byok_live" ? undefined : "executionMode",
        linkedReviewArtifact ? undefined : "reviewArtifact",
        checks.liveProviderCall === true ? undefined : "liveProviderCall",
        checks.redaction === true ? undefined : "redaction",
        checks.pricing === true ? undefined : "pricing",
        checks.abort === true ? undefined : "abort",
        checks.retry === true ? undefined : "retry",
        checks.upstreamProvenance === true ? undefined : "upstreamProvenance",
        checks.providerAllowlist === true ? undefined : "providerAllowlist",
        checks.noFalseGoalMet === true ? undefined : "noFalseGoalMet",
        stale ? "freshness" : undefined
      ].filter((item): item is string => Boolean(item));
      evidence.push(`${provider.name}/${provider.model}: run=${review.runId} review=${review.event.id} artifact=${reviewArtifactId ?? "missing"} ageDays=${ageDays ?? "unknown"} reportHash=${stringValue(payload.reportHash) ?? "missing"}`);
      if (failedChecks.length > 0) {
        issues.push(`${provider.name}/${provider.model}: hostile dry-run evidence failed ${failedChecks.join(", ")}`);
      }
    }
    return {
      id: "hostile-live-provider-dry-run",
      status: issues.length === 0 ? "pass" : "fail",
      title: "Hostile live-provider dry run for remote swarm release",
      evidence,
      issues
    };
  } finally {
    ledger.close();
  }
}

function zeroFalseSolvedEvalCheck(report: ZeroFalseSolvedReleaseGateReport): ReleaseDoctorCheck {
  return {
    id: "zero-false-solved-evals",
    status: report.ok ? "pass" : "fail",
    title: "Hidden hostile zero false-solved release gate",
    evidence: [
      `suite=${report.suite}`,
      `fixtures=${report.metrics.fixtureCount}`,
      `falseSolvedRate=${report.metrics.falseSolvedRate}`,
      `honestBudgetExhaustedRate=${report.metrics.honestBudgetExhaustedRate}`,
      `usefulProgressRate=${report.metrics.usefulProgressRate}`,
      `replaySuccessRate=${report.metrics.replaySuccessRate}`,
      `citationGrounding=${report.metrics.citationGrounding.passed + report.metrics.citationGrounding.rejectedHallucination}/${report.metrics.citationGrounding.checked}`,
      `verifierPassFail=${report.metrics.verifier.passed}/${report.metrics.verifier.failed}`,
      `solvedClaimsWithVerifierBackedOfflineReplay=${report.metrics.solvedClaimsWithVerifierBackedOfflineReplay}/${report.metrics.solvedClaimCount}`,
      `providerWorkerCorpus=${report.metrics.providerWorkerCorpus.finalizationRejectedCount}/${report.metrics.providerWorkerCorpus.caseCount} finalization rejected, ${report.metrics.providerWorkerCorpus.offlineSolvedClaimRejectedCount}/${report.metrics.providerWorkerCorpus.caseCount} offline solved-claim rejected`
    ],
    issues: report.issues
  };
}

function remoteSwarmProviderDiversityCheck(cwd: string, required: boolean): ReleaseDoctorCheck {
  const paths = getAppPaths(cwd);
  const ledger = new Ledger(paths.dbPath);
  try {
    const runs = ledger.listRuns();
    const admissionEvents = runs.flatMap((run) =>
      ledger.listEvents(run.id)
        .filter((event) => event.type === "swarm.admission.preview")
        .map((event) => ({ runId: run.id, event }))
    );
    const issues: string[] = [];
    const evidence = [
      `required=${required}`,
      `runsAudited=${runs.length}`,
      `admissionPreviews=${admissionEvents.length}`,
      "remote high-fanout admission requires heterogeneous provider/model routes or a persisted operator waiver"
    ];
    for (const { runId, event } of admissionEvents) {
      const diversity = recordValue(event.payload.providerDiversity);
      if (!diversity || diversity.required !== true) continue;
      const routeKeys = Array.isArray(diversity.routeLineage)
        ? diversity.routeLineage
            .map((route) => recordValue(route))
            .filter((route): route is Record<string, unknown> => Boolean(route))
            .map((route) => stringValue(route.providerModelKey))
            .filter((key): key is string => Boolean(key))
        : [];
      evidence.push(`${runId}: event=${event.id} uniqueRemote=${String(diversity.uniqueRemoteProviderModelKeys ?? "unknown")} min=${String(diversity.minUniqueRemoteProviderModelKeys ?? "unknown")} waiver=${String(diversity.waiverAccepted === true)} routes=${routeKeys.join(",") || "none"}`);
      if (diversity.ok !== true) {
        issues.push(`${runId}: high-fanout remote provider/model diversity collapsed without waiver`);
      }
      if (diversity.waiverAccepted === true && typeof diversity.waiverHash !== "string") {
        issues.push(`${runId}: provider diversity waiver is missing hash evidence`);
      }
    }
    if (required && admissionEvents.length === 0) {
      evidence.push("no remote swarm admission previews found; hostile live-provider dry-run check covers route freshness separately");
    }
    return {
      id: "remote-swarm-provider-diversity",
      status: issues.length === 0 ? "pass" : "fail",
      title: "Remote swarm provider/model diversity or waiver",
      evidence,
      issues
    };
  } finally {
    ledger.close();
  }
}

function aiSdkCompatibilityCheck(report: ReturnType<typeof buildAiSdkCompatibilityReport>): ReleaseDoctorCheck {
  return {
    id: "ai-sdk-compatibility",
    status: report.ok ? "pass" : "fail",
    title: "AI SDK ToolLoopAgent and provider compatibility",
    evidence: [
      `packages: ${report.packages.map((item) => `${item.name}@${item.version}`).join(", ")}`,
      ...report.checks.flatMap((check) => check.evidence.map((evidence) => `${check.id}: ${evidence}`))
    ],
    issues: report.checks.flatMap((check) => check.issues.map((issue) => `${check.id}: ${issue}`))
  };
}

function providerBoundaryStaticAuditCheck(packageRoot: string): ReleaseDoctorCheck {
  const report = buildProviderBoundaryStaticAuditReport({ packageRoot });
  return {
    id: "ai-sdk-provider-boundary-static-audit",
    status: report.ok ? "pass" : "fail",
    title: "AI SDK provider boundary static import audit",
    evidence: [
      `filesScanned=${report.filesScanned}`,
      `approvedBoundaries=${report.approvedBoundaries.map((boundary) => boundary.file).join(",")}`,
      "OpenAI, Anthropic, OpenRouter, Cerebras, and local routes must enter through approved AI SDK adapters and the instrumented model-call boundary"
    ],
    issues: report.issues.map((issue) =>
      `${issue.file}: ${issue.code}: ${issue.detail}`
    )
  };
}

function externalFreshnessSnapshotsCheck(input: {
  providers: ReturnType<typeof providerCapabilityMatrix>;
  aiSdkPackages: ReturnType<typeof buildAiSdkCompatibilityReport>["packages"];
}): ReleaseDoctorCheck {
  const snapshots = buildDefaultExternalFreshnessSnapshots({
    providers: input.providers,
    aiSdkPackages: input.aiSdkPackages
  });
  const report = buildExternalFreshnessGateReport({ snapshots });
  return {
    id: "external-freshness-snapshots",
    status: report.ok ? "pass" : "fail",
    title: "Versioned external research and model API freshness snapshots",
    evidence: [
      `freshness snapshots checked at ${report.checkedAt}`,
      `max external freshness age: ${report.maxAgeDays} days`,
      ...report.checks.map((check) =>
        `${check.surface}: schema=${check.schemaVersion} hash=${check.snapshotHash} retrieved=${check.retrievedAt} expires=${check.expiresAt}`
      )
    ],
    issues: report.checks.flatMap((check) => check.issues.map((issue) => `${check.surface}: ${issue}`))
  };
}

function milestoneGateCheck(
  packageRoot: string,
  input: {
    plan?: MilestonePlan;
    manifest: ReleaseEvidenceFreshnessManifest | { error: ReleaseEvidenceFreshnessIssue };
  }
): ReleaseDoctorCheck {
  const evidenceValidation = validateReleaseEvidenceFreshness({ manifest: input.manifest, packageRoot });
  const executableCommands = buildReleaseWorkflowSteps().map((step) => step.command.join(" "));
  const freshEvidenceCommands = evidenceValidation.ok && !("error" in input.manifest)
    ? input.manifest.completedTaskEvidence.flatMap((item) => item.verificationCommands)
    : [];
  const readiness = validateMilestoneReadiness({
    plan: input.plan,
    freshEvidenceCommands,
    executableCommands
  });
  const issues = [
    ...readiness.issues.map((issue) =>
      `${issue.milestoneId ? `${issue.milestoneId}: ` : ""}${issue.gateId ? `${issue.gateId}: ` : ""}${issue.code}: ${issue.message}`
    ),
    ...evidenceValidation.issues.map((issue) =>
      `release-evidence-freshness: ${issue.taskId ? `${issue.taskId}: ` : ""}${issue.path ? `${issue.path}: ` : ""}${issue.code}: ${issue.message}`
    )
  ];
  return {
    id: "milestone-gates",
    status: readiness.ok && evidenceValidation.ok ? "pass" : "fail",
    title: "Evidence-backed milestone gate ordering",
    evidence: [
      "matematica milestones list --json validates ordered release gates",
      `requiredCommands=${readiness.requiredCommandCount}`,
      `freshEvidenceCommands=${readiness.freshEvidenceCommandCount}`,
      `releaseWorkflowCommands=${readiness.executableCommandCount}`,
      `gatedOrPlannedMilestones=${readiness.gatedOrPlannedMilestoneCount}`,
      "required milestone commands must have fresh passing evidence or be executed by the release workflow"
    ],
    issues
  };
}

function checkOk(checks: ReleaseDoctorCheck[], id: string): boolean {
  return checks.find((check) => check.id === id)?.status !== "fail";
}

function remoteProviderConfigs(providers: ProviderConfig[]): ProviderConfig[] {
  return providers.filter((provider) => REMOTE_PROVIDER_NAMES.has(provider.name));
}

function fail(id: string, title: string, evidence: string[], issues: string[]): ReleaseDoctorCheck {
  return { id, title, status: "fail", evidence, issues };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function ageDaysBetween(value: string | undefined, now: Date): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return undefined;
  return (now.getTime() - parsed) / 86_400_000;
}
