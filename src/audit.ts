import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { computeLedgerEventHash, type Ledger, type LedgerMaintenanceSnapshot } from "./ledger";
import { stableHash } from "./idempotency";
import { readArtifactBytes, readArtifactText } from "./storage-encryption";
import { auditWorkflowPhaseReleaseReadiness } from "./workflow";

export type AuditIssue = {
  severity: "error" | "warning";
  code: string;
  message: string;
};

export type AuditResult = {
  ok: boolean;
  runId: string;
  schemaVersion: number;
  migrations: string[];
  maintenance: LedgerMaintenanceSnapshot;
  events: number;
  artifacts: number;
  externalOperations: Array<{
    id: string;
    operationType: string;
    provider?: string;
    idempotencyKey: string;
    requestHash: string;
    status: string;
    retryOfOperationId?: string;
  }>;
  retryLineage: Array<{
    parentOperationId: string;
    retryAttemptOperationId: string;
    failedAttempt: number;
    nextAttempt: number;
    retryReservationId?: string;
  }>;
  issues: AuditIssue[];
};

export type SavedEverythingCategoryStatus = "passed" | "failed" | "not_observed";

export type SavedEverythingCategory = {
  id:
    | "ai_actions"
    | "tool_calls"
    | "search_research"
    | "branch_decisions"
    | "experiments"
    | "verifiers"
    | "budgets"
    | "providers"
    | "plan_mutations";
  label: string;
  status: SavedEverythingCategoryStatus;
  observedEvents: number;
  artifactBackedEvents: number;
  eventRefs: Array<{
    eventId: string;
    type: string;
    artifactIds: string[];
  }>;
  issues: AuditIssue[];
};

export type SavedEverythingAudit = {
  format: "matematica.saved-everything-audit";
  version: 1;
  ok: boolean;
  runId: string;
  baseAuditOk: boolean;
  events: number;
  artifacts: number;
  externalOperations: number;
  workerJobs: number;
  categories: SavedEverythingCategory[];
  issues: AuditIssue[];
};

export type SavedEverythingReleaseCoverageRequirement = {
  id:
    | "ai_call"
    | "tool_call"
    | "source_retrieval"
    | "verifier_attempt"
    | "workflow_transition"
    | "budget_accounting"
    | "provider_operation"
    | "retry_or_error"
    | "experiment_execution"
    | "final_claim"
    | "plan_mutation";
  categoryId: SavedEverythingCategory["id"];
  label: string;
  eventTypes: string[];
  requiredIssueCodePrefixes: string[];
  replayEvidence: string;
};

export type SavedEverythingReleaseCoverageReport = {
  format: "matematica.saved-everything-release-coverage";
  version: 1;
  ok: boolean;
  strictNotObservedFails: boolean;
  requiredOperations: number;
  requirements: Array<SavedEverythingReleaseCoverageRequirement & {
    categoryPresent: boolean;
    eventTypesCovered: string[];
    issuePrefixesCovered: string[];
    missing: string[];
  }>;
  issues: string[];
};

export type AuditSavedEverythingOptions = {
  requireObservedCategoryIds?: SavedEverythingCategory["id"][];
  failOnNotObserved?: boolean;
};

export const SAVED_EVERYTHING_RELEASE_REQUIREMENTS: SavedEverythingReleaseCoverageRequirement[] = [
  {
    id: "ai_call",
    categoryId: "ai_actions",
    label: "AI model request and terminal result",
    eventTypes: ["ai.call.started", "ai.call.completed", "ai.call.failed", "ai.call.aborted"],
    requiredIssueCodePrefixes: ["ai_call_", "ai_trace_"],
    replayEvidence: "request, response or error, usage, transcript, external operation, and budget reservation"
  },
  {
    id: "tool_call",
    categoryId: "tool_calls",
    label: "AI tool-loop step and stream chunk",
    eventTypes: ["ai.call.step", "ai.call.stream_chunk", "ai.call.transcript.persisted"],
    requiredIssueCodePrefixes: ["ai_call_step_", "ai_call_stream_", "ai_trace_"],
    replayEvidence: "step artifacts, stream chunk artifacts, transcript artifact, and external operation id"
  },
  {
    id: "source_retrieval",
    categoryId: "search_research",
    label: "Search or research source retrieval",
    eventTypes: ["source.query", "source.results", "source.citations.reviewed", "source.retrieval.evaluated"],
    requiredIssueCodePrefixes: ["source_"],
    replayEvidence: "query request artifact, citation-only result artifact, source records, license, provenance, and retrieval evaluation"
  },
  {
    id: "verifier_attempt",
    categoryId: "verifiers",
    label: "Verifier attempt and proof gate",
    eventTypes: ["verifier.started", "verifier.completed", "proof.obligations.reviewed", "formalization.assessed"],
    requiredIssueCodePrefixes: ["verifier_", "proof_"],
    replayEvidence: "verifier input, stdout, stderr, result artifact, proof obligations, and independent equivalence review"
  },
  {
    id: "workflow_transition",
    categoryId: "branch_decisions",
    label: "Workflow transition and branch scheduling decision",
    eventTypes: ["phase.completed", "swarm.fanout.planned", "worker.queued", "worker.committed"],
    requiredIssueCodePrefixes: ["worker_", "event_artifact_completeness_missing"],
    replayEvidence: "phase output manifest, prompt lineage, branch lineage, worker job ids, and next-cycle decision"
  },
  {
    id: "budget_accounting",
    categoryId: "budgets",
    label: "Budget reservation, debit, release, and preflight",
    eventTypes: ["budget.checked", "budget.reserved", "budget.debited", "budget.released", "remote.cost.preflight"],
    requiredIssueCodePrefixes: ["budget_", "external_operation_"],
    replayEvidence: "hard caps, reservation ids, measured usage, debit/release settlement, and exhausted dimension"
  },
  {
    id: "provider_operation",
    categoryId: "providers",
    label: "Provider route, egress, and external operation",
    eventTypes: ["provider.matrix.pinned", "provider.routing.pinned", "external.operation.prepared", "external.operation.completed", "privacy.remote_provider.used"],
    requiredIssueCodePrefixes: ["provider_", "external_operation_", "ai_call_"],
    replayEvidence: "requested provider/model, observed provider/model, egress decision, idempotency key, and operation status"
  },
  {
    id: "retry_or_error",
    categoryId: "providers",
    label: "Retry, provider error, or unknown external outcome",
    eventTypes: ["ai.call.failed", "external.operation.unknown", "external.operation.dead_lettered", "external.operation.failed", "provider.retry_after.observed"],
    requiredIssueCodePrefixes: ["external_operation_", "ai_call_", "provider_"],
    replayEvidence: "retry lineage, sanitized provider error artifact, retained reservation, and operator reconciliation path"
  },
  {
    id: "experiment_execution",
    categoryId: "experiments",
    label: "Experiment execution and ranking",
    eventTypes: ["worker.ranked", "worker.committed"],
    requiredIssueCodePrefixes: ["worker_", "event_artifact_completeness_missing"],
    replayEvidence: "experiment artifact, sandbox/verifier handoff, score, branch result, and ranking rationale"
  },
  {
    id: "final_claim",
    categoryId: "verifiers",
    label: "Final claim, success evaluation, and terminal report",
    eventTypes: ["goal.success.evaluated", "goal.finalization.checked", "goal.completed", "goal.failed", "report.generated"],
    requiredIssueCodePrefixes: ["terminal_", "proof_", "event_artifact_completeness_missing"],
    replayEvidence: "decision token, proof/counterexample/computation evidence ids, finalization quorum, terminal integrity, and report artifact"
  },
  {
    id: "plan_mutation",
    categoryId: "plan_mutations",
    label: "Plan mutation and adversarial review",
    eventTypes: ["adversarial.quorum.reviewed"],
    requiredIssueCodePrefixes: ["adversarial_", "event_artifact_completeness_missing"],
    replayEvidence: "plan-change scope, reviewer artifacts, findings, and accepted/rejected rationale"
  }
];

export function auditRun(runId: string, ledger: Ledger): AuditResult {
  const run = ledger.requireRun(runId);
  const events = ledger.listEvents(runId);
  const artifacts = ledger.listArtifacts(runId);
  const maintenance = ledger.maintenanceSnapshot();
  const artifactIds = new Set(artifacts.map((artifact) => artifact.id));
  const issues: AuditIssue[] = [];

  if (ledger.schemaVersion() !== ledger.appliedMigrations().length) {
    issues.push({
      severity: "error",
      code: "schema_version_mismatch",
      message: `PRAGMA user_version ${ledger.schemaVersion()} does not match applied migrations ${ledger.appliedMigrations().length}.`
    });
  }

  auditLedgerEventHashChain(events, artifacts, issues);
  auditLedgerWitness(runId, ledger, issues);
  auditLedgerMaintenance(maintenance, issues);
  const externalOperations = ledger.listExternalOperations(runId);
  auditExternalOperationPersistence(events, artifactIds, externalOperations, issues);
  auditWorkerPersistence(events, ledger.listWorkerJobs(runId), issues);
  auditProviderMatrixPersistence(events, artifacts, artifactIds, issues);
  auditSourceCitationDiscipline(events, artifactIds, issues);
  auditAiTraceCompleteness(run.status, events, issues);
  auditSideTablePersistence(runId, ledger, events, issues);
  auditReportSnapshotProvenance(events, artifacts, issues);
  auditWorkflowPhaseContracts(runId, ledger, issues);

  for (const artifact of artifacts) {
    if (!existsSync(artifact.path)) {
      issues.push({
        severity: "error",
        code: "artifact_missing",
        message: `Artifact ${artifact.id} is missing at ${artifact.path}.`
      });
      continue;
    }
    const content = readArtifactBytes(artifact);
    const sha256 = createHash("sha256").update(content).digest("hex");
    if (sha256 !== artifact.sha256) {
      issues.push({
        severity: "error",
        code: "artifact_hash_mismatch",
        message: `Artifact ${artifact.id} hash mismatch: expected ${artifact.sha256}, got ${sha256}.`
      });
    }
    if (content.byteLength !== artifact.bytes) {
      issues.push({
        severity: "warning",
        code: "artifact_size_mismatch",
        message: `Artifact ${artifact.id} size mismatch: expected ${artifact.bytes}, got ${content.byteLength}.`
      });
    }
    auditArtifactProvenance(artifact, issues);
    const createdEvent = events.find((event) =>
      event.type === "artifact.created" &&
      event.payload.artifactId === artifact.id &&
      event.artifactIds.includes(artifact.id)
    );
    if (!createdEvent) {
      issues.push({
        severity: "error",
        code: "artifact_row_missing_created_event",
        message: `Artifact ${artifact.id} has a ledger row but no linked artifact.created event.`
      });
    } else {
      if (
        createdEvent.payload.kind !== artifact.kind ||
        createdEvent.payload.sha256 !== artifact.sha256 ||
        createdEvent.payload.contentAddress !== artifact.contentAddress ||
        createdEvent.payload.mediaType !== artifact.mediaType ||
        createdEvent.payload.storageKey !== artifact.storageKey ||
        createdEvent.payload.bytes !== artifact.bytes ||
        stableHash(createdEvent.payload.provenance) !== stableHash(artifact.provenance)
      ) {
        issues.push({
          severity: "error",
          code: "artifact_created_payload_mismatch",
          message: `Artifact ${artifact.id} row diverges from its artifact.created ledger payload.`
        });
      }
    }
  }

  for (const event of events) {
    for (const artifactId of event.artifactIds) {
      if (!artifactIds.has(artifactId)) {
        issues.push({
          severity: "error",
          code: "event_missing_artifact",
          message: `Event ${event.id} references missing artifact ${artifactId}.`
        });
      }
    }
    auditEventArtifactCompleteness(event, issues);
    auditActionPersistence(event, artifactIds, issues);
  }

  if (events.length === 0) {
    issues.push({
      severity: "warning",
      code: "no_events",
      message: "Run has no ledger events."
    });
  }

  return {
    ok: issues.every((issue) => issue.severity !== "error"),
    runId,
    schemaVersion: ledger.schemaVersion(),
    migrations: ledger.appliedMigrations(),
    maintenance,
    events: events.length,
    artifacts: artifacts.length,
    externalOperations: externalOperations.map((operation) => ({
      id: operation.id,
      operationType: operation.operationType,
      provider: operation.provider,
      idempotencyKey: operation.idempotencyKey,
      requestHash: operation.requestHash,
      status: operation.status,
      retryOfOperationId: operation.retryOfOperationId
    })),
    retryLineage: buildRetryLineage(events),
    issues
  };
}

