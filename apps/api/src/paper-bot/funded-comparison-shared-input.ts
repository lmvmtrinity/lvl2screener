import type {
  FundedComparisonInputChunk,
  FundedComparisonInputItem,
  FundedComparisonSourceOpportunity,
} from "@tsx-scanner/contracts";
import type { FundedComparisonSpecificationReceipt } from "./funded-comparison-repository.js";
import { FundedComparisonSpecificationError } from "./funded-comparison-specification.js";
import {
  fundedComparisonChunkDigest,
  fundedComparisonInputItemDigest,
  fundedComparisonSessionInputDigest,
} from "./funded-comparison-digest.js";
import {
  inputItemEffectiveAt,
  inputItemOrderKey,
  type FundedComparisonInputItem as ContractInputItem,
} from "@tsx-scanner/contracts";

/**
 * Session-scoped reconstruction exclusively from the immutable comparison input
 * chunks. Every item, chunk and session digest is verified before any replay
 * effect exists; no raw `quote_snapshot`, `candle`, `strategy_state_event` or
 * current configuration read happens here.
 */

export type FundedComparisonOpportunityItem = Extract<
  ContractInputItem,
  { kind: "OPPORTUNITY" }
>;
export type FundedComparisonQuoteItem = Extract<
  ContractInputItem,
  { kind: "QUOTE" }
>;
export type FundedComparisonInvalidationItem = Extract<
  ContractInputItem,
  { kind: "INVALIDATION" }
>;

export interface FundedComparisonSharedInput {
  readonly sessionDate: string;
  readonly sessionStartAt: string;
  readonly scheduledCloseAt: string;
  readonly sessionTimezone: string;
  readonly items: readonly FundedComparisonInputItem[];
  readonly opportunities: readonly FundedComparisonSourceOpportunity[];
  readonly opportunityItems: ReadonlyMap<
    string,
    FundedComparisonOpportunityItem
  >;
  readonly quotes: readonly FundedComparisonQuoteItem[];
  readonly invalidations: readonly FundedComparisonInvalidationItem[];
  readonly sessionInputDigest: string;
}

export interface FundedComparisonSharedInputSource {
  loadSpecification(
    specId: string,
  ): Promise<FundedComparisonSpecificationReceipt | undefined>;
  loadSessionChunks(
    specId: string,
    sessionDate: string,
  ): Promise<readonly FundedComparisonInputChunk[]>;
}

function fail(message: string): never {
  throw new FundedComparisonSpecificationError(
    "RETAINED_INPUT_MISSING",
    message,
  );
}

