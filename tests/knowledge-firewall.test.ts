import { expect, test } from "bun:test";
import type { Artifact, LedgerEvent } from "../src/domain";
import { reviewKnowledgePromotionFirewall } from "../src/knowledge-firewall";

function artifact(id: string): Artifact {
  return {
    id,
    runId: "run_firewall",
    kind: "test.artifact",
    sha256: id,
    contentAddress: `sha256:${id}`,
    mediaType: "text/plain; charset=utf-8",
    storageKey: `run_firewall/${id}.txt`,
    path: `/tmp/${id}.txt`,
    bytes: 1,
    createdAt: "2026-01-01T00:00:00.000Z"
  };
}

function event(input: {
  id: string;
  type: LedgerEvent["type"];
  payload: Record<string, unknown>;
  artifactIds?: string[];
}): LedgerEvent {
  return {
    id: input.id,
    runId: "run_firewall",
    type: input.type,
    payload: input.payload,
    artifactIds: input.artifactIds ?? [],
    createdAt: "2026-01-01T00:00:00.000Z"
  };
}

test("knowledge promotion firewall rejects branch candidates without typed lineage", () => {
  const review = reviewKnowledgePromotionFirewall({
    targetCycle: 2,
    artifacts: [
      artifact("art_candidate"),
      artifact("art_branch"),
      artifact("art_schema"),
      artifact("art_obligations")
    ],
    inputEvents: [event({
      id: "evt_branch",
      type: "branch.candidate_claim.reviewed",
      artifactIds: ["art_candidate", "art_branch", "art_schema", "art_obligations"],
      payload: {
        phase: "loophole",
        status: "accepted",
        candidateArtifactId: "art_candidate",
        sourceBranchArtifactId: "art_branch",
        workerResultSchemaReviewArtifactId: "art_schema",
        proofObligationArtifactId: "art_obligations",
        claim: { evidenceGrade: "verified_computation" },
        workerResultSchemaReview: { status: "valid" }
      }
    })]
  });

  expect(review.ok).toBe(false);
  expect(review.rejected.map((issue) => issue.code)).toEqual(expect.arrayContaining([
    "branch_candidate_source_lineage_missing"
  ]));
});

test("knowledge promotion firewall accepts only metadata source context and typed candidate artifacts", () => {
  const review = reviewKnowledgePromotionFirewall({
    targetCycle: 2,
    artifacts: [
      artifact("art_source"),
      artifact("art_candidate"),
      artifact("art_branch"),
      artifact("art_schema"),
      artifact("art_obligations"),
      artifact("art_delta")
    ],
    inputEvents: [
      event({
        id: "evt_source",
        type: "source.results",
        artifactIds: ["art_source"],
        payload: {
          provider: "arxiv",
          phase: "feedback",
          cycle: 1,
          artifactId: "art_source",
          retrievalEvaluation: { trustImpact: "untrusted_context_only" }
        }
      }),
      event({
        id: "evt_branch",
        type: "branch.candidate_claim.reviewed",
        artifactIds: ["art_candidate", "art_branch", "art_schema", "art_obligations", "art_delta"],
        payload: {
          phase: "loophole",
          role: "assumption-auditor",
          status: "rejected",
          evidenceGrade: "unsupported",
          candidateArtifactId: "art_candidate",
          sourceBranchArtifactId: "art_branch",
          workerResultSchemaReviewArtifactId: "art_schema",
          proofObligationArtifactId: "art_obligations",
          assumptionDeltaArtifactId: "art_delta",
          workerResultSchemaReview: { status: "absent" },
          sourceLineage: {
            modelTextTrusted: false,
            sourceTextTrusted: false,
            controlsAffected: false
          }
        }
      })
    ]
  });

  expect(review.ok).toBe(true);
  expect(review.accepted.map((item) => item.role)).toEqual([
    "source_context_only",
    "typed_branch_candidate"
  ]);
  expect(review.accepted.find((item) => item.role === "source_context_only")?.trustedAsEvidence).toBe(false);
  expect(review.accepted.find((item) => item.role === "source_context_only")?.truthLevel).toBe("raw_source");
  expect(review.accepted.find((item) => item.role === "typed_branch_candidate")?.truthLevel).toBe("candidate");
  expect(review.accepted.find((item) => item.role === "typed_branch_candidate")?.trustedAsEvidence).toBe(false);
  expect(review.policy).toMatchObject({
    modelTextTrusted: false,
    sourceTextTrusted: false,
    controlsAffected: false,
    verifiedTruthLevels: ["checked_lemma", "formalized", "refuted"],
    unverifiedTruthLevels: ["raw_source", "candidate", "obsolete"],
    hardEvidenceRequiresSchemaValidTypedArtifacts: true
  });
});

test("knowledge promotion firewall requires source provenance license recency and non-proof policy before promotion", () => {
  const review = reviewKnowledgePromotionFirewall({
    targetCycle: 2,
    artifacts: [artifact("art_source")],
    inputEvents: [event({
      id: "evt_source",
      type: "source.results",
      artifactIds: ["art_source"],
      payload: {
        provider: "arxiv",
        phase: "feedback",
        cycle: 1,
        artifactId: "art_source",
        retrievalEvaluation: {
          trustImpact: "none",
          canPromoteResearchBackedClaims: true,
          failures: [],
          staleResultCount: 0,
          citationValidity: 1
        }
      }
    })]
  });

  expect(review.ok).toBe(false);
  expect(review.rejected.map((issue) => issue.code)).toContain("source_license_manifest_missing");
});

