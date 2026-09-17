import { describe, expect, it, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { getJson } from "../lib/api.js";
vi.mock("../lib/api.js", () => ({ getJson: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
import { EvidenceAutomationPanel } from "./EvidenceAutomationPanel.js";
import type { EvidenceAutomationStage } from "@tsx-scanner/contracts";

const stage = (
  key: EvidenceAutomationStage["key"],
): EvidenceAutomationStage => ({
  key,
  marketId: "CA_TSX",
  scopeId: "CA_TSX:test",
  state: key === "COVERAGE" ? "UNKNOWN" : "WAITING",
  asOf: "2026-09-10T12:00:00.000Z",
  lastAttemptAt: null,
  lastSuccessAt: null,
  nextCheckAt: null,
  progress: null,
  reasonCodes: ["NO_DURABLE_HISTORY"],
  nextAction: { kind: "AUTOMATIC", label: "The worker will check again" },
  jobId: null,
  reportId: null,
});

describe("EvidenceAutomationPanel", () => {
  it("opens the exact retained report with its market and shows historical success", async () => {
    vi.mocked(getJson).mockResolvedValue({
      status: "UNKNOWN",
      marketId: "CA_TSX",
      reason: "No retained input provenance",
    });
    render(
      <EvidenceAutomationPanel
        marketId="CA_TSX"
        stages={[
          {
            ...stage("COVERAGE"),
            reportId: "a".repeat(64),
            lastSuccessAt: "2026-09-09T17:00:00.000Z",
          },
        ]}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Inspect saved coverage report" }),
    );
    expect(
      await screen.findByText("No retained input provenance"),
    ).toBeTruthy();
    expect(getJson).toHaveBeenCalledWith(
      `/api/learning/evidence-artifacts/COVERAGE/${"a".repeat(64)}?marketId=CA_TSX`,
      expect.any(AbortSignal),
    );
    expect(screen.getByText("Last success")).toBeTruthy();
  });
  it("shows all six durable lanes and an accessible explanation trigger", () => {
    render(
      <EvidenceAutomationPanel
        marketId="CA_TSX"
        stages={[
          stage("COVERAGE"),
          stage("QUALIFICATION"),
          stage("STUDY"),
          stage("TRAINING"),
          stage("FORWARD_OBSERVATION"),
          stage("DIAGNOSTICS"),
        ]}
      />,
    );
    expect(screen.getByText("Evidence and automation")).toBeTruthy();
    expect(screen.getAllByText("WAITING FOR EVIDENCE")).toHaveLength(5);
    expect(screen.getByText("UNKNOWN")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /Explain/ })).toHaveLength(6);
  });

  it("shows active retry progress and dates the preserved historical failure", () => {
    const { container } = render(
      <EvidenceAutomationPanel
        marketId="CA_TSX"
        stages={[
          {
            ...stage("COVERAGE"),
            scopeId: "current-retry",
            state: "RUNNING",
            lastAttemptAt: "2026-09-14T19:31:00.000Z",
            progress: { completed: 3, total: 10, unit: "sessions" },
            relatedScopes: [
              {
                scopeId: "historical-failure",
                state: "FAILED",
                lastAttemptAt: "2026-09-12T12:00:00.000Z",
                progress: null,
                reasonCodes: ["EVIDENCE_RUNTIME_MISMATCH"],
                jobId: "10000000-0000-4000-8000-000000000983",
                reportId: null,
              },
            ],
          },
        ]}
      />,
    );

    expect(screen.getByText("3/10 sessions")).toBeTruthy();
    expect(
      container.querySelector('time[datetime="2026-09-14T19:31:00.000Z"]'),
    ).not.toBeNull();
    fireEvent.click(screen.getByText("Other retained scopes (1)"));
    expect(screen.getByText(/historical-failure: FAILED/)).toBeTruthy();
    expect(
      container.querySelector('time[datetime="2026-09-12T12:00:00.000Z"]'),
    ).not.toBeNull();
  });

  it("keeps retained UNKNOWN reports navigable from related history", async () => {
    vi.mocked(getJson).mockResolvedValue({
      status: "UNKNOWN",
      marketId: "CA_TSX",
      reason: "No retained input provenance",
    });
    render(
      <EvidenceAutomationPanel
        marketId="CA_TSX"
        stages={[
          {
            ...stage("COVERAGE"),
            scopeId: "current-retry",
            state: "RUNNING",
            lastAttemptAt: "2026-09-14T19:31:00.000Z",
            progress: { completed: 3, total: 10, unit: "sessions" },
            relatedScopes: [
              {
                scopeId: "retained-unknown",
                state: "UNKNOWN",
                lastAttemptAt: "2026-09-13T17:00:00.000Z",
                progress: null,
                reasonCodes: ["COVERAGE_UNKNOWN"],
                jobId: null,
                reportId: "b".repeat(64),
              },
            ],
          },
        ]}
      />,
    );
    expect(screen.getByText("3/10 sessions")).toBeTruthy();
    fireEvent.click(screen.getByText("Other retained scopes (1)"));
    expect(screen.getByText(/retained-unknown: UNKNOWN/)).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Inspect saved report for retained-unknown",
      }),
    );
    expect(
      await screen.findByText("No retained input provenance"),
    ).toBeTruthy();
    expect(getJson).toHaveBeenCalledWith(
      `/api/learning/evidence-artifacts/COVERAGE/${"b".repeat(64)}?marketId=CA_TSX`,
      expect.any(AbortSignal),
    );
  });
});
