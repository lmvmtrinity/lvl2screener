/**
 * W7: tracks rows-written, conflict, and transaction-latency counters for the set-based bulk
 * repository writes (quotes, candles, feature snapshots, setup evaluations/signals, state events,
 * contexts, instruments). Extends the W6 `/metrics` surface (see `metrics.ts`) with per-entity
 * detail so a scan cycle that starts writing slowly or hitting an unexpected volume of conflicts
 * shows up on the same dashboard as cycle/engine/feature latency, instead of only being visible
 * as an overall cycle-latency regression after the fact.
 */
export interface PersistenceEntityMetrics {
  /** Cumulative rows written (inserted or updated) since process start. */
  rowsWrittenTotal: number;
  /** Cumulative rows that hit `ON CONFLICT DO UPDATE` (an existing row was updated) since start. */
  conflictsTotal: number;
  /** Cumulative bulk-write statements executed since start. */
  writesTotal: number;
  /** Wall-clock duration of the most recent bulk write (connect/BEGIN through COMMIT/release). */
  lastLatencyMs: number | null;
  /** p95 latency over a bounded rolling window of recent writes for this entity. */
  p95LatencyMs: number | null;
}

export type PersistenceMetricsSnapshot = Record<
  string,
  PersistenceEntityMetrics
>;

const LATENCY_WINDOW = 500;

interface Bucket {
  rowsWrittenTotal: number;
  conflictsTotal: number;
  writesTotal: number;
  latencies: number[];
  /** Ring-buffer write cursor; avoids an O(n) `shift()` per sample once the window fills. */
  cursor: number;
  lastLatencyMs: number;
}

export class PersistenceMetrics {
  private readonly entities = new Map<string, Bucket>();

  /** Records the outcome of one bulk-write statement for `entity` (e.g. "quote_snapshot"). */
  record(
    entity: string,
    rowsWritten: number,
    conflicts: number,
    latencyMs: number,
  ): void {
    let bucket = this.entities.get(entity);
    if (!bucket) {
      bucket = {
        rowsWrittenTotal: 0,
        conflictsTotal: 0,
        writesTotal: 0,
        latencies: [],
        cursor: 0,
        lastLatencyMs: 0,
      };
      this.entities.set(entity, bucket);
    }
    bucket.rowsWrittenTotal += rowsWritten;
    bucket.conflictsTotal += conflicts;
    bucket.writesTotal += 1;
    bucket.lastLatencyMs = latencyMs;
    if (bucket.latencies.length < LATENCY_WINDOW) {
      bucket.latencies.push(latencyMs);
    } else {
      bucket.latencies[bucket.cursor] = latencyMs;
      bucket.cursor = (bucket.cursor + 1) % LATENCY_WINDOW;
    }
  }

  /** Times `operation`, records its outcome for `entity`, and returns its result. Rethrows and
   *  still records on failure (with rowsWritten/conflicts = 0) so a failed bulk write's latency
   *  is visible rather than silently missing from the window. */
  async time<T extends { written: number; conflicts: number }>(
    entity: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const started = performance.now();
    try {
      const result = await operation();
      this.record(
        entity,
        result.written,
        result.conflicts,
        Math.round((performance.now() - started) * 100) / 100,
      );
      return result;
    } catch (error) {
      this.record(
        entity,
        0,
        0,
        Math.round((performance.now() - started) * 100) / 100,
      );
      throw error;
    }
  }

  snapshot(): PersistenceMetricsSnapshot {
    const out: PersistenceMetricsSnapshot = {};
    for (const [entity, bucket] of this.entities) {
      const sorted = [...bucket.latencies].sort((a, b) => a - b);
      const p95Index = Math.min(
        sorted.length - 1,
        Math.floor(sorted.length * 0.95),
      );
      out[entity] = {
        rowsWrittenTotal: bucket.rowsWrittenTotal,
        conflictsTotal: bucket.conflictsTotal,
        writesTotal: bucket.writesTotal,
        lastLatencyMs: bucket.writesTotal > 0 ? bucket.lastLatencyMs : null,
        p95LatencyMs: sorted.length ? (sorted[p95Index] ?? null) : null,
      };
    }
    return out;
  }
}
