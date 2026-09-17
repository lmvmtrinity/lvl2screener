import {
  executionDiagnosticReportSchema,
  type ExecutionDiagnosticReport,
} from "@tsx-scanner/contracts";
import type { Pool } from "pg";
import { canonicalJson, contentHash } from "../backtests/research-coverage.js";

export type ExecutionDiagnosticIdentity = {
  runId: string;
  accountId: string;
  marketId: "CA_TSX" | "US_EQUITIES";
  currency: "CAD" | "USD";
  temporalScope: "RUN_END" | "AS_OF" | "CURRENT_ACCOUNT";
  asOf: string;
  reportVersion: string;
  sourceDigest: string;
};

export type StoredExecutionDiagnosticReport = {
  id: string;
  identity: ExecutionDiagnosticIdentity;
  report: ExecutionDiagnosticReport;
  createdAt: string;
};

type ReportRow = {
  id: string;
  run_id: string;
  account_id: string;
  market_id: "CA_TSX" | "US_EQUITIES";
  currency: "CAD" | "USD";
  temporal_scope: ExecutionDiagnosticIdentity["temporalScope"];
  as_of: Date | string;
  report_version: string;
  source_digest: string;
  identity_hash: string;
  report: unknown;
  created_at: Date | string;
};

const columns = `id,run_id,account_id,market_id,currency,temporal_scope,as_of,
  report_version,source_digest,identity_hash,report,created_at`;

export function executionDiagnosticIdentityHash(
  identity: ExecutionDiagnosticIdentity,
): string {
  return contentHash(identity);
}

function iso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function mapRow(row: ReportRow): StoredExecutionDiagnosticReport {
  return {
    id: row.id,
    identity: {
      runId: row.run_id,
      accountId: row.account_id,
      marketId: row.market_id,
      currency: row.currency,
      temporalScope: row.temporal_scope,
      asOf: iso(row.as_of),
      reportVersion: row.report_version,
      sourceDigest: row.source_digest,
    },
    report: executionDiagnosticReportSchema.parse(row.report),
    createdAt: iso(row.created_at),
  };
}

function sameIdentity(
  left: ExecutionDiagnosticIdentity,
  right: ExecutionDiagnosticIdentity,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export class ExecutionDiagnosticReportRepository {
  constructor(private readonly pool: Pool) {}

  async save(
    identity: ExecutionDiagnosticIdentity,
    report: ExecutionDiagnosticReport,
  ): Promise<StoredExecutionDiagnosticReport> {
    const parsed = executionDiagnosticReportSchema.parse(report);
    if (parsed.sourceDigest !== identity.sourceDigest)
      throw new Error("EXECUTION_DIAGNOSTIC_SOURCE_DIGEST_MISMATCH");
    if (parsed.scope.selectedRunId !== identity.runId)
      throw new Error("EXECUTION_DIAGNOSTIC_RUN_MISMATCH");
    if (
      parsed.scope.accountId !== identity.accountId ||
      parsed.scope.marketId !== identity.marketId ||
      parsed.scope.currency !== identity.currency ||
      parsed.scope.temporalScope !== identity.temporalScope ||
      parsed.scope.asOf !== identity.asOf ||
      parsed.reportVersion !== identity.reportVersion
    )
      throw new Error("EXECUTION_DIAGNOSTIC_IDENTITY_CONFLICT");
    const identityHash = executionDiagnosticIdentityHash(identity);
    const inserted = await this.pool.query<ReportRow>(
      `INSERT INTO execution_diagnostic_report
         (run_id,account_id,market_id,currency,temporal_scope,as_of,
          report_version,source_digest,identity_hash,report)
       VALUES ($1,$2,$3,$4,$5,$6::timestamptz,$7,$8,$9,$10::jsonb)
       ON CONFLICT (identity_hash) DO NOTHING
       RETURNING ${columns}`,
      [
        identity.runId,
        identity.accountId,
        identity.marketId,
        identity.currency,
        identity.temporalScope,
        identity.asOf,
        identity.reportVersion,
        identity.sourceDigest,
        identityHash,
        JSON.stringify(parsed),
      ],
    );
    if (inserted.rows[0]) return mapRow(inserted.rows[0]);

    const existing = await this.pool.query<ReportRow>(
      `SELECT ${columns} FROM execution_diagnostic_report WHERE identity_hash=$1`,
      [identityHash],
    );
    const row = existing.rows[0];
    if (!row) throw new Error("EXECUTION_DIAGNOSTIC_IDENTITY_RACE");
    const stored = mapRow(row);
    if (!sameIdentity(stored.identity, identity))
      throw new Error("EXECUTION_DIAGNOSTIC_IDENTITY_CONFLICT");
    return stored;
  }

  async findByIdentity(
    identity: ExecutionDiagnosticIdentity,
  ): Promise<StoredExecutionDiagnosticReport | undefined> {
    const result = await this.pool.query<ReportRow>(
      `SELECT ${columns} FROM execution_diagnostic_report WHERE identity_hash=$1`,
      [executionDiagnosticIdentityHash(identity)],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }

  async findLatest(
    runId: string,
    temporalScope: ExecutionDiagnosticIdentity["temporalScope"],
    asOf?: string,
    reportVersion?: string,
  ): Promise<StoredExecutionDiagnosticReport | undefined> {
    const result = await this.pool.query<ReportRow>(
      `SELECT ${columns}
         FROM execution_diagnostic_report
        WHERE run_id=$1 AND temporal_scope=$2
          AND ($3::timestamptz IS NULL OR as_of=$3::timestamptz)
          AND ($4::text IS NULL OR report_version=$4)
        ORDER BY created_at DESC, id DESC LIMIT 1`,
      [runId, temporalScope, asOf ?? null, reportVersion ?? null],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }

  async findDiagnosticsJob(
    runId: string,
    reportVersion = "execution-diagnostics-v2",
  ): Promise<{ id: string; status: string } | undefined> {
    const result = await this.pool.query<{ id: string; status: string }>(
      `SELECT id,status FROM research_job
        WHERE job_type='EXECUTION_DIAGNOSTICS'
          AND request_payload->>'runId'=$1
          AND request_payload->>'reportVersion'=$2
        ORDER BY created_at DESC, id DESC LIMIT 1`,
      [runId, reportVersion],
    );
    return result.rows[0];
  }
}
