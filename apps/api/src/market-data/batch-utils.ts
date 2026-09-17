/**
 * W7: shared helpers for the set-based bulk repository methods.
 *
 * All bulk writes below pass one row-array as a single `jsonb` bind parameter and expand it
 * server-side with `jsonb_to_recordset`, rather than binding one PostgreSQL parameter per column
 * per row (typed `UNNEST($1::type[], $2::type[], ...)` arrays). Both approaches send exactly one
 * network round trip per statement; `jsonb_to_recordset` was picked over typed array `UNNEST`
 * because:
 *
 * - Bind-parameter count stays constant (1-2) regardless of batch size, so the PostgreSQL 65535
 *   parameter limit is never a concern here (a typed `UNNEST` with N columns already only binds N
 *   parameters total -- one array per column, not one per cell -- so both approaches are far under
 *   the limit at the row counts this workstream targets; `jsonb_to_recordset` was preferred for the
 *   16-24 column tables below purely because it reads as one flat column list instead of N parallel
 *   JS arrays built and kept in lockstep by hand, which is where the existing per-row code had
 *   drifted out of sync with its own INSERT column list).
 * - Rows here are naturally JS objects with nullable/optional fields and nested JSON
 *   (`reasonCodes`, `scoreComponents`, `snapshot_json`, ...); `JSON.stringify` on the row array
 *   is the natural encoding, and jsonb_to_recordset's column-type coercion (`t(col type, ...)`)
 *   does the per-column casting PostgreSQL-side.
 *
 * This is a reasoning-based choice, not a measured one: no live PostgreSQL instance was available
 * while writing this module to A/B it against typed arrays or `COPY`. `COPY` was ruled out because
 * these are all upserts (INSERT ... ON CONFLICT DO UPDATE), which `COPY` cannot express directly
 * without a staging table plus a second statement -- more round trips, not fewer, at this row
 * count. Temporary staging tables were ruled out for the same reason: a bare `INSERT ... SELECT
 * FROM jsonb_to_recordset(...)` already does the expand-and-upsert in one statement.
 *
 * Chunk sizes below are NOT driven by the parameter limit (each statement binds one jsonb
 * parameter no matter how many rows it contains). They exist to bound per-statement payload size
 * and lock/WAL-batch duration for the rare large calls this module makes outside the 2-second
 * quote cycle (candle warmup backfill can submit tens of thousands of rows in one call). Normal
 * live cycles (100-200 symbols) never approach these thresholds, so chunking is a safety bound,
 * not part of the steady-state hot path.
 */

/** Splits `items` into chunks of at most `size`. Never returns an empty chunk. */
export function chunkRows<T>(items: readonly T[], size: number): T[][] {
  if (items.length === 0) return [];
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

/** Counts inserted vs. conflicted (updated) rows from a `RETURNING (xmax = 0) AS inserted` upsert. */
export function countUpsertOutcome(rows: { inserted: boolean }[]): {
  written: number;
  conflicts: number;
} {
  let conflicts = 0;
  for (const row of rows) if (!row.inserted) conflicts += 1;
  return { written: rows.length, conflicts };
}
