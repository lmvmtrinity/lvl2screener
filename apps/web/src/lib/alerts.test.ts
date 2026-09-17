import { describe, expect, it } from "vitest";
import type { ScannerAlert } from "@tsx-scanner/contracts";
import { alertDedupeKey, partitionUnseenAlerts } from "./alerts.js";

function makeAlert(overrides: Partial<ScannerAlert> = {}): ScannerAlert {
  return {
    alertId: "alert-1",
    type: "READY",
    symbol: "TD.TO",
    strategy: "ORB_RETEST",
    profileId: "p1",
    setupInstanceId: "instance-1",
    eventId: "event-1",
    score: 80,
    title: "TD.TO ready",
    message: "Setup ready",
    createdAt: "2026-08-28T14:00:00.000Z",
    ...overrides,
  } as ScannerAlert;
}

describe("alertDedupeKey", () => {
  it("uses the server-provided deduplicationKey when present", () => {
    const alert = makeAlert({ deduplicationKey: "explicit-key" });
    expect(alertDedupeKey(alert)).toBe("explicit-key");
  });

  it("falls back to type:setupInstanceId when no deduplicationKey is sent", () => {
    const alert = makeAlert({ setupInstanceId: "instance-1" });
    expect(alertDedupeKey(alert)).toBe("READY:instance-1");
  });

  it("falls back to type:eventId when neither deduplicationKey nor setupInstanceId exist", () => {
    const alert = makeAlert({
      setupInstanceId: undefined,
      eventId: "event-9",
    });
    expect(alertDedupeKey(alert)).toBe("READY:event-9");
  });
});

describe("partitionUnseenAlerts", () => {
  it("treats every alert as unseen the first time its key is encountered", () => {
    const seen = new Set<string>();
    const { unseen } = partitionUnseenAlerts(
      [
        makeAlert({ alertId: "a" }),
        makeAlert({
          alertId: "b",
          eventId: "event-2",
          setupInstanceId: "instance-2",
        }),
      ],
      seen,
    );
    expect(unseen).toHaveLength(2);
  });

  it("dedupes a repeat delivery of the same setup instance's alert", () => {
    const seen = new Set<string>();
    partitionUnseenAlerts([makeAlert()], seen);
    const { unseen } = partitionUnseenAlerts([makeAlert()], seen);
    expect(unseen).toHaveLength(0);
  });

  it("mutates the seen set so a later call sees the same keys as already known", () => {
    const seen = new Set<string>();
    partitionUnseenAlerts([makeAlert()], seen);
    expect(seen.has("READY:instance-1")).toBe(true);
  });

  it("still returns unseen alerts alongside already-seen ones in a mixed batch", () => {
    const seen = new Set<string>();
    partitionUnseenAlerts([makeAlert({ alertId: "a" })], seen);
    const { unseen } = partitionUnseenAlerts(
      [
        makeAlert({ alertId: "a" }),
        makeAlert({
          alertId: "c",
          eventId: "event-3",
          setupInstanceId: "instance-3",
        }),
      ],
      seen,
    );
    expect(unseen.map((alert) => alert.alertId)).toEqual(["c"]);
  });
});
