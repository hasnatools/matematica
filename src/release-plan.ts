export type CanonicalReleasePlanTaskStatus =
  | "completed"
  | "in_progress"
  | "pending"
  | "superseded";

export type CanonicalReleasePlanTask = {
  taskId: string;
  title: string;
  priority: "critical" | "high";
  status: CanonicalReleasePlanTaskStatus;
  owner: string;
  milestoneId: string;
  requiredCheckIds: string[];
  acceptanceCriteria: string[];
  supersededBy?: string;
  supersededReason?: string;
};

export type CanonicalReleasePlan = {
  format: "matematica.canonical-release-plan";
  version: 1;
  planId: string;
  shortPlanId: string;
  packageName: "@hasna/matematica";
  repository: "hasna/matematica";
  objective: string;
  taskSource: {
    system: "todos";
    projectPath: string;
    commentPolicy: "supersede-never-delete";
  };
  releaseBlockerPolicy: {
    everyBlockerMustHaveOwner: true;
    everyBlockerMustHaveAcceptanceCriteria: true;
    everyBlockerMustMapToReleaseDoctorChecks: true;
    duplicateTaskIdsFailRelease: true;
    supersededTasksRequireReplacementAndReason: true;
  };
  releaseBlockers: CanonicalReleasePlanTask[];
};

export type CanonicalReleasePlanValidationIssue = {
  code:
    | "wrong_format"
    | "wrong_plan_id"
    | "duplicate_task_id"
    | "owner_missing"
    | "acceptance_missing"
    | "release_check_missing"
    | "milestone_missing"
    | "superseded_replacement_missing"
    | "superseded_without_replacement"
    | "superseded_without_reason"
    | "no_release_blockers";
  taskId?: string;
  message: string;
};

export type CanonicalReleasePlanValidation = {
  ok: boolean;
  blockerCount: number;
  activeBlockerCount: number;
  completedBlockerCount: number;
  supersededTaskCount: number;
  issues: CanonicalReleasePlanValidationIssue[];
};

export const CANONICAL_MATEMATICA_PLAN_ID = "62077a6e-5b78-4849-b43a-f3b6bf5a67bd";
export const CANONICAL_MATEMATICA_PLAN_SHORT_ID = "62077a6e";

