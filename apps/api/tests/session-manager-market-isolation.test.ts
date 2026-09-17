import { describe, expect, it } from "vitest";
import { MarketSessionManager } from "../src/market-data/session-manager.js";
import type { Market, MarketDataAdapter } from "../src/questrade/types.js";

const now = new Date("2026-09-03T14:00:00.000Z");

function market(name: string, start: string, end: string): Market {
  return {
    name,
    currency: name === "TSX" ? "CAD" : "USD",
    startTime: new Date(start),
    endTime: new Date(end),
    extendedStartTime: new Date("2026-09-03T12:00:00.000Z"),
    extendedEndTime: new Date("2026-09-03T22:00:00.000Z"),
    status: "OPEN",
  };
}

describe("MarketSessionManager market isolation", () => {
  it.each(["CA_TSX", "US_EQUITIES"] as const)(
    "%s stops scanning at the provider's early close while its peer stays open",
    async (closedMarket) => {
      const clock = () => new Date("2026-11-27T18:30:00Z");
      const adapter = {
        getMarket: async (name: string) => ({
          ...market(
            name,
            "2026-11-27T14:30:00Z",
            name === (closedMarket === "CA_TSX" ? "TSX" : "US")
              ? "2026-11-27T18:00:00Z"
              : "2026-11-27T21:00:00Z",
          ),
          extendedStartTime: new Date("2026-11-27T12:00:00Z"),
          extendedEndTime: new Date("2026-11-28T01:00:00Z"),
        }),
      } as MarketDataAdapter;
      const snapshots = await Promise.all(
        (["CA_TSX", "US_EQUITIES"] as const).map(async (id) => {
          const manager = new MarketSessionManager(
            adapter,
            clock,
            id === "CA_TSX" ? "TSX" : "US",
            {
              timezone:
                id === "CA_TSX" ? "America/Toronto" : "America/New_York",
              openingRange: { start: "09:30", end: "09:45" },
              scanning: { start: "09:45", end: "16:00" },
              entries: {
                preferredStart: "10:00",
                preferredEnd: "11:30",
                hardEnd: "16:00",
              },
            },
            id,
          );
          return manager.initialize();
        }),
      );
      expect(
        snapshots.find((value) => value.marketId === closedMarket),
      ).toMatchObject({
        marketStatus: "AFTER_HOURS",
        phase: "AFTER_HOURS",
        scanningEnabled: false,
        preferredEntriesEnabled: false,
        newEntriesAllowed: false,
      });
      expect(
        snapshots.find((value) => value.marketId !== closedMarket),
      ).toMatchObject({
        marketStatus: "OPEN",
        phase: "ACTIVE_SCAN",
        scanningEnabled: true,
        newEntriesAllowed: true,
      });
    },
  );
  it("keeps session identity and local policy independent per market", async () => {
    const adapter = {
      getMarket: async (name: string) =>
        name === "TSX"
          ? market(
              "TSX",
              "2026-09-03T13:30:00.000Z",
              "2026-09-03T20:00:00.000Z",
            )
          : market(
              "US",
              "2026-09-03T13:30:00.000Z",
              "2026-09-03T20:00:00.000Z",
            ),
    } as MarketDataAdapter;
    const tsx = new MarketSessionManager(adapter, () => now, "TSX", {
      timezone: "America/Toronto",
      openingRange: { start: "09:30", end: "09:45" },
      scanning: { start: "09:45", end: "16:00" },
      entries: {
        preferredStart: "10:00",
        preferredEnd: "11:30",
        hardEnd: "16:00",
      },
    });
    const us = new MarketSessionManager(
      adapter,
      () => now,
      "US",
      {
        timezone: "America/New_York",
        openingRange: { start: "09:30", end: "09:45" },
        scanning: { start: "09:45", end: "16:00" },
        entries: {
          preferredStart: "10:00",
          preferredEnd: "11:30",
          hardEnd: "16:00",
        },
      },
      "US_EQUITIES",
    );

    const [tsxSnapshot, usSnapshot] = await Promise.all([
      tsx.initialize(),
      us.initialize(),
    ]);
    expect(tsxSnapshot.marketId).toBe("CA_TSX");
    expect(usSnapshot.marketId).toBe("US_EQUITIES");
    expect(tsx.getPolicy().timezone).toBe("America/Toronto");
    expect(us.getPolicy().timezone).toBe("America/New_York");
  });
});
