import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LearningView } from "./LearningView.js";

const { getJsonMock } = vi.hoisted(() => ({
  getJsonMock: vi.fn(),
}));

vi.mock("../lib/api.js", () => ({
  getJson: getJsonMock,
  sendJson: vi.fn(),
}));

const HASH = "a".repeat(64);
const MODEL_ID = "11111111-1111-4111-8111-111111111111";
const EXPERIMENT_ID = "22222222-2222-4222-8222-222222222222";
const PROFILE_ID = "33333333-3333-4333-8333-333333333333";

const overview = {
  pipelineHealth: {
    schedulerEnabled: true,
    scheduleDescription: "Daily at 5:00 p.m. Eastern, plus worker startup",
    schedulerPolicyVersion: "policy-v1",
    lastCheckAt: "2026-09-09T21:00:00.000Z",
    nextCheckAt: "2026-09-10T21:00:00.000Z",
    nextCheckIsEstimate: true,
    checkOverdue: false,
    lastState: "NOOP",
    lastNoopReason: "INSUFFICIENT_CLOSED_QUOTES",
    activeJobs: 0,
    durableErrors: 0,
    explanation: "Scheduler idle: INSUFFICIENT_CLOSED_QUOTES",
  },
  evidenceReadiness: [
    {
      cohort: {
        marketId: "CA_TSX" as const,
        strategy: "ORB_RETEST" as const,
        strategyVersion: "strategy-v1",
        profileConfigId: PROFILE_ID,
        configVersion: "config-v1",
        executionModelVersion: "execution-v1",
        assumptions: {},
        closedQuoteCount: 120,
        positives: 60,
        negatives: 60,
        firstSignalAt: "2026-08-01T14:00:00.000Z",
        lastSignalAt: "2026-09-09T14:00:00.000Z",
        missingFeatureCount: 0,
        signalSemanticsVersion: "signals-v1",
        replayScope: "FORWARD_LIVE",
      },
      closedQuoteCount: 120,
      threshold: 200,
      progressPct: 60,
      newOutcomesSinceLastDataset: 120,
      newOutcomeThreshold: 50,
      qualifies: false,
      disqualificationReason: "INSUFFICIENT_CLOSED_QUOTES (120 < 200)",
    },
  ],
  lifecycle: { datasetsCount: 0, modelsCount: 0, activeModelsCount: 0 },
  forwardMonitoring: [],
  shadowExperiments: {
    policyVersion: "paper-coordination-v4-shadow" as const,
    comparatorPolicyVersion: "paper-coordination-v3",
    decisionsEvaluated: 0,
    selectionChangesCount: 0,
    selectionChangeRate: 0,
    differenceReasons: {},
    hypotheticalNetPnl: 0,
    primaryNetPnl: 0,
    hypotheticalCumulativeR: 0,
    primaryCumulativeR: 0,
  },
};

const experiment = {
  id: EXPERIMENT_ID,
  modelId: MODEL_ID,
  modelVersion: "model-v2",
  artifactHash: HASH,
  scope: {
    marketId: "CA_TSX" as const,
    currency: "CAD" as const,
    strategy: "ORB_RETEST" as const,
    strategyVersion: "strategy-v1",
    profileConfigId: PROFILE_ID,
    configVersion: "config-v1",
    executionModelVersion: "execution-v1",
    executionAssumptionsHash: HASH,
    signalSemanticsVersion: "signals-v1",
    replayScope: "sessions-v1",
  },
  researchEvidence: {
    manifestHash: HASH,
    coverageReportHash: HASH,
    inputHash: HASH,
    engineRevision: "1234567890abcdef1234567890abcdef12345678",
    runtimeFingerprint: HASH,
    verifiedAt: "2026-09-01T12:00:00.000Z",
  },
  baselineIdentityHash: HASH,
  acceptancePlanHash: HASH,
  startsAt: "2026-09-02T13:30:00.000Z",
  endsAt: "2026-09-30T20:00:00.000Z",
  maxPredictionLagMs: 500,
  registeredAt: "2026-09-01T12:00:00.000Z",
  state: "ACTIVE" as const,
};

