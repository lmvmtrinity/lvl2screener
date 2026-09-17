import {
  frozenStudyPlanSchema,
  strategyStudyReportSchema,
  studySelectionSchema,
  studyStageResultSchema,
  type FrozenStudyPlan,
  type MarketId,
  type StudySelection,
  type StudyStage,
  type StudyStageResult,
  type StrategyStudyReport,
} from "@tsx-scanner/contracts";
import type { Pool, PoolClient } from "pg";
import { canonicalJson, contentHash } from "./research-coverage.js";
import type {
  StudyExecutionFence,
  StudyStore,
} from "./strategy-study-service.js";

export type { StudyAuthorityRef } from "@tsx-scanner/contracts";
import type { StudyAuthorityRef } from "@tsx-scanner/contracts";
import { assertStudyAuthority } from "./study-session-authority.js";

type ReceiptKey =
  | "TRAIN_CLAIM"
  | "TRAIN_RESULT"
  | "VALIDATION_CLAIM"
  | "VALIDATION_RESULT"
  | "SELECTION"
  | "TEST_CLAIM"
  | "TEST_RESULT"
  | "REPORT"
  | "COVERAGE_REFUSAL";

export type StrategyStudyRecord = {
  id: string;
  marketId: MarketId;
  plan: FrozenStudyPlan;
  receiptKeys: ReceiptKey[];
  report: StrategyStudyReport | null;
  createdAt: string;
};

export interface StrategyStudyReadStore {
  get(id: string): Promise<StrategyStudyRecord | null>;
  list(marketId: MarketId, limit?: number): Promise<StrategyStudyRecord[]>;
}

