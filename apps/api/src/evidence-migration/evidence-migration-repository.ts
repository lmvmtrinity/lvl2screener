import type { Pool, PoolClient } from "pg";
import type { CalibrationTrial } from "@tsx-scanner/contracts";

export type EvidenceMigrationStatus =
  "PENDING" | "RUNNING" | "REPLACED" | "UNREPLAYABLE_LEGACY" | "FAILED";

export interface EvidenceMigrationItem {
  id: string;
  sourceId: string;
  report: Record<string, unknown>;
}

export interface EvidenceMigrationReport {
  execution: Array<{
    sourceId: string;
    replacementId: string | null;
    status: EvidenceMigrationStatus;
    reason: string | null;
  }>;
  calibrations: Array<{
    sourceId: string;
    replacementId: string | null;
    status: EvidenceMigrationStatus;
    reason: string | null;
  }>;
}

export class EvidenceMigrationRepository {
  constructor(private readonly pool: Pool) {}

  async pendingExecutions(): Promise<EvidenceMigrationItem[]> {
    const result = await this.pool.query<{
      id: string;
      source_backtest_run_id: string;
      report: Record<string, unknown>;
    }>(
      `SELECT id,source_backtest_run_id,report
       FROM execution_evidence_migration
       WHERE status IN ('PENDING','FAILED')
       ORDER BY created_at,id`,
    );
    return result.rows.map((row) => ({
      id: row.id,
      sourceId: row.source_backtest_run_id,
      report: row.report,
    }));
  }

  async pendingCalibrations(): Promise<EvidenceMigrationItem[]> {
    const result = await this.pool.query<{
      id: string;
      source_calibration_run_id: string;
      report: Record<string, unknown>;
    }>(
      `SELECT id,source_calibration_run_id,report
       FROM calibration_evidence_migration
       WHERE status IN ('PENDING','FAILED')
       ORDER BY created_at,id`,
    );
    return result.rows.map((row) => ({
      id: row.id,
      sourceId: row.source_calibration_run_id,
      report: row.report,
    }));
  }

