import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { marketIdSchema, type MarketId } from "@tsx-scanner/contracts";
import {
  CatalogClientBase,
  CatalogError,
  catalogReasonsFor,
  massiveCatalogEvidenceSchema,
  type CatalogClient,
  type CatalogMember,
  type CatalogRow,
  type CatalogSnapshotStore,
} from "./eodhd-catalog.js";

const BASE_URL = "https://api.polygon.io";

export const MASSIVE_CATALOG_DEFAULTS = Object.freeze({
  timeoutMs: 30_000,
  pageDelayMs: 12_000,
  maxAttemptsPerPage: 4,
  retryDelayMs: 2_000,
  maxPages: 60,
});

const pageSchema = z
  .object({
    status: z.string(),
    results: z.array(z.record(z.string(), z.unknown())).default([]),
    next_url: z.string().nullable().optional(),
  })
  .passthrough();

const tickerSchema = z
  .object({
    ticker: z.string().trim().min(1).max(100),
    name: z.string().trim().min(1).max(500),
    primary_exchange: z.string().trim().max(20).nullable().optional(),
    type: z.string().trim().min(1).max(50),
    currency_name: z.string().trim().max(20).nullable().optional(),
    cik: z.string().trim().max(32).nullable().optional(),
    composite_figi: z.string().trim().max(64).nullable().optional(),
    share_class_figi: z.string().trim().max(64).nullable().optional(),
  })
  .passthrough();

/** Normalized rows as persisted in the durable catalog snapshot. */
const rowSchema = z.object({
  Code: z.string().trim().min(1).max(100),
  Name: z.string().trim().min(1).max(500),
  Exchange: z.string().trim().min(1).max(100),
  Currency: z.string().trim().min(1).max(20),
  Type: z.string().trim().min(1).max(100),
  Isin: z.string().max(100).nullable().optional(),
  Massive: massiveCatalogEvidenceSchema,
});

export interface MassiveCatalogRetention {
  retrievedAt: string;
  responseDigest: string;
}

function emptyToNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Maps original Massive ticker records to retained catalog rows. The original
 * provider row is never replaced: provider type, exchange MIC, currency and
 * identifiers are retained alongside the derived `Common Stock` label, and the
 * complete payload digest stays attached. A single malformed record fails the
 * whole page rather than publishing a partial catalog.
 */
export function normalizeMassiveTickers(
  input: unknown,
  retention: MassiveCatalogRetention,
): CatalogRow[] {
  if (!Array.isArray(input))
    throw new CatalogError("INVALID_RESPONSE", false, "MASSIVE");
  return input.map((record) => {
    const parsed = tickerSchema.safeParse(record);
    if (!parsed.success)
      throw new CatalogError("INVALID_RESPONSE", false, "MASSIVE");
    const ticker = parsed.data;
    const exchangeMic =
      emptyToNull(ticker.primary_exchange)?.toUpperCase() ?? null;
    const currency = emptyToNull(ticker.currency_name)?.toUpperCase() ?? null;
    return {
      Code: ticker.ticker,
      Name: ticker.name,
      // Unknown exchanges are retained as explicitly unknown, never guessed.
      Exchange: exchangeMic ?? "UNKNOWN",
      Currency: currency ?? "UNKNOWN",
      Type:
        ticker.type.trim().toUpperCase() === "CS"
          ? "Common Stock"
          : ticker.type,
      Isin: null,
      Massive: {
        providerTicker: ticker.ticker,
        providerType: ticker.type,
        exchangeMic,
        currency,
        cik: emptyToNull(ticker.cik),
        compositeFigi: emptyToNull(ticker.composite_figi),
        shareClassFigi: emptyToNull(ticker.share_class_figi),
        retrievedAt: retention.retrievedAt,
        responseDigest: retention.responseDigest,
      },
    };
  });
}

export function parseMassiveCatalog(
  input: unknown,
  marketId: MarketId,
): CatalogMember[] {
  marketIdSchema.parse(marketId);
  const parsed = z.array(rowSchema).max(100_000).safeParse(input);
  if (!parsed.success)
    throw new CatalogError("INVALID_RESPONSE", false, "MASSIVE");
  if (parsed.data.length === 0)
    throw new CatalogError("EMPTY_CATALOG", false, "MASSIVE");
  const identities = new Set<string>();
  return parsed.data.map((raw) => {
    const identity = JSON.stringify([raw.Exchange, raw.Code]);
    if (identities.has(identity))
      throw new CatalogError("DUPLICATE_IDENTITY", false, "MASSIVE");
    identities.add(identity);
    const reasons = catalogReasonsFor(raw, marketId);
    return {
      providerCode: raw.Code,
      raw,
      reasons,
      resolutionStatus: reasons.length === 0 ? "PENDING" : "REVIEW_REQUIRED",
    };
  });
}

