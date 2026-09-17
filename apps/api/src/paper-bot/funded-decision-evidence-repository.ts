import type { Pool } from "pg";
import {
  fundedCohortComponentsSchema,
  fundedCohortIdentitySchema,
  fundedDecisionActionSchema,
  fundedDecisionTimeInputSchema,
  fundedOutcomeDetailSchema,
  fundedOutcomeStatusSchema,
  fundedOutcomeVersionSchema,
  fundedSourceKindSchema,
  marketIdSchema,
  type FundedDecisionAction,
  type FundedDecisionEvidenceIdentity,
  type FundedDecisionTimeInput,
  type FundedOutcomeStatus,
  type FundedSourceKind,
} from "@tsx-scanner/contracts";
import {
  decisionContentDigest,
  fundedCohortDigest,
  outcomeSourceDigest,
} from "./funded-evidence-digest.js";
import type {
  CapturedDecisionEvidence,
  FundedDecisionDraft,
  FundedEvidenceQueryable,
} from "./funded-decision-evidence.js";
import {
  buildDurableFundedDecision,
  type FundedDecisionEvidenceSource,
} from "./funded-decision-capture.js";
import {
  FundedReconstructionUnavailableError,
  type FundedReconstructionObservation,
} from "./funded-ledger-repository.js";

export type {
  CapturedDecisionEvidence,
  FundedDecisionDraft,
  FundedEvidenceQueryable,
} from "./funded-decision-evidence.js";

export interface OutcomeVersionDraft {
  readonly runId: string;
  readonly observationId: string;
  readonly status: FundedOutcomeStatus;
  readonly availableAt: string;
  readonly sourceKind: FundedSourceKind;
  readonly sourceId: string;
  readonly reason: string | null;
  readonly detail: unknown;
  readonly supersedesSequence: number | null;
  /**
   * Exact durable funded fact that made this version knowable. Required for a
   * trainable historical-replay version; null keeps it unavailable instead of
   * manufacturing a boundary. Live rows never carry one.
   */
  readonly sourceFactId?: string | null;
  /** Optional assertion checked against the recomputed source digest. */
  readonly expectedSourceDigest?: string;
}

export interface PersistedOutcomeVersion {
  readonly identity: FundedDecisionEvidenceIdentity;
  readonly sequence: number;
  readonly status: FundedOutcomeStatus;
  readonly availableAt: string;
  readonly recordedAt: string;
  readonly sourceKind: FundedSourceKind;
  readonly sourceId: string;
  readonly sourceDigest: string;
  readonly reason: string | null;
  readonly detail: unknown;
  readonly supersedesSequence: number | null;
  /** Exact causal fact identity; null means unavailable to replay training. */
  readonly sourceFactId: string | null;
}

/**
 * Durable decision intent. It is written before any best-effort decision
 * projection, so a restart can rebuild the exact action, reason, decision time
 * and ledger boundary without recomputing them from a later cycle clock.
 */
export interface DecisionIntentInput {
  readonly runId: string;
  readonly observationId: string;
  readonly action: FundedDecisionAction;
  readonly policyReason: string | null;
  readonly decisionAt: string;
}

export interface PersistedDecisionIntent {
  readonly runId: string;
  readonly observationId: string;
  readonly action: FundedDecisionAction;
  readonly policyReason: string | null;
  readonly decisionAt: string;
  readonly marketId: "CA_TSX" | "US_EQUITIES";
  readonly currency: "CAD" | "USD";
  readonly accountId: string;
  readonly sourceKind: FundedSourceKind;
  readonly boundaryEventSequence: number;
  readonly recordedAt: string;
}

/**
 * Durable refusal request. It is written before any intent INSERT, so a
 * failure at the intent boundary never consumes the refusal: repair rebuilds
 * the intent from this row with its original action, exact reason, decision
 * time and proven chronological ledger cursor.
 */
export interface DecisionRefusalInput {
  readonly runId: string;
  readonly observationId: string;
  readonly action: Extract<FundedDecisionAction, "DECLINE" | "DEFER">;
  readonly policyReason: string;
  readonly decisionAt: string;
}

export interface PersistedDecisionRefusal {
  readonly runId: string;
  readonly observationId: string;
  readonly action: Extract<FundedDecisionAction, "DECLINE" | "DEFER">;
  readonly policyReason: string;
  readonly decisionAt: string;
  readonly marketId: "CA_TSX" | "US_EQUITIES";
  readonly currency: "CAD" | "USD";
  readonly accountId: string;
  readonly sourceKind: FundedSourceKind;
  readonly boundaryEventSequence: number;
  readonly recordedAt: string;
}

/**
 * One refusal request presented with the funded cycle input. A live refusal is
 * materialized as the immutable refusal source inside the enqueue transaction;
 * a deferred request (historical replay) travels as an additive sidecar on its
 * enqueued fact and receives its chronological cursor from the ordered drain.
 * This is never part of the strict session-driver envelope.
 */
