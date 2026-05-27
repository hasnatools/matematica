import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { assumptionDeltaBlocksOriginalGoal, assumptionDeltaReason, type AssumptionDeltaReview } from "./assumption-delta";
import type { Artifact } from "./domain";
import type { EvidenceGrade } from "./domain";
import { isUntrustedLiteratureArtifact } from "./literature-policy";
import { evaluateProofObligationGraph, type ProofObligationDecision, type ProofObligationGraph } from "./proof-obligations";
import { readArtifactBytes, readArtifactText } from "./storage-encryption";

export type ClaimType =
  | "conjecture"
  | "proof_sketch"
  | "lean_checked_theorem"
  | "literature_backed_lemma"
  | "numerical_evidence"
  | "counterexample"
  | "failed_attempt"
  | "contradiction";

export type VerifierStatus =
  | "not_checked"
  | "verified"
  | "failed"
  | "inapplicable";

export type FormalClaimContract = {
  id: string;
  claimType: ClaimType;
  verifierId: string;
  assumptions: string[];
  conclusion: string;
  dependencies: string[];
  verifierStatus: VerifierStatus;
  evidenceGrade: EvidenceGrade;
  verifierArtifactIds: string[];
  supportingVerifierResults?: SupportingVerifierResult[];
  proofObligationGraph?: ProofObligationGraph;
  formalization?: FormalizationAssessment;
  machineCheck?: MachineCheckBinding;
  assumptionDelta?: AssumptionDeltaReview;
};

export type MachineCheckBinding = {
  verifier: "lean4";
  resultArtifactId: string;
  sourceHash: string;
  theoremName: string;
  toolchainHash: string;
  sandboxPolicyHash: string;
  projectPinned: boolean;
  proofObligationArtifactIds: string[];
  tcb: LeanTrustedComputingBase;
};

export type LeanTrustedComputingBase = {
  format: "matematica.lean-tcb";
  version: 1;
  theoremName: string;
  theoremStatementHash: string;
  proofFileHash: string;
  leanBinaryHash: string;
  lakeBinaryHash?: string;
  leanToolchain: string;
  lakeManifestHash: string;
  lakefileHash: string;
  mathlibRevision: string;
  verifierCommand: string[];
  verifierCommandHash: string;
  sandboxPolicyHash: string;
  sandboxPolicyArtifactId: string;
  exactExitResultHash: string;
  stdoutHash: string;
  stderrHash: string;
  exitCode: number;
};

export type SupportingVerifierRole =
  | "independent_checker"
  | "counterexample_validator"
  | "equivalence_reviewer";

export type SupportingVerifierResult = {
  verifierId: string;
  role: SupportingVerifierRole;
  claimType: ClaimType;
  verifierStatus: VerifierStatus;
  evidenceGrade: EvidenceGrade;
  artifactIds: string[];
  notes?: string;
};

export type FormalizationAssessment = {
  status: FormalizationStatus;
  artifactId?: string;
  equivalenceReview?: TheoremEquivalenceReview;
  equivalenceAuditBundle?: FormalEquivalenceAuditBundle;
  gap?: FormalizationGapClassification;
  knownGaps?: string[];
  missingDefinitions?: string[];
  missingLemmas?: string[];
  missingAssumptions?: string[];
  scopeChanges?: string[];
  statementDiffs?: string[];
  ambiguityNotes?: string[];
};

export type FormalizationStatus =
  | "not_required"
  | "equivalent"
  | "not_assessed"
  | "mismatch"
  | "not_formalized"
  | "partial"
  | "weakened"
  | "unknown"
  | "contradictory";

export type FormalizationGapKind =
  | "none"
  | "not_assessed"
  | "not_formalized"
  | "partial_formalization"
  | "weakened_theorem"
  | "missing_case"
  | "changed_quantifier"
  | "hidden_assumption"
  | "wrong_domain"
  | "non_equivalent_normalization"
  | "missing_definition"
  | "missing_lemma"
  | "missing_assumption"
  | "contradictory_mapping"
  | "mismatch"
  | "unknown";

export type FormalizationGapClassification = {
  status: FormalizationStatus;
  kind: FormalizationGapKind;
  blocksGoal: boolean;
  reason: string;
  missingDefinitions: string[];
  missingLemmas: string[];
  missingAssumptions: string[];
  scopeChanges: string[];
  statementDiffs: string[];
  ambiguityNotes: string[];
  knownGaps: string[];
};

export type TheoremEquivalenceReview = {
  originalProblem: string;
  normalizedStatement: string;
  formalStatement: string;
  assumptions: string[];
  conclusion: string;
  ambiguityNotes: string[];
  statementDiffs: string[];
  reviewer: string;
  reviewerDisagreement: boolean;
  auditBundle?: FormalEquivalenceAuditBundle;
};

