import { randomUUID } from "node:crypto";
import {
  discoveryParityAuditSchema,
  discoveryParityStatusSchema,
  type DiscoveryDiscrepancyCategory,
  type DiscoveryEvidence,
  type DiscoveryParityAudit,
  type DiscoveryParityMetricDiff,
  type DiscoveryParityStatus,
  type DiscoveryReason,
  type DiscoveryRun,
  type MarketId,
  type TradingViewCandidate,
} from "@tsx-scanner/contracts";
import type { PostgresDiscoveryEvidenceStore } from "./discovery-evidence-repository.js";
import type { DiscoveryParityStore } from "./postgres-discovery-parity-store.js";
import type { TradingViewScannerClient } from "./tradingview-scanner-client.js";

export interface ShadowComparatorOptions {
  marketId: MarketId;
  tvClient: TradingViewScannerClient;
  evidenceStore: PostgresDiscoveryEvidenceStore;
  parityStore: DiscoveryParityStore;
  clock?: () => Date;
  logger?: {
    info(fields: Record<string, unknown>): void;
    warn(fields: Record<string, unknown>): void;
    error(fields: Record<string, unknown>): void;
  };
}

function categorizeDiscrepancy(
  reasons: readonly DiscoveryReason[],
): DiscoveryDiscrepancyCategory {
  if (
    reasons.includes("INSUFFICIENT_SLOT_HISTORY") ||
    reasons.includes("RELATIVE_VOLUME_THRESHOLD")
  ) {
    return "FORMULA_DIFFERENCE";
  }
  if (reasons.includes("ATR_THRESHOLD")) {
    return "FORMULA_DIFFERENCE";
  }
  if (
    reasons.includes("CLASSIFICATION_REVIEW_REQUIRED") ||
    reasons.includes("EXCHANGE_NOT_ALLOWED") ||
    reasons.includes("CURRENCY_NOT_ALLOWED")
  ) {
    return "CLASSIFICATION_MISMATCH";
  }
  if (
    reasons.includes("QUOTE_STALE") ||
    reasons.includes("OUTSIDE_REGULAR_SESSION") ||
    reasons.includes("FUTURE_OBSERVATION")
  ) {
    return "TIMESTAMP_LAG";
  }
  if (
    reasons.includes("PRICE_OUT_OF_RANGE") ||
    reasons.includes("CHANGE_FROM_OPEN_THRESHOLD") ||
    reasons.includes("MARKET_CAP_THRESHOLD") ||
    reasons.includes("AVERAGE_VOLUME_THRESHOLD") ||
    reasons.includes("DOLLAR_VOLUME_THRESHOLD")
  ) {
    return "THRESHOLD_BOUNDARY";
  }
  if (
    reasons.includes("QUOTE_DELAYED") ||
    reasons.includes("QUOTE_HALTED") ||
    reasons.includes("QUOTE_UNAVAILABLE") ||
    reasons.includes("CATALOG_UNAVAILABLE") ||
    reasons.includes("BUDGET_DEFERRED") ||
    reasons.includes("EVALUATION_EXPIRED")
  ) {
    return "VOLUME_COVERAGE";
  }
  if (reasons.includes("ADJUSTMENT_UNVERIFIED")) {
    return "CORPORATE_ACTION";
  }
  return "OTHER";
}

function computeMetricDiff(
  symbol: string,
  field: string,
  qtVal: number | null,
  tvVal: number | null,
): DiscoveryParityMetricDiff {
  const difference =
    qtVal !== null && tvVal !== null
      ? Number((qtVal - tvVal).toFixed(4))
      : null;
  const pctDifference =
    difference !== null && tvVal !== null && tvVal !== 0
      ? Number(((difference / Math.abs(tvVal)) * 100).toFixed(2))
      : null;

  return {
    symbol,
    field,
    questradeValue: qtVal,
    tradingViewValue: tvVal,
    difference,
    pctDifference,
  };
}

export class TradingViewShadowComparator {
  private readonly marketId: MarketId;
  private readonly tvClient: TradingViewScannerClient;
  private readonly evidenceStore: PostgresDiscoveryEvidenceStore;
  private readonly parityStore: DiscoveryParityStore;
  private readonly clock: () => Date;
  private readonly logger?: ShadowComparatorOptions["logger"];

