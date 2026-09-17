import { normalizeExchange } from "../questrade/exchange.js";
import type {
  CandidateIntakeEntry,
  CandidatePasteReport,
  CandidateIntakeStatus,
  CandidateSource,
  UpdateCandidateIntake,
  UniverseAutomation,
  UniverseExclusionReason,
  UniverseMember,
  UniversePolicy,
  UniverseRefreshRun,
} from "@tsx-scanner/contracts";
import type {
  Candle,
  Instrument,
  MarketDataAdapter,
  Quote,
} from "../questrade/types.js";
import type { PersistedInstrument } from "../market-data/repository.js";

export interface UniverseCatalogSymbol {
  symbol: string;
  marketCap: number | null;
  sector: string | null;
}

export interface AutomatedUniverseProvider {
  readonly name: string;
  listSymbols(): Promise<UniverseCatalogSymbol[]>;
}

export interface UniverseWatchlistStore {
  loadConfiguredSymbols(
    provider: string,
    marketId?: "CA_TSX" | "US_EQUITIES",
  ): Promise<{
    symbols: string[];
    tradingDate: string;
    candidates?: CandidateIntakeEntry[];
  } | null>;
  saveConfiguredSymbols(
    provider: string,
    symbols: string[],
    tradingDate: string,
    candidates?: CandidateIntakeEntry[],
    marketId?: "CA_TSX" | "US_EQUITIES",
  ): Promise<void>;
  listCandidateIntakeStatuses?(
    provider: string,
    tradingDate: string,
    marketId?: "CA_TSX" | "US_EQUITIES",
  ): Promise<CandidateIntakeStatus[]>;
  /**
   * Optional transactional manual mutation. Implementations use the same
   * market/mode/exclusion/watchlist lock boundary as automatic discovery
   * intake, preventing stale read-modify-write races.
   */
  applyManualCandidates?(
    provider: string,
    operation: "ADD" | "REPLACE",
    tradingDate: string,
    candidates: CandidateIntakeEntry[],
    marketId?: "CA_TSX" | "US_EQUITIES",
  ): Promise<CandidateIntakeEntry[]>;
}

interface EditableUniverseProvider extends AutomatedUniverseProvider {
  getConfiguredSymbols(): string[];
  getConfiguredCandidates(): CandidateIntakeEntry[];
  getWatchlistDate(): string;
  getCandidateIntakeStatuses?(): Promise<CandidateIntakeStatus[]>;
  replaceSymbols(symbols: string[]): Promise<void>;
  updateCandidates(input: UpdateCandidateIntake): Promise<CandidatePasteReport>;
  reloadConfigured?(): Promise<void>;
}

interface ManualUniverseProvider extends EditableUniverseProvider {
  readonly activationMode: "MANUAL";
}

export interface UniverseEvaluation {
  instrument?: Instrument;
  member: UniverseMember;
}

export interface UniverseStore {
  begin(
    provider: string,
    policy: UniversePolicy,
    startedAt: Date,
  ): Promise<UniverseRefreshRun>;
  complete(
    runId: string,
    evaluations: UniverseEvaluation[],
    warnings: string[],
    completedAt: Date,
    minimumSize: number,
  ): Promise<{
    run: UniverseRefreshRun;
    instruments: PersistedInstrument[];
    members: UniverseMember[];
  }>;
  fail(
    runId: string,
    error: string,
    completedAt: Date,
  ): Promise<UniverseRefreshRun>;
  listRuns(
    limit: number,
    marketId: UniversePolicy["marketId"],
  ): Promise<UniverseRefreshRun[]>;
  loadLastCompleted(
    provider: string,
    marketId?: UniversePolicy["marketId"],
  ): Promise<{
    instruments: PersistedInstrument[];
    members: UniverseMember[];
  } | null>;
}

export interface UniverseManager {
  enrich(allowLastKnownGood?: boolean): Promise<PersistedInstrument[]>;
  getAutomation?(): UniverseAutomation;
  listRuns?(limit?: number): Promise<UniverseRefreshRun[]>;
  replaceSymbols?(symbols: string[]): Promise<void>;
  updateCandidates?(
    input: UpdateCandidateIntake,
  ): Promise<CandidatePasteReport>;
  reloadConfiguredCandidates?(): Promise<void>;
  getCandidateIntakeStatuses?(): Promise<CandidateIntakeStatus[]>;
}