export type FormalEquivalenceAuditBundle = {
  format: "matematica.formal-equivalence-audit-bundle";
  version: 1;
  originalProblem: string;
  normalizedTheorem: string;
  leanTheorem: string;
  assumptionDiff: {
    originalAssumptions: string[];
    formalAssumptions: string[];
    addedAssumptions: string[];
    removedAssumptions: string[];
    hiddenAssumptions: string[];
  };
  allowedAssumptionPolicy: {
    allowAddedAssumptions: false;
    allowedAddedAssumptions: string[];
    reason: string;
  };
  independentReview: Omit<TheoremEquivalenceReview, "auditBundle">;
  decision: {
    equivalent: boolean;
    status: FormalizationStatus;
    reviewer: string;
    reviewerIndependent: boolean;
    blockingReasons: string[];
  };
  artifactId?: string;
  bundleHash?: string;
};

export type TrustedVerifier = {
  id: string;
  allowedGrades: EvidenceGrade[];
  allowedClaimTypes: ClaimType[];
  independenceGroup: string;
};

export type EvidenceGateContext = {
  trustedVerifiers: TrustedVerifier[];
  artifacts: Artifact[];
  verifyArtifactHashes?: boolean;
};

export type EvidenceDecision = {
  canMarkGoalMet: boolean;
  reason: string;
  quorum: QuorumDecision;
  proofObligations?: ProofObligationDecision;
  formalizationGap?: FormalizationGapClassification;
};

export type QuorumDecision = {
  required: string[];
  satisfiedBy: Array<{
    verifierId: string;
    role: string;
    artifactIds: string[];
    artifactHashes: string[];
  }>;
  disagreements: string[];
};

