import {
  sampledExcursionSchema,
  type SampledExcursion,
} from "@tsx-scanner/contracts";

export type ExcursionInput = {
  entryAt: string;
  exitAt: string;
  entryPrice: number;
  lotCount: number;
  coverageVerified: boolean;
  /** True when replay excluded invalid quotes for this instrument. */
  exclusionsPresent?: boolean;
  marks: readonly {
    timestamp: string;
    bid: number;
    admissible: boolean;
  }[];
};

export function sampledExcursion(input: ExcursionInput): SampledExcursion {
  const base = {
    basis: "SAMPLED_EXECUTABLE_BID_SINGLE_LOT" as const,
    adversePct: null,
    favorablePct: null,
    samples: 0,
  };
  const reasons: string[] = [];
  const start = Date.parse(input.entryAt);
  const end = Date.parse(input.exitAt);
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    end <= start ||
    !Number.isFinite(input.entryPrice) ||
    input.entryPrice <= 0
  )
    reasons.push("INVALID_INTERVAL");
  if (input.lotCount !== 1) reasons.push("MULTI_LOT_UNSUPPORTED");
  if (input.exclusionsPresent) reasons.push("INPUT_EXCLUSIONS_PRESENT");
  if (reasons.length > 0)
    return unavailable({
      ...base,
      reasonCodes: input.coverageVerified
        ? reasons
        : [...reasons, "COVERAGE_UNVERIFIED"],
    });

  const byTimestamp = new Map<string, number>();
  let conflicting = false;
  for (const mark of input.marks) {
    const at = Date.parse(mark.timestamp);
    if (!mark.admissible || !Number.isFinite(at)) continue;
    if (!Number.isFinite(mark.bid) || mark.bid <= 0) continue;
    if (at <= start || at >= end) continue;
    const prior = byTimestamp.get(mark.timestamp);
    if (prior !== undefined && prior !== mark.bid) conflicting = true;
    byTimestamp.set(mark.timestamp, mark.bid);
  }
  if (conflicting)
    return unavailable({
      ...base,
      reasonCodes: withCoverage(
        ["CONFLICTING_SAME_TIME_MARKS"],
        input.coverageVerified,
      ),
    });
  const changes = [...byTimestamp.values()].map(
    (bid) => (bid / input.entryPrice - 1) * 100,
  );
  if (changes.length === 0)
    return unavailable({
      ...base,
      reasonCodes: withCoverage(
        ["NO_INTERIOR_SAMPLES"],
        input.coverageVerified,
      ),
    });
  // Unverified coverage still yields the observed excursion as a diagnostic,
  // labelled INDICATIVE so it can never be mistaken for verified evidence.
  return sampledExcursionSchema.parse({
    ...base,
    status: input.coverageVerified ? "AVAILABLE" : "INDICATIVE",
    adversePct: Math.min(0, ...changes),
    favorablePct: Math.max(0, ...changes),
    samples: changes.length,
    reasonCodes: input.coverageVerified ? [] : ["COVERAGE_UNVERIFIED"],
  });
}

function withCoverage(reasons: string[], coverageVerified: boolean): string[] {
  return coverageVerified ? reasons : [...reasons, "COVERAGE_UNVERIFIED"];
}

function unavailable(
  value: Omit<SampledExcursion, "status">,
): SampledExcursion {
  return sampledExcursionSchema.parse({
    ...value,
    status: "UNAVAILABLE",
  });
}

export type { SampledExcursion } from "@tsx-scanner/contracts";
