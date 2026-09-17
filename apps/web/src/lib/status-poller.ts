/**
 * Serial interval runner for the shell's status check. A scheduled tick while
 * the previous check is still pending is skipped (never queued, never joined),
 * so a slow backend cannot accumulate overlapping requests or apply an older
 * response after a newer one. The check itself owns stale-response handling
 * (market generation) and cancellation.
 */
export interface StatusPoller {
  /** Runs immediately, then every `intervalMs`, skipping overlapping ticks. */
  start(): void;
  stop(): void;
  /** Manual trigger with the same overlap guarantee. */
  trigger(): Promise<void>;
}

export function createStatusPoller(
  check: () => Promise<void>,
  intervalMs: number,
): StatusPoller {
  let inFlight = false;
  let stopped = false;
  let timer: number | undefined;
  const run = async (): Promise<void> => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      await check();
    } finally {
      inFlight = false;
    }
  };
  return {
    start() {
      stopped = false;
      if (timer !== undefined) window.clearInterval(timer);
      timer = window.setInterval(() => void run(), intervalMs);
      void run();
    },
    stop() {
      stopped = true;
      if (timer !== undefined) {
        window.clearInterval(timer);
        timer = undefined;
      }
    },
    trigger: run,
  };
}
