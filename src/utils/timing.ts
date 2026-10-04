/**
 * Shared timing helpers (one home, previously copy-pasted across the loop,
 * executor, connection, and session manager). Both `unref` their timers when
 * the runtime supports it, so a losing timeout-race or settle timer never
 * keeps the process alive after the work is done.
 */

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    (timer as { unref?: () => void }).unref?.();
  });
}

/** Rejects with `message` after `ms` if the promise hasn't settled. */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
        (timer as { unref?: () => void }).unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
