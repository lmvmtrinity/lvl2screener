import {
  FUNDED_COMPARISON_MARK_AGE_MS,
  fundedComparisonSessionMetricSchema,
  type FundedComparisonFailureReason,
  type FundedComparisonJobPayload,
  type FundedComparisonPolicyEvaluation,
  type FundedComparisonResult,
  type FundedComparisonRunBinding,
  type FundedComparisonSessionMetric,
  type FundedComparisonSide,
  type FundedComparisonSpecification,
  type MarketId,
} from "@tsx-scanner/contracts";
import type { Pool } from "pg";
import {
  FundedComparisonChampionError,
  verifyChallengerBinding,
  verifyChampionBinding,
} from "./funded-comparison-champion.js";
import {
  FundedComparisonRepository,
  FundedComparisonRepositoryError,
  type FundedComparisonSpecificationReceipt,
} from "./funded-comparison-repository.js";
import {
  FundedComparisonSpecificationError,
  type FundedComparisonFrozenSessionIdentity,
} from "./funded-comparison-specification.js";
import {
  fundedComparisonEvaluationMembershipDigest,
  fundedComparisonFailureDigest,
  fundedComparisonMetricDigest,
  fundedComparisonSpecDigest,
} from "./funded-comparison-digest.js";
import {
  loadFundedComparisonSharedInput,
  type FundedComparisonOpportunityItem,
  type FundedComparisonSharedInput,
  type FundedComparisonSharedInputSource,
} from "./funded-comparison-shared-input.js";
import { loadFundedComparisonChallenger } from "./funded-comparison-prediction.js";
import { FundedComparisonChallengerPolicyError } from "./funded-comparison-challenger-policy.js";
import {
  assembleComparisonResult,
  assembleSideMetrics,
  type FundedComparisonMetricDecision,
  type FundedComparisonMetricOrder,
  type FundedComparisonSideMetricSession,
} from "./funded-comparison-metrics.js";
import {
  reconstructComparisonValuation,
  type FundedComparisonSideValuation,
} from "./funded-comparison-valuation.js";
import {
  fundedAccountSummary,
  type FundedLedger,
  type LedgerEvent,
} from "./funded-ledger.js";
import {
  FundedReconstructionUnavailableError,
  reconstructFundedLedgerAt,
} from "./funded-ledger-repository.js";
import { roundTripCosts } from "./financials.js";
import type { PendingEntryOrder } from "./pending-order.js";
import type {
  FundedDecisionContextInput,
  FundedDecisionEvidenceSource,
} from "./funded-decision-capture.js";
import type { QuoteFact } from "./types.js";
import type {
  FundedPairedComparisonInput,
  FundedPairedRunResult,
} from "./funded-paired-runner.js";
import { loadFundedComparisonChampionPolicy } from "./funded-paired-runner.js";
import { CancelledError } from "../worker/research-worker.js";
import { LeaseLostError } from "../research-jobs/research-job-repository.js";

/**
 * FP03 comparison orchestration: load the frozen specification, revalidate its
 * immutable identity and digest, execute only incomplete sides and sessions,
 * reconstruct the union-grid valuation, append the immutable per-side session
 * metrics, assemble the paired artifact and finalize it transactionally.
 *
 * Cancellation and lease loss are durable interruption receipts, never
 * rollbacks: committed comparison evidence and funded economic effects stay
 * exactly as they were. A terminal failure prevents any result.
 */

const SIDES: readonly FundedComparisonSide[] = ["CHAMPION", "CHALLENGER"];
const MICROS = 1_000_000;

export class FundedComparisonServiceError extends Error {
  constructor(
    readonly reason: FundedComparisonFailureReason,
    message: string,
  ) {
    super(message);
    this.name = "FundedComparisonServiceError";
  }
}

export class FundedComparisonIncompleteError extends Error {
  constructor(readonly remainingSessions: readonly string[]) {
    super(
      `Funded comparison sessions remain incomplete: ${remainingSessions.join(", ")}`,
    );
    this.name = "FundedComparisonIncompleteError";
  }
}

export interface FundedComparisonRunContext {
  readonly attemptId: string;
  readonly maxSessions: number;
  readonly betweenSessions?: () => Promise<void>;
  /**
   * The worker handler verifies the payload immediately before it calls
   * `run`, so it may declare that revalidation complete. Standalone callers
   * always receive the full immutable revalidation.
   */
  readonly verification?: "REQUIRED" | "COMPLETED";
}

export interface FundedComparisonRunOutcome {
  readonly specificationId: string;
  readonly result: FundedComparisonResult;
  readonly reused: boolean;
}

export interface FundedComparisonSideSessionEvidence {
  readonly valuation: FundedComparisonSideValuation;
  readonly carryInEquity: number;
  readonly dailyLossLimit: number;
  readonly dailyPnl: number;
  readonly entriesAllowed: boolean;
  readonly openRisk: number;
  readonly grossNotional: number;
  readonly openPositions: number;
  readonly zeroTradeSessions: boolean;
  readonly decisions: readonly FundedComparisonMetricDecision[];
  readonly orders: readonly FundedComparisonMetricOrder[];
}