export interface DecisionRefusalRequest {
  readonly observationId: string;
  readonly action: Extract<FundedDecisionAction, "DECLINE" | "DEFER">;
  readonly policyReason: string;
  readonly decisionAt: string;
  /** Defer cursor capture to the ordered funded inbox (historical replay). */
  readonly deferBoundary?: boolean;
  /** Enqueued fact carrying a deferred request; required when deferred. */
  readonly factId?: string;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export interface FundedDecisionRow {
  run_id: string;
  observation_id: string;
  sequence: number;
  market_id: "CA_TSX" | "US_EQUITIES";
  currency: "CAD" | "USD";
  account_id: string;
  funded_policy_version: string;
  execution_model_version: string;
  feature_version: string;
  evidence_schema_version: number;
  action: FundedDecisionAction;
  source_kind: FundedSourceKind;
  content_digest: string;
  cohort_digest: string;
  decision_content: unknown;
  captured_at: Date | string;
}

export type DecisionRow = FundedDecisionRow;

interface DecisionIntentRow {
  run_id: string;
  observation_id: string;
  sequence_cursor: number | string;
  market_id: "CA_TSX" | "US_EQUITIES";
  currency: "CAD" | "USD";
  account_id: string;
  source_kind: FundedSourceKind;
  action: FundedDecisionAction;
  policy_reason: string | null;
  decision_at: Date | string;
  recorded_at: Date | string;
}

interface DecisionRefusalRow {
  run_id: string;
  observation_id: string;
  sequence_cursor: number | string;
  market_id: "CA_TSX" | "US_EQUITIES";
  currency: "CAD" | "USD";
  account_id: string;
  source_kind: FundedSourceKind;
  action: "DECLINE" | "DEFER";
  policy_reason: string;
  decision_at: Date | string;
  recorded_at: Date | string;
}

interface OutcomeRow {
  run_id: string;
  observation_id: string;
  sequence: number;
  status: FundedOutcomeStatus;
  source_kind: FundedSourceKind;
  source_id: string;
  source_digest: string;
  available_at: Date | string;
  recorded_at: Date | string;
  supersedes_sequence: number | null;
  reason: string | null;
  detail: unknown;
  source_fact_id: string | null;
  decision_sequence: number;
  market_id: "CA_TSX" | "US_EQUITIES";
  currency: "CAD" | "USD";
  account_id: string;
  funded_policy_version: string;
  execution_model_version: string;
  feature_version: string;
}

function iso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function decisionIdentity(row: DecisionRow): FundedDecisionEvidenceIdentity {
  return {
    marketId: row.market_id,
    currency: row.currency,
    accountId: row.account_id,
    runId: row.run_id,
    observationId: row.observation_id,
    decisionSequence: row.sequence,
    fundedPolicyVersion: row.funded_policy_version,
    executionModelVersion: row.execution_model_version,
    featureVersion: row.feature_version,
  };
}

function outcomeIdentity(row: OutcomeRow): FundedDecisionEvidenceIdentity {
  return {
    marketId: row.market_id,
    currency: row.currency,
    accountId: row.account_id,
    runId: row.run_id,
    observationId: row.observation_id,
    decisionSequence: row.decision_sequence,
    fundedPolicyVersion: row.funded_policy_version,
    executionModelVersion: row.execution_model_version,
    featureVersion: row.feature_version,
  };
}

function persistedOutcome(row: OutcomeRow): PersistedOutcomeVersion {
  return {
    identity: outcomeIdentity(row),
    sequence: row.sequence,
    status: row.status,
    availableAt: iso(row.available_at),
    recordedAt: iso(row.recorded_at),
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    sourceDigest: row.source_digest,
    reason: row.reason,
    detail: row.detail,
    supersedesSequence: row.supersedes_sequence,
    sourceFactId: row.source_fact_id,
  };
}

function persistedIntent(row: DecisionIntentRow): PersistedDecisionIntent {
  return {
    runId: row.run_id,
    observationId: row.observation_id,
    action: row.action,
    policyReason: row.policy_reason,
    decisionAt: iso(row.decision_at),
    marketId: row.market_id,
    currency: row.currency,
    accountId: row.account_id,
    sourceKind: row.source_kind,
    boundaryEventSequence: Number(row.sequence_cursor),
    recordedAt: iso(row.recorded_at),
  };
}

function persistedRefusal(row: DecisionRefusalRow): PersistedDecisionRefusal {
  return {
    runId: row.run_id,
    observationId: row.observation_id,
    action: row.action,
    policyReason: row.policy_reason,
    decisionAt: iso(row.decision_at),
    marketId: row.market_id,
    currency: row.currency,
    accountId: row.account_id,
    sourceKind: row.source_kind,
    boundaryEventSequence: Number(row.sequence_cursor),
    recordedAt: iso(row.recorded_at),
  };
}

function sourceKindOfRun(run: string): FundedSourceKind {
  if (run === "LIVE") return "LIVE_PAPER";
  if (run === "BACKTEST") return "HISTORICAL_REPLAY";
  throw new Error("UNSUPPORTED_FUNDED_RUN_SOURCE");
}

const DECISION_SELECT = `SELECT run_id,observation_id,sequence,market_id,currency,account_id,
    funded_policy_version,execution_model_version,feature_version,action,source_kind,
    content_digest,cohort_digest,decision_content,captured_at,evidence_schema_version
  FROM funded_decision_evidence`;

const INTENT_SELECT = `SELECT run_id,observation_id,sequence_cursor,market_id,currency,account_id,
    source_kind,action,policy_reason,decision_at,recorded_at
  FROM funded_decision_intent`;

const REFUSAL_SELECT = `SELECT run_id,observation_id,sequence_cursor,market_id,currency,account_id,
    source_kind,action,policy_reason,decision_at,recorded_at
  FROM funded_decision_refusal`;

/**
 * One distinct candidate set keyed by run/observation across every durable
 * backing source: refusal requests, intents, processed SIGNAL facts and
 * eligible observations. An opportunity with several sources is one missing
 * decision, not several.
 */
const MISSING_DECISION_CANDIDATES = `SELECT run_id,observation_id,at FROM (
    SELECT r.run_id,r.observation_id,r.decision_at AS at
      FROM funded_decision_refusal r
     WHERE r.run_id=$1
       AND NOT EXISTS (
         SELECT 1 FROM funded_decision_evidence d
         WHERE d.run_id=r.run_id AND d.observation_id=r.observation_id
       )
    UNION ALL
    SELECT i.run_id,i.observation_id,i.decision_at
      FROM funded_decision_intent i
     WHERE i.run_id=$1
       AND NOT EXISTS (
         SELECT 1 FROM funded_decision_evidence d
         WHERE d.run_id=i.run_id AND d.observation_id=i.observation_id
       )
    UNION ALL
    SELECT f.run_id,(f.fact->'order'->>'orderId')::uuid,f.fact_at
      FROM paper_funded_fact f
     WHERE f.run_id=$1 AND f.fact->>'type'='SIGNAL'
       AND f.outcome IS NOT NULL
       AND COALESCE(f.outcome->>'status','')<>'LATE_FACT'
       AND NOT EXISTS (
         SELECT 1 FROM funded_decision_evidence d
         WHERE d.run_id=f.run_id
           AND d.observation_id::text=f.fact->'order'->>'orderId'
       )
    UNION ALL
    SELECT f.run_id,(f.refusal_request->>'observationId')::uuid,f.fact_at
      FROM paper_funded_fact f
     WHERE f.run_id=$1 AND f.refusal_request IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM funded_decision_evidence d
         WHERE d.run_id=f.run_id
           AND d.observation_id::text=f.refusal_request->>'observationId'
       )
    UNION ALL
    SELECT o.run_id,o.id,o.signal_timestamp
      FROM paper_signal_observation o
     WHERE o.run_id=$1 AND o.eligibility_status='ELIGIBLE'
       AND NOT EXISTS (
         SELECT 1 FROM funded_decision_evidence d
         WHERE d.run_id=o.run_id AND d.observation_id=o.id
       )
       AND NOT EXISTS (
         SELECT 1 FROM paper_funded_fact f
         WHERE f.run_id=o.run_id AND f.fact_id='funded-signal:'||o.id::text
       )
  ) candidate_sources`;

const MISSING_DECISION_WORK = `WITH candidates AS (
    SELECT DISTINCT ON (run_id,observation_id) run_id,observation_id,at
      FROM (${MISSING_DECISION_CANDIDATES}) deduped
     ORDER BY run_id,observation_id,at
  )`;

const OUTCOME_SELECT = `SELECT o.run_id,o.observation_id,o.sequence,o.status,
    o.source_kind,o.source_id,o.source_digest,o.available_at,o.recorded_at,
    o.supersedes_sequence,o.reason,o.detail,o.source_fact_id,
    d.sequence AS decision_sequence,
    d.market_id,d.currency,d.account_id,d.funded_policy_version,
    d.execution_model_version,d.feature_version
  FROM funded_decision_outcome o
  JOIN funded_decision_evidence d
    ON d.run_id=o.run_id AND d.observation_id=o.observation_id`;

/**
 * Lifecycle-aware projection work: a decision is a candidate when it has a
 * durable fact/order/ledger source that is not yet represented by an outcome
 * version, or when a SUBMIT decision has no durable source at all (missing
 * evidence). A pending inbox fact or an open order is deliberately not a
 * candidate: nothing terminal has happened yet, so no version is owed.
 */
const PROJECTION_WORK_BODY = `WITH decision AS (
    SELECT d.run_id,d.observation_id,d.sequence,d.action,
           d.observation_id::text AS observation_key,
           CASE WHEN r.source='BACKTEST' THEN 'HISTORICAL_REPLAY' ELSE 'LIVE_PAPER' END AS source_kind
    FROM funded_decision_evidence d
    JOIN paper_bot_run r ON r.id=d.run_id
    WHERE d.run_id=$1
  ),
  signal_fact AS (
    SELECT d.run_id,d.observation_id,d.source_kind,f.fact_id,f.outcome
    FROM decision d
    JOIN paper_funded_fact f
      ON f.run_id=d.run_id AND f.fact_id='funded-signal:'||d.observation_key
    WHERE d.action='SUBMIT'
  ),
  entry_order AS (
    SELECT d.run_id,d.observation_id,d.source_kind,d.observation_key,o.state
    FROM decision d
    JOIN paper_entry_order o
      ON o.run_id=d.run_id AND o.order_id=d.observation_key
    WHERE d.action='SUBMIT'
  ),
  ledger_event AS (
    SELECT d.run_id,d.observation_id,d.source_kind,d.observation_key,
           e.event->>'id' AS event_id,e.event->>'type' AS event_type
    FROM decision d
    JOIN paper_funded_run b ON b.run_id=d.run_id
    JOIN paper_funded_event e ON e.account_id=b.account_id
      AND (e.event->>'orderId'=d.observation_key
           OR e.event->>'positionId'=d.observation_key)
    WHERE d.action='SUBMIT' AND e.event->>'type'='BUY'
  ),
  final_sell AS (
    SELECT DISTINCT ON (d.run_id,d.observation_id)
           d.run_id,d.observation_id,d.source_kind,d.observation_key,
           e.event->>'id' AS event_id
    FROM decision d
    JOIN paper_entry_order o
      ON o.run_id=d.run_id AND o.order_id=d.observation_key
    JOIN paper_funded_run b ON b.run_id=d.run_id
    JOIN paper_funded_event e ON e.account_id=b.account_id
      AND (e.event->>'orderId'=d.observation_key
           OR e.event->>'positionId'=d.observation_key)
    WHERE d.action='SUBMIT'
      AND o.state->'execution'->>'status'='CLOSED'
      AND e.event->>'type'='SELL'
    ORDER BY d.run_id,d.observation_id,e.event_sequence DESC
  ),
  expected AS (
    SELECT run_id,observation_id,source_kind,
           'decision:'||observation_key||':declined' AS source_id
    FROM decision WHERE action='DECLINE'
    UNION ALL
    SELECT run_id,observation_id,source_kind,
           'decision:'||observation_key||':deferred'
    FROM decision WHERE action='DEFER'
    UNION ALL
    SELECT run_id,observation_id,source_kind,'fact:'||fact_id||':veto'
    FROM signal_fact WHERE outcome->>'status'='RISK_VETO'
    UNION ALL
    SELECT run_id,observation_id,source_kind,'fact:'||fact_id||':suppressed'
    FROM signal_fact WHERE outcome->>'status'='PRE_SUBMISSION_SUPPRESSED'
    UNION ALL
    SELECT run_id,observation_id,source_kind,'fact:'||fact_id||':accepted'
    FROM signal_fact WHERE outcome->>'status'='APPLIED'
    UNION ALL
    SELECT run_id,observation_id,source_kind,'order:'||observation_key||':expired'
    FROM entry_order
    WHERE state->>'status'='CANCELLED'
      AND state->>'reason' IN ('EXPIRED','SESSION_CLOSED')
      AND state->>'lastQuoteAt' IS NOT NULL
    UNION ALL
    SELECT run_id,observation_id,source_kind,
           'order:'||observation_key||':no-executable-quote'
    FROM entry_order
    WHERE state->>'status'='CANCELLED'
      AND state->>'reason' IN ('EXPIRED','SESSION_CLOSED')
      AND state->>'lastQuoteAt' IS NULL
    UNION ALL
    SELECT run_id,observation_id,source_kind,'order:'||observation_key||':risk-veto'
    FROM entry_order
    WHERE state->>'status'='CANCELLED' AND state->>'reason'='RISK_VETO'
    UNION ALL
    SELECT run_id,observation_id,source_kind,'order:'||observation_key||':cancelled'
    FROM entry_order
    WHERE state->>'status'='CANCELLED'
      AND COALESCE(state->>'reason','') NOT IN ('EXPIRED','SESSION_CLOSED','RISK_VETO')
    UNION ALL
    SELECT run_id,observation_id,source_kind,'order:'||observation_key||':no-fill'
    FROM entry_order
    WHERE state->>'status'='REJECTED' AND state->'execution'->>'status'='NO_FILL'
      AND COALESCE(state->'execution'->>'noFillReason','') NOT IN
          ('MISSING_QUOTE','HALTED','DELAYED','STALE','UNKNOWN_QUOTE_SIZE')
    UNION ALL
    SELECT run_id,observation_id,source_kind,'order:'||observation_key||':no-executable-quote'
    FROM entry_order
    WHERE state->>'status'='REJECTED' AND state->'execution'->>'status'='NO_FILL'
      AND state->'execution'->>'noFillReason' IN
          ('MISSING_QUOTE','HALTED','DELAYED','STALE','UNKNOWN_QUOTE_SIZE')
    UNION ALL
    SELECT run_id,observation_id,source_kind,'order:'||observation_key||':economics'
    FROM entry_order
    WHERE state->>'status'='REJECTED'
      AND state->'execution'->>'status'='REJECTED_ECONOMICS'
    UNION ALL
    SELECT run_id,observation_id,source_kind,'order:'||observation_key||':rejected'
    FROM entry_order
    WHERE state->>'status'='REJECTED'
      AND COALESCE(state->'execution'->>'status','') NOT IN
          ('NO_FILL','REJECTED_ECONOMICS')
    UNION ALL
    SELECT run_id,observation_id,source_kind,'ledger:'||event_id
    FROM ledger_event WHERE event_type='BUY'
    UNION ALL
    SELECT run_id,observation_id,source_kind,'ledger:'||event_id
    FROM final_sell
    UNION ALL
    SELECT o.run_id,o.observation_id,o.source_kind,'ledger:'||o.observation_key||':entry'
    FROM entry_order o
    WHERE o.state->>'status'='FILLED' AND o.state->'execution' IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM ledger_event e
        WHERE e.run_id=o.run_id AND e.observation_id=o.observation_id
          AND e.event_type='BUY'
      )
  ),
  missing AS (
    SELECT d.run_id,d.observation_id,d.sequence
    FROM decision d
    WHERE EXISTS (
      SELECT 1 FROM expected e
      WHERE e.run_id=d.run_id AND e.observation_id=d.observation_id
        AND NOT EXISTS (
          SELECT 1 FROM funded_decision_outcome o
          WHERE o.run_id=e.run_id AND o.observation_id=e.observation_id
            AND o.source_kind=e.source_kind AND o.source_id=e.source_id
        )
    )
    UNION
    SELECT d.run_id,d.observation_id,d.sequence
    FROM decision d
    WHERE d.action='SUBMIT'
      AND NOT EXISTS (
        SELECT 1 FROM signal_fact f
        WHERE f.run_id=d.run_id AND f.observation_id=d.observation_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM entry_order o
        WHERE o.run_id=d.run_id AND o.observation_id=d.observation_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM funded_decision_outcome o
        WHERE o.run_id=d.run_id AND o.observation_id=d.observation_id
      )
  )`;

/**
 * Immutable funded decision evidence and append-only outcome versions.
 *
 * The persistence boundary owns capture time, decision and outcome sequences,
 * and every digest. It never calls the order service or ledger store, so it
 * cannot create, change or reverse an economic effect. Writes lock the existing
 * `paper_bot_run` row (the funded-run lock used by the order service) and run
 * in one transaction; a failed evidence write rolls back only evidence.
 */
export class FundedDecisionEvidenceRepository {
  constructor(
    private readonly pool: Pool,
    /** Optional operational observer for bounded ledger reconstructions. */
    private readonly onReconstruction?: (
      observation: FundedReconstructionObservation,
    ) => void,
    /**
     * Optional decision-time evidence provider. FP03 binds it to frozen
     * comparison chunks; live and historical replay leave it undefined and keep
     * reading the raw source tables.
     */
    private readonly evidenceSource?: FundedDecisionEvidenceSource,
  ) {}

