import { createHash } from "node:crypto";
import type {
  BacktestMetrics,
  BacktestReplayResult,
  CalibrationGrid,
  CalibrationRun,
  CalibrationTrial,
  CreateBacktest,
  CreateCalibration,
  MarketId,
} from "@tsx-scanner/contracts";
import type {
  BacktestSignalEngine,
  BacktestStore,
} from "../backtests/backtest-service.js";
import { assertCapturedHistoryAvailable } from "../backtests/backtest-service.js";
import type { ReplaySessionPolicy } from "../backtests/backtest-repository.js";
import type { CalibrationStore } from "./calibration-repository.js";
import { DomainError } from "../errors.js";
import {
  AuthoritativeBacktestAccumulator,
  type HistoricalReplaySession,
} from "../backtests/authoritative-backtest-executor.js";
import { admitReplaySession } from "../backtests/replay-quote-admission.js";
import {
  researchSessionDates,
  type ArtifactResearchLineage,
} from "../backtests/research-lineage-service.js";
import { hashResearchSession } from "../backtests/research-session-input.js";
import { costPolicyForMarket } from "../paper-bot/cost-policy.js";

class CalibrationError extends DomainError {
  constructor(
    readonly code:
      | "RUN_NOT_FOUND"
      | "INVALID_RANGE"
      | "HISTORY_UNAVAILABLE"
      | "GRID_TOO_LARGE"
      | "CALIBRATION_FAILED",
    message: string,
    readonly runId?: string,
  ) {
    // Every current call site treats every CalibrationError code as "not found" (404); kept
    // as-is to avoid a behavior change during this restructuring.
    super(code, message, 404);
  }
}
type Parameters = CalibrationTrial["parameters"];
type Replay = {
  sessions: Array<
    HistoricalReplaySession & {
      session: {
        startTime: string;
        openingRange: { start: string; end: string };
        scanning: { start: string; end: string };
        entries: {
          preferredStart: string;
          preferredEnd: string;
          hardEnd: string;
        };
      };
      [key: string]: unknown;
    }
  >;
};

