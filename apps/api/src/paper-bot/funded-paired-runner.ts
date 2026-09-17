import type { CreateBacktest } from "@tsx-scanner/contracts";
import {
  fundedComparisonPolicyEvaluationSchema,
  type FundedComparisonPolicyEvaluation,
  type FundedComparisonSide,
  type FundedComparisonSourceOpportunity,
  type FundedComparisonSpecification,
} from "@tsx-scanner/contracts";
import type { Pool } from "pg";
import {
  loadFundedComparisonSharedInput,
  type FundedComparisonSharedInput,
  type FundedComparisonSharedInputSource,
} from "./funded-comparison-shared-input.js";
import { FundedComparisonRepository } from "./funded-comparison-repository.js";
import {
  FundedComparisonSpecificationError,
  assertSessionSourceOpportunityOwnership,
} from "./funded-comparison-specification.js";
import {
  loadFundedComparisonChallenger,
  predictFundedComparisonBatch,
  type FundedComparisonInferenceEngine,
} from "./funded-comparison-prediction.js";
import {
  orderChallengerCandidates,
  type ChallengerOrdering,
} from "./funded-comparison-challenger-policy.js";
import {
  applyComparisonSideSession,
  prepareComparisonSideObservations,
  projectComparisonSideSession,
  type ComparisonSideRunnerDependencies,
  type ComparisonSideSessionInput,
  type ComparisonSideSessionResult,
} from "./funded-comparison-side-runner.js";
import type { FundedDecisionEvidenceSource } from "./funded-decision-capture.js";
import { FundedComparisonChampionError } from "./funded-comparison-champion.js";
import { normalizeFundedPolicy, type FundedPolicy } from "./funded-policy.js";
import {
  provisionHistoricalFundedRun,
  type ProvisionedHistoricalFundedRun,
} from "./funded-historical-provisioning.js";
import type { FundedHistoricalProfile } from "./funded-historical-signal-bridge.js";
import { contentHash } from "./funded-evidence-digest.js";
import { stableUuid } from "./stable-uuid.js";
import type { FundedReportingService } from "./funded-reporting-service.js";
import type { AssumptionsSnapshot } from "./types.js";

/**
 * Policy-neutral paired runner: champion first, then comparison-owned inference,
 * then the challenger in the approved applied order. Both sides consume exactly
 * the frozen session and opportunity membership on separate dedicated replay
 * accounts and never touch a live funded account. It never writes the final
 * result; the comparison service owns valuation, metrics and finalization.
 */

export const FUNDED_COMPARISON_REPLAY_ACCOUNT_VERSION =
  "funded-comparison-replay-account-v1";

export interface FundedPairedComparisonInput {
  readonly specificationId: string;
  readonly maxSessions: number;
}

export interface FundedPairedComparisonDependencies {
  readonly pool: Pool;
  readonly repository: FundedComparisonRepository;
  readonly predictionEngine: FundedComparisonInferenceEngine;
  readonly reporting: FundedReportingService;
  /**
   * Comparison-owned decision-time evidence for one frozen session. Replay
   * never re-queries a retention-managed source table.
   */
  readonly evidenceSourceFor: (
    shared: FundedComparisonSharedInput,
  ) => FundedDecisionEvidenceSource;
  /** Called before each session and each side for cancellation/lease safety. */
  readonly betweenSessions?: () => Promise<void>;
  /** Test seam; production always uses the real side runner. */
  readonly applySide?: typeof applyComparisonSideSession;
  /** Test seam; production always re-reads a completed side from durable rows. */
  readonly projectSide?: typeof projectComparisonSideSession;
  /** Test seam; production always provisions through the historical path. */
  readonly provisionRun?: typeof provisionHistoricalFundedRun;
  /** Test seam; production prepares durable observations without facts. */
  readonly prepareSide?: typeof prepareComparisonSideObservations;
}

export interface FundedPairedSessionOutcome {
  readonly sessionDate: string;
  readonly champion: ComparisonSideSessionResult;
  readonly challenger: ComparisonSideSessionResult;
  readonly championEvaluations: readonly FundedComparisonPolicyEvaluation[];
  readonly challengerEvaluations: readonly FundedComparisonPolicyEvaluation[];
  readonly predictionFallback: boolean;
  readonly ordering: ChallengerOrdering | null;
}

export interface FundedPairedRunResult {
  readonly specificationId: string;
  readonly sessions: readonly FundedPairedSessionOutcome[];
  readonly skippedSessions: readonly string[];
}

