import type { PaperBotStatus } from "../types.js";

/**
 * At-a-glance health of the paper-trading bot for the market bar.
 *
 * The bot runs unattended on the market-data cycle, so the failure that
 * matters is the silent one: a healthy-looking process that has stopped
 * turning READY events into evidence. private development record
 * ("Failure visibility") lists what has to be legible before commissioning --
 * reconciliation backlog, open and close-pending counts, the last successful
 * transition, processing errors, and the model version. This reduces those to
 * one severity plus a one-line reason, and keeps the detail for the tooltip.
 */
export type PaperBotIndicatorTone = "ok" | "attention" | "error" | "idle";

export interface PaperBotIndicator {
  readonly tone: PaperBotIndicatorTone;
  /** Short uppercase word rendered next to the dot. */
  readonly label: string;
  /** One sentence naming the current state and, when unhealthy, its cause. */
  readonly summary: string;
  /** Supporting counts, already formatted, for the tooltip body. */
  readonly detail: string[];
}

const plural = (count: number, noun: string) =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

function detailLines(paperBot: PaperBotStatus): string[] {
  const lines: string[] = [];
  if (paperBot.sessionDate) lines.push(`Session ${paperBot.sessionDate}`);
  if (paperBot.executionModelVersion)
    lines.push(`Model ${paperBot.executionModelVersion}`);
  if (paperBot.openExecutions !== null)
    lines.push(
      `${paperBot.openExecutions} open · ${paperBot.closePendingExecutions ?? 0} close-pending · ${paperBot.closedExecutions ?? 0} closed · ${paperBot.noFillExecutions ?? 0} no-fill · ${paperBot.rejectedEconomicsExecutions ?? 0} economics-rejected`,
    );
  if (paperBot.abandonedExecutions)
    lines.push(
      `${plural(paperBot.abandonedExecutions, "execution")} abandoned past the close horizon`,
    );
  if (paperBot.unresolvedCoordinatedPositions)
    lines.push(
      `${plural(paperBot.unresolvedCoordinatedPositions, "coordinated position")} unresolved${paperBot.oldestUnresolvedCoordinatedAgeMs === null || paperBot.oldestUnresolvedCoordinatedAgeMs === undefined ? "" : ` · oldest ${Math.floor(paperBot.oldestUnresolvedCoordinatedAgeMs / 3_600_000)}h`}`,
    );
  if (paperBot.unknownQuoteSizeUnits)
    lines.push(
      `${plural(paperBot.unknownQuoteSizeUnits, "latest quote")} has an unknown size unit`,
    );
  if (paperBot.lastTransitionAt)
    lines.push(
      `Last transition ${new Date(paperBot.lastTransitionAt).toLocaleTimeString()}`,
    );
  if (paperBot.lastProcessingDurationMs !== null)
    lines.push(`Paper stage ${paperBot.lastProcessingDurationMs} ms`);
  if (paperBot.lastSuccessfulProcessingAt)
    lines.push(
      `Last successful paper cycle ${new Date(paperBot.lastSuccessfulProcessingAt).toLocaleTimeString()}`,
    );
  if (paperBot.funded?.pendingFacts)
    lines.push(
      `${paperBot.funded.pendingFacts} funded facts pending${paperBot.funded.oldestPendingFactAgeMs == null ? "" : ` · oldest ${Math.floor(paperBot.funded.oldestPendingFactAgeMs / 1000)}s`}`,
    );
  if (paperBot.fundedProcessing)
    lines.push("Funded recovery batch running; live collection continues");
  return lines;
}

/**
 * Severity is ordered worst-first: an error outranks a stuck event, which
 * outranks an overdue run. Anything unresolved is surfaced even while the
 * bot is otherwise collecting normally, because a partial failure is exactly
 * the state that would otherwise pass for healthy.
 */
export function derivePaperBotIndicator(
  paperBot: PaperBotStatus | undefined,
): PaperBotIndicator {
  if (!paperBot) {
    return {
      tone: "idle",
      label: "OFF",
      summary:
        "The paper bot is not wired into this process, so no forward evidence is being collected.",
      detail: [],
    };
  }

  const detail = detailLines(paperBot);

  if (paperBot.lastError) {
    return {
      tone: "error",
      label: "ERROR",
      summary: `The last paper-processing cycle failed: ${paperBot.lastError}`,
      detail,
    };
  }

  if ((paperBot.unknownQuoteSizeUnits ?? 0) > 0) {
    return {
      tone: "error",
      label: "SIZE UNIT",
      summary: `${plural(paperBot.unknownQuoteSizeUnits ?? 0, "latest quote")} has an unknown size unit. Coordinated sizing is fail-closed.`,
      detail,
    };
  }

  if (!paperBot.runId) {
    return {
      tone: "idle",
      label: "IDLE",
      summary:
        "No live run is open yet. The bot starts one once market data initializes, so this usually means the feed is not authenticated or the process has just started.",
      detail,
    };
  }

  if (paperBot.unreconcilableEvents > 0) {
    return {
      tone: "error",
      label: "STUCK",
      summary: `${plural(paperBot.unreconcilableEvents, "READY event")} cannot be turned into evidence and will be retried forever. Check the PAPER_BOT_EVENT_UNRECONCILABLE logs.`,
      detail,
    };
  }

  if ((paperBot.completedRunsWithUnresolvedCoordinatedPositions ?? 0) > 0) {
    return {
      tone: "error",
      label: "ORPHAN",
      summary: `${plural(paperBot.completedRunsWithUnresolvedCoordinatedPositions ?? 0, "completed run")} still owns an unresolved coordinated position. New coordinated approvals are blocked.`,
      detail,
    };
  }

  if (paperBot.overdueRuns > 0) {
    return {
      tone: "attention",
      label: "OVERDUE",
      summary: `${plural(paperBot.overdueRuns, "earlier run")} is past its session close and still waiting for an actionable bid.`,
      detail,
    };
  }

  if (paperBot.funded?.pendingFacts) {
    return {
      tone: "attention",
      label: "CATCHING UP",
      summary: `${paperBot.funded.pendingFacts} funded facts await processing. Live collection continues independently.`,
      detail,
    };
  }
  if (paperBot.reconciliationBacklog) {
    return {
      tone: "attention",
      label: "CATCHING UP",
      summary: `${plural(paperBot.reconciliationBacklog, "READY event")} is still missing complete paper evidence and is being repaired.`,
      detail,
    };
  }

  if (paperBot.lastSuccessfulProcessingAt === null) {
    return {
      tone: "idle",
      label: "STARTING",
      summary: "Waiting for the first successful paper-processing cycle.",
      detail,
    };
  }

  const live =
    (paperBot.openExecutions ?? 0) + (paperBot.closePendingExecutions ?? 0);
  return {
    tone: "ok",
    label: live > 0 ? `LIVE ${live}` : "LIVE",
    summary:
      live > 0
        ? `Collecting forward evidence. ${plural(live, "execution")} still unresolved and therefore excluded from closed-trade performance.`
        : "Collecting forward evidence. Nothing is currently unresolved.",
    detail,
  };
}
