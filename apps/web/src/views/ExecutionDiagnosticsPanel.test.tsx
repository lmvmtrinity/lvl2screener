import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExecutionDiagnosticsPanel } from "./ExecutionDiagnosticsPanel.js";

const run = {
  id: "10000000-0000-4000-8000-000000000701",
  source: "LIVE",
  sessionDate: "2026-09-10",
  sessionTimezone: "America/Toronto",
  scheduledCloseAt: "2026-09-10T20:00:00.000Z",
  status: "COMPLETED",
  executionModelVersion: "paper-execution-v1",
  assumptions: {},
  startedAt: "2026-09-10T13:30:00.000Z",
  completedAt: "2026-09-10T20:00:00.000Z",
  failedAt: null,
  failureReason: null,
};

const report = {
  reportVersion: "execution-diagnostics-v1",
  sourceDigest: "a".repeat(64),
  generatedAt: "2026-09-10T20:01:00.000Z",
  scope: {
    marketId: "CA_TSX",
    currency: "CAD",
    accountId: "10000000-0000-4000-8000-000000000702",
    selectedRunId: run.id,
    runIds: [run.id],
    temporalScope: "RUN_END",
    asOf: "2026-09-10T20:00:00.000Z",
  },
  replenishment: {
    scope: {
      marketId: "CA_TSX",
      currency: "CAD",
      accountId: "10000000-0000-4000-8000-000000000702",
      selectedRunId: run.id,
      runIds: [run.id],
      temporalScope: "RUN_END",
      asOf: "2026-09-10T20:00:00.000Z",
    },
    stretches: [],
    excluded: [],
    unlinkedFillShares: { BID: 0, ASK: 0 },
    unavailable: ["UNVERIFIED_EVENT_SEQUENCE"],
  },
  contention: {
    scope: {
      marketId: "CA_TSX",
      currency: "CAD",
      accountId: "10000000-0000-4000-8000-000000000702",
      selectedRunId: run.id,
      runIds: [run.id],
      temporalScope: "RUN_END",
      asOf: "2026-09-10T20:00:00.000Z",
    },
    rows: [],
  },
};

function response(status: "READY" | "PENDING") {
  return {
    status,
    runId: run.id,
    accountId: "10000000-0000-4000-8000-000000000702",
    marketId: "CA_TSX",
    currency: "CAD",
    temporalScope: "RUN_END",
    asOf: "2026-09-10T20:00:00.000Z",
    reportId:
      status === "READY" ? "10000000-0000-4000-8000-000000000703" : null,
    jobId: status === "PENDING" ? "10000000-0000-4000-8000-000000000704" : null,
    reportVersion: "execution-diagnostics-v1",
    sourceDigest: status === "READY" ? "a".repeat(64) : null,
    generatedAt: status === "READY" ? "2026-09-10T20:01:00.000Z" : null,
    report: status === "READY" ? report : null,
    reason: status === "PENDING" ? "DIAGNOSTICS_JOB_PENDING" : null,
  };
}

describe("ExecutionDiagnosticsPanel", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows freshness, unknown evidence and accessible explanations", async () => {
    const fetch = vi.fn(
      async (input: RequestInfo | URL) =>
        new Response(
          JSON.stringify(
            String(input).includes("execution-diagnostics")
              ? response("READY")
              : { runs: [run] },
          ),
          { headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetch);
    render(<ExecutionDiagnosticsPanel />);

    await waitFor(() => expect(screen.getByText("READY")).toBeInTheDocument());
    expect(screen.getByText("UNKNOWN")).toBeInTheDocument();
    fireEvent.mouseEnter(screen.getByText("UNKNOWN").parentElement!);
    await waitFor(() =>
      expect(
        screen.getByRole("tooltip", { name: /Unknown includes/i }),
      ).toBeInTheDocument(),
    );
    expect(String(fetch.mock.calls.at(-1)?.[0])).toContain("mode=RUN_END");
  });

  it("keeps a pending report visible instead of displaying zero evidence", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (input: RequestInfo | URL) =>
          new Response(
            JSON.stringify(
              String(input).includes("execution-diagnostics")
                ? response("PENDING")
                : { runs: [run] },
            ),
            { headers: { "content-type": "application/json" } },
          ),
      ),
    );
    render(<ExecutionDiagnosticsPanel />);
    await waitFor(() =>
      expect(screen.getAllByText("PENDING").length).toBeGreaterThan(0),
    );
    expect(screen.getByText("DIAGNOSTICS_JOB_PENDING")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
  });
});