function auditWorkflowPhaseContracts(runId: string, ledger: Ledger, issues: AuditIssue[]): void {
  const phaseAudit = auditWorkflowPhaseReleaseReadiness(ledger, runId);
  for (const issue of phaseAudit.issues) {
    issues.push({
      severity: "error",
      code: "workflow_phase_release_audit_failed",
      message: issue
    });
  }
}

function auditLedgerMaintenance(snapshot: LedgerMaintenanceSnapshot, issues: AuditIssue[]): void {
  if (!snapshot.integrity.migrationsComplete) {
    issues.push({
      severity: "error",
      code: "schema_migration_missing",
      message: `Ledger has ${snapshot.appliedMigrations.length} applied migrations but expected the complete migration set.`
    });
  }
  if (!snapshot.integrity.concurrencyConfigOk) {
    issues.push({
      severity: "error",
      code: "sqlite_concurrency_config_invalid",
      message: `SQLite must run in WAL mode with busy_timeout >= 10000 and wal_autocheckpoint = 1000; observed ${JSON.stringify(snapshot.sqlite)}.`
    });
  }
  for (const index of snapshot.requiredIndexes) {
    if (index.present) continue;
    issues.push({
      severity: "error",
      code: "ledger_required_index_missing",
      message: `Required ledger index ${index.name} on ${index.table} is missing: ${index.purpose}`
    });
  }
}

export function auditSavedEverything(
  runId: string,
  ledger: Ledger,
  options: AuditSavedEverythingOptions = {}
): SavedEverythingAudit {
  const baseAudit = auditRun(runId, ledger);
  const events = ledger.listEvents(runId);
  const artifacts = ledger.listArtifacts(runId);
  const externalOperations = ledger.listExternalOperations(runId);
  const workerJobs = ledger.listWorkerJobs(runId);
  const requiredCategoryIds = new Set(options.requireObservedCategoryIds ?? []);
  const categories = savedEverythingCategories().map((definition): SavedEverythingCategory => {
    const eventRefs = events
      .filter(definition.matches)
      .map((event) => ({
        eventId: event.id,
        type: event.type,
        artifactIds: event.artifactIds
      }));
    const issues = baseAudit.issues.filter((issue) => definition.issueCodes.some((prefix) => issue.code.startsWith(prefix)) || definition.issueMessageTypes.some((type) => issue.message.includes(type)));
    const requiredButMissing = options.failOnNotObserved === true &&
      requiredCategoryIds.has(definition.id) &&
      eventRefs.length === 0;
    if (requiredButMissing) {
      issues.push({
        severity: "error",
        code: "saved_everything_required_category_not_observed",
        message: `Required saved-everything category ${definition.id} (${definition.label}) was not observed in this release fixture.`
      });
    }
    const status: SavedEverythingCategoryStatus = issues.some((issue) => issue.severity === "error")
      ? "failed"
      : eventRefs.length > 0
        ? "passed"
        : "not_observed";
    return {
      id: definition.id,
      label: definition.label,
      status,
      observedEvents: eventRefs.length,
      artifactBackedEvents: eventRefs.filter((event) => event.artifactIds.length > 0).length,
      eventRefs,
      issues
    };
  });
  const uncoveredIssues = baseAudit.issues.filter((issue) =>
    !categories.some((category) => category.issues.some((categoryIssue) => categoryIssue === issue))
  );
  const allIssues = uniqueIssueRefs([
    ...baseAudit.issues,
    ...categories.flatMap((category) => category.issues)
  ]);
  return {
    format: "matematica.saved-everything-audit",
    version: 1,
    ok: baseAudit.ok && categories.every((category) => category.status !== "failed") && uncoveredIssues.every((issue) => issue.severity !== "error"),
    runId,
    baseAuditOk: baseAudit.ok,
    events: events.length,
    artifacts: artifacts.length,
    externalOperations: externalOperations.length,
    workerJobs: workerJobs.length,
    categories,
    issues: allIssues
  };
}

export function buildSavedEverythingReleaseCoverageReport(input: {
  requirements?: SavedEverythingReleaseCoverageRequirement[];
} = {}): SavedEverythingReleaseCoverageReport {
  const definitions = savedEverythingCategories();
  const requirements = (input.requirements ?? SAVED_EVERYTHING_RELEASE_REQUIREMENTS).map((requirement) => {
    const category = definitions.find((definition) => definition.id === requirement.categoryId);
    const eventTypesCovered = category
      ? requirement.eventTypes.filter((type) => category.matches(syntheticEvent(type)))
      : [];
    const issuePrefixesCovered = category
      ? requirement.requiredIssueCodePrefixes.filter((prefix) =>
        category.issueCodes.some((codePrefix) => codePrefix.startsWith(prefix) || prefix.startsWith(codePrefix))
      )
      : [];
    const missing = [
      category ? undefined : `category ${requirement.categoryId}`,
      ...requirement.eventTypes
        .filter((type) => !eventTypesCovered.includes(type))
        .map((type) => `event ${type}`),
      ...requirement.requiredIssueCodePrefixes
        .filter((prefix) => !issuePrefixesCovered.includes(prefix))
        .map((prefix) => `issue prefix ${prefix}`),
      requirement.replayEvidence.trim() ? undefined : "replay evidence description"
    ].filter((item): item is string => Boolean(item));
    return {
      ...requirement,
      categoryPresent: category !== undefined,
      eventTypesCovered,
      issuePrefixesCovered,
      missing
    };
  });
  const issues = requirements.flatMap((requirement) =>
    requirement.missing.map((missing) => `${requirement.id}: missing ${missing}`)
  );
  return {
    format: "matematica.saved-everything-release-coverage",
    version: 1,
    ok: issues.length === 0,
    strictNotObservedFails: true,
    requiredOperations: requirements.length,
    requirements,
    issues
  };
}

type SavedEverythingCategoryDefinition = {
  id: SavedEverythingCategory["id"];
  label: string;
  matches: (event: ReturnType<Ledger["listEvents"]>[number]) => boolean;
  issueCodes: string[];
  issueMessageTypes: string[];
};

function savedEverythingCategories(): SavedEverythingCategoryDefinition[] {
  return [
    {
      id: "ai_actions",
      label: "AI actions",
      matches: (event) => event.type.startsWith("ai.call."),
      issueCodes: ["ai_call_", "ai_trace_"],
      issueMessageTypes: ["ai.call."]
    },
    {
      id: "tool_calls",
      label: "AI tool-loop steps and streamed chunks",
      matches: (event) => event.type === "ai.call.step" || event.type === "ai.call.stream_chunk" || event.type === "ai.call.transcript.persisted",
      issueCodes: ["ai_call_step_", "ai_call_stream_", "ai_trace_"],
      issueMessageTypes: ["ai.call.step", "ai.call.stream_chunk", "ai.call.transcript.persisted"]
    },
    {
      id: "search_research",
      label: "Search and research ingestion",
      matches: (event) => event.type.startsWith("source."),
      issueCodes: ["source_", "novelty_claim_"],
      issueMessageTypes: ["source."]
    },
    {
      id: "branch_decisions",
      label: "Workflow transitions, branch decisions, and worker lifecycle",
      matches: (event) => event.type === "phase.completed" || event.type.startsWith("worker.") || event.type.startsWith("branch.") || event.type.startsWith("swarm.coordinator.") || event.type === "swarm.fanout.planned" || event.type === "loophole.assumption_delta.reviewed",
      issueCodes: ["worker_", "event_artifact_completeness_missing"],
      issueMessageTypes: ["worker.", "branch.", "swarm.coordinator.", "swarm.fanout.planned", "loophole.assumption_delta.reviewed"]
    },
    {
      id: "experiments",
      label: "Experiment execution and ranking",
      matches: (event) =>
        event.type === "worker.ranked" ||
        stringValue(event.payload.phase)?.includes("experiment") === true ||
        stringValue(event.payload.kind)?.includes("experiment") === true,
      issueCodes: ["worker_", "event_artifact_completeness_missing"],
      issueMessageTypes: ["experiment", "worker.ranked"]
    },
    {
      id: "verifiers",
      label: "Verifier results and proof gates",
      matches: (event) =>
        event.type.startsWith("verifier.") ||
        event.type.startsWith("proof.") ||
        event.type.startsWith("theorem.") ||
        event.type === "formalization.assessed" ||
        event.type === "counterexample.search.reviewed" ||
        event.type === "claim.graph.reviewed" ||
        event.type === "goal.success.evaluated" ||
        event.type === "goal.finalization.checked" ||
        event.type === "goal.completed" ||
        event.type === "goal.failed" ||
        event.type === "report.generated" ||
        event.type === "adversarial.quorum.reviewed",
      issueCodes: ["verifier_", "proof_", "problem_classification_", "terminal_", "event_artifact_completeness_missing"],
      issueMessageTypes: ["verifier.", "proof.", "theorem.", "formalization", "counterexample", "claim.graph", "goal.finalization", "adversarial.quorum.reviewed"]
    },
    {
      id: "budgets",
      label: "Budget reservations and settlement",
      matches: (event) => event.type.startsWith("budget.") || event.type === "remote.cost.preflight" || event.type === "swarm.admission.preview",
      issueCodes: ["budget_", "external_operation_"],
      issueMessageTypes: ["budget.", "remote.cost.preflight", "swarm.admission.preview"]
    },
    {
      id: "providers",
      label: "Provider calls, routing, and remote operation state",
      matches: (event) =>
        event.type.startsWith("provider.") ||
        event.type.startsWith("external.operation.") ||
        event.type.startsWith("ai.call.") ||
        event.type === "privacy.remote_provider.used",
      issueCodes: ["provider_", "openrouter_", "external_operation_", "ai_call_"],
      issueMessageTypes: ["provider.", "external.operation.", "ai.call.", "privacy.remote_provider.used"]
    },
    {
      id: "plan_mutations",
      label: "Plan changes and adversarial planning review",
      matches: (event) => event.type === "adversarial.quorum.reviewed" && event.payload.scope === "plan_change",
      issueCodes: ["adversarial_", "event_artifact_completeness_missing"],
      issueMessageTypes: ["adversarial.quorum.reviewed", "plan_change"]
    }
  ];
}