export interface FundedComparisonSessionEvidence {
  readonly champion: FundedComparisonSideSessionEvidence;
  readonly challenger: FundedComparisonSideSessionEvidence;
}

export interface FundedComparisonSessionEvidenceInput {
  readonly specificationId: string;
  readonly specification: FundedComparisonSpecification;
  readonly sessionDate: string;
  readonly champion: FundedComparisonRunBinding;
  readonly challenger: FundedComparisonRunBinding;
}

export interface FundedComparisonEvidenceSource {
  loadSessionEvidence(
    input: FundedComparisonSessionEvidenceInput,
  ): Promise<FundedComparisonSessionEvidence>;
}

export type FundedComparisonPairedRunner = (
  input: FundedPairedComparisonInput,
  betweenSessions: () => Promise<void>,
) => Promise<FundedPairedRunResult>;

export interface FundedComparisonServiceOptions {
  readonly repository: FundedComparisonRepository;
  readonly pairedRunner: FundedComparisonPairedRunner;
  readonly pool?: Pool;
  /** Test seam; production reconstructs from immutable comparison rows. */
  readonly evidenceSource?: FundedComparisonEvidenceSource;
  /** Test seam; production re-reads persisted champion/challenger identity. */
  readonly verifyImmutableIdentities?: (
    specification: FundedComparisonSpecification,
  ) => Promise<void>;
}

export class FundedComparisonService {
  private readonly repository: FundedComparisonRepository;
  private readonly pairedRunner: FundedComparisonPairedRunner;
  private readonly evidenceSource: FundedComparisonEvidenceSource | undefined;
  private readonly verifyImmutableIdentities: (
    specification: FundedComparisonSpecification,
  ) => Promise<void>;

  constructor(options: FundedComparisonServiceOptions) {
    this.repository = options.repository;
    this.pairedRunner = options.pairedRunner;
    this.evidenceSource = options.evidenceSource;
    if (options.verifyImmutableIdentities)
      this.verifyImmutableIdentities = options.verifyImmutableIdentities;
    else if (options.pool) {
      const pool = options.pool;
      this.verifyImmutableIdentities = (specification) =>
        verifyFrozenComparisonIdentities(pool, specification);
    } else
      this.verifyImmutableIdentities = async () => {
        throw new FundedComparisonServiceError(
          "INTERNAL_ERROR",
          "A comparison service requires a pool or an explicit identity verifier",
        );
      };
  }

  /**
   * Execution-time payload reverification for the worker handler: the payload
   * must name the persisted specification exactly, and the frozen digest,
   * champion/challenger identity, cutoff and shared-input identity are
   * revalidated before any effect.
   */
  async verifyJobSpecification(
    payload: FundedComparisonJobPayload,
  ): Promise<FundedComparisonSpecificationReceipt> {
    const receipt = await this.repository.loadSpecification(
      payload.specificationId,
    );
    if (!receipt)
      throw new FundedComparisonServiceError(
        "RETAINED_INPUT_MISSING",
        `Comparison specification ${payload.specificationId} does not exist`,
      );
    const specification = receipt.specification;
    if (
      payload.comparisonSpecDigest !== specification.comparisonSpecDigest ||
      payload.marketId !== specification.marketId ||
      payload.currency !== specification.currency
    )
      throw new FundedComparisonServiceError(
        "CONFLICTING_RETRY",
        "The job payload does not identify the frozen comparison specification",
      );
    await this.verifySpecification(receipt);
    return receipt;
  }

  /** Full immutable revalidation before any comparison effect. */
  async verifySpecification(
    receipt: FundedComparisonSpecificationReceipt,
  ): Promise<void> {
    const specification = receipt.specification;
    const { comparisonSpecDigest, ...withoutDigest } = specification;
    if (fundedComparisonSpecDigest(withoutDigest) !== comparisonSpecDigest)
      throw new FundedComparisonServiceError(
        "CONFLICTING_RETRY",
        "The frozen comparison specification digest does not match its payload",
      );
    if (
      Date.parse(specification.evidenceCutoffAt) >
      Date.parse(specification.specificationFrozenAt)
    )
      throw new FundedComparisonServiceError(
        "SOURCE_CUTOFF_AFTER_FREEZE",
        "The evidence cutoff follows the specification freeze time",
      );
    await this.verifyImmutableIdentities(specification);
    const source: FundedComparisonSharedInputSource = {
      loadSpecification: (specId) => this.repository.loadSpecification(specId),
      loadSessionChunks: (specId, sessionDate) =>
        this.repository.loadSessionChunks(specId, sessionDate),
    };
    for (const session of receipt.sessions) {
      const frozen = specification.sharedInput.orderedSessions.find(
        (entry) => entry.sessionDate === session.sessionDate,
      );
      if (!frozen || !sameFrozenIdentity(frozen, session))
        throw new FundedComparisonServiceError(
          "RETAINED_INPUT_MISSING",
          `Session ${session.sessionDate} does not match the frozen shared-input identity`,
        );
      const shared = await loadFundedComparisonSharedInput(
        source,
        receipt.specId,
        session.sessionDate,
      );
      if (shared.sessionInputDigest !== frozen.sessionInputDigest)
        throw new FundedComparisonServiceError(
          "RETAINED_INPUT_MISSING",
          `Session ${session.sessionDate} retained input does not reproduce the frozen digest`,
        );
    }
  }

