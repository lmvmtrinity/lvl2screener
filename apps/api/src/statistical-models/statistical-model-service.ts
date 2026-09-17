import { createHash } from "node:crypto";
import type {
  ActiveStatisticalPredictions,
  BacktestRun,
  BacktestTrade,
  CreateStatisticalModel,
  StatisticalModel,
  StatisticalPredictionBatch,
  StatisticalPredictionInput,
  StatisticalTrainingResult,
  StatisticalTrainingDataset,
  StrategyEvaluation,
} from "@tsx-scanner/contracts";
import type { BacktestStore } from "../backtests/backtest-service.js";
import type { StatisticalModelStore } from "./statistical-model-repository.js";
import { DomainError } from "../errors.js";
import { AUTHORITATIVE_EXECUTION_MODEL_VERSION } from "../backtests/execution-provenance.js";
import type { PaperEvidenceTrainingService } from "./paper-evidence-training-service.js";

export type StatisticalModelErrorCode =
  | "MODEL_NOT_FOUND"
  | "BACKTEST_NOT_FOUND"
  | "BACKTEST_NOT_COMPLETED"
  | "BACKTEST_DATA_QUALITY"
  | "BACKTEST_EXECUTION_MODEL"
  | "PAPER_DATASET_NOT_FOUND"
  | "PAPER_DATASET_NOT_QUALIFIED"
  | "PAPER_DATASET_STRATEGY"
  | "STRATEGY_NOT_IN_RUN"
  | "MODEL_NOT_READY"
  | "MODEL_NOT_ELIGIBLE"
  | "TRAINING_FAILED";

class StatisticalModelError extends DomainError {
  constructor(
    readonly code: StatisticalModelErrorCode,
    message: string,
    readonly modelId?: string,
  ) {
    super(code, message, code === "MODEL_NOT_FOUND" ? 404 : 409);
  }
}
export interface StatisticalModelEngine {
  trainStatistical(payload: unknown): Promise<StatisticalTrainingResult>;
  predictStatistical(
    payload: unknown,
    requestSignal?: AbortSignal,
  ): Promise<StatisticalPredictionBatch>;
}