export async function loadFundedComparisonSharedInput(
  source: FundedComparisonSharedInputSource,
  specId: string,
  sessionDate: string,
): Promise<FundedComparisonSharedInput> {
  const receipt = await source.loadSpecification(specId);
  if (!receipt) fail(`Comparison specification ${specId} does not exist`);
  const specification = receipt.specification;
  if (
    !specification.sessionMembership.orderedSessionDates.includes(sessionDate)
  )
    fail(`Session ${sessionDate} is not part of the frozen membership`);
  const session = receipt.sessions.find(
    (value) => value.sessionDate === sessionDate,
  );
  if (!session)
    fail(`Session ${sessionDate} is not part of the frozen membership`);
  const frozenSessionInput = specification.sharedInput.orderedSessions.find(
    (entry) => entry.sessionDate === sessionDate,
  );
  if (!frozenSessionInput)
    fail(`Session ${sessionDate} has no frozen shared-input identity`);
  const chunks = await source.loadSessionChunks(specId, sessionDate);
  if (chunks.length === 0)
    fail(`Session ${sessionDate} has no retained chunks`);
  let expectedOrdinal = 1;
  let itemCount = 0;
  const itemDigests: string[] = [];
  const items: FundedComparisonInputItem[] = [];
  let previousKey = "";
  for (const chunk of chunks) {
    if (chunk.sessionDate !== sessionDate)
      fail("A retained chunk belongs to another session");
    if (chunk.chunkOrdinal !== expectedOrdinal)
      fail("Retained chunk ordinals are not contiguous");
    expectedOrdinal += 1;
    if (chunk.itemCount !== chunk.items.length)
      fail("Retained chunk item count does not match its membership");
    const digests: string[] = [];
    for (const [index, entry] of chunk.items.entries()) {
      if (fundedComparisonInputItemDigest(entry.item) !== entry.itemDigest)
        fail("A retained input item does not match its item digest");
      const key = inputItemOrderKey(entry.item);
      if (index === 0 && previousKey !== "" && key < previousKey)
        fail("Retained input order is not monotone across a chunk boundary");
      if (index > 0 && key < previousKey)
        fail("Retained input items are not in canonical order");
      previousKey = key;
      digests.push(entry.itemDigest);
      itemDigests.push(entry.itemDigest);
      items.push(entry.item);
    }
    const first = items[items.length - chunk.items.length]!;
    const last = items[items.length - 1]!;
    if (
      inputItemEffectiveAt(first) !== chunk.firstEffectiveAt ||
      inputItemEffectiveAt(last) !== chunk.lastEffectiveAt
    )
      fail("A retained chunk boundary does not match its effective window");
    const expectedChunkDigest = fundedComparisonChunkDigest({
      sessionDate,
      chunkOrdinal: chunk.chunkOrdinal,
      firstEffectiveAt: chunk.firstEffectiveAt,
      lastEffectiveAt: chunk.lastEffectiveAt,
      itemDigests: digests,
    });
    if (expectedChunkDigest !== chunk.chunkDigest)
      fail("A retained chunk digest does not match its content");
    itemCount += chunk.itemCount;
  }
  const sessionInputDigest = fundedComparisonSessionInputDigest({
    sessionDate,
    chunkDigests: chunks.map((chunk) => chunk.chunkDigest),
    itemCount,
  });
  if (sessionInputDigest !== session.sessionInputDigest)
    fail("The retained session input digest does not match the specification");
  if (
    frozenSessionInput.itemCount !== itemCount ||
    frozenSessionInput.chunkCount !== chunks.length ||
    frozenSessionInput.sessionInputDigest !== sessionInputDigest
  )
    fail(
      "The retained session input does not match the frozen shared-input identity",
    );
  void itemDigests;
  const opportunityItems = new Map<string, FundedComparisonOpportunityItem>();
  const quotes: FundedComparisonQuoteItem[] = [];
  const invalidations: FundedComparisonInvalidationItem[] = [];
  for (const item of items) {
    if (item.kind === "OPPORTUNITY") {
      if (opportunityItems.has(item.sourceOpportunityId))
        fail("A retained opportunity identity appears twice");
      opportunityItems.set(item.sourceOpportunityId, item);
    } else if (item.kind === "QUOTE") quotes.push(item);
    else if (item.kind === "INVALIDATION") invalidations.push(item);
  }
  const sessionMembership = specification.opportunityMembership;
  const sessionOpportunities = receipt.opportunities.filter(
    (opportunity) => opportunity.sessionDate === sessionDate,
  );
  if (
    sessionOpportunities.length !== opportunityItems.size ||
    sessionOpportunities.some(
      (opportunity, index) => opportunity.sourceOrdinal !== index + 1,
    )
  )
    fail(
      "Retained session opportunity ordinals are not the frozen ordinal slice",
    );
  for (const opportunity of sessionOpportunities) {
    if (
      !sessionMembership.orderedOpportunityIds.includes(
        opportunity.sourceOpportunityId,
      )
    )
      fail(
        `Source opportunity ${opportunity.sourceOpportunityId} is outside the frozen membership`,
      );
    const item = opportunityItems.get(opportunity.sourceOpportunityId);
    if (!item)
      fail(
        `Source opportunity ${opportunity.sourceOpportunityId} has no retained input item`,
      );
    if (
      fundedComparisonInputItemDigest(item) !== opportunity.sourceContentDigest
    )
      fail(
        `Source opportunity ${opportunity.sourceOpportunityId} does not match its retained content digest`,
      );
    if (
      item.sourceEventId !== opportunity.sourceEventId ||
      item.sessionDate !== opportunity.sessionDate ||
      item.sourceOrdinal !== opportunity.sourceOrdinal ||
      item.signalTimestamp !== opportunity.signalTimestamp
    )
      fail(
        `Source opportunity ${opportunity.sourceOpportunityId} identity changed in the retained input`,
      );
  }
  const boundary = items.find(
    (item): item is Extract<ContractInputItem, { kind: "SESSION_BOUNDARY" }> =>
      item.kind === "SESSION_BOUNDARY",
  );
  if (!boundary) fail("The retained session has no boundary item");
  return {
    sessionDate,
    sessionStartAt: boundary.sessionStartAt,
    scheduledCloseAt: boundary.scheduledCloseAt,
    sessionTimezone: boundary.sessionTimezone,
    items,
    opportunities: [...sessionOpportunities],
    opportunityItems,
    quotes,
    invalidations,
    sessionInputDigest,
  };
}
