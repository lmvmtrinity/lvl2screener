import type { MarketId } from "@tsx-scanner/contracts";
import type { Pool } from "pg";
import { contentHash } from "./research-coverage.js";

export type SignalModelSourceScope = {
  runId: string;
  marketId: MarketId;
  strategy: string;
  strategyVersion: string;
  configVersion: string;
  profileId: string;
  profileName: string;
  executionModelVersion: string;
  executionAssumptionsHash: string;
};

export type CanonicalSignalOpportunityCapture = SignalModelSourceScope & {
  signalSemanticsVersion: string | null;
  sourceRunId: string;
  replayId: string;
  evidenceId: string;
  opportunityId: string;
  stage: "TRAIN" | "VALIDATION" | "TEST";
  sessionDate: string;
  symbol: string;
  instrumentId: string;
  baselineSelected: boolean;
  predictionInput: {
    marketId: MarketId;
    strategy: string;
    timestamp: string;
    deterministicScore: number;
    atrPct: number | null;
    rvolAtTime: number | null;
  };
  /** Exact persisted decision-time featureSnapshot; no reconstructed inputs. */
  sourceFeatures: Record<string, unknown>;
  outcome:
    | {
        status: "CLOSED";
        entryTime: string;
        exitTime: string;
        entryPrice: number;
        exitPrice: number;
        shares: number;
        netPnl: number;
        rMultiple: number;
      }
    | { status: "NO_FILL"; reason: string }
    | { status: "INVALID"; reason: string }
    | null;
  labelAvailableAt: string | null;
};

type SignalModelSourceInspection =
  | {
      status: "AVAILABLE";
      reasonCodes: [];
      missingFields: [];
      orderedCaptures: CanonicalSignalOpportunityCapture[];
    }
  | {
      status: "UNAVAILABLE";
      reasonCodes: string[];
      missingFields: string[];
    };

export type SignalModelSourcePreflight =
  | {
      status: "AVAILABLE";
      reasonCodes: [];
      missingFields: [];
      sourceRunIdentity: {
        runId: string;
        status: string;
        marketId: MarketId;
        strategyVersion: string;
        configVersion: string;
        executionModelVersion: string;
        executionAssumptionsHash: string;
      };
      /** Verified research_evidence_binding.input_hash. */
      sourceDigest: string;
      /** Hash of the exact immutable owner binding identity and payload. */
      sourceBindingHash: string;
      orderedMembershipHash: string;
      orderedMembershipCount: number;
      testMembershipHash: string;
      testOpportunityIds: string[];
      testOutcomesReleased: boolean;
      orderedCaptures: CanonicalSignalOpportunityCapture[];
    }
  | {
      status: "UNAVAILABLE";
      reasonCodes: string[];
      missingFields: string[];
    };

export type RetainedBacktestSourcePreflight = {
  status: "UNAVAILABLE";
  runId: string;
  marketId: MarketId;
  strategyVersion: string;
  configVersion: string;
  executionModelVersion: string | null;
  executionAssumptions: unknown;
  coverageStatus: "VERIFIED" | "MISSING";
  lineageStatus: "VERIFIED" | "UNVERIFIED";
  closedTradeRows: number;
  stateEventRows: number;
  canonicalOpportunityCaptureTablePresent: boolean;
  reasonCodes: string[];
  missingFields: string[];
};

export type CanonicalFinalTestClaimRequest = {
  claimId: string;
  sourceRunId: string;
  marketId: MarketId;
  membershipHash: string;
};

export interface CanonicalFinalTestClaimVerifier {
  consumeFinalTestClaim(
    request: CanonicalFinalTestClaimRequest,
  ): Promise<CanonicalFinalTestClaimRequest | null>;
}

/** Reads only prospective immutable captures whose completed run still has an
 * exact verified coverage binding. The caller supplies frozen session stages;
 * stage is deliberately not inferred or persisted on the source row. */
export class PostgresCanonicalSignalOpportunityCaptureRepository {
  constructor(
    private readonly pool: Pool,
    private readonly finalTestGate?: CanonicalFinalTestClaimVerifier,
  ) {}

