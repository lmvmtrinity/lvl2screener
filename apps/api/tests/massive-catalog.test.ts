import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  MassiveCatalogClient,
  normalizeMassiveTickers,
  parseMassiveCatalog,
} from "../src/universe/massive-catalog.js";
import { validatedSnapshot } from "../src/universe/postgres-discovery-provider-store.js";
import {
  parseEodhdCatalog,
  type CatalogSnapshot,
  type CatalogSnapshotStore,
} from "../src/universe/eodhd-catalog.js";

// Synthetic contract fixtures, not captured provider/entitlement evidence.
const ticker = (overrides: Record<string, unknown> = {}) => ({
  ticker: "AAPL",
  name: "Apple Inc.",
  primary_exchange: "XNAS",
  type: "CS",
  currency_name: "usd",
  cik: "0000320193",
  composite_figi: "BBG000B9XRY4",
  share_class_figi: "BBG001S5N8V8",
  ...overrides,
});

const retention = {
  retrievedAt: "2026-09-08T12:00:00.000Z",
  responseDigest: "a".repeat(64),
};

function harness() {
  const snapshots = new Map<string, CatalogSnapshot>();
  const store: CatalogSnapshotStore = {
    loadLatest: async (market) => snapshots.get(market) ?? null,
    save: vi.fn(async (snapshot) => {
      snapshots.set(snapshot.marketId, snapshot);
    }),
    recordFailure: vi.fn(async () => {}),
  };
  const fetcher = vi.fn<typeof fetch>();
  const sleep = vi.fn(async (_ms: number) => {});
  let now = new Date("2026-09-08T12:00:00Z");
  const client = new MassiveCatalogClient(
    "secret-fixture-key",
    store,
    fetcher,
    () => now,
    sleep,
  );
  return {
    client,
    store,
    fetcher,
    sleep,
    snapshots,
    setTime: (value: string) => {
      now = new Date(value);
    },
  };
}

const page = (
  results: Array<Record<string, unknown>>,
  next: string | null = null,
) => Response.json({ status: "OK", results, next_url: next });

