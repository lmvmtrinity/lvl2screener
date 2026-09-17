import type { MarketId, FrozenCoverageRecipe } from "@tsx-scanner/contracts";
import type { Pool } from "pg";
import type { ReplaySessionPolicy } from "../backtests/backtest-repository.js";
import type { ResearchRuntimeIdentityProvider } from "../backtests/research-runtime-identity.js";
import { PostgresCoverageRequestRepository } from "../backtests/coverage-request-repository.js";
import { PostgresResearchCoverageSource } from "../backtests/research-coverage-source.js";
import { PostgresResearchEvidenceStore } from "../backtests/research-evidence-repository.js";
import { contentHash } from "../backtests/research-coverage.js";
import { researchSessionDates } from "../backtests/research-lineage-service.js";
import { PostgresChallengerExperimentStore } from "./challenger-experiment-repository.js";
import {
  evidenceWorkKey,
  PostgresEvidenceAutomationRepository,
} from "./evidence-automation-repository.js";

/** Routine read-side preparation for explicitly enrolled experiments only.
 * Runs on evidence catch-up, never on the latency-sensitive observation path.
 * No provider calls, enrollment, inference or model activation happen here. */
export class ChallengerCoverageAutomation {
  constructor(
    private readonly pool: Pool,
    private readonly runtime: ResearchRuntimeIdentityProvider,
    private readonly policies: Readonly<Record<MarketId, ReplaySessionPolicy>>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async runOnce(marketId: MarketId, limit = 1): Promise<number> {
    const experiments = new PostgresChallengerExperimentStore(this.pool);
    const today = researchSessionDates(
      [this.now().toISOString()],
      marketId,
    )[0]!;
    let prepared = 0;
    for (const experiment of await experiments.list(marketId, 100)) {
      if (experiment.state === "REGISTERED" || experiment.state === "REVOKED")
        continue;
      const records = await experiments.getAcceptance(
        experiment.baselineIdentityHash,
        experiment.acceptancePlanHash,
        marketId,
      );
      if (!records) continue;
      for (const date of records.acceptancePlan.comparison.expectedSessions.filter(
        (value) => value < today,
      )) {
        const key = `challenger-coverage:${experiment.id}:${date}`;
        if (
          (
            await this.pool.query(
              "SELECT id FROM research_coverage_request WHERE idempotency_key=$1",
              [key],
            )
          ).rowCount
        )
          continue;
        const runtime = await this.runtime.current();
        const identity = {
          kind: "COVERAGE" as const,
          marketId,
          scopeHash: contentHash(experiment.scope),
          inputIdentityHash: contentHash({ experimentId: experiment.id, date }),
          processorVersion: "challenger-coverage-v1",
        };
        if (
          !runtime?.featureVersion ||
          runtime.featureVersion !== records.baseline.featureVersion
        ) {
          await new PostgresEvidenceAutomationRepository(this.pool).record(
            identity,
            {
              workKey: evidenceWorkKey(identity),
              identity,
              state: "WAITING",
              jobId: null,
              reasonCodes: ["CHALLENGER_COVERAGE_RUNTIME_UNAVAILABLE"],
              recordedAt: this.now().toISOString(),
            },
          );
          return prepared;
        }
        const policy = { ...this.policies[marketId], marketId };
        const cutoff = this.now().toISOString();
        const recipe: FrozenCoverageRecipe = {
          version: "research-coverage-recipe-v2",
          marketId,
          ...runtime,
          featureVersion: runtime.featureVersion,
          sessionDates: [date],
          inputCutoff: cutoff,
          streamRequirements: [
            {
              timeframe: "Daily",
              warmupDays: 45,
              requiredWarmupBars: 20,
              includeInSession: false,
            },
            {
              timeframe: "OneMinute",
              warmupDays: 20,
              requiredWarmupBars: 20,
              includeInSession: true,
            },
            {
              timeframe: "FiveMinutes",
              warmupDays: 1,
              requiredWarmupBars: 0,
              includeInSession: true,
            },
          ],
          maxQuoteGapMs: 30000,
          replayPolicy: policy,
          replayPolicyHash: contentHash(policy),
          membershipPolicyHash: contentHash({
            policy: "retained-universe-membership-v1",
            marketId,
          }),
          calendarPolicyHash: contentHash({
            policy: "retained-session-calendar-v1",
            timezone: policy.timezone,
          }),
        };
        const evidence = new PostgresResearchEvidenceStore(this.pool);
        const seed = {
          version: "challenger-coverage-preparation-v1",
          purpose: {
            kind: "CHALLENGER",
            experimentId: experiment.id,
            scope: experiment.scope,
          },
          plan: { expectedSessions: [date] },
        };
        await evidence.saveManifest({
          hash: contentHash(seed),
          marketId,
          manifest: seed,
        });
        const frozen = await new PostgresResearchCoverageSource(
          this.pool,
        ).readFrozenInputs({
          marketId,
          manifestHash: contentHash(seed),
          sessionDates: [date],
          inputCutoff: cutoff,
          recipe,
        });
        const transitions = await this.pool.query<{
          state: string;
          effective_at: Date;
        }>(
          "SELECT state,effective_at FROM challenger_experiment_transition WHERE experiment_id=$1 AND effective_at<=$2::timestamptz ORDER BY sequence",
          [experiment.id, cutoff],
        );
        const grid = frozen.expected.filter(
          (cell) => cell.sessionDate === date,
        );
        const first = grid.length
          ? Math.min(...grid.map((cell) => Date.parse(cell.windowStart)))
          : 0;
        const last = grid.length
          ? Math.max(...grid.map((cell) => Date.parse(cell.windowEnd)))
          : 0;
        const activeWindows = transitions.rows.flatMap((transition, index) => {
          const start = Math.max(
            first,
            Date.parse(experiment.startsAt),
            transition.effective_at.getTime(),
          );
          const end = Math.min(
            last,
            Date.parse(experiment.endsAt),
            transitions.rows[index + 1]?.effective_at.getTime() ??
              Date.parse(cutoff),
          );
          return transition.state === "ACTIVE" && start < end
            ? [
                {
                  start: new Date(start).toISOString(),
                  end: new Date(end).toISOString(),
                },
              ]
            : [];
        });
        const manifest = {
          ...seed,
          version: "challenger-prospective-coverage-v1",
          purpose: {
            ...seed.purpose,
            expectedInputs: frozen.expected,
            activeWindows: { [date]: activeWindows },
          },
        };
        await new PostgresCoverageRequestRepository(this.pool).create(
          {
            manifest: { hash: contentHash(manifest), marketId, manifest },
            recipe,
          },
          key,
        );
        prepared++;
        if (prepared >= limit) return prepared;
      }
    }
    return prepared;
  }
}
