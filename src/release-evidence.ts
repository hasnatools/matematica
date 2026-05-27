import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CANONICAL_RELEASE_PLAN,
  type CanonicalReleasePlan
} from "./release-plan";

export type ReleaseEvidenceSourceHash = {
  path: string;
  sha256: string;
};

export type ReleaseCompletedTaskEvidence = {
  taskId: string;
  evidenceId: string;
  verifiedAt: string;
  verificationCommands: string[];
  requiredCheckIds: string[];
  sourceHashes: ReleaseEvidenceSourceHash[];
};

export type ReleaseSupersessionEvidence = {
  taskId: string;
  replacementTaskIds: string[];
  supersededReason: string;
  commentEvidence: string;
};

export type ReleaseEvidenceFreshnessManifest = {
  format: "matematica.release-evidence-freshness";
  version: 1;
  planId: string;
  generatedAt: string;
  completedTaskEvidence: ReleaseCompletedTaskEvidence[];
  supersessionEvidence: ReleaseSupersessionEvidence[];
};

export type ReleaseEvidenceFreshnessIssue = {
  code:
    | "manifest_missing"
    | "manifest_parse_failed"
    | "wrong_format"
    | "wrong_plan_id"
    | "completed_evidence_missing"
    | "completed_evidence_duplicate"
    | "verification_missing"
    | "required_check_missing"
    | "source_hash_missing"
    | "source_file_missing"
    | "source_hash_stale"
    | "supersession_evidence_missing"
    | "supersession_evidence_duplicate"
    | "supersession_replacement_mismatch"
    | "supersession_reason_mismatch"
    | "supersession_comment_missing";
  taskId?: string;
  path?: string;
  message: string;
};

export type ReleaseEvidenceFreshnessValidation = {
  ok: boolean;
  completedTaskCount: number;
  supersededTaskCount: number;
  evidenceRecordCount: number;
  supersessionRecordCount: number;
  issues: ReleaseEvidenceFreshnessIssue[];
};

export const RELEASE_EVIDENCE_FRESHNESS_MANIFEST_RELATIVE_PATH =
  "docs/release/evidence-freshness.json";

export function readReleaseEvidenceFreshnessManifest(
  packageRoot = defaultPackageRoot()
): ReleaseEvidenceFreshnessManifest | { error: ReleaseEvidenceFreshnessIssue } {
  const path = join(packageRoot, RELEASE_EVIDENCE_FRESHNESS_MANIFEST_RELATIVE_PATH);
  if (!existsSync(path)) {
    return {
      error: {
        code: "manifest_missing",
        message: `${RELEASE_EVIDENCE_FRESHNESS_MANIFEST_RELATIVE_PATH} is missing`
      }
    };
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ReleaseEvidenceFreshnessManifest;
  } catch (error) {
    return {
      error: {
        code: "manifest_parse_failed",
        message: `${RELEASE_EVIDENCE_FRESHNESS_MANIFEST_RELATIVE_PATH} could not be parsed: ${error instanceof Error ? error.message : String(error)}`
      }
    };
  }
}

