import {
  challengerExperimentDetailSchema,
  challengerObservationReportSchema,
  challengerOutcomeSchema,
  challengerAcceptancePlanSchema,
  researchCoverageReportSchema,
  expectedInputCellSchema,
  challengerScopeSchema,
  type ChallengerExperiment,
  type ChallengerObservationReport,
  type ChallengerOutcome,
  type MarketId,
  type SessionComparisonResult,
} from "@tsx-scanner/contracts";
import type { Pool, PoolClient } from "pg";
import { contentHash } from "../backtests/research-coverage.js";
import type { ChallengerAttemptRecord } from "./challenger-attempt-repository.js";
import type { PostgresChallengerExperimentStore } from "./challenger-experiment-repository.js";
import type { ChallengerExperimentApi } from "../api-types.js";
import type { ChallengerExperimentService } from "./challenger-experiment-service.js";
import { deriveChallengerSessionCoverage } from "./challenger-session-coverage.js";
import {
  challengerActiveBoundaries,
  challengerPopulationPredicate,
} from "./challenger-population.js";
import {
  PostgresChallengerAcceptanceRepository,
  type ChallengerAcceptanceRecords,
} from "./challenger-acceptance-repository.js";
import { researchSessionDates } from "../backtests/research-lineage-service.js";
export type { ChallengerAttempt } from "@tsx-scanner/contracts";

export type ChallengerQuoteOutcome = {
  status: "CLOSED" | "OPEN" | "CLOSE_PENDING" | "NO_FILL" | "PENDING";
  rMultiple: number | null;
  /** Null is an explicit lack of a durable first-availability receipt. */
  labelAvailableAt: string | null;
  exitAt?: string | null;
};

export type ChallengerReportRow = ChallengerAttemptRecord & {
  quoteOutcome: ChallengerQuoteOutcome | null;
};

export type ChallengerReportInputs = {
  experimentId: string;
  asOf: string;
  attempts: readonly ChallengerReportRow[];
  unknownCapture?: number;
  verifiedSessions?: number | null;
  incompleteSessions?: number | null;
  unknownSessions?: number | null;
  coveredNoOpportunitySessions?: number | null;
  excludedPausedSessions?: number | null;
  sessionCountsAvailable?: boolean;
  sessionCountsUnavailableReason?: string | null;
  frozenAcceptance?: ChallengerAcceptanceRecords | null;
  comparison?: SessionComparisonResult | null;
  comparisonUnavailableReason?:
    | "PAIRED_INPUTS_MISSING"
    | "INSUFFICIENT_SESSIONS"
    | "COVERAGE_UNVERIFIED"
    | "EXPERIMENT_REVOKED"
    | null;
  revoked?: boolean;
};

export function labelVisibleAt(
  label: { labelAvailableAt: string | null; exitAt?: string | null },
  asOf: string,
): boolean {
  const available = Date.parse(label.labelAvailableAt ?? "");
  const boundary = Date.parse(asOf);
  if (!Number.isFinite(available) || !Number.isFinite(boundary)) return false;
  if (label.exitAt !== undefined && label.exitAt !== null) {
    const exit = Date.parse(label.exitAt);
    if (!Number.isFinite(exit) || exit > available) return false;
  }
  return available <= boundary;
}