export class CalibrationService {
  constructor(
    private readonly calibrationStore: CalibrationStore,
    private readonly backtests: BacktestStore,
    private readonly engine: BacktestSignalEngine,
    private readonly policy:
      ReplaySessionPolicy | Readonly<Record<MarketId, ReplaySessionPolicy>>,
    private readonly lineage?: ArtifactResearchLineage,
  ) {}
  list(limit = 50): Promise<CalibrationRun[]> {
    return this.calibrationStore.list(limit);
  }
  async get(id: string): Promise<CalibrationRun> {
    const value = await this.calibrationStore.get(id);
    if (!value)
      throw new CalibrationError("RUN_NOT_FOUND", "Calibration run not found");
    return value;
  }
  async create(
    input: CreateCalibration,
    researchJobId?: string,
    attemptCount = 1,
  ): Promise<CalibrationRun> {
    if (researchJobId) {
      const existing = await this.calibrationStore.getForJob(
        researchJobId,
        input,
      );
      if (existing?.status === "COMPLETED") return existing;
      if (
        (existing && existing.status !== "PENDING") ||
        (!existing && attemptCount > 1)
      ) {
        throw new CalibrationError(
          "CALIBRATION_FAILED",
          "Calibration cannot repeat an interrupted or unlinked prior attempt; review its holdout exposure before declaring a new experiment.",
          existing?.id,
        );
      }
    }
    const policy = this.policyFor(input.marketId);
    if (input.endDate < input.startDate)
      throw new CalibrationError(
        "INVALID_RANGE",
        "endDate must be on or after startDate",
      );
    if (
      input.marketId === "US_EQUITIES" &&
      input.slippageBps < costPolicyForMarket("US_EQUITIES").slippageBps
    )
      throw new CalibrationError(
        "INVALID_RANGE",
        `US calibration slippageBps must be at least ${costPolicyForMarket("US_EQUITIES").slippageBps} to match the forward-paper cost policy; higher stress is allowed.`,
      );
    const latestOpeningEnd = addMinutes(
      policy.openingRange.start,
      Math.max(...input.grid.openingRangeMinutes),
    );
    if (
      input.grid.entryWindowEnd.some(
        (value) =>
          !validTime(value) ||
          value <= latestOpeningEnd ||
          value < policy.entries.preferredStart,
      )
    )
      throw new CalibrationError(
        "INVALID_RANGE",
        `Every entryWindowEnd must be a valid time at or after ${policy.entries.preferredStart} and later than the longest opening range (${latestOpeningEnd}).`,
      );
    const total = combinationCount(input.grid);
    if (total > input.maxCombinations * 100)
      throw new CalibrationError(
        "GRID_TOO_LARGE",
        `Grid contains ${total} combinations; narrow it below ${input.maxCombinations * 100}.`,
      );
    const capturedHistoryAvailability =
      await this.backtests.getCapturedHistoryAvailability(input.marketId);
    try {
      assertCapturedHistoryAvailable(input, capturedHistoryAvailability);
    } catch (error) {
      if (error instanceof Error)
        throw new CalibrationError("HISTORY_UNAVAILABLE", error.message);
      throw error;
    }
    const variants = combinations(input.grid, input.maxCombinations);
    const base: CreateBacktest = {
      name: input.name,
      marketId: input.marketId,
      startDate: input.startDate,
      endDate: input.endDate,
      strategies: [input.strategy],
      symbols: input.symbols,
      dataSource: input.dataSource,
      startingCapital: input.startingCapital,
      positionSize: input.positionSize,
      slippageBps: input.slippageBps,
      feePerTrade: input.feePerTrade,
      parameters: strategyParameters(variants[0]!),
    };
    const replayInput = await this.backtests.resolveReplayInput(
      base,
      capturedHistoryAvailability,
    );
    const replay = (await this.backtests.loadReplayData(
      base,
      replayInput,
      policy,
    )) as Replay;
    const hashes = Object.fromEntries(
      replay.sessions.map((session) => {
        const date = researchSessionDates(
          [session.session.startTime],
          input.marketId,
        )[0]!;
        return [date, hashResearchSession(date, session)];
      }),
    );
    const researchEvidence = await this.lineage?.resolve({
      kind: "CALIBRATION",
      marketId: input.marketId,
      scope: { input, replayInput },
      sessionDates: Object.keys(hashes).sort(),
      inputCutoff: `${input.endDate}T23:59:59.999Z`,
      sessionPayloadHashes: hashes,
    });
    const run = await this.calibrationStore.create(
      input,
      total,
      total > variants.length,
      capturedHistoryAvailability,
      researchJobId,
      researchEvidence,
    );
    if (run.status === "COMPLETED") return run;
    if (!(await this.calibrationStore.markRunning(run.id))) {
      throw new CalibrationError(
        "CALIBRATION_FAILED",
        "Calibration already started; interrupted runs cannot repeat a potentially exposed holdout. Review the recorded run before declaring a new experiment.",
        run.id,
      );
    }
    try {
      const split = splitDates(
        input.startDate,
        input.endDate,
        input.trainPct,
        input.validationPct,
      );
      const evaluate = async (parameters: Parameters, segment: Replay) => {
        const configuredInput: CreateBacktest = {
          ...base,
          parameters: strategyParameters(parameters),
        };
        const configVersion = versionFor(parameters);
        const accumulator = new AuthoritativeBacktestAccumulator(
          run.id,
          configVersion,
          configuredInput,
        );
        const metadata = {
          runId: run.id,
          marketId: input.marketId,
          configVersion,
          strategies: [input.strategy],
          parameters: configuredInput.parameters,
          assumptions: {
            startingCapital: input.startingCapital,
            positionSize: input.positionSize,
            slippageBps: input.slippageBps,
            feePerTrade: input.feePerTrade,
            stopMethod: parameters.stopMethod,
            atrStopMultiple: input.atrStopMultiple,
            rewardRiskRatio: parameters.rewardRiskRatio,
          },
        };
        if (segment.sessions.length === 0) {
          accumulator.addReplayWarnings(
            await this.engine.runBacktestSignals({ ...metadata, sessions: [] }),
          );
        }
        for (const session of segment.sessions) {
          const admittedSession = admitReplaySession(session);
          const signals = await this.engine.runBacktestSignals({
            ...metadata,
            sessions: [admittedSession],
          });
          accumulator.ingestSession(session, signals);
        }
        return accumulator.finish().output;
      };
      const raw: CalibrationTrial[] = [];
      for (const parameters of variants) {
        const configured = configureReplay(replay, parameters);
        const train = await evaluate(
          parameters,
          filter(configured, input.startDate, split.trainEnd),
        );
        const validation = await evaluate(
          parameters,
          filter(configured, dayAfter(split.trainEnd), split.validationEnd),
        );
        const metrics = {
          TRAIN: train.metrics,
          VALIDATION: validation.metrics,
          TEST: null,
          ALL: null,
        };
        const warnings = [
          ...new Set([
            ...train.dataQuality.warnings,
            ...validation.dataQuality.warnings,
          ]),
        ];
        warnings.push(...weaknessWarnings(validation.analyses));
        warnings.push(
          "TEST is not evaluated unless this configuration is selected; slice analyses cover VALIDATION only.",
        );
        raw.push({
          rank: 1,
          configVersion: versionFor(parameters),
          parameters,
          segments: metrics,
          robustScore: robustScore(metrics),
          plateauSize: 0,
          sufficientSample: false,
          outOfSamplePositive: false,
          warnings,
          analyses: validation.analyses,
          analysesScope: "VALIDATION",
        });
      }
      for (const trial of raw)
        trial.plateauSize = plateauSize(trial, raw, input.grid);
      raw
        .sort(
          (a, b) =>
            b.robustScore - a.robustScore ||
            b.segments.VALIDATION.expectancy -
              a.segments.VALIDATION.expectancy ||
            a.configVersion.localeCompare(b.configVersion),
        )
        .forEach((value, index) => (value.rank = index + 1));
      // Select a candidate using TRAIN/VALIDATION only. TEST is held out from
      // ranking and plateau construction, then checked once on that candidate.
      const selected = raw.find(
        (value) =>
          selectionSufficient(value, input.minimumTradesPerSegment) &&
          value.segments.VALIDATION.expectancy > 0 &&
          value.segments.VALIDATION.averageR > 0 &&
          value.plateauSize >= 2,
      );
      // Persist the decision and search report before any TEST input reaches
      // the engine. An interrupted job is never restarted against this holdout.
      await this.calibrationStore.freezeSelection(
        run.id,
        {
          version: "selected-holdout-v1",
          configVersion: selected?.configVersion ?? null,
          replayInputHash: replayInput.inputHash,
        },
        raw,
        split,
      );
      if (selected) {
        const test = await evaluate(
          selected.parameters,
          filter(
            configureReplay(replay, selected.parameters),
            dayAfter(split.validationEnd),
            input.endDate,
          ),
        );
        selected.segments.TEST = test.metrics;
        selected.sufficientSample =
          selectionSufficient(selected, input.minimumTradesPerSegment) &&
          test.metrics.tradesSimulated >= input.minimumTradesPerSegment;
        selected.outOfSamplePositive =
          selected.segments.VALIDATION.expectancy > 0 &&
          selected.segments.VALIDATION.averageR > 0 &&
          test.metrics.expectancy > 0 &&
          test.metrics.averageR > 0;
        selected.warnings = selected.warnings.filter(
          (value) => !value.startsWith("TEST is not evaluated"),
        );
        selected.warnings.push(
          "Selected TEST evaluated once; slice analyses cover VALIDATION only.",
          ...test.dataQuality.warnings,
        );
        if (!selected.sufficientSample)
          selected.warnings.push(
            `Fewer than ${input.minimumTradesPerSegment} trades in one or more chronological segments.`,
          );
        if (!selected.outOfSamplePositive)
          selected.warnings.push(
            "Validation and test expectancy are not both positive.",
          );
      }
      const recommended =
        selected &&
        selected.segments.TEST &&
        selected.segments.TEST.tradesSimulated >=
          input.minimumTradesPerSegment &&
        selected.segments.TEST.expectancy > 0 &&
        selected.segments.TEST.averageR > 0
          ? selected
          : undefined;
      const recommendation =
        (recommended
          ? `Robust range found: rank ${recommended.rank} was selected using train/validation only, then passed the untouched test sample with positive expectancy and ${recommended.plateauSize} adjacent plateau configurations. Prefer the plateau over the exact point estimate.`
          : `No robust calibration is supported yet. Require adequate samples in every chronological segment, positive validation and test expectancy, and at least one adjacent parameter configuration with similar results.`) +
        (raw.length > 1
          ? ` This run evaluated ${raw.length} parameter combinations; the reported point estimates are not adjusted for multiple testing, so treat the winning configuration as a starting point for out-of-sample confirmation, not a validated result on its own.`
          : "");
      return await this.calibrationStore.complete(run.id, {
        trials: raw,
        splitDates: split,
        recommendation,
        recommendedConfig: recommended?.parameters ?? null,
        combinationsTested: raw.length,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown calibration failure";
      await this.calibrationStore.fail(run.id, message);
      throw new CalibrationError(
        "CALIBRATION_FAILED",
        `Calibration failed: ${message}`,
        run.id,
      );
    }
  }

  private policyFor(marketId: MarketId): ReplaySessionPolicy {
    if ("timezone" in this.policy) return this.policy;
    const policy = this.policy[marketId];
    if (!policy)
      throw new CalibrationError(
        "INVALID_RANGE",
        `No replay session policy is configured for ${marketId}`,
      );
    return policy;
  }
}

const keys = (grid: CalibrationGrid) =>
  Object.keys(grid) as Array<keyof CalibrationGrid>;
export function combinationCount(grid: CalibrationGrid): number {
  return keys(grid).reduce((total, key) => total * grid[key].length, 1);
}
export function combinations(
  grid: CalibrationGrid,
  limit: number,
): Parameters[] {
  const all: Parameters[] = [];
  const ordered = keys(grid);
  const visit = (index: number, value: Partial<Parameters>) => {
    if (index === ordered.length) {
      all.push({
        ...value,
        breakoutBufferPct: 0.05,
        relativeStrengthMinPct: 0.5,
        flagpoleMinAtr: 0.5,
        flagRetracementMaxPct: 50,
        setupTimeoutMinutes: 20,
        consolidationBarsMin: 3,
        consolidationRangeMaxPct: 0.75,
        flagDurationBarsMin: 1,
        flagDurationBarsMax: 2,
        flagpoleMinSlopeAtrPerBar: 0,
        volumeContractionMaxPct: 100,
        retestVolumeContractionEnabled: 0,
        retestHighBreakEnabled: 0,
        retestRejectionEnabled: 0,
        retestVolumeContractionMaxRatio: 0.8,
        rejectionLowerWickBodyMin: 2,
        rejectionUpperWickRangeMaxPct: 20,
        rejectionCloseLocationMinPct: 65,
        rsiPeriod: 14,
        rsiPivotLeftBars: 2,
        rsiPivotRightBars: 2,
        rsiPivotMinSpacingBars: 3,
        rsiPivotMaxSpacingBars: 12,
        rsiDivergenceMinPoints: 3,
        rsiDivergenceVolumeContractionMaxRatio: 0.8,
        rsiSetupTimeoutMinutes: 30,
        dailyEmaFilterEnabled: 0,
      } as Parameters);
      return;
    }
    const key = ordered[index]!;
    for (const option of grid[key])
      visit(index + 1, { ...value, [key]: option });
  };
  visit(0, {});
  if (all.length <= limit) return all;
  if (limit === 1) return [all[Math.floor((all.length - 1) / 2)]!];
  const selected = new Set<number>();
  for (let index = 0; index < limit; index++)
    selected.add(Math.round((index * (all.length - 1)) / (limit - 1)));
  return [...selected].map((index) => all[index]!);
}
const strategyParameters = (value: Parameters) => ({
  rvolAtTimeMin: value.rvolAtTimeMin,
  spreadHardMaxPct: value.spreadHardMaxPct,
  atrPctMin: value.atrPctMin,
  breakoutVolumeRatioMin: value.breakoutVolumeRatioMin,
  retestTolerancePct: value.retestTolerancePct,
  scoreCutoff: value.scoreCutoff,
  breakoutBufferPct: value.breakoutBufferPct,
  relativeStrengthMinPct: value.relativeStrengthMinPct,
  flagpoleMinAtr: value.flagpoleMinAtr,
  flagRetracementMaxPct: value.flagRetracementMaxPct,
  setupTimeoutMinutes: value.setupTimeoutMinutes,
  consolidationBarsMin: value.consolidationBarsMin,
  consolidationRangeMaxPct: value.consolidationRangeMaxPct,
  flagDurationBarsMin: value.flagDurationBarsMin,
  flagDurationBarsMax: value.flagDurationBarsMax,
  flagpoleMinSlopeAtrPerBar: value.flagpoleMinSlopeAtrPerBar,
  volumeContractionMaxPct: value.volumeContractionMaxPct,
  retestVolumeContractionEnabled: value.retestVolumeContractionEnabled,
  retestHighBreakEnabled: value.retestHighBreakEnabled,
  retestRejectionEnabled: value.retestRejectionEnabled,
  retestVolumeContractionMaxRatio: value.retestVolumeContractionMaxRatio,
  rejectionLowerWickBodyMin: value.rejectionLowerWickBodyMin,
  rejectionUpperWickRangeMaxPct: value.rejectionUpperWickRangeMaxPct,
  rejectionCloseLocationMinPct: value.rejectionCloseLocationMinPct,
  rsiPeriod: value.rsiPeriod,
  rsiPivotLeftBars: value.rsiPivotLeftBars,
  rsiPivotRightBars: value.rsiPivotRightBars,
  rsiPivotMinSpacingBars: value.rsiPivotMinSpacingBars,
  rsiPivotMaxSpacingBars: value.rsiPivotMaxSpacingBars,
  rsiDivergenceMinPoints: value.rsiDivergenceMinPoints,
  rsiDivergenceVolumeContractionMaxRatio:
    value.rsiDivergenceVolumeContractionMaxRatio,
  rsiSetupTimeoutMinutes: value.rsiSetupTimeoutMinutes,
  dailyEmaFilterEnabled: value.dailyEmaFilterEnabled,
});
const versionFor = (value: Parameters) =>
  `phase9-${createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12)}`;
function configureReplay(replay: Replay, value: Parameters): Replay {
  return {
    sessions: replay.sessions.map((item) => {
      const openingStart = item.session.openingRange.start,
        openingEnd = addMinutes(openingStart, value.openingRangeMinutes);
      return {
        ...item,
        session: {
          ...item.session,
          openingRange: { start: openingStart, end: openingEnd },
          scanning: { start: openingEnd, end: value.entryWindowEnd },
          entries: {
            ...item.session.entries,
            preferredStart: maxTime(
              item.session.entries.preferredStart,
              openingEnd,
            ),
            preferredEnd: value.entryWindowEnd,
            hardEnd: value.entryWindowEnd,
          },
        },
      };
    }),
  };
}
function filter(replay: Replay, start: string, end: string): Replay {
  return {
    sessions: replay.sessions.filter((value) => {
      const date = value.session.startTime.slice(0, 10);
      return date >= start && date <= end;
    }),
  };
}
function splitDates(
  start: string,
  end: string,
  trainPct: number,
  validationPct: number,
) {
  const first = Date.parse(`${start}T00:00:00Z`),
    days =
      Math.floor((Date.parse(`${end}T00:00:00Z`) - first) / 86_400_000) + 1;
  return {
    trainEnd: dateAt(
      first,
      Math.max(0, Math.floor((days * trainPct) / 100) - 1),
    ),
    validationEnd: dateAt(
      first,
      Math.max(0, Math.floor((days * (trainPct + validationPct)) / 100) - 1),
    ),
  };
}
const dateAt = (first: number, offset: number) =>
  new Date(first + offset * 86_400_000).toISOString().slice(0, 10);
const dayAfter = (value: string) =>
  new Date(Date.parse(`${value}T00:00:00Z`) + 86_400_000)
    .toISOString()
    .slice(0, 10);
export function weaknessWarnings(
  analyses: BacktestReplayResult["analyses"],
): string[] {
  return analyses
    .filter(
      (slice) =>
        ["SECTOR", "ATR_REGIME", "RVOL_REGIME"].includes(slice.dimension) &&
        slice.trades > 0 &&
        slice.expectancy < 0,
    )
    .map(
      (slice) =>
        `Negative ${slice.dimension} bucket ${slice.bucket}: expectancy ${slice.expectancy.toFixed(4)} over ${slice.trades} trade(s); review this weakness separately from the combined average.`,
    );
}
function addMinutes(value: string, minutes: number) {
  const [hour, minute] = value.split(":").map(Number);
  const total = hour! * 60 + minute! + minutes;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}
const maxTime = (a: string, b: string) => (a > b ? a : b);
const validTime = (value: string) => {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  return !!match && Number(match[1]) < 24 && Number(match[2]) < 60;
};
export function robustScore(values: {
  TRAIN: BacktestMetrics;
  VALIDATION: BacktestMetrics;
  TEST?: BacktestMetrics | null;
  ALL?: BacktestMetrics | null;
}): number {
  // TEST is held out: it is reported and gated after selection, never ranked.
  const segments = [values.TRAIN, values.VALIDATION],
    rs = segments.map((v) => v.averageR),
    mean = rs.reduce((a, b) => a + b, 0) / rs.length,
    variance = rs.reduce((sum, v) => sum + (v - mean) ** 2, 0) / rs.length,
    worst = Math.min(...rs),
    drawdown =
      segments.reduce((sum, v) => sum + v.maximumDrawdownPct, 0) /
      segments.length;
  return Number(
    (mean + worst - Math.sqrt(variance) - drawdown / 100).toFixed(6),
  );
}
function plateauSize(
  trial: CalibrationTrial,
  all: CalibrationTrial[],
  grid: CalibrationGrid,
): number {
  return (
    all.filter(
      (candidate) =>
        selectionSufficient(candidate, 0) &&
        candidate.segments.VALIDATION.expectancy > 0 &&
        candidate.segments.VALIDATION.averageR > 0 &&
        candidate.robustScore >= trial.robustScore - 0.25 &&
        adjacent(trial.parameters, candidate.parameters, grid),
    ).length + 1
  );
}

function selectionSufficient(
  trial: CalibrationTrial,
  minimumTradesPerSegment: number,
): boolean {
  return (
    trial.segments.TRAIN.tradesSimulated >= minimumTradesPerSegment &&
    trial.segments.VALIDATION.tradesSimulated >= minimumTradesPerSegment
  );
}
function adjacent(
  a: Parameters,
  b: Parameters,
  grid: CalibrationGrid,
): boolean {
  let changed = 0;
  for (const key of keys(grid)) {
    const left = grid[key].indexOf(a[key] as never),
      right = grid[key].indexOf(b[key] as never);
    if (left !== right) {
      if (Math.abs(left - right) !== 1) return false;
      changed++;
    }
  }
  return changed === 1;
}
