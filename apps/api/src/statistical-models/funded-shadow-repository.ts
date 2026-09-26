import {
  fundedShadowAttemptSchema,
  fundedShadowAttemptResultSchema,
  fundedShadowBatchProjectionSchema,
  fundedShadowBatchSchema,
  fundedShadowEnrollmentSchema,
  fundedShadowEnrollmentTransitionSchema,
  fundedShadowGatePolicySchema,
  fundedShadowLabelSchema,
  fundedShadowReportSchema,
  fundedShadowStatusSchema,
  FUNDED_SHADOW_BATCH_SEAL_GRACE_MS,
  nextFundedShadowState,
  type FundedShadowActiveEnrollment,
  type FundedShadowAttempt,
  type FundedShadowAttemptResult,
  type FundedShadowAvailabilityReceipt,
  type FundedShadowBatch,
  type FundedShadowBatchProjection,
  type FundedShadowEnrollment,
  type FundedShadowEnrollmentDraft,
  type FundedShadowEnrollmentState,
  type FundedShadowEnrollmentTransition,
  type FundedShadowFailureReason,
  type FundedShadowGatePolicy,
  type FundedShadowGatePolicyDraft,
  type FundedShadowLabel,
  type FundedShadowObserverEventKind,
  type FundedShadowReport,
  type FundedShadowReportDraft,
  type FundedShadowStatus,
  type FundedShadowTransitionAction,
  type MarketId,
} from "@tsx-scanner/contracts";
import type { Pool, PoolClient } from "pg";
import { contentHash } from "../paper-bot/funded-evidence-digest.js";
import { fundedExecutionSessionDate } from "./funded-execution-features.js";
import {
  fundedShadowAttemptDigest,
  fundedShadowBatchDigest,
  fundedShadowEnrollmentDigest,
  fundedShadowGatePolicyDigest,
  fundedShadowLabelDigest,
  fundedShadowMemberDigest,
  fundedShadowProjectionDigest,
  fundedShadowReportDigest,
  fundedShadowResultDigest,
} from "./funded-shadow-digest.js";

/**
 * Immutable FP04 shadow-observation persistence. The store is append-only: it
 * never updates or deletes an existing row, it never writes an order,
 * reservation, ledger, decision, outcome, policy or authority row, and it never
 * mutates a live funded account.
 */

export class FundedShadowError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = "FundedShadowError";
  }
}

export interface FundedShadowChampionRun {
  readonly runId: string;
  readonly status: string;
  readonly accountId: string;
  readonly currency: "CAD" | "USD";
  readonly policy: unknown;
  readonly policyDigest: string;
}

export interface FundedShadowDecisionMember {
  readonly observationId: string;
  readonly sequence: number;
  readonly contentDigest: string;
  readonly action: "SUBMIT" | "DECLINE" | "DEFER";
  readonly decisionContent: unknown;
  readonly evidenceSchemaVersion: number;
  readonly cohortDigest: string;
  readonly sourceKind: string;
}

export interface FundedShadowDecisionGroup {
  readonly runId: string;
  readonly accountId: string;
  readonly marketId: MarketId;
  readonly currency: "CAD" | "USD";
  readonly decisionAt: string;
  readonly sessionDate: string;
  readonly members: readonly FundedShadowDecisionMember[];
}

export interface FundedShadowPendingAttempt {
  readonly attempt: FundedShadowAttempt;
  readonly evidenceSchemaVersion: number | null;
  readonly cohortDigest: string | null;
  readonly sourceKind: string | null;
  readonly decisionContent: unknown;
}

export interface FundedShadowProjectionMember {
  readonly attempt: FundedShadowAttempt;
  readonly ordinal: number;
  readonly disposition: FundedShadowAttemptResult["disposition"];
  readonly failureReason: FundedShadowFailureReason | null;
  readonly predictionId: string | null;
  readonly predictionOutput: unknown;
  readonly decisionContent: unknown;
}

export interface FundedShadowProjectableBatch {
  readonly batch: FundedShadowBatch;
  readonly members: readonly FundedShadowProjectionMember[];
}

export interface FundedShadowLabelCandidate {
  readonly attemptId: string;
  readonly enrollmentId: string;
  readonly runId: string;
  readonly observationId: string;
  readonly marketId: MarketId;
  readonly currency: "CAD" | "USD";
}

export interface FundedShadowCanonicalOutcome {
  readonly executionId: string | null;
  readonly exitTime: string | null;
  readonly rMultiple: number | null;
  readonly runStatus: string;
}

export interface FundedShadowReportInputs {
  readonly active: FundedShadowActiveEnrollment;
  readonly batches: readonly FundedShadowBatch[];
  readonly attempts: readonly FundedShadowAttempt[];
  readonly results: readonly FundedShadowAttemptResult[];
  readonly predictions: ReadonlyMap<
    string,
    { readonly id: string; readonly output: unknown }
  >;
  readonly projections: readonly FundedShadowBatchProjection[];
  readonly labels: readonly FundedShadowLabel[];
  readonly eligibleObservations: number;
}

export interface FundedShadowStore {
  saveGatePolicy(draft: FundedShadowGatePolicyDraft): Promise<{
    id: string;
    policy: FundedShadowGatePolicy;
    reused: boolean;
  }>;
  getGatePolicy(
    digest: string,
  ): Promise<{ id: string; policy: FundedShadowGatePolicy } | undefined>;
  saveEnrollment(
    draft: FundedShadowEnrollmentDraft,
  ): Promise<{ enrollment: FundedShadowEnrollment; reused: boolean }>;
  transitionEnrollment(
    enrollmentId: string,
    action: FundedShadowTransitionAction,
    requestId: string,
  ): Promise<FundedShadowEnrollmentTransition>;
  listActiveEnrollments(
    marketId: MarketId,
  ): Promise<FundedShadowActiveEnrollment[]>;
  getEnrollment(
    enrollmentId: string,
  ): Promise<FundedShadowActiveEnrollment | undefined>;
  listEnrollmentIds(marketId: MarketId): Promise<string[]>;
  listChampionRuns(
    enrollment: FundedShadowEnrollment,
  ): Promise<FundedShadowChampionRun[]>;
  listUnsealedDecisionGroups(
    enrollment: FundedShadowEnrollment,
    runIds: readonly string[],
    limit: number,
  ): Promise<FundedShadowDecisionGroup[]>;
  countLateDecisionInputs(
    enrollment: FundedShadowEnrollment,
    runIds: readonly string[],
  ): Promise<number>;
  lateDecisionInputCount(marketId: MarketId): Promise<number>;
  lastLateInputEventCount(marketId: MarketId): Promise<number>;
  durablePredictionFor(input: {
    modelId: string;
    runId: string;
    observationId: string;
    decisionSequence: number;
  }): Promise<{ id: string; digest: string; predictionAt: string } | undefined>;
  sealBatch(
    enrollment: FundedShadowEnrollment,
    group: FundedShadowDecisionGroup,
  ): Promise<{
    batch: FundedShadowBatch;
    attempts: readonly FundedShadowAttempt[];
  }>;
  listPendingAttempts(
    enrollmentId: string,
    limit: number,
  ): Promise<FundedShadowPendingAttempt[]>;
  appendResult(
    input: Omit<FundedShadowAttemptResult, "recordedAt" | "resultDigest">,
  ): Promise<{ result: FundedShadowAttemptResult; reused: boolean }>;
  listProjectableBatches(
    enrollmentId: string,
    limit: number,
  ): Promise<FundedShadowProjectableBatch[]>;
  appendProjection(
    input: Omit<FundedShadowBatchProjection, "recordedAt" | "projectionDigest">,
  ): Promise<{ projection: FundedShadowBatchProjection; reused: boolean }>;
  listLabelCandidates(
    enrollmentId: string,
    limit: number,
  ): Promise<FundedShadowLabelCandidate[]>;
  canonicalOutcome(
    runId: string,
    observationId: string,
  ): Promise<FundedShadowCanonicalOutcome>;
  appendLabel(
    input: Omit<FundedShadowLabel, "recordedAt" | "labelDigest">,
  ): Promise<{ label: FundedShadowLabel; reused: boolean }>;
  saveReport(
    draft: FundedShadowReportDraft,
  ): Promise<{ report: FundedShadowReport; reused: boolean }>;
  loadReportInputs(
    enrollmentId: string,
    asOf?: string,
  ): Promise<FundedShadowReportInputs | undefined>;
  availability(
    enrollmentId: string,
  ): Promise<FundedShadowAvailabilityReceipt | undefined>;
  recordObserverEvent(input: {
    marketId: MarketId;
    currency: "CAD" | "USD";
    kind: FundedShadowObserverEventKind;
    detail?: string | null;
  }): Promise<void>;
  status(marketId: MarketId): Promise<FundedShadowStatus>;
}