  /** Capture a decision in its own transaction (locks the funded run). */
  async recordDecision(
    draft: FundedDecisionDraft,
  ): Promise<CapturedDecisionEvidence> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await this.recordDecisionInTransaction(
        client as unknown as FundedEvidenceQueryable,
        draft,
      );
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Capture a decision inside an existing transaction, for the funded inbox
   * acknowledgement path that must commit evidence with the fact it describes.
   */
  async recordDecisionInTransaction(
    client: FundedEvidenceQueryable,
    draft: FundedDecisionDraft,
  ): Promise<CapturedDecisionEvidence> {
    const decision = fundedDecisionTimeInputSchema.parse(draft.decision);
    // A runtime cohort digest may exist on a structurally typed caller object.
    // It is never trusted or hashed: the components are parsed by the strict
    // schema that has no digest field, and a supplied digest is only accepted
    // as an assertion against the recomputed value.
    const runtimeCohort = draft.cohort as typeof draft.cohort & {
      cohortDigest?: unknown;
    };
    const { cohortDigest: runtimeCohortDigest, ...cohortInput } = runtimeCohort;
    if (
      runtimeCohortDigest !== undefined &&
      (typeof runtimeCohortDigest !== "string" ||
        !/^[a-f0-9]{64}$/.test(runtimeCohortDigest))
    )
      throw new Error("Funded decision cohort digest is not canonical");
    const cohortComponents = fundedCohortComponentsSchema.parse({
      ...cohortInput,
      marketId: decision.marketId,
      currency: decision.currency,
      evidenceSchemaVersion: decision.evidenceSchemaVersion,
      fundedPolicyVersion: decision.fundedPolicyVersion,
      executionModelVersion: decision.executionModelVersion,
      featureVersion: decision.featureVersion,
    });
    const cohortDigest = fundedCohortDigest(cohortComponents);
    const cohort = fundedCohortIdentitySchema.parse({
      ...cohortComponents,
      cohortDigest,
    });
    if (
      runtimeCohortDigest !== undefined &&
      runtimeCohortDigest !== cohortDigest
    )
      throw new Error("Funded decision cohort digest mismatch");
    const contentDigest = decisionContentDigest(decision);
    if (
      draft.expectedContentDigest !== undefined &&
      draft.expectedContentDigest !== contentDigest
    )
      throw new Error("Funded decision content digest mismatch");
    if (
      draft.expectedCohortDigest !== undefined &&
      draft.expectedCohortDigest !== cohort.cohortDigest
    )
      throw new Error("Funded decision cohort digest mismatch");

    await this.lockFundedRun(client, decision.runId);
    await this.assertOwnership(client, decision);

    const existing = await client.query<DecisionRow>(
      `${DECISION_SELECT} WHERE run_id=$1 AND observation_id=$2`,
      [decision.runId, decision.observationId],
    );
    if (existing.rows[0]) {
      if (
        existing.rows[0].content_digest !== contentDigest ||
        existing.rows[0].cohort_digest !== cohort.cohortDigest ||
        existing.rows[0].action !== decision.action ||
        existing.rows[0].evidence_schema_version !==
          decision.evidenceSchemaVersion
      )
        throw new Error("Conflicting funded decision evidence retry");
      return {
        identity: decisionIdentity(existing.rows[0]),
        contentDigest: existing.rows[0].content_digest,
        cohortDigest: existing.rows[0].cohort_digest,
        capturedAt: iso(existing.rows[0].captured_at),
      };
    }

    const sequence = await this.nextDecisionSequence(client, decision.runId);
    await client.query(
      `INSERT INTO funded_decision_evidence(
         run_id,observation_id,sequence,market_id,currency,account_id,
         funded_policy_version,execution_model_version,feature_version,
         source_kind,action,decision_at,content_digest,decision_content,
         cohort_digest,cohort_components,evidence_schema_version)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16::jsonb,$17)`,
      [
        decision.runId,
        decision.observationId,
        sequence,
        decision.marketId,
        decision.currency,
        decision.accountId,
        decision.fundedPolicyVersion,
        decision.executionModelVersion,
        decision.featureVersion,
        decision.sourceKind,
        decision.action,
        decision.decisionAt,
        contentDigest,
        JSON.stringify(decision),
        cohortDigest,
        JSON.stringify(cohortComponents),
        decision.evidenceSchemaVersion,
      ],
    );
    const stored = await client.query<DecisionRow>(
      `${DECISION_SELECT} WHERE run_id=$1 AND observation_id=$2`,
      [decision.runId, decision.observationId],
    );
    const row = stored.rows[0];
    if (!row) throw new Error("Funded decision evidence was not persisted");
    return {
      identity: decisionIdentity(row),
      contentDigest: row.content_digest,
      cohortDigest: row.cohort_digest,
      capturedAt: iso(row.captured_at),
    };
  }

