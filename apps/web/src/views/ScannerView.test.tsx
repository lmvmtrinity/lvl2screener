import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScannerAlert } from "@tsx-scanner/contracts";
import { AlertHistory, ScannerFilters } from "./ScannerView.js";
import type { BoardFilters } from "../types.js";

afterEach(cleanup);

const DEFAULT_FILTERS: BoardFilters = {
  state: "ALL",
  setup: "ALL",
  sector: "ALL",
  context: "ALL",
  readiness: "ALL",
  maximumSpread: "",
};

function alert(
  overrides: Partial<ScannerAlert> & Pick<ScannerAlert, "alertId" | "type">,
): ScannerAlert {
  return {
    eventId: "00000000-0000-4000-8000-000000000001",
    symbol: "CNQ.TO",
    strategy: "ORB_RETEST",
    profileId: "00000000-0000-4000-8000-000000000002",
    profileName: "Momentum core",
    strategyVersion: "1.0.0",
    configVersion: "config-v7",
    timestamp: "2026-09-08T14:00:00.000Z",
    previousState: "FORMING",
    state: "READY",
    score: 82,
    title: "Setup ready",
    message: "ORB retest armed",
    reasonCodes: [],
    setupInstanceId: null,
    entryReference: 21.5,
    stopReference: 21.1,
    targetReference: 22.3,
    ...overrides,
  };
}

describe("ScannerFilters", () => {
  it("summarizes active filters in the trigger and clears them from the popover", () => {
    const changed = vi.fn();
    render(
      <ScannerFilters
        filters={{ ...DEFAULT_FILTERS, state: "READY" }}
        sectors={["ENERGY"]}
        changed={changed}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Scanner filters" });
    expect(trigger).toHaveTextContent("FILTERS · 1");
    expect(trigger).toHaveClass("tw:text-accent");

    fireEvent.click(trigger);
    expect(
      screen.getByRole("dialog", { name: "Scanner filters" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "RESET" }));
    expect(changed).toHaveBeenCalledWith(DEFAULT_FILTERS);
  });

  it("shows a plain trigger when nothing is filtered", () => {
    render(
      <ScannerFilters
        filters={DEFAULT_FILTERS}
        sectors={[]}
        changed={() => {}}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Scanner filters" });
    expect(trigger).toHaveTextContent("FILTERS");
    expect(trigger).not.toHaveClass("tw:text-accent");
  });
});

describe("AlertHistory", () => {
  it("keeps READY and INVALIDATION icon backgrounds mutually exclusive", () => {
    render(
      <AlertHistory
        alerts={[
          alert({
            alertId: "11111111-1111-4111-8111-111111111111",
            type: "READY",
          }),
          alert({
            alertId: "22222222-2222-4222-8222-222222222222",
            type: "INVALIDATION",
            previousState: "READY",
            state: "INVALIDATED",
            title: "Setup invalidated",
            message: "Lost VWAP",
            score: 41,
          }),
        ]}
        select={() => {}}
      />,
    );

    const ready = screen.getByText("↑");
    expect(ready).toHaveClass("tw:bg-surface-raised");
    expect(ready).not.toHaveClass("tw:bg-surface-danger");

    const invalidation = screen.getByText("×");
    expect(invalidation).toHaveClass("tw:bg-surface-danger");
    expect(invalidation).not.toHaveClass("tw:bg-surface-raised");
  });
});
