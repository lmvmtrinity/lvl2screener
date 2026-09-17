import {
  executableFrozenStudyPlanSchema,
  type FrozenStudyPlan,
} from "@tsx-scanner/contracts";
import type { Pool } from "pg";
import { PostgresResearchEvidenceStore } from "./research-evidence-repository.js";
import type { ResearchRuntimeIdentityProvider } from "./research-runtime-identity.js";
import { verifyStudyProfiles } from "./study-profile-scope.js";
import { canonicalJson } from "./research-coverage.js";
export type StudyAdmission = (plan: FrozenStudyPlan) => Promise<void>;
export function createStudyAdmission(
  pool: Pool,
  identity: ResearchRuntimeIdentityProvider,
): StudyAdmission {
  return async (raw) => {
    const plan = executableFrozenStudyPlanSchema.parse(raw);
    const runtime = await identity.current();
    if (!runtime) throw new Error("RESEARCH_RUNTIME_UNAVAILABLE");
    if (
      runtime.engineRevision !== plan.binding.engineRevision ||
      runtime.runtimeFingerprint !== plan.binding.runtimeFingerprint
    )
      throw new Error("STUDY_RUNTIME_MISMATCH");
    await verifyStudyProfiles(pool, plan);
    const report = await new PostgresResearchEvidenceStore(pool).getReport(
      plan.binding.coverageReportHash,
    );
    if (
      !report ||
      report.status !== "VERIFIED" ||
      report.marketId !== plan.comparison.marketId ||
      report.inputHash !== plan.binding.inputHash ||
      report.verifiedAt !== plan.binding.verifiedAt
    )
      throw new Error("COVERAGE_NOT_VERIFIED");
    const proof = await pool.query(
      `SELECT 1 FROM research_evidence_binding
       WHERE market_id=$1 AND coverage_report_hash=$2 AND binding=$3::jsonb LIMIT 1`,
      [
        plan.comparison.marketId,
        plan.binding.coverageReportHash,
        JSON.stringify(plan.binding),
      ],
    );
    if (!proof.rows[0] || report.manifestHash !== plan.binding.manifestHash)
      throw new Error("STUDY_INPUT_BINDING_MISMATCH");
    const dates = Object.values(plan.sessionPlan.sessions).flat().sort();
    if (
      canonicalJson(Object.keys(report.sessionPayloadHashes).sort()) !==
      canonicalJson(dates)
    )
      throw new Error("STUDY_SESSION_SCOPE_MISMATCH");
  };
}
