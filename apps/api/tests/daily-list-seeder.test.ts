import { describe, expect, it, vi } from "vitest";
import type { UniversePolicy } from "@tsx-scanner/contracts";
import type { Pool } from "pg";
import {
  DailyListSeeder,
  PostgresDailySeedPool,
  excludedListing,
  passesSnapshotPrefilter,
  rankDailySeedPicks,
  scoreDailySeedCandidate,
  type DailySeedPoolMember,
  type DailySeedRunRecord,
  type DailySeedRunStore,
} from "../src/universe/daily-list-seeder.js";
import { DEFAULT_US_UNIVERSE_POLICY } from "../src/universe/universe-service.js";
import type { Candle, SymbolSnapshot } from "../src/questrade/types.js";

const policy: UniversePolicy = DEFAULT_US_UNIVERSE_POLICY;
// Friday 2026-09-25, 08:50 America/New_York.
const preMarket = new Date("2026-09-25T12:50:00Z");

function dailyBars(
  symbolId: number,
  options: { lastVolume: number; lastClose: number; lastLow?: number },
): Candle[] {
  const bars: Candle[] = [];
  const end = Date.parse("2026-09-24T04:00:00Z");
  for (let index = 0; index < 60; index++) {
    const start = new Date(end - (59 - index) * 86_400_000);
    const last = index === 59;
    const close = last ? options.lastClose : 50;
    bars.push({
      symbolId,
      interval: "OneDay",
      start,
      end: new Date(start.getTime() + 86_400_000),
      open: 49,
      high: last ? Math.max(close, 51.5) : 51.5,
      low: last ? (options.lastLow ?? 48.5) : 48.5,
      close,
      volume: last ? options.lastVolume : 2_000_000,
      source: "QUESTRADE",
      isComplete: true,
    });
  }
  return bars;
}

function snapshot(symbolId: number, overrides: Partial<SymbolSnapshot> = {}) {
  return {
    symbol: `S${symbolId}`,
    symbolId,
    marketCap: 5_000_000_000,
    prevDayClosePrice: 50,
    averageVol3Months: 2_000_000,
    averageVol20Days: 2_000_000,
    securityType: "Stock",
    listingExchange: "NASDAQ",
    currency: "USD",
    description: "EXAMPLE CORP",
    isTradable: true,
    isQuotable: true,
    ...overrides,
  } satisfies SymbolSnapshot;
}

describe("daily-seed-v1 selection", () => {
  it("prefilters listings on the universe policy before any candle request", () => {
    expect(passesSnapshotPrefilter(snapshot(1), policy)).toBe(true);
    expect(
      passesSnapshotPrefilter(snapshot(1, { prevDayClosePrice: 3 }), policy),
    ).toBe(false);
    expect(
      passesSnapshotPrefilter(snapshot(1, { marketCap: 100_000_000 }), policy),
    ).toBe(false);
    expect(
      passesSnapshotPrefilter(
        snapshot(1, { averageVol3Months: 10_000 }),
        policy,
      ),
    ).toBe(false);
    expect(
      passesSnapshotPrefilter(
        snapshot(1, { description: "EXAMPLE BITCOIN ETF" }),
        policy,
      ),
    ).toBe(false);
  });

  it("ranks a high-volume close near the high above a quiet close near the low", () => {
    const active = scoreDailySeedCandidate(
      "ACTV",
      dailyBars(1, { lastVolume: 6_000_000, lastClose: 53, lastLow: 49 }),
      policy,
      preMarket,
    );
    const quiet = scoreDailySeedCandidate(
      "QUIT",
      dailyBars(2, { lastVolume: 1_500_000, lastClose: 48.6 }),
      policy,
      preMarket,
    );
    expect(active).not.toBeNull();
    expect(quiet).not.toBeNull();
    expect(active!.relativeVolume).toBe(3);
    expect(active!.aboveSma20).toBe(true);
    expect(rankDailySeedPicks([quiet!, active!], 1)).toEqual([active]);
  });

  it("ignores a partial bar for the trading date being seeded", () => {
    const bars = dailyBars(1, {
      lastVolume: 6_000_000,
      lastClose: 53,
      lastLow: 49,
    });
    const yesterday = scoreDailySeedCandidate("ACTV", bars, policy, preMarket);
    // Questrade ends the newest daily bar at the fetch time, so a US
    // pre-market bar for today arrives marked complete.
    const partialToday: Candle = {
      symbolId: 1,
      interval: "OneDay",
      start: new Date("2026-09-25T04:00:00Z"),
      end: new Date("2026-09-25T12:45:00Z"),
      open: 53.5,
      high: 54,
      low: 53.2,
      close: 53.8,
      volume: 40_000,
      source: "QUESTRADE",
      isComplete: true,
    };
    expect(
      scoreDailySeedCandidate(
        "ACTV",
        [...bars, partialToday],
        policy,
        preMarket,
        new Date("2026-09-25T04:00:00Z"),
      ),
    ).toEqual(yesterday);
  });

  it("rejects stale history", () => {
    expect(
      scoreDailySeedCandidate(
        "OLD",
        dailyBars(1, { lastVolume: 6_000_000, lastClose: 53 }),
        policy,
        new Date("2026-10-05T12:50:00Z"),
      ),
    ).toBeNull();
  });
});

