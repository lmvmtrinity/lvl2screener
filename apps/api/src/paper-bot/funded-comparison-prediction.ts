import {
  FUNDED_EXECUTION_FEATURE_VERSION,
  FUNDED_EXECUTION_MODEL_TYPE,
  fundedDecisionTimeInputSchema,
  fundedExecutionInferenceInputSchema,
  fundedExecutionInferenceOutputSchema,
  fundedExecutionModelArtifactSchema,
  type FundedComparisonPredictionIdentity,
  type FundedComparisonSpecification,
  type FundedExecutionModelArtifact,
  type MarketId,
} from "@tsx-scanner/contracts";
import type { Pool } from "pg";
import { fundedExecutionArtifactDigest } from "../statistical-models/funded-execution-digest.js";
import { fundedExecutionTrainingPartitionDigest } from "../statistical-models/funded-execution-digest.js";
import { extractFundedExecutionFeatures } from "../statistical-models/funded-execution-features.js";
import { contentHash } from "./funded-evidence-digest.js";
import type { FundedDecisionRow } from "./funded-decision-evidence-repository.js";
import { FundedComparisonSpecificationError } from "./funded-comparison-specification.js";
import type { FundedComparisonChallengerCandidate } from "./funded-comparison-challenger-policy.js";
import type { FundedComparisonTrainingWindow } from "./funded-comparison-specification.js";

/**
 * Comparison-owned historical inference. It recomputes predictions from the
 * champion side's immutable version-2 decision-time feature inputs with the
 * exact frozen FP02 artifact. It never calls `FundedExecutionPredictionService`
 * and never writes `funded_execution_prediction`; that table belongs to the
 * FP04 forward observation boundary.
 */

export interface FundedComparisonInferenceEngine {
  predictFundedExecution(payload: unknown): Promise<unknown>;
}

export interface FundedComparisonChallengerRecord {
  readonly challengerId: string;
  readonly modelVersion: string;
  readonly artifactDigest: string;
  readonly cohortDigest: string;
  readonly datasetDigest: string;
  readonly featureVersion: string;
  readonly artifact: FundedExecutionModelArtifact;
  readonly training: FundedComparisonTrainingWindow;
}

/**
 * Derives the TRAIN window from the persisted FP02 dataset/member rows. The
 * ordered training session dates, the latest `label_available_at` knowledge
 * coordinate and the training partition digest are computed here; a caller can
 * never supply them. The persisted artifact must reproduce the partition digest.
 */
export async function loadFundedComparisonTrainingLineage(
  pool: Pool,
  datasetId: string,
): Promise<FundedComparisonTrainingWindow> {
  const { rows } = await pool.query<{
    session_date: string | Date;
    label_available_at: Date | string;
    row_digest: string;
  }>(
    `SELECT session_date,label_available_at,row_digest
       FROM funded_execution_dataset_member
      WHERE dataset_id=$1 AND partition='TRAIN'
      ORDER BY ordinal`,
    [datasetId],
  );
  if (rows.length === 0)
    throw new FundedComparisonSpecificationError(
      "TRAINING_CHRONOLOGY_UNPROVEN",
      "The frozen challenger dataset retains no TRAIN-partition members",
    );
  const trainingSessionDates: string[] = [];
  let previousDate = "";
  let knowledgeCutoff = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    const sessionDate =
      row.session_date instanceof Date
        ? row.session_date.toISOString().slice(0, 10)
        : String(row.session_date).slice(0, 10);
    if (sessionDate < previousDate)
      throw new FundedComparisonSpecificationError(
        "TRAINING_CHRONOLOGY_UNPROVEN",
        "The frozen TRAIN membership is not ordered by session date",
      );
    if (sessionDate !== previousDate) trainingSessionDates.push(sessionDate);
    previousDate = sessionDate;
    const availableAt = new Date(row.label_available_at).getTime();
    if (!Number.isFinite(availableAt))
      throw new FundedComparisonSpecificationError(
        "TRAINING_CHRONOLOGY_UNPROVEN",
        "A frozen TRAIN member has no provable label knowledge time",
      );
    if (availableAt > knowledgeCutoff) knowledgeCutoff = availableAt;
  }
  return {
    trainingSessionDates,
    trainingKnowledgeCutoffAt: new Date(knowledgeCutoff).toISOString(),
    trainingPartitionDigest: fundedExecutionTrainingPartitionDigest(
      rows.map((row) => row.row_digest),
    ),
    trainingSessionDigest: contentHash(trainingSessionDates),
  };
}

