import type { StudyAdmission } from "./study-admission.js";
import {
  frozenStudyPlanSchema,
  requiredStudyExecutions,
  type MarketId,
  type ResearchCoverageReport,
  type StudyAuthorizationRecord,
} from "@tsx-scanner/contracts";
import type { ResearchEvidenceStore } from "./research-evidence-repository.js";
import {
  assertAuthorizationPlan,
  type StudyAuthorizationRepository,
  type StudyAuthorizationDispatch,
} from "./study-authorization-repository.js";

export class StudyDispatchService {
  constructor(
    private readonly authorizations: StudyAuthorizationRepository,
    private readonly evidence: ResearchEvidenceStore,
    private readonly now: () => Date = () => new Date(),
    private readonly admission?: StudyAdmission,
  ) {}

  async dispatchReady(marketId: MarketId, limit = 10): Promise<number> {
    const ready = await this.authorizations.list(marketId, limit);
    let dispatched = 0;
    for (const authorization of ready) {
      if (authorization.mode !== "EXECUTE_WHEN_READY") continue;
      if (authorization.revokedAt || authorization.dispatchedJobId) continue;
      if (Date.parse(authorization.expiresAt) <= this.now().getTime()) continue;
      const result = await this.tryDispatch(authorization);
      if (result.state === "DISPATCHED") dispatched++;
    }
    return dispatched;
  }

  async tryDispatch(
    authorization: StudyAuthorizationRecord,
  ): Promise<StudyAuthorizationDispatch> {
    const record = await this.authorizations.get(authorization.id);
    if (!record) throw new Error("STUDY_AUTHORIZATION_NOT_FOUND");
    const plan = await this.authorizations.getPlan(record.id);
    if (!plan) throw new Error("STUDY_AUTHORIZATION_PLAN_NOT_FOUND");
    if (!plan.sessionPlan) throw new Error("STUDY_SESSION_PLAN_REQUIRED");
    assertAuthorizationPlan(authorization, plan);
    const report = await this.evidence.getReport(
      plan.binding.coverageReportHash,
    );
    if (!isVerifiedPrerequisite(report, plan)) return { state: "WAITING" };
    if (this.admission) {
      try {
        await this.admission(plan);
      } catch (error) {
        if (
          error instanceof Error &&
          ["RESEARCH_RUNTIME_UNAVAILABLE", "COVERAGE_NOT_VERIFIED"].includes(
            error.message,
          )
        )
          return { state: "WAITING" };
        throw error;
      }
    }
    const sessionCount = requiredStudyExecutions(plan);
    if (sessionCount > record.maxSessionExecutions)
      throw new Error("STUDY_AUTHORIZATION_BUDGET_EXCEEDED");
    return this.authorizations.reserveAndEnqueue(
      record.id,
      `study-authorization:${record.id}`,
    );
  }
}

function isVerifiedPrerequisite(
  report: ResearchCoverageReport | null,
  plan: ReturnType<typeof frozenStudyPlanSchema.parse>,
): boolean {
  return Boolean(
    report &&
    report.status === "VERIFIED" &&
    report.marketId === plan.comparison.marketId &&
    report.inputHash === plan.binding.inputHash &&
    plan.binding.coverageReportHash,
  );
}
