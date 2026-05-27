import type { AuditResult } from "./audit";
import type { LedgerEvent } from "./domain";
import type { Ledger } from "./ledger";
import { defaultMathlibTheoremIndexSnapshot } from "./theorem";

export type OfflineReplayGateManifest = {
  providerMatrix?: {
    matrixHash?: string;
  };
  actionPersistence: Array<{
    eventId: string;
    type: string;
    replayable: boolean;
  }>;
};

export type OfflineSelfContainedGate = {
  ok: boolean;
  networkPolicy: "no_new_network_or_provider_calls";
  semantics: string;
  checked: {
    events: number;
    artifacts: number;
    externalOperations: number;
    nonReplayableSteps: number;
  };
  issues: Array<{
    code: string;
    message: string;
    eventId?: string;
    operationId?: string;
    artifactId?: string;
  }>;
};

export function buildOfflineReplayNonReplayableSteps(events: LedgerEvent[]): Array<{
  eventId: string;
  type: string;
  reason: string;
}> {
  return events
    .filter((event) =>
      event.type === "ai.call.started" ||
      event.type === "ai.call.stream_chunk" ||
      event.type === "ai.call.step" ||
      event.type === "ai.call.transcript.persisted" ||
      event.type === "source.query" ||
      event.type === "verifier.started" ||
      event.type.startsWith("worker.tool.") ||
      event.type === "provider.retry.scheduled" ||
      event.type === "external.operation.started" ||
      event.type === "external.operation.completed"
    )
    .map((event) => ({
      eventId: event.id,
      type: event.type,
      reason: nonReplayableReason(event.type)
    }));
}

export function buildOfflineReplayGateManifest(input: {
  runId: string;
  ledger: Ledger;
  events: LedgerEvent[];
}): OfflineReplayGateManifest {
  const artifacts = input.ledger.listArtifacts(input.runId);
  const artifactById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const providerMatrixEvent = input.events.findLast((event) => event.type === "provider.matrix.pinned");
  return {
    providerMatrix: providerMatrixEvent
      ? { matrixHash: stringValue(providerMatrixEvent.payload.matrixHash) }
      : undefined,
    actionPersistence: input.events
      .filter((event) => ACTION_PERSISTENCE_EVENT_TYPES.has(event.type))
      .map((event) => {
        const externalOperationId = stringValue(event.payload.externalOperationId) ?? stringValue(event.payload.operationId);
        return {
          eventId: event.id,
          type: event.type,
          replayable: event.artifactIds.every((artifactId) => Boolean(artifactById.get(artifactId))) &&
            (!requiresExternalOperationManifest(event.type) || Boolean(externalOperationId))
        };
      })
  };
}