  async run(
    specificationId: string,
    context: FundedComparisonRunContext,
  ): Promise<FundedComparisonRunOutcome> {
    const receipt = await this.repository.loadSpecification(specificationId);
    if (!receipt)
      throw new FundedComparisonServiceError(
        "RETAINED_INPUT_MISSING",
        `Comparison specification ${specificationId} does not exist`,
      );
    const existing = await this.repository.loadResult(specificationId);
    if (existing) return { specificationId, result: existing, reused: true };
    const failures = await this.repository.listFailures(specificationId);
    const terminal = failures.find(
      (failure) => failure.classification === "TERMINAL",
    );
    if (terminal)
      throw new FundedComparisonServiceError(terminal.reason, terminal.detail);

    const hook = context.betweenSessions ?? (async () => {});
    try {
      return await this.runAttempt(receipt, context, hook);
    } catch (error) {
      if (error instanceof CancelledError) {
        await this.recordFailure(
          receipt,
          context.attemptId,
          "CANCELLED",
          "INTERRUPTION",
          error.message,
        ).catch(() => undefined);
        throw error;
      }
      if (error instanceof LeaseLostError) {
        await this.recordFailure(
          receipt,
          context.attemptId,
          "LEASE_LOST",
          "INTERRUPTION",
          error.message,
        ).catch(() => undefined);
        throw error;
      }
      if (error instanceof FundedComparisonIncompleteError) throw error;
      const mapped = mapComparisonFailure(error);
      await this.recordFailure(
        receipt,
        context.attemptId,
        mapped.reason,
        "TERMINAL",
        mapped.detail,
      ).catch(() => undefined);
      throw new FundedComparisonServiceError(mapped.reason, mapped.detail);
    }
  }

  private async runAttempt(
    receipt: FundedComparisonSpecificationReceipt,
    context: FundedComparisonRunContext,
    hook: () => Promise<void>,
  ): Promise<FundedComparisonRunOutcome> {
    const specification = receipt.specification;
    if (context.verification !== "COMPLETED")
      await this.verifySpecification(receipt);

    const frozenDates = specification.sessionMembership.orderedSessionDates;
    const provenSides = await this.provenSides(receipt.specId);
    const proven = (sessionDate: string, side: FundedComparisonSide) =>
      provenSides.get(sessionDate)?.has(side) === true;
    const incomplete = frozenDates.filter(
      (sessionDate) =>
        !proven(sessionDate, "CHAMPION") || !proven(sessionDate, "CHALLENGER"),
    );
    let paired: FundedPairedRunResult | undefined;
    if (incomplete.length > 0)
      paired = await this.pairedRunner(
        { specificationId: receipt.specId, maxSessions: context.maxSessions },
        hook,
      );
    const attempted = new Set(
      (paired?.sessions ?? []).map((session) => session.sessionDate),
    );

    const evidenceBySession = new Map<
      string,
      FundedComparisonSessionEvidence
    >();
    for (const sessionDate of frozenDates) {
      await hook();
      const championBinding = await this.repository.findBinding(
        receipt.specId,
        "CHAMPION",
        sessionDate,
      );
      const challengerBinding = await this.repository.findBinding(
        receipt.specId,
        "CHALLENGER",
        sessionDate,
      );
      const championMissing = !proven(sessionDate, "CHAMPION");
      const challengerMissing = !proven(sessionDate, "CHALLENGER");
      if (championMissing || challengerMissing) {
        if (!championBinding || !challengerBinding) {
          if (attempted.has(sessionDate))
            throw new FundedComparisonServiceError(
              "INCOMPLETE_SESSION",
              `Session ${sessionDate} has no complete side binding after execution`,
            );
          throw new FundedComparisonIncompleteError([sessionDate]);
        }
      }
      if (!championBinding || !challengerBinding)
        throw new FundedComparisonServiceError(
          "INCOMPLETE_SESSION",
          `Session ${sessionDate} has no complete side binding`,
        );
      verifyChampionBinding(specification, championBinding);
      verifyChallengerBinding(specification, challengerBinding);
      const evidence = await this.requireEvidenceSource().loadSessionEvidence({
        specificationId: receipt.specId,
        specification,
        sessionDate,
        champion: championBinding,
        challenger: challengerBinding,
      });
      evidenceBySession.set(sessionDate, evidence);
      if (championMissing) {
        await this.appendSideMetric(
          receipt,
          "CHAMPION",
          sessionDate,
          evidence.champion,
        );
        addProvenSide(provenSides, sessionDate, "CHAMPION");
      }
      if (challengerMissing) {
        await this.appendSideMetric(
          receipt,
          "CHALLENGER",
          sessionDate,
          evidence.challenger,
        );
        addProvenSide(provenSides, sessionDate, "CHALLENGER");
      }
    }

    const remaining = frozenDates.filter(
      (sessionDate) =>
        !proven(sessionDate, "CHAMPION") || !proven(sessionDate, "CHALLENGER"),
    );
    if (remaining.length > 0) {
      if (remaining.some((sessionDate) => attempted.has(sessionDate)))
        throw new FundedComparisonServiceError(
          "INCOMPLETE_SESSION",
          `Executed sessions remain incomplete: ${remaining.join(", ")}`,
        );
      throw new FundedComparisonIncompleteError(remaining);
    }

    await this.assertFinalizationCoverage(receipt, evidenceBySession);
    await hook();
    return {
      specificationId: receipt.specId,
      result: await this.assembleAndFinalize(receipt, evidenceBySession),
      reused: false,
    };
  }

