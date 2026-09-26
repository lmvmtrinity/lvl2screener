import {
  strategyLearningScopeSchema,
  type StrategyLearningScope,
  type StrategyLearningReadiness,
} from "@tsx-scanner/contracts";
import type { Pool } from "pg";
import { canonicalJson } from "./research-coverage.js";
import { DomainError } from "../errors.js";

export { strategyLearningScopeSchema };
export type { StrategyLearningScope };

export type StrategyLearningEvidenceRecord = {
  scope: StrategyLearningScope;
  setupInstanceId: string | null;
  sessionDate: string;
  signalHour: number | null;
  atrPct: number | null;
  rvolAtTime: number | null;
  coverageVerified: boolean;
  lineageVerified: boolean;
  candidateCount: number;
  qualification: "EVIDENCE_QUALIFIED" | "EXPLORATORY";
  closedOutcome: {
    netPnl: number;
    rMultiple: number;
    exitReason: string;
    exitTime: string;
    entryPrice: number;
    exitPrice: number;
  } | null;
};

export function assessStrategyLearningReadiness(
  scope: StrategyLearningScope,
  records: readonly StrategyLearningEvidenceRecord[],
  options: {
    targetDistinctTrades: number;
    recentSessions: number;
  },
): StrategyLearningReadiness {
  const matching = records.filter(
    (record) => canonicalJson(record.scope) === canonicalJson(scope),
  );
  const exclusions: Record<string, number> = {};
  const blockers = new Set<string>();
  const count = (key: string) => {
    exclusions[key] = (exclusions[key] ?? 0) + 1;
  };
  const incompatibleScopeCount = records.length - matching.length;
  if (incompatibleScopeCount > 0)
    exclusions.INCOMPATIBLE_SCOPE = incompatibleScopeCount;
  const verifiedSessions = new Set<string>();
  const outcomes = new Map<string, StrategyLearningEvidenceRecord>();
  const conflictingIdentities = new Set<string>();

  for (const record of matching) {
    if (!record.coverageVerified) {
      blockers.add("UNVERIFIED_COVERAGE");
      count("UNVERIFIED_COVERAGE");
      continue;
    }
    if (!record.lineageVerified) {
      blockers.add("UNVERIFIED_LINEAGE");
      count("UNVERIFIED_LINEAGE");
      continue;
    }
    if (record.candidateCount === 0) {
      count("NO_REPLAY_CANDIDATES");
      continue;
    }
    verifiedSessions.add(record.sessionDate);
    if (!record.closedOutcome) continue;
    if (!record.setupInstanceId) {
      count("MISSING_OUTCOME_IDENTITY");
      blockers.add("MISSING_OUTCOME_IDENTITY");
      continue;
    }
    if (conflictingIdentities.has(record.setupInstanceId)) continue;
    const existing = outcomes.get(record.setupInstanceId);
    if (existing) {
      const identityEvidence = (value: StrategyLearningEvidenceRecord) => ({
        sessionDate: value.sessionDate,
        signalHour: value.signalHour,
        atrPct: value.atrPct,
        rvolAtTime: value.rvolAtTime,
        closedOutcome: value.closedOutcome,
      });
      if (
        canonicalJson(identityEvidence(existing)) !==
        canonicalJson(identityEvidence(record))
      ) {
        outcomes.delete(record.setupInstanceId);
        conflictingIdentities.add(record.setupInstanceId);
        blockers.add("CONFLICTING_DUPLICATE_OUTCOME_IDENTITY");
        count("CONFLICTING_DUPLICATE_OUTCOME_IDENTITY");
      } else if (
        existing.qualification === "EXPLORATORY" &&
        record.qualification === "EVIDENCE_QUALIFIED"
      ) {
        outcomes.set(record.setupInstanceId, {
          ...existing,
          qualification: "EVIDENCE_QUALIFIED",
        });
      }
      continue;
    }
    outcomes.set(record.setupInstanceId, record);
  }

  const unique = [...outcomes.values()];
  const qualificationCounts = {
    EVIDENCE_QUALIFIED: unique.filter(
      (record) => record.qualification === "EVIDENCE_QUALIFIED",
    ).length,
    EXPLORATORY: unique.filter(
      (record) => record.qualification === "EXPLORATORY",
    ).length,
  };
  const usable = unique.filter(
    (record) =>
      record.atrPct !== null &&
      Number.isFinite(record.atrPct) &&
      record.rvolAtTime !== null &&
      Number.isFinite(record.rvolAtTime),
  );
  for (const record of unique) {
    if (!usable.includes(record)) count("MISSING_MODEL_FEATURES");
  }
  const strata = {
    time: {} as Record<string, number>,
    atr: {} as Record<string, number>,
    rvol: {} as Record<string, number>,
  };
  for (const record of usable) {
    const hour = record.signalHour;
    const timeBucket =
      hour === null
        ? "TIME_UNKNOWN"
        : hour < 10
          ? "OPEN"
          : hour < 14
            ? "MIDDAY"
            : "CLOSE";
    strata.time[timeBucket] = (strata.time[timeBucket] ?? 0) + 1;
    const atrBucket =
      record.atrPct! < 1 ? "LOW" : record.atrPct! < 3 ? "MID" : "HIGH";
    const rvolBucket =
      record.rvolAtTime! < 1 ? "LOW" : record.rvolAtTime! < 2 ? "MID" : "HIGH";
    strata.atr[atrBucket] = (strata.atr[atrBucket] ?? 0) + 1;
    strata.rvol[rvolBucket] = (strata.rvol[rvolBucket] ?? 0) + 1;
  }
  const remaining = Math.max(0, options.targetDistinctTrades - unique.length);
  const recentDates =
    options.recentSessions > 0
      ? [...verifiedSessions].sort().slice(-options.recentSessions)
      : [];
  const recentCounts = new Map(recentDates.map((date) => [date, 0]));
  for (const record of unique) {
    if (recentCounts.has(record.sessionDate)) {
      recentCounts.set(
        record.sessionDate,
        recentCounts.get(record.sessionDate)! + 1,
      );
    }
  }
  const rates = [...recentCounts.values()];
  const estimate =
    recentDates.length > 0 && rates.length > 0 && Math.min(...rates) > 0
      ? {
          state: "AVAILABLE_RANGE" as const,
          minSessions: Math.ceil(remaining / Math.max(...rates)),
          maxSessions: Math.ceil(remaining / Math.min(...rates)),
          observedRateMin: Math.min(...rates),
          observedRateMax: Math.max(...rates),
          observedSessions: recentDates.length,
        }
      : {
          state: "UNAVAILABLE" as const,
          reason:
            recentDates.length === 0
              ? ("NO_VERIFIED_SESSIONS" as const)
              : ("ZERO_OUTCOME_SESSION" as const),
          observedRateMin: rates.length ? Math.min(...rates) : null,
          observedRateMax: rates.length ? Math.max(...rates) : null,
          observedSessions: recentDates.length,
        };
  const state = blockers.size
    ? "UNVERIFIED_INPUT"
    : unique.length >= options.targetDistinctTrades
      ? "SAMPLE_THRESHOLD_MET"
      : "WAITING_FOR_EVIDENCE";
  return {
    sourceKind: "BACKTEST_RUN",
    scope,
    state,
    targetDistinctTrades: options.targetDistinctTrades,
    verifiedSessions: verifiedSessions.size,
    distinctClosedTrades: unique.length,
    usableModelRows: usable.length,
    qualificationCounts,
    exclusions,
    strata,
    blockers: [...blockers].sort(),
    shortfall: Math.max(0, options.targetDistinctTrades - unique.length),
    feasibility: {
      state: "UNAVAILABLE",
      reason: "MISSING_PREDECLARED_EXPERIMENT_CRITERIA",
    },
    collectionEstimate: estimate,
  };
}

