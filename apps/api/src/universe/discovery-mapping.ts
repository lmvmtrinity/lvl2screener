import { createHash } from "node:crypto";
import { z } from "zod";
import { marketIdSchema, type MarketId } from "@tsx-scanner/contracts";
import type {
  Instrument,
  MarketDataAdapter,
  MarketDataRequestOptions,
} from "../questrade/types.js";
import { QuestradeQueueError } from "../questrade/rate-limiter.js";
import { normalizeExchange } from "../questrade/exchange.js";
import {
  parseEodhdCatalog,
  normalizeCatalogExchange,
  type CatalogMember,
} from "./eodhd-catalog.js";
import { parseMassiveCatalog } from "./massive-catalog.js";
import type { DiscoveryAttemptDiagnosticsCollector } from "./discovery-attempt-diagnostics.js";

const instrumentSchema = z.object({
  symbol: z.string().min(1),
  symbolId: z.number().int().positive(),
  description: z.string(),
  securityType: z.string(),
  exchange: z.string(),
  currency: z.string(),
  isQuotable: z.boolean(),
  isTradable: z.boolean(),
});

/** Reviewed classification rubric revision. A change invalidates cached resolutions. */
export const CLASSIFICATION_REVIEW_REVISION =
  "catalog-common-stock-evidence-v2" as const;

export const classificationEvidenceSchema = z
  .object({
    reviewRevision: z.string().min(1).max(100),
    basis: z.enum([
      "BROKER_COMMON_STOCK",
      "EODHD_COMMON_STOCK_ISIN",
      "MASSIVE_COMMON_STOCK",
    ]),
    brokerSecurityType: z.string().min(1).max(100),
    catalogType: z.string().min(1).max(100),
    isin: z.string().min(1).max(32).nullable(),
    catalogFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    observedAt: z.string().datetime(),
    // Retained Massive reference evidence; null for non-Massive bases.
    providerTicker: z.string().min(1).max(100).nullable().default(null),
    providerType: z.string().min(1).max(50).nullable().default(null),
    providerExchangeMic: z.string().min(1).max(20).nullable().default(null),
    providerCurrency: z.string().min(1).max(20).nullable().default(null),
    cik: z.string().max(32).nullable().default(null),
    compositeFigi: z.string().max(64).nullable().default(null),
    shareClassFigi: z.string().max(64).nullable().default(null),
    providerRetrievedAt: z.string().datetime().nullable().default(null),
    providerDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable()
      .default(null),
  })
  .strict();
export type ClassificationEvidence = z.infer<
  typeof classificationEvidenceSchema
>;

