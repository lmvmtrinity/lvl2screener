import type {
  BacktestSignalReplayResult,
  CreateBacktest,
  MarketId,
  SetupStrategyName,
  StrategyStateEvent,
} from "@tsx-scanner/contracts";
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import {
  admitReplaySession,
  type ReplayQuoteLike,
} from "../backtests/replay-quote-admission.js";
import {
  PostgresPaperBotStore,
  type InsertObservationInput,
} from "./paper-bot-repository.js";
import { stableUuid } from "./stable-uuid.js";

export interface FundedHistoricalSignalEngine {
  runBacktestSignals(payload: unknown): Promise<BacktestSignalReplayResult>;
}

export interface FundedHistoricalProfile {
  readonly strategy: SetupStrategyName;
  readonly profileId: string;
  readonly profileName: string;
  readonly profileConfigId: string;
  readonly configVersion: string;
}

export function fundedHistoricalConfigVersion(
  parameters: CreateBacktest["parameters"],
): string {
  const ordered = Object.fromEntries(
    Object.entries(parameters).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
  const digest = createHash("sha256")
    .update(JSON.stringify(ordered))
    .digest("hex")
    .slice(0, 12);
  return `funded-historical:${digest}`;
}

export function fundedHistoricalProfiles(
  marketId: MarketId,
  strategies: readonly SetupStrategyName[],
  baseConfigVersion: string,
): FundedHistoricalProfile[] {
  return strategies.map((strategy) => {
    // `scanner_profile_config.config_version` is globally unique, so two
    // strategies replaying the same parameter set need distinct versions.
    const configVersion = `${baseConfigVersion}:${strategy}`;
    return {
      strategy,
      profileId: stableUuid(
        `funded-historical-profile:${marketId}:${strategy}`,
      ),
      profileName: `Funded historical replay · ${strategy} · ${marketId}`,
      profileConfigId: stableUuid(
        `funded-historical-profile-config:${marketId}:${strategy}:${configVersion}`,
      ),
      configVersion,
    };
  });
}

export interface FundedHistoricalObservationInput {
  readonly runId: string;
  readonly profiles: readonly FundedHistoricalProfile[];
  readonly events: readonly StrategyStateEvent[];
  readonly parameters: CreateBacktest["parameters"];
  readonly scoreCutoff: number;
}

/**
 * Maps READY strategy events to durable observations with the same shape the
 * live funded processor writes. Provenance is never invented: an event without
 * a semantic version is rejected instead of being replayed as an unknown.
 */
export function buildFundedHistoricalObservations(
  input: FundedHistoricalObservationInput,
): InsertObservationInput[] {
  const profiles = new Map(
    input.profiles.map((profile) => [profile.strategy, profile]),
  );
  const seen = new Set<string>();
  const observations: InsertObservationInput[] = [];
  for (const event of input.events) {
    if (event.state !== "READY") continue;
    const identity = event.setupInstanceId ?? event.eventId;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const profile = profiles.get(event.strategy);
    if (!profile) continue;
    const signalSemanticsVersion = event.signalSemanticsVersion;
    if (
      !signalSemanticsVersion ||
      signalSemanticsVersion.trim() === "" ||
      signalSemanticsVersion === "UNKNOWN"
    )
      throw new Error(
        `Funded historical replay requires signal semantic provenance for event ${event.eventId}`,
      );
    const eligible = event.score >= input.scoreCutoff;
    observations.push({
      runId: input.runId,
      sourceEventId: stableUuid(
        `funded-historical-event:${input.runId}:${profile.profileConfigId}:${event.instrumentId}:${event.timestamp}:${identity}`,
      ),
      sourceSignalId: null,
      setupInstanceId: event.setupInstanceId,
      instrumentId: event.instrumentId,
      symbol: event.symbol,
      profileId: profile.profileId,
      profileName: profile.profileName,
      profileConfigId: profile.profileConfigId,
      configVersion: profile.configVersion,
      profileParameters: input.parameters,
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
      sourceEventPayload: {
        ...event,
        signalSemanticsVersion,
        replayLineage: {
          type: "FUNDED_HISTORICAL_REPLAY",
          runId: input.runId,
          configVersion: profile.configVersion,
        },
      },
      eligibilityStatus: eligible ? "ELIGIBLE" : "BELOW_SCORE_CUTOFF",
      eligibilityReason: eligible ? null : "SCORE_CUTOFF",
    });
  }
  return observations;
}

export async function ensureFundedHistoricalProfiles(
  pool: Pool,
  profiles: readonly FundedHistoricalProfile[],
  marketId: MarketId,
  parameters: CreateBacktest["parameters"],
): Promise<void> {
  for (const profile of profiles) {
    const definition = await pool.query<{ id: string }>(
      "SELECT id FROM strategy_definition WHERE strategy_key=$1 AND version=$2 AND analysis_kind='SETUP'",
      [profile.strategy, "1.0.0"],
    );
    const strategyDefinitionId = definition.rows[0]?.id;
    if (!strategyDefinitionId)
      throw new Error(
        `Funded historical replay requires a SETUP strategy definition for ${profile.strategy}`,
      );
    await pool.query(
      `INSERT INTO scanner_profile (id,name,strategy_definition_id,enabled,display_order,market_id)
       VALUES ($1,$2,$3,false,0,$4) ON CONFLICT (id) DO NOTHING`,
      [profile.profileId, profile.profileName, strategyDefinitionId, marketId],
    );
    await pool.query(
      `INSERT INTO scanner_profile_config (id,profile_id,config_version,parameters,market_id)
       VALUES ($1,$2,$3,$4::jsonb,$5) ON CONFLICT (id) DO NOTHING`,
      [
        profile.profileConfigId,
        profile.profileId,
        profile.configVersion,
        JSON.stringify(parameters),
        marketId,
      ],
    );
    const resolved = await pool.query<{ id: string }>(
      "SELECT id FROM scanner_profile_config WHERE config_version=$1",
      [profile.configVersion],
    );
    if (resolved.rows[0]?.id !== profile.profileConfigId)
      throw new Error(
        `Funded historical replay profile config ${profile.configVersion} is owned by another profile`,
      );
  }
}

export interface FundedHistoricalBridgeInput {
  readonly pool: Pool;
  readonly runId: string;
  readonly marketId: MarketId;
  readonly session: Record<string, unknown> & {
    readonly quotes?: readonly ReplayQuoteLike[];
    readonly candles?: readonly unknown[];
    readonly session?: { readonly instruments?: readonly unknown[] };
  };
  readonly request: CreateBacktest;
  readonly engine: FundedHistoricalSignalEngine;
}

export interface FundedHistoricalBridgeResult {
  readonly eventCount: number;
  readonly observationCount: number;
  readonly eligibleObservationCount: number;
  readonly excludedQuoteCount: number;
}

/**
 * Runs the production signal replay for one retained session and persists the
 * READY events as funded observations. The scanner payload uses the same quote
 * admission as independent replay; execution never sees invalid quotes.
 */
export async function bridgeFundedHistoricalSession(
  input: FundedHistoricalBridgeInput,
): Promise<FundedHistoricalBridgeResult> {
  const rawQuoteCount = input.session.quotes?.length ?? 0;
  const admittedSession = admitReplaySession(input.session);
  const admittedQuoteCount = admittedSession.quotes?.length ?? 0;
  const configVersion = fundedHistoricalConfigVersion(input.request.parameters);
  const profiles = fundedHistoricalProfiles(
    input.marketId,
    input.request.strategies,
    configVersion,
  );
  const metadata = {
    runId: input.runId,
    marketId: input.marketId,
    configVersion,
    strategies: input.request.strategies,
    parameters: input.request.parameters,
    assumptions: {
      startingCapital: input.request.startingCapital,
      positionSize: input.request.positionSize,
      slippageBps: input.request.slippageBps,
      feePerTrade: input.request.feePerTrade,
    },
  };
  const replay = await input.engine.runBacktestSignals({
    ...metadata,
    sessions: [admittedSession],
  });
  await ensureFundedHistoricalProfiles(
    input.pool,
    profiles,
    input.marketId,
    input.request.parameters,
  );
  const observations = buildFundedHistoricalObservations({
    runId: input.runId,
    profiles,
    events: replay.events,
    parameters: input.request.parameters,
    scoreCutoff: input.request.parameters.scoreCutoff,
  });
  const store = new PostgresPaperBotStore(input.pool);
  for (const observation of observations)
    await store.insertObservation(observation);
  return {
    eventCount: replay.events.filter((event) => event.state === "READY").length,
    observationCount: observations.length,
    eligibleObservationCount: observations.filter(
      (observation) => observation.eligibilityStatus === "ELIGIBLE",
    ).length,
    excludedQuoteCount: rawQuoteCount - admittedQuoteCount,
  };
}