  private async provenSides(
    specId: string,
  ): Promise<Map<string, Set<FundedComparisonSide>>> {
    const metrics = await this.repository.listSessionMetrics(specId);
    const proven = new Map<string, Set<FundedComparisonSide>>();
    for (const metric of metrics)
      if (metric.valuation === "UNION_GRID_MTM")
        addProvenSide(proven, metric.sessionDate, metric.side);
    return proven;
  }

  private async appendSideMetric(
    receipt: FundedComparisonSpecificationReceipt,
    side: FundedComparisonSide,
    sessionDate: string,
    evidence: FundedComparisonSideSessionEvidence,
  ): Promise<void> {
    const metric = this.buildSessionMetric(
      receipt,
      side,
      sessionDate,
      evidence,
    );
    await this.repository.appendSessionMetric(receipt.specId, side, metric);
    if (metric.valuation === "UNAVAILABLE") {
      const reason = metric.valuationReason ?? "STALE_MARK";
      throw new FundedComparisonServiceError(
        reason,
        `${side} session ${sessionDate} valuation is unavailable: ${reason}`,
      );
    }
  }

  private buildSessionMetric(
    receipt: FundedComparisonSpecificationReceipt,
    side: FundedComparisonSide,
    sessionDate: string,
    evidence: FundedComparisonSideSessionEvidence,
  ): FundedComparisonSessionMetric {
    const specification = receipt.specification;
    const valuation = evidence.valuation;
    const proven = valuation.status === "PROVEN";
    const withoutDigest = {
      specId: receipt.specId,
      side,
      sessionDate,
      marketId: specification.marketId,
      currency: specification.currency,
      valuation: proven
        ? ("UNION_GRID_MTM" as const)
        : ("UNAVAILABLE" as const),
      valuationReason: proven ? null : (valuation.reason ?? "STALE_MARK"),
      netReturn: proven
        ? valuation.equityPoints.at(-1)!.equity -
          valuation.equityPoints[0]!.equity
        : null,
      maxDrawdown: proven ? valuation.maxDrawdown : null,
      tradeCount: evidence.orders.filter((order) => order.filledShares > 0)
        .length,
      unrealizedPositionCount: evidence.openPositions,
      unresolvedOrderCount: 0,
      unresolvedReservationCount: 0,
      staleMarkCount: valuation.staleMarkPoints,
      valuationPointCount: valuation.equityPoints.length,
    };
    return fundedComparisonSessionMetricSchema.parse({
      ...withoutDigest,
      metricDigest: fundedComparisonMetricDigest(withoutDigest),
    });
  }

  private async assertFinalizationCoverage(
    receipt: FundedComparisonSpecificationReceipt,
    evidenceBySession: ReadonlyMap<string, FundedComparisonSessionEvidence>,
  ): Promise<void> {
    for (const sessionDate of receipt.specification.sessionMembership
      .orderedSessionDates) {
      const evidence = evidenceBySession.get(sessionDate);
      if (!evidence)
        throw new FundedComparisonServiceError(
          "INCOMPLETE_SESSION",
          `Session ${sessionDate} has no reconstructed side evidence`,
        );
      const expected = receipt.opportunities.filter(
        (opportunity) => opportunity.sessionDate === sessionDate,
      );
      for (const side of SIDES) {
        const binding = await this.repository.findBinding(
          receipt.specId,
          side,
          sessionDate,
        );
        if (!binding)
          throw new FundedComparisonServiceError(
            "INCOMPLETE_SESSION",
            `${side} binding is missing for ${sessionDate}`,
          );
        if (side === "CHAMPION")
          verifyChampionBinding(receipt.specification, binding);
        else verifyChallengerBinding(receipt.specification, binding);
        const evaluations = await this.repository.listPolicyEvaluations(
          receipt.specId,
          side,
          sessionDate,
        );
        if (
          evaluations.length !== expected.length ||
          evaluations.some(
            (evaluation, index) =>
              evaluation.sourceOpportunityId !==
                expected[index]!.sourceOpportunityId ||
              evaluation.sourceOrdinal !== expected[index]!.sourceOrdinal,
          )
        )
          throw new FundedComparisonServiceError(
            "INCOMPLETE_SESSION",
            `${side} policy evaluations do not map the exact frozen membership for ${sessionDate}`,
          );
        const metric = await this.repository.findSessionMetric(
          receipt.specId,
          side,
          sessionDate,
        );
        if (!metric || metric.valuation !== "UNION_GRID_MTM")
          throw new FundedComparisonServiceError(
            "INCOMPLETE_SESSION",
            `${side} has no proven session metric for ${sessionDate}`,
          );
        const sideEvidence =
          side === "CHAMPION" ? evidence.champion : evidence.challenger;
        if (sideEvidence.valuation.status !== "PROVEN")
          throw new FundedComparisonServiceError(
            "INCOMPLETE_SESSION",
            `${side} valuation is not proven for ${sessionDate}`,
          );
      }
    }
  }

