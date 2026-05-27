# Worker Lease State Machine

Platform-matematica treats every leased worker job as an append-only state machine. The database keeps the operational status, while ledger events keep the replayable automaton history.

## Version

Current payload version: `worker-lease-state-machine-v1`.

Every worker lease transition event for a queued job includes:

- `workerLeaseStateMachine.version`
- `workerLeaseStateMachine.jobId`
- `actor`
- `reason`
- `priorState`
- `nextState`
- `attempt`
- `reservationId`
- `leaseExpiresAt` when a lease is active or being reconciled

## States

- `queued`: job is available to lease. Database statuses `pending` and `failed_retryable` map here.
- `leased`: a worker owns a lease and has not started execution.
- `running`: a leased worker started execution.
- `committed`: a worker produced a committed result.
- `failed`: a job reached terminal failure.
- `cancelled`: the job was cancelled without a valid committed result.
- `revoked`: an operator or safety controller revoked the active lease. The persisted job status becomes `cancelled`, but the automaton records the revoked transition first.
- `stale`: the reaper observed an expired lease. The persisted job status becomes `failed_retryable` or `failed_terminal`, but the automaton records the stale transition first.

## Transition Events

- `worker.enqueued`: `queued -> queued`
- `worker.leased`: `queued|leased|running -> leased`
- `worker.reservation_bound`: `leased -> leased`
- `worker.started`: `leased -> running`
- `worker.heartbeat`: `leased|running -> leased|running`
- `worker.committed`: `leased|running -> committed`
- `worker.completed`: `committed -> committed`
- `worker.failed`: `leased|running -> queued|failed`
- `worker.cancelled`: `queued|leased|running|revoked -> cancelled`
- `worker.revoked`: `queued|leased|running -> revoked`
- `worker.stale`: `leased|running -> stale`
- `worker.reconciled`: `stale -> queued|failed`
- `worker.quarantined`: `stale -> failed`
- `worker.mutation.ignored`: invalid or late mutation with identical prior and next state

## Replay And Reaper Rules

The reaper is idempotent: it emits `worker.stale` only for currently leased or running jobs whose lease expiry is in the past, then emits `worker.reconciled` once the job is moved to retryable or terminal failure.

Replay treats reservation binding, stale detection, revocation, reconciliation, cancellation, commit, and failure as durable action events. Duplicate lease attempts must not produce a second lease. Duplicate heartbeats may extend the same lease and are valid. Late commits after stale reconciliation or revocation are rejected and persisted as `worker.mutation.ignored` with the rejection reason.
