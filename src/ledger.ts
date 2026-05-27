import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import {
  buildBudgetContract,
  checkBudget,
  checkBudgetHardCap,
  type BudgetDimension,
  type BudgetHardCaps,
  type BudgetUsage
} from "./budget";
import { buildGoalContract } from "./goal-contract";
import { goalSuccessDecisionHash, type GoalSuccessDecisionToken } from "./goal-success";
import type {
  Artifact,
  Budget,
  EvidenceGrade,
  EventType,
  GoalRun,
  GoalStatus,
  LedgerEvent,
  WorkerJob,
  WorkerJobStatus,
  Workflow
} from "./domain";
import type { CancellationSettlement } from "./cancellation";
import { artifactContentAddress, artifactStorageKey, evidenceSatisfiesGoal, makeId, nowIso } from "./domain";
import { stableHash } from "./idempotency";
import { redactJson } from "./redaction";
import { decryptStringFromStorage, encryptStringForStorage } from "./storage-encryption";
import { workerLeaseStateFromStatus, workerLeaseTransitionPayload, type WorkerLeaseState } from "./worker-lease-state-machine";

type GoalRunRow = {
  id: string;
  problem: string;
  goal: string;
  success_criteria: string;
  workflow: Workflow;
  budget_json: string;
  status: GoalStatus;
  evidence_grade: EvidenceGrade;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
};

type EventRow = {
  id: string;
  run_id: string;
  type: EventType;
  payload_json: string;
  artifact_ids_json: string;
  created_at: string;
  sequence: number | null;
  payload_hash: string | null;
  linked_artifact_hashes_json: string | null;
  schema_version: number | null;
  previous_event_hash: string | null;
  event_hash: string | null;
};

type ArtifactRow = {
  id: string;
  run_id: string;
  kind: string;
  sha256: string;
  content_address: string | null;
  media_type: string | null;
  storage_key: string | null;
  path: string;
  bytes: number;
  created_at: string;
  provenance_json: string | null;
};

type WorkerJobRow = {
  id: string;
  run_id: string;
  kind: string;
  payload_json: string;
  dedupe_key: string | null;
  status: WorkerJobStatus;
  lease_owner: string | null;
  lease_expires_at: string | null;
  attempts: number;
  max_attempts: number;
  created_at: string;
  updated_at: string;
};

type ScoreRow = {
  id: string;
  run_id: string;
  subject_id: string;
  scorer: string;
  score: number;
  rubric_json: string;
  created_at: string;
};

export type ExternalOperationStatus =
  | "reserved"
  | "running"
  | "succeeded"
  | "failed"
  | "unknown_remote_outcome"
  | "dead_lettered"
  | "released";

type ExternalOperationRow = {
  id: string;
  run_id: string;
  operation_type: string;
  provider: string | null;
  idempotency_key: string;
  request_hash: string;
  request_artifact_id: string | null;
  response_artifact_id: string | null;
  reservation_id: string;
  status: ExternalOperationStatus;
  retry_of_operation_id: string | null;
  attempt: number;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
};

type BudgetReservationState = {
  reservationId: string;
  reserve: BudgetUsage;
  operationType?: string;
  operationId?: string;
  provider?: string;
  settled: "open" | "debited" | "released";
};

export type MachineAdmissionReservationState = {
  reservationId: string;
  reserve: BudgetUsage;
  operationType?: string;
  operationId?: string;
  provider?: string;
  modelId?: string;
  command?: string;
  settled: "open" | "released";
};

type BudgetOverReservationPolicy = {
  allowedDimensions: BudgetDimension[];
  reason: string;
};

function cancellationSettlementForExternalOperation(input: {
  status: "completed" | "failed" | "released" | "unknown";
  debited?: boolean;
}): CancellationSettlement {
  if (input.status === "completed") return "debited";
  if (input.status === "failed") return input.debited ? "debited" : "released";
  if (input.status === "released") return "released";
  return "unknown";
}

type ProviderRuntimeStateRow = {
  provider: string;
  consecutive_failures: number;
  circuit_open_until: string | null;
  retry_after_until: string | null;
  retry_after_operation_id: string | null;
  updated_at: string;
};

type ProviderRuntimeLockRow = {
  id: string;
  provider: string;
  run_id: string;
  operation_id: string;
  model_id: string;
  acquired_at: string;
  expires_at: string;
};

const TERMINAL_STATUS_PRIORITY: Record<GoalStatus, number> = {
  created: 0,
  running: 0,
  needs_human_review: 10,
  cancelled: 20,
  failed: 30,
  budget_exhausted: 40,
  goal_met: 100
};

const TERMINAL_ARBITER_AUTHORITY = "ledger.terminal-state-arbiter";

export type ProviderRuntimeAdmissionResult =
  | {
      ok: true;
      lockId: string;
      activeBeforeAcquire: number;
      maxConcurrency: number;
      expiresAt: string;
    }
  | {
      ok: false;
      reason: string;
      kind: "concurrency" | "circuit_open" | "rate_limited";
      retryAfterMs?: number;
      activeBeforeAcquire: number;
      maxConcurrency: number;
    };

export type BudgetReservationResult =
  | {
      ok: true;
      reservationId: string;
      reused?: boolean;
    }
  | {
      ok: false;
      reason: string;
    };

export type StoredScore = {
  id: string;
  runId: string;
  subjectId: string;
  scorer: string;
  score: number;
  rubric: Record<string, unknown>;
  createdAt: string;
};

export type ExternalOperation = {
  id: string;
  runId: string;
  operationType: string;
  provider?: string;
  idempotencyKey: string;
  requestHash: string;
  requestArtifactId?: string;
  responseArtifactId?: string;
  reservationId: string;
  status: ExternalOperationStatus;
  retryOfOperationId?: string;
  attempt: number;
  errorMessage?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
};

export type PrepareExternalOperationResult =
  | {
      ok: true;
      created: boolean;
      operation: ExternalOperation;
    }
  | {
      ok: false;
      reason: string;
    };

export type ExternalOperationPrepareFault =
  | "after_budget_checked"
  | "after_budget_reserved"
  | "after_external_operation_inserted"
  | "after_external_operation_reserved_event";

export type SqliteConcurrencyConfig = {
  journalMode: string;
  busyTimeoutMs: number;
  synchronous: number;
  walAutocheckpoint: number;
};

export type LedgerRequiredIndex = {
  name: string;
  table: string;
  columns: string[];
  present: boolean;
  purpose: string;
};

export type LedgerMaintenanceSnapshot = {
  format: "matematica.ledger.maintenance";
  version: 1;
  generatedAt: string;
  schemaVersion: number;
  appliedMigrations: string[];
  sqlite: SqliteConcurrencyConfig;
  requiredIndexes: LedgerRequiredIndex[];
  tables: {
    ledgerEvents: {
      rows: number;
      oldestCreatedAt?: string;
      newestCreatedAt?: string;
    };
    artifacts: {
      rows: number;
    };
    externalOperations: {
      rows: number;
    };
  };
  compactionPolicy: {
    sqliteWalCheckpoint: "automatic_wal_autocheckpoint_1000_pages";
    witnessCheckpoint: "refresh_after_every_event_append";
    vacuum: "operator_after_large_cache_prune_or_home_rotation";
    guidance: string[];
  };
  retentionPolicy: {
    ledgerEvents: "retain_until_operator_deletes_matematica_home";
    runArtifacts: "retain_until_operator_deletes_matematica_home";
    researchCaches: "prune_with_storage_prune_caches";
    portableReplayExports: "explicit_redacted_archive_only";
  };
  integrity: {
    schemaVersionMatchesMigrations: boolean;
    migrationsComplete: boolean;
    requiredIndexesPresent: boolean;
    concurrencyConfigOk: boolean;
  };
};

export type AppendEventBatchInput = {
  type: EventType;
  payload: Record<string, unknown>;
  artifactIds?: string[];
};

export type LedgerWitnessEntry = {
  sequence: number;
  eventId: string;
  type: EventType;
  payloadHash?: string;
  linkedArtifactManifestHash?: string;
  schemaVersion?: number;
  previousEventHash?: string;
  eventHash?: string;
};

export type LedgerWitnessCheckpoint = {
  format: "matematica.ledger.witness";
  version: 1;
  runId: string;
  eventCount: number;
  headEventHash?: string;
  eventLogHash: string;
  entries: LedgerWitnessEntry[];
  checkpointHash: string;
};

export type LedgerWitnessIssue = {
  code: string;
  message: string;
};

export type LedgerWitnessVerification = {
  ok: boolean;
  path: string;
  expected: LedgerWitnessCheckpoint;
  actual?: LedgerWitnessCheckpoint;
  issues: LedgerWitnessIssue[];
};

const MIGRATIONS = [
  {
    id: "001_initial_goal_run_schema",
    sql: `
      CREATE TABLE IF NOT EXISTS goal_runs (
        id TEXT PRIMARY KEY,
        problem TEXT NOT NULL,
        goal TEXT NOT NULL,
        success_criteria TEXT NOT NULL,
        workflow TEXT NOT NULL CHECK (workflow IN ('pflk', 'gree')),
        budget_json TEXT NOT NULL,
        status TEXT NOT NULL,
        evidence_grade TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES goal_runs(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        path TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ledger_events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES goal_runs(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        artifact_ids_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_ledger_events_run_created
        ON ledger_events(run_id, created_at, id);

      CREATE INDEX IF NOT EXISTS idx_artifacts_run
        ON artifacts(run_id, created_at);

      CREATE TABLE IF NOT EXISTS worker_jobs (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES goal_runs(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN (
            'pending',
            'leased',
            'running',
            'committed',
            'failed_retryable',
            'failed_terminal',
            'cancelled'
          )
        ),
        lease_owner TEXT,
        lease_expires_at TEXT,
        attempts INTEGER NOT NULL,
        max_attempts INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_worker_jobs_run_status
        ON worker_jobs(run_id, status, created_at, id);

      CREATE TABLE IF NOT EXISTS worker_attempts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES goal_runs(id) ON DELETE CASCADE,
        job_id TEXT REFERENCES worker_jobs(id) ON DELETE SET NULL,
        worker_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        artifact_ids_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_worker_attempts_run_job
        ON worker_attempts(run_id, job_id, attempt);

      CREATE TABLE IF NOT EXISTS source_records (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES goal_runs(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        query TEXT NOT NULL,
        source_id TEXT,
        title TEXT,
        url TEXT,
        retrieved_at TEXT NOT NULL,
        artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_source_records_run_provider
        ON source_records(run_id, provider, retrieved_at);

      CREATE TABLE IF NOT EXISTS verifier_runs (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES goal_runs(id) ON DELETE CASCADE,
        verifier_id TEXT NOT NULL,
        status TEXT NOT NULL,
        evidence_grade TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        artifact_ids_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_verifier_runs_run_verifier
        ON verifier_runs(run_id, verifier_id, started_at);

      CREATE TABLE IF NOT EXISTS budget_debits (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES goal_runs(id) ON DELETE CASCADE,
        event_id TEXT REFERENCES ledger_events(id) ON DELETE SET NULL,
        phase TEXT,
        worker_id TEXT,
        provider TEXT,
        attempts REAL NOT NULL DEFAULT 0,
        tokens REAL NOT NULL DEFAULT 0,
        usd REAL NOT NULL DEFAULT 0,
        elapsed_ms REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_budget_debits_run_created
        ON budget_debits(run_id, created_at);

      CREATE TABLE IF NOT EXISTS scores (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES goal_runs(id) ON DELETE CASCADE,
        subject_id TEXT NOT NULL,
        scorer TEXT NOT NULL,
        score REAL NOT NULL,
        rubric_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_scores_run_subject
        ON scores(run_id, subject_id, created_at);

      CREATE TABLE IF NOT EXISTS reports (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES goal_runs(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
        generated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_reports_run_generated
        ON reports(run_id, generated_at);
    `
  },
  {
    id: "002_external_operation_outbox",
    sql: `
      CREATE TABLE IF NOT EXISTS external_operations (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES goal_runs(id) ON DELETE CASCADE,
        operation_type TEXT NOT NULL,
        provider TEXT,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        request_artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
        response_artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
        reservation_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN ('reserved', 'running', 'succeeded', 'failed', 'unknown_remote_outcome', 'dead_lettered', 'released')
        ),
        retry_of_operation_id TEXT REFERENCES external_operations(id) ON DELETE SET NULL,
        attempt INTEGER NOT NULL,
        error_message TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE(run_id, idempotency_key)
      );

      CREATE INDEX IF NOT EXISTS idx_external_operations_run_status
        ON external_operations(run_id, status, created_at, id);

      CREATE INDEX IF NOT EXISTS idx_external_operations_retry
        ON external_operations(run_id, retry_of_operation_id, attempt);
    `
  },
  {
    id: "003_ledger_event_sequence",
    sql: `
      ALTER TABLE ledger_events ADD COLUMN sequence INTEGER;

      CREATE TABLE IF NOT EXISTS run_event_counters (
        run_id TEXT PRIMARY KEY REFERENCES goal_runs(id) ON DELETE CASCADE,
        next_sequence INTEGER NOT NULL
      );

      INSERT OR IGNORE INTO run_event_counters (run_id, next_sequence)
      SELECT run_id, COUNT(*)
      FROM ledger_events
      GROUP BY run_id;

      CREATE INDEX IF NOT EXISTS idx_ledger_events_run_sequence
        ON ledger_events(run_id, sequence, created_at, id);
    `
  },
  {
    id: "004_worker_job_deduplication",
    sql: `
      ALTER TABLE worker_jobs ADD COLUMN dedupe_key TEXT;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_worker_jobs_run_dedupe
        ON worker_jobs(run_id, dedupe_key)
        WHERE dedupe_key IS NOT NULL;
    `
  },
  {
    id: "005_provider_runtime_state",
    sql: `
      CREATE TABLE IF NOT EXISTS provider_runtime_state (
        provider TEXT PRIMARY KEY,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        circuit_open_until TEXT,
        retry_after_until TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS provider_runtime_locks (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        run_id TEXT NOT NULL REFERENCES goal_runs(id) ON DELETE CASCADE,
        operation_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        acquired_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_provider_runtime_locks_provider_expires
        ON provider_runtime_locks(provider, expires_at);

      CREATE INDEX IF NOT EXISTS idx_provider_runtime_locks_run
        ON provider_runtime_locks(run_id, provider);
    `
  },
  {
    id: "006_provider_retry_after_owner",
    sql: `
      ALTER TABLE provider_runtime_state ADD COLUMN retry_after_operation_id TEXT;
    `
  },
  {
    id: "007_ledger_event_hash_chain",
    sql: `
      ALTER TABLE ledger_events ADD COLUMN previous_event_hash TEXT;
      ALTER TABLE ledger_events ADD COLUMN event_hash TEXT;

      CREATE INDEX IF NOT EXISTS idx_ledger_events_run_hash
        ON ledger_events(run_id, event_hash);
    `
  },
  {
    id: "008_ledger_event_integrity_manifest",
    sql: `
      ALTER TABLE ledger_events ADD COLUMN payload_hash TEXT;
      ALTER TABLE ledger_events ADD COLUMN linked_artifact_hashes_json TEXT;
      ALTER TABLE ledger_events ADD COLUMN schema_version INTEGER;
    `
  },
  {
    id: "009_artifact_redaction_provenance",
    sql: `
      ALTER TABLE artifacts ADD COLUMN provenance_json TEXT;
    `
  },
  {
    id: "010_external_operation_unknown_remote_outcome",
    sql: `
      ALTER TABLE external_operations RENAME TO external_operations_legacy_010;

      DROP INDEX IF EXISTS idx_external_operations_run_status;
      DROP INDEX IF EXISTS idx_external_operations_retry;

      CREATE TABLE external_operations (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES goal_runs(id) ON DELETE CASCADE,
        operation_type TEXT NOT NULL,
        provider TEXT,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        request_artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
        response_artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
        reservation_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN ('reserved', 'running', 'succeeded', 'failed', 'unknown_remote_outcome', 'dead_lettered', 'released')
        ),
        retry_of_operation_id TEXT REFERENCES external_operations(id) ON DELETE SET NULL,
        attempt INTEGER NOT NULL,
        error_message TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE(run_id, idempotency_key)
      );

      INSERT INTO external_operations (
        id, run_id, operation_type, provider, idempotency_key, request_hash,
        request_artifact_id, response_artifact_id, reservation_id, status,
        retry_of_operation_id, attempt, error_message, created_at, started_at,
        completed_at, updated_at
      )
      SELECT
        id, run_id, operation_type, provider, idempotency_key, request_hash,
        request_artifact_id, response_artifact_id, reservation_id, status,
        retry_of_operation_id, attempt, error_message, created_at, started_at,
        completed_at, updated_at
      FROM external_operations_legacy_010;

      CREATE INDEX IF NOT EXISTS idx_external_operations_run_status
        ON external_operations(run_id, status, created_at, id);

      CREATE INDEX IF NOT EXISTS idx_external_operations_retry
        ON external_operations(run_id, retry_of_operation_id, attempt);
    `
  },
  {
    id: "011_arxiv_runtime_cache",
    sql: `
      CREATE TABLE IF NOT EXISTS arxiv_runtime_state (
        id TEXT PRIMARY KEY,
        next_request_at_ms INTEGER NOT NULL,
        in_flight_lock_id TEXT,
        lock_expires_at_ms INTEGER,
        updated_at TEXT NOT NULL
      );

      INSERT OR IGNORE INTO arxiv_runtime_state (
        id, next_request_at_ms, in_flight_lock_id, lock_expires_at_ms, updated_at
      ) VALUES ('global', 0, NULL, NULL, '1970-01-01T00:00:00.000Z');

      CREATE TABLE IF NOT EXISTS arxiv_query_cache (
        cache_key TEXT PRIMARY KEY,
        query TEXT NOT NULL,
        max_results INTEGER NOT NULL,
        sort_by TEXT NOT NULL,
        sort_order TEXT NOT NULL,
        papers_json TEXT NOT NULL,
        result_hash TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        stale_at TEXT NOT NULL,
        freshness_json TEXT NOT NULL,
        query_expansion_json TEXT NOT NULL,
        source_snapshot_hashes_json TEXT NOT NULL,
        retrieval_quality_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_arxiv_query_cache_query_updated
        ON arxiv_query_cache(query, updated_at);

      CREATE INDEX IF NOT EXISTS idx_arxiv_query_cache_stale
        ON arxiv_query_cache(stale_at);
    `
  },
  {
    id: "012_budget_resource_dimensions",
    sql: `
      ALTER TABLE budget_debits ADD COLUMN artifact_bytes REAL NOT NULL DEFAULT 0;
      ALTER TABLE budget_debits ADD COLUMN source_queries REAL NOT NULL DEFAULT 0;
      ALTER TABLE budget_debits ADD COLUMN retries REAL NOT NULL DEFAULT 0;
      ALTER TABLE budget_debits ADD COLUMN sandbox_ms REAL NOT NULL DEFAULT 0;
    `
  },
  {
    id: "013_external_operation_dead_lettered",
    sql: `
      ALTER TABLE external_operations RENAME TO external_operations_legacy_013;

      DROP INDEX IF EXISTS idx_external_operations_run_status;
      DROP INDEX IF EXISTS idx_external_operations_retry;

      CREATE TABLE external_operations (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES goal_runs(id) ON DELETE CASCADE,
        operation_type TEXT NOT NULL,
        provider TEXT,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        request_artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
        response_artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
        reservation_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN ('reserved', 'running', 'succeeded', 'failed', 'unknown_remote_outcome', 'dead_lettered', 'released')
        ),
        retry_of_operation_id TEXT REFERENCES external_operations(id) ON DELETE SET NULL,
        attempt INTEGER NOT NULL,
        error_message TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE(run_id, idempotency_key)
      );

      INSERT INTO external_operations (
        id, run_id, operation_type, provider, idempotency_key, request_hash,
        request_artifact_id, response_artifact_id, reservation_id, status,
        retry_of_operation_id, attempt, error_message, created_at, started_at,
        completed_at, updated_at
      )
      SELECT
        id, run_id, operation_type, provider, idempotency_key, request_hash,
        request_artifact_id, response_artifact_id, reservation_id, status,
        retry_of_operation_id, attempt, error_message, created_at, started_at,
        completed_at, updated_at
      FROM external_operations_legacy_013;

      CREATE INDEX IF NOT EXISTS idx_external_operations_run_status
        ON external_operations(run_id, status, created_at, id);

      CREATE INDEX IF NOT EXISTS idx_external_operations_retry
        ON external_operations(run_id, retry_of_operation_id, attempt);
    `
  },
  {
    id: "014_ledger_maintenance_query_indexes",
    sql: `
      CREATE INDEX IF NOT EXISTS idx_ledger_events_run_created_sequence
        ON ledger_events(run_id, created_at, sequence, id);

      CREATE INDEX IF NOT EXISTS idx_artifacts_run_kind_created
        ON artifacts(run_id, kind, created_at, id);
    `
  },
  {
    id: "015_artifact_content_address_metadata",
    sql: `
      ALTER TABLE artifacts ADD COLUMN content_address TEXT;
      ALTER TABLE artifacts ADD COLUMN media_type TEXT;
      ALTER TABLE artifacts ADD COLUMN storage_key TEXT;

      UPDATE artifacts
      SET
        content_address = 'sha256:' || sha256,
        media_type = 'text/plain; charset=utf-8',
        storage_key = run_id || '/' || sha256 || '.txt'
      WHERE content_address IS NULL
        OR media_type IS NULL
        OR storage_key IS NULL;

      CREATE INDEX IF NOT EXISTS idx_artifacts_content_address
        ON artifacts(content_address);
    `
  }
] as const;

