import {
  evidenceWorkIdentitySchema,
  evidenceWorkReceiptSchema,
  type EvidenceWorkIdentity,
  type EvidenceWorkReceipt,
  type MarketId,
} from "@tsx-scanner/contracts";
import type { Pool, PoolClient } from "pg";
import { canonicalJson, contentHash } from "../backtests/research-coverage.js";

export type EvidenceAutomationWorkRecord = {
  workKey: string;
  identity: EvidenceWorkIdentity;
  jobId: string | null;
  receipt: EvidenceWorkReceipt | null;
};

export interface EvidenceAutomationRepository {
  record(
    identity: EvidenceWorkIdentity,
    receipt: EvidenceWorkReceipt,
  ): Promise<void>;
  list(
    marketId: EvidenceWorkIdentity["marketId"],
  ): Promise<EvidenceAutomationWorkRecord[]>;
  catchUp?(
    marketId: MarketId,
    limit?: number,
    budgetMs?: number,
  ): Promise<number>;
}

function receiptIdentity(receipt: EvidenceWorkReceipt): unknown {
  return {
    state: receipt.state,
    jobId: receipt.jobId,
    reasonCodes: [...receipt.reasonCodes].sort(),
  };
}

export function evidenceWorkKey(identity: EvidenceWorkIdentity): string {
  return contentHash(evidenceWorkIdentitySchema.parse(identity));
}

export function evidenceReceiptHash(receipt: EvidenceWorkReceipt): string {
  return contentHash(receiptIdentity(evidenceWorkReceiptSchema.parse(receipt)));
}

export class PostgresEvidenceAutomationRepository implements EvidenceAutomationRepository {
  constructor(private readonly pool: Pool) {}

