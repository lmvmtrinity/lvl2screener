import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FUNDED_EXECUTION_FEATURE_NAMES,
  FUNDED_EXECUTION_FEATURE_VERSION,
  FUNDED_EXECUTION_LABEL_MAPPING_VERSION,
  FUNDED_DECISION_EVIDENCE_SCHEMA_VERSION,
  fundedDecisionTimeInputSchema,
  fundedExecutionChallengerSchema,
  fundedExecutionPredictionRecordSchema,
  type FundedCohortIdentity,
  type FundedExecutionChallenger,
  type FundedExecutionModelArtifact,
  type FundedExecutionPredictionOutput,
  type FundedExecutionTrainingResult,
} from "@tsx-scanner/contracts";
import { migrate } from "../src/database/migrate.js";
import { isolatedDatabaseUrl } from "./isolated-database.js";
import { PostgresPaperBotStore } from "../src/paper-bot/paper-bot-repository.js";
import { PostgresFundedLedgerStore } from "../src/paper-bot/funded-ledger-repository.js";
import { FundedOrderService } from "../src/paper-bot/funded-order-service.js";
import { FundedFactAdapter } from "../src/paper-bot/funded-fact-adapter.js";
import { FundedDecisionEvidenceRepository } from "../src/paper-bot/funded-decision-evidence-repository.js";
import { fundedPolicy } from "../src/paper-bot/funded-policy.js";
import {
  decisionContentDigest,
  fundedCohortDigest,
} from "../src/paper-bot/funded-evidence-digest.js";
import { PostgresFundedExecutionTrainingStore } from "../src/statistical-models/funded-execution-training-repository.js";
import { FundedExecutionTrainingService } from "../src/statistical-models/funded-execution-training-service.js";
import {
  contentHash,
  fundedExecutionArtifactDigest,
} from "../src/statistical-models/funded-execution-digest.js";
import {
  FundedExecutionPredictionService,
  PostgresFundedExecutionPredictionStore,
  predictionDigest,
} from "../src/statistical-models/funded-execution-prediction.js";
import type { FundedExecutionTrainingClient } from "../src/statistical-models/funded-execution-training-service.js";

const databaseUrl =
  isolatedDatabaseUrl("AUDIT_TEST_DATABASE_URL") ??
  isolatedDatabaseUrl("PERSISTENCE_TEST_DATABASE_URL");

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
} as const;

