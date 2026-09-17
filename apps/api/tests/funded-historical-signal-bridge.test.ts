import { describe, expect, it, vi } from "vitest";
import type {
  CreateBacktest,
  StrategyStateEvent,
} from "@tsx-scanner/contracts";
import {
  buildFundedHistoricalObservations,
  ensureFundedHistoricalProfiles,
  fundedHistoricalConfigVersion,
  fundedHistoricalProfiles,
} from "../src/paper-bot/funded-historical-signal-bridge.js";

const instrumentId = "10000000-0000-4000-8000-000000000081";
const profileId = "10000000-0000-4000-8000-000000000082";
const parameters = {
  scoreCutoff: 70,
  rvolAtTimeMin: 1.5,
} as CreateBacktest["parameters"];

function event(
  overrides: Partial<StrategyStateEvent> = {},
): StrategyStateEvent {
  return {
    kind: "SETUP",
    marketId: "CA_TSX",
    eventId: "10000000-0000-4000-8000-000000000083",
    eventType: "STRATEGY_STATE_CHANGED",
    previousState: "FORMING",
    state: "READY",
    instrumentId,
    symbol: "ABC.TO",
    timestamp: "2026-09-08T14:00:00.000Z",
    profileId,
    profileName: "ORB",
    strategy: "ORB_RETEST",
    strategyVersion: "1.0.0",
    configVersion: "config-v1",
    score: 85,
    setupScore: 85,
    scoreVersion: "v2",
    scoreComponents: {
      pattern: 1,
      confirmation: 1,
      structure: 1,
      liquidity: 1,
      timing: 1,
      penalties: 0,
    },
    scoreExplanation: [],
    setupInstanceId: "10000000-0000-4000-8000-000000000084",
    reasonCodes: [],
    entryReference: 10,
    stopReference: 9.5,
    targetReference: 11,
    estimatedRr: 2,
    featureSnapshot: { atr14: 0.25 },
    signalSemanticsVersion: "setup-semantics-v2",
    ...overrides,
  } as StrategyStateEvent;
}

describe("funded historical signal bridge", () => {
  it("derives deterministic profile identity and a namespaced config version", () => {
    const first = fundedHistoricalConfigVersion(parameters);
    expect(first).toBe(fundedHistoricalConfigVersion({ ...parameters }));
    expect(first).toMatch(/^funded-historical:[a-f0-9]{12}$/);
    const profiles = fundedHistoricalProfiles("CA_TSX", ["ORB_RETEST"], first);
    expect(fundedHistoricalProfiles("CA_TSX", ["ORB_RETEST"], first)).toEqual(
      profiles,
    );
    expect(profiles[0]).toMatchObject({
      strategy: "ORB_RETEST",
      configVersion: `${first}:ORB_RETEST`,
    });
    const both = fundedHistoricalProfiles(
      "CA_TSX",
      ["ORB_RETEST", "VWAP_HOLD"],
      first,
    );
    expect(new Set(both.map((profile) => profile.configVersion)).size).toBe(2);
  });

  it("maps only READY events, deduplicates lifecycles, and records eligibility", () => {
    const configVersion = fundedHistoricalConfigVersion(parameters);
    const profiles = fundedHistoricalProfiles(
      "CA_TSX",
      ["ORB_RETEST"],
      configVersion,
    );
    const observations = buildFundedHistoricalObservations({
      runId: "run-1",
      profiles,
      events: [
        event(),
        event(),
        event({
          eventId: "10000000-0000-4000-8000-000000000085",
          setupInstanceId: "10000000-0000-4000-8000-000000000087",
          score: 60,
        }),
        event({
          eventId: "10000000-0000-4000-8000-000000000086",
          state: "FORMING",
        }),
      ],
      parameters,
      scoreCutoff: 70,
    });
    expect(observations).toHaveLength(2);
    expect(observations[0]).toMatchObject({
      runId: "run-1",
      profileConfigId: profiles[0]!.profileConfigId,
      configVersion: profiles[0]!.configVersion,
      eligibilityStatus: "ELIGIBLE",
      eligibilityReason: null,
    });
    expect(observations[1]).toMatchObject({
      eligibilityStatus: "BELOW_SCORE_CUTOFF",
      eligibilityReason: "SCORE_CUTOFF",
    });
    expect(
      (observations[0]!.sourceEventPayload as { replayLineage: unknown })
        .replayLineage,
    ).toMatchObject({
      type: "FUNDED_HISTORICAL_REPLAY",
      runId: "run-1",
    });
  });

  it("fails closed when signal semantic provenance is missing or unknown", () => {
    const profiles = fundedHistoricalProfiles("CA_TSX", ["ORB_RETEST"], "v");
    for (const signalSemanticsVersion of [undefined, "", "UNKNOWN"])
      expect(() =>
        buildFundedHistoricalObservations({
          runId: "run-1",
          profiles,
          events: [event({ signalSemanticsVersion })],
          parameters,
          scoreCutoff: 0,
        }),
      ).toThrow(/signal semantic provenance/);
  });

  it("ensures deterministic disabled profiles and rejects config collisions", async () => {
    const queries: { sql: string; values: unknown[] }[] = [];
    const configOwner = new Map<string, string>();
    const pool = {
      query: vi.fn(async (sql: string, values: unknown[] = []) => {
        queries.push({ sql, values });
        if (sql.includes("FROM strategy_definition"))
          return { rows: [{ id: "definition-1" }] };
        if (
          sql.includes("INSERT INTO scanner_profile_config") &&
          !configOwner.has(values[2] as string)
        )
          configOwner.set(values[2] as string, values[0] as string);
        if (sql.includes("WHERE config_version=$1"))
          return {
            rows: configOwner.has(values[0] as string)
              ? [{ id: configOwner.get(values[0] as string) }]
              : [],
          };
        return { rows: [] };
      }),
    };
    const profiles = fundedHistoricalProfiles(
      "US_EQUITIES",
      ["ORB_RETEST"],
      "funded-historical:abc",
    );
    await ensureFundedHistoricalProfiles(
      pool as never,
      profiles,
      "US_EQUITIES",
      parameters,
    );
    const profileInsert = queries.find((entry) =>
      entry.sql.includes("INSERT INTO scanner_profile "),
    );
    expect(profileInsert?.values).toEqual([
      profiles[0]!.profileId,
      profiles[0]!.profileName,
      "definition-1",
      "US_EQUITIES",
    ]);

    configOwner.set(profiles[0]!.configVersion, "other-config");
    await expect(
      ensureFundedHistoricalProfiles(
        pool as never,
        profiles,
        "US_EQUITIES",
        parameters,
      ),
    ).rejects.toThrow(/owned by another profile/);
  });

  it("requires a SETUP strategy definition before creating profiles", async () => {
    const pool = {
      query: vi.fn(async (sql: string) =>
        sql.includes("FROM strategy_definition") ? { rows: [] } : { rows: [] },
      ),
    };
    await expect(
      ensureFundedHistoricalProfiles(
        pool as never,
        fundedHistoricalProfiles("CA_TSX", ["ORB_RETEST"], "v"),
        "CA_TSX",
        parameters,
      ),
    ).rejects.toThrow(/SETUP strategy definition/);
  });
});
