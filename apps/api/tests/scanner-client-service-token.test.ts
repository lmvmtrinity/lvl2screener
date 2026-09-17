import { afterEach, describe, expect, it, vi } from "vitest";
import { ScannerFeatureClient } from "../src/market-data/scanner-client.js";
import type { ScannerProfile } from "@tsx-scanner/contracts";

const profile = (id: string, marketId: "CA_TSX" | "US_EQUITIES") =>
  ({
    id,
    name: `${marketId} profile`,
    marketId,
    strategyDefinitionId: "10000000-0000-4000-8000-000000000071",
    analysisKind: "SETUP",
    strategyKey: "ORB_RETEST",
    strategyVersion: "1.0.0",
    configId: "10000000-0000-4000-8000-000000000091",
    configVersion: `${marketId}-v1`,
    parameters: {
      rvolAtTimeMin: 1.5,
      spreadHardMaxPct: 0.25,
      atrPctMin: 0,
      breakoutVolumeRatioMin: 1.5,
      retestTolerancePct: 0.15,
      scoreCutoff: 0,
      breakoutBufferPct: 0.05,
      relativeStrengthMinPct: 0.5,
      flagpoleMinAtr: 0.5,
      flagRetracementMaxPct: 50,
      setupTimeoutMinutes: 20,
      consolidationBarsMin: 3,
      consolidationRangeMaxPct: 0.75,
      flagDurationBarsMin: 1,
      flagDurationBarsMax: 2,
      flagpoleMinSlopeAtrPerBar: 0,
      volumeContractionMaxPct: 100,
    },
    enabled: true,
    qualification: "EXPLORATORY",
    qualificationReason: "test",
    displayOrder: 0,
    createdAt: "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T00:00:00.000Z",
  }) satisfies ScannerProfile;

describe("W5 scanner client internal credential", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("attaches the X-Scanner-Token header when a service token is configured", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ profiles: [] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new ScannerFeatureClient(
      new URL("http://scanner:8000"),
      10_000,
      "the-shared-secret",
    );
    await client.syncProfiles([]);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0]!;
    const headers = init?.headers as Record<string, string>;
    expect(headers["x-scanner-token"]).toBe("the-shared-secret");
  });

  it("omits the header entirely when no service token is configured", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ profiles: [] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new ScannerFeatureClient(new URL("http://scanner:8000"));
    await client.syncProfiles([]);

    const [, init] = fetchMock.mock.calls[0]!;
    const headers = init?.headers as Record<string, string>;
    expect(headers["x-scanner-token"]).toBeUndefined();
  });

  it("sends each market runtime only its own enabled profiles", () => {
    const client = new ScannerFeatureClient(new URL("http://scanner:8000"));
    client.setProfiles([
      profile("10000000-0000-4000-8000-000000000081", "CA_TSX"),
      profile("10000000-0000-4000-8000-000000000082", "US_EQUITIES"),
    ]);
    expect((client as any).profilePayload("CA_TSX")).toHaveLength(1);
    expect((client as any).profilePayload("CA_TSX")[0].marketId).toBe("CA_TSX");
    expect((client as any).profilePayload("US_EQUITIES")[0].marketId).toBe(
      "US_EQUITIES",
    );
  });
});