test("knowledge promotion firewall tags verifier-backed candidates with verified truth levels only", () => {
  const review = reviewKnowledgePromotionFirewall({
    targetCycle: 2,
    artifacts: [
      artifact("art_candidate"),
      artifact("art_branch"),
      artifact("art_schema"),
      artifact("art_obligations")
    ],
    inputEvents: [event({
      id: "evt_branch",
      type: "branch.candidate_claim.reviewed",
      artifactIds: ["art_candidate", "art_branch", "art_schema", "art_obligations"],
      payload: {
        phase: "feedback",
        status: "accepted",
        evidenceGrade: "formal_proof",
        candidateArtifactId: "art_candidate",
        sourceBranchArtifactId: "art_branch",
        workerResultSchemaReviewArtifactId: "art_schema",
        proofObligationArtifactId: "art_obligations",
        workerResultSchemaReview: { status: "valid" },
        sourceLineage: {
          modelTextTrusted: false,
          sourceTextTrusted: false,
          controlsAffected: false
        }
      }
    })]
  });

  expect(review.ok).toBe(true);
  expect(review.accepted[0]).toMatchObject({
    truthLevel: "formalized",
    trustedAsEvidence: true
  });
});

test("knowledge promotion firewall rejects conjectures without typed promotion metadata", () => {
  const review = reviewKnowledgePromotionFirewall({
    targetCycle: 2,
    artifacts: [artifact("art_knowledge")],
    inputEvents: [event({
      id: "evt_knowledge",
      type: "knowledge.conjecture.saved",
      artifactIds: ["art_knowledge"],
      payload: {
        cycle: 1,
        artifactId: "art_knowledge",
        truthLevel: "candidate",
        evidenceGrade: "conjectural_solution"
      }
    })]
  });

  expect(review.ok).toBe(false);
  expect(review.rejected.map((issue) => issue.code)).toContain("knowledge_provenance_missing");
});

test("knowledge promotion firewall accepts explicit typed conjecture promotion as non-evidence context", () => {
  const review = reviewKnowledgePromotionFirewall({
    targetCycle: 2,
    artifacts: [artifact("art_knowledge"), artifact("art_obligations")],
    inputEvents: [event({
      id: "evt_knowledge",
      type: "knowledge.conjecture.saved",
      artifactIds: ["art_knowledge", "art_obligations"],
      payload: {
        cycle: 1,
        artifactId: "art_knowledge",
        truthLevel: "candidate",
        trustGrade: "quarantined_context_only",
        evidenceGrade: "conjectural_solution",
        verifierStatus: { verifierId: "local", verified: false, status: "not_verifier_backed" },
        provenance: { source: "goal.success.evaluated", sourceEventIds: ["evt_goal"], sourceArtifactIds: ["art_obligations"] },
        sourceTaint: { sourceDerived: true, taintedSourceEventIds: ["evt_source"], taintedFields: ["summary"] },
        dependencyGraph: { rootClaimId: "claim_1", artifactIds: ["art_obligations"], obligationIds: ["obl_1"] },
        contradictionReview: { status: "not_contradicted", retractionEventIds: [] },
        supersession: { supersededBy: null, supersedes: [] },
        freshness: { expiresAt: "2026-01-02T00:00:00.000Z", policy: "expire_without_verifier_refresh" },
        promotion: {
          explicit: true,
          promotedAs: "context_only",
          proofSupportAllowed: false,
          controlsAffected: false,
          providerPolicyMutationAllowed: false,
          budgetMutationAllowed: false,
          toolPolicyMutationAllowed: false,
          goalContractMutationAllowed: false,
          promptFirewallRequired: true,
          promptFirewallReviewed: true
        }
      }
    })]
  });

  expect(review.ok).toBe(true);
  expect(review.accepted[0]).toMatchObject({
    role: "typed_knowledge_artifact",
    truthLevel: "candidate",
    trustedAsEvidence: false,
    status: "context_only"
  });
});

test("knowledge promotion firewall rejects unverified knowledge that mutates controls or proof support", () => {
  const review = reviewKnowledgePromotionFirewall({
    targetCycle: 2,
    artifacts: [artifact("art_knowledge")],
    inputEvents: [event({
      id: "evt_knowledge",
      type: "knowledge.conjecture.saved",
      artifactIds: ["art_knowledge"],
      payload: {
        cycle: 1,
        artifactId: "art_knowledge",
        truthLevel: "candidate",
        trustGrade: "quarantined_context_only",
        evidenceGrade: "heuristic_evidence",
        verifierStatus: { verifierId: "local", verified: false, status: "not_verifier_backed" },
        provenance: { source: "cross-agent-summary", sourceEventIds: ["evt_agent"], sourceArtifactIds: [] },
        sourceTaint: { sourceDerived: true, taintedSourceEventIds: ["evt_agent"], taintedFields: ["crossAgentSummary"] },
        dependencyGraph: { rootClaimId: "claim_2", artifactIds: [], obligationIds: [] },
        contradictionReview: { status: "not_checked", retractionEventIds: [] },
        supersession: { supersededBy: null, supersedes: [] },
        freshness: { expiresAt: "2026-01-02T00:00:00.000Z", policy: "expire_without_verifier_refresh" },
        promotion: {
          explicit: true,
          promotedAs: "proof_support",
          proofSupportAllowed: true,
          controlsAffected: true,
          providerPolicyMutationAllowed: true,
          budgetMutationAllowed: false,
          toolPolicyMutationAllowed: false,
          goalContractMutationAllowed: false,
          promptFirewallRequired: true,
          promptFirewallReviewed: true
        }
      }
    })]
  });

  expect(review.ok).toBe(false);
  expect(review.rejected.map((issue) => issue.code)).toContain("knowledge_control_mutation_attempt");
});
