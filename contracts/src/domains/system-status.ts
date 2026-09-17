import { z } from "zod";

export const serviceNameSchema = z.enum(["api", "scanner"]);
export type ServiceName = z.infer<typeof serviceNameSchema>;

export const serviceHealthSchema = z.object({
  service: serviceNameSchema,
  status: z.enum(["ok", "degraded"]),
  version: z.string().min(1),
  timestamp: z.string().datetime(),
});
export type ServiceHealth = z.infer<typeof serviceHealthSchema>;

export const scannerReadinessSchema = serviceHealthSchema.extend({
  service: z.literal("scanner"),
  checks: z.object({
    config: z.literal("ok"),
  }),
});
export type ScannerReadiness = z.infer<typeof scannerReadinessSchema>;

export const dependencyStatusSchema = z.object({
  status: z.enum(["ok", "error"]),
  detail: z.string().optional(),
});
export type DependencyStatus = z.infer<typeof dependencyStatusSchema>;

/**
 * Every distinct reason the system can be non-actionable. `/health/ready` and `/api/system/status`
 * stay in sync by sharing this list: a service can be infrastructure-healthy (able to serve the
 * operator UI) while still reporting one or more of these codes and therefore not actionable for
 * trading. An actionable state always reports an empty array.
 */
export const operationalReasonCodeSchema = z.enum([
  "SERVICE_STARTING",
  "SCANNER_UNAVAILABLE",
  "DATABASE_UNAVAILABLE",
  "AUTH_REQUIRED",
  "MARKET_CLOSED",
  "EMPTY_UNIVERSE",
  "WAITING_FOR_CANDIDATES",
  "BENCHMARKS_UNRESOLVED",
  "DATA_STALE",
  "SCANNER_OUT_OF_SYNC",
]);
export type OperationalReasonCode = z.infer<typeof operationalReasonCodeSchema>;

export const operationalStatusSchema = z.object({
  /** Can the service serve the operator UI at all — the sole concern of `/health/ready`. */
  serviceReady: z.boolean(),
  /** Are the dependencies needed for trading (auth, universe, benchmarks, engine) healthy. */
  operationalReady: z.boolean(),
  /** `serviceReady && operationalReady && reasonCodes.length === 0`. The single value every
   *  operator surface (footer, alerting, `/metrics`) should read instead of deriving its own. */
  actionable: z.boolean(),
  reasonCodes: z.array(operationalReasonCodeSchema),
  marketDataMode: z.enum(["mock", "live"]),
  session: z
    .object({
      marketStatus: z.string(),
      phase: z.string().nullable(),
    })
    .nullable(),
  auth: z.enum(["CONNECTED", "AUTH_REQUIRED", "UNKNOWN"]),
  dataFreshness: z.object({
    quoteAgeMs: z.number().nonnegative().nullable(),
    candleAgeMs: z.number().nonnegative().nullable(),
    benchmarkAgeMs: z.number().nonnegative().nullable(),
    evaluationAgeMs: z.number().nonnegative().nullable(),
  }),
  universe: z.object({
    configured: z.number().int().nonnegative(),
    resolved: z.number().int().nonnegative(),
    evaluated: z.number().int().nonnegative(),
  }),
  benchmarkReady: z.boolean(),
  scannerSynchronized: z.boolean(),
});
export type OperationalStatus = z.infer<typeof operationalStatusSchema>;

export const systemStatusSchema = z.object({
  service: z.literal("api"),
  status: z.enum(["ok", "degraded"]),
  version: z.string().min(1),
  timestamp: z.string().datetime(),
  mode: z.enum(["mock", "live"]),
  checks: z.object({
    database: dependencyStatusSchema,
    scanner: dependencyStatusSchema,
    config: dependencyStatusSchema,
    marketData: dependencyStatusSchema,
  }),
  operational: operationalStatusSchema,
});
export type SystemStatus = z.infer<typeof systemStatusSchema>;