  async loadForSource(input: {
    scope: SignalModelSourceScope;
    expectedSessions: Record<
      "TRAIN" | "VALIDATION" | "TEST",
      readonly string[]
    >;
  }): Promise<SignalModelSourcePreflight> {
    return this.loadForSourceInternal(input, false);
  }

  /** TEST outcomes are only re-read after the exact one-use final-test claim
   * has been consumed. The receipt and source hashes are compared across both
   * reads so the released labels cannot drift from frozen membership. */
  async loadTestAfterClaim(input: {
    scope: SignalModelSourceScope;
    expectedSessions: Record<
      "TRAIN" | "VALIDATION" | "TEST",
      readonly string[]
    >;
    claimId: string;
    expectedTestMembershipHash: string;
  }): Promise<SignalModelSourcePreflight> {
    const metadata = await this.loadForSourceInternal(input, false);
    if (metadata.status !== "AVAILABLE") return metadata;
    if (!this.finalTestGate)
      return unavailable("FINAL_TEST_CLAIM_VERIFIER_UNAVAILABLE");
    if (metadata.testMembershipHash !== input.expectedTestMembershipHash)
      return unavailable("FINAL_TEST_MEMBERSHIP_HASH_MISMATCH");
    const request: CanonicalFinalTestClaimRequest = {
      claimId: input.claimId,
      sourceRunId: input.scope.runId,
      marketId: input.scope.marketId,
      membershipHash: metadata.testMembershipHash,
    };
    const consumed = await this.finalTestGate.consumeFinalTestClaim(request);
    if (
      !consumed ||
      consumed.claimId !== request.claimId ||
      consumed.sourceRunId !== request.sourceRunId ||
      consumed.marketId !== request.marketId ||
      consumed.membershipHash !== request.membershipHash
    )
      return unavailable("FINAL_TEST_CLAIM_INVALID");
    const released = await this.loadForSourceInternal(input, true);
    if (
      released.status !== "AVAILABLE" ||
      released.orderedMembershipHash !== metadata.orderedMembershipHash ||
      released.sourceBindingHash !== metadata.sourceBindingHash ||
      released.testMembershipHash !== metadata.testMembershipHash
    )
      return unavailable("FINAL_TEST_SOURCE_CHANGED_AFTER_CLAIM");
    return released;
  }