export const CANONICAL_RELEASE_PLAN: CanonicalReleasePlan = {
  format: "matematica.canonical-release-plan",
  version: 1,
  planId: CANONICAL_MATEMATICA_PLAN_ID,
  shortPlanId: CANONICAL_MATEMATICA_PLAN_SHORT_ID,
  packageName: "@hasna/matematica",
  repository: "hasna/matematica",
  objective: "Fully build the Bun/TypeScript Matematica CLI for persistent, budget-governed mathematical goal runs with PFLK/GREE, saved-everything replay, BYOK providers, research provenance, verifier-backed finalization, and public OSS release gates.",
  taskSource: {
    system: "todos",
    projectPath: "platform-matematica",
    commentPolicy: "supersede-never-delete"
  },
  releaseBlockerPolicy: {
    everyBlockerMustHaveOwner: true,
    everyBlockerMustHaveAcceptanceCriteria: true,
    everyBlockerMustMapToReleaseDoctorChecks: true,
    duplicateTaskIdsFailRelease: true,
    supersededTasksRequireReplacementAndReason: true
  },
  releaseBlockers: [
    task({
      taskId: "c8e06dcb",
      title: "Define durable run and worker state machine",
      status: "completed",
      owner: "cato",
      milestoneId: "m0-local-core",
      requiredCheckIds: ["workflow-phase-release-audit", "zero-false-solved-evals"],
      acceptanceCriteria: [
        "Every run reaches at most one terminal state.",
        "goal_met cannot be reached without verifier-backed evidence.",
        "Resume, replay, cancellation, budget exhaustion, and failed states are covered by tests."
      ]
    }),
    task({
      taskId: "4d8e86ef",
      title: "Build append-only event ledger that saves every step",
      status: "completed",
      owner: "cato",
      milestoneId: "m0-local-core",
      requiredCheckIds: ["unreconciled-external-outcomes", "workflow-phase-release-audit"],
      acceptanceCriteria: [
        "Every AI, tool, verifier, source, budget, and worker action is persisted or explicitly justified.",
        "Ledger witness and artifact hash-chain audits fail closed on tampering."
      ]
    }),
    task({
      taskId: "c3a22bd0",
      title: "Implement budget manager and stop conditions",
      status: "completed",
      owner: "cato",
      milestoneId: "m0-local-core",
      requiredCheckIds: ["zero-network", "unreconciled-external-outcomes"],
      acceptanceCriteria: [
        "Budget reservations settle exactly once.",
        "Runs stop on goal_met, budget_exhausted, cancelled, failed, or needs_human_review."
      ]
    }),
    task({
      taskId: "a401f68d",
      title: "Expand budget contract beyond model spend",
      status: "completed",
      owner: "cato",
      milestoneId: "m4-swarm-scale",
      requiredCheckIds: ["unreconciled-external-outcomes", "workflow-phase-release-audit"],
      acceptanceCriteria: [
        "Budget contract covers USD, tokens, wall time, attempts, workers, artifact bytes, source queries, retries, and sandbox resources.",
        "budget_exhausted reports name the exact exhausted dimension."
      ]
    }),
    task({
      taskId: "f020dba2",
      title: "Implement worker queue leases and cancellation",
      status: "completed",
      owner: "cato",
      milestoneId: "m4-swarm-scale",
      requiredCheckIds: ["workflow-phase-release-audit", "unreconciled-external-outcomes"],
      acceptanceCriteria: [
        "Worker leases have heartbeat TTL, stale reaping, cancellation propagation, and child cleanup.",
        "Lease and budget cleanup remains exact under 100-worker contention."
      ]
    }),
    task({
      taskId: "6daa2d93",
      title: "Implement controlled parallel execution",
      status: "completed",
      owner: "cato",
      milestoneId: "m4-swarm-scale",
      requiredCheckIds: ["workflow-phase-release-audit", "milestone-gates"],
      acceptanceCriteria: [
        "PFLK/GREE branch fanout respects configured worker, provider, and budget caps.",
        "100-worker fanout is admitted only through release-gated capacity checks."
      ]
    }),
    task({
      taskId: "c7b2a697",
      title: "Add machine-wide budget and provider admission ledger",
      status: "completed",
      owner: "cato",
      milestoneId: "m4-swarm-scale",
      requiredCheckIds: ["provider-model-pricing", "provider-legal-privacy", "unreconciled-external-outcomes"],
      acceptanceCriteria: [
        "Concurrent CLI processes share machine/global/provider/daily caps.",
        "100 workers across processes cannot exceed caps under retry, crash, cancellation, or stale lease recovery."
      ]
    }),
    task({
      taskId: "1baf48f5",
      title: "Define multi-provider CLI routing contract",
      status: "completed",
      owner: "cato",
      milestoneId: "m3-provider-byok",
      requiredCheckIds: ["byok-boundary", "provider-legal-privacy", "provider-model-pricing", "hostile-live-provider-dry-run"],
      acceptanceCriteria: [
        "OpenAI, Anthropic, OpenRouter, Cerebras, and local routes are explicit and replayable.",
        "No silent fallback, missing max-call USD cap, or unredacted provider egress is allowed."
      ]
    }),
    task({
      taskId: "a9aa79bf",
      title: "Move every provider call path behind instrumented AI outbox",
      status: "completed",
      owner: "cato",
      milestoneId: "m3-provider-byok",
      requiredCheckIds: ["ai-sdk-provider-boundary-static-audit", "saved-everything-release-coverage", "unreconciled-external-outcomes"],
      acceptanceCriteria: [
        "No remote-capable generateText or streamText path can bypass the instrumented ledger/outbox boundary.",
        "Provider request, response, model metadata, usage, budget reservation, egress decision, and replay manifest are persisted before a call can influence a run."
      ]
    }),
    task({
      taskId: "33bdd555",
      title: "Add hostile provider accounting fraud suite",
      status: "completed",
      owner: "cato",
      milestoneId: "m3-provider-byok",
      requiredCheckIds: ["provider-model-pricing", "hostile-live-provider-dry-run", "unreconciled-external-outcomes", "zero-false-solved-evals"],
      acceptanceCriteria: [
        "Mock providers attack missing usage, underreported usage, over-limit usage, wrong model metadata, upstream substitution, secret-bearing streams, malformed tool calls, partial responses, retry storms, and unknown post-send outcomes.",
        "Every fraud case fails closed, debits pessimistically, or requires operator reconciliation without false goal_met or open reservations."
      ]
    }),
    task({
      taskId: "ba7da35c",
      title: "Integrate mathlib theorem search and lemma retrieval into planning",
      status: "completed",
      owner: "cato",
      milestoneId: "m2-research-security",
      requiredCheckIds: ["research-legal-privacy-citations", "workflow-phase-release-audit"],
      acceptanceCriteria: [
        "Feedback/Gather can query pinned mathlib/theorem indexes offline or from a versioned cache.",
        "Retrieved lemmas include provenance, exact statement hashes, index version, and trust grade."
      ]
    }),
    task({
      taskId: "d986cab3",
      title: "Promote research legal privacy and citation compliance to release blocker",
      status: "completed",
      owner: "cato",
      milestoneId: "m2-research-security",
      requiredCheckIds: ["research-legal-privacy-citations"],
      acceptanceCriteria: [
        "Release doctor blocks stale, hostile, ungrounded, or redistribution-unsafe arXiv/source evidence.",
        "Citation metadata is never treated as proof support for solved claims."
      ]
    }),
    task({
      taskId: "b9a12f12",
      title: "Create tiered math benchmark suite",
      priority: "high",
      status: "completed",
      owner: "octavia",
      milestoneId: "m5-public-release",
      requiredCheckIds: ["zero-false-solved-evals", "milestone-gates"],
      acceptanceCriteria: [
        "Benchmark tiers cover arithmetic, symbolic, olympiad, undergraduate theorem proving, mathlib-adjacent lemmas, recent theorem restatements, false/impossible goals, and open-ended research prompts.",
        "Eval output reports capability by tier, evidence grade, and public-release promotion threshold."
      ]
    }),
    task({
      taskId: "a2fb51b7",
      title: "Run hidden hostile evals as clean CLI replays",
      status: "completed",
      owner: "cato",
      milestoneId: "m5-public-release",
      requiredCheckIds: ["zero-false-solved-evals", "public-claim-language-guardrail"],
      acceptanceCriteria: [
        "Hidden hostile fixtures run real clean MATEMATICA_HOME CLI goals and offline replays.",
        "False-solved rate is exactly zero and every solved claim has verifier-backed clean replay evidence."
      ]
    }),
    task({
      taskId: "3c5f744c",
      title: "Make PFLK/GREE progression measurable and release-gated",
      status: "completed",
      owner: "cato",
      milestoneId: "m4-swarm-scale",
      requiredCheckIds: ["workflow-phase-release-audit", "saved-everything-release-coverage", "zero-false-solved-evals"],
      acceptanceCriteria: [
        "Every cycle persists what changed from the previous cycle, why branches were promoted or pruned, and how Feedback/Gather alters Loophole/Experiment prompts.",
        "Knowledge/Evolve suppresses repeated low-value branches and release fixtures fail if phase outputs do not influence subsequent cycles."
      ]
    }),
    task({
      taskId: "9b7f1963",
      title: "Gate release on zero false-solved hidden hostile evals",
      status: "completed",
      owner: "cato",
      milestoneId: "m5-public-release",
      requiredCheckIds: ["zero-false-solved-evals"],
      acceptanceCriteria: [
        "Release doctor exposes hostile false-solved metrics.",
        "Provider worker false-solved corpus is rejected by finalization and offline solved-claim checks."
      ]
    }),
    task({
      taskId: "7eb5850f",
      title: "Add public claim-language guardrail",
      status: "completed",
      owner: "cato",
      milestoneId: "m5-public-release",
      requiredCheckIds: ["public-claim-language-guardrail"],
      acceptanceCriteria: [
        "Public surfaces cannot market weak, conjectural, budget-exhausted, or open-problem progress as solved.",
        "Erdos/open-problem terminal surfaces snapshot as non-solved with progress context."
      ]
    }),
    task({
      taskId: "c6a03f04",
      title: "Map public claims to release-blocking checks",
      status: "completed",
      owner: "cato",
      milestoneId: "m5-public-release",
      requiredCheckIds: ["public-claims-release-matrix"],
      acceptanceCriteria: [
        "Every public README/CLI claim maps to concrete release-doctor checks.",
        "Missing or failing mapped checks fail release."
      ]
    }),
    task({
      taskId: "21a0604c",
      title: "Extend public claims audit to package metadata docs and examples",
      status: "completed",
      owner: "cato",
      milestoneId: "m5-public-release",
      requiredCheckIds: ["public-claims-surface-audit", "public-claims-release-matrix"],
      acceptanceCriteria: [
        "Package metadata, NOTICE, docs, examples, CLI help, and benchmark copy are scanned for unsupported claims.",
        "Packed OSS releases include public docs needed for claim audit."
      ]
    }),
    task({
      taskId: "9a35cdba",
      title: "Add packed OSS install acceptance gate",
      status: "completed",
      owner: "cato",
      milestoneId: "m5-public-release",
      requiredCheckIds: ["package-metadata", "package-files", "zero-network", "public-claims-surface-audit"],
      acceptanceCriteria: [
        "bun pack installs in a clean temp home with no provider keys and network disabled.",
        "doctor, local solve, report, audit, and offline replay pass without private paths, secrets, or internal packages."
      ]
    }),
    task({
      taskId: "031a8206",
      title: "Back proof certificates with clean-home offline replay",
      status: "completed",
      owner: "cato",
      milestoneId: "m1-replay-verifier",
      requiredCheckIds: ["zero-false-solved-evals"],
      acceptanceCriteria: [
        "Proof certificates bind clean-home replay transcripts and supporting artifact hashes.",
        "Finalization rejects simulated, missing, drifted, or private-path replay evidence."
      ]
    }),
    task({
      taskId: "42d5b68c",
      title: "Block release on unreconciled external unknown outcomes",
      status: "completed",
      owner: "cato",
      milestoneId: "m1-replay-verifier",
      requiredCheckIds: ["unreconciled-external-outcomes"],
      acceptanceCriteria: [
        "Provider, source, verifier, tool, and sandbox unknown outcomes require operator reconciliation before release.",
        "Open external reservations fail zero-network and BYOK readiness."
      ]
    }),
    task({
      taskId: "a219e0dc",
      title: "Register canonical Matematica plan in plan registry and release doctor",
      status: "completed",
      owner: "cato",
      milestoneId: "m5-public-release",
      requiredCheckIds: ["canonical-release-plan"],
      acceptanceCriteria: [
        "A single canonical Matematica release plan is discoverable from the CLI and package exports.",
        "Release doctor fails on duplicate, ownerless, acceptance-free, unmapped, or invalid release blockers."
      ]
    }),
    task({
      taskId: "9d269c14",
      title: "Create canonical release-critical path and archive stale plan tasks",
      status: "completed",
      owner: "cato",
      milestoneId: "m5-public-release",
      requiredCheckIds: ["shared-implementation-plan-registry", "canonical-release-plan", "milestone-gates"],
      acceptanceCriteria: [
        "Every Matematica release blocker is marked blocker/non-blocker, dependency, owner, and release milestone.",
        "Duplicate or obsolete tasks are commented as superseded, never deleted."
      ]
    }),
    task({
      taskId: "a3b795e3",
      title: "Add shared implementation-plan registry publication gate",
      status: "completed",
      owner: "cato",
      milestoneId: "m5-public-release",
      requiredCheckIds: ["shared-implementation-plan-registry", "canonical-release-plan", "milestone-gates"],
      acceptanceCriteria: [
        "The canonical Matematica plan is published or mirrored into the shared implementation-plan registry.",
        "Release doctor fails if the shared registry is empty, has multiple canonical Matematica plans, or diverges from CLI/export/todos task IDs."
      ]
    }),
    task({
      taskId: "451a787f",
      title: "Add all-step persistence release coverage gate",
      status: "completed",
      owner: "cato",
      milestoneId: "m5-public-release",
      requiredCheckIds: ["saved-everything-release-coverage", "workflow-phase-release-audit", "unreconciled-external-outcomes", "zero-false-solved-evals"],
      acceptanceCriteria: [
        "Release doctor proves every AI call, tool action, research/source fetch, verifier attempt, workflow transition, budget debit, retry/error, provider operation, and final claim has durable ledger events.",
        "Every persisted action links to replay-visible artifacts or an explicit non-persistence justification."
      ]
    }),
    task({
      taskId: "04362083",
      title: "Add release evidence freshness and supersession audit",
      status: "completed",
      owner: "cato",
      milestoneId: "m5-public-release",
      requiredCheckIds: ["release-evidence-freshness", "canonical-release-plan", "public-claims-release-matrix"],
      acceptanceCriteria: [
        "Completed release blockers link to verification evidence produced after relevant code, docs, public-surface, or plan changes.",
        "Stale evidence and superseded tasks without replacement IDs or comment history fail release."
      ]
    }),
    task({
      taskId: "fc3b3129",
      title: "Add AI SDK provider-boundary static import audit",
      status: "completed",
      owner: "cato",
      milestoneId: "m3-provider-byok",
      requiredCheckIds: ["ai-sdk-provider-boundary-static-audit", "ai-sdk-compatibility", "provider-legal-privacy", "provider-model-pricing", "hostile-live-provider-dry-run"],
      acceptanceCriteria: [
        "Direct provider SDK/model calls outside approved adapters fail release.",
        "OpenAI, Anthropic, OpenRouter, and Cerebras routes go through the instrumented AI SDK boundary and record requested versus observed provider, model, and usage."
      ]
    }),
    task({
      taskId: "e89c566b",
      title: "Prepare release workflow",
      status: "completed",
      owner: "cato",
      milestoneId: "m5-public-release",
      requiredCheckIds: ["package-metadata", "package-files", "canonical-release-plan", "public-claims-release-matrix"],
      acceptanceCriteria: [
        "One release workflow runs typecheck, full tests, packed install, zero-network local solve/report/audit/replay, mocked BYOK, hostile evals, claims audit, license scan, secret scan, and privacy scan.",
        "Any failing release gate blocks publish."
      ]
    }),
    task({
      taskId: "fe8ff7dc",
      title: "Require independent adversarial quorum for release-critical plan changes",
      status: "completed",
      owner: "cato",
      milestoneId: "m5-public-release",
      requiredCheckIds: ["adversarial-plan-change-review", "canonical-release-plan"],
      acceptanceCriteria: [
        "Material release-blocking plan changes require reviewers with different provider/model family, prompt lineage, and execution root.",
        "Release doctor fails release approval when only degraded-capacity reviews exist unless release-owner risk acceptance is explicit, scoped, expiring, and rollback-backed."
      ]
    }),
    task({
      taskId: "b685adb5",
      title: "Make live todos entropy fail release check",
      status: "completed",
      owner: "cato",
      milestoneId: "m5-public-release",
      requiredCheckIds: ["canonical-release-plan", "shared-implementation-plan-registry"],
      acceptanceCriteria: [
        "Release readiness comes from a schema-valid canonical Matematica live-todos snapshot, not stale static registries, polluted backlog, truncated output, or empty injected fixtures.",
        "Pending or in-progress critical plan tasks missing from canonical release blockers fail release with actionable errors."
      ]
    }),
    task({
      taskId: "7202cb8f",
      title: "Add full-fidelity redacted and verifier-only replay trust labels",
      status: "completed",
      owner: "cato",
      milestoneId: "m1-replay-verifier",
      requiredCheckIds: ["saved-everything-release-coverage", "public-claims-surface-audit", "public-claim-language-guardrail"],
      acceptanceCriteria: [
        "Reports and replay manifests distinguish full-local-forensic replay, redacted-public replay, and verifier-only replay.",
        "Proof claims cannot depend on unreplayable model text, redacted provider responses, or redacted source text."
      ]
    }),
    task({
      taskId: "a89287a7",
      title: "Gate formal proof claims on clean-home Lean mathlib TCB replay",
      status: "completed",
      owner: "cato",
      milestoneId: "m1-replay-verifier",
      requiredCheckIds: ["zero-false-solved-evals", "workflow-phase-release-audit"],
      acceptanceCriteria: [
        "goal_met from formal_proof requires pinned Lean binary, Lake/mathlib revision, theorem statement hash, proof file hash, verifier command, sandbox/network policy, exact exit result, and clean MATEMATICA_HOME replay.",
        "Changing informal problem, formal statement, verifier environment, or proof file invalidates the proof claim."
      ]
    }),
    task({
      taskId: "a8c85969",
      title: "Add remote dispatch outbox dead-letter handling and unknown-outcome settlement",
      status: "completed",
      owner: "cato",
      milestoneId: "m3-provider-byok",
      requiredCheckIds: ["unreconciled-external-outcomes", "workflow-phase-release-audit"],
      acceptanceCriteria: [
        "Remote dispatch operations that time out, crash, or lose acknowledgements land in a durable dead-letter state.",
        "Unknown provider outcomes retain pessimistic budget reservations and require operator reconciliation before release readiness."
      ]
    }),
    task({
      taskId: "a976b9a0",
      title: "Add model catalog freshness gate",
      status: "completed",
      owner: "cato",
      milestoneId: "m3-provider-byok",
      requiredCheckIds: ["external-freshness-snapshots", "provider-model-pricing"],
      acceptanceCriteria: [
        "Provider model catalogs have timestamped freshness metadata and stale snapshots fail release.",
        "Unavailable refresh data downgrades remote provider readiness without silently using unknown model capabilities."
      ]
    }),
    task({
      taskId: "29e25612",
      title: "Reject provider pricing drift during active runs",
      status: "completed",
      owner: "cato",
      milestoneId: "m3-provider-byok",
      requiredCheckIds: ["provider-model-pricing", "unreconciled-external-outcomes"],
      acceptanceCriteria: [
        "Active runs bind pricing metadata versions used for admission and settlement.",
        "Detected pricing drift fails closed or requires explicit operator reconciliation before any solved claim or release readiness."
      ]
    }),
    task({
      taskId: "21e3177e",
      title: "Add provider model catalog refresh and compatibility checks",
      status: "completed",
      owner: "cato",
      milestoneId: "m3-provider-byok",
      requiredCheckIds: ["ai-sdk-compatibility", "provider-legal-privacy", "provider-model-pricing"],
      acceptanceCriteria: [
        "OpenAI, Anthropic, OpenRouter, Cerebras, and local model catalogs refresh into versioned compatibility metadata.",
        "Provider routing rejects models that lack required capabilities, pricing, privacy policy, or AI SDK adapter support."
      ]
    }),
    task({
      taskId: "2e00f370",
      title: "Add provider route smoke matrix for AI SDK adapters",
      status: "completed",
      owner: "cato",
      milestoneId: "m3-provider-byok",
      requiredCheckIds: [
        "ai-sdk-compatibility",
        "ai-sdk-provider-boundary-static-audit",
        "provider-model-pricing",
        "provider-legal-privacy",
        "provider-route-smoke-matrix",
        "hostile-live-provider-dry-run"
      ],
      acceptanceCriteria: [
        "Mocked free OSS route smokes cover OpenAI, Anthropic, OpenRouter, Cerebras, and local OpenAI-compatible routes without paid provider calls.",
        "Each route smoke verifies requested versus observed provider/model lineage, provider-specific options, tool calling, structured output, abort/timeout behavior, usage/cost metadata, redaction, replay artifacts, and OpenRouter upstream provenance.",
        "Remote swarm readiness remains blocked until opt-in BYOK live dry-run evidence is fresh."
      ]
    }),
    task({
      taskId: "0d26e615",
      title: "Define milestone release gates before swarm scale",
      status: "completed",
      owner: "cato",
      milestoneId: "m4-swarm-scale",
      requiredCheckIds: ["milestone-gates"],
      acceptanceCriteria: [
        "Release doctor exposes separate free-local-v0 and remote-swarm release readiness booleans.",
        "Free local v0 readiness requires zero-network, package, public wording, false-solved, canonical-plan, evidence-freshness, and milestone gates.",
        "Remote swarm release readiness remains false until opt-in live BYOK hostile dry-run and remote provider diversity gates pass.",
        "Swarm-scale work is blocked behind ordered release milestones with named gates, required commands, owner-visible readiness, and fresh command evidence."
      ]
    }),
    task({
      taskId: "18bf46d9",
      title: "Add immutable run snapshots and deterministic report provenance",
      status: "completed",
      owner: "cato",
      milestoneId: "m1-replay-verifier",
      requiredCheckIds: ["saved-everything-release-coverage", "workflow-phase-release-audit"],
      acceptanceCriteria: [
        "Report generation persists an immutable run snapshot artifact before report.generated.",
        "The snapshot binds source event range, ledger head hash, event count, artifact manifest, external-operation and budget-settlement summary, replay mode, report input hash, report hash, and regenerated=false.",
        "Audit and replay fail when report.generated lacks snapshot/report artifact links or when source events, source artifacts, snapshot hash, report input hash, or report content drift."
      ]
    }),
    task({
      taskId: "5bc128e2",
      title: "Use content-addressed artifact storage",
      status: "completed",
      owner: "cato",
      milestoneId: "m1-replay-verifier",
      requiredCheckIds: ["saved-everything-release-coverage", "workflow-phase-release-audit"],
      acceptanceCriteria: [
        "Artifacts are addressed by content hash and deduplicated without weakening replay evidence.",
        "Hash mismatches, missing blobs, or mutable artifact paths fail replay and release coverage."
      ]
    }),
    task({
      taskId: "9c518524",
      title: "Add ledger integrity schema versioning and compaction",
      status: "completed",
      owner: "cato",
      milestoneId: "m1-replay-verifier",
      requiredCheckIds: ["saved-everything-release-coverage", "unreconciled-external-outcomes"],
      acceptanceCriteria: [
        "Ledger schema versions and migrations are explicit, replayable, and fail closed on unknown future versions.",
        "Compaction preserves event hash-chain integrity, external outcome reconciliation, and saved-everything coverage."
      ]
    }),
    task({
      taskId: "29bd3e36",
      title: "Synchronize canonical release registry with live Matematica blockers before release checks can pass",
      status: "completed",
      owner: "cato",
      milestoneId: "m5-public-release",
      requiredCheckIds: ["canonical-release-plan", "shared-implementation-plan-registry"],
      acceptanceCriteria: [
        "The canonical release plan, shared registry mirror, release doctor output, and live Matematica todos snapshot agree on every current critical release blocker.",
        "Missing, stale, truncated, malformed, spoofed, or untrusted live todo data fails release readiness with actionable errors."
      ]
    }),
    task({
      taskId: "3be841bf",
      title: "Create benchmark and eval suite",
      status: "superseded",
      owner: "octavia",
      milestoneId: "m5-public-release",
      requiredCheckIds: ["zero-false-solved-evals"],
      acceptanceCriteria: [
        "Superseded into tiered hard-math benchmark and hidden hostile clean replay gates."
      ],
      supersededBy: "b9a12f12,a2fb51b7",
      supersededReason: "Adversarial review found duplicate benchmark/eval suite tasks; keep task for history and do not delete."
    }),
    task({
      taskId: "bbdd53b9",
      title: "Add OSS licensing citation and source-cache hygiene",
      status: "superseded",
      owner: "octavia",
      milestoneId: "m2-research-security",
      requiredCheckIds: ["research-legal-privacy-citations"],
      acceptanceCriteria: [
        "Superseded by critical research legal/privacy/citation release blocker."
      ],
      supersededBy: "d986cab3",
      supersededReason: "Adversarial review promoted this medium hygiene work into a release-critical blocker."
    })
  ]
};

