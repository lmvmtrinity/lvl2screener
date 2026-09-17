import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { OperationalStatus, SystemStatus } from "@tsx-scanner/contracts";
import { HeaderStatus } from "./HeaderStatus.js";
import { derivePaperBotIndicator } from "../lib/paper-bot-status.js";
import type { MarketStatus, PaperBotStatus } from "../types.js";

function operational(
  overrides: Partial<OperationalStatus> = {},
): OperationalStatus {
  return {
    serviceReady: true,
    operationalReady: true,
    actionable: true,
    reasonCodes: [],
    marketDataMode: "live",
    session: { marketStatus: "OPEN", phase: "PREFERRED_ENTRIES" },
    auth: "CONNECTED",
    dataFreshness: {
      quoteAgeMs: 500,
      candleAgeMs: 1_500,
      benchmarkAgeMs: 500,
      evaluationAgeMs: 2_000,
    },
    universe: { configured: 3, resolved: 3, evaluated: 3 },
    benchmarkReady: true,
    scannerSynchronized: true,
    ...overrides,
  };
}

function systemStatus(
  overrides: Partial<OperationalStatus> = {},
): SystemStatus {
  return {
    service: "api",
    status: "ok",
    version: "0.12.0",
    timestamp: new Date().toISOString(),
    mode: "live",
    checks: {
      database: { status: "ok" },
      scanner: { status: "ok" },
      config: { status: "ok" },
      marketData: { status: "ok" },
    },
    operational: operational(overrides),
  };
}

function paperBot(overrides: Partial<PaperBotStatus> = {}): PaperBotStatus {
  return {
    runId: "10000000-0000-4000-8000-000000000501",
    sessionDate: "2026-09-12",
    scheduledCloseAt: null,
    executionModelVersion: null,
    openExecutions: 0,
    closePendingExecutions: 0,
    closedExecutions: 0,
    noFillExecutions: 0,
    reconciliationBacklog: 0,
    unreconcilableEvents: 0,
    overdueRuns: 0,
    abandonedExecutions: 0,
    lastTransitionAt: null,
    lastProcessingDurationMs: 12,
    lastError: null,
    lastSuccessfulProcessingAt: new Date(Date.now() - 5_000).toISOString(),
    ...overrides,
  };
}

function renderStatus({
  system = systemStatus(),
  market = { paperBot: paperBot() } satisfies MarketStatus,
  candidateCount = 2,
  pollError = null,
  marketInactive = null,
}: {
  system?: SystemStatus;
  market?: MarketStatus;
  candidateCount?: number;
  pollError?: string | null;
  marketInactive?: string | null;
} = {}) {
  const botIndicator = derivePaperBotIndicator(market.paperBot);
  return render(
    <HeaderStatus
      system={system}
      market={market}
      connection="LIVE"
      botIndicator={botIndicator}
      candidateCount={candidateCount}
      checkedAt={new Date().toISOString()}
      pollError={pollError}
      marketInactive={marketInactive}
    />,
  );
}

function pill() {
  return screen.getByRole("button", { name: "System status" });
}

function openStatus() {
  fireEvent.click(pill());
}

