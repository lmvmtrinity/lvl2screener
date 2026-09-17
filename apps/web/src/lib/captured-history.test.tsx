import { render, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { getJson } from "./api.js";
import { useCapturedHistoryFormGuard } from "./captured-history.js";

vi.mock("./api.js", () => ({ getJson: vi.fn() }));

function availability(
  earliestDate: string,
  latestDate: string,
  limitations?: unknown[],
) {
  return {
    source: "CAPTURED_QUOTES",
    observedAt: "2026-09-11T00:00:00.000Z",
    tables: {
      quoteSnapshot: { earliest: null, latest: null },
      candle: { earliest: null, latest: null },
    },
    replay: { earliestDate, latestDate },
    ...(limitations === undefined ? {} : { limitations }),
  };
}

const interiorGap = {
  marketId: "CA_TSX",
  kind: "INTERIOR_NO_QUOTE",
  basis: "QUOTE_GAP_WITH_BACKFILLED_CANDLES",
  startAt: "2026-09-14T13:39:05.524Z",
  endAt: "2026-09-14T15:25:29.153Z",
  sessionDates: ["2026-09-14"],
  detail:
    "No forward quotes were retained through this interval although completed candles exist inside it.",
  evaluatedFrom: "2026-08-15T00:00:00.000Z",
  evaluatedThrough: "2026-09-15T00:00:00.000Z",
};

function FormFixture() {
  useCapturedHistoryFormGuard("2026-09-01", "2026-09-10", "CA_TSX");
  return (
    <form className="backtest-form">
      <input type="date" aria-label="start" />
      <button className="run-backtest" type="button">
        Run
      </button>
    </form>
  );
}

describe("captured-history availability scoping", () => {
  it("requests availability for the selected market and refetches on change", async () => {
    vi.mocked(getJson).mockResolvedValue(
      availability("2026-08-31", "2026-09-11"),
    );
    const { rerender } = renderHook(
      ({ marketId }: { marketId: "CA_TSX" | "US_EQUITIES" }) =>
        useCapturedHistoryFormGuard("2026-09-01", "2026-09-10", marketId),
      {
        initialProps: {
          marketId: "CA_TSX" as "CA_TSX" | "US_EQUITIES",
        },
      },
    );

    await waitFor(() =>
      expect(getJson).toHaveBeenCalledWith(
        "/api/captured-history/availability?marketId=CA_TSX",
      ),
    );

    rerender({ marketId: "US_EQUITIES" as const });
    await waitFor(() =>
      expect(getJson).toHaveBeenCalledWith(
        "/api/captured-history/availability?marketId=US_EQUITIES",
      ),
    );
  });

  it("surfaces the interior no-quote limitation on the existing backtest form", async () => {
    vi.mocked(getJson).mockResolvedValue(
      availability("2026-08-31", "2026-09-15", [interiorGap]),
    );
    render(<FormFixture />);
    await waitFor(() =>
      expect(
        document.querySelector<HTMLFormElement>(".backtest-form")?.dataset
          .capturedHistory ?? "",
      ).toMatch(/Forward quotes are missing/),
    );
    const message =
      document.querySelector<HTMLFormElement>(".backtest-form")?.dataset
        .capturedHistory ?? "";
    expect(message).toContain("2026-09-14");
    expect(message).toContain("do not replace the missing quotes");
  });

  it("marks an older snapshot without a recorded gap assessment as not assessed", async () => {
    vi.mocked(getJson).mockResolvedValue(
      availability("2026-08-31", "2026-09-15"),
    );
    render(<FormFixture />);
    await waitFor(() =>
      expect(
        document.querySelector<HTMLFormElement>(".backtest-form")?.dataset
          .capturedHistory ?? "",
      ).toContain("Interior quote-gap limits were not recorded"),
    );
  });

  it("does not claim a limitation when the evaluated window is clean", async () => {
    vi.mocked(getJson).mockResolvedValue(
      availability("2026-08-31", "2026-09-15", []),
    );
    render(<FormFixture />);
    await waitFor(() =>
      expect(
        document.querySelector<HTMLFormElement>(".backtest-form")?.dataset
          .capturedHistory ?? "",
      ).toMatch(/Captured quotes available/),
    );
    const message =
      document.querySelector<HTMLFormElement>(".backtest-form")?.dataset
        .capturedHistory ?? "";
    expect(message).not.toContain("Forward quotes are missing");
    expect(message).not.toContain("not recorded");
  });
});
