import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  defaultStrategyParameters,
  type BacktestAutomationWork,
  type ScannerProfile,
  type StrategyDefinition,
} from "@tsx-scanner/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getJson, sendJson } from "../lib/api.js";
import { comparisonRequestUrl, StrategyLab } from "./StrategyLabView";

vi.mock("../lib/api.js", () => ({
  getJson: vi.fn(),
  sendJson: vi.fn(),
  ApiRequestError: class extends Error {},
}));

const definition: StrategyDefinition = {
  id: "10000000-0000-4000-8000-000000000071",
  strategyKey: "ORB_RETEST",
  version: "1.0.0",
  name: "ORB Retest",
  analysisKind: "SETUP",
  description: "Test strategy",
  enabled: true,
  parameterSchema: { scoreCutoff: {} },
  createdAt: "2026-09-01T00:00:00.000Z",
};

const PROFILE_LEFT = "10000000-0000-4000-8000-000000000001";
const PROFILE_RIGHT = "10000000-0000-4000-8000-000000000002";
const PROFILE_CREATED = "10000000-0000-4000-8000-000000000003";

function configIdFor(id: string): string {
  return id.replace("10000000", "20000000");
}

function profile(
  id: string,
  name: string,
  overrides: Partial<ScannerProfile> = {},
): ScannerProfile {
  return {
    id,
    name,
    marketId: "CA_TSX",
    strategyDefinitionId: definition.id,
    analysisKind: "SETUP",
    strategyKey: "ORB_RETEST",
    strategyVersion: "1.0.0",
    configId: configIdFor(id),
    configVersion: "profile-v1",
    parameters: defaultStrategyParameters(),
    enabled: true,
    qualification: "EXPLORATORY",
    qualificationReason: "Test",
    displayOrder: 0,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function work(
  overrides: Partial<BacktestAutomationWork> = {},
): BacktestAutomationWork {
  return {
    workKey: "a".repeat(64),
    marketId: "CA_TSX",
    kind: "PROFILE_QUALIFICATION",
    configId: configIdFor(PROFILE_LEFT),
    configName: "Left",
    configVersion: "profile-v1",
    strategyKey: "ORB_RETEST",
    state: "QUEUED",
    triggerOrigin: "PROFILE_SAVE",
    blockerReason: null,
    inputFingerprint: "b".repeat(64),
    consumedFingerprint: "b".repeat(64),
    attemptKey: "c".repeat(64),
    jobId: null,
    jobStatus: null,
    runId: null,
    evaluatedThrough: null,
    retryCount: 0,
    nextAttemptAt: null,
    lastDispatchedAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    waitingSince: null,
    startedAt: null,
    heartbeatAt: null,
    progress: null,
    runDurationMs: null,
    failureMessage: null,
    inputChanged: false,
    updatedAt: "2026-09-11T20:00:00.000Z",
    ...overrides,
  };
}

function automationStatus(works: BacktestAutomationWork[]) {
  return {
    marketId: "CA_TSX",
    enabled: true,
    cadence: "DAILY_POST_SESSION",
    maxOutstanding: 2,
    asOf: "2026-09-11T21:00:00.000Z",
    nextCheckAt: null,
    interventionRequired: false,
    lastCycle: null,
    works,
    stages: [],
    outstandingWork: works.length,
    oldestOutstandingAt: null,
    oldestWaitingAt: null,
    lastSuccessAt: null,
    lastSuccessDurationMs: null,
    lastSuccessEvaluatedThrough: null,
    retryScheduled: 0,
    blockerCounts: [],
    recentCycles: [],
  };
}

interface ApiState {
  profiles: ScannerProfile[];
  works: BacktestAutomationWork[];
  comparison?: unknown;
}

function stubApi(state: ApiState) {
  vi.mocked(getJson).mockImplementation(async (path: string) => {
    if (path.includes("/api/backtest-automation/status"))
      return automationStatus(state.works);
    if (path.includes("/configs")) return { versions: [] };
    if (path.startsWith("/api/scanner-profiles"))
      return { profiles: state.profiles };
    if (path.startsWith("/api/comparisons")) return state.comparison;
    throw new Error(`Unexpected request ${path}`);
  });
}

function renderLab(
  profiles: ScannerProfile[],
  options: { onOpenBacktests?: () => void } = {},
) {
  return render(
    <StrategyLab
      profiles={profiles}
      definitions={[definition]}
      updated={() => undefined}
      onOpenBacktests={options.onOpenBacktests}
    />,
  );
}

describe("StrategyLab automation feedback", () => {
  afterEach(() => {
    cleanup();
    vi.resetAllMocks();
  });

  it("renders a Queued chip only for the matching configuration", async () => {
    const left = profile(PROFILE_LEFT, "Left");
    const right = profile(PROFILE_RIGHT, "Right");
    stubApi({
      profiles: [left, right],
      works: [
        work({
          configId: left.configId,
          configVersion: left.configVersion,
          state: "QUEUED",
          jobStatus: "QUEUED",
        }),
      ],
    });
    renderLab([left, right]);
    await waitFor(() => expect(screen.getByText("Queued")).toBeInTheDocument());
    expect(
      within(screen.getByText("Left").closest("article")!).getByText("Queued"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByText("Right").closest("article")!).getByText(
        "No automation record yet",
      ),
    ).toBeInTheDocument();
  });

  it("renders session progress for a running replay", async () => {
    const left = profile(PROFILE_LEFT, "Left");
    stubApi({
      profiles: [left],
      works: [
        work({
          configId: left.configId,
          configVersion: left.configVersion,
          state: "RUNNING",
          jobStatus: "RUNNING",
          startedAt: "2026-09-11T20:37:00.000Z",
          progress: {
            totalSessions: 9,
            completedSessions: 7,
            message: "Loading session 2026-09-11",
          },
        }),
      ],
    });
    renderLab([left]);
    expect(await screen.findByText("Running 7/9")).toBeInTheDocument();
  });

  it("shows the blocker explanation for waiting work", async () => {
    const left = profile(PROFILE_LEFT, "Left");
    stubApi({
      profiles: [left],
      works: [
        work({
          configId: left.configId,
          configVersion: left.configVersion,
          state: "WAITING",
          blockerReason: "CAPACITY_LIMIT",
        }),
      ],
    });
    renderLab([left]);
    expect(
      await screen.findByText("Waiting · queued behind outstanding replays"),
    ).toBeInTheDocument();
  });

  it("shows the configuration version with up-to-date evidence coverage", async () => {
    const left = profile(PROFILE_LEFT, "Left");
    stubApi({
      profiles: [left],
      works: [
        work({
          configId: left.configId,
          configVersion: left.configVersion,
          state: "SUCCEEDED",
          evaluatedThrough: "2026-09-10",
        }),
      ],
    });
    renderLab([left]);
    expect(
      await screen.findByText("Up to date · evidence through 2026-09-10"),
    ).toBeInTheDocument();
  });

  it("fetches automation status for the requested market", async () => {
    stubApi({ profiles: [], works: [] });
    render(
      <StrategyLab
        profiles={[]}
        definitions={[definition]}
        updated={() => undefined}
        marketId="US_EQUITIES"
      />,
    );
    await waitFor(() =>
      expect(
        vi
          .mocked(getJson)
          .mock.calls.some((call) =>
            String(call[0]).includes(
              "/api/backtest-automation/status?marketId=US_EQUITIES",
            ),
          ),
      ).toBe(true),
    );
  });
});

describe("StrategyLab save acknowledgement", () => {
  afterEach(() => {
    cleanup();
    vi.resetAllMocks();
  });

  it("acknowledges the server-confirmed queued state after create", async () => {
    const created = profile(PROFILE_CREATED, "ORB Experiment");
    const state: ApiState = { profiles: [], works: [] };
    stubApi(state);
    vi.mocked(sendJson).mockImplementation(async () => {
      state.profiles = [created];
      state.works = [
        work({
          configId: created.configId,
          configVersion: created.configVersion,
          configName: created.name,
          state: "QUEUED",
          jobStatus: "QUEUED",
        }),
      ];
      return created;
    });
    renderLab([]);
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "ORB Experiment" },
    });
    fireEvent.click(screen.getByRole("button", { name: "CREATE PROFILE" }));
    expect(
      await screen.findByText(/Saved profile-v1 · qualification queued/),
    ).toBeInTheDocument();
  });

  it("never claims queued when no work row exists yet", async () => {
    const created = profile(PROFILE_CREATED, "ORB Experiment");
    const state: ApiState = { profiles: [], works: [] };
    stubApi(state);
    vi.mocked(sendJson).mockResolvedValue(created);
    renderLab([]);
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "ORB Experiment" },
    });
    fireEvent.click(screen.getByRole("button", { name: "CREATE PROFILE" }));
    const acknowledgement = await screen.findByText(/Saved profile-v1/);
    expect(acknowledgement).toHaveTextContent("checking automation status…");
    expect(screen.queryByText(/qualification queued/)).not.toBeInTheDocument();
  });
});

