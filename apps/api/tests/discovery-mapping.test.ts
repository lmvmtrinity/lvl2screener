import { describe, expect, it, vi } from "vitest";
import {
  CLASSIFICATION_REVIEW_REVISION,
  DiscoverySymbolMapper,
  triageMappingFailure,
  triageMappingFailures,
  type DiscoveryMappingStore,
  type DiscoverySymbolMapperOptions,
  type MappingDecision,
} from "../src/universe/discovery-mapping.js";
import { parseEodhdCatalog } from "../src/universe/eodhd-catalog.js";
import {
  normalizeMassiveTickers,
  parseMassiveCatalog,
} from "../src/universe/massive-catalog.js";
import type { Instrument } from "../src/questrade/types.js";

const member = () =>
  parseEodhdCatalog(
    [
      {
        Code: "QBR.B",
        Name: "Example",
        Exchange: "TSX",
        Currency: "CAD",
        Type: "Common Stock",
      },
    ],
    "CA_TSX",
  )[0]!;
const instrument: Instrument = {
  symbol: "QBR.B.TO",
  symbolId: 123,
  exchange: "TSX",
  currency: "CAD",
  securityType: "Common Stock",
  description: "Example",
  isQuotable: true,
  isTradable: true,
};
const massiveDigest = "b".repeat(64);
const massiveMember = (overrides: Record<string, unknown> = {}) => {
  const rows = normalizeMassiveTickers(
    [
      {
        ticker: "AAPL",
        name: "Apple Inc.",
        primary_exchange: "XNAS",
        type: "CS",
        currency_name: "usd",
        cik: "0000320193",
        composite_figi: "BBG000B9XRY4",
        share_class_figi: "BBG001S5N8V8",
        ...overrides,
      },
    ],
    { retrievedAt: "2026-09-08T12:00:00.000Z", responseDigest: massiveDigest },
  );
  return parseMassiveCatalog(rows, "US_EQUITIES")[0]!;
};
const usInstrument: Instrument = {
  symbol: "AAPL",
  symbolId: 456,
  exchange: "NASDAQ",
  currency: "USD",
  securityType: "Stock",
  description: "Apple Inc.",
  isQuotable: true,
  isTradable: true,
};
function setup(
  rows = [instrument],
  options: DiscoverySymbolMapperOptions = {},
) {
  let value: MappingDecision | null = null;
  const store: DiscoveryMappingStore = {
    load: async () => value,
    save: vi.fn(async (decision) => {
      value = decision;
    }),
  };
  const broker = { searchSymbols: vi.fn(async () => rows) };
  let now = new Date("2026-09-08T12:00:00Z");
  return {
    broker,
    store,
    mapper: new DiscoverySymbolMapper(broker, store, () => now, options),
    setTime: (at: string) => {
      now = new Date(at);
    },
  };
}
describe("discovery broker mapping", () => {
  it("matches EODHD TO to broker TSX without trusting a generic Stock classification", async () => {
    const item = member();
    item.raw.Exchange = "TO";
    expect((await setup().mapper.resolve("CA_TSX", item)).status).toBe(
      "RESOLVED",
    );
    expect(
      (
        await setup([{ ...instrument, securityType: "Stock" }]).mapper.resolve(
          "CA_TSX",
          item,
        )
      ).status,
    ).toBe("REVIEW_REQUIRED");
    expect(
      (
        await setup([{ ...instrument, exchange: "TO" }]).mapper.resolve(
          "CA_TSX",
          item,
        )
      ).status,
    ).toBe("UNSUPPORTED");
  });
  it("rejects corrupted resolved cache ownership instead of trusting status", async () => {
    const h = setup();
    const resolved = await h.mapper.resolve("CA_TSX", member());
    vi.spyOn(h.store, "load").mockResolvedValue({
      ...resolved,
      instrument: { ...instrument, currency: "USD" },
    });
    await expect(h.mapper.resolve("CA_TSX", member())).rejects.toThrow(
      "verified instrument ownership/type",
    );
  });
  it("resolves an exact reviewed share class and caches its identity", async () => {
    const h = setup();
    const [first, second] = await Promise.all([
      h.mapper.resolve("CA_TSX", member()),
      h.mapper.resolve("CA_TSX", member()),
    ]);
    expect(first).toMatchObject({
      status: "RESOLVED",
      instrument: { symbolId: 123 },
    });
    expect(second).toEqual(first);
    expect(await h.mapper.resolve("CA_TSX", member())).toEqual(first);
    expect(h.broker.searchSymbols).toHaveBeenCalledTimes(1);
  });
  it.each([
    [{ currency: "USD" }, "UNSUPPORTED", "CURRENCY_NOT_ALLOWED"],
    [{ exchange: "TSXV" }, "UNSUPPORTED", "EXCHANGE_NOT_ALLOWED"],
    [
      { securityType: "Stock" },
      "REVIEW_REQUIRED",
      "CLASSIFICATION_REVIEW_REQUIRED",
    ],
    [
      { securityType: "ADR" },
      "REVIEW_REQUIRED",
      "CLASSIFICATION_REVIEW_REQUIRED",
    ],
    [{ symbol: "QBR-B.TO" }, "NOT_FOUND", "NO_EXACT_MATCH"],
    [{ isQuotable: false }, "UNSUPPORTED", "NOT_QUOTABLE"],
    [{ isTradable: false }, "UNSUPPORTED", "NOT_TRADABLE"],
  ] as const)(
    "does not qualify ambiguous metadata %o",
    async (override, status, reason) => {
      const h = setup([{ ...instrument, ...override }]);
      expect(await h.mapper.resolve("CA_TSX", member())).toMatchObject({
        status,
        reason,
      });
    },
  );
  it("rejects multiple broker identities for the same exact listing", async () => {
    const h = setup([instrument, { ...instrument, symbolId: 124 }]);
    expect(await h.mapper.resolve("CA_TSX", member())).toMatchObject({
      status: "AMBIGUOUS",
    });
  });
  it("reuses unresolved classification across daily cycles and mapper restarts without renewing evidence", async () => {
    const h = setup([{ ...instrument, securityType: "Stock" }]);
    const first = await h.mapper.resolve("CA_TSX", member());
    expect(first).toMatchObject({
      status: "REVIEW_REQUIRED",
      resolvedAt: "2026-09-08T12:00:00.000Z",
      expiresAt: "2026-10-08T12:00:00.000Z",
    });
    for (let day = 9; day <= 30; day++) {
      const at = `2026-09-${String(day).padStart(2, "0")}T12:00:00Z`;
      const restarted = new DiscoverySymbolMapper(
        h.broker,
        h.store,
        () => new Date(at),
      );
      expect(await restarted.resolve("CA_TSX", member())).toEqual(first);
    }
    expect(h.broker.searchSymbols).toHaveBeenCalledTimes(1);
    expect(h.store.save).toHaveBeenCalledTimes(1);
    h.setTime("2026-10-08T12:00:00Z");
    await h.mapper.resolve("CA_TSX", member());
    expect(h.broker.searchSymbols).toHaveBeenCalledTimes(2);
  });
  it("invalidates classification review immediately when catalog metadata changes", async () => {
    const h = setup([{ ...instrument, securityType: "Stock" }]);
    await h.mapper.resolve("CA_TSX", member());
    const changed = member();
    changed.raw.Isin = "new-identity";
    expect((await h.mapper.resolve("CA_TSX", changed)).status).toBe(
      "REVIEW_REQUIRED",
    );
    expect(h.broker.searchSymbols).toHaveBeenCalledTimes(2);
  });
  it("honors legacy review expiry instead of silently extending an old observation", async () => {
    const h = setup([{ ...instrument, securityType: "Stock" }]);
    const first = await h.mapper.resolve("CA_TSX", member());
    await h.store.save({ ...first, expiresAt: "2026-09-09T12:00:00.000Z" });
    h.setTime("2026-09-09T12:00:00Z");
    const refreshed = await h.mapper.resolve("CA_TSX", member());
    expect(h.broker.searchSymbols).toHaveBeenCalledTimes(2);
    expect(refreshed.resolvedAt).toBe("2026-09-09T12:00:00.000Z");
    expect(refreshed.expiresAt).toBe("2026-10-09T12:00:00.000Z");
  });
  it.each([
    [],
    [instrument, { ...instrument, symbolId: 124 }],
    [{ ...instrument, isQuotable: false }],
    [{ ...instrument, isTradable: false }],
  ])("retries transient or ambiguous mappings daily (%j)", async (...rows) => {
    const h = setup(rows);
    const first = await h.mapper.resolve("CA_TSX", member());
    expect(first.expiresAt).toBe("2026-09-09T12:00:00.000Z");
    h.setTime("2026-09-09T12:00:00Z");
    await h.mapper.resolve("CA_TSX", member());
    expect(h.broker.searchSymbols).toHaveBeenCalledTimes(2);
  });
  it("invalidates changed catalog metadata and expired decisions", async () => {
    const h = setup();
    await h.mapper.resolve("CA_TSX", member());
    const changed = member();
    changed.raw.Isin = "changed-revision";
    await h.mapper.resolve("CA_TSX", changed);
    h.setTime("2026-09-15T12:00:00Z");
    await h.mapper.resolve("CA_TSX", changed);
    expect(h.broker.searchSymbols).toHaveBeenCalledTimes(3);
  });
  it("revalidates market ownership before making broker calls", async () => {
    const h = setup();
    expect(await h.mapper.resolve("US_EQUITIES", member())).toMatchObject({
      status: "UNSUPPORTED",
    });
    expect(h.broker.searchSymbols).not.toHaveBeenCalled();
  });
  it("does not cache provider failures as missing listings", async () => {
    const h = setup();
    h.broker.searchSymbols.mockRejectedValueOnce(new Error("provider down"));
    await expect(h.mapper.resolve("CA_TSX", member())).rejects.toThrow(
      "provider down",
    );
    expect(h.store.save).not.toHaveBeenCalled();
    expect((await h.mapper.resolve("CA_TSX", member())).status).toBe(
      "RESOLVED",
    );
  });

  it("resolves generic broker Stock only with reviewed catalog evidence and a matching ISIN", async () => {
    const item = member();
    item.raw.Isin = "CA1234567890";
    const resolved = await setup([
      { ...instrument, securityType: "Stock" },
    ]).mapper.resolve("CA_TSX", item);
    expect(resolved).toMatchObject({
      status: "RESOLVED",
      reason: "VERIFIED_COMMON_STOCK",
    });
    expect(resolved.classificationEvidence).toMatchObject({
      reviewRevision: CLASSIFICATION_REVIEW_REVISION,
      basis: "EODHD_COMMON_STOCK_ISIN",
      brokerSecurityType: "Stock",
      catalogType: "Common Stock",
      isin: "CA1234567890",
      catalogFingerprint: resolved.catalogFingerprint,
    });
  });

  it("keeps generic broker Stock blocked without matching structured evidence", async () => {
    const noIsin = member();
    expect(
      (
        await setup([{ ...instrument, securityType: "Stock" }]).mapper.resolve(
          "CA_TSX",
          noIsin,
        )
      ).status,
    ).toBe("REVIEW_REQUIRED");
    const wrongIsin = member();
    wrongIsin.raw.Isin = "US0378331005";
    expect(
      (
        await setup([{ ...instrument, securityType: "Stock" }]).mapper.resolve(
          "CA_TSX",
          wrongIsin,
        )
      ).status,
    ).toBe("REVIEW_REQUIRED");
  });

  it("retains broker evidence for an exact common-stock resolution", async () => {
    const item = member();
    item.raw.Isin = "CA1234567890";
    const resolved = await setup().mapper.resolve("CA_TSX", item);
    expect(resolved.classificationEvidence).toMatchObject({
      reviewRevision: CLASSIFICATION_REVIEW_REVISION,
      basis: "BROKER_COMMON_STOCK",
      brokerSecurityType: "Common Stock",
      isin: "CA1234567890",
    });
  });

  it("bounds stale-review re-observation and provisionally reuses the cached decision", async () => {
    const h = setup([{ ...instrument, securityType: "Stock" }], {
      reobservationPerHour: 0,
    });
    const first = await h.mapper.resolve("CA_TSX", member());
    await h.store.save({ ...first, reviewRevision: "legacy" });
    const second = await h.mapper.resolve("CA_TSX", member());
    expect(second.reviewRevision).toBe("legacy");
    expect(h.broker.searchSymbols).toHaveBeenCalledTimes(1);
  });

  it("re-observes a resolution recorded under a stale review revision", async () => {
    const h = setup();
    const first = await h.mapper.resolve("CA_TSX", member());
    await h.store.save({
      ...first,
      reviewRevision: "superseded-review-revision",
      classificationEvidence: {
        ...first.classificationEvidence!,
        reviewRevision: "superseded-review-revision",
      },
    });
    const second = await h.mapper.resolve("CA_TSX", member());
    expect(h.broker.searchSymbols).toHaveBeenCalledTimes(2);
    expect(second.reviewRevision).toBe(CLASSIFICATION_REVIEW_REVISION);
  });

  it("re-observes a legacy cached review decision instead of waiting out its TTL", async () => {
    const h = setup([{ ...instrument, securityType: "Stock" }]);
    const first = await h.mapper.resolve("CA_TSX", member());
    expect(first).toMatchObject({
      status: "REVIEW_REQUIRED",
      reviewRevision: CLASSIFICATION_REVIEW_REVISION,
    });
    const legacy = first as Partial<typeof first>;
    delete legacy.reviewRevision;
    await h.store.save(legacy as typeof first);
    const item = member();
    item.raw.Isin = "CA1234567890";
    const second = await h.mapper.resolve("CA_TSX", item);
    expect(h.broker.searchSymbols).toHaveBeenCalledTimes(2);
    expect(second.status).toBe("RESOLVED");
  });

  it("triages non-resolved mappings into visible categories", async () => {
    const gap = await setup([
      { ...instrument, securityType: "Stock" },
    ]).mapper.resolve("CA_TSX", member());
    const ambiguous = await setup([
      instrument,
      { ...instrument, symbolId: 124 },
    ]).mapper.resolve("CA_TSX", member());
    const mismatch = await setup([]).mapper.resolve("CA_TSX", member());
    const unsupported = await setup([
      { ...instrument, currency: "USD" },
    ]).mapper.resolve("CA_TSX", member());
    expect(triageMappingFailure(gap)).toBe("RULE_GAP");
    expect(triageMappingFailure(ambiguous)).toBe("PROVIDER_MISMATCH");
    expect(triageMappingFailure(mismatch)).toBe("PROVIDER_MISMATCH");
    expect(triageMappingFailure(unsupported)).toBe("UNSUPPORTED");
    expect(
      triageMappingFailures([gap, ambiguous, mismatch, unsupported]),
    ).toEqual({ RULE_GAP: 1, PROVIDER_MISMATCH: 2, UNSUPPORTED: 1 });
  });

  it("resolves generic broker Stock from retained Massive CS evidence", async () => {
    const resolved = await setup([usInstrument]).mapper.resolve(
      "US_EQUITIES",
      massiveMember(),
    );
    expect(resolved).toMatchObject({
      status: "RESOLVED",
      reason: "VERIFIED_COMMON_STOCK",
    });
    expect(resolved.classificationEvidence).toMatchObject({
      reviewRevision: CLASSIFICATION_REVIEW_REVISION,
      basis: "MASSIVE_COMMON_STOCK",
      brokerSecurityType: "Stock",
      catalogType: "Common Stock",
      isin: null,
      providerTicker: "AAPL",
      providerType: "CS",
      providerExchangeMic: "XNAS",
      providerCurrency: "USD",
      cik: "0000320193",
      compositeFigi: "BBG000B9XRY4",
      shareClassFigi: "BBG001S5N8V8",
      providerRetrievedAt: "2026-09-08T12:00:00.000Z",
      providerDigest: massiveDigest,
    });
  });

  it("never resolves a Massive share class through a shared CIK", async () => {
    const h = setup([
      {
        ...usInstrument,
        symbol: "GOOGL",
        symbolId: 789,
        description: "Alphabet Inc. Class A",
      },
    ]);
    const decision = await h.mapper.resolve(
      "US_EQUITIES",
      massiveMember({
        ticker: "GOOG",
        cik: "0001652044",
        share_class_figi: "BBG009S3NB30",
      }),
    );
    expect(h.broker.searchSymbols).toHaveBeenCalledWith("GOOG", undefined);
    expect(decision).toMatchObject({
      status: "NOT_FOUND",
      reason: "NO_EXACT_MATCH",
      instrument: null,
    });
  });

  it.each([
    [{ exchange: "NYSE" }, "UNSUPPORTED", "EXCHANGE_NOT_ALLOWED"],
    [{ currency: "CAD" }, "UNSUPPORTED", "CURRENCY_NOT_ALLOWED"],
  ] as const)(
    "rejects Massive evidence with incompatible broker ownership %o",
    async (override, status, reason) => {
      const h = setup([{ ...usInstrument, ...override }]);
      expect(
        await h.mapper.resolve("US_EQUITIES", massiveMember()),
      ).toMatchObject({ status, reason });
    },
  );

  it("keeps a Massive listing ambiguous when the broker returns multiple exact matches", async () => {
    const h = setup([usInstrument, { ...usInstrument, symbolId: 457 }]);
    expect(
      await h.mapper.resolve("US_EQUITIES", massiveMember()),
    ).toMatchObject({ status: "AMBIGUOUS", reason: "MULTIPLE_MATCHES" });
  });

  it("does not promote a non-CS Massive type or contradictory retained evidence", async () => {
    expect(
      await setup([usInstrument]).mapper.resolve(
        "US_EQUITIES",
        massiveMember({ type: "ETF" }),
      ),
    ).toMatchObject({
      status: "UNSUPPORTED",
      reason: "CLASSIFICATION_REVIEW_REQUIRED",
    });
    const contradictory = massiveMember();
    contradictory.raw.Massive!.providerType = "ETF";
    expect(
      await setup([usInstrument]).mapper.resolve("US_EQUITIES", contradictory),
    ).toMatchObject({
      status: "REVIEW_REQUIRED",
      reason: "CLASSIFICATION_REVIEW_REQUIRED",
    });
  });

  it("invalidates a Massive resolution when retained provider evidence changes", async () => {
    const h = setup([usInstrument]);
    const first = await h.mapper.resolve("US_EQUITIES", massiveMember());
    const second = await h.mapper.resolve(
      "US_EQUITIES",
      massiveMember({ share_class_figi: "BBG001S5N8V9" }),
    );
    expect(h.broker.searchSymbols).toHaveBeenCalledTimes(2);
    expect(second.catalogFingerprint).not.toBe(first.catalogFingerprint);
  });

  it("reuses a Massive resolution when only retrieval metadata changes", async () => {
    const build = (retrievedAt: string, responseDigest: string) =>
      parseMassiveCatalog(
        normalizeMassiveTickers(
          [
            {
              ticker: "AAPL",
              name: "Apple Inc.",
              primary_exchange: "XNAS",
              type: "CS",
              currency_name: "usd",
              cik: "0000320193",
              composite_figi: "BBG000B9XRY4",
              share_class_figi: "BBG001S5N8V8",
            },
          ],
          { retrievedAt, responseDigest },
        ),
        "US_EQUITIES",
      )[0]!;
    const h = setup([usInstrument]);
    const first = await h.mapper.resolve(
      "US_EQUITIES",
      build("2026-09-08T12:00:00.000Z", "b".repeat(64)),
    );
    const second = await h.mapper.resolve(
      "US_EQUITIES",
      build("2026-09-09T12:00:00.000Z", "d".repeat(64)),
    );
    expect(second).toEqual(first);
    expect(h.broker.searchSymbols).toHaveBeenCalledTimes(1);
  });
});
