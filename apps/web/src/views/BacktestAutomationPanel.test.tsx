import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BacktestAutomationPanel } from "./BacktestAutomationPanel.js";

const now = "2026-09-10T21:00:00.000Z";

function work(overrides: Record<string, unknown>) {
  return {
    workKey: "a".repeat(64),
    marketId: "CA_TSX",
    kind: "PROFILE_QUALIFICATION",
    configId: "10000000-0000-4000-8000-000000000098",
    configName: "Bull Flag",
    configVersion: "profile-bull-flag-v1",
    strategyKey: "BULL_FLAG",
    state: "SUCCEEDED",
    triggerOrigin: "SCHEDULED_CATCH_UP",
    blockerReason: null,
    inputFingerprint: "b".repeat(64),
    consumedFingerprint: "b".repeat(64),
    attemptKey: "c".repeat(64),
    jobId: null,
    jobStatus: null,
    runId: "20000000-0000-4000-8000-000000000001",
    evaluatedThrough: "2026-09-10",
    retryCount: 0,
    nextAttemptAt: null,
    lastDispatchedAt: "2026-09-10T20:00:00.000Z",
    lastSuccessAt: "2026-09-10T20:05:00.000Z",
    lastFailureAt: null,
    waitingSince: null,
    startedAt: null,
    heartbeatAt: null,
    progress: null,
    runDurationMs: 1_560_000,
    failureMessage: null,
    inputChanged: false,
    updatedAt: now,
    ...overrides,
  };
}

const stage = {
  stageKey: "TRAINING",
  workKey: "a".repeat(64),
  marketId: "CA_TSX",
  configId: "10000000-0000-4000-8000-000000000098",
  configName: "Bull Flag",
  state: "WAITING_FOR_EVIDENCE",
  authorizationScope: "QUALIFICATION_OWNED",
  reasonCodes: ["PAPER_QUALIFICATION_REQUIRED"],
  inputIdentityHash: "f".repeat(64),
  jobId: null,
  jobStatus: null,
  retryCount: 0,
  nextAttemptAt: null,
  failureMessage: null,
  lastEvaluatedAt: now,
  completedAt: null,
  updatedAt: now,
};

const policy = {
  policyId: "40000000-0000-4000-8000-000000000001",
  policyHash: "9".repeat(64),
  marketId: "CA_TSX",
  scope: {
    kind: "PROFILE_CONFIG",
    configId: "10000000-0000-4000-8000-000000000098",
    configVersion: "profile-bull-flag-v1",
  },
  maxSessions: 5,
  approvedBy: "operator",
  approvalNote: "Bounded funded replay comparison",
  approvedAt: "2026-09-10T20:00:00.000Z",
  expiresAt: "2099-10-10T20:00:00.000Z",
  revokedAt: null,
  revokedBy: null,
  revokedReason: null,
};

const running = work({
  workKey: "1".repeat(64),
  configId: "10000000-0000-4000-8000-000000000010",
  configName: "ORB Standard",
  configVersion: "profile-orb-standard-v1",
  strategyKey: "ORB_RETEST",
  state: "QUEUED",
  jobId: "50000000-0000-4000-8000-000000000001",
  jobStatus: "RUNNING",
  lastSuccessAt: null,
  runDurationMs: null,
  startedAt: "2026-09-10T20:37:00.000Z",
  heartbeatAt: "2026-09-10T20:59:48.000Z",
  progress: {
    totalSessions: 9,
    completedSessions: 7,
    message: "Loading session 2026-09-10",
  },
});

const queued = work({
  workKey: "2".repeat(64),
  configId: "10000000-0000-4000-8000-000000000011",
  configName: "VWAP Hold",
  configVersion: "profile-vwap-hold-v1",
  strategyKey: "VWAP_HOLD",
  state: "QUEUED",
  jobId: "50000000-0000-4000-8000-000000000002",
  jobStatus: "QUEUED",
  lastSuccessAt: null,
  runDurationMs: null,
});

function capacityWork(index: number) {
  return work({
    workKey: `${index}`.repeat(64).slice(0, 64),
    configId: `10000000-0000-4000-8000-0000000000${10 + index}`,
    configName: `Capacity Config ${index}`,
    configVersion: `profile-capacity-${index}-v1`,
    state: "WAITING",
    blockerReason: "CAPACITY_LIMIT",
    lastSuccessAt: null,
    runDurationMs: null,
    waitingSince: "2026-09-10T19:30:00.000Z",
    updatedAt: now,
  });
}