const REQUIRED_LEDGER_INDEXES: Array<Omit<LedgerRequiredIndex, "present">> = [
  {
    name: "idx_ledger_events_run_sequence",
    table: "ledger_events",
    columns: ["run_id", "sequence", "created_at", "id"],
    purpose: "Replay and audit each run in monotonic event order even when wall-clock timestamps span days."
  },
  {
    name: "idx_ledger_events_run_created_sequence",
    table: "ledger_events",
    columns: ["run_id", "created_at", "sequence", "id"],
    purpose: "Keep multi-day run event windows queryable by timestamp without sacrificing deterministic sequence ties."
  },
  {
    name: "idx_ledger_events_run_hash",
    table: "ledger_events",
    columns: ["run_id", "event_hash"],
    purpose: "Locate integrity-chain heads and hash evidence for corruption investigations."
  },
  {
    name: "idx_artifacts_run",
    table: "artifacts",
    columns: ["run_id", "created_at"],
    purpose: "Query retained artifacts for long-running runs without scanning unrelated homes."
  },
  {
    name: "idx_artifacts_run_kind_created",
    table: "artifacts",
    columns: ["run_id", "kind", "created_at", "id"],
    purpose: "Find retention, replay, and maintenance evidence artifacts by kind during audits."
  },
  {
    name: "idx_artifacts_content_address",
    table: "artifacts",
    columns: ["content_address"],
    purpose: "Resolve immutable artifact content addresses without depending on local filesystem paths."
  },
  {
    name: "idx_worker_jobs_run_status",
    table: "worker_jobs",
    columns: ["run_id", "status", "created_at", "id"],
    purpose: "Resume and reconcile long-running swarms by run and worker state."
  },
  {
    name: "idx_external_operations_run_status",
    table: "external_operations",
    columns: ["run_id", "status", "created_at", "id"],
    purpose: "Reconcile provider outbox operations and unknown remote outcomes by run."
  }
];

export class Ledger {
  readonly db: Database;
  private readonly dbPath: string;
  private readonly storageRoot: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    this.storageRoot = dirname(dbPath);
    this.db = new Database(dbPath, { create: true, strict: true });
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  migrate(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 10000;
      PRAGMA synchronous = NORMAL;
      PRAGMA wal_autocheckpoint = 1000;
      PRAGMA foreign_keys = ON;
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);

    const applyMigration = this.db.transaction((id: string, sql: string) => {
      const existing = this.db.query("SELECT id FROM schema_migrations WHERE id = ?").get(id);
      if (existing) return false;
      this.db.exec(sql);
      this.db.query("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(id, nowIso());
      return true;
    });

    const appliedInThisOpen: string[] = [];
    for (const migration of MIGRATIONS) {
      if (applyMigration(migration.id, migration.sql)) appliedInThisOpen.push(migration.id);
    }
    if (
      appliedInThisOpen.includes("007_ledger_event_hash_chain") ||
      appliedInThisOpen.includes("008_ledger_event_integrity_manifest")
    ) {
      this.backfillEventHashChains();
    }
    this.db.exec(`PRAGMA user_version = ${MIGRATIONS.length};`);
  }

  sqliteConcurrencyConfig(): SqliteConcurrencyConfig {
    const journalMode = this.db.query("PRAGMA journal_mode").get() as { journal_mode: string };
    const busyTimeout = this.db.query("PRAGMA busy_timeout").get() as { timeout: number };
    const synchronous = this.db.query("PRAGMA synchronous").get() as { synchronous: number };
    const walAutocheckpoint = this.db.query("PRAGMA wal_autocheckpoint").get() as { wal_autocheckpoint: number };
    void this.dbPath;
    return {
      journalMode: journalMode.journal_mode,
      busyTimeoutMs: busyTimeout.timeout,
      synchronous: synchronous.synchronous,
      walAutocheckpoint: walAutocheckpoint.wal_autocheckpoint
    };
  }

  appliedMigrations(): string[] {
    return (this.db.query("SELECT id FROM schema_migrations ORDER BY id ASC").all() as Array<{ id: string }>)
      .map((row) => row.id);
  }

  schemaVersion(): number {
    const row = this.db.query("PRAGMA user_version").get() as { user_version: number };
    return row.user_version;
  }

  requiredIndexes(): LedgerRequiredIndex[] {
    return REQUIRED_LEDGER_INDEXES.map((index) => ({
      ...index,
      present: this.indexExists(index.name)
    }));
  }

  maintenanceSnapshot(): LedgerMaintenanceSnapshot {
    const schemaVersion = this.schemaVersion();
    const appliedMigrations = this.appliedMigrations();
    const sqlite = this.sqliteConcurrencyConfig();
    const requiredIndexes = this.requiredIndexes();
    const ledgerEventStats = this.db.query(`
      SELECT COUNT(*) AS rows, MIN(created_at) AS oldest_created_at, MAX(created_at) AS newest_created_at
      FROM ledger_events
    `).get() as { rows: number; oldest_created_at: string | null; newest_created_at: string | null };
    const artifactStats = this.db.query("SELECT COUNT(*) AS rows FROM artifacts").get() as { rows: number };
    const externalOperationStats = this.db.query("SELECT COUNT(*) AS rows FROM external_operations").get() as { rows: number };
    const concurrencyConfigOk =
      sqlite.journalMode.toLowerCase() === "wal" &&
      sqlite.busyTimeoutMs >= 10_000 &&
      sqlite.walAutocheckpoint === 1000;

    return {
      format: "matematica.ledger.maintenance",
      version: 1,
      generatedAt: nowIso(),
      schemaVersion,
      appliedMigrations,
      sqlite,
      requiredIndexes,
      tables: {
        ledgerEvents: {
          rows: ledgerEventStats.rows,
          oldestCreatedAt: ledgerEventStats.oldest_created_at ?? undefined,
          newestCreatedAt: ledgerEventStats.newest_created_at ?? undefined
        },
        artifacts: {
          rows: artifactStats.rows
        },
        externalOperations: {
          rows: externalOperationStats.rows
        }
      },
      compactionPolicy: {
        sqliteWalCheckpoint: "automatic_wal_autocheckpoint_1000_pages",
        witnessCheckpoint: "refresh_after_every_event_append",
        vacuum: "operator_after_large_cache_prune_or_home_rotation",
        guidance: [
          "SQLite WAL checkpointing is automatic at 1000 pages; use a manual checkpoint only during an operator maintenance window.",
          "Ledger witness checkpoints are rewritten after every event append and audited against the SQLite log.",
          "Run VACUUM only after large cache pruning or home rotation, with no active workers writing to the ledger."
        ]
      },
      retentionPolicy: {
        ledgerEvents: "retain_until_operator_deletes_matematica_home",
        runArtifacts: "retain_until_operator_deletes_matematica_home",
        researchCaches: "prune_with_storage_prune_caches",
        portableReplayExports: "explicit_redacted_archive_only"
      },
      integrity: {
        schemaVersionMatchesMigrations: schemaVersion === appliedMigrations.length,
        migrationsComplete: appliedMigrations.length === MIGRATIONS.length,
        requiredIndexesPresent: requiredIndexes.every((index) => index.present),
        concurrencyConfigOk
      }
    };
  }

