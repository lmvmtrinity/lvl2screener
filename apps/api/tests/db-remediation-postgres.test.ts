import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/database/migrate.js";
import { isolatedDatabaseUrl } from "./isolated-database.js";
import { FundedDecisionEvidenceRepository } from "../src/paper-bot/funded-decision-evidence-repository.js";
import type { Pool as PoolType } from "pg";

const databaseUrl = isolatedDatabaseUrl("PERSISTENCE_TEST_DATABASE_URL");

const DROPPED_INDEXES = [
  "strategy_signal_latest_idx",
  "strategy_evaluation_profile_latest_idx",
  "strategy_evaluation_opportunities_idx",
];

describe.skipIf(!databaseUrl)("database performance remediation", () => {
  let pool: Pool;
  const runId = randomUUID();

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 4 });
    await migrate(pool);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  });

  it("drops the superseded lookup indexes and keeps the feature-snapshot RI index", async () => {
    const { rows } = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = ANY($1)`,
      [[...DROPPED_INDEXES, "strategy_evaluation_feature_snapshot_idx"]],
    );
    const present = new Set(rows.map((row) => row.indexname));
    for (const name of DROPPED_INDEXES) expect(present.has(name)).toBe(false);
    expect(present.has("strategy_evaluation_feature_snapshot_idx")).toBe(true);
  });

  it("creates a valid partial index for completed SIGNAL facts", async () => {
    const { rows } = await pool.query<{
      indexdef: string;
      indisvalid: boolean;
    }>(
      `SELECT pg_get_indexdef(i.indexrelid) AS indexdef, i.indisvalid
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relname = 'paper_funded_fact_signal_outcome_idx'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.indisvalid).toBe(true);
    expect(rows[0]!.indexdef).toContain("SIGNAL");
    expect(rows[0]!.indexdef).toContain("outcome IS NOT NULL");
  });

  it("plans the funded repair candidate query through the partial index", async () => {
    let captured = "";
    const recordingPool = {
      query: async (text: string) => {
        captured = text;
        return { rows: [] };
      },
      connect: async () => {
        throw new Error("the recording pool never opens transactions");
      },
    } as unknown as PoolType;
    const repository = new FundedDecisionEvidenceRepository(recordingPool);
    await repository.listMissingDecisionCandidates(runId, 25);
    expect(captured).toContain("candidate_sources");

    const explainSql = captured
      .replaceAll("$1", `'${runId}'`)
      .replace("$2", "25");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL enable_seqscan=off");
      const planned = await client.query<{ "QUERY PLAN": unknown[] }>(
        `EXPLAIN (FORMAT JSON) ${explainSql}`,
      );
      const plan = JSON.stringify(planned.rows[0]!["QUERY PLAN"]);
      expect(plan).toContain("paper_funded_fact_signal_outcome_idx");

      await client.query("DROP INDEX paper_funded_fact_signal_outcome_idx");
      const control = await client.query<{ "QUERY PLAN": unknown[] }>(
        `EXPLAIN (FORMAT JSON) ${explainSql}`,
      );
      expect(JSON.stringify(control.rows[0]!["QUERY PLAN"])).not.toContain(
        "paper_funded_fact_signal_outcome_idx",
      );
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });
});
