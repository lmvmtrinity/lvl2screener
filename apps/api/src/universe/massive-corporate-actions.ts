import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

const pageSchema = z
  .object({
    status: z.string(),
    results: z.array(z.record(z.string(), z.unknown())).default([]),
    next_url: z.string().url().optional().nullable(),
  })
  .passthrough();

export interface MassiveSplitEvent {
  ticker: string;
  executionDate: string;
  /** Multiplier applied to pre-event prices to reach the post-event basis. */
  priceFactor: number;
  /** Multiplier applied to pre-event volumes to reach the post-event basis. */
  volumeFactor: number;
  adjustmentType: string | null;
}

export interface MassiveDividendEvent {
  ticker: string;
  exDividendDate: string;
  cashAmount: number;
  currency: string;
  adjustmentFactor: number | null;
}

const BASE_URL = "https://api.polygon.io";
/** Free tier is 5 requests/minute; one request per 12s stays under it. */
const DEFAULT_PAGE_DELAY_MS = 12_000;
const MAX_PAGES = 60;

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export class MassiveCorporateActionClient {
  constructor(
    private readonly token: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly sleep: (ms: number) => Promise<void> = delay,
    private readonly pageDelayMs: number = DEFAULT_PAGE_DELAY_MS,
  ) {
    if (!token.trim()) throw new Error("Massive API key is required");
  }

  async splits(from: string, to: string): Promise<MassiveSplitEvent[]> {
    const rows = await this.pages("/stocks/v1/splits", {
      "execution_date.gte": from,
      "execution_date.lte": to,
    });
    return rows.flatMap((row) => {
      const ticker = stringOrNull(row.ticker);
      const executionDate = stringOrNull(row.execution_date);
      const fromShares = numberOrNull(row.split_from);
      const toShares = numberOrNull(row.split_to);
      if (!ticker || !executionDate || !fromShares || !toShares) return [];
      const priceFactor =
        numberOrNull(row.historical_adjustment_factor) ?? fromShares / toShares;
      if (!Number.isFinite(priceFactor) || priceFactor <= 0) return [];
      return [
        {
          ticker,
          executionDate,
          priceFactor,
          volumeFactor: 1 / priceFactor,
          adjustmentType: stringOrNull(row.adjustment_type),
        },
      ];
    });
  }

  async dividends(from: string, to: string): Promise<MassiveDividendEvent[]> {
    const rows = await this.pages("/stocks/v1/dividends", {
      "ex_dividend_date.gte": from,
      "ex_dividend_date.lte": to,
    });
    return rows.flatMap((row) => {
      const ticker = stringOrNull(row.ticker);
      const exDividendDate = stringOrNull(row.ex_dividend_date);
      const cashAmount = numberOrNull(row.cash_amount);
      if (!ticker || !exDividendDate || cashAmount === null) return [];
      return [
        {
          ticker,
          exDividendDate,
          cashAmount,
          currency: stringOrNull(row.currency) ?? "USD",
          adjustmentFactor: numberOrNull(row.historical_adjustment_factor),
        },
      ];
    });
  }

  private async pages(
    path: string,
    params: Record<string, string>,
  ): Promise<Array<Record<string, unknown>>> {
    const url = new URL(`${BASE_URL}${path}`);
    for (const [key, value] of Object.entries(params))
      url.searchParams.set(key, value);
    url.searchParams.set("limit", "5000");
    const rows: Array<Record<string, unknown>> = [];
    let next: string | null = url.toString();
    for (let page = 0; page < MAX_PAGES && next; page += 1) {
      if (page > 0) await this.sleep(this.pageDelayMs);
      const response = await this.request(next);
      const parsed = pageSchema.safeParse(response);
      if (!parsed.success)
        throw new Error("Massive corporate action response was malformed");
      rows.push(...parsed.data.results);
      next = parsed.data.next_url ?? null;
    }
    return rows;
  }

  private async request(url: string): Promise<unknown> {
    for (let attempt = 1; ; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetcher(url, {
          signal: AbortSignal.timeout(30_000),
          redirect: "error",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${this.token}`,
          },
        });
      } catch {
        if (attempt >= 3)
          throw new Error("Massive corporate action request failed");
        await this.sleep(2_000 * attempt);
        continue;
      }
      if (response.status === 429) {
        await response.body?.cancel();
        if (attempt >= 4)
          throw new Error("Massive corporate action rate limit exceeded");
        await this.sleep(this.pageDelayMs * attempt);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(
          `Massive corporate action request failed (${response.status})`,
        );
      }
      return response.json();
    }
  }
}
