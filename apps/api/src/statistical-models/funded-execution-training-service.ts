import { z } from "zod";
import {
  FUNDED_EXECUTION_ARTIFACT_VERSION,
  FUNDED_EXECUTION_DATASET_POLICY_VERSION,
  FUNDED_EXECUTION_FEATURE_NAMES,
  FUNDED_EXECUTION_FEATURE_VERSION,
  FUNDED_EXECUTION_LABEL_MAPPING_VERSION,
  FUNDED_EXECUTION_QUALIFICATION_POLICY_VERSION,
  FUNDED_EXECUTION_TRAINING_POLICY_VERSION,
  fundedCohortIdentitySchema,
  fundedExecutionChallengerSchema,
  fundedExecutionTrainingRequestSchema,
  fundedExecutionTrainingResultSchema,
  marketIdSchema,
  type FundedCohortIdentity,
  type FundedExecutionChallenger,
  type FundedExecutionDatasetManifest,
  type FundedExecutionQualificationReceipt,
  type FundedExecutionTrainingResult,
} from "@tsx-scanner/contracts";
import {
  contentHash,
  fundedExecutionArtifactDigest,
  fundedExecutionDatasetDigest,
  fundedExecutionMembershipDigest,
  fundedExecutionTrainingPartitionDigest,
} from "./funded-execution-digest.js";
import {
  qualifyFundedExecutionRows,
  type FundedExecutionQualifiedRow,
} from "./funded-execution-qualification.js";
import type {
  FundedExecutionChallengerDraft,
  FundedExecutionMemberDraft,
  FundedExecutionTrainingStore,
} from "./funded-execution-training-repository.js";

/**
 * Funded-execution dataset materialization and inactive challenger training
 * (FP02). Qualification and training never write an order, ledger, reservation,
 * profile, policy or activation row. Training completion changes nothing
 * outside the funded-execution learning tables.
 */

export const FUNDED_EXECUTION_TRAINING_POLICY = {
  version: FUNDED_EXECUTION_TRAINING_POLICY_VERSION,
  trainPct: 80,
  minimumSamples: 200,
  l2Penalty: 0.1,
} as const;

export const fundedExecutionTrainingJobSchema = z
  .object({
    sourceKind: z.literal("FUNDED_EXECUTION"),
    datasetId: z.string().uuid(),
    marketId: marketIdSchema,
    cohort: fundedCohortIdentitySchema,
  })
  .strict();
export type FundedExecutionTrainingJob = z.infer<
  typeof fundedExecutionTrainingJobSchema
>;

export interface FundedExecutionTrainingClient {
  trainFundedExecution(
    payload: unknown,
  ): Promise<FundedExecutionTrainingResult>;
}

export interface FundedExecutionTrainingRuntimeIdentity {
  current(): Promise<{ runtimeFingerprint: string } | null>;
}

export interface FundedExecutionMaterialization {
  receipt: FundedExecutionQualificationReceipt;
  dataset: FundedExecutionDatasetManifest | null;
}

export class FundedExecutionTrainingService {
  constructor(
    private readonly store: FundedExecutionTrainingStore,
    private readonly client: FundedExecutionTrainingClient,
    private readonly runtimeIdentity?: FundedExecutionTrainingRuntimeIdentity,
  ) {}

  listCohorts() {
    return this.store.listCohorts();
  }

  countDatasets() {
    return this.store.countDatasets();
  }

  getDataset(id: string) {
    return this.store.getDataset(id);
  }

  latestDatasetFor(cohortDigest: string) {
    return this.store.latestDatasetFor(cohortDigest);
  }

  datasetMembers(id: string) {
    return this.store.listDatasetMembers(id);
  }

  listChallengers(marketId?: string) {
    return this.store.listChallengers(marketId);
  }

  findChallengerByDatasetDigest(datasetDigest: string) {
    return this.store.findChallengerByDatasetDigest(datasetDigest);
  }

