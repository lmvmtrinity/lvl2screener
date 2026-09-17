import { expect, it } from "vitest";
import { PostgresBacktestStore } from "../src/backtests/backtest-repository.js";
import { contentHash } from "../src/backtests/research-coverage.js";
it("derives input identity only from the immutable sessions and verification clock", async () => {
  const date = "2026-09-01",
    verifiedAt = "2026-09-02T12:00:00.000Z";
  const payload = {
    session: {
      market: "CA_TSX",
      instruments: [
        {
          instrumentId: "10000000-0000-4000-8000-000000000001",
          symbol: "OLD.TO",
          sector: null,
          role: "CANDIDATE",
          benchmarkKind: null,
          benchmarkSector: null,
        },
      ],
    },
    quotes: [{ timestamp: "2026-09-01T14:00:00.000Z" }],
    candles: [],
  };
  const hash = contentHash({ date, payload });
  const store = new PostgresBacktestStore({
    query: async (sql: string) => {
      expect(sql).toContain("research_coverage_session");
      expect(sql).not.toContain("FROM instrument");
      return {
        rows: [
          {
            session_date: date,
            payload,
            payload_hash: hash,
            expected_hash: hash,
            market_id: "CA_TSX",
            verified_at: verifiedAt,
          },
        ],
      };
    },
  } as never);
  const input = await store.loadVerifiedReplayInput("a".repeat(64));
  expect(input.candidateInstruments.map((i) => i.symbol)).toEqual(["OLD.TO"]);
  expect(input.resolvedAt).toBe(verifiedAt);
  expect(input.capturedHistoryAvailability.replay).toEqual({
    earliestDate: date,
    latestDate: date,
  });
});
