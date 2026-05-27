import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { WORKER_LEASE_STATE_MACHINE_VERSION, workerLeaseStateFromStatus } from "../src/worker-lease-state-machine";

describe("worker lease state-machine documentation", () => {
  test("documents the current payload version states and transition events", () => {
    const doc = readFileSync(join(import.meta.dir, "..", "docs", "worker-lease-state-machine.md"), "utf8");

    expect(doc).toContain(WORKER_LEASE_STATE_MACHINE_VERSION);
    for (const state of ["queued", "leased", "running", "committed", "failed", "cancelled", "revoked", "stale"]) {
      expect(doc).toContain(`\`${state}\``);
    }
    for (const eventType of [
      "worker.enqueued",
      "worker.leased",
      "worker.reservation_bound",
      "worker.started",
      "worker.heartbeat",
      "worker.committed",
      "worker.completed",
      "worker.failed",
      "worker.cancelled",
      "worker.revoked",
      "worker.stale",
      "worker.reconciled",
      "worker.quarantined",
      "worker.mutation.ignored"
    ]) {
      expect(doc).toContain(`\`${eventType}\``);
    }
  });

  test("maps persisted statuses to replay states", () => {
    expect(workerLeaseStateFromStatus("pending")).toBe("queued");
    expect(workerLeaseStateFromStatus("failed_retryable")).toBe("queued");
    expect(workerLeaseStateFromStatus("leased")).toBe("leased");
    expect(workerLeaseStateFromStatus("running")).toBe("running");
    expect(workerLeaseStateFromStatus("committed")).toBe("committed");
    expect(workerLeaseStateFromStatus("failed_terminal")).toBe("failed");
    expect(workerLeaseStateFromStatus("cancelled")).toBe("cancelled");
  });
});
