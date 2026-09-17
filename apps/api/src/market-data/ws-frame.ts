/**
 * W6b: building and suppressing the WebSocket snapshot frame sent to browsers.
 * Pulled out of `app.ts` so the size/suppression/sequencing behavior is unit
 * testable without spinning up a real Fastify + WebSocket connection.
 */

// Per-cycle timing/telemetry fields on `MarketDataServiceSnapshot` (see
// `service.ts`). These already surface on `/metrics` for operators (W6) and
// have no rendering purpose in the browser — worse, because they change every
// broadcast cycle regardless of whether anything a user cares about changed,
// embedding them in the WebSocket frame defeated change-detection before it
// could even be added: every frame differed purely because of these values.
// Stripped here, not in `getSnapshot()` itself, so `/metrics` and any other
// internal caller keep seeing them.
export const WS_BROADCAST_TELEMETRY_FIELDS = [
  "lastCycleDurationMs",
  "lastEngineDurationMs",
  "lastFeatureDurationMs",
  "lastEvaluationDurationMs",
  "lastEvaluationAgeMs",
] as const;

export function stripBroadcastTelemetry(snapshot: unknown): unknown {
  if (!snapshot || typeof snapshot !== "object") return snapshot;
  const trimmed = { ...(snapshot as Record<string, unknown>) };
  for (const field of WS_BROADCAST_TELEMETRY_FIELDS) delete trimmed[field];
  return trimmed;
}

// Nested per-cycle timestamps/latencies/counters that change on every funded
// processing cycle (or server clock tick) without changing anything the board
// displays. They remain in transmitted frames — the paper-bot health indicator
// reads several of them — but are excluded from change detection, otherwise the
// browser is re-rendered every two seconds even with the market closed.
export const WS_BROADCAST_VOLATILE_FIELD_PATHS = [
  ["session", "observedAt"],
  ["paperBot", "lastProcessingDurationMs"],
  ["paperBot", "lastSuccessfulProcessingAt"],
  ["paperBot", "fundedLastSuccessfulProcessingAt"],
  ["paperBot", "funded", "lastCycleLatencyMs"],
  ["paperBot", "funded", "coverageGapsTotal"],
] as const;

/** Copies only along the listed paths, deleting the volatile leaves. The input
 * snapshot is never mutated; unlisted branches are shared by reference because
 * callers only serialize the result. */
export function omitBroadcastVolatile(snapshot: unknown): unknown {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot))
    return snapshot;
  const root = { ...(snapshot as Record<string, unknown>) };
  for (const path of WS_BROADCAST_VOLATILE_FIELD_PATHS) {
    let current: Record<string, unknown> = root;
    let complete = true;
    for (const key of path.slice(0, -1)) {
      const child = current[key];
      if (child === null || typeof child !== "object" || Array.isArray(child)) {
        complete = false;
        break;
      }
      const copy = { ...(child as Record<string, unknown>) };
      current[key] = copy;
      current = copy;
    }
    if (complete) delete current[path[path.length - 1]!];
  }
  return root;
}

// Bumped only if the WS frame shape changes in a way a client should key off
// of. Sent alongside `seq` on every frame so a client can distinguish "the
// protocol changed" from "frames were suppressed or a reconnect happened".
export const WS_PROTOCOL_VERSION = 1;

// The browser only renders the newest alerts and the REST bootstrap fetches 100;
// the retained buffer holds 200, so the socket sends the same bounded window
// instead of the full buffer on every frame.
export const WS_BROADCAST_ALERT_LIMIT = 100;

/** Newest-first selection; the alert buffer already stores entries newest-first. */
export function selectBroadcastAlerts<T>(
  alerts: readonly T[],
  limit = WS_BROADCAST_ALERT_LIMIT,
): T[] {
  return alerts.slice(0, Math.max(0, limit));
}

export interface SnapshotFrameInput {
  type: "snapshot";
  timestamp: string;
  market: unknown;
  universe: unknown;
  candidates: unknown;
  contexts: unknown;
  alerts: unknown;
}

export interface SnapshotFrameResult {
  /** Serialized JSON frame ready to send over the socket. Absent when this
   *  cycle's content is byte-identical to the last frame actually sent to
   *  this connection and was suppressed instead. */
  json?: string;
  suppressed: boolean;
}

/**
 * One instance per WebSocket connection. A fresh instance (a new connection —
 * initial load or a post-drop reconnect) starts with no prior frame to compare
 * against, so its first `next()` call is never suppressed: the client always
 * gets a full snapshot on connect/reconnect rather than inheriting suppression
 * (or sequence) state from a previous socket.
 */
export function createSnapshotBroadcaster() {
  let lastPayload: string | undefined;
  // Ticks every call regardless of whether a frame is actually sent, so `seq`
  // on the next transmitted frame reveals how many cycles were suppressed in
  // between (a benign gap: nothing changed) versus a `seq` that resets low (a
  // new connection — not a gap at all, see above).
  let cycle = 0;

  return {
    next(input: SnapshotFrameInput): SnapshotFrameResult {
      cycle += 1;
      // The frame timestamp changes every cycle, so it must stay out of the
      // comparison payload or suppression would never trigger. It is spliced
      // into frames actually sent, next to `seq`/`version`.
      const market = stripBroadcastTelemetry(input.market);
      const body = {
        type: input.type,
        market,
        universe: input.universe,
        candidates: input.candidates,
        contexts: input.contexts,
        alerts: input.alerts,
      };
      // Compare the user-visible projection: per-cycle timestamps, latencies and
      // cumulative counters are sent on real frames but never trigger one.
      const comparison = JSON.stringify({
        ...body,
        market: omitBroadcastVolatile(market),
      });
      if (comparison === lastPayload) return { suppressed: true };
      lastPayload = comparison;
      const payload = JSON.stringify(body);
      // `payload` always ends in `}` (an object literal): splice the
      // per-send fields in rather than re-stringifying the whole (potentially
      // ~1MB) frame a second time.
      return {
        json: `${payload.slice(0, -1)},"timestamp":${JSON.stringify(input.timestamp)},"seq":${cycle},"version":${WS_PROTOCOL_VERSION}}`,
        suppressed: false,
      };
    },
  };
}
