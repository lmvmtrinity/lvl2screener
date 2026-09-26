import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { HistoricalImportProgress } from "./HistoricalImportProgress.js";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("shows stopped imports and saved chunk progress", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            tasks: [
              {
                id: "1",
                kind: "Bars (step 3)",
                status: "Stopped",
                startDate: "2025-01-01",
                endDate: "2025-12-31",
                planned: 100,
                completed: 20,
                failed: 0,
                skipped: 5,
                rows: 1234,
                estimatedCostUsd: 0,
                current: "COIN",
                updatedAt: "2026-09-26T12:00:00Z",
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        ),
    ),
  );
  render(<HistoricalImportProgress />);
  expect(
    await screen.findByText("Bars (step 3) — Stopped"),
  ).toBeInTheDocument();
  expect(screen.getByText(/20 \/ 100 chunks/)).toBeInTheDocument();
  expect(screen.getByText(/Rerun the same command/)).toBeInTheDocument();
});
