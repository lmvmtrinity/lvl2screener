import { describe, expect, it, vi } from "vitest";
import type {
  ChallengerExperiment,
  ChallengerObservationReport,
} from "@tsx-scanner/contracts";
import {
  buildApp,
  type ChallengerExperimentApi as ChallengerApi,
} from "../src/app.js";
import type { DependencyProbe } from "../src/foundation/probes.js";
import { FoundationStatusService } from "../src/foundation/status-service.js";

const probe: DependencyProbe = { check: async () => ({ status: "ok" }) };
const status = () =>
  new FoundationStatusService({
    database: probe,
    scanner: probe,
    marketData: probe,
  });

const experiment = {
  id: "10000000-0000-4000-8000-000000000001",
  modelId: "10000000-0000-4000-8000-000000000002",
  modelVersion: "model-v1",
  artifactHash: "a".repeat(64),
  scope: {
    marketId: "CA_TSX" as const,
    currency: "CAD" as const,
    strategy: "ORB_RETEST" as const,
    strategyVersion: "strategy-v1",
    profileConfigId: "10000000-0000-4000-8000-000000000003",
    configVersion: "config-v1",
    executionModelVersion: "paper-execution-v1",
    executionAssumptionsHash: "b".repeat(64),
    signalSemanticsVersion: "signal-v1",
    replayScope: "FORWARD_LIVE",
  },
  researchEvidence: {
    manifestHash: "c".repeat(64),
    coverageReportHash: "d".repeat(64),
    inputHash: "e".repeat(64),
    engineRevision: "f".repeat(40),
    runtimeFingerprint: "1".repeat(64),
    verifiedAt: "2026-09-10T11:00:00.000Z",
  },
  baselineIdentityHash: "2".repeat(64),
  acceptancePlanHash: "3".repeat(64),
  startsAt: "2026-09-11T12:00:00.000Z",
  endsAt: "2026-09-17T12:00:00.000Z",
  maxPredictionLagMs: 1_000,
  registeredAt: "2026-09-10T12:00:00.000Z",
  state: "REGISTERED" as const,
};

const report: ChallengerObservationReport = {
  experimentId: experiment.id,
  asOf: "2026-09-10T14:00:00.000Z",
  population: {
    expectedEligibleObservations: 0,
    predicted: 0,
    pending: 0,
    missedDeadline: 0,
    engineFailed: 0,
    inputInvalid: 0,
    revoked: 0,
    unknownCapture: 0,
  },
  verifiedSessions: 0,
  incompleteSessions: 0,
  unknownSessions: 1,
  coveredNoOpportunitySessions: 0,
  excludedPausedSessions: 0,
  closedQuoteOutcomes: 0,
  prospectiveBrierScore: null,
  comparison: null,
  comparisonUnavailableReason: "COVERAGE_UNVERIFIED",
  promotionAuthorized: false,
};

class FakeChallengers implements ChallengerApi {
  activation = vi.fn();
  async list(): Promise<ChallengerExperiment[]> {
    return [];
  }
  async get(): Promise<ChallengerExperiment | null> {
    return experiment;
  }
  async report(): Promise<ChallengerObservationReport> {
    return report;
  }
  async register(): Promise<ChallengerExperiment> {
    return experiment;
  }
  async transition(): Promise<ChallengerExperiment> {
    return { ...experiment, state: "ACTIVE" };
  }
}

describe("challenger experiment API", () => {
  it("requires concrete market and idempotency for reads and mutations", async () => {
    const app = await buildApp({
      statusService: status(),
      challengerExperimentService: new FakeChallengers(),
    });
    expect(
      (await app.inject({ method: "GET", url: "/api/challenger-experiments" }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/challenger-experiments",
          payload: {},
        })
      ).statusCode,
    ).toBe(400);
    await app.close();
  });

  it("keeps report reads market-scoped and never exposes activation controls", async () => {
    const fake = new FakeChallengers();
    const app = await buildApp({
      statusService: status(),
      challengerExperimentService: fake,
    });
    const response = await app.inject({
      method: "GET",
      url: `/api/challenger-experiments/${experiment.id}/report?marketId=CA_TSX`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().report.promotionAuthorized).toBe(false);
    expect(fake.activation).not.toHaveBeenCalled();
    const wrongMarket = await app.inject({
      method: "GET",
      url: `/api/challenger-experiments/${experiment.id}/report?marketId=US_EQUITIES`,
    });
    expect(wrongMarket.statusCode).toBe(404);
    await app.close();
  });
});
