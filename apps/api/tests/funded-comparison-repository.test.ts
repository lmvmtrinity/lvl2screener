import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FUNDED_COMPARISON_CHALLENGER_POLICY_VERSION,
  createBacktestSchema,
  fundedComparisonFailureReceiptSchema,
  fundedComparisonPolicyEvaluationSchema,
  fundedComparisonSessionMetricSchema,
  type FundedComparisonPolicyEvaluation,
  type FundedComparisonResult,
  type FundedComparisonSessionMetric,
  type FundedComparisonSourceOpportunity,
  type FundedComparisonSpecification,
} from "@tsx-scanner/contracts";
import { migrate } from "../src/database/migrate.js";
import { isolatedDatabaseUrl } from "./isolated-database.js";
import {
  FundedComparisonRepository,
  FundedComparisonRepositoryError,
  type FundedComparisonSessionFreeze,
} from "../src/paper-bot/funded-comparison-repository.js";
import {
  buildFundedComparisonSpecification,
  fundedComparisonTrainingSessionDigest,
  type FundedComparisonSpecificationInput,
} from "../src/paper-bot/funded-comparison-specification.js";
import { fundedComparisonSpecDigest } from "../src/paper-bot/funded-comparison-digest.js";
import {
  chunkFundedComparisonItems,
  projectFundedComparisonSessionItems,
  sessionInputDigestOf,
} from "../src/paper-bot/funded-comparison-input-freezer.js";
import { PostgresFundedLedgerStore } from "../src/paper-bot/funded-ledger-repository.js";
import { PostgresPaperBotStore } from "../src/paper-bot/paper-bot-repository.js";
import { FundedOrderService } from "../src/paper-bot/funded-order-service.js";
import { fundedPolicy } from "../src/paper-bot/funded-policy.js";
import { contentHash } from "../src/paper-bot/funded-evidence-digest.js";
import {
  fundedComparisonEvaluationMembershipDigest,
  fundedComparisonFailureDigest,
  fundedComparisonMetricsDigest,
  fundedComparisonResultDigest,
} from "../src/paper-bot/funded-comparison-digest.js";
import {
  fundedComparisonDeltaMetricsOf,
  fundedComparisonOutperformedSessions,
} from "../src/paper-bot/funded-comparison-metrics.js";

const databaseUrl =
  isolatedDatabaseUrl("AUDIT_TEST_DATABASE_URL") ??
  isolatedDatabaseUrl("PERSISTENCE_TEST_DATABASE_URL");

const digestA = "a".repeat(64);
const digestB = "b".repeat(64);
const digestC = "c".repeat(64);
const sessionDates = ["2026-09-14", "2026-09-15"] as const;
const TRAINING_DATES = ["2026-09-09", "2026-09-10", "2026-09-11"];

