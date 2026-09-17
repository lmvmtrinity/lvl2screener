import {
  researchCoverageReportSchema,
  researchEvidenceBindingSchema,
  researchOwnerSchema,
  type ResearchCoverageReport,
  type ResearchEvidenceBinding,
  type ResearchOwner,
} from "@tsx-scanner/contracts";
import type { Pool, PoolClient } from "pg";
import { researchJobMarket } from "../research-jobs/research-job-market.js";
import {
  canonicalJson,
  contentHash,
  coverageReportHash,
} from "./research-coverage.js";

export type EvidenceBindingOwner = ResearchOwner;

export type ResearchManifestRecord = {
  hash: string;
  marketId: ResearchOwner["marketId"];
  manifest: unknown;
};

export interface ResearchEvidenceStore {
  saveManifest(record: ResearchManifestRecord): Promise<string>;
  getManifest(hash: string): Promise<ResearchManifestRecord | null>;
  saveReport(report: ResearchCoverageReport): Promise<string>;
  getReport(hash: string): Promise<ResearchCoverageReport | null>;
  bind(owner: ResearchOwner, binding: ResearchEvidenceBinding): Promise<void>;
  bindWithClient?(
    client: PoolClient,
    owner: ResearchOwner,
    binding: ResearchEvidenceBinding,
  ): Promise<void>;
  withTransaction?<T>(
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T>;
  getBinding(owner: ResearchOwner): Promise<ResearchEvidenceBinding | null>;
  saveSessions?(
    reportHash: string,
    sessions: Record<string, Record<string, unknown>>,
  ): Promise<void>;
}

export function assertEvidenceBinding(
  owner: EvidenceBindingOwner,
  report: ResearchCoverageReport,
  binding: ResearchEvidenceBinding,
): void {
  researchOwnerSchema.parse(owner);
  researchEvidenceBindingSchema.parse(binding);
  if (report.status !== "VERIFIED")
    throw new Error("EVIDENCE_REPORT_NOT_VERIFIED");
  if (owner.marketId !== report.marketId)
    throw new Error("EVIDENCE_MARKET_MISMATCH");
  if (binding.manifestHash !== report.manifestHash)
    throw new Error("EVIDENCE_MANIFEST_MISMATCH");
  if (binding.coverageReportHash !== coverageReportHash(report))
    throw new Error("EVIDENCE_REPORT_HASH_MISMATCH");
  if (binding.inputHash !== report.inputHash)
    throw new Error("EVIDENCE_INPUT_MISMATCH");
  if (binding.verifiedAt !== report.verifiedAt)
    throw new Error("EVIDENCE_VERIFICATION_TIME_MISMATCH");
}

type ReportRow = {
  hash: string;
  market_id: ResearchOwner["marketId"];
  input_hash: string;
  status: ResearchCoverageReport["status"];
  report: unknown;
};
type ManifestRow = {
  hash: string;
  market_id: ResearchOwner["marketId"];
  manifest: unknown;
};
type BindingRow = { binding: unknown };
type OwnerMarketRow = { market_id: ResearchOwner["marketId"] };

export class PostgresResearchEvidenceStore implements ResearchEvidenceStore {
  constructor(private readonly pool: Pool) {}

  async saveSessions(
    reportHash: string,
    sessions: Record<string, Record<string, unknown>>,
  ): Promise<void> {
    const report = await this.getReport(reportHash);
    if (!report) throw new Error("COVERAGE_REPORT_MISSING");
    await this.withTransaction(async (client) => {
      for (const [date, payload] of Object.entries(sessions)) {
        const hash = contentHash({ date, payload });
        if (report.sessionPayloadHashes[date] !== hash)
          throw new Error("COVERAGE_SESSION_HASH_MISMATCH");
        await client.query(
          `INSERT INTO research_coverage_session(report_hash,session_date,payload_hash,payload)
          VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(report_hash,session_date) DO NOTHING`,
          [reportHash, date, hash, JSON.stringify(payload)],
        );
        const existing = await client.query<{
          payload: unknown;
          payload_hash: string;
        }>(
          "SELECT payload,payload_hash FROM research_coverage_session WHERE report_hash=$1 AND session_date=$2",
          [reportHash, date],
        );
        if (
          existing.rows[0]?.payload_hash !== hash ||
          canonicalJson(existing.rows[0]?.payload) !== canonicalJson(payload)
        )
          throw new Error("COVERAGE_SESSION_CONFLICT");
      }
    });
  }