/**
 * Loads and freezes the exact inactive challenger identity named by the spec.
 * A missing, failed, active or identity-mismatched challenger fails closed; a
 * comparison specification can never be built from a mismatched model.
 */
export async function loadFundedComparisonChallenger(
  pool: Pool,
  specification: FundedComparisonSpecification,
): Promise<FundedComparisonChallengerRecord> {
  const model = specification.challenger.model;
  const { rows } = await pool.query<{
    status: string;
    artifact: unknown;
    cohort_digest: string;
    dataset_digest: string;
    dataset_id: string;
    feature_version: string;
    model_version: string;
    artifact_digest: string;
  }>(
    `SELECT status,artifact,cohort_digest,dataset_digest,dataset_id,
       feature_version,model_version,artifact_digest
     FROM funded_execution_challenger
     WHERE id=$1 AND market_id=$2 AND currency=$3
       AND eligible_for_activation=false AND active=false`,
    [model.modelId, specification.marketId, specification.currency],
  );
  const row = rows[0];
  if (!row || row.status !== "INACTIVE" || row.artifact === null)
    throw new FundedComparisonSpecificationError(
      "MODEL_IDENTITY_MISMATCH",
      "The frozen comparison challenger is not an accessible inactive artifact",
    );
  if (
    row.cohort_digest !== model.cohortDigest ||
    row.dataset_digest !== model.datasetDigest ||
    row.feature_version !== model.featureVersion ||
    row.model_version !== model.modelVersion ||
    row.artifact_digest !== model.artifactDigest
  )
    throw new FundedComparisonSpecificationError(
      "MODEL_IDENTITY_MISMATCH",
      "The retained challenger no longer matches the frozen model identity",
    );
  const artifact = fundedExecutionModelArtifactSchema.parse(row.artifact);
  if (fundedExecutionArtifactDigest(artifact) !== model.artifactDigest)
    throw new FundedComparisonSpecificationError(
      "ARTIFACT_IDENTITY_MISMATCH",
      "The retained challenger artifact does not match its frozen digest",
    );
  if (
    artifact.sourceDatasetDigest !== model.datasetDigest ||
    artifact.trainingPartitionDigest !== model.trainingPartitionDigest
  )
    throw new FundedComparisonSpecificationError(
      "ARTIFACT_IDENTITY_MISMATCH",
      "The retained challenger artifact was trained on another dataset",
    );
  // The frozen TRAIN chronology is derived from the persisted members, not from
  // the specification's caller-supplied values, and must agree exactly.
  const training = await loadFundedComparisonTrainingLineage(
    pool,
    row.dataset_id,
  );
  if (
    training.trainingPartitionDigest !== artifact.trainingPartitionDigest ||
    training.trainingPartitionDigest !== model.trainingPartitionDigest ||
    training.trainingKnowledgeCutoffAt !== model.trainingEvidenceCutoffAt ||
    training.trainingSessionDigest !== model.trainingSessionDigest
  )
    throw new FundedComparisonSpecificationError(
      "TRAINING_CHRONOLOGY_UNPROVEN",
      "The retained FP02 training lineage does not match the frozen specification",
    );
  return {
    challengerId: model.modelId,
    modelVersion: model.modelVersion,
    artifactDigest: model.artifactDigest,
    cohortDigest: model.cohortDigest,
    datasetDigest: model.datasetDigest,
    featureVersion: model.featureVersion,
    artifact,
    training,
  };
}