const MARKET_CURRENCY: Record<MarketId, "CAD" | "USD"> = {
  CA_TSX: "CAD",
  US_EQUITIES: "USD",
};

const iso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const sessionDateOf = (value: Date | string): string =>
  value instanceof Date
    ? value.toISOString().slice(0, 10)
    : String(value).slice(0, 10);

function latestInstant(values: readonly string[]): string {
  let latest = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > latest) latest = parsed;
  }
  return new Date(
    latest === Number.NEGATIVE_INFINITY ? 0 : latest,
  ).toISOString();
}

interface GatePolicyRow {
  id: string;
  gate_policy_version: string;
  market_id: MarketId;
  currency: "CAD" | "USD";
  stage_b_approval: unknown;
  gate_window: unknown;
  challenger_policy_version: string;
  max_prediction_lag_ms: number;
  gate_policy_digest: string;
  created_at: Date;
}

interface EnrollmentRow {
  id: string;
  gate_policy_id: string;
  market_id: MarketId;
  currency: "CAD" | "USD";
  source_kind: "LIVE_PAPER";
  champion_payload: unknown;
  challenger_payload: unknown;
  effective_from: Date;
  evidence_cutoff_at: Date;
  registration_request_id: string;
  request_hash: string;
  enrollment_digest: string;
  created_at: Date;
}

interface AttemptRow {
  id: string;
  attempt_version: "funded-shadow-attempt-v1";
  batch_id: string;
  enrollment_id: string;
  market_id: MarketId;
  currency: "CAD" | "USD";
  run_id: string;
  account_id: string;
  observation_id: string;
  session_date: string;
  decision_sequence: number | null;
  decision_input_digest: string | null;
  champion_action: "SUBMIT" | "DECLINE" | "DEFER" | "UNAVAILABLE";
  decision_at: Date;
  deadline_at: Date;
  recorded_at: Date;
  attempt_digest: string;
}

function mapGatePolicy(row: GatePolicyRow): FundedShadowGatePolicy {
  return fundedShadowGatePolicySchema.parse({
    gatePolicyVersion: row.gate_policy_version,
    marketId: row.market_id,
    currency: row.currency,
    stageBApproval: row.stage_b_approval,
    window: row.gate_window,
    challengerPolicyVersion: row.challenger_policy_version,
    maxPredictionLagMs: Number(row.max_prediction_lag_ms),
    gatePolicyDigest: row.gate_policy_digest,
  });
}

function mapEnrollment(row: EnrollmentRow): FundedShadowEnrollment {
  return fundedShadowEnrollmentSchema.parse({
    enrollmentVersion: "funded-shadow-enrollment-v1",
    id: row.id,
    gatePolicyId: row.gate_policy_id,
    marketId: row.market_id,
    currency: row.currency,
    sourceKind: row.source_kind,
    champion: row.champion_payload,
    challenger: row.challenger_payload,
    effectiveFrom: iso(row.effective_from),
    evidenceCutoffAt: iso(row.evidence_cutoff_at),
    registrationRequestId: row.registration_request_id,
    requestHash: row.request_hash,
    enrollmentDigest: row.enrollment_digest,
    createdAt: iso(row.created_at),
  });
}

function mapAttempt(row: AttemptRow): FundedShadowAttempt {
  return fundedShadowAttemptSchema.parse({
    attemptVersion: row.attempt_version,
    id: row.id,
    batchId: row.batch_id,
    enrollmentId: row.enrollment_id,
    marketId: row.market_id,
    currency: row.currency,
    runId: row.run_id,
    accountId: row.account_id,
    observationId: row.observation_id,
    sessionDate: sessionDateOf(row.session_date),
    decisionSequence: row.decision_sequence,
    decisionInputDigest: row.decision_input_digest,
    championAction: row.champion_action,
    decisionAt: iso(row.decision_at),
    deadlineAt: iso(row.deadline_at),
    recordedAt: iso(row.recorded_at),
    attemptDigest: row.attempt_digest,
  });
}

interface BatchRow {
  id: string;
  enrollment_id: string;
  market_id: MarketId;
  currency: "CAD" | "USD";
  run_id: string;
  account_id: string;
  session_date: string;
  decision_at: Date;
  champion_identity_digest: string;
  sealed_at: Date;
  batch_digest: string;
}

function mapBatch(row: BatchRow): FundedShadowBatch {
  return fundedShadowBatchSchema.parse({
    id: row.id,
    enrollmentId: row.enrollment_id,
    marketId: row.market_id,
    currency: row.currency,
    runId: row.run_id,
    accountId: row.account_id,
    sessionDate: sessionDateOf(row.session_date),
    decisionAt: iso(row.decision_at),
    championIdentityDigest: row.champion_identity_digest,
    sealedAt: iso(row.sealed_at),
    batchDigest: row.batch_digest,
  });
}

interface ResultRow {
  attempt_id: string;
  enrollment_id: string;
  market_id: MarketId;
  currency: "CAD" | "USD";
  disposition: FundedShadowAttemptResult["disposition"];
  prediction_id: string | null;
  prediction_digest: string | null;
  failure_reason: FundedShadowFailureReason | null;
  recorded_at: Date;
  result_digest: string;
}

function mapResult(row: ResultRow): FundedShadowAttemptResult {
  return fundedShadowAttemptResultSchema.parse({
    attemptId: row.attempt_id,
    enrollmentId: row.enrollment_id,
    marketId: row.market_id,
    currency: row.currency,
    disposition: row.disposition,
    predictionId: row.prediction_id,
    predictionDigest: row.prediction_digest,
    failureReason: row.failure_reason,
    recordedAt: iso(row.recorded_at),
    resultDigest: row.result_digest,
  });
}

interface ProjectionRow {
  batch_id: string;
  projection_version: "funded-shadow-projection-v1";
  enrollment_id: string;
  market_id: MarketId;
  currency: "CAD" | "USD";
  batch_disposition: FundedShadowBatchProjection["batchDisposition"];
  fallback_reason: FundedShadowFailureReason | null;
  ordered_attempt_ids: string[];
  prediction_coverage: string | number;
  order_changes: number;
  recorded_at: Date;
  projection_digest: string;
}

function mapProjection(row: ProjectionRow): FundedShadowBatchProjection {
  return fundedShadowBatchProjectionSchema.parse({
    projectionVersion: row.projection_version,
    batchId: row.batch_id,
    enrollmentId: row.enrollment_id,
    marketId: row.market_id,
    currency: row.currency,
    batchDisposition: row.batch_disposition,
    fallbackReason: row.fallback_reason,
    orderedAttemptIds: row.ordered_attempt_ids,
    predictionCoverage: Number(row.prediction_coverage),
    orderChanges: Number(row.order_changes),
    recordedAt: iso(row.recorded_at),
    projectionDigest: row.projection_digest,
  });
}

interface LabelRow {
  attempt_id: string;
  label_version: "funded-shadow-label-v1";
  enrollment_id: string;
  market_id: MarketId;
  currency: "CAD" | "USD";
  status: FundedShadowLabel["status"];
  r_multiple: string | number | null;
  label_available_at: Date | null;
  unresolved_reason: FundedShadowLabel["unresolvedReason"];
  evidence_execution_id: string | null;
  recorded_at: Date;
  label_digest: string;
}

function mapLabel(row: LabelRow): FundedShadowLabel {
  return fundedShadowLabelSchema.parse({
    labelVersion: row.label_version,
    attemptId: row.attempt_id,
    enrollmentId: row.enrollment_id,
    marketId: row.market_id,
    currency: row.currency,
    status: row.status,
    rMultiple: row.r_multiple === null ? null : Number(row.r_multiple),
    labelAvailableAt:
      row.label_available_at === null ? null : iso(row.label_available_at),
    unresolvedReason: row.unresolved_reason,
    evidenceExecutionId: row.evidence_execution_id,
    recordedAt: iso(row.recorded_at),
    labelDigest: row.label_digest,
  });
}