  /**
   * Durable decision boundary cursor for one observation. A committed
   * reservation proves the state strictly before it; an account with no
   * applicable events proves an empty state; anything else is only provable
   * while the decision is still in flight (the caller must not use a later
   * `CURRENT` read to repair an already-acknowledged fact).
   */
  private async decisionBoundarySequence(
    client: FundedEvidenceQueryable,
    accountId: string,
    observationId: string,
    decisionAt: string,
  ): Promise<{
    sequence: number;
    proof: "RESERVATION" | "EMPTY" | "CURRENT";
  }> {
    const reservation = await client.query<{
      event_sequence: number | string;
      event_sequence_verified: boolean;
    }>(
      `SELECT event_sequence,event_sequence_verified
         FROM paper_funded_event
        WHERE account_id=$1 AND event_id=$2`,
      [accountId, `reserve:${observationId}`],
    );
    const own = reservation.rows[0];
    if (own) {
      const sequence = Number(own.event_sequence);
      if (
        !own.event_sequence_verified ||
        !Number.isSafeInteger(sequence) ||
        sequence < 1
      )
        throw new FundedReconstructionUnavailableError(
          "UNVERIFIED_ORDERING",
          "Funded decision boundary is unavailable: the reservation ordering is unverified",
        );
      return { sequence: sequence - 1, proof: "RESERVATION" };
    }
    const latest = await client.query<{
      event_sequence: number | string;
      event_sequence_verified: boolean;
    }>(
      `SELECT event_sequence,event_sequence_verified
         FROM paper_funded_event
        WHERE account_id=$1
          AND (event->>'at')::timestamptz <= $2::timestamptz
        ORDER BY event_sequence DESC
        LIMIT 1`,
      [accountId, decisionAt],
    );
    const bound = latest.rows[0];
    if (!bound) return { sequence: 0, proof: "EMPTY" };
    const sequence = Number(bound.event_sequence);
    if (
      !bound.event_sequence_verified ||
      !Number.isSafeInteger(sequence) ||
      sequence < 1
    )
      throw new FundedReconstructionUnavailableError(
        "UNVERIFIED_ORDERING",
        "Funded decision boundary is unavailable: event ordering is unverified",
      );
    return { sequence, proof: "CURRENT" };
  }

  /**
   * Read the durable decision intent for one observation. The intent is the
   * restart-repairable source for a decision whose best-effort projection
   * failed.
   */
  async findDecisionIntent(
    runId: string,
    observationId: string,
  ): Promise<PersistedDecisionIntent | undefined> {
    const { rows } = await this.pool.query<DecisionIntentRow>(
      `${INTENT_SELECT} WHERE run_id=$1 AND observation_id=$2`,
      [runId, observationId],
    );
    return rows[0] ? persistedIntent(rows[0]) : undefined;
  }

  private async readIntentInTransaction(
    client: FundedEvidenceQueryable,
    runId: string,
    observationId: string,
  ): Promise<PersistedDecisionIntent | undefined> {
    const { rows } = await client.query<DecisionIntentRow>(
      `${INTENT_SELECT} WHERE run_id=$1 AND observation_id=$2`,
      [runId, observationId],
    );
    return rows[0] ? persistedIntent(rows[0]) : undefined;
  }

  /** Read the durable refusal source for one observation. */
  async findDecisionRefusal(
    runId: string,
    observationId: string,
  ): Promise<PersistedDecisionRefusal | undefined> {
    const { rows } = await this.pool.query<DecisionRefusalRow>(
      `${REFUSAL_SELECT} WHERE run_id=$1 AND observation_id=$2`,
      [runId, observationId],
    );
    return rows[0] ? persistedRefusal(rows[0]) : undefined;
  }

  private async readRefusalInTransaction(
    client: FundedEvidenceQueryable,
    runId: string,
    observationId: string,
  ): Promise<PersistedDecisionRefusal | undefined> {
    const { rows } = await client.query<DecisionRefusalRow>(
      `${REFUSAL_SELECT} WHERE run_id=$1 AND observation_id=$2`,
      [runId, observationId],
    );
    return rows[0] ? persistedRefusal(rows[0]) : undefined;
  }

