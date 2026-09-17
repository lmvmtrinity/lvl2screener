import type {
  ChallengerAcceptancePlan,
  ChallengerBaselineRecord,
  ChallengerConditionDefinition,
  ChallengerScope,
} from "@tsx-scanner/contracts";
import {
  challengerBaselineRecordSchema,
  challengerAcceptancePlanSchema,
  challengerConditionDefinitionSchema,
} from "@tsx-scanner/contracts";
import type { Pool, PoolClient } from "pg";
import { canonicalJson, contentHash } from "../backtests/research-coverage.js";

export type ChallengerAcceptanceRecords = {
  baseline: ChallengerBaselineRecord;
  acceptancePlan: ChallengerAcceptancePlan;
  conditionDefinition: ChallengerConditionDefinition;
};

/** Immutable C02 records are written by the same transaction as enrollment. */
export class PostgresChallengerAcceptanceRepository {
  constructor(private readonly client: Pool | PoolClient) {}

  async persist(
    _modelId: string,
    scope: ChallengerScope,
    records: ChallengerAcceptanceRecords,
  ): Promise<void> {
    await this.insertRecord(
      "challenger_baseline_record",
      contentHash(records.baseline),
      records.baseline,
      scope.marketId,
    );
    await this.insertRecord(
      "challenger_acceptance_plan",
      contentHash(records.acceptancePlan),
      records.acceptancePlan,
      scope.marketId,
    );
    await this.insertRecord(
      "challenger_condition_definition",
      contentHash(records.conditionDefinition),
      records.conditionDefinition,
      scope.marketId,
    );
  }

  private async insertRecord(
    table:
      | "challenger_baseline_record"
      | "challenger_acceptance_plan"
      | "challenger_condition_definition",
    identityHash: string,
    record: unknown,
    marketId: ChallengerScope["marketId"],
  ): Promise<void> {
    await this.client.query(
      `INSERT INTO ${table}(identity_hash,market_id,record)
       VALUES($1,$2,$3::jsonb) ON CONFLICT(identity_hash) DO NOTHING`,
      [identityHash, marketId, JSON.stringify(record)],
    );
    const existing = await this.client.query<{ record: unknown }>(
      `SELECT record FROM ${table} WHERE identity_hash=$1`,
      [identityHash],
    );
    if (
      !existing.rows[0] ||
      canonicalJson(existing.rows[0].record) !== canonicalJson(record)
    )
      throw new Error("EXPERIMENT_ACCEPTANCE_RECORD_CONFLICT");
  }

  async get(
    baselineHash: string,
    planHash: string,
    marketId: ChallengerScope["marketId"],
  ): Promise<ChallengerAcceptanceRecords | null> {
    const result = await this.client.query<{
      baseline: unknown;
      plan: unknown;
      conditions: unknown;
    }>(
      `SELECT b.record AS baseline,p.record AS plan,c.record AS conditions
         FROM challenger_baseline_record b
         JOIN challenger_acceptance_plan p ON p.identity_hash=$2 AND p.market_id=b.market_id
         JOIN challenger_condition_definition c ON c.identity_hash=p.record->>'conditionDefinitionHash' AND c.market_id=p.market_id
        WHERE b.identity_hash=$1 AND b.market_id=$3
          AND b.created_at<=clock_timestamp() AND p.created_at<=clock_timestamp() AND c.created_at<=clock_timestamp()`,
      [baselineHash, planHash, marketId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      baseline: challengerBaselineRecordSchema.parse(row.baseline),
      acceptancePlan: challengerAcceptancePlanSchema.parse(row.plan),
      conditionDefinition: challengerConditionDefinitionSchema.parse(
        row.conditions,
      ),
    };
  }
}