export function evaluateEvidenceGate(claim: FormalClaimContract, context?: EvidenceGateContext): EvidenceDecision {
  const emptyQuorum = makeQuorumDecision();
  if (!claim.claimType) {
    return reject("missing claim type", emptyQuorum);
  }
  if (!claim.verifierId) {
    return reject("missing verifier identity", emptyQuorum);
  }
  if (claim.conclusion.trim().length === 0) {
    return reject("missing conclusion", emptyQuorum);
  }
  if (claim.verifierStatus !== "verified") {
    return reject(`verifier status is ${claim.verifierStatus}`, emptyQuorum);
  }
  if (claim.verifierArtifactIds.length === 0) {
    return reject("missing verifier artifact", emptyQuorum);
  }
  if (!isVerifierBackedSuccessGrade(claim.evidenceGrade)) {
    return reject(`evidence grade ${claim.evidenceGrade} is not a hard success grade`, emptyQuorum);
  }
  if (isModelSelfGradingVerifier(claim.verifierId)) {
    return reject(`model self-grading verifier ${claim.verifierId} cannot issue solved evidence`, emptyQuorum);
  }
  if (assumptionDeltaBlocksOriginalGoal(claim.assumptionDelta)) {
    return reject(
      `assumption delta changes the original goal and can only create an alternate candidate: ${assumptionDeltaReason(claim.assumptionDelta!)}`,
      emptyQuorum
    );
  }
  if (!context) {
    return reject("missing verifier trust context", emptyQuorum);
  }
  const trustedVerifier = context.trustedVerifiers.find((verifier) => verifier.id === claim.verifierId);
  if (!trustedVerifier) {
    return reject(`verifier ${claim.verifierId} is not trusted`, emptyQuorum);
  }
  if (isModelSelfGradingVerifier(trustedVerifier.id) || isModelSelfGradingVerifier(trustedVerifier.independenceGroup)) {
    return reject(`model self-grading verifier ${trustedVerifier.id} cannot be trusted for solved evidence`, emptyQuorum);
  }
  if (!trustedVerifier.allowedGrades.includes(claim.evidenceGrade)) {
    return reject(`verifier ${claim.verifierId} cannot issue ${claim.evidenceGrade}`, emptyQuorum);
  }
  if (!trustedVerifier.allowedClaimTypes.includes(claim.claimType)) {
    return reject(`verifier ${claim.verifierId} cannot verify ${claim.claimType}`, emptyQuorum);
  }
  const artifactCheck = validateVerifierArtifacts(claim, context);
  if (!artifactCheck.ok) {
    return reject(artifactCheck.reason, emptyQuorum);
  }
  if (claim.proofObligationGraph) {
    const proofObligations = evaluateProofObligationGraph(
      claim.proofObligationGraph,
      context.artifacts,
      { requireCounterexampleSearch: claim.evidenceGrade === "formal_proof", evidenceGrade: claim.evidenceGrade }
    );
    if (!proofObligations.ok) {
      return reject("proof obligation graph has unresolved or invalid obligations", emptyQuorum, proofObligations);
    }
  }
  const quorum = makeQuorumDecision(claim, context);
  quorum.satisfiedBy.push({
    verifierId: claim.verifierId,
    role: "primary_verifier",
    artifactIds: claim.verifierArtifactIds,
    artifactHashes: artifactHashes(claim.verifierArtifactIds, context)
  });
  if (claim.evidenceGrade === "formal_proof" && claim.claimType !== "lean_checked_theorem") {
    return reject("formal_proof requires a Lean-checked theorem claim", quorum);
  }
  const formalizationGap = classifyFormalizationGap(claim.formalization);
  if (claim.evidenceGrade === "formal_proof" && formalizationGap.blocksGoal) {
    return reject(
      `formal_proof requires formalization equivalence; formalization gap ${formalizationGap.kind}: ${formalizationGap.reason}`,
      quorum,
      undefined,
      formalizationGap
    );
  }
  if (claim.evidenceGrade === "formal_proof" && !claim.formalization?.artifactId) {
    return reject("formal_proof requires recorded formalization assessment artifact", quorum);
  }
  if (claim.evidenceGrade === "formal_proof" && !claim.formalization?.equivalenceReview) {
    return reject("formal_proof requires theorem-equivalence review details", quorum);
  }
  const equivalenceReview = claim.formalization?.equivalenceReview;
  if (claim.evidenceGrade === "formal_proof" && equivalenceReview?.reviewerDisagreement) {
    quorum.disagreements.push(`equivalence reviewer ${equivalenceReview.reviewer} reported disagreement`);
    return reject("formal_proof has reviewer disagreement on theorem equivalence", quorum);
  }
  if (claim.evidenceGrade === "formal_proof" && equivalenceReview && equivalenceReview.statementDiffs.length > 0) {
    quorum.disagreements.push(...equivalenceReview.statementDiffs);
    return reject("formal_proof has unresolved theorem statement diffs", quorum);
  }
  if (claim.evidenceGrade === "formal_proof") {
    if (!equivalenceReview?.reviewer || equivalenceReview.reviewer === claim.verifierId) {
      return reject("formal_proof requires an independent theorem-equivalence reviewer", quorum);
    }
    const equivalenceBundleCheck = validateFormalEquivalenceAuditBundle(claim, context);
    if (!equivalenceBundleCheck.ok) {
      return reject(`formal_proof requires formal statement equivalence audit bundle: ${equivalenceBundleCheck.reason}`, quorum);
    }
    quorum.satisfiedBy.push({
      verifierId: equivalenceReview.reviewer,
      role: "equivalence_reviewer",
      artifactIds: [claim.formalization!.artifactId!],
      artifactHashes: artifactHashes([claim.formalization!.artifactId!], context)
    });
  }
  if (claim.evidenceGrade === "formal_proof") {
    const machineCheck = validateLeanMachineCheckBinding(claim, context);
    if (!machineCheck.ok) return reject(machineCheck.reason, quorum);
  }
  if (claim.evidenceGrade === "verified_counterexample" && claim.claimType !== "counterexample") {
    return reject("verified_counterexample requires a counterexample claim", quorum);
  }
  const supportingCheck = validateSupportingQuorum(claim, context, trustedVerifier, quorum);
  if (!supportingCheck.ok) return reject(supportingCheck.reason, quorum);
  if (isVerifierBackedSuccessGrade(claim.evidenceGrade) && !claim.proofObligationGraph) {
    return reject("missing proof obligation graph for verifier-backed final claim", quorum);
  }
  return {
    canMarkGoalMet: true,
    reason: "verifier-backed success with independent quorum",
    quorum,
    proofObligations: claim.proofObligationGraph
      ? evaluateProofObligationGraph(claim.proofObligationGraph, context.artifacts, { requireCounterexampleSearch: claim.evidenceGrade === "formal_proof", evidenceGrade: claim.evidenceGrade })
      : undefined
  };
}

