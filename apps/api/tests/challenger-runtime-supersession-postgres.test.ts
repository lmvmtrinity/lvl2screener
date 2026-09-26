import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/database/migrate.js";
import { isolatedDatabaseUrl } from "./isolated-database.js";
import { PostgresCoverageRequestRepository } from "../src/backtests/coverage-request-repository.js";
import { contentHash } from "../src/backtests/research-coverage.js";
import {
  challengerCoverageKey,
  legacyChallengerCoverageKey,
} from "../src/backtests/research-runtime-supersession.js";

const databaseUrl = isolatedDatabaseUrl("AUDIT_TEST_DATABASE_URL");

const runtimeA = {
  engineRevision: "a".repeat(40),
  runtimeFingerprint: "b".repeat(64),
  featureVersion: "1.0.0",
};
const runtimeB = {
  engineRevision: "c".repeat(40),
  runtimeFingerprint: "d".repeat(64),
  featureVersion: "1.0.0",
};

function coverageInput(
  runtime: typeof runtimeA,
  experimentId: string,
  date: string,
  inputCutoff = "2026-09-10T00:00:00.000Z",
) {
  const manifest = {
    version: "challenger-prospective-coverage-v1",
    purpose: {
      kind: "CHALLENGER",
      experimentId,
      scope: { marketId: "CA_TSX" },
      expectedInputs: [],
      activeWindows: { [date]: [] },
    },
    plan: { expectedSessions: [date] },
  };
  return {
    manifest: {
      hash: contentHash(manifest),
      marketId: "CA_TSX" as const,
      manifest,
    },
    recipe: {
      version: "research-coverage-recipe-v2" as const,
      marketId: "CA_TSX" as const,
      ...runtime,
      sessionDates: [date],
      inputCutoff,
      streamRequirements: [
        {
          timeframe: "OneMinute" as const,
          warmupDays: 1,
          requiredWarmupBars: 2,
          includeInSession: true,
        },
      ],
      maxQuoteGapMs: 30000,
      replayPolicyHash: "1".repeat(64),
      membershipPolicyHash: "2".repeat(64),
      calendarPolicyHash: "3".repeat(64),
    },
  };
}

describe.skipIf(!databaseUrl)(
  "challenger runtime supersession PostgreSQL regression",
  () => {
    let pool: Pool;
    let requests: PostgresCoverageRequestRepository;
    const experimentId = randomUUID();
    const date = "2026-09-09";

    beforeAll(async () => {
      pool = new Pool({ connectionString: databaseUrl });
      await migrate(pool);
      requests = new PostgresCoverageRequestRepository(pool);
    });
    afterAll(async () => {
      await pool?.end();
    });

    it("runtime A request/failure → exactly one runtime B successor → repeated polling creates nothing further", async () => {
      // Legacy row shape is preserved (previous request and failure stay).
      const legacyKey = legacyChallengerCoverageKey(experimentId, date);
      // Pre-upgrade request used an older cutoff, so its content hash differs
      // from the post-upgrade runtime-bound successor even under runtime A.
      const legacyInput = coverageInput(
        runtimeA,
        experimentId,
        date,
        "2026-09-09T00:00:00.000Z",
      );
      const legacyRequest = await requests.create(legacyInput, legacyKey);
      expect(legacyRequest.requestHash).toMatch(/^[a-f0-9]{64}$/);

      // Runtime A successor under the new runtime-bound identity.
      const keyA = challengerCoverageKey(experimentId, date, runtimeA);
      expect(keyA).not.toBe(legacyKey);
      const firstA = await requests.create(
        coverageInput(runtimeA, experimentId, date),
        keyA,
      );
      // Repeated polling under runtime A creates nothing further.
      const secondA = await requests.create(
        coverageInput(runtimeA, experimentId, date),
        keyA,
      );
      expect(secondA.id).toBe(firstA.id);
      expect(secondA.latestJobId).toBe(firstA.latestJobId);

      // Runtime replacement creates exactly one successor under runtime B.
      const keyB = challengerCoverageKey(experimentId, date, runtimeB);
      expect(keyB).not.toBe(keyA);
      expect(keyB).not.toBe(legacyKey);
      const firstB = await requests.create(
        coverageInput(runtimeB, experimentId, date),
        keyB,
      );
      expect(firstB.id).not.toBe(firstA.id);
      expect(firstB.id).not.toBe(legacyRequest.id);
      // Repeated polling under runtime B creates nothing further.
      const secondB = await requests.create(
        coverageInput(runtimeB, experimentId, date),
        keyB,
      );
      expect(secondB.id).toBe(firstB.id);

      // All three rows remain immutable and distinct.
      const rows = await pool.query<{ idempotency_key: string }>(
        "SELECT idempotency_key FROM research_coverage_request WHERE id IN ($1,$2,$3)",
        [legacyRequest.id, firstA.id, firstB.id],
      );
      expect(rows.rowCount).toBe(3);
    });
  },
);
