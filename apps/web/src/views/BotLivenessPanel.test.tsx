import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  BotLivenessDiagnostics,
  BotLivenessPanel,
} from "./BotLivenessPanel.js";
import type { PaperBotStatus } from "../types.js";

function paperBot(overrides: Partial<PaperBotStatus> = {}): PaperBotStatus {
  return {
    runId: "10000000-0000-4000-8000-000000000501",
    sessionDate: "2026-09-12",
    scheduledCloseAt: new Date(Date.now() + 3_600_000).toISOString(),
    executionModelVersion: "paper-execution-v7",
    openExecutions: 1,
    closePendingExecutions: 0,
    closedExecutions: 2,
    noFillExecutions: 0,
    reconciliationBacklog: 0,
    unreconcilableEvents: 0,
    overdueRuns: 0,
    abandonedExecutions: 0,
    lastTransitionAt: null,
    lastProcessingDurationMs: 14,
    lastError: null,
    lastSuccessfulProcessingAt: new Date(Date.now() - 12_000).toISOString(),
    fundedLastSuccessfulProcessingAt: new Date(
      Date.now() - 60_000,
    ).toISOString(),
    funded: {
      pendingFacts: 4,
      oldestPendingFactAgeMs: 90_000,
      closePendingOrders: 2,
      oldestClosePendingAgeMs: 3_600_000,
      riskVetoesTotal: 1,
      coverageGapsTotal: 0,
      recoveryFailuresTotal: 0,
      lastCycleLatencyMs: 45,
    },
    ...overrides,
  };
}

describe("BotLivenessPanel", () => {
  afterEach(cleanup);

  it("summarizes last success and unresolved work without raw telemetry", () => {
    render(<BotLivenessPanel paperBot={paperBot()} />);

    expect(screen.getByText("LAST SUCCESSFUL PROCESSING")).toBeInTheDocument();
    expect(screen.getByText("UNRESOLVED WORK")).toBeInTheDocument();
    expect(
      screen.getByText(/4 pending facts · 2 close-pending orders/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Funded cycle/)).toBeInTheDocument();
    expect(screen.getByText(/SESSION CLOSES/)).toBeInTheDocument();
    // Timings, identifiers and detailed counters stay out of the summary.
    expect(screen.queryByText("LAST PAPER CYCLE")).not.toBeInTheDocument();
    expect(screen.queryByText(/took 14 ms/)).not.toBeInTheDocument();
    expect(screen.queryByText(/RUN 10000000/)).not.toBeInTheDocument();
    expect(screen.queryByText(/oldest 1m ago/)).not.toBeInTheDocument();
  });

  it("keeps overlapping recovery counts separate from the completed batch", () => {
    const { rerender } = render(
      <BotLivenessPanel
        paperBot={paperBot({
          reconciliationBacklog: 10,
          unreconcilableEvents: 1,
          overdueRuns: 2,
        })}
      />,
    );
    expect(screen.getByText("Work pending")).toBeInTheDocument();
    expect(
      screen.getByText("1 stuck event · 2 overdue runs"),
    ).toBeInTheDocument();
    expect(screen.queryByText("19")).not.toBeInTheDocument();

    rerender(
      <BotLivenessPanel
        paperBot={paperBot({
          reconciliationBacklog: 10,
          funded: { pendingFacts: 0, closePendingOrders: 0 },
        })}
      />,
    );
    expect(screen.getByText("No reported backlog")).toBeInTheDocument();
    expect(screen.queryByText("Work pending")).not.toBeInTheDocument();
  });

  it("keeps processing errors visible instead of only in Diagnostics", () => {
    render(
      <BotLivenessPanel
        paperBot={paperBot({ lastError: "funded recovery failed" })}
      />,
    );
    expect(
      screen.getByText(
        /Last processing error \(independent or funded\) · funded recovery failed/,
      ),
    ).toBeInTheDocument();
  });

  it("raises account-wide funded failures in the summary", () => {
    render(
      <BotLivenessPanel
        paperBot={paperBot({
          funded: { ...paperBot().funded!, recoveryFailuresTotal: 3 },
        })}
      />,
    );
    expect(screen.getByText("FUNDED FAILURES")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("states that no run is open rather than showing a countdown", () => {
    render(
      <BotLivenessPanel
        paperBot={paperBot({
          runId: null,
          scheduledCloseAt: null,
          lastSuccessfulProcessingAt: null,
        })}
      />,
    );
    expect(screen.getByText("NO OPEN RUN")).toBeInTheDocument();
    expect(screen.getByText(/not yet/)).toBeInTheDocument();
  });
});

describe("BotLivenessDiagnostics", () => {
  afterEach(cleanup);

  it("keeps cycle timings, counters and run identity out of the Overview", () => {
    render(<BotLivenessDiagnostics paperBot={paperBot()} />);

    expect(screen.getByText("LAST PAPER CYCLE")).toBeInTheDocument();
    expect(screen.getByText("LAST FUNDED CYCLE")).toBeInTheDocument();
    expect(screen.getByText("PENDING FACTS")).toBeInTheDocument();
    expect(screen.getByText("CLOSE-PENDING ORDERS")).toBeInTheDocument();
    expect(screen.getByText("LAST RECONCILIATION BATCH")).toBeInTheDocument();
    expect(screen.getByText("FUNDED FAILURES")).toBeInTheDocument();
    expect(screen.getByText(/took 14 ms/)).toBeInTheDocument();
    expect(screen.getByText(/oldest 1m ago/)).toBeInTheDocument();
    expect(screen.getByText(/RUN 10000000/)).toBeInTheDocument();
    expect(
      screen.getByText(/across every run, not only the current one/),
    ).toBeInTheDocument();
  });

  it("keeps processing errors visible in Diagnostics too", () => {
    render(
      <BotLivenessDiagnostics
        paperBot={paperBot({ lastError: "funded recovery failed" })}
      />,
    );
    expect(
      screen.getByText(/Last processing error \(independent or funded\)/),
    ).toBeInTheDocument();
  });
});
