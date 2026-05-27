import type { Artifact, LedgerEvent } from "../domain";
import type { Ledger } from "../ledger";
import { ARXIV_POLITE_MIN_INTERVAL_MS } from "./arxiv";
import { readArtifactText } from "../storage-encryption";

export type ResearchComplianceIssue = {
  runId: string;
  eventId?: string;
  artifactId?: string;
  code: string;
  message: string;
};

export type ResearchComplianceReleaseReport = {
  format: "matematica.research-compliance-release";
  version: 1;
  ok: boolean;
  runsAudited: number;
  sourceResultEvents: number;
  citationReviewEvents: number;
  licenseManifestEvents: number;
  sourceArtifactsAudited: number;
  issues: ResearchComplianceIssue[];
};

const FORBIDDEN_ARXIV_ARTIFACT_KINDS = new Set([
  "source.arxiv.pdf",
  "source.arxiv.source",
  "source.arxiv.eprint",
  "source.arxiv.fulltext"
]);

export function buildResearchComplianceReleaseReport(ledger: Ledger): ResearchComplianceReleaseReport {
  const runs = ledger.listRuns();
  const issues: ResearchComplianceIssue[] = [];
  let sourceResultEvents = 0;
  let citationReviewEvents = 0;
  let licenseManifestEvents = 0;
  let sourceArtifactsAudited = 0;

  for (const run of runs) {
    const events = ledger.listEvents(run.id);
    const artifacts = ledger.listArtifacts(run.id);
    const artifactById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));

    const sourceResults = events.filter((event) => event.type === "source.results");
    const citationReviews = events.filter((event) => event.type === "source.citations.reviewed");
    const licenseManifests = events.filter((event) => event.type === "source.license.manifest.reviewed");
    sourceResultEvents += sourceResults.length;
    citationReviewEvents += citationReviews.length;
    licenseManifestEvents += licenseManifests.length;

    for (const artifact of artifacts) {
      if (!isSourceArtifact(artifact)) continue;
      sourceArtifactsAudited += 1;
      auditSourceArtifact(run.id, artifact, issues);
    }

    for (const event of sourceResults) {
      auditSourceResultsEvent(event, artifactById, issues);
    }
    for (const event of citationReviews) {
      auditCitationReviewEvent(event, issues);
    }
    for (const event of licenseManifests) {
      auditLicenseManifestEvent(event, issues);
    }
  }

  return {
    format: "matematica.research-compliance-release",
    version: 1,
    ok: issues.length === 0,
    runsAudited: runs.length,
    sourceResultEvents,
    citationReviewEvents,
    licenseManifestEvents,
    sourceArtifactsAudited,
    issues
  };
}

function auditSourceResultsEvent(
  event: LedgerEvent,
  artifactById: Map<string, Artifact>,
  issues: ResearchComplianceIssue[]
): void {
  const payload = event.payload;
  const count = numberValue(payload.count) ?? 0;
  if (payload.provider !== "arxiv") {
    pushIssue(issues, event, "research_provider_not_arxiv", "release research compliance currently supports only arXiv source events");
  }
  if (count === 0) return;

  const artifactId = stringValue(payload.artifactId);
  if (!artifactId || !artifactById.has(artifactId)) {
    pushIssue(issues, event, "source_results_missing_artifact", "source.results event is not backed by a persisted source artifact");
  }
  if (payload.quarantined !== true || payload.citationOnly !== true) {
    pushIssue(issues, event, "source_text_not_citation_only", "source text must remain quarantined and citation-only for public release runs");
  }
  if (stringArray(payload.hostileFlags).length > 0) {
    pushIssue(issues, event, "hostile_source_prompt_leakage", "source results include prompt-injection flags and must not pass the public release compliance gate");
  }

  auditArxivCompliancePolicy(event, recordValue(payload.compliance), issues);

  const records = recordArray(payload.sourceRecords);
  if (records.length !== count) {
    pushIssue(issues, event, "source_record_count_mismatch", `source.results count=${count} but sourceRecords=${records.length}`);
  }
  for (const [index, record] of records.entries()) {
    auditSourceRecord(event, index, record, issues);
  }

  auditCitationGrounding(event, recordValue(payload.citationGrounding), issues);
  auditLicenseManifest(event, recordValue(payload.citationLicenseManifest), records.length, issues);

  const retrievalEvaluation = recordValue(payload.retrievalEvaluation);
  if (retrievalEvaluation.canPromoteResearchBackedClaims === true && (
    stringArray(payload.hostileFlags).length > 0 ||
    (numberValue(retrievalEvaluation.staleResultCount) ?? 0) > 0 ||
    stringArray(retrievalEvaluation.failures).length > 0
  )) {
    pushIssue(issues, event, "unsafe_research_claim_promotion", "research with hostile, stale, or incomplete source evidence cannot promote research-backed claims");
  }
}

