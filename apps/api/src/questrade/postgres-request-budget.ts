import type { Pool } from "pg";
import type {
  BudgetDecision,
  QuestradeRequestBudget,
} from "./request-budget.js";

/** Row lock serializes both markets/processes. Database time avoids host clock skew. */
export class PostgresRequestBudget implements QuestradeRequestBudget {
  constructor(
    private readonly pool: Pool,
    private readonly namespace: string,
  ) {
    if (!namespace.trim())
      throw new Error("Broker budget namespace is required");
  }

  async acquire(discovery: boolean): Promise<BudgetDecision> {
    const result = await this.pool.query<{
      granted: boolean;
      retry_after_ms: number;
      remaining_hour: number;
      remaining_discovery_hour: number;
    }>(
      `SELECT granted,retry_after_ms,remaining_hour,remaining_discovery_hour
       FROM questrade_acquire_request_budget($1,$2)`,
      [this.namespace, discovery],
    );
    const decision = result.rows[0];
    if (!decision) throw new Error("Broker budget decision unavailable");
    return {
      granted: decision.granted,
      retryAfterMs: decision.retry_after_ms,
      remainingHour: decision.remaining_hour,
      remainingDiscoveryHour: decision.remaining_discovery_hour,
    };
  }

  async block(until: Date): Promise<void> {
    if (!Number.isFinite(until.getTime()))
      throw new Error("Invalid broker reset time");
    await this.pool.query(
      `INSERT INTO questrade_request_budget(namespace,blocked_until)
      VALUES($1,GREATEST($2::timestamptz, clock_timestamp() + interval '1 hour'))
      ON CONFLICT(namespace) DO UPDATE SET blocked_until=GREATEST(questrade_request_budget.blocked_until,$2::timestamptz)`,
      [this.namespace, until],
    );
  }
}