  async record(
    identity: EvidenceWorkIdentity,
    receipt: EvidenceWorkReceipt,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.recordWithClient(client, identity, receipt);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async recordWithClient(
    client: PoolClient,
    identity: EvidenceWorkIdentity,
    receipt: EvidenceWorkReceipt,
  ): Promise<void> {
    const parsedIdentity = evidenceWorkIdentitySchema.parse(identity);
    const workKey = evidenceWorkKey(parsedIdentity);
    const parsedReceipt = evidenceWorkReceiptSchema.parse({
      ...receipt,
      workKey,
    });
    const receiptHash = evidenceReceiptHash(parsedReceipt);
    const existing = await client.query<{
      identity: unknown;
      job_id: string | null;
    }>(
      `SELECT identity, job_id FROM research_evidence_work
         WHERE work_key=$1 FOR UPDATE`,
      [workKey],
    );
    if (existing.rows[0]) {
      if (
        canonicalJson(
          evidenceWorkIdentitySchema.parse(existing.rows[0].identity),
        ) !== canonicalJson(parsedIdentity)
      )
        throw new Error("EVIDENCE_WORK_IDENTITY_CONFLICT");
      if (
        existing.rows[0].job_id &&
        parsedReceipt.jobId &&
        existing.rows[0].job_id !== parsedReceipt.jobId
      )
        throw new Error("EVIDENCE_WORK_JOB_CONFLICT");
      if (!existing.rows[0].job_id && parsedReceipt.jobId) {
        await client.query(
          `UPDATE research_evidence_work SET job_id=$2, updated_at=clock_timestamp()
             WHERE work_key=$1`,
          [workKey, parsedReceipt.jobId],
        );
      }
    } else {
      await client.query(
        `INSERT INTO research_evidence_work
             (work_key, kind, market_id, scope_hash, input_identity_hash,
              processor_version, job_id, identity)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
        [
          workKey,
          parsedIdentity.kind,
          parsedIdentity.marketId,
          parsedIdentity.scopeHash,
          parsedIdentity.inputIdentityHash,
          parsedIdentity.processorVersion,
          parsedReceipt.jobId,
          JSON.stringify(parsedIdentity),
        ],
      );
    }

    const inserted = await client.query(
      `INSERT INTO research_evidence_work_receipt
           (work_key, receipt_hash, receipt)
         VALUES ($1,$2,$3::jsonb)
         ON CONFLICT (work_key, receipt_hash) DO NOTHING`,
      [workKey, receiptHash, JSON.stringify(parsedReceipt)],
    );
    if (inserted.rowCount === 0) {
      const prior = await client.query<{ receipt: unknown }>(
        `SELECT receipt FROM research_evidence_work_receipt
           WHERE work_key=$1 AND receipt_hash=$2`,
        [workKey, receiptHash],
      );
      if (
        prior.rows[0] &&
        canonicalJson(
          receiptIdentity(
            evidenceWorkReceiptSchema.parse(prior.rows[0].receipt),
          ),
        ) !== canonicalJson(receiptIdentity(parsedReceipt))
      )
        throw new Error("EVIDENCE_RECEIPT_CONFLICT");
    }
  }

  async list(
    marketId: EvidenceWorkIdentity["marketId"],
  ): Promise<EvidenceAutomationWorkRecord[]> {
    const result = await this.pool.query<{
      work_key: string;
      identity: unknown;
      job_id: string | null;
      receipt: unknown;
    }>(
      `SELECT w.work_key, w.identity, w.job_id, r.receipt
         FROM research_evidence_work w
         LEFT JOIN LATERAL (
           SELECT receipt FROM research_evidence_work_receipt
            WHERE work_key=w.work_key ORDER BY recorded_at DESC LIMIT 1
         ) r ON TRUE
        WHERE w.market_id=$1 ORDER BY w.updated_at DESC`,
      [marketId],
    );
    return result.rows.map((row) => ({
      workKey: row.work_key,
      identity: evidenceWorkIdentitySchema.parse(row.identity),
      jobId: row.job_id,
      receipt: row.receipt
        ? evidenceWorkReceiptSchema.parse(row.receipt)
        : null,
    }));
  }

  async catchUp(
    marketId: MarketId,
    limit = 100,
    budgetMs = 1_000,
  ): Promise<number> {
    const client = await this.pool.connect();
    const deadline = Date.now() + budgetMs;
    let processed = 0;
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO research_evidence_source_watermark(market_id)
         VALUES($1) ON CONFLICT(market_id) DO NOTHING`,
        [marketId],
      );
      const cursor = await client.query<{
        last_completed_at: Date | null;
        last_source_id: string | null;
      }>(
        `SELECT last_completed_at,last_source_id
           FROM research_evidence_source_watermark
          WHERE market_id=$1 FOR UPDATE`,
        [marketId],
      );
      const current = cursor.rows[0]!;
      const sourceRows = await client.query<{
        id: string;
        completed_at: Date;
      }>(
        `SELECT id,completed_at
           FROM universe_refresh_run
          WHERE market_id=$1 AND status='COMPLETED' AND completed_at IS NOT NULL
            AND ($2::timestamptz IS NULL
              OR completed_at > $2::timestamptz
              OR (completed_at=$2::timestamptz AND id > $3::uuid))
          ORDER BY completed_at,id
          LIMIT $4`,
        [marketId, current.last_completed_at, current.last_source_id, limit],
      );
      for (const source of sourceRows.rows) {
        if (Date.now() >= deadline) break;
        const identity = evidenceWorkIdentitySchema.parse({
          kind: "COVERAGE",
          marketId,
          scopeHash: contentHash({ marketId, sourceId: source.id }),
          inputIdentityHash: contentHash({
            sourceId: source.id,
            completedAt: source.completed_at.toISOString(),
          }),
          processorVersion: "coverage-catch-up-v1",
        });
        const workKey = evidenceWorkKey(identity);
        const now = await client.query<{ now: Date }>(
          "SELECT clock_timestamp() AS now",
        );
        const receipt = evidenceWorkReceiptSchema.parse({
          workKey,
          identity,
          state: "WAITING",
          jobId: null,
          reasonCodes: [
            "SOURCE_REVISION_UNAVAILABLE",
            "RESEARCH_SCOPE_UNAVAILABLE",
          ],
          recordedAt: now.rows[0]!.now.toISOString(),
        });
        await insertWorkAndReceipt(
          client,
          identity,
          receipt,
          evidenceReceiptHash(receipt),
        );
        await client.query(
          `UPDATE research_evidence_source_watermark
              SET last_completed_at=$2,last_source_id=$3,updated_at=clock_timestamp()
            WHERE market_id=$1`,
          [marketId, source.completed_at, source.id],
        );
        processed++;
      }
      await client.query("COMMIT");
      return processed;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

async function insertWorkAndReceipt(
  client: PoolClient,
  identity: EvidenceWorkIdentity,
  receipt: EvidenceWorkReceipt,
  receiptHash: string,
): Promise<void> {
  const workKey = evidenceWorkKey(identity);
  const existing = await client.query<{ identity: unknown }>(
    `SELECT identity FROM research_evidence_work WHERE work_key=$1 FOR UPDATE`,
    [workKey],
  );
  if (existing.rows[0]) {
    if (
      canonicalJson(
        evidenceWorkIdentitySchema.parse(existing.rows[0].identity),
      ) !== canonicalJson(identity)
    )
      throw new Error("EVIDENCE_WORK_IDENTITY_CONFLICT");
  } else {
    await client.query(
      `INSERT INTO research_evidence_work
       (work_key,kind,market_id,scope_hash,input_identity_hash,processor_version,job_id,identity)
       VALUES($1,$2,$3,$4,$5,$6,NULL,$7::jsonb)`,
      [
        workKey,
        identity.kind,
        identity.marketId,
        identity.scopeHash,
        identity.inputIdentityHash,
        identity.processorVersion,
        JSON.stringify(identity),
      ],
    );
  }
  await client.query(
    `INSERT INTO research_evidence_work_receipt(work_key,receipt_hash,receipt)
     VALUES($1,$2,$3::jsonb) ON CONFLICT(work_key,receipt_hash) DO NOTHING`,
    [workKey, receiptHash, JSON.stringify(receipt)],
  );
}