export function buildChallengerObservationReport(
  inputs: ChallengerReportInputs,
): ChallengerObservationReport {
  const asOf = Date.parse(inputs.asOf);
  if (!Number.isFinite(asOf)) throw new Error("INVALID_REPORT_AS_OF");
  const visible = inputs.attempts.filter(
    (row) => Date.parse(row.observedAt) <= asOf,
  );
  let predicted = 0;
  let pending = 0;
  let missedDeadline = 0;
  let engineFailed = 0;
  let inputInvalid = 0;
  let revoked = 0;
  let closedQuoteOutcomes = 0;
  const brier: number[] = [];
  for (const row of visible) {
    const outcome = outcomeAtAsOf(row.outcome, asOf);
    if (
      row.quoteOutcome?.status === "CLOSED" &&
      labelVisibleAt(row.quoteOutcome, inputs.asOf)
    ) {
      closedQuoteOutcomes += 1;
    }
    if (!outcome) {
      pending += 1;
      continue;
    }
    switch (outcome.status) {
      case "PREDICTED":
        predicted += 1;
        if (
          row.quoteOutcome?.status === "CLOSED" &&
          row.quoteOutcome.rMultiple !== null &&
          labelVisibleAt(row.quoteOutcome, inputs.asOf)
        ) {
          brier.push(
            (outcome.prediction.setupProbability -
              (row.quoteOutcome.rMultiple > 0 ? 1 : 0)) **
              2,
          );
        }
        break;
      case "MISSED_DEADLINE":
        missedDeadline += 1;
        break;
      case "ENGINE_FAILED":
        engineFailed += 1;
        break;
      case "INPUT_INVALID":
        inputInvalid += 1;
        break;
      case "EXPERIMENT_REVOKED":
        revoked += 1;
        break;
    }
  }
  const unknownCapture = inputs.unknownCapture ?? 0;
  const comparison = inputs.revoked ? null : (inputs.comparison ?? null);
  const comparisonUnavailableReason = comparison
    ? null
    : inputs.revoked
      ? "EXPERIMENT_REVOKED"
      : (inputs.comparisonUnavailableReason ?? "PAIRED_INPUTS_MISSING");
  const report = {
    experimentId: inputs.experimentId,
    asOf: inputs.asOf,
    population: {
      expectedEligibleObservations: visible.length + unknownCapture,
      predicted,
      pending,
      missedDeadline,
      engineFailed,
      inputInvalid,
      revoked,
      unknownCapture,
    },
    verifiedSessions:
      inputs.sessionCountsAvailable === false
        ? null
        : (inputs.verifiedSessions ?? 0),
    incompleteSessions:
      inputs.sessionCountsAvailable === false
        ? null
        : (inputs.incompleteSessions ?? 0),
    unknownSessions:
      inputs.sessionCountsAvailable === false
        ? null
        : (inputs.unknownSessions ?? 0),
    coveredNoOpportunitySessions:
      inputs.sessionCountsAvailable === false
        ? null
        : (inputs.coveredNoOpportunitySessions ?? 0),
    excludedPausedSessions:
      inputs.sessionCountsAvailable === false
        ? null
        : (inputs.excludedPausedSessions ?? 0),
    sessionCountsAvailable: inputs.sessionCountsAvailable ?? true,
    sessionCountsUnavailableReason:
      inputs.sessionCountsUnavailableReason ?? null,
    frozenAcceptance: inputs.frozenAcceptance ?? null,
    closedQuoteOutcomes,
    prospectiveBrierScore:
      brier.length > 0
        ? brier.reduce((sum, value) => sum + value, 0) / brier.length
        : null,
    comparison,
    comparisonUnavailableReason,
    promotionAuthorized: false as const,
  };
  return challengerObservationReportSchema.parse(report);
}

export interface ChallengerReportingApi {
  list(marketId: MarketId, limit?: number): Promise<ChallengerExperiment[]>;
  get(id: string): Promise<ChallengerExperiment | null>;
  report(id: string, asOf?: string): Promise<ChallengerObservationReport>;
}

export class PostgresChallengerReportingService implements ChallengerReportingApi {
  constructor(
    private readonly experiments: PostgresChallengerExperimentStore,
    private readonly pool: Pool,
    private readonly now: () => Date = () => new Date(),
  ) {}

  list(marketId: MarketId, limit?: number): Promise<ChallengerExperiment[]> {
    return this.experiments.list(marketId, limit);
  }

  get(id: string): Promise<ChallengerExperiment | null> {
    return this.experiments.get(id);
  }

