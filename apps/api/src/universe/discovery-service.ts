import type {
  DiscoveryEvidence,
  DiscoveryModeState,
  DiscoveryParityAudit,
  DiscoveryParityStatus,
  DiscoveryRun,
  DiscoveryStatus,
  FastFunnelStatus,
  MarketId,
} from "@tsx-scanner/contracts";
import type { DiscoveryApi } from "../api-types.js";
import type {
  DiscoveryControlStore,
  DiscoveryModeChange,
} from "./discovery-control-repository.js";
import { DiscoveryScheduler } from "./discovery-scheduler.js";
import type { PostgresDiscoveryEvidenceStore } from "./discovery-evidence-repository.js";
import type { PostgresDiscoveryIntakeRepository } from "./discovery-intake-repository.js";
import type { TradingViewShadowComparator } from "./tradingview-shadow-comparator.js";
import type { FastFunnelAccelerator } from "./fast-funnel-accelerator.js";
import type { DiscoveryParityStore } from "./postgres-discovery-parity-store.js";

/** HTTP-facing discovery facade. Routes cannot reach provider or persistence internals directly. */
export class DiscoveryService implements DiscoveryApi {
  constructor(
    private readonly scheduler: DiscoveryScheduler,
    private readonly controlStore: DiscoveryControlStore,
    private readonly evidenceStore: PostgresDiscoveryEvidenceStore,
    private readonly marketId: MarketId,
    private readonly intakeRepository?: PostgresDiscoveryIntakeRepository,
    private readonly comparator?: TradingViewShadowComparator,
    private readonly fastFunnel?: FastFunnelAccelerator,
    private readonly parityStore?: DiscoveryParityStore,
  ) {}

  status(marketId: MarketId): Promise<DiscoveryStatus> {
    this.assertMarket(marketId);
    return this.scheduler.getStatus();
  }

  listRuns(
    marketId: MarketId,
    options: { limit?: number; before?: string } = {},
  ): Promise<DiscoveryRun[]> {
    this.assertMarket(marketId);
    return this.evidenceStore.listRuns(marketId, options);
  }

  listEvaluations(
    marketId: MarketId,
    runId: string,
    options: {
      limit?: number;
      after?: { exchange: string; code: string };
      includeInput?: boolean;
    } = {},
  ): Promise<DiscoveryEvidence[]> {
    this.assertMarket(marketId);
    return this.evidenceStore.listEvaluations(marketId, runId, options);
  }

  preview(
    marketId: MarketId,
    completedBarEnd?: string,
  ): Promise<DiscoveryRun | null> {
    this.assertMarket(marketId);
    return this.scheduler.preview(completedBarEnd);
  }

  changeMode(input: DiscoveryModeChange): Promise<DiscoveryModeState> {
    this.assertMarket(input.marketId);
    return this.controlStore.changeMode(input);
  }

  async changeExclusion(input: {
    marketId: MarketId;
    tradingDate: string;
    instrumentId: string;
    excluded: boolean;
    reason: string;
    actor: string;
  }): Promise<void> {
    this.assertMarket(input.marketId);
    if (!this.intakeRepository)
      throw new Error("Discovery intake is unavailable");
    await this.intakeRepository.setExclusion(input);
  }

  async parityStatus(marketId: MarketId): Promise<DiscoveryParityStatus> {
    this.assertMarket(marketId);
    if (!this.comparator) {
      throw new Error(
        "TradingView secondary shadow comparator is not configured",
      );
    }
    return this.comparator.getStatus();
  }

  async listParityAudits(
    marketId: MarketId,
    limit = 50,
  ): Promise<DiscoveryParityAudit[]> {
    this.assertMarket(marketId);
    if (!this.parityStore) {
      throw new Error("Discovery parity audit store is not configured");
    }
    return this.parityStore.listAudits(marketId, limit);
  }

  async compareParity(
    marketId: MarketId,
    runId?: string,
  ): Promise<DiscoveryParityAudit> {
    this.assertMarket(marketId);
    if (!this.comparator) {
      throw new Error(
        "TradingView secondary shadow comparator is not configured",
      );
    }
    return this.comparator.auditParity(runId);
  }

  async fastFunnelStatus(marketId: MarketId): Promise<FastFunnelStatus> {
    this.assertMarket(marketId);
    if (!this.fastFunnel) {
      throw new Error("Fast Funnel accelerator is not configured");
    }
    return this.fastFunnel.getStatus();
  }

  async stop(): Promise<void> {
    await this.scheduler.stop();
  }

  private assertMarket(marketId: MarketId): void {
    if (marketId !== this.marketId)
      throw new Error("Discovery service is bound to another market");
  }
}
