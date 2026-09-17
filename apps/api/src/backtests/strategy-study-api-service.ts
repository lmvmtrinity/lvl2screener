import type { StudyAdmission } from "./study-admission.js";
import {
  executableFrozenStudyPlanSchema,
  type FrozenStudyPlan,
  type MarketId,
  type ResearchJob,
  type StudyAuthorizationRecord,
  type StudyExecutionAuthorization,
} from "@tsx-scanner/contracts";
import type { ResearchJobApi, StrategyStudyApi } from "../api-types.js";
import { PostgresStrategyStudyStore } from "./strategy-study-repository.js";
import type { StrategyStudyRecord } from "./strategy-study-repository.js";
import type { PostgresStudyAuthorizationRepository } from "./study-authorization-repository.js";

export class StrategyStudyApiService implements StrategyStudyApi {
  constructor(
    private readonly studies: PostgresStrategyStudyStore,
    private readonly authorizations: PostgresStudyAuthorizationRepository,
    private readonly jobs: ResearchJobApi,
    private readonly admission?: StudyAdmission,
  ) {}

  async create(
    plan: FrozenStudyPlan,
    idempotencyKey: string,
  ): Promise<ResearchJob> {
    const parsed = executableFrozenStudyPlanSchema.parse(plan);
    if (!this.admission) throw new Error("RESEARCH_RUNTIME_UNAVAILABLE");
    await this.admission(parsed);
    return this.authorizations.createDirect(parsed, idempotencyKey);
  }

  get(id: string): Promise<StrategyStudyRecord | null> {
    return this.studies.get(id);
  }

  list(marketId: MarketId, limit?: number): Promise<StrategyStudyRecord[]> {
    return this.studies.list(marketId, limit);
  }

  async createAuthorization(
    authorization: StudyExecutionAuthorization,
    plan: FrozenStudyPlan,
    idempotencyKey: string,
  ): Promise<StudyAuthorizationRecord> {
    return this.authorizations.create(authorization, plan, idempotencyKey);
  }

  listAuthorizations(
    marketId: MarketId,
    limit?: number,
  ): Promise<StudyAuthorizationRecord[]> {
    return this.authorizations.list(marketId, limit);
  }

  revokeAuthorization(
    id: string,
    idempotencyKey: string,
  ): Promise<StudyAuthorizationRecord | null> {
    return this.authorizations.revoke(id, idempotencyKey);
  }
}
