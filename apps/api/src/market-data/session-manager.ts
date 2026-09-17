import type {
  Market,
  MarketDataAdapter,
  MarketSessionStatus,
} from "../questrade/types.js";
import type { MarketId } from "@tsx-scanner/contracts";

export type ScannerSessionPhase =
  | "PRE_OPEN"
  | "OPENING_RANGE"
  | "ACTIVE_SCAN"
  | "PREFERRED_ENTRIES"
  | "MONITORING"
  | "AFTER_HOURS"
  | "CLOSED";

export interface MarketSessionSnapshot {
  marketId: MarketId;
  market: string;
  marketStatus: MarketSessionStatus;
  phase: ScannerSessionPhase;
  startTime: Date;
  endTime: Date;
  observedAt: Date;
  scanningEnabled: boolean;
  preferredEntriesEnabled: boolean;
  newEntriesAllowed: boolean;
}

export interface SessionPolicy {
  timezone: "America/Toronto" | "America/New_York";
  openingRange: { start: string; end: string };
  scanning: { start: string; end: string };
  entries: { preferredStart: string; preferredEnd: string; hardEnd: string };
}

const DEFAULT_SESSION_POLICY: SessionPolicy = {
  timezone: "America/Toronto",
  openingRange: { start: "09:30", end: "09:45" },
  scanning: { start: "09:45", end: "16:00" },
  entries: { preferredStart: "10:00", preferredEnd: "11:30", hardEnd: "16:00" },
};

export class MarketSessionManager {
  private market: Market | undefined;

  constructor(
    private readonly adapter: MarketDataAdapter,
    private readonly clock: () => Date = () => new Date(),
    private readonly marketName = "TSX",
    private readonly policy: SessionPolicy = DEFAULT_SESSION_POLICY,
    private readonly marketId: MarketId = "CA_TSX",
  ) {}

  getMarketId(): MarketId {
    return this.marketId;
  }

  async initialize(): Promise<MarketSessionSnapshot> {
    return this.refresh();
  }

  async refresh(): Promise<MarketSessionSnapshot> {
    const market = await this.adapter.getMarket(this.marketName);
    if (!market)
      throw new Error(`${this.marketName} market hours are unavailable`);
    this.market = market;
    return this.getSnapshot();
  }

  getMarket(): Market {
    if (!this.market)
      throw new Error("Market session manager is not initialized");
    return this.market;
  }

  getSnapshot(): MarketSessionSnapshot {
    const market = this.getMarket();
    const now = this.clock();
    const minutes = localMinutes(now, this.policy.timezone);
    const marketStatus = statusAt(market, now);
    const scanningEnabled =
      marketStatus === "OPEN" &&
      inWindow(minutes, this.policy.scanning.start, this.policy.scanning.end);
    const preferredEntriesEnabled =
      marketStatus === "OPEN" &&
      inWindow(
        minutes,
        this.policy.entries.preferredStart,
        this.policy.entries.preferredEnd,
      );
    return {
      marketId: this.marketId,
      market: market.name,
      marketStatus,
      phase: phaseAt(market, now, this.policy),
      startTime: market.startTime,
      endTime: market.endTime,
      observedAt: now,
      scanningEnabled,
      preferredEntriesEnabled,
      newEntriesAllowed:
        scanningEnabled && minutes < toMinutes(this.policy.entries.hardEnd),
    };
  }

  getPolicy(): SessionPolicy {
    return structuredClone(this.policy);
  }
}

function statusAt(market: Market, now: Date): MarketSessionStatus {
  if (now >= market.startTime && now < market.endTime) return "OPEN";
  if (now >= market.extendedStartTime && now < market.startTime)
    return "PRE_MARKET";
  if (now >= market.endTime && now < market.extendedEndTime)
    return "AFTER_HOURS";
  return "CLOSED";
}

function phaseAt(
  market: Market,
  now: Date,
  policy: SessionPolicy,
): ScannerSessionPhase {
  const minutes = localMinutes(now, policy.timezone);
  if (now < market.startTime)
    return now >= market.extendedStartTime ? "PRE_OPEN" : "CLOSED";
  if (now >= market.endTime)
    return now < market.extendedEndTime ? "AFTER_HOURS" : "CLOSED";
  if (inWindow(minutes, policy.openingRange.start, policy.openingRange.end))
    return "OPENING_RANGE";
  if (inWindow(minutes, policy.scanning.start, policy.entries.preferredStart))
    return "ACTIVE_SCAN";
  if (
    inWindow(
      minutes,
      policy.entries.preferredStart,
      policy.entries.preferredEnd,
    )
  )
    return "PREFERRED_ENTRIES";
  if (inWindow(minutes, policy.entries.preferredEnd, policy.scanning.end))
    return "ACTIVE_SCAN";
  if (now < market.endTime) return "MONITORING";
  if (now < market.extendedEndTime) return "AFTER_HOURS";
  return "CLOSED";
}

function toMinutes(value: string): number {
  const [hours, minutes] = value.split(":").map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
}
function inWindow(value: number, start: string, end: string): boolean {
  return value >= toMinutes(start) && value < toMinutes(end);
}
function localMinutes(now: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  return (
    Number(parts.find((part) => part.type === "hour")?.value) * 60 +
    Number(parts.find((part) => part.type === "minute")?.value)
  );
}