function validateFormalEquivalenceAuditBundle(
  claim: FormalClaimContract,
  context: EvidenceGateContext
): { ok: true } | { ok: false; reason: string } {
  const formalization = claim.formalization;
  const review = formalization?.equivalenceReview;
  const bundle = formalization?.equivalenceAuditBundle ?? review?.auditBundle;
  const failures: string[] = [];
  if (!formalization?.artifactId) failures.push("missing formalization artifact id");
  if (!bundle) {
    return { ok: false, reason: "missing equivalence audit bundle" };
  }
  const artifact = formalization?.artifactId
    ? context.artifacts.find((item) => item.id === formalization.artifactId)
    : undefined;
  if (!artifact) failures.push(`unverifiable review artifact ${formalization?.artifactId ?? "missing"}`);
  if (bundle.artifactId && formalization?.artifactId && bundle.artifactId !== formalization.artifactId) {
    failures.push(`bundle artifact ${bundle.artifactId} does not match formalization artifact ${formalization.artifactId}`);
  }
  if (bundle.format !== "matematica.formal-equivalence-audit-bundle") failures.push("invalid bundle format");
  if (bundle.version !== 1) failures.push("invalid bundle version");
  if (!bundle.originalProblem?.trim()) failures.push("bundle missing original problem");
  if (!bundle.normalizedTheorem?.trim()) failures.push("bundle missing normalized theorem");
  if (!bundle.leanTheorem?.trim()) failures.push("bundle missing Lean theorem");
  if (review) {
    if (bundle.originalProblem !== review.originalProblem) failures.push("bundle original problem does not match equivalence review");
    if (bundle.normalizedTheorem !== review.normalizedStatement) failures.push("bundle normalized theorem does not match equivalence review");
    if (bundle.leanTheorem !== review.formalStatement) failures.push("bundle Lean theorem does not match equivalence review");
  }
  if (bundle.leanTheorem !== claim.conclusion) failures.push("bundle Lean theorem does not match claim conclusion");
  if (bundle.allowedAssumptionPolicy?.allowAddedAssumptions !== false) failures.push("bundle policy must forbid added assumptions");
  if (bundle.assumptionDiff?.addedAssumptions?.length > 0) {
    failures.push(`bundle has added assumptions: ${bundle.assumptionDiff.addedAssumptions.join("; ")}`);
  }
  if (bundle.assumptionDiff?.hiddenAssumptions?.length > 0) {
    failures.push(`bundle has hidden assumptions: ${bundle.assumptionDiff.hiddenAssumptions.join("; ")}`);
  }
  if (bundle.decision?.equivalent !== true) failures.push("bundle decision is not equivalent");
  if (bundle.decision?.status !== "equivalent") failures.push(`bundle status is ${bundle.decision?.status ?? "missing"}`);
  if (bundle.decision?.reviewerIndependent !== true) failures.push("bundle reviewer is not independent");
  if (bundle.decision?.reviewer === claim.verifierId) failures.push("bundle reviewer matches Lean verifier");
  if (bundle.decision?.blockingReasons?.length > 0) {
    failures.push(`bundle has blocking reasons: ${bundle.decision.blockingReasons.join("; ")}`);
  }
  if (!bundle.bundleHash) failures.push("bundle hash is missing");
  return failures.length === 0
    ? { ok: true }
    : { ok: false, reason: unique(failures).join("; ") };
}

export function isVerifierBackedSuccessGrade(grade: EvidenceGrade): boolean {
  return grade === "formal_proof" || grade === "verified_counterexample" || grade === "verified_computation";
}

export function classifyFormalizationGap(assessment?: FormalizationAssessment): FormalizationGapClassification {
  const status = assessment?.status ?? "not_assessed";
  const review = assessment?.equivalenceReview;
  const knownGaps = assessment?.knownGaps ?? [];
  const statementDiffs = assessment?.statementDiffs ?? review?.statementDiffs ?? [];
  const ambiguityNotes = assessment?.ambiguityNotes ?? review?.ambiguityNotes ?? [];
  const scopeChanges = assessment?.scopeChanges ?? [];
  const missingDefinitions = unique([
    ...(assessment?.missingDefinitions ?? []),
    ...extractGapItems(knownGaps, ["definition", "def"])
  ]);
  const missingLemmas = unique([
    ...(assessment?.missingLemmas ?? []),
    ...extractGapItems(knownGaps, ["lemma", "theorem"])
  ]);
  const missingAssumptions = unique([
    ...(assessment?.missingAssumptions ?? []),
    ...extractGapItems(knownGaps, ["assumption", "hypothesis"])
  ]);
  const kind = chooseFormalizationGapKind({
    status,
    knownGaps,
    statementDiffs,
    scopeChanges,
    ambiguityNotes,
    missingDefinitions,
    missingLemmas,
    missingAssumptions
  });
  const blocksGoal = status !== "equivalent" && status !== "not_required";
  return {
    status,
    kind,
    blocksGoal,
    reason: formalizationGapReason(status, kind, {
      knownGaps,
      statementDiffs,
      scopeChanges,
      ambiguityNotes,
      missingDefinitions,
      missingLemmas,
      missingAssumptions
    }),
    missingDefinitions,
    missingLemmas,
    missingAssumptions,
    scopeChanges,
    statementDiffs,
    ambiguityNotes,
    knownGaps
  };
}

