import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  candidateIntakeEntrySchema,
  discoveryEvaluationInputSchema,
  discoveryEvaluationResultSchema,
} from "@tsx-scanner/contracts";
import { migrate } from "../src/database/migrate.js";
import { isolatedDatabaseUrl } from "./isolated-database.js";
import { PostgresDiscoveryControlStore } from "../src/universe/discovery-control-repository.js";
import { PostgresDiscoveryEvidenceStore } from "../src/universe/discovery-evidence-repository.js";
import { PostgresDiscoveryIntakeRepository } from "../src/universe/discovery-intake-repository.js";
import { EodhdCatalogClient } from "../src/universe/eodhd-catalog.js";
import { ConfiguredTsxUniverseProvider } from "../src/universe/universe-service.js";
import { PostgresUniverseStore } from "../src/universe/universe-repository.js";

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
  "discovery durable intake PostgreSQL acceptance",
  () => {
    let pool: Pool;
    let now: Date;
    let control: PostgresDiscoveryControlStore;
    let intake: PostgresDiscoveryIntakeRepository;
    let evidence: PostgresDiscoveryEvidenceStore;

    beforeAll(async () => {
      pool = new Pool({ connectionString: databaseUrl, max: 5 });
      await migrate(pool);
      control = new PostgresDiscoveryControlStore(pool);
      now = new Date("2026-11-03T14:40:15Z");
      intake = new PostgresDiscoveryIntakeRepository(pool, () => now);
      evidence = new PostgresDiscoveryEvidenceStore(pool, () => now, intake);
    }, 60_000);

    afterAll(async () => {
      await pool?.end();
    }, 60_000);

    async function setMode(mode: "OFF" | "AUTO_ADD"): Promise<number> {
      const current = await control.getMode("CA_TSX");
      if (current.mode === mode) return current.revision;
      return (
        await control.changeMode({
          marketId: "CA_TSX",
          mode,
          expectedRevision: current.revision,
          actor: "intake-acceptance",
          reason: `intake acceptance ${mode}`,
        })
      ).revision;
    }

    async function setup(mode: "SHADOW" | "AUTO_ADD" = "AUTO_ADD") {
      await setMode(mode === "AUTO_ADD" ? "AUTO_ADD" : "OFF");
      const suffix = randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase();
      const input = discoveryEvaluationInputSchema.parse({
        ...(fixture.input as object),
        providerCode: `EXAMPLE${suffix}`,
        identity: {
          ...(fixture.input as { identity: object }).identity,
          symbolId: 100_000 + Math.floor(Math.random() * 800_000),
          symbol: `EX${suffix}.TO`,
        },
      });
      const result = discoveryEvaluationResultSchema.parse({
        ...(fixture.result as object),
        providerCode: input.providerCode,
        symbolId: input.identity.symbolId,
      });
      const catalogClient = new EodhdCatalogClient(
        "fixture-token",
        { loadLatest: async () => null, save: async () => {} },
        async () =>
          Response.json([
            {
              Code: input.providerCode,
              Name: "Synthetic intake fixture",
              Exchange: input.providerExchange,
              Currency: input.identity.currency,
              Type: "Common Stock",
            },
          ]),
        () => new Date(now.getTime() - 3_600_000),
      );
      const catalog = (await catalogClient.refresh("CA_TSX", input.tradingDate))
        .snapshot!;
      const run = await evidence.begin({
        marketId: "CA_TSX",
        tradingDate: input.tradingDate,
        mode,
        evaluationAt: input.evaluationAt,
        completedBarEnd: input.completedBarEnd,
        idempotencyKey: randomUUID(),
        catalog,
      });
      return {
        input,
        result,
        run,
        setNow: (value: string) => {
          now = new Date(value);
        },
      };
    }

    it("enqueues PASS atomically and merges discovery provenance into manual metadata", async () => {
      const f = await setup();
      const universe = new ConfiguredTsxUniverseProvider(
        [],
        new PostgresUniverseStore(pool),
        () => now,
      );
      await universe.updateCandidates({
        operation: "ADD",
        source: "MANUAL",
        inputs: [f.input.identity.symbol],
        note: "operator metadata survives discovery",
        tags: ["watch"],
      });
      const recorded = await evidence.record(f.run.id, f.result, f.input);
      expect(recorded.input).toEqual(f.input);
      expect(
        await pool.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM discovery_intake_outbox WHERE evaluation_id=$1",
          [recorded.id],
        ),
      ).toMatchObject({ rows: [{ count: "1" }] });
      expect(
        await pool.query<{ reason: string }>(
          "SELECT reason FROM discovery_evidence_hold WHERE evaluation_id=$1",
          [recorded.id],
        ),
      ).toMatchObject({ rows: [{ reason: "DISCOVERY_INTAKE_OUTBOX" }] });
      await expect(
        intake.listCandidateIntakeStatuses(
          "CONFIGURED_TSX_LIVE_WATCHLIST",
          f.input.tradingDate,
          "CA_TSX",
        ),
      ).resolves.toEqual([
        expect.objectContaining({
          symbol: f.input.identity.symbol,
          status: "QUALIFIED",
          source: "MANUAL",
          attemptCount: 0,
        }),
      ]);

      const action = await intake.claimNext("CA_TSX", f.input.tradingDate);
      expect(action).toMatchObject({
        marketId: "CA_TSX",
        syncOnly: false,
        symbol: f.input.identity.symbol,
      });
      const watchlist = await pool.query<{ candidates: unknown }>(
        `SELECT candidates FROM universe_watchlist
       WHERE market_id='CA_TSX' AND provider='CONFIGURED_TSX_LIVE_WATCHLIST'`,
      );
      const candidate = candidateIntakeEntrySchema.parse(
        (watchlist.rows[0]!.candidates as unknown[]).find(
          (value) =>
            candidateIntakeEntrySchema.parse(value).normalizedSymbol ===
            f.input.identity.symbol,
        ),
      );
      expect(candidate).toMatchObject({
        source: "MANUAL",
        note: "operator metadata survives discovery",
        tags: ["watch"],
        discoveryRunId: f.run.id,
        discoveryEvaluationId: recorded.id,
        resolutionStatus: "RESOLVED",
      });
      expect(candidate.provenanceSources).toEqual(["MANUAL", "DISCOVERY"]);
      await expect(
        intake.listCandidateIntakeStatuses(
          "CONFIGURED_TSX_LIVE_WATCHLIST",
          f.input.tradingDate,
          "CA_TSX",
        ),
      ).resolves.toEqual([
        expect.objectContaining({
          symbol: f.input.identity.symbol,
          status: "ADDED",
          source: "MANUAL",
        }),
      ]);

      await intake.markSynchronizationFailed(action!.id, "scanner unavailable");
      await expect(
        intake.listCandidateIntakeStatuses(
          "CONFIGURED_TSX_LIVE_WATCHLIST",
          f.input.tradingDate,
          "CA_TSX",
        ),
      ).resolves.toEqual([
        expect.objectContaining({
          symbol: f.input.identity.symbol,
          status: "FAILED",
          reason: "scanner unavailable",
        }),
      ]);
      await pool.query(
        "UPDATE discovery_intake_outbox SET next_attempt_at=clock_timestamp() WHERE id=$1",
        [action!.id],
      );
      const retry = await intake.claimNext("CA_TSX", f.input.tradingDate);
      expect(retry).toMatchObject({ id: action!.id, syncOnly: true });
      await expect(
        intake.listCandidateIntakeStatuses(
          "CONFIGURED_TSX_LIVE_WATCHLIST",
          f.input.tradingDate,
          "CA_TSX",
        ),
      ).resolves.toEqual([
        expect.objectContaining({
          symbol: f.input.identity.symbol,
          status: "WARMING",
        }),
      ]);
      await intake.markSynchronized(retry!.id);
      expect(
        await pool.query<{ status: string; sync_status: string }>(
          "SELECT status,sync_status FROM discovery_intake_outbox WHERE id=$1",
          [action!.id],
        ),
      ).toMatchObject({
        rows: [{ status: "DELIVERED", sync_status: "COMPLETE" }],
      });
      await expect(
        intake.listCandidateIntakeStatuses(
          "CONFIGURED_TSX_LIVE_WATCHLIST",
          f.input.tradingDate,
          "CA_TSX",
        ),
      ).resolves.toEqual([
        expect.objectContaining({
          symbol: f.input.identity.symbol,
          status: "READY",
          strategyReadyAt: expect.any(String),
        }),
      ]);

      await intake.setExclusion({
        marketId: "CA_TSX",
        tradingDate: f.input.tradingDate,
        instrumentId: action!.instrument.id,
        excluded: true,
        actor: "intake-acceptance",
        reason: "operator excluded for status fixture",
      });
      await expect(
        intake.listCandidateIntakeStatuses(
          "CONFIGURED_TSX_LIVE_WATCHLIST",
          f.input.tradingDate,
          "CA_TSX",
        ),
      ).resolves.toEqual([
        expect.objectContaining({
          symbol: f.input.identity.symbol,
          status: "EXCLUDED",
          source: "DISCOVERY",
          reason: "operator excluded for status fixture",
        }),
      ]);

      await intake.setExclusion({
        marketId: "CA_TSX",
        tradingDate: f.input.tradingDate,
        instrumentId: action!.instrument.id,
        excluded: false,
        actor: "intake-acceptance",
        reason: "operator cleared status fixture",
      });
      await expect(
        intake.listCandidateIntakeStatuses(
          "CONFIGURED_TSX_LIVE_WATCHLIST",
          f.input.tradingDate,
          "CA_TSX",
        ),
      ).resolves.toEqual([]);
    });

    it("expires pending work on an OFF/revision race and permits a fresh AUTO_ADD evaluation", async () => {
      const first = await setup();
      const firstEvidence = await evidence.record(
        first.run.id,
        first.result,
        first.input,
      );
      await setMode("OFF");
      expect(
        await intake.claimNext("CA_TSX", first.input.tradingDate),
      ).toBeNull();
      expect(
        await pool.query<{ status: string }>(
          "SELECT status FROM discovery_intake_outbox WHERE evaluation_id=$1",
          [firstEvidence.id],
        ),
      ).toMatchObject({ rows: [{ status: "EXPIRED" }] });
      const expired = await pool.query<{ status: string }>(
        `SELECT o.status FROM discovery_intake_outbox o
       JOIN discovery_evaluation e ON e.id=o.evaluation_id WHERE e.run_id=$1`,
        [first.run.id],
      );
      expect(expired.rows[0]?.status).toBe("EXPIRED");

      const second = await setup();
      await evidence.record(second.run.id, second.result, second.input);
      const action = await intake.claimNext("CA_TSX", second.input.tradingDate);
      expect(action?.syncOnly).toBe(false);
      await intake.markSynchronized(
        (await intake.claimNext("CA_TSX", second.input.tradingDate))!.id,
      );
    });

    it("manual REPLACE excludes pending and delivered-but-unsynchronized discovery work", async () => {
      const pending = await setup();
      const pendingEvidence = await evidence.record(
        pending.run.id,
        pending.result,
        pending.input,
      );
      await intake.applyManualCandidates(
        "CONFIGURED_TSX_LIVE_WATCHLIST",
        "REPLACE",
        pending.input.tradingDate,
        [],
        "CA_TSX",
      );
      await expect(
        intake.claimNext("CA_TSX", pending.input.tradingDate),
      ).resolves.toBeNull();
      expect(
        await pool.query<{ status: string }>(
          "SELECT status FROM discovery_intake_outbox WHERE evaluation_id=$1",
          [pendingEvidence.id],
        ),
      ).toMatchObject({ rows: [{ status: "EXPIRED" }] });
      await expect(
        intake.listCandidateIntakeStatuses(
          "CONFIGURED_TSX_LIVE_WATCHLIST",
          pending.input.tradingDate,
          "CA_TSX",
        ),
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            symbol: pending.input.identity.symbol,
            status: "EXCLUDED",
            source: "DISCOVERY",
            reason: "MANUAL_REPLACE",
          }),
        ]),
      );

      const delivered = await setup();
      const deliveredEvidence = await evidence.record(
        delivered.run.id,
        delivered.result,
        delivered.input,
      );
      const action = await intake.claimNext(
        "CA_TSX",
        delivered.input.tradingDate,
      );
      expect(action?.syncOnly).toBe(false);
      await intake.applyManualCandidates(
        "CONFIGURED_TSX_LIVE_WATCHLIST",
        "REPLACE",
        delivered.input.tradingDate,
        [],
        "CA_TSX",
      );
      await expect(
        intake.claimNext("CA_TSX", delivered.input.tradingDate),
      ).resolves.toBeNull();
      expect(
        await pool.query<{ status: string; sync_status: string }>(
          "SELECT status,sync_status FROM discovery_intake_outbox WHERE evaluation_id=$1",
          [deliveredEvidence.id],
        ),
      ).toMatchObject({
        rows: [{ status: "EXPIRED", sync_status: "PENDING" }],
      });
    });

    it("does not enqueue SHADOW PASS evidence", async () => {
      const f = await setup("SHADOW");
      const recorded = await evidence.record(f.run.id, f.result, f.input);
      const outbox = await pool.query(
        "SELECT 1 FROM discovery_intake_outbox WHERE evaluation_id=$1",
        [recorded.id],
      );
      expect(outbox.rowCount).toBe(0);
    });

    it("expires a same-day discovery addition whose qualification is older than the validity boundary", async () => {
      const f = await setup();
      const recorded = await evidence.record(f.run.id, f.result, f.input);
      f.setNow("2026-11-03T14:42:16Z");

      await expect(
        intake.claimNext("CA_TSX", f.input.tradingDate),
      ).resolves.toBeNull();
      expect(
        await pool.query<{ status: string; last_error: string }>(
          "SELECT status,last_error FROM discovery_intake_outbox WHERE evaluation_id=$1",
          [recorded.id],
        ),
      ).toMatchObject({
        rows: [
          {
            status: "EXPIRED",
            last_error:
              "Discovery qualification freshness fence no longer valid",
          },
        ],
      });
      f.setNow("2026-11-03T14:40:15Z");
    });

    it("does not let stale synchronization overwrite the next trading day's metadata", async () => {
      const f = await setup();
      const recorded = await evidence.record(f.run.id, f.result, f.input);
      const action = await intake.claimNext("CA_TSX", f.input.tradingDate);
      expect(action?.syncOnly).toBe(false);

      const nextDate = "2026-11-04";
      const nextCandidate = candidateIntakeEntrySchema.parse({
        source: "MANUAL",
        tradingDate: nextDate,
        addedAt: "2026-11-04T14:00:00.000Z",
        originalInput: "NEXT.TO",
        marketId: "CA_TSX",
        requestedExchange: "TSX",
        normalizedSymbol: "NEXT.TO",
        resolvedInstrumentId: null,
        resolvedSymbol: "NEXT.TO",
        resolutionStatus: "PENDING",
        note: "next day metadata",
        tags: ["preserve"],
      });
      await pool.query(
        `UPDATE universe_watchlist SET trading_date=$1,candidates=$2::jsonb,symbols=$3::jsonb
         WHERE market_id='CA_TSX' AND provider='CONFIGURED_TSX_LIVE_WATCHLIST'`,
        [
          nextDate,
          JSON.stringify([nextCandidate]),
          JSON.stringify(["NEXT.TO"]),
        ],
      );

      await expect(intake.claimNext("CA_TSX", nextDate)).resolves.toBeNull();
      expect(
        await pool.query<{ candidates: unknown; trading_date: string }>(
          `SELECT candidates,trading_date::text AS trading_date FROM universe_watchlist
           WHERE market_id='CA_TSX' AND provider='CONFIGURED_TSX_LIVE_WATCHLIST'`,
        ),
      ).toMatchObject({
        rows: [{ trading_date: nextDate, candidates: [nextCandidate] }],
      });
      expect(
        await pool.query<{ status: string }>(
          "SELECT status FROM discovery_intake_outbox WHERE evaluation_id=$1",
          [recorded.id],
        ),
      ).toMatchObject({ rows: [{ status: "EXPIRED" }] });
    });

    it("retires the intake hold and outbox before deleting old evidence summaries", async () => {
      const f = await setup();
      const recorded = await evidence.record(f.run.id, f.result, f.input);
      const action = await intake.claimNext("CA_TSX", f.input.tradingDate);
      await intake.markSynchronized(action!.id);
      await evidence.complete(f.run.id, "CA_TSX");
      f.setNow("2027-12-05T15:00:00Z");

      await expect(evidence.compact()).resolves.toMatchObject({
        inputs: expect.any(Number),
        runs: expect.any(Number),
      });
      expect(
        await pool.query(
          "SELECT 1 FROM discovery_intake_outbox WHERE evaluation_id=$1",
          [recorded.id],
        ),
      ).toMatchObject({ rowCount: 0 });
      expect(
        await pool.query(
          "SELECT 1 FROM discovery_evidence_hold WHERE evaluation_id=$1",
          [recorded.id],
        ),
      ).toMatchObject({ rowCount: 0 });
      expect(
        await pool.query("SELECT 1 FROM discovery_evaluation WHERE id=$1", [
          recorded.id,
        ]),
      ).toMatchObject({ rowCount: 0 });
    }, 60_000);
  },
);
