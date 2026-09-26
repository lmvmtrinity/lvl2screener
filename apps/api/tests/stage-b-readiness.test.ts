import { describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import {
  analyzeStageBReadiness,
  loadStageBReadiness,
  STAGE_B_REFERENCE_MIN_SESSIONS,
  type StageBChampionRow,
  type StageBSessionRow,
} from "../src/paper-bot/stage-b-readiness.js";
import { isMarketTradingDay } from "../src/universe/market-calendar.js";

const ACCOUNT = "10000000-0000-4000-8000-000000000901";

const POLICY = {
  portfolio: { version: "funded-portfolio-v2", maxOpenPositions: 3 },
  participation: 0.25,
  impactBps: 0,
} as const;

const ASSUMPTIONS = {
  riskBudget: 50,
  maxNotional: 3_000,
  costs: { brokerPricingVersion: "paper-cost-policy-2026-09-04" },
} as const;

function tradingDates(count: number, start = "2026-07-02"): string[] {
  const dates: string[] = [];
  let cursor = new Date(`${start}T00:00:00Z`);
  while (dates.length < count) {
    const iso = cursor.toISOString().slice(0, 10);
    if (isMarketTradingDay(iso, "CA_TSX")) dates.push(iso);
    cursor = new Date(cursor.getTime() + 86_400_000);
  }
  return dates;
}

function champion(
  overrides: Partial<StageBChampionRow> = {},
): StageBChampionRow {
  return {
    runId: "champion-run",
    marketId: "CA_TSX",
    sessionDate: "2026-09-18",
    status: "COMPLETED",
    executionModelVersion: "paper-execution-v7",
    assumptions: ASSUMPTIONS,
    policy: POLICY,
    accountId: ACCOUNT,
    currency: "CAD",
    ...overrides,
  };
}

function session(
  sessionDate: string,
  overrides: Partial<StageBSessionRow> = {},
  options: { netPnl?: number } = {},
): StageBSessionRow {
  const currency = overrides.currency ?? "CAD";
  const boundaryAt = `${sessionDate}T20:00:00.000Z`;
  const netPnl = overrides.snapshot ? 0 : (options.netPnl ?? 0);
  const openingEquity = 10_000;
  const state = {
    version: "funded-ledger-v1",
    currency,
    cash: openingEquity + netPnl,
    session: sessionDate,
    openingEquity,
    dailyLossLimit: 200,
    realizedPnl: netPnl,
    positions: {},
    reservations: {},
    events: [],
    lastEventAt: boundaryAt,
  };
  const base: StageBSessionRow = {
    runId: `run-${sessionDate}`,
    marketId: "CA_TSX",
    currency: "CAD",
    accountId: ACCOUNT,
    sessionDate,
    sessionTimezone: "America/Toronto",
    status: "COMPLETED",
    source: "LIVE",
    startedAt: `${sessionDate}T07:00:00.000Z`,
    completedAt: `${sessionDate}T20:30:00.000Z`,
    scheduledCloseAt: `${sessionDate}T20:00:00.000Z`,
    executionModelVersion: "paper-execution-v7",
    assumptions: ASSUMPTIONS,
    policy: POLICY,
    bindingCreatedAt: `${sessionDate}T07:00:00.000Z`,
    accountCreatedAt: "2026-07-02T07:00:00.000Z",
    accountInitialSession: "2026-07-02",
    snapshot: {
      boundaryAt,
      capturedAt: `${sessionDate}T20:30:00.000Z`,
      boundaryEventSequence: 100,
      state,
    },
    pendingFactsAtCutoff: 0,
    openOrders: 0,
    unresolvedDecisionOutcomes: 0,
    unverifiedEventsToBoundary: 0,
    decisions: 1,
    sessionOpenedAt: `${sessionDate}T07:00:00.000Z`,
  };
  return { ...base, ...overrides };
}

function analyze(
  sessions: StageBSessionRow[],
  options: {
    market?: "CA_TSX" | "US_EQUITIES";
    asOf?: string;
    champion?: StageBChampionRow | null;
  } = {},
) {
  return analyzeStageBReadiness({
    market: options.market ?? "CA_TSX",
    asOf: options.asOf ?? "2026-09-21T00:00:00.000Z",
    schemaVersion: 138,
    codeRevision: "test-revision",
    champion: options.champion === undefined ? champion() : options.champion,
    sessions,
    authorityState: {
      gatePolicies: 0,
      enrollments: 0,
      attempts: 0,
      reports: 0,
      activeOrEligibleChallengers: 0,
    },
  });
}

describe("Stage B readiness analysis", () => {
  it("scopes the authority challenger count to the requested market", async () => {
    // Migration 130 rejects active/eligible challengers at the database boundary;
    // capture the real loader query and bind parameter instead of weakening it.
    const queries: Array<{
      sql: string;
      parameters: readonly unknown[] | undefined;
    }> = [];
    const client = {
      query: async (sql: string, parameters?: readonly unknown[]) => {
        queries.push({ sql, parameters });
        if (sql.includes("clock_timestamp()"))
          return {
            rows: [
              { database_now: "2026-09-21T00:00:00.000Z", schema_version: 137 },
            ],
          };
        if (sql.includes("FROM paper_bot_run r")) return { rows: [] };
        if (sql.includes("FROM paper_funded_fact")) return { rows: [] };
        if (sql.includes("FROM paper_entry_order")) return { rows: [] };
        if (sql.includes("FROM funded_decision_outcome")) return { rows: [] };
        if (sql.includes("FROM funded_decision_evidence")) return { rows: [] };
        if (sql.includes("FROM funded_shadow_gate_policy"))
          return {
            rows: [
              {
                gate_policies: 0,
                enrollments: 0,
                attempts: 0,
                reports: 0,
                challengers: 0,
              },
            ],
          };
        throw new Error(`Unexpected Stage B query: ${sql}`);
      },
    } as unknown as PoolClient;

    const loaded = await loadStageBReadiness(
      client,
      "US_EQUITIES",
      "2026-09-21T00:00:00.000Z",
    );
    const authorityQuery = queries.find((entry) =>
      entry.sql.includes("FROM funded_execution_challenger"),
    );

    expect(authorityQuery?.sql).toContain(
      "WHERE market_id=$1 AND (active OR eligible_for_activation)",
    );
    expect(authorityQuery?.parameters).toEqual(["US_EQUITIES"]);
    expect(loaded.authorityState.activeOrEligibleChallengers).toBe(0);
  });

  it("fails closed below 40 eligible sessions and never publishes an M_market", () => {
    const dates = tradingDates(39);
    const report = analyze(dates.map((date) => session(date)));
    expect(report.eligibleSessionCount).toBe(39);
    expect(report.verdict).toBe("INSUFFICIENT_SESSIONS");
    expect(report.remainingRequired).toBe(1);
    expect(report.sdReference).toBeNull();
    expect(report.mMarketCandidate).toBeNull();
    expect(report.mMarketAuthoritative).toBe(false);
    expect(report.manifestDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("qualifies exactly 40 eligible sessions for review with a reproducible M_market", () => {
    const dates = tradingDates(STAGE_B_REFERENCE_MIN_SESSIONS);
    const sessions = dates.map((date, index) =>
      session(date, {}, { netPnl: index % 2 === 0 ? 10 : -10 }),
    );
    const report = analyze(sessions);
    expect(report.verdict).toBe("READY_FOR_STAGE_B_REVIEW");
    expect(report.eligibleSessionCount).toBe(40);
    expect(report.remainingRequired).toBe(0);
    expect(report.sdReference).not.toBeNull();
    const returns = report.includedSessions.map((entry) => entry.netReturn);
    const mean =
      returns.reduce((total, value) => total + value, 0) / returns.length;
    const variance =
      returns.reduce((total, value) => total + (value - mean) ** 2, 0) /
      (returns.length - 1);
    const expectedSd = Math.sqrt(variance);
    expect(report.sdReference).toBeCloseTo(expectedSd, 12);
    expect(report.mMarketCandidate).toBeCloseTo(expectedSd * 0.25, 12);
  });

  it("reproduces the same digest and values for identical inputs", () => {
    const dates = tradingDates(5);
    const sessions = dates.map((date) => session(date));
    const first = analyze(sessions);
    const second = analyze(sessions.map((entry) => ({ ...entry })));
    expect(second.manifestDigest).toBe(first.manifestDigest);
    expect(second.includedSessions).toEqual(first.includedSessions);
  });

  it("excludes an overlapping second run on the same session deterministically", () => {
    const dates = tradingDates(3);
    const duplicate = session(dates[1]!, {
      runId: `later-${dates[1]}`,
      startedAt: `${dates[1]}T09:00:00.000Z`,
    });
    const report = analyze([
      session(dates[0]!),
      session(dates[1]!),
      duplicate,
      session(dates[2]!),
    ]);
    expect(report.rawSessionCount).toBe(4);
    expect(report.eligibleSessionCount).toBe(3);
    const excluded = report.excludedSessions.find(
      (entry) => entry.runId === duplicate.runId,
    );
    expect(excluded?.reasons).toEqual(["OVERLAPPING_SESSION"]);
    expect(report.includedSessions.map((entry) => entry.runId)).not.toContain(
      duplicate.runId,
    );
  });

  it("excludes unresolved exposure and incomplete reconciliation", () => {
    const dates = tradingDates(3);
    const exposure = session(dates[0]!, {
      runId: "exposure-run",
      snapshot: {
        boundaryAt: `${dates[0]}T20:00:00.000Z`,
        capturedAt: `${dates[0]}T20:30:00.000Z`,
        boundaryEventSequence: 10,
        state: {
          version: "funded-ledger-v1",
          currency: "CAD",
          cash: 9_000,
          session: dates[0],
          openingEquity: 10_000,
          dailyLossLimit: 200,
          realizedPnl: 0,
          positions: {
            position: {
              instrumentId: "instrument",
              shares: 100,
              basis: 1_000,
              stop: 9,
              mark: 10,
              markedAt: `${dates[0]}T19:59:00.000Z`,
            },
          },
          reservations: {},
          events: [],
          lastEventAt: `${dates[0]}T20:00:00.000Z`,
        },
      },
    });
    const backlog = session(dates[1]!, {
      runId: "backlog-run",
      pendingFactsAtCutoff: 2,
    });
    const openOrder = session(dates[2]!, {
      runId: "open-order-run",
      openOrders: 1,
    });
    const report = analyze([exposure, backlog, openOrder]);
    expect(report.eligibleSessionCount).toBe(0);
    const byRun = new Map(
      report.excludedSessions.map((entry) => [entry.runId, entry.reasons]),
    );
    expect(byRun.get("exposure-run")).toContain("UNRESOLVED_EXPOSURE");
    expect(byRun.get("backlog-run")).toContain("UNRESOLVED_BACKLOG");
    expect(byRun.get("open-order-run")).toContain("UNRESOLVED_ORDER");
  });

  it("isolates markets and currencies and keeps US sessions structurally valid only", () => {
    const dates = tradingDates(2);
    const wrongCurrency = session(dates[0]!, {
      runId: "usd-run",
      currency: "USD",
    });
    const report = analyze([session(dates[1]!), wrongCurrency]);
    expect(report.currency).toBe("CAD");
    const excluded = report.excludedSessions.find(
      (entry) => entry.runId === "usd-run",
    );
    expect(excluded?.reasons).toContain("CURRENCY_MISMATCH");

    const usAccount = "20000000-0000-4000-8000-000000000902";
    const usReport = analyze(
      [
        session("2026-09-16", {
          marketId: "US_EQUITIES",
          currency: "USD",
          accountId: usAccount,
        }),
        session("2026-09-17", {
          marketId: "US_EQUITIES",
          currency: "USD",
          accountId: usAccount,
        }),
      ],
      {
        market: "US_EQUITIES",
        champion: champion({
          marketId: "US_EQUITIES",
          currency: "USD",
          accountId: usAccount,
        }),
      },
    );
    expect(usReport.currency).toBe("USD");
    expect(usReport.structuralSessionCount).toBe(2);
    expect(usReport.eligibleSessionCount).toBe(0);
    expect(usReport.verdict).toBe("EVIDENCE_UNAVAILABLE");
    expect(usReport.blockers.join(" ")).toContain(
      "COMMISSIONING_PROVENANCE_UNPROVEN",
    );
  });

  it("splits the cohort when policy identity drifts", () => {
    const dates = tradingDates(3);
    const drifted = session(dates[2]!, {
      runId: "drifted-run",
      policy: { ...POLICY, participation: 0.5 },
    });
    const report = analyze([session(dates[0]!), session(dates[1]!), drifted]);
    expect(report.eligibleSessionCount).toBe(2);
    const excluded = report.excludedSessions.find(
      (entry) => entry.runId === "drifted-run",
    );
    expect(excluded?.reasons).toEqual(["IDENTITY_MISMATCH"]);
    expect(report.exclusionsByReason.IDENTITY_MISMATCH).toBe(1);
  });

  it("does not count a partial-coverage session or a session whose ledger open is unproven", () => {
    const dates = tradingDates(4);
    const lateStart = session(dates[0]!, {
      runId: "late-start",
      sessionOpenedAt: `${dates[0]}T14:00:00.000Z`,
    });
    const unproven = session(dates[1]!, {
      runId: "unproven-open",
      sessionOpenedAt: null,
      accountInitialSession: null,
    });
    const lateBinding = session(dates[2]!, {
      runId: "late-binding",
      bindingCreatedAt: `${dates[2]}T15:00:00.000Z`,
    });
    const report = analyze([
      lateStart,
      unproven,
      lateBinding,
      session(dates[3]!),
    ]);
    const byRun = new Map(
      report.excludedSessions.map((entry) => [entry.runId, entry.reasons]),
    );
    expect(byRun.get("late-start")).toContain("PARTIAL_SESSION_COVERAGE");
    expect(byRun.get("unproven-open")).toContain("SESSION_OPEN_UNPROVEN");
    expect(byRun.get("late-binding")).toContain("PARTIAL_SESSION_COVERAGE");
    expect(report.eligibleSessionCount).toBe(1);
  });

  it("excludes a non-trading session and a snapshot captured after the as-of cutoff", () => {
    const dates = tradingDates(2);
    const weekend = session("2026-09-19", { runId: "weekend-run" });
    const afterCutoff = session(dates[1]!, {
      runId: "after-cutoff",
      snapshot: {
        boundaryAt: `${dates[1]}T20:00:00.000Z`,
        capturedAt: `${dates[1]}T21:00:00.000Z`,
        boundaryEventSequence: 5,
        state: {
          version: "funded-ledger-v1",
          currency: "CAD",
          cash: 10_000,
          session: dates[1],
          openingEquity: 10_000,
          dailyLossLimit: 200,
          realizedPnl: 0,
          positions: {},
          reservations: {},
          events: [],
          lastEventAt: `${dates[1]}T20:00:00.000Z`,
        },
      },
    });
    const report = analyze([session(dates[0]!), weekend, afterCutoff], {
      asOf: `${dates[1]}T20:30:00.000Z`,
    });
    const byRun = new Map(
      report.excludedSessions.map((entry) => [entry.runId, entry.reasons]),
    );
    expect(byRun.get("weekend-run")).toContain("NOT_A_TRADING_SESSION");
    expect(byRun.get("after-cutoff")).toContain("SNAPSHOT_AFTER_CUTOFF");
    expect(report.eligibleSessionCount).toBe(1);
  });

  it("reports evidence unavailable when no champion identity can be resolved", () => {
    const report = analyze([session("2026-09-16")], { champion: null });
    expect(report.verdict).toBe("EVIDENCE_UNAVAILABLE");
    expect(report.champion).toBeNull();
    expect(report.eligibleSessionCount).toBe(0);
    expect(report.blockers).toContain("CHAMPION_IDENTITY_UNRESOLVED");
  });

  it("flags a nonzero authority state without granting any authority", () => {
    const report = analyzeStageBReadiness({
      market: "CA_TSX",
      asOf: "2026-09-21T00:00:00.000Z",
      schemaVersion: 138,
      codeRevision: null,
      champion: champion(),
      sessions: [session("2026-09-16")],
      authorityState: {
        gatePolicies: 1,
        enrollments: 1,
        attempts: 0,
        reports: 0,
        activeOrEligibleChallengers: 0,
      },
    });
    expect(report.blockers).toContain("GATE_POLICY_PRESENT_WITHOUT_STAGE_B");
    expect(report.blockers).toContain("ENROLLMENT_PRESENT_WITHOUT_STAGE_B");
    expect(report.mMarketAuthoritative).toBe(false);
  });
});
