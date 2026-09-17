import { createHash } from "node:crypto";
import type {
  FundedCohortComponents,
  FundedDecisionTimeInput,
  FundedExecutionAssumptions,
  FundedOutcomeVersion,
} from "@tsx-scanner/contracts";

/**
 * Canonical hashing for funded learning evidence. This module is API-only:
 * Node's crypto and the canonical JSON rules must never enter the browser
 * contracts bundle. Every digest is recomputed here at the trusted persistence
 * boundary from the actual payload, never accepted from a caller.
 */

/** Stable JSON: object keys sorted recursively, arrays keep their order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function contentHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalValue(value: unknown): unknown {
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("UNSUPPORTED_CANONICAL_VALUE");
    return value;
  }
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .filter((key) => record[key] !== undefined)
        .map((key) => [key, canonicalValue(record[key])]),
    );
  }
  throw new Error("UNSUPPORTED_CANONICAL_VALUE");
}

/** Digest of the exact decision-time content (sequence and capture excluded). */
export function decisionContentDigest(
  decision: FundedDecisionTimeInput,
): string {
  return contentHash(decision);
}

/**
 * Digest of one compatible-cohort component set. The components schema
 * deliberately excludes any cohort digest, so a caller-supplied runtime value
 * can never enter this hash.
 */
export function fundedCohortDigest(
  components: FundedCohortComponents | Record<string, unknown>,
): string {
  return contentHash(components);
}

/** Digest of the exact account assumption snapshot used by the funded run. */
export function accountAssumptionDigest(
  assumptions: FundedExecutionAssumptions,
): string {
  return contentHash(assumptions);
}

/**
 * Digest of an outcome version's source payload. The sequence and recorded
 * time are database-owned and deliberately excluded so a retry of the same
 * durable source resolves to the same identity.
 */
export function outcomeSourceDigest(source: {
  sourceKind: FundedOutcomeVersion["sourceKind"];
  sourceId: string;
  status: FundedOutcomeVersion["status"];
  availableAt: string;
  reason: string | null;
  detail: unknown;
  supersedesSequence: number | null;
}): string {
  return contentHash({
    sourceKind: source.sourceKind,
    sourceId: source.sourceId,
    status: source.status,
    availableAt: source.availableAt,
    reason: source.reason,
    detail: source.detail,
    supersedesSequence: source.supersedesSequence,
  });
}
