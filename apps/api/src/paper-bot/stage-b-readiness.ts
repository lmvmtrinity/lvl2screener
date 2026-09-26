import type { Pool, PoolClient } from "pg";
import type { MarketId } from "@tsx-scanner/contracts";
import { contentHash } from "../backtests/research-coverage.js";
import {
  getRecentRegularSessions,
  isMarketTradingDay,
} from "../universe/market-calendar.js";
import { fundedPolicyDigest } from "./funded-comparison-digest.js";
import { fundedAccountSummary, type FundedLedger } from "./funded-ledger.js";

/**
 * Read-only Stage B readiness analysis (ADR-016 section 4.1).
 *
 * The reference window is the champion's observed per-session net return over
 * at least 40 retained, reconciled, non-overlapping funded sessions that all
 * ended before the automatic-policy approval. This module only reads; it never
 * creates a Stage B approval, a gate policy, an enrollment or any authority
 * row. It is deliberately fail-closed: a session with a missing, partial,
 * unprovable or mismatched input is excluded rather than estimated.
 */

export const STAGE_B_REFERENCE_MIN_SESSIONS = 40;
export const STAGE_B_PRACTICAL_EFFECT_FRACTION = 0.25;

export type StageBMarket = "CA_TSX" | "US_EQUITIES";

export const STAGE_B_MARKET_CURRENCY: Readonly<
  Record<StageBMarket, "CAD" | "USD">
> = {
  CA_TSX: "CAD",
  US_EQUITIES: "USD",
};

export type StageBVerdict =
  | "INSUFFICIENT_SESSIONS"
  | "EVIDENCE_UNAVAILABLE"
  | "IDENTITY_MISMATCH"
  | "READY_FOR_STAGE_B_REVIEW";

export const STAGE_B_EXCLUSION_REASONS = [
  "MARKET_MISMATCH",
  "CURRENCY_MISMATCH",
  "NOT_A_TRADING_SESSION",
  "OVERLAPPING_SESSION",
  "ACCOUNT_NOT_CHAMPION_ACCOUNT",
  "SNAPSHOT_MISSING",
  "SNAPSHOT_AFTER_CUTOFF",
  "SNAPSHOT_CURSOR_UNPROVEN",
  "SNAPSHOT_BOUNDARY_MISMATCH",
  "LEDGER_STATE_INVALID",
  "LEDGER_ORDERING_UNVERIFIED",
  "UNRESOLVED_BACKLOG",
  "UNRESOLVED_ORDER",
  "UNRESOLVED_EXPOSURE",
  "UNRESOLVED_DECISION_OUTCOME",
  "SESSION_OPEN_UNPROVEN",
  "PARTIAL_SESSION_COVERAGE",
  "IDENTITY_MISMATCH",
  "COMMISSIONING_PROVENANCE_UNPROVEN",
] as const;

export type StageBExclusionReason = (typeof STAGE_B_EXCLUSION_REASONS)[number];

export interface StageBSnapshotRow {
  readonly boundaryAt: string;
  readonly capturedAt: string;
  readonly boundaryEventSequence: number | null;
  readonly state: unknown;
}

export interface StageBSessionRow {
  readonly runId: string;
  readonly marketId: string;
  readonly currency: string;
  readonly accountId: string;
  readonly sessionDate: string;
  readonly sessionTimezone: string | null;
  readonly status: string;
  readonly source: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly scheduledCloseAt: string | null;
  readonly executionModelVersion: string;
  readonly assumptions: unknown;
  readonly policy: unknown;
  readonly bindingCreatedAt: string;
  readonly accountCreatedAt: string;
  readonly accountInitialSession: string | null;
  readonly snapshot: StageBSnapshotRow | null;
  readonly pendingFactsAtCutoff: number;
  readonly openOrders: number;
  readonly unresolvedDecisionOutcomes: number;
  readonly unverifiedEventsToBoundary: number;
  readonly decisions: number;
  /** Database-clock recording time of this session's funded SESSION rollover. */
  readonly sessionOpenedAt: string | null;
}

export interface StageBChampionRow {
  readonly runId: string;
  readonly marketId: string;
  readonly sessionDate: string;
  readonly status: string;
  readonly executionModelVersion: string;
  readonly assumptions: unknown;
  readonly policy: unknown;
  readonly accountId: string;
  readonly currency: string;
}

