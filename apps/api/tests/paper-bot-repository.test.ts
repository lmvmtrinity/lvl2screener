import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  PostgresPaperBotStore,
  type InsertObservationInput,
  type StartRunInput,
} from "../src/paper-bot/paper-bot-repository.js";
import type { AssumptionsSnapshot } from "../src/paper-bot/types.js";

const assumptions: AssumptionsSnapshot = {
  positionSize: 1_000,
  slippageBps: 10,
  feePerTrade: 1,
  stopMethod: "STRUCTURAL",
  atrStopMultiple: 2,
  rewardRiskRatio: null,
  maxQuoteAgeSeconds: 30,
  sessionTimezone: "America/Toronto",
  noonCloseTime: "16:00",
};

/**
 * A minimal in-memory stand-in for the paper_bot_run / paper_signal_observation
 * tables, faithful only to the constraints this repository relies on: the
 * live-run resume lookup and the lifecycle/legacy unique indexes. Follows the
 * FakeClient pattern already used for migration tests (tests/migrate.test.ts)
 * rather than mocking `pg` directly.
 */
class FakeDb {
  runs: Array<Record<string, unknown>> = [];
  observations: Array<Record<string, unknown>> = [];
  runSeq = 0;
  obsSeq = 0;

  async query<T>(text: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(text)) return { rows: [] };
    if (text.includes("FROM paper_bot_run") && text.includes("market_id=$1")) {
      const [marketId, sessionDate, executionModelVersion] = params as [
        string,
        string,
        string,
      ];
      const row = this.runs.find(
        (r) =>
          r.marketId === marketId &&
          r.source === "LIVE" &&
          r.sessionDate === sessionDate &&
          r.executionModelVersion === executionModelVersion &&
          (r.status === "RUNNING" || r.status === "CLOSE_PENDING"),
      );
      return { rows: row ? [row as T] : [] };
    }
    if (text.startsWith("INSERT INTO paper_bot_run")) {
      const [
        marketId,
        source,
        sessionDate,
        sessionTimezone,
        scheduledCloseAt,
        executionModelVersion,
        assumptionsJson,
      ] = params as [string, string, string, string, string, string, string];
      const row = {
        id: `run-${++this.runSeq}`,
        marketId,
        source,
        sessionDate,
        sessionTimezone,
        scheduledCloseAt,
        status: "RUNNING",
        executionModelVersion,
        assumptions: JSON.parse(assumptionsJson),
        startedAt: new Date().toISOString(),
        completedAt: null,
        failedAt: null,
        failureReason: null,
      };
      this.runs.push(row);
      return { rows: [row as T] };
    }
    if (text.startsWith("INSERT INTO paper_signal_observation")) {
      const [
        runId,
        sourceEventId,
        sourceSignalId,
        setupInstanceId,
        instrumentId,
        symbol,
        profileId,
        profileName,
        profileConfigId,
        configVersion,
        profileParameters,
        strategyKey,
        strategyVersion,
        signalTimestamp,
        score,
        entryReference,
        stopReference,
        targetReference,
        atr14,
        featureSnapshot,
        reasonCodes,
        sourceEventPayload,
        eligibilityStatus,
        eligibilityReason,
      ] = params as unknown[];
      const conflict = this.observations.find((o) =>
        setupInstanceId !== null
          ? o.runId === runId &&
            o.profileConfigId === profileConfigId &&
            o.setupInstanceId === setupInstanceId
          : o.runId === runId && o.sourceEventId === sourceEventId,
      );
      if (conflict) return { rows: [] };
      const row = {
        id: `obs-${++this.obsSeq}`,
        marketId:
          this.runs.find((run) => run.id === runId)?.marketId ?? "CA_TSX",
        runId,
        sourceEventId,
        sourceSignalId,
        setupInstanceId,
        instrumentId,
        symbol,
        profileId,
        profileName,
        profileConfigId,
        configVersion,
        profileParameters: JSON.parse(profileParameters as string),
        strategyKey,
        strategyVersion,
        signalTimestamp,
        score,
        entryReference,
        stopReference,
        targetReference,
        atr14,
        featureSnapshot: JSON.parse(featureSnapshot as string),
        reasonCodes: JSON.parse(reasonCodes as string),
        sourceEventPayload: JSON.parse(sourceEventPayload as string),
        eligibilityStatus,
        eligibilityReason,
        createdAt: new Date().toISOString(),
      };
      this.observations.push(row);
      return { rows: [{ id: row.id } as T] };
    }
    if (
      text.includes(
        "FROM paper_signal_observation o JOIN paper_bot_run r ON r.id=o.run_id WHERE o.id=$1",
      )
    ) {
      const [id] = params as [string];
      const row = this.observations.find((o) => o.id === id);
      return { rows: row ? [row as T] : [] };
    }
    if (
      text.includes(
        "o.run_id=$1 AND o.profile_config_id=$2 AND o.setup_instance_id=$3",
      )
    ) {
      const [runId, profileConfigId, setupInstanceId] = params as [
        string,
        string,
        string,
      ];
      const row = this.observations.find(
        (o) =>
          o.runId === runId &&
          o.profileConfigId === profileConfigId &&
          o.setupInstanceId === setupInstanceId,
      );
      return { rows: row ? [row as T] : [] };
    }
    if (text.includes("o.run_id=$1 AND o.source_event_id=$2")) {
      const [runId, sourceEventId] = params as [string, string];
      const row = this.observations.find(
        (o) => o.runId === runId && o.sourceEventId === sourceEventId,
      );
      return { rows: row ? [row as T] : [] };
    }
    throw new Error(`FakeDb: unhandled query: ${text}`);
  }

  connect() {
    return Promise.resolve({
      query: (text: string, params?: unknown[]) =>
        this.query(text, params ?? []),
      release: () => {},
    });
  }
}