describe("DailyListSeeder schedule", () => {
  const pool: DailySeedPoolMember[] = [1, 2, 3].map((id) => ({
    symbol: `S${id}`,
    symbolId: id,
    exchange: "NASDAQ",
    description: "EXAMPLE CORP",
  }));

  function seeder(
    now: { value: Date },
    list: string[] = [],
    store?: DailySeedRunStore,
  ) {
    const apply = vi.fn(async (_symbols: string[], _note: string) => {});
    const getCandles = vi.fn(async (symbolId: number) =>
      dailyBars(symbolId, {
        lastVolume: 2_000_000 * symbolId,
        lastClose: 52,
      }),
    );
    const instance = new DailyListSeeder({
      marketId: "US_EQUITIES",
      enabled: true,
      runAt: "08:45",
      count: 2,
      pool: { load: async () => pool },
      marketData: {
        getSymbolSnapshots: async (ids) => ids.map((id) => snapshot(id)),
        getCandles,
      },
      policy: () => policy,
      currentList: async () => list,
      apply,
      store,
      clock: () => now.value,
    });
    return { instance, apply, getCandles };
  }

  it("waits for the run time, then adds the top picks once per trading date", async () => {
    const now = { value: new Date("2026-09-25T12:30:00Z") }; // 08:30 ET
    const { instance, apply } = seeder(now);
    expect(await instance.tick()).toBeNull();
    now.value = preMarket;
    const result = await instance.tick();
    expect(result?.status).toBe("APPLIED");
    expect(apply).toHaveBeenCalledOnce();
    expect(apply.mock.calls[0]![0]).toEqual(["S3", "S2"]);
    expect(await instance.tick()).toBeNull();
  });

  it("leaves an operator list unchanged and skips weekends", async () => {
    const now = { value: preMarket };
    const present = seeder(now, ["OWN"]);
    expect((await present.instance.tick())?.status).toBe(
      "SKIPPED_LIST_PRESENT",
    );
    expect(present.apply).not.toHaveBeenCalled();
    expect(present.getCandles).not.toHaveBeenCalled();

    const weekend = seeder({ value: new Date("2026-09-26T12:50:00Z") });
    expect(await weekend.instance.tick()).toBeNull();
  });

  it("skips when an operator wins the database race after the final list check", async () => {
    const { instance, apply } = seeder({ value: preMarket });
    apply.mockRejectedValue(new Error("DAILY_SEED_LIST_NOT_EMPTY"));
    expect((await instance.tick())?.status).toBe("SKIPPED_LIST_PRESENT");
    expect(apply).toHaveBeenCalledWith(
      ["S3", "S2"],
      expect.any(String),
      "2026-09-25",
    );
    expect(await instance.tick()).toBeNull();
  });

  it("previews without editing the list", async () => {
    const { instance, apply } = seeder({ value: preMarket });
    const result = await instance.preview();
    expect(result.status).toBe("PREVIEW");
    expect(result.selection?.picks.map((pick) => pick.symbol)).toEqual([
      "S3",
      "S2",
    ]);
    expect(apply).not.toHaveBeenCalled();
  });

  it("records outcomes and restores today's result after a restart", async () => {
    const records: DailySeedRunRecord[] = [];
    const store: DailySeedRunStore = {
      record: async (run) => void records.push(run),
      latest: async (_marketId, tradingDate) =>
        records.filter((run) => run.tradingDate === tradingDate).at(-1) ?? null,
    };
    const now = { value: preMarket };
    await seeder(now, [], store).instance.tick();
    expect(records.map((run) => [run.status, run.symbols])).toEqual([
      ["APPLIED", ["S3", "S2"]],
    ]);

    const restarted = seeder(now, [], store);
    const status = await restarted.instance.status();
    expect(status.doneDate).toBe("2026-09-25");
    expect(status.lastResult?.status).toBe("APPLIED");
    expect(status.latestSelection?.picks).toHaveLength(2);
    expect(await restarted.instance.tick()).toBeNull();
    expect(restarted.apply).not.toHaveBeenCalled();
  });

  it("adds the top of today's ranking to an existing list", async () => {
    const { instance, apply } = seeder({ value: preMarket }, ["OWN"]);
    await expect(instance.addTop(1)).rejects.toThrow(/preview first/);
    await instance.preview();
    expect(await instance.addTop(1)).toEqual(["S3"]);
    expect(apply).toHaveBeenCalledWith(["S3"], expect.any(String));
  });

  it("reports today's schedule and the next session's run", async () => {
    const { instance } = seeder({ value: new Date("2026-09-25T12:30:00Z") });
    const before = await instance.status();
    expect(before.scheduledAt).toBe("2026-09-25T12:45:00.000Z");
    expect(before.nextRunAt).toBe("2026-09-25T12:45:00.000Z");
    expect(before.latestRunAt).toBe("2026-09-25T18:30:00.000Z");
    const weekend = seeder({ value: new Date("2026-09-26T15:00:00Z") });
    const saturday = await weekend.instance.status();
    expect(saturday.session).toBeNull();
    expect(saturday.nextRunAt).toBe("2026-09-28T12:45:00.000Z");
  });

  it("reads the pool once per trading date", async () => {
    const load = vi.fn(async () => pool);
    const instance = new DailyListSeeder({
      marketId: "US_EQUITIES",
      enabled: true,
      runAt: "08:45",
      count: 2,
      pool: { load },
      marketData: {
        getSymbolSnapshots: async (ids) => ids.map((id) => snapshot(id)),
        getCandles: async (symbolId: number) =>
          dailyBars(symbolId, { lastVolume: 2_000_000, lastClose: 52 }),
      },
      policy: () => policy,
      currentList: async () => [],
      apply: async () => {},
      clock: () => preMarket,
    });
    expect(await instance.poolSize()).toBe(3);
    await instance.preview();
    expect(load).toHaveBeenCalledOnce();
  });
});

