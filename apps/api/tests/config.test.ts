import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createMarketProfiles } from "../src/markets/market-profile.js";

describe("API configuration", () => {
  it("keeps mock mode credential-free", () => {
    const config = loadConfig({});
    expect(config.MARKET_DATA_MODE).toBe("mock");
    expect(config.TSX_UNIVERSE_SYMBOLS).toEqual([]);
    expect(config.MARKET_BENCHMARK_SYMBOL).toBe("XIU.TO");
    expect(config.SECTOR_BENCHMARK_SYMBOLS.BASIC_MATERIALS).toBe("XMA.TO");
    expect(config.SECTOR_BENCHMARK_SYMBOLS).not.toHaveProperty(
      "COMMUNICATION_SERVICES",
    );
    expect(config.PAPER_BOT_FEE_PER_TRADE).toBe(0);
    expect(config.PAPER_COORDINATION_MAX_DAILY_LOSS).toBe(1_000);
    expect(config.PAPER_COORDINATION_MAX_CONSECUTIVE_STOPS).toBe(3);
    expect(config.PAPER_BOT_SLIPPAGE_BPS).toBe(2);
    expect(config.PAPER_FUNDED_CAD_ACCOUNT_ID).toBeUndefined();
    expect(config.PAPER_FUNDED_INITIAL_CASH_CAD).toBe(10_000);
    expect(config.DISCOVERY_COMPACTION_ENABLED).toBe(true);
    expect(config.DISCOVERY_COMPACTION_INTERVAL_MS).toBe(86_400_000);
    expect(config.DISCOVERY_INPUT_RETENTION_DAYS).toBe(30);
    expect(config.DISCOVERY_SUMMARY_RETENTION_DAYS).toBe(365);
    expect(config.DISCOVERY_FAST_FUNNEL_ENABLED).toBe(false);
  });

  it("defaults to daily learning and preserves explicit interval overrides", () => {
    expect(loadConfig({}).PAPER_MODEL_TRAINING_ENABLED).toBe(true);
    expect(loadConfig({}).PAPER_MODEL_TRAINING_CHECK_MS).toBeUndefined();
    expect(
      loadConfig({ PAPER_MODEL_TRAINING_CHECK_MS: "" })
        .PAPER_MODEL_TRAINING_CHECK_MS,
    ).toBeUndefined();
    expect(
      loadConfig({ PAPER_MODEL_TRAINING_CHECK_MS: "3600000" })
        .PAPER_MODEL_TRAINING_CHECK_MS,
    ).toBe(3600000);
    expect(
      loadConfig({ PAPER_MODEL_TRAINING_ENABLED: "false" })
        .PAPER_MODEL_TRAINING_ENABLED,
    ).toBe(false);
  });

  it("validates configurable discovery evidence retention", () => {
    const config = loadConfig({
      DISCOVERY_COMPACTION_ENABLED: "false",
      DISCOVERY_COMPACTION_INTERVAL_MS: "60000",
      DISCOVERY_INPUT_RETENTION_DAYS: "14",
      DISCOVERY_SUMMARY_RETENTION_DAYS: "90",
    });
    expect(config.DISCOVERY_COMPACTION_ENABLED).toBe(false);
    expect(config.DISCOVERY_COMPACTION_INTERVAL_MS).toBe(60_000);
    expect(config.DISCOVERY_INPUT_RETENTION_DAYS).toBe(14);
    expect(config.DISCOVERY_SUMMARY_RETENTION_DAYS).toBe(90);
    expect(() =>
      loadConfig({
        DISCOVERY_INPUT_RETENTION_DAYS: "31",
        DISCOVERY_SUMMARY_RETENTION_DAYS: "30",
      }),
    ).toThrow("must not be shorter");
  });

  it("requires both live secrets", () => {
    expect(() => loadConfig({ MARKET_DATA_MODE: "live" })).toThrow();
    expect(() =>
      loadConfig({
        MARKET_DATA_MODE: "live",
        QUESTRADE_REFRESH_TOKEN: "token",
      }),
    ).toThrow();
  });

  it("normalizes a configured live watchlist", () => {
    const config = loadConfig({
      MARKET_DATA_MODE: "live",
      QUESTRADE_REFRESH_TOKEN: "refresh-token",
      APP_MASTER_KEY: "master-key",
      TSX_UNIVERSE_SYMBOLS: " td.to,RY.TO,td.to ",
    });
    expect(config.TSX_UNIVERSE_SYMBOLS).toEqual(["TD.TO", "RY.TO"]);
  });

  it("normalizes an explicit stable benchmark map", () => {
    const config = loadConfig({
      MARKET_BENCHMARK_SYMBOL: " xiu.to ",
      SECTOR_BENCHMARK_SYMBOLS: '{"Energy":"xeg.to"}',
    });
    expect(config.MARKET_BENCHMARK_SYMBOL).toBe("XIU.TO");
    expect(config.SECTOR_BENCHMARK_SYMBOLS).toEqual({ ENERGY: "XEG.TO" });
  });

  it("accepts explicit paper execution friction assumptions", () => {
    const config = loadConfig({
      PAPER_BOT_FEE_PER_TRADE: "1.25",
      PAPER_BOT_SLIPPAGE_BPS: "4",
    });
    expect(config.PAPER_BOT_FEE_PER_TRADE).toBe(1.25);
    expect(config.PAPER_BOT_SLIPPAGE_BPS).toBe(4);
  });

  it("loads funded account provisioning only from explicit UUID identities", () => {
    const config = loadConfig({
      PAPER_FUNDED_CAD_ACCOUNT_ID: "2f4b1f5c-7b4d-4a0c-9f7f-99ad7c9690e1",
      PAPER_FUNDED_INITIAL_CASH_CAD: "25000",
      PAPER_FUNDED_DAILY_LOSS_LIMIT_CAD: "350",
    });
    expect(config.PAPER_FUNDED_CAD_ACCOUNT_ID).toBe(
      "2f4b1f5c-7b4d-4a0c-9f7f-99ad7c9690e1",
    );
    expect(config.PAPER_FUNDED_INITIAL_CASH_CAD).toBe(25_000);
    expect(config.PAPER_FUNDED_DAILY_LOSS_LIMIT_CAD).toBe(350);
    expect(() =>
      loadConfig({ PAPER_FUNDED_CAD_ACCOUNT_ID: "not-an-account-id" }),
    ).toThrow();
  });

  it("rejects funded identities that cannot be serviced by the selected market runtime", () => {
    expect(() =>
      loadConfig({
        ENABLED_MARKETS: "US_EQUITIES",
        PAPER_FUNDED_CAD_ACCOUNT_ID: "2f4b1f5c-7b4d-4a0c-9f7f-99ad7c9690e1",
      }),
    ).toThrow("CAD funded processing requires CA_TSX");

    expect(() =>
      loadConfig({
        ENABLED_MARKETS: "CA_TSX,US_EQUITIES",
        PAPER_FUNDED_USD_ACCOUNT_ID: "3f4b1f5c-7b4d-4a0c-9f7f-99ad7c9690e1",
      }),
    ).toThrow("USD funded processing requires US market data");
  });

  it("requires fully commissioned US runtime flags for funded USD processing", () => {
    const config = loadConfig({
      ENABLED_MARKETS: "CA_TSX,US_EQUITIES",
      US_MARKET_DATA_ENABLED: "true",
      US_PAPER_TRADING_ENABLED: "true",
      PAPER_FUNDED_USD_ACCOUNT_ID: "3f4b1f5c-7b4d-4a0c-9f7f-99ad7c9690e1",
    });
    expect(config.PAPER_FUNDED_USD_ACCOUNT_ID).toBe(
      "3f4b1f5c-7b4d-4a0c-9f7f-99ad7c9690e1",
    );
  });

  it("does not allow one funded identity to represent two currencies", () => {
    const accountId = "4f4b1f5c-7b4d-4a0c-9f7f-99ad7c9690e1";
    expect(() =>
      loadConfig({
        ENABLED_MARKETS: "CA_TSX,US_EQUITIES",
        US_MARKET_DATA_ENABLED: "true",
        US_PAPER_TRADING_ENABLED: "true",
        PAPER_FUNDED_CAD_ACCOUNT_ID: accountId,
        PAPER_FUNDED_USD_ACCOUNT_ID: accountId,
      }),
    ).toThrow("distinct account identities");
  });

  it("loads separate CAD and USD paper risk limits", () => {
    const config = loadConfig({});
    expect(config.PAPER_BOT_RISK_BUDGET_CAD).toBe(50);
    expect(config.PAPER_BOT_RISK_BUDGET_USD).toBe(25);
    expect(config.PAPER_COORDINATION_MAX_TOTAL_OPEN_RISK_CAD).toBe(150);
    expect(config.PAPER_COORDINATION_MAX_TOTAL_OPEN_RISK_USD).toBe(75);
    expect(config.PAPER_COORDINATION_MAX_DAILY_LOSS_CAD).toBe(200);
    expect(config.PAPER_COORDINATION_MAX_DAILY_LOSS_USD).toBe(100);
  });

  it("keeps US market data and paper execution disabled until explicitly commissioned", () => {
    const config = loadConfig({ ENABLED_MARKETS: "CA_TSX,US_EQUITIES" });
    const profiles = createMarketProfiles(config);
    expect(profiles.CA_TSX).toMatchObject({
      enabled: true,
      marketDataEnabled: true,
    });
    expect(profiles.US_EQUITIES).toMatchObject({
      enabled: true,
      currency: "USD",
      timezone: "America/New_York",
      marketDataEnabled: false,
      paperTradingEnabled: false,
    });
  });

  it("rejects US paper trading without its explicit market-data prerequisites", () => {
    expect(() => loadConfig({ US_PAPER_TRADING_ENABLED: "true" })).toThrow(
      "US paper trading requires US market data",
    );
    expect(() =>
      loadConfig({
        US_MARKET_DATA_ENABLED: "true",
        US_PAPER_TRADING_ENABLED: "true",
      }),
    ).toThrow("US_EQUITIES");
  });

  it("rejects unknown configured market identities", () => {
    expect(() => loadConfig({ ENABLED_MARKETS: "CA_TSX,CRYPTO" })).toThrow();
  });
});