export class PostgresStrategyStudyStore
  implements StudyStore, StrategyStudyReadStore
{
  constructor(
    private readonly pool: Pool,
    private readonly fence?: StudyExecutionFence,
    private readonly authority?: StudyAuthorityRef,
  ) {}

  async register(rawPlan: FrozenStudyPlan): Promise<void> {
    const plan = frozenStudyPlanSchema.parse(rawPlan);
    const specHash = contentHash(plan);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await assertFence(client, this.fence, this.authority);
      const existing = await client.query<{
        spec_hash: string;
        spec: unknown;
      }>("SELECT spec_hash,spec FROM strategy_study WHERE id=$1 FOR UPDATE", [
        plan.experimentId,
      ]);
      if (existing.rows[0]) {
        if (
          existing.rows[0].spec_hash !== specHash ||
          canonicalJson(existing.rows[0].spec) !== canonicalJson(plan)
        )
          throw new Error("STRATEGY_STUDY_SPEC_CONFLICT");
      } else {
        await client.query(
          `INSERT INTO strategy_study(id,market_id,spec_hash,spec)
           VALUES($1,$2,$3,$4::jsonb)`,
          [
            plan.experimentId,
            plan.comparison.marketId,
            specHash,
            JSON.stringify(plan),
          ],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async report(id: string): Promise<StrategyStudyReport | null> {
    const result = await this.pool.query<{ payload: unknown }>(
      `SELECT payload FROM strategy_study_receipt
        WHERE study_id=$1 AND receipt_key='REPORT'`,
      [id],
    );
    return result.rows[0]
      ? strategyStudyReportSchema.parse(result.rows[0].payload)
      : null;
  }

  async claim(id: string, stage: StudyStage): Promise<boolean> {
    return this.mutate(id, async (client) => {
      const key = `${stage}_CLAIM` as ReceiptKey;
      const existing = await receipt(client, id, key);
      if (existing) return false;
      if (!this.fence)
        throw new Error("STRATEGY_STUDY_MUTATION_REQUIRES_JOB_FENCE");
      await insertReceipt(client, id, key, {
        stage,
        jobId: this.fence.jobId,
        leaseOwner: this.fence.leaseOwner,
        attemptCount: this.fence.attemptCount,
      });
      return true;
    });
  }

  async result(
    id: string,
    stage: StudyStage,
  ): Promise<StudyStageResult | null> {
    const result = await this.pool.query<{ payload: unknown }>(
      `SELECT payload FROM strategy_study_receipt
        WHERE study_id=$1 AND receipt_key=$2`,
      [id, `${stage}_RESULT`],
    );
    return result.rows[0]
      ? studyStageResultSchema.parse(result.rows[0].payload)
      : null;
  }

  async saveResult(id: string, rawResult: StudyStageResult): Promise<void> {
    const result = studyStageResultSchema.parse(rawResult);
    await this.mutate(id, async (client) => {
      const key = `${result.stage}_RESULT` as ReceiptKey;
      const prior = await receipt(client, id, key);
      if (prior) {
        if (canonicalJson(prior) !== canonicalJson(result))
          throw new Error("STUDY_RECEIPT_CONFLICT");
        return undefined;
      }
      if (!(await receipt(client, id, `${result.stage}_CLAIM` as ReceiptKey)))
        throw new Error("STRATEGY_STUDY_CLAIM_REQUIRED");
      await insertReceipt(client, id, key, result);
      return undefined;
    });
  }

  async select(id: string, rawSelection: StudySelection): Promise<void> {
    const selection = studySelectionSchema.parse(rawSelection);
    await this.mutate(id, async (client) => {
      const prior = await receipt(client, id, "SELECTION");
      if (prior) {
        if (canonicalJson(prior) !== canonicalJson(selection))
          throw new Error("STUDY_RECEIPT_CONFLICT");
        return undefined;
      }
      if (
        !(await receipt(client, id, "TRAIN_RESULT")) ||
        !(await receipt(client, id, "VALIDATION_RESULT"))
      )
        throw new Error("DEVELOPMENT_RESULTS_REQUIRED");
      await insertReceipt(client, id, "SELECTION", selection);
      return undefined;
    });
  }

  async saveReport(rawReport: StrategyStudyReport): Promise<void> {
    const report = strategyStudyReportSchema.parse(rawReport);
    await this.mutate(
      report.experimentId,
      async (client) => {
        const prior = await receipt(client, report.experimentId, "REPORT");
        if (prior) {
          if (canonicalJson(prior) !== canonicalJson(report))
            throw new Error("STUDY_RECEIPT_CONFLICT");
          return undefined;
        }
        if (
          report.status === "INSUFFICIENT_EVIDENCE" &&
          report.results.length === 0
        )
          await insertReceipt(client, report.experimentId, "COVERAGE_REFUSAL", {
            reasonCodes: report.reasonCodes,
          });
        await insertReceipt(client, report.experimentId, "REPORT", report);
        return undefined;
      },
      report.status === "INTERRUPTED",
    );
  }

  async get(id: string): Promise<StrategyStudyRecord | null> {
    const result = await this.pool.query<{
      id: string;
      market_id: MarketId;
      spec: unknown;
      created_at: Date;
    }>(`SELECT id,market_id,spec,created_at FROM strategy_study WHERE id=$1`, [
      id,
    ]);
    const row = result.rows[0];
    return row ? this.mapRecord(row) : null;
  }

  async list(marketId: MarketId, limit = 100): Promise<StrategyStudyRecord[]> {
    const result = await this.pool.query<{
      id: string;
      market_id: MarketId;
      spec: unknown;
      created_at: Date;
    }>(
      `SELECT id,market_id,spec,created_at FROM strategy_study
        WHERE market_id=$1 ORDER BY created_at DESC LIMIT $2`,
      [marketId, limit],
    );
    return Promise.all(result.rows.map((row) => this.mapRecord(row)));
  }

  private async mapRecord(row: {
    id: string;
    market_id: MarketId;
    spec: unknown;
    created_at: Date;
  }): Promise<StrategyStudyRecord> {
    const receipts = await this.pool.query<{
      receipt_key: ReceiptKey;
      payload: unknown;
    }>(
      `SELECT receipt_key,payload FROM strategy_study_receipt
        WHERE study_id=$1 ORDER BY created_at`,
      [row.id],
    );
    const reportPayload = receipts.rows.find(
      (value) => value.receipt_key === "REPORT",
    )?.payload;
    return {
      id: row.id,
      marketId: row.market_id,
      plan: frozenStudyPlanSchema.parse(row.spec),
      receiptKeys: receipts.rows.map((value) => value.receipt_key),
      report: reportPayload
        ? strategyStudyReportSchema.parse(reportPayload)
        : null,
      createdAt: row.created_at.toISOString(),
    };
  }

  private async mutate<T>(
    id: string,
    operation: (client: PoolClient) => Promise<T>,
    allowEnded = false,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await assertFence(client, this.fence, this.authority, allowEnded);
      const study = await client.query(
        "SELECT id FROM strategy_study WHERE id=$1 FOR UPDATE",
        [id],
      );
      if (!study.rows[0]) throw new Error("STRATEGY_STUDY_NOT_FOUND");
      const value = await operation(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

async function assertFence(
  client: PoolClient,
  fence: StudyExecutionFence | undefined,
  authority: StudyAuthorityRef | undefined,
  allowEnded = false,
): Promise<void> {
  if (!fence) throw new Error("STRATEGY_STUDY_MUTATION_REQUIRES_JOB_FENCE");
  // Legacy read/test stores can inspect immutable receipts. Production handlers
  // require a grant before constructing a mutating store.
  if (authority) {
    await assertStudyAuthority(client, authority, fence, { allowEnded });
    return;
  }
  const result = await client.query<{ valid: boolean }>(
    `SELECT status='RUNNING' AND lease_owner=$2 AND attempt_count=$3 AND lease_expires_at>clock_timestamp() AS valid FROM research_job WHERE id=$1 FOR UPDATE`,
    [fence.jobId, fence.leaseOwner, fence.attemptCount],
  );
  if (!result.rows[0]?.valid) throw new Error("STUDY_LEASE_LOST");
}

async function receipt(
  client: PoolClient,
  studyId: string,
  key: ReceiptKey,
): Promise<unknown | null> {
  const result = await client.query<{ payload: unknown }>(
    "SELECT payload FROM strategy_study_receipt WHERE study_id=$1 AND receipt_key=$2",
    [studyId, key],
  );
  return result.rows[0]?.payload ?? null;
}

async function insertReceipt(
  client: PoolClient,
  studyId: string,
  key: ReceiptKey,
  payload: unknown,
): Promise<void> {
  const inserted = await client.query(
    `INSERT INTO strategy_study_receipt(study_id,receipt_key,payload)
     VALUES($1,$2,$3::jsonb) ON CONFLICT(study_id,receipt_key) DO NOTHING`,
    [studyId, key, JSON.stringify(payload)],
  );
  if (inserted.rowCount === 0) {
    const prior = await receipt(client, studyId, key);
    if (canonicalJson(prior) !== canonicalJson(payload))
      throw new Error("STUDY_RECEIPT_CONFLICT");
  }
}
