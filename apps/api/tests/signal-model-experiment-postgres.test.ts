import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/database/migrate.js";
import { isolatedDatabaseUrl } from "./isolated-database.js";

const databaseUrl = isolatedDatabaseUrl("PERSISTENCE_TEST_DATABASE_URL");

describe.skipIf(!databaseUrl)(
  "independent signal-model research ledger",
  () => {
    let pool: Pool;

    beforeAll(async () => {
      pool = new Pool({ connectionString: databaseUrl, max: 2 });
      await migrate(pool);
    });

    afterAll(async () => {
      await pool?.end();
    });

    it("has a standalone prepare-only authorization ledger and dedicated job type", async () => {
      const handoff = await pool.query<{
        capture_semantics: boolean;
        source_constraint: string;
      }>(
        `SELECT EXISTS (SELECT 1 FROM information_schema.columns
                         WHERE table_name='backtest_opportunity_capture'
                           AND column_name='signal_semantics_version') capture_semantics,
                pg_get_constraintdef(oid) source_constraint
           FROM pg_constraint WHERE conrelid='statistical_model'::regclass
             AND conname='statistical_model_source_check'`,
      );
      expect(handoff.rows[0]?.capture_semantics).toBe(true);
      expect(handoff.rows[0]?.source_constraint).toContain(
        "CAPTURED_BACKTEST_RESEARCH",
      );
      expect(handoff.rows[0]?.source_constraint).toContain("active = false");
      expect(handoff.rows[0]?.source_constraint).toContain(
        "eligible_for_activation = false",
      );

      const tables = await pool.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
       WHERE table_schema='public' AND table_name=ANY($1::text[])`,
        [
          [
            "signal_model_research_authorization",
            "signal_model_research_execution_grant",
            "signal_model_research_stage_claim",
            "signal_model_research_attempt",
            "signal_model_validation_selection",
            "signal_model_research_test_consumption",
          ],
        ],
      );
      expect(tables.rows.map((row) => row.table_name).sort()).toEqual([
        "signal_model_research_attempt",
        "signal_model_research_authorization",
        "signal_model_research_execution_grant",
        "signal_model_research_stage_claim",
        "signal_model_research_test_consumption",
        "signal_model_validation_selection",
      ]);
      const jobType = await pool.query<{ accepted: boolean }>(
        `SELECT pg_get_constraintdef(oid) LIKE '%SIGNAL_MODEL_RESEARCH%' AS accepted
       FROM pg_constraint WHERE conrelid='research_job'::regclass
         AND conname='research_job_job_type_check'`,
      );
      expect(jobType.rows[0]?.accepted).toBe(true);

      const defaults = await pool.query<{ column_default: string | null }>(
        `SELECT column_default FROM information_schema.columns
       WHERE table_name='signal_model_research_authorization' AND column_name='mode'`,
      );
      expect(defaults.rows[0]?.column_default).toContain("PREPARE_ONLY");
      const triggers = await pool.query<{ trigger_name: string }>(
        `SELECT trigger_name FROM information_schema.triggers
       WHERE event_object_table IN ('signal_model_research_execution_grant','signal_model_research_stage_claim','signal_model_research_attempt','signal_model_research_test_consumption')`,
      );
      expect(triggers.rows.map((row) => row.trigger_name)).toEqual(
        expect.arrayContaining([
          "signal_model_research_grant_validate",
          "signal_model_stage_claim_validate",
          "signal_model_attempt_validate",
          "signal_model_test_consumption_immutable",
        ]),
      );

      await expect(
        pool.query(
          `INSERT INTO signal_model_research_execution_grant(authorization_id,job_id,market_id,source_run_id,source_digest,plan_hash)
         VALUES(gen_random_uuid(),gen_random_uuid(),'CA_TSX',gen_random_uuid(),repeat('a',64),repeat('b',64))`,
        ),
      ).rejects.toThrow();
    });
  },
);
