import type { Artifact, EvidenceGrade, LedgerEvent } from "./domain";
import {
  isUntrustedLiteratureArtifact,
  isUntrustedLiteratureEventType,
  literatureArtifactViolation,
  literatureEventViolation,
  type LiteratureEvidenceViolation
} from "./literature-policy";

export type ProofObligationStatus =
  | "unchecked"
  | "syntactic"
  | "semantic"
  | "lean_checked"
  | "computational_evidence"
  | "externally_cited"
  | "informal_unverified"
  | "independently_rejected"
  | "contradicted"
  | "invalid";

export type ProofObligation = {
  id: string;
  statement: string;
  assumptions: string[];
  conclusion: string;
  dependencies: string[];
  dependencyEventIds: string[];
  status: ProofObligationStatus;
  verifierId?: string;
  artifactIds: string[];
  nonblocking?: boolean;
  reproducibility?: ComputationalReproducibilityManifest;
  counterexampleSearch?: "not_run" | "attempted" | "passed" | "found";
  counterexampleSearches?: CounterexampleSearchEvidence[];
};

export type ComputationalReproducibilityManifest = {
  executableArtifactId: string;
  command: string;
  seed: string;
  environmentHash: string;
  inputDomain: string;
  boundsStatement: string;
  outputHash: string;
  independentRerunArtifactId: string;
  failureClassification: "none" | "setup_failed" | "execution_failed" | "output_mismatch" | "non_deterministic" | "not_reproduced";
};

export type CounterexampleSearchMethod = "numeric" | "symbolic" | "random" | "domain_specific";
export type CounterexampleSearchOutcome = "not_applicable" | "not_run" | "attempted" | "passed" | "found";

export type CounterexampleSearchEvidence = {
  method: CounterexampleSearchMethod;
  outcome: CounterexampleSearchOutcome;
  artifactIds: string[];
  verifierId?: string;
  domain?: string;
  checkedCases?: number;
  seed?: string;
  counterexample?: string;
  notes?: string;
};

export type ProofObligationGraph = {
  rootClaimId: string;
  obligations: ProofObligation[];
};

export type ProofObligationDecision = {
  ok: boolean;
  unresolvedObligations: ProofObligation[];
  invalidObligations: ProofObligation[];
  missingDependencies: Array<{ obligationId: string; dependencyId: string }>;
  missingDependencyEvents: Array<{ obligationId: string; eventId: string }>;
  invalidDependencyEvents: Array<{ obligationId: string; eventId: string; eventType?: string; reason: string }>;
  structuralGaps: Array<{ obligationId: string; field: string; reason: string }>;
  insufficientVerification: Array<{ obligationId: string; status: ProofObligationStatus; targetEvidenceGrade: EvidenceGrade; reason: string }>;
  untrustedLiteratureEvidence: Array<{ obligationId: string } & LiteratureEvidenceViolation>;
  missingReproducibilityManifests: Array<{ obligationId: string; field: string; reason: string }>;
  duplicateObligationIds: string[];
  cyclicDependencies: Array<{ obligationId: string; dependencyId: string }>;
  unreachableObligations: ProofObligation[];
  missingArtifacts: Array<{ obligationId: string; artifactId: string }>;
  counterexampleGaps: ProofObligation[];
  missingCounterexampleMethods: Array<{ obligationId: string; method: CounterexampleSearchMethod }>;
  foundCounterexamples: Array<{
    obligationId: string;
    method: CounterexampleSearchMethod | "summary";
    counterexample?: string;
    artifactIds: string[];
  }>;
};

const REQUIRED_COUNTEREXAMPLE_METHODS: CounterexampleSearchMethod[] = ["numeric", "symbolic", "random", "domain_specific"];

export type ProofObligationTrace = {
  ok: boolean;
  rootClaimId: string;
  orderedObligationIds: string[];
  unresolvedObligationIds: string[];
  missingDependencyIds: string[];
  cycleDetected: boolean;
};

const VERIFIED_STATUSES: ProofObligationStatus[] = ["lean_checked", "computational_evidence", "semantic", "externally_cited"];
const PROOF_SUPPORT_EVENT_TYPES = new Set<string>([
  "verifier.completed",
  "theorem.normalized",
  "theorem.equivalence.reviewed",
  "formalization.assessed",
  "counterexample.search.reviewed",
  "proof.obligations.reviewed",
  "worker.committed",
  "artifact.created"
]);

