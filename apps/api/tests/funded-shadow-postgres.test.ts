import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FUNDED_EXECUTION_FEATURE_VERSION,
  fundedShadowAttemptResultSchema,
  fundedShadowLabelSchema,
  fundedShadowGatePolicySchema,
  type FundedShadowEnrollment,
} from "@tsx-scanner/contracts";
import { migrate } from "../src/database/migrate.js";
import { isolatedDatabaseUrl } from "./isolated-database.js";
import { PostgresPaperBotStore } from "../src/paper-bot/paper-bot-repository.js";
import { PostgresFundedLedgerStore } from "../src/paper-bot/funded-ledger-repository.js";
import { FundedOrderService } from "../src/paper-bot/funded-order-service.js";
import { fundedPolicy } from "../src/paper-bot/funded-policy.js";
import { resolveFundedComparisonChampion } from "../src/paper-bot/funded-comparison-champion.js";
import { decisionContentDigest } from "../src/paper-bot/funded-evidence-digest.js";
import { PostgresFundedShadowStore } from "../src/statistical-models/funded-shadow-repository.js";
import { FundedShadowObserver } from "../src/statistical-models/funded-shadow-observer.js";
import { FundedShadowReportingService } from "../src/statistical-models/funded-shadow-reporting.js";
import {
  buildFundedShadowGatePolicy,
  fundedShadowChallengerPolicyIdentity,
  loadFundedShadowChallengerById,
} from "../src/statistical-models/funded-shadow-gate-policy.js";
import {
  FundedExecutionPredictionService,
  PostgresFundedExecutionPredictionStore,
} from "../src/statistical-models/funded-execution-prediction.js";
import {
  contentHash,
  fundedExecutionArtifactDigest,
  fundedExecutionTrainingPartitionDigest,
} from "../src/statistical-models/funded-execution-digest.js";
import {
  shadowArtifact,
  shadowDecisionContent,
  shadowGatePolicyDraft,
  shadowPredictionOutput,
} from "./funded-shadow-fixtures.js";

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
  "funded shadow observation on isolated PostgreSQL",
  () => {
    let pool: Pool;
    let botStore: PostgresPaperBotStore;
    let ledger: PostgresFundedLedgerStore;
    let shadow: PostgresFundedShadowStore;
    let reporting: FundedShadowReportingService;
    let predictions: FundedExecutionPredictionService;
    let profileId: string;
    let configId: string;
    let definitionId: string;

    beforeAll(async () => {
      pool = new Pool({ connectionString: databaseUrl, max: 8 });
      await migrate(pool);
      await pool.query(
        `TRUNCATE
           funded_shadow_observer_event,
           funded_shadow_report,
           funded_shadow_label,
           funded_shadow_batch_projection,
           funded_shadow_attempt_result,
           funded_shadow_batch_member,
           funded_shadow_attempt,
           funded_shadow_batch,
           funded_shadow_enrollment_transition,
           funded_shadow_enrollment,
           funded_shadow_gate_policy,
           funded_execution_prediction,
           funded_execution_challenger,
           funded_execution_dataset_member,
           funded_execution_dataset,
           funded_decision_outcome,
           funded_decision_intent,
           funded_decision_refusal,
           funded_decision_evidence,
           paper_execution,
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
      shadow = new PostgresFundedShadowStore(pool);
      reporting = new FundedShadowReportingService(shadow);
      predictions = new FundedExecutionPredictionService(
        new PostgresFundedExecutionPredictionStore(pool),
      );
      definitionId = randomUUID();
      profileId = randomUUID();
      configId = randomUUID();
      await pool.query(
        `INSERT INTO strategy_definition(id,strategy_key,version,name,description)
         VALUES($1,$2,'2026-09-01','FP04','FP04 integration')`,
        [definitionId, `FP04_${definitionId.slice(0, 8)}`],
      );
      await pool.query(
        `INSERT INTO scanner_profile(id,name,strategy_definition_id,enabled,display_order)
         VALUES($1,$2,$3,true,0)`,
        [profileId, `fp04-${profileId.slice(0, 8)}`, definitionId],
      );
      await pool.query(
        `INSERT INTO scanner_profile_config(id,profile_id,config_version,parameters)
         VALUES($1,$2,$3,'{}'::jsonb)`,
        [configId, profileId, `fp04-${configId.slice(0, 8)}`],
      );
    }, 180_000);

    afterAll(async () => {
      await pool?.end();
    });

    async function insertInstrument() {
      const instrumentId = randomUUID();
      await pool.query(
        `INSERT INTO instrument(id,questrade_symbol_id,symbol,description,exchange,currency,
         security_type,industry_sector,is_quotable,is_tradable,active,market_id)
         VALUES($1,$2,$3,'FP04 integration','TSX','CAD','Stock','Technology',true,true,true,'CA_TSX')`,
        [
          instrumentId,
          Math.floor(Math.random() * 1_000_000_000) + 1_000_000_000,
          `FP04_${instrumentId.slice(0, 8)}`,
        ],
      );
      return instrumentId;
    }

    async function seedRun(input: {
      sessionDate: string;
      complete?: boolean;
      source?: "LIVE" | "BACKTEST";
    }) {
      const accountId = randomUUID();
      const startAt = `${input.sessionDate}T13:55:00.000Z`;
      const run = await botStore.startOrResumeLiveRun({
        source: input.source ?? "LIVE",
        marketId: "CA_TSX",
        sessionDate: input.sessionDate,
        sessionTimezone: "America/Toronto",
        scheduledCloseAt: `${input.sessionDate}T21:00:00.000Z`,
        executionModelVersion: "paper-execution-v3",
        assumptions,
      });
      await ledger.ensure(accountId, [
        "CAD",
        50_000,
        input.sessionDate,
        startAt,
        3_000,
      ]);
      await new FundedOrderService(pool, run.id, accountId, "CAD").bind(
        fundedPolicy(0.25, 0, {}),
        {
          session: input.sessionDate,
          at: startAt,
        },
      );
      if (input.complete)
        await pool.query(
          `UPDATE paper_bot_run SET status='COMPLETED', completed_at=now() WHERE id=$1`,
          [run.id],
        );
      return { runId: run.id, accountId };
    }

    async function insertObservation(input: {
      runId: string;
      instrumentId: string;
      signalAt: string;
      score?: number;
    }) {
      const observation = await botStore.insertObservation({
        runId: input.runId,
        sourceEventId: randomUUID(),
        sourceSignalId: null,
        setupInstanceId: null,
        instrumentId: input.instrumentId,
        symbol: "FP04",
        profileId,
        profileName: "fp04",
        profileConfigId: configId,
        configVersion: "v1",
        profileParameters: { signalValidityMinutes: 60 },
        strategyKey: "ORB_STANDARD",
        strategyVersion: "2026-09-01",
        signalTimestamp: input.signalAt,
        score: input.score ?? 70,
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
      return observation.observation.id;
    }

    async function seedDecision(input: {
      runId: string;
      accountId: string;
      observationId: string;
      sequence: number;
      decisionAt: string;
      cohortDigest: string;
      evidenceSchemaVersion?: number;
      score?: number;
    }) {
      const content = shadowDecisionContent({
        observationId: input.observationId,
        decisionAt: input.decisionAt,
        accountId: input.accountId,
        runId: input.runId,
        score: input.score ?? 70,
      });
      await pool.query(
        `INSERT INTO funded_decision_evidence(
           run_id,observation_id,sequence,market_id,currency,account_id,funded_policy_version,
           execution_model_version,feature_version,source_kind,action,decision_at,captured_at,
           content_digest,decision_content,cohort_digest,cohort_components,evidence_schema_version)
         VALUES($1,$2,$3,'CA_TSX','CAD',$4,'funded-policy-v1','paper-execution-v3','1.2.0',
                'LIVE_PAPER','SUBMIT',$5,clock_timestamp(),$6,$7::jsonb,$8,'{}'::jsonb,$9)`,
        [
          input.runId,
          input.observationId,
          input.sequence,
          input.accountId,
          input.decisionAt,
          decisionContentDigest(content),
          JSON.stringify(content),
          input.cohortDigest,
          input.evidenceSchemaVersion ?? 2,
        ],
      );
    }

    async function seedChallenger() {
      // A completed LIVE training run proves the TRAIN lineage.
      const training = await seedRun({
        sessionDate: "2026-08-31",
        complete: true,
      });
      const instrumentId = await insertInstrument();
      const observationId = await insertObservation({
        runId: training.runId,
        instrumentId,
        signalAt: "2026-08-31T14:30:00.000Z",
      });
      const cohortDigest = "c".repeat(64);
      await seedDecision({
        runId: training.runId,
        accountId: training.accountId,
        observationId,
        sequence: 1,
        decisionAt: "2026-08-31T14:30:00.000Z",
        cohortDigest,
      });
      const rowDigest = contentHash({ row: observationId });
      const partitionDigest = fundedExecutionTrainingPartitionDigest([
        rowDigest,
      ]);
      const artifact = shadowArtifact("b".repeat(64), partitionDigest);
      const artifactDigest = fundedExecutionArtifactDigest(artifact);
      const datasetId = randomUUID();
      const datasetDigest = "b".repeat(64);
      await pool.query(
        `INSERT INTO funded_execution_dataset(
           id,market_id,currency,source_kind,evidence_schema_version,cohort_digest,cohort_components,
           dataset_policy_version,label_mapping_version,feature_version,qualification_policy_version,
           requested_cutoff,effective_cutoff,membership_digest,dataset_digest,row_count,counts,
           qualification_receipt,source_watermark,activation_eligible)
         VALUES($1,'CA_TSX','CAD','LIVE_PAPER',2,$2,'{}'::jsonb,'funded-execution-dataset-v1',
                'funded-execution-labels-v1','funded-execution-features-v1',
                'funded-execution-qualification-v1',$3,$3,$4,$5,1,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,false)`,
        [
          datasetId,
          cohortDigest,
          "2026-09-01T00:00:00.000Z",
          digestOf("membership"),
          datasetDigest,
        ],
      );
      await pool.query(
        `INSERT INTO funded_execution_dataset_member(
           dataset_id,ordinal,market_id,currency,run_id,observation_id,account_id,
           decision_sequence,decision_content_digest,cohort_digest,evidence_schema_version,
           instrument_id,decision_at,session_date,partition,label_available_at,label_economic_at,
           source_kind,label_mapping_version,feature_version,features,labels,
           outcome_sequences,outcome_source_digests,row_digest)
         VALUES($1,0,'CA_TSX','CAD',$2,$3,$4,1,$5,$6,2,$7,'2026-08-31T14:30:00.000Z','2026-08-31',
                'TRAIN','2026-08-31T15:00:00.000Z','2026-08-31T15:00:00.000Z','LIVE_PAPER',
                'funded-execution-labels-v1','funded-execution-features-v1','{}'::jsonb,'{}'::jsonb,
                ARRAY[]::integer[],ARRAY[]::text[],$8)`,
        [
          datasetId,
          training.runId,
          observationId,
          training.accountId,
          digestOf("decision"),
          cohortDigest,
          instrumentId,
          rowDigest,
        ],
      );
      const challenger = await pool.query<{ id: string }>(
        `INSERT INTO funded_execution_challenger(
            market_id,currency,cohort_digest,cohort_components,dataset_id,dataset_digest,
            model_version,model_type,artifact_digest,feature_version,label_mapping_version,
            qualification_policy_version,training_policy_version,training_code_version,
            runtime_fingerprint,status,artifact,metrics,sample_counts,failure_receipt,created_at)
          VALUES('CA_TSX','CAD',$1,'{}'::jsonb,$2,$3,'1','FUNDED_EXECUTION_QUALITY',$4,
                 'funded-execution-features-v1','funded-execution-labels-v1',
                 'funded-execution-qualification-v1','funded-execution-training-v1',
                 'funded-execution-trainer-v1',NULL,'INACTIVE',$5::jsonb,NULL,'{}'::jsonb,NULL,now())
          RETURNING id`,
        [
          cohortDigest,
          datasetId,
          datasetDigest,
          artifactDigest,
          JSON.stringify(artifact),
        ],
      );
      return {
        challengerId: challenger.rows[0]!.id,
        cohortDigest,
        datasetDigest,
        artifactDigest,
      };
    }

    function digestOf(value: string): string {
      return contentHash({ value });
    }

    let challengerFixture:
      Awaited<ReturnType<typeof seedChallenger>> | undefined;

    async function createEnrollment(input: {
      runId: string;
      accountId: string;
    }) {
      challengerFixture ??= await seedChallenger();
      const challenger = challengerFixture;
      const identity = await loadFundedShadowChallengerById(pool, {
        modelId: challenger.challengerId,
        marketId: "CA_TSX",
        currency: "CAD",
      });
      const champion = await resolveFundedComparisonChampion(
        pool,
        "CA_TSX",
        input.accountId,
      );
      const policy = buildFundedShadowGatePolicy({
        marketId: "CA_TSX",
        maxPredictionLagMs: 1_000,
        stageBApproval: {
          approvalRef: "stage-b-fp04-test",
          approvedAt: "2026-09-21T12:00:00.000Z",
          approvedBy: "user",
          mMarket: 12.5,
          referenceSessionCount: 40,
          referenceSessionDigest: digestOf("reference"),
          referenceWindowStart: "2026-07-01",
          referenceWindowEnd: "2026-08-31",
          referenceEvidenceCutoffAt: "2026-09-01T00:00:00.000Z",
        },
      });
      const { gatePolicyDigest: _digest, ...policyDraft } = policy;
      const savedPolicy = await shadow.saveGatePolicy(policyDraft);
      const saved = await shadow.saveEnrollment({
        enrollmentVersion: "funded-shadow-enrollment-v1",
        gatePolicyId: savedPolicy.id,
        marketId: "CA_TSX",
        currency: "CAD",
        sourceKind: "LIVE_PAPER",
        champion: champion.champion,
        challenger: fundedShadowChallengerPolicyIdentity(identity),
        evidenceCutoffAt: identity.training.trainingKnowledgeCutoffAt,
        registrationRequestId: `fp04-test-${randomUUID()}`,
        requestHash: digestOf(randomUUID()),
      });
      return {
        enrollment: saved.enrollment as FundedShadowEnrollment,
        challenger,
      };
    }

    async function fundedTableCounts() {
      const tables = [
        "paper_bot_run",
        "paper_signal_observation",
        "paper_funded_run",
        "paper_funded_account",
        "paper_funded_event",
        "paper_entry_order",
        "funded_decision_evidence",
        "funded_decision_outcome",
      ];
      const counts: Record<string, number> = {};
      for (const table of tables) {
        const result = await pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM ${table}`,
        );
        counts[table] = Number(result.rows[0]!.count);
      }
      return counts;
    }

    it("seals batches, predicts before deadlines, projects, labels and reports", async () => {
      const run = await seedRun({ sessionDate: "2026-09-21" });
      const { enrollment, challenger } = await createEnrollment(run);
      const decisionAt = new Date().toISOString();
      const observationA = await insertObservation({
        runId: run.runId,
        instrumentId: await insertInstrument(),
        signalAt: decisionAt,
      });
      const observationB = await insertObservation({
        runId: run.runId,
        instrumentId: await insertInstrument(),
        signalAt: decisionAt,
      });
      await seedDecision({
        runId: run.runId,
        accountId: run.accountId,
        observationId: observationA,
        sequence: 1,
        decisionAt,
        cohortDigest: challenger.cohortDigest,
        score: 90,
      });
      await seedDecision({
        runId: run.runId,
        accountId: run.accountId,
        observationId: observationB,
        sequence: 2,
        decisionAt,
        cohortDigest: challenger.cohortDigest,
        score: 60,
      });
      const before = await fundedTableCounts();
      const model = {
        modelId: challenger.challengerId,
        modelVersion: "1",
        modelType: "FUNDED_EXECUTION_QUALITY",
        artifactDigest: challenger.artifactDigest,
        cohortDigest: challenger.cohortDigest,
        featureVersion: FUNDED_EXECUTION_FEATURE_VERSION,
      };
      const realObserver = new FundedShadowObserver({
        store: shadow,
        pool,
        engine: {
          predictFundedExecution: async (payload) => {
            const typed = payload as {
              inputs: Array<{
                runId: string;
                observationId: string;
                decisionSequence: number;
                decisionInputDigest: string;
              }>;
            };
            return {
              requestVersion: "funded-execution-inference-v1",
              marketId: "CA_TSX",
              currency: "CAD",
              model,
              predictions: typed.inputs.map((input) => ({
                runId: input.runId,
                observationId: input.observationId,
                decisionSequence: input.decisionSequence,
                decisionInputDigest: input.decisionInputDigest,
                output:
                  input.observationId === observationB
                    ? shadowPredictionOutput(0.99, 0.1)
                    : shadowPredictionOutput(0.5, 2),
                warnings: [],
              })),
              warnings: [],
            };
          },
        },
        predictions,
      });
      const pass = await realObserver.runOnce("CA_TSX");
      expect(pass.enrollments).toBe(1);
      expect(pass.sealedBatches).toBe(1);
      const attempts = await pool.query<{
        id: string;
        observation_id: string;
        deadline_at: Date;
        decision_at: Date;
      }>(
        `SELECT id,observation_id,deadline_at,decision_at FROM funded_shadow_attempt
          WHERE enrollment_id=$1 ORDER BY decision_at, decision_sequence`,
        [enrollment.id],
      );
      expect(attempts.rows).toHaveLength(2);
      expect(
        attempts.rows.every(
          (row) =>
            row.deadline_at.getTime() - row.decision_at.getTime() === 1_000,
        ),
      ).toBe(true);
      const results = await pool.query<{ disposition: string }>(
        `SELECT disposition FROM funded_shadow_attempt_result
          WHERE enrollment_id=$1 ORDER BY attempt_id`,
        [enrollment.id],
      );
      expect(results.rows.map((row) => row.disposition)).toEqual([
        "TIMELY_PREDICTION",
        "TIMELY_PREDICTION",
      ]);
      fundedShadowAttemptResultSchema.parse(
        (
          await pool.query(
            `SELECT * FROM funded_shadow_attempt_result WHERE enrollment_id=$1 LIMIT 1`,
            [enrollment.id],
          )
        ).rows.map((row) => ({
          attemptId: row.attempt_id,
          enrollmentId: row.enrollment_id,
          marketId: row.market_id,
          currency: row.currency,
          disposition: row.disposition,
          predictionId: row.prediction_id,
          predictionDigest: row.prediction_digest,
          failureReason: row.failure_reason,
          recordedAt: (row.recorded_at as Date).toISOString(),
          resultDigest: row.result_digest,
        }))[0],
      );
      // Closure requires the prediction lag and the durable seal grace.
      await new Promise((resolve) => setTimeout(resolve, 5_300));
      await realObserver.runOnce("CA_TSX");
      const projection = await pool.query<{
        batch_disposition: string;
        prediction_coverage: string;
      }>(
        `SELECT batch_disposition,prediction_coverage FROM funded_shadow_batch_projection
          WHERE enrollment_id=$1`,
        [enrollment.id],
      );
      expect(projection.rows).toHaveLength(1);
      expect(projection.rows[0]!.batch_disposition).toBe("CHALLENGER_ORDER");
      expect(Number(projection.rows[0]!.prediction_coverage)).toBe(1);
      // Independent canonical labels: A positive, B permanently unresolved.
      const executionId = randomUUID();
      await pool.query(
        `INSERT INTO paper_execution(
           id,observation_id,model,status,
           entry_price,entry_time,stop_price,target_price,shares,initial_risk,
           exit_price,exit_time,exit_reason,fee,gross_pnl,net_pnl,r_multiple)
         VALUES($1,$2,'QUOTE','CLOSED',
                10.0,now() - interval '2 minutes',9.8,10.6,100,20,
                10.5,now() - interval '1 minute','TARGET',1,50,49,1.5)`,
        [executionId, observationA],
      );
      await pool.query(
        `UPDATE paper_bot_run SET status='COMPLETED', completed_at=now() WHERE id=$1`,
        [run.runId],
      );
      await realObserver.runOnce("CA_TSX");
      const labels = await pool.query<{
        attempt_id: string;
        status: string;
        r_multiple: string | null;
      }>(
        `SELECT attempt_id,status,r_multiple FROM funded_shadow_label WHERE enrollment_id=$1`,
        [enrollment.id],
      );
      expect(labels.rows).toHaveLength(2);
      expect(
        labels.rows.filter((row) => row.status === "POSITIVE"),
      ).toHaveLength(1);
      expect(
        labels.rows.filter((row) => row.status === "UNRESOLVED"),
      ).toHaveLength(1);
      fundedShadowLabelSchema.parse(
        (
          await pool.query(
            `SELECT * FROM funded_shadow_label WHERE enrollment_id=$1 LIMIT 1`,
            [enrollment.id],
          )
        ).rows.map((row) => ({
          labelVersion: row.label_version,
          attemptId: row.attempt_id,
          enrollmentId: row.enrollment_id,
          marketId: row.market_id,
          currency: row.currency,
          status: row.status,
          rMultiple: row.r_multiple === null ? null : Number(row.r_multiple),
          labelAvailableAt:
            row.label_available_at === null
              ? null
              : (row.label_available_at as Date).toISOString(),
          unresolvedReason: row.unresolved_reason,
          evidenceExecutionId: row.evidence_execution_id,
          recordedAt: (row.recorded_at as Date).toISOString(),
          labelDigest: row.label_digest,
        }))[0],
      );
      const first = await reporting.record(enrollment.id);
      const second = await reporting.record(enrollment.id);
      expect(first?.reused).toBe(false);
      expect(second?.reused).toBe(true);
      expect(first?.report.reportDigest).toBe(second?.report.reportDigest);
      expect(first?.report.promotionAuthorized).toBe(false);
      expect(first?.report.authorityEffect).toBe("NONE");
      expect(first?.report.coverage.timelyPredictions).toBe(2);
      expect(first?.report.coverage.labelsAvailable).toBe(1);
      expect(first?.report.coverage.labelsPermanentlyUnresolved).toBe(1);
      const after = await fundedTableCounts();
      expect(after).toEqual(before);
      // Every populated FP04 table rejects both UPDATE and DELETE. The update
      // is a no-op assignment so only the immutability trigger can raise.
      const immutableUpdates: ReadonlyArray<readonly [string, string]> = [
        ["funded_shadow_gate_policy", "market_id"],
        ["funded_shadow_enrollment", "market_id"],
        ["funded_shadow_batch", "market_id"],
        ["funded_shadow_attempt", "market_id"],
        ["funded_shadow_batch_member", "ordinal"],
        ["funded_shadow_attempt_result", "market_id"],
        ["funded_shadow_batch_projection", "market_id"],
        ["funded_shadow_label", "market_id"],
        ["funded_shadow_report", "market_id"],
      ];
      for (const [table, column] of immutableUpdates) {
        await expect(
          pool.query(`UPDATE ${table} SET ${column}=${column}`),
        ).rejects.toThrow(/immutable/i);
        await expect(pool.query(`DELETE FROM ${table}`)).rejects.toThrow(
          /immutable/i,
        );
      }
      const storedPolicy = fundedShadowGatePolicySchema.parse(
        (
          await pool.query(
            `SELECT p.* FROM funded_shadow_gate_policy p
               JOIN funded_shadow_enrollment e ON e.gate_policy_id=p.id
              WHERE e.id=$1`,
            [enrollment.id],
          )
        ).rows.map((row) => ({
          gatePolicyVersion: row.gate_policy_version,
          marketId: row.market_id,
          currency: row.currency,
          stageBApproval: row.stage_b_approval,
          window: row.gate_window,
          challengerPolicyVersion: row.challenger_policy_version,
          maxPredictionLagMs: row.max_prediction_lag_ms,
          gatePolicyDigest: row.gate_policy_digest,
        }))[0],
      );
      expect(storedPolicy.maxPredictionLagMs).toBe(1_000);
    }, 60_000);

    it("records unavailable input, invalid identity and whole-batch fallback", async () => {
      const run = await seedRun({ sessionDate: "2026-09-22" });
      const { enrollment, challenger } = await createEnrollment(run);
      const decisionAt = new Date().toISOString();
      const v1Observation = await insertObservation({
        runId: run.runId,
        instrumentId: await insertInstrument(),
        signalAt: decisionAt,
      });
      const mismatchObservation = await insertObservation({
        runId: run.runId,
        instrumentId: await insertInstrument(),
        signalAt: decisionAt,
      });
      await seedDecision({
        runId: run.runId,
        accountId: run.accountId,
        observationId: v1Observation,
        sequence: 1,
        decisionAt,
        cohortDigest: challenger.cohortDigest,
        evidenceSchemaVersion: 1,
      });
      await seedDecision({
        runId: run.runId,
        accountId: run.accountId,
        observationId: mismatchObservation,
        sequence: 2,
        decisionAt,
        cohortDigest: "9".repeat(64),
      });
      const observer = new FundedShadowObserver({
        store: shadow,
        pool,
        engine: {
          predictFundedExecution: async () => {
            throw new Error("must not be called");
          },
        },
        predictions,
      });
      await observer.runOnce("CA_TSX");
      const results = await pool.query<{
        disposition: string;
        failure_reason: string;
      }>(
        `SELECT disposition,failure_reason FROM funded_shadow_attempt_result
          WHERE enrollment_id=$1 ORDER BY attempt_id`,
        [enrollment.id],
      );
      expect(results.rows.map((row) => row.disposition).sort()).toEqual([
        "INPUT_UNAVAILABLE",
        "INVALID_IDENTITY",
      ]);
      expect(results.rows.map((row) => row.failure_reason).sort()).toEqual([
        "DECISION_NOT_V2",
        "MODEL_IDENTITY_MISMATCH",
      ]);
      await new Promise((resolve) => setTimeout(resolve, 5_300));
      const pass = await observer.runOnce("CA_TSX");
      expect(pass.lateInputs).toBe(0);
      const projection = await pool.query<{
        batch_disposition: string;
        fallback_reason: string;
      }>(
        `SELECT batch_disposition,fallback_reason FROM funded_shadow_batch_projection
          WHERE enrollment_id=$1`,
        [enrollment.id],
      );
      expect(projection.rows[0]!.batch_disposition).toBe(
        "FALLBACK_CHAMPION_ORDER",
      );
      expect(projection.rows[0]!.fallback_reason).toBe(
        "PREDICTION_INPUT_UNAVAILABLE",
      );
    }, 60_000);

    it("terminalizes missed deadlines by database time", async () => {
      const run = await seedRun({ sessionDate: "2026-09-23" });
      const { enrollment, challenger } = await createEnrollment(run);
      const decisionAt = new Date().toISOString();
      const observationId = await insertObservation({
        runId: run.runId,
        instrumentId: await insertInstrument(),
        signalAt: decisionAt,
      });
      await seedDecision({
        runId: run.runId,
        accountId: run.accountId,
        observationId,
        sequence: 1,
        decisionAt,
        cohortDigest: challenger.cohortDigest,
      });
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      const observer = new FundedShadowObserver({
        store: shadow,
        pool,
        engine: {
          predictFundedExecution: async () => {
            throw new Error("must not be called after the deadline");
          },
        },
        predictions,
      });
      await observer.runOnce("CA_TSX");
      const result = await pool.query<{
        disposition: string;
        failure_reason: string;
      }>(
        `SELECT disposition,failure_reason FROM funded_shadow_attempt_result
          WHERE enrollment_id=$1`,
        [enrollment.id],
      );
      expect(result.rows[0]!.disposition).toBe("MISSED_DEADLINE");
      expect(result.rows[0]!.failure_reason).toBe("DEADLINE_EXPIRED");
    });

    it("rejects mutation, cross-market ownership and authority surfaces", async () => {
      const run = await seedRun({ sessionDate: "2026-09-24" });
      const { enrollment } = await createEnrollment(run);
      await expect(
        pool.query(
          `UPDATE funded_shadow_enrollment SET market_id='US_EQUITIES' WHERE id=$1`,
          [enrollment.id],
        ),
      ).rejects.toThrow(/immutable/i);
      await expect(
        pool.query(`DELETE FROM funded_shadow_gate_policy`),
      ).rejects.toThrow(/immutable/i);
      // A US enrollment cannot bind a CAD champion run.
      await expect(
        pool.query(
          `INSERT INTO funded_shadow_enrollment(
             gate_policy_id,market_id,currency,source_kind,
             champion_source_run_id,champion_source_account_id,champion_policy_digest,
             champion_execution_model_version,champion_account_assumption_digest,champion_payload,
             challenger_model_id,challenger_model_version,challenger_model_type,
             challenger_artifact_digest,challenger_feature_version,challenger_cohort_digest,
             challenger_dataset_digest,challenger_training_partition_digest,
             challenger_training_evidence_cutoff_at,challenger_policy_digest,challenger_payload,
             evidence_cutoff_at,registration_request_id,request_hash,enrollment_digest)
           SELECT gate_policy_id,'US_EQUITIES','USD',source_kind,
                  champion_source_run_id,champion_source_account_id,champion_policy_digest,
                  champion_execution_model_version,champion_account_assumption_digest,champion_payload,
                  challenger_model_id,challenger_model_version,challenger_model_type,
                  challenger_artifact_digest,challenger_feature_version,challenger_cohort_digest,
                  challenger_dataset_digest,challenger_training_partition_digest,
                  challenger_training_evidence_cutoff_at,challenger_policy_digest,challenger_payload,
                  evidence_cutoff_at,'fp04-cross-market','${"a".repeat(64)}','${"b".repeat(64)}'
             FROM funded_shadow_enrollment WHERE id=$1`,
          [enrollment.id],
        ),
      ).rejects.toThrow();
      const columns = await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name LIKE 'funded_shadow_%'`,
      );
      const forbidden = [
        "authority",
        "activation",
        "promotion",
        "active_policy",
        "canary",
        "rollback",
      ];
      for (const column of columns.rows)
        for (const word of forbidden)
          expect(column.column_name).not.toContain(word);
      // No funded shadow service exposes an authority transition method.
      const shadowMethods = Object.getOwnPropertyNames(
        Object.getPrototypeOf(shadow),
      );
      for (const forbidden of ["activate", "promote", "rollback"])
        expect(shadowMethods).not.toContain(forbidden);
    });

    it("fails closed on NULL gate policies and mutates no receipt table", async () => {
      const run = await seedRun({ sessionDate: "2026-09-25" });
      const { enrollment } = await createEnrollment(run);
      await pool.query(
        `INSERT INTO funded_shadow_enrollment_transition(
           enrollment_id,sequence,action,state,request_id,request_hash)
         VALUES($1,1,'PAUSE','PAUSED','fp04-mutation-transition',$2)`,
        [enrollment.id, "c".repeat(64)],
      );
      await pool.query(
        `INSERT INTO funded_shadow_observer_event(market_id,currency,kind,detail)
         VALUES('CA_TSX','CAD','LATE_INPUT','fp04-mutation-fixture')`,
      );
      await expect(
        pool.query(
          `UPDATE funded_shadow_enrollment_transition SET sequence=sequence`,
        ),
      ).rejects.toThrow(/immutable/i);
      await expect(
        pool.query(`DELETE FROM funded_shadow_enrollment_transition`),
      ).rejects.toThrow(/immutable/i);
      await expect(
        pool.query(
          `UPDATE funded_shadow_observer_event SET market_id=market_id`,
        ),
      ).rejects.toThrow(/immutable/i);
      await expect(
        pool.query(`DELETE FROM funded_shadow_observer_event`),
      ).rejects.toThrow(/immutable/i);
      const policy = shadowGatePolicyDraft();
      const insertPolicy = (stageBApproval: string, window: string) =>
        pool.query(
          `INSERT INTO funded_shadow_gate_policy(
             gate_policy_version,market_id,currency,stage_b_approval,gate_window,
             challenger_policy_version,max_prediction_lag_ms,gate_policy_digest)
           VALUES('funded-shadow-gate-policy-v1','CA_TSX','CAD',
                  $1::jsonb,$2::jsonb,
                  'funded-comparison-execution-quality-ordering-v1',1000,$3)`,
          [stageBApproval, window, "e".repeat(64)],
        );
      await expect(
        insertPolicy("null", JSON.stringify(policy.window)),
      ).rejects.toThrow(/stage_b_check/);
      await expect(
        insertPolicy(JSON.stringify(policy.stageBApproval), "null"),
      ).rejects.toThrow(/window_check/);
      await expect(
        insertPolicy(
          JSON.stringify({ approvalRef: "incomplete" }),
          JSON.stringify(policy.window),
        ),
      ).rejects.toThrow(/stage_b_check/);
      await expect(
        insertPolicy(
          JSON.stringify(policy.stageBApproval),
          JSON.stringify({
            minDecisions: null,
            minSessions: 20,
            horizonSessions: 40,
            horizonDays: 90,
          }),
        ),
      ).rejects.toThrow(/window_check/);
    });
  },
);
