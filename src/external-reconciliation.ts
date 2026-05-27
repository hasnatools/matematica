import type { ExternalOperation, Ledger } from "./ledger";

export type ExternalOutcomeReconciliationOperation = {
  id: string;
  operationType: string;
  provider?: string;
  status: ExternalOperation["status"];
  reservationId: string;
  requestArtifactId?: string;
  responseArtifactId?: string;
  quarantineEventId?: string;
  retainedReservation: boolean;
  operatorReconciliationSteps: string[];
};

export type ExternalOutcomeReconciliationReservation = {
  reservationId: string;
  operationId?: string;
  operationType?: string;
  provider?: string;
  retainedForUnknownOutcome: boolean;
  retainedForExternalOutcome: boolean;
  operatorReconciliationSteps: string[];
};

export type ExternalOutcomeReconciliationReport = {
  format: "matematica.external-outcome-reconciliation";
  version: 1;
  runId: string;
  ok: boolean;
  unknownOperations: ExternalOutcomeReconciliationOperation[];
  deadLetterOperations: ExternalOutcomeReconciliationOperation[];
  openOperations: ExternalOutcomeReconciliationOperation[];
  openReservations: ExternalOutcomeReconciliationReservation[];
  issueCodes: string[];
};

export function buildExternalOutcomeReconciliationReport(
  runId: string,
  ledger: Ledger
): ExternalOutcomeReconciliationReport {
  const operations = ledger.listExternalOperations(runId);
  const openReservations = ledger.listOpenBudgetReservations(runId);
  const openReservationIds = new Set(openReservations.map((reservation) => reservation.reservationId));
  const quarantineEventsByOperation = new Map<string, string>();
  for (const event of ledger.listEvents(runId)) {
    if (event.type !== "external.operation.unknown" && event.type !== "external.operation.dead_lettered") continue;
    const operationId = stringValue(event.payload.operationId);
    if (operationId) quarantineEventsByOperation.set(operationId, event.id);
  }

  const unknownOperations = operations
    .filter((operation) => operation.status === "unknown_remote_outcome")
    .map((operation) => operationReconciliation(operation, openReservationIds, quarantineEventsByOperation.get(operation.id)));
  const deadLetterOperations = operations
    .filter((operation) => operation.status === "dead_lettered")
    .map((operation) => operationReconciliation(operation, openReservationIds, quarantineEventsByOperation.get(operation.id)));
  const openOperations = operations
    .filter((operation) => operation.status === "reserved" || operation.status === "running")
    .map((operation) => operationReconciliation(operation, openReservationIds, quarantineEventsByOperation.get(operation.id)));
  const unknownReservationIds = new Set(unknownOperations.map((operation) => operation.reservationId));
  const retainedExternalOutcomeReservationIds = new Set([
    ...unknownOperations.map((operation) => operation.reservationId),
    ...deadLetterOperations.map((operation) => operation.reservationId)
  ]);
  const reservations = openReservations.map((reservation) => ({
    reservationId: reservation.reservationId,
    operationId: reservation.operationId,
    operationType: reservation.operationType,
    provider: reservation.provider,
    retainedForUnknownOutcome: unknownReservationIds.has(reservation.reservationId),
    retainedForExternalOutcome: retainedExternalOutcomeReservationIds.has(reservation.reservationId),
    operatorReconciliationSteps: reservationOperatorSteps(
      unknownReservationIds.has(reservation.reservationId),
      retainedExternalOutcomeReservationIds.has(reservation.reservationId)
    )
  }));
  const issueCodes = [
    ...(unknownOperations.length > 0 ? ["unknown_remote_outcome"] : []),
    ...(deadLetterOperations.length > 0 ? ["dead_lettered_dispatch"] : []),
    ...(openOperations.length > 0 ? ["open_external_operation"] : []),
    ...(reservations.length > 0 ? ["open_external_reservation"] : [])
  ];

  return {
    format: "matematica.external-outcome-reconciliation",
    version: 1,
    runId,
    ok: issueCodes.length === 0,
    unknownOperations,
    deadLetterOperations,
    openOperations,
    openReservations: reservations,
    issueCodes
  };
}

function operationReconciliation(
  operation: ExternalOperation,
  openReservationIds: Set<string>,
  quarantineEventId?: string
): ExternalOutcomeReconciliationOperation {
  return {
    id: operation.id,
    operationType: operation.operationType,
    provider: operation.provider,
    status: operation.status,
    reservationId: operation.reservationId,
    requestArtifactId: operation.requestArtifactId,
    responseArtifactId: operation.responseArtifactId,
    quarantineEventId,
    retainedReservation: openReservationIds.has(operation.reservationId),
    operatorReconciliationSteps: operationOperatorSteps(operation.status)
  };
}

function operationOperatorSteps(status: ExternalOperation["status"]): string[] {
  if (status === "unknown_remote_outcome") {
    return [
      "inspect the provider/tool/verifier/sandbox side effect out-of-band",
      "record the observed remote outcome as a new audited retry or reconciliation artifact",
      "keep the retained reservation open until an operator explicitly resolves the unknown outcome"
    ];
  }
  if (status === "dead_lettered") {
    return [
      "inspect the remote dispatch side effect out-of-band",
      "record the lost acknowledgement or terminal remote result as a new reconciliation artifact",
      "retry only through a new audited remote dispatch after operator settlement"
    ];
  }
  if (status === "reserved" || status === "running") {
    return [
      "run goal resume to reconcile pre-send reserved operations or quarantine post-send running operations",
      "do not release with reserved or running external operations still present"
    ];
  }
  return [];
}

function reservationOperatorSteps(retainedForUnknownOutcome: boolean, retainedForExternalOutcome: boolean): string[] {
  if (retainedForUnknownOutcome) {
    return [
      "do not auto-release this reservation",
      "resolve the paired unknown external operation before retrying or manually releasing retained budget"
    ];
  }
  if (retainedForExternalOutcome) {
    return [
      "do not auto-release this reservation",
      "resolve the paired dead-lettered remote dispatch before retrying or manually releasing retained budget"
    ];
  }
  return [
    "run goal resume to release stranded pre-send reservations",
    "verify no paired external operation can still complete remotely"
  ];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