export const mappingDecisionSchema = z
  .object({
    marketId: marketIdSchema,
    providerCode: z.string().min(1),
    providerExchange: z.string().min(1),
    catalogFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.enum([
      "RESOLVED",
      "REVIEW_REQUIRED",
      "NOT_FOUND",
      "AMBIGUOUS",
      "UNSUPPORTED",
    ]),
    reason: z.enum([
      "VERIFIED_COMMON_STOCK",
      "CLASSIFICATION_REVIEW_REQUIRED",
      "EXCHANGE_NOT_ALLOWED",
      "CURRENCY_NOT_ALLOWED",
      "NOT_QUOTABLE",
      "NOT_TRADABLE",
      "NO_EXACT_MATCH",
      "MULTIPLE_MATCHES",
    ]),
    instrument: instrumentSchema.nullable(),
    // Records which reviewed rule/cache generation produced this decision.
    // Legacy rows parse as "legacy" and are re-observed on next use.
    reviewRevision: z.string().min(1).max(100).default("legacy"),
    classificationEvidence: classificationEvidenceSchema
      .nullable()
      .default(null),
    resolvedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (Date.parse(value.expiresAt) <= Date.parse(value.resolvedAt))
      ctx.addIssue({
        code: "custom",
        message: "Mapping expiry must follow observation",
      });
    if (value.status !== "RESOLVED") return;
    const instrument = value.instrument;
    const evidence = value.classificationEvidence;
    const exchange = normalizeCatalogExchange(value.providerExchange);
    const expectedSymbol =
      value.marketId === "CA_TSX"
        ? `${value.providerCode}.TO`
        : value.providerCode;
    const expectedIsinCountry = value.marketId === "CA_TSX" ? "CA" : "US";
    const instrumentTypeAllowed =
      instrument?.securityType === "Common Stock" ||
      (instrument?.securityType === "Stock" && evidence !== null);
    if (
      !instrument ||
      instrument.symbol !== expectedSymbol ||
      instrument.currency !== (value.marketId === "CA_TSX" ? "CAD" : "USD") ||
      normalizeExchange(instrument.exchange) !== exchange ||
      (value.marketId === "CA_TSX"
        ? exchange !== "TSX"
        : exchange !== "NYSE" && exchange !== "NASDAQ") ||
      !instrumentTypeAllowed ||
      !instrument.isQuotable ||
      !instrument.isTradable ||
      value.reason !== "VERIFIED_COMMON_STOCK"
    )
      ctx.addIssue({
        code: "custom",
        message: "Resolved mapping requires verified instrument ownership/type",
      });
    if (!evidence) return;
    if (
      evidence.catalogFingerprint !== value.catalogFingerprint ||
      evidence.brokerSecurityType !== instrument?.securityType
    )
      ctx.addIssue({
        code: "custom",
        message: "Classification evidence does not match the decision",
      });
    const evidenceSupportsResolution =
      evidence.basis === "BROKER_COMMON_STOCK"
        ? instrument?.securityType === "Common Stock"
        : evidence.basis === "EODHD_COMMON_STOCK_ISIN"
          ? instrument?.securityType === "Stock" &&
            evidence.catalogType === "Common Stock" &&
            evidence.isin !== null &&
            evidence.isin.slice(0, 2).toUpperCase() === expectedIsinCountry
          : instrument?.securityType === "Stock" &&
            evidence.catalogType === "Common Stock" &&
            evidence.providerType?.trim().toUpperCase() === "CS" &&
            evidence.providerTicker === value.providerCode &&
            evidence.providerExchangeMic === value.providerExchange &&
            evidence.providerCurrency !== null &&
            evidence.providerCurrency.toUpperCase() === instrument?.currency &&
            evidence.providerDigest !== null;
    if (!evidenceSupportsResolution)
      ctx.addIssue({
        code: "custom",
        message: "Classification evidence does not support resolution",
      });
  });
export type MappingDecision = z.infer<typeof mappingDecisionSchema>;

// Review is a metadata blocker, not a transient provider failure. Retain the
// rejection longer without treating it as verified. Catalog changes still
// invalidate every status immediately; persisted expiry is never extended on read.
const mappingCacheDays: Record<MappingDecision["status"], number> = {
  RESOLVED: 7,
  REVIEW_REQUIRED: 30,
  AMBIGUOUS: 1,
  NOT_FOUND: 1,
  UNSUPPORTED: 1,
};
export interface DiscoveryMappingStore {
  load(
    marketId: MarketId,
    exchange: string,
    code: string,
  ): Promise<MappingDecision | null>;
  save(decision: MappingDecision): Promise<void>;
}

export function catalogFingerprint(member: CatalogMember): string {
  const raw = member.raw;
  const massive = raw.Massive;
  return createHash("sha256")
    .update(
      JSON.stringify([
        raw.Code,
        raw.Name,
        raw.Exchange,
        raw.Currency,
        raw.Type,
        raw.Isin ?? null,
        // Provider identity is fingerprint-relevant; retrieval time and payload
        // digest are retained but intentionally excluded so unchanged daily
        // snapshots do not invalidate every cached resolution.
        massive
          ? [
              massive.providerTicker,
              massive.providerType,
              massive.exchangeMic,
              massive.currency,
              massive.cik,
              massive.compositeFigi,
              massive.shareClassFigi,
            ]
          : null,
      ]),
    )
    .digest("hex");
}

