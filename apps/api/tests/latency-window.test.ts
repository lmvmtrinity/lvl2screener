import { describe, expect, it } from "vitest";
import { LatencyWindow } from "../src/observability/latency-window.js";

describe("LatencyWindow", () => {
  it("reports nearest-rank p95 and retains only the bounded sample", () => {
    const window = new LatencyWindow(4);
    [10, 20, 30, 40, 50].forEach((value) => window.record(value));

    expect(window.sampleCount).toBe(4);
    expect(window.p95()).toBe(50);
  });

  it("clamps negative values and preserves sub-millisecond precision", () => {
    const window = new LatencyWindow(2);
    window.record(-10);
    window.record(12.345);

    expect(window.p95()).toBe(12.35);
  });

  it("rejects invalid samples and capacities", () => {
    expect(() => new LatencyWindow(0)).toThrow(RangeError);
    expect(() => new LatencyWindow(1.5)).toThrow(RangeError);

    const window = new LatencyWindow();
    expect(() => window.record(Number.NaN)).toThrow(TypeError);
  });
});