export function evaluateOfflineSelfContainedGate(input: {
  runId: string;
  ledger: Ledger;
  manifest: OfflineReplayGateManifest;
  audit: AuditResult;
  events: LedgerEvent[];
  nonReplayableSteps: Array<{ eventId: string; type: string; reason: string }>;
}): OfflineSelfContainedGate {
  const artifacts = input.ledger.listArtifacts(input.runId);
  const artifactIds = new Set(artifacts.map((artifact) => artifact.id));
  const issues: OfflineSelfContainedGate["issues"] = [];
  const witness = input.ledger.verifyLedgerWitness(input.runId);
  for (const issue of witness.issues) {
    issues.push({
      code: issue.code,
      message: issue.message
    });
  }
  if (!input.audit.ok) {
    issues.push({
      code: "audit_failed",
      message: "Offline replay requires a clean audit before treating the run as self-contained."
    });
  }

  const providerEvents = input.events.filter((event) =>
    event.type === "ai.call.started" ||
    event.type === "ai.call.completed" ||
    event.type === "ai.call.failed" ||
    event.type === "ai.call.aborted" ||
    event.type === "ai.call.stream_chunk" ||
    event.type === "ai.call.transcript.persisted" ||
    event.type === "ai.call.step"
  );
  if (providerEvents.length > 0 && !input.manifest.providerMatrix?.matrixHash) {
    issues.push({
      code: "provider_matrix_missing",
      message: "Provider events are present but the replay manifest has no pinned provider matrix."
    });
  }

  for (const event of providerEvents) {
    if (event.type === "ai.call.started" || event.type === "ai.call.completed" || event.type === "ai.call.failed") {
      requireReplayArtifact({ event, payloadKey: "requestArtifactId", artifactIds, issues, code: "ai_request_artifact_missing" });
      const providerMatrix = isRecord(event.payload.providerMatrix) ? event.payload.providerMatrix : undefined;
      if (!stringValue(providerMatrix?.matrixHash)) {
        issues.push({
          code: "ai_provider_matrix_hash_missing",
          message: `AI event ${event.id} is not bound to a provider matrix hash.`,
          eventId: event.id
        });
      }
    }
    if (event.type === "ai.call.completed") {
      requireReplayArtifact({ event, payloadKey: "responseArtifactId", artifactIds, issues, code: "ai_response_artifact_missing" });
      requireReplayArtifact({ event, payloadKey: "transcriptArtifactId", artifactIds, issues, code: "ai_transcript_artifact_missing" });
      if (!isRecord(event.payload.usage)) {
        issues.push({
          code: "ai_usage_missing",
          message: `AI completion ${event.id} is missing persisted usage metadata.`,
          eventId: event.id
        });
      }
      const provider = stringValue(event.payload.provider);
      const modelId = stringValue(event.payload.modelId);
      const provenance = isRecord(event.payload.providerProvenance) ? event.payload.providerProvenance : undefined;
      if (!stringValue(event.payload.providerMetadataHash)) {
        issues.push({
          code: "ai_provider_metadata_hash_missing",
          message: `AI completion ${event.id} is missing a provider metadata hash.`,
          eventId: event.id
        });
      }
      if (!stringValue(provenance?.pricingSource)) {
        issues.push({
          code: "ai_pricing_source_missing",
          message: `AI completion ${event.id} is missing provider pricing source provenance.`,
          eventId: event.id
        });
      }
      if (!stringValue(provenance?.actualUpstreamModel) || !stringValue(provenance?.actualUpstreamProvider)) {
        issues.push({
          code: "ai_upstream_provenance_missing",
          message: `AI completion ${event.id} is missing actual upstream provider/model provenance.`,
          eventId: event.id
        });
      }
      if (provider === "openrouter") {
        const actual = stringValue(provenance?.actualUpstreamModel);
        if (!actual) {
          issues.push({
            code: "openrouter_upstream_provenance_missing",
            message: `OpenRouter completion ${event.id} is missing actual upstream model provenance.`,
            eventId: event.id
          });
        } else if (actual !== modelId) {
          issues.push({
            code: "openrouter_upstream_drift_without_routing_event",
            message: `OpenRouter completion ${event.id} requested ${modelId} but recorded upstream ${actual} without an explicit routing event.`,
            eventId: event.id
          });
        }
      }
    }
    if (event.type === "ai.call.failed") {
      requireReplayArtifact({ event, payloadKey: "errorArtifactId", artifactIds, issues, code: "ai_error_artifact_missing" });
      requireReplayArtifact({ event, payloadKey: "transcriptArtifactId", artifactIds, issues, code: "ai_transcript_artifact_missing" });
    }
    if (event.type === "ai.call.aborted") {
      requireReplayArtifact({ event, payloadKey: "errorArtifactId", artifactIds, issues, code: "ai_error_artifact_missing" });
      requireReplayArtifact({ event, payloadKey: "transcriptArtifactId", artifactIds, issues, code: "ai_transcript_artifact_missing" });
    }
    if (event.type === "ai.call.stream_chunk") {
      requireReplayArtifact({ event, payloadKey: "streamChunkArtifactId", artifactIds, issues, code: "ai_stream_chunk_artifact_missing" });
    }
    if (event.type === "ai.call.step") {
      requireReplayArtifact({ event, payloadKey: "stepArtifactId", artifactIds, issues, code: "ai_step_artifact_missing" });
    }
    if (event.type === "ai.call.transcript.persisted") {
      requireReplayArtifact({ event, payloadKey: "transcriptArtifactId", artifactIds, issues, code: "ai_transcript_artifact_missing" });
      requireReplayArtifact({ event, payloadKey: "requestArtifactId", artifactIds, issues, code: "ai_request_artifact_missing" });
    }
  }

  for (const event of input.events) {
    if (event.type === "source.query") {
      requireReplayArtifact({ event, payloadKey: "requestArtifactId", artifactIds, issues, code: "source_query_request_artifact_missing" });
    }
    if (event.type === "source.results") {
      requireReplayArtifact({ event, payloadKey: "artifactId", artifactIds, issues, code: "source_result_artifact_missing" });
      if (event.payload.provider === "mathlib") {
        const pinnedIndexHash = stringValue(event.payload.indexHash);
        const currentIndexHash = defaultMathlibTheoremIndexSnapshot().indexHash;
        if (!pinnedIndexHash) {
          issues.push({
            code: "mathlib_theorem_index_hash_missing",
            message: `Mathlib theorem retrieval ${event.id} is missing a pinned index hash.`,
            eventId: event.id
          });
        } else if (pinnedIndexHash !== currentIndexHash) {
          issues.push({
            code: "mathlib_theorem_index_drift",
            message: `Mathlib theorem retrieval ${event.id} was pinned to ${pinnedIndexHash} but current index is ${currentIndexHash}.`,
            eventId: event.id
          });
        }
      }
    }
    if (event.type === "verifier.completed" && event.artifactIds.length === 0) {
      issues.push({
        code: "verifier_artifact_missing",
        message: `Verifier completion ${event.id} has no persisted verifier artifact links.`,
        eventId: event.id
      });
    }
    if (event.type === "remote.worker.attested") {
      requireReplayArtifact({ event, payloadKey: "artifactId", artifactIds, issues, code: "remote_worker_attestation_artifact_missing" });
    }
    if (event.type === "provider.retry.scheduled") {
      requireReplayArtifact({ event, payloadKey: "retryRequestArtifactId", artifactIds, issues, code: "provider_retry_request_artifact_missing" });
      requireReplayArtifact({ event, payloadKey: "retryErrorArtifactId", artifactIds, issues, code: "provider_retry_error_artifact_missing" });
    }
  }

  const eventsByReservation = new Map<string, LedgerEvent[]>();
  const operationsById = new Map(input.ledger.listExternalOperations(input.runId).map((operation) => [operation.id, operation]));
  for (const event of input.events) {
    const reservationId = stringValue(event.payload.reservationId);
    if (!reservationId) continue;
    const existing = eventsByReservation.get(reservationId) ?? [];
    existing.push(event);
    eventsByReservation.set(reservationId, existing);
  }

  for (const event of input.events) {
    const operationId = externalOperationIdForEvent(event);
    if (!operationId) continue;
    const operation = operationsById.get(operationId);
    if (!operation) {
      issues.push({
        code: "external_effect_operation_missing",
        message: `External effect event ${event.id} (${event.type}) references missing external operation ${operationId}.`,
        eventId: event.id,
        operationId
      });
      continue;
    }
    const reservationId = stringValue(event.payload.reservationId);
    if (reservationId && reservationId !== operation.reservationId) {
      issues.push({
        code: "external_effect_reservation_mismatch",
        message: `External effect event ${event.id} (${event.type}) references reservation ${reservationId} but operation ${operationId} is bound to ${operation.reservationId}.`,
        eventId: event.id,
        operationId
      });
    }
  }

  const externalOperations = input.ledger.listExternalOperations(input.runId);
  for (const operation of externalOperations) {
    const reservationEvents = eventsByReservation.get(operation.reservationId) ?? [];
    if (!reservationEvents.some((event) => event.type === "budget.reserved")) {
      issues.push({
        code: "external_operation_budget_reservation_missing",
        message: `External operation ${operation.id} has no replayable budget.reserved event.`,
        operationId: operation.id
      });
    }
    const settlementEvents = reservationEvents.filter((event) => event.type === "budget.debited" || event.type === "budget.released");
    if ((operation.status === "succeeded" || operation.status === "failed" || operation.status === "released") &&
      settlementEvents.length !== 1) {
      issues.push({
        code: "external_operation_budget_settlement_missing",
        message: `External operation ${operation.id} has ${settlementEvents.length} replayable budget settlement events; exactly one is required.`,
        operationId: operation.id
      });
    }
    if ((operation.status === "reserved" || operation.status === "running" || operation.status === "unknown_remote_outcome" || operation.status === "dead_lettered") &&
      settlementEvents.length > 0) {
      issues.push({
        code: "external_operation_unsettled_status_has_settlement",
        message: `External operation ${operation.id} is ${operation.status} but reservation ${operation.reservationId} already has a settlement event.`,
        operationId: operation.id
      });
    }
    if (operation.requestArtifactId && !artifactIds.has(operation.requestArtifactId)) {
      issues.push({
        code: "external_operation_request_artifact_missing",
        message: `External operation ${operation.id} references missing request artifact ${operation.requestArtifactId}.`,
        operationId: operation.id,
        artifactId: operation.requestArtifactId
      });
    }
    if (operation.status === "succeeded" && (!operation.responseArtifactId || !artifactIds.has(operation.responseArtifactId))) {
      issues.push({
        code: "external_operation_response_artifact_missing",
        message: `External operation ${operation.id} succeeded without a replayable response artifact.`,
        operationId: operation.id,
        artifactId: operation.responseArtifactId
      });
    }
  }

  for (const action of input.manifest.actionPersistence) {
    if (!action.replayable) {
      issues.push({
        code: "action_not_replayable",
        message: `Action event ${action.eventId} (${action.type}) is missing persisted artifacts required for offline replay.`,
        eventId: action.eventId
      });
    }
  }

  return {
    ok: issues.length === 0,
    networkPolicy: "no_new_network_or_provider_calls",
    semantics: "Offline replay is self-contained only when every external effect is reconstructed from persisted ledger rows, artifacts, budget events, provider matrix pins, and the external ledger witness.",
    checked: {
      events: input.events.length,
      artifacts: artifacts.length,
      externalOperations: externalOperations.length,
      nonReplayableSteps: input.nonReplayableSteps.length
    },
    issues
  };
}