export interface DiscoverySymbolMapperOptions {
  /**
   * Maximum stale-review decisions re-observed per rolling hour. Excess
   * symbols reuse their cached non-resolved decision until a later cycle.
   */
  reobservationPerHour?: number;
}

/** Broker metadata plus exact identity is mandatory; no fuzzy/suffix-only match. */
export class DiscoverySymbolMapper {
  private readonly pending = new Map<string, Promise<MappingDecision>>();
  private readonly reobservationPerHour: number;
  private readonly reobservations: number[] = [];

  constructor(
    private readonly broker: Pick<MarketDataAdapter, "searchSymbols">,
    private readonly store: DiscoveryMappingStore,
    private readonly clock: () => Date = () => new Date(),
    options: DiscoverySymbolMapperOptions = {},
  ) {
    const limit = options.reobservationPerHour ?? 60;
    if (!Number.isInteger(limit) || limit < 0)
      throw new Error(
        "Mapping re-observation limit must be a non-negative integer",
      );
    this.reobservationPerHour = limit;
  }

  private canReobserve(nowMs: number): boolean {
    while (
      this.reobservations.length > 0 &&
      this.reobservations[0]! <= nowMs - 3_600_000
    )
      this.reobservations.shift();
    return this.reobservations.length < this.reobservationPerHour;
  }

  private recordReobservation(nowMs: number): void {
    this.reobservations.push(nowMs);
  }

  async resolve(
    marketId: MarketId,
    member: CatalogMember,
    options?: MarketDataRequestOptions,
    diagnostics?: DiscoveryAttemptDiagnosticsCollector,
  ): Promise<MappingDecision> {
    const stopTiming = diagnostics?.startStage("MAPPING");
    try {
      marketIdSchema.parse(marketId);
      this.assertRequestActive(options);
      const fingerprint = catalogFingerprint(member);
      const key = JSON.stringify([
        marketId,
        member.raw.Exchange,
        member.providerCode,
        fingerprint,
      ]);
      // A caller-scoped abort signal must never cancel a coalesced operation
      // that another caller is awaiting. Scheduled discovery catalogs are unique
      // by identity, so deadline-bound lookups run independently.
      const canCoalesce = !options?.signal && !options?.expiresAt;
      const pending = canCoalesce ? this.pending.get(key) : undefined;
      if (pending) return await pending;
      const operation = this.resolveOnce(
        marketId,
        member,
        fingerprint,
        options,
        diagnostics,
      );
      if (!canCoalesce) return await operation;
      this.pending.set(key, operation);
      try {
        return await operation;
      } finally {
        this.pending.delete(key);
      }
    } finally {
      stopTiming?.();
    }
  }