export interface FundedComparisonChampionPolicyRecord {
  readonly policy: FundedPolicy;
  readonly assumptions: AssumptionsSnapshot;
}

export function championReplayAccountId(specDigest: string): string {
  return stableUuid(
    `${FUNDED_COMPARISON_REPLAY_ACCOUNT_VERSION}:champion-account:${specDigest}`,
  );
}

export function challengerReplayAccountId(specDigest: string): string {
  return stableUuid(
    `${FUNDED_COMPARISON_REPLAY_ACCOUNT_VERSION}:challenger-account:${specDigest}`,
  );
}

/** Loads the exact persisted champion policy and assumptions named by the spec. */
export async function loadFundedComparisonChampionPolicy(
  pool: Pool,
  specification: Pick<
    FundedComparisonSpecification,
    "marketId" | "currency" | "champion"
  >,
): Promise<FundedComparisonChampionPolicyRecord> {
  const { rows } = await pool.query<{
    policy: unknown;
    assumptions: AssumptionsSnapshot;
    execution_model_version: string;
    account_id: string;
    market_id: string;
    currency: string;
  }>(
    `SELECT b.policy,r.assumptions,r.execution_model_version,b.account_id,
       r.market_id,b.currency
     FROM paper_bot_run r JOIN paper_funded_run b ON b.run_id=r.id
     WHERE r.id=$1`,
    [specification.champion.sourceLiveRunId],
  );
  const row = rows[0];
  if (
    !row ||
    row.account_id !== specification.champion.sourceAccountId ||
    row.market_id !== specification.marketId ||
    row.currency !== specification.currency ||
    row.execution_model_version !== specification.champion.executionModelVersion
  )
    throw new FundedComparisonChampionError(
      "CHAMPION_POLICY_IDENTITY_MISMATCH",
      "The retained champion source no longer matches the frozen identity",
    );
  if (contentHash(row.policy) !== specification.champion.policyDigest)
    throw new FundedComparisonChampionError(
      "CHAMPION_POLICY_IDENTITY_MISMATCH",
      "The retained champion policy digest changed after the freeze",
    );
  if (contentHash(row.assumptions) !== specification.champion.assumptionsDigest)
    throw new FundedComparisonChampionError(
      "RUNTIME_IDENTITY_MISMATCH",
      "The retained champion assumptions changed after the freeze",
    );
  return {
    policy: normalizeFundedPolicy(row.policy as FundedPolicy),
    assumptions: row.assumptions,
  };
}

/**
 * A live funded account is never a replay target. A deterministic replay
 * account already owned by a run bound to the same specification is reusable;
 * an account used by a live run or by another comparison still fails closed.
 */
