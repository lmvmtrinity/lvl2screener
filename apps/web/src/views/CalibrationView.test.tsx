import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  backtestMetricsSchema,
  calibrationRunSchema,
  createCalibrationSchema,
} from "@tsx-scanner/contracts";
import { getJson } from "../lib/api.js";
import { CalibrationView } from "./CalibrationView.js";

vi.mock("../lib/api.js", () => ({ getJson: vi.fn(), sendJson: vi.fn() }));
vi.mock("../lib/captured-history.js", () => ({
  useCapturedHistoryFormGuard: () => undefined,
  useCapturedHistoryRunSummary: () => undefined,
}));

describe("Calibration holdout presentation", () => {
  afterEach(cleanup);
  it.each([false, true])(
    "renders unevaluated TEST explicitly and preserves legacy metrics (legacy=%s)",
    async (legacy) => {
      const metrics = backtestMetricsSchema.parse({
        ...Object.fromEntries(
          Object.keys(backtestMetricsSchema.shape).map((key) => [key, 0]),
        ),
        averageR: 0.5,
        tradesSimulated: 10,
      });
      const input = createCalibrationSchema.parse({
        name: "Holdout report",
        startDate: "2026-01-01",
        endDate: "2026-06-30",
        strategy: "ORB_RETEST",
      });
      const payload = {
        id: "10000000-0000-4000-8000-000000000099",
        name: input.name,
        marketId: "CA_TSX",
        status: "COMPLETED",
        startDate: input.startDate,
        endDate: input.endDate,
        strategy: input.strategy,
        symbols: [],
        dataSource: "CAPTURED_QUOTES",
        input,
        combinationsTested: 1,
        totalCombinations: 1,
        truncated: false,
        splitDates: { trainEnd: "2026-04-18", validationEnd: "2026-05-24" },
        recommendation: "Insufficient evidence",
        recommendedConfig: null,
        trials: [
          {
            rank: 1,
            configVersion: "fixture",
            parameters: {
              openingRangeMinutes: 15,
              entryWindowEnd: "11:30",
              stopMethod: "STRUCTURAL",
              rewardRiskRatio: 2,
            },
            segments: {
              TRAIN: metrics,
              VALIDATION: metrics,
              TEST: legacy ? metrics : null,
              ALL: legacy ? metrics : null,
            },
            robustScore: 0.5,
            plateauSize: 1,
            sufficientSample: false,
            outOfSamplePositive: false,
            warnings: [],
            analyses: [],
            ...(legacy ? {} : { analysesScope: "VALIDATION" }),
          },
        ],
        error: null,
        createdAt: "2026-07-01T00:00:00.000Z",
        startedAt: null,
        completedAt: null,
      };
      vi.mocked(getJson).mockResolvedValue(payload);
      render(
        <CalibrationView
          runs={[calibrationRunSchema.parse(payload)]}
          updated={() => undefined}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: /Holdout report/ }));
      expect(
        await screen.findByText(
          legacy
            ? "Slice coverage: all dates."
            : "Slice coverage: validation segment.",
        ),
      ).toBeInTheDocument();
      if (legacy) {
        expect(screen.queryByText("Not evaluated")).not.toBeInTheDocument();
        expect(screen.getAllByText("0.50R")).toHaveLength(3);
      } else {
        expect(screen.getByText("Not evaluated")).toBeInTheDocument();
        expect(screen.getAllByText("0.50R")).toHaveLength(2);
      }
    },
  );
});