export function evaluateProofObligationGraph(
  graph: ProofObligationGraph,
  artifacts: Artifact[],
  options: { requireCounterexampleSearch?: boolean; events?: LedgerEvent[]; evidenceGrade?: EvidenceGrade } = {}
): ProofObligationDecision {
  const obligationById = new Map(graph.obligations.map((obligation) => [obligation.id, obligation]));
  const artifactIds = new Set(artifacts.map((artifact) => artifact.id));
  const artifactsById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const eventById = new Map((options.events ?? []).map((event) => [event.id, event]));
  const eventIds = new Set(eventById.keys());
  const structure = analyzeGraphStructure(graph);
  const structuralGaps = [
    ...structure.structuralGaps,
    ...graph.obligations.flatMap((obligation) => structuralGapsFor(obligation))
  ];
  const unresolvedObligations = graph.obligations.filter((obligation) => !isVerifiedForTarget(obligation, options.evidenceGrade));
  const insufficientVerification = options.evidenceGrade
    ? graph.obligations
        .filter((obligation) => VERIFIED_STATUSES.includes(obligation.status) && !isVerifiedForTarget(obligation, options.evidenceGrade))
        .map((obligation) => ({
          obligationId: obligation.id,
          status: obligation.status,
          targetEvidenceGrade: options.evidenceGrade!,
          reason: verificationStatusReason(obligation.status, options.evidenceGrade!)
        }))
    : [];
  const missingReproducibilityManifests = options.evidenceGrade === "verified_computation"
    ? graph.obligations.flatMap((obligation) => reproducibilityManifestGapsFor(obligation))
    : [];
  const invalidObligations = graph.obligations.filter((obligation) =>
    obligation.status === "invalid" ||
    obligation.status === "contradicted" ||
    obligation.status === "independently_rejected"
  );
  const missingDependencies = graph.obligations.flatMap((obligation) =>
    obligation.dependencies
      .filter((dependencyId) => !obligationById.has(dependencyId))
      .map((dependencyId) => ({ obligationId: obligation.id, dependencyId }))
  );
  const missingDependencyEvents = options.events
    ? graph.obligations.flatMap((obligation) =>
        dependencyEventIdsFor(obligation)
          .filter((eventId) => !eventIds.has(eventId))
          .map((eventId) => ({ obligationId: obligation.id, eventId }))
      )
    : [];
  const invalidDependencyEvents = options.events
    ? graph.obligations.flatMap((obligation) =>
        dependencyEventIdsFor(obligation)
          .map((eventId) => ({ obligation, eventId, event: eventById.get(eventId) }))
          .filter((item) => item.event && !PROOF_SUPPORT_EVENT_TYPES.has(item.event.type))
          .map((item) => ({
            obligationId: item.obligation.id,
            eventId: item.eventId,
            eventType: item.event?.type,
            reason: item.event && isUntrustedLiteratureEventType(item.event.type)
              ? literatureEventViolation(item.eventId, item.event.type).reason
              : "dependency event type does not record proof-supporting evidence"
          }))
      )
    : [];
  const missingArtifacts = graph.obligations.flatMap((obligation) =>
    allArtifactIdsFor(obligation)
      .filter((artifactId) => !artifactIds.has(artifactId))
      .map((artifactId) => ({ obligationId: obligation.id, artifactId }))
  );
  const untrustedLiteratureEvidence = isHardEvidenceGrade(options.evidenceGrade)
    ? graph.obligations.flatMap((obligation) =>
        allArtifactIdsFor(obligation)
          .map((artifactId) => artifactsById.get(artifactId))
          .filter((artifact): artifact is Artifact => artifact !== undefined)
          .filter((artifact) => isUntrustedLiteratureArtifact(artifact))
          .map((artifact) => ({
            obligationId: obligation.id,
            ...literatureArtifactViolation(artifact)
          }))
      )
    : [];
  const foundCounterexamples = graph.obligations.flatMap((obligation) => foundCounterexamplesFor(obligation));
  const counterexampleGaps = options.requireCounterexampleSearch
    ? graph.obligations.filter((obligation) =>
        !hasPassedCounterexamplePressure(obligation)
      )
    : [];
  const missingCounterexampleMethods = options.requireCounterexampleSearch
    ? graph.obligations.flatMap((obligation) => missingCounterexampleMethodsFor(obligation))
    : [];

  return {
    ok:
      unresolvedObligations.length === 0 &&
      invalidObligations.length === 0 &&
      missingDependencies.length === 0 &&
      missingDependencyEvents.length === 0 &&
      invalidDependencyEvents.length === 0 &&
      structuralGaps.length === 0 &&
      insufficientVerification.length === 0 &&
      untrustedLiteratureEvidence.length === 0 &&
      missingReproducibilityManifests.length === 0 &&
      structure.duplicateObligationIds.length === 0 &&
      structure.cyclicDependencies.length === 0 &&
      structure.unreachableObligations.length === 0 &&
      missingArtifacts.length === 0 &&
      counterexampleGaps.length === 0 &&
      missingCounterexampleMethods.length === 0 &&
      foundCounterexamples.length === 0 &&
      Boolean(obligationById.get(graph.rootClaimId)),
    unresolvedObligations,
    invalidObligations,
    missingDependencies,
    missingDependencyEvents,
    invalidDependencyEvents,
    structuralGaps,
    insufficientVerification,
    untrustedLiteratureEvidence,
    missingReproducibilityManifests,
    duplicateObligationIds: structure.duplicateObligationIds,
    cyclicDependencies: structure.cyclicDependencies,
    unreachableObligations: structure.unreachableObligations,
    missingArtifacts,
    counterexampleGaps,
    missingCounterexampleMethods,
    foundCounterexamples
  };
}

