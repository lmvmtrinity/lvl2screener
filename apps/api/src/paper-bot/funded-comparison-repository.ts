import {
  fundedComparisonAvailabilityReceiptSchema,
  fundedComparisonFailureReceiptSchema,
  fundedComparisonInputItemEntrySchema,
  fundedComparisonPolicyEvaluationSchema,
  fundedComparisonResultSchema,
  fundedComparisonRunBindingSchema,
  fundedComparisonSessionMetricSchema,
  fundedComparisonSpecificationSchema,
  type FundedComparisonAvailabilityReceipt,
  type FundedComparisonFailureReason,
  type FundedComparisonFailureReceipt,
  type FundedComparisonInputChunk,
  type FundedComparisonPolicyEvaluation,
  type FundedComparisonResult,
  type FundedComparisonRunBinding,
  type FundedComparisonSessionMetric,
  type FundedComparisonSide,
  type FundedComparisonSourceOpportunity,
  type FundedComparisonSpecification,
} from "@tsx-scanner/contracts";
import type { Pool, PoolClient } from "pg";
import { isDeepStrictEqual } from "node:util";
import {
  fundedComparisonDeltaMetricsOf,
  fundedComparisonOutperformedSessions,
} from "./funded-comparison-metrics.js";
import {
  fundedComparisonEvaluationDigest,
  fundedComparisonEvaluationMembershipDigest,
  fundedComparisonFailureDigest,
  fundedComparisonMetricDigest,
  fundedComparisonMetricsDigest,
  fundedComparisonPairedSessionDigest,
  fundedComparisonResultDigest,
  fundedComparisonSpecDigest,
} from "./funded-comparison-digest.js";

/**
 * Append-only persistence for the FP03 comparison. Nothing here writes to any
 * order, ledger, reservation, decision or challenger table; the comparison owns
 * only its own immutable records and can never mutate funded economics.
 *
 * Completion is derived, never updated: a side/session is complete when its
 * immutable binding, every policy evaluation for its source-opportunity
 * membership and a PROVEN session metric exist, and no terminal failure
 * receipt covers it. This module deliberately exposes no side-state update
 * method.
 */

export class FundedComparisonRepositoryError extends Error {
  constructor(
    readonly reason:
      | "CONFLICTING_RETRY"
      | "RESULT_DIGEST_CONFLICT"
      | "INCOMPLETE_SESSION"
      | "RETAINED_INPUT_MISSING"
      | "INTERNAL_ERROR",
    message: string,
  ) {
    super(message);
    this.name = "FundedComparisonRepositoryError";
  }
}

export interface FundedComparisonSpecificationReceipt {
  readonly specification: FundedComparisonSpecification;
  readonly specId: string;
  readonly sessions: readonly {
    readonly sessionDate: string;
    readonly ordinal: number;
    readonly itemCount: number;
    readonly chunkCount: number;
    readonly sessionInputDigest: string;
    readonly chunks: readonly FundedComparisonInputChunk[];
    readonly opportunities: readonly FundedComparisonSourceOpportunity[];
  }[];
  readonly opportunities: readonly FundedComparisonSourceOpportunity[];
}

export interface FundedComparisonSessionFreeze {
  readonly sessionDate: string;
  readonly sessionStartAt: string;
  readonly scheduledCloseAt: string;
  readonly sessionTimezone: string;
  readonly itemCount: number;
  readonly chunkCount: number;
  readonly sessionInputDigest: string;
  readonly chunks: readonly FundedComparisonInputChunk[];
  readonly opportunities: readonly FundedComparisonSourceOpportunity[];
}

export interface FundedComparisonSpecificationBuild {
  readonly specification: FundedComparisonSpecification;
  readonly sessions: readonly FundedComparisonSessionFreeze[];
}

export interface FundedComparisonProvisioningIntent {
  readonly specId: string;
  readonly side: FundedComparisonSide;
  readonly sessionDate: string;
  readonly accountId: string;
  readonly marketId: "CA_TSX" | "US_EQUITIES";
  readonly currency: "CAD" | "USD";
  readonly policyDigest: string;
  readonly executionModelVersion: string;
  readonly accountAssumptionDigest: string;
  readonly createdAt: string;
}

/**
 * Freeze one specification. The builder receives the database-owned freeze time
 * inside the insert transaction; the digest is recomputed here from the exact
 * payload and a caller-supplied digest is never trusted.
 */
export interface FundedComparisonSpecificationFreeze {
  readonly build: (
    specificationFrozenAt: string,
  ) => FundedComparisonSpecificationBuild;
}

function iso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function numberOrNull(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

interface SpecRow {
  id: string;
  market_id: string;
  currency: string;
  baseline_backtest_run_id: string;
  comparison_spec_digest: string;
  specification: unknown;
  evidence_cutoff_at: Date | string;
  specification_frozen_at: Date | string;
  champion_policy_digest: string;
  challenger_policy_digest: string;
  initial_cash: string | number;
  daily_loss_limit: string | number;
  created_at: Date | string;
}

interface ChunkRow {
  session_date: string | Date;
  chunk_ordinal: number;
  item_count: number;
  payload: unknown;
  chunk_digest: string;
  first_effective_at: Date | string;
  last_effective_at: Date | string;
}

interface OpportunityRow {
  source_opportunity_id: string;
  session_date: string | Date;
  ordinal: number;
  source_event_id: string;
  setup_instance_id: string;
  instrument_id: string;
  profile_config_id: string;
  signal_timestamp: Date | string;
  source_content_digest: string;
}

function dateOnly(value: string | Date): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return value.slice(0, 10);
}

function chunkFromRow(row: ChunkRow): FundedComparisonInputChunk {
  const payload = Array.isArray(row.payload) ? row.payload : [];
  return {
    sessionDate: dateOnly(row.session_date),
    chunkOrdinal: row.chunk_ordinal,
    itemCount: row.item_count,
    firstEffectiveAt: iso(row.first_effective_at),
    lastEffectiveAt: iso(row.last_effective_at),
    chunkDigest: row.chunk_digest,
    items: payload.map((entry) =>
      fundedComparisonInputItemEntrySchema.parse(entry),
    ),
  };
}

function opportunityFromRow(
  row: OpportunityRow,
): FundedComparisonSourceOpportunity {
  return {
    sourceOpportunityId: row.source_opportunity_id,
    sessionDate: dateOnly(row.session_date),
    sourceOrdinal: row.ordinal,
    sourceEventId: row.source_event_id,
    setupInstanceId: row.setup_instance_id,
    instrumentId: row.instrument_id,
    profileConfigId: row.profile_config_id,
    signalTimestamp: iso(row.signal_timestamp),
    sourceContentDigest: row.source_content_digest,
  };
}

/**
 * An exact specification retry must reproduce the stored sessions, frozen
 * chunks and source opportunities exactly; a differing chunk boundary, item
 * payload or opportunity identity is a conflicting retry, never a silent reuse.
 */