type EvidenceDbRow = {
  profile_config_id: string;
  strategy_key: string;
  strategy_version: string;
  config_version: string;
  execution_model_version: string;
  execution_assumptions: Record<string, unknown>;
  setup_instance_id: string | null;
  session_date: string;
  signal_hour: number | null;
  atr_pct: number | null;
  rvol_at_time: number | null;
  coverage_verified: boolean;
  lineage_verified: boolean;
  candidate_count: number;
  qualification: "EVIDENCE_QUALIFIED" | "EXPLORATORY";
  net_pnl: number | null;
  r_multiple: number | null;
  exit_reason: string | null;
  exit_time: string | null;
  entry_price: number | null;
  exit_price: number | null;
};

export class StrategyLearningReadinessRepository {
  constructor(private readonly pool: Pool) {}

  async resolveBacktestScope(
    runId: string,
    strategyKey: string,
    requestedMarket: StrategyLearningScope["marketId"],
  ): Promise<StrategyLearningScope> {
    const result = await this.pool.query<{
      market_id: StrategyLearningScope["marketId"];
      status: string;
      strategies: string[];
      strategy_version: string;
      config_version: string;
      execution_model_version: string | null;
      execution_assumptions: Record<string, unknown> | null;
      profile_config_id: string | null;
      evidence_strategy_version: string | null;
      evidence_config_version: string | null;
    }>(
      `SELECT r.market_id,r.status,r.strategies,r.strategy_version,r.config_version,
              r.execution_model_version,r.execution_assumptions,
              pce.profile_config_id::text,
              pce.strategy_version AS evidence_strategy_version,
              pc.config_version AS evidence_config_version
         FROM backtest_run r
         LEFT JOIN profile_config_evidence pce
           ON pce.backtest_run_id=r.id AND pce.strategy_key=$2 AND pce.revoked_at IS NULL
         LEFT JOIN scanner_profile_config pc ON pc.id=pce.profile_config_id
        WHERE r.id=$1::uuid`,
      [runId, strategyKey],
    );
    if (!result.rows.length)
      throw new DomainError(
        "BACKTEST_RUN_NOT_FOUND",
        "Backtest run not found",
        404,
      );
    const row = result.rows[0]!;
    if (row.market_id !== requestedMarket)
      throw new DomainError(
        "BACKTEST_MARKET_MISMATCH",
        "Requested market does not match the selected backtest run",
        409,
      );
    if (row.status !== "COMPLETED")
      throw new DomainError(
        "BACKTEST_SCOPE_UNAVAILABLE",
        "Readiness requires a completed backtest run",
        422,
      );
    if (!row.strategies.includes(strategyKey))
      throw new DomainError(
        "BACKTEST_SCOPE_UNAVAILABLE",
        "Selected strategy is not part of this backtest run",
        422,
      );
    if (result.rows.length > 1)
      throw new DomainError(
        "BACKTEST_SCOPE_AMBIGUOUS",
        "Multiple profile evidence records match this run and strategy",
        409,
      );
    if (
      !row.profile_config_id ||
      !row.evidence_strategy_version ||
      !row.evidence_config_version ||
      row.evidence_strategy_version !== row.strategy_version ||
      row.evidence_config_version !== row.config_version ||
      !row.execution_model_version ||
      !row.execution_assumptions ||
      Array.isArray(row.execution_assumptions) ||
      typeof row.execution_assumptions !== "object"
    )
      throw new DomainError(
        "BACKTEST_SCOPE_UNAVAILABLE",
        "The run does not retain a complete matching profile and execution scope",
        422,
      );
    return strategyLearningScopeSchema.parse({
      marketId: row.market_id,
      strategyKey,
      profileConfigId: row.profile_config_id,
      strategyVersion: row.evidence_strategy_version,
      configVersion: row.evidence_config_version,
      executionModelVersion: row.execution_model_version,
      executionAssumptions: row.execution_assumptions,
    });
  }

