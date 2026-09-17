import type { MarketDataAdapter, Quote } from "../questrade/types.js";
import type { MarketDataRepository } from "./repository.js";
import type { MarketId } from "@tsx-scanner/contracts";

export class QuestradeQuoteService {
  constructor(
    private readonly adapter: MarketDataAdapter,
    private readonly repository: MarketDataRepository,
    private readonly batchSize = 50,
  ) {
    if (!Number.isInteger(batchSize) || batchSize < 1)
      throw new Error("Quote batch size must be positive");
  }

  recoveryInstruments(marketId: MarketId) {
    return (
      this.repository.listRecoveryInstruments?.(marketId) ?? Promise.resolve([])
    );
  }

  async collect(symbolIds: number[]): Promise<Quote[]> {
    const uniqueIds = [...new Set(symbolIds)];
    const batches: number[][] = [];
    for (let index = 0; index < uniqueIds.length; index += this.batchSize) {
      batches.push(uniqueIds.slice(index, index + this.batchSize));
    }
    const quotes = (
      await Promise.all(batches.map((batch) => this.adapter.getQuotes(batch)))
    ).flat();
    await this.repository.saveQuotes(quotes);
    return quotes;
  }
}
