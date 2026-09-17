import type { StrategyStateEvent } from "@tsx-scanner/contracts";
import {
  applyCandleFacts,
  applyQuoteFact,
  createCandleExecution,
  createQuoteExecution,
  requestCandleSessionClose,
  requestQuoteSessionClose,
  requestQuoteTimeStop,
  type CandleExecutionState,
  type QuoteExecutionState,
} from "./execution-core.js";
import type {
  PaperBotStore,
  EligibilityStatus,
  PaperSignalObservation,
} from "./paper-bot-repository.js";
import type { PaperExecutionStore } from "./paper-execution-repository.js";
import {
  coordinateCandidates,
  isStalledBreakout,
  maximumHoldingMinutesFor,
  rankCandidates,
  type CoordinationPolicy,
  type CoordinationCandidate,
  type CoordinationState,
} from "./coordination-policy.js";

/**
 * Used only when a caller wires the coordinator without a policy. Real
 * deployments pass the configured policy; these values keep a misconfigured
 * process conservative rather than unlimited.
 */
const DEFAULT_COORDINATION_POLICY: CoordinationPolicy = {
  cooldownMinutesAfterStop: 15,
  maxOpenPositions: 3,
  maxTotalOpenRisk: 1_000,
  maxDailyLoss: 1_000,
  maxConsecutiveStops: 3,
};

/**
 * Bound on reconciliation drain passes per call. Each pass re-reads the
 * unobserved READY backlog after the previous pass's observations landed, so
 * a crash backlog larger than one `limit` batch still converges; the bound
 * prevents an unbounded loop when a permanently unprocessable row is all that
 * remains (a pass with zero processed rows stops immediately).
 */
const MAX_RECONCILIATION_PASSES = 20;
import type { PaperCoordinationStore } from "./paper-coordination-repository.js";
import { evaluateCandleEntry } from "./candle-execution.js";
import { evaluateQuoteEntry } from "./quote-execution.js";
import type {
  AssumptionsSnapshot,
  CandleFact,
  MarketSnapshot,
  QuoteFact,
  SignalFact,
  SizingContext,
} from "./types.js";

/**
 * The result of one reconciliation pass. `candidates` is the backlog of READY
 * events still lacking complete paper evidence; `skipped` names the ones that
 * could not be repaired and why, so a permanently stuck row is visible rather
 * than silently retried forever.
 */
export interface ReadyEventReconciliationOutcome {
  readonly candidates: number;
  processed: number;
  readonly skipped: { sourceEventId: string; reason: string }[];
  readonly eligibleObservations: readonly PaperSignalObservation[];
}

/** The subset of ScannerProfile the live processor needs to classify eligibility. */
export interface ProfileConfigLookup {
  readonly configId: string;
  readonly configVersion: string;
  readonly parameters: unknown;
}

export interface ProfileLookup {
  getProfileConfig(
    profileId: string,
    configVersion: string,
  ): Promise<ProfileConfigLookup | undefined>;
}
export interface PaperPredictionSnapshotWriter {
  record(observation: PaperSignalObservation): Promise<void>;
}

import type { CandidatePredictionResolver } from "./candidate-prediction-resolver.js";
import type { CandidatePrediction } from "./coordination-policy.js";

export interface PaperBotLiveProcessorDeps {
  readonly paperBotStore: PaperBotStore;
  readonly paperExecutionStore: PaperExecutionStore;
  readonly profiles: ProfileLookup;
  readonly assumptions: AssumptionsSnapshot;
  readonly predictionSnapshots?: PaperPredictionSnapshotWriter;
  /** Shadow-only coordinated selection; never alters independent executions. */
  readonly coordinationStore?: PaperCoordinationStore;
  readonly coordinationPolicy?: CoordinationPolicy;
  /**
   * Exposure caps applied when sizing a coordinated position. Deliberately
   * absent from the independent projection, whose per-strategy evidence must
   * not be resized by portfolio state.
   */
  readonly coordinationSizing?: Pick<
    SizingContext,
    "maxDisplayedSizeParticipation"
  >;
  readonly candidatePredictionResolver?: CandidatePredictionResolver;
}

function extractScoreCutoff(parameters: unknown): number {
  if (typeof parameters !== "object" || parameters === null) return 0;
  const value = (parameters as Record<string, unknown>).scoreCutoff;
  return typeof value === "number" ? value : 0;
}

