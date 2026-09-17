import { describe, expect, it } from "vitest";
import { DiscoveryAttemptDiagnosticsCollector } from "../src/universe/discovery-attempt-diagnostics.js";

const identity = {
  attemptId: "10000000-0000-4000-8000-000000000002",
  attemptKind: "FRESH" as const,
  marketId: "US_EQUITIES" as const,
  startedAt: new Date("2026-09-15T16:00:00.000Z"),
  collectionDeadlineAt: new Date("2026-09-15T16:02:00.000Z"),
};

describe("discovery attempt diagnostics", () => {
  it("includes active work at termination and ignores late completion", () => {
    let now = 0;
    const collector = new DiscoveryAttemptDiagnosticsCollector(
      identity,
      () => now,
    );
    const stop = collector.startStage("DAILY_HISTORY");
    now = 40;
    const terminal = collector.finish();
    now = 90;
    stop();
    expect(terminal.stages.DAILY_HISTORY).toMatchObject({
      wallMs: 40,
      cumulativeMs: 40,
    });
    expect(collector.snapshot()).toEqual(terminal);
  });
  it("separates overlapping wall time from cumulative work and aggregates batch occupancy", () => {
    let now = 0;
    const collector = new DiscoveryAttemptDiagnosticsCollector(
      identity,
      () => now,
    );
    const first = collector.startStage("ENRICHMENT");
    const second = collector.startStage("ENRICHMENT");
    collector.recordBatch("ENRICHMENT", { members: 4, uniqueSymbols: 4 });
    now = 40;
    first();
    second();
    expect(collector.snapshot()).toMatchObject({
      wallMs: 40,
      stages: {
        ENRICHMENT: {
          wallMs: 40,
          cumulativeMs: 80,
          batches: {
            count: 1,
            minSize: 4,
            maxSize: 4,
            members: 4,
            uniqueSymbols: 4,
          },
        },
      },
    });
  });

  it("accepts only matching aggregate request events and drops raw fields", () => {
    const collector = new DiscoveryAttemptDiagnosticsCollector(identity);
    const event = {
      attemptId: identity.attemptId,
      operation: "QUOTE" as const,
      phase: "SETTLED" as const,
      at: identity.startedAt,
      requestedItems: 4,
      outcome: "FAILED" as const,
      queueWaitMs: 10,
      executionMs: 20,
      symbol: "SECRET_SYMBOL",
      error: new Error("SECRET_FAILURE"),
      url: "SECRET_URL",
    };
    collector.observe(event);
    collector.observe({ ...event, attemptId: "another-attempt" });
    const snapshot = collector.snapshot();
    expect(snapshot.requests.QUOTE).toMatchObject({
      settled: 1,
      failed: 1,
      queueWaitMs: 10,
      executionMs: 20,
    });
    expect(JSON.stringify(snapshot)).not.toMatch(/SECRET|symbol|url|error/);
  });

  it("freezes terminal aggregates and uses the frozen quote boundary", () => {
    let now = 0;
    const collector = new DiscoveryAttemptDiagnosticsCollector(
      identity,
      () => now,
    );
    collector.recordQuoteAge(
      "2026-09-15T16:00:00.000Z",
      "2026-09-15T16:00:40.000Z",
    );
    collector.recordQuoteAge(
      "2026-09-15T16:00:10.000Z",
      "2026-09-15T16:00:40.000Z",
    );
    collector.recordQuoteAge(
      "2026-09-15T16:00:41.000Z",
      "2026-09-15T16:00:40.000Z",
    );
    collector.recordQuoteAge(null, "2026-09-15T16:00:40.000Z");
    collector.recordQuoteAge(
      "2026-09-15T16:00:10.000Z",
      "2026-09-15T16:00:40.000Z",
      "2026-09-15T16:00:41.000Z",
    );
    collector.recordReasons(["QUOTE_STALE", "QUOTE_STALE"]);
    collector.recordCache("DAILY_HISTORY", "PARTIAL_HIT");
    collector.recordLoadedBars("DAILY_HISTORY", 12);
    now = 40;
    const terminal = collector.finish();
    now = 60;
    collector.recordReasons(["PROVIDER_FAILURE"]);
    expect(collector.snapshot()).toEqual(terminal);
    expect(terminal).toMatchObject({
      wallMs: 40,
      quoteAgeBuckets: { missing: 1, future: 2, fresh: 1, stale: 1 },
      reasonCounts: { QUOTE_STALE: 1 },
      stages: { DAILY_HISTORY: { cache: { partialHit: 1 }, loadedBars: 12 } },
    });
  });

  it("classifies old or missing price timestamps as stale and prices ahead of observation as future", () => {
    const collector = new DiscoveryAttemptDiagnosticsCollector(identity);
    collector.recordQuoteAge(
      "2026-09-15T16:00:35.000Z",
      "2026-09-15T16:00:40.000Z",
      "2026-09-15T16:00:00.000Z",
    );
    collector.recordQuoteAge(
      "2026-09-15T16:00:35.000Z",
      "2026-09-15T16:00:40.000Z",
      null,
    );
    collector.recordQuoteAge(
      "2026-09-15T16:00:35.000Z",
      "2026-09-15T16:00:40.000Z",
      "2026-09-15T16:00:39.000Z",
    );
    expect(collector.snapshot().quoteAgeBuckets).toEqual({
      missing: 0,
      fresh: 0,
      future: 1,
      stale: 2,
    });
  });
});
