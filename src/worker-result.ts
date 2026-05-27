import { z } from "zod";
import type { Artifact, EvidenceGrade } from "./domain";
import type { ClaimType, VerifierStatus } from "./evidence";

const artifactRoleSchema = z.enum([
  "candidate_output",
  "computation_manifest",
  "counterexample_witness",
  "lean_source",
  "lean_result",
  "failed_attempt_log",
  "uncertainty_note",
  "tool_trace"
]);

const artifactReferenceSchema = z.object({
  artifactId: z.string().min(1),
  role: artifactRoleSchema,
  description: z.string().min(1).optional()
});

const verifierClaimSchema = z.object({
  verifierId: z.string().min(1),
  verifierStatus: z.enum(["not_checked", "verified", "failed", "inapplicable"]),
  evidenceGrade: z.enum([
    "formal_proof",
    "verified_counterexample",
    "verified_computation",
    "literature_backed_reduction",
    "conjectural_solution",
    "heuristic_evidence",
    "unsupported",
    "contradicted",
    "budget_exhausted",
    "none"
  ]),
  claimType: z.enum([
    "conjecture",
    "proof_sketch",
    "lean_checked_theorem",
    "literature_backed_lemma",
    "numerical_evidence",
    "counterexample",
    "failed_attempt",
    "contradiction"
  ])
}).optional();

const toolTraceSchema = z.object({
  toolName: z.string().min(1),
  callId: z.string().min(1).optional(),
  inputArtifactId: z.string().min(1).optional(),
  outputArtifactId: z.string().min(1).optional(),
  status: z.enum(["started", "completed", "failed", "cancelled"]),
  summary: z.string().min(1).optional()
});

export const structuredWorkerResultSchema = z.object({
  format: z.literal("matematica.worker-result"),
  version: z.literal(1),
  resultType: z.enum([
    "theorem_candidate",
    "counterexample",
    "computation",
    "lean_attempt",
    "failed_approach",
    "uncertainty"
  ]),
  conclusion: z.string().min(1),
  confidence: z.number().min(0).max(1).optional(),
  artifactReferences: z.array(artifactReferenceSchema).min(1),
  verifierClaim: verifierClaimSchema,
  toolTrace: z.array(toolTraceSchema).optional(),
  computation: z.object({
    statement: z.string().min(1),
    command: z.string().min(1).optional(),
    inputDomain: z.string().min(1).optional(),
    outputHash: z.string().min(1).optional()
  }).optional(),
  counterexample: z.object({
    witness: z.string().min(1),
    refutes: z.string().min(1).optional()
  }).optional(),
  leanAttempt: z.object({
    theoremName: z.string().min(1).optional(),
    importHints: z.array(z.string().min(1)).optional(),
    knownGaps: z.array(z.string().min(1)).optional()
  }).optional(),
  failedApproach: z.object({
    reason: z.string().min(1),
    reusableObservations: z.array(z.string().min(1)).optional()
  }).optional(),
  uncertainty: z.object({
    blockers: z.array(z.string().min(1)).min(1),
    nextChecks: z.array(z.string().min(1)).optional()
  }).optional()
});

export type StructuredWorkerResult = z.infer<typeof structuredWorkerResultSchema>;

export type WorkerResultSchemaReview =
  | {
      status: "valid";
      result: StructuredWorkerResult;
      referencedArtifactIds: string[];
      modelClaimedVerifierStatusIgnored: boolean;
    }
  | {
      status: "invalid";
      reason: string;
      modelClaimedVerifierStatusIgnored: boolean;
      referencedArtifactIds: string[];
    }
  | {
      status: "absent";
      reason: string;
      modelClaimedVerifierStatusIgnored: false;
      referencedArtifactIds: [];
    };