function assertSpecificationRetryMatches(
  existing: FundedComparisonSpecificationReceipt,
  specification: FundedComparisonSpecification,
  built: FundedComparisonSpecificationBuild,
): void {
  if (
    existing.specification.comparisonSpecDigest !==
    specification.comparisonSpecDigest
  )
    throw new FundedComparisonRepositoryError(
      "CONFLICTING_RETRY",
      "A different comparison specification already owns this frozen identity",
    );
  if (
    !isDeepStrictEqual(existing.specification, specification) ||
    existing.sessions.length !== built.sessions.length
  )
    throw new FundedComparisonRepositoryError(
      "CONFLICTING_RETRY",
      "The retained comparison specification does not match the rebuilt payload",
    );
  for (const [index, session] of built.sessions.entries()) {
    const stored = existing.sessions[index]!;
    if (
      stored.sessionDate !== session.sessionDate ||
      stored.ordinal !== index + 1 ||
      stored.itemCount !== session.itemCount ||
      stored.chunkCount !== session.chunkCount ||
      stored.sessionInputDigest !== session.sessionInputDigest ||
      stored.chunks.length !== session.chunks.length ||
      stored.opportunities.length !== session.opportunities.length
    )
      throw new FundedComparisonRepositoryError(
        "CONFLICTING_RETRY",
        `Retained session ${session.sessionDate} does not match the rebuilt session`,
      );
    for (const [chunkIndex, chunk] of session.chunks.entries()) {
      const storedChunk = stored.chunks[chunkIndex]!;
      if (
        storedChunk.sessionDate !== chunk.sessionDate ||
        storedChunk.chunkOrdinal !== chunk.chunkOrdinal ||
        storedChunk.itemCount !== chunk.itemCount ||
        storedChunk.firstEffectiveAt !== chunk.firstEffectiveAt ||
        storedChunk.lastEffectiveAt !== chunk.lastEffectiveAt ||
        storedChunk.chunkDigest !== chunk.chunkDigest ||
        !isDeepStrictEqual(storedChunk.items, chunk.items)
      )
        throw new FundedComparisonRepositoryError(
          "CONFLICTING_RETRY",
          `Retained chunk ${chunk.sessionDate}/${chunk.chunkOrdinal} does not match the rebuilt chunk`,
        );
    }
    for (const [
      opportunityIndex,
      opportunity,
    ] of session.opportunities.entries()) {
      const storedOpportunity = stored.opportunities[opportunityIndex]!;
      if (!isDeepStrictEqual(storedOpportunity, opportunity))
        throw new FundedComparisonRepositoryError(
          "CONFLICTING_RETRY",
          `Retained source opportunity ${opportunity.sourceOpportunityId} does not match the rebuilt identity`,
        );
    }
  }
}

export class FundedComparisonRepository {
  constructor(private readonly pool: Pool) {}

