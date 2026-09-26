import {
  fundedShadowAvailabilityReceiptSchema,
  type FundedShadowAvailabilityReceipt,
  type FundedShadowReport,
  type MarketId,
} from "@tsx-scanner/contracts";
import type { FundedShadowStore } from "../statistical-models/funded-shadow-repository.js";
import { FundedShadowReportingService } from "../statistical-models/funded-shadow-reporting.js";

/**
 * Market-scoped read-only projection over immutable FP04 rows. It never
 * aggregates markets, never exposes `ALL`, never fabricates a metric and never
 * mutates or activates anything.
 */

export class FundedShadowReadError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = "FundedShadowReadError";
  }
}

export interface FundedShadowEnrollmentRead {
  readonly availability: FundedShadowAvailabilityReceipt;
  readonly report: FundedShadowReport | null;
}

export class FundedShadowReadService {
  constructor(
    private readonly store: FundedShadowStore,
    private readonly reporting: FundedShadowReportingService,
  ) {}

  async list(marketId: MarketId): Promise<FundedShadowAvailabilityReceipt[]> {
    if ((marketId as string) === "ALL")
      throw new FundedShadowReadError(
        "FUNDED_SHADOW_MARKET_REQUIRED",
        "Funded shadow observation is market-scoped; ALL is read-only and empty",
      );
    const ids = await this.store.listEnrollmentIds(marketId);
    const receipts: FundedShadowAvailabilityReceipt[] = [];
    for (const id of ids) {
      const availability = await this.store.availability(id);
      if (!availability) continue;
      if (availability.marketId !== marketId)
        throw new FundedShadowReadError(
          "FUNDED_SHADOW_OWNERSHIP_REFUSAL",
          "An enrollment read crossed a market boundary",
        );
      receipts.push(fundedShadowAvailabilityReceiptSchema.parse(availability));
    }
    return receipts;
  }

  async get(enrollmentId: string): Promise<FundedShadowEnrollmentRead> {
    const availability = await this.store.availability(enrollmentId);
    if (!availability)
      throw new FundedShadowReadError(
        "FUNDED_SHADOW_ENROLLMENT_NOT_FOUND",
        "No funded shadow enrollment exists for that identity",
      );
    const report = await this.reporting.preview(enrollmentId);
    return {
      availability: fundedShadowAvailabilityReceiptSchema.parse(availability),
      report: report ?? null,
    };
  }

  async report(
    enrollmentId: string,
    asOf?: string,
  ): Promise<FundedShadowReport> {
    const report = await this.reporting.preview(enrollmentId, asOf);
    if (!report)
      throw new FundedShadowReadError(
        "FUNDED_SHADOW_ENROLLMENT_NOT_FOUND",
        "No funded shadow enrollment exists for that identity",
      );
    return report;
  }
}
