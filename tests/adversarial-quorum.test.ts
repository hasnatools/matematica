import { expect, test } from "bun:test";
import type { LedgerEvent } from "../src/domain";
import { buildAdversarialQuorumReview, latestAdversarialQuorumForTarget, type AdversarialCriticReview, type AdversarialProviderLineage } from "../src/adversarial-quorum";

test("adversarial quorum passes only with two persisted independent critics and rationales", () => {
  const review = buildAdversarialQuorumReview({
    runId: "run-quorum",
    scope: "finalization",
    targetEvent: event("evt-goal-success", "goal.success.evaluated", ["art-proof"]),
    critics: [
      critic("evidence_skeptic-v1", "evidence_skeptic", "evidence", "art-evidence-review"),
      critic("replay_auditor-v1", "replay_auditor", "replay", "art-replay-review")
    ]
  });

  expect(review.status).toBe("passed");
  expect(review.degraded).toBe(false);
  expect(review.failureReasons).toEqual([]);
  expect(review.modelFamilyDiversity).toMatchObject({
    status: "passed",
    effectiveIndependentSignals: 2,
    downgradedCriticIds: []
  });
  expect(review.targetArtifactIds).toEqual(["art-proof"]);
  expect(review.rejectedFindings).toHaveLength(2);
  expect(review.rejectedFindings.every((finding) => finding.rationale.length > 0)).toBe(true);
  expect(review.reviewHash).toMatch(/^[a-f0-9]{64}$/);
});

test("adversarial quorum records capacity failures without treating them as agreement", () => {
  const review = buildAdversarialQuorumReview({
    runId: "run-quorum",
    scope: "plan_change",
    critics: [critic("skeptical_planner-v1", "skeptical_planner", "planner", "art-planner-review")],
    capacityFailure: {
      reason: "sub-agent thread limit reached",
      requestedCritics: 2,
      availableCritics: 1,
      artifactId: "art-capacity-failure"
    }
  });

  expect(review.status).toBe("degraded_capacity");
  expect(review.degraded).toBe(true);
  expect(review.capacityFailure?.artifactId).toBe("art-capacity-failure");
  expect(review.failureReasons).toContain("requires at least 2 critics, got 1");
});

test("finalization quorum fails default synthetic critics", () => {
  const review = buildAdversarialQuorumReview({
    runId: "run-quorum",
    scope: "finalization",
    targetEvent: event("evt-goal-success", "goal.success.evaluated", ["art-proof"]),
    critics: [
      critic("default-evidence", "evidence_skeptic", "evidence", "art-evidence-review", undefined, {
        source: "default_synthetic",
        blind: false
      }),
      critic("default-replay", "replay_auditor", "replay", "art-replay-review", undefined, {
        source: "default_synthetic",
        blind: false
      })
    ]
  });

  expect(review.status).toBe("failed");
  expect(review.failureReasons).toContain("critic default-evidence uses default/synthetic critic source");
  expect(review.failureReasons).toContain("critic default-replay is not blind to the proposed final verdict");
});

test("accepted high or critical finalization findings block quorum", () => {
  const blocked = critic("evidence_skeptic-v1", "evidence_skeptic", "evidence", "art-evidence-review", undefined, {
    findingStatus: "accepted",
    findingSeverity: "critical"
  });
  const review = buildAdversarialQuorumReview({
    runId: "run-quorum",
    scope: "finalization",
    targetEvent: event("evt-goal-success", "goal.success.evaluated", ["art-proof"]),
    critics: [
      blocked,
      critic("replay_auditor-v1", "replay_auditor", "replay", "art-replay-review")
    ]
  });

  expect(review.status).toBe("failed");
  expect(review.failureReasons).toContain("accepted critical adversarial finding evidence_skeptic-v1-finding blocks finalization");
  expect(review.acceptedFindings).toHaveLength(1);
});

test("non-blind finalization critics cannot pass even with artifacts and diverse providers", () => {
  const review = buildAdversarialQuorumReview({
    runId: "run-quorum",
    scope: "finalization",
    targetEvent: event("evt-goal-success", "goal.success.evaluated", ["art-proof"]),
    critics: [
      critic("openai-critic", "evidence_skeptic", "evidence", "art-openai", {
        provider: "openai",
        requestedModelId: "gpt-5.5",
        actualModelId: "gpt-5.5",
        modelFamily: "gpt-5",
        routingPath: ["openai"],
        systemPromptLineageHash: "prompt-evidence"
      }, { blind: false }),
      critic("anthropic-critic", "replay_auditor", "replay", "art-anthropic", {
        provider: "anthropic",
        requestedModelId: "claude-opus-4.5",
        actualModelId: "claude-opus-4.5",
        modelFamily: "claude-opus",
        routingPath: ["anthropic"],
        systemPromptLineageHash: "prompt-replay"
      }, { blind: false })
    ]
  });

  expect(review.status).toBe("failed");
  expect(review.failureReasons).toContain("critic openai-critic is not blind to the proposed final verdict");
  expect(review.failureReasons).toContain("critic anthropic-critic blind review did not redact final verdict status");
});

