import type {
  SignalModelResearchAuthorization,
  SignalModelResearchAuthorizationRecord,
  SignalModelResearchPlan,
  SignalModelResearchPreflight,
  SignalModelResearchDispatch,
  MarketId,
} from "@tsx-scanner/contracts";
import type { SignalModelResearchApi } from "../api-types.js";
import { PostgresSignalModelResearchControlStore } from "./signal-model-research-control.js";

export class SignalModelResearchApiService implements SignalModelResearchApi {
  constructor(
    private readonly store: PostgresSignalModelResearchControlStore,
  ) {}

  preflight(
    plan: SignalModelResearchPlan,
  ): Promise<SignalModelResearchPreflight> {
    return this.store.preflight(plan);
  }

  authorize(
    authorization: SignalModelResearchAuthorization,
    plan: SignalModelResearchPlan,
    idempotencyKey: string,
  ): Promise<SignalModelResearchAuthorizationRecord> {
    return this.store.createAuthorization({
      authorization,
      plan,
      idempotencyKey,
    });
  }

  list(
    marketId: MarketId,
    limit?: number,
  ): Promise<SignalModelResearchAuthorizationRecord[]> {
    return this.store.listAuthorizations(marketId, limit);
  }

  get(id: string): Promise<SignalModelResearchAuthorizationRecord | null> {
    return this.store.getAuthorization(id);
  }

  readiness(id: string) {
    return this.store.getReadiness(id);
  }

  report(id: string) {
    return this.store.getReport(id);
  }

  revoke(
    id: string,
    idempotencyKey: string,
  ): Promise<SignalModelResearchAuthorizationRecord | null> {
    return this.store.revoke(id, idempotencyKey);
  }

  dispatch(
    id: string,
    idempotencyKey: string,
  ): Promise<SignalModelResearchDispatch> {
    return this.store.dispatch(id, idempotencyKey);
  }
}
