import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { PostgresBacktestStore } from "../src/backtests/backtest-repository.js";

const NOW = new Date("2026-09-18T14:00:00.000Z");

describe("captureInputFingerprint transaction", () => {
  it("runs the full-history aggregate in a bounded-work_mem transaction", async () => {
    const queries: string[] = [];
    const client = {
      query: async (text: string) => {
        queries.push(text);
        return { rows: [] };
      },
      release: () => undefined,
    };
    const pool = {
      query: async () => {
        throw new Error("the fingerprint aggregate must not bypass the client");
      },
      connect: async () => client,
    } as unknown as Pool;
    const store = new PostgresBacktestStore(pool);

    await store.captureInputFingerprint("CA_TSX", NOW);

    expect(queries[0]).toBe("BEGIN");
    expect(queries[1]).toContain("SET LOCAL work_mem");
    expect(queries[2]).toContain("SELECT u.session_date");
    expect(queries.at(-1)).toBe("COMMIT");
  });

  it("reuses one captured watermark for different membership digests in the same cycle", async () => {
    const queries: string[] = [];
    const client = {
      query: async (text: string) => {
        queries.push(text);
        return { rows: [] };
      },
      release: () => undefined,
    };
    const pool = { connect: async () => client } as unknown as Pool;
    const store = new PostgresBacktestStore(pool);
    const cycle = {};
    const first = await store.captureInputFingerprint(
      "CA_TSX",
      NOW,
      "first",
      cycle,
    );
    const second = await store.captureInputFingerprint(
      "CA_TSX",
      NOW,
      "second",
      cycle,
    );
    expect(first).not.toBe(second);
    expect(
      queries.filter((query) => query.includes("SELECT u.session_date")),
    ).toHaveLength(1);
  });

  it("rolls back and surfaces a failed aggregate", async () => {
    const queries: string[] = [];
    const client = {
      query: async (text: string) => {
        queries.push(text);
        if (text.includes("SELECT u.session_date"))
          throw new Error("fingerprint fixture failure");
        return { rows: [] };
      },
      release: () => undefined,
    };
    const pool = {
      query: async () => {
        throw new Error("the fingerprint aggregate must not bypass the client");
      },
      connect: async () => client,
    } as unknown as Pool;
    const store = new PostgresBacktestStore(pool);

    await expect(store.captureInputFingerprint("CA_TSX", NOW)).rejects.toThrow(
      "fingerprint fixture failure",
    );
    expect(queries).toContain("ROLLBACK");
    expect(queries).not.toContain("COMMIT");
  });
});
