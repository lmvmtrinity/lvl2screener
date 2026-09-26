import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  boundedRuleSearchSpaceSchema,
  type FrozenStudyPlan,
} from "@tsx-scanner/contracts";
import { migrate } from "../src/database/migrate.js";
import { verifyStudyProfiles } from "../src/backtests/study-profile-scope.js";
import { enumerateBoundedRuleCandidates } from "../src/backtests/bounded-rule-candidates.js";
import { isolatedDatabaseUrl } from "./isolated-database.js";
import { studyPlan } from "./study-fixture.js";

const databaseUrl = isolatedDatabaseUrl("AUDIT_TEST_DATABASE_URL");

describe.skipIf(!databaseUrl)(
  "numeric study profile admission PostgreSQL acceptance",
  () => {
    let pool: Pool;
    let plan: FrozenStudyPlan;
    const profileId = randomUUID();

    beforeAll(async () => {
      pool = new Pool({ connectionString: databaseUrl, max: 2 });
      await migrate(pool);

      const strategy = await pool.query<{ id: string }>(
        "SELECT id FROM strategy_definition WHERE strategy_key='ORB_RETEST' AND version='1.0.0'",
      );
      if (!strategy.rows[0]) throw new Error("STUDY_PROFILE_FIXTURE_MISSING");
      await pool.query(
        `INSERT INTO scanner_profile(id,name,market_id,strategy_definition_id,enabled)
         VALUES($1,'Numeric study acceptance fixture','CA_TSX',$2,true)`,
        [profileId, strategy.rows[0].id],
      );

      plan = studyPlan();
      const space = boundedRuleSearchSpaceSchema.parse({
        version: "bounded-rule-search-space-v1",
        strategy: "ORB_RETEST",
        marketId: "CA_TSX",
        baselineParameters: plan.inputs.TRAIN.baseline.parameters,
        dimensions: [{ key: "scoreCutoff", values: [10] }],
        maxCandidates: 1,
      });
      const candidate = enumerateBoundedRuleCandidates(space)[0]!;
      plan.variant = "NUMERIC_PARAMETER";
      plan.inputs.TRAIN.baseline.parameters.scoreCutoff = 0;
      for (const stage of Object.values(plan.inputs)) {
        stage.baseline.parameters.scoreCutoff = 0;
        stage.challenger.parameters = candidate.parameters;
      }

      await pool.query(
        `INSERT INTO scanner_profile_config(id,profile_id,market_id,config_version,parameters)
         VALUES($1,$3,'CA_TSX',$6,$4::jsonb),
               ($2,$3,'CA_TSX',$7,$5::jsonb)`,
        [
          plan.baselineProfileConfigId,
          plan.challengerProfileConfigId,
          profileId,
          JSON.stringify(plan.inputs.TRAIN.baseline.parameters),
          JSON.stringify(candidate.parameters),
          `numeric-study-baseline-${plan.baselineProfileConfigId}`,
          `numeric-study-candidate-${plan.challengerProfileConfigId}`,
        ],
      );
      await pool.query(
        "UPDATE scanner_profile SET current_config_id=$2 WHERE id=$1",
        [profileId, plan.baselineProfileConfigId],
      );
      plan.boundedRuleCandidate = {
        ...candidate,
        approvalStatus: "APPROVED",
      };
    });

    afterAll(async () => {
      await pool?.end();
    });

    it("accepts an exact inactive config, then rejects it when active or changed", async () => {
      await expect(verifyStudyProfiles(pool, plan)).resolves.toBeUndefined();

      await pool.query(
        "UPDATE scanner_profile SET current_config_id=$2 WHERE id=$1",
        [profileId, plan.challengerProfileConfigId],
      );
      await expect(verifyStudyProfiles(pool, plan)).rejects.toThrow(
        "STUDY_NUMERIC_CHALLENGER_CONFIG_ACTIVE",
      );

      await pool.query(
        "UPDATE scanner_profile SET current_config_id=$2 WHERE id=$1",
        [profileId, plan.baselineProfileConfigId],
      );
      await pool.query(
        `UPDATE scanner_profile_config SET parameters=jsonb_set(parameters,'{scoreCutoff}','20'::jsonb)
         WHERE id=$1`,
        [plan.challengerProfileConfigId],
      );
      await expect(verifyStudyProfiles(pool, plan)).rejects.toThrow(
        "STUDY_VARIANT_MISMATCH",
      );
    });
  },
);