describe.skipIf(!databaseUrl)(
  "funded execution learning persistence on isolated PostgreSQL",
  () => {
    let pool: Pool;
    let botStore: PostgresPaperBotStore;
    let ledger: PostgresFundedLedgerStore;

    beforeAll(async () => {
      pool = new Pool({ connectionString: databaseUrl, max: 8 });
      await migrate(pool);
      await pool.query(
        `TRUNCATE
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
           paper_funded_run,
           paper_funded_account,
           paper_signal_observation,
           paper_bot_run,
           scanner_profile_config,
           scanner_profile,
           strategy_definition,
           instrument
         CASCADE`,
      );
      botStore = new PostgresPaperBotStore(pool);
      ledger = new PostgresFundedLedgerStore(pool);
    }, 180_000);

    afterAll(async () => {
      await pool?.end();
    });

    async function insertInstrument(marketId: "CA_TSX" | "US_EQUITIES") {
      const instrumentId = randomUUID();
      const currency = marketId === "CA_TSX" ? "CAD" : "USD";
      await pool.query(
        `INSERT INTO instrument(id,questrade_symbol_id,symbol,description,exchange,currency,
         security_type,industry_sector,is_quotable,is_tradable,active,market_id)
         VALUES($1,$2,$3,'FP02 integration',$4,$5,'Stock','Technology',true,true,true,$6)`,
        [
          instrumentId,
          Math.floor(Math.random() * 1_000_000_000) + 1_000_000_000,
          `FP02_${instrumentId.slice(0, 8)}`,
          marketId === "CA_TSX" ? "TSX" : "NASDAQ",
          currency,
          marketId,
        ],
      );
      return instrumentId;
    }

    async function seedDecision(input: {
      runId: string;
      sessionDate: string;
      index: number;
      instrumentId: string;
      marketId: "CA_TSX" | "US_EQUITIES";
      currency: "CAD" | "USD";
      sourceKind: "LIVE_PAPER" | "HISTORICAL_REPLAY";
      cohort: FundedCohortIdentity;
      fill: "FILLED" | "NO_FILL" | "NONE";
      outcomeOffsetMinutes: number;
    }) {
      const profileId = randomUUID();
      const configId = randomUUID();
      const definitionId = randomUUID();
      await pool.query(
        `INSERT INTO strategy_definition(id,strategy_key,version,name,description)
         VALUES($1,$2,'2026-09-01','FP02','FP02 integration')`,
        [definitionId, `FP02_${definitionId.slice(0, 8)}`],
      );
      await pool.query(
        `INSERT INTO scanner_profile(id,name,strategy_definition_id,enabled,display_order)
         VALUES($1,$2,$3,true,0)`,
        [profileId, `fp02-${profileId.slice(0, 8)}`, definitionId],
      );
      await pool.query(
        `INSERT INTO scanner_profile_config(id,profile_id,config_version,parameters)
         VALUES($1,$2,$3,'{}'::jsonb)`,
        [configId, profileId, `fp02-${configId.slice(0, 8)}`],
      );
      const signalAt = `${input.sessionDate}T14:28:00.000Z`;
      const accountId = await accountIdFor(input.runId);
      const observation = await botStore.insertObservation({
        runId: input.runId,
        sourceEventId: randomUUID(),
        sourceSignalId: null,
        setupInstanceId: null,
        instrumentId: input.instrumentId,
        symbol: `FP02_${input.index}`,
        profileId,
        profileName: "fp02",
        profileConfigId: configId,
        configVersion: "v1",
        profileParameters: { signalValidityMinutes: 60 },
        strategyKey: "ORB_STANDARD",
        strategyVersion: "2026-09-01",
        signalTimestamp: signalAt,
        score: 60 + (input.index % 40),
        entryReference: 10.02,
        stopReference: 9.8,
        targetReference: 10.6,
        atr14: 0.22,
        featureSnapshot: { featureVersion: "1.2.0", configVersion: "v1" },
        reasonCodes: ["BREAKOUT"],
        sourceEventPayload: { signalSemanticsVersion: "setup-semantics-v2" },
        eligibilityStatus: "ELIGIBLE",
        eligibilityReason: null,
      });
      const observationIdStored = observation.observation.id;
      const decisionAt = `${input.sessionDate}T14:30:00.000Z`;
      const content = fundedDecisionTimeInputSchema.parse({
        marketId: input.marketId,
        currency: input.currency,
        accountId,
        runId: input.runId,
        observationId: observationIdStored,
        evidenceSchemaVersion: FUNDED_DECISION_EVIDENCE_SCHEMA_VERSION,
        fundedPolicyVersion: input.cohort.fundedPolicyVersion,
        executionModelVersion: input.cohort.executionModelVersion,
        featureVersion: input.cohort.featureVersion,
        sourceKind: input.sourceKind,
        action: "SUBMIT",
        policyReason: null,
        decisionAt,
        strategyKey: "ORB_STANDARD",
        strategyVersion: "2026-09-01",
        score: 60 + (input.index % 40),
        reasonCodes: ["BREAKOUT"],
        requestedCapital: {
          status: "AVAILABLE",
          maximumDebit: 1_500,
          maximumRisk: 250,
        },
        quote: {
          status: "AVAILABLE",
          snapshot: {
            timestamp: signalAt,
            bid: 10.01,
            ask: 10.03,
            bidSize: 500,
            askSize: 400,
            sizeUnit: "SHARES",
            sizeMultiplier: 1,
            dataStatus: "REALTIME",
            actionable: true,
          },
        },
        model: { status: "UNAVAILABLE", reason: "No signal model was active" },
        portfolio: {
          status: "AVAILABLE",
          cash: 10_000,
          reservedCash: 0,
          openRisk: 0,
          reservedRisk: 0,
          positionCount: 0,
          sectorExposure: {},
          dailyPnl: 0,
          entriesAllowed: true,
          cooldownActive: false,
          consecutiveStops: 0,
        },
        context: { status: "UNAVAILABLE", reason: "No context captured" },
        execution: {
          positionSize: 1_000,
          slippageBps: 2,
          feePerTrade: 1,
          costs: null,
          riskBudget: 250,
          maxNotional: 3_000,
          economics: null,
          stopMethod: "STRUCTURAL",
          atrStopMultiple: 1,
          rewardRiskRatio: null,
          maxQuoteAgeSeconds: 30,
          sessionTimezone: "America/Toronto",
          noonCloseTime: "16:00",
          executionMode: "CAPACITY_CONSTRAINED",
          latencyMs: 0,
          evidenceScope: null,
        },
        sizingContext: null,
        policy: {
          projectionVersion: "funded-cash-v1",
          participation: 0.25,
          impactBps: 2,
          latencyPolicy: "CAPTURED_PER_ORDER",
          portfolio: null,
        },
        signal: {
          signalTimestamp: signalAt,
          entryReference: 10.02,
          stopReference: 9.8,
          targetReference: 10.6,
          atr14: 0.22,
        },
      });
      await pool.query(
        `INSERT INTO funded_decision_evidence(
           run_id,observation_id,sequence,market_id,currency,account_id,funded_policy_version,
           execution_model_version,feature_version,source_kind,action,decision_at,captured_at,
           content_digest,decision_content,cohort_digest,cohort_components,evidence_schema_version)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'SUBMIT',$11,$11,$12,$13::jsonb,$14,$15::jsonb,2)`,
        [
          input.runId,
          observationIdStored,
          input.index + 1,
          input.marketId,
          input.currency,
          accountId,
          input.cohort.fundedPolicyVersion,
          input.cohort.executionModelVersion,
          input.cohort.featureVersion,
          input.sourceKind,
          decisionAt,
          decisionContentDigest(content),
          JSON.stringify(content),
          input.cohort.cohortDigest,
          JSON.stringify(withoutDigest(input.cohort)),
        ],
      );
      const availableAt = new Date(
        Date.parse(decisionAt) + input.outcomeOffsetMinutes * 60_000,
      ).toISOString();
      // Historical-replay rows carry their proven applied-fact chronology.
      // This synthetic fixture records one applied signal fact per decision so
      // the database assigns its applied sequence and the outcome version
      // names that exact fact as its causal source; the full production replay
      // path is covered by funded-execution-replay-postgres.test.ts.
      const sourceFactId =
        input.sourceKind === "HISTORICAL_REPLAY"
          ? `funded-signal:${observationIdStored}`
          : null;
      if (sourceFactId)
        await pool.query(
          `INSERT INTO paper_funded_fact(
             run_id,fact_id,fact_at,priority,sort_key,fact,outcome,processed_at)
           VALUES($1,$2,$3,2,$4,'{}'::jsonb,'{"status":"APPLIED"}'::jsonb,now())`,
          [input.runId, sourceFactId, signalAt, observationIdStored],
        );
      if (input.fill === "NONE") return observationIdStored;
      if (input.fill === "FILLED") {
        await pool.query(
          `INSERT INTO funded_decision_outcome(
             run_id,observation_id,sequence,status,source_kind,source_id,source_digest,available_at,recorded_at,detail,source_fact_id)
           VALUES($1,$2,1,'FILLED',$3,$4,$5,$6,$6,$7::jsonb,$8)`,
          [
            input.runId,
            observationIdStored,
            input.sourceKind,
            `ledger:${observationIdStored}:fill`,
            digestOf(`${observationIdStored}:filled`),
            availableAt,
            JSON.stringify({
              filledFraction: 1,
              filledShares: 100,
              requestedShares: 100,
              averagePrice: 10.02,
              fees: 1,
              slippage: 0.02,
            }),
            sourceFactId,
          ],
        );
      } else {
        await pool.query(
          `INSERT INTO funded_decision_outcome(
             run_id,observation_id,sequence,status,source_kind,source_id,source_digest,available_at,recorded_at,reason,detail,source_fact_id)
           VALUES($1,$2,1,'NO_FILL',$3,$4,$5,$6,$6,'Order cancelled before fill: EXPIRED','{"noFillReason":"ORDER_CANCELLED_EXPIRED"}'::jsonb,$7)`,
          [
            input.runId,
            observationIdStored,
            input.sourceKind,
            `order:${observationIdStored}:cancelled`,
            digestOf(`${observationIdStored}:no-fill`),
            availableAt,
            sourceFactId,
          ],
        );
      }
      return observationIdStored;
    }

    async function accountIdFor(runId: string): Promise<string> {
      const result = await pool.query<{ account_id: string }>(
        "SELECT account_id FROM paper_funded_run WHERE run_id=$1",
        [runId],
      );
      const accountId = result.rows[0]?.account_id;
      if (!accountId) throw new Error("Funded run is missing an account");
      return accountId;
    }

    async function seedRun(input: {
      marketId: "CA_TSX" | "US_EQUITIES";
      currency: "CAD" | "USD";
      sessionDate: string;
      source: "LIVE" | "BACKTEST";
      sourceKind: "LIVE_PAPER" | "HISTORICAL_REPLAY";
      /** Set false to keep the run RUNNING for funded submission tests. */
      complete?: boolean;
    }) {
      const accountId = randomUUID();
      const startAt = `${input.sessionDate}T13:55:00.000Z`;
      const run = await botStore.startOrResumeLiveRun({
        source: input.source,
        marketId: input.marketId,
        sessionDate: input.sessionDate,
        sessionTimezone:
          input.marketId === "CA_TSX" ? "America/Toronto" : "America/New_York",
        scheduledCloseAt: `${input.sessionDate}T21:00:00.000Z`,
        executionModelVersion: "paper-execution-v3",
        assumptions,
      });
      await ledger.ensure(accountId, [
        input.currency,
        50_000,
        input.sessionDate,
        startAt,
        3_000,
      ]);
      await new FundedOrderService(
        pool,
        run.id,
        accountId,
        input.currency,
      ).bind(fundedPolicy(0.25, 0, {}), {
        session: input.sessionDate,
        at: startAt,
      });
      // Automatically trainable challengers require completed LIVE runs.
      if (input.complete !== false)
        await pool.query(
          "UPDATE paper_bot_run SET status='COMPLETED', completed_at=now() WHERE id=$1",
          [run.id],
        );
      return { runId: run.id, accountId };
    }

    function cohortFor(input: {
      marketId: "CA_TSX" | "US_EQUITIES";
      currency: "CAD" | "USD";
      sourceKind: "LIVE_PAPER" | "HISTORICAL_REPLAY";
      fundedPolicyVersion?: string;
    }): FundedCohortIdentity {
      const components = {
        marketId: input.marketId,
        currency: input.currency,
        evidenceSchemaVersion: 2 as const,
        fundedPolicyVersion: input.fundedPolicyVersion ?? "funded-policy-v1",
        portfolioPolicyVersion: "funded-portfolio-v2",
        executionModelVersion: "paper-execution-v3",
        costPolicyVersion: "paper-cost-policy-2026-09-04",
        participationVersion: "participation-v1",
        sourceKind: input.sourceKind,
        featureVersion: FUNDED_EXECUTION_FEATURE_VERSION,
        runtimeVersion: "runtime-fp02",
        accountAssumptionDigest: digestOf("account-assumptions"),
        signalModelId: null,
        signalModelVersion: null,
      };
      return {
        ...components,
        cohortDigest: fundedCohortDigest(components),
      };
    }

    async function seedQualifiedCohort(input: {
      marketId: "CA_TSX" | "US_EQUITIES";
      currency: "CAD" | "USD";
      source: "LIVE" | "BACKTEST";
      sourceKind: "LIVE_PAPER" | "HISTORICAL_REPLAY";
      sessions: string[];
      perSession: number;
      fundedPolicyVersion?: string;
    }): Promise<FundedCohortIdentity> {
      const cohort = cohortFor(input);
      let index = 0;
      for (const sessionDate of input.sessions) {
        const run = await seedRun({ ...input, sessionDate });
        for (let position = 0; position < input.perSession; position += 1) {
          const instrumentId = await insertInstrument(input.marketId);
          await seedDecision({
            runId: run.runId,
            sessionDate,
            index,
            instrumentId,
            marketId: input.marketId,
            currency: input.currency,
            sourceKind: input.sourceKind,
            cohort,
            fill: index % 2 === 0 ? "FILLED" : "NO_FILL",
            outcomeOffsetMinutes: index % 2 === 0 ? 5 : 25,
          });
          index += 1;
        }
      }
      return cohort;
    }

    const trainingSessions = [
      "2025-07-07",
      "2025-07-08",
      "2025-07-09",
      "2025-07-10",
    ];
    const validCutoff = new Date("2025-07-11T00:00:00.000Z");

    function trainingClient(
      mode: "COMPLETED" | "INSUFFICIENT_DATA",
    ): FundedExecutionTrainingClient {
      return {
        async trainFundedExecution(payload: unknown) {
          const request = payload as {
            datasetDigest: string;
            trainingPartitionDigest: string;
          };
          if (mode === "INSUFFICIENT_DATA")
            return {
              status: "INSUFFICIENT_DATA",
              artifact: null,
              artifactDigest: null,
              warnings: ["Masked labels were insufficient."],
            } satisfies FundedExecutionTrainingResult;
          const artifact = buildArtifact(
            request.datasetDigest,
            request.trainingPartitionDigest,
          );
          return {
            status: "COMPLETED",
            artifact,
            artifactDigest: fundedExecutionArtifactDigest(artifact),
            warnings: [],
          } satisfies FundedExecutionTrainingResult;
        },
      };
    }

    describe("dataset persistence", () => {
      it("freezes, reproduces and protects an immutable dataset", async () => {
        const cohort = await seedQualifiedCohort({
          marketId: "CA_TSX",
          currency: "CAD",
          source: "LIVE",
          sourceKind: "LIVE_PAPER",
          sessions: trainingSessions,
          perSession: 50,
        });
        const store = new PostgresFundedExecutionTrainingStore(pool);
        const service = new FundedExecutionTrainingService(
          store,
          trainingClient("COMPLETED"),
        );
        const first = await service.materialize(cohort, validCutoff);
        expect(first.dataset).not.toBeNull();
        const dataset = first.dataset!;
        expect(dataset.cohort.cohortDigest).toBe(cohort.cohortDigest);
        expect(dataset.qualificationReceipt.counts.includedRowCount).toBe(200);
        expect(dataset.activationEligible).toBe(true);
        const members = await store.listDatasetMembers(dataset.id);
        expect(members).toHaveLength(200);
        expect(members[0]!.ordinal).toBe(0);
        expect(members.at(-1)!.ordinal).toBe(199);

        // Exact retry reproduces the identical dataset and membership.
        const retry = await service.materialize(cohort, validCutoff);
        expect(retry.dataset!.id).toBe(dataset.id);
        expect(retry.dataset!.datasetDigest).toBe(dataset.datasetDigest);
        expect(retry.dataset!.membershipDigest).toBe(dataset.membershipDigest);

        // UPDATE and DELETE are rejected for datasets and members.
        await expect(
          pool.query(
            "UPDATE funded_execution_dataset SET row_count=0 WHERE id=$1",
            [dataset.id],
          ),
        ).rejects.toThrow(/immutable/i);
        await expect(
          pool.query(
            "DELETE FROM funded_execution_dataset_member WHERE dataset_id=$1",
            [dataset.id],
          ),
        ).rejects.toThrow(/immutable/i);
        await expect(
          pool.query("DELETE FROM funded_execution_dataset WHERE id=$1", [
            dataset.id,
          ]),
        ).rejects.toThrow(/immutable/i);

        // A conflicting reuse of market/cohort/cutoff fails visibly.
        await expect(
          store.createDataset({
            requestedCutoff: validCutoff,
            effectiveCutoff: new Date(dataset.effectiveCutoff),
            cohort,
            sourceKind: "LIVE_PAPER",
            datasetDigest: digestOf("conflicting-dataset"),
            membershipDigest: digestOf("conflicting-membership"),
            datasetPolicyVersion: "funded-execution-dataset-v1",
            labelMappingVersion: FUNDED_EXECUTION_LABEL_MAPPING_VERSION,
            featureVersion: FUNDED_EXECUTION_FEATURE_VERSION,
            qualificationPolicyVersion: "funded-execution-qualification-v1",
            counts: dataset.qualificationReceipt.counts,
            receipt: dataset.qualificationReceipt,
            sourceWatermark: dataset.sourceWatermark,
            activationEligible: true,
            members: [],
          }),
        ).rejects.toThrow("CONFLICTING_FUNDED_EXECUTION_DATASET");
      }, 180_000);

      it("keeps signal-quality and funded-execution datasets separate", async () => {
        const store = new PostgresFundedExecutionTrainingStore(pool);
        const fundedDatasets = await store.countDatasets();
        const signalQuality = await pool.query<{ count: string }>(
          "SELECT count(*) AS count FROM statistical_training_dataset",
        );
        expect(Number(signalQuality.rows[0]!.count)).toBe(0);
        expect(fundedDatasets).toBeGreaterThan(0);
      });
    });

    describe("correction availability cutoff", () => {
      it("does not select a correction recorded after the cutoff", async () => {
        const cohort = cohortFor({
          marketId: "CA_TSX",
          currency: "CAD",
          sourceKind: "LIVE_PAPER",
          fundedPolicyVersion: "funded-policy-corrections",
        });
        const run = await seedRun({
          marketId: "CA_TSX",
          currency: "CAD",
          sessionDate: "2025-08-04",
          source: "LIVE",
          sourceKind: "LIVE_PAPER",
        });
        const instrumentId = await insertInstrument("CA_TSX");
        const requestedCutoff = new Date(Date.now() + 60_000);
        const correctionRecordedAt = new Date(
          requestedCutoff.getTime() + 3_600_000,
        ).toISOString();
        const observationId = await seedPartialThenCorrection({
          runId: run.runId,
          sessionDate: "2025-08-04",
          instrumentId,
          cohort,
          correctionRecordedAt,
        });
        const store = new PostgresFundedExecutionTrainingStore(pool);
        const rows = await store.assembledRowsFor(
          cohort.cohortDigest,
          requestedCutoff,
        );
        const row = rows.find((entry) => entry.observationId === observationId);
        expect(row).toBeDefined();
        // The late-recorded correction cannot leak backward: only the partial
        // fill available and recorded at the cutoff is selected.
        expect(row!.labels?.fillFraction).toBe(0.5);
      }, 120_000);

      it("selects the correction only after it is recorded", async () => {
        const cohort = cohortFor({
          marketId: "CA_TSX",
          currency: "CAD",
          sourceKind: "LIVE_PAPER",
          fundedPolicyVersion: "funded-policy-corrections-2",
        });
        const run = await seedRun({
          marketId: "CA_TSX",
          currency: "CAD",
          sessionDate: "2025-08-05",
          source: "LIVE",
          sourceKind: "LIVE_PAPER",
        });
        const instrumentId = await insertInstrument("CA_TSX");
        const correctionRecordedAt = new Date(
          Date.now() + 3_600_000,
        ).toISOString();
        const observationId = await seedPartialThenCorrection({
          runId: run.runId,
          sessionDate: "2025-08-05",
          instrumentId,
          cohort,
          correctionRecordedAt,
        });
        const store = new PostgresFundedExecutionTrainingStore(pool);
        const rows = await store.assembledRowsFor(
          cohort.cohortDigest,
          new Date(Date.parse(correctionRecordedAt) + 60_000),
        );
        const row = rows.find((entry) => entry.observationId === observationId);
        expect(row!.labels?.fillFraction).toBe(1);
      }, 120_000);

      it("reproduces a non-conflicting dataset identity when a correction arrives late", async () => {
        const cohort = await seedQualifiedCohort({
          marketId: "CA_TSX",
          currency: "CAD",
          source: "LIVE",
          sourceKind: "LIVE_PAPER",
          sessions: ["2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11"],
          perSession: 50,
          fundedPolicyVersion: "funded-policy-late-correction",
        });
        const run = await pool.query<{ id: string }>(
          `SELECT id FROM paper_bot_run
            WHERE market_id='CA_TSX' AND source='LIVE' AND session_date='2026-09-11'`,
        );
        const runId = run.rows[0]!.id;
        const instrumentId = await insertInstrument("CA_TSX");
        const sessionDate = "2026-09-11";
        // The partial fill is final and known at the requested cutoff: the
        // terminal revision is captured now and the cutoff follows it, while
        // the correction is recorded an hour after the cutoff.
        const partialAt = `${sessionDate}T14:40:00.000Z`;
        const correctionAt = `${sessionDate}T14:50:00.000Z`;
        const requestedCutoff = new Date(Date.now() + 60_000);
        const correctionRecordedAt = new Date(
          requestedCutoff.getTime() + 3_600_000,
        );
        const extraObservationId = await seedDecision({
          runId,
          sessionDate,
          index: 0,
          instrumentId,
          marketId: "CA_TSX",
          currency: "CAD",
          sourceKind: "LIVE_PAPER",
          cohort,
          fill: "NONE",
          outcomeOffsetMinutes: 0,
        });
        // The terminal revision is written through the production order path;
        // the database captures it with the real recording clock.
        await pool.query(
          `INSERT INTO paper_entry_order(order_id,run_id,instrument_id,submission,state,revision,last_fact_at,updated_at)
         VALUES($1,$2,$3,'{}'::jsonb,$4::jsonb,0,$5,$5)`,
          [
            extraObservationId,
            runId,
            instrumentId,
            JSON.stringify({
              orderId: extraObservationId,
              version: "pending-entry-v1",
              status: "CANCELLED",
              execution: null,
            }),
            partialAt,
          ],
        );
        await pool.query(
          `INSERT INTO funded_decision_outcome(
             run_id,observation_id,sequence,status,source_kind,source_id,source_digest,available_at,recorded_at,detail)
           VALUES($1,$2,1,'PARTIAL_FILL','LIVE_PAPER',$3,$4,$5,$5,$6::jsonb)`,
          [
            runId,
            extraObservationId,
            `ledger:${extraObservationId}:partial`,
            digestOf(`${extraObservationId}:partial`),
            partialAt,
            JSON.stringify({
              filledFraction: 0.5,
              filledShares: 50,
              requestedShares: 100,
              averagePrice: 10.02,
              fees: 0.5,
              slippage: 0.01,
            }),
          ],
        );
        const store = new PostgresFundedExecutionTrainingStore(pool);
        const service = new FundedExecutionTrainingService(
          store,
          trainingClient("COMPLETED"),
        );
        const first = await service.materialize(cohort, requestedCutoff);
        expect(first.dataset).not.toBeNull();
        const dataset = first.dataset!;
        const partialMember = (await store.listDatasetMembers(dataset.id)).find(
          (member) => member.identity.observationId === extraObservationId,
        );
        expect(partialMember?.labels.fillFraction).toBe(0.5);
        // The audit knowledge time is the real database capture time of the
        // immutable order revision, while the economic time is preserved.
        expect(partialMember?.labels.economicOutcomeAt).toBe(partialAt);
        expect(partialMember?.labels.terminalityProof?.recordedAt).toBe(
          partialMember?.labels.labelAvailableAt,
        );

        // A correction recorded after the cutoff arrives. It must not change
        // the earlier dataset: the same cutoff reproduces the same identity
        // without a conflict.
        await pool.query(
          `INSERT INTO funded_decision_outcome(
             run_id,observation_id,sequence,status,source_kind,source_id,source_digest,available_at,recorded_at,supersedes_sequence,detail)
           VALUES($1,$2,2,'FILLED','LIVE_PAPER',$3,$4,$5,$6,1,$7::jsonb)`,
          [
            runId,
            extraObservationId,
            `ledger:${extraObservationId}:fill`,
            digestOf(`${extraObservationId}:filled`),
            correctionAt,
            correctionRecordedAt.toISOString(),
            JSON.stringify({
              filledFraction: 1,
              filledShares: 100,
              requestedShares: 100,
              averagePrice: 10.02,
              fees: 1,
              slippage: 0.01,
            }),
          ],
        );
        const retry = await service.materialize(cohort, requestedCutoff);
        expect(retry.dataset!.id).toBe(dataset.id);
        expect(retry.dataset!.datasetDigest).toBe(dataset.datasetDigest);
        expect(retry.dataset!.membershipDigest).toBe(dataset.membershipDigest);

        // After the correction is recorded, materializing at a later cutoff
        // still does not treat a corrected existing decision as a new outcome.
        const later = await service.materialize(
          cohort,
          new Date(correctionRecordedAt.getTime() + 1_800_000),
        );
        expect(later.dataset).toBeNull();
        expect(
          later.receipt.reasons.some((reason) =>
            reason.startsWith("INSUFFICIENT_NEW_OUTCOMES"),
          ),
        ).toBe(true);
      }, 240_000);
    });

    describe("immutable point-in-time entry terminality", () => {
      it("keeps a partial-fill cutoff identical after a later order close", async () => {
        const cohort = await seedQualifiedCohort({
          marketId: "CA_TSX",
          currency: "CAD",
          source: "LIVE",
          sourceKind: "LIVE_PAPER",
          sessions: ["2025-10-06", "2025-10-07", "2025-10-08", "2025-10-09"],
          perSession: 50,
          fundedPolicyVersion: "funded-policy-terminality",
        });
        const run = await pool.query<{ id: string }>(
          `SELECT id FROM paper_bot_run
            WHERE market_id='CA_TSX' AND source='LIVE' AND session_date='2025-10-09'`,
        );
        const runId = run.rows[0]!.id;
        const instrumentId = await insertInstrument("CA_TSX");
        const sessionDate = "2025-10-09";
        const decisionAt = `${sessionDate}T14:30:00.000Z`;
        const partialAt = `${sessionDate}T14:40:00.000Z`;
        const lateCloseAt = `${sessionDate}T15:30:00.000Z`;
        const observationId = await seedDecision({
          runId,
          sessionDate,
          index: 0,
          instrumentId,
          marketId: "CA_TSX",
          currency: "CAD",
          sourceKind: "LIVE_PAPER",
          cohort,
          fill: "NONE",
          outcomeOffsetMinutes: 0,
        });
        const terminalState = {
          orderId: observationId,
          version: "pending-entry-v1",
          status: "CANCELLED",
          reason: "EXPIRED",
          submittedAt: decisionAt,
          lastQuoteAt: partialAt,
          execution: null,
        };
        // The order is written through the production path; the database
        // trigger captures the terminal revision with its own recording clock,
        // which the requested cutoff follows.
        await pool.query(
          `INSERT INTO paper_entry_order(order_id,run_id,instrument_id,submission,state,revision,last_fact_at,updated_at)
           VALUES($1,$2,$3,'{}'::jsonb,$4::jsonb,0,$5,$5)`,
          [
            observationId,
            runId,
            instrumentId,
            JSON.stringify(terminalState),
            partialAt,
          ],
        );
        // The cutoff is one millisecond after the real database capture of the
        // terminal revision, so it is provable at the cutoff while the later
        // order close recorded after it is not.
        const capturedRecordedAt = (
          await pool.query<{ recorded_at: Date }>(
            `SELECT recorded_at FROM paper_entry_order_history
              WHERE order_id=$1 AND revision=0`,
            [observationId],
          )
        ).rows[0]!.recorded_at;
        const requestedCutoff = new Date(capturedRecordedAt.getTime() + 1);
        await pool.query(
          `INSERT INTO funded_decision_outcome(
             run_id,observation_id,sequence,status,source_kind,source_id,source_digest,available_at,recorded_at,detail)
           VALUES($1,$2,1,'PARTIAL_FILL','LIVE_PAPER',$3,$4,$5,$5,$6::jsonb)`,
          [
            runId,
            observationId,
            `ledger:${observationId}:partial`,
            digestOf(`${observationId}:partial`),
            partialAt,
            JSON.stringify({
              filledFraction: 0.5,
              filledShares: 50,
              requestedShares: 100,
              averagePrice: 10.02,
              fees: 0.5,
              slippage: 0.01,
            }),
          ],
        );

        const store = new PostgresFundedExecutionTrainingStore(pool);
        const service = new FundedExecutionTrainingService(
          store,
          trainingClient("COMPLETED"),
        );
        const first = await service.materialize(cohort, requestedCutoff);
        expect(first.dataset).not.toBeNull();
        const dataset = first.dataset!;
        const members = await store.listDatasetMembers(dataset.id);
        const partialMember = members.find(
          (member) => member.identity.observationId === observationId,
        );
        expect(partialMember?.labels.fillFraction).toBe(0.5);
        const capturedProof = (
          await pool.query<{ recorded_at: Date }>(
            `SELECT recorded_at FROM paper_entry_order_history
              WHERE order_id=$1 AND revision=0`,
            [observationId],
          )
        ).rows[0]!.recorded_at.toISOString();
        expect(partialMember?.labels.terminalityProof).toEqual({
          orderId: observationId,
          revision: 0,
          stateDigest: contentHash(terminalState),
          factAt: partialAt,
          recordedAt: capturedProof,
        });
        expect(partialMember?.labels.labelAvailableAt).toBe(capturedProof);
        const labelsBefore = partialMember!.labels;
        const membershipBefore = members.map((member) => member.rowDigest);

        // A later close/recovery/reconciliation updates only the current row.
        const laterState = {
          ...terminalState,
          status: "FILLED",
          reason: null,
          lastQuoteAt: lateCloseAt,
          execution: { status: "CLOSED", position: { shares: 50 } },
        };
        await pool.query(
          `UPDATE paper_entry_order
              SET state=$2::jsonb,last_fact_at=$3::timestamptz,
                  revision=revision+1,updated_at=now()
            WHERE order_id=$1`,
          [observationId, JSON.stringify(laterState), lateCloseAt],
        );

        // The original cutoff must assemble the identical row: the later
        // revision is not provable at that cutoff.
        const rows = await store.assembledRowsFor(
          cohort.cohortDigest,
          requestedCutoff,
        );
        const reassembled = rows.find(
          (row) => row.observationId === observationId,
        );
        expect(reassembled?.labels).toEqual(labelsBefore);
        const membersAfter = await store.listDatasetMembers(dataset.id);
        expect(membersAfter.map((member) => member.rowDigest)).toEqual(
          membershipBefore,
        );

        // Rematerializing the original cutoff reproduces the same dataset
        // identity without a conflict, even after rejected history mutations.
        await expect(
          pool.query(
            "UPDATE paper_entry_order_history SET recorded_at=now() WHERE order_id=$1",
            [observationId],
          ),
        ).rejects.toThrow(/immutable/i);
        await expect(
          pool.query(
            "DELETE FROM paper_entry_order_history WHERE order_id=$1",
            [observationId],
          ),
        ).rejects.toThrow(/immutable/i);
        const retry = await service.materialize(cohort, requestedCutoff);
        expect(retry.dataset!.id).toBe(dataset.id);
        expect(retry.dataset!.datasetDigest).toBe(dataset.datasetDigest);
        expect(retry.dataset!.membershipDigest).toBe(dataset.membershipDigest);
        expect(retry.dataset!.effectiveCutoff).toBe(dataset.effectiveCutoff);
        const rowCount = await pool.query<{ count: string }>(
          `SELECT count(*) AS count FROM funded_execution_dataset
            WHERE market_id='CA_TSX' AND cohort_digest=$1 AND effective_cutoff=$2`,
          [cohort.cohortDigest, dataset.effectiveCutoff],
        );
        expect(Number(rowCount.rows[0]!.count)).toBe(1);
      }, 240_000);

      it("keeps an order revision immutable under replay and direct mutation", async () => {
        const run = await seedRun({
          marketId: "CA_TSX",
          currency: "CAD",
          sessionDate: "2025-10-15",
          source: "LIVE",
          sourceKind: "LIVE_PAPER",
        });
        const instrumentId = await insertInstrument("CA_TSX");
        const observationId = await seedDecision({
          runId: run.runId,
          sessionDate: "2025-10-15",
          index: 0,
          instrumentId,
          marketId: "CA_TSX",
          currency: "CAD",
          sourceKind: "LIVE_PAPER",
          cohort: cohortFor({
            marketId: "CA_TSX",
            currency: "CAD",
            sourceKind: "LIVE_PAPER",
            fundedPolicyVersion: "funded-policy-history-immutable",
          }),
          fill: "NONE",
          outcomeOffsetMinutes: 0,
        });
        const factAt = "2025-10-15T14:40:00.000Z";
        const state = {
          orderId: observationId,
          version: "pending-entry-v1",
          status: "CANCELLED",
          reason: "EXPIRED",
          lastQuoteAt: factAt,
          execution: null,
        };
        await pool.query(
          `INSERT INTO paper_entry_order(order_id,run_id,instrument_id,submission,state,revision,last_fact_at,updated_at)
           VALUES($1,$2,$3,'{}'::jsonb,$4::jsonb,1,$5,$5)`,
          [
            observationId,
            run.runId,
            instrumentId,
            JSON.stringify(state),
            factAt,
          ],
        );
        const before = await pool.query<{
          revision: string;
          fact_at: Date;
          state: unknown;
          recorded_at: Date;
        }>(
          `SELECT revision,fact_at,state,recorded_at
             FROM paper_entry_order_history WHERE order_id=$1 ORDER BY revision`,
          [observationId],
        );
        expect(before.rows).toHaveLength(1);
        const recordedAt = before.rows[0]!.recorded_at;

        // Re-observing the exact same revision is an idempotent no-op that
        // preserves the original recording time.
        await pool.query(
          `UPDATE paper_entry_order
              SET state=$2::jsonb,last_fact_at=$3::timestamptz,revision=revision
            WHERE order_id=$1`,
          [observationId, JSON.stringify(state), factAt],
        );
        const afterReplay = await pool.query<{
          revision: string;
          fact_at: Date;
          state: unknown;
          recorded_at: Date;
        }>(
          `SELECT revision,fact_at,state,recorded_at
             FROM paper_entry_order_history WHERE order_id=$1 ORDER BY revision`,
          [observationId],
        );
        expect(afterReplay.rows).toHaveLength(1);
        expect(afterReplay.rows[0]!.revision).toBe(before.rows[0]!.revision);
        expect(afterReplay.rows[0]!.fact_at).toEqual(before.rows[0]!.fact_at);
        expect(afterReplay.rows[0]!.state).toEqual(before.rows[0]!.state);
        expect(afterReplay.rows[0]!.recorded_at).toEqual(recordedAt);

        // Reusing the same revision with different content fails visibly.
        await expect(
          pool.query(
            `UPDATE paper_entry_order
                SET state=$2::jsonb,revision=revision
              WHERE order_id=$1`,
            [
              observationId,
              JSON.stringify({ ...state, status: "FILLED", reason: null }),
            ],
          ),
        ).rejects.toThrow(/different content/i);
        await expect(
          pool.query(
            `UPDATE paper_entry_order
                SET state=$2::jsonb,last_fact_at=$3::timestamptz,revision=revision
              WHERE order_id=$1`,
            [observationId, JSON.stringify(state), "2025-10-15T15:00:00.000Z"],
          ),
        ).rejects.toThrow(/different content/i);

        // Direct UPDATE and DELETE of stored history are rejected.
        await expect(
          pool.query(
            "UPDATE paper_entry_order_history SET state='{}'::jsonb WHERE order_id=$1",
            [observationId],
          ),
        ).rejects.toThrow(/immutable/i);
        await expect(
          pool.query(
            "DELETE FROM paper_entry_order_history WHERE order_id=$1",
            [observationId],
          ),
        ).rejects.toThrow(/immutable/i);

        // A new higher revision still works through the normal order path and
        // leaves every earlier revision untouched.
        await pool.query(
          `UPDATE paper_entry_order
              SET state=$2::jsonb,last_fact_at=$3::timestamptz,
                  revision=revision+1,updated_at=now()
            WHERE order_id=$1`,
          [
            observationId,
            JSON.stringify({ ...state, status: "PENDING", reason: null }),
            "2025-10-15T15:00:00.000Z",
          ],
        );
        const finalRows = await pool.query<{
          revision: string;
          recorded_at: Date;
        }>(
          `SELECT revision,recorded_at
             FROM paper_entry_order_history WHERE order_id=$1 ORDER BY revision`,
          [observationId],
        );
        expect(finalRows.rows.map((row) => Number(row.revision))).toEqual([
          1, 2,
        ]);
        expect(finalRows.rows[0]!.recorded_at).toEqual(recordedAt);
      }, 120_000);

      it("leaves terminality unprovable for a revision recorded after the cutoff", async () => {
        const cohort = cohortFor({
          marketId: "CA_TSX",
          currency: "CAD",
          sourceKind: "LIVE_PAPER",
          fundedPolicyVersion: "funded-policy-unprovable-terminality",
        });
        const run = await seedRun({
          marketId: "CA_TSX",
          currency: "CAD",
          sessionDate: "2025-10-14",
          source: "LIVE",
          sourceKind: "LIVE_PAPER",
        });
        const instrumentId = await insertInstrument("CA_TSX");
        const observationId = await seedDecision({
          runId: run.runId,
          sessionDate: "2025-10-14",
          index: 0,
          instrumentId,
          marketId: "CA_TSX",
          currency: "CAD",
          sourceKind: "LIVE_PAPER",
          cohort,
          fill: "NONE",
          outcomeOffsetMinutes: 0,
        });
        const partialAt = "2025-10-14T14:40:00.000Z";
        // The cutoff is taken before the order is captured, so the revision
        // fact time is before it but its real recording time is not: the
        // proof is unprovable at the cutoff and the partial fill must remain
        // INTERMEDIATE_PARTIAL_FILL.
        const requestedCutoff = new Date();
        await pool.query(
          `INSERT INTO paper_entry_order(order_id,run_id,instrument_id,submission,state,revision,last_fact_at,updated_at)
           VALUES($1,$2,$3,'{}'::jsonb,$4::jsonb,0,$5,$5)`,
          [
            observationId,
            run.runId,
            instrumentId,
            JSON.stringify({
              orderId: observationId,
              version: "pending-entry-v1",
              status: "CANCELLED",
              execution: null,
            }),
            partialAt,
          ],
        );
        await pool.query(
          `INSERT INTO funded_decision_outcome(
             run_id,observation_id,sequence,status,source_kind,source_id,source_digest,available_at,recorded_at,detail)
           VALUES($1,$2,1,'PARTIAL_FILL','LIVE_PAPER',$3,$4,$5,$5,$6::jsonb)`,
          [
            run.runId,
            observationId,
            `ledger:${observationId}:partial`,
            digestOf(`${observationId}:partial`),
            partialAt,
            JSON.stringify({
              filledFraction: 0.5,
              filledShares: 50,
              requestedShares: 100,
              averagePrice: 10.02,
              fees: 0.5,
              slippage: 0.01,
            }),
          ],
        );
        const store = new PostgresFundedExecutionTrainingStore(pool);
        const rows = await store.assembledRowsFor(
          cohort.cohortDigest,
          requestedCutoff,
        );
        const row = rows.find((entry) => entry.observationId === observationId);
        expect(row?.verdict).toBe("EXCLUDED");
        expect(row?.exclusionReason).toBe("INTERMEDIATE_PARTIAL_FILL");
      }, 120_000);
    });

    describe("inactive challenger persistence", () => {
      it("persists and deduplicates an inactive challenger across restarts", async () => {
        const cohort = await seedQualifiedCohort({
          marketId: "CA_TSX",
          currency: "CAD",
          source: "LIVE",
          sourceKind: "LIVE_PAPER",
          sessions: ["2025-07-14", "2025-07-15", "2025-07-16", "2025-07-17"],
          perSession: 50,
          fundedPolicyVersion: "funded-policy-challenger",
        });
        const cutoff = new Date("2025-07-18T00:00:00.000Z");
        const firstStore = new PostgresFundedExecutionTrainingStore(pool);
        const firstService = new FundedExecutionTrainingService(
          firstStore,
          trainingClient("COMPLETED"),
        );
        const dataset = (await firstService.materialize(cohort, cutoff))
          .dataset!;
        const challenger = await firstService.train(dataset.id);
        expect(challenger.status).toBe("INACTIVE");
        expect(challenger.eligibleForActivation).toBe(false);
        expect(challenger.active).toBe(false);
        expect(challenger.artifactDigest).toBe(
          fundedExecutionArtifactDigest(challenger.artifact!),
        );

        // A new process instance (restart) repairs nothing and reuses the row.
        const restarted = new FundedExecutionTrainingService(
          new PostgresFundedExecutionTrainingStore(pool),
          trainingClient("COMPLETED"),
        );
        const retry = await restarted.train(dataset.id);
        expect(retry.id).toBe(challenger.id);
        const count = await pool.query<{ count: string }>(
          "SELECT count(*) AS count FROM funded_execution_challenger WHERE dataset_digest=$1",
          [dataset.datasetDigest],
        );
        expect(Number(count.rows[0]!.count)).toBe(1);

        await expect(
          pool.query(
            "UPDATE funded_execution_challenger SET eligible_for_activation=true WHERE id=$1",
            [challenger.id],
          ),
        ).rejects.toThrow(/immutable/i);

        // A failed attempt is retained with its receipt.
        const failedDataset = await seedQualifiedCohort({
          marketId: "CA_TSX",
          currency: "CAD",
          source: "LIVE",
          sourceKind: "LIVE_PAPER",
          sessions: ["2025-07-21", "2025-07-22", "2025-07-23", "2025-07-24"],
          perSession: 50,
          fundedPolicyVersion: "funded-policy-failed",
        });
        const failedService = new FundedExecutionTrainingService(
          new PostgresFundedExecutionTrainingStore(pool),
          trainingClient("INSUFFICIENT_DATA"),
        );
        const failed = (
          await failedService.materialize(
            failedDataset,
            new Date("2025-07-25T00:00:00.000Z"),
          )
        ).dataset!;
        const failedChallenger = await failedService.train(failed.id);
        expect(failedChallenger.status).toBe("FAILED");
        expect(failedChallenger.failureReceipt).toBeTruthy();
        expect(failedChallenger.eligibleForActivation).toBe(false);
      }, 240_000);
    });

    describe("market and source isolation", () => {
      it("does not pool CA and US evidence", async () => {
        const caCohort = await seedQualifiedCohort({
          marketId: "CA_TSX",
          currency: "CAD",
          source: "LIVE",
          sourceKind: "LIVE_PAPER",
          sessions: ["2025-07-28", "2025-07-29", "2025-07-30", "2025-07-31"],
          perSession: 50,
          fundedPolicyVersion: "funded-policy-ca-isolation",
        });
        const usCohort = await seedQualifiedCohort({
          marketId: "US_EQUITIES",
          currency: "USD",
          source: "LIVE",
          sourceKind: "LIVE_PAPER",
          sessions: ["2025-08-01", "2025-08-04", "2025-08-05", "2025-08-06"],
          perSession: 50,
          fundedPolicyVersion: "funded-policy-us-isolation",
        });
        const store = new PostgresFundedExecutionTrainingStore(pool);
        const cutoff = new Date("2025-08-07T00:00:00.000Z");
        const caRowsResult = await store.assembledRowsFor(
          caCohort.cohortDigest,
          cutoff,
        );
        const usRowsResult = await store.assembledRowsFor(
          usCohort.cohortDigest,
          cutoff,
        );
        expect(caRowsResult).toHaveLength(200);
        expect(usRowsResult).toHaveLength(200);
        expect(
          caRowsResult.every(
            (row) => row.marketId === "CA_TSX" && row.currency === "CAD",
          ),
        ).toBe(true);
        expect(
          usRowsResult.every(
            (row) => row.marketId === "US_EQUITIES" && row.currency === "USD",
          ),
        ).toBe(true);
        const service = new FundedExecutionTrainingService(
          store,
          trainingClient("COMPLETED"),
        );
        const usService = new FundedExecutionTrainingService(
          store,
          trainingClient("COMPLETED"),
        );
        const caDataset = (await service.materialize(caCohort, cutoff))
          .dataset!;
        const usDataset = (await usService.materialize(usCohort, cutoff))
          .dataset!;
        expect(caDataset.marketId).toBe("CA_TSX");
        expect(usDataset.marketId).toBe("US_EQUITIES");
        expect(caDataset.datasetDigest).not.toBe(usDataset.datasetDigest);
        // Ownership is proven at the schema: a member from the other market
        // cannot be attached to this dataset.
        await expect(
          pool.query(
            `INSERT INTO funded_execution_dataset_member(
               dataset_id,ordinal,market_id,currency,run_id,observation_id,account_id,decision_sequence,
               decision_content_digest,cohort_digest,evidence_schema_version,decision_at,session_date,
               partition,label_available_at,source_kind,label_mapping_version,feature_version,
               features,labels,outcome_sequences,outcome_source_digests,row_digest)
             VALUES($1,999,'US_EQUITIES','USD',gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),1,$2,$3,2,now(),now(),'TRAIN',now(),'LIVE_PAPER',
                    'funded-execution-labels-v1','funded-execution-features-v1','{}'::jsonb,'{}'::jsonb,'{}','{}',$2)`,
            [caDataset.id, digestOf("row"), digestOf("cohort")],
          ),
        ).rejects.toThrow();
      }, 240_000);

      it("retains replay datasets as non-activation-eligible artifacts", async () => {
        const cohort = await seedQualifiedCohort({
          marketId: "CA_TSX",
          currency: "CAD",
          source: "BACKTEST",
          sourceKind: "HISTORICAL_REPLAY",
          sessions: ["2025-08-08", "2025-08-11", "2025-08-12", "2025-08-13"],
          perSession: 50,
          fundedPolicyVersion: "funded-policy-replay-isolation",
        });
        const store = new PostgresFundedExecutionTrainingStore(pool);
        const service = new FundedExecutionTrainingService(
          store,
          trainingClient("COMPLETED"),
        );
        const dataset = (
          await service.materialize(
            cohort,
            new Date("2025-08-14T00:00:00.000Z"),
          )
        ).dataset!;
        expect(dataset.activationEligible).toBe(false);
        expect(dataset.qualificationReceipt.liveRunRequired).toBe(false);
      }, 240_000);
    });

    describe("forward prediction persistence", () => {
      async function decisionEvidence(runId: string, observationId: string) {
        const result = await pool.query<{
          sequence: number;
          content_digest: string;
          decision_at: Date | string;
        }>(
          "SELECT sequence,content_digest,decision_at FROM funded_decision_evidence WHERE run_id=$1 AND observation_id=$2",
          [runId, observationId],
        );
        const row = result.rows[0];
        if (!row) throw new Error("Seeded decision evidence is missing");
        return {
          sequence: Number(row.sequence),
          contentDigest: row.content_digest,
          decisionAt:
            row.decision_at instanceof Date
              ? row.decision_at.toISOString()
              : new Date(row.decision_at).toISOString(),
        };
      }

      async function predictionContext(suffix: string) {
        const sessionDate = `2025-08-${suffix}`;
        const cohort = cohortFor({
          marketId: "CA_TSX",
          currency: "CAD",
          sourceKind: "LIVE_PAPER",
          fundedPolicyVersion: `funded-policy-prediction-${suffix}`,
        });
        const run = await seedRun({
          marketId: "CA_TSX",
          currency: "CAD",
          sessionDate,
          source: "LIVE",
          sourceKind: "LIVE_PAPER",
        });
        const instrumentId = await insertInstrument("CA_TSX");
        const observationId = await seedDecision({
          runId: run.runId,
          sessionDate,
          index: 0,
          instrumentId,
          marketId: "CA_TSX",
          currency: "CAD",
          sourceKind: "LIVE_PAPER",
          cohort,
          fill: "FILLED",
          outcomeOffsetMinutes: 5,
        });
        const evidence = await decisionEvidence(run.runId, observationId);
        const challenger = await seedChallenger(
          cohort,
          `${sessionDate}T00:00:00.000Z`,
        );
        return { cohort, run, observationId, evidence, challenger };
      }

      function predictionInput(
        context: Awaited<ReturnType<typeof predictionContext>>,
        overrides: Record<string, unknown> = {},
      ) {
        return {
          challengerId: context.challenger.id,
          marketId: "CA_TSX" as const,
          currency: "CAD" as const,
          sourceKind: "LIVE_PAPER" as const,
          runId: context.run.runId,
          observationId: context.observationId,
          expectedDecisionSequence: context.evidence.sequence,
          expectedDecisionInputDigest: context.evidence.contentDigest,
          deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
          output: predictionOutput(),
          warnings: [],
          ...overrides,
        } as const;
      }

      it("records a database-timed prediction, stays idempotent and touches no funded state", async () => {
        const context = await predictionContext("15");
        const fundedBefore = await fundedMutationCounters();
        const store = new PostgresFundedExecutionPredictionStore(pool);
        const service = new FundedExecutionPredictionService(store);
        const request = predictionInput(context);
        const record = await service.record(request);
        expect(record.digest).toMatch(/^[a-f0-9]{64}$/);
        expect(
          fundedExecutionPredictionRecordSchema.safeParse(record).success,
        ).toBe(true);
        // The prediction time is database-owned and inside the decision
        // deadline window, not a caller-supplied value.
        expect(Date.parse(record.predictionAt)).toBeGreaterThanOrEqual(
          Date.parse(context.evidence.decisionAt),
        );
        expect(Date.parse(record.predictionAt)).toBeLessThanOrEqual(
          Date.parse(request.deadlineAt),
        );
        const duplicate = await service.record(request);
        expect(duplicate.digest).toBe(record.digest);
        expect(duplicate.predictionAt).toBe(record.predictionAt);
        await expect(
          service.record({
            ...request,
            output: {
              ...predictionOutput(),
              fillProbability: {
                value: 0.2,
                unit: "PROBABILITY",
                lowerBound: 0,
                upperBound: 1,
              },
            },
          }),
        ).rejects.toThrow("CONFLICTING_FUNDED_EXECUTION_PREDICTION");
        const count = await pool.query<{ count: string }>(
          "SELECT count(*) AS count FROM funded_execution_prediction WHERE run_id=$1 AND observation_id=$2",
          [context.run.runId, context.observationId],
        );
        expect(Number(count.rows[0]!.count)).toBe(1);
        await expect(
          pool.query("UPDATE funded_execution_prediction SET digest=$1", [
            digestOf("mutated"),
          ]),
        ).rejects.toThrow(/immutable/i);
        expect(await fundedMutationCounters()).toEqual(fundedBefore);
      }, 120_000);

      it("rejects a wrong decision digest or sequence", async () => {
        const context = await predictionContext("16");
        const service = new FundedExecutionPredictionService(
          new PostgresFundedExecutionPredictionStore(pool),
        );
        await expect(
          service.record(
            predictionInput(context, {
              expectedDecisionInputDigest: digestOf("wrong-digest"),
            }),
          ),
        ).rejects.toThrow("FUNDED_EXECUTION_PREDICTION_INPUT_DIGEST_MISMATCH");
        await expect(
          service.record(
            predictionInput(context, {
              expectedDecisionSequence: context.evidence.sequence + 1,
            }),
          ),
        ).rejects.toThrow("FUNDED_EXECUTION_PREDICTION_SEQUENCE_MISMATCH");
      }, 120_000);

      it("rejects a nonexistent challenger and cross-market ownership", async () => {
        const context = await predictionContext("17");
        const service = new FundedExecutionPredictionService(
          new PostgresFundedExecutionPredictionStore(pool),
        );
        await expect(
          service.record(
            predictionInput(context, { challengerId: randomUUID() }),
          ),
        ).rejects.toThrow("FUNDED_EXECUTION_PREDICTION_CHALLENGER_NOT_FOUND");
        await expect(
          service.record(
            predictionInput(context, {
              marketId: "US_EQUITIES",
              currency: "USD",
            }),
          ),
        ).rejects.toThrow("FUNDED_EXECUTION_PREDICTION_MARKET_MISMATCH");
      }, 120_000);

      it("rejects a challenger frozen after the decision", async () => {
        const context = await predictionContext("19");
        const lateChallenger = await seedChallenger(
          context.cohort,
          "2025-08-20T00:00:00.000Z",
        );
        const service = new FundedExecutionPredictionService(
          new PostgresFundedExecutionPredictionStore(pool),
        );
        await expect(
          service.record(
            predictionInput(context, { challengerId: lateChallenger.id }),
          ),
        ).rejects.toThrow("FUNDED_EXECUTION_PREDICTION_PRECEDES_MODEL");
        // The database trigger enforces the same rule for a direct insert.
        await expect(
          pool.query(
            `INSERT INTO funded_execution_prediction(
               market_id,currency,model_id,model_version,model_type,artifact_digest,
               cohort_digest,feature_version,source_kind,run_id,observation_id,
               decision_sequence,decision_input_digest,decision_at,prediction_at,
               deadline_at,output,warnings,digest)
             VALUES($1,$2,$3,'funded-execution-v1','FUNDED_EXECUTION_QUALITY',$4,
                    $5,'funded-execution-features-v1','LIVE_PAPER',$6,$7,$8,$9,$10,$10,$11,
                    '{}'::jsonb,'[]'::jsonb,$12)`,
            [
              context.cohort.marketId,
              context.cohort.currency,
              lateChallenger.id,
              lateChallenger.artifactDigest,
              context.cohort.cohortDigest,
              context.run.runId,
              context.observationId,
              context.evidence.sequence,
              context.evidence.contentDigest,
              context.evidence.decisionAt,
              new Date(Date.now() + 3_600_000).toISOString(),
              digestOf("late-challenger"),
            ],
          ),
        ).rejects.toThrow(/precede/i);
      }, 120_000);

      it("cannot backdate a late prediction or invent relationships", async () => {
        const context = await predictionContext("18");
        const service = new FundedExecutionPredictionService(
          new PostgresFundedExecutionPredictionStore(pool),
        );
        // A deadline that already passed fails even though the caller supplies
        // no time of its own.
        await expect(
          service.record(
            predictionInput(context, {
              deadlineAt: context.evidence.decisionAt,
            }),
          ),
        ).rejects.toThrow("FUNDED_EXECUTION_PREDICTION_AFTER_DEADLINE");

        // Direct inserts cannot fabricate the challenger/decision binding, and
        // a caller-supplied prediction_at is overwritten by the database clock.
        const base = {
          marketId: "CA_TSX",
          currency: "CAD",
          modelId: context.challenger.id,
          modelVersion: "funded-execution-v1",
          modelType: "FUNDED_EXECUTION_QUALITY",
          artifactDigest: context.challenger.artifactDigest,
          cohortDigest: context.challenger.cohort.cohortDigest,
          featureVersion: "funded-execution-features-v1",
          sourceKind: "LIVE_PAPER",
          runId: context.run.runId,
          observationId: context.observationId,
          decisionSequence: context.evidence.sequence,
          decisionInputDigest: context.evidence.contentDigest,
          decisionAt: context.evidence.decisionAt,
          predictionAt: context.evidence.decisionAt,
          deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
        };
        const directInsert = (overrides: Record<string, unknown>) => {
          const row = { ...base, ...overrides };
          return pool.query(
            `INSERT INTO funded_execution_prediction(
               market_id,currency,model_id,model_version,model_type,artifact_digest,
               cohort_digest,feature_version,source_kind,run_id,observation_id,
               decision_sequence,decision_input_digest,decision_at,prediction_at,
               deadline_at,output,warnings,digest)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'{}'::jsonb,'[]'::jsonb,$17)`,
            [
              row.marketId,
              row.currency,
              row.modelId,
              row.modelVersion,
              row.modelType,
              row.artifactDigest,
              row.cohortDigest,
              row.featureVersion,
              row.sourceKind,
              row.runId,
              row.observationId,
              row.decisionSequence,
              row.decisionInputDigest,
              row.decisionAt,
              row.predictionAt,
              row.deadlineAt,
              digestOf("direct"),
            ],
          );
        };
        // Backdated caller timestamp: the trigger replaces it with now(), which
        // is after the past deadline, so the late prediction fails.
        await expect(
          directInsert({
            deadlineAt: new Date(
              Date.parse(context.evidence.decisionAt) + 60_000,
            ).toISOString(),
          }),
        ).rejects.toThrow(/deadline|timing/i);
        // With a valid future deadline the trigger passes, so fabricated
        // challenger/decision relationships must fail the composite foreign
        // keys instead.
        await expect(
          directInsert({ cohortDigest: digestOf("other-cohort") }),
        ).rejects.toThrow(/foreign key/i);
        await expect(
          directInsert({ artifactDigest: digestOf("other-artifact") }),
        ).rejects.toThrow(/foreign key/i);
        await expect(
          directInsert({ sourceKind: "HISTORICAL_REPLAY" }),
        ).rejects.toThrow(/foreign key/i);
        await expect(
          directInsert({ decisionInputDigest: digestOf("other-decision") }),
        ).rejects.toThrow(/foreign key/i);
        await expect(
          directInsert({ decisionSequence: context.evidence.sequence + 1 }),
        ).rejects.toThrow(/foreign key/i);
        await expect(
          directInsert({ marketId: "US_EQUITIES", currency: "USD" }),
        ).rejects.toThrow(/foreign key/i);
      }, 120_000);

      it("enforces the deadline against the actual wall clock inside an open transaction", async () => {
        const context = await predictionContext("20");
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          // The transaction begins before the deadline; the insert reaches the
          // trigger after it. A transaction-start time (now()) would pass here,
          // so only the actual wall clock can fail the insert.
          const deadlineAt = new Date(Date.now() + 1_500).toISOString();
          await new Promise((resolve) => setTimeout(resolve, 2_000));
          await expect(
            client.query(
              `INSERT INTO funded_execution_prediction(
                 market_id,currency,model_id,model_version,model_type,artifact_digest,
                 cohort_digest,feature_version,source_kind,run_id,observation_id,
                 decision_sequence,decision_input_digest,decision_at,prediction_at,
                 deadline_at,output,warnings,digest)
               VALUES($1,$2,$3,'funded-execution-v1','FUNDED_EXECUTION_QUALITY',$4,
                      $5,'funded-execution-features-v1','LIVE_PAPER',$6,$7,$8,$9,
                      $10,$10,$11,'{}'::jsonb,'[]'::jsonb,$12)`,
              [
                context.cohort.marketId,
                context.cohort.currency,
                context.challenger.id,
                context.challenger.artifactDigest,
                context.cohort.cohortDigest,
                context.run.runId,
                context.observationId,
                context.evidence.sequence,
                context.evidence.contentDigest,
                context.evidence.decisionAt,
                deadlineAt,
                digestOf("late-wall-clock"),
              ],
            ),
          ).rejects.toThrow(/deadline/i);
        } finally {
          await client.query("ROLLBACK").catch(() => {});
          client.release();
        }
      }, 120_000);

      it("resolves concurrent identical predictions to one durable record", async () => {
        const context = await predictionContext("21");
        const service = new FundedExecutionPredictionService(
          new PostgresFundedExecutionPredictionStore(pool),
        );
        const request = predictionInput(context);
        const results = await Promise.all([
          service.record(request),
          service.record(request),
        ]);
        expect(results[0]!.digest).toBe(results[1]!.digest);
        expect(results[0]!.predictionAt).toBe(results[1]!.predictionAt);
        const count = await pool.query<{ count: string }>(
          `SELECT count(*) AS count FROM funded_execution_prediction
            WHERE model_id=$1 AND run_id=$2 AND observation_id=$3`,
          [context.challenger.id, context.run.runId, context.observationId],
        );
        expect(Number(count.rows[0]!.count)).toBe(1);
      }, 120_000);

      it("leaves one row and exposes a concurrent conflicting prediction", async () => {
        const context = await predictionContext("22");
        const service = new FundedExecutionPredictionService(
          new PostgresFundedExecutionPredictionStore(pool),
        );
        const request = predictionInput(context);
        const conflicting = predictionInput(context, {
          output: {
            ...predictionOutput(),
            fillProbability: {
              value: 0.2,
              unit: "PROBABILITY",
              lowerBound: 0,
              upperBound: 1,
            },
          },
        });
        const settled = await Promise.allSettled([
          service.record(request),
          service.record(conflicting),
        ]);
        const fulfilled = settled.filter(
          (result) => result.status === "fulfilled",
        );
        const rejected = settled.filter(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        );
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect(String(rejected[0]!.reason)).toContain(
          "CONFLICTING_FUNDED_EXECUTION_PREDICTION",
        );
        const count = await pool.query<{ count: string }>(
          `SELECT count(*) AS count FROM funded_execution_prediction
            WHERE model_id=$1 AND run_id=$2 AND observation_id=$3`,
          [context.challenger.id, context.run.runId, context.observationId],
        );
        expect(Number(count.rows[0]!.count)).toBe(1);
      }, 120_000);

      it("returns the durable race winner on retry", async () => {
        const context = await predictionContext("23");
        const service = new FundedExecutionPredictionService(
          new PostgresFundedExecutionPredictionStore(pool),
        );
        const request = predictionInput(context);
        const settled = await Promise.allSettled([
          service.record(request),
          service.record(request),
        ]);
        const winner = settled.find(
          (
            result,
          ): result is PromiseFulfilledResult<
            Awaited<ReturnType<typeof service.record>>
          > => result.status === "fulfilled",
        )!.value;
        const retry = await service.record(request);
        expect(retry.digest).toBe(winner.digest);
        expect(retry.predictionAt).toBe(winner.predictionAt);
        expect(retry.model).toEqual(winner.model);
      }, 120_000);

      it("retries an identical prediction after its deadline", async () => {
        const context = await predictionContext("24");
        const service = new FundedExecutionPredictionService(
          new PostgresFundedExecutionPredictionStore(pool),
        );
        const deadlineAt = new Date(Date.now() + 1_500).toISOString();
        const request = predictionInput(context, { deadlineAt });
        const first = await service.record(request);
        expect(Date.parse(first.predictionAt)).toBeLessThanOrEqual(
          Date.parse(deadlineAt),
        );
        await new Promise((resolve) => setTimeout(resolve, 2_000));

        // The deadline has passed, but the durable prediction exists: an exact
        // retry returns the original immutable record.
        const retry = await service.record(request);
        expect(retry.digest).toBe(first.digest);
        expect(retry.predictionAt).toBe(first.predictionAt);

        // A conflicting retry after the deadline exposes the conflict, not a
        // deadline error.
        await expect(
          service.record(
            predictionInput(context, {
              deadlineAt,
              output: {
                ...predictionOutput(),
                fillProbability: {
                  value: 0.2,
                  unit: "PROBABILITY",
                  lowerBound: 0,
                  upperBound: 1,
                },
              },
            }),
          ),
        ).rejects.toThrow("CONFLICTING_FUNDED_EXECUTION_PREDICTION");
        const count = await pool.query<{ count: string }>(
          `SELECT count(*) AS count FROM funded_execution_prediction
            WHERE model_id=$1 AND run_id=$2 AND observation_id=$3`,
          [context.challenger.id, context.run.runId, context.observationId],
        );
        expect(Number(count.rows[0]!.count)).toBe(1);
      }, 120_000);

      it("refuses a genuinely new first prediction after its deadline", async () => {
        const context = await predictionContext("25");
        const service = new FundedExecutionPredictionService(
          new PostgresFundedExecutionPredictionStore(pool),
        );
        const deadlineAt = new Date(Date.now() + 1_500).toISOString();
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        await expect(
          service.record(predictionInput(context, { deadlineAt })),
        ).rejects.toThrow("FUNDED_EXECUTION_PREDICTION_AFTER_DEADLINE");
        const count = await pool.query<{ count: string }>(
          `SELECT count(*) AS count FROM funded_execution_prediction
            WHERE model_id=$1 AND run_id=$2 AND observation_id=$3`,
          [context.challenger.id, context.run.runId, context.observationId],
        );
        expect(Number(count.rows[0]!.count)).toBe(0);
      }, 120_000);

      it("resolves a concurrent retry straddling the deadline to the committed winner", async () => {
        const context = await predictionContext("26");
        const service = new FundedExecutionPredictionService(
          new PostgresFundedExecutionPredictionStore(pool),
        );
        const deadlineAt = new Date(Date.now() + 2_000).toISOString();
        const request = predictionInput(context, { deadlineAt });
        const digest = predictionDigest({
          model: {
            modelId: context.challenger.id,
            modelVersion: context.challenger.modelVersion,
            modelType: "FUNDED_EXECUTION_QUALITY",
            artifactDigest: context.challenger.artifactDigest,
            cohortDigest: context.challenger.cohort.cohortDigest,
            featureVersion: context.challenger.featureVersion,
          },
          marketId: request.marketId,
          currency: request.currency,
          sourceKind: request.sourceKind,
          runId: request.runId,
          observationId: request.observationId,
          decisionSequence: request.expectedDecisionSequence,
          decisionInputDigest: request.expectedDecisionInputDigest,
          deadlineAt: request.deadlineAt,
          output: request.output,
          warnings: request.warnings,
        });
        const holder = await pool.connect();
        try {
          await holder.query("BEGIN");
          await holder.query(
            `INSERT INTO funded_execution_prediction(
               market_id,currency,model_id,model_version,model_type,artifact_digest,
               cohort_digest,feature_version,source_kind,run_id,observation_id,
               decision_sequence,decision_input_digest,decision_at,deadline_at,
               output,warnings,digest)
             VALUES($1,$2,$3,'funded-execution-v1','FUNDED_EXECUTION_QUALITY',$4,
                    $5,'funded-execution-features-v1','LIVE_PAPER',$6,$7,$8,$9,
                    $10,$11,$12::jsonb,'[]'::jsonb,$13)`,
            [
              context.cohort.marketId,
              context.cohort.currency,
              context.challenger.id,
              context.challenger.artifactDigest,
              context.cohort.cohortDigest,
              context.run.runId,
              context.observationId,
              context.evidence.sequence,
              context.evidence.contentDigest,
              context.evidence.decisionAt,
              deadlineAt,
              JSON.stringify(request.output),
              digest,
            ],
          );
          // The retry starts before the deadline but cannot insert until the
          // uncommitted winner resolves; the deadline then passes.
          const pending = service.record(request);
          await new Promise((resolve) => setTimeout(resolve, 3_000));
          await holder.query("COMMIT");
          const record = await pending;
          const stored = await pool.query<{
            prediction_at: Date;
            digest: string;
          }>(
            `SELECT prediction_at,digest FROM funded_execution_prediction
              WHERE model_id=$1 AND run_id=$2 AND observation_id=$3`,
            [context.challenger.id, context.run.runId, context.observationId],
          );
          expect(stored.rows).toHaveLength(1);
          expect(record.digest).toBe(digest);
          expect(record.predictionAt).toBe(
            stored.rows[0]!.prediction_at.toISOString(),
          );
          expect(Date.parse(record.predictionAt)).toBeLessThan(
            Date.parse(deadlineAt),
          );
        } finally {
          await holder.query("ROLLBACK").catch(() => {});
          holder.release();
        }
      }, 120_000);
    });

    /**
     * A partial fill followed by a correction through the production capture
     * paths. The terminal order revision is captured by the database trigger
     * with the real recording clock (never backdated), and the correction is
     * recorded at the caller-supplied wall-clock time so both "before" and
     * "after the cutoff" cases use realistic current cutoffs.
     */
    async function seedPartialThenCorrection(input: {
      runId: string;
      sessionDate: string;
      instrumentId: string;
      cohort: FundedCohortIdentity;
      correctionRecordedAt: string;
    }): Promise<string> {
      const observationId = await seedDecision({
        runId: input.runId,
        sessionDate: input.sessionDate,
        index: 0,
        instrumentId: input.instrumentId,
        marketId: "CA_TSX",
        currency: "CAD",
        sourceKind: "LIVE_PAPER",
        cohort: input.cohort,
        fill: "NONE",
        outcomeOffsetMinutes: 5,
      });
      const partialAt = `${input.sessionDate}T14:32:00.000Z`;
      const correctionAt = `${input.sessionDate}T14:45:00.000Z`;
      // A cancelled order proves the entry opportunity has ended, so the
      // partial fill is final for this decision. The terminal revision is
      // written through the production order path; its immutable history proof
      // carries the database recording clock.
      const terminalState = {
        orderId: observationId,
        version: "pending-entry-v1",
        status: "CANCELLED",
        execution: null,
      };
      await pool.query(
        `INSERT INTO paper_entry_order(order_id,run_id,instrument_id,submission,state,revision,last_fact_at,updated_at)
         VALUES($1,$2,$3,'{}'::jsonb,$4::jsonb,0,$5,$5)`,
        [
          observationId,
          input.runId,
          input.instrumentId,
          JSON.stringify(terminalState),
          partialAt,
        ],
      );
      await pool.query(
        `INSERT INTO funded_decision_outcome(
           run_id,observation_id,sequence,status,source_kind,source_id,source_digest,available_at,recorded_at,detail)
         VALUES($1,$2,1,'PARTIAL_FILL','LIVE_PAPER',$3,$4,$5,$5,$6::jsonb)`,
        [
          input.runId,
          observationId,
          `ledger:${observationId}:partial`,
          digestOf(`${observationId}:partial`),
          partialAt,
          JSON.stringify({
            filledFraction: 0.5,
            filledShares: 50,
            requestedShares: 100,
            averagePrice: 10.02,
            fees: 0.5,
            slippage: 0.01,
          }),
        ],
      );
      await pool.query(
        `INSERT INTO funded_decision_outcome(
           run_id,observation_id,sequence,status,source_kind,source_id,source_digest,available_at,recorded_at,supersedes_sequence,detail)
         VALUES($1,$2,2,'FILLED','LIVE_PAPER',$3,$4,$5,$6,1,$7::jsonb)`,
        [
          input.runId,
          observationId,
          `ledger:${observationId}:fill`,
          digestOf(`${observationId}:filled`),
          correctionAt,
          input.correctionRecordedAt,
          JSON.stringify({
            filledFraction: 1,
            filledShares: 100,
            requestedShares: 100,
            averagePrice: 10.02,
            fees: 1,
            slippage: 0.01,
          }),
        ],
      );
      return observationId;
    }

    async function seedChallenger(
      cohort: FundedCohortIdentity,
      createdAt = "2025-08-15T00:00:00.000Z",
    ): Promise<FundedExecutionChallenger> {
      const datasetId = randomUUID();
      const datasetDigest = digestOf(`challenger-dataset:${datasetId}`);
      const artifact = buildArtifact(datasetDigest, digestOf("partition"));
      const inserted = await pool.query<{ id: string }>(
        `INSERT INTO funded_execution_dataset(
           id,market_id,currency,source_kind,evidence_schema_version,cohort_digest,cohort_components,
           dataset_policy_version,label_mapping_version,feature_version,qualification_policy_version,
           requested_cutoff,effective_cutoff,membership_digest,dataset_digest,row_count,counts,
           qualification_receipt,source_watermark,activation_eligible)
         VALUES($1,$2,$3,'LIVE_PAPER',2,$4,$5::jsonb,'funded-execution-dataset-v1',
                'funded-execution-labels-v1','funded-execution-features-v1',
                'funded-execution-qualification-v1',$6,$6,$7,$8,0,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,false)
         RETURNING id`,
        [
          datasetId,
          cohort.marketId,
          cohort.currency,
          cohort.cohortDigest,
          JSON.stringify(withoutDigest(cohort)),
          createdAt,
          digestOf("membership"),
          datasetDigest,
        ],
      );
      const storedDatasetId = inserted.rows[0]!.id;
      const challenger = await pool.query<{ id: string }>(
        `INSERT INTO funded_execution_challenger(
            market_id,currency,cohort_digest,cohort_components,dataset_id,dataset_digest,
            model_version,model_type,artifact_digest,feature_version,label_mapping_version,
            qualification_policy_version,training_policy_version,training_code_version,
            runtime_fingerprint,status,artifact,metrics,sample_counts,failure_receipt,created_at)
          VALUES($1,$2,$3,$4::jsonb,$5,$6,'funded-execution-v1','FUNDED_EXECUTION_QUALITY',$7,
                 'funded-execution-features-v1','funded-execution-labels-v1',
                 'funded-execution-qualification-v1','funded-execution-training-v1',
                 'funded-execution-trainer-v1',NULL,'INACTIVE',$8::jsonb,NULL,'{}'::jsonb,NULL,$9)
          RETURNING id`,
        [
          cohort.marketId,
          cohort.currency,
          cohort.cohortDigest,
          JSON.stringify(withoutDigest(cohort)),
          storedDatasetId,
          datasetDigest,
          fundedExecutionArtifactDigest(artifact),
          JSON.stringify(artifact),
          createdAt,
        ],
      );
      return fundedExecutionChallengerSchema.parse({
        id: challenger.rows[0]!.id,
        marketId: cohort.marketId,
        currency: cohort.currency,
        cohort,
        datasetId: storedDatasetId,
        datasetDigest,
        modelVersion: "funded-execution-v1",
        modelType: "FUNDED_EXECUTION_QUALITY",
        artifactDigest: fundedExecutionArtifactDigest(artifact),
        featureVersion: "funded-execution-features-v1",
        labelMappingVersion: "funded-execution-labels-v1",
        qualificationPolicyVersion: "funded-execution-qualification-v1",
        trainingPolicyVersion: "funded-execution-training-v1",
        trainingCodeVersion: "funded-execution-trainer-v1",
        runtimeFingerprint: null,
        status: "INACTIVE",
        eligibleForActivation: false,
        active: false,
        artifact,
        metrics: null,
        sampleCounts: {},
        failureReceipt: null,
        createdAt,
      });
    }

    async function fundedMutationCounters() {
      const tables = [
        "paper_bot_run",
        "paper_signal_observation",
        "paper_funded_run",
        "paper_funded_account",
        "paper_funded_event",
        "paper_entry_order",
        "funded_decision_evidence",
        "funded_decision_outcome",
        "statistical_model",
        "statistical_training_dataset",
      ];
      const counters: Record<string, number> = {};
      for (const table of tables) {
        const result = await pool.query<{ count: string }>(
          `SELECT count(*) AS count FROM ${table}`,
        );
        counters[table] = Number(result.rows[0]!.count);
      }
      return counters;
    }

    function predictionOutput(): FundedExecutionPredictionOutput {
      return {
        fillProbability: {
          value: 0.8,
          unit: "PROBABILITY",
          lowerBound: 0,
          upperBound: 1,
        },
        expectedFillFraction: {
          value: 0.7,
          unit: "FRACTION",
          lowerBound: 0,
          upperBound: 1,
        },
        expectedSlippagePerShare: {
          value: 0.01,
          unit: "CURRENCY_PER_SHARE",
          lowerBound: 0,
          upperBound: null,
        },
        expectedTotalExecutionCost: {
          value: 1.2,
          unit: "CURRENCY",
          lowerBound: 0,
          upperBound: null,
        },
      };
    }

    function buildArtifact(
      datasetDigest: string,
      partitionDigest: string,
    ): FundedExecutionModelArtifact {
      const head = (
        output: string,
        kind: "LOGISTIC" | "LINEAR",
        unit: string,
      ) => {
        const metrics =
          kind === "LOGISTIC"
            ? {
                kind,
                samples: 100,
                positives: 50,
                negatives: 50,
                baseRate: 0.5,
                brierScore: 0.2,
                baselineBrierScore: 0.25,
                logLoss: 0.6,
                rocAuc: 0.6,
                calibration: [],
              }
            : {
                kind,
                samples: 100,
                meanPredicted: 0.5,
                meanActual: 0.5,
                meanAbsoluteError: 0.1,
                rootMeanSquaredError: 0.2,
              };
        return {
          output,
          kind,
          unit,
          lowerBound: 0,
          upperBound: unit === "PROBABILITY" || unit === "FRACTION" ? 1 : null,
          trainingSamples: 100,
          intercept: 0.1,
          coefficients: FUNDED_EXECUTION_FEATURE_NAMES.map(() => 0.01),
          means: FUNDED_EXECUTION_FEATURE_NAMES.map(() => 0),
          scales: FUNDED_EXECUTION_FEATURE_NAMES.map(() => 1),
          medians: FUNDED_EXECUTION_FEATURE_NAMES.map(() => 0),
          trainMetrics: metrics,
          testMetrics: metrics,
        };
      };
      return {
        artifactVersion: "funded-execution-v1",
        modelType: "FUNDED_EXECUTION_QUALITY",
        featureVersion: "funded-execution-features-v1",
        featureNames: [...FUNDED_EXECUTION_FEATURE_NAMES],
        sourceDatasetDigest: datasetDigest,
        trainingPartitionDigest: partitionDigest,
        trainingRowCount: 100,
        trainingFillRowCount: 100,
        trainingCostRowCount: 50,
        outputs: [
          head("fillProbability", "LOGISTIC", "PROBABILITY"),
          head("expectedFillFraction", "LINEAR", "FRACTION"),
          head("expectedSlippagePerShare", "LINEAR", "CURRENCY_PER_SHARE"),
          head("expectedTotalExecutionCost", "LINEAR", "CURRENCY"),
        ] as unknown as FundedExecutionModelArtifact["outputs"],
        warnings: [],
      };
    }

    function digestOf(value: string): string {
      return createHash("sha256").update(value).digest("hex");
    }

    describe("database-owned applied sequences and terminality capture", () => {
      function signalEnvelope(input: {
        orderId: string;
        instrumentId: string;
        submittedAt: string;
        expiresAt: string;
      }) {
        return {
          id: `funded-signal:${input.orderId}`,
          fact: {
            type: "SIGNAL" as const,
            instrumentId: input.instrumentId,
            maximumDebit: 1_000,
            maximumRisk: 100,
            order: {
              orderId: input.orderId,
              submittedAt: input.submittedAt,
              expiresAt: input.expiresAt,
              signal: {
                entryReference: 10,
                stopReference: 9.5,
                targetReference: 11,
                atr14: 0.5,
                signalTimestamp: input.submittedAt,
              },
              assumptions,
            },
          },
        };
      }

      function cancelEnvelope(input: {
        eventId: string;
        orderId: string;
        at: string;
      }) {
        return {
          id: `funded-invalidation:${input.eventId}`,
          fact: {
            type: "CANCEL" as const,
            orderId: input.orderId,
            at: input.at,
            reason: "SIGNAL_INVALIDATED" as const,
            preSubmissionEventId: input.eventId,
          },
        };
      }

      async function factRows(runId: string) {
        const result = await pool.query<{
          fact_id: string;
          status: string | null;
          applied_sequence: string | null;
        }>(
          `SELECT fact_id,outcome->>'status' AS status,applied_sequence
             FROM paper_funded_fact WHERE run_id=$1
            ORDER BY applied_sequence NULLS LAST, fact_id`,
          [runId],
        );
        return result.rows.map((row) => ({
          factId: row.fact_id,
          status: row.status,
          sequence:
            row.applied_sequence === null ? null : Number(row.applied_sequence),
        }));
      }

      it("sequences both enqueue-side processed paths, leaves LATE_FACT unsequenced and refuses caller control", async () => {
        const run = await seedRun({
          marketId: "CA_TSX",
          currency: "CAD",
          sessionDate: "2025-12-01",
          source: "LIVE",
          sourceKind: "LIVE_PAPER",
          complete: false,
        });
        const instrumentId = await insertInstrument("CA_TSX");
        const adapter = new FundedFactAdapter(pool, run.runId);
        const suppressedOrderId = randomUUID();
        const reconciledOrderId = randomUUID();

        // Path 1: PRE_SUBMISSION_SUPPRESSED update of an existing SIGNAL. The
        // signal is still pending and has no committed order.
        await adapter.enqueue([
          signalEnvelope({
            orderId: suppressedOrderId,
            instrumentId,
            submittedAt: "2025-12-01T14:30:00.000Z",
            expiresAt: "2025-12-01T15:00:00.000Z",
          }),
        ]);
        await adapter.enqueue([
          cancelEnvelope({
            eventId: "path1",
            orderId: suppressedOrderId,
            at: "2025-12-01T14:31:00.000Z",
          }),
        ]);
        // Path 2: a submitted PENDING order is reconciled by the enqueue
        // transaction and its CANCEL is inserted directly with APPLIED.
        await adapter.enqueue([
          signalEnvelope({
            orderId: reconciledOrderId,
            instrumentId,
            submittedAt: "2025-12-01T14:32:00.000Z",
            expiresAt: "2025-12-01T15:00:00.000Z",
          }),
        ]);
        await adapter.drain();
        await adapter.enqueue([
          cancelEnvelope({
            eventId: "path2",
            orderId: reconciledOrderId,
            at: "2025-12-01T14:32:00.000Z",
          }),
        ]);
        // A newly supplied fact at an already processed timestamp is late.
        await adapter.enqueue([
          {
            id: "late-quote",
            fact: {
              type: "QUOTE",
              instrumentId,
              participation: 1,
              impactBps: 0,
              quote: {
                timestamp: "2025-12-01T14:20:00.000Z",
                bid: 9.99,
                ask: 10,
                bidSize: 100,
                askSize: 100,
                dataStatus: "REALTIME",
                actionable: true,
              },
            },
          },
        ]);

        expect(await factRows(run.runId)).toEqual([
          {
            factId: `funded-signal:${suppressedOrderId}`,
            status: "PRE_SUBMISSION_SUPPRESSED",
            sequence: 1,
          },
          {
            factId: "funded-invalidation:path1",
            status: "PRE_SUBMISSION_SUPPRESSED",
            sequence: 2,
          },
          {
            factId: `funded-signal:${reconciledOrderId}`,
            status: "APPLIED",
            sequence: 3,
          },
          {
            factId: "funded-invalidation:path2",
            status: "APPLIED",
            sequence: 4,
          },
          { factId: "late-quote", status: "LATE_FACT", sequence: null },
        ]);
        expect(
          (
            await pool.query<{ applied_sequence_counter: string }>(
              "SELECT applied_sequence_counter FROM paper_funded_run WHERE run_id=$1",
              [run.runId],
            )
          ).rows[0]!.applied_sequence_counter,
        ).toBe("4");
        // The enqueue-side reconciliation persists the exact CANCEL fact on the
        // order revision it cancels, and the original revision keeps the exact
        // SIGNAL envelope. Recovery/retry therefore retain causal identity.
        const reconciledOrder = await pool.query<{
          last_fact_id: string | null;
        }>(
          "SELECT last_fact_id FROM paper_entry_order WHERE run_id=$1 AND order_id=$2",
          [run.runId, reconciledOrderId],
        );
        expect(reconciledOrder.rows[0]!.last_fact_id).toBe(
          "funded-invalidation:path2",
        );
        const reconciledHistory = await pool.query<{
          revision: string;
          fact_id: string | null;
        }>(
          `SELECT revision,fact_id FROM paper_entry_order_history
            WHERE order_id=$1 ORDER BY revision`,
          [reconciledOrderId],
        );
        expect(
          reconciledHistory.rows.map((row) => ({
            revision: Number(row.revision),
            factId: row.fact_id,
          })),
        ).toEqual([
          {
            revision: 0,
            factId: `funded-signal:${reconciledOrderId}`,
          },
          { revision: 1, factId: "funded-invalidation:path2" },
        ]);

        // Direct callers cannot fabricate, change or clear a sequence, and a
        // processed outcome cannot be rewritten.
        await expect(
          pool.query(
            `INSERT INTO paper_funded_fact(
               run_id,fact_id,fact_at,priority,sort_key,fact,economic_key,outcome,applied_sequence)
             VALUES($1,'fabricated','2025-12-01T14:40:00.000Z',2,'fabricated','{}'::jsonb,
                    'fabricated','{"status":"APPLIED"}'::jsonb,99)`,
            [run.runId],
          ),
        ).rejects.toThrow(/database-owned/i);
        for (const mutation of [
          "SET applied_sequence=applied_sequence+100",
          "SET applied_sequence=NULL",
        ])
          await expect(
            pool.query(
              `UPDATE paper_funded_fact ${mutation}
                WHERE run_id=$1 AND fact_id='funded-invalidation:path2'`,
              [run.runId],
            ),
          ).rejects.toThrow(/immutable/i);
        // The LATE_FACT assignment itself cannot be cleared by rewriting its
        // outcome, and a processed outcome cannot be reset.
        await expect(
          pool.query(
            `UPDATE paper_funded_fact SET outcome='{"status":"APPLIED"}'::jsonb
              WHERE run_id=$1 AND fact_id='late-quote'`,
            [run.runId],
          ),
        ).rejects.toThrow(/immutable/i);

        // Retry after a lost response preserves the original sequence.
        await adapter.enqueue([
          cancelEnvelope({
            eventId: "path2",
            orderId: reconciledOrderId,
            at: "2025-12-01T14:32:00.000Z",
          }),
        ]);
        expect((await factRows(run.runId)).at(-2)).toMatchObject({
          factId: "funded-invalidation:path2",
          sequence: 4,
        });

        // Sequences are run-isolated: another run starts at one.
        const other = await seedRun({
          marketId: "CA_TSX",
          currency: "CAD",
          sessionDate: "2025-12-02",
          source: "LIVE",
          sourceKind: "LIVE_PAPER",
        });
        const otherAdapter = new FundedFactAdapter(pool, other.runId);
        const otherOrderId = randomUUID();
        await otherAdapter.enqueue([
          signalEnvelope({
            orderId: otherOrderId,
            instrumentId,
            submittedAt: "2025-12-02T14:30:00.000Z",
            expiresAt: "2025-12-02T15:00:00.000Z",
          }),
        ]);
        await otherAdapter.enqueue([
          cancelEnvelope({
            eventId: "isolation",
            orderId: otherOrderId,
            at: "2025-12-02T14:31:00.000Z",
          }),
        ]);
        const otherRows = await factRows(other.runId);
        expect(otherRows.map((row) => row.sequence)).toEqual([1, null]);
        const counters = await pool.query<{ counter: string }>(
          `SELECT applied_sequence_counter::text AS counter
             FROM paper_funded_run WHERE run_id=$1`,
          [other.runId],
        );
        expect(counters.rows[0]!.counter).toBe("1");
      }, 180_000);

      it("fails a replay run closed when a processed non-LATE fact has no required sequence", async () => {
        const cohort = cohortFor({
          marketId: "CA_TSX",
          currency: "CAD",
          sourceKind: "HISTORICAL_REPLAY",
          fundedPolicyVersion: "funded-policy-incomplete-chronology",
        });
        const run = await seedRun({
          marketId: "CA_TSX",
          currency: "CAD",
          sessionDate: "2025-12-03",
          source: "BACKTEST",
          sourceKind: "HISTORICAL_REPLAY",
        });
        const instrumentId = await insertInstrument("CA_TSX");
        const observationId = await seedDecision({
          runId: run.runId,
          sessionDate: "2025-12-03",
          index: 0,
          instrumentId,
          marketId: "CA_TSX",
          currency: "CAD",
          sourceKind: "HISTORICAL_REPLAY",
          cohort,
          fill: "FILLED",
          outcomeOffsetMinutes: 5,
        });
        // Deliberately incomplete chronology: a processed non-LATE fact with
        // no sequence can only be written with the assignment trigger
        // disabled, as an older writer or a manual repair might.
        await pool.query(
          `ALTER TABLE paper_funded_fact
             DISABLE TRIGGER paper_funded_fact_applied_sequence;
           ALTER TABLE paper_funded_fact
             DISABLE TRIGGER paper_funded_fact_applied_sequence_insert;`,
        );
        try {
          await pool.query(
            `INSERT INTO paper_funded_fact(
               run_id,fact_id,fact_at,priority,sort_key,fact,economic_key,outcome)
             VALUES($1,'unsequenced','2025-12-03T14:31:00.000Z',2,'unsequenced',
                    '{}'::jsonb,'unsequenced','{"status":"APPLIED"}'::jsonb)`,
            [run.runId],
          );
        } finally {
          await pool.query(
            `ALTER TABLE paper_funded_fact
               ENABLE TRIGGER paper_funded_fact_applied_sequence;
             ALTER TABLE paper_funded_fact
               ENABLE TRIGGER paper_funded_fact_applied_sequence_insert;`,
          );
        }
        const store = new PostgresFundedExecutionTrainingStore(pool);
        const rows = await store.assembledRowsFor(
          cohort.cohortDigest,
          new Date("2025-12-03T20:00:00.000Z"),
        );
        const row = rows.find((entry) => entry.observationId === observationId);
        expect(row?.verdict).toBe("EXCLUDED");
        expect(row?.exclusionReason).toBe("REPLAY_CHRONOLOGY_UNPROVEN");
      }, 120_000);

      it("does not trust a migration-130 replay outcome boundary without its source fact", async () => {
        const cohort = cohortFor({
          marketId: "CA_TSX",
          currency: "CAD",
          sourceKind: "HISTORICAL_REPLAY",
          fundedPolicyVersion: "funded-policy-legacy-outcome-boundary",
        });
        const run = await seedRun({
          marketId: "CA_TSX",
          currency: "CAD",
          sessionDate: "2025-12-03",
          source: "BACKTEST",
          sourceKind: "HISTORICAL_REPLAY",
        });
        const instrumentId = await insertInstrument("CA_TSX");
        const observationId = await seedDecision({
          runId: run.runId,
          sessionDate: "2025-12-03",
          index: 1,
          instrumentId,
          marketId: "CA_TSX",
          currency: "CAD",
          sourceKind: "HISTORICAL_REPLAY",
          cohort,
          fill: "FILLED",
          outcomeOffsetMinutes: 5,
        });
        const source = await pool.query<{
          applied_sequence: string;
          applied_frontier_at: Date;
        }>(
          `SELECT applied_sequence,applied_frontier_at
             FROM paper_funded_fact
            WHERE run_id=$1 AND fact_id='funded-signal:'||$2::text`,
          [run.runId, observationId],
        );
        const boundary = source.rows[0]!;
        // This is the shape retained by a database upgraded from migration
        // 130: knowledge columns existed, while source_fact_id did not. The
        // migration intentionally does not backfill an unprovable source.
        await pool.query(
          `ALTER TABLE funded_decision_outcome
             DISABLE TRIGGER funded_decision_outcome_knowledge_boundary`,
        );
        try {
          await pool.query(
            `INSERT INTO funded_decision_outcome(
               run_id,observation_id,sequence,status,source_kind,source_id,source_digest,
               available_at,recorded_at,detail,supersedes_sequence,
               knowledge_applied_sequence,knowledge_at,source_fact_id)
             VALUES($1,$2,2,'FILLED','HISTORICAL_REPLAY',$3,$4,$5,$5,$6::jsonb,1,$7,$8,NULL)`,
            [
              run.runId,
              observationId,
              `legacy:${observationId}`,
              digestOf(`${observationId}:legacy-boundary`),
              "2025-12-03T14:36:00.000Z",
              JSON.stringify({
                filledFraction: 1,
                filledShares: 100,
                requestedShares: 100,
                averagePrice: 10.02,
                fees: 1,
                slippage: 0.02,
              }),
              boundary.applied_sequence,
              boundary.applied_frontier_at,
            ],
          );
        } finally {
          await pool.query(
            `ALTER TABLE funded_decision_outcome
               ENABLE TRIGGER funded_decision_outcome_knowledge_boundary`,
          );
        }
        const store = new PostgresFundedExecutionTrainingStore(pool);
        const row = (
          await store.assembledRowsFor(
            cohort.cohortDigest,
            new Date("2025-12-03T20:00:00.000Z"),
          )
        ).find((entry) => entry.observationId === observationId);
        expect(row?.verdict).toBe("EXCLUDED");
        expect(row?.exclusionReason).toBe("REPLAY_CHRONOLOGY_UNPROVEN");
        expect(row?.labels).toBeNull();
      }, 120_000);

      it("clears stale order causes when quote, transition and clock mutations have no fact", async () => {
        const run = await seedRun({
          marketId: "CA_TSX",
          currency: "CAD",
          sessionDate: "2025-12-19",
          source: "BACKTEST",
          sourceKind: "HISTORICAL_REPLAY",
          complete: false,
        });
        const service = new FundedOrderService(
          pool,
          run.runId,
          run.accountId,
          "CAD",
        );
        const cases = ["transition", "quote", "clock"] as const;
        const orders: { orderId: string; instrumentId: string }[] = [];
        for (const [index, kind] of cases.entries()) {
          const instrumentId = await insertInstrument("CA_TSX");
          const orderId = randomUUID();
          const causeFactId = `initial-${kind}-${orderId}`;
          const submittedAt = `2025-12-19T14:${30 + index}:00.000Z`;
          await pool.query(
            `INSERT INTO paper_funded_fact(
               run_id,fact_id,fact_at,priority,sort_key,fact,economic_key,outcome)
             VALUES($1,$2,$3,2,$2,'{}'::jsonb,$2,'{"status":"APPLIED"}'::jsonb)`,
            [run.runId, causeFactId, submittedAt],
          );
          await service.submit(
            instrumentId,
            {
              orderId,
              signal: {
                entryReference: 10,
                stopReference: 9.5,
                targetReference: 11,
                atr14: 0.5,
                signalTimestamp: submittedAt,
              },
              assumptions,
              submittedAt,
              expiresAt:
                kind === "clock"
                  ? "2025-12-19T14:40:00.000Z"
                  : "2025-12-19T15:30:00.000Z",
            },
            1_000,
            100,
            causeFactId,
          );
          orders.push({ orderId, instrumentId });
        }
        await service.cancel(
          orders[0]!.orderId,
          "2025-12-19T14:35:00.000Z",
          "SIGNAL_INVALIDATED",
        );
        await service.quote(
          orders[1]!.instrumentId,
          {
            timestamp: "2025-12-19T14:36:00.000Z",
            bid: 9.99,
            ask: 10,
            bidSize: 1_000,
            askSize: 1_000,
            dataStatus: "REALTIME",
            actionable: true,
          },
          0.25,
          0,
        );
        await service.advanceClock("2025-12-19T14:41:00.000Z");
        for (const { orderId } of orders) {
          const latest = await pool.query<{ fact_id: string | null }>(
            `SELECT fact_id FROM paper_entry_order_history
              WHERE order_id=$1 ORDER BY revision DESC LIMIT 1`,
            [orderId],
          );
          expect(latest.rows[0]?.fact_id).toBeNull();
        }
      }, 180_000);

      it("makes ledger causal ownership immutable and part of retry identity", async () => {
        const run = await seedRun({
          marketId: "CA_TSX",
          currency: "CAD",
          sessionDate: "2025-12-20",
          source: "BACKTEST",
          sourceKind: "HISTORICAL_REPLAY",
          complete: false,
        });
        const other = await seedRun({
          marketId: "CA_TSX",
          currency: "CAD",
          sessionDate: "2025-12-21",
          source: "BACKTEST",
          sourceKind: "HISTORICAL_REPLAY",
          complete: false,
        });
        for (const [runId, factId, factAt] of [
          [run.runId, "ledger-cause-a", "2025-12-20T14:00:00.000Z"],
          [run.runId, "ledger-cause-b", "2025-12-20T14:01:00.000Z"],
          [other.runId, "other-run-cause", "2025-12-21T14:00:00.000Z"],
        ] as const)
          await pool.query(
            `INSERT INTO paper_funded_fact(
               run_id,fact_id,fact_at,priority,sort_key,fact,economic_key,outcome)
             VALUES($1,$2,$3,2,$2,'{}'::jsonb,$2,'{"status":"APPLIED"}'::jsonb)`,
            [runId, factId, factAt],
          );
        const event = {
          id: `causal-reserve:${randomUUID()}`,
          at: "2025-12-20T14:02:00.000Z",
          currency: "CAD" as const,
          type: "RESERVE" as const,
          orderId: randomUUID(),
          debit: 100,
          risk: 10,
        };
        await ledger.apply(run.accountId, [event], {
          causeRunId: run.runId,
          causeFactId: "ledger-cause-a",
        });
        await expect(
          pool.query(
            `UPDATE paper_funded_event SET fact_id='ledger-cause-b'
              WHERE account_id=$1 AND event_id=$2`,
            [run.accountId, event.id],
          ),
        ).rejects.toThrow(/immutable/i);
        await expect(
          ledger.apply(run.accountId, [event], {
            causeRunId: run.runId,
            causeFactId: "ledger-cause-b",
          }),
        ).rejects.toThrow("Conflicting ledger event causal provenance");
        await expect(
          ledger.apply(
            run.accountId,
            [
              {
                ...event,
                id: `cross-run-reserve:${randomUUID()}`,
                orderId: randomUUID(),
                at: "2025-12-20T14:03:00.000Z",
              },
            ],
            {
              causeRunId: other.runId,
              causeFactId: "other-run-cause",
            },
          ),
        ).rejects.toThrow(/same funded account/i);
      }, 180_000);

      it("binds a replay correction to its exact causal fact and preserves it on retry", async () => {
        const cohort = cohortFor({
          marketId: "CA_TSX",
          currency: "CAD",
          sourceKind: "HISTORICAL_REPLAY",
          fundedPolicyVersion: "funded-policy-replay-correction-boundary",
        });
        const run = await seedRun({
          marketId: "CA_TSX",
          currency: "CAD",
          sessionDate: "2025-12-04",
          source: "BACKTEST",
          sourceKind: "HISTORICAL_REPLAY",
        });
        const instrumentId = await insertInstrument("CA_TSX");
        const observationId = await seedDecision({
          runId: run.runId,
          sessionDate: "2025-12-04",
          index: 0,
          instrumentId,
          marketId: "CA_TSX",
          currency: "CAD",
          sourceKind: "HISTORICAL_REPLAY",
          cohort,
          fill: "FILLED",
          outcomeOffsetMinutes: 5,
        });
        const economicAt = "2025-12-04T14:35:00.000Z";
        // A later replay fact is applied after the original outcome, so the
        // correction is only knowable at that exact fact's boundary.
        await pool.query(
          `INSERT INTO paper_funded_fact(
             run_id,fact_id,fact_at,priority,sort_key,fact,economic_key,outcome)
           VALUES($1,'later-fact','2025-12-04T15:30:00.000Z',1,'later-fact',
                  '{}'::jsonb,'later-fact','{"status":"APPLIED"}'::jsonb)`,
          [run.runId],
        );
        const evidence = new FundedDecisionEvidenceRepository(pool);
        const correction = await evidence.appendOutcomeVersion({
          runId: run.runId,
          observationId,
          status: "FILLED",
          // The correction keeps the earlier economic time; its boundary is
          // the later applied fact.
          availableAt: economicAt,
          sourceKind: "HISTORICAL_REPLAY",
          sourceId: `ledger:${observationId}:corrected`,
          reason: null,
          detail: {
            filledFraction: 1,
            filledShares: 100,
            requestedShares: 100,
            averagePrice: 10.02,
            fees: 1,
            slippage: 0.02,
          },
          supersedesSequence: 1,
          sourceFactId: "later-fact",
        });
        expect(correction.sequence).toBe(2);
        expect(correction.sourceFactId).toBe("later-fact");
        const stored = await pool.query<{
          knowledge_applied_sequence: string;
          knowledge_at: Date;
        }>(
          `SELECT knowledge_applied_sequence,knowledge_at FROM funded_decision_outcome
            WHERE run_id=$1 AND observation_id=$2 AND sequence=2`,
          [run.runId, observationId],
        );
        expect(Number(stored.rows[0]!.knowledge_applied_sequence)).toBe(2);
        expect(stored.rows[0]!.knowledge_at.toISOString()).toBe(
          "2025-12-04T15:30:00.000Z",
        );

        // An exact retry preserves the original version, boundary and capture.
        const retry = await evidence.appendOutcomeVersion({
          runId: run.runId,
          observationId,
          status: "FILLED",
          availableAt: economicAt,
          sourceKind: "HISTORICAL_REPLAY",
          sourceId: `ledger:${observationId}:corrected`,
          reason: null,
          detail: {
            filledFraction: 1,
            filledShares: 100,
            requestedShares: 100,
            averagePrice: 10.02,
            fees: 1,
            slippage: 0.02,
          },
          supersedesSequence: 1,
          sourceFactId: "later-fact",
        });
        expect(retry.sequence).toBe(correction.sequence);
        expect(retry.recordedAt).toBe(correction.recordedAt);
        expect(retry.sourceFactId).toBe("later-fact");
        // A retry may not attach a different causal fact to the same version.
        await expect(
          evidence.appendOutcomeVersion({
            runId: run.runId,
            observationId,
            status: "FILLED",
            availableAt: economicAt,
            sourceKind: "HISTORICAL_REPLAY",
            sourceId: `ledger:${observationId}:corrected`,
            reason: null,
            detail: {
              filledFraction: 1,
              filledShares: 100,
              requestedShares: 100,
              averagePrice: 10.02,
              fees: 1,
              slippage: 0.02,
            },
            supersedesSequence: 1,
            sourceFactId: `funded-signal:${observationId}`,
          }),
        ).rejects.toThrow("Conflicting funded outcome source retry");

        const store = new PostgresFundedExecutionTrainingStore(pool);
        // A current cutoff follows the correction's real database capture.
        const rows = await store.assembledRowsFor(
          cohort.cohortDigest,
          new Date(Date.now() + 60_000),
        );
        const row = rows.find((entry) => entry.observationId === observationId);
        expect(row?.verdict).toBe("INCLUDED");
        expect(row?.labels?.terminalOutcomeSequence).toBe(2);
        expect(row?.labels?.economicOutcomeAt).toBe(economicAt);
        expect(row?.labels?.knowledge).toEqual({
          provenance: "HISTORICAL_REPLAY_FACT_SEQUENCE",
          runId: run.runId,
          sequence: 2,
          at: "2025-12-04T15:30:00.000Z",
        });
      }, 120_000);

      it("keeps a correction without a new causal fact unavailable to replay training", async () => {
        const cohort = cohortFor({
          marketId: "CA_TSX",
          currency: "CAD",
          sourceKind: "HISTORICAL_REPLAY",
          fundedPolicyVersion: "funded-policy-no-new-fact-correction",
        });
        const run = await seedRun({
          marketId: "CA_TSX",
          currency: "CAD",
          sessionDate: "2025-12-05",
          source: "BACKTEST",
          sourceKind: "HISTORICAL_REPLAY",
        });
        const instrumentId = await insertInstrument("CA_TSX");
        const observationId = await seedDecision({
          runId: run.runId,
          sessionDate: "2025-12-05",
          index: 0,
          instrumentId,
          marketId: "CA_TSX",
          currency: "CAD",
          sourceKind: "HISTORICAL_REPLAY",
          cohort,
          fill: "FILLED",
          outcomeOffsetMinutes: 5,
        });
        const evidence = new FundedDecisionEvidenceRepository(pool);
        // No new fact is applied; the correction must not inherit the run's
        // current boundary.
        const correction = await evidence.appendOutcomeVersion({
          runId: run.runId,
          observationId,
          status: "FILLED",
          availableAt: "2025-12-05T14:35:00.000Z",
          sourceKind: "HISTORICAL_REPLAY",
          sourceId: `ledger:${observationId}:no-fact-correction`,
          reason: null,
          detail: {
            filledFraction: 1,
            filledShares: 100,
            requestedShares: 100,
            averagePrice: 10.02,
            fees: 1,
            slippage: 0.04,
          },
          supersedesSequence: 1,
        });
        expect(correction.sequence).toBe(2);
        expect(correction.sourceFactId).toBeNull();
        const stored = await pool.query<{
          source_fact_id: string | null;
          knowledge_applied_sequence: string | null;
          knowledge_at: Date | null;
        }>(
          `SELECT source_fact_id,knowledge_applied_sequence,knowledge_at
             FROM funded_decision_outcome
            WHERE run_id=$1 AND observation_id=$2 AND sequence=2`,
          [run.runId, observationId],
        );
        expect(stored.rows[0]).toEqual({
          source_fact_id: null,
          knowledge_applied_sequence: null,
          knowledge_at: null,
        });
        const store = new PostgresFundedExecutionTrainingStore(pool);
        const rows = await store.assembledRowsFor(
          cohort.cohortDigest,
          new Date(Date.now() + 60_000),
        );
        const row = rows.find((entry) => entry.observationId === observationId);
        expect(row?.verdict).toBe("EXCLUDED");
        expect(row?.exclusionReason).toBe("REPLAY_CHRONOLOGY_UNPROVEN");
        expect(row?.labels).toBeNull();
      }, 120_000);

      it("fails closed on missing, pending, LATE, cross-run or fabricated replay sources", async () => {
        const cohort = cohortFor({
          marketId: "CA_TSX",
          currency: "CAD",
          sourceKind: "HISTORICAL_REPLAY",
          fundedPolicyVersion: "funded-policy-source-validation",
        });
        const run = await seedRun({
          marketId: "CA_TSX",
          currency: "CAD",
          sessionDate: "2025-12-08",
          source: "BACKTEST",
          sourceKind: "HISTORICAL_REPLAY",
        });
        const instrumentId = await insertInstrument("CA_TSX");
        const observationId = await seedDecision({
          runId: run.runId,
          sessionDate: "2025-12-08",
          index: 0,
          instrumentId,
          marketId: "CA_TSX",
          currency: "CAD",
          sourceKind: "HISTORICAL_REPLAY",
          cohort,
          fill: "FILLED",
          outcomeOffsetMinutes: 5,
        });
        const evidence = new FundedDecisionEvidenceRepository(pool);
        const draft = (
          sourceFactId: string | null | undefined,
          suffix: string,
        ) => ({
          runId: run.runId,
          observationId,
          status: "FILLED" as const,
          availableAt: "2025-12-08T14:35:00.000Z",
          sourceKind: "HISTORICAL_REPLAY" as const,
          sourceId: `ledger:${observationId}:${suffix}`,
          reason: null,
          detail: {
            filledFraction: 1,
            filledShares: 100,
            requestedShares: 100,
            averagePrice: 10.02,
            fees: 1,
            slippage: 0.02,
          },
          supersedesSequence: null,
          sourceFactId,
        });
        // A missing source stays unavailable instead of being rejected: the
        // version is persisted without a boundary.
        const missing = await evidence.appendOutcomeVersion(
          draft(undefined, "missing"),
        );
        expect(missing.sourceFactId).toBeNull();
        // A fabricated source is not durable.
        await expect(
          evidence.appendOutcomeVersion(draft(randomUUID(), "fabricated")),
        ).rejects.toThrow(/not durable/i);
        // An unprocessed (pending) fact is not a provable cause.
        await pool.query(
          `INSERT INTO paper_funded_fact(
             run_id,fact_id,fact_at,priority,sort_key,fact,economic_key)
           VALUES($1,'pending-source','2025-12-08T14:40:00.000Z',1,'pending-source',
                  '{}'::jsonb,'pending-source')`,
          [run.runId],
        );
        await expect(
          evidence.appendOutcomeVersion(draft("pending-source", "pending")),
        ).rejects.toThrow(/not processed/i);
        // A refused LATE fact is not a provable cause.
        await pool.query(
          `INSERT INTO paper_funded_fact(
             run_id,fact_id,fact_at,priority,sort_key,fact,economic_key,outcome)
           VALUES($1,'late-source','2025-12-08T14:41:00.000Z',1,'late-source',
                  '{}'::jsonb,'late-source','{"status":"LATE_FACT"}'::jsonb)`,
          [run.runId],
        );
        await expect(
          evidence.appendOutcomeVersion(draft("late-source", "late")),
        ).rejects.toThrow(/refused or unknown/i);
        // A fact from another run is not this run's cause even when it is
        // processed and sequenced: ownership is proven by the composite key.
        const other = await seedRun({
          marketId: "CA_TSX",
          currency: "CAD",
          sessionDate: "2025-12-09",
          source: "BACKTEST",
          sourceKind: "HISTORICAL_REPLAY",
        });
        await pool.query(
          `INSERT INTO paper_funded_fact(
             run_id,fact_id,fact_at,priority,sort_key,fact,economic_key,outcome)
           VALUES($1,'other-run-fact','2025-12-09T14:40:00.000Z',1,'other-run-fact',
                  '{}'::jsonb,'other-run-fact','{"status":"APPLIED"}'::jsonb)`,
          [other.runId],
        );
        await expect(
          evidence.appendOutcomeVersion(draft("other-run-fact", "cross-run")),
        ).rejects.toThrow(/not durable/i);
        // A caller cannot supply the boundary columns directly.
        await expect(
          pool.query(
            `INSERT INTO funded_decision_outcome(
               run_id,observation_id,sequence,status,source_kind,source_id,source_digest,
               available_at,recorded_at,knowledge_applied_sequence,knowledge_at)
             VALUES($1,$2,3,'FILLED','HISTORICAL_REPLAY','fabricated-boundary',$3,
                    '2025-12-08T14:35:00.000Z',now(),1,now())`,
            [run.runId, observationId, digestOf("fabricated-boundary")],
          ),
        ).rejects.toThrow(/database-owned/i);
      }, 180_000);

      it("refuses direct counter/frontier changes and processed-fact mutation or deletion", async () => {
        const run = await seedRun({
          marketId: "CA_TSX",
          currency: "CAD",
          sessionDate: "2025-12-10",
          source: "LIVE",
          sourceKind: "LIVE_PAPER",
        });
        const other = await seedRun({
          marketId: "CA_TSX",
          currency: "CAD",
          sessionDate: "2025-12-11",
          source: "LIVE",
          sourceKind: "LIVE_PAPER",
        });
        await pool.query(
          `INSERT INTO paper_funded_fact(
             run_id,fact_id,fact_at,priority,sort_key,fact,economic_key,outcome,processed_at)
           VALUES($1,'processed','2025-12-10T14:30:00.000Z',2,'processed',
                  '{}'::jsonb,'processed','{"status":"APPLIED"}'::jsonb,now())`,
          [run.runId],
        );
        await pool.query(
          `INSERT INTO paper_funded_fact(
             run_id,fact_id,fact_at,priority,sort_key,fact,economic_key)
           VALUES($1,'pending-a','2025-12-10T14:40:00.000Z',2,'pending-a','{}'::jsonb,'pending-a'),
                 ($1,'pending-b','2025-12-10T14:41:00.000Z',2,'pending-b','{}'::jsonb,'pending-b')`,
          [run.runId],
        );
        const processed = await pool.query<{
          applied_sequence: string;
          applied_frontier_at: Date;
        }>(
          `SELECT applied_sequence,applied_frontier_at FROM paper_funded_fact
            WHERE run_id=$1 AND fact_id='processed'`,
          [run.runId],
        );
        expect(Number(processed.rows[0]!.applied_sequence)).toBe(1);
        expect(processed.rows[0]!.applied_frontier_at.toISOString()).toBe(
          "2025-12-10T14:30:00.000Z",
        );

        // The run counter and frontier are database-internal: a direct caller
        // cannot advance or clear them in either direction.
        for (const mutation of [
          "SET applied_sequence_counter=applied_sequence_counter+1",
          "SET applied_sequence_counter=0",
          "SET applied_frontier_at=now()",
        ])
          await expect(
            pool.query(`UPDATE paper_funded_run ${mutation} WHERE run_id=$1`, [
              run.runId,
            ]),
          ).rejects.toThrow(/database-internal/i);

        // Even moving a processed fact to another run is refused.
        await expect(
          pool.query(
            "UPDATE paper_funded_fact SET run_id=$2 WHERE run_id=$1 AND fact_id='processed'",
            [run.runId, other.runId],
          ),
        ).rejects.toThrow(/immutable/i);
        // Every other causal field of a processed fact is immutable.
        for (const mutation of [
          "SET fact_id='renamed'",
          "SET fact_at=fact_at+interval '1 hour'",
          "SET priority=0",
          "SET sort_key='changed'",
          "SET fact='{\"changed\":true}'::jsonb",
          "SET economic_key='changed'",
          'SET outcome=\'{"status":"LATE_FACT"}\'::jsonb',
          "SET processed_at=now()",
          "SET applied_sequence=applied_sequence+1",
          "SET applied_sequence=NULL",
          "SET applied_frontier_at=now()",
        ])
          await expect(
            pool.query(
              `UPDATE paper_funded_fact ${mutation}
                WHERE run_id=$1 AND fact_id='processed'`,
              [run.runId],
            ),
          ).rejects.toThrow(/immutable/i);
        await expect(
          pool.query(
            "DELETE FROM paper_funded_fact WHERE run_id=$1 AND fact_id='processed'",
            [run.runId],
          ),
        ).rejects.toThrow(/immutable/i);

        // Pending facts may still transition to processed and be removed while
        // they remain unprocessed.
        await pool.query(
          `UPDATE paper_funded_fact SET outcome='{"status":"APPLIED"}'::jsonb,
             processed_at=now()
            WHERE run_id=$1 AND fact_id='pending-a'`,
          [run.runId],
        );
        const pendingASequence = await pool.query<{
          applied_sequence: string;
        }>(
          `SELECT applied_sequence FROM paper_funded_fact
            WHERE run_id=$1 AND fact_id='pending-a'`,
          [run.runId],
        );
        expect(Number(pendingASequence.rows[0]!.applied_sequence)).toBe(2);
        await pool.query(
          "DELETE FROM paper_funded_fact WHERE run_id=$1 AND fact_id='pending-b'",
          [run.runId],
        );
        await expect(
          pool.query(
            "DELETE FROM paper_funded_fact WHERE run_id=$1 AND fact_id='pending-a'",
            [run.runId],
          ),
        ).rejects.toThrow(/immutable/i);
      }, 180_000);

      it("fails training closed on corrupt replay chronology", async () => {
        const store = new PostgresFundedExecutionTrainingStore(pool);
        const cutoff = new Date(Date.now() + 60_000);
        async function seedReplayPair(sessionDate: string, suffix: string) {
          const cohort = cohortFor({
            marketId: "CA_TSX",
            currency: "CAD",
            sourceKind: "HISTORICAL_REPLAY",
            fundedPolicyVersion: `funded-policy-corrupt-${suffix}`,
          });
          const run = await seedRun({
            marketId: "CA_TSX",
            currency: "CAD",
            sessionDate,
            source: "BACKTEST",
            sourceKind: "HISTORICAL_REPLAY",
          });
          const instrumentId = await insertInstrument("CA_TSX");
          const observationIds: string[] = [];
          for (const index of [0, 1])
            observationIds.push(
              await seedDecision({
                runId: run.runId,
                sessionDate,
                index,
                instrumentId,
                marketId: "CA_TSX",
                currency: "CAD",
                sourceKind: "HISTORICAL_REPLAY",
                cohort,
                fill: "FILLED",
                outcomeOffsetMinutes: 5 + index,
              }),
            );
          return {
            cohort,
            runId: run.runId,
            observationId: observationIds[0]!,
          };
        }
        async function expectUnproven(
          cohort: FundedCohortIdentity,
          observationId: string,
        ) {
          const rows = await store.assembledRowsFor(
            cohort.cohortDigest,
            cutoff,
          );
          const row = rows.find(
            (entry) => entry.observationId === observationId,
          );
          expect(row?.verdict).toBe("EXCLUDED");
          expect(row?.exclusionReason).toBe("REPLAY_CHRONOLOGY_UNPROVEN");
        }

        // Baseline: a complete chronology yields an included label.
        const baseline = await seedReplayPair("2025-12-12", "baseline");
        const baselineRows = await store.assembledRowsFor(
          baseline.cohort.cohortDigest,
          cutoff,
        );
        expect(
          baselineRows.find(
            (row) => row.observationId === baseline.observationId,
          )?.verdict,
        ).toBe("INCLUDED");

        // Counter mismatch.
        const counterCase = await seedReplayPair("2025-12-13", "counter");
        await pool.query(
          "ALTER TABLE paper_funded_run DISABLE TRIGGER paper_funded_run_applied_sequence_counter_guard",
        );
        await pool.query(
          `UPDATE paper_funded_run
              SET applied_sequence_counter=applied_sequence_counter+1
            WHERE run_id=$1`,
          [counterCase.runId],
        );
        await pool.query(
          "ALTER TABLE paper_funded_run ENABLE TRIGGER paper_funded_run_applied_sequence_counter_guard",
        );
        await expectUnproven(counterCase.cohort, counterCase.observationId);

        // Stored frontier disagreement.
        const frontierCase = await seedReplayPair("2025-12-14", "frontier");
        await pool.query(
          `ALTER TABLE paper_funded_fact
             DISABLE TRIGGER paper_funded_fact_processed_guard;
           ALTER TABLE paper_funded_fact
             DISABLE TRIGGER paper_funded_fact_applied_sequence`,
        );
        try {
          await pool.query(
            `UPDATE paper_funded_fact SET applied_frontier_at='2000-01-01T00:00:00Z'
              WHERE run_id=$1 AND applied_sequence=2`,
            [frontierCase.runId],
          );
        } finally {
          await pool.query(
            `ALTER TABLE paper_funded_fact
               ENABLE TRIGGER paper_funded_fact_processed_guard;
             ALTER TABLE paper_funded_fact
               ENABLE TRIGGER paper_funded_fact_applied_sequence`,
          );
        }
        await expectUnproven(frontierCase.cohort, frontierCase.observationId);

        // Sequence gap.
        const gapCase = await seedReplayPair("2025-12-15", "gap");
        await pool.query(
          `ALTER TABLE paper_funded_fact
             DISABLE TRIGGER paper_funded_fact_processed_guard;
           ALTER TABLE paper_funded_fact
             DISABLE TRIGGER paper_funded_fact_applied_sequence`,
        );
        try {
          await pool.query(
            `UPDATE paper_funded_fact SET applied_sequence=3
              WHERE run_id=$1 AND applied_sequence=2`,
            [gapCase.runId],
          );
        } finally {
          await pool.query(
            `ALTER TABLE paper_funded_fact
               ENABLE TRIGGER paper_funded_fact_processed_guard;
             ALTER TABLE paper_funded_fact
               ENABLE TRIGGER paper_funded_fact_applied_sequence`,
          );
        }
        await expectUnproven(gapCase.cohort, gapCase.observationId);

        // Missing rows against the durable counter.
        const missingCase = await seedReplayPair("2025-12-16", "missing");
        const missingDecision = await pool.query<{ observation_id: string }>(
          `SELECT observation_id FROM funded_decision_evidence
            WHERE run_id=$1 ORDER BY sequence DESC LIMIT 1`,
          [missingCase.runId],
        );
        const removedObservationId = missingDecision.rows[0]!.observation_id;
        await pool.query(
          `ALTER TABLE paper_funded_fact
             DISABLE TRIGGER paper_funded_fact_processed_guard;
           ALTER TABLE funded_decision_outcome
             DISABLE TRIGGER funded_decision_outcome_immutable`,
        );
        try {
          await pool.query(
            `DELETE FROM funded_decision_outcome
              WHERE run_id=$1 AND observation_id=$2`,
            [missingCase.runId, removedObservationId],
          );
          await pool.query(
            `DELETE FROM paper_funded_fact
              WHERE run_id=$1 AND fact_id='funded-signal:'||$2::text`,
            [missingCase.runId, removedObservationId],
          );
        } finally {
          await pool.query(
            `ALTER TABLE paper_funded_fact
               ENABLE TRIGGER paper_funded_fact_processed_guard;
             ALTER TABLE funded_decision_outcome
               ENABLE TRIGGER funded_decision_outcome_immutable`,
          );
        }
        await expectUnproven(missingCase.cohort, missingCase.observationId);
      }, 300_000);

      it("binds terminality to the exact same-time causal fact", async () => {
        const cohort = cohortFor({
          marketId: "CA_TSX",
          currency: "CAD",
          sourceKind: "HISTORICAL_REPLAY",
          fundedPolicyVersion: "funded-policy-terminality-causal",
        });
        const run = await seedRun({
          marketId: "CA_TSX",
          currency: "CAD",
          sessionDate: "2025-12-17",
          source: "BACKTEST",
          sourceKind: "HISTORICAL_REPLAY",
        });
        const instrumentId = await insertInstrument("CA_TSX");
        const observationId = await seedDecision({
          runId: run.runId,
          sessionDate: "2025-12-17",
          index: 0,
          instrumentId,
          marketId: "CA_TSX",
          currency: "CAD",
          sourceKind: "HISTORICAL_REPLAY",
          cohort,
          fill: "NONE",
          outcomeOffsetMinutes: 0,
        });
        // Two facts share one timestamp. The clock sorts first, so exact
        // provenance resolves the revision to the lower sequence even though
        // timestamp inference would pick the last same-time point.
        await pool.query(
          `INSERT INTO paper_funded_fact(
             run_id,fact_id,fact_at,priority,sort_key,fact,economic_key,outcome)
           VALUES($1,'same-time-clock','2025-12-17T14:35:00.000Z',1,'clock',
                  '{}'::jsonb,'same-time-clock','{"status":"APPLIED"}'::jsonb),
                 ($1,'same-time-quote','2025-12-17T14:35:00.000Z',3,'quote',
                  '{}'::jsonb,'same-time-quote','{"status":"APPLIED"}'::jsonb)`,
          [run.runId],
        );
        const sequences = await pool.query<{
          fact_id: string;
          applied_sequence: string;
        }>(
          `SELECT fact_id,applied_sequence FROM paper_funded_fact
            WHERE run_id=$1 ORDER BY applied_sequence`,
          [run.runId],
        );
        const clockSequence = Number(
          sequences.rows.find((row) => row.fact_id === "same-time-clock")!
            .applied_sequence,
        );
        const quoteSequence = Number(
          sequences.rows.find((row) => row.fact_id === "same-time-quote")!
            .applied_sequence,
        );
        expect(clockSequence).toBeLessThan(quoteSequence);
        const terminalState = {
          orderId: observationId,
          version: "pending-entry-v1",
          status: "CANCELLED",
          reason: "EXPIRED",
          lastQuoteAt: "2025-12-17T14:35:00.000Z",
          execution: null,
        };
        // The revision was caused by the clock fact, not the later same-time
        // quote.
        await pool.query(
          `INSERT INTO paper_entry_order(
             order_id,run_id,instrument_id,submission,state,revision,last_fact_at,last_fact_id,updated_at)
           VALUES($1,$2,$3,'{}'::jsonb,$4::jsonb,0,$5,'same-time-clock',$5)`,
          [
            observationId,
            run.runId,
            instrumentId,
            JSON.stringify(terminalState),
            "2025-12-17T14:35:00.000Z",
          ],
        );
        await pool.query(
          `INSERT INTO funded_decision_outcome(
             run_id,observation_id,sequence,status,source_kind,source_id,source_digest,
             available_at,recorded_at,detail,source_fact_id)
           VALUES($1,$2,1,'PARTIAL_FILL','HISTORICAL_REPLAY',$3,$4,$5,$5,$6::jsonb,$7)`,
          [
            run.runId,
            observationId,
            `ledger:${observationId}:partial`,
            digestOf(`${observationId}:partial`),
            "2025-12-17T14:35:00.000Z",
            JSON.stringify({
              filledFraction: 0.5,
              filledShares: 50,
              requestedShares: 100,
              averagePrice: 10.02,
              fees: 0.5,
              slippage: 0.01,
            }),
            `funded-signal:${observationId}`,
          ],
        );
        const store = new PostgresFundedExecutionTrainingStore(pool);
        const rows = await store.assembledRowsFor(
          cohort.cohortDigest,
          new Date(Date.now() + 60_000),
        );
        const row = rows.find((entry) => entry.observationId === observationId);
        expect(row?.verdict).toBe("INCLUDED");
        expect(row?.labels?.terminalOutcomeStatus).toBe("PARTIAL_FILL");
        // The exact terminality sequence is the clock's, combined by applied
        // order with the outcome version's sequence.
        expect(row?.labels?.knowledge).toEqual({
          provenance: "HISTORICAL_REPLAY_FACT_SEQUENCE",
          runId: run.runId,
          sequence: clockSequence,
          at: "2025-12-17T14:35:00.000Z",
        });
        expect(row?.labels?.knowledge.sequence).not.toBe(quoteSequence);
      }, 180_000);

      it("fails closed on unacknowledged or missing terminality causal facts", async () => {
        const cohort = cohortFor({
          marketId: "CA_TSX",
          currency: "CAD",
          sourceKind: "HISTORICAL_REPLAY",
          fundedPolicyVersion: "funded-policy-terminality-missing",
        });
        const run = await seedRun({
          marketId: "CA_TSX",
          currency: "CAD",
          sessionDate: "2025-12-18",
          source: "BACKTEST",
          sourceKind: "HISTORICAL_REPLAY",
        });
        const instrumentId = await insertInstrument("CA_TSX");
        const observationIds: string[] = [];
        for (const index of [0, 1])
          observationIds.push(
            await seedDecision({
              runId: run.runId,
              sessionDate: "2025-12-18",
              index,
              instrumentId,
              marketId: "CA_TSX",
              currency: "CAD",
              sourceKind: "HISTORICAL_REPLAY",
              cohort,
              fill: "NONE",
              outcomeOffsetMinutes: 0,
            }),
          );
        // An unacknowledged (pending) fact is retained as the revision cause
        // but cannot prove terminality.
        await pool.query(
          `INSERT INTO paper_funded_fact(
             run_id,fact_id,fact_at,priority,sort_key,fact,economic_key)
           VALUES($1,'pending-terminality','2025-12-18T14:05:00.000Z',1,'pending',
                  '{}'::jsonb,'pending-terminality')`,
          [run.runId],
        );
        const terminalState = (orderId: string) => ({
          orderId,
          version: "pending-entry-v1",
          status: "CANCELLED",
          reason: "EXPIRED",
          lastQuoteAt: "2025-12-18T14:05:00.000Z",
          execution: null,
        });
        // Observation 0: revision caused by the pending fact.
        await pool.query(
          `INSERT INTO paper_entry_order(
             order_id,run_id,instrument_id,submission,state,revision,last_fact_at,last_fact_id,updated_at)
           VALUES($1,$2,$3,'{}'::jsonb,$4::jsonb,0,$5,'pending-terminality',$5)`,
          [
            observationIds[0],
            run.runId,
            instrumentId,
            JSON.stringify(terminalState(observationIds[0]!)),
            "2025-12-18T14:05:00.000Z",
          ],
        );
        // Observation 1: revision with no causal fact identity at all.
        await pool.query(
          `INSERT INTO paper_entry_order(
             order_id,run_id,instrument_id,submission,state,revision,last_fact_at,updated_at)
           VALUES($1,$2,$3,'{}'::jsonb,$4::jsonb,0,$5,$5)`,
          [
            observationIds[1],
            run.runId,
            instrumentId,
            JSON.stringify(terminalState(observationIds[1]!)),
            "2025-12-18T14:05:00.000Z",
          ],
        );
        for (const [index, observationId] of observationIds.entries())
          await pool.query(
            `INSERT INTO funded_decision_outcome(
               run_id,observation_id,sequence,status,source_kind,source_id,source_digest,
               available_at,recorded_at,detail,source_fact_id)
             VALUES($1,$2,1,'PARTIAL_FILL','HISTORICAL_REPLAY',$3,$4,$5,$5,$6::jsonb,$7)`,
            [
              run.runId,
              observationId,
              `ledger:${observationId}:partial`,
              digestOf(`${observationId}:partial-${index}`),
              "2025-12-18T14:05:00.000Z",
              JSON.stringify({
                filledFraction: 0.5,
                filledShares: 50,
                requestedShares: 100,
                averagePrice: 10.02,
                fees: 0.5,
                slippage: 0.01,
              }),
              `funded-signal:${observationId}`,
            ],
          );
        const store = new PostgresFundedExecutionTrainingStore(pool);
        const rows = await store.assembledRowsFor(
          cohort.cohortDigest,
          new Date(Date.now() + 60_000),
        );
        for (const observationId of observationIds) {
          const row = rows.find(
            (entry) => entry.observationId === observationId,
          );
          expect(row?.verdict).toBe("EXCLUDED");
          expect(row?.exclusionReason).toBe("REPLAY_CHRONOLOGY_UNPROVEN");
        }
      }, 180_000);

      it("rejects persisted members whose source kind contradicts their knowledge provenance", async () => {
        const store = new PostgresFundedExecutionTrainingStore(pool);
        const baseLabels = {
          fillProbability: 1,
          fillFraction: 1,
          slippagePerShare: 0.01,
          totalExecutionCost: 1,
          labelAvailableAt: "2025-12-06T14:40:00.000Z",
          economicOutcomeAt: "2025-12-06T14:35:00.000Z",
          terminalityProof: null,
          terminalOutcomeStatus: "FILLED",
          terminalOutcomeSequence: 1,
          terminalOutcomeSourceDigest: digestOf("member-binding"),
          fillLabelAvailable: true,
          costLabelAvailable: true,
        };
        async function mismatchedMemberId(input: {
          sessionDate: string;
          source: "LIVE" | "BACKTEST";
          sourceKind: "LIVE_PAPER" | "HISTORICAL_REPLAY";
          knowledge: Record<string, unknown>;
        }): Promise<string> {
          const run = await seedRun({
            marketId: "CA_TSX",
            currency: "CAD",
            sessionDate: input.sessionDate,
            source: input.source,
            sourceKind: input.sourceKind,
          });
          const instrumentId = await insertInstrument("CA_TSX");
          const cohort = cohortFor({
            marketId: "CA_TSX",
            currency: "CAD",
            sourceKind: input.sourceKind,
            fundedPolicyVersion: `funded-policy-member-binding-${input.sessionDate}`,
          });
          const observationId = await seedDecision({
            runId: run.runId,
            sessionDate: input.sessionDate,
            index: 0,
            instrumentId,
            marketId: "CA_TSX",
            currency: "CAD",
            sourceKind: input.sourceKind,
            cohort,
            fill: "FILLED",
            outcomeOffsetMinutes: 5,
          });
          const decision = (
            await pool.query<{
              account_id: string;
              sequence: number;
              content_digest: string;
              decision_at: Date;
            }>(
              `SELECT account_id,sequence,content_digest,decision_at
                 FROM funded_decision_evidence WHERE run_id=$1 AND observation_id=$2`,
              [run.runId, observationId],
            )
          ).rows[0]!;
          const datasetId = randomUUID();
          await pool.query(
            `INSERT INTO funded_execution_dataset(
               id,market_id,currency,source_kind,evidence_schema_version,cohort_digest,cohort_components,
               dataset_policy_version,label_mapping_version,feature_version,qualification_policy_version,
               requested_cutoff,effective_cutoff,membership_digest,dataset_digest,row_count,counts,
               qualification_receipt,source_watermark,activation_eligible)
             VALUES($1,'CA_TSX','CAD',$2,2,$3,'{}'::jsonb,'funded-execution-dataset-v1',
                    'funded-execution-labels-v1','funded-execution-features-v1',
                    'funded-execution-qualification-v1',now(),now(),$4,$5,1,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,false)`,
            [
              datasetId,
              input.sourceKind,
              digestOf(`member-binding-cohort:${datasetId}`),
              digestOf(`member-binding-membership:${datasetId}`),
              digestOf(`member-binding-dataset:${datasetId}`),
            ],
          );
          await pool.query(
            `INSERT INTO funded_execution_dataset_member(
               dataset_id,ordinal,market_id,currency,run_id,observation_id,account_id,decision_sequence,
               decision_content_digest,cohort_digest,evidence_schema_version,decision_at,session_date,
               partition,label_available_at,label_economic_at,source_kind,label_mapping_version,
               feature_version,features,labels,outcome_sequences,outcome_source_digests,row_digest)
             VALUES($1,0,'CA_TSX','CAD',$2,$3,$4,$5,$6,$7,2,$8,$9,'TRAIN',$10,$11,$12,
                    'funded-execution-labels-v1','funded-execution-features-v1','{}'::jsonb,$13::jsonb,
                    ARRAY[1],ARRAY[$6]::text[],$14)`,
            [
              datasetId,
              run.runId,
              observationId,
              decision.account_id,
              decision.sequence,
              decision.content_digest,
              digestOf(`member-binding-cohort:${datasetId}`),
              decision.decision_at,
              input.sessionDate,
              baseLabels.labelAvailableAt,
              baseLabels.economicOutcomeAt,
              input.sourceKind,
              JSON.stringify({ ...baseLabels, knowledge: input.knowledge }),
              digestOf(`member-binding-row:${datasetId}`),
            ],
          );
          return datasetId;
        }
        // LIVE_PAPER must not carry a replay coordinate.
        const liveDataset = await mismatchedMemberId({
          sessionDate: "2025-12-06",
          source: "LIVE",
          sourceKind: "LIVE_PAPER",
          knowledge: {
            provenance: "HISTORICAL_REPLAY_FACT_SEQUENCE",
            runId: "some-run",
            sequence: 1,
            at: "2025-12-06T14:40:00.000Z",
          },
        });
        await expect(store.listDatasetMembers(liveDataset)).rejects.toThrow();
        // HISTORICAL_REPLAY must not use database capture.
        const replayDataset = await mismatchedMemberId({
          sessionDate: "2025-12-07",
          source: "BACKTEST",
          sourceKind: "HISTORICAL_REPLAY",
          knowledge: {
            provenance: "DATABASE_CAPTURE",
            runId: null,
            sequence: null,
            at: "2025-12-07T14:40:00.000Z",
          },
        });
        await expect(store.listDatasetMembers(replayDataset)).rejects.toThrow();
      }, 180_000);

      it("rejects caller-supplied order-history time, revision, fact time and state", async () => {
        const run = await seedRun({
          marketId: "CA_TSX",
          currency: "CAD",
          sessionDate: "2025-12-05",
          source: "LIVE",
          sourceKind: "LIVE_PAPER",
        });
        const instrumentId = await insertInstrument("CA_TSX");
        const orderId = randomUUID();
        const factAt = "2025-12-05T14:40:00.000Z";
        const state = {
          orderId,
          version: "pending-entry-v1",
          status: "CANCELLED",
          reason: "EXPIRED",
          lastQuoteAt: factAt,
          execution: null,
        };
        await pool.query(
          `INSERT INTO paper_entry_order(order_id,run_id,instrument_id,submission,state,revision,last_fact_at,updated_at)
           VALUES($1,$2,$3,'{}'::jsonb,$4::jsonb,0,$5,$5)`,
          [orderId, run.runId, instrumentId, JSON.stringify(state), factAt],
        );
        const captured = await pool.query<{ recorded_at: Date | null }>(
          `SELECT recorded_at FROM paper_entry_order_history
            WHERE order_id=$1 AND revision=0`,
          [orderId],
        );
        expect(captured.rows).toHaveLength(1);
        expect(captured.rows[0]!.recorded_at).not.toBeNull();

        // The production capture path is the only source of a proof; a direct
        // insert cannot supply a recording time.
        await expect(
          pool.query(
            `INSERT INTO paper_entry_order_history(order_id,revision,fact_at,state,recorded_at)
             VALUES($1,0,$2,$3::jsonb,'2001-01-01T00:00:00.000Z')`,
            [orderId, factAt, JSON.stringify(state)],
          ),
        ).rejects.toThrow(/database-owned/i);
        // Neither a fabricated higher revision nor a backdated fact time nor a
        // rewritten state may be inserted.
        for (const fabricated of [
          {
            revision: 1,
            factAt,
            state,
          },
          {
            revision: 0,
            factAt: "2001-01-01T00:00:00.000Z",
            state,
          },
          {
            revision: 0,
            factAt,
            state: { ...state, status: "FILLED" },
          },
        ])
          await expect(
            pool.query(
              `INSERT INTO paper_entry_order_history(order_id,revision,fact_at,state)
               VALUES($1,$2,$3,$4::jsonb)`,
              [
                orderId,
                fabricated.revision,
                fabricated.factAt,
                JSON.stringify(fabricated.state),
              ],
            ),
          ).rejects.toThrow(/current locked order revision/i);
        // A higher revision becomes current through the production path, after
        // which the earlier revision cannot be re-inserted either.
        await pool.query(
          `UPDATE paper_entry_order
              SET state=$2::jsonb,last_fact_at=$3::timestamptz,
                  revision=revision+1,updated_at=now()
            WHERE order_id=$1`,
          [
            orderId,
            JSON.stringify({ ...state, status: "PENDING", reason: null }),
            "2025-12-05T14:50:00.000Z",
          ],
        );
        await expect(
          pool.query(
            `INSERT INTO paper_entry_order_history(order_id,revision,fact_at,state)
             VALUES($1,0,$2,$3::jsonb)`,
            [orderId, factAt, JSON.stringify(state)],
          ),
        ).rejects.toThrow(/current locked order revision/i);
        await expect(
          pool.query(
            "UPDATE paper_entry_order_history SET recorded_at=now() WHERE order_id=$1",
            [orderId],
          ),
        ).rejects.toThrow(/immutable/i);
        await expect(
          pool.query(
            "DELETE FROM paper_entry_order_history WHERE order_id=$1",
            [orderId],
          ),
        ).rejects.toThrow(/immutable/i);
      }, 120_000);
    });

    function withoutDigest(
      cohort: FundedCohortIdentity,
    ): Record<string, unknown> {
      const components = { ...cohort } as Record<string, unknown>;
      delete components.cohortDigest;
      return components;
    }
  },
);
