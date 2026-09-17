import { createHash } from "node:crypto";
import { contentHash } from "../paper-bot/funded-evidence-digest.js";
import type { FundedExecutionModelArtifact } from "@tsx-scanner/contracts";

/**
 * Canonical digests for the funded-execution learning path (FP02).
 *
 * Dataset, membership, row and prediction digests use the repository's sorted
 * canonical JSON (`contentHash`, also used by FP01 evidence). The artifact
 * digest uses the fixed twelve-decimal serializer shared with the Python
 * trainer, so the same artifact produces byte-identical input in both
 * languages. Digests are recomputed at the trusted persistence boundary and
 * never accepted from a caller.
 */

export { contentHash };

export function fundedExecutionArtifactDigest(
  artifact: FundedExecutionModelArtifact,
): string {
  return createHash("sha256")
    .update(canonicalArtifactJson(artifact))
    .digest("hex");
}

/** Canonical JSON with twelve-decimal numbers, matching the Python trainer. */
export function canonicalArtifactJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("UNSUPPORTED_CANONICAL_VALUE");
    const normalized = Object.is(value, -0) ? 0 : value;
    return normalized.toFixed(12);
  }
  if (typeof value === "string") return canonicalString(value);
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalArtifactJson(item)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map(
        (key) =>
          `${canonicalString(key)}:${canonicalArtifactJson(record[key])}`,
      )
      .join(",")}}`;
  }
  throw new Error("UNSUPPORTED_CANONICAL_VALUE");
}

/** JSON string escaping that matches Python's `ensure_ascii=True` output. */
function canonicalString(value: string): string {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (character) => {
    const code = character.charCodeAt(0).toString(16).padStart(4, "0");
    return `\\u${code}`;
  });
}

/** Digest of the frozen training partition (TRAIN rows only). */
export function fundedExecutionTrainingPartitionDigest(
  rowDigests: readonly string[],
): string {
  return contentHash({ partition: "TRAIN", rowDigests: [...rowDigests] });
}

/** Digest of an ordered dataset membership (all included rows). */
export function fundedExecutionMembershipDigest(
  rowDigests: readonly string[],
): string {
  return contentHash({ rowDigests: [...rowDigests] });
}

/** Digest of the complete frozen dataset manifest content. */
export function fundedExecutionDatasetDigest(value: unknown): string {
  return contentHash(value);
}

/** Digest of a frozen forward-prediction record (recordedAt excluded). */
export function fundedExecutionPredictionDigest(value: unknown): string {
  return contentHash(value);
}