  /**
   * Persist one durable refusal source in its own transaction. The row is
   * committed before any intent INSERT, so a failure at the intent boundary
   * leaves the exact action, reason, decision time and proven cursor
   * discoverable by repair.
   */
  async recordDecisionRefusal(
    input: DecisionRefusalInput,
  ): Promise<PersistedDecisionRefusal> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const refusal = await this.recordDecisionRefusalInTransaction(
        client as unknown as FundedEvidenceQueryable,
        input,
      );
      await client.query("COMMIT");
      return refusal;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async recordDecisionRefusalInTransaction(
    client: FundedEvidenceQueryable,
    input: DecisionRefusalInput,
  ): Promise<PersistedDecisionRefusal> {
    if (input.action !== "DECLINE" && input.action !== "DEFER")
      throw new Error("Unsupported funded decision refusal action");
    if (
      typeof input.policyReason !== "string" ||
      input.policyReason.trim() === ""
    )
      throw new Error("Funded decision refusal requires an exact reason");
    if (!Number.isFinite(Date.parse(input.decisionAt)))
      throw new Error("Invalid funded decision refusal time");
    const owned = await client.query<{
      market_id: string;
      source: string;
      currency: "CAD" | "USD";
      account_id: string;
    }>(
      `SELECT r.market_id,r.source,f.currency,f.account_id
         FROM paper_bot_run r JOIN paper_funded_run f ON f.run_id=r.id
        WHERE r.id=$1`,
      [input.runId],
    );
    const run = owned.rows[0];
    if (!run) throw new Error("Funded decision refusal run not found");
    const marketId = marketIdSchema.parse(run.market_id);
    const expectedCurrency = marketId === "CA_TSX" ? "CAD" : "USD";
    if (run.currency !== expectedCurrency)
      throw new Error("Funded decision refusal market/currency mismatch");
    const sourceKind = sourceKindOfRun(run.source);
    const observation = await client.query(
      "SELECT 1 FROM paper_signal_observation WHERE run_id=$1 AND id=$2",
      [input.runId, input.observationId],
    );
    if (!observation.rows.length)
      throw new Error(
        "Funded decision refusal observation does not belong to the funded run",
      );
    const boundary = await this.decisionBoundarySequence(
      client,
      run.account_id,
      input.observationId,
      input.decisionAt,
    );
    await client.query(
      `INSERT INTO funded_decision_refusal(
         run_id,observation_id,sequence_cursor,market_id,currency,account_id,
         source_kind,action,policy_reason,decision_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (run_id,observation_id) DO NOTHING`,
      [
        input.runId,
        input.observationId,
        boundary.sequence,
        marketId,
        run.currency,
        run.account_id,
        sourceKind,
        input.action,
        input.policyReason,
        input.decisionAt,
      ],
    );
    const stored = await client.query<DecisionRefusalRow>(
      `${REFUSAL_SELECT} WHERE run_id=$1 AND observation_id=$2`,
      [input.runId, input.observationId],
    );
    const row = stored.rows[0];
    if (!row) throw new Error("Funded decision refusal was not persisted");
    const persisted = persistedRefusal(row);
    if (
      persisted.action !== input.action ||
      persisted.policyReason !== input.policyReason ||
      Date.parse(persisted.decisionAt) !== Date.parse(input.decisionAt) ||
      persisted.sourceKind !== sourceKind ||
      persisted.marketId !== marketId ||
      persisted.currency !== run.currency ||
      persisted.accountId !== run.account_id ||
      persisted.boundaryEventSequence !== boundary.sequence
    )
      throw new Error("Conflicting funded decision refusal retry");
    return persisted;
  }

  /**
   * Standalone refusal writer for tests and repair fixtures. The production
   * live path never uses it: a live refusal source is written inside the
   * enqueue transaction (`ensureLiveRefusalInTransaction`) so the source and
   * its cycle input commit atomically. A stored refusal always wins and must
   * match the exact action and reason.
   */
  async ensureDecisionRefusal(
    input: DecisionRefusalInput,
  ): Promise<PersistedDecisionRefusal> {
    const existing = await this.findDecisionRefusal(
      input.runId,
      input.observationId,
    );
    if (existing) {
      if (
        existing.action !== input.action ||
        existing.policyReason !== input.policyReason
      )
        throw new Error("Conflicting funded decision refusal retry");
      return existing;
    }
    return this.recordDecisionRefusal(input);
  }

  /**
   * Record the refusal requests carried by one funded cycle input inside the
   * caller's enqueue transaction. A live request is materialized as the
   * immutable refusal source in the same transaction that commits its facts;
   * a deferred request is stored as an additive sidecar on its fact row and
   * receives its chronological cursor from the ordered drain. Either the
   * exact source commits with the cycle input or neither does.
   */
  async recordRefusalRequestsInTransaction(
    client: FundedEvidenceQueryable,
    runId: string,
    requests: readonly DecisionRefusalRequest[],
  ): Promise<void> {
    for (const request of requests) {
      if (request.deferBoundary)
        await this.attachDeferredRefusalRequestInTransaction(
          client,
          runId,
          request,
        );
      else
        await this.ensureLiveRefusalInTransaction(client, {
          runId,
          observationId: request.observationId,
          action: request.action,
          policyReason: request.policyReason,
          decisionAt: request.decisionAt,
        });
    }
  }

  /**
   * Live refusal source inside the enqueue transaction. A stored refusal
   * always wins and must match the exact action and reason; the cursor is
   * captured from the account state committed before this cycle's facts.
   */
  async ensureLiveRefusalInTransaction(
    client: FundedEvidenceQueryable,
    input: DecisionRefusalInput,
  ): Promise<PersistedDecisionRefusal> {
    const existing = await this.readRefusalInTransaction(
      client,
      input.runId,
      input.observationId,
    );
    if (existing) {
      if (
        existing.action !== input.action ||
        existing.policyReason !== input.policyReason
      )
        throw new Error("Conflicting funded decision refusal retry");
      return existing;
    }
    return this.recordDecisionRefusalInTransaction(client, input);
  }

  /**
   * Attach a deferred refusal request to its already-enqueued fact row. The
   * sidecar retains the exact action, reason and decision time so the ordered
   * drain can capture the chronological cursor later; the fact JSON that
   * reaches `processFundedSessionFacts` is unchanged.
   */
  private async attachDeferredRefusalRequestInTransaction(
    client: FundedEvidenceQueryable,
    runId: string,
    request: DecisionRefusalRequest,
  ): Promise<void> {
    if (request.action !== "DECLINE" && request.action !== "DEFER")
      throw new Error("Unsupported funded decision refusal action");
    if (
      typeof request.policyReason !== "string" ||
      request.policyReason.trim() === ""
    )
      throw new Error("Funded decision refusal requires an exact reason");
    if (!Number.isFinite(Date.parse(request.decisionAt)))
      throw new Error("Invalid funded decision refusal time");
    if (!request.factId)
      throw new Error("Deferred funded refusal requires its enqueued fact");
    const owned = await client.query<{ run_id: string }>(
      `SELECT r.id AS run_id
         FROM paper_bot_run r JOIN paper_funded_run f ON f.run_id=r.id
        WHERE r.id=$1`,
      [runId],
    );
    if (!owned.rows.length)
      throw new Error("Funded decision refusal run not found");
    const observation = await client.query(
      "SELECT 1 FROM paper_signal_observation WHERE run_id=$1 AND id=$2",
      [runId, request.observationId],
    );
    if (!observation.rows.length)
      throw new Error(
        "Funded decision refusal observation does not belong to the funded run",
      );
    const metadata = {
      observationId: request.observationId,
      action: request.action,
      policyReason: request.policyReason,
      decisionAt: request.decisionAt,
    };
    await client.query(
      `UPDATE paper_funded_fact SET refusal_request=$3::jsonb
        WHERE run_id=$1 AND fact_id=$2 AND refusal_request IS NULL`,
      [runId, request.factId, JSON.stringify(metadata)],
    );
    const stored = await client.query<{ refusal_request: unknown }>(
      "SELECT refusal_request FROM paper_funded_fact WHERE run_id=$1 AND fact_id=$2",
      [runId, request.factId],
    );
    const row = stored.rows[0];
    if (!row)
      throw new Error(
        "Deferred funded refusal fact was not found in the cycle input",
      );
    const persisted = recordOf(row.refusal_request);
    if (
      !persisted ||
      persisted.observationId !== request.observationId ||
      persisted.action !== request.action ||
      persisted.policyReason !== request.policyReason ||
      Date.parse(String(persisted.decisionAt)) !==
        Date.parse(request.decisionAt)
    )
      throw new Error("Conflicting funded refusal request retry");
  }

