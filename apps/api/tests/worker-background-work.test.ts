import { describe, expect, it, vi } from "vitest";
import { BackgroundWorkTracker } from "../src/worker/background-work.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("BackgroundWorkTracker", () => {
  it("drains immediately when no background work is running", async () => {
    const tracker = new BackgroundWorkTracker({ error: vi.fn() });
    await expect(tracker.drain()).resolves.toBeUndefined();
    expect(tracker.size).toBe(0);
  });

  it("waits for an in-flight poll before draining", async () => {
    const tracker = new BackgroundWorkTracker({ error: vi.fn() });
    const gate = deferred();
    const run = tracker.run(
      "CHALLENGER_OBSERVATION_WORKER_FAILED",
      "CA_TSX",
      () => gate.promise,
    );
    expect(tracker.size).toBe(1);
    let drained = false;
    const drain = tracker.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    gate.resolve();
    await run;
    await drain;
    expect(drained).toBe(true);
    expect(tracker.size).toBe(0);
  });

  it("waits for an in-flight evidence catch-up pass", async () => {
    const tracker = new BackgroundWorkTracker({ error: vi.fn() });
    const gate = deferred();
    const run = tracker.run(
      "EVIDENCE_AUTOMATION_CATCH_UP_FAILED",
      undefined,
      () => gate.promise,
    );
    const drain = tracker.drain();
    await Promise.resolve();
    expect(tracker.size).toBe(1);
    gate.resolve();
    await run;
    await drain;
    expect(tracker.size).toBe(0);
  });

  it("refuses new work after close so timers cannot query a closed pool", async () => {
    const logger = { error: vi.fn() };
    const tracker = new BackgroundWorkTracker(logger);
    const task = vi.fn(async () => undefined);
    tracker.close();
    await expect(
      tracker.run("CHALLENGER_OBSERVATION_WORKER_FAILED", "CA_TSX", task),
    ).resolves.toBeUndefined();
    expect(task).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "CHALLENGER_OBSERVATION_WORKER_FAILED_REFUSED",
        marketId: "CA_TSX",
      }),
    );
  });

  it("logs a failed pass without rejecting the returned promise", async () => {
    const logger = { error: vi.fn() };
    const tracker = new BackgroundWorkTracker(logger);
    await expect(
      tracker.run(
        "EVIDENCE_AUTOMATION_CATCH_UP_FAILED",
        undefined,
        async () => {
          throw new Error("boom");
        },
      ),
    ).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "EVIDENCE_AUTOMATION_CATCH_UP_FAILED",
        error: "boom",
      }),
    );
    expect(tracker.size).toBe(0);
  });

  it("drains repeatedly and leaves no work behind", async () => {
    const tracker = new BackgroundWorkTracker({ error: vi.fn() });
    const gate = deferred();
    const first = tracker.run("A_FAILED", undefined, () => gate.promise);
    const second = tracker.run("B_FAILED", undefined, async () => undefined);
    await second;
    gate.resolve();
    await first;
    await tracker.drain();
    await tracker.drain();
    expect(tracker.size).toBe(0);
  });
});
