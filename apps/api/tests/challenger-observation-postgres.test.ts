import { contentHash } from "../src/backtests/research-coverage.js";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { featureSnapshotSchema } from "@tsx-scanner/contracts";
import { migrate } from "../src/database/migrate.js";
import {
  PostgresChallengerAttemptStore,
  type ChallengerPredictionInput,
  type ChallengerAttemptRecord,
} from "../src/statistical-models/challenger-attempt-repository.js";
import { PostgresChallengerExperimentStore } from "../src/statistical-models/challenger-experiment-repository.js";
import { PostgresStatisticalModelStore } from "../src/statistical-models/statistical-model-repository.js";
import { PostgresChallengerReportingService } from "../src/statistical-models/challenger-reporting-service.js";
import { PostgresPaperExecutionStore } from "../src/paper-bot/paper-execution-repository.js";
import { ChallengerExperimentService } from "../src/statistical-models/challenger-experiment-service.js";
import { PostgresResearchEvidenceStore } from "../src/backtests/research-evidence-repository.js";
import { registerChallengerSchema } from "@tsx-scanner/contracts";
import { ChallengerCoverageAutomation } from "../src/statistical-models/challenger-coverage-automation.js";
import type { PaperSignalObservation } from "../src/paper-bot/paper-bot-repository.js";
import { isolatedDatabaseUrl } from "./isolated-database.js";

const databaseUrl = isolatedDatabaseUrl("AUDIT_TEST_DATABASE_URL");

const experimentId = randomUUID();
const modelId = randomUUID();
const backtestRunId = randomUUID();
const runId = randomUUID();
const instrumentId = randomUUID();
const profileId = randomUUID();
const profileConfigId = randomUUID();
const strategyDefinitionId = "10000000-0000-4000-8000-000000000073";
const artifactHash = contentHash({});
const researchEvidence = {
  manifestHash: "1".repeat(64),
  coverageReportHash: "2".repeat(64),
  inputHash: "3".repeat(64),
  engineRevision: "4".repeat(40),
  runtimeFingerprint: "5".repeat(64),
  verifiedAt: "2026-09-10T12:00:00.000Z",
};
const scope = {
  marketId: "CA_TSX" as const,
  currency: "CAD" as const,
  strategy: "VWAP_RECLAIM" as const,
  strategyVersion: "1.0.0",
  profileConfigId,
  configVersion: "challenger-test",
  executionModelVersion: "paper-v1",
  executionAssumptionsHash: "c".repeat(64),
  signalSemanticsVersion: "signals-v1",
  replayScope: "paper-test",
};

const featureSnapshot = featureSnapshotSchema.parse({
  marketId: "CA_TSX",
  instrumentId,
  symbol: "BTO.TO",
  timestamp: "2026-09-10T14:00:00.000Z",
  timeframe: "OneMinute",
  featureVersion: "1.0.0",
  configVersion: "challenger-test",
  dataStatus: "REALTIME",
  actionable: true,
  price: 8,
  bid: 7.99,
  ask: 8.01,
  mid: 8,
  spreadAbsolute: 0.02,
  spreadPct: 0.25,
  changeFromOpenPct: 1,
  rollingReturn5mPct: 0.1,
  vwap: 7.95,
  distanceFromVwapPct: 0.63,
  closeAboveVwap: true,
  last3ClosesAboveVwap: 3,
  vwapSlopePct: 0.1,
  touchVwap: false,
  vwapReclaim: false,
  vwapRejection: false,
  atr14: 0.25,
  atrPct: 3.125,
  rvolAtTime: 2,
  currentCumulativeVolume: 100_000,
  historicalMeanCumulativeVolume: 50_000,
  openingRange: null,
  swingHighs: [],
  swingLows: [],
  nearestSupport: null,
  nearestResistance: null,
  distanceFromVwapAtr: 0.2,
  distanceFromOrhAtr: null,
  changeFromOpenAtr: 0.32,
  consecutiveGreenCandles: 2,
  recentMoveVelocityAtr: 0.1,
  warmingUp: [],
});

