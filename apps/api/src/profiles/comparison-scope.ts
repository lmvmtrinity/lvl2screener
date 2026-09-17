import { createHash } from "node:crypto";
import type { MarketId } from "@tsx-scanner/contracts";

export type ComparisonScope = {
  profileId: string;
  marketId: MarketId;
  windowHash: string | null;
  universeHash: string | null;
  featureVersion: string | null;
  executionModelVersion: string | null;
  executionAssumptionsHash: string | null;
  inputHash: string | null;
  coverageReportHash: string | null;
  coverageComplete: boolean;
};

export type ComparisonAssessment = {
  status: "CONTROLLED" | "UNCONTROLLED" | "UNVERIFIED";
  controlled: boolean;
  differences: string[];
};

const scopeKeys = [
  "marketId",
  "windowHash",
  "universeHash",
  "featureVersion",
  "executionModelVersion",
  "executionAssumptionsHash",
  "inputHash",
  "coverageReportHash",
] as const;

export function assessComparisonScopes(
  scopes: readonly ComparisonScope[],
): ComparisonAssessment {
  const differences: string[] = [];
  let missing = scopes.length < 2;

  for (const key of scopeKeys) {
    const known = scopes
      .map((scope) => scope[key])
      .filter(
        (value): value is string =>
          typeof value === "string" && value.length > 0,
      );
    if (known.length !== scopes.length) {
      missing = true;
      differences.push(`unverified ${key}`);
    }
    if (new Set(known).size > 1) differences.push(`different ${key}`);
  }

  if (scopes.some((scope) => !scope.coverageComplete)) {
    missing = true;
    differences.push("coverage incomplete or unverified");
  }

  const differs = differences.some((value) => value.startsWith("different "));
  const status = differs
    ? "UNCONTROLLED"
    : missing
      ? "UNVERIFIED"
      : "CONTROLLED";
  return { status, controlled: status === "CONTROLLED", differences };
}

export type ComparisonCohortRecord = ComparisonScope & {
  cohortKey: string;
  executionAssumptions: unknown | null;
  outcomeCount: number;
};

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

export function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function comparisonWindowHash(
  marketId: MarketId,
  startDate: string,
  endDate: string,
  timeStart: string,
  timeEnd: string,
): string {
  return sha256({ marketId, startDate, endDate, timeStart, timeEnd });
}

export function comparisonCohortKey(value: {
  marketId: MarketId;
  profileConfigId: string;
  strategyVersion: string | null;
  featureVersion?: string | null;
  executionModelVersion: string | null;
  executionAssumptions: unknown;
  signalSemanticsVersion: string | null;
  replayScope: string | null;
  inputHash: string | null;
  windowHash: string | null;
}): string {
  return sha256({
    marketId: value.marketId,
    profileConfigId: value.profileConfigId,
    strategyVersion: value.strategyVersion,
    featureVersion: value.featureVersion ?? null,
    executionModelVersion: value.executionModelVersion,
    executionAssumptions: value.executionAssumptions,
    signalSemanticsVersion: value.signalSemanticsVersion,
    replayScope: value.replayScope,
    inputHash: value.inputHash,
    windowHash: value.windowHash,
  });
}
