import { normalizeExchange } from "../questrade/exchange.js";
import {
  candidateIntakeEntrySchema,
  type CandidateIntakeStatus,
  type CandidateIntakeEntry,
  type UniverseExclusionReason,
  type UniverseMember,
  type UniversePolicy,
  type UniverseRefreshRun,
} from "@tsx-scanner/contracts";
import type { Pool, PoolClient } from "pg";
import type { PersistedInstrument } from "../market-data/repository.js";
import type {
  UniverseEvaluation,
  UniverseStore,
  UniverseWatchlistStore,
} from "./universe-service.js";

interface RunRow {
  id: string;
  market_id: UniverseRefreshRun["marketId"];
  provider: string;
  policy_version: string;
  status: UniverseRefreshRun["status"];
  discovered_count: number;
  evaluated_count: number;
  eligible_count: number;
  activated_count: number;
  warnings: unknown;
  error: string | null;
  started_at: Date;
  completed_at: Date | null;
}

interface InstrumentRow {
  id: string;
  questrade_symbol_id: string;
  symbol: string;
  description: string;
  security_type: string;
  exchange: string;
  currency: string;
  is_quotable: boolean;
  is_tradable: boolean;
  active: boolean;
  market_cap: string | null;
  average_volume_20d: string | null;
  average_volume_3m: string | null;
  average_dollar_volume: string | null;
  atr_14: string | null;
  atr_pct: string | null;
  industry_sector: string | null;
  market_id: "CA_TSX" | "US_EQUITIES";
}

interface MembershipRow {
  instrument_id: string | null;
  market_id: UniverseMember["marketId"];
  symbol: string;
  description: string;
  exchange: string;
  sector: string | null;
  eligible: boolean;
  reasons: unknown;
  price: string | null;
  market_cap: string | null;
  average_volume_20d: string | null;
  average_volume_90d: string | null;
  dollar_volume: string | null;
  atr_14: string | null;
  atr_pct: string | null;
  metrics_as_of: Date;
}