  createRun(input: {
    problem: string;
    goal: string;
    successCriteria: string[];
    workflow: Workflow;
    budget: Budget;
  }): GoalRun {
    const createdAt = nowIso();
    const run: GoalRun = {
      id: makeId("run"),
      problem: redactJson(input.problem),
      goal: redactJson(input.goal),
      successCriteria: redactJson(input.successCriteria),
      workflow: input.workflow,
      budget: input.budget,
      status: "created",
      evidenceGrade: "none",
      createdAt,
      updatedAt: createdAt
    };

    this.db.query(`
      INSERT INTO goal_runs (
        id, problem, goal, success_criteria, workflow, budget_json,
        status, evidence_grade, created_at, updated_at, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      run.id,
      this.encryptStorageString(run.problem, `goal_run:${run.id}:problem`),
      this.encryptStorageString(run.goal, `goal_run:${run.id}:goal`),
      this.encryptStorageString(JSON.stringify(run.successCriteria), `goal_run:${run.id}:success_criteria`),
      run.workflow,
      JSON.stringify(run.budget),
      run.status,
      run.evidenceGrade,
      run.createdAt,
      run.updatedAt,
      null,
      null
    );

    this.appendEvent(run.id, "goal.created", {
      problem: run.problem,
      goal: run.goal,
      successCriteria: run.successCriteria,
      workflow: run.workflow,
      budget: run.budget,
      budgetContract: buildBudgetContract(run.budget),
      goalContract: buildGoalContract(run)
    });

    return run;
  }

  getRun(runId: string): GoalRun | undefined {
    const row = this.db.query("SELECT * FROM goal_runs WHERE id = ?").get(runId) as GoalRunRow | null;
    return row ? mapRun(row, this.storageRoot) : undefined;
  }

  listRuns(): GoalRun[] {
    const rows = this.db.query("SELECT * FROM goal_runs ORDER BY created_at ASC, id ASC").all() as GoalRunRow[];
    return rows.map((row) => mapRun(row, this.storageRoot));
  }

  requireRun(runId: string): GoalRun {
    const run = this.getRun(runId);
    if (!run) throw new Error(`Goal run not found: ${runId}`);
    return run;
  }

  private terminalRunStatus(runId: string): GoalStatus | undefined {
    const status = this.requireRun(runId).status;
    return isTerminal(status) ? status : undefined;
  }

  updateRunStatus(runId: string, status: GoalStatus, evidenceGrade?: EvidenceGrade): GoalRun {
    if (status === "goal_met") {
      throw new Error("Use markGoalMet with verifier-backed evidence to complete a goal.");
    }
    const current = this.requireRun(runId);
    return this.setRunStatus(current, status, evidenceGrade);
  }

  markGoalMet(
    runId: string,
    evidenceGrade: EvidenceGrade,
    evidence: Record<string, unknown>,
    artifactIds: string[],
    decision?: GoalSuccessDecisionToken
  ): GoalRun {
    if (!evidenceSatisfiesGoal(evidenceGrade)) {
      throw new Error(`Cannot mark goal_met with non-verifier-backed grade ${evidenceGrade}.`);
    }
    if (artifactIds.length === 0) {
      throw new Error("Cannot mark goal_met without satisfying artifact IDs.");
    }
    const openReservations = this.listOpenBudgetReservations(runId);
    if (openReservations.length > 0) {
      throw new Error(`Cannot mark goal_met with ${openReservations.length} open budget reservations.`);
    }
    this.verifyGoalSuccessDecision(runId, evidenceGrade, evidence, artifactIds, decision);
    const current = this.requireRun(runId);
    const run = this.setRunStatus(current, "goal_met", evidenceGrade);
    this.appendEvent(runId, "goal.completed", {
      status: "goal_met",
      evidenceGrade,
      ...evidence,
      finalState: finalStateForEvidenceGrade(evidenceGrade),
      canClaimSolved: evidenceGrade !== "verified_counterexample",
      satisfyingArtifactIds: artifactIds
    }, artifactIds);
    return run;
  }

  private verifyGoalSuccessDecision(
    runId: string,
    evidenceGrade: EvidenceGrade,
    evidence: Record<string, unknown>,
    artifactIds: string[],
    decision: GoalSuccessDecisionToken | undefined
  ): void {
    if (!decision) {
      throw new Error("Cannot mark goal_met without a persisted GoalSuccessDecision token.");
    }
    if (decision.format !== "matematica.goal-success-decision-token" || decision.version !== 1) {
      throw new Error("Invalid GoalSuccessDecision token format.");
    }
    if (decision.runId !== runId) {
      throw new Error("GoalSuccessDecision token belongs to a different run.");
    }
    if (decision.status !== "goal_met") {
      throw new Error("GoalSuccessDecision token does not authorize goal_met.");
    }
    if (decision.evidenceGrade !== evidenceGrade) {
      throw new Error("GoalSuccessDecision token evidence grade does not match goal completion.");
    }

    const claimId = typeof evidence.claimId === "string" ? evidence.claimId : undefined;
    const verifierId = typeof evidence.verifierId === "string" ? evidence.verifierId : undefined;
    if (claimId && decision.claimId !== claimId) {
      throw new Error("GoalSuccessDecision token claim does not match goal completion.");
    }
    if (verifierId && decision.verifierId !== verifierId) {
      throw new Error("GoalSuccessDecision token verifier does not match goal completion.");
    }

    const event = this.listEvents(runId).find((item) => item.id === decision.eventId);
    if (!event || event.type !== "goal.success.evaluated") {
      throw new Error("GoalSuccessDecision token does not reference a persisted goal.success.evaluated event.");
    }
    if (event.eventHash !== decision.eventHash || event.payloadHash !== decision.payloadHash) {
      throw new Error("GoalSuccessDecision token ledger hash does not match persisted event.");
    }
    if (goalSuccessDecisionHash(event.payload) !== decision.decisionHash) {
      throw new Error("GoalSuccessDecision token hash does not match persisted event payload.");
    }
    if (event.payload.status !== "goal_met") {
      throw new Error("Persisted GoalSuccessDecision did not approve goal_met.");
    }
    if (event.payload.evidenceGrade !== evidenceGrade) {
      throw new Error("Persisted GoalSuccessDecision evidence grade does not match goal completion.");
    }
    if (event.payload.claimId !== decision.claimId || event.payload.verifierId !== decision.verifierId) {
      throw new Error("GoalSuccessDecision token identity does not match persisted event.");
    }

    const satisfyingArtifactIds = stringArray(event.payload.satisfyingArtifactIds);
    if (!sameOrderedStrings(satisfyingArtifactIds, artifactIds) || !sameOrderedStrings(satisfyingArtifactIds, decision.satisfyingArtifactIds)) {
      throw new Error("GoalSuccessDecision token satisfying artifacts do not match goal completion.");
    }
    const finalization = [...this.listEvents(runId)].reverse().find((item) =>
      item.type === "goal.finalization.checked" &&
      item.payload.goalSuccessEventId === decision.eventId
    );
    if (!finalization) {
      throw new Error("Cannot mark goal_met without a passed no-false-solved finalization gate.");
    }
    if (finalization.payload.status !== "passed" || finalization.payload.canMarkGoalMet !== true) {
      throw new Error("No-false-solved finalization gate did not approve goal_met.");
    }
    const finalizationChecks = Array.isArray(finalization.payload.checks) ? finalization.payload.checks : [];
    const proofCertificateCheck = finalizationChecks.find((check) =>
      check &&
      typeof check === "object" &&
      (check as Record<string, unknown>).id === "proof_certificate"
    ) as Record<string, unknown> | undefined;
    if (!proofCertificateCheck || proofCertificateCheck.status !== "passed") {
      throw new Error("No-false-solved finalization is missing a passed proof certificate check.");
    }
    const adversarialQuorumCheck = finalizationChecks.find((check) =>
      check &&
      typeof check === "object" &&
      (check as Record<string, unknown>).id === "adversarial_planning_quorum"
    ) as Record<string, unknown> | undefined;
    if (!adversarialQuorumCheck || adversarialQuorumCheck.status !== "passed") {
      throw new Error("No-false-solved finalization is missing a passed adversarial planning quorum check.");
    }
    this.verifyBlindAdversarialFinalizationQuorum(runId, decision.eventId);
    if (finalization.payload.evidenceGrade !== evidenceGrade) {
      throw new Error("No-false-solved finalization evidence grade does not match goal completion.");
    }
    if (finalization.payload.claimId !== decision.claimId || finalization.payload.verifierId !== decision.verifierId) {
      throw new Error("No-false-solved finalization identity does not match goal completion.");
    }
    if (!sameOrderedStrings(stringArray(finalization.payload.satisfyingArtifactIds), artifactIds)) {
      throw new Error("No-false-solved finalization satisfying artifacts do not match goal completion.");
    }
    if (finalization.artifactIds.length === 0) {
      throw new Error("No-false-solved finalization must link its review artifact.");
    }
  }

  private verifyBlindAdversarialFinalizationQuorum(runId: string, goalSuccessEventId: string): void {
    const quorum = [...this.listEvents(runId)].reverse().find((item) =>
      item.type === "adversarial.quorum.reviewed" &&
      item.payload.scope === "finalization" &&
      item.payload.targetEventId === goalSuccessEventId
    );
    if (!quorum) {
      throw new Error("No-false-solved finalization is missing a persisted blind adversarial quorum event.");
    }
    const failures: string[] = [];
    if (quorum.payload.status !== "passed") failures.push(`adversarial quorum status is ${String(quorum.payload.status)}`);
    if (quorum.payload.degraded === true) failures.push("adversarial quorum is degraded");
    const modelFamilyDiversity = recordValue(quorum.payload.modelFamilyDiversity);
    if (modelFamilyDiversity.status !== "passed") failures.push("adversarial quorum model-family diversity did not pass");
    if (typeof modelFamilyDiversity.effectiveIndependentSignals === "number" && modelFamilyDiversity.effectiveIndependentSignals < 2) {
      failures.push(`adversarial quorum has only ${modelFamilyDiversity.effectiveIndependentSignals} provider/model-family signal`);
    }
    const critics = arrayValue(quorum.payload.critics).map(recordValue);
    if (critics.length < 2) failures.push(`requires at least 2 persisted critics, got ${critics.length}`);
    const independentGroups = new Set(
      critics
        .map((critic) => stringValue(critic.independentGroup))
        .filter((value): value is string => Boolean(value))
    );
    if (independentGroups.size < 2) failures.push("critics are not independently grouped");
    for (const critic of critics) {
      const criticId = stringValue(critic.criticId) ?? "unknown";
      if (stringValue(critic.source) === "default_synthetic") {
        failures.push(`critic ${criticId} uses default/synthetic critic source`);
      }
      const blindReview = recordValue(critic.blindReview);
      if (blindReview.blindedToFinalVerdict !== true) {
        failures.push(`critic ${criticId} is not blind to the proposed final verdict`);
      }
      if (!stringValue(blindReview.targetDigest)) failures.push(`critic ${criticId} is missing blind target digest`);
      if (!stringValue(blindReview.protocolHash)) failures.push(`critic ${criticId} is missing blind review protocol hash`);
      if (!stringArray(blindReview.redactedFields).includes("status")) {
        failures.push(`critic ${criticId} blind review did not redact final verdict status`);
      }
      const findings = arrayValue(critic.findings).map(recordValue);
      for (const finding of findings) {
        const severity = stringValue(finding.severity);
        if (finding.status === "accepted" && (severity === "high" || severity === "critical")) {
          failures.push(`accepted ${severity} adversarial finding ${stringValue(finding.id) ?? "unknown"} blocks finalization`);
        }
      }
    }
    if (quorum.artifactIds.length === 0) failures.push("adversarial quorum event does not link artifacts");
    if (failures.length > 0) {
      throw new Error(`No-false-solved finalization adversarial quorum is not blind and blocking: ${[...new Set(failures)].join("; ")}.`);
    }
  }

  private setRunStatus(current: GoalRun, status: GoalStatus, evidenceGrade?: EvidenceGrade): GoalRun {
    if (isTerminal(current.status)) {
      if (!this.canReopenTerminalRun(current, status)) {
        this.appendEvent(current.id, "goal.terminal_transition.ignored", {
          from: current.status,
          to: status,
          evidenceGrade: evidenceGrade ?? current.evidenceGrade,
          terminalArbiter: terminalTransitionArbiter({
            from: current.status,
            to: status,
            transition: "ignored",
            reason: "run_already_terminal",
            applied: false
          })
        });
        throw new Error(
          `Cannot change terminal run ${current.id} from ${current.status} to ${status} without explicit terminal reopen intent.`
        );
      }
    }
    const updatedAt = nowIso();
    const startedAt = current.startedAt ?? (status === "running" ? updatedAt : undefined);
    const completedAt = isTerminal(status) ? updatedAt : current.completedAt;
    const grade = evidenceGrade ?? current.evidenceGrade;

    const result = this.db.query(`
      UPDATE goal_runs
      SET status = ?, evidence_grade = ?, updated_at = ?, started_at = ?, completed_at = ?
      WHERE id = ? AND status = ?
    `).run(status, grade, updatedAt, startedAt ?? null, completedAt ?? null, current.id, current.status);

    if (result.changes !== 1) {
      const observed = this.requireRun(current.id);
      this.appendEvent(current.id, "goal.terminal_transition.ignored", {
        from: observed.status,
        attemptedFrom: current.status,
        to: status,
        evidenceGrade: grade,
        terminalArbiter: terminalTransitionArbiter({
          from: current.status,
          observedFrom: observed.status,
          to: status,
          transition: "ignored",
          reason: "compare_and_set_failed",
          applied: false
        })
      });
      throw new Error(`Cannot change run ${current.id} from ${current.status} to ${status}: terminal arbiter compare-and-set failed; current status is ${observed.status}.`);
    }

    this.appendEvent(current.id, "goal.status_changed", {
      from: current.status,
      to: status,
      evidenceGrade: grade,
      terminalArbiter: terminalTransitionArbiter({
        from: current.status,
        to: status,
        transition: "applied",
        reason: isTerminal(status) ? "terminal_status_selected" : "nonterminal_status_update",
        applied: true
      })
    });

    return this.requireRun(current.id);
  }

  private canReopenTerminalRun(current: GoalRun, status: GoalStatus): boolean {
    if (current.status === "goal_met") return false;
    if (status !== "created") return false;
    const events = this.listEvents(current.id);
    const latestTerminalStatus = [...events].reverse().find((event) =>
      event.type === "goal.status_changed" &&
      event.payload.to === current.status
    );
    const latestReopenIntent = [...events].reverse().find((event) =>
      event.type === "goal.terminal_reopen.requested" &&
      event.payload.fromStatus === current.status &&
      event.payload.reopened === true
    );
    if (!latestReopenIntent) return false;
    if (!latestTerminalStatus) return true;
    return (latestReopenIntent.sequence ?? -1) > (latestTerminalStatus.sequence ?? -1);
  }

  appendEvent(
    runId: string,
    type: EventType,
    payload: Record<string, unknown>,
    artifactIds: string[] = []
  ): LedgerEvent {
    this.requireRun(runId);
    if (this.db.inTransaction) return this.insertEvent(runId, type, payload, artifactIds);
    const insertOne = this.db.transaction(() => this.insertEvent(runId, type, payload, artifactIds));
    const event = insertOne();
    this.refreshLedgerWitness(runId);
    return event;
  }

  appendEventsBatch(runId: string, events: AppendEventBatchInput[]): LedgerEvent[] {
    this.requireRun(runId);
    if (events.length === 0) return [];
    const insertMany = this.db.transaction((items: AppendEventBatchInput[]) =>
      items.map((event) => this.insertEvent(runId, event.type, event.payload, event.artifactIds ?? []))
    );
    const inserted = insertMany(events);
    this.refreshLedgerWitness(runId);
    return inserted;
  }

  private insertEvent(
    runId: string,
    type: EventType,
    payload: Record<string, unknown>,
    artifactIds: string[] = []
  ): LedgerEvent {
    const linkedArtifactIds = [...new Set(artifactIds)];
    const payloadWithCompleteness = addNoArtifactJustification(type, payload, linkedArtifactIds);
    const sequence = this.nextEventSequence(runId);
    const previousEventHash = this.previousEventHash(runId, sequence);
    const linkedArtifactHashes = this.linkedArtifactHashes(runId, linkedArtifactIds);
    const schemaVersion = MIGRATIONS.length;
    const redactedPayload = addTerminalIntegrity(
      type,
      redactJson(payloadWithCompleteness),
      {
        previousEventHash,
        artifactRoot: stableHash(linkedArtifactHashes),
        schemaVersion
      }
    );
    const payloadHash = stableHash(redactedPayload);
    const event: LedgerEvent = {
      id: makeId("evt"),
      runId,
      type,
      payload: redactedPayload,
      artifactIds: linkedArtifactIds,
      createdAt: nowIso(),
      sequence,
      payloadHash,
      linkedArtifactHashes,
      schemaVersion,
      previousEventHash,
      eventHash: computeLedgerEventHash({
        runId,
        type,
        payload: redactedPayload,
        artifactIds: linkedArtifactIds,
        sequence,
        payloadHash,
        linkedArtifactHashes,
        schemaVersion,
        previousEventHash
      })
    };

    this.db.query(`
      INSERT INTO ledger_events (
        id, run_id, type, payload_json, artifact_ids_json, created_at, sequence,
        payload_hash, linked_artifact_hashes_json, schema_version,
        previous_event_hash, event_hash
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.runId,
      event.type,
      this.encryptStorageString(JSON.stringify(event.payload), `ledger_event:${event.id}:payload`),
      JSON.stringify(event.artifactIds),
      event.createdAt,
      sequence,
      payloadHash,
      JSON.stringify(event.linkedArtifactHashes),
      schemaVersion,
      event.previousEventHash ?? null,
      event.eventHash ?? null
    );

    return event;
  }

  listEvents(runId: string): LedgerEvent[] {
    return (this.db.query(`
      SELECT * FROM ledger_events
      WHERE run_id = ?
      ORDER BY COALESCE(sequence, 0) ASC, created_at ASC, id ASC
    `).all(runId) as EventRow[]).map((row) => mapEvent(row, this.storageRoot));
  }

  insertArtifact(artifact: Artifact): void {
    this.requireRun(artifact.runId);
    this.insertArtifactRow(artifact);
  }

  recordArtifactCreated(artifact: Artifact, options: { fault?: "after_artifact_insert" } = {}): void {
    this.requireRun(artifact.runId);
    const record = this.db.transaction(() => {
      this.insertArtifactRow(artifact);
      if (options.fault === "after_artifact_insert") {
        throw new Error("Injected artifact persistence fault after artifact row insert.");
      }
      this.appendEvent(artifact.runId, "artifact.created", {
        artifactId: artifact.id,
        kind: artifact.kind,
        sha256: artifact.sha256,
        contentAddress: artifact.contentAddress,
        mediaType: artifact.mediaType,
        storageKey: artifact.storageKey,
        bytes: artifact.bytes,
        provenance: artifact.provenance
      }, [artifact.id]);
    });
    record();
    this.refreshLedgerWitness(artifact.runId);
  }

  reconcileOrphanArtifactRows(runId: string, reason: string): string[] {
    this.requireRun(runId);
    const events = this.listEvents(runId);
    const referencedArtifactIds = new Set(events.flatMap((event) => event.artifactIds));
    const orphanIds = this.listArtifacts(runId)
      .filter((artifact) => !referencedArtifactIds.has(artifact.id))
      .map((artifact) => artifact.id);
    if (orphanIds.length === 0) return [];

    const reconcile = this.db.transaction((ids: string[]) => {
      for (const artifactId of ids) {
        this.db.query("DELETE FROM artifacts WHERE run_id = ? AND id = ?").run(runId, artifactId);
      }
      this.appendEvent(runId, "artifact.reconciled", {
        reason,
        action: "deleted_orphan_artifact_rows",
        artifactIds: ids
      });
    });
    reconcile(orphanIds);
    this.refreshLedgerWitness(runId);
    return orphanIds;
  }

  private insertArtifactRow(artifact: Artifact): void {
    this.db.query(`
      INSERT INTO artifacts (
        id, run_id, kind, sha256, content_address, media_type, storage_key,
        path, bytes, created_at, provenance_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      artifact.id,
      artifact.runId,
      artifact.kind,
      artifact.sha256,
      artifact.contentAddress,
      artifact.mediaType,
      artifact.storageKey,
      artifact.path,
      artifact.bytes,
      artifact.createdAt,
      artifact.provenance ? JSON.stringify(artifact.provenance) : null
    );
  }

  listArtifacts(runId: string): Artifact[] {
    return (this.db.query(`
      SELECT * FROM artifacts
      WHERE run_id = ?
      ORDER BY created_at ASC, id ASC
    `).all(runId) as ArtifactRow[]).map(mapArtifact);
  }

  insertScore(input: {
    runId: string;
    subjectId: string;
    scorer: string;
    score: number;
    rubric: Record<string, unknown>;
    faultAfter?: "after_score_insert";
  }): StoredScore {
    this.requireRun(input.runId);
    const stored: StoredScore = {
      id: makeId("score"),
      runId: input.runId,
      subjectId: input.subjectId,
      scorer: input.scorer,
      score: input.score,
      rubric: redactJson(input.rubric),
      createdAt: nowIso()
    };
    const insertAtomically = this.db.transaction(() => {
      this.db.query(`
        INSERT INTO scores (id, run_id, subject_id, scorer, score, rubric_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        stored.id,
        stored.runId,
        stored.subjectId,
        stored.scorer,
        stored.score,
        JSON.stringify(stored.rubric),
        stored.createdAt
      );
      if (input.faultAfter === "after_score_insert") {
        throw new Error("Injected score persistence fault after score row insert.");
      }
      this.appendEvent(stored.runId, "evidence.scored", {
        scoreId: stored.id,
        subjectId: stored.subjectId,
        scorer: stored.scorer,
        score: stored.score,
        rubric: stored.rubric
      });
    });
    insertAtomically();
    this.refreshLedgerWitness(stored.runId);
    return stored;
  }

  listScores(runId: string): StoredScore[] {
    this.requireRun(runId);
    return (this.db.query(`
      SELECT * FROM scores
      WHERE run_id = ?
      ORDER BY created_at ASC, id ASC
    `).all(runId) as ScoreRow[]).map(mapScore);
  }

