import { describe, expect, it, vi } from "vitest";
import type {
  DailySeedRescanResult,
  DailySeedRunResult,
} from "@tsx-scanner/contracts";
import {
  DailySeedRescan,
  completedBarBoundary,
  measureOpeningActivity,
  type DailySeedRescanStore,
} from "../src/universe/daily-seed-rescan.js";
import { DEFAULT_UNIVERSE_POLICY } from "../src/universe/universe-service.js";
import type { Candle, SymbolSnapshot } from "../src/questrade/types.js";

const TODAY = "2026-09-25";
// 09:30 and 09:55 America/Toronto on Friday 2026-09-25.
const OPEN = new Date("2026-09-25T13:30:00Z");
const RUN = new Date("2026-09-25T13:55:20Z");
const PRIOR_DATES = [
  "2026-09-11",
  "2026-09-14",
  "2026-09-15",
  "2026-09-16",
  "2026-09-17",
  "2026-09-18",
  "2026-09-21",
  "2026-09-22",
  "2026-09-23",
  "2026-09-24",
];

function bar(
  symbolId: number,
  start: string,
  values: { open?: number; close?: number; volume: number },
): Candle {
  const startTime = new Date(start);
  return {
    symbolId,
    interval: "FiveMinutes",
    start: startTime,
    end: new Date(startTime.getTime() + 5 * 60_000),
    open: values.open ?? 20,
    high: Math.max(values.open ?? 20, values.close ?? 20) + 0.1,
    low: Math.min(values.open ?? 20, values.close ?? 20) - 0.1,
    close: values.close ?? 20,
    volume: values.volume,
    source: "QUESTRADE",
    isComplete: true,
  };
}

/** Prior sessions trade 10k shares per five minutes; today trades `todayVolume`. */
function sessionBars(
  symbolId: number,
  todayVolume: number,
  todayClose: number,
): Candle[] {
  const bars: Candle[] = [];
  for (const date of PRIOR_DATES) {
    for (let slot = 0; slot < 8; slot++) {
      const minutes = 30 + slot * 5;
      const hour = 13 + Math.floor(minutes / 60);
      const minute = String(minutes % 60).padStart(2, "0");
      bars.push(
        bar(symbolId, `${date}T${hour}:${minute}:00Z`, { volume: 10_000 }),
      );
    }
  }
  for (const [index, time] of [
    "13:30",
    "13:35",
    "13:40",
    "13:45",
    "13:50",
  ].entries())
    bars.push(
      bar(symbolId, `${TODAY}T${time}:00Z`, {
        open: index === 0 ? 20 : undefined,
        close: index === 4 ? todayClose : 20,
        volume: todayVolume,
      }),
    );
  // The in-progress bar: Questrade ends it at the fetch time.
  bars.push({
    ...bar(symbolId, `${TODAY}T13:55:00Z`, { volume: 999_999 }),
    end: RUN,
  });
  return bars;
}

describe("measureOpeningActivity", () => {
  it("compares volume since the open with the same minutes of prior sessions", () => {
    const activity = measureOpeningActivity(
      "MOVE.TO",
      sessionBars(1, 30_000, 20.5),
      {
        tradingDate: TODAY,
        sessionOpen: OPEN,
        boundary: completedBarBoundary(RUN),
        timezone: "America/Toronto",
        previousClose: 19.5,
      },
    );
    // Five completed bars today (the in-progress 09:55 bar is ignored) against
    // the same five slots of ten prior sessions.
    expect(activity).toEqual({
      symbol: "MOVE.TO",
      relativeVolume: 3,
      changeFromOpenPct: 2.5,
      gapPct: 2.56,
      price: 20.5,
    });
  });

  it("needs five prior sessions and a completed bar today", () => {
    const bars = sessionBars(1, 30_000, 20.5).filter(
      (value) => value.start >= new Date("2026-09-22T00:00:00Z"),
    );
    expect(
      measureOpeningActivity("MOVE.TO", bars, {
        tradingDate: TODAY,
        sessionOpen: OPEN,
        boundary: completedBarBoundary(RUN),
        timezone: "America/Toronto",
        previousClose: null,
      }),
    ).toBeNull();
    expect(completedBarBoundary(RUN).toISOString()).toBe(
      "2026-09-25T13:55:00.000Z",
    );
  });
});

