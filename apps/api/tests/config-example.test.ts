import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const example = parseEnv(
  readFileSync(new URL("../../../.env.example", import.meta.url), "utf8"),
);

describe("copyable environment example", () => {
  it("boots configuration in mock mode with empty credential placeholders", () => {
    const config = loadConfig(example);
    expect(config.MARKET_DATA_MODE).toBe("mock");
    expect(config.APP_MASTER_KEY).toBeUndefined();
    expect(config.QUESTRADE_REFRESH_TOKEN).toBeUndefined();
    expect(config.EODHD_API_TOKEN).toBeUndefined();
    expect(config.US_PAPER_TRADING_ENABLED).toBe(false);
  });

  it("accepts the documented live substitutions and optional US observation", () => {
    const live = {
      ...example,
      MARKET_DATA_MODE: "live",
      QUESTRADE_REFRESH_TOKEN: "synthetic-bootstrap-token",
      APP_MASTER_KEY: Buffer.alloc(32, 1).toString("base64"),
      EODHD_API_TOKEN: "synthetic-catalog-token",
    };
    expect(loadConfig(live).MARKET_DATA_MODE).toBe("live");
    const bothMarkets = loadConfig({
      ...live,
      ENABLED_MARKETS: "CA_TSX,US_EQUITIES",
      US_MARKET_DATA_ENABLED: "true",
    });
    expect(bothMarkets.ENABLED_MARKETS).toEqual(["CA_TSX", "US_EQUITIES"]);
    expect(bothMarkets.US_PAPER_TRADING_ENABLED).toBe(false);
  });
});