export async function assertReplayAccountIsolation(
  pool: Pool,
  specification: Pick<
    FundedComparisonSpecification,
    "champion" | "challenger" | "comparisonSpecDigest" | "marketId" | "currency"
  >,
  specificationId: string,
  championAccountId: string,
  challengerAccountId: string,
): Promise<void> {
  if (championAccountId === challengerAccountId)
    throw new FundedComparisonSpecificationError(
      "ACCOUNT_IDENTITY_COLLISION",
      "The two comparison replay accounts are identical",
    );
  if (
    specification.champion.sourceAccountId === championAccountId ||
    specification.champion.sourceAccountId === challengerAccountId
  )
    throw new FundedComparisonSpecificationError(
      "LIVE_ACCOUNT_REPLAY_TARGET",
      "The champion's live account cannot be a comparison replay target",
    );
  const { rows } = await pool.query<{
    run_id: string;
    account_id: string;
    source: string;
    run_session_date: string | Date;
    binding_spec_id: string | null;
    binding_side: FundedComparisonSide | null;
    binding_session_date: string | Date | null;
    binding_run_id: string | null;
    binding_account_id: string | null;
    intent_spec_id: string | null;
    intent_side: FundedComparisonSide | null;
    intent_session_date: string | Date | null;
    intent_account_id: string | null;
    intent_market_id: string | null;
    intent_currency: string | null;
    intent_policy_digest: string | null;
    intent_execution_model_version: string | null;
    intent_account_assumption_digest: string | null;
    run_market_id: string;
    run_execution_model_version: string;
    run_assumptions: unknown;
    run_policy: unknown;
    run_currency: string;
  }>(
    `SELECT b.run_id,b.account_id,r.source,r.session_date AS run_session_date,
            rb.spec_id AS binding_spec_id,rb.side AS binding_side,
            rb.session_date AS binding_session_date,
            rb.run_id AS binding_run_id,rb.account_id AS binding_account_id,
            pi.spec_id AS intent_spec_id,pi.side AS intent_side,
            pi.session_date AS intent_session_date,
            pi.account_id AS intent_account_id,pi.market_id AS intent_market_id,
            pi.currency AS intent_currency,pi.policy_digest AS intent_policy_digest,
            pi.execution_model_version AS intent_execution_model_version,
            pi.account_assumption_digest AS intent_account_assumption_digest,
            r.market_id AS run_market_id,
            r.execution_model_version AS run_execution_model_version,
            r.assumptions AS run_assumptions,b.policy AS run_policy,
            b.currency AS run_currency
       FROM paper_funded_run b JOIN paper_bot_run r ON r.id=b.run_id
       LEFT JOIN funded_comparison_run_binding rb ON rb.run_id=b.run_id
       LEFT JOIN funded_comparison_provisioning_intent pi
         ON pi.account_id=b.account_id AND pi.session_date=r.session_date
      WHERE b.account_id=ANY($1::uuid[])`,
    [[championAccountId, challengerAccountId]],
  );
  const rowsByRun = new Map<string, typeof rows>();
  for (const row of rows) {
    const runRows = rowsByRun.get(row.run_id) ?? [];
    runRows.push(row);
    rowsByRun.set(row.run_id, runRows);
  }
  const dateOnly = (value: string | Date): string =>
    typeof value === "string"
      ? value.slice(0, 10)
      : value.toISOString().slice(0, 10);
  for (const runRows of rowsByRun.values()) {
    const row = runRows[0]!;
    if (row.source === "LIVE")
      throw new FundedComparisonSpecificationError(
        "LIVE_ACCOUNT_REPLAY_TARGET",
        "A comparison replay account is also a live funded account",
      );
    const bindings = runRows.filter(
      (candidate) => candidate.binding_spec_id !== null,
    );
    const expectedSide: FundedComparisonSide =
      row.account_id === championAccountId ? "CHAMPION" : "CHALLENGER";
    if (bindings.length === 0) {
      const expectedPolicyDigest =
        expectedSide === "CHAMPION"
          ? specification.champion.policyDigest
          : specification.challenger.policyDigest;
      if (
        runRows.length !== 1 ||
        row.intent_spec_id !== specificationId ||
        row.intent_side !== expectedSide ||
        row.intent_session_date === null ||
        dateOnly(row.intent_session_date) !== dateOnly(row.run_session_date) ||
        row.intent_account_id !== row.account_id ||
        row.intent_market_id !== specification.marketId ||
        row.intent_currency !== specification.currency ||
        row.intent_policy_digest !== expectedPolicyDigest ||
        row.intent_execution_model_version !==
          specification.champion.executionModelVersion ||
        row.intent_account_assumption_digest !==
          specification.champion.accountAssumptionDigest ||
        row.run_market_id !== specification.marketId ||
        row.run_currency !== specification.currency ||
        row.run_execution_model_version !==
          specification.champion.executionModelVersion ||
        contentHash(row.run_policy) !== specification.champion.policyDigest ||
        contentHash(row.run_assumptions) !==
          specification.champion.assumptionsDigest
      )
        throw new FundedComparisonSpecificationError(
          "ACCOUNT_IDENTITY_COLLISION",
          "An unbound replay run has no exact comparison-owned provisioning proof",
        );
      continue;
    }
    if (bindings.length !== 1)
      throw new FundedComparisonSpecificationError(
        "ACCOUNT_IDENTITY_COLLISION",
        "A run on a deterministic replay account must have exactly one comparison binding",
      );
    const binding = bindings[0]!;
    if (binding.binding_spec_id !== specificationId)
      throw new FundedComparisonSpecificationError(
        "ACCOUNT_IDENTITY_COLLISION",
        "A comparison replay account is owned by another comparison specification",
      );
    if (
      binding.binding_side !== expectedSide ||
      binding.binding_run_id !== row.run_id ||
      binding.binding_account_id !== row.account_id ||
      binding.binding_session_date === null ||
      dateOnly(binding.binding_session_date) !== dateOnly(row.run_session_date)
    )
      throw new FundedComparisonSpecificationError(
        "ACCOUNT_IDENTITY_COLLISION",
        "A comparison replay binding has the wrong account, side, run, or session identity",
      );
  }
}