function isHardEvidenceGrade(evidenceGrade: EvidenceGrade | undefined): boolean {
  return evidenceGrade === "formal_proof" ||
    evidenceGrade === "verified_computation" ||
    evidenceGrade === "verified_counterexample";
}

function dependencyEventIdsFor(obligation: ProofObligation): string[] {
  return Array.isArray(obligation.dependencyEventIds) ? obligation.dependencyEventIds : [];
}

export function traceProofObligations(
  graph: ProofObligationGraph,
  rootClaimId = graph.rootClaimId
): ProofObligationTrace {
  const obligationById = new Map(graph.obligations.map((obligation) => [obligation.id, obligation]));
  const orderedObligationIds: string[] = [];
  const unresolvedObligationIds: string[] = [];
  const missingDependencyIds: string[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  let cycleDetected = false;

  function visit(id: string): void {
    const obligation = obligationById.get(id);
    if (!obligation) {
      missingDependencyIds.push(id);
      return;
    }
    if (visiting.has(id)) {
      cycleDetected = true;
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of obligation.dependencies) visit(dependency);
    visiting.delete(id);
    visited.add(id);
    orderedObligationIds.push(id);
    if (!VERIFIED_STATUSES.includes(obligation.status)) unresolvedObligationIds.push(id);
  }

  visit(rootClaimId);
  return {
    ok: !cycleDetected && missingDependencyIds.length === 0 && unresolvedObligationIds.length === 0,
    rootClaimId,
    orderedObligationIds,
    unresolvedObligationIds,
    missingDependencyIds,
    cycleDetected
  };
}

export function makeProofObligationGraph(input: {
  rootClaimId: string;
  obligations: ProofObligation[];
}): ProofObligationGraph {
  return {
    rootClaimId: input.rootClaimId,
    obligations: input.obligations
  };
}

function analyzeGraphStructure(graph: ProofObligationGraph): {
  duplicateObligationIds: string[];
  cyclicDependencies: Array<{ obligationId: string; dependencyId: string }>;
  unreachableObligations: ProofObligation[];
  structuralGaps: Array<{ obligationId: string; field: string; reason: string }>;
} {
  const idCounts = new Map<string, number>();
  for (const obligation of graph.obligations) {
    idCounts.set(obligation.id, (idCounts.get(obligation.id) ?? 0) + 1);
  }
  const duplicateObligationIds = [...idCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([id]) => id);
  const obligationById = new Map(graph.obligations.map((obligation) => [obligation.id, obligation]));
  const structuralGaps: Array<{ obligationId: string; field: string; reason: string }> = [];
  if (!obligationById.has(graph.rootClaimId)) {
    structuralGaps.push({
      obligationId: graph.rootClaimId,
      field: "rootClaimId",
      reason: "root claim is missing from obligations"
    });
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const reachable = new Set<string>();
  const cyclicDependencies: Array<{ obligationId: string; dependencyId: string }> = [];

  function visit(id: string): void {
    const obligation = obligationById.get(id);
    if (!obligation) return;
    reachable.add(id);
    if (visiting.has(id)) return;
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependencyId of obligation.dependencies) {
      if (visiting.has(dependencyId)) {
        cyclicDependencies.push({ obligationId: id, dependencyId });
        continue;
      }
      visit(dependencyId);
    }
    visiting.delete(id);
    visited.add(id);
  }

  visit(graph.rootClaimId);
  const unreachableObligations = graph.obligations.filter((obligation) =>
    !reachable.has(obligation.id) && obligation.nonblocking !== true
  );
  for (const duplicateId of duplicateObligationIds) {
    structuralGaps.push({
      obligationId: duplicateId,
      field: "id",
      reason: "duplicate obligation id"
    });
  }
  for (const obligation of unreachableObligations) {
    structuralGaps.push({
      obligationId: obligation.id,
      field: "dependencies",
      reason: "obligation is not reachable from root claim"
    });
  }
  for (const edge of cyclicDependencies) {
    structuralGaps.push({
      obligationId: edge.obligationId,
      field: "dependencies",
      reason: `cyclic dependency on ${edge.dependencyId}`
    });
  }

  return {
    duplicateObligationIds,
    cyclicDependencies,
    unreachableObligations,
    structuralGaps
  };
}

function structuralGapsFor(obligation: ProofObligation): Array<{ obligationId: string; field: string; reason: string }> {
  const gaps: Array<{ obligationId: string; field: string; reason: string }> = [];
  if (obligation.id.trim().length === 0) {
    gaps.push({ obligationId: obligation.id, field: "id", reason: "id is empty" });
  }
  if (obligation.statement.trim().length === 0) {
    gaps.push({ obligationId: obligation.id, field: "statement", reason: "statement is empty" });
  }
  if (obligation.conclusion.trim().length === 0) {
    gaps.push({ obligationId: obligation.id, field: "conclusion", reason: "conclusion is empty" });
  }
  if (!Array.isArray(obligation.assumptions)) {
    gaps.push({ obligationId: obligation.id, field: "assumptions", reason: "assumptions must be explicit array" });
  }
  if (!Array.isArray(obligation.dependencyEventIds)) {
    gaps.push({ obligationId: obligation.id, field: "dependencyEventIds", reason: "dependency event IDs must be explicit array" });
  }
  if (obligation.counterexampleSearches && !Array.isArray(obligation.counterexampleSearches)) {
    gaps.push({ obligationId: obligation.id, field: "counterexampleSearches", reason: "counterexample searches must be explicit array" });
  }
  if (VERIFIED_STATUSES.includes(obligation.status) && !obligation.verifierId) {
    gaps.push({ obligationId: obligation.id, field: "verifierId", reason: "verified obligation is missing verifier id" });
  }
  if (VERIFIED_STATUSES.includes(obligation.status) && obligation.artifactIds.length === 0) {
    gaps.push({ obligationId: obligation.id, field: "artifactIds", reason: "verified obligation is missing verifier output artifact" });
  }
  return gaps;
}

function allArtifactIdsFor(obligation: ProofObligation): string[] {
  return [
    ...obligation.artifactIds,
    ...reproducibilityArtifactIdsFor(obligation),
    ...(obligation.counterexampleSearches ?? []).flatMap((search) => search.artifactIds)
  ];
}

function isVerifiedForTarget(obligation: ProofObligation, evidenceGrade: EvidenceGrade | undefined): boolean {
  if (!evidenceGrade) return VERIFIED_STATUSES.includes(obligation.status);
  if (evidenceGrade === "formal_proof") return obligation.status === "lean_checked";
  if (evidenceGrade === "verified_computation") return obligation.status === "computational_evidence";
  if (evidenceGrade === "verified_counterexample") {
    return obligation.status === "lean_checked" || obligation.status === "computational_evidence";
  }
  return VERIFIED_STATUSES.includes(obligation.status);
}

function verificationStatusReason(status: ProofObligationStatus, evidenceGrade: EvidenceGrade): string {
  if (evidenceGrade === "formal_proof") {
    return `formal_proof obligations require lean_checked discharge; ${status} can only support context or reductions`;
  }
  if (evidenceGrade === "verified_computation") {
    return `verified_computation obligations require computational_evidence discharge; ${status} is insufficient`;
  }
  if (evidenceGrade === "verified_counterexample") {
    return `verified_counterexample obligations require computational or formal validator discharge; ${status} is insufficient`;
  }
  return `${status} is insufficient for ${evidenceGrade}`;
}

function reproducibilityManifestGapsFor(obligation: ProofObligation): Array<{ obligationId: string; field: string; reason: string }> {
  if (obligation.status !== "computational_evidence") return [];
  const manifest = obligation.reproducibility;
  if (!manifest) {
    return [{
      obligationId: obligation.id,
      field: "reproducibility",
      reason: "computational evidence requires an executable reproducibility manifest"
    }];
  }
  const requiredFields: Array<keyof ComputationalReproducibilityManifest> = [
    "executableArtifactId",
    "command",
    "seed",
    "environmentHash",
    "inputDomain",
    "boundsStatement",
    "outputHash",
    "independentRerunArtifactId",
    "failureClassification"
  ];
  return requiredFields
    .filter((field) => {
      const value = manifest[field];
      return typeof value !== "string" || value.trim().length === 0;
    })
    .map((field) => ({
      obligationId: obligation.id,
      field: `reproducibility.${field}`,
      reason: "computational reproducibility manifest field is missing"
    }))
    .concat(isValidFailureClassification(manifest.failureClassification)
      ? []
      : [{
          obligationId: obligation.id,
          field: "reproducibility.failureClassification",
          reason: "computational reproducibility failure classification is invalid"
        }]);
}

function reproducibilityArtifactIdsFor(obligation: ProofObligation): string[] {
  const manifest = obligation.reproducibility;
  if (!manifest) return [];
  return [
    manifest.executableArtifactId,
    manifest.independentRerunArtifactId
  ].filter((artifactId) => typeof artifactId === "string" && artifactId.length > 0);
}

function isValidFailureClassification(value: string): value is ComputationalReproducibilityManifest["failureClassification"] {
  return value === "none" ||
    value === "setup_failed" ||
    value === "execution_failed" ||
    value === "output_mismatch" ||
    value === "non_deterministic" ||
    value === "not_reproduced";
}

function hasPassedCounterexamplePressure(obligation: ProofObligation): boolean {
  if (foundCounterexamplesFor(obligation).length > 0) return false;
  const searches = obligation.counterexampleSearches ?? [];
  if (searches.length === 0) return obligation.counterexampleSearch === "passed";
  return REQUIRED_COUNTEREXAMPLE_METHODS.every((method) => {
    const search = searches.find((item) => item.method === method);
    return search?.outcome === "passed" || search?.outcome === "not_applicable";
  });
}

function missingCounterexampleMethodsFor(obligation: ProofObligation): Array<{ obligationId: string; method: CounterexampleSearchMethod }> {
  const searches = obligation.counterexampleSearches ?? [];
  if (searches.length === 0) return [];
  return REQUIRED_COUNTEREXAMPLE_METHODS
    .filter((method) => {
      const search = searches.find((item) => item.method === method);
      return !search || (search.outcome !== "passed" && search.outcome !== "not_applicable");
    })
    .map((method) => ({ obligationId: obligation.id, method }));
}

function foundCounterexamplesFor(obligation: ProofObligation): Array<{
  obligationId: string;
  method: CounterexampleSearchMethod | "summary";
  counterexample?: string;
  artifactIds: string[];
}> {
  const found: Array<{
    obligationId: string;
    method: CounterexampleSearchMethod | "summary";
    counterexample?: string;
    artifactIds: string[];
  }> = (obligation.counterexampleSearches ?? [])
    .filter((search) => search.outcome === "found")
    .map((search) => ({
      obligationId: obligation.id,
      method: search.method,
      counterexample: search.counterexample,
      artifactIds: search.artifactIds
    }));
  if (obligation.counterexampleSearch === "found" && found.length === 0) {
    found.push({
      obligationId: obligation.id,
      method: "summary",
      artifactIds: obligation.artifactIds
    });
  }
  return found;
}