function syntheticEvent(type: string): ReturnType<Ledger["listEvents"]>[number] {
  const payload = type === "adversarial.quorum.reviewed"
    ? { scope: "plan_change" }
    : type === "worker.committed"
      ? { kind: "experiment" }
      : {};
  return {
    id: `synthetic-${type}`,
    runId: "synthetic-run",
    type,
    payload,
    artifactIds: [],
    createdAt: "1970-01-01T00:00:00.000Z",
    sequence: 0,
    payloadHash: "",
    linkedArtifactHashes: [],
    schemaVersion: 1,
    eventHash: ""
  } as ReturnType<Ledger["listEvents"]>[number];
}

function uniqueIssueRefs(issues: AuditIssue[]): AuditIssue[] {
  const seen = new Set<string>();
  const unique: AuditIssue[] = [];
  for (const issue of issues) {
    const key = `${issue.severity}:${issue.code}:${issue.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(issue);
  }
  return unique;
}

function auditLedgerWitness(runId: string, ledger: Ledger, issues: AuditIssue[]): void {
  const witness = ledger.verifyLedgerWitness(runId);
  for (const issue of witness.issues) {
    issues.push({
      severity: "error",
      code: issue.code,
      message: issue.message
    });
  }
}

function auditLedgerEventHashChain(
  events: ReturnType<Ledger["listEvents"]>,
  artifacts: ReturnType<Ledger["listArtifacts"]>,
  issues: AuditIssue[]
): void {
  let previousComputedHash: string | undefined;
  const artifactHashesById = new Map(artifacts.map((artifact) => [artifact.id, artifact.sha256]));
  events.forEach((event, index) => {
    if (typeof event.sequence !== "number") {
      issues.push({
        severity: "error",
        code: "event_sequence_missing",
        message: `Event ${event.id} (${event.type}) is missing a ledger sequence.`
      });
      return;
    }
    if (event.sequence !== index) {
      issues.push({
        severity: "error",
        code: "event_sequence_gap",
        message: `Event ${event.id} (${event.type}) has sequence ${event.sequence}, expected ${index}.`
      });
    }
    if (event.previousEventHash !== previousComputedHash) {
      issues.push({
        severity: "error",
        code: "event_previous_hash_mismatch",
        message: `Event ${event.id} (${event.type}) previous hash does not match the recomputed prior event hash.`
      });
    }
    const payloadHash = stableHash(event.payload);
    if (!event.payloadHash) {
      issues.push({
        severity: "error",
        code: "event_payload_hash_missing",
        message: `Event ${event.id} (${event.type}) is missing a payload hash.`
      });
    } else if (event.payloadHash !== payloadHash) {
      issues.push({
        severity: "error",
        code: "event_payload_hash_mismatch",
        message: `Event ${event.id} (${event.type}) payload hash mismatch: expected ${event.payloadHash}, got ${payloadHash}.`
      });
    }
    if (typeof event.schemaVersion !== "number") {
      issues.push({
        severity: "error",
        code: "event_schema_version_missing",
        message: `Event ${event.id} (${event.type}) is missing schema version.`
      });
    }
    if (!Array.isArray(event.linkedArtifactHashes)) {
      issues.push({
        severity: "error",
        code: "event_linked_artifact_hashes_missing",
        message: `Event ${event.id} (${event.type}) is missing linked artifact hash manifest.`
      });
    }
    const linkedArtifactHashes = event.linkedArtifactHashes ?? [];
    const expectedLinkedManifest = event.artifactIds.map((artifactId) => ({
      artifactId,
      sha256: artifactHashesById.get(artifactId)
    }));
    if (stableHash(linkedArtifactHashes) !== stableHash(expectedLinkedManifest)) {
      issues.push({
        severity: "error",
        code: "event_linked_artifact_hash_mismatch",
        message: `Event ${event.id} (${event.type}) linked artifact hash manifest does not match linked artifacts.`
      });
    }
    auditTerminalIntegrity(event, linkedArtifactHashes, issues);
    const recomputedHash = computeLedgerEventHash({
      runId: event.runId,
      type: event.type,
      payload: event.payload,
      artifactIds: event.artifactIds,
      sequence: event.sequence,
      payloadHash,
      linkedArtifactHashes,
      schemaVersion: event.schemaVersion,
      previousEventHash: event.previousEventHash
    });
    if (!event.eventHash) {
      issues.push({
        severity: "error",
        code: "event_hash_missing",
        message: `Event ${event.id} (${event.type}) is missing a ledger event hash.`
      });
    } else if (event.eventHash !== recomputedHash) {
      issues.push({
        severity: "error",
        code: "event_hash_mismatch",
        message: `Event ${event.id} (${event.type}) hash mismatch: expected ${event.eventHash}, got ${recomputedHash}.`
      });
    }
    previousComputedHash = recomputedHash;
  });
}

function auditArtifactProvenance(
  artifact: ReturnType<Ledger["listArtifacts"]>[number],
  issues: AuditIssue[]
): void {
  if (!artifact.provenance || typeof artifact.provenance !== "object" || Array.isArray(artifact.provenance)) {
    issues.push({
      severity: "error",
      code: "artifact_provenance_missing",
      message: `Artifact ${artifact.id} is missing raw/redacted provenance metadata.`
    });
    return;
  }
  const provenance = artifact.provenance;
  if (artifact.contentAddress !== `sha256:${artifact.sha256}`) {
    issues.push({
      severity: "error",
      code: "artifact_content_address_mismatch",
      message: `Artifact ${artifact.id} content address ${artifact.contentAddress} does not match sha256 ${artifact.sha256}.`
    });
  }
  if (typeof artifact.mediaType !== "string" || artifact.mediaType.length === 0) {
    issues.push({
      severity: "error",
      code: "artifact_media_type_missing",
      message: `Artifact ${artifact.id} is missing artifact media type metadata.`
    });
  }
  if (artifact.storageKey !== `${artifact.runId}/${artifact.sha256}.txt`) {
    issues.push({
      severity: "error",
      code: "artifact_storage_key_mismatch",
      message: `Artifact ${artifact.id} storage key ${artifact.storageKey} does not match its content-addressed location.`
    });
  }
  const raw = provenance.raw;
  const redacted = provenance.redacted;
  if (
    provenance.contentAddress !== artifact.contentAddress ||
    provenance.mediaType !== artifact.mediaType ||
    provenance.storageKey !== artifact.storageKey
  ) {
    issues.push({
      severity: "error",
      code: "artifact_provenance_metadata_mismatch",
      message: `Artifact ${artifact.id} provenance metadata diverges from the artifact row.`
    });
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    issues.push({
      severity: "error",
      code: "artifact_raw_provenance_missing",
      message: `Artifact ${artifact.id} is missing raw-input provenance.`
    });
  } else {
    const rawRecord = raw as Record<string, unknown>;
    const hasRawHash = typeof rawRecord.sha256 === "string" && rawRecord.sha256.length > 0;
    const hasUnavailableReason = typeof rawRecord.unavailableReason === "string" && rawRecord.unavailableReason.length > 0;
    if (!hasRawHash && !hasUnavailableReason) {
      issues.push({
        severity: "error",
        code: "artifact_raw_provenance_missing",
        message: `Artifact ${artifact.id} raw provenance must include a raw hash or explicit unavailability reason.`
      });
    }
  }
  if (!redacted || typeof redacted !== "object" || Array.isArray(redacted)) {
    issues.push({
      severity: "error",
      code: "artifact_redacted_provenance_missing",
      message: `Artifact ${artifact.id} is missing redacted-byte provenance.`
    });
    return;
  }
  const redactedRecord = redacted as Record<string, unknown>;
  if (
    redactedRecord.sha256 !== artifact.sha256 ||
    redactedRecord.bytes !== artifact.bytes ||
    redactedRecord.contentAddress !== artifact.contentAddress ||
    redactedRecord.mediaType !== artifact.mediaType
  ) {
    issues.push({
      severity: "error",
      code: "artifact_redacted_provenance_mismatch",
      message: `Artifact ${artifact.id} redacted provenance diverges from the artifact row.`
    });
  }
  if (typeof provenance.redactionPolicyVersion !== "string" || provenance.redactionPolicyVersion.length === 0) {
    issues.push({
      severity: "error",
      code: "artifact_redaction_policy_missing",
      message: `Artifact ${artifact.id} is missing redaction policy provenance.`
    });
  }
}

function auditSideTablePersistence(
  runId: string,
  ledger: Ledger,
  events: ReturnType<Ledger["listEvents"]>,
  issues: AuditIssue[]
): void {
  auditScoreRows(runId, ledger, events, issues);
  auditReportRows(runId, ledger, events, issues);
  auditSourceRecordRows(runId, ledger, events, issues);
  auditVerifierRunRows(runId, ledger, events, issues);
}

function auditScoreRows(
  runId: string,
  ledger: Ledger,
  events: ReturnType<Ledger["listEvents"]>,
  issues: AuditIssue[]
): void {
  const rows = ledger.db.query(`
    SELECT id, subject_id, scorer, score, rubric_json
    FROM scores
    WHERE run_id = ?
  `).all(runId) as Array<{
    id: string;
    subject_id: string;
    scorer: string;
    score: number;
    rubric_json: string;
  }>;
  for (const row of rows) {
    const event = events.find((item) => item.type === "evidence.scored" && item.payload.scoreId === row.id);
    if (!event) {
      issues.push({
        severity: "error",
        code: "side_table_missing_event",
        message: `Score row ${row.id} has no matching evidence.scored ledger event.`
      });
      continue;
    }
    if (
      event.payload.subjectId !== row.subject_id ||
      event.payload.scorer !== row.scorer ||
      event.payload.score !== row.score ||
      stableHash(event.payload.rubric) !== stableHash(parseJsonObject(row.rubric_json))
    ) {
      issues.push({
        severity: "error",
        code: "side_table_event_mismatch",
        message: `Score row ${row.id} diverges from its evidence.scored ledger event.`
      });
    }
  }
}

function auditReportRows(
  runId: string,
  ledger: Ledger,
  events: ReturnType<Ledger["listEvents"]>,
  issues: AuditIssue[]
): void {
  const rows = ledger.db.query(`
    SELECT id, kind, artifact_id
    FROM reports
    WHERE run_id = ?
  `).all(runId) as Array<{ id: string; kind: string; artifact_id: string | null }>;
  for (const row of rows) {
    const event = events.find((item) => item.type === "report.generated" && item.payload.reportId === row.id);
    if (!event) {
      issues.push({
        severity: "error",
        code: "side_table_missing_event",
        message: `Report row ${row.id} has no matching report.generated ledger event.`
      });
      continue;
    }
    if (event.payload.kind !== row.kind || (row.artifact_id && !event.artifactIds.includes(row.artifact_id))) {
      issues.push({
        severity: "error",
        code: "side_table_event_mismatch",
        message: `Report row ${row.id} diverges from its report.generated ledger event.`
      });
    }
  }
}

function auditReportSnapshotProvenance(
  events: ReturnType<Ledger["listEvents"]>,
  artifacts: ReturnType<Ledger["listArtifacts"]>,
  issues: AuditIssue[]
): void {
  const artifactById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const eventById = new Map(events.map((event) => [event.id, event]));
  for (const event of events) {
    if (event.type !== "report.generated") continue;
    const payload = event.payload;
    const snapshotArtifactId = stringValue(payload.snapshotArtifactId);
    const reportArtifactId = stringValue(payload.reportArtifactId) ?? stringValue(payload.artifactId);
    const snapshotHash = stringValue(payload.snapshotHash);
    const reportHash = stringValue(payload.reportHash);
    const reportInputHash = stringValue(payload.reportInputHash);
    const sourceEventRange = recordValue(payload.sourceEventRange);

    if (!snapshotArtifactId || !reportArtifactId || !snapshotHash || !reportHash || !reportInputHash || Object.keys(sourceEventRange).length === 0) {
      issues.push({
        severity: "error",
        code: "report_snapshot_provenance_missing",
        message: `report.generated event ${event.id} must link snapshot/report artifacts and carry snapshotHash, reportInputHash, sourceEventRange, and reportHash.`
      });
      continue;
    }
    if (!event.artifactIds.includes(snapshotArtifactId) || !event.artifactIds.includes(reportArtifactId)) {
      issues.push({
        severity: "error",
        code: "report_snapshot_artifact_link_missing",
        message: `report.generated event ${event.id} does not link both snapshot artifact ${snapshotArtifactId} and report artifact ${reportArtifactId}.`
      });
    }

    const snapshotArtifact = artifactById.get(snapshotArtifactId);
    const reportArtifact = artifactById.get(reportArtifactId);
    if (!snapshotArtifact || !reportArtifact) {
      issues.push({
        severity: "error",
        code: "report_snapshot_artifact_missing",
        message: `report.generated event ${event.id} references missing snapshot or report artifacts.`
      });
      continue;
    }
    if (snapshotArtifact.kind !== "report.run_snapshot") {
      issues.push({
        severity: "error",
        code: "report_snapshot_kind_mismatch",
        message: `Report snapshot artifact ${snapshotArtifact.id} has kind ${snapshotArtifact.kind}.`
      });
    }
    if (!reportArtifact.kind.startsWith("report.")) {
      issues.push({
        severity: "error",
        code: "report_artifact_kind_mismatch",
        message: `Report artifact ${reportArtifact.id} has kind ${reportArtifact.kind}.`
      });
    }

    const snapshot = parseJsonObject(readArtifactText(snapshotArtifact));
    if (snapshot.format !== "matematica.run-report-snapshot" || snapshot.version !== 1) {
      issues.push({
        severity: "error",
        code: "report_snapshot_format_invalid",
        message: `Report snapshot artifact ${snapshotArtifact.id} is not a matematica.run-report-snapshot v1 payload.`
      });
      continue;
    }
    if (stableHash(snapshot) !== snapshotHash) {
      issues.push({
        severity: "error",
        code: "report_snapshot_hash_mismatch",
        message: `Report snapshot ${snapshotArtifact.id} hash diverges from report.generated payload.`
      });
    }
    if (stringValue(payload.snapshotArtifactSha256) !== snapshotArtifact.sha256) {
      issues.push({
        severity: "error",
        code: "report_snapshot_artifact_hash_mismatch",
        message: `Report snapshot ${snapshotArtifact.id} artifact sha256 diverges from report.generated payload.`
      });
    }
    if (snapshot.regenerated !== false || payload.regenerated !== false) {
      issues.push({
        severity: "error",
        code: "report_snapshot_regenerated",
        message: `Report snapshot ${snapshotArtifact.id} must declare regenerated=false.`
      });
    }
    if (snapshot.reportHash !== reportHash || snapshot.reportInputHash !== reportInputHash) {
      issues.push({
        severity: "error",
        code: "report_snapshot_payload_mismatch",
        message: `Report snapshot ${snapshotArtifact.id} report hash or report input hash diverges from report.generated payload.`
      });
    }
    if (stableHash(recordValue(snapshot.sourceEventRange)) !== stableHash(sourceEventRange)) {
      issues.push({
        severity: "error",
        code: "report_snapshot_source_range_mismatch",
        message: `Report snapshot ${snapshotArtifact.id} source event range diverges from report.generated payload.`
      });
    }
    const reportArtifactHash = stableHash(readArtifactText(reportArtifact));
    if (reportArtifactHash !== reportHash) {
      issues.push({
        severity: "error",
        code: "report_artifact_hash_mismatch",
        message: `Report artifact ${reportArtifact.id} content hash diverges from report.generated reportHash.`
      });
    }

    const sourceEvents = recordArray(snapshot.sourceEvents);
    if (sourceEvents.length !== numberValue(snapshot.eventCount)) {
      issues.push({
        severity: "error",
        code: "report_snapshot_event_count_mismatch",
        message: `Report snapshot ${snapshotArtifact.id} event manifest count diverges from eventCount.`
      });
    }
    const lastSourceEvent = sourceEvents[sourceEvents.length - 1];
    if (stringValue(lastSourceEvent?.eventHash) !== stringValue(snapshot.ledgerHeadEventHash)) {
      issues.push({
        severity: "error",
        code: "report_snapshot_head_mismatch",
        message: `Report snapshot ${snapshotArtifact.id} ledger head hash diverges from its source event manifest.`
      });
    }
    for (const sourceEvent of sourceEvents) {
      const current = eventById.get(stringValue(sourceEvent.id) ?? "");
      if (!current) {
        issues.push({
          severity: "error",
          code: "report_snapshot_source_event_missing",
          message: `Report snapshot ${snapshotArtifact.id} references missing source event ${String(sourceEvent.id)}.`
        });
        continue;
      }
      if (
        current.type !== sourceEvent.type ||
        current.sequence !== numberValue(sourceEvent.sequence) ||
        current.eventHash !== stringValue(sourceEvent.eventHash) ||
        current.payloadHash !== stringValue(sourceEvent.payloadHash) ||
        !sameStringSet(current.artifactIds, stringArray(sourceEvent.artifactIds))
      ) {
        issues.push({
          severity: "error",
          code: "report_snapshot_source_event_drift",
          message: `Report snapshot ${snapshotArtifact.id} source event ${current.id} diverges from current ledger state.`
        });
      }
    }

    const artifactManifest = recordArray(snapshot.artifactManifest);
    if (stableHash(artifactManifest) !== stringValue(snapshot.artifactManifestHash)) {
      issues.push({
        severity: "error",
        code: "report_snapshot_artifact_manifest_hash_mismatch",
        message: `Report snapshot ${snapshotArtifact.id} artifact manifest hash is invalid.`
      });
    }
    for (const manifestArtifact of artifactManifest) {
      const current = artifactById.get(stringValue(manifestArtifact.id) ?? "");
      if (!current) {
        issues.push({
          severity: "error",
          code: "report_snapshot_source_artifact_missing",
          message: `Report snapshot ${snapshotArtifact.id} references missing source artifact ${String(manifestArtifact.id)}.`
        });
        continue;
      }
      if (
        current.kind !== manifestArtifact.kind ||
        current.sha256 !== stringValue(manifestArtifact.sha256) ||
        current.contentAddress !== stringValue(manifestArtifact.contentAddress) ||
        current.mediaType !== stringValue(manifestArtifact.mediaType) ||
        current.storageKey !== stringValue(manifestArtifact.storageKey) ||
        current.bytes !== numberValue(manifestArtifact.bytes)
      ) {
        issues.push({
          severity: "error",
          code: "report_snapshot_source_artifact_drift",
          message: `Report snapshot ${snapshotArtifact.id} source artifact ${current.id} diverges from current artifact state.`
        });
      }
    }
  }
}

function auditSourceRecordRows(
  runId: string,
  ledger: Ledger,
  events: ReturnType<Ledger["listEvents"]>,
  issues: AuditIssue[]
): void {
  const rows = ledger.db.query(`
    SELECT id, provider, query, source_id, title, url, artifact_id
    FROM source_records
    WHERE run_id = ?
  `).all(runId) as Array<{
    id: string;
    provider: string;
    query: string;
    source_id: string | null;
    title: string | null;
    url: string | null;
    artifact_id: string | null;
  }>;
  for (const row of rows) {
    const event = events.find((item) =>
      item.type.startsWith("source.") &&
      item.payload.sourceRecordId === row.id
    );
    if (!event) {
      issues.push({
        severity: "error",
        code: "side_table_missing_event",
        message: `Source record row ${row.id} has no matching source ledger event.`
      });
      continue;
    }
    if (
      event.payload.provider !== row.provider ||
      event.payload.query !== row.query ||
      (row.source_id && event.payload.sourceId !== row.source_id) ||
      (row.title && event.payload.title !== row.title) ||
      (row.url && event.payload.url !== row.url) ||
      (row.artifact_id && !event.artifactIds.includes(row.artifact_id))
    ) {
      issues.push({
        severity: "error",
        code: "side_table_event_mismatch",
        message: `Source record row ${row.id} diverges from its source ledger event.`
      });
    }
  }
}

function auditVerifierRunRows(
  runId: string,
  ledger: Ledger,
  events: ReturnType<Ledger["listEvents"]>,
  issues: AuditIssue[]
): void {
  const rows = ledger.db.query(`
    SELECT id, verifier_id, status, evidence_grade, artifact_ids_json
    FROM verifier_runs
    WHERE run_id = ?
  `).all(runId) as Array<{
    id: string;
    verifier_id: string;
    status: string;
    evidence_grade: string;
    artifact_ids_json: string;
  }>;
  for (const row of rows) {
    const event = events.find((item) => item.type === "verifier.completed" && item.payload.verifierRunId === row.id);
    if (!event) {
      issues.push({
        severity: "error",
        code: "side_table_missing_event",
        message: `Verifier run row ${row.id} has no matching verifier.completed ledger event.`
      });
      continue;
    }
    if (
      event.payload.verifierId !== row.verifier_id ||
      event.payload.status !== row.status ||
      event.payload.evidenceGrade !== row.evidence_grade ||
      !sameStringSet(event.artifactIds, stringArray(parseJsonValue(row.artifact_ids_json)))
    ) {
      issues.push({
        severity: "error",
        code: "side_table_event_mismatch",
        message: `Verifier run row ${row.id} diverges from its verifier.completed ledger event.`
      });
    }
  }
}

const COMPLETENESS_CRITICAL_EVENTS = new Set<string>([
  "phase.completed",
  "knowledge.promotion.reviewed",
  "worker.committed",
  "budget.checked",
  "budget.reserved",
  "budget.released",
  "budget.debited",
  "worker.ranked",
  "swarm.capacity.reviewed",
  "swarm.fanout.planned",
  "context.compaction.reviewed",
  "loophole.assumption_delta.reviewed",
  "proof.certificate.minimized",
  "adversarial.quorum.reviewed",
  "goal.finalization.checked",
  "goal.completed",
  "goal.failed",
  "report.generated"
]);

function auditEventArtifactCompleteness(
  event: ReturnType<Ledger["listEvents"]>[number],
  issues: AuditIssue[]
): void {
  if (!COMPLETENESS_CRITICAL_EVENTS.has(event.type)) return;
  if (event.artifactIds.length > 0) return;
  if (stringValue(event.payload.noArtifactJustification)) return;
  issues.push({
    severity: "error",
    code: "event_artifact_completeness_missing",
    message: `Completeness-critical event ${event.id} (${event.type}) has no linked artifacts and no noArtifactJustification.`
  });
}

function auditTerminalIntegrity(
  event: ReturnType<Ledger["listEvents"]>[number],
  linkedArtifactHashes: Array<{ artifactId: string; sha256?: string }>,
  issues: AuditIssue[]
): void {
  if (event.type !== "goal.completed" && event.type !== "goal.failed") return;
  const integrity = event.payload.terminalIntegrity;
  if (!integrity || typeof integrity !== "object" || Array.isArray(integrity)) {
    issues.push({
      severity: "error",
      code: "terminal_integrity_missing",
      message: `Terminal event ${event.id} (${event.type}) is missing terminal integrity roots.`
    });
    return;
  }
  const record = integrity as Record<string, unknown>;
  const expectedArtifactRoot = stableHash(linkedArtifactHashes);
  if (record.previousEventHash !== (event.previousEventHash ?? null)) {
    issues.push({
      severity: "error",
      code: "terminal_previous_hash_mismatch",
      message: `Terminal event ${event.id} previous hash root does not match its hash-chain link.`
    });
  }
  if (record.artifactRoot !== expectedArtifactRoot) {
    issues.push({
      severity: "error",
      code: "terminal_artifact_root_mismatch",
      message: `Terminal event ${event.id} artifact root does not match linked artifact hashes.`
    });
  }
  if (record.schemaVersion !== event.schemaVersion) {
    issues.push({
      severity: "error",
      code: "terminal_schema_version_mismatch",
      message: `Terminal event ${event.id} schema version root does not match event schema version.`
    });
  }
}

function auditActionPersistence(
  event: ReturnType<Ledger["listEvents"]>[number],
  artifactIds: Set<string>,
  issues: AuditIssue[]
): void {
  if (event.type === "ai.call.started") {
    requirePayloadArtifact(event, "requestArtifactId", artifactIds, issues, "ai_call_missing_request_artifact");
    requirePayloadString(event, "externalOperationId", issues, "ai_call_missing_external_operation");
  }
  if (event.type === "ai.call.step") {
    requirePayloadArtifact(event, "stepArtifactId", artifactIds, issues, "ai_call_step_missing_artifact");
    requirePayloadString(event, "externalOperationId", issues, "ai_call_step_missing_external_operation");
  }
  if (event.type === "ai.call.stream_chunk") {
    requirePayloadArtifact(event, "streamChunkArtifactId", artifactIds, issues, "ai_call_stream_chunk_missing_artifact");
    requirePayloadString(event, "externalOperationId", issues, "ai_call_stream_chunk_missing_external_operation");
  }
  if (event.type === "ai.call.transcript.persisted") {
    requirePayloadArtifact(event, "transcriptArtifactId", artifactIds, issues, "ai_call_missing_transcript_artifact");
    requirePayloadArtifact(event, "requestArtifactId", artifactIds, issues, "ai_call_missing_request_artifact");
    requirePayloadString(event, "externalOperationId", issues, "ai_call_missing_external_operation");
  }
  if (event.type === "ai.call.completed") {
    requirePayloadString(event, "externalOperationId", issues, "ai_call_missing_external_operation");
    requirePayloadArtifact(event, "requestArtifactId", artifactIds, issues, "ai_call_missing_request_artifact");
    requirePayloadArtifact(event, "responseArtifactId", artifactIds, issues, "ai_call_missing_response_artifact");
    requirePayloadArtifact(event, "transcriptArtifactId", artifactIds, issues, "ai_call_missing_transcript_artifact");
    if (!event.payload.usage || typeof event.payload.usage !== "object") {
      issues.push({
        severity: "error",
        code: "ai_call_missing_usage",
        message: `AI completion event ${event.id} is missing provider usage metadata.`
      });
    }
  }
  if (event.type === "ai.call.failed") {
    requirePayloadString(event, "externalOperationId", issues, "ai_call_missing_external_operation");
    requirePayloadArtifact(event, "requestArtifactId", artifactIds, issues, "ai_call_missing_request_artifact");
    requirePayloadArtifact(event, "errorArtifactId", artifactIds, issues, "ai_call_missing_error_artifact");
    requirePayloadArtifact(event, "transcriptArtifactId", artifactIds, issues, "ai_call_missing_transcript_artifact");
  }
  if (event.type === "ai.call.aborted") {
    requirePayloadString(event, "externalOperationId", issues, "ai_call_missing_external_operation");
    requirePayloadArtifact(event, "errorArtifactId", artifactIds, issues, "ai_call_missing_error_artifact");
    requirePayloadArtifact(event, "transcriptArtifactId", artifactIds, issues, "ai_call_missing_transcript_artifact");
  }
  if (event.type === "provider.retry.scheduled") {
    requirePayloadString(event, "externalOperationId", issues, "provider_retry_missing_parent_operation");
    requirePayloadString(event, "retryAttemptOperationId", issues, "provider_retry_missing_attempt_operation");
    requirePayloadString(event, "retryReservationId", issues, "provider_retry_missing_reservation");
    requirePayloadArtifact(event, "retryRequestArtifactId", artifactIds, issues, "provider_retry_missing_request_artifact");
    requirePayloadArtifact(event, "retryErrorArtifactId", artifactIds, issues, "provider_retry_missing_error_artifact");
  }
  if (event.type === "source.query") {
    requirePayloadString(event, "externalOperationId", issues, "source_query_missing_external_operation");
    requirePayloadArtifact(event, "requestArtifactId", artifactIds, issues, "source_query_missing_request_artifact");
  }
  if (event.type === "source.results") {
    requirePayloadArtifact(event, "artifactId", artifactIds, issues, "source_results_missing_artifact");
  }
  if (event.type === "problem.classification.reviewed") {
    requirePayloadArtifact(event, "artifactId", artifactIds, issues, "problem_classification_missing_artifact");
    const heuristic = recordValue(event.payload.heuristic);
    const classification = recordValue(event.payload.classification);
    const override = recordValue(event.payload.override);
    if (
      heuristic.class === "open_problem" &&
      override.requestedClass === "standard_problem" &&
      (override.accepted === true || classification.class !== "open_problem")
    ) {
      issues.push({
        severity: "error",
        code: "problem_classification_override_relaxed_open_problem",
        message: `Problem classification review ${event.id} silently relaxed open-problem verifier requirements.`
      });
    }
  }
  if (event.type === "verifier.started" && event.payload.verifier === "lean4") {
    requirePayloadArtifact(event, "inputArtifactId", artifactIds, issues, "verifier_missing_input_artifact");
  }
  if (event.type === "verifier.completed" && event.artifactIds.length === 0) {
    issues.push({
      severity: "error",
      code: "verifier_missing_artifacts",
      message: `Verifier completion event ${event.id} does not reference persisted verifier artifacts.`
    });
  }
  if (event.type === "verifier.completed" && event.payload.verifier === "lean4") {
    requirePayloadString(event, "externalOperationId", issues, "verifier_missing_external_operation");
    requirePayloadArtifact(event, "inputArtifactId", artifactIds, issues, "verifier_missing_input_artifact");
    requirePayloadArtifact(event, "resultArtifactId", artifactIds, issues, "verifier_missing_result_artifact");
    requirePayloadArtifact(event, "stdoutArtifactId", artifactIds, issues, "verifier_missing_stdout_artifact");
    requirePayloadArtifact(event, "stderrArtifactId", artifactIds, issues, "verifier_missing_stderr_artifact");
  }
  if (event.type === "worker.completed" && event.artifactIds.length === 0 && !event.payload.jobId) {
    issues.push({
      severity: "warning",
      code: "worker_completion_without_artifact_or_job",
      message: `Worker completion event ${event.id} does not reference a worker job or persisted artifacts.`
    });
  }
}

function auditAiTraceCompleteness(
  runStatus: string,
  events: ReturnType<Ledger["listEvents"]>,
  issues: AuditIssue[]
): void {
  const terminalRun = runStatus === "goal_met" ||
    runStatus === "budget_exhausted" ||
    runStatus === "needs_human_review" ||
    runStatus === "cancelled" ||
    runStatus === "failed";
  const traces = new Map<string, ReturnType<Ledger["listEvents"]>>();
  for (const event of events) {
    if (!event.type.startsWith("ai.call.")) continue;
    const key = stringValue(event.payload.externalOperationId) ??
      stringValue(event.payload.callId) ??
      `event:${event.id}`;
    traces.set(key, [...(traces.get(key) ?? []), event]);
  }
  for (const [traceId, traceEvents] of traces) {
    const hasStarted = traceEvents.some((event) => event.type === "ai.call.started");
    const hasTerminal = traceEvents.some((event) =>
      event.type === "ai.call.completed" ||
      event.type === "ai.call.failed" ||
      event.type === "ai.call.aborted"
    );
    const hasStepOrStream = traceEvents.some((event) => event.type === "ai.call.step" || event.type === "ai.call.stream_chunk");
    const hasTranscript = traceEvents.some((event) => event.type === "ai.call.transcript.persisted");
    if (!hasStarted) {
      issues.push({
        severity: "error",
        code: "ai_trace_missing_started_event",
        message: `AI trace ${traceId} has AI action events but no ai.call.started event.`
      });
    }
    if ((hasTerminal || hasStepOrStream) && !hasTranscript) {
      issues.push({
        severity: "error",
        code: "ai_trace_missing_transcript_event",
        message: `AI trace ${traceId} has terminal or tool-step events but no ai.call.transcript.persisted event.`
      });
    }
    if (terminalRun && hasStarted && !hasTerminal) {
      issues.push({
        severity: "error",
        code: "ai_trace_missing_terminal_event",
        message: `AI trace ${traceId} belongs to a terminal run but has no completed, failed, or aborted AI event.`
      });
    }
  }
}

function auditSourceCitationDiscipline(
  events: ReturnType<Ledger["listEvents"]>,
  artifactIds: Set<string>,
  issues: AuditIssue[]
): void {
  for (const event of events) {
    if (event.type === "source.results") {
      auditSourceResultsMetadata(event, artifactIds, issues);
    }
    if (event.type === "source.citations.reviewed") {
      if (event.payload.ok !== true || event.payload.requiresAdversarialReview === true) {
        issues.push({
          severity: "error",
          code: "source_citation_grounding_failed",
          message: `Source citation review ${event.id} contains ungrounded or hallucinated citations.`
        });
      }
      auditCitationSupportBoundary(event, issues);
    }
    if (event.type === "source.retrieval.evaluated") {
      const failures = stringArray(event.payload.failures);
      if (failures.includes("search_outage") && event.payload.canPromoteResearchBackedClaims === true) {
        issues.push({
          severity: "error",
          code: "source_outage_promoted_claims",
          message: `Source retrieval outage ${event.id} still permits research-backed claim promotion.`
        });
      }
    }
    auditSourceDerivedClaims(event, artifactIds, issues);
  }
}

function auditCitationSupportBoundary(
  event: ReturnType<Ledger["listEvents"]>[number],
  issues: AuditIssue[]
): void {
  const policy = recordValue(event.payload.supportPolicy);
  const policyOk = policy.sourceExistenceIsNotMathematicalSupport === true &&
    policy.exactArxivVersionRequired === true &&
    policy.snapshotHashRequired === true &&
    policy.quotedSpanRequired === true &&
    policy.independentEntailmentRequired === true &&
    policy.licenseAndProvenanceRequired === true &&
    policy.canSupportSolvedClaim === false;
  if (!policyOk) {
    issues.push({
      severity: "error",
      code: "source_citation_support_policy_missing",
      message: `Source citation review ${event.id} does not declare that source existence is not mathematical proof support.`
    });
  }

  for (const finding of recordArray(event.payload.findings)) {
    if (finding.status !== "grounded") continue;
    const review = recordValue(finding.supportReview);
    const entailment = recordValue(review.entailment);
    const reviewOk = review.sourceExists === true &&
      review.exactArxivVersion === true &&
      review.snapshotHashMatches === true &&
      review.quotedSpanLocated === true &&
      stringValue(review.quotedSpanHash) !== undefined &&
      stringValue(review.quotedSpan) !== undefined &&
      review.licenseAndProvenancePresent === true &&
      review.withdrawn === false &&
      entailment.independent === true &&
      entailment.status === "entailed" &&
      review.canSupportMathematicalClaim === true &&
      review.canSupportSolvedClaim === false &&
      review.proofSupport === "not_proof_support";
    if (!reviewOk) {
      issues.push({
        severity: "error",
        code: "source_citation_support_review_missing",
        message: `Grounded citation in review ${event.id} lacks exact-version, snapshot, quoted-span, provenance, and independent entailment support.`
      });
    }
  }
}

function auditSourceResultsMetadata(
  event: ReturnType<Ledger["listEvents"]>[number],
  artifactIds: Set<string>,
  issues: AuditIssue[]
): void {
  requirePayloadArtifact(event, "artifactId", artifactIds, issues, "source_results_missing_artifact");
  const count = numberValue(event.payload.count) ?? 0;
  if (event.payload.provider === "mathlib") {
    auditMathlibSourceResultsMetadata(event, count, issues);
    return;
  }
  const sourceRecords = recordArray(event.payload.sourceRecords);
  if (count === 0) {
    const retrieval = recordValue(event.payload.retrievalEvaluation);
    const incomplete = retrieval.incompleteResearch === true ||
      stringArray(retrieval.failures).includes("search_outage") ||
      recordValue(retrieval.outage).degradedTo === "partial_inconclusive";
    if (!incomplete && event.payload.networkMode !== "offline") {
      issues.push({
        severity: "warning",
        code: "source_results_empty_without_inconclusive_marker",
        message: `Source result event ${event.id} has no records and no partial/inconclusive marker.`
      });
    }
    return;
  }
  if (sourceRecords.length === 0) {
    issues.push({
      severity: "error",
      code: "source_records_missing",
      message: `Source result event ${event.id} fetched ${count} sources but persisted no sourceRecords.`
    });
    return;
  }
  auditSourceLicenseManifest(event, sourceRecords, issues);
  for (const [index, record] of sourceRecords.entries()) {
    const missing = [
      stringValue(record.query) || stringValue(event.payload.query) ? undefined : "query",
      stringValue(record.sourceId) ? undefined : "sourceId",
      stringValue(record.canonicalId) ? undefined : "canonicalId",
      numberValue(record.version) !== undefined ? undefined : "version",
      stringValue(record.title) ? undefined : "title",
      stringArray(record.authors).length > 0 ? undefined : "authors",
      stringValue(record.updated) ? undefined : "updated",
      stringValue(record.retrievedAt) ? undefined : "retrievedAt",
      numberValue(record.ranking) !== undefined ? undefined : "ranking",
      stringValue(record.url) ? undefined : "url",
      stringValue(record.contentHash) ? undefined : "contentHash",
      stringValue(record.abstractHash) || stringValue(record.snapshotHash) ? undefined : "abstractHash_or_snapshotHash",
      stringArray(record.extractedClaims).length > 0 ? undefined : "extractedClaims"
    ].filter((item): item is string => Boolean(item));
    if (missing.length > 0) {
      issues.push({
        severity: "error",
        code: "source_record_incomplete_metadata",
        message: `Source record ${index + 1} in event ${event.id} is missing required metadata: ${missing.join(", ")}.`
      });
    }
    const expectedRanking = index + 1;
    if (numberValue(record.ranking) !== undefined && numberValue(record.ranking) !== expectedRanking) {
      issues.push({
        severity: "error",
        code: "source_record_ranking_mismatch",
        message: `Source record ${stringValue(record.sourceId) ?? index + 1} has ranking ${record.ranking}, expected ${expectedRanking}.`
      });
    }
  }
}

function auditMathlibSourceResultsMetadata(
  event: ReturnType<Ledger["listEvents"]>[number],
  count: number,
  issues: AuditIssue[]
): void {
  const retrievedLemmas = recordArray(event.payload.retrievedLemmas);
  const missing = [
    stringValue(event.payload.indexVersion) ? undefined : "indexVersion",
    stringValue(event.payload.indexHash) ? undefined : "indexHash",
    stringValue(event.payload.mathlibRevision) ? undefined : "mathlibRevision",
    stringValue(event.payload.lakeManifestHash) ? undefined : "lakeManifestHash"
  ].filter((item): item is string => Boolean(item));
  if (missing.length > 0) {
    issues.push({
      severity: "error",
      code: "mathlib_index_provenance_missing",
      message: `Mathlib source result event ${event.id} is missing pinned index provenance: ${missing.join(", ")}.`
    });
  }
  if (count > 0 && retrievedLemmas.length === 0) {
    issues.push({
      severity: "error",
      code: "mathlib_retrieved_lemmas_missing",
      message: `Mathlib source result event ${event.id} retrieved ${count} lemmas but persisted no retrievedLemmas metadata.`
    });
    return;
  }
  if (retrievedLemmas.length !== count) {
    issues.push({
      severity: "error",
      code: "mathlib_retrieved_lemma_count_mismatch",
      message: `Mathlib source result event ${event.id} count ${count} does not match ${retrievedLemmas.length} retrieved lemma records.`
    });
  }
  for (const [index, lemma] of retrievedLemmas.entries()) {
    const provenance = recordValue(lemma.provenance);
    const promptSummary = recordValue(lemma.promptSummary);
    const lemmaMissing = [
      stringValue(lemma.name) ? undefined : "name",
      stringValue(lemma.module) ? undefined : "module",
      stringValue(lemma.statementHash) ? undefined : "statementHash",
      stringValue(lemma.trustGrade) ? undefined : "trustGrade",
      stringValue(provenance.indexVersion) ? undefined : "provenance.indexVersion",
      stringValue(provenance.indexHash) ? undefined : "provenance.indexHash",
      promptSummary.proofSupport === false ? undefined : "promptSummary.proofSupport=false"
    ].filter((item): item is string => Boolean(item));
    if (lemmaMissing.length > 0) {
      issues.push({
        severity: "error",
        code: "mathlib_lemma_provenance_missing",
        message: `Mathlib source result event ${event.id} lemma ${index} is missing replayable theorem metadata: ${lemmaMissing.join(", ")}.`
      });
    }
  }
}

function auditSourceLicenseManifest(
  event: ReturnType<Ledger["listEvents"]>[number],
  sourceRecords: Array<Record<string, unknown>>,
  issues: AuditIssue[]
): void {
  const manifest = recordValue(event.payload.citationLicenseManifest);
  if (Object.keys(manifest).length === 0) {
    issues.push({
      severity: "error",
      code: "source_license_manifest_missing",
      message: `Source result event ${event.id} is missing the citation license and redistribution manifest.`
    });
    return;
  }
  if (manifest.format !== "matematica.citation-license-manifest" || manifest.version !== 1) {
    issues.push({
      severity: "error",
      code: "source_license_manifest_invalid",
      message: `Source result event ${event.id} has an unrecognized citation license manifest format.`
    });
  }
  const entries = recordArray(manifest.entries);
  if (entries.length !== sourceRecords.length) {
    issues.push({
      severity: "error",
      code: "source_license_manifest_entry_mismatch",
      message: `Source result event ${event.id} has ${sourceRecords.length} source records but ${entries.length} license manifest entries.`
    });
  }
  const summary = recordValue(manifest.summary);
  if (summary.pdfOrSourceContentExported === true) {
    issues.push({
      severity: "error",
      code: "source_pdf_or_source_exported_without_license",
      message: `Source result event ${event.id} claims arXiv PDF/source content was exported.`
    });
  }
  if (summary.proofSupportPolicy !== "citation_metadata_is_not_proof_support") {
    issues.push({
      severity: "error",
      code: "source_license_manifest_missing_proof_boundary",
      message: `Source result event ${event.id} does not distinguish citation metadata from proof support.`
    });
  }

  const entriesByCanonicalId = new Map(entries.map((entry) => [stringValue(entry.canonicalId), entry]));
  const staleBefore = stringValue(event.payload.staleBefore);
  for (const record of sourceRecords) {
    const canonicalId = stringValue(record.canonicalId);
    const entry = entriesByCanonicalId.get(canonicalId);
    if (!entry) {
      issues.push({
        severity: "error",
        code: "source_license_manifest_missing_entry",
        message: `Source record ${canonicalId ?? "unknown"} in event ${event.id} has no license manifest entry.`
      });
      continue;
    }
    const missing = [
      stringValue(entry.sourceId) ? undefined : "sourceId",
      stringValue(entry.canonicalId) ? undefined : "canonicalId",
      stringValue(entry.retrievalTimestamp) ? undefined : "retrievalTimestamp",
      stringValue(entry.contentHash) ? undefined : "contentHash",
      stringValue(entry.citationFormat) ? undefined : "citationFormat",
      Object.keys(recordValue(entry.license)).length > 0 ? undefined : "license",
      Object.keys(recordValue(entry.staleStatus)).length > 0 ? undefined : "staleStatus",
      Object.keys(recordValue(entry.copiedTextPolicy)).length > 0 ? undefined : "copiedTextPolicy",
      Object.keys(recordValue(entry.verifiedSupport)).length > 0 ? undefined : "verifiedSupport",
      stringValue(entry.manifestHash) ? undefined : "manifestHash"
    ].filter((item): item is string => Boolean(item));
    if (missing.length > 0) {
      issues.push({
        severity: "error",
        code: "source_license_manifest_entry_incomplete",
        message: `Source license manifest entry ${canonicalId ?? "unknown"} in event ${event.id} is missing: ${missing.join(", ")}.`
      });
    }
    if (entry.contentHash !== record.contentHash) {
      issues.push({
        severity: "error",
        code: "source_license_manifest_hash_mismatch",
        message: `Source license manifest entry ${canonicalId ?? "unknown"} in event ${event.id} does not match the source record content hash.`
      });
    }
    const copiedTextPolicy = recordValue(entry.copiedTextPolicy);
    if (
      copiedTextPolicy.pdfExported !== false ||
      copiedTextPolicy.sourceExported !== false ||
      copiedTextPolicy.fullTextExported !== false
    ) {
      issues.push({
        severity: "error",
        code: "source_pdf_or_source_exported_without_license",
        message: `Source license manifest entry ${canonicalId ?? "unknown"} in event ${event.id} permits exported arXiv PDF/source/fulltext content.`
      });
    }
    const verifiedSupport = recordValue(entry.verifiedSupport);
    if (verifiedSupport.proofSupport !== "not_proof_support" || verifiedSupport.canSupportSolvedClaim !== false) {
      issues.push({
        severity: "error",
        code: "source_license_manifest_missing_proof_boundary",
        message: `Source license manifest entry ${canonicalId ?? "unknown"} in event ${event.id} blurs citation metadata with proof support.`
      });
    }
    const staleStatus = recordValue(entry.staleStatus);
    const updated = stringValue(record.updated);
    if (staleBefore && updated && updated < staleBefore && staleStatus.status !== "stale") {
      issues.push({
        severity: "error",
        code: "source_stale_status_not_flagged",
        message: `Source license manifest entry ${canonicalId ?? "unknown"} in event ${event.id} failed to flag a stale source.`
      });
    }
  }
  const hostileFlags = stringArray(event.payload.hostileFlags);
  if (hostileFlags.length > 0 && !entries.some((entry) => recordValue(entry.hostileSource).flagged === true)) {
    issues.push({
      severity: "error",
      code: "source_hostile_status_not_flagged",
      message: `Source result event ${event.id} has hostile source flags but no flagged license manifest entry.`
    });
  }
}

function auditSourceDerivedClaims(
  event: ReturnType<Ledger["listEvents"]>[number],
  artifactIds: Set<string>,
  issues: AuditIssue[]
): void {
  const claims = sourceDerivedClaimRecords(event.payload);
  for (const claim of claims) {
    const citationArtifactIds = stringArray(claim.citationArtifactIds).concat(stringArray(claim.sourceArtifactIds));
    const sourceIds = stringArray(claim.sourceIds).concat(stringArray(claim.citedSourceIds));
    if (citationArtifactIds.length === 0 || citationArtifactIds.some((artifactId) => !artifactIds.has(artifactId))) {
      issues.push({
        severity: "error",
        code: "source_derived_claim_missing_citation_artifacts",
        message: `Source-derived claim in event ${event.id} lacks persisted citation/source artifact ids.`
      });
    }
    if (sourceIds.length === 0 && stringArray(claim.citations).length === 0) {
      issues.push({
        severity: "error",
        code: "source_derived_claim_missing_source_ids",
        message: `Source-derived claim in event ${event.id} lacks cited source identifiers.`
      });
    }
    if (claim.noveltyClaim === true || claim.novel === true) {
      const comparisons = stringArray(claim.comparisonSourceIds).concat(stringArray(claim.comparedAgainstSourceIds));
      if (comparisons.length === 0) {
        issues.push({
          severity: "error",
          code: "novelty_claim_missing_source_comparison",
          message: `Novelty claim in event ${event.id} lacks explicit comparison against gathered sources.`
        });
      }
    }
  }
}

function sourceDerivedClaimRecords(payload: Record<string, unknown>): Record<string, unknown>[] {
  const records = recordArray(payload.sourceDerivedClaims);
  const claim = recordValue(payload.claim);
  if (claim.sourceDerived === true || stringValue(claim.sourceSupport) === "literature") {
    records.push(claim);
  }
  return records;
}

function auditProviderMatrixPersistence(
  events: ReturnType<Ledger["listEvents"]>,
  artifacts: ReturnType<Ledger["listArtifacts"]>,
  artifactIds: Set<string>,
  issues: AuditIssue[]
): void {
  const providerCalls = events.filter((event) => event.type === "ai.call.started" || event.type === "ai.call.completed");
  if (providerCalls.length === 0) return;

  const pinEvents = events.filter((event) => event.type === "provider.matrix.pinned");
  if (pinEvents.length === 0) {
    issues.push({
      severity: "error",
      code: "provider_matrix_missing",
      message: "Run has provider calls but no pinned provider capability matrix."
    });
    return;
  }

  const artifactById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  for (const pin of pinEvents) {
    const artifactId = stringValue(pin.payload.artifactId);
    if (!artifactId || !artifactIds.has(artifactId)) {
      issues.push({
        severity: "error",
        code: "provider_matrix_missing_artifact",
        message: `Provider matrix pin event ${pin.id} does not reference a persisted provider.matrix artifact.`
      });
      continue;
    }
    if (!pin.artifactIds.includes(artifactId)) {
      issues.push({
        severity: "error",
        code: "provider_matrix_artifact_not_linked",
        message: `Provider matrix pin event ${pin.id} payload artifact ${artifactId} is not linked in event artifactIds.`
      });
    }
    const artifact = artifactById.get(artifactId);
    if (!artifact) continue;
    try {
      const snapshot = JSON.parse(readArtifactText(artifact)) as Record<string, unknown>;
      if (snapshot.matrixHash !== pin.payload.matrixHash) {
        issues.push({
          severity: "error",
          code: "provider_matrix_hash_mismatch",
          message: `Provider matrix artifact ${artifactId} hash field diverges from pin event ${pin.id}.`
        });
      }
      if (!Array.isArray(snapshot.providers) || snapshot.providers.length === 0) {
        issues.push({
          severity: "error",
          code: "provider_matrix_empty",
          message: `Provider matrix artifact ${artifactId} has no provider records.`
        });
      }
      if (stableHash(providerMatrixComparable(snapshot)) !== pin.payload.matrixHash) {
        issues.push({
          severity: "error",
          code: "provider_matrix_content_hash_mismatch",
          message: `Provider matrix artifact ${artifactId} content does not recompute to pinned matrix hash.`
        });
      }
    } catch (error) {
      issues.push({
        severity: "error",
        code: "provider_matrix_artifact_invalid",
        message: `Provider matrix artifact ${artifactId} is not valid JSON: ${error instanceof Error ? error.message : String(error)}.`
      });
    }
  }

  const latestPin = pinEvents.at(-1);
  const providerRecords = Array.isArray(latestPin?.payload.providers) ? latestPin.payload.providers : [];
  const providerAllowlist = stringArray(latestPin?.payload.providerAllowlist);
  for (const call of providerCalls) {
    const provider = stringValue(call.payload.provider);
    const modelId = stringValue(call.payload.modelId);
    if (!provider || !modelId) continue;
    if (providerAllowlist.length > 0 && !providerAllowlist.includes(provider)) {
      issues.push({
        severity: "error",
        code: "provider_call_not_allowlisted",
        message: `Provider call ${call.id} uses ${provider}/${modelId}, which is not in the pinned provider allowlist.`
      });
    }
    const route = providerRecords.find((record) =>
      Boolean(record) &&
      typeof record === "object" &&
      (record as Record<string, unknown>).provider === provider &&
      (record as Record<string, unknown>).requestedModel === modelId
    );
    if (!route) {
      issues.push({
        severity: "error",
        code: "provider_call_not_in_pinned_matrix",
        message: `Provider call ${call.id} uses ${provider}/${modelId}, which is absent from the pinned provider matrix.`
      });
    }
    if (provider === "openrouter" && call.type === "ai.call.completed") {
      const capabilities = call.payload.capabilities && typeof call.payload.capabilities === "object"
        ? call.payload.capabilities as Record<string, unknown>
        : {};
      const actual = stringValue(capabilities.actualUpstreamModel);
      if (!actual) {
        issues.push({
          severity: "error",
          code: "openrouter_upstream_provenance_missing",
          message: `OpenRouter completion ${call.id} is missing actual upstream model provenance.`
        });
      } else if (actual !== modelId) {
        issues.push({
          severity: "error",
          code: "openrouter_silent_model_substitution",
          message: `OpenRouter completion ${call.id} requested ${modelId} but recorded upstream ${actual}.`
        });
      }
    }
  }
}

function providerMatrixComparable(snapshot: Record<string, unknown>): Record<string, unknown> {
  return {
    format: snapshot.format,
    version: snapshot.version,
    routingPolicyVersion: snapshot.routingPolicyVersion,
    source: snapshot.source,
    providerAllowlist: snapshot.providerAllowlist,
    requiredCapabilities: snapshot.requiredCapabilities,
    fallbackPolicy: snapshot.fallbackPolicy,
    providers: snapshot.providers,
    freshnessSnapshots: snapshot.freshnessSnapshots
  };
}

function auditExternalOperationPersistence(
  events: ReturnType<Ledger["listEvents"]>,
  artifactIds: Set<string>,
  operations: ReturnType<Ledger["listExternalOperations"]>,
  issues: AuditIssue[]
): void {
  const eventsByOperationId = new Map<string, ReturnType<Ledger["listEvents"]>>();
  const operationsById = new Map(operations.map((operation) => [operation.id, operation]));
  const eventsByReservationId = new Map<string, ReturnType<Ledger["listEvents"]>>();
  for (const event of events) {
    const operationId = stringValue(event.payload.externalOperationId) ?? stringValue(event.payload.operationId);
    if (operationId) {
      const existing = eventsByOperationId.get(operationId) ?? [];
      existing.push(event);
      eventsByOperationId.set(operationId, existing);
    }
    const reservationId = stringValue(event.payload.reservationId);
    if (reservationId) {
      const existing = eventsByReservationId.get(reservationId) ?? [];
      existing.push(event);
      eventsByReservationId.set(reservationId, existing);
    }
  }

  for (const event of events) {
    const operationId = externalOperationIdForEvent(event);
    if (!operationId) continue;
    const operation = operationsById.get(operationId);
    if (!operation) {
      issues.push({
        severity: "error",
        code: "external_effect_missing_operation_row",
        message: `External effect event ${event.id} (${event.type}) references external operation ${operationId} but no external operation row exists.`
      });
      continue;
    }
    const reservationId = stringValue(event.payload.reservationId);
    if (reservationId && reservationId !== operation.reservationId) {
      issues.push({
        severity: "error",
        code: "external_effect_reservation_mismatch",
        message: `External effect event ${event.id} (${event.type}) references reservation ${reservationId} but operation ${operationId} is bound to ${operation.reservationId}.`
      });
    }
  }

  for (const operation of operations) {
    const operationEvents = eventsByOperationId.get(operation.id) ?? [];
    const reservationEvents = eventsByReservationId.get(operation.reservationId) ?? [];
    const reservedEvents = reservationEvents.filter((event) => event.type === "budget.reserved");
    const settlementEvents = reservationEvents.filter((event) => event.type === "budget.debited" || event.type === "budget.released");
    if (reservedEvents.length !== 1) {
      issues.push({
        severity: "error",
        code: "external_operation_budget_reservation_cardinality",
        message: `External operation ${operation.id} has ${reservedEvents.length} budget.reserved events for reservation ${operation.reservationId}; exactly one is required.`
      });
    }
    if ((operation.status === "succeeded" || operation.status === "failed" || operation.status === "released") && settlementEvents.length !== 1) {
      issues.push({
        severity: "error",
        code: "external_operation_budget_settlement_cardinality",
        message: `External operation ${operation.id} is ${operation.status} with ${settlementEvents.length} budget settlement events for reservation ${operation.reservationId}; exactly one debit or release is required.`
      });
    }
    if ((operation.status === "reserved" || operation.status === "running" || operation.status === "unknown_remote_outcome" || operation.status === "dead_lettered") && settlementEvents.length > 0) {
      issues.push({
        severity: "error",
        code: "external_operation_unsettled_status_has_settlement",
        message: `External operation ${operation.id} is ${operation.status} but reservation ${operation.reservationId} already has a budget settlement event.`
      });
    }
    if (!operationEvents.some((event) => event.type === "external.operation.reserved")) {
      issues.push({
        severity: "error",
        code: "external_operation_missing_reserved_event",
        message: `External operation ${operation.id} has no external.operation.reserved ledger event.`
      });
    }
    if ((operation.status === "running" || operation.status === "succeeded" || operation.status === "failed" || operation.status === "unknown_remote_outcome" || operation.status === "dead_lettered" || operation.status === "released") &&
      !operationEvents.some((event) => event.type === "external.operation.started")) {
      issues.push({
        severity: "error",
        code: "external_operation_missing_started_event",
        message: `External operation ${operation.id} is ${operation.status} but has no external.operation.started ledger event.`
      });
    }
    if (operation.status === "succeeded" && !operationEvents.some((event) => event.type === "external.operation.completed")) {
      issues.push({
        severity: "error",
        code: "external_operation_missing_completed_event",
        message: `External operation ${operation.id} succeeded without an external.operation.completed ledger event.`
      });
    }
    if (operation.status === "failed" && !operationEvents.some((event) => event.type === "external.operation.failed")) {
      issues.push({
        severity: "error",
        code: "external_operation_missing_failed_event",
        message: `External operation ${operation.id} failed without an external.operation.failed ledger event.`
      });
    }
    if (operation.status === "unknown_remote_outcome" && !operationEvents.some((event) => event.type === "external.operation.unknown")) {
      issues.push({
        severity: "error",
        code: "external_operation_missing_unknown_event",
        message: `External operation ${operation.id} has unknown remote outcome without an external.operation.unknown ledger event.`
      });
    }
    if (operation.status === "dead_lettered" && !operationEvents.some((event) => event.type === "external.operation.dead_lettered")) {
      issues.push({
        severity: "error",
        code: "external_operation_missing_dead_lettered_event",
        message: `External operation ${operation.id} is dead-lettered without an external.operation.dead_lettered ledger event.`
      });
    }
    if (operation.status === "released" && !operationEvents.some((event) => event.type === "external.operation.released")) {
      issues.push({
        severity: "error",
        code: "external_operation_missing_released_event",
        message: `External operation ${operation.id} released without an external.operation.released ledger event.`
      });
    }
    if (operation.requestArtifactId && !artifactIds.has(operation.requestArtifactId)) {
      issues.push({
        severity: "error",
        code: "external_operation_missing_request_artifact",
        message: `External operation ${operation.id} references missing request artifact ${operation.requestArtifactId}.`
      });
    }
    if (operation.status === "succeeded") {
      if (!operation.responseArtifactId || !artifactIds.has(operation.responseArtifactId)) {
        issues.push({
          severity: "error",
          code: "external_operation_missing_response_artifact",
          message: `External operation ${operation.id} succeeded without a persisted response artifact.`
        });
      }
      if (!operationEvents.some((event) =>
        (
          event.type === "ai.call.completed" ||
          event.type === "source.results" ||
          event.type === "verifier.completed" ||
          event.type === "worker.tool.completed"
        ) &&
        (event.artifactIds.includes(operation.responseArtifactId ?? "") || event.payload.responseArtifactId === operation.responseArtifactId || event.payload.resultArtifactId === operation.responseArtifactId || event.payload.artifactId === operation.responseArtifactId)
      )) {
        issues.push({
          severity: "error",
          code: "external_operation_missing_domain_completion_event",
          message: `External operation ${operation.id} has no domain completion event linked to its response artifact.`
        });
      }
    }
  }
  auditRetryLineage(events, operations, issues);
}

function externalOperationIdForEvent(event: ReturnType<Ledger["listEvents"]>[number]): string | undefined {
  const operationId = stringValue(event.payload.externalOperationId) ?? stringValue(event.payload.operationId);
  if (!operationId) return undefined;
  if (event.type.startsWith("external.operation.")) return operationId;
  if (event.type.startsWith("ai.call.")) return operationId;
  if (event.type === "provider.retry.scheduled") return operationId;
  if (event.type === "source.query") return operationId;
  if (event.type === "source.results" && event.payload.externalOperationId) return operationId;
  if (event.type === "verifier.started" && event.payload.verifier === "lean4") return operationId;
  if (event.type === "verifier.completed" && event.payload.verifier === "lean4") return operationId;
  if (event.type.startsWith("worker.tool.")) return operationId;
  return undefined;
}

function auditRetryLineage(
  events: ReturnType<Ledger["listEvents"]>,
  operations: ReturnType<Ledger["listExternalOperations"]>,
  issues: AuditIssue[]
): void {
  const operationsById = new Map(operations.map((operation) => [operation.id, operation]));
  for (const operation of operations) {
    if (!operation.retryOfOperationId) continue;
    const parent = operationsById.get(operation.retryOfOperationId);
    if (!parent) {
      issues.push({
        severity: "error",
        code: "retry_lineage_missing_parent_operation",
        message: `Retry operation ${operation.id} references missing parent operation ${operation.retryOfOperationId}.`
      });
      continue;
    }
    if (parent.runId !== operation.runId) {
      issues.push({
        severity: "error",
        code: "retry_lineage_cross_run_parent",
        message: `Retry operation ${operation.id} points at parent operation ${parent.id} from another run.`
      });
    }
    if (operation.provider !== parent.provider) {
      issues.push({
        severity: "error",
        code: "retry_lineage_provider_mismatch",
        message: `Retry operation ${operation.id} provider ${operation.provider ?? "unknown"} does not match parent ${parent.id} provider ${parent.provider ?? "unknown"}.`
      });
    }
    if (operation.attempt <= parent.attempt) {
      issues.push({
        severity: "error",
        code: "retry_lineage_attempt_not_monotonic",
        message: `Retry operation ${operation.id} attempt ${operation.attempt} is not greater than parent ${parent.id} attempt ${parent.attempt}.`
      });
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (operationId: string): void => {
    if (visited.has(operationId)) return;
    if (visiting.has(operationId)) {
      issues.push({
        severity: "error",
        code: "retry_lineage_cycle",
        message: `Retry lineage contains a cycle at operation ${operationId}.`
      });
      return;
    }
    visiting.add(operationId);
    const parentId = operationsById.get(operationId)?.retryOfOperationId;
    if (parentId && operationsById.has(parentId)) visit(parentId);
    visiting.delete(operationId);
    visited.add(operationId);
  };
  for (const operation of operations) visit(operation.id);

  for (const event of events.filter((item) => item.type === "provider.retry.scheduled")) {
    const parentId = stringValue(event.payload.externalOperationId);
    const retryAttemptId = stringValue(event.payload.retryAttemptOperationId);
    const retryReservationId = stringValue(event.payload.retryReservationId);
    const retryRequestArtifactId = stringValue(event.payload.retryRequestArtifactId);
    const failedAttempt = numberValue(event.payload.failedAttempt);
    const nextAttempt = numberValue(event.payload.nextAttempt);
    const parent = parentId ? operationsById.get(parentId) : undefined;
    const retryAttempt = retryAttemptId ? operationsById.get(retryAttemptId) : undefined;
    if (!parent || !retryAttempt) continue;
    if (retryAttempt.retryOfOperationId !== parent.id) {
      issues.push({
        severity: "error",
        code: "retry_lineage_parent_mismatch",
        message: `Provider retry event ${event.id} links parent ${parent.id} to retry operation ${retryAttempt.id}, but the retry operation points to ${retryAttempt.retryOfOperationId ?? "none"}.`
      });
    }
    if (retryReservationId !== retryAttempt.reservationId) {
      issues.push({
        severity: "error",
        code: "retry_lineage_reservation_mismatch",
        message: `Provider retry event ${event.id} reservation ${retryReservationId ?? "none"} does not match retry operation ${retryAttempt.id} reservation ${retryAttempt.reservationId}.`
      });
    }
    if (retryRequestArtifactId !== retryAttempt.requestArtifactId) {
      issues.push({
        severity: "error",
        code: "retry_lineage_request_artifact_mismatch",
        message: `Provider retry event ${event.id} request artifact ${retryRequestArtifactId ?? "none"} does not match retry operation ${retryAttempt.id}.`
      });
    }
    if (failedAttempt !== undefined && failedAttempt !== parent.attempt) {
      issues.push({
        severity: "error",
        code: "retry_lineage_failed_attempt_mismatch",
        message: `Provider retry event ${event.id} failedAttempt ${failedAttempt} does not match parent operation ${parent.id} attempt ${parent.attempt}.`
      });
    }
    if (nextAttempt !== undefined && nextAttempt !== retryAttempt.attempt) {
      issues.push({
        severity: "error",
        code: "retry_lineage_next_attempt_mismatch",
        message: `Provider retry event ${event.id} nextAttempt ${nextAttempt} does not match retry operation ${retryAttempt.id} attempt ${retryAttempt.attempt}.`
      });
    }
  }
}

function buildRetryLineage(events: ReturnType<Ledger["listEvents"]>): AuditResult["retryLineage"] {
  return events
    .filter((event) => event.type === "provider.retry.scheduled")
    .map((event) => ({
      parentOperationId: stringValue(event.payload.externalOperationId) ?? "",
      retryAttemptOperationId: stringValue(event.payload.retryAttemptOperationId) ?? "",
      failedAttempt: numberValue(event.payload.failedAttempt) ?? 0,
      nextAttempt: numberValue(event.payload.nextAttempt) ?? 0,
      retryReservationId: stringValue(event.payload.retryReservationId)
    }));
}

function auditWorkerPersistence(
  events: ReturnType<Ledger["listEvents"]>,
  jobs: ReturnType<Ledger["listWorkerJobs"]>,
  issues: AuditIssue[]
): void {
  for (const job of jobs) {
    const jobEvents = events.filter((event) => event.payload.jobId === job.id);
    if (job.kind !== "safety.preflight.cancellation" && !jobEvents.some((event) => event.type === "worker.enqueued")) {
      issues.push({
        severity: "error",
        code: "worker_job_missing_enqueued_event",
        message: `Worker job ${job.id} has no worker.enqueued ledger event.`
      });
    }
    if ((job.status === "leased" || job.status === "running" || job.status === "committed" || job.status === "failed_retryable" || job.status === "failed_terminal") &&
      !jobEvents.some((event) => event.type === "worker.leased")) {
      issues.push({
        severity: "error",
        code: "worker_job_missing_lease_event",
        message: `Worker job ${job.id} reached ${job.status} without a worker.leased ledger event.`
      });
    }
    if (job.status === "running" && !jobEvents.some((event) => event.type === "worker.started")) {
      issues.push({
        severity: "error",
        code: "worker_job_missing_started_event",
        message: `Worker job ${job.id} is running without a worker.started ledger event.`
      });
    }
    if (job.status === "committed") {
      if (!jobEvents.some((event) => event.type === "worker.committed")) {
        issues.push({
          severity: "error",
          code: "worker_job_missing_committed_event",
          message: `Worker job ${job.id} is committed without a worker.committed ledger event.`
        });
      }
      if (!jobEvents.some((event) => event.type === "worker.completed")) {
        issues.push({
          severity: "error",
          code: "worker_job_missing_completed_event",
          message: `Worker job ${job.id} is committed without a worker.completed ledger event.`
        });
      }
    }
    if ((job.status === "failed_retryable" || job.status === "failed_terminal") &&
      !jobEvents.some((event) => event.type === "worker.failed" || event.type === "worker.reconciled")) {
      issues.push({
        severity: "error",
        code: "worker_job_missing_failure_event",
        message: `Worker job ${job.id} failed without a worker.failed or worker.reconciled ledger event.`
      });
    }
    if (job.status === "cancelled" && !jobEvents.some((event) => event.type === "worker.cancelled")) {
      issues.push({
        severity: "error",
        code: "worker_job_missing_cancelled_event",
        message: `Worker job ${job.id} is cancelled without a worker.cancelled ledger event.`
      });
    }
  }
}

function requirePayloadArtifact(
  event: ReturnType<Ledger["listEvents"]>[number],
  payloadKey: string,
  artifactIds: Set<string>,
  issues: AuditIssue[],
  code: string
): void {
  const artifactId = stringValue(event.payload[payloadKey]);
  if (!artifactId || !artifactIds.has(artifactId)) {
    issues.push({
      severity: "error",
      code,
      message: `Event ${event.id} (${event.type}) is missing persisted artifact payload ${payloadKey}.`
    });
    return;
  }
  if (!event.artifactIds.includes(artifactId)) {
    issues.push({
      severity: "error",
      code: `${code}_not_linked`,
      message: `Event ${event.id} (${event.type}) payload ${payloadKey}=${artifactId} is not linked in event artifactIds.`
    });
  }
}

function requirePayloadString(
  event: ReturnType<Ledger["listEvents"]>[number],
  payloadKey: string,
  issues: AuditIssue[],
  code: string
): void {
  if (stringValue(event.payload[payloadKey])) return;
  issues.push({
    severity: "error",
    code,
    message: `Event ${event.id} (${event.type}) is missing payload ${payloadKey}.`
  });
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function recordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => item !== null && typeof item === "object" && !Array.isArray(item))
    : [];
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseJsonValue(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function parseJsonObject(value: string): Record<string, unknown> {
  const parsed = parseJsonValue(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

function sameStringSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}
