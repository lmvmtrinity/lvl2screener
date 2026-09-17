import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScannerFeatureClient } from "../src/market-data/scanner-client.js";

const signalResult = {
  events: [],
  contexts: [],
  dataQuality: {
    quoteSnapshots: 0,
    candles: 0,
    sessions: 0,
    spread: "UNAVAILABLE",
    warnings: [],
  },
};

describe("scanner client long-running replay transport", () => {
  let server: Server | undefined;

  afterEach(async () => {
    vi.unstubAllGlobals();
    if (server) {
      const running = server;
      await new Promise<void>((resolve) => running.close(() => resolve()));
      server = undefined;
    }
  });

  it("does not use fetch for replay requests that may exceed the header timeout", async () => {
    server = createServer((_request, response) => {
      setTimeout(() => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(signalResult));
      }, 150);
    });
    await new Promise<void>((resolve) =>
      server!.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as AddressInfo).port;
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const client = new ScannerFeatureClient(
      new URL(`http://127.0.0.1:${port}`),
      10_000,
      "long-request-token",
    );
    const result = await client.runBacktestSignals({ sessions: [] });

    expect(result.events).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces a non-2xx replay response without falling back to fetch", async () => {
    server = createServer((_request, response) => {
      response.writeHead(422, { "content-type": "application/json" });
      response.end(JSON.stringify({ detail: "rejected" }));
    });
    await new Promise<void>((resolve) =>
      server!.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as AddressInfo).port;

    const client = new ScannerFeatureClient(
      new URL(`http://127.0.0.1:${port}`),
      10_000,
    );
    await expect(client.runBacktestSignals({ sessions: [] })).rejects.toThrow(
      "returned HTTP 422: rejected",
    );
  });
});
