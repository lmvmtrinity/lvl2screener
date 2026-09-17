import { describe, expect, it } from "vitest";
import type { ResearchCoverageSource } from "../src/backtests/research-coverage-source.js";
import { ResearchCoverageService } from "../src/backtests/research-coverage-service.js";
import { coverageFixture } from "./research-coverage-fixtures.js";

describe("ResearchCoverageService", () => {
  it("retains UNKNOWN scope evidence when no historical members can be established", async () => {
    const service = new ResearchCoverageService(
      {
        readFrozenInputs: async () => ({
          expected: [],
          receipts: [],
          sessionPayloadHashes: { "2026-09-09": "e".repeat(64) },
        }),
      },
      () => new Date("2026-09-10T00:00:00Z"),
    );
    const report = await service.verify({
      marketId: "CA_TSX",
      manifestHash: "d".repeat(64),
      inputCutoff: "2026-09-10T00:00:00Z",
      sessionDates: ["2026-09-09"],
    });
    expect(report.status).toBe("UNKNOWN");
    expect(report.cells[0]?.reasons).toContain(
      "EXPECTED_MEMBERSHIP_UNAVAILABLE",
    );
  });

  it("requires each member and benchmark independently of trade count", async () => {
    const { cell, receipt } = coverageFixture();
    const source: ResearchCoverageSource = {
      readFrozenInputs: async () => ({
        expected: [
          cell,
          { ...cell, cellId: "second-member" },
          { ...cell, cellId: "benchmark", role: "MARKET_BENCHMARK" },
        ],
        receipts: [receipt, { ...receipt, cellId: "benchmark" }],
        sessionPayloadHashes: { [cell.sessionDate]: "e".repeat(64) },
      }),
    };
    const report = await new ResearchCoverageService(
      source,
      () => new Date("2026-09-10T00:00:00.000Z"),
    ).verify({
      marketId: "CA_TSX",
      manifestHash: "d".repeat(64),
      inputCutoff: "2026-09-09T21:00:00.000Z",
      sessionDates: [cell.sessionDate],
    });
    expect(report.status).toBe("INCOMPLETE");
    expect(
      report.cells.find((value) => value.cellId === "second-member")?.reasons,
    ).toContain("QUOTE_MISSING");
  });

  it("accepts a verified zero-opportunity session", async () => {
    const { cell, receipt } = coverageFixture();
    const source: ResearchCoverageSource = {
      readFrozenInputs: async () => ({
        expected: [cell],
        receipts: [receipt],
        sessionPayloadHashes: { [cell.sessionDate]: "e".repeat(64) },
      }),
    };
    const report = await new ResearchCoverageService(
      source,
      () => new Date("2026-09-10T00:00:00.000Z"),
    ).verify({
      marketId: "CA_TSX",
      manifestHash: "d".repeat(64),
      inputCutoff: "2026-09-09T21:00:00.000Z",
      sessionDates: [cell.sessionDate],
    });
    expect(report.status).toBe("VERIFIED");
    expect(report.cells[0]?.validQuotes).toBeGreaterThan(0);
  });

  it("rejects an empty or cross-market expected grid", async () => {
    const source: ResearchCoverageSource = {
      readFrozenInputs: async () => ({
        expected: [],
        receipts: [],
        sessionPayloadHashes: {},
      }),
    };
    const service = new ResearchCoverageService(source, () => new Date());
    await expect(
      service.verify({
        marketId: "CA_TSX",
        manifestHash: "d".repeat(64),
        inputCutoff: "2026-09-09T21:00:00.000Z",
        sessionDates: ["2026-09-09"],
      }),
    ).rejects.toThrow("COVERAGE_SCOPE_MISMATCH");
  });

  it("requires exactly the declared session payload hash keys", async () => {
    const { cell, receipt } = coverageFixture();
    const source: ResearchCoverageSource = {
      readFrozenInputs: async () => ({
        expected: [cell],
        receipts: [receipt],
        sessionPayloadHashes: {
          [cell.sessionDate]: "e".repeat(64),
          "2026-09-10": "f".repeat(64),
        },
      }),
    };
    await expect(
      new ResearchCoverageService(source, () => new Date()).verify({
        marketId: "CA_TSX",
        manifestHash: "d".repeat(64),
        inputCutoff: "2026-09-09T21:00:00.000Z",
        sessionDates: [cell.sessionDate],
      }),
    ).rejects.toThrow("SESSION_PAYLOAD_SCOPE_MISMATCH");
  });
});
