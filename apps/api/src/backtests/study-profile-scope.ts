import {
  boundedSearchParameterBounds,
  type FrozenStudyPlan,
  strategyParametersSchema,
} from "@tsx-scanner/contracts";
import type { Pool } from "pg";
import { canonicalJson } from "./research-coverage.js";
export type StudyProfileScope = {
  id: string;
  profileId?: string;
  marketId: string;
  strategy: string;
  strategyVersion?: string;
  parameters: unknown;
  isCurrent?: boolean;
};
export function assertStudyProfileScope(
  plan: FrozenStudyPlan,
  profiles: StudyProfileScope[],
): void {
  const baseline = profiles.find((p) => p.id === plan.baselineProfileConfigId),
    challenger = profiles.find((p) => p.id === plan.challengerProfileConfigId);
  if (!baseline || !challenger)
    throw new Error("STUDY_PROFILE_CONFIG_NOT_FOUND");
  const switches = {
    RETEST_CONTRACTION: "retestVolumeContractionEnabled",
    RETEST_REJECTION: "retestRejectionEnabled",
    RETEST_HIGH_BREAK: "retestHighBreakEnabled",
    DAILY_EMA: "dailyEmaFilterEnabled",
    RSI_SEQUENCE: null,
  } as const;
  const toggle =
    plan.variant === "NUMERIC_PARAMETER" ? undefined : switches[plan.variant];
  const baseParameters = strategyParametersSchema.parse(baseline.parameters),
    challengeParameters = strategyParametersSchema.parse(challenger.parameters);
  const difference = new Set(
    [
      ...Object.keys(baseParameters),
      ...Object.keys(challengeParameters),
    ].filter(
      (k) =>
        canonicalJson(
          baseParameters[k as keyof typeof baseParameters] ?? null,
        ) !==
        canonicalJson(
          challengeParameters[k as keyof typeof challengeParameters] ?? null,
        ),
    ),
  );
  if (toggle) {
    if (
      difference.size !== 1 ||
      !difference.has(toggle) ||
      baseParameters[toggle] !== 0 ||
      challengeParameters[toggle] !== 1 ||
      baseline.strategy !== challenger.strategy
    )
      throw new Error("STUDY_VARIANT_MISMATCH");
    if (
      plan.variant.startsWith("RETEST_") &&
      !["ORB_RETEST", "VWAP_HOLD"].includes(baseline.strategy)
    )
      throw new Error("STUDY_VARIANT_MISMATCH");
  } else if (plan.variant === "NUMERIC_PARAMETER") {
    const candidate = plan.boundedRuleCandidate;
    const change =
      candidate?.changes.length === 1 ? candidate.changes[0] : null;
    const parameter = change?.key as keyof typeof baseParameters | undefined;
    if (
      !candidate ||
      !change ||
      !parameter ||
      boundedSearchParameterBounds[change.key].kind !== "numeric" ||
      candidate.marketId !== plan.comparison.marketId ||
      candidate.strategy !== baseline.strategy ||
      baseline.strategy !== challenger.strategy ||
      !baseline.profileId ||
      baseline.profileId !== challenger.profileId ||
      !baseline.strategyVersion ||
      baseline.strategyVersion !== challenger.strategyVersion ||
      challenger.isCurrent !== false ||
      difference.size !== 1 ||
      !difference.has(change.key) ||
      baseParameters[parameter] !== change.from ||
      challengeParameters[parameter] !== change.to ||
      canonicalJson(candidate.parameters) !== canonicalJson(challengeParameters)
    )
      throw new Error(
        challenger.isCurrent === true
          ? "STUDY_NUMERIC_CHALLENGER_CONFIG_ACTIVE"
          : "STUDY_VARIANT_MISMATCH",
      );
  } else if (
    baseline.strategy !== "VWAP_RECLAIM" ||
    challenger.strategy !== "RSI_VWAP_RECLAIM" ||
    difference.size !== 0
  )
    throw new Error("STUDY_VARIANT_MISMATCH");
  const scope = (v: FrozenStudyPlan["inputs"]["TRAIN"]["baseline"]) => ({
    marketId: v.marketId,
    symbols: v.symbols,
    dataSource: v.dataSource,
    startingCapital: v.startingCapital,
    positionSize: v.positionSize,
    slippageBps: v.slippageBps,
    feePerTrade: v.feePerTrade,
  });
  const frozenScope = canonicalJson(scope(plan.inputs.TRAIN.baseline));
  for (const input of Object.values(plan.inputs))
    for (const [side, profile] of [
      ["baseline", baseline],
      ["challenger", challenger],
    ] as const) {
      const request = input[side];
      if (
        profile.marketId !== plan.comparison.marketId ||
        canonicalJson(request.strategies) !==
          canonicalJson([profile.strategy]) ||
        canonicalJson(strategyParametersSchema.parse(request.parameters)) !==
          canonicalJson(strategyParametersSchema.parse(profile.parameters))
      )
        throw new Error("STUDY_PROFILE_CONFIG_MISMATCH");
      if (canonicalJson(scope(request)) !== frozenScope)
        throw new Error("STUDY_COMPARISON_SCOPE_MISMATCH");
    }
}
export async function verifyStudyProfiles(
  pool: Pool,
  plan: FrozenStudyPlan,
): Promise<void> {
  const result = await pool.query<{
    id: string;
    profile_id: string;
    market_id: string;
    strategy_key: string;
    strategy_version: string;
    parameters: unknown;
    is_current: boolean;
  }>(
    `SELECT c.id,c.profile_id,c.market_id,d.strategy_key,d.version strategy_version,c.parameters,(p.current_config_id=c.id) is_current FROM scanner_profile_config c JOIN scanner_profile p ON p.id=c.profile_id JOIN strategy_definition d ON d.id=p.strategy_definition_id WHERE c.id=ANY($1::uuid[])`,
    [[plan.baselineProfileConfigId, plan.challengerProfileConfigId]],
  );
  assertStudyProfileScope(
    plan,
    result.rows.map((r) => ({
      id: r.id,
      profileId: r.profile_id,
      marketId: r.market_id,
      strategy: r.strategy_key,
      strategyVersion: r.strategy_version,
      parameters: r.parameters,
      isCurrent: r.is_current,
    })),
  );
}
