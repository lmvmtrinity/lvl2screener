import { describe, expect, it } from "vitest";
import {
  createCalibrationSchema,
  type CalibrationRun,
  type CreateCalibration,
  type ResearchJob,
  type ResearchJobType,
} from "@tsx-scanner/contracts";
import {
  buildApp,
  type CalibrationApi,
  type ResearchJobApi,
} from "../src/app.js";
import type { DependencyProbe } from "../src/foundation/probes.js";
import { FoundationStatusService } from "../src/foundation/status-service.js";

const jobId = "10000000-0000-4000-8000-000000000091";
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
      createdAt: "2026-08-25T00:00:00.000Z",
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

const probe: DependencyProbe = { check: async () => ({ status: "ok" }) },
  status = () =>
    new FoundationStatusService({
      database: probe,
      scanner: probe,
      marketData: probe,
    });
const id = "10000000-0000-4000-8000-000000000099",
  input = createCalibrationSchema.parse({
    name: "Calibration",
    startDate: "2026-01-01",
    endDate: "2026-06-30",
    strategy: "ORB_RETEST",
  });
const run = {
  id,
  marketId: "CA_TSX",
  name: input.name,
  status: "COMPLETED",
  startDate: input.startDate,
  endDate: input.endDate,
  strategy: input.strategy,
  symbols: [],
  dataSource: "CAPTURED_QUOTES",
  executionModelVersion: "legacy-python-v1",
  executionAssumptions: {},
  input,
  capturedHistoryAvailability: null,
  combinationsTested: 1,
  totalCombinations: 1,
  truncated: false,
  splitDates: { trainEnd: "2026-04-18", validationEnd: "2026-05-24" },
  recommendation: "No robust calibration is supported yet.",
  recommendedConfig: null,
  trials: [],
  holdoutSelection: null,
  error: null,
  createdAt: "2026-08-25T00:00:00.000Z",
  startedAt: null,
  completedAt: null,
} as CalibrationRun;
class Calibrations implements CalibrationApi {
  created?: CreateCalibration;
  async list() {
    return [run];
  }
  async get() {
    return run;
  }
  async create(value: CreateCalibration) {
    this.created = value;
    return run;
  }
}

describe("Phase 9 calibration API", () => {
  it("validates, enqueues, lists, and reads calibration research", async () => {
    const service = new Calibrations(),
      jobs = new FakeResearchJobs(),
      app = await buildApp({
        statusService: status(),
        calibrationService: service,
        researchJobService: jobs,
      });
    expect(
      (await app.inject({ method: "GET", url: "/api/calibrations" })).json(),
    ).toEqual({ calibrations: [run] });
    const response = await app.inject({
      method: "POST",
      url: "/api/calibrations",
      payload: {
        name: "Study",
        startDate: "2026-01-01",
        endDate: "2026-06-30",
        strategy: "ORB_RETEST",
      },
    });
    expect(response.statusCode, response.body).toBe(202);
    expect(jobs.created?.jobType).toBe("CALIBRATION");
    expect(
      (jobs.created?.payload as CreateCalibration | undefined)?.grid.atrPctMin,
    ).toEqual([1.5]);
    expect(
      (await app.inject({ method: "GET", url: `/api/calibrations/${id}` }))
        .statusCode,
    ).toBe(200);
    await app.close();
  });
  it("rejects malformed calibration requests", async () => {
    const app = await buildApp({
      statusService: status(),
      calibrationService: new Calibrations(),
      researchJobService: new FakeResearchJobs(),
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/calibrations",
          payload: {},
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: "GET", url: "/api/calibrations/nope" }))
        .statusCode,
    ).toBe(400);
    const usStudy = await app.inject({
      method: "POST",
      url: "/api/calibrations",
      payload: {
        name: "Underpowered US study",
        marketId: "US_EQUITIES",
        startDate: "2026-01-01",
        endDate: "2026-06-30",
        strategy: "ORB_RETEST",
        minimumTradesPerSegment: 1,
        trainPct: 50,
        validationPct: 20,
      },
    });
    expect(usStudy.statusCode, usStudy.body).toBe(400);
    await app.close();
  });
});