export const DEFAULT_UNIVERSE_POLICY: UniversePolicy = {
  version: "tsx-liquid-momentum-v1",
  marketId: "CA_TSX",
  exchange: "TSX",
  currency: "CAD",
  allowedExchanges: ["TSX"],
  allowedCurrencies: ["CAD"],
  securityTypes: ["Stock", "Common Stock"],
  minimumPrice: 5,
  maximumPrice: 150,
  minimumMarketCap: 500_000_000,
  minimumAverageVolume90d: 500_000,
  minimumDollarVolume: 20_000_000,
  minimumAtrPct: 1.5,
  minimumHistoryDays: 20,
};

export const DEFAULT_US_UNIVERSE_POLICY: UniversePolicy = {
  version: "us-liquid-momentum-v1",
  marketId: "US_EQUITIES",
  allowedExchanges: ["NASDAQ", "NYSE", "NYSE_ARCA"],
  allowedCurrencies: ["USD"],
  securityTypes: ["Stock", "Common Stock"],
  minimumPrice: 5,
  maximumPrice: 500,
  minimumMarketCap: 500_000_000,
  minimumAverageVolume90d: 1_000_000,
  minimumDollarVolume: 50_000_000,
  minimumAtrPct: 1.5,
  minimumHistoryDays: 20,
};

export class MockTsxUniverseProvider implements AutomatedUniverseProvider {
  readonly name = "MOCK_TSX_CATALOG";

  async listSymbols(): Promise<UniverseCatalogSymbol[]> {
    return [
      {
        symbol: "BAM.TO",
        marketCap: 103_000_000_000,
        sector: "Financial Services",
      },
      {
        symbol: "BTO.TO",
        marketCap: 14_000_000_000,
        sector: "Basic Materials",
      },
      {
        symbol: "QBR.B.TO",
        marketCap: 8_200_000_000,
        sector: "Communication Services",
      },
    ];
  }
}

export class MockUsUniverseProvider implements AutomatedUniverseProvider {
  readonly name = "MOCK_US_CATALOG";

  async listSymbols(): Promise<UniverseCatalogSymbol[]> {
    return [
      { symbol: "AAPL", marketCap: 3_000_000_000_000, sector: "Technology" },
      { symbol: "NVDA", marketCap: 3_000_000_000_000, sector: "Technology" },
    ];
  }
}

export class ConfiguredTsxUniverseProvider implements AutomatedUniverseProvider {
  readonly name: string = "CONFIGURED_TSX_LIVE_WATCHLIST";
  readonly activationMode = "MANUAL" as const;
  private symbols: string[];
  private candidates: CandidateIntakeEntry[];
  private hydrated = false;
  private watchlistDate: string;

  constructor(
    symbols: string[],
    private readonly store?: UniverseWatchlistStore,
    private readonly clock: () => Date = () => new Date(),
    private readonly marketId: "CA_TSX" | "US_EQUITIES" = "CA_TSX",
  ) {
    this.symbols = normalizeConfiguredSymbols(symbols, this.marketId);
    this.watchlistDate = marketDate(this.clock(), this.marketId);
    this.candidates = this.symbols.map((symbol) =>
      candidateEntry(
        symbol,
        symbol,
        "MANUAL",
        this.watchlistDate,
        this.clock(),
        null,
        [],
        this.marketId,
      ),
    );
  }

  async listSymbols(): Promise<UniverseCatalogSymbol[]> {
    await this.hydrate();
    return this.symbols.map((symbol) => ({
      symbol,
      marketCap: null,
      sector: null,
    }));
  }

  getConfiguredSymbols(): string[] {
    return [...this.symbols];
  }

  getConfiguredCandidates(): CandidateIntakeEntry[] {
    return this.candidates.map((value) => ({
      ...value,
      tags: [...value.tags],
    }));
  }

  getWatchlistDate(): string {
    return this.watchlistDate;
  }

  async getCandidateIntakeStatuses(): Promise<CandidateIntakeStatus[]> {
    await this.hydrate();
    const persisted = await this.store?.listCandidateIntakeStatuses?.(
      this.name,
      this.watchlistDate,
      this.marketId,
    );
    return persisted && (persisted.length > 0 || this.candidates.length === 0)
      ? persisted
      : this.candidates.map(candidatePipelineStatus);
  }

