import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  discoveryModeChangeSchema,
  discoveryModeStateSchema,
  marketIdSchema,
  type DiscoveryMode,
  type DiscoveryModeState,
  type MarketId,
} from "@tsx-scanner/contracts";

export interface DiscoveryLeaseKey {
  marketId: MarketId;
  tradingDate: string;
  policyVersion: string;
  completedBarEnd: string;
  idempotencyKey: string;
}

export interface DiscoveryLease extends DiscoveryLeaseKey {
  ownerToken: string;
  fencingGeneration: number;
  runId: string | null;
  leaseExpiresAt: string;
}

export interface DiscoveryModeChange {
  marketId: MarketId;
  mode: DiscoveryMode;
  expectedRevision: number;
  reason: string;
  actor: string;
}

export class DiscoveryControlConflictError extends Error {
  readonly code = "DISCOVERY_CONTROL_CONFLICT" as const;
  constructor(message: string) {
    super(message);
    this.name = "DiscoveryControlConflictError";
  }
}

export interface DiscoveryControlStore {
  getMode(marketId: MarketId): Promise<DiscoveryModeState>;
  changeMode(input: DiscoveryModeChange): Promise<DiscoveryModeState>;
  claim(
    key: DiscoveryLeaseKey,
    ownerToken: string,
    leaseMs: number,
  ): Promise<DiscoveryLease | null>;
  reclaimExpired?(
    marketId: MarketId,
    tradingDate: string,
    ownerToken: string,
    leaseMs: number,
  ): Promise<DiscoveryLease | null>;
  bindRun(lease: DiscoveryLease, runId: string): Promise<DiscoveryLease>;
  renew(lease: DiscoveryLease, leaseMs: number): Promise<DiscoveryLease | null>;
  release(lease: DiscoveryLease): Promise<boolean>;
}

interface ModeRow {
  market_id: MarketId;
  mode: DiscoveryMode;
  revision: string | number;
  updated_at: Date;
  actor: string;
  reason: string;
}

interface LeaseRow {
  market_id: MarketId;
  trading_date: string;
  policy_version: string;
  completed_bar_end: Date;
  idempotency_key: string;
  owner_token: string;
  fencing_generation: string | number;
  run_id: string | null;
  lease_expires_at: Date;
  status?: "ACTIVE" | "RELEASED" | "EXPIRED";
  is_live?: boolean;
}

function modeFromRow(row: ModeRow): DiscoveryModeState {
  return discoveryModeStateSchema.parse({
    marketId: row.market_id,
    mode: row.mode,
    revision: Number(row.revision),
    updatedAt: row.updated_at.toISOString(),
    actor: row.actor,
    reason: row.reason,
  });
}

function leaseFromRow(row: LeaseRow): DiscoveryLease {
  return {
    marketId: row.market_id,
    tradingDate: row.trading_date,
    policyVersion: row.policy_version,
    completedBarEnd: row.completed_bar_end.toISOString(),
    idempotencyKey: row.idempotency_key,
    ownerToken: row.owner_token,
    fencingGeneration: Number(row.fencing_generation),
    runId: row.run_id,
    leaseExpiresAt: row.lease_expires_at.toISOString(),
  };
}

export class PostgresDiscoveryControlStore implements DiscoveryControlStore {
  constructor(private readonly pool: Pool) {}

