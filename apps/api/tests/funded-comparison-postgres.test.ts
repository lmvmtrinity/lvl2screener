import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createBacktestSchema,
  FUNDED_COMPARISON_CHALLENGER_POLICY_VERSION,
} from "@tsx-scanner/contracts";
import { migrate } from "../src/database/migrate.js";
import { isolatedDatabaseUrl } from "./isolated-database.js";
import {
  FundedComparisonRepository,
  FundedComparisonRepositoryError,
  type FundedComparisonSpecificationBuild,
} from "../src/paper-bot/funded-comparison-repository.js";
import {
  buildFundedComparisonSpecification,
  fundedComparisonTrainingSessionDigest,
  type FundedComparisonSpecificationInput,
} from "../src/paper-bot/funded-comparison-specification.js";
import {
  chunkFundedComparisonItems,
  projectFundedComparisonSessionItems,
  sessionInputDigestOf,
} from "../src/paper-bot/funded-comparison-input-freezer.js";
import { fundedComparisonSpecDigest } from "../src/paper-bot/funded-comparison-digest.js";
import { PostgresFundedLedgerStore } from "../src/paper-bot/funded-ledger-repository.js";
import { FundedOrderService } from "../src/paper-bot/funded-order-service.js";
import { fundedPolicy } from "../src/paper-bot/funded-policy.js";
import { provisionHistoricalFundedRun } from "../src/paper-bot/funded-historical-provisioning.js";

const databaseUrl =
  isolatedDatabaseUrl("AUDIT_TEST_DATABASE_URL") ??
  isolatedDatabaseUrl("PERSISTENCE_TEST_DATABASE_URL");
const marketId = "CA_TSX" as const;
const currency = "CAD" as const;
const digestA = "a".repeat(64);
const digestB = "b".repeat(64);
const digestC = "c".repeat(64);
const sessions = ["2026-09-14", "2026-09-15", "2026-09-16"] as const;
const trainingSessions = ["2026-09-09", "2026-09-10", "2026-09-11"] as const;

const assumptions = {
  positionSize: 1_000,
  slippageBps: 2,
  feePerTrade: 1,
  costs: {
    entryCommission: 1,
    exitCommission: 1,
    estimatedRegulatoryFees: 0,
    slippageBps: 2,
    currency,
    brokerPricingVersion: "fp03-task12-costs-v1",
  },
  stopMethod: "STRUCTURAL",
  atrStopMultiple: 1,
  rewardRiskRatio: null,
  maxQuoteAgeSeconds: 30,
  sessionTimezone: "America/Toronto",
  noonCloseTime: "16:00",
  riskBudget: 250,
  maxNotional: 1_500,
  executionMode: "CAPACITY_CONSTRAINED",
  latencyMs: 0,
} as const;

