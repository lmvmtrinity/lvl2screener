/**
 * Small bounded latency sample used for operational p95 diagnostics.
 *
 * The window is intentionally process-local: Prometheus retains the time series across
 * restarts, while the sample count and p95 describe only the observations made by the
 * current process. A restart therefore cannot manufacture continuity in a commissioning
 * report.
 */
export class LatencyWindow {
  private readonly values: number[] = [];
  private cursor = 0;

  constructor(private readonly capacity = 100) {
    if (!Number.isInteger(capacity) || capacity <= 0)
      throw new RangeError(
        "Latency window capacity must be a positive integer",
      );
  }

  record(valueMs: number): void {
    if (!Number.isFinite(valueMs))
      throw new TypeError("Latency sample must be finite");
    const value = Math.max(0, Math.round(valueMs * 100) / 100);
    if (this.values.length < this.capacity) this.values.push(value);
    else {
      this.values[this.cursor] = value;
      this.cursor = (this.cursor + 1) % this.capacity;
    }
  }

  get sampleCount(): number {
    return this.values.length;
  }

  p95(): number | null {
    if (this.values.length === 0) return null;
    const sorted = [...this.values].sort((left, right) => left - right);
    const index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
    return sorted[index] ?? null;
  }
}