const report = {
  experimentId: EXPERIMENT_ID,
  asOf: "2026-09-10T15:00:00.000Z",
  population: {
    expectedEligibleObservations: 5,
    predicted: 1,
    pending: 1,
    missedDeadline: 1,
    engineFailed: 1,
    inputInvalid: 0,
    revoked: 0,
    unknownCapture: 1,
  },
  verifiedSessions: 1,
  incompleteSessions: 1,
  unknownSessions: 1,
  coveredNoOpportunitySessions: 0,
  excludedPausedSessions: 0,
  closedQuoteOutcomes: 1,
  prospectiveEconomics: {
    unit: "CAD" as const,
    status: "UNAVAILABLE" as const,
    observedBaselineLabelDenominator: 0,
    observedBaselineNetPnlAfterCosts: null,
    decisionCounts: {
      selected: null,
      rejected: null,
      noFill: null,
      invalid: null,
      missedWinner: null,
      unavailableReason: "NO_FROZEN_DECISION_OR_FILL_CLASSIFICATION",
    },
    riskDiagnostics: {
      drawdown: null,
      concentration: null,
      unavailableReason: "NO_CAUSAL_PORTFOLIO_SEQUENCE_IN_CHALLENGER_LABELS",
    },
    unavailableReason: "NO_VISIBLE_CLOSED_NET_PNL_LABELS",
  },
  prospectiveBrierScore: 0.25,
  comparison: null,
  comparisonUnavailableReason: "PAIRED_INPUTS_MISSING" as const,
  promotionAuthorized: false as const,
};

function endpoint(
  url: string,
  overviewData: typeof overview = overview,
): unknown {
  if (url === "/api/learning/overview") return overviewData;
  if (url.startsWith("/api/learning/automation-runs")) return { runs: [] };
  if (url.startsWith("/api/learning/coordination-decisions"))
    return { decisions: [] };
  if (url.startsWith("/api/statistical-models")) return { models: [] };
  if (url.startsWith("/api/learning/evidence-automation"))
    return { stages: [] };
  if (url.startsWith("/api/calibrations")) return { calibrations: [] };
  if (url.startsWith("/api/challenger-experiments/"))
    return { experiment, report };
  if (url.startsWith("/api/challenger-experiments"))
    return { experiments: [experiment] };
  if (url.startsWith("/api/signal-model-research/authorizations?"))
    return { authorizations: [] };
  throw new Error(`Unexpected request: ${url}`);
}