  private async resolveOnce(
    marketId: MarketId,
    member: CatalogMember,
    fingerprint: string,
    options?: MarketDataRequestOptions,
    diagnostics?: DiscoveryAttemptDiagnosticsCollector,
  ): Promise<MappingDecision> {
    // Revalidate against requested market; never trust mutable/precomputed reasons.
    const verified = member.raw.Massive
      ? parseMassiveCatalog([member.raw], marketId)[0]!
      : parseEodhdCatalog([member.raw], marketId)[0]!;
    if (member.providerCode !== member.raw.Code)
      throw new Error("Catalog identity conflict");
    const cached = await this.store.load(
      marketId,
      member.raw.Exchange,
      member.providerCode,
    );
    this.assertRequestActive(options);
    const now = this.clock();
    if (cached) {
      mappingDecisionSchema.parse(cached);
      if (
        cached.marketId !== marketId ||
        cached.providerCode !== member.providerCode ||
        cached.providerExchange !== member.raw.Exchange
      )
        throw new Error("Discovery mapping ownership conflict");
      // A decision is reusable only under the current review revision. Legacy
      // or stale-review rows are re-observed instead of trusted or failed hard.
      const fingerprintMatches = cached.catalogFingerprint === fingerprint;
      const unexpired =
        Date.parse(cached.resolvedAt) <= now.getTime() &&
        Date.parse(cached.expiresAt) > now.getTime();
      const reusableResolution =
        fingerprintMatches &&
        unexpired &&
        cached.reviewRevision === CLASSIFICATION_REVIEW_REVISION &&
        (cached.status !== "RESOLVED" ||
          (cached.classificationEvidence !== null &&
            cached.classificationEvidence.catalogFingerprint === fingerprint));
      if (reusableResolution) {
        diagnostics?.recordCache("MAPPING", "HIT");
        return cached;
      }
      const staleReview =
        cached.reviewRevision !== CLASSIFICATION_REVIEW_REVISION;
      if (
        staleReview &&
        cached.status !== "RESOLVED" &&
        fingerprintMatches &&
        unexpired &&
        !this.canReobserve(now.getTime())
      ) {
        // Provisional reuse: the old decision stays visible and unevaluable
        // rather than flooding the broker queue. Timestamps are not rewritten.
        diagnostics?.recordCache("MAPPING", "HIT");
        return cached;
      }
      if (staleReview) this.recordReobservation(now.getTime());
    }
    diagnostics?.recordCache("MAPPING", "MISS");
    let status: MappingDecision["status"] = "UNSUPPORTED";
    let reason: MappingDecision["reason"] =
      verified.reasons[0] ?? "NO_EXACT_MATCH";
    let instrument: Instrument | null = null;
    let classificationEvidence: ClassificationEvidence | null = null;
    const observedAt = this.clock();
    if (verified.reasons.length === 0) {
      const symbols = await this.broker.searchSymbols(
        member.providerCode,
        options,
      );
      this.assertRequestActive(options);
      const exactSymbol =
        marketId === "CA_TSX"
          ? `${member.providerCode}.TO`
          : member.providerCode;
      const exact = symbols.filter((item) => item.symbol === exactSymbol);
      const owned = exact.filter(
        (item) =>
          normalizeExchange(item.exchange) ===
            normalizeCatalogExchange(member.raw.Exchange) &&
          item.currency === member.raw.Currency,
      );
      if (owned.length > 1) {
        status = "AMBIGUOUS";
        reason = "MULTIPLE_MATCHES";
      } else if (owned.length === 0) {
        status = exact.length ? "UNSUPPORTED" : "NOT_FOUND";
        reason = exact.length
          ? exact.some((item) => item.currency === member.raw.Currency)
            ? "EXCHANGE_NOT_ALLOWED"
            : "CURRENCY_NOT_ALLOWED"
          : "NO_EXACT_MATCH";
      } else {
        instrument = instrumentSchema.parse(owned[0]);
        const isin = member.raw.Isin?.trim().toUpperCase() ?? null;
        const expectedIsinCountry = marketId === "CA_TSX" ? "CA" : "US";
        const reviewedIsin =
          isin && isin.slice(0, 2) === expectedIsinCountry ? isin : null;
        if (!instrument.isQuotable) reason = "NOT_QUOTABLE";
        else if (!instrument.isTradable) reason = "NOT_TRADABLE";
        else if (instrument.securityType === "Common Stock") {
          status = "RESOLVED";
          reason = "VERIFIED_COMMON_STOCK";
          classificationEvidence = classificationEvidenceSchema.parse({
            reviewRevision: CLASSIFICATION_REVIEW_REVISION,
            basis: "BROKER_COMMON_STOCK",
            brokerSecurityType: instrument.securityType,
            catalogType: member.raw.Type,
            isin: reviewedIsin,
            catalogFingerprint: fingerprint,
            observedAt: observedAt.toISOString(),
          });
        } else if (
          instrument.securityType === "Stock" &&
          member.raw.Massive !== undefined &&
          member.raw.Massive.providerType.trim().toUpperCase() === "CS" &&
          member.raw.Type === "Common Stock"
        ) {
          // Massive's reviewed CS classification is promoted only for an exact,
          // unique broker identity and compatible exchange/currency; the CIK and
          // FIGIs are retained evidence, never share-class disambiguators.
          status = "RESOLVED";
          reason = "VERIFIED_COMMON_STOCK";
          classificationEvidence = classificationEvidenceSchema.parse({
            reviewRevision: CLASSIFICATION_REVIEW_REVISION,
            basis: "MASSIVE_COMMON_STOCK",
            brokerSecurityType: instrument.securityType,
            catalogType: member.raw.Type,
            isin: null,
            catalogFingerprint: fingerprint,
            observedAt: observedAt.toISOString(),
            providerTicker: member.raw.Massive.providerTicker,
            providerType: member.raw.Massive.providerType,
            providerExchangeMic: member.raw.Massive.exchangeMic,
            providerCurrency: member.raw.Massive.currency,
            cik: member.raw.Massive.cik,
            compositeFigi: member.raw.Massive.compositeFigi,
            shareClassFigi: member.raw.Massive.shareClassFigi,
            providerRetrievedAt: member.raw.Massive.retrievedAt,
            providerDigest: member.raw.Massive.responseDigest,
          });
        } else if (
          instrument.securityType === "Stock" &&
          member.raw.Massive === undefined &&
          member.raw.Type === "Common Stock" &&
          reviewedIsin !== null
        ) {
          // Questrade's generic `Stock` is promoted only when the retained
          // catalog provides a reviewed common-stock type and a matching ISIN.
          status = "RESOLVED";
          reason = "VERIFIED_COMMON_STOCK";
          classificationEvidence = classificationEvidenceSchema.parse({
            reviewRevision: CLASSIFICATION_REVIEW_REVISION,
            basis: "EODHD_COMMON_STOCK_ISIN",
            brokerSecurityType: instrument.securityType,
            catalogType: member.raw.Type,
            isin: reviewedIsin,
            catalogFingerprint: fingerprint,
            observedAt: observedAt.toISOString(),
          });
        } else {
          status = "REVIEW_REQUIRED";
          reason = "CLASSIFICATION_REVIEW_REQUIRED";
        }
      }
    }
    const decision = mappingDecisionSchema.parse({
      marketId,
      providerCode: member.providerCode,
      providerExchange: member.raw.Exchange,
      catalogFingerprint: fingerprint,
      status,
      reason,
      instrument,
      reviewRevision: CLASSIFICATION_REVIEW_REVISION,
      classificationEvidence,
      resolvedAt: observedAt.toISOString(),
      expiresAt: new Date(
        observedAt.getTime() + mappingCacheDays[status] * 86_400_000,
      ).toISOString(),
    });
    this.assertRequestActive(options);
    await this.store.save(decision);
    return decision;
  }

