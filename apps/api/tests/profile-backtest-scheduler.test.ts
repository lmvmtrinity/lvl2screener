import { describe, expect, it, vi } from "vitest";
import type { ScannerProfile } from "@tsx-scanner/contracts";
import type { BacktestAutomationService } from "../src/backtests/backtest-automation.js";
import { AutomaticProfileBacktestScheduler } from "../src/backtests/profile-backtest-scheduler.js";

const profile = {
  id: "10000000-0000-4000-8000-000000000088",
  name: "Bull Flag",
  analysisKind: "SETUP",
  configId: "10000000-0000-4000-8000-000000000098",
  configVersion: "profile-bull-flag-v1",
  strategyKey: "BULL_FLAG",
  marketId: "CA_TSX",
  parameters: { flagpoleMinAtr: 0.5 },
} as unknown as ScannerProfile;

describe("automatic profile backtest scheduling", () => {
  it("routes profile saves through the durable automation registry", async () => {
    const triggerProfile = vi.fn(async () => ({ kind: "DISPATCHED" }));
    const scheduler = new AutomaticProfileBacktestScheduler({
      triggerProfile,
    } as unknown as BacktestAutomationService);

    await scheduler.schedule(profile);

    expect(triggerProfile).toHaveBeenCalledTimes(1);
    expect(triggerProfile).toHaveBeenCalledWith(profile, "PROFILE_SAVE");
  });
});
