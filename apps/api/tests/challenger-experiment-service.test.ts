import { describe, expect, it, vi } from "vitest";
import { contentHash } from "../src/backtests/research-coverage.js";
import {
  challengerExperimentSchema,
  registerChallengerSchema,
} from "@tsx-scanner/contracts";
import {
  ChallengerExperimentService,
  nextExperimentState,
} from "../src/statistical-models/challenger-experiment-service.js";
import { sameChallengerScope } from "../src/statistical-models/challenger-scope.js";

const HASH = "a".repeat(64);
const ENGINE = "b".repeat(40);
const UUID = "10000000-0000-4000-8000-000000000001";
const ARTIFACT = { fixture: "challenger" };

const binding = {
  manifestHash: HASH,
  coverageReportHash: HASH,
  inputHash: HASH,
  engineRevision: ENGINE,
  runtimeFingerprint: HASH,
  verifiedAt: "2026-09-10T11:00:00.000Z",
};

const scope = {
  marketId: "CA_TSX" as const,
  currency: "CAD" as const,
  strategy: "ORB_RETEST" as const,
  strategyVersion: "strategy-v1",
  profileConfigId: UUID,
  configVersion: "config-v1",
  executionModelVersion: "paper-execution-v2",
  executionAssumptionsHash: HASH,
  signalSemanticsVersion: "signal-v1",
  replayScope: "FORWARD_LIVE",
};

const request = {
  modelId: UUID,
  modelVersion: "model-v1",
  artifactHash: contentHash(ARTIFACT),
  scope,
  researchEvidence: binding,
  baselineIdentityHash: HASH,
  acceptancePlanHash: HASH,
  startsAt: "2026-09-10T12:00:00.000Z",
  endsAt: "2026-09-17T12:00:00.000Z",
  maxPredictionLagMs: 1_000,
};

describe("challenger experiment contracts", () => {
  it("does not restart an ended or revoked experiment", () => {
    expect(nextExperimentState("REGISTERED", "START")).toBe("ACTIVE");
    expect(nextExperimentState("ACTIVE", "PAUSE")).toBe("PAUSED");
    expect(nextExperimentState("PAUSED", "RESUME")).toBe("ACTIVE");
    expect(() => nextExperimentState("ENDED", "RESUME")).toThrow(
      "EXPERIMENT_STATE_CONFLICT",
    );
    expect(() => nextExperimentState("REVOKED", "START")).toThrow(
      "EXPERIMENT_STATE_CONFLICT",
    );
  });

  it("requires a bounded positive prediction deadline and strict identities", () => {
    expect(() => registerChallengerSchema.parse(request)).not.toThrow();
    expect(() =>
      registerChallengerSchema.parse({ ...request, maxPredictionLagMs: 0 }),
    ).toThrow();
    expect(() =>
      registerChallengerSchema.parse({
        ...request,
        maxPredictionLagMs: 30_001,
      }),
    ).toThrow();
    expect(() =>
      challengerExperimentSchema.parse({
        ...request,
        id: UUID,
        registeredAt: request.startsAt,
        state: "REGISTERED",
      }),
    ).not.toThrow();
  });
});

