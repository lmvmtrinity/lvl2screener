import {
  normalizeCandle,
  normalizeMarket,
  normalizeQuote,
  normalizeSymbol,
} from "./normalizers.js";
import { QuestradeTokenManager } from "./token-manager.js";
import { normalizeSectorKey } from "./sector.js";
import { QuestradeQueueError } from "./rate-limiter.js";
import { QuestradeHttpError } from "./live-transport.js";
import type {
  QuestradeRequestPriority,
  QuestradeRequestScheduler,
  RequestOptions,
} from "./rate-limiter.js";
import type {
  QuestradeRequestObservation,
  QuestradeRequestOperation,
  QuestradeScheduledRequestObservation,
} from "./request-observation.js";
import type {
  AuthSession,
  Candle,
  CandleInterval,
  CandleRange,
  Instrument,
  InstrumentFundamentals,
  Market,
  MarketDataAdapter,
  QuestradeTransport,
  QuoteSizeUnit,
  Quote,
  RawCandle,
  MarketDataRequestOptions,
} from "./types.js";

export class QuestradeAdapter implements MarketDataAdapter {
  constructor(
    private readonly tokenManager: QuestradeTokenManager,
    private readonly transport: QuestradeTransport,
    private readonly clock: () => Date = () => new Date(),
    private readonly source: Candle["source"] = "QUESTRADE_MOCK",
    private readonly scheduler?: QuestradeRequestScheduler,
    private readonly quoteSizeUnit: QuoteSizeUnit = source === "QUESTRADE"
      ? "BOARD_LOTS"
      : "SHARES",
    private readonly quoteSizeMultiplier: number = quoteSizeUnit ===
    "BOARD_LOTS"
      ? 100
      : 1,
    private readonly requestOptions: Omit<RequestOptions, "observation"> = {},
  ) {}

  /** Same identity, token manager and scheduler; discovery never gets its own allowance. */
  forDiscovery(
    options: Omit<RequestOptions, "discovery" | "observation"> = {},
  ): QuestradeAdapter {
    if (!this.scheduler)
      throw new Error("Discovery requires a shared broker scheduler");
    return new QuestradeAdapter(
      this.tokenManager,
      this.transport,
      this.clock,
      this.source,
      this.scheduler,
      this.quoteSizeUnit,
      this.quoteSizeMultiplier,
      { ...options, discovery: true },
    );
  }

  initialize(): Promise<AuthSession> {
    return this.tokenManager.getSession();
  }

  async searchSymbols(
    prefix: string,
    options?: MarketDataRequestOptions,
  ): Promise<Instrument[]> {
    const query = prefix.trim();
    if (!query) return [];
    const symbols = await this.withSession(
      "P3",
      (session) =>
        this.transport.searchSymbols(
          session.apiServer,
          session.accessToken,
          query,
        ),
      options,
      "MAPPING",
      1,
    );
    return symbols.map(normalizeSymbol);
  }

  async getFundamentals(
    symbolIds: number[],
    options?: MarketDataRequestOptions,
  ): Promise<InstrumentFundamentals[]> {
    const uniqueIds = [...new Set(symbolIds)];
    if (uniqueIds.length === 0) return [];
    const result: InstrumentFundamentals[] = [];
    for (let index = 0; index < uniqueIds.length; index += 50) {
      const ids = uniqueIds.slice(index, index + 50);
      const details = await this.withSession(
        "P3",
        (session) =>
          this.transport.getSymbolDetails(
            session.apiServer,
            session.accessToken,
            ids,
          ),
        options,
        "FUNDAMENTALS",
        ids.length,
      );
      result.push(
        ...details.map((value) => ({
          symbol: value.symbol,
          symbolId: value.symbolId,
          marketCap: value.marketCap,
          sector: normalizeSectorKey(value.industrySector),
        })),
      );
    }
    return result;
  }

  async getQuotes(
    symbolIds: number[],
    options?: MarketDataRequestOptions,
  ): Promise<Quote[]> {
    const uniqueIds = [...new Set(symbolIds)];
    if (uniqueIds.length === 0) return [];
    const quotes = await this.withSession(
      "P1",
      (session) =>
        this.transport.getQuotes(
          session.apiServer,
          session.accessToken,
          uniqueIds,
        ),
      options,
      "QUOTE",
      uniqueIds.length,
    );
    const receivedAt = this.clock();
    return quotes.map((quote) =>
      normalizeQuote(
        quote,
        receivedAt,
        this.source,
        this.quoteSizeUnit,
        this.quoteSizeMultiplier,
      ),
    );
  }

  async getCandles(
    symbolId: number,
    interval: CandleInterval,
    range: CandleRange,
    options?: MarketDataRequestOptions,
  ): Promise<Candle[]> {
    if (range.endTime <= range.startTime) {
      throw new Error("Candle endTime must be after startTime");
    }
    const candles: RawCandle[] = [];
    for (const page of splitCandleRange(interval, range)) {
      try {
        candles.push(
          ...(await this.withSession(
            "P2",
            (session) =>
              this.transport.getCandles(
                session.apiServer,
                session.accessToken,
                symbolId,
                interval,
                page,
              ),
            options,
            interval === "OneDay" ? "DAILY_HISTORY" : "SLOT_HISTORY",
            1,
          )),
        );
      } catch (error) {
        // Questrade uses 404 for a resolved symbol that has no candle history.
        // Treat that symbol as unavailable; callers already model an empty
        // history and must not lose every peer in a Promise.all batch.
        if (error instanceof QuestradeHttpError && error.status === 404)
          return [];
        throw error;
      }
    }
    const now = this.clock();
    const uniqueCandles = new Map(
      candles.map((candle) => [candle.start, candle]),
    );
    return [...uniqueCandles.values()]
      .sort((left, right) => Date.parse(left.start) - Date.parse(right.start))
      .map((candle) =>
        normalizeCandle(candle, symbolId, interval, now, this.source),
      );
  }

