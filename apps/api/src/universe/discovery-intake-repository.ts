import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import {
  candidateIntakeEntrySchema,
  candidateIntakeStatusSchema,
  discoveryEvaluationInputSchema,
  discoveryEvaluationResultSchema,
  discoveryPolicyForMarket,
  marketIdSchema,
  type CandidateIntakeEntry,
  type CandidateIntakeStatus,
  type DiscoveryEvaluationInput,
  type DiscoveryEvaluationResult,
  type MarketId,
  type UpdateCandidateIntake,
} from "@tsx-scanner/contracts";
import type { DiscoveryDb } from "./discovery-evidence-repository.js";
import type { PersistedInstrument } from "../market-data/repository.js";

export interface DiscoveryOutboxWriter {
  enqueuePass(
    db: DiscoveryDb,
    input: {
      evaluationId: string;
      runId: string;
      result: DiscoveryEvaluationResult;
      input: DiscoveryEvaluationInput;
    },
  ): Promise<void>;
}

export interface DiscoveryIntakeAction {
  id: string;
  marketId: MarketId;
  syncOnly: boolean;
  symbol: string;
  instrument: PersistedInstrument;
}

export interface DiscoveryIntakeRepository extends DiscoveryOutboxWriter {
  listCandidateIntakeStatuses(
    provider: string,
    tradingDate: string,
    marketId?: MarketId,
  ): Promise<CandidateIntakeStatus[]>;
  claimNext(
    marketId: MarketId,
    tradingDate: string,
  ): Promise<DiscoveryIntakeAction | null>;
  markSynchronized(id: string): Promise<void>;
  markSynchronizationFailed(id: string, error: string): Promise<void>;
  expireUndelivered(marketId: MarketId, tradingDate: string): Promise<number>;
  applyManualCandidates(
    provider: string,
    operation: UpdateCandidateIntake["operation"],
    tradingDate: string,
    candidates: CandidateIntakeEntry[],
    marketId: MarketId,
  ): Promise<CandidateIntakeEntry[]>;
  setExclusion(input: {
    marketId: MarketId;
    tradingDate: string;
    instrumentId: string;
    excluded: boolean;
    actor: string;
    reason: string;
  }): Promise<void>;
}

interface ModeRow {
  mode: "OFF" | "SHADOW" | "AUTO_ADD";
  revision: string | number;
}

interface WatchlistRow {
  symbols: unknown;
  candidates: unknown;
  trading_date: string;
}

interface OutboxRow {
  id: string;
  market_id: MarketId;
  trading_date: string;
  mode_revision: string | number;
  normalized_symbol: string;
  questrade_symbol_id: string | number;
  payload: unknown;
  status: "PENDING" | "PROCESSING" | "DELIVERED" | "SYNCING";
  sync_status: "PENDING" | "COMPLETE";
  attempt_count: string | number;
}

interface IntakeInstrumentRow {
  id: string;
  questrade_symbol_id: string | number;
  symbol: string;
  description: string;
  security_type: string;
  exchange: string;
  currency: string;
  is_quotable: boolean;
  is_tradable: boolean;
  active: boolean;
  industry_sector: string | null;
}

interface IntakeStatusRow {
  normalized_symbol: string;
  status: OutboxRow["status"] | "EXPIRED" | "FAILED";
  sync_status: OutboxRow["sync_status"];
  attempt_count: string | number;
  last_error: string | null;
  intake_at: Date | string | null;
  payload: unknown;
}

interface ExclusionStatusRow {
  normalized_symbol: string;
  reason: string;
}

const WATCHLIST_PROVIDERS = new Set([
  "CONFIGURED_TSX_LIVE_WATCHLIST",
  "CONFIGURED_US_LIVE_WATCHLIST",
]);

function providerFor(marketId: MarketId): string {
  return marketId === "CA_TSX"
    ? "CONFIGURED_TSX_LIVE_WATCHLIST"
    : "CONFIGURED_US_LIVE_WATCHLIST";
}

function parseCandidates(value: unknown): CandidateIntakeEntry[] {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((item) => {
    const candidate = candidateIntakeEntrySchema.safeParse(item);
    return candidate.success ? [candidate.data] : [];
  });
}

function mergeUnique<T>(left: T[], right: T[]): T[] {
  return [...new Set([...left, ...right])];
}

