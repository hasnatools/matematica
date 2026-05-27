import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli";
import { loadConfig } from "../src/config";
import {
  RELEASE_MILESTONE_PLAN,
  formatMilestonePlan,
  validateMilestonePlan,
  validateMilestoneReadiness
} from "../src/milestones";
import {
  formatSharedImplementationPlanRegistryMirror,
  readSharedImplementationPlanRegistryMirror,
  validateSharedImplementationPlanRegistryMirror,
  type SharedImplementationPlanRegistryMirror
} from "../src/implementation-plan-registry";
import {
  readReleaseEvidenceFreshnessManifest,
  validateReleaseEvidenceFreshness,
  type ReleaseEvidenceFreshnessManifest
} from "../src/release-evidence";
import {
  CANONICAL_MATEMATICA_PLAN_ID,
  CANONICAL_RELEASE_PLAN,
  formatCanonicalReleasePlan,
  validateCanonicalReleasePlan,
  type CanonicalReleasePlan
} from "../src/release-plan";
import { buildReleaseDoctorReport } from "../src/release-doctor";
import { buildReleaseWorkflowSteps } from "../src/release-workflow";

test("release milestone plan has contiguous ordering and complete required gates", () => {
  const validation = validateMilestonePlan();

  expect(validation).toEqual({ ok: true, issues: [] });
  expect(RELEASE_MILESTONE_PLAN.milestones.map((milestone) => milestone.id)).toEqual([
    "m0-local-core",
    "m1-replay-verifier",
    "m2-research-security",
    "m3-provider-byok",
    "m4-swarm-scale",
    "m5-public-release"
  ]);
  expect(RELEASE_MILESTONE_PLAN.milestones.every((milestone) =>
    milestone.gates.every((gate) => gate.required && gate.commands.length > 0 && gate.blocks.length > 0)
  )).toBe(true);
});

test("milestone release ordering keeps swarm and public release behind safety gates", () => {
  const byId = new Map(RELEASE_MILESTONE_PLAN.milestones.map((milestone) => [milestone.id, milestone]));

  expect(byId.get("m4-swarm-scale")!.order).toBeGreaterThan(byId.get("m3-provider-byok")!.order);
  expect(byId.get("m5-public-release")!.order).toBeGreaterThan(byId.get("m4-swarm-scale")!.order);
  expect(byId.get("m4-swarm-scale")!.gates.map((gate) => gate.id)).toContain("m4-kill-drill");
  expect(byId.get("m5-public-release")!.gates.map((gate) => gate.id)).toContain("m5-acceptance");
});

test("milestone readiness requires fresh command evidence or executable release workflow coverage", () => {
  const manifest = readReleaseEvidenceFreshnessManifest();
  if ("error" in manifest) throw new Error(manifest.error.message);
  const validation = validateReleaseEvidenceFreshness({ manifest });
  expect(validation.ok).toBe(true);

  const readiness = validateMilestoneReadiness({
    freshEvidenceCommands: manifest.completedTaskEvidence.flatMap((item) => item.verificationCommands),
    executableCommands: buildReleaseWorkflowSteps().map((step) => step.command.join(" "))
  });

  expect(readiness.ok).toBe(true);
  expect(readiness.requiredCommandCount).toBe(25);
  expect(readiness.gatedOrPlannedMilestoneCount).toBe(4);
});

test("milestone readiness rejects gated or planned milestones with missing command evidence", () => {
  const readiness = validateMilestoneReadiness({
    freshEvidenceCommands: ["bunx tsc --noEmit"],
    executableCommands: []
  });

  expect(readiness.ok).toBe(false);
  expect(readiness.issues.map((issue) => issue.code)).toContain("milestone_command_uncovered");
  expect(readiness.issues.map((issue) => issue.command)).toContain("bun run src/bin/matematica.ts drills swarm-stress --workers 100 --provider-concurrency 8");
});

