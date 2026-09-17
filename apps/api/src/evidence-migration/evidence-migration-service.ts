import type { CalibrationService } from "../calibration/calibration-service.js";
import {
  BacktestError,
  type BacktestService,
} from "../backtests/backtest-service.js";
import type { RankingResearchService } from "../ranking-research/ranking-research-service.js";
import type { StatisticalModelService } from "../statistical-models/statistical-model-service.js";
import { createBacktestStatisticalModelSchema } from "@tsx-scanner/contracts";
import {
  EvidenceMigrationRepository,
  type EvidenceMigrationReport,
} from "./evidence-migration-repository.js";

export interface EvidenceMigrationLogger {
  info(fields: Record<string, unknown>): void;
  error(fields: Record<string, unknown>): void;
}

export class EvidenceMigrationService {
  constructor(
    private readonly repository: EvidenceMigrationRepository,
    private readonly backtests: BacktestService,
    private readonly calibrations: CalibrationService,
    private readonly statisticalModels: StatisticalModelService,
    private readonly rankingResearch: RankingResearchService,
    private readonly logger: EvidenceMigrationLogger,
  ) {}

  async run(): Promise<EvidenceMigrationReport> {
    for (const item of await this.repository.pendingExecutions()) {
      await this.repository.startExecution(item.id);
      try {
        const source = await this.backtests.getRun(item.sourceId);
        const replacement = await this.backtests.createReplacementRun(source);
        const replacementModelIds: string[] = [];
        const replacementRankingStudyIds: string[] = [];
        const dependencyFailures: Array<{
          dependency: string;
          id: string;
          reason: string;
        }> = [];

        for (const modelId of await this.repository.legacyModelIds(source.id)) {
          try {
            const legacy = await this.statisticalModels.get(modelId);
            const trained = await this.statisticalModels.create(
              createBacktestStatisticalModelSchema.parse({
                name: `${legacy.name} · authoritative replacement`,
                strategy: legacy.strategy,
                trainPct: legacy.input.trainPct,
                minimumSamples: legacy.input.minimumSamples,
                l2Penalty: legacy.input.l2Penalty,
                backtestRunId: replacement.id,
              }),
            );
            replacementModelIds.push(trained.id);
          } catch (error) {
            dependencyFailures.push({
              dependency: "STATISTICAL_MODEL",
              id: modelId,
              reason: message(error),
            });
          }
        }

        for (const studyId of await this.repository.activatedRankingStudyIds(
          source.id,
        )) {
          try {
            const legacy = await this.rankingResearch.get(studyId);
            const study = await this.rankingResearch.create({
              ...legacy.input,
              name: `${legacy.name} · authoritative replacement`,
              backtestRunId: replacement.id,
            });
            replacementRankingStudyIds.push(study.id);
          } catch (error) {
            dependencyFailures.push({
              dependency: "RANKING_RESEARCH",
              id: studyId,
              reason: message(error),
            });
          }
        }

        await this.repository.completeExecution(item.id, replacement.id, {
          replacementModelIds,
          replacementRankingStudyIds,
          dependencyFailures,
          replacementModelsRequireManualActivation: true,
        });
        this.logger.info({
          event: "EVIDENCE_RUN_REPLACED",
          sourceId: source.id,
          replacementId: replacement.id,
          replacementModelIds,
          replacementRankingStudyIds,
          dependencyFailures,
        });
      } catch (error) {
        const status = isUnreplayable(error) ? "UNREPLAYABLE_LEGACY" : "FAILED";
        const reason = message(error);
        const demotedProfiles = await this.repository.failExecution(
          item.id,
          status,
          reason,
        );
        this.logger.error({
          event: "EVIDENCE_RUN_MIGRATION_FAILED",
          sourceId: item.sourceId,
          status,
          reason,
          demotedProfiles,
        });
      }
    }

    for (const item of await this.repository.pendingCalibrations()) {
      await this.repository.startCalibration(item.id);
      try {
        const source = await this.calibrations.get(item.sourceId);
        const replacement = await this.calibrations.create({
          ...source.input,
          name: `${source.name} · authoritative replacement`,
        });
        await this.repository.completeCalibration(
          item.id,
          replacement.id,
          replacement.recommendedConfig,
        );
        this.logger.info({
          event: "CALIBRATION_EVIDENCE_REPLACED",
          sourceId: source.id,
          replacementId: replacement.id,
        });
      } catch (error) {
        const reason = message(error);
        const status = /history|replay|captured quote/i.test(reason)
          ? "UNREPLAYABLE_LEGACY"
          : "FAILED";
        await this.repository.failCalibration(item.id, status, reason);
        this.logger.error({
          event: "CALIBRATION_EVIDENCE_MIGRATION_FAILED",
          sourceId: item.sourceId,
          status,
          reason,
        });
      }
    }

    return this.repository.report();
  }
}

function isUnreplayable(error: unknown): boolean {
  return (
    error instanceof BacktestError &&
    [
      "HISTORY_UNAVAILABLE",
      "REPLAY_INPUT_UNAVAILABLE",
      "REPLAY_COVERAGE_INCOMPLETE",
    ].includes(error.code)
  );
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : "Unknown evidence migration failure";