export class PostgresUniverseStore
  implements UniverseStore, UniverseWatchlistStore
{
  constructor(
    private readonly pool: Pool,
    private readonly candidateStatusStore?: {
      listCandidateIntakeStatuses(
        provider: string,
        tradingDate: string,
        marketId?: "CA_TSX" | "US_EQUITIES",
      ): Promise<CandidateIntakeStatus[]>;
    },
  ) {}

  async begin(
    provider: string,
    policy: UniversePolicy,
    startedAt: Date,
  ): Promise<UniverseRefreshRun> {
    const result = await this.pool.query<RunRow>(
      `INSERT INTO universe_refresh_run(market_id,provider,policy_version,policy,status,started_at)
       VALUES($1,$2,$3,$4,'RUNNING',$5) RETURNING *`,
      [
        policy.marketId,
        provider,
        policy.version,
        JSON.stringify(policy),
        startedAt,
      ],
    );
    return mapRun(result.rows[0]!);
  }

  async complete(
    runId: string,
    evaluations: UniverseEvaluation[],
    warnings: string[],
    completedAt: Date,
    minimumSize: number,
  ): Promise<{
    run: UniverseRefreshRun;
    instruments: PersistedInstrument[];
    members: UniverseMember[];
  }> {
    const eligibleCount = evaluations.filter(
      (value) => value.member.eligible && value.instrument,
    ).length;
    if (eligibleCount < minimumSize) {
      throw new Error(
        `Universe refresh produced ${eligibleCount} eligible symbols; minimum safe size is ${minimumSize}`,
      );
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const runMarket = await client.query<{
        market_id: UniverseRefreshRun["marketId"];
      }>("SELECT market_id FROM universe_refresh_run WHERE id=$1 FOR UPDATE", [
        runId,
      ]);
      const marketId = runMarket.rows[0]?.market_id;
      if (!marketId)
        throw new Error(`Universe refresh ${runId} does not exist`);
      if (evaluations.some((value) => value.member.marketId !== marketId))
        throw new Error(
          "Universe refresh contains a member from another market",
        );
      const rowsBySymbol = new Map<string, InstrumentRow>();
      for (const evaluation of evaluations) {
        if (!evaluation.instrument) continue;
        const value = evaluation.member;
        const instrument = evaluation.instrument;
        const result = await client.query<InstrumentRow>(
          `INSERT INTO instrument(
             market_id,questrade_symbol_id,symbol,description,exchange,currency,security_type,market_cap,
             average_volume_20d,average_volume_3m,industry_sector,is_quotable,is_tradable,active,
             last_price,average_dollar_volume,atr_14,atr_pct,universe_eligible,universe_evaluated_at,universe_source
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,FALSE,$14,$15,$16,$17,FALSE,$18,$19)
           ON CONFLICT(market_id,symbol) DO UPDATE SET
             questrade_symbol_id=EXCLUDED.questrade_symbol_id,description=EXCLUDED.description,exchange=EXCLUDED.exchange,
             currency=EXCLUDED.currency,security_type=EXCLUDED.security_type,market_cap=EXCLUDED.market_cap,
             average_volume_20d=EXCLUDED.average_volume_20d,average_volume_3m=EXCLUDED.average_volume_3m,
             industry_sector=EXCLUDED.industry_sector,is_quotable=EXCLUDED.is_quotable,is_tradable=EXCLUDED.is_tradable,
             last_price=EXCLUDED.last_price,average_dollar_volume=EXCLUDED.average_dollar_volume,
             atr_14=EXCLUDED.atr_14,atr_pct=EXCLUDED.atr_pct,universe_evaluated_at=EXCLUDED.universe_evaluated_at,
             universe_source=EXCLUDED.universe_source,updated_at=NOW()
           RETURNING id,questrade_symbol_id,symbol,description,security_type,exchange,currency,is_quotable,is_tradable,
           active,market_cap,average_volume_20d,average_volume_3m,average_dollar_volume,atr_14,atr_pct,industry_sector,market_id`,
          [
            marketId,
            instrument.symbolId,
            instrument.symbol,
            instrument.description,
            instrument.exchange,
            instrument.currency,
            instrument.securityType,
            value.marketCap,
            value.averageVolume20d,
            value.averageVolume90d,
            value.sector,
            instrument.isQuotable,
            instrument.isTradable,
            value.price,
            value.dollarVolume,
            value.atr14,
            value.atrPct,
            value.metricsAsOf,
            marketId === "US_EQUITIES"
              ? "AUTOMATED_US_UNIVERSE"
              : "AUTOMATED_TSX_UNIVERSE",
          ],
        );
        rowsBySymbol.set(value.symbol, result.rows[0]!);
      }

      await client.query(
        "UPDATE instrument SET active=FALSE,universe_eligible=FALSE WHERE market_id=$1 AND (active=TRUE OR universe_eligible=TRUE)",
        [marketId],
      );
      const eligibleIds = evaluations
        .filter((value) => value.member.eligible)
        .map((value) => rowsBySymbol.get(value.member.symbol)?.id)
        .filter((value): value is string => value !== undefined);
      if (eligibleIds.length > 0) {
        await client.query(
          "UPDATE instrument SET active=TRUE,universe_eligible=TRUE,updated_at=NOW() WHERE market_id=$1 AND id=ANY($2::uuid[])",
          [marketId, eligibleIds],
        );
      }

      const members: UniverseMember[] = [];
      for (const evaluation of evaluations) {
        const instrumentId =
          rowsBySymbol.get(evaluation.member.symbol)?.id ?? null;
        const member = { ...evaluation.member, instrumentId };
        members.push(member);
        await insertMembership(client, runId, member);
      }

      const runResult = await client.query<RunRow>(
        `UPDATE universe_refresh_run SET status='COMPLETED',discovered_count=$2,evaluated_count=$3,
           eligible_count=$4,activated_count=$5,warnings=$6,error=NULL,completed_at=$7
         WHERE id=$1 RETURNING *`,
        [
          runId,
          evaluations.length,
          evaluations.length,
          eligibleCount,
          eligibleIds.length,
          JSON.stringify(warnings),
          completedAt,
        ],
      );
      const instrumentsResult = await client.query<InstrumentRow>(
        `SELECT id,questrade_symbol_id,symbol,description,security_type,exchange,currency,is_quotable,is_tradable,
           active,market_cap,average_volume_20d,average_volume_3m,average_dollar_volume,atr_14,atr_pct,industry_sector,market_id
         FROM instrument WHERE market_id=$1 AND active=TRUE ORDER BY symbol`,
        [marketId],
      );
      await client.query("COMMIT");
      return {
        run: mapRun(runResult.rows[0]!),
        instruments: instrumentsResult.rows.map(mapInstrument),
        members,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async fail(
    runId: string,
    error: string,
    completedAt: Date,
  ): Promise<UniverseRefreshRun> {
    const result = await this.pool.query<RunRow>(
      `UPDATE universe_refresh_run SET status='FAILED',error=$2,completed_at=$3 WHERE id=$1 RETURNING *`,
      [runId, error, completedAt],
    );
    return mapRun(result.rows[0]!);
  }

  async listRuns(
    limit = 20,
    marketId: UniverseRefreshRun["marketId"] = "CA_TSX",
  ): Promise<UniverseRefreshRun[]> {
    const result = await this.pool.query<RunRow>(
      "SELECT * FROM universe_refresh_run WHERE market_id=$1 ORDER BY started_at DESC LIMIT $2",
      [marketId, limit],
    );
    return result.rows.map(mapRun);
  }

  async loadLastCompleted(
    provider: string,
    marketId: UniverseRefreshRun["marketId"] = "CA_TSX",
  ): Promise<{
    instruments: PersistedInstrument[];
    members: UniverseMember[];
  } | null> {
    const run = await this.pool.query<{ id: string }>(
      "SELECT id FROM universe_refresh_run WHERE market_id=$1 AND status='COMPLETED' AND provider=$2 ORDER BY completed_at DESC LIMIT 1",
      [marketId, provider],
    );
    const runId = run.rows[0]?.id;
    if (!runId) return null;
    const [instruments, members] = await Promise.all([
      this.pool.query<InstrumentRow>(
        `SELECT i.id,i.questrade_symbol_id,i.symbol,i.description,i.security_type,i.exchange,i.currency,
           i.is_quotable,i.is_tradable,TRUE AS active,i.market_cap,i.average_volume_20d,i.average_volume_3m,
           i.average_dollar_volume,i.atr_14,i.atr_pct,i.industry_sector,i.market_id
         FROM instrument i
         JOIN universe_membership m ON m.instrument_id=i.id
         WHERE m.run_id=$1 AND m.eligible=TRUE
         ORDER BY i.symbol`,
        [runId],
      ),
      this.pool.query<MembershipRow>(
        "SELECT * FROM universe_membership WHERE market_id=$1 AND run_id=$2 ORDER BY symbol",
        [marketId, runId],
      ),
    ]);
    return {
      instruments: instruments.rows.map(mapInstrument),
      members: members.rows.map(mapMember),
    };
  }

  async loadConfiguredSymbols(
    provider: string,
    marketId: "CA_TSX" | "US_EQUITIES" = "CA_TSX",
  ): Promise<{
    symbols: string[];
    tradingDate: string;
    candidates?: CandidateIntakeEntry[];
  } | null> {
    const result = await this.pool.query<{
      symbols: unknown;
      trading_date: string;
      candidates: unknown;
    }>(
      "SELECT symbols,trading_date::text,candidates FROM universe_watchlist WHERE market_id=$1 AND provider=$2",
      [marketId, provider],
    );
    return result.rows[0]
      ? {
          symbols: arrayOfStrings(result.rows[0].symbols),
          tradingDate: result.rows[0].trading_date,
          candidates: arrayOfCandidates(result.rows[0].candidates),
        }
      : null;
  }

  async saveConfiguredSymbols(
    provider: string,
    symbols: string[],
    tradingDate: string,
    candidates: CandidateIntakeEntry[] = [],
    marketId: "CA_TSX" | "US_EQUITIES" = "CA_TSX",
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO universe_watchlist(market_id,provider,symbols,trading_date,candidates,updated_at) VALUES($1,$2,$3,$4,$5,NOW())
       ON CONFLICT(market_id,provider) DO UPDATE SET symbols=EXCLUDED.symbols,trading_date=EXCLUDED.trading_date,candidates=EXCLUDED.candidates,updated_at=NOW()`,
      [
        marketId,
        provider,
        JSON.stringify(symbols),
        tradingDate,
        JSON.stringify(candidates),
      ],
    );
  }

  listCandidateIntakeStatuses(
    provider: string,
    tradingDate: string,
    marketId?: "CA_TSX" | "US_EQUITIES",
  ): Promise<CandidateIntakeStatus[]> {
    return (
      this.candidateStatusStore?.listCandidateIntakeStatuses(
        provider,
        tradingDate,
        marketId,
      ) ?? Promise.resolve([])
    );
  }
}

async function insertMembership(
  client: PoolClient,
  runId: string,
  member: UniverseMember,
): Promise<void> {
  await client.query(
    `INSERT INTO universe_membership(
       run_id,market_id,instrument_id,symbol,description,exchange,sector,eligible,reasons,price,market_cap,
       average_volume_20d,average_volume_90d,dollar_volume,atr_14,atr_pct,metrics_as_of
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     ON CONFLICT (run_id,symbol) DO NOTHING`,
    [
      runId,
      member.marketId,
      member.instrumentId,
      member.symbol,
      member.description,
      member.exchange,
      member.sector,
      member.eligible,
      JSON.stringify(member.reasons),
      member.price,
      member.marketCap,
      member.averageVolume20d,
      member.averageVolume90d,
      member.dollarVolume,
      member.atr14,
      member.atrPct,
      member.metricsAsOf,
    ],
  );
}

function mapRun(row: RunRow): UniverseRefreshRun {
  return {
    id: row.id,
    marketId: row.market_id,
    provider: row.provider,
    policyVersion: row.policy_version,
    status: row.status,
    discoveredCount: row.discovered_count,
    evaluatedCount: row.evaluated_count,
    eligibleCount: row.eligible_count,
    activatedCount: row.activated_count,
    warnings: arrayOfStrings(row.warnings),
    error: row.error,
    startedAt: row.started_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
  };
}

function arrayOfStrings(value: unknown): string[] {
  const parsed =
    typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === "string")
    : [];
}

function arrayOfCandidates(value: unknown): CandidateIntakeEntry[] {
  const parsedValue =
    typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  if (!Array.isArray(parsedValue)) return [];
  return parsedValue.flatMap((item) => {
    const parsed = candidateIntakeEntrySchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

function numberOrNull(value: string | null): number | null {
  return value === null ? null : Number(value);
}

function mapInstrument(row: InstrumentRow): PersistedInstrument {
  return {
    id: row.id,
    marketId: row.market_id,
    symbolId: Number(row.questrade_symbol_id),
    symbol: row.symbol,
    description: row.description,
    securityType: row.security_type,
    exchange: row.exchange,
    currency: row.currency,
    isQuotable: row.is_quotable,
    isTradable: row.is_tradable,
    active: row.active,
    marketCap: numberOrNull(row.market_cap),
    averageVolume20d: numberOrNull(row.average_volume_20d),
    averageVolume90d: numberOrNull(row.average_volume_3m),
    dollarVolume: numberOrNull(row.average_dollar_volume),
    atr14: numberOrNull(row.atr_14),
    atrPct: numberOrNull(row.atr_pct),
    sector: row.industry_sector,
  };
}

function mapMember(row: MembershipRow): UniverseMember {
  const normalizedExchange = normalizeExchange(row.exchange);
  return {
    instrumentId: row.instrument_id,
    marketId: row.market_id,
    symbol: row.symbol,
    description: row.description,
    exchange: row.exchange,
    normalizedExchange,
    rawExchange: row.exchange || null,
    currency: row.market_id === "US_EQUITIES" ? "USD" : "CAD",
    sector: row.sector,
    eligible: row.eligible,
    reasons: arrayOfStrings(row.reasons) as UniverseExclusionReason[],
    price: numberOrNull(row.price),
    marketCap: numberOrNull(row.market_cap),
    averageVolume20d: numberOrNull(row.average_volume_20d),
    averageVolume90d: numberOrNull(row.average_volume_90d),
    dollarVolume: numberOrNull(row.dollar_volume),
    atr14: numberOrNull(row.atr_14),
    atrPct: numberOrNull(row.atr_pct),
    metricsAsOf: row.metrics_as_of.toISOString(),
  };
}
