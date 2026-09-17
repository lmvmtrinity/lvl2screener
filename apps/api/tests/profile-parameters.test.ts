import { describe, expect, it } from "vitest";
import {
  defaultStrategyParameters,
  type MarketId,
  type ProfileConfigVersion,
  type ScannerProfile,
  type StrategyDefinition,
  type StrategyEvaluation,
  type StrategyParameters,
} from "@tsx-scanner/contracts";
import {
  ProfileError,
  ProfileService,
} from "../src/profiles/profile-service.js";
import type {
  ComparisonOutcome,
  ProfileStore,
} from "../src/profiles/profile-repository.js";
import type {
  ComparisonCohortRecord,
  ComparisonScope,
} from "../src/profiles/comparison-scope.js";
import { AUTHORITATIVE_EXECUTION_MODEL_VERSION } from "../src/backtests/execution-provenance.js";

const definition: StrategyDefinition = {
  id: "10000000-0000-4000-8000-000000000075",
  strategyKey: "BULL_FLAG",
  version: "1.0.0",
  name: "Bull Flag",
  analysisKind: "SETUP",
  description: "Bull flag",
  enabled: true,
  parameterSchema: {
    rvolAtTimeMin: "number",
    spreadHardMaxPct: "number",
    atrPctMin: "number",
    breakoutVolumeRatioMin: "number",
    flagpoleMinAtr: "number",
    flagRetracementMaxPct: "number",
    setupTimeoutMinutes: "integer",
    scoreCutoff: "integer",
  },
  createdAt: "2026-08-25T00:00:00.000Z",
};

class MemoryStore implements ProfileStore {
  private sequence = 0;
  calibration?: {
    status: string;
    marketId: MarketId;
    executionModelVersion: string;
    strategy: "BULL_FLAG";
    recommendedConfig: StrategyParameters;
  };
  readonly profiles = new Map<string, ScannerProfile>();
  readonly configs = new Map<string, ProfileConfigVersion[]>();
  async listDefinitions() {
    return [definition];
  }
  async getCalibrationRecommendation() {
    return this.calibration;
  }
  async listProfiles() {
    return [...this.profiles.values()];
  }
  async getProfile(id: string) {
    return this.profiles.get(id);
  }
  async createProfile(
    value: {
      name: string;
      marketId: MarketId;
      strategyDefinitionId: string;
      parameters: StrategyParameters;
      enabled: boolean;
    },
    configVersion: string,
  ) {
    this.sequence += 1;
    const id = `10000000-0000-4000-8000-00000000010${this.sequence}`,
      configId = `10000000-0000-4000-8000-00000000020${this.sequence}`;
    const profile: ScannerProfile = {
      id,
      name: value.name,
      marketId: value.marketId,
      strategyDefinitionId: value.strategyDefinitionId,
      analysisKind: "SETUP",
      strategyKey: "BULL_FLAG",
      strategyVersion: "1.0.0",
      configId,
      configVersion,
      parameters: value.parameters,
      enabled: value.enabled,
      qualification: "EXPLORATORY",
      qualificationReason: "No holdout evidence",
      displayOrder: 0,
      createdAt: definition.createdAt,
      updatedAt: definition.createdAt,
    };
    this.profiles.set(id, profile);
    this.configs.set(id, [
      {
        configId,
        configVersion,
        parameters: value.parameters,
        createdAt: definition.createdAt,
        current: true,
        changes: [],
      },
    ]);
    return profile;
  }
  async updateProfile(
    id: string,
    value: { parameters?: StrategyParameters },
    configVersion?: string,
  ) {
    const existing = this.profiles.get(id);
    if (!existing) return undefined;
    if (value.parameters && configVersion) {
      this.sequence += 1;
      const configId = `10000000-0000-4000-8000-00000000020${this.sequence}`,
        history = this.configs.get(id) ?? [];
      this.configs.set(id, [
        ...history.map((v) => ({ ...v, current: false })),
        {
          configId,
          configVersion,
          parameters: value.parameters,
          createdAt: definition.createdAt,
          current: true,
          changes: [],
        },
      ]);
      const updated = {
        ...existing,
        configId,
        configVersion,
        parameters: value.parameters,
      };
      this.profiles.set(id, updated);
      return updated;
    }
    return existing;
  }
  async duplicateProfile(id: string, name: string, configVersion: string) {
    const original = this.profiles.get(id);
    if (!original) return undefined;
    return this.createProfile(
      {
        name,
        marketId: original.marketId,
        strategyDefinitionId: original.strategyDefinitionId,
        parameters: original.parameters,
        enabled: false,
      },
      configVersion,
    );
  }
  async listConfigVersions(profileId: string) {
    return this.configs.get(profileId) ?? [];
  }
  async listEvaluations(): Promise<StrategyEvaluation[]> {
    return [];
  }
  async comparisonOutcomes(): Promise<ComparisonOutcome[]> {
    return [];
  }
  async comparisonCohorts(): Promise<ComparisonCohortRecord[]> {
    return [];
  }
  async comparisonScopes(): Promise<ComparisonScope[]> {
    return [];
  }
}

const create = async (
  service: ProfileService,
  parameters: StrategyParameters,
  name = "Bull Flag Lab",
  marketId: MarketId = "CA_TSX",
) =>
  service.create({
    name,
    marketId,
    strategyDefinitionId: definition.id,
    parameters,
    enabled: true,
  });