  /**
   * Persist one decision intent in its own transaction, before any best-effort
   * decision projection. The action, exact reason, decision time, ownership and
   * ledger sequence cursor are immutable: a conflicting retry is an error and a
   * later caller must reuse the stored intent.
   */
  async recordDecisionIntent(
    input: DecisionIntentInput,
  ): Promise<PersistedDecisionIntent> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const intent = await this.recordDecisionIntentInTransaction(
        client as unknown as FundedEvidenceQueryable,
        input,
      );
      await client.query("COMMIT");
      return intent;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Immutable-intent retry boundary. A stored intent always wins, so a restart
   * or an idempotent replay never re-derives the decision time or the proven
   * ledger cursor from a later state. The action and exact reason must still
   * match; a recomputed deterministic boundary for the same refusal is
   * discarded in favor of the original stored timestamp.
   */
  async ensureDecisionIntent(
    input: DecisionIntentInput,
  ): Promise<PersistedDecisionIntent> {
    const existing = await this.findDecisionIntent(
      input.runId,
      input.observationId,
    );
    if (existing) {
      const reason = input.policyReason ?? null;
      if (existing.action !== input.action || existing.policyReason !== reason)
        throw new Error("Conflicting funded decision intent retry");
      return existing;
    }
    return this.recordDecisionIntent(input);
  }

  async recordDecisionIntentInTransaction(
    client: FundedEvidenceQueryable,
    input: DecisionIntentInput,
    options: {
      allowCurrentBoundary?: boolean;
      /**
       * A cursor already proven by a durable refusal source. When present it is
       * authoritative: it is never recomputed from the transaction's state.
       */
      boundaryEventSequence?: number;
    } = {},
  ): Promise<PersistedDecisionIntent> {
    const action = fundedDecisionActionSchema.parse(input.action);
    if (!Number.isFinite(Date.parse(input.decisionAt)))
      throw new Error("Invalid funded decision intent time");
    const reason = input.policyReason ?? null;
    if ((action === "SUBMIT") !== (reason === null))
      throw new Error(
        "Funded decision intent reason does not match its action",
      );
    const owned = await client.query<{
      market_id: string;
      source: string;
      currency: "CAD" | "USD";
      account_id: string;
    }>(
      `SELECT r.market_id,r.source,f.currency,f.account_id
         FROM paper_bot_run r JOIN paper_funded_run f ON f.run_id=r.id
        WHERE r.id=$1`,
      [input.runId],
    );
    const run = owned.rows[0];
    if (!run) throw new Error("Funded decision intent run not found");
    const marketId = marketIdSchema.parse(run.market_id);
    const expectedCurrency = marketId === "CA_TSX" ? "CAD" : "USD";
    if (run.currency !== expectedCurrency)
      throw new Error("Funded decision intent market/currency mismatch");
    const sourceKind = sourceKindOfRun(run.source);
    const observation = await client.query(
      "SELECT 1 FROM paper_signal_observation WHERE run_id=$1 AND id=$2",
      [input.runId, input.observationId],
    );
    if (!observation.rows.length)
      throw new Error(
        "Funded decision intent observation does not belong to the funded run",
      );
    let boundarySequence: number;
    let boundaryProof: "RESERVATION" | "EMPTY" | "CURRENT" | "PROVIDED";
    if (options.boundaryEventSequence !== undefined) {
      if (
        !Number.isSafeInteger(options.boundaryEventSequence) ||
        options.boundaryEventSequence < 0
      )
        throw new Error("Invalid funded decision intent boundary cursor");
      boundarySequence = options.boundaryEventSequence;
      boundaryProof = "PROVIDED";
    } else {
      const boundary = await this.decisionBoundarySequence(
        client,
        run.account_id,
        input.observationId,
        input.decisionAt,
      );
      boundarySequence = boundary.sequence;
      boundaryProof = boundary.proof;
    }
    if (boundaryProof === "CURRENT" && options.allowCurrentBoundary === false)
      throw new FundedReconstructionUnavailableError(
        "BOUNDARY_UNPROVEN",
        "Funded decision intent boundary cannot be proven after acknowledgement",
      );
    await client.query(
      `INSERT INTO funded_decision_intent(
         run_id,observation_id,sequence_cursor,market_id,currency,account_id,
         source_kind,action,policy_reason,decision_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (run_id,observation_id) DO NOTHING`,
      [
        input.runId,
        input.observationId,
        boundarySequence,
        marketId,
        run.currency,
        run.account_id,
        sourceKind,
        action,
        reason,
        input.decisionAt,
      ],
    );
    const stored = await client.query<DecisionIntentRow>(
      `${INTENT_SELECT} WHERE run_id=$1 AND observation_id=$2`,
      [input.runId, input.observationId],
    );
    const row = stored.rows[0];
    if (!row) throw new Error("Funded decision intent was not persisted");
    const persisted = persistedIntent(row);
    if (
      persisted.action !== action ||
      persisted.policyReason !== reason ||
      Date.parse(persisted.decisionAt) !== Date.parse(input.decisionAt) ||
      persisted.sourceKind !== sourceKind ||
      persisted.marketId !== marketId ||
      persisted.currency !== run.currency ||
      persisted.accountId !== run.account_id ||
      persisted.boundaryEventSequence !== boundarySequence
    )
      throw new Error("Conflicting funded decision intent retry");
    return persisted;
  }

  /**
   * Capture one already-committed SIGNAL submission from durable sources
   * inside the caller's transaction. The decision boundary is the exact
   * persisted `order.submittedAt` and the durable intent's proven ledger
   * cursor; the portfolio state is reconstructed from the account ledger and
   * order history under the funded run/account locks, so a later signal in the
   * same batch sees this signal's committed reservation and an earlier signal
   * never sees a later same-timestamp one.
   */
  async captureSignalDecisionInTransaction(
    client: FundedEvidenceQueryable,
    runId: string,
    observationId: string,
    options: { allowCurrentBoundary?: boolean } = {},
  ): Promise<CapturedDecisionEvidence> {
    let intent = await this.readIntentInTransaction(
      client,
      runId,
      observationId,
    );
    if (!intent) {
      const fact = await client.query<{ submitted_at: Date | string | null }>(
        `SELECT fact->'order'->>'submittedAt' AS submitted_at
         FROM paper_funded_fact WHERE run_id=$1 AND fact_id=$2`,
        [runId, `funded-signal:${observationId}`],
      );
      const submittedAt = fact.rows[0]?.submitted_at;
      if (!submittedAt)
        throw new Error("Funded signal decision has no retained submission");
      intent = await this.recordDecisionIntentInTransaction(
        client,
        {
          runId,
          observationId,
          action: "SUBMIT",
          policyReason: null,
          decisionAt: iso(submittedAt),
        },
        options,
      );
    }
    return this.captureIntentDecisionInTransaction(client, intent);
  }

  private async captureIntentDecisionInTransaction(
    client: FundedEvidenceQueryable,
    intent: PersistedDecisionIntent,
  ): Promise<CapturedDecisionEvidence> {
    const draft = await buildDurableFundedDecision(
      client,
      {
        runId: intent.runId,
        observationId: intent.observationId,
        action: intent.action,
        policyReason: intent.policyReason,
        decisionAt: intent.decisionAt,
        boundaryEventSequence: intent.boundaryEventSequence,
      },
      this.onReconstruction,
      this.evidenceSource,
    );
    return this.recordDecisionInTransaction(client, draft);
  }