export class PostgresFundedShadowStore implements FundedShadowStore {
  constructor(private readonly pool: Pool) {}

  async saveGatePolicy(draft: FundedShadowGatePolicyDraft): Promise<{
    id: string;
    policy: FundedShadowGatePolicy;
    reused: boolean;
  }> {
    const draftParsed = fundedShadowGatePolicySchema.parse({
      ...draft,
      gatePolicyDigest: "0".repeat(64),
    });
    const { gatePolicyDigest: _draftDigest, ...parsed } = draftParsed;
    const digest = fundedShadowGatePolicyDigest(parsed);
    const inserted = await this.pool.query<GatePolicyRow>(
      `INSERT INTO funded_shadow_gate_policy(
         gate_policy_version,market_id,currency,stage_b_approval,gate_window,
         challenger_policy_version,max_prediction_lag_ms,gate_policy_digest)
       VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8)
       ON CONFLICT (gate_policy_digest) DO NOTHING
       RETURNING *`,
      [
        parsed.gatePolicyVersion,
        parsed.marketId,
        parsed.currency,
        JSON.stringify(parsed.stageBApproval),
        JSON.stringify(parsed.window),
        parsed.challengerPolicyVersion,
        parsed.maxPredictionLagMs,
        digest,
      ],
    );
    if (inserted.rows[0])
      return {
        id: inserted.rows[0].id,
        policy: mapGatePolicy(inserted.rows[0]),
        reused: false,
      };
    const existing = await this.getGatePolicy(digest);
    if (!existing)
      throw new FundedShadowError(
        "FUNDED_SHADOW_GATE_POLICY_WRITE_CONFLICT",
        "The gate policy insert lost its race without a durable winner",
      );
    return { id: existing.id, policy: existing.policy, reused: true };
  }

  async getGatePolicy(
    digest: string,
  ): Promise<{ id: string; policy: FundedShadowGatePolicy } | undefined> {
    const { rows } = await this.pool.query<GatePolicyRow>(
      `SELECT * FROM funded_shadow_gate_policy WHERE gate_policy_digest=$1`,
      [digest],
    );
    return rows[0]
      ? { id: rows[0].id, policy: mapGatePolicy(rows[0]) }
      : undefined;
  }

  async saveEnrollment(
    draft: FundedShadowEnrollmentDraft,
  ): Promise<{ enrollment: FundedShadowEnrollment; reused: boolean }> {
    const draftParsed = fundedShadowEnrollmentSchema.parse({
      ...draft,
      id: "00000000-0000-4000-8000-000000000000",
      effectiveFrom: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      enrollmentDigest: "0".repeat(64),
    });
    const {
      id: _draftId,
      effectiveFrom: _draftEffective,
      createdAt: _draftCreated,
      enrollmentDigest: _draftDigest,
      ...parsed
    } = draftParsed;
    const digest = fundedShadowEnrollmentDigest(parsed);
    const { rows } = await this.pool.query<EnrollmentRow>(
      `INSERT INTO funded_shadow_enrollment(
         gate_policy_id,market_id,currency,source_kind,
         champion_source_run_id,champion_source_account_id,champion_policy_digest,
         champion_execution_model_version,champion_account_assumption_digest,champion_payload,
         challenger_model_id,challenger_model_version,challenger_model_type,
         challenger_artifact_digest,challenger_feature_version,challenger_cohort_digest,
         challenger_dataset_digest,challenger_training_partition_digest,
         challenger_training_evidence_cutoff_at,challenger_policy_digest,challenger_payload,
         evidence_cutoff_at,registration_request_id,request_hash,enrollment_digest)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21::jsonb,$22,$23,$24,$25)
       ON CONFLICT (registration_request_id) DO NOTHING
       RETURNING *`,
      [
        parsed.gatePolicyId,
        parsed.marketId,
        parsed.currency,
        parsed.sourceKind,
        parsed.champion.sourceLiveRunId,
        parsed.champion.sourceAccountId,
        parsed.champion.policyDigest,
        parsed.champion.executionModelVersion,
        parsed.champion.accountAssumptionDigest,
        JSON.stringify(parsed.champion),
        parsed.challenger.model.modelId,
        parsed.challenger.model.modelVersion,
        "FUNDED_EXECUTION_QUALITY",
        parsed.challenger.model.artifactDigest,
        parsed.challenger.model.featureVersion,
        parsed.challenger.model.cohortDigest,
        parsed.challenger.model.datasetDigest,
        parsed.challenger.model.trainingPartitionDigest,
        parsed.challenger.model.trainingEvidenceCutoffAt,
        parsed.challenger.policyDigest,
        JSON.stringify(parsed.challenger),
        parsed.evidenceCutoffAt,
        parsed.registrationRequestId,
        parsed.requestHash,
        digest,
      ],
    );
    if (rows[0]) return { enrollment: mapEnrollment(rows[0]), reused: false };
    const existing = await this.pool.query<EnrollmentRow>(
      `SELECT * FROM funded_shadow_enrollment
        WHERE registration_request_id=$1 OR enrollment_digest=$2
        ORDER BY created_at LIMIT 1`,
      [parsed.registrationRequestId, digest],
    );
    const row = existing.rows[0];
    if (!row)
      throw new FundedShadowError(
        "FUNDED_SHADOW_ENROLLMENT_WRITE_CONFLICT",
        "The enrollment insert lost its race without a durable winner",
      );
    if (row.enrollment_digest === digest)
      return { enrollment: mapEnrollment(row), reused: true };
    throw new FundedShadowError(
      "CONFLICTING_FUNDED_SHADOW_ENROLLMENT",
      "The enrollment registration request already owns a different identity",
    );
  }