export class StatisticalModelService {
  constructor(
    private readonly store: StatisticalModelStore,
    private readonly backtests: BacktestStore,
    private readonly engine: StatisticalModelEngine,
    private readonly paperEvidence?: PaperEvidenceTrainingService,
  ) {}
  list(limit = 50): Promise<StatisticalModel[]> {
    return this.store.list(limit);
  }
  async get(id: string): Promise<StatisticalModel> {
    const value = await this.store.get(id);
    if (!value)
      throw new StatisticalModelError(
        "MODEL_NOT_FOUND",
        "Statistical model not found",
      );
    return value;
  }
  async create(input: CreateStatisticalModel): Promise<StatisticalModel> {
    if (input.sourceKind === "PAPER_EVIDENCE")
      return this.createFromPaperEvidence(input);
    const source = await this.backtests.get(input.backtestRunId);
    if (!source)
      throw new StatisticalModelError(
        "BACKTEST_NOT_FOUND",
        "Source backtest run not found",
      );
    if (source.status !== "COMPLETED")
      throw new StatisticalModelError(
        "BACKTEST_NOT_COMPLETED",
        "Source backtest must be completed before training",
      );
    if (source.dataQuality?.spread !== "CAPTURED")
      throw new StatisticalModelError(
        "BACKTEST_DATA_QUALITY",
        "Source backtest must contain captured quote spreads; candle-only or undisclosed data is not eligible for statistical training",
      );
    this.assertAuthoritativeBacktest(source);
    if (!source.strategies.includes(input.strategy))
      throw new StatisticalModelError(
        "STRATEGY_NOT_IN_RUN",
        "The selected strategy is not present in the source backtest",
      );
    const model = await this.store.create(input);
    await this.store.markTraining(model.id);
    try {
      const trades = source.trades.filter(
        (value) => value.strategy === input.strategy,
      );
      const result = await this.engine.trainStatistical({
        marketId: source.marketId,
        strategy: input.strategy,
        trades,
        trainPct: input.trainPct,
        minimumSamples: input.minimumSamples,
        l2Penalty: input.l2Penalty,
      });
      const modelVersion = versionFor(
        input,
        { backtestRunId: source.id },
        result,
      );
      return source.researchEvidence
        ? await this.store.complete(
            model.id,
            result,
            modelVersion,
            source.researchEvidence,
          )
        : await this.store.complete(model.id, result, modelVersion);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Unknown statistical training failure";
      await this.store.fail(model.id, message);
      throw new StatisticalModelError(
        "TRAINING_FAILED",
        `Statistical training failed: ${message}`,
        model.id,
      );
    }
  }
  async activate(id: string): Promise<StatisticalModel> {
    const model = await this.get(id);
    if (model.status !== "COMPLETED" || !model.artifact)
      throw new StatisticalModelError(
        "MODEL_NOT_READY",
        "Only completed models can be activated",
      );
    if (!model.eligibleForActivation)
      throw new StatisticalModelError(
        "MODEL_NOT_ELIGIBLE",
        "Chronological validation did not qualify this model for activation",
      );
    if (model.sourceKind === "PAPER_EVIDENCE") {
      const dataset = await this.paperEvidence?.getDataset(
        model.trainingDatasetId ?? "",
      );
      if (!dataset)
        throw new StatisticalModelError(
          "PAPER_DATASET_NOT_FOUND",
          "Source paper-evidence dataset not found",
          model.id,
        );
      if (!dataset.researchQualification?.qualified)
        throw new StatisticalModelError(
          "PAPER_DATASET_NOT_QUALIFIED",
          "Source paper-evidence dataset has not passed the immutable chronological research qualification gate",
          model.id,
        );
      if (
        dataset.researchQualification.policyVersion !==
          "paper-research-qualification-v2" ||
        !dataset.researchQualification.chronologicalTrainSourceKeys ||
        !dataset.researchQualification.chronologicalTestSourceKeys
      )
        throw new StatisticalModelError(
          "PAPER_DATASET_NOT_QUALIFIED",
          "Source paper-evidence dataset uses a legacy qualification without a frozen leakage-free partition",
          model.id,
        );
      if (
        dataset.cohort.executionModelVersion !==
        AUTHORITATIVE_EXECUTION_MODEL_VERSION
      )
        throw new StatisticalModelError(
          "BACKTEST_EXECUTION_MODEL",
          `Statistical models require ${AUTHORITATIVE_EXECUTION_MODEL_VERSION} paper evidence`,
          model.id,
        );
    } else {
      const source = await this.backtests.get(model.backtestRunId ?? "");
      if (!source)
        throw new StatisticalModelError(
          "BACKTEST_NOT_FOUND",
          "Source backtest run not found",
          model.id,
        );
      this.assertAuthoritativeBacktest(source, model.id);
    }
    return this.store.activate(id, model.strategy);
  }