describe("Phase 3 API-authoritative profile parameters", () => {
  it("rejects a parameter the strategy does not declare, even through direct API use", async () => {
    const service = new ProfileService(new MemoryStore());
    const error = await create(service, {
      ...defaultStrategyParameters(),
      retestTolerancePct: 2,
    }).catch((reason) => reason as ProfileError);
    expect(error).toBeInstanceOf(ProfileError);
    expect((error as ProfileError).code).toBe("INVALID_PARAMETERS");
    expect((error as ProfileError).issues.map((v) => v.key)).toEqual([
      "retestTolerancePct",
    ]);
  });

  it("rejects an out-of-bounds declared parameter on update", async () => {
    const store = new MemoryStore(),
      service = new ProfileService(store);
    const profile = await create(service, defaultStrategyParameters());
    await expect(
      service.update(profile.id, {
        parameters: { ...defaultStrategyParameters(), flagpoleMinAtr: 50 },
      }),
    ).rejects.toThrow(/Flagpole minimum/);
  });

  it("versions every saved change and reports a human-readable diff", async () => {
    const store = new MemoryStore(),
      service = new ProfileService(store);
    const profile = await create(service, defaultStrategyParameters());
    await service.update(profile.id, {
      parameters: {
        ...defaultStrategyParameters(),
        flagpoleMinAtr: 1.2,
        setupTimeoutMinutes: 35,
      },
    });
    const history = await service.configHistory(profile.id);
    expect(history.versions).toHaveLength(2);
    expect(history.versions[0]!.changes).toEqual([]);
    expect(history.versions[1]!.changes).toEqual([
      {
        key: "setupTimeoutMinutes",
        label: "Setup timeout",
        unit: "min",
        previous: 20,
        next: 35,
      },
      {
        key: "flagpoleMinAtr",
        label: "Flagpole minimum",
        unit: "ATR",
        previous: 0.5,
        next: 1.2,
      },
    ]);
    expect(history.versions[1]!.current).toBe(true);
    expect(history.versions[0]!.configVersion).not.toBe(
      history.versions[1]!.configVersion,
    );
  });

  it("keeps duplicated profiles independently versioned", async () => {
    const store = new MemoryStore(),
      service = new ProfileService(store);
    const original = await create(service, defaultStrategyParameters());
    const copy = await service.duplicate(original.id, "Bull Flag Copy");
    expect(copy.parameters).toEqual(original.parameters);
    expect(copy.configVersion).not.toBe(original.configVersion);
    await service.update(copy.id, {
      parameters: { ...defaultStrategyParameters(), flagpoleMinAtr: 2 },
    });
    expect((await service.configHistory(original.id)).versions).toHaveLength(1);
    expect((await service.configHistory(copy.id)).versions).toHaveLength(2);
  });

  it("keeps US profile edits out of the TSX profile set", async () => {
    const store = new MemoryStore(),
      service = new ProfileService(store);
    const tsx = await create(
      service,
      defaultStrategyParameters(),
      "TSX baseline",
    );
    const us = await create(
      service,
      defaultStrategyParameters(),
      "US baseline",
      "US_EQUITIES",
    );
    await service.update(us.id, {
      parameters: { ...defaultStrategyParameters(), flagpoleMinAtr: 1.5 },
    });
    expect((await store.getProfile(tsx.id))?.parameters.flagpoleMinAtr).toBe(
      0.5,
    );
    expect((await store.getProfile(us.id))?.marketId).toBe("US_EQUITIES");
    await expect(
      service.compare(
        [tsx.id, us.id],
        "LIVE",
        "2026-08-01",
        "2026-08-02",
        "09:30",
        "16:00",
        "CA_TSX",
      ),
    ).rejects.toMatchObject({ code: "INVALID_COMPARISON" });
  });

  it("requires calibration lineage before duplicating a US challenger", async () => {
    const service = new ProfileService(new MemoryStore());
    const us = await create(
      service,
      defaultStrategyParameters(),
      "US baseline",
      "US_EQUITIES",
    );
    await expect(service.duplicate(us.id)).rejects.toMatchObject({
      code: "CALIBRATION_NOT_APPLICABLE",
    });
  });

  it("copies the exact recommended parameters into a US challenger", async () => {
    const store = new MemoryStore(),
      service = new ProfileService(store);
    const us = await create(
      service,
      defaultStrategyParameters(),
      "US baseline",
      "US_EQUITIES",
    );
    const recommended = {
      ...defaultStrategyParameters(),
      flagpoleMinAtr: 1.5,
    };
    store.calibration = {
      status: "COMPLETED",
      marketId: "US_EQUITIES",
      executionModelVersion: AUTHORITATIVE_EXECUTION_MODEL_VERSION,
      strategy: "BULL_FLAG",
      recommendedConfig: recommended,
    };
    const challenger = await service.duplicate(
      us.id,
      "US challenger",
      "10000000-0000-4000-8000-000000000099",
    );
    expect(challenger.parameters).toEqual(recommended);
    expect(challenger.enabled).toBe(false);
    expect(challenger.marketId).toBe("US_EQUITIES");
  });
});
