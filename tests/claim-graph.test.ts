import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "../src/artifacts";
import {
  buildClaimRetraction,
  evaluateClaimGraph,
  persistClaimRetraction
} from "../src/claim-graph";
import { makeClaimContract, type FormalClaimContract } from "../src/evidence";
import { evaluateGoalSuccess } from "../src/goal-success";
import { Ledger } from "../src/ledger";
import { getAppPaths } from "../src/paths";
import { replayOffline } from "../src/replay";
import { renderReport } from "../src/report";
import { runGoal } from "../src/runner";
import { loadConfig } from "../src/config";

const homes: string[] = [];

afterEach(() => {
  delete process.env.MATEMATICA_HOME;
  while (homes.length > 0) {
    rmSync(homes.pop()!, { recursive: true, force: true });
  }
});

test("claim graph blocks target claims with active counterexample conflicts", () => {
  const theorem = claim("claim-theorem", "lean_checked_theorem", "formal_proof", "forall n, P n");
  const counterexample = claim("claim-counterexample", "counterexample", "verified_counterexample", "n = 0 refutes forall n, P n", ["claim-theorem"]);
  const decision = evaluateClaimGraph({
    claims: [{ claim: theorem }, { claim: counterexample }],
    targetClaimId: theorem.id
  });

  expect(decision.ok).toBe(false);
  expect(decision.conflicts.map((conflict) => conflict.kind)).toContain("counterexample_refutes_claim");
  expect(decision.blockingClaimIds).toEqual(["claim-counterexample"]);
  expect(decision.nodes.find((node) => node.claimId === theorem.id)?.status).toBe("conflicted");
});

test("explicit retraction blocks goal success even when evidence gate accepts", () => {
  const run = {
    id: "run-claim-graph",
    problem: "Prove 1 + 1 = 2",
    goal: "Find verified computation",
    successCriteria: ["Produce verifier-backed evidence"],
    workflow: "pflk" as const,
    budget: { maxAttempts: 1 },
    status: "running" as const,
    evidenceGrade: "none" as const,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const target = claim("claim-target", "numerical_evidence", "verified_computation", "1 + 1 = 2");
  const graph = evaluateClaimGraph({
    claims: [{ claim: target, artifactIds: ["art-target"] }],
    targetClaimId: target.id,
    retractions: [buildClaimRetraction({ claimId: target.id, reason: "independent rerun contradicted the computation" })]
  });
  const gate = {
    canMarkGoalMet: true,
    reason: "verifier-backed success with independent quorum",
    quorum: {
      required: ["primary verifier"],
      satisfiedBy: [{ verifierId: target.verifierId, role: "primary_verifier", artifactIds: ["art-target"], artifactHashes: ["hash"] }],
      disagreements: []
    }
  };
  const success = evaluateGoalSuccess({
    run,
    claim: target,
    gate,
    problemClassification: { class: "standard_problem", triggers: [] },
    candidateArtifactIds: ["art-target"],
    claimGraph: graph
  });

  expect(success.status).toBe("not_met");
  expect(success.reason).toContain("Claim graph blocks target claim");
});

test("claim graph reviews are persisted reported and replay-verified", async () => {
  const { home, ledger, artifacts, run } = setupSolvable();
  await runGoal(run.id, ledger, artifacts);

  const claimGraphEvent = ledger.listEvents(run.id).find((event) => event.type === "claim.graph.reviewed");
  expect(claimGraphEvent?.payload.decision).toMatchObject({ ok: true, targetClaimId: `claim-${run.id}-local-v0` });
  expect(renderReport(run.id, ledger)).toContain("## Claim Graph Review");
  expect(replayOffline({ runId: run.id, ledger, cwd: process.cwd(), config: loadConfig(home), verifyFinal: true }).ok).toBe(true);

  const claimGraphArtifactId = claimGraphEvent?.payload.artifactId;
  const claimGraphArtifact = ledger.listArtifacts(run.id).find((artifact) => artifact.id === claimGraphArtifactId);
  expect(claimGraphArtifact).toBeTruthy();
  const parsed = JSON.parse(readFileSync(claimGraphArtifact!.path, "utf8"));
  writeFileSync(claimGraphArtifact!.path, JSON.stringify({ ...parsed, ok: false, reason: "forged claim graph result" }, null, 2));

  const replay = replayOffline({ runId: run.id, ledger, cwd: process.cwd(), config: loadConfig(home), verifyFinal: true });
  expect(replay.ok).toBe(false);
  expect(replay.finalVerification?.divergences.map((item) => item.kind)).toContain("claim_graph");
});

test("claim retraction workflow persists auditable retraction artifacts", () => {
  const { ledger, artifacts, run } = setupSolvable();
  const retraction = persistClaimRetraction({
    runId: run.id,
    ledger,
    artifacts,
    claimId: "claim-stale",
    reason: "later verifier result invalidated the assumptions",
    retractedByClaimId: "claim-new"
  });

  expect(retraction.retraction.eventId).toBe(retraction.event.id);
  expect(retraction.artifact.kind).toBe("claim.retraction");
  expect(ledger.listEvents(run.id).find((event) => event.type === "claim.retracted")?.artifactIds).toContain(retraction.artifact.id);
});

function setupSolvable() {
  const home = mkdtempSync(join(tmpdir(), "matematica-claim-graph-test-"));
  homes.push(home);
  process.env.MATEMATICA_HOME = home;
  const paths = getAppPaths();
  const ledger = new Ledger(paths.dbPath);
  const artifacts = new ArtifactStore(paths.artifactsDir, ledger);
  const run = ledger.createRun({
    problem: "Prove 1 + 1 = 2",
    goal: "Find verified computation",
    successCriteria: ["Produce verifier-backed evidence"],
    workflow: "pflk",
    budget: { maxAttempts: 8, maxWorkers: 2, maxTokens: 2_000 }
  });
  return { home, ledger, artifacts, run };
}

function claim(
  id: string,
  claimType: FormalClaimContract["claimType"],
  evidenceGrade: FormalClaimContract["evidenceGrade"],
  conclusion: string,
  dependencies: string[] = []
): FormalClaimContract {
  return makeClaimContract({
    id,
    claimType,
    verifierId: evidenceGrade === "verified_counterexample" ? "counterexample-checker" : "local-deterministic-v0",
    assumptions: [],
    conclusion,
    dependencies,
    verifierStatus: "verified",
    evidenceGrade,
    verifierArtifactIds: ["art-target"],
    supportingVerifierResults: evidenceGrade === "verified_computation" ? [{
      verifierId: "arithmetic-independent-checker",
      role: "independent_checker",
      claimType,
      verifierStatus: "verified",
      evidenceGrade,
      artifactIds: ["art-target"]
    }] : undefined,
    formalization: { status: "not_required" }
  });
}