  async getMarket(name: string): Promise<Market | undefined> {
    const markets = await this.withSession("P2", (session) =>
      this.transport.getMarkets(session.apiServer, session.accessToken),
    );
    const normalized = name.trim().toUpperCase();
    const candidateNames =
      normalized === "US" || normalized === "US_EQUITIES"
        ? ["US", "NASDAQ", "NYSE", "NYSEAM", "ARCA"]
        : [normalized];
    const market = markets.find((candidate) =>
      candidateNames.includes(candidate.name.trim().toUpperCase()),
    );
    if (!market) return undefined;
    const normalizedMarket = normalizeMarket(market, this.clock());
    return normalized === "US" || normalized === "US_EQUITIES"
      ? { ...normalizedMarket, name: "US", currency: "USD" }
      : normalizedMarket;
  }

  private request<T>(
    priority: QuestradeRequestPriority,
    operation: () => Promise<T>,
    options?: RequestOptions,
  ): Promise<T> {
    return this.scheduler
      ? this.scheduler.schedule(priority, operation, {
          ...this.requestOptions,
          ...options,
        })
      : operation();
  }

  private async withSession<T>(
    priority: QuestradeRequestPriority,
    operation: (session: AuthSession) => Promise<T>,
    options?: MarketDataRequestOptions,
    requestOperation?: QuestradeRequestOperation,
    requestedItems?: number,
  ): Promise<T> {
    const requestOptions = this.requestOptionsFor(
      options,
      requestOperation,
      requestedItems,
    );
    this.assertRequestActive(requestOptions);
    let session = await this.tokenManager.getSession();
    this.assertRequestActive(requestOptions);
    try {
      return await this.request(
        priority,
        () => operation(session),
        requestOptions,
      );
    } catch (error) {
      if (!(error instanceof QuestradeHttpError) || error.status !== 401)
        throw error;
      this.assertRequestActive(requestOptions);
      session = await this.tokenManager.refresh();
      this.assertRequestActive(requestOptions);
      this.observe(requestOptions.observation, "HTTP_401_RETRY");
      return this.request(priority, () => operation(session), requestOptions);
    }
  }

  private requestOptionsFor(
    options: MarketDataRequestOptions | undefined,
    operation: QuestradeRequestOperation | undefined,
    requestedItems: number | undefined,
  ): RequestOptions {
    const { observation, ...requestOptions } = options ?? {};
    if (!observation || !operation || requestedItems === undefined)
      return requestOptions;
    return {
      ...requestOptions,
      observation: { ...observation, operation, requestedItems },
    };
  }

  private observe(
    observation: QuestradeScheduledRequestObservation | undefined,
    phase: QuestradeRequestObservation["phase"],
    detail: Pick<QuestradeRequestObservation, "outcome" | "queueWaitMs"> = {},
  ): void {
    if (!observation) return;
    try {
      const result = observation.observer.observe({
        attemptId: observation.attemptId,
        operation: observation.operation,
        requestedItems: observation.requestedItems,
        phase,
        at: this.clock(),
        ...detail,
      });
      void Promise.resolve(result as unknown).catch(() => undefined);
    } catch {
      // Diagnostics must never change broker request semantics.
    }
  }

  private assertRequestActive(options?: RequestOptions): void {
    if (options?.signal?.aborted) {
      const reason = options.signal.reason;
      const code =
        typeof reason === "object" && reason !== null && "code" in reason
          ? reason.code
          : null;
      const outcome = code === "EXPIRED" ? "EXPIRED" : "CANCELLED";
      this.observe(options.observation, "SETTLED", {
        outcome,
        queueWaitMs: 0,
      });
      throw new QuestradeQueueError(outcome);
    }
    if (
      options?.expiresAt &&
      options.expiresAt.getTime() <= this.clock().getTime()
    ) {
      this.observe(options.observation, "SETTLED", {
        outcome: "EXPIRED",
        queueWaitMs: 0,
      });
      throw new QuestradeQueueError("EXPIRED");
    }
  }
}

function splitCandleRange(
  interval: CandleInterval,
  range: CandleRange,
): CandleRange[] {
  const days =
    interval === "OneMinute" ? 3 : interval === "FiveMinutes" ? 21 : 1_500;
  const windowMs = days * 86_400_000;
  const result: CandleRange[] = [];
  for (
    let cursor = range.startTime.getTime();
    cursor < range.endTime.getTime();
    cursor += windowMs
  ) {
    result.push({
      startTime: new Date(cursor),
      endTime: new Date(Math.min(cursor + windowMs, range.endTime.getTime())),
    });
  }
  return result;
}