function store(db: FakeDb): PostgresPaperBotStore {
  return new PostgresPaperBotStore(db as unknown as Pool);
}

const baseRunInput: StartRunInput = {
  source: "LIVE",
  sessionDate: "2026-08-25",
  sessionTimezone: "America/Toronto",
  scheduledCloseAt: "2026-08-25T16:00:00.000Z",
  executionModelVersion: "v1",
  assumptions,
};

const observationInput = (
  overrides: Partial<InsertObservationInput> = {},
): InsertObservationInput => ({
  runId: "run-1",
  sourceEventId: "event-1",
  sourceSignalId: "signal-1",
  setupInstanceId: "setup-1",
  instrumentId: "instrument-1",
  symbol: "ABC",
  profileId: "profile-1",
  profileName: "Bull Flag",
  profileConfigId: "config-1",
  configVersion: "v1",
  profileParameters: { scoreCutoff: 70 },
  strategyKey: "bull_flag",
  strategyVersion: "1.0.0",
  signalTimestamp: "2026-08-25T14:00:00.000Z",
  score: 85,
  entryReference: 10,
  stopReference: 9.5,
  targetReference: 11,
  atr14: 0.25,
  featureSnapshot: {},
  reasonCodes: [],
  sourceEventPayload: {},
  eligibilityStatus: "ELIGIBLE",
  eligibilityReason: null,
  ...overrides,
});

describe("PostgresPaperBotStore run lifecycle", () => {
  it("starts a new live run when none exists for the session and version", async () => {
    const db = new FakeDb();
    const run = await store(db).startOrResumeLiveRun(baseRunInput);
    expect(run.status).toBe("RUNNING");
    expect(db.runs).toHaveLength(1);
  });

  it("resumes the existing RUNNING live run instead of creating a second one", async () => {
    const db = new FakeDb();
    const first = await store(db).startOrResumeLiveRun(baseRunInput);
    const second = await store(db).startOrResumeLiveRun(baseRunInput);
    expect(second.id).toBe(first.id);
    expect(db.runs).toHaveLength(1);
  });

  it("keeps same-date US and TSX live runs in separate market cohorts", async () => {
    const db = new FakeDb();
    const repository = store(db);
    const ca = await repository.startOrResumeLiveRun({
      ...baseRunInput,
      marketId: "CA_TSX",
    });
    const us = await repository.startOrResumeLiveRun({
      ...baseRunInput,
      marketId: "US_EQUITIES",
      sessionTimezone: "America/New_York",
    });
    expect(ca.id).not.toBe(us.id);
    expect([ca.marketId, us.marketId]).toEqual(["CA_TSX", "US_EQUITIES"]);
    expect(db.runs).toHaveLength(2);
  });

  it("starts a new backtest run unconditionally, never resuming", async () => {
    const db = new FakeDb();
    await store(db).startBacktestRun({ ...baseRunInput, source: "BACKTEST" });
    await store(db).startBacktestRun({ ...baseRunInput, source: "BACKTEST" });
    expect(db.runs).toHaveLength(2);
  });
});