  async reloadConfigured(): Promise<void> {
    this.hydrated = false;
    await this.hydrate();
  }

  async replaceSymbols(symbols: string[]): Promise<void> {
    await this.hydrate();
    const normalized = normalizeConfiguredSymbols(symbols, this.marketId);
    const tradingDate = marketDate(this.clock(), this.marketId);
    const existing = new Map(
      this.candidates.map((value) => [value.normalizedSymbol, value]),
    );
    const candidates = normalized.map(
      (symbol) =>
        existing.get(symbol) ??
        candidateEntry(
          symbol,
          symbol,
          "MANUAL",
          tradingDate,
          this.clock(),
          null,
          [],
          this.marketId,
        ),
    );
    const applied = this.store?.applyManualCandidates
      ? await this.store.applyManualCandidates(
          this.name,
          "REPLACE",
          tradingDate,
          candidates,
          this.marketId,
        )
      : candidates;
    if (!this.store?.applyManualCandidates)
      await this.store?.saveConfiguredSymbols(
        this.name,
        normalized,
        tradingDate,
        candidates,
        this.marketId,
      );
    this.symbols = applied.map((value) => value.normalizedSymbol);
    this.candidates = applied;
    this.watchlistDate = tradingDate;
  }

  async updateCandidates(
    input: UpdateCandidateIntake,
  ): Promise<CandidatePasteReport> {
    await this.hydrate();
    const tradingDate = marketDate(this.clock(), this.marketId);
    const report = emptyPasteReport();
    const retained = input.operation === "ADD" ? this.candidates : [];
    const candidates = new Map(
      retained.map((value) => [value.normalizedSymbol, value]),
    );
    const seen = new Set(candidates.keys());
    const tags = normalizeTags(input.tags);
    for (const originalInput of input.inputs) {
      const parsed = parseCandidateForMarket(originalInput, this.marketId);
      if (parsed.status === "FAILED") {
        report.failed.push({
          originalInput,
          normalizedSymbol: null,
          reason: parsed.reason,
        });
        continue;
      }
      if (parsed.status === "UNSUPPORTED") {
        report.unsupported.push({
          originalInput,
          normalizedSymbol: parsed.normalizedSymbol,
          reason: parsed.reason,
        });
        continue;
      }
      if (seen.has(parsed.normalizedSymbol)) {
        report.duplicate.push({
          originalInput,
          normalizedSymbol: parsed.normalizedSymbol,
          reason: "Already present in this Toronto trading-date list",
        });
        continue;
      }
      seen.add(parsed.normalizedSymbol);
      candidates.set(
        parsed.normalizedSymbol,
        candidateEntry(
          originalInput,
          parsed.normalizedSymbol,
          input.source,
          tradingDate,
          this.clock(),
          input.note?.trim() || null,
          tags,
          this.marketId,
          parsed.requestedExchange,
        ),
      );
      const item = {
        originalInput,
        normalizedSymbol: parsed.normalizedSymbol,
        reason: null,
      };
      if (parsed.normalized) report.normalized.push(item);
      else report.accepted.push(item);
    }
    const values = [...candidates.values()].sort((left, right) =>
      left.normalizedSymbol.localeCompare(right.normalizedSymbol),
    );
    if (
      input.operation === "REPLACE" &&
      values.length === 0 &&
      (report.failed.length > 0 || report.unsupported.length > 0)
    ) {
      return report;
    }
    const symbols = values.map((value) => value.normalizedSymbol);
    const applied = this.store?.applyManualCandidates
      ? await this.store.applyManualCandidates(
          this.name,
          input.operation,
          tradingDate,
          values,
          this.marketId,
        )
      : values;
    if (!this.store?.applyManualCandidates)
      await this.store?.saveConfiguredSymbols(
        this.name,
        symbols,
        tradingDate,
        values,
        this.marketId,
      );
    this.symbols = applied.map((value) => value.normalizedSymbol);
    this.candidates = applied;
    this.watchlistDate = tradingDate;
    return report;
  }

