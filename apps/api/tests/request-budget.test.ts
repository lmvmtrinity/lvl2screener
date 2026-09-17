import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BROKER_BUDGET,
  decideBudget,
  MemoryRequestBudget,
  type BudgetUsage,
} from "../src/questrade/request-budget.js";
import { QuestradeRateLimiter } from "../src/questrade/rate-limiter.js";
import type {
  QuestradeRequestObservation,
  QuestradeRequestObserver,
} from "../src/questrade/request-observation.js";

const baseline: BudgetUsage = {
  second: 0,
  hour: 0,
  discoveryHour: 0,
  oldestSecondMs: 0,
  oldestHourMs: 0,
  oldestDiscoveryMs: 0,
  lastMs: -Infinity,
  lastDiscoveryMs: -Infinity,
  blockedUntilMs: 0,
};
afterEach(() => vi.useRealTimers());

describe("broker request budget", () => {
  it.each([
    [false, { second: 20, oldestSecondMs: 100 }, 1_100],
    [false, { hour: 15_000, oldestHourMs: 100 }, 3_600_100],
    [true, { hour: 9_000, oldestHourMs: 100 }, 3_600_100],
    [true, { discoveryHour: 1_800, oldestDiscoveryMs: 100 }, 3_600_100],
    [true, { lastDiscoveryMs: 500 }, 1_500],
    [false, { lastMs: 995 }, 1_045],
  ] as const)("enforces %s usage %o", (discovery, usage, expected) => {
    expect(
      decideBudget(1_000, discovery, { ...baseline, ...usage }),
    ).toMatchObject({ granted: false, retryAfterMs: expected - 1_000 });
  });
  it("leaves monitoring capacity after discovery is exhausted", () => {
    const usage = {
      ...baseline,
      hour: 9_000,
      discoveryHour: 1_800,
      oldestHourMs: 1,
      oldestDiscoveryMs: 1,
    };
    expect(decideBudget(2_000, false, usage).granted).toBe(true);
    expect(decideBudget(2_000, true, usage).granted).toBe(false);
  });
  it("shares grants between markets and rolls the second window exactly", async () => {
    let now = 0;
    const shared = new MemoryRequestBudget(() => new Date(now));
    for (let i = 0; i < 20; i++) {
      now = i * 50;
      expect((await shared.acquire(false)).granted).toBe(true);
      expect((await shared.acquire(false)).granted).toBe(false);
    }
    now = 999;
    expect((await shared.acquire(false)).granted).toBe(false);
    now = 1000;
    expect((await shared.acquire(false)).granted).toBe(true);
  });
  it("retains discovery hourly spend until the exact rolling boundary", async () => {
    let now = 0;
    const budget = new MemoryRequestBudget(() => new Date(now));
    for (let i = 0; i < 1_800; i++) {
      now = i * 1_000;
      expect((await budget.acquire(true)).granted).toBe(true);
    }
    now = 3_599_999;
    expect((await budget.acquire(true)).granted).toBe(false);
    now = 3_600_000;
    expect((await budget.acquire(true)).granted).toBe(true);
  });
});