test("OpenRouter critics routed to the same upstream model family are downgraded", () => {
  const review = buildAdversarialQuorumReview({
    runId: "run-quorum",
    scope: "finalization",
    critics: [
      critic("openrouter-critic-a", "evidence_skeptic", "evidence-a", "art-openrouter-a", {
        provider: "openrouter",
        upstreamProvider: "openai",
        requestedModelId: "openai/gpt-5.5",
        actualModelId: "openai/gpt-5.5",
        modelFamily: "gpt-5",
        routingPath: ["openrouter", "openai"],
        systemPromptLineageHash: "prompt-shared"
      }),
      critic("openrouter-critic-b", "replay_auditor", "evidence-b", "art-openrouter-b", {
        provider: "openrouter",
        upstreamProvider: "openai",
        requestedModelId: "openai/gpt-5.5",
        actualModelId: "openai/gpt-5.5",
        modelFamily: "gpt-5",
        routingPath: ["openrouter", "openai"],
        systemPromptLineageHash: "prompt-shared"
      })
    ]
  });

  expect(review.status).toBe("failed");
  expect(review.modelFamilyDiversity.status).toBe("downgraded_to_single_signal");
  expect(review.modelFamilyDiversity.effectiveIndependentSignals).toBe(1);
  expect(review.modelFamilyDiversity.downgradedCriticIds).toEqual(["openrouter-critic-b"]);
  expect(review.failureReasons).toContain("requires critics from at least 2 provider/upstream model-family independence keys");
  expect(review.modelFamilyDiversity.routingGroups[0]).toMatchObject({
    independenceKey: "openai:gpt-5",
    providers: ["openrouter"],
    upstreamProviders: ["openai"],
    modelFamilies: ["gpt-5"]
  });
});

test("mixed provider and model families satisfy verifier-adjacent diversity", () => {
  const review = buildAdversarialQuorumReview({
    runId: "run-quorum",
    scope: "finalization",
    critics: [
      critic("openai-critic", "evidence_skeptic", "evidence", "art-openai", {
        provider: "openai",
        requestedModelId: "gpt-5.5",
        actualModelId: "gpt-5.5",
        modelFamily: "gpt-5",
        routingPath: ["openai"],
        systemPromptLineageHash: "prompt-evidence"
      }),
      critic("anthropic-critic", "replay_auditor", "replay", "art-anthropic", {
        provider: "anthropic",
        requestedModelId: "claude-opus-4.5",
        actualModelId: "claude-opus-4.5",
        modelFamily: "claude-opus",
        routingPath: ["anthropic"],
        systemPromptLineageHash: "prompt-replay"
      })
    ]
  });

  expect(review.status).toBe("passed");
  expect(review.modelFamilyDiversity).toMatchObject({
    status: "passed",
    effectiveIndependentSignals: 2,
    downgradedCriticIds: []
  });
  expect(review.modelFamilyDiversity.distinctIndependenceKeys).toEqual(["anthropic:claude-opus", "openai:gpt-5"]);
});

test("latest adversarial quorum lookup is scoped to the finalization target", () => {
  const first = event("evt-quorum-1", "adversarial.quorum.reviewed", ["art-review-1"], {
    scope: "finalization",
    targetEventId: "evt-old"
  });
  const second = event("evt-quorum-2", "adversarial.quorum.reviewed", ["art-review-2"], {
    scope: "finalization",
    targetEventId: "evt-new"
  });

  expect(latestAdversarialQuorumForTarget([first, second], "finalization", "evt-new")?.id).toBe("evt-quorum-2");
  expect(latestAdversarialQuorumForTarget([first, second], "finalization", "evt-missing")).toBeUndefined();
});

function critic(
  criticId: string,
  role: AdversarialCriticReview["role"],
  independentGroup: string,
  artifactId: string,
  providerLineage: AdversarialProviderLineage = {
    provider: "local",
    requestedModelId: `${criticId}-deterministic-rule-engine`,
    actualModelId: `${criticId}-deterministic-rule-engine`,
    modelFamily: `${independentGroup}-rules`,
    routingPath: ["cli-ledger", "local-rule-engine"],
    systemPromptLineageHash: `${criticId}-prompt`
  },
  options: {
    source?: AdversarialCriticReview["source"];
    blind?: boolean;
    findingStatus?: AdversarialCriticReview["findings"][number]["status"];
    findingSeverity?: AdversarialCriticReview["findings"][number]["severity"];
  } = {}
): AdversarialCriticReview {
  return {
    criticId,
    role,
    independentGroup,
    source: options.source ?? "external_model",
    blindReview: {
      blindedToFinalVerdict: options.blind ?? true,
      targetDigest: `${criticId}-target-digest`,
      redactedFields: options.blind === false ? [] : ["status", "finalState", "canClaimSolved"],
      protocolHash: `${criticId}-blind-protocol`
    },
    providerLineage,
    summary: "adversarial review",
    artifactIds: [artifactId],
    findings: [{
      id: `${criticId}-finding`,
      severity: options.findingSeverity ?? "medium",
      finding: "stress the plan",
      status: options.findingStatus ?? "rejected",
      rationale: options.findingStatus === "accepted"
        ? "Accepted because the blinded critic found an unresolved blocker."
        : "Rejected because persisted evidence covers the objection.",
      artifactIds: [artifactId]
    }]
  };
}

function event(
  id: string,
  type: LedgerEvent["type"],
  artifactIds: string[],
  payload: Record<string, unknown> = {}
): LedgerEvent {
  return {
    id,
    runId: "run-quorum",
    type,
    payload,
    artifactIds,
    createdAt: "2026-05-25T00:00:00.000Z"
  };
}