  private async assembleAndFinalize(
    receipt: FundedComparisonSpecificationReceipt,
    evidenceBySession: ReadonlyMap<string, FundedComparisonSessionEvidence>,
  ): Promise<FundedComparisonResult> {
    const specification = receipt.specification;
    const frozenDates = specification.sessionMembership.orderedSessionDates;
    const championEvaluations = await this.repository.listPolicyEvaluations(
      receipt.specId,
      "CHAMPION",
    );
    const challengerEvaluations = await this.repository.listPolicyEvaluations(
      receipt.specId,
      "CHALLENGER",
    );
    const champion = assembleSideMetrics(
      this.sideMetricInput(
        receipt,
        "CHAMPION",
        evidenceBySession,
        championEvaluations,
      ),
    );
    const challenger = assembleSideMetrics(
      this.sideMetricInput(
        receipt,
        "CHALLENGER",
        evidenceBySession,
        challengerEvaluations,
      ),
    );
    const result = assembleComparisonResult({
      specification,
      sessionPairs: frozenDates.map((sessionDate) => {
        const evidence = evidenceBySession.get(sessionDate)!;
        return {
          sessionDate,
          champion: evidence.champion.valuation,
          challenger: evidence.challenger.valuation,
        };
      }),
      champion,
      challenger,
      championEvaluationDigest: fundedComparisonEvaluationMembershipDigest(
        championEvaluations.map((evaluation) => evaluation.evaluationDigest),
      ),
      challengerEvaluationDigest: fundedComparisonEvaluationMembershipDigest(
        challengerEvaluations.map((evaluation) => evaluation.evaluationDigest),
      ),
    });
    return this.repository.finalizeResult(receipt.specId, result);
  }

  private sideMetricInput(
    receipt: FundedComparisonSpecificationReceipt,
    side: FundedComparisonSide,
    evidenceBySession: ReadonlyMap<string, FundedComparisonSessionEvidence>,
    evaluations: readonly FundedComparisonPolicyEvaluation[],
  ) {
    const sessions: FundedComparisonSideMetricSession[] = [];
    const decisions: FundedComparisonMetricDecision[] = [];
    const orders: FundedComparisonMetricOrder[] = [];
    for (const sessionDate of receipt.specification.sessionMembership
      .orderedSessionDates) {
      const evidence = evidenceBySession.get(sessionDate)!;
      const sideEvidence =
        side === "CHAMPION" ? evidence.champion : evidence.challenger;
      sessions.push({
        sessionDate,
        valuation: sideEvidence.valuation,
        carryInEquity: sideEvidence.carryInEquity,
        dailyLossLimit: sideEvidence.dailyLossLimit,
        dailyPnl: sideEvidence.dailyPnl,
        entriesAllowed: sideEvidence.entriesAllowed,
        openRisk: sideEvidence.openRisk,
        grossNotional: sideEvidence.grossNotional,
        openPositions: sideEvidence.openPositions,
        zeroTradeSessions: sideEvidence.zeroTradeSessions,
      });
      decisions.push(...sideEvidence.decisions);
      orders.push(...sideEvidence.orders);
    }
    return {
      side,
      specification: receipt.specification,
      sessions,
      decisions,
      orders,
      evaluations,
    };
  }

  private requireEvidenceSource(): FundedComparisonEvidenceSource {
    if (this.evidenceSource) return this.evidenceSource;
    throw new FundedComparisonServiceError(
      "INTERNAL_ERROR",
      "A comparison service requires an evidence source",
    );
  }

  private async recordFailure(
    receipt: FundedComparisonSpecificationReceipt,
    attemptId: string,
    reason: FundedComparisonFailureReason,
    classification: "TERMINAL" | "INTERRUPTION",
    detail: string,
  ): Promise<void> {
    const bounded = detail.length > 0 ? detail.slice(0, 500) : reason;
    await this.repository.appendFailure({
      specId: receipt.specId,
      attemptId,
      side: null,
      sessionDate: null,
      reason,
      classification,
      detail: bounded,
      failureDigest: fundedComparisonFailureDigest({
        specId: receipt.specId,
        attemptId,
        side: null,
        sessionDate: null,
        reason,
        classification,
        detail: bounded,
      }),
      recordedAt: new Date(0).toISOString(),
    });
  }
}

export async function verifyFrozenComparisonIdentities(
  pool: Pool,
  specification: FundedComparisonSpecification,
): Promise<void> {
  await loadFundedComparisonChampionPolicy(pool, specification);
  await loadFundedComparisonChallenger(pool, specification);
}

