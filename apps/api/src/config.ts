import { z } from "zod";
import { normalizeSectorKey } from "./questrade/sector.js";

const optionalValue = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().min(1).optional(),
);

const optionalUuid = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().uuid().optional(),
);

const sectorBenchmarks = z.preprocess(
  (value) => {
    if (typeof value !== "string") return value;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  },
  z
    .record(
      z
        .string()
        .min(1)
        .transform((value) => normalizeSectorKey(value)!),
      z
        .string()
        .trim()
        .min(1)
        .transform((value) => value.toUpperCase()),
    )
    .default({
      BASIC_MATERIALS: "XMA.TO",
      FINANCIAL_SERVICES: "XFN.TO",
      ENERGY: "XEG.TO",
      INDUSTRIAL: "XGI.TO",
      TECHNOLOGY: "XIT.TO",
      UTILITIES: "XUT.TO",
      CONSUMER_CYCLICAL: "XCD.TO",
    }),
);

const usSectorBenchmarks = z.preprocess(
  (value) => {
    if (typeof value !== "string") return value;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  },
  z
    .record(
      z
        .string()
        .min(1)
        .transform((value) => normalizeSectorKey(value)!),
      z
        .string()
        .trim()
        .min(1)
        .transform((value) => value.toUpperCase()),
    )
    .default({}),
);

/**
 * Per-strategy holding horizons, e.g.
 * `{"ORB_RETEST":30,"VWAP_HOLD":20}`. Anything unlisted keeps the portfolio
 * default. Values are minutes; the plan requires these to be tested, not
 * assumed, so they stay configuration rather than constants.
 */
const holdingMinutesByStrategy = z.preprocess(
  (value) => {
    if (typeof value !== "string") return value;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  },
  z
    .record(z.string().min(1), z.coerce.number().int().min(1).max(240))
    .default({}),
);

const enabledMarkets = z
  .string()
  .default("CA_TSX")
  .transform((value, context) => {
    const markets = [
      ...new Set(
        value
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
      ),
    ];
    if (markets.length === 0) {
      context.addIssue({
        code: "custom",
        message: "At least one market must be enabled",
      });
      return z.NEVER;
    }
    if (
      markets.some((market) => market !== "CA_TSX" && market !== "US_EQUITIES")
    ) {
      context.addIssue({
        code: "custom",
        message: "ENABLED_MARKETS contains an unsupported market",
      });
      return z.NEVER;
    }
    return markets as ("CA_TSX" | "US_EQUITIES")[];
  });

const commaSeparatedSymbols = z
  .string()
  .default("")
  .transform((value) => [
    ...new Set(
      value
        .split(",")
        .map((symbol) => symbol.trim().toUpperCase())
        .filter(Boolean),
    ),
  ]);