describe("PostgresDailySeedPool", () => {
  it("adds the catalog name so CDRs described as the company are recognized", async () => {
    const query = vi.fn(async (sql: string) =>
      sql.includes("discovery_symbol_mapping")
        ? {
            rows: [
              {
                provider_code: "META",
                symbol: "META.TO",
                symbol_id: "39309226",
                exchange: "TSX",
                description: "META PLATFORMS INC",
              },
              {
                provider_code: "SHOP",
                symbol: "SHOP.TO",
                symbol_id: "9975421",
                exchange: "TSX",
                description: "SHOPIFY INC",
              },
            ],
          }
        : {
            rows: [
              { provider_code: "META", name: "Meta CDR (CAD Hedged)" },
              { provider_code: "SHOP", name: "Shopify Inc" },
            ],
          },
    );
    const members = await new PostgresDailySeedPool({
      query,
    } as unknown as Pool).load("CA_TSX");
    expect(members).toEqual([
      {
        symbol: "META.TO",
        symbolId: 39309226,
        exchange: "TSX",
        description: "META PLATFORMS INC Meta CDR (CAD Hedged)",
      },
      {
        symbol: "SHOP.TO",
        symbolId: 9975421,
        exchange: "TSX",
        description: "SHOPIFY INC Shopify Inc",
      },
    ]);
    expect(excludedListing(members[0]!.description)).toBe(true);
    expect(excludedListing(members[1]!.description)).toBe(false);
  });
});
