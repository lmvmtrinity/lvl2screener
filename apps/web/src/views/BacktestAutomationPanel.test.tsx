import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BacktestView } from "./BacktestView.js";

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
    const json = (value: unknown, code = 200) =>
      new Response(JSON.stringify(value), {
        status: code,
        headers: { "content-type": "application/json" },
      });
    if (url.includes("/api/backtest-automation/status")) return json(status);
    if (url.includes("funded-historical-policies"))
      return json({ policies: [policy] });
    return json({ error: "unavailable" }, 503);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function statusWith(overrides: Record<string, unknown>) {
  return (url: string) =>
    url.includes("/api/backtest-automation/status")
      ? new Response(JSON.stringify({ ...status, ...overrides }), {
          headers: { "content-type": "application/json" },
        })
      : undefined;
}

function renderPage(
  marketId: "CA_TSX" | "US_EQUITIES" = "CA_TSX",
  onOpenUniverse?: () => void,
) {
  return render(
    <BacktestView
      runs={[]}
      updateRuns={() => undefined}
      marketId={marketId}
      onOpenUniverse={onOpenUniverse}
    />,
  );
}

function openMenuItem(label: string) {
  fireEvent.click(screen.getByLabelText("More backtest tools"));
  fireEvent.click(screen.getByRole("menuitem", { name: label }));
}

describe("Backtest automation sections", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("summarizes activity, the running replay, its queue and issues", async () => {
    const fetch = stubFetch();
    renderPage();

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Automation on · 1 running, 1 queued, 6 waiting for capacity, 1 needs attention · next check",
      ),
    );
    const running = screen.getByRole("region", { name: "Now running" });
    expect(within(running).getByText("ORB Standard")).toBeInTheDocument();
    expect(within(running).getByText("8 of 9")).toBeInTheDocument();
    expect(within(running).getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "7",
    );
    expect(within(running).getByText(/Last progress/)).toBeInTheDocument();
    expect(within(running).getByText("VWAP Hold")).toBeInTheDocument();
    expect(within(running).getByText("+3 more")).toBeInTheDocument();

    const evidence = screen.getByRole("region", {
      name: "Automation evidence",
    });
    expect(within(evidence).getByText(/ran in 26m 0s/)).toBeInTheDocument();
    expect(within(evidence).getByText("0 / 9")).toBeInTheDocument();
    const issues = within(evidence).getByRole("list", {
      name: "Needs attention",
    });
    expect(within(issues).getByText("Needs your action")).toBeInTheDocument();
    expect(
      within(issues).getByText("US backtest slippageBps must be at least 10"),
    ).toBeInTheDocument();
    expect(
      within(issues).getByText("Profile configuration rejected"),
    ).toBeInTheDocument();
    expect(
      fetch.mock.calls.some((call) =>
        String(call[0]).includes(
          "/api/backtest-automation/status?marketId=CA_TSX",
        ),
      ),
    ).toBe(true);
  });

  it("summarizes each stage across strategies in one strip", async () => {
    const second = {
      ...stage,
      workKey: "e".repeat(64),
      configName: "VWAP Hold",
    };
    const study = {
      stageKey: "STRATEGY_STUDY",
      state: "NOT_ELIGIBLE",
      authorizationScope: "AUTHORIZATION_REQUIRED",
      reasonCodes: ["EXPLICIT_STUDY_AUTHORIZATION_REQUIRED"],
    };
    stubFetch(
      statusWith({
        stages: [
          stage,
          second,
          { ...stage, ...study },
          { ...second, ...study },
          {
            ...stage,
            stageKey: "CALIBRATION",
            state: "RETRY_SCHEDULED",
            authorizationScope: "AUTHORIZATION_REQUIRED",
            reasonCodes: ["RETRY_BACKOFF"],
          },
          {
            ...second,
            stageKey: "CALIBRATION",
            state: "COMPLETED",
            authorizationScope: "AUTHORIZATION_REQUIRED",
            reasonCodes: [],
            completedAt: now,
          },
        ],
      }),
    );
    renderPage();

    const strip = await screen.findByRole("list", {
      name: "Strategy pipeline",
    });
    const steps = within(strip).getAllByRole("listitem");
    expect(
      steps.map((item) => item.querySelector("strong")?.textContent),
    ).toEqual([
      "Replay",
      "Coverage",
      "Calibration",
      "Training",
      "Study",
      "Funded replay",
    ]);
    expect(steps[1]).toHaveTextContent("Not evaluated yet");
    expect(steps[2]).toHaveTextContent("Retrying after a failure (1 of 2)");
    expect(steps[3]).toHaveTextContent("Waits for paper qualification");
    expect(steps[4]).toHaveTextContent("Needs study authorization");
    expect(steps[4]!.textContent).not.toMatch(/of 2/);

    openMenuItem("Diagnostics");
    const matrix = within(screen.getByRole("dialog")).getByRole("table", {
      name: "Stages per strategy",
    });
    expect(within(matrix).getByText("Bull Flag")).toBeInTheDocument();
    expect(within(matrix).getByText("VWAP Hold")).toBeInTheDocument();
  });

  it("collapses to one line and names the paused schedule when idle", async () => {
    stubFetch(
      statusWith({
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
    );
    renderPage();

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Automation paused · no qualification work recorded yet · scheduled checks are off",
      ),
    );
    expect(screen.getByText(/Nothing is running\./)).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("offers the universe action for NO_REPLAY_CANDIDATES only when passed", async () => {
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
    stubFetch(
      statusWith({
        works: [quiet],
        stages: [],
        blockerCounts: [{ reason: "NO_REPLAY_CANDIDATES", count: 1 }],
      }),
    );
    const onOpenUniverse = vi.fn();
    const { unmount } = renderPage("CA_TSX", onOpenUniverse);

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "1 waiting for data",
      ),
    );
    expect(screen.getByText("No replay candidates yet")).toBeInTheDocument();
    expect(
      screen.getByText(/daily list captured with each session/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByText("Open universe & daily list"));
    expect(onOpenUniverse).toHaveBeenCalledTimes(1);

    unmount();
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("No replay candidates yet")).toBeInTheDocument(),
    );
    expect(
      screen.queryByText("Open universe & daily list"),
    ).not.toBeInTheDocument();
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
    renderPage();
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Automation on"),
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
    renderPage("US_EQUITIES");
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Automation on"),
    );
    openMenuItem("Automation settings");
    const dialog = screen.getByRole("dialog", { name: "Automation settings" });
    fireEvent.click(within(dialog).getByText("Force rerun now"));
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
    renderPage();
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Automation on"),
    );
    openMenuItem("Automation settings");
    const dialog = screen.getByRole("dialog", { name: "Automation settings" });
    expect(
      await within(dialog).findByText("1 approved policy."),
    ).toBeInTheDocument();
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
