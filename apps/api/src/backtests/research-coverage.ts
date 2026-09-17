import { createHash } from "node:crypto";
import {
  coverageCellResultSchema,
  expectedInputCellSchema,
  retainedInputReceiptSchema,
  type CoverageCellResult,
  type ExpectedInputCell,
  type ResearchCoverageReport,
  type RetainedInputReceipt,
} from "@tsx-scanner/contracts";

export type {
  CoverageCellResult,
  ExpectedInputCell,
  ResearchCoverageReport,
  RetainedInputReceipt,
};

const UNKNOWN_PROVENANCE_REASONS = new Set([
  "AVAILABILITY_UNPROVEN",
  "ADJUSTMENT_UNPROVEN",
  "SOURCE_REVISION_UNAVAILABLE",
]);

/** Stable JSON for evidence identities. Object keys are sorted recursively while arrays retain
 * their order because chronology and provider record order are part of the input contract. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function contentHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** A coverage scope whose retained evidence exceeds the bounded materialization
 * limit. Deterministic and non-retryable: the worker maps it to VALIDATION so an
 * over-scoped request fails visibly instead of retrying and burning CPU. */
export class CoverageInputLimitError extends Error {
  constructor(
    readonly retainedRecords: number,
    readonly limit: number,
  ) {
    super(`COVERAGE_INPUT_TOO_LARGE:${retainedRecords}>${limit}`);
    this.name = "CoverageInputLimitError";
  }
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime()))
      throw new Error("UNSUPPORTED_CANONICAL_VALUE");
    return value.toISOString();
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("UNSUPPORTED_CANONICAL_VALUE");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => {
          const child = record[key];
          if (child === undefined)
            throw new Error("UNSUPPORTED_CANONICAL_VALUE");
          return [key, canonicalValue(child)];
        }),
    );
  }
  throw new Error("UNSUPPORTED_CANONICAL_VALUE");
}