function auditCitationReviewEvent(event: LedgerEvent, issues: ResearchComplianceIssue[]): void {
  const payload = event.payload;
  if (payload.ok !== true || payload.requiresAdversarialReview === true) {
    pushIssue(issues, event, "citation_grounding_failed", "citation review contains ungrounded, hallucinated, or adversarial-review-required support");
  }
  auditCitationSupportPolicy(event, recordValue(payload.supportPolicy), issues);
  for (const finding of recordArray(payload.findings)) {
    if (finding.status !== "grounded") {
      pushIssue(issues, event, "citation_finding_not_grounded", `citation finding is ${String(finding.status ?? "missing")}, not grounded`);
      continue;
    }
    auditCitationSupportReview(event, recordValue(finding.supportReview), issues);
  }
}

function auditLicenseManifestEvent(event: LedgerEvent, issues: ResearchComplianceIssue[]): void {
  auditLicenseManifest(event, event.payload, recordArray(event.payload.entries).length, issues);
}

function auditSourceArtifact(runId: string, artifact: Artifact, issues: ResearchComplianceIssue[]): void {
  if (FORBIDDEN_ARXIV_ARTIFACT_KINDS.has(artifact.kind)) {
    issues.push({
      runId,
      artifactId: artifact.id,
      code: "arxiv_pdf_or_source_artifact_forbidden",
      message: `${artifact.kind} artifact is not portable without an explicit license grant`
    });
    return;
  }
  if (artifact.kind !== "source.arxiv.results") return;
  const text = readArtifactText(artifact);
  if (/"untrustedSummary"\s*:/.test(text)) {
    issues.push({
      runId,
      artifactId: artifact.id,
      code: "raw_source_text_persisted",
      message: "source.arxiv.results artifact persisted untrustedSummary instead of citation-only metadata/preview"
    });
  }
  if (/"pdfExported"\s*:\s*true|"sourceExported"\s*:\s*true|"fullTextExported"\s*:\s*true/.test(text)) {
    issues.push({
      runId,
      artifactId: artifact.id,
      code: "source_cache_privacy_violation",
      message: "source artifact claims arXiv PDF/source/fulltext content was exported"
    });
  }
}

function auditArxivCompliancePolicy(
  event: LedgerEvent,
  compliance: Record<string, unknown>,
  issues: ResearchComplianceIssue[]
): void {
  if (compliance.source !== "arxiv_api_terms_of_use") {
    pushIssue(issues, event, "arxiv_terms_source_missing", "arXiv compliance policy must cite the API terms of use");
  }
  if (compliance.termsUrl !== "https://info.arxiv.org/help/api/tou.html") {
    pushIssue(issues, event, "arxiv_terms_url_missing", "arXiv compliance policy must include the arXiv API terms URL");
  }
  if (compliance.maxConnections !== 1) {
    pushIssue(issues, event, "arxiv_parallel_fetch_not_allowed", "arXiv compliance policy must serialize API requests with maxConnections=1");
  }
  const minIntervalMs = numberValue(compliance.minIntervalMs);
  if (minIntervalMs === undefined || minIntervalMs < ARXIV_POLITE_MIN_INTERVAL_MS) {
    pushIssue(issues, event, "arxiv_rate_limit_too_low", `arXiv compliance policy must use minIntervalMs >= ${ARXIV_POLITE_MIN_INTERVAL_MS}`);
  }
  if (!String(compliance.userAgent ?? "").includes("matematica-cli/")) {
    pushIssue(issues, event, "arxiv_user_agent_missing", "arXiv compliance policy must include a Matematica user agent");
  }
  if (compliance.metadataRedistribution !== "allowed") {
    pushIssue(issues, event, "arxiv_metadata_policy_missing", "arXiv metadata redistribution policy must be explicit");
  }
  if (compliance.pdfAndSourceRedistribution !== "not_exported_without_license") {
    pushIssue(issues, event, "arxiv_pdf_source_policy_missing", "arXiv PDF/source content must not be exported without a license grant");
  }
}

