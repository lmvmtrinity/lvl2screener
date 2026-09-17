import {
  sessionComparisonConfigSchema,
  sessionComparisonResultSchema,
  sessionPairSchema,
  type SessionComparisonConfig,
  type SessionComparisonResult,
  type SessionPair,
} from "@tsx-scanner/contracts";

export type { SessionComparisonConfig, SessionComparisonResult, SessionPair };

export function comparePairedSessions(
  rawRows: readonly SessionPair[],
  rawConfig: SessionComparisonConfig,
): SessionComparisonResult {
  const config = sessionComparisonConfigSchema.parse(rawConfig);
  const expected = validateExpectedSessions(config.expectedSessions);
  if (config.blockLength > expected.length)
    throw new Error("INVALID_BLOCK_LENGTH");
  if (
    (config.unit === "CAD" && config.marketId !== "CA_TSX") ||
    (config.unit === "USD" && config.marketId !== "US_EQUITIES")
  )
    throw new Error("UNIT_SCOPE_MISMATCH");

  const byDate = new Map<string, SessionPair>();
  for (const rawRow of rawRows) {
    const row = sessionPairSchema.parse(rawRow);
    if (byDate.has(row.sessionDate))
      throw new Error(`DUPLICATE_SESSION:${row.sessionDate}`);
    if (!expected.includes(row.sessionDate))
      throw new Error(`UNEXPECTED_SESSION:${row.sessionDate}`);
    if (row.baseline !== null && !Number.isFinite(row.baseline))
      throw new Error(`NONFINITE_SESSION_VALUE:${row.sessionDate}`);
    if (row.challenger !== null && !Number.isFinite(row.challenger))
      throw new Error(`NONFINITE_SESSION_VALUE:${row.sessionDate}`);
    byDate.set(row.sessionDate, row);
  }

  const method = {
    kind: "CIRCULAR_MOVING_BLOCK_BOOTSTRAP" as const,
    blockLength: config.blockLength,
    bootstrapSamples: config.bootstrapSamples,
    seed: config.seed,
  };
  const base = {
    version: "paired-session-v1" as const,
    unit: config.unit,
    basis: "MEAN_PAIRED_SESSION_DIFFERENCE" as const,
    expectedSessions: expected.length,
    observedSessions: byDate.size,
    confidenceLevel: 0.95 as const,
    method,
  };

  const missing = expected.filter((date) => !byDate.has(date));
  const unverified = expected.filter((date) => {
    const row = byDate.get(date);
    return row?.coverage === "MISSING";
  });
  const nullValues = expected.filter((date) => {
    const row = byDate.get(date);
    return (
      row !== undefined && (row.baseline === null || row.challenger === null)
    );
  });
  if (missing.length > 0 || unverified.length > 0 || nullValues.length > 0) {
    return result({
      ...base,
      status: "UNVERIFIED",
      estimate: null,
      lower: null,
      upper: null,
      reasonCodes: [
        ...(missing.length > 0 ? ["MISSING_SESSION"] : []),
        ...(unverified.length > 0 ? ["COVERAGE_UNVERIFIED"] : []),
        ...(nullValues.length > 0 ? ["SESSION_VALUE_MISSING"] : []),
      ],
    });
  }

  if (byDate.size < config.minimumSessions) {
    return result({
      ...base,
      status: "INSUFFICIENT",
      estimate: null,
      lower: null,
      upper: null,
      reasonCodes: ["MINIMUM_SESSIONS_NOT_MET"],
    });
  }

  const differences = expected.map((date) => {
    const row = byDate.get(date)!;
    return row.challenger! - row.baseline!;
  });
  let state = config.seed >>> 0;
  const next = () => {
    state = (Math.imul(1_664_525, state) + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
  const estimates: number[] = [];
  for (let sample = 0; sample < config.bootstrapSamples; sample++) {
    let sum = 0;
    let count = 0;
    while (count < differences.length) {
      const start = Math.floor(next() * differences.length);
      for (
        let offset = 0;
        offset < config.blockLength && count < differences.length;
        offset++, count++
      ) {
        sum += differences[(start + offset) % differences.length]!;
      }
    }
    estimates.push(sum / differences.length);
  }
  estimates.sort((left, right) => left - right);
  const percentile = (probability: number) =>
    estimates[Math.floor((estimates.length - 1) * probability)]!;
  const estimate =
    differences.reduce((total, value) => total + value, 0) / differences.length;
  return result({
    ...base,
    status: "AVAILABLE",
    estimate,
    lower: percentile(0.025),
    upper: percentile(0.975),
    reasonCodes: [],
  });
}

function validateExpectedSessions(
  sessions: readonly string[],
): readonly string[] {
  const sorted = [...sessions].sort();
  if (new Set(sessions).size !== sessions.length)
    throw new Error("DUPLICATE_EXPECTED_SESSION");
  if (sessions.some((date, index) => date !== sorted[index]))
    throw new Error("EXPECTED_SESSIONS_NOT_SORTED");
  return sessions;
}

function result(
  value: Omit<
    SessionComparisonResult,
    "version" | "basis" | "confidenceLevel"
  > & {
    version: "paired-session-v1";
    basis: "MEAN_PAIRED_SESSION_DIFFERENCE";
    confidenceLevel: 0.95;
  },
): SessionComparisonResult {
  return sessionComparisonResultSchema.parse(value);
}
