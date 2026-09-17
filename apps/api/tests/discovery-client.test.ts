import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discoveryEvaluationInputSchema,
  type DiscoveryEvaluationInput,
  type DiscoveryEvaluationResult,
} from "@tsx-scanner/contracts";
import { ScannerFeatureClient } from "../src/market-data/scanner-client.js";

const fixtures: {
  input: DiscoveryEvaluationInput;
  result: DiscoveryEvaluationResult;
}[] = JSON.parse(
  readFileSync(
    new URL(
      "../../../contracts/fixtures/discovery-evaluation-v1.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
afterEach(() => vi.unstubAllGlobals());
describe("discovery scanner client", () => {
  it.each(fixtures)(
    "round trips $input.marketId with internal authentication",
    async ({ input, result }) => {
      const fetcher = vi.fn().mockResolvedValue(Response.json(result));
      vi.stubGlobal("fetch", fetcher);
      const client = new ScannerFeatureClient(
        new URL("http://scanner:8000"),
        1000,
        "fixture-token",
      );
      expect(
        await client.evaluateDiscovery(
          discoveryEvaluationInputSchema.parse(input),
        ),
      ).toEqual(result);
      const [url, options] = fetcher.mock.calls[0]!;
      expect(url.pathname).toBe("/internal/v1/discovery/evaluate");
      expect(options.headers["x-scanner-token"]).toBe("fixture-token");
      expect(options.signal).toBeInstanceOf(AbortSignal);
      expect(JSON.parse(options.body)).toEqual(input);
    },
  );
  it.each([
    { symbolId: 999 },
    { providerCode: "OTHER" },
    { providerExchange: "NYSE" },
  ])("rejects mismatched result identity %j", async (change) => {
    const { input, result } = fixtures[0]!;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ ...result, ...change })),
    );
    await expect(
      new ScannerFeatureClient(
        new URL("http://scanner:8000"),
      ).evaluateDiscovery(input),
    ).rejects.toThrow("ownership mismatch");
  });
  it("surfaces scanner failures without a manufactured screening result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 })),
    );
    await expect(
      new ScannerFeatureClient(
        new URL("http://scanner:8000"),
      ).evaluateDiscovery(fixtures[0]!.input),
    ).rejects.toThrow();
  });
});