describe("bounded discovery queue", () => {
  it("observes discovery expiry before broker dispatch", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const budget = new MemoryRequestBudget();
    await budget.block(new Date(3_600_000));
    const limiter = new QuestradeRateLimiter(1, 2, () => new Date(), budget);
    const events: QuestradeRequestObservation[] = [];
    const observer: QuestradeRequestObserver = {
      observe: (event) => events.push(event),
    };

    const result = limiter
      .schedule("P1", async () => "quote", {
        discovery: true,
        expiresAt: new Date(5_000),
        observation: {
          attemptId: "10000000-0000-4000-8000-000000000002",
          operation: "QUOTE",
          requestedItems: 4,
          observer,
        },
      })
      .catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(5_000);

    await expect(result).resolves.toMatchObject({ code: "EXPIRED" });
    expect(events.map((event) => event.phase)).toEqual(["QUEUED", "SETTLED"]);
    expect(events.at(-1)).toMatchObject({
      attemptId: "10000000-0000-4000-8000-000000000002",
      operation: "QUOTE",
      requestedItems: 4,
      outcome: "EXPIRED",
      queueWaitMs: expect.any(Number),
    });
    expect(events.at(-1)?.queueWaitMs).toBeGreaterThanOrEqual(0);
    expect(events.at(-1)?.executionMs).toBeUndefined();
  });

  it("observes a non-discovery request without changing its priority", async () => {
    const limiter = new QuestradeRateLimiter();
    const events: QuestradeRequestObservation[] = [];
    const observer: QuestradeRequestObserver = {
      observe: (event) => events.push(event),
    };

    await limiter.schedule("P1", async () => "quote", {
      observation: {
        attemptId: "10000000-0000-4000-8000-000000000003",
        operation: "QUOTE",
        requestedItems: 1,
        observer,
      },
    });

    expect(events.at(-1)).toMatchObject({
      attemptId: "10000000-0000-4000-8000-000000000003",
      operation: "QUOTE",
      requestedItems: 1,
      outcome: "COMPLETED",
    });
  });

  it("dispatches monitoring ahead of a throttled discovery request", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const budget = new MemoryRequestBudget();
    const limiter = new QuestradeRateLimiter(2, 2, () => new Date(), budget);
    const order: string[] = [];
    await limiter.schedule(
      "P4",
      async () => {
        order.push("first-discovery");
      },
      { discovery: true },
    );
    const discovery = limiter.schedule(
      "P1",
      async () => {
        order.push("next-discovery");
      },
      { discovery: true },
    );
    const monitoring = limiter.schedule("P1", async () => {
      order.push("monitoring");
    });
    await vi.advanceTimersByTimeAsync(50);
    await monitoring;
    expect(order).toEqual(["first-discovery", "monitoring"]);
    await vi.advanceTimersByTimeAsync(950);
    await discovery;
    expect(order).toEqual(["first-discovery", "monitoring", "next-discovery"]);
  });
  it("expires starved discovery while monitoring and auth can progress", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const budget = new MemoryRequestBudget();
    await budget.block(new Date(3_600_000));
    const limiter = new QuestradeRateLimiter(2, 2, () => new Date(), budget);
    const operation = vi.fn(async () => 1);
    const queued = limiter
      .schedule("P1", operation, { discovery: true })
      .catch((error: unknown) => error);
    await expect(limiter.schedule("P0", async () => "auth")).resolves.toBe(
      "auth",
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(limiter.requestCounts).toMatchObject({
      discoveryQueued: 1,
      oldestQueueAgeMs: 60_000,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await queued).toMatchObject({ code: "EXPIRED" });
    expect(operation).not.toHaveBeenCalled();
    expect(limiter.requestCounts.expired).toBe(1);
  });
  it("enforces a caller's earlier absolute discovery deadline by timer", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const budget = new MemoryRequestBudget();
    await budget.block(new Date(3_600_000));
    const limiter = new QuestradeRateLimiter(2, 2, () => new Date(), budget);
    const operation = vi.fn(async () => 1);
    const queued = limiter
      .schedule("P1", operation, {
        discovery: true,
        expiresAt: new Date(5_000),
      })
      .catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(5_000);

    expect(await queued).toMatchObject({ code: "EXPIRED" });
    expect(operation).not.toHaveBeenCalled();
    expect(limiter.requestCounts).toMatchObject({
      discoveryExpired: 1,
      discoveryCancelled: 0,
    });
  });
  it("bounds queues and cancels obsolete work without calling the broker", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const budget = new MemoryRequestBudget();
    await budget.block(new Date(3_600_000));
    const limiter = new QuestradeRateLimiter(2, 2, () => new Date(), budget);
    const operation = vi.fn(async () => 1);
    const queued = Array.from({ length: BROKER_BUDGET.discoveryQueue }, () =>
      limiter
        .schedule("P4", operation, { discovery: true })
        .catch((error: unknown) => error),
    );
    await expect(
      limiter.schedule("P4", operation, { discovery: true }),
    ).rejects.toMatchObject({ code: "QUEUE_FULL" });
    limiter.cancelPendingDiscovery();
    expect(
      (await Promise.all(queued)).every(
        (value) => (value as { code: string }).code === "CANCELLED",
      ),
    ).toBe(true);
    expect(operation).not.toHaveBeenCalled();
  });
  it("retains a grant cancelled during persistence, without dispatching", async () => {
    const controller = new AbortController();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const memory = new MemoryRequestBudget();
    const limiter = new QuestradeRateLimiter(1, 2, () => new Date(), {
      acquire: async (low) => {
        const grant = await memory.acquire(low);
        await gate;
        return grant;
      },
      block: (until) => memory.block(until),
    });
    const operation = vi.fn(async () => 1);
    const result = limiter
      .schedule("P4", operation, { discovery: true, signal: controller.signal })
      .catch((error: unknown) => error);
    controller.abort();
    release();
    expect(await result).toMatchObject({ code: "CANCELLED" });
    expect(operation).not.toHaveBeenCalled();
    expect((await memory.acquire(true)).granted).toBe(false);
  });
  it("counts fixed-deadline aborts as expired while a grant is persisting", async () => {
    const controller = new AbortController();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const memory = new MemoryRequestBudget();
    const limiter = new QuestradeRateLimiter(1, 2, () => new Date(), {
      acquire: async (low) => {
        const grant = await memory.acquire(low);
        await gate;
        return grant;
      },
      block: (until) => memory.block(until),
    });
    const operation = vi.fn(async () => 1);
    const result = limiter
      .schedule("P4", operation, {
        discovery: true,
        signal: controller.signal,
        expiresAt: new Date(Date.now() + 5_000),
      })
      .catch((error: unknown) => error);

    controller.abort(Object.assign(new Error("deadline"), { code: "EXPIRED" }));
    release();

    expect(await result).toMatchObject({ code: "EXPIRED" });
    expect(operation).not.toHaveBeenCalled();
    expect(limiter.requestCounts).toMatchObject({
      discoveryExpired: 1,
      discoveryCancelled: 0,
    });
    expect((await memory.acquire(true)).granted).toBe(false);
  });
  it("honors 429 Retry-After and ignores missing remaining headers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const budget = new MemoryRequestBudget();
    const limiter = new QuestradeRateLimiter(1, 2, () => new Date(), budget);
    await limiter.observeHeaders(new Headers({ "x-ratelimit-reset": "99999" }));
    expect((await budget.acquire(false)).granted).toBe(true);
    await limiter.observeHeaders(new Headers({ "retry-after": "60" }), 429);
    vi.setSystemTime(59_999);
    expect((await budget.acquire(false)).granted).toBe(false);
    vi.setSystemTime(60_000);
    expect((await budget.acquire(false)).granted).toBe(true);
    expect(limiter.requestCounts.throttled).toBe(1);
  });
  it("handles synchronous throws without wedging later requests", async () => {
    const limiter = new QuestradeRateLimiter();
    await expect(
      limiter.schedule("P0", () => {
        throw new Error("sync");
      }),
    ).rejects.toThrow("sync");
    await expect(limiter.schedule("P0", async () => 2)).resolves.toBe(2);
  });
  it("rejects budget persistence failure without dispatching", async () => {
    const operation = vi.fn(async () => 1);
    const limiter = new QuestradeRateLimiter(1, 2, () => new Date(), {
      acquire: async () => {
        throw new Error("database down");
      },
      block: async () => {},
    });
    await expect(limiter.schedule("P1", operation)).rejects.toThrow(
      "budget unavailable",
    );
    expect(operation).not.toHaveBeenCalled();
  });

  it("attributes dispatched discovery outcomes separately from monitoring", async () => {
    const limiter = new QuestradeRateLimiter();
    await expect(
      limiter.schedule("P4", async () => 1, { discovery: true }),
    ).resolves.toBe(1);
    await expect(
      limiter.schedule(
        "P4",
        async () => {
          throw new Error("provider failure");
        },
        { discovery: true },
      ),
    ).rejects.toThrow("provider failure");

    expect(limiter.requestCounts).toMatchObject({
      discoveryCompleted: 1,
      discoveryFailed: 1,
      discoveryCancelled: 0,
      discoveryExpired: 0,
    });
  });
});
