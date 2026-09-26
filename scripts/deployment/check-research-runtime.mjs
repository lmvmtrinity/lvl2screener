import pg from "pg";

const { Pool } = pg;

// Read-only pre-deployment inventory: reports queued/running research jobs
// bound to a runtime different from the candidate worker runtime, grouped by
// market, manifest/scope and runtime identity. Never mutates jobs, requests,
// or evidence. An old EVIDENCE_RUNTIME_MISMATCH is described as superseded
// only after a VERIFIED successor for the same logical scope exists.
const candidateEngine = process.argv[2];
const candidateFingerprint = process.argv[3];
if (!candidateEngine || !candidateFingerprint) {
  console.error(
    "usage: check-research-runtime.mjs <engineRevision> <runtimeFingerprint> [--database-url $DATABASE_URL]",
  );
  process.exit(2);
}

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ?? process.env.PERSISTENCE_TEST_DATABASE_URL,
});
try {
  const mismatched = await pool.query(
    `SELECT id, job_type, status, request_payload FROM research_job
      WHERE job_type IN ('COVERAGE_VERIFICATION','BACKTEST','CALIBRATION','RANKING_RESEARCH','STATISTICAL_TRAINING','STRATEGY_STUDY','EXECUTION_DIAGNOSTICS')
        AND status IN ('QUEUED','RUNNING','CANCELLING')
      ORDER BY created_at DESC, id DESC LIMIT 500`,
  );
  const rows = [];
  for (const row of mismatched.rows) {
    const payload = row.request_payload ?? {};
    const request = payload.request ?? {};
    const recipe = request.recipe ?? {};
    const engine =
      recipe.engineRevision ??
      request.engineRevision ??
      payload.engineRevision ??
      null;
    const fingerprint =
      recipe.runtimeFingerprint ??
      request.runtimeFingerprint ??
      payload.runtimeFingerprint ??
      null;
    if (engine !== candidateEngine || fingerprint !== candidateFingerprint) {
      const market =
        recipe.marketId ??
        request.marketId ??
        request.manifest?.marketId ??
        null;
      rows.push({
        jobId: row.id,
        jobType: row.job_type,
        status: row.status,
        marketId: market,
        requestEngineRevision: engine,
        requestRuntimeFingerprint: fingerprint,
      });
    }
  }

  const failures = await pool.query(
    `SELECT j.id AS job_id, j.error, j.error_category,
            COALESCE(q.market_id, j.request_payload#>>'{request,recipe,marketId}', j.request_payload#>>'{request,marketId}') AS market_id,
            COALESCE(r.request_id::text, j.request_payload->>'requestId', j.id::text) AS scope,
            r.status AS coverage_status, j.status AS job_status
       FROM research_job j
       LEFT JOIN research_coverage_request_result r ON r.job_id = j.id
       LEFT JOIN research_coverage_request q ON q.id::text = j.request_payload->>'requestId'
      WHERE j.job_type = 'COVERAGE_VERIFICATION' AND j.status = 'FAILED'
      ORDER BY j.created_at DESC LIMIT 200`,
  );
  const historical = [];
  for (const row of failures.rows) {
    const isMismatch =
      row.error === "EVIDENCE_RUNTIME_MISMATCH" ||
      row.error_category === "VALIDATION";
    if (!isMismatch) {
      historical.push({ ...row, disposition: "ACTIONABLE" });
      continue;
    }
    // Superseded only after a VERIFIED successor for the same scope exists.
    const successor = await pool.query(
      `SELECT 1 FROM research_job s
         JOIN research_coverage_request_result sr ON sr.job_id = s.id
        WHERE s.job_type = 'COVERAGE_VERIFICATION' AND s.status = 'SUCCEEDED'
          AND sr.status = 'VERIFIED'
          AND COALESCE(sr.request_id::text, s.request_payload->>'requestId') = $1
        LIMIT 1`,
      [row.scope],
    );
    historical.push({
      ...row,
      disposition: successor.rowCount ? "SUPERSEDED" : "ACTIONABLE",
    });
  }

  const report = {
    version: "research-runtime-inventory-v1",
    candidate: {
      engineRevision: candidateEngine,
      runtimeFingerprint: candidateFingerprint,
    },
    mismatchedQueuedRunning: rows,
    recentCoverageFailures: historical,
    generatedAt: new Date().toISOString(),
  };
  console.log(JSON.stringify(report, null, 2));
} finally {
  await pool.end();
}