function sameFrozenIdentity(
  frozen: FundedComparisonFrozenSessionIdentity,
  session: {
    readonly sessionDate: string;
    readonly itemCount: number;
    readonly chunkCount: number;
    readonly sessionInputDigest: string;
  },
): boolean {
  return (
    frozen.sessionDate === session.sessionDate &&
    frozen.itemCount === session.itemCount &&
    frozen.chunkCount === session.chunkCount &&
    frozen.sessionInputDigest === session.sessionInputDigest
  );
}

function addProvenSide(
  proven: Map<string, Set<FundedComparisonSide>>,
  sessionDate: string,
  side: FundedComparisonSide,
): void {
  const sides = proven.get(sessionDate) ?? new Set<FundedComparisonSide>();
  sides.add(side);
  proven.set(sessionDate, sides);
}

export function mapComparisonFailure(error: unknown): {
  reason: FundedComparisonFailureReason;
  detail: string;
} {
  const message = error instanceof Error ? error.message : String(error);
  const detail = message.length > 0 ? message.slice(0, 500) : "unknown failure";
  if (error instanceof FundedComparisonServiceError)
    return { reason: error.reason, detail };
  if (error instanceof FundedComparisonSpecificationError)
    return { reason: error.reason, detail };
  if (error instanceof FundedComparisonChampionError)
    return { reason: error.reason, detail };
  if (error instanceof FundedComparisonRepositoryError)
    return { reason: error.reason, detail };
  if (error instanceof FundedComparisonChallengerPolicyError) {
    const known: readonly string[] = [
      "PREDICTION_DECISION_UNAVAILABLE",
      "MODEL_IDENTITY_MISMATCH",
      "OPPORTUNITY_MEMBERSHIP_MISMATCH",
    ];
    return known.includes(error.reason)
      ? { reason: error.reason as FundedComparisonFailureReason, detail }
      : { reason: "INTERNAL_ERROR", detail };
  }
  if (error instanceof FundedReconstructionUnavailableError)
    return { reason: "REPLAY_LINEAGE_UNAVAILABLE", detail };
  return { reason: "INTERNAL_ERROR", detail };
}

interface SideBuild {
  readonly valuationSide: {
    readonly initialState: FundedLedger;
    readonly effects: readonly {
      readonly at: string;
      readonly sequence: number;
      readonly event: LedgerEvent;
    }[];
  };
  readonly evidence: Omit<FundedComparisonSideSessionEvidence, "valuation">;
}

export class PostgresFundedComparisonEvidenceSource implements FundedComparisonEvidenceSource {
  constructor(
    private readonly pool: Pool,
    private readonly repository: FundedComparisonRepository,
    private readonly markAgeMs: number = FUNDED_COMPARISON_MARK_AGE_MS,
  ) {}

  async loadSessionEvidence(
    input: FundedComparisonSessionEvidenceInput,
  ): Promise<FundedComparisonSessionEvidence> {
    const shared = await loadFundedComparisonSharedInput(
      {
        loadSpecification: (specId) =>
          this.repository.loadSpecification(specId),
        loadSessionChunks: (specId, sessionDate) =>
          this.repository.loadSessionChunks(specId, sessionDate),
      },
      input.specificationId,
      input.sessionDate,
    );
    const champion = await this.loadSide(
      input,
      "CHAMPION",
      input.champion,
      shared,
    );
    const challenger = await this.loadSide(
      input,
      "CHALLENGER",
      input.challenger,
      shared,
    );
    const valuation = reconstructComparisonValuation({
      sharedInputs: shared.items,
      champion: champion.valuationSide,
      challenger: challenger.valuationSide,
      initialCash: input.specification.capital.initialCash,
    });
    return {
      champion: { ...champion.evidence, valuation: valuation.champion },
      challenger: { ...challenger.evidence, valuation: valuation.challenger },
    };
  }

  private async loadSide(
    input: FundedComparisonSessionEvidenceInput,
    side: FundedComparisonSide,
    binding: FundedComparisonRunBinding,
    shared: FundedComparisonSharedInput,
  ): Promise<SideBuild> {
    const initial = await this.reconstructAt(
      binding.accountId,
      shared.sessionStartAt,
    );
    const closing = await this.reconstructAt(
      binding.accountId,
      shared.scheduledCloseAt,
    );
    const effects = await this.loadEffects(
      binding.accountId,
      shared.sessionStartAt,
      shared.scheduledCloseAt,
    );
    const initialSummary = fundedAccountSummary(
      initial,
      shared.sessionStartAt,
      this.markAgeMs,
    );
    const closingSummary = fundedAccountSummary(
      closing,
      shared.scheduledCloseAt,
      this.markAgeMs,
    );
    const evaluations = await this.repository.listPolicyEvaluations(
      input.specificationId,
      side,
      input.sessionDate,
    );
    const decisions = await this.loadDecisions(
      binding.runId,
      evaluations.map((evaluation) => ({
        observationId: evaluation.destinationObservationId,
        sourceOpportunityId: evaluation.sourceOpportunityId,
      })),
    );
    const orders = await this.loadOrders(binding.runId);
    return {
      valuationSide: { initialState: initial, effects },
      evidence: {
        carryInEquity: initialSummary.equity,
        dailyLossLimit: input.specification.capital.dailyLossLimit,
        dailyPnl: closingSummary.dailyPnl,
        entriesAllowed: closingSummary.entriesAllowed,
        openRisk: closingSummary.openRisk,
        grossNotional: closingSummary.marketValue,
        openPositions: Object.keys(closing.positions).length,
        zeroTradeSessions: !orders.some((order) => order.filledShares > 0),
        decisions,
        orders,
      },
    };
  }

