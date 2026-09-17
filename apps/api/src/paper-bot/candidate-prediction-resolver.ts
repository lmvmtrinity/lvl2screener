import { createHash } from "node:crypto";
import {
  featureSnapshotSchema,
  type PaperEvidenceCohort,
  type StatisticalPredictionInput,
} from "@tsx-scanner/contracts";
import type { CandidatePrediction } from "./coordination-policy.js";
import type { PaperSignalObservation } from "./paper-bot-repository.js";
import type { StatisticalModelStore } from "../statistical-models/statistical-model-repository.js";
import type { StatisticalModelEngine } from "../statistical-models/statistical-model-service.js";
import type { PaperEvidenceTrainingStore } from "../statistical-models/paper-evidence-training-repository.js";
import type { AssumptionsSnapshot, QuoteFact } from "./types.js";
import { AUTHORITATIVE_EXECUTION_MODEL_VERSION } from "../backtests/execution-provenance.js";

export interface CandidatePredictionResolver {
  resolveCandidatePrediction(
    observation: PaperSignalObservation,
    quoteAtSignal: QuoteFact | null,
    targetNetR?: number | null,
  ): Promise<CandidatePrediction>;
}

export function estimateConditionalPayoffs(
  rows: readonly { rMultiple: number }[],
  baselineRows: readonly { rMultiple: number }[],
): {
  winExpectedR: number;
  lossExpectedR: number;
  sampleCount: number;
  priorSampleCount: number;
} | null {
  if (rows.length === 0 || baselineRows.length === 0) return null;
  const wins = rows.filter((r) => r.rMultiple > 0).map((r) => r.rMultiple);
  const losses = rows.filter((r) => r.rMultiple <= 0).map((r) => r.rMultiple);
  const baselineWins = baselineRows
    .filter((r) => r.rMultiple > 0)
    .map((r) => r.rMultiple);
  const baselineLosses = baselineRows
    .filter((r) => r.rMultiple <= 0)
    .map((r) => r.rMultiple);
  // Do not manufacture a payoff for a one-sided or unavailable prior cohort.
  if (baselineWins.length === 0 || baselineLosses.length === 0) return null;

  const K = 5;
  const baselineWinR =
    baselineWins.reduce((sum, r) => sum + r, 0) / baselineWins.length;
  const baselineLossR =
    baselineLosses.reduce((sum, r) => sum + r, 0) / baselineLosses.length;

  const winSum = wins.reduce((sum, r) => sum + r, 0);
  const lossSum = losses.reduce((sum, r) => sum + r, 0);

  const winExpectedR = (winSum + K * baselineWinR) / (wins.length + K);
  const lossExpectedR = (lossSum + K * baselineLossR) / (losses.length + K);

  return {
    winExpectedR: Math.round(winExpectedR * 1000) / 1000,
    lossExpectedR: Math.round(lossExpectedR * 1000) / 1000,
    sampleCount: rows.length,
    priorSampleCount: baselineRows.length,
  };
}

export class ModelInformedPredictionResolver implements CandidatePredictionResolver {
  constructor(
    private readonly models: StatisticalModelStore,
    private readonly engine: StatisticalModelEngine,
    private readonly evidenceStore?: PaperEvidenceTrainingStore,
    private readonly assumptions?: AssumptionsSnapshot,
  ) {}