const status = {
  marketId: "CA_TSX",
  enabled: true,
  cadence: "DAILY_POST_SESSION",
  maxOutstanding: 2,
  asOf: now,
  nextCheckAt: "2026-09-11T21:00:00.000Z",
  interventionRequired: true,
  lastCycle: {
    cycleId: "30000000-0000-4000-8000-000000000001",
    marketId: "CA_TSX",
    triggerOrigin: "SCHEDULED_CATCH_UP",
    outcome: "BLOCKED",
    startedAt: "2026-09-10T20:59:00.000Z",
    finishedAt: now,
    evaluated: 8,
    dispatched: 1,
    coalesced: 0,
    blocked: 1,
    retried: 0,
    succeeded: 0,
    failed: 0,
    changes: ["Bull Flag: dispatched new replay for 2026-09-10"],
  },
  works: [
    running,
    queued,
    capacityWork(1),
    capacityWork(2),
    capacityWork(3),
    capacityWork(4),
    capacityWork(5),
    capacityWork(6),
    work({
      workKey: "d".repeat(64),
      configId: "10000000-0000-4000-8000-000000000099",
      configName: "US Momentum",
      configVersion: "profile-us-v1",
      state: "BLOCKED",
      blockerReason: "POLICY_VIOLATION",
      failureMessage: "US backtest slippageBps must be at least 10",
      consumedFingerprint: null,
      inputChanged: true,
      updatedAt: "2026-09-10T20:59:30.000Z",
    }),
  ],
  stages: [stage],
  outstandingWork: 1,
  oldestOutstandingAt: "2026-09-10T20:00:00.000Z",
  oldestWaitingAt: "2026-09-10T19:30:00.000Z",
  lastSuccessAt: "2026-09-10T20:05:00.000Z",
  lastSuccessDurationMs: 1_560_000,
  lastSuccessEvaluatedThrough: "2026-09-10",
  retryScheduled: 0,
  blockerCounts: [{ reason: "POLICY_VIOLATION", count: 1 }],
  recentCycles: [],
};