export interface StageBAuthorityState {
  readonly gatePolicies: number;
  readonly enrollments: number;
  readonly attempts: number;
  readonly reports: number;
  readonly activeOrEligibleChallengers: number;
}

export interface StageBCommissioningProvenance {
  readonly market: StageBMarket;
  readonly proven: boolean;
  readonly basis: string;
  readonly missing: readonly string[];
}

/**
 * Market commissioning provenance is a fail-closed input, not a flag check.
 * `CA_TSX` is the primary production market and carries no open commissioning
 * checklist; `US_EQUITIES` has an open checklist whose provider, calendar,
 * adjustment and operator sign-off gates are unproven, so its retained
 * sessions stay structurally valid but not Stage B-eligible. Changing this
 * record requires a reviewed operator sign-off receipt, not a code edit.
 */
export const STAGE_B_COMMISSIONING_PROVENANCE: Readonly<
  Record<StageBMarket, StageBCommissioningProvenance>
> = {
  CA_TSX: {
    market: "CA_TSX",
    proven: true,
    basis:
      "primary production market; no open CA_TSX commissioning checklist is recorded",
    missing: [],
  },
  US_EQUITIES: {
    market: "US_EQUITIES",
    proven: false,
    basis: "private development record remains open",
    missing: [
      "PROVIDER_EVIDENCE_SAMPLES",
      "US_HOLIDAY_AND_CANADIAN_HOLIDAY_CAPTURES",
      "BROKER_UI_QUOTE_COMPARISON",
      "TWO_OBSERVATION_ONLY_US_SESSIONS_WITH_RESTART",
      "OPERATOR_SIGN_OFF",
    ],
  },
};

export interface StageBSessionEntry {
  readonly sessionDate: string;
  readonly runId: string;
  readonly accountId: string;
  readonly currency: string;
  readonly policyDigest: string;
  readonly assumptionsDigest: string;
  readonly executionModelVersion: string;
  readonly openingEquity: number;
  readonly equity: number;
  readonly netPnl: number;
  readonly netReturn: number;
  readonly boundaryAt: string;
  readonly completedAt: string;
}

export interface StageBExcludedSession {
  readonly sessionDate: string;
  readonly runId: string;
  readonly reasons: readonly StageBExclusionReason[];
}

export interface StageBReadinessReport {
  readonly schema: "stage-b-readiness-v1";
  readonly market: StageBMarket;
  readonly currency: "CAD" | "USD";
  readonly asOf: string;
  readonly rawSessionCount: number;
  readonly candidateSessionCount: number;
  readonly structuralSessionCount: number;
  readonly eligibleSessionCount: number;
  readonly excludedSessionCount: number;
  readonly remainingRequired: number;
  readonly earliestEligibleSession: string | null;
  readonly latestEligibleSession: string | null;
  readonly exclusionsByReason: Readonly<Record<string, number>>;
  readonly excludedSessions: readonly StageBExcludedSession[];
  readonly includedSessions: readonly StageBSessionEntry[];
  readonly manifestDigest: string;
  readonly netReturns: {
    readonly mean: number | null;
    readonly sampleStandardDeviation: number | null;
    readonly sampleStandardDeviationConvention: "SAMPLE_N_MINUS_ONE";
    readonly absolutePnlSampleStandardDeviation: number | null;
  };
  readonly sdReference: number | null;
  readonly mMarketCandidate: number | null;
  readonly mMarketAuthoritative: false;
  readonly verdict: StageBVerdict;
  readonly champion: {
    readonly runId: string;
    readonly accountId: string;
    readonly currency: string;
    readonly sessionDate: string;
    readonly status: string;
    readonly policyDigest: string;
    readonly assumptionsDigest: string;
    readonly executionModelVersion: string;
  } | null;
  readonly commissioning: StageBCommissioningProvenance;
  readonly authorityState: StageBAuthorityState;
  readonly missingTradingSessions: readonly string[];
  readonly blockers: readonly string[];
  readonly notes: readonly string[];
}

export interface StageBReadinessInput {
  readonly market: StageBMarket;
  readonly asOf: string;
  readonly schemaVersion: number | null;
  readonly codeRevision: string | null;
  readonly champion: StageBChampionRow | null;
  readonly sessions: readonly StageBSessionRow[];
  readonly authorityState: StageBAuthorityState;
}

export interface StageBReadinessReceipt {
  readonly schema: "stage-b-readiness-receipt-v1";
  readonly generatedAt: string;
  readonly databaseNow: string;
  readonly codeRevision: string | null;
  readonly schemaVersion: number | null;
  readonly databaseCutoff: string;
  readonly report: StageBReadinessReport;
}

