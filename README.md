# Matematica

Matematica is a Bun and TypeScript CLI for long-running mathematical goal runs.

The core invariant is simple: every AI action and every deterministic action is
persisted before the run can move on. A run stops only when the goal is met,
the budget is exhausted, it is cancelled, or it fails.

## Current v0

This repository currently contains the local foundation:

- Bun + TypeScript CLI scaffold
- SQLite append-only ledger
- content-addressed artifact store
- goal lifecycle and budget stop conditions
- deterministic local run loop
- replay, status, report, and doctor commands

Provider-backed AI SDK workers, Lean verification, arXiv ingestion, and swarm
fanout are layered on top of this ledger. The project is implemented with Bun
and TypeScript and the CLI is the primary product surface.

## Security And Privacy

Matematica is BYOK and local-ledger first. Secrets are read from the operator
environment, redacted before persistence, and never written intentionally to the
SQLite ledger, artifacts, replay output, reports, or provider summaries.

Artifacts are stored on the local filesystem under `MATEMATICA_HOME` unless the
operator chooses a different local home directory. Replay manifests record that
artifact storage is local and that redaction is enabled.

The CLI is free and open source. It does not include bundled model credits,
hosted compute, API keys, or provider accounts. Remote model calls are BYOK:
the operator supplies provider keys through environment variables such as
`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, and
`CEREBRAS_API_KEY`. Any remote usage is charged by that provider to the
operator's account.

Remote provider use is explicit: a run only sends model prompts to a remote API
when the operator selects a remote provider such as `--provider openai`. Every
remote provider call requires `--max-call-usd`, an explicit pessimistic per-call
USD cap. If a provider omits cost metadata, Matematica settles the call at that
operator cap instead of treating it as free. Every remote run records a
`remote.cost.preflight` event before model dispatch with the provider, model,
worker count, BYOK status, bundled-compute status, available budget caps, and an
upper-bound estimate from `--max-call-usd`. Multi-worker remote fanout is
refused unless the operator passes `--i-understand-remote-costs`. This prevents
default commands from accidentally launching paid 100-worker runs.
`--allow-remote-costs` is accepted as an equivalent shorter alias.

The remote compute admission gate is run-scoped and sits before the external
operation outbox. Remote AI calls must have a persisted consent artifact, a
provider allowlist match, a model id, a remote network mode, and a hard budget
cap before the provider request artifact or provider call can be created.

Provider egress is firewalled before the AI SDK call. Only the model handle,
sanitized prompt, selected generation settings, abort signal, timeout, and step
callback are allowed to leave the process. Secret-looking values and local
filesystem paths are redacted from the provider-bound prompt, and ledger
internals such as SQLite tables or database paths block the call before the
external-operation outbox is opened. Each remote call records a
`provider.egress.checked` event.

Provider smoke checks without `--run-id` are refused for every provider,
including local OpenAI-compatible endpoints. Use `--run-id` so the smoke call,
remote compute consent when applicable, budget preflight, request, response,
usage, provider metadata, and replay manifest are persisted in the run ledger
and artifact store.

The free baseline works with zero API keys and zero network by default. Without
provider configuration or an explicit `--allow-network`/`--online` flag,
Matematica can still create and run goals, persist every step, perform
deterministic local work, use cached research metadata, generate reports,
audit/replay runs, and invoke local proof-checker tooling when installed.

Use `--allow-network` on research and goal run/resume commands to permit
network-backed arXiv/source access. Use `--offline` or set
`MATEMATICA_LOCAL_ONLY=true` to reject remote network calls even when provider
flags are present. Local-only mode allows only deterministic local work plus any
configured local OpenAI-compatible endpoint; it does not fetch remote model help
or provide hidden hosted compute. Every remote model call emits a
`privacy.remote_provider.used` ledger event tied to the persisted redacted
request artifact.

In default/offline/local-only mode, arXiv research does not call fetchers, PDF
URLs, provider metadata, model catalogs, telemetry, or any other network
endpoint. If no cached metadata exists, the run records a
`source.offline_cache.missed` event and proceeds with empty research evidence;
cache hits record `source.offline_cache.used`.

Retrieved source text is untrusted data. It is quarantined before prompt use and
cannot change tool, provider, budget, verifier, or success policy.

### Private Artifacts, Retention, And Export

The local ledger keeps the complete run structure, but artifact bytes are
redacted before local persistence. Raw prompt text, raw provider responses, raw
source text, provider keys, environment-derived secrets, and private filesystem
paths are not intentionally persisted as raw artifact content. Artifact
provenance records both the raw-content hash and the redacted-content hash so a
local audit can prove redaction happened without exporting the raw payload.

Local redacted artifacts are retained under `MATEMATICA_HOME` until the
operator prunes that home directory or deletes it. Artifact rows carry immutable
`sha256:<hash>` content addresses, media types, storage keys, and provenance
that links the artifact row to its `artifact.created` ledger event; audit fails
if those fields drift. Portable replay exports are separate operator-managed
files. They default to a redacted portable bundle: artifact references are
content-addressed as `sha256:<hash>` and materialized under
`artifacts/<run-id>/<sha256>.txt`, local machine paths are replaced with
`<redacted-path>`, and raw provider/source text is excluded. arXiv PDF/source
payload artifacts are refused by portable export unless a future explicit
license grant path is added.

Goal reports include the privacy policy used for the run, relative local
artifact bundle paths, and booleans that state whether raw provider or source
text is included. The default is `false`; exporting raw payloads would require a
separate explicit consent mode and is not part of the portable OSS export path.

For long-running local homes, operators can create a compressed redacted archive
with `matematica goal replay <run-id> --archive run.bundle.json.gz
--redacted-export`. The archive is a gzip-compressed portable replay bundle and
can be imported with `matematica goal replay --import run.bundle.json.gz` in a
clean `MATEMATICA_HOME`. Research caches can be pruned without deleting ledger
events or run artifacts by running `matematica storage prune-caches
--older-than-hours <hours>`. Pass `--run-id <run-id>` to ledger the pruning
summary as retention evidence for a specific run. `matematica storage
maintenance --run-id <run-id>` saves the schema/index/WAL checkpoint snapshot
and operator VACUUM guidance as run evidence.

## Free Open-Source Release Boundary

The public package name is `@hasna/matematica`, the CLI command is
`matematica`, and the public repository is `hasnatools/matematica`. The package is
MIT licensed and ships `LICENSE` and `NOTICE` files.

The npm package is self-contained source for the Bun CLI. It does not depend on
private scoped packages, private machine paths, hosted Hasna services, bundled
credits, or internal infrastructure. A clean install with zero provider keys and
zero network permissions can run `matematica doctor`, create local runs, execute
deterministic local workers, report, audit, and replay persisted state.

Remote AI providers are optional BYOK integrations. The operator must configure
their own provider keys, choose a provider, and pass explicit cost caps before a
remote call can be dispatched.

### Free OSS Zero-Network Smoke

These commands are the public acceptance smoke for the free local package. Run
them from a clean install directory with a fresh `MATEMATICA_HOME`, no provider
keys, and local-only mode enabled:

For the full operator procedure, including BYOK admission, arXiv compliance,
Lean setup, cancellation, replay archives, cache pruning, and evidence-grade
claim rules, see [docs/operator-runbook.md](docs/operator-runbook.md).

```bash
export MATEMATICA_HOME="$(mktemp -d)"
export MATEMATICA_LOCAL_ONLY=true
unset OPENAI_API_KEY ANTHROPIC_API_KEY OPENROUTER_API_KEY CEREBRAS_API_KEY