/**
 * Drives Phase 3's "create/reconcile paper observations from the persisted
 * eligible events and the same quote batch" pipeline stage
 * (private development record). Every persisted READY event is observed
 * regardless of score; only score-eligible, newly created observations get
 * initial QUOTE/CANDLE executions. Ongoing exits are evaluated by the other
 * processor stages below.
 */
export class PaperBotLiveProcessor {
  constructor(
    private readonly deps: PaperBotLiveProcessorDeps,
    private readonly runId: string,
  ) {}

  /**
   * Repairs the crash window after event persistence and before observation
   * creation.
   *
   * Every candidate is isolated: one event that cannot be processed -- an
   * unparseable payload, a profile configuration that no longer resolves --
   * is counted and skipped rather than thrown. A failing candidate is never
   * observed, so it stays in the candidate set forever; aborting the batch on
   * it would re-fail on the same row every cycle and halt all forward
   * evidence collection indefinitely.
   */
  async reconcileReadyEvents(
    limit = 500,
  ): Promise<ReadyEventReconciliationOutcome> {
    // A single capped batch leaves the remainder of a crash backlog
    // unobserved forever, because later ticks only look at the newest rows.
    // Drain in bounded passes until a pass observes nothing new; permanently
    // unprocessable rows are reported instead of silently blocking the batch.
    const skipped = new Map<string, string>();
    const newlyEligible: PaperSignalObservation[] = [];
    const quotesByObservationId = new Map<string, QuoteFact | null>();
    let candidates = 0;
    let processed = 0;
    for (let pass = 0; pass < MAX_RECONCILIATION_PASSES; pass++) {
      const batch = await this.reconcileReadyEventBatch(
        limit,
        skipped,
        newlyEligible,
        quotesByObservationId,
      );
      candidates = batch.candidates;
      processed += batch.processed;
      if (batch.processed === 0) break;
    }
    const observationsForCoordination =
      this.deps.coordinationStore &&
      this.deps.paperBotStore.findEligibleObservationsWithoutCoordination
        ? await this.deps.paperBotStore.findEligibleObservationsWithoutCoordination(
            this.runId,
          )
        : newlyEligible;
    await this.recordShadowCoordinationDecisions(
      observationsForCoordination,
      quotesByObservationId,
    );
    await this.recoverApprovedDecisionsWithoutPositions();
    return {
      candidates,
      processed,
      skipped: [...skipped].map(([sourceEventId, reason]) => ({
        sourceEventId,
        reason,
      })),
      eligibleObservations: newlyEligible,
    };
  }

