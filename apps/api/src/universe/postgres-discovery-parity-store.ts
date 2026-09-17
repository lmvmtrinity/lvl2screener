import type { Pool } from "pg";
import {
  discoveryParityAuditSchema,
  type DiscoveryParityAudit,
  type MarketId,
} from "@tsx-scanner/contracts";

export interface DiscoveryParityStore {
  save(audit: DiscoveryParityAudit): Promise<void>;
  loadLatest(marketId: MarketId): Promise<DiscoveryParityAudit | null>;
  listAudits(
    marketId: MarketId,
    limit?: number,
  ): Promise<DiscoveryParityAudit[]>;
  getAudit(id: string): Promise<DiscoveryParityAudit | null>;
  countAudits(marketId: MarketId): Promise<number>;
}

/**
 * Bounded retention for parity evidence. One audit can be stored per scheduled
 * discovery cycle, so an explicit cap keeps the immutable table from growing
 * without limit. The newest audits are always retained.
 */
export const PARITY_AUDIT_RETENTION_PER_MARKET = 500;

export class PostgresDiscoveryParityStore implements DiscoveryParityStore {
  constructor(private readonly pool: Pool) {}

  async save(audit: DiscoveryParityAudit): Promise<void> {
    const validated = discoveryParityAuditSchema.parse(audit);
    await this.pool.query(
      `INSERT INTO discovery_parity_audit (
        id,
        market_id,
        trading_date,
        run_id,
        audited_at,
        tradingview_count,
        questrade_pass_count,
        overlap_count,
        overlap_ratio,
        overlap_symbols,
        missed_movers,
        questrade_only,
        metric_differences,
        discrepancy_summary,
        created_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15
      ) ON CONFLICT (id) DO NOTHING`,
      [
        validated.id,
        validated.marketId,
        validated.tradingDate,
        validated.runId,
        validated.auditedAt,
        validated.tradingViewCount,
        validated.questradePassCount,
        validated.overlapCount,
        validated.overlapRatio,
        JSON.stringify(validated.overlapSymbols),
        JSON.stringify(validated.missedMovers),
        JSON.stringify(validated.questradeOnly),
        JSON.stringify(validated.metricDifferences),
        JSON.stringify(validated.discrepancySummary),
        validated.auditedAt,
      ],
    );
    await this.pool.query(
      `DELETE FROM discovery_parity_audit
      WHERE market_id = $1 AND id NOT IN (
        SELECT id FROM discovery_parity_audit
        WHERE market_id = $1
        ORDER BY audited_at DESC, id DESC
        LIMIT $2
      )`,
      [validated.marketId, PARITY_AUDIT_RETENTION_PER_MARKET],
    );
  }

  async loadLatest(marketId: MarketId): Promise<DiscoveryParityAudit | null> {
    const result = await this.pool.query(
      `SELECT
        id,
        market_id as "marketId",
        trading_date::text as "tradingDate",
        run_id as "runId",
        audited_at as "auditedAt",
        tradingview_count as "tradingViewCount",
        questrade_pass_count as "questradePassCount",
        overlap_count as "overlapCount",
        overlap_ratio as "overlapRatio",
        overlap_symbols as "overlapSymbols",
        missed_movers as "missedMovers",
        questrade_only as "questradeOnly",
        metric_differences as "metricDifferences",
        discrepancy_summary as "discrepancySummary"
      FROM discovery_parity_audit
      WHERE market_id = $1
      ORDER BY audited_at DESC
      LIMIT 1`,
      [marketId],
    );

    if (result.rows.length === 0) return null;
    return this.mapRow(result.rows[0]);
  }

  async listAudits(
    marketId: MarketId,
    limit = 50,
  ): Promise<DiscoveryParityAudit[]> {
    const result = await this.pool.query(
      `SELECT
        id,
        market_id as "marketId",
        trading_date::text as "tradingDate",
        run_id as "runId",
        audited_at as "auditedAt",
        tradingview_count as "tradingViewCount",
        questrade_pass_count as "questradePassCount",
        overlap_count as "overlapCount",
        overlap_ratio as "overlapRatio",
        overlap_symbols as "overlapSymbols",
        missed_movers as "missedMovers",
        questrade_only as "questradeOnly",
        metric_differences as "metricDifferences",
        discrepancy_summary as "discrepancySummary"
      FROM discovery_parity_audit
      WHERE market_id = $1
      ORDER BY audited_at DESC
      LIMIT $2`,
      [marketId, limit],
    );

    return result.rows.map((row) => this.mapRow(row));
  }

