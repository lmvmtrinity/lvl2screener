import type {
  Candle,
  CandleInterval,
  CandleRange,
  Market,
  MarketDataAdapter,
} from "../questrade/types.js";
import type {
  MarketDataRepository,
  PersistedInstrument,
} from "./repository.js";
import { QuestradeHttpError } from "../questrade/live-transport.js";

export interface CandleCollectionOptions {
  maxConcurrentRequests?: number;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
}

const DEFAULT_MAX_CONCURRENT_REQUESTS = 2;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 1_000;

const defaultSleep = (delayMs: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, delayMs));

export class QuestradeCandleService {
  private readonly maxConcurrentRequests: number;
  private readonly maxAttempts: number;
  private readonly retryBaseDelayMs: number;
  private readonly sleep: (delayMs: number) => Promise<void>;

  constructor(
    private readonly adapter: MarketDataAdapter,
    private readonly repository: MarketDataRepository,
    options: CandleCollectionOptions = {},
  ) {
    this.maxConcurrentRequests =
      options.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.retryBaseDelayMs =
      options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    this.sleep = options.sleep ?? defaultSleep;

    if (
      !Number.isInteger(this.maxConcurrentRequests) ||
      this.maxConcurrentRequests < 1
    ) {
      throw new Error("maxConcurrentRequests must be a positive integer");
    }
    if (!Number.isInteger(this.maxAttempts) || this.maxAttempts < 1) {
      throw new Error("maxAttempts must be a positive integer");
    }
    if (!Number.isFinite(this.retryBaseDelayMs) || this.retryBaseDelayMs < 0) {
      throw new Error("retryBaseDelayMs must be non-negative");
    }
  }

  async collect(
    instruments: PersistedInstrument[],
    market: Market,
    now: Date,
    intervals: CandleInterval[],
  ): Promise<Candle[]> {
    const endTime = new Date(Math.min(now.getTime(), market.endTime.getTime()));
    if (endTime <= market.startTime || intervals.length === 0) return [];

    return this.collectRange(
      instruments,
      { startTime: market.startTime, endTime },
      intervals,
    );
  }

  async collectRange(
    instruments: PersistedInstrument[],
    range: CandleRange,
    intervals: CandleInterval[],
  ): Promise<Candle[]> {
    if (range.endTime <= range.startTime || intervals.length === 0) return [];
    const requests = instruments.flatMap((instrument) =>
      intervals.map((interval) => ({ instrument, interval })),
    );
    const results = new Array<Candle[]>(requests.length);
    let nextRequest = 0;
    const worker = async () => {
      while (nextRequest < requests.length) {
        const index = nextRequest++;
        const request = requests[index]!;
        results[index] = await this.fetchWithRetry(
          request.instrument,
          request.interval,
          range,
        );
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(this.maxConcurrentRequests, requests.length) },
        () => worker(),
      ),
    );
    const candles = results.flat();
    await this.repository.saveCandles(candles);
    return candles;
  }

  private async fetchWithRetry(
    instrument: PersistedInstrument,
    interval: CandleInterval,
    range: CandleRange,
  ): Promise<Candle[]> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.adapter.getCandles(
          instrument.symbolId,
          interval,
          range,
        );
      } catch (error) {
        if (attempt >= this.maxAttempts || !isTransientCandleError(error)) {
          throw error;
        }
        await this.sleep(this.retryBaseDelayMs * 2 ** (attempt - 1));
      }
    }
  }
}

function isTransientCandleError(error: unknown): boolean {
  if (error instanceof QuestradeHttpError) {
    return error.status === 429 || error.status >= 500;
  }
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" || error instanceof TypeError;
}
