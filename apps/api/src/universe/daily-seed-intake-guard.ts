import type { MarketId } from "@tsx-scanner/contracts";

/** Internal seed/rescan preconditions, checked against the locked durable list. */
export interface DailySeedIntakeGuard {
  phase: "SEED" | "RESCAN";
  marketId: MarketId;
  tradingDate: string;
  maxAdds: number;
}
