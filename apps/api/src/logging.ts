import type { FastifyServerOptions } from "fastify";
import type { ApiConfig } from "./config.js";

export function loggerOptions(
  config: ApiConfig,
): FastifyServerOptions["logger"] {
  return {
    level: config.LOG_LEVEL,
    base: { service: "api" },
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "accessToken",
        "refreshToken",
        "*.accessToken",
        "*.refreshToken",
        "QUESTRADE_REFRESH_TOKEN",
        "*.QUESTRADE_REFRESH_TOKEN",
        "APP_MASTER_KEY",
        "*.APP_MASTER_KEY",
      ],
      censor: "[REDACTED]",
    },
  };
}
