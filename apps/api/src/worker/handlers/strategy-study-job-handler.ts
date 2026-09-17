import {
  executableStrategyStudyJobPayloadSchema,
  type MarketId,
} from "@tsx-scanner/contracts";
import type { Pool } from "pg";
import type { ScannerFeatureClient } from "../../market-data/scanner-client.js";
import type { ReplaySessionPolicy } from "../../backtests/backtest-repository.js";
import { PostgresBacktestStore } from "../../backtests/backtest-repository.js";
import { CapturedReplayRunner } from "../../backtests/captured-replay-runner.js";
import { PostgresResearchEvidenceStore } from "../../backtests/research-evidence-repository.js";
import { PostgresStrategyStudyStore } from "../../backtests/strategy-study-repository.js";
import { StrategyStudyService } from "../../backtests/strategy-study-service.js";
import { createStudyAdmission } from "../../backtests/study-admission.js";
import {
  PostgresStudySessionAuthority,
  assertStudyAuthority,
} from "../../backtests/study-session-authority.js";
import {
  assertAuthorizationPlan,
  PostgresStudyAuthorizationRepository,
} from "../../backtests/study-authorization-repository.js";
import {
  assertStudyIdentity,
  type ResearchRuntimeIdentityProvider,
} from "../../backtests/research-runtime-identity.js";
import { canonicalJson } from "../../backtests/research-coverage.js";
import {
  CategorizedError,
  CancelledError,
  type ClaimedResearchJob,
  type JobContext,
  type ResearchJobHandler,
} from "../research-worker.js";

export class StrategyStudyJobHandler implements ResearchJobHandler {
  constructor(
    private readonly pool: Pool,
    private readonly backtests: PostgresBacktestStore,
    private readonly scanner: ScannerFeatureClient,
    private readonly policies:
      ReplaySessionPolicy | Readonly<Record<MarketId, ReplaySessionPolicy>>,
    private readonly evidence: PostgresResearchEvidenceStore,
    private readonly runtimeIdentity?: ResearchRuntimeIdentityProvider | null,
  ) {}

  async execute(
    job: ClaimedResearchJob,
    context: JobContext,
  ): Promise<{ resultRefId: string }> {
    const parsed = executableStrategyStudyJobPayloadSchema.safeParse(
      job.requestPayload,
    );
    if (!parsed.success)
      throw new CategorizedError(
        "VALIDATION",
        `Strategy study payload failed validation: ${parsed.error.message}`,
      );
    const previous = await new PostgresStrategyStudyStore(this.pool).get(
      parsed.data.plan.experimentId,
    );
    if (
      previous?.report &&
      canonicalJson(previous.plan) === canonicalJson(parsed.data.plan)
    )
      return { resultRefId: previous.id };
    try {
      if (!this.runtimeIdentity)
        throw new Error("RESEARCH_RUNTIME_UNAVAILABLE");
      await createStudyAdmission(
        this.pool,
        this.runtimeIdentity,
      )(parsed.data.plan);
      if (parsed.data.authority?.kind === "EXECUTE_WHEN_READY") {
        const authorityId = parsed.data.authority.authorizationId;
        if (!authorityId || !this.runtimeIdentity)
          throw new Error("STUDY_RUNTIME_IDENTITY_UNAVAILABLE");
        const authorizations = new PostgresStudyAuthorizationRepository(
          this.pool,
        );
        const authorization = await authorizations.get(authorityId);
        const authorizedPlan = await authorizations.getPlan(authorityId);
        if (!authorization || !authorizedPlan)
          throw new Error("STUDY_AUTHORIZATION_NOT_FOUND");
        if (canonicalJson(authorizedPlan) !== canonicalJson(parsed.data.plan))
          throw new Error("STUDY_AUTHORIZATION_PLAN_MISMATCH");
        assertAuthorizationPlan(authorization, authorizedPlan);
        assertStudyIdentity({
          authorization,
          plan: authorizedPlan,
          runtime: (await this.runtimeIdentity.current())!,
        });
      }
    } catch (error) {
      throw new CategorizedError(
        "VALIDATION",
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    }
    const fence = {
      jobId: job.id,
      leaseOwner: job.leaseOwner,
      attemptCount: job.attemptCount,
    };
    const store = new PostgresStrategyStudyStore(
      this.pool,
      fence,
      parsed.data.authority,
    );
    const fencedBacktests = this.backtests.withFence(fence, (client) =>
      assertStudyAuthority(client, parsed.data.authority, fence).then(
        () => undefined,
      ),
    );
    const runner = new CapturedReplayRunner(
      fencedBacktests,
      this.scanner,
      this.policies,
      this.evidence,
      context,
      new PostgresStudySessionAuthority(
        this.pool,
        parsed.data.authority,
        parsed.data.plan,
      ),
      fence,
    );
    const service = new StrategyStudyService({
      store,
      runner,
      verify: async (plan) => {
        const report = await this.evidence.getReport(
          plan.binding.coverageReportHash,
        );
        return Boolean(
          report &&
          report.status === "VERIFIED" &&
          report.marketId === plan.comparison.marketId &&
          report.inputHash === plan.binding.inputHash,
        );
      },
      checkpoint: async () => {
        const heartbeat = await context.heartbeat();
        if (heartbeat.cancellationRequested)
          throw new CancelledError("Study cancelled before next stage");
      },
    });
    try {
      const report = await service.evaluate(parsed.data.plan);
      return { resultRefId: report.experimentId };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        error instanceof CancelledError ||
        ["STUDY_AUTHORITY_LOST", "STUDY_SESSION_ALREADY_ACCEPTED"].some(
          (code) => message.includes(code),
        )
      ) {
        await store
          .saveReport({
            experimentId: parsed.data.plan.experimentId,
            calculationVersion: "study-report-v2",
            binding: parsed.data.plan.binding,
            status: "INTERRUPTED",
            results: [],
            comparison: null,
            reasonCodes: [message],
          })
          .catch(() => undefined);
        throw new CategorizedError("CANCELLED", message, { cause: error });
      }
      if (
        message.includes("STUDY_INPUT_CHANGED") ||
        message.includes("STRATEGY_STUDY_SPEC_CONFLICT") ||
        message.includes("STUDY_SESSION_SCOPE_MISMATCH")
      )
        throw new CategorizedError("VALIDATION", message, { cause: error });
      throw error;
    }
  }
}
