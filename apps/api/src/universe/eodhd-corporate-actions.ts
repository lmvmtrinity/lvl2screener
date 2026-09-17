import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

const rawSplitSchema = z.object({
  date: z.string().date(),
  split: z.string().regex(/^\d+(\.\d+)?\/\d+(\.\d+)?$/),
});
const rawDividendSchema = z.object({
  date: z.string().date(),
  value: z.number().finite().nonnegative(),
  currency: z.string().min(1).max(10),
});

export interface EodhdSplitEvent {
  date: string;
  /** New shares per old share (4-for-1 => 4). */
  shareFactor: number;
}

export interface EodhdDividendEvent {
  date: string;
  amount: number;
  currency: string;
}

export class EodhdCorporateActionClient {
  constructor(
    private readonly token: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly sleep: (ms: number) => Promise<void> = delay,
  ) {
    if (!token.trim())
      throw new Error("EODHD token is required for corporate actions");
  }

  /** Splits for one ticker, ascending by date. Never logs the token. */
  async splits(ticker: string): Promise<EodhdSplitEvent[]> {
    const payload = await this.request(`splits/${encodeURIComponent(ticker)}`);
    if (!Array.isArray(payload)) return [];
    return payload
      .flatMap((row) => {
        const parsed = rawSplitSchema.safeParse(row);
        if (!parsed.success) return [];
        const [numerator, denominator] = parsed.data.split.split("/");
        const shareFactor = Number(numerator) / Number(denominator);
        return Number.isFinite(shareFactor) && shareFactor > 0
          ? [{ date: parsed.data.date, shareFactor }]
          : [];
      })
      .sort((left, right) => left.date.localeCompare(right.date));
  }

  /** Cash dividends for one ticker, ascending by date. */
  async dividends(ticker: string): Promise<EodhdDividendEvent[]> {
    const payload = await this.request(`div/${encodeURIComponent(ticker)}`);
    if (!Array.isArray(payload)) return [];
    return payload
      .flatMap((row) => {
        const parsed = rawDividendSchema.safeParse(row);
        return parsed.success
          ? [
              {
                date: parsed.data.date,
                amount: parsed.data.value,
                currency: parsed.data.currency,
              },
            ]
          : [];
      })
      .sort((left, right) => left.date.localeCompare(right.date));
  }

  private async request(path: string): Promise<unknown> {
    const url = new URL(`https://eodhd.com/api/${path}`);
    url.searchParams.set("api_token", this.token);
    url.searchParams.set("fmt", "json");
    for (let attempt = 1; ; attempt++) {
      // Stay well below the plan's per-minute allowance.
      await this.sleep(80);
      let response: Response;
      try {
        response = await this.fetcher(url, {
          signal: AbortSignal.timeout(30_000),
          redirect: "error",
          headers: { Accept: "application/json" },
        });
      } catch {
        if (attempt >= 3)
          throw new Error(`EODHD corporate action request failed: ${path}`);
        await this.sleep(1_000 * attempt);
        continue;
      }
      if (response.status === 429) {
        await response.body?.cancel();
        if (attempt >= 4)
          throw new Error("EODHD corporate action rate limit exceeded");
        await this.sleep(5_000 * attempt);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(
          `EODHD corporate action request failed (${response.status}): ${path}`,
        );
      }
      return response.json();
    }
  }
}