describe("StrategyLab backtests shortcut", () => {
  afterEach(() => {
    cleanup();
    vi.resetAllMocks();
  });

  it("renders a working View in Backtests link when provided", async () => {
    const open = vi.fn();
    const left = profile(PROFILE_LEFT, "Left");
    stubApi({ profiles: [left], works: [] });
    renderLab([left], { onOpenBacktests: open });
    await screen.findByText("No automation record yet");
    fireEvent.click(
      screen.getAllByRole("button", { name: "View in Backtests" })[0]!,
    );
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("omits the Backtests link when no handler is provided", async () => {
    const left = profile(PROFILE_LEFT, "Left");
    stubApi({ profiles: [left], works: [] });
    renderLab([left]);
    await screen.findByText("No automation record yet");
    expect(
      screen.queryByRole("button", { name: "View in Backtests" }),
    ).not.toBeInTheDocument();
  });
});

describe("Strategy Lab comparison routing", () => {
  afterEach(() => {
    cleanup();
    vi.resetAllMocks();
  });

  it("includes the selected US market in comparison requests", () => {
    const url = comparisonRequestUrl(
      ["profile-us-v1", "profile-us-v2"],
      "PAPER",
      "2026-08-01",
      "2026-08-31",
      "US_EQUITIES",
    );
    expect(url).toContain("marketId=US_EQUITIES");
    expect(url).toContain("profileIds=profile-us-v1%2Cprofile-us-v2");
  });

  it("renders incomplete evidence, market currency, dates and null drawdown honestly", async () => {
    stubApi({
      profiles: [
        profile(PROFILE_LEFT, "Left"),
        profile(PROFILE_RIGHT, "Right"),
      ],
      works: [],
      comparison: {
        marketId: "US_EQUITIES",
        source: "PAPER",
        startDate: "2026-08-01",
        endDate: "2026-08-31",
        timeStart: "09:30",
        timeEnd: "16:00",
        status: "UNVERIFIED",
        controlled: false,
        differences: ["unverified inputHash"],
        metrics: [
          {
            profileId: PROFILE_LEFT,
            profileName: "Left",
            setupCount: 2,
            trades: 0,
            wins: 0,
            winRate: 0,
            averageWinner: 0,
            averageLoser: 0,
            averageR: 0,
            profitFactor: 0,
            expectancy: 0,
            maximumDrawdown: null,
            drawdownBasis: "REALIZED_CLOSED_OUTCOMES",
            drawdownStatus: "NO_CLOSED_OUTCOMES",
            averageHoldMinutes: 0,
            falsePositiveRate: 0,
          },
          {
            profileId: PROFILE_RIGHT,
            profileName: "Right",
            setupCount: 1,
            trades: 0,
            wins: 0,
            winRate: 0,
            averageWinner: 0,
            averageLoser: 0,
            averageR: 0,
            profitFactor: 0,
            expectancy: 0,
            maximumDrawdown: null,
            drawdownBasis: "REALIZED_CLOSED_OUTCOMES",
            drawdownStatus: "UNAVAILABLE",
            averageHoldMinutes: 0,
            falsePositiveRate: 0,
          },
        ],
      },
    });
    renderLab([profile(PROFILE_LEFT, "Left"), profile(PROFILE_RIGHT, "Right")]);
    fireEvent.click(screen.getByLabelText("Compare Left"));
    fireEvent.click(screen.getByLabelText("Compare Right"));
    fireEvent.click(screen.getByRole("button", { name: "COMPARE · 2" }));

    expect(
      await screen.findByText("Comparison evidence incomplete"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/USD · 2026-08-01 to 2026-08-31/),
    ).toBeInTheDocument();
    expect(screen.getByText(/America\/New_York/)).toBeInTheDocument();
    expect(screen.getByText("unverified inputHash")).toBeInTheDocument();
    expect(screen.getAllByText("No outcomes")).toHaveLength(1);
    expect(screen.getAllByText("—")).toHaveLength(1);
  });
});
