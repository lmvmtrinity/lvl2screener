import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  createCandleExecution,
  createQuoteExecution,
} from "../src/paper-bot/execution-core.js";
import { PostgresPaperExecutionStore } from "../src/paper-bot/paper-execution-repository.js";
import type {
  AssumptionsSnapshot,
  QuoteFact,
  SignalFact,
} from "../src/paper-bot/types.js";

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

const signal: SignalFact = {
  entryReference: 10,
  stopReference: 9.5,
  targetReference: 11,
  atr14: 0.25,
  signalTimestamp: "2026-08-25T14:00:00.000Z",
};

const quote = (overrides: Partial<QuoteFact> = {}): QuoteFact => ({
  timestamp: "2026-08-25T14:00:00.000Z",
  bid: 9.99,
  ask: 10,
  bidSize: 500,
  askSize: 500,
  dataStatus: "REALTIME",
  actionable: true,
  ...overrides,
});

/** Mirrors the (observation_id, model) UNIQUE constraint on paper_execution. */
class FakeExecutionDb {
  rows: Array<Record<string, unknown>> = [];
  lastOpenQueryParams: unknown[] = [];
  labelTransactions: string[] = [];

  async connect() {
    return {
      query: async (text: string) => {
        this.labelTransactions.push(text);
        return { rows: [], rowCount: 0 };
      },
      release: () => undefined,
    };
  }

  async query<T>(text: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    if (text.startsWith("INSERT INTO paper_execution")) {
      const [observationId, model, ...rest] = params as [
        string,
        string,
        ...unknown[],
      ];
      const columns = [
        "status",
        "entryPrice",
        "entryTime",
        "stopPrice",
        "targetPrice",
        "shares",
        "initialRisk",
        "exitPrice",
        "exitTime",
        "exitReason",
        "fee",
        "grossPnl",
        "netPnl",
        "rMultiple",
        "noFillReason",
        "entryMarketSnapshot",
        "exitMarketSnapshot",
        "entrySizeCoverage",
        "exitSizeCoverage",
        "sessionCloseDelayMs",
        "lastFactTimestamp",
      ];
      const values: Record<string, unknown> = { observationId, model };
      columns.forEach((column, index) => {
        const raw = rest[index];
        values[column] =
          (column === "entryMarketSnapshot" ||
            column === "exitMarketSnapshot") &&
          typeof raw === "string"
            ? JSON.parse(raw)
            : raw;
      });
      const existingIndex = this.rows.findIndex(
        (row) => row.observationId === observationId && row.model === model,
      );
      if (existingIndex === -1) this.rows.push(values);
      else this.rows[existingIndex] = values;
      return { rows: [] };
    }
    if (text.includes("JOIN paper_signal_observation")) {
      this.lastOpenQueryParams = params;
      const open = this.rows
        .filter(
          (row) => row.status === "OPEN" || row.status === "CLOSE_PENDING",
        )
        .map((row) => ({ instrumentId: "instrument-1", ...row }));
      return { rows: open as T[] };
    }
    if (text.includes("SELECT entry_market_snapshot FROM paper_execution")) {
      const [observationId] = params as [string];
      const match = this.rows.find(
        (row) => row.observationId === observationId && row.model === "QUOTE",
      );
      return {
        rows: match
          ? ([{ entry_market_snapshot: match.entryMarketSnapshot }] as T[])
          : [],
      };
    }
    throw new Error(`FakeExecutionDb: unhandled query: ${text}`);
  }
}

function store(db: FakeExecutionDb): PostgresPaperExecutionStore {
  return new PostgresPaperExecutionStore(db as unknown as Pool);
}

