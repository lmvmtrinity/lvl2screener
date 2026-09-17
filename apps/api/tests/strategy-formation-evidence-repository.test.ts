import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type {
  StrategyEvaluation,
  StrategyStateEvent,
} from "@tsx-scanner/contracts";
import { PostgresStrategySignalStore } from "../src/market-data/strategy-repository.js";
import { loadMigrations, migrate } from "../src/database/migrate.js";
import { isolatedDatabaseUrl } from "./isolated-database.js";

const formationEvidence = {
  version: "formation-evidence-v1" as const,
  strategy: "RSI_VWAP_RECLAIM" as const,
  formationKey: "2026-09-08T14:40:00.000Z:2026-09-08T15:05:00.000Z",
  setupLevel: 97.5,
  stopLevel: 97.45,
  retest: null,
  rsiVwapReclaim: {
    indicatorVersion: "wilder-rsi-14-v1",
    firstPivot: {
      timestamp: "2026-09-08T14:40:00.000Z",
      price: 98,
      rsi: 40,
    },
    secondPivot: {
      timestamp: "2026-09-08T15:05:00.000Z",
      price: 97.5,
      rsi: 45,
    },
    divergenceConfirmedAt: "2026-09-08T15:15:00.000Z",
    divergenceVolumeContractionRatio: 0.5,
    reclaimAt: "2026-09-08T15:20:00.000Z",
    holdAt: "2026-09-08T15:25:00.000Z",
    frozenResistance: 101,
    invalidationLevel: 97.5,
  },
};

const evaluation = {
  kind: "SETUP",
  marketId: "CA_TSX",
  instrumentId: "10000000-0000-4000-8000-000000000001",
  symbol: "TEST.TO",
  timestamp: "2026-09-08T15:30:00.000Z",
  profileId: "10000000-0000-4000-8000-000000000002",
  profileName: "RSI research",
  strategy: "RSI_VWAP_RECLAIM",
  strategyVersion: "1.0.0",
  configVersion: "research-v1",
  state: "READY",
  score: 80,
  setupScore: 80,
  scoreVersion: "setup-score-v1",
  scoreComponents: {},
  scoreExplanation: [],
  setupInstanceId: "10000000-0000-4000-8000-000000000003",
  reasonCodes: ["RSI_RESISTANCE_BREAK_CONFIRMED"],
  entryReference: 101.2,
  stopReference: 97.45,
  targetReference: 108.7,
  estimatedRr: 2,
  formationEvidence,
  featureSnapshot: { marketId: "CA_TSX", featureVersion: "1.1.0" },
} as unknown as StrategyEvaluation;

describe("strategy formation evidence persistence", () => {
  it("writes the versioned bound payload to signals, evaluations, and events", async () => {
    const queries: Array<{ sql: string; values?: unknown[] }> = [];
    const client = {
      query: async (sql: string, values?: unknown[]) => {
        queries.push({ sql, values });
        if (sql.includes("RETURNING (xmax = 0) AS inserted"))
          return { rows: [{ inserted: true }] };
        return { rows: [] };
      },
      release: () => undefined,
    };
    const store = new PostgresStrategySignalStore({
      connect: async () => client,
    } as never);
    const event = {
      ...evaluation,
      eventId: "10000000-0000-4000-8000-000000000004",
      eventType: "STRATEGY_STATE_CHANGED",
      previousState: "FORMING",
    } as StrategyStateEvent;

    await store.saveStrategyResults([evaluation], [event]);

    for (const table of [
      "strategy_signal",
      "strategy_evaluation",
      "strategy_state_event",
    ]) {
      const query = queries.find((value) =>
        value.sql.includes(`INSERT INTO ${table}`),
      );
      expect(query?.sql).toContain("formation_evidence");
      const row = JSON.parse(String(query?.values?.[0]))[0];
      expect(row.formation_evidence).toEqual(formationEvidence);
      if (table === "strategy_state_event")
        expect(row.payload.formationEvidence).toEqual(formationEvidence);
    }
  });
});

