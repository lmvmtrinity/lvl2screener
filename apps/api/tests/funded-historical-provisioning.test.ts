import { describe, expect, it, vi } from "vitest";
import { provisionHistoricalFundedRun } from "../src/paper-bot/funded-historical-provisioning.js";
import { fundedPolicy } from "../src/paper-bot/funded-policy.js";
import type { AssumptionsSnapshot } from "../src/paper-bot/types.js";

const assumptions = {
  positionSize: 10_000,
  slippageBps: 2,
  feePerTrade: 0,
  stopMethod: "STRUCTURAL",
  atrStopMultiple: 1,
  rewardRiskRatio: null,
} as AssumptionsSnapshot;

const input = {
  marketId: "CA_TSX" as const,
  sessionDate: "2026-09-08",
  sessionTimezone: "America/Toronto",
  scheduledCloseAt: "2026-09-08T20:00:00.000Z",
  sessionStartAt: "2026-09-08T13:30:00.000Z",
  assumptions,
  policy: fundedPolicy(),
  accountId: "10000000-0000-4000-8000-000000000090",
  currency: "CAD" as const,
  initialCash: 10_000,
  dailyLossLimit: 200,
};

describe("historical funded provisioning", () => {
  it("ensures the account before creating and binding the run", async () => {
    const order: string[] = [];
    const provisioned = await provisionHistoricalFundedRun({} as never, input, {
      findActiveRun: async () => {
        order.push("find");
        return undefined;
      },
      ensureLedger: async (accountId) => {
        order.push(`ledger:${accountId}`);
      },
      startRun: async () => {
        order.push("run");
        return { id: "run-1" } as never;
      },
      bind: async (runId) => {
        order.push(`bind:${runId}`);
      },
    });
    expect(order).toEqual([
      "find",
      `ledger:${input.accountId}`,
      "run",
      "bind:run-1",
    ]);
    expect(provisioned).toEqual({
      runId: "run-1",
      accountId: input.accountId,
      reused: false,
    });
  });

  it("reuses an active provisioned run instead of creating a second one", async () => {
    const startRun = vi.fn();
    const bind = vi.fn();
    const result = await provisionHistoricalFundedRun({} as never, input, {
      findActiveRun: async () => ({
        runId: "run-existing",
        accountId: input.accountId,
        reused: true,
      }),
      startRun,
      bind,
    });
    expect(result).toEqual({
      runId: "run-existing",
      accountId: input.accountId,
      reused: true,
    });
    expect(startRun).not.toHaveBeenCalled();
    expect(bind).not.toHaveBeenCalled();
  });

  it("fails the run and rethrows when binding is rejected", async () => {
    const failRun = vi.fn(async () => {});
    await expect(
      provisionHistoricalFundedRun({} as never, input, {
        findActiveRun: async () => undefined,
        ensureLedger: async () => {},
        startRun: async () => ({ id: "run-1" }) as never,
        bind: async () => {
          throw new Error("Funded account has an active run");
        },
        failRun,
      }),
    ).rejects.toThrow("Funded account has an active run");
    expect(failRun).toHaveBeenCalledWith(
      "run-1",
      "Funded account has an active run",
    );
  });
});
