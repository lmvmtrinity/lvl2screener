import { afterEach, describe, expect, it, vi } from "vitest";
import { ScannerFeatureClient } from "../src/market-data/scanner-client.js";

describe("scanner client error details", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("surfaces the scanner detail for a normal request", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({ detail: "Invalid quote values for XCD.TO" }),
          {
            status: 400,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new ScannerFeatureClient(new URL("http://scanner:8000"));

    await expect(client.researchRuntimeIdentity()).rejects.toThrow(
      "Scanner /internal/v1/system/runtime-identity returned HTTP 400: Invalid quote values for XCD.TO",
    );
  });
});