  /** Capture a decision from its durable intent inside a caller transaction. */
  async captureDecisionFromIntentInTransaction(
    client: FundedEvidenceQueryable,
    runId: string,
    observationId: string,
  ): Promise<CapturedDecisionEvidence> {
    const intent = await this.readIntentInTransaction(
      client,
      runId,
      observationId,
    );
    if (!intent) throw new Error("No funded decision intent exists");
    return this.captureIntentDecisionInTransaction(client, intent);
  }

  /** Capture a decision from its durable intent in its own transaction. */
  async captureDecisionFromIntent(
    runId: string,
    observationId: string,
  ): Promise<CapturedDecisionEvidence> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await this.captureDecisionFromIntentInTransaction(
        client as unknown as FundedEvidenceQueryable,
        runId,
        observationId,
      );
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  private async ensureIntentFromRefusalInTransaction(
    client: FundedEvidenceQueryable,
    refusal: PersistedDecisionRefusal,
  ): Promise<PersistedDecisionIntent> {
    const existing = await this.readIntentInTransaction(
      client,
      refusal.runId,
      refusal.observationId,
    );
    if (existing) {
      if (
        existing.action !== refusal.action ||
        existing.policyReason !== refusal.policyReason
      )
        throw new Error("Conflicting funded decision intent retry");
      return existing;
    }
    return this.recordDecisionIntentInTransaction(
      client,
      {
        runId: refusal.runId,
        observationId: refusal.observationId,
        action: refusal.action,
        policyReason: refusal.policyReason,
        decisionAt: refusal.decisionAt,
      },
      { boundaryEventSequence: refusal.boundaryEventSequence },
    );
  }

  /**
   * Capture a refusal decision from its durable source inside the caller's
   * transaction. The refusal row is the only action/reason/timestamp/cursor
   * input, so this is safe to retry after a restart.
   */
  async captureRefusalDecisionInTransaction(
    client: FundedEvidenceQueryable,
    runId: string,
    observationId: string,
  ): Promise<CapturedDecisionEvidence> {
    const refusal = await this.readRefusalInTransaction(
      client,
      runId,
      observationId,
    );
    if (!refusal)
      throw new Error("No funded decision refusal exists for this observation");
    const intent = await this.ensureIntentFromRefusalInTransaction(
      client,
      refusal,
    );
    return this.captureIntentDecisionInTransaction(client, intent);
  }

  /**
   * Capture a refusal when a durable source exists, and report false when the
   * suppression has no source (for example a legacy or supplied-facts CANCEL).
   * The ordered drain uses this so it never fabricates a refusal: semantics
   * come only from the durable source written with the cycle input.
   */
  async captureRefusalDecisionIfPresentInTransaction(
    client: FundedEvidenceQueryable,
    runId: string,
    observationId: string,
  ): Promise<boolean> {
    const refusal = await this.readRefusalInTransaction(
      client,
      runId,
      observationId,
    );
    if (!refusal) return false;
    const intent = await this.ensureIntentFromRefusalInTransaction(
      client,
      refusal,
    );
    await this.captureIntentDecisionInTransaction(client, intent);
    return true;
  }

  /**
   * Resolve one missing decision from whichever durable source exists: a
   * refusal request, an existing intent, or a processed SIGNAL fact with a
   * provable reservation. A candidate with no resolvable source fails visibly
   * and stays a gap; nothing is fabricated.
   */
  private async captureMissingDecisionInTransaction(
    client: FundedEvidenceQueryable,
    runId: string,
    observationId: string,
  ): Promise<CapturedDecisionEvidence> {
    const refusal = await this.readRefusalInTransaction(
      client,
      runId,
      observationId,
    );
    if (refusal)
      return this.captureRefusalDecisionInTransaction(
        client,
        runId,
        observationId,
      );
    const intent = await this.readIntentInTransaction(
      client,
      runId,
      observationId,
    );
    if (intent) return this.captureIntentDecisionInTransaction(client, intent);
    // A deferred refusal sidecar whose chronological boundary was never
    // materialized cannot be proven after acknowledgement. Fail closed with a
    // clear reason instead of fabricating a snapshot.
    const deferred = await client.query<{ refusal_request: unknown }>(
      `SELECT refusal_request FROM paper_funded_fact
        WHERE run_id=$1 AND (refusal_request->>'observationId')::uuid=$2::uuid
        LIMIT 1`,
      [runId, observationId],
    );
    if (deferred.rows[0]?.refusal_request)
      throw new FundedReconstructionUnavailableError(
        "BOUNDARY_UNPROVEN",
        "Deferred funded refusal boundary was not materialized at its inbox position",
      );
    return this.captureSignalDecisionInTransaction(
      client,
      runId,
      observationId,
      {
        allowCurrentBoundary: false,
      },
    );
  }

  /**
   * Repair pass for decisions that are still owed evidence. One distinct
   * candidate set is built across refusal requests, intents, processed SIGNAL
   * facts and eligible observations, keyed by run/observation and ordered
   * oldest-first. The batch attempts no more than `limit` decisions in total.
   * A SIGNAL fact without a stored source needs a provable reservation; an
   * unprovable post-hoc boundary fails closed and stays a visible gap rather
   * than fabricating a portfolio snapshot.
   */
  async repairMissingDecisions(
    runId: string,
    limit = 25,
  ): Promise<{ repaired: number; failed: number; remaining: number }> {
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new Error("Invalid funded decision repair limit");
    const candidates = await this.listMissingDecisionCandidates(runId, limit);
    let repaired = 0;
    let failed = 0;
    const client = await this.pool.connect();
    try {
      for (const candidate of candidates) {
        try {
          await client.query("BEGIN");
          await this.captureMissingDecisionInTransaction(
            client as unknown as FundedEvidenceQueryable,
            runId,
            candidate.observationId,
          );
          await client.query("COMMIT");
          repaired += 1;
        } catch {
          await client.query("ROLLBACK").catch(() => {});
          failed += 1;
        }
      }
    } finally {
      client.release();
    }
    const remaining = await this.decisionGapCount(runId);
    return { repaired, failed, remaining };
  }

  /**
   * Oldest-first distinct missing-decision candidates, bounded by `limit`.
   * Parallel backing sources for one opportunity collapse to one candidate.
   */
  async listMissingDecisionCandidates(
    runId: string,
    limit: number,
  ): Promise<{ runId: string; observationId: string }[]> {
    const { rows } = await this.pool.query<{
      run_id: string;
      observation_id: string;
    }>(
      `${MISSING_DECISION_WORK}
       SELECT run_id,observation_id FROM candidates
        ORDER BY at,observation_id
        LIMIT $2`,
      [runId, limit],
    );
    return rows.map((row) => ({
      runId: row.run_id,
      observationId: row.observation_id,
    }));
  }

  /** Durable count of missing decisions, one per distinct opportunity. */
  async decisionGapCount(runId: string): Promise<number> {
    const { rows } = await this.pool.query<{ count: number }>(
      `${MISSING_DECISION_WORK} SELECT count(*)::int AS count FROM candidates`,
      [runId],
    );
    return Number(rows[0]?.count ?? 0);
  }

  private async lockFundedRun(
    client: FundedEvidenceQueryable,
    runId: string,
  ): Promise<void> {
    // Same lock order as the funded order service and inbox enqueue: the
    // paper_bot_run row is the funded-run lock.
    const locked = await client.query(
      "SELECT id FROM paper_bot_run WHERE id=$1 FOR UPDATE",
      [runId],
    );
    if (!locked.rows.length) throw new Error("Funded decision run not found");
  }

