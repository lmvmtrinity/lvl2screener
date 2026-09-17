import { describe, expect, it } from "vitest";
import type { StrategyStateEvent } from "@tsx-scanner/contracts";
import { createAlert, createAlerts } from "../src/alerts/alert-service.js";

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

describe("Phase 6 alert generation", () => {
  it("creates a READY alert from an authoritative READY transition", () => {
    expect(createAlert(event("FORMING", "READY"))).toMatchObject({
      alertId: "10000000-0000-4000-8000-000000000001",
      eventId: "10000000-0000-4000-8000-000000000001",
      type: "READY",
      symbol: "BTO.TO",
      score: 86,
    });
  });

  it("does not alert when an event remains READY", () => {
    expect(createAlert(event("READY", "READY"))).toBeUndefined();
  });

  it("only creates an invalidation alert when a READY setup becomes INVALIDATED", () => {
    expect(createAlert(event("READY", "INVALIDATED"))).toMatchObject({
      type: "INVALIDATION",
    });
    expect(createAlert(event("FORMING", "INVALIDATED"))).toBeUndefined();
  });

  it("ignores non-actionable transitions", () => {
    expect(
      createAlerts([event("WATCH", "FORMING"), event("FORMING", "WATCH")]),
    ).toEqual([]);
  });

  it("emits READY only once per setup instance even when another READY event is delivered", () => {
    const first = event("FORMING", "READY");
    const repeated = event("FORMING", "READY", {
      eventId: "10000000-0000-4000-8000-000000000003",
      timestamp: "2026-08-24T14:30:00.000Z",
    });
    expect(
      createAlerts([first, repeated], [], {
        cooldownMinutes: 0,
        rearmRule: "NEW_SETUP_INSTANCE",
        contextNotificationsEnabled: false,
      }),
    ).toHaveLength(1);
  });

  it("applies cooldown across new setup instances", () => {
    const first = createAlert(event("FORMING", "READY"))!;
    const next = event("FORMING", "READY", {
      eventId: "10000000-0000-4000-8000-000000000003",
      setupInstanceId: "10000000-0000-4000-8000-000000000098",
      timestamp: "2026-08-24T14:04:00.000Z",
    });
    expect(
      createAlerts([next], [first], {
        cooldownMinutes: 5,
        rearmRule: "NEW_SETUP_INSTANCE",
        contextNotificationsEnabled: false,
      }),
    ).toEqual([]);
    expect(
      createAlerts(
        [{ ...next, timestamp: "2026-08-24T14:05:00.000Z" }],
        [first],
        {
          cooldownMinutes: 5,
          rearmRule: "NEW_SETUP_INSTANCE",
          contextNotificationsEnabled: false,
        },
      ),
    ).toHaveLength(1);
  });

  it("can require invalidation before a different setup instance rearms alerts", () => {
    const first = createAlert(event("FORMING", "READY"))!;
    const next = event("FORMING", "READY", {
      eventId: "10000000-0000-4000-8000-000000000003",
      setupInstanceId: "10000000-0000-4000-8000-000000000098",
      timestamp: "2026-08-24T14:10:00.000Z",
    });
    const policy = {
      cooldownMinutes: 0,
      rearmRule: "AFTER_INVALIDATION" as const,
      contextNotificationsEnabled: false as const,
    };
    expect(createAlerts([next], [first], policy)).toEqual([]);
    const invalidation = createAlert(
      event("READY", "INVALIDATED", { timestamp: "2026-08-24T14:05:00.000Z" }),
    )!;
    expect(createAlerts([next], [first, invalidation], policy)).toHaveLength(1);
  });
});
