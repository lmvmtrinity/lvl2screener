import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { PostgresResearchEvidenceStore } from "../src/backtests/research-evidence-repository.js";
import { contentHash } from "../src/backtests/research-coverage.js";

describe("coverage session write queries", () => {
  it("uses insert returning and SQL hash comparison without reading payload back", async () => {
    const date = "2026-09-09";
    const payload = { session: { market: "CA_TSX" } };
    const hash = contentHash({ date, payload });
    const statements: string[] = [];
    let matches = true;
    const client = {
      query: async (sql: string) => {
        statements.push(sql);
        if (sql.includes("INSERT INTO research_coverage_session"))
          return { rowCount: 0, rows: [] };
        if (sql.includes("SELECT EXISTS"))
          return { rows: [{ same_hash: matches }] };
        return { rowCount: 1, rows: [] };
      },
      release: () => undefined,
    };
    const store = new PostgresResearchEvidenceStore({
      connect: async () => client,
    } as unknown as Pool);
    vi.spyOn(store, "getReport").mockResolvedValue({
      sessionPayloadHashes: { [date]: hash },
    } as never);
    await store.saveSessions("report", { [date]: payload });
    expect(
      statements.some((sql) => sql.includes("RETURNING payload_hash")),
    ).toBe(true);
    expect(statements.some((sql) => sql.includes("SELECT payload FROM"))).toBe(
      false,
    );
    expect(statements.some((sql) => sql.includes("payload_hash=$3"))).toBe(
      true,
    );
    matches = false;
    await expect(
      store.saveSessions("report", { [date]: payload }),
    ).rejects.toThrow("COVERAGE_SESSION_CONFLICT");
  });
});
