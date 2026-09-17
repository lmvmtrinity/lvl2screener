import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import {
  discoveryAttemptDiagnosticsDraftSchema,
  discoveryAttemptDiagnosticsSchema,
  discoveryCoverageSchema,
  discoveryEvaluationInputSchema,
  discoveryEvaluationResultSchema,
  discoveryEvidenceSchema,
  discoveryPolicyForMarket,
  discoveryPolicySchema,
  discoveryRunSchema,
  marketIdSchema,
  type DiscoveryEvaluationInput,
  type DiscoveryAttemptDiagnostics,
  type DiscoveryEvaluationResult,
  type DiscoveryEvidence,
  type DiscoveryPolicy,
  type DiscoveryRun,
  type MarketId,
} from "@tsx-scanner/contracts";
import { CATALOG_DEFAULTS, type CatalogSnapshot } from "./eodhd-catalog.js";
import { validatedSnapshot } from "./postgres-discovery-provider-store.js";
import type { DiscoveryLease } from "./discovery-control-repository.js";
import type { DiscoveryOutboxWriter } from "./discovery-intake-repository.js";
import type { DiscoveryAttemptDiagnosticsDraft } from "./discovery-attempt-diagnostics.js";

export type DiscoveryDb = Pick<PoolClient, "query">;
type Db = DiscoveryDb;
interface RunRow {
  id: string;
  market_id: MarketId;
  trading_date: string;
  policy_version: string;
  mode: string;
  evaluation_at: Date;
  completed_bar_end: Date;
  status: string;
  coverage: unknown;
  started_at: Date;
  completed_at: Date | null;
  failure: string | null;
  idempotency_key: string;
  catalog_snapshot_id: string;
  catalog_digest: string;
  row_count: number;
}
interface EvidenceRow {
  id: string;
  run_id: string;
  result: unknown;
  input_digest: string | null;
  payload: unknown | null;
  input_retained?: boolean;
}
export interface BeginDiscoveryRun {
  marketId: MarketId;
  tradingDate: string;
  mode: "SHADOW" | "AUTO_ADD";
  evaluationAt: string;
  completedBarEnd: string;
  idempotencyKey: string;
  catalog: CatalogSnapshot;
}

export interface DiscoveryScheduledRunRecovery {
  run: DiscoveryRun;
  catalog: CatalogSnapshot;
  evaluated: Array<{ providerExchange: string; providerCode: string }>;
}
export interface DiscoveryRunWritePerformance {
  serializationMs: number;
  persistenceMs: number;
}
/** Phase timings belong to one scheduler attempt. Late writes from an older,
 * failed attempt are ignored after that attempt is finalized. */
export class DiscoveryWritePerformanceAttempt {
  private closed = false;
  private sampleCount = 0;
  private serializationMs = 0;
  private persistenceMs = 0;

  record(serializationMs: number, persistenceMs: number): void {
    if (this.closed) return;
    this.sampleCount += 1;
    this.serializationMs += serializationMs;
    this.persistenceMs += persistenceMs;
  }

  take(): DiscoveryRunWritePerformance | null {
    if (this.closed) return null;
    this.closed = true;
    return this.sampleCount === 0
      ? null
      : {
          serializationMs: this.serializationMs,
          persistenceMs: this.persistenceMs,
        };
  }
}
interface SerializationTiming {
  milliseconds: number;
}
interface RecordedEvidence {
  evidence: DiscoveryEvidence;
  inserted: boolean;
}
const runSelect = `SELECT r.*, r.trading_date::text AS trading_date, s.digest AS catalog_digest,s.row_count FROM discovery_run r
  JOIN discovery_catalog_snapshot s ON s.id=r.catalog_snapshot_id AND s.market_id=r.market_id`;
const evidenceSelect = `SELECT e.id,e.run_id,e.result,e.input_digest,i.payload FROM discovery_evaluation e
  LEFT JOIN discovery_evaluation_input i ON i.evaluation_id=e.id`;

function parseRun(row: RunRow): DiscoveryRun {
  return discoveryRunSchema.parse({
    id: row.id,
    marketId: row.market_id,
    tradingDate: row.trading_date,
    policyVersion: row.policy_version,
    mode: row.mode,
    evaluationAt: row.evaluation_at.toISOString(),
    completedBarEnd: row.completed_bar_end.toISOString(),
    catalogDigest: row.catalog_digest,
    status: row.status,
    coverage: row.coverage,
    startedAt: row.started_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
    failure: row.failure,
  });
}
function parseEvidence(
  row: EvidenceRow,
  includeInput = true,
): DiscoveryEvidence {
  return discoveryEvidenceSchema.parse({
    id: row.id,
    runId: row.run_id,
    result: row.result,
    inputDigest: row.input_digest,
    input: includeInput ? row.payload : null,
    inputRetained: row.input_retained ?? row.payload !== null,
  });
}

function timedJsonStringify(
  value: unknown,
  timing: SerializationTiming,
): string {
  const startedAt = performance.now();
  const serialized = JSON.stringify(value);
  timing.milliseconds += performance.now() - startedAt;
  return serialized;
}