describe("Massive US catalog boundary", () => {
  it("retains original provider evidence and derives the common-stock label", () => {
    const rows = normalizeMassiveTickers([ticker()], retention);
    expect(rows[0]).toMatchObject({
      Code: "AAPL",
      Exchange: "XNAS",
      Currency: "USD",
      Type: "Common Stock",
      Massive: {
        providerTicker: "AAPL",
        providerType: "CS",
        exchangeMic: "XNAS",
        currency: "USD",
        cik: "0000320193",
        compositeFigi: "BBG000B9XRY4",
        shareClassFigi: "BBG001S5N8V8",
        retrievedAt: "2026-09-08T12:00:00.000Z",
        responseDigest: "a".repeat(64),
      },
    });
    expect(parseMassiveCatalog(rows, "US_EQUITIES")[0]?.reasons).toEqual([]);
  });

  it("keeps non-CS types, unknown exchanges and wrong currencies visible", () => {
    const rows = normalizeMassiveTickers(
      [
        ticker({ ticker: "ETF1", type: "ETF" }),
        ticker({ ticker: "OTC1", primary_exchange: "OTC" }),
        ticker({ ticker: "EUR1", currency_name: "eur" }),
        ticker({ ticker: "UNK1", primary_exchange: null }),
      ],
      retention,
    );
    const members = parseMassiveCatalog(rows, "US_EQUITIES");
    expect(
      members.find((member) => member.providerCode === "ETF1")?.reasons,
    ).toContain("CLASSIFICATION_REVIEW_REQUIRED");
    expect(
      members.find((member) => member.providerCode === "OTC1")?.reasons,
    ).toContain("EXCHANGE_NOT_ALLOWED");
    expect(
      members.find((member) => member.providerCode === "EUR1")?.reasons,
    ).toContain("CURRENCY_NOT_ALLOWED");
    const unknown = members.find((member) => member.providerCode === "UNK1");
    expect(unknown?.raw).toMatchObject({
      Exchange: "UNKNOWN",
      Currency: "USD",
    });
    expect(unknown?.raw.Massive?.exchangeMic).toBeNull();
    expect(unknown?.reasons).toContain("EXCHANGE_NOT_ALLOWED");
  });

  it("follows every pagination link with free-tier pacing and the fixed provider origin", async () => {
    const h = harness();
    const nextUrl =
      "https://api.polygon.io/v3/reference/tickers?cursor=cursor-1";
    h.fetcher
      .mockResolvedValueOnce(page([ticker({ ticker: "AAPL" })], nextUrl))
      .mockResolvedValueOnce(page([ticker({ ticker: "MSFT" })]));
    const result = await h.client.refresh("US_EQUITIES", "2026-09-08");
    expect(result.status).toBe("FRESH");
    expect(result.snapshot).toMatchObject({
      source: "MASSIVE",
      rowCount: 2,
      admittedCount: 2,
    });
    expect(result.snapshot?.providerDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(h.fetcher).toHaveBeenCalledTimes(2);
    expect(String(h.fetcher.mock.calls[1]?.[0])).toBe(nextUrl);
    expect(h.sleep).toHaveBeenCalledWith(12_000);
    const [firstUrl, options] = h.fetcher.mock.calls[0]!;
    expect(String(firstUrl)).toContain(
      "https://api.polygon.io/v3/reference/tickers?",
    );
    expect(String(firstUrl)).toContain("type=CS");
    expect(options?.redirect).toBe("error");
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect((options?.headers as Record<string, string>).Authorization).toBe(
      "Bearer secret-fixture-key",
    );
    expect(JSON.stringify(result)).not.toContain("secret-fixture-key");
  });

  it("does not publish a partial catalog when a later page fails", async () => {
    const h = harness();
    h.fetcher
      .mockResolvedValueOnce(
        page(
          [ticker()],
          "https://api.polygon.io/v3/reference/tickers?cursor=next",
        ),
      )
      .mockResolvedValue(new Response("", { status: 500 }));
    const result = await h.client.refresh("US_EQUITIES", "2026-09-08");
    expect(result).toMatchObject({
      status: "UNAVAILABLE",
      snapshot: null,
      failure: "HTTP_ERROR",
    });
    expect(h.store.save).not.toHaveBeenCalled();
    expect(h.store.recordFailure).toHaveBeenCalledWith(
      "US_EQUITIES",
      "2026-09-08",
      "HTTP_ERROR",
      null,
    );
  });

  it("aborts on an out-of-origin pagination link without publishing", async () => {
    const h = harness();
    h.fetcher.mockResolvedValueOnce(
      page([ticker()], "https://attacker.example/tickers?cursor=1"),
    );
    expect(await h.client.refresh("US_EQUITIES", "2026-09-08")).toMatchObject({
      status: "UNAVAILABLE",
      snapshot: null,
      failure: "INVALID_RESPONSE",
    });
    expect(h.store.save).not.toHaveBeenCalled();
  });

  it("rejects duplicate identities across pages", async () => {
    const h = harness();
    h.fetcher
      .mockResolvedValueOnce(
        page(
          [ticker({ ticker: "AAPL" })],
          "https://api.polygon.io/v3/reference/tickers?cursor=next",
        ),
      )
      .mockResolvedValueOnce(page([ticker({ ticker: "AAPL" })]));
    expect(await h.client.refresh("US_EQUITIES", "2026-09-08")).toMatchObject({
      status: "UNAVAILABLE",
      failure: "DUPLICATE_IDENTITY",
    });
    expect(h.store.save).not.toHaveBeenCalled();
  });

  it("retries throttling with bounded pacing before publishing", async () => {
    const h = harness();
    h.fetcher
      .mockResolvedValueOnce(new Response("", { status: 429 }))
      .mockResolvedValueOnce(page([ticker()]));
    expect((await h.client.refresh("US_EQUITIES", "2026-09-08")).status).toBe(
      "FRESH",
    );
    expect(h.fetcher).toHaveBeenCalledTimes(2);
    expect(h.sleep).toHaveBeenCalledWith(12_000);
  });

  it("never reuses or falls back to another provider's snapshot", async () => {
    const h = harness();
    const eodhd: CatalogSnapshot = {
      source: "EODHD",
      marketId: "US_EQUITIES",
      tradingDate: "2026-09-08",
      fetchedAt: "2026-09-08T11:00:00.000Z",
      digest: "b".repeat(64),
      providerDigest: null,
      rowCount: 1,
      admittedCount: 1,
      members: [],
    };
    h.snapshots.set("US_EQUITIES", eodhd);
    h.fetcher.mockRejectedValue(new Error("provider unavailable"));
    expect(await h.client.refresh("US_EQUITIES", "2026-09-08")).toMatchObject({
      status: "UNAVAILABLE",
      snapshot: null,
      failure: "TRANSPORT_ERROR",
    });
    h.fetcher.mockResolvedValue(page([ticker()]));
    const switched = await h.client.refresh("US_EQUITIES", "2026-09-08");
    expect(switched).toMatchObject({ status: "FRESH" });
    expect(switched.snapshot?.source).toBe("MASSIVE");
    expect(h.store.save).toHaveBeenCalledTimes(1);
  });

  it("validates a persisted Massive snapshot and rejects digest drift", () => {
    const members = parseMassiveCatalog(
      normalizeMassiveTickers([ticker()], retention),
      "US_EQUITIES",
    );
    const snapshot: CatalogSnapshot = {
      source: "MASSIVE",
      marketId: "US_EQUITIES",
      tradingDate: "2026-09-08",
      fetchedAt: retention.retrievedAt,
      digest: createHash("sha256")
        .update(JSON.stringify(members))
        .digest("hex"),
      providerDigest: retention.responseDigest,
      rowCount: 1,
      admittedCount: 1,
      members,
    };
    expect(
      validatedSnapshot(snapshot).members[0]?.raw.Massive?.providerTicker,
    ).toBe("AAPL");
    expect(() =>
      validatedSnapshot({ ...snapshot, providerDigest: "f".repeat(64) }),
    ).toThrow("provider digest mismatch");
    const eodhdMembers = parseEodhdCatalog(
      [
        {
          Code: "X",
          Name: "Legacy",
          Exchange: "TSX",
          Currency: "CAD",
          Type: "Common Stock",
        },
      ],
      "CA_TSX",
    );
    const legacy = {
      source: "EODHD" as const,
      marketId: "CA_TSX" as const,
      tradingDate: "2026-09-08",
      fetchedAt: retention.retrievedAt,
      digest: createHash("sha256")
        .update(JSON.stringify(eodhdMembers))
        .digest("hex"),
      rowCount: 1,
      admittedCount: 1,
      members: eodhdMembers,
    };
    expect(validatedSnapshot(legacy).providerDigest).toBeNull();
  });
});