  prepareExternalOperation(input: {
    runId: string;
    operationType: string;
    provider?: string;
    idempotencyKey: string;
    requestHash: string;
    reserve: Partial<BudgetUsage>;
    budgetCaps?: BudgetHardCaps;
    requestArtifactId?: string;
    remoteAdmissionEventId?: string;
    admissionArtifactIds?: string[];
    requiresRemoteAdmission?: boolean;
    retryOfOperationId?: string;
    faultAfter?: ExternalOperationPrepareFault;
  }): PrepareExternalOperationResult {
    const prepareAtomically = this.db.transaction((): PrepareExternalOperationResult => {
      const run = this.requireRun(input.runId);
      if (input.requestArtifactId) {
        this.requireArtifact(input.runId, input.requestArtifactId, "prepare external operation");
      }
      const admissionArtifactIds = input.admissionArtifactIds ?? [];
      for (const artifactId of admissionArtifactIds) {
        this.requireArtifact(input.runId, artifactId, "prepare external operation");
      }
      if (input.requiresRemoteAdmission && admissionArtifactIds.length === 0) {
        throw new Error(`External operation ${input.idempotencyKey} requires persisted remote admission artifacts.`);
      }

      const existing = this.getExternalOperationByIdempotencyKey(input.runId, input.idempotencyKey);
      if (existing) {
        if (existing.requestHash !== input.requestHash) {
          throw new Error(`External operation idempotency key collision for ${input.idempotencyKey}.`);
        }
        return { ok: true, created: false, operation: existing };
      }

      const reserve = normalizeBudgetUsage(input.reserve);
      if (isZeroBudgetUsage(reserve)) {
        throw new Error("Budget reservations must reserve at least one finite budget dimension.");
      }
      const usage = this.getBudgetUsage(input.runId);
      const budgetCheck = checkBudget(run, usage, reserve);
      this.appendEvent(input.runId, "budget.checked", {
        ok: budgetCheck.ok,
        reason: budgetCheck.reason ?? null,
        reserve,
        budget: run.budget,
        usage,
        operationType: input.operationType,
        operationId: input.idempotencyKey,
        provider: input.provider
      });
      throwPrepareFault(input.faultAfter, "after_budget_checked");
      if (!budgetCheck.ok) {
        return { ok: false, reason: budgetCheck.reason ?? "budget exhausted" };
      }

      const hardCapCheck = this.checkBudgetHardCapsForReservation({
        runId: input.runId,
        reserve,
        budgetCaps: input.budgetCaps,
        operationType: input.operationType,
        operationId: input.idempotencyKey,
        provider: input.provider
      });
      if (!hardCapCheck.ok) return hardCapCheck;

      const reservationId = makeId("budgetres");
      this.appendEvent(input.runId, "budget.reserved", {
        reservationId,
        reserve,
        operationType: input.operationType,
        operationId: input.idempotencyKey,
        provider: input.provider
      });
      throwPrepareFault(input.faultAfter, "after_budget_reserved");

      const now = nowIso();
      const operation: ExternalOperation = {
        id: makeId("extop"),
        runId: input.runId,
        operationType: input.operationType,
        provider: input.provider,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        requestArtifactId: input.requestArtifactId,
        reservationId,
        status: "reserved",
        retryOfOperationId: input.retryOfOperationId,
        attempt: this.nextExternalOperationAttempt(input.runId, input.retryOfOperationId),
        createdAt: now,
        updatedAt: now
      };

      this.db.query(`
        INSERT INTO external_operations (
          id, run_id, operation_type, provider, idempotency_key, request_hash,
          request_artifact_id, response_artifact_id, reservation_id, status,
          retry_of_operation_id, attempt, error_message, created_at, started_at,
          completed_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        operation.id,
        operation.runId,
        operation.operationType,
        operation.provider ?? null,
        operation.idempotencyKey,
        operation.requestHash,
        operation.requestArtifactId ?? null,
        null,
        operation.reservationId,
        operation.status,
        operation.retryOfOperationId ?? null,
        operation.attempt,
        null,
        operation.createdAt,
        null,
        null,
        operation.updatedAt
      );
      throwPrepareFault(input.faultAfter, "after_external_operation_inserted");
      this.appendEvent(input.runId, "external.operation.reserved", {
        operationId: operation.id,
        operationType: operation.operationType,
        provider: operation.provider,
        idempotencyKey: operation.idempotencyKey,
        requestHash: operation.requestHash,
        requestArtifactId: operation.requestArtifactId,
        reservationId: operation.reservationId,
        remoteAdmissionEventId: input.remoteAdmissionEventId,
        admissionArtifactIds,
        requiresRemoteAdmission: Boolean(input.requiresRemoteAdmission),
        retryOfOperationId: operation.retryOfOperationId,
        attempt: operation.attempt
      }, [operation.requestArtifactId, ...admissionArtifactIds].filter((id): id is string => Boolean(id)));
      throwPrepareFault(input.faultAfter, "after_external_operation_reserved_event");
      return { ok: true, created: true, operation };
    });
    const result = prepareAtomically.immediate();
    this.refreshLedgerWitness(input.runId);
    return result;
  }

  startExternalOperation(operationId: string): ExternalOperation {
    const operation = this.requireExternalOperation(operationId);
    if (operation.status !== "reserved") {
      throw new Error(`Cannot start external operation ${operationId} in status ${operation.status}.`);
    }
    this.requireExternalOperationPrepareEnvelope(operation);
    const now = nowIso();
    this.db.query(`
      UPDATE external_operations
      SET status = 'running', started_at = ?, updated_at = ?
      WHERE id = ? AND status = 'reserved'
    `).run(now, now, operationId);
    const updated = this.requireExternalOperation(operationId);
    this.appendEvent(updated.runId, "external.operation.started", {
      operationId: updated.id,
      operationType: updated.operationType,
      provider: updated.provider,
      idempotencyKey: updated.idempotencyKey,
      requestHash: updated.requestHash,
      reservationId: updated.reservationId
    }, updated.requestArtifactId ? [updated.requestArtifactId] : []);
    return updated;
  }

  completeExternalOperation(input: {
    operationId: string;
    responseArtifactId: string;
    debit: Partial<BudgetUsage>;
    overReservationPolicy?: BudgetOverReservationPolicy;
    provider?: string;
    workerId?: string;
    phase?: string;
  }): ExternalOperation {
    const operation = this.requireExternalOperation(input.operationId);
    if (operation.status !== "running" && operation.status !== "reserved") {
      throw new Error(`Cannot complete external operation ${operation.id} in status ${operation.status}.`);
    }
    const terminalStatus = this.terminalRunStatus(operation.runId);
    if (terminalStatus) {
      this.ignoreExternalOperationAfterTerminal(operation, "complete", terminalStatus, input.responseArtifactId);
      throw new Error(`Cannot complete external operation after terminal run ${operation.runId} is ${terminalStatus}.`);
    }
    this.debitBudget({
      runId: operation.runId,
      reservationId: operation.reservationId,
      debit: input.debit,
      overReservationPolicy: input.overReservationPolicy,
      provider: input.provider ?? operation.provider,
      workerId: input.workerId,
      phase: input.phase
    });
    const now = nowIso();
    this.db.query(`
      UPDATE external_operations
      SET status = 'succeeded',
          response_artifact_id = ?,
          completed_at = ?,
          updated_at = ?
      WHERE id = ?
    `).run(input.responseArtifactId, now, now, operation.id);
    const updated = this.requireExternalOperation(operation.id);
    this.appendEvent(updated.runId, "external.operation.completed", {
      operationId: updated.id,
      operationType: updated.operationType,
      provider: updated.provider,
      idempotencyKey: updated.idempotencyKey,
      requestHash: updated.requestHash,
      reservationId: updated.reservationId,
      responseArtifactId: updated.responseArtifactId,
      debit: normalizeBudgetUsage(input.debit),
      cancellationSettlement: cancellationSettlementForExternalOperation({ status: "completed" })
    }, [updated.requestArtifactId, updated.responseArtifactId].filter((id): id is string => Boolean(id)));
    return updated;
  }

  failExternalOperation(input: {
    operationId: string;
    errorMessage: string;
    debit?: Partial<BudgetUsage>;
    overReservationPolicy?: BudgetOverReservationPolicy;
    releaseReason?: string;
    provider?: string;
    errorArtifactId?: string;
  }): ExternalOperation {
    const operation = this.requireExternalOperation(input.operationId);
    if (operation.status !== "running" && operation.status !== "reserved") {
      throw new Error(`Cannot fail external operation ${operation.id} in status ${operation.status}.`);
    }
    if (input.debit && !isZeroBudgetUsage(normalizeBudgetUsage(input.debit))) {
      this.debitBudget({
        runId: operation.runId,
        reservationId: operation.reservationId,
        debit: input.debit,
        overReservationPolicy: input.overReservationPolicy,
        provider: input.provider ?? operation.provider
      });
    } else {
      this.releaseBudget({
        runId: operation.runId,
        reservationId: operation.reservationId,
        reason: input.releaseReason ?? input.errorMessage
      });
    }
    const now = nowIso();
    const redactedError = String(redactJson(input.errorMessage));
    this.db.query(`
      UPDATE external_operations
      SET status = 'failed',
          error_message = ?,
          completed_at = ?,
          updated_at = ?
      WHERE id = ?
    `).run(redactedError, now, now, operation.id);
    const updated = this.requireExternalOperation(operation.id);
    this.appendEvent(updated.runId, "external.operation.failed", {
      operationId: updated.id,
      operationType: updated.operationType,
      provider: updated.provider,
      idempotencyKey: updated.idempotencyKey,
      requestHash: updated.requestHash,
      reservationId: updated.reservationId,
      errorArtifactId: input.errorArtifactId,
      errorMessage: redactedError,
      settled: input.debit ? "debited" : "released",
      cancellationSettlement: cancellationSettlementForExternalOperation({
        status: "failed",
        debited: Boolean(input.debit && !isZeroBudgetUsage(normalizeBudgetUsage(input.debit)))
      })
    }, [updated.requestArtifactId, input.errorArtifactId].filter((id): id is string => Boolean(id)));
    return updated;
  }

  listExternalOperations(runId: string): ExternalOperation[] {
    this.requireRun(runId);
    return (this.db.query(`
      SELECT * FROM external_operations
      WHERE run_id = ?
      ORDER BY created_at ASC, id ASC
    `).all(runId) as ExternalOperationRow[]).map(mapExternalOperation);
  }

  requireExternalOperation(operationId: string): ExternalOperation {
    const row = this.db.query("SELECT * FROM external_operations WHERE id = ?").get(operationId) as ExternalOperationRow | null;
    if (!row) throw new Error(`External operation not found: ${operationId}`);
    return mapExternalOperation(row);
  }

  reconcileOpenExternalOperations(runId: string, reason: string): number {
    const openOperations = this.listExternalOperations(runId)
      .filter((operation) => operation.status === "reserved" || operation.status === "running");
    for (const operation of openOperations) {
      if (operation.status === "running") {
        if (isRemoteDispatchOperation(operation)) {
          this.markExternalOperationDeadLettered(operation.id, reason);
        } else {
          this.markExternalOperationUnknown(operation.id, reason);
        }
      } else {
        this.releaseExternalOperation(operation.id, reason);
      }
    }
    return openOperations.length;
  }

  private markExternalOperationUnknown(operationId: string, reason: string): ExternalOperation {
    const operation = this.requireExternalOperation(operationId);
    if (operation.status !== "running") {
      throw new Error(`Cannot mark external operation ${operation.id} unknown in status ${operation.status}.`);
    }
    const now = nowIso();
    const redactedReason = String(redactJson(reason));
    this.db.query(`
      UPDATE external_operations
      SET status = 'unknown_remote_outcome',
          error_message = ?,
          completed_at = ?,
          updated_at = ?
      WHERE id = ?
    `).run(redactedReason, now, now, operation.id);
    const updated = this.requireExternalOperation(operation.id);
    this.appendEvent(updated.runId, "external.operation.unknown", {
      operationId: updated.id,
      operationType: updated.operationType,
      provider: updated.provider,
      idempotencyKey: updated.idempotencyKey,
      requestHash: updated.requestHash,
      reservationId: updated.reservationId,
      reason: redactedReason,
      cancellationSettlement: cancellationSettlementForExternalOperation({ status: "unknown" }),
      retryPolicy: "explicit_retry_required",
      quarantine: {
        status: "quarantined",
        canSatisfyGoalEvidence: false,
        reservationPolicy: "retained_until_operator_reconciliation",
        operatorAction: "inspect the external provider/tool/verifier/sandbox side effect before retrying with a new audited operation"
      }
    }, updated.requestArtifactId ? [updated.requestArtifactId] : []);
    return updated;
  }

  private markExternalOperationDeadLettered(operationId: string, reason: string): ExternalOperation {
    const operation = this.requireExternalOperation(operationId);
    if (operation.status !== "running") {
      throw new Error(`Cannot dead-letter external operation ${operation.id} in status ${operation.status}.`);
    }
    const now = nowIso();
    const redactedReason = String(redactJson(reason));
    this.db.query(`
      UPDATE external_operations
      SET status = 'dead_lettered',
          error_message = ?,
          completed_at = ?,
          updated_at = ?
      WHERE id = ?
    `).run(redactedReason, now, now, operation.id);
    const updated = this.requireExternalOperation(operation.id);
    this.appendEvent(updated.runId, "external.operation.dead_lettered", {
      operationId: updated.id,
      operationType: updated.operationType,
      provider: updated.provider,
      idempotencyKey: updated.idempotencyKey,
      requestHash: updated.requestHash,
      reservationId: updated.reservationId,
      reason: redactedReason,
      cancellationSettlement: cancellationSettlementForExternalOperation({ status: "unknown" }),
      retryPolicy: "new_dispatch_required",
      deadLetter: {
        status: "dead_lettered",
        canSatisfyGoalEvidence: false,
        reservationPolicy: "retained_until_operator_reconciliation",
        acknowledgement: "lost_or_timed_out",
        operatorAction: "inspect the remote dispatch side effect out-of-band and retry with a new audited dispatch"
      }
    }, updated.requestArtifactId ? [updated.requestArtifactId] : []);
    return updated;
  }

  private ignoreExternalOperationAfterTerminal(
    operation: ExternalOperation,
    action: "start" | "complete" | "fail",
    runStatus: GoalStatus,
    artifactId?: string
  ): ExternalOperation {
    if (operation.status === "running") {
      const now = nowIso();
      this.db.query(`
        UPDATE external_operations
        SET status = 'unknown_remote_outcome',
            error_message = ?,
            completed_at = ?,
            updated_at = ?
        WHERE id = ?
      `).run(`ignored ${action} after terminal run ${runStatus}`, now, now, operation.id);
    }
    const updated = this.requireExternalOperation(operation.id);
    this.appendEvent(updated.runId, "external.operation.ignored", {
      operationId: updated.id,
      operationType: updated.operationType,
      provider: updated.provider,
      idempotencyKey: updated.idempotencyKey,
      requestHash: updated.requestHash,
      reservationId: updated.reservationId,
      action,
      runStatus,
      ignored: true,
      cancellationSettlement: operation.status === "running" ? "unknown" : "released",
      terminalArbiter: terminalMutationArbiter(runStatus, "post_terminal_mutation"),
      quarantine: {
        status: "quarantined",
        canSatisfyGoalEvidence: false,
        reservationPolicy: operation.status === "running" ? "retained_until_operator_reconciliation" : "reserved_operation_not_started",
        operatorAction: "inspect or reconcile this external operation before any retry"
      }
    }, [updated.requestArtifactId, artifactId].filter((id): id is string => Boolean(id)));
    return updated;
  }

  reserveBudget(input: {
    runId: string;
    reserve: Partial<BudgetUsage>;
    budgetCaps?: BudgetHardCaps;
    operationType: string;
    operationId?: string;
    workerId?: string;
    phase?: string;
    provider?: string;
    reservationId?: string;
  }): BudgetReservationResult {
    const reserve = normalizeBudgetUsage(input.reserve);
    if (isZeroBudgetUsage(reserve)) {
      throw new Error("Budget reservations must reserve at least one finite budget dimension.");
    }

    const reserveAtomically = this.db.transaction((): BudgetReservationResult => {
      const run = this.requireRun(input.runId);
      const usage = this.getBudgetUsage(input.runId);
      const budgetCheck = checkBudget(run, usage, reserve);
      this.appendEvent(input.runId, "budget.checked", {
        ok: budgetCheck.ok,
        reason: budgetCheck.reason ?? null,
        reserve,
        budget: run.budget,
        usage,
        operationType: input.operationType,
        operationId: input.operationId,
        workerId: input.workerId,
        phase: input.phase,
        provider: input.provider
      });
      if (!budgetCheck.ok) {
        return { ok: false, reason: budgetCheck.reason ?? "budget exhausted" };
      }

      const hardCapCheck = this.checkBudgetHardCapsForReservation({
        runId: input.runId,
        reserve,
        budgetCaps: input.budgetCaps,
        operationType: input.operationType,
        operationId: input.operationId,
        workerId: input.workerId,
        phase: input.phase,
        provider: input.provider
      });
      if (!hardCapCheck.ok) return hardCapCheck;

      const reservationId = input.reservationId ?? makeId("budgetres");
      if (this.getBudgetReservationState(input.runId, reservationId)) {
        throw new Error(`Budget reservation already exists: ${reservationId}.`);
      }
      this.appendEvent(input.runId, "budget.reserved", {
        reservationId,
        reserve,
        operationType: input.operationType,
        operationId: input.operationId,
        workerId: input.workerId,
        phase: input.phase,
        provider: input.provider
      });
      return { ok: true, reservationId };
    });
    const result = reserveAtomically.immediate();
    this.refreshLedgerWitness(input.runId);
    return result;
  }

  releaseBudget(input: {
    runId: string;
    reservationId: string;
    reason: string;
  }): void {
    const state = this.requireOpenBudgetReservation(input.runId, input.reservationId, "release");
    this.appendEvent(input.runId, "budget.released", {
      reservationId: input.reservationId,
      release: state.reserve,
      reason: input.reason,
      operationType: state.operationType,
      operationId: state.operationId
    });
  }

  debitBudget(input: {
    runId: string;
    reservationId: string;
    debit: Partial<BudgetUsage>;
    overReservationPolicy?: BudgetOverReservationPolicy;
    phase?: string;
    workerId?: string;
    provider?: string;
  }): void {
    const state = this.requireOpenBudgetReservation(input.runId, input.reservationId, "debit");
    const debit = normalizeBudgetUsage(input.debit);
    if (isZeroBudgetUsage(debit)) {
      throw new Error("Budget debits must include at least one finite usage dimension.");
    }
    assertDebitWithinReservation(debit, state.reserve, input.reservationId, input.overReservationPolicy);
    const usage = this.getBudgetUsage(input.runId);
    const event = this.appendEvent(input.runId, "budget.debited", {
      reservationId: input.reservationId,
      debit,
      overReservationPolicy: input.overReservationPolicy,
      operationType: state.operationType,
      operationId: state.operationId,
      phase: input.phase,
      workerId: input.workerId,
      provider: input.provider,
      usage: {
        attempts: usage.attempts - state.reserve.attempts + debit.attempts,
        tokens: usage.tokens - state.reserve.tokens + debit.tokens,
        usd: usage.usd - state.reserve.usd + debit.usd,
        elapsedMs: usage.elapsedMs - state.reserve.elapsedMs + debit.elapsedMs,
        artifactBytes: usage.artifactBytes - state.reserve.artifactBytes + debit.artifactBytes,
        sourceQueries: usage.sourceQueries - state.reserve.sourceQueries + debit.sourceQueries,
        retries: usage.retries - state.reserve.retries + debit.retries,
        sandboxMs: usage.sandboxMs - state.reserve.sandboxMs + debit.sandboxMs
      }
    });
    this.db.query(`
      INSERT INTO budget_debits (
        id, run_id, event_id, phase, worker_id, provider,
        attempts, tokens, usd, elapsed_ms, artifact_bytes, source_queries,
        retries, sandbox_ms, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      makeId("debit"),
      input.runId,
      event.id,
      input.phase ?? null,
      input.workerId ?? null,
      input.provider ?? null,
      debit.attempts,
      debit.tokens,
      debit.usd,
      debit.elapsedMs,
      debit.artifactBytes,
      debit.sourceQueries,
      debit.retries,
      debit.sandboxMs,
      event.createdAt
    );
  }

  reconcileOpenBudgetReservations(runId: string, reason: string): number {
    const unknownExternalReservationIds = new Set(this.listExternalOperations(runId)
      .filter((operation) => operation.status === "unknown_remote_outcome" || operation.status === "dead_lettered")
      .map((operation) => operation.reservationId));
    const openReservations = this.listOpenBudgetReservations(runId);
    let reconciled = 0;
    for (const reservation of openReservations) {
      if (unknownExternalReservationIds.has(reservation.reservationId)) continue;
      this.releaseBudget({ runId, reservationId: reservation.reservationId, reason });
      reconciled += 1;
    }
    return reconciled;
  }

  enqueueWorkerJob(input: {
    runId: string;
    kind: string;
    payload: Record<string, unknown>;
    maxAttempts?: number;
    dedupeKey?: string;
  }): WorkerJob {
    this.requireRun(input.runId);
    const now = nowIso();
    const payload = redactJson(input.payload);
    const dedupeKey = input.dedupeKey ?? stableHash({ kind: input.kind, payload });
    const existing = this.getWorkerJobByDedupeKey(input.runId, dedupeKey);
    if (existing) {
      this.appendEvent(input.runId, "worker.deduplicated", {
        existingJobId: existing.id,
        kind: input.kind,
        dedupeKey,
        payload
      });
      return existing;
    }
    const job: WorkerJob = {
      id: makeId("job"),
      runId: input.runId,
      kind: input.kind,
      payload,
      dedupeKey,
      status: "pending",
      attempts: 0,
      maxAttempts: input.maxAttempts ?? 3,
      createdAt: now,
      updatedAt: now
    };

    try {
      this.db.query(`
        INSERT INTO worker_jobs (
          id, run_id, kind, payload_json, dedupe_key, status, lease_owner, lease_expires_at,
          attempts, max_attempts, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        job.id,
        job.runId,
        job.kind,
        this.encryptStorageString(JSON.stringify(job.payload), `worker_job:${job.id}:payload`),
        dedupeKey,
        job.status,
        null,
        null,
        job.attempts,
        job.maxAttempts,
        job.createdAt,
        job.updatedAt
      );
    } catch (error) {
      const duplicate = this.getWorkerJobByDedupeKey(input.runId, dedupeKey);
      if (!duplicate) throw error;
      this.appendEvent(input.runId, "worker.deduplicated", {
        existingJobId: duplicate.id,
        kind: input.kind,
        dedupeKey,
        payload
      });
      return duplicate;
    }

    this.appendEvent(job.runId, "worker.enqueued", {
      ...workerLeaseTransitionPayload({
        jobId: job.id,
        actor: "worker-queue",
        reason: "worker job enqueued",
        priorState: "queued",
        nextStatus: job.status,
        attempt: job.attempts,
        maxAttempts: job.maxAttempts
      }),
      jobId: job.id,
      kind: job.kind,
      payload: job.payload,
      dedupeKey: job.dedupeKey,
      maxAttempts: job.maxAttempts
    });

    return job;
  }

  listWorkerJobs(runId: string): WorkerJob[] {
    return (this.db.query(`
      SELECT * FROM worker_jobs
      WHERE run_id = ?
      ORDER BY created_at ASC, id ASC
    `).all(runId) as WorkerJobRow[]).map((row) => mapWorkerJob(row, this.storageRoot));
  }

  leaseWorkerJobs(runId: string, owner: string, limit: number, leaseMs: number, reservationIds: string[] = []): WorkerJob[] {
    const run = this.requireRun(runId);
    if (isTerminal(run.status)) {
      this.appendEvent(runId, "worker.mutation.ignored", {
        action: "lease",
        owner,
        limit,
        runStatus: run.status,
        ignored: true,
        terminalArbiter: terminalMutationArbiter(run.status, "post_terminal_mutation")
      });
      return [];
    }
    if (limit <= 0) return [];

    const now = nowIso();
    const expiresAt = new Date(Date.now() + leaseMs).toISOString();
    const candidates = this.db.query(`
      SELECT * FROM worker_jobs
      WHERE run_id = ?
        AND (
          status = 'pending'
          OR (
            status IN ('leased', 'running')
            AND lease_expires_at IS NOT NULL
            AND lease_expires_at < ?
          )
          OR status = 'failed_retryable'
        )
        AND attempts < max_attempts
      ORDER BY created_at ASC, id ASC
      LIMIT ?
    `).all(runId, now, limit) as WorkerJobRow[];

    const jobs: WorkerJob[] = [];
    const leaseOne = this.db.transaction((row: WorkerJobRow, index: number) => {
      const previous = mapWorkerJob(row, this.storageRoot);
      const reservationId = reservationIds[index] ?? this.latestWorkerReservationId(runId, previous.id) ?? "unbound";
      this.db.query(`
        UPDATE worker_jobs
        SET status = 'leased',
            lease_owner = ?,
            lease_expires_at = ?,
            attempts = attempts + 1,
            updated_at = ?
        WHERE id = ?
          AND status = ?
          AND attempts = ?
      `).run(owner, expiresAt, now, row.id, row.status, row.attempts);

      const updated = this.requireWorkerJob(row.id);
      if (updated.status !== "leased" || updated.leaseOwner !== owner || updated.attempts !== previous.attempts + 1) {
        return undefined;
      }
      this.appendEvent(runId, "worker.leased", {
        ...workerLeaseTransitionPayload({
          jobId: updated.id,
          actor: owner,
          reason: "worker lease acquired",
          priorStatus: previous.status,
          nextStatus: updated.status,
          attempt: updated.attempts,
          maxAttempts: updated.maxAttempts,
          leaseExpiresAt: expiresAt,
          reservationId
        }),
        jobId: updated.id,
        owner,
        previousStatus: previous.status,
        attempts: updated.attempts,
        leaseExpiresAt: expiresAt
      });
      return updated;
    });

    for (const [index, candidate] of candidates.entries()) {
      const leased = leaseOne(candidate, index);
      if (leased) jobs.push(leased);
    }
    if (jobs.length > 0) this.refreshLedgerWitness(runId);
    return jobs;
  }

  countLeasableWorkerJobs(runId: string, now = nowIso()): number {
    this.requireRun(runId);
    const row = this.db.query(`
      SELECT COUNT(*) AS count FROM worker_jobs
      WHERE run_id = ?
        AND (
          status = 'pending'
          OR (
            status IN ('leased', 'running')
            AND lease_expires_at IS NOT NULL
            AND lease_expires_at < ?
          )
          OR status = 'failed_retryable'
        )
        AND attempts < max_attempts
    `).get(runId, now) as { count: number };
    return row.count;
  }

  markWorkerJobRunning(jobId: string, owner: string, expectedAttempt: number): WorkerJob {
    const job = this.requireWorkerJob(jobId);
    const terminalStatus = this.terminalRunStatus(job.runId);
    if (terminalStatus) {
      this.ignoreWorkerMutationAfterTerminal(job, "start", terminalStatus, { owner, expectedAttempt });
      throw new Error(`Cannot start worker job after terminal run ${job.runId} is ${terminalStatus}.`);
    }
    this.requireActiveLease(job, owner, expectedAttempt, "start");
    if (job.status !== "leased") {
      throw new Error(`Cannot start job ${jobId} in status ${job.status}.`);
    }
    const reservationId = this.latestWorkerReservationId(job.runId, job.id, job.attempts) ?? "unbound";
    const updated = this.updateWorkerJob(jobId, {
      status: "running",
      leaseOwner: job.leaseOwner,
      leaseExpiresAt: job.leaseExpiresAt
    });
    this.appendEvent(updated.runId, "worker.started", {
      ...workerLeaseTransitionPayload({
        jobId,
        actor: owner,
        reason: "worker execution started",
        priorStatus: job.status,
        nextStatus: updated.status,
        attempt: updated.attempts,
        maxAttempts: updated.maxAttempts,
        leaseExpiresAt: updated.leaseExpiresAt,
        reservationId
      }),
      jobId,
      owner: updated.leaseOwner,
      attempts: updated.attempts
    });
    return updated;
  }

  heartbeatWorkerJob(jobId: string, owner: string, expectedAttempt: number, leaseMs: number): WorkerJob {
    const job = this.requireWorkerJob(jobId);
    const terminalStatus = this.terminalRunStatus(job.runId);
    if (terminalStatus) {
      this.ignoreWorkerMutationAfterTerminal(job, "heartbeat", terminalStatus, { owner, expectedAttempt });
      throw new Error(`Cannot heartbeat worker job after terminal run ${job.runId} is ${terminalStatus}.`);
    }
    this.requireActiveLease(job, owner, expectedAttempt, "heartbeat");
    if (job.status !== "leased" && job.status !== "running") {
      throw new Error(`Cannot heartbeat job ${jobId} in status ${job.status}.`);
    }
    const leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
    const reservationId = this.latestWorkerReservationId(job.runId, job.id, job.attempts) ?? "unbound";
    const updated = this.updateWorkerJob(jobId, {
      status: job.status,
      leaseOwner: job.leaseOwner,
      leaseExpiresAt
    });
    this.appendEvent(updated.runId, "worker.heartbeat", {
      ...workerLeaseTransitionPayload({
        jobId,
        actor: owner,
        reason: "worker lease heartbeat",
        priorStatus: job.status,
        nextStatus: updated.status,
        attempt: updated.attempts,
        maxAttempts: updated.maxAttempts,
        leaseExpiresAt,
        reservationId
      }),
      jobId,
      owner: updated.leaseOwner,
      leaseExpiresAt
    });
    return updated;
  }

  commitWorkerJob(jobId: string, owner: string, expectedAttempt: number, result: Record<string, unknown> = {}): WorkerJob {
    const job = this.requireWorkerJob(jobId);
    const terminalStatus = this.terminalRunStatus(job.runId);
    if (terminalStatus) {
      this.ignoreWorkerMutationAfterTerminal(job, "commit", terminalStatus, { owner, expectedAttempt, resultHash: stableHash(result) });
      throw new Error(`Cannot commit worker job after terminal run ${job.runId} is ${terminalStatus}.`);
    }
    this.requireActiveLease(job, owner, expectedAttempt, "commit");
    if (job.status !== "leased" && job.status !== "running") {
      throw new Error(`Cannot commit job ${jobId} in status ${job.status}.`);
    }
    const reservationId = this.latestWorkerReservationId(job.runId, job.id, job.attempts) ?? "unbound";
    const updated = this.updateWorkerJob(jobId, {
      status: "committed",
      leaseOwner: undefined,
      leaseExpiresAt: undefined
    });
    const resultArtifactIds = artifactIdsFromValue(result);
    this.appendEvent(updated.runId, "worker.committed", {
      ...workerLeaseTransitionPayload({
        jobId,
        actor: owner,
        reason: "worker committed result",
        priorStatus: job.status,
        nextStatus: updated.status,
        attempt: updated.attempts,
        maxAttempts: updated.maxAttempts,
        reservationId
      }),
      jobId,
      result,
      attempts: updated.attempts
    }, resultArtifactIds);
    this.appendEvent(updated.runId, "worker.completed", {
      ...workerLeaseTransitionPayload({
        jobId,
        actor: owner,
        reason: "worker completed after commit",
        priorStatus: updated.status,
        nextStatus: updated.status,
        attempt: updated.attempts,
        maxAttempts: updated.maxAttempts,
        reservationId
      }),
      jobId,
      result,
      attempts: updated.attempts
    }, resultArtifactIds);
    return updated;
  }

  failWorkerJob(jobId: string, owner: string, expectedAttempt: number, error: string, retryable = true): WorkerJob {
    const job = this.requireWorkerJob(jobId);
    const terminalStatus = this.terminalRunStatus(job.runId);
    if (terminalStatus) {
      this.ignoreWorkerMutationAfterTerminal(job, "fail", terminalStatus, { owner, expectedAttempt, retryable, error: String(redactJson(error)) });
      throw new Error(`Cannot fail worker job after terminal run ${job.runId} is ${terminalStatus}.`);
    }
    this.requireActiveLease(job, owner, expectedAttempt, "fail");
    if (job.status !== "leased" && job.status !== "running") {
      throw new Error(`Cannot fail job ${jobId} in status ${job.status}.`);
    }
    const status: WorkerJobStatus = retryable && job.attempts < job.maxAttempts
      ? "failed_retryable"
      : "failed_terminal";
    const reservationId = this.latestWorkerReservationId(job.runId, job.id, job.attempts) ?? "unbound";
    const updated = this.updateWorkerJob(jobId, {
      status,
      leaseOwner: undefined,
      leaseExpiresAt: undefined
    });
    this.appendEvent(updated.runId, "worker.failed", {
      ...workerLeaseTransitionPayload({
        jobId,
        actor: owner,
        reason: "worker execution failed",
        priorStatus: job.status,
        nextStatus: updated.status,
        attempt: updated.attempts,
        maxAttempts: updated.maxAttempts,
        reservationId
      }),
      jobId,
      error,
      retryable: status === "failed_retryable",
      attempts: updated.attempts
    });
    return updated;
  }

  cancelWorkerJob(jobId: string, reason: string, owner: string, expectedAttempt: number): WorkerJob {
    const job = this.requireWorkerJob(jobId);
    if (this.terminalRunStatus(job.runId) === "goal_met") {
      this.ignoreWorkerMutationAfterTerminal(job, "cancel", "goal_met", { owner, expectedAttempt, reason });
      throw new Error(`Cannot cancel worker job after terminal run ${job.runId} is goal_met.`);
    }
    this.requireActiveLease(job, owner, expectedAttempt, "cancel");
    return this.cancelWorkerJobAsSystem(jobId, reason);
  }

  cancelPendingWorkerJobs(runId: string, reason: string): WorkerJob[] {
    const cancellable = this.listWorkerJobs(runId)
      .filter((job) => job.status === "pending" || job.status === "leased" || job.status === "running" || job.status === "failed_retryable");
    return cancellable.map((job) => this.cancelWorkerJobAsSystem(job.id, reason));
  }

  cancelQueuedWorkerJobs(runId: string, reason: string): WorkerJob[] {
    const cancellable = this.listWorkerJobs(runId)
      .filter((job) => job.status === "pending" || job.status === "failed_retryable");
    return cancellable.map((job) => this.cancelWorkerJobAsSystem(job.id, reason));
  }

  cancelWorkerJobAsSystemForPreflight(jobId: string, reason: string): WorkerJob {
    const job = this.requireWorkerJob(jobId);
    if (job.kind !== "safety.preflight.cancellation") {
      throw new Error(`Cannot preflight-cancel non-preflight job ${job.id}.`);
    }
    if (job.status !== "pending" && job.status !== "leased" && job.status !== "running" && job.status !== "failed_retryable") {
      throw new Error(`Cannot preflight-cancel job ${job.id} in status ${job.status}.`);
    }
    return this.cancelWorkerJobAsSystem(job.id, reason);
  }

  revokeWorkerJob(jobId: string, reason: string, actor = "lease-revoker"): WorkerJob {
    const job = this.requireWorkerJob(jobId);
    if (job.status !== "pending" && job.status !== "leased" && job.status !== "running" && job.status !== "failed_retryable") {
      throw new Error(`Cannot revoke job ${job.id} in status ${job.status}.`);
    }
    const reservationId = this.latestWorkerReservationId(job.runId, job.id, job.attempts) ?? "unbound";
    const updated = this.updateWorkerJob(jobId, {
      status: "cancelled",
      leaseOwner: undefined,
      leaseExpiresAt: undefined
    });
    this.appendEvent(updated.runId, "worker.revoked", {
      ...workerLeaseTransitionPayload({
        jobId,
        actor,
        reason,
        priorStatus: job.status,
        nextState: "revoked",
        attempt: job.attempts,
        maxAttempts: job.maxAttempts,
        leaseExpiresAt: job.leaseExpiresAt,
        reservationId
      }),
      jobId,
      owner: job.leaseOwner,
      previousStatus: job.status
    });
    this.appendEvent(updated.runId, "worker.cancelled", {
      ...workerLeaseTransitionPayload({
        jobId,
        actor,
        reason,
        priorState: "revoked",
        nextStatus: updated.status,
        attempt: updated.attempts,
        maxAttempts: updated.maxAttempts,
        reservationId
      }),
      jobId,
      reason,
      previousStatus: job.status,
      cancellationSettlement: job.status === "pending" || job.status === "failed_retryable" ? "avoided" : "unknown"
    });
    return updated;
  }

  reconcileStaleWorkerJobs(runId: string, now = nowIso(), reaperId = "lease-reaper"): WorkerJob[] {
    this.requireRun(runId);
    const stale = this.listWorkerJobs(runId)
      .filter((job) =>
        (job.status === "leased" || job.status === "running") &&
        Boolean(job.leaseExpiresAt) &&
        job.leaseExpiresAt! < now
      );
    const reconciled: WorkerJob[] = [];
    for (const job of stale) {
      const status: WorkerJobStatus = job.attempts < job.maxAttempts ? "failed_retryable" : "failed_terminal";
      const reservationId = this.latestWorkerReservationId(runId, job.id, job.attempts) ?? "unbound";
      this.appendEvent(runId, "worker.stale", {
        ...workerLeaseTransitionPayload({
          jobId: job.id,
          actor: reaperId,
          reason: "stale lease expired",
          priorStatus: job.status,
          nextState: "stale",
          attempt: job.attempts,
          maxAttempts: job.maxAttempts,
          leaseExpiresAt: job.leaseExpiresAt,
          reservationId
        }),
        jobId: job.id,
        leaseOwner: job.leaseOwner,
        leaseExpiresAt: job.leaseExpiresAt
      });
      const updated = this.updateWorkerJob(job.id, {
        status,
        leaseOwner: undefined,
        leaseExpiresAt: undefined
      });
      this.appendEvent(runId, "worker.reconciled", {
        ...workerLeaseTransitionPayload({
          jobId: job.id,
          actor: reaperId,
          reason: "stale lease expired",
          priorState: "stale",
          nextStatus: status,
          attempt: job.attempts,
          maxAttempts: job.maxAttempts,
          leaseExpiresAt: job.leaseExpiresAt,
          reservationId
        }),
        jobId: job.id,
        previousStatus: job.status,
        status,
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
        reason: "stale lease expired",
        reaperId,
        leaseOwner: job.leaseOwner,
        leaseExpiresAt: job.leaseExpiresAt
      });
      if (status === "failed_terminal") {
        this.appendEvent(runId, "worker.quarantined", {
          ...workerLeaseTransitionPayload({
            jobId: job.id,
            actor: reaperId,
            reason: "poison task reached max attempts after stale lease",
            priorState: "stale",
            nextStatus: status,
            attempt: job.attempts,
            maxAttempts: job.maxAttempts,
            leaseExpiresAt: job.leaseExpiresAt,
            reservationId
          }),
          jobId: job.id,
          previousStatus: job.status,
          status,
          attempts: job.attempts,
          maxAttempts: job.maxAttempts,
          reason: "poison task reached max attempts after stale lease",
          reaperId,
          leaseOwner: job.leaseOwner,
          leaseExpiresAt: job.leaseExpiresAt
        });
      }
      reconciled.push(updated);
    }
    return reconciled;
  }

  requireWorkerJob(jobId: string): WorkerJob {
    const row = this.db.query("SELECT * FROM worker_jobs WHERE id = ?").get(jobId) as WorkerJobRow | null;
    if (!row) throw new Error(`Worker job not found: ${jobId}`);
    return mapWorkerJob(row, this.storageRoot);
  }

  getWorkerJobByDedupeKey(runId: string, dedupeKey: string): WorkerJob | undefined {
    this.requireRun(runId);
    const row = this.db.query(`
      SELECT * FROM worker_jobs
      WHERE run_id = ? AND dedupe_key = ?
    `).get(runId, dedupeKey) as WorkerJobRow | null;
    return row ? mapWorkerJob(row, this.storageRoot) : undefined;
  }

  getBudgetUsage(runId: string, filter: { provider?: string; operationType?: string; phase?: string; since?: string } = {}): BudgetUsage {
    const events = this.listEvents(runId);
    return budgetUsageFromEvents(events, filter);
  }

  getGlobalBudgetUsage(filter: { provider?: string; operationType?: string; phase?: string; since?: string } = {}): BudgetUsage {
    const events = (this.db.query(`
      SELECT * FROM ledger_events
      ORDER BY created_at ASC, sequence ASC, id ASC
    `).all() as EventRow[]).map((row) => mapEvent(row, this.storageRoot));
    return budgetUsageFromEvents(events, filter);
  }

  getMachineAdmissionUsage(filter: { provider?: string; operationType?: string; since?: string } = {}): BudgetUsage {
    const events = (this.db.query(`
      SELECT * FROM ledger_events
      ORDER BY created_at ASC, sequence ASC, id ASC
    `).all() as EventRow[]).map((row) => mapEvent(row, this.storageRoot));
    return machineAdmissionUsageFromEvents(events, filter);
  }

  refreshLedgerWitness(runId: string): LedgerWitnessCheckpoint {
    this.requireRun(runId);
    const checkpoint = buildLedgerWitnessCheckpoint(runId, this.listEvents(runId));
    const path = this.ledgerWitnessPath(runId);
    mkdirSync(dirname(path), { recursive: true });
    const tempPath = `${path}.${makeId("witness")}.tmp`;
    writeFileSync(
      tempPath,
      this.encryptStorageString(`${JSON.stringify(checkpoint, null, 2)}\n`, `ledger_witness:${runId}`),
      { mode: 0o600 }
    );
    renameSync(tempPath, path);
    return checkpoint;
  }

  verifyLedgerWitness(runId: string): LedgerWitnessVerification {
    this.requireRun(runId);
    const path = this.ledgerWitnessPath(runId);
    const expected = buildLedgerWitnessCheckpoint(runId, this.listEvents(runId));
    const issues: LedgerWitnessIssue[] = [];
    if (!existsSync(path)) {
      return {
        ok: false,
        path,
        expected,
        issues: [{
          code: "ledger_witness_missing",
          message: `Ledger witness checkpoint is missing for run ${runId}.`
        }]
      };
    }

    let actual: LedgerWitnessCheckpoint | undefined;
    try {
      actual = JSON.parse(
        decryptStringFromStorage(this.storageRoot, readFileSync(path, "utf8"), `ledger_witness:${runId}`)
      ) as LedgerWitnessCheckpoint;
    } catch (error) {
      return {
        ok: false,
        path,
        expected,
        issues: [{
          code: "ledger_witness_unreadable",
          message: `Ledger witness checkpoint could not be parsed: ${error instanceof Error ? error.message : String(error)}.`
        }]
      };
    }

    if (actual.format !== "matematica.ledger.witness" || actual.version !== 1) {
      issues.push({
        code: "ledger_witness_format_invalid",
        message: `Ledger witness checkpoint has unsupported format or version for run ${runId}.`
      });
    }
    if (actual.runId !== runId) {
      issues.push({
        code: "ledger_witness_run_mismatch",
        message: `Ledger witness run id ${actual.runId} does not match audited run ${runId}.`
      });
    }
    if (actual.checkpointHash !== hashLedgerWitnessComparable(actual)) {
      issues.push({
        code: "ledger_witness_hash_mismatch",
        message: `Ledger witness checkpoint hash does not match its stored contents for run ${runId}.`
      });
    }
    if (stableHash(ledgerWitnessComparable(actual)) !== stableHash(ledgerWitnessComparable(expected))) {
      issues.push({
        code: "ledger_witness_event_log_mismatch",
        message: `Ledger witness checkpoint diverges from the current SQLite event log for run ${runId}.`
      });
    }

    return {
      ok: issues.length === 0,
      path,
      expected,
      actual,
      issues
    };
  }

  listOpenBudgetReservations(runId: string): BudgetReservationState[] {
    this.requireRun(runId);
    const states = new Map<string, BudgetReservationState>();
    for (const event of this.listEvents(runId)) {
      if (event.type === "budget.reserved") {
        const reservationId = stringValue(event.payload.reservationId);
        if (!reservationId) continue;
        states.set(reservationId, {
          reservationId,
          reserve: budgetUsageFromPayload(event.payload.reserve),
          operationType: stringValue(event.payload.operationType),
          operationId: stringValue(event.payload.operationId),
          provider: stringValue(event.payload.provider),
          settled: "open"
        });
      }
      if (event.type === "budget.released" || event.type === "budget.debited") {
        const reservationId = stringValue(event.payload.reservationId);
        if (!reservationId) continue;
        const state = states.get(reservationId);
        if (state) {
          state.settled = event.type === "budget.released" ? "released" : "debited";
        }
      }
    }
    return [...states.values()].filter((state) => state.settled === "open");
  }

  listOpenMachineAdmissionReservations(runId?: string): MachineAdmissionReservationState[] {
    if (runId) this.requireRun(runId);
    const rows = this.db.query(`
      SELECT * FROM ledger_events
      ${runId ? "WHERE run_id = ?" : ""}
      ORDER BY created_at ASC, sequence ASC, id ASC
    `).all(...(runId ? [runId] : [])) as EventRow[];
    return machineAdmissionReservationsFromEvents(rows.map((row) => mapEvent(row, this.storageRoot)))
      .filter((state) => state.settled === "open");
  }

  reserveMachineAdmission(input: {
    runId: string;
    reserve: Partial<BudgetUsage>;
    budgetCaps?: BudgetHardCaps;
    operationType: string;
    operationId: string;
    provider: string;
    modelId: string;
    command: string;
  }): BudgetReservationResult {
    const reserve = normalizeBudgetUsage(input.reserve);
    if (isZeroBudgetUsage(reserve)) {
      throw new Error("Machine admission reservations must reserve at least one finite budget dimension.");
    }

    const reserveAtomically = this.db.transaction((): BudgetReservationResult => {
      this.requireRun(input.runId);
      const existing = this.listOpenMachineAdmissionReservations(input.runId)
        .find((reservation) =>
          reservation.operationType === input.operationType &&
          reservation.operationId === input.operationId &&
          reservation.provider === input.provider &&
          reservation.modelId === input.modelId
        );
      if (existing) return { ok: true, reservationId: existing.reservationId, reused: true };

      const capCheck = this.checkMachineAdmissionHardCaps({
        runId: input.runId,
        reserve,
        budgetCaps: input.budgetCaps,
        operationType: input.operationType,
        operationId: input.operationId,
        provider: input.provider,
        modelId: input.modelId,
        command: input.command
      });
      if (!capCheck.ok) return capCheck;

      const reservationId = makeId("machineadm");
      this.appendEvent(input.runId, "machine.admission.reserved", {
        reservationId,
        reserve,
        operationType: input.operationType,
        operationId: input.operationId,
        provider: input.provider,
        modelId: input.modelId,
        command: input.command,
        scope: "machine"
      });
      return { ok: true, reservationId };
    });
    const result = reserveAtomically.immediate();
    this.refreshLedgerWitness(input.runId);
    return result;
  }

  releaseMachineAdmission(input: {
    runId: string;
    reservationId: string;
    reason: string;
  }): void {
    const state = this.requireOpenMachineAdmissionReservation(input.runId, input.reservationId, "release");
    this.appendEvent(input.runId, "machine.admission.released", {
      reservationId: input.reservationId,
      release: state.reserve,
      reason: input.reason,
      operationType: state.operationType,
      operationId: state.operationId,
      provider: state.provider,
      modelId: state.modelId,
      command: state.command
    });
  }

  reconcileMachineAdmissionReservations(runId: string, reason: string): number {
    const reservations = this.listOpenMachineAdmissionReservations(runId);
    for (const reservation of reservations) {
      this.releaseMachineAdmission({ runId, reservationId: reservation.reservationId, reason });
    }
    return reservations.length;
  }

  acquireProviderRuntimeSlot(input: {
    runId: string;
    provider: string;
    modelId: string;
    operationId: string;
    maxConcurrency: number;
    leaseMs: number;
    now?: Date;
  }): ProviderRuntimeAdmissionResult {
    this.requireRun(input.runId);
    const now = (input.now ?? new Date()).toISOString();
    const leaseMs = finitePositiveInteger(input.leaseMs, 60_000);
    const maxConcurrency = Math.max(0, Math.trunc(input.maxConcurrency));
    const expiresAt = new Date(Date.parse(now) + leaseMs).toISOString();
    const acquire = this.db.transaction((): ProviderRuntimeAdmissionResult => {
      this.deleteExpiredProviderRuntimeLocks(now);
      const state = this.getProviderRuntimeState(input.provider);
      const activeBeforeAcquire = this.countProviderRuntimeLocks(input.provider);
      if (state?.circuit_open_until && state.circuit_open_until > now) {
        return {
          ok: false,
          kind: "circuit_open",
          reason: `provider circuit breaker is open for ${input.provider}`,
          retryAfterMs: Math.max(0, Date.parse(state.circuit_open_until) - Date.parse(now)),
          activeBeforeAcquire,
          maxConcurrency
        };
      }
      if (
        state?.retry_after_until &&
        state.retry_after_until > now &&
        state.retry_after_operation_id !== input.operationId
      ) {
        return {
          ok: false,
          kind: "rate_limited",
          reason: `provider retry-after window is active for ${input.provider}`,
          retryAfterMs: Math.max(0, Date.parse(state.retry_after_until) - Date.parse(now)),
          activeBeforeAcquire,
          maxConcurrency
        };
      }
      if (activeBeforeAcquire >= maxConcurrency) {
        return {
          ok: false,
          kind: "concurrency",
          reason: `provider concurrency cap exceeded for ${input.provider} (${activeBeforeAcquire}/${maxConcurrency})`,
          activeBeforeAcquire,
          maxConcurrency
        };
      }
      const lockId = makeId("providerlock");
      this.db.query(`
        INSERT INTO provider_runtime_locks (
          id, provider, run_id, operation_id, model_id, acquired_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(lockId, input.provider, input.runId, input.operationId, input.modelId, now, expiresAt);
      return {
        ok: true,
        lockId,
        activeBeforeAcquire,
        maxConcurrency,
        expiresAt
      };
    });
    return acquire.immediate();
  }

  releaseProviderRuntimeSlot(lockId: string): void {
    this.db.query("DELETE FROM provider_runtime_locks WHERE id = ?").run(lockId);
  }

  recordProviderRuntimeSuccess(provider: string): void {
    const now = nowIso();
    this.db.query(`
      INSERT INTO provider_runtime_state (
        provider, consecutive_failures, circuit_open_until, retry_after_until, retry_after_operation_id, updated_at
      ) VALUES (?, 0, NULL, NULL, NULL, ?)
      ON CONFLICT(provider) DO UPDATE SET
        consecutive_failures = 0,
        circuit_open_until = NULL,
        retry_after_until = NULL,
        retry_after_operation_id = NULL,
        updated_at = excluded.updated_at
    `).run(provider, now);
  }

  recordProviderRuntimeFailure(input: {
    provider: string;
    circuitBreakerFailure: boolean;
    failureThreshold: number;
    cooldownMs: number;
    retryAfterMs?: number;
    retryAfterOperationId?: string;
    now?: Date;
  }): { circuitOpened: boolean; openedUntil?: number; retryAfterUntil?: number } {
    const nowMs = input.now?.getTime() ?? Date.now();
    const now = new Date(nowMs).toISOString();
    const failureThreshold = finitePositiveInteger(input.failureThreshold, 1);
    const cooldownMs = finitePositiveInteger(input.cooldownMs, 30_000);
    const update = this.db.transaction(() => {
      this.ensureProviderRuntimeState(input.provider, now);
      const previous = this.getProviderRuntimeState(input.provider)!;
      const consecutiveFailures = input.circuitBreakerFailure
        ? previous.consecutive_failures + 1
        : previous.consecutive_failures;
      const retryAfterUntilMs = input.retryAfterMs === undefined
        ? dateMs(previous.retry_after_until)
        : Math.max(dateMs(previous.retry_after_until) ?? 0, nowMs + Math.max(0, Math.trunc(input.retryAfterMs)));
      const retryAfterOperationId = input.retryAfterMs === undefined
        ? previous.retry_after_operation_id
        : input.retryAfterOperationId ?? null;
      const circuitOpened = input.circuitBreakerFailure && consecutiveFailures >= failureThreshold;
      const openedUntilMs = circuitOpened
        ? nowMs + cooldownMs
        : dateMs(previous.circuit_open_until);
      this.db.query(`
        UPDATE provider_runtime_state
        SET consecutive_failures = ?,
            circuit_open_until = ?,
            retry_after_until = ?,
            retry_after_operation_id = ?,
            updated_at = ?
        WHERE provider = ?
      `).run(
        consecutiveFailures,
        openedUntilMs === undefined ? null : new Date(openedUntilMs).toISOString(),
        retryAfterUntilMs === undefined ? null : new Date(retryAfterUntilMs).toISOString(),
        retryAfterOperationId,
        now,
        input.provider
      );
      return {
        circuitOpened,
        openedUntil: openedUntilMs,
        retryAfterUntil: retryAfterUntilMs
      };
    });
    return update.immediate();
  }

  private updateWorkerJob(jobId: string, update: {
    status: WorkerJobStatus;
    leaseOwner?: string;
    leaseExpiresAt?: string;
  }): WorkerJob {
    const now = nowIso();
    this.db.query(`
      UPDATE worker_jobs
      SET status = ?,
          lease_owner = ?,
          lease_expires_at = ?,
          updated_at = ?
      WHERE id = ?
    `).run(update.status, update.leaseOwner ?? null, update.leaseExpiresAt ?? null, now, jobId);
    return this.requireWorkerJob(jobId);
  }

  private checkBudgetHardCapsForReservation(input: {
    runId: string;
    reserve: BudgetUsage;
    budgetCaps?: BudgetHardCaps;
    operationType: string;
    operationId?: string;
    workerId?: string;
    phase?: string;
    provider?: string;
  }): { ok: true } | { ok: false; reason: string } {
    if (!input.budgetCaps) return { ok: true };
    const checks = [
      {
        scope: "provider" as const,
        cap: input.budgetCaps.provider,
        usage: input.provider ? this.getGlobalBudgetUsage({ provider: input.provider }) : emptyBudgetUsage()
      },
      {
        scope: "phase" as const,
        cap: input.budgetCaps.phase,
        usage: input.phase ? this.getGlobalBudgetUsage({ phase: input.phase }) : emptyBudgetUsage()
      },
      {
        scope: "daily" as const,
        cap: input.budgetCaps.daily,
        usage: this.getGlobalBudgetUsage({ since: startOfUtcDayIso() })
      },
      {
        scope: "global" as const,
        cap: input.budgetCaps.global,
        usage: this.getGlobalBudgetUsage()
      }
    ];

    for (const check of checks) {
      if (!check.cap) continue;
      const budgetCheck = checkBudgetHardCap(check.scope, check.cap, check.usage, input.reserve);
      this.appendEvent(input.runId, "budget.checked", {
        ok: budgetCheck.ok,
        reason: budgetCheck.reason ?? null,
        reserve: input.reserve,
        budget: check.cap,
        usage: check.usage,
        operationType: input.operationType,
        operationId: input.operationId,
        workerId: input.workerId,
        phase: input.phase,
        provider: input.provider,
        capScope: check.scope
      });
      if (!budgetCheck.ok) {
        return { ok: false, reason: budgetCheck.reason ?? "budget exhausted" };
      }
    }
    return { ok: true };
  }

  private checkMachineAdmissionHardCaps(input: {
    runId: string;
    reserve: BudgetUsage;
    budgetCaps?: BudgetHardCaps;
    operationType: string;
    operationId: string;
    provider: string;
    modelId: string;
    command: string;
  }): { ok: true } | { ok: false; reason: string } {
    if (!input.budgetCaps) {
      this.appendEvent(input.runId, "machine.admission.checked", {
        ok: true,
        reason: null,
        reserve: input.reserve,
        operationType: input.operationType,
        operationId: input.operationId,
        provider: input.provider,
        modelId: input.modelId,
        command: input.command,
        capScope: "none",
        policy: "no machine hard caps configured"
      });
      return { ok: true };
    }

    const checks = [
      {
        scope: "provider" as const,
        cap: input.budgetCaps.provider,
        ledgerUsage: this.getGlobalBudgetUsage({ provider: input.provider }),
        machineAdmissionUsage: this.getMachineAdmissionUsage({ provider: input.provider })
      },
      {
        scope: "daily" as const,
        cap: input.budgetCaps.daily,
        ledgerUsage: this.getGlobalBudgetUsage({ since: startOfUtcDayIso() }),
        machineAdmissionUsage: this.getMachineAdmissionUsage({ since: startOfUtcDayIso() })
      },
      {
        scope: "global" as const,
        cap: input.budgetCaps.global,
        ledgerUsage: this.getGlobalBudgetUsage(),
        machineAdmissionUsage: this.getMachineAdmissionUsage()
      }
    ];

    for (const check of checks) {
      if (!check.cap) continue;
      const usage = addBudgetUsage(check.ledgerUsage, check.machineAdmissionUsage);
      const budgetCheck = checkBudgetHardCap(check.scope, check.cap, usage, input.reserve);
      this.appendEvent(input.runId, "machine.admission.checked", {
        ok: budgetCheck.ok,
        reason: budgetCheck.reason ?? null,
        reserve: input.reserve,
        budget: check.cap,
        usage,
        ledgerUsage: check.ledgerUsage,
        machineAdmissionUsage: check.machineAdmissionUsage,
        operationType: input.operationType,
        operationId: input.operationId,
        provider: input.provider,
        modelId: input.modelId,
        command: input.command,
        capScope: check.scope,
        policy: "machine-wide admission caps include committed debits, open budget reservations, and open admission holds"
      });
      if (!budgetCheck.ok) return { ok: false, reason: budgetCheck.reason ?? "machine admission budget exhausted" };
    }
    return { ok: true };
  }

  private requireOpenMachineAdmissionReservation(runId: string, reservationId: string, action: string): MachineAdmissionReservationState {
    const state = this.listOpenMachineAdmissionReservations(runId)
      .find((reservation) => reservation.reservationId === reservationId);
    if (!state) throw new Error(`Cannot ${action} unknown or settled machine admission reservation ${reservationId}.`);
    return state;
  }

  private releaseExternalOperation(operationId: string, reason: string): ExternalOperation {
    const operation = this.requireExternalOperation(operationId);
    if (operation.status !== "reserved" && operation.status !== "running") {
      throw new Error(`Cannot release external operation ${operation.id} in status ${operation.status}.`);
    }
    this.releaseBudget({
      runId: operation.runId,
      reservationId: operation.reservationId,
      reason
    });
    const now = nowIso();
    this.db.query(`
      UPDATE external_operations
      SET status = 'released',
          error_message = ?,
          completed_at = ?,
          updated_at = ?
      WHERE id = ?
    `).run(String(redactJson(reason)), now, now, operation.id);
    const updated = this.requireExternalOperation(operation.id);
    this.appendEvent(updated.runId, "external.operation.released", {
      operationId: updated.id,
      operationType: updated.operationType,
      provider: updated.provider,
      idempotencyKey: updated.idempotencyKey,
      requestHash: updated.requestHash,
      reservationId: updated.reservationId,
      reason: String(redactJson(reason)),
      cancellationSettlement: cancellationSettlementForExternalOperation({ status: "released" })
    }, updated.requestArtifactId ? [updated.requestArtifactId] : []);
    return updated;
  }

  private getExternalOperationByIdempotencyKey(runId: string, idempotencyKey: string): ExternalOperation | undefined {
    const row = this.db.query(`
      SELECT * FROM external_operations
      WHERE run_id = ? AND idempotency_key = ?
    `).get(runId, idempotencyKey) as ExternalOperationRow | null;
    return row ? mapExternalOperation(row) : undefined;
  }

  private requireExternalOperationPrepareEnvelope(operation: ExternalOperation): void {
    this.requireOpenBudgetReservation(operation.runId, operation.reservationId, "start external operation");
    if (operation.requestArtifactId) {
      this.requireArtifact(operation.runId, operation.requestArtifactId, "start external operation");
    }
    const reservedEvent = this.listEvents(operation.runId).find((event) =>
      event.type === "external.operation.reserved" &&
      event.payload.operationId === operation.id &&
      event.payload.reservationId === operation.reservationId
    );
    if (!reservedEvent) {
      throw new Error(`Cannot start external operation ${operation.id}: missing atomic reservation event.`);
    }
    if (reservedEvent.payload.requestArtifactId !== operation.requestArtifactId) {
      throw new Error(`Cannot start external operation ${operation.id}: request artifact reference drifted.`);
    }
    if (reservedEvent.payload.requiresRemoteAdmission === true) {
      const admissionArtifactIds = Array.isArray(reservedEvent.payload.admissionArtifactIds)
        ? reservedEvent.payload.admissionArtifactIds
        : [];
      if (admissionArtifactIds.length === 0 || typeof reservedEvent.payload.remoteAdmissionEventId !== "string") {
        throw new Error(`Cannot start external operation ${operation.id}: missing persisted remote admission reference.`);
      }
      for (const artifactId of admissionArtifactIds) {
        if (typeof artifactId !== "string") {
          throw new Error(`Cannot start external operation ${operation.id}: invalid remote admission artifact reference.`);
        }
        this.requireArtifact(operation.runId, artifactId, "start external operation");
      }
    }
  }

  private requireArtifact(runId: string, artifactId: string, action: string): Artifact {
    const row = this.db.query(`
      SELECT * FROM artifacts
      WHERE run_id = ? AND id = ?
    `).get(runId, artifactId) as ArtifactRow | null;
    if (!row) throw new Error(`Cannot ${action}: missing artifact ${artifactId}.`);
    return mapArtifact(row);
  }

  private deleteExpiredProviderRuntimeLocks(now: string): void {
    this.db.query("DELETE FROM provider_runtime_locks WHERE expires_at <= ?").run(now);
  }

  private countProviderRuntimeLocks(provider: string): number {
    const row = this.db.query(`
      SELECT COUNT(*) AS count
      FROM provider_runtime_locks
      WHERE provider = ?
    `).get(provider) as { count: number };
    return row.count;
  }

  private getProviderRuntimeState(provider: string): ProviderRuntimeStateRow | undefined {
    const row = this.db.query(`
      SELECT * FROM provider_runtime_state
      WHERE provider = ?
    `).get(provider) as ProviderRuntimeStateRow | null;
    return row ?? undefined;
  }

  private ensureProviderRuntimeState(provider: string, now: string): void {
    this.db.query(`
      INSERT OR IGNORE INTO provider_runtime_state (
        provider, consecutive_failures, circuit_open_until, retry_after_until, retry_after_operation_id, updated_at
      ) VALUES (?, 0, NULL, NULL, NULL, ?)
    `).run(provider, now);
  }

  private nextExternalOperationAttempt(runId: string, retryOfOperationId: string | undefined): number {
    if (!retryOfOperationId) return 1;
    const row = this.db.query(`
      SELECT COALESCE(MAX(attempt), 0) + 1 AS attempt
      FROM external_operations
      WHERE run_id = ?
        AND (id = ? OR retry_of_operation_id = ?)
    `).get(runId, retryOfOperationId, retryOfOperationId) as { attempt: number };
    return row.attempt;
  }

  private nextEventSequence(runId: string): number {
    const row = this.db.query(`
      INSERT INTO run_event_counters (run_id, next_sequence)
      VALUES (?, 1)
      ON CONFLICT(run_id) DO UPDATE
        SET next_sequence = next_sequence + 1
      RETURNING next_sequence - 1 AS sequence
    `).get(runId) as { sequence: number };
    return row.sequence;
  }

  private previousEventHash(runId: string, sequence: number): string | undefined {
    if (sequence === 0) return undefined;
    const row = this.db.query(`
      SELECT event_hash
      FROM ledger_events
      WHERE run_id = ? AND sequence = ?
    `).get(runId, sequence - 1) as { event_hash: string | null } | null;
    if (!row?.event_hash) {
      throw new Error(`Cannot append ledger event ${sequence} for ${runId}: previous event hash is missing.`);
    }
    return row.event_hash;
  }

  private linkedArtifactHashes(runId: string, artifactIds: string[]): Array<{ artifactId: string; sha256?: string }> {
    if (artifactIds.length === 0) return [];
    const rows = this.db.query(`
      SELECT id, sha256
      FROM artifacts
      WHERE run_id = ?
    `).all(runId) as Array<{ id: string; sha256: string }>;
    const hashesById = new Map(rows.map((row) => [row.id, row.sha256]));
    return artifactIds.map((artifactId) => ({
      artifactId,
      sha256: hashesById.get(artifactId)
    }));
  }

  private ledgerWitnessPath(runId: string): string {
    return join(dirname(this.dbPath), "ledger-witness", `${runId}.json`);
  }

  private backfillEventHashChains(): void {
    const hasHashColumns = this.db.query(`
      SELECT COUNT(*) AS count
      FROM pragma_table_info('ledger_events')
      WHERE name IN (
        'previous_event_hash',
        'event_hash',
        'payload_hash',
        'linked_artifact_hashes_json',
        'schema_version'
      )
    `).get() as { count: number };
    if (hasHashColumns.count !== 5) return;

    const backfill = this.db.transaction(() => {
      const runs = this.db.query(`
        SELECT DISTINCT run_id
        FROM ledger_events
        ORDER BY run_id ASC
      `).all() as Array<{ run_id: string }>;
      for (const { run_id: runId } of runs) {
        const rows = this.db.query(`
          SELECT *
          FROM ledger_events
          WHERE run_id = ?
          ORDER BY COALESCE(sequence, 9223372036854775807) ASC, created_at ASC, id ASC
        `).all(runId) as EventRow[];

        let previousEventHash: string | undefined;
        let backfilledAny = false;
        rows.forEach((row, index) => {
          const sequence = typeof row.sequence === "number" ? row.sequence : index;
          const artifactIds = JSON.parse(row.artifact_ids_json) as string[];
          const linkedArtifactHashes = this.linkedArtifactHashes(runId, artifactIds);
          const existingPayloadJson = decryptStringFromStorage(this.storageRoot, row.payload_json, `ledger_event:${row.id}:payload`);
          const payload = addTerminalIntegrity(
            row.type,
            JSON.parse(existingPayloadJson) as Record<string, unknown>,
            {
              previousEventHash,
              artifactRoot: stableHash(linkedArtifactHashes),
              schemaVersion: MIGRATIONS.length
            }
          );
          const payloadHash = stableHash(payload);
          const computedEventHash = computeLedgerEventHash({
            runId,
            type: row.type,
            payload,
            artifactIds,
            sequence,
            payloadHash,
            linkedArtifactHashes,
            schemaVersion: MIGRATIONS.length,
            previousEventHash
          });
          const shouldBackfill =
            row.sequence === null ||
            row.event_hash === null ||
            row.payload_hash === null ||
            row.linked_artifact_hashes_json === null ||
            row.schema_version === null ||
            (sequence > 0 && row.previous_event_hash === null) ||
            existingPayloadJson !== JSON.stringify(payload);
          if (shouldBackfill) {
            this.db.query(`
              UPDATE ledger_events
              SET sequence = ?,
                  payload_json = ?,
                  payload_hash = ?,
                  linked_artifact_hashes_json = ?,
                  schema_version = ?,
                  previous_event_hash = ?,
                  event_hash = ?
              WHERE id = ?
            `).run(
              sequence,
              this.encryptStorageString(JSON.stringify(payload), `ledger_event:${row.id}:payload`),
              payloadHash,
              JSON.stringify(linkedArtifactHashes),
              MIGRATIONS.length,
              previousEventHash ?? null,
              computedEventHash,
              row.id
            );
            backfilledAny = true;
          }
          previousEventHash = computedEventHash;
        });

        if (backfilledAny) {
          this.db.query(`
            INSERT INTO run_event_counters (run_id, next_sequence)
            VALUES (?, ?)
            ON CONFLICT(run_id) DO UPDATE SET next_sequence = MAX(run_event_counters.next_sequence, excluded.next_sequence)
          `).run(runId, rows.length);
        }
      }
    });
    backfill();
    for (const { run_id: runId } of this.db.query(`
      SELECT DISTINCT run_id
      FROM ledger_events
      ORDER BY run_id ASC
    `).all() as Array<{ run_id: string }>) {
      this.refreshLedgerWitness(runId);
    }
  }

  private requireActiveLease(job: WorkerJob, owner: string, expectedAttempt: number, action: string): void {
    if (job.leaseOwner !== owner) {
      this.appendIgnoredWorkerLeaseMutation(job, action, "lease_owner_mismatch", owner, expectedAttempt);
      throw new Error(`Cannot ${action} job ${job.id}: lease owner mismatch.`);
    }
    if (job.attempts !== expectedAttempt) {
      this.appendIgnoredWorkerLeaseMutation(job, action, "lease_attempt_mismatch", owner, expectedAttempt);
      throw new Error(`Cannot ${action} job ${job.id}: attempt mismatch.`);
    }
    if (!job.leaseExpiresAt) {
      this.appendIgnoredWorkerLeaseMutation(job, action, "missing_lease", owner, expectedAttempt);
      throw new Error(`Cannot ${action} job ${job.id}: missing lease.`);
    }
    if (new Date(job.leaseExpiresAt).getTime() <= Date.now()) {
      this.appendIgnoredWorkerLeaseMutation(job, action, "lease_expired", owner, expectedAttempt);
      throw new Error(`Cannot ${action} job ${job.id}: lease expired.`);
    }
  }

  private appendIgnoredWorkerLeaseMutation(
    job: WorkerJob,
    action: string,
    reason: string,
    actor: string,
    expectedAttempt: number,
    details: Record<string, unknown> = {}
  ): void {
    const state = workerLeaseStateFromStatus(job.status);
    this.appendEvent(job.runId, "worker.mutation.ignored", {
      ...workerLeaseTransitionPayload({
        jobId: job.id,
        actor,
        reason,
        priorState: state,
        nextState: state,
        attempt: expectedAttempt,
        maxAttempts: job.maxAttempts,
        leaseExpiresAt: job.leaseExpiresAt,
        reservationId: this.latestWorkerReservationId(job.runId, job.id, job.attempts) ?? "unbound"
      }),
      jobId: job.id,
      action,
      reason,
      owner: actor,
      expectedAttempt,
      actualAttempt: job.attempts,
      previousStatus: job.status,
      ignored: true,
      details
    });
  }

  private ignoreWorkerMutationAfterTerminal(
    job: WorkerJob,
    action: "start" | "heartbeat" | "commit" | "fail" | "cancel",
    runStatus: GoalStatus,
    details: Record<string, unknown> = {}
  ): void {
    const state = workerLeaseStateFromStatus(job.status);
    this.appendEvent(job.runId, "worker.mutation.ignored", {
      ...workerLeaseTransitionPayload({
        jobId: job.id,
        actor: typeof details.owner === "string" ? details.owner : "terminal-arbiter",
        reason: "post_terminal_mutation",
        priorState: state,
        nextState: state,
        attempt: typeof details.expectedAttempt === "number" ? details.expectedAttempt : job.attempts,
        maxAttempts: job.maxAttempts,
        leaseExpiresAt: job.leaseExpiresAt,
        reservationId: this.latestWorkerReservationId(job.runId, job.id, job.attempts) ?? "unbound"
      }),
      jobId: job.id,
      action,
      reason: "post_terminal_mutation",
      previousStatus: job.status,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      runStatus,
      ignored: true,
      details,
      cancellationSettlement: "unknown",
      terminalArbiter: terminalMutationArbiter(runStatus, "post_terminal_mutation")
    });
  }

  private cancelWorkerJobAsSystem(jobId: string, reason: string): WorkerJob {
    const previous = this.requireWorkerJob(jobId);
    const reservationId = this.latestWorkerReservationId(previous.runId, previous.id, previous.attempts) ?? "unbound";
    const updated = this.updateWorkerJob(jobId, {
      status: "cancelled",
      leaseOwner: undefined,
      leaseExpiresAt: undefined
    });
    this.appendEvent(updated.runId, "worker.cancelled", {
      ...workerLeaseTransitionPayload({
        jobId,
        actor: "system",
        reason,
        priorStatus: previous.status,
        nextStatus: updated.status,
        attempt: updated.attempts,
        maxAttempts: updated.maxAttempts,
        leaseExpiresAt: previous.leaseExpiresAt,
        reservationId
      }),
      jobId,
      reason,
      previousStatus: previous.status,
      cancellationSettlement: previous.status === "pending" || previous.status === "failed_retryable" ? "avoided" : "unknown"
    });
    return updated;
  }

  private latestWorkerReservationId(runId: string, jobId: string, attempt?: number): string | undefined {
    for (const event of this.listEvents(runId).slice().reverse()) {
      if (event.payload.jobId !== jobId) continue;
      if (attempt !== undefined) {
        const eventAttempt = typeof event.payload.attempt === "number"
          ? event.payload.attempt
          : typeof event.payload.attempts === "number"
            ? event.payload.attempts
            : undefined;
        if (eventAttempt !== undefined && eventAttempt !== attempt) continue;
      }
      if (event.type !== "worker.reservation_bound" && event.type !== "worker.leased") continue;
      const reservationId = event.payload.reservationId;
      if (typeof reservationId === "string" && reservationId.length > 0) return reservationId;
    }
    return undefined;
  }

  private getBudgetReservationState(runId: string, reservationId: string): BudgetReservationState | undefined {
    let state: BudgetReservationState | undefined;
    for (const event of this.listEvents(runId)) {
      const eventReservationId = stringValue(event.payload.reservationId);
      if (eventReservationId !== reservationId) continue;
      if (event.type === "budget.reserved") {
        state = {
          reservationId,
          reserve: budgetUsageFromPayload(event.payload.reserve),
          operationType: stringValue(event.payload.operationType),
          operationId: stringValue(event.payload.operationId),
          provider: stringValue(event.payload.provider),
          settled: "open"
        };
      }
      if (event.type === "budget.released") {
        if (!state) throw new Error(`Budget reservation ${reservationId} was released before it was reserved.`);
        state = { ...state, settled: "released" };
      }
      if (event.type === "budget.debited") {
        if (!state) throw new Error(`Budget reservation ${reservationId} was debited before it was reserved.`);
        state = { ...state, settled: "debited" };
      }
    }
    return state;
  }

  private requireOpenBudgetReservation(runId: string, reservationId: string, action: string): BudgetReservationState {
    const state = this.getBudgetReservationState(runId, reservationId);
    if (!state) {
      throw new Error(`Cannot ${action} unknown budget reservation ${reservationId}.`);
    }
    if (state.settled !== "open") {
      throw new Error(`Cannot ${action} budget reservation ${reservationId}: already ${state.settled}.`);
    }
    return state;
  }

  private indexExists(indexName: string): boolean {
    const row = this.db.query(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'index' AND name = ?
    `).get(indexName) as { name: string } | null;
    return Boolean(row);
  }

  private encryptStorageString(value: string, aad: string): string {
    return encryptStringForStorage(this.storageRoot, value, aad);
  }
}

function mapRun(row: GoalRunRow, storageRoot: string): GoalRun {
  return {
    id: row.id,
    problem: decryptStringFromStorage(storageRoot, row.problem, `goal_run:${row.id}:problem`),
    goal: decryptStringFromStorage(storageRoot, row.goal, `goal_run:${row.id}:goal`),
    successCriteria: JSON.parse(decryptStringFromStorage(storageRoot, row.success_criteria, `goal_run:${row.id}:success_criteria`)) as string[],
    workflow: row.workflow,
    budget: JSON.parse(row.budget_json) as Budget,
    status: row.status,
    evidenceGrade: row.evidence_grade,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined
  };
}

function mapEvent(row: EventRow, storageRoot: string): LedgerEvent {
  return {
    id: row.id,
    runId: row.run_id,
    type: row.type,
    payload: JSON.parse(decryptStringFromStorage(storageRoot, row.payload_json, `ledger_event:${row.id}:payload`)) as Record<string, unknown>,
    artifactIds: JSON.parse(row.artifact_ids_json) as string[],
    createdAt: row.created_at,
    sequence: row.sequence ?? undefined,
    payloadHash: row.payload_hash ?? undefined,
    linkedArtifactHashes: row.linked_artifact_hashes_json
      ? JSON.parse(row.linked_artifact_hashes_json) as Array<{ artifactId: string; sha256?: string }>
      : undefined,
    schemaVersion: row.schema_version ?? undefined,
    previousEventHash: row.previous_event_hash ?? undefined,
    eventHash: row.event_hash ?? undefined
  };
}

function mapArtifact(row: ArtifactRow): Artifact {
  const contentAddress = row.content_address ?? artifactContentAddress(row.sha256);
  const storageKey = row.storage_key ?? artifactStorageKey(row.run_id, row.sha256);
  return {
    id: row.id,
    runId: row.run_id,
    kind: row.kind,
    sha256: row.sha256,
    contentAddress,
    mediaType: row.media_type ?? "text/plain; charset=utf-8",
    storageKey,
    path: row.path,
    bytes: row.bytes,
    createdAt: row.created_at,
    provenance: row.provenance_json
      ? JSON.parse(row.provenance_json) as Record<string, unknown>
      : undefined
  };
}

function mapWorkerJob(row: WorkerJobRow, storageRoot: string): WorkerJob {
  return {
    id: row.id,
    runId: row.run_id,
    kind: row.kind,
    payload: JSON.parse(decryptStringFromStorage(storageRoot, row.payload_json, `worker_job:${row.id}:payload`)) as Record<string, unknown>,
    dedupeKey: row.dedupe_key ?? undefined,
    status: row.status,
    leaseOwner: row.lease_owner ?? undefined,
    leaseExpiresAt: row.lease_expires_at ?? undefined,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function computeLedgerEventHash(input: {
  runId: string;
  type: EventType;
  payload: Record<string, unknown>;
  artifactIds: string[];
  sequence: number;
  payloadHash?: string;
  linkedArtifactHashes?: Array<{ artifactId: string; sha256?: string }>;
  schemaVersion?: number;
  previousEventHash?: string;
}): string {
  const payloadHash = input.payloadHash ?? stableHash(input.payload);
  const linkedArtifactHashes = input.linkedArtifactHashes ?? [];
  const schemaVersion = input.schemaVersion ?? MIGRATIONS.length;
  return stableHash({
    version: 2,
    runId: input.runId,
    schemaVersion,
    sequence: input.sequence,
    type: input.type,
    payloadHash,
    artifactIds: input.artifactIds,
    linkedArtifactHashes,
    previousEventHash: input.previousEventHash ?? null
  });
}

function buildLedgerWitnessCheckpoint(runId: string, events: LedgerEvent[]): LedgerWitnessCheckpoint {
  const entries = events.map((event): LedgerWitnessEntry => ({
    sequence: typeof event.sequence === "number" ? event.sequence : -1,
    eventId: event.id,
    type: event.type,
    payloadHash: event.payloadHash,
    linkedArtifactManifestHash: stableHash(event.linkedArtifactHashes ?? []),
    schemaVersion: event.schemaVersion,
    previousEventHash: event.previousEventHash,
    eventHash: event.eventHash
  }));
  const base = {
    format: "matematica.ledger.witness" as const,
    version: 1 as const,
    runId,
    eventCount: entries.length,
    headEventHash: entries.at(-1)?.eventHash,
    eventLogHash: stableHash(entries),
    entries
  };
  return {
    ...base,
    checkpointHash: stableHash(base)
  };
}

function ledgerWitnessComparable(checkpoint: LedgerWitnessCheckpoint): Omit<LedgerWitnessCheckpoint, "checkpointHash"> {
  const { checkpointHash: _checkpointHash, ...comparable } = checkpoint;
  return comparable;
}

function hashLedgerWitnessComparable(checkpoint: LedgerWitnessCheckpoint): string {
  return stableHash(ledgerWitnessComparable(checkpoint));
}

function mapScore(row: ScoreRow): StoredScore {
  return {
    id: row.id,
    runId: row.run_id,
    subjectId: row.subject_id,
    scorer: row.scorer,
    score: row.score,
    rubric: JSON.parse(row.rubric_json) as Record<string, unknown>,
    createdAt: row.created_at
  };
}

function mapExternalOperation(row: ExternalOperationRow): ExternalOperation {
  return {
    id: row.id,
    runId: row.run_id,
    operationType: row.operation_type,
    provider: row.provider ?? undefined,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    requestArtifactId: row.request_artifact_id ?? undefined,
    responseArtifactId: row.response_artifact_id ?? undefined,
    reservationId: row.reservation_id,
    status: row.status,
    retryOfOperationId: row.retry_of_operation_id ?? undefined,
    attempt: row.attempt,
    errorMessage: row.error_message ?? undefined,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    updatedAt: row.updated_at
  };
}

function isRemoteDispatchOperation(operation: ExternalOperation): boolean {
  const type = operation.operationType.toLowerCase();
  return type === "remote.worker.dispatch" ||
    type === "remote.dispatch" ||
    (type.startsWith("remote.") && type.includes("dispatch"));
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function budgetUsageFromPayload(value: unknown): BudgetUsage {
  if (!value || typeof value !== "object") return emptyBudgetUsage();
  const record = value as Record<string, unknown>;
  return {
    attempts: numberValue(record.attempts),
    tokens: numberValue(record.tokens),
    usd: numberValue(record.usd),
    elapsedMs: numberValue(record.elapsedMs),
    artifactBytes: numberValue(record.artifactBytes),
    sourceQueries: numberValue(record.sourceQueries),
    retries: numberValue(record.retries),
    sandboxMs: numberValue(record.sandboxMs)
  };
}

function budgetUsageFromEvents(
  events: LedgerEvent[],
  filter: { provider?: string; operationType?: string; phase?: string; since?: string } = {}
): BudgetUsage {
  const usage = emptyBudgetUsage();
  const openReservations = new Map<string, BudgetUsage>();
  const reservationMatches = new Map<string, boolean>();
  for (const event of events) {
    const reservationId = stringValue(event.payload.reservationId);
    if (event.type === "budget.reserved") {
      const reserve = budgetUsageFromPayload(event.payload.reserve);
      const matches = budgetEventMatches(event, filter);
      if (reservationId) {
        reservationMatches.set(reservationId, matches);
        if (matches) openReservations.set(reservationId, reserve);
      }
    }
    if (event.type === "budget.released") {
      if (reservationId) openReservations.delete(reservationId);
    }
    if (event.type === "budget.debited") {
      if (reservationId) openReservations.delete(reservationId);
      const matches = budgetEventMatches(event, filter) || (reservationId ? reservationMatches.get(reservationId) === true : false);
      if (matches) {
        const debit = budgetUsageFromPayload(event.payload.debit);
        usage.attempts += debit.attempts;
        usage.tokens += debit.tokens;
        usage.usd += debit.usd;
        usage.elapsedMs += debit.elapsedMs;
        usage.artifactBytes += debit.artifactBytes;
        usage.sourceQueries += debit.sourceQueries;
        usage.retries += debit.retries;
        usage.sandboxMs += debit.sandboxMs;
      }
    }
    if (event.type === "artifact.created" && budgetEventMatches(event, filter)) {
      usage.artifactBytes += numberValue(event.payload.bytes);
    }
    if (event.type === "source.query" && budgetEventMatches(event, filter)) {
      usage.sourceQueries += 1;
    }
    if (event.type === "provider.retry.scheduled" && budgetEventMatches(event, filter)) {
      usage.retries += 1;
    }
  }
  for (const reservation of openReservations.values()) {
    usage.attempts += reservation.attempts;
    usage.tokens += reservation.tokens;
    usage.usd += reservation.usd;
    usage.elapsedMs += reservation.elapsedMs;
    usage.artifactBytes += reservation.artifactBytes;
    usage.sourceQueries += reservation.sourceQueries;
    usage.retries += reservation.retries;
    usage.sandboxMs += reservation.sandboxMs;
  }
  return usage;
}

function machineAdmissionUsageFromEvents(
  events: LedgerEvent[],
  filter: { provider?: string; operationType?: string; since?: string } = {}
): BudgetUsage {
  const usage = emptyBudgetUsage();
  for (const reservation of machineAdmissionReservationsFromEvents(events)) {
    if (reservation.settled !== "open") continue;
    if (filter.provider && reservation.provider !== filter.provider) continue;
    if (filter.operationType && reservation.operationType !== filter.operationType) continue;
    const event = events.find((item) =>
      item.type === "machine.admission.reserved" &&
      item.payload.reservationId === reservation.reservationId
    );
    if (filter.since && event && event.createdAt < filter.since) continue;
    addBudgetUsageInPlace(usage, reservation.reserve);
  }
  return usage;
}

function machineAdmissionReservationsFromEvents(events: LedgerEvent[]): MachineAdmissionReservationState[] {
  const states = new Map<string, MachineAdmissionReservationState>();
  for (const event of events) {
    const reservationId = stringValue(event.payload.reservationId);
    if (!reservationId) continue;
    if (event.type === "machine.admission.reserved") {
      states.set(reservationId, {
        reservationId,
        reserve: budgetUsageFromPayload(event.payload.reserve),
        operationType: stringValue(event.payload.operationType),
        operationId: stringValue(event.payload.operationId),
        provider: stringValue(event.payload.provider),
        modelId: stringValue(event.payload.modelId),
        command: stringValue(event.payload.command),
        settled: "open"
      });
    }
    if (event.type === "machine.admission.released") {
      const state = states.get(reservationId);
      if (state) state.settled = "released";
    }
  }
  return [...states.values()];
}

function budgetEventMatches(event: LedgerEvent, filter: { provider?: string; operationType?: string; phase?: string; since?: string }): boolean {
  if (filter.since && event.createdAt < filter.since) return false;
  if (filter.provider && stringValue(event.payload.provider) !== filter.provider) return false;
  if (filter.operationType && stringValue(event.payload.operationType) !== filter.operationType) return false;
  if (filter.phase && stringValue(event.payload.phase) !== filter.phase) return false;
  return true;
}

function addBudgetUsage(left: BudgetUsage, right: BudgetUsage): BudgetUsage {
  const usage = { ...left };
  addBudgetUsageInPlace(usage, right);
  return usage;
}

function addBudgetUsageInPlace(target: BudgetUsage, source: BudgetUsage): void {
  target.attempts += source.attempts;
  target.tokens += source.tokens;
  target.usd += source.usd;
  target.elapsedMs += source.elapsedMs;
  target.artifactBytes += source.artifactBytes;
  target.sourceQueries += source.sourceQueries;
  target.retries += source.retries;
  target.sandboxMs += source.sandboxMs;
}

function emptyBudgetUsage(): BudgetUsage {
  return {
    attempts: 0,
    tokens: 0,
    usd: 0,
    elapsedMs: 0,
    artifactBytes: 0,
    sourceQueries: 0,
    retries: 0,
    sandboxMs: 0
  };
}

function assertDebitWithinReservation(
  debit: BudgetUsage,
  reserve: BudgetUsage,
  reservationId: string,
  policy?: BudgetOverReservationPolicy
): void {
  const allowed = new Set(policy?.allowedDimensions ?? []);
  for (const dimension of ["attempts", "tokens", "usd", "elapsedMs", "artifactBytes", "sourceQueries", "retries", "sandboxMs"] as const) {
    if (debit[dimension] > reserve[dimension] && !allowed.has(dimension)) {
      throw new Error(
        `Budget debit for ${reservationId} exceeds reserved ${dimension} (${debit[dimension]}/${reserve[dimension]}).`
      );
    }
  }
  if (allowed.size > 0 && !policy?.reason.trim()) {
    throw new Error(`Budget debit for ${reservationId} cannot exceed reservation without a reason.`);
  }
}

function finalStateForEvidenceGrade(evidenceGrade: EvidenceGrade): string {
  if (evidenceGrade === "formal_proof") return "formal_proof";
  if (evidenceGrade === "verified_counterexample") return "counterexample";
  if (evidenceGrade === "verified_computation") return "computational_evidence";
  if (evidenceGrade === "heuristic_evidence") return "heuristic";
  if (evidenceGrade === "conjectural_solution" || evidenceGrade === "literature_backed_reduction") return "partial";
  if (evidenceGrade === "unsupported" || evidenceGrade === "none") return "inconclusive";
  return "conjecture";
}

const DEFAULT_NO_ARTIFACT_JUSTIFICATIONS: Partial<Record<EventType, string>> = {
  "budget.checked": "Budget check records deterministic ledger accounting; no separate artifact is produced.",
  "budget.reserved": "Budget reservation records deterministic ledger accounting; no separate artifact is produced.",
  "budget.released": "Budget release records deterministic ledger accounting; no separate artifact is produced.",
  "budget.debited": "Budget debit records deterministic ledger accounting; no separate artifact is produced.",
  "worker.committed": "Worker commit recorded no artifact-bearing result; job state is persisted in the worker queue.",
  "worker.ranked": "Worker ranking is deterministic from committed worker job records; no separate artifact is produced.",
  "run.deadline.checked": "Run deadline checks record deterministic wall-clock budget enforcement; no separate artifact is produced.",
  "goal.completed": "Terminal event records final ledger state; verifier-backed completions link satisfying artifacts when available.",
  "goal.failed": "Failure terminal event records state transition and reason; no separate artifact is produced.",
  "goal.terminal_transition.ignored": "Terminal arbiter ignored a losing transition attempt; no separate artifact is produced.",
  "goal.terminal_reopen.requested": "Terminal reopen intent records explicit operator control-plane intent; no separate artifact is produced.",
  "worker.mutation.ignored": "Terminal arbiter ignored a post-terminal worker mutation; no separate artifact is produced.",
  "external.operation.ignored": "Terminal arbiter ignored a post-terminal external operation mutation; linked request or response artifacts are included when available.",
  "report.generated": "Report generation event records deterministic render metadata; report content is reproducible from ledger artifacts."
};

function addNoArtifactJustification(
  type: EventType,
  payload: Record<string, unknown>,
  artifactIds: string[]
): Record<string, unknown> {
  if (artifactIds.length > 0 || typeof payload.noArtifactJustification === "string") return payload;
  const justification = DEFAULT_NO_ARTIFACT_JUSTIFICATIONS[type];
  return justification ? { ...payload, noArtifactJustification: justification } : payload;
}

function addTerminalIntegrity(
  type: EventType,
  payload: Record<string, unknown>,
  input: {
    previousEventHash?: string;
    artifactRoot: string;
    schemaVersion: number;
  }
): Record<string, unknown> {
  if (type !== "goal.completed" && type !== "goal.failed") return payload;
  return {
    ...payload,
    terminalIntegrity: {
      chainVersion: 1,
      previousEventHash: input.previousEventHash ?? null,
      artifactRoot: input.artifactRoot,
      schemaVersion: input.schemaVersion
    }
  };
}

function artifactIdsFromValue(value: unknown): string[] {
  const ids = new Set<string>();
  collectArtifactIds(value, ids);
  return [...ids];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function sameOrderedStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function collectArtifactIds(value: unknown, ids: Set<string>): void {
  if (typeof value === "string") return;
  if (Array.isArray(value)) {
    for (const item of value) collectArtifactIds(item, ids);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (key === "artifactId" && typeof nested === "string") {
      ids.add(nested);
      continue;
    }
    if (key === "artifactIds" && Array.isArray(nested)) {
      for (const item of nested) {
        if (typeof item === "string") ids.add(item);
      }
      continue;
    }
    collectArtifactIds(nested, ids);
  }
}

function startOfUtcDayIso(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

function normalizeBudgetUsage(value: Partial<BudgetUsage>): BudgetUsage {
  return {
    attempts: finiteNonNegative(value.attempts),
    tokens: finiteNonNegative(value.tokens),
    usd: finiteNonNegative(value.usd),
    elapsedMs: finiteNonNegative(value.elapsedMs),
    artifactBytes: finiteNonNegative(value.artifactBytes),
    sourceQueries: finiteNonNegative(value.sourceQueries),
    retries: finiteNonNegative(value.retries),
    sandboxMs: finiteNonNegative(value.sandboxMs)
  };
}

function finiteNonNegative(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Budget usage values must be non-negative finite numbers.");
  }
  return value;
}

function finitePositiveInteger(value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0) return fallback;
  return Math.trunc(resolved);
}

function throwPrepareFault(
  configured: ExternalOperationPrepareFault | undefined,
  boundary: ExternalOperationPrepareFault
): void {
  if (configured === boundary) {
    throw new Error(`Injected external operation prepare fault at ${boundary}.`);
  }
}

function dateMs(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isZeroBudgetUsage(value: BudgetUsage): boolean {
  return value.attempts === 0 &&
    value.tokens === 0 &&
    value.usd === 0 &&
    value.elapsedMs === 0 &&
    value.artifactBytes === 0 &&
    value.sourceQueries === 0 &&
    value.retries === 0 &&
    value.sandboxMs === 0;
}

function isTerminal(status: GoalStatus): boolean {
  return status === "goal_met" ||
    status === "budget_exhausted" ||
    status === "needs_human_review" ||
    status === "cancelled" ||
    status === "failed";
}

function terminalPriority(status: GoalStatus): number {
  return TERMINAL_STATUS_PRIORITY[status] ?? 0;
}

function terminalTransitionArbiter(input: {
  from: GoalStatus;
  observedFrom?: GoalStatus;
  to: GoalStatus;
  transition: "applied" | "ignored";
  reason: string;
  applied: boolean;
}): Record<string, unknown> {
  return {
    authority: TERMINAL_ARBITER_AUTHORITY,
    transition: input.transition,
    reason: input.reason,
    priority: terminalPriority(input.to),
    previousPriority: terminalPriority(input.from),
    compareAndSet: {
      expectedFrom: input.from,
      observedFrom: input.observedFrom ?? input.from,
      applied: input.applied
    },
    terminalPriorityOrder: {
      goal_met: TERMINAL_STATUS_PRIORITY.goal_met,
      budget_exhausted: TERMINAL_STATUS_PRIORITY.budget_exhausted,
      failed: TERMINAL_STATUS_PRIORITY.failed,
      cancelled: TERMINAL_STATUS_PRIORITY.cancelled,
      needs_human_review: TERMINAL_STATUS_PRIORITY.needs_human_review
    }
  };
}

function terminalMutationArbiter(status: GoalStatus, reason: string): Record<string, unknown> {
  return {
    authority: TERMINAL_ARBITER_AUTHORITY,
    transition: "ignored",
    reason,
    runStatus: status,
    priority: terminalPriority(status),
    terminalPriorityOrder: {
      goal_met: TERMINAL_STATUS_PRIORITY.goal_met,
      budget_exhausted: TERMINAL_STATUS_PRIORITY.budget_exhausted,
      failed: TERMINAL_STATUS_PRIORITY.failed,
      cancelled: TERMINAL_STATUS_PRIORITY.cancelled,
      needs_human_review: TERMINAL_STATUS_PRIORITY.needs_human_review
    }
  };
}