test("milestones CLI renders human and JSON release plans", async () => {
  const text = await runCli(["milestones", "list"]);
  expect(text).toContain("Matematica release milestones");
  expect(text).toContain("m0-local-core");
  expect(text).toContain("m5-public-release");
  expect(text).toBe(formatMilestonePlan());

  const json = JSON.parse(await runCli(["milestones", "list", "--json"]));
  expect(json.format).toBe("matematica.release-milestone-plan");
  expect(json.milestones).toHaveLength(6);
  expect(json.milestones[4].id).toBe("m4-swarm-scale");
});

test("canonical release plan validates release-critical task coverage", () => {
  const releaseCheckIds = unique(CANONICAL_RELEASE_PLAN.releaseBlockers.flatMap((task) => task.requiredCheckIds));
  const validation = validateCanonicalReleasePlan({
    releaseCheckIds,
    milestoneIds: RELEASE_MILESTONE_PLAN.milestones.map((milestone) => milestone.id)
  });

  expect(validation.ok).toBe(true);
  expect(validation.issues).toEqual([]);
  expect(CANONICAL_RELEASE_PLAN.planId).toBe(CANONICAL_MATEMATICA_PLAN_ID);
  expect(CANONICAL_RELEASE_PLAN.releaseBlockers.map((task) => task.taskId)).toEqual(expect.arrayContaining([
    "a219e0dc",
    "9d269c14",
    "a401f68d",
    "a9aa79bf",
    "33bdd555",
    "3c5f744c",
    "b9a12f12",
    "a3b795e3",
    "451a787f",
    "04362083",
    "fc3b3129",
    "d986cab3",
    "21a0604c",
    "2e00f370",
    "3be841bf",
    "bbdd53b9"
  ]));
  expect(validation.activeBlockerCount).toBeGreaterThan(0);
  expect(validation.completedBlockerCount).toBeGreaterThan(0);
  expect(validation.supersededTaskCount).toBe(2);
});

test("canonical release plan rejects stale duplicated or unmapped blockers", () => {
  const plan = clonePlan();
  plan.releaseBlockers.push({ ...plan.releaseBlockers[0] });
  plan.releaseBlockers[1] = {
    ...plan.releaseBlockers[1],
    owner: "",
    acceptanceCriteria: [""],
    requiredCheckIds: ["missing-release-check"],
    milestoneId: "missing-milestone"
  };
  const supersededIndex = plan.releaseBlockers.findIndex((task) => task.status === "superseded");
  plan.releaseBlockers[supersededIndex] = {
    ...plan.releaseBlockers[supersededIndex],
    supersededBy: "missing-replacement",
    supersededReason: ""
  };

  const validation = validateCanonicalReleasePlan({
    plan,
    releaseCheckIds: unique(CANONICAL_RELEASE_PLAN.releaseBlockers.flatMap((task) => task.requiredCheckIds)),
    milestoneIds: RELEASE_MILESTONE_PLAN.milestones.map((milestone) => milestone.id)
  });
  const codes = validation.issues.map((issue) => issue.code);

  expect(validation.ok).toBe(false);
  for (const code of [
    "duplicate_task_id",
    "owner_missing",
    "acceptance_missing",
    "release_check_missing",
    "milestone_missing",
    "superseded_without_reason",
    "superseded_replacement_missing"
  ] as const) {
    expect(codes).toContain(code);
  }
});

test("release plan CLI renders human and JSON canonical registry", async () => {
  const text = await runCli(["release-plan", "show"]);
  expect(text).toBe(formatCanonicalReleasePlan());
  expect(text).toContain("Matematica canonical release plan");
  expect(text).toContain("62077a6e");
  expect(text).toContain("a219e0dc");

  const json = JSON.parse(await runCli(["release-plan", "show", "--json"]));
  expect(json.format).toBe("matematica.canonical-release-plan");
  expect(json.planId).toBe(CANONICAL_MATEMATICA_PLAN_ID);
  expect(json.releaseBlockers.length).toBe(CANONICAL_RELEASE_PLAN.releaseBlockers.length);
});