describe("PostgresPaperBotStore observation idempotency", () => {
  it("inserts a new observation and reports created: true", async () => {
    const db = new FakeDb();
    const result = await store(db).insertObservation(observationInput());
    expect(result.created).toBe(true);
    expect(result.observation.symbol).toBe("ABC");
    expect(db.observations).toHaveLength(1);
  });

  it("returns the existing row with created: false on a lifecycle-identity conflict", async () => {
    const db = new FakeDb();
    const input = observationInput();
    const first = await store(db).insertObservation(input);
    const second = await store(db).insertObservation(input);
    expect(second.created).toBe(false);
    expect(second.observation.id).toBe(first.observation.id);
    expect(db.observations).toHaveLength(1);
  });

  it("falls back to the legacy (run_id, source_event_id) identity when there is no setup instance", async () => {
    const db = new FakeDb();
    const input = observationInput({
      setupInstanceId: null,
      sourceEventId: "legacy-event-1",
    });
    const first = await store(db).insertObservation(input);
    const second = await store(db).insertObservation(input);
    expect(second.created).toBe(false);
    expect(second.observation.id).toBe(first.observation.id);
  });
});

describe("PostgresPaperBotStore findUnobservedReadyEvents", () => {
  it("includes cross-run session date check for live runs", async () => {
    let capturedSql = "";
    let capturedParams: unknown[] = [];
    const store = new PostgresPaperBotStore({
      query: async (sql: string, params?: unknown[]) => {
        capturedSql = sql;
        capturedParams = params ?? [];
        return { rows: [] };
      },
    } as never);

    await store.findUnobservedReadyEvents("run-123", 100);
    expect(capturedSql).toContain("r_prior.source = 'LIVE'");
    expect(capturedSql).toContain("r_prior.session_date = r.session_date");
    expect(capturedParams).toEqual(["run-123", 100]);
  });
});

describe("PostgresPaperBotStore funded invalidation lookup", () => {
  it("follows setup identity after an intermediate display-state transition", async () => {
    let capturedSql = "";
    const store = new PostgresPaperBotStore({
      query: async (sql: string) => {
        capturedSql = sql;
        return {
          rows: [
            {
              eventId: "event-1",
              orderId: "order-1",
              at: "2026-08-25T14:05:00.000Z",
            },
          ],
        };
      },
    } as never);

    await expect(store.findFundedInvalidations("run-1")).resolves.toEqual([
      {
        eventId: "event-1",
        orderId: "order-1",
        at: "2026-08-25T14:05:00.000Z",
      },
    ]);
    expect(capturedSql).toContain("o.setup_instance_id=e.setup_instance_id");
    expect(capturedSql).toContain("e.new_state='INVALIDATED'");
    expect(capturedSql).not.toContain("e.previous_state='READY'");
  });
});

describe("persisted quote size provenance", () => {
  it.each(["BOARD_LOTS", "UNKNOWN"])(
    "preserves %s validation on reconciliation and close reads",
    async (sizeUnit) => {
      const store = new PostgresPaperBotStore({
        query: async () => ({
          rows: [
            {
              instrumentId: "instrument-1",
              sourceEventId: "event-1",
              sourceSignalId: "signal-1",
              payload: {},
              timestamp: "2026-09-08T20:00:01Z",
              quoteTimestamp: "2026-09-08T20:00:01Z",
              bid: "10",
              ask: "10.01",
              bidSize: "2500",
              askSize: "3000",
              sizeUnit,
              sizeMultiplier: 100,
              isDelayed: false,
              isHalted: false,
            },
          ],
        }),
      } as never);
      const quotes = await store.findSessionCloseQuotes(
        ["instrument-1"],
        "2026-09-08T20:00:00Z",
      );
      const candidates = await store.findUnobservedReadyEvents("run-1");
      for (const quote of [
        quotes.get("instrument-1")?.[0],
        candidates[0]?.quoteAtSignal,
      ]) {
        expect(quote).toMatchObject({
          bidSize: 2500,
          askSize: 3000,
          sizeUnit: sizeUnit === "BOARD_LOTS" ? "SHARES" : "UNKNOWN",
        });
      }
    },
  );
});