  private async assertOwnership(
    client: FundedEvidenceQueryable,
    decision: FundedDecisionTimeInput,
  ): Promise<void> {
    const owned = await client.query<{
      bot_market: string;
      account_id: string;
      currency: string;
    }>(
      `SELECT r.market_id AS bot_market,f.account_id,f.currency
       FROM paper_bot_run r JOIN paper_funded_run f ON f.run_id=r.id
       WHERE r.id=$1`,
      [decision.runId],
    );
    const row = owned.rows[0];
    if (!row) throw new Error("Funded decision run has no funded binding");
    if (
      row.bot_market !== decision.marketId ||
      row.currency !== decision.currency ||
      row.account_id !== decision.accountId
    )
      throw new Error(
        "Funded decision ownership does not match the funded run binding",
      );
    const observation = await client.query(
      "SELECT 1 FROM paper_signal_observation WHERE run_id=$1 AND id=$2",
      [decision.runId, decision.observationId],
    );
    if (!observation.rows.length)
      throw new Error(
        "Funded decision observation ownership does not match the funded run",
      );
  }

  private async nextDecisionSequence(
    client: FundedEvidenceQueryable,
    runId: string,
  ): Promise<number> {
    const { rows } = await client.query<{ next: number | null }>(
      "SELECT COALESCE(MAX(sequence),0)+1 AS next FROM funded_decision_evidence WHERE run_id=$1",
      [runId],
    );
    return rows[0]?.next ?? 1;
  }

  async appendOutcomeVersion(
    draft: OutcomeVersionDraft,
  ): Promise<PersistedOutcomeVersion> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await this.appendOutcomeVersionInTransaction(
        client as unknown as FundedEvidenceQueryable,
        draft,
      );
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async appendOutcomeVersionInTransaction(
    client: FundedEvidenceQueryable,
    draft: OutcomeVersionDraft,
  ): Promise<PersistedOutcomeVersion> {
    const status = fundedOutcomeStatusSchema.parse(draft.status);
    const sourceKind = fundedSourceKindSchema.parse(draft.sourceKind);
    if (!Number.isFinite(Date.parse(draft.availableAt)))
      throw new Error("Invalid funded outcome availability time");
    if (status === "UNRESOLVED" && !draft.reason)
      throw new Error("UNRESOLVED funded outcomes require an explicit reason");
    if (draft.detail !== null) {
      const detail = fundedOutcomeDetailSchema.safeParse({
        status,
        detail: draft.detail,
      });
      if (!detail.success)
        throw new Error("Funded outcome detail does not match its status");
    }
    const decision = await client.query<DecisionRow>(
      `${DECISION_SELECT} WHERE run_id=$1 AND observation_id=$2`,
      [draft.runId, draft.observationId],
    );
    const decisionRow = decision.rows[0];
    if (!decisionRow)
      throw new Error("No funded decision exists for this outcome");
    await this.lockFundedRun(client, draft.runId);

    const sourceDigest = outcomeSourceDigest({
      sourceKind,
      sourceId: draft.sourceId,
      status,
      availableAt: draft.availableAt,
      reason: draft.reason,
      detail: draft.detail,
      supersedesSequence: draft.supersedesSequence,
    });
    if (
      draft.expectedSourceDigest !== undefined &&
      draft.expectedSourceDigest !== sourceDigest
    )
      throw new Error("Funded outcome source digest mismatch");

    const existing = await client.query<OutcomeRow>(
      `${OUTCOME_SELECT}
       WHERE o.run_id=$1 AND o.observation_id=$2 AND o.source_kind=$3 AND o.source_id=$4`,
      [draft.runId, draft.observationId, sourceKind, draft.sourceId],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].source_digest !== sourceDigest)
        throw new Error("Conflicting funded outcome source retry");
      // The causal fact is immutable with the version: a retry may repeat it,
      // but it may never attach one to an existing version or replace it.
      if (
        draft.sourceFactId !== undefined &&
        draft.sourceFactId !== null &&
        existing.rows[0].source_fact_id !== draft.sourceFactId
      )
        throw new Error("Conflicting funded outcome source retry");
      return persistedOutcome(existing.rows[0]);
    }

    if (draft.supersedesSequence !== null) {
      const superseded = await client.query(
        "SELECT 1 FROM funded_decision_outcome WHERE run_id=$1 AND observation_id=$2 AND sequence=$3",
        [draft.runId, draft.observationId, draft.supersedesSequence],
      );
      if (!superseded.rows.length)
        throw new Error(
          "Funded outcome correction supersedes an unknown version",
        );
    }
    const sequences = await client.query<{ next: number | null }>(
      "SELECT COALESCE(MAX(sequence),0)+1 AS next FROM funded_decision_outcome WHERE run_id=$1 AND observation_id=$2",
      [draft.runId, draft.observationId],
    );
    const sequence = sequences.rows[0]?.next ?? 1;
    await client.query(
      `INSERT INTO funded_decision_outcome(
         run_id,observation_id,sequence,status,source_kind,source_id,
         source_digest,available_at,supersedes_sequence,reason,detail,source_fact_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)`,
      [
        draft.runId,
        draft.observationId,
        sequence,
        status,
        sourceKind,
        draft.sourceId,
        sourceDigest,
        draft.availableAt,
        draft.supersedesSequence,
        draft.reason,
        draft.detail === null ? null : JSON.stringify(draft.detail),
        draft.sourceFactId ?? null,
      ],
    );
    const stored = await client.query<OutcomeRow>(
      `${OUTCOME_SELECT}
       WHERE o.run_id=$1 AND o.observation_id=$2 AND o.source_kind=$3 AND o.source_id=$4`,
      [draft.runId, draft.observationId, sourceKind, draft.sourceId],
    );
    const row = stored.rows[0];
    if (!row) throw new Error("Funded outcome version was not persisted");
    fundedOutcomeVersionSchema.parse({
      identity: outcomeIdentity(row),
      sequence: row.sequence,
      status: row.status,
      availableAt: iso(row.available_at),
      recordedAt: iso(row.recorded_at),
      sourceKind: row.source_kind,
      sourceId: row.source_id,
      sourceDigest: row.source_digest,
      reason: row.reason,
      detail: row.detail,
      supersedesSequence: row.supersedes_sequence,
    });
    return persistedOutcome(row);
  }

  async listOutcomeVersions(input: {
    runId: string;
    observationId: string;
  }): Promise<PersistedOutcomeVersion[]> {
    const { rows } = await this.pool.query<OutcomeRow>(
      `${OUTCOME_SELECT} WHERE o.run_id=$1 AND o.observation_id=$2 ORDER BY o.sequence`,
      [input.runId, input.observationId],
    );
    return rows.map(persistedOutcome);
  }

  async findDecision(
    runId: string,
    observationId: string,
  ): Promise<DecisionRow | undefined> {
    const { rows } = await this.pool.query<DecisionRow>(
      `${DECISION_SELECT} WHERE run_id=$1 AND observation_id=$2`,
      [runId, observationId],
    );
    return rows[0];
  }

  /**
   * Decisions whose durable sources are not fully represented yet, oldest
   * first. Re-projecting a returned decision is always safe: appends are
   * idempotent per durable source identity and additional later sources append
   * new versions.
   */
  async listProjectionCandidates(
    runId: string,
    limit: number,
  ): Promise<{ runId: string; observationId: string }[]> {
    const { rows } = await this.pool.query<{
      run_id: string;
      observation_id: string;
    }>(
      `${PROJECTION_WORK_BODY} SELECT run_id,observation_id FROM missing ORDER BY sequence LIMIT $2`,
      [runId, limit],
    );
    return rows.map((row) => ({
      runId: row.run_id,
      observationId: row.observation_id,
    }));
  }

  /** Durable count of decisions whose durable sources are unrepresented. */
  async projectionGapCount(runId: string): Promise<number> {
    const { rows } = await this.pool.query<{ count: number }>(
      `${PROJECTION_WORK_BODY} SELECT count(*)::int AS count FROM missing`,
      [runId],
    );
    return Number(rows[0]?.count ?? 0);
  }
}