  constructor(options: ShadowComparatorOptions) {
    this.marketId = options.marketId;
    this.tvClient = options.tvClient;
    this.evidenceStore = options.evidenceStore;
    this.parityStore = options.parityStore;
    this.clock = options.clock ?? (() => new Date());
    this.logger = options.logger;
  }

  async auditParity(
    runId?: string,
    options: {
      tvCandidates?: TradingViewCandidate[];
    } = {},
  ): Promise<DiscoveryParityAudit> {
    let run: DiscoveryRun | null = null;
    if (runId) {
      if (
        "getRun" in this.evidenceStore &&
        typeof (this.evidenceStore as { getRun?: unknown }).getRun ===
          "function"
      ) {
        run = await (
          this.evidenceStore as {
            getRun(m: MarketId, id: string): Promise<DiscoveryRun | null>;
          }
        ).getRun(this.marketId, runId);
      } else {
        const runs = await this.evidenceStore.listRuns(this.marketId, {
          limit: 50,
        });
        run = runs.find((r) => r.id === runId) ?? null;
      }
    } else {
      const runs = await this.evidenceStore.listRuns(this.marketId, {
        limit: 10,
      });
      run = runs.find((r) => r.status === "COMPLETED") ?? runs[0] ?? null;
    }

    if (!run) {
      throw new Error(
        `No discovery run found to audit for market ${this.marketId}${runId ? ` (runId: ${runId})` : ""}`,
      );
    }

    const evaluations: DiscoveryEvidence[] = [];
    let after: { exchange: string; code: string } | undefined;
    while (true) {
      const page = await this.evidenceStore.listEvaluations(
        this.marketId,
        run.id,
        { limit: 200, after },
      );
      if (!page || page.length === 0) break;
      evaluations.push(...page);
      if (page.length < 200) break;
      const last = page[page.length - 1]!;
      after = {
        exchange: last.result.providerExchange,
        code: last.result.providerCode,
      };
    }

    const tvCandidates =
      options.tvCandidates ?? (await this.tvClient.scan(this.marketId));

    const qtPassEvaluations = evaluations.filter(
      (e) => e.result.state === "PASS",
    );

    const tvMap = new Map<string, TradingViewCandidate>();
    for (const c of tvCandidates) {
      tvMap.set(c.symbol.toUpperCase(), c);
    }

    const qtPassMap = new Map<string, DiscoveryEvidence>();
    for (const e of qtPassEvaluations) {
      qtPassMap.set(e.result.providerCode.toUpperCase(), e);
    }

    const qtAllMap = new Map<string, DiscoveryEvidence>();
    for (const e of evaluations) {
      qtAllMap.set(e.result.providerCode.toUpperCase(), e);
    }

    const overlapSymbols: string[] = [];
    const metricDifferences: DiscoveryParityMetricDiff[] = [];

    for (const [sym, qtEv] of qtPassMap.entries()) {
      if (tvMap.has(sym)) {
        overlapSymbols.push(sym);
        const tvCand = tvMap.get(sym)!;

        // Compare price
        metricDifferences.push(
          computeMetricDiff(
            sym,
            "price",
            qtEv.result.metrics.price.value,
            tvCand.price,
          ),
        );
        // Compare changeFromOpenPct
        metricDifferences.push(
          computeMetricDiff(
            sym,
            "changeFromOpenPct",
            qtEv.result.metrics.changeFromOpenPct.value,
            tvCand.changeFromOpenPct,
          ),
        );
        // Compare relativeVolume
        metricDifferences.push(
          computeMetricDiff(
            sym,
            "relativeVolume",
            qtEv.result.metrics.relativeVolume.value,
            tvCand.relativeVolume,
          ),
        );
        // Compare averageVolume90d
        metricDifferences.push(
          computeMetricDiff(
            sym,
            "averageVolume90d",
            qtEv.result.metrics.averageVolume90d.value,
            tvCand.averageVolume90d,
          ),
        );
        // Compare marketCap
        metricDifferences.push(
          computeMetricDiff(
            sym,
            "marketCap",
            qtEv.result.metrics.marketCap.value,
            tvCand.marketCap,
          ),
        );
      }
    }

    const missedMovers: DiscoveryParityAudit["missedMovers"] = [];
    const discrepancySummary: Record<DiscoveryDiscrepancyCategory, number> = {
      FORMULA_DIFFERENCE: 0,
      FORMING_VS_COMPLETED_BAR: 0,
      VOLUME_COVERAGE: 0,
      TIMESTAMP_LAG: 0,
      CORPORATE_ACTION: 0,
      CLASSIFICATION_MISMATCH: 0,
      THRESHOLD_BOUNDARY: 0,
      OTHER: 0,
    };

    for (const [sym, tvCand] of tvMap.entries()) {
      if (!qtPassMap.has(sym)) {
        const qtEv = qtAllMap.get(sym);
        const questradeState = qtEv?.result.state ?? null;
        let questradeReasons = qtEv?.result.reasons ?? [];
        let category: DiscoveryDiscrepancyCategory;

        if (qtEv) {
          category = categorizeDiscrepancy(questradeReasons);
        } else {
          category = "VOLUME_COVERAGE";
          questradeReasons = ["CATALOG_UNAVAILABLE"];
        }

        discrepancySummary[category] = (discrepancySummary[category] ?? 0) + 1;

        missedMovers.push({
          symbol: tvCand.symbol,
          exchange: tvCand.exchange,
          tradingViewMetrics: {
            price: tvCand.price,
            changeFromOpenPct: tvCand.changeFromOpenPct,
            relativeVolume: tvCand.relativeVolume,
            averageVolume90d: tvCand.averageVolume90d,
            marketCap: tvCand.marketCap,
          },
          questradeState,
          questradeReasons,
          discrepancyCategory: category,
        });
      }
    }

    const questradeOnly: DiscoveryParityAudit["questradeOnly"] = [];
    for (const [sym, qtEv] of qtPassMap.entries()) {
      if (!tvMap.has(sym)) {
        questradeOnly.push({
          symbol: qtEv.result.providerCode,
          exchange: qtEv.result.providerExchange,
          questradeMetrics: {
            price: qtEv.result.metrics.price.value,
            changeFromOpenPct: qtEv.result.metrics.changeFromOpenPct.value,
            relativeVolume: qtEv.result.metrics.relativeVolume.value,
            averageVolume90d: qtEv.result.metrics.averageVolume90d.value,
            marketCap: qtEv.result.metrics.marketCap.value,
          },
        });
      }
    }

    const totalUniqueCandidates = new Set([
      ...qtPassMap.keys(),
      ...tvMap.keys(),
    ]).size;

    const overlapRatio =
      totalUniqueCandidates > 0
        ? Math.min(
            1,
            Math.max(
              0,
              Number(
                (overlapSymbols.length / totalUniqueCandidates).toFixed(4),
              ),
            ),
          )
        : 0.0;

    const audit: DiscoveryParityAudit = discoveryParityAuditSchema.parse({
      id: randomUUID(),
      marketId: this.marketId,
      tradingDate: run.tradingDate,
      runId: run.id,
      auditedAt: this.clock().toISOString(),
      tradingViewCount: tvCandidates.length,
      questradePassCount: qtPassEvaluations.length,
      overlapCount: overlapSymbols.length,
      overlapRatio,
      overlapSymbols,
      missedMovers,
      questradeOnly,
      metricDifferences,
      discrepancySummary,
    });

    await this.parityStore.save(audit);

    this.logger?.info({
      event: "DISCOVERY_PARITY_AUDIT_RECORDED",
      marketId: this.marketId,
      auditId: audit.id,
      runId: run.id,
      tradingViewCount: audit.tradingViewCount,
      questradePassCount: audit.questradePassCount,
      overlapCount: audit.overlapCount,
      overlapRatio: audit.overlapRatio,
      missedMoverCount: audit.missedMovers.length,
      questradeOnlyCount: audit.questradeOnly.length,
    });

    return audit;
  }

  async getStatus(): Promise<DiscoveryParityStatus> {
    const latest = await this.parityStore.loadLatest(this.marketId);
    const recent = await this.parityStore.listAudits(this.marketId, 20);
    const auditCount = await this.parityStore.countAudits(this.marketId);

    const averageOverlapRatio =
      recent.length > 0
        ? Number(
            (
              recent.reduce((acc, curr) => acc + curr.overlapRatio, 0) /
              recent.length
            ).toFixed(4),
          )
        : null;

    return discoveryParityStatusSchema.parse({
      marketId: this.marketId,
      latestAudit: latest,
      auditCount,
      averageOverlapRatio,
      lastAuditedAt: latest?.auditedAt ?? null,
    });
  }
}