  async saveSpecification(
    freeze: FundedComparisonSpecificationFreeze,
  ): Promise<FundedComparisonSpecificationReceipt> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const frozen = await client.query<{ at: Date | string }>(
        "SELECT clock_timestamp() AS at",
      );
      const frozenAt = iso(frozen.rows[0]!.at);
      const built = freeze.build(frozenAt);
      const specification = fundedComparisonSpecificationSchema.parse(
        built.specification,
      );
      const { comparisonSpecDigest, ...withoutDigest } = specification;
      if (fundedComparisonSpecDigest(withoutDigest) !== comparisonSpecDigest)
        throw new FundedComparisonRepositoryError(
          "INTERNAL_ERROR",
          "Comparison specification digest does not match its payload",
        );
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO funded_comparison_spec (
           market_id,currency,spec_version,baseline_backtest_run_id,
           baseline_config_version,baseline_start_date,baseline_end_date,
           baseline_execution_model_version,baseline_replay_input_digest,
           baseline_result_digest,baseline_completed_at,champion_policy_digest,
           champion_source_run_id,champion_source_account_id,
           champion_execution_model_version,champion_account_assumption_digest,
           challenger_model_id,challenger_model_version,challenger_model_type,
           challenger_artifact_digest,challenger_feature_version,
           challenger_cohort_digest,challenger_policy_digest,initial_cash,
           daily_loss_limit,risk_configuration_digest,evidence_cutoff_at,
           specification_frozen_at,comparison_spec_digest,specification
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
           $19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30::jsonb
         )
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [
          specification.marketId,
          specification.currency,
          specification.specVersion,
          specification.baseline.backtestRunId,
          specification.baseline.configVersion,
          specification.baseline.startDate,
          specification.baseline.endDate,
          specification.baseline.executionModelVersion,
          specification.baseline.replayInputDigest,
          specification.baseline.baselineResultDigest,
          specification.baseline.completedAt,
          specification.champion.policyDigest,
          specification.champion.sourceLiveRunId,
          specification.champion.sourceAccountId,
          specification.champion.executionModelVersion,
          specification.champion.accountAssumptionDigest,
          specification.challenger.model.modelId,
          specification.challenger.model.modelVersion,
          "FUNDED_EXECUTION_QUALITY",
          specification.challenger.model.artifactDigest,
          specification.challenger.model.featureVersion,
          specification.challenger.model.cohortDigest,
          specification.challenger.policyDigest,
          specification.capital.initialCash,
          specification.capital.dailyLossLimit,
          specification.capital.riskConfigurationDigest,
          specification.evidenceCutoffAt,
          specification.specificationFrozenAt,
          comparisonSpecDigest,
          JSON.stringify(specification),
        ],
      );
      if (!inserted.rows[0]) {
        const existing = await this.findSpecificationByFrozenIdentityWithClient(
          client,
          specification,
        );
        if (existing)
          assertSpecificationRetryMatches(existing, specification, built);
        await client.query("COMMIT");
        if (!existing)
          throw new FundedComparisonRepositoryError(
            "CONFLICTING_RETRY",
            "A different comparison specification already owns this frozen identity",
          );
        return existing;
      }
      const specId = inserted.rows[0].id;
      await this.insertSessionMembership(
        client,
        specId,
        specification,
        built.sessions,
      );
      await client.query("COMMIT");
      return {
        specification,
        specId,
        sessions: built.sessions.map((session, index) => ({
          sessionDate: session.sessionDate,
          ordinal: index + 1,
          itemCount: session.itemCount,
          chunkCount: session.chunks.length,
          sessionInputDigest: session.sessionInputDigest,
          chunks: session.chunks,
          opportunities: session.opportunities,
        })),
        opportunities: built.sessions.flatMap(
          (session) => session.opportunities,
        ),
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  private async insertSessionMembership(
    client: PoolClient,
    specId: string,
    specification: FundedComparisonSpecification,
    sessions: readonly FundedComparisonSessionFreeze[],
  ): Promise<void> {
    for (const [index, session] of sessions.entries()) {
      const expectedDigest =
        specification.sessionMembership.orderedSessionDates[index];
      if (expectedDigest !== session.sessionDate)
        throw new FundedComparisonRepositoryError(
          "INTERNAL_ERROR",
          "Session membership does not match the frozen specification",
        );
      if (
        session.chunkCount !== session.chunks.length ||
        session.itemCount !==
          session.chunks.reduce((total, chunk) => total + chunk.itemCount, 0)
      )
        throw new FundedComparisonRepositoryError(
          "INTERNAL_ERROR",
          "Frozen session counts do not match the materialized chunks",
        );
      await client.query(
        `INSERT INTO funded_comparison_spec_session (
           spec_id,session_date,ordinal,session_start_at,scheduled_close_at,
           session_timezone,item_count,chunk_count,session_input_digest
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          specId,
          session.sessionDate,
          index + 1,
          session.sessionStartAt,
          session.scheduledCloseAt,
          session.sessionTimezone,
          session.itemCount,
          session.chunks.length,
          session.sessionInputDigest,
        ],
      );
      for (const opportunity of session.opportunities)
        await client.query(
          `INSERT INTO funded_comparison_spec_opportunity (
             spec_id,source_opportunity_id,session_date,ordinal,source_event_id,
             setup_instance_id,instrument_id,profile_config_id,signal_timestamp,
             source_content_digest
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            specId,
            opportunity.sourceOpportunityId,
            opportunity.sessionDate,
            opportunity.sourceOrdinal,
            opportunity.sourceEventId,
            opportunity.setupInstanceId,
            opportunity.instrumentId,
            opportunity.profileConfigId,
            opportunity.signalTimestamp,
            opportunity.sourceContentDigest,
          ],
        );
      for (const chunk of session.chunks)
        await client.query(
          `INSERT INTO funded_comparison_input_chunk (
             spec_id,session_date,chunk_ordinal,item_count,first_effective_at,
             last_effective_at,chunk_digest,payload
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
          [
            specId,
            chunk.sessionDate,
            chunk.chunkOrdinal,
            chunk.itemCount,
            chunk.firstEffectiveAt,
            chunk.lastEffectiveAt,
            chunk.chunkDigest,
            JSON.stringify(chunk.items),
          ],
        );
    }
  }

  private async findSpecificationByFrozenIdentityWithClient(
    client: PoolClient,
    specification: FundedComparisonSpecification,
  ): Promise<FundedComparisonSpecificationReceipt | undefined> {
    const result = await client.query<{ id: string; specification: unknown }>(
      `SELECT id,specification FROM funded_comparison_spec
        WHERE market_id=$1 AND baseline_backtest_run_id=$2
          AND champion_policy_digest=$3 AND challenger_policy_digest=$4
          AND evidence_cutoff_at=$5::timestamptz`,
      [
        specification.marketId,
        specification.baseline.backtestRunId,
        specification.champion.policyDigest,
        specification.challenger.policyDigest,
        specification.evidenceCutoffAt,
      ],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    const stored = fundedComparisonSpecificationSchema.parse(row.specification);
    if (stored.comparisonSpecDigest !== specification.comparisonSpecDigest)
      return undefined;
    const receipt = await this.loadSpecificationWithClient(client, row.id);
    return receipt;
  }

  async loadSpecification(
    specId: string,
  ): Promise<FundedComparisonSpecificationReceipt | undefined> {
    return this.loadSpecificationWithClient(this.pool, specId);
  }

  private async loadSpecificationWithClient(
    client: PoolClient | Pool,
    specId: string,
  ): Promise<FundedComparisonSpecificationReceipt | undefined> {
    const specResult = await client.query<SpecRow>(
      "SELECT * FROM funded_comparison_spec WHERE id=$1",
      [specId],
    );
    const specRow = specResult.rows[0];
    if (!specRow) return undefined;
    const specification = fundedComparisonSpecificationSchema.parse(
      specRow.specification,
    );
    const sessionRows = await client.query<{
      session_date: string | Date;
      ordinal: number;
      item_count: number;
      chunk_count: number;
      session_input_digest: string;
    }>(
      `SELECT session_date,ordinal,item_count,chunk_count,session_input_digest
         FROM funded_comparison_spec_session WHERE spec_id=$1
        ORDER BY ordinal`,
      [specId],
    );
    const chunks = (
      await client.query<ChunkRow>(
        `SELECT session_date,chunk_ordinal,item_count,payload,chunk_digest,
                first_effective_at,last_effective_at
           FROM funded_comparison_input_chunk WHERE spec_id=$1
          ORDER BY session_date,chunk_ordinal`,
        [specId],
      )
    ).rows.map(chunkFromRow);
    const opportunities = (
      await client.query<OpportunityRow>(
        `SELECT source_opportunity_id,session_date,ordinal,source_event_id,
                setup_instance_id,instrument_id,profile_config_id,
                signal_timestamp,source_content_digest
           FROM funded_comparison_spec_opportunity WHERE spec_id=$1
          ORDER BY session_date,ordinal`,
        [specId],
      )
    ).rows.map(opportunityFromRow);
    return {
      specification,
      specId,
      sessions: sessionRows.rows.map((row) => ({
        sessionDate: dateOnly(row.session_date),
        ordinal: row.ordinal,
        itemCount: row.item_count,
        chunkCount: row.chunk_count,
        sessionInputDigest: row.session_input_digest,
        chunks: chunks.filter(
          (chunk) => chunk.sessionDate === dateOnly(row.session_date),
        ),
        opportunities: opportunities.filter(
          (opportunity) =>
            opportunity.sessionDate === dateOnly(row.session_date),
        ),
      })),
      opportunities,
    };
  }

  /** Full ordered chunk payloads for one frozen session (replay reads only these). */
  async loadSessionChunks(
    specId: string,
    sessionDate: string,
  ): Promise<readonly FundedComparisonInputChunk[]> {
    const rows = await this.pool.query<ChunkRow>(
      `SELECT session_date,chunk_ordinal,item_count,payload,chunk_digest,
              first_effective_at,last_effective_at
         FROM funded_comparison_input_chunk
        WHERE spec_id=$1 AND session_date=$2::date
        ORDER BY chunk_ordinal`,
      [specId, sessionDate],
    );
    return rows.rows.map(chunkFromRow);
  }

  async findSpecificationIdByFrozenIdentity(input: {
    marketId: string;
    baselineBacktestRunId: string;
    championPolicyDigest: string;
    challengerPolicyDigest: string;
    evidenceCutoffAt: string;
  }): Promise<string | undefined> {
    const result = await this.pool.query<{ id: string }>(
      `SELECT id FROM funded_comparison_spec
        WHERE market_id=$1 AND baseline_backtest_run_id=$2
          AND champion_policy_digest=$3 AND challenger_policy_digest=$4
          AND evidence_cutoff_at=$5::timestamptz`,
      [
        input.marketId,
        input.baselineBacktestRunId,
        input.championPolicyDigest,
        input.challengerPolicyDigest,
        input.evidenceCutoffAt,
      ],
    );
    return result.rows[0]?.id;
  }

  async listSpecifications(
    marketId: "CA_TSX" | "US_EQUITIES",
    limit = 50,
  ): Promise<readonly FundedComparisonAvailabilityReceipt[]> {
    const rows = await this.pool.query<{ id: string }>(
      `SELECT id FROM funded_comparison_spec
        WHERE market_id=$1
        ORDER BY specification_frozen_at DESC,id
        LIMIT $2`,
      [marketId, limit],
    );
    const receipts: FundedComparisonAvailabilityReceipt[] = [];
    for (const row of rows.rows) {
      const receipt = await this.loadAvailability(row.id);
      if (receipt) receipts.push(receipt);
    }
    return receipts;
  }

  /**
   * Insert the immutable per-side/session binding. `bound_at` is always the
   * database clock; an exact retry must reproduce every immutable identity
   * field or it fails visibly as a conflicting retry.
   */
  async bindSessionSide(
    specId: string,
    side: FundedComparisonSide,
    sessionDate: string,
    binding: Omit<
      FundedComparisonRunBinding,
      "specId" | "side" | "sessionDate"
    >,
  ): Promise<FundedComparisonRunBinding> {
    const parsed = fundedComparisonRunBindingSchema.parse({
      specId,
      side,
      sessionDate,
      ...binding,
    });
    const inserted = await this.pool.query<{ bound_at: Date | string }>(
      `INSERT INTO funded_comparison_run_binding (
         spec_id,side,session_date,run_id,account_id,market_id,currency,
         policy_digest,execution_model_version,account_assumption_digest,bound_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,clock_timestamp())
       ON CONFLICT DO NOTHING
       RETURNING bound_at`,
      [
        parsed.specId,
        parsed.side,
        parsed.sessionDate,
        parsed.runId,
        parsed.accountId,
        parsed.marketId,
        parsed.currency,
        parsed.policyDigest,
        parsed.executionModelVersion,
        parsed.accountAssumptionDigest,
      ],
    );
    if (inserted.rows[0])
      return {
        ...parsed,
        boundAt: iso(inserted.rows[0].bound_at),
      };
    const existing = await this.findBinding(specId, side, sessionDate);
    if (!existing)
      throw new FundedComparisonRepositoryError(
        "CONFLICTING_RETRY",
        "Run binding conflicts with an existing row",
      );
    if (
      existing.runId !== parsed.runId ||
      existing.accountId !== parsed.accountId ||
      existing.marketId !== parsed.marketId ||
      existing.currency !== parsed.currency ||
      existing.policyDigest !== parsed.policyDigest ||
      existing.executionModelVersion !== parsed.executionModelVersion ||
      existing.accountAssumptionDigest !== parsed.accountAssumptionDigest
    )
      throw new FundedComparisonRepositoryError(
        "CONFLICTING_RETRY",
        `Run binding for ${side} ${sessionDate} conflicts with the stored identity`,
      );
    return existing;
  }

  async saveProvisioningIntent(
    intent: Omit<FundedComparisonProvisioningIntent, "createdAt">,
  ): Promise<FundedComparisonProvisioningIntent> {
    const values = [
      intent.specId,
      intent.side,
      intent.sessionDate,
      intent.accountId,
      intent.marketId,
      intent.currency,
      intent.policyDigest,
      intent.executionModelVersion,
      intent.accountAssumptionDigest,
    ];
    const inserted = await this.pool.query<{ created_at: Date | string }>(
      `INSERT INTO funded_comparison_provisioning_intent (
         spec_id,side,session_date,account_id,market_id,currency,policy_digest,
         execution_model_version,account_assumption_digest
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT DO NOTHING RETURNING created_at`,
      values,
    );
    if (inserted.rows[0])
      return { ...intent, createdAt: iso(inserted.rows[0].created_at) };
    const existing = await this.findProvisioningIntent(
      intent.specId,
      intent.side,
      intent.sessionDate,
    );
    if (
      !existing ||
      existing.accountId !== intent.accountId ||
      existing.marketId !== intent.marketId ||
      existing.currency !== intent.currency ||
      existing.policyDigest !== intent.policyDigest ||
      existing.executionModelVersion !== intent.executionModelVersion ||
      existing.accountAssumptionDigest !== intent.accountAssumptionDigest
    )
      throw new FundedComparisonRepositoryError(
        "CONFLICTING_RETRY",
        `Provisioning intent for ${intent.side} ${intent.sessionDate} conflicts with the stored identity`,
      );
    return existing;
  }

  async findProvisioningIntent(
    specId: string,
    side: FundedComparisonSide,
    sessionDate: string,
  ): Promise<FundedComparisonProvisioningIntent | undefined> {
    const result = await this.pool.query<{
      account_id: string;
      market_id: "CA_TSX" | "US_EQUITIES";
      currency: "CAD" | "USD";
      policy_digest: string;
      execution_model_version: string;
      account_assumption_digest: string;
      created_at: Date | string;
    }>(
      `SELECT * FROM funded_comparison_provisioning_intent
        WHERE spec_id=$1 AND side=$2 AND session_date=$3::date`,
      [specId, side, sessionDate],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      specId,
      side,
      sessionDate,
      accountId: row.account_id,
      marketId: row.market_id,
      currency: row.currency,
      policyDigest: row.policy_digest,
      executionModelVersion: row.execution_model_version,
      accountAssumptionDigest: row.account_assumption_digest,
      createdAt: iso(row.created_at),
    };
  }

  async findBinding(
    specId: string,
    side: FundedComparisonSide,
    sessionDate: string,
  ): Promise<FundedComparisonRunBinding | undefined> {
    const result = await this.pool.query<{
      spec_id: string;
      side: FundedComparisonSide;
      session_date: string | Date;
      run_id: string;
      account_id: string;
      market_id: "CA_TSX" | "US_EQUITIES";
      currency: "CAD" | "USD";
      policy_digest: string;
      execution_model_version: string;
      account_assumption_digest: string;
      bound_at: Date | string;
    }>(
      `SELECT * FROM funded_comparison_run_binding
        WHERE spec_id=$1 AND side=$2 AND session_date=$3::date`,
      [specId, side, sessionDate],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return fundedComparisonRunBindingSchema.parse({
      specId: row.spec_id,
      side: row.side,
      sessionDate: dateOnly(row.session_date),
      runId: row.run_id,
      accountId: row.account_id,
      marketId: row.market_id,
      currency: row.currency,
      policyDigest: row.policy_digest,
      executionModelVersion: row.execution_model_version,
      accountAssumptionDigest: row.account_assumption_digest,
      boundAt: iso(row.bound_at),
    });
  }

  async listBindings(
    specId: string,
  ): Promise<readonly FundedComparisonRunBinding[]> {
    const result = await this.pool.query<{
      spec_id: string;
      side: FundedComparisonSide;
      session_date: string | Date;
      run_id: string;
      account_id: string;
      market_id: "CA_TSX" | "US_EQUITIES";
      currency: "CAD" | "USD";
      policy_digest: string;
      execution_model_version: string;
      account_assumption_digest: string;
      bound_at: Date | string;
    }>(
      `SELECT * FROM funded_comparison_run_binding
        WHERE spec_id=$1
        ORDER BY session_date,side`,
      [specId],
    );
    return result.rows.map((row) =>
      fundedComparisonRunBindingSchema.parse({
        specId: row.spec_id,
        side: row.side,
        sessionDate: dateOnly(row.session_date),
        runId: row.run_id,
        accountId: row.account_id,
        marketId: row.market_id,
        currency: row.currency,
        policyDigest: row.policy_digest,
        executionModelVersion: row.execution_model_version,
        accountAssumptionDigest: row.account_assumption_digest,
        boundAt: iso(row.bound_at),
      }),
    );
  }

  /**
   * Append one side's complete per-session mapping atomically. The exact
   * ordered source-opportunity slice of the frozen specification membership is
   * required: a partial set, an extra identity or a changed ordinal fails
   * visibly and nothing is written.
   */
  async appendPolicyEvaluations(
    specId: string,
    side: FundedComparisonSide,
    sessionDate: string,
    evaluations: readonly FundedComparisonPolicyEvaluation[],
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const slice = await client.query<{
        source_opportunity_id: string;
        ordinal: number;
      }>(
        `SELECT source_opportunity_id,ordinal
           FROM funded_comparison_spec_opportunity
          WHERE spec_id=$1 AND session_date=$2::date
          ORDER BY ordinal`,
        [specId, sessionDate],
      );
      const session = await client.query(
        `SELECT 1 FROM funded_comparison_spec_session
          WHERE spec_id=$1 AND session_date=$2::date`,
        [specId, sessionDate],
      );
      if (
        session.rowCount !== 1 ||
        evaluations.length !== slice.rows.length ||
        evaluations.some(
          (evaluation, index) =>
            evaluation.sourceOpportunityId !==
              slice.rows[index]!.source_opportunity_id ||
            evaluation.sourceOrdinal !== slice.rows[index]!.ordinal,
        )
      )
        throw new FundedComparisonRepositoryError(
          "INCOMPLETE_SESSION",
          `Policy evaluations for ${side} ${sessionDate} must cover the exact frozen source-opportunity slice`,
        );
      for (const raw of evaluations) {
        const evaluation = fundedComparisonPolicyEvaluationSchema.parse(raw);
        if (
          evaluation.specId !== specId ||
          evaluation.side !== side ||
          evaluation.sessionDate !== sessionDate
        )
          throw new FundedComparisonRepositoryError(
            "INTERNAL_ERROR",
            "Policy evaluation ownership does not match its append coordinate",
          );
        const { evaluationDigest, ...withoutDigest } = evaluation;
        if (
          fundedComparisonEvaluationDigest(withoutDigest) !== evaluationDigest
        )
          throw new FundedComparisonRepositoryError(
            "INTERNAL_ERROR",
            "Policy evaluation digest does not match its payload",
          );
        const inserted = await client.query(
          `INSERT INTO funded_comparison_policy_evaluation (
             spec_id,side,session_date,source_opportunity_id,source_ordinal,
             signal_timestamp,batch_key,champion_rank,applied_rank,
             destination_run_id,destination_observation_id,disposition,
             fallback_reason,prediction,evaluation_digest
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15)
           ON CONFLICT DO NOTHING`,
          [
            evaluation.specId,
            evaluation.side,
            evaluation.sessionDate,
            evaluation.sourceOpportunityId,
            evaluation.sourceOrdinal,
            evaluation.signalTimestamp,
            evaluation.batchKey,
            evaluation.championRank,
            evaluation.appliedRank,
            evaluation.destinationRunId,
            evaluation.destinationObservationId,
            evaluation.disposition,
            evaluation.fallbackReason,
            evaluation.prediction === null
              ? null
              : JSON.stringify(evaluation.prediction),
            evaluation.evaluationDigest,
          ],
        );
        if (inserted.rowCount === 0) {
          const existing = await this.findPolicyEvaluationWithClient(
            client,
            specId,
            side,
            sessionDate,
            evaluation.sourceOpportunityId,
          );
          if (
            !existing ||
            existing.evaluationDigest !== evaluation.evaluationDigest
          )
            throw new FundedComparisonRepositoryError(
              "CONFLICTING_RETRY",
              `Policy evaluation for ${evaluation.sourceOpportunityId} conflicts with the stored row`,
            );
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  private async findPolicyEvaluationWithClient(
    client: PoolClient | Pool,
    specId: string,
    side: FundedComparisonSide,
    sessionDate: string,
    sourceOpportunityId: string,
  ): Promise<FundedComparisonPolicyEvaluation | undefined> {
    const result = await client.query<{
      source_ordinal: number;
      signal_timestamp: Date | string;
      batch_key: string;
      champion_rank: number;
      applied_rank: number;
      destination_run_id: string;
      destination_observation_id: string;
      disposition: "CHAMPION_ORDER" | "PREDICTED" | "FALLBACK_CHAMPION_ORDER";
      fallback_reason: string | null;
      prediction: unknown;
      evaluation_digest: string;
    }>(
      `SELECT * FROM funded_comparison_policy_evaluation
        WHERE spec_id=$1 AND side=$2 AND session_date=$3::date
          AND source_opportunity_id=$4`,
      [specId, side, sessionDate, sourceOpportunityId],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return fundedComparisonPolicyEvaluationSchema.parse({
      specId,
      side,
      sessionDate,
      sourceOpportunityId,
      sourceOrdinal: row.source_ordinal,
      signalTimestamp: iso(row.signal_timestamp),
      batchKey: row.batch_key,
      championRank: row.champion_rank,
      appliedRank: row.applied_rank,
      destinationRunId: row.destination_run_id,
      destinationObservationId: row.destination_observation_id,
      disposition: row.disposition,
      fallbackReason: row.fallback_reason,
      prediction: row.prediction ?? null,
      evaluationDigest: row.evaluation_digest,
    });
  }

  async listPolicyEvaluations(
    specId: string,
    side: FundedComparisonSide,
    sessionDate?: string,
  ): Promise<readonly FundedComparisonPolicyEvaluation[]> {
    const result = await this.pool.query<{
      session_date: string | Date;
      source_opportunity_id: string;
    }>(
      `SELECT session_date,source_opportunity_id
         FROM funded_comparison_policy_evaluation
        WHERE spec_id=$1 AND side=$2
          AND ($3::date IS NULL OR session_date=$3::date)
        ORDER BY session_date,source_ordinal,source_opportunity_id`,
      [specId, side, sessionDate ?? null],
    );
    const evaluations: FundedComparisonPolicyEvaluation[] = [];
    for (const row of result.rows) {
      const evaluation = await this.findPolicyEvaluationWithClient(
        this.pool,
        specId,
        side,
        dateOnly(row.session_date),
        row.source_opportunity_id,
      );
      if (evaluation) evaluations.push(evaluation);
    }
    return evaluations;
  }

  async appendSessionMetric(
    specId: string,
    side: FundedComparisonSide,
    metric: FundedComparisonSessionMetric,
  ): Promise<void> {
    const parsed = fundedComparisonSessionMetricSchema.parse(metric);
    if (parsed.specId !== specId || parsed.side !== side)
      throw new FundedComparisonRepositoryError(
        "INTERNAL_ERROR",
        "Session metric ownership does not match its append coordinate",
      );
    const { metricDigest, ...withoutDigest } = parsed;
    if (fundedComparisonMetricDigest(withoutDigest) !== metricDigest)
      throw new FundedComparisonRepositoryError(
        "INTERNAL_ERROR",
        "Session metric digest does not match its payload",
      );
    const inserted = await this.pool.query(
      `INSERT INTO funded_comparison_session_metric (
         spec_id,side,session_date,market_id,currency,valuation,
         valuation_reason,net_return,max_drawdown,trade_count,
         unrealized_position_count,unresolved_order_count,
         unresolved_reservation_count,stale_mark_count,valuation_point_count,
         metric_digest
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT DO NOTHING`,
      [
        parsed.specId,
        parsed.side,
        parsed.sessionDate,
        parsed.marketId,
        parsed.currency,
        parsed.valuation,
        parsed.valuationReason,
        parsed.netReturn,
        parsed.maxDrawdown,
        parsed.tradeCount,
        parsed.unrealizedPositionCount,
        parsed.unresolvedOrderCount,
        parsed.unresolvedReservationCount,
        parsed.staleMarkCount,
        parsed.valuationPointCount,
        parsed.metricDigest,
      ],
    );
    if (inserted.rowCount === 0) {
      const existing = await this.findSessionMetric(
        specId,
        side,
        parsed.sessionDate,
      );
      if (!existing || existing.metricDigest !== parsed.metricDigest)
        throw new FundedComparisonRepositoryError(
          "CONFLICTING_RETRY",
          "Session metric conflicts with the stored row",
        );
    }
  }

  async findSessionMetric(
    specId: string,
    side: FundedComparisonSide,
    sessionDate: string,
  ): Promise<FundedComparisonSessionMetric | undefined> {
    const result = await this.pool.query<{
      market_id: "CA_TSX" | "US_EQUITIES";
      currency: "CAD" | "USD";
      valuation: "UNION_GRID_MTM" | "UNAVAILABLE";
      valuation_reason: FundedComparisonFailureReason | null;
      net_return: string | number | null;
      max_drawdown: string | number | null;
      trade_count: number;
      unrealized_position_count: number;
      unresolved_order_count: number;
      unresolved_reservation_count: number;
      stale_mark_count: number;
      valuation_point_count: number;
      metric_digest: string;
    }>(
      `SELECT * FROM funded_comparison_session_metric
        WHERE spec_id=$1 AND side=$2 AND session_date=$3::date`,
      [specId, side, sessionDate],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return fundedComparisonSessionMetricSchema.parse({
      specId,
      side,
      sessionDate,
      marketId: row.market_id,
      currency: row.currency,
      valuation: row.valuation,
      valuationReason: row.valuation_reason,
      netReturn: numberOrNull(row.net_return),
      maxDrawdown: numberOrNull(row.max_drawdown),
      tradeCount: row.trade_count,
      unrealizedPositionCount: row.unrealized_position_count,
      unresolvedOrderCount: row.unresolved_order_count,
      unresolvedReservationCount: row.unresolved_reservation_count,
      staleMarkCount: row.stale_mark_count,
      valuationPointCount: row.valuation_point_count,
      metricDigest: row.metric_digest,
    });
  }

  async listSessionMetrics(
    specId: string,
    side?: FundedComparisonSide,
  ): Promise<readonly FundedComparisonSessionMetric[]> {
    const result = await this.pool.query<{ session_date: string | Date }>(
      `SELECT session_date FROM funded_comparison_session_metric
        WHERE spec_id=$1 AND ($2::text IS NULL OR side=$2)
        ORDER BY session_date`,
      [specId, side ?? null],
    );
    const metrics: FundedComparisonSessionMetric[] = [];
    for (const row of result.rows) {
      for (const resolved of side
        ? [side]
        : (["CHAMPION", "CHALLENGER"] as const)) {
        const metric = await this.findSessionMetric(
          specId,
          resolved,
          dateOnly(row.session_date),
        );
        if (metric) metrics.push(metric);
      }
    }
    return metrics;
  }

  /**
   * Append one immutable failure/interruption receipt. The recording time is
   * always the database clock; a caller-supplied time is never authoritative.
   */
  async appendFailure(
    receipt: FundedComparisonFailureReceipt,
  ): Promise<FundedComparisonFailureReceipt> {
    const parsed = fundedComparisonFailureReceiptSchema.parse(receipt);
    const expected = fundedComparisonFailureDigest({
      specId: parsed.specId,
      attemptId: parsed.attemptId,
      side: parsed.side,
      sessionDate: parsed.sessionDate,
      reason: parsed.reason,
      classification: parsed.classification,
      detail: parsed.detail,
    });
    if (expected !== parsed.failureDigest)
      throw new FundedComparisonRepositoryError(
        "INTERNAL_ERROR",
        "Failure receipt digest does not match its payload",
      );
    const inserted = await this.pool.query<{ recorded_at: Date | string }>(
      `INSERT INTO funded_comparison_failure (
         spec_id,attempt_id,side,session_date,reason,classification,detail,
         failure_digest,recorded_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp())
       ON CONFLICT DO NOTHING
       RETURNING recorded_at`,
      [
        parsed.specId,
        parsed.attemptId,
        parsed.side,
        parsed.sessionDate,
        parsed.reason,
        parsed.classification,
        parsed.detail,
        parsed.failureDigest,
      ],
    );
    if (inserted.rows[0])
      return { ...parsed, recordedAt: iso(inserted.rows[0].recorded_at) };
    const existing = await this.findFailure(
      parsed.specId,
      parsed.attemptId,
      parsed.reason,
      parsed.side,
      parsed.sessionDate,
    );
    if (!existing || existing.failureDigest !== parsed.failureDigest)
      throw new FundedComparisonRepositoryError(
        "CONFLICTING_RETRY",
        "A different failure receipt already owns this attempt coordinate",
      );
    return existing;
  }

  private async findFailure(
    specId: string,
    attemptId: string,
    reason: FundedComparisonFailureReason,
    side: FundedComparisonSide | null,
    sessionDate: string | null,
  ): Promise<FundedComparisonFailureReceipt | undefined> {
    const result = await this.pool.query<{
      side: FundedComparisonSide | null;
      session_date: string | Date | null;
      classification: "TERMINAL" | "INTERRUPTION";
      detail: string;
      failure_digest: string;
      recorded_at: Date | string;
    }>(
      `SELECT * FROM funded_comparison_failure
        WHERE spec_id=$1 AND attempt_id=$2 AND reason=$3
          AND side IS NOT DISTINCT FROM $4
          AND session_date IS NOT DISTINCT FROM $5::date`,
      [specId, attemptId, reason, side, sessionDate],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return fundedComparisonFailureReceiptSchema.parse({
      specId,
      attemptId,
      side: row.side,
      sessionDate:
        row.session_date === null ? null : dateOnly(row.session_date),
      reason,
      classification: row.classification,
      detail: row.detail,
      failureDigest: row.failure_digest,
      recordedAt: iso(row.recorded_at),
    });
  }

  async listFailures(
    specId: string,
  ): Promise<readonly FundedComparisonFailureReceipt[]> {
    const result = await this.pool.query<{
      attempt_id: string;
      side: FundedComparisonSide | null;
      session_date: string | Date | null;
      reason: FundedComparisonFailureReason;
      classification: "TERMINAL" | "INTERRUPTION";
      detail: string;
      failure_digest: string;
      recorded_at: Date | string;
    }>(
      `SELECT attempt_id,side,session_date,reason,classification,detail,
              failure_digest,recorded_at
         FROM funded_comparison_failure WHERE spec_id=$1
        ORDER BY recorded_at,id`,
      [specId],
    );
    return result.rows.map((row) =>
      fundedComparisonFailureReceiptSchema.parse({
        specId,
        attemptId: row.attempt_id,
        side: row.side,
        sessionDate:
          row.session_date === null ? null : dateOnly(row.session_date),
        reason: row.reason,
        classification: row.classification,
        detail: row.detail,
        failureDigest: row.failure_digest,
        recordedAt: iso(row.recorded_at),
      }),
    );
  }

  /**
   * Transactional finalization. Locks the specification, requires complete
   * immutable coverage for both sides and every membership session, recomputes
   * the result digest from the stored evidence and inserts the paired result
   * exactly once. A terminal failure prevents any result.
   */
  async finalizeResult(
    specId: string,
    result: FundedComparisonResult,
  ): Promise<FundedComparisonResult> {
    const parsed = fundedComparisonResultSchema.parse(result);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query<SpecRow>(
        "SELECT * FROM funded_comparison_spec WHERE id=$1 FOR UPDATE",
        [specId],
      );
      const specRow = locked.rows[0];
      if (!specRow)
        throw new FundedComparisonRepositoryError(
          "INTERNAL_ERROR",
          "Comparison specification does not exist",
        );
      const specification = fundedComparisonSpecificationSchema.parse(
        specRow.specification,
      );
      if (parsed.comparisonSpecDigest !== specification.comparisonSpecDigest)
        throw new FundedComparisonRepositoryError(
          "INTERNAL_ERROR",
          "Result specification digest does not match the frozen specification",
        );
      if (
        parsed.marketId !== specification.marketId ||
        parsed.currency !== specification.currency
      )
        throw new FundedComparisonRepositoryError(
          "INTERNAL_ERROR",
          "Result market or currency does not match the frozen specification",
        );
      const failures = await this.listFailuresWithClient(client, specId);
      if (failures.some((failure) => failure.classification === "TERMINAL"))
        throw new FundedComparisonRepositoryError(
          "INCOMPLETE_SESSION",
          "A terminal failure prevents a comparison result",
        );
      const sessions = await client.query<{
        session_date: string | Date;
        ordinal: number;
        opportunity_count: string | number;
      }>(
        `SELECT s.session_date,s.ordinal,
                (SELECT COUNT(*) FROM funded_comparison_spec_opportunity o
                  WHERE o.spec_id=s.spec_id AND o.session_date=s.session_date)
                  AS opportunity_count
           FROM funded_comparison_spec_session s
          WHERE s.spec_id=$1 ORDER BY s.ordinal`,
        [specId],
      );
      const frozenDates = sessions.rows.map((row) =>
        dateOnly(row.session_date),
      );
      const pairedDates = parsed.pairedSessions.map((row) => row.sessionDate);
      if (
        frozenDates.length !== parsed.sessionCount ||
        frozenDates.length !== pairedDates.length ||
        frozenDates.some((date, index) => date !== pairedDates[index])
      )
        throw new FundedComparisonRepositoryError(
          "INCOMPLETE_SESSION",
          "Result paired sessions do not match the exact frozen session membership",
        );
      for (const side of ["CHAMPION", "CHALLENGER"] as const) {
        const sideMetrics =
          parsed[side === "CHAMPION" ? "champion" : "challenger"];
        const returnDates = sideMetrics.return.sessions.map(
          (row) => row.sessionDate,
        );
        if (
          returnDates.length !== frozenDates.length ||
          returnDates.some((date, index) => date !== frozenDates[index])
        )
          throw new FundedComparisonRepositoryError(
            "INCOMPLETE_SESSION",
            `${side} per-session returns do not match the frozen session membership`,
          );
        const totalNetReturn = sideMetrics.return.sessions.reduce(
          (total, row) => total + row.netReturn,
          0,
        );
        if (
          sideMetrics.return.totalNetReturn !== totalNetReturn ||
          sideMetrics.return.returnPctOfInitialCash !==
            totalNetReturn / specification.capital.initialCash ||
          sideMetrics.drawdown.maxDrawdownPctOfInitialCash !==
            sideMetrics.drawdown.maxDrawdown /
              specification.capital.initialCash ||
          sideMetrics.stability.sessionCount !== frozenDates.length
        )
          throw new FundedComparisonRepositoryError(
            "INTERNAL_ERROR",
            `${side} derived metrics do not match their retained inputs`,
          );
      }
      for (const [index] of sessions.rows.entries()) {
        const sessionDate = frozenDates[index]!;
        const paired = parsed.pairedSessions[index]!;
        for (const side of ["CHAMPION", "CHALLENGER"] as const) {
          const binding = await this.findBindingWithClient(
            client,
            specId,
            side,
            sessionDate,
          );
          if (!binding)
            throw new FundedComparisonRepositoryError(
              "INCOMPLETE_SESSION",
              `${side} binding is missing for ${sessionDate}`,
            );
          const expectedPolicyDigest =
            side === "CHAMPION"
              ? specification.champion.policyDigest
              : specification.challenger.policyDigest;
          if (binding.policyDigest !== expectedPolicyDigest)
            throw new FundedComparisonRepositoryError(
              "INCOMPLETE_SESSION",
              `${side} policy identity changed for ${sessionDate}`,
            );
          const storedEvaluations = await this.listSessionEvaluationsWithClient(
            client,
            specId,
            side,
            sessionDate,
          );
          const expectedOpportunities = await client.query<{
            source_opportunity_id: string;
            ordinal: number;
          }>(
            `SELECT source_opportunity_id,ordinal
               FROM funded_comparison_spec_opportunity
              WHERE spec_id=$1 AND session_date=$2::date
              ORDER BY ordinal`,
            [specId, sessionDate],
          );
          if (
            storedEvaluations.length !== expectedOpportunities.rows.length ||
            storedEvaluations.some(
              (evaluation, evaluationIndex) =>
                evaluation.sourceOpportunityId !==
                  expectedOpportunities.rows[evaluationIndex]!
                    .source_opportunity_id ||
                evaluation.sourceOrdinal !==
                  expectedOpportunities.rows[evaluationIndex]!.ordinal,
            )
          )
            throw new FundedComparisonRepositoryError(
              "INCOMPLETE_SESSION",
              `${side} policy evaluations do not map the exact frozen membership for ${sessionDate}`,
            );
          const metric = await this.findSessionMetricWithClient(
            client,
            specId,
            side,
            sessionDate,
          );
          if (!metric || metric.valuation !== "UNION_GRID_MTM")
            throw new FundedComparisonRepositoryError(
              "INCOMPLETE_SESSION",
              `${side} has no proven session metric for ${sessionDate}`,
            );
          const expectedReturn =
            side === "CHAMPION"
              ? paired.baselineNetReturn
              : paired.challengerNetReturn;
          const expectedDrawdown =
            side === "CHAMPION"
              ? paired.baselineMaxDrawdown
              : paired.challengerMaxDrawdown;
          const sideReturn =
            parsed[side === "CHAMPION" ? "champion" : "challenger"].return
              .sessions[index]!.netReturn;
          if (
            metric.netReturn !== expectedReturn ||
            metric.maxDrawdown !== expectedDrawdown ||
            sideReturn !== expectedReturn
          )
            throw new FundedComparisonRepositoryError(
              "INCOMPLETE_SESSION",
              `${side} stored metric and side return for ${sessionDate} do not match the paired result`,
            );
        }
      }
      const recomputedDeltas = fundedComparisonDeltaMetricsOf(
        parsed.champion,
        parsed.challenger,
        parsed.pairedSessions,
      );
      const recomputedOutperformed = fundedComparisonOutperformedSessions(
        parsed.pairedSessions,
      );
      if (
        !isDeepStrictEqual(recomputedDeltas, parsed.deltas) ||
        recomputedOutperformed.count !==
          parsed.challengerOutperformedSessions.count ||
        recomputedOutperformed.proportion !==
          parsed.challengerOutperformedSessions.proportion
      )
        throw new FundedComparisonRepositoryError(
          "INTERNAL_ERROR",
          "Result deltas and paired values do not match the retained side metrics",
        );
      const championEvaluations = await this.listEvaluationsWithClient(
        client,
        specId,
        "CHAMPION",
      );
      const challengerEvaluations = await this.listEvaluationsWithClient(
        client,
        specId,
        "CHALLENGER",
      );
      const championEvaluationDigest =
        fundedComparisonEvaluationMembershipDigest(
          championEvaluations.map((evaluation) => evaluation.evaluationDigest),
        );
      const challengerEvaluationDigest =
        fundedComparisonEvaluationMembershipDigest(
          challengerEvaluations.map(
            (evaluation) => evaluation.evaluationDigest,
          ),
        );
      const championMetricsDigest = fundedComparisonMetricsDigest(
        parsed.champion,
      );
      const challengerMetricsDigest = fundedComparisonMetricsDigest(
        parsed.challenger,
      );
      const computedResultDigest = fundedComparisonResultDigest({
        comparisonSpecDigest: specification.comparisonSpecDigest,
        championEvaluationDigest,
        challengerEvaluationDigest,
        championMetricsDigest,
        challengerMetricsDigest,
        orderedPairedSessionDigests: parsed.pairedSessions.map((session) =>
          fundedComparisonPairedSessionDigest(parsed, session.sessionDate),
        ),
      });
      if (
        computedResultDigest !== parsed.resultDigest ||
        parsed.championEvaluationDigest !== championEvaluationDigest ||
        parsed.challengerEvaluationDigest !== challengerEvaluationDigest ||
        parsed.championMetricsDigest !== championMetricsDigest ||
        parsed.challengerMetricsDigest !== challengerMetricsDigest
      )
        throw new FundedComparisonRepositoryError(
          "INTERNAL_ERROR",
          "Result digest does not match the stored comparison evidence",
        );
      const existing = await this.loadResultWithClient(client, specId);
      if (existing) {
        await client.query("COMMIT");
        if (existing.resultDigest !== parsed.resultDigest)
          throw new FundedComparisonRepositoryError(
            "RESULT_DIGEST_CONFLICT",
            "A different result digest is already committed for this specification",
          );
        return existing;
      }
      await client.query(
        `INSERT INTO funded_comparison_result (
           spec_id,market_id,currency,result_version,session_count,
           historical_volume_status,champion_evaluation_digest,
           challenger_evaluation_digest,champion_metrics_digest,
           challenger_metrics_digest,result_digest,result
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
        [
          specId,
          specification.marketId,
          specification.currency,
          parsed.resultVersion,
          parsed.sessionCount,
          parsed.historicalVolumeStatus,
          parsed.championEvaluationDigest,
          parsed.challengerEvaluationDigest,
          parsed.championMetricsDigest,
          parsed.challengerMetricsDigest,
          parsed.resultDigest,
          JSON.stringify(parsed),
        ],
      );
      await client.query("COMMIT");
      return parsed;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  private async findBindingWithClient(
    client: PoolClient | Pool,
    specId: string,
    side: FundedComparisonSide,
    sessionDate: string,
  ): Promise<FundedComparisonRunBinding | undefined> {
    const result = await client.query<{
      run_id: string;
      account_id: string;
      market_id: "CA_TSX" | "US_EQUITIES";
      currency: "CAD" | "USD";
      policy_digest: string;
      execution_model_version: string;
      account_assumption_digest: string;
      bound_at: Date | string;
    }>(
      `SELECT * FROM funded_comparison_run_binding
        WHERE spec_id=$1 AND side=$2 AND session_date=$3::date`,
      [specId, side, sessionDate],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return fundedComparisonRunBindingSchema.parse({
      specId,
      side,
      sessionDate,
      runId: row.run_id,
      accountId: row.account_id,
      marketId: row.market_id,
      currency: row.currency,
      policyDigest: row.policy_digest,
      executionModelVersion: row.execution_model_version,
      accountAssumptionDigest: row.account_assumption_digest,
      boundAt: iso(row.bound_at),
    });
  }

  private async findSessionMetricWithClient(
    client: PoolClient | Pool,
    specId: string,
    side: FundedComparisonSide,
    sessionDate: string,
  ): Promise<FundedComparisonSessionMetric | undefined> {
    const result = await client.query<{
      market_id: "CA_TSX" | "US_EQUITIES";
      currency: "CAD" | "USD";
      valuation: "UNION_GRID_MTM" | "UNAVAILABLE";
      valuation_reason: FundedComparisonFailureReason | null;
      net_return: string | number | null;
      max_drawdown: string | number | null;
      trade_count: number;
      unrealized_position_count: number;
      unresolved_order_count: number;
      unresolved_reservation_count: number;
      stale_mark_count: number;
      valuation_point_count: number;
      metric_digest: string;
    }>(
      `SELECT * FROM funded_comparison_session_metric
        WHERE spec_id=$1 AND side=$2 AND session_date=$3::date`,
      [specId, side, sessionDate],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return fundedComparisonSessionMetricSchema.parse({
      specId,
      side,
      sessionDate,
      marketId: row.market_id,
      currency: row.currency,
      valuation: row.valuation,
      valuationReason: row.valuation_reason,
      netReturn: numberOrNull(row.net_return),
      maxDrawdown: numberOrNull(row.max_drawdown),
      tradeCount: row.trade_count,
      unrealizedPositionCount: row.unrealized_position_count,
      unresolvedOrderCount: row.unresolved_order_count,
      unresolvedReservationCount: row.unresolved_reservation_count,
      staleMarkCount: row.stale_mark_count,
      valuationPointCount: row.valuation_point_count,
      metricDigest: row.metric_digest,
    });
  }

  private async listEvaluationsWithClient(
    client: PoolClient | Pool,
    specId: string,
    side: FundedComparisonSide,
  ): Promise<readonly FundedComparisonPolicyEvaluation[]> {
    const result = await client.query<{
      session_date: string | Date;
      source_opportunity_id: string;
    }>(
      `SELECT session_date,source_opportunity_id
         FROM funded_comparison_policy_evaluation
        WHERE spec_id=$1 AND side=$2
        ORDER BY session_date,source_ordinal,source_opportunity_id`,
      [specId, side],
    );
    const evaluations: FundedComparisonPolicyEvaluation[] = [];
    for (const row of result.rows) {
      const evaluation = await this.findPolicyEvaluationWithClient(
        client,
        specId,
        side,
        dateOnly(row.session_date),
        row.source_opportunity_id,
      );
      if (evaluation) evaluations.push(evaluation);
    }
    return evaluations;
  }

  private async listSessionEvaluationsWithClient(
    client: PoolClient | Pool,
    specId: string,
    side: FundedComparisonSide,
    sessionDate: string,
  ): Promise<readonly FundedComparisonPolicyEvaluation[]> {
    const result = await client.query<{ source_opportunity_id: string }>(
      `SELECT source_opportunity_id
         FROM funded_comparison_policy_evaluation
        WHERE spec_id=$1 AND side=$2 AND session_date=$3::date
        ORDER BY source_ordinal,source_opportunity_id`,
      [specId, side, sessionDate],
    );
    const evaluations: FundedComparisonPolicyEvaluation[] = [];
    for (const row of result.rows) {
      const evaluation = await this.findPolicyEvaluationWithClient(
        client,
        specId,
        side,
        sessionDate,
        row.source_opportunity_id,
      );
      if (evaluation) evaluations.push(evaluation);
    }
    return evaluations;
  }

  private async listFailuresWithClient(
    client: PoolClient | Pool,
    specId: string,
  ): Promise<readonly FundedComparisonFailureReceipt[]> {
    const result = await client.query<{
      attempt_id: string;
      side: FundedComparisonSide | null;
      session_date: string | Date | null;
      reason: FundedComparisonFailureReason;
      classification: "TERMINAL" | "INTERRUPTION";
      detail: string;
      failure_digest: string;
      recorded_at: Date | string;
    }>(
      `SELECT attempt_id,side,session_date,reason,classification,detail,
              failure_digest,recorded_at
         FROM funded_comparison_failure WHERE spec_id=$1`,
      [specId],
    );
    return result.rows.map((row) =>
      fundedComparisonFailureReceiptSchema.parse({
        specId,
        attemptId: row.attempt_id,
        side: row.side,
        sessionDate:
          row.session_date === null ? null : dateOnly(row.session_date),
        reason: row.reason,
        classification: row.classification,
        detail: row.detail,
        failureDigest: row.failure_digest,
        recordedAt: iso(row.recorded_at),
      }),
    );
  }

  async loadResult(
    specId: string,
  ): Promise<FundedComparisonResult | undefined> {
    return this.loadResultWithClient(this.pool, specId);
  }

  private async loadResultWithClient(
    client: PoolClient | Pool,
    specId: string,
  ): Promise<FundedComparisonResult | undefined> {
    const result = await client.query<{
      result: unknown;
      result_digest: string;
    }>(
      "SELECT result,result_digest FROM funded_comparison_result WHERE spec_id=$1",
      [specId],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    const parsed = fundedComparisonResultSchema.parse(row.result);
    if (parsed.resultDigest !== row.result_digest)
      throw new FundedComparisonRepositoryError(
        "INTERNAL_ERROR",
        "Stored comparison result digest does not match its payload",
      );
    return parsed;
  }

  async loadAvailability(
    specId: string,
  ): Promise<FundedComparisonAvailabilityReceipt | undefined> {
    const specRow = await this.pool.query<SpecRow>(
      "SELECT * FROM funded_comparison_spec WHERE id=$1",
      [specId],
    );
    const row = specRow.rows[0];
    if (!row) return undefined;
    const specification = fundedComparisonSpecificationSchema.parse(
      row.specification,
    );
    const result = await this.loadResultWithClient(this.pool, specId);
    const failures = await this.listFailures(specId);
    const bindings = await this.pool.query<{ count: string | number }>(
      "SELECT COUNT(*) AS count FROM funded_comparison_run_binding WHERE spec_id=$1",
      [specId],
    );
    const sessionCount =
      specification.sessionMembership.orderedSessionDates.length;
    const terminal = failures.some(
      (failure) => failure.classification === "TERMINAL",
    );
    const interrupted = failures.some(
      (failure) => failure.classification === "INTERRUPTION",
    );
    const status = result
      ? "READY"
      : terminal
        ? "UNAVAILABLE"
        : interrupted
          ? "CANCELLED"
          : Number(bindings.rows[0]?.count ?? 0) > 0
            ? "RUNNING"
            : "PENDING";
    return fundedComparisonAvailabilityReceiptSchema.parse({
      specificationId: specId,
      marketId: specification.marketId,
      currency: specification.currency,
      comparisonSpecDigest: specification.comparisonSpecDigest,
      status,
      sessionCount,
      historicalVolumeStatus: result ? result.historicalVolumeStatus : null,
      resultDigest: result?.resultDigest ?? null,
      resultAvailable: result !== undefined,
      failures: failures.map((failure) => ({
        reason: failure.reason,
        classification: failure.classification,
        side: failure.side,
        sessionDate: failure.sessionDate,
        detail: failure.detail,
        recordedAt: failure.recordedAt,
      })),
      createdAt: iso(row.created_at),
    });
  }
}
