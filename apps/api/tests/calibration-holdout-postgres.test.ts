import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCalibrationSchema } from "@tsx-scanner/contracts";
import { PostgresCalibrationStore } from "../src/calibration/calibration-repository.js";
import { migrate } from "../src/database/migrate.js";
import { isolatedDatabaseUrl } from "./isolated-database.js";

const databaseUrl = isolatedDatabaseUrl("AUDIT_TEST_DATABASE_URL");
const input = createCalibrationSchema.parse({
  name: "Holdout acceptance",
  startDate: "2026-01-01",
  endDate: "2026-06-30",
  strategy: "ORB_RETEST",
});
const availability = {
  source: "CAPTURED_QUOTES" as const,
  observedAt: "2026-07-01T00:00:00.000Z",
  tables: {
    quoteSnapshot: { earliest: null, latest: null },
    candle: { earliest: null, latest: null },
  },
  replay: { earliestDate: "2026-01-01", latestDate: "2026-06-30" },
};
const splitDates = { trainEnd: "2026-04-18", validationEnd: "2026-05-24" };

describe.skipIf(!databaseUrl)(
  "calibration holdout PostgreSQL acceptance",
  () => {
    let pool: Pool;
    let store: PostgresCalibrationStore;
    beforeAll(async () => {
      pool = new Pool({ connectionString: databaseUrl, max: 4 });
      await migrate(pool);
      store = new PostgresCalibrationStore(pool);
    });
    afterAll(async () => {
      await pool?.end();
    });

    it("deduplicates concurrent job attempts and preserves the frozen selection and completed result", async () => {
      const jobId = randomUUID();
      await pool.query(
        `INSERT INTO research_job(id,job_type,request_payload) VALUES($1,'CALIBRATION',$2)`,
        [jobId, input],
      );
      const runs = await Promise.all([
        store.create(input, 1, false, availability, jobId),
        store.create(input, 1, false, availability, jobId),
      ]);
      const id = runs[0]!.id;
      expect(runs[1]!.id).toBe(id);
      expect(
        (
          await Promise.all([store.markRunning(id), store.markRunning(id)])
        ).sort(),
      ).toEqual([false, true]);
      const selection = {
        version: "selected-holdout-v1" as const,
        configVersion: null,
        replayInputHash: "0".repeat(64),
      };
      const freezes = await Promise.allSettled([
        store.freezeSelection(id, selection, [], splitDates),
        store.freezeSelection(id, selection, [], splitDates),
      ]);
      expect(
        freezes.filter((value) => value.status === "fulfilled"),
      ).toHaveLength(1);
      expect((await store.get(id))?.holdoutSelection).toEqual(selection);
      await expect(
        pool.query(
          `UPDATE calibration_run SET holdout_selection=$2 WHERE id=$1`,
          [id, { ...selection, configVersion: "different" }],
        ),
      ).rejects.toThrow("selection is immutable");
      await expect(
        pool.query(
          `UPDATE calibration_run SET research_job_id=NULL WHERE id=$1`,
          [id],
        ),
      ).rejects.toThrow("identity is immutable");
      const completed = await store.complete(id, {
        trials: [],
        splitDates,
        recommendation: "No candidate qualified for TEST.",
        recommendedConfig: null,
        combinationsTested: 1,
      });
      await store.fail(id, "late failure after completion");
      expect(await store.getForJob(jobId, input)).toEqual(completed);
      expect(await store.create(input, 1, false, availability, jobId)).toEqual(
        completed,
      );
      expect(await store.markRunning(id)).toBe(false);
      await expect(
        store.getForJob(jobId, { ...input, marketId: "US_EQUITIES" }),
      ).rejects.toThrow("Conflicting");
      await expect(
        store.create(
          { ...input, name: "Changed" },
          1,
          false,
          availability,
          jobId,
        ),
      ).rejects.toThrow("Conflicting");
    });

    it("requires frozen selection for completion and keeps failed attempts non-restartable", async () => {
      const run = await store.create(input, 1, false, availability);
      await store.markRunning(run.id);
      await expect(
        store.complete(run.id, {
          trials: [],
          splitDates,
          recommendation: "",
          recommendedConfig: null,
          combinationsTested: 0,
        }),
      ).rejects.toThrow("frozen selection");
      await store.freezeSelection(
        run.id,
        {
          version: "selected-holdout-v1",
          configVersion: "selected-v1",
          replayInputHash: "1".repeat(64),
        },
        [],
        splitDates,
      );
      await store.fail(run.id, "uncertain holdout execution");
      expect(await store.markRunning(run.id)).toBe(false);
      expect((await store.get(run.id))?.holdoutSelection?.configVersion).toBe(
        "selected-v1",
      );
    });
  },
);