  async startExecution(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE execution_evidence_migration
       SET status='RUNNING',reason=NULL,started_at=now(),completed_at=NULL
       WHERE id=$1`,
      [id],
    );
  }

  async startCalibration(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE calibration_evidence_migration
       SET status='RUNNING',reason=NULL,started_at=now(),completed_at=NULL
       WHERE id=$1`,
      [id],
    );
  }

  async legacyModelIds(sourceId: string): Promise<string[]> {
    const result = await this.pool.query<{ id: string }>(
      `SELECT m.id FROM statistical_model m
       JOIN execution_evidence_migration x
         ON x.source_backtest_run_id=m.backtest_run_id
       WHERE x.source_backtest_run_id=$1
         AND ((x.report->'activeStatisticalModelIds') ? m.id::text)
       ORDER BY m.created_at,m.id`,
      [sourceId],
    );
    return result.rows.map((row) => row.id);
  }

  async activatedRankingStudyIds(sourceId: string): Promise<string[]> {
    const result = await this.pool.query<{ id: string }>(
      `SELECT DISTINCT s.id FROM ranking_research_run s
       JOIN ranking_formula f ON f.activation_research_run_id=s.id
       JOIN execution_evidence_migration x
         ON x.source_backtest_run_id=s.backtest_run_id
       WHERE x.source_backtest_run_id=$1
         AND ((x.report->'activatedRankingFormulaVersions') ? f.version)
       ORDER BY s.id`,
      [sourceId],
    );
    return result.rows.map((row) => row.id);
  }

  async completeExecution(
    id: string,
    replacementId: string,
    report: Record<string, unknown>,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE execution_evidence_migration
       SET status='REPLACED',replacement_backtest_run_id=$2,reason=NULL,
           report=report || $3::jsonb,completed_at=now()
       WHERE id=$1`,
      [id, replacementId, JSON.stringify(report)],
    );
  }

  async failExecution(
    id: string,
    status: "UNREPLAYABLE_LEGACY" | "FAILED",
    reason: string,
  ): Promise<string[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const demoted = await demotedProfiles(client, id);
      await client.query(
        `UPDATE profile_config_evidence e
         SET revoked_at=COALESCE(e.revoked_at,now())
         FROM execution_evidence_migration x
         WHERE x.id=$1 AND e.backtest_run_id=x.source_backtest_run_id`,
        [id],
      );
      await client.query(
        `UPDATE execution_evidence_migration
         SET status=$2,reason=$3,report=report || jsonb_build_object('demotedProfiles',$4::jsonb),completed_at=now()
         WHERE id=$1`,
        [id, status, reason.slice(0, 5000), JSON.stringify(demoted)],
      );
      await client.query("COMMIT");
      return demoted;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async completeCalibration(
    id: string,
    replacementId: string,
    recommendedConfig: CalibrationTrial["parameters"] | null,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const relinked = recommendedConfig
        ? await client.query<{ id: string }>(
            `UPDATE scanner_profile_config pc
             SET source_calibration_run_id=$2
             FROM calibration_evidence_migration x
             WHERE x.id=$1 AND pc.source_calibration_run_id=x.source_calibration_run_id
               AND pc.parameters = ($3::jsonb - ARRAY['openingRangeMinutes','entryWindowEnd','stopMethod','rewardRiskRatio'])
             RETURNING pc.id`,
            [id, replacementId, JSON.stringify(recommendedConfig)],
          )
        : { rows: [] as { id: string }[] };
      const unlinked = await client.query<{ id: string }>(
        `UPDATE scanner_profile_config pc
         SET source_calibration_run_id=NULL
         FROM calibration_evidence_migration x
         WHERE x.id=$1 AND pc.source_calibration_run_id=x.source_calibration_run_id
         RETURNING pc.id`,
        [id],
      );
      await client.query(
        `UPDATE calibration_evidence_migration
         SET status='REPLACED',replacement_calibration_run_id=$2,reason=NULL,
             report=report || jsonb_build_object(
               'relinkedProfileConfigIds',$3::jsonb,
               'unlinkedProfileConfigIds',$4::jsonb
             ),completed_at=now()
         WHERE id=$1`,
        [
          id,
          replacementId,
          JSON.stringify(relinked.rows.map((row) => row.id)),
          JSON.stringify(unlinked.rows.map((row) => row.id)),
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async failCalibration(
    id: string,
    status: "UNREPLAYABLE_LEGACY" | "FAILED",
    reason: string,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE scanner_profile_config pc SET source_calibration_run_id=NULL
         FROM calibration_evidence_migration x
         WHERE x.id=$1 AND pc.source_calibration_run_id=x.source_calibration_run_id`,
        [id],
      );
      await client.query(
        `UPDATE calibration_evidence_migration
         SET status=$2,reason=$3,completed_at=now() WHERE id=$1`,
        [id, status, reason.slice(0, 5000)],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async report(): Promise<EvidenceMigrationReport> {
    const [execution, calibrations] = await Promise.all([
      this.pool.query<{
        sourceId: string;
        replacementId: string | null;
        status: EvidenceMigrationStatus;
        reason: string | null;
      }>(
        `SELECT source_backtest_run_id AS "sourceId",replacement_backtest_run_id AS "replacementId",status,reason
         FROM execution_evidence_migration ORDER BY created_at,id`,
      ),
      this.pool.query<{
        sourceId: string;
        replacementId: string | null;
        status: EvidenceMigrationStatus;
        reason: string | null;
      }>(
        `SELECT source_calibration_run_id AS "sourceId",replacement_calibration_run_id AS "replacementId",status,reason
         FROM calibration_evidence_migration ORDER BY created_at,id`,
      ),
    ]);
    return { execution: execution.rows, calibrations: calibrations.rows };
  }
}

async function demotedProfiles(
  client: PoolClient,
  migrationId: string,
): Promise<string[]> {
  const result = await client.query<{ name: string }>(
    `SELECT DISTINCT p.name
     FROM execution_evidence_migration x
     JOIN profile_config_evidence e ON e.backtest_run_id=x.source_backtest_run_id
     JOIN scanner_profile p ON p.current_config_id=e.profile_config_id
     WHERE x.id=$1 AND e.revoked_at IS NULL
     ORDER BY p.name`,
    [migrationId],
  );
  return result.rows.map((row) => row.name);
}