  private assertRequestActive(options?: MarketDataRequestOptions): void {
    if (options?.signal?.aborted) {
      const reason = options.signal.reason;
      const code =
        typeof reason === "object" && reason !== null && "code" in reason
          ? reason.code
          : null;
      throw new QuestradeQueueError(
        code === "EXPIRED" ? "EXPIRED" : "CANCELLED",
      );
    }
    if (
      options?.expiresAt &&
      options.expiresAt.getTime() <= this.clock().getTime()
    )
      throw new QuestradeQueueError("EXPIRED");
  }
}

export type MappingTriage = "RULE_GAP" | "PROVIDER_MISMATCH" | "UNSUPPORTED";

/** Visible classification of a non-resolved mapping for operator triage. */
export function triageMappingFailure(
  decision: MappingDecision,
): MappingTriage | null {
  if (decision.status === "RESOLVED") return null;
  switch (decision.reason) {
    case "CLASSIFICATION_REVIEW_REQUIRED":
      return "RULE_GAP";
    case "MULTIPLE_MATCHES":
    case "NO_EXACT_MATCH":
      return "PROVIDER_MISMATCH";
    default:
      return "UNSUPPORTED";
  }
}

export function triageMappingFailures(
  decisions: readonly MappingDecision[],
): Record<MappingTriage, number> {
  const counts: Record<MappingTriage, number> = {
    RULE_GAP: 0,
    PROVIDER_MISMATCH: 0,
    UNSUPPORTED: 0,
  };
  for (const decision of decisions) {
    const triage = triageMappingFailure(decision);
    if (triage) counts[triage] += 1;
  }
  return counts;
}