  /**
   * Freeze one qualified dataset at a requested cutoff, or return the visible
   * unqualified receipt. Historical-replay datasets are materialized as
   * isolated, non-activation-eligible research artifacts.
   */
  async materialize(
    cohort: FundedCohortIdentity,
    requestedCutoff: Date,
  ): Promise<FundedExecutionMaterialization> {
    const rows = await this.store.assembledRowsFor(
      cohort.cohortDigest,
      requestedCutoff,
    );
    const prior = await this.store.latestDatasetFor(cohort.cohortDigest);
    // The 50-new-outcome gate compares stable member identities, not row
    // counts: corrections or changed row content for an existing decision are
    // not new outcomes, and removed prior members never subtract.
    const priorMemberKeys = prior
      ? new Set(
          (await this.store.listDatasetMembers(prior.id)).map(
            (member) =>
              `${member.identity.runId}:${member.identity.observationId}`,
          ),
        )
      : null;

    // Exact retry: when the current evidence snapshot and effective cutoff
    // match the latest frozen dataset, return that dataset unchanged instead of
    // re-evaluating the 50-new-outcome gate.
    const snapshot = qualifyFundedExecutionRows({
      cohort,
      rows,
      requestedCutoff,
      priorDataset: null,
    });
    if (snapshot.receipt.qualified) {
      const snapshotMembers = snapshot.qualifiedRows.map((row, ordinal) =>
        memberDraft(row, ordinal),
      );
      const snapshotMembership = fundedExecutionMembershipDigest(
        snapshotMembers.map((member) => member.rowDigest),
      );
      const snapshotEffective =
        latestTimestamp(
          snapshot.qualifiedRows.map((row) => row.labels!.labelAvailableAt),
        ) ?? requestedCutoff.toISOString();
      if (
        prior &&
        prior.membershipDigest === snapshotMembership &&
        prior.effectiveCutoff === snapshotEffective
      )
        return { receipt: snapshot.receipt, dataset: prior };
    }

    const result = qualifyFundedExecutionRows({
      cohort,
      rows,
      requestedCutoff,
      priorDataset:
        prior && priorMemberKeys
          ? {
              id: prior.id,
              memberIdentityKeys: priorMemberKeys,
              includedRowCount:
                prior.qualificationReceipt.counts.includedRowCount,
            }
          : null,
    });
    if (!result.receipt.qualified) {
      return { receipt: result.receipt, dataset: null };
    }
    const activationEligible =
      cohort.sourceKind === "LIVE_PAPER" && result.receipt.liveRunRequired;
    const members = result.qualifiedRows.map((row, ordinal) =>
      memberDraft(row, ordinal),
    );
    const rowDigests = members.map((member) => member.rowDigest);
    const membershipDigest = fundedExecutionMembershipDigest(rowDigests);
    const trainingPartitionDigest = fundedExecutionTrainingPartitionDigest(
      members
        .filter((member) => member.partition === "TRAIN")
        .map((member) => member.rowDigest),
    );
    const included = result.qualifiedRows;
    const effectiveCutoffIso =
      latestTimestamp(included.map((row) => row.labels!.labelAvailableAt)) ??
      requestedCutoff.toISOString();
    const effectiveCutoff = new Date(effectiveCutoffIso);
    const sourceWatermark = {
      latestDecisionAt: latestTimestamp(included.map((row) => row.decisionAt)),
      latestLabelAvailableAt: latestTimestamp(
        included.map((row) => row.labels!.labelAvailableAt),
      ),
      latestEconomicOutcomeAt: latestTimestamp(
        included.map((row) => row.labels!.economicOutcomeAt),
      ),
      decisionCount: rows.length,
      outcomeVersionCount: included.reduce(
        (total, row) => total + row.outcomeSequences.length,
        0,
      ),
    };
    // The digest covers the frozen membership and counts only: prior-dependent
    // receipt fields are excluded so the same cutoff and evidence reproduce the
    // same digest regardless of how many datasets preceded it.
    const datasetDigest = fundedExecutionDatasetDigest({
      datasetPolicyVersion: FUNDED_EXECUTION_DATASET_POLICY_VERSION,
      labelMappingVersion: FUNDED_EXECUTION_LABEL_MAPPING_VERSION,
      featureVersion: FUNDED_EXECUTION_FEATURE_VERSION,
      qualificationPolicyVersion: FUNDED_EXECUTION_QUALIFICATION_POLICY_VERSION,
      cohortDigest: cohort.cohortDigest,
      marketId: cohort.marketId,
      currency: cohort.currency,
      sourceKind: cohort.sourceKind,
      effectiveCutoff: effectiveCutoff.toISOString(),
      membershipDigest,
      counts: result.receipt.counts,
      trainingPartitionDigest,
    });
    const dataset = await this.store.createDataset({
      requestedCutoff,
      effectiveCutoff,
      cohort,
      sourceKind: cohort.sourceKind,
      datasetDigest,
      membershipDigest,
      datasetPolicyVersion: FUNDED_EXECUTION_DATASET_POLICY_VERSION,
      labelMappingVersion: FUNDED_EXECUTION_LABEL_MAPPING_VERSION,
      featureVersion: FUNDED_EXECUTION_FEATURE_VERSION,
      qualificationPolicyVersion: FUNDED_EXECUTION_QUALIFICATION_POLICY_VERSION,
      counts: result.receipt.counts,
      receipt: result.receipt,
      sourceWatermark,
      activationEligible,
      members,
    });
    return { receipt: result.receipt, dataset };
  }

