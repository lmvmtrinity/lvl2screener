import { describe, expect, it } from "vitest";
import {
  coverageReportHash,
  type ResearchCoverageReport,
} from "../src/backtests/research-coverage.js";
import {
  assertEvidenceBinding,
  type EvidenceBindingOwner,
} from "../src/backtests/research-evidence-repository.js";
import type { ResearchEvidenceBinding } from "@tsx-scanner/contracts";

const report: ResearchCoverageReport = {
  version: "research-coverage-v1",
  marketId: "CA_TSX",
  manifestHash: "d".repeat(64),
  expectedInputsHash: "e".repeat(64),
  inputHash: "c".repeat(64),
  sessionPayloadHashes: { "2026-09-09": "f".repeat(64) },
  verifiedAt: "2026-09-10T00:00:00.000Z",
  status: "VERIFIED",
  cells: [
    {
      cellId: "cell",
      status: "VERIFIED",
      validQuotes: 1,
      validWarmupBars: 1,
      maximumGapMs: 30_000,
      reasons: [],
    },
  ],
};

const owner: EvidenceBindingOwner = {
  kind: "MODEL",
  id: "10000000-0000-4000-8000-000000000010",
  marketId: "CA_TSX",
};

const binding: ResearchEvidenceBinding = {
  manifestHash: report.manifestHash,
  coverageReportHash: coverageReportHash(report),
  inputHash: report.inputHash,
  engineRevision: "a".repeat(40),
  runtimeFingerprint: "b".repeat(64),
  verifiedAt: report.verifiedAt,
};

describe("research evidence binding invariants", () => {
  it("excludes verification wall time from report identity", () => {
    expect(
      coverageReportHash({
        ...report,
        verifiedAt: "2026-09-11T00:00:00.000Z",
      }),
    ).toBe(coverageReportHash(report));
  });

  it("accepts a matching verified owner binding", () => {
    expect(() => assertEvidenceBinding(owner, report, binding)).not.toThrow();
  });

  it("rejects incomplete reports, mismatched markets and altered identities", () => {
    expect(() =>
      assertEvidenceBinding(
        owner,
        { ...report, status: "INCOMPLETE" },
        binding,
      ),
    ).toThrow("EVIDENCE_REPORT_NOT_VERIFIED");
    expect(() =>
      assertEvidenceBinding(
        { ...owner, marketId: "US_EQUITIES" },
        report,
        binding,
      ),
    ).toThrow("EVIDENCE_MARKET_MISMATCH");
    expect(() =>
      assertEvidenceBinding(owner, report, {
        ...binding,
        inputHash: "a".repeat(64),
      }),
    ).toThrow("EVIDENCE_INPUT_MISMATCH");
  });
});
