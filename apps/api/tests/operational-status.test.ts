import { describe, expect, it } from "vitest";
import {
  computeOperationalStatus,
  type OperationalStatusInput,
} from "../src/foundation/operational-status.js";

const BASE: OperationalStatusInput = {
  databaseReady: true,
  scannerReady: true,
  marketDataMode: "live",
  auth: "CONNECTED",
  marketStatus: "OPEN",
  phase: "PREFERRED_ENTRIES",
  quoteAgeMs: 500,
  candleAgeMs: 1_000,
  benchmarkAgeMs: 2_000,
  evaluationAgeMs: 1_500,
  universeConfigured: 150,
  universeResolved: 150,
  universeEvaluated: 42,
  benchmarkReady: true,
  scannerSynchronized: true,
};

describe("computeOperationalStatus", () => {
  it("is actionable when every dependency and business condition is healthy", () => {
    const status = computeOperationalStatus(BASE);
    expect(status.actionable).toBe(true);
    expect(status.operationalReady).toBe(true);
    expect(status.reasonCodes).toEqual([]);
  });

  it("is never actionable with an empty universe, even with every dependency healthy and the session open — the highest-value W6 guard", () => {
    const status = computeOperationalStatus({
      ...BASE,
      universeConfigured: 0,
      universeResolved: 0,
      universeEvaluated: 0,
    });
    expect(status.actionable).toBe(false);
    expect(status.reasonCodes).toContain("EMPTY_UNIVERSE");
  });

  it("is never actionable when the universe resolved but zero evaluations were written during an open session", () => {
    const status = computeOperationalStatus({
      ...BASE,
      universeEvaluated: 0,
    });
    expect(status.actionable).toBe(false);
    expect(status.reasonCodes).toContain("WAITING_FOR_CANDIDATES");
  });

  it("serves the UI (does not block startup) but reports WAITING_FOR_CANDIDATES for an empty list while the session is open", () => {
    const status = computeOperationalStatus({
      ...BASE,
      universeResolved: 0,
      universeEvaluated: 0,
    });
    expect(status.serviceReady).toBe(true);
    expect(status.actionable).toBe(false);
    expect(status.reasonCodes).toContain("WAITING_FOR_CANDIDATES");
  });

  it("is non-actionable when the market is closed", () => {
    const status = computeOperationalStatus({
      ...BASE,
      marketStatus: "CLOSED",
      phase: null,
    });
    expect(status.actionable).toBe(false);
    expect(status.reasonCodes).toContain("MARKET_CLOSED");
  });

  it("is non-actionable when auth is required", () => {
    const status = computeOperationalStatus({ ...BASE, auth: "AUTH_REQUIRED" });
    expect(status.actionable).toBe(false);
    expect(status.reasonCodes).toContain("AUTH_REQUIRED");
  });

  it("is non-actionable when data is stale during an open session", () => {
    const status = computeOperationalStatus({
      ...BASE,
      quoteAgeMs: 120_000,
      staleDataThresholdMs: 60_000,
    });
    expect(status.actionable).toBe(false);
    expect(status.reasonCodes).toContain("DATA_STALE");
  });

  it("is non-actionable when benchmarks are unresolved", () => {
    const status = computeOperationalStatus({ ...BASE, benchmarkReady: false });
    expect(status.actionable).toBe(false);
    expect(status.reasonCodes).toContain("BENCHMARKS_UNRESOLVED");
  });

  it("is non-actionable when the scanner engine is unavailable/unsynchronized", () => {
    const status = computeOperationalStatus({
      ...BASE,
      scannerSynchronized: false,
    });
    expect(status.actionable).toBe(false);
    expect(status.reasonCodes).toContain("SCANNER_OUT_OF_SYNC");
  });

  it("reports SERVICE_STARTING and is not actionable before the session is resolved", () => {
    const status = computeOperationalStatus({
      ...BASE,
      marketStatus: null,
      phase: null,
    });
    expect(status.actionable).toBe(false);
    expect(status.reasonCodes).toContain("SERVICE_STARTING");
    expect(status.session).toBeNull();
  });

  it("reports serviceReady=false and is not actionable when the database is unavailable, even if business conditions are healthy", () => {
    const status = computeOperationalStatus({
      ...BASE,
      databaseReady: false,
    });
    expect(status.serviceReady).toBe(false);
    expect(status.actionable).toBe(false);
    expect(status.reasonCodes).toContain("DATABASE_UNAVAILABLE");
  });

  it("reports serviceReady=false and is not actionable when the scanner dependency is unavailable", () => {
    const status = computeOperationalStatus({
      ...BASE,
      scannerReady: false,
    });
    expect(status.serviceReady).toBe(false);
    expect(status.actionable).toBe(false);
    expect(status.reasonCodes).toContain("SCANNER_UNAVAILABLE");
  });

  it("stacks multiple simultaneous reason codes rather than reporting only the first", () => {
    const status = computeOperationalStatus({
      ...BASE,
      auth: "AUTH_REQUIRED",
      benchmarkReady: false,
      marketStatus: "CLOSED",
      phase: null,
    });
    expect(status.reasonCodes).toEqual(
      expect.arrayContaining([
        "AUTH_REQUIRED",
        "BENCHMARKS_UNRESOLVED",
        "MARKET_CLOSED",
      ]),
    );
    expect(status.actionable).toBe(false);
  });

  it("echoes marketDataMode, session, dataFreshness, and universe counts verbatim", () => {
    const status = computeOperationalStatus(BASE);
    expect(status.marketDataMode).toBe("live");
    expect(status.session).toEqual({
      marketStatus: "OPEN",
      phase: "PREFERRED_ENTRIES",
    });
    expect(status.dataFreshness).toEqual({
      quoteAgeMs: 500,
      candleAgeMs: 1_000,
      benchmarkAgeMs: 2_000,
      evaluationAgeMs: 1_500,
    });
    expect(status.universe).toEqual({
      configured: 150,
      resolved: 150,
      evaluated: 42,
    });
  });
});
