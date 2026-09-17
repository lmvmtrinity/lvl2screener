import {
  createRankingResearchSchema,
  type CreateRankingResearch,
  type RankingResearchRun,
  type ResearchJob,
  type ResearchJobType,
} from "@tsx-scanner/contracts";
import { describe, expect, it } from "vitest";
import {
  buildApp,
  type RankingResearchApi,
  type ResearchJobApi,
} from "../src/app.js";
import type { DependencyProbe } from "../src/foundation/probes.js";
import { FoundationStatusService } from "../src/foundation/status-service.js";

const jobId = "10000000-0000-4000-8000-000000000109";
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
      createdAt: "2026-08-28T00:00:00.000Z",
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
const id = "10000000-0000-4000-8000-000000000107",
  backtestRunId = "10000000-0000-4000-8000-000000000108";
const input = createRankingResearchSchema.parse({
  name: "Holdout",
  backtestRunId,
  formulaVersions: ["ranking-bounded-context-research-v1"],
});
const study = {
  id,
  marketId: "CA_TSX",
  name: input.name,
  status: "COMPLETED",
  backtestRunId,
  executionModelVersion: "paper-execution-v1",
  input,
  activeFormulaVersionAtStart: "ranking-tiebreak-v1",
  chronologicalSplitAt: null,
  results: [],
  warnings: [],
  error: null,
  createdAt: "2026-08-28T00:00:00.000Z",
  startedAt: null,
  completedAt: null,
} as RankingResearchRun;
class Studies implements RankingResearchApi {
  created?: CreateRankingResearch;
  async list(): Promise<RankingResearchRun[]> {
    return [study];
  }
  async get(): Promise<RankingResearchRun> {
    return study;
  }
  async create(value: CreateRankingResearch): Promise<RankingResearchRun> {
    this.created = value;
    return study;
  }
}

describe("Phase 6 ranking research API", () => {
  it("enqueues, lists, and reads durable studies", async () => {
    const service = new Studies(),
      jobs = new FakeResearchJobs(),
      app = await buildApp({
        statusService: status(),
        rankingResearchService: service,
        researchJobService: jobs,
      });
    expect(
      (
        await app.inject({ method: "GET", url: "/api/ranking-research" })
      ).json(),
    ).toEqual({ studies: [study] });
    const response = await app.inject({
      method: "POST",
      url: "/api/ranking-research",
      payload: {
        name: "Holdout",
        backtestRunId,
        formulaVersions: ["ranking-bounded-context-research-v1"],
      },
    });
    expect(response.statusCode, response.body).toBe(202);
    expect(jobs.created?.jobType).toBe("RANKING_RESEARCH");
    expect(jobs.created?.payload).toMatchObject({
      contextHorizon: "MULTI_HORIZON",
      trainPct: 70,
      topPerSession: 3,
      minimumSamplesPerSlice: 30,
    });
    expect(
      (await app.inject({ method: "GET", url: `/api/ranking-research/${id}` }))
        .statusCode,
    ).toBe(200);
    await app.close();
  });
  it("rejects invalid inputs and identifiers", async () => {
    const app = await buildApp({
      statusService: status(),
      rankingResearchService: new Studies(),
      researchJobService: new FakeResearchJobs(),
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/ranking-research",
          payload: {},
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: "GET", url: "/api/ranking-research/nope" }))
        .statusCode,
    ).toBe(400);
    await app.close();
  });
});
