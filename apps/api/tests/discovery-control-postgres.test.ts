import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isolatedDatabaseUrl } from "./isolated-database.js";
import { migrate } from "../src/database/migrate.js";
import {
  DiscoveryControlConflictError,
  PostgresDiscoveryControlStore,
} from "../src/universe/discovery-control-repository.js";
import { EodhdCatalogClient } from "../src/universe/eodhd-catalog.js";
import { PostgresDiscoveryEvidenceStore } from "../src/universe/discovery-evidence-repository.js";
import {
  discoveryEvaluationInputSchema,
  discoveryEvaluationResultSchema,
} from "@tsx-scanner/contracts";

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../../../contracts/fixtures/discovery-evaluation-v1.json",
      import.meta.url,
    ),
    "utf8",
  ),
)[0] as { input: unknown; result: unknown };

const databaseUrl = isolatedDatabaseUrl("AUDIT_TEST_DATABASE_URL");

describe.skipIf(!databaseUrl)(
  "discovery shadow control PostgreSQL acceptance",
  () => {
    let pool: Pool;
    let admin: Pool;
    let created = false;
    const databaseName = `tsx_scanner_test_discovery_control_${randomUUID().replaceAll("-", "")}`;
    beforeAll(async () => {
      // Seed assertions require a fresh database, independent of intake suites.
      admin = new Pool({ connectionString: databaseUrl, max: 1 });
      const target = new URL(databaseUrl!);
      target.pathname = `/${databaseName}`;
      const connectionString = isolatedDatabaseUrl("AUDIT_TEST_DATABASE_URL", {
        ...process.env,
        AUDIT_TEST_DATABASE_URL: target.toString(),
      });
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      created = true;
      pool = new Pool({ connectionString, max: 5 });
      await migrate(pool);
    }, 60_000);
    afterAll(async () => {
      await pool?.end();
      if (created) await admin.query(`DROP DATABASE "${databaseName}"`);
      await admin?.end();
    });

    it("seeds OFF and rejects stale mode revisions without an audit row", async () => {
      const store = new PostgresDiscoveryControlStore(pool);
      const initial = await store.getMode("CA_TSX");
      expect(initial).toMatchObject({
        marketId: "CA_TSX",
        mode: "OFF",
        revision: 0,
      });
      const changed = await store.changeMode({
        marketId: "CA_TSX",
        mode: "SHADOW",
        expectedRevision: initial.revision,
        reason: "isolated shadow fixture",
        actor: "postgres-test",
      });
      expect(changed).toMatchObject({ mode: "SHADOW", revision: 1 });
      await expect(
        store.changeMode({
          marketId: "CA_TSX",
          mode: "OFF",
          expectedRevision: 0,
          reason: "stale fixture",
          actor: "postgres-test",
        }),
      ).rejects.toBeInstanceOf(DiscoveryControlConflictError);
      expect(await store.getMode("CA_TSX")).toMatchObject({
        mode: "SHADOW",
        revision: 1,
      });
      await store.changeMode({
        marketId: "CA_TSX",
        mode: "OFF",
        expectedRevision: 1,
        reason: "restore isolated default",
        actor: "postgres-test",
      });
      const audit = await pool.query(
        "SELECT previous_mode,mode,previous_revision,revision FROM discovery_mode_audit WHERE market_id='CA_TSX' ORDER BY changed_at DESC,id LIMIT 2",
      );
      expect(audit.rows).toEqual([
        expect.objectContaining({
          previous_mode: "SHADOW",
          mode: "OFF",
          previous_revision: "1",
          revision: "2",
        }),
        expect.objectContaining({
          previous_mode: "OFF",
          mode: "SHADOW",
          previous_revision: "0",
          revision: "1",
        }),
      ]);
    });

    it("fences a scheduled identity across expiry and restart", async () => {
      const store = new PostgresDiscoveryControlStore(pool);
      const key = {
        marketId: "US_EQUITIES" as const,
        tradingDate: "2099-01-04",
        policyVersion: "us-discovery-v1",
        completedBarEnd: "2099-01-04T14:40:00.000Z",
        idempotencyKey: `scheduled-test-${randomUUID()}`,
      };
      const first = await store.claim(key, randomUUID(), 120_000);
      expect(first).not.toBeNull();
      const competing = await store.claim(key, randomUUID(), 120_000);
      expect(competing).toBeNull();
      await pool.query(
        `UPDATE discovery_schedule_lease
       SET lease_expires_at=clock_timestamp()-interval '1 second'
       WHERE market_id=$1 AND trading_date=$2 AND policy_version=$3
         AND completed_bar_end=$4 AND idempotency_key=$5`,
        [
          key.marketId,
          key.tradingDate,
          key.policyVersion,
          key.completedBarEnd,
          key.idempotencyKey,
        ],
      );
      const restarted = await store.claim(key, randomUUID(), 120_000);
      expect(restarted).toMatchObject({ fencingGeneration: 2, runId: null });
      expect(await store.release(first!)).toBe(false);
      expect(await store.release(restarted!)).toBe(true);
      expect(await store.claim(key, randomUUID(), 120_000)).toBeNull();
    });

    it("reclaims an expired running identity for a later bar cycle", async () => {
      const input = discoveryEvaluationInputSchema.parse(fixture.input);
      const catalog = (
        await new EodhdCatalogClient(
          "fixture-token",
          { loadLatest: async () => null, save: async () => {} },
          async () =>
            Response.json([
              {
                Code: input.providerCode,
                Name: "Fixture",
                Exchange: input.providerExchange,
                Currency: input.identity.currency,
                Type: "Common Stock",
              },
            ]),
          () => new Date(Date.parse(input.evaluationAt) - 3_600_000),
        ).refresh(input.marketId, input.tradingDate)
      ).snapshot!;
      const evidence = new PostgresDiscoveryEvidenceStore(
        pool,
        () => new Date(input.evaluationAt),
      );
      const key = {
        marketId: input.marketId,
        tradingDate: input.tradingDate,
        policyVersion: input.policyVersion,
        completedBarEnd: input.completedBarEnd,
        idempotencyKey: `later-cycle-${randomUUID()}`,
      };
      const run = await evidence.begin({
        marketId: input.marketId,
        tradingDate: input.tradingDate,
        mode: "SHADOW",
        evaluationAt: input.evaluationAt,
        completedBarEnd: input.completedBarEnd,
        idempotencyKey: key.idempotencyKey,
        catalog,
      });
      const store = new PostgresDiscoveryControlStore(pool);
      const first = await store.claim(key, randomUUID(), 120_000);
      expect(first).not.toBeNull();
      await store.bindRun(first!, run.id);
      await pool.query(
        `UPDATE discovery_schedule_lease SET lease_expires_at=clock_timestamp()-interval '1 second'
         WHERE market_id=$1 AND trading_date=$2 AND policy_version=$3
           AND completed_bar_end=$4 AND idempotency_key=$5`,
        [
          key.marketId,
          key.tradingDate,
          key.policyVersion,
          key.completedBarEnd,
          key.idempotencyKey,
        ],
      );

      const reclaimed = await store.reclaimExpired(
        input.marketId,
        input.tradingDate,
        randomUUID(),
        120_000,
      );

      expect(reclaimed).toMatchObject({
        runId: run.id,
        fencingGeneration: 2,
      });
      expect(reclaimed?.ownerToken).not.toBe(first?.ownerToken);
      expect(await store.release(reclaimed!)).toBe(true);
    });

    it("expires an abandoned lease when no recoverable run exists", async () => {
      const store = new PostgresDiscoveryControlStore(pool);
      const key = {
        marketId: "CA_TSX" as const,
        tradingDate: "2099-01-05",
        policyVersion: "ca-discovery-v1",
        completedBarEnd: "2099-01-05T14:40:00.000Z",
        idempotencyKey: `orphaned-${randomUUID()}`,
      };
      const lease = await store.claim(key, randomUUID(), 120_000);
      expect(lease).not.toBeNull();
      await pool.query(
        `UPDATE discovery_schedule_lease SET lease_expires_at=clock_timestamp()-interval '1 second'
         WHERE market_id=$1 AND trading_date=$2 AND policy_version=$3
           AND completed_bar_end=$4 AND idempotency_key=$5`,
        [
          key.marketId,
          key.tradingDate,
          key.policyVersion,
          key.completedBarEnd,
          key.idempotencyKey,
        ],
      );

      expect(
        await store.reclaimExpired(
          key.marketId,
          key.tradingDate,
          randomUUID(),
          120_000,
        ),
      ).toBeNull();
      const status = await pool.query<{ status: string }>(
        `SELECT status FROM discovery_schedule_lease
         WHERE market_id=$1 AND trading_date=$2 AND policy_version=$3
           AND completed_bar_end=$4 AND idempotency_key=$5`,
        [
          key.marketId,
          key.tradingDate,
          key.policyVersion,
          key.completedBarEnd,
          key.idempotencyKey,
        ],
      );
      expect(status.rows[0]?.status).toBe("EXPIRED");
    });

    it("rejects a stale worker's result after the lease is reclaimed", async () => {
      const input = discoveryEvaluationInputSchema.parse(fixture.input);
      const result = discoveryEvaluationResultSchema.parse(fixture.result);
      const catalog = (
        await new EodhdCatalogClient(
          "fixture-token",
          { loadLatest: async () => null, save: async () => {} },
          async () =>
            Response.json([
              {
                Code: input.providerCode,
                Name: "Fixture",
                Exchange: input.providerExchange,
                Currency: input.identity.currency,
                Type: "Common Stock",
              },
            ]),
          () => new Date(Date.parse(input.evaluationAt) - 3_600_000),
        ).refresh(input.marketId, input.tradingDate)
      ).snapshot!;
      const evidence = new PostgresDiscoveryEvidenceStore(
        pool,
        () => new Date(input.evaluationAt),
      );
      const request = {
        marketId: input.marketId,
        tradingDate: input.tradingDate,
        mode: "SHADOW" as const,
        evaluationAt: input.evaluationAt,
        completedBarEnd: input.completedBarEnd,
        idempotencyKey: `stale-worker-${randomUUID()}`,
        catalog,
      };
      const run = await evidence.begin(request);
      const control = new PostgresDiscoveryControlStore(pool);
      const first = await control.claim(
        {
          marketId: input.marketId,
          tradingDate: input.tradingDate,
          policyVersion: input.policyVersion,
          completedBarEnd: input.completedBarEnd,
          idempotencyKey: request.idempotencyKey,
        },
        randomUUID(),
        120_000,
      );
      expect(first).not.toBeNull();
      await control.bindRun(first!, run.id);
      await pool.query(
        `UPDATE discovery_schedule_lease SET lease_expires_at=clock_timestamp()-interval '1 second'
       WHERE market_id=$1 AND trading_date=$2 AND policy_version=$3
         AND completed_bar_end=$4 AND idempotency_key=$5`,
        [
          input.marketId,
          input.tradingDate,
          input.policyVersion,
          input.completedBarEnd,
          request.idempotencyKey,
        ],
      );
      const second = await control.claim(
        {
          marketId: input.marketId,
          tradingDate: input.tradingDate,
          policyVersion: input.policyVersion,
          completedBarEnd: input.completedBarEnd,
          idempotencyKey: request.idempotencyKey,
        },
        randomUUID(),
        120_000,
      );
      expect(second).toMatchObject({ fencingGeneration: 2 });
      await expect(
        evidence.recordOwned(run.id, first!, result, input),
      ).rejects.toThrow("lease is stale");
      expect(await evidence.listEvaluations(input.marketId, run.id)).toEqual(
        [],
      );
      await control.release(second!);
    });
  },
);
