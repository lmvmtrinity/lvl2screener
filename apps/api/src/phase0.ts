/**
 * @supported (decision-gated, defaulted per private development record W10)
 * Standalone smoke/acceptance script (invoked via `pnpm phase0`) exercising the mock Questrade
 * adapter end to end. No decision was recorded by the plan's "before PR 3" deadline on whether
 * to move this to scripts/ or delete it, so per the plan's stated default it is KEPT in place.
 * Keep while this remains a useful supported smoke/acceptance tool; remove (or relocate under
 * scripts/) once the Phase 0 artifact has no operator use. It has no dedicated unit test, but
 * the adapter it exercises (./questrade/create-mock-adapter.js) is covered by
 * apps/api/tests/mock-adapter.test.ts.
 */
import {
  createMockQuestradeAdapter,
  PHASE0_NOW,
} from "./questrade/create-mock-adapter.js";
import type {
  Candle,
  CandleInterval,
  Instrument,
  Quote,
} from "./questrade/types.js";

const SYMBOLS = ["BTO.TO", "BAM.TO", "QBR.B.TO"];
const RANGE = {
  startTime: new Date("2026-08-24T13:30:00.000Z"),
  endTime: PHASE0_NOW,
};
type Phase0Interval = Exclude<CandleInterval, "OneDay">;

function formatCandle(candle: Candle) {
  return {
    start: candle.start.toISOString(),
    open: candle.open.toFixed(2),
    high: candle.high.toFixed(2),
    low: candle.low.toFixed(2),
    close: candle.close.toFixed(2),
    volume: candle.volume,
    complete: candle.isComplete,
  };
}

async function findExactSymbols(
  adapter: ReturnType<typeof createMockQuestradeAdapter>["adapter"],
) {
  const found = await Promise.all(
    SYMBOLS.map((symbol) => adapter.searchSymbols(symbol)),
  );
  return SYMBOLS.map((symbol, index) =>
    found[index]?.find((candidate) => candidate.symbol === symbol),
  ).filter((instrument): instrument is Instrument => instrument !== undefined);
}

async function loadCandles(
  adapter: ReturnType<typeof createMockQuestradeAdapter>["adapter"],
  instrument: Instrument,
  interval: CandleInterval,
) {
  return adapter.getCandles(instrument.symbolId, interval, RANGE);
}

async function main(): Promise<void> {
  const mode = process.env.MARKET_DATA_MODE ?? "mock";
  if (mode !== "mock") {
    throw new Error(
      "Only MARKET_DATA_MODE=mock is enabled in Phase 0; live Questrade commissioning is deferred.",
    );
  }

  const { adapter, transport } = createMockQuestradeAdapter();
  const session = await adapter.initialize();
  const instruments = await findExactSymbols(adapter);
  if (instruments.length !== SYMBOLS.length) {
    throw new Error(
      `Mock symbol lookup returned ${instruments.length}/${SYMBOLS.length} requested symbols`,
    );
  }

  const quotes = await adapter.getQuotes(
    instruments.map((instrument) => instrument.symbolId),
  );
  const market = await adapter.getMarket("TSX");
  const candlesBySymbol = new Map<string, Record<Phase0Interval, Candle[]>>();

  await Promise.all(
    instruments.map(async (instrument) => {
      const [oneMinute, fiveMinutes] = await Promise.all([
        loadCandles(adapter, instrument, "OneMinute"),
        loadCandles(adapter, instrument, "FiveMinutes"),
      ]);
      candlesBySymbol.set(instrument.symbol, {
        OneMinute: oneMinute,
        FiveMinutes: fiveMinutes,
      });
    }),
  );

  const quoteBySymbol = new Map<string, Quote>(
    quotes.map((quote) => [quote.symbol, quote]),
  );
  console.log("Phase 0 — mocked Questrade technical spike");
  console.log(
    `Auth: MOCK_CONNECTED | dynamic API server: ${session.apiServer.href}`,
  );
  console.log(
    `TSX market: ${market?.status ?? "UNKNOWN"} | clock: ${PHASE0_NOW.toISOString()}`,
  );
  console.table(
    instruments.map((instrument) => {
      const quote = quoteBySymbol.get(instrument.symbol);
      const candles = candlesBySymbol.get(instrument.symbol);
      if (!quote || !candles)
        throw new Error(`Missing Phase 0 data for ${instrument.symbol}`);
      return {
        symbol: instrument.symbol,
        bid: quote.bid.toFixed(2),
        ask: quote.ask.toFixed(2),
        spreadPct: quote.spreadPct.toFixed(3),
        last: quote.last.toFixed(2),
        volume: quote.volume,
        dataStatus: quote.dataStatus,
        actionable: quote.actionable,
        oneMinuteBars: candles.OneMinute.length,
        fiveMinuteBars: candles.FiveMinutes.length,
      };
    }),
  );

  for (const instrument of instruments) {
    const candles = candlesBySymbol.get(instrument.symbol);
    if (!candles) continue;
    console.log(`${instrument.symbol} — latest completed 1m candles`);
    console.table(candles.OneMinute.slice(-3).map(formatCandle));
    console.log(`${instrument.symbol} — latest completed 5m candles`);
    console.table(candles.FiveMinutes.slice(-3).map(formatCandle));
  }

  console.log(
    `Quote batching: ${transport.quoteBatches.length} request for ${quotes.length} symbols`,
  );
  console.log("Safety gate: delayed or halted quotes are never actionable.");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Phase 0 failed: ${message}`);
  process.exitCode = 1;
});
