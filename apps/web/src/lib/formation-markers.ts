import type {
  FormationEvidence,
  StrategyEvaluation,
  StrategyStateEvent,
} from "@tsx-scanner/contracts";

export type FormationRecord = Pick<
  StrategyEvaluation,
  | "marketId"
  | "instrumentId"
  | "profileId"
  | "setupInstanceId"
  | "timestamp"
  | "formationEvidence"
> & {
  event?: Pick<StrategyStateEvent, "eventId" | "state">;
};

export type MarkerKind =
  | "PIVOT_ORIGIN"
  | "DIVERGENCE_CONFIRMED"
  | "RECLAIM"
  | "HOLD"
  | "RETEST"
  | "STATE_EVENT";

export type FormationMarker = {
  id: string;
  kind: MarkerKind;
  plotAt: string;
  originAt: string | null;
  availableAt: string | null;
  recordedAt: string;
  price: number | null;
  label: string;
};

export type MarkerScope = Pick<StrategyEvaluation, "marketId" | "instrumentId">;
export type MarkerCandle = { start: string; end: string };
export type MarkerLayout = FormationMarker & { x: number; y: number };

export function buildFormationMarkers(
  records: readonly FormationRecord[],
  scope: MarkerScope,
  asOf: string,
): FormationMarker[] {
  const cutoff = Date.parse(asOf);
  if (!Number.isFinite(cutoff)) return [];
  const result = new Map<string, FormationMarker>();
  const ordered = [...records]
    .filter(
      (record) =>
        record.marketId === scope.marketId &&
        record.instrumentId === scope.instrumentId &&
        Number.isFinite(Date.parse(record.timestamp)) &&
        Date.parse(record.timestamp) <= cutoff,
    )
    .sort(
      (left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp),
    );

  for (const record of ordered) {
    const recordedAt = Date.parse(record.timestamp);
    const base = `${record.marketId}:${record.instrumentId}:${record.profileId}:${record.setupInstanceId}`;
    const put = (
      key: string,
      kind: MarkerKind,
      plotAt: string,
      price: number | null,
      label: string,
      originAt: string | null,
      availableAt: string | null,
    ) => {
      const plotTime = Date.parse(plotAt);
      if (
        !Number.isFinite(plotTime) ||
        plotTime > recordedAt ||
        plotTime > cutoff
      )
        return;
      if (
        availableAt !== null &&
        (!Number.isFinite(Date.parse(availableAt)) ||
          Date.parse(availableAt) > recordedAt ||
          Date.parse(availableAt) > cutoff)
      )
        return;
      const id = `${base}:${key}:${plotAt}`;
      if (!result.has(id))
        result.set(id, {
          id,
          kind,
          plotAt,
          originAt,
          availableAt,
          recordedAt: record.timestamp,
          price: price !== null && Number.isFinite(price) ? price : null,
          label,
        });
    };

    if (record.event)
      put(
        `event:${record.event.eventId}`,
        "STATE_EVENT",
        record.timestamp,
        null,
        `State ${record.event.state}`,
        null,
        record.timestamp,
      );

    const evidence: FormationEvidence | null = record.formationEvidence ?? null;
    if (!evidence || !record.setupInstanceId) continue;

    const rsi = evidence.rsiVwapReclaim;
    if (rsi) {
      put(
        "pivot-1",
        "PIVOT_ORIGIN",
        rsi.firstPivot.timestamp,
        rsi.firstPivot.price,
        "First price pivot origin; exact confirmation unavailable",
        rsi.firstPivot.timestamp,
        null,
      );
      put(
        "pivot-2",
        "PIVOT_ORIGIN",
        rsi.secondPivot.timestamp,
        rsi.secondPivot.price,
        "Second price pivot origin",
        rsi.secondPivot.timestamp,
        rsi.divergenceConfirmedAt,
      );
      put(
        "divergence",
        "DIVERGENCE_CONFIRMED",
        rsi.divergenceConfirmedAt,
        null,
        "Divergence confirmed",
        rsi.secondPivot.timestamp,
        rsi.divergenceConfirmedAt,
      );
      if (rsi.reclaimAt)
        put(
          "reclaim",
          "RECLAIM",
          rsi.reclaimAt,
          null,
          "VWAP reclaim recorded; historical VWAP price unavailable",
          null,
          rsi.reclaimAt,
        );
      if (rsi.holdAt)
        put(
          "hold",
          "HOLD",
          rsi.holdAt,
          null,
          "VWAP hold recorded; historical VWAP price unavailable",
          null,
          rsi.holdAt,
        );
    }

    if (evidence.retest?.retestBarEnd)
      put(
        "retest",
        "RETEST",
        evidence.retest.retestBarEnd,
        evidence.retest.retestBarLow,
        "Retest bar retained; not a READY timestamp",
        evidence.retest.retestBarEnd,
        null,
      );
  }

  return [...result.values()].sort(
    (left, right) =>
      Date.parse(left.plotAt) - Date.parse(right.plotAt) ||
      left.id.localeCompare(right.id),
  );
}

export function layoutFormationMarkers(
  markers: readonly FormationMarker[],
  candles: readonly MarkerCandle[],
  geometry: {
    width: number;
    height: number;
    pad: number;
    min: number;
    max: number;
  },
): MarkerLayout[] {
  const { width, height, pad, min, max } = geometry;
  if (!candles.length) return [];
  const slot = (width - 2 * pad) / candles.length;
  const range = max - min || 1;
  return markers.flatMap((marker) => {
    const time = Date.parse(marker.plotAt);
    // End timestamps belong to the bar that closed, not the following bar.
    const index = candles.findIndex(
      (candle) =>
        Date.parse(candle.start) < time && time <= Date.parse(candle.end),
    );
    if (
      index < 0 ||
      (marker.price !== null && (marker.price < min || marker.price > max))
    )
      return [];
    return [
      {
        ...marker,
        x: pad + slot * (index + 0.5),
        y:
          marker.price === null
            ? pad + 8
            : pad + ((max - marker.price) / range) * (height - pad * 2),
      },
    ];
  });
}
