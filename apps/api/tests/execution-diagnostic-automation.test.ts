import { describe, expect, it, vi } from "vitest";
import { ExecutionDiagnosticAutomation } from "../src/paper-bot/execution-diagnostic-automation.js";
import type { EvidenceAutomationWorkRecord } from "../src/statistical-models/evidence-automation-repository.js";

describe("execution diagnostics automation", () => {
  it("dispatches completed snapshots once and reuses the evidence-work identity", async () => {
    const records: EvidenceAutomationWorkRecord[] = [];
    const evidence = {
      list: vi.fn(async () => records),
      recordWithClient: vi.fn(
        async (
          _client: unknown,
          identity: EvidenceAutomationWorkRecord["identity"],
          receipt: NonNullable<EvidenceAutomationWorkRecord["receipt"]>,
        ) => {
          records.push({
            workKey: receipt.workKey,
            identity,
            jobId: receipt.jobId,
            receipt,
          });
        },
      ),
    };
    const createStrictJob = vi.fn(async () => ({
      id: "10000000-0000-4000-8000-000000000971",
    }));
    const jobs = { withClient: () => ({ createStrictJob }) };
    const sourceRow = {
      sourceRevision: "revision",
      runId: "10000000-0000-4000-8000-000000000972",
      accountId: "10000000-0000-4000-8000-000000000973",
      marketId: "CA_TSX",
      currency: "CAD",
      boundaryAt: new Date("2026-09-10T20:00:00.000Z"),
    };
    const pool = {
      connect: async () => ({
        query: async (text: unknown) =>
          String(text).includes('"sourceRevision"')
            ? { rows: [sourceRow] }
            : { rows: [] },
        release: () => undefined,
      }),
      query: vi.fn(async () => ({ rows: [{ runId: sourceRow.runId }] })),
    };
    const automation = new ExecutionDiagnosticAutomation(
      pool as never,
      evidence as never,
      jobs as never,
      () => new Date("2026-09-10T20:01:00.000Z"),
    );
    expect(await automation.catchUp("CA_TSX")).toBe(1);
    expect(await automation.catchUp("CA_TSX")).toBe(0);
    expect(createStrictJob).toHaveBeenCalledTimes(1);
    expect(evidence.recordWithClient).toHaveBeenCalledTimes(1);
  });
});
