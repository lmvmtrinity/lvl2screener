import { canonicalJson } from "../backtests/research-coverage.js";
import { classifyQuoteAvailability } from "./quote-execution.js";
import type {
  BookSide,
  DiagnosticFill,
  DiagnosticQuote,
  ExecutionDiagnosticEvidence,
  SnapshotReplenishmentDiagnostic,
} from "./execution-diagnostics-types.js";

const SIDES: readonly BookSide[] = ["BID", "ASK"];

type ValidQuote = DiagnosticQuote & { valid: true };
type Stretch = {
  runId: string;
  instrumentId: string;
  side: BookSide;
  rows: ValidQuote[];
};

function timestamp(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid diagnostic ${label}`);
  return parsed;
}

function sameIdentity(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function deduplicate<T>(rows: readonly T[], identity: (row: T) => string): T[] {
  const values = new Map<string, T>();
  for (const row of rows) {
    const key = identity(row);
    const prior = values.get(key);
    if (prior && !sameIdentity(prior, row))
      throw new Error("Conflicting diagnostic event identity");
    if (!prior) values.set(key, row);
  }
  return [...values.values()];
}

function sideValue(
  row: DiagnosticQuote,
  side: BookSide,
): readonly [number, number] {
  return side === "ASK"
    ? [row.quote.ask, row.quote.askSize]
    : [row.quote.bid, row.quote.bidSize];
}

function initialBudget(row: DiagnosticQuote, side: BookSide): number | null {
  return row.participation === null
    ? null
    : Math.floor(sideValue(row, side)[1] * row.participation);
}

function groupKey(row: { runId: string; instrumentId: string }): string {
  return `${row.runId}\u0000${row.instrumentId}`;
}

function sameBook(
  left: DiagnosticQuote,
  right: DiagnosticQuote,
  side: BookSide,
) {
  const [leftPrice, leftSize] = sideValue(left, side);
  const [rightPrice, rightSize] = sideValue(right, side);
  return (
    leftPrice === rightPrice &&
    leftSize === rightSize &&
    left.participation === right.participation
  );
}

function validateQuote(row: DiagnosticQuote): void {
  timestamp(row.quote.timestamp, "quote timestamp");
  timestamp(row.decisionAt, "decision timestamp");
  if (!row.runId || !row.instrumentId || !row.evidenceId)
    throw new Error("Invalid diagnostic quote identity");
  if (
    row.participation !== null &&
    (!Number.isFinite(row.participation) ||
      row.participation <= 0 ||
      row.participation > 1)
  )
    throw new Error("Invalid diagnostic participation");
  if (
    row.maxQuoteAgeSeconds !== null &&
    (!Number.isFinite(row.maxQuoteAgeSeconds) || row.maxQuoteAgeSeconds < 0)
  )
    throw new Error("Invalid diagnostic quote-age budget");
}

function validateFill(row: DiagnosticFill): void {
  timestamp(row.at, "fill timestamp");
  if (
    !row.runId ||
    !row.instrumentId ||
    !row.eventId ||
    !Number.isSafeInteger(row.eventSequence) ||
    !Number.isSafeInteger(row.shares) ||
    row.shares < 0
  )
    throw new Error("Invalid diagnostic fill");
}

function findStretchFills(
  stretch: Stretch,
  fills: readonly DiagnosticFill[],
): { total: number; later: number; unlinked: number } {
  const evidenceIds = new Set(stretch.rows.map((row) => row.evidenceId));
  const firstId = stretch.rows[0]!.evidenceId;
  let total = 0;
  let later = 0;
  let unlinked = 0;
  for (const fill of fills) {
    if (
      fill.runId !== stretch.runId ||
      fill.instrumentId !== stretch.instrumentId
    )
      continue;
    if (fill.side !== stretch.side) continue;
    if (fill.quoteEvidenceId === null) {
      unlinked += fill.shares;
      continue;
    }
    if (!evidenceIds.has(fill.quoteEvidenceId)) continue;
    total += fill.shares;
    if (fill.quoteEvidenceId !== firstId) later += fill.shares;
  }
  return { total, later, unlinked };
}

export function analyzeSnapshotReplenishment(
  evidence: ExecutionDiagnosticEvidence,
): SnapshotReplenishmentDiagnostic {
  const { scope } = evidence;
  if (
    scope.marketId === "CA_TSX"
      ? scope.currency !== "CAD"
      : scope.currency !== "USD"
  )
    throw new Error("Diagnostic market/currency mismatch");
  if (!scope.runIds.includes(scope.selectedRunId))
    throw new Error("Selected diagnostic run is outside its scope");
  timestamp(scope.asOf, "as-of timestamp");

  const quotes = deduplicate(evidence.quotes, (row) => row.evidenceId);
  const fills = deduplicate(evidence.fills, (row) => row.eventId);
  const excluded: { evidenceId: string; reason: string }[] = [];
  const unavailable = new Set(evidence.unavailable);
  const invalidTimes = new Map<string, number[]>();
  const authoritative = new Map<string, DiagnosticQuote>();
  const valid: ValidQuote[] = [];

  for (const row of quotes) {
    validateQuote(row);
    if (!scope.runIds.includes(row.runId))
      throw new Error("Diagnostic quote run is outside its scope");
    const key = `${row.runId}\u0000${row.instrumentId}\u0000${row.quote.timestamp}`;
    if (row.source === "FUNDED_FACT") authoritative.set(key, row);
  }
  for (const row of quotes) {
    const key = `${row.runId}\u0000${row.instrumentId}\u0000${row.quote.timestamp}`;
    if (row.source === "RAW_OBSERVATION") {
      const funded = authoritative.get(key);
      if (funded && sameIdentity(funded.quote, row.quote)) {
        excluded.push({
          evidenceId: row.evidenceId,
          reason: "DUPLICATE_AUTHORITATIVE_OBSERVATION",
        });
        continue;
      }
      if (!funded) {
        excluded.push({
          evidenceId: row.evidenceId,
          reason: "NOT_EXECUTED_FUNDED_QUOTE",
        });
        const key = groupKey(row);
        const times = invalidTimes.get(key) ?? [];
        times.push(timestamp(row.quote.timestamp, "quote timestamp"));
        invalidTimes.set(key, times);
        continue;
      }
    }
    if (row.maxQuoteAgeSeconds === null) {
      unavailable.add("MISSING_HISTORICAL_BUDGET");
      excluded.push({
        evidenceId: row.evidenceId,
        reason: "MISSING_HISTORICAL_BUDGET",
      });
      const key = groupKey(row);
      const times = invalidTimes.get(key) ?? [];
      times.push(timestamp(row.quote.timestamp, "quote timestamp"));
      invalidTimes.set(key, times);
      continue;
    }
    const reason = classifyQuoteAvailability(
      row.quote,
      row.decisionAt,
      row.maxQuoteAgeSeconds,
    );
    if (reason !== null) {
      excluded.push({ evidenceId: row.evidenceId, reason });
      const key = groupKey(row);
      const times = invalidTimes.get(key) ?? [];
      times.push(timestamp(row.quote.timestamp, "quote timestamp"));
      invalidTimes.set(key, times);
      continue;
    }
    valid.push({ ...row, valid: true });
  }

  for (const row of fills) {
    validateFill(row);
    if (!scope.runIds.includes(row.runId))
      throw new Error("Diagnostic fill run is outside its scope");
    if (row.linkUnknown) unavailable.add(row.linkUnknown);
  }

  const byGroup = new Map<string, DiagnosticQuote[]>();
  for (const row of valid) {
    const key = groupKey(row);
    const group = byGroup.get(key) ?? [];
    group.push(row);
    byGroup.set(key, group);
  }
  const stretches: Stretch[] = [];
  for (const rows of byGroup.values()) {
    rows.sort(
      (left, right) =>
        timestamp(left.quote.timestamp, "quote timestamp") -
          timestamp(right.quote.timestamp, "quote timestamp") ||
        (left.evidenceId < right.evidenceId
          ? -1
          : left.evidenceId > right.evidenceId
            ? 1
            : 0),
    );
    for (const side of SIDES) {
      let current: ValidQuote[] = [];
      const flush = () => {
        if (current.length >= 2)
          stretches.push({
            runId: rows[0]!.runId,
            instrumentId: rows[0]!.instrumentId,
            side,
            rows: current,
          });
        current = [];
      };
      for (const row of rows) {
        const previous = current.at(-1);
        if (
          previous &&
          timestamp(row.quote.timestamp, "quote timestamp") <=
            timestamp(previous.quote.timestamp, "quote timestamp")
        ) {
          throw new Error("Diagnostic quotes are not strictly chronological");
        }
        if (
          previous &&
          (invalidTimes.get(groupKey(row)) ?? []).some(
            (at) =>
              at > timestamp(previous.quote.timestamp, "quote timestamp") &&
              at < timestamp(row.quote.timestamp, "quote timestamp"),
          )
        )
          flush();
        if (!previous || sameBook(previous, row, side))
          current.push(row as ValidQuote);
        else {
          flush();
          current.push(row as ValidQuote);
        }
      }
      flush();
    }
  }

  const unlinkedFillShares: Record<BookSide, number> = { BID: 0, ASK: 0 };
  for (const fill of fills) {
    if (fill.quoteEvidenceId === null)
      unlinkedFillShares[fill.side] += fill.shares;
  }
  const rows = stretches.map((stretch) => {
    const first = stretch.rows[0]!;
    const linked = findStretchFills(stretch, fills);
    const budget = initialBudget(first, stretch.side);
    return {
      runId: stretch.runId,
      instrumentId: stretch.instrumentId,
      side: stretch.side,
      startAt: first.quote.timestamp,
      endAt: stretch.rows.at(-1)!.quote.timestamp,
      snapshotCount: stretch.rows.length,
      displayedShares: sideValue(first, stretch.side)[1],
      initialBudgetShares: budget,
      totalFilledShares: linked.total,
      fillsAfterFirstSnapshotShares: linked.later,
      excessOverInitialBudgetShares:
        budget === null ? null : Math.max(0, linked.total - budget),
      assessment: "REPLENISHMENT_UNVERIFIED" as const,
    };
  });

  return {
    scope,
    stretches: rows,
    excluded: excluded.sort((left, right) =>
      left.evidenceId < right.evidenceId
        ? -1
        : left.evidenceId > right.evidenceId
          ? 1
          : 0,
    ),
    unlinkedFillShares,
    unavailable: [...unavailable].sort(),
  };
}