  async getAudit(id: string): Promise<DiscoveryParityAudit | null> {
    const result = await this.pool.query(
      `SELECT
        id,
        market_id as "marketId",
        trading_date::text as "tradingDate",
        run_id as "runId",
        audited_at as "auditedAt",
        tradingview_count as "tradingViewCount",
        questrade_pass_count as "questradePassCount",
        overlap_count as "overlapCount",
        overlap_ratio as "overlapRatio",
        overlap_symbols as "overlapSymbols",
        missed_movers as "missedMovers",
        questrade_only as "questradeOnly",
        metric_differences as "metricDifferences",
        discrepancy_summary as "discrepancySummary"
      FROM discovery_parity_audit
      WHERE id = $1`,
      [id],
    );

    if (result.rows.length === 0) return null;
    return this.mapRow(result.rows[0]);
  }

  async countAudits(marketId: MarketId): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text as count FROM discovery_parity_audit WHERE market_id = $1`,
      [marketId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  private mapRow(row: Record<string, unknown>): DiscoveryParityAudit {
    return discoveryParityAuditSchema.parse({
      ...row,
      auditedAt:
        row.auditedAt instanceof Date
          ? row.auditedAt.toISOString()
          : String(row.auditedAt),
      overlapSymbols:
        typeof row.overlapSymbols === "string"
          ? JSON.parse(row.overlapSymbols)
          : row.overlapSymbols,
      missedMovers:
        typeof row.missedMovers === "string"
          ? JSON.parse(row.missedMovers)
          : row.missedMovers,
      questradeOnly:
        typeof row.questradeOnly === "string"
          ? JSON.parse(row.questradeOnly)
          : row.questradeOnly,
      metricDifferences:
        typeof row.metricDifferences === "string"
          ? JSON.parse(row.metricDifferences)
          : row.metricDifferences,
      discrepancySummary:
        typeof row.discrepancySummary === "string"
          ? JSON.parse(row.discrepancySummary)
          : row.discrepancySummary,
    });
  }
}

export class InMemoryDiscoveryParityStore implements DiscoveryParityStore {
  private readonly audits = new Map<string, DiscoveryParityAudit>();

  async save(audit: DiscoveryParityAudit): Promise<void> {
    const validated = discoveryParityAuditSchema.parse(audit);
    this.audits.set(validated.id, validated);
    const retained = await this.listAudits(
      validated.marketId,
      Number.MAX_SAFE_INTEGER,
    );
    for (const stale of retained.slice(PARITY_AUDIT_RETENTION_PER_MARKET))
      this.audits.delete(stale.id);
  }

  async loadLatest(marketId: MarketId): Promise<DiscoveryParityAudit | null> {
    const matching = Array.from(this.audits.values())
      .filter((a) => a.marketId === marketId)
      .sort(
        (left, right) =>
          Date.parse(right.auditedAt) - Date.parse(left.auditedAt),
      );
    return matching[0] ?? null;
  }

  async listAudits(
    marketId: MarketId,
    limit = 50,
  ): Promise<DiscoveryParityAudit[]> {
    return Array.from(this.audits.values())
      .filter((a) => a.marketId === marketId)
      .sort(
        (left, right) =>
          Date.parse(right.auditedAt) - Date.parse(left.auditedAt),
      )
      .slice(0, limit);
  }

  async getAudit(id: string): Promise<DiscoveryParityAudit | null> {
    return this.audits.get(id) ?? null;
  }

  async countAudits(marketId: MarketId): Promise<number> {
    return Array.from(this.audits.values()).filter(
      (a) => a.marketId === marketId,
    ).length;
  }
}