function requireReplayArtifact(input: {
  event: LedgerEvent;
  payloadKey: string;
  artifactIds: Set<string>;
  issues: OfflineSelfContainedGate["issues"];
  code: string;
}): void {
  const artifactId = stringValue(input.event.payload[input.payloadKey]);
  if (!artifactId || !input.artifactIds.has(artifactId)) {
    input.issues.push({
      code: input.code,
      message: `Event ${input.event.id} (${input.event.type}) is missing replay artifact ${input.payloadKey}.`,
      eventId: input.event.id,
      artifactId
    });
    return;
  }
  if (!input.event.artifactIds.includes(artifactId)) {
    input.issues.push({
      code: `${input.code}_not_linked`,
      message: `Event ${input.event.id} (${input.event.type}) payload artifact ${artifactId} is not linked in event artifactIds.`,
      eventId: input.event.id,
      artifactId
    });
  }
}

function nonReplayableReason(type: string): string {
  if (type.startsWith("ai.call.")) return "provider call is reconstructed from persisted request/response/step artifacts";
  if (type.startsWith("source.")) return "source retrieval is reconstructed from persisted source artifacts";
  if (type.startsWith("verifier.")) return "verifier execution is reconstructed from persisted verifier artifacts";
  if (type === "provider.retry.scheduled") return "provider retry scheduling is reconstructed from the parent and retry attempt outbox operations";
  if (type.startsWith("external.operation.")) return "external operation boundary is reconstructed from durable outbox rows and budget events";
  return "event is replayed from persisted ledger state";
}

