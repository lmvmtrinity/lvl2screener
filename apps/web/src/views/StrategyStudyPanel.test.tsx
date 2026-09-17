import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getJson } from "../lib/api.js";
import {
  StrategyStudyPanel,
  StudyComparisonSummary,
} from "./StrategyStudyPanel.js";
import type { StrategyStudyReport } from "@tsx-scanner/contracts";

vi.mock("../lib/api.js", () => ({
  getJson: vi.fn(),
  sendJson: vi.fn(),
}));

describe("StrategyStudyPanel", () => {
  afterEach(() => vi.clearAllMocks());

  it("labels current native currency and refuses historical mislabeled currency", () => {
    const report = {
      calculationVersion: "study-report-v2",
      comparison: { unit: "CAD", estimate: 50, lower: 40, upper: 60 },
    } as StrategyStudyReport;
    const { rerender } = render(<StudyComparisonSummary report={report} />);
    expect(screen.getByText(/paired 50.000 CAD/)).toBeInTheDocument();
    rerender(
      <StudyComparisonSummary
        report={{ ...report, calculationVersion: undefined }}
      />,
    );
    expect(
      screen.getByText(/LEGACY_CURRENCY_AGGREGATION_UNVERIFIED/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/50.000/)).not.toBeInTheDocument();
  });

  it("shows durable empty state and review guard for a concrete market", async () => {
    vi.mocked(getJson).mockResolvedValue({ studies: [] });
    render(<StrategyStudyPanel marketId="US_EQUITIES" />);
    expect(screen.getByText("Frozen comparative studies")).toBeInTheDocument();
    expect(screen.getByText("NO ACTIVATION")).toBeInTheDocument();
    expect(
      await screen.findByText("No retained studies for this market."),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(getJson).toHaveBeenCalledWith(
        "/api/strategy-studies?marketId=US_EQUITIES",
        expect.any(AbortSignal),
      ),
    );
  });
});
