import { describe, expect, it, vi } from "vitest";
import {
  LiveQuestradeTransport,
  QuestradeHttpError,
} from "../src/questrade/live-transport.js";

function json(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("LiveQuestradeTransport", () => {
  it("never discards a rotated token because a market-budget observer fails", async () => {
    const observer = vi.fn(async () => {
      throw new Error("budget unavailable");
    });
    const transport = new LiveQuestradeTransport(
      vi.fn(async () =>
        json({
          access_token: "access",
          refresh_token: "rotated",
          token_type: "Bearer",
          expires_in: 1800,
          api_server: "https://api01.iq.questrade.com/v1/",
        }),
      ),
      observer,
    );
    expect(
      (await transport.redeemRefreshToken("synthetic")).refresh_token,
    ).toBe("rotated");
    expect(observer).not.toHaveBeenCalled();
  });
  it("awaits durable 429 observation before returning the provider failure", async () => {
    const observed: number[] = [];
    const transport = new LiveQuestradeTransport(
      vi.fn(async () => json({}, { status: 429 })),
      async (_headers, status) => {
        await Promise.resolve();
        observed.push(status!);
      },
    );
    await expect(
      transport.searchSymbols(
        new URL("https://api01.iq.questrade.com/v1/"),
        "synthetic",
        "X",
      ),
    ).rejects.toMatchObject({ status: 429 });
    expect(observed).toEqual([429]);
  });
  it("redeems the manual refresh token using a form POST", async () => {
    const fetchMock = vi.fn(async () =>
      json({
        access_token: "access-1",
        refresh_token: "refresh-2",
        token_type: "Bearer",
        expires_in: 1_800,
        api_server: "https://api01.iq.questrade.com/v1",
      }),
    ) as unknown as typeof fetch;
    const transport = new LiveQuestradeTransport(fetchMock);

    const grant = await transport.redeemRefreshToken("refresh-1+/=");

    expect(grant.refresh_token).toBe("refresh-2");
    const [url, init] = vi.mocked(fetchMock).mock.calls[0]!;
    expect(String(url)).toBe("https://login.questrade.com/oauth2/token");
    expect(init?.method).toBe("POST");
    expect(String(init?.body)).toContain("refresh_token=refresh-1%2B%2F%3D");
  });

  it("uses the dynamic v1 API server for live market-data calls", async () => {
    const urls: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("symbols/search"))
        return json({
          symbol: [
            {
              symbol: "TD.TO",
              symbolId: 123,
              description: "TORONTO-DOMINION BANK",
              securityType: "Stock",
              listingExchange: "TSX",
              isQuotable: true,
              isTradable: true,
              currency: "CAD",
            },
          ],
        });
      if (url.includes("/symbols?"))
        return json({
          symbols: [
            {
              symbol: "TD.TO",
              symbolId: 123,
              marketCap: 150_000_000_000,
              industrySector: "Financial Services",
            },
          ],
        });
      if (url.includes("markets/quotes"))
        return json({
          quotes: [
            {
              symbol: "TD.TO",
              symbolId: 123,
              bidPrice: 100,
              bidSize: 10,
              askPrice: 100.01,
              askSize: 12,
              lastTradePrice: 100,
              lastTradeSize: 2,
              volume: 1_000,
              openPrice: 99,
              highPrice: 101,
              lowPrice: 98,
              delay: 0,
              isHalted: false,
            },
          ],
        });
      if (url.includes("markets/candles"))
        return json({
          candles: [
            {
              start: "2026-08-27T13:30:00.000Z",
              end: "2026-08-27T13:31:00.000Z",
              open: 99,
              high: 100,
              low: 98,
              close: 100,
              volume: 100,
            },
          ],
        });
      return json({
        markets: [
          {
            name: "TSX",
            tradingVenues: ["TSX"],
            defaultTradingVenue: "AUTO",
            startTime: "2026-08-27T13:30:00.000Z",
            endTime: "2026-08-27T20:00:00.000Z",
            snapQuotesLimit: 99_999,
          },
        ],
      });
    }) as unknown as typeof fetch;
    const transport = new LiveQuestradeTransport(fetchMock);
    // Questrade token responses are documented both with and without /v1.
    const server = new URL("https://api01.iq.questrade.com");

    expect(
      (await transport.searchSymbols(server, "access", "TD.TO"))[0]?.symbolId,
    ).toBe(123);
    expect(
      (await transport.getSymbolDetails(server, "access", [123]))[0]?.marketCap,
    ).toBe(150_000_000_000);
    const quotes = await transport.getQuotes(server, "access", [123]);
    expect(quotes).toHaveLength(1);
    expect(
      await transport.getCandles(server, "access", 123, "OneMinute", {
        startTime: new Date("2026-08-27T13:30:00Z"),
        endTime: new Date("2026-08-27T13:31:00Z"),
      }),
    ).toHaveLength(1);
    expect((await transport.getMarkets(server, "access"))[0]).toMatchObject({
      extendedStartTime: "2026-08-27T13:30:00.000Z",
      extendedEndTime: "2026-08-27T20:00:00.000Z",
      currency: "CAD",
    });
    expect(
      urls.every((url) => url.startsWith("https://api01.iq.questrade.com/v1/")),
    ).toBe(true);
  });

  it("never forwards bearer tokens to an untrusted dynamic server", async () => {
    const fetchMock = vi.fn() as unknown as typeof fetch;
    const transport = new LiveQuestradeTransport(fetchMock);
    await expect(
      transport.getMarkets(new URL("https://example.com/v1"), "access"),
    ).rejects.toThrow("untrusted");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("drops an unavailable null-price quote without rejecting valid batch peers", async () => {
    const fetchMock = vi.fn(async () =>
      json({
        quotes: [
          {
            symbol: "TD.TO",
            symbolId: 123,
            bidPrice: 100,
            bidSize: 10,
            askPrice: 100.01,
            askSize: 12,
            lastTradePrice: 100,
            lastTradeSize: 2,
            lastTradeTime: "2026-08-27T09:59:59.123456-04:00",
            volume: 1_000,
            openPrice: 99,
            highPrice: 101,
            lowPrice: 98,
            delay: 0,
            isHalted: false,
          },
          {
            symbol: "NOQUOTE.TO",
            symbolId: 456,
            bidPrice: null,
            bidSize: 0,
            askPrice: null,
            askSize: 0,
            lastTradePrice: null,
            lastTradeSize: 0,
            volume: 0,
            openPrice: null,
            highPrice: null,
            lowPrice: null,
            delay: 0,
            isHalted: false,
          },
        ],
      }),
    ) as unknown as typeof fetch;
    const transport = new LiveQuestradeTransport(fetchMock);

    const quotes = await transport.getQuotes(
      new URL("https://api01.iq.questrade.com/v1"),
      "access",
      [123, 456],
    );

    expect(quotes).toHaveLength(1);
    expect(quotes[0]?.symbol).toBe("TD.TO");
    expect(quotes[0]?.lastTradeTime).toBe("2026-08-27T09:59:59.123456-04:00");
  });

  it("returns a typed HTTP error without including response secrets", async () => {
    const fetchMock = vi.fn(async () =>
      json({ access_token: "should-not-leak" }, { status: 401 }),
    ) as unknown as typeof fetch;
    const transport = new LiveQuestradeTransport(fetchMock);
    const failure = transport.redeemRefreshToken("secret-refresh-token");
    await expect(failure).rejects.toBeInstanceOf(QuestradeHttpError);
    await expect(failure).rejects.not.toThrow(
      /secret-refresh-token|should-not-leak/,
    );
  });
});