function profilesOf(
  specification: FundedComparisonSpecification,
): FundedHistoricalProfile[] {
  return specification.replay.profiles.map((profile) => ({
    strategy: profile.strategyKey as FundedHistoricalProfile["strategy"],
    profileId: profile.profileId,
    profileName: profile.profileName,
    profileConfigId: profile.profileConfigId,
    configVersion: profile.configVersion,
  }));
}

async function loadRunStatus(
  pool: Pool,
  runId: string,
): Promise<string | undefined> {
  const { rows } = await pool.query<{ status: string }>(
    "SELECT status FROM paper_bot_run WHERE id=$1",
    [runId],
  );
  return rows[0]?.status;
}

function withinBatchChampionRanks(
  opportunities: readonly FundedComparisonSourceOpportunity[],
): ReadonlyMap<string, number> {
  const ranks = new Map<string, number>();
  const forTimestamp = new Map<string, FundedComparisonSourceOpportunity[]>();
  for (const opportunity of opportunities) {
    const list = forTimestamp.get(opportunity.signalTimestamp) ?? [];
    list.push(opportunity);
    forTimestamp.set(opportunity.signalTimestamp, list);
  }
  for (const list of forTimestamp.values()) {
    list
      .sort((left, right) =>
        left.sourceOrdinal !== right.sourceOrdinal
          ? left.sourceOrdinal - right.sourceOrdinal
          : left.sourceOpportunityId.localeCompare(right.sourceOpportunityId),
      )
      .forEach((opportunity, index) =>
        ranks.set(opportunity.sourceOpportunityId, index + 1),
      );
  }
  return ranks;
}

function evaluationOf(input: {
  specId: string;
  side: FundedComparisonSide;
  sessionDate: string;
  runId: string;
  opportunity: FundedComparisonSourceOpportunity;
  destinationObservationId: string;
  championRank: number;
  appliedRank: number;
  disposition: FundedComparisonPolicyEvaluation["disposition"];
  fallbackReason: string | null;
  prediction: FundedComparisonPolicyEvaluation["prediction"];
}): FundedComparisonPolicyEvaluation {
  const withoutDigest = {
    specId: input.specId,
    side: input.side,
    sessionDate: input.sessionDate,
    sourceOpportunityId: input.opportunity.sourceOpportunityId,
    sourceOrdinal: input.opportunity.sourceOrdinal,
    signalTimestamp: input.opportunity.signalTimestamp,
    batchKey: input.opportunity.signalTimestamp,
    championRank: input.championRank,
    appliedRank: input.appliedRank,
    destinationRunId: input.runId,
    destinationObservationId: input.destinationObservationId,
    disposition: input.disposition,
    fallbackReason: input.fallbackReason,
    prediction: input.prediction,
  };
  return fundedComparisonPolicyEvaluationSchema.parse({
    ...withoutDigest,
    evaluationDigest: contentHash(withoutDigest),
  });
}