export function validateCanonicalReleasePlan(input: {
  plan?: CanonicalReleasePlan;
  releaseCheckIds?: string[];
  milestoneIds?: string[];
} = {}): CanonicalReleasePlanValidation {
  const plan = input.plan ?? CANONICAL_RELEASE_PLAN;
  const releaseCheckIds = new Set(input.releaseCheckIds ?? []);
  const milestoneIds = new Set(input.milestoneIds ?? []);
  const issues: CanonicalReleasePlanValidationIssue[] = [];
  const seenTaskIds = new Set<string>();

  if (plan.format !== "matematica.canonical-release-plan" || plan.version !== 1) {
    issues.push({
      code: "wrong_format",
      message: "canonical release plan must use matematica.canonical-release-plan v1"
    });
  }
  if (plan.planId !== CANONICAL_MATEMATICA_PLAN_ID || plan.shortPlanId !== CANONICAL_MATEMATICA_PLAN_SHORT_ID) {
    issues.push({
      code: "wrong_plan_id",
      message: `canonical release plan must use ${CANONICAL_MATEMATICA_PLAN_ID}`
    });
  }
  if (plan.releaseBlockers.length === 0) {
    issues.push({
      code: "no_release_blockers",
      message: "canonical release plan has no release blockers"
    });
  }

  for (const blocker of plan.releaseBlockers) {
    if (seenTaskIds.has(blocker.taskId)) {
      issues.push({
        code: "duplicate_task_id",
        taskId: blocker.taskId,
        message: `duplicate release blocker task id ${blocker.taskId}`
      });
    }
    seenTaskIds.add(blocker.taskId);

    if (!blocker.owner.trim()) {
      issues.push({
        code: "owner_missing",
        taskId: blocker.taskId,
        message: `release blocker ${blocker.taskId} has no owner`
      });
    }
    if (blocker.acceptanceCriteria.length === 0 || blocker.acceptanceCriteria.some((item) => !item.trim())) {
      issues.push({
        code: "acceptance_missing",
        taskId: blocker.taskId,
        message: `release blocker ${blocker.taskId} has no acceptance criteria`
      });
    }
    if (blocker.requiredCheckIds.length === 0) {
      issues.push({
        code: "release_check_missing",
        taskId: blocker.taskId,
        message: `release blocker ${blocker.taskId} maps to no release-doctor checks`
      });
    }
    for (const checkId of blocker.requiredCheckIds) {
      if (releaseCheckIds.size > 0 && !releaseCheckIds.has(checkId)) {
        issues.push({
          code: "release_check_missing",
          taskId: blocker.taskId,
          message: `release blocker ${blocker.taskId} maps to missing release-doctor check ${checkId}`
        });
      }
    }
    if (milestoneIds.size > 0 && !milestoneIds.has(blocker.milestoneId)) {
      issues.push({
        code: "milestone_missing",
        taskId: blocker.taskId,
        message: `release blocker ${blocker.taskId} maps to missing milestone ${blocker.milestoneId}`
      });
    }
    if (blocker.status === "superseded" && !blocker.supersededBy) {
      issues.push({
        code: "superseded_without_replacement",
        taskId: blocker.taskId,
        message: `superseded blocker ${blocker.taskId} has no replacement task id`
      });
    }
    if (blocker.status === "superseded" && !blocker.supersededReason) {
      issues.push({
        code: "superseded_without_reason",
        taskId: blocker.taskId,
        message: `superseded blocker ${blocker.taskId} has no supersession reason`
      });
    }
  }

  for (const blocker of plan.releaseBlockers) {
    if (blocker.status !== "superseded" || !blocker.supersededBy) continue;
    for (const replacementId of blocker.supersededBy.split(",").map((item) => item.trim()).filter(Boolean)) {
      if (!seenTaskIds.has(replacementId)) {
        issues.push({
          code: "superseded_replacement_missing",
          taskId: blocker.taskId,
          message: `superseded blocker ${blocker.taskId} points to missing replacement task ${replacementId}`
        });
      }
    }
  }

  return {
    ok: issues.length === 0,
    blockerCount: plan.releaseBlockers.length,
    activeBlockerCount: plan.releaseBlockers.filter((blocker) => blocker.status !== "superseded").length,
    completedBlockerCount: plan.releaseBlockers.filter((blocker) => blocker.status === "completed").length,
    supersededTaskCount: plan.releaseBlockers.filter((blocker) => blocker.status === "superseded").length,
    issues
  };
}