bun run matematica doctor

SOLVED_JSON="$(bun run matematica solve --problem "Prove 1 + 1 = 2" --goal "Find verified computation" --budget-usd 0 --max-attempts 4 --workers 1)"
RUN_ID="$(printf '%s' "$SOLVED_JSON" | bun -e 'const fs=require("fs"); console.log(JSON.parse(fs.readFileSync(0, "utf8")).runId)')"
bun run matematica goal watch "$RUN_ID" --json
bun run matematica goal report "$RUN_ID"
bun run matematica goal audit "$RUN_ID" --saved-everything
bun run matematica goal replay "$RUN_ID" --offline --verify-final
bun run matematica goal resume "$RUN_ID" --offline

EXHAUSTED_JSON="$(bun run matematica solve --problem "Prove the Collatz conjecture." --goal "Find a formal proof or verified counterexample" --budget-usd 0 --max-attempts 1 --workers 1 || test "$?" = "2")"
RUN_ID="$(printf '%s' "$EXHAUSTED_JSON" | bun -e 'const fs=require("fs"); console.log(JSON.parse(fs.readFileSync(0, "utf8")).runId)')"
bun run matematica goal watch "$RUN_ID" --json
bun run matematica goal report "$RUN_ID"
bun run matematica goal audit "$RUN_ID" --saved-everything
bun run matematica goal replay "$RUN_ID" --offline --verify-final
bun run matematica goal resume "$RUN_ID" --offline || test "$?" = "2"
```

The first solve must end `goal_met` with verifier-backed computational
evidence. The Collatz/open-problem smoke must end `budget_exhausted` without a
solved claim. Reports and replays must not require provider keys or network
access.

`matematica contract show --json` exposes this boundary as a stable
machine-readable execution contract. It has exactly two execution modes:

- `free-local-oss`: free, zero-network by default, local-ledger and
  deterministic-worker based. It can run with no provider keys and forbids
  remote model dispatch, hosted Hasna compute, bundled credits, secret
  persistence, and unprompted network fetches.
- `paid-byok-remote`: optional provider-billed BYOK mode. It requires
  `--provider`, network permission, `--max-call-usd`, `--max-output-tokens`,
  ledgered remote compute admission, provider allowlist match, and
  `--i-understand-remote-costs` for multi-worker fanout. It forbids unledgered
  paid calls, local-only remote dispatch, uncapped remote dispatch, and treating
  model output as verifier-backed final evidence.

## AI SDK Swarm Boundary

AI SDK tool loops are worker-local only. They may sequence model/tool calls
inside one leased worker attempt, but they do not own global orchestration.

The CLI ledger owns global worker leases, budget reservation/debit/release,
cancellation, external-operation idempotency, replay provenance, and all goal
success evidence gates. Worker-local AI SDK calls must receive the scheduler
`AbortSignal`, persist step-level traces, and run through the external-operation
outbox.

Model-visible tool summaries such as `toModelOutput` are treated as lossy
heuristic summaries. They can guide later work, but they are not verifier-backed
evidence and cannot mark `goal_met`.

AI SDK subagents are useful for worker-local delegation with isolated context,
but they are not the global swarm. The Matematica scheduler remains responsible
for admission control, cost preflight, persistence, and stop conditions.

## Remote Swarm Control Plane Contract

Remote swarm execution is coordinated by the CLI ledger, not by model-visible
agents. The coordinator signs every remote worker lease command and scopes it to
one run, one job, one worker id, one attempt, one dispatch id, one expiry, and
one budget reservation. Remote workers can only report mutations against that
signed lease; they cannot mint leases, expand budgets, mark goals met, grant
verifier trust, or change provider/network policy.

Each remote dispatch id is an idempotency key. Re-delivering the same signed
payload is replayable; reusing the dispatch id with different payload is
rejected. Heartbeats are accepted only while the signed lease is live. Revoked
worker ids, command ids, and dispatch ids fail closed, and the kill switch is
implemented as revocation plus coordinator-side cancellation of queued and
leased jobs.

Accepted remote lease commands and worker mutations must be persisted before
their effects are trusted. Offline replay must recompute signature validity,
lease TTL decisions, revocation decisions, duplicate-dispatch decisions, and the
budget reservation binding from persisted data.

## Usage

```bash
bun run src/bin/matematica.ts --help