export function reviewStructuredWorkerResult(
  branchArtifact: Record<string, unknown>,
  artifacts: Artifact[]
): WorkerResultSchemaReview {
  const candidate = extractWorkerResultCandidate(branchArtifact);
  if (candidate.status === "absent") {
    return {
      status: "absent",
      reason: candidate.reason,
      modelClaimedVerifierStatusIgnored: false,
      referencedArtifactIds: []
    };
  }
  if (candidate.status === "invalid-json") {
    return {
      status: "invalid",
      reason: candidate.reason,
      modelClaimedVerifierStatusIgnored: false,
      referencedArtifactIds: []
    };
  }

  const parsed = structuredWorkerResultSchema.safeParse(candidate.value);
  if (!parsed.success) {
    return {
      status: "invalid",
      reason: z.prettifyError(parsed.error),
      modelClaimedVerifierStatusIgnored: hasVerifierClaim(candidate.value),
      referencedArtifactIds: []
    };
  }

  const artifactIds = new Set(artifacts.map((artifact) => artifact.id));
  const referencedArtifactIds = parsed.data.artifactReferences.map((reference) => reference.artifactId);
  const missingArtifactIds = referencedArtifactIds.filter((artifactId) => !artifactIds.has(artifactId));
  if (missingArtifactIds.length > 0) {
    return {
      status: "invalid",
      reason: `structured worker result references unknown artifact ids: ${missingArtifactIds.join(", ")}`,
      modelClaimedVerifierStatusIgnored: parsed.data.verifierClaim !== undefined,
      referencedArtifactIds: []
    };
  }

  return {
    status: "valid",
    result: parsed.data,
    referencedArtifactIds,
    modelClaimedVerifierStatusIgnored: parsed.data.verifierClaim !== undefined
  };
}

export function workerResultClaimsHardComputation(review: WorkerResultSchemaReview): boolean {
  return review.status === "valid" && review.result.resultType === "computation";
}

export function workerResultClaimsHardCounterexample(review: WorkerResultSchemaReview): boolean {
  return review.status === "valid" && review.result.resultType === "counterexample";
}

export function workerResultLooksLikeFormalProof(review: WorkerResultSchemaReview): boolean {
  if (review.status !== "valid") return false;
  return review.result.resultType === "lean_attempt" ||
    review.result.resultType === "theorem_candidate" ||
    review.result.verifierClaim?.evidenceGrade === "formal_proof" ||
    review.result.verifierClaim?.claimType === "lean_checked_theorem";
}

export function workerResultConclusion(review: WorkerResultSchemaReview): string | undefined {
  return review.status === "valid" ? review.result.conclusion : undefined;
}

export function workerResultCounterexampleText(review: WorkerResultSchemaReview): string | undefined {
  if (review.status !== "valid") return undefined;
  return review.result.counterexample?.witness ?? review.result.conclusion;
}

export function ignoredVerifierClaimSummary(review: WorkerResultSchemaReview): {
  verifierId: string;
  verifierStatus: VerifierStatus;
  evidenceGrade: EvidenceGrade;
  claimType: ClaimType;
} | undefined {
  if (review.status !== "valid" || !review.result.verifierClaim) return undefined;
  return review.result.verifierClaim;
}

function extractWorkerResultCandidate(branchArtifact: Record<string, unknown>):
  | { status: "found"; value: unknown }
  | { status: "invalid-json"; reason: string }
  | { status: "absent"; reason: string } {
  if (isRecord(branchArtifact.workerResult)) {
    return { status: "found", value: branchArtifact.workerResult };
  }
  if (isRecord(branchArtifact.structuredWorkerResult)) {
    return { status: "found", value: branchArtifact.structuredWorkerResult };
  }
  const text = typeof branchArtifact.text === "string" ? branchArtifact.text.trim() : "";
  if (text.length === 0) {
    return { status: "absent", reason: "branch artifact has no structured worker result" };
  }
  if (!text.startsWith("{")) {
    return { status: "absent", reason: "branch text is not structured worker-result JSON" };
  }
  try {
    return { status: "found", value: JSON.parse(text) as unknown };
  } catch (error) {
    return {
      status: "invalid-json",
      reason: error instanceof Error
        ? `structured worker result JSON parse failed: ${error.message}`
        : "structured worker result JSON parse failed"
    };
  }
}

function hasVerifierClaim(value: unknown): boolean {
  return isRecord(value) && isRecord(value.verifierClaim);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
