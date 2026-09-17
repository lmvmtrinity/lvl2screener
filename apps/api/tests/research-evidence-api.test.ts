import { describe, expect, it } from "vitest";
import type { ResearchCoverageReport } from "@tsx-scanner/contracts";
import { buildApp, type ResearchEvidenceApi } from "../src/app.js";
import type { DependencyProbe } from "../src/foundation/probes.js";
import { FoundationStatusService } from "../src/foundation/status-service.js";

const probe: DependencyProbe = { check: async () => ({ status: "ok" }) };
const status = () =>
  new FoundationStatusService({
    database: probe,
    scanner: probe,
    marketData: probe,
  });
const hash = "a".repeat(64);
const report: ResearchCoverageReport = {
  version: "research-coverage-v1",
  marketId: "CA_TSX",
  manifestHash: "b".repeat(64),
  expectedInputsHash: "c".repeat(64),
  inputHash: "d".repeat(64),
  sessionPayloadHashes: { "2026-09-09": "e".repeat(64) },
  verifiedAt: "2026-09-10T00:00:00.000Z",
  status: "UNKNOWN",
  cells: [],
};

class FakeResearchEvidence implements ResearchEvidenceApi {
  async saveManifest(): Promise<string> {
    return report.manifestHash;
  }
  async getManifest(): Promise<null> {
    return null;
  }
  async saveReport(): Promise<string> {
    return hash;
  }
  async getReport(): Promise<ResearchCoverageReport | null> {
    return report;
  }
  async bind(): Promise<void> {}
  async getBinding(): Promise<null> {
    return null;
  }
}

describe("research evidence API", () => {
  it("returns a persisted report only in the requested market scope", async () => {
    const app = await buildApp({
      statusService: status(),
      researchEvidenceService: new FakeResearchEvidence(),
    });
    const ok = await app.inject({
      method: "GET",
      url: `/api/research-evidence/${hash}?marketId=CA_TSX`,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual(report);
    const otherMarket = await app.inject({
      method: "GET",
      url: `/api/research-evidence/${hash}?marketId=US_EQUITIES`,
    });
    expect(otherMarket.statusCode).toBe(404);
    await app.close();
  });

  it("rejects invalid hashes and aggregation mutation scope", async () => {
    const app = await buildApp({
      statusService: status(),
      researchEvidenceService: new FakeResearchEvidence(),
    });
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/research-evidence/not-a-hash?marketId=CA_TSX",
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/research-evidence/${hash}?marketId=ALL`,
        })
      ).statusCode,
    ).toBe(400);
    await app.close();
  });
});
