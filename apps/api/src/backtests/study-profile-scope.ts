import {
  type FrozenStudyPlan,
  strategyParametersSchema,
} from "@tsx-scanner/contracts";
import type { Pool } from "pg";
import { canonicalJson } from "./research-coverage.js";
export type StudyProfileScope = {
  id: string;
  marketId: string;
  strategy: string;
  parameters: unknown;
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
  const toggle = switches[plan.variant];
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
    market_id: string;
    strategy_key: string;
    parameters: unknown;
  }>(
    `SELECT c.id,c.market_id,d.strategy_key,c.parameters FROM scanner_profile_config c JOIN scanner_profile p ON p.id=c.profile_id JOIN strategy_definition d ON d.id=p.strategy_definition_id WHERE c.id=ANY($1::uuid[])`,
    [[plan.baselineProfileConfigId, plan.challengerProfileConfigId]],
  );
  assertStudyProfileScope(
    plan,
    result.rows.map((r) => ({
      id: r.id,
      marketId: r.market_id,
      strategy: r.strategy_key,
      parameters: r.parameters,
    })),
  );
}