/** Discovery-only evidence. No daily-list, profile, strategy or paper mutations. */
export class PostgresDiscoveryEvidenceStore {
  constructor(
    private readonly pool: Pool,
    private readonly clock: () => Date = () => new Date(),
    private readonly intakeWriter?: DiscoveryOutboxWriter,
  ) {}

  beginWritePerformanceAttempt(): DiscoveryWritePerformanceAttempt {
    return new DiscoveryWritePerformanceAttempt();
  }

  private recordWritePerformance(
    attempt: DiscoveryWritePerformanceAttempt | undefined,
    startedAt: number,
    serializationMs: number,
  ): void {
    if (!attempt) return;
    const elapsedMs = performance.now() - startedAt;
    attempt.record(serializationMs, Math.max(0, elapsedMs - serializationMs));
  }

  private async transaction<T>(
    action: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await action(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async ensurePolicy(policy: DiscoveryPolicy): Promise<void> {
    await this.policy(this.pool, policy);
  }
  private async policy(db: Db, value: DiscoveryPolicy): Promise<void> {
    const policy = discoveryPolicySchema.parse(value);
    await db.query(
      `INSERT INTO discovery_policy(market_id,version,definition,effective_at)
      VALUES($1,$2,$3::jsonb,'2026-09-08T00:00:00Z') ON CONFLICT DO NOTHING`,
      [policy.marketId, policy.version, JSON.stringify(policy)],
    );
    const check = await db.query<{ matches: boolean }>(
      `SELECT definition=$3::jsonb AS matches FROM discovery_policy WHERE market_id=$1 AND version=$2`,
      [policy.marketId, policy.version, JSON.stringify(policy)],
    );
    if (!check.rows[0]?.matches)
      throw new Error("Discovery policy definition conflict");
  }

  async begin(value: BeginDiscoveryRun): Promise<DiscoveryRun> {
    marketIdSchema.parse(value.marketId);
    z.string().date().parse(value.tradingDate);
    z.enum(["SHADOW", "AUTO_ADD"]).parse(value.mode);
    z.string().min(1).max(200).parse(value.idempotencyKey);
    const at = new Date(z.string().datetime().parse(value.evaluationAt));
    const end = new Date(z.string().datetime().parse(value.completedBarEnd));
    const catalog = validatedSnapshot(value.catalog);
    const tradingDate = new Intl.DateTimeFormat("en-CA", {
      timeZone:
        value.marketId === "CA_TSX" ? "America/Toronto" : "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(at);
    if (
      catalog.marketId !== value.marketId ||
      catalog.tradingDate > value.tradingDate ||
      tradingDate !== value.tradingDate ||
      end > at ||
      at > this.clock() ||
      Date.parse(catalog.fetchedAt) > at.getTime() ||
      at.getTime() - Date.parse(catalog.fetchedAt) > CATALOG_DEFAULTS.maxAgeMs
    )
      throw new Error("Discovery run catalog/time ownership conflict");
    const policy = discoveryPolicyForMarket(value.marketId);
    return this.transaction(async (db) => {
      await this.policy(db, policy);
      await db.query(
        `INSERT INTO discovery_catalog_snapshot(id,market_id,trading_date,digest,snapshot,row_count,fetched_at)
        VALUES($1,$2,$3,$4,$5::jsonb,$6,$7) ON CONFLICT(market_id,trading_date,digest) DO NOTHING`,
        [
          randomUUID(),
          catalog.marketId,
          catalog.tradingDate,
          catalog.digest,
          JSON.stringify(catalog),
          catalog.rowCount,
          catalog.fetchedAt,
        ],
      );
      const snapshot = (
        await db.query<{ id: string }>(
          `SELECT id FROM discovery_catalog_snapshot WHERE market_id=$1 AND trading_date=$2 AND digest=$3`,
          [catalog.marketId, catalog.tradingDate, catalog.digest],
        )
      ).rows[0]!;
      await db.query(
        `INSERT INTO discovery_catalog_member(snapshot_id,provider_exchange,provider_code)
        SELECT $1,x.exchange,x.code FROM jsonb_to_recordset($2::jsonb) AS x(exchange text,code text) ON CONFLICT DO NOTHING`,
        [
          snapshot.id,
          JSON.stringify(
            catalog.members.map((member) => ({
              exchange: member.raw.Exchange,
              code: member.providerCode,
            })),
          ),
        ],
      );
      const count = catalog.rowCount;
      const coverage = {
        total: count,
        pass: 0,
        fail: 0,
        unevaluable: 0,
        deferred: count,
      };
      await db.query(
        `INSERT INTO discovery_run(id,market_id,trading_date,policy_version,mode,evaluation_at,completed_bar_end,catalog_snapshot_id,idempotency_key,status,coverage,started_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'RUNNING',$10::jsonb,$11) ON CONFLICT(market_id,trading_date,idempotency_key) DO NOTHING`,
        [
          randomUUID(),
          value.marketId,
          value.tradingDate,
          policy.version,
          value.mode,
          at,
          end,
          snapshot.id,
          value.idempotencyKey,
          JSON.stringify(coverage),
          this.clock(),
        ],
      );
      const row = (
        await db.query<RunRow>(
          `${runSelect} WHERE r.market_id=$1 AND r.trading_date=$2 AND r.idempotency_key=$3`,
          [value.marketId, value.tradingDate, value.idempotencyKey],
        )
      ).rows[0]!;
      if (
        row.mode !== value.mode ||
        row.policy_version !== policy.version ||
        row.evaluation_at.getTime() !== at.getTime() ||
        row.completed_bar_end.getTime() !== end.getTime() ||
        row.catalog_snapshot_id !== snapshot.id
      )
        throw new Error("Discovery run idempotency conflict");
      return parseRun(row);
    });
  }

  /** Load the immutable catalog and already-recorded identities for a reclaimed run. */
  async loadScheduledRun(
    runId: string,
    marketId: MarketId,
  ): Promise<DiscoveryScheduledRunRecovery | null> {
    z.string().uuid().parse(runId);
    marketIdSchema.parse(marketId);
    const row = (
      await this.pool.query<RunRow & { snapshot: unknown }>(
        `SELECT r.*, r.trading_date::text AS trading_date,
                s.digest AS catalog_digest,s.row_count,s.snapshot
         FROM discovery_run r
         JOIN discovery_catalog_snapshot s
           ON s.id=r.catalog_snapshot_id AND s.market_id=r.market_id
         WHERE r.id=$1 AND r.market_id=$2`,
        [runId, marketId],
      )
    ).rows[0];
    if (!row) return null;
    const evaluated = await this.pool.query<{
      provider_exchange: string;
      provider_code: string;
    }>(
      `SELECT provider_exchange,provider_code
       FROM discovery_evaluation WHERE run_id=$1`,
      [runId],
    );
    return {
      run: parseRun(row),
      catalog: validatedSnapshot(row.snapshot),
      evaluated: evaluated.rows.map((value) => ({
        providerExchange: value.provider_exchange,
        providerCode: value.provider_code,
      })),
    };
  }

  /** Covers the crash window between run creation and lease-to-run binding. */
  async loadScheduledRunByKey(input: {
    marketId: MarketId;
    tradingDate: string;
    idempotencyKey: string;
  }): Promise<DiscoveryScheduledRunRecovery | null> {
    marketIdSchema.parse(input.marketId);
    z.string().date().parse(input.tradingDate);
    z.string().min(1).max(200).parse(input.idempotencyKey);
    const row = await this.pool.query<{ id: string }>(
      `SELECT id FROM discovery_run
       WHERE market_id=$1 AND trading_date=$2 AND idempotency_key=$3`,
      [input.marketId, input.tradingDate, input.idempotencyKey],
    );
    return row.rows[0]
      ? this.loadScheduledRun(row.rows[0].id, input.marketId)
      : null;
  }

  private async locked(
    db: Db,
    runId: string,
    marketId: MarketId,
  ): Promise<RunRow> {
    z.string().uuid().parse(runId);
    marketIdSchema.parse(marketId);
    const row = (
      await db.query<RunRow>(
        `${runSelect} WHERE r.id=$1 AND r.market_id=$2 FOR UPDATE OF r`,
        [runId, marketId],
      )
    ).rows[0];
    if (!row) throw new Error("Discovery run not found in selected market");
    return row;
  }

  async record(
    runId: string,
    result: DiscoveryEvaluationResult,
    input: DiscoveryEvaluationInput | null,
    performanceAttempt?: DiscoveryWritePerformanceAttempt,
  ): Promise<DiscoveryEvidence> {
    const parsed = discoveryEvaluationResultSchema.parse(result);
    const payload =
      input === null ? null : discoveryEvaluationInputSchema.parse(input);
    const startedAt = performance.now();
    const timing: SerializationTiming = { milliseconds: 0 };
    try {
      return await this.transaction(async (db) => {
        const run = await this.locked(db, runId, parsed.marketId);
        const recorded = await this.recordIn(db, run, parsed, payload, timing);
        if (run.status === "RUNNING" && recorded.inserted)
          await this.incrementCoverage(db, run, parsed.state, timing);
        return recorded.evidence;
      });
    } finally {
      this.recordWritePerformance(
        performanceAttempt,
        startedAt,
        timing.milliseconds,
      );
    }
  }

  /**
   * Fenced counterpart used by the scheduled shadow worker. The lease check and
   * evidence write share one transaction, so a worker that lost ownership while
   * waiting on provider/scanner I/O cannot publish a late result.
   */
  async recordOwned(
    runId: string,
    lease: DiscoveryLease,
    result: DiscoveryEvaluationResult,
    input: DiscoveryEvaluationInput | null,
    performanceAttempt?: DiscoveryWritePerformanceAttempt,
  ): Promise<DiscoveryEvidence> {
    const parsed = discoveryEvaluationResultSchema.parse(result);
    const payload =
      input === null ? null : discoveryEvaluationInputSchema.parse(input);
    const startedAt = performance.now();
    const timing: SerializationTiming = { milliseconds: 0 };
    try {
      return await this.transaction(async (db) => {
        await this.assertLease(db, runId, lease);
        const run = await this.locked(db, runId, parsed.marketId);
        const recorded = await this.recordIn(db, run, parsed, payload, timing);
        if (run.status === "RUNNING" && recorded.inserted)
          await this.incrementCoverage(db, run, parsed.state, timing);
        return recorded.evidence;
      });
    } finally {
      this.recordWritePerformance(
        performanceAttempt,
        startedAt,
        timing.milliseconds,
      );
    }
  }

  private async recordIn(
    db: Db,
    run: RunRow,
    result: DiscoveryEvaluationResult,
    input: DiscoveryEvaluationInput | null,
    timing: SerializationTiming,
  ): Promise<RecordedEvidence> {
    const at = Date.parse(result.evaluationAt);
    if (
      result.marketId !== run.market_id ||
      result.policyVersion !== run.policy_version ||
      result.tradingDate !== run.trading_date ||
      at !== run.evaluation_at.getTime() ||
      Date.parse(result.completedBarEnd) !== run.completed_bar_end.getTime()
    )
      throw new Error("Discovery evaluation run ownership conflict");
    if (
      !(
        await db.query(
          "SELECT 1 FROM discovery_catalog_member WHERE snapshot_id=$1 AND provider_exchange=$2 AND provider_code=$3",
          [
            run.catalog_snapshot_id,
            result.providerExchange,
            result.providerCode,
          ],
        )
      ).rowCount
    )
      throw new Error("Discovery evaluation is not in captured catalog");
    if ((result.state === "PASS" || result.state === "FAIL") && input === null)
      throw new Error("Evaluated discovery must retain its input evidence");
    if (
      input &&
      (input.marketId !== result.marketId ||
        input.policyVersion !== result.policyVersion ||
        input.providerCode !== result.providerCode ||
        input.providerExchange !== result.providerExchange ||
        input.identity.symbolId !== result.symbolId ||
        input.tradingDate !== result.tradingDate ||
        Date.parse(input.evaluationAt) !== at ||
        Date.parse(input.completedBarEnd) !==
          Date.parse(result.completedBarEnd))
    )
      throw new Error("Discovery input/result ownership conflict");
    const resultText = timedJsonStringify(result, timing);
    const inputText = input === null ? null : timedJsonStringify(input, timing);
    const digest =
      inputText === null
        ? null
        : createHash("sha256").update(inputText).digest("hex");
    const existing = (
      await db.query<EvidenceRow>(
        `${evidenceSelect} WHERE e.run_id=$1 AND e.provider_exchange=$2 AND e.provider_code=$3`,
        [run.id, result.providerExchange, result.providerCode],
      )
    ).rows[0];
    if (existing) {
      if (
        existing.input_digest !== digest ||
        timedJsonStringify(
          discoveryEvaluationResultSchema.parse(existing.result),
          timing,
        ) !== resultText
      )
        throw new Error(
          "Discovery evaluation retry conflicts with durable evidence",
        );
      return { evidence: parseEvidence(existing), inserted: false };
    }
    if (run.status !== "RUNNING")
      throw new Error("Discovery run is already completed");
    const id = randomUUID();
    await db.query(
      `INSERT INTO discovery_evaluation(id,run_id,market_id,policy_version,provider_code,provider_exchange,result,input_digest,created_at,catalog_snapshot_id)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)`,
      [
        id,
        run.id,
        result.marketId,
        result.policyVersion,
        result.providerCode,
        result.providerExchange,
        resultText,
        digest,
        this.clock(),
        run.catalog_snapshot_id,
      ],
    );
    if (inputText !== null)
      await db.query(
        "INSERT INTO discovery_evaluation_input(evaluation_id,payload) VALUES($1,$2::jsonb)",
        [id, inputText],
      );
    if (run.mode === "AUTO_ADD" && result.state === "PASS" && input) {
      if (!this.intakeWriter)
        throw new Error("Discovery AUTO_ADD intake writer is unavailable");
      // The outbox is an external owner of the PASS input. Keep the immutable
      // payload until the outbox reaches a terminal retention boundary; the
      // compactor releases this specific hold only when it retires that row.
      await db.query(
        "INSERT INTO discovery_evidence_hold(evaluation_id,reason) VALUES($1,'DISCOVERY_INTAKE_OUTBOX') ON CONFLICT DO NOTHING",
        [id],
      );
      await this.intakeWriter.enqueuePass(db, {
        evaluationId: id,
        runId: run.id,
        result,
        input,
      });
    }
    return {
      evidence: discoveryEvidenceSchema.parse({
        id,
        runId: run.id,
        result,
        inputDigest: digest,
        input,
        inputRetained: input !== null,
      }),
      inserted: true,
    };
  }

  /**
   * `locked` serializes updates for a run. Advance its bounded counters from
   * the newly inserted identity instead of rescanning every prior evaluation
   * after each write; completion still reconciles them from durable evidence.
   */
  private async incrementCoverage(
    db: Db,
    run: RunRow,
    state: DiscoveryEvaluationResult["state"],
    timing: SerializationTiming,
  ): Promise<void> {
    const current = discoveryCoverageSchema.parse(run.coverage);
    const consumesDeferred = state !== "DEFERRED";
    if (consumesDeferred && current.deferred === 0)
      throw new Error("Discovery coverage exceeds captured catalog size");
    const coverage = discoveryCoverageSchema.parse({
      total: current.total,
      pass: current.pass + (state === "PASS" ? 1 : 0),
      fail: current.fail + (state === "FAIL" ? 1 : 0),
      unevaluable: current.unevaluable + (state === "UNEVALUABLE" ? 1 : 0),
      deferred: current.deferred - (consumesDeferred ? 1 : 0),
    });
    await db.query("UPDATE discovery_run SET coverage=$2::jsonb WHERE id=$1", [
      run.id,
      timedJsonStringify(coverage, timing),
    ]);
  }

  private async updateCoverage(db: Db, run: RunRow) {
    const groups = (
      await db.query<{ state: string; count: number }>(
        "SELECT result->>'state' AS state,count(*)::int AS count FROM discovery_evaluation WHERE run_id=$1 GROUP BY result->>'state'",
        [run.id],
      )
    ).rows;
    const count = (state: string) =>
      groups.find((group) => group.state === state)?.count ?? 0;
    const total = run.row_count;
    const coverage = discoveryCoverageSchema.parse({
      total,
      pass: count("PASS"),
      fail: count("FAIL"),
      unevaluable: count("UNEVALUABLE"),
      deferred: total - count("PASS") - count("FAIL") - count("UNEVALUABLE"),
    });
    await db.query("UPDATE discovery_run SET coverage=$2::jsonb WHERE id=$1", [
      run.id,
      JSON.stringify(coverage),
    ]);
    return coverage;
  }

  async complete(
    runId: string,
    marketId: MarketId,
    failure: "PROVIDER_FAILURE" | "CANCELLED" | null = null,
  ): Promise<DiscoveryRun> {
    z.enum(["PROVIDER_FAILURE", "CANCELLED"]).nullable().parse(failure);
    return this.transaction(async (db) => {
      const run = await this.locked(db, runId, marketId);
      if (run.status !== "RUNNING") return parseRun(run);
      const metrics = Object.fromEntries(
        [
          "price",
          "marketCap",
          "averageVolume90d",
          "averageVolume30d",
          "atr14",
          "atrPct",
          "relativeVolume",
          "changeFromOpenPct",
          "dollarVolume30d",
        ].map((key) => [key, { value: null, asOf: null }]),
      );
      const unfinished = discoveryEvaluationResultSchema.parse({
        marketId,
        policyVersion: run.policy_version,
        providerCode: "__DEFERRED__",
        providerExchange: "__DEFERRED__",
        symbolId: null,
        tradingDate: run.trading_date,
        evaluationAt: run.evaluation_at.toISOString(),
        computedAt: this.clock().toISOString(),
        completedBarEnd: run.completed_bar_end.toISOString(),
        state: "DEFERRED",
        reasons: [
          failure === "PROVIDER_FAILURE"
            ? "PROVIDER_FAILURE"
            : failure === "CANCELLED"
              ? "DISCOVERY_CANCELLED"
              : "BUDGET_DEFERRED",
        ],
        metrics,
      });
      await db.query(
        `INSERT INTO discovery_evaluation(id,run_id,market_id,policy_version,provider_code,provider_exchange,result,input_digest,created_at,catalog_snapshot_id)
        SELECT gen_random_uuid(),$1,$5,$6,m.provider_code,m.provider_exchange,
          $3::jsonb || jsonb_build_object('providerCode',m.provider_code,'providerExchange',m.provider_exchange),NULL,$4,$2
        FROM discovery_catalog_member m WHERE m.snapshot_id=$2
          AND NOT EXISTS(SELECT 1 FROM discovery_evaluation e WHERE e.run_id=$1 AND e.provider_exchange=m.provider_exchange AND e.provider_code=m.provider_code)`,
        [
          run.id,
          run.catalog_snapshot_id,
          JSON.stringify(unfinished),
          this.clock(),
          run.market_id,
          run.policy_version,
        ],
      );
      const coverage = await this.updateCoverage(db, run);
      const status =
        failure === "CANCELLED"
          ? "CANCELLED"
          : failure
            ? "FAILED"
            : coverage.unevaluable || coverage.deferred
              ? "PARTIAL"
              : "COMPLETED";
      await db.query(
        "UPDATE discovery_run SET status=$2,completed_at=$3,failure=$4 WHERE id=$1",
        [runId, status, this.clock(), failure],
      );
      return parseRun(
        (
          await db.query<RunRow>(
            `${runSelect} WHERE r.id=$1 AND r.market_id=$2`,
            [runId, marketId],
          )
        ).rows[0]!,
      );
    });
  }

  /** Complete only while the caller still owns the scheduled run fence. */
  async completeOwned(
    runId: string,
    lease: DiscoveryLease,
    failure: "PROVIDER_FAILURE" | "CANCELLED" | null = null,
    diagnostic?: DiscoveryAttemptDiagnosticsDraft,
  ): Promise<DiscoveryRun> {
    return this.transaction(async (db) => {
      await this.assertLease(db, runId, lease);
      return this.completeIn(db, runId, lease.marketId, failure, diagnostic);
    });
  }

  private async completeIn(
    db: Db,
    runId: string,
    marketId: MarketId,
    failure: "PROVIDER_FAILURE" | "CANCELLED" | null,
    diagnostic?: DiscoveryAttemptDiagnosticsDraft,
  ): Promise<DiscoveryRun> {
    const run = await this.locked(db, runId, marketId);
    const draft =
      diagnostic === undefined
        ? undefined
        : discoveryAttemptDiagnosticsDraftSchema.parse(diagnostic);
    if (draft && draft.marketId !== run.market_id)
      throw new Error("Discovery diagnostic ownership conflict");
    if (run.status !== "RUNNING") {
      if (draft) await this.persistDiagnostic(db, parseRun(run), draft, true);
      return parseRun(run);
    }
    const metrics = Object.fromEntries(
      [
        "price",
        "marketCap",
        "averageVolume90d",
        "averageVolume30d",
        "atr14",
        "atrPct",
        "relativeVolume",
        "changeFromOpenPct",
        "dollarVolume30d",
      ].map((key) => [key, { value: null, asOf: null }]),
    );
    const unfinished = discoveryEvaluationResultSchema.parse({
      marketId,
      policyVersion: run.policy_version,
      providerCode: "__DEFERRED__",
      providerExchange: "__DEFERRED__",
      symbolId: null,
      tradingDate: run.trading_date,
      evaluationAt: run.evaluation_at.toISOString(),
      computedAt: this.clock().toISOString(),
      completedBarEnd: run.completed_bar_end.toISOString(),
      state: "DEFERRED",
      reasons: [
        failure === "PROVIDER_FAILURE"
          ? "PROVIDER_FAILURE"
          : failure === "CANCELLED"
            ? "DISCOVERY_CANCELLED"
            : "BUDGET_DEFERRED",
      ],
      metrics,
    });
    await db.query(
      `INSERT INTO discovery_evaluation(id,run_id,market_id,policy_version,provider_code,provider_exchange,result,input_digest,created_at,catalog_snapshot_id)
      SELECT gen_random_uuid(),$1,$5,$6,m.provider_code,m.provider_exchange,
        $3::jsonb || jsonb_build_object('providerCode',m.provider_code,'providerExchange',m.provider_exchange),NULL,$4,$2
      FROM discovery_catalog_member m WHERE m.snapshot_id=$2
        AND NOT EXISTS(SELECT 1 FROM discovery_evaluation e WHERE e.run_id=$1 AND e.provider_exchange=m.provider_exchange AND e.provider_code=m.provider_code)`,
      [
        run.id,
        run.catalog_snapshot_id,
        JSON.stringify(unfinished),
        this.clock(),
        run.market_id,
        run.policy_version,
      ],
    );
    const coverage = await this.updateCoverage(db, run);
    const status =
      failure === "CANCELLED"
        ? "CANCELLED"
        : failure
          ? "FAILED"
          : coverage.unevaluable || coverage.deferred
            ? "PARTIAL"
            : "COMPLETED";
    await db.query(
      "UPDATE discovery_run SET status=$2,completed_at=$3,failure=$4 WHERE id=$1",
      [runId, status, this.clock(), failure],
    );
    const completed = parseRun(
      (
        await db.query<RunRow>(
          `${runSelect} WHERE r.id=$1 AND r.market_id=$2`,
          [runId, marketId],
        )
      ).rows[0]!,
    );
    if (draft) await this.persistDiagnostic(db, completed, draft, false);
    return completed;
  }

  private async persistDiagnostic(
    db: Db,
    run: DiscoveryRun,
    draft: DiscoveryAttemptDiagnosticsDraft,
    retry: boolean,
  ): Promise<void> {
    const existing = await db.query<{ payload: unknown }>(
      "SELECT payload FROM discovery_run_diagnostic WHERE run_id=$1 AND market_id=$2 AND attempt_id=$3",
      [run.id, run.marketId, draft.attemptId],
    );
    if (retry && !existing.rows[0])
      throw new Error("Completed discovery diagnostic cannot be backfilled");
    const recorded = existing.rows[0]
      ? discoveryAttemptDiagnosticsSchema.parse(existing.rows[0].payload)
      : null;
    const capturedAt =
      recorded?.capturedAt ??
      (
        await db.query<{ captured_at: Date }>(
          "SELECT clock_timestamp() AS captured_at",
        )
      ).rows[0]!.captured_at.toISOString();
    const {
      wallMs,
      stages: { EVIDENCE, ...stages },
      ...observations
    } = draft;
    const summary = discoveryAttemptDiagnosticsSchema.parse({
      ...observations,
      schemaVersion: "discovery-attempt-diagnostics-v1",
      timingBoundary: "BEFORE_COMPLETION_TRANSACTION",
      preCompletionWallMs: wallMs,
      stages: { ...stages, PRE_COMPLETION_PERSISTENCE: EVIDENCE },
      runId: run.id,
      capturedAt,
      frozenEvaluationAt: run.evaluationAt,
      finalRunCoverage: run.coverage,
    });
    if (recorded) {
      const check = await db.query<{ matches: boolean }>(
        "SELECT payload=$4::jsonb AS matches FROM discovery_run_diagnostic WHERE run_id=$1 AND market_id=$2 AND attempt_id=$3",
        [run.id, run.marketId, draft.attemptId, JSON.stringify(summary)],
      );
      if (!check.rows[0]?.matches)
        throw new Error(
          "Discovery diagnostic retry conflicts with completed evidence",
        );
      return;
    }
    await db.query(
      `INSERT INTO discovery_run_diagnostic(run_id,market_id,attempt_id,schema_version,captured_at,payload)
       VALUES($1,$2,$3,$4,$5,$6::jsonb)`,
      [
        run.id,
        run.marketId,
        draft.attemptId,
        summary.schemaVersion,
        capturedAt,
        JSON.stringify(summary),
      ],
    );
  }

  async listLatestDiagnostics(
    marketId: MarketId,
  ): Promise<DiscoveryAttemptDiagnostics | null> {
    marketIdSchema.parse(marketId);
    const result = await this.pool.query<{ payload: unknown }>(
      `SELECT d.payload FROM discovery_run_diagnostic d
       JOIN discovery_run r ON r.id=d.run_id AND r.market_id=d.market_id
       WHERE d.market_id=$1 AND r.status<>'RUNNING'
       ORDER BY d.captured_at DESC,d.run_id,d.attempt_id LIMIT 1`,
      [marketId],
    );
    return result.rows[0]
      ? discoveryAttemptDiagnosticsSchema.parse(result.rows[0].payload)
      : null;
  }

  private async assertLease(
    db: Db,
    runId: string,
    lease: DiscoveryLease,
  ): Promise<void> {
    const result = await db.query(
      `SELECT 1 FROM discovery_schedule_lease
       WHERE market_id=$1 AND trading_date=$2 AND policy_version=$3
         AND completed_bar_end=$4 AND idempotency_key=$5 AND owner_token=$6
         AND fencing_generation=$7 AND run_id=$8 AND status='ACTIVE'
         AND lease_expires_at > clock_timestamp()`,
      [
        lease.marketId,
        lease.tradingDate,
        lease.policyVersion,
        lease.completedBarEnd,
        lease.idempotencyKey,
        lease.ownerToken,
        lease.fencingGeneration,
        runId,
      ],
    );
    if (!result.rowCount)
      throw new Error("Discovery scheduled run lease is stale");
  }

  async listRuns(
    marketId: MarketId,
    options: number | { limit?: number; before?: string } = 50,
  ): Promise<DiscoveryRun[]> {
    marketIdSchema.parse(marketId);
    const limit = typeof options === "number" ? options : (options.limit ?? 50);
    z.number().int().min(1).max(200).parse(limit);
    const before =
      typeof options === "number" || options.before === undefined
        ? null
        : z.string().datetime().parse(options.before);
    return (
      await this.pool.query<RunRow>(
        `${runSelect} WHERE r.market_id=$1
          AND ($2::timestamptz IS NULL OR r.evaluation_at < $2::timestamptz)
          ORDER BY r.evaluation_at DESC,r.id LIMIT $3`,
        [marketId, before, limit],
      )
    ).rows.map(parseRun);
  }

  async getRun(
    marketId: MarketId,
    runId: string,
  ): Promise<DiscoveryRun | null> {
    marketIdSchema.parse(marketId);
    z.string().uuid().parse(runId);
    const result = await this.pool.query<RunRow>(
      `${runSelect} WHERE r.market_id=$1 AND r.id=$2`,
      [marketId, runId],
    );
    if (result.rows.length === 0) return null;
    return parseRun(result.rows[0]!);
  }

  async listEvaluations(
    marketId: MarketId,
    runId: string,
    options: {
      limit?: number;
      after?: { exchange: string; code: string };
      includeInput?: boolean;
    } = {},
  ): Promise<DiscoveryEvidence[]> {
    marketIdSchema.parse(marketId);
    z.string().uuid().parse(runId);
    const limit = z
      .number()
      .int()
      .min(1)
      .max(200)
      .parse(options.limit ?? 50);
    const select = options.includeInput
      ? evidenceSelect
      : `SELECT e.id,e.run_id,e.result,e.input_digest,NULL::jsonb AS payload,
      EXISTS(SELECT 1 FROM discovery_evaluation_input i WHERE i.evaluation_id=e.id) AS input_retained FROM discovery_evaluation e`;
    const result = await this.pool.query<EvidenceRow>(
      `${select} WHERE e.market_id=$1 AND e.run_id=$2
      AND ($3::text IS NULL OR (e.provider_exchange,e.provider_code)>($3::text,$4::text)) ORDER BY e.provider_exchange,e.provider_code LIMIT $5`,
      [
        marketId,
        runId,
        options.after?.exchange ?? null,
        options.after?.code ?? null,
        limit,
      ],
    );
    return result.rows.map((row) =>
      parseEvidence(row, options.includeInput ?? false),
    );
  }

  async holdEvidence(
    marketId: MarketId,
    evaluationId: string,
    reason: string,
  ): Promise<void> {
    marketIdSchema.parse(marketId);
    z.string().uuid().parse(evaluationId);
    z.string().trim().min(1).max(500).parse(reason);
    await this.transaction(async (db) => {
      const evidence = (
        await db.query<{ id: string }>(
          "SELECT id FROM discovery_evaluation WHERE id=$1 AND market_id=$2 FOR UPDATE",
          [evaluationId, marketId],
        )
      ).rows[0];
      if (!evidence)
        throw new Error("Discovery evidence not found in selected market");
      const input = await db.query(
        "SELECT evaluation_id FROM discovery_evaluation_input WHERE evaluation_id=$1",
        [evaluationId],
      );
      if (!input.rows.length)
        throw new Error("Cannot hold unavailable discovery input");
      await db.query(
        "INSERT INTO discovery_evidence_hold(evaluation_id,reason) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [evaluationId, reason],
      );
    });
  }

  async compact(
    inputDays = 30,
    summaryDays = 365,
  ): Promise<{ inputs: number; runs: number }> {
    z.number().int().min(1).max(365).parse(inputDays);
    z.number().int().min(inputDays).max(3650).parse(summaryDays);
    return this.transaction(async (db) => {
      // PASS evidence referenced by intake is held until its terminal outbox
      // row is retired. Retire the two records together at the summary
      // boundary, so the outbox's ON DELETE RESTRICT FK can never make a
      // later run-summary delete roll back the maintenance transaction.
      const retiredOutbox = await db.query<{ evaluation_id: string }>(
        `SELECT o.evaluation_id
         FROM discovery_intake_outbox o
         JOIN discovery_evaluation e ON e.id=o.evaluation_id
         JOIN discovery_run r ON r.id=e.run_id
         WHERE r.status<>'RUNNING'
           AND o.created_at<$1::timestamptz-make_interval(days=>$2)
           AND (
             (o.status='DELIVERED' AND o.sync_status='COMPLETE')
             OR o.status IN ('EXPIRED','FAILED')
           )
         ORDER BY o.created_at,o.id
         LIMIT 500 FOR UPDATE OF o SKIP LOCKED`,
        [this.clock(), summaryDays],
      );
      const retiredEvaluationIds = retiredOutbox.rows.map(
        (row) => row.evaluation_id,
      );
      if (retiredEvaluationIds.length > 0) {
        await db.query(
          `DELETE FROM discovery_evidence_hold
           WHERE evaluation_id=ANY($1::uuid[])
             AND reason='DISCOVERY_INTAKE_OUTBOX'`,
          [retiredEvaluationIds],
        );
        await db.query(
          "DELETE FROM discovery_intake_outbox WHERE evaluation_id=ANY($1::uuid[])",
          [retiredEvaluationIds],
        );
      }

      // Lock candidate evidence first, using the same lock as holdEvidence. Holds
      // cannot race an input deletion or claim already-compacted qualification.
      const candidates = await db.query<{ id: string }>(
        `SELECT e.id FROM discovery_evaluation e JOIN discovery_run r ON r.id=e.run_id
        JOIN discovery_evaluation_input i ON i.evaluation_id=e.id
        WHERE r.status<>'RUNNING' AND e.created_at<$1::timestamptz-make_interval(days=>$2)
        AND NOT EXISTS(SELECT 1 FROM discovery_evidence_hold h WHERE h.evaluation_id=e.id)
        ORDER BY e.created_at,e.id LIMIT 500 FOR UPDATE OF e SKIP LOCKED`,
        [this.clock(), inputDays],
      );
      const ids = candidates.rows.map((row) => row.id);
      const inputs = await db.query(
        "DELETE FROM discovery_evaluation_input i WHERE i.evaluation_id=ANY($1::uuid[]) AND NOT EXISTS(SELECT 1 FROM discovery_evidence_hold h WHERE h.evaluation_id=i.evaluation_id)",
        [ids],
      );
      const runs = await db.query(
        `WITH expired AS (SELECT r.id FROM discovery_run r WHERE status<>'RUNNING' AND completed_at<$1::timestamptz-make_interval(days=>$2)
        AND NOT EXISTS(SELECT 1 FROM discovery_evaluation e JOIN discovery_evidence_hold h ON h.evaluation_id=e.id WHERE e.run_id=r.id)
        AND NOT EXISTS(SELECT 1 FROM discovery_evaluation e JOIN discovery_evaluation_input i ON i.evaluation_id=e.id WHERE e.run_id=r.id)
        ORDER BY completed_at,r.id LIMIT 10 FOR UPDATE OF r SKIP LOCKED)
        DELETE FROM discovery_run WHERE id IN(SELECT id FROM expired)`,
        [this.clock(), summaryDays],
      );
      await db.query(
        `DELETE FROM discovery_catalog_snapshot s WHERE s.fetched_at<$1::timestamptz-make_interval(days=>$2)
        AND NOT EXISTS(SELECT 1 FROM discovery_run r WHERE r.catalog_snapshot_id=s.id)`,
        [this.clock(), summaryDays],
      );
      return { inputs: inputs.rowCount ?? 0, runs: runs.rowCount ?? 0 };
    });
  }
}
