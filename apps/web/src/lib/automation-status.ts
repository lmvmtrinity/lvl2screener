import type {
  OperationalReasonCode,
  SystemStatus,
} from "@tsx-scanner/contracts";
import type { MarketStatus, PaperBotStatus } from "../types.js";
import type { PaperBotIndicator } from "./paper-bot-status.js";

/** Automation health for the shared shell row. Tone separates an ordinary wait
 * from something the user has to look at: a market that is simply closed must
 * never render the same as a pipeline that failed. */
export type AutomationTone = "ok" | "waiting" | "attention" | "error";

export interface ReasonCopy {
  readonly tone: AutomationTone;
  /** What automation is doing now, in plain language. */
  readonly headline: string;
  /** Two or three words for the header pill, where the full headline does not fit. */
  readonly short: string;
  /** The next automatic action. Absent only when the user genuinely must act. */
  readonly next: string | null;
}

const REASON_COPY: Record<OperationalReasonCode, ReasonCopy> = {
  SERVICE_STARTING: {
    tone: "waiting",
    headline: "Starting up · Automation begins once dependencies are ready.",
    short: "STARTING",
    next: "Startup continues automatically; no action needed.",
  },
  SCANNER_UNAVAILABLE: {
    tone: "error",
    headline: "Scanner engine unavailable · Feature evaluation is paused.",
    short: "ENGINE UNAVAILABLE",
    next: "The API retries the engine connection automatically.",
  },
  DATABASE_UNAVAILABLE: {
    tone: "error",
    headline: "Database unavailable · Durable evidence writes are paused.",
    short: "DATABASE UNAVAILABLE",
    next: "The API retries the database connection automatically.",
  },
  AUTH_REQUIRED: {
    tone: "attention",
    headline: "Broker sign-in required · Market data collection is paused.",
    short: "SIGN-IN REQUIRED",
    next: "Reconnect Questrade; collection resumes automatically after sign-in.",
  },
  MARKET_CLOSED: {
    tone: "waiting",
    headline:
      "Waiting for market open · Collection resumes at the next session.",
    short: "MARKET CLOSED",
    next: "The next session starts automatically; no action needed now.",
  },
  EMPTY_UNIVERSE: {
    tone: "attention",
    headline: "No symbols configured · Nothing can be evaluated yet.",
    short: "NO SYMBOLS",
    next: "Open Daily List and paste today's scan to start the engine.",
  },
  WAITING_FOR_CANDIDATES: {
    tone: "waiting",
    headline: "List loaded · Waiting for the engine's first evaluations.",
    short: "WARMING UP",
    next: "Evaluation continues automatically as quotes arrive.",
  },
  BENCHMARKS_UNRESOLVED: {
    tone: "waiting",
    headline: "Resolving benchmark context · Context stays gated until ready.",
    short: "BENCHMARKS PENDING",
    next: "Benchmarks resolve automatically during collection.",
  },
  DATA_STALE: {
    tone: "attention",
    headline: "Market data is stale · Signals stay gated until quotes refresh.",
    short: "DATA STALE",
    next: "The collector retries every cycle; no manual refresh needed.",
  },
  SCANNER_OUT_OF_SYNC: {
    tone: "waiting",
    headline: "Engine warming up · Evaluations resume when versions match.",
    short: "ENGINE SYNCING",
    next: "Version synchronization completes automatically.",
  },
};

/** Worst-first. A database outage outranks a closed market even when both are
 * reported; the remaining codes are ordered so the most user-visible cause of
 * an empty board wins. */
const REASON_PRIORITY: OperationalReasonCode[] = [
  "DATABASE_UNAVAILABLE",
  "SCANNER_UNAVAILABLE",
  "SCANNER_OUT_OF_SYNC",
  "DATA_STALE",
  "AUTH_REQUIRED",
  "BENCHMARKS_UNRESOLVED",
  "EMPTY_UNIVERSE",
  "WAITING_FOR_CANDIDATES",
  "SERVICE_STARTING",
  "MARKET_CLOSED",
];

export function primaryReason(
  codes: readonly OperationalReasonCode[],
): OperationalReasonCode | null {
  for (const code of REASON_PRIORITY) if (codes.includes(code)) return code;
  return codes[0] ?? null;
}

export function reasonCopy(code: OperationalReasonCode): ReasonCopy {
  return REASON_COPY[code];
}

/** Copy for an empty candidate board whose cause is automation state, not the
 * user's filters. Returns null when actionability is healthy. */
export function emptyBoardMessage(
  codes: readonly OperationalReasonCode[],
): string | null {
  if (codes.length === 0) return null;
  const copy = reasonCopy(primaryReason(codes)!);
  return copy.next ? `${copy.headline} ${copy.next}` : copy.headline;
}

export function sessionLabel(
  operational: SystemStatus["operational"] | undefined,
  market: MarketStatus | undefined,
): string | null {
  const marketStatus =
    operational?.session?.marketStatus ?? market?.session?.marketStatus;
  const phase = operational?.session?.phase ?? market?.session?.phase;
  if (!marketStatus) return null;
  const status = marketStatus.replaceAll("_", " ");
  const phaseText = phase?.replaceAll("_", " ");
  return [status, phaseText && phaseText !== status ? phaseText : null]
    .filter(Boolean)
    .join(" · ");
}

export function universeLabel(
  operational: SystemStatus["operational"] | undefined,
): string | null {
  if (!operational || operational.universe.configured === 0) return null;
  const { configured, resolved, evaluated } = operational.universe;
  return `${resolved}/${configured} resolved · ${evaluated}/${configured} evaluated`;
}