  async transitionEnrollment(
    enrollmentId: string,
    action: FundedShadowTransitionAction,
    requestId: string,
  ): Promise<FundedShadowEnrollmentTransition> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Serialize concurrent transitions for this enrollment so the sequence is
      // allocated once and a duplicate request resolves to the committed row.
      await client.query(
        `SELECT id FROM funded_shadow_enrollment WHERE id=$1 FOR UPDATE`,
        [enrollmentId],
      );
      const existing = await client.query<{
        enrollment_id: string;
        sequence: number;
        action: FundedShadowTransitionAction;
        state: FundedShadowEnrollmentState;
        request_id: string;
        request_hash: string;
        effective_at: Date;
      }>(
        `SELECT * FROM funded_shadow_enrollment_transition
          WHERE enrollment_id=$1 AND request_id=$2`,
        [enrollmentId, requestId],
      );
      const requestHash = contentHash({ action });
      if (existing.rows[0]) {
        if (existing.rows[0].request_hash !== requestHash)
          throw new FundedShadowError(
            "CONFLICTING_FUNDED_SHADOW_TRANSITION",
            "The transition request id already owns a different action",
          );
        await client.query("COMMIT");
        return fundedShadowEnrollmentTransitionSchema.parse({
          enrollmentId: existing.rows[0].enrollment_id,
          sequence: Number(existing.rows[0].sequence),
          action: existing.rows[0].action,
          state: existing.rows[0].state,
          requestId: existing.rows[0].request_id,
          requestHash: existing.rows[0].request_hash,
          effectiveAt: iso(existing.rows[0].effective_at),
        });
      }
      const latest = await client.query<{
        state: FundedShadowEnrollmentState;
        sequence: number;
      }>(
        `SELECT state,sequence FROM funded_shadow_enrollment_transition
          WHERE enrollment_id=$1 ORDER BY sequence DESC LIMIT 1`,
        [enrollmentId],
      );
      const current = latest.rows[0]?.state ?? "SHADOW";
      const state = nextFundedShadowState(current, action);
      const sequence = Number(latest.rows[0]?.sequence ?? 0) + 1;
      const inserted = await client.query<{
        enrollment_id: string;
        sequence: number;
        action: FundedShadowTransitionAction;
        state: FundedShadowEnrollmentState;
        request_id: string;
        request_hash: string;
        effective_at: Date;
      }>(
        `INSERT INTO funded_shadow_enrollment_transition(
           enrollment_id,sequence,action,state,request_id,request_hash)
         VALUES($1,$2,$3,$4,$5,$6)
         RETURNING *`,
        [enrollmentId, sequence, action, state, requestId, requestHash],
      );
      await client.query("COMMIT");
      return fundedShadowEnrollmentTransitionSchema.parse({
        enrollmentId: inserted.rows[0]!.enrollment_id,
        sequence: Number(inserted.rows[0]!.sequence),
        action: inserted.rows[0]!.action,
        state: inserted.rows[0]!.state,
        requestId: inserted.rows[0]!.request_id,
        requestHash: inserted.rows[0]!.request_hash,
        effectiveAt: iso(inserted.rows[0]!.effective_at),
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async enrollmentState(
    client: Pool | PoolClient,
    enrollmentId: string,
  ): Promise<FundedShadowEnrollmentState> {
    const { rows } = await client.query<{ state: FundedShadowEnrollmentState }>(
      `SELECT state FROM funded_shadow_enrollment_transition
        WHERE enrollment_id=$1 ORDER BY sequence DESC LIMIT 1`,
      [enrollmentId],
    );
    return rows[0]?.state ?? "SHADOW";
  }

  private async activeEnrollmentRow(
    client: Pool | PoolClient,
    where: string,
    values: unknown[],
  ): Promise<FundedShadowActiveEnrollment | undefined> {
    const { rows } = await client.query<
      EnrollmentRow & {
        gate_policy_version: string;
        stage_b_approval: unknown;
        gate_window: unknown;
        challenger_policy_version: string;
        max_prediction_lag_ms: number;
        gate_policy_digest: string;
        policy_created_at: Date;
      }
    >(
      `SELECT e.*, p.gate_policy_version,p.stage_b_approval,p.gate_window,
              p.challenger_policy_version,p.max_prediction_lag_ms,
              p.gate_policy_digest,p.created_at AS policy_created_at
         FROM funded_shadow_enrollment e
         JOIN funded_shadow_gate_policy p ON p.id=e.gate_policy_id
        WHERE ${where}`,
      values,
    );
    const row = rows[0];
    if (!row) return undefined;
    const gatePolicy = mapGatePolicy({
      id: row.gate_policy_id,
      gate_policy_version: row.gate_policy_version,
      market_id: row.market_id,
      currency: row.currency,
      stage_b_approval: row.stage_b_approval,
      gate_window: row.gate_window,
      challenger_policy_version: row.challenger_policy_version,
      max_prediction_lag_ms: row.max_prediction_lag_ms,
      gate_policy_digest: row.gate_policy_digest,
      created_at: row.policy_created_at,
    });
    return {
      enrollment: mapEnrollment(row),
      gatePolicy,
      state: await this.enrollmentState(client, row.id),
    };
  }

  async listActiveEnrollments(
    marketId: MarketId,
  ): Promise<FundedShadowActiveEnrollment[]> {
    const { rows } = await this.pool.query<{ id: string }>(
      `SELECT id FROM funded_shadow_enrollment
        WHERE market_id=$1 ORDER BY created_at DESC`,
      [marketId],
    );
    const active: FundedShadowActiveEnrollment[] = [];
    for (const row of rows) {
      const enrollment = await this.activeEnrollmentRow(this.pool, "e.id=$1", [
        row.id,
      ]);
      if (enrollment && enrollment.state === "SHADOW") active.push(enrollment);
    }
    return active;
  }

  async getEnrollment(
    enrollmentId: string,
  ): Promise<FundedShadowActiveEnrollment | undefined> {
    return this.activeEnrollmentRow(this.pool, "e.id=$1", [enrollmentId]);
  }

  async listEnrollmentIds(marketId: MarketId): Promise<string[]> {
    const { rows } = await this.pool.query<{ id: string }>(
      `SELECT id FROM funded_shadow_enrollment
        WHERE market_id=$1 ORDER BY created_at DESC LIMIT 200`,
      [marketId],
    );
    return rows.map((row) => row.id);
  }

  async listChampionRuns(
    enrollment: FundedShadowEnrollment,
  ): Promise<FundedShadowChampionRun[]> {
    const { rows } = await this.pool.query<{
      run_id: string;
      status: string;
      account_id: string;
      currency: "CAD" | "USD";
      policy: unknown;
    }>(
      `SELECT r.id AS run_id,r.status,b.account_id,b.currency,b.policy
         FROM paper_bot_run r
         JOIN paper_funded_run b ON b.run_id=r.id
        WHERE r.source='LIVE' AND r.market_id=$1 AND b.account_id=$2 AND b.currency=$3
        ORDER BY r.started_at DESC, r.id`,
      [
        enrollment.marketId,
        enrollment.champion.sourceAccountId,
        enrollment.currency,
      ],
    );
    return rows.map((row) => ({
      runId: row.run_id,
      status: row.status,
      accountId: row.account_id,
      currency: row.currency,
      policy: row.policy,
      policyDigest: contentHash(row.policy),
    }));
  }

  async listUnsealedDecisionGroups(
    enrollment: FundedShadowEnrollment,
    runIds: readonly string[],
    limit: number,
  ): Promise<FundedShadowDecisionGroup[]> {
    if (runIds.length === 0) return [];
    const groups = await this.pool.query<{
      run_id: string;
      decision_at: Date;
      account_id: string;
    }>(
      `SELECT DISTINCT d.run_id,d.decision_at,b.account_id
         FROM funded_decision_evidence d
         JOIN paper_funded_run b ON b.run_id=d.run_id
        WHERE d.run_id = ANY($1::uuid[])
          AND d.market_id=$2 AND d.currency=$3
          AND d.decision_at >= $4
          AND NOT EXISTS (
            SELECT 1 FROM funded_shadow_batch x
             WHERE x.enrollment_id=$5 AND x.run_id=d.run_id AND x.decision_at=d.decision_at)
        ORDER BY d.decision_at, d.run_id
        LIMIT $6`,
      [
        runIds,
        enrollment.marketId,
        enrollment.currency,
        enrollment.effectiveFrom,
        enrollment.id,
        limit,
      ],
    );
    const result: FundedShadowDecisionGroup[] = [];
    for (const group of groups.rows) {
      const members = await this.pool.query<{
        observation_id: string;
        sequence: number;
        content_digest: string;
        action: "SUBMIT" | "DECLINE" | "DEFER";
        decision_content: unknown;
        evidence_schema_version: number;
        cohort_digest: string;
        source_kind: string;
      }>(
        `SELECT observation_id,sequence,content_digest,action,decision_content,
                evidence_schema_version,cohort_digest,source_kind
           FROM funded_decision_evidence
          WHERE run_id=$1 AND decision_at=$2 AND market_id=$3 AND currency=$4
          ORDER BY sequence
          LIMIT 500`,
        [
          group.run_id,
          group.decision_at,
          enrollment.marketId,
          enrollment.currency,
        ],
      );
      if (members.rows.length === 0) continue;
      const decisionAt = iso(group.decision_at);
      result.push({
        runId: group.run_id,
        accountId: group.account_id,
        marketId: enrollment.marketId,
        currency: enrollment.currency,
        decisionAt,
        sessionDate: fundedExecutionSessionDate(
          decisionAt,
          enrollment.marketId,
        ),
        members: members.rows.map((member) => ({
          observationId: member.observation_id,
          sequence: Number(member.sequence),
          contentDigest: member.content_digest,
          action: member.action,
          decisionContent: member.decision_content,
          evidenceSchemaVersion: Number(member.evidence_schema_version),
          cohortDigest: member.cohort_digest,
          sourceKind: member.source_kind,
        })),
      });
    }
    return result;
  }

  async durablePredictionFor(input: {
    modelId: string;
    runId: string;
    observationId: string;
    decisionSequence: number;
  }): Promise<
    { id: string; digest: string; predictionAt: string } | undefined
  > {
    const { rows } = await this.pool.query<{
      id: string;
      digest: string;
      prediction_at: Date;
    }>(
      `SELECT id,digest,prediction_at FROM funded_execution_prediction
        WHERE model_id=$1 AND run_id=$2 AND observation_id=$3 AND decision_sequence=$4`,
      [input.modelId, input.runId, input.observationId, input.decisionSequence],
    );
    const row = rows[0];
    return row
      ? { id: row.id, digest: row.digest, predictionAt: iso(row.prediction_at) }
      : undefined;
  }

  async countLateDecisionInputs(
    enrollment: FundedShadowEnrollment,
    runIds: readonly string[],
  ): Promise<number> {
    if (runIds.length === 0) return 0;
    const { rows } = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM funded_decision_evidence d
        WHERE d.run_id = ANY($1::uuid[])
          AND d.market_id=$2 AND d.currency=$3
          AND d.decision_at >= $4
          AND EXISTS (
            SELECT 1 FROM funded_shadow_batch b
             WHERE b.enrollment_id=$5 AND b.run_id=d.run_id AND b.decision_at=d.decision_at)
          AND NOT EXISTS (
            SELECT 1 FROM funded_shadow_attempt a
             WHERE a.enrollment_id=$5 AND a.run_id=d.run_id
               AND a.observation_id=d.observation_id)`,
      [
        runIds,
        enrollment.marketId,
        enrollment.currency,
        enrollment.effectiveFrom,
        enrollment.id,
      ],
    );
    return Number(rows[0]?.count ?? 0);
  }

  /** Distinct committed decisions that arrived after their batch was sealed. */
  async lateDecisionInputCount(marketId: MarketId): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      `SELECT count(DISTINCT (d.run_id, d.observation_id))::text AS count
         FROM funded_decision_evidence d
         JOIN funded_shadow_enrollment e
           ON e.market_id = d.market_id
          AND e.champion_source_account_id = d.account_id
        WHERE e.market_id=$1
          AND d.decision_at >= e.effective_from
          AND EXISTS (
            SELECT 1 FROM funded_shadow_batch b
             WHERE b.enrollment_id = e.id AND b.run_id = d.run_id
               AND b.decision_at = d.decision_at)
          AND NOT EXISTS (
            SELECT 1 FROM funded_shadow_attempt a
             WHERE a.enrollment_id = e.id AND a.run_id = d.run_id
               AND a.observation_id = d.observation_id)`,
      [marketId],
    );
    return Number(rows[0]?.count ?? 0);
  }

  /** Highest late-input count already recorded as an observer receipt. */
  async lastLateInputEventCount(marketId: MarketId): Promise<number> {
    const { rows } = await this.pool.query<{ count: string | null }>(
      `SELECT max((regexp_match(detail, 'late-decision-inputs:([0-9]+)'))[1]::int)::text AS count
         FROM funded_shadow_observer_event
        WHERE market_id=$1 AND kind='LATE_INPUT'`,
      [marketId],
    );
    return Number(rows[0]?.count ?? 0);
  }

  async sealBatch(
    enrollment: FundedShadowEnrollment,
    group: FundedShadowDecisionGroup,
  ): Promise<{
    batch: FundedShadowBatch;
    attempts: readonly FundedShadowAttempt[];
  }> {
    if (group.members.length === 0)
      throw new FundedShadowError(
        "EMPTY_FUNDED_SHADOW_BATCH",
        "A funded shadow batch requires at least one member",
      );
    const batchDigest = fundedShadowBatchDigest({
      enrollmentId: enrollment.id,
      runId: group.runId,
      accountId: group.accountId,
      marketId: group.marketId,
      currency: group.currency,
      sessionDate: group.sessionDate,
      decisionAt: group.decisionAt,
      championIdentityDigest: enrollment.champion.policyDigest,
      observationIds: group.members.map((member) => member.observationId),
    });
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const batch = await this.insertBatch(
        client,
        enrollment,
        group,
        batchDigest,
      );
      const attempts: FundedShadowAttempt[] = [];
      for (const [index, member] of group.members.entries()) {
        const attemptDigest = fundedShadowAttemptDigest({
          enrollmentId: enrollment.id,
          runId: group.runId,
          observationId: member.observationId,
          decisionSequence: member.sequence,
          decisionInputDigest: member.contentDigest,
          championAction: member.action,
          decisionAt: group.decisionAt,
          sessionDate: group.sessionDate,
        });
        const inserted = await client.query<AttemptRow>(
          `INSERT INTO funded_shadow_attempt(
             attempt_version,batch_id,enrollment_id,market_id,currency,run_id,
             account_id,observation_id,session_date,decision_sequence,
             decision_input_digest,champion_action,decision_at,deadline_at,attempt_digest)
           VALUES('funded-shadow-attempt-v1',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,$13)
           ON CONFLICT (enrollment_id,run_id,observation_id) DO NOTHING
           RETURNING *`,
          [
            batch.id,
            enrollment.id,
            group.marketId,
            group.currency,
            group.runId,
            group.accountId,
            member.observationId,
            group.sessionDate,
            member.sequence,
            member.contentDigest,
            member.action,
            group.decisionAt,
            attemptDigest,
          ],
        );
        let attempt = inserted.rows[0]
          ? mapAttempt(inserted.rows[0])
          : undefined;
        if (!attempt) {
          const existing = await client.query<AttemptRow>(
            `SELECT * FROM funded_shadow_attempt
              WHERE enrollment_id=$1 AND run_id=$2 AND observation_id=$3`,
            [enrollment.id, group.runId, member.observationId],
          );
          attempt = existing.rows[0] ? mapAttempt(existing.rows[0]) : undefined;
          if (!attempt || attempt.attemptDigest !== attemptDigest)
            throw new FundedShadowError(
              "CONFLICTING_FUNDED_SHADOW_ATTEMPT",
              "A sealed attempt already owns a different identity",
            );
        }
        attempts.push(attempt);
        const memberDigest = fundedShadowMemberDigest({
          batchId: batch.id,
          ordinal: index + 1,
          observationId: member.observationId,
          attemptId: attempt.id,
        });
        const memberInsert = await client.query<{ attempt_id: string }>(
          `INSERT INTO funded_shadow_batch_member(
             batch_id,ordinal,observation_id,attempt_id,member_digest)
           VALUES($1,$2,$3,$4,$5)
           ON CONFLICT (batch_id,observation_id) DO NOTHING
           RETURNING attempt_id`,
          [batch.id, index + 1, member.observationId, attempt.id, memberDigest],
        );
        if (!memberInsert.rows[0]) {
          const existingMember = await client.query<{
            attempt_id: string;
            member_digest: string;
          }>(
            `SELECT attempt_id,member_digest FROM funded_shadow_batch_member
              WHERE batch_id=$1 AND observation_id=$2`,
            [batch.id, member.observationId],
          );
          const row = existingMember.rows[0];
          if (
            !row ||
            row.member_digest !== memberDigest ||
            row.attempt_id !== attempt.id
          )
            throw new FundedShadowError(
              "CONFLICTING_FUNDED_SHADOW_BATCH_MEMBER",
              "A sealed batch member already owns a different identity",
            );
        }
      }
      await client.query("COMMIT");
      return { batch, attempts };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async insertBatch(
    client: PoolClient,
    enrollment: FundedShadowEnrollment,
    group: FundedShadowDecisionGroup,
    batchDigest: string,
  ): Promise<FundedShadowBatch> {
    const inserted = await client.query<BatchRow>(
      `INSERT INTO funded_shadow_batch(
         enrollment_id,market_id,currency,run_id,account_id,session_date,
         decision_at,champion_identity_digest,batch_digest)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (enrollment_id,run_id,decision_at) DO NOTHING
       RETURNING *`,
      [
        enrollment.id,
        group.marketId,
        group.currency,
        group.runId,
        group.accountId,
        group.sessionDate,
        group.decisionAt,
        enrollment.champion.policyDigest,
        batchDigest,
      ],
    );
    if (inserted.rows[0]) return mapBatch(inserted.rows[0]);
    const existing = await client.query<BatchRow>(
      `SELECT * FROM funded_shadow_batch
        WHERE enrollment_id=$1 AND run_id=$2 AND decision_at=$3`,
      [enrollment.id, group.runId, group.decisionAt],
    );
    const row = existing.rows[0];
    if (!row || row.batch_digest !== batchDigest)
      throw new FundedShadowError(
        "CONFLICTING_FUNDED_SHADOW_BATCH",
        "A sealed batch already owns a different identity",
      );
    return mapBatch(row);
  }

  async listPendingAttempts(
    enrollmentId: string,
    limit: number,
  ): Promise<FundedShadowPendingAttempt[]> {
    const { rows } = await this.pool.query<
      AttemptRow & {
        evidence_schema_version: number | null;
        cohort_digest: string | null;
        source_kind: string | null;
        decision_content: unknown;
      }
    >(
      `SELECT a.*,d.evidence_schema_version,d.cohort_digest,d.source_kind,d.decision_content
         FROM funded_shadow_attempt a
         LEFT JOIN funded_decision_evidence d
           ON d.run_id=a.run_id AND d.observation_id=a.observation_id
         LEFT JOIN funded_shadow_attempt_result r ON r.attempt_id=a.id
        WHERE a.enrollment_id=$1 AND r.attempt_id IS NULL
        ORDER BY a.deadline_at, a.id
        LIMIT $2`,
      [enrollmentId, limit],
    );
    return rows.map((row) => ({
      attempt: mapAttempt(row),
      evidenceSchemaVersion:
        row.evidence_schema_version === null
          ? null
          : Number(row.evidence_schema_version),
      cohortDigest: row.cohort_digest,
      sourceKind: row.source_kind,
      decisionContent: row.decision_content,
    }));
  }

  async appendResult(
    input: Omit<FundedShadowAttemptResult, "recordedAt" | "resultDigest">,
  ): Promise<{ result: FundedShadowAttemptResult; reused: boolean }> {
    const draftParsed = fundedShadowAttemptResultSchema.parse({
      ...input,
      recordedAt: new Date().toISOString(),
      resultDigest: "0".repeat(64),
    });
    const {
      recordedAt: _draftRecorded,
      resultDigest: _draftDigest,
      ...parsed
    } = draftParsed;
    const digest = fundedShadowResultDigest(parsed);
    const inserted = await this.pool.query<ResultRow>(
      `INSERT INTO funded_shadow_attempt_result(
         attempt_id,enrollment_id,market_id,currency,disposition,prediction_id,
         prediction_digest,failure_reason,result_digest)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (attempt_id) DO NOTHING
       RETURNING *`,
      [
        parsed.attemptId,
        parsed.enrollmentId,
        parsed.marketId,
        parsed.currency,
        parsed.disposition,
        parsed.predictionId,
        parsed.predictionDigest,
        parsed.failureReason,
        digest,
      ],
    );
    if (inserted.rows[0])
      return { result: mapResult(inserted.rows[0]), reused: false };
    const existing = await this.pool.query<ResultRow>(
      `SELECT * FROM funded_shadow_attempt_result WHERE attempt_id=$1`,
      [parsed.attemptId],
    );
    const row = existing.rows[0];
    if (!row || row.result_digest !== digest)
      throw new FundedShadowError(
        "CONFLICTING_FUNDED_SHADOW_ATTEMPT_RESULT",
        "A terminal attempt result already owns a different identity",
      );
    return { result: mapResult(row), reused: true };
  }

  async listProjectableBatches(
    enrollmentId: string,
    limit: number,
  ): Promise<FundedShadowProjectableBatch[]> {
    const { rows } = await this.pool.query<BatchRow>(
      `SELECT b.* FROM funded_shadow_batch b
         JOIN funded_shadow_enrollment e ON e.id=b.enrollment_id
         JOIN funded_shadow_gate_policy p ON p.id=e.gate_policy_id
        WHERE b.enrollment_id=$1
          AND NOT EXISTS (
            SELECT 1 FROM funded_shadow_batch_projection x WHERE x.batch_id=b.id)
          AND clock_timestamp() >= GREATEST(
            b.decision_at + (p.max_prediction_lag_ms * interval '1 millisecond'),
            b.sealed_at + ($3 * interval '1 millisecond')
          )
          AND NOT EXISTS (
            SELECT 1 FROM funded_shadow_batch_member m
            LEFT JOIN funded_shadow_attempt_result r ON r.attempt_id=m.attempt_id
            WHERE m.batch_id=b.id AND r.attempt_id IS NULL)
        ORDER BY b.decision_at, b.id
        LIMIT $2`,
      [enrollmentId, limit, FUNDED_SHADOW_BATCH_SEAL_GRACE_MS],
    );
    const result: FundedShadowProjectableBatch[] = [];
    for (const row of rows) {
      const batch = mapBatch(row);
      const members = await this.pool.query<
        AttemptRow & {
          ordinal: number;
          disposition: FundedShadowAttemptResult["disposition"];
          failure_reason: FundedShadowFailureReason | null;
          prediction_id: string | null;
          prediction_output: unknown;
          decision_content: unknown;
        }
      >(
        `SELECT a.*,m.ordinal,r.disposition,r.failure_reason,r.prediction_id,
                p.output AS prediction_output,d.decision_content
           FROM funded_shadow_batch_member m
           JOIN funded_shadow_attempt a ON a.id=m.attempt_id
           JOIN funded_shadow_attempt_result r ON r.attempt_id=a.id
           LEFT JOIN funded_execution_prediction p ON p.id=r.prediction_id
           LEFT JOIN funded_decision_evidence d
             ON d.run_id=a.run_id AND d.observation_id=a.observation_id
          WHERE m.batch_id=$1
          ORDER BY m.ordinal`,
        [batch.id],
      );
      result.push({
        batch,
        members: members.rows.map((member) => ({
          attempt: mapAttempt(member),
          ordinal: Number(member.ordinal),
          disposition: member.disposition,
          failureReason: member.failure_reason,
          predictionId: member.prediction_id,
          predictionOutput: member.prediction_output,
          decisionContent: member.decision_content,
        })),
      });
    }
    return result;
  }

  async appendProjection(
    input: Omit<FundedShadowBatchProjection, "recordedAt" | "projectionDigest">,
  ): Promise<{ projection: FundedShadowBatchProjection; reused: boolean }> {
    const draftParsed = fundedShadowBatchProjectionSchema.parse({
      ...input,
      recordedAt: new Date().toISOString(),
      projectionDigest: "0".repeat(64),
    });
    const {
      recordedAt: _draftRecorded,
      projectionDigest: _draftDigest,
      ...parsed
    } = draftParsed;
    const digest = fundedShadowProjectionDigest(parsed);
    const inserted = await this.pool.query<ProjectionRow>(
      `INSERT INTO funded_shadow_batch_projection(
         batch_id,projection_version,enrollment_id,market_id,currency,
         batch_disposition,fallback_reason,ordered_attempt_ids,
         prediction_coverage,order_changes,projection_digest)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8::uuid[],$9,$10,$11)
       ON CONFLICT (batch_id) DO NOTHING
       RETURNING *`,
      [
        parsed.batchId,
        parsed.projectionVersion,
        parsed.enrollmentId,
        parsed.marketId,
        parsed.currency,
        parsed.batchDisposition,
        parsed.fallbackReason,
        parsed.orderedAttemptIds,
        parsed.predictionCoverage,
        parsed.orderChanges,
        digest,
      ],
    );
    if (inserted.rows[0])
      return { projection: mapProjection(inserted.rows[0]), reused: false };
    const existing = await this.pool.query<ProjectionRow>(
      `SELECT * FROM funded_shadow_batch_projection WHERE batch_id=$1`,
      [parsed.batchId],
    );
    const row = existing.rows[0];
    if (!row || row.projection_digest !== digest)
      throw new FundedShadowError(
        "CONFLICTING_FUNDED_SHADOW_PROJECTION",
        "A projected batch already owns a different identity",
      );
    return { projection: mapProjection(row), reused: true };
  }

  async listLabelCandidates(
    enrollmentId: string,
    limit: number,
  ): Promise<FundedShadowLabelCandidate[]> {
    const { rows } = await this.pool.query<{
      id: string;
      enrollment_id: string;
      run_id: string;
      observation_id: string;
      market_id: MarketId;
      currency: "CAD" | "USD";
    }>(
      `SELECT a.id,a.enrollment_id,a.run_id,a.observation_id,a.market_id,a.currency
         FROM funded_shadow_attempt a
         JOIN funded_shadow_attempt_result r ON r.attempt_id=a.id
         LEFT JOIN funded_shadow_label l ON l.attempt_id=a.id
        WHERE a.enrollment_id=$1 AND l.attempt_id IS NULL
        ORDER BY a.recorded_at, a.id
        LIMIT $2`,
      [enrollmentId, limit],
    );
    return rows.map((row) => ({
      attemptId: row.id,
      enrollmentId: row.enrollment_id,
      runId: row.run_id,
      observationId: row.observation_id,
      marketId: row.market_id,
      currency: row.currency,
    }));
  }

  async canonicalOutcome(
    runId: string,
    observationId: string,
  ): Promise<FundedShadowCanonicalOutcome> {
    const execution = await this.pool.query<{
      id: string;
      exit_time: Date | null;
      r_multiple: string | number | null;
    }>(
      `SELECT id,date_trunc('milliseconds',exit_time) AS exit_time,r_multiple
         FROM paper_execution
        WHERE observation_id=$1 AND model='QUOTE'
        ORDER BY (status='CLOSED' AND r_multiple IS NOT NULL) DESC NULLS LAST,
                 exit_time DESC NULLS LAST, id
        LIMIT 1`,
      [observationId],
    );
    const run = await this.pool.query<{ status: string }>(
      `SELECT status FROM paper_bot_run WHERE id=$1`,
      [runId],
    );
    const row = execution.rows[0];
    return {
      executionId: row?.id ?? null,
      exitTime: row?.exit_time ? iso(row.exit_time) : null,
      rMultiple:
        row?.r_multiple === null || row?.r_multiple === undefined
          ? null
          : Number(row.r_multiple),
      runStatus: run.rows[0]?.status ?? "UNKNOWN",
    };
  }

  async appendLabel(
    input: Omit<FundedShadowLabel, "recordedAt" | "labelDigest">,
  ): Promise<{ label: FundedShadowLabel; reused: boolean }> {
    const draftParsed = fundedShadowLabelSchema.parse({
      ...input,
      recordedAt: new Date().toISOString(),
      labelDigest: "0".repeat(64),
    });
    const {
      recordedAt: _draftRecorded,
      labelDigest: _draftDigest,
      ...parsed
    } = draftParsed;
    const digest = fundedShadowLabelDigest(parsed);
    const inserted = await this.pool.query<LabelRow>(
      `INSERT INTO funded_shadow_label(
         attempt_id,label_version,enrollment_id,market_id,currency,status,
         r_multiple,label_available_at,unresolved_reason,evidence_execution_id,label_digest)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (attempt_id) DO NOTHING
       RETURNING *`,
      [
        parsed.attemptId,
        parsed.labelVersion,
        parsed.enrollmentId,
        parsed.marketId,
        parsed.currency,
        parsed.status,
        parsed.rMultiple,
        parsed.labelAvailableAt,
        parsed.unresolvedReason,
        parsed.evidenceExecutionId,
        digest,
      ],
    );
    if (inserted.rows[0])
      return { label: mapLabel(inserted.rows[0]), reused: false };
    const existing = await this.pool.query<LabelRow>(
      `SELECT * FROM funded_shadow_label WHERE attempt_id=$1`,
      [parsed.attemptId],
    );
    const row = existing.rows[0];
    if (!row || row.label_digest !== digest)
      throw new FundedShadowError(
        "CONFLICTING_FUNDED_SHADOW_LABEL",
        "A labelled attempt already owns a different identity",
      );
    return { label: mapLabel(row), reused: true };
  }

  async saveReport(
    draft: FundedShadowReportDraft,
  ): Promise<{ report: FundedShadowReport; reused: boolean }> {
    const draftParsed = fundedShadowReportSchema.parse({
      ...draft,
      reportDigest: "0".repeat(64),
    });
    const { reportDigest: _draftDigest, ...parsed } = draftParsed;
    const digest = fundedShadowReportDigest(parsed);
    const inserted = await this.pool.query<{
      enrollment_id: string;
      market_id: MarketId;
      currency: "CAD" | "USD";
      as_of: Date;
      report: unknown;
      report_digest: string;
      created_at: Date;
    }>(
      `INSERT INTO funded_shadow_report(
         enrollment_id,market_id,currency,as_of,report,report_digest)
       VALUES($1,$2,$3,$4,$5::jsonb,$6)
       ON CONFLICT (report_digest) DO NOTHING
       RETURNING *`,
      [
        parsed.enrollmentId,
        parsed.marketId,
        parsed.currency,
        parsed.evidenceBoundary.asOf,
        JSON.stringify({ ...parsed, reportDigest: digest }),
        digest,
      ],
    );
    const row =
      inserted.rows[0] ??
      (
        await this.pool.query<{
          enrollment_id: string;
          market_id: MarketId;
          currency: "CAD" | "USD";
          as_of: Date;
          report: unknown;
          report_digest: string;
          created_at: Date;
        }>(`SELECT * FROM funded_shadow_report WHERE report_digest=$1`, [
          digest,
        ])
      ).rows[0];
    if (!row)
      throw new FundedShadowError(
        "FUNDED_SHADOW_REPORT_WRITE_CONFLICT",
        "The report insert lost its race without a durable winner",
      );
    return {
      report: fundedShadowReportSchema.parse(row.report),
      reused: inserted.rows.length === 0,
    };
  }

  async loadReportInputs(
    enrollmentId: string,
    asOf?: string,
  ): Promise<FundedShadowReportInputs | undefined> {
    const active = await this.getEnrollment(enrollmentId);
    if (!active) return undefined;
    // With no explicit boundary the evidence itself defines it, so identical
    // frozen rows reproduce an identical report at any wall-clock time.
    const boundaryFilter = asOf ?? null;
    const batches = await this.pool.query<BatchRow>(
      `SELECT * FROM funded_shadow_batch
        WHERE enrollment_id=$1 AND ($2::timestamptz IS NULL OR sealed_at <= $2)
        ORDER BY decision_at, id`,
      [enrollmentId, boundaryFilter],
    );
    const attempts = await this.pool.query<AttemptRow>(
      `SELECT * FROM funded_shadow_attempt
        WHERE enrollment_id=$1 AND ($2::timestamptz IS NULL OR recorded_at <= $2)
        ORDER BY recorded_at, id`,
      [enrollmentId, boundaryFilter],
    );
    const results = await this.pool.query<ResultRow>(
      `SELECT * FROM funded_shadow_attempt_result
        WHERE enrollment_id=$1 AND ($2::timestamptz IS NULL OR recorded_at <= $2)
        ORDER BY recorded_at, attempt_id`,
      [enrollmentId, boundaryFilter],
    );
    const predictions = await this.pool.query<{
      id: string;
      output: unknown;
    }>(
      `SELECT p.id,p.output FROM funded_execution_prediction p
        JOIN funded_shadow_attempt_result r ON r.prediction_id=p.id
       WHERE r.enrollment_id=$1 AND ($2::timestamptz IS NULL OR r.recorded_at <= $2)`,
      [enrollmentId, boundaryFilter],
    );
    const projections = await this.pool.query<ProjectionRow>(
      `SELECT * FROM funded_shadow_batch_projection
        WHERE enrollment_id=$1 AND ($2::timestamptz IS NULL OR recorded_at <= $2)
        ORDER BY recorded_at, batch_id`,
      [enrollmentId, boundaryFilter],
    );
    const labels = await this.pool.query<LabelRow>(
      `SELECT * FROM funded_shadow_label
        WHERE enrollment_id=$1 AND ($2::timestamptz IS NULL OR recorded_at <= $2)
        ORDER BY recorded_at, attempt_id`,
      [enrollmentId, boundaryFilter],
    );
    const mappedBatches = batches.rows.map(mapBatch);
    const mappedAttempts = attempts.rows.map(mapAttempt);
    const mappedResults = results.rows.map(mapResult);
    const mappedProjections = projections.rows.map(mapProjection);
    const mappedLabels = labels.rows.map(mapLabel);
    const boundary =
      asOf ??
      latestInstant([
        active.enrollment.createdAt,
        ...mappedBatches.map((row) => row.sealedAt),
        ...mappedAttempts.map((row) => row.recordedAt),
        ...mappedResults.map((row) => row.recordedAt),
        ...mappedProjections.map((row) => row.recordedAt),
        ...mappedLabels.map((row) => row.recordedAt),
      ]);
    // The report's lifecycle state must belong to the same evidence boundary.
    const stateRow = await this.pool.query<{
      state: FundedShadowEnrollmentState;
    }>(
      `SELECT state FROM funded_shadow_enrollment_transition
        WHERE enrollment_id=$1 AND effective_at <= $2
        ORDER BY sequence DESC LIMIT 1`,
      [enrollmentId, boundary],
    );
    // The input denominator is the union of eligible observations in the window
    // and the decisions the champion actually made in it, so an attempt on a
    // pre-enrollment signal (a valid decision after enrollment) cannot make the
    // coverage ratio exceed one.
    const eligible = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM (
         SELECT o.id
           FROM paper_signal_observation o
           JOIN paper_bot_run r ON r.id=o.run_id
           JOIN paper_funded_run b ON b.run_id=r.id
          WHERE r.source='LIVE' AND r.market_id=$1 AND b.account_id=$2
            AND o.eligibility_status='ELIGIBLE'
            AND o.signal_timestamp >= $3 AND o.signal_timestamp <= $4
         UNION
         SELECT d.observation_id
           FROM funded_decision_evidence d
          WHERE d.market_id=$1 AND d.account_id=$2
            AND d.decision_at >= $3 AND d.decision_at <= $4
       ) eligible`,
      [
        active.enrollment.marketId,
        active.enrollment.champion.sourceAccountId,
        active.enrollment.effectiveFrom,
        boundary,
      ],
    );
    return {
      active: { ...active, state: stateRow.rows[0]?.state ?? "SHADOW" },
      batches: mappedBatches,
      attempts: mappedAttempts,
      results: mappedResults,
      predictions: new Map(
        predictions.rows.map((row) => [
          row.id,
          { id: row.id, output: row.output },
        ]),
      ),
      projections: mappedProjections,
      labels: mappedLabels,
      eligibleObservations: Number(eligible.rows[0]?.count ?? 0),
    };
  }