  async withTransaction<T>(
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const value = await operation(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async saveManifest(record: ResearchManifestRecord): Promise<string> {
    validateHash(record.hash, "manifest");
    if (record.marketId !== "CA_TSX" && record.marketId !== "US_EQUITIES")
      throw new Error("INVALID_MANIFEST_MARKET");
    const inserted = await this.pool.query<ManifestRow>(
      `INSERT INTO research_manifest(hash,market_id,manifest)
       VALUES($1,$2,$3::jsonb)
       ON CONFLICT(hash) DO NOTHING
       RETURNING hash,market_id,manifest`,
      [record.hash, record.marketId, JSON.stringify(record.manifest)],
    );
    if (inserted.rows[0]) return inserted.rows[0].hash;
    const existing = await this.pool.query<ManifestRow>(
      "SELECT hash,market_id,manifest FROM research_manifest WHERE hash=$1",
      [record.hash],
    );
    const row = existing.rows[0];
    if (!row) throw new Error("RESEARCH_MANIFEST_SAVE_RACE");
    if (
      row.market_id !== record.marketId ||
      canonicalJson(row.manifest) !== canonicalJson(record.manifest)
    )
      throw new Error("EVIDENCE_MANIFEST_CONFLICT");
    return row.hash;
  }

  async getManifest(hash: string): Promise<ResearchManifestRecord | null> {
    validateHash(hash, "manifest");
    const result = await this.pool.query<ManifestRow>(
      "SELECT hash,market_id,manifest FROM research_manifest WHERE hash=$1",
      [hash],
    );
    const row = result.rows[0];
    return row
      ? { hash: row.hash, marketId: row.market_id, manifest: row.manifest }
      : null;
  }

  async saveReport(report: ResearchCoverageReport): Promise<string> {
    const parsed = researchCoverageReportSchema.parse(report);
    const hash = coverageReportHash(parsed);
    const inserted = await this.pool.query<ReportRow>(
      `INSERT INTO research_coverage_report(hash,market_id,input_hash,status,report)
       VALUES($1,$2,$3,$4,$5::jsonb)
       ON CONFLICT(hash) DO NOTHING
       RETURNING hash,market_id,input_hash,status,report`,
      [
        hash,
        parsed.marketId,
        parsed.inputHash,
        parsed.status,
        JSON.stringify(parsed),
      ],
    );
    if (inserted.rows[0]) return hash;
    const existing = await this.pool.query<ReportRow>(
      `SELECT hash,market_id,input_hash,status,report
         FROM research_coverage_report WHERE hash=$1`,
      [hash],
    );
    const row = existing.rows[0];
    if (!row) throw new Error("RESEARCH_REPORT_SAVE_RACE");
    const existingReport = researchCoverageReportSchema.parse(row.report);
    if (
      row.market_id !== parsed.marketId ||
      row.input_hash !== parsed.inputHash ||
      canonicalReport(existingReport) !== canonicalReport(parsed)
    )
      throw new Error("EVIDENCE_REPORT_CONFLICT");
    return row.hash;
  }

  async getReport(hash: string): Promise<ResearchCoverageReport | null> {
    validateHash(hash, "coverage report");
    const result = await this.pool.query<ReportRow>(
      `SELECT hash,market_id,input_hash,status,report
         FROM research_coverage_report WHERE hash=$1`,
      [hash],
    );
    return result.rows[0]
      ? researchCoverageReportSchema.parse(result.rows[0].report)
      : null;
  }

  async bind(
    owner: ResearchOwner,
    binding: ResearchEvidenceBinding,
  ): Promise<void> {
    await this.withTransaction((client) =>
      this.bindWithClient(client, owner, binding),
    );
  }

  /** Perform the binding against a caller-owned transaction. This deliberately
   * does not begin or commit: job ownership and artifact attachment can use the
   * same short database transaction. */
  async bindWithClient(
    client: PoolClient,
    owner: ResearchOwner,
    binding: ResearchEvidenceBinding,
  ): Promise<void> {
    researchOwnerSchema.parse(owner);
    const parsedBinding = researchEvidenceBindingSchema.parse(binding);
    const ownerMarket = await lockOwner(client, owner);
    if (!ownerMarket) throw new Error("EVIDENCE_OWNER_NOT_FOUND");
    if (ownerMarket.market_id !== owner.marketId)
      throw new Error("EVIDENCE_MARKET_MISMATCH");
    const table = {
      JOB: "research_job",
      BACKTEST: "backtest_run",
      CALIBRATION: "calibration_run",
      DATASET: "statistical_training_dataset",
      MODEL: "statistical_model",
    }[owner.kind];
    const column = await client.query<{ research_evidence: unknown }>(
      `SELECT research_evidence FROM ${table} WHERE id=$1 FOR UPDATE`,
      [owner.id],
    );
    if (column.rows[0]?.research_evidence == null) {
      // Immutable datasets must receive lineage when created, never by backfill.
      if (owner.kind === "DATASET")
        throw new Error("EVIDENCE_DATASET_BINDING_REQUIRED_AT_CREATION");
      await client.query(
        `UPDATE ${table} SET research_evidence=$2::jsonb WHERE id=$1`,
        [owner.id, JSON.stringify(parsedBinding)],
      );
    } else if (
      canonicalJson(column.rows[0].research_evidence) !==
      canonicalJson(parsedBinding)
    ) {
      throw new Error("EVIDENCE_BINDING_CONFLICT");
    }
    const priorBinding = await client.query<BindingRow>(
      `SELECT binding FROM research_evidence_binding
        WHERE owner_kind=$1 AND owner_id=$2 FOR SHARE`,
      [owner.kind, owner.id],
    );
    if (priorBinding.rows[0]) {
      const saved = researchEvidenceBindingSchema.parse(
        priorBinding.rows[0].binding,
      );
      if (canonicalJson(saved) !== canonicalJson(parsedBinding))
        throw new Error("EVIDENCE_BINDING_CONFLICT");
      return;
    }
    const reportRow = await client.query<ReportRow>(
      `SELECT hash,market_id,input_hash,status,report
         FROM research_coverage_report WHERE hash=$1 FOR SHARE`,
      [parsedBinding.coverageReportHash],
    );
    const report = reportRow.rows[0]
      ? researchCoverageReportSchema.parse(reportRow.rows[0].report)
      : null;
    if (!report) throw new Error("EVIDENCE_REPORT_NOT_FOUND");
    const manifest = await client.query<ManifestRow>(
      "SELECT hash,market_id,manifest FROM research_manifest WHERE hash=$1 FOR SHARE",
      [parsedBinding.manifestHash],
    );
    if (!manifest.rows[0]) throw new Error("EVIDENCE_MANIFEST_NOT_FOUND");
    if (manifest.rows[0].market_id !== owner.marketId)
      throw new Error("EVIDENCE_MANIFEST_MARKET_MISMATCH");
    assertEvidenceBinding(owner, report, parsedBinding);
    await client.query(
      `INSERT INTO research_evidence_binding(
         owner_kind,owner_id,market_id,manifest_hash,coverage_report_hash,input_hash,binding
       ) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)
       ON CONFLICT(owner_kind,owner_id) DO NOTHING`,
      [
        owner.kind,
        owner.id,
        owner.marketId,
        parsedBinding.manifestHash,
        parsedBinding.coverageReportHash,
        parsedBinding.inputHash,
        JSON.stringify(parsedBinding),
      ],
    );
    const existing = await client.query<BindingRow>(
      `SELECT binding FROM research_evidence_binding
        WHERE owner_kind=$1 AND owner_id=$2`,
      [owner.kind, owner.id],
    );
    const saved = existing.rows[0]
      ? researchEvidenceBindingSchema.parse(existing.rows[0].binding)
      : null;
    if (!saved) throw new Error("EVIDENCE_BINDING_SAVE_FAILED");
    if (canonicalJson(saved) !== canonicalJson(parsedBinding))
      throw new Error("EVIDENCE_BINDING_CONFLICT");
  }

  async getBinding(
    owner: ResearchOwner,
  ): Promise<ResearchEvidenceBinding | null> {
    researchOwnerSchema.parse(owner);
    const result = await this.pool.query<BindingRow>(
      `SELECT binding FROM research_evidence_binding
        WHERE owner_kind=$1 AND owner_id=$2 AND market_id=$3`,
      [owner.kind, owner.id, owner.marketId],
    );
    return result.rows[0]
      ? researchEvidenceBindingSchema.parse(result.rows[0].binding)
      : null;
  }
}

async function lockOwner(
  client: PoolClient,
  owner: ResearchOwner,
): Promise<OwnerMarketRow | undefined> {
  if (owner.kind === "JOB") {
    const result = await client.query<{
      job_type: import("@tsx-scanner/contracts").ResearchJobType;
      request_payload: unknown;
    }>(
      `SELECT job_type,request_payload
         FROM research_job WHERE id=$1 FOR UPDATE`,
      [owner.id],
    );
    const row = result.rows[0];
    return row
      ? { market_id: researchJobMarket(row.job_type, row.request_payload) }
      : undefined;
  }
  const table = {
    BACKTEST: "backtest_run",
    CALIBRATION: "calibration_run",
    DATASET: "statistical_training_dataset",
    MODEL: "statistical_model",
  }[owner.kind];
  const result = await client.query<OwnerMarketRow>(
    `SELECT market_id FROM ${table} WHERE id=$1 FOR UPDATE`,
    [owner.id],
  );
  return result.rows[0];
}

function canonicalReport(report: ResearchCoverageReport): string {
  const { verifiedAt: _verifiedAt, ...content } = report;
  return canonicalJson(content);
}

function validateHash(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/.test(value))
    throw new Error(`INVALID_${label.toUpperCase().replaceAll(" ", "_")}_HASH`);
}

export { contentHash, coverageReportHash };
