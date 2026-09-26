import type {
  FundedComparisonAvailabilityReceipt,
  FundedComparisonFailureReceipt,
  FundedComparisonResult,
  FundedComparisonSpecification,
  MarketId,
} from "@tsx-scanner/contracts";

export interface FundedComparisonReadSpecification extends Pick<
  FundedComparisonSpecification,
  | "marketId"
  | "currency"
  | "comparisonSpecDigest"
  | "baseline"
  | "evidenceCutoffAt"
  | "specificationFrozenAt"
> {
  readonly sessionMembership: Pick<
    FundedComparisonSpecification["sessionMembership"],
    "orderedSessionDates"
  >;
}

export interface FundedComparisonReadSpecificationReceipt {
  readonly specification: FundedComparisonReadSpecification;
}

/**
 * Read-only FP03 projection. The repository remains the authority for the
 * immutable rows; this service only joins the availability receipt to a
 * proven complete result and never manufactures metric fields.
 */
export interface FundedComparisonReadRepository {
  listSpecifications(
    marketId: Exclude<MarketId, "ALL">,
    limit: number,
  ): Promise<readonly FundedComparisonAvailabilityReceipt[]>;
  loadAvailability(
    specId: string,
  ): Promise<FundedComparisonAvailabilityReceipt | undefined>;
  loadSpecification(
    specId: string,
  ): Promise<FundedComparisonReadSpecificationReceipt | undefined>;
  loadResult(specId: string): Promise<FundedComparisonResult | undefined>;
}

export interface FundedComparisonReadProjection extends FundedComparisonAvailabilityReceipt {
  readonly result: FundedComparisonResult | null;
}

export interface FundedComparisonListProjection extends FundedComparisonAvailabilityReceipt {
  readonly baseline: FundedComparisonSpecification["baseline"];
  readonly evidenceCutoffAt: string;
  readonly specificationFrozenAt: string;
}

export class FundedComparisonReadService {
  constructor(private readonly repository: FundedComparisonReadRepository) {}

  async list(
    marketId: MarketId | "ALL",
    limit = 50,
  ): Promise<readonly FundedComparisonListProjection[]> {
    if (marketId === "ALL")
      throw new Error(
        "FUNDED_COMPARISON_MARKET_REQUIRED: ALL is not supported",
      );
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new Error("FUNDED_COMPARISON_LIMIT_INVALID");
    const receipts = await this.repository.listSpecifications(marketId, limit);
    const projections: FundedComparisonListProjection[] = [];
    for (const receipt of receipts) {
      if (receipt.marketId !== marketId)
        throw new Error(
          "MARKET_CURRENCY_MISMATCH: comparison list crossed markets",
        );
      const retained = await this.repository.loadSpecification(
        receipt.specificationId,
      );
      if (!retained)
        throw new Error(
          `RETAINED_INPUT_MISSING: specification ${receipt.specificationId} is unavailable`,
        );
      const specification = retained.specification;
      if (
        specification.marketId !== receipt.marketId ||
        specification.currency !== receipt.currency ||
        specification.comparisonSpecDigest !== receipt.comparisonSpecDigest
      )
        throw new Error(
          `MARKET_CURRENCY_MISMATCH: specification ${receipt.specificationId} identity does not match availability`,
        );
      projections.push({
        ...receipt,
        baseline: specification.baseline,
        evidenceCutoffAt: specification.evidenceCutoffAt,
        specificationFrozenAt: specification.specificationFrozenAt,
      });
    }
    return projections;
  }

  async get(
    specId: string,
  ): Promise<FundedComparisonReadProjection | undefined> {
    const availability = await this.repository.loadAvailability(specId);
    if (!availability) return undefined;
    if (availability.status !== "READY")
      return { ...availability, result: null };
    if (!availability.resultAvailable)
      return this.unavailable(
        availability,
        "INCOMPLETE_SESSION",
        "The comparison is marked READY without an available result artifact",
      );

    const result = await this.repository.loadResult(specId);
    if (!result)
      return this.unavailable(
        availability,
        "INCOMPLETE_SESSION",
        "The comparison is marked available but has no retained result artifact",
      );

    const specification = await this.repository.loadSpecification(specId);
    if (!specification)
      return this.unavailable(
        availability,
        "INCOMPLETE_SESSION",
        "The result has no retained specification membership to prove its sessions",
      );
    const missing = missingSessionDates(specification.specification, result);
    if (missing.length > 0)
      return this.unavailable(
        availability,
        "INCOMPLETE_SESSION",
        `The retained result is missing session(s): ${missing.join(",")}`,
      );

    if (
      result.marketId !== availability.marketId ||
      result.currency !== availability.currency ||
      result.comparisonSpecDigest !== availability.comparisonSpecDigest ||
      result.resultDigest !== availability.resultDigest
    )
      return this.unavailable(
        availability,
        "INTERNAL_ERROR",
        "The retained result identity does not match its availability receipt",
      );

    return { ...availability, result };
  }

  private unavailable(
    availability: FundedComparisonAvailabilityReceipt,
    reason: FundedComparisonFailureReceipt["reason"],
    detail: string,
  ): FundedComparisonReadProjection {
    return {
      ...availability,
      status: "UNAVAILABLE",
      resultAvailable: false,
      resultDigest: null,
      result: null,
      failures: [
        ...availability.failures,
        {
          reason,
          classification: "TERMINAL",
          side: null,
          sessionDate: null,
          detail,
          recordedAt: availability.createdAt,
        },
      ],
    };
  }
}

function missingSessionDates(
  specification: FundedComparisonReadSpecification,
  result: FundedComparisonResult,
): readonly string[] {
  const expected = specification.sessionMembership.orderedSessionDates;
  const vectors = [
    result.pairedSessions.map((session) => session.sessionDate),
    (result.champion?.return?.sessions ?? []).map(
      (session) => session.sessionDate,
    ),
    (result.challenger?.return?.sessions ?? []).map(
      (session) => session.sessionDate,
    ),
  ];
  if (
    vectors.some(
      (actual) =>
        actual.length !== expected.length ||
        actual.some((sessionDate, index) => sessionDate !== expected[index]),
    )
  ) {
    const actual = new Set(vectors[0]);
    const missing = expected.filter((sessionDate) => !actual.has(sessionDate));
    return missing.length > 0 ? missing : ["session-vector-mismatch"];
  }
  return [];
}