  private async createFromPaperEvidence(
    input: Extract<CreateStatisticalModel, { sourceKind: "PAPER_EVIDENCE" }>,
  ): Promise<StatisticalModel> {
    const paperEvidence = this.paperEvidence;
    const dataset = await paperEvidence?.getDataset(input.trainingDatasetId);
    if (!dataset)
      throw new StatisticalModelError(
        "PAPER_DATASET_NOT_FOUND",
        "Source paper-evidence dataset not found",
      );
    if (!dataset.researchQualification?.qualified)
      throw new StatisticalModelError(
        "PAPER_DATASET_NOT_QUALIFIED",
        "Source paper-evidence dataset has not passed the immutable chronological research qualification gate",
      );
    if (
      dataset.researchQualification.policyVersion !==
        "paper-research-qualification-v2" ||
      !dataset.researchQualification.chronologicalTrainSourceKeys ||
      !dataset.researchQualification.chronologicalTestSourceKeys
    )
      throw new StatisticalModelError(
        "PAPER_DATASET_NOT_QUALIFIED",
        "Source paper-evidence dataset uses a legacy qualification without a frozen leakage-free partition",
      );
    if (dataset.cohort.strategy !== input.strategy)
      throw new StatisticalModelError(
        "PAPER_DATASET_STRATEGY",
        "Paper-evidence dataset strategy does not match requested model strategy",
      );
    if (
      dataset.cohort.executionModelVersion !==
      AUTHORITATIVE_EXECUTION_MODEL_VERSION
    )
      throw new StatisticalModelError(
        "BACKTEST_EXECUTION_MODEL",
        `Statistical models require ${AUTHORITATIVE_EXECUTION_MODEL_VERSION} paper evidence`,
      );
    const rows = await paperEvidence!.datasetRows(input.trainingDatasetId);
    let partition: { train: typeof rows; test: typeof rows };
    try {
      partition = paperEvidencePartition(dataset, rows);
    } catch (error) {
      throw new StatisticalModelError(
        "PAPER_DATASET_NOT_QUALIFIED",
        error instanceof Error
          ? error.message
          : "Source paper-evidence dataset has an invalid frozen partition",
      );
    }
    const model = await this.store.create(input);
    await this.store.markTraining(model.id);
    try {
      const trades: (Pick<
        BacktestTrade,
        | "strategy"
        | "entryTime"
        | "score"
        | "atrPct"
        | "rvolAtTime"
        | "rMultiple"
      > & { sourceKey?: string })[] = [
        ...partition.train,
        ...partition.test,
      ].map((row) => ({
        sourceKey: row.sourceKey,
        strategy: input.strategy,
        entryTime: row.signalTimestamp,
        score: row.deterministicScore,
        atrPct: row.atrPct,
        rvolAtTime: row.rvolAtTime,
        rMultiple: row.rMultiple,
      }));
      const result = await this.engine.trainStatistical({
        marketId: dataset.cohort.marketId,
        strategy: input.strategy,
        trades,
        trainingSourceKeys: partition.train.map((row) => row.sourceKey),
        testingSourceKeys: partition.test.map((row) => row.sourceKey),
        trainPct: input.trainPct,
        minimumSamples: input.minimumSamples,
        l2Penalty: input.l2Penalty,
      });
      const modelVersion = versionFor(
        input,
        { datasetId: dataset.id, digest: dataset.sourceDigest },
        result,
      );
      return dataset.researchEvidence
        ? await this.store.complete(
            model.id,
            result,
            modelVersion,
            dataset.researchEvidence,
          )
        : await this.store.complete(model.id, result, modelVersion);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Unknown statistical training failure";
      await this.store.fail(model.id, message);
      throw new StatisticalModelError(
        "TRAINING_FAILED",
        `Statistical training failed: ${message}`,
        model.id,
      );
    }
  }

