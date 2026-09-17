import {
  alertPolicySchema,
  scannerAlertSchema,
  type AlertPolicy,
  type ScannerAlert,
} from "@tsx-scanner/contracts";
import type { Pool } from "pg";
import { alertDeduplicationKey } from "./alert-service.js";

export interface AlertStore {
  saveAlerts(alerts: ScannerAlert[]): Promise<ScannerAlert[]>;
  listRecent(limit?: number): Promise<ScannerAlert[]>;
  loadPolicy(): Promise<AlertPolicy>;
  savePolicy(policy: AlertPolicy): Promise<AlertPolicy>;
}

export class PostgresAlertStore implements AlertStore {
  constructor(private readonly pool: Pool) {}

  async saveAlerts(alerts: ScannerAlert[]): Promise<ScannerAlert[]> {
    if (alerts.length === 0) return [];
    const saved: ScannerAlert[] = [];
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const alert of alerts) {
        const result = await client.query(
          `INSERT INTO scanner_alert (id, source_event_id, instrument_id,profile_id, alert_type, strategy_name, strategy_version, config_version, timestamp, previous_state, state, score, title, message, reason_codes, payload,setup_instance_id,deduplication_key)
           SELECT $1,$2,e.instrument_id,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb,$16,$17
           FROM strategy_state_event e WHERE e.id=$2
           ON CONFLICT (deduplication_key) DO NOTHING
           RETURNING id`,
          [
            alert.alertId,
            alert.eventId,
            alert.profileId,
            alert.type,
            alert.strategy,
            alert.strategyVersion,
            alert.configVersion,
            alert.timestamp,
            alert.previousState,
            alert.state,
            alert.score,
            alert.title,
            alert.message,
            JSON.stringify(alert.reasonCodes),
            JSON.stringify(alert),
            alert.setupInstanceId,
            alert.deduplicationKey ??
              alertDeduplicationKey(
                alert.type,
                alert.setupInstanceId,
                alert.eventId,
              ),
          ],
        );
        if (result.rowCount === 1) saved.push(alert);
        else {
          const source = await client.query(
            "SELECT 1 FROM strategy_state_event WHERE id=$1",
            [alert.eventId],
          );
          if (source.rowCount !== 1)
            throw new Error(
              `Source strategy event ${alert.eventId} was not persisted`,
            );
        }
      }
      await client.query("COMMIT");
      return saved;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listRecent(limit = 200): Promise<ScannerAlert[]> {
    const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    const result = await this.pool.query<{ payload: unknown }>(
      "SELECT payload FROM scanner_alert ORDER BY timestamp DESC, created_at DESC LIMIT $1",
      [safeLimit],
    );
    return result.rows.map((row) => scannerAlertSchema.parse(row.payload));
  }

  async loadPolicy(): Promise<AlertPolicy> {
    const result = await this.pool.query<{
      cooldown_minutes: number;
      rearm_rule: string;
      context_notifications_enabled: boolean;
    }>(
      "SELECT cooldown_minutes,rearm_rule,context_notifications_enabled FROM scanner_alert_policy WHERE singleton=TRUE",
    );
    return alertPolicySchema.parse({
      cooldownMinutes: result.rows[0]?.cooldown_minutes,
      rearmRule: result.rows[0]?.rearm_rule,
      contextNotificationsEnabled:
        result.rows[0]?.context_notifications_enabled,
    });
  }

  async savePolicy(policy: AlertPolicy): Promise<AlertPolicy> {
    const parsed = alertPolicySchema.parse(policy);
    await this.pool.query(
      `INSERT INTO scanner_alert_policy(singleton,cooldown_minutes,rearm_rule,context_notifications_enabled,updated_at)
       VALUES(TRUE,$1,$2,$3,NOW()) ON CONFLICT(singleton) DO UPDATE SET
       cooldown_minutes=EXCLUDED.cooldown_minutes,rearm_rule=EXCLUDED.rearm_rule,
       context_notifications_enabled=EXCLUDED.context_notifications_enabled,updated_at=NOW()`,
      [
        parsed.cooldownMinutes,
        parsed.rearmRule,
        parsed.contextNotificationsEnabled,
      ],
    );
    return parsed;
  }
}