  async get(
    scope: StrategyLearningScope,
    cutoff: string,
  ): Promise<StrategyLearningEvidenceRecord[]> {
    const timezone =
      scope.marketId === "CA_TSX" ? "America/Toronto" : "America/New_York";
    const result = await this.pool.query<EvidenceDbRow>(
      `WITH runs AS (
         SELECT r.*, pce.profile_config_id,pce.strategy_key,
                pce.strategy_version AS evidence_strategy_version,pce.qualification
           FROM backtest_run r
           JOIN profile_config_evidence pce ON pce.backtest_run_id=r.id
          WHERE r.market_id=$1 AND r.status='COMPLETED' AND r.completed_at <= $2::timestamptz
            AND pce.profile_config_id=$3::uuid AND pce.strategy_key=$4
            AND pce.strategy_version=$5
            AND pce.revoked_at IS NULL AND pce.created_at <= $2::timestamptz
            AND r.execution_model_version=$7
            AND r.execution_assumptions=$9::jsonb
       ), sessions AS (
         SELECT r.*, s.value AS session_input,
                (s.value->>'sessionDate')::date AS session_date,
                jsonb_array_length(COALESCE(s.value->'candidates','[]'::jsonb)) AS candidate_count
           FROM runs r CROSS JOIN LATERAL jsonb_array_elements(
             CASE WHEN jsonb_array_length(COALESCE(r.replay_input->'sessions','[]'::jsonb)) > 0
               THEN r.replay_input->'sessions' ELSE '[]'::jsonb END
           ) s(value)
         UNION ALL
         SELECT r.*, NULL::jsonb AS session_input, r.start_date AS session_date,
                jsonb_array_length(COALESCE(r.replay_input->'candidateInstruments','[]'::jsonb)) AS candidate_count
           FROM runs r
          WHERE jsonb_array_length(COALESCE(r.replay_input->'sessions','[]'::jsonb))=0
       )
      SELECT s.profile_config_id::text, s.strategy_key,
              s.evidence_strategy_version AS strategy_version,
              COALESCE(t.config_version,s.config_version) AS config_version,
              s.execution_model_version, s.execution_assumptions,
              t.setup_instance_id::text,
              s.session_date::text AS session_date,
              EXTRACT(HOUR FROM (t.signal_timestamp AT TIME ZONE $8))::int AS signal_hour,
              t.atr_pct::float8, t.rvol_at_time::float8,
              t.net_pnl::float8, t.r_multiple::float8, t.exit_reason,
              t.exit_time::text AS exit_time, t.entry_price::float8, t.exit_price::float8,
              (cr.status='VERIFIED' AND rm.hash IS NOT NULL
                AND NULLIF(cr.report->>'verifiedAt','')::timestamptz <= $2::timestamptz) AS coverage_verified,
              (b.owner_id IS NOT NULL AND b.binding->>'manifestHash'=rm.hash
                AND b.binding->>'coverageReportHash'=cr.hash
                AND b.binding->>'inputHash'=cr.input_hash
                AND rm.manifest->'purpose'->'scope'->'replayInput'=s.replay_input
                AND s.replay_input->>'candidateProvenance' IN ('HISTORICAL_MEMBERSHIP','EXPLICIT_CAPTURED_COHORT')
                AND s.session_input IS NOT NULL
                AND COALESCE(s.session_input->>'resolution','RESOLVED') <> 'NO_EVIDENCE') AS lineage_verified,
              s.candidate_count, s.qualification
         FROM sessions s
         LEFT JOIN backtest_trade t ON t.run_id=s.id
          AND (t.entry_time AT TIME ZONE $8)::date=s.session_date
          AND t.strategy_name=s.strategy_key
          AND t.strategy_version=s.evidence_strategy_version
          AND t.config_version=$6 AND t.exit_time IS NOT NULL
          AND t.exit_time <= $2::timestamptz
         LEFT JOIN research_evidence_binding b ON b.owner_kind='BACKTEST' AND b.owner_id=s.id
          AND b.market_id=s.market_id
         LEFT JOIN research_coverage_report cr ON cr.hash=b.coverage_report_hash
          AND cr.market_id=b.market_id AND cr.input_hash=b.input_hash
         LEFT JOIN research_manifest rm ON rm.hash=b.manifest_hash AND rm.market_id=b.market_id
        WHERE s.config_version=$6
        ORDER BY s.session_date,t.entry_time,t.id`,
      [
        scope.marketId,
        cutoff,
        scope.profileConfigId,
        scope.strategyKey,
        scope.strategyVersion,
        scope.configVersion,
        scope.executionModelVersion,
        timezone,
        JSON.stringify(scope.executionAssumptions),
      ],
    );
    return result.rows.map((row) => ({
      scope: {
        marketId: scope.marketId,
        strategyKey: row.strategy_key,
        profileConfigId: row.profile_config_id,
        strategyVersion: row.strategy_version,
        configVersion: row.config_version,
        executionModelVersion: row.execution_model_version,
        executionAssumptions: row.execution_assumptions,
      },
      setupInstanceId: row.setup_instance_id,
      sessionDate: row.session_date,
      signalHour: row.signal_hour,
      atrPct: row.atr_pct,
      rvolAtTime: row.rvol_at_time,
      coverageVerified: row.coverage_verified,
      lineageVerified: row.lineage_verified,
      candidateCount: row.candidate_count,
      qualification: row.qualification,
      closedOutcome:
        row.net_pnl === null ||
        row.r_multiple === null ||
        row.exit_reason === null ||
        row.exit_time === null ||
        row.entry_price === null ||
        row.exit_price === null
          ? null
          : {
              netPnl: row.net_pnl,
              rMultiple: row.r_multiple,
              exitReason: row.exit_reason,
              exitTime: row.exit_time,
              entryPrice: row.entry_price,
              exitPrice: row.exit_price,
            },
    }));
  }
}

export class StrategyLearningReadinessService {
  constructor(
    private readonly repository: StrategyLearningReadinessRepository,
  ) {}

  async getReadiness(
    scopeInput: StrategyLearningScope,
    cutoff = new Date().toISOString(),
  ): Promise<StrategyLearningReadiness> {
    const scope = strategyLearningScopeSchema.parse(scopeInput);
    const records = await this.repository.get(scope, cutoff);
    return assessStrategyLearningReadiness(scope, records, {
      targetDistinctTrades: 30,
      recentSessions: 10,
    });
  }

  async getReadinessForBacktest(
    runId: string,
    strategyKey: string,
    marketId: StrategyLearningScope["marketId"],
    cutoff = new Date().toISOString(),
  ): Promise<StrategyLearningReadiness> {
    const scope = await this.repository.resolveBacktestScope(
      runId,
      strategyKey,
      marketId,
    );
    return this.getReadiness(scope, cutoff);
  }
}
