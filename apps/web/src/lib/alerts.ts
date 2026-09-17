import type { ScannerAlert } from "@tsx-scanner/contracts";

/** Same dedup key App.tsx has always used: the alert's own `deduplicationKey` when the server
 * sent one, else a type + setup-instance (or event) composite. Extracted so the dedup rule is
 * unit-testable without mounting the whole app. */
export function alertDedupeKey(alert: ScannerAlert): string {
  return (
    alert.deduplicationKey ??
    `${alert.type}:${alert.setupInstanceId ?? alert.eventId}`
  );
}

/** Splits `incoming` alerts against a `seen` set of dedup keys (mutated in place, matching the
 * `seenAlerts` ref App.tsx keeps across renders/reconnects): every incoming alert's key is added
 * to `seen` regardless, but only alerts whose key was not already present are returned as
 * "unseen" — the ones that should actually raise a toast/notification/sound. */
export function partitionUnseenAlerts(
  incoming: ScannerAlert[],
  seen: Set<string>,
): { unseen: ScannerAlert[]; keys: string[] } {
  const keys = incoming.map(alertDedupeKey);
  const unseen = incoming.filter((alert) => !seen.has(alertDedupeKey(alert)));
  for (const key of keys) seen.add(key);
  return { unseen, keys };
}