test("shared implementation-plan registry mirror validates against canonical task ids", async () => {
  const mirror = readSharedImplementationPlanRegistryMirror();
  if ("error" in mirror) throw new Error(mirror.error.message);
  const validation = validateSharedImplementationPlanRegistryMirror({ mirror });

  expect(validation.ok).toBe(true);
  expect(validation.registryPlanCount).toBe(1);
  expect(validation.canonicalPlanCount).toBe(1);
  expect(validation.taskCount).toBe(CANONICAL_RELEASE_PLAN.releaseBlockers.length);
  expect(mirror.registryPlans[0].canonicalPlanId).toBe(CANONICAL_MATEMATICA_PLAN_ID);
  expect(mirror.registryPlans[0].taskIds).toEqual(CANONICAL_RELEASE_PLAN.releaseBlockers.map((task) => task.taskId));

  const text = await runCli(["release-plan", "registry"]);
  expect(text).toBe(formatSharedImplementationPlanRegistryMirror(mirror));
  expect(text).toContain("implementations://plans");
  expect(text).toContain("0c51ff1c");

  const json = JSON.parse(await runCli(["release-plan", "registry", "--json"]));
  expect(json.format).toBe("matematica.shared-implementation-plan-registry-mirror");
  expect(json.registryPlans[0].canonicalPlanId).toBe(CANONICAL_MATEMATICA_PLAN_ID);
});

test("shared implementation-plan registry mirror rejects empty duplicate or divergent plans", () => {
  const mirror = readSharedImplementationPlanRegistryMirror();
  if ("error" in mirror) throw new Error(mirror.error.message);

  const empty = cloneMirror(mirror);
  empty.registryPlans = [];
  expect(validateSharedImplementationPlanRegistryMirror({ mirror: empty }).issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
    "registry_empty",
    "duplicate_canonical_plan"
  ]));

  const duplicate = cloneMirror(mirror);
  duplicate.registryPlans.push({ ...duplicate.registryPlans[0], registryPlanId: "duplicate-plan", registryPlanShortId: "duplicate" });
  expect(validateSharedImplementationPlanRegistryMirror({ mirror: duplicate }).issues.map((issue) => issue.code)).toContain("duplicate_canonical_plan");

  const divergent = cloneMirror(mirror);
  divergent.registryPlans[0].taskIds = divergent.registryPlans[0].taskIds.slice(1).concat("extra-task");
  const codes = validateSharedImplementationPlanRegistryMirror({ mirror: divergent }).issues.map((issue) => issue.code);
  expect(codes).toContain("task_id_missing");
  expect(codes).toContain("task_id_extra");
  expect(codes).toContain("task_id_order_mismatch");
});

test("release evidence freshness manifest validates completed blockers and supersession trails", async () => {
  const manifest = readReleaseEvidenceFreshnessManifest();
  if ("error" in manifest) throw new Error(manifest.error.message);
  const validation = validateReleaseEvidenceFreshness({ manifest });

  expect(validation.ok).toBe(true);
  expect(validation.completedTaskCount).toBe(43);
  expect(validation.supersededTaskCount).toBe(2);
  expect(manifest.completedTaskEvidence.map((item) => item.taskId)).toEqual(expect.arrayContaining([
    "d986cab3",
    "a219e0dc",
    "a3b795e3",
    "04362083",
    "fc3b3129",
    "451a787f",
    "9d269c14",
    "29bd3e36",
    "fe8ff7dc",
    "b685adb5",
    "7202cb8f",
    "a89287a7",
    "a8c85969",
    "21e3177e",
    "2e00f370",
    "18bf46d9",
    "0d26e615",
    "a976b9a0",
    "29e25612",
    "5bc128e2",
    "9c518524",
    "c3a22bd0",
    "4d8e86ef",
    "a401f68d",
    "c8e06dcb",
    "f020dba2",
    "6daa2d93",
    "c7b2a697",
    "ba7da35c",
    "b9a12f12",
    "1baf48f5",
    "3c5f744c",
    "a9aa79bf",
    "33bdd555",
    "9a35cdba",
    "a2fb51b7",
    "e89c566b"
  ]));
  expect(manifest.supersessionEvidence.map((item) => item.taskId)).toEqual(["3be841bf", "bbdd53b9"]);

  const text = await runCli(["release-plan", "evidence"]);
  expect(text).toContain("Matematica release evidence freshness manifest");
  expect(text).toContain("Completed evidence records: 43");

  const json = JSON.parse(await runCli(["release-plan", "evidence", "--json"]));
  expect(json.format).toBe("matematica.release-evidence-freshness");
  expect(json.completedTaskEvidence).toHaveLength(43);
});