  /**
   * Train one inactive challenger for one frozen dataset digest. The attempt is
   * idempotent: an existing challenger or a deterministic insufficient-data
   * result is returned without a second artifact.
   */
  async train(datasetId: string): Promise<FundedExecutionChallenger> {
    const dataset = await this.store.getDataset(datasetId);
    if (!dataset) throw new Error("Funded execution dataset does not exist");
    const existing = await this.store.findChallengerByDatasetDigest(
      dataset.datasetDigest,
    );
    if (existing) return existing;
    const members = await this.store.listDatasetMembers(datasetId);
    if (members.length === 0)
      throw new Error("Funded execution dataset has no members");
    const trainingRows = members.map((member) => ({
      marketId: member.marketId,
      currency: member.currency,
      runId: member.identity.runId,
      observationId: member.identity.observationId,
      decisionSequence: member.identity.decisionSequence,
      decisionContentDigest: member.identity.decisionContentDigest,
      decisionAt: member.decisionAt,
      sessionDate: member.sessionDate,
      partition: member.partition,
      features: member.features,
      labels: member.labels,
      rowDigest: member.rowDigest,
    }));
    const trainingPartitionDigest = fundedExecutionTrainingPartitionDigest(
      members
        .filter((member) => member.partition === "TRAIN")
        .map((member) => member.rowDigest),
    );
    const request = fundedExecutionTrainingRequestSchema.parse({
      requestVersion: "funded-execution-training-v1",
      marketId: dataset.marketId,
      currency: dataset.currency,
      cohortDigest: dataset.cohort.cohortDigest,
      datasetDigest: dataset.datasetDigest,
      membershipDigest: dataset.membershipDigest,
      trainingPartitionDigest,
      featureVersion: FUNDED_EXECUTION_FEATURE_VERSION,
      labelMappingVersion: FUNDED_EXECUTION_LABEL_MAPPING_VERSION,
      featureNames: [...FUNDED_EXECUTION_FEATURE_NAMES],
      sourceKind: dataset.sourceKind,
      rows: trainingRows,
    });
    const response = fundedExecutionTrainingResultSchema.parse(
      await this.client.trainFundedExecution(request),
    );
    const runtime = (await this.runtimeIdentity?.current()) ?? null;
    if (response.status !== "COMPLETED" || !response.artifact) {
      return this.store.persistChallenger(
        failedChallengerDraft(dataset, response, runtime, trainingRows),
      );
    }
    const recomputed = fundedExecutionArtifactDigest(response.artifact);
    if (recomputed !== response.artifactDigest)
      throw new Error("FUNDED_EXECUTION_ARTIFACT_DIGEST_MISMATCH");
    if (response.artifact.sourceDatasetDigest !== dataset.datasetDigest)
      throw new Error("FUNDED_EXECUTION_ARTIFACT_DATASET_MISMATCH");
    if (response.artifact.trainingPartitionDigest !== trainingPartitionDigest)
      throw new Error("FUNDED_EXECUTION_ARTIFACT_PARTITION_MISMATCH");
    if (response.artifact.featureVersion !== FUNDED_EXECUTION_FEATURE_VERSION)
      throw new Error("FUNDED_EXECUTION_ARTIFACT_FEATURE_VERSION_MISMATCH");
    const draft: FundedExecutionChallengerDraft = {
      marketId: dataset.marketId,
      currency: dataset.currency,
      cohort: dataset.cohort,
      datasetId: dataset.id,
      datasetDigest: dataset.datasetDigest,
      modelVersion: FUNDED_EXECUTION_ARTIFACT_VERSION,
      artifactDigest: recomputed,
      trainingCodeVersion: "funded-execution-trainer-v1",
      runtimeFingerprint: runtime?.runtimeFingerprint ?? null,
      status: "INACTIVE",
      artifact: response.artifact,
      metrics: artifactMetrics(response.artifact),
      sampleCounts: {
        trainingRows: trainingRows.filter((row) => row.partition === "TRAIN")
          .length,
        testRows: trainingRows.filter((row) => row.partition === "TEST").length,
        fillRows: response.artifact.trainingFillRowCount,
        costRows: response.artifact.trainingCostRowCount,
      },
      failureReceipt: null,
    };
    return this.store.persistChallenger(draft);
  }
}

