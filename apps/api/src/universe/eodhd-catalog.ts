import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { marketIdSchema, type MarketId } from "@tsx-scanner/contracts";
import { normalizeExchange } from "../questrade/exchange.js";

export type CatalogSource = "EODHD" | "MASSIVE";

const rowSchema = z.object({
  Code: z.string().trim().min(1).max(100),
  Name: z.string().trim().min(1).max(500),
  Exchange: z.string().trim().min(1).max(100),
  Currency: z.string().trim().min(1).max(20),
  Type: z.string().trim().min(1).max(100),
  Isin: z.string().max(100).nullable().optional(),
});

/**
 * Original Massive/Polygon reference evidence retained with each row. The
 * row-level `Type` is a derived label and is never the only classification
 * record. Retrieval metadata is deliberately excluded from the mapping
 * fingerprint so repeated unchanged snapshots do not invalidate cached
 * decisions, while provider/type/identity evidence remains bound to them.
 */
export const massiveCatalogEvidenceSchema = z
  .object({
    providerTicker: z.string().trim().min(1).max(100),
    providerType: z.string().trim().min(1).max(50),
    exchangeMic: z.string().trim().min(1).max(20).nullable(),
    currency: z.string().trim().min(1).max(20).nullable(),
    cik: z.string().trim().max(32).nullable(),
    compositeFigi: z.string().trim().max(64).nullable(),
    shareClassFigi: z.string().trim().max(64).nullable(),
    retrievedAt: z.string().datetime(),
    responseDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type MassiveCatalogEvidence = z.infer<
  typeof massiveCatalogEvidenceSchema
>;

export type CatalogRow = z.infer<typeof rowSchema> & {
  Massive?: MassiveCatalogEvidence;
};
export type CatalogReason =
  | "EXCHANGE_NOT_ALLOWED"
  | "CURRENCY_NOT_ALLOWED"
  | "CLASSIFICATION_REVIEW_REQUIRED";

export interface CatalogMember {
  providerCode: string;
  raw: CatalogRow;
  reasons: CatalogReason[];
  // Catalog admission never establishes broker identity or final common-stock status.
  resolutionStatus: "PENDING" | "REVIEW_REQUIRED";
}

export interface CatalogSnapshot {
  source: CatalogSource;
  marketId: MarketId;
  tradingDate: string;
  fetchedAt: string;
  digest: string;
  /** Digest of the complete provider payload for this snapshot, when retained. */
  providerDigest: string | null;
  rowCount: number;
  admittedCount: number;
  members: CatalogMember[];
}

function catalogLabel(source: CatalogSource): string {
  return source === "MASSIVE" ? "Massive" : "EODHD";
}

export class CatalogError extends Error {
  constructor(
    readonly code:
      | "INVALID_RESPONSE"
      | "DUPLICATE_IDENTITY"
      | "EMPTY_CATALOG"
      | "CATALOG_DROP"
      | "HTTP_ERROR"
      | "TRANSPORT_ERROR",
    readonly retryable = false,
    readonly source: CatalogSource = "EODHD",
  ) {
    // Never retain provider bodies, request URLs, or underlying exception causes.
    super(`${catalogLabel(source)} catalog: ${code}`);
    this.name = "CatalogError";
  }
}

/** EODHD exchange-list code, observed on the TO endpoint; not a broker alias. */
export function normalizeCatalogExchange(value: string) {
  const normalized = value.trim().toUpperCase();
  // Massive exposes exchange MICs; they are not broker aliases either.
  if (normalized === "XNYS") return "NYSE";
  if (normalized === "XNAS") return "NASDAQ";
  return normalized === "TO" ? "TSX" : normalizeExchange(value);
}

export function catalogReasonsFor(
  raw: CatalogRow,
  marketId: MarketId,
): CatalogReason[] {
  const exchange = normalizeCatalogExchange(raw.Exchange);
  const reasons: CatalogReason[] = [];
  if (
    marketId === "CA_TSX"
      ? exchange !== "TSX"
      : exchange !== "NYSE" && exchange !== "NASDAQ"
  )
    reasons.push("EXCHANGE_NOT_ALLOWED");
  if (raw.Currency !== (marketId === "CA_TSX" ? "CAD" : "USD"))
    reasons.push("CURRENCY_NOT_ALLOWED");
  if (raw.Type !== "Common Stock")
    reasons.push("CLASSIFICATION_REVIEW_REQUIRED");
  return reasons;
}

export function parseEodhdCatalog(
  input: unknown,
  marketId: MarketId,
): CatalogMember[] {
  marketIdSchema.parse(marketId);
  const parsed = z.array(rowSchema).max(100_000).safeParse(input);
  if (!parsed.success) throw new CatalogError("INVALID_RESPONSE");
  if (parsed.data.length === 0) throw new CatalogError("EMPTY_CATALOG");
  const identities = new Set<string>();
  return parsed.data.map((raw) => {
    const identity = JSON.stringify([raw.Exchange, raw.Code]);
    if (identities.has(identity)) throw new CatalogError("DUPLICATE_IDENTITY");
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

/** The durable implementation must atomically publish one snapshot per market/date.
 * Its caller must hold a cross-process refresh lease. */
export interface CatalogSnapshotStore {
  loadLatest(marketId: MarketId): Promise<CatalogSnapshot | null>;
  save(snapshot: CatalogSnapshot): Promise<void>;
  withRefreshLease?<T>(
    marketId: MarketId,
    action: (store: CatalogSnapshotStore) => Promise<T>,
  ): Promise<T>;
  recordFailure?(
    marketId: MarketId,
    tradingDate: string,
    failure: CatalogError["code"],
    retainedDigest: string | null,
  ): Promise<void>;
}

export interface CatalogResult {
  status: "FRESH" | "LAST_GOOD" | "UNAVAILABLE";
  snapshot: CatalogSnapshot | null;
  ageMs: number | null;
  failure: CatalogError["code"] | null;
}

/** Shared facade so provider selection stays a composition decision. */
export interface CatalogClient {
  refresh(marketId: MarketId, tradingDate: string): Promise<CatalogResult>;
}

export const CATALOG_DEFAULTS = Object.freeze({
  timeoutMs: 10_000,
  maxAttempts: 2,
  retryDelayMs: 1_000,
  maxAgeMs: 96 * 60 * 60 * 1_000,
  maximumDropFraction: 0.2,
});

interface CatalogLoad {
  members: CatalogMember[];
  providerDigest: string | null;
}

/**
 * Shared refresh/lease/drop-guard behavior for one catalog provider. A snapshot
 * from a different provider is never reused or reported as last-good, so a
 * selected provider's failures stay visible instead of silently falling back.
 */
export abstract class CatalogClientBase implements CatalogClient {
  private readonly pending = new Map<
    MarketId,
    { tradingDate: string; operation: Promise<CatalogResult> }
  >();

  protected constructor(
    private readonly store: CatalogSnapshotStore,
    protected readonly clock: () => Date,
    protected readonly sleep: (ms: number) => Promise<void>,
  ) {}

  protected abstract readonly source: CatalogSource;
  protected abstract loadMembers(marketId: MarketId): Promise<CatalogLoad>;

  async refresh(
    marketId: MarketId,
    tradingDate: string,
  ): Promise<CatalogResult> {
    marketIdSchema.parse(marketId);
    z.string().date().parse(tradingDate);
    // Serialize different dates too, preventing an older request overwriting a new one.
    const pending = this.pending.get(marketId);
    if (pending) {
      if (pending.tradingDate === tradingDate) return pending.operation;
      await pending.operation;
      return this.refresh(marketId, tradingDate);
    }
    const operation = this.store.withRefreshLease
      ? this.store.withRefreshLease(marketId, (store) =>
          this.refreshOnce(marketId, tradingDate, store),
        )
      : this.refreshOnce(marketId, tradingDate, this.store);
    this.pending.set(marketId, { tradingDate, operation });
    try {
      return await operation;
    } finally {
      this.pending.delete(marketId);
    }
  }

  private async refreshOnce(
    marketId: MarketId,
    tradingDate: string,
    store: CatalogSnapshotStore,
  ): Promise<CatalogResult> {
    const previous = await store.loadLatest(marketId);
    if (
      previous &&
      (previous.marketId !== marketId || previous.tradingDate > tradingDate)
    )
      throw new Error("Catalog cache ownership/date conflict");
    const age = (snapshot: CatalogSnapshot) =>
      this.clock().getTime() - Date.parse(snapshot.fetchedAt);
    const usable = (snapshot: CatalogSnapshot) =>
      age(snapshot) >= 0 && age(snapshot) <= CATALOG_DEFAULTS.maxAgeMs;
    // Evidence from another provider cannot stand in for the selected one.
    const lastGood = previous?.source === this.source ? previous : null;
    if (lastGood?.tradingDate === tradingDate && usable(lastGood))
      return {
        status: "FRESH",
        snapshot: lastGood,
        ageMs: age(lastGood),
        failure: null,
      };

    let snapshot: CatalogSnapshot;
    try {
      const loaded = await this.loadMembers(marketId);
      const members = loaded.members;
      const admittedCount = members.filter(
        (row) => row.reasons.length === 0,
      ).length;
      if (admittedCount === 0)
        throw new CatalogError("EMPTY_CATALOG", false, this.source);
      if (
        lastGood &&
        (members.length <
          lastGood.rowCount * (1 - CATALOG_DEFAULTS.maximumDropFraction) ||
          admittedCount <
            lastGood.admittedCount * (1 - CATALOG_DEFAULTS.maximumDropFraction))
      )
        throw new CatalogError("CATALOG_DROP", false, this.source);
      // Canonical order makes the digest independent of provider row ordering.
      members.sort((a, b) => {
        const left = JSON.stringify([a.raw.Exchange, a.providerCode]);
        const right = JSON.stringify([b.raw.Exchange, b.providerCode]);
        return left < right ? -1 : left > right ? 1 : 0;
      });
      snapshot = {
        source: this.source,
        marketId,
        tradingDate,
        fetchedAt: this.clock().toISOString(),
        digest: createHash("sha256")
          .update(JSON.stringify(members))
          .digest("hex"),
        providerDigest: loaded.providerDigest,
        rowCount: members.length,
        admittedCount,
        members,
      };
    } catch (error) {
      if (!(error instanceof CatalogError)) throw error;
      await store.recordFailure?.(
        marketId,
        tradingDate,
        error.code,
        lastGood?.digest ?? null,
      );
      return {
        status: lastGood && usable(lastGood) ? "LAST_GOOD" : "UNAVAILABLE",
        snapshot: lastGood && usable(lastGood) ? lastGood : null,
        ageMs: lastGood ? age(lastGood) : null,
        failure: error.code,
      };
    }
    // Storage errors must remain visible, not be mislabeled as provider failures.
    await store.save(snapshot);
    return { status: "FRESH", snapshot, ageMs: age(snapshot), failure: null };
  }
}

export class EodhdCatalogClient extends CatalogClientBase {
  protected readonly source = "EODHD" as const;

  constructor(
    private readonly token: string,
    store: CatalogSnapshotStore,
    private readonly fetcher: typeof fetch = fetch,
    clock: () => Date = () => new Date(),
    sleep: (ms: number) => Promise<void> = delay,
  ) {
    super(store, clock, sleep);
    if (!token.trim()) throw new Error("EODHD token is required");
  }

  protected async loadMembers(marketId: MarketId): Promise<CatalogLoad> {
    return {
      members: parseEodhdCatalog(await this.request(marketId), marketId),
      providerDigest: null,
    };
  }

  private async request(marketId: MarketId): Promise<unknown> {
    const url = new URL(
      `https://eodhd.com/api/exchange-symbol-list/${marketId === "CA_TSX" ? "TO" : "US"}`,
    );
    url.searchParams.set("api_token", this.token);
    url.searchParams.set("fmt", "json");
    url.searchParams.set("type", "common_stock");
    for (let attempt = 1; ; attempt++) {
      try {
        const response = await this.fetcher(url, {
          signal: AbortSignal.timeout(CATALOG_DEFAULTS.timeoutMs),
          redirect: "error",
          headers: { Accept: "application/json" },
        });
        if (!response.ok) {
          await response.body?.cancel();
          // Defer 429 until a later scheduled attempt; never retry before Retry-After.
          throw new CatalogError("HTTP_ERROR", response.status >= 500);
        }
        try {
          return await response.json();
        } catch {
          throw new CatalogError("INVALID_RESPONSE");
        }
      } catch (error) {
        const safe =
          error instanceof CatalogError
            ? error
            : new CatalogError("TRANSPORT_ERROR", true);
        if (!safe.retryable || attempt >= CATALOG_DEFAULTS.maxAttempts)
          throw safe;
        await this.sleep(CATALOG_DEFAULTS.retryDelayMs);
      }
    }
  }
}