  private async loadForSourceInternal(
    input: {
      scope: SignalModelSourceScope;
      expectedSessions: Record<
        "TRAIN" | "VALIDATION" | "TEST",
        readonly string[]
      >;
    },
    releaseTestOutcomes: boolean,
  ): Promise<SignalModelSourcePreflight> {
    const client = await this.pool.connect();
    try {
      await client.query(
        "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      const run = await client.query<{
        status: string;
        market_id: MarketId;
        strategy_version: string;
        config_version: string;
        execution_model_version: string;
        execution_assumptions: unknown;
        metrics: { observations?: number } | null;
        lineage_verified: boolean;
        research_input_hash: string | null;
        research_manifest_hash: string | null;
        coverage_report_hash: string | null;
        binding_payload: unknown;
      }>(
        `SELECT r.status,r.market_id,r.strategy_version,r.config_version,
                r.execution_model_version,r.execution_assumptions,r.metrics,
                EXISTS (
                  SELECT 1 FROM research_evidence_binding b
                  JOIN research_coverage_report cr
                    ON cr.hash=b.coverage_report_hash AND cr.market_id=b.market_id AND cr.status='VERIFIED'
                  WHERE b.owner_kind='BACKTEST' AND b.owner_id=r.id
                    AND b.market_id=r.market_id
                    AND b.input_hash=r.research_evidence->>'inputHash'
                ) AS lineage_verified,
                (SELECT b.input_hash FROM research_evidence_binding b
                  WHERE b.owner_kind='BACKTEST' AND b.owner_id=r.id) AS research_input_hash,
                (SELECT b.manifest_hash FROM research_evidence_binding b
                  WHERE b.owner_kind='BACKTEST' AND b.owner_id=r.id) AS research_manifest_hash,
                (SELECT b.coverage_report_hash FROM research_evidence_binding b
                  WHERE b.owner_kind='BACKTEST' AND b.owner_id=r.id) AS coverage_report_hash,
                (SELECT b.binding FROM research_evidence_binding b
                  WHERE b.owner_kind='BACKTEST' AND b.owner_id=r.id) AS binding_payload
           FROM backtest_run r WHERE r.id=$1`,
        [input.scope.runId],
      );
      const row = run.rows[0];
      if (!row) {
        await client.query("COMMIT");
        return {
          status: "UNAVAILABLE",
          reasonCodes: ["SOURCE_RUN_NOT_FOUND"],
          missingFields: [],
        };
      }
      const receipt = await client.query<{
        market_id: MarketId;
        expected_count: number;
        membership_hash: string;
        execution_model_version: string;
        execution_assumptions_hash: string;
      }>(
        `SELECT market_id,expected_count,membership_hash,execution_model_version,execution_assumptions_hash
           FROM backtest_opportunity_capture_receipt WHERE source_run_id=$1`,
        [input.scope.runId],
      );
      const captures = await client.query<{
        capture_ordinal: number;
        market_id: MarketId;
        strategy_name: string;
        strategy_version: string;
        config_version: string;
        profile_id: string;
        profile_name: string;
        execution_model_version: string;
        execution_assumptions_hash: string;
        signal_semantics_version: string | null;
        replay_id: string;
        evidence_id: string;
        opportunity_id: string;
        session_date: string;
        symbol: string;
        instrument_id: string;
        baseline_selected: boolean;
        score: number;
        prediction_features: Record<string, unknown> & {
          atrPct: number | null;
          rvolAtTime: number | null;
        };
        outcome: CanonicalSignalOpportunityCapture["outcome"];
        decision_timestamp: Date;
        label_available_at: Date | null;
        capture_hash: string;
      }>(
        `SELECT market_id,strategy_name,strategy_version,config_version,
                profile_id,profile_name,execution_model_version,execution_assumptions_hash,signal_semantics_version,
                replay_id,evidence_id,opportunity_id,session_date::text,symbol,instrument_id,
                baseline_selected,score,prediction_features,outcome,decision_timestamp,label_available_at,capture_hash,capture_ordinal
           FROM backtest_opportunity_capture
          WHERE source_run_id=$1
          ORDER BY capture_ordinal`,
        [input.scope.runId],
      );
      await client.query("COMMIT");
      const assumptionsHash = contentHash(row.execution_assumptions);
      const receiptRow = receipt.rows[0];
      if (!row.lineage_verified) return unavailable("LINEAGE_UNVERIFIED");
      if (!receiptRow)
        return unavailable("CANONICAL_CAPTURE_RECEIPT_UNAVAILABLE");
      if (
        receiptRow.market_id !== row.market_id ||
        receiptRow.execution_model_version !== row.execution_model_version ||
        receiptRow.execution_assumptions_hash !== assumptionsHash ||
        receiptRow.expected_count !== captures.rows.length ||
        receiptRow.expected_count !== row.metrics?.observations
      )
        return unavailable("CANONICAL_CAPTURE_MEMBERSHIP_INCOMPLETE");
      const captureIdentities = captures.rows.map((capture) => {
        const value = {
          runId: input.scope.runId,
          marketId: capture.market_id,
          strategy: capture.strategy_name,
          strategyVersion: capture.strategy_version,
          configVersion: capture.config_version,
          profileId: capture.profile_id,
          profileName: capture.profile_name,
          executionModelVersion: capture.execution_model_version,
          executionAssumptionsHash: capture.execution_assumptions_hash,
          ...(capture.signal_semantics_version
            ? { signalSemanticsVersion: capture.signal_semantics_version }
            : {}),
          replayId: capture.replay_id,
          evidenceId: capture.evidence_id,
          opportunityId: capture.opportunity_id,
          sessionDate: capture.session_date,
          symbol: capture.symbol,
          instrumentId: capture.instrument_id,
          baselineSelected: capture.baseline_selected,
          decisionTimestamp: capture.decision_timestamp.toISOString(),
          score: capture.score,
          features: capture.prediction_features,
          outcome: capture.outcome,
          labelAvailableAt: capture.label_available_at?.toISOString() ?? null,
        };
        return { capture, value, hash: contentHash(value) };
      });
      if (
        captureIdentities.some(
          (item, index) => item.capture.capture_ordinal !== index,
        )
      )
        return unavailable("CANONICAL_CAPTURE_ORDER_INCOMPLETE");
      if (
        captureIdentities.some(
          (item) => item.hash !== item.capture.capture_hash,
        )
      )
        return unavailable("CANONICAL_CAPTURE_ROW_DIGEST_MISMATCH");
      const membershipHash = contentHash(
        captureIdentities.map(({ capture, hash }) => ({
          opportunityId: capture.opportunity_id,
          evidenceId: capture.evidence_id,
          captureHash: hash,
        })),
      );
      if (membershipHash !== receiptRow.membership_hash)
        return unavailable("CANONICAL_CAPTURE_MEMBERSHIP_DIGEST_MISMATCH");
      const actualScope: SignalModelSourceScope = {
        ...input.scope,
        marketId: row.market_id,
        strategyVersion: row.strategy_version,
        configVersion: row.config_version,
        executionModelVersion: row.execution_model_version,
        executionAssumptionsHash: assumptionsHash,
      };
      const scopedCaptures = captureIdentities.filter(({ capture }) =>
        sameScope(input.scope, {
          runId: input.scope.runId,
          marketId: capture.market_id,
          strategy: capture.strategy_name,
          strategyVersion: capture.strategy_version,
          configVersion: capture.config_version,
          profileId: capture.profile_id,
          profileName: capture.profile_name,
          executionModelVersion: capture.execution_model_version,
          executionAssumptionsHash: capture.execution_assumptions_hash,
        }),
      );
      const stageFor = (sessionDate: string) => {
        const matches = (["TRAIN", "VALIDATION", "TEST"] as const).filter(
          (stage) => input.expectedSessions[stage].includes(sessionDate),
        );
        if (matches.length !== 1)
          throw new Error("CANONICAL_CAPTURE_SESSION_STAGE_UNAVAILABLE");
        return matches[0]!;
      };
      const inspected = inspectSignalModelSource({
        scope: input.scope,
        run: { ...actualScope, status: row.status },
        coverageStatus: row.lineage_verified ? "VERIFIED" : "MISSING",
        lineageStatus: row.lineage_verified ? "VERIFIED" : "UNVERIFIED",
        expectedSessions: input.expectedSessions,
        captures: scopedCaptures.map(({ capture }) => {
          const stage = stageFor(capture.session_date);
          const hideTestOutcome = stage === "TEST" && !releaseTestOutcomes;
          return {
            ...input.scope,
            runId: input.scope.runId,
            sourceRunId: input.scope.runId,
            replayId: capture.replay_id,
            evidenceId: capture.evidence_id,
            opportunityId: capture.opportunity_id,
            stage,
            sessionDate: capture.session_date,
            symbol: capture.symbol,
            instrumentId: capture.instrument_id,
            baselineSelected: capture.baseline_selected,
            predictionInput: {
              marketId: capture.market_id,
              strategy: capture.strategy_name,
              timestamp: capture.decision_timestamp.toISOString(),
              deterministicScore: capture.score,
              atrPct: capture.prediction_features.atrPct,
              rvolAtTime: capture.prediction_features.rvolAtTime,
            },
            sourceFeatures: capture.prediction_features,
            signalSemanticsVersion: capture.signal_semantics_version,
            outcome: hideTestOutcome ? null : capture.outcome,
            labelAvailableAt: hideTestOutcome
              ? null
              : (capture.label_available_at?.toISOString() ?? null),
          };
        }),
      });
      if (inspected.status !== "AVAILABLE") return inspected;
      if (
        !row.research_input_hash ||
        !row.research_manifest_hash ||
        !row.coverage_report_hash
      )
        return unavailable("SOURCE_BINDING_IDENTITY_UNAVAILABLE");
      return {
        ...inspected,
        sourceRunIdentity: {
          runId: input.scope.runId,
          status: row.status,
          marketId: row.market_id,
          strategyVersion: row.strategy_version,
          configVersion: row.config_version,
          executionModelVersion: row.execution_model_version,
          executionAssumptionsHash: assumptionsHash,
        },
        sourceDigest: row.research_input_hash,
        sourceBindingHash: contentHash({
          ownerKind: "BACKTEST",
          ownerId: input.scope.runId,
          marketId: row.market_id,
          manifestHash: row.research_manifest_hash,
          coverageReportHash: row.coverage_report_hash,
          inputHash: row.research_input_hash,
          binding: row.binding_payload,
        }),
        orderedMembershipHash: receiptRow.membership_hash,
        orderedMembershipCount: receiptRow.expected_count,
        testMembershipHash: contentHash({
          sourceRunId: input.scope.runId,
          marketId: row.market_id,
          sessionDates: [...input.expectedSessions.TEST],
          opportunityIds: inspected.orderedCaptures
            .filter((capture) => capture.stage === "TEST")
            .map((capture) => capture.opportunityId),
        }),
        testOpportunityIds: inspected.orderedCaptures
          .filter((capture) => capture.stage === "TEST")
          .map((capture) => capture.opportunityId),
        testOutcomesReleased: releaseTestOutcomes,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

const REQUIRED_CAPTURE_FIELDS = [
  "canonical opportunity membership",
  "decision-time profile id and name",
  "decision-time ATR and RVOL features",
  "baseline-selected flag and stable opportunity id",
  "authoritative CLOSED/NO_FILL/INVALID outcome and evidence identity",
] as const;

function unavailable(reason: string): SignalModelSourcePreflight {
  return {
    status: "UNAVAILABLE",
    reasonCodes: [reason],
    missingFields: [],
  };
}

/**
 * Read-only inventory of retained backtest evidence. This legacy inventory
 * endpoint does not accept the frozen source scope needed to resolve canonical
 * opportunity rows; use PostgresCanonicalSignalOpportunityCaptureRepository
 * for that stage-scoped read.
 */
export class PostgresSignalModelSourcePreflight {
  constructor(private readonly pool: Pool) {}

  async inspect(
    runId: string,
  ): Promise<RetainedBacktestSourcePreflight | null> {
    const client = await this.pool.connect();
    try {
      await client.query(
        "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      const result = await client.query<{
        market_id: MarketId;
        strategy_version: string;
        config_version: string;
        execution_model_version: string | null;
        execution_assumptions: unknown;
        trade_count: string;
        event_count: string;
        capture_table: string | null;
        coverage_status: string | null;
        binding_market: MarketId | null;
        binding_input_hash: string | null;
        run_input_hash: string | null;
      }>(
        `SELECT r.market_id,r.strategy_version,r.config_version,
                r.execution_model_version,r.execution_assumptions,
                (SELECT count(*)::text FROM backtest_trade t WHERE t.run_id=r.id) AS trade_count,
                (SELECT count(*)::text FROM backtest_state_event e WHERE e.run_id=r.id) AS event_count,
                to_regclass('public.backtest_opportunity_capture')::text AS capture_table,
                cr.status AS coverage_status,b.market_id AS binding_market,
                b.input_hash AS binding_input_hash,
                r.research_evidence->>'inputHash' AS run_input_hash
           FROM backtest_run r
           LEFT JOIN research_evidence_binding b
             ON b.owner_kind='BACKTEST' AND b.owner_id=r.id
           LEFT JOIN research_coverage_report cr
             ON cr.hash=b.coverage_report_hash AND cr.market_id=b.market_id
          WHERE r.id=$1`,
        [runId],
      );
      const row = result.rows[0];
      await client.query("COMMIT");
      if (!row) return null;
      const coverageStatus =
        row.coverage_status === "VERIFIED" ? "VERIFIED" : "MISSING";
      const lineageStatus =
        row.binding_market === row.market_id &&
        row.binding_input_hash !== null &&
        row.binding_input_hash === row.run_input_hash &&
        coverageStatus === "VERIFIED"
          ? "VERIFIED"
          : "UNVERIFIED";
      const capturePresent = row.capture_table !== null;
      return {
        status: "UNAVAILABLE",
        runId,
        marketId: row.market_id,
        strategyVersion: row.strategy_version,
        configVersion: row.config_version,
        executionModelVersion: row.execution_model_version,
        executionAssumptions: row.execution_assumptions,
        coverageStatus,
        lineageStatus,
        closedTradeRows: Number(row.trade_count),
        stateEventRows: Number(row.event_count),
        canonicalOpportunityCaptureTablePresent: capturePresent,
        reasonCodes: [
          ...(lineageStatus === "VERIFIED" ? [] : ["LINEAGE_UNVERIFIED"]),
          ...(capturePresent
            ? ["CANONICAL_SOURCE_SCOPE_REQUIRED"]
            : ["CANONICAL_OPPORTUNITY_CAPTURE_UNAVAILABLE"]),
        ],
        missingFields: [...REQUIRED_CAPTURE_FIELDS],
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

export function inspectSignalModelSource(input: {
  scope: SignalModelSourceScope;
  run: SignalModelSourceScope & { status: string };
  coverageStatus: "VERIFIED" | "MISSING";
  lineageStatus: "VERIFIED" | "UNVERIFIED";
  captures: readonly CanonicalSignalOpportunityCapture[];
  expectedSessions: Record<"TRAIN" | "VALIDATION" | "TEST", readonly string[]>;
}): SignalModelSourceInspection {
  const reasons = new Set<string>();
  const missing = new Set<string>();
  if (input.run.status !== "COMPLETED") reasons.add("SOURCE_RUN_NOT_COMPLETED");
  if (!sameScope(input.scope, input.run)) reasons.add("SOURCE_SCOPE_MISMATCH");
  if (input.coverageStatus !== "VERIFIED") reasons.add("COVERAGE_UNVERIFIED");
  if (input.lineageStatus !== "VERIFIED") reasons.add("LINEAGE_UNVERIFIED");
  if (!input.captures.length) {
    reasons.add("CANONICAL_OPPORTUNITY_CAPTURE_UNAVAILABLE");
    REQUIRED_CAPTURE_FIELDS.forEach((field) => missing.add(field));
  }

  const seenOpportunityIds = new Set<string>();
  const seenEvidenceIds = new Set<string>();
  const captures = [...input.captures];
  for (const row of captures) {
    if (
      row.sourceRunId !== input.scope.runId ||
      row.runId !== input.scope.runId ||
      !sameScope(input.scope, row)
    )
      reasons.add("SOURCE_SCOPE_MISMATCH");
    if (!row.opportunityId || seenOpportunityIds.has(row.opportunityId))
      reasons.add("DUPLICATE_OPPORTUNITY_ID");
    seenOpportunityIds.add(row.opportunityId);
    if (!row.evidenceId || seenEvidenceIds.has(row.evidenceId))
      reasons.add("DUPLICATE_REPLAY_EVIDENCE");
    seenEvidenceIds.add(row.evidenceId);
    if (!row.replayId) reasons.add("REPLAY_IDENTITY_MISSING");
    if (
      !row.predictionInput ||
      row.predictionInput.atrPct === null ||
      row.predictionInput.rvolAtTime === null
    ) {
      reasons.add("PREDICTION_FEATURES_MISSING");
      if (row.predictionInput?.atrPct == null)
        missing.add("predictionInput.atrPct");
      if (row.predictionInput?.rvolAtTime == null)
        missing.add("predictionInput.rvolAtTime");
    }
    if (
      row.predictionInput?.marketId !== input.scope.marketId ||
      row.predictionInput?.strategy !== input.scope.strategy
    )
      reasons.add("PREDICTION_SCOPE_MISMATCH");
    if (
      row.baselineSelected &&
      (!Number.isInteger(row.predictionInput?.deterministicScore) ||
        !Number.isFinite(Date.parse(row.predictionInput?.timestamp ?? "")))
    )
      reasons.add("OPPORTUNITY_CAPTURE_INCOMPLETE");
    if (row.outcome === null) {
      if (row.stage !== "TEST") reasons.add("OUTCOME_LABEL_UNAVAILABLE");
    } else {
      if (
        row.outcome.status === "CLOSED" &&
        (!Number.isFinite(row.outcome.netPnl) ||
          !Number.isFinite(row.outcome.rMultiple) ||
          !Number.isFinite(row.outcome.entryPrice) ||
          !Number.isFinite(row.outcome.exitPrice) ||
          !Number.isFinite(row.outcome.shares))
      )
        reasons.add("CLOSED_OUTCOME_LABEL_MISSING");
      if (
        row.outcome.status !== "CLOSED" &&
        (!row.outcome.reason || !row.evidenceId)
      )
        reasons.add("NON_CLOSED_OUTCOME_EVIDENCE_MISSING");
    }
    checkSessionPartition(row, input.expectedSessions, reasons);
    checkLabelChronology(row, input.expectedSessions, reasons);
  }

  const orderedCaptures = captures.sort(
    (a, b) =>
      a.sessionDate.localeCompare(b.sessionDate) ||
      a.predictionInput.timestamp.localeCompare(b.predictionInput.timestamp) ||
      a.profileId.localeCompare(b.profileId) ||
      a.opportunityId.localeCompare(b.opportunityId),
  );
  if (reasons.size) {
    return {
      status: "UNAVAILABLE",
      reasonCodes: [...reasons].sort(),
      missingFields: [...missing].sort(),
    };
  }
  return {
    status: "AVAILABLE",
    reasonCodes: [],
    missingFields: [],
    orderedCaptures,
  };
}

function sameScope(
  expected: SignalModelSourceScope,
  actual: SignalModelSourceScope,
): boolean {
  return (
    expected.runId === actual.runId &&
    expected.marketId === actual.marketId &&
    expected.strategy === actual.strategy &&
    expected.strategyVersion === actual.strategyVersion &&
    expected.configVersion === actual.configVersion &&
    expected.profileId === actual.profileId &&
    expected.profileName === actual.profileName &&
    expected.executionModelVersion === actual.executionModelVersion &&
    expected.executionAssumptionsHash === actual.executionAssumptionsHash
  );
}

function checkSessionPartition(
  row: CanonicalSignalOpportunityCapture,
  expected: Record<"TRAIN" | "VALIDATION" | "TEST", readonly string[]>,
  reasons: Set<string>,
): void {
  const stageSessions = expected[row.stage];
  if (!stageSessions?.includes(row.sessionDate))
    reasons.add("SESSION_MEMBERSHIP_MISMATCH");
  for (const stage of ["TRAIN", "VALIDATION", "TEST"] as const) {
    const sessions = expected[stage];
    if (
      sessions.some(
        (date, index) =>
          !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
          (index > 0 && sessions[index - 1]! >= date),
      ) ||
      new Set(sessions).size !== sessions.length
    )
      reasons.add("CHRONOLOGICAL_PARTITION_INVALID");
  }
  const train = expected.TRAIN;
  const validation = expected.VALIDATION;
  const test = expected.TEST;
  if (
    !train.length ||
    !validation.length ||
    !test.length ||
    train.at(-1)! >= validation[0]! ||
    validation.at(-1)! >= test[0]!
  )
    reasons.add("CHRONOLOGICAL_PARTITION_INVALID");
}

function checkLabelChronology(
  row: CanonicalSignalOpportunityCapture,
  expected: Record<"TRAIN" | "VALIDATION" | "TEST", readonly string[]>,
  reasons: Set<string>,
): void {
  if (row.stage === "TEST" && row.outcome === null) return;
  const labelTime = row.labelAvailableAt
    ? Date.parse(row.labelAvailableAt)
    : Number.NaN;
  if (!Number.isFinite(labelTime)) {
    reasons.add("OUTCOME_LABEL_TIME_UNPROVEN");
    return;
  }
  const boundary =
    row.stage === "TRAIN"
      ? expected.VALIDATION[0]
      : row.stage === "VALIDATION"
        ? expected.TEST[0]
        : undefined;
  if (boundary && labelTime >= Date.parse(`${boundary}T00:00:00.000Z`))
    reasons.add(
      row.stage === "TRAIN"
        ? "TRAIN_LABEL_CHRONOLOGY_UNPROVEN"
        : "VALIDATION_LABEL_CHRONOLOGY_UNPROVEN",
    );
}
