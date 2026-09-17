import { describe, expect, it } from "vitest";
import type {
  ResearchCoverageReport,
  ResearchEvidenceBinding,
  ResearchOwner,
} from "@tsx-scanner/contracts";
import { ResearchCoverageService } from "../src/backtests/research-coverage-service.js";
import {
  assertEvidenceBinding,
  type ResearchEvidenceStore,
} from "../src/backtests/research-evidence-repository.js";
import { coverageReportHash } from "../src/backtests/research-coverage.js";
import { coverageFixture } from "./research-coverage-fixtures.js";

class FakeEvidenceStore implements ResearchEvidenceStore {
  manifests = new Map<
    string,
    { hash: string; marketId: "CA_TSX" | "US_EQUITIES"; manifest: unknown }
  >();
  reports = new Map<string, ResearchCoverageReport>();
  bindings = new Map<string, ResearchEvidenceBinding>();

  async saveManifest(record: {
    hash: string;
    marketId: "CA_TSX" | "US_EQUITIES";
    manifest: unknown;
  }) {
    const existing = this.manifests.get(record.hash);
    if (existing && JSON.stringify(existing) !== JSON.stringify(record))
      throw new Error("EVIDENCE_MANIFEST_CONFLICT");
    this.manifests.set(record.hash, record);
    return record.hash;
  }
  async getManifest(hash: string) {
    return this.manifests.get(hash) ?? null;
  }
  async saveReport(report: ResearchCoverageReport) {
    const hash = coverageReportHash(report);
    const existing = this.reports.get(hash);
    if (
      existing &&
      JSON.stringify({ ...existing, verifiedAt: undefined }) !==
        JSON.stringify({ ...report, verifiedAt: undefined })
    )
      throw new Error("EVIDENCE_REPORT_CONFLICT");
    this.reports.set(hash, existing ?? report);
    return hash;
  }
  async getReport(hash: string) {
    return this.reports.get(hash) ?? null;
  }
  async bind(owner: ResearchOwner, binding: ResearchEvidenceBinding) {
    const report = this.reports.get(binding.coverageReportHash);
    if (!report) throw new Error("EVIDENCE_REPORT_NOT_FOUND");
    const existing = this.bindings.get(`${owner.kind}:${owner.id}`);
    if (existing && JSON.stringify(existing) !== JSON.stringify(binding))
      throw new Error("EVIDENCE_BINDING_CONFLICT");
    assertEvidenceBinding(owner, report, binding);
    this.bindings.set(`${owner.kind}:${owner.id}`, binding);
  }
  async getBinding(owner: ResearchOwner) {
    return this.bindings.get(`${owner.kind}:${owner.id}`) ?? null;
  }
}

describe("research evidence lineage workflow", () => {
  it("does not bind an incomplete member and carries complete evidence unchanged", async () => {
    const { cell, receipt } = coverageFixture();
    const request = {
      marketId: "CA_TSX" as const,
      manifestHash: "d".repeat(64),
      inputCutoff: "2026-09-09T21:00:00.000Z",
      sessionDates: [cell.sessionDate],
    };
    const incomplete = await new ResearchCoverageService(
      {
        readFrozenInputs: async () => ({
          expected: [cell, { ...cell, cellId: "second-member" }],
          receipts: [receipt],
          sessionPayloadHashes: { [cell.sessionDate]: "e".repeat(64) },
        }),
      },
      () => new Date("2026-09-10T00:00:00.000Z"),
    ).verify(request);
    expect(incomplete.status).toBe("INCOMPLETE");

    const evidence = new FakeEvidenceStore();
    const owner: ResearchOwner = {
      kind: "MODEL",
      id: "10000000-0000-4000-8000-000000000010",
      marketId: "CA_TSX",
    };
    await evidence.saveManifest({
      hash: request.manifestHash,
      marketId: request.marketId,
      manifest: { plan: { expectedSessions: [cell.sessionDate] } },
    });
    const incompleteHash = await evidence.saveReport(incomplete);
    await expect(
      evidence.bind(owner, {
        manifestHash: request.manifestHash,
        coverageReportHash: incompleteHash,
        inputHash: incomplete.inputHash,
        engineRevision: "a".repeat(40),
        runtimeFingerprint: "b".repeat(64),
        verifiedAt: incomplete.verifiedAt,
      }),
    ).rejects.toThrow("EVIDENCE_REPORT_NOT_VERIFIED");

    const complete = await new ResearchCoverageService(
      {
        readFrozenInputs: async () => ({
          expected: [cell, { ...cell, cellId: "second-member" }],
          receipts: [receipt, { ...receipt, cellId: "second-member" }],
          sessionPayloadHashes: { [cell.sessionDate]: "f".repeat(64) },
        }),
      },
      () => new Date("2026-09-10T00:00:00.000Z"),
    ).verify(request);
    expect(complete.status).toBe("VERIFIED");
    const completeHash = await evidence.saveReport(complete);
    const binding: ResearchEvidenceBinding = {
      manifestHash: request.manifestHash,
      coverageReportHash: completeHash,
      inputHash: complete.inputHash,
      engineRevision: "a".repeat(40),
      runtimeFingerprint: "b".repeat(64),
      verifiedAt: complete.verifiedAt,
    };
    await evidence.bind(owner, binding);
    expect(await evidence.getBinding(owner)).toEqual(binding);
    expect((await evidence.getReport(incompleteHash))?.status).toBe(
      "INCOMPLETE",
    );
    expect(completeHash).toBe(coverageReportHash(complete));
  });
});
