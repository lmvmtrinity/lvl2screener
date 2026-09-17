import { describe, expect, it } from "vitest";
import type {
  AlertPolicy,
  ScannerAlert,
  StrategyStateEvent,
} from "@tsx-scanner/contracts";
import {
  createAlerts,
  alertDeduplicationKey,
} from "../src/alerts/alert-service.js";

/**
 * Simulates the durable side of PostgresAlertStore: an `ON CONFLICT
 * (deduplication_key) DO NOTHING` insert. Standing in for Postgres here keeps
 * the test process-restart-shaped without a database, while exercising the
 * exact dedup key the real store enforces.
 */
class DurableAlertLedger {
  private readonly byKey = new Map<string, ScannerAlert>();

  persist(alerts: ScannerAlert[]): ScannerAlert[] {
    const saved: ScannerAlert[] = [];
    for (const alert of alerts) {
      const key =
        alert.deduplicationKey ??
        alertDeduplicationKey(alert.type, alert.setupInstanceId, alert.eventId);
      if (this.byKey.has(key)) continue;
      this.byKey.set(key, alert);
      saved.push(alert);
    }
    return saved;
  }

  listRecent(): ScannerAlert[] {
    return [...this.byKey.values()];
  }
}

function event(
  previousState: StrategyStateEvent["previousState"],
  state: StrategyStateEvent["state"],
  overrides: Partial<StrategyStateEvent> = {},
): StrategyStateEvent {
  return {
    eventId: "10000000-0000-4000-8000-000000000001",
    eventType: "STRATEGY_STATE_CHANGED",
    instrumentId: "10000000-0000-4000-8000-000000000002",
    symbol: "BTO.TO",
    strategy: "ORB_RETEST",
    strategyVersion: "1.0.0",
    configVersion: "phase4-default-v1",
    timestamp: "2026-08-24T14:00:00.000Z",
    previousState,
    state,
    score: 86,
    reasonCodes: ["ORB_RETEST_CONFIRMED"],
    setupInstanceId: "10000000-0000-4000-8000-000000000099",
    ...overrides,
  } as unknown as StrategyStateEvent;
}

const policy: AlertPolicy = {
  cooldownMinutes: 0,
  rearmRule: "NEW_SETUP_INSTANCE",
  contextNotificationsEnabled: false,
};

describe("Phase 9 restart recovery", () => {
  it("does not re-deliver a READY alert when a process restart replays the same setup instance", () => {
    const ledger = new DurableAlertLedger();

    // Process instance A: sees the READY event, persists the alert, then "restarts" (in-memory state is lost).
    const inMemoryA: ScannerAlert[] = [];
    const generatedA = createAlerts(
      [event("FORMING", "READY")],
      inMemoryA,
      policy,
    );
    const savedA = ledger.persist(generatedA);
    expect(savedA).toHaveLength(1);

    // Process instance B: reloads persisted alerts on boot (mirrors service.ts initialize()),
    // then replays the identical READY event as if the scanner resent an unacknowledged batch.
    const inMemoryB = ledger.listRecent();
    const generatedB = createAlerts(
      [event("FORMING", "READY")],
      inMemoryB,
      policy,
    );
    const savedB = ledger.persist(generatedB);

    expect(generatedB).toHaveLength(0);
    expect(savedB).toHaveLength(0);
    expect(ledger.listRecent()).toHaveLength(1);
  });

  it("still delivers a genuinely new setup instance after a restart", () => {
    const ledger = new DurableAlertLedger();
    ledger.persist(createAlerts([event("FORMING", "READY")], [], policy));

    const nextInstance = event("FORMING", "READY", {
      eventId: "10000000-0000-4000-8000-000000000003",
      setupInstanceId: "10000000-0000-4000-8000-000000000098",
      timestamp: "2026-08-24T14:10:00.000Z",
    });
    const reloaded = ledger.listRecent();
    const generated = createAlerts([nextInstance], reloaded, policy);
    const saved = ledger.persist(generated);

    expect(saved).toHaveLength(1);
    expect(ledger.listRecent()).toHaveLength(2);
  });
});
