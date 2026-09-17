import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { discoveryEvaluationResultSchema } from "@tsx-scanner/contracts";
import { migrate } from "../src/database/migrate.js";
import { isolatedDatabaseUrl } from "./isolated-database.js";
import {
  runCapacityScenario,
  runCandleStateScenario,
  runDynamicMetricScenario,
  runProfileCohortScenario,
  runRestartScenario,
  type ProfileAssignment,
} from "./fixtures/discovery-capacity/full-market-scenarios.js";

const databaseUrl = isolatedDatabaseUrl("AUDIT_TEST_DATABASE_URL");
const MARKETS = ["CA_TSX", "US_EQUITIES"] as const;

/** Fresh-quote group: collection stays inside the 30-second quote rule so the
 * frozen evaluation itself decides price and market-cap thresholds. */
const FRESH_GATE_PROFILES: readonly ProfileAssignment[] = [
  { profile: "ELIGIBLE", count: 1 },
  { profile: "LOW_MARKET_CAP", count: 1 },
  { profile: "PRICE_OUT_OF_RANGE", count: 1 },
];

/** Availability group: gates that must not spend later-stage requests. */
const AVAILABILITY_PROFILES: readonly ProfileAssignment[] = [
  { profile: "MISSING_METADATA", count: 1 },
  { profile: "MISSING_QUOTE", count: 1 },
  { profile: "HALTED_QUOTE", count: 1 },
  { profile: "DELAYED_QUOTE", count: 1 },
  { profile: "UNRESOLVED_MAPPING", count: 1 },
];

/** History group: daily history is fetched once, then slot history is either
 * skipped (insufficient daily) or requested and reported missing. */
const HISTORY_PROFILES: readonly ProfileAssignment[] = [
  { profile: "MISSING_DAILY_HISTORY", count: 1 },
  { profile: "SPARSE_DAILY_HISTORY", count: 1 },
  { profile: "MISSING_SLOT_HISTORY", count: 1 },
];

const AVAILABILITY_REASONS: Record<string, string> = {
  MISSING_METADATA: "METADATA_UNAVAILABLE",
  MISSING_QUOTE: "QUOTE_UNAVAILABLE",
  HALTED_QUOTE: "QUOTE_HALTED",
  DELAYED_QUOTE: "QUOTE_DELAYED",
  UNRESOLVED_MAPPING: "MAPPING_UNAVAILABLE",
};