/**
 * Massive/Polygon US reference-ticker catalog. The free tier allows five
 * requests/minute, so pages are paced at 12s. Every `next_url` is followed
 * within the fixed provider origin; any page failure aborts the refresh so a
 * partial catalog can never be published. Throttling and transport failures
 * receive bounded retries; no request ever falls back to another provider.
 */
export class MassiveCatalogClient
  extends CatalogClientBase
  implements CatalogClient
{
  protected readonly source = "MASSIVE" as const;

  constructor(
    private readonly token: string,
    store: CatalogSnapshotStore,
    private readonly fetcher: typeof fetch = fetch,
    clock: () => Date = () => new Date(),
    sleep: (ms: number) => Promise<void> = delay,
    private readonly pageDelayMs: number = MASSIVE_CATALOG_DEFAULTS.pageDelayMs,
  ) {
    super(store, clock, sleep);
    if (!token.trim()) throw new Error("Massive API key is required");
  }

  protected async loadMembers(marketId: MarketId) {
    if (marketId !== "US_EQUITIES")
      throw new Error("Massive catalog supports US_EQUITIES only");
    const url = new URL(`${BASE_URL}/v3/reference/tickers`);
    url.searchParams.set("market", "stocks");
    url.searchParams.set("active", "true");
    url.searchParams.set("type", "CS");
    url.searchParams.set("limit", "1000");
    const results: Array<Record<string, unknown>> = [];
    let next: string | null = url.toString();
    for (let page = 0; next !== null; page += 1) {
      if (page >= MASSIVE_CATALOG_DEFAULTS.maxPages)
        throw new CatalogError("INVALID_RESPONSE", false, "MASSIVE");
      if (page > 0) await this.sleep(this.pageDelayMs);
      const parsed = pageSchema.safeParse(await this.request(next, 1));
      if (!parsed.success)
        throw new CatalogError("INVALID_RESPONSE", false, "MASSIVE");
      results.push(...parsed.data.results);
      next = this.validatedNextUrl(parsed.data.next_url ?? null);
    }
    const providerDigest = createHash("sha256")
      .update(JSON.stringify(results))
      .digest("hex");
    const rows = normalizeMassiveTickers(results, {
      retrievedAt: this.clock().toISOString(),
      responseDigest: providerDigest,
    });
    return { members: parseMassiveCatalog(rows, marketId), providerDigest };
  }

  private validatedNextUrl(value: string | null): string | null {
    if (value === null) return null;
    let target: URL;
    try {
      target = new URL(value);
    } catch {
      throw new CatalogError("INVALID_RESPONSE", false, "MASSIVE");
    }
    if (target.origin !== BASE_URL)
      throw new CatalogError("INVALID_RESPONSE", false, "MASSIVE");
    return target.toString();
  }

  private async request(url: string, attempt: number): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(url, {
        signal: AbortSignal.timeout(MASSIVE_CATALOG_DEFAULTS.timeoutMs),
        redirect: "error",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.token}`,
        },
      });
    } catch {
      if (attempt >= MASSIVE_CATALOG_DEFAULTS.maxAttemptsPerPage)
        throw new CatalogError("TRANSPORT_ERROR", true, "MASSIVE");
      await this.sleep(MASSIVE_CATALOG_DEFAULTS.retryDelayMs * attempt);
      return this.request(url, attempt + 1);
    }
    if (response.status === 429) {
      await response.body?.cancel();
      if (attempt >= MASSIVE_CATALOG_DEFAULTS.maxAttemptsPerPage)
        throw new CatalogError("HTTP_ERROR", false, "MASSIVE");
      await this.sleep(this.pageDelayMs * attempt);
      return this.request(url, attempt + 1);
    }
    if (response.status >= 500) {
      await response.body?.cancel();
      if (attempt >= MASSIVE_CATALOG_DEFAULTS.maxAttemptsPerPage)
        throw new CatalogError("HTTP_ERROR", true, "MASSIVE");
      await this.sleep(this.pageDelayMs);
      return this.request(url, attempt + 1);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new CatalogError("HTTP_ERROR", false, "MASSIVE");
    }
    try {
      return await response.json();
    } catch {
      throw new CatalogError("INVALID_RESPONSE", false, "MASSIVE");
    }
  }
}