  private async reconstructAt(
    accountId: string,
    at: string,
  ): Promise<FundedLedger> {
    try {
      const reconstruction = await reconstructFundedLedgerAt(
        this.pool,
        accountId,
        at,
      );
      return reconstruction.ledger;
    } catch (error) {
      if (error instanceof FundedReconstructionUnavailableError)
        throw new FundedComparisonSpecificationError(
          "REPLAY_LINEAGE_UNAVAILABLE",
          `Funded ledger reconstruction at ${at} is unavailable: ${error.message}`,
        );
      throw error;
    }
  }

  private async loadEffects(
    accountId: string,
    sessionStartAt: string,
    scheduledCloseAt: string,
  ): Promise<SideBuild["valuationSide"]["effects"]> {
    const { rows } = await this.pool.query<{
      event: LedgerEvent;
      event_sequence: number | string | null;
      event_sequence_verified: boolean;
    }>(
      `SELECT event,event_sequence,event_sequence_verified
         FROM paper_funded_event
        WHERE account_id=$1
          AND (event->>'at')::timestamptz > $2::timestamptz
          AND (event->>'at')::timestamptz <= $3::timestamptz
        ORDER BY event_sequence`,
      [accountId, sessionStartAt, scheduledCloseAt],
    );
    return rows.map((row) => ({
      at: row.event.at,
      sequence:
        row.event_sequence_verified && row.event_sequence !== null
          ? Number(row.event_sequence)
          : 0,
      event: row.event,
    }));
  }

  private async loadDecisions(
    runId: string,
    observations: readonly {
      readonly observationId: string;
      readonly sourceOpportunityId: string;
    }[],
  ): Promise<readonly FundedComparisonMetricDecision[]> {
    if (observations.length === 0) return [];
    const sourceByObservation = new Map(
      observations.map((entry) => [
        entry.observationId,
        entry.sourceOpportunityId,
      ]),
    );
    const { rows } = await this.pool.query<{
      observation_id: string;
      action: "SUBMIT" | "DECLINE" | "DEFER";
      decision_content: unknown;
      veto_code: string | null;
      outcome_status: string | null;
      outcome_detail: unknown;
    }>(
      `SELECT e.observation_id,e.action,e.decision_content,
              f.outcome->'vetoes'->0->>'code' AS veto_code,
              o.status AS outcome_status,o.detail AS outcome_detail
         FROM funded_decision_evidence e
         LEFT JOIN paper_funded_fact f
           ON f.run_id=e.run_id AND f.fact_id='funded-signal:'||e.observation_id
         LEFT JOIN LATERAL (
           SELECT status,detail FROM funded_decision_outcome x
            WHERE x.run_id=e.run_id AND x.observation_id=e.observation_id
            ORDER BY x.sequence DESC LIMIT 1
         ) o ON true
        WHERE e.run_id=$1 AND e.observation_id=ANY($2::uuid[])`,
      [runId, observations.map((entry) => entry.observationId)],
    );
    return rows.map((row) =>
      metricDecisionOf(
        row,
        sourceByObservation.get(row.observation_id) ?? row.observation_id,
      ),
    );
  }

  private async loadOrders(
    runId: string,
  ): Promise<readonly FundedComparisonMetricOrder[]> {
    const { rows } = await this.pool.query<{ state: PendingEntryOrder }>(
      `SELECT state FROM paper_entry_order
        WHERE run_id=$1 ORDER BY created_at,order_id`,
      [runId],
    );
    return rows.map((row) => metricOrderOf(row.state));
  }
}

function metricDecisionOf(
  row: {
    observation_id: string;
    action: "SUBMIT" | "DECLINE" | "DEFER";
    decision_content: unknown;
    veto_code: string | null;
    outcome_status: string | null;
    outcome_detail: unknown;
  },
  sourceOpportunityId: string,
): FundedComparisonMetricDecision {
  const content = recordOf(row.decision_content);
  const requestedCapital = recordOf(content?.requestedCapital);
  const capitalAvailable = requestedCapital?.status === "AVAILABLE";
  const vetoed = row.outcome_status === "RISK_VETOED";
  const vetoCode = vetoed ? vetoCodeOf(row.veto_code) : null;
  const closed = row.outcome_status === "CLOSED";
  const detail = recordOf(row.outcome_detail);
  const realized =
    closed && typeof detail?.realizedNetPnl === "number"
      ? detail.realizedNetPnl
      : null;
  return {
    sourceOpportunityId,
    action: vetoed ? "DECLINE" : row.action,
    policyReason:
      vetoed || typeof content?.policyReason !== "string"
        ? null
        : content.policyReason,
    vetoCode,
    requestedNotional:
      capitalAvailable && typeof requestedCapital?.maximumDebit === "number"
        ? requestedCapital.maximumDebit
        : null,
    requestedRisk:
      capitalAvailable && typeof requestedCapital?.maximumRisk === "number"
        ? requestedCapital.maximumRisk
        : null,
    realizedValue: realized,
    realizable: closed,
  };
}

