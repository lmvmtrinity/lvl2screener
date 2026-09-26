import { describe, expect, it } from "vitest";
import type { FrozenCoverageRecipe } from "@tsx-scanner/contracts";
import { contentHash } from "../src/backtests/research-coverage.js";
import {
  calendarPolicyHashFor,
  legacyCalendarPolicyHash,
} from "../src/universe/market-calendar.js";
import { PostgresResearchCoverageSource } from "../src/backtests/research-coverage-source.js";

const marketId = "US_EQUITIES" as const;
const inputCutoff = "2026-09-12T00:00:00.000Z";
const sessionDate = "2026-11-27";
const manifestHash = "a".repeat(64);
const instrumentId = "10000000-0000-4000-8000-000000000001";

function recipe(calendarPolicyHash: string): FrozenCoverageRecipe {
  const replayPolicy = {
    marketId,
    timezone: "America/New_York" as const,
    openingRange: { start: "09:30", end: "09:45" },
    scanning: { start: "09:30", end: "16:00" },
    entries: {
      preferredStart: "09:45",
      preferredEnd: "11:30",
      hardEnd: "15:30",
    },
  };
  return {
    version: "research-coverage-recipe-v2",
    marketId,
    engineRevision: "0".repeat(40),
    runtimeFingerprint: "1".repeat(64),
    featureVersion: "fixture",
    sessionDates: [sessionDate],
    inputCutoff,
    streamRequirements: [
      {
        timeframe: "OneMinute",
        warmupDays: 20,
        requiredWarmupBars: 20,
        includeInSession: true,
      },
    ],
    maxQuoteGapMs: 30_000,
    replayPolicy,
    replayPolicyHash: contentHash(replayPolicy),
    membershipPolicyHash: "2".repeat(64),
    calendarPolicyHash,
  };
}

function fakePool() {
  const clientQueries: Array<{ text: string; values?: unknown[] }> = [];
  const client = {
    query: async (text: string, values?: unknown[]) => {
      clientQueries.push({ text, values });
      if (text.includes("FROM universe_refresh_run"))
        return {
          rows: [
            {
              id: "20000000-0000-4000-8000-000000000001",
              policy: {},
              started_at: new Date("2026-11-27T12:00:00.000Z"),
              completed_at: new Date("2026-11-27T12:01:00.000Z"),
            },
          ],
        };
      if (text.includes("FROM universe_membership"))
        return {
          rows: [
            {
              instrument_id: instrumentId,
              symbol: "FIXTURE",
              eligible: true,
              sector: null,
            },
          ],
        };
      if (text.includes("FROM instrument")) return { rows: [] };
      if (text.startsWith("SELECT instrument_id,timestamp"))
        return { rows: [] };
      if (text.startsWith("SELECT instrument_id,timeframe"))
        return { rows: [] };
      return { rows: [] };
    },
    release: () => undefined,
  };
  return {
    queries: clientQueries,
    pool: {
      query: async () => ({
        rows: [
          {
            market_id: marketId,
            manifest: { plan: { expectedSessions: [sessionDate] } },
          },
        ],
      }),
      connect: async () => client,
    },
  };
}

describe("calendar-bound research coverage extraction", () => {
  it("uses the exact early-close boundary and full source hash for a new recipe", async () => {
    const fixture = fakePool();
    const source = new PostgresResearchCoverageSource(fixture.pool as never);
    const frozen = await source.readFrozenInputs({
      marketId,
      manifestHash,
      inputCutoff,
      sessionDates: [sessionDate],
      recipe: recipe(
        calendarPolicyHashFor({
          marketId,
          timezone: "America/New_York",
          sessionDates: [sessionDate],
          inputCutoff,
        }),
      ),
    });
    expect(frozen.expected[0]?.calendarSourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(frozen.expected[0]?.windowStart).toBe("2026-11-27T14:30:00.000Z");
    expect(frozen.expected[0]?.windowEnd).toBe("2026-11-27T18:00:00.000Z");
    const boundaryQueries = fixture.queries.filter((value) =>
      value.text.includes("FROM quote_snapshot"),
    );
    expect(boundaryQueries.length).toBeGreaterThan(0);
    expect(
      boundaryQueries.every(
        (value) =>
          (value.values?.[2] as Date).toISOString() ===
          "2026-11-27T18:00:00.000Z",
      ),
    ).toBe(true);
  });

  it("keeps the exact old generic recipe on the legacy unproven path", async () => {
    const fixture = fakePool();
    const source = new PostgresResearchCoverageSource(fixture.pool as never);
    const frozen = await source.readFrozenInputs({
      marketId,
      manifestHash,
      inputCutoff,
      sessionDates: [sessionDate],
      recipe: recipe(legacyCalendarPolicyHash("America/New_York")),
    });
    expect(frozen.expected[0]?.calendarSourceHash).toBeNull();
    expect(frozen.expected[0]?.windowEnd).toBe("2026-11-27T21:00:00.000Z");
  });

  it("rejects a changed nonlegacy frozen calendar hash visibly", async () => {
    const source = new PostgresResearchCoverageSource(fakePool().pool as never);
    await expect(
      source.readFrozenInputs({
        marketId,
        manifestHash,
        inputCutoff,
        sessionDates: [sessionDate],
        recipe: recipe("f".repeat(64)),
      }),
    ).rejects.toThrow("COVERAGE_CALENDAR_POLICY_HASH_MISMATCH");
  });

  it("rejects a recipe whose market identity differs from the request", async () => {
    const source = new PostgresResearchCoverageSource(fakePool().pool as never);
    const mismatched = {
      ...recipe(
        calendarPolicyHashFor({
          marketId,
          timezone: "America/New_York",
          sessionDates: [sessionDate],
          inputCutoff,
        }),
      ),
      marketId: "CA_TSX" as const,
    };
    await expect(
      source.readFrozenInputs({
        marketId,
        manifestHash,
        inputCutoff,
        sessionDates: [sessionDate],
        recipe: mismatched,
      }),
    ).rejects.toThrow("COVERAGE_CALENDAR_MARKET_MISMATCH");
  });
});
