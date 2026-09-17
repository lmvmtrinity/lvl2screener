import { describe, expect, it } from "vitest";
import {
  createStatisticalModelSchema,
  statisticalModelSchema,
  type ActiveStatisticalPredictions,
  type CreateStatisticalModel,
  type PaperEvidenceCohort,
  type ResearchJob,
  type ResearchJobType,
  type StatisticalModel,
  type StatisticalPredictionBatch,
  type StrategyEvaluation,
} from "@tsx-scanner/contracts";
import {
  buildApp,
  type PaperEvidenceTrainingApi,
  type ResearchJobApi,
  type StatisticalModelApi,
} from "../src/app.js";
import type { DependencyProbe } from "../src/foundation/probes.js";
import { FoundationStatusService } from "../src/foundation/status-service.js";

const jobId = "10000000-0000-4000-8000-000000000013";
class FakeResearchJobs implements ResearchJobApi {
  created?: { jobType: ResearchJobType; payload: unknown };
  async createJob(
    jobType: ResearchJobType,
    payload: unknown,
  ): Promise<ResearchJob> {
    this.created = { jobType, payload };
    return {
      id: jobId,
      jobType,
      status: "QUEUED",
      resultRefId: null,
      progress: {},
      error: null,
      errorCategory: null,
      attemptCount: 0,
      maxAttempts: 3,
      cancellationRequested: false,
      createdAt: "2026-08-26T00:00:00.000Z",
      startedAt: null,
      completedAt: null,
    };
  }
  async get(): Promise<ResearchJob | undefined> {
    return undefined;
  }
  async requestCancellation(): Promise<ResearchJob | undefined> {
    return undefined;
  }
}

const probe: DependencyProbe = { check: async () => ({ status: "ok" }) };
const status = () =>
  new FoundationStatusService({
    database: probe,
    scanner: probe,
    marketData: probe,
  });
const id = "10000000-0000-4000-8000-000000000012",
  runId = "10000000-0000-4000-8000-000000000008";
const input = createStatisticalModelSchema.parse({
  name: "ORB setup quality",
  backtestRunId: runId,
  strategy: "ORB_RETEST",
});
const model = statisticalModelSchema.parse({
  id,
  name: input.name,
  status: "INSUFFICIENT_DATA",
  modelType: "LOGISTIC_SETUP_QUALITY",
  modelVersion: "phase12-test",
  sourceKind: "BACKTEST_RUN",
  backtestRunId: runId,
  trainingDatasetId: null,
  strategy: "ORB_RETEST",
  input,
  artifact: null,
  trainMetrics: null,
  testMetrics: null,
  calibration: [],
  eligibleForActivation: false,
  active: false,
  warnings: ["Need more data"],
  error: null,
  trainingStart: null,
  trainingEnd: null,
  testStart: null,
  testEnd: null,
  createdAt: "2026-08-26T00:00:00.000Z",
  startedAt: null,
  completedAt: "2026-08-26T00:00:01.000Z",
});

class Models implements StatisticalModelApi {
  created?: CreateStatisticalModel;
  async list(): Promise<StatisticalModel[]> {
    return [model];
  }
  async get(): Promise<StatisticalModel> {
    return model;
  }
  async create(value: CreateStatisticalModel): Promise<StatisticalModel> {
    this.created = value;
    return model;
  }
  async activate(): Promise<StatisticalModel> {
    return model;
  }
  async deactivate(): Promise<StatisticalModel> {
    return model;
  }
  async predictions(
    _id: string,
    _values: StrategyEvaluation[],
  ): Promise<StatisticalPredictionBatch> {
    return { modelId: id, modelVersion: model.modelVersion, predictions: [] };
  }
  async activePredictions(
    _values: StrategyEvaluation[],
  ): Promise<ActiveStatisticalPredictions> {
    return { models: [] };
  }
}
class PaperEvidenceTraining implements PaperEvidenceTrainingApi {
  async listCohorts(): Promise<PaperEvidenceCohort[]> {
    return [
      {
        marketId: "CA_TSX",
        strategy: "ORB_RETEST",
        strategyVersion: "v1",
        profileConfigId: "10000000-0000-4000-8000-000000000001",
        configVersion: "config-v1",
        executionModelVersion: "paper-execution-v1",
        assumptions: { positionSize: 100 },
        closedQuoteCount: 12,
        positives: 6,
        negatives: 6,
        firstSignalAt: "2026-08-01T14:00:00.000Z",
        lastSignalAt: "2026-08-02T14:00:00.000Z",
        missingFeatureCount: 0,
      },
    ];
  }
}

describe("Phase 12 statistical model API", () => {
  it("validates, creates, lists, reads, and exposes supplemental predictions", async () => {
    const service = new Models(),
      jobs = new FakeResearchJobs(),
      app = await buildApp({
        statusService: status(),
        statisticalModelService: service,
        researchJobService: jobs,
        paperEvidenceTrainingService: new PaperEvidenceTraining(),
      });
    expect(
      (
        await app.inject({ method: "GET", url: "/api/statistical-models" })
      ).json(),
    ).toEqual({ models: [model] });
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/statistical-models/paper-evidence/cohorts",
        })
      ).json(),
    ).toMatchObject({ cohorts: [{ closedQuoteCount: 12 }] });
    const response = await app.inject({
      method: "POST",
      url: "/api/statistical-models",
      payload: {
        name: "Research",
        backtestRunId: runId,
        strategy: "ORB_RETEST",
      },
    });
    expect(response.statusCode, response.body).toBe(202);
    expect(jobs.created?.jobType).toBe("STATISTICAL_TRAINING");
    expect(
      (jobs.created?.payload as CreateStatisticalModel | undefined)
        ?.minimumSamples,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/statistical-models/${id}`,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/statistical-models/${id}/predictions`,
        })
      ).json(),
    ).toMatchObject({ modelId: id, predictions: [] });
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/statistical-models/active/predictions",
        })
      ).json(),
    ).toEqual({ models: [] });
    await app.close();
  });
  it("rejects malformed research requests and identifiers", async () => {
    const app = await buildApp({
      statusService: status(),
      statisticalModelService: new Models(),
      researchJobService: new FakeResearchJobs(),
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/statistical-models",
          payload: {},
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: "GET", url: "/api/statistical-models/nope" }))
        .statusCode,
    ).toBe(400);
    await app.close();
  });
});
