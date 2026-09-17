import { expect, it } from "vitest";
import { sampledExcursion } from "../src/backtests/sampled-excursions.js";

const base = {
  entryAt: "2026-09-01T14:00:00Z",
  exitAt: "2026-09-01T14:03:00Z",
  entryPrice: 100,
  lotCount: 1,
  coverageVerified: true,
};

it("uses only observed admissible bid marks inside the owned interval", () => {
  const result = sampledExcursion({
    ...base,
    marks: [
      { timestamp: "2026-09-01T13:59:00Z", bid: 50, admissible: true },
      { timestamp: "2026-09-01T14:01:00Z", bid: 99, admissible: true },
      { timestamp: "2026-09-01T14:02:00Z", bid: 103, admissible: true },
      { timestamp: "2026-09-01T14:02:30Z", bid: 1, admissible: false },
      { timestamp: "2026-09-01T14:04:00Z", bid: 200, admissible: true },
    ],
  });
  expect(result.status).toBe("AVAILABLE");
  expect(result.samples).toBe(2);
  expect(result.adversePct).toBeCloseTo(-1);
  expect(result.favorablePct).toBeCloseTo(3);
});

it("excludes exact entry and exit boundaries", () => {
  const result = sampledExcursion({
    ...base,
    marks: [
      { timestamp: base.entryAt, bid: 1, admissible: true },
      { timestamp: base.exitAt, bid: 200, admissible: true },
    ],
  });
  expect(result.status).toBe("UNAVAILABLE");
  expect(result.reasonCodes).toContain("NO_INTERIOR_SAMPLES");
});

it("refuses unsupported or unverified exposure", () => {
  expect(
    sampledExcursion({
      ...base,
      lotCount: 2,
      marks: [],
    }).reasonCodes,
  ).toContain("MULTI_LOT_UNSUPPORTED");
  expect(
    sampledExcursion({
      ...base,
      coverageVerified: false,
      marks: [],
    }).reasonCodes,
  ).toContain("COVERAGE_UNVERIFIED");
});

it("refuses a completeness claim when replay excluded quotes for the instrument", () => {
  const result = sampledExcursion({
    ...base,
    exclusionsPresent: true,
    marks: [
      { timestamp: "2026-09-01T14:01:00Z", bid: 99, admissible: true },
      { timestamp: "2026-09-01T14:02:00Z", bid: 103, admissible: true },
    ],
  });
  expect(result.status).toBe("UNAVAILABLE");
  expect(result.reasonCodes).toContain("INPUT_EXCLUSIONS_PRESENT");
  expect(result.samples).toBe(0);
});

it("refuses invalid intervals and conflicting same-time marks", () => {
  expect(
    sampledExcursion({
      ...base,
      entryAt: base.exitAt,
      marks: [],
    }).reasonCodes,
  ).toContain("INVALID_INTERVAL");
  expect(
    sampledExcursion({
      ...base,
      marks: [
        { timestamp: "2026-09-01T14:01:00Z", bid: 99, admissible: true },
        { timestamp: "2026-09-01T14:01:00Z", bid: 101, admissible: true },
      ],
    }).reasonCodes,
  ).toContain("CONFLICTING_SAME_TIME_MARKS");
});