export async function runFundedPairedComparison(
  input: FundedPairedComparisonInput,
  deps: FundedPairedComparisonDependencies,
): Promise<FundedPairedRunResult> {
  const applySide = deps.applySide ?? applyComparisonSideSession;
  const prepareSide = deps.prepareSide ?? prepareComparisonSideObservations;
  const projectSide = deps.projectSide ?? projectComparisonSideSession;
  const source: FundedComparisonSharedInputSource = {
    loadSpecification: (specId) => deps.repository.loadSpecification(specId),
    loadSessionChunks: (specId, sessionDate) =>
      deps.repository.loadSessionChunks(specId, sessionDate),
  };
  const receipt = await deps.repository.loadSpecification(
    input.specificationId,
  );
  if (!receipt)
    throw new FundedComparisonSpecificationError(
      "RETAINED_INPUT_MISSING",
      `Comparison specification ${input.specificationId} does not exist`,
    );
  const specification = receipt.specification;
  const championAccountId = championReplayAccountId(
    specification.comparisonSpecDigest,
  );
  const challengerAccountId = challengerReplayAccountId(
    specification.comparisonSpecDigest,
  );
  await assertReplayAccountIsolation(
    deps.pool,
    specification,
    input.specificationId,
    championAccountId,
    challengerAccountId,
  );
  const championSource = await loadFundedComparisonChampionPolicy(
    deps.pool,
    specification,
  );
  const challenger = await loadFundedComparisonChallenger(
    deps.pool,
    specification,
  );
  const profiles = profilesOf(specification);
  const parameters = specification.replay.request
    .parameters as CreateBacktest["parameters"];
  const metrics = await deps.repository.listSessionMetrics(
    input.specificationId,
  );
  const proven = (side: FundedComparisonSide, sessionDate: string) =>
    metrics.some(
      (metric) =>
        metric.side === side &&
        metric.sessionDate === sessionDate &&
        metric.valuation === "UNION_GRID_MTM",
    );
  const hasCompleteEvaluationMembership = async (
    side: FundedComparisonSide,
    sessionDate: string,
  ): Promise<boolean> => {
    const expected = receipt.opportunities.filter(
      (opportunity) => opportunity.sessionDate === sessionDate,
    );
    const evaluations = await deps.repository.listPolicyEvaluations(
      input.specificationId,
      side,
      sessionDate,
    );
    return (
      evaluations.length === expected.length &&
      evaluations.every(
        (evaluation, index) =>
          evaluation.sourceOpportunityId ===
            expected[index]!.sourceOpportunityId &&
          evaluation.sourceOrdinal === expected[index]!.sourceOrdinal,
      )
    );
  };
  const sessions: FundedPairedSessionOutcome[] = [];
  const skippedSessions: string[] = [];
  let processed = 0;
  for (const sessionDate of specification.sessionMembership
    .orderedSessionDates) {
    const championBinding = await deps.repository.findBinding(
      input.specificationId,
      "CHAMPION",
      sessionDate,
    );
    const challengerBinding = await deps.repository.findBinding(
      input.specificationId,
      "CHALLENGER",
      sessionDate,
    );
    const [championEvaluationsComplete, challengerEvaluationsComplete] =
      await Promise.all([
        championBinding && proven("CHAMPION", sessionDate)
          ? hasCompleteEvaluationMembership("CHAMPION", sessionDate)
          : false,
        challengerBinding && proven("CHALLENGER", sessionDate)
          ? hasCompleteEvaluationMembership("CHALLENGER", sessionDate)
          : false,
      ]);
    if (
      championBinding &&
      challengerBinding &&
      proven("CHAMPION", sessionDate) &&
      proven("CHALLENGER", sessionDate) &&
      championEvaluationsComplete &&
      challengerEvaluationsComplete
    ) {
      skippedSessions.push(sessionDate);
      continue;
    }
    if (processed >= input.maxSessions) break;
    await deps.betweenSessions?.();
    processed += 1;
    const shared = await loadFundedComparisonSharedInput(
      source,
      input.specificationId,
      sessionDate,
    );
    assertSessionSourceOpportunityOwnership(
      specification,
      receipt,
      sessionDate,
      shared.opportunities,
    );
    const evidenceSource = deps.evidenceSourceFor(shared);
    const sideDeps: ComparisonSideRunnerDependencies = {
      pool: deps.pool,
      reporting: deps.reporting,
    };
    const championRanks = withinBatchChampionRanks(shared.opportunities);
    const championOrdering = shared.opportunities.map((opportunity) => ({
      sourceOpportunityId: opportunity.sourceOpportunityId,
      appliedRank: championRanks.get(opportunity.sourceOpportunityId)!,
    }));

    // Champion: provision or adopt, bind before any fact exists, then apply.
    const championRunId = await resolveSideRunId(
      "CHAMPION",
      championAccountId,
      championBinding?.runId,
      sessionDate,
      shared,
    );
    await deps.repository.bindSessionSide(
      input.specificationId,
      "CHAMPION",
      sessionDate,
      bindingOf(
        specification,
        "CHAMPION",
        championRunId,
        championAccountId,
        shared.sessionStartAt,
      ),
    );
    await deps.betweenSessions?.();
    const championRun = await runOrAdoptSide(
      "CHAMPION",
      {
        specId: input.specificationId,
        side: "CHAMPION",
        runId: championRunId,
        accountId: championAccountId,
        currency: specification.currency,
        marketId: specification.marketId,
        shared,
        profiles,
        parameters,
        assumptions: championSource.assumptions,
        policy: championSource.policy,
        ordering: championOrdering,
        evidenceSource,
      },
      sideDeps,
      applySide,
    );
    assertResolved("CHAMPION", shared.sessionDate, championRun);
    const championDecisions = new Map(
      shared.opportunities.map((opportunity) => [
        opportunity.sourceOpportunityId,
        championRun.decisions.get(opportunity.sourceOpportunityId)!,
      ]),
    );
    const championEvaluations = shared.opportunities.map((opportunity) =>
      evaluationOf({
        specId: input.specificationId,
        side: "CHAMPION",
        sessionDate,
        runId: championRunId,
        opportunity,
        destinationObservationId: championRun.observations.get(
          opportunity.sourceOpportunityId,
        )!,
        championRank: championRanks.get(opportunity.sourceOpportunityId)!,
        appliedRank: championRanks.get(opportunity.sourceOpportunityId)!,
        disposition: "CHAMPION_ORDER",
        fallbackReason: null,
        prediction: null,
      }),
    );
    await deps.repository.appendPolicyEvaluations(
      input.specificationId,
      "CHAMPION",
      sessionDate,
      championEvaluations,
    );

    // Provision/bind the challenger before preparing its destination rows. The
    // provisioning intent was already committed by resolveSideRunId.
    const challengerRunId = await resolveSideRunId(
      "CHALLENGER",
      challengerAccountId,
      challengerBinding?.runId,
      sessionDate,
      shared,
    );
    await deps.repository.bindSessionSide(
      input.specificationId,
      "CHALLENGER",
      sessionDate,
      bindingOf(
        specification,
        "CHALLENGER",
        challengerRunId,
        challengerAccountId,
        shared.sessionStartAt,
      ),
    );

    const batches = new Map<string, FundedComparisonSourceOpportunity[]>();
    for (const opportunity of shared.opportunities) {
      const list = batches.get(opportunity.signalTimestamp) ?? [];
      list.push(opportunity);
      batches.set(opportunity.signalTimestamp, list);
    }
    let challengerEvaluations = [
      ...(await deps.repository.listPolicyEvaluations(
        input.specificationId,
        "CHALLENGER",
        sessionDate,
      )),
    ];
    const expectedById = new Map(
      shared.opportunities.map((opportunity) => [
        opportunity.sourceOpportunityId,
        opportunity,
      ]),
    );
    if (
      challengerEvaluations.length > 0 &&
      (challengerEvaluations.length !== shared.opportunities.length ||
        challengerEvaluations.some((evaluation) => {
          const expected = expectedById.get(evaluation.sourceOpportunityId);
          return (
            !expected ||
            evaluation.specId !== input.specificationId ||
            evaluation.side !== "CHALLENGER" ||
            evaluation.sessionDate !== sessionDate ||
            evaluation.sourceOrdinal !== expected.sourceOrdinal ||
            evaluation.destinationRunId !== challengerRunId
          );
        }))
    )
      throw new FundedComparisonSpecificationError(
        "OPPORTUNITY_MEMBERSHIP_MISMATCH",
        `Stored challenger evaluations do not match session ${sessionDate}`,
      );

    let predictionFallback = challengerEvaluations.some(
      (evaluation) => evaluation.disposition === "FALLBACK_CHAMPION_ORDER",
    );
    let lastOrdering: ChallengerOrdering | null = null;
    let challengerObservations: ReadonlyMap<string, string>;
    if (challengerEvaluations.length === 0) {
      challengerObservations = await prepareSide(
        {
          specId: input.specificationId,
          side: "CHALLENGER",
          runId: challengerRunId,
          accountId: challengerAccountId,
          currency: specification.currency,
          marketId: specification.marketId,
          shared,
          profiles,
          parameters,
          assumptions: championSource.assumptions,
          policy: championSource.policy,
          ordering: [],
          evidenceSource,
        },
        sideDeps,
      );
      const dispositions = new Map<
        string,
        {
          disposition: FundedComparisonPolicyEvaluation["disposition"];
          appliedRank: number;
          fallbackReason: string | null;
        }
      >();
      const predictionIdentity = new Map<
        string,
        NonNullable<FundedComparisonPolicyEvaluation["prediction"]>
      >();
      for (const [signalTimestamp, list] of batches) {
        const batch = await predictFundedComparisonBatch(
          {
            specification,
            challenger,
            signalTimestamp,
            candidates: list.map((opportunity) => ({
              sourceOpportunityId: opportunity.sourceOpportunityId,
              sourceOrdinal: opportunity.sourceOrdinal,
              signalTimestamp: opportunity.signalTimestamp,
              deterministicScore: shared.opportunityItems.get(
                opportunity.sourceOpportunityId,
              )!.score,
              decisionAt: opportunity.signalTimestamp,
              observationId: championRun.observations.get(
                opportunity.sourceOpportunityId,
              )!,
            })),
            championDecisions,
          },
          deps.predictionEngine,
        );
        if (batch.batchFallback) predictionFallback = true;
        const approved = orderChallengerCandidates(
          batch.candidates,
          specification.challenger,
        );
        lastOrdering = approved;
        for (const entry of approved.entries) {
          dispositions.set(entry.sourceOpportunityId, {
            disposition: entry.disposition,
            appliedRank: entry.appliedRank,
            fallbackReason: entry.fallbackReason,
          });
          const identity = batch.identities.get(entry.sourceOpportunityId);
          if (identity)
            predictionIdentity.set(entry.sourceOpportunityId, identity);
        }
      }
      challengerEvaluations = shared.opportunities.map((opportunity) => {
        const disposition = dispositions.get(opportunity.sourceOpportunityId);
        if (!disposition)
          throw new FundedComparisonSpecificationError(
            "OPPORTUNITY_MEMBERSHIP_MISMATCH",
            `No challenger disposition exists for ${opportunity.sourceOpportunityId}`,
          );
        return evaluationOf({
          specId: input.specificationId,
          side: "CHALLENGER",
          sessionDate,
          runId: challengerRunId,
          opportunity,
          destinationObservationId: challengerObservations.get(
            opportunity.sourceOpportunityId,
          )!,
          championRank: championRanks.get(opportunity.sourceOpportunityId)!,
          appliedRank: disposition.appliedRank,
          disposition: disposition.disposition,
          fallbackReason: disposition.fallbackReason,
          prediction:
            predictionIdentity.get(opportunity.sourceOpportunityId) ?? null,
        });
      });
      await deps.repository.appendPolicyEvaluations(
        input.specificationId,
        "CHALLENGER",
        sessionDate,
        challengerEvaluations,
      );
    } else {
      challengerObservations = new Map(
        challengerEvaluations.map((evaluation) => [
          evaluation.sourceOpportunityId,
          evaluation.destinationObservationId,
        ]),
      );
      const latestBatch = [
        ...new Set(
          challengerEvaluations.map((evaluation) => evaluation.batchKey),
        ),
      ]
        .sort()
        .at(-1);
      if (latestBatch) {
        const batchRows = challengerEvaluations.filter(
          (evaluation) => evaluation.batchKey === latestBatch,
        );
        lastOrdering = {
          batchKey: latestBatch,
          batchFallback: batchRows.some(
            (evaluation) =>
              evaluation.disposition === "FALLBACK_CHAMPION_ORDER",
          ),
          entries: batchRows.map((evaluation) => ({
            sourceOpportunityId: evaluation.sourceOpportunityId,
            championRank: evaluation.championRank,
            appliedRank: evaluation.appliedRank,
            disposition:
              evaluation.disposition === "PREDICTED"
                ? "PREDICTED"
                : "FALLBACK_CHAMPION_ORDER",
            fallbackReason: evaluation.fallbackReason,
          })),
        };
      }
    }

    await deps.betweenSessions?.();
    const challengerRun = await runOrAdoptSide(
      "CHALLENGER",
      {
        specId: input.specificationId,
        side: "CHALLENGER",
        runId: challengerRunId,
        accountId: challengerAccountId,
        currency: specification.currency,
        marketId: specification.marketId,
        shared,
        profiles,
        parameters,
        assumptions: championSource.assumptions,
        policy: championSource.policy,
        ordering: challengerEvaluations.map((evaluation) => ({
          sourceOpportunityId: evaluation.sourceOpportunityId,
          appliedRank: evaluation.appliedRank,
        })),
        evidenceSource,
        preparedObservations: challengerObservations,
      },
      sideDeps,
      applySide,
    );
    assertResolved("CHALLENGER", shared.sessionDate, challengerRun);
    sessions.push({
      sessionDate,
      champion: championRun,
      challenger: challengerRun,
      championEvaluations,
      challengerEvaluations,
      predictionFallback,
      ordering: lastOrdering,
    });
  }
  return {
    specificationId: input.specificationId,
    sessions,
    skippedSessions,
  };

  async function runOrAdoptSide(
    side: FundedComparisonSide,
    sideInput: ComparisonSideSessionInput,
    sideDependencies: ComparisonSideRunnerDependencies,
    apply: typeof applyComparisonSideSession,
  ): Promise<ComparisonSideSessionResult> {
    const status = await loadRunStatus(deps.pool, sideInput.runId);
    if (status === "COMPLETED") return projectSide(sideInput, sideDependencies);
    if (status !== "RUNNING" && status !== "CLOSE_PENDING")
      throw new FundedComparisonSpecificationError(
        "REPLAY_LINEAGE_UNAVAILABLE",
        `${side} run ${sideInput.runId} is not resumable (status ${status})`,
      );
    return apply(sideInput, sideDependencies);
  }

  async function resolveSideRunId(
    side: FundedComparisonSide,
    accountId: string,
    existingRunId: string | undefined,
    sessionDate: string,
    shared: FundedComparisonSharedInput,
  ): Promise<string> {
    if (existingRunId) {
      const binding = await deps.repository.findBinding(
        input.specificationId,
        side,
        sessionDate,
      );
      const expected = bindingOf(
        specification,
        side,
        existingRunId,
        accountId,
        shared.sessionStartAt,
      );
      if (
        !binding ||
        binding.specId !== input.specificationId ||
        binding.side !== side ||
        binding.sessionDate !== sessionDate ||
        binding.runId !== expected.runId ||
        binding.accountId !== expected.accountId ||
        binding.marketId !== expected.marketId ||
        binding.currency !== expected.currency ||
        binding.policyDigest !== expected.policyDigest ||
        binding.executionModelVersion !== expected.executionModelVersion ||
        binding.accountAssumptionDigest !== expected.accountAssumptionDigest
      )
        throw new FundedComparisonSpecificationError(
          "REPLAY_LINEAGE_UNAVAILABLE",
          `${side} binding changed while resuming session ${sessionDate}`,
        );
      return existingRunId;
    }
    await deps.repository.saveProvisioningIntent(
      provisioningIntentOf(
        input.specificationId,
        specification,
        side,
        accountId,
        sessionDate,
      ),
    );
    const provisioned: ProvisionedHistoricalFundedRun = await (
      deps.provisionRun ?? provisionHistoricalFundedRun
    )(deps.pool, {
      marketId: specification.marketId,
      sessionDate,
      sessionTimezone: shared.sessionTimezone,
      scheduledCloseAt: shared.scheduledCloseAt,
      sessionStartAt: shared.sessionStartAt,
      assumptions: championSource.assumptions,
      policy: championSource.policy,
      accountId,
      currency: specification.currency,
      initialCash: specification.capital.initialCash,
      dailyLossLimit: specification.capital.dailyLossLimit,
      executionModelVersion: specification.champion.executionModelVersion,
    });
    return provisioned.runId;
  }
}

