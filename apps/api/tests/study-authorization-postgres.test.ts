import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createBacktestSchema,
  type FrozenStudyPlan,
} from "@tsx-scanner/contracts";
import { migrate } from "../src/database/migrate.js";
import {
  authorizationPlanHash,
  authorizationPolicyHash,
  PostgresStudyAuthorizationRepository,
} from "../src/backtests/study-authorization-repository.js";
import { isolatedDatabaseUrl } from "./isolated-database.js";

const databaseUrl = isolatedDatabaseUrl("AUDIT_TEST_DATABASE_URL");
const binding = {
  manifestHash: "a".repeat(64),
  coverageReportHash: "b".repeat(64),
  inputHash: "c".repeat(64),
  engineRevision: "d".repeat(40),
  runtimeFingerprint: "e".repeat(64),
  verifiedAt: "2026-09-10T12:00:00.000Z",
};
const plan: FrozenStudyPlan = {
  experimentId: "10000000-0000-4000-8000-000000000120",
  binding,
  variant: "RETEST_CONTRACTION",
  baselineProfileConfigId: "10000000-0000-4000-8000-000000000121",
  challengerProfileConfigId: "10000000-0000-4000-8000-000000000122",
  inputs: Object.fromEntries(
    (["TRAIN", "VALIDATION", "TEST"] as const).map((stage) => [
      stage,
      {
        baseline: createBacktestSchema.parse({
          name: `${stage} baseline`,
          marketId: "CA_TSX",
          startDate:
            stage === "TRAIN"
              ? "2026-09-01"
              : stage === "VALIDATION"
                ? "2026-09-02"
                : "2026-09-03",
          endDate:
            stage === "TRAIN"
              ? "2026-09-01"
              : stage === "VALIDATION"
                ? "2026-09-02"
                : "2026-09-03",
          strategies: ["ORB_RETEST"],
        }),
        challenger: createBacktestSchema.parse({
          name: `${stage} challenger`,
          marketId: "CA_TSX",
          startDate:
            stage === "TRAIN"
              ? "2026-09-01"
              : stage === "VALIDATION"
                ? "2026-09-02"
                : "2026-09-03",
          endDate:
            stage === "TRAIN"
              ? "2026-09-01"
              : stage === "VALIDATION"
                ? "2026-09-02"
                : "2026-09-03",
          strategies: ["ORB_RETEST"],
        }),
        binding,
      },
    ]),
  ) as FrozenStudyPlan["inputs"],
  comparison: {
    marketId: "CA_TSX",
    unit: "R",
    expectedSessions: ["2026-09-03"],
    minimumSessions: 1,
    blockLength: 1,
    bootstrapSamples: 1_000,
    seed: 7,
  },
  sessionPlan: {
    version: "study-session-plan-v2",
    sessions: {
      TRAIN: ["2026-09-01"],
      VALIDATION: ["2026-09-02"],
      TEST: ["2026-09-03"],
    },
  },
  minimumClosedTradesPerDevelopmentSegment: 1,
  minimumValidationAverageR: 0,
};

describe.skipIf(!databaseUrl)(
  "study authorization PostgreSQL acceptance",
  () => {
    let pool: Pool;
    let repository: PostgresStudyAuthorizationRepository;

    beforeAll(async () => {
      pool = new Pool({ connectionString: databaseUrl, max: 4 });
      await migrate(pool);
      repository = new PostgresStudyAuthorizationRepository(pool);
    });

    afterAll(async () => {
      await pool?.end();
    });

    it("persists one explicit authorization and atomically reserves one job", async () => {
      const authorization = {
        id: randomUUID(),
        marketId: "CA_TSX" as const,
        frozenPlanHash: authorizationPlanHash(plan),
        prerequisitePolicyHash: authorizationPolicyHash(plan),
        sourceWindowStart: "2026-09-01",
        sourceWindowEnd: "2026-09-03",
        engineRevision: binding.engineRevision,
        runtimeFingerprint: binding.runtimeFingerprint,
        expiresAt: "2099-09-10T00:00:00.000Z",
        maxStudies: 1 as const,
        maxSessionExecutions: 6,
        mode: "EXECUTE_WHEN_READY" as const,
      };
      const saved = await repository.create(
        authorization,
        plan,
        "auth-create-1",
      );
      expect(saved.dispatchedJobId).toBeNull();
      const duplicate = await repository.create(
        authorization,
        plan,
        "auth-create-1",
      );
      expect(duplicate.id).toBe(saved.id);
      const dispatched = await repository.reserveAndEnqueue(
        saved.id,
        `study-authorization:${saved.id}`,
      );
      expect(dispatched.state).toBe("DISPATCHED");
      expect(
        await repository.reserveAndEnqueue(
          saved.id,
          `study-authorization:${saved.id}`,
        ),
      ).toEqual({ state: "USED" });
    });

    it("rejects changed authorization identity and preserves revoke idempotency", async () => {
      const authorization = {
        id: randomUUID(),
        marketId: "CA_TSX" as const,
        frozenPlanHash: authorizationPlanHash({
          ...plan,
          experimentId: randomUUID(),
        }),
        prerequisitePolicyHash: authorizationPolicyHash(plan),
        sourceWindowStart: "2026-09-01",
        sourceWindowEnd: "2026-09-03",
        engineRevision: binding.engineRevision,
        runtimeFingerprint: binding.runtimeFingerprint,
        expiresAt: "2099-09-10T00:00:00.000Z",
        maxStudies: 1 as const,
        maxSessionExecutions: 6,
        mode: "PREPARE_ONLY" as const,
      };
      const otherPlan = { ...plan, experimentId: randomUUID() };
      authorization.frozenPlanHash = authorizationPlanHash(otherPlan);
      const saved = await repository.create(
        authorization,
        otherPlan,
        "auth-revoke-1",
      );
      await expect(
        repository.create(
          { ...authorization, engineRevision: "changed" },
          otherPlan,
          "auth-revoke-1",
        ),
      ).rejects.toThrow("STUDY_AUTHORIZATION_ENGINE_MISMATCH");
      const revoked = await repository.revoke(saved.id, "revoke-1");
      expect(revoked?.revokedAt).not.toBeNull();
      expect((await repository.revoke(saved.id, "revoke-1"))?.id).toBe(
        saved.id,
      );
      await expect(repository.revoke(saved.id, "revoke-2")).rejects.toThrow(
        "STUDY_AUTHORIZATION_REVOKE_CONFLICT",
      );
    });
  },
);