  private async transaction<T>(
    action: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await action(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getMode(marketId: MarketId): Promise<DiscoveryModeState> {
    marketIdSchema.parse(marketId);
    const result = await this.pool.query<ModeRow>(
      "SELECT market_id,mode,revision,updated_at,actor,reason FROM discovery_mode WHERE market_id=$1",
      [marketId],
    );
    const row = result.rows[0];
    if (!row) throw new Error(`Discovery mode is not seeded for ${marketId}`);
    return modeFromRow(row);
  }

  async changeMode(input: DiscoveryModeChange): Promise<DiscoveryModeState> {
    const parsed = discoveryModeChangeSchema.parse({
      marketId: input.marketId,
      mode: input.mode,
      expectedRevision: input.expectedRevision,
      reason: input.reason,
    });
    const actor = input.actor.trim();
    if (!actor || actor.length > 200)
      throw new Error("Discovery actor invalid");
    return this.transaction(async (db) => {
      const current = (
        await db.query<ModeRow>(
          "SELECT market_id,mode,revision,updated_at,actor,reason FROM discovery_mode WHERE market_id=$1 FOR UPDATE",
          [parsed.marketId],
        )
      ).rows[0];
      if (!current)
        throw new Error(`Discovery mode is not seeded for ${parsed.marketId}`);
      if (Number(current.revision) !== parsed.expectedRevision)
        throw new DiscoveryControlConflictError(
          `Discovery mode revision ${current.revision} is stale`,
        );
      const updated = (
        await db.query<ModeRow>(
          `UPDATE discovery_mode SET mode=$2,revision=revision+1,updated_at=clock_timestamp(),actor=$3,reason=$4
           WHERE market_id=$1 AND revision=$5
           RETURNING market_id,mode,revision,updated_at,actor,reason`,
          [
            parsed.marketId,
            parsed.mode,
            actor,
            parsed.reason,
            parsed.expectedRevision,
          ],
        )
      ).rows[0];
      if (!updated)
        throw new DiscoveryControlConflictError(
          "Discovery mode changed concurrently",
        );
      await db.query(
        `INSERT INTO discovery_mode_audit(
          market_id,previous_mode,mode,previous_revision,revision,actor,reason
        ) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [
          parsed.marketId,
          current.mode,
          parsed.mode,
          current.revision,
          updated.revision,
          actor,
          parsed.reason,
        ],
      );
      return modeFromRow(updated);
    });
  }

  async claim(
    key: DiscoveryLeaseKey,
    ownerToken: string,
    leaseMs: number,
  ): Promise<DiscoveryLease | null> {
    marketIdSchema.parse(key.marketId);
    if (!ownerToken || ownerToken.length > 200)
      throw new Error("Discovery owner token invalid");
    if (!Number.isInteger(leaseMs) || leaseMs < 120_000)
      throw new Error("Discovery lease must be at least 120 seconds");
    return this.transaction(async (db) => {
      const existing = (
        await db.query<LeaseRow>(
          `SELECT market_id,trading_date::text AS trading_date,policy_version,completed_bar_end,
             idempotency_key,owner_token,fencing_generation,run_id,lease_expires_at,
             status,lease_expires_at > clock_timestamp() AS is_live
           FROM discovery_schedule_lease
           WHERE market_id=$1 AND trading_date=$2 AND policy_version=$3
             AND completed_bar_end=$4 AND idempotency_key=$5
           FOR UPDATE`,
          [
            key.marketId,
            key.tradingDate,
            key.policyVersion,
            key.completedBarEnd,
            key.idempotencyKey,
          ],
        )
      ).rows[0];
      if (existing?.status === "RELEASED") return null;
      if (existing?.is_live) {
        if (existing.owner_token === ownerToken) return leaseFromRow(existing);
        return null;
      }
      if (existing?.run_id) {
        // A run may be completed while its lease still exists. Its durable
        // status is checked below, so a completed identity is never replayed.
        const run = await db.query<{ status: string }>(
          "SELECT status FROM discovery_run WHERE id=$1",
          [existing.run_id],
        );
        if (run.rows[0]?.status && run.rows[0].status !== "RUNNING")
          return null;
      }
      const row = (
        await db.query<LeaseRow>(
          `INSERT INTO discovery_schedule_lease(
            market_id,trading_date,policy_version,completed_bar_end,idempotency_key,
            owner_token,fencing_generation,lease_expires_at,status
          ) VALUES($1,$2,$3,$4,$5,$6,1,clock_timestamp()+($7 * interval '1 millisecond'),'ACTIVE')
          ON CONFLICT(market_id,trading_date,policy_version,completed_bar_end,idempotency_key)
          DO UPDATE SET owner_token=EXCLUDED.owner_token,
            fencing_generation=discovery_schedule_lease.fencing_generation+1,
            lease_expires_at=EXCLUDED.lease_expires_at,status='ACTIVE',renewed_at=clock_timestamp()
          WHERE discovery_schedule_lease.status <> 'RELEASED'
            AND discovery_schedule_lease.lease_expires_at <= clock_timestamp()
          RETURNING market_id,trading_date::text AS trading_date,policy_version,completed_bar_end,
            idempotency_key,owner_token,fencing_generation,run_id,lease_expires_at`,
          [
            key.marketId,
            key.tradingDate,
            key.policyVersion,
            key.completedBarEnd,
            key.idempotencyKey,
            ownerToken,
            leaseMs,
          ],
        )
      ).rows[0];
      return row ? leaseFromRow(row) : null;
    });
  }

  async reclaimExpired(
    marketId: MarketId,
    tradingDate: string,
    ownerToken: string,
    leaseMs: number,
  ): Promise<DiscoveryLease | null> {
    marketIdSchema.parse(marketId);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(tradingDate))
      throw new Error("Discovery trading date invalid");
    if (!ownerToken || ownerToken.length > 200)
      throw new Error("Discovery owner token invalid");
    if (!Number.isInteger(leaseMs) || leaseMs < 120_000)
      throw new Error("Discovery lease must be at least 120 seconds");
    return this.transaction(async (db) => {
      for (;;) {
        const existing = (
          await db.query<LeaseRow & { run_status: string | null }>(
            `SELECT l.market_id,l.trading_date::text AS trading_date,l.policy_version,
               l.completed_bar_end,l.idempotency_key,l.owner_token,l.fencing_generation,
               l.run_id,l.lease_expires_at,l.status,r.status AS run_status
             FROM discovery_schedule_lease l
             LEFT JOIN discovery_run r ON r.id=l.run_id
             WHERE l.market_id=$1 AND l.trading_date=$2 AND l.status='ACTIVE'
               AND l.lease_expires_at <= clock_timestamp()
               AND (l.run_id IS NULL OR r.status='RUNNING')
             ORDER BY l.lease_expires_at,l.created_at,l.idempotency_key
             LIMIT 1 FOR UPDATE OF l SKIP LOCKED`,
            [marketId, tradingDate],
          )
        ).rows[0];
        if (!existing) return null;

        // A crash can occur after begin() commits but before bindRun(). Recover
        // that run by its immutable schedule identity. If no running run exists,
        // terminate the lease instead of allowing a later cycle to mint a new
        // run for the same abandoned work.
        let runId = existing.run_id;
        if (!runId) {
          runId =
            (
              await db.query<{ id: string }>(
                `SELECT id FROM discovery_run
               WHERE market_id=$1 AND trading_date=$2 AND idempotency_key=$3
                 AND status='RUNNING'`,
                [marketId, tradingDate, existing.idempotency_key],
              )
            ).rows[0]?.id ?? null;
          if (!runId) {
            await db.query(
              `UPDATE discovery_schedule_lease SET status='EXPIRED',
                 lease_expires_at=clock_timestamp(),renewed_at=clock_timestamp()
               WHERE market_id=$1 AND trading_date=$2 AND policy_version=$3
                 AND completed_bar_end=$4 AND idempotency_key=$5
                 AND status='ACTIVE'`,
              [
                marketId,
                tradingDate,
                existing.policy_version,
                existing.completed_bar_end,
                existing.idempotency_key,
              ],
            );
            continue;
          }
        }
        const row = (
          await db.query<LeaseRow>(
            `UPDATE discovery_schedule_lease SET owner_token=$6,
               fencing_generation=fencing_generation+1,
               lease_expires_at=clock_timestamp()+($7 * interval '1 millisecond'),
               run_id=COALESCE(run_id,$8),status='ACTIVE',renewed_at=clock_timestamp()
             WHERE market_id=$1 AND trading_date=$2 AND policy_version=$3
               AND completed_bar_end=$4 AND idempotency_key=$5
               AND status='ACTIVE' AND lease_expires_at <= clock_timestamp()
             RETURNING market_id,trading_date::text AS trading_date,policy_version,
               completed_bar_end,idempotency_key,owner_token,fencing_generation,
               run_id,lease_expires_at`,
            [
              marketId,
              tradingDate,
              existing.policy_version,
              existing.completed_bar_end,
              existing.idempotency_key,
              ownerToken,
              leaseMs,
              runId,
            ],
          )
        ).rows[0];
        return row ? leaseFromRow(row) : null;
      }
    });
  }

  async bindRun(lease: DiscoveryLease, runId: string): Promise<DiscoveryLease> {
    const row = (
      await this.pool.query<LeaseRow>(
        `UPDATE discovery_schedule_lease SET run_id=$7,renewed_at=clock_timestamp()
         WHERE market_id=$1 AND trading_date=$2 AND policy_version=$3
           AND completed_bar_end=$4 AND idempotency_key=$5
           AND owner_token=$6 AND fencing_generation=$8 AND status='ACTIVE'
           AND lease_expires_at > clock_timestamp() AND (run_id IS NULL OR run_id=$7)
         RETURNING market_id,trading_date::text AS trading_date,policy_version,completed_bar_end,
           idempotency_key,owner_token,fencing_generation,run_id,lease_expires_at`,
        [
          lease.marketId,
          lease.tradingDate,
          lease.policyVersion,
          lease.completedBarEnd,
          lease.idempotencyKey,
          lease.ownerToken,
          runId,
          lease.fencingGeneration,
        ],
      )
    ).rows[0];
    if (!row)
      throw new DiscoveryControlConflictError("Discovery lease is stale");
    return leaseFromRow(row);
  }

  async renew(
    lease: DiscoveryLease,
    leaseMs: number,
  ): Promise<DiscoveryLease | null> {
    if (!Number.isInteger(leaseMs) || leaseMs < 120_000)
      throw new Error("Discovery lease must be at least 120 seconds");
    const row = (
      await this.pool.query<LeaseRow>(
        `UPDATE discovery_schedule_lease SET lease_expires_at=clock_timestamp()+($7 * interval '1 millisecond'),renewed_at=clock_timestamp()
         WHERE market_id=$1 AND trading_date=$2 AND policy_version=$3
           AND completed_bar_end=$4 AND idempotency_key=$5 AND owner_token=$6
           AND fencing_generation=$8 AND status='ACTIVE' AND lease_expires_at > clock_timestamp()
         RETURNING market_id,trading_date::text AS trading_date,policy_version,completed_bar_end,
           idempotency_key,owner_token,fencing_generation,run_id,lease_expires_at`,
        [
          lease.marketId,
          lease.tradingDate,
          lease.policyVersion,
          lease.completedBarEnd,
          lease.idempotencyKey,
          lease.ownerToken,
          leaseMs,
          lease.fencingGeneration,
        ],
      )
    ).rows[0];
    return row ? leaseFromRow(row) : null;
  }

  async release(lease: DiscoveryLease): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE discovery_schedule_lease SET status='RELEASED',lease_expires_at=clock_timestamp(),renewed_at=clock_timestamp()
       WHERE market_id=$1 AND trading_date=$2 AND policy_version=$3
         AND completed_bar_end=$4 AND idempotency_key=$5 AND owner_token=$6
         AND fencing_generation=$7 AND status='ACTIVE'`,
      [
        lease.marketId,
        lease.tradingDate,
        lease.policyVersion,
        lease.completedBarEnd,
        lease.idempotencyKey,
        lease.ownerToken,
        lease.fencingGeneration,
      ],
    );
    return result.rowCount === 1;
  }

  static newOwnerToken(): string {
    return randomUUID();
  }
}
