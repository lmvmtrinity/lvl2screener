import { describe, expect, it, vi } from "vitest";
import { QuestradeDataService } from "../src/market-data/service.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("live paper processing isolation", () => {
  it("retains recovery-only quote history and excludes facts beyond the batch boundary", async () => {
    const service = new QuestradeDataService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const internal = service as unknown as Record<string, any>;
    internal.clock = () => new Date("2099-02-02T15:00:00Z");
    internal.instruments = [{ id: "candidate" }];
    internal.paperBotRunId = "run";
    internal.paperFundedBound = true;
    internal.paperBotStore = {
      findEligibleObservationsForFunding: async () => [
        { signalTimestamp: "2099-02-02T15:00:01Z" },
      ],
      findFundedInvalidations: async () => [{ at: "2099-02-02T15:00:01Z" }],
    };
    const retainedQuotes = vi.fn(async () => []);
    const process = vi.fn(async () => ({ skippedQuotes: 0 }));
    internal.paperFundedAdapter = {
      retainedQuotes,
      process,
      operationalSnapshot: async () => ({}),
    };
    expect(
      await internal.processFundedPaperBot(
        new Map([["recovery", { timestamp: "2099-02-02T14:59:59Z" }]]),
        [],
      ),
    ).toBe(true);
    expect(retainedQuotes).toHaveBeenCalledWith(
      ["candidate", "recovery"],
      "2099-02-02T15:00:00.000Z",
    );
    expect(process).toHaveBeenCalledWith(
      expect.objectContaining({ observations: [], invalidations: [] }),
      { maxFacts: 100, maxDurationMs: 1000 },
    );
  });
  it("extends the funded cycle drain pass with the durable backlog", async () => {
    const service = new QuestradeDataService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const internal = service as unknown as Record<string, any>;
    internal.clock = () => new Date("2099-02-02T15:00:00Z");
    internal.instruments = [];
    internal.paperBotRunId = "run";
    internal.paperFundedBound = true;
    internal.paperFundedOperational = { pendingFacts: 4_100 };
    internal.paperBotStore = {
      findEligibleObservationsForFunding: async () => [],
      findFundedInvalidations: async () => [],
    };
    const process = vi.fn(async () => ({ skippedQuotes: 0 }));
    internal.paperFundedAdapter = {
      retainedQuotes: vi.fn(async () => []),
      process,
      operationalSnapshot: async () => ({ pendingFacts: 4_100 }),
    };
    expect(await internal.processFundedPaperBot(new Map(), [])).toBe(true);
    expect(process).toHaveBeenCalledWith(expect.anything(), {
      maxFacts: 500,
      maxDurationMs: 5_000,
    });
  });
  it("starts both market timers without waiting for either first cycle", async () => {
    vi.useFakeTimers();
    const gate = deferred();
    const make = () =>
      new QuestradeDataService(
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
      );
    const ca = make();
    const us = make();
    const caCycle = vi.spyOn(ca, "runCycle").mockReturnValue(gate.promise);
    const usCycle = vi.spyOn(us, "runCycle").mockResolvedValue();
    try {
      ca.start();
      us.start();
      expect(caCycle).toHaveBeenCalledOnce();
      expect(usCycle).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(2000);
      expect(usCycle).toHaveBeenCalledTimes(2);
    } finally {
      gate.resolve();
      await ca.stop();
      await us.stop();
      vi.useRealTimers();
    }
  });

  it("continues independent exits while one funded batch is blocked and waits on shutdown", async () => {
    const gate = deferred();
    const service = new QuestradeDataService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const internal = service as unknown as Record<string, any>;
    internal.clock = () => new Date("2099-02-02T15:00:00Z");
    internal.strategyStore = {};
    internal.paperFundedAdapter = {};
    internal.paperBotProcessor = {
      reconcileReadyEvents: vi.fn(async () => ({
        candidates: 0,
        skipped: [],
        eligibleObservations: [],
      })),
      evaluateOpenQuoteExecutions: vi.fn(async () => {}),
      evaluateOpenCoordinatedPositions: vi.fn(async () => {}),
    };
    internal.processFundedPaperBot = vi.fn(async () => {
      await gate.promise;
      return true;
    });
    await internal.processPaperBot([], []);
    await internal.processPaperBot([], []);
    expect(internal.processFundedPaperBot).toHaveBeenCalledOnce();
    expect(
      internal.paperBotProcessor.evaluateOpenQuoteExecutions,
    ).toHaveBeenCalledTimes(2);
    expect(
      internal.paperBotProcessor.evaluateOpenCoordinatedPositions,
    ).toHaveBeenCalledTimes(2);
    expect(service.getSnapshot().paperBot).toBeUndefined();
    let stopped = false;
    const stopping = service.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    gate.resolve();
    await stopping;
    expect(stopped).toBe(true);
    expect(internal.fundedLastSuccessAt).toBe("2099-02-02T15:00:00.000Z");
  });
});
