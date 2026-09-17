import { randomUUID } from "node:crypto";
import {
  createFundedHistoricalAutomationPolicySchema,
  fundedHistoricalAutomationPolicySchema,
  fundedHistoricalAutomationScopeSchema,
  revokeFundedHistoricalAutomationPolicySchema,
  type CreateFundedHistoricalAutomationPolicy,
  type FundedHistoricalAutomationPolicy,
  type FundedHistoricalAutomationScope,
  type MarketId,
  type RevokeFundedHistoricalAutomationPolicy,
} from "@tsx-scanner/contracts";
import type { Pool } from "pg";
import { contentHash } from "../backtests/research-coverage.js";

interface PolicyRow {
  policy_id: string;
  policy_hash: string;
  market_id: MarketId;
  scope: unknown;
  max_sessions: number;
  approved_by: string;
  approval_note: string;
  approved_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  revoked_by: string | null;
  revoked_reason: string | null;
}

const policyColumns = `policy_id,policy_hash,market_id,scope,max_sessions,approved_by,
  approval_note,approved_at,expires_at,revoked_at,revoked_by,revoked_reason`;

/** True when the policy can authorize new automatic funded replay writes. */
export function fundedPolicyIsActive(
  policy: FundedHistoricalAutomationPolicy,
  now: Date,
): boolean {
  return (
    policy.revokedAt === null && Date.parse(policy.expiresAt) > now.getTime()
  );
}

/**
 * A3 policy store. Approval and revocation are the only mutations; the frozen
 * fields (market, scope, bounds, approver, note, expiry) are hashed and never
 * rewritten. A policy never names a live funded account: the dedicated replay
 * account id is derived from `policyHash` at dispatch time.
 */
export class FundedHistoricalAutomationService {
  constructor(
    private readonly pool: Pool,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async requestPolicy(
    raw: CreateFundedHistoricalAutomationPolicy,
  ): Promise<FundedHistoricalAutomationPolicy> {
    const input = createFundedHistoricalAutomationPolicySchema.parse(raw);
    const now = this.clock();
    if (Date.parse(input.expiresAt) <= now.getTime())
      throw new Error("FUNDED_POLICY_EXPIRY_MUST_BE_FUTURE");
    const policyId = randomUUID();
    const policyHash = contentHash({
      version: "funded-historical-automation-policy-v1",
      marketId: input.marketId,
      scope: input.scope,
      maxSessions: input.maxSessions,
      approvedBy: input.approvedBy,
      approvalNote: input.approvalNote,
      expiresAt: input.expiresAt,
    });
    const inserted = await this.pool.query<PolicyRow>(
      `INSERT INTO funded_historical_automation_policy
         (policy_id,policy_hash,market_id,scope,max_sessions,approved_by,approval_note,
          approved_at,expires_at)
       VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9)
       ON CONFLICT (policy_hash) DO NOTHING
       RETURNING ${policyColumns}`,
      [
        policyId,
        policyHash,
        input.marketId,
        JSON.stringify(input.scope),
        input.maxSessions,
        input.approvedBy,
        input.approvalNote,
        now.toISOString(),
        input.expiresAt,
      ],
    );
    if (inserted.rows[0]) return mapPolicy(inserted.rows[0]);
    const existing = await this.pool.query<PolicyRow>(
      `SELECT ${policyColumns} FROM funded_historical_automation_policy WHERE policy_hash=$1`,
      [policyHash],
    );
    if (!existing.rows[0]) throw new Error("FUNDED_POLICY_SAVE_RACE");
    return mapPolicy(existing.rows[0]);
  }

  async revokePolicy(
    policyId: string,
    raw: RevokeFundedHistoricalAutomationPolicy,
  ): Promise<FundedHistoricalAutomationPolicy | null> {
    const input = revokeFundedHistoricalAutomationPolicySchema.parse(raw);
    const result = await this.pool.query<PolicyRow>(
      `UPDATE funded_historical_automation_policy
          SET revoked_at=$2,revoked_by=$3,revoked_reason=$4
        WHERE policy_id=$1 AND revoked_at IS NULL
        RETURNING ${policyColumns}`,
      [policyId, this.clock().toISOString(), input.revokedBy, input.reason],
    );
    if (result.rows[0]) return mapPolicy(result.rows[0]);
    return this.getPolicy(policyId);
  }

  async getPolicy(
    policyId: string,
  ): Promise<FundedHistoricalAutomationPolicy | null> {
    const result = await this.pool.query<PolicyRow>(
      `SELECT ${policyColumns} FROM funded_historical_automation_policy WHERE policy_id=$1`,
      [policyId],
    );
    return result.rows[0] ? mapPolicy(result.rows[0]) : null;
  }

  async listPolicies(
    marketId: MarketId,
  ): Promise<FundedHistoricalAutomationPolicy[]> {
    const result = await this.pool.query<PolicyRow>(
      `SELECT ${policyColumns} FROM funded_historical_automation_policy
        WHERE market_id=$1 ORDER BY approved_at DESC LIMIT 200`,
      [marketId],
    );
    return result.rows.map(mapPolicy);
  }

  /** The newest active policy for one immutable experiment scope, if any. */
  async activePolicyFor(
    marketId: MarketId,
    scope: FundedHistoricalAutomationScope,
  ): Promise<FundedHistoricalAutomationPolicy | null> {
    const result = await this.pool.query<PolicyRow>(
      `SELECT ${policyColumns} FROM funded_historical_automation_policy
        WHERE market_id=$1
          AND scope->>'configId'=$2
          AND scope->>'configVersion'=$3
          AND revoked_at IS NULL
          AND expires_at > $4::timestamptz
        ORDER BY approved_at DESC LIMIT 1`,
      [
        marketId,
        scope.configId,
        scope.configVersion,
        this.clock().toISOString(),
      ],
    );
    return result.rows[0] ? mapPolicy(result.rows[0]) : null;
  }
}

function mapPolicy(row: PolicyRow): FundedHistoricalAutomationPolicy {
  return fundedHistoricalAutomationPolicySchema.parse({
    policyId: row.policy_id,
    policyHash: row.policy_hash,
    marketId: row.market_id,
    scope: fundedHistoricalAutomationScopeSchema.parse(row.scope),
    maxSessions: row.max_sessions,
    approvedBy: row.approved_by,
    approvalNote: row.approval_note,
    approvedAt: row.approved_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    revokedAt: row.revoked_at?.toISOString() ?? null,
    revokedBy: row.revoked_by,
    revokedReason: row.revoked_reason,
  });
}