function auditSourceRecord(
  event: LedgerEvent,
  index: number,
  record: Record<string, unknown>,
  issues: ResearchComplianceIssue[]
): void {
  const missing = [
    stringValue(record.query) || stringValue(event.payload.query) ? undefined : "query",
    stringValue(record.sourceId) ? undefined : "sourceId",
    stringValue(record.canonicalId) ? undefined : "canonicalId",
    numberValue(record.version) !== undefined ? undefined : "version",
    stringValue(record.title) ? undefined : "title",
    stringArray(record.authors).length > 0 ? undefined : "authors",
    stringValue(record.published) ? undefined : "published",
    stringValue(record.updated) ? undefined : "updated",
    stringValue(record.retrievedAt) ? undefined : "retrievedAt",
    numberValue(record.ranking) !== undefined ? undefined : "ranking",
    stringValue(record.url) ? undefined : "url",
    stringValue(record.abstractHash) ? undefined : "abstractHash",
    stringValue(record.snapshotHash) ? undefined : "snapshotHash",
    stringValue(record.rawMetadataHash) ? undefined : "rawMetadataHash",
    stringValue(record.contentHash) ? undefined : "contentHash",
    stringArray(record.extractedClaims).length > 0 ? undefined : "extractedClaims"
  ].filter((item): item is string => Boolean(item));
  if (missing.length > 0) {
    pushIssue(issues, event, "source_record_incomplete_release_metadata", `source record ${index + 1} is missing ${missing.join(", ")}`);
  }
}

function auditCitationGrounding(
  event: LedgerEvent,
  grounding: Record<string, unknown>,
  issues: ResearchComplianceIssue[]
): void {
  if (grounding.ok !== true || grounding.requiresAdversarialReview === true) {
    pushIssue(issues, event, "citation_grounding_failed", "source.results citation grounding is not fully grounded");
  }
  auditCitationSupportPolicy(event, recordValue(grounding.supportPolicy), issues);
  for (const finding of recordArray(grounding.findings)) {
    if (finding.status !== "grounded") {
      pushIssue(issues, event, "citation_finding_not_grounded", `source.results citation finding is ${String(finding.status ?? "missing")}`);
      continue;
    }
    auditCitationSupportReview(event, recordValue(finding.supportReview), issues);
  }
}

function auditCitationSupportPolicy(
  event: LedgerEvent,
  policy: Record<string, unknown>,
  issues: ResearchComplianceIssue[]
): void {
  const ok = policy.sourceExistenceIsNotMathematicalSupport === true &&
    policy.exactArxivVersionRequired === true &&
    policy.snapshotHashRequired === true &&
    policy.quotedSpanRequired === true &&
    policy.independentEntailmentRequired === true &&
    policy.licenseAndProvenanceRequired === true &&
    policy.canSupportSolvedClaim === false;
  if (!ok) {
    pushIssue(issues, event, "citation_support_policy_missing", "citation policy must require exact source version, snapshot hash, quoted span, independent entailment, provenance, and no solved-claim support");
  }
}

function auditCitationSupportReview(
  event: LedgerEvent,
  review: Record<string, unknown>,
  issues: ResearchComplianceIssue[]
): void {
  const entailment = recordValue(review.entailment);
  const ok = review.sourceExists === true &&
    review.exactArxivVersion === true &&
    review.snapshotHashMatches === true &&
    review.quotedSpanLocated === true &&
    stringValue(review.quotedSpanHash) !== undefined &&
    stringValue(review.quotedSpan) !== undefined &&
    review.licenseAndProvenancePresent === true &&
    review.staleStatus !== "stale" &&
    review.withdrawn === false &&
    entailment.independent === true &&
    entailment.status === "entailed" &&
    review.canSupportMathematicalClaim === true &&
    review.canSupportSolvedClaim === false &&
    review.proofSupport === "not_proof_support";
  if (!ok) {
    pushIssue(issues, event, "citation_support_review_incomplete", "grounded citation review lacks release-grade exact-version, snapshot, quoted-span, provenance, freshness, and independent entailment evidence");
  }
}

