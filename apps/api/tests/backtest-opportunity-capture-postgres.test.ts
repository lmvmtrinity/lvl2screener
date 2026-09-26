import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { isolatedDatabaseUrl } from "./isolated-database.js";
import { migrate } from "../src/database/migrate.js";
import {
  contentHash,
  coverageReportHash,
} from "../src/backtests/research-coverage.js";
import { PostgresBacktestStore } from "../src/backtests/backtest-repository.js";
import type { BacktestOpportunityCaptureInput } from "../src/backtests/authoritative-backtest-executor.js";
import { PostgresCanonicalSignalOpportunityCaptureRepository } from "../src/backtests/signal-model-source-preflight.js";
import { PostgresSignalModelResearchControlStore } from "../src/backtests/signal-model-research-control.js";
import { persistCapturedResearchCandidate } from "../src/backtests/signal-model-candidate-persistence.js";
import { PostgresChallengerExperimentStore } from "../src/statistical-models/challenger-experiment-repository.js";
import {
  signalModelResearchPlanSchema,
  type StatisticalModelArtifact,
  type SignalModelResearchPlan,
} from "@tsx-scanner/contracts";

const url = isolatedDatabaseUrl("PERSISTENCE_TEST_DATABASE_URL");
const date = "2026-08-25";
const marketId = "CA_TSX" as const;
const strategyVersion = "1.0.0";
const configVersion = "capture-test-v1";
const executionModelVersion = "paper-execution-v7";
const assumptions = { positionSize: 1000, slippageBps: 1 };
const assumptionsHash = contentHash(assumptions);