export function makeClaimContract(input: Omit<FormalClaimContract, "assumptions" | "dependencies" | "verifierArtifactIds"> & {
  assumptions?: string[];
  dependencies?: string[];
  verifierArtifactIds?: string[];
  supportingVerifierResults?: SupportingVerifierResult[];
  proofObligationGraph?: ProofObligationGraph;
  formalization?: FormalizationAssessment;
  assumptionDelta?: AssumptionDeltaReview;
}): FormalClaimContract {
  return {
    ...input,
    assumptions: input.assumptions ?? [],
    dependencies: input.dependencies ?? [],
    verifierArtifactIds: input.verifierArtifactIds ?? [],
    supportingVerifierResults: input.supportingVerifierResults ?? []
  };
}

export function defaultTrustedVerifiers(): TrustedVerifier[] {
  return [
    {
      id: "local-deterministic-v0",
      allowedGrades: ["verified_computation"],
      allowedClaimTypes: ["numerical_evidence"],
      independenceGroup: "local-deterministic"
    },
    {
      id: "arithmetic-independent-checker",
      allowedGrades: ["verified_computation"],
      allowedClaimTypes: ["numerical_evidence"],
      independenceGroup: "independent-arithmetic"
    },
    {
      id: "lean4",
      allowedGrades: ["formal_proof"],
      allowedClaimTypes: ["lean_checked_theorem"],
      independenceGroup: "lean-machine"
    },
    {
      id: "counterexample-checker",
      allowedGrades: ["verified_counterexample"],
      allowedClaimTypes: ["counterexample"],
      independenceGroup: "counterexample-primary"
    },
    {
      id: "counterexample-independent-validator",
      allowedGrades: ["verified_counterexample"],
      allowedClaimTypes: ["counterexample"],
      independenceGroup: "counterexample-validator"
    }
  ];
}

function validateVerifierArtifacts(claim: FormalClaimContract, context: EvidenceGateContext): { ok: true } | { ok: false; reason: string } {
  const artifactsById = new Map(context.artifacts.map((artifact) => [artifact.id, artifact]));
  for (const artifactId of claim.verifierArtifactIds) {
    const artifact = artifactsById.get(artifactId);
    if (!artifact) {
      return { ok: false, reason: `verifier artifact not found: ${artifactId}` };
    }
    if (isAiProviderArtifact(artifact)) {
      return { ok: false, reason: `AI provider artifact ${artifactId} cannot be used as verifier evidence` };
    }
    if (isUntrustedLiteratureArtifact(artifact)) {
      return { ok: false, reason: `literature artifact ${artifactId} cannot be used as verifier evidence` };
    }
    if (context.verifyArtifactHashes !== false) {
      const hashCheck = validateArtifactHash(artifact);
      if (!hashCheck.ok) return hashCheck;
    }
  }
  if (claim.formalization?.artifactId && !artifactsById.has(claim.formalization.artifactId)) {
    return { ok: false, reason: `formalization artifact not found: ${claim.formalization.artifactId}` };
  }
  return { ok: true };
}

