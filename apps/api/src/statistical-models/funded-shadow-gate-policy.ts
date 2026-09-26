import {
  FUNDED_COMPARISON_CHALLENGER_POLICY_VERSION,
  FUNDED_EXECUTION_FEATURE_VERSION,
  FUNDED_EXECUTION_MODEL_TYPE,
  FUNDED_SHADOW_GATE_POLICY_VERSION,
  FUNDED_SHADOW_MAX_PREDICTION_LAG_MS,
  FUNDED_SHADOW_WINDOW,
  fundedComparisonChallengerPolicyIdentitySchema,
  fundedExecutionModelArtifactSchema,
  fundedShadowGatePolicySchema,
  type FundedShadowEnrollment,
  type FundedShadowGatePolicy,
  type FundedShadowGatePolicyDraft,
  type FundedShadowStageBApproval,
  type MarketId,
} from "@tsx-scanner/contracts";
import type { Pool } from "pg";
import { fundedComparisonChallengerPolicyDigest } from "../paper-bot/funded-comparison-challenger-policy.js";
import { fundedExecutionArtifactDigest } from "./funded-execution-digest.js";
import { FundedShadowError } from "./funded-shadow-repository.js";
import { fundedShadowGatePolicyDigest } from "./funded-shadow-digest.js";
import type { FundedComparisonTrainingWindow } from "../paper-bot/funded-comparison-specification.js";
import { loadFundedComparisonTrainingLineage } from "../paper-bot/funded-comparison-prediction.js";

/**
 * FP04 gate-policy construction and frozen-identity loading.
 *
 * The Stage B approval reference is operator-supplied evidence. FP04 validates
 * its completeness and freezes it; it can never create or infer the approval,
 * and it carries no authority transition of its own.
 */

export interface FundedShadowGatePolicyInput {
  readonly marketId: MarketId;
  readonly stageBApproval: FundedShadowStageBApproval;
  readonly maxPredictionLagMs?: number;
  readonly window?: FundedShadowGatePolicyDraft["window"];
  /** Operator ceiling; a larger requested lag is refused, not clamped. */
  readonly maxPredictionLagMsCeiling?: number;
}

export function buildFundedShadowGatePolicy(
  input: FundedShadowGatePolicyInput,
): FundedShadowGatePolicy {
  const requestedLag =
    input.maxPredictionLagMs ?? FUNDED_SHADOW_MAX_PREDICTION_LAG_MS;
  if (
    input.maxPredictionLagMsCeiling !== undefined &&
    requestedLag > input.maxPredictionLagMsCeiling
  )
    throw new FundedShadowError(
      "FUNDED_SHADOW_LAG_CEILING_EXCEEDED",
      "The requested prediction lag exceeds the configured FP04 ceiling",
    );
  const draft: FundedShadowGatePolicyDraft = {
    gatePolicyVersion: FUNDED_SHADOW_GATE_POLICY_VERSION,
    marketId: input.marketId,
    currency: input.marketId === "CA_TSX" ? "CAD" : "USD",
    stageBApproval: input.stageBApproval,
    window: input.window ?? { ...FUNDED_SHADOW_WINDOW },
    challengerPolicyVersion: FUNDED_COMPARISON_CHALLENGER_POLICY_VERSION,
    maxPredictionLagMs: requestedLag,
  };
  // Zod v4 cannot omit a field from a refined schema, so the draft is validated
  // with a placeholder digest and the canonical digest is recomputed from the
  // parsed payload without that placeholder.
  const parsed = fundedShadowGatePolicySchema.parse({
    ...draft,
    gatePolicyDigest: "0".repeat(64),
  });
  const { gatePolicyDigest: _placeholder, ...payload } = parsed;
  return fundedShadowGatePolicySchema.parse({
    ...payload,
    gatePolicyDigest: fundedShadowGatePolicyDigest(payload),
  });
}

export interface FundedShadowChallengerRecord {
  readonly challengerId: string;
  readonly modelVersion: string;
  readonly artifactDigest: string;
  readonly cohortDigest: string;
  readonly datasetDigest: string;
  readonly featureVersion: string;
  readonly artifact: ReturnType<
    typeof fundedExecutionModelArtifactSchema.parse
  >;
  readonly training: FundedComparisonTrainingWindow;
}

export interface FundedShadowChallengerIdentityInput {
  readonly modelId: string;
  readonly marketId: MarketId;
  readonly currency: "CAD" | "USD";
}

/**
 * Loads and re-proves the exact inactive challenger artifact, dataset, cohort,
 * feature and training lineage identities by model id. A missing, failed,
 * active or mismatched challenger fails closed; FP04 never substitutes a
 * different model.
 */