describe("ChallengerExperimentService", () => {
  it("rejects legacy registration without complete persisted acceptance records", async () => {
    const store = {
      getModel: vi.fn(async () => ({
        id: UUID,
        marketId: scope.marketId,
        strategy: scope.strategy,
        modelVersion: request.modelVersion,
        status: "COMPLETED",
        active: false,
        artifact: ARTIFACT,
        completedAt: "2026-09-10T11:00:00.000Z",
        researchEvidence: binding,
        researchEvidenceVerified: true,
        scope,
        trainingLabelCutoffAt: "2026-09-10T10:00:00.000Z",
      })),
      getAcceptance: vi.fn(async () => null),
      register: vi.fn(async (value) => value),
      get: vi.fn(),
      transition: vi.fn(),
    };
    const service = new ChallengerExperimentService(store, {
      activate: vi.fn(),
      now: () => new Date(request.startsAt),
    });
    await expect(service.register(request)).rejects.toMatchObject({
      code: "EXPERIMENT_ACCEPTANCE_PLAN_NOT_FOUND",
    });
    expect(store.register).not.toHaveBeenCalled();
  });
  it("revalidates inactive model ownership before starting a historical enrollment", async () => {
    const store = {
      get: vi.fn(async () => ({
        ...request,
        id: UUID,
        registeredAt: request.startsAt,
        state: "REGISTERED" as const,
      })),
      getModel: vi.fn(async () => ({
        id: UUID,
        marketId: scope.marketId,
        strategy: scope.strategy,
        modelVersion: request.modelVersion,
        status: "COMPLETED",
        active: true,
        artifact: ARTIFACT,
        completedAt: "2026-09-10T11:00:00.000Z",
        researchEvidence: binding,
        researchEvidenceVerified: true,
        scope,
        trainingLabelCutoffAt: "2026-09-10T10:00:00.000Z",
      })),
      register: vi.fn(),
      transition: vi.fn(),
    };
    const service = new ChallengerExperimentService(store, {
      activate: vi.fn(),
      now: () => new Date(request.startsAt),
    });
    await expect(
      service.transition(UUID, "START", "start-1"),
    ).rejects.toMatchObject({ code: "EXPERIMENT_MODEL_ACTIVE" });
    expect(store.transition).not.toHaveBeenCalled();
  });
  it("compares every immutable scope field", () => {
    expect(sameChallengerScope(scope, { ...scope })).toBe(true);
    expect(
      sameChallengerScope(
        { ...scope, executionAssumptionsHash: "b".repeat(64) },
        scope,
      ),
    ).toBe(false);
  });
  it("rejects a non-prospective enrollment without touching stores or activation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-10T12:00:00.000Z"));
    const stores = {
      getModel: vi.fn(async () => ({
        id: UUID,
        marketId: "CA_TSX" as const,
        strategy: "ORB_RETEST" as const,
        modelVersion: "model-v1",
        status: "COMPLETED" as const,
        active: false,
        artifact: ARTIFACT,
        completedAt: "2026-09-10T13:00:00.000Z",
        researchEvidence: binding,
        researchEvidenceVerified: true,
        scope,
        trainingLabelCutoffAt: "2026-09-10T10:00:00.000Z",
      })),
      register: vi.fn(),
      get: vi.fn(),
      transition: vi.fn(),
    };
    const service = new ChallengerExperimentService(stores, {
      now: () => new Date(),
      activate: vi.fn(),
    });

    await expect(service.register(request)).rejects.toMatchObject({
      code: "EXPERIMENT_START_NOT_PROSPECTIVE",
    });
    expect(stores.register).not.toHaveBeenCalled();
    expect(service.activation.activate).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("rejects a hash-shaped binding without a persisted verified evidence record", async () => {
    const stores = {
      getModel: vi.fn(async () => ({
        id: UUID,
        marketId: "CA_TSX" as const,
        strategy: "ORB_RETEST" as const,
        modelVersion: "model-v1",
        status: "COMPLETED" as const,
        active: false,
        artifact: ARTIFACT,
        completedAt: "2026-09-10T11:00:00.000Z",
        researchEvidence: binding,
        researchEvidenceVerified: false,
        scope,
        trainingLabelCutoffAt: "2026-09-10T10:00:00.000Z",
      })),
      register: vi.fn(),
      get: vi.fn(),
      transition: vi.fn(),
    };
    const service = new ChallengerExperimentService(stores, {
      now: () => new Date("2026-09-10T12:00:00.000Z"),
      activate: vi.fn(),
    });

    await expect(service.register(request)).rejects.toMatchObject({
      code: "EXPERIMENT_MODEL_EVIDENCE",
    });
    expect(stores.register).not.toHaveBeenCalled();
  });
});
