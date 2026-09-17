import {
  frozenStudyPlanSchema,
  strategyStudyReportSchema,
  studySelectionSchema,
  studyStageResultSchema,
  type FrozenStudyPlan,
  type SessionComparisonResult,
  type StudySelection,
  type StudyStage,
  type StudyStageResult,
  type StrategyStudyReport,
} from "@tsx-scanner/contracts";
import { comparePairedSessions } from "./paired-session-comparison.js";
import { contentHash } from "./research-coverage.js";

const DEVELOPMENT_STAGES = ["TRAIN", "VALIDATION"] as const;
const ALL_STAGES = ["TRAIN", "VALIDATION", "TEST"] as const;

export type StudyExecutionFence = {
  jobId: string;
  leaseOwner: string;
  attemptCount: number;
};

export interface StudyStore {
  register(plan: FrozenStudyPlan): Promise<void>;
  report(id: string): Promise<StrategyStudyReport | null>;
  claim(id: string, stage: StudyStage): Promise<boolean>;
  result(id: string, stage: StudyStage): Promise<StudyStageResult | null>;
  saveResult(id: string, result: StudyStageResult): Promise<void>;
  select(id: string, selection: StudySelection): Promise<void>;
  saveReport(report: StrategyStudyReport): Promise<void>;
}

export interface StudyRunner {
  run(plan: FrozenStudyPlan, stage: StudyStage): Promise<StudyStageResult>;
}

export interface StudyPorts {
  store: StudyStore;
  runner: StudyRunner;
  verify(plan: FrozenStudyPlan): Promise<boolean>;
  checkpoint(): Promise<void>;
}

export function selectStudyChallenger(
  train: Pick<
    StudyStageResult,
    "baselineClosedTrades" | "challengerClosedTrades"
  >,
  validation: Pick<
    StudyStageResult,
    "baselineClosedTrades" | "challengerClosedTrades" | "challengerAverageR"
  >,
  floor: number,
  minimumR: number,
): boolean {
  return (
    [
      train.baselineClosedTrades,
      train.challengerClosedTrades,
      validation.baselineClosedTrades,
      validation.challengerClosedTrades,
    ].every((value) => Number.isInteger(value) && value >= floor) &&
    Number.isFinite(minimumR) &&
    validation.challengerAverageR !== null &&
    Number.isFinite(validation.challengerAverageR) &&
    validation.challengerAverageR > minimumR
  );
}

export class StrategyStudyService {
  constructor(private readonly ports: StudyPorts) {}

  async evaluate(rawPlan: FrozenStudyPlan): Promise<StrategyStudyReport> {
    const plan = frozenStudyPlanSchema.parse(rawPlan);
    await this.ports.checkpoint();
    await this.ports.store.register(plan);
    const prior = await this.ports.store.report(plan.experimentId);
    if (prior) {
      strategyStudyReportSchema.parse(prior);
      return prior;
    }

    const results: StudyStageResult[] = [];
    const makeReport = (
      status: StrategyStudyReport["status"],
      reasonCodes: string[],
      comparison: SessionComparisonResult | null = null,
    ): StrategyStudyReport =>
      strategyStudyReportSchema.parse({
        experimentId: plan.experimentId,
        ...(plan.sessionPlan ? { calculationVersion: "study-report-v2" } : {}),
        binding: plan.binding,
        status,
        results: [...results],
        comparison,
        reasonCodes,
      });

    if (!(await this.ports.verify(plan))) {
      const value = makeReport("INSUFFICIENT_EVIDENCE", [
        "COVERAGE_NOT_VERIFIED",
      ]);
      await this.ports.store.saveReport(value);
      return value;
    }

    for (const stage of ALL_STAGES) {
      await this.ports.checkpoint();
      if (stage === "TEST") {
        const train = results[0];
        const validation = results[1];
        if (!train || !validation)
          throw new Error("DEVELOPMENT_RESULTS_REQUIRED");
        const selected = selectStudyChallenger(
          train,
          validation,
          plan.minimumClosedTradesPerDevelopmentSegment,
          plan.minimumValidationAverageR,
        );
        const selection = studySelectionSchema.parse({
          selected,
          baselineProfileConfigId: plan.baselineProfileConfigId,
          challengerProfileConfigId: plan.challengerProfileConfigId,
          developmentResultHashes: [
            contentHash(train),
            contentHash(validation),
          ],
        });
        await this.ports.store.select(plan.experimentId, selection);
        if (!selected) {
          const value = makeReport("NOT_SELECTED", [
            "DEVELOPMENT_SELECTION_FAILED",
          ]);
          await this.ports.store.saveReport(value);
          return value;
        }
      }

      let stageResult = await this.ports.store.result(plan.experimentId, stage);
      if (!stageResult) {
        if (!(await this.ports.store.claim(plan.experimentId, stage))) {
          const value = makeReport("INTERRUPTED", [
            "STAGE_ALREADY_CLAIMED_WITHOUT_RESULT",
          ]);
          await this.ports.store.saveReport(value);
          return value;
        }
        stageResult = studyStageResultSchema.parse(
          await this.ports.runner.run(plan, stage),
        );
        validateStageResult(plan, stageResult, stage);
        await this.ports.checkpoint();
        await this.ports.store.saveResult(plan.experimentId, stageResult);
      } else {
        stageResult = studyStageResultSchema.parse(stageResult);
        validateStageResult(plan, stageResult, stage);
      }
      results.push(stageResult);
    }

    const comparison = comparePairedSessions(
      results[2]!.sessions,
      plan.comparison,
    );
    const value =
      comparison.status === "AVAILABLE"
        ? makeReport("COMPLETE", [], comparison)
        : makeReport(
            "INSUFFICIENT_EVIDENCE",
            comparison.reasonCodes,
            comparison,
          );
    await this.ports.store.saveReport(value);
    return value;
  }
}

function validateStageResult(
  plan: FrozenStudyPlan,
  result: StudyStageResult,
  stage: StudyStage,
): void {
  if (result.stage !== stage) throw new Error("STUDY_STAGE_MISMATCH");
  if (
    JSON.stringify(result.binding) !==
    JSON.stringify(plan.inputs[stage].binding)
  )
    throw new Error("STUDY_INPUT_BINDING_MISMATCH");
  if (
    result.sessions.some(
      (session) =>
        session.sessionDate < plan.inputs[stage].baseline.startDate ||
        session.sessionDate > plan.inputs[stage].baseline.endDate,
    )
  )
    throw new Error("STUDY_SESSION_SCOPE_MISMATCH");
  const dates = result.sessions.map((session) => session.sessionDate);
  if (new Set(dates).size !== dates.length)
    throw new Error("STUDY_SESSION_SCOPE_MISMATCH");
  const expectedDates = plan.sessionPlan
    ? plan.sessionPlan.sessions[stage]
    : stage === "TEST"
      ? plan.comparison.expectedSessions
      : null;
  if (expectedDates && JSON.stringify(dates) !== JSON.stringify(expectedDates))
    throw new Error("STUDY_SESSION_SCOPE_MISMATCH");
}

export { DEVELOPMENT_STAGES };
