import type { ArtifactStore } from "./artifacts";
import type { Artifact, LedgerEvent } from "./domain";
import { defaultTrustedVerifiers, type TrustedVerifier } from "./evidence";
import { stableHash } from "./idempotency";
import type { Ledger } from "./ledger";
import { readArtifactText } from "./storage-encryption";

export const VERIFIER_POLICY_SCHEMA_VERSION = 1;
export const VERIFIER_POLICY_VERSION = "verifier-policy-v1";
export const EVIDENCE_GATE_VERSION = "evidence-gate-v1";
export const PROOF_OBLIGATION_RULES_VERSION = "proof-obligations-v1";
export const PROBLEM_CLASSIFIER_VERSION = "problem-classifier-v2";
export const FINAL_OUTCOME_MAPPING_VERSION = "final-outcome-v1";

export type VerifierPolicyManifest = {
  schemaVersion: number;
  policyVersion: string;
  evidenceGateVersion: string;
  proofObligationRulesVersion: string;
  problemClassifierVersion: string;
  finalOutcomeMappingVersion: string;
  trustedVerifiers: TrustedVerifier[];
  finalOutcomeMapping: Record<string, { state: string; canClaimSolved: boolean }>;
  policyHash: string;
};

export type PinnedVerifierPolicy = {
  manifest: VerifierPolicyManifest;
  artifactId: string;
};

const FINAL_OUTCOME_MAPPING: VerifierPolicyManifest["finalOutcomeMapping"] = {
  formal_proof: { state: "formal_proof", canClaimSolved: true },
  verified_computation: { state: "computational_evidence", canClaimSolved: true },
  verified_counterexample: { state: "counterexample", canClaimSolved: false },
  conjectural_solution: { state: "conjecture", canClaimSolved: false },
  literature_backed_reduction: { state: "conjecture", canClaimSolved: false },
  contradicted: { state: "counterexample", canClaimSolved: false },
  budget_exhausted: { state: "budget_exhausted", canClaimSolved: false },
  none: { state: "conjecture", canClaimSolved: false },
  unsupported: { state: "conjecture", canClaimSolved: false },
  heuristic_evidence: { state: "conjecture", canClaimSolved: false }
};

export function buildVerifierPolicyManifest(input: {
  trustedVerifiers?: TrustedVerifier[];
} = {}): VerifierPolicyManifest {
  const withoutHash = {
    schemaVersion: VERIFIER_POLICY_SCHEMA_VERSION,
    policyVersion: VERIFIER_POLICY_VERSION,
    evidenceGateVersion: EVIDENCE_GATE_VERSION,
    proofObligationRulesVersion: PROOF_OBLIGATION_RULES_VERSION,
    problemClassifierVersion: PROBLEM_CLASSIFIER_VERSION,
    finalOutcomeMappingVersion: FINAL_OUTCOME_MAPPING_VERSION,
    trustedVerifiers: normalizeTrustedVerifiers(input.trustedVerifiers ?? defaultTrustedVerifiers()),
    finalOutcomeMapping: FINAL_OUTCOME_MAPPING
  };
  return {
    ...withoutHash,
    policyHash: stableHash(withoutHash)
  };
}

export function ensureRunVerifierPolicyManifest(
  runId: string,
  ledger: Ledger,
  artifacts: ArtifactStore,
  manifest: VerifierPolicyManifest = buildVerifierPolicyManifest()
): PinnedVerifierPolicy {
  const existing = loadRunVerifierPolicyManifest(runId, ledger);
  if (existing) return existing;

  const artifact = artifacts.create(runId, "policy.verifier.manifest", JSON.stringify(manifest, null, 2));
  ledger.appendEvent(runId, "policy.manifest.pinned", {
    artifactId: artifact.id,
    policyHash: manifest.policyHash,
    policyVersion: manifest.policyVersion,
    evidenceGateVersion: manifest.evidenceGateVersion,
    proofObligationRulesVersion: manifest.proofObligationRulesVersion,
    problemClassifierVersion: manifest.problemClassifierVersion,
    finalOutcomeMappingVersion: manifest.finalOutcomeMappingVersion,
    trustedVerifierIds: manifest.trustedVerifiers.map((verifier) => verifier.id)
  }, [artifact.id]);
  return { manifest, artifactId: artifact.id };
}

export function loadRunVerifierPolicyManifest(runId: string, ledger: Ledger): PinnedVerifierPolicy | undefined {
  const events = ledger.listEvents(runId);
  const artifacts = ledger.listArtifacts(runId);
  return loadVerifierPolicyManifestFromState(events, artifacts);
}

export function loadVerifierPolicyManifestFromState(
  events: LedgerEvent[],
  artifacts: Artifact[]
): PinnedVerifierPolicy | undefined {
  const pinned = [...events].reverse().find((event) => event.type === "policy.manifest.pinned");
  const artifactId = typeof pinned?.payload.artifactId === "string" ? pinned.payload.artifactId : undefined;
  const artifact = artifactId ? artifacts.find((item) => item.id === artifactId) : undefined;
  if (!artifact) return undefined;
  const manifest = parseVerifierPolicyManifest(artifact);
  return manifest ? { manifest, artifactId: artifact.id } : undefined;
}

export function parseVerifierPolicyManifest(artifact: Artifact): VerifierPolicyManifest | undefined {
  try {
    const parsed = JSON.parse(readArtifactText(artifact)) as Partial<VerifierPolicyManifest>;
    if (!isVerifierPolicyManifest(parsed)) return undefined;
    const { policyHash: _policyHash, ...withoutHash } = parsed;
    const expectedHash = stableHash(withoutHash);
    if (parsed.policyHash !== expectedHash) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function isVerifierPolicyManifest(value: Partial<VerifierPolicyManifest>): value is VerifierPolicyManifest {
  return (
    value.schemaVersion === VERIFIER_POLICY_SCHEMA_VERSION &&
    typeof value.policyVersion === "string" &&
    typeof value.evidenceGateVersion === "string" &&
    typeof value.proofObligationRulesVersion === "string" &&
    typeof value.problemClassifierVersion === "string" &&
    typeof value.finalOutcomeMappingVersion === "string" &&
    Array.isArray(value.trustedVerifiers) &&
    typeof value.finalOutcomeMapping === "object" &&
    value.finalOutcomeMapping !== null &&
    typeof value.policyHash === "string"
  );
}

function normalizeTrustedVerifiers(verifiers: TrustedVerifier[]): TrustedVerifier[] {
  return [...verifiers]
    .map((verifier) => ({
      id: verifier.id,
      allowedGrades: [...verifier.allowedGrades].sort(),
      allowedClaimTypes: [...verifier.allowedClaimTypes].sort(),
      independenceGroup: verifier.independenceGroup
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}