describe("DailySeedRescan", () => {
  const pool = [1, 2, 3].map((id) => ({
    symbol: `S${id}.TO`,
    symbolId: id,
    exchange: "TSX",
    description: "EXAMPLE CORP",
  }));
  const snapshot = (id: number): SymbolSnapshot => ({
    symbol: `S${id}.TO`,
    symbolId: id,
    marketCap: 5_000_000_000,
    prevDayClosePrice: 20,
    averageVol3Months: 2_000_000,
    averageVol20Days: 2_000_000,
    securityType: "Stock",
    listingExchange: "TSX",
    currency: "CAD",
    description: "EXAMPLE CORP",
    isTradable: true,
    isQuotable: true,
  });
  // S1: 3x volume, +2.5%. S2: 3x volume, +0.2% (below the move). S3: 1.2x.
  const barsFor: Record<number, [number, number]> = {
    1: [30_000, 20.5],
    2: [30_000, 20.04],
    3: [12_000, 21],
  };

  function rescan(
    outcome: DailySeedRunResult["status"] | null,
    list: string[],
    store?: DailySeedRescanStore,
    now: Date = RUN,
  ) {
    const apply = vi.fn(async (_symbols: string[], _note: string) => {});
    const getCandles = vi.fn(async (symbolId: number) =>
      sessionBars(symbolId, ...barsFor[symbolId]!),
    );
    const instance = new DailySeedRescan({
      marketId: "CA_TSX",
      enabled: true,
      runAt: "09:55",
      maxAdds: 5,
      maxCandidates: 150,
      seed: {
        poolMembers: async () => pool,
        todayOutcome: async () =>
          outcome
            ? {
                status: outcome,
                selection: null,
                error: null,
                finishedAt: "2026-09-25T12:46:00.000Z",
                symbols: list,
              }
            : null,
      },
      marketData: {
        getSymbolSnapshots: async (ids) => ids.map(snapshot),
        getCandles,
      },
      policy: () => DEFAULT_UNIVERSE_POLICY,
      currentList: async () => list,
      apply,
      store,
      clock: () => now,
    });
    return { instance, apply, getCandles };
  }

  it("retries a complete candle outage instead of finishing with no picks", async () => {
    const now = new Date(RUN);
    const { instance, apply, getCandles } = rescan(
      "APPLIED",
      ["BB.TO"],
      undefined,
      now,
    );
    getCandles.mockRejectedValue(new Error("provider unavailable"));
    expect((await instance.tick())?.status).toBe("FAILED");
    expect(apply).not.toHaveBeenCalled();
    now.setTime(now.getTime() + 60_000);
    expect(await instance.tick()).toBeNull();
    expect(getCandles).toHaveBeenCalledTimes(3);
    getCandles.mockImplementation(async (id) => [
      ...sessionBars(id, ...barsFor[id]!).filter(
        (value) => value.start < new Date(`${TODAY}T13:55:00Z`),
      ),
      bar(id, `${TODAY}T13:55:00Z`, {
        volume: barsFor[id]![0],
        close: barsFor[id]![1],
      }),
    ]);
    now.setTime(now.getTime() + 4 * 60_000);
    expect((await instance.tick())?.status).toBe("APPLIED");
    expect(apply).toHaveBeenCalledOnce();
  });

  it("keeps genuine empty candle history as no picks", async () => {
    const { instance, apply, getCandles } = rescan("APPLIED", ["BB.TO"]);
    getCandles.mockResolvedValue([]);
    expect((await instance.tick())?.status).toBe("NO_PICKS");
    expect(apply).not.toHaveBeenCalled();
    expect(await instance.tick()).toBeNull();
  });

  it("reports operator ownership conflicts as skipped without retrying", async () => {
    const { instance, apply } = rescan("APPLIED", ["BB.TO"]);
    apply.mockRejectedValue(new Error("DAILY_SEED_RESCAN_LIST_NOT_OWNED"));
    expect((await instance.tick())?.status).toBe("SKIPPED_LIST_PRESENT");
    expect(await instance.tick()).toBeNull();
    expect(apply).toHaveBeenCalledOnce();
  });

  it("keeps a lost receipt visible without claiming a second batch", async () => {
    const { instance, apply } = rescan("APPLIED", ["BB.TO"]);
    apply.mockRejectedValue(
      new Error(
        "DAILY_SEED_RESCAN_ALREADY_APPLIED: original receipt unavailable",
      ),
    );
    const result = await instance.tick();
    expect(result?.status).toBe("FAILED");
    expect(result?.added).toEqual([]);
    expect(result?.error).toContain("original receipt unavailable");
  });

  it("adds the passing opening movers to a list the seed filled", async () => {
    const records: DailySeedRescanResult[] = [];
    const store: DailySeedRescanStore = {
      recordRescan: async (record) => void records.push(record.result),
      latestRescan: async () => records.at(-1) ?? null,
    };
    const { instance, apply } = rescan("APPLIED", ["BB.TO"], store);
    const result = await instance.tick();
    expect(result?.status).toBe("APPLIED");
    expect(apply).toHaveBeenCalledWith(["S1.TO"], expect.any(String), TODAY);
    expect(
      result?.candidates.map((value) => [value.symbol, value.passed]),
    ).toEqual([
      ["S1.TO", true],
      ["S2.TO", false],
      ["S3.TO", false],
    ]);
    expect(result?.thresholds).toEqual({
      minimumRelativeVolume: 1.5,
      minimumChangeFromOpenPct: 0.75,
    });
    expect(records).toHaveLength(1);

    // A restart restores today's result and does not rescan again.
    const restarted = rescan("APPLIED", ["BB.TO", "S1.TO"], store);
    expect((await restarted.instance.status()).result?.added).toEqual([
      "S1.TO",
    ]);
    expect(await restarted.instance.tick()).toBeNull();
    expect(restarted.apply).not.toHaveBeenCalled();
  });

  it("leaves an operator list unchanged", async () => {
    const { instance, apply } = rescan("SKIPPED_LIST_PRESENT", ["OWN.TO"]);
    expect((await instance.tick())?.status).toBe("SKIPPED_LIST_PRESENT");
    expect(apply).not.toHaveBeenCalled();
  });

  it("waits for its run time and stops after the window", async () => {
    const early = rescan(
      "APPLIED",
      [],
      undefined,
      new Date("2026-09-25T13:40:00Z"),
    );
    expect(await early.instance.tick()).toBeNull();
    const late = rescan(
      "APPLIED",
      [],
      undefined,
      new Date("2026-09-25T15:00:00Z"),
    );
    expect(await late.instance.tick()).toBeNull();
    expect(late.apply).not.toHaveBeenCalled();
  });
});
