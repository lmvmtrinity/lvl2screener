import type {
  BacktestRun,
  FundedComparisonInputItem,
  FundedComparisonPolicyEvaluation,
  FundedComparisonResult,
  FundedComparisonSessionMetric,
  FundedComparisonSpecification,
} from "@tsx-scanner/contracts";
import { contentHash } from "./funded-evidence-digest.js";

/**
 * Canonical digests for FP03 comparison records. Every digest is recomputed at
 * the trusted persistence boundary from the actual payload; a caller-supplied
 * digest is never trusted. Audit-only fields (database clock, capture time) are
 * deliberately excluded so an exact retry resolves to the same identity.
 */

export function fundedComparisonSpecDigest(
  specification: Omit<FundedComparisonSpecification, "comparisonSpecDigest">,
): string {
  return contentHash(specification);
}

export function fundedComparisonSessionMembershipDigest(
  orderedSessionDates: readonly string[],
): string {
  return contentHash(orderedSessionDates);
}

export function fundedComparisonOpportunityMembershipDigest(
  orderedOpportunityIds: readonly string[],
): string {
  return contentHash(orderedOpportunityIds);
}

export interface FundedComparisonSharedInputSessionEntry {
  readonly sessionDate: string;
  readonly itemCount: number;
  readonly chunkCount: number;
  readonly sessionInputDigest: string;
}

/** Ordered digest over each frozen session's input identity. */
export function fundedComparisonSharedInputMembershipDigest(
  orderedSessions: readonly FundedComparisonSharedInputSessionEntry[],
): string {
  return contentHash(orderedSessions);
}

/** Digest of the exact frozen replay request payload. */
export function fundedComparisonReplayRequestDigest(request: unknown): string {
  return contentHash(request);
}

/** Digest of the exact frozen profile/config identities replay materializes. */
export function fundedComparisonReplayProfilesDigest(
  profiles: readonly unknown[],
): string {
  return contentHash(profiles);
}

export function fundedComparisonInputItemDigest(
  item: FundedComparisonInputItem,
): string {
  return contentHash(item);
}

export interface FundedComparisonChunkDigestInput {
  readonly sessionDate: string;
  readonly chunkOrdinal: number;
  readonly firstEffectiveAt: string;
  readonly lastEffectiveAt: string;
  readonly itemDigests: readonly string[];
}

export function fundedComparisonChunkDigest(
  chunk: FundedComparisonChunkDigestInput,
): string {
  return contentHash(chunk);
}

export interface FundedComparisonSessionInputDigestInput {
  readonly sessionDate: string;
  readonly chunkDigests: readonly string[];
  readonly itemCount: number;
}

export function fundedComparisonSessionInputDigest(
  input: FundedComparisonSessionInputDigestInput,
): string {
  return contentHash(input);
}

/**
 * Canonical digest of a retained completed baseline result. Covers the exact
 * retained metrics, analyses, trades, data quality and replay-input identity so
 * a later mutation or deletion of the baseline's source tables cannot change
 * what the comparison claims to compare against.
 */
export function backtestBaselineResultDigest(run: BacktestRun): string {
  return contentHash({
    metrics: run.metrics,
    analyses: run.analyses,
    trades: run.trades,
    dataQuality: run.dataQuality,
    replayInputHash: run.replayInput?.inputHash ?? null,
    executionModelVersion: run.executionModelVersion,
  });
}

/** Digest of the exact persisted funded policy JSON. */
export function fundedPolicyDigest(policy: unknown): string {
  return contentHash(policy);
}

/** Digest of the funded risk configuration actually persisted for the account. */
export function riskConfigurationDigest(risk: {
  initialCash: number;
  dailyLossLimit: number;
  maxOpenRisk: number | null;
  maxSymbolNotional: number | null;
  maxSectorNotional: number | null;
  maxOpenPositions: number | null;
}): string {
  return contentHash(risk);
}

export function fundedComparisonEvaluationDigest(
  evaluation: Omit<FundedComparisonPolicyEvaluation, "evaluationDigest">,
): string {
  return contentHash(evaluation);
}

export function fundedComparisonMetricDigest(
  metric: Omit<FundedComparisonSessionMetric, "metricDigest">,
): string {
  return contentHash(metric);
}

export interface FundedComparisonResultDigestInput {
  readonly comparisonSpecDigest: string;
  readonly championEvaluationDigest: string;
  readonly challengerEvaluationDigest: string;
  readonly championMetricsDigest: string;
  readonly challengerMetricsDigest: string;
  readonly orderedPairedSessionDigests: readonly string[];
}

export function fundedComparisonResultDigest(
  input: FundedComparisonResultDigestInput,
): string {
  return contentHash(input);
}

export interface FundedComparisonFailureDigestInput {
  readonly specId: string;
  readonly attemptId: string;
  readonly side: string | null;
  readonly sessionDate: string | null;
  readonly reason: string;
  readonly classification: string;
  readonly detail: string;
}

export function fundedComparisonFailureDigest(
  input: FundedComparisonFailureDigestInput,
): string {
  return contentHash(input);
}

/** Digest of the ordered policy-evaluation membership for one side. */
export function fundedComparisonEvaluationMembershipDigest(
  evaluationDigests: readonly string[],
): string {
  return contentHash(evaluationDigests);
}

/** Digest of one side's assembled metric tree. */
export function fundedComparisonMetricsDigest(metrics: unknown): string {
  return contentHash(metrics);
}

/** Digest of one paired session row (excludes the result-level digests). */
export function fundedComparisonPairedSessionDigest(
  result: Pick<FundedComparisonResult, "pairedSessions">,
  sessionDate: string,
): string {
  const row = result.pairedSessions.find(
    (session) => session.sessionDate === sessionDate,
  );
  if (!row)
    throw new Error(
      `Paired session ${sessionDate} is not part of the retained vector`,
    );
  return contentHash(row);
}