export function validateReleaseEvidenceFreshness(input: {
  manifest?: ReleaseEvidenceFreshnessManifest | { error: ReleaseEvidenceFreshnessIssue };
  canonicalPlan?: CanonicalReleasePlan;
  packageRoot?: string;
} = {}): ReleaseEvidenceFreshnessValidation {
  const packageRoot = input.packageRoot ?? defaultPackageRoot();
  const canonicalPlan = input.canonicalPlan ?? CANONICAL_RELEASE_PLAN;
  const manifest = input.manifest ?? readReleaseEvidenceFreshnessManifest(packageRoot);
  const completedTasks = canonicalPlan.releaseBlockers.filter((task) => task.status === "completed");
  const supersededTasks = canonicalPlan.releaseBlockers.filter((task) => task.status === "superseded");
  if ("error" in manifest) {
    return {
      ok: false,
      completedTaskCount: completedTasks.length,
      supersededTaskCount: supersededTasks.length,
      evidenceRecordCount: 0,
      supersessionRecordCount: 0,
      issues: [manifest.error]
    };
  }

  const issues: ReleaseEvidenceFreshnessIssue[] = [];
  if (manifest.format !== "matematica.release-evidence-freshness" || manifest.version !== 1) {
    issues.push({
      code: "wrong_format",
      message: "release evidence freshness manifest must use matematica.release-evidence-freshness v1"
    });
  }
  if (manifest.planId !== canonicalPlan.planId) {
    issues.push({
      code: "wrong_plan_id",
      message: `release evidence freshness manifest must target ${canonicalPlan.planId}`
    });
  }

  const evidenceByTask = mapUnique(
    manifest.completedTaskEvidence,
    (item) => item.taskId,
    (taskId) => issues.push({
      code: "completed_evidence_duplicate",
      taskId,
      message: `completed release blocker ${taskId} has duplicate evidence records`
    })
  );
  for (const task of completedTasks) {
    const evidence = evidenceByTask.get(task.taskId);
    if (!evidence) {
      issues.push({
        code: "completed_evidence_missing",
        taskId: task.taskId,
        message: `completed release blocker ${task.taskId} has no freshness evidence`
      });
      continue;
    }
    if (!evidence.evidenceId.trim() || !evidence.verifiedAt.trim() || evidence.verificationCommands.length === 0) {
      issues.push({
        code: "verification_missing",
        taskId: task.taskId,
        message: `completed release blocker ${task.taskId} is missing evidence id, verification timestamp, or commands`
      });
    }
    for (const checkId of task.requiredCheckIds) {
      if (!evidence.requiredCheckIds.includes(checkId)) {
        issues.push({
          code: "required_check_missing",
          taskId: task.taskId,
          message: `completed release blocker ${task.taskId} evidence does not cover required check ${checkId}`
        });
      }
    }
    if (evidence.sourceHashes.length === 0) {
      issues.push({
        code: "source_hash_missing",
        taskId: task.taskId,
        message: `completed release blocker ${task.taskId} has no source freshness hashes`
      });
    }
    for (const sourceHash of evidence.sourceHashes) {
      const path = join(packageRoot, sourceHash.path);
      if (!existsSync(path)) {
        if (sourceHash.path.startsWith("tests/")) continue;
        issues.push({
          code: "source_file_missing",
          taskId: task.taskId,
          path: sourceHash.path,
          message: `completed release blocker ${task.taskId} freshness file is missing: ${sourceHash.path}`
        });
        continue;
      }
      const actual = sha256File(path);
      if (actual !== sourceHash.sha256) {
        issues.push({
          code: "source_hash_stale",
          taskId: task.taskId,
          path: sourceHash.path,
          message: `completed release blocker ${task.taskId} evidence is stale for ${sourceHash.path}`
        });
      }
    }
  }

  const supersessionByTask = mapUnique(
    manifest.supersessionEvidence,
    (item) => item.taskId,
    (taskId) => issues.push({
      code: "supersession_evidence_duplicate",
      taskId,
      message: `superseded release blocker ${taskId} has duplicate supersession records`
    })
  );
  for (const task of supersededTasks) {
    const evidence = supersessionByTask.get(task.taskId);
    if (!evidence) {
      issues.push({
        code: "supersession_evidence_missing",
        taskId: task.taskId,
        message: `superseded release blocker ${task.taskId} has no supersession evidence`
      });
      continue;
    }
    const expectedReplacements = splitTaskIds(task.supersededBy ?? "");
    if (expectedReplacements.join(",") !== evidence.replacementTaskIds.join(",")) {
      issues.push({
        code: "supersession_replacement_mismatch",
        taskId: task.taskId,
        message: `superseded release blocker ${task.taskId} replacement ids diverge from canonical plan`
      });
    }
    if (evidence.supersededReason !== task.supersededReason) {
      issues.push({
        code: "supersession_reason_mismatch",
        taskId: task.taskId,
        message: `superseded release blocker ${task.taskId} reason diverges from canonical plan`
      });
    }
    if (!evidence.commentEvidence.trim()) {
      issues.push({
        code: "supersession_comment_missing",
        taskId: task.taskId,
        message: `superseded release blocker ${task.taskId} lacks comment/history evidence`
      });
    }
  }

  return {
    ok: issues.length === 0,
    completedTaskCount: completedTasks.length,
    supersededTaskCount: supersededTasks.length,
    evidenceRecordCount: manifest.completedTaskEvidence.length,
    supersessionRecordCount: manifest.supersessionEvidence.length,
    issues
  };
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function mapUnique<T>(
  items: T[],
  keyFor: (item: T) => string,
  onDuplicate: (key: string) => void
): Map<string, T> {
  const result = new Map<string, T>();
  for (const item of items) {
    const key = keyFor(item);
    if (result.has(key)) onDuplicate(key);
    result.set(key, item);
  }
  return result;
}

function splitTaskIds(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function defaultPackageRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}