function memberDraft(
  row: FundedExecutionQualifiedRow,
  ordinal: number,
): FundedExecutionMemberDraft {
  const content = {
    identity: {
      marketId: row.marketId,
      currency: row.currency,
      accountId: row.accountId,
      runId: row.runId,
      observationId: row.observationId,
      decisionSequence: row.decisionSequence,
      decisionContentDigest: row.decisionContentDigest,
      cohortDigest: row.cohortDigest,
      evidenceSchemaVersion: 2,
      outcomeSequences: [...row.outcomeSequences],
      outcomeSourceDigests: [...row.outcomeSourceDigests],
    },
    instrumentId: row.instrumentId,
    decisionAt: row.decisionAt,
    sessionDate: row.sessionDate,
    partition: row.partition,
    features: row.features,
    labels: row.labels,
    sourceKind: row.sourceKind,
    labelMappingVersion: FUNDED_EXECUTION_LABEL_MAPPING_VERSION,
    featureVersion: FUNDED_EXECUTION_FEATURE_VERSION,
  };
  return {
    ordinal,
    marketId: row.marketId,
    currency: row.currency,
    runId: row.runId,
    observationId: row.observationId,
    accountId: row.accountId,
    decisionSequence: row.decisionSequence,
    decisionContentDigest: row.decisionContentDigest,
    cohortDigest: row.cohortDigest,
    instrumentId: row.instrumentId,
    decisionAt: row.decisionAt,
    sessionDate: row.sessionDate,
    partition: row.partition,
    labelAvailableAt: row.labels!.labelAvailableAt,
    labelEconomicAt: row.labels!.economicOutcomeAt,
    sourceKind: row.sourceKind,
    features: row.features,
    labels: row.labels,
    outcomeSequences: row.outcomeSequences,
    outcomeSourceDigests: row.outcomeSourceDigests,
    rowDigest: contentHash(content),
  };
}

function failedChallengerDraft(
  dataset: FundedExecutionDatasetManifest,
  response: FundedExecutionTrainingResult,
  runtime: { runtimeFingerprint: string } | null,
  rows: readonly { partition: string }[],
): FundedExecutionChallengerDraft {
  const failureReceipt =
    response.warnings.join("; ") ||
    "Funded execution training returned no artifact";
  return {
    marketId: dataset.marketId,
    currency: dataset.currency,
    cohort: dataset.cohort,
    datasetId: dataset.id,
    datasetDigest: dataset.datasetDigest,
    modelVersion: FUNDED_EXECUTION_ARTIFACT_VERSION,
    artifactDigest: contentHash({
      status: "FAILED",
      datasetDigest: dataset.datasetDigest,
      failureReceipt,
    }),
    trainingCodeVersion: "funded-execution-trainer-v1",
    runtimeFingerprint: runtime?.runtimeFingerprint ?? null,
    status: "FAILED",
    artifact: null,
    metrics: null,
    sampleCounts: {
      trainingRows: rows.filter((row) => row.partition === "TRAIN").length,
      testRows: rows.filter((row) => row.partition === "TEST").length,
    },
    failureReceipt,
  };
}

function artifactMetrics(artifact: {
  outputs: readonly {
    output: string;
    trainMetrics: unknown;
    testMetrics: unknown;
  }[];
  trainingRowCount: number;
  trainingFillRowCount: number;
  trainingCostRowCount: number;
}): Record<string, unknown> {
  const outputs: Record<string, unknown> = {};
  for (const head of artifact.outputs)
    outputs[head.output] = {
      train: head.trainMetrics,
      test: head.testMetrics,
    };
  return {
    trainingRowCount: artifact.trainingRowCount,
    trainingFillRowCount: artifact.trainingFillRowCount,
    trainingCostRowCount: artifact.trainingCostRowCount,
    outputs,
  };
}

function latestTimestamp(values: readonly string[]): string | null {
  let latest: number | null = null;
  for (const value of values) {
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) continue;
    if (latest === null || parsed > latest) latest = parsed;
  }
  return latest === null ? null : new Date(latest).toISOString();
}

export function assertInactiveChallenger(
  challenger: unknown,
): FundedExecutionChallenger {
  return fundedExecutionChallengerSchema.parse(challenger);
}