const configSchema = z
  .object({
    API_HOST: z.string().min(1).default("0.0.0.0"),
    API_PORT: z.coerce.number().int().positive().max(65_535).default(3000),
    DATABASE_URL: z
      .string()
      .min(1)
      .default(
        "postgresql://tsx_scanner:local_development_only@localhost:5432/tsx_scanner",
      ),
    SCANNER_URL: z.string().url().default("http://localhost:8000"),
    MARKET_DATA_MODE: z.enum(["mock", "live"]).default("mock"),
    ENABLED_MARKETS: enabledMarkets,
    US_MARKET_DATA_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    US_PAPER_TRADING_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    // Discovery credentials are server-side only. PostgreSQL remains the sole
    // authority for OFF/SHADOW/AUTO_ADD mode.
    EODHD_API_TOKEN: optionalValue,
    // Free Massive (Polygon) key. It selects the Massive US discovery catalog
    // and supplies US corporate-action reference evidence; CA_TSX keeps EODHD.
    MASSIVE_API_KEY: optionalValue,
    QUESTRADE_REFRESH_TOKEN: optionalValue,
    MARKET_DATA_POLL_MS: z.coerce.number().int().min(250).default(2_000),
    DISCOVERY_POLL_MS: z.coerce.number().int().min(250).default(15_000),
    DISCOVERY_LEASE_MS: z.coerce.number().int().min(120_000).default(600_000),
    DISCOVERY_WORKERS: z.coerce.number().int().min(1).max(32).default(4),
    DISCOVERY_COMPACTION_ENABLED: z
      .enum(["true", "false"])
      .default("true")
      .transform((value) => value === "true"),
    DISCOVERY_COMPACTION_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(60_000)
      .max(7 * 24 * 60 * 60 * 1_000)
      .default(24 * 60 * 60 * 1_000),
    DISCOVERY_INPUT_RETENTION_DAYS: z.coerce
      .number()
      .int()
      .min(1)
      .max(365)
      .default(30),
    DISCOVERY_SUMMARY_RETENTION_DAYS: z.coerce
      .number()
      .int()
      .min(1)
      .max(3_650)
      .default(365),
    // The Fast Funnel adds an external TradingView scan to every discovery
    // cycle. Keep it opt-in; enabling it does not authorize AUTO_ADD.
    DISCOVERY_FAST_FUNNEL_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    QUOTE_BATCH_SIZE: z.coerce.number().int().positive().max(100).default(50),
    UNIVERSE_MINIMUM_SIZE: z.coerce
      .number()
      .int()
      .positive()
      .max(10_000)
      .default(1),
    UNIVERSE_MIN_PRICE: z.coerce.number().nonnegative().default(5),
    UNIVERSE_MAX_PRICE: z.coerce.number().positive().default(150),
    UNIVERSE_MIN_MARKET_CAP: z.coerce
      .number()
      .nonnegative()
      .default(500_000_000),
    UNIVERSE_MIN_AVERAGE_VOLUME: z.coerce
      .number()
      .int()
      .nonnegative()
      .default(500_000),
    UNIVERSE_MIN_DOLLAR_VOLUME: z.coerce
      .number()
      .nonnegative()
      .default(20_000_000),
    UNIVERSE_MIN_ATR_PCT: z.coerce.number().nonnegative().default(1.5),
    APP_MASTER_KEY: optionalValue,
    TSX_UNIVERSE_SYMBOLS: commaSeparatedSymbols,
    US_UNIVERSE_SYMBOLS: commaSeparatedSymbols,
    MARKET_BENCHMARK_SYMBOL: z
      .string()
      .trim()
      .min(1)
      .default("XIU.TO")
      .transform((value) => value.toUpperCase()),
    SECTOR_BENCHMARK_SYMBOLS: sectorBenchmarks,
    US_MARKET_BENCHMARK_SYMBOL: z
      .string()
      .trim()
      .min(1)
      .default("SPY")
      .transform((value) => value.toUpperCase()),
    US_SECTOR_BENCHMARK_SYMBOLS: usSectorBenchmarks,
    BENCHMARK_MAX_STALENESS_SECONDS: z.coerce
      .number()
      .int()
      .min(1)
      .max(300)
      .default(30),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    WEB_ORIGIN: z.string().url().default("http://localhost:5173"),
    SESSION_TIMEZONE: z.literal("America/Toronto").default("America/Toronto"),
    US_SESSION_TIMEZONE: z
      .literal("America/New_York")
      .default("America/New_York"),
    OPENING_RANGE_START: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .default("09:30"),
    OPENING_RANGE_END: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .default("09:45"),
    SCANNING_START: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .default("09:45"),
    SCANNING_END: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .default("16:00"),
    ENTRY_PREFERRED_START: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .default("10:00"),
    ENTRY_PREFERRED_END: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .default("11:30"),
    ENTRY_HARD_END: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .default("16:00"),
    // Questrade's current self-directed pricing is $0 commission for online
    // Canadian-listed stock orders. Keep the paper assumption configurable so
    // a different broker, instrument, or future pricing schedule is explicit
    // in the immutable run snapshot rather than hidden in execution code.
    PAPER_BOT_FEE_PER_TRADE: z.coerce
      .number()
      .nonnegative()
      .max(10_000)
      .default(0),
    PAPER_BOT_SLIPPAGE_BPS: z.coerce
      .number()
      .nonnegative()
      .max(1_000)
      .default(2),
    PAPER_BOT_RISK_BUDGET: z.coerce
      .number()
      .positive()
      .max(1_000_000)
      .default(100),
    // Market-specific paper risk overrides. The legacy shared values above
    // remain as compatibility fallbacks for callers that do not provide a
    // market-specific override.
    PAPER_BOT_RISK_BUDGET_CAD: z.coerce
      .number()
      .positive()
      .max(1_000_000)
      .default(50),
    PAPER_BOT_RISK_BUDGET_USD: z.coerce
      .number()
      .positive()
      .max(1_000_000)
      .default(25),
    // The funded paper path is disabled unless an account identity is
    // explicitly supplied. Provisioning is idempotent but the initial cash
    // and daily-loss contract remains immutable for that account.
    PAPER_FUNDED_CAD_ACCOUNT_ID: optionalUuid,
    PAPER_FUNDED_USD_ACCOUNT_ID: optionalUuid,
    PAPER_FUNDED_INITIAL_CASH_CAD: z.coerce
      .number()
      .positive()
      .max(100_000_000)
      .default(10_000),
    PAPER_FUNDED_INITIAL_CASH_USD: z.coerce
      .number()
      .positive()
      .max(100_000_000)
      .default(10_000),
    PAPER_FUNDED_DAILY_LOSS_LIMIT_CAD: z.coerce
      .number()
      .positive()
      .max(1_000_000)
      .default(200),
    PAPER_FUNDED_DAILY_LOSS_LIMIT_USD: z.coerce
      .number()
      .positive()
      .max(1_000_000)
      .default(100),
    // Economic-viability gates (docs/paper-bot-performance-improvement-plan.md
    // Phase 2). These reject a structurally valid setup whose modeled trade
    // cannot pay for its own friction. They are deliberately configurable and
    // recorded in the run's immutable assumptions, because the right values
    // are an evidence question, not a constant.
    PAPER_BOT_MIN_NET_REWARD_RISK: z.coerce
      .number()
      .nonnegative()
      .max(100)
      .default(1),
    PAPER_BOT_MIN_STOP_FRICTION_MULTIPLE: z.coerce
      .number()
      .nonnegative()
      .max(100)
      .default(2),
    PAPER_BOT_MIN_TARGET_FRICTION_MULTIPLE: z.coerce
      .number()
      .nonnegative()
      .max(100)
      .default(3),
    PAPER_BOT_MAX_SPREAD_PCT: z.coerce
      .number()
      .positive()
      .max(100)
      .default(0.5),
    // Portfolio exposure caps for the coordinated projection only; the
    // independent per-strategy evidence is never resized by them.
    PAPER_COORDINATION_MAX_SYMBOL_NOTIONAL: z.coerce
      .number()
      .positive()
      .max(100_000_000)
      .default(10_000),
    PAPER_COORDINATION_MAX_SYMBOL_NOTIONAL_CAD: z.coerce
      .number()
      .positive()
      .max(100_000_000)
      .default(3_000),
    PAPER_COORDINATION_MAX_SYMBOL_NOTIONAL_USD: z.coerce
      .number()
      .positive()
      .max(100_000_000)
      .default(1_500),
    PAPER_COORDINATION_MAX_SECTOR_NOTIONAL: z.coerce
      .number()
      .positive()
      .max(100_000_000)
      .default(20_000),
    PAPER_COORDINATION_MAX_SECTOR_NOTIONAL_CAD: z.coerce
      .number()
      .positive()
      .max(100_000_000)
      .default(5_000),
    PAPER_COORDINATION_MAX_SECTOR_NOTIONAL_USD: z.coerce
      .number()
      .positive()
      .max(100_000_000)
      .default(2_500),
    PAPER_COORDINATION_MAX_DISPLAYED_SIZE_PARTICIPATION: z.coerce
      .number()
      .positive()
      .max(1)
      .default(0.25),
    // Context is a veto, never a setup: these only ever withhold a coordinated
    // entry (docs/paper-bot-performance-improvement-plan.md, Phase 4).
    PAPER_COORDINATION_REQUIRE_FRESH_CONTEXT: z
      .enum(["true", "false"])
      .default("true")
      .transform((value) => value === "true"),
    PAPER_COORDINATION_CONTEXT_REQUIREMENT: z
      .enum(["MARKET_ONLY", "MARKET_AND_SECTOR_REQUIRED"])
      .default("MARKET_AND_SECTOR_REQUIRED"),
    PAPER_COORDINATION_CONTEXT_MAX_AGE_SECONDS: z.coerce
      .number()
      .int()
      .min(1)
      .max(3_600)
      .default(300),
    PAPER_COORDINATION_VETO_ON_WEAK_CONTEXT: z
      .enum(["true", "false"])
      .default("true")
      .transform((value) => value === "true"),
    PAPER_COORDINATION_COOLDOWN_MINUTES_AFTER_STOP: z.coerce
      .number()
      .int()
      .min(0)
      .max(240)
      .default(15),
    PAPER_COORDINATION_MAX_OPEN_POSITIONS: z.coerce
      .number()
      .int()
      .min(1)
      .max(20)
      .default(3),
    PAPER_COORDINATION_DAILY_LOSS_LIMIT_TYPE: z
      .enum(["CUMULATIVE_LOSS", "NET_REALIZED_LOSS"])
      .default("CUMULATIVE_LOSS"),
    PAPER_COORDINATION_RESERVE_REMAINING_DAILY_RISK: z
      .enum(["true", "false"])
      .default("true")
      .transform((value) => value === "true"),
    PAPER_COORDINATION_MAX_TOTAL_OPEN_RISK: z.coerce
      .number()
      .positive()
      .max(1_000_000)
      .default(1_000),
    PAPER_COORDINATION_MAX_TOTAL_OPEN_RISK_CAD: z.coerce
      .number()
      .positive()
      .max(1_000_000)
      .default(150),
    PAPER_COORDINATION_MAX_TOTAL_OPEN_RISK_USD: z.coerce
      .number()
      .positive()
      .max(1_000_000)
      .default(75),
    PAPER_COORDINATION_MAX_DAILY_LOSS: z.coerce
      .number()
      .positive()
      .max(1_000_000)
      .default(1_000),
    PAPER_COORDINATION_MAX_DAILY_LOSS_CAD: z.coerce
      .number()
      .positive()
      .max(1_000_000)
      .default(200),
    PAPER_COORDINATION_MAX_DAILY_LOSS_USD: z.coerce
      .number()
      .positive()
      .max(1_000_000)
      .default(100),
    PAPER_COORDINATION_MAX_CONSECUTIVE_STOPS: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(3),
    PAPER_COORDINATION_MAX_HOLDING_MINUTES: z.coerce
      .number()
      .int()
      .min(1)
      .max(240)
      .default(45),
    PAPER_COORDINATION_MAX_HOLDING_MINUTES_BY_STRATEGY:
      holdingMinutesByStrategy,
    PAPER_COORDINATION_STALLED_BREAKOUT_MINUTES: z.coerce
      .number()
      .int()
      .min(1)
      .max(240)
      .default(15),
    PAPER_COORDINATION_STALLED_BREAKOUT_MIN_PROGRESS_R: z.coerce
      .number()
      .min(0)
      .max(5)
      .default(0.25),
    // W8: how long a worker's claim on a research_job row is valid without a heartbeat before
    // another worker may reap and re-claim it, and how often the worker polls for claimable work.
    // Captured-history replays may spend up to the scanner's 10-minute research timeout
    // processing a single session; keep the lease longer so an active replay is not requeued.
    RESEARCH_JOB_LEASE_MS: z.coerce.number().int().min(5_000).default(720_000),
    RESEARCH_JOB_POLL_MS: z.coerce.number().int().min(250).default(2_000),
    PAPER_MODEL_TRAINING_ENABLED: z
      .enum(["true", "false"])
      .default("true")
      .transform((value) => value === "true"),
    // A1: daily post-session qualification catch-up. Opt-in until an operator
    // enables it; profile saves and explicit refreshes are always evaluated.
    BACKTEST_AUTOMATION_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    BACKTEST_AUTOMATION_MAX_OUTSTANDING: z.coerce
      .number()
      .int()
      .min(0)
      .max(100)
      .default(2),
    // Optional legacy interval override; otherwise use the daily Eastern close schedule.
    PAPER_MODEL_TRAINING_CHECK_MS: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce
        .number()
        .int()
        .min(60 * 60 * 1000)
        .optional(),
    ),
    // W5: shared internal credential presented on every api/worker -> scanner call. The scanner
    // service rejects any /internal/v1/* request whose X-Scanner-Token header doesn't match its
    // own SCANNER_SERVICE_TOKEN, so a process on the Compose network (or a host that manages to
    // reach the scanner port in a debug profile) still can't drive the feature engine without
    // this secret. Always required -- see docker-compose.yml for the Phase A default.
    SCANNER_SERVICE_TOKEN: z
      .string()
      .min(1)
      .default("local-development-only-scanner-token"),
    // W5: gates the remote-access profile's auth/CSRF/rate-limit/audit layer in app.ts. Off by
    // default (Phase A, single trusted operator on localhost never sees a login screen). The
    // "remote" Compose profile sets this to true and must also supply OPERATOR_PASSWORD_HASH and
    // SESSION_SECRET (enforced below).
    REMOTE_ACCESS_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    // scrypt hash of the single operator's login password, formatted "scrypt:<saltHex>:<hashHex>"
    // (see src/auth/password.ts). Never a plaintext password on disk or in the process environment.
    OPERATOR_PASSWORD_HASH: optionalValue,
    // Signs nothing cryptographically today (sessions are an in-memory random id, not a JWT) but
    // is required alongside the password hash so a remote deployment can't be stood up by copying
    // only half of docker-compose.yml's remote-profile env block.
    SESSION_SECRET: optionalValue,
  })
  .superRefine((config, context) => {
    if (config.US_PAPER_TRADING_ENABLED && !config.US_MARKET_DATA_ENABLED) {
      context.addIssue({
        code: "custom",
        path: ["US_PAPER_TRADING_ENABLED"],
        message: "US paper trading requires US market data to be enabled",
      });
    }
    if (
      config.US_PAPER_TRADING_ENABLED &&
      !config.ENABLED_MARKETS.includes("US_EQUITIES")
    ) {
      context.addIssue({
        code: "custom",
        path: ["US_PAPER_TRADING_ENABLED"],
        message: "US paper trading requires US_EQUITIES in ENABLED_MARKETS",
      });
    }
    if (
      config.PAPER_FUNDED_CAD_ACCOUNT_ID &&
      !config.ENABLED_MARKETS.includes("CA_TSX")
    ) {
      context.addIssue({
        code: "custom",
        path: ["PAPER_FUNDED_CAD_ACCOUNT_ID"],
        message: "CAD funded processing requires CA_TSX in ENABLED_MARKETS",
      });
    }
    if (config.PAPER_FUNDED_USD_ACCOUNT_ID) {
      if (!config.ENABLED_MARKETS.includes("US_EQUITIES")) {
        context.addIssue({
          code: "custom",
          path: ["PAPER_FUNDED_USD_ACCOUNT_ID"],
          message:
            "USD funded processing requires US_EQUITIES in ENABLED_MARKETS",
        });
      }
      if (!config.US_MARKET_DATA_ENABLED) {
        context.addIssue({
          code: "custom",
          path: ["PAPER_FUNDED_USD_ACCOUNT_ID"],
          message:
            "USD funded processing requires US market data to be enabled",
        });
      }
      if (!config.US_PAPER_TRADING_ENABLED) {
        context.addIssue({
          code: "custom",
          path: ["PAPER_FUNDED_USD_ACCOUNT_ID"],
          message:
            "USD funded processing requires US paper trading to be enabled",
        });
      }
    }
    if (
      config.PAPER_FUNDED_CAD_ACCOUNT_ID &&
      config.PAPER_FUNDED_CAD_ACCOUNT_ID === config.PAPER_FUNDED_USD_ACCOUNT_ID
    ) {
      context.addIssue({
        code: "custom",
        path: ["PAPER_FUNDED_USD_ACCOUNT_ID"],
        message:
          "CAD and USD funded processing must use distinct account identities",
      });
    }
    if (config.MARKET_DATA_MODE === "live") {
      if (!config.QUESTRADE_REFRESH_TOKEN) {
        context.addIssue({
          code: "custom",
          path: ["QUESTRADE_REFRESH_TOKEN"],
          message: "Required in live mode",
        });
      }
      if (!config.APP_MASTER_KEY) {
        context.addIssue({
          code: "custom",
          path: ["APP_MASTER_KEY"],
          message: "Required in live mode",
        });
      }
    }
    if (config.REMOTE_ACCESS_ENABLED) {
      if (!config.OPERATOR_PASSWORD_HASH) {
        context.addIssue({
          code: "custom",
          path: ["OPERATOR_PASSWORD_HASH"],
          message: "Required when REMOTE_ACCESS_ENABLED=true",
        });
      }
      if (!config.SESSION_SECRET || config.SESSION_SECRET.length < 32) {
        context.addIssue({
          code: "custom",
          path: ["SESSION_SECRET"],
          message:
            "Required when REMOTE_ACCESS_ENABLED=true and must be at least 32 characters",
        });
      }
      // Guards against the operator-facing default in docker-compose.yml/.env.example leaking
      // into a remotely reachable deployment: the Phase A default is fine on an isolated internal
      // Compose network, but the remote profile's whole premise is that the host may be exposed.
      if (config.DATABASE_URL.includes("local_development_only")) {
        context.addIssue({
          code: "custom",
          path: ["DATABASE_URL"],
          message:
            "Refusing to start a remote-access deployment with the documented local-development Postgres password. Set POSTGRES_PASSWORD to a real secret.",
        });
      }
      if (
        config.SCANNER_SERVICE_TOKEN === "local-development-only-scanner-token"
      ) {
        context.addIssue({
          code: "custom",
          path: ["SCANNER_SERVICE_TOKEN"],
          message:
            "Refusing to start a remote-access deployment with the documented local-development scanner token. Set SCANNER_SERVICE_TOKEN to a real secret.",
        });
      }
    }
    if (
      config.DISCOVERY_SUMMARY_RETENTION_DAYS <
      config.DISCOVERY_INPUT_RETENTION_DAYS
    ) {
      context.addIssue({
        code: "custom",
        path: ["DISCOVERY_SUMMARY_RETENTION_DAYS"],
        message:
          "Discovery summary retention must not be shorter than input retention",
      });
    }
  });

export type ApiConfig = z.infer<typeof configSchema>;

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ApiConfig {
  return configSchema.parse(environment);
}
