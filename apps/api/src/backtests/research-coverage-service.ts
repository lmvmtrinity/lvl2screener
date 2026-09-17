import {
  expectedInputCellSchema,
  researchCoverageReportSchema,
  type ResearchCoverageReport,
} from "@tsx-scanner/contracts";
import { contentHash, evaluateCoverage } from "./research-coverage.js";
import type {
  CoverageReadOptions,
  CoverageRequest,
  ResearchCoverageSource,
} from "./research-coverage-source.js";

export class ResearchCoverageService {
  constructor(
    private readonly source: ResearchCoverageSource,
    private readonly now: () => Date,
  ) {}

  async verify(request: CoverageRequest): Promise<ResearchCoverageReport> {
    return (await this.verifyInputs(request)).report;
  }

  async verifyInputs(
    request: CoverageRequest,
    options?: CoverageReadOptions,
  ): Promise<{
    report: ResearchCoverageReport;
    sessions: Record<string, Record<string, unknown>>;
  }> {
    validateRequest(request);
    const frozen = await this.source.readFrozenInputs(
      {
        marketId: request.marketId,
        manifestHash: request.manifestHash,
        inputCutoff: request.inputCutoff,
        sessionDates: [...request.sessionDates],
        ...(request.recipe ? { recipe: request.recipe } : {}),
      },
      options,
    );
    const expected = frozen.expected.map((value) =>
      expectedInputCellSchema.parse(value),
    );
    if (
      (expected.length === 0 &&
        Object.keys(frozen.sessionPayloadHashes).length === 0) ||
      (expected.length > 0 &&
        expected.every((cell) => cell.membership === "NOT_REQUIRED")) ||
      expected.some((cell) => cell.marketId !== request.marketId)
    ) {
      throw new Error("COVERAGE_SCOPE_MISMATCH");
    }
    const expectedDates = new Set(expected.map((cell) => cell.sessionDate));
    const requestedDates = new Set(request.sessionDates);
    if ([...expectedDates].some((date) => !requestedDates.has(date))) {
      throw new Error("COVERAGE_SESSION_SCOPE_MISMATCH");
    }
    const payloadDates = Object.keys(frozen.sessionPayloadHashes).sort();
    const requestDates = [...requestedDates].sort();
    if (
      payloadDates.length !== requestDates.length ||
      payloadDates.some((date, index) => date !== requestDates[index])
    ) {
      throw new Error("SESSION_PAYLOAD_SCOPE_MISMATCH");
    }
    for (const hash of Object.values(frozen.sessionPayloadHashes)) {
      if (!/^[a-f0-9]{64}$/.test(hash))
        throw new Error("INVALID_SESSION_PAYLOAD_HASH");
    }

    const cells = evaluateCoverage(expected, frozen.receipts);
    for (const date of requestedDates)
      if (!expectedDates.has(date))
        cells.push({
          cellId: `${date}:SCOPE_UNAVAILABLE`,
          status: "UNKNOWN",
          validQuotes: 0,
          validWarmupBars: 0,
          maximumGapMs: null,
          reasons: ["EXPECTED_MEMBERSHIP_UNAVAILABLE"],
        });
    const report: ResearchCoverageReport = {
      version: "research-coverage-v2",
      marketId: request.marketId,
      manifestHash: request.manifestHash,
      expectedInputsHash: contentHash(
        [...expected].sort((a, b) => a.cellId.localeCompare(b.cellId)),
      ),
      inputHash: contentHash({
        receipts: [...frozen.receipts].sort((a, b) =>
          a.cellId.localeCompare(b.cellId),
        ),
        sessionPayloadHashes: Object.fromEntries(
          Object.entries(frozen.sessionPayloadHashes).sort(([a], [b]) =>
            a.localeCompare(b),
          ),
        ),
      }),
      sessionPayloadHashes: Object.fromEntries(
        Object.entries(frozen.sessionPayloadHashes).sort(([a], [b]) =>
          a.localeCompare(b),
        ),
      ),
      verifiedAt: this.now().toISOString(),
      cells,
      status: cells.some((cell) => cell.status === "UNKNOWN")
        ? "UNKNOWN"
        : cells.some((cell) => cell.status === "INCOMPLETE")
          ? "INCOMPLETE"
          : "VERIFIED",
    };
    return {
      report: researchCoverageReportSchema.parse(report),
      sessions: frozen.sessionPayloads ?? {},
    };
  }
}

function validateRequest(request: CoverageRequest): void {
  if (!/^[a-f0-9]{64}$/.test(request.manifestHash))
    throw new Error("INVALID_MANIFEST_HASH");
  if (!Number.isFinite(Date.parse(request.inputCutoff)))
    throw new Error("INVALID_INPUT_CUTOFF");
  if (request.sessionDates.length === 0)
    throw new Error("EMPTY_COVERAGE_SCOPE");
  const dates = new Set<string>();
  for (const date of request.sessionDates) {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      Number.isNaN(Date.parse(`${date}T00:00:00Z`))
    )
      throw new Error("INVALID_SESSION_DATE");
    if (dates.has(date)) throw new Error("DUPLICATE_SESSION_DATE");
    dates.add(date);
  }
}

export type {
  CoverageRequest,
  ResearchCoverageSource,
} from "./research-coverage-source.js";