function toIso(value: string | Date): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function optionalIso(value: string | Date | null): string | null {
  return value === null || value === undefined ? null : toIso(value);
}

function asLedger(state: unknown): FundedLedger | null {
  if (!state || typeof state !== "object") return null;
  const candidate = state as Partial<FundedLedger>;
  if (
    candidate.version !== "funded-ledger-v1" ||
    typeof candidate.cash !== "number" ||
    typeof candidate.openingEquity !== "number" ||
    typeof candidate.session !== "string" ||
    typeof candidate.lastEventAt !== "string" ||
    !candidate.positions ||
    !candidate.reservations
  )
    return null;
  return candidate as FundedLedger;
}

function sessionOpenAt(
  market: StageBMarket,
  sessionDate: string,
): string | null {
  const sessions = getRecentRegularSessions(market, sessionDate, 1);
  const last = sessions.at(-1);
  if (!last || last.tradingDate !== sessionDate) return null;
  return toIso(last.open);
}

function sampleStatistics(values: readonly number[]): {
  mean: number | null;
  sampleStandardDeviation: number | null;
} {
  if (values.length === 0) return { mean: null, sampleStandardDeviation: null };
  const mean =
    values.reduce((total, value) => total + value, 0) / values.length;
  if (values.length < 2) return { mean, sampleStandardDeviation: null };
  const variance =
    values.reduce((total, value) => total + (value - mean) ** 2, 0) /
    (values.length - 1);
  return { mean, sampleStandardDeviation: Math.sqrt(variance) };
}

interface EvaluatedSession {
  readonly row: StageBSessionRow;
  readonly reasons: StageBExclusionReason[];
  readonly entry: StageBSessionEntry | null;
}

function evaluateSession(
  row: StageBSessionRow,
  input: {
    market: StageBMarket;
    currency: "CAD" | "USD";
    asOf: string;
    champion: StageBChampionRow | null;
    overlapLoser: boolean;
    commissioning: StageBCommissioningProvenance;
  },
): EvaluatedSession {
  const reasons: StageBExclusionReason[] = [];
  const add = (reason: StageBExclusionReason) => {
    if (!reasons.includes(reason)) reasons.push(reason);
  };

  if (row.marketId !== input.market) add("MARKET_MISMATCH");
  if (row.currency !== input.currency) add("CURRENCY_MISMATCH");
  if (!isMarketTradingDay(row.sessionDate, input.market as MarketId))
    add("NOT_A_TRADING_SESSION");
  if (input.overlapLoser) add("OVERLAPPING_SESSION");
  if (!input.champion) {
    add("ACCOUNT_NOT_CHAMPION_ACCOUNT");
  } else if (row.accountId !== input.champion.accountId) {
    add("ACCOUNT_NOT_CHAMPION_ACCOUNT");
  }

  let entry: StageBSessionEntry | null = null;
  let ledger: FundedLedger | null = null;
  const snapshot = row.snapshot;
  if (!snapshot) {
    add("SNAPSHOT_MISSING");
  } else {
    if (toIso(snapshot.capturedAt) > input.asOf) add("SNAPSHOT_AFTER_CUTOFF");
    if (snapshot.boundaryEventSequence === null) {
      add("SNAPSHOT_CURSOR_UNPROVEN");
    }
    const boundaryAt = toIso(snapshot.boundaryAt);
    ledger = asLedger(snapshot.state);
    if (!ledger) {
      add("LEDGER_STATE_INVALID");
    } else {
      const boundaryMismatch =
        ledger.session !== row.sessionDate ||
        ledger.currency !== row.currency ||
        toIso(ledger.lastEventAt) !== boundaryAt ||
        boundaryAt < toIso(row.startedAt) ||
        boundaryAt > toIso(row.completedAt);
      if (boundaryMismatch) add("SNAPSHOT_BOUNDARY_MISMATCH");
      const summary = fundedAccountSummary(ledger, boundaryAt, 86_400_000);
      const netPnl = summary.dailyPnl;
      const netReturn = netPnl / ledger.openingEquity;
      if (!boundaryMismatch) {
        entry = {
          sessionDate: row.sessionDate,
          runId: row.runId,
          accountId: row.accountId,
          currency: row.currency,
          policyDigest: fundedPolicyDigest(row.policy),
          assumptionsDigest: contentHash(row.assumptions),
          executionModelVersion: row.executionModelVersion,
          openingEquity: ledger.openingEquity,
          equity: summary.equity,
          netPnl,
          netReturn,
          boundaryAt,
          completedAt: toIso(row.completedAt),
        };
      }
    }
  }
  if (row.unverifiedEventsToBoundary > 0) add("LEDGER_ORDERING_UNVERIFIED");
  if (row.pendingFactsAtCutoff > 0) add("UNRESOLVED_BACKLOG");
  if (row.openOrders > 0) add("UNRESOLVED_ORDER");
  if (
    ledger &&
    (Object.keys(ledger.positions).length > 0 ||
      Object.keys(ledger.reservations).length > 0)
  )
    add("UNRESOLVED_EXPOSURE");
  if (row.unresolvedDecisionOutcomes > 0) add("UNRESOLVED_DECISION_OUTCOME");

  const open = sessionOpenAt(input.market, row.sessionDate);
  const openedAt = row.sessionOpenedAt
    ? toIso(row.sessionOpenedAt)
    : row.accountInitialSession === row.sessionDate
      ? toIso(row.accountCreatedAt)
      : null;
  if (!openedAt) add("SESSION_OPEN_UNPROVEN");
  else if (open && openedAt > open) add("PARTIAL_SESSION_COVERAGE");
  if (open && toIso(row.bindingCreatedAt) > open)
    add("PARTIAL_SESSION_COVERAGE");
  if (open && toIso(row.startedAt) > open) add("PARTIAL_SESSION_COVERAGE");

  if (input.champion && entry) {
    if (
      entry.policyDigest !== fundedPolicyDigest(input.champion.policy) ||
      entry.assumptionsDigest !== contentHash(input.champion.assumptions) ||
      entry.executionModelVersion !== input.champion.executionModelVersion
    )
      add("IDENTITY_MISMATCH");
  }
  if (!input.commissioning.proven) add("COMMISSIONING_PROVENANCE_UNPROVEN");

  return { row, reasons, entry };
}

