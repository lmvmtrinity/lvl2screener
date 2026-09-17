import { describe, expect, it, vi } from "vitest";
import type { ExecutionDiagnosticResponse } from "@tsx-scanner/contracts";
import { buildApp, type FundedReportingApi } from "../src/app.js";
import { FoundationStatusService } from "../src/foundation/status-service.js";
import type { DependencyProbe } from "../src/foundation/probes.js";
import { FundedReportingService } from "../src/paper-bot/funded-reporting-service.js";
import { ExecutionDiagnosticsRepository } from "../src/paper-bot/execution-diagnostics-repository.js";
import { ExecutionDiagnosticReportRepository } from "../src/paper-bot/execution-diagnostic-report-repository.js";

const probe: DependencyProbe = { check: async () => ({ status: "ok" }) };
const status = () =>
  new FoundationStatusService({
    database: probe,
    scanner: probe,
    marketData: probe,
  });

const response: ExecutionDiagnosticResponse = {
  status: "PENDING",
  runId: "10000000-0000-4000-8000-000000000801",
  accountId: "10000000-0000-4000-8000-000000000802",
  marketId: "CA_TSX",
  currency: "CAD",
  temporalScope: "RUN_END",
  asOf: "2026-09-10T20:00:00.000Z",
  reportId: null,
  jobId: "10000000-0000-4000-8000-000000000803",
  reportVersion: "execution-diagnostics-v1",
  sourceDigest: null,
  generatedAt: null,
  report: null,
  reason: "DIAGNOSTICS_JOB_PENDING",
};

describe("execution diagnostics API", () => {
  it("requires corrected report and job versions on the real read service", async () => {
    const describe = vi
      .spyOn(ExecutionDiagnosticsRepository.prototype, "describe")
      .mockResolvedValue({
        runId: response.runId,
        accountId: response.accountId,
        marketId: "CA_TSX",
        currency: "CAD",
        temporalScope: "RUN_END",
        asOf: response.asOf,
        runIds: [response.runId],
      });
    const reports = vi
      .spyOn(ExecutionDiagnosticReportRepository.prototype, "findLatest")
      .mockResolvedValue(undefined);
    const jobs = vi
      .spyOn(
        ExecutionDiagnosticReportRepository.prototype,
        "findDiagnosticsJob",
      )
      .mockResolvedValue(undefined);
    try {
      const result = await new FundedReportingService(
        {} as never,
      ).getExecutionDiagnostics(response.runId, {
        mode: "RUN_END",
        marketId: "CA_TSX",
      });
      expect(reports).toHaveBeenCalledWith(
        response.runId,
        "RUN_END",
        response.asOf,
        "execution-diagnostics-v2",
      );
      expect(jobs).toHaveBeenCalledWith(
        response.runId,
        "execution-diagnostics-v2",
      );
      expect(result.reportVersion).toBe("execution-diagnostics-v2");
    } finally {
      describe.mockRestore();
      reports.mockRestore();
      jobs.mockRestore();
    }
  });
  it("accepts an explicit market and returns pending without a write path", async () => {
    const getExecutionDiagnostics = vi.fn(async () => response);
    const service: FundedReportingApi = {
      getExecutionDiagnostics,
      performanceCurve: vi.fn(),
      journal: vi.fn(),
    };
    const app = await buildApp({
      statusService: status(),
      fundedReportingService: service,
    });
    const result = await app.inject({
      method: "GET",
      url: `/api/paper-bot/runs/${response.runId}/execution-diagnostics?marketId=CA_TSX&mode=RUN_END`,
    });
    expect(result.statusCode).toBe(200);
    expect(result.json().status).toBe("PENDING");
    expect(getExecutionDiagnostics).toHaveBeenCalledWith(response.runId, {
      marketId: "CA_TSX",
      mode: "RUN_END",
    });
    await app.close();
  });

  it("rejects missing and contradictory time parameters before calling the service", async () => {
    const getExecutionDiagnostics = vi.fn(async () => response);
    const app = await buildApp({
      statusService: status(),
      fundedReportingService: {
        getExecutionDiagnostics,
        performanceCurve: vi.fn(),
        journal: vi.fn(),
      },
    });
    const missingAsOf = await app.inject({
      method: "GET",
      url: `/api/paper-bot/runs/${response.runId}/execution-diagnostics?marketId=CA_TSX&mode=AS_OF`,
    });
    const contradictory = await app.inject({
      method: "GET",
      url: `/api/paper-bot/runs/${response.runId}/execution-diagnostics?marketId=CA_TSX&mode=RUN_END&asOf=2026-09-10T20%3A00%3A00.000Z`,
    });
    expect(missingAsOf.statusCode).toBe(400);
    expect(contradictory.statusCode).toBe(400);
    expect(getExecutionDiagnostics).not.toHaveBeenCalled();
    await app.close();
  });
});
