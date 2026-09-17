import type { ScannerAlert } from "@tsx-scanner/contracts";

const MAX_RETAINED_ALERTS = 200;

/** W9: extracted from `QuestradeDataService.updateFeatures`'s inline alert-buffer bookkeeping —
 * deduping newly generated alerts against ones already known, tracking a running
 * `alertsDeliveredTotal` (the count that feeds `/metrics`), and keeping the in-memory buffer
 * capped so a long-running process doesn't grow it without bound (durable history lives in
 * Postgres via alert-repository.ts). */
export class AlertBuffer {
  private readonly alerts: ScannerAlert[] = [];
  private deliveredTotal = 0;

  constructor(initial: ScannerAlert[] = []) {
    const seen = new Set<string>();
    for (const alert of initial) {
      if (seen.has(alert.alertId)) continue;
      seen.add(alert.alertId);
      this.alerts.push(alert);
    }
  }

  get deliveredCount(): number {
    return this.deliveredTotal;
  }

  list(): ScannerAlert[] {
    return [...this.alerts];
  }

  /** Records `candidates` (the durable-store's return value, which may include ones already
   * known) into the buffer, newest-first, trimmed to `MAX_RETAINED_ALERTS`, and returns only the
   * ones that were actually new so the caller can log each exactly once. */
  record(candidates: ScannerAlert[]): ScannerAlert[] {
    if (candidates.length === 0) return [];
    const existingIds = new Set(this.alerts.map((alert) => alert.alertId));
    const delivered = candidates.filter(
      (alert) => !existingIds.has(alert.alertId),
    );
    this.deliveredTotal += delivered.length;
    const newestFirst = [...delivered].reverse();
    this.alerts.unshift(...newestFirst);
    this.alerts.splice(MAX_RETAINED_ALERTS);
    return delivered;
  }
}
