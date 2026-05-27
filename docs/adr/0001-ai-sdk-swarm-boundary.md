# ADR 0001: AI SDK Swarm Boundary

Status: accepted

Date: 2026-05-25

## Context

Matematica is a Bun and TypeScript CLI that runs a mathematical goal until the goal is met or the configured budget is exhausted. It uses PFLK and GREE cycles, arXiv research, verifier tools, and provider-backed worker attempts. Loophole and Experiment phases may fan out to many workers, including future remote workers.

The AI SDK is the provider and worker-loop layer. It is useful for model calls, structured output, tool-call sequencing inside a worker, stream metadata, and provider adapters. It is not the authority for global swarm state.

Current local package surface:

- `ai`: `^6.0.191`
- `@ai-sdk/openai`: `^3.0.65`
- `@ai-sdk/anthropic`: `^3.0.79`
- `@ai-sdk/cerebras`: `^2.0.54`
- `@openrouter/ai-sdk-provider`: `^2.9.0`
- `@ai-sdk/openai-compatible`: `^2.0.48`

Current AI SDK documentation checked on 2026-05-26:

- `ToolLoopAgent` is a reusable multi-step tool loop with `stopWhen`,
  `prepareStep`, `maxRetries`, `timeout`, `abortSignal`, step callbacks,
  telemetry, and tool-call repair hooks.
- AI SDK subagents are model-callable tools that delegate to another agent
  loop. They are useful inside a leased worker, but they are still tool calls
  inside a worker-local loop.
- Tool results can expose `toModelOutput` summaries back to the model. Those
  summaries are lossy context and are never proof, budget, lease, or terminal
  state authority.

References:

- https://ai-sdk.dev/docs/reference/ai-sdk-core/tool-loop-agent
- https://ai-sdk.dev/docs/agents/subagents
- https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling

## Decision

The CLI ledger is the swarm coordinator and source of authority.

AI SDK owns:

- Worker-local model and tool loop execution.
- Tool-call sequencing inside one leased worker attempt.
- Provider-specific request, response, usage, streaming, and step metadata capture.
- Provider adapters for OpenAI, Anthropic, OpenRouter, Cerebras, and OpenAI-compatible local endpoints.
- Worker-local loop controls such as `stopWhen`, `prepareStep`, `maxRetries`,
  `timeout`, callbacks, telemetry metadata, and tool-call repair attempts,
  provided every such control is mirrored into the Matematica ledger boundary.

The CLI ledger owns:

- Global worker leases.
- Admission control and provider allowlists.
- Budget reservation, debit, release, and kill switches.
- Cancellation and `AbortSignal` propagation.
- External-operation idempotency and retry lineage.
- Artifact persistence and deterministic replay provenance.
- Goal success, evidence gates, finalization, and report trust.
- Remote worker command signing, revocation, replay, and capability attestation.

## Invariants

1. A worker-local AI SDK call must receive the scheduler abort signal before any external provider effect.
2. Every model request, response, step trace, tool call, tool result, usage object, retry, failure, and cancellation must be persisted through the append-only ledger or linked artifacts.
3. AI SDK text, tool summaries, and `toModelOutput` summaries are heuristic material only. They never become proof support by themselves.
4. A remote worker may only mutate the run through a signed lease command that binds run id, job id, worker id, attempt, dispatch id, lease expiry, and budget reservation id.
5. Duplicate remote dispatch with the same signed payload is replayable. Duplicate dispatch with a different signed payload is rejected.
6. Remote workers never mint leases, budgets, success decisions, verifier authority, or final outcomes.
7. Offline replay must recompute provider-call manifests, remote worker attestation decisions, signed command decisions, budget accounting, and finalization from persisted records only.

## Consequences

The code can use AI SDK ToolLoopAgent-like patterns or manual `generateText`/`streamText` loops per worker, but both modes must emit the same canonical ledger event shapes. The CLI can scale worker fanout independently of AI SDK internals because global scheduling, budgets, replay, and finalization do not live inside model-visible state.

Provider integrations are replaceable behind `src/providers.ts`; scheduler and evidence semantics are not provider responsibilities.