export async function loadFundedShadowChallengerById(
  pool: Pool,
  input: FundedShadowChallengerIdentityInput,
): Promise<FundedShadowChallengerRecord> {
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
    [input.modelId, input.marketId, input.currency],
  );
  const row = rows[0];
  if (!row || row.status !== "INACTIVE" || row.artifact === null)
    throw new FundedShadowError(
      "MODEL_NOT_FOUND",
      "The challenger is not an accessible inactive artifact",
    );
  const artifact = fundedExecutionModelArtifactSchema.parse(row.artifact);
  if (fundedExecutionArtifactDigest(artifact) !== row.artifact_digest)
    throw new FundedShadowError(
      "MODEL_IDENTITY_MISMATCH",
      "The retained challenger artifact does not match its persisted digest",
    );
  if (artifact.sourceDatasetDigest !== row.dataset_digest)
    throw new FundedShadowError(
      "MODEL_IDENTITY_MISMATCH",
      "The retained challenger artifact was trained on another dataset",
    );
  const training = await loadFundedComparisonTrainingLineage(
    pool,
    row.dataset_id,
  );
  if (training.trainingPartitionDigest !== artifact.trainingPartitionDigest)
    throw new FundedShadowError(
      "MODEL_IDENTITY_MISMATCH",
      "The retained FP02 training lineage does not match the challenger artifact",
    );
  return {
    challengerId: input.modelId,
    modelVersion: row.model_version,
    artifactDigest: row.artifact_digest,
    cohortDigest: row.cohort_digest,
    datasetDigest: row.dataset_digest,
    featureVersion: row.feature_version,
    artifact,
    training,
  };
}

/** Builds the frozen challenger policy identity for one loaded challenger. */
export function fundedShadowChallengerPolicyIdentity(
  record: FundedShadowChallengerRecord,
): FundedShadowEnrollment["challenger"] {
  return fundedComparisonChallengerPolicyIdentitySchema.parse({
    kind: "FUNDED_EXECUTION_POLICY_V1",
    policyVersion: FUNDED_COMPARISON_CHALLENGER_POLICY_VERSION,
    policyDigest: fundedComparisonChallengerPolicyDigest(),
    model: {
      modelId: record.challengerId,
      modelVersion: record.modelVersion,
      artifactDigest: record.artifactDigest,
      datasetDigest: record.datasetDigest,
      cohortDigest: record.cohortDigest,
      featureVersion: record.featureVersion,
      predictionPolicyVersion: "funded-execution-prediction-v1",
      trainingPartitionDigest: record.training.trainingPartitionDigest,
      trainingEvidenceCutoffAt: record.training.trainingKnowledgeCutoffAt,
      trainingSessionDigest: record.training.trainingSessionDigest,
    },
  });
}

/**
 * Loads the exact inactive challenger frozen by the enrollment and re-proves
 * every identity. A missing, failed, active or mismatched challenger fails
 * closed.
 */
export async function loadFundedShadowChallenger(
  pool: Pool,
  enrollment: FundedShadowEnrollment,
): Promise<FundedShadowChallengerRecord> {
  const model = enrollment.challenger.model;
  const record = await loadFundedShadowChallengerById(pool, {
    modelId: model.modelId,
    marketId: enrollment.marketId,
    currency: enrollment.currency,
  });
  if (
    record.cohortDigest !== model.cohortDigest ||
    record.datasetDigest !== model.datasetDigest ||
    record.featureVersion !== model.featureVersion ||
    record.modelVersion !== model.modelVersion ||
    record.artifactDigest !== model.artifactDigest ||
    record.training.trainingPartitionDigest !== model.trainingPartitionDigest ||
    record.training.trainingKnowledgeCutoffAt !==
      model.trainingEvidenceCutoffAt ||
    record.training.trainingSessionDigest !== model.trainingSessionDigest
  )
    throw new FundedShadowError(
      "MODEL_IDENTITY_MISMATCH",
      "The retained challenger no longer matches the enrolled model identity",
    );
  return record;
}

/** The exact FP02 inference model identity for one enrolled challenger. */
export function fundedShadowInferenceModelIdentity(
  enrollment: FundedShadowEnrollment,
): {
  modelId: string;
  modelVersion: string;
  modelType: typeof FUNDED_EXECUTION_MODEL_TYPE;
  artifactDigest: string;
  cohortDigest: string;
  featureVersion: typeof FUNDED_EXECUTION_FEATURE_VERSION;
} {
  return {
    modelId: enrollment.challenger.model.modelId,
    modelVersion: enrollment.challenger.model.modelVersion,
    modelType: FUNDED_EXECUTION_MODEL_TYPE,
    artifactDigest: enrollment.challenger.model.artifactDigest,
    cohortDigest: enrollment.challenger.model.cohortDigest,
    featureVersion: FUNDED_EXECUTION_FEATURE_VERSION,
  };
}

/**
 * Validates the frozen challenger policy identity exactly as enrolled. The
 * approved FP03 ordering rule is the only policy FP04 may apply.
 */
export function verifyFundedShadowChallengerPolicy(
  enrollment: FundedShadowEnrollment,
): void {
  const parsed = fundedComparisonChallengerPolicyIdentitySchema.parse(
    enrollment.challenger,
  );
  if (parsed.policyVersion !== FUNDED_COMPARISON_CHALLENGER_POLICY_VERSION)
    throw new FundedShadowError(
      "MODEL_IDENTITY_MISMATCH",
      "The enrollment does not name the approved challenger ordering policy",
    );
  if (parsed.policyDigest !== fundedComparisonChallengerPolicyDigest())
    throw new FundedShadowError(
      "MODEL_IDENTITY_MISMATCH",
      "The enrollment retains an invalid challenger policy digest",
    );
}
