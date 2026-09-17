import type { Pool } from "pg";
import {
  decideBudget,
  type BudgetDecision,
  type QuestradeRequestBudget,
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
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "INSERT INTO questrade_request_budget(namespace) VALUES ($1) ON CONFLICT DO NOTHING",
        [this.namespace],
      );
      const state = (
        await client.query<{
          blocked_until: Date;
          last_started_at: Date | null;
          last_discovery_at: Date | null;
        }>(
          "SELECT * FROM questrade_request_budget WHERE namespace=$1 FOR UPDATE",
          [this.namespace],
        )
      ).rows[0]!;
      const now = (
        await client.query<{ now: Date }>("SELECT clock_timestamp() AS now")
      ).rows[0]!.now;
      // Retain only the rolling hour. No market/evidence data is touched.
      await client.query(
        "DELETE FROM questrade_request_grant WHERE namespace=$1 AND started_at <= $2::timestamptz - interval '1 hour'",
        [this.namespace, now],
      );
      const usage = (
        await client.query<{
          hour_count: number;
          second_count: number;
          discovery_count: number;
          oldest_hour: Date | null;
          oldest_second: Date | null;
          oldest_discovery: Date | null;
        }>(
          `SELECT count(*)::int AS hour_count,
        count(*) FILTER (WHERE started_at > $2::timestamptz - interval '1 second')::int AS second_count,
        count(*) FILTER (WHERE discovery)::int AS discovery_count,
        min(started_at) AS oldest_hour,
        min(started_at) FILTER (WHERE started_at > $2::timestamptz - interval '1 second') AS oldest_second,
        min(started_at) FILTER (WHERE discovery) AS oldest_discovery
        FROM questrade_request_grant WHERE namespace=$1`,
          [this.namespace, now],
        )
      ).rows[0]!;
      const decision = decideBudget(now.getTime(), discovery, {
        second: usage.second_count,
        hour: usage.hour_count,
        discoveryHour: usage.discovery_count,
        oldestSecondMs: usage.oldest_second?.getTime() ?? 0,
        oldestHourMs: usage.oldest_hour?.getTime() ?? 0,
        oldestDiscoveryMs: usage.oldest_discovery?.getTime() ?? 0,
        lastMs: state.last_started_at?.getTime() ?? -Infinity,
        lastDiscoveryMs: state.last_discovery_at?.getTime() ?? -Infinity,
        blockedUntilMs: state.blocked_until.getTime(),
      });
      if (decision.granted) {
        await client.query(
          "INSERT INTO questrade_request_grant(namespace,started_at,discovery) VALUES($1,$2,$3)",
          [this.namespace, now, discovery],
        );
        await client.query(
          `UPDATE questrade_request_budget SET last_started_at=$2,
          last_discovery_at=CASE WHEN $3 THEN $2 ELSE last_discovery_at END WHERE namespace=$1`,
          [this.namespace, now, discovery],
        );
      }
      await client.query("COMMIT");
      return decision;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
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