  async availability(
    enrollmentId: string,
  ): Promise<FundedShadowAvailabilityReceipt | undefined> {
    const active = await this.getEnrollment(enrollmentId);
    if (!active) return undefined;
    const counts = await this.pool.query<{
      batches: string;
      attempts: string;
      terminal: string;
      reports: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM funded_shadow_batch WHERE enrollment_id=$1) AS batches,
         (SELECT count(*)::text FROM funded_shadow_attempt WHERE enrollment_id=$1) AS attempts,
         (SELECT count(*)::text FROM funded_shadow_attempt_result WHERE enrollment_id=$1) AS terminal,
         (SELECT count(*)::text FROM funded_shadow_report WHERE enrollment_id=$1) AS reports`,
      [enrollmentId],
    );
    const latest = await this.pool.query<{
      report_digest: string;
      as_of: Date;
    }>(
      `SELECT report_digest,as_of FROM funded_shadow_report
        WHERE enrollment_id=$1 ORDER BY created_at DESC LIMIT 1`,
      [enrollmentId],
    );
    const row = counts.rows[0];
    return {
      enrollmentId,
      marketId: active.enrollment.marketId,
      currency: active.enrollment.currency,
      state: active.state,
      sealedBatches: Number(row?.batches ?? 0),
      attempts: Number(row?.attempts ?? 0),
      terminalAttempts: Number(row?.terminal ?? 0),
      reportsAvailable: Number(row?.reports ?? 0),
      latestReportDigest: latest.rows[0]?.report_digest ?? null,
      latestReportAsOf: latest.rows[0] ? iso(latest.rows[0].as_of) : null,
    };
  }

  async recordObserverEvent(input: {
    marketId: MarketId;
    currency: "CAD" | "USD";
    kind: FundedShadowObserverEventKind;
    detail?: string | null;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO funded_shadow_observer_event(market_id,currency,kind,detail)
       VALUES($1,$2,$3,$4)`,
      [input.marketId, input.currency, input.kind, input.detail ?? null],
    );
  }

  async status(marketId: MarketId): Promise<FundedShadowStatus> {
    const currency = MARKET_CURRENCY[marketId];
    const enrollments = await this.pool.query<{
      id: string;
      state: FundedShadowEnrollmentState;
    }>(
      `SELECT e.id,
              COALESCE((SELECT t.state FROM funded_shadow_enrollment_transition t
                         WHERE t.enrollment_id=e.id ORDER BY t.sequence DESC LIMIT 1),'SHADOW') AS state
         FROM funded_shadow_enrollment e
        WHERE e.market_id=$1
        ORDER BY e.created_at DESC, e.id`,
      [marketId],
    );
    const activeEnrollments = enrollments.rows.filter(
      (row) => row.state === "SHADOW",
    ).length;
    const enrollmentState =
      enrollments.rows.find((row) => row.state === "SHADOW")?.state ??
      enrollments.rows[0]?.state ??
      null;
    const counts = await this.pool.query<{
      sealed_batches: string;
      pending: string;
      oldest_pending_ms: string | null;
      timely: string;
      missed: string;
      invalid: string;
      failed: string;
      unavailable: string;
      fallback: string;
      labels: string;
      terminal: string;
      reports: string;
      latest_report_age_ms: string | null;
    }>(
      `SELECT
         (SELECT count(*)::text FROM funded_shadow_batch WHERE market_id=$1) AS sealed_batches,
         (SELECT count(*)::text FROM funded_shadow_attempt a
            LEFT JOIN funded_shadow_attempt_result r ON r.attempt_id=a.id
           WHERE a.market_id=$1 AND r.attempt_id IS NULL) AS pending,
         (SELECT EXTRACT(EPOCH FROM (clock_timestamp() - min(a.recorded_at))) * 1000
            FROM funded_shadow_attempt a
            LEFT JOIN funded_shadow_attempt_result r ON r.attempt_id=a.id
           WHERE a.market_id=$1 AND r.attempt_id IS NULL)::text AS oldest_pending_ms,
         (SELECT count(*)::text FROM funded_shadow_attempt_result WHERE market_id=$1 AND disposition='TIMELY_PREDICTION') AS timely,
         (SELECT count(*)::text FROM funded_shadow_attempt_result WHERE market_id=$1 AND disposition='MISSED_DEADLINE') AS missed,
         (SELECT count(*)::text FROM funded_shadow_attempt_result WHERE market_id=$1 AND disposition='INVALID_IDENTITY') AS invalid,
         (SELECT count(*)::text FROM funded_shadow_attempt_result WHERE market_id=$1 AND disposition='INFERENCE_FAILURE') AS failed,
         (SELECT count(*)::text FROM funded_shadow_attempt_result WHERE market_id=$1 AND disposition='INPUT_UNAVAILABLE') AS unavailable,
         (SELECT count(*)::text FROM funded_shadow_batch_projection WHERE market_id=$1 AND batch_disposition='FALLBACK_CHAMPION_ORDER') AS fallback,
         (SELECT count(*)::text FROM funded_shadow_label WHERE market_id=$1) AS labels,
         (SELECT count(*)::text FROM funded_shadow_attempt_result WHERE market_id=$1) AS terminal,
         (SELECT count(*)::text FROM funded_shadow_report WHERE market_id=$1) AS reports,
         (SELECT EXTRACT(EPOCH FROM (clock_timestamp() - max(created_at))) * 1000
            FROM funded_shadow_report WHERE market_id=$1)::text AS latest_report_age_ms`,
      [marketId],
    );
    const events = await this.pool.query<{ kind: string; count: string }>(
      `SELECT kind,count(*)::text AS count FROM funded_shadow_observer_event
        WHERE market_id=$1 GROUP BY kind`,
      [marketId],
    );
    const eventCount = (kind: string): number =>
      Number(events.rows.find((row) => row.kind === kind)?.count ?? 0);
    const row = counts.rows[0]!;
    const terminal = Number(row.terminal);
    const labels = Number(row.labels);
    const batches = Number(row.sealed_batches);
    const fallback = Number(row.fallback);
    return fundedShadowStatusSchema.parse({
      marketId,
      currency,
      enrollmentState,
      activeEnrollments,
      sealedBatches: batches,
      pendingAttempts: Number(row.pending),
      oldestPendingAttemptAgeMs:
        row.oldest_pending_ms === null
          ? null
          : Math.max(0, Math.round(Number(row.oldest_pending_ms))),
      timelyPredictions: Number(row.timely),
      missedDeadline: Number(row.missed),
      invalidIdentity: Number(row.invalid),
      inferenceFailure: Number(row.failed),
      inputUnavailable: Number(row.unavailable),
      fallbackBatches: fallback,
      predictionCoverage: terminal === 0 ? null : Number(row.timely) / terminal,
      labelCompleteness: terminal === 0 ? null : labels / terminal,
      reportsAvailable: Number(row.reports),
      latestReportAgeMs:
        row.latest_report_age_ms === null
          ? null
          : Math.max(0, Math.round(Number(row.latest_report_age_ms))),
      observerFailures: eventCount("OBSERVER_FAILURE"),
      reconcileFailures: eventCount("RECONCILE_FAILURE"),
      leaseContention: eventCount("LEASE_CONTENDED"),
      ownershipRefusals: eventCount("OWNERSHIP_REFUSAL"),
      lateInputs: await this.lateDecisionInputCount(marketId),
      readAt: new Date().toISOString(),
    });
  }
}
