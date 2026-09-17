import { createHash, randomUUID } from "node:crypto";
import {
  strategyParameterDescriptors,
  defaultStopPolicyForStrategy,
  validateStrategyParameters,
  type CreateScannerProfile,
  type ParameterChange,
  type ParameterIssue,
  type ProfileComparison,
  type ProfileComparisonMetric,
  type MarketId,
  type ProfileConfigHistory,
  type ScannerProfile,
  type StrategyDefinition,
  type StrategyEvaluation,
  type StrategyParameterKey,
  type StrategyParameters,
  type UpdateScannerProfile,
  type ComparisonCohortSelection,
} from "@tsx-scanner/contracts";
import type { ComparisonOutcome, ProfileStore } from "./profile-repository.js";
import { realizedOutcomeDrawdown } from "./comparison-metrics.js";
import { assessComparisonScopes } from "./comparison-scope.js";
import { DomainError, type DomainErrorStatus } from "../errors.js";
import { AUTHORITATIVE_EXECUTION_MODEL_VERSION } from "../backtests/execution-provenance.js";
import type { ProfileBacktestScheduler } from "../backtests/profile-backtest-scheduler.js";

export type ProfileErrorCode =
  | "PROFILE_NOT_FOUND"
  | "STRATEGY_NOT_FOUND"
  | "CALIBRATION_NOT_APPLICABLE"
  | "INVALID_COMPARISON"
  | "COMPARISON_COHORT_REQUIRED"
  | "INVALID_PARAMETERS";

function statusFor(code: ProfileErrorCode): DomainErrorStatus {
  if (code === "PROFILE_NOT_FOUND" || code === "STRATEGY_NOT_FOUND") return 404;
  if (code === "COMPARISON_COHORT_REQUIRED") return 409;
  return 422;
}

export class ProfileError extends DomainError {
  constructor(
    public readonly code: ProfileErrorCode,
    message: string,
    public readonly issues: ParameterIssue[] = [],
    public readonly availableCohorts?: unknown,
  ) {
    super(code, message, statusFor(code), issues);
  }
  override toResponse() {
    const response = super.toResponse();
    return this.availableCohorts === undefined
      ? response
      : { ...response, availableCohorts: this.availableCohorts };
  }
}
const versionFor = (parameters: unknown) =>
  `profile-${createHash("sha256")
    .update(JSON.stringify(parameters) + randomUUID())
    .digest("hex")
    .slice(0, 16)}`;

