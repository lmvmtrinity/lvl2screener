import {
  type ContextEvaluation,
  type ContextStatus,
  type StrategyName,
  type StrategyState,
} from "@tsx-scanner/contracts";

export const ACTIVE_SETUP_STATES = new Set<StrategyState>([
  "WATCH",
  "FORMING",
  "READY",
]);

export const contextStatusFor = (values: ContextEvaluation[]): ContextStatus =>
  values.some((value) => value.status === "STRONG")
    ? "STRONG"
    : values.some((value) => value.status === "WEAK")
      ? "WEAK"
      : values.some((value) => value.status === "NEUTRAL")
        ? "NEUTRAL"
        : values.some((value) => value.status === "STALE")
          ? "STALE"
          : "UNAVAILABLE";

export const freshness = (timestamp: string | null | undefined) => {
  if (!timestamp) return "NO ANALYSIS";
  const seconds = Math.max(
    0,
    Math.round((Date.now() - Date.parse(timestamp)) / 1000),
  );
  return seconds < 60
    ? `${seconds}s ago`
    : seconds < 3600
      ? `${Math.floor(seconds / 60)}m ago`
      : `${Math.floor(seconds / 3600)}h ago`;
};

/** Relative age from a ticking clock, so an on-screen "12s ago" stays honest
 * without a data fetch. Distinct from `freshness`, which reads Date.now() once. */
export function ago(now: Date, timestamp: string | null | undefined): string {
  if (!timestamp) return "not yet";
  const seconds = Math.max(
    0,
    Math.round((now.getTime() - Date.parse(timestamp)) / 1000),
  );
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function agoFromMs(milliseconds: number | null | undefined): string {
  if (milliseconds === null || milliseconds === undefined) return "not yet";
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

/** Time until a future timestamp, for scheduled automation (session close,
 * next check). "due now" inside the final minute, "overdue" once past. */
export function countdown(
  now: Date,
  timestamp: string | null | undefined,
): string | null {
  if (!timestamp) return null;
  const milliseconds = Date.parse(timestamp) - now.getTime();
  if (Number.isNaN(milliseconds)) return null;
  if (milliseconds <= 0) return "due now";
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 60) return `in ${seconds}s`;
  if (seconds < 3600) return `in ${Math.floor(seconds / 60)}m`;
  return `in ${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

export function localDateTime(date = new Date()): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export const stateClass = (state: string) =>
  `badge badge-${state.toLowerCase().replace("_", "-")}`;

export const displayStrategy = (value: string) => value.replaceAll("_", " ");

export const STRATEGY_OPTIONS: StrategyName[] = [
  "ORB_RETEST",
  "VWAP_HOLD",
  "VWAP_RECLAIM",
  "RSI_VWAP_RECLAIM",
  "HIGH_OF_DAY_BREAKOUT",
  "BULL_FLAG",
  "PRIOR_DAY_HIGH_BREAKOUT",
];

export const fmt = (value: number | null, suffix = "") =>
  value == null ? "—" : `${value.toFixed(2)}${suffix}`;

export function dateInput(date = new Date()): string {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 10);
}