  async report(
    id: string,
    asOf = this.now().toISOString(),
  ): Promise<ChallengerObservationReport> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const report = await this.reportWithClient(id, asOf, client);
      await client.query("COMMIT");
      return report;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async reportWithClient(
    id: string,
    asOf: string,
    client: PoolClient,
  ): Promise<ChallengerObservationReport> {
    const experiment = await this.experiments.get(id);
    if (!experiment) throw new Error("EXPERIMENT_NOT_FOUND");
    const rows = await client.query<{
      experiment_id: string;
      observation_id: string;
      model_version: string;
      input_hash: string;
      observed_at: Date;
      recorded_at: Date;
      deadline_at: Date;
      input_snapshot: unknown;
      outcome: unknown | null;
      quote_status: ChallengerQuoteOutcome["status"] | null;
      r_multiple: string | number | null;
      exit_at: Date | null;
      label_available_at: Date | null;
    }>(
      `SELECT a.experiment_id,a.observation_id,a.model_version,a.input_hash,
              a.observed_at,a.recorded_at,a.deadline_at,a.input_snapshot,
              CASE WHEN o.completed_at <= $2::timestamptz THEN o.outcome ELSE NULL END AS outcome,
              le.label->>'status' AS quote_status,le.label->>'rMultiple' AS r_multiple,le.exit_at,
              le.label_available_at
         FROM challenger_attempt a
         LEFT JOIN challenger_outcome o
           ON o.experiment_id=a.experiment_id AND o.observation_id=a.observation_id
        LEFT JOIN challenger_label_evidence le ON le.observation_id=a.observation_id AND le.model='QUOTE'
          AND le.label_available_at<=$2::timestamptz AND le.exit_at<=$2::timestamptz
        WHERE a.experiment_id=$1
          AND a.recorded_at <= $2::timestamptz
        ORDER BY a.observed_at,a.observation_id`,
      [id, asOf],
    );
    const reportRows: ChallengerReportRow[] = rows.rows.map((row) => ({
      experimentId: row.experiment_id,
      observationId: row.observation_id,
      modelVersion: row.model_version,
      inputHash: row.input_hash,
      observedAt: row.observed_at.toISOString(),
      recordedAt: row.recorded_at.toISOString(),
      deadlineAt: row.deadline_at.toISOString(),
      input: row.input_snapshot as ChallengerAttemptRecord["input"],
      outcome: row.outcome ? challengerOutcomeSchema.parse(row.outcome) : null,
      quoteOutcome: row.quote_status
        ? {
            status: row.quote_status,
            rMultiple: row.r_multiple === null ? null : Number(row.r_multiple),
            labelAvailableAt: row.label_available_at?.toISOString() ?? null,
            exitAt: row.exit_at?.toISOString() ?? null,
          }
        : null,
    }));
    const unknownCapture = await this.unknownCapture(
      id,
      experiment,
      asOf,
      client,
    );
    const sessionCoverage = await this.sessionCoverage(
      experiment,
      asOf,
      reportRows,
      unknownCapture.sessionDates,
      client,
    );
    const historicalState = await client.query<{ state: string }>(
      `SELECT state FROM challenger_experiment_transition
        WHERE experiment_id=$1 AND effective_at <= $2::timestamptz
        ORDER BY sequence DESC LIMIT 1`,
      [id, asOf],
    );
    const state = (historicalState.rows[0]?.state ??
      "REGISTERED") as ChallengerExperiment["state"];
    const frozenAcceptance = await new PostgresChallengerAcceptanceRepository(
      client,
    ).get(
      experiment.baselineIdentityHash,
      experiment.acceptancePlanHash,
      experiment.scope.marketId,
    );
    return buildChallengerObservationReport({
      experimentId: id,
      asOf,
      attempts: reportRows,
      unknownCapture: unknownCapture.count,
      ...sessionCoverage,
      frozenAcceptance,
      comparisonUnavailableReason:
        state === "REVOKED" ? "EXPERIMENT_REVOKED" : "COVERAGE_UNVERIFIED",
      revoked: state === "REVOKED",
    });
  }

  private async unknownCapture(
    id: string,
    experiment: ChallengerExperiment,
    asOf: string,
    client: PoolClient,
  ): Promise<{ count: number; sessionDates: Set<string> }> {
    const result = await client.query<{
      session_date: string;
      count: string;
    }>(
      `WITH active_boundaries AS (${challengerActiveBoundaries})
       SELECT (o.signal_timestamp AT TIME ZONE r.session_timezone)::date::text AS session_date,count(*)::text AS count
         FROM paper_signal_observation o
         JOIN paper_bot_run r ON r.id=o.run_id
         JOIN challenger_experiment e ON e.id=$1
         JOIN active_boundaries t ON t.experiment_id=$1
         JOIN challenger_baseline_record b ON b.identity_hash=e.baseline_identity_hash
        WHERE ${challengerPopulationPredicate}
          AND t.active_from <= $3::timestamptz AND r.market_id=$2
          AND (o.captured_at IS NULL OR o.captured_at <= $3::timestamptz)
          AND o.signal_timestamp <= $3::timestamptz
          AND o.signal_timestamp >= GREATEST($4::timestamptz,t.active_from)
          AND o.signal_timestamp < $5::timestamptz
          AND (t.active_to IS NULL OR o.signal_timestamp < LEAST(t.active_to,$5::timestamptz))
          AND NOT EXISTS (
            SELECT 1 FROM challenger_attempt a
             WHERE a.experiment_id=$1 AND a.observation_id=o.id AND a.recorded_at<=$3::timestamptz
          )
        GROUP BY (o.signal_timestamp AT TIME ZONE r.session_timezone)::date`,
      [
        id,
        experiment.scope.marketId,
        asOf,
        experiment.startsAt,
        experiment.endsAt,
      ],
    );
    return {
      count: result.rows.reduce((sum, row) => sum + Number(row.count), 0),
      sessionDates: new Set(result.rows.map((row) => row.session_date)),
    };
  }