  private async hydrate(): Promise<void> {
    const today = marketDate(this.clock(), this.marketId);
    if (this.hydrated && this.watchlistDate === today) return;
    const persisted = await this.store?.loadConfiguredSymbols(
      this.name,
      this.marketId,
    );
    if (persisted?.tradingDate === today) {
      this.symbols = normalizeConfiguredSymbols(
        persisted.symbols,
        this.marketId,
      );
      const bySymbol = new Map(
        (persisted.candidates ?? []).map((value) => [
          value.normalizedSymbol,
          value,
        ]),
      );
      this.candidates = this.symbols.map(
        (symbol) =>
          bySymbol.get(symbol) ??
          candidateEntry(
            symbol,
            symbol,
            "MANUAL",
            today,
            this.clock(),
            null,
            [],
            this.marketId,
          ),
      );
    } else if (persisted) {
      this.symbols = [];
      this.candidates = [];
      await this.store?.saveConfiguredSymbols(
        this.name,
        this.symbols,
        today,
        this.candidates,
        this.marketId,
      );
    } else {
      await this.store?.saveConfiguredSymbols(
        this.name,
        this.symbols,
        today,
        this.candidates,
        this.marketId,
      );
    }
    this.watchlistDate = today;
    this.hydrated = true;
  }
}

/** Live US manual watchlist. It shares persistence semantics with the TSX
 * provider but accepts only deterministic US exchange/symbol inputs. */
export class ConfiguredUsUniverseProvider extends ConfiguredTsxUniverseProvider {
  readonly name = "CONFIGURED_US_LIVE_WATCHLIST";
  constructor(
    symbols: string[],
    store?: UniverseWatchlistStore,
    clock?: () => Date,
  ) {
    super(symbols, store, clock, "US_EQUITIES");
  }
}

export class AutomatedUniverseService implements UniverseManager {
  private latestRun: UniverseRefreshRun | null = null;
  private members: UniverseMember[] = [];
  private refreshInFlight?: Promise<PersistedInstrument[]>;

