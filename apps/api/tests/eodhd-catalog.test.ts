import { describe, expect, it, vi } from "vitest";
import {
  CATALOG_DEFAULTS,
  EodhdCatalogClient,
  parseEodhdCatalog,
  type CatalogSnapshot,
  type CatalogSnapshotStore,
} from "../src/universe/eodhd-catalog.js";

// Synthetic contract fixtures, not captured provider/entitlement evidence.
const row = (
  Code = "QBR.B",
  Exchange = "TSX",
  Currency = "CAD",
  Type = "Common Stock",
) => ({ Code, Name: `Example ${Code}`, Exchange, Currency, Type, Isin: null });

function harness() {
  const snapshots = new Map<string, CatalogSnapshot>();
  const store: CatalogSnapshotStore = {
    loadLatest: async (market) => snapshots.get(market) ?? null,
    save: vi.fn(async (snapshot) => {
      snapshots.set(snapshot.marketId, snapshot);
    }),
  };
  const fetcher = vi.fn<typeof fetch>();
  const sleep = vi.fn(async (_ms: number) => {});
  let now = new Date("2026-09-08T12:00:00Z");
  const client = new EodhdCatalogClient(
    "secret-fixture-token",
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

describe("EODHD catalog boundary", () => {
  it("recognizes EODHD TO while preserving currency and market isolation", () => {
    expect(
      parseEodhdCatalog([row("TEST", "TO")], "CA_TSX")[0]?.reasons,
    ).toEqual([]);
    expect(
      parseEodhdCatalog([row("TEST", "TO", "USD")], "CA_TSX")[0]?.reasons,
    ).toContain("CURRENCY_NOT_ALLOWED");
    expect(
      parseEodhdCatalog([row("TEST", "TO", "USD")], "US_EQUITIES")[0]?.reasons,
    ).toContain("EXCHANGE_NOT_ALLOWED");
    expect(
      parseEodhdCatalog([row("TEST", "V")], "CA_TSX")[0]?.reasons,
    ).toContain("EXCHANGE_NOT_ALLOWED");
  });
  it("coalesces failed concurrent refreshes without multiplying retry spend", async () => {
    const h = harness();
    h.fetcher.mockRejectedValue(new Error("network failure"));
    const results = await Promise.all([
      h.client.refresh("CA_TSX", "2026-09-08"),
      h.client.refresh("CA_TSX", "2026-09-08"),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(h.fetcher).toHaveBeenCalledTimes(2);
  });

  it("aborts stalled provider requests and bounds timeout retries", async () => {
    vi.useFakeTimers();
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation((ms) => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), ms);
        return controller.signal;
      });
    try {
      const h = harness();
      h.fetcher.mockImplementation(
        async (_url, options) =>
          new Promise((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () =>
              reject(new Error("timeout")),
            );
          }),
      );
      const result = h.client.refresh("CA_TSX", "2026-09-08");
      await vi.runAllTimersAsync();
      expect(await result).toMatchObject({
        status: "UNAVAILABLE",
        failure: "TRANSPORT_ERROR",
      });
      expect(timeout).toHaveBeenCalledWith(10_000);
      expect(h.fetcher).toHaveBeenCalledTimes(2);
    } finally {
      timeout.mockRestore();
      vi.useRealTimers();
    }
  });

  it("preserves share-class codes and does not infer broker resolution", () => {
    expect(parseEodhdCatalog([row()], "CA_TSX")[0]).toMatchObject({
      providerCode: "QBR.B",
      resolutionStatus: "PENDING",
      reasons: [],
    });
  });

  it.each([
    ["TSXV", "CAD", "Common Stock", "EXCHANGE_NOT_ALLOWED"],
    ["TSX", "USD", "Common Stock", "CURRENCY_NOT_ALLOWED"],
    ["TSX", "CAD", "ETF", "CLASSIFICATION_REVIEW_REQUIRED"],
    ["TSX", "CAD", "Preferred Stock", "CLASSIFICATION_REVIEW_REQUIRED"],
    ["TSX", "CAD", "ADR", "CLASSIFICATION_REVIEW_REQUIRED"],
    ["TSX", "CAD", "Trust", "CLASSIFICATION_REVIEW_REQUIRED"],
    ["TSX", "CAD", "Warrant", "CLASSIFICATION_REVIEW_REQUIRED"],
  ])(
    "keeps excluded %s/%s/%s rows with reasons",
    (exchange, currency, type, reason) => {
      expect(
        parseEodhdCatalog([row("X", exchange, currency, type)], "CA_TSX")[0]
          ?.reasons,
      ).toContain(reason);
    },
  );

  it("admits only NYSE/NASDAQ USD rows for US and preserves cross listings", () => {
    const members = parseEodhdCatalog(
      [
        row("X", "NYSE", "USD"),
        row("X", "NASDAQ", "USD"),
        row("Y", "NYSE ARCA", "USD"),
        row("Z", "NYSE American", "USD"),
        row("A", "OTC", "USD"),
        row("B"),
      ],
      "US_EQUITIES",
    );
    expect(members.filter((item) => item.reasons.length === 0)).toHaveLength(2);
    expect(
      members
        .slice(2)
        .every((item) => item.reasons.includes("EXCHANGE_NOT_ALLOWED")),
    ).toBe(true);
  });

  it.each([{}, [], [row(), { Code: "incomplete" }], [row(), row()]])(
    "rejects empty/malformed/duplicate snapshots as a whole",
    (payload) => {
      expect(() => parseEodhdCatalog(payload, "CA_TSX")).toThrow(
        /EODHD catalog/,
      );
    },
  );

  it("coalesces successful concurrent refreshes and uses only the fixed provider origin", async () => {
    const h = harness();
    h.fetcher.mockResolvedValue(Response.json([row()]));
    const results = await Promise.all([
      h.client.refresh("CA_TSX", "2026-09-08"),
      h.client.refresh("CA_TSX", "2026-09-08"),
    ]);
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    expect(results[0]).toEqual(results[1]);
    const [url, options] = h.fetcher.mock.calls[0]!;
    expect(String(url)).toContain(
      "https://eodhd.com/api/exchange-symbol-list/TO?",
    );
    expect(String(url)).toContain("type=common_stock");
    expect(options?.redirect).toBe("error");
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  });

  it("isolates the two market caches", async () => {
    const h = harness();
    h.fetcher
      .mockResolvedValueOnce(Response.json([row()]))
      .mockResolvedValueOnce(Response.json([row("AAPL", "NASDAQ", "USD")]));
    await h.client.refresh("CA_TSX", "2026-09-08");
    const us = await h.client.refresh("US_EQUITIES", "2026-09-08");
    expect(us.snapshot?.members[0]?.providerCode).toBe("AAPL");
    expect(h.snapshots.size).toBe(2);
  });

  it("retries transient failures twice at most and never exposes transport errors", async () => {
    const h = harness();
    h.fetcher.mockRejectedValue(
      new Error("https://example/?api_token=secret-fixture-token"),
    );
    const result = await h.client.refresh("CA_TSX", "2026-09-08");
    expect(result).toMatchObject({
      status: "UNAVAILABLE",
      failure: "TRANSPORT_ERROR",
      snapshot: null,
    });
    expect(JSON.stringify(result)).not.toContain("secret-fixture-token");
    expect(h.fetcher).toHaveBeenCalledTimes(2);
    expect(h.sleep).toHaveBeenCalledWith(1000);
  });

  it.each([401, 403, 422, 429])("does not retry HTTP %s", async (status) => {
    const h = harness();
    h.fetcher.mockResolvedValue(new Response("private body", { status }));
    expect(await h.client.refresh("CA_TSX", "2026-09-08")).toMatchObject({
      failure: "HTTP_ERROR",
    });
    expect(h.fetcher).toHaveBeenCalledTimes(1);
  });

  it("recovers after a server error", async () => {
    const h = harness();
    h.fetcher
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(Response.json([row()]));
    expect((await h.client.refresh("CA_TSX", "2026-09-08")).status).toBe(
      "FRESH",
    );
    expect(h.fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed JSON without retry or cache replacement", async () => {
    const h = harness();
    h.fetcher.mockResolvedValueOnce(Response.json([row()]));
    const first = await h.client.refresh("CA_TSX", "2026-09-08");
    h.setTime("2026-09-09T12:00:00Z");
    h.fetcher.mockResolvedValueOnce(new Response("not json"));
    expect(await h.client.refresh("CA_TSX", "2026-09-09")).toMatchObject({
      status: "LAST_GOOD",
      snapshot: first.snapshot,
      failure: "INVALID_RESPONSE",
    });
    expect(h.store.save).toHaveBeenCalledTimes(1);
  });

  it.each([3, 4])(
    "enforces the 20 percent catalog drop boundary (%s retained of 5)",
    async (remaining) => {
      const h = harness();
      const rows = Array.from({ length: 5 }, (_, i) => row(String(i)));
      h.fetcher.mockResolvedValueOnce(Response.json(rows));
      await h.client.refresh("CA_TSX", "2026-09-08");
      h.setTime("2026-09-09T12:00:00Z");
      h.fetcher.mockResolvedValueOnce(Response.json(rows.slice(0, remaining)));
      expect((await h.client.refresh("CA_TSX", "2026-09-09")).status).toBe(
        remaining === 3 ? "LAST_GOOD" : "FRESH",
      );
    },
  );

  it("detects admitted coverage loss even with unchanged total row count", async () => {
    const h = harness();
    h.fetcher.mockResolvedValueOnce(Response.json([row("A"), row("B")]));
    await h.client.refresh("CA_TSX", "2026-09-08");
    h.setTime("2026-09-09T12:00:00Z");
    h.fetcher.mockResolvedValueOnce(
      Response.json([row("A"), row("B", "unknown")]),
    );
    expect(await h.client.refresh("CA_TSX", "2026-09-09")).toMatchObject({
      failure: "CATALOG_DROP",
    });
  });

  it.each([0, 1])(
    "only permits last-good through 96 hours inclusive (+%s ms)",
    async (extra) => {
      const h = harness();
      h.fetcher.mockResolvedValueOnce(Response.json([row()]));
      await h.client.refresh("CA_TSX", "2026-09-08");
      h.setTime(
        new Date(
          Date.parse("2026-09-08T12:00:00Z") +
            CATALOG_DEFAULTS.maxAgeMs +
            extra,
        ).toISOString(),
      );
      h.fetcher.mockResolvedValue(Response.json([]));
      const result = await h.client.refresh("CA_TSX", "2026-09-12");
      expect(result.status).toBe(extra === 0 ? "LAST_GOOD" : "UNAVAILABLE");
      expect(h.snapshots.size).toBe(1);
      if (extra) expect(result.snapshot).toBeNull();
    },
  );

  it("produces the same digest for reordered provider rows", async () => {
    const h = harness();
    h.fetcher.mockResolvedValueOnce(Response.json([row("B"), row("A")]));
    const first = await h.client.refresh("CA_TSX", "2026-09-08");
    h.setTime("2026-09-09T12:00:00Z");
    h.fetcher.mockResolvedValueOnce(Response.json([row("A"), row("B")]));
    expect(
      (await h.client.refresh("CA_TSX", "2026-09-09")).snapshot?.digest,
    ).toBe(first.snapshot?.digest);
  });

  it("surfaces storage failures and rejects backwards refreshes", async () => {
    const h = harness();
    h.fetcher.mockResolvedValueOnce(Response.json([row()]));
    await h.client.refresh("CA_TSX", "2026-09-08");
    await expect(h.client.refresh("CA_TSX", "2026-09-07")).rejects.toThrow(
      "ownership/date conflict",
    );
    vi.mocked(h.store.save).mockRejectedValueOnce(
      new Error("storage unavailable"),
    );
    h.setTime("2026-09-09T12:00:00Z");
    h.fetcher.mockResolvedValueOnce(Response.json([row()]));
    await expect(h.client.refresh("CA_TSX", "2026-09-09")).rejects.toThrow(
      "storage unavailable",
    );
  });
});