function provisioningIntentOf(
  specId: string,
  specification: FundedComparisonSpecification,
  side: FundedComparisonSide,
  accountId: string,
  sessionDate: string,
) {
  return {
    specId,
    side,
    sessionDate,
    accountId,
    marketId: specification.marketId,
    currency: specification.currency,
    policyDigest:
      side === "CHAMPION"
        ? specification.champion.policyDigest
        : specification.challenger.policyDigest,
    executionModelVersion: specification.champion.executionModelVersion,
    accountAssumptionDigest: specification.champion.accountAssumptionDigest,
  };
}

function bindingOf(
  specification: FundedComparisonSpecification,
  side: FundedComparisonSide,
  runId: string,
  accountId: string,
  boundAt: string,
) {
  return {
    runId,
    accountId,
    marketId: specification.marketId,
    currency: specification.currency,
    policyDigest:
      side === "CHAMPION"
        ? specification.champion.policyDigest
        : specification.challenger.policyDigest,
    executionModelVersion: specification.champion.executionModelVersion,
    accountAssumptionDigest: specification.champion.accountAssumptionDigest,
    boundAt,
  };
}

function assertResolved(
  side: FundedComparisonSide,
  sessionDate: string,
  result: ComparisonSideSessionResult,
): void {
  if (result.unresolvedPositions > 0)
    throw new FundedComparisonSpecificationError(
      "UNRESOLVED_POSITION",
      `${side} session ${sessionDate} left open positions`,
    );
  if (result.unresolvedReservations > 0)
    throw new FundedComparisonSpecificationError(
      "UNRESOLVED_RESERVATION",
      `${side} session ${sessionDate} left reservations`,
    );
}