  async resolveCandidatePrediction(
    observation: PaperSignalObservation,
    _quoteAtSignal: QuoteFact | null,
    _targetNetR?: number | null,
  ): Promise<CandidatePrediction> {
    const activeModels = await this.models.listActive();
    const model = activeModels.find(
      (m) =>
        m.marketId === observation.marketId &&
        m.strategy === observation.strategyKey &&
        m.artifact,
    );

    if (!model || !model.artifact) {
      return {
        fallbackReason: "NO_ACTIVE_MODEL",
      };
    }

    // A strategy name is not a compatible evidence cohort.  In particular,
    // profiles and execution assumptions must never share a challenger.
    if (
      !this.evidenceStore ||
      !this.evidenceStore.compatibleBaselineRowsFor ||
      !this.assumptions ||
      !model.trainingDatasetId
    ) {
      return {
        modelId: model.id,
        modelVersion: model.modelVersion,
        fallbackReason: "MODEL_COHORT_UNAVAILABLE",
      };
    }
    const cohort: PaperEvidenceCohort = {
      marketId: model.marketId,
      strategy: observation.strategyKey as PaperEvidenceCohort["strategy"],
      strategyVersion: observation.strategyVersion,
      profileConfigId: observation.profileConfigId,
      configVersion: observation.configVersion,
      executionModelVersion: AUTHORITATIVE_EXECUTION_MODEL_VERSION,
      assumptions: this.assumptions as unknown as Record<string, unknown>,
      closedQuoteCount: 0,
      positives: 0,
      negatives: 0,
      firstSignalAt: null,
      lastSignalAt: null,
      missingFeatureCount: 0,
    };
    let dataset;
    try {
      dataset = await this.evidenceStore.getDataset(model.trainingDatasetId);
    } catch {
      return {
        modelId: model.id,
        modelVersion: model.modelVersion,
        fallbackReason: "MODEL_COHORT_UNAVAILABLE",
      };
    }
    if (!dataset || !sameCohort(dataset.cohort, cohort)) {
      return {
        modelId: model.id,
        modelVersion: model.modelVersion,
        fallbackReason: "MODEL_COHORT_MISMATCH",
      };
    }

    let atrPct: number | null = null;
    let rvolAtTime: number | null = null;

    const fullFeatures = featureSnapshotSchema.safeParse(
      observation.featureSnapshot,
    );
    if (fullFeatures.success) {
      atrPct = fullFeatures.data.atrPct;
      rvolAtTime = fullFeatures.data.rvolAtTime;
    } else if (
      typeof observation.featureSnapshot === "object" &&
      observation.featureSnapshot !== null
    ) {
      const snap = observation.featureSnapshot as Record<string, unknown>;
      atrPct = typeof snap.atrPct === "number" ? snap.atrPct : null;
      rvolAtTime = typeof snap.rvolAtTime === "number" ? snap.rvolAtTime : null;
    } else {
      return {
        modelId: model.id,
        modelVersion: model.modelVersion,
        fallbackReason: "FEATURE_PARSE_FAILED",
      };
    }

    const input: StatisticalPredictionInput = {
      marketId: observation.marketId,
      instrumentId: observation.instrumentId,
      symbol: observation.symbol,
      timestamp: observation.signalTimestamp,
      profileId: observation.profileId,
      profileName: observation.profileName,
      strategy:
        observation.strategyKey as StatisticalPredictionInput["strategy"],
      deterministicScore: observation.score,
      atrPct,
      rvolAtTime,
    };

    const payloadDigest = createHash("sha256")
      .update(JSON.stringify(input))
      .digest("hex");

    try {
      const batch = await this.engine.predictStatistical({
        artifact: model.artifact,
        inputs: [input],
      });
      const prediction = batch.predictions[0];
      if (!prediction) {
        return {
          modelId: model.id,
          modelVersion: model.modelVersion,
          payloadDigest,
          fallbackReason: "EMPTY_PREDICTION_BATCH",
        };
      }

      // Prior-only conditional payoff estimation
      let expectedR: number | null = null;
      let payoffDistribution:
        | {
            winExpectedR: number;
            lossExpectedR: number;
            sampleCount: number;
            priorSampleCount: number;
          }
        | undefined;

      {
        try {
          const priorRows = await this.evidenceStore.rowsFor(
            cohort,
            new Date(observation.signalTimestamp),
          );
          const baselineRows = await this.evidenceStore
            .compatibleBaselineRowsFor!(
            cohort,
            new Date(observation.signalTimestamp),
          );
          const payoffs = estimateConditionalPayoffs(priorRows, baselineRows);
          if (payoffs) {
            payoffDistribution = payoffs;
            const prob = prediction.setupProbability;
            expectedR =
              Math.round(
                (prob * payoffs.winExpectedR +
                  (1 - prob) * payoffs.lossExpectedR) *
                  1000,
              ) / 1000;
          }
        } catch {
          // If prior lookup fails, expectedR stays null fail-open
        }
      }

      return {
        modelId: model.id,
        modelVersion: model.modelVersion,
        predictionTimestamp: new Date().toISOString(),
        predictedProbability: prediction.setupProbability,
        payloadDigest,
        warnings: prediction.warnings,
        fallbackReason: null,
        expectedR,
        payoffDistribution,
      };
    } catch (err) {
      return {
        modelId: model.id,
        modelVersion: model.modelVersion,
        payloadDigest,
        fallbackReason: "PREDICTION_FAILED",
        warnings: [err instanceof Error ? err.message : String(err)],
      };
    }
  }
}

function sameCohort(
  left: PaperEvidenceCohort,
  right: PaperEvidenceCohort,
): boolean {
  return (
    left.strategy === right.strategy &&
    left.strategyVersion === right.strategyVersion &&
    left.profileConfigId === right.profileConfigId &&
    left.configVersion === right.configVersion &&
    left.executionModelVersion === right.executionModelVersion &&
    canonicalJson(left.assumptions) === canonicalJson(right.assumptions)
  );
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