export function analyzeStageBReadiness(
  input: StageBReadinessInput,
): StageBReadinessReport {
  const currency = STAGE_B_MARKET_CURRENCY[input.market];
  const commissioning = STAGE_B_COMMISSIONING_PROVENANCE[input.market];

  const ordered = [...input.sessions].sort((left, right) => {
    if (left.sessionDate !== right.sessionDate)
      return left.sessionDate < right.sessionDate ? -1 : 1;
    if (left.startedAt !== right.startedAt)
      return left.startedAt < right.startedAt ? -1 : 1;
    return left.runId < right.runId ? -1 : left.runId > right.runId ? 1 : 0;
  });

  const firstBySession = new Map<string, string>();
  for (const row of ordered)
    if (!firstBySession.has(row.sessionDate))
      firstBySession.set(row.sessionDate, row.runId);

  const structuralReasons: StageBExclusionReason[] = [
    "MARKET_MISMATCH",
    "CURRENCY_MISMATCH",
    "NOT_A_TRADING_SESSION",
    "OVERLAPPING_SESSION",
    "ACCOUNT_NOT_CHAMPION_ACCOUNT",
  ];

  const evaluated = ordered.map((row) =>
    evaluateSession(row, {
      market: input.market,
      currency,
      asOf: input.asOf,
      champion: input.champion,
      overlapLoser: firstBySession.get(row.sessionDate) !== row.runId,
      commissioning,
    }),
  );

  const candidateSessionCount = evaluated.filter(
    (session) =>
      !session.reasons.some((reason) => structuralReasons.includes(reason)),
  ).length;
  const structuralSessionCount = evaluated.filter(
    (session) =>
      session.reasons.length === 0 ||
      (session.reasons.length === 1 &&
        session.reasons[0] === "COMMISSIONING_PROVENANCE_UNPROVEN"),
  ).length;
  const eligible = evaluated.filter((session) => session.reasons.length === 0);
  const includedSessions = eligible
    .map((session) => session.entry!)
    .sort((left, right) =>
      left.sessionDate < right.sessionDate
        ? -1
        : left.sessionDate > right.sessionDate
          ? 1
          : left.runId < right.runId
            ? -1
            : 1,
    );

  const exclusionsByReason: Record<string, number> = {};
  for (const session of evaluated)
    for (const reason of session.reasons)
      exclusionsByReason[reason] = (exclusionsByReason[reason] ?? 0) + 1;

  const manifestDigest = contentHash({
    market: input.market,
    currency,
    sessions: includedSessions,
  });
  const netReturns = includedSessions.map((session) => session.netReturn);
  const statistics = sampleStatistics(netReturns);
  const absolutePnlStatistics = sampleStatistics(
    includedSessions.map((session) => session.netPnl),
  );
  const sufficient = includedSessions.length >= STAGE_B_REFERENCE_MIN_SESSIONS;
  const sdReference = sufficient ? statistics.sampleStandardDeviation : null;
  const mMarketCandidate =
    sdReference === null
      ? null
      : sdReference * STAGE_B_PRACTICAL_EFFECT_FRACTION;

  const blockers: string[] = [];
  if (!input.champion) blockers.push("CHAMPION_IDENTITY_UNRESOLVED");
  if (!commissioning.proven)
    blockers.push(
      `COMMISSIONING_PROVENANCE_UNPROVEN (${commissioning.missing.join(",")})`,
    );
  if (input.authorityState.gatePolicies > 0)
    blockers.push("GATE_POLICY_PRESENT_WITHOUT_STAGE_B");
  if (input.authorityState.enrollments > 0)
    blockers.push("ENROLLMENT_PRESENT_WITHOUT_STAGE_B");
  if (
    input.authorityState.activeOrEligibleChallengers > 0 &&
    input.authorityState.enrollments > 0
  )
    blockers.push("ACTIVE_OR_ELIGIBLE_CHALLENGER_PRESENT");

  let verdict: StageBVerdict;
  if (!input.champion) verdict = "EVIDENCE_UNAVAILABLE";
  else if (!commissioning.proven) verdict = "EVIDENCE_UNAVAILABLE";
  else if (sufficient) verdict = "READY_FOR_STAGE_B_REVIEW";
  else if (
    candidateSessionCount > 0 &&
    eligible.length === 0 &&
    evaluated.some((session) => session.reasons.includes("IDENTITY_MISMATCH"))
  )
    verdict = "IDENTITY_MISMATCH";
  else verdict = "INSUFFICIENT_SESSIONS";

  const missingTradingSessions: string[] = [];
  if (ordered.length > 0) {
    const first = ordered[0]!.sessionDate;
    const calendar = getRecentRegularSessions(
      input.market,
      input.asOf.slice(0, 10),
      400,
    );
    const covered = new Set(ordered.map((row) => row.sessionDate));
    for (const session of calendar)
      if (session.tradingDate >= first && !covered.has(session.tradingDate))
        missingTradingSessions.push(session.tradingDate);
  }

  const notes = [
    "M_market is only computed from at least 40 eligible sessions; a value below that threshold is never authoritative.",
    "Per-session net return is the run-end snapshot equity minus its session opening equity, divided by the opening equity.",
    "The sample standard deviation uses the n-1 denominator over included sessions in ascending session order.",
    "US sessions remain structurally valid but not Stage B-eligible until commissioning provenance is recorded.",
  ];

  return {
    schema: "stage-b-readiness-v1",
    market: input.market,
    currency,
    asOf: input.asOf,
    rawSessionCount: evaluated.length,
    candidateSessionCount,
    structuralSessionCount,
    eligibleSessionCount: includedSessions.length,
    excludedSessionCount: evaluated.length - includedSessions.length,
    remainingRequired: Math.max(
      0,
      STAGE_B_REFERENCE_MIN_SESSIONS - includedSessions.length,
    ),
    earliestEligibleSession: includedSessions[0]?.sessionDate ?? null,
    latestEligibleSession: includedSessions.at(-1)?.sessionDate ?? null,
    exclusionsByReason,
    excludedSessions: evaluated
      .filter((session) => session.reasons.length > 0)
      .map((session) => ({
        sessionDate: session.row.sessionDate,
        runId: session.row.runId,
        reasons: session.reasons,
      })),
    includedSessions,
    manifestDigest,
    netReturns: {
      mean: statistics.mean,
      sampleStandardDeviation: statistics.sampleStandardDeviation,
      sampleStandardDeviationConvention: "SAMPLE_N_MINUS_ONE",
      absolutePnlSampleStandardDeviation:
        absolutePnlStatistics.sampleStandardDeviation,
    },
    sdReference,
    mMarketCandidate,
    mMarketAuthoritative: false,
    verdict,
    champion: input.champion
      ? {
          runId: input.champion.runId,
          accountId: input.champion.accountId,
          currency: input.champion.currency,
          sessionDate: input.champion.sessionDate,
          status: input.champion.status,
          policyDigest: fundedPolicyDigest(input.champion.policy),
          assumptionsDigest: contentHash(input.champion.assumptions),
          executionModelVersion: input.champion.executionModelVersion,
        }
      : null,
    commissioning,
    authorityState: input.authorityState,
    missingTradingSessions,
    blockers,
    notes,
  };
}