  constructor(
    private readonly provider: AutomatedUniverseProvider,
    private readonly adapter: MarketDataAdapter,
    private readonly store: UniverseStore,
    private readonly policy: UniversePolicy = DEFAULT_UNIVERSE_POLICY,
    private readonly minimumSize = 1,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async enrich(allowLastKnownGood = false): Promise<PersistedInstrument[]> {
    this.refreshInFlight ??= this.refresh().finally(() => {
      this.refreshInFlight = undefined;
    });
    try {
      return await this.refreshInFlight;
    } catch (error) {
      if (!allowLastKnownGood) throw error;
      const fallback = await this.store.loadLastCompleted(
        this.provider.name,
        this.policy.marketId,
      );
      if (!fallback || fallback.instruments.length === 0) throw error;
      this.members = fallback.members;
      return fallback.instruments;
    }
  }

  getAutomation(): UniverseAutomation {
    const editable = isEditableProvider(this.provider);
    return {
      provider: this.provider.name,
      policy: { ...this.policy, securityTypes: [...this.policy.securityTypes] },
      latestRun: this.latestRun
        ? { ...this.latestRun, warnings: [...this.latestRun.warnings] }
        : null,
      members: this.members.map((member) => ({
        ...member,
        reasons: [...member.reasons],
      })),
      editable,
      ...(editable
        ? { configuredSymbols: this.provider.getConfiguredSymbols() }
        : {}),
      ...(editable
        ? { candidates: this.provider.getConfiguredCandidates() }
        : {}),
      ...(editable ? { watchlistDate: this.provider.getWatchlistDate() } : {}),
    };
  }

  getCandidateIntakeStatuses(): Promise<CandidateIntakeStatus[]> {
    if (!isEditableProvider(this.provider)) return Promise.resolve([]);
    return this.provider.getCandidateIntakeStatuses?.() ?? Promise.resolve([]);
  }

  listRuns(limit = 20): Promise<UniverseRefreshRun[]> {
    return this.store.listRuns(limit, this.policy.marketId);
  }

  async replaceSymbols(symbols: string[]): Promise<void> {
    if (!isEditableProvider(this.provider))
      throw new Error("This universe provider is not editable");
    await this.provider.replaceSymbols(symbols);
  }

  async updateCandidates(
    input: UpdateCandidateIntake,
  ): Promise<CandidatePasteReport> {
    if (!isEditableProvider(this.provider))
      throw new Error("This universe provider is not editable");
    return this.provider.updateCandidates(input);
  }

  async reloadConfiguredCandidates(): Promise<void> {
    if (!isEditableProvider(this.provider)) return;
    await this.provider.reloadConfigured?.();
  }

  private async refresh(): Promise<PersistedInstrument[]> {
    const startedAt = this.clock();
    const running = await this.store.begin(
      this.provider.name,
      this.policy,
      startedAt,
    );
    this.latestRun = running;
    try {
      const catalog = deduplicateCatalog(await this.provider.listSymbols());
      const resolved = await Promise.all(
        catalog.map(async (entry) => {
          const matches = await this.adapter.searchSymbols(entry.symbol);
          return {
            entry,
            instrument: matches.find(
              (value) => value.symbol.toUpperCase() === entry.symbol,
            ),
          };
        }),
      );
      const instruments = resolved.flatMap((value) =>
        value.instrument ? [value.instrument] : [],
      );
      const fundamentals = this.adapter.getFundamentals
        ? await this.adapter.getFundamentals(
            instruments.map((value) => value.symbolId),
          )
        : [];
      const fundamentalsById = new Map(
        fundamentals.map((value) => [value.symbolId, value]),
      );
      const enriched = resolved.map(({ entry, instrument }) => {
        const details = instrument
          ? fundamentalsById.get(instrument.symbolId)
          : undefined;
        return {
          instrument,
          entry: {
            ...entry,
            marketCap: details?.marketCap ?? entry.marketCap,
            sector: details?.sector ?? entry.sector,
          },
        };
      });
      const quoteBatches = chunk(
        instruments.map((value) => value.symbolId),
        50,
      );
      const quotes = (
        await Promise.all(
          quoteBatches.map((ids) => this.adapter.getQuotes(ids)),
        )
      ).flat();
      const quotesById = new Map(
        quotes.map((value) => [value.symbolId, value]),
      );
      const dailyById = new Map<number, Candle[]>();
      await Promise.all(
        instruments.map(async (instrument) => {
          dailyById.set(
            instrument.symbolId,
            await this.adapter.getCandles(instrument.symbolId, "OneDay", {
              startTime: new Date(startedAt.getTime() - 150 * 86_400_000),
              endTime: startedAt,
            }),
          );
        }),
      );
      const manual = isManualProvider(this.provider);
      const evaluations = enriched.map(({ entry, instrument }) =>
        instrument
          ? {
              instrument,
              member: buildMember(
                entry,
                instrument,
                quotesById.get(instrument.symbolId),
                dailyById.get(instrument.symbolId) ?? [],
                this.policy,
                startedAt,
                manual,
              ),
            }
          : {
              member: emptyMember(
                entry,
                startedAt,
                "METADATA_UNAVAILABLE",
                this.policy,
              ),
            },
      );
      const warnings = evaluations
        .filter((value) =>
          value.member.reasons.includes("METADATA_UNAVAILABLE"),
        )
        .map(
          (value) =>
            `${value.member.symbol}: provider symbol could not be resolved by Questrade`,
        );
      const completed = await this.store.complete(
        running.id,
        evaluations,
        warnings,
        this.clock(),
        manual ? 0 : this.minimumSize,
      );
      this.latestRun = completed.run;
      this.members = completed.members;
      return completed.instruments;
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Unknown universe refresh error";
      this.latestRun = await this.store.fail(running.id, message, this.clock());
      throw error;
    }
  }
}

function isEditableProvider(
  provider: AutomatedUniverseProvider,
): provider is EditableUniverseProvider {
  return (
    "replaceSymbols" in provider &&
    "updateCandidates" in provider &&
    "getConfiguredSymbols" in provider &&
    "getConfiguredCandidates" in provider &&
    "getWatchlistDate" in provider
  );
}

function isManualProvider(
  provider: AutomatedUniverseProvider,
): provider is ManualUniverseProvider {
  return (
    isEditableProvider(provider) &&
    "activationMode" in provider &&
    provider.activationMode === "MANUAL"
  );
}

function normalizeSymbols(symbols: string[]): string[] {
  return [...new Set(symbols.map(normalizeTsxSymbol).filter(Boolean))].sort(
    (a, b) => a.localeCompare(b),
  );
}

function normalizeConfiguredSymbols(
  symbols: string[],
  marketId: "CA_TSX" | "US_EQUITIES",
): string[] {
  if (marketId === "CA_TSX") return normalizeSymbols(symbols);
  return [
    ...new Set(
      symbols.map((symbol) => {
        const parsed = parseCandidateForMarket(symbol, "US_EQUITIES");
        if (parsed.status !== "VALID") throw new Error(parsed.reason);
        return parsed.normalizedSymbol;
      }),
    ),
  ].sort();
}

function normalizeTsxSymbol(value: string): string {
  let symbol = value
    .trim()
    .toUpperCase()
    .replace(/^\$/, "")
    .replace(/^TSX:/, "");
  if (symbol && !symbol.endsWith(".TO")) symbol += ".TO";
  return symbol;
}

type ParsedCandidateInput =
  | {
      status: "VALID";
      normalizedSymbol: string;
      normalized: boolean;
      requestedExchange?:
        | "TSX"
        | "NASDAQ"
        | "NYSE"
        | "NYSE_AMERICAN"
        | "NYSE_ARCA"
        | "CBOE_BZX"
        | null;
    }
  | { status: "UNSUPPORTED"; normalizedSymbol: string | null; reason: string }
  | { status: "FAILED"; reason: string };

export type ParsedMarketCandidateInput =
  | {
      status: "VALID";
      marketId: "CA_TSX" | "US_EQUITIES";
      requestedExchange:
        | "TSX"
        | "NASDAQ"
        | "NYSE"
        | "NYSE_AMERICAN"
        | "NYSE_ARCA"
        | "CBOE_BZX"
        | null;
      normalizedSymbol: string;
      normalized: boolean;
    }
  | { status: "FAILED"; reason: string };

/** Parses user intent without using a suffix or currency after intake routing. */
export function parseMarketCandidateInput(
  value: string,
): ParsedMarketCandidateInput {
  const trimmed = value.trim();
  if (!trimmed) return { status: "FAILED", reason: "Input is empty" };
  let symbol = trimmed.toUpperCase().replace(/^\$/, "");
  const prefix = /^([A-Z_]+):/.exec(symbol)?.[1];
  const exchange =
    prefix === "TSX"
      ? "TSX"
      : prefix === "NASDAQ"
        ? "NASDAQ"
        : prefix === "NYSE"
          ? "NYSE"
          : prefix === "NYSE_AMERICAN" || prefix === "AMEX"
            ? "NYSE_AMERICAN"
            : prefix === "NYSE_ARCA" || prefix === "ARCA"
              ? "NYSE_ARCA"
              : prefix === "CBOE_BZX" || prefix === "BZX"
                ? "CBOE_BZX"
                : null;
  if (prefix && !exchange)
    return {
      status: "FAILED",
      reason: `${prefix} is not a supported exchange prefix`,
    };
  if (prefix) symbol = symbol.slice(prefix.length + 1);
  const tsx = exchange === "TSX" || symbol.endsWith(".TO");
  if (symbol.endsWith(".TO")) symbol = symbol.slice(0, -3);
  if (!/^[A-Z0-9][A-Z0-9.-]{0,16}$/.test(symbol))
    return { status: "FAILED", reason: "Not a valid equity symbol" };
  const normalizedSymbol = tsx ? `${symbol}.TO` : symbol;
  return {
    status: "VALID",
    marketId: tsx ? "CA_TSX" : "US_EQUITIES",
    requestedExchange: exchange ?? (tsx ? "TSX" : null),
    normalizedSymbol,
    normalized: trimmed.toUpperCase() !== normalizedSymbol,
  };
}

function parseCandidateInput(value: string): ParsedCandidateInput {
  // Keep the existing TSX watchlist's bare-symbol interpretation stable. The
  // mixed-market intake parser intentionally defaults bare symbols to US.
  const trimmed = value.trim();
  const tsxCompatibilityInput =
    !trimmed.includes(":") && !trimmed.toUpperCase().endsWith(".TO")
      ? `TSX:${trimmed}`
      : trimmed;
  const parsed = parseMarketCandidateInput(tsxCompatibilityInput);
  if (parsed.status === "FAILED") return parsed;
  if (parsed.marketId !== "CA_TSX") {
    return {
      status: "UNSUPPORTED",
      normalizedSymbol: null,
      reason: `${parsed.marketId} is not supported by this TSX-only watchlist`,
    };
  }
  return {
    status: "VALID",
    normalizedSymbol: parsed.normalizedSymbol,
    normalized: parsed.normalized,
    requestedExchange: parsed.requestedExchange,
  };
}

function parseCandidateForMarket(
  value: string,
  marketId: "CA_TSX" | "US_EQUITIES",
): ParsedCandidateInput {
  if (marketId === "CA_TSX") return parseCandidateInput(value);
  const parsed = parseMarketCandidateInput(value);
  if (parsed.status === "FAILED") return parsed;
  if (parsed.marketId !== "US_EQUITIES") {
    return {
      status: "UNSUPPORTED",
      normalizedSymbol: parsed.normalizedSymbol,
      reason: "Candidate does not resolve to US_EQUITIES",
    };
  }
  return {
    status: "VALID",
    normalizedSymbol: parsed.normalizedSymbol,
    normalized: parsed.normalized,
    requestedExchange: parsed.requestedExchange,
  };
}

function candidateEntry(
  originalInput: string,
  normalizedSymbol: string,
  source: CandidateSource,
  tradingDate: string,
  addedAt: Date,
  note: string | null = null,
  tags: string[] = [],
  marketId: "CA_TSX" | "US_EQUITIES" = "CA_TSX",
  requestedExchange?:
    | "TSX"
    | "NASDAQ"
    | "NYSE"
    | "NYSE_AMERICAN"
    | "NYSE_ARCA"
    | "CBOE_BZX"
    | null,
): CandidateIntakeEntry {
  return {
    source,
    tradingDate,
    addedAt: addedAt.toISOString(),
    originalInput,
    marketId,
    requestedExchange:
      requestedExchange !== undefined
        ? requestedExchange
        : marketId === "CA_TSX"
          ? "TSX"
          : null,
    normalizedSymbol,
    resolvedInstrumentId: null,
    resolvedSymbol: null,
    resolutionStatus: "PENDING",
    note,
    tags: [...tags],
    provenanceSources: [source],
    discoveryRunId: null,
    discoveryEvaluationId: null,
    discoveredAt: null,
    intakeAt: null,
    strategyReadyAt: null,
  };
}

function candidatePipelineStatus(
  candidate: CandidateIntakeEntry,
): CandidateIntakeStatus {
  return {
    symbol: candidate.normalizedSymbol,
    status: candidate.strategyReadyAt
      ? "READY"
      : candidate.source === "DISCOVERY"
        ? candidate.intakeAt
          ? "ADDED"
          : "QUALIFIED"
        : "ADDED",
    source: candidate.source,
    discoveredAt: candidate.discoveredAt,
    intakeAt: candidate.intakeAt,
    strategyReadyAt: candidate.strategyReadyAt,
    reason: null,
    attemptCount: 0,
  };
}

function normalizeTags(values: string[] = []): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function emptyPasteReport(): CandidatePasteReport {
  return {
    accepted: [],
    normalized: [],
    duplicate: [],
    unsupported: [],
    failed: [],
  };
}

function marketDate(value: Date, marketId: "CA_TSX" | "US_EQUITIES"): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: marketId === "CA_TSX" ? "America/Toronto" : "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((value) => value.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function deduplicateCatalog(
  values: UniverseCatalogSymbol[],
): UniverseCatalogSymbol[] {
  const result = new Map<string, UniverseCatalogSymbol>();
  for (const value of values) {
    const symbol = value.symbol.trim().toUpperCase();
    if (symbol) result.set(symbol, { ...value, symbol });
  }
  return [...result.values()].sort((left, right) =>
    left.symbol.localeCompare(right.symbol),
  );
}