function mockEndpoints(overviewData: typeof overview = overview) {
  getJsonMock.mockImplementation((url: string) => {
    try {
      return Promise.resolve(endpoint(url, overviewData));
    } catch (reason) {
      return Promise.reject(reason);
    }
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const coverageStage = {
  key: "COVERAGE" as const,
  marketId: "CA_TSX" as const,
  scopeId: "e51cc793-d168-4acf-a552-532ee04c6ad2",
  state: "RUNNING" as const,
  asOf: "2026-09-10T15:00:00.000Z",
  lastAttemptAt: "2026-09-10T14:50:00.000Z",
  lastSuccessAt: null,
  nextCheckAt: null,
  progress: { completed: 6, total: 17, unit: "sessions" },
  reasonCodes: [],
  nextAction: {
    kind: "AUTOMATIC" as const,
    label: "The worker will check again",
  },
  jobId: null,
  reportId: null,
};

const usCohort = {
  ...overview.evidenceReadiness[0]!,
  cohort: {
    ...overview.evidenceReadiness[0]!.cohort,
    marketId: "US_EQUITIES" as const,
    strategy: "PRIOR_DAY_HIGH_BREAKOUT" as const,
    profileConfigId: "44444444-4444-4444-8444-444444444444",
    configVersion: "profile-us-prior-day-high-breakout-v1",
    closedQuoteCount: 178,
  },
  closedQuoteCount: 178,
  progressPct: 89,
};

function openTool(label: string) {
  fireEvent.click(screen.getByRole("button", { name: "More learning tools" }));
  fireEvent.click(screen.getByRole("menuitem", { name: label }));
  return screen.getByRole("dialog");
}

// Initial load: seven summary requests plus the selected challenger report.
const INITIAL_REQUESTS = 8;

describe("LearningView summary page", () => {
  it("leads with status, training progress and the selected market's evidence", async () => {
    mockEndpoints({
      ...overview,
      evidenceReadiness: [
        ...overview.evidenceReadiness,
        usCohort,
      ] as unknown as typeof overview.evidenceReadiness,
    });
    render(<LearningView marketId="CA_TSX" />);
    await waitFor(() =>
      expect(getJsonMock).toHaveBeenCalledTimes(INITIAL_REQUESTS),
    );

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Learning checks on · 1 needs review · waiting for enough closed outcomes · next check",
    );
    expect(
      screen.getByText(/Nothing is running\. Learning checks run on schedule/),
    ).toBeInTheDocument();

    const progress = screen.getByRole("region", {
      name: "Progress to training",
    });
    expect(within(progress).getByText("120 / 200")).toBeInTheDocument();
    expect(within(progress).getByText("0 / 1")).toBeInTheDocument();
    expect(
      within(progress).getByText(
        /1 prospective observation missed the capture deadline/,
      ),
    ).toBeInTheDocument();
    const strip = within(progress).getByRole("list", {
      name: "Learning pipeline",
    });
    expect(within(strip).getAllByRole("listitem")).toHaveLength(6);
    expect(within(strip).getByText("1 enrolled")).toBeInTheDocument();
    expect(
      within(strip).getByText("Manual only, after comparison"),
    ).toBeInTheDocument();

    // The overview endpoint spans both markets; the US cohort stays out.
    const evidence = screen.getByRole("region", {
      name: "Evidence by strategy",
    });
    expect(within(evidence).getByText("ORB Retest")).toBeInTheDocument();
    expect(
      within(evidence).queryByText("Prior Day High Breakout"),
    ).not.toBeInTheDocument();
    expect(within(evidence).queryByText(/178/)).not.toBeInTheDocument();

    fireEvent.click(within(evidence).getByText("ORB Retest"));
    const gates = within(evidence).getByRole("list", {
      name: "Training gates",
    });
    expect(gates).toHaveTextContent("200 closed outcomes (120) (not met)");
    expect(gates).toHaveTextContent("50 new since last dataset (120) (met)");
    expect(
      within(evidence).getByText(/Activation\s+stays manual/),
    ).toBeInTheDocument();

    const shadow = screen.getByRole("region", {
      name: "Models and shadow comparison",
    });
    expect(within(shadow).getByText("None trained yet")).toBeInTheDocument();
    expect(within(shadow).getByText(/all markets/)).toBeInTheDocument();
  });

  it("shows a running process with its measured progress", async () => {
    getJsonMock.mockImplementation((url: string) =>
      url.startsWith("/api/learning/evidence-automation")
        ? Promise.resolve({ stages: [coverageStage] })
        : Promise.resolve(endpoint(url)),
    );
    render(<LearningView marketId="CA_TSX" />);

    const running = await screen.findByRole("region", { name: "Now running" });
    await waitFor(() =>
      expect(within(running).getByText("Coverage check")).toBeInTheDocument(),
    );
    expect(within(running).getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "6",
    );
    expect(within(running).getByText("6 of 17")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("1 process running");
  });

  it("keeps scheduler detail and process counts in the Processes drawer", async () => {
    mockEndpoints();
    render(<LearningView marketId="CA_TSX" />);
    await waitFor(() =>
      expect(getJsonMock).toHaveBeenCalledTimes(INITIAL_REQUESTS),
    );

    const dialog = openTool("Processes");
    expect(
      within(dialog).getByText(/Scheduled evidence checks/),
    ).toBeInTheDocument();
    expect(within(dialog).getByText("Raw scheduler state")).toBeInTheDocument();
    expect(
      within(dialog).getByText("Evidence and automation"),
    ).toBeInTheDocument();
    expect(within(dialog).getByText("Process summary")).toBeInTheDocument();
    expect(
      within(dialog).getByText(/Unknown is not success/),
    ).toBeInTheDocument();
  });

  it("keeps models, observation and the acceptance report read-only in their drawer", async () => {
    mockEndpoints();
    render(<LearningView marketId="CA_TSX" />);
    await waitFor(() =>
      expect(getJsonMock).toHaveBeenCalledTimes(INITIAL_REQUESTS),
    );

    const dialog = openTool("Models & monitoring");
    expect(within(dialog).getByText("Model lifecycle")).toBeInTheDocument();
    expect(
      within(dialog).getByText(/No statistical models trained yet/),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText("Prospective observation"),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/model-v2/)).toBeInTheDocument();
    expect(
      within(dialog).queryByRole("button", {
        name: /start|pause|resume|end|revoke/i,
      }),
    ).not.toBeInTheDocument();
    expect(
      within(dialog).getByText("Prospective acceptance progress"),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(/No frozen acceptance plan is attached/),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(within(dialog).getByText("Pending")).toBeInTheDocument(),
    );
    expect(within(dialog).getByText("Missed deadline")).toBeInTheDocument();
    expect(within(dialog).getByText("Capture unknown")).toBeInTheDocument();
    expect(
      within(dialog).getByText(/Promotion authorized: No/),
    ).toBeInTheDocument();
  });

  it("keeps raw decision facts in their own drawer", async () => {
    mockEndpoints();
    render(<LearningView marketId="CA_TSX" />);
    await waitFor(() =>
      expect(getJsonMock).toHaveBeenCalledTimes(INITIAL_REQUESTS),
    );

    const dialog = openTool("Coordination decisions");
    expect(within(dialog).getByText("Decision drill-down")).toBeInTheDocument();
  });

  it("surfaces an overdue check in the status line, review list and processes", async () => {
    mockEndpoints({
      ...overview,
      pipelineHealth: { ...overview.pipelineHealth, checkOverdue: true },
    });
    render(<LearningView marketId="CA_TSX" />);
    await waitFor(() =>
      expect(getJsonMock).toHaveBeenCalledTimes(INITIAL_REQUESTS),
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "scheduled check overdue",
    );
    expect(
      screen.getByText(/scheduled evidence check is overdue for its cadence/),
    ).toBeInTheDocument();
    const dialog = openTool("Processes");
    expect(
      within(dialog).getByText(
        /The previous check is overdue for this schedule/,
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByText("schedule basis")).toBeInTheDocument();
  });

  it("refreshes the selected challenger report with the overview lifecycle", async () => {
    mockEndpoints();
    render(<LearningView marketId="CA_TSX" />);
    await waitFor(() =>
      expect(getJsonMock).toHaveBeenCalledTimes(INITIAL_REQUESTS),
    );

    const reportCalls = () =>
      getJsonMock.mock.calls.filter(([url]) =>
        String(url).startsWith(
          `/api/challenger-experiments/${EXPERIMENT_ID}/report`,
        ),
      ).length;
    expect(reportCalls()).toBe(1);

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });

    // The overview refresh must also re-read the report it claims is current;
    // the selected experiment stays selected for the follow-up request.
    await waitFor(() => expect(reportCalls()).toBe(2));
    await waitFor(() =>
      expect(getJsonMock).toHaveBeenCalledTimes(INITIAL_REQUESTS * 2),
    );
  });

  it("keeps the selected report when a background refresh fails", async () => {
    let reportCalls = 0;
    getJsonMock.mockImplementation((url: string) => {
      if (
        String(url).startsWith(
          `/api/challenger-experiments/${EXPERIMENT_ID}/report`,
        )
      ) {
        reportCalls += 1;
        if (reportCalls > 1)
          return Promise.reject(new Error("temporary report failure"));
      }
      try {
        return Promise.resolve(endpoint(String(url)));
      } catch (reason) {
        return Promise.reject(reason);
      }
    });
    render(<LearningView marketId="CA_TSX" />);
    await waitFor(() =>
      expect(getJsonMock).toHaveBeenCalledTimes(INITIAL_REQUESTS),
    );

    const dialog = openTool("Models & monitoring");
    await waitFor(() =>
      expect(within(dialog).getByText("Pending")).toBeInTheDocument(),
    );

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });
    await waitFor(() => expect(reportCalls).toBe(2));
    // The report still belongs to the selected experiment, so the failed
    // background refresh must not blank it.
    expect(within(dialog).getByText("Pending")).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        /Report refresh failed.*last successfully loaded report/,
      ),
    ).toBeInTheDocument();
  });

  it("hides the previous experiment's report while another selection loads", async () => {
    const otherId = "10000000-0000-4000-8000-000000000099";
    const otherExperiment = {
      ...experiment,
      id: otherId,
      modelVersion: "model-v3",
    };
    let resolveReport!: (value: unknown) => void;
    getJsonMock.mockImplementation((url: string) => {
      if (url.startsWith(`/api/challenger-experiments/${otherId}/report`))
        return new Promise((resolve) => {
          resolveReport = resolve;
        });
      if (url.startsWith("/api/challenger-experiments?"))
        return Promise.resolve({ experiments: [experiment, otherExperiment] });
      return Promise.resolve(endpoint(url));
    });
    render(<LearningView marketId="CA_TSX" />);
    await waitFor(() =>
      expect(getJsonMock).toHaveBeenCalledTimes(INITIAL_REQUESTS),
    );
    const dialog = openTool("Models & monitoring");
    await waitFor(() =>
      expect(within(dialog).getByText("Pending")).toBeInTheDocument(),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: /model-v3/ }));
    expect(within(dialog).queryByText("Pending")).not.toBeInTheDocument();
    expect(
      within(dialog).getByText("Loading selected report…"),
    ).toBeInTheDocument();
    await act(async () => {
      resolveReport({
        experiment: otherExperiment,
        report: { ...report, experimentId: otherId },
      });
    });
    expect(within(dialog).getByText("Pending")).toBeInTheDocument();
  });
});