describe.skipIf(!databaseUrl)(
  "synthetic discovery capacity, not commissioning evidence",
  () => {
    let pool: Pool;
    beforeAll(async () => {
      pool = new Pool({ connectionString: databaseUrl, max: 12 });
      await migrate(pool);
    }, 60_000);
    afterAll(async () => pool?.end());

    // Catches reducing the denominator, replacing the shared limiter, expanding
    // enrichment past the four workers, or turning synthetic inputs into passes.
    it.each(["COINCIDENT", "STAGGERED"] as const)(
      "%s mapping; virtual 100ms provider latency, zero database latency, two full markets share 1 discovery request/s",
      async (mapping) => {
        const report = await runCapacityScenario(pool, {
          mapping,
          fullMarket: true,
          providerLatencyMs: 100,
          concurrentMonitoring: true,
        });
        expect(report.assumptions).toMatchObject({
          evidence: "SYNTHETIC_CAPACITY_ONLY",
          commissioningValidity: "UNVERIFIED",
          providerLatencyMs: 100,
          databaseVirtualLatencyMs: 0,
          workersPerMarket: 4,
          discoverySpacingMs: 1_000,
          collectionDeadlineMs: 120_000,
          quoteFreshnessMs: 30_000,
          mapping,
        });
        expect(report.markets.CA_TSX!.catalog).toEqual({
          rowCount: 875,
          admittedCount: 857,
        });
        expect(report.markets.US_EQUITIES!.catalog).toEqual({
          rowCount: 5321,
          admittedCount: 5087,
        });
        expect(report.sharedLimiter.discoveryRequests).toBeGreaterThan(120);
        expect(report.sharedLimiter.discoveryDispatched).toBeLessThanOrEqual(
          121,
        );
        expect(
          report.sharedLimiter.minimumDiscoverySpacingMs,
        ).toBeGreaterThanOrEqual(1_000);
        expect(report.sharedLimiter.monitoringCompleted).toBe(3);
        expect(
          report.markets.CA_TSX!.diagnostics!.stages.ENRICHMENT.batches.maxSize,
        ).toBeLessThanOrEqual(4);
        expect(report.markets.US_EQUITIES!.run!.coverage.total).toBe(5321);
        for (const market of Object.values(report.markets)) {
          expect(market.run).toMatchObject({
            mode: "SHADOW",
            status: "PARTIAL",
            coverage: { pass: 0, fail: 0 },
          });
          expect(market.run!.coverage.deferred).toBeGreaterThan(0);
          expect(market.persisted.evaluations).toBe(market.catalog.rowCount);
          expect(market.persisted.diagnostics).toBe(1);
          expect(market.persisted.wrongMarketEvaluations).toBe(0);
          expect(market.evaluator.successfulResponses).toBeGreaterThan(0);
          expect(market.internal!.reasonCounts.ADJUSTMENT_UNVERIFIED).toBe(
            market.evaluator.successfulResponses,
          );
          expect(market.retainedInputs).toHaveLength(
            market.evaluator.successfulResponses,
          );
          for (const input of market.retainedInputs) {
            expect(input.marketId).toBe(market.run!.marketId);
            expect(input.adjustment.verified).toBe(false);
          }
          const retainedEvaluations = market.evaluationSummaries.filter(
            (evaluation) => evaluation.inputRetained,
          );
          expect(retainedEvaluations).toHaveLength(
            market.evaluator.successfulResponses,
          );
          for (const evaluation of retainedEvaluations) {
            expect(evaluation.state).toBe("UNEVALUABLE");
            expect(evaluation.reasons).toContain("ADJUSTMENT_UNVERIFIED");
          }
          expect(market.internal!.stages.ENRICHMENT.batches.maxSize).toBe(
            mapping === "COINCIDENT" ? 4 : 1,
          );
          expect(market.diagnostics!.timingBoundary).toBe(
            "BEFORE_COMPLETION_TRANSACTION",
          );
          expect(market.diagnostics!.preCompletionWallMs).toBeGreaterThan(0);
          expect(market.internal!.wallMs).toBeGreaterThanOrEqual(
            market.diagnostics!.preCompletionWallMs,
          );
          expect(
            market.internal!.reasonCounts.EVALUATION_EXPIRED,
          ).toBeGreaterThan(0);
        }
        expect(report.hostWallMs).toBeGreaterThan(0);
        expect(report.sharedLimiter.queuedAfterCompletion).toBe(0);
        console.info("capacity fixture", JSON.stringify(report.summary));
      },
      180_000,
    );

    it("rejects a US-only evaluator schema failure after the real full-market schedulers finish; virtual 100ms provider latency", async () => {
      const parseResult = discoveryEvaluationResultSchema.parse;
      // Corrupt only a real US evaluator response at its schema boundary.
      // The scheduler's fallback PROVIDER_FAILURE result remains schema-valid,
      // so persistence still completes and cannot make this test fail for us.
      const schemaFault = vi
        .spyOn(discoveryEvaluationResultSchema, "parse")
        .mockImplementation((value, parameters) => {
          const result = value as {
            marketId?: string;
            reasons?: string[];
          };
          return parseResult(
            result?.marketId === "US_EQUITIES" &&
              result.reasons?.includes("ADJUSTMENT_UNVERIFIED")
              ? { ...result, symbolId: "synthetic-invalid-symbol-id" }
              : value,
            parameters,
          );
        });
      try {
        await expect(
          runCapacityScenario(pool, {
            fullMarket: true,
            providerLatencyMs: 100,
          }).then((report) => ({
            canadianEvaluatorEvidence:
              report.markets.CA_TSX!.internal!.reasonCounts
                .ADJUSTMENT_UNVERIFIED,
            usProviderFailures:
              report.markets.US_EQUITIES!.internal!.reasonCounts
                .PROVIDER_FAILURE,
          })),
        ).rejects.toThrow("US_EQUITIES evaluator boundary");
      } finally {
        schemaFault.mockRestore();
      }
    }, 180_000);

    // Catches changing >30s to >=30s or recording provider last trade time as now.
    it.each([30_000, 30_001])(
      "virtual quote-to-freeze age %ims; zero provider latency except declared slot tail",
      async (quoteAgeAtFreezeMs) => {
        const report = await runCapacityScenario(pool, {
          providerLatencyMs: 0,
          quoteAgeAtFreezeMs,
        });
        const market = report.markets.CA_TSX!;
        expect(report.assumptions.quoteAgeAtFreezeMs).toBe(quoteAgeAtFreezeMs);
        expect(market.run).toMatchObject({
          mode: "SHADOW",
          coverage: { total: 1, pass: 0, fail: 0, unevaluable: 1 },
        });
        expect(market.internal!.reasonCounts.ADJUSTMENT_UNVERIFIED).toBe(1);
        expect(market.internal!.quoteAgeBuckets).toMatchObject(
          quoteAgeAtFreezeMs === 30_000
            ? { fresh: 1, stale: 0 }
            : { fresh: 0, stale: 1 },
        );
        expect(market.internal!.reasonCounts.QUOTE_STALE ?? 0).toBe(
          quoteAgeAtFreezeMs === 30_000 ? 0 : 1,
        );
        expect(market.retainedInputs[0]!.adjustment.verified).toBe(false);
      },
      60_000,
    );

    it("warm then restart-cold candles; virtual 100ms provider latency and 5-minute cycle separation", async () => {
      const result = await runCandleStateScenario(pool);
      expect(result.assumptions).toMatchObject({
        providerLatencyMs: 100,
        cycleSeparationMs: 300_000,
      });
      expect(result.warm.internal.stages.DAILY_HISTORY.cache.partialHit).toBe(
        1,
      );
      expect(result.restarted.internal.stages.DAILY_HISTORY.cache.miss).toBe(1);
      expect(result.restarted.internal.stages.MAPPING.cache.hit).toBe(1);
      expect(result.warm.maximumDailyRangeMs).toBeLessThan(2 * 86_400_000);
      expect(result.restarted.maximumDailyRangeMs).toBe(600 * 86_400_000);
      expect(result.restarted.maximumSlotRangeMs).toBe(21 * 86_400_000);
      expect(
        result.warm.run.coverage.pass + result.restarted.run.coverage.pass,
      ).toBe(0);
    }, 60_000);

    // Catches losing a peer on partial data, wrong 404 handling, missing 401 retry,
    // and accidental retries of a 504 that were never part of adapter semantics.
    it.each(["PARTIAL", "404", "401", "504"] as const)(
      "%s transport response; virtual 100ms latency, four real workers",
      async (fault) => {
        const report = await runCapacityScenario(pool, {
          providerLatencyMs: 100,
          fault,
        });
        const market = report.markets.CA_TSX!;
        expect(market.run).toMatchObject({
          mode: "SHADOW",
          coverage: { total: 4, pass: 0, fail: 0 },
        });
        expect(market.persisted.evaluations).toBe(4);
        if (fault === "PARTIAL")
          expect(market.internal!.reasonCounts.QUOTE_UNAVAILABLE).toBe(1);
        if (fault === "404") {
          expect(
            market.evaluationSummaries.find(
              (entry) => entry.symbolId === 100_001,
            ),
          ).toMatchObject({
            reasons: ["INSUFFICIENT_DAILY_HISTORY"],
            inputRetained: false,
          });
          expect(market.retainedInputs).toHaveLength(3);
          expect(market.internal!.requests.DAILY_HISTORY.failed).toBe(1);
          expect(market.internal!.requests.SLOT_HISTORY.dispatched).toBe(3);
        }
        if (fault === "401")
          expect(market.internal!.requests.QUOTE.http401Retries).toBe(1);
        if (fault === "504")
          expect(market.internal!.reasonCounts.PROVIDER_FAILURE).toBe(1);
        expect(report.sharedLimiter.queuedAfterCompletion).toBe(0);
      },
      60_000,
    );

    it("cancel before begin; virtual 100ms transport and explicit cancellation at 500ms", async () => {
      const report = await runCapacityScenario(pool, {
        providerLatencyMs: 100,
        cancelAtMs: 500,
      });
      expect(report.markets.CA_TSX!.run).toBeNull();
      expect(report.markets.CA_TSX!.persisted).toMatchObject({
        evaluations: 0,
        diagnostics: 0,
      });
      expect(
        report.markets.CA_TSX!.internal!.requests.QUOTE.cancelled,
      ).toBeGreaterThan(0);
      expect(report.sharedLimiter.queuedAfterCompletion).toBe(0);
    }, 60_000);

    it.each(["BEFORE_BEGIN", "AFTER_BEGIN", "POSTGRES_BUDGET"] as const)(
      "%s restart with expired PostgreSQL fixture lease; virtual 100ms provider latency, real database clock for grants/leases",
      async (boundary) => {
        const report = await runRestartScenario(pool, boundary);
        expect(report.assumptions).toMatchObject({
          providerLatencyMs: 100,
          leaseClock: "POSTGRES_WALL_CLOCK",
        });
        expect(report.orphanDiagnosticCount).toBe(0);
        if (boundary === "BEFORE_BEGIN") {
          expect(report.oldLeaseStatus).toBe("EXPIRED");
          expect(report.recoveredSameRun).toBe(false);
          expect(report.abandonedScheduleRunCount).toBe(0);
        } else {
          expect(report.recoveredSameRun).toBe(true);
          expect(report.internal.attemptKind).toBe("RECOVERY");
          expect(report.diagnosticCount).toBe(1);
          expect(report.frozenBoundaryUnchanged).toBe(true);
        }
        expect(report.run.coverage.pass + report.run.coverage.fail).toBe(0);
        if (boundary === "AFTER_BEGIN")
          expect(report.internal.reasonCounts.FUTURE_OBSERVATION).toBe(1);
        if (boundary === "POSTGRES_BUDGET") {
          expect(report.budget).toMatchObject({
            grantsBefore: 9000,
            discoveryGrantedAfterRestart: false,
            monitoringGrantedAfterRestart: true,
            discoveryGrantsAfter: 0,
          });
          expect(report.run.status).toBe("CANCELLED");
        }
      },
      60_000,
    );

    it("decides fresh price and market-cap failures in the frozen evaluation and projects staged pruning", async () => {
      for (const marketId of MARKETS) {
        const report = await runProfileCohortScenario(pool, {
          profiles: FRESH_GATE_PROFILES,
          marketIds: [marketId],
        });
        expect(report.assumptions).toMatchObject({
          evidence: "SYNTHETIC_CAPACITY_ONLY",
          commissioningValidity: "UNVERIFIED",
          databaseVirtualLatencyMs: 0,
          workersPerMarket: 4,
          discoverySpacingMs: 1_000,
          collectionDeadlineMs: 120_000,
          quoteFreshnessMs: 30_000,
          stagedScreening:
            "PROJECTION_ONLY_EVALUATOR_DERIVED_NO_PRODUCTION_PRUNE",
        });
        expect(report.sharedLimiter.queuedAfterCompletion).toBe(0);
        const market = report.markets[marketId]!;
        expect(market.catalog).toEqual({ rowCount: 3, admittedCount: 3 });
        expect(market.run!.coverage).toMatchObject({
          total: 3,
          pass: 0,
          fail: 0,
        });
        const members = new Map(
          market.members.map((member) => [member.profile, member]),
        );
        const eligible = members.get("ELIGIBLE")!;
        expect(eligible.state).toBe("UNEVALUABLE");
        expect(eligible.inputRetained).toBe(true);
        expect(eligible.reasons).toContain("ADJUSTMENT_UNVERIFIED");
        expect(eligible.reasons).not.toContain("QUOTE_STALE");
        expect(eligible.reasons).not.toContain("PRICE_OUT_OF_RANGE");
        expect(eligible.reasons).not.toContain("MARKET_CAP_THRESHOLD");
        expect(eligible.requests.daily).toBeGreaterThan(0);
        expect(eligible.requests.slot).toBeGreaterThan(0);
        const lowCap = members.get("LOW_MARKET_CAP")!;
        expect(lowCap.state).toBe("UNEVALUABLE");
        expect(lowCap.inputRetained).toBe(true);
        expect(lowCap.reasons).toContain("MARKET_CAP_THRESHOLD");
        expect(lowCap.requests.slot).toBeGreaterThan(0);
        const outOfRange = members.get("PRICE_OUT_OF_RANGE")!;
        expect(outOfRange.state).toBe("UNEVALUABLE");
        expect(outOfRange.inputRetained).toBe(true);
        expect(outOfRange.reasons).toContain("PRICE_OUT_OF_RANGE");
        expect(outOfRange.quotePrice).toBe(1_000);
        expect(outOfRange.requests.slot).toBeGreaterThan(0);
        // Evaluator-derived projection: price and market-cap failures are
        // slot-independent, so those slot requests were avoidable; the
        // supporting metadata/quote requests are not.
        expect(market.stagedPruningProjection).toEqual({
          boundary: "EVALUATOR_DERIVED_PROJECTION_NOT_A_MEASURED_STAGED_RUN",
          admittedMembers: 3,
          membersWithSlotIndependentFailures: 2,
          slotRequestsIssued: 3,
          avoidableSlotRequests: 2,
          dailyRequestsIssued: 3,
          metadataQuoteMembers: 3,
        });
        console.info(
          "fresh gate cohort",
          marketId,
          JSON.stringify(market.stagedPruningProjection),
        );
      }
    }, 180_000);

    it("suppresses downstream requests for availability-gated members and accounts for every row", async () => {
      for (const marketId of MARKETS) {
        const report = await runProfileCohortScenario(pool, {
          profiles: AVAILABILITY_PROFILES,
          marketIds: [marketId],
        });
        expect(report.sharedLimiter.queuedAfterCompletion).toBe(0);
        const market = report.markets[marketId]!;
        expect(market.catalog).toEqual({ rowCount: 5, admittedCount: 5 });
        expect(market.run!.coverage).toMatchObject({
          total: 5,
          pass: 0,
          fail: 0,
        });
        expect(market.members.every((member) => member.state !== null)).toBe(
          true,
        );
        for (const member of market.members) {
          expect(member.state).toBe("UNEVALUABLE");
          expect(member.reasons).toContain(
            AVAILABILITY_REASONS[member.profile!]!,
          );
          expect(member.inputRetained).toBe(false);
          expect(member.requests.daily).toBe(0);
          expect(member.requests.slot).toBe(0);
          if (member.profile === "UNRESOLVED_MAPPING") {
            expect(member.requests.searches).toBeGreaterThan(0);
            expect(member.requests.quotes).toBe(0);
          } else {
            expect(member.requests.quotes).toBeGreaterThan(0);
          }
        }
      }
    }, 180_000);

    it("skips slot history after daily-history rejection and reports a missing slot stage", async () => {
      for (const marketId of MARKETS) {
        const report = await runProfileCohortScenario(pool, {
          profiles: HISTORY_PROFILES,
          catalogExcludedCount: 1,
          marketIds: [marketId],
        });
        expect(report.sharedLimiter.queuedAfterCompletion).toBe(0);
        const market = report.markets[marketId]!;
        expect(market.catalog).toEqual({ rowCount: 4, admittedCount: 3 });
        expect(market.run!.coverage).toMatchObject({
          total: 4,
          pass: 0,
          fail: 0,
        });
        expect(market.members).toHaveLength(4);
        expect(market.members.every((member) => member.state !== null)).toBe(
          true,
        );
        for (const reason of [
          "MISSING_DAILY_HISTORY",
          "SPARSE_DAILY_HISTORY",
        ]) {
          const member = market.members.find(
            (entry) => entry.profile === reason,
          )!;
          expect(member.state).toBe("UNEVALUABLE");
          expect(member.reasons).toEqual(["INSUFFICIENT_DAILY_HISTORY"]);
          expect(member.inputRetained).toBe(false);
          expect(member.requests.daily).toBeGreaterThan(0);
          expect(member.requests.slot).toBe(0);
        }
        const missingSlot = market.members.find(
          (entry) => entry.profile === "MISSING_SLOT_HISTORY",
        )!;
        expect(missingSlot.state).toBe("UNEVALUABLE");
        expect(missingSlot.reasons).toContain("INSUFFICIENT_SLOT_HISTORY");
        expect(missingSlot.inputRetained).toBe(true);
        expect(missingSlot.requests.daily).toBeGreaterThan(0);
        expect(missingSlot.requests.slot).toBeGreaterThan(0);
        const excluded = market.members.find(
          (entry) => entry.catalogReasons.length > 0,
        )!;
        expect(excluded.state).toBe("UNEVALUABLE");
        expect(excluded.reasons).toContain("CLASSIFICATION_REVIEW_REQUIRED");
        expect(excluded.requests).toEqual({
          searches: 0,
          details: 0,
          quotes: 0,
          daily: 0,
          slot: 0,
        });
      }
    }, 180_000);

    it("runs mixed cohorts for both markets through one shared limiter with monitoring interleaved", async () => {
      const report = await runProfileCohortScenario(pool, {
        profiles: FRESH_GATE_PROFILES,
        concurrentMonitoring: true,
      });
      expect(report.sharedLimiter.monitoringCompleted).toBe(3);
      expect(report.sharedLimiter.discoveryDispatched).toBeGreaterThan(0);
      if (report.sharedLimiter.discoveryDispatched > 1)
        expect(
          report.sharedLimiter.minimumDiscoverySpacingMs,
        ).toBeGreaterThanOrEqual(1_000);
      expect(report.sharedLimiter.queuedAfterCompletion).toBe(0);
      let avoidable = 0;
      let issued = 0;
      for (const marketId of MARKETS) {
        const market = report.markets[marketId]!;
        expect(market.catalog).toEqual({ rowCount: 3, admittedCount: 3 });
        expect(market.run!.coverage).toMatchObject({
          total: 3,
          pass: 0,
          fail: 0,
        });
        expect(market.members.every((member) => member.state !== null)).toBe(
          true,
        );
        avoidable += market.stagedPruningProjection.avoidableSlotRequests;
        issued += market.stagedPruningProjection.slotRequestsIssued;
      }
      expect(avoidable).toBe(4);
      expect(issued).toBe(6);
    }, 180_000);

    it("keeps price, ATR percentage and dollar volume dynamic while daily history stays reused", async () => {
      const result = await runDynamicMetricScenario(pool);
      expect(result.assumptions).toMatchObject({
        evidence: "SYNTHETIC_CAPACITY_ONLY",
        commissioningValidity: "UNVERIFIED",
        cycleSeparationMs: 300_000,
        probe: "SYNTHETIC_UNADJUSTED_CONVENTION_NOT_EVIDENCE",
      });
      expect(result.first.input.quote!.price).toBe(50);
      expect(result.second.input.quote!.price).toBe(1_000);
      // Reusable history: the cold cycle fetches the 600-day window; the warm
      // cycle requests only the missing suffix and reuses the cache.
      expect(result.first.dailyRanges).toHaveLength(1);
      expect(result.first.dailyRanges[0]!).toBe(600 * 86_400_000);
      expect(result.second.dailyCache?.miss).toBe(0);
      expect(result.second.dailyRanges).toHaveLength(1);
      expect(result.second.dailyRanges[0]!).toBeLessThan(2 * 86_400_000);
      // Dynamic current-price calculations: the evaluator probe sees the same
      // retained history but recomputes price, ATR percent and dollar volume.
      const firstProbe = result.first.probe;
      const secondProbe = result.second.probe;
      expect(firstProbe.state).not.toBe("PASS");
      expect(secondProbe.state).not.toBe("PASS");
      expect(firstProbe.reasons).not.toContain("PRICE_OUT_OF_RANGE");
      expect(secondProbe.reasons).toContain("PRICE_OUT_OF_RANGE");
      expect(firstProbe.metrics.price.value).toBe(50);
      expect(secondProbe.metrics.price.value).toBe(1_000);
      expect(firstProbe.metrics.dollarVolume30d.value).not.toBeNull();
      expect(secondProbe.metrics.dollarVolume30d.value).toBeCloseTo(
        firstProbe.metrics.dollarVolume30d.value! * 20,
        6,
      );
      expect(firstProbe.metrics.atrPct.value).not.toBeNull();
      expect(secondProbe.metrics.atrPct.value).toBeCloseTo(
        firstProbe.metrics.atrPct.value! / 20,
        10,
      );
      // Observations stay anchored to their retrieval time; the later cycle
      // advances the evaluation boundary instead of backdating inputs.
      for (const cycle of [result.first.input, result.second.input]) {
        const evaluationAt = Date.parse(cycle.evaluationAt);
        for (const bar of cycle.dailyBars)
          expect(Date.parse(bar.observedAt)).toBeLessThanOrEqual(evaluationAt);
        expect(Date.parse(cycle.quote!.observedAt)).toBeLessThanOrEqual(
          evaluationAt,
        );
      }
      expect(Date.parse(result.second.input.evaluationAt)).toBeGreaterThan(
        Date.parse(result.first.input.evaluationAt),
      );
      expect(result.first.run!.coverage.pass).toBe(0);
      expect(result.second.run!.coverage.pass).toBe(0);
      console.info(
        "dynamic metric scenario",
        JSON.stringify({
          first: {
            price: firstProbe.metrics.price.value,
            atrPct: firstProbe.metrics.atrPct.value,
            dollarVolume30d: firstProbe.metrics.dollarVolume30d.value,
            dailyRange: result.first.dailyRanges[0],
          },
          second: {
            price: secondProbe.metrics.price.value,
            atrPct: secondProbe.metrics.atrPct.value,
            dollarVolume30d: secondProbe.metrics.dollarVolume30d.value,
            dailyRange: result.second.dailyRanges[0],
          },
        }),
      );
    }, 180_000);
  },
);
