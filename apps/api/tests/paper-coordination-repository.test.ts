import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { PostgresPaperCoordinationStore } from "../src/paper-bot/paper-coordination-repository.js";
import type { QuoteExecutionState } from "../src/paper-bot/execution-core.js";
import { COORDINATION_POLICY_VERSION } from "../src/paper-bot/coordination-policy.js";

describe("PostgresPaperCoordinationStore remediation", () => {
  it("reports portfolio-wide unresolved and completed-run invariant counts", async () => {
    const pool = {
      query: async () => ({
        rows: [
          {
            unresolvedPositions: "2",
            completedRunsWithUnresolvedPositions: "1",
            oldestUnresolvedAgeMs: "7200000",
            unknownQuoteSizeUnits: "1",
          },
        ],
      }),
    } as unknown as Pool;

    await expect(
      new PostgresPaperCoordinationStore(pool).portfolioHealth(),
    ).resolves.toEqual({
      unresolvedPositions: 2,
      completedRunsWithUnresolvedPositions: 1,
      oldestUnresolvedAgeMs: 7_200_000,
      unknownQuoteSizeUnits: 1,
    });
  });

  it("persists the selected recovery fact and delay with a terminal close", async () => {
    let values: unknown[] = [];
    const pool = {
      query: async (_text: string, parameters: unknown[]) => {
        values = parameters;
        return { rows: [] };
      },
    } as unknown as Pool;
    const state = {
      status: "CLOSED",
      position: {
        entryPrice: 10,
        entryTime: "2026-09-01T14:00:00.000Z",
        stop: 9.5,
        target: 11,
        shares: 10,
        initialRisk: 5,
      },
      entryMarketSnapshot: {
        bid: 9.99,
        ask: 10,
        bidSize: 100,
        askSize: 100,
        spread: 0.01,
        quoteTimestamp: "2026-09-01T14:00:00.000Z",
        dataStatus: "REALTIME",
        stalenessSeconds: 0,
      },
      entrySizeCoverage: 10,
      exit: {
        triggered: true,
        exitReason: "SESSION_CLOSE_DELAYED",
        exitTime: "2026-09-02T16:01:00.000Z",
        exitSizeCoverage: 10,
        exitMarketSnapshot: {
          bid: 10.2,
          ask: 10.21,
          bidSize: 100,
          askSize: 100,
          spread: 0.01,
          quoteTimestamp: "2026-09-02T16:01:00.000Z",
          dataStatus: "REALTIME",
          stalenessSeconds: 0,
        },
        sessionCloseDelayMs: 60_000,
        financials: { exitPrice: 10.2, grossPnl: 2, netPnl: 2, rMultiple: 0.4 },
      },
    } satisfies QuoteExecutionState;

    await new PostgresPaperCoordinationStore(pool).updateQuotePosition(
      "position-1",
      state,
      {
        source: "PERSISTED_QUOTE",
        boundary: "2026-09-02T16:00:00.000Z",
        factTimestamp: "2026-09-02T16:01:00.000Z",
        delayMs: 60_000,
      },
    );

    expect(values.slice(5)).toEqual([
      "PERSISTED_QUOTE",
      "2026-09-02T16:00:00.000Z",
      "2026-09-02T16:01:00.000Z",
      60_000,
    ]);
  });

  it("isolates portfolioHealth query and unknownQuoteSizeUnits to marketId and SHADOW mode", async () => {
    let capturedSql = "";
    let capturedParams: unknown[] = [];
    const pool = {
      query: async (sql: string, params: unknown[]) => {
        capturedSql = sql;
        capturedParams = params;
        return {
          rows: [
            {
              unresolvedPositions: "0",
              completedRunsWithUnresolvedPositions: "0",
              oldestUnresolvedAgeMs: null,
              unknownQuoteSizeUnits: "0",
            },
          ],
        };
      },
    } as unknown as Pool;

    const store = new PostgresPaperCoordinationStore(pool);
    await store.portfolioHealth("US_EQUITIES");

    expect(capturedParams).toEqual(["US_EQUITIES"]);
    expect(capturedSql).toContain("WHERE i.market_id=$1");
    expect(capturedSql).toContain(
      "WHERE p.portfolio_id=(SELECT id FROM paper_portfolio WHERE market_id=$1 AND mode='SHADOW')",
    );
  });

  it("scopes paper_portfolio lookups in recordDecision and stateForSymbol to mode=SHADOW", async () => {
    const executedSqls: string[] = [];
    const pool = {
      query: async (sql: string) => {
        executedSqls.push(sql);
        return { rows: [{ id: "decision-1" }] };
      },
    } as unknown as Pool;

    const store = new PostgresPaperCoordinationStore(pool);
    await store.recordDecision({
      runId: "run-1",
      symbol: "AAPL",
      decisionTimestamp: "2026-09-01T14:00:00.000Z",
      triggerObservationIds: [],
      decision: {
        rankedCandidates: [],
        selectedObservationId: null,
        selectedStrategyKey: null,
        confirmationObservationIds: [],
        outcome: "REJECTED",
        reason: "NO_FEASIBLE_CANDIDATE",
        policyVersion: COORDINATION_POLICY_VERSION,
        contextAlignment: 0,
        contexts: [],
      },
      state: {
        hasOpenSymbolPosition: false,
        lastStopAt: null,
        openPositionCount: 0,
        totalOpenRisk: 0,
        dailyRealizedLoss: 0,
        consecutiveStops: 0,
        portfolioReconciliationRequired: false,
        sector: null,
        openSymbolNotional: 0,
        openSectorNotional: 0,
        contexts: [],
      },
    });

    expect(executedSqls[0]).toContain("mode='SHADOW'");
  });

  it("inserts initial position atomically inside a transaction when initialPosition is provided", async () => {
    const executedSqls: string[] = [];
    const client = {
      query: async (sql: string) => {
        executedSqls.push(sql);
        if (sql.includes("INSERT INTO paper_coordination_decision")) {
          return { rows: [{ id: "decision-100" }] };
        }
        return { rows: [] };
      },
      release: () => {},
    };
    const pool = {
      connect: async () => client,
      query: async (sql: string) => {
        executedSqls.push(sql);
        return { rows: [] };
      },
    } as unknown as Pool;

    const store = new PostgresPaperCoordinationStore(pool);
    const result = await store.recordDecision({
      runId: "run-1",
      symbol: "MSFT",
      decisionTimestamp: "2026-09-01T14:00:00.000Z",
      triggerObservationIds: ["obs-1"],
      decision: {
        rankedCandidates: [],
        selectedObservationId: "obs-1",
        selectedStrategyKey: "VWAP_RECLAIM",
        confirmationObservationIds: [],
        outcome: "APPROVED",
        reason: "SELECTED_PRIMARY",
        policyVersion: COORDINATION_POLICY_VERSION,
        contextAlignment: 1,
        contexts: [],
      },
      state: {
        hasOpenSymbolPosition: false,
        lastStopAt: null,
        openPositionCount: 0,
        totalOpenRisk: 0,
        dailyRealizedLoss: 0,
        consecutiveStops: 0,
        portfolioReconciliationRequired: false,
        sector: null,
        openSymbolNotional: 0,
        openSectorNotional: 0,
        contexts: [],
      },
      initialPosition: {
        observationId: "obs-1",
        state: {
          status: "OPEN",
          position: {
            entryPrice: 100,
            entryTime: "2026-09-01T14:00:00.000Z",
            stop: 98,
            target: 105,
            shares: 50,
            initialRisk: 100,
          },
          entryMarketSnapshot: {
            bid: 99.99,
            ask: 100,
            bidSize: 100,
            askSize: 100,
            spread: 0.01,
            quoteTimestamp: "2026-09-01T14:00:00.000Z",
            dataStatus: "REALTIME",
            stalenessSeconds: 0,
          },
          entrySizeCoverage: 1,
          lastFactTimestamp: "2026-09-01T14:00:00.000Z",
        },
      },
    });

    expect(result).toEqual({ id: "decision-100", created: true });
    expect(executedSqls[0]).toBe("BEGIN");
    expect(executedSqls[1]).toContain(
      "INSERT INTO paper_coordination_decision",
    );
    expect(executedSqls[2]).toContain(
      "INSERT INTO paper_coordination_position",
    );
    expect(executedSqls[2]).toContain("ON CONFLICT (decision_id) DO NOTHING");
    expect(executedSqls[3]).toBe("COMMIT");
  });

  it("finds approved decisions without positions", async () => {
    let capturedSql = "";
    let capturedParams: unknown[] = [];
    const pool = {
      query: async (sql: string, params: unknown[]) => {
        capturedSql = sql;
        capturedParams = params;
        return {
          rows: [
            {
              id: "dec-orphan-1",
              runId: "run-test",
              symbol: "GOOGL",
              decisionTimestamp: "2026-09-01T14:05:00.000Z",
              selectedObservationId: "obs-orphan-1",
              stateSnapshot: JSON.stringify({
                hasOpenSymbolPosition: false,
                openPositionCount: 0,
              }),
            },
          ],
        };
      },
    } as unknown as Pool;

    const store = new PostgresPaperCoordinationStore(pool);
    const orphans =
      await store.findApprovedDecisionsWithoutPositions("run-test");

    expect(capturedParams).toEqual(["run-test"]);
    expect(capturedSql).toContain("outcome = 'APPROVED'");
    expect(capturedSql).toContain("selected_observation_id IS NOT NULL");
    expect(capturedSql).toContain("p.id IS NULL");
    expect(orphans).toEqual([
      {
        id: "dec-orphan-1",
        runId: "run-test",
        symbol: "GOOGL",
        decisionTimestamp: "2026-09-01T14:05:00.000Z",
        selectedObservationId: "obs-orphan-1",
        stateSnapshot: {
          hasOpenSymbolPosition: false,
          openPositionCount: 0,
        },
      },
    ]);
  });

  it("reconstructs point-in-time stateForSymbol including closed positions that exited after before timestamp (F-06)", async () => {
    const executedSqls: string[] = [];
    const pool = {
      query: async (sql: string) => {
        executedSqls.push(sql);
        if (sql.includes("WITH symbol_state")) {
          return {
            rows: [
              {
                open: true,
                lastStopAt: null,
                openSymbolNotional: "1000",
                openPositionCount: "1",
                totalOpenRisk: "50",
                dailyRealizedLoss: "0",
                portfolioReconciliationRequired: false,
              },
            ],
          };
        }
        if (sql.includes("SELECT p.exit_reason")) {
          return { rows: [] };
        }
        if (sql.includes("WITH candidate")) {
          return {
            rows: [{ sector: "Technology", openSectorNotional: "1000" }],
          };
        }
        if (sql.includes("contextsFor")) {
          return { rows: [] };
        }
        return { rows: [] };
      },
    } as unknown as Pool;

    const store = new PostgresPaperCoordinationStore(pool);
    const state = await store.stateForSymbol(
      "run-1",
      "SHOP",
      "2026-09-01T14:00:00.000Z",
      "inst-1",
    );

    expect(state.hasOpenSymbolPosition).toBe(true);
    expect(state.openPositionCount).toBe(1);

    // Verify SQL includes point-in-time checks
    const mainSql = executedSqls[0];
    expect(mainSql).toContain(
      "(p.status IN ('OPEN','CLOSE_PENDING') OR (p.status='CLOSED' AND p.exit_time > $2))",
    );
    expect(mainSql).toContain("p.exit_time <= $2");
  });

  it("calculates dailyNetRealizedPnl, openPortfolioNotional, and pendingCloseCount in stateForSymbol (F-10)", async () => {
    const executedSqls: string[] = [];
    const pool = {
      query: async (sql: string) => {
        executedSqls.push(sql);
        if (sql.includes("WITH symbol_state")) {
          return {
            rows: [
              {
                open: false,
                lastStopAt: null,
                openSymbolNotional: "0",
                openPositionCount: "2",
                pendingCloseCount: "1",
                totalOpenRisk: "120",
                openPortfolioNotional: "3500.50",
                dailyRealizedLoss: "150.25",
                dailyNetRealizedPnl: "-50.75",
                portfolioReconciliationRequired: false,
              },
            ],
          };
        }
        if (sql.includes("SELECT p.exit_reason")) {
          return { rows: [] };
        }
        if (sql.includes("WITH candidate")) {
          return {
            rows: [{ sector: "Financials", openSectorNotional: "0" }],
          };
        }
        return { rows: [] };
      },
    } as unknown as Pool;

    const store = new PostgresPaperCoordinationStore(pool);
    const state = await store.stateForSymbol(
      "run-1",
      "RY",
      "2026-09-01T14:30:00.000Z",
      "inst-ry",
    );

    expect(state.pendingCloseCount).toBe(1);
    expect(state.openPortfolioNotional).toBe(3500.5);
    expect(state.dailyCumulativeLoss).toBe(150.25);
    expect(state.dailyRealizedLoss).toBe(150.25);
    expect(state.dailyNetRealizedPnl).toBe(-50.75);

    const mainSql = executedSqls[0];
    expect(mainSql).toContain("openPortfolioNotional");
    expect(mainSql).toContain("pendingCloseCount");
    expect(mainSql).toContain("dailyNetRealizedPnl");
  });

  it("updates decision candidate snapshot and shadow decision facts", async () => {
    let capturedSql = "";
    let capturedParams: unknown[] = [];
    const pool = {
      query: async (sql: string, params: unknown[]) => {
        capturedSql = sql;
        capturedParams = params;
        return { rows: [] };
      },
    } as unknown as Pool;

    const store = new PostgresPaperCoordinationStore(pool);
    const mockDecision = {
      outcome: "APPROVED",
      reason: "SELECTED_PRIMARY",
      rankedCandidates: [{ symbol: "SHOP.TO", rank: 1 }],
      shadowDecision: { outcome: "APPROVED", differenceReason: null },
    } as never;

    await store.updateDecisionModelFacts("dec-123", mockDecision);

    expect(capturedSql).toContain("UPDATE paper_coordination_decision");
    expect(capturedSql).toContain(
      "SET candidate_snapshot=$2::jsonb, shadow_decision=$3::jsonb",
    );
    expect(capturedSql).toContain("WHERE id=$1");
    expect(capturedParams[0]).toBe("dec-123");
    expect(JSON.parse(capturedParams[1] as string)).toEqual([
      { symbol: "SHOP.TO", rank: 1 },
    ]);
    expect(JSON.parse(capturedParams[2] as string)).toEqual({
      outcome: "APPROVED",
      differenceReason: null,
    });
  });
});
