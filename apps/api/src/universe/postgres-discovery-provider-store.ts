import type { Pool, PoolClient } from "pg";
import { createHash } from "node:crypto";
import { z } from "zod";
import { marketIdSchema, type MarketId } from "@tsx-scanner/contracts";
import {
  parseEodhdCatalog,
  type CatalogSnapshot,
  type CatalogSnapshotStore,
  type CatalogError,
} from "./eodhd-catalog.js";
import { parseMassiveCatalog } from "./massive-catalog.js";
import {
  mappingDecisionSchema,
  type DiscoveryMappingStore,
  type MappingDecision,
} from "./discovery-mapping.js";

const snapshotHeader = z.object({
  source: z.enum(["EODHD", "MASSIVE"]),
  marketId: marketIdSchema,
  tradingDate: z.string().date(),
  fetchedAt: z.string().datetime(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  providerDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable()
    .default(null),
  rowCount: z.number().int().positive(),
  admittedCount: z.number().int().positive(),
  members: z.array(z.object({ raw: z.unknown() })),
});
export function validatedSnapshot(value: unknown): CatalogSnapshot {
  const parsed = snapshotHeader.parse(value);
  const raws = parsed.members.map((member) => member.raw);
  const members =
    parsed.source === "MASSIVE"
      ? parseMassiveCatalog(raws, parsed.marketId)
      : parseEodhdCatalog(raws, parsed.marketId);
  if (
    parsed.source === "MASSIVE" &&
    (parsed.providerDigest === null ||
      members.some(
        (member) =>
          member.raw.Massive?.responseDigest !== parsed.providerDigest,
      ))
  )
    throw new Error("Catalog provider digest mismatch");
  if (
    members.length !== parsed.rowCount ||
    members.filter((member) => member.reasons.length === 0).length !==
      parsed.admittedCount
  )
    throw new Error("Catalog cache coverage mismatch");
  if (
    createHash("sha256").update(JSON.stringify(members)).digest("hex") !==
    parsed.digest
  )
    throw new Error("Catalog cache digest mismatch");
  return { ...parsed, members };
}

class TransactionCatalogStore implements CatalogSnapshotStore {
  constructor(private readonly db: Pick<PoolClient, "query">) {}
  async loadLatest(marketId: MarketId): Promise<CatalogSnapshot | null> {
    marketIdSchema.parse(marketId);
    const result = await this.db.query<{ snapshot: unknown }>(
      "SELECT snapshot FROM discovery_catalog_cache WHERE market_id=$1",
      [marketId],
    );
    return result.rows[0] ? validatedSnapshot(result.rows[0].snapshot) : null;
  }
  async save(snapshot: CatalogSnapshot): Promise<void> {
    const validated = validatedSnapshot(snapshot);
    const result = await this.db.query(
      `INSERT INTO discovery_catalog_cache(market_id,trading_date,snapshot)
      VALUES($1,$2,$3::jsonb) ON CONFLICT(market_id) DO UPDATE SET
      trading_date=EXCLUDED.trading_date,snapshot=EXCLUDED.snapshot,updated_at=clock_timestamp()
      WHERE discovery_catalog_cache.trading_date < EXCLUDED.trading_date
        OR (discovery_catalog_cache.trading_date = EXCLUDED.trading_date AND (
          discovery_catalog_cache.snapshot->>'digest' = EXCLUDED.snapshot->>'digest'
          OR discovery_catalog_cache.snapshot->>'source' IS DISTINCT FROM EXCLUDED.snapshot->>'source'))`,
      [validated.marketId, validated.tradingDate, JSON.stringify(validated)],
    );
    if (result.rowCount !== 1)
      throw new Error("Catalog publication date/digest conflict");
  }
  async recordFailure(
    marketId: MarketId,
    tradingDate: string,
    failure: CatalogError["code"],
    retainedDigest: string | null,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO discovery_catalog_attempt(market_id,trading_date,failure_code,retained_digest) VALUES($1,$2,$3,$4)`,
      [marketId, tradingDate, failure, retainedDigest],
    );
  }
}

export class PostgresCatalogSnapshotStore extends TransactionCatalogStore {
  constructor(private readonly pool: Pool) {
    super(pool);
  }
  async withRefreshLease<T>(
    marketId: MarketId,
    action: (store: CatalogSnapshotStore) => Promise<T>,
  ): Promise<T> {
    marketIdSchema.parse(marketId);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Transaction ownership releases on connection loss. All callback storage
      // uses this same connection, avoiding pool starvation while a lease is held.
      await client.query("SELECT pg_advisory_xact_lock(846021, $1::integer)", [
        marketId === "CA_TSX" ? 1 : 2,
      ]);
      const result = await action(new TransactionCatalogStore(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

export class PostgresDiscoveryMappingStore implements DiscoveryMappingStore {
  constructor(private readonly pool: Pool) {}
  async load(
    marketId: MarketId,
    exchange: string,
    code: string,
  ): Promise<MappingDecision | null> {
    marketIdSchema.parse(marketId);
    const result = await this.pool.query<{ decision: unknown }>(
      `SELECT decision FROM discovery_symbol_mapping
      WHERE market_id=$1 AND provider_exchange=$2 AND provider_code=$3`,
      [marketId, exchange, code],
    );
    return result.rows[0]
      ? mappingDecisionSchema.parse(result.rows[0].decision)
      : null;
  }
  async save(value: MappingDecision): Promise<void> {
    const decision = mappingDecisionSchema.parse(value);
    await this.pool.query(
      `INSERT INTO discovery_symbol_mapping(market_id,provider_exchange,provider_code,catalog_fingerprint,decision,expires_at)
      VALUES($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT(market_id,provider_exchange,provider_code) DO UPDATE
      SET catalog_fingerprint=EXCLUDED.catalog_fingerprint,decision=EXCLUDED.decision,expires_at=EXCLUDED.expires_at
      WHERE (discovery_symbol_mapping.decision->>'resolvedAt')::timestamptz <= (EXCLUDED.decision->>'resolvedAt')::timestamptz`,
      [
        decision.marketId,
        decision.providerExchange,
        decision.providerCode,
        decision.catalogFingerprint,
        JSON.stringify(decision),
        decision.expiresAt,
      ],
    );
  }
}
