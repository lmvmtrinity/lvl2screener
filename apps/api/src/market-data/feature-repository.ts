import type { FeatureSnapshot } from "@tsx-scanner/contracts";
import type { Pool } from "pg";
import type { PersistenceMetrics } from "../observability/persistence-metrics.js";
import { chunkRows, countUpsertOutcome } from "./batch-utils.js";

export interface FeatureSnapshotStore {
  saveFeatureSnapshots(snapshots: FeatureSnapshot[]): Promise<void>;
}

// See batch-utils.ts for the jsonb_to_recordset rationale and why this bound is a payload-size
// safety valve, not a parameter-limit workaround.
const FEATURE_CHUNK_SIZE = 1000;

export class PostgresFeatureSnapshotStore implements FeatureSnapshotStore {
  constructor(
    private readonly pool: Pool,
    private readonly metrics?: PersistenceMetrics,
  ) {}

  /** Bulk feature-snapshot upsert: one `jsonb_to_recordset` statement per chunk instead of one
   *  round trip per instrument. Also fixes the prior ON CONFLICT clause, which only refreshed a
   *  subset of columns (price/vwap/atr/rvol/opening-range-high-low/support/resistance/json) and
   *  silently left `change_from_open_pct`, the rest of the opening-range fields, `spread_pct`,
   *  the support/resistance *type* columns, `extension_atr`, and `config_version` stale on a
   *  re-write of the same (instrument, timestamp, feature_version) key -- every non-key column is
   *  refreshed now. */
  async saveFeatureSnapshots(snapshots: FeatureSnapshot[]): Promise<void> {
    if (snapshots.length === 0) return;
    const started = performance.now();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      let written = 0;
      let conflicts = 0;
      for (const chunk of chunkRows(snapshots, FEATURE_CHUNK_SIZE)) {
        const result = await client.query<{ inserted: boolean }>(
          `WITH input AS (
             SELECT * FROM jsonb_to_recordset($1::jsonb) AS t(
               market_id text, instrument_id uuid, ts timestamptz, timeframe text, price numeric, vwap numeric,
               distance_from_vwap_pct numeric, atr_14 numeric, atr_pct numeric,
               rvol_at_time numeric, change_from_open_pct numeric, opening_range_high numeric,
               opening_range_low numeric, opening_range_mid numeric, opening_range_width_pct numeric,
               opening_range_width_atr numeric, spread_pct numeric, nearest_support numeric,
               nearest_support_type text, nearest_resistance numeric, nearest_resistance_type text,
               extension_atr numeric, config_version text, feature_version text, snapshot_json jsonb
             )
           )
           INSERT INTO feature_snapshot (
             market_id, instrument_id, timestamp, timeframe, price, vwap, distance_from_vwap_pct,
             atr_14, atr_pct, rvol_at_time, change_from_open_pct, opening_range_high,
             opening_range_low, opening_range_mid, opening_range_width_pct,
             opening_range_width_atr, spread_pct, nearest_support, nearest_support_type,
             nearest_resistance, nearest_resistance_type, extension_atr,
             config_version, feature_version, snapshot_json
           )
           SELECT market_id, instrument_id, ts, timeframe, price, vwap, distance_from_vwap_pct,
                  atr_14, atr_pct, rvol_at_time, change_from_open_pct, opening_range_high,
                  opening_range_low, opening_range_mid, opening_range_width_pct,
                  opening_range_width_atr, spread_pct, nearest_support, nearest_support_type,
                  nearest_resistance, nearest_resistance_type, extension_atr,
                  config_version, feature_version, snapshot_json
           FROM input
           ON CONFLICT (instrument_id, timestamp, feature_version) DO UPDATE SET
             timeframe = EXCLUDED.timeframe,
             price = EXCLUDED.price,
             vwap = EXCLUDED.vwap,
             distance_from_vwap_pct = EXCLUDED.distance_from_vwap_pct,
             atr_14 = EXCLUDED.atr_14,
             atr_pct = EXCLUDED.atr_pct,
             rvol_at_time = EXCLUDED.rvol_at_time,
             change_from_open_pct = EXCLUDED.change_from_open_pct,
             opening_range_high = EXCLUDED.opening_range_high,
             opening_range_low = EXCLUDED.opening_range_low,
             opening_range_mid = EXCLUDED.opening_range_mid,
             opening_range_width_pct = EXCLUDED.opening_range_width_pct,
             opening_range_width_atr = EXCLUDED.opening_range_width_atr,
             spread_pct = EXCLUDED.spread_pct,
             nearest_support = EXCLUDED.nearest_support,
             nearest_support_type = EXCLUDED.nearest_support_type,
             nearest_resistance = EXCLUDED.nearest_resistance,
             nearest_resistance_type = EXCLUDED.nearest_resistance_type,
             extension_atr = EXCLUDED.extension_atr,
             config_version = EXCLUDED.config_version,
             snapshot_json = EXCLUDED.snapshot_json
           RETURNING (xmax = 0) AS inserted`,
          [JSON.stringify(chunk.map(toFeatureRow))],
        );
        const outcome = countUpsertOutcome(result.rows);
        written += outcome.written;
        conflicts += outcome.conflicts;
      }
      await client.query("COMMIT");
      this.metrics?.record(
        "feature_snapshot",
        written,
        conflicts,
        Math.round((performance.now() - started) * 100) / 100,
      );
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

function toFeatureRow(snapshot: FeatureSnapshot) {
  return {
    market_id: snapshot.marketId,
    instrument_id: snapshot.instrumentId,
    ts: snapshot.timestamp,
    timeframe: snapshot.timeframe,
    price: snapshot.price,
    vwap: snapshot.vwap,
    distance_from_vwap_pct: snapshot.distanceFromVwapPct,
    atr_14: snapshot.atr14,
    atr_pct: snapshot.atrPct,
    rvol_at_time: snapshot.rvolAtTime,
    change_from_open_pct: snapshot.changeFromOpenPct,
    opening_range_high: snapshot.openingRange?.high ?? null,
    opening_range_low: snapshot.openingRange?.low ?? null,
    opening_range_mid: snapshot.openingRange?.mid ?? null,
    opening_range_width_pct: snapshot.openingRange?.widthPct ?? null,
    opening_range_width_atr: snapshot.openingRange?.widthAtr ?? null,
    spread_pct: snapshot.spreadPct,
    nearest_support: snapshot.nearestSupport?.price ?? null,
    nearest_support_type: snapshot.nearestSupport?.type ?? null,
    nearest_resistance: snapshot.nearestResistance?.price ?? null,
    nearest_resistance_type: snapshot.nearestResistance?.type ?? null,
    extension_atr: snapshot.distanceFromVwapAtr,
    config_version: snapshot.configVersion,
    feature_version: snapshot.featureVersion,
    snapshot_json: snapshot,
  };
}
