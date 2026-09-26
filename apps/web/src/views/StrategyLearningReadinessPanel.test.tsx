import type { StrategyLearningScope } from "@tsx-scanner/contracts";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StrategyLearningReadinessPanel } from "./StrategyLearningReadinessPanel.js";

const { getJsonMock } = vi.hoisted(() => ({ getJsonMock: vi.fn() }));
vi.mock("../lib/api.js", () => ({ getJson: getJsonMock }));

const scope: StrategyLearningScope = {
  marketId: "CA_TSX",
  strategyKey: "ORB_RETEST",
  profileConfigId: "33333333-3333-4333-8333-333333333333",
  strategyVersion: "strategy-v1",
  configVersion: "config-v1",
  executionModelVersion: "execution-v1",
  executionAssumptions: { slippageBps: 2 },
};

const readiness = {
  sourceKind: "BACKTEST_RUN",
  scope,
  state: "WAITING_FOR_EVIDENCE",
  targetDistinctTrades: 30,
  verifiedSessions: 2,
  distinctClosedTrades: 4,
  usableModelRows: 2,
  qualificationCounts: { EVIDENCE_QUALIFIED: 1, EXPLORATORY: 3 },
  exclusions: { MISSING_LABEL: 1 },
  strata: {
    time: { OPEN: 2 },
    atr: { LOW: 2 },
    rvol: { HIGH: 1 },
  },
  blockers: ["DATASET_DERIVATION_UNPROVEN"],
  shortfall: 26,
  feasibility: {
    state: "UNAVAILABLE",
    reason: "MISSING_PREDECLARED_EXPERIMENT_CRITERIA",
  },
  collectionEstimate: {
    state: "UNAVAILABLE",
    reason: "NO_VERIFIED_SESSIONS",
    observedRateMin: null,
    observedRateMax: null,
    observedSessions: 0,
  },
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("StrategyLearningReadinessPanel", () => {
  it("explains why readiness is unavailable when the selected run lacks exact scope", () => {
    render(<StrategyLearningReadinessPanel scope={null} />);

    expect(
      screen.getByRole("region", { name: "Strategy learning readiness" }),
    ).toHaveTextContent("Readiness unavailable for this run");
    expect(
      screen.getByText(/exact profile configuration and execution scope/),
    ).toBeInTheDocument();
    expect(getJsonMock).not.toHaveBeenCalled();
  });

  it("shows raw distinct closed outcomes separately from qualification and renders blockers", async () => {
    getJsonMock.mockResolvedValue(readiness);
    render(<StrategyLearningReadinessPanel scope={scope} />);

    expect(
      await screen.findByText(
        "4 / 30 raw distinct closed outcomes across compatible runs",
      ),
    ).toBeInTheDocument();
    const panel = screen.getByRole("region", {
      name: "Strategy learning readiness",
    });
    expect(panel).toHaveTextContent(/Evidence-qualified distinct outcomes\s*1/);
    expect(panel).toHaveTextContent(/Exploratory distinct outcomes\s*3/);
    expect(screen.getByText("DATASET_DERIVATION_UNPROVEN")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Collection estimate unavailable: no verified sessions are available.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Feasibility unavailable: the report lacks predeclared minimum effect, outcome variance, significance level, target power, and comparison design.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Raw distinct outcomes accumulate across compatible runs/,
      ),
    ).toBeInTheDocument();
    expect(getJsonMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/learning/strategy-readiness?"),
      expect.any(AbortSignal),
    );
  });

  it("resolves selected run scope through the API and renders the scoped report", async () => {
    getJsonMock.mockResolvedValue(readiness);
    render(
      <StrategyLearningReadinessPanel
        scope={null}
        runContext={{
          runId: "44444444-4444-4444-8444-444444444444",
          marketId: "CA_TSX",
          status: "COMPLETED",
          strategies: ["ORB_RETEST"],
        }}
      />,
    );

    expect(
      await screen.findByText(
        "4 / 30 raw distinct closed outcomes across compatible runs",
      ),
    ).toBeInTheDocument();
    expect(getJsonMock).toHaveBeenCalledWith(
      expect.stringContaining(
        "/api/learning/backtest-runs/44444444-4444-4444-8444-444444444444/strategy-readiness?strategyKey=ORB_RETEST&marketId=CA_TSX",
      ),
      expect.any(AbortSignal),
    );
  });

  it("does not show a prior market response after scope changes", async () => {
    let resolveOld!: (value: unknown) => void;
    getJsonMock.mockImplementation((url: string) => {
      if (url.includes("CA_TSX"))
        return new Promise((resolve) => (resolveOld = resolve));
      return Promise.resolve({
        ...readiness,
        scope: { ...scope, marketId: "US_EQUITIES" },
        distinctClosedTrades: 9,
      });
    });
    const { rerender } = render(
      <StrategyLearningReadinessPanel scope={scope} />,
    );
    const usScope = { ...scope, marketId: "US_EQUITIES" as const };
    rerender(<StrategyLearningReadinessPanel scope={usScope} />);

    expect(
      await screen.findByText(
        "9 / 30 raw distinct closed outcomes across compatible runs",
      ),
    ).toBeInTheDocument();
    resolveOld(readiness);
    await waitFor(() =>
      expect(
        screen.getByText(
          "9 / 30 raw distinct closed outcomes across compatible runs",
        ),
      ).toBeInTheDocument(),
    );
    expect(
      screen.queryByText(
        "4 / 30 raw distinct closed outcomes across compatible runs",
      ),
    ).not.toBeInTheDocument();
  });

  it("does not show a prior selected-run market response after the market changes", async () => {
    let resolveCanadian!: (value: unknown) => void;
    getJsonMock.mockImplementation((url: string) => {
      if (url.includes("marketId=CA_TSX"))
        return new Promise((resolve) => (resolveCanadian = resolve));
      return Promise.resolve({
        ...readiness,
        scope: { ...scope, marketId: "US_EQUITIES" },
        distinctClosedTrades: 9,
      });
    });
    const runContext = {
      runId: "44444444-4444-4444-8444-444444444444",
      marketId: "CA_TSX",
      status: "COMPLETED",
      strategies: ["ORB_RETEST"],
    };
    const { rerender } = render(
      <StrategyLearningReadinessPanel scope={null} runContext={runContext} />,
    );
    rerender(
      <StrategyLearningReadinessPanel
        scope={null}
        runContext={{ ...runContext, marketId: "US_EQUITIES" }}
      />,
    );

    expect(
      await screen.findByText(
        "9 / 30 raw distinct closed outcomes across compatible runs",
      ),
    ).toBeInTheDocument();
    resolveCanadian(readiness);
    await waitFor(() =>
      expect(
        screen.getByText(
          "9 / 30 raw distinct closed outcomes across compatible runs",
        ),
      ).toBeInTheDocument(),
    );
    expect(
      screen.queryByText(
        "4 / 30 raw distinct closed outcomes across compatible runs",
      ),
    ).not.toBeInTheDocument();
  });
});