  private assertAuthoritativeBacktest(
    source: BacktestRun,
    modelId?: string,
  ): void {
    if (
      source.executionModelVersion !== AUTHORITATIVE_EXECUTION_MODEL_VERSION
    ) {
      throw new StatisticalModelError(
        "BACKTEST_EXECUTION_MODEL",
        `Statistical models require ${AUTHORITATIVE_EXECUTION_MODEL_VERSION} backtest evidence; source run ${source.id} uses ${source.executionModelVersion ?? "legacy unknown execution"}`,
        modelId,
      );
    }
  }
  async deactivate(id: string): Promise<StatisticalModel> {
    await this.get(id);
    return this.store.deactivate(id);
  }
  async predictions(
    id: string,
    evaluations: StrategyEvaluation[],
  ): Promise<StatisticalPredictionBatch> {
    const model = await this.get(id);
    if (model.status !== "COMPLETED" || !model.artifact)
      throw new StatisticalModelError(
        "MODEL_NOT_READY",
        "This model has no usable artifact",
      );
    const inputs: StatisticalPredictionInput[] = evaluations
      .filter(
        (value) =>
          value.marketId === model.marketId &&
          value.strategy === model.strategy &&
          value.state === "READY",
      )
      .map((value) => ({
        marketId: value.marketId,
        instrumentId: value.instrumentId,
        symbol: value.symbol,
        timestamp: value.timestamp,
        profileId: value.profileId,
        profileName: value.profileName,
        strategy: value.strategy,
        deterministicScore: value.score,
        atrPct: value.featureSnapshot.atrPct,
        rvolAtTime: value.featureSnapshot.rvolAtTime,
      }));
    const result = await this.engine.predictStatistical({
      artifact: model.artifact,
      inputs,
    });
    return {
      modelId: model.id,
      modelVersion: model.modelVersion,
      predictions: result.predictions,
    };
  }
  async activePredictions(
    evaluations: StrategyEvaluation[],
  ): Promise<ActiveStatisticalPredictions> {
    const active = await this.store.listActive();
    return {
      models: await Promise.all(
        active.map((value) => this.predictions(value.id, evaluations)),
      ),
    };
  }
}

function versionFor(
  input: CreateStatisticalModel,
  source: { backtestRunId: string } | { datasetId: string; digest: string },
  result: StatisticalTrainingResult,
): string {
  const payload = {
    source,
    strategy: input.strategy,
    trainPct: input.trainPct,
    minimumSamples: input.minimumSamples,
    l2Penalty: input.l2Penalty,
    artifact: result.artifact,
  };
  return `phase12-${createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 12)}`;
}

function paperEvidencePartition(
  dataset: StatisticalTrainingDataset,
  rows: Awaited<ReturnType<PaperEvidenceTrainingService["datasetRows"]>>,
): { train: typeof rows; test: typeof rows } {
  const qualification = dataset.researchQualification;
  if (
    qualification?.chronologicalTrainSourceKeys &&
    qualification.chronologicalTestSourceKeys
  ) {
    const trainKeys = qualification.chronologicalTrainSourceKeys;
    const testKeys = qualification.chronologicalTestSourceKeys;
    const trainSet = new Set(trainKeys);
    const testSet = new Set(testKeys);
    const rowKeys = new Set(rows.map((row) => row.sourceKey));
    if (trainSet.size !== trainKeys.length || testSet.size !== testKeys.length)
      throw new Error(
        "Frozen chronological partition contains duplicate source keys",
      );
    if ([...trainSet].some((key) => testSet.has(key)))
      throw new Error("Frozen chronological train/test partition overlaps");
    if (
      rowKeys.size !== rows.length ||
      trainSet.size + testSet.size !== rowKeys.size
    )
      throw new Error(
        "Frozen chronological partition does not cover dataset rows exactly",
      );
    if ([...rowKeys].some((key) => !trainSet.has(key) && !testSet.has(key)))
      throw new Error(
        "Frozen chronological partition contains an unknown source key",
      );
    const byKey = new Map(rows.map((row) => [row.sourceKey, row]));
    const train = trainKeys.map((key) => byKey.get(key)!);
    const test = testKeys.map((key) => byKey.get(key)!);
    const testStart = Math.min(
      ...test.map((row) => Date.parse(row.signalTimestamp)),
    );
    if (!Number.isFinite(testStart))
      throw new Error(
        "Frozen chronological partition has invalid test timestamps",
      );
    if (
      train.some(
        (row) =>
          !Number.isFinite(Date.parse(row.labelAvailableAt ?? "")) ||
          Date.parse(row.labelAvailableAt!) >= testStart,
      )
    )
      throw new Error(
        "Frozen chronological partition includes a training label unavailable at the holdout boundary",
      );
    return { train, test };
  }
  throw new Error(
    "Source paper-evidence dataset lacks a frozen leakage-free partition",
  );
}