function chunk<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size)
    result.push(values.slice(index, index + size));
  return result;
}

function emptyMember(
  entry: UniverseCatalogSymbol,
  asOf: Date,
  reason: UniverseExclusionReason,
  policy: UniversePolicy,
): UniverseMember {
  return {
    instrumentId: null,
    marketId: policy.marketId,
    symbol: entry.symbol,
    description: "",
    exchange: "",
    normalizedExchange: "UNKNOWN",
    rawExchange: null,
    currency: policy.allowedCurrencies[0]!,
    sector: entry.sector,
    eligible: false,
    reasons: [reason],
    price: null,
    marketCap: entry.marketCap,
    averageVolume20d: null,
    averageVolume90d: null,
    dollarVolume: null,
    atr14: null,
    atrPct: null,
    metricsAsOf: asOf.toISOString(),
  };
}

function buildMember(
  entry: UniverseCatalogSymbol,
  instrument: Instrument,
  quote: Quote | undefined,
  candles: Candle[],
  policy: UniversePolicy,
  asOf: Date,
  manualSelection = false,
): UniverseMember {
  const complete = candles
    .filter((value) => value.isComplete)
    .sort((left, right) => left.start.getTime() - right.start.getTime());
  const price =
    quote?.last && quote.last > 0
      ? quote.last
      : (complete.at(-1)?.close ?? null);
  const volumes = complete.map((value) => value.volume);
  const averageVolume20d = average(volumes.slice(-20));
  const averageVolume90d = average(volumes.slice(-90));
  const atr14 = calculateAtr14(complete);
  const atrPct =
    atr14 !== null && price !== null ? (atr14 / price) * 100 : null;
  const dollarVolume =
    price !== null && averageVolume90d !== null
      ? price * averageVolume90d
      : null;
  const reasons: UniverseExclusionReason[] = [];

  const normalizedExchange = normalizeExchange(instrument.exchange);
  if (
    normalizedExchange === "UNKNOWN" ||
    !policy.allowedExchanges.includes(normalizedExchange)
  )
    reasons.push("EXCHANGE_NOT_ALLOWED");
  if (
    !policy.allowedCurrencies.includes(
      instrument.currency.toUpperCase() as "CAD" | "USD",
    )
  )
    reasons.push("CURRENCY_NOT_ALLOWED");
  if (
    !policy.securityTypes.some(
      (value) => value.toUpperCase() === instrument.securityType.toUpperCase(),
    )
  )
    reasons.push("NOT_COMMON_STOCK");
  if (!instrument.isQuotable) reasons.push("NOT_QUOTABLE");
  if (!instrument.isTradable) reasons.push("NOT_TRADABLE");
  if (!quote) reasons.push("QUOTE_UNAVAILABLE");
  if (!manualSelection) {
    if (complete.length < policy.minimumHistoryDays)
      reasons.push("INSUFFICIENT_HISTORY");
    if (price !== null && price < policy.minimumPrice)
      reasons.push("PRICE_BELOW_MINIMUM");
    if (price !== null && price > policy.maximumPrice)
      reasons.push("PRICE_ABOVE_MAXIMUM");
    if (entry.marketCap === null || entry.marketCap < policy.minimumMarketCap)
      reasons.push("MARKET_CAP_BELOW_MINIMUM");
    if (
      averageVolume90d === null ||
      averageVolume90d < policy.minimumAverageVolume90d
    )
      reasons.push("AVERAGE_VOLUME_BELOW_MINIMUM");
    if (dollarVolume === null || dollarVolume < policy.minimumDollarVolume)
      reasons.push("DOLLAR_VOLUME_BELOW_MINIMUM");
    if (atrPct === null || atrPct < policy.minimumAtrPct)
      reasons.push("ATR_BELOW_MINIMUM");
  }

  return {
    instrumentId: null,
    marketId: policy.marketId,
    symbol: instrument.symbol,
    description: instrument.description,
    exchange: instrument.exchange,
    normalizedExchange,
    rawExchange: instrument.exchange || null,
    currency: instrument.currency.toUpperCase() as "CAD" | "USD",
    sector: entry.sector,
    eligible: reasons.length === 0,
    reasons,
    price,
    marketCap: entry.marketCap,
    averageVolume20d,
    averageVolume90d,
    dollarVolume,
    atr14,
    atrPct,
    metricsAsOf: asOf.toISOString(),
  };
}

function average(values: number[]): number | null {
  return values.length === 0
    ? null
    : Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function calculateAtr14(candles: Candle[]): number | null {
  if (candles.length < 15) return null;
  const ranges = candles.slice(1).map((candle, index) => {
    const previousClose = candles[index]!.close;
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose),
    );
  });
  let atr = ranges.slice(0, 14).reduce((sum, value) => sum + value, 0) / 14;
  for (const range of ranges.slice(14)) atr = (atr * 13 + range) / 14;
  return atr;
}