export class ProfileService {
  constructor(
    private readonly store: ProfileStore,
    private readonly changed?: (
      profiles: ScannerProfile[],
    ) => void | Promise<void>,
    private readonly backtests?: ProfileBacktestScheduler,
  ) {}
  listDefinitions(): Promise<StrategyDefinition[]> {
    return this.store.listDefinitions();
  }
  listProfiles(): Promise<ScannerProfile[]> {
    return this.store.listProfiles();
  }
  async initialize(): Promise<ScannerProfile[]> {
    const profiles = await this.store.listProfiles();
    await this.changed?.(profiles);
    return profiles;
  }
  async create(input: CreateScannerProfile): Promise<ScannerProfile> {
    const definition = (await this.store.listDefinitions()).find(
      (v) => v.id === input.strategyDefinitionId && v.enabled,
    );
    if (!definition)
      throw new ProfileError(
        "STRATEGY_NOT_FOUND",
        "Enabled strategy definition not found",
      );
    this.assertParameters(definition, input.parameters);
    const profile = await this.store.createProfile(
      input,
      versionFor(input.parameters),
    );
    await this.scheduleBacktest(profile);
    await this.refresh();
    return profile;
  }
  async update(
    id: string,
    input: UpdateScannerProfile,
  ): Promise<ScannerProfile> {
    if (input.parameters) {
      const existing = await this.store.getProfile(id);
      if (!existing)
        throw new ProfileError(
          "PROFILE_NOT_FOUND",
          "Scanner profile not found",
        );
      const definition = (await this.store.listDefinitions()).find(
        (v) => v.id === existing.strategyDefinitionId,
      );
      if (!definition)
        throw new ProfileError(
          "STRATEGY_NOT_FOUND",
          "Strategy definition not found",
        );
      this.assertParameters(definition, input.parameters);
      if (input.sourceCalibrationRunId) {
        const calibration = await this.store.getCalibrationRecommendation?.(
          input.sourceCalibrationRunId,
        );
        const matches =
          calibration?.recommendedConfig &&
          Object.entries(input.parameters).every(
            ([key, value]) => calibration.recommendedConfig?.[key] === value,
          );
        if (
          !calibration ||
          calibration.status !== "COMPLETED" ||
          calibration.marketId !== existing.marketId ||
          calibration.executionModelVersion !==
            AUTHORITATIVE_EXECUTION_MODEL_VERSION ||
          calibration.strategy !== existing.strategyKey ||
          !matches
        )
          throw new ProfileError(
            "CALIBRATION_NOT_APPLICABLE",
            `The calibration source must be completed under ${AUTHORITATIVE_EXECUTION_MODEL_VERSION}, target this strategy, and recommend the exact applied parameters.`,
          );
      }
    }
    const profile = await this.store.updateProfile(
      id,
      input,
      input.parameters ? versionFor(input.parameters) : undefined,
    );
    if (!profile)
      throw new ProfileError("PROFILE_NOT_FOUND", "Scanner profile not found");
    if (input.parameters) await this.scheduleBacktest(profile);
    await this.refresh();
    return profile;
  }
  async duplicate(
    id: string,
    name?: string,
    sourceCalibrationRunId?: string,
  ): Promise<ScannerProfile> {
    const original = await this.store.getProfile(id);
    if (!original)
      throw new ProfileError("PROFILE_NOT_FOUND", "Scanner profile not found");
    let parameters = original.parameters;
    if (original.marketId === "US_EQUITIES") {
      const calibration = sourceCalibrationRunId
        ? await this.store.getCalibrationRecommendation?.(
            sourceCalibrationRunId,
          )
        : undefined;
      if (
        !calibration ||
        calibration.status !== "COMPLETED" ||
        calibration.marketId !== original.marketId ||
        calibration.executionModelVersion !==
          AUTHORITATIVE_EXECUTION_MODEL_VERSION ||
        calibration.strategy !== original.strategyKey ||
        !calibration.recommendedConfig
      )
        throw new ProfileError(
          "CALIBRATION_NOT_APPLICABLE",
          `A US challenger requires a completed ${AUTHORITATIVE_EXECUTION_MODEL_VERSION} calibration recommendation for the same market and strategy.`,
        );
      parameters = calibration.recommendedConfig as StrategyParameters;
    }
    const profile = await this.store.createProfile(
      {
        name: name?.trim() || `${original.name} Copy`,
        marketId: original.marketId,
        strategyDefinitionId: original.strategyDefinitionId,
        parameters,
        enabled: false,
        sourceCalibrationRunId,
      },
      versionFor(parameters),
    );
    if (!profile)
      throw new ProfileError("PROFILE_NOT_FOUND", "Scanner profile not found");
    await this.scheduleBacktest(profile);
    await this.refresh();
    return profile;
  }
  /** API-authoritative parameter validation; the React form renders the same descriptors. */
  private assertParameters(
    definition: StrategyDefinition,
    parameters: StrategyParameters,
  ): void {
    const issues = validateStrategyParameters(definition, parameters);
    if (
      definition.strategyKey === "RSI_VWAP_RECLAIM" &&
      parameters.stopPolicy !==
        defaultStopPolicyForStrategy(definition.strategyKey)
    )
      issues.push({
        key: "stopPolicy",
        message: "RSI/VWAP Reclaim requires PATTERN_INVALIDATION stop policy",
      });
    if (issues.length)
      throw new ProfileError(
        "INVALID_PARAMETERS",
        `Invalid parameters for ${definition.name}: ${issues.map((v) => v.message).join("; ")}`,
        issues,
      );
  }
  /** A profile save is durable even if the optional research queue is briefly unavailable. */
  private async scheduleBacktest(profile: ScannerProfile): Promise<void> {
    try {
      await this.backtests?.schedule(profile);
    } catch {
      // A later parameter edit can retry scheduling; never report a failed save
      // after the profile/configuration transaction has already committed.
    }
  }
  /** Immutable configuration versions with a human-readable diff against the version before them. */
  async configHistory(id: string): Promise<ProfileConfigHistory> {
    const profile = await this.store.getProfile(id);
    if (!profile)
      throw new ProfileError("PROFILE_NOT_FOUND", "Scanner profile not found");
    const versions = await this.store.listConfigVersions(id),
      keys = Object.keys(
        strategyParameterDescriptors,
      ) as StrategyParameterKey[];
    return {
      profileId: profile.id,
      profileName: profile.name,
      versions: versions.map((version, index) => {
        const previous = index === 0 ? undefined : versions[index - 1];
        const changes: ParameterChange[] = previous
          ? keys
              .filter(
                (key) => version.parameters[key] !== previous.parameters[key],
              )
              .map((key) => ({
                key,
                label: strategyParameterDescriptors[key].label,
                unit: strategyParameterDescriptors[key].unit,
                previous: previous.parameters[key] ?? null,
                next: version.parameters[key] ?? null,
              }))
          : [];
        return { ...version, changes };
      }),
    };
  }
  listEvaluations(
    profileId?: string,
    limit?: number,
  ): Promise<StrategyEvaluation[]> {
    return this.store.listEvaluations(profileId, limit);
  }
  async opportunities(): Promise<StrategyEvaluation[]> {
    const values = this.store.listLatestEvaluations
        ? await this.store.listLatestEvaluations(5000)
        : await this.store.listEvaluations(undefined, 5000),
      latestByProfileSymbol = new Map<string, StrategyEvaluation>();
    for (const value of values) {
      const key = `${value.profileId}:${value.symbol}`;
      if (!latestByProfileSymbol.has(key))
        latestByProfileSymbol.set(key, value);
    }
    const best = new Map<string, StrategyEvaluation>();
    for (const value of latestByProfileSymbol.values()) {
      const current = best.get(value.symbol);
      if (!current || value.score > current.score)
        best.set(value.symbol, value);
    }
    return [...best.values()].sort(
      (a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol),
    );
  }
  async compare(
    profileIds: string[],
    source: "LIVE" | "PAPER" | "BACKTEST",
    startDate: string,
    endDate: string,
    timeStart = "09:30",
    timeEnd = "16:00",
    marketId: MarketId = "CA_TSX",
    cohortKeys?: ComparisonCohortSelection,
  ): Promise<ProfileComparison> {
    if (
      profileIds.length < 2 ||
      profileIds.length > 10 ||
      new Set(profileIds).size !== profileIds.length ||
      startDate > endDate
    )
      throw new ProfileError(
        "INVALID_COMPARISON",
        "Comparison requires 2–10 profiles and an ordered date range",
      );
    if (
      cohortKeys &&
      Object.keys(cohortKeys).some(
        (profileId) => !profileIds.includes(profileId),
      )
    )
      throw new ProfileError(
        "INVALID_COMPARISON",
        "Cohort selections must belong to requested profiles",
      );
    const profiles = await this.store.listProfiles();
    const selected = profileIds.map((id) => profiles.find((v) => v.id === id));
    if (selected.some((v) => !v))
      throw new ProfileError(
        "PROFILE_NOT_FOUND",
        "One or more scanner profiles were not found",
      );
    if (selected.some((v) => v?.marketId !== marketId))
      throw new ProfileError(
        "INVALID_COMPARISON",
        "Every compared profile must belong to the requested market",
      );
    if (selected.some((v) => (v?.analysisKind ?? "SETUP") !== "SETUP"))
      throw new ProfileError(
        "INVALID_COMPARISON",
        "Trade-performance comparison accepts setup profiles only",
      );
    const cohorts = await this.store.comparisonCohorts(
      profileIds,
      source,
      startDate,
      endDate,
      timeStart,
      timeEnd,
      marketId,
    );
    const availableCohorts = cohorts.map((value) => ({
      profileId: value.profileId,
      cohortKey: value.cohortKey,
      executionModelVersion: value.executionModelVersion,
      executionAssumptionsHash: value.executionAssumptionsHash,
      outcomeCount: value.outcomeCount,
    }));
    for (const profileId of profileIds) {
      const profileCohorts = cohorts.filter(
        (value) => value.profileId === profileId,
      );
      if (profileCohorts.length <= 1) continue;
      const selectedCohort = cohortKeys?.[profileId];
      if (
        !selectedCohort ||
        !profileCohorts.some((value) => value.cohortKey === selectedCohort)
      )
        throw new ProfileError(
          "COMPARISON_COHORT_REQUIRED",
          `Profile ${profileId} spans multiple incompatible evidence cohorts; select one before comparing.`,
          [],
          availableCohorts,
        );
    }
    const outcomes = await this.store.comparisonOutcomes(
      profileIds,
      source,
      startDate,
      endDate,
      timeStart,
      timeEnd,
      marketId,
      cohortKeys,
    );
    const scopes = await this.store.comparisonScopes(
      profileIds,
      source,
      startDate,
      endDate,
      timeStart,
      timeEnd,
      marketId,
      cohortKeys,
    );
    const assessment = assessComparisonScopes(scopes);
    return {
      marketId,
      source,
      startDate,
      endDate,
      timeStart,
      timeEnd,
      status: assessment.status,
      controlled: assessment.controlled,
      differences: assessment.differences,
      availableCohorts: availableCohorts.length ? availableCohorts : undefined,
      metrics: selected.map((profile) =>
        this.metrics(
          profile!,
          outcomes.filter((v) => v.profileId === profile!.id),
        ),
      ),
    };
  }
  private async refresh() {
    await this.changed?.(await this.store.listProfiles());
  }
  private metrics(
    profile: ScannerProfile,
    values: ComparisonOutcome[],
  ): ProfileComparisonMetric {
    const setups = values.filter((v) => v.setup),
      trades = values.filter((v) => v.pnl !== null),
      wins = trades.filter((v) => v.pnl! > 0),
      losses = trades.filter((v) => v.pnl! <= 0),
      pnls = trades.map((v) => v.pnl!),
      grossWin = wins.reduce((s, v) => s + v.pnl!, 0),
      grossLoss = Math.abs(losses.reduce((s, v) => s + v.pnl!, 0));
    const drawdown = realizedOutcomeDrawdown(
      trades.map((value) => ({
        outcomeId: value.outcomeId,
        realizedAt: value.realizedAt,
        pnl: value.pnl!,
      })),
    );
    return {
      profileId: profile.id,
      profileName: profile.name,
      setupCount: setups.length,
      trades: trades.length,
      wins: wins.length,
      winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
      averageWinner: wins.length ? grossWin / wins.length : 0,
      averageLoser: losses.length
        ? losses.reduce((s, v) => s + v.pnl!, 0) / losses.length
        : 0,
      averageR: trades.length
        ? trades.reduce((s, v) => s + (v.rMultiple ?? 0), 0) / trades.length
        : 0,
      profitFactor: grossLoss ? grossWin / grossLoss : grossWin ? null : 0,
      expectancy: trades.length
        ? pnls.reduce((a, b) => a + b, 0) / trades.length
        : 0,
      maximumDrawdown: drawdown.amount,
      drawdownBasis: drawdown.basis,
      drawdownStatus: drawdown.status,
      averageHoldMinutes: trades.length
        ? trades.reduce((s, v) => s + (v.holdMinutes ?? 0), 0) / trades.length
        : 0,
      falsePositiveRate: setups.length
        ? (values.filter((v) => v.falsePositive).length / setups.length) * 100
        : 0,
    };
  }
}