function auditLicenseManifest(
  event: LedgerEvent,
  manifest: Record<string, unknown>,
  expectedEntries: number,
  issues: ResearchComplianceIssue[]
): void {
  if (manifest.format !== "matematica.citation-license-manifest" || manifest.version !== 1) {
    pushIssue(issues, event, "citation_license_manifest_invalid", "citation license manifest must use matematica.citation-license-manifest v1");
  }
  const entries = recordArray(manifest.entries);
  if (entries.length !== expectedEntries) {
    pushIssue(issues, event, "citation_license_manifest_entry_mismatch", `license manifest entries=${entries.length} expected=${expectedEntries}`);
  }
  const summary = recordValue(manifest.summary);
  if (summary.pdfOrSourceContentExported !== false) {
    pushIssue(issues, event, "source_pdf_or_source_exported_without_license", "license manifest must prove no arXiv PDF/source content export");
  }
  if (summary.copiedTextPolicy !== "metadata_and_abstract_excerpt_only") {
    pushIssue(issues, event, "copied_text_policy_missing", "license manifest must restrict copied text to metadata and abstract excerpts");
  }
  if (summary.proofSupportPolicy !== "citation_metadata_is_not_proof_support") {
    pushIssue(issues, event, "citation_proof_boundary_missing", "license manifest must state citation metadata is not proof support");
  }
  if ((numberValue(summary.staleCount) ?? 0) > 0) {
    pushIssue(issues, event, "stale_source_release_blocked", "public release gate rejects stale arXiv source records");
  }
  if ((numberValue(summary.hostileCount) ?? 0) > 0) {
    pushIssue(issues, event, "hostile_source_release_blocked", "public release gate rejects hostile prompt-injection source records");
  }
  for (const entry of entries) {
    auditLicenseManifestEntry(event, entry, issues);
  }
}

function auditLicenseManifestEntry(
  event: LedgerEvent,
  entry: Record<string, unknown>,
  issues: ResearchComplianceIssue[]
): void {
  const missing = [
    stringValue(entry.sourceId) ? undefined : "sourceId",
    stringValue(entry.canonicalId) ? undefined : "canonicalId",
    numberValue(entry.version) !== undefined ? undefined : "version",
    stringValue(entry.retrievalTimestamp) ? undefined : "retrievalTimestamp",
    stringValue(entry.contentHash) ? undefined : "contentHash",
    stringValue(entry.citationFormat) ? undefined : "citationFormat",
    stringValue(entry.manifestHash) ? undefined : "manifestHash"
  ].filter((item): item is string => Boolean(item));
  if (missing.length > 0) {
    pushIssue(issues, event, "citation_license_manifest_entry_incomplete", `license manifest entry is missing ${missing.join(", ")}`);
  }
  const license = recordValue(entry.license);
  if (license.metadataRedistribution !== "allowed" ||
    license.pdfAndSourceRedistribution !== "not_exported_without_license" ||
    license.termsUrl !== "https://info.arxiv.org/help/api/tou.html") {
    pushIssue(issues, event, "citation_license_policy_incomplete", "license manifest entry must include arXiv metadata, PDF/source, and terms provenance");
  }
  const copiedTextPolicy = recordValue(entry.copiedTextPolicy);
  if (copiedTextPolicy.pdfExported !== false ||
    copiedTextPolicy.sourceExported !== false ||
    copiedTextPolicy.fullTextExported !== false ||
    copiedTextPolicy.supportTextIsProofSupport !== false) {
    pushIssue(issues, event, "source_cache_privacy_violation", "license manifest entry permits exported source content or treats source text as proof support");
  }
  const verifiedSupport = recordValue(entry.verifiedSupport);
  if (verifiedSupport.status !== "citation_metadata_and_support_verified" ||
    verifiedSupport.proofSupport !== "not_proof_support" ||
    verifiedSupport.canSupportSolvedClaim !== false) {
    pushIssue(issues, event, "citation_support_not_release_verified", "license manifest entry lacks release-grade citation support verification");
  }
  if (recordValue(entry.staleStatus).status === "stale") {
    pushIssue(issues, event, "stale_source_release_blocked", "license manifest entry marks the arXiv source stale");
  }
  if (recordValue(entry.hostileSource).flagged === true) {
    pushIssue(issues, event, "hostile_source_release_blocked", "license manifest entry marks the source as hostile");
  }
  if (entry.storagePolicy !== "metadata_only_not_exported") {
    pushIssue(issues, event, "source_storage_policy_not_metadata_only", "source storage policy must be metadata-only and not exported");
  }
}

function isSourceArtifact(artifact: Artifact): boolean {
  return artifact.kind.startsWith("source.") ||
    artifact.kind.includes("arxiv") ||
    artifact.kind.includes("citation");
}

function pushIssue(
  issues: ResearchComplianceIssue[],
  event: LedgerEvent,
  code: string,
  message: string
): void {
  issues.push({
    runId: event.runId,
    eventId: event.id,
    code,
    message
  });
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function recordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item))
    : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