  private async sessionCoverage(
    experiment: ChallengerExperiment,
    asOf: string,
    rows: readonly ChallengerReportRow[],
    unknownCaptureDates: Set<string>,
    client: PoolClient,
  ): Promise<
    ReturnType<typeof deriveChallengerSessionCoverage> & {
      sessionCountsAvailable?: boolean;
      sessionCountsUnavailableReason?: string | null;
    }
  > {
    const acceptance = await client.query<{ record: unknown }>(
      `SELECT record FROM challenger_acceptance_plan
        WHERE identity_hash=$1 AND market_id=$2`,
      [experiment.acceptancePlanHash, experiment.scope.marketId],
    );
    const plan = acceptance.rows[0]
      ? challengerAcceptancePlanSchema.safeParse(acceptance.rows[0].record)
      : null;
    if (!plan?.success)
      return {
        ...deriveChallengerSessionCoverage([]),
        sessionCountsAvailable: false,
        sessionCountsUnavailableReason: "ACCEPTANCE_CALENDAR_UNAVAILABLE",
      };

    // A model's training report cannot establish prospective observation
    // coverage. Only independently captured requests for this exact experiment
    // and scope can supply the expected grid and interval boundaries.
    const coverage = await client.query<{
      request: unknown;
      report: unknown;
      recorded_at: Date;
    }>(
      `SELECT q.request,c.report,x.recorded_at FROM research_coverage_request q
       JOIN research_coverage_request_result x ON x.request_id=q.id
       JOIN research_coverage_report c ON c.hash=x.report_hash
       WHERE q.market_id=$1 AND q.request->'manifest'->'manifest'->'purpose'->>'kind'='CHALLENGER'
         AND q.request->'manifest'->'manifest'->'purpose'->>'experimentId'=$2
         AND q.created_at<=$3::timestamptz AND x.recorded_at<=$3::timestamptz AND c.created_at<=$3::timestamptz
       ORDER BY x.recorded_at DESC`,
      [experiment.scope.marketId, experiment.id, asOf],
    );
    const transitions = await client.query<{
      state: ChallengerExperiment["state"];
      effective_at: Date;
    }>(
      `SELECT state,effective_at FROM challenger_experiment_transition WHERE experiment_id=$1 AND effective_at<=$2::timestamptz ORDER BY sequence`,
      [experiment.id, asOf],
    );
    const dates = plan.data.comparison.expectedSessions.filter(
      (date) => date <= asOf.slice(0, 10),
    );
    const cells: Parameters<
      typeof deriveChallengerSessionCoverage
    >[0][number][] = [];
    const calendarDates = new Set<string>();
    const observedDates = new Set(
      researchSessionDates(
        rows.map((row) => row.observedAt),
        experiment.scope.marketId,
      ),
    );
    for (const date of dates) {
      let proved = false;
      for (const receipt of coverage.rows) {
        const request = receipt.request as {
          manifest?: {
            manifest?: {
              purpose?: {
                scope?: unknown;
                expectedInputs?: unknown;
                activeWindows?: unknown;
              };
            };
          };
        };
        const purpose = request.manifest?.manifest?.purpose;
        const scope = challengerScopeSchema.safeParse(purpose?.scope);
        const expected = expectedInputCellSchema
          .array()
          .safeParse(purpose?.expectedInputs);
        const report = researchCoverageReportSchema.safeParse(receipt.report);
        if (
          !scope.success ||
          contentHash(scope.data) !== contentHash(experiment.scope) ||
          !expected.success ||
          !report.success ||
          contentHash(expected.data) !== report.data.expectedInputsHash ||
          Date.parse(report.data.verifiedAt) > Date.parse(asOf)
        )
          continue;
        const required = expected.data.filter(
          (cell) =>
            cell.sessionDate === date &&
            cell.marketId === experiment.scope.marketId &&
            cell.membership === "REQUIRED",
        );
        if (
          !required.length ||
          required.some(
            (cell) => !cell.calendarSourceHash || !cell.membershipSourceHash,
          )
        )
          continue;
        const first = Math.min(
          ...required.map((cell) => Date.parse(cell.windowStart)),
        );
        const last = Math.max(
          ...required.map((cell) => Date.parse(cell.windowEnd)),
        );
        calendarDates.add(date);
        const active = transitions.rows.flatMap((t, index) => {
          const start = Math.max(
            first,
            Date.parse(experiment.startsAt),
            t.effective_at.getTime(),
          );
          const end = Math.min(
            last,
            Date.parse(experiment.endsAt),
            transitions.rows[index + 1]?.effective_at.getTime() ??
              Date.parse(asOf),
          );
          return t.state === "ACTIVE" && start < end
            ? [
                {
                  start: new Date(start).toISOString(),
                  end: new Date(end).toISOString(),
                },
              ]
            : [];
        });
        if (last > Date.parse(asOf)) continue;
        if (!active.length) {
          if (
            transitions.rows.some(
              (transition, index) =>
                transition.state === "PAUSED" &&
                transition.effective_at.getTime() <= first &&
                (transitions.rows[index + 1]?.effective_at.getTime() ??
                  Date.parse(asOf)) >= last,
            )
          ) {
            cells.push({
              sessionDate: date,
              status: "UNKNOWN",
              coveredOpportunity: false,
              fullyPaused: true,
            });
            proved = true;
            break;
          }
          continue;
        }
        const declared = purpose?.activeWindows as
          Record<string, unknown> | undefined;
        if (
          !declared ||
          !declared[date] ||
          contentHash(declared[date]) !== contentHash(active)
        )
          continue;
        // Full windows are required to match the actual active intervals; a
        // full-session report does not prove an arbitrary partial session.
        if (
          required.some(
            (cell) =>
              !active.some(
                (window) =>
                  window.start === cell.windowStart &&
                  window.end === cell.windowEnd,
              ),
          )
        )
          continue;
        const results = required.map((cell) =>
          report.data.cells.find((result) => result.cellId === cell.cellId),
        );
        const unknown =
          unknownCaptureDates.has(date) ||
          results.some((result) => !result || result.status === "UNKNOWN");
        const status = unknown
          ? "UNKNOWN"
          : results.every((result) => result?.status === "VERIFIED")
            ? "VERIFIED"
            : "INCOMPLETE";
        cells.push({
          sessionDate: date,
          status,
          coveredOpportunity: observedDates.has(date),
        });
        proved = true;
        break;
      }
      if (!proved)
        cells.push({
          sessionDate: date,
          status: "UNKNOWN",
          coveredOpportunity: false,
        });
    }
    // Without a retained calendar, even the declared date count is not a
    // verified session denominator. Preserve an explicit unavailable state.
    if (calendarDates.size !== dates.length || !coverage.rows.length)
      return {
        ...deriveChallengerSessionCoverage([]),
        sessionCountsAvailable: false,
        sessionCountsUnavailableReason: "PROSPECTIVE_CALENDAR_UNAVAILABLE",
      };
    return {
      ...deriveChallengerSessionCoverage(cells),
      sessionCountsAvailable: true,
      sessionCountsUnavailableReason: null,
    };
  }
}

