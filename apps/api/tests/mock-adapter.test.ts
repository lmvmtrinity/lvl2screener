import { describe, expect, it, vi } from "vitest";
import {
  createMockQuestradeAdapter,
  PHASE0_NOW,
} from "../src/questrade/create-mock-adapter.js";
import { QuestradeHttpError } from "../src/questrade/live-transport.js";
import type {
  QuestradeRequestObservation,
  QuestradeRequestObserver,
} from "../src/questrade/request-observation.js";

describe("mocked Questrade adapter", () => {
  it("observes adapter preflight cancellation without scheduling a broker call", async () => {
    const { adapter, transport } = createMockQuestradeAdapter();
    const controller = new AbortController();
    controller.abort();
    const events: QuestradeRequestObservation[] = [];

    await expect(
      adapter.getQuotes([1001], {
        signal: controller.signal,
        observation: {
          attemptId: "10000000-0000-4000-8000-000000000006",
          observer: { observe: (event) => events.push(event) },
        },
      }),
    ).rejects.toMatchObject({ code: "CANCELLED" });

    expect(transport.quoteBatches).toEqual([]);
    expect(events).toEqual([
      expect.objectContaining({
        attemptId: "10000000-0000-4000-8000-000000000006",
        operation: "QUOTE",
        requestedItems: 1,
        phase: "SETTLED",
        outcome: "CANCELLED",
        queueWaitMs: 0,
      }),
    ]);
  });

  it("observes adapter preflight expiry without scheduling a broker call", async () => {
    const { adapter, transport } = createMockQuestradeAdapter();
    const events: QuestradeRequestObservation[] = [];

    await expect(
      adapter.getQuotes([1001], {
        expiresAt: new Date(PHASE0_NOW.getTime() - 1),
        observation: {
          attemptId: "10000000-0000-4000-8000-000000000007",
          observer: { observe: (event) => events.push(event) },
        },
      }),
    ).rejects.toMatchObject({ code: "EXPIRED" });

    expect(transport.quoteBatches).toEqual([]);
    expect(events).toEqual([
      expect.objectContaining({
        attemptId: "10000000-0000-4000-8000-000000000007",
        operation: "QUOTE",
        requestedItems: 1,
        phase: "SETTLED",
        outcome: "EXPIRED",
        queueWaitMs: 0,
      }),
    ]);
  });

  it("contains a rejected observer promise from the adapter 401 event", async () => {
    const { adapter, transport } = createMockQuestradeAdapter();
    const original = transport.getQuotes.bind(transport);
    vi.spyOn(transport, "getQuotes")
      .mockRejectedValueOnce(new QuestradeHttpError(401, "unauthorized"))
      .mockImplementation(original);
    const rejection = Promise.reject(new Error("observer failed"));
    const catchRejection = vi.spyOn(rejection, "catch");
    void rejection.catch(() => undefined);
    catchRejection.mockClear();

    await expect(
      adapter.getQuotes([1001], {
        observation: {
          attemptId: "10000000-0000-4000-8000-000000000008",
          observer: {
            observe: (event) =>
              event.phase === "HTTP_401_RETRY" ? rejection : undefined,
          },
        },
      }),
    ).resolves.toHaveLength(1);

    expect(catchRejection).toHaveBeenCalled();
  });

  it("observes an HTTP 401 retry before its second broker dispatch", async () => {
    const { adapter, transport } = createMockQuestradeAdapter();
    const original = transport.getQuotes.bind(transport);
    const getQuotes = vi
      .spyOn(transport, "getQuotes")
      .mockRejectedValueOnce(new QuestradeHttpError(401, "unauthorized"))
      .mockImplementation(original);
    const events: QuestradeRequestObservation[] = [];
    const observer: QuestradeRequestObserver = {
      observe: (event) => events.push(event),
    };

    await expect(
      adapter.getQuotes([1001, 1002], {
        observation: {
          attemptId: "10000000-0000-4000-8000-000000000004",
          observer,
        },
      }),
    ).resolves.toHaveLength(2);

    expect(getQuotes).toHaveBeenCalledTimes(2);
    expect(events.filter((event) => event.phase === "DISPATCHED")).toHaveLength(
      2,
    );
    expect(events.filter((event) => event.phase === "HTTP_401_RETRY")).toEqual([
      expect.objectContaining({
        attemptId: "10000000-0000-4000-8000-000000000004",
        operation: "QUOTE",
        requestedItems: 2,
      }),
    ]);
    const retryIndex = events.findIndex(
      (event) => event.phase === "HTTP_401_RETRY",
    );
    expect(retryIndex).toBeLessThan(
      events.findIndex(
        (event, index) => index > retryIndex && event.phase === "DISPATCHED",
      ),
    );
  });

  it("timestamps quote receipt after the transport completes", async () => {
    let now = new Date(PHASE0_NOW);
    const { adapter, transport } = createMockQuestradeAdapter(() => now);
    const original = transport.getQuotes.bind(transport);
    vi.spyOn(transport, "getQuotes").mockImplementation(async (...args) => {
      const result = await original(...args);
      now = new Date(now.getTime() + 45_000);
      return result;
    });
    const quotes = await adapter.getQuotes([1001]);
    expect(quotes[0]?.receivedAt).toEqual(now);
    expect(now.getTime()).toBe(PHASE0_NOW.getTime() + 45_000);
  });
  it("routes discovery through the same scheduler with cancellation options", async () => {
    const { adapter, rateLimiter } = createMockQuestradeAdapter();
    const controller = new AbortController();
    const schedule = vi.spyOn(rateLimiter, "schedule");
    await adapter
      .forDiscovery({ signal: controller.signal })
      .searchSymbols("BTO.TO");
    expect(schedule).toHaveBeenCalledWith(
      "P3",
      expect.any(Function),
      expect.objectContaining({ discovery: true, signal: controller.signal }),
    );
    controller.abort();
    await expect(
      adapter.forDiscovery({ signal: controller.signal }).getQuotes([1001]),
    ).rejects.toMatchObject({ code: "CANCELLED" });
  });
  it("applies a per-call discovery deadline to the shared scheduler", async () => {
    const { adapter, rateLimiter } = createMockQuestradeAdapter();
    const schedule = vi.spyOn(rateLimiter, "schedule");
    const signal = new AbortController().signal;
    const expiresAt = new Date(Date.now() + 30_000);

    await adapter.forDiscovery().getQuotes([1001], { signal, expiresAt });

    expect(schedule).toHaveBeenCalledWith(
      "P1",
      expect.any(Function),
      expect.objectContaining({ discovery: true, signal, expiresAt }),
    );
  });
  it("looks up TSX symbols and requests all quotes in one batch", async () => {
    const { adapter, transport } = createMockQuestradeAdapter();
    const searches = await Promise.all(
      ["BTO.TO", "BAM.TO", "QBR.B.TO"].map((symbol) =>
        adapter.searchSymbols(symbol),
      ),
    );
    const instruments = searches.flat();
    const quotes = await adapter.getQuotes(
      instruments.map((instrument) => instrument.symbolId),
    );

    expect(instruments.map((instrument) => instrument.symbol)).toEqual([
      "BTO.TO",
      "BAM.TO",
      "QBR.B.TO",
    ]);
    expect(quotes).toHaveLength(3);
    expect(transport.quoteBatches).toEqual([[1001, 1002, 1003]]);
    expect(
      transport.apiServersSeen.every(
        (server) => server === "https://mock-api02.iq.questrade.test/",
      ),
    ).toBe(true);
  });

  it("returns complete 1m and 5m candles without look-ahead bars", async () => {
    const { adapter } = createMockQuestradeAdapter();
    const range = {
      startTime: new Date("2026-08-24T13:30:00Z"),
      endTime: PHASE0_NOW,
    };

    const [oneMinute, fiveMinutes] = await Promise.all([
      adapter.getCandles(1001, "OneMinute", range),
      adapter.getCandles(1001, "FiveMinutes", range),
    ]);

    expect(oneMinute).toHaveLength(30);
    expect(fiveMinutes).toHaveLength(6);
    expect(fiveMinutes[0]?.volume).toBe(
      oneMinute.slice(0, 5).reduce((total, candle) => total + candle.volume, 0),
    );
    expect(oneMinute.every((candle) => candle.isComplete)).toBe(true);
    expect(fiveMinutes.every((candle) => candle.isComplete)).toBe(true);
  });

  it("represents a resolved symbol with no candle history as an empty series", async () => {
    const { adapter, transport } = createMockQuestradeAdapter();
    vi.spyOn(transport, "getCandles").mockRejectedValueOnce(
      new QuestradeHttpError(404, "candles"),
    );

    await expect(
      adapter.getCandles(1001, "OneDay", {
        startTime: new Date("2026-08-01T00:00:00Z"),
        endTime: PHASE0_NOW,
      }),
    ).resolves.toEqual([]);
  });

  it("reports TSX market status and hard-gates the delayed fixture", async () => {
    const { adapter } = createMockQuestradeAdapter();
    const [market, quotes] = await Promise.all([
      adapter.getMarket("TSX"),
      adapter.getQuotes([1001, 1003]),
    ]);

    expect(market?.status).toBe("OPEN");
    expect(quotes.find((quote) => quote.symbol === "BTO.TO")?.actionable).toBe(
      true,
    );
    expect(quotes.find((quote) => quote.symbol === "QBR.B.TO")).toMatchObject({
      dataStatus: "DELAYED",
      delaySeconds: 15,
      actionable: false,
    });
  });

  it("provides deterministic intraday and daily warm-up history for Phase 3", async () => {
    const { adapter } = createMockQuestradeAdapter();
    const range = {
      startTime: new Date("2026-06-01T00:00:00Z"),
      endTime: PHASE0_NOW,
    };

    const [oneMinute, fiveMinute, daily] = await Promise.all([
      adapter.getCandles(1001, "OneMinute", range),
      adapter.getCandles(1001, "FiveMinutes", range),
      adapter.getCandles(1001, "OneDay", range),
    ]);

    expect(
      new Set(
        oneMinute.map((candle) => candle.start.toISOString().slice(0, 10)),
      ).size,
    ).toBe(11);
    expect(oneMinute).toHaveLength(330);
    expect(fiveMinute).toHaveLength(66);
    expect(daily).toHaveLength(30);
    expect(daily.every((candle) => candle.isComplete)).toBe(true);
  });
});