describe.skipIf(!databaseUrl)("funded comparison PostgreSQL acceptance", () => {
  let pool: Pool;
  let repository: FundedComparisonRepository;
  let baselineRunId: string;
  let championRunId: string;
  let championAccountId: string;
  let challengerId: string;
  let profileId: string;
  let profileConfigId: string;
  let instrumentId: string;
  let specCounter = 0;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 8 });
    await migrate(pool);
    await pool.query(
      `TRUNCATE funded_comparison_failure,funded_comparison_result,
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
       scanner_profile_config,scanner_profile,strategy_definition,instrument
       CASCADE`,
    );
    repository = new FundedComparisonRepository(pool);
    await installFixtures();
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
  });

  async function installFixtures(): Promise<void> {
    baselineRunId = randomUUID();
    await pool.query(
      `INSERT INTO backtest_run(id,market_id,name,status,start_date,end_date,
         strategies,symbols,data_source,strategy_version,config_version,
         execution_model_version,starting_capital,position_size,slippage_bps,
         fee_per_trade,parameters,metrics,analyses,data_quality,replay_input,
         completed_at)
       VALUES($1,$2,'fp03 task12 baseline','COMPLETED','2026-09-09','2026-09-16',
         $3::jsonb,$4::jsonb,'CAPTURED_QUOTES','2026-09-01','config-1',
         'execution-v1',25000,1000,2,1,'{}'::jsonb,'{}'::jsonb,'[]'::jsonb,
         '{}'::jsonb,$5::jsonb,'2026-09-16T20:30:00.000Z')`,
      [
        baselineRunId,
        marketId,
        JSON.stringify(["ORB_RETEST"]),
        JSON.stringify([]),
        JSON.stringify({ version: "task12-fixture", marketId }),
      ],
    );
    const definitionId = randomUUID();
    profileId = randomUUID();
    profileConfigId = randomUUID();
    instrumentId = randomUUID();
    await pool.query(
      `INSERT INTO instrument(id,questrade_symbol_id,symbol,description,exchange,
         currency,security_type,industry_sector,is_quotable,is_tradable,active,
         market_id)
       VALUES($1,1987654321,'FP03TASK12','task12','TSX','CAD','Stock',
         'Technology',true,true,true,$2)`,
      [instrumentId, marketId],
    );
    await pool.query(
      `INSERT INTO strategy_definition(id,strategy_key,version,name,description)
       VALUES($1,'FP03_TASK12','2026-09-01','FP03 task12','acceptance')`,
      [definitionId],
    );
    await pool.query(
      `INSERT INTO scanner_profile(id,name,strategy_definition_id,enabled,
         display_order,market_id)
       VALUES($1,'fp03-task12',$2,false,0,$3)`,
      [profileId, definitionId, marketId],
    );
    await pool.query(
      `INSERT INTO scanner_profile_config(id,profile_id,config_version,
         parameters,market_id)
       VALUES($1,$2,'fp03-task12-config','{}'::jsonb,$3)`,
      [profileConfigId, profileId, marketId],
    );
    championAccountId = randomUUID();
    const ledger = new PostgresFundedLedgerStore(pool);
    await ledger.ensure(championAccountId, [
      currency,
      25_000,
      sessions[0],
      `${sessions[0]}T13:30:00.000Z`,
      2_500,
    ]);
    championRunId = randomUUID();
    await pool.query(
      `INSERT INTO paper_bot_run(id,source,market_id,session_date,
         session_timezone,scheduled_close_at,status,execution_model_version,
         assumptions,started_at,completed_at)
       VALUES($1,'LIVE',$2,$3,'America/Toronto',$4,'COMPLETED','execution-v1',
         $5::jsonb,$6,$7)`,
      [
        championRunId,
        marketId,
        sessions[0],
        `${sessions[0]}T20:00:00.000Z`,
        JSON.stringify(assumptions),
        `${sessions[0]}T13:30:00.000Z`,
        `${sessions[0]}T20:00:00.000Z`,
      ],
    );
    await new FundedOrderService(
      pool,
      championRunId,
      championAccountId,
      currency,
    ).bind(fundedPolicy(1, 0), {
      session: sessions[0],
      at: `${sessions[0]}T13:30:00.000Z`,
    });
    const datasetId = randomUUID();
    challengerId = randomUUID();
    await pool.query(
      `INSERT INTO funded_execution_dataset(id,market_id,currency,source_kind,
         evidence_schema_version,cohort_digest,cohort_components,
         dataset_policy_version,label_mapping_version,feature_version,
         qualification_policy_version,requested_cutoff,effective_cutoff,
         membership_digest,dataset_digest,row_count,counts,qualification_receipt,
         source_watermark,activation_eligible)
       VALUES($1,$2,$3,'HISTORICAL_REPLAY',2,$4,'{}'::jsonb,
         'funded-execution-dataset-v1','funded-execution-labels-v1',
         'funded-execution-features-v1','funded-execution-qualification-v1',
         '2026-09-11T20:00:00.000Z','2026-09-11T20:00:00.000Z',$5,$6,0,
         '{}'::jsonb,'{}'::jsonb,'{}'::jsonb,false)`,
      [datasetId, marketId, currency, digestB, digestA, digestC],
    );
    await pool.query(
      `INSERT INTO funded_execution_challenger(id,market_id,currency,
         cohort_digest,cohort_components,dataset_id,dataset_digest,
         model_version,model_type,artifact_digest,feature_version,
         label_mapping_version,qualification_policy_version,training_policy_version,
         training_code_version,status,eligible_for_activation,active,artifact,
         metrics,sample_counts)
       VALUES($1,$2,$3,$4,'{}'::jsonb,$5,$6,'funded-execution-v1',
         'FUNDED_EXECUTION_QUALITY',$7,'funded-execution-features-v1',
         'funded-execution-labels-v1','funded-execution-qualification-v1',
         'funded-execution-training-v1','task12','INACTIVE',false,false,
         '{}'::jsonb,'{}'::jsonb,'{}'::jsonb)`,
      [challengerId, marketId, currency, digestB, datasetId, digestC, digestA],
    );
  }

  function buildSpecInput(
    overrides: Partial<FundedComparisonSpecificationInput> = {},
  ): {
    input: FundedComparisonSpecificationInput;
    build: FundedComparisonSpecificationBuild;
  } {
    const frozenSessions = sessions.map((sessionDate) => {
      const projection = projectFundedComparisonSessionItems({
        baselineRunId,
        sessionDate,
        sessionStartAt: `${sessionDate}T13:30:00.000Z`,
        scheduledCloseAt: `${sessionDate}T20:00:00.000Z`,
        sessionTimezone: "America/Toronto",
        observations: [
          {
            runId: baselineRunId,
            sourceEventId: `task12-source-${sessionDate}`,
            sourceSignalId: null,
            setupInstanceId: `task12-setup-${sessionDate}`,
            instrumentId,
            symbol: "FP03TASK12",
            profileId,
            profileName: "fp03-task12",
            profileConfigId,
            configVersion: "fp03-task12-config",
            profileParameters: { scoreCutoff: 60 },
            strategyKey: "ORB_RETEST",
            strategyVersion: "2026-09-01",
            signalTimestamp: `${sessionDate}T14:30:00.000Z`,
            score: 70,
            entryReference: 10,
            stopReference: 9.8,
            targetReference: 10.5,
            atr14: 0.2,
            featureSnapshot: { featureVersion: "features-v1", atr14: 0.2 },
            reasonCodes: ["BREAKOUT"],
            sourceEventPayload: {
              signalSemanticsVersion: "setup-semantics-v2",
            },
            eligibilityStatus: "ELIGIBLE" as const,
            eligibilityReason: null,
          },
        ],
        quotes: [
          {
            instrumentId,
            timestamp: `${sessionDate}T14:30:30.000Z`,
            bid: 10,
            ask: 10.02,
            bidSize: 500,
            askSize: 500,
            sizeUnit: "SHARES" as const,
            sizeMultiplier: null,
            isDelayed: false,
            isHalted: false,
            source: "QUESTRADE" as const,
          },
        ],
        invalidations: [],
        contextsFor: () => [
          {
            signalKey: "MARKET_RELATIVE_STRENGTH",
            status: "STRONG",
            timestamp: `${sessionDate}T14:25:00.000Z`,
            benchmarkTimestamp: null,
          },
        ],
      });
      const chunks = chunkFundedComparisonItems(sessionDate, projection.items);
      return {
        sessionDate,
        sessionStartAt: `${sessionDate}T13:30:00.000Z`,
        scheduledCloseAt: `${sessionDate}T20:00:00.000Z`,
        sessionTimezone: "America/Toronto",
        itemCount: projection.items.length,
        chunkCount: chunks.length,
        sessionInputDigest: sessionInputDigestOf(sessionDate, chunks),
        chunks,
        opportunities: projection.opportunities,
      };
    });
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
      sessions: frozenSessions.map((session) => ({
        sessionDate: session.sessionDate,
        itemCount: session.itemCount,
        chunkCount: session.chunkCount,
        sessionInputDigest: session.sessionInputDigest,
      })),
      replay: {
        request: createBacktestSchema.parse({
          name: "fp03 task12 replay",
          marketId,
          startDate: "2026-09-09",
          endDate: "2026-09-16",
          strategies: ["ORB_RETEST"],
          symbols: [],
          startingCapital: 25_000,
          positionSize: 1_000,
          slippageBps: 2,
          feePerTrade: 1,
          parameters: { scoreCutoff: 60 },
        }),
        profiles: [
          {
            strategyKey: "ORB_RETEST",
            profileId,
            profileName: "fp03-task12",
            profileConfigId,
            configVersion: "fp03-task12-config",
          },
        ],
      },
      opportunities: frozenSessions.flatMap((session) => session.opportunities),
      champion: {
        kind: "DETERMINISTIC_FUNDED_POLICY",
        fundedPolicyVersion: "funded-cash-v1",
        portfolioPolicyVersion: "funded-portfolio-v2",
        policyDigest: digestA,
        sourceLiveRunId: championRunId,
        sourceAccountId: championAccountId,
        executionModelVersion: "execution-v1",
        costPolicyVersion: "fp03-task12-costs-v1",
        participationVersion: "participation-v1",
        runtimeVersion: "task12-runtime-v1",
        accountAssumptionDigest: digestB,
        assumptionsDigest: digestC,
      },
      challenger: {
        kind: "FUNDED_EXECUTION_POLICY_V1",
        policyVersion: FUNDED_COMPARISON_CHALLENGER_POLICY_VERSION,
        policyDigest: digestB,
        model: {
          modelId: challengerId,
          modelVersion: "funded-execution-v1",
          artifactDigest: digestA,
          datasetDigest: digestC,
          cohortDigest: digestB,
          featureVersion: "funded-execution-features-v1",
          predictionPolicyVersion: "funded-execution-prediction-v1",
          trainingPartitionDigest: digestA,
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
        trainingPartitionDigest: digestA,
        trainingSessionDigest:
          fundedComparisonTrainingSessionDigest(trainingSessions),
      },
      lastInputEffectiveAt: "2026-09-16T20:00:00.000Z",
      evidenceCutoffAt: "2026-09-16T21:00:00.000Z",
      specificationFrozenAt: "2026-09-16T22:00:00.000Z",
      ...overrides,
    };
    return {
      input,
      build: {
        specification: buildFundedComparisonSpecification(input),
        sessions: frozenSessions,
      },
    };
  }

  async function saveSpec(
    overrides: Partial<FundedComparisonSpecificationInput> = {},
  ) {
    specCounter += 1;
    const { build } = buildSpecInput({
      evidenceCutoffAt: `2026-09-16T21:00:${String(specCounter).padStart(2, "0")}.000Z`,
      ...overrides,
    });
    return repository.saveSpecification({
      build: () => build,
    });
  }

  it("returns the same immutable artifact on an exact retry and rejects a conflicting digest", async () => {
    const firstBuilt = buildSpecInput({
      evidenceCutoffAt: "2026-09-16T21:10:00.000Z",
    });
    const first = await repository.saveSpecification({
      build: () => firstBuilt.build,
    });
    const retry = await repository.saveSpecification({
      build: () => firstBuilt.build,
    });
    expect(retry.specId).toBe(first.specId);
    const conflicting = {
      specification: {
        ...first.specification,
        baseline: {
          ...first.specification.baseline,
          baselineResultDigest: digestC,
        },
      },
      sessions: firstBuilt.build.sessions.map((session) => ({
        ...session,
        chunks: [...session.chunks],
        opportunities: [...session.opportunities],
      })),
    };
    await expect(
      repository.saveSpecification({ build: () => conflicting }),
    ).rejects.toBeInstanceOf(FundedComparisonRepositoryError);
  });

  it("provisions a comparison-owned historical run through the production path and reuses it", async () => {
    const accountId = randomUUID();
    const input = {
      marketId,
      sessionDate: sessions[0],
      sessionTimezone: "America/Toronto",
      scheduledCloseAt: `${sessions[0]}T20:00:00.000Z`,
      sessionStartAt: `${sessions[0]}T13:30:00.000Z`,
      assumptions,
      policy: fundedPolicy(1, 0),
      accountId,
      currency,
      initialCash: 25_000,
      dailyLossLimit: 2_500,
      executionModelVersion: "execution-v1",
    } as const;
    const first = await provisionHistoricalFundedRun(pool, input);
    const retry = await provisionHistoricalFundedRun(pool, input);
    expect(first.reused).toBe(false);
    expect(retry).toEqual({ ...first, reused: true });
    const count = await pool.query<{ count: string }>(
      "SELECT count(*) FROM paper_bot_run WHERE id=$1",
      [first.runId],
    );
    expect(count.rows[0]?.count).toBe("1");
  });

  it("persists a distinct specification when a frozen identity legitimately changes", async () => {
    const first = await saveSpec({
      evidenceCutoffAt: "2026-09-16T21:11:00.000Z",
    });
    const changed = await saveSpec({
      evidenceCutoffAt: "2026-09-16T21:12:00.000Z",
    });
    expect(changed.specId).not.toBe(first.specId);
    expect(changed.specification.comparisonSpecDigest).not.toBe(
      first.specification.comparisonSpecDigest,
    );
    expect(
      (await repository.loadSpecification(changed.specId))!.specification
        .comparisonSpecDigest,
    ).toBe(changed.specification.comparisonSpecDigest);
  });

  it("keeps a one-side partial binding visibly non-ready", async () => {
    const receipt = await saveSpec();
    const accountId = randomUUID();
    const run = await provisionHistoricalFundedRun(pool, {
      marketId,
      sessionDate: sessions[0],
      sessionTimezone: "America/Toronto",
      scheduledCloseAt: `${sessions[0]}T20:00:00.000Z`,
      sessionStartAt: `${sessions[0]}T13:30:00.000Z`,
      assumptions,
      policy: fundedPolicy(1, 0),
      accountId,
      currency,
      initialCash: 25_000,
      dailyLossLimit: 2_500,
      executionModelVersion: "execution-v1",
    });
    await repository.bindSessionSide(receipt.specId, "CHAMPION", sessions[0], {
      runId: run.runId,
      accountId,
      marketId,
      currency,
      policyDigest: receipt.specification.champion.policyDigest,
      executionModelVersion: "execution-v1",
      accountAssumptionDigest:
        receipt.specification.champion.accountAssumptionDigest,
      boundAt: `${sessions[0]}T13:30:00.000Z`,
    });
    const availability = await repository.loadAvailability(receipt.specId);
    expect(availability?.status).not.toBe("READY");
    expect(availability?.resultAvailable).toBe(false);
  });

  it("rejects mutation of frozen source chunks and preserves their digest", async () => {
    const receipt = await saveSpec();
    const before = await repository.loadSessionChunks(
      receipt.specId,
      sessions[0],
    );
    await expect(
      pool.query(
        "UPDATE funded_comparison_input_chunk SET item_count=item_count WHERE spec_id=$1",
        [receipt.specId],
      ),
    ).rejects.toThrow(/immutable/i);
    const after = await repository.loadSessionChunks(
      receipt.specId,
      sessions[0],
    );
    expect(after).toEqual(before);
    const { comparisonSpecDigest, ...withoutDigest } = receipt.specification;
    expect(fundedComparisonSpecDigest(withoutDigest)).toBe(
      comparisonSpecDigest,
    );
  });

  it("does not silently accept a missing source session", async () => {
    const receipt = await saveSpec();
    await expect(
      repository.loadSessionChunks(receipt.specId, "2026-09-17"),
    ).resolves.toEqual([]);
  });

  it("keeps PostgreSQL comparison listings isolated by market", async () => {
    await saveSpec();
    expect(await repository.listSpecifications("CA_TSX")).not.toHaveLength(0);
    expect(await repository.listSpecifications("US_EQUITIES")).toEqual([]);
  });

  it("rejects cross-market side ownership at the PostgreSQL binding boundary", async () => {
    const receipt = await saveSpec();
    const accountId = randomUUID();
    const run = await provisionHistoricalFundedRun(pool, {
      marketId,
      sessionDate: sessions[0],
      sessionTimezone: "America/Toronto",
      scheduledCloseAt: `${sessions[0]}T20:00:00.000Z`,
      sessionStartAt: `${sessions[0]}T13:30:00.000Z`,
      assumptions,
      policy: fundedPolicy(1, 0),
      accountId,
      currency,
      initialCash: 25_000,
      dailyLossLimit: 2_500,
      executionModelVersion: "execution-v1",
    });
    await expect(
      repository.bindSessionSide(receipt.specId, "CHAMPION", sessions[0], {
        runId: run.runId,
        accountId,
        marketId: "US_EQUITIES",
        currency: "USD",
        policyDigest: receipt.specification.champion.policyDigest,
        executionModelVersion: "execution-v1",
        accountAssumptionDigest:
          receipt.specification.champion.accountAssumptionDigest,
        boundAt: `${sessions[0]}T13:30:00.000Z`,
      }),
    ).rejects.toThrow();
  });

  it("rejects an overlapping training window before persisting a PostgreSQL specification", async () => {
    const valid = buildSpecInput();
    const before = await pool.query<{ count: string }>(
      "SELECT count(*) FROM funded_comparison_spec WHERE baseline_backtest_run_id=$1",
      [valid.input.baseline.backtestRunId],
    );
    const invalid = {
      ...valid.input,
      training: {
        trainingSessionDates: ["2026-09-14"],
        trainingKnowledgeCutoffAt: "2026-09-14T20:00:00.000Z",
        trainingPartitionDigest: digestA,
        trainingSessionDigest: fundedComparisonTrainingSessionDigest([
          "2026-09-14",
        ]),
      },
    };
    await expect(
      repository.saveSpecification({
        build: () => ({
          specification: buildFundedComparisonSpecification(invalid),
          sessions: valid.build.sessions,
        }),
      }),
    ).rejects.toThrow(/first comparison session/i);
    const after = await pool.query<{ count: string }>(
      "SELECT count(*) FROM funded_comparison_spec WHERE baseline_backtest_run_id=$1",
      [valid.input.baseline.backtestRunId],
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });

  it("keeps comparison persistence separate from the FP04 prediction table", async () => {
    const result = await pool.query<{ count: string }>(
      "SELECT count(*) FROM funded_execution_prediction",
    );
    expect(result.rows[0]?.count).toBe("0");
  });
});