const databaseUrl = isolatedDatabaseUrl("AUDIT_TEST_DATABASE_URL");

describe.skipIf(!databaseUrl)("strategy research PostgreSQL acceptance", () => {
  // Each case owns a fresh database on the explicitly isolated server. This
  // keeps the 079 upgrade fixture independent of other suites' migrations.
  it.each(["fresh", "upgrade"] as const)(
    "%s schema preserves baseline profiles and market-scoped formation evidence",
    async (mode) => {
      const databaseName = `tsx_scanner_test_research_${randomUUID().replaceAll("-", "")}`;
      const admin = new Pool({ connectionString: databaseUrl, max: 1 });
      const url = new URL(databaseUrl!);
      url.pathname = `/${databaseName}`;
      const connectionString = isolatedDatabaseUrl("AUDIT_TEST_DATABASE_URL", {
        ...process.env,
        AUDIT_TEST_DATABASE_URL: url.toString(),
      });
      const pool = new Pool({ connectionString, max: 2 });
      let created = false;
      try {
        await admin.query(`CREATE DATABASE "${databaseName}"`);
        created = true;
        const migrations = await loadMigrations();
        let baseline: unknown[] | undefined;
        const profilesSql = `SELECT p.id,p.market_id,p.enabled,p.current_config_id,
          c.id AS config_id,c.config_version,c.parameters
          FROM scanner_profile p JOIN scanner_profile_config c ON c.profile_id=p.id
          ORDER BY p.id,c.id`;
        if (mode === "upgrade") {
          await migrate(pool, {
            migrations: migrations.filter((value) => value.filename < "080-"),
          });
          baseline = (await pool.query(profilesSql)).rows;
          expect(baseline.length).toBeGreaterThan(0);
        }
        await migrate(pool);
        if (baseline)
          expect((await pool.query(profilesSql)).rows).toEqual(baseline);
        expect((await migrate(pool)).applied).toEqual([]);
        const definitions = await pool.query(
          `SELECT strategy_key,parameter_schema FROM strategy_definition
           WHERE strategy_key IN ('ORB_RETEST','VWAP_HOLD','RSI_VWAP_RECLAIM')`,
        );
        expect(definitions.rows).toHaveLength(3);
        for (const row of definitions.rows) {
          expect(row.parameter_schema).toHaveProperty(
            "dailyEmaFilterEnabled",
            "integer",
          );
        }
        expect(
          (
            await pool.query(`SELECT p.id FROM scanner_profile p
          JOIN strategy_definition d ON d.id=p.strategy_definition_id
          WHERE d.strategy_key='RSI_VWAP_RECLAIM'`)
          ).rows,
        ).toEqual([]);
        expect(
          (
            await pool.query(`SELECT id FROM scanner_profile
          WHERE market_id='US_EQUITIES' AND enabled`)
          ).rows,
        ).toEqual([]);

        const store = new PostgresStrategySignalStore(pool);
        for (const marketId of ["CA_TSX", "US_EQUITIES"] as const) {
          const instrumentId = randomUUID();
          const profileId = randomUUID();
          const configVersion = `research-${profileId}`;
          await pool.query(
            `INSERT INTO instrument
            (id,questrade_symbol_id,symbol,description,exchange,currency,market_id,
             security_type,industry_sector,is_quotable,is_tradable,active)
            VALUES($1,$2,$3,'Research acceptance',$4,$5,$6,'Stock','Technology',true,true,true)`,
            [
              instrumentId,
              marketId === "CA_TSX" ? 1900000001 : 1900000002,
              `RESEARCH_${marketId}`,
              marketId === "CA_TSX" ? "TSX" : "NASDAQ",
              marketId === "CA_TSX" ? "CAD" : "USD",
              marketId,
            ],
          );
          await pool.query(
            `INSERT INTO scanner_profile(id,name,market_id,strategy_definition_id,enabled)
            SELECT $1,'Research acceptance',$2,id,false FROM strategy_definition
            WHERE strategy_key='RSI_VWAP_RECLAIM'`,
            [profileId, marketId],
          );
          await pool.query(
            `INSERT INTO scanner_profile_config(profile_id,market_id,config_version,parameters)
            VALUES($1,$2,$3,'{}')`,
            [profileId, marketId, configVersion],
          );
          const value = {
            ...evaluation,
            instrumentId,
            profileId,
            configVersion,
            marketId,
            setupInstanceId: randomUUID(),
            featureSnapshot: { ...evaluation.featureSnapshot, marketId },
          };
          await pool.query(
            `INSERT INTO feature_snapshot
            (instrument_id,market_id,timestamp,timeframe,price,change_from_open_pct,
             spread_pct,config_version,feature_version,snapshot_json)
            VALUES($1,$2,$3,'OneMinute',101.2,1,0.1,$4,$5,$6)`,
            [
              instrumentId,
              marketId,
              value.timestamp,
              configVersion,
              value.featureSnapshot.featureVersion,
              value.featureSnapshot,
            ],
          );
          const event = {
            ...value,
            eventId: randomUUID(),
            eventType: "STRATEGY_STATE_CHANGED",
            previousState: "FORMING",
          } as StrategyStateEvent;
          await store.saveStrategyResults([value], [event]);
          await store.saveStrategyResults([value], [event]);
          for (const table of [
            "strategy_signal",
            "strategy_evaluation",
            "strategy_state_event",
          ]) {
            const rows = (
              await pool.query(
                `SELECT market_id,formation_evidence FROM ${table}
              WHERE instrument_id=$1 AND profile_id=$2`,
                [instrumentId, profileId],
              )
            ).rows;
            expect(rows).toEqual([
              { market_id: marketId, formation_evidence: formationEvidence },
            ]);
          }
          const persistedEvent = (
            await pool.query(
              `SELECT e.payload,e.signal_id,s.id
            FROM strategy_state_event e JOIN strategy_signal s ON s.id=e.signal_id
            WHERE e.id=$1`,
              [event.eventId],
            )
          ).rows[0];
          expect(persistedEvent.payload.formationEvidence).toEqual(
            formationEvidence,
          );
          expect(persistedEvent.signal_id).toBe(persistedEvent.id);

          // Fail in the event write, after both evaluation writes, and prove
          // those updates roll back with it rather than replacing evidence.
          const changed = {
            ...value,
            formationEvidence: { ...formationEvidence, setupLevel: 96 },
          };
          await expect(
            store.saveStrategyResults(
              [changed],
              [
                {
                  ...event,
                  eventId: "invalid-uuid",
                  formationEvidence: changed.formationEvidence,
                },
              ],
            ),
          ).rejects.toThrow();
          expect(
            (
              await pool.query(
                `SELECT formation_evidence FROM strategy_signal
            WHERE instrument_id=$1`,
                [instrumentId],
              )
            ).rows[0].formation_evidence,
          ).toEqual(formationEvidence);
          expect(
            (
              await pool.query(
                `SELECT formation_evidence FROM strategy_evaluation
            WHERE instrument_id=$1`,
                [instrumentId],
              )
            ).rows[0].formation_evidence,
          ).toEqual(formationEvidence);

          // A same-instrument evaluation using the peer market profile must
          // fail the database ownership boundary, leaving existing rows intact.
          const peer = (
            await pool.query(
              `SELECT id FROM scanner_profile
            WHERE market_id<>$1 LIMIT 1`,
              [marketId],
            )
          ).rows[0];
          await expect(
            store.saveStrategyResults([{ ...value, profileId: peer.id }], []),
          ).rejects.toThrow();
          expect(
            (
              await pool.query(
                `SELECT id FROM strategy_signal WHERE instrument_id=$1`,
                [instrumentId],
              )
            ).rows,
          ).toHaveLength(1);
        }
      } finally {
        await pool.end();
        try {
          if (created) await admin.query(`DROP DATABASE "${databaseName}"`);
        } finally {
          await admin.end();
        }
      }
    },
    60_000,
  );
});
