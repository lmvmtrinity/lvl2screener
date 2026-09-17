import { describe, expect, it } from "vitest";
import { mergeMarketStatus } from "./market-merge.js";

describe("mergeMarketStatus", () => {
  it("clears an error the incoming snapshot omits so recovered failures stop rendering", () => {
    const current = {
      state: "ACTIVE",
      lastError: "funded recovery failed",
      lastQuoteAt: "2026-09-12T14:00:00.000Z",
      lastCandleAt: "2026-09-12T13:59:00.000Z",
    };
    const merged = mergeMarketStatus(current, {
      state: "ACTIVE",
      dataStatus: "REALTIME",
    });
    expect(merged).not.toHaveProperty("lastError");
    expect(merged).not.toHaveProperty("lastQuoteAt");
    expect(merged).not.toHaveProperty("lastCandleAt");
    expect(merged.dataStatus).toBe("REALTIME");
  });

  it("preserves REST-filled telemetry that WebSocket frames strip on purpose", () => {
    const current = {
      state: "ACTIVE",
      lastEvaluationAgeMs: 400,
      lastCycleDurationMs: 120,
    };
    const merged = mergeMarketStatus(current, {
      state: "ACTIVE",
      dataStatus: "REALTIME",
    });
    expect(merged.lastEvaluationAgeMs).toBe(400);
    expect(merged.lastCycleDurationMs).toBe(120);
  });

  it("keeps an incoming error and unrelated prior fields", () => {
    const merged = mergeMarketStatus(
      { state: "ACTIVE", instrumentCount: 3 },
      { state: "ACTIVE", lastError: "quote unavailable" },
    );
    expect(merged.lastError).toBe("quote unavailable");
    expect(merged.instrumentCount).toBe(3);
  });
});
