import { describe, expect, it } from "vitest";
import type { LearningDashboardApi } from "../src/api-types.js";
import { buildApp } from "../src/app.js";
import { FoundationStatusService } from "../src/foundation/status-service.js";
import type { DependencyProbe } from "../src/foundation/probes.js";
import type { EvidenceAutomationStage } from "@tsx-scanner/contracts";

const probe: DependencyProbe = { check: async () => ({ status: "ok" }) };
const status = () =>
  new FoundationStatusService({
    database: probe,
    scanner: probe,
    marketData: probe,
  });
const stage: EvidenceAutomationStage = {
  key: "COVERAGE",
  marketId: "CA_TSX",
  scopeId: "CA_TSX:test",
  state: "UNKNOWN",
  asOf: "2026-09-10T00:00:00.000Z",
  lastAttemptAt: null,
  lastSuccessAt: null,
  nextCheckAt: null,
  progress: null,
  reasonCodes: ["NO_DURABLE_HISTORY"],
  nextAction: { kind: "AUTOMATIC", label: "Awaiting the next evidence check" },
  jobId: null,
  reportId: null,
};

const learning: LearningDashboardApi = {
  async overview() {
    throw new Error("unused");
  },
  async automationRuns() {
    return [];
  },
  async evidenceAutomation(marketId) {
    return [{ ...stage, marketId }];
  },
};

describe("evidence automation API", () => {
  it("returns market-scoped stages and rejects ALL", async () => {
    const app = await buildApp({
      statusService: status(),
      learningDashboardService: learning,
    });
    const ok = await app.inject({
      method: "GET",
      url: "/api/learning/evidence-automation?marketId=US_EQUITIES",
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().stages[0].marketId).toBe("US_EQUITIES");
    const all = await app.inject({
      method: "GET",
      url: "/api/learning/evidence-automation?marketId=ALL",
    });
    expect(all.statusCode).toBe(400);
    await app.close();
  });

  it("serializes persisted progress and retained UNKNOWN scopes", async () => {
    const app = await buildApp({
      statusService: status(),
      learningDashboardService: {
        ...learning,
        async evidenceAutomation(marketId) {
          return [
            {
              ...stage,
              marketId,
              state: "RUNNING",
              jobId: "10000000-0000-4000-8000-000000000980",
              progress: { completed: 3, total: 10, unit: "sessions" },
              relatedScopes: [
                {
                  scopeId: "retained-unknown",
                  state: "UNKNOWN",
                  lastAttemptAt: "2026-09-13T17:00:00.000Z",
                  progress: null,
                  reasonCodes: ["COVERAGE_UNKNOWN"],
                  jobId: null,
                  reportId: "b".repeat(64),
                },
              ],
            },
          ];
        },
      },
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/learning/evidence-automation?marketId=CA_TSX",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().stages[0]).toMatchObject({
      state: "RUNNING",
      progress: { completed: 3, total: 10, unit: "sessions" },
      relatedScopes: [
        {
          scopeId: "retained-unknown",
          state: "UNKNOWN",
          reportId: "b".repeat(64),
        },
      ],
    });
    await app.close();
  });
});
