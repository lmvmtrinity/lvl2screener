import { describe, expect, it, vi } from "vitest";
import { TradingViewScannerClient } from "../src/universe/tradingview-scanner-client.js";

function createMockResponse(body: unknown, status = 200, ok = true): Response {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    json: async () => body,
  } as unknown as Response;
}

describe("TradingViewScannerClient", () => {
  it("generates correct filter payload and parses response for CA_TSX", async () => {
    let capturedUrl = "";
    let capturedBody: Record<string, unknown> | null = null;

    const mockFetch = vi.fn(async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return createMockResponse({
        totalCount: 2,
        data: [
          {
            s: "TSX:SHOP",
            d: [
              "Shopify Inc",
              "Shopify Inc Subordinate Voting",
              105.5,
              2.45,
              2.1,
              1200000,
              135000000000,
              "TSX",
              "stock",
            ],
          },
          {
            s: "TSX:BMO",
            d: [
              "Bank of Montreal",
              "Bank of Montreal Common",
              128.2,
              0.85,
              1.6,
              950000,
              92000000000,
              "TSX",
              "stock",
            ],
          },
        ],
      });
    });

    const client = new TradingViewScannerClient({
      fetchFn: mockFetch as typeof fetch,
    });
    const candidates = await client.scan("CA_TSX");

    expect(capturedUrl).toBe("https://scanner.tradingview.com/canada/scan");
    expect(capturedBody).not.toBeNull();
    const filter = capturedBody!.filter as Array<{
      left: string;
      operation: string;
      right: unknown;
    }>;

    const exchangeFilter = filter.find((f) => f.left === "exchange");
    expect(exchangeFilter).toEqual({
      left: "exchange",
      operation: "equal",
      right: "TSX",
    });

    const priceFilter = filter.find((f) => f.left === "close");
    expect(priceFilter).toEqual({
      left: "close",
      operation: "in_range",
      right: [5, 150],
    });

    const mcapFilter = filter.find((f) => f.left === "market_cap_basic");
    expect(mcapFilter).toEqual({
      left: "market_cap_basic",
      operation: "greater",
      right: 400_000_000,
    });

    const rvolFilter = filter.find(
      (f) => f.left === "relative_volume_10d_calc",
    );
    expect(rvolFilter).toEqual({
      left: "relative_volume_10d_calc",
      operation: "greater",
      right: 1.5,
    });

    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toEqual({
      symbol: "SHOP",
      exchange: "TSX",
      fullSymbol: "TSX:SHOP",
      price: 105.5,
      changeFromOpenPct: 2.45,
      relativeVolume: 2.1,
      averageVolume90d: 1200000,
      marketCap: 135000000000,
      observedAt: expect.any(String),
    });
  });

  it("generates correct filter payload and parses response for US_EQUITIES", async () => {
    let capturedUrl = "";
    let capturedBody: Record<string, unknown> | null = null;

    const mockFetch = vi.fn(async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return createMockResponse({
        totalCount: 1,
        data: [
          {
            s: "NASDAQ:NVDA",
            d: [
              "NVIDIA Corporation",
              "NVIDIA Corp Common Stock",
              118.5,
              3.2,
              2.4,
              45000000,
              2900000000000,
              "NASDAQ",
              "stock",
            ],
          },
        ],
      });
    });

    const client = new TradingViewScannerClient({
      fetchFn: mockFetch as typeof fetch,
    });
    const candidates = await client.scan("US_EQUITIES");

    expect(capturedUrl).toBe("https://scanner.tradingview.com/america/scan");
    expect(capturedBody).not.toBeNull();
    const filter = capturedBody!.filter as Array<{
      left: string;
      operation: string;
      right: unknown;
    }>;

    const exchangeFilter = filter.find((f) => f.left === "exchange");
    expect(exchangeFilter).toEqual({
      left: "exchange",
      operation: "in_range",
      right: ["NYSE", "NASDAQ"],
    });

    const priceFilter = filter.find((f) => f.left === "close");
    expect(priceFilter).toEqual({
      left: "close",
      operation: "in_range",
      right: [10, 200],
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.symbol).toBe("NVDA");
    expect(candidates[0]?.exchange).toBe("NASDAQ");
  });

  it("queries top active movers for Fast Funnel accelerator", async () => {
    const mockFetch = vi.fn(async () =>
      createMockResponse({
        totalCount: 2,
        data: [
          {
            s: "TSX:CVE",
            d: [
              "Cenovus Energy Inc",
              "Cenovus Common",
              24.5,
              1.8,
              3.4,
              6000000,
              45000000000,
              "TSX",
              "stock",
            ],
          },
          {
            s: "TSX:SU",
            d: [
              "Suncor Energy Inc",
              "Suncor Common",
              51.2,
              1.1,
              2.8,
              5500000,
              68000000000,
              "TSX",
              "stock",
            ],
          },
        ],
      }),
    );

    const client = new TradingViewScannerClient({
      fetchFn: mockFetch as typeof fetch,
    });
    const movers = await client.fetchTopMovers("CA_TSX", { limit: 10 });

    expect(movers).toHaveLength(2);
    expect(movers[0]?.symbol).toBe("CVE");
    expect(movers[1]?.symbol).toBe("SU");
  });

  it("rejects a truncated scan instead of reporting partial parity evidence", async () => {
    const mockFetch = vi.fn(async () =>
      createMockResponse({
        totalCount: 250,
        data: [
          {
            s: "TSX:SHOP",
            d: [
              "Shopify Inc",
              "Shopify Inc Subordinate Voting",
              105.5,
              2.45,
              2.1,
              1200000,
              135000000000,
              "TSX",
              "stock",
            ],
          },
        ],
      }),
    );

    const client = new TradingViewScannerClient({
      fetchFn: mockFetch as typeof fetch,
    });
    await expect(client.scan("CA_TSX")).rejects.toThrow(
      "TradingView scan returned 1 of 250 matching symbols",
    );
  });

  it("rejects a malformed response instead of treating it as an empty screen", async () => {
    const client = new TradingViewScannerClient({
      fetchFn: vi.fn(async () => createMockResponse({})) as typeof fetch,
    });

    await expect(client.scan("CA_TSX")).rejects.toThrow(
      "TradingView scanner returned malformed response",
    );
  });

  it("rejects malformed rows instead of silently dropping parity candidates", async () => {
    const client = new TradingViewScannerClient({
      fetchFn: vi.fn(async () =>
        createMockResponse({
          totalCount: 1,
          data: [{ s: "TSX:SHOP", d: [] }],
        }),
      ) as typeof fetch,
    });

    await expect(client.scan("CA_TSX")).rejects.toThrow(
      "TradingView scanner returned malformed response",
    );
  });

  it("keeps a well-formed empty scan distinct from a malformed response", async () => {
    const client = new TradingViewScannerClient({
      fetchFn: vi.fn(async () =>
        createMockResponse({ totalCount: 0, data: [] }),
      ) as typeof fetch,
    });

    await expect(client.scan("CA_TSX")).resolves.toEqual([]);
  });

  it("handles HTTP error status codes gracefully", async () => {
    const mockFetch = vi.fn(async () =>
      createMockResponse({ error: "Rate limit exceeded" }, 429, false),
    );

    const client = new TradingViewScannerClient({
      fetchFn: mockFetch as typeof fetch,
    });
    await expect(client.scan("CA_TSX")).rejects.toThrow(
      "TradingView scanner returned HTTP 429",
    );
  });

  it("handles malformed JSON responses gracefully", async () => {
    const mockFetch = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => {
            throw new Error("Invalid JSON");
          },
        }) as unknown as Response,
    );

    const client = new TradingViewScannerClient({
      fetchFn: mockFetch as typeof fetch,
    });
    await expect(client.scan("CA_TSX")).rejects.toThrow(
      "TradingView scanner returned malformed JSON",
    );
  });
});
