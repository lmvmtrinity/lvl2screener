import { z } from "zod";
import { setupStrategyNameSchema, strategyStateSchema } from "./strategies.js";

export const alertTypeSchema = z.enum(["READY", "INVALIDATION"]);
export const alertRearmRuleSchema = z.enum([
  "NEW_SETUP_INSTANCE",
  "AFTER_INVALIDATION",
]);
export const alertPolicySchema = z.object({
  cooldownMinutes: z.number().int().min(0).max(120).default(5),
  rearmRule: alertRearmRuleSchema.default("NEW_SETUP_INSTANCE"),
  contextNotificationsEnabled: z.literal(false).default(false),
});
export type AlertPolicy = z.infer<typeof alertPolicySchema>;
export const DEFAULT_ALERT_POLICY: AlertPolicy = {
  cooldownMinutes: 5,
  rearmRule: "NEW_SETUP_INSTANCE",
  contextNotificationsEnabled: false,
};
export const scannerAlertSchema = z.object({
  alertId: z.string().uuid(),
  eventId: z.string().uuid(),
  type: alertTypeSchema,
  symbol: z.string().min(1),
  strategy: setupStrategyNameSchema,
  profileId: z.string().uuid().default("00000000-0000-4000-8000-000000000000"),
  profileName: z.string().min(1).default("Legacy"),
  strategyVersion: z.string().min(1),
  configVersion: z.string().min(1),
  timestamp: z.string().datetime(),
  previousState: strategyStateSchema,
  state: strategyStateSchema,
  score: z.number().int().min(0).max(100),
  title: z.string().min(1),
  message: z.string().min(1),
  reasonCodes: z.array(z.string()),
  setupInstanceId: z.string().uuid().nullable().default(null),
  deduplicationKey: z.string().min(1).optional(),
  entryReference: z.number().positive().nullable().default(null),
  stopReference: z.number().positive().nullable().default(null),
  targetReference: z.number().positive().nullable().default(null),
});
export type ScannerAlert = z.infer<typeof scannerAlertSchema>;
export const alertListSchema = z.object({
  alerts: z.array(scannerAlertSchema),
});
export type AlertList = z.infer<typeof alertListSchema>;
