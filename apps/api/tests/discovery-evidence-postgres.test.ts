import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  discoveryEvaluationInputSchema,
  discoveryEvaluationResultSchema,
  discoveryPolicyForMarket,
} from "@tsx-scanner/contracts";
import { isolatedDatabaseUrl } from "./isolated-database.js";
import { migrate } from "../src/database/migrate.js";
import { PostgresDiscoveryEvidenceStore } from "../src/universe/discovery-evidence-repository.js";
import { EodhdCatalogClient } from "../src/universe/eodhd-catalog.js";
import { DiscoveryAttemptDiagnosticsCollector } from "../src/universe/discovery-attempt-diagnostics.js";
import { PostgresDiscoveryControlStore } from "../src/universe/discovery-control-repository.js";

const fixtures = JSON.parse(
  readFileSync(
    new URL(
      "../../../contracts/fixtures/discovery-evaluation-v1.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const databaseUrl = isolatedDatabaseUrl("AUDIT_TEST_DATABASE_URL");
describe.skipIf(!databaseUrl)(
  "discovery evidence PostgreSQL acceptance",
  () => {
    let pool: Pool;
    beforeAll(async () => {
      pool = new Pool({ connectionString: databaseUrl, max: 5 });
      await migrate(pool);
    }, 60_000);
    afterAll(async () => {
      await pool?.end();
    });
    async function setup(
      extra = false,
      marketIndex = 0,
      additionalCodes: string[] = [],
    ) {
      const input = discoveryEvaluationInputSchema.parse(
        fixtures[marketIndex].input,
      );
      const result = discoveryEvaluationResultSchema.parse(
        fixtures[marketIndex].result,
      );
      let now = new Date(input.evaluationAt);
      const store = new PostgresDiscoveryEvidenceStore(pool, () => now);
      const rows = [
        input.providerCode,
        ...(extra ? ["UNPROCESSED"] : []),
        ...additionalCodes,
      ].map((Code) => ({
        Code,
        Name: "Synthetic fixture",
        Exchange: input.providerExchange,
        Currency: input.identity.currency,
        Type: "Common Stock",
      }));
      const provider = new EodhdCatalogClient(
        "fixture-token",
        { loadLatest: async () => null, save: async () => {} },
        async () => Response.json(rows),
        () => new Date(now.getTime() - 3600000),
      );
      const catalog = (
        await provider.refresh(input.marketId, input.tradingDate)
      ).snapshot!;
      const request = {
        marketId: input.marketId,
        tradingDate: input.tradingDate,
        mode: "SHADOW" as const,
        evaluationAt: input.evaluationAt,
        completedBarEnd: input.completedBarEnd,
        idempotencyKey: randomUUID(),
        catalog,
      };
      const run = await store.begin(request);
      return {
        input,
        result,
        store,
        request,
        run,
        setNow: (value: string) => {
          now = new Date(value);
        },
      };
    }
    async function diagnosticFixture() {
      const f = await setup(true, 1);
      const control = new PostgresDiscoveryControlStore(pool);
      const claimed = await control.claim(
        {
          marketId: f.input.marketId,
          tradingDate: f.input.tradingDate,
          policyVersion: f.input.policyVersion,
          completedBarEnd: f.input.completedBarEnd,
          idempotencyKey: f.request.idempotencyKey,
        },
        randomUUID(),
        120_000,
      );
      const lease = await control.bindRun(claimed!, f.run.id);
      const draft = new DiscoveryAttemptDiagnosticsCollector(
        {
          attemptId: "10000000-0000-4000-8000-000000000003",
          attemptKind: "FRESH",
          marketId: "US_EQUITIES",
          startedAt: new Date(f.input.evaluationAt),
          collectionDeadlineAt: new Date(
            Date.parse(f.input.evaluationAt) + 120_000,
          ),
        },
        () => 0,
      ).finish();
      return { ...f, lease, draft };
    }
    it("binds immutable completed diagnostics to final full-catalog coverage and one market", async () => {
      const f = await diagnosticFixture();
      const previousCanadianDiagnostic =
        await f.store.listLatestDiagnostics("CA_TSX");
      await f.store.recordOwned(f.run.id, f.lease, f.result, f.input);
      const run = await f.store.completeOwned(f.run.id, f.lease, null, f.draft);
      expect(run.coverage).toEqual({
        total: 2,
        pass: 1,
        fail: 0,
        unevaluable: 0,
        deferred: 1,
      });
      await expect(
        f.store.listLatestDiagnostics("US_EQUITIES"),
      ).resolves.toMatchObject({
        runId: run.id,
        marketId: "US_EQUITIES",
        attemptId: "10000000-0000-4000-8000-000000000003",
        finalRunCoverage: {
          total: 2,
          pass: 1,
          fail: 0,
          unevaluable: 0,
          deferred: 1,
        },
        frozenEvaluationAt: "2026-11-03T14:40:15.000Z",
        timingBoundary: "BEFORE_COMPLETION_TRANSACTION",
        preCompletionWallMs: 0,
        stages: { PRE_COMPLETION_PERSISTENCE: { wallMs: 0, cumulativeMs: 0 } },
      });
      // Other acceptance fixtures may already own Canadian evidence. A US
      // completion must leave that market's projection exactly unchanged.
      await expect(f.store.listLatestDiagnostics("CA_TSX")).resolves.toEqual(
        previousCanadianDiagnostic,
      );
      const rows = await pool.query(
        "SELECT run_id,market_id,attempt_id FROM discovery_run_diagnostic WHERE run_id=$1",
        [run.id],
      );
      expect(rows.rows).toEqual([
        {
          run_id: run.id,
          market_id: "US_EQUITIES",
          attempt_id: f.draft.attemptId,
        },
      ]);
      await expect(
        pool.query(
          "UPDATE discovery_run_diagnostic SET payload=payload WHERE run_id=$1",
          [run.id],
        ),
      ).rejects.toThrow("immutable");
      await expect(
        pool.query("DELETE FROM discovery_run_diagnostic WHERE run_id=$1", [
          run.id,
        ]),
      ).rejects.toThrow("immutable");
      await expect(
        pool.query(
          "INSERT INTO discovery_run_diagnostic SELECT run_id,'CA_TSX',$2::uuid,schema_version,captured_at,payload || jsonb_build_object('marketId','CA_TSX','attemptId',$2::text) FROM discovery_run_diagnostic WHERE run_id=$1",
          [run.id, randomUUID()],
        ),
      ).rejects.toThrow("foreign key");
      await expect(
        pool.query(
          "INSERT INTO discovery_run_diagnostic SELECT run_id,market_id,gen_random_uuid(),schema_version,captured_at,payload FROM discovery_run_diagnostic WHERE run_id=$1",
          [run.id],
        ),
      ).rejects.toThrow("check constraint");
    });
    it("deduplicates exact completion retries and rejects changed or later diagnostic attempts", async () => {
      const f = await diagnosticFixture();
      await f.store.completeOwned(f.run.id, f.lease, null, f.draft);
      await f.store.completeOwned(f.run.id, f.lease, null, f.draft);
      for (const changed of [
        { ...f.draft, wallMs: 999 },
        { ...f.draft, attemptId: randomUUID() },
      ]) {
        await expect(
          f.store.completeOwned(f.run.id, f.lease, null, changed),
        ).rejects.toThrow("diagnostic");
      }
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS count FROM discovery_run_diagnostic WHERE run_id=$1",
            [f.run.id],
          )
        ).rows,
      ).toEqual([{ count: 1 }]);
      const legacy = await diagnosticFixture();
      await legacy.store.completeOwned(legacy.run.id, legacy.lease);
      await expect(
        legacy.store.completeOwned(
          legacy.run.id,
          legacy.lease,
          null,
          legacy.draft,
        ),
      ).rejects.toThrow("diagnostic");
    });
    it("rejects wrong-market and stale-fence diagnostics without completing a run", async () => {
      const f = await diagnosticFixture();
      await expect(
        f.store.completeOwned(f.run.id, f.lease, null, {
          ...f.draft,
          marketId: "CA_TSX",
        }),
      ).rejects.toThrow("ownership");
      await expect(
        f.store.completeOwned(
          f.run.id,
          { ...f.lease, fencingGeneration: f.lease.fencingGeneration + 1 },
          null,
          f.draft,
        ),
      ).rejects.toThrow("lease is stale");
      await expect(
        f.store.getRun("US_EQUITIES", f.run.id),
      ).resolves.toMatchObject({ status: "RUNNING" });
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS count FROM discovery_run_diagnostic WHERE run_id=$1",
            [f.run.id],
          )
        ).rows,
      ).toEqual([{ count: 0 }]);
    });
    it("rolls back completion and deferred evidence if diagnostic insertion fails", async () => {
      const f = await diagnosticFixture();
      await pool.query(
        `ALTER TABLE discovery_run_diagnostic ADD CONSTRAINT discovery_diagnostic_fixture_fault CHECK (run_id <> '${f.run.id}'::uuid)`,
      );
      try {
        await expect(
          f.store.completeOwned(f.run.id, f.lease, null, f.draft),
        ).rejects.toThrow("discovery_diagnostic_fixture_fault");
        await expect(
          f.store.getRun("US_EQUITIES", f.run.id),
        ).resolves.toMatchObject({ status: "RUNNING" });
        expect(await f.store.listEvaluations("US_EQUITIES", f.run.id)).toEqual(
          [],
        );
      } finally {
        await pool.query(
          "ALTER TABLE discovery_run_diagnostic DROP CONSTRAINT discovery_diagnostic_fixture_fault",
        );
      }
    });
    it("cascades diagnostic retention with its run", async () => {
      const f = await diagnosticFixture();
      await f.store.completeOwned(f.run.id, f.lease, null, f.draft);
      await pool.query("DELETE FROM discovery_run WHERE id=$1", [f.run.id]);
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS count FROM discovery_run_diagnostic WHERE run_id=$1",
            [f.run.id],
          )
        ).rows,
      ).toEqual([{ count: 0 }]);
    });
    it("deduplicates concurrent run creation and rejects changed bindings", async () => {
      const f = await setup();
      const retries = await Promise.all([
        f.store.begin(f.request),
        f.store.begin(f.request),
      ]);
      expect(retries.map((run) => run.id)).toEqual([f.run.id, f.run.id]);
      await expect(
        f.store.begin({ ...f.request, mode: "AUTO_ADD" }),
      ).rejects.toThrow("idempotency conflict");
      await expect(
        f.store.begin({ ...f.request, marketId: "US_EQUITIES" }),
      ).rejects.toThrow("ownership conflict");
    });
    it("persists exact input once across retries and keeps completed facts immutable", async () => {
      const f = await setup();
      const evidence = await f.store.record(f.run.id, f.result, f.input);
      expect(evidence.inputDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(evidence.input).toEqual(f.input);
      await expect(
        f.store.getRun(f.input.marketId, f.run.id),
      ).resolves.toMatchObject({
        coverage: { total: 1, pass: 1, fail: 0, deferred: 0, unevaluable: 0 },
      });
      await f.store.record(f.run.id, f.result, f.input);
      await expect(
        f.store.getRun(f.input.marketId, f.run.id),
      ).resolves.toMatchObject({
        coverage: { total: 1, pass: 1, fail: 0, deferred: 0, unevaluable: 0 },
      });
      const run = await f.store.complete(f.run.id, f.input.marketId);
      expect(run).toMatchObject({
        status: "COMPLETED",
        coverage: { total: 1, pass: 1, fail: 0, deferred: 0, unevaluable: 0 },
      });
      expect((await f.store.record(f.run.id, f.result, f.input)).id).toBe(
        evidence.id,
      );
      await expect(
        f.store.record(f.run.id, f.result, {
          ...f.input,
          marketCap: { ...f.input.marketCap, value: 3e9 },
        }),
      ).rejects.toThrow("retry conflicts");
      await expect(
        pool.query(
          "UPDATE discovery_evaluation SET result=result WHERE id=$1",
          [evidence.id],
        ),
      ).rejects.toThrow("immutable");
      await expect(
        pool.query(
          "UPDATE discovery_run SET status='RUNNING',completed_at=NULL WHERE id=$1",
          [run.id],
        ),
      ).rejects.toThrow("immutable");
      const summary = await f.store.listEvaluations(f.input.marketId, run.id);
      expect(summary[0]).toMatchObject({ input: null, inputRetained: true });
      expect(await f.store.listEvaluations("US_EQUITIES", run.id)).toEqual([]);
    });
    it("retains every unprocessed catalog member as deferred with exact coverage", async () => {
      const f = await setup(true);
      await f.store.record(f.run.id, f.result, f.input);
      await expect(
        f.store.getRun(f.input.marketId, f.run.id),
      ).resolves.toMatchObject({
        coverage: { total: 2, pass: 1, fail: 0, unevaluable: 0, deferred: 1 },
      });
      expect(await f.store.complete(f.run.id, f.input.marketId)).toMatchObject({
        status: "PARTIAL",
        coverage: { total: 2, pass: 1, deferred: 1 },
      });
      const first = await f.store.listEvaluations(f.input.marketId, f.run.id, {
        limit: 1,
      });
      const second = await f.store.listEvaluations(f.input.marketId, f.run.id, {
        after: {
          exchange: first[0]!.result.providerExchange,
          code: first[0]!.result.providerCode,
        },
      });
      expect(second[0]).toMatchObject({
        inputRetained: false,
        result: {
          providerCode: "UNPROCESSED",
          state: "DEFERRED",
          reasons: ["BUDGET_DEFERRED"],
        },
      });
    });
    it("updates counters once for concurrent outcomes and reconciles at completion", async () => {
      const f = await setup(true, 0, ["FAILED", "UNEVALUABLE", "EXPIRED"]);
      const failedInput = { ...f.input, providerCode: "FAILED" };
      const failed = discoveryEvaluationResultSchema.parse({
        ...f.result,
        providerCode: "FAILED",
        state: "FAIL",
        reasons: ["PRICE_OUT_OF_RANGE"],
      });
      const unevaluable = discoveryEvaluationResultSchema.parse({
        ...f.result,
        providerCode: "UNEVALUABLE",
        symbolId: null,
        state: "UNEVALUABLE",
        reasons: ["METADATA_UNAVAILABLE"],
        metrics: Object.fromEntries(
          Object.keys(f.result.metrics).map((key) => [
            key,
            { value: null, asOf: null },
          ]),
        ),
      });
      const deferred = discoveryEvaluationResultSchema.parse({
        ...f.result,
        providerCode: "EXPIRED",
        symbolId: null,
        state: "DEFERRED",
        reasons: ["EVALUATION_EXPIRED"],
        metrics: Object.fromEntries(
          Object.keys(f.result.metrics).map((key) => [
            key,
            { value: null, asOf: null },
          ]),
        ),
      });

      await Promise.all([
        f.store.record(f.run.id, f.result, f.input),
        f.store.record(f.run.id, failed, failedInput),
        f.store.record(f.run.id, unevaluable, null),
        f.store.record(f.run.id, deferred, null),
        f.store.record(f.run.id, deferred, null),
      ]);

      await expect(
        f.store.getRun(f.input.marketId, f.run.id),
      ).resolves.toMatchObject({
        coverage: {
          total: 5,
          pass: 1,
          fail: 1,
          unevaluable: 1,
          deferred: 2,
        },
      });
      await expect(
        f.store.complete(f.run.id, f.input.marketId),
      ).resolves.toMatchObject({
        status: "PARTIAL",
        coverage: {
          total: 5,
          pass: 1,
          fail: 1,
          unevaluable: 1,
          deferred: 2,
        },
      });
    });
    it.each(["PROVIDER_FAILURE", "CANCELLED"] as const)(
      "distinguishes %s from a completed zero-pass screen",
      async (failure) => {
        const f = await setup();
        expect(
          (await f.store.complete(f.run.id, f.input.marketId, failure)).status,
        ).toBe(failure === "CANCELLED" ? "CANCELLED" : "FAILED");
        const g = await setup();
        await g.store.record(
          g.run.id,
          { ...g.result, state: "FAIL", reasons: ["PRICE_OUT_OF_RANGE"] },
          g.input,
        );
        expect(
          await g.store.complete(g.run.id, g.input.marketId),
        ).toMatchObject({
          status: "COMPLETED",
          coverage: { pass: 0, fail: 1, deferred: 0 },
        });
      },
    );
    it("rejects uncaptured identities and wrong input ownership before any write", async () => {
      const f = await setup(false, 1);
      await expect(
        f.store.record(
          f.run.id,
          { ...f.result, providerExchange: "NYSE" },
          f.input,
        ),
      ).rejects.toThrow("captured catalog");
      await expect(
        f.store.record(f.run.id, f.result, {
          ...f.input,
          identity: { ...f.input.identity, symbolId: 987 },
        }),
      ).rejects.toThrow("ownership conflict");
      await expect(f.store.record(f.run.id, f.result, null)).rejects.toThrow(
        "retain its input",
      );
      expect(await f.store.listEvaluations(f.input.marketId, f.run.id)).toEqual(
        [],
      );
      await f.store.ensurePolicy(discoveryPolicyForMarket("US_EQUITIES"));
      await expect(
        pool.query(
          "UPDATE discovery_policy SET definition=definition WHERE market_id='US_EQUITIES'",
        ),
      ).rejects.toThrow("immutable");
    });
    it("rolls back the result when retaining its input fails", async () => {
      const f = await setup();
      // A temporary database constraint scoped to this synthetic payload injects a
      // failure after the evaluation INSERT, inside the repository transaction.
      f.input.marketCap.value = 123456789;
      await pool.query(
        "ALTER TABLE discovery_evaluation_input ADD CONSTRAINT discovery_fixture_fault CHECK ((payload->'marketCap'->>'value')::numeric <> 123456789)",
      );
      try {
        await expect(
          f.store.record(f.run.id, f.result, f.input),
        ).rejects.toThrow("discovery_fixture_fault");
        await expect(
          f.store.getRun(f.input.marketId, f.run.id),
        ).resolves.toMatchObject({
          coverage: { total: 1, pass: 0, fail: 0, unevaluable: 0, deferred: 1 },
        });
        expect(
          await f.store.listEvaluations(f.input.marketId, f.run.id),
        ).toEqual([]);
      } finally {
        await pool.query(
          "ALTER TABLE discovery_evaluation_input DROP CONSTRAINT discovery_fixture_fault",
        );
      }
    });
    it("enforces market and catalog membership at the database boundary", async () => {
      const f = await setup();
      const g = await setup(false, 1);
      await f.store.record(f.run.id, f.result, f.input);
      await expect(
        pool.query(
          `INSERT INTO discovery_evaluation(id,run_id,market_id,policy_version,provider_code,provider_exchange,result,created_at,catalog_snapshot_id)
      SELECT $1,$2,market_id,policy_version,provider_code,provider_exchange,result,created_at,catalog_snapshot_id FROM discovery_evaluation WHERE run_id=$3`,
          [randomUUID(), g.run.id, f.run.id],
        ),
      ).rejects.toThrow("foreign key");
      await expect(
        pool.query(
          `INSERT INTO discovery_evaluation(id,run_id,market_id,policy_version,provider_code,provider_exchange,result,created_at,catalog_snapshot_id)
      SELECT $1,run_id,market_id,policy_version,'ABSENT',provider_exchange,result || '{"providerCode":"ABSENT"}'::jsonb,created_at,catalog_snapshot_id FROM discovery_evaluation WHERE run_id=$2`,
          [randomUUID(), f.run.id],
        ),
      ).rejects.toThrow("foreign key");
    });
    it("skips locked evidence during compaction while a qualification hold commits", async () => {
      const f = await setup();
      const evidence = await f.store.record(f.run.id, f.result, f.input);
      await f.store.complete(f.run.id, f.input.marketId);
      const holder = await pool.connect();
      try {
        await holder.query("BEGIN");
        await holder.query(
          "SELECT id FROM discovery_evaluation WHERE id=$1 FOR UPDATE",
          [evidence.id],
        );
        await holder.query(
          "INSERT INTO discovery_evidence_hold(evaluation_id,reason) VALUES($1,'concurrent hold fixture')",
          [evidence.id],
        );
        f.setNow("2026-12-05T15:00:00Z");
        await f.store.compact();
        await holder.query("COMMIT");
        await f.store.compact();
        expect(
          (await f.store.listEvaluations(f.input.marketId, f.run.id))[0]!
            .inputRetained,
        ).toBe(true);
      } finally {
        await holder.query("ROLLBACK");
        holder.release();
      }
    });
    it("compacts payloads while preserving digests, held evidence and unfinished runs", async () => {
      const plain = await setup();
      const held = await setup();
      const pending = await setup();
      const a = await plain.store.record(
        plain.run.id,
        plain.result,
        plain.input,
      );
      const b = await held.store.record(held.run.id, held.result, held.input);
      await pending.store.record(pending.run.id, pending.result, pending.input);
      await plain.store.complete(plain.run.id, plain.input.marketId);
      await held.store.complete(held.run.id, held.input.marketId);
      await held.store.holdEvidence(
        held.input.marketId,
        b.id,
        "retained qualification fixture",
      );
      plain.setNow("2026-12-05T15:00:00Z");
      expect((await plain.store.compact()).inputs).toBeGreaterThan(0);
      expect(
        (
          await plain.store.listEvaluations(
            plain.input.marketId,
            plain.run.id,
            { includeInput: true },
          )
        )[0],
      ).toMatchObject({
        input: null,
        inputRetained: false,
        inputDigest: a.inputDigest,
      });
      expect(
        (
          await held.store.listEvaluations(held.input.marketId, held.run.id, {
            includeInput: true,
          })
        )[0]!.input,
      ).toEqual(held.input);
      expect(
        (
          await pending.store.listEvaluations(
            pending.input.marketId,
            pending.run.id,
          )
        )[0]!.inputRetained,
      ).toBe(true);
      await expect(
        plain.store.holdEvidence(plain.input.marketId, a.id, "too late"),
      ).rejects.toThrow("unavailable");
      plain.setNow("2027-12-05T15:00:00Z");
      await plain.store.compact();
      expect(
        await plain.store.listEvaluations(plain.input.marketId, plain.run.id),
      ).toEqual([]);
      expect(
        (await held.store.listEvaluations(held.input.marketId, held.run.id))
          .length,
      ).toBe(1);
    });
  },
);
