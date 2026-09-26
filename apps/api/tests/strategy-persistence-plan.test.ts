import { describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import type {
  StrategyEvaluation,
  StrategyStateEvent,
  ContextEvaluation,
} from "@tsx-scanner/contracts";
import { PostgresStrategySignalStore } from "../src/market-data/strategy-repository.js";

const instrumentId = "11111111-1111-4111-8111-111111111111";
const profileId = "22222222-2222-4222-8222-222222222222";

function evaluation(timestamp: string, state = "WATCH"): StrategyEvaluation {
  return {
    marketId: "CA_TSX",
    instrumentId,
    profileId,
    strategyVersion: "1.0.0",
    configVersion: "v1",
    timestamp,
    state,
    featureSnapshot: {
      marketId: "CA_TSX",
      instrumentId,
      timestamp,
      featureVersion: "v1",
    },
  } as StrategyEvaluation;
}

function context(timestamp: string, status = "NEUTRAL"): ContextEvaluation {
  return {
    marketId: "CA_TSX",
    instrumentId,
    profileId,
    signalVersion: "1.0.0",
    configVersion: "v1",
    timestamp,
    status,
    featureSnapshot: {
      marketId: "CA_TSX",
      instrumentId,
      timestamp,
      featureVersion: "v1",
    },
  } as ContextEvaluation;
}

describe("strategy persistence plan", () => {
  it("writes first observation, changes, events and heartbeat, and advances only after commit", async () => {
    const queries: string[] = [];
    const client = {
      query: async (sql: string) => {
        queries.push(sql);
        return {
          rows: sql.includes("INSERT INTO") ? [{ inserted: true }] : [],
        };
      },
      release: () => undefined,
    } as unknown as PoolClient;
    const store = new PostgresStrategySignalStore(
      { connect: async () => client } as unknown as Pool,
      undefined,
      60_000,
    );
    const t0 = "2026-09-24T14:00:00.000Z";
    const t1 = "2026-09-24T14:00:02.000Z";
    const t2 = "2026-09-24T14:01:00.000Z";
    expect(
      store.planPersistence([evaluation(t0)], [], [context(t0)]).evaluations,
    ).toHaveLength(1);
    await store.saveStrategyResults([evaluation(t0)], [], [context(t0)]);
    expect(queries.at(-1)).toBe("COMMIT");
    expect(store.planPersistence([evaluation(t1)], [], [context(t1)])).toEqual({
      evaluations: [],
      contexts: [],
    });
    const rescored = { ...evaluation(t1), score: 72 } as StrategyEvaluation;
    const rescoredContext = {
      ...context(t1),
      contextScore: 64,
    } as ContextEvaluation;
    expect(store.planPersistence([rescored], [], [rescoredContext])).toEqual({
      evaluations: [rescored],
      contexts: [rescoredContext],
    });
    const changed = store.planPersistence(
      [evaluation(t1, "READY")],
      [],
      [context(t1, "STRONG")],
    );
    expect(changed.evaluations).toHaveLength(1);
    expect(changed.contexts).toHaveLength(1);
    expect(
      store.planPersistence(
        [evaluation(t1)],
        [evaluation(t1) as StrategyStateEvent],
        [],
      ).evaluations,
    ).toHaveLength(1);
    expect(
      store.planPersistence([evaluation(t2)], [], [context(t2)]).evaluations,
    ).toHaveLength(1);
  });

  it("keeps the old every poll behavior at zero heartbeat", async () => {
    const store = new PostgresStrategySignalStore({} as Pool, undefined, 0);
    expect(
      store.planPersistence([evaluation("2026-09-24T14:00:00Z")], [], [])
        .evaluations,
    ).toHaveLength(1);
  });

  it("does not suppress a retry after transaction failure", async () => {
    const client = {
      query: async (sql: string) => {
        if (sql === "COMMIT") throw new Error("commit failed");
        return {
          rows: sql.includes("INSERT INTO") ? [{ inserted: true }] : [],
        };
      },
      release: () => undefined,
    } as unknown as PoolClient;
    const store = new PostgresStrategySignalStore({
      connect: async () => client,
    } as unknown as Pool);
    const value = evaluation("2026-09-24T14:00:00Z");
    await expect(store.saveStrategyResults([value], [])).rejects.toThrow(
      "commit failed",
    );
    expect(store.planPersistence([value], [], []).evaluations).toHaveLength(1);
  });

  it("keeps a missing feature join visible instead of caching a dropped row", async () => {
    const client = {
      query: async () => ({ rows: [] }),
      release: () => undefined,
    } as unknown as PoolClient;
    const store = new PostgresStrategySignalStore({
      connect: async () => client,
    } as unknown as Pool);
    const value = evaluation("2026-09-24T14:00:00Z");
    await expect(store.saveStrategyResults([value], [])).rejects.toThrow(
      /did not match/,
    );
    expect(store.planPersistence([value], [], []).evaluations).toHaveLength(1);
  });
});