describe.skipIf(!databaseUrl)(
  "challenger observation PostgreSQL acceptance",
  () => {
    let pool: Pool;
    let experiments: PostgresChallengerExperimentStore;
    let attempts: PostgresChallengerAttemptStore;
    let firstObservation: PaperSignalObservation;
    let firstAttempt: ChallengerAttemptRecord;

    beforeAll(async () => {
      pool = new Pool({ connectionString: databaseUrl, max: 4 });
      await migrate(pool);
      await pool.query(
        `INSERT INTO instrument(
         id,questrade_symbol_id,symbol,description,exchange,currency,security_type,
         is_quotable,is_tradable,market_id
       ) VALUES($1,990001,'BTO.TO','Challenger test','TSX','CAD','Equity',true,true,'CA_TSX')`,
        [instrumentId],
      );
      await pool.query(
        `INSERT INTO scanner_profile(id,name,strategy_definition_id,enabled)
       VALUES($1,'Challenger test profile',$2,true)`,
        [profileId, strategyDefinitionId],
      );
      await pool.query(
        `INSERT INTO scanner_profile_config(id,profile_id,config_version,parameters)
       VALUES($1,$2,'challenger-test','{}'::jsonb)`,
        [profileConfigId, profileId],
      );
      await pool.query(
        `INSERT INTO paper_bot_run(
         id,source,session_date,session_timezone,scheduled_close_at,status,
         execution_model_version,assumptions,market_id
       ) VALUES($1,'LIVE',CURRENT_DATE,'America/Toronto',clock_timestamp()+INTERVAL '1 hour',
         'RUNNING','paper-v1',
         '{"positionSize":1000,"slippageBps":2,"feePerTrade":1,
           "stopMethod":"ATR","atrStopMultiple":1.5,"maxQuoteAgeSeconds":5,
           "sessionTimezone":"America/Toronto","noonCloseTime":"12:00","evidenceScope":"paper-test"}'::jsonb,
         'CA_TSX')`,
        [runId],
      );
      await pool.query(
        `INSERT INTO backtest_run(
         id,name,status,start_date,end_date,strategies,symbols,data_source,
         strategy_version,config_version,starting_capital,position_size,
         slippage_bps,fee_per_trade,parameters,execution_model_version,
         execution_assumptions,market_id
       ) VALUES($1,'challenger model source','COMPLETED',CURRENT_DATE,CURRENT_DATE,
         '["VWAP_RECLAIM"]'::jsonb,'[]'::jsonb,'CAPTURED_QUOTES','1.0.0',
         'challenger-test',100000,1000,2,1,'{}'::jsonb,'paper-execution-v7',
         '{"positionSize":1000,"slippageBps":2,"feePerTrade":1,
           "stopMethod":"ATR","atrStopMultiple":1.5,"maxQuoteAgeSeconds":5,
           "sessionTimezone":"America/Toronto","noonCloseTime":"12:00","evidenceScope":"paper-test"}'::jsonb,
         'CA_TSX')`,
        [backtestRunId],
      );
      await pool.query(
        `INSERT INTO statistical_model(
         id,name,status,model_type,model_version,backtest_run_id,strategy_name,
         input,artifact,completed_at,market_id
       ) VALUES($1,'challenger model','COMPLETED','LOGISTIC_SETUP_QUALITY','model-v1',
         $2,'VWAP_RECLAIM','{}'::jsonb,'{}'::jsonb,clock_timestamp(),'CA_TSX')`,
        [modelId, backtestRunId],
      );
      const runSource = await pool.query<{
        assumptions: Record<string, unknown>;
      }>("SELECT assumptions FROM paper_bot_run WHERE id=$1", [runId]);
      scope.executionAssumptionsHash = contentHash(
        runSource.rows[0]!.assumptions,
      );
      const baseline = {
        version: "challenger-baseline-v1",
        scope,
        featureVersion: "1.0.0",
        deterministicPolicyHash: "1".repeat(64),
        executionAssumptions: runSource.rows[0]!.assumptions,
        researchEvidence,
      };
      const conditions = {
        version: "challenger-conditions-v1",
        marketId: "CA_TSX",
        featureVersion: "1.0.0",
        dimensions: ["atrPct", "rvolAtTime", "spreadPct"].map((field) => ({
          field,
          breakpoints: [1],
          missing: "UNKNOWN",
        })),
      };
      const startsAt = new Date(Date.now() - 2000).toISOString(),
        endsAt = new Date(Date.now() + 3600000).toISOString();
      const plan = {
        version: "challenger-acceptance-v1",
        baselineIdentityHash: contentHash(baseline),
        scope,
        startsAt,
        endsAt,
        comparison: {
          marketId: "CA_TSX",
          unit: "R",
          expectedSessions: [startsAt.slice(0, 10)],
          minimumSessions: 1,
          blockLength: 1,
          bootstrapSamples: 1000,
          seed: 1,
        },
        minimumClosedOutcomes: 1,
        criteria: [
          "NET_RETURN_AFTER_COSTS",
          "CLOSED_OUTCOME_DRAWDOWN",
          "SESSION_CONSISTENCY",
          "SYMBOL_CONSISTENCY",
          "CONDITION_CONSISTENCY",
          "BRIER_SCORE",
        ].map((metric, i) => ({
          metric,
          unit: i < 2 ? "R" : "PROPORTION",
          operator: "GT",
          threshold: 0,
        })),
        conditionDefinitionHash: contentHash(conditions),
        evaluationBasis: "INDEPENDENT_CLOSED_OUTCOMES",
      };
      for (const [table, record] of [
        ["challenger_baseline_record", baseline],
        ["challenger_acceptance_plan", plan],
        ["challenger_condition_definition", conditions],
      ] as const)
        await pool.query(
          `INSERT INTO ${table}(identity_hash,market_id,record) VALUES($1,'CA_TSX',$2::jsonb) ON CONFLICT DO NOTHING`,
          [contentHash(record), JSON.stringify(record)],
        );
      await pool.query(
        `INSERT INTO challenger_model_scope(model_id,scope_hash,scope,source_kind,source_id,source_digest,artifact_hash,training_label_cutoff_at)
        VALUES($1,$2,$3::jsonb,'BACKTEST_RUN',$4,$5,$6,$7)`,
        [
          modelId,
          contentHash(scope),
          JSON.stringify(scope),
          backtestRunId,
          "a".repeat(64),
          artifactHash,
          new Date(Date.now() - 10000),
        ],
      );
      await pool.query(
        `INSERT INTO challenger_experiment(
         id,model_id,model_version,artifact_hash,market_id,currency,scope,
         research_evidence,baseline_identity_hash,acceptance_plan_hash,
         starts_at,ends_at,registered_at,max_prediction_lag_ms,
         registration_request_id,registration_request_hash
       ) VALUES($1,$2,'model-v1',$3,'CA_TSX','CAD',$4::jsonb,$5::jsonb,$6,$7,
         $10,$11,
         clock_timestamp()-INTERVAL '3 seconds',30000,$8,$9)`,
        [
          experimentId,
          modelId,
          artifactHash,
          JSON.stringify(scope),
          JSON.stringify(researchEvidence),
          contentHash(baseline),
          contentHash(plan),
          `registration-${experimentId}`,
          "f".repeat(64),
          startsAt,
          endsAt,
        ],
      );
      await pool.query(
        `INSERT INTO challenger_experiment_transition(
         experiment_id,sequence,request_id,action,state,effective_at,request_hash
       ) VALUES($1,1,$2,'START','ACTIVE',clock_timestamp()-INTERVAL '1 second',$3)`,
        [experimentId, `start-${experimentId}`, "1".repeat(64)],
      );
      experiments = new PostgresChallengerExperimentStore(pool);
      attempts = new PostgresChallengerAttemptStore(pool);
      firstObservation = await insertObservation(randomUUID());
      await withTransaction(async (client) => {
        await experiments.captureForObservation(client, firstObservation);
      });
      firstAttempt = (await attempts.listWithOutcomes(experimentId))[0]!;
    });

    afterAll(async () => {
      await pool?.end();
    });

    it("stamps capture time in PostgreSQL, deduplicates attempts and preserves terminal outcomes", async () => {
      await expect(experiments.getModel(modelId)).resolves.toMatchObject({
        researchEvidenceVerified: false,
      });
      expect(firstObservation.capturedAt).not.toBeNull();
      expect(Date.parse(firstObservation.capturedAt!)).toBeGreaterThan(
        Date.now() - 60_000,
      );
      expect(firstAttempt).toMatchObject({
        experimentId,
        observationId: firstObservation.id,
        modelVersion: "model-v1",
      });
      const attempt = attemptOnly(firstAttempt);
      expect(
        await attempts.capture(
          attempt,
          firstAttempt.input! as ChallengerPredictionInput,
        ),
      ).toBe("EXISTING");
      await attempts.finish(attempt, {
        status: "MISSED_DEADLINE",
        completedAt: attempt.deadlineAt,
        reason: "DEADLINE_EXPIRED",
      });
      await expect(
        attempts.finish(attempt, {
          status: "PREDICTED",
          completedAt: attempt.deadlineAt,
          prediction: {
            marketId: "CA_TSX",
            instrumentId,
            symbol: "BTO.TO",
            timestamp: firstAttempt.observedAt,
            profileId,
            profileName: "Challenger test profile",
            strategy: "VWAP_RECLAIM",
            deterministicScore: 80,
            setupProbability: 0.6,
            falseBreakoutProbability: 0.2,
            rankingScore: 80,
            regime: { atr: "HIGH", rvol: "HIGH", combined: "HIGH_HIGH" },
            contributions: {},
            warnings: [],
          },
        }),
      ).rejects.toThrow("CHALLENGER_OUTCOME_CONFLICT");
      const count = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM challenger_attempt WHERE experiment_id=$1`,
        [experimentId],
      );
      expect(count.rows[0]!.n).toBe(1);
    });

    it("does not infer legacy capture and closes active intervals on pause/resume", async () => {
      await experiments.transition(
        experimentId,
        "PAUSE",
        `pause-${experimentId}`,
      );
      const pausedObservation = await insertObservation(randomUUID());
      await withTransaction(async (client) => {
        await experiments.captureForObservation(client, pausedObservation);
      });
      expect(
        (await attempts.listWithOutcomes(experimentId)).some(
          (row) => row.observationId === pausedObservation.id,
        ),
      ).toBe(false);

      await experiments.transition(
        experimentId,
        "RESUME",
        `resume-${experimentId}`,
      );
      const resumedObservation = await insertObservation(randomUUID());
      await withTransaction(async (client) => {
        await experiments.captureForObservation(client, resumedObservation);
      });
      expect(
        (await attempts.listWithOutcomes(experimentId)).some(
          (row) => row.observationId === resumedObservation.id,
        ),
      ).toBe(true);

      const legacyId = randomUUID();
      await pool.query(
        "ALTER TABLE paper_signal_observation DISABLE TRIGGER paper_signal_observation_capture",
      );
      try {
        await insertObservation(legacyId, null);
      } finally {
        await pool.query(
          "ALTER TABLE paper_signal_observation ENABLE TRIGGER paper_signal_observation_capture",
        );
      }
      const legacy = await getObservation(legacyId);
      expect(legacy.capturedAt).toBeNull();
      await withTransaction(async (client) => {
        await experiments.captureForObservation(client, legacy);
      });
      expect(
        (await attempts.listWithOutcomes(experimentId)).some(
          (row) => row.observationId === legacyId,
        ),
      ).toBe(false);
      await experiments.transition(experimentId, "END", `end-${experimentId}`);
      await experiments.transition(
        experimentId,
        "REVOKE",
        `revoke-${experimentId}`,
      );
      expect(
        (await attempts.listWithOutcomes(experimentId)).find(
          (row) => row.observationId === resumedObservation.id,
        )?.outcome,
      ).toMatchObject({ status: "EXPERIMENT_REVOKED" });
    });

    it("rejects changed retry identity and direct mutation of evidence", async () => {
      await expect(
        attempts.finish(
          {
            ...attemptOnly(firstAttempt),
            deadlineAt: "2099-01-01T00:00:00.000Z",
          },
          {
            status: "MISSED_DEADLINE",
            completedAt: "2099-01-01T00:00:00.000Z",
            reason: "DEADLINE_EXPIRED",
          },
        ),
      ).rejects.toThrow("ATTEMPT_CONFLICT");
      await expect(
        pool.query(
          `UPDATE challenger_attempt SET deadline_at=clock_timestamp()
          WHERE experiment_id=$1 AND observation_id=$2`,
          [experimentId, firstObservation.id],
        ),
      ).rejects.toThrow("immutable");
      await expect(
        pool.query(
          `UPDATE challenger_outcome SET outcome=outcome || '{"reason":"changed"}'::jsonb
          WHERE experiment_id=$1 AND observation_id=$2`,
          [experimentId, firstObservation.id],
        ),
      ).rejects.toThrow("immutable");
    });

    it("completes successive models in one scope and rolls back scope-write failures", async () => {
      const datasetId = randomUUID();
      const evidence = new PostgresResearchEvidenceStore(pool);
      const manifest = { version: "challenger-enrollment-fixture", datasetId };
      const manifestHash = contentHash(manifest);
      await evidence.saveManifest({
        hash: manifestHash,
        marketId: "CA_TSX",
        manifest,
      });
      const verifiedAt = new Date().toISOString();
      const reportHash = await evidence.saveReport({
        version: "research-coverage-v2",
        marketId: "CA_TSX",
        manifestHash,
        inputHash: contentHash({ datasetId }),
        expectedInputsHash: contentHash([]),
        sessionPayloadHashes: {},
        verifiedAt,
        status: "VERIFIED",
        cells: [],
      });
      const binding = {
        manifestHash,
        coverageReportHash: reportHash,
        inputHash: contentHash({ datasetId }),
        engineRevision: "a".repeat(40),
        runtimeFingerprint: "b".repeat(64),
        verifiedAt,
      };
      const source = (
        await pool.query<{ assumptions: unknown }>(
          "SELECT assumptions FROM paper_bot_run WHERE id=$1",
          [runId],
        )
      ).rows[0]!;
      const cohort = {
        ...scope,
        executionModelVersion: "paper-execution-v7",
        assumptions: source.assumptions,
      };
      await evidence.withTransaction(async (client) => {
        await client.query(
          `INSERT INTO statistical_training_dataset(id,source_kind,market_id,policy_version,cohort,requested_cutoff,effective_cutoff,source_digest,source_row_count,research_qualification,research_evidence)
        VALUES($1,'PAPER_EVIDENCE','CA_TSX','fixture-qualified',$2::jsonb,clock_timestamp(),clock_timestamp()-interval '1 day',$3,200,'{"qualified":true}'::jsonb,$4::jsonb)`,
          [
            datasetId,
            JSON.stringify(cohort),
            randomUUID(),
            JSON.stringify(binding),
          ],
        );
        await evidence.bindWithClient(
          client,
          { kind: "DATASET", id: datasetId, marketId: "CA_TSX" },
          binding,
        );
      });
      await pool.query(
        `INSERT INTO statistical_training_dataset_member(dataset_id,ordinal,source_key,signal_timestamp,normalized_row)
        SELECT $1,n,'source-'||n,clock_timestamp()-interval '2 days',jsonb_build_object('labelAvailableAt',clock_timestamp()-interval '1 day') FROM generate_series(0,199) n`,
        [datasetId],
      );
      const models = new PostgresStatisticalModelStore(pool);
      const artifact = {
        artifactVersion: "1.0.0" as const,
        modelType: "LOGISTIC_SETUP_QUALITY" as const,
        featureNames: ["score", "atr", "rvol", "regime"],
        intercept: 0,
        coefficients: [0, 0, 0, 0],
        means: [0, 0, 0, 0],
        scales: [1, 1, 1, 1],
        medians: [0, 0, 0, 0],
        atrMedian: 1,
        rvolMedian: 1,
      };
      const result = {
        status: "COMPLETED" as const,
        artifact,
        train: null,
        test: null,
        calibration: [],
        eligibleForActivation: true,
        warnings: [],
        trainingStart: null,
        trainingEnd: null,
        testStart: null,
        testEnd: null,
      };
      const create = () =>
        models.create({
          sourceKind: "PAPER_EVIDENCE",
          trainingDatasetId: datasetId,
          name: "repeat challenger",
          strategy: "VWAP_RECLAIM",
          trainPct: 80,
          minimumSamples: 200,
          l2Penalty: 0.1,
        });
      const first = await create(),
        second = await create();
      await models.complete(first.id, result, "repeat-1", binding);
      await models.complete(second.id, result, "repeat-2", binding);
      const scopes = await pool.query<{ scope_hash: string }>(
        "SELECT scope_hash FROM challenger_model_scope WHERE model_id=ANY($1::uuid[])",
        [[first.id, second.id]],
      );
      expect(scopes.rows).toHaveLength(2);
      expect(scopes.rows[0]!.scope_hash).toBe(scopes.rows[1]!.scope_hash);
      // Exercise production lookup and registration, using an actual verified
      // model binding rather than the enrollment service's mocked store shape.
      await evidence.bind(
        { kind: "MODEL", id: first.id, marketId: "CA_TSX" },
        binding,
      );
      const frozenModel = await experiments.getModel(first.id);
      expect(frozenModel).toMatchObject({
        researchEvidenceVerified: true,
        scope: { executionModelVersion: "paper-execution-v7" },
      });
      const startsAt = new Date(Date.now() + 250).toISOString(),
        endsAt = new Date(Date.now() + 60000).toISOString();
      const baseline = {
        version: "challenger-baseline-v1",
        scope: frozenModel!.scope!,
        featureVersion: "1.0.0",
        deterministicPolicyHash: "a".repeat(64),
        executionAssumptions: source.assumptions,
        researchEvidence: binding,
      };
      const conditions = {
        version: "challenger-conditions-v1",
        marketId: "CA_TSX",
        featureVersion: "1.0.0",
        dimensions: ["atrPct", "rvolAtTime", "spreadPct"].map((field) => ({
          field,
          breakpoints: [1],
          missing: "UNKNOWN",
        })),
      };
      const acceptancePlan = {
        version: "challenger-acceptance-v1",
        baselineIdentityHash: contentHash(baseline),
        scope: frozenModel!.scope!,
        startsAt,
        endsAt,
        comparison: {
          marketId: "CA_TSX",
          unit: "R",
          expectedSessions: [startsAt.slice(0, 10)],
          minimumSessions: 1,
          blockLength: 1,
          bootstrapSamples: 1000,
          seed: 1,
        },
        minimumClosedOutcomes: 200,
        criteria: [
          "NET_RETURN_AFTER_COSTS",
          "CLOSED_OUTCOME_DRAWDOWN",
          "SESSION_CONSISTENCY",
          "SYMBOL_CONSISTENCY",
          "CONDITION_CONSISTENCY",
          "BRIER_SCORE",
        ].map((metric, i) => ({
          metric,
          unit: i < 2 ? "R" : "PROPORTION",
          operator: "GT",
          threshold: 0,
        })),
        conditionDefinitionHash: contentHash(conditions),
        evaluationBasis: "INDEPENDENT_CLOSED_OUTCOMES",
      };
      const enrollment = new ChallengerExperimentService(experiments, {
        activate: async () => {
          throw new Error("UNEXPECTED_ACTIVATION");
        },
      });
      const request = registerChallengerSchema.parse({
        version: "register-challenger-v2",
        modelId: first.id,
        modelVersion: "repeat-1",
        artifactHash: contentHash(artifact),
        scope: frozenModel!.scope!,
        researchEvidence: binding,
        baselineIdentityHash: contentHash(baseline),
        acceptancePlanHash: contentHash(acceptancePlan),
        startsAt,
        endsAt,
        maxPredictionLagMs: 1000,
        baseline,
        acceptancePlan,
        conditionDefinition: conditions,
      });
      const registered = await enrollment.register(
        request,
        `fixture-${first.id}`,
      );
      expect(registered.state).toBe("REGISTERED");
      expect(
        (await enrollment.register(request, `fixture-${first.id}`)).id,
      ).toBe(registered.id);
      await new Promise((resolve) => setTimeout(resolve, 260));
      expect(
        (
          await enrollment.transition(
            registered.id,
            "START",
            `start-${first.id}`,
          )
        ).state,
      ).toBe("ACTIVE");
      await models.activate(first.id, "VWAP_RECLAIM");
      await enrollment.transition(registered.id, "PAUSE", `pause-${first.id}`);
      await expect(
        enrollment.transition(registered.id, "RESUME", `resume-${first.id}`),
      ).rejects.toMatchObject({ code: "EXPERIMENT_MODEL_ACTIVE" });
      await models.deactivate(first.id);
      const third = await create();
      await pool.query(
        `CREATE FUNCTION fail_test_challenger_scope() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.model_id='${third.id}'::uuid THEN RAISE EXCEPTION 'TEST_SCOPE_WRITE_FAILURE'; END IF; RETURN NEW; END $$`,
      );
      await pool.query(
        "CREATE TRIGGER fail_test_challenger_scope BEFORE INSERT ON challenger_model_scope FOR EACH ROW EXECUTE FUNCTION fail_test_challenger_scope()",
      );
      try {
        await expect(
          models.complete(third.id, result, "repeat-3"),
        ).rejects.toThrow("TEST_SCOPE_WRITE_FAILURE");
        expect(await models.get(third.id)).toMatchObject({
          status: "PENDING",
          artifact: null,
        });
      } finally {
        await pool.query(
          "DROP TRIGGER fail_test_challenger_scope ON challenger_model_scope",
        );
        await pool.query("DROP FUNCTION fail_test_challenger_scope()");
      }
    });

    it("keeps compatible captures when another experiment insert fails and reconciles omissions without prediction", async () => {
      const good = await cloneActiveExperiment(),
        bad = randomUUID(),
        other = randomUUID();
      for (const [id, lag, otherStrategy] of [
        [bad, 100, false],
        [other, 30000, true],
      ] as const) {
        await pool.query(
          `INSERT INTO challenger_experiment(id,model_id,model_version,artifact_hash,market_id,currency,scope,research_evidence,baseline_identity_hash,acceptance_plan_hash,starts_at,ends_at,max_prediction_lag_ms,registered_at,registration_request_id,registration_request_hash)
          SELECT $1::uuid,model_id,model_version,artifact_hash,market_id,currency,CASE WHEN $3 THEN jsonb_set(scope,'{strategy}','"ORB_RETEST"') ELSE scope END,research_evidence,baseline_identity_hash,acceptance_plan_hash,starts_at,ends_at,$2,registered_at,$1::text,registration_request_hash FROM challenger_experiment WHERE id=$4`,
          [id, lag, otherStrategy, experimentId],
        );
        await pool.query(
          `INSERT INTO challenger_experiment_transition(experiment_id,sequence,request_id,action,state,effective_at,request_hash)
          VALUES($1::uuid,1,$1::text,'START','ACTIVE',clock_timestamp()-interval '1 second',$2)`,
          [id, "a".repeat(64)],
        );
      }
      await pool.query(
        `CREATE FUNCTION fail_test_challenger_capture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.experiment_id='${bad}'::uuid THEN RAISE EXCEPTION 'TEST_CAPTURE_FAILURE'; END IF; RETURN NEW; END $$`,
      );
      await pool.query(
        "CREATE TRIGGER fail_test_challenger_capture BEFORE INSERT ON challenger_attempt FOR EACH ROW EXECUTE FUNCTION fail_test_challenger_capture()",
      );
      const observation = await insertObservation(randomUUID());
      try {
        await withTransaction((client) =>
          experiments.captureForObservation(client, observation),
        );
        expect(
          (await attempts.listWithOutcomes(good)).some(
            (row) => row.observationId === observation.id,
          ),
        ).toBe(true);
        expect(await attempts.listWithOutcomes(bad)).toHaveLength(0);
        expect(await attempts.listWithOutcomes(other)).toHaveLength(0);
        expect(
          (
            await pool.query(
              "SELECT * FROM challenger_capture_failure WHERE experiment_id=$1 AND observation_id=$2",
              [bad, observation.id],
            )
          ).rowCount,
        ).toBe(1);
      } finally {
        await pool.query(
          "DROP TRIGGER fail_test_challenger_capture ON challenger_attempt",
        );
        await pool.query("DROP FUNCTION fail_test_challenger_capture()");
      }
      await new Promise((resolve) => setTimeout(resolve, 120));
      const recovered = await attempts.reconcileMissingAttempts("CA_TSX", 100);
      expect(recovered.terminalized).toBeGreaterThan(0);
      expect((await attempts.listWithOutcomes(bad))[0]?.outcome).toMatchObject({
        status: "MISSED_DEADLINE",
      });
    });

    it("uses first captured labels and leaves absent prospective coverage unavailable", async () => {
      const activeId = await cloneActiveExperiment();
      const observation = await insertObservation(randomUUID());
      await withTransaction((client) =>
        experiments.captureForObservation(client, observation),
      );
      await pool.query(
        `INSERT INTO paper_execution(observation_id,market_id,model,status,entry_price,entry_time,stop_price,target_price,shares,initial_risk,exit_price,exit_time,exit_reason,fee,gross_pnl,net_pnl,r_multiple)
        VALUES($1,'CA_TSX','QUOTE','CLOSED',8,clock_timestamp()-interval '2 seconds',7,9,10,10,9,clock_timestamp()-interval '1 second','TARGET',1,10,9,0.9)`,
        [observation.id],
      );
      const before = (
        await pool.query<{ now: Date }>("SELECT clock_timestamp() AS now")
      ).rows[0]!.now.toISOString();
      const reporter = new PostgresChallengerReportingService(
        experiments,
        pool,
      );
      const beforeReport = await reporter.report(activeId, before);
      expect(beforeReport.closedQuoteOutcomes).toBe(0);
      expect(beforeReport.sessionCountsAvailable).toBe(false);
      expect(beforeReport.verifiedSessions).toBeNull();
      const execution = new PostgresPaperExecutionStore(pool);
      await pool.query(
        `CREATE FUNCTION fail_test_challenger_label() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.observation_id='${observation.id}'::uuid THEN RAISE EXCEPTION 'TEST_LABEL_FAILURE'; END IF; RETURN NEW; END $$`,
      );
      await pool.query(
        "CREATE TRIGGER fail_test_challenger_label BEFORE INSERT ON challenger_label_evidence FOR EACH ROW EXECUTE FUNCTION fail_test_challenger_label()",
      );
      try {
        expect(await execution.reconcileLabelEvidence(100)).toBe(0);
        expect(
          (
            await pool.query(
              "SELECT status FROM paper_execution WHERE observation_id=$1",
              [observation.id],
            )
          ).rows[0],
        ).toMatchObject({ status: "CLOSED" });
      } finally {
        await pool.query(
          "DROP TRIGGER fail_test_challenger_label ON challenger_label_evidence",
        );
        await pool.query("DROP FUNCTION fail_test_challenger_label()");
      }
      expect(await execution.reconcileLabelEvidence(100)).toBeGreaterThan(0);
      const after = await reporter.report(activeId);
      expect(after.closedQuoteOutcomes).toBe(1);
      expect(await reporter.report(activeId, before)).toEqual(beforeReport);
      expect(await execution.reconcileLabelEvidence(100)).toBe(0);
      await expect(
        pool.query(
          "UPDATE challenger_label_evidence SET label='{}' WHERE observation_id=$1",
          [observation.id],
        ),
      ).rejects.toThrow("IMMUTABLE_CHALLENGER_LABEL_EVIDENCE");
    });

    it("allows only one observer process per market while retaining separate market leases", async () => {
      const other = new PostgresChallengerAttemptStore(pool);
      let entered!: () => void, release!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const running = attempts.withMarketLease("CA_TSX", async () => {
        entered();
        await blocked;
        return 1;
      });
      await started;
      try {
        expect(await other.withMarketLease("CA_TSX", async () => 2)).toBeNull();
        expect(await other.withMarketLease("US_EQUITIES", async () => 3)).toBe(
          3,
        );
      } finally {
        release();
        await running;
      }
      expect(await other.withMarketLease("CA_TSX", async () => 4)).toBe(4);
    });

    it("automatically queues independent dated coverage only for existing enrolled experiments", async () => {
      const original = (await experiments.get(experimentId))!;
      const records = (await experiments.getAcceptance(
        original.baselineIdentityHash,
        original.acceptancePlanHash,
        "CA_TSX",
      ))!;
      const date = new Date(Date.now() - 2 * 86400000)
        .toISOString()
        .slice(0, 10);
      const plan = {
        ...records.acceptancePlan,
        startsAt: `${date}T00:00:00.000Z`,
        endsAt: `${date}T23:59:59.000Z`,
        comparison: {
          ...records.acceptancePlan.comparison,
          expectedSessions: [date],
        },
      };
      const id = randomUUID();
      await pool.query(
        "INSERT INTO challenger_acceptance_plan(identity_hash,market_id,record) VALUES($1,'CA_TSX',$2::jsonb)",
        [contentHash(plan), JSON.stringify(plan)],
      );
      await pool.query(
        `INSERT INTO challenger_experiment(id,model_id,model_version,artifact_hash,market_id,currency,scope,research_evidence,baseline_identity_hash,acceptance_plan_hash,starts_at,ends_at,max_prediction_lag_ms,registered_at,registration_request_id,registration_request_hash)
        SELECT $1::uuid,model_id,model_version,artifact_hash,market_id,currency,scope,research_evidence,baseline_identity_hash,$3,$4,$5,max_prediction_lag_ms,$4::timestamptz-interval '1 second',$1::text,registration_request_hash FROM challenger_experiment WHERE id=$2`,
        [id, experimentId, contentHash(plan), plan.startsAt, plan.endsAt],
      );
      await pool.query(
        `INSERT INTO challenger_experiment_transition(experiment_id,sequence,request_id,action,state,effective_at,request_hash)
        VALUES($1::uuid,1,$1::text,'START','ACTIVE',$2,$3)`,
        [id, plan.startsAt, "a".repeat(64)],
      );
      const policy = {
        timezone: "America/Toronto" as const,
        openingRange: { start: "09:30", end: "09:45" },
        scanning: { start: "09:30", end: "16:00" },
        entries: {
          preferredStart: "09:45",
          preferredEnd: "11:00",
          hardEnd: "11:30",
        },
      };
      const automation = new ChallengerCoverageAutomation(
        pool,
        {
          current: async () => ({
            engineRevision: "a".repeat(40),
            runtimeFingerprint: "b".repeat(64),
            featureVersion: "1.0.0",
          }),
        },
        {
          CA_TSX: policy,
          US_EQUITIES: { ...policy, timezone: "America/New_York" },
        },
      );
      expect(await automation.runOnce("CA_TSX")).toBe(1);
      const saved = await pool.query<{
        request: {
          manifest: {
            manifest: {
              purpose: { experimentId: string; expectedInputs: unknown[] };
            };
          };
        };
      }>(
        "SELECT request FROM research_coverage_request WHERE idempotency_key=$1",
        [`challenger-coverage:${id}:${date}`],
      );
      expect(
        saved.rows[0]?.request.manifest.manifest.purpose.experimentId,
      ).toBe(id);
      expect(
        saved.rows[0]?.request.manifest.manifest.purpose.expectedInputs,
      ).toBeDefined();
      expect(await automation.runOnce("CA_TSX")).toBe(0);
      expect((await experiments.get(id))?.state).toBe("ACTIVE");
    });

    async function cloneActiveExperiment(): Promise<string> {
      const id = randomUUID();
      await pool.query(
        `INSERT INTO challenger_experiment(id,model_id,model_version,artifact_hash,market_id,currency,scope,research_evidence,baseline_identity_hash,acceptance_plan_hash,starts_at,ends_at,max_prediction_lag_ms,registered_at,registration_request_id,registration_request_hash)
        SELECT $1::uuid,model_id,model_version,artifact_hash,market_id,currency,scope,research_evidence,baseline_identity_hash,acceptance_plan_hash,starts_at,ends_at,max_prediction_lag_ms,registered_at,$1::text,registration_request_hash FROM challenger_experiment WHERE id=$2`,
        [id, experimentId],
      );
      await pool.query(
        `INSERT INTO challenger_experiment_transition(experiment_id,sequence,request_id,action,state,effective_at,request_hash)
        VALUES($1::uuid,1,$1::text,'START','ACTIVE',clock_timestamp()-interval '1 second',$2)`,
        [id, "a".repeat(64)],
      );
      return id;
    }

    async function insertObservation(
      id: string,
      captureValue: string | null = "1970-01-01T00:00:00Z",
    ): Promise<PaperSignalObservation> {
      const timestamp = new Date().toISOString();
      await pool.query(
        `INSERT INTO paper_signal_observation(
         id,run_id,source_event_id,setup_instance_id,instrument_id,symbol,
         profile_id,profile_name,profile_config_id,config_version,profile_parameters,
         strategy_key,strategy_version,signal_timestamp,score,feature_snapshot,
         reason_codes,source_event_payload,eligibility_status,eligibility_reason,
         captured_at
       ) VALUES($1,$2,$3,NULL,$4,'BTO.TO',$5,'Challenger test profile',$6,
         'challenger-test','{}'::jsonb,'VWAP_RECLAIM','1.0.0',$7,80,$8::jsonb,
         '[]'::jsonb,'{"signalSemanticsVersion":"signals-v1"}'::jsonb,'ELIGIBLE',NULL,$9)`,
        [
          id,
          runId,
          randomUUID(),
          instrumentId,
          profileId,
          profileConfigId,
          timestamp,
          JSON.stringify({ ...featureSnapshot, timestamp }),
          captureValue,
        ],
      );
      return getObservation(id);
    }

    async function getObservation(id: string): Promise<PaperSignalObservation> {
      const result = await pool.query<{
        id: string;
        marketId: "CA_TSX" | "US_EQUITIES";
        runId: string;
        sourceEventId: string;
        instrumentId: string;
        symbol: string;
        profileId: string;
        profileName: string;
        profileConfigId: string;
        configVersion: string;
        profileParameters: unknown;
        strategyKey: string;
        strategyVersion: string;
        signalTimestamp: Date;
        score: number;
        featureSnapshot: unknown;
        reasonCodes: unknown;
        sourceEventPayload: unknown;
        eligibilityStatus: "ELIGIBLE" | "BELOW_SCORE_CUTOFF";
        eligibilityReason: string | null;
        createdAt: Date;
        capturedAt: Date | null;
      }>(
        `SELECT o.id,r.market_id AS "marketId",o.run_id AS "runId",
              o.source_event_id AS "sourceEventId",o.instrument_id AS "instrumentId",
              o.symbol,o.profile_id AS "profileId",o.profile_name AS "profileName",
              o.profile_config_id AS "profileConfigId",o.config_version AS "configVersion",
              o.profile_parameters AS "profileParameters",o.strategy_key AS "strategyKey",
              o.strategy_version AS "strategyVersion",o.signal_timestamp AS "signalTimestamp",
              o.score,o.feature_snapshot AS "featureSnapshot",o.reason_codes AS "reasonCodes",
              o.source_event_payload AS "sourceEventPayload",
              o.eligibility_status AS "eligibilityStatus",o.eligibility_reason AS "eligibilityReason",
              o.created_at AS "createdAt",o.captured_at AS "capturedAt"
         FROM paper_signal_observation o
         JOIN paper_bot_run r ON r.id=o.run_id
        WHERE o.id=$1`,
        [id],
      );
      const row = result.rows[0]!;
      return {
        id: row.id,
        marketId: row.marketId,
        runId: row.runId,
        sourceEventId: row.sourceEventId,
        sourceSignalId: null,
        setupInstanceId: null,
        instrumentId: row.instrumentId,
        symbol: row.symbol,
        profileId: row.profileId,
        profileName: row.profileName,
        profileConfigId: row.profileConfigId,
        configVersion: row.configVersion,
        profileParameters: row.profileParameters,
        strategyKey: row.strategyKey,
        strategyVersion: row.strategyVersion,
        signalTimestamp: row.signalTimestamp.toISOString(),
        score: row.score,
        entryReference: null,
        stopReference: null,
        targetReference: null,
        atr14: null,
        featureSnapshot: row.featureSnapshot,
        reasonCodes: row.reasonCodes,
        sourceEventPayload: row.sourceEventPayload,
        eligibilityStatus: row.eligibilityStatus,
        eligibilityReason: row.eligibilityReason,
        createdAt: row.createdAt.toISOString(),
        capturedAt: row.capturedAt?.toISOString() ?? null,
      };
    }

    async function withTransaction(
      callback: (client: import("pg").PoolClient) => Promise<void>,
    ): Promise<void> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await callback(client);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }

    function attemptOnly(record: ChallengerAttemptRecord) {
      const { outcome: _outcome, ...attempt } = record;
      return attempt;
    }
  },
);
