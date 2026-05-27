# Matematica Operator Runbook

This runbook is for operators running the open-source `matematica` CLI from a
clean Bun install. It covers the free local baseline and optional BYOK remote
provider mode. The CLI does not include hosted compute, bundled credits,
provider accounts, telemetry, or private infrastructure.

## 1. Clean Local Baseline

Use a fresh home directory and clear remote provider keys when validating the
free mode:

```bash
export MATEMATICA_HOME="$(mktemp -d)"
export MATEMATICA_LOCAL_ONLY=true
unset OPENAI_API_KEY ANTHROPIC_API_KEY OPENROUTER_API_KEY CEREBRAS_API_KEY
bun run matematica doctor
```

In this mode the CLI performs deterministic local work, cached research replay,
reports, audits, and offline replay. It does not make live arXiv requests or
remote model calls unless network access is explicitly enabled and the relevant
provider gates pass.

## 2. Local Solve Smoke

Run a bounded known-local problem first:

```bash
bun run matematica solve --problem "Prove 1 + 1 = 2" --goal "Find verified computation" --budget-usd 0 --max-attempts 4 --workers 1
```

For hard or open problems, expect honest progress or budget exhaustion unless a
formal proof or verified counterexample is produced:

```bash
bun run matematica solve --problem "Prove the Collatz conjecture." --goal "Find a formal proof or verified counterexample" --budget-usd 0 --max-attempts 1 --workers 1
```

Exit code `0` means the goal run reached a verifier-backed terminal success.
Exit code `2` means the budget was exhausted without a solved claim.

## 3. Inspect, Report, Replay, And Resume

Every run should be inspected from persisted state:

```bash
RUN_ID="<run-id>"
bun run matematica goal watch "$RUN_ID" --json
bun run matematica goal report "$RUN_ID"
bun run matematica goal audit "$RUN_ID" --saved-everything
bun run matematica goal replay "$RUN_ID" --offline --verify-final
bun run matematica goal resume "$RUN_ID" --offline
```

`goal watch` shows phase, worker, budget, warning, and terminal status.
`goal report` states the evidence grade and whether the run can claim solved.
`goal audit --saved-everything` checks ledger and artifact coverage. Offline
replay must not call arXiv, provider APIs, or verifier services. Artifact
evidence is addressed by immutable `sha256:<hash>` content addresses with media
type, storage key, and ledger provenance metadata; audit should fail on any
artifact hash or metadata drift.

## 4. Cancel And Recover

Cancel queued or active local work with:

```bash
bun run matematica goal stop "$RUN_ID"
bun run matematica goal resume-workers "$RUN_ID"
```

Terminal runs are immutable by default. `goal resume "$RUN_ID"` preserves
terminal states. Use `--reopen-terminal` only after an operator intentionally
decides to continue a cancelled, failed, or budget-exhausted run.

## 5. Replay Export, Archive, And Retention

Portable exports are redacted by default:

```bash
bun run matematica goal replay "$RUN_ID" --export run.bundle.json --redacted-export
bun run matematica goal replay "$RUN_ID" --archive run.bundle.json.gz --redacted-export
bun run matematica goal replay --import run.bundle.json.gz
```

The portable bundle omits raw provider responses, raw prompts, raw source text,
and private machine paths. Archives are gzip-compressed portable bundles.

Prune stale research caches without deleting the ledger or run artifacts:

```bash
bun run matematica storage prune-caches --older-than-hours 168 --dry-run
bun run matematica storage prune-caches --older-than-hours 168 --run-id "$RUN_ID"
bun run matematica storage maintenance --run-id "$RUN_ID"
```

When `--run-id` is supplied, the CLI records a retention evidence event for the
run. The maintenance command records a ledger maintenance snapshot with the
schema version, required query indexes, WAL checkpoint policy, retention policy,
and VACUUM guidance. Deleting `MATEMATICA_HOME` is the operator-controlled way
to remove the local ledger and redacted artifacts.

## 6. BYOK Remote Provider Mode

Remote providers are optional and require the operator's own keys and explicit
cost consent. Configure only the providers you intend to use:

```bash
export MATEMATICA_HOME="$(mktemp -d)"
unset MATEMATICA_LOCAL_ONLY
export OPENAI_API_KEY="<provider-key>"
export ANTHROPIC_API_KEY="<provider-key>"
export OPENROUTER_API_KEY="<provider-key>"
export CEREBRAS_API_KEY="<provider-key>"
bun run matematica providers list --json
```

Before a remote run, review the admission envelope:

```bash
bun run matematica goal create --problem "Bound a finite search" --goal "Find verifier-backed evidence" --max-attempts 4 --workers 2
RUN_ID="<run-id>"
bun run matematica goal admission "$RUN_ID" --allow-network --provider-routes "openai:<model-id>;anthropic:<model-id>" --max-call-usd 0.02 --max-output-tokens 512 --provider-concurrency 1 --i-understand-remote-costs --yes
bun run matematica goal run "$RUN_ID" --allow-network --provider-routes "openai:<model-id>;anthropic:<model-id>" --max-call-usd 0.02 --max-output-tokens 512 --provider-concurrency 1 --i-understand-remote-costs --yes
```

Remote calls are refused without an explicit network flag, provider allowlist,
per-call USD cap, output-token cap, BYOK cost consent, and ledgered admission
evidence. Silent provider fallback is not allowed.

## 7. arXiv Research Compliance

Live arXiv access is opt-in:

```bash
bun run matematica research arxiv --query "all:finite search proof" --allow-network --include-abstracts
```

Offline and local-only modes use cached metadata only. arXiv source and PDF
payloads are not exported without a separate license grant path. Retrieved
source text is untrusted input and cannot change provider, budget, verifier, or
success policy.

## 8. Lean And Verifier Setup

Matematica can use local Lean tooling when installed. Point the CLI at explicit
binaries for diagnostics:

```bash
bun run matematica doctor --lean-bin lean --lake-bin lake --elan-bin elan
bun run matematica goal verify-lean "$RUN_ID" --file proof.lean --project-root .
```

Verifier-backed proof claims require persisted verifier artifacts, exact
statement-equivalence review, and replayable proof-obligation evidence.

## 9. Evidence Grades And Claim Discipline

Final reports use evidence grades such as `formal_proof`,
`computational_evidence`, `counterexample`, `conjectural_progress`, and
`budget_exhausted`. Model agreement, provider-written proof text, citations, or
worker confidence cannot by themselves satisfy a mathematical goal.

For open problems, verified computation is useful progress but not a theorem
proof. A solved theorem claim requires a trusted verifier-backed proof or a
verified counterexample under the run's success contract.

## 10. Release Readiness Smoke

Before publishing or distributing a build, run:

```bash
MATEMATICA_RELEASE_TODOS_SNAPSHOT_JSON='{"format":"matematica.release-live-todos","version":1,"source":"operator-runbook-smoke","tasks":[]}' bun run matematica doctor --release --json
bun run matematica release check
```

Use a clean home and scrub provider keys for the zero-network release doctor
smoke. Do not set `MATEMATICA_LOCAL_ONLY=true` around `release check`; the full
workflow includes tests that exercise remote-admission refusal paths.