function stubFetch(
  override?: (url: string, init?: RequestInit) => Response | undefined,
) {
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const custom = override?.(url, init);
    if (custom) return custom;
    return new Response(
      JSON.stringify(
        url.includes("funded-historical-policies")
          ? { policies: [policy] }
          : status,
      ),
      { headers: { "content-type": "application/json" } },
    );
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("BacktestAutomationPanel", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows the compact overview, live progress, grouped waiting and issues", async () => {
    const fetch = stubFetch();
    render(<BacktestAutomationPanel marketId="CA_TSX" />);

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Running: ORB Standard 8/9 sessions",
      ),
    );
    expect(screen.getByRole("status")).toHaveTextContent("CA market");
    expect(
      screen.getByText(
        "1 running · 1 queued · 6 waiting for capacity · 1 needs action",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/Next automatic check/)).toBeInTheDocument();
    expect(screen.getByText("Last completed replay")).toBeInTheDocument();
    expect(screen.getByText(/ran in 26m 0s/)).toBeInTheDocument();
    expect(screen.getByText(/evidence through 2026-09-10/)).toBeInTheDocument();
    expect(
      screen.getByText("captured history, not a live run"),
    ).toBeInTheDocument();
    expect(screen.getByText("ORB Standard")).toBeInTheDocument();
    expect(screen.getByText("replaying captured sessions")).toBeInTheDocument();
    expect(screen.getByText(/Session 8 of 9/)).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "7",
    );
    expect(screen.getByText(/Last progress/)).toBeInTheDocument();
    expect(screen.getByText("Recent activity")).toBeInTheDocument();
    expect(screen.getByText("ORB Standard started")).toBeInTheDocument();
    expect(
      screen.getByText("US backtest slippageBps must be at least 10"),
    ).toBeInTheDocument();
    expect(screen.getByText("Needs your action")).toBeInTheDocument();
    expect(
      screen.getByText("Portfolio simulation: 1 approved policy"),
    ).toBeInTheDocument();
    expect(screen.getByText("6 configurations")).toBeInTheDocument();
    expect(screen.getAllByText(/oldest waiting/).length).toBeGreaterThan(0);
    expect(screen.queryByText("Capacity Config 1")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("View configurations"));
    expect(screen.getByText("Capacity Config 1")).toBeInTheDocument();
    expect(screen.getByText("Capacity Config 6")).toBeInTheDocument();
    expect(screen.getByText("Follow-on stages (1)")).toBeInTheDocument();
    expect(screen.getByText("Diagnostics")).toBeInTheDocument();
    expect(
      fetch.mock.calls.some((call) =>
        String(call[0]).includes(
          "/api/backtest-automation/status?marketId=CA_TSX",
        ),
      ),
    ).toBe(true);
  });

  it("leads with a plain-language paused headline and the next automatic action", async () => {
    stubFetch((url) =>
      url.includes("/api/backtest-automation/status")
        ? new Response(
            JSON.stringify({
              ...status,
              enabled: false,
              nextCheckAt: null,
              works: [],
              stages: [],
              blockerCounts: [],
              lastCycle: null,
              lastSuccessAt: null,
              lastSuccessDurationMs: null,
              lastSuccessEvaluatedThrough: null,
            }),
            { headers: { "content-type": "application/json" } },
          )
        : undefined,
    );
    render(<BacktestAutomationPanel marketId="CA_TSX" />);

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Automation paused"),
    );
    expect(screen.getByText(/Scheduled checks are off/)).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("explains NO_REPLAY_CANDIDATES and only offers the universe action when passed", async () => {
    const quiet = work({
      workKey: "e".repeat(64),
      configId: "10000000-0000-4000-8000-000000000097",
      configName: "Quiet Guide",
      configVersion: "profile-quiet-guide-v1",
      state: "WAITING",
      blockerReason: "NO_REPLAY_CANDIDATES",
      lastSuccessAt: null,
      runDurationMs: null,
      waitingSince: "2026-09-10T18:00:00.000Z",
    });
    stubFetch((url) =>
      url.includes("/api/backtest-automation/status")
        ? new Response(
            JSON.stringify({
              ...status,
              works: [quiet],
              stages: [],
              blockerCounts: [{ reason: "NO_REPLAY_CANDIDATES", count: 1 }],
            }),
            { headers: { "content-type": "application/json" } },
          )
        : undefined,
    );
    const onOpenUniverse = vi.fn();
    const { unmount } = render(
      <BacktestAutomationPanel
        marketId="CA_TSX"
        onOpenUniverse={onOpenUniverse}
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Waiting for captured sessions",
      ),
    );
    expect(screen.getByText("No replay candidates yet")).toBeInTheDocument();
    expect(
      screen.getByText(/daily list captured with each session/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByText("Open universe & daily list"));
    expect(onOpenUniverse).toHaveBeenCalledTimes(1);

    unmount();
    render(<BacktestAutomationPanel marketId="CA_TSX" />);
    await waitFor(() =>
      expect(screen.getByText("No replay candidates yet")).toBeInTheDocument(),
    );
    expect(
      screen.queryByText("Open universe & daily list"),
    ).not.toBeInTheDocument();
  });

  it("summarizes stage progression in order with authorization-aware states", async () => {
    stubFetch((url) =>
      url.includes("/api/backtest-automation/status")
        ? new Response(
            JSON.stringify({
              ...status,
              stages: [
                stage,
                {
                  ...stage,
                  stageKey: "CALIBRATION",
                  state: "RETRY_SCHEDULED",
                  authorizationScope: "AUTHORIZATION_REQUIRED",
                  reasonCodes: ["RETRY_BACKOFF"],
                  nextAttemptAt: "2026-09-11T12:00:00.000Z",
                },
                {
                  ...stage,
                  stageKey: "STRATEGY_STUDY",
                  state: "NOT_ELIGIBLE",
                  authorizationScope: "AUTHORIZATION_REQUIRED",
                  reasonCodes: ["EXPLICIT_STUDY_AUTHORIZATION_REQUIRED"],
                },
                {
                  ...stage,
                  stageKey: "COVERAGE",
                  state: "COMPLETED",
                  authorizationScope: "AUTOMATIC",
                  reasonCodes: ["RESEARCH_EVIDENCE_VERIFIED"],
                  completedAt: now,
                },
              ],
            }),
            { headers: { "content-type": "application/json" } },
          )
        : undefined,
    );
    render(<BacktestAutomationPanel marketId="CA_TSX" />);

    await waitFor(() =>
      expect(screen.getByText("Stage progression")).toBeInTheDocument(),
    );
    const progression = screen.getByLabelText("Stage progression");
    expect(
      within(progression)
        .getAllByRole("listitem")
        .map((item) => item.querySelector("strong")?.textContent),
    ).toEqual([
      "Coverage",
      "Calibration",
      "Training",
      "Strategy study",
      "Funded replay",
    ]);
    expect(
      within(progression).getByText("qualification-owned"),
    ).toBeInTheDocument();
    expect(
      within(progression).getByText(
        /Waiting for the evidence this stage needs/,
      ),
    ).toBeInTheDocument();
    expect(
      within(progression).getByText(
        /requires explicit authorization or an approved policy/,
      ),
    ).toBeInTheDocument();
    expect(within(progression).getByText(/Next attempt/)).toBeInTheDocument();
  });

  it("checks for new work without forcing a rerun", async () => {
    const calls: { url: string; method: string | undefined }[] = [];
    stubFetch((url, init) => {
      calls.push({ url, method: init?.method });
      if (url.includes("/check"))
        return new Response(JSON.stringify(status.lastCycle), {
          headers: { "content-type": "application/json" },
        });
      return undefined;
    });
    render(<BacktestAutomationPanel marketId="CA_TSX" />);
    await waitFor(() =>
      expect(screen.getByText("Check for new work")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByText("Check for new work"));
    await waitFor(() =>
      expect(
        calls.some(
          (call) =>
            call.method === "POST" &&
            call.url.includes("/api/backtest-automation/check?marketId=CA_TSX"),
        ),
      ).toBe(true),
    );
    expect(calls.some((call) => call.url.includes("/refresh"))).toBe(false);
  });

  it("forces a rerun from the automation settings drawer", async () => {
    const calls: { url: string; method: string | undefined }[] = [];
    stubFetch((url, init) => {
      calls.push({ url, method: init?.method });
      if (url.includes("/refresh"))
        return new Response(JSON.stringify(status.lastCycle), {
          headers: { "content-type": "application/json" },
        });
      return undefined;
    });
    render(<BacktestAutomationPanel marketId="US_EQUITIES" />);
    await waitFor(() =>
      expect(screen.getByText("Automation settings")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByText("Automation settings"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByText("FORCE RERUN NOW"));
    await waitFor(() =>
      expect(
        calls.some(
          (call) =>
            call.method === "POST" &&
            call.url.includes(
              "/api/backtest-automation/refresh?marketId=US_EQUITIES",
            ),
        ),
      ).toBe(true),
    );
  });

  it("revokes an approved policy from the settings drawer", async () => {
    const posted: { url: string; body: unknown }[] = [];
    stubFetch((url, init) => {
      if (init?.method === "POST") {
        posted.push({ url, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ ...policy, revokedAt: now }), {
          headers: { "content-type": "application/json" },
        });
      }
      return undefined;
    });
    render(<BacktestAutomationPanel marketId="CA_TSX" />);
    await waitFor(() =>
      expect(screen.getByText("Automation settings")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByText("Automation settings"));
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByText("Funded replay policy"),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(within(dialog).getByText("REVOKE")).toBeInTheDocument(),
    );
    fireEvent.click(within(dialog).getByText("REVOKE"));
    fireEvent.change(within(dialog).getByLabelText("Revoked by"), {
      target: { value: "operator" },
    });
    fireEvent.change(within(dialog).getByLabelText("Reason"), {
      target: { value: "Superseded by a new comparison" },
    });
    fireEvent.click(within(dialog).getByText("CONFIRM REVOKE"));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]!.url).toContain(
      `/api/funded-historical-policies/${policy.policyId}/revoke`,
    );
    expect(posted[0]!.body).toEqual({
      revokedBy: "operator",
      reason: "Superseded by a new comparison",
    });
  });
});