function mergeCandidate(
  current: CandidateIntakeEntry | undefined,
  incoming: CandidateIntakeEntry,
): CandidateIntakeEntry {
  if (!current) return candidateIntakeEntrySchema.parse(incoming);
  return candidateIntakeEntrySchema.parse({
    ...current,
    // Manual and TradingView metadata remain authoritative once a symbol is
    // already present. Discovery contributes provenance and its evidence IDs.
    requestedExchange: incoming.requestedExchange ?? current.requestedExchange,
    note: incoming.note ?? current.note,
    tags: mergeUnique(current.tags, incoming.tags),
    provenanceSources: mergeUnique(
      current.provenanceSources ?? [current.source],
      incoming.provenanceSources ?? [incoming.source],
    ),
    discoveryRunId: incoming.discoveryRunId ?? current.discoveryRunId,
    discoveryEvaluationId:
      incoming.discoveryEvaluationId ?? current.discoveryEvaluationId,
    discoveredAt: incoming.discoveredAt ?? current.discoveredAt,
    intakeAt: incoming.intakeAt ?? current.intakeAt,
    strategyReadyAt: incoming.strategyReadyAt ?? current.strategyReadyAt,
    resolvedInstrumentId:
      incoming.resolvedInstrumentId ?? current.resolvedInstrumentId,
    resolvedSymbol: incoming.resolvedSymbol ?? current.resolvedSymbol,
    resolutionStatus:
      incoming.resolutionStatus === "RESOLVED"
        ? incoming.resolutionStatus
        : current.resolutionStatus,
  });
}

function parsePayload(value: unknown): CandidateIntakeEntry {
  return candidateIntakeEntrySchema.parse(value);
}

function errorText(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.slice(0, 500) || "Discovery intake synchronization failed";
}

