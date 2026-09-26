import { contentHash } from "../paper-bot/funded-evidence-digest.js";

/**
 * Canonical FP04 shadow-observation digests. Every digest is recomputed at the
 * persistence boundary from the exact frozen payload; a caller-supplied digest
 * is never trusted. Audit-only database clocks are excluded so identical frozen
 * inputs reproduce an identical identity.
 */

export function fundedShadowGatePolicyDigest(value: unknown): string {
  return contentHash(value);
}

export function fundedShadowEnrollmentDigest(value: unknown): string {
  return contentHash(value);
}

export function fundedShadowBatchDigest(value: unknown): string {
  return contentHash(value);
}

export function fundedShadowMemberDigest(value: unknown): string {
  return contentHash(value);
}

export function fundedShadowAttemptDigest(value: unknown): string {
  return contentHash(value);
}

export function fundedShadowResultDigest(value: unknown): string {
  return contentHash(value);
}

export function fundedShadowProjectionDigest(value: unknown): string {
  return contentHash(value);
}

export function fundedShadowLabelDigest(value: unknown): string {
  return contentHash(value);
}

export function fundedShadowReportDigest(value: unknown): string {
  return contentHash(value);
}
