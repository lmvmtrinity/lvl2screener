import { describe, expect, it, vi } from "vitest";
import { QuestradeRateLimiter } from "../src/questrade/rate-limiter.js";
import type {
  QuestradeRequestObservation,
  QuestradeRequestObserver,
} from "../src/questrade/request-observation.js";

describe("QuestradeRateLimiter", () => {
  it.each([false, true])(
    "separates terminal queue wait from execution (failure=%s)",
    async (failure) => {
      let now = 0;
      const limiter = new QuestradeRateLimiter(1, 2, () => new Date(now));
      let release!: () => void;
      let started!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const activeStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      const active = limiter.schedule("P0", async () => {
        started();
        await gate;
      });
      await activeStarted;
      const events: QuestradeRequestObservation[] = [];
      const pending = limiter.schedule(
        "P1",
        async () => {
          now = 15;
          if (failure) throw new Error("fixture failure");
          return "quote";
        },
        {
          discovery: true,
          observation: {
            attemptId: "10000000-0000-4000-8000-000000000002",
            operation: "QUOTE",
            requestedItems: 1,
            observer: { observe: (event) => events.push(event) },
          },
        },
      );
      now = 5;
      release();
      await Promise.allSettled([active, pending]);
      expect(events.at(-1)).toMatchObject({
        phase: "SETTLED",
        outcome: failure ? "FAILED" : "COMPLETED",
        queueWaitMs: 5,
        executionMs: 10,
      });
    },
  );
  it("observes a completed discovery request lifecycle", async () => {
    let now = 1_000;
    const limiter = new QuestradeRateLimiter(1, 2, () => new Date(now));
    const events: QuestradeRequestObservation[] = [];
    const observer: QuestradeRequestObserver = {
      observe: (event) => events.push(event),
    };

    await expect(
      limiter.schedule(
        "P1",
        async () => {
          now += 15;
          return "quote";
        },
        {
          discovery: true,
          observation: {
            attemptId: "10000000-0000-4000-8000-000000000001",
            operation: "QUOTE",
            requestedItems: 4,
            observer,
          },
        },
      ),
    ).resolves.toBe("quote");

    expect(events.map((event) => event.phase)).toEqual([
      "QUEUED",
      "DISPATCHED",
      "SETTLED",
    ]);
    expect(events.at(-1)).toMatchObject({
      attemptId: "10000000-0000-4000-8000-000000000001",
      operation: "QUOTE",
      requestedItems: 4,
      outcome: "COMPLETED",
      queueWaitMs: expect.any(Number),
      executionMs: expect.any(Number),
    });
    expect(events.at(-1)?.queueWaitMs).toBeGreaterThanOrEqual(0);
    expect(events.at(-1)?.executionMs).toBeGreaterThanOrEqual(0);
  });

  it("contains a rejected observer promise without affecting dispatch", async () => {
    const rejection = Promise.reject(new Error("observer failed"));
    const catchRejection = vi.spyOn(rejection, "catch");
    void rejection.catch(() => undefined);
    catchRejection.mockClear();
    const limiter = new QuestradeRateLimiter();

    await expect(
      limiter.schedule("P1", async () => "quote", {
        observation: {
          attemptId: "10000000-0000-4000-8000-000000000005",
          operation: "QUOTE",
          requestedItems: 1,
          observer: { observe: () => rejection },
        },
      }),
    ).resolves.toBe("quote");

    expect(catchRejection).toHaveBeenCalled();
  });

  it("prioritizes auth and quotes ahead of queued backfill work", async () => {
    const limiter = new QuestradeRateLimiter(1);
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const active = limiter.schedule("P4", async () => {
      order.push("active-backfill");
      await firstGate;
    });
    const queuedBackfill = limiter.schedule("P4", async () => {
      order.push("queued-backfill");
    });
    const quote = limiter.schedule("P1", async () => {
      order.push("quote");
    });
    const auth = limiter.schedule("P0", async () => {
      order.push("auth");
    });

    releaseFirst();
    await Promise.all([active, queuedBackfill, quote, auth]);
    expect(order).toEqual([
      "active-backfill",
      "auth",
      "quote",
      "queued-backfill",
    ]);
  });
});