export interface FundedComparisonPredictionRequest {
  readonly specification: FundedComparisonSpecification;
  readonly challenger: FundedComparisonChallengerRecord;
  readonly signalTimestamp: string;
  readonly candidates: readonly {
    readonly sourceOpportunityId: string;
    readonly sourceOrdinal: number;
    readonly signalTimestamp: string;
    readonly deterministicScore: number;
    readonly decisionAt: string;
    readonly observationId: string;
  }[];
  /** Champion-side decisions keyed by the shared source opportunity identity. */
  readonly championDecisions: ReadonlyMap<string, FundedDecisionRow>;
}

export interface FundedComparisonPredictionBatch {
  readonly batchKey: string;
  readonly batchFallback: boolean;
  readonly candidates: readonly FundedComparisonChallengerCandidate[];
  readonly identities: ReadonlyMap<string, FundedComparisonPredictionIdentity>;
}

function fallbackBatch(
  request: FundedComparisonPredictionRequest,
  reason: string,
): FundedComparisonPredictionBatch {
  return {
    batchKey: request.signalTimestamp,
    batchFallback: true,
    candidates: request.candidates.map((candidate) => ({
      sourceOpportunityId: candidate.sourceOpportunityId,
      sourceOrdinal: candidate.sourceOrdinal,
      signalTimestamp: candidate.signalTimestamp,
      deterministicScore: candidate.deterministicScore,
      decisionAt: candidate.decisionAt,
      prediction: null,
      predictionIdentityValid: false,
      unavailableReason: reason,
    })),
    identities: new Map(),
  };
}

