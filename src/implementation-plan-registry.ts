import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CANONICAL_MATEMATICA_PLAN_ID,
  CANONICAL_MATEMATICA_PLAN_SHORT_ID,
  CANONICAL_RELEASE_PLAN,
  type CanonicalReleasePlan
} from "./release-plan";

export type SharedImplementationPlanRegistryEntry = {
  registryPlanId: string;
  registryPlanShortId: string;
  status: "draft" | "review" | "approved" | "in_progress" | "done" | "archived";
  title: string;
  canonicalPlanId: string;
  canonicalShortPlanId: string;
  packageName: "@hasna/matematica";
  repository: "hasnatools/matematica";
  taskIds: string[];
};

export type SharedImplementationPlanRegistryMirror = {
  format: "matematica.shared-implementation-plan-registry-mirror";
  version: 1;
  source: "implementations://plans";
  invariant: "exactly-one-canonical-matematica-plan";
  registryPlans: SharedImplementationPlanRegistryEntry[];
};

export type SharedImplementationPlanRegistryValidationIssue = {
  code:
    | "mirror_missing"
    | "mirror_parse_failed"
    | "wrong_format"
    | "registry_empty"
    | "duplicate_canonical_plan"
    | "wrong_plan_identity"
    | "task_id_missing"
    | "task_id_extra"
    | "task_id_order_mismatch";
  message: string;
};

export type SharedImplementationPlanRegistryValidation = {
  ok: boolean;
  registryPlanCount: number;
  canonicalPlanCount: number;
  taskCount: number;
  issues: SharedImplementationPlanRegistryValidationIssue[];
};

export const IMPLEMENTATION_PLAN_REGISTRY_MIRROR_RELATIVE_PATH =
  "docs/release/implementation-plan-registry.json";

export function readSharedImplementationPlanRegistryMirror(
  packageRoot = defaultPackageRoot()
): SharedImplementationPlanRegistryMirror | { error: SharedImplementationPlanRegistryValidationIssue } {
  const path = join(packageRoot, IMPLEMENTATION_PLAN_REGISTRY_MIRROR_RELATIVE_PATH);
  if (!existsSync(path)) {
    return {
      error: {
        code: "mirror_missing",
        message: `${IMPLEMENTATION_PLAN_REGISTRY_MIRROR_RELATIVE_PATH} is missing`
      }
    };
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as SharedImplementationPlanRegistryMirror;
  } catch (error) {
    return {
      error: {
        code: "mirror_parse_failed",
        message: `${IMPLEMENTATION_PLAN_REGISTRY_MIRROR_RELATIVE_PATH} could not be parsed: ${error instanceof Error ? error.message : String(error)}`
      }
    };
  }
}

export function validateSharedImplementationPlanRegistryMirror(input: {
  mirror?: SharedImplementationPlanRegistryMirror | { error: SharedImplementationPlanRegistryValidationIssue };
  canonicalPlan?: CanonicalReleasePlan;
} = {}): SharedImplementationPlanRegistryValidation {
  const canonicalPlan = input.canonicalPlan ?? CANONICAL_RELEASE_PLAN;
  const mirror = input.mirror ?? readSharedImplementationPlanRegistryMirror();
  if ("error" in mirror) {
    return {
      ok: false,
      registryPlanCount: 0,
      canonicalPlanCount: 0,
      taskCount: canonicalPlan.releaseBlockers.length,
      issues: [mirror.error]
    };
  }

  const issues: SharedImplementationPlanRegistryValidationIssue[] = [];
  if (
    mirror.format !== "matematica.shared-implementation-plan-registry-mirror" ||
    mirror.version !== 1 ||
    mirror.source !== "implementations://plans"
  ) {
    issues.push({
      code: "wrong_format",
      message: "shared implementation-plan registry mirror must use matematica.shared-implementation-plan-registry-mirror v1 from implementations://plans"
    });
  }
  if (mirror.registryPlans.length === 0) {
    issues.push({
      code: "registry_empty",
      message: "shared implementation-plan registry mirror has no plans"
    });
  }

  const canonicalPlans = mirror.registryPlans.filter((plan) =>
    plan.packageName === canonicalPlan.packageName ||
    plan.canonicalPlanId === CANONICAL_MATEMATICA_PLAN_ID ||
    plan.canonicalShortPlanId === CANONICAL_MATEMATICA_PLAN_SHORT_ID
  );
  if (canonicalPlans.length !== 1) {
    issues.push({
      code: "duplicate_canonical_plan",
      message: `shared registry mirror must contain exactly one canonical Matematica plan; found ${canonicalPlans.length}`
    });
  }

  const canonicalMirror = canonicalPlans[0];
  if (canonicalMirror) {
    if (
      canonicalMirror.canonicalPlanId !== canonicalPlan.planId ||
      canonicalMirror.canonicalShortPlanId !== canonicalPlan.shortPlanId ||
      canonicalMirror.packageName !== canonicalPlan.packageName ||
      canonicalMirror.repository !== canonicalPlan.repository
    ) {
      issues.push({
        code: "wrong_plan_identity",
        message: "shared registry mirror canonical plan identity diverges from package canonical plan"
      });
    }

    const expectedTaskIds = canonicalPlan.releaseBlockers.map((task) => task.taskId);
    const mirroredTaskIds = canonicalMirror.taskIds;
    const mirroredSet = new Set(mirroredTaskIds);
    const expectedSet = new Set(expectedTaskIds);
    for (const taskId of expectedTaskIds) {
      if (!mirroredSet.has(taskId)) {
        issues.push({
          code: "task_id_missing",
          message: `shared registry mirror is missing canonical task ${taskId}`
        });
      }
    }
    for (const taskId of mirroredTaskIds) {
      if (!expectedSet.has(taskId)) {
        issues.push({
          code: "task_id_extra",
          message: `shared registry mirror contains non-canonical task ${taskId}`
        });
      }
    }
    if (
      expectedTaskIds.length === mirroredTaskIds.length &&
      expectedTaskIds.some((taskId, index) => mirroredTaskIds[index] !== taskId)
    ) {
      issues.push({
        code: "task_id_order_mismatch",
        message: "shared registry mirror task order diverges from package canonical plan"
      });
    }
  }

  return {
    ok: issues.length === 0,
    registryPlanCount: mirror.registryPlans.length,
    canonicalPlanCount: canonicalPlans.length,
    taskCount: canonicalPlan.releaseBlockers.length,
    issues
  };
}

export function formatSharedImplementationPlanRegistryMirror(
  mirror: SharedImplementationPlanRegistryMirror
): string {
  const lines = [
    "Matematica shared implementation-plan registry mirror",
    `Source: ${mirror.source}`,
    `Plans: ${mirror.registryPlans.length}`,
    ""
  ];
  for (const plan of mirror.registryPlans) {
    lines.push(`- ${plan.registryPlanShortId} ${plan.title}`);
    lines.push(`  status=${plan.status} canonicalPlan=${plan.canonicalShortPlanId}`);
    lines.push(`  package=${plan.packageName} repository=${plan.repository}`);
    lines.push(`  tasks=${plan.taskIds.length}`);
  }
  return lines.join("\n");
}

function defaultPackageRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}
