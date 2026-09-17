export const BROKER_BUDGET = Object.freeze({
  second: 20,
  hour: 15_000,
  spacingMs: 50,
  discoveryHour: 1_800,
  discoverySpacingMs: 1_000,
  monitoringReserveHour: 6_000,
  discoveryQueue: 500,
  discoveryExpiryMs: 120_000,
});

export interface BudgetUsage {
  second: number;
  hour: number;
  discoveryHour: number;
  oldestSecondMs: number;
  oldestHourMs: number;
  oldestDiscoveryMs: number;
  lastMs: number;
  lastDiscoveryMs: number;
  blockedUntilMs: number;
}

export interface BudgetDecision {
  granted: boolean;
  retryAfterMs: number;
  remainingHour: number;
  remainingDiscoveryHour: number;
}

/** Uses rolling windows, with a durable grant counted even if dispatch crashes. */
export function decideBudget(
  now: number,
  discovery: boolean,
  usage: BudgetUsage,
): BudgetDecision {
  let next = Math.max(
    now,
    usage.blockedUntilMs,
    usage.lastMs + BROKER_BUDGET.spacingMs,
  );
  if (usage.second >= BROKER_BUDGET.second)
    next = Math.max(next, usage.oldestSecondMs + 1_000);
  if (usage.hour >= BROKER_BUDGET.hour)
    next = Math.max(next, usage.oldestHourMs + 3_600_000);
  if (discovery) {
    next = Math.max(
      next,
      usage.lastDiscoveryMs + BROKER_BUDGET.discoverySpacingMs,
    );
    if (usage.discoveryHour >= BROKER_BUDGET.discoveryHour)
      next = Math.max(next, usage.oldestDiscoveryMs + 3_600_000);
    if (usage.hour >= BROKER_BUDGET.hour - BROKER_BUDGET.monitoringReserveHour)
      next = Math.max(next, usage.oldestHourMs + 3_600_000);
  }
  return {
    granted: next <= now,
    retryAfterMs: Math.max(0, next - now),
    remainingHour: Math.max(
      0,
      BROKER_BUDGET.hour - usage.hour - (next <= now ? 1 : 0),
    ),
    remainingDiscoveryHour: Math.max(
      0,
      Math.min(
        BROKER_BUDGET.discoveryHour -
          usage.discoveryHour -
          (next <= now && discovery ? 1 : 0),
        BROKER_BUDGET.hour -
          BROKER_BUDGET.monitoringReserveHour -
          usage.hour -
          (next <= now ? 1 : 0),
      ),
    ),
  };
}

export interface QuestradeRequestBudget {
  acquire(discovery: boolean): Promise<BudgetDecision>;
  block(until: Date): Promise<void>;
}

/** Explicitly simulated transports spend no broker allowance. Keeps fixture clocks
 * independent of wall-clock pacing; never inject this into a live transport. */
export class MockRequestBudget implements QuestradeRequestBudget {
  async acquire(): Promise<BudgetDecision> {
    return {
      granted: true,
      retryAfterMs: 0,
      remainingHour: 15_000,
      remainingDiscoveryHour: 1_800,
    };
  }
  async block(): Promise<void> {}
}

/** Deterministic test/mock budget. Live composition must use the Postgres implementation. */
export class MemoryRequestBudget implements QuestradeRequestBudget {
  private grants: { at: number; discovery: boolean }[] = [];
  private blockedUntilMs = 0;
  constructor(private readonly clock: () => Date = () => new Date()) {}

  async acquire(discovery: boolean): Promise<BudgetDecision> {
    const now = this.clock().getTime();
    this.grants = this.grants.filter((grant) => grant.at > now - 3_600_000);
    const second = this.grants.filter((grant) => grant.at > now - 1_000);
    const low = this.grants.filter((grant) => grant.discovery);
    const decision = decideBudget(now, discovery, {
      second: second.length,
      hour: this.grants.length,
      discoveryHour: low.length,
      oldestSecondMs: second[0]?.at ?? 0,
      oldestHourMs: this.grants[0]?.at ?? 0,
      oldestDiscoveryMs: low[0]?.at ?? 0,
      lastMs: this.grants.at(-1)?.at ?? -Infinity,
      lastDiscoveryMs: low.at(-1)?.at ?? -Infinity,
      blockedUntilMs: this.blockedUntilMs,
    });
    if (decision.granted) this.grants.push({ at: now, discovery });
    return decision;
  }

  async block(until: Date): Promise<void> {
    this.blockedUntilMs = Math.max(this.blockedUntilMs, until.getTime());
  }
}
