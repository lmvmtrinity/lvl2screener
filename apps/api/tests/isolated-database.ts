import { setTimeout as delay } from "node:timers/promises";
import type { Pool } from "pg";

/** Fixed historical fixtures must survive the host's current retention clock.
 * Pause only maintenance jobs in an explicitly disposable database, then let
 * any already-started worker finish before fixture inserts begin. Policy
 * definitions remain available for explicit retention/compression assertions. */
export async function pauseHistoricalFixtureMaintenance(
  pool: Pick<Pool, "query">,
): Promise<void> {
  const database = await pool.query<{ name: string }>(
    "SELECT current_database() AS name",
  );
  if (!/^tsx_scanner_test(?:_[a-z0-9_]+)?$/.test(database.rows[0]?.name ?? ""))
    throw new Error(
      "Maintenance isolation requires a disposable test database",
    );
  const jobs = await pool.query<{ job_id: number }>(
    `SELECT job_id FROM timescaledb_information.jobs
     WHERE proc_name IN ('policy_compression', 'policy_retention', 'run_scheduled_retention')`,
  );
  const ids = jobs.rows.map((job) => job.job_id);
  if (ids.length === 0) return;
  await pool.query(
    `SELECT alter_job(job_id, scheduled => false)
     FROM timescaledb_information.jobs WHERE job_id = ANY($1::int[])`,
    [ids],
  );
  const deadline = Date.now() + 10_000;
  while (true) {
    // job_stats can report Paused while a worker is between commands. Wait for
    // the backend itself to exit, without filtering its current activity state.
    const active = await pool.query(
      `SELECT a.pid FROM timescaledb_information.jobs j
       JOIN pg_stat_activity a ON a.application_name = j.application_name
         AND a.datname = current_database()
       WHERE j.job_id = ANY($1::int[])`,
      [ids],
    );
    if (active.rows.length === 0) return;
    if (Date.now() >= deadline)
      throw new Error("Historical fixture maintenance workers did not drain");
    await delay(50);
  }
}

export function isolatedDatabaseUrl(
  key: string,
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const value = environment[key];
  if (!value) {
    if (environment.REQUIRE_POSTGRES_INTEGRATION === "true") {
      throw new Error(`${key} must name an explicitly isolated test database`);
    }
    return undefined;
  }
  const parsed = new URL(value);
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !/^tsx_scanner_test(?:_[a-z0-9_]+)?$/.test(
      decodeURIComponent(parsed.pathname.slice(1)),
    )
  ) {
    throw new Error(`${key} database name must start with tsx_scanner_test`);
  }
  if (environment.DATABASE_URL) {
    const application = new URL(environment.DATABASE_URL);
    if (
      application.hostname === parsed.hostname &&
      (application.port || "5432") === (parsed.port || "5432") &&
      application.pathname === parsed.pathname
    ) {
      throw new Error(`${key} must not target the application database`);
    }
  }
  return value;
}