describe.skipIf(!url)(
  "canonical backtest opportunity capture persistence",
  () => {
    let pool: Pool;
    beforeAll(async () => {
      pool = new Pool({ connectionString: url });
      await migrate(pool);
    }, 60000);
    afterAll(async () => pool?.end(), 60000);

    async function sourceRun(
      selectedMarket: "CA_TSX" | "US_EQUITIES" = marketId,
      withLineage = true,
    ) {
      const runId = randomUUID();
      const instrumentId = randomUUID();
      const inputHash = contentHash(randomUUID());
      const manifestHash = contentHash(`manifest:${runId}`);
      const verifiedAt = "2026-08-26T12:00:00.000Z";
      const report = {
        version: "research-coverage-v1" as const,
        marketId: selectedMarket,
        manifestHash,
        expectedInputsHash: contentHash(`expected:${runId}`),
        inputHash,
        sessionPayloadHashes: { [date]: contentHash(`session:${runId}`) },
        verifiedAt,
        status: "VERIFIED" as const,
        cells: [
          {
            cellId: `cell:${runId}`,
            status: "VERIFIED" as const,
            validQuotes: 1,
            validWarmupBars: 1,
            maximumGapMs: 30_000,
            reasons: [],
          },
        ],
      };
      const reportHash = coverageReportHash(report);
      const binding = {
        manifestHash,
        coverageReportHash: reportHash,
        inputHash,
        engineRevision: "a".repeat(40),
        runtimeFingerprint: contentHash(`runtime:${runId}`),
        verifiedAt,
      };
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO instrument
       (id,questrade_symbol_id,symbol,description,exchange,currency,security_type,is_quotable,is_tradable,market_id)
       VALUES($1,$2,$3,'fixture',$4,$5,'EQUITY',TRUE,TRUE,$6)`,
          [
            instrumentId,
            Math.floor(Math.random() * 1_000_000_000),
            `CAP${runId.slice(0, 5)}`,
            selectedMarket === "CA_TSX" ? "TSX" : "NASDAQ",
            selectedMarket === "CA_TSX" ? "CAD" : "USD",
            selectedMarket,
          ],
        );
        await client.query(
          `INSERT INTO research_manifest(hash,market_id,manifest) VALUES($1,$2,'{}'::jsonb)`,
          [manifestHash, selectedMarket],
        );
        await client.query(
          `INSERT INTO research_coverage_report(hash,market_id,input_hash,status,report)
       VALUES($1,$2,$3,'VERIFIED',$4::jsonb)`,
          [reportHash, selectedMarket, inputHash, JSON.stringify(report)],
        );
        await client.query(
          `INSERT INTO backtest_run
       (id,market_id,name,status,start_date,end_date,strategies,symbols,data_source,strategy_version,
        config_version,execution_model_version,execution_assumptions,starting_capital,position_size,
        slippage_bps,fee_per_trade,parameters,research_evidence)
       VALUES($1,$2,'capture fixture','RUNNING',$3,$3,'["ORB_RETEST"]','["CAP"]','CAPTURED_QUOTES',
              $4,$5,$6,$7::jsonb,100000,1000,1,0,'{}'::jsonb,$8::jsonb)`,
          [
            runId,
            selectedMarket,
            date,
            strategyVersion,
            configVersion,
            executionModelVersion,
            JSON.stringify(assumptions),
            withLineage ? JSON.stringify(binding) : null,
          ],
        );
        if (withLineage)
          await client.query(
            `INSERT INTO research_evidence_binding
       (owner_kind,owner_id,market_id,manifest_hash,coverage_report_hash,input_hash,binding)
       VALUES('BACKTEST',$1,$2,$3,$4,$5,$6::jsonb)`,
            [
              runId,
              selectedMarket,
              manifestHash,
              reportHash,
              inputHash,
              JSON.stringify(binding),
            ],
          );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
      return { runId, instrumentId, selectedMarket, inputHash };
    }

    function capture(
      source: Awaited<ReturnType<typeof sourceRun>>,
      overrides: Partial<BacktestOpportunityCaptureInput> = {},
    ): BacktestOpportunityCaptureInput {
      return {
        marketId: source.selectedMarket,
        strategy: "ORB_RETEST",
        strategyVersion,
        configVersion,
        profileId: "00000000-0000-4000-8000-000000000082",
        profileName: "ORB",
        executionModelVersion,
        executionAssumptionsHash: assumptionsHash,
        signalSemanticsVersion: "setup-semantics-v2",
        replayId: source.runId,
        evidenceId: randomUUID(),
        opportunityId: randomUUID(),
        sessionDate: date,
        symbol: "CAP",
        instrumentId: source.instrumentId,
        baselineSelected: true,
        decisionTimestamp: `${date}T14:00:00.000Z`,
        score: 85,
        features: { atr14: 0.2, atrPct: 2, rvolAtTime: 1.5 } as never,
        outcome: {
          status: "CLOSED",
          entryTime: `${date}T14:01:00.000Z`,
          exitTime: `${date}T15:00:00.000Z`,
          entryPrice: 10,
          exitPrice: 11,
          shares: 100,
          netPnl: 12.5,
          rMultiple: 1.25,
        },
        labelAvailableAt: `${date}T15:00:00.000Z`,
        ...overrides,
      };
    }

    const output = (observations: number) =>
      ({
        metrics: { observations },
        analyses: [],
        trades: [],
        timeline: [],
        dataQuality: { spread: "CAPTURED" },
      }) as never;

    async function complete(
      runId: string,
      captures: readonly BacktestOpportunityCaptureInput[],
      observations = captures.length,
    ) {
      const store = new PostgresBacktestStore(pool);
      vi.spyOn(store, "get").mockResolvedValue({ id: runId } as never);
      return store.complete(runId, output(observations), {} as never, captures);
    }

    it("atomically persists all rows, accepts an identical retry, and keeps rows immutable", async () => {
      const source = await sourceRun();
      const captures = [capture(source), capture(source)];
      await complete(source.runId, captures);
      await complete(source.runId, captures);
      const count = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM backtest_opportunity_capture WHERE source_run_id=$1",
        [source.runId],
      );
      expect(count.rows[0]?.count).toBe("2");
      const semantics = await pool.query<{
        count: string;
        versions: string[];
      }>(
        `SELECT count(*)::text AS count,array_agg(DISTINCT signal_semantics_version) versions
           FROM backtest_opportunity_capture WHERE source_run_id=$1`,
        [source.runId],
      );
      expect(semantics.rows[0]).toEqual({
        count: "2",
        versions: ["setup-semantics-v2"],
      });
      const sourceEvidence =
        await new PostgresCanonicalSignalOpportunityCaptureRepository(
          pool,
        ).loadForSource({
          scope: {
            runId: source.runId,
            marketId: source.selectedMarket,
            strategy: "ORB_RETEST",
            strategyVersion,
            configVersion,
            profileId: "00000000-0000-4000-8000-000000000082",
            profileName: "ORB",
            executionModelVersion,
            executionAssumptionsHash: assumptionsHash,
          },
          expectedSessions: {
            TRAIN: [date],
            VALIDATION: ["2026-08-26"],
            TEST: ["2026-08-27"],
          },
        });
      expect(sourceEvidence.status).toBe("AVAILABLE");
      if (sourceEvidence.status === "AVAILABLE") {
        expect(sourceEvidence.orderedCaptures).toHaveLength(2);
        expect(sourceEvidence).toMatchObject({
          sourceRunIdentity: {
            runId: source.runId,
            status: "COMPLETED",
            marketId: source.selectedMarket,
            strategyVersion,
            configVersion,
            executionModelVersion,
            executionAssumptionsHash: assumptionsHash,
          },
          sourceDigest: source.inputHash,
          sourceBindingHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          orderedMembershipHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          orderedMembershipCount: 2,
        });
        expect(sourceEvidence.orderedCaptures).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              sourceRunId: source.runId,
              stage: "TRAIN",
              sourceFeatures: { atr14: 0.2, atrPct: 2, rvolAtTime: 1.5 },
              outcome: {
                status: "CLOSED",
                entryTime: `${date}T14:01:00.000Z`,
                exitTime: `${date}T15:00:00.000Z`,
                entryPrice: 10,
                exitPrice: 11,
                shares: 100,
                netPnl: 12.5,
                rMultiple: 1.25,
              },
            }),
          ]),
        );
      }
      await expect(
        pool.query(
          "UPDATE backtest_opportunity_capture SET score=score WHERE source_run_id=$1",
          [source.runId],
        ),
      ).rejects.toThrow("IMMUTABLE_BACKTEST_OPPORTUNITY_CAPTURE");
    });

    it("verifies the full receipt when it includes a baseline-unselected capture", async () => {
      const source = await sourceRun();
      const selected = capture(source);
      const belowCutoff = capture(source, {
        baselineSelected: false,
        evidenceId: randomUUID(),
        opportunityId: "below-cutoff",
      });
      await complete(source.runId, [selected, belowCutoff], 2);

      const result =
        await new PostgresCanonicalSignalOpportunityCaptureRepository(
          pool,
        ).loadForSource({
          scope: {
            runId: source.runId,
            marketId: source.selectedMarket,
            strategy: "ORB_RETEST",
            strategyVersion,
            configVersion,
            profileId: "00000000-0000-4000-8000-000000000082",
            profileName: "ORB",
            executionModelVersion,
            executionAssumptionsHash: assumptionsHash,
          },
          expectedSessions: {
            TRAIN: [date],
            VALIDATION: ["2026-08-26"],
            TEST: ["2026-08-27"],
          },
        });

      expect(result.status).toBe("AVAILABLE");
      if (result.status === "AVAILABLE") {
        expect(result.orderedMembershipCount).toBe(2);
        expect(
          result.orderedCaptures.map((row) => row.opportunityId).sort(),
        ).toEqual(["below-cutoff", selected.opportunityId].sort());
        expect(
          result.orderedCaptures.find(
            (row) => row.opportunityId === "below-cutoff",
          ),
        ).toMatchObject({
          baselineSelected: false,
          outcome: { status: "CLOSED", rMultiple: 1.25 },
        });
      }
    });

    it("authorizes, dispatches, resumes and charges one frozen candidate across all phase receipts", async () => {
      const source = await sourceRun();
      const sessions = {
        TRAIN: [
          "2026-06-01",
          "2026-06-02",
          "2026-06-03",
          "2026-06-04",
          "2026-06-05",
          "2026-06-06",
        ],
        VALIDATION: ["2026-06-08", "2026-06-09"],
        TEST: [
          "2026-06-11",
          "2026-06-12",
          "2026-06-13",
          "2026-06-14",
          "2026-06-15",
          "2026-06-16",
        ],
      };
      let ordinal = 0;
      const captures = (
        Object.entries(sessions) as [keyof typeof sessions, readonly string[]][]
      ).flatMap(([stage, stageDates]) =>
        stageDates.flatMap((sessionDate, sessionIndex) =>
          Array.from({ length: stage === "TEST" ? 2 : 4 }, (_, rowIndex) => {
            ordinal += 1;
            const decisionTimestamp = `${sessionDate}T14:00:${String(rowIndex).padStart(2, "0")}.000Z`;
            const labelAvailableAt = `${sessionDate}T15:00:00.000Z`;
            return capture(source, {
              sessionDate,
              opportunityId: `opportunity-${String(ordinal).padStart(4, "0")}`,
              baselineSelected: !(
                stage === "TRAIN" &&
                sessionIndex === 0 &&
                rowIndex === 0
              ),
              decisionTimestamp,
              labelAvailableAt,
              outcome: {
                status: "CLOSED",
                entryTime: `${sessionDate}T14:01:00.000Z`,
                exitTime: labelAvailableAt,
                entryPrice: 10,
                exitPrice: 11,
                shares: 100,
                netPnl: 12.5 + (sessionIndex % 2 === 0 ? -0.01 : 0.01),
                rMultiple: 1.25,
              },
            });
          }),
        ),
      );
      await complete(source.runId, captures, captures.length);
      const scope = {
        runId: source.runId,
        marketId: source.selectedMarket,
        strategy: "ORB_RETEST",
        strategyVersion,
        configVersion,
        profileId: "00000000-0000-4000-8000-000000000082",
        profileName: "ORB",
        executionModelVersion,
        executionAssumptionsHash: assumptionsHash,
      } as const;
      const canonical =
        await new PostgresCanonicalSignalOpportunityCaptureRepository(
          pool,
        ).loadForSource({ scope, expectedSessions: sessions });
      expect(canonical.status).toBe("AVAILABLE");
      if (canonical.status !== "AVAILABLE") return;
      const membership = (stage: "TRAIN" | "VALIDATION" | "TEST") => {
        const opportunityIds = canonical.orderedCaptures
          .filter((row) => row.stage === stage)
          .map((row) => row.opportunityId);
        return {
          opportunityIds,
          membershipHash: contentHash({
            sourceRunId: source.runId,
            marketId: source.selectedMarket,
            sessionDates: sessions[stage],
            opportunityIds,
          }),
        };
      };
      const plan = signalModelResearchPlanSchema.parse({
        version: "signal-model-experiment-v1",
        experimentId: randomUUID(),
        source: {
          ...scope,
          sourceDigest: canonical.sourceDigest,
          sourceBindingHash: canonical.sourceBindingHash,
          orderedMembershipHash: canonical.orderedMembershipHash,
          orderedMembershipCount: canonical.orderedMembershipCount,
        },
        sessions,
        membership: {
          TRAIN: membership("TRAIN"),
          VALIDATION: membership("VALIDATION"),
          TEST: membership("TEST"),
        },
        overlapPurge: {
          labelHorizonSessions: 1,
          trainValidationPurgeSessions: ["2026-06-07"],
          validationTestPurgeSessions: ["2026-06-10"],
        },
        model: {
          minimumTrainingSamples: 20,
          thresholdCandidates: [0, 50, 90],
          l2Penalty: 0.1,
        },
        comparison: {
          minimumUsefulNetPnlPerSelectedOpportunity: 0.25,
          unit: "CAD",
          alpha: 0.05,
          targetPower: 0.8,
          minimumIndependentSessions: 2,
          minimumValidationSessions: 2,
          minimumClosedOutcomes: 20,
          maximumMissedWinnerRate: 0.25,
          maximumDrawdownIncrease: 100,
          maximumTurnoverIncrease: 0.1,
          maximumLargestSymbolShare: 1,
          maximumLargestSessionShare: 1,
          bootstrapSamples: 1000,
          blockLength: 2,
          seed: 17,
          extraCostScenarios: [],
        },
        trialBudget: 1,
      }) as SignalModelResearchPlan;
      const authorization = {
        id: randomUUID(),
        marketId: source.selectedMarket,
        frozenPlanHash: contentHash(plan),
        sourceDigest: canonical.sourceDigest,
        sourceBindingHash: canonical.sourceBindingHash,
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        trialBudget: 1,
        mode: "EXECUTE_WHEN_READY" as const,
      };
      const control = new PostgresSignalModelResearchControlStore(pool);
      const prepared = await control.createAuthorization({
        authorization,
        plan,
        idempotencyKey: `auth:${authorization.id}`,
      });
      expect(
        await control.createAuthorization({
          authorization,
          plan,
          idempotencyKey: `auth:${authorization.id}`,
        }),
      ).toEqual(prepared);
      const readiness = await control.preflight(plan);
      expect(readiness.status).toBe("READY");
      expect(readiness.usableTrainingRows).toBe(23);
      expect(plan.membership.TRAIN.opportunityIds).toContain(
        "opportunity-0001",
      );
      expect(readiness.estimatedPowerMethod).toBe(
        "UNVALIDATED_TRAINING_SESSION_MEAN_PROXY",
      );
      expect(readiness.estimatedPowerLimitations).toHaveLength(2);

      const dispatched = await control.dispatch(
        authorization.id,
        `dispatch:${authorization.id}`,
      );
      expect(dispatched.state).toBe("DISPATCHED");
      if (dispatched.state !== "DISPATCHED") return;
      expect(
        await control.dispatch(
          authorization.id,
          `dispatch:${authorization.id}`,
        ),
      ).toEqual({ state: "USED" });
      await pool.query(
        `UPDATE research_job SET status='RUNNING',lease_owner='model-test-worker',lease_expires_at=clock_timestamp()+interval '5 minutes',attempt_count=1 WHERE id=$1`,
        [dispatched.jobId],
      );
      const fence = {
        jobId: dispatched.jobId,
        leaseOwner: "model-test-worker",
        attemptCount: 1,
      };
      const candidate = contentHash({
        experiment: plan.experimentId,
        candidate: "one",
      });
      const stageAttempt = async (
        stage: "TRAIN" | "VALIDATION" | "TEST",
        claimId: string,
        attemptId: string,
        outcome: Record<string, unknown>,
      ) =>
        control.appendAttempt({
          authorizationId: authorization.id,
          fence,
          claimId,
          attemptId,
          stage,
          candidateIdentity: candidate,
          status: "SUCCEEDED",
          outcome,
        });

      const trainClaim = await control.claimStage(
        authorization.id,
        "TRAIN",
        fence,
        randomUUID(),
        plan.membership.TRAIN.membershipHash,
      );
      const trainAttemptId = randomUUID();
      const trainOutcome = { trainingRows: 23 };
      await stageAttempt(
        "TRAIN",
        trainClaim.claim_id,
        trainAttemptId,
        trainOutcome,
      );
      const validationClaim = await control.claimStage(
        authorization.id,
        "VALIDATION",
        fence,
        randomUUID(),
        plan.membership.VALIDATION.membershipHash,
      );
      await stageAttempt("VALIDATION", validationClaim.claim_id, randomUUID(), {
        selectedCandidateIdentity: candidate,
        selectedThreshold: 50,
      });
      const testClaim = await control.claimStage(
        authorization.id,
        "TEST",
        fence,
        randomUUID(),
        plan.membership.TEST.membershipHash,
      );
      await expect(
        stageAttempt("TEST", testClaim.claim_id, randomUUID(), {
          evaluation: "before claim consumption",
        }),
      ).rejects.toThrow("SIGNAL_MODEL_TEST_CLAIM_NOT_CONSUMED");
      const finalTestRequest = {
        claimId: testClaim.claim_id,
        sourceRunId: source.runId,
        marketId: source.selectedMarket,
        membershipHash: plan.membership.TEST.membershipHash,
      };
      expect(await control.consumeFinalTestClaim(finalTestRequest)).toEqual(
        finalTestRequest,
      );
      // A crash after durable consumption but before the report must let the
      // same claim resume while its execution job still has a live lease.
      expect(await control.consumeFinalTestClaim(finalTestRequest)).toEqual(
        finalTestRequest,
      );
      expect(
        await control.consumeFinalTestClaim({
          ...finalTestRequest,
          membershipHash: contentHash("changed-test-membership"),
        }),
      ).toBeNull();
      expect(
        await control.consumeFinalTestClaim({
          ...finalTestRequest,
          sourceRunId: randomUUID(),
        }),
      ).toBeNull();
      await stageAttempt("TEST", testClaim.claim_id, randomUUID(), {
        evaluation: "consumed",
      });

      const artifact = {
        artifactVersion: "1.0.0",
        modelType: "LOGISTIC_SETUP_QUALITY",
        featureNames: ["score", "atrPct", "logRvol", "minutesFromOpen"],
        intercept: 0,
        coefficients: [0, 0, 0, 0],
        means: [0, 0, 0, 0],
        scales: [1, 1, 1, 1],
        medians: [0, 0, 0, 0],
        atrMedian: 1,
        rvolMedian: 1,
      } as StatisticalModelArtifact;
      const trainingMetrics = {
        samples: 24,
        positives: 12,
        negatives: 12,
        baseRate: 0.5,
        brierScore: 0.1,
        baselineBrierScore: 0.2,
        logLoss: 0.3,
        rocAuc: 0.6,
      };
      await control.recordReport({
        authorizationId: authorization.id,
        fence,
        report: {
          experimentId: plan.experimentId,
          sourceDigest: plan.source.sourceDigest,
          planHash: authorization.frozenPlanHash,
          status: "INSUFFICIENT",
          selectedCandidateIdentity: candidate,
          selectedThreshold: 50,
          evaluation: {
            inactive: true,
            eligibleForActivation: false,
            trainingMetrics,
          },
          reasonCodes: [
            "DRAWDOWN_GATE_UNAVAILABLE_FROM_INDEPENDENT_OPPORTUNITIES",
          ],
        },
      });
      const handoff = {
        pool,
        authorizationId: authorization.id,
        plan,
        planHash: authorization.frozenPlanHash,
        modelVersion: candidate,
        artifact,
        // Recovery after the report was committed must use its frozen metrics.
        // The original worker invocation's in-memory metrics are no longer available.
        trainMetrics: null,
        testMetrics: null,
        warnings: ["INACTIVE_RESEARCH_ONLY", "TRAIN_METRICS_ARE_IN_SAMPLE"],
      };
      const modelId = await persistCapturedResearchCandidate(handoff);
      expect(await persistCapturedResearchCandidate(handoff)).toBe(modelId);
      const model = await pool.query<{
        status: string;
        active: boolean;
        eligible_for_activation: boolean;
        source_kind: string;
      }>(
        "SELECT status,active,eligible_for_activation,source_kind FROM statistical_model WHERE id=$1",
        [modelId],
      );
      expect(model.rows[0]).toEqual({
        status: "COMPLETED",
        active: false,
        eligible_for_activation: false,
        source_kind: "CAPTURED_BACKTEST_RESEARCH",
      });
      const prospective = await new PostgresChallengerExperimentStore(
        pool,
      ).getModel(modelId);
      expect(prospective).toMatchObject({
        id: modelId,
        status: "COMPLETED",
        active: false,
        researchEvidenceVerified: true,
        scope: {
          marketId: "CA_TSX",
          currency: "CAD",
          strategy: "ORB_RETEST",
          strategyVersion,
          profileConfigId: scope.profileId,
          configVersion,
          executionModelVersion,
          executionAssumptionsHash: assumptionsHash,
          signalSemanticsVersion: "setup-semantics-v2",
          replayScope: "FORWARD_LIVE",
        },
      });
      await expect(
        pool.query("UPDATE statistical_model SET active=true WHERE id=$1", [
          modelId,
        ]),
      ).rejects.toThrow();
      await expect(
        persistCapturedResearchCandidate({
          ...handoff,
          plan: {
            ...plan,
            source: {
              ...plan.source,
              sourceDigest: contentHash("mismatched-source"),
            },
          },
        }),
      ).rejects.toThrow("SIGNAL_MODEL_CANDIDATE_AUTHORITY_UNAVAILABLE");

      const receipts = await pool.query<{ stage: string; trial_cost: number }>(
        "SELECT stage,trial_cost FROM signal_model_research_stage_claim WHERE authorization_id=$1 ORDER BY stage",
        [authorization.id],
      );
      expect(receipts.rows).toEqual([
        { stage: "TEST", trial_cost: 0 },
        { stage: "TRAIN", trial_cost: 1 },
        { stage: "VALIDATION", trial_cost: 0 },
      ]);
      const attemptCount = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM signal_model_research_attempt WHERE authorization_id=$1",
        [authorization.id],
      );
      expect(attemptCount.rows[0]?.count).toBe("3");

      const reusedPlan = signalModelResearchPlanSchema.parse({
        ...plan,
        experimentId: randomUUID(),
      });
      const reusedAuthorization = {
        ...authorization,
        id: randomUUID(),
        frozenPlanHash: contentHash(reusedPlan),
      };
      await control.createAuthorization({
        authorization: reusedAuthorization,
        plan: reusedPlan,
        idempotencyKey: `auth:${reusedAuthorization.id}`,
      });
      const reusedDispatch = await control.dispatch(
        reusedAuthorization.id,
        `dispatch:${reusedAuthorization.id}`,
      );
      expect(reusedDispatch.state).toBe("DISPATCHED");
      if (reusedDispatch.state !== "DISPATCHED") return;
      await pool.query(
        `UPDATE research_job SET status='RUNNING',lease_owner='model-reuse-worker',lease_expires_at=clock_timestamp()+interval '5 minutes',attempt_count=1 WHERE id=$1`,
        [reusedDispatch.jobId],
      );
      const capacityPlan = signalModelResearchPlanSchema.parse({
        ...plan,
        experimentId: randomUUID(),
      });
      const capacityAuthorization = {
        ...authorization,
        id: randomUUID(),
        frozenPlanHash: contentHash(capacityPlan),
      };
      await control.createAuthorization({
        authorization: capacityAuthorization,
        plan: capacityPlan,
        idempotencyKey: `auth:${capacityAuthorization.id}`,
      });
      expect(
        await control.dispatch(
          capacityAuthorization.id,
          `dispatch:${capacityAuthorization.id}`,
        ),
      ).toEqual({ state: "WAITING" });
      expect(await control.dispatchAuthorizedReady(2)).toBe(0);
      expect(await control.dispatchAuthorizedReady(2)).toBe(0);
      const capacityState = await pool.query<{
        outstanding: number;
        third_job_id: string | null;
        blocker: string[];
      }>(
        `SELECT
           (SELECT count(*)::int FROM research_job WHERE job_type='SIGNAL_MODEL_RESEARCH' AND status IN ('QUEUED','RUNNING','CANCELLING')) AS outstanding,
           a.dispatched_job_id AS third_job_id,
           (SELECT blockers FROM signal_model_research_readiness_check WHERE authorization_id=a.id ORDER BY checked_at DESC,id DESC LIMIT 1) AS blocker
         FROM signal_model_research_authorization a WHERE a.id=$1`,
        [capacityAuthorization.id],
      );
      expect(capacityState.rows[0]).toEqual({
        outstanding: 2,
        third_job_id: null,
        blocker: ["RESEARCH_CAPACITY_FULL"],
      });
      const reusedFence = {
        jobId: reusedDispatch.jobId,
        leaseOwner: "model-reuse-worker",
        attemptCount: 1,
      };
      const reusedCandidate = contentHash({
        experiment: reusedPlan.experimentId,
        candidate: "one",
      });
      const reusedTrainClaim = await control.claimStage(
        reusedAuthorization.id,
        "TRAIN",
        reusedFence,
        randomUUID(),
        reusedPlan.membership.TRAIN.membershipHash,
      );
      await control.appendAttempt({
        authorizationId: reusedAuthorization.id,
        fence: reusedFence,
        claimId: reusedTrainClaim.claim_id,
        attemptId: randomUUID(),
        stage: "TRAIN",
        candidateIdentity: reusedCandidate,
        status: "SUCCEEDED",
        outcome: { trainingRows: 23 },
      });
      const reusedValidationClaim = await control.claimStage(
        reusedAuthorization.id,
        "VALIDATION",
        reusedFence,
        randomUUID(),
        reusedPlan.membership.VALIDATION.membershipHash,
      );
      await control.appendAttempt({
        authorizationId: reusedAuthorization.id,
        fence: reusedFence,
        claimId: reusedValidationClaim.claim_id,
        attemptId: randomUUID(),
        stage: "VALIDATION",
        candidateIdentity: reusedCandidate,
        status: "SUCCEEDED",
        outcome: {
          selectedCandidateIdentity: reusedCandidate,
          selectedThreshold: 50,
        },
      });
      const reusedTestClaim = await control.claimStage(
        reusedAuthorization.id,
        "TEST",
        reusedFence,
        randomUUID(),
        reusedPlan.membership.TEST.membershipHash,
      );
      expect(
        await control.consumeFinalTestClaim({
          claimId: reusedTestClaim.claim_id,
          sourceRunId: source.runId,
          marketId: source.selectedMarket,
          membershipHash: reusedPlan.membership.TEST.membershipHash,
        }),
      ).toBeNull();
      const consumedMemberships = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM signal_model_research_test_consumption WHERE market_id=$1 AND source_digest=$2",
        [source.selectedMarket, canonical.sourceDigest],
      );
      expect(consumedMemberships.rows[0]?.count).toBe("1");

      await pool.query(
        "UPDATE research_job SET lease_owner='model-test-worker-restarted',attempt_count=2,lease_expires_at=clock_timestamp()+interval '5 minutes' WHERE id=$1",
        [dispatched.jobId],
      );
      const restartedFence = {
        jobId: dispatched.jobId,
        leaseOwner: "model-test-worker-restarted",
        attemptCount: 2,
      };
      // The attempt-2 lease is still the same fenced execution job and claim.
      // It may finish reporting after recovering the consumed TEST receipt.
      expect(await control.consumeFinalTestClaim(finalTestRequest)).toEqual(
        finalTestRequest,
      );
      expect(
        await control.claimStage(
          authorization.id,
          "TRAIN",
          restartedFence,
          trainClaim.claim_id,
          plan.membership.TRAIN.membershipHash,
        ),
      ).toEqual(trainClaim);
      await control.appendAttempt({
        authorizationId: authorization.id,
        fence: restartedFence,
        claimId: trainClaim.claim_id,
        attemptId: trainAttemptId,
        stage: "TRAIN",
        candidateIdentity: candidate,
        status: "SUCCEEDED",
        outcome: trainOutcome,
      });
      await control.revoke(authorization.id, `revoke:${authorization.id}`);
      expect(
        (
          await control.dispatch(
            authorization.id,
            `dispatch-after-revoke:${authorization.id}`,
          )
        ).state,
      ).toBe("REVOKED");
      await expect(
        control.claimStage(
          authorization.id,
          "TRAIN",
          restartedFence,
          randomUUID(),
          plan.membership.TRAIN.membershipHash,
        ),
      ).rejects.toThrow("SIGNAL_MODEL_ACTIVE_JOB_REQUIRED");
    }, 60000);

    it("rolls back the run and all captures when a later row violates market ownership", async () => {
      const source = await sourceRun();
      const good = capture(source);
      const wrongMarket = capture(source, { marketId: "US_EQUITIES" });
      await expect(complete(source.runId, [good, wrongMarket])).rejects.toThrow(
        "BACKTEST_OPPORTUNITY_CAPTURE_SCOPE_MISMATCH",
      );
      const run = await pool.query<{ status: string }>(
        "SELECT status FROM backtest_run WHERE id=$1",
        [source.runId],
      );
      const rows = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM backtest_opportunity_capture WHERE source_run_id=$1",
        [source.runId],
      );
      expect(run.rows[0]?.status).toBe("RUNNING");
      expect(rows.rows[0]?.count).toBe("0");
    });

    it("rejects an incomplete opportunity set before committing the run", async () => {
      const source = await sourceRun();
      await expect(
        complete(source.runId, [capture(source)], 2),
      ).rejects.toThrow("BACKTEST_OPPORTUNITY_CAPTURE_PARTIAL");
      const run = await pool.query<{ status: string }>(
        "SELECT status FROM backtest_run WHERE id=$1",
        [source.runId],
      );
      expect(run.rows[0]?.status).toBe("RUNNING");
    });

    it("rejects duplicate opportunity/evidence identities before any row commits", async () => {
      const source = await sourceRun();
      const duplicate = capture(source);
      await expect(
        complete(source.runId, [duplicate, duplicate]),
      ).rejects.toThrow("BACKTEST_OPPORTUNITY_CAPTURE_DUPLICATE");
      const rows = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM backtest_opportunity_capture WHERE source_run_id=$1",
        [source.runId],
      );
      expect(rows.rows[0]?.count).toBe("0");
    });

    it("does not write or expose captures for an unverified legacy run", async () => {
      const source = await sourceRun("CA_TSX", false);
      await complete(source.runId, [capture(source)]);
      const unavailable =
        await new PostgresCanonicalSignalOpportunityCaptureRepository(
          pool,
        ).loadForSource({
          scope: {
            runId: source.runId,
            marketId: source.selectedMarket,
            strategy: "ORB_RETEST",
            strategyVersion,
            configVersion,
            profileId: "00000000-0000-4000-8000-000000000082",
            profileName: "ORB",
            executionModelVersion,
            executionAssumptionsHash: assumptionsHash,
          },
          expectedSessions: {
            TRAIN: [date],
            VALIDATION: ["2026-08-26"],
            TEST: ["2026-08-27"],
          },
        });
      expect(unavailable.status).toBe("UNAVAILABLE");
      expect(unavailable.reasonCodes).toContain("LINEAGE_UNVERIFIED");
      const count = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM backtest_opportunity_capture WHERE source_run_id=$1",
        [source.runId],
      );
      expect(count.rows[0]?.count).toBe("0");
    });

    it("rejects labels available before the decision timestamp", async () => {
      const source = await sourceRun("US_EQUITIES");
      const invalid = capture(source, {
        labelAvailableAt: `${date}T13:59:59.000Z`,
      });
      await expect(complete(source.runId, [invalid])).rejects.toThrow();
      const rows = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM backtest_opportunity_capture WHERE source_run_id=$1",
        [source.runId],
      );
      expect(rows.rows[0]?.count).toBe("0");
    });

    it("keeps a verified US replay unavailable to a Canadian source scope", async () => {
      const source = await sourceRun("US_EQUITIES");
      await complete(source.runId, [capture(source)]);
      const scoped =
        await new PostgresCanonicalSignalOpportunityCaptureRepository(
          pool,
        ).loadForSource({
          scope: {
            runId: source.runId,
            marketId: "CA_TSX",
            strategy: "ORB_RETEST",
            strategyVersion,
            configVersion,
            profileId: "00000000-0000-4000-8000-000000000082",
            profileName: "ORB",
            executionModelVersion,
            executionAssumptionsHash: assumptionsHash,
          },
          expectedSessions: {
            TRAIN: [date],
            VALIDATION: ["2026-08-26"],
            TEST: ["2026-08-27"],
          },
        });
      expect(scoped.status).toBe("UNAVAILABLE");
      expect(scoped.reasonCodes).toContain("SOURCE_SCOPE_MISMATCH");
    });

    it("withholds TEST outcomes until the exact final-test claim is consumed", async () => {
      const source = await sourceRun();
      const sessions = [date, "2026-08-26", "2026-08-27"] as const;
      const captures = sessions.map((sessionDate) => {
        const timestamp = `${sessionDate}T14:00:00.000Z`;
        const labelTimestamp = `${sessionDate}T15:00:00.000Z`;
        return capture(source, {
          sessionDate,
          decisionTimestamp: timestamp,
          labelAvailableAt: labelTimestamp,
          outcome: {
            status: "CLOSED",
            entryTime: `${sessionDate}T14:01:00.000Z`,
            exitTime: labelTimestamp,
            entryPrice: 10,
            exitPrice: 11,
            shares: 100,
            netPnl: 12.5,
            rMultiple: 1.25,
          },
        });
      });
      await complete(source.runId, captures);
      const scope = {
        runId: source.runId,
        marketId: source.selectedMarket,
        strategy: "ORB_RETEST",
        strategyVersion,
        configVersion,
        profileId: "00000000-0000-4000-8000-000000000082",
        profileName: "ORB",
        executionModelVersion,
        executionAssumptionsHash: assumptionsHash,
      } as const;
      const expectedSessions = {
        TRAIN: [sessions[0]],
        VALIDATION: [sessions[1]],
        TEST: [sessions[2]],
      };
      const gate = {
        consumeFinalTestClaim: vi.fn(
          async (request: {
            claimId: string;
            sourceRunId: string;
            marketId: "CA_TSX" | "US_EQUITIES";
            membershipHash: string;
          }) => request,
        ),
      };
      const reader = new PostgresCanonicalSignalOpportunityCaptureRepository(
        pool,
        gate,
      );
      const sourceView = await reader.loadForSource({
        scope,
        expectedSessions,
      });
      expect(sourceView.status).toBe("AVAILABLE");
      if (sourceView.status !== "AVAILABLE") return;
      const testRow = sourceView.orderedCaptures.find(
        (row) => row.stage === "TEST",
      );
      expect(testRow?.outcome).toBeNull();
      expect(testRow?.labelAvailableAt).toBeNull();
      expect(sourceView.testOutcomesReleased).toBe(false);
      const released = await reader.loadTestAfterClaim({
        scope,
        expectedSessions,
        claimId: randomUUID(),
        expectedTestMembershipHash: sourceView.testMembershipHash,
      });
      expect(gate.consumeFinalTestClaim).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceRunId: source.runId,
          marketId: source.selectedMarket,
          membershipHash: sourceView.testMembershipHash,
        }),
      );
      expect(released.status).toBe("AVAILABLE");
      if (released.status === "AVAILABLE") {
        expect(released.testOutcomesReleased).toBe(true);
        expect(
          released.orderedCaptures.find((row) => row.stage === "TEST")?.outcome,
        ).toMatchObject({ status: "CLOSED", rMultiple: 1.25 });
      }
    });
  },
);
