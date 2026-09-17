import { describe, expect, it } from "vitest";
import { QuestradeDataService } from "../src/market-data/service.js";

/**
 * Exercise the narrow failure boundary without constructing a live Questrade
 * session. The funded processor is deliberately isolated from the legacy
 * processor, so a structural service fixture is sufficient here.
 */
function fixture() {
  let failures = 0;
  const service = Object.create(QuestradeDataService.prototype) as Record<
    string,
    any
  >;
  service.paperBotRunId = "run-1";
  service.paperBotStore = {};
  service.paperFundedBound = true;
  service.instruments = [];
  service.clock = () => new Date("2026-09-06T14:00:00.000Z");
  service.logger = { info: () => undefined, error: () => undefined };
  service.paperFundedAdapter = {
    retainedQuotes: async () => [],
    process: async () => {
      throw new Error("funded transport unavailable");
    },
    recordRecoveryFailure: () => ++failures,
  };
  return service;
}

function fundedSnapshot(service: Record<string, any>) {
  return service.paperBotSnapshot().funded;
}

describe("funded recovery observability", () => {
  it("publishes the first failure before any successful funded snapshot", async () => {
    const service = fixture();

    await expect(service.processFundedPaperBot(new Map(), [])).resolves.toBe(
      false,
    );

    expect(fundedSnapshot(service)).toMatchObject({
      closePendingOrders: 0,
      riskVetoesTotal: 0,
      coverageGapsTotal: 0,
      recoveryFailuresTotal: 1,
    });
  });

  it("keeps persistent failures monotonic and survives legacy success state", async () => {
    const service = fixture();

    await service.processFundedPaperBot(new Map(), []);
    expect(fundedSnapshot(service).recoveryFailuresTotal).toBe(1);

    await service.processFundedPaperBot(new Map(), []);
    expect(fundedSnapshot(service).recoveryFailuresTotal).toBe(2);

    // A successful legacy cycle clears its own error state; it must not erase
    // the funded recovery counter that operators use to detect this outage.
    service.paperBotLastError = undefined;
    expect(fundedSnapshot(service).recoveryFailuresTotal).toBe(2);
  });
});
