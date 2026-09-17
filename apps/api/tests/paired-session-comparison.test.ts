import { expect, it } from "vitest";
import { comparePairedSessions } from "../src/backtests/paired-session-comparison.js";
import type {
  SessionComparisonConfig,
  SessionPair,
} from "@tsx-scanner/contracts";

const sessions = Array.from(
  { length: 20 },
  (_, index) => `2026-09-${String(index + 1).padStart(2, "0")}`,
);

const config: SessionComparisonConfig = {
  marketId: "CA_TSX",
  unit: "R",
  expectedSessions: sessions,
  minimumSessions: 20,
  blockLength: 2,
  bootstrapSamples: 1_000,
  seed: 7,
};

const rows: SessionPair[] = sessions.map((sessionDate) => ({
  sessionDate,
  baseline: 1,
  challenger: 1,
  coverage: "VERIFIED",
}));

it("keeps true zero sessions and gives identical series zero difference", () => {
  const input = rows.map((value, index) =>
    index === 0 ? { ...value, baseline: 0, challenger: 0 } : value,
  );
  const result = comparePairedSessions(input, config);
  expect(result.status).toBe("AVAILABLE");
  expect([result.estimate, result.lower, result.upper]).toEqual([0, 0, 0]);
  expect(result.observedSessions).toBe(20);
});

it("refuses a missing session rather than shortening both arrays", () => {
  expect(comparePairedSessions(rows.slice(1), config).status).toBe(
    "UNVERIFIED",
  );
});

it("uses date identity rather than input order", () => {
  expect(comparePairedSessions([...rows].reverse(), config)).toEqual(
    comparePairedSessions(rows, config),
  );
});

it("does not interpret too few sessions as a narrow successful interval", () => {
  expect(
    comparePairedSessions(rows, { ...config, minimumSessions: 21 }).status,
  ).toBe("INSUFFICIENT");
});

it("returns a deterministic interval for a clustered paired difference", () => {
  const input = rows.map((row, index) => ({
    ...row,
    challenger: row.baseline! + (index % 4 < 2 ? 0.25 : -0.1),
  }));
  const first = comparePairedSessions(input, config);
  const second = comparePairedSessions([...input].reverse(), config);
  expect(first).toEqual(second);
  expect(first.estimate).toBeCloseTo(0.075, 12);
  expect(first.method).toEqual({
    kind: "CIRCULAR_MOVING_BLOCK_BOOTSTRAP",
    blockLength: 2,
    bootstrapSamples: 1_000,
    seed: 7,
  });
});

it("rejects duplicate, extra, unverified, null, and nonfinite rows", () => {
  expect(() => comparePairedSessions([rows[0]!, rows[0]!], config)).toThrow(
    "DUPLICATE_SESSION",
  );
  expect(() =>
    comparePairedSessions(
      [...rows, { ...rows[0]!, sessionDate: "2026-10-01" }],
      config,
    ),
  ).toThrow("UNEXPECTED_SESSION");
  expect(
    comparePairedSessions(
      rows.map((row) => ({ ...row, coverage: "MISSING" as const })),
      config,
    ).status,
  ).toBe("UNVERIFIED");
  expect(
    comparePairedSessions(
      rows.map((row, index) =>
        index === 0 ? { ...row, baseline: null } : row,
      ),
      config,
    ).status,
  ).toBe("UNVERIFIED");
  expect(() =>
    comparePairedSessions(
      rows.map((row, index) =>
        index === 0 ? { ...row, challenger: Number.NaN } : row,
      ),
      config,
    ),
  ).toThrow();
});

it("rejects invalid block, sample, seed, and unit inputs", () => {
  expect(() =>
    comparePairedSessions(rows, { ...config, blockLength: 0 }),
  ).toThrow();
  expect(() =>
    comparePairedSessions(rows, { ...config, bootstrapSamples: 999 }),
  ).toThrow();
  expect(() => comparePairedSessions(rows, { ...config, seed: -1 })).toThrow();
  expect(() =>
    comparePairedSessions(rows, {
      ...config,
      marketId: "US_EQUITIES",
      unit: "CAD",
    }),
  ).toThrow("UNIT_SCOPE_MISMATCH");
});
