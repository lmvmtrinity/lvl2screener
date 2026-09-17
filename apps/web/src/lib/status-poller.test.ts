import { afterEach, describe, expect, it, vi } from "vitest";
import { createStatusPoller } from "./status-poller.js";

describe("createStatusPoller", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("never overlaps a scheduled tick with a pending check", async () => {
    vi.useFakeTimers();
    let resolve!: () => void;
    const check = vi.fn(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    const poller = createStatusPoller(check, 15_000);
    poller.start();
    expect(check).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(45_000);
    expect(check).toHaveBeenCalledTimes(1);

    resolve();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(check).toHaveBeenCalledTimes(2);
    poller.stop();
  });

  it("stops scheduling after stop()", async () => {
    vi.useFakeTimers();
    const check = vi.fn(async () => undefined);
    const poller = createStatusPoller(check, 15_000);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(check).toHaveBeenCalledTimes(1);

    poller.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("manual triggers share the in-flight guard", async () => {
    let resolve!: () => void;
    const check = vi.fn(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    const poller = createStatusPoller(check, 15_000);
    const first = poller.trigger();
    const second = poller.trigger();
    expect(check).toHaveBeenCalledTimes(1);
    resolve();
    await Promise.all([first, second]);
    expect(check).toHaveBeenCalledTimes(1);
  });
});