describe("PostgresPaperExecutionStore quote mapping", () => {
  it("persists a NO_FILL row with its reason and entry snapshot", async () => {
    const db = new FakeExecutionDb();
    const state = createQuoteExecution(
      signal,
      quote({ dataStatus: "HALTED" }),
      assumptions,
    );
    await store(db).upsertQuoteExecution("obs-1", state);
    expect(db.rows).toEqual([
      expect.objectContaining({
        observationId: "obs-1",
        model: "QUOTE",
        status: "NO_FILL",
        noFillReason: "HALTED",
        entryPrice: null,
      }),
    ]);
  });

  it("persists an OPEN row with entry fields, snapshot, and size coverage, and no exit fields", async () => {
    const db = new FakeExecutionDb();
    const state = createQuoteExecution(signal, quote(), assumptions);
    await store(db).upsertQuoteExecution("obs-1", state);
    const row = db.rows[0];
    expect(row).toMatchObject({
      status: "OPEN",
      entryPrice: 10.01,
      stopPrice: 9.5,
      targetPrice: 11,
      shares: 99,
      exitPrice: null,
      exitReason: null,
    });
    expect(row?.entryMarketSnapshot).toMatchObject({ dataStatus: "REALTIME" });
  });

  it("upserts the same (observation, model) row rather than duplicating it", async () => {
    const db = new FakeExecutionDb();
    const opened = createQuoteExecution(signal, quote(), assumptions);
    await store(db).upsertQuoteExecution("obs-1", opened);
    await store(db).upsertQuoteExecution("obs-1", opened);
    expect(db.rows).toHaveLength(1);
  });

  it("persists a CLOSED row with full financials and exit snapshot", async () => {
    const db = new FakeExecutionDb();
    const opened = createQuoteExecution(signal, quote(), assumptions);
    await store(db).upsertQuoteExecution("obs-1", opened);

    const { applyQuoteFact } =
      await import("../src/paper-bot/execution-core.js");
    const closed = applyQuoteFact(
      opened,
      quote({ timestamp: "2026-08-25T14:30:00.000Z", bid: 9.4 }),
      assumptions,
    ).state;
    await store(db).upsertQuoteExecution("obs-1", closed);

    const row = db.rows[0];
    expect(row).toMatchObject({ status: "CLOSED", exitReason: "STOP" });
    expect(row?.fee).toBe(1);
    expect(row?.netPnl).not.toBeNull();
    expect(row?.exitMarketSnapshot).toMatchObject({ bid: 9.4 });
  });

  it("lists OPEN and CLOSE_PENDING rows for startup resume, reconstructing the position", async () => {
    const db = new FakeExecutionDb();
    const opened = createQuoteExecution(signal, quote(), assumptions);
    await store(db).upsertQuoteExecution("obs-1", opened);
    const resumable = await store(db).findOpenAndClosePending("run-1");
    expect(db.lastOpenQueryParams).toEqual(["run-1"]);
    expect(resumable).toEqual([
      {
        observationId: "obs-1",
        instrumentId: "instrument-1",
        model: "QUOTE",
        status: "OPEN",
        position: {
          entryPrice: 10.01,
          entryTime: "2026-08-25T14:00:00.000Z",
          stop: 9.5,
          target: 11,
          shares: 99,
          initialRisk: 50.49,
        },
        entryMarketSnapshot: expect.objectContaining({
          dataStatus: "REALTIME",
        }),
        entrySizeCoverage: 500 / 99,
        lastFactTimestamp: "2026-08-25T14:00:00.000Z",
      },
    ]);
  });

  it("retrieves entry market snapshot for an observation", async () => {
    const db = new FakeExecutionDb();
    const state = createQuoteExecution(
      signal,
      quote({ bid: 9.95, ask: 10.05 }),
      assumptions,
    );
    await store(db).upsertQuoteExecution("obs-1", state);

    const fact = await store(db).findQuoteSnapshotForObservation("obs-1");
    expect(fact).toMatchObject({
      bid: 9.95,
      ask: 10.05,
      actionable: true,
      dataStatus: "REALTIME",
    });

    const notFound =
      await store(db).findQuoteSnapshotForObservation("obs-missing");
    expect(notFound).toBeNull();
  });
});

describe("PostgresPaperExecutionStore candle mapping", () => {
  it("persists a candle NO_FILL row with no market snapshot column populated", async () => {
    const db = new FakeExecutionDb();
    const state = createCandleExecution(
      { ...signal, targetReference: null },
      assumptions,
    );
    await store(db).upsertCandleExecution("obs-2", state);
    expect(db.rows[0]).toMatchObject({
      model: "CANDLE",
      status: "NO_FILL",
      noFillReason: "MISSING_REFERENCE",
      entryMarketSnapshot: null,
    });
  });

  it("persists an OPEN candle row from the synthetic entry", async () => {
    const db = new FakeExecutionDb();
    const state = createCandleExecution(signal, assumptions);
    await store(db).upsertCandleExecution("obs-2", state);
    expect(db.rows[0]).toMatchObject({
      model: "CANDLE",
      status: "OPEN",
      entryPrice: 10.01,
      shares: 99,
    });
  });

  it("persists the fee on a CLOSED candle row", async () => {
    const db = new FakeExecutionDb();
    const opened = createCandleExecution(signal, assumptions);
    const { applyCandleFacts } =
      await import("../src/paper-bot/execution-core.js");
    const closed = applyCandleFacts(
      opened,
      [
        {
          start: "2026-08-25T14:01:00.000Z",
          end: "2026-08-25T14:02:00.000Z",
          open: 10,
          high: 10.1,
          low: 9.4,
          close: 9.5,
        },
      ],
      assumptions,
    ).state;

    await store(db).upsertCandleExecution("obs-2", closed);
    expect(db.rows[0]).toMatchObject({ status: "CLOSED", fee: 1 });
  });
});