export function formatCanonicalReleasePlan(plan: CanonicalReleasePlan = CANONICAL_RELEASE_PLAN): string {
  const lines = [
    "Matematica canonical release plan",
    `Plan: ${plan.shortPlanId} (${plan.planId})`,
    `Package: ${plan.packageName}`,
    `Repository: ${plan.repository}`,
    `Objective: ${plan.objective}`,
    `Task source: ${plan.taskSource.system} ${plan.taskSource.projectPath}`,
    `Release blockers: ${plan.releaseBlockers.length}`,
    ""
  ];
  for (const blocker of plan.releaseBlockers) {
    lines.push(`- ${blocker.taskId} [${blocker.status}] ${blocker.title}`);
    lines.push(`  owner=${blocker.owner} priority=${blocker.priority} milestone=${blocker.milestoneId}`);
    lines.push(`  checks=${blocker.requiredCheckIds.join(",")}`);
    if (blocker.status === "superseded") {
      lines.push(`  supersededBy=${blocker.supersededBy ?? "missing"} reason=${blocker.supersededReason ?? "missing"}`);
    }
  }
  return lines.join("\n");
}

function task(
  input: Omit<CanonicalReleasePlanTask, "priority"> & Partial<Pick<CanonicalReleasePlanTask, "priority">>
): CanonicalReleasePlanTask {
  return {
    priority: "critical",
    ...input
  };
}