export function evaluateCoverage(
  rawExpected: readonly ExpectedInputCell[],
  rawReceipts: readonly RetainedInputReceipt[],
): CoverageCellResult[] {
  const expected = rawExpected.map((value) =>
    expectedInputCellSchema.parse(value),
  );
  const receipts = rawReceipts.map((value) =>
    retainedInputReceiptSchema.parse(value),
  );
  const receiptByCell = new Map<string, RetainedInputReceipt>();
  for (const receipt of receipts) {
    if (receiptByCell.has(receipt.cellId))
      throw new Error(`DUPLICATE_RECEIPT:${receipt.cellId}`);
    receiptByCell.set(receipt.cellId, receipt);
  }

  return expected.map((cell) => {
    const receipt = receiptByCell.get(cell.cellId);
    const reasons = new Set<string>();
    const base = {
      cellId: cell.cellId,
      validQuotes: 0,
      validWarmupBars: 0,
      maximumGapMs: null as number | null,
      reasons,
    };

    if (!cell.membershipSourceHash) reasons.add("MEMBERSHIP_UNPROVEN");
    if (!cell.calendarSourceHash) reasons.add("CALENDAR_UNPROVEN");
    if (cell.membership === "UNKNOWN") reasons.add("MEMBERSHIP_UNPROVEN");
    const windowStart = Date.parse(cell.windowStart);
    const windowEnd = Date.parse(cell.windowEnd);
    const warmupWindowStart = Date.parse(cell.warmupWindowStart);
    const warmupBefore = Date.parse(cell.warmupBefore);
    if (
      ![windowStart, windowEnd, warmupWindowStart, warmupBefore].every(
        Number.isFinite,
      ) ||
      windowEnd <= windowStart ||
      warmupBefore <= warmupWindowStart
    )
      throw new Error(`INVALID_COVERAGE_WINDOW:${cell.cellId}`);
    if (cell.membership === "NOT_REQUIRED" && reasons.size === 0)
      return coverageCellResultSchema.parse({
        cellId: cell.cellId,
        status: "NOT_REQUIRED",
        validQuotes: 0,
        validWarmupBars: 0,
        maximumGapMs: null,
        reasons: [],
      });
    if (!receipt) {
      reasons.add("QUOTE_MISSING");
      return result(
        base,
        reasons.has("MEMBERSHIP_UNPROVEN") || reasons.has("CALENDAR_UNPROVEN")
          ? "UNKNOWN"
          : "INCOMPLETE",
      );
    }
    if (receipt.warmupTimeframe !== cell.warmupTimeframe)
      throw new Error(`WARMUP_STREAM_MISMATCH:${cell.cellId}`);
    for (const reason of receipt.provenanceReasons) {
      if (reason !== "NO_TRADE_INTERVAL_PROVED") reasons.add(reason);
    }
    if (
      receipt.provenance === "UNKNOWN" ||
      receipt.provenanceReasons.some((reason) =>
        UNKNOWN_PROVENANCE_REASONS.has(reason),
      )
    ) {
      if (
        receipt.provenance === "UNKNOWN" &&
        receipt.provenanceReasons.length === 0
      )
        reasons.add("AVAILABILITY_UNPROVEN");
    }

    const start = windowStart;
    const end = windowEnd;
    const parsedQuotes = receipt.quoteTimes.map(Date.parse);
    const quoteTimes = [...new Set(parsedQuotes)]
      .filter((time) => Number.isFinite(time) && time >= start && time <= end)
      .sort((a, b) => a - b);
    if (parsedQuotes.some((time) => !Number.isFinite(time)))
      reasons.add("INVALID_RETAINED_INPUT");
    base.validQuotes = quoteTimes.length;
    const boundaries = [start, ...quoteTimes, end];
    base.maximumGapMs = Math.max(
      ...boundaries.slice(1).map((time, index) => time - boundaries[index]!),
    );
    if (base.validQuotes === 0) reasons.add("QUOTE_MISSING");
    if (
      base.maximumGapMs > cell.maxQuoteGapMs &&
      !receipt.provenanceReasons.includes("NO_TRADE_INTERVAL_PROVED")
    )
      reasons.add("QUOTE_GAP");
    if (receipt.invalidQuoteCount > 0 || receipt.invalidWarmupBarCount > 0)
      reasons.add("INVALID_RETAINED_INPUT");

    const parsedWarmup = receipt.warmupBarTimes.map(Date.parse);
    const uniqueWarmup = new Set(
      parsedWarmup.filter(
        (time) =>
          Number.isFinite(time) &&
          time >= warmupWindowStart &&
          time < warmupBefore,
      ),
    );
    base.validWarmupBars = uniqueWarmup.size;
    if (parsedWarmup.some((time) => !Number.isFinite(time)))
      reasons.add("INVALID_RETAINED_INPUT");
    if (uniqueWarmup.size < cell.requiredWarmupBars)
      reasons.add("WARMUP_SHORTFALL");
    if (uniqueWarmup.size !== receipt.warmupBarTimes.length)
      reasons.add("INVALID_RETAINED_INPUT");

    const unknown =
      cell.membership === "UNKNOWN" ||
      !cell.membershipSourceHash ||
      !cell.calendarSourceHash ||
      receipt.provenance === "UNKNOWN" ||
      receipt.provenanceReasons.some((reason) =>
        UNKNOWN_PROVENANCE_REASONS.has(reason),
      );
    return result(
      base,
      unknown ? "UNKNOWN" : reasons.size > 0 ? "INCOMPLETE" : "VERIFIED",
    );
  });
}

function result(
  base: {
    cellId: string;
    validQuotes: number;
    validWarmupBars: number;
    maximumGapMs: number | null;
    reasons: Set<string>;
  },
  status: CoverageCellResult["status"],
): CoverageCellResult {
  return coverageCellResultSchema.parse({
    cellId: base.cellId,
    status,
    validQuotes: base.validQuotes,
    validWarmupBars: base.validWarmupBars,
    maximumGapMs: base.maximumGapMs,
    reasons: [...base.reasons].sort(),
  });
}

export function coverageReportHash(report: ResearchCoverageReport): string {
  const { verifiedAt: _verifiedAt, ...content } = report;
  return contentHash(content);
}
