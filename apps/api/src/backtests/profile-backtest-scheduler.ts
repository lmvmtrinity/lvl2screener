import type { ScannerProfile } from "@tsx-scanner/contracts";
import type { BacktestAutomationService } from "./backtest-automation.js";

export interface ProfileBacktestScheduler {
  schedule(profile: ScannerProfile): Promise<void>;
}

/**
 * Profile-save trigger for routine qualification replays. It routes through the
 * durable A1 work registry so a save coalesces with an equivalent scheduled
 * catch-up instead of enqueueing a second job, and so the recorded watermark
 * (input fingerprint, trigger origin) is durable even when the queue is briefly
 * unavailable. The worker owns execution; saving a profile never performs a
 * long replay on the request path.
 */
export class AutomaticProfileBacktestScheduler implements ProfileBacktestScheduler {
  constructor(private readonly automation: BacktestAutomationService) {}

  async schedule(profile: ScannerProfile): Promise<void> {
    await this.automation.triggerProfile(profile, "PROFILE_SAVE");
  }
}
