import { Ledger } from "../../src/ledger";
import { getAppPaths } from "../../src/paths";
import { runWorkerQueue } from "../../src/scheduler";

const [runId, workerId] = process.argv.slice(2);
if (!runId || !workerId) {
  console.error("usage: sqlite-lease-worker.ts <run-id> <worker-id>");
  process.exit(2);
}

const ledger = new Ledger(getAppPaths().dbPath);
try {
  const result = await runWorkerQueue({
    runId,
    ledger,
    workerId,
    maxWorkers: 1,
    leaseMs: 30_000,
    cancellationPollMs: 25,
    executor: async (job) => {
      await Bun.sleep(Number(job.payload.delayMs ?? 0));
      return {
        workerId,
        jobId: job.id,
        index: job.payload.index
      };
    }
  });
  console.log(JSON.stringify({ workerId, ...result }));
} finally {
  ledger.close();
}
