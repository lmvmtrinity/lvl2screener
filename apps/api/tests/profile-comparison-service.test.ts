import { describe, expect, it } from "vitest";
import {
  defaultStrategyParameters,
  type ScannerProfile,
} from "@tsx-scanner/contracts";
import { ProfileService } from "../src/profiles/profile-service.js";
import type { ProfileStore } from "../src/profiles/profile-repository.js";
import type { ComparisonScope } from "../src/profiles/comparison-scope.js";

const profile = (id: string, name: string): ScannerProfile =>
  ({
    id,
    name,
    marketId: "CA_TSX",
    strategyDefinitionId: "10000000-0000-4000-8000-000000000071",
    analysisKind: "SETUP",
    strategyKey: "ORB_RETEST",
    strategyVersion: "1.0.0",
    configId: `10000000-0000-4000-8000-${id.slice(-12)}`,
    configVersion: "profile-v1",
    parameters: defaultStrategyParameters(),
    enabled: true,
    qualification: "EXPLORATORY",
    qualificationReason: "test",
    displayOrder: 0,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  }) as ScannerProfile;

const completeScope = (profileId: string): ComparisonScope => ({
  profileId,
  marketId: "CA_TSX",
  windowHash: "window",
  universeHash: "universe",
  featureVersion: "features",
  executionModelVersion: "execution",
  executionAssumptionsHash: "costs",
  inputHash: "inputs",
  coverageReportHash: "coverage",
  coverageComplete: true,
});

describe("ProfileService.compare", () => {
  it("uses realization chronology and exposes incomplete comparison evidence", async () => {
    const left = profile("10000000-0000-4000-8000-000000000001", "Left"),
      right = profile("10000000-0000-4000-8000-000000000002", "Right"),
      store = {
        listProfiles: async () => [left, right],
        comparisonCohorts: async () => [],
        comparisonScopes: async () => [
          {
            ...completeScope(left.id),
            inputHash: null,
            coverageReportHash: null,
            coverageComplete: false,
          },
          {
            ...completeScope(right.id),
            inputHash: null,
            coverageReportHash: null,
            coverageComplete: false,
          },
        ],
        comparisonOutcomes: async () => [
          {
            profileId: left.id,
            profileName: left.name,
            outcomeId: "left-3",
            realizedAt: "2026-09-01T14:02:00.000Z",
            setup: false,
            pnl: -80,
            rMultiple: -1,
            holdMinutes: 5,
            falsePositive: true,
          },
          {
            profileId: left.id,
            profileName: left.name,
            outcomeId: "left-1",
            realizedAt: "2026-09-01T14:00:00.000Z",
            setup: false,
            pnl: 100,
            rMultiple: 1,
            holdMinutes: 5,
            falsePositive: false,
          },
          {
            profileId: left.id,
            profileName: left.name,
            outcomeId: "left-2",
            realizedAt: "2026-09-01T14:01:00.000Z",
            setup: false,
            pnl: -80,
            rMultiple: -1,
            holdMinutes: 5,
            falsePositive: true,
          },
          {
            profileId: left.id,
            profileName: left.name,
            outcomeId: "left-4",
            realizedAt: "2026-09-01T14:03:00.000Z",
            setup: false,
            pnl: 100,
            rMultiple: 1,
            holdMinutes: 5,
            falsePositive: false,
          },
        ],
      } as unknown as ProfileStore;

    const result = await new ProfileService(store).compare(
      [left.id, right.id],
      "PAPER",
      "2026-09-01",
      "2026-09-01",
    );

    expect(result.status).toBe("UNVERIFIED");
    expect(result.controlled).toBe(false);
    expect(result.metrics[0]?.maximumDrawdown).toBe(160);
    expect(result.metrics[0]?.drawdownStatus).toBe("AVAILABLE");
    expect(result.metrics[0]?.drawdownBasis).toBe("REALIZED_CLOSED_OUTCOMES");
  });

  it("returns no closed outcomes instead of zero risk", async () => {
    const left = profile("10000000-0000-4000-8000-000000000011", "Left"),
      right = profile("10000000-0000-4000-8000-000000000012", "Right"),
      store = {
        listProfiles: async () => [left, right],
        comparisonCohorts: async () => [],
        comparisonScopes: async () => [
          completeScope(left.id),
          completeScope(right.id),
        ],
        comparisonOutcomes: async () => [],
      } as unknown as ProfileStore;

    const result = await new ProfileService(store).compare(
      [left.id, right.id],
      "LIVE",
      "2026-09-01",
      "2026-09-01",
    );

    expect(result.status).toBe("CONTROLLED");
    expect(result.metrics[0]?.maximumDrawdown).toBeNull();
    expect(result.metrics[0]?.drawdownStatus).toBe("NO_CLOSED_OUTCOMES");
  });

  it("requires and forwards an explicit cohort when evidence is incompatible", async () => {
    const left = profile("10000000-0000-4000-8000-000000000021", "Left"),
      right = profile("10000000-0000-4000-8000-000000000022", "Right"),
      selectedCohort = "a".repeat(64),
      otherCohort = "b".repeat(64),
      outcomeCalls: unknown[][] = [],
      cohort = (profileId: string, cohortKey: string) => ({
        profileId,
        cohortKey,
        marketId: "CA_TSX",
        windowHash: "window",
        universeHash: null,
        featureVersion: null,
        executionModelVersion: "execution",
        executionAssumptionsHash: cohortKey.slice(0, 8),
        inputHash: null,
        coverageReportHash: null,
        coverageComplete: false,
        executionAssumptions: null,
        outcomeCount: 1,
      }),
      store = {
        listProfiles: async () => [left, right],
        comparisonCohorts: async () => [
          cohort(left.id, selectedCohort),
          cohort(left.id, otherCohort),
          cohort(right.id, selectedCohort),
        ],
        comparisonScopes: async () => [
          { ...completeScope(left.id), coverageComplete: false },
          { ...completeScope(right.id), coverageComplete: false },
        ],
        comparisonOutcomes: async (...args: unknown[]) => {
          outcomeCalls.push(args);
          return [];
        },
      } as unknown as ProfileStore;

    await expect(
      new ProfileService(store).compare(
        [left.id, right.id],
        "PAPER",
        "2026-09-01",
        "2026-09-01",
      ),
    ).rejects.toMatchObject({ code: "COMPARISON_COHORT_REQUIRED" });
    expect(outcomeCalls).toHaveLength(0);

    await new ProfileService(store).compare(
      [left.id, right.id],
      "PAPER",
      "2026-09-01",
      "2026-09-01",
      "09:30",
      "16:00",
      "CA_TSX",
      { [left.id]: selectedCohort, [right.id]: selectedCohort },
    );
    expect(outcomeCalls[0]?.at(-1)).toEqual({
      [left.id]: selectedCohort,
      [right.id]: selectedCohort,
    });
  });
});
