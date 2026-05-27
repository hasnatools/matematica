export type CancellationSettlement = "avoided" | "released" | "debited" | "unknown";

export function abortErrorFromSignal(signal: AbortSignal, fallback = "Operation aborted."): Error {
  const reason = signal.reason;
  const message = reason instanceof Error ? reason.message : typeof reason === "string" ? reason : fallback;
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /abort|cancel/i.test(error.message));
}

export function throwIfAborted(signal: AbortSignal | undefined, fallback?: string): void {
  if (signal?.aborted) throw abortErrorFromSignal(signal, fallback);
}

export async function abortableSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  throwIfAborted(signal);
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    if (!signal) return;
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortErrorFromSignal(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function abortableWait<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  throwIfAborted(signal);
  if (!signal) return await promise;
  return await Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      signal.addEventListener("abort", () => reject(abortErrorFromSignal(signal)), { once: true });
    })
  ]);
}
