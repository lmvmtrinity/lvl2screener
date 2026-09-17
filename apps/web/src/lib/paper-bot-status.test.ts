import { describe, expect, it } from "vitest";
import { derivePaperBotIndicator } from "./paper-bot-status.js";
import type { PaperBotStatus } from "../types.js";

const healthy = (overrides: Partial<PaperBotStatus> = {}): PaperBotStatus => ({
  runId: "run-1",
  sessionDate: "2026-08-24",
  scheduledCloseAt: "2026-08-24T16:00:00.000Z",
  executionModelVersion: "paper-execution-v1",
  openExecutions: 0,
  closePendingExecutions: 0,
  closedExecutions: 0,
  noFillExecutions: 0,
  reconciliationBacklog: 0,
  unreconcilableEvents: 0,
  overdueRuns: 0,
  abandonedExecutions: 0,
  lastTransitionAt: null,
  lastProcessingDurationMs: 3,
  lastSuccessfulProcessingAt: "2026-08-24T15:00:00.000Z",
  lastError: null,
  ...overrides,
});

describe("derivePaperBotIndicator", () => {
  it("does not report LIVE before the first successful cycle", () => {
    expect(
      derivePaperBotIndicator(healthy({ lastSuccessfulProcessingAt: null }))
        .label,
    ).toBe("STARTING");
  });
  it("reports funded backlog even when there is no processing error", () => {
    const result = derivePaperBotIndicator(
      healthy({
        funded: { pendingFacts: 40, oldestPendingFactAgeMs: 130000 },
        fundedProcessing: true,
      }),
    );
    expect(result.label).toBe("CATCHING UP");
    expect(result.detail.join(" ")).toContain("40 funded facts pending");
  });
  it("reports OFF when the bot is not wired into the process", () => {
    const indicator = derivePaperBotIndicator(undefined);
    expect(indicator.tone).toBe("idle");
    expect(indicator.label).toBe("OFF");
  });

  it("reports IDLE when no live run is open yet", () => {
    // The state a stranded refresh token produces: the process is healthy but
    // market data never initialized, so no run exists.
    const indicator = derivePaperBotIndicator(healthy({ runId: null }));
    expect(indicator.tone).toBe("idle");
    expect(indicator.label).toBe("IDLE");
    expect(indicator.summary).toContain("authenticated");
  });

  it("reports LIVE while collecting with nothing unresolved", () => {
    const indicator = derivePaperBotIndicator(healthy());
    expect(indicator.tone).toBe("ok");
    expect(indicator.label).toBe("LIVE");
  });

  it("counts open and close-pending executions as the live position count", () => {
    const indicator = derivePaperBotIndicator(
      healthy({ openExecutions: 2, closePendingExecutions: 3 }),
    );
    expect(indicator.tone).toBe("ok");
    expect(indicator.label).toBe("LIVE 5");
    // Unresolved positions never enter closed-trade performance, and the
    // tooltip has to say so rather than implying five open P&L positions.
    expect(indicator.summary).toContain("excluded from closed-trade");
  });

  it("surfaces a stuck event even while the bot is otherwise collecting", () => {
    const indicator = derivePaperBotIndicator(
      healthy({ unreconcilableEvents: 1, openExecutions: 4 }),
    );
    expect(indicator.tone).toBe("error");
    expect(indicator.label).toBe("STUCK");
    expect(indicator.summary).toContain("1 READY event");
  });

  it("surfaces an overdue run awaiting an actionable bid", () => {
    const indicator = derivePaperBotIndicator(healthy({ overdueRuns: 2 }));
    expect(indicator.tone).toBe("attention");
    expect(indicator.label).toBe("OVERDUE");
    expect(indicator.summary).toContain("2 earlier runs");
  });

  it("blocks healthy presentation when a completed run owns an unresolved position", () => {
    const indicator = derivePaperBotIndicator(
      healthy({ completedRunsWithUnresolvedCoordinatedPositions: 1 }),
    );
    expect(indicator.tone).toBe("error");
    expect(indicator.label).toBe("ORPHAN");
    expect(indicator.summary).toContain(
      "New coordinated approvals are blocked",
    );
  });

  it("surfaces unknown quote-size units as a fail-closed error", () => {
    const indicator = derivePaperBotIndicator(
      healthy({ unknownQuoteSizeUnits: 2 }),
    );
    expect(indicator.tone).toBe("error");
    expect(indicator.label).toBe("SIZE UNIT");
    expect(indicator.summary).toContain("fail-closed");
  });

  it.each([null, "2026-08-24T15:00:00.000Z"])(
    "surfaces reconciliation backlog with last successful cycle %s",
    (lastSuccessfulProcessingAt) => {
      const indicator = derivePaperBotIndicator(
        healthy({ reconciliationBacklog: 3, lastSuccessfulProcessingAt }),
      );
      expect(indicator.tone).toBe("attention");
      expect(indicator.label).toBe("CATCHING UP");
    },
  );

  it("ranks a cycle error above every other condition", () => {
    const indicator = derivePaperBotIndicator(
      healthy({
        lastError: "connection terminated",
        unreconcilableEvents: 5,
        overdueRuns: 2,
      }),
    );
    expect(indicator.tone).toBe("error");
    expect(indicator.label).toBe("ERROR");
    expect(indicator.summary).toContain("connection terminated");
  });

  it("carries the cohort identity and counts in its detail lines", () => {
    const detail = derivePaperBotIndicator(
      healthy({ openExecutions: 1, closedExecutions: 7, noFillExecutions: 2 }),
    ).detail.join(" | ");
    expect(detail).toContain("Session 2026-08-24");
    expect(detail).toContain("Model paper-execution-v1");
    expect(detail).toContain("1 open");
    expect(detail).toContain("7 closed");
    expect(detail).toContain("2 no-fill");
  });

  it("names abandoned executions so they are not read as still waiting", () => {
    const indicator = derivePaperBotIndicator(
      healthy({ abandonedExecutions: 1 }),
    );
    expect(indicator.detail.join(" | ")).toContain(
      "1 execution abandoned past the close horizon",
    );
  });
});
