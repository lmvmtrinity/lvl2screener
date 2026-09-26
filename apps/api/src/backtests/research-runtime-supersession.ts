import type { Pool } from "pg";
import type { MarketId } from "@tsx-scanner/contracts";
import { contentHash } from "./research-coverage.js";
import type { ResearchRuntimeIdentity } from "./research-runtime-identity.js";

export type RuntimeDigestInput = Pick<
  ResearchRuntimeIdentity,
  "engineRevision" | "runtimeFingerprint"
> & { featureVersion?: string };

/** Stable non-secret digest binding a coverage identity to one runtime. */
export function challengerCoverageRuntimeDigest(
  runtime: RuntimeDigestInput,
): string {
  return contentHash({
    engineRevision: runtime.engineRevision,
    runtimeFingerprint: runtime.runtimeFingerprint,
    featureVersion: runtime.featureVersion ?? null,
  });
}

/**
 * New immutable challenger coverage identity. The frozen recipe/runtime digest
 * makes replacement after a runtime change a new row while keeping the
 * previous request and its failure intact. Repeated polling under the same
 * runtime resolves to the same key, so exactly one successor exists per
 * runtime.
 */
export function challengerCoverageKey(
  experimentId: string,
  date: string,
  runtime: RuntimeDigestInput,
): string {
  return `challenger-coverage:${experimentId}:${date}:${challengerCoverageRuntimeDigest(runtime)}`;
}

/** Pre-runtime-replacement key format. Retained for lookup only; never reused. */
export function legacyChallengerCoverageKey(
  experimentId: string,
  date: string,
): string {
  return `challenger-coverage:${experimentId}:${date}`;
}

export type MismatchedJobInventoryItem = {
  jobId: string;
  jobType: string;
  status: string;
  marketId: string | null;
  requestEngineRevision: string | null;
  requestRuntimeFingerprint: string | null;
  candidateEngineRevision: string;
  candidateRuntimeFingerprint: string;
};

function requestMarket(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const root = payload as Record<string, unknown>;
  const request = root.request as Record<string, unknown> | undefined;
  const recipe = request?.recipe as Record<string, unknown> | undefined;
  const directMarket =
    (recipe?.marketId as string | undefined) ??
    (request?.marketId as string | undefined);
  if (typeof directMarket === "string") return directMarket;
  const manifest = request?.manifest as Record<string, unknown> | undefined;
  const market = manifest?.marketId;
  return typeof market === "string" ? market : null;
}

function requestRuntime(payload: unknown): {
  engineRevision: string | null;
  runtimeFingerprint: string | null;
} {
  if (typeof payload !== "object" || payload === null)
    return { engineRevision: null, runtimeFingerprint: null };
  const root = payload as Record<string, unknown>;
  // v2: request.recipe.{engineRevision,runtimeFingerprint}; legacy: top-level.
  const request = root.request as Record<string, unknown> | undefined;
  const recipe = request?.recipe as Record<string, unknown> | undefined;
  const engineRevision =
    (recipe?.engineRevision as string | undefined) ??
    (request?.engineRevision as string | undefined) ??
    (root.engineRevision as string | undefined) ??
    null;
  const runtimeFingerprint =
    (recipe?.runtimeFingerprint as string | undefined) ??
    (request?.runtimeFingerprint as string | undefined) ??
    (root.runtimeFingerprint as string | undefined) ??
    null;
  return { engineRevision, runtimeFingerprint };
}

/**
 * Read-only pre-deployment inventory: queued/running research jobs whose bound
 * runtime differs from the candidate worker runtime. Never mutates jobs,
 * requests, or evidence.
 */
