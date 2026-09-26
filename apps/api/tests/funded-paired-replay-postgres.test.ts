import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  BacktestSignalReplayResult,
  CreateBacktest,
  StrategyStateEvent,
} from "@tsx-scanner/contracts";
import {
  createBacktestSchema,
  FUNDED_COMPARISON_CHALLENGER_POLICY_VERSION,
  fundedExecutionInferenceOutputSchema,
  fundedExecutionModelArtifactSchema,
} from "@tsx-scanner/contracts";
import { PostgresBacktestStore } from "../src/backtests/backtest-repository.js";
import { migrate } from "../src/database/migrate.js";
import { isolatedDatabaseUrl } from "./isolated-database.js";
import {
  FundedComparisonRepository,
  type FundedComparisonSessionFreeze,
} from "../src/paper-bot/funded-comparison-repository.js";
import {
  buildFundedComparisonSpecification,
  fundedComparisonTrainingSessionDigest,
  type FundedComparisonSpecificationInput,
} from "../src/paper-bot/funded-comparison-specification.js";
import {
  freezeFundedComparisonSharedInput,
  type FundedComparisonFrozenInput,
} from "../src/paper-bot/funded-comparison-input-freezer.js";
import {
  championReplayAccountId,
  challengerReplayAccountId,
  runFundedPairedComparison,
} from "../src/paper-bot/funded-paired-runner.js";
import {
  createFundedComparisonReplayEvidenceSource,
  FundedComparisonService,
  PostgresFundedComparisonEvidenceSource,
} from "../src/paper-bot/funded-comparison-service.js";
import {
  fundedExecutionArtifactDigest,
  fundedExecutionTrainingPartitionDigest,
} from "../src/statistical-models/funded-execution-digest.js";
import { FundedReportingService } from "../src/paper-bot/funded-reporting-service.js";
import { PostgresFundedLedgerStore } from "../src/paper-bot/funded-ledger-repository.js";
import { FundedOrderService } from "../src/paper-bot/funded-order-service.js";
import {
  buildFundedHistoricalObservations,
  ensureFundedHistoricalProfiles,
  fundedHistoricalConfigVersion,
  fundedHistoricalProfiles,
} from "../src/paper-bot/funded-historical-signal-bridge.js";
import { replayFundedHistoricalSession } from "../src/paper-bot/funded-replay-service.js";
import { PostgresPaperBotStore } from "../src/paper-bot/paper-bot-repository.js";
import { fundedPolicy } from "../src/paper-bot/funded-policy.js";
import { contentHash } from "../src/paper-bot/funded-evidence-digest.js";
import { CancelledError } from "../src/worker/research-worker.js";

const databaseUrl =
  isolatedDatabaseUrl("AUDIT_TEST_DATABASE_URL") ??
  isolatedDatabaseUrl("PERSISTENCE_TEST_DATABASE_URL");
const marketId = "CA_TSX" as const;
const currency = "CAD" as const;
const digestA = "a".repeat(64);
const digestB = "b".repeat(64);
const sessions = ["2026-09-14", "2026-09-15", "2026-09-16"] as const;
const trainingSessions = ["2026-09-09", "2026-09-10"] as const;
const trainingRowDigests = ["1".repeat(64), "2".repeat(64)];
const fixturePath = new URL(
  "../../../services/scanner/tests/fixtures/funded_execution_result.json",
  import.meta.url,
);
const fixtureArtifact = fundedExecutionModelArtifactSchema.parse(
  JSON.parse(readFileSync(fixturePath, "utf8")).artifact,
);
const assumptions = {
  positionSize: 1_000,
  slippageBps: 0,
  feePerTrade: 0,
  costs: {
    entryCommission: 0,
    exitCommission: 0,
    estimatedRegulatoryFees: 0,
    slippageBps: 0,
    currency,
    brokerPricingVersion: "fp03-task12-costs-v1",
  },
  stopMethod: "STRUCTURAL",
  atrStopMultiple: 1,
  rewardRiskRatio: null,
  maxQuoteAgeSeconds: 30,
  sessionTimezone: "America/Toronto",
  noonCloseTime: "16:00",
  riskBudget: 1_000,
  maxNotional: 1_500,
  executionMode: "CAPACITY_CONSTRAINED",
  latencyMs: 0,
} as const;
const sourcePolicy = fundedPolicy(1, 0);
const sourcePolicyDigest = contentHash(sourcePolicy);
const sourceAssumptionsDigest = contentHash(assumptions);
const replayPolicy = {
  timezone: "America/Toronto" as const,
  openingRange: { start: "09:30", end: "09:45" },
  scanning: { start: "09:45", end: "16:00" },
  entries: { preferredStart: "09:45", preferredEnd: "15:30", hardEnd: "15:45" },
};

function independentCanonicalValue(value: unknown): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(independentCanonicalValue);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .filter((key) => record[key] !== undefined)
        .map((key) => [key, independentCanonicalValue(record[key])]),
    );
  }
  return value;
}

function independentHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(independentCanonicalValue(value)))
    .digest("hex");
}