describe("HeaderStatus", () => {
  afterEach(cleanup);

  it("summarizes a healthy scan in the pill and hides detail until opened", () => {
    renderStatus();
    expect(pill()).toHaveClass("tone-ok");
    expect(pill()).toHaveTextContent("LIVE · OPEN");
    expect(screen.queryByText(/Scanning normally/)).not.toBeInTheDocument();

    openStatus();
    expect(screen.getByText(/Scanning normally/)).toBeInTheDocument();
    expect(screen.getByText("STATUS")).toBeInTheDocument();
    expect(screen.getByText("LAST CYCLE")).toBeInTheDocument();
    expect(screen.getByText("EVIDENCE")).toBeInTheDocument();
    expect(screen.getByText("QUOTES")).toBeInTheDocument();
    expect(screen.getByText("CANDLES")).toBeInTheDocument();
    expect(screen.getByText("ENGINE")).toBeInTheDocument();
    expect(screen.getByText("BENCHMARKS")).toBeInTheDocument();
    expect(screen.getByText("SIGNALS · READY")).toBeInTheDocument();
    expect(
      screen.getByText(/UNIVERSE · 3\/3 resolved · 3\/3 evaluated/),
    ).toBeInTheDocument();
  });

  it("describes a closed market as healthy waiting, not a failure", () => {
    renderStatus({
      system: systemStatus({ reasonCodes: ["MARKET_CLOSED"] }),
      candidateCount: 0,
    });
    expect(pill()).toHaveClass("tone-waiting");
    expect(pill()).not.toHaveClass("tone-error");
    expect(pill()).toHaveTextContent("MARKET CLOSED");

    openStatus();
    expect(
      screen.getByText(/Waiting for market open · Collection resumes/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/The next session starts automatically/),
    ).toBeInTheDocument();
  });

  it("explains an empty universe as a user action without implying a refresh fixes it", () => {
    renderStatus({
      system: systemStatus({ reasonCodes: ["EMPTY_UNIVERSE"] }),
      candidateCount: 0,
    });
    expect(pill()).toHaveClass("tone-attention");
    expect(pill()).toHaveTextContent("NO SYMBOLS");

    openStatus();
    expect(
      screen.getByText(/No symbols configured · Nothing can be evaluated yet/),
    ).toBeInTheDocument();
    expect(screen.getByText(/paste today's scan/)).toBeInTheDocument();
  });

  it("promotes bot backlog counts into explicit attention lines", () => {
    renderStatus({
      market: {
        paperBot: paperBot({
          overdueRuns: 2,
          funded: {
            pendingFacts: 4,
            oldestPendingFactAgeMs: 90_000,
            recoveryFailuresTotal: 3,
          },
        }),
      },
    });
    openStatus();
    expect(
      screen.getByText(/2 earlier runs are past session close/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/3 funded recovery attempts failed/),
    ).toBeInTheDocument();
  });

  it("surfaces a bot processing error in both the pill and the detail", () => {
    renderStatus({
      market: {
        paperBot: paperBot({ lastError: "quote size unit unknown" }),
      },
    });
    expect(pill()).toHaveClass("tone-error");
    expect(pill()).toHaveTextContent("ERROR");

    openStatus();
    expect(
      screen.getAllByText(/quote size unit unknown/).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getByText(/Open BOT for the failing run/),
    ).toBeInTheDocument();
  });

  it("surfaces a failed status check instead of letting the last state look fresh", () => {
    renderStatus({ pollError: "network down" });
    expect(pill()).toHaveClass("tone-attention");
    expect(pill()).toHaveTextContent("STATUS FAILING");

    openStatus();
    expect(screen.getByText(/Status checks are failing/)).toBeInTheDocument();
    expect(screen.getByText(/Reconnecting automatically/)).toBeInTheDocument();
  });

  it("distinguishes a market absent from this runtime from a broken status check", () => {
    renderStatus({ marketInactive: "US_EQUITIES" });
    expect(pill()).toHaveClass("tone-attention");
    expect(pill()).toHaveTextContent("MARKET INACTIVE");

    openStatus();
    expect(
      screen.getByText(/US_EQUITIES is not active in this runtime/),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Status checks are failing/),
    ).not.toBeInTheDocument();
  });

  it("names the waiting reason and marks signals gated", () => {
    renderStatus({
      system: systemStatus({
        actionable: false,
        reasonCodes: ["DATA_STALE"],
        dataFreshness: {
          quoteAgeMs: 120_000,
          candleAgeMs: 120_000,
          benchmarkAgeMs: 500,
          evaluationAgeMs: 2_000,
        },
      }),
      candidateCount: 0,
    });
    expect(pill()).toHaveTextContent("DATA STALE");

    openStatus();
    expect(screen.getByText(/Market data is stale/)).toBeInTheDocument();
    expect(screen.getByText(/retries every cycle/)).toBeInTheDocument();
    expect(screen.getByText("SIGNALS · GATED")).toBeInTheDocument();
  });

  it("collapses a session status that repeats as its phase", () => {
    renderStatus({
      system: systemStatus({
        session: { marketStatus: "AFTER_HOURS", phase: "AFTER_HOURS" },
      }),
    });
    expect(pill()).toHaveTextContent("LIVE · AFTER HOURS");

    openStatus();
    expect(screen.getByText("SESSION · AFTER HOURS")).toBeInTheDocument();
    expect(
      screen.queryByText(/AFTER HOURS · AFTER HOURS/),
    ).not.toBeInTheDocument();
  });
});
