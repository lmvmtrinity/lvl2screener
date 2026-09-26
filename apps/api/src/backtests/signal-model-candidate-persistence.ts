import {
  statisticalDatasetMetricsSchema,
  type SignalModelResearchPlan,
  type StatisticalModelArtifact,
  type StatisticalDatasetMetrics,
} from "@tsx-scanner/contracts";
import type { Pool, PoolClient } from "pg";
import { canonicalJson, contentHash } from "./research-coverage.js";
import { PostgresResearchEvidenceStore } from "./research-evidence-repository.js";
import { buildCapturedResearchProspectiveScope } from "./signal-model-candidate-handoff.js";

/** Persist the inactive research artifact as a manually enrollable prospective candidate. */
export async function persistCapturedResearchCandidate(input: {
  pool: Pool;
  authorizationId: string;
  plan: SignalModelResearchPlan;
  planHash: string;
  modelVersion: string;
  artifact: StatisticalModelArtifact;
  trainMetrics: StatisticalDatasetMetrics | null;
  testMetrics: StatisticalDatasetMetrics | null;
  warnings: readonly string[];
}): Promise<string> {
  const { pool } = input;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const authority = await client.query<{
      plan_hash: string;
      plan: SignalModelResearchPlan;
      source_run_id: string;
      market_id: string;
      source_digest: string;
      revoked_at: Date | null;
      report_status: string;
      selected_candidate_identity: string | null;
      evaluation: unknown;
      binding: unknown;
      binding_market: string;
      binding_digest: string;
      run_evidence: unknown;
    }>(
      `SELECT a.plan_hash,a.plan,a.source_run_id,a.market_id,a.source_digest,
              a.revoked_at,r.status report_status,
              r.selected_candidate_identity,r.evaluation,eb.binding,eb.market_id binding_market,
              eb.input_hash binding_digest,bk.research_evidence run_evidence
         FROM signal_model_research_authorization a
         JOIN signal_model_research_report r ON r.authorization_id=a.id
         JOIN backtest_run bk ON bk.id=a.source_run_id
         JOIN research_evidence_binding eb ON eb.owner_kind='BACKTEST' AND eb.owner_id=bk.id
         JOIN research_coverage_report cr ON cr.hash=eb.coverage_report_hash
          AND cr.market_id=eb.market_id AND cr.status='VERIFIED' AND cr.input_hash=eb.input_hash
        WHERE a.id=$1 AND a.expires_at>clock_timestamp() FOR UPDATE OF a`,
      [input.authorizationId],
    );
    const row = authority.rows[0];
    if (
      !row ||
      row.plan_hash !== input.planHash ||
      row.revoked_at ||
      contentHash(input.plan) !== input.planHash ||
      canonicalJson(row.plan) !== canonicalJson(input.plan) ||
      row.source_run_id !== input.plan.source.runId ||
      row.market_id !== input.plan.source.marketId ||
      row.source_digest !== input.plan.source.sourceDigest ||
      row.binding === null ||
      row.binding_market !== input.plan.source.marketId ||
      row.binding_digest !== input.plan.source.sourceDigest ||
      canonicalJson(row.run_evidence) !== canonicalJson(row.binding) ||
      !["COMPLETED", "INSUFFICIENT"].includes(row.report_status) ||
      row.selected_candidate_identity !== input.modelVersion
    )
      throw new Error("SIGNAL_MODEL_CANDIDATE_AUTHORITY_UNAVAILABLE");

    // The immutable report is the durable source for metrics when a worker
    // retries after committing its report but before completing this handoff.
    const reportEvaluation =
      row.evaluation && typeof row.evaluation === "object"
        ? (row.evaluation as Record<string, unknown>)
        : null;
    const reportTrainingMetrics = statisticalDatasetMetricsSchema.safeParse(
      reportEvaluation?.trainingMetrics,
    );
    if (
      !reportTrainingMetrics.success ||
      (input.trainMetrics &&
        canonicalJson(input.trainMetrics) !==
          canonicalJson(reportTrainingMetrics.data))
    )
      throw new Error("SIGNAL_MODEL_CANDIDATE_TRAINING_METRICS_UNPROVEN");
    const trainMetrics = reportTrainingMetrics.data;

    const existing = await client.query<{
      id: string;
      status: string;
      active: boolean;
      eligible_for_activation: boolean;
      source_kind: string;
      backtest_run_id: string;
      signal_model_research_authorization_id: string;
      model_version: string;
      artifact: unknown;
      input: unknown;
    }>(
      `SELECT id,status,active,eligible_for_activation,source_kind,backtest_run_id,
              signal_model_research_authorization_id,model_version,artifact,input
         FROM statistical_model
        WHERE signal_model_research_authorization_id=$1`,
      [input.authorizationId],
    );
    const scope = buildCapturedResearchProspectiveScope({
      marketId: input.plan.source.marketId,
      strategy: input.plan.source.strategy,
      strategyVersion: input.plan.source.strategyVersion,
      profileId: input.plan.source.profileId,
      configVersion: input.plan.source.configVersion,
      executionModelVersion: input.plan.source.executionModelVersion,
      executionAssumptionsHash: input.plan.source.executionAssumptionsHash,
      signalSemanticsVersions: await loadSemantics(client, input),
    });
    const scopeHash = contentHash(scope);
    const artifactHash = contentHash(input.artifact);
    const trainingIds = input.plan.membership.TRAIN.opportunityIds;
    const cutoff = await client.query<{
      cutoff: Date | null;
      sample_count: number;
    }>(
      `SELECT max(label_available_at) cutoff,count(*)::integer sample_count
         FROM backtest_opportunity_capture
        WHERE source_run_id=$1 AND opportunity_id=ANY($2::text[])
          AND market_id=$3 AND strategy_name=$4 AND strategy_version=$5
          AND config_version=$6 AND profile_id=$7 AND profile_name=$8
          AND execution_model_version=$9 AND execution_assumptions_hash=$10
          AND outcome->>'status'='CLOSED' AND label_available_at IS NOT NULL`,
      [
        input.plan.source.runId,
        trainingIds,
        input.plan.source.marketId,
        input.plan.source.strategy,
        input.plan.source.strategyVersion,
        input.plan.source.configVersion,
        input.plan.source.profileId,
        input.plan.source.profileName,
        input.plan.source.executionModelVersion,
        input.plan.source.executionAssumptionsHash,
      ],
    );
    if (
      !cutoff.rows[0]?.cutoff ||
      cutoff.rows[0].sample_count !== trainMetrics.samples
    )
      throw new Error("SIGNAL_MODEL_CANDIDATE_TRAINING_CUTOFF_UNPROVEN");

    if (existing.rows[0]) {
      const saved = existing.rows[0];
      if (
        saved.status !== "COMPLETED" ||
        saved.active ||
        saved.eligible_for_activation ||
        saved.source_kind !== "CAPTURED_BACKTEST_RESEARCH" ||
        saved.backtest_run_id !== input.plan.source.runId ||
        saved.signal_model_research_authorization_id !==
          input.authorizationId ||
        saved.model_version !== input.modelVersion ||
        contentHash(saved.artifact) !== artifactHash ||
        (saved.input as { planHash?: string; authorizationId?: string } | null)
          ?.planHash !== input.planHash ||
        (saved.input as { authorizationId?: string } | null)
          ?.authorizationId !== input.authorizationId
      )
        throw new Error("SIGNAL_MODEL_CANDIDATE_IDEMPOTENCY_CONFLICT");
      const savedScope = await client.query<{
        scope_hash: string;
        scope: unknown;
        source_kind: string;
        source_id: string;
        source_digest: string;
        artifact_hash: string;
        training_label_cutoff_at: Date | null;
      }>(
        `SELECT scope_hash,scope,source_kind,source_id,source_digest,artifact_hash,training_label_cutoff_at
           FROM challenger_model_scope WHERE model_id=$1`,
        [saved.id],
      );
      const savedScopeRow = savedScope.rows[0];
      if (
        !savedScopeRow ||
        savedScopeRow.scope_hash !== scopeHash ||
        canonicalJson(savedScopeRow.scope) !== canonicalJson(scope) ||
        savedScopeRow.source_kind !== "CAPTURED_BACKTEST_RESEARCH" ||
        savedScopeRow.source_id !== input.plan.source.runId ||
        savedScopeRow.source_digest !== input.plan.source.sourceDigest ||
        savedScopeRow.artifact_hash !== artifactHash ||
        savedScopeRow.training_label_cutoff_at?.getTime() !==
          cutoff.rows[0]!.cutoff!.getTime()
      )
        throw new Error("SIGNAL_MODEL_CANDIDATE_SCOPE_CONFLICT");
      await client.query("COMMIT");
      return saved.id;
    }

    const candidateInput = {
      name: `Signal research candidate ${input.plan.source.strategy}`,
      sourceKind: "CAPTURED_BACKTEST_RESEARCH" as const,
      backtestRunId: input.plan.source.runId,
      authorizationId: input.authorizationId,
      strategy: input.plan.source.strategy,
      trainPct: 80,
      minimumSamples: input.plan.model.minimumTrainingSamples,
      l2Penalty: input.plan.model.l2Penalty,
      planHash: input.planHash,
    };
    const model = await client.query<{ id: string }>(
      `INSERT INTO statistical_model
        (market_id,name,status,model_type,model_version,source_kind,backtest_run_id,
         signal_model_research_authorization_id,strategy_name,input,artifact,train_metrics,
         test_metrics,calibration,eligible_for_activation,active,warnings,completed_at,research_evidence)
       VALUES($1,$2,'COMPLETED','LOGISTIC_SETUP_QUALITY',$3,'CAPTURED_BACKTEST_RESEARCH',$4,
         $5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,'[]'::jsonb,false,false,
         $12::jsonb,clock_timestamp(),$11::jsonb)
       RETURNING id`,
      [
        input.plan.source.marketId,
        candidateInput.name,
        input.modelVersion,
        input.plan.source.runId,
        input.authorizationId,
        input.plan.source.strategy,
        JSON.stringify(candidateInput),
        JSON.stringify(input.artifact),
        JSON.stringify(trainMetrics),
        JSON.stringify(input.testMetrics),
        JSON.stringify(row.binding),
        JSON.stringify([...input.warnings, "PROSPECTIVE_GATE_REQUIRED"]),
      ],
    );
    const modelId = model.rows[0]!.id;
    await client.query(
      `INSERT INTO challenger_model_scope
        (model_id,scope_hash,scope,source_kind,source_id,source_digest,artifact_hash,training_label_cutoff_at)
       VALUES($1,$2,$3::jsonb,'CAPTURED_BACKTEST_RESEARCH',$4,$5,$6,$7)`,
      [
        modelId,
        scopeHash,
        JSON.stringify(scope),
        input.plan.source.runId,
        input.plan.source.sourceDigest,
        artifactHash,
        cutoff.rows[0]!.cutoff,
      ],
    );
    await new PostgresResearchEvidenceStore(pool).bindWithClient!(
      client,
      { kind: "MODEL", id: modelId, marketId: input.plan.source.marketId },
      row.binding as never,
    );
    await client.query("COMMIT");
    return modelId;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function loadSemantics(
  client: PoolClient,
  input: { authorizationId: string; plan: SignalModelResearchPlan },
): Promise<(string | null)[]> {
  const source = await client.query<{
    status: string;
    market_id: string;
    strategy_version: string;
    config_version: string;
    execution_model_version: string;
    execution_assumptions: unknown;
    input_digest: string | null;
  }>(
    `SELECT r.status,r.market_id,r.strategy_version,r.config_version,
            r.execution_model_version,r.execution_assumptions,
            r.research_evidence->>'inputHash' input_digest
       FROM backtest_run r WHERE r.id=$1`,
    [input.plan.source.runId],
  );
  const run = source.rows[0];
  const receipt = await client.query<{
    market_id: string;
    expected_count: number;
    membership_hash: string;
    execution_model_version: string;
    execution_assumptions_hash: string;
  }>(
    `SELECT market_id,expected_count,membership_hash,execution_model_version,execution_assumptions_hash
       FROM backtest_opportunity_capture_receipt WHERE source_run_id=$1`,
    [input.plan.source.runId],
  );
  const captureRows = await client.query<{
    capture_ordinal: number;
    opportunity_id: string;
    evidence_id: string;
    capture_hash: string;
  }>(
    `SELECT capture_ordinal,opportunity_id,evidence_id,capture_hash
       FROM backtest_opportunity_capture WHERE source_run_id=$1 ORDER BY capture_ordinal`,
    [input.plan.source.runId],
  );
  const receiptRow = receipt.rows[0];
  if (
    !run ||
    !receiptRow ||
    run.status !== "COMPLETED" ||
    run.market_id !== input.plan.source.marketId ||
    run.strategy_version !== input.plan.source.strategyVersion ||
    run.config_version !== input.plan.source.configVersion ||
    run.execution_model_version !== input.plan.source.executionModelVersion ||
    contentHash(run.execution_assumptions) !==
      input.plan.source.executionAssumptionsHash ||
    run.input_digest !== input.plan.source.sourceDigest ||
    receiptRow.market_id !== input.plan.source.marketId ||
    receiptRow.expected_count !== input.plan.source.orderedMembershipCount ||
    receiptRow.membership_hash !== input.plan.source.orderedMembershipHash ||
    receiptRow.execution_model_version !==
      input.plan.source.executionModelVersion ||
    receiptRow.execution_assumptions_hash !==
      input.plan.source.executionAssumptionsHash ||
    captureRows.rows.length !== receiptRow.expected_count ||
    captureRows.rows.some((row, index) => row.capture_ordinal !== index) ||
    contentHash(
      captureRows.rows.map(({ opportunity_id, evidence_id, capture_hash }) => ({
        opportunityId: opportunity_id,
        evidenceId: evidence_id,
        captureHash: capture_hash,
      })),
    ) !== receiptRow.membership_hash
  )
    throw new Error("SIGNAL_MODEL_CANDIDATE_SOURCE_MEMBERSHIP_UNPROVEN");

  const ids = [
    ...input.plan.membership.TRAIN.opportunityIds,
    ...input.plan.membership.VALIDATION.opportunityIds,
    ...input.plan.membership.TEST.opportunityIds,
  ];
  const result = await client.query<{
    opportunity_id: string;
    signal_semantics_version: string | null;
  }>(
    `SELECT opportunity_id,signal_semantics_version
       FROM backtest_opportunity_capture
      WHERE source_run_id=$1 AND opportunity_id=ANY($2::text[])
        AND market_id=$3 AND strategy_name=$4 AND strategy_version=$5
        AND config_version=$6 AND profile_id=$7 AND profile_name=$8
        AND execution_model_version=$9 AND execution_assumptions_hash=$10
      ORDER BY capture_ordinal`,
    [
      input.plan.source.runId,
      ids,
      input.plan.source.marketId,
      input.plan.source.strategy,
      input.plan.source.strategyVersion,
      input.plan.source.configVersion,
      input.plan.source.profileId,
      input.plan.source.profileName,
      input.plan.source.executionModelVersion,
      input.plan.source.executionAssumptionsHash,
    ],
  );
  if (
    result.rows.length !== ids.length ||
    canonicalJson(result.rows.map((item) => item.opportunity_id).sort()) !==
      canonicalJson([...ids].sort())
  )
    throw new Error("SIGNAL_MODEL_CANDIDATE_MEMBERSHIP_UNPROVEN");
  return result.rows.map((item) => item.signal_semantics_version);
}