describe.skipIf(!databaseUrl)(
  "funded paired replay PostgreSQL acceptance",
  () => {
    let pool: Pool;
    let repository: FundedComparisonRepository;
    let baselineRunId: string;
    let championRunId: string;
    let championAccountId: string;
    let challengerId: string;
    let datasetId: string;
    let instrumentIds: string[];
    let negativeInstrumentId: string;
    let negativeRunId: string;
    let negativeAccountId: string;
    let liveSourceRunId: string;
    let liveSourceAccountId: string;
    let frozen: FundedComparisonFrozenInput;
    let artifact: typeof fixtureArtifact;
    let comparisonCohortDigest: string;

    beforeAll(async () => {
      pool = new Pool({ connectionString: databaseUrl, max: 12 });
      await migrate(pool);
      await pool.query(`TRUNCATE funded_comparison_failure,funded_comparison_result,
      funded_comparison_session_metric,funded_comparison_policy_evaluation,
      funded_comparison_run_binding,funded_comparison_provisioning_intent,
      funded_comparison_input_chunk,funded_comparison_spec_opportunity,
      funded_comparison_spec_session,funded_comparison_spec,
      funded_execution_prediction,funded_execution_challenger,
      funded_execution_dataset_member,funded_execution_dataset,
      funded_decision_outcome,funded_decision_intent,funded_decision_refusal,
      funded_decision_evidence,paper_funded_fact,paper_funded_event,
      paper_entry_order,paper_funded_run,paper_funded_account,
      paper_signal_observation,paper_bot_run,backtest_run,
      scanner_profile_config,scanner_profile,strategy_definition,instrument CASCADE`);
      repository = new FundedComparisonRepository(pool);
      await installFixtures();
      frozen = await freezeFundedComparisonSharedInput(
        {
          baselineRunId,
          marketId,
          evidenceCutoffAt: "2026-09-16T21:00:00.000Z",
          maxSessions: sessions.length,
          replayPolicy,
        },
        {
          pool,
          store: new PostgresBacktestStore(pool),
          engine: {
            runBacktestSignals: async (payload) => {
              const replayPayload = payload as {
                sessions: readonly { session: { startTime: string } }[];
              };
              const sessionDate = String(
                replayPayload.sessions[0]!.session.startTime,
              ).slice(0, 10);
              return {
                events: sourceEvents(sessionDate),
              } as BacktestSignalReplayResult;
            },
          },
        },
      );
    }, 240_000);

    afterAll(async () => {
      await pool?.end();
    });

    function sourceEvents(sessionDate: string): StrategyStateEvent[] {
      return sourceEventsFor(sessionDate, instrumentIds);
    }

    function sourceEventsFor(
      sessionDate: string,
      sourceInstrumentIds: readonly string[],
    ): StrategyStateEvent[] {
      return sourceInstrumentIds.map((instrumentId, index) => ({
        eventId: randomUUID(),
        strategy: "ORB_RETEST",
        strategyVersion: "1.0.0",
        instrumentId,
        symbol: `FP03TASK12_${index}`,
        timestamp: `${sessionDate}T14:30:00.000Z`,
        state: "READY",
        score: 70 - index,
        reasonCodes: ["BREAKOUT"],
        setupInstanceId: randomUUID(),
        signalSemanticsVersion: "setup-semantics-v2",
        featureSnapshot: {
          featureVersion: "features-v1",
          atr14: 0.2,
          spreadPct: 0.001,
        },
        entryReference: 10,
        stopReference: 9.8,
        targetReference: 11,
      })) as unknown as StrategyStateEvent[];
    }

    async function insertQuotes(sessionDate: string): Promise<void> {
      for (const instrumentId of instrumentIds)
        await pool.query(
          `INSERT INTO quote_snapshot(
        instrument_id,timestamp,bid,ask,bid_size,ask_size,last,last_size,day_volume,day_open,day_high,day_low,
        spread_absolute,spread_pct,is_delayed,is_halted,source,size_unit,size_multiplier)
        VALUES($1,$2,10,10,1000,1000,10,1000,1000,10,11,9,0,0,false,false,'FP03_TASK12','SHARES',1),
        ($1,$3,11,11,1000,1000,11,1000,2000,10,11,9,0,0,false,false,'FP03_TASK12','SHARES',1)`,
          [
            instrumentId,
            `${sessionDate}T14:30:00.000Z`,
            `${sessionDate}T14:45:00.000Z`,
          ],
        );
    }

    async function installFixtures(): Promise<void> {
      baselineRunId = randomUUID();
      championRunId = randomUUID();
      championAccountId = randomUUID();
      datasetId = randomUUID();
      instrumentIds = [randomUUID(), randomUUID()];
      const definitionId = randomUUID();
      await pool.query(
        `INSERT INTO strategy_definition(id,strategy_key,version,name,description,analysis_kind) VALUES($1,'ORB_RETEST','1.0.0','ORB retest','acceptance','SETUP')`,
        [definitionId],
      );
      for (const [index, id] of instrumentIds.entries())
        await pool.query(
          `INSERT INTO instrument(id,questrade_symbol_id,symbol,description,exchange,currency,security_type,industry_sector,is_quotable,is_tradable,active,market_id) VALUES($1,$2,$3,'task12','TSX','CAD','Stock','Technology',true,true,true,$4)`,
          [id, 1987654300 + index, `FP03TASK12_${index}`, marketId],
        );
      negativeInstrumentId = randomUUID();
      await pool.query(
        `INSERT INTO instrument(id,questrade_symbol_id,symbol,description,exchange,currency,security_type,industry_sector,is_quotable,is_tradable,active,market_id) VALUES($1,$2,$3,'task12 stale mark','TSX','CAD','Stock','Technology',true,true,true,$4)`,
        [negativeInstrumentId, 1987654399, "FP03TASK12_STALE", marketId],
      );
      const replayInput = {
        version: "replay-input-v1",
        marketId,
        resolvedAt: "2026-09-16T20:30:00.000Z",
        requestedSymbols: instrumentIds.map(
          (_, index) => `FP03TASK12_${index}`,
        ),
        candidateInstruments: instrumentIds.map((id, index) => ({
          instrumentId: id,
          symbol: `FP03TASK12_${index}`,
          sector: "Technology",
        })),
        benchmarks: [],
        universeRefreshRunId: null,
        capturedHistoryAvailability: {
          source: "CAPTURED_QUOTES",
          observedAt: "2026-09-16T20:30:00.000Z",
          tables: {
            quoteSnapshot: {
              earliest: "2026-09-14T13:30:00.000Z",
              latest: "2026-09-16T14:45:00.000Z",
            },
            candle: { earliest: null, latest: null },
          },
          replay: { earliestDate: sessions[0], latestDate: sessions.at(-1) },
        },
        warnings: [],
        candidateProvenance: "EXPLICIT_CAPTURED_COHORT",
        sessions: [],
        inputHash: digestA,
      };
      await pool.query(
        `INSERT INTO backtest_run(id,market_id,name,status,start_date,end_date,strategies,symbols,data_source,strategy_version,config_version,execution_model_version,starting_capital,position_size,slippage_bps,fee_per_trade,parameters,metrics,analyses,data_quality,replay_input,completed_at)
      VALUES($1,$2,'fp03 task12 baseline','COMPLETED','2026-09-09','2026-09-16',$3::jsonb,$4::jsonb,'CAPTURED_QUOTES','2026-09-01','config-1','execution-v1',25000,1000,2,1,$5::jsonb,
        '{"signalsGenerated":6,"readySignals":6,"tradesSimulated":4,"wins":4,"losses":0,"winRate":1,"averageWin":100,"averageLoss":0,"averageR":1,"medianR":1,"profitFactor":null,"expectancy":1,"netPnl":400,"maximumDrawdown":0,"maximumDrawdownPct":0,"falseBreakoutRate":0,"signalToTradeConversion":0.667,"averageHoldMinutes":15}'::jsonb,
        '[]'::jsonb,'{"quoteSnapshots":12,"candles":0,"sessions":3,"spread":"CAPTURED","warnings":[]}'::jsonb,$6::jsonb,'2026-09-16T20:30:00.000Z')`,
        [
          baselineRunId,
          marketId,
          JSON.stringify(["ORB_RETEST"]),
          JSON.stringify(
            instrumentIds.map((_, index) => `FP03TASK12_${index}`),
          ),
          JSON.stringify({ scoreCutoff: 60, rvolAtTimeMin: 1.5 }),
          JSON.stringify(replayInput),
        ],
      );
      for (const sessionDate of sessions) await insertQuotes(sessionDate);
      await pool.query(
        `INSERT INTO quote_snapshot(
          instrument_id,timestamp,bid,ask,bid_size,ask_size,last,last_size,day_volume,day_open,day_high,day_low,
          spread_absolute,spread_pct,is_delayed,is_halted,source,size_unit,size_multiplier)
         VALUES($1,$2,10,10,1000,1000,10,1000,1000,10,10,10,0,0,false,false,'FP03_TASK12','SHARES',1)`,
        [negativeInstrumentId, `${sessions[0]}T14:30:00.000Z`],
      );
      await new PostgresFundedLedgerStore(pool).ensure(championAccountId, [
        currency,
        25_000,
        sessions[0],
        `${sessions[0]}T13:30:00.000Z`,
        2_500,
      ]);
      await pool.query(
        `INSERT INTO paper_bot_run(id,source,market_id,session_date,session_timezone,scheduled_close_at,status,execution_model_version,assumptions,started_at) VALUES($1,'BACKTEST',$2,$3,'America/Toronto',$4,'RUNNING','execution-v1',$5::jsonb,$6)`,
        [
          championRunId,
          marketId,
          sessions[0],
          `${sessions[0]}T20:00:00.000Z`,
          JSON.stringify(assumptions),
          `${sessions[0]}T13:30:00.000Z`,
        ],
      );
      await new FundedOrderService(
        pool,
        championRunId,
        championAccountId,
        currency,
      ).bind(sourcePolicy, {
        session: sessions[0],
        at: `${sessions[0]}T13:30:00.000Z`,
      });
      const parameters = {
        scoreCutoff: 60,
        rvolAtTimeMin: 1.5,
      } as CreateBacktest["parameters"];
      const profiles = fundedHistoricalProfiles(
        marketId,
        ["ORB_RETEST"],
        fundedHistoricalConfigVersion(parameters),
      );
      await ensureFundedHistoricalProfiles(
        pool,
        profiles,
        marketId,
        parameters,
      );
      const sourceStore = new PostgresPaperBotStore(pool);
      for (const observation of buildFundedHistoricalObservations({
        runId: championRunId,
        profiles,
        events: sourceEvents(sessions[0]),
        parameters,
        scoreCutoff: 60,
      })) {
        // The retained training run is deliberately fixture-built with the
        // same scanner semantics as the comparison replay.  The production
        // decision capture hashes this provenance, so using the historical
        // bridge's default lineage here would correctly (but undesirably for
        // this acceptance fixture) reject every prediction as a cohort miss.
        await sourceStore.insertObservation({
          ...observation,
          sourceEventPayload: {
            ...(observation.sourceEventPayload as Record<string, unknown>),
            replayLineage: {
              type: "FUNDED_COMPARISON_REPLAY",
              runId: championRunId,
              configVersion: profiles[0]!.configVersion,
            },
          },
        });
      }
      await replayFundedHistoricalSession(pool, championRunId, true);
      await sourceStore.completeRun(championRunId);
      // Keep an independent LIVE authority row in the same disposable
      // database.  The comparison itself consumes the retained BACKTEST
      // source because the historical replay entry point intentionally rejects
      // LIVE runs; the LIVE row proves that the comparison does not mutate the
      // live run/account/policy boundary while it executes.
      const liveSource = await sourceStore.startOrResumeLiveRun({
        source: "LIVE",
        marketId,
        sessionDate: sessions[0],
        sessionTimezone: assumptions.sessionTimezone,
        scheduledCloseAt: `${sessions[0]}T20:00:00.000Z`,
        executionModelVersion: "execution-v1",
        assumptions,
      });
      liveSourceRunId = liveSource.id;
      liveSourceAccountId = randomUUID();
      await new PostgresFundedLedgerStore(pool).ensure(liveSourceAccountId, [
        currency,
        25_000,
        sessions[0],
        `${sessions[0]}T13:30:00.000Z`,
        2_500,
      ]);
      await new FundedOrderService(
        pool,
        liveSourceRunId,
        liveSourceAccountId,
        currency,
      ).bind(sourcePolicy, {
        session: sessions[0],
        at: `${sessions[0]}T13:30:00.000Z`,
      });
      await sourceStore.completeRun(liveSourceRunId);
      comparisonCohortDigest = (
        await pool.query<{ cohort_digest: string }>(
          `SELECT cohort_digest FROM funded_decision_evidence
           WHERE run_id=$1 ORDER BY sequence LIMIT 1`,
          [championRunId],
        )
      ).rows[0]!.cohort_digest;
      negativeRunId = randomUUID();
      negativeAccountId = randomUUID();
      await new PostgresFundedLedgerStore(pool).ensure(negativeAccountId, [
        currency,
        25_000,
        sessions[0],
        `${sessions[0]}T13:30:00.000Z`,
        2_500,
      ]);
      await pool.query(
        `INSERT INTO paper_bot_run(id,source,market_id,session_date,session_timezone,scheduled_close_at,status,execution_model_version,assumptions,started_at) VALUES($1,'BACKTEST',$2,$3,'America/Toronto',$4,'RUNNING','execution-v1',$5::jsonb,$6)`,
        [
          negativeRunId,
          marketId,
          sessions[0],
          `${sessions[0]}T20:00:00.000Z`,
          JSON.stringify(assumptions),
          `${sessions[0]}T13:30:00.000Z`,
        ],
      );
      await new FundedOrderService(
        pool,
        negativeRunId,
        negativeAccountId,
        currency,
      ).bind(sourcePolicy, {
        session: sessions[0],
        at: `${sessions[0]}T13:30:00.000Z`,
      });
      const negativeStore = new PostgresPaperBotStore(pool);
      for (const observation of buildFundedHistoricalObservations({
        runId: negativeRunId,
        profiles,
        events: sourceEventsFor(sessions[0], [negativeInstrumentId]),
        parameters,
        scoreCutoff: 60,
      }))
        await negativeStore.insertObservation(observation);
      await replayFundedHistoricalSession(pool, negativeRunId, true);
      artifact = {
        ...fixtureArtifact,
        trainingPartitionDigest:
          fundedExecutionTrainingPartitionDigest(trainingRowDigests),
      };
      await pool.query(
        `INSERT INTO funded_execution_dataset(id,market_id,currency,source_kind,evidence_schema_version,cohort_digest,cohort_components,dataset_policy_version,label_mapping_version,feature_version,qualification_policy_version,requested_cutoff,effective_cutoff,membership_digest,dataset_digest,row_count,counts,qualification_receipt,source_watermark,activation_eligible) VALUES($1,$2,$3,'HISTORICAL_REPLAY',2,$4,'{}'::jsonb,'funded-execution-dataset-v1','funded-execution-labels-v1','funded-execution-features-v1','funded-execution-qualification-v1','2026-09-11T20:00:00.000Z','2026-09-11T20:00:00.000Z',$5,$6,2,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,false)`,
        [
          datasetId,
          marketId,
          currency,
          comparisonCohortDigest,
          digestA,
          artifact.sourceDatasetDigest,
        ],
      );
      const evidence = await pool.query<{
        observation_id: string;
        sequence: number;
        content_digest: string;
        decision_at: Date;
      }>(
        `SELECT observation_id,sequence,content_digest,decision_at FROM funded_decision_evidence WHERE run_id=$1 ORDER BY sequence`,
        [championRunId],
      );
      for (const [ordinal, row] of evidence.rows.entries())
        await pool.query(
          `INSERT INTO funded_execution_dataset_member(dataset_id,ordinal,market_id,currency,run_id,observation_id,account_id,decision_sequence,decision_content_digest,cohort_digest,evidence_schema_version,decision_at,session_date,partition,label_available_at,label_economic_at,source_kind,label_mapping_version,feature_version,features,labels,outcome_sequences,outcome_source_digests,row_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,2,$11,$12,'TRAIN','2026-09-11T20:00:00.000Z',$11,'HISTORICAL_REPLAY','funded-execution-labels-v1','funded-execution-features-v1','{}'::jsonb,'{}'::jsonb,'{}','{}',$13)`,
          [
            datasetId,
            ordinal,
            marketId,
            currency,
            championRunId,
            row.observation_id,
            championAccountId,
            row.sequence,
            row.content_digest,
            comparisonCohortDigest,
            row.decision_at,
            trainingSessions[ordinal],
            trainingRowDigests[ordinal],
          ],
        );
      challengerId = randomUUID();
      await pool.query(
        `INSERT INTO funded_execution_challenger(id,market_id,currency,cohort_digest,cohort_components,dataset_id,dataset_digest,model_version,model_type,artifact_digest,feature_version,label_mapping_version,qualification_policy_version,training_policy_version,training_code_version,status,eligible_for_activation,active,artifact,metrics,sample_counts) VALUES($1,$2,$3,$4,'{}'::jsonb,$5,$6,'funded-execution-v1','FUNDED_EXECUTION_QUALITY',$7,'funded-execution-features-v1','funded-execution-labels-v1','funded-execution-qualification-v1','funded-execution-training-v1','task12','INACTIVE',false,false,$8::jsonb,'{}'::jsonb,'{}'::jsonb)`,
        [
          challengerId,
          marketId,
          currency,
          comparisonCohortDigest,
          datasetId,
          artifact.sourceDatasetDigest,
          fundedExecutionArtifactDigest(artifact),
          JSON.stringify(artifact),
        ],
      );
    }

    async function saveSpec(
      overrides: Partial<FundedComparisonSpecificationInput> = {},
      shared = frozen,
    ) {
      const input: FundedComparisonSpecificationInput = {
        marketId,
        baseline: {
          backtestRunId: baselineRunId,
          configVersion: "config-1",
          strategyKeys: ["ORB_RETEST"],
          startDate: "2026-09-09",
          endDate: "2026-09-16",
          executionModelVersion: "execution-v1",
          replayInputDigest: digestA,
          baselineResultDigest: digestB,
          completedAt: "2026-09-16T20:30:00.000Z",
        },
        sessionDates: [...sessions],
        sessions: shared.sessions.map((row) => ({
          sessionDate: row.sessionDate,
          itemCount: row.itemCount,
          chunkCount: row.chunkCount,
          sessionInputDigest: row.sessionInputDigest,
        })),
        replay: {
          request: createBacktestSchema.parse(shared.replay.request),
          profiles: shared.replay.profiles,
        },
        opportunities: shared.opportunities,
        champion: {
          kind: "DETERMINISTIC_FUNDED_POLICY",
          fundedPolicyVersion: "funded-cash-v1",
          portfolioPolicyVersion: "funded-portfolio-v2",
          policyDigest: sourcePolicyDigest,
          sourceLiveRunId: liveSourceRunId,
          sourceAccountId: liveSourceAccountId,
          executionModelVersion: "execution-v1",
          costPolicyVersion: "fp03-task12-costs-v1",
          participationVersion: "participation-v1",
          runtimeVersion: "task12-runtime-v1",
          accountAssumptionDigest: digestB,
          assumptionsDigest: sourceAssumptionsDigest,
        },
        challenger: {
          kind: "FUNDED_EXECUTION_POLICY_V1",
          policyVersion: FUNDED_COMPARISON_CHALLENGER_POLICY_VERSION,
          policyDigest: digestB,
          model: {
            modelId: challengerId,
            modelVersion: "funded-execution-v1",
            artifactDigest: fundedExecutionArtifactDigest(artifact),
            datasetDigest: artifact.sourceDatasetDigest,
            cohortDigest: comparisonCohortDigest,
            featureVersion: "funded-execution-features-v1",
            predictionPolicyVersion: "funded-execution-prediction-v1",
            trainingPartitionDigest: artifact.trainingPartitionDigest,
            trainingEvidenceCutoffAt: "2026-09-11T20:00:00.000Z",
            trainingSessionDigest:
              fundedComparisonTrainingSessionDigest(trainingSessions),
          },
        },
        capital: {
          initialCash: 25_000,
          dailyLossLimit: 2_500,
          riskConfigurationDigest: digestA,
        },
        training: {
          trainingSessionDates: [...trainingSessions],
          trainingKnowledgeCutoffAt: "2026-09-11T20:00:00.000Z",
          trainingPartitionDigest: artifact.trainingPartitionDigest,
          trainingSessionDigest:
            fundedComparisonTrainingSessionDigest(trainingSessions),
        },
        lastInputEffectiveAt: shared.lastInputEffectiveAt,
        evidenceCutoffAt: "2026-09-16T21:00:00.000Z",
        specificationFrozenAt: "2026-09-16T22:00:00.000Z",
        ...overrides,
      };
      const receipt = await repository.saveSpecification({
        build: () => ({
          specification: buildFundedComparisonSpecification(input),
          sessions:
            shared.sessions as unknown as FundedComparisonSessionFreeze[],
        }),
      });
      return receipt;
    }

    // The production tables reject mutation. This helper models an external
    // storage-corruption/missing-row condition in the disposable acceptance
    // database; no economic rows are inserted or rewritten by the fixture.
    async function corruptDelete(text: string, values: unknown[]) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL session_replication_role='replica'");
        await client.query(text, values);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    }

    async function economicSnapshot(specId: string) {
      const bindings = await repository.listBindings(specId);
      const receipt = await repository.loadSpecification(specId);
      if (!receipt) throw new Error(`missing specification ${specId}`);
      const runIds = bindings.map((binding) => binding.runId);
      const accountIds = bindings.map((binding) => binding.accountId);
      const [facts, orders, events, accounts] = await Promise.all([
        pool.query(
          `SELECT run_id,fact_id,fact_at,processed_at,applied_sequence,
                  fact::text AS fact_json,outcome::text AS outcome_json
             FROM paper_funded_fact WHERE run_id=ANY($1::uuid[])
            ORDER BY run_id,fact_id`,
          [runIds],
        ),
        pool.query(
          `SELECT order_id,run_id,revision,last_fact_id,state::text AS state_json,
                  submission::text AS submission_json
             FROM paper_entry_order WHERE run_id=ANY($1::uuid[])
            ORDER BY run_id,order_id,revision`,
          [runIds],
        ),
        pool.query(
          `SELECT account_id,event_id,event_sequence,event_sequence_verified,
                  fact_run_id,fact_id,event::text AS event_json
             FROM paper_funded_event WHERE account_id=ANY($1::uuid[])
            ORDER BY account_id,event_sequence,event_id`,
          [accountIds],
        ),
        pool.query(
          `SELECT id,revision,state::text AS state_json,initial_state::text AS initial_state_json,
                  checkpoint_sequence,events_since_checkpoint
             FROM paper_funded_account WHERE id=ANY($1::uuid[])
            ORDER BY id`,
          [accountIds],
        ),
      ]);
      return {
        bindings,
        opportunities: receipt.opportunities,
        facts: facts.rows,
        orders: orders.rows,
        events: events.rows,
        accounts: accounts.rows,
      };
    }

    function comparableEconomicSnapshot(
      snapshot: Awaited<ReturnType<typeof economicSnapshot>>,
    ) {
      const runRole = new Map(
        snapshot.bindings.map((binding) => [
          binding.runId,
          `${binding.side}:${binding.sessionDate}`,
        ]),
      );
      const accountRole = new Map(
        snapshot.bindings.map((binding) => [binding.accountId, binding.side]),
      );
      const replaceIds = (
        value: unknown,
        replacements: Map<string, string>,
      ): unknown => {
        if (typeof value === "string") {
          let result = value;
          for (const [from, to] of replacements)
            result = result.split(from).join(to);
          return result;
        }
        if (Array.isArray(value))
          return value.map((item) => replaceIds(item, replacements));
        if (value && typeof value === "object") {
          const record = value as Record<string, unknown>;
          return Object.fromEntries(
            Object.keys(record)
              .sort()
              .map((key) => [key, replaceIds(record[key], replacements)]),
          );
        }
        return value;
      };
      const baseReplacements = new Map<string, string>();
      for (const binding of snapshot.bindings) {
        baseReplacements.set(
          binding.runId,
          `${binding.side}:${binding.sessionDate}`,
        );
        baseReplacements.set(binding.accountId, binding.side);
      }
      const opportunities = snapshot.opportunities.map((opportunity) => ({
        ...opportunity,
        key: `${opportunity.sessionDate}:${opportunity.instrumentId}:${opportunity.signalTimestamp}`,
      }));
      const factIdentity = (value: unknown) => {
        const fact = value as {
          instrumentId?: string;
          signalTimestamp?: string;
          at?: string;
          orderId?: string;
          order?: {
            instrumentId?: string;
            orderId?: string;
            signal?: { signalTimestamp?: string };
          };
        };
        return {
          instrumentId: fact.instrumentId ?? fact.order?.instrumentId,
          timestamp:
            fact.signalTimestamp ??
            fact.order?.signal?.signalTimestamp ??
            fact.at,
          orderId: fact.orderId ?? fact.order?.orderId,
        };
      };
      const opportunityRole = (
        runId: string,
        instrumentId: string | undefined,
        timestamp: string | undefined,
      ) => {
        const binding = snapshot.bindings.find(
          (candidate) => candidate.runId === runId,
        );
        const exact = opportunities.find(
          (candidate) =>
            candidate.sessionDate === binding?.sessionDate &&
            candidate.instrumentId === instrumentId &&
            candidate.signalTimestamp === timestamp,
        );
        return (
          exact?.sourceOpportunityId ?? instrumentId ?? "UNKNOWN_OPPORTUNITY"
        );
      };
      const factRows = snapshot.facts.map((row) => {
        const fact = JSON.parse(row.fact_json) as { type?: string };
        const identity = factIdentity(JSON.parse(row.fact_json));
        const role = runRole.get(row.run_id) ?? row.run_id;
        const opportunity = opportunityRole(
          row.run_id,
          identity.instrumentId,
          identity.timestamp,
        );
        const factRole = `${role}:${opportunity}:${fact.type ?? "FACT"}:${row.applied_sequence ?? row.fact_at}`;
        return { row, factRole };
      });
      const factRoleByRun = new Map<string, Map<string, string>>();
      const orderReferenceRoleByRun = new Map<string, Map<string, string>>();
      for (const { row, factRole } of factRows) {
        const byFact =
          factRoleByRun.get(row.run_id) ?? new Map<string, string>();
        byFact.set(row.fact_id, factRole);
        factRoleByRun.set(row.run_id, byFact);
        const identity = factIdentity(JSON.parse(row.fact_json));
        if (identity.orderId) {
          const opportunity = opportunityRole(
            row.run_id,
            identity.instrumentId,
            identity.timestamp,
          );
          const byOrder =
            orderReferenceRoleByRun.get(row.run_id) ??
            new Map<string, string>();
          byOrder.set(
            identity.orderId,
            `${runRole.get(row.run_id) ?? row.run_id}:${opportunity}:ORDER`,
          );
          orderReferenceRoleByRun.set(row.run_id, byOrder);
        }
      }
      const orderRolesByRun = new Map<string, Map<string, string>>();
      for (const row of snapshot.orders) {
        const role = runRole.get(row.run_id) ?? row.run_id;
        const matchingFact = factRows.find(
          ({ row: factRow }) =>
            factRow.run_id === row.run_id &&
            factRow.fact_json.includes(row.order_id),
        );
        const fact = matchingFact
          ? factIdentity(JSON.parse(matchingFact.row.fact_json))
          : undefined;
        const opportunity = opportunityRole(
          row.run_id,
          fact?.instrumentId,
          fact?.timestamp,
        );
        const orderRole = `${role}:${opportunity}:ORDER`;
        const byOrder =
          orderRolesByRun.get(row.run_id) ?? new Map<string, string>();
        byOrder.set(row.order_id, orderRole);
        orderRolesByRun.set(row.run_id, byOrder);
      }
      const eventSequenceBase = new Map<string, number>();
      for (const row of snapshot.events) {
        const sequence = Number(row.event_sequence);
        const previous = eventSequenceBase.get(row.account_id);
        if (
          Number.isFinite(sequence) &&
          (previous === undefined || sequence < previous)
        )
          eventSequenceBase.set(row.account_id, sequence);
      }
      const replaceJson = (runId: string | undefined, json: string | null) => {
        if (json === null) return null;
        const replacements = new Map(baseReplacements);
        for (const [key, value] of factRoleByRun.get(runId ?? "") ?? [])
          replacements.set(key, value);
        for (const [key, value] of orderReferenceRoleByRun.get(runId ?? "") ??
          [])
          replacements.set(key, value);
        for (const [key, value] of orderRolesByRun.get(runId ?? "") ?? []) {
          replacements.set(key, value);
          replacements.set(value.replace(":ORDER", ":POSITION"), value);
        }
        return replaceIds(JSON.parse(json), replacements);
      };
      const replaceAnyJson = (json: string | null) => {
        if (json === null) return null;
        const replacements = new Map(baseReplacements);
        for (const values of factRoleByRun.values())
          for (const [key, value] of values) replacements.set(key, value);
        for (const values of orderRolesByRun.values())
          for (const [key, value] of values) replacements.set(key, value);
        return replaceIds(JSON.parse(json), replacements);
      };
      const orderRows = snapshot.orders.map((row) => ({
        row,
        orderRole:
          orderRolesByRun.get(row.run_id)?.get(row.order_id) ??
          `${runRole.get(row.run_id) ?? row.run_id}:UNKNOWN_ORDER`,
      }));
      const eventRows = snapshot.events.map((row) => ({
        row,
        eventRole: `${accountRole.get(row.account_id) ?? row.account_id}:EVENT:${
          Number(row.event_sequence) -
          (eventSequenceBase.get(row.account_id) ?? 0)
        }`,
      }));
      return {
        facts: factRows
          .map(({ row, factRole }) => ({
            run: runRole.get(row.run_id),
            factId: factRole,
            factAt: row.fact_at,
            appliedSequence: row.applied_sequence,
            fact: replaceJson(row.run_id, row.fact_json),
            outcome: replaceJson(row.run_id, row.outcome_json),
          }))
          .sort((left, right) =>
            `${left.run}:${left.appliedSequence}:${left.factId}`.localeCompare(
              `${right.run}:${right.appliedSequence}:${right.factId}`,
            ),
          ),
        orders: orderRows
          .map(({ row, orderRole }) => ({
            run: runRole.get(row.run_id),
            orderId: orderRole,
            revision: row.revision,
            lastFactId:
              factRoleByRun.get(row.run_id)?.get(row.last_fact_id) ??
              row.last_fact_id,
            state: replaceJson(row.run_id, row.state_json),
            submission: replaceJson(row.run_id, row.submission_json),
          }))
          .sort((left, right) =>
            `${left.run}:${left.orderId}:${left.revision}`.localeCompare(
              `${right.run}:${right.orderId}:${right.revision}`,
            ),
          ),
        events: eventRows
          .map(({ row, eventRole }) => ({
            account: accountRole.get(row.account_id),
            eventId: eventRole,
            eventSequence:
              Number(row.event_sequence) -
              (eventSequenceBase.get(row.account_id) ?? 0),
            eventSequenceVerified: row.event_sequence_verified,
            factRun: runRole.get(row.fact_run_id) ?? row.fact_run_id,
            factId:
              factRoleByRun.get(row.fact_run_id)?.get(row.fact_id) ??
              row.fact_id,
            event: replaceJson(row.fact_run_id, row.event_json),
          }))
          .sort((left, right) =>
            `${left.account}:${left.eventSequence}`.localeCompare(
              `${right.account}:${right.eventSequence}`,
            ),
          ),
        accounts: snapshot.accounts
          .map((row) => ({
            account: accountRole.get(row.id),
            revision: row.revision,
            checkpointSequence:
              row.checkpoint_sequence === null
                ? null
                : Number(row.checkpoint_sequence) -
                  (eventSequenceBase.get(row.id) ?? 0),
            eventsSinceCheckpoint: row.events_since_checkpoint,
            state: replaceAnyJson(row.state_json),
            initialState: replaceAnyJson(row.initial_state_json),
          }))
          .sort((left, right) =>
            String(left.account).localeCompare(String(right.account)),
          ),
      };
    }

    function service(predictionEngine: {
      predictFundedExecution(payload: unknown): Promise<unknown>;
    }) {
      return new FundedComparisonService({
        pool,
        repository,
        pairedRunner: (input, betweenSessions) =>
          runFundedPairedComparison(input, {
            pool,
            repository,
            reporting: new FundedReportingService(pool),
            predictionEngine,
            evidenceSourceFor: (shared) =>
              createFundedComparisonReplayEvidenceSource(shared),
            betweenSessions,
          }),
        evidenceSource: new PostgresFundedComparisonEvidenceSource(
          pool,
          repository,
        ),
      });
    }

    function predictionEngine(
      failCall?: number,
      options: { reverse?: boolean; corruptMember?: boolean } = {},
    ) {
      let calls = 0;
      return {
        predictFundedExecution: async (value: unknown) => {
          calls += 1;
          if (failCall === calls)
            throw new Error("task12 injected inference failure");
          const input = value as {
            requestVersion: string;
            marketId: string;
            currency: string;
            model: unknown;
            inputs: readonly {
              runId: string;
              observationId: string;
              decisionSequence: number;
              decisionInputDigest: string;
            }[];
          };
          const response = {
            requestVersion: input.requestVersion,
            marketId: input.marketId,
            currency: input.currency,
            model: input.model,
            predictions: input.inputs.map((row, index) => ({
              runId: row.runId,
              observationId: row.observationId,
              decisionSequence: row.decisionSequence,
              decisionInputDigest: row.decisionInputDigest,
              output: {
                fillProbability: {
                  value: 1,
                  unit: "PROBABILITY",
                  lowerBound: 0,
                  upperBound: 1,
                },
                expectedFillFraction: {
                  value: options.reverse
                    ? (index + 1) / input.inputs.length
                    : 1,
                  unit: "FRACTION",
                  lowerBound: 0,
                  upperBound: 1,
                },
                expectedTotalExecutionCost: {
                  value: 1,
                  unit: "CURRENCY",
                  lowerBound: 0,
                  upperBound: null,
                },
                expectedSlippagePerShare: {
                  value: 0,
                  unit: "CURRENCY_PER_SHARE",
                  lowerBound: 0,
                  upperBound: null,
                },
              },
              warnings: [],
            })),
            warnings: [],
          };
          const parsed =
            fundedExecutionInferenceOutputSchema.safeParse(response);
          if (!parsed.success) {
            console.error(
              "task12 inference fixture schema",
              parsed.error.issues,
            );
            throw new Error("task12 inference fixture schema");
          }
          if (options.corruptMember) {
            // Exactly one schema-valid identity mismatch; every peer retains
            // the same valid, discriminating diagnostics as the healthy control.
            response.predictions[0]!.decisionInputDigest = digestA;
            expect(
              response.predictions.filter(
                (row, index) =>
                  row.decisionInputDigest !==
                  input.inputs[index]!.decisionInputDigest,
              ),
            ).toHaveLength(1);
            expect(
              response.predictions[1]!.output.expectedFillFraction.value,
            ).toBe(1);
            expect(
              fundedExecutionInferenceOutputSchema.safeParse(response).success,
            ).toBe(true);
          }
          return response;
        },
      };
    }

    it("freezes retained PostgreSQL sessions, replays production economics, recovers fallback, and reproduces the result", async () => {
      const receipt = await saveSpec();
      const before = await pool.query(
        `SELECT r.source,r.market_id,r.session_date::text AS session_date,
                r.session_timezone,r.scheduled_close_at,r.status,
                r.execution_model_version,r.assumptions::text AS assumptions,
                r.started_at,r.completed_at,f.account_id,f.currency,
                f.policy::text AS funded_policy,f.clock_at,
                a.initial_state::text AS initial_state,a.state::text AS state,
                a.revision,
                (SELECT string_agg(DISTINCT d.funded_policy_version,',' ORDER BY d.funded_policy_version)
                   FROM funded_decision_evidence d WHERE d.run_id=f.run_id) AS funded_policy_versions,
                (SELECT count(*) FROM paper_funded_event e WHERE e.account_id=f.account_id) AS event_count,
                (SELECT count(*) FROM funded_decision_evidence d WHERE d.run_id=f.run_id) AS evidence_count
           FROM paper_bot_run r
           JOIN paper_funded_run f ON f.run_id=r.id
           JOIN paper_funded_account a ON a.id=f.account_id WHERE r.id=$1`,
        [liveSourceRunId],
      );
      const authorityBefore = await pool.query(
        `SELECT c.status,c.eligible_for_activation,c.active,c.artifact_digest,
                c.cohort_digest,c.dataset_digest,
                d.dataset_digest AS persisted_dataset_digest,d.activation_eligible,
                (SELECT count(*) FROM funded_execution_dataset_member m WHERE m.dataset_id=d.id) AS member_count
           FROM funded_execution_challenger c
           JOIN funded_execution_dataset d ON d.id=c.dataset_id
          WHERE c.id=$1`,
        [challengerId],
      );
      const liveAuthorityBefore = await pool.query(
        `SELECT r.id,r.market_id,r.status,r.execution_model_version,
                r.assumptions::text AS assumptions,r.started_at,r.completed_at,
                f.account_id,f.currency,f.policy::text AS funded_policy,f.clock_at,
                a.initial_state::text AS initial_state,a.state::text AS state
           FROM paper_bot_run r
           LEFT JOIN paper_funded_run f ON f.run_id=r.id
           LEFT JOIN paper_funded_account a ON a.id=f.account_id
          WHERE r.source='LIVE' ORDER BY r.id`,
      );
      const outcome = await service(predictionEngine(2)).run(receipt.specId, {
        attemptId: "task12-production-replay",
        maxSessions: 3,
      });
      expect(
        outcome.result.pairedSessions.map((row) => row.sessionDate),
      ).toEqual([...sessions]);
      expect(
        outcome.result.champion.drawdown.maxDrawdown,
      ).toBeGreaterThanOrEqual(0);
      expect(
        outcome.result.challenger.drawdown.maxDrawdown,
      ).toBeGreaterThanOrEqual(0);
      for (const side of [outcome.result.champion, outcome.result.challenger]) {
        expect(side.integrity.unresolvedExposure).toBe(0);
        expect(side.integrity.findings).toEqual([]);
      }
      for (const metric of await repository.listSessionMetrics(
        receipt.specId,
      )) {
        expect(metric.valuation).toBe("UNION_GRID_MTM");
        expect(metric.unresolvedOrderCount).toBe(0);
        expect(metric.unresolvedReservationCount).toBe(0);
        expect(metric.staleMarkCount).toBe(0);
      }
      expect(
        (
          await pool.query(
            `SELECT count(*) FROM paper_funded_fact f
              WHERE f.run_id IN (SELECT run_id FROM funded_comparison_run_binding WHERE spec_id=$1)
                AND f.processed_at IS NULL`,
            [receipt.specId],
          )
        ).rows[0]?.count,
      ).toBe("0");
      expect(
        (
          await pool.query(
            `SELECT count(*) FROM paper_entry_order o
              WHERE o.run_id IN (SELECT run_id FROM funded_comparison_run_binding WHERE spec_id=$1)
                AND COALESCE(o.state->'execution'->>'status',o.state->>'status')
                    NOT IN ('CLOSED','COMPLETED','CANCELLED','EXPIRED')`,
            [receipt.specId],
          )
        ).rows[0]?.count,
      ).toBe("0");
      const persisted = await repository.loadResult(receipt.specId);
      expect(persisted).not.toBeNull();
      const resultDigest = persisted!.resultDigest;
      const championEvaluations = await repository.listPolicyEvaluations(
        receipt.specId,
        "CHAMPION",
      );
      const challengerEvaluations = await repository.listPolicyEvaluations(
        receipt.specId,
        "CHALLENGER",
      );
      expect(championEvaluations).toHaveLength(6);
      expect(challengerEvaluations).toHaveLength(6);
      const durableMetrics = await repository.listSessionMetrics(
        receipt.specId,
        "CHAMPION",
      );
      expect(durableMetrics).toHaveLength(3);
      for (const metric of durableMetrics) {
        const paired = persisted!.pairedSessions.find(
          (session) => session.sessionDate === metric.sessionDate,
        );
        expect(paired).toBeDefined();
        expect(metric.netReturn).toBe(paired!.baselineNetReturn);
        expect(metric.maxDrawdown).toBe(paired!.baselineMaxDrawdown);
      }
      const durableChallengerMetrics = await repository.listSessionMetrics(
        receipt.specId,
        "CHALLENGER",
      );
      expect(durableChallengerMetrics).toHaveLength(3);
      for (const metric of durableChallengerMetrics) {
        const paired = persisted!.pairedSessions.find(
          (session) => session.sessionDate === metric.sessionDate,
        );
        expect(paired).toBeDefined();
        expect(metric.netReturn).toBe(paired!.challengerNetReturn);
        expect(metric.maxDrawdown).toBe(paired!.challengerMaxDrawdown);
      }
      const durableMetricRows = [...durableMetrics, ...durableChallengerMetrics]
        .map((metric) => ({
          side: metric.side,
          sessionDate: metric.sessionDate,
          valuation: metric.valuation,
          valuationReason: metric.valuationReason,
          netReturn: metric.netReturn,
          maxDrawdown: metric.maxDrawdown,
          tradeCount: metric.tradeCount,
          unrealizedPositionCount: metric.unrealizedPositionCount,
          unresolvedOrderCount: metric.unresolvedOrderCount,
          unresolvedReservationCount: metric.unresolvedReservationCount,
          staleMarkCount: metric.staleMarkCount,
          valuationPointCount: metric.valuationPointCount,
          metricDigest: metric.metricDigest,
        }))
        .sort((left, right) =>
          `${left.side}:${left.sessionDate}`.localeCompare(
            `${right.side}:${right.sessionDate}`,
          ),
        );
      expect(independentHash(durableMetricRows)).toBe(
        independentHash(
          [
            ...(await repository.listSessionMetrics(
              receipt.specId,
              "CHAMPION",
            )),
            ...(await repository.listSessionMetrics(
              receipt.specId,
              "CHALLENGER",
            )),
          ]
            .map((metric) => ({
              side: metric.side,
              sessionDate: metric.sessionDate,
              valuation: metric.valuation,
              valuationReason: metric.valuationReason,
              netReturn: metric.netReturn,
              maxDrawdown: metric.maxDrawdown,
              tradeCount: metric.tradeCount,
              unrealizedPositionCount: metric.unrealizedPositionCount,
              unresolvedOrderCount: metric.unresolvedOrderCount,
              unresolvedReservationCount: metric.unresolvedReservationCount,
              staleMarkCount: metric.staleMarkCount,
              valuationPointCount: metric.valuationPointCount,
              metricDigest: metric.metricDigest,
            }))
            .sort((left, right) =>
              `${left.side}:${left.sessionDate}`.localeCompare(
                `${right.side}:${right.sessionDate}`,
              ),
            ),
        ),
      );
      const evidenceSource = new PostgresFundedComparisonEvidenceSource(
        pool,
        repository,
      );
      const durableEvidence = new Map<
        string,
        Awaited<
          ReturnType<
            PostgresFundedComparisonEvidenceSource["loadSessionEvidence"]
          >
        >
      >();
      for (const sessionDate of receipt.specification.sessionMembership
        .orderedSessionDates) {
        const championBinding = await repository.findBinding(
          receipt.specId,
          "CHAMPION",
          sessionDate,
        );
        const challengerBinding = await repository.findBinding(
          receipt.specId,
          "CHALLENGER",
          sessionDate,
        );
        expect(championBinding).not.toBeNull();
        expect(challengerBinding).not.toBeNull();
        durableEvidence.set(
          sessionDate,
          await evidenceSource.loadSessionEvidence({
            specificationId: receipt.specId,
            specification: receipt.specification,
            sessionDate,
            champion: championBinding!,
            challenger: challengerBinding!,
          }),
        );
      }
      const reconstructDurableSideMetric = (
        side: "CHAMPION" | "CHALLENGER",
        evaluations: readonly (typeof championEvaluations)[number][],
      ) => {
        const sessions =
          receipt.specification.sessionMembership.orderedSessionDates.map(
            (sessionDate) => {
              const evidence = durableEvidence.get(sessionDate)!;
              return side === "CHAMPION"
                ? evidence.champion
                : evidence.challenger;
            },
          );
        const ordered = sessions.map((session, index) => ({
          sessionDate:
            receipt.specification.sessionMembership.orderedSessionDates[index]!,
          ...session,
        }));
        const sessionReturns = ordered.map((session) => ({
          sessionDate: session.sessionDate,
          netReturn:
            session.valuation.equityPoints.at(-1)!.equity -
            session.carryInEquity,
        }));
        const totalNetReturn = sessionReturns.reduce(
          (total, row) => total + row.netReturn,
          0,
        );
        const equitySeries = ordered.flatMap((session) =>
          session.valuation.equityPoints.map((point) => point.equity),
        );
        let peak = Number.NEGATIVE_INFINITY;
        let maxDrawdown = 0;
        for (const equity of equitySeries) {
          if (equity > peak) peak = equity;
          if (Number.isFinite(peak))
            maxDrawdown = Math.max(maxDrawdown, peak - equity);
        }
        const decisions = sessions.flatMap((session) => session.decisions);
        const orders = sessions.flatMap((session) => session.orders);
        const knownVetoCodes = new Set([
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
        ]);
        const vetoCounts = new Map<string, number>();
        let unknownVeto = false;
        for (const decision of decisions) {
          if (decision.action !== "DECLINE" || decision.vetoCode === null)
            continue;
          if (!knownVetoCodes.has(decision.vetoCode)) {
            unknownVeto = true;
            continue;
          }
          vetoCounts.set(
            decision.vetoCode,
            (vetoCounts.get(decision.vetoCode) ?? 0) + 1,
          );
        }
        const declines = new Map<string, number>();
        for (const decision of decisions) {
          if (decision.action === "SUBMIT" || decision.vetoCode !== null)
            continue;
          const reason = decision.policyReason ?? decision.action;
          declines.set(reason, (declines.get(reason) ?? 0) + 1);
        }
        const notSubmitted = decisions.filter(
          (decision) =>
            decision.action !== "SUBMIT" || decision.vetoCode !== null,
        );
        const requestedCapitalRows = notSubmitted.filter(
          (decision) =>
            decision.requestedNotional !== null &&
            decision.requestedRisk !== null,
        );
        const requestedCapitalAvailableCount = requestedCapitalRows.length;
        const requestedCapitalUnavailableCount =
          notSubmitted.length - requestedCapitalAvailableCount;
        const forgoneRequestedNotional =
          requestedCapitalUnavailableCount > 0
            ? null
            : requestedCapitalRows.reduce(
                (total, decision) => total + decision.requestedNotional!,
                0,
              );
        const forgoneRequestedRisk =
          requestedCapitalUnavailableCount > 0
            ? null
            : requestedCapitalRows.reduce(
                (total, decision) => total + decision.requestedRisk!,
                0,
              );
        const provable = notSubmitted.filter(
          (decision) => decision.realizable && decision.realizedValue !== null,
        );
        const realizedValue =
          provable.length === notSubmitted.length && provable.length > 0
            ? provable.reduce(
                (total, decision) => total + decision.realizedValue!,
                0,
              )
            : null;
        const filled = orders.filter((order) => order.filledShares > 0);
        const fullFills = orders.filter(
          (order) =>
            order.filledShares >= order.requestedShares &&
            order.requestedShares > 0,
        ).length;
        const partialFills = filled.length - fullFills;
        const requestedShares = orders.reduce(
          (total, order) => total + order.requestedShares,
          0,
        );
        const filledShares = orders.reduce(
          (total, order) => total + order.filledShares,
          0,
        );
        const slippageRows = orders.filter(
          (order) =>
            order.slippageMicrosPerShare !== null && order.filledShares > 0,
        );
        const slippageWeight = slippageRows.reduce(
          (total, order) => total + order.filledShares,
          0,
        );
        const averageSlippagePerShare =
          slippageWeight > 0
            ? slippageRows.reduce(
                (total, order) =>
                  total + order.slippageMicrosPerShare! * order.filledShares,
                0,
              ) /
              slippageWeight /
              1_000_000
            : 0;
        const turnover = orders.reduce(
          (total, order) =>
            total +
            ((order.entryPriceMicros + (order.exitPriceMicros ?? 0)) *
              order.filledShares) /
              1_000_000,
          0,
        );
        const totalModeledCosts = orders.reduce(
          (total, order) => total + order.costsMicros / 1_000_000,
          0,
        );
        let longestReturnSignRun = 0;
        let currentRun = 0;
        let previousSign = 0;
        for (const row of sessionReturns) {
          const sign = Math.sign(row.netReturn);
          currentRun =
            sign !== 0 && sign === previousSign
              ? currentRun + 1
              : sign === 0
                ? 0
                : 1;
          previousSign = sign;
          longestReturnSignRun = Math.max(longestReturnSignRun, currentRun);
        }
        const fallbackDecisionCount = evaluations.filter(
          (evaluation) => evaluation.disposition === "FALLBACK_CHAMPION_ORDER",
        ).length;
        const predictionAvailableCount = evaluations.filter(
          (evaluation) => evaluation.disposition === "PREDICTED",
        ).length;
        const predictionRequiredCount = evaluations.filter(
          (evaluation) => evaluation.disposition !== "CHAMPION_ORDER",
        ).length;
        return {
          return: {
            totalNetReturn,
            returnPctOfInitialCash:
              totalNetReturn / receipt.specification.capital.initialCash,
            sessions: sessionReturns,
          },
          drawdown: {
            maxDrawdown,
            maxDrawdownPctOfInitialCash:
              maxDrawdown / receipt.specification.capital.initialCash,
          },
          dailyLoss: {
            limitHits: ordered.filter(
              (session) => session.dailyPnl <= -session.dailyLossLimit,
            ).length,
            mostNegativeDailyPnl: Math.min(
              0,
              ...ordered.map((session) => session.dailyPnl),
            ),
            sessionsBlocked: ordered.filter(
              (session) => !session.entriesAllowed,
            ).length,
          },
          risk: {
            maxOpenRisk: Math.max(
              0,
              ...ordered.map((session) => session.openRisk),
            ),
            maxGrossNotional: Math.max(
              0,
              ...ordered.map((session) => session.grossNotional),
            ),
            maxOpenPositions: Math.max(
              0,
              ...ordered.map((session) => session.openPositions),
            ),
          },
          activity: {
            turnover,
            requested: orders.length,
            partialFills,
            fullFills,
            zeroFills: orders.length - filled.length,
          },
          execution: {
            fillFraction:
              requestedShares > 0 ? filledShares / requestedShares : 0,
            averageSlippagePerShare,
            totalModeledCosts,
          },
          veto: {
            classification: unknownVeto ? "UNAVAILABLE" : "AVAILABLE",
            counts: [...vetoCounts.entries()]
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([reason, count]) => ({ reason, count })),
          },
          declines: [...declines.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([reason, count]) => ({ reason, count })),
          opportunityCost: {
            declinedOrVetoedCount: notSubmitted.length,
            forgoneRequestedNotional,
            forgoneRequestedRisk,
            requestedCapitalAvailableCount,
            requestedCapitalUnavailableCount,
            realizedValue,
            provableCount: provable.length,
            unprovableCount: notSubmitted.length - provable.length,
          },
          stability: {
            sessionCount: ordered.length,
            zeroTradeSessions: ordered.filter(
              (session) => session.zeroTradeSessions,
            ).length,
            longestReturnSignRun,
          },
          integrity: {
            unresolvedExposure: ordered.reduce(
              (total, session) =>
                total +
                (session.valuation.integrityFindings.length > 0 ? 1 : 0),
              0,
            ),
            fallbackDecisionCount,
            predictionAvailableCount,
            predictionRequiredCount,
            findings: ordered.flatMap((session) =>
              session.valuation.integrityFindings.map(
                (finding) => `${session.sessionDate}: ${finding}`,
              ),
            ),
          },
        };
      };
      const reconstructedChampion = reconstructDurableSideMetric(
        "CHAMPION",
        championEvaluations,
      );
      const reconstructedChallenger = reconstructDurableSideMetric(
        "CHALLENGER",
        challengerEvaluations,
      );
      const reconstructedPairedSessions =
        receipt.specification.sessionMembership.orderedSessionDates.map(
          (sessionDate) => {
            const evidence = durableEvidence.get(sessionDate)!;
            return {
              sessionDate,
              baselineNetReturn:
                evidence.champion.valuation.equityPoints.at(-1)!.equity -
                evidence.champion.carryInEquity,
              challengerNetReturn:
                evidence.challenger.valuation.equityPoints.at(-1)!.equity -
                evidence.challenger.carryInEquity,
              baselineMaxDrawdown: evidence.champion.valuation.maxDrawdown,
              challengerMaxDrawdown: evidence.challenger.valuation.maxDrawdown,
              valuation: "UNION_GRID_MTM" as const,
              coverage: "VERIFIED" as const,
            };
          },
        );
      expect(resultDigest).toBe(
        independentHash({
          comparisonSpecDigest: receipt.specification.comparisonSpecDigest,
          championEvaluationDigest: independentHash(
            championEvaluations.map(
              (evaluation) => evaluation.evaluationDigest,
            ),
          ),
          challengerEvaluationDigest: independentHash(
            challengerEvaluations.map(
              (evaluation) => evaluation.evaluationDigest,
            ),
          ),
          championMetricsDigest: independentHash(reconstructedChampion),
          challengerMetricsDigest: independentHash(reconstructedChallenger),
          orderedPairedSessionDigests: reconstructedPairedSessions.map(
            (session) => independentHash(session),
          ),
        }),
      );
      const retry = await service(predictionEngine()).run(receipt.specId, {
        attemptId: "task12-production-replay-retry",
        maxSessions: 3,
      });
      expect(retry.reused).toBe(true);
      expect(retry.result.resultDigest).toBe(resultDigest);
      const evaluations = await repository.listPolicyEvaluations(
        receipt.specId,
        "CHALLENGER",
      );
      expect(
        evaluations.filter((row) => row.disposition === "PREDICTED"),
      ).toHaveLength(4);
      expect(
        evaluations.filter(
          (row) => row.disposition === "FALLBACK_CHAMPION_ORDER",
        ),
      ).toHaveLength(2);
      expect(await repository.listBindings(receipt.specId)).toHaveLength(6);
      expect(
        new Set(
          (await repository.listBindings(receipt.specId)).map(
            (row) => row.accountId,
          ),
        ),
      ).toEqual(
        new Set([
          championReplayAccountId(receipt.specification.comparisonSpecDigest),
          challengerReplayAccountId(receipt.specification.comparisonSpecDigest),
        ]),
      );
      expect(
        (await pool.query("SELECT count(*) FROM funded_execution_prediction"))
          .rows[0]?.count,
      ).toBe("0");
      const sourceOpportunity = receipt.opportunities[0]!;
      await expect(
        pool.query(
          "DELETE FROM funded_comparison_input_chunk WHERE spec_id=$1 AND session_date=$2",
          [receipt.specId, sessions[0]],
        ),
      ).rejects.toThrow(/immutable/i);
      await expect(
        pool.query(
          "DELETE FROM funded_comparison_spec_opportunity WHERE spec_id=$1 AND source_opportunity_id=$2",
          [receipt.specId, sourceOpportunity.sourceOpportunityId],
        ),
      ).rejects.toThrow(/immutable/i);
      await expect(
        pool.query(
          "DELETE FROM funded_comparison_policy_evaluation WHERE spec_id=$1 AND side='CHAMPION' AND session_date=$2",
          [receipt.specId, sessions[0]],
        ),
      ).rejects.toThrow(/immutable/i);
      expect(
        (
          await pool.query(
            `SELECT r.source,r.market_id,r.session_date::text AS session_date,
                    r.session_timezone,r.scheduled_close_at,r.status,
                    r.execution_model_version,r.assumptions::text AS assumptions,
                    r.started_at,r.completed_at,f.account_id,f.currency,
                    f.policy::text AS funded_policy,f.clock_at,
                    a.initial_state::text AS initial_state,a.state::text AS state,
                    a.revision,
                    (SELECT string_agg(DISTINCT d.funded_policy_version,',' ORDER BY d.funded_policy_version)
                       FROM funded_decision_evidence d WHERE d.run_id=f.run_id) AS funded_policy_versions,
                    (SELECT count(*) FROM paper_funded_event e WHERE e.account_id=f.account_id) AS event_count,
                    (SELECT count(*) FROM funded_decision_evidence d WHERE d.run_id=f.run_id) AS evidence_count
               FROM paper_funded_run f
               JOIN paper_bot_run r ON r.id=f.run_id
               JOIN paper_funded_account a ON a.id=f.account_id WHERE f.run_id=$1`,
            [liveSourceRunId],
          )
        ).rows,
      ).toEqual(before.rows);
      expect(
        (
          await pool.query(
            `SELECT c.status,c.eligible_for_activation,c.active,c.artifact_digest,
                    c.cohort_digest,c.dataset_digest,
                    d.dataset_digest AS persisted_dataset_digest,d.activation_eligible,
                    (SELECT count(*) FROM funded_execution_dataset_member m WHERE m.dataset_id=d.id) AS member_count
               FROM funded_execution_challenger c
               JOIN funded_execution_dataset d ON d.id=c.dataset_id
              WHERE c.id=$1`,
            [challengerId],
          )
        ).rows,
      ).toEqual(authorityBefore.rows);
      expect(
        (
          await pool.query(
            `SELECT r.id,r.market_id,r.status,r.execution_model_version,
                    r.assumptions::text AS assumptions,r.started_at,r.completed_at,
                    f.account_id,f.currency,f.policy::text AS funded_policy,f.clock_at,
                    a.initial_state::text AS initial_state,a.state::text AS state
               FROM paper_bot_run r
               LEFT JOIN paper_funded_run f ON f.run_id=r.id
               LEFT JOIN paper_funded_account a ON a.id=f.account_id
              WHERE r.source='LIVE' ORDER BY r.id`,
          )
        ).rows,
      ).toEqual(liveAuthorityBefore.rows);
    }, 240_000);

    it("fails closed through the PostgreSQL service when a frozen source chunk is missing", async () => {
      const receipt = await saveSpec({
        evidenceCutoffAt: "2026-09-16T21:05:00.000Z",
        specificationFrozenAt: "2026-09-16T22:05:00.000Z",
      });
      await corruptDelete(
        "DELETE FROM funded_comparison_input_chunk WHERE spec_id=$1 AND session_date=$2 AND chunk_ordinal=1",
        [receipt.specId, sessions[0]],
      );
      await expect(
        service(predictionEngine()).run(receipt.specId, {
          attemptId: "task12-missing-chunk",
          maxSessions: 3,
        }),
      ).rejects.toThrow(/retained|missing|chunk/i);
      expect(await repository.loadResult(receipt.specId)).toBeUndefined();
    });

    it("fails closed through the PostgreSQL service when a frozen opportunity mapping is missing", async () => {
      const receipt = await saveSpec({
        evidenceCutoffAt: "2026-09-16T21:06:00.000Z",
        specificationFrozenAt: "2026-09-16T22:06:00.000Z",
      });
      await corruptDelete(
        "DELETE FROM funded_comparison_spec_opportunity WHERE spec_id=$1 AND session_date=$2 AND ordinal=1",
        [receipt.specId, sessions[0]],
      );
      await expect(
        service(predictionEngine()).run(receipt.specId, {
          attemptId: "task12-missing-mapping",
          maxSessions: 3,
        }),
      ).rejects.toThrow(/opportunity|membership|missing/i);
      expect(await repository.loadResult(receipt.specId)).toBeUndefined();
    });

    it("fails closed before finalization when a persisted policy evaluation is missing", async () => {
      const receipt = await saveSpec({
        evidenceCutoffAt: "2026-09-16T21:07:00.000Z",
        specificationFrozenAt: "2026-09-16T22:07:00.000Z",
      });
      let calls = 0;
      await expect(
        service(predictionEngine()).run(receipt.specId, {
          attemptId: "task12-missing-evaluation",
          maxSessions: 3,
          betweenSessions: async () => {
            calls += 1;
            if (calls === 3)
              await corruptDelete(
                "DELETE FROM funded_comparison_policy_evaluation WHERE spec_id=$1 AND side='CHAMPION' AND session_date=$2",
                [receipt.specId, sessions[0]],
              );
          },
        }),
      ).rejects.toThrow(/evaluation|incomplete|membership/i);
      expect(await repository.loadResult(receipt.specId)).toBeUndefined();
    });

    it("reports stale marks and retained exposure through the production funded reporter", async () => {
      const report = await new FundedReportingService(pool).report(
        negativeRunId,
        { mode: "CURRENT_ACCOUNT" },
      );
      expect(report.summary.staleMarks).toBe(true);
      expect(report.warnings).toContain("STALE_POSITION_MARKS");
      expect(Object.keys(report.positions)).not.toHaveLength(0);
      expect(report.summary.openRisk).toBeGreaterThan(0);
      expect(report.warnings).toContain("UNRESOLVED_CLOSE_QUANTITY");
      expect(report.summary.entriesAllowed).toBe(false);
    });

    it("fails closed through comparison service for stale retained exposure", async () => {
      const receipt = await saveSpec({
        evidenceCutoffAt: "2026-09-16T21:09:00.000Z",
        specificationFrozenAt: "2026-09-16T22:09:00.000Z",
      });
      const staleAccountId = championReplayAccountId(
        receipt.specification.comparisonSpecDigest,
      );
      let callbacks = 0;
      await expect(
        service(predictionEngine()).run(receipt.specId, {
          attemptId: "task12-stale-comparison",
          maxSessions: 3,
          betweenSessions: async () => {
            callbacks += 1;
            if (callbacks !== 2) return;
            const run = await pool.query<{ run_id: string }>(
              "SELECT run_id FROM paper_funded_run WHERE account_id=$1",
              [staleAccountId],
            );
            const runId = run.rows[0]?.run_id;
            if (!runId)
              throw new Error("stale comparison run was not provisioned");
            const staleOrderService = new FundedOrderService(
              pool,
              runId,
              staleAccountId,
              currency,
            );
            const submittedAt = `${sessions[0]}T13:30:00.000Z`;
            const orderId = randomUUID();
            await staleOrderService.submit(
              negativeInstrumentId,
              {
                orderId,
                assumptions,
                signal: {
                  entryReference: 10,
                  stopReference: 9.8,
                  targetReference: 11,
                  atr14: 0.2,
                  signalTimestamp: submittedAt,
                },
                submittedAt,
                expiresAt: `${sessions[0]}T13:50:00.000Z`,
              },
              1_000,
              1_000,
            );
            await staleOrderService.quote(
              negativeInstrumentId,
              {
                timestamp: submittedAt,
                bid: 10,
                ask: 10,
                bidSize: 1_000,
                askSize: 1_000,
                sizeUnit: "SHARES",
                sizeMultiplier: 1,
                dataStatus: "REALTIME",
                actionable: true,
              },
              1,
              0,
            );
          },
        }),
      ).rejects.toThrow(
        /UNRESOLVED_POSITION|UNRESOLVED_RESERVATION|STALE|unresolved orders or positions/i,
      );
      expect(await repository.loadResult(receipt.specId)).toBeUndefined();
      const staleRun = await pool.query<{ run_id: string }>(
        "SELECT run_id FROM paper_funded_run WHERE account_id=$1",
        [staleAccountId],
      );
      const report = await new FundedReportingService(pool).report(
        staleRun.rows[0]!.run_id,
        { mode: "CURRENT_ACCOUNT" },
      );
      expect(report.summary.staleMarks).toBe(true);
      expect(report.summary.entriesAllowed).toBe(false);
    });

    async function runCancelledAt(
      receipt: Awaited<ReturnType<typeof saveSpec>>,
      failAt: number,
      attemptId: string,
    ) {
      let calls = 0;
      await expect(
        service(predictionEngine()).run(receipt.specId, {
          attemptId,
          maxSessions: 3,
          betweenSessions: async () => {
            calls += 1;
            if (calls === failAt)
              throw new CancelledError(`task12 cancellation ${failAt}`);
          },
        }),
      ).rejects.toThrow(`task12 cancellation ${failAt}`);
      const failures = await repository.listFailures(receipt.specId);
      expect(
        failures.filter(
          (row) =>
            row.attemptId === attemptId &&
            row.reason === "CANCELLED" &&
            row.classification === "INTERRUPTION",
        ),
      ).toHaveLength(1);
      expect(failures).toContainEqual(
        expect.objectContaining({
          reason: "CANCELLED",
          classification: "INTERRUPTION",
        }),
      );
      expect(failures.some((row) => row.classification === "TERMINAL")).toBe(
        false,
      );
      const beforeRetry = await economicSnapshot(receipt.specId);
      const resumed = await service(predictionEngine()).run(receipt.specId, {
        attemptId: `${attemptId}-resume`,
        maxSessions: 3,
      });
      expect(resumed.result.pairedSessions).toHaveLength(3);
      const afterRetry = await economicSnapshot(receipt.specId);
      for (const table of ["facts", "orders", "events"] as const)
        expect(afterRetry[table]).toEqual(
          expect.arrayContaining(beforeRetry[table]),
        );
      if (beforeRetry.accounts.length > 0) {
        expect(afterRetry.accounts.map((row) => row.id)).toEqual(
          beforeRetry.accounts.map((row) => row.id),
        );
        for (const beforeAccount of beforeRetry.accounts) {
          const afterAccount = afterRetry.accounts.find(
            (row) => row.id === beforeAccount.id,
          );
          expect(afterAccount?.initial_state_json).toBe(
            beforeAccount.initial_state_json,
          );
        }
      }
      for (const afterAccount of afterRetry.accounts) {
        const finalState = JSON.parse(afterAccount.state_json) as {
          cash: number;
          positions: Record<string, unknown>;
          reservations: Record<string, unknown>;
        };
        expect(finalState.cash).toBe(25300);
        expect(finalState.positions).toEqual({});
        expect(finalState.reservations).toEqual({});
      }
      expect(afterRetry.facts).toHaveLength(48);
      expect(afterRetry.orders).toHaveLength(6);
      // Idle quotes retain one mark; a second mark is written only when a
      // fill or release changes the account's economic state.
      expect(afterRetry.events).toHaveLength(58);
      expect(
        new Set(afterRetry.facts.map((row) => `${row.run_id}:${row.fact_id}`))
          .size,
      ).toBe(afterRetry.facts.length);
      const appliedByRun = new Map<string, number[]>();
      for (const row of afterRetry.facts) {
        if (row.applied_sequence === null) continue;
        const sequence = appliedByRun.get(row.run_id) ?? [];
        sequence.push(Number(row.applied_sequence));
        appliedByRun.set(row.run_id, sequence);
      }
      for (const sequence of appliedByRun.values()) {
        const ordered = [...sequence].sort((left, right) => left - right);
        expect(new Set(ordered).size).toBe(ordered.length);
        expect(ordered).toEqual(ordered.map((_, index) => index + 1));
      }
      expect(new Set(afterRetry.events.map((row) => row.event_id)).size).toBe(
        afterRetry.events.length,
      );
      expect(await repository.listBindings(receipt.specId)).toHaveLength(6);
      expect(
        (
          await pool.query(
            "SELECT count(*) FROM funded_comparison_session_metric WHERE spec_id=$1",
            [receipt.specId],
          )
        ).rows[0]?.count,
      ).toBe("6");
      expect(
        (
          await pool.query(
            "SELECT count(*) FROM funded_comparison_policy_evaluation WHERE spec_id=$1",
            [receipt.specId],
          )
        ).rows[0]?.count,
      ).toBe("12");

      const control = await saveSpec({
        evidenceCutoffAt: "2026-09-16T21:08:00.000Z",
        specificationFrozenAt: "2026-09-16T22:08:00.000Z",
      });
      await service(predictionEngine()).run(control.specId, {
        attemptId: `${attemptId}-control`,
        maxSessions: 3,
      });
      expect(comparableEconomicSnapshot(afterRetry)).toEqual(
        comparableEconomicSnapshot(await economicSnapshot(control.specId)),
      );
    }

    it("records a durable interruption before side application and resumes all incomplete sessions", async () => {
      const receipt = await saveSpec({
        evidenceCutoffAt: "2026-09-16T21:01:00.000Z",
        specificationFrozenAt: "2026-09-16T22:01:00.000Z",
      });
      await runCancelledAt(receipt, 1, "task12-interruption-before-side");
    }, 240_000);

    it("recovers after a cancellation between the committed champion and challenger sides", async () => {
      const receipt = await saveSpec({
        evidenceCutoffAt: "2026-09-16T21:03:00.000Z",
        specificationFrozenAt: "2026-09-16T22:03:00.000Z",
      });
      await runCancelledAt(receipt, 3, "task12-interruption-between-sides");
    }, 240_000);

    it("recovers after a cancellation immediately before service finalization", async () => {
      const receipt = await saveSpec({
        evidenceCutoffAt: "2026-09-16T21:04:00.000Z",
        specificationFrozenAt: "2026-09-16T22:04:00.000Z",
      });
      await runCancelledAt(receipt, 13, "task12-interruption-finalization");
    }, 240_000);

    it("restores actual champion execution order when exactly one member identity is invalid", async () => {
      const healthy = await saveSpec({
        evidenceCutoffAt: "2026-09-16T21:13:00.000Z",
        specificationFrozenAt: "2026-09-16T22:13:00.000Z",
      });
      const broken = await saveSpec({
        evidenceCutoffAt: "2026-09-16T21:14:00.000Z",
        specificationFrozenAt: "2026-09-16T22:14:00.000Z",
      });
      await service(predictionEngine(undefined, { reverse: true })).run(
        healthy.specId,
        {
          attemptId: "task12-healthy-reordered-batch",
          maxSessions: 3,
        },
      );
      await service(
        predictionEngine(undefined, { reverse: true, corruptMember: true }),
      ).run(broken.specId, {
        attemptId: "task12-one-invalid-member",
        maxSessions: 3,
      });
      for (const sessionDate of sessions) {
        const valid = await repository.listPolicyEvaluations(
          healthy.specId,
          "CHALLENGER",
          sessionDate,
        );
        const fallback = await repository.listPolicyEvaluations(
          broken.specId,
          "CHALLENGER",
          sessionDate,
        );
        expect(
          valid.map((row) => [
            row.championRank,
            row.appliedRank,
            row.disposition,
          ]),
        ).toEqual([
          [1, 2, "PREDICTED"],
          [2, 1, "PREDICTED"],
        ]);
        expect(
          fallback.map((row) => [
            row.championRank,
            row.appliedRank,
            row.disposition,
            row.fallbackReason,
            row.prediction,
          ]),
        ).toEqual([
          [1, 1, "FALLBACK_CHAMPION_ORDER", "INVALID_DIAGNOSTIC", null],
          [2, 2, "FALLBACK_CHAMPION_ORDER", "INVALID_DIAGNOSTIC", null],
        ]);
        for (const [receipt, expectedRanks] of [
          [healthy, [2, 1]],
          [broken, [1, 2]],
        ] as const) {
          const durable = await pool.query<{
            champion_rank: number;
            sequence: number;
            applied_sequence: string;
            order_id: string | null;
            reservation_sequence: string | null;
            reserve_fact_id: string | null;
            fact_id: string;
            order_status: string | null;
          }>(
            `SELECT e.champion_rank,d.sequence,f.applied_sequence,f.fact_id,
                    o.order_id,o.state->'execution'->>'status' AS order_status,
                    r.event_sequence AS reservation_sequence,r.fact_id AS reserve_fact_id
               FROM funded_comparison_policy_evaluation e
               JOIN funded_comparison_spec_opportunity s
                 ON s.spec_id=e.spec_id AND s.source_opportunity_id=e.source_opportunity_id
               JOIN paper_signal_observation obs
                 ON obs.run_id=e.destination_run_id AND obs.id=e.destination_observation_id
                 AND obs.instrument_id=s.instrument_id
               JOIN funded_decision_evidence d ON d.run_id=obs.run_id AND d.observation_id=obs.id
               JOIN paper_funded_fact f ON f.run_id=d.run_id
                 AND f.fact->>'type'='SIGNAL' AND f.fact->'order'->>'orderId'=obs.id::text
               LEFT JOIN paper_entry_order o ON o.run_id=d.run_id AND o.order_id=obs.id::text AND o.instrument_id=obs.instrument_id
               LEFT JOIN paper_funded_event r ON r.fact_run_id=f.run_id AND r.fact_id=f.fact_id
                 AND r.event->>'type'='RESERVE' AND r.event->>'orderId'=o.order_id
              WHERE e.spec_id=$1 AND e.side='CHALLENGER' AND e.session_date=$2
              ORDER BY f.applied_sequence`,
            [receipt.specId, sessionDate],
          );
          expect(durable.rows).toHaveLength(2);
          expect(durable.rows.map((row) => row.champion_rank)).toEqual(
            expectedRanks,
          );
          expect(durable.rows.map((row) => row.sequence)).toEqual([1, 2]);
          expect(Number(durable.rows[0]!.applied_sequence)).toBeLessThan(
            Number(durable.rows[1]!.applied_sequence),
          );
          // The first reservation consumes the unchanged fixture risk allowance.
          // Therefore metadata-only fallback with reordered execution would fund
          // the wrong opportunity and fail this causal fact/order/ledger join.
          expect(durable.rows[0]!.order_id).not.toBeNull();
          expect(durable.rows[0]!.order_status).toBe("CLOSED");
          expect(durable.rows[0]!.reservation_sequence).not.toBeNull();
          expect(durable.rows[0]!.reserve_fact_id).toBe(
            durable.rows[0]!.fact_id,
          );
          expect(durable.rows[1]!.order_id).toBeNull();
          expect(durable.rows[1]!.reservation_sequence).toBeNull();
        }
      }
    }, 240_000);

    it("retains adverse unrealized marks and both sides' distinct union-grid timestamps", async () => {
      // Both prices stay above the unchanged 9.8 stop, then recover to the 11
      // target. Different instruments peak/trough/close at different times.
      const paths = [
        {
          peakSecond: 10,
          peak: 10.1,
          troughSecond: 20,
          trough: 9.9,
          closeSecond: 30,
        },
        {
          peakSecond: 15,
          peak: 10.2,
          troughSecond: 25,
          trough: 9.85,
          closeSecond: 35,
        },
      ];
      const at = (session: string, second: number) =>
        `${session}T14:30:${String(second).padStart(2, "0")}.000Z`;
      let adverse: FundedComparisonFrozenInput;
      try {
        for (const session of sessions)
          for (const [index, path] of paths.entries()) {
            await pool.query(
              "UPDATE quote_snapshot SET timestamp=$3 WHERE instrument_id=$1 AND timestamp=$2",
              [
                instrumentIds[index],
                `${session}T14:45:00.000Z`,
                at(session, path.closeSecond),
              ],
            );
            for (const [second, price] of [
              [path.peakSecond, path.peak],
              [path.troughSecond, path.trough],
            ])
              await pool.query(
                `INSERT INTO quote_snapshot(instrument_id,timestamp,bid,ask,bid_size,ask_size,last,last_size,day_volume,day_open,day_high,day_low,spread_absolute,spread_pct,is_delayed,is_halted,source,size_unit,size_multiplier)
              VALUES($1,$2,$3,$3,1000,1000,$3,1000,1500,10,11,9,0,0,false,false,'FP03_TASK12_DRAWDOWN','SHARES',1)`,
                [instrumentIds[index], at(session, second!), price],
              );
          }
        adverse = await freezeFundedComparisonSharedInput(
          {
            baselineRunId,
            marketId,
            evidenceCutoffAt: "2026-09-16T21:00:00.000Z",
            maxSessions: 3,
            replayPolicy,
          },
          {
            pool,
            store: new PostgresBacktestStore(pool),
            engine: {
              runBacktestSignals: async (payload) => {
                const session = (
                  payload as { sessions: { session: { startTime: string } }[] }
                ).sessions[0]!.session.startTime.slice(0, 10);
                return {
                  events: sourceEvents(session),
                } as BacktestSignalReplayResult;
              },
            },
          },
        );
      } finally {
        await pool.query(
          "DELETE FROM quote_snapshot WHERE source='FP03_TASK12_DRAWDOWN' AND instrument_id=ANY($1::uuid[])",
          [instrumentIds],
        );
        for (const session of sessions)
          for (const [index, path] of paths.entries())
            await pool.query(
              "UPDATE quote_snapshot SET timestamp=$3 WHERE instrument_id=$1 AND timestamp=$2",
              [
                instrumentIds[index],
                at(session, path.closeSecond),
                `${session}T14:45:00.000Z`,
              ],
            );
      }
      const receipt = await saveSpec(
        {
          evidenceCutoffAt: "2026-09-16T21:15:00.000Z",
          specificationFrozenAt: "2026-09-16T22:15:00.000Z",
        },
        adverse,
      );
      await service(predictionEngine(undefined, { reverse: true })).run(
        receipt.specId,
        { attemptId: "task12-unrealized-drawdown", maxSessions: 3 },
      );
      const result = (await repository.loadResult(receipt.specId))!;
      const bindings = await repository.listBindings(receipt.specId);
      const metrics = await repository.listSessionMetrics(receipt.specId);
      const evidenceSource = new PostgresFundedComparisonEvidenceSource(
        pool,
        repository,
      );
      const expectedWindowDrawdown = { CHAMPION: 0, CHALLENGER: 0 };
      for (const [sessionIndex, sessionDate] of sessions.entries()) {
        const sharedSession = adverse.sessions.find(
          (row) => row.sessionDate === sessionDate,
        )!;
        const retainedEffects = await pool.query<{ count: string }>(
          `SELECT count(*) FROM paper_funded_event
            WHERE account_id=ANY($1::uuid[]) AND (event->>'at')::timestamptz > $2
              AND (event->>'at')::timestamptz <= $3`,
          [
            bindings
              .filter((row) => row.sessionDate === sessionDate)
              .map((row) => row.accountId),
            sharedSession.sessionStartAt,
            sharedSession.scheduledCloseAt,
          ],
        );
        // Every frozen item and every side-owned causal effect contributes a
        // distinct grid member, including effects sharing an exogenous time.
        const unionPointCount =
          sharedSession.itemCount + Number(retainedEffects.rows[0]!.count);
        const evidence = await evidenceSource.loadSessionEvidence({
          specificationId: receipt.specId,
          specification: receipt.specification,
          sessionDate,
          champion: bindings.find(
            (row) => row.side === "CHAMPION" && row.sessionDate === sessionDate,
          )!,
          challenger: bindings.find(
            (row) =>
              row.side === "CHALLENGER" && row.sessionDate === sessionDate,
          )!,
        });
        for (const [rankIndex, side] of (
          ["CHAMPION", "CHALLENGER"] as const
        ).entries()) {
          // Champion follows the frozen source ordinal, which is a hashed
          // source identity rather than the scanner array's instrument order.
          const expectedOpportunity = receipt.opportunities.find(
            (row) =>
              row.sessionDate === sessionDate &&
              row.sourceOrdinal === rankIndex + 1,
          )!;
          const index = instrumentIds.indexOf(expectedOpportunity.instrumentId);
          expect(index).toBeGreaterThanOrEqual(0);
          const path = paths[index]!;
          const binding = bindings.find(
            (row) => row.side === side && row.sessionDate === sessionDate,
          )!;
          const fills = await pool.query<{
            instrument_id: string;
            shares: number;
            price: number;
            fee: number;
          }>(
            `SELECT event->>'instrumentId' AS instrument_id,(event->>'shares')::float AS shares,(event->>'price')::float AS price,(event->>'fee')::float AS fee
               FROM paper_funded_event WHERE fact_run_id=$1 AND event->>'type'='BUY'`,
            [binding.runId],
          );
          expect(fills.rows).toHaveLength(1);
          const fill = fills.rows[0]!;
          expect(fill.instrument_id).toBe(instrumentIds[index]);
          expect(fill).toMatchObject({ shares: 100, price: 10, fee: 0 });
          // Independent arithmetic uses only fixture prices and durable filled
          // quantity, never production valuation to construct expected amounts.
          const initialEquity =
            25_000 + sessionIndex * fill.shares * (11 - fill.price);
          const expectedPeak =
            initialEquity + fill.shares * (path.peak - fill.price);
          const expectedTrough =
            initialEquity + fill.shares * (path.trough - fill.price);
          const expectedDrawdown = expectedPeak - expectedTrough;
          expect(expectedDrawdown).toBeCloseTo(index === 0 ? 20 : 35, 8);
          const actual =
            side === "CHAMPION" ? evidence.champion : evidence.challenger;
          const expectedAt = new Map([
            [at(sessionDate, path.peakSecond), expectedPeak],
            [at(sessionDate, path.troughSecond), expectedTrough],
            [
              at(sessionDate, path.closeSecond),
              initialEquity + fill.shares * (11 - fill.price),
            ],
          ]);
          // A side must also be valued at the OTHER side's intermediate effect
          // times. Its last fresh mark is carried forward until its next quote.
          const other = paths[1 - index]!;
          for (const second of [
            other.peakSecond,
            other.troughSecond,
            other.closeSecond,
          ]) {
            const price =
              second >= path.closeSecond
                ? 11
                : second >= path.troughSecond
                  ? path.trough
                  : second >= path.peakSecond
                    ? path.peak
                    : fill.price;
            expectedAt.set(
              at(sessionDate, second),
              initialEquity + fill.shares * (price - fill.price),
            );
          }
          for (const [timestamp, equity] of expectedAt) {
            const points = actual.valuation.equityPoints.filter(
              (point) => point.at === timestamp,
            );
            expect(points.length).toBeGreaterThan(0);
            for (const point of points)
              expect(point.equity).toBeCloseTo(equity, 8);
          }
          expect(actual.valuation.staleMarkPoints).toBe(0);
          expect(actual.valuation.equityPoints).toHaveLength(unionPointCount);
          expect(actual.valuation.maxDrawdown).toBeCloseTo(expectedDrawdown, 8);
          const metric = metrics.find(
            (row) => row.side === side && row.sessionDate === sessionDate,
          )!;
          expect(metric.maxDrawdown).toBeCloseTo(expectedDrawdown, 8);
          expect(metric.netReturn).toBeCloseTo(
            fill.shares * (11 - fill.price),
            8,
          );
          expect(metric.staleMarkCount).toBe(0);
          expect(metric.valuationPointCount).toBe(unionPointCount);
          const paired = result.pairedSessions.find(
            (row) => row.sessionDate === sessionDate,
          )!;
          expect(
            side === "CHAMPION"
              ? paired.baselineMaxDrawdown
              : paired.challengerMaxDrawdown,
          ).toBeCloseTo(expectedDrawdown, 8);
          expectedWindowDrawdown[side] = Math.max(
            expectedWindowDrawdown[side],
            expectedDrawdown,
          );
        }
      }
      // Each session ends at a new recovered high (+100); therefore the full
      // window maximum is the largest independently calculated session drop.
      for (const side of ["CHAMPION", "CHALLENGER"] as const) {
        const sideResult =
          side === "CHAMPION" ? result.champion : result.challenger;
        expect(sideResult.drawdown.maxDrawdown).toBeCloseTo(
          expectedWindowDrawdown[side],
          8,
        );
        expect(sideResult.drawdown.maxDrawdownPctOfInitialCash).toBeCloseTo(
          expectedWindowDrawdown[side] / 25_000,
          10,
        );
      }
    }, 240_000);

    it("replays the frozen retained source after source deletion without mutating the source account", async () => {
      const control = await saveSpec({
        evidenceCutoffAt: "2026-09-16T21:12:00.000Z",
        specificationFrozenAt: "2026-09-16T22:12:00.000Z",
      });
      const controlOutcome = await service(predictionEngine()).run(
        control.specId,
        {
          attemptId: "task12-source-control",
          maxSessions: 3,
        },
      );
      const controlEconomics = comparableEconomicSnapshot(
        await economicSnapshot(control.specId),
      );
      const receipt = await saveSpec({
        evidenceCutoffAt: "2026-09-16T21:02:00.000Z",
        specificationFrozenAt: "2026-09-16T22:02:00.000Z",
      });
      const frozenSessionIdentity =
        receipt.specification.sharedInput.orderedSessions.find(
          (session) => session.sessionDate === sessions[0],
        );
      const changed = await pool.query(
        "UPDATE quote_snapshot SET bid=9.5,ask=9.5 WHERE instrument_id=$1 AND timestamp=$2",
        [instrumentIds[1], `${sessions[0]}T14:30:00.000Z`],
      );
      expect(changed.rowCount).toBe(1);
      const deleted = await pool.query(
        "DELETE FROM quote_snapshot WHERE instrument_id=$1",
        [instrumentIds[0]],
      );
      expect(deleted.rowCount).toBeGreaterThanOrEqual(6);
      expect(
        (
          await pool.query(
            "SELECT count(*) FROM quote_snapshot WHERE instrument_id=$1",
            [instrumentIds[0]],
          )
        ).rows[0].count,
      ).toBe("0");
      expect(
        (
          await pool.query(
            "SELECT bid::float,ask::float FROM quote_snapshot WHERE instrument_id=$1 AND timestamp=$2",
            [instrumentIds[1], `${sessions[0]}T14:30:00.000Z`],
          )
        ).rows,
      ).toEqual([{ bid: 9.5, ask: 9.5 }]);
      const outcome = await service(predictionEngine()).run(receipt.specId, {
        attemptId: "task12-source-deletion",
        maxSessions: 3,
      });
      expect(outcome.result.pairedSessions).toHaveLength(3);
      expect(receipt.specId).not.toBe(control.specId);
      expect(
        comparableEconomicSnapshot(await economicSnapshot(receipt.specId)),
      ).toEqual(controlEconomics);
      expect(outcome.result.champion).toEqual(controlOutcome.result.champion);
      expect(outcome.result.challenger).toEqual(
        controlOutcome.result.challenger,
      );
      expect(outcome.result.pairedSessions).toEqual(
        controlOutcome.result.pairedSessions,
      );
      const comparableMetrics = (
        rows: Awaited<ReturnType<typeof repository.listSessionMetrics>>,
      ) =>
        rows.map(
          ({ specId: _specId, metricDigest: _metricDigest, ...economics }) =>
            economics,
        );
      expect(
        comparableMetrics(await repository.listSessionMetrics(receipt.specId)),
      ).toEqual(
        comparableMetrics(await repository.listSessionMetrics(control.specId)),
      );
      expect(
        (await repository.loadSpecification(
          receipt.specId,
        ))!.specification.sharedInput.orderedSessions.find(
          (session) => session.sessionDate === sessions[0],
        ),
      ).toEqual(frozenSessionIdentity);
      const source = await pool.query<{ account_id: string; status: string }>(
        `SELECT f.account_id,r.status FROM paper_funded_run f
           JOIN paper_bot_run r ON r.id=f.run_id WHERE f.run_id=$1`,
        [liveSourceRunId],
      );
      expect(source.rows[0]).toEqual({
        account_id: liveSourceAccountId,
        status: "COMPLETED",
      });
    }, 240_000);
  },
);