export function reportDetail(
  experiment: ChallengerExperiment,
  report: ChallengerObservationReport,
) {
  return challengerExperimentDetailSchema.parse({ experiment, report });
}

export class PostgresChallengerExperimentApiService implements ChallengerExperimentApi {
  constructor(
    private readonly enrollment: ChallengerExperimentService,
    private readonly reporting: ChallengerReportingApi,
  ) {}

  list(marketId: MarketId, limit?: number): Promise<ChallengerExperiment[]> {
    return this.reporting.list(marketId, limit);
  }

  get(id: string): Promise<ChallengerExperiment | null> {
    return this.reporting.get(id);
  }

  report(id: string, asOf?: string): Promise<ChallengerObservationReport> {
    return this.reporting.report(id, asOf);
  }

  register(
    input: Parameters<ChallengerExperimentService["register"]>[0],
    key: string,
  ) {
    return this.enrollment.register(input, key);
  }

  transition(
    id: string,
    action: Parameters<ChallengerExperimentService["transition"]>[1],
    key: string,
  ) {
    return this.enrollment.transition(id, action, key);
  }
}

function outcomeAtAsOf(
  outcome: ChallengerOutcome | null,
  asOf: number,
): ChallengerOutcome | null {
  if (!outcome || Date.parse(outcome.completedAt) > asOf) return null;
  return outcome;
}