test("release evidence freshness manifest rejects stale missing or incomplete evidence", () => {
  const manifest = readReleaseEvidenceFreshnessManifest();
  if ("error" in manifest) throw new Error(manifest.error.message);
  const missing = cloneEvidenceManifest(manifest);
  missing.completedTaskEvidence = missing.completedTaskEvidence.filter((item) => item.taskId !== "04362083");

  expect(validateReleaseEvidenceFreshness({ manifest: missing }).issues.map((issue) => issue.code)).toContain("completed_evidence_missing");

  const stale = cloneEvidenceManifest(manifest);
  stale.completedTaskEvidence[0].sourceHashes[0].sha256 = "stale";
  expect(validateReleaseEvidenceFreshness({ manifest: stale }).issues.map((issue) => issue.code)).toContain("source_hash_stale");

  const supersession = cloneEvidenceManifest(manifest);
  supersession.supersessionEvidence[0].commentEvidence = "";
  supersession.supersessionEvidence[0].replacementTaskIds = ["wrong"];
  const codes = validateReleaseEvidenceFreshness({ manifest: supersession }).issues.map((issue) => issue.code);
  expect(codes).toContain("supersession_comment_missing");
  expect(codes).toContain("supersession_replacement_mismatch");
});

test("release doctor milestone gates fail when backing evidence is stale", () => {
  const manifest = readReleaseEvidenceFreshnessManifest();
  if ("error" in manifest) throw new Error(manifest.error.message);
  const stale = cloneEvidenceManifest(manifest);
  stale.completedTaskEvidence[0].sourceHashes[0].sha256 = "stale";
  const home = mkdtempSync(join(tmpdir(), "matematica-milestone-doctor-test-"));
  process.env.MATEMATICA_HOME = home;

  try {
    const report = buildReleaseDoctorReport({
      cwd: process.cwd(),
      config: loadConfig(home, {}),
      releaseEvidenceManifest: stale
    });
    const check = report.checks.find((item) => item.id === "milestone-gates");

    expect(check?.status).toBe("fail");
    expect(check?.issues.join("\n")).toContain("release-evidence-freshness");
    expect(check?.issues.join("\n")).toContain("source_hash_stale");
  } finally {
    delete process.env.MATEMATICA_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});

function clonePlan(): CanonicalReleasePlan {
  return JSON.parse(JSON.stringify(CANONICAL_RELEASE_PLAN)) as CanonicalReleasePlan;
}

function cloneMirror(mirror: SharedImplementationPlanRegistryMirror): SharedImplementationPlanRegistryMirror {
  return JSON.parse(JSON.stringify(mirror)) as SharedImplementationPlanRegistryMirror;
}

function cloneEvidenceManifest(manifest: ReleaseEvidenceFreshnessManifest): ReleaseEvidenceFreshnessManifest {
  return JSON.parse(JSON.stringify(manifest)) as ReleaseEvidenceFreshnessManifest;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