export async function predictFundedComparisonBatch(
  request: FundedComparisonPredictionRequest,
  engine: FundedComparisonInferenceEngine,
): Promise<FundedComparisonPredictionBatch> {
  const { specification, challenger } = request;
  const modelId = specification.challenger.model.modelId;
  const modelIdentity = {
    modelId,
    modelVersion: challenger.modelVersion,
    modelType: FUNDED_EXECUTION_MODEL_TYPE,
    artifactDigest: challenger.artifactDigest,
    cohortDigest: challenger.cohortDigest,
    featureVersion: FUNDED_EXECUTION_FEATURE_VERSION,
  } as const;
  const inputs: {
    runId: string;
    observationId: string;
    decisionSequence: number;
    decisionInputDigest: string;
    features: ReturnType<typeof extractFundedExecutionFeatures>;
  }[] = [];
  for (const candidate of request.candidates) {
    const decision = request.championDecisions.get(
      candidate.sourceOpportunityId,
    );
    if (
      !decision ||
      decision.observation_id !== candidate.observationId ||
      decision.evidence_schema_version !== 2 ||
      decision.source_kind !== "HISTORICAL_REPLAY"
    )
      return fallbackBatch(request, "PREDICTION_DECISION_UNAVAILABLE");
    if (
      decision.cohort_digest !== challenger.cohortDigest ||
      decision.market_id !== specification.marketId ||
      decision.currency !== specification.currency
    )
      return fallbackBatch(request, "MODEL_IDENTITY_MISMATCH");
    const decisionContent = fundedDecisionTimeInputSchema.safeParse(
      decision.decision_content,
    );
    if (!decisionContent.success)
      return fallbackBatch(request, "PREDICTION_DECISION_UNAVAILABLE");
    if (decisionContent.data.observationId !== candidate.observationId)
      return fallbackBatch(request, "PREDICTION_DECISION_UNAVAILABLE");
    inputs.push({
      runId: decision.run_id,
      observationId: decision.observation_id,
      decisionSequence: decision.sequence,
      decisionInputDigest: decision.content_digest,
      features: extractFundedExecutionFeatures({
        decision: decisionContent.data,
        marketId: specification.marketId as MarketId,
      }),
    });
  }
  const payload = fundedExecutionInferenceInputSchema.parse({
    requestVersion: "funded-execution-inference-v1",
    marketId: specification.marketId,
    currency: specification.currency,
    model: modelIdentity,
    artifact: challenger.artifact,
    inputs,
  });
  let output;
  try {
    output = fundedExecutionInferenceOutputSchema.parse(
      await engine.predictFundedExecution(payload),
    );
  } catch {
    return fallbackBatch(request, "INFERENCE_FAILED");
  }
  if (
    output.marketId !== specification.marketId ||
    output.currency !== specification.currency ||
    JSON.stringify(output.model) !== JSON.stringify(modelIdentity)
  )
    return fallbackBatch(request, "MODEL_IDENTITY_MISMATCH");
  if (output.predictions.length !== inputs.length)
    return fallbackBatch(request, "INVALID_DIAGNOSTIC");
  const byObservation = new Map(
    output.predictions.map((prediction) => [
      prediction.observationId,
      prediction,
    ]),
  );
  const identities = new Map<string, FundedComparisonPredictionIdentity>();
  const candidates: FundedComparisonChallengerCandidate[] = [];
  let complete = true;
  for (const [index, candidate] of request.candidates.entries()) {
    const input = inputs[index]!;
    const prediction = byObservation.get(input.observationId);
    if (
      !prediction ||
      prediction.runId !== input.runId ||
      prediction.decisionSequence !== input.decisionSequence ||
      prediction.decisionInputDigest !== input.decisionInputDigest
    ) {
      candidates.push({
        sourceOpportunityId: candidate.sourceOpportunityId,
        sourceOrdinal: candidate.sourceOrdinal,
        signalTimestamp: candidate.signalTimestamp,
        deterministicScore: candidate.deterministicScore,
        decisionAt: candidate.decisionAt,
        prediction: null,
        predictionIdentityValid: false,
        unavailableReason: "INVALID_DIAGNOSTIC",
      });
      complete = false;
      continue;
    }
    const diagnostic = {
      expectedFillFraction: prediction.output.expectedFillFraction.value,
      expectedTotalExecutionCost:
        prediction.output.expectedTotalExecutionCost.value,
      expectedSlippagePerShare:
        prediction.output.expectedSlippagePerShare.value,
    };
    // Frozen units: fill fraction in [0,1]; cost and slippage are market-currency
    // nonnegative amounts. An out-of-range diagnostic is invalid, never clamped.
    if (
      !Number.isFinite(diagnostic.expectedFillFraction) ||
      diagnostic.expectedFillFraction < 0 ||
      diagnostic.expectedFillFraction > 1 ||
      !Number.isFinite(diagnostic.expectedTotalExecutionCost) ||
      diagnostic.expectedTotalExecutionCost < 0 ||
      !Number.isFinite(diagnostic.expectedSlippagePerShare) ||
      diagnostic.expectedSlippagePerShare < 0
    )
      return fallbackBatch(request, "INVALID_DIAGNOSTIC");
    const identity: FundedComparisonPredictionIdentity = {
      runId: input.runId,
      observationId: input.observationId,
      decisionSequence: input.decisionSequence,
      decisionInputDigest: input.decisionInputDigest,
      modelId,
      modelVersion: challenger.modelVersion,
      modelType: FUNDED_EXECUTION_MODEL_TYPE,
      artifactDigest: challenger.artifactDigest,
      cohortDigest: challenger.cohortDigest,
      featureVersion: FUNDED_EXECUTION_FEATURE_VERSION,
      inputDigest: contentHash(input),
      outputDigest: contentHash(prediction.output),
    };
    identities.set(candidate.sourceOpportunityId, identity);
    candidates.push({
      sourceOpportunityId: candidate.sourceOpportunityId,
      sourceOrdinal: candidate.sourceOrdinal,
      signalTimestamp: candidate.signalTimestamp,
      deterministicScore: candidate.deterministicScore,
      decisionAt: candidate.decisionAt,
      prediction: diagnostic,
      predictionIdentityValid: true,
      unavailableReason: null,
    });
  }
  if (
    !complete ||
    candidates.some((candidate) => candidate.prediction === null)
  )
    return fallbackBatch(request, "INVALID_DIAGNOSTIC");
  return {
    batchKey: request.signalTimestamp,
    batchFallback: false,
    candidates,
    identities,
  };
}