export async function inventoryRuntimeMismatchedJobs(
  pool: Pool,
  candidate: Pick<
    ResearchRuntimeIdentity,
    "engineRevision" | "runtimeFingerprint"
  >,
): Promise<MismatchedJobInventoryItem[]> {
  const result = await pool.query<{
    id: string;
    job_type: string;
    status: string;
    request_payload: unknown;
  }>(
    `SELECT id, job_type, status, request_payload FROM research_job
      WHERE job_type IN ('COVERAGE_VERIFICATION','BACKTEST','CALIBRATION','RANKING_RESEARCH','STATISTICAL_TRAINING','STRATEGY_STUDY','EXECUTION_DIAGNOSTICS')
        AND status IN ('QUEUED','RUNNING','CANCELLING')
      ORDER BY created_at DESC, id DESC
      LIMIT 500`,
  );
  const mismatched: MismatchedJobInventoryItem[] = [];
  for (const row of result.rows) {
    const { engineRevision, runtimeFingerprint } = requestRuntime(
      row.request_payload,
    );
    // Jobs without a bound runtime (legacy v1 without recipe) cannot be proven
    // to match the candidate; report them as requiring review rather than
    // silently treating them as current.
    if (
      engineRevision === null ||
      runtimeFingerprint === null ||
      engineRevision !== candidate.engineRevision ||
      runtimeFingerprint !== candidate.runtimeFingerprint
    ) {
      mismatched.push({
        jobId: row.id,
        jobType: row.job_type,
        status: row.status,
        marketId: requestMarket(row.request_payload),
        requestEngineRevision: engineRevision,
        requestRuntimeFingerprint: runtimeFingerprint,
        candidateEngineRevision: candidate.engineRevision,
        candidateRuntimeFingerprint: candidate.runtimeFingerprint,
      });
    }
  }
  return mismatched;
}

export type LogicalScopeSuccessor = {
  requestId: string;
  jobId: string;
  reportHash: string | null;
  coverageStatus: "VERIFIED" | "INCOMPLETE" | "UNKNOWN" | null;
  jobStatus: string;
};

/**
 * Finds the successor result for the same logical challenger scope
 * (market + experiment + date) created under a different idempotency key.
 * Old evidence stays immutable; a caller may describe the old mismatch as
 * superseded only when this returns a VERIFIED successor.
 */
export async function findChallengerSuccessor(
  pool: Pool,
  input: { marketId: MarketId; experimentId: string; date: string },
): Promise<LogicalScopeSuccessor | null> {
  // Requests for one logical scope share the manifest purpose
  // (experimentId + date) even though each runtime uses a distinct
  // idempotency key. Join through the stored request JSON rather than the key.
  const result = await pool.query<{
    request_id: string;
    job_id: string;
    report_hash: string | null;
    coverage_status: LogicalScopeSuccessor["coverageStatus"];
    job_status: string;
    job_created_at: Date;
  }>(
    `SELECT q.id AS request_id, j.id AS job_id, r.report_hash, r.status AS coverage_status,
            j.status AS job_status, j.created_at AS job_created_at
       FROM research_coverage_request q
       JOIN research_job j ON j.request_payload->>'requestId' = q.id::text
       LEFT JOIN research_coverage_request_result r ON r.job_id = j.id
      WHERE q.market_id = $1
        AND q.request->'manifest'->'manifest'->'purpose'->>'experimentId' = $2
        AND $3 = ANY (
          SELECT jsonb_array_elements_text(
            COALESCE(
              q.request->'manifest'->'manifest'->'plan'->'expectedSessions',
              q.request->'recipe'->'sessionDates'
            )
          )
        )
      ORDER BY j.created_at DESC, j.id DESC`,
    [input.marketId, input.experimentId, input.date],
  );
  for (const row of result.rows) {
    if (row.job_status === "SUCCEEDED" && row.coverage_status === "VERIFIED") {
      return {
        requestId: row.request_id,
        jobId: row.job_id,
        reportHash: row.report_hash,
        coverageStatus: row.coverage_status,
        jobStatus: row.job_status,
      };
    }
  }
  return null;
}

/**
 * Returns true only when a VERIFIED successor exists for the same logical
 * scope. Callers must keep the old mismatch retained as FAILED; this helper
 * only informs operational display (superseded vs actionable).
 */
export async function isChallengerMismatchSuperseded(
  pool: Pool,
  input: { marketId: MarketId; experimentId: string; date: string },
): Promise<boolean> {
  return (await findChallengerSuccessor(pool, input)) !== null;
}
