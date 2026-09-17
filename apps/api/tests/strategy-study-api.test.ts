import { describe, expect, it } from "vitest";
import type {
  FrozenStudyPlan,
  ResearchJob,
  StudyAuthorizationRecord,
  StudyExecutionAuthorization,
} from "@tsx-scanner/contracts";
import { buildApp, type StrategyStudyApi } from "../src/app.js";
import type { StrategyStudyRecord } from "../src/backtests/strategy-study-repository.js";
import { FoundationStatusService } from "../src/foundation/status-service.js";
import type { DependencyProbe } from "../src/foundation/probes.js";

const probe: DependencyProbe = { check: async () => ({ status: "ok" }) };
const status = () =>
  new FoundationStatusService({
    database: probe,
    scanner: probe,
    marketData: probe,
  });

class FakeStudies implements StrategyStudyApi {
  async create(): Promise<ResearchJob> {
    return {
      id: "10000000-0000-4000-8000-000000000190",
      jobType: "STRATEGY_STUDY",
      status: "QUEUED",
      resultRefId: null,
      progress: {},
      error: null,
      errorCategory: null,
      attemptCount: 0,
      maxAttempts: 3,
      cancellationRequested: false,
      createdAt: "2026-09-10T00:00:00.000Z",
      startedAt: null,
      completedAt: null,
    };
  }
  async get(): Promise<StrategyStudyRecord | null> {
    return null;
  }
  async list(): Promise<StrategyStudyRecord[]> {
    return [];
  }
  async createAuthorization(
    _authorization: StudyExecutionAuthorization,
    _plan: FrozenStudyPlan,
    _idempotencyKey: string,
  ): Promise<StudyAuthorizationRecord> {
    throw new Error("unused");
  }
  async listAuthorizations(): Promise<StudyAuthorizationRecord[]> {
    return [];
  }
  async revokeAuthorization(): Promise<StudyAuthorizationRecord | null> {
    return null;
  }
}

describe("strategy study API", () => {
  it("requires a complete frozen plan and idempotency key without running the engine", async () => {
    const app = await buildApp({
      statusService: status(),
      strategyStudyService: new FakeStudies(),
    });
    const missingKey = await app.inject({
      method: "POST",
      url: "/api/strategy-studies",
      payload: {},
    });
    expect(missingKey.statusCode).toBe(400);
    const missingMarket = await app.inject({
      method: "GET",
      url: "/api/strategy-studies",
    });
    expect(missingMarket.statusCode).toBe(400);
    await app.close();
  });

  it("keeps study reads scoped to the concrete market", async () => {
    const app = await buildApp({
      statusService: status(),
      strategyStudyService: new FakeStudies(),
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/strategy-studies?marketId=US_EQUITIES",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ studies: [] });
    await app.close();
  });
});
