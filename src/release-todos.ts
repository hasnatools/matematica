import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CANONICAL_MATEMATICA_PLAN_ID,
  CANONICAL_RELEASE_PLAN,
  type CanonicalReleasePlan
} from "./release-plan";

export type ReleaseLiveTodoStatus = "pending" | "in_progress" | "completed" | "superseded" | "failed";

export type ReleaseLiveTodoTask = {
  id: string;
  title: string;
  status: ReleaseLiveTodoStatus | string;
  priority: string;
  plan_id?: string | null;
  working_dir?: string | null;
  tags?: string[];
  reason?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type ReleaseLiveTodosSnapshot = {
  format: "matematica.release-live-todos";
  version: 1;
  source: string;
  tasks: ReleaseLiveTodoTask[];
};

export type ReleaseLiveTodosIssue = {
  code:
    | "live_todos_unavailable"
    | "live_todos_malformed"
    | "live_todos_untrusted_source"
    | "live_todos_low_entropy"
    | "live_todo_duplicate_title"
    | "live_todo_placeholder"
    | "live_todo_superseded_still_active"
    | "live_plan_blocker_missing"
    | "live_todo_unrepresented"
    | "live_todo_completed_in_plan";
  taskId?: string;
  message: string;
};

export type ReleaseLiveTodosValidation = {
  ok: boolean;
  source: string;
  releaseRelevantTaskCount: number;
  liveCriticalTaskCount: number;
  representedTaskCount: number;
  nonReleaseBacklogCount: number;
  duplicateTitleGroupCount: number;
  placeholderTaskCount: number;
  supersededActiveTaskCount: number;
  missingActivePlanBlockerCount: number;
  entropyScorePermille: number;
  issues: ReleaseLiveTodosIssue[];
};

export function readReleaseLiveTodosSnapshot(input: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): ReleaseLiveTodosSnapshot | { error: ReleaseLiveTodosIssue } {
  const env = input.env ?? process.env;
  const hasOverride = Object.prototype.hasOwnProperty.call(env, "MATEMATICA_RELEASE_TODOS_SNAPSHOT_JSON");
  const override = env.MATEMATICA_RELEASE_TODOS_SNAPSHOT_JSON;
  if (hasOverride) {
    if (typeof override !== "string" || override.trim().length === 0) {
      return {
        error: {
          code: "live_todos_malformed",
          message: "MATEMATICA_RELEASE_TODOS_SNAPSHOT_JSON must be a non-empty named fixture or captured todos snapshot"
        }
      };
    }
    try {
      const parsed = JSON.parse(override);
      return parseReleaseLiveTodosSnapshot(parsed, "MATEMATICA_RELEASE_TODOS_SNAPSHOT_JSON");
    } catch (error) {
      return {
        error: {
          code: "live_todos_unavailable",
          message: `MATEMATICA_RELEASE_TODOS_SNAPSHOT_JSON could not be parsed: ${error instanceof Error ? error.message : String(error)}`
        }
      };
    }
  }
  if (!isMatematicaSourceProject(input.cwd)) {
    return {
      format: "matematica.release-live-todos",
      version: 1,
      source: "not-source-project",
      tasks: []
    };
  }

  const tasks: ReleaseLiveTodoTask[] = [];
  const limit = 5000;
  for (const status of ["pending", "in_progress"]) {
    const result = spawnSync("todos", [
      "--project",
      input.cwd,
      "list",
      "--status",
      status,
      "--priority",
      "critical",
      "--format",
      "json",
      "--limit",
      String(limit)
    ], {
      cwd: input.cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 100 * 1024 * 1024
    });
    if (result.status !== 0) {
      return {
        error: {
          code: "live_todos_unavailable",
          message: `todos ${status} snapshot failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.status ?? "unknown"}`}`
        }
      };
    }
    try {
      const page = parseTodosJsonArray(result.stdout);
      if (page.length >= limit) {
        return {
          error: {
            code: "live_todos_unavailable",
            message: `todos ${status} snapshot returned ${page.length} tasks at the safety limit; release snapshot may be truncated`
          }
        };
      }
      tasks.push(...page.filter((task) => task.working_dir === input.cwd || task.plan_id === CANONICAL_MATEMATICA_PLAN_ID));
    } catch (error) {
      return {
        error: {
          code: "live_todos_unavailable",
          message: `todos ${status} snapshot could not be parsed: ${error instanceof Error ? error.message : String(error)}`
        }
      };
    }
  }

  return {
    format: "matematica.release-live-todos",
    version: 1,
    source: "todos-cli",
    tasks
  };
}

function parseTodosJsonArray(stdout: string): ReleaseLiveTodoTask[] {
  try {
    const parsed = JSON.parse(stdout);
    return Array.isArray(parsed) ? parsed as ReleaseLiveTodoTask[] : [];
  } catch {
    const start = stdout.indexOf("[");
    const end = stdout.lastIndexOf("]");
    if (start === -1 || end <= start) throw new Error("no JSON array found in todos output");
    const parsed = JSON.parse(stdout.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed as ReleaseLiveTodoTask[] : [];
  }
}

export function validateReleaseLiveTodos(input: {
  snapshot?: ReleaseLiveTodosSnapshot | { error: ReleaseLiveTodosIssue };
  plan?: CanonicalReleasePlan;
} = {}): ReleaseLiveTodosValidation {
  const plan = input.plan ?? CANONICAL_RELEASE_PLAN;
  const snapshot = input.snapshot ?? {
    format: "matematica.release-live-todos" as const,
    version: 1 as const,
    source: "not-provided",
    tasks: []
  };
  if ("error" in snapshot) {
    return {
      ok: false,
      source: "error",
      releaseRelevantTaskCount: 0,
      liveCriticalTaskCount: 0,
      representedTaskCount: 0,
      nonReleaseBacklogCount: 0,
      duplicateTitleGroupCount: 0,
      placeholderTaskCount: 0,
      supersededActiveTaskCount: 0,
      missingActivePlanBlockerCount: 0,
      entropyScorePermille: 0,
      issues: [snapshot.error]
    };
  }
  const shapeIssue = validateReleaseLiveTodosSnapshotShape(snapshot);
  if (shapeIssue) {
    return {
      ok: false,
      source: "malformed",
      releaseRelevantTaskCount: 0,
      liveCriticalTaskCount: 0,
      representedTaskCount: 0,
      nonReleaseBacklogCount: 0,
      duplicateTitleGroupCount: 0,
      placeholderTaskCount: 0,
      supersededActiveTaskCount: 0,
      missingActivePlanBlockerCount: 0,
      entropyScorePermille: 0,
      issues: [shapeIssue]
    };
  }
  const sourceIssue = validateReleaseLiveTodosSource(snapshot);
  if (sourceIssue) {
    return {
      ok: false,
      source: snapshot.source,
      releaseRelevantTaskCount: 0,
      liveCriticalTaskCount: 0,
      representedTaskCount: 0,
      nonReleaseBacklogCount: 0,
      duplicateTitleGroupCount: 0,
      placeholderTaskCount: 0,
      supersededActiveTaskCount: 0,
      missingActivePlanBlockerCount: 0,
      entropyScorePermille: 0,
      issues: [sourceIssue]
    };
  }

  const blockers = new Map(plan.releaseBlockers.map((task) => [task.taskId, task]));
  const issues: ReleaseLiveTodosIssue[] = [];
  const releaseRelevantTasks = snapshot.tasks.filter(isActiveCanonicalMatematicaTodo);
  const quality = validateReleaseTodoEntropy(releaseRelevantTasks);
  let liveCriticalTaskCount = 0;
  let representedTaskCount = 0;
  let nonReleaseBacklogCount = 0;
  let supersededActiveTaskCount = 0;
  let missingActivePlanBlockerCount = 0;

  issues.push(...quality.issues);

  for (const task of releaseRelevantTasks) {
    const taskId = shortTaskId(task.id);
    const blocker = blockers.get(taskId);
    if (blocker?.status === "superseded") {
      supersededActiveTaskCount += 1;
      issues.push({
        code: "live_todo_superseded_still_active",
        taskId,
        message: `live todo ${taskId} is still ${task.status} but the canonical release plan supersedes it with ${blocker.supersededBy ?? "no replacement"}`
      });
    }
  }

  if (shouldRequireLiveCoverage(snapshot)) {
    const liveCriticalIds = new Set(
      releaseRelevantTasks
        .filter((task) => task.priority === "critical")
        .map((task) => shortTaskId(task.id))
    );
    for (const blocker of plan.releaseBlockers) {
      if (blocker.priority !== "critical") continue;
      if (blocker.status !== "pending" && blocker.status !== "in_progress") continue;
      if (liveCriticalIds.has(blocker.taskId)) continue;
      missingActivePlanBlockerCount += 1;
      issues.push({
        code: "live_plan_blocker_missing",
        taskId: blocker.taskId,
        message: `canonical active critical release blocker ${blocker.taskId} is not present in the live pending/in_progress todos-cli snapshot`
      });
    }
  }

  for (const task of snapshot.tasks) {
    if (!isTrackedReleaseCriticalTodo(task)) continue;
    liveCriticalTaskCount += 1;
    const taskId = shortTaskId(task.id);
    const blocker = blockers.get(taskId);
    if (!blocker) {
      if (isExplicitNonReleaseBacklog(task)) {
        nonReleaseBacklogCount += 1;
        continue;
      }
      issues.push({
        code: "live_todo_unrepresented",
        taskId,
        message: `live critical todo ${taskId} is pending/in_progress under plan ${CANONICAL_MATEMATICA_PLAN_ID} but is not an active blocker, superseded task, or explicit non-release backlog item`
      });
      continue;
    }
    if (blocker.status === "completed") {
      issues.push({
        code: "live_todo_completed_in_plan",
        taskId,
        message: `live critical todo ${taskId} is still ${task.status} but the canonical release plan marks it completed`
      });
      continue;
    }
    representedTaskCount += 1;
  }

  return {
    ok: issues.length === 0,
    source: snapshot.source,
    releaseRelevantTaskCount: releaseRelevantTasks.length,
    liveCriticalTaskCount,
    representedTaskCount,
    nonReleaseBacklogCount,
    duplicateTitleGroupCount: quality.duplicateTitleGroupCount,
    placeholderTaskCount: quality.placeholderTaskCount,
    supersededActiveTaskCount,
    missingActivePlanBlockerCount,
    entropyScorePermille: quality.entropyScorePermille,
    issues
  };
}

function parseReleaseLiveTodosSnapshot(
  value: unknown,
  source: string
): ReleaseLiveTodosSnapshot | { error: ReleaseLiveTodosIssue } {
  const issue = validateReleaseLiveTodosSnapshotShape(value);
  if (issue) {
    return {
      error: {
        ...issue,
        message: `${source} is not a valid release live-todos snapshot: ${issue.message}`
      }
    };
  }
  return value as ReleaseLiveTodosSnapshot;
}

function validateReleaseLiveTodosSnapshotShape(value: unknown): ReleaseLiveTodosIssue | undefined {
  if (!value || typeof value !== "object") {
    return {
      code: "live_todos_malformed",
      message: "snapshot must be an object"
    };
  }
  const snapshot = value as Partial<ReleaseLiveTodosSnapshot>;
  if (snapshot.format !== "matematica.release-live-todos" || snapshot.version !== 1) {
    return {
      code: "live_todos_malformed",
      message: "snapshot must use matematica.release-live-todos v1"
    };
  }
  if (typeof snapshot.source !== "string" || snapshot.source.trim().length === 0) {
    return {
      code: "live_todos_malformed",
      message: "snapshot source must be a non-empty string"
    };
  }
  if (!Array.isArray(snapshot.tasks)) {
    return {
      code: "live_todos_malformed",
      message: "snapshot tasks must be an array"
    };
  }
  for (const task of snapshot.tasks) {
    if (!task || typeof task !== "object") {
      return {
        code: "live_todos_malformed",
        message: "snapshot task entries must be objects"
      };
    }
    const candidate = task as Partial<ReleaseLiveTodoTask>;
    if (
      typeof candidate.id !== "string" ||
      typeof candidate.title !== "string" ||
      typeof candidate.status !== "string" ||
      typeof candidate.priority !== "string"
    ) {
      return {
        code: "live_todos_malformed",
        message: "snapshot task entries require string id, title, status, and priority"
      };
    }
  }
  return undefined;
}

function validateReleaseLiveTodosSource(snapshot: ReleaseLiveTodosSnapshot): ReleaseLiveTodosIssue | undefined {
  const trustedSource = snapshot.source === "todos-cli" ||
    snapshot.source === "not-source-project" ||
    snapshot.source.startsWith("unit-test-fixture:");
  if (!trustedSource) {
    return {
      code: "live_todos_untrusted_source",
      message: `live todos snapshot source ${snapshot.source} is not trusted for release readiness`
    };
  }
  if (
    snapshot.tasks.length === 0 &&
    snapshot.source !== "todos-cli" &&
    !snapshot.source.startsWith("unit-test-fixture:") &&
    snapshot.source !== "not-source-project"
  ) {
    return {
      code: "live_todos_untrusted_source",
      message: "empty live todos snapshots are allowed only for todos-cli, named unit-test fixtures, or non-source package checks"
    };
  }
  return undefined;
}

function isTrackedReleaseCriticalTodo(task: ReleaseLiveTodoTask): boolean {
  return task.priority === "critical" &&
    (task.status === "pending" || task.status === "in_progress") &&
    task.plan_id === CANONICAL_MATEMATICA_PLAN_ID;
}

function isActiveCanonicalMatematicaTodo(task: ReleaseLiveTodoTask): boolean {
  return (task.status === "pending" || task.status === "in_progress") &&
    task.plan_id === CANONICAL_MATEMATICA_PLAN_ID;
}

function shouldRequireLiveCoverage(snapshot: ReleaseLiveTodosSnapshot): boolean {
  return snapshot.source === "todos-cli";
}

function validateReleaseTodoEntropy(tasks: ReleaseLiveTodoTask[]): {
  duplicateTitleGroupCount: number;
  placeholderTaskCount: number;
  entropyScorePermille: number;
  issues: ReleaseLiveTodosIssue[];
} {
  if (tasks.length === 0) {
    return {
      duplicateTitleGroupCount: 0,
      placeholderTaskCount: 0,
      entropyScorePermille: 1000,
      issues: []
    };
  }

  const issues: ReleaseLiveTodosIssue[] = [];
  const titleGroups = new Map<string, ReleaseLiveTodoTask[]>();
  for (const task of tasks) {
    const normalized = normalizeTodoTitle(task.title);
    const group = titleGroups.get(normalized) ?? [];
    group.push(task);
    titleGroups.set(normalized, group);
  }

  let duplicateTitleGroupCount = 0;
  for (const [title, group] of titleGroups) {
    if (group.length < 2) continue;
    duplicateTitleGroupCount += 1;
    issues.push({
      code: "live_todo_duplicate_title",
      taskId: shortTaskId(group[0].id),
      message: `live Matematica todo title "${title}" appears ${group.length} times; release snapshots must not count duplicated backlog shadows as distinct work`
    });
  }

  const placeholderTasks = tasks.filter(isPlaceholderOrForeignBacklogTask);
  for (const task of placeholderTasks) {
    issues.push({
      code: "live_todo_placeholder",
      taskId: shortTaskId(task.id),
      message: `live Matematica todo ${shortTaskId(task.id)} looks like placeholder, browser, Gmail, TUI, or synthetic backlog and must be moved out of release work or given explicit non-release rationale`
    });
  }

  const entropyScorePermille = Math.round((titleGroups.size / tasks.length) * 1000);
  if (tasks.length >= 6 && entropyScorePermille < 600) {
    issues.push({
      code: "live_todos_low_entropy",
      message: `live Matematica todos have low title diversity (${entropyScorePermille}/1000 across ${tasks.length} active tasks); release snapshots may be duplicated, truncated, or polluted`
    });
  }

  return {
    duplicateTitleGroupCount,
    placeholderTaskCount: placeholderTasks.length,
    entropyScorePermille,
    issues
  };
}

function isExplicitNonReleaseBacklog(task: ReleaseLiveTodoTask): boolean {
  const metadata = task.metadata ?? {};
  const rationale = stringValue(metadata.releaseRationale) ?? task.reason ?? "";
  return (task.tags ?? []).includes("non-release-backlog") && rationale.trim().length > 0;
}

function shortTaskId(id: string): string {
  return id.split("-")[0] ?? id;
}

function normalizeTodoTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\s*->\s+\S+$/u, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isPlaceholderOrForeignBacklogTask(task: ReleaseLiveTodoTask): boolean {
  const title = normalizeTodoTitle(task.title);
  const tags = new Set(task.tags ?? []);
  if (/^tas\d*-?\d*:/u.test(title)) return true;
  if (title === "extract pricing" || title.startsWith("extract pricing ")) return true;
  if (tags.has("browser-task") || title.includes("[browser-task]")) return true;
  if (tags.has("tui-parity") || title.includes("tui")) return true;
  if (tags.has("gmail") || title.includes("gmail")) return true;
  return false;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isMatematicaSourceProject(cwd: string): boolean {
  const packageJsonPath = join(cwd, "package.json");
  if (!existsSync(packageJsonPath)) return false;
  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { name?: unknown };
    return packageJson.name === "@hasna/matematica";
  } catch {
    return false;
  }
}
