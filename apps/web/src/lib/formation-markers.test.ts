import { describe, expect, it } from "vitest";
import type { FormationEvidence } from "@tsx-scanner/contracts";
import {
  buildFormationMarkers,
  layoutFormationMarkers,
  type FormationRecord,
} from "./formation-markers.js";

const scope = {
  marketId: "CA_TSX" as const,
  instrumentId: "11111111-1111-4111-8111-111111111111",
};
const time = (minute: number) =>
  `2026-09-08T14:${String(minute).padStart(2, "0")}:00.000Z`;
const evidence: FormationEvidence = {
  version: "formation-evidence-v1",
  strategy: "RSI_VWAP_RECLAIM",
  formationKey: "pair-a",
  setupLevel: 99,
  stopLevel: 98.9,
  retest: null,
  rsiVwapReclaim: {
    indicatorVersion: "wilder-rsi-14-v1",
    firstPivot: { timestamp: time(5), price: 100, rsi: 40 },
    secondPivot: { timestamp: time(15), price: 99, rsi: 45 },
    divergenceConfirmedAt: time(25),
    divergenceVolumeContractionRatio: null,
    reclaimAt: time(30),
    holdAt: time(35),
    frozenResistance: 102,
    invalidationLevel: 99,
  },
};
const record = (timestamp = time(40)): FormationRecord => ({
  ...scope,
  profileId: "22222222-2222-4222-8222-222222222222",
  setupInstanceId: "33333333-3333-4333-8333-333333333333",
  timestamp,
  formationEvidence: evidence,
});

describe("retained formation markers", () => {
  it("does not expose old origins from a record captured after as-of", () => {
    expect(buildFormationMarkers([record()], scope, time(30))).toEqual([]);
  });

  it("uses exact state-event time and keeps unknown pivot availability unknown", () => {
    const event: FormationRecord = {
      ...record(),
      event: {
        eventId: "44444444-4444-4444-8444-444444444444",
        state: "READY",
      },
    };
    const markers = buildFormationMarkers([event, record()], scope, time(40));
    expect(
      markers.filter((m) => m.kind === "STATE_EVENT").map((m) => m.plotAt),
    ).toEqual([time(40)]);
    expect(markers.find((m) => m.plotAt === time(5))?.availableAt).toBeNull();
    expect(markers.find((m) => m.kind === "DIVERGENCE_CONFIRMED")?.plotAt).toBe(
      time(25),
    );
    expect(markers.find((m) => m.kind === "RECLAIM")?.price).toBeNull();
  });

  it("isolates markets, deduplicates, and never promotes a latest evaluation to an event", () => {
    const records = [
      record(),
      record(),
      { ...record(), marketId: "US_EQUITIES" as const },
    ];
    expect(buildFormationMarkers(records, scope, time(40))).toEqual(
      buildFormationMarkers([record()], scope, time(40)),
    );
    expect(
      buildFormationMarkers(records, scope, time(40)).some(
        (m) => m.kind === "STATE_EVENT",
      ),
    ).toBe(false);
    expect(
      buildFormationMarkers(
        [{ ...record(), formationEvidence: null }],
        scope,
        time(40),
      ),
    ).toEqual([]);
  });

  it("ignores later snapshots and clips markers without changing bounds", () => {
    const original = buildFormationMarkers([record()], scope, time(40));
    expect(
      buildFormationMarkers([record(time(45)), record()], scope, time(40)),
    ).toEqual(original);
    const geometry = { width: 900, height: 340, pad: 30, min: 98, max: 104 };
    const candles = [
      { start: time(20), end: time(25) },
      { start: time(25), end: time(30) },
    ];
    const placed = layoutFormationMarkers(original, candles, geometry);
    expect(placed.map((m) => m.plotAt)).toEqual([time(25), time(30)]);
    expect(
      placed.every((m) => m.x >= 30 && m.x <= 870 && m.y >= 30 && m.y <= 310),
    ).toBe(true);
    expect(geometry).toEqual({
      width: 900,
      height: 340,
      pad: 30,
      min: 98,
      max: 104,
    });
  });
});