/** Issues worth surfacing outside the single headline. Returns already
 * human-readable lines; empty means nothing needs review. */
export function attentionLines(
  paperBot: PaperBotStatus | undefined,
  market: MarketStatus | undefined,
): string[] {
  const lines: string[] = [];
  if (market?.lastError)
    lines.push(`Last market-data error: ${market.lastError}`);
  if (paperBot?.lastError)
    lines.push(`Last paper-processing error: ${paperBot.lastError}`);
  if ((paperBot?.unreconcilableEvents ?? 0) > 0)
    lines.push(
      `${paperBot!.unreconcilableEvents} READY event${paperBot!.unreconcilableEvents === 1 ? "" : "s"} cannot become evidence and keep retrying.`,
    );
  if ((paperBot?.unknownQuoteSizeUnits ?? 0) > 0)
    lines.push(
      `${paperBot!.unknownQuoteSizeUnits} quote${paperBot!.unknownQuoteSizeUnits === 1 ? "" : "s"} has an unknown size unit; coordinated sizing is paused.`,
    );
  if ((paperBot?.completedRunsWithUnresolvedCoordinatedPositions ?? 0) > 0)
    lines.push(
      `${paperBot!.completedRunsWithUnresolvedCoordinatedPositions} completed run${paperBot!.completedRunsWithUnresolvedCoordinatedPositions === 1 ? "" : "s"} still owns an unresolved coordinated position.`,
    );
  if ((paperBot?.overdueRuns ?? 0) > 0) {
    const count = paperBot!.overdueRuns;
    lines.push(
      `${count} earlier run${count === 1 ? "" : "s"} ${count === 1 ? "is" : "are"} past session close and still waiting on an exit.`,
    );
  }
  if ((paperBot?.funded?.recoveryFailuresTotal ?? 0) > 0)
    lines.push(
      `${paperBot!.funded!.recoveryFailuresTotal} funded recovery attempt${paperBot!.funded!.recoveryFailuresTotal === 1 ? "" : "s"} failed; retries continue.`,
    );
  return lines;
}

export interface AutomationStatusView {
  tone: AutomationTone;
  headline: string;
  /** Next automatic action; null when nothing further is scheduled. */
  next: string | null;
  attention: string[];
  reasons: OperationalReasonCode[];
  /** Compact detail shown after the connection state in the header pill. */
  pillLabel: string | null;
  session: string | null;
  universe: string | null;
  bot: string;
  /** Last successful automation cycle for the selected market (paper bot). */
  lastCycleAt: string | null;
  /** Age of the newest strategy evaluation, as reported by the status API. */
  evidenceAgeMs: number | null;
}

export function deriveAutomationStatus({
  system,
  market,
  connection,
  botIndicator,
  candidateCount,
  pollError,
  marketInactive,
}: {
  system?: SystemStatus;
  market?: MarketStatus;
  connection: "LIVE" | "RECONNECTING";
  botIndicator: PaperBotIndicator;
  candidateCount: number;
  pollError: string | null;
  /** Set when the API reports the selected market is not enabled in this runtime. */
  marketInactive?: string | null;
}): AutomationStatusView {
  const operational = system?.operational;
  const reasons = operational?.reasonCodes ?? [];
  const attention = attentionLines(market?.paperBot, market);

  let tone: AutomationTone = "ok";
  let headline =
    candidateCount === 0
      ? "Scanning normally · No setups currently meet the rules."
      : `Scanning normally · ${candidateCount} evaluation${candidateCount === 1 ? "" : "s"} on the board.`;
  let next: string | null =
    candidateCount === 0 ? "The engine re-evaluates every two seconds." : null;

  if (reasons.length > 0) {
    const copy = reasonCopy(primaryReason(reasons)!);
    tone = copy.tone;
    headline = copy.headline;
    next = copy.next;
  } else if (marketInactive) {
    tone = "attention";
    headline = `${marketInactive} is not active in this runtime · Collection is stopped for this market.`;
    next =
      "Switch markets or enable the runtime; the rest of the API is unaffected.";
  } else if (connection === "RECONNECTING" || pollError) {
    tone = "attention";
    headline =
      connection === "RECONNECTING"
        ? "Live stream reconnecting · Showing the last known snapshot."
        : "Status checks are failing · Showing the last known state.";
    next = "Reconnecting automatically; no manual refresh needed.";
  } else if (botIndicator.tone === "error") {
    tone = "error";
    headline = botIndicator.summary;
    next = "Open BOT for the failing run and its recovery state.";
  } else if (botIndicator.tone === "attention") {
    tone = "attention";
    headline = botIndicator.summary;
    next = "Recovery continues automatically; BOT shows the backlog.";
  } else if (!operational) {
    tone = "waiting";
    headline =
      "Waiting for the first status response · The board shows bootstrap data until then.";
    next = "Status is checked automatically every 15 seconds.";
  }

  const session = sessionLabel(operational, market);
  const pillLabel =
    reasons.length > 0
      ? reasonCopy(primaryReason(reasons)!).short
      : marketInactive
        ? "MARKET INACTIVE"
        : botIndicator.tone === "error" || botIndicator.tone === "attention"
          ? botIndicator.label
          : pollError
            ? "STATUS FAILING"
            : !operational
              ? "STARTING"
              : (session?.split(" · ")[0] ?? null);

  return {
    tone,
    headline,
    next,
    attention,
    reasons,
    pillLabel,
    session,
    universe: universeLabel(operational),
    bot: botIndicator.label,
    lastCycleAt: market?.paperBot?.lastSuccessfulProcessingAt ?? null,
    evidenceAgeMs: operational?.dataFreshness.evaluationAgeMs ?? null,
  };
}