# Primary one-shot command:
bun run src/bin/matematica.ts solve \
  --problem "Prove or disprove: every even integer greater than 2 is the sum of two primes" \
  --goal "Find a formal proof or verified counterexample" \
  --workflow pflk \
  --budget-usd 0 \
  --max-attempts 1

bun run src/bin/matematica.ts goal create \
  --problem "Prove or disprove: every even integer greater than 2 is the sum of two primes" \
  --goal "Find a formal proof or verified counterexample" \
  --workflow pflk \
  --max-attempts 1

bun run src/bin/matematica.ts goal run <run-id>
bun run src/bin/matematica.ts goal run <run-id> \
  --allow-network \
  --provider openai \
  --max-call-usd 0.02 \
  --i-understand-remote-costs
bun run src/bin/matematica.ts goal status <run-id>
bun run src/bin/matematica.ts goal watch <run-id> --json
bun run src/bin/matematica.ts goal replay <run-id>
bun run src/bin/matematica.ts goal report <run-id>
bun run src/bin/matematica.ts drills swarm-kill --worker-counts 1,4,16,100
```

## CLI Command Surface

`matematica solve` is the primary product contract: the user supplies a problem,
goal, budget, workflow, and optional worker/provider settings; the CLI creates a
run, starts it, returns the terminal outcome, and prints follow-up watch,
report, replay, and resume commands.

| Command | Contract |
| --- | --- |
| `solve` | One-shot prompt/file plus budget entry point for create + run, with follow-up watch/report/replay/resume commands. |
| `goal create` | Persist problem, goal, workflow, success criteria, and budget caps without executing workers. |
| `goal run` | Continue a run until `goal_met`, `budget_exhausted`, `cancelled`, `failed`, or `needs_human_review`. |
| `goal watch` | Monitor phase, cycle, worker states, budget used/remaining, provider spend, latest artifacts, best claim, warnings, and terminal reason; supports `--json`, `--follow`, and bounded polling with `--ticks`. |
| `goal resume` | Reconcile crash state and continue a run with the same safety gates as `goal run`; terminal runs are preserved unless `--reopen-terminal` is provided. |
| `goal report` | Render a human-readable report from persisted ledger events and artifacts. |
| `goal replay` | Emit event log, replay manifest, deterministic replay, or offline final verification. |
| `goal audit` | Check ledger/artifact integrity for a run. |
| `doctor` | Show local environment, provider, Lean, zero-network, BYOK, and release readiness diagnostics. |
| `contract show` | Print the free OSS versus paid BYOK execution contract. |
| `providers list/smoke` | Inspect provider readiness and run ledgered smoke checks for configured providers. |
| `milestones list` | Print ordered release gates from local core through public OSS release. |
| `research arxiv` | Fetch or replay citation-only arXiv metadata under network/offline policy. |
| `drills swarm-kill` | Run the swarm kill-drill matrix for cancellation, stale leases, provider 429 storms, budget exhaustion, and terminal-stop races. |

## Release Milestones

`matematica milestones list --json` exposes the release ordering as a stable
machine-readable contract. A milestone is ready only when all required gates in
that milestone and every earlier milestone have passing evidence.

`matematica doctor --release --json` emits the matching release-readiness report
for package metadata, package file allowlist, zero-network OSS baseline, BYOK
remote-provider boundary, and milestone gate validity.

1. `m0-local-core`: local Bun/TypeScript CLI, persisted ledger/artifacts,
   zero-network default, and honest terminal vocabulary.
2. `m1-replay-verifier`: evidence gate, proof obligations, claim graph,
   verifier conformance corpus, and offline replay final verification.
3. `m2-research-security`: hostile arXiv/source handling, citation provenance,
   source-quality checks, cache, and polite-use throttle.
4. `m3-provider-byok`: explicit BYOK admission, per-call caps, provider
   resilience, redaction, and replayable provider metadata.
5. `m4-swarm-scale`: scheduler leases, remote worker attestation, AI SDK swarm
   boundary, kill switches, and 1/4/16/100 worker kill-drill coverage.
6. `m5-public-release`: free OSS acceptance, release doctor, operator runbook,
   docs, and package hygiene.

Exit-code contract:

| Code | Meaning |
| --- | --- |
| `0` | Command succeeded. For `solve`, `goal run`, and `goal resume`, this means `goal_met`. |
| `1` | Operational or validation failure; no successful terminal run result was produced. |
| `2` | `solve`, `goal run`, or `goal resume` reached an honest `budget_exhausted` terminal report. |
| `3` | `solve`, `goal run`, or `goal resume` ended `cancelled`. |
| `4` | `solve`, `goal run`, or `goal resume` ended `needs_human_review` or failed evidence gates. |
