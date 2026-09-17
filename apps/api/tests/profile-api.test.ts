import { describe, expect, it } from "vitest";
import type {
  CreateScannerProfile,
  ProfileComparison,
  ProfileConfigHistory,
  ScannerProfile,
  StrategyDefinition,
  StrategyEvaluation,
  UpdateScannerProfile,
} from "@tsx-scanner/contracts";
import { buildApp, type ProfileApi } from "../src/app.js";
import type { DependencyProbe } from "../src/foundation/probes.js";
import { FoundationStatusService } from "../src/foundation/status-service.js";
import { ProfileError } from "../src/profiles/profile-service.js";

const probe: DependencyProbe = { check: async () => ({ status: "ok" }) };
const profile = {
  id: "10000000-0000-4000-8000-000000000081",
  name: "ORB Standard",
  marketId: "CA_TSX",
  strategyDefinitionId: "10000000-0000-4000-8000-000000000071",
  analysisKind: "SETUP",
  strategyKey: "ORB_RETEST",
  strategyVersion: "1.0.0",
  configId: "10000000-0000-4000-8000-000000000091",
  configVersion: "profile-v1",
  parameters: {
    rvolAtTimeMin: 1.5,
    spreadHardMaxPct: 0.25,
    atrPctMin: 0,
    breakoutVolumeRatioMin: 1.5,
    retestTolerancePct: 0.15,
    scoreCutoff: 0,
    breakoutBufferPct: 0.05,
    relativeStrengthMinPct: 0.5,
    flagpoleMinAtr: 0.5,
    flagRetracementMaxPct: 50,
    setupTimeoutMinutes: 20,
    consolidationBarsMin: 3,
    consolidationRangeMaxPct: 0.75,
    flagDurationBarsMin: 1,
    flagDurationBarsMax: 2,
    flagpoleMinSlopeAtrPerBar: 0,
    volumeContractionMaxPct: 100,
  },
  enabled: true,
  qualification: "EXPLORATORY",
  qualificationReason: "No holdout evidence",
  displayOrder: 0,
  createdAt: "2026-08-25T00:00:00.000Z",
  updatedAt: "2026-08-25T00:00:00.000Z",
} satisfies ScannerProfile;
const definition = {
  id: profile.strategyDefinitionId,
  strategyKey: "ORB_RETEST",
  version: "1.0.0",
  name: "ORB",
  analysisKind: "SETUP",
  description: "ORB",
  enabled: true,
  parameterSchema: {},
  createdAt: profile.createdAt,
} satisfies StrategyDefinition;
class FakeProfiles implements ProfileApi {
  async listDefinitions() {
    return [definition];
  }
  async listProfiles() {
    return [profile];
  }
  async create(_input: CreateScannerProfile) {
    return profile;
  }
  async update(_id: string, _input: UpdateScannerProfile) {
    return profile;
  }
  async duplicate() {
    return { ...profile, id: "10000000-0000-4000-8000-000000000082" };
  }
  async configHistory(id: string): Promise<ProfileConfigHistory> {
    return {
      profileId: id,
      profileName: profile.name,
      versions: [
        {
          configId: profile.configId,
          configVersion: profile.configVersion,
          parameters: profile.parameters,
          createdAt: profile.createdAt,
          current: true,
          changes: [],
        },
      ],
    };
  }
  async listEvaluations(): Promise<StrategyEvaluation[]> {
    return [];
  }
  async opportunities(): Promise<StrategyEvaluation[]> {
    return [];
  }
  async compare(): Promise<ProfileComparison> {
    return {
      marketId: "CA_TSX",
      source: "LIVE",
      startDate: "2026-08-01",
      endDate: "2026-08-25",
      timeStart: "09:30",
      timeEnd: "16:00",
      status: "CONTROLLED",
      controlled: true,
      differences: [],
      metrics: [],
    };
  }
}

class CohortRequiredProfiles extends FakeProfiles {
  override async compare(): Promise<ProfileComparison> {
    throw new ProfileError(
      "COMPARISON_COHORT_REQUIRED",
      "Select one cohort",
      [],
      [
        {
          profileId: profile.id,
          cohortKey: "a".repeat(64),
          executionModelVersion: "paper-execution-v7",
          executionAssumptionsHash: "b".repeat(64),
          outcomeCount: 2,
        },
      ],
    );
  }
}

describe("Phase 8A profile API", () => {
  it("manages profiles and exposes projections", async () => {
    const app = await buildApp({
      statusService: new FoundationStatusService({
        database: probe,
        scanner: probe,
        marketData: probe,
      }),
      profileService: new FakeProfiles(),
    });
    expect(
      (await app.inject({ method: "GET", url: "/api/strategies" })).json()
        .strategies,
    ).toHaveLength(1);
    expect(
      (await app.inject({ method: "GET", url: "/api/scanner-profiles" })).json()
        .profiles[0].name,
    ).toBe("ORB Standard");
    const created = await app.inject({
      method: "POST",
      url: "/api/scanner-profiles",
      payload: {
        name: "Test",
        marketId: "CA_TSX",
        strategyDefinitionId: definition.id,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(
      (await app.inject({ method: "GET", url: "/api/opportunities" })).json(),
    ).toEqual({ opportunities: [] });
    expect(
      (await app.inject({ method: "GET", url: "/api/evaluations" })).json(),
    ).toEqual({ evaluations: [] });
    await app.close();
  });
  it("validates profile and comparison inputs", async () => {
    const app = await buildApp({
      statusService: new FoundationStatusService({
        database: probe,
        scanner: probe,
        marketData: probe,
      }),
      profileService: new FakeProfiles(),
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/scanner-profiles",
          payload: {},
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/comparisons?profileIds=${profile.id},${profile.id}&timeStart=25:00`,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/api/scanner-profiles/${profile.id}`,
          payload: {},
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/comparisons?profileIds=nope",
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/scanner-profiles/nope/configs",
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/scanner-profiles/${profile.id}/configs`,
        })
      ).json().versions,
    ).toHaveLength(1);
    await app.close();
  });

  it("returns available cohorts when scope selection is required", async () => {
    const app = await buildApp({
      statusService: new FoundationStatusService({
        database: probe,
        scanner: probe,
        marketData: probe,
      }),
      profileService: new CohortRequiredProfiles(),
    });
    const response = await app.inject({
      method: "GET",
      url: `/api/comparisons?profileIds=${profile.id},10000000-0000-4000-8000-000000000082`,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: "COMPARISON_COHORT_REQUIRED",
      availableCohorts: [{ profileId: profile.id, outcomeCount: 2 }],
    });
    await app.close();
  });
});