const assumptions = {
  positionSize: 1_000,
  slippageBps: 2,
  feePerTrade: 1,
  costs: {
    entryCommission: 1,
    exitCommission: 1,
    estimatedRegulatoryFees: 0,
    slippageBps: 2,
    currency: "CAD",
    brokerPricingVersion: "test-cost-policy-v1",
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
};

interface SideStudy {
  accountId: string;
  runIds: string[];
}

describe.skipIf(!databaseUrl)(
  "funded comparison repository on isolated PostgreSQL",
  () => {
    let pool: Pool;
    let repository: FundedComparisonRepository;
    let botStore: PostgresPaperBotStore;
    let ledger: PostgresFundedLedgerStore;
    const marketId = "CA_TSX" as const;
    let instrumentId: string;
    let profileId: string;
    let profileConfigId: string;
    let championSourceAccountId: string;
    let championSourceRunId: string;
    let challengerId: string;

    beforeAll(async () => {
      pool = new Pool({ connectionString: databaseUrl, max: 8 });
      await migrate(pool);
      await pool.query(
        `TRUNCATE
           funded_comparison_failure,
           funded_comparison_result,
           funded_comparison_session_metric,
           funded_comparison_policy_evaluation,
           funded_comparison_run_binding,
           funded_comparison_provisioning_intent,
           funded_comparison_input_chunk,
           funded_comparison_spec_opportunity,
           funded_comparison_spec_session,
           funded_comparison_spec,
           funded_execution_prediction,
           funded_execution_challenger,
           funded_execution_dataset_member,
           funded_execution_dataset,
           funded_decision_outcome,
           funded_decision_intent,
           funded_decision_refusal,
           funded_decision_evidence,
           paper_funded_fact,
           paper_funded_event,
           paper_entry_order,
           funded_historical_automation_policy,
           paper_funded_run,
           paper_funded_account,
           paper_signal_observation,
           paper_bot_run,
           backtest_run,
           scanner_profile_config,
           scanner_profile,
           strategy_definition,
           instrument
         CASCADE`,
      );
      repository = new FundedComparisonRepository(pool);
      botStore = new PostgresPaperBotStore(pool);
      ledger = new PostgresFundedLedgerStore(pool);
      await installFixtures();
    }, 180_000);

    afterAll(async () => {
      await pool?.end();
    });

    async function installFixtures(): Promise<void> {
      instrumentId = randomUUID();
      await pool.query(
        `INSERT INTO instrument(id,questrade_symbol_id,symbol,description,exchange,currency,
           security_type,industry_sector,is_quotable,is_tradable,active,market_id)
         VALUES($1,$2,$3,'FP03 comparison','TSX','CAD','Stock','Technology',true,true,true,$4)`,
        [
          instrumentId,
          Math.floor(Math.random() * 1_000_000_000) + 1_000_000_000,
          `FP03_${instrumentId.slice(0, 8)}`,
          marketId,
        ],
      );
      const definitionId = randomUUID();
      await pool.query(
        `INSERT INTO strategy_definition(id,strategy_key,version,name,description)
         VALUES($1,$2,'2026-09-01','FP03','FP03 comparison')`,
        [definitionId, `FP03_${definitionId.slice(0, 8)}`],
      );
      profileId = randomUUID();
      profileConfigId = randomUUID();
      await pool.query(
        `INSERT INTO scanner_profile(id,name,strategy_definition_id,enabled,display_order,market_id)
         VALUES($1,$2,$3,false,0,$4)`,
        [profileId, `fp03-${profileId.slice(0, 8)}`, definitionId, marketId],
      );
      await pool.query(
        `INSERT INTO scanner_profile_config(id,profile_id,config_version,parameters,market_id)
         VALUES($1,$2,$3,'{}'::jsonb,$4)`,
        [
          profileConfigId,
          profileId,
          `fp03-${profileConfigId.slice(0, 8)}`,
          marketId,
        ],
      );
      await pool.query(
        `INSERT INTO backtest_run(id,market_id,name,status,start_date,end_date,strategies,symbols,
           data_source,strategy_version,config_version,execution_model_version,starting_capital,
           position_size,slippage_bps,fee_per_trade,parameters,metrics,analyses,data_quality,
           replay_input,completed_at)
         VALUES($1,$2,'fp03 baseline','COMPLETED','2026-09-10','2026-09-15',$3::jsonb,
           $4::jsonb,'CAPTURED_QUOTES','2026-09-01','config-1','execution-v1',25000,1000,2,1,
           '{"scoreCutoff":60}'::jsonb,'{"trades":1}'::jsonb,'[]'::jsonb,'{"warnings":[]}'::jsonb,
           $5::jsonb, now())`,
        [
          baselineRunIdHolder.id,
          marketId,
          JSON.stringify(["ORB_RETEST"]),
          JSON.stringify(["FP03"]),
          JSON.stringify({
            version: "replay-input-v1",
            marketId,
            resolvedAt: "2026-09-15T20:00:00.000Z",
            requestedSymbols: ["FP03"],
            candidateInstruments: [],
            benchmarks: [],
            universeRefreshRunId: null,
            capturedHistoryAvailability: {
              source: "CAPTURED_QUOTES",
              observedAt: "2026-09-15T20:00:00.000Z",
              tables: {
                quoteSnapshot: { earliest: null, latest: null },
                candle: { earliest: null, latest: null },
              },
              replay: { earliestDate: null, latestDate: null },
            },
            warnings: [],
            candidateProvenance: "EXPLICIT_CAPTURED_COHORT",
            sessions: [],
            inputHash: digestA,
          }),
        ],
      );
      championSourceAccountId = randomUUID();
      await ledger.ensure(championSourceAccountId, [
        "CAD",
        25_000,
        "2026-09-14",
        "2026-09-14T13:30:00.000Z",
        2_500,
      ]);
      championSourceRunId = await createBoundRun(
        "LIVE",
        "2026-09-14",
        championSourceAccountId,
        "COMPLETED",
      );
      const datasetId = randomUUID();
      await pool.query(
        `INSERT INTO funded_execution_dataset(id,market_id,currency,source_kind,
           evidence_schema_version,cohort_digest,cohort_components,dataset_policy_version,
           label_mapping_version,feature_version,qualification_policy_version,
           requested_cutoff,effective_cutoff,membership_digest,dataset_digest,row_count,
           counts,qualification_receipt,source_watermark,activation_eligible)
         VALUES($1,$2,'CAD','HISTORICAL_REPLAY',2,$3,'{}'::jsonb,'funded-execution-dataset-v1',
           'funded-execution-labels-v1','funded-execution-features-v1',
           'funded-execution-qualification-v1','2026-09-11T20:00:00.000Z',
           '2026-09-11T20:00:00.000Z',$4,$5,200,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,false)`,
        [datasetId, marketId, digestB, digestA, digestC],
      );
      challengerId = randomUUID();
      await pool.query(
        `INSERT INTO funded_execution_challenger(id,market_id,currency,cohort_digest,
           cohort_components,dataset_id,dataset_digest,model_version,model_type,
           artifact_digest,feature_version,label_mapping_version,
           qualification_policy_version,training_policy_version,training_code_version,
           status,eligible_for_activation,active,artifact,metrics,sample_counts)
         VALUES($1,$2,'CAD',$3,'{}'::jsonb,$4,$5,'funded-execution-v1',
           'FUNDED_EXECUTION_QUALITY',$6,'funded-execution-features-v1',
           'funded-execution-labels-v1','funded-execution-qualification-v1',
           'funded-execution-training-v1','training-code-v1','INACTIVE',false,false,
           '{}'::jsonb,'{}'::jsonb,'{}'::jsonb)`,
        [challengerId, marketId, digestB, datasetId, digestC, digestA],
      );
    }

    const baselineRunIdHolder = { id: randomUUID() };

    async function createBoundRun(
      source: "LIVE" | "BACKTEST",
      sessionDate: string,
      accountId: string,
      status: "RUNNING" | "COMPLETED" = "RUNNING",
    ): Promise<string> {
      const runId = randomUUID();
      await pool.query(
        `INSERT INTO paper_bot_run(id,source,market_id,session_date,session_timezone,
           scheduled_close_at,status,execution_model_version,assumptions,started_at,completed_at)
         VALUES($1,$2,$3,$4,'America/Toronto',$5::timestamptz,$6,'execution-v1',$7::jsonb,now(),
           CASE WHEN $6='COMPLETED' THEN now() ELSE NULL END)`,
        [
          runId,
          source,
          marketId,
          sessionDate,
          `${sessionDate}T20:00:00.000Z`,
          status,
          JSON.stringify(assumptions),
        ],
      );
      await new FundedOrderService(pool, runId, accountId, "CAD").bind(
        fundedPolicy(1, 0),
        { session: sessionDate, at: `${sessionDate}T13:30:00.000Z` },
      );
      return runId;
    }

    async function completeRun(runId: string): Promise<void> {
      await pool.query(
        "UPDATE paper_bot_run SET status='COMPLETED',completed_at=now() WHERE id=$1",
        [runId],
      );
    }

    interface BuiltSpec {
      input: FundedComparisonSpecificationInput;
      specification: FundedComparisonSpecification;
      sessions: readonly FundedComparisonSessionFreeze[];
      opportunities: readonly FundedComparisonSourceOpportunity[];
    }

    function frozenObservation(sessionDate: string, setupInstanceId: string) {
      return {
        runId: baselineRunIdHolder.id,
        sourceEventId: randomUUID(),
        sourceSignalId: null,
        setupInstanceId,
        instrumentId,
        symbol: "FP03",
        profileId,
        profileName: "fp03",
        profileConfigId,
        configVersion: "config-1",
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
        sourceEventPayload: { signalSemanticsVersion: "setup-semantics-v2" },
        eligibilityStatus: "ELIGIBLE" as const,
        eligibilityReason: null,
      };
    }

    let specSequence = 0;
    function uniqueCutoff(step: number): string {
      return new Date(
        Date.UTC(2026, 8, 15, 21, 0, 0) + step * 60_000,
      ).toISOString();
    }

    function buildSpec(
      overrides: Partial<FundedComparisonSpecificationInput> = {},
      quietSessionDates: ReadonlySet<string> = new Set(),
    ): BuiltSpec {
      const sessions: FundedComparisonSessionFreeze[] = [];
      const opportunities: FundedComparisonSourceOpportunity[] = [];
      let lastInputEffectiveAt = "";
      for (const sessionDate of sessionDates) {
        const projection = projectFundedComparisonSessionItems({
          baselineRunId: baselineRunIdHolder.id,
          sessionDate,
          sessionStartAt: `${sessionDate}T13:30:00.000Z`,
          scheduledCloseAt: `${sessionDate}T20:00:00.000Z`,
          sessionTimezone: "America/Toronto",
          observations: quietSessionDates.has(sessionDate)
            ? []
            : [frozenObservation(sessionDate, `setup-${sessionDate}`)],
          quotes: [
            {
              instrumentId,
              timestamp: `${sessionDate}T14:30:30.000Z`,
              bid: 10,
              ask: 10.02,
              bidSize: 500,
              askSize: 500,
              sizeUnit: "SHARES",
              sizeMultiplier: null,
              isDelayed: false,
              isHalted: false,
              source: "QUESTRADE",
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
        const chunks = chunkFundedComparisonItems(
          sessionDate,
          projection.items,
        );
        sessions.push({
          sessionDate,
          sessionStartAt: `${sessionDate}T13:30:00.000Z`,
          scheduledCloseAt: `${sessionDate}T20:00:00.000Z`,
          sessionTimezone: "America/Toronto",
          itemCount: projection.items.length,
          chunkCount: chunks.length,
          sessionInputDigest: sessionInputDigestOf(sessionDate, chunks),
          chunks,
          opportunities: projection.opportunities,
        });
        opportunities.push(...projection.opportunities);
        for (const item of projection.items) {
          const at =
            item.kind === "SESSION_BOUNDARY"
              ? item.sessionStartAt
              : item.kind === "OPPORTUNITY"
                ? item.signalTimestamp
                : item.kind === "QUOTE"
                  ? item.timestamp
                  : item.at;
          if (at > lastInputEffectiveAt) lastInputEffectiveAt = at;
        }
      }
      const input: FundedComparisonSpecificationInput = {
        marketId,
        baseline: {
          backtestRunId: baselineRunIdHolder.id,
          configVersion: "config-1",
          strategyKeys: ["ORB_RETEST"],
          startDate: "2026-09-10",
          endDate: "2026-09-15",
          executionModelVersion: "execution-v1",
          replayInputDigest: digestA,
          baselineResultDigest: digestB,
          completedAt: "2026-09-15T20:30:00.000Z",
        },
        sessionDates: [...sessionDates],
        sessions: sessions.map((session) => ({
          sessionDate: session.sessionDate,
          itemCount: session.itemCount,
          chunkCount: session.chunkCount,
          sessionInputDigest: session.sessionInputDigest,
        })),
        replay: {
          request: createBacktestSchema.parse({
            name: "baseline",
            marketId,
            startDate: "2026-09-10",
            endDate: "2026-09-15",
            strategies: ["ORB_RETEST"],
            symbols: [],
            startingCapital: 25_000,
            positionSize: 1_000,
            slippageBps: 5,
            feePerTrade: 1,
            parameters: {
              ...createBacktestSchema.parse({
                name: "x",
                startDate: "2026-09-10",
                endDate: "2026-09-15",
              }).parameters,
              scoreCutoff: 60,
            },
          }),
          profiles: [
            {
              strategyKey: "ORB_RETEST",
              profileId,
              profileName: "fp03",
              profileConfigId,
              configVersion: "config-1",
            },
          ],
        },
        opportunities,
        champion: {
          kind: "DETERMINISTIC_FUNDED_POLICY",
          fundedPolicyVersion: "funded-cash-v1",
          portfolioPolicyVersion: "funded-portfolio-v2",
          policyDigest: digestA,
          sourceLiveRunId: championSourceRunId,
          sourceAccountId: championSourceAccountId,
          executionModelVersion: "execution-v1",
          costPolicyVersion: "test-cost-policy-v1",
          participationVersion: "participation-v1",
          runtimeVersion: "runtime-v1",
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
              fundedComparisonTrainingSessionDigest(TRAINING_DATES),
          },
        },
        capital: {
          initialCash: 25_000,
          dailyLossLimit: 2_500,
          riskConfigurationDigest: digestA,
        },
        training: {
          trainingSessionDates: TRAINING_DATES,
          trainingKnowledgeCutoffAt: "2026-09-11T20:00:00.000Z",
          trainingPartitionDigest: digestA,
          trainingSessionDigest:
            fundedComparisonTrainingSessionDigest(TRAINING_DATES),
        },
        lastInputEffectiveAt,
        evidenceCutoffAt: uniqueCutoff(1_000 + specSequence),
        specificationFrozenAt: "2026-09-15T22:00:00.000Z",
      };
      const merged = {
        ...input,
        ...overrides,
      };
      merged.specificationFrozenAt = new Date(
        Math.max(
          Date.parse(merged.evidenceCutoffAt),
          Date.parse(merged.specificationFrozenAt),
        ) +
          30 * 60_000,
      ).toISOString();
      return {
        input: merged,
        specification: buildFundedComparisonSpecification(merged),
        sessions,
        opportunities,
      };
    }

    async function saveSpec(
      overrides: Partial<FundedComparisonSpecificationInput> = {},
      quietSessionDates: ReadonlySet<string> = new Set(),
    ): Promise<{
      specId: string;
      built: BuiltSpec;
      specification: FundedComparisonSpecification;
    }> {
      specSequence += 1;
      const built = buildSpec(
        {
          evidenceCutoffAt: uniqueCutoff(2_000 + specSequence),
          ...overrides,
        },
        quietSessionDates,
      );
      const receipt = await repository.saveSpecification({
        build: (frozenAt) => ({
          specification: buildFundedComparisonSpecification({
            ...built.input,
            evidenceCutoffAt:
              overrides.evidenceCutoffAt ??
              new Date(
                Date.parse(frozenAt) - (60 + specSequence) * 1_000,
              ).toISOString(),
            specificationFrozenAt: frozenAt,
          }),
          sessions: built.sessions,
        }),
      });
      return {
        specId: receipt.specId,
        built,
        specification: receipt.specification,
      };
    }

    it("freezes one specification with a database-owned freeze time", async () => {
      const receipt = await repository.saveSpecification({
        build: (frozenAt) => {
          const built = buildSpec({
            evidenceCutoffAt: new Date(
              Date.parse(frozenAt) - 60_000,
            ).toISOString(),
          });
          return {
            specification: buildFundedComparisonSpecification({
              ...built.input,
              specificationFrozenAt: frozenAt,
            }),
            sessions: built.sessions,
          };
        },
      });
      const { comparisonSpecDigest, ...withoutDigest } = receipt.specification;
      expect(fundedComparisonSpecDigest(withoutDigest)).toBe(
        comparisonSpecDigest,
      );
      expect(
        receipt.specification.specificationFrozenAt >=
          receipt.specification.evidenceCutoffAt,
      ).toBe(true);
      const loaded = await repository.loadSpecification(receipt.specId);
      expect(loaded?.specification.comparisonSpecDigest).toBe(
        comparisonSpecDigest,
      );
      expect(loaded?.sessions).toHaveLength(2);
      expect(loaded?.opportunities).toHaveLength(2);
      expect(loaded?.sessions[0]!.chunks).toHaveLength(1);
      const chunks = await repository.loadSessionChunks(
        receipt.specId,
        "2026-09-14",
      );
      expect(chunks).toHaveLength(1);
      expect(chunks[0]!.items[0]!.item.kind).toBe("SESSION_BOUNDARY");
      const sameIdentity = await repository.findSpecificationIdByFrozenIdentity(
        {
          marketId,
          baselineBacktestRunId: baselineRunIdHolder.id,
          championPolicyDigest: receipt.specification.champion.policyDigest,
          challengerPolicyDigest: receipt.specification.challenger.policyDigest,
          evidenceCutoffAt: receipt.specification.evidenceCutoffAt,
        },
      );
      expect(sameIdentity).toBe(receipt.specId);
    });

    it("returns the existing specification on an exact digest retry and conflicts otherwise", async () => {
      const built = buildSpec({ evidenceCutoffAt: uniqueCutoff(9_500) });
      const first = await repository.saveSpecification({
        build: () => ({
          specification: built.specification,
          sessions: built.sessions,
        }),
      });
      const retry = await repository.saveSpecification({
        build: () => ({
          specification: built.specification,
          sessions: built.sessions,
        }),
      });
      expect(retry.specId).toBe(first.specId);
      const { comparisonSpecDigest, ...withoutDigest } = built.specification;
      expect(fundedComparisonSpecDigest(withoutDigest)).toBe(
        comparisonSpecDigest,
      );
      await expect(
        repository.saveSpecification({
          build: () => ({
            specification: {
              ...built.specification,
              comparisonSpecDigest: digestC,
            },
            sessions: built.sessions,
          }),
        }),
      ).rejects.toThrow(FundedComparisonRepositoryError);
    });

    it("rejects modification of every comparison table", async () => {
      const { specId } = await saveSpec();
      const tables = [
        "funded_comparison_spec",
        "funded_comparison_spec_session",
        "funded_comparison_spec_opportunity",
        "funded_comparison_input_chunk",
        "funded_comparison_provisioning_intent",
        "funded_comparison_run_binding",
        "funded_comparison_policy_evaluation",
        "funded_comparison_session_metric",
        "funded_comparison_result",
        "funded_comparison_failure",
      ];
      const triggers = await pool.query<{
        table_name: string;
        definition: string;
      }>(
        `SELECT t.relname AS table_name, pg_get_triggerdef(x.oid) AS definition
           FROM pg_trigger x
           JOIN pg_class t ON t.oid=x.tgrelid
           JOIN pg_namespace n ON n.oid=t.relnamespace
          WHERE n.nspname='public' AND NOT x.tgisinternal
            AND t.relname=ANY($1::text[])`,
        [tables],
      );
      for (const table of tables) {
        const trigger = triggers.rows.find((row) => row.table_name === table);
        expect(trigger?.definition, table).toMatch(
          /BEFORE (UPDATE OR DELETE|DELETE OR UPDATE)/,
        );
        expect(trigger?.definition, table).toContain(
          "reject_funded_comparison_mutation",
        );
      }
      const statements: [string, string][] = [
        [
          "funded_comparison_spec",
          `UPDATE funded_comparison_spec SET currency=currency WHERE id='${specId}'`,
        ],
        [
          "funded_comparison_spec_session",
          `UPDATE funded_comparison_spec_session SET ordinal=ordinal WHERE spec_id='${specId}'`,
        ],
        [
          "funded_comparison_spec_opportunity",
          `UPDATE funded_comparison_spec_opportunity SET ordinal=ordinal WHERE spec_id='${specId}'`,
        ],
        [
          "funded_comparison_input_chunk",
          `UPDATE funded_comparison_input_chunk SET item_count=item_count WHERE spec_id='${specId}'`,
        ],
        [
          "funded_comparison_spec",
          `DELETE FROM funded_comparison_spec WHERE id='${specId}'`,
        ],
        [
          "funded_comparison_spec_session",
          `DELETE FROM funded_comparison_spec_session WHERE spec_id='${specId}'`,
        ],
        [
          "funded_comparison_spec_opportunity",
          `DELETE FROM funded_comparison_spec_opportunity WHERE spec_id='${specId}'`,
        ],
        [
          "funded_comparison_input_chunk",
          `DELETE FROM funded_comparison_input_chunk WHERE spec_id='${specId}'`,
        ],
      ];
      for (const [table, statement] of statements)
        await expect(pool.query(statement), table).rejects.toThrow(
          /immutable/i,
        );
    });

    it("binds per side and session and derives availability", async () => {
      const { specId, specification } = await saveSpec();
      expect((await repository.loadAvailability(specId))?.status).toBe(
        "PENDING",
      );
      const champion = await createSideStudy();
      for (const [index, sessionDate] of sessionDates.entries()) {
        const binding = await repository.bindSessionSide(
          specId,
          "CHAMPION",
          sessionDate,
          {
            runId: champion.runIds[index]!,
            accountId: champion.accountId,
            marketId,
            currency: "CAD",
            policyDigest: specification.champion.policyDigest,
            executionModelVersion: "execution-v1",
            accountAssumptionDigest: digestB,
            boundAt: `${sessionDate}T13:30:00.000Z`,
          },
        );
        expect(binding.sessionDate).toBe(sessionDate);
        expect(binding.side).toBe("CHAMPION");
        const retry = await repository.bindSessionSide(
          specId,
          "CHAMPION",
          sessionDate,
          {
            runId: champion.runIds[index]!,
            accountId: champion.accountId,
            marketId,
            currency: "CAD",
            policyDigest: specification.champion.policyDigest,
            executionModelVersion: "execution-v1",
            accountAssumptionDigest: digestB,
            boundAt: "2026-09-15T13:31:00.000Z",
          },
        );
        expect(retry.boundAt).toBe(binding.boundAt);
      }
      expect(await repository.listBindings(specId)).toHaveLength(2);
      const availability = await repository.loadAvailability(specId);
      expect(availability?.status).toBe("RUNNING");
      expect(availability?.resultAvailable).toBe(false);
      expect(availability?.historicalVolumeStatus).toBeNull();
    });

    it("lists each of four two-session side bindings exactly once", async () => {
      const { specId, specification } = await saveSpec();
      const champion = await createSideStudy();
      const challenger = await createSideStudy();
      for (const [index, sessionDate] of sessionDates.entries()) {
        for (const [side, study, policyDigest] of [
          ["CHAMPION", champion, specification.champion.policyDigest],
          ["CHALLENGER", challenger, specification.challenger.policyDigest],
        ] as const)
          await repository.bindSessionSide(specId, side, sessionDate, {
            runId: study.runIds[index]!,
            accountId: study.accountId,
            marketId,
            currency: "CAD",
            policyDigest,
            executionModelVersion: "execution-v1",
            accountAssumptionDigest: digestB,
            boundAt: `${sessionDate}T13:30:00.000Z`,
          });
      }
      const bindings = await repository.listBindings(specId);
      expect(bindings).toHaveLength(4);
      expect(
        new Set(
          bindings.map(
            (binding) =>
              `${binding.side}:${binding.sessionDate}:${binding.runId}`,
          ),
        ).size,
      ).toBe(4);
    });

    it("persists one immutable exact provisioning intent before run binding", async () => {
      const { specId, specification } = await saveSpec();
      const intent = {
        specId,
        side: "CHAMPION" as const,
        sessionDate: sessionDates[0],
        accountId: randomUUID(),
        marketId,
        currency: "CAD" as const,
        policyDigest: specification.champion.policyDigest,
        executionModelVersion: "execution-v1",
        accountAssumptionDigest: digestB,
      };
      const stored = await repository.saveProvisioningIntent(intent);
      expect(await repository.saveProvisioningIntent(intent)).toEqual(stored);
      await expect(
        repository.saveProvisioningIntent({
          ...intent,
          accountId: randomUUID(),
        }),
      ).rejects.toThrow(/conflicts with the stored identity/i);
      await expect(
        pool.query(
          `UPDATE funded_comparison_provisioning_intent
              SET account_id=account_id
            WHERE spec_id=$1 AND side='CHAMPION' AND session_date=$2::date`,
          [specId, sessionDates[0]],
        ),
      ).rejects.toThrow(/immutable/i);
    });

    it("rejects binding one funded run to a second comparison specification", async () => {
      const first = await saveSpec();
      const second = await saveSpec();
      const study = await createSideStudy();
      const binding = {
        runId: study.runIds[0]!,
        accountId: study.accountId,
        marketId,
        currency: "CAD" as const,
        policyDigest: first.specification.champion.policyDigest,
        executionModelVersion: "execution-v1",
        accountAssumptionDigest: digestB,
        boundAt: "2026-09-14T13:30:00.000Z",
      };
      await repository.bindSessionSide(
        first.specId,
        "CHAMPION",
        "2026-09-14",
        binding,
      );
      await expect(
        repository.bindSessionSide(
          second.specId,
          "CHAMPION",
          "2026-09-14",
          binding,
        ),
      ).rejects.toThrow(/conflict/i);
    });

    it("rejects binding one funded run to the opposite comparison side", async () => {
      const { specId, specification } = await saveSpec();
      const study = await createSideStudy();
      const runId = study.runIds[0]!;
      await repository.bindSessionSide(specId, "CHAMPION", "2026-09-14", {
        runId,
        accountId: study.accountId,
        marketId,
        currency: "CAD",
        policyDigest: specification.champion.policyDigest,
        executionModelVersion: "execution-v1",
        accountAssumptionDigest: digestB,
        boundAt: "2026-09-14T13:30:00.000Z",
      });
      await expect(
        repository.bindSessionSide(specId, "CHALLENGER", "2026-09-14", {
          runId,
          accountId: study.accountId,
          marketId,
          currency: "CAD",
          policyDigest: specification.challenger.policyDigest,
          executionModelVersion: "execution-v1",
          accountAssumptionDigest: digestB,
          boundAt: "2026-09-14T13:30:00.000Z",
        }),
      ).rejects.toThrow(/conflict/i);
    });

    async function createSideStudy(): Promise<SideStudy> {
      const accountId = randomUUID();
      await ledger.ensure(accountId, [
        "CAD",
        25_000,
        sessionDates[0],
        `${sessionDates[0]}T13:30:00.000Z`,
        2_500,
      ]);
      const runIds: string[] = [];
      for (const sessionDate of sessionDates) {
        const runId = await createBoundRun("BACKTEST", sessionDate, accountId);
        await completeRun(runId);
        runIds.push(runId);
      }
      return { accountId, runIds };
    }

    async function appendSideEvaluationsAndMetrics(
      specId: string,
      side: "CHAMPION" | "CHALLENGER",
      study: SideStudy,
      opportunities: readonly FundedComparisonSourceOpportunity[],
      netReturn: number,
      fallback: boolean,
    ): Promise<readonly FundedComparisonPolicyEvaluation[]> {
      const evaluations: FundedComparisonPolicyEvaluation[] = [];
      for (const [index, sessionDate] of sessionDates.entries()) {
        const runId = study.runIds[index]!;
        const sessionOpportunities = opportunities.filter(
          (opportunity) => opportunity.sessionDate === sessionDate,
        );
        const sessionEvaluations: FundedComparisonPolicyEvaluation[] = [];
        for (const opportunity of sessionOpportunities) {
          const destination = await botStore.insertObservation({
            runId,
            sourceEventId: randomUUID(),
            sourceSignalId: null,
            setupInstanceId: randomUUID(),
            instrumentId,
            symbol: "FP03",
            profileId,
            profileName: "fp03",
            profileConfigId,
            configVersion: "config-1",
            profileParameters: { scoreCutoff: 60 },
            strategyKey: "ORB_RETEST",
            strategyVersion: "2026-09-01",
            signalTimestamp: opportunity.signalTimestamp,
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
            eligibilityStatus: "ELIGIBLE",
            eligibilityReason: null,
          });
          const withoutDigest = {
            specId,
            side,
            sessionDate,
            sourceOpportunityId: opportunity.sourceOpportunityId,
            sourceOrdinal: opportunity.sourceOrdinal,
            signalTimestamp: opportunity.signalTimestamp,
            batchKey: opportunity.signalTimestamp,
            championRank: opportunity.sourceOrdinal,
            appliedRank: opportunity.sourceOrdinal,
            destinationRunId: runId,
            destinationObservationId: destination.observation.id,
            disposition:
              side === "CHAMPION"
                ? ("CHAMPION_ORDER" as const)
                : fallback
                  ? ("FALLBACK_CHAMPION_ORDER" as const)
                  : ("CHAMPION_ORDER" as const),
            fallbackReason:
              side === "CHALLENGER" && fallback
                ? "PREDICTION_UNAVAILABLE"
                : null,
            prediction: null,
          };
          sessionEvaluations.push(
            fundedComparisonPolicyEvaluationSchema.parse({
              ...withoutDigest,
              evaluationDigest: contentHash(withoutDigest),
            }),
          );
        }
        await repository.appendPolicyEvaluations(
          specId,
          side,
          sessionDate,
          sessionEvaluations,
        );
        evaluations.push(...sessionEvaluations);
        const metricWithoutDigest: Omit<
          FundedComparisonSessionMetric,
          "metricDigest"
        > = {
          specId,
          side,
          sessionDate,
          marketId,
          currency: "CAD",
          valuation: "UNION_GRID_MTM",
          valuationReason: null,
          netReturn: sessionOpportunities.length === 0 ? 0 : netReturn,
          maxDrawdown: 20,
          tradeCount: sessionOpportunities.length === 0 ? 0 : 1,
          unrealizedPositionCount: 0,
          unresolvedOrderCount: 0,
          unresolvedReservationCount: 0,
          staleMarkCount: 0,
          valuationPointCount: 4,
        };
        await repository.appendSessionMetric(
          specId,
          side,
          fundedComparisonSessionMetricSchema.parse({
            ...metricWithoutDigest,
            metricDigest: contentHash(metricWithoutDigest),
          }),
        );
      }
      return evaluations;
    }

    it("appends complete policy evaluations with exact-retry semantics", async () => {
      const { specId, built, specification } = await saveSpec();
      const champion = await createSideStudy();
      await repository.bindSessionSide(specId, "CHAMPION", "2026-09-14", {
        runId: champion.runIds[0]!,
        accountId: champion.accountId,
        marketId,
        currency: "CAD",
        policyDigest: specification.champion.policyDigest,
        executionModelVersion: "execution-v1",
        accountAssumptionDigest: digestB,
        boundAt: "2026-09-14T13:30:00.000Z",
      });
      await repository.bindSessionSide(specId, "CHAMPION", "2026-09-15", {
        runId: champion.runIds[1]!,
        accountId: champion.accountId,
        marketId,
        currency: "CAD",
        policyDigest: specification.champion.policyDigest,
        executionModelVersion: "execution-v1",
        accountAssumptionDigest: digestB,
        boundAt: "2026-09-15T13:30:00.000Z",
      });
      const evaluations = await appendSideEvaluationsAndMetrics(
        specId,
        "CHAMPION",
        champion,
        built.opportunities,
        40,
        false,
      );
      const stored = await repository.listPolicyEvaluations(specId, "CHAMPION");
      expect(stored).toHaveLength(2);
      expect(stored.map((evaluation) => evaluation.sourceOrdinal)).toEqual([
        1, 1,
      ]);
      const sessionOne = evaluations.filter(
        (evaluation) => evaluation.sessionDate === "2026-09-14",
      );
      await repository.appendPolicyEvaluations(
        specId,
        "CHAMPION",
        "2026-09-14",
        sessionOne,
      );
      const conflicting = {
        ...sessionOne[0]!,
        destinationObservationId: randomUUID(),
        evaluationDigest: digestC,
      };
      await expect(
        repository.appendPolicyEvaluations(specId, "CHAMPION", "2026-09-14", [
          conflicting,
        ]),
      ).rejects.toThrow(FundedComparisonRepositoryError);
      const metrics = await repository.listSessionMetrics(specId, "CHAMPION");
      expect(metrics).toHaveLength(2);
      expect(
        metrics.every((metric) => metric.valuation === "UNION_GRID_MTM"),
      ).toBe(true);
    });

    it("accepts an exact empty evaluation slice only for a frozen quiet session", async () => {
      const quietDate = sessionDates[1];
      const { specId, specification } = await saveSpec(
        {},
        new Set([quietDate]),
      );
      const champion = await createSideStudy();
      await repository.bindSessionSide(specId, "CHAMPION", quietDate, {
        runId: champion.runIds[1]!,
        accountId: champion.accountId,
        marketId,
        currency: "CAD",
        policyDigest: specification.champion.policyDigest,
        executionModelVersion: "execution-v1",
        accountAssumptionDigest: digestB,
        boundAt: `${quietDate}T13:30:00.000Z`,
      });
      await expect(
        repository.appendPolicyEvaluations(specId, "CHAMPION", quietDate, []),
      ).resolves.toBeUndefined();
      await expect(
        repository.appendPolicyEvaluations(
          specId,
          "CHAMPION",
          "2026-09-16",
          [],
        ),
      ).rejects.toThrow(/exact frozen source-opportunity slice/i);
      await expect(
        repository.appendPolicyEvaluations(
          specId,
          "CHAMPION",
          sessionDates[0],
          [],
        ),
      ).rejects.toThrow(/exact frozen source-opportunity slice/i);
    });

    it("finalizes both sides with a populated session followed by a quiet session", async () => {
      const quietDate = sessionDates[1];
      const { specId, built, specification } = await saveSpec(
        {},
        new Set([quietDate]),
      );
      const champion = await createSideStudy();
      const challenger = await createSideStudy();
      for (const [index, date] of sessionDates.entries()) {
        await repository.bindSessionSide(specId, "CHAMPION", date, {
          runId: champion.runIds[index]!,
          accountId: champion.accountId,
          marketId,
          currency: "CAD",
          policyDigest: specification.champion.policyDigest,
          executionModelVersion: "execution-v1",
          accountAssumptionDigest: digestB,
          boundAt: `${date}T13:30:00.000Z`,
        });
        await repository.bindSessionSide(specId, "CHALLENGER", date, {
          runId: challenger.runIds[index]!,
          accountId: challenger.accountId,
          marketId,
          currency: "CAD",
          policyDigest: specification.challenger.policyDigest,
          executionModelVersion: "execution-v1",
          accountAssumptionDigest: digestB,
          boundAt: `${date}T13:30:00.000Z`,
        });
      }
      const championEvaluations = await appendSideEvaluationsAndMetrics(
        specId,
        "CHAMPION",
        champion,
        built.opportunities,
        40,
        false,
      );
      const challengerEvaluations = await appendSideEvaluationsAndMetrics(
        specId,
        "CHALLENGER",
        challenger,
        built.opportunities,
        55,
        true,
      );
      const result = buildResult(
        specification,
        fundedComparisonEvaluationMembershipDigest(
          championEvaluations.map((row) => row.evaluationDigest),
        ),
        fundedComparisonEvaluationMembershipDigest(
          challengerEvaluations.map((row) => row.evaluationDigest),
        ),
        true,
      );
      const finalized = await repository.finalizeResult(specId, result);
      expect(finalized.pairedSessions[1]).toMatchObject({
        sessionDate: quietDate,
        baselineNetReturn: 0,
        challengerNetReturn: 0,
      });
      expect((await repository.loadAvailability(specId))?.status).toBe("READY");
    });

    it("records interruption and terminal failures idempotently", async () => {
      const { specId } = await saveSpec();
      expect(await repository.listFailures(specId)).toHaveLength(0);
      const interruption = fundedComparisonFailureReceiptSchema.parse({
        specId,
        attemptId: "attempt-1",
        side: null,
        sessionDate: null,
        reason: "CANCELLED",
        classification: "INTERRUPTION",
        detail: "cancelled between sessions",
        failureDigest: digestA,
        recordedAt: "2026-09-15T21:00:00.000Z",
      });
      const withDigest = {
        ...interruption,
        failureDigest: fundedComparisonFailureDigest({
          specId,
          attemptId: interruption.attemptId,
          side: interruption.side,
          sessionDate: interruption.sessionDate,
          reason: interruption.reason,
          classification: interruption.classification,
          detail: interruption.detail,
        }),
      };
      await repository.appendFailure(withDigest);
      await repository.appendFailure(withDigest);
      expect((await repository.loadAvailability(specId))?.status).toBe(
        "CANCELLED",
      );
      await expect(
        repository.appendFailure({ ...withDigest, detail: "changed later" }),
      ).rejects.toThrow(FundedComparisonRepositoryError);
      const terminal = fundedComparisonFailureReceiptSchema.parse({
        ...interruption,
        reason: "STALE_MARK",
        classification: "TERMINAL",
        detail: "stale mark",
        failureDigest: fundedComparisonFailureDigest({
          specId,
          attemptId: interruption.attemptId,
          side: null,
          sessionDate: null,
          reason: "STALE_MARK",
          classification: "TERMINAL",
          detail: "stale mark",
        }),
      });
      await repository.appendFailure(terminal);
      const availability = await repository.loadAvailability(specId);
      expect(availability?.status).toBe("UNAVAILABLE");
      expect(availability?.failures).toHaveLength(2);
    });

    it("exposes no mutable side-state update method", () => {
      const prototype = Object.getOwnPropertyNames(
        FundedComparisonRepository.prototype,
      );
      for (const forbidden of [
        "markSideComplete",
        "markSideFailed",
        "updateBinding",
        "updateMetric",
        "updateResult",
      ])
        expect(prototype).not.toContain(forbidden);
      expect(
        prototype.some((name) => /order|ledger|reservation/i.test(name)),
      ).toBe(false);
    });

    it("isolates read projections by market", async () => {
      const { specId } = await saveSpec();
      const caList = await repository.listSpecifications("CA_TSX");
      expect(caList.some((row) => row.specificationId === specId)).toBe(true);
      expect(await repository.listSpecifications("US_EQUITIES")).toEqual([]);
    });

    it("finalizes exactly one immutable paired result", async () => {
      const { specId, built, specification } = await saveSpec();
      const champion = await createSideStudy();
      const challenger = await createSideStudy();
      for (const [index, sessionDate] of sessionDates.entries()) {
        await repository.bindSessionSide(specId, "CHAMPION", sessionDate, {
          runId: champion.runIds[index]!,
          accountId: champion.accountId,
          marketId,
          currency: "CAD",
          policyDigest: specification.champion.policyDigest,
          executionModelVersion: "execution-v1",
          accountAssumptionDigest: digestB,
          boundAt: `${sessionDate}T13:30:00.000Z`,
        });
        await repository.bindSessionSide(specId, "CHALLENGER", sessionDate, {
          runId: challenger.runIds[index]!,
          accountId: challenger.accountId,
          marketId,
          currency: "CAD",
          policyDigest: specification.challenger.policyDigest,
          executionModelVersion: "execution-v1",
          accountAssumptionDigest: digestB,
          boundAt: `${sessionDate}T13:30:00.000Z`,
        });
      }
      await expect(
        repository.finalizeResult(
          specId,
          buildResult(specification, digestA, digestA),
        ),
      ).rejects.toThrow(/incomplete|does not match|do not map/i);
      const championEvaluations = await appendSideEvaluationsAndMetrics(
        specId,
        "CHAMPION",
        champion,
        built.opportunities,
        40,
        false,
      );
      expect((await repository.loadAvailability(specId))?.status).toBe(
        "RUNNING",
      );
      const challengerEvaluations = await appendSideEvaluationsAndMetrics(
        specId,
        "CHALLENGER",
        challenger,
        built.opportunities,
        55,
        true,
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
      const result = buildResult(
        specification,
        championEvaluationDigest,
        challengerEvaluationDigest,
      );
      const inconsistentChampion = {
        ...result.champion,
        return: {
          ...result.champion.return,
          totalNetReturn: result.champion.return.totalNetReturn + 2,
          returnPctOfInitialCash:
            (result.champion.return.totalNetReturn + 2) / 25_000,
          sessions: result.champion.return.sessions.map((row) => ({
            ...row,
            netReturn: row.netReturn + 1,
          })),
        },
      };
      const inconsistentChallenger = {
        ...result.challenger,
        return: {
          ...result.challenger.return,
          totalNetReturn: result.challenger.return.totalNetReturn + 2,
          returnPctOfInitialCash:
            (result.challenger.return.totalNetReturn + 2) / 25_000,
          sessions: result.challenger.return.sessions.map((row) => ({
            ...row,
            netReturn: row.netReturn + 1,
          })),
        },
      };
      const inconsistentChampionDigest =
        fundedComparisonMetricsDigest(inconsistentChampion);
      const inconsistentChallengerDigest = fundedComparisonMetricsDigest(
        inconsistentChallenger,
      );
      await expect(
        repository.finalizeResult(specId, {
          ...result,
          champion: inconsistentChampion,
          challenger: inconsistentChallenger,
          championMetricsDigest: inconsistentChampionDigest,
          challengerMetricsDigest: inconsistentChallengerDigest,
          resultDigest: fundedComparisonResultDigest({
            comparisonSpecDigest: specification.comparisonSpecDigest,
            championEvaluationDigest,
            challengerEvaluationDigest,
            championMetricsDigest: inconsistentChampionDigest,
            challengerMetricsDigest: inconsistentChallengerDigest,
            orderedPairedSessionDigests: result.pairedSessions.map((row) =>
              contentHash(row),
            ),
          }),
        }),
      ).rejects.toThrow(/stored metric|paired result/i);
      // Derived deltas are recomputed from the retained side metrics at
      // finalization: a tampered delta tree is refused even though the result
      // digest does not cover it.
      await expect(
        repository.finalizeResult(specId, {
          ...result,
          deltas: {
            ...result.deltas,
            totalNetReturn: result.deltas.totalNetReturn + 1,
          },
        }),
      ).rejects.toThrow(/deltas and paired values do not match/i);
      const committed = await repository.finalizeResult(specId, result);
      expect(committed.resultDigest).toBe(result.resultDigest);
      expect(await repository.finalizeResult(specId, result)).toEqual(result);
      const availability = await repository.loadAvailability(specId);
      expect(availability?.status).toBe("READY");
      expect(availability?.resultDigest).toBe(result.resultDigest);
      expect(availability?.historicalVolumeStatus).toBe(
        "INSUFFICIENT_SESSIONS",
      );
      const tamperedPaired = [
        { ...result.pairedSessions[0]!, challengerNetReturn: 60 },
        result.pairedSessions[1]!,
      ];
      await expect(
        repository.finalizeResult(specId, {
          ...result,
          pairedSessions: tamperedPaired,
          resultDigest: fundedComparisonResultDigest({
            comparisonSpecDigest: specification.comparisonSpecDigest,
            championEvaluationDigest,
            challengerEvaluationDigest,
            championMetricsDigest: result.championMetricsDigest,
            challengerMetricsDigest: result.challengerMetricsDigest,
            orderedPairedSessionDigests: tamperedPaired.map((row) =>
              contentHash(row),
            ),
          }),
        }),
      ).rejects.toThrow(
        /RESULT_DIGEST_CONFLICT|different result digest|stored metric/i,
      );
    });

    it("requires the complete exact session membership for policy evaluations", async () => {
      const { specId, built, specification } = await saveSpec();
      const champion = await createSideStudy();
      for (const [index, sessionDate] of sessionDates.entries())
        await repository.bindSessionSide(specId, "CHAMPION", sessionDate, {
          runId: champion.runIds[index]!,
          accountId: champion.accountId,
          marketId,
          currency: "CAD",
          policyDigest: specification.champion.policyDigest,
          executionModelVersion: "execution-v1",
          accountAssumptionDigest: digestB,
          boundAt: `${sessionDate}T13:30:00.000Z`,
        });
      // An empty set is not a complete session membership and writes nothing.
      await expect(
        repository.appendPolicyEvaluations(
          specId,
          "CHAMPION",
          "2026-09-14",
          [],
        ),
      ).rejects.toThrow(/exact frozen source-opportunity slice/i);
      expect(
        await repository.listPolicyEvaluations(
          specId,
          "CHAMPION",
          "2026-09-14",
        ),
      ).toHaveLength(0);
      const evaluations = await appendSideEvaluationsAndMetrics(
        specId,
        "CHAMPION",
        champion,
        built.opportunities,
        40,
        false,
      );
      const sessionTwo = evaluations.find(
        (evaluation) => evaluation.sessionDate === "2026-09-15",
      )!;
      const sessionOne = evaluations.find(
        (evaluation) => evaluation.sessionDate === "2026-09-14",
      )!;
      const foreign = {
        ...sessionTwo,
        sourceOpportunityId: sessionOne.sourceOpportunityId,
      };
      await expect(
        repository.appendPolicyEvaluations(specId, "CHAMPION", "2026-09-15", [
          foreign,
        ]),
      ).rejects.toThrow(/exact frozen source-opportunity slice/i);
      expect(
        await repository.listPolicyEvaluations(
          specId,
          "CHAMPION",
          "2026-09-15",
        ),
      ).toHaveLength(1);
    });

    it("requires every immutable binding field to match on an exact retry", async () => {
      const { specId, specification } = await saveSpec();
      const champion = await createSideStudy();
      const binding = {
        runId: champion.runIds[0]!,
        accountId: champion.accountId,
        marketId,
        currency: "CAD" as const,
        policyDigest: specification.champion.policyDigest,
        executionModelVersion: "execution-v1",
        accountAssumptionDigest: digestB,
        boundAt: "2026-09-14T13:30:00.000Z",
      };
      await repository.bindSessionSide(
        specId,
        "CHAMPION",
        "2026-09-14",
        binding,
      );
      for (const changed of [
        { runId: champion.runIds[1]! },
        { accountId: randomUUID() },
        { policyDigest: digestC },
        { executionModelVersion: "execution-v2" },
        { accountAssumptionDigest: digestA },
      ]) {
        await expect(
          repository.bindSessionSide(specId, "CHAMPION", "2026-09-14", {
            ...binding,
            ...changed,
          }),
        ).rejects.toThrow(/conflicts with the stored identity/i);
      }
      const stored = await repository.findBinding(
        specId,
        "CHAMPION",
        "2026-09-14",
      );
      expect(stored?.runId).toBe(binding.runId);
    });

    it("owns the failure recording time from the database clock", async () => {
      const { specId } = await saveSpec();
      const receipt = fundedComparisonFailureReceiptSchema.parse({
        specId,
        attemptId: "attempt-clock",
        side: null,
        sessionDate: null,
        reason: "STALE_MARK",
        classification: "TERMINAL",
        detail: "stale mark",
        failureDigest: fundedComparisonFailureDigest({
          specId,
          attemptId: "attempt-clock",
          side: null,
          sessionDate: null,
          reason: "STALE_MARK",
          classification: "TERMINAL",
          detail: "stale mark",
        }),
        recordedAt: "2020-01-01T00:00:00.000Z",
      });
      const stored = await repository.appendFailure(receipt);
      expect(stored.recordedAt).not.toBe(receipt.recordedAt);
      expect(Date.parse(stored.recordedAt)).toBeGreaterThan(
        Date.parse("2026-01-01T00:00:00.000Z"),
      );
      const retry = await repository.appendFailure(receipt);
      expect(retry.recordedAt).toBe(stored.recordedAt);
      const listed = await repository.listFailures(specId);
      expect(listed[0]!.recordedAt).toBe(stored.recordedAt);
    });

    function buildResult(
      specification: FundedComparisonSpecification,
      championEvaluationDigest: string,
      challengerEvaluationDigest: string,
      quietSecondSession = false,
    ): FundedComparisonResult {
      const withSessionReturns = (
        metrics: ReturnType<typeof sideMetrics>,
        netReturn: number,
      ) => {
        const sessions = sessionDates.map((sessionDate, index) => ({
          sessionDate,
          netReturn: quietSecondSession && index === 1 ? 0 : netReturn,
        }));
        const totalNetReturn = sessions.reduce(
          (total, session) => total + session.netReturn,
          0,
        );
        return {
          ...metrics,
          return: {
            totalNetReturn,
            returnPctOfInitialCash: totalNetReturn / 25_000,
            sessions,
          },
          stability: {
            ...metrics.stability,
            zeroTradeSessions: quietSecondSession ? 1 : 0,
          },
        };
      };
      const champion = withSessionReturns(
        sideMetrics(40, 20, sessionDates.length),
        40,
      );
      const challenger = withSessionReturns(
        sideMetrics(55, 20, sessionDates.length),
        55,
      );
      const championMetricsDigest = fundedComparisonMetricsDigest(champion);
      const challengerMetricsDigest = fundedComparisonMetricsDigest(challenger);
      const pairedSessions = sessionDates.map((sessionDate, index) => ({
        sessionDate,
        baselineNetReturn: quietSecondSession && index === 1 ? 0 : 40,
        challengerNetReturn: quietSecondSession && index === 1 ? 0 : 55,
        baselineMaxDrawdown: 20,
        challengerMaxDrawdown: 20,
        valuation: "UNION_GRID_MTM" as const,
        coverage: "VERIFIED" as const,
      }));
      return {
        resultVersion: "funded-comparison-result-v1",
        comparisonSpecDigest: specification.comparisonSpecDigest,
        marketId,
        currency: "CAD",
        sessionCount: sessionDates.length,
        historicalVolumeStatus: "INSUFFICIENT_SESSIONS",
        pairedSessions,
        champion,
        challenger,
        deltas: fundedComparisonDeltaMetricsOf(
          champion,
          challenger,
          pairedSessions,
        ),
        challengerOutperformedSessions:
          fundedComparisonOutperformedSessions(pairedSessions),
        championEvaluationDigest,
        challengerEvaluationDigest,
        championMetricsDigest,
        challengerMetricsDigest,
        resultDigest: fundedComparisonResultDigest({
          comparisonSpecDigest: specification.comparisonSpecDigest,
          championEvaluationDigest,
          challengerEvaluationDigest,
          championMetricsDigest,
          challengerMetricsDigest,
          orderedPairedSessionDigests: pairedSessions.map((row) =>
            contentHash(row),
          ),
        }),
      };
    }
  },
);

function sideMetrics(
  netReturn: number,
  drawdown: number,
  sessionCount: number,
) {
  return {
    return: {
      totalNetReturn: netReturn * sessionCount,
      returnPctOfInitialCash: (netReturn * sessionCount) / 25_000,
      sessions: sessionDates
        .slice(0, sessionCount)
        .map((sessionDate) => ({ sessionDate, netReturn })),
    },
    drawdown: {
      maxDrawdown: drawdown,
      maxDrawdownPctOfInitialCash: drawdown / 25_000,
    },
    dailyLoss: { limitHits: 0, mostNegativeDailyPnl: -10, sessionsBlocked: 0 },
    risk: { maxOpenRisk: 250, maxGrossNotional: 1_000, maxOpenPositions: 1 },
    activity: {
      turnover: 1_000,
      requested: sessionCount,
      partialFills: 0,
      fullFills: sessionCount,
      zeroFills: 0,
    },
    execution: {
      fillFraction: 1,
      averageSlippagePerShare: 0.01,
      totalModeledCosts: 2,
    },
    veto: { classification: "AVAILABLE" as const, counts: [] },
    declines: [] as { reason: string; count: number }[],
    opportunityCost: {
      declinedOrVetoedCount: 0,
      forgoneRequestedNotional: 0,
      forgoneRequestedRisk: 0,
      requestedCapitalAvailableCount: 0,
      requestedCapitalUnavailableCount: 0,
      realizedValue: null,
      provableCount: 0,
      unprovableCount: 0,
    },
    stability: {
      sessionCount,
      zeroTradeSessions: 0,
      longestReturnSignRun: sessionCount,
    },
    integrity: {
      unresolvedExposure: 0,
      fallbackDecisionCount: 0,
      predictionAvailableCount: 0,
      predictionRequiredCount: 0,
      findings: [] as string[],
    },
  };
}