interface SessionQueryRow {
  run_id: string;
  market_id: string;
  session_date: string;
  session_timezone: string | null;
  status: string;
  source: string;
  started_at: string | Date;
  completed_at: string | Date;
  scheduled_close_at: string | Date | null;
  execution_model_version: string;
  assumptions: unknown;
  account_id: string;
  currency: string;
  policy: unknown;
  binding_created_at: string | Date;
  account_created_at: string | Date;
  account_initial_session: string | null;
  boundary_at: string | Date | null;
  captured_at: string | Date | null;
  boundary_event_sequence: string | number | null;
  state: unknown;
}

function normalizeSessionDate(value: string | Date): string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? value
    : toIso(value).slice(0, 10);
}
export interface StageBReadinessLoad {
  readonly databaseNow: string;
  readonly cutoff: string;
  readonly schemaVersion: number | null;
  readonly champion: StageBChampionRow | null;
  readonly sessions: StageBSessionRow[];
  readonly authorityState: StageBAuthorityState;
}

/** Loads every input the analyzer needs inside one read-only transaction. */
export async function loadStageBReadiness(
  client: PoolClient,
  market: StageBMarket,
  asOf?: string,
): Promise<StageBReadinessLoad> {
  const meta = await client.query<{
    database_now: string | Date;
    schema_version: string | number | null;
  }>(
    `SELECT clock_timestamp() AS database_now,
            (SELECT max(substring(filename FROM '^([0-9]+)-')::integer)
             FROM schema_migration) AS schema_version`,
  );
  const databaseNow = toIso(meta.rows[0]!.database_now);
  const cutoff = asOf ?? databaseNow;
  const schemaVersion =
    meta.rows[0]!.schema_version === null
      ? null
      : Number(meta.rows[0]!.schema_version);

  const championResult = await client.query<{
    run_id: string;
    market_id: string;
    session_date: string;
    status: string;
    execution_model_version: string;
    assumptions: unknown;
    account_id: string;
    currency: string;
    policy: unknown;
  }>(
    `SELECT r.id AS run_id, r.market_id, r.session_date::text AS session_date,
            r.status, r.execution_model_version, r.assumptions,
            b.account_id, b.currency, b.policy
     FROM paper_bot_run r
     JOIN paper_funded_run b ON b.run_id = r.id
     WHERE r.source='LIVE' AND r.market_id=$1
       AND r.started_at <= $2::timestamptz
       AND (r.completed_at IS NULL OR r.completed_at <= $2::timestamptz)
     ORDER BY r.session_date DESC, r.started_at DESC, r.id DESC
     LIMIT 1`,
    [market, cutoff],
  );
  const championRow = championResult.rows[0];
  const champion: StageBChampionRow | null = championRow
    ? {
        runId: championRow.run_id,
        marketId: championRow.market_id,
        sessionDate: normalizeSessionDate(championRow.session_date),
        status: championRow.status,
        executionModelVersion: championRow.execution_model_version,
        assumptions: championRow.assumptions,
        policy: championRow.policy,
        accountId: championRow.account_id,
        currency: championRow.currency,
      }
    : null;

  const sessionResult = await client.query<SessionQueryRow>(
    `SELECT r.id AS run_id, r.market_id, r.session_date::text AS session_date,
            r.session_timezone, r.status, r.source, r.started_at, r.completed_at,
            r.scheduled_close_at, r.execution_model_version, r.assumptions,
            b.account_id, b.currency, b.policy, b.created_at AS binding_created_at,
            a.created_at AS account_created_at,
            a.initial_state->>'session' AS account_initial_session,
            s.boundary_at, s.captured_at, s.boundary_event_sequence, s.state
     FROM paper_bot_run r
     JOIN paper_funded_run b ON b.run_id = r.id
     JOIN paper_funded_account a ON a.id = b.account_id
     LEFT JOIN paper_funded_run_snapshot s ON s.run_id = r.id
     WHERE r.source='LIVE' AND r.market_id=$1 AND r.status='COMPLETED'
       AND r.completed_at <= $2::timestamptz
     ORDER BY r.session_date ASC, r.started_at ASC, r.id ASC`,
    [market, cutoff],
  );

  const runIds = sessionResult.rows.map((row) => row.run_id);
  const pendingFacts = await queryCounts(
    client,
    `SELECT run_id, count(*)::int AS count FROM paper_funded_fact
     WHERE run_id = ANY($1::uuid[]) AND (processed_at IS NULL OR processed_at > $2::timestamptz)
     GROUP BY run_id`,
    [runIds, cutoff],
  );
  const openOrders = await queryCounts(
    client,
    `SELECT run_id, count(*)::int AS count FROM paper_entry_order
     WHERE run_id = ANY($1::uuid[])
       AND (state->>'status'='PENDING'
            OR state->'execution'->>'status' IN ('OPEN','CLOSE_PENDING'))
     GROUP BY run_id`,
    [runIds],
  );
  const unresolvedOutcomes = await queryCounts(
    client,
    `SELECT run_id, count(*)::int AS count FROM funded_decision_outcome
     WHERE run_id = ANY($1::uuid[]) AND status='UNRESOLVED'
     GROUP BY run_id`,
    [runIds],
  );
  const decisionCounts = await queryCounts(
    client,
    `SELECT run_id, count(*)::int AS count FROM funded_decision_evidence
     WHERE run_id = ANY($1::uuid[])
     GROUP BY run_id`,
    [runIds],
  );

  const accountIds = [
    ...new Set(sessionResult.rows.map((row) => row.account_id)),
  ];
  const sessionOpens = new Map<string, string>();
  const unverified = new Map<string, number>();
  for (const accountId of accountIds) {
    const opens = await client.query<{
      session: string;
      recorded_at: string | Date;
    }>(
      `SELECT DISTINCT ON (e.event->>'session') e.event->>'session' AS session,
              e.recorded_at
       FROM paper_funded_event e
       WHERE e.account_id=$1 AND e.event->>'type'='SESSION'
       ORDER BY e.event->>'session', e.event_sequence`,
      [accountId],
    );
    for (const open of opens.rows)
      sessionOpens.set(`${accountId}:${open.session}`, toIso(open.recorded_at));
  }
  for (const row of sessionResult.rows) {
    if (row.boundary_event_sequence === null) continue;
    const unverifiedRow = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM paper_funded_event e
       WHERE e.account_id=$1 AND e.event_sequence <= $2
         AND NOT e.event_sequence_verified`,
      [row.account_id, Number(row.boundary_event_sequence)],
    );
    unverified.set(row.run_id, unverifiedRow.rows[0]!.count);
  }

  const authority = await client.query<{
    gate_policies: number;
    enrollments: number;
    attempts: number;
    reports: number;
    challengers: number;
  }>(
    `SELECT
       (SELECT count(*)::int FROM funded_shadow_gate_policy WHERE market_id=$1) AS gate_policies,
       (SELECT count(*)::int FROM funded_shadow_enrollment WHERE market_id=$1) AS enrollments,
       (SELECT count(*)::int FROM funded_shadow_attempt a
          JOIN funded_shadow_batch b ON b.id = a.batch_id
          JOIN funded_shadow_enrollment e ON e.id = b.enrollment_id
         WHERE e.market_id=$1) AS attempts,
       (SELECT count(*)::int FROM funded_shadow_report r
          JOIN funded_shadow_enrollment e ON e.id = r.enrollment_id
         WHERE e.market_id=$1) AS reports,
        (SELECT count(*)::int FROM funded_execution_challenger
          WHERE market_id=$1 AND (active OR eligible_for_activation)) AS challengers`,
    [market],
  );
  const authorityRow = authority.rows[0]!;

  const sessions: StageBSessionRow[] = sessionResult.rows.map((row) => ({
    runId: row.run_id,
    marketId: row.market_id,
    currency: row.currency,
    accountId: row.account_id,
    sessionDate: normalizeSessionDate(row.session_date),
    sessionTimezone: row.session_timezone,
    status: row.status,
    source: row.source,
    startedAt: toIso(row.started_at),
    completedAt: toIso(row.completed_at),
    scheduledCloseAt: optionalIso(row.scheduled_close_at),
    executionModelVersion: row.execution_model_version,
    assumptions: row.assumptions,
    policy: row.policy,
    bindingCreatedAt: toIso(row.binding_created_at),
    accountCreatedAt: toIso(row.account_created_at),
    accountInitialSession: row.account_initial_session,
    snapshot:
      row.boundary_at === null || row.captured_at === null
        ? null
        : {
            boundaryAt: toIso(row.boundary_at),
            capturedAt: toIso(row.captured_at),
            boundaryEventSequence:
              row.boundary_event_sequence === null
                ? null
                : Number(row.boundary_event_sequence),
            state: row.state,
          },
    pendingFactsAtCutoff: pendingFacts.get(row.run_id) ?? 0,
    openOrders: openOrders.get(row.run_id) ?? 0,
    unresolvedDecisionOutcomes: unresolvedOutcomes.get(row.run_id) ?? 0,
    unverifiedEventsToBoundary: unverified.get(row.run_id) ?? 0,
    decisions: decisionCounts.get(row.run_id) ?? 0,
    sessionOpenedAt:
      sessionOpens.get(
        `${row.account_id}:${normalizeSessionDate(row.session_date)}`,
      ) ?? null,
  }));

  return {
    databaseNow,
    cutoff,
    schemaVersion,
    champion,
    sessions,
    authorityState: {
      gatePolicies: authorityRow.gate_policies,
      enrollments: authorityRow.enrollments,
      attempts: authorityRow.attempts,
      reports: authorityRow.reports,
      activeOrEligibleChallengers: authorityRow.challengers,
    },
  };
}

async function queryCounts(
  client: PoolClient,
  sql: string,
  parameters: readonly unknown[],
): Promise<Map<string, number>> {
  const result = await client.query<{ run_id: string; count: number }>(
    sql,
    parameters as unknown[],
  );
  return new Map(result.rows.map((row) => [row.run_id, Number(row.count)]));
}

export interface StageBReadinessOptions {
  readonly market: StageBMarket;
  readonly asOf?: string;
  readonly codeRevision?: string;
}

export async function runStageBReadiness(
  pool: Pool,
  options: StageBReadinessOptions,
): Promise<StageBReadinessReceipt> {
  const client = await pool.connect();
  try {
    await client.query(
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    await client.query("SET LOCAL statement_timeout = '30000'");
    const load = await loadStageBReadiness(
      client,
      options.market,
      options.asOf,
    );
    await client.query("COMMIT");
    const report = analyzeStageBReadiness({
      market: options.market,
      asOf: load.cutoff,
      schemaVersion: load.schemaVersion,
      codeRevision: options.codeRevision ?? null,
      champion: load.champion,
      sessions: load.sessions,
      authorityState: load.authorityState,
    });
    return {
      schema: "stage-b-readiness-receipt-v1",
      generatedAt: load.databaseNow,
      databaseNow: load.databaseNow,
      codeRevision: options.codeRevision ?? null,
      schemaVersion: load.schemaVersion,
      databaseCutoff: load.cutoff,
      report,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export function stageBReadinessSummary(report: StageBReadinessReport): string {
  const lines = [
    `Stage B readiness — ${report.market}/${report.currency} as of ${report.asOf}`,
    `verdict: ${report.verdict}`,
    `raw ${report.rawSessionCount} | candidate ${report.candidateSessionCount} | structural ${report.structuralSessionCount} | eligible ${report.eligibleSessionCount} | excluded ${report.excludedSessionCount}`,
    `reference window: ${report.earliestEligibleSession ?? "none"} .. ${report.latestEligibleSession ?? "none"}`,
    `manifest digest: ${report.manifestDigest}`,
    `remaining eligible sessions required: ${report.remainingRequired}`,
  ];
  if (report.sdReference !== null && report.mMarketCandidate !== null)
    lines.push(
      `SD_reference: ${report.sdReference} | candidate M_market (non-authoritative): ${report.mMarketCandidate}`,
    );
  else
    lines.push(
      "SD_reference: not computable (fewer than 40 eligible sessions); no M_market is published",
    );
  if (Object.keys(report.exclusionsByReason).length > 0)
    lines.push(
      `exclusions: ${Object.entries(report.exclusionsByReason)
        .map(([reason, count]) => `${reason}=${count}`)
        .join(", ")}`,
    );
  if (report.blockers.length > 0)
    lines.push(`blockers: ${report.blockers.join("; ")}`);
  return lines.join("\n");
}