function vetoCodeOf(value: string | null) {
  if (value === null) return "UNKNOWN_VETO_REASON" as const;
  const known: readonly string[] = [
    "MAX_OPEN_POSITIONS",
    "MAX_TOTAL_OPEN_RISK",
    "CONTEXT_UNAVAILABLE_OR_STALE",
    "WEAK_CONTEXT",
    "SYMBOL_EXPOSURE",
    "SECTOR_EXPOSURE",
    "POST_STOP_COOLDOWN",
    "CONSECUTIVE_STOP_LIMIT",
    "DAILY_LOSS_OR_BUYING_POWER",
    "FILL_EXCEEDS_RESERVATION",
  ];
  return known.includes(value)
    ? (value as FundedComparisonMetricDecision["vetoCode"])
    : "UNKNOWN_VETO_REASON";
}

function metricOrderOf(order: PendingEntryOrder): FundedComparisonMetricOrder {
  const execution = order.execution;
  const position =
    execution && "position" in execution ? execution.position : undefined;
  const sizing =
    execution && "sizing" in execution ? execution.sizing : undefined;
  const closed = execution?.status === "CLOSED" ? execution : undefined;
  const requestedShares = sizing
    ? sizing.shares + (sizing.unfilledShares ?? 0)
    : 0;
  const filledShares = position?.shares ?? 0;
  return {
    requestedShares,
    filledShares,
    entryPriceMicros: position ? Math.round(position.entryPrice * MICROS) : 0,
    exitPriceMicros: closed
      ? Math.round(closed.exit.financials.exitPrice * MICROS)
      : null,
    netPnlMicros: closed
      ? Math.round(closed.exit.financials.netPnl * MICROS)
      : null,
    slippageMicrosPerShare: slippageMicrosOf(execution),
    costsMicros: Math.round(roundTripCosts(order.assumptions) * MICROS),
  };
}

function slippageMicrosOf(
  execution: PendingEntryOrder["execution"],
): number | null {
  if (!execution || !("position" in execution)) return null;
  let slippage =
    execution.position.entryPrice - execution.entryMarketSnapshot.ask;
  if (execution.status === "CLOSED")
    slippage +=
      execution.exit.exitMarketSnapshot.bid -
      execution.exit.financials.exitPrice;
  return Math.round(slippage * MICROS);
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Comparison-owned decision input for replay. Quotes and contexts come only
 * from the frozen shared-input rows; the signal-quality model prediction is
 * not part of the frozen exogenous stream and stays explicitly unavailable.
 */
export function createFundedComparisonReplayEvidenceSource(
  shared: FundedComparisonSharedInput,
): FundedDecisionEvidenceSource {
  return {
    quote: async (instrumentId: string, at: string) => {
      const boundary = Date.parse(at);
      let match: FundedComparisonSharedInput["quotes"][number] | undefined;
      for (const quote of shared.quotes) {
        if (quote.instrumentId !== instrumentId) continue;
        if (Date.parse(quote.timestamp) > boundary) continue;
        if (!match || quote.timestamp > match.timestamp) match = quote;
      }
      if (!match) return null;
      return {
        timestamp: match.timestamp,
        bid: match.bid,
        ask: match.ask,
        bidSize: match.bidSize,
        askSize: match.askSize,
        sizeUnit: match.sizeUnit,
        sizeMultiplier: match.sizeMultiplier,
        dataStatus: match.dataStatus,
        actionable: match.actionable,
      } satisfies QuoteFact;
    },
    contexts: async (_marketId: MarketId, instrumentId: string, at: string) => {
      const boundary = Date.parse(at);
      let selected: FundedComparisonOpportunityItem | undefined;
      for (const item of shared.opportunityItems.values()) {
        if (item.instrumentId !== instrumentId) continue;
        if (Date.parse(item.signalTimestamp) > boundary) continue;
        if (!selected || item.signalTimestamp > selected.signalTimestamp)
          selected = item;
      }
      if (!selected) return [];
      return selected.contexts.map((context) => ({
        signalKey: context.signalKey,
        status: contextStatusOf(context.status),
        timestamp: context.timestamp,
      }));
    },
    model: async () => null,
  };
}

function contextStatusOf(status: string): FundedDecisionContextInput["status"] {
  switch (status) {
    case "UNAVAILABLE":
    case "WEAK":
    case "NEUTRAL":
    case "STRONG":
    case "STALE":
      return status;
    default:
      return "UNAVAILABLE";
  }
}
