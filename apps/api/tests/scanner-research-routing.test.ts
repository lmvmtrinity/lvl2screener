import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScannerFeatureClient } from "../src/market-data/scanner-client.js";

const livePayload = JSON.parse(
  readFileSync(
    new URL(
      "../../../contracts/fixtures/engine-result-batch.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

afterEach(() => vi.unstubAllGlobals());

describe("scanner research routing", () => {
  it("keeps live and prediction calls on the live scanner and sends research work to the research scanner", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: URL) => {
      urls.push(url.toString());
      return new Response(
        JSON.stringify(
          url.pathname.endsWith("quotes/batch") ? livePayload : {},
        ),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });
    const client = new ScannerFeatureClient(
      new URL("http://live-scanner:8000"),
      10_000,
      "test-token",
      new URL("http://research-scanner:8000"),
    );
    await client.ingestQuotes([], [], "CA_TSX");
    await client.researchRuntimeIdentity();
    await client.predictStatistical({}).catch(() => undefined);
    await client.predictFundedExecution({}).catch(() => undefined);
    await client.trainStatistical({}).catch(() => undefined);
    await client.trainFundedExecution({}).catch(() => undefined);
    expect(urls).toEqual([
      "http://live-scanner:8000/internal/v1/quotes/batch",
      "http://research-scanner:8000/internal/v1/system/runtime-identity",
      "http://live-scanner:8000/internal/v1/statistical-models/predict",
      "http://live-scanner:8000/internal/v1/funded-execution-models/predict",
      "http://research-scanner:8000/internal/v1/statistical-models/train",
      "http://research-scanner:8000/internal/v1/funded-execution-models/train",
    ]);
  });
});