function isoDateTime(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

/**
 * Durable WP5 intake boundary. The only external work after claim is runtime
 * synchronization; watchlist membership and its provenance are committed first.
 */
export class PostgresDiscoveryIntakeRepository implements DiscoveryIntakeRepository {
  constructor(
    private readonly pool: Pool,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async listCandidateIntakeStatuses(
    provider: string,
    tradingDate: string,
    marketId?: MarketId,
  ): Promise<CandidateIntakeStatus[]> {
    const resolvedMarketId =
      marketId ??
      (provider === "CONFIGURED_TSX_LIVE_WATCHLIST"
        ? "CA_TSX"
        : provider === "CONFIGURED_US_LIVE_WATCHLIST"
          ? "US_EQUITIES"
          : null);
    if (!resolvedMarketId)
      throw new Error(
        "Watchlist provider does not identify a market: " + provider,
      );
    marketIdSchema.parse(resolvedMarketId);
    if (provider !== providerFor(resolvedMarketId))
      throw new Error(
        "Watchlist provider does not belong to " + resolvedMarketId,
      );
    z.string().date().parse(tradingDate);

    const watchlist = await this.pool.query<WatchlistRow>(
      `SELECT symbols,candidates,trading_date::text AS trading_date
       FROM universe_watchlist WHERE market_id=$1 AND provider=$2`,
      [resolvedMarketId, provider],
    );
    const current =
      watchlist.rows[0]?.trading_date === tradingDate
        ? parseCandidates(watchlist.rows[0].candidates)
        : [];
    const outbox = await this.pool.query<IntakeStatusRow>(
      `SELECT DISTINCT ON (normalized_symbol)
         normalized_symbol,status,sync_status,attempt_count,last_error,
         intake_at,payload
       FROM discovery_intake_outbox
       WHERE market_id=$1 AND trading_date=$2
       ORDER BY normalized_symbol,created_at DESC,id DESC`,
      [resolvedMarketId, tradingDate],
    );
    const exclusions = await this.pool.query<ExclusionStatusRow>(
      `SELECT normalized_symbol,reason
       FROM discovery_intake_exclusion
       WHERE market_id=$1 AND trading_date=$2 AND cleared_at IS NULL`,
      [resolvedMarketId, tradingDate],
    );
    const bySymbol = new Map(
      current.map((candidate) => [candidate.normalizedSymbol, candidate]),
    );
    const outboxBySymbol = new Map(
      outbox.rows.map((row) => [row.normalized_symbol, row]),
    );
    const exclusionBySymbol = new Map(
      exclusions.rows.map((row) => [row.normalized_symbol, row.reason]),
    );
    const symbols = new Set([...bySymbol.keys(), ...exclusionBySymbol.keys()]);
    for (const row of outbox.rows) {
      if (
        row.status === "PENDING" ||
        row.status === "PROCESSING" ||
        row.status === "SYNCING"
      )
        symbols.add(row.normalized_symbol);
    }
    return [...symbols]
      .sort((left, right) => left.localeCompare(right))
      .map((symbol) => {
        const candidate = bySymbol.get(symbol);
        const delivery = outboxBySymbol.get(symbol);
        const deliveryPayload = delivery
          ? candidateIntakeEntrySchema.safeParse(delivery.payload).data
          : undefined;
        const exclusionReason = exclusionBySymbol.get(symbol);
        const status = exclusionReason
          ? "EXCLUDED"
          : delivery
            ? delivery.status === "DELIVERED" &&
              delivery.sync_status === "COMPLETE"
              ? "READY"
              : delivery.status === "SYNCING"
                ? "WARMING"
                : delivery.status === "DELIVERED"
                  ? delivery.last_error
                    ? "FAILED"
                    : "ADDED"
                  : delivery.status === "PENDING" ||
                      delivery.status === "PROCESSING"
                    ? "QUALIFIED"
                    : "FAILED"
            : candidate
              ? candidate.strategyReadyAt
                ? "READY"
                : candidate.source === "DISCOVERY"
                  ? candidate.intakeAt
                    ? "ADDED"
                    : "QUALIFIED"
                  : "ADDED"
              : "FAILED";
        return candidateIntakeStatusSchema.parse({
          symbol,
          status,
          source: candidate?.source ?? deliveryPayload?.source ?? "MANUAL",
          discoveredAt:
            candidate?.discoveredAt ?? deliveryPayload?.discoveredAt ?? null,
          intakeAt:
            candidate?.intakeAt ?? isoDateTime(delivery?.intake_at) ?? null,
          strategyReadyAt: candidate?.strategyReadyAt ?? null,
          reason: exclusionReason ?? delivery?.last_error ?? null,
          attemptCount: Number(delivery?.attempt_count ?? 0),
        });
      });
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

  async enqueuePass(
    db: DiscoveryDb,
    value: {
      evaluationId: string;
      runId: string;
      result: DiscoveryEvaluationResult;
      input: DiscoveryEvaluationInput;
    },
  ): Promise<void> {
    const result = discoveryEvaluationResultSchema.parse(value.result);
    const input = discoveryEvaluationInputSchema.parse(value.input);
    if (
      result.state !== "PASS" ||
      result.marketId !== input.marketId ||
      result.providerCode !== input.providerCode ||
      result.providerExchange !== input.providerExchange ||
      result.symbolId !== input.identity.symbolId
    )
      throw new Error("Discovery intake pass ownership conflict");

    // Mode is read under the same transaction as the immutable evidence write.
    // If an operator disables AUTO_ADD first, the PASS remains evidence but no
    // automatic mutation is created.
    const mode = (
      await db.query<ModeRow>(
        "SELECT mode,revision FROM discovery_mode WHERE market_id=$1 FOR UPDATE",
        [result.marketId],
      )
    ).rows[0];
    if (!mode || mode.mode !== "AUTO_ADD") return;

    const payload = candidateIntakeEntrySchema.parse({
      source: "DISCOVERY",
      tradingDate: input.tradingDate,
      addedAt: result.evaluationAt,
      originalInput: `${input.providerExchange}:${input.providerCode}`,
      marketId: input.marketId,
      requestedExchange: input.identity.exchange,
      normalizedSymbol: input.identity.symbol,
      resolvedInstrumentId: null,
      resolvedSymbol: input.identity.symbol,
      resolutionStatus: "RESOLVED",
      note: null,
      tags: [],
      provenanceSources: ["DISCOVERY"],
      discoveryRunId: value.runId,
      discoveryEvaluationId: value.evaluationId,
      discoveredAt: result.evaluationAt,
      intakeAt: null,
      strategyReadyAt: null,
    });
    await db.query(
      `INSERT INTO discovery_intake_outbox(
        evaluation_id,market_id,trading_date,policy_version,mode_revision,
        normalized_symbol,provider_code,provider_exchange,questrade_symbol_id,payload,
        status,sync_status,next_attempt_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,'PENDING','PENDING',clock_timestamp())
      ON CONFLICT DO NOTHING`,
      [
        value.evaluationId,
        input.marketId,
        input.tradingDate,
        input.policyVersion,
        Number(mode.revision),
        input.identity.symbol,
        input.providerCode,
        input.providerExchange,
        input.identity.symbolId,
        JSON.stringify(payload),
      ],
    );
  }

  async claimNext(
    marketId: MarketId,
    tradingDate: string,
  ): Promise<DiscoveryIntakeAction | null> {
    marketIdSchema.parse(marketId);
    return this.transaction(async (db) => {
      const mode = (
        await db.query<ModeRow>(
          "SELECT mode,revision FROM discovery_mode WHERE market_id=$1 FOR UPDATE",
          [marketId],
        )
      ).rows[0];
      if (!mode)
        throw new Error(`Discovery mode is not seeded for ${marketId}`);
      await db.query(
        `SELECT normalized_symbol FROM discovery_intake_exclusion
         WHERE market_id=$1 AND trading_date=$2 FOR UPDATE`,
        [marketId, tradingDate],
      );
      const provider = providerFor(marketId);
      if (!WATCHLIST_PROVIDERS.has(provider))
        throw new Error(`Discovery watchlist provider is invalid: ${provider}`);
      const watchlist = await this.lockWatchlist(
        db,
        provider,
        marketId,
        tradingDate,
      );
      const row = (
        await db.query<OutboxRow>(
          `SELECT id,market_id,trading_date::text AS trading_date,mode_revision,
             normalized_symbol,questrade_symbol_id,payload,status,sync_status,attempt_count
           FROM discovery_intake_outbox
           WHERE market_id=$1 AND (
             (status IN ('PENDING','PROCESSING') AND next_attempt_at <= clock_timestamp()
                AND (status='PENDING' OR lease_expires_at IS NULL OR lease_expires_at <= clock_timestamp()))
             OR (status='DELIVERED' AND sync_status='PENDING' AND next_attempt_at <= clock_timestamp())
             OR (status='SYNCING' AND lease_expires_at <= clock_timestamp())
           )
           ORDER BY created_at,id
           LIMIT 1 FOR UPDATE SKIP LOCKED`,
          [marketId],
        )
      ).rows[0];
      if (!row) return null;

      // A lease can outlive the market session that created it. Never allow
      // an old delivery/synchronization attempt to run against today's
      // watchlist: its empty/missing membership view must not overwrite the
      // current day's candidate metadata.
      if (row.trading_date !== tradingDate) {
        await this.expireRow(
          db,
          row.id,
          "Discovery intake trading-date fence no longer valid",
        );
        return null;
      }

      const exclusion = (
        await db.query<{ instrument_id: string | null }>(
          `SELECT instrument_id FROM discovery_intake_exclusion
           WHERE market_id=$1 AND trading_date=$2 AND normalized_symbol=$3
             AND cleared_at IS NULL`,
          [marketId, tradingDate, row.normalized_symbol],
        )
      ).rows[0];
      if (exclusion) {
        await this.expireRow(db, row.id, "Excluded by manual intake");
        return null;
      }

      if (row.status === "DELIVERED" || row.status === "SYNCING") {
        await db.query(
          `UPDATE discovery_intake_outbox
           SET status='SYNCING',attempt_count=attempt_count+1,
               lease_expires_at=clock_timestamp()+interval '2 minutes',updated_at=clock_timestamp()
           WHERE id=$1`,
          [row.id],
        );
        const instrument = await this.loadInstrument(db, row.id);
        return {
          id: row.id,
          marketId,
          syncOnly: true,
          symbol: row.normalized_symbol,
          instrument,
        };
      }

      if (
        mode.mode !== "AUTO_ADD" ||
        Number(mode.revision) !== Number(row.mode_revision) ||
        row.trading_date !== tradingDate
      ) {
        await this.expireRow(
          db,
          row.id,
          "AUTO_ADD mode/date fence no longer valid",
        );
        return null;
      }

      const payload = parsePayload(row.payload);
      const qualifiedAt = Date.parse(payload.discoveredAt ?? payload.addedAt);
      const qualificationAgeMs = this.clock().getTime() - qualifiedAt;
      if (
        !Number.isFinite(qualifiedAt) ||
        qualificationAgeMs < 0 ||
        qualificationAgeMs >
          discoveryPolicyForMarket(marketId).maximumEvaluationAgeMs
      ) {
        await this.expireRow(
          db,
          row.id,
          "Discovery qualification freshness fence no longer valid",
        );
        return null;
      }

      const current =
        watchlist.trading_date === tradingDate
          ? parseCandidates(watchlist.candidates)
          : [];
      const instrument = (
        await db.query<IntakeInstrumentRow>(
          `INSERT INTO instrument(
             market_id,questrade_symbol_id,symbol,description,exchange,currency,
             security_type,is_quotable,is_tradable,active,universe_source
           ) VALUES($1,$2,$3,$4,$5,$6,'Common Stock',TRUE,TRUE,TRUE,'DISCOVERY_INTAKE')
           ON CONFLICT(market_id,symbol) DO UPDATE SET
             questrade_symbol_id=EXCLUDED.questrade_symbol_id,
             description=EXCLUDED.description,exchange=EXCLUDED.exchange,
             currency=EXCLUDED.currency,security_type=EXCLUDED.security_type,
             is_quotable=EXCLUDED.is_quotable,is_tradable=EXCLUDED.is_tradable,
             active=TRUE,universe_source=EXCLUDED.universe_source,updated_at=clock_timestamp()
           RETURNING id,questrade_symbol_id,symbol,description,security_type,exchange,
             currency,is_quotable,is_tradable,active,industry_sector`,
          [
            marketId,
            Number(row.questrade_symbol_id),
            payload.normalizedSymbol,
            payload.originalInput,
            payload.requestedExchange ??
              (marketId === "CA_TSX" ? "TSX" : "NASDAQ"),
            marketId === "CA_TSX" ? "CAD" : "USD",
          ],
        )
      ).rows[0];
      if (!instrument)
        throw new Error("Discovery intake instrument upsert failed");
      const persistedInstrument = mapIntakeInstrument(instrument);
      const intakeAt = this.clock().toISOString();
      const delivered = candidateIntakeEntrySchema.parse({
        ...mergeCandidate(
          current.find(
            (value) => value.normalizedSymbol === payload.normalizedSymbol,
          ),
          payload,
        ),
        resolvedInstrumentId: persistedInstrument.id,
        resolvedSymbol: payload.normalizedSymbol,
        resolutionStatus: "RESOLVED",
        intakeAt,
      });
      const merged = [
        ...current.filter(
          (value) => value.normalizedSymbol !== payload.normalizedSymbol,
        ),
        delivered,
      ].sort((left, right) =>
        left.normalizedSymbol.localeCompare(right.normalizedSymbol),
      );
      const symbols = merged.map((value) => value.normalizedSymbol);
      await db.query(
        `UPDATE universe_watchlist SET symbols=$3::jsonb,candidates=$4::jsonb,
           trading_date=$5,updated_at=clock_timestamp()
         WHERE market_id=$1 AND provider=$2`,
        [
          marketId,
          provider,
          JSON.stringify(symbols),
          JSON.stringify(merged),
          tradingDate,
        ],
      );
      await db.query(
        `UPDATE discovery_intake_outbox SET status='DELIVERED',sync_status='PENDING',
           instrument_id=$2,intake_at=$3::timestamptz,lease_expires_at=NULL,
           last_error=NULL,updated_at=clock_timestamp() WHERE id=$1`,
        [row.id, persistedInstrument.id, intakeAt],
      );
      return {
        id: row.id,
        marketId,
        syncOnly: false,
        symbol: payload.normalizedSymbol,
        instrument: persistedInstrument,
      };
    });
  }

  async markSynchronized(id: string): Promise<void> {
    const identity = await this.pool.query<{
      market_id: MarketId;
      trading_date: string;
      normalized_symbol: string;
    }>(
      `SELECT market_id,trading_date::text AS trading_date,normalized_symbol
       FROM discovery_intake_outbox WHERE id=$1`,
      [id],
    );
    const row = identity.rows[0];
    if (!row) return;
    if (marketTradingDate(row.market_id, this.clock()) !== row.trading_date)
      return this.transaction(async (db) => {
        await this.expireRow(
          db,
          id,
          "Discovery synchronization trading-date fence no longer valid",
        );
      });
    await this.transaction(async (db) => {
      await db.query(
        "SELECT market_id FROM discovery_mode WHERE market_id=$1 FOR UPDATE",
        [row.market_id],
      );
      await db.query(
        `SELECT normalized_symbol FROM discovery_intake_exclusion
         WHERE market_id=$1 AND trading_date=$2 FOR UPDATE`,
        [row.market_id, row.trading_date],
      );
      const watchlist = await this.lockWatchlist(
        db,
        providerFor(row.market_id),
        row.market_id,
        row.trading_date,
      );
      const locked = (
        await db.query<{
          status: OutboxRow["status"];
          sync_status: OutboxRow["sync_status"];
        }>(
          "SELECT status,sync_status FROM discovery_intake_outbox WHERE id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (
        !locked ||
        locked.sync_status !== "PENDING" ||
        (locked.status !== "SYNCING" && locked.status !== "DELIVERED")
      )
        return;
      if (watchlist.trading_date !== row.trading_date) {
        await this.expireRow(
          db,
          id,
          "Discovery synchronization watchlist date no longer valid",
        );
        return;
      }
      const exclusion = (
        await db.query(
          `SELECT 1 FROM discovery_intake_exclusion
           WHERE market_id=$1 AND trading_date=$2 AND normalized_symbol=$3
             AND cleared_at IS NULL`,
          [row.market_id, row.trading_date, row.normalized_symbol],
        )
      ).rows[0];
      if (exclusion) {
        await this.expireRow(db, id, "Excluded by manual intake");
        return;
      }
      const current = parseCandidates(watchlist.candidates);
      const candidate = current.find(
        (value) => value.normalizedSymbol === row.normalized_symbol,
      );
      if (!candidate) {
        await this.expireRow(
          db,
          id,
          "Discovery synchronization membership is no longer present",
        );
        return;
      }
      const readyAt = this.clock().toISOString();
      const candidates = current.map((candidate) =>
        candidate.normalizedSymbol === row.normalized_symbol
          ? candidateIntakeEntrySchema.parse({
              ...candidate,
              strategyReadyAt: readyAt,
            })
          : candidate,
      );
      const watchlistUpdate = await db.query(
        `UPDATE universe_watchlist SET candidates=$3::jsonb,updated_at=clock_timestamp()
         WHERE market_id=$1 AND provider=$2 AND trading_date=$4`,
        [
          row.market_id,
          providerFor(row.market_id),
          JSON.stringify(candidates),
          row.trading_date,
        ],
      );
      if (watchlistUpdate.rowCount !== 1) {
        await this.expireRow(
          db,
          id,
          "Discovery synchronization watchlist date no longer valid",
        );
        return;
      }
      await db.query(
        `UPDATE discovery_intake_outbox SET status='DELIVERED',sync_status='COMPLETE',
           synchronized_at=clock_timestamp(),lease_expires_at=NULL,last_error=NULL,
           updated_at=clock_timestamp()
         WHERE id=$1 AND status IN ('DELIVERED','SYNCING') AND sync_status='PENDING'`,
        [id],
      );
    });
  }

  async markSynchronizationFailed(id: string, error: string): Promise<void> {
    await this.pool.query(
      `UPDATE discovery_intake_outbox SET status='DELIVERED',sync_status='PENDING',
         next_attempt_at=clock_timestamp()+make_interval(secs => LEAST(300, GREATEST(5, attempt_count * 5))),
         lease_expires_at=NULL,last_error=$2,updated_at=clock_timestamp()
       WHERE id=$1 AND status IN ('DELIVERED','SYNCING') AND sync_status='PENDING'`,
      [id, errorText(error)],
    );
  }

  async expireUndelivered(
    marketId: MarketId,
    tradingDate: string,
  ): Promise<number> {
    return this.transaction(async (db) => {
      await db.query(
        "SELECT market_id FROM discovery_mode WHERE market_id=$1 FOR UPDATE",
        [marketId],
      );
      const result = await db.query(
        `UPDATE discovery_intake_outbox SET status='EXPIRED',lease_expires_at=NULL,
           last_error=$3,updated_at=clock_timestamp()
         WHERE market_id=$1 AND trading_date=$2 AND status IN ('PENDING','PROCESSING')`,
        [marketId, tradingDate, "Undelivered discovery intake expired"],
      );
      return result.rowCount ?? 0;
    });
  }

  async applyManualCandidates(
    provider: string,
    operation: UpdateCandidateIntake["operation"],
    tradingDate: string,
    candidates: CandidateIntakeEntry[],
    marketId: MarketId,
  ): Promise<CandidateIntakeEntry[]> {
    marketIdSchema.parse(marketId);
    if (provider !== providerFor(marketId))
      throw new Error(`Watchlist provider does not belong to ${marketId}`);
    return this.transaction(async (db) => {
      const mode = (
        await db.query<ModeRow>(
          "SELECT mode,revision FROM discovery_mode WHERE market_id=$1 FOR UPDATE",
          [marketId],
        )
      ).rows[0];
      if (!mode)
        throw new Error(`Discovery mode is not seeded for ${marketId}`);
      await db.query(
        `SELECT normalized_symbol FROM discovery_intake_exclusion
         WHERE market_id=$1 AND trading_date=$2 FOR UPDATE`,
        [marketId, tradingDate],
      );
      const watchlist = await this.lockWatchlist(
        db,
        provider,
        marketId,
        tradingDate,
      );
      const oldCandidates =
        watchlist.trading_date === tradingDate
          ? parseCandidates(watchlist.candidates)
          : [];
      const activeOutbox = await db.query<{
        normalized_symbol: string;
        instrument_id: string | null;
      }>(
        `SELECT normalized_symbol,instrument_id
         FROM discovery_intake_outbox
         WHERE market_id=$1 AND trading_date=$2 AND (
           status IN ('PENDING','PROCESSING','SYNCING')
           OR (status='DELIVERED' AND sync_status='PENDING')
         )
         ORDER BY normalized_symbol
         FOR UPDATE`,
        [marketId, tradingDate],
      );
      const incoming = candidates.map((value) =>
        candidateIntakeEntrySchema.parse({ ...value, marketId, tradingDate }),
      );
      const result = new Map<string, CandidateIntakeEntry>();
      if (operation === "ADD")
        for (const value of oldCandidates)
          result.set(value.normalizedSymbol, value);
      for (const value of incoming)
        result.set(
          value.normalizedSymbol,
          mergeCandidate(result.get(value.normalizedSymbol), value),
        );

      const nextSymbols = new Set(result.keys());
      const knownCandidates = new Map(
        oldCandidates.map((value) => [value.normalizedSymbol, value]),
      );
      const removedSymbols =
        operation === "REPLACE"
          ? new Set([
              ...oldCandidates.map((value) => value.normalizedSymbol),
              ...activeOutbox.rows.map((value) => value.normalized_symbol),
            ])
          : new Set<string>();
      for (const normalizedSymbol of removedSymbols) {
        if (nextSymbols.has(normalizedSymbol)) continue;
        const current = knownCandidates.get(normalizedSymbol);
        const outbox = activeOutbox.rows.find(
          (value) => value.normalized_symbol === normalizedSymbol,
        );
        await db.query(
          `INSERT INTO discovery_intake_exclusion(
             market_id,trading_date,normalized_symbol,instrument_id,actor,reason
           ) VALUES($1,$2,$3,$4,'manual-dashboard',$5)
           ON CONFLICT(market_id,trading_date,normalized_symbol) DO UPDATE SET
             instrument_id=EXCLUDED.instrument_id,actor=EXCLUDED.actor,reason=EXCLUDED.reason,
             created_at=clock_timestamp(),cleared_at=NULL`,
          [
            marketId,
            tradingDate,
            normalizedSymbol,
            current?.resolvedInstrumentId ?? outbox?.instrument_id ?? null,
            "MANUAL_REPLACE",
          ],
        );
      }
      if (removedSymbols.size > 0)
        await db.query(
          `UPDATE discovery_intake_outbox SET status='EXPIRED',lease_expires_at=NULL,
             last_error='MANUAL_REPLACE',updated_at=clock_timestamp()
           WHERE market_id=$1 AND trading_date=$2
             AND normalized_symbol=ANY($3::text[])
             AND status IN ('PENDING','PROCESSING')`,
          [marketId, tradingDate, [...removedSymbols]],
        );
      for (const value of incoming) {
        await db.query(
          `UPDATE discovery_intake_exclusion SET cleared_at=clock_timestamp()
           WHERE market_id=$1 AND trading_date=$2 AND normalized_symbol=$3 AND cleared_at IS NULL`,
          [marketId, tradingDate, value.normalizedSymbol],
        );
      }
      const values = [...result.values()].sort((left, right) =>
        left.normalizedSymbol.localeCompare(right.normalizedSymbol),
      );
      await db.query(
        `UPDATE universe_watchlist SET symbols=$3::jsonb,candidates=$4::jsonb,
           trading_date=$5,updated_at=clock_timestamp()
         WHERE market_id=$1 AND provider=$2`,
        [
          marketId,
          provider,
          JSON.stringify(values.map((value) => value.normalizedSymbol)),
          JSON.stringify(values),
          tradingDate,
        ],
      );
      return values;
    });
  }

  async setExclusion(input: {
    marketId: MarketId;
    tradingDate: string;
    instrumentId: string;
    excluded: boolean;
    actor: string;
    reason: string;
  }): Promise<void> {
    marketIdSchema.parse(input.marketId);
    z.string().date().parse(input.tradingDate);
    z.string().uuid().parse(input.instrumentId);
    const actor = input.actor.trim();
    const reason = input.reason.trim();
    if (!actor || actor.length > 200 || !reason || reason.length > 500)
      throw new Error("Discovery exclusion actor/reason is invalid");
    await this.transaction(async (db) => {
      await db.query(
        "SELECT market_id FROM discovery_mode WHERE market_id=$1 FOR UPDATE",
        [input.marketId],
      );
      await db.query(
        `SELECT normalized_symbol FROM discovery_intake_exclusion
         WHERE market_id=$1 AND trading_date=$2 FOR UPDATE`,
        [input.marketId, input.tradingDate],
      );
      const provider = providerFor(input.marketId);
      const watchlist = await this.lockWatchlist(
        db,
        provider,
        input.marketId,
        input.tradingDate,
      );
      const instrument = (
        await db.query<{ symbol: string }>(
          `SELECT symbol FROM instrument WHERE id=$1 AND market_id=$2 FOR UPDATE`,
          [input.instrumentId, input.marketId],
        )
      ).rows[0];
      if (!instrument)
        throw new Error(
          "Discovery exclusion instrument is not in the selected market",
        );
      if (input.excluded) {
        await db.query(
          `INSERT INTO discovery_intake_exclusion(
             market_id,trading_date,normalized_symbol,instrument_id,actor,reason
           ) VALUES($1,$2,$3,$4,$5,$6)
           ON CONFLICT(market_id,trading_date,normalized_symbol) DO UPDATE SET
             instrument_id=EXCLUDED.instrument_id,actor=EXCLUDED.actor,reason=EXCLUDED.reason,
             created_at=clock_timestamp(),cleared_at=NULL`,
          [
            input.marketId,
            input.tradingDate,
            instrument.symbol,
            input.instrumentId,
            actor,
            reason,
          ],
        );
      } else {
        await db.query(
          `UPDATE discovery_intake_exclusion SET cleared_at=clock_timestamp()
           WHERE market_id=$1 AND trading_date=$2 AND normalized_symbol=$3`,
          [input.marketId, input.tradingDate, instrument.symbol],
        );
      }
      if (input.excluded && watchlist.trading_date === input.tradingDate) {
        const candidates = parseCandidates(watchlist.candidates).filter(
          (candidate) => candidate.normalizedSymbol !== instrument.symbol,
        );
        await db.query(
          `UPDATE universe_watchlist SET symbols=$3::jsonb,candidates=$4::jsonb,
             updated_at=clock_timestamp() WHERE market_id=$1 AND provider=$2`,
          [
            input.marketId,
            provider,
            JSON.stringify(
              candidates.map((candidate) => candidate.normalizedSymbol),
            ),
            JSON.stringify(candidates),
          ],
        );
      }
      if (input.excluded)
        await db.query(
          `UPDATE discovery_intake_outbox SET status='EXPIRED',lease_expires_at=NULL,
             last_error=$4,updated_at=clock_timestamp()
           WHERE market_id=$1 AND trading_date=$2 AND normalized_symbol=$3
             AND status IN ('PENDING','PROCESSING')`,
          [
            input.marketId,
            input.tradingDate,
            instrument.symbol,
            "MANUAL_EXCLUSION",
          ],
        );
    });
  }

  private async lockWatchlist(
    db: DiscoveryDb,
    provider: string,
    marketId: MarketId,
    tradingDate: string,
  ): Promise<WatchlistRow> {
    await db.query(
      `INSERT INTO universe_watchlist(market_id,provider,symbols,candidates,trading_date)
       VALUES($1,$2,'[]'::jsonb,'[]'::jsonb,$3)
       ON CONFLICT(market_id,provider) DO NOTHING`,
      [marketId, provider, tradingDate],
    );
    const result = await db.query<WatchlistRow>(
      `SELECT symbols,candidates,trading_date::text AS trading_date
       FROM universe_watchlist WHERE market_id=$1 AND provider=$2 FOR UPDATE`,
      [marketId, provider],
    );
    const row = result.rows[0];
    if (!row)
      throw new Error(`Discovery watchlist is not available for ${marketId}`);
    return row;
  }

  private async loadInstrument(
    db: DiscoveryDb,
    outboxId: string,
  ): Promise<PersistedInstrument> {
    const result = await db.query<IntakeInstrumentRow>(
      `SELECT i.id,i.questrade_symbol_id,i.symbol,i.description,i.security_type,
         i.exchange,i.currency,i.is_quotable,i.is_tradable,i.active,i.industry_sector
       FROM instrument i
       JOIN discovery_intake_outbox o ON o.instrument_id=i.id
       WHERE o.id=$1`,
      [outboxId],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Delivered discovery instrument is missing");
    return mapIntakeInstrument(row);
  }

  private async expireRow(
    db: DiscoveryDb,
    id: string,
    reason: string,
  ): Promise<void> {
    await db.query(
      `UPDATE discovery_intake_outbox SET status='EXPIRED',lease_expires_at=NULL,
         last_error=$2,updated_at=clock_timestamp() WHERE id=$1`,
      [id, reason.slice(0, 500)],
    );
  }
}

function mapIntakeInstrument(row: IntakeInstrumentRow): PersistedInstrument {
  return {
    id: row.id,
    marketId: row.currency === "USD" ? "US_EQUITIES" : "CA_TSX",
    symbolId: Number(row.questrade_symbol_id),
    symbol: row.symbol,
    description: row.description,
    securityType: row.security_type,
    exchange: row.exchange,
    currency: row.currency,
    isQuotable: row.is_quotable,
    isTradable: row.is_tradable,
    active: row.active,
    sector: row.industry_sector,
  };
}

function marketTradingDate(marketId: MarketId, value: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: marketId === "CA_TSX" ? "America/Toronto" : "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

export interface DiscoveryIntakeWorkerOptions {
  repository: DiscoveryIntakeRepository;
  marketId: MarketId;
  tradingDate: () => string;
  synchronize: (action: DiscoveryIntakeAction) => Promise<void>;
  enabled?: boolean;
  pollIntervalMs?: number;
  logger?: { error(fields: Record<string, unknown>): void };
}

/** One serialized worker per market. Durable claims make a second API process safe. */
export class DiscoveryIntakeWorker {
  private readonly enabled: boolean;
  private readonly pollIntervalMs: number;
  private readonly logger: { error(fields: Record<string, unknown>): void };
  private timer: NodeJS.Timeout | undefined;
  private active?: Promise<void>;

  constructor(private readonly options: DiscoveryIntakeWorkerOptions) {
    this.enabled = options.enabled ?? false;
    this.pollIntervalMs = options.pollIntervalMs ?? 10_000;
    this.logger = options.logger ?? { error: () => {} };
    if (!Number.isInteger(this.pollIntervalMs) || this.pollIntervalMs < 250)
      throw new Error("Discovery intake poll interval must be at least 250ms");
  }

  start(): void {
    if (!this.enabled || this.timer) return;
    this.timer = setInterval(
      () => void this.runScheduled(),
      this.pollIntervalMs,
    );
    this.timer.unref?.();
    void this.runScheduled();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.active) await this.active;
  }

  async drainOnce(): Promise<void> {
    if (!this.enabled) return;
    const action = await this.options.repository.claimNext(
      this.options.marketId,
      this.options.tradingDate(),
    );
    if (!action) return;
    try {
      await this.options.synchronize(action);
      await this.options.repository.markSynchronized(action.id);
    } catch (error) {
      await this.options.repository.markSynchronizationFailed(
        action.id,
        error instanceof Error ? error.message : String(error),
      );
      this.logger.error({
        event: "DISCOVERY_INTAKE_SYNCHRONIZATION_FAILED",
        marketId: this.options.marketId,
        symbol: action.symbol,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async runScheduled(): Promise<void> {
    if (this.active) return;
    this.active = this.drainOnce()
      .catch((error) => {
        this.logger.error({
          event: "DISCOVERY_INTAKE_WORKER_FAILED",
          marketId: this.options.marketId,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.active = undefined;
      });
    await this.active;
  }
}
