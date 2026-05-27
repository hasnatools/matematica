import type { Artifact, LedgerEvent, GoalRun } from "./domain";

export type ReplayTrustMode =
  | "full_local_forensic"
  | "redacted_public"
  | "verifier_only";

export type ReplayTrustModeContract = {
  mode: ReplayTrustMode;
  label: string;
  available: boolean;
  scope: string;
  includesFullLedger: boolean;
  includesRedactedArtifacts: boolean;
  includesVerifierArtifacts: boolean;
  includesRawPromptText: false;
  includesRawProviderText: false;
  includesRawSourceText: false;
  proofClaimsMayDependOnModelText: false;
  proofClaimsMayDependOnProviderResponseText: false;
  proofClaimsMayDependOnSourceText: false;
  independentlyReproducibleClaims: string[];
  limitations: string[];
};

export type ReplayTrustContract = {
  format: "matematica.replay-trust-contract";
  version: 1;
  defaultReportMode: ReplayTrustMode;
  proofDependencyPolicy: {
    modelTextTrustedAsProof: false;
    providerResponseTextTrustedAsProof: false;
    sourceTextTrustedAsProof: false;
    proofClaimsRequireVerifierArtifacts: true;
    redactedTextMaySupport: "audit_context_only";
  };
  modes: ReplayTrustModeContract[];
};

export function buildReplayTrustContract(input: {
  run?: GoalRun;
  events: LedgerEvent[];
  artifacts: Artifact[];
  redactedPublicExport?: boolean;
}): ReplayTrustContract {
  const verifierArtifacts = input.artifacts.filter(isVerifierArtifact);
  const proofArtifacts = input.artifacts.filter(isProofArtifact);
  const hasVerifierEvidence = verifierArtifacts.length > 0 ||
    input.events.some((event) => event.type === "verifier.completed");
  const hasProofSupport = proofArtifacts.length > 0 ||
    input.events.some((event) =>
      event.type === "proof.obligations.reviewed" ||
      event.type === "proof.certificate.minimized" ||
      event.type === "goal.success.evaluated"
    );
  const verifiedClaimTypes = independentlyReproducibleClaims({
    run: input.run,
    hasVerifierEvidence,
    hasProofSupport,
    hasCounterexampleReview: input.events.some((event) => event.type === "counterexample.search.reviewed")
  });

  return {
    format: "matematica.replay-trust-contract",
    version: 1,
    defaultReportMode: input.redactedPublicExport ? "redacted_public" : "full_local_forensic",
    proofDependencyPolicy: {
      modelTextTrustedAsProof: false,
      providerResponseTextTrustedAsProof: false,
      sourceTextTrustedAsProof: false,
      proofClaimsRequireVerifierArtifacts: true,
      redactedTextMaySupport: "audit_context_only"
    },
    modes: [
      {
        mode: "full_local_forensic",
        label: "full local forensic replay (redacted artifact bytes)",
        available: true,
        scope: "Local MATEMATICA_HOME ledger, witness, event hash chain, redacted artifacts, provider/source metadata, budgets, and verifier artifacts.",
        includesFullLedger: true,
        includesRedactedArtifacts: true,
        includesVerifierArtifacts: hasVerifierEvidence,
        includesRawPromptText: false,
        includesRawProviderText: false,
        includesRawSourceText: false,
        proofClaimsMayDependOnModelText: false,
        proofClaimsMayDependOnProviderResponseText: false,
        proofClaimsMayDependOnSourceText: false,
        independentlyReproducibleClaims: verifiedClaimTypes,
        limitations: [
          "Raw prompts, raw provider responses, and raw source text are not persisted; their redacted artifacts are audit context, not proof support.",
          "A solved theorem claim still requires verifier artifacts, proof obligations, and final replay verification."
        ]
      },
      {
        mode: "redacted_public",
        label: "redacted public replay bundle",
        available: true,
        scope: "Portable replay export with private paths, secrets, raw provider text, and raw source text removed or replaced.",
        includesFullLedger: true,
        includesRedactedArtifacts: true,
        includesVerifierArtifacts: hasVerifierEvidence,
        includesRawPromptText: false,
        includesRawProviderText: false,
        includesRawSourceText: false,
        proofClaimsMayDependOnModelText: false,
        proofClaimsMayDependOnProviderResponseText: false,
        proofClaimsMayDependOnSourceText: false,
        independentlyReproducibleClaims: verifiedClaimTypes,
        limitations: [
          "Public bundles prove replay integrity over redacted payloads and verifier artifacts; they do not expose private prompts, provider completions, or source bodies.",
          "Model-generated explanations and redacted retrieved source text cannot independently establish mathematical truth."
        ]
      },
      {
        mode: "verifier_only",
        label: "verifier-only replay",
        available: hasVerifierEvidence,
        scope: "Minimal trust path through verifier outputs, proof obligations, proof certificate, finalization, and ledger hashes.",
        includesFullLedger: false,
        includesRedactedArtifacts: false,
        includesVerifierArtifacts: hasVerifierEvidence,
        includesRawPromptText: false,
        includesRawProviderText: false,
        includesRawSourceText: false,
        proofClaimsMayDependOnModelText: false,
        proofClaimsMayDependOnProviderResponseText: false,
        proofClaimsMayDependOnSourceText: false,
        independentlyReproducibleClaims: hasVerifierEvidence ? verifiedClaimTypes : [],
        limitations: hasVerifierEvidence
          ? [
              "Verifier-only replay can support only claims discharged by trusted verifier artifacts and replayed finalization metadata.",
              "It does not reproduce exploratory AI reasoning, branch prompts, retrieved source text, or provider responses."
            ]
          : [
              "No verifier completion artifacts are available, so this run has no verifier-only proof trust path."
            ]
      }
    ]
  };
}

function independentlyReproducibleClaims(input: {
  run?: GoalRun;
  hasVerifierEvidence: boolean;
  hasProofSupport: boolean;
  hasCounterexampleReview: boolean;
}): string[] {
  const claims = [
    "ledger_integrity",
    "budget_accounting",
    "provider_and_source_metadata",
    "negative_or_progress_reporting"
  ];
  if (input.hasVerifierEvidence) claims.push("verifier_result_replay");
  if (input.hasVerifierEvidence && input.hasProofSupport) claims.push("verifier_backed_final_claim");
  if (input.hasCounterexampleReview) claims.push("counterexample_pressure_review");
  if (input.run?.status === "goal_met" && input.hasVerifierEvidence) claims.push("accepted_goal_status");
  return [...new Set(claims)];
}

function isVerifierArtifact(artifact: Artifact): boolean {
  return artifact.kind.startsWith("verifier.") ||
    artifact.kind.startsWith("proof.") ||
    artifact.kind.includes("proof") ||
    artifact.kind.includes("counterexample") ||
    artifact.kind.includes("formalization") ||
    artifact.kind.includes("computation");
}

function isProofArtifact(artifact: Artifact): boolean {
  return artifact.kind.startsWith("proof.") ||
    artifact.kind.includes("proof") ||
    artifact.kind.includes("formalization") ||
    artifact.kind.includes("computation");
}
