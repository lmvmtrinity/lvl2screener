import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
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

describe("LearningView automation-first hierarchy", () => {
  it("leads with the current situation, scheduler state and qualification gates", async () => {
    mockEndpoints();
    render(<LearningView marketId="CA_TSX" />);

    await waitFor(() => expect(getJsonMock).toHaveBeenCalledTimes(8));
    expect(screen.getByRole("button", { name: "OVERVIEW" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      await screen.findByText(/1 item needs review before this pipeline/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Scheduled evidence checks/)).toBeInTheDocument();
    expect(
      screen.getAllByText(/Daily at 5:00 p.m. Eastern/).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText(/Qualification progress/)).toBeInTheDocument();
    expect(
      screen.getByText(/Fewer closed quote outcomes than the gate requires/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Enough closed quote outcomes/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Activation stays manual/)).toBeInTheDocument();
    // Raw reason codes are explained, not headline copy.
    expect(
      screen.getAllByText(/Waiting for enough closed outcomes/).length,
    ).toBeGreaterThan(0);
    // The raw state remains inspectable under a details block.
    expect(screen.getByText("Raw scheduler state")).toBeInTheDocument();
  });

  it("separates processes and keeps prospective observation read-only", async () => {
    mockEndpoints();
    render(<LearningView marketId="CA_TSX" />);
    await waitFor(() => expect(getJsonMock).toHaveBeenCalledTimes(8));

    fireEvent.click(screen.getByRole("button", { name: "PROCESSES" }));
    expect(screen.getByText("Evidence and automation")).toBeInTheDocument();
    expect(screen.getByText("Calibration")).toBeInTheDocument();
    expect(screen.getByText("Prospective observation")).toBeInTheDocument();
    expect(screen.getByText(/model-v2/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /start|pause|resume|end|revoke/i }),
    ).not.toBeInTheDocument();
  });

  it("shows model lifecycle gates and the challenger acceptance report under Results", async () => {
    mockEndpoints();
    render(<LearningView marketId="CA_TSX" />);
    await waitFor(() => expect(getJsonMock).toHaveBeenCalledTimes(8));

    fireEvent.click(screen.getByRole("button", { name: "RESULTS" }));
    expect(screen.getByText("Model lifecycle")).toBeInTheDocument();
    expect(
      screen.getByText(/No statistical models trained yet/),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Prospective acceptance progress"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/No frozen acceptance plan is attached/),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText("Pending")).toBeInTheDocument(),
    );
    expect(screen.getByText("Missed deadline")).toBeInTheDocument();
    expect(screen.getByText("Capture unknown")).toBeInTheDocument();
    expect(screen.getByText(/Promotion authorized: No/)).toBeInTheDocument();
  });

  it("keeps raw decision facts and process counts in Diagnostics", async () => {
    mockEndpoints();
    render(<LearningView marketId="CA_TSX" />);
    await waitFor(() => expect(getJsonMock).toHaveBeenCalledTimes(8));

    fireEvent.click(screen.getByRole("button", { name: "DIAGNOSTICS" }));
    expect(screen.getByText("Decision drill-down")).toBeInTheDocument();
    expect(screen.getByText("Process summary")).toBeInTheDocument();
    expect(screen.getByText(/Unknown is not success/)).toBeInTheDocument();
  });

  it("labels the schedule as an estimate and surfaces an overdue check as needing review", async () => {
    mockEndpoints({
      ...overview,
      pipelineHealth: { ...overview.pipelineHealth, checkOverdue: true },
    });
    render(<LearningView marketId="CA_TSX" />);
    await waitFor(() => expect(getJsonMock).toHaveBeenCalledTimes(8));

    expect(screen.getByText("OVERDUE")).toBeInTheDocument();
    expect(
      screen.getByText(/The previous check is overdue for this schedule/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/scheduled evidence check is overdue for its cadence/),
    ).toBeInTheDocument();
    expect(screen.getByText("schedule basis")).toBeInTheDocument();
  });

  it("refreshes the selected challenger report with the overview lifecycle", async () => {
    mockEndpoints();
    render(<LearningView marketId="CA_TSX" />);
    await waitFor(() => expect(getJsonMock).toHaveBeenCalledTimes(8));

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
    await waitFor(() => expect(getJsonMock).toHaveBeenCalledTimes(16));
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
    await waitFor(() => expect(getJsonMock).toHaveBeenCalledTimes(8));

    fireEvent.click(screen.getByRole("button", { name: "RESULTS" }));
    await waitFor(() =>
      expect(screen.getByText("Pending")).toBeInTheDocument(),
    );

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });
    await waitFor(() => expect(reportCalls).toBe(2));
    // The report still belongs to the selected experiment, so the failed
    // background refresh must not blank it.
    expect(screen.getByText("Pending")).toBeInTheDocument();
    expect(
      screen.getByText(
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
    await waitFor(() => expect(getJsonMock).toHaveBeenCalledTimes(8));
    fireEvent.click(screen.getByRole("button", { name: "RESULTS" }));
    await waitFor(() =>
      expect(screen.getByText("Pending")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "PROCESSES" }));
    fireEvent.click(screen.getByRole("button", { name: /model-v3/ }));
    fireEvent.click(screen.getByRole("button", { name: "RESULTS" }));
    expect(screen.queryByText("Pending")).not.toBeInTheDocument();
    expect(screen.getByText("Loading selected report…")).toBeInTheDocument();
    await act(async () => {
      resolveReport({
        experiment: otherExperiment,
        report: { ...report, experimentId: otherId },
      });
    });
    expect(screen.getByText("Pending")).toBeInTheDocument();
  });
});