function requiresExternalOperationManifest(type: string): boolean {
  return type.startsWith("ai.call.") ||
    type === "provider.retry.scheduled" ||
    type === "source.query" ||
    type.startsWith("worker.tool.") ||
    type.startsWith("external.operation.");
}

const ACTION_PERSISTENCE_EVENT_TYPES = new Set<string>([
  "artifact.created",
  "source.query",
  "source.results",
  "source.offline_cache.used",
  "source.offline_cache.missed",
  "ai.call.started",
  "ai.call.stream_chunk",
  "ai.call.step",
  "ai.call.transcript.persisted",
  "ai.call.completed",
  "ai.call.failed",
  "ai.call.aborted",
  "provider.retry.scheduled",
  "external.operation.reserved",
  "external.operation.started",
  "external.operation.completed",
  "external.operation.failed",
  "external.operation.unknown",
  "external.operation.dead_lettered",
  "external.operation.ignored",
  "external.operation.released",
  "verifier.started",
  "verifier.completed",
  "proof.certificate.minimized",
  "adversarial.quorum.reviewed",
  "loophole.assumption_delta.reviewed",
  "worker.enqueued",
  "worker.leased",
  "worker.reservation_bound",
  "worker.started",
  "worker.heartbeat",
  "worker.committed",
  "worker.completed",
  "worker.tool.started",
  "worker.tool.completed",
  "worker.tool.cancelled",
  "worker.tool.failed",
  "worker.mutation.ignored",
  "worker.failed",
  "worker.cancelled",
  "worker.reconciled",
  "worker.stale",
  "worker.revoked",
  "worker.quarantined",
  "swarm.capacity.reviewed",
  "context.compaction.reviewed",
  "remote.worker.attested"
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function externalOperationIdForEvent(event: LedgerEvent): string | undefined {
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
