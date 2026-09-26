import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { PostgresBacktestStore } from "../src/backtests/backtest-repository.js";
import { contentHash } from "../src/backtests/research-coverage.js";

describe("verified replay session cache", () => {
  it("reads payload once, checks database hash on every cache hit, and isolates callers", async () => {
    const date = "2026-09-09";
    const payload = { session: { market: "CA_TSX" }, quotes: [] };
    const hash = contentHash({ date, payload });
    let currentHash = hash;
    const query = vi.fn(async (sql: string) => ({
      rows: sql.includes("p.payload")
        ? [{ payload, payload_hash: currentHash, expected_hash: hash }]
        : [{ payload_hash: currentHash, expected_hash: hash }],
    }));
    const store = new PostgresBacktestStore({ query } as unknown as Pool);
    const first = await store.loadVerifiedReplaySession("report", date);
    (first.session as { market: string }).market = "US_EQUITIES";
    const second = await store.loadVerifiedReplaySession("report", date);
    expect((second.session as { market: string }).market).toBe("CA_TSX");
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1]![0]).not.toContain("p.payload");
    currentHash = "f".repeat(64);
    await expect(
      store.loadVerifiedReplaySession("report", date),
    ).rejects.toThrow("VERIFIED_REPLAY_SESSION_UNAVAILABLE");
    expect(query).toHaveBeenCalledTimes(3);
  });
});