function validateLeanMachineCheckBinding(
  claim: FormalClaimContract,
  context: EvidenceGateContext
): { ok: true } | { ok: false; reason: string } {
  if (claim.verifierId !== "lean4" || claim.claimType !== "lean_checked_theorem") {
    return { ok: false, reason: "formal_proof requires Lean machine-check binding" };
  }
  const binding = claim.machineCheck;
  if (!binding) {
    return { ok: false, reason: "formal_proof requires Lean machine-check binding" };
  }
  if (binding.verifier !== "lean4") {
    return { ok: false, reason: "Lean machine-check binding must use verifier lean4" };
  }
  if (!claim.verifierArtifactIds.includes(binding.resultArtifactId)) {
    return { ok: false, reason: "Lean machine-check result artifact must be a primary verifier artifact" };
  }
  if (!binding.projectPinned) {
    return { ok: false, reason: "Lean machine-check binding requires a pinned Lake/mathlib project" };
  }
  const artifact = context.artifacts.find((item) => item.id === binding.resultArtifactId);
  if (!artifact) {
    return { ok: false, reason: `Lean result artifact not found: ${binding.resultArtifactId}` };
  }
  if (context.verifyArtifactHashes !== false) {
    const hashCheck = validateArtifactHash(artifact);
    if (!hashCheck.ok) return hashCheck;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readArtifactText(artifact)) as Record<string, unknown>;
  } catch (error) {
    return { ok: false, reason: `Lean result artifact could not be parsed: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (parsed.status !== "verified") {
    return { ok: false, reason: "Lean result artifact status is not verified" };
  }
  if (parsed.verifier !== undefined && parsed.verifier !== "lean4") {
    return { ok: false, reason: "Lean result artifact verifier is not lean4" };
  }
  if (parsed.sourceHash !== binding.sourceHash) {
    return { ok: false, reason: "Lean result source hash does not match formal proof binding" };
  }
  if (!theoremNamesFromLeanResult(parsed).includes(binding.theoremName)) {
    return { ok: false, reason: "Lean result theorem name does not match formal proof binding" };
  }
  if (parsed.toolchainHash !== binding.toolchainHash) {
    return { ok: false, reason: "Lean result toolchain hash does not match formal proof binding" };
  }
  if (parsed.sandboxPolicyHash !== binding.sandboxPolicyHash) {
    return { ok: false, reason: "Lean result sandbox policy hash does not match formal proof binding" };
  }
  if (parsed.projectPinned !== true) {
    return { ok: false, reason: "Lean result was not produced from a pinned project" };
  }
  const tcbCheck = validateLeanTrustedComputingBase({ claim, binding, parsed, context });
  if (!tcbCheck.ok) return tcbCheck;
  const requiredProofArtifactIds = allProofObligationArtifactIds(claim);
  const boundProofArtifactIds = new Set(binding.proofObligationArtifactIds);
  for (const artifactId of requiredProofArtifactIds) {
    if (!boundProofArtifactIds.has(artifactId)) {
      return { ok: false, reason: `Lean machine-check binding is missing proof-obligation artifact ${artifactId}` };
    }
  }
  return { ok: true };
}

function validateLeanTrustedComputingBase(input: {
  claim: FormalClaimContract;
  binding: MachineCheckBinding;
  parsed: Record<string, unknown>;
  context: EvidenceGateContext;
}): { ok: true } | { ok: false; reason: string } {
  const { claim, binding, parsed, context } = input;
  const parsedTcb = isRecord(parsed.tcb) ? parsed.tcb as Partial<LeanTrustedComputingBase> : undefined;
  if (!binding.tcb) {
    return { ok: false, reason: "formal_proof requires Lean trusted computing base binding" };
  }
  if (!parsedTcb) {
    return { ok: false, reason: "Lean result artifact is missing trusted computing base metadata" };
  }
  const tcb = binding.tcb;
  const failures: string[] = [];
  if (tcb.format !== "matematica.lean-tcb" || tcb.version !== 1) failures.push("invalid Lean TCB format");
  if (tcb.theoremName !== binding.theoremName) failures.push("Lean TCB theorem name does not match binding");
  if (tcb.proofFileHash !== binding.sourceHash) failures.push("Lean TCB proof file hash does not match binding source hash");
  if (tcb.sandboxPolicyHash !== binding.sandboxPolicyHash) failures.push("Lean TCB sandbox policy hash does not match binding");
  if (sha256Text(claim.conclusion) !== tcb.theoremStatementHash) {
    failures.push("Lean TCB theorem statement hash does not match claim conclusion");
  }
  for (const field of [
    "format",
    "version",
    "theoremName",
    "theoremStatementHash",
    "proofFileHash",
    "leanBinaryHash",
    "lakeBinaryHash",
    "leanToolchain",
    "lakeManifestHash",
    "lakefileHash",
    "mathlibRevision",
    "verifierCommandHash",
    "sandboxPolicyHash",
    "sandboxPolicyArtifactId",
    "exactExitResultHash",
    "stdoutHash",
    "stderrHash",
    "exitCode"
  ] as const) {
    if (parsedTcb[field] !== tcb[field]) failures.push(`Lean TCB ${field} diverges from result artifact`);
  }
  if (JSON.stringify(parsedTcb.verifierCommand) !== JSON.stringify(tcb.verifierCommand)) {
    failures.push("Lean TCB verifier command diverges from result artifact");
  }
  if (!Array.isArray(tcb.verifierCommand) || tcb.verifierCommand.length === 0) failures.push("Lean TCB verifier command is missing");
  if (!tcb.leanBinaryHash) failures.push("Lean TCB missing pinned Lean binary hash");
  if (!tcb.lakeBinaryHash) failures.push("Lean TCB missing pinned Lake binary hash");
  if (!tcb.leanToolchain) failures.push("Lean TCB missing lean-toolchain revision");
  if (!tcb.lakeManifestHash) failures.push("Lean TCB missing lake-manifest hash");
  if (!tcb.lakefileHash) failures.push("Lean TCB missing lakefile hash");
  if (!tcb.mathlibRevision) failures.push("Lean TCB missing mathlib revision");
  if (!tcb.sandboxPolicyArtifactId) failures.push("Lean TCB missing sandbox policy artifact");
  if (typeof tcb.exitCode !== "number" || tcb.exitCode !== 0) failures.push("Lean TCB exact exit result is not a successful Lean exit");
  return failures.length === 0
    ? { ok: true }
    : { ok: false, reason: unique(failures).join("; ") };
}

function theoremNamesFromLeanResult(parsed: Record<string, unknown>): string[] {
  const names = Array.isArray(parsed.theoremNames)
    ? parsed.theoremNames
    : parsed.theoremName
      ? [parsed.theoremName]
      : [];
  return names.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function allProofObligationArtifactIds(claim: FormalClaimContract): string[] {
  return [...new Set(claim.proofObligationGraph?.obligations.flatMap((obligation) => [
    ...obligation.artifactIds,
    ...(obligation.counterexampleSearches?.flatMap((search) => search.artifactIds) ?? []),
    obligation.reproducibility?.executableArtifactId,
    obligation.reproducibility?.independentRerunArtifactId
  ]).filter((item): item is string => typeof item === "string" && item.length > 0) ?? [])];
}

function validateSupportingQuorum(
  claim: FormalClaimContract,
  context: EvidenceGateContext,
  primaryVerifier: TrustedVerifier,
  quorum: QuorumDecision
): { ok: true } | { ok: false; reason: string } {
  if (claim.evidenceGrade === "formal_proof") return { ok: true };

  const requiredRole: SupportingVerifierRole | undefined =
    claim.evidenceGrade === "verified_computation"
      ? "independent_checker"
      : claim.evidenceGrade === "verified_counterexample"
        ? "counterexample_validator"
        : undefined;
  if (!requiredRole) return { ok: true };

  const supportingResults = claim.supportingVerifierResults ?? [];
  for (const result of supportingResults) {
    if (result.role !== requiredRole) continue;
    if (result.verifierStatus !== "verified") continue;
    if (result.evidenceGrade !== claim.evidenceGrade) continue;
    if (result.claimType !== claim.claimType) continue;
    if (result.artifactIds.length === 0) continue;
    if (isModelSelfGradingVerifier(result.verifierId)) {
      return { ok: false, reason: `model self-grading verifier ${result.verifierId} cannot satisfy independent quorum` };
    }
    const trustedSupportingVerifier = context.trustedVerifiers.find((verifier) => verifier.id === result.verifierId);
    if (!trustedSupportingVerifier) continue;
    if (isModelSelfGradingVerifier(trustedSupportingVerifier.id) || isModelSelfGradingVerifier(trustedSupportingVerifier.independenceGroup)) {
      return { ok: false, reason: `model self-grading verifier ${trustedSupportingVerifier.id} cannot satisfy independent quorum` };
    }
    if (trustedSupportingVerifier.id === primaryVerifier.id) continue;
    if (trustedSupportingVerifier.independenceGroup === primaryVerifier.independenceGroup) continue;
    if (!trustedSupportingVerifier.allowedGrades.includes(result.evidenceGrade)) continue;
    if (!trustedSupportingVerifier.allowedClaimTypes.includes(result.claimType)) continue;
    const artifactCheck = validateSupportingArtifacts(result, context);
    if (!artifactCheck.ok) return artifactCheck;
    quorum.satisfiedBy.push({
      verifierId: result.verifierId,
      role: result.role,
      artifactIds: result.artifactIds,
      artifactHashes: artifactHashes(result.artifactIds, context)
    });
    return { ok: true };
  }

  if (claim.evidenceGrade === "verified_computation") {
    return { ok: false, reason: "verified_computation requires an independent checker quorum" };
  }
  return { ok: false, reason: "verified_counterexample requires an independent validator quorum" };
}

function validateSupportingArtifacts(
  result: SupportingVerifierResult,
  context: EvidenceGateContext
): { ok: true } | { ok: false; reason: string } {
  const artifactsById = new Map(context.artifacts.map((artifact) => [artifact.id, artifact]));
  for (const artifactId of result.artifactIds) {
    const artifact = artifactsById.get(artifactId);
    if (!artifact) {
      return { ok: false, reason: `supporting verifier artifact not found: ${artifactId}` };
    }
    if (isAiProviderArtifact(artifact)) {
      return { ok: false, reason: `AI provider artifact ${artifactId} cannot be used as supporting verifier evidence` };
    }
    if (isUntrustedLiteratureArtifact(artifact)) {
      return { ok: false, reason: `literature artifact ${artifactId} cannot be used as supporting verifier evidence` };
    }
    if (context.verifyArtifactHashes !== false) {
      const hashCheck = validateArtifactHash(artifact);
      if (!hashCheck.ok) return hashCheck;
    }
  }
  return { ok: true };
}

function isAiProviderArtifact(artifact: Artifact): boolean {
  return artifact.kind.startsWith("ai.");
}

function isModelSelfGradingVerifier(value: string): boolean {
  return /\b(openai|anthropic|claude|openrouter|cerebras|llm|model|ai-sdk|provider|self[-_ ]?grade)\b/i.test(value);
}

function makeQuorumDecision(claim?: FormalClaimContract, context?: EvidenceGateContext): QuorumDecision {
  const required = ["trusted primary verifier with valid artifacts"];
  if (claim?.evidenceGrade === "formal_proof") {
    required.push("independent theorem-equivalence review");
  }
  if (claim?.evidenceGrade === "verified_computation") {
    required.push("independent computational checker");
  }
  if (claim?.evidenceGrade === "verified_counterexample") {
    required.push("independent counterexample validator");
  }
  void context;
  return {
    required,
    satisfiedBy: [],
    disagreements: []
  };
}

function reject(
  reason: string,
  quorum: QuorumDecision,
  proofObligations?: ProofObligationDecision,
  formalizationGap?: FormalizationGapClassification
): EvidenceDecision {
  return { canMarkGoalMet: false, reason, quorum, proofObligations, formalizationGap };
}

function artifactHashes(artifactIds: string[], context: EvidenceGateContext): string[] {
  const artifactsById = new Map(context.artifacts.map((artifact) => [artifact.id, artifact]));
  return artifactIds.map((artifactId) => artifactsById.get(artifactId)?.sha256 ?? "missing");
}

function validateArtifactHash(artifact: Artifact): { ok: true } | { ok: false; reason: string } {
  if (!existsSync(artifact.path)) {
    return { ok: false, reason: `artifact file missing: ${artifact.id}` };
  }
  const actual = createHash("sha256").update(readArtifactBytes(artifact)).digest("hex");
  if (actual !== artifact.sha256) {
    return { ok: false, reason: `artifact hash mismatch: ${artifact.id}` };
  }
  return { ok: true };
}

function chooseFormalizationGapKind(input: {
  status: FormalizationStatus;
  knownGaps: string[];
  statementDiffs: string[];
  scopeChanges: string[];
  ambiguityNotes: string[];
  missingDefinitions: string[];
  missingLemmas: string[];
  missingAssumptions: string[];
}): FormalizationGapKind {
  if (input.status === "equivalent" || input.status === "not_required") return "none";
  if (input.status === "not_assessed") return "not_assessed";
  if (input.status === "not_formalized") return "not_formalized";
  if (input.status === "partial") {
    if (input.missingDefinitions.length > 0) return "missing_definition";
    if (input.missingLemmas.length > 0) return "missing_lemma";
    if (input.missingAssumptions.length > 0) return "missing_assumption";
    return "partial_formalization";
  }
  if (input.status === "weakened") return "weakened_theorem";
  if (input.status === "contradictory") return "contradictory_mapping";
  const text = [...input.knownGaps, ...input.statementDiffs, ...input.scopeChanges, ...input.ambiguityNotes]
    .join("\n")
    .toLowerCase();
  if (/quantifier|forall|exists|existential|universal/.test(text)) return "changed_quantifier";
  if (/hidden assumption|extra assumption|adds assumption|assumes/.test(text)) return "hidden_assumption";
  if (/\bdomain\b|\bcodomain\b|nat|integer|real|positive/.test(text)) return "wrong_domain";
  if (/\bcase\b|\bcases\b|edge case|boundary/.test(text)) return "missing_case";
  if (/normalization|normalised|normalized/.test(text)) return "non_equivalent_normalization";
  if (input.missingDefinitions.length > 0) return "missing_definition";
  if (input.missingLemmas.length > 0) return "missing_lemma";
  if (input.missingAssumptions.length > 0) return "missing_assumption";
  if (input.status === "mismatch") return "mismatch";
  return "unknown";
}

function formalizationGapReason(
  status: FormalizationStatus,
  kind: FormalizationGapKind,
  details: {
    knownGaps: string[];
    statementDiffs: string[];
    scopeChanges: string[];
    ambiguityNotes: string[];
    missingDefinitions: string[];
    missingLemmas: string[];
    missingAssumptions: string[];
  }
): string {
  if (kind === "none") return "formal statement is accepted as equivalent to the original problem";
  const blockers = [
    ...details.knownGaps,
    ...details.statementDiffs,
    ...details.scopeChanges,
    ...details.ambiguityNotes,
    ...details.missingDefinitions.map((item) => `missing definition: ${item}`),
    ...details.missingLemmas.map((item) => `missing lemma: ${item}`),
    ...details.missingAssumptions.map((item) => `missing assumption: ${item}`)
  ];
  const suffix = blockers.length > 0 ? ` Blockers: ${unique(blockers).join("; ")}` : "";
  return `formalization status ${status} is classified as ${kind}.${suffix}`;
}

function extractGapItems(gaps: string[], labels: string[]): string[] {
  const items: string[] = [];
  for (const gap of gaps) {
    const trimmed = gap.trim();
    const lower = trimmed.toLowerCase();
    for (const label of labels) {
      if (!lower.includes(label)) continue;
      const match = trimmed.match(/:\s*(.+)$/);
      items.push(match?.[1]?.trim() || trimmed);
      break;
    }
  }
  return items;
}

function unique(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter((item) => item.length > 0))];
}