  private async reconcileReadyEventBatch(
    limit: number,
    skipped: Map<string, string>,
    newlyEligible: PaperSignalObservation[],
    quotesByObservationId: Map<string, QuoteFact | null>,
  ): Promise<{ candidates: number; processed: number }> {
    const candidates = await this.deps.paperBotStore.findUnobservedReadyEvents(
      this.runId,
      limit,
    );
    let processed = 0;
    for (const candidate of candidates) {
      if (candidate.event === null) {
        skipped.set(
          candidate.sourceEventId,
          candidate.parseError ?? "unparseable event payload",
        );
        continue;
      }
      try {
        const observation = await this.processReadyEvent(
          candidate.event,
          candidate.quoteAtSignal,
          candidate.sourceSignalId,
        );
        if (observation?.eligibilityStatus === "ELIGIBLE") {
          newlyEligible.push(observation);
          quotesByObservationId.set(observation.id, candidate.quoteAtSignal);
        }
        processed += 1;
      } catch (error) {
        skipped.set(
          candidate.sourceEventId,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    return { candidates: candidates.length, processed };
  }

  /**
   * Processes one persisted READY event against the quote observed at (or
   * nearest before) its own timestamp, from the same ingest batch that
   * produced the event. Pass `null` when no quote for that instrument was in
   * the batch (the quote model will record NO_FILL / MISSING_QUOTE; the
   * candle model is unaffected since it never depends on a quote).
   */
  async processReadyEvent(
    event: StrategyStateEvent,
    quoteAtSignal: QuoteFact | null,
    sourceSignalId: string | null = null,
  ): Promise<PaperSignalObservation | undefined> {
    if (event.state !== "READY") return undefined;

    const profile = await this.deps.profiles.getProfileConfig(
      event.profileId,
      event.configVersion,
    );
    if (!profile) {
      throw new Error(
        `Profile configuration ${event.profileId}/${event.configVersion} could not be resolved`,
      );
    }

    const scoreCutoff = extractScoreCutoff(profile.parameters);
    const eligibilityStatus: EligibilityStatus =
      event.score >= scoreCutoff ? "ELIGIBLE" : "BELOW_SCORE_CUTOFF";
    const eligibilityReason =
      eligibilityStatus === "BELOW_SCORE_CUTOFF"
        ? `score ${event.score} is below the profile's score_cutoff of ${scoreCutoff}`
        : null;

    const { observation } = await this.deps.paperBotStore.insertObservation({
      runId: this.runId,
      sourceEventId: event.eventId,
      sourceSignalId,
      setupInstanceId: event.setupInstanceId,
      instrumentId: event.instrumentId,
      symbol: event.symbol,
      profileId: event.profileId,
      profileName: event.profileName,
      profileConfigId: profile.configId,
      configVersion: profile.configVersion,
      profileParameters: profile.parameters,
      strategyKey: event.strategy,
      strategyVersion: event.strategyVersion,
      signalTimestamp: event.timestamp,
      score: event.score,
      entryReference: event.entryReference,
      stopReference: event.stopReference,
      targetReference: event.targetReference,
      atr14: event.featureSnapshot.atr14,
      featureSnapshot: event.featureSnapshot,
      reasonCodes: event.reasonCodes,
      sourceEventPayload: event,
      eligibilityStatus,
      eligibilityReason,
    });

    // A failed supplemental prediction must never block observation capture or
    // paper execution. The absence is observable through logs/monitoring, but
    // we must not invent a later prediction for this historical observation.
    try {
      await this.deps.predictionSnapshots?.record(observation);
    } catch {
      // Best effort by design; the deterministic bot remains authoritative.
    }

    if (observation.eligibilityStatus !== "ELIGIBLE") return observation;

    const signal: SignalFact = {
      entryReference: observation.entryReference,
      stopReference: observation.stopReference,
      targetReference: observation.targetReference,
      atr14: observation.atr14,
      signalTimestamp: observation.signalTimestamp,
    };

    const quoteState = createQuoteExecution(
      signal,
      quoteAtSignal,
      this.deps.assumptions,
    );
    const candleState = createCandleExecution(signal, this.deps.assumptions);
    await this.deps.paperExecutionStore.insertInitialExecutions(
      observation.id,
      quoteState,
      candleState,
    );
    return observation;
  }

  /**
   * Records one decision per same-symbol/same-scan timestamp batch, then opens
   * the approved position under the portfolio's own exposure caps.
   *
   * Candidate viability comes from the same entry evaluation the independent
   * projection runs, so the coordinator can never rank a candidate the
   * execution core would have refused, and live and replay agree by
   * construction.
   */
  private async recordShadowCoordinationDecisions(
    observations: readonly PaperSignalObservation[],
    quotesByObservationId: ReadonlyMap<string, QuoteFact | null>,
  ): Promise<void> {
    if (!this.deps.coordinationStore) return;

    // Group observations by signal timestamp
    const timestampMap = new Map<string, PaperSignalObservation[]>();
    for (const observation of observations) {
      const t = observation.signalTimestamp;
      const list = timestampMap.get(t) ?? [];
      list.push(observation);
      timestampMap.set(t, list);
    }

    // Process timestamps in strictly chronological order
    const sortedTimestamps = Array.from(timestampMap.keys()).sort(
      (a, b) => new Date(a).getTime() - new Date(b).getTime(),
    );

    for (const timestamp of sortedTimestamps) {
      const obsAtTimestamp = timestampMap.get(timestamp)!;
      // Group by symbol at this timestamp
      const symbolMap = new Map<string, PaperSignalObservation[]>();
      for (const obs of obsAtTimestamp) {
        const list = symbolMap.get(obs.symbol) ?? [];
        list.push(obs);
        symbolMap.set(obs.symbol, list);
      }

      // If multiple symbols trigger at the same timestamp, determine deterministic cross-symbol priority:
      // Compare each symbol group's highest-ranking candidate.
      const symbolGroups = Array.from(symbolMap.entries()).map(
        ([symbol, group]) => {
          const candidates: CoordinationCandidate[] = group.map((observation) =>
            this.candidateFor(
              observation,
              quotesByObservationId.get(observation.id) ?? null,
              { fallbackReason: "PREDICTION_PENDING" },
            ),
          );
          const ranked = rankCandidates(candidates);
          const topCandidate = ranked[0];
          return { symbol, group, candidates, topCandidate };
        },
      );

      symbolGroups.sort((a, b) => {
        if (!a.topCandidate && !b.topCandidate)
          return a.symbol.localeCompare(b.symbol);
        if (!a.topCandidate) return 1;
        if (!b.topCandidate) return -1;

        const primaryDiff =
          Number(b.topCandidate.eligibleAsPrimary) -
          Number(a.topCandidate.eligibleAsPrimary);
        if (primaryDiff !== 0) return primaryDiff;

        const rrDiff = b.topCandidate.rewardRisk - a.topCandidate.rewardRisk;
        if (Math.abs(rrDiff) > 1e-6) return rrDiff;

        const confDiff =
          b.topCandidate.confirmationCount - a.topCandidate.confirmationCount;
        if (confDiff !== 0) return confDiff;

        const scoreDiff = b.topCandidate.score - a.topCandidate.score;
        if (scoreDiff !== 0) return scoreDiff;

        return a.symbol.localeCompare(b.symbol);
      });

      for (const { group } of symbolGroups) {
        const first = group[0];
        if (!first) continue;
        // Start resolution at signal time, but never wait for it before opening
        // the deterministic position. A slow model is observational only.
        const predictionTasks = group.map(async (observation) => {
          let prediction: CandidatePrediction | undefined;
          if (this.deps.candidatePredictionResolver) {
            try {
              prediction =
                await this.deps.candidatePredictionResolver.resolveCandidatePrediction(
                  observation,
                  quotesByObservationId.get(observation.id) ?? null,
                );
            } catch (err) {
              prediction = {
                fallbackReason: "PREDICTION_FAILED",
                warnings: [err instanceof Error ? err.message : String(err)],
              };
            }
          }
          return prediction ?? { fallbackReason: "NO_PREDICTION_RESOLVER" };
        });
        const candidates: CoordinationCandidate[] = group.map((observation) =>
          this.candidateFor(
            observation,
            quotesByObservationId.get(observation.id) ?? null,
            { fallbackReason: "PREDICTION_PENDING" },
          ),
        );
        const state = await this.deps.coordinationStore.stateForSymbol(
          this.runId,
          first.symbol,
          first.signalTimestamp,
          first.instrumentId,
        );
        const decision = coordinateCandidates(
          candidates,
          state,
          this.deps.coordinationPolicy ?? DEFAULT_COORDINATION_POLICY,
          first.signalTimestamp,
        );
        let initialPosition: {
          observationId: string;
          state: QuoteExecutionState;
        } | null = null;
        if (decision.outcome === "APPROVED" && decision.selectedObservationId) {
          const selected = group.find(
            (observation) => observation.id === decision.selectedObservationId,
          );
          if (selected) {
            const quoteAtSignal =
              quotesByObservationId.get(selected.id) ?? null;
            const signal: SignalFact = {
              entryReference: selected.entryReference,
              stopReference: selected.stopReference,
              targetReference: selected.targetReference,
              atr14: selected.atr14,
              signalTimestamp: selected.signalTimestamp,
            };
            initialPosition = {
              observationId: selected.id,
              state: createQuoteExecution(
                signal,
                quoteAtSignal,
                this.deps.assumptions,
                this.sizingContextFor(state),
              ),
            };
          }
        }

        const record = await this.deps.coordinationStore.recordDecision({
          runId: this.runId,
          symbol: first.symbol,
          decisionTimestamp: first.signalTimestamp,
          triggerObservationIds: group.map((observation) => observation.id),
          decision,
          state,
          initialPosition,
        });
        // The deterministic decision is durable now. Resolve and persist the
        // model-only comparison after that boundary, never before v3 entry.
        const persistModelFacts = async () => {
          if (
            !record.created ||
            !this.deps.coordinationStore?.updateDecisionModelFacts
          )
            return;
          const predictions = await Promise.all(predictionTasks);
          const predictedCandidates = group.map((observation, index) =>
            this.candidateFor(
              observation,
              quotesByObservationId.get(observation.id) ?? null,
              predictions[index],
            ),
          );
          const modelDecision = coordinateCandidates(
            predictedCandidates,
            state,
            this.deps.coordinationPolicy ?? DEFAULT_COORDINATION_POLICY,
            first.signalTimestamp,
          );
          await this.deps.coordinationStore.updateDecisionModelFacts(
            record.id,
            modelDecision,
          );
        };

        if (initialPosition) {
          await this.deps.coordinationStore.insertInitialQuotePosition(
            record.id,
            initialPosition.observationId,
            initialPosition.state,
          );
        }

        void persistModelFacts().catch(() => undefined);
      }
    }
  }

  /**
   * Recovers any approved coordination decisions that are missing a position
   * row (e.g. process crashed between decision persistence and position insertion,
   * or a transient database failure). Uses immutable decision-time inputs.
   */
  async recoverApprovedDecisionsWithoutPositions(): Promise<number> {
    if (!this.deps.coordinationStore?.findApprovedDecisionsWithoutPositions) {
      return 0;
    }
    const orphans =
      await this.deps.coordinationStore.findApprovedDecisionsWithoutPositions(
        this.runId,
      );
    if (orphans.length === 0) return 0;

    let recovered = 0;
    for (const orphan of orphans) {
      const observation = await this.deps.paperBotStore.findObservationById(
        orphan.selectedObservationId,
      );
      if (!observation) continue;

      let quoteAtSignal: QuoteFact | null = null;
      if (this.deps.paperExecutionStore?.findQuoteSnapshotForObservation) {
        quoteAtSignal =
          await this.deps.paperExecutionStore.findQuoteSnapshotForObservation(
            observation.id,
          );
      }

      const signal: SignalFact = {
        entryReference: observation.entryReference,
        stopReference: observation.stopReference,
        targetReference: observation.targetReference,
        atr14: observation.atr14,
        signalTimestamp: observation.signalTimestamp,
      };

      const positionState = createQuoteExecution(
        signal,
        quoteAtSignal,
        this.deps.assumptions,
        this.sizingContextFor(orphan.stateSnapshot),
      );

      await this.deps.coordinationStore.insertInitialQuotePosition(
        orphan.id,
        observation.id,
        positionState,
      );
      recovered += 1;
    }
    return recovered;
  }

  /**
   * Evaluates one observation exactly as the execution core would, so the
   * coordinator ranks on the trade it could actually open: cost-inclusive
   * reward/risk, the risk-budgeted share count, and the economics gate's own
   * verdict. Candle evaluation covers the reconciliation path, where the
   * decision-time quote is no longer available.
   */
  private candidateFor(
    observation: PaperSignalObservation,
    quoteAtSignal: QuoteFact | null,
    prediction?: CandidatePrediction,
  ): CoordinationCandidate {
    const signal: SignalFact = {
      entryReference: observation.entryReference,
      stopReference: observation.stopReference,
      targetReference: observation.targetReference,
      atr14: observation.atr14,
      signalTimestamp: observation.signalTimestamp,
    };
    const evaluation =
      quoteAtSignal === null
        ? evaluateCandleEntry(signal, this.deps.assumptions)
        : evaluateQuoteEntry(signal, quoteAtSignal, this.deps.assumptions);
    const base = {
      observationId: observation.id,
      strategyKey: observation.strategyKey,
      strategyVersion: observation.strategyVersion,
      score: observation.score,
      entryPrice: observation.entryReference,
      stopPrice: observation.stopReference,
      targetPrice: observation.targetReference,
      prediction,
    };
    if (evaluation.status !== "OPEN") {
      return {
        ...base,
        economicallyViable: false,
        economicsReason:
          evaluation.status === "REJECTED_ECONOMICS"
            ? evaluation.economicsReason
            : null,
        netRewardRisk: null,
        estimatedInitialRisk: 0,
      };
    }
    const entryPrice =
      "executableEntryPrice" in evaluation
        ? evaluation.executableEntryPrice
        : evaluation.syntheticEntryPrice;
    return {
      ...base,
      economicallyViable: true,
      economicsReason: null,
      netRewardRisk: evaluation.economics.netRewardRisk,
      estimatedInitialRisk: evaluation.initialRisk,
      estimatedShares: evaluation.shares,
      estimatedNotional: entryPrice * evaluation.shares,
    };
  }

  /** Portfolio room remaining for the coordinated position being opened. */
  private sizingContextFor(state: CoordinationState): SizingContext {
    const policy = this.deps.coordinationPolicy ?? DEFAULT_COORDINATION_POLICY;
    return {
      executionMode: "CAPACITY_CONSTRAINED",
      ...this.deps.coordinationSizing,
      openSymbolNotional: state.openSymbolNotional ?? 0,
      openSectorNotional: state.openSectorNotional ?? 0,
      openPortfolioRisk: state.totalOpenRisk,
      maxSymbolNotional: policy.maxSymbolNotional,
      maxSectorNotional: policy.maxSectorNotional,
      maxPortfolioRisk: policy.maxTotalOpenRisk,
    };
  }

  async evaluateOpenCoordinatedPositions(
    quotesByInstrumentId: ReadonlyMap<string, QuoteFact>,
    noonBoundaryTimestamp: string | null = null,
  ): Promise<void> {
    if (!this.deps.coordinationStore) return;
    const boundary =
      noonBoundaryTimestamp === null
        ? Number.POSITIVE_INFINITY
        : new Date(noonBoundaryTimestamp).getTime();
    for (const position of await this.deps.coordinationStore.findOpenPositions(
      this.runId,
    )) {
      const quote = quotesByInstrumentId.get(position.instrumentId);
      if (!quote || new Date(quote.timestamp).getTime() >= boundary) continue;
      if (position.state.status !== "OPEN") continue;
      const policy =
        this.deps.coordinationPolicy ?? DEFAULT_COORDINATION_POLICY;
      const holdingMs =
        new Date(quote.timestamp).getTime() -
        new Date(position.state.position.entryTime).getTime();
      // Two independent time controls: the strategy's own holding horizon, and
      // a breakout that never went anywhere. Both are risk controls, recorded
      // as TIME_STOP rather than as a strategy exit.
      const expired =
        holdingMs >=
        maximumHoldingMinutesFor(policy, position.strategyKey) * 60_000;
      const stalled = isStalledBreakout(
        policy,
        position.strategyKey,
        position.state.position,
        quote.bid,
        quote.timestamp,
      );
      if (expired || stalled) {
        const timeStop = requestQuoteTimeStop(
          position.state,
          quote,
          this.deps.assumptions,
        );
        if (timeStop.transitioned) {
          await this.deps.coordinationStore.updateQuotePosition(
            position.id,
            timeStop.state,
          );
          continue;
        }
      }
      const result = applyQuoteFact(
        position.state,
        quote,
        this.deps.assumptions,
      );
      if (result.state !== position.state)
        await this.deps.coordinationStore.updateQuotePosition(
          position.id,
          result.state,
        );
    }
  }

  /**
   * Evaluates every currently OPEN or CLOSE_PENDING QUOTE execution against
   * the current quote batch (Phase 3's "evaluate canonical quote
   * transitions" stage), keyed by instrument. An instrument with no quote in
   * this cycle's batch is simply left untouched — there is no new fact to
   * apply. Only executions that actually transition are written back.
   */
  async evaluateOpenQuoteExecutions(
    quotesByInstrumentId: ReadonlyMap<string, QuoteFact>,
    noonBoundaryTimestamp: string | null = null,
  ): Promise<void> {
    const boundaryMs =
      noonBoundaryTimestamp === null
        ? Number.POSITIVE_INFINITY
        : new Date(noonBoundaryTimestamp).getTime();
    const openExecutions =
      await this.deps.paperExecutionStore.findOpenAndClosePending(this.runId);
    for (const row of openExecutions) {
      if (row.model !== "QUOTE") continue;
      const quote = quotesByInstrumentId.get(row.instrumentId);
      if (!quote) continue;
      // Noon is authoritative: a quote at or after the boundary belongs to
      // session closure, never to a normal TARGET/STOP exit. Enforcing that
      // here rather than at the call site keeps the rule true regardless of
      // the order in which a cycle happens to run its stages, and matches
      // the replay path in authoritative-backtest-executor.ts.
      if (new Date(quote.timestamp).getTime() >= boundaryMs) continue;

      const state: QuoteExecutionState =
        (row.executionState as QuoteExecutionState | null) ?? {
          status: row.status,
          position: row.position,
          entryMarketSnapshot: row.entryMarketSnapshot as MarketSnapshot,
          entrySizeCoverage: row.entrySizeCoverage ?? 0,
          lastFactTimestamp: row.lastFactTimestamp,
        };
      const result = applyQuoteFact(state, quote, this.deps.assumptions);
      if (result.state !== state) {
        await this.deps.paperExecutionStore.upsertQuoteExecution(
          row.observationId,
          result.state,
        );
      }
    }
  }

  /**
   * Evaluates every currently OPEN or CLOSE_PENDING CANDLE execution against
   * newly completed one-minute candles for that instrument. Candles already
   * at or before the position's entry time are dropped inside
   * `applyCandleFacts` itself, so passing the same batch across restarts or
   * overlapping cycles is harmless.
   */
  async evaluateOpenCandleExecutions(
    candlesByInstrumentId: ReadonlyMap<string, readonly CandleFact[]>,
    noonBoundaryTimestamp: string | null = null,
  ): Promise<void> {
    const boundaryMs =
      noonBoundaryTimestamp === null
        ? Number.POSITIVE_INFINITY
        : new Date(noonBoundaryTimestamp).getTime();
    const openExecutions =
      await this.deps.paperExecutionStore.findOpenAndClosePending(this.runId);
    for (const row of openExecutions) {
      if (row.model !== "CANDLE") continue;
      // The bar ending exactly at noon is still evaluated normally -- a stop
      // or target inside it precedes the close -- but no later bar may
      // produce an exit reason other than session closure.
      const candles = candlesByInstrumentId
        .get(row.instrumentId)
        ?.filter((candle) => new Date(candle.end).getTime() <= boundaryMs);
      if (!candles || candles.length === 0) continue;

      const state: CandleExecutionState =
        (row.executionState as CandleExecutionState | null) ?? {
          status: row.status,
          position: row.position,
          lastFactTimestamp: row.lastFactTimestamp,
        };
      const result = applyCandleFacts(state, candles, this.deps.assumptions);
      if (result.state !== state) {
        await this.deps.paperExecutionStore.upsertCandleExecution(
          row.observationId,
          result.state,
        );
      }
    }
  }

  /**
   * Requests the noon session close for every currently OPEN or
   * CLOSE_PENDING execution of both models (Phase 3's "detect the noon
   * boundary and request or resolve session closure" stage). Pass the quote
   * or noon-ending candle for an instrument only once it is actually
   * available; an instrument absent from either map stays CLOSE_PENDING (or
   * OPEN, on the first request) and is retried on a later cycle or restart.
   */
  async requestSessionClose(
    noonBoundaryTimestamp: string,
    quotesByInstrumentId: ReadonlyMap<string, QuoteFact>,
    noonCandlesByInstrumentId: ReadonlyMap<string, CandleFact>,
  ): Promise<void> {
    const openExecutions =
      await this.deps.paperExecutionStore.findOpenAndClosePending(this.runId);
    const coordinatedPositions = this.deps.coordinationStore
      ? await this.deps.coordinationStore.findOpenPositions(this.runId)
      : [];

    const missingCloseQuoteInstrumentIds = [
      ...new Set([
        ...openExecutions
          .filter(
            (row) =>
              row.model === "QUOTE" &&
              !quotesByInstrumentId.has(row.instrumentId),
          )
          .map((row) => row.instrumentId),
        ...coordinatedPositions
          .filter(
            (position) => !quotesByInstrumentId.has(position.instrumentId),
          )
          .map((position) => position.instrumentId),
      ]),
    ];
    const persistedCloseQuotes = this.deps.paperBotStore.findSessionCloseQuotes
      ? await this.deps.paperBotStore.findSessionCloseQuotes(
          missingCloseQuoteInstrumentIds,
          noonBoundaryTimestamp,
        )
      : new Map<string, QuoteFact[]>();

    // The noon bar is only offered by the collection batch that happened to
    // contain it. An execution that missed it -- because the process was down
    // at noon, or because this is a run from an earlier session -- can only
    // ever resolve from persisted history, so fall back to it for every
    // candle row the caller had no bar for.
    const missingNoonBars = openExecutions
      .filter(
        (row) =>
          row.model === "CANDLE" &&
          !noonCandlesByInstrumentId.has(row.instrumentId),
      )
      .map((row) => row.instrumentId);
    const persistedNoonCandles =
      await this.deps.paperBotStore.findSessionCloseCandles(
        [...new Set(missingNoonBars)],
        noonBoundaryTimestamp,
      );

    // The live batch quote is preferred, but a single unusable row (halted,
    // delayed, zero size for a capacity-constrained exit) must not strand the
    // execution: advance through the real persisted post-boundary quotes in
    // timestamp order until one resolves the close. Never fabricate a price.
    const closeQuoteCandidates = (instrumentId: string): QuoteFact[] => {
      const live = quotesByInstrumentId.get(instrumentId);
      const persisted = persistedCloseQuotes.get(instrumentId) ?? [];
      return live ? [live, ...persisted] : persisted;
    };
    const resolveQuoteClose = (
      state: QuoteExecutionState,
      instrumentId: string,
    ): {
      transition: ReturnType<typeof requestQuoteSessionClose>;
      resolvedBy: QuoteFact | null;
    } => {
      const candidates = closeQuoteCandidates(instrumentId);
      let transition: ReturnType<typeof requestQuoteSessionClose> | null = null;
      let resolvedBy: QuoteFact | null = null;
      for (const candidate of candidates) {
        const result = requestQuoteSessionClose(
          state,
          noonBoundaryTimestamp,
          candidate,
          this.deps.assumptions,
        );
        if (!result.transitioned) continue;
        transition = result;
        if (result.state.status === "CLOSED") {
          resolvedBy = candidate;
          break;
        }
      }
      if (transition === null)
        transition = requestQuoteSessionClose(
          state,
          noonBoundaryTimestamp,
          candidates[0] ?? null,
          this.deps.assumptions,
        );
      return { transition, resolvedBy };
    };

    for (const row of openExecutions) {
      if (row.model === "QUOTE") {
        const state: QuoteExecutionState =
          (row.executionState as QuoteExecutionState | null) ?? {
            status: row.status,
            position: row.position,
            entryMarketSnapshot: row.entryMarketSnapshot as MarketSnapshot,
            entrySizeCoverage: row.entrySizeCoverage ?? 0,
            lastFactTimestamp: row.lastFactTimestamp,
          };
        const { transition } = resolveQuoteClose(state, row.instrumentId);
        if (transition.transitioned) {
          await this.deps.paperExecutionStore.upsertQuoteExecution(
            row.observationId,
            transition.state,
          );
        }
        continue;
      }

      const state: CandleExecutionState =
        (row.executionState as CandleExecutionState | null) ?? {
          status: row.status,
          position: row.position,
          lastFactTimestamp: row.lastFactTimestamp,
        };
      const noonCandle =
        noonCandlesByInstrumentId.get(row.instrumentId) ??
        persistedNoonCandles.get(row.instrumentId) ??
        null;
      const result = requestCandleSessionClose(
        state,
        noonCandle,
        this.deps.assumptions,
      );
      if (result.transitioned) {
        await this.deps.paperExecutionStore.upsertCandleExecution(
          row.observationId,
          result.state,
        );
      }
    }
    if (this.deps.coordinationStore) {
      for (const position of coordinatedPositions) {
        const { transition, resolvedBy } = resolveQuoteClose(
          position.state,
          position.instrumentId,
        );
        if (transition.transitioned) {
          const factTimestamp = resolvedBy?.timestamp;
          await this.deps.coordinationStore.updateQuotePosition(
            position.id,
            transition.state,
            transition.state.status === "CLOSED" && factTimestamp
              ? {
                  source:
                    resolvedBy ===
                    quotesByInstrumentId.get(position.instrumentId)
                      ? "LIVE_QUOTE"
                      : "PERSISTED_QUOTE",
                  boundary: noonBoundaryTimestamp,
                  factTimestamp,
                  delayMs: Math.max(
                    0,
                    new Date(factTimestamp).getTime() -
                      new Date(noonBoundaryTimestamp).getTime(),
                  ),
                }
              : undefined,
          );
        }
      }
    }
    await this.deps.paperBotStore.settleRunAfterCloseRequest(this.runId);
  }
}
