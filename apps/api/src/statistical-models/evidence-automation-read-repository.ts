import type {
  EvidenceAutomationStage,
  EvidenceAutomationState,
  MarketId,
} from "@tsx-scanner/contracts";
import type { Pool } from "pg";
import { PAPER_EVIDENCE_RESEARCH_POLICY } from "./paper-evidence-qualification.js";

export type EvidenceStageFact = {
  key: EvidenceAutomationStage["key"];
  marketId: MarketId;
  scopeId: string;
  state: EvidenceAutomationState;
  attemptedAt: string | null;
  succeededAt: string | null;
  nextCheckAt: string | null;
  progress: EvidenceAutomationStage["progress"];
  reasonCodes: string[];
  jobId: string | null;
  reportId: string | null;
};

type DatasetRow = {
  id: string;
  created_at: Date;
  source_row_count: number;
  research_qualification: unknown;
};

type CoverageRow = {
  request_id: string;
  job_id: string;
  report_hash: string | null;
  coverage_status: "VERIFIED" | "INCOMPLETE" | "UNKNOWN" | null;
  job_status:
    | "QUEUED"
    | "RUNNING"
    | "CANCELLING"
    | "SUCCEEDED"
    | "FAILED"
    | "CANCELLED"
    | "INTERRUPTED";
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  progress: unknown;
  error: string | null;
  error_category: string | null;
};

type JobRow = {
  id: string;
  status:
    | EvidenceAutomationState
    | "CANCELLING"
    | "QUEUED"
    | "RUNNING"
    | "SUCCEEDED"
    | "FAILED"
    | "CANCELLED"
    | "INTERRUPTED";
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  result_ref_id: string | null;
  progress: unknown;
  error: string | null;
  error_category: string | null;
};

type ForwardRow = {
  id: string;
  state: "REGISTERED" | "ACTIVE" | "PAUSED" | "ENDED" | "REVOKED";
  starts_at: Date;
  ends_at: Date;
  registered_at: Date;
  attempt_at: Date | null;
  success_at: Date | null;
};

/** Read-only projection of learning stages whose durable owners are not
 * evidence-work receipts. It never creates or updates a status record. */
export class PostgresEvidenceAutomationReadRepository {
  constructor(private readonly pool: Pool) {}

  async artifact(
    kind: string,
    id: string,
    marketId: MarketId,
  ): Promise<unknown | undefined> {
    const queries: Record<string, string> = {
      COVERAGE:
        "SELECT report AS payload FROM research_coverage_report WHERE hash=$1 AND market_id=$2",
      DIAGNOSTICS:
        "SELECT jsonb_build_object('reportId',id,'runId',run_id,'accountId',account_id,'marketId',market_id,'reportVersion',report_version,'legacyCalculation',report_version<>'execution-diagnostics-v2','report',report) AS payload FROM execution_diagnostic_report WHERE id::text=$1 AND market_id=$2",
      TRAINING:
        "SELECT jsonb_build_object('id',id,'marketId',market_id,'name',name,'status',status,'active',active,'artifact',artifact) AS payload FROM statistical_model WHERE id::text=$1 AND market_id=$2",
      QUALIFICATION: `SELECT jsonb_build_object('datasetId',id,'marketId',market_id,'createdAt',created_at,'sourceRowCount',source_row_count,'qualification',research_qualification,'cohort',cohort) AS payload FROM statistical_training_dataset WHERE id::text=$1 AND market_id=$2
        UNION ALL SELECT jsonb_build_object('auditId',a.id,'startedAt',a.started_at,'completedAt',a.completed_at,'state',a.state,'cohorts',jsonb_agg(c.value),'error',a.error) FROM learning_automation_run a CROSS JOIN LATERAL jsonb_array_elements(a.cohorts_examined) c(value) WHERE a.id::text=$1 AND COALESCE(c.value->>'marketId',c.value#>>'{cohort,marketId}')=$2 GROUP BY a.id`,
      STUDY:
        "SELECT jsonb_build_object('studyId',s.id,'marketId',s.market_id,'plan',s.spec,'receipts',(SELECT jsonb_agg(jsonb_build_object('stage',r.receipt_key,'result',r.payload)) FROM strategy_study_receipt r WHERE r.study_id=s.id)) AS payload FROM strategy_study s WHERE s.id::text=$1 AND s.market_id=$2",
      FORWARD_OBSERVATION:
        "SELECT jsonb_build_object('experimentId',e.id,'marketId',e.market_id,'scope',e.scope,'startsAt',e.starts_at,'endsAt',e.ends_at,'outcomes',(SELECT jsonb_agg(o.outcome) FROM challenger_outcome o WHERE o.experiment_id=e.id)) AS payload FROM challenger_experiment e WHERE e.id::text=$1 AND e.market_id=$2",
    };
    const query = queries[kind];
    if (!query) return undefined;
    return (await this.pool.query<{ payload: unknown }>(query, [id, marketId]))
      .rows[0]?.payload;
  }

  async listStageFacts(marketId: MarketId): Promise<EvidenceStageFact[]> {
    const [coverage, qualification, training, forward, audits] =
      await Promise.all([
        this.coverage(marketId),
        this.qualification(marketId),
        this.training(marketId),
        this.forwardObservation(marketId),
        this.qualificationAudits(marketId),
      ]);
    return [...coverage, ...qualification, ...training, ...forward, ...audits];
  }

  private async coverage(marketId: MarketId): Promise<EvidenceStageFact[]> {
    const result = await this.pool.query<CoverageRow>(
      `SELECT COALESCE(r.request_id::text,j.request_payload->>'requestId',j.id::text) AS request_id,j.id AS job_id,r.report_hash,r.status AS coverage_status,
              j.status AS job_status,j.created_at,j.started_at,j.completed_at,
              j.progress,j.error,j.error_category
         FROM research_job j
         LEFT JOIN research_coverage_request_result r ON r.job_id=j.id
         LEFT JOIN research_coverage_request q ON q.id::text=j.request_payload->>'requestId'
        WHERE j.job_type='COVERAGE_VERIFICATION'
          AND COALESCE(q.market_id,j.request_payload#>>'{request,recipe,marketId}',j.request_payload#>>'{request,marketId}')=$1
        ORDER BY j.created_at DESC,j.id DESC`,
      [marketId],
    );
    return result.rows.map((row): EvidenceStageFact => {
      const jobState = jobStateForCoverage(row.job_status);
      const completed = row.job_status === "SUCCEEDED";
      const verified = completed && row.coverage_status === "VERIFIED";
      return {
        key: "COVERAGE",
        marketId,
        scopeId: row.request_id,
        state: verified ? "SUCCEEDED" : completed ? "UNKNOWN" : jobState,
        attemptedAt: (row.started_at ?? row.created_at).toISOString(),
        succeededAt: verified
          ? (row.completed_at?.toISOString() ?? null)
          : null,
        nextCheckAt: null,
        progress: progressValue(row.progress),
        reasonCodes: row.error
          ? [row.error_category ?? "RESEARCH_JOB_FAILED"]
          : verified
            ? []
            : [
                row.coverage_status
                  ? `COVERAGE_${row.coverage_status}`
                  : "COVERAGE_RESULT_UNAVAILABLE",
              ],
        jobId: row.job_id,
        reportId: row.report_hash,
      };
    });
  }

  private async qualificationAudits(
    marketId: MarketId,
  ): Promise<EvidenceStageFact[]> {
    const result = await this.pool.query<{
      id: string;
      started_at: Date;
      completed_at: Date;
      state: string;
      cohort: unknown;
      created_dataset_id: string | null;
      error: string | null;
    }>(
      `SELECT a.id,a.started_at,a.completed_at,a.state,c.value AS cohort,a.created_dataset_id,a.error
       FROM learning_automation_run a CROSS JOIN LATERAL jsonb_array_elements(a.cohorts_examined) c(value)
       WHERE COALESCE(c.value->>'marketId',c.value#>>'{cohort,marketId}')=$1
       ORDER BY a.started_at DESC,a.id DESC,
         COALESCE(NULLIF(c.value->>'closedQuoteCount','')::int,0) DESC,
         c.value->>'strategy' ASC`,
      [marketId],
    );
    return result.rows.map((row) => {
      const cohort = object(row.cohort);
      const qualified = cohort?.status === "JOB_QUEUED";
      const reason =
        typeof cohort?.reason === "string" ? cohort.reason : row.error;
      const closedQuoteCount = Number.parseInt(
        String(cohort?.closedQuoteCount ?? ""),
        10,
      );
      const threshold = PAPER_EVIDENCE_RESEARCH_POLICY.minimumRows;
      return {
        key: "QUALIFICATION",
        marketId,
        scopeId: row.id,
        state:
          row.state === "FAILED"
            ? "FAILED"
            : qualified
              ? "SUCCEEDED"
              : "WAITING",
        attemptedAt: row.started_at.toISOString(),
        succeededAt: qualified ? row.completed_at.toISOString() : null,
        nextCheckAt: null,
        // The leading cohort (highest closed-quote count) is ordered first, so
        // its progress is what the surface shows while accumulation continues.
        progress:
          Number.isInteger(closedQuoteCount) && closedQuoteCount > 0
            ? {
                completed: Math.min(closedQuoteCount, threshold),
                total: threshold,
                unit: "closed quotes",
              }
            : null,
        reasonCodes: reason
          ? [reason.slice(0, 120)]
          : qualified
            ? []
            : ["QUALIFICATION_NOT_MET"],
        jobId: null,
        reportId: row.id,
      };
    });
  }

  private async qualification(
    marketId: MarketId,
  ): Promise<EvidenceStageFact[]> {
    const result = await this.pool.query<DatasetRow>(
      `SELECT id,created_at,source_row_count,research_qualification
         FROM statistical_training_dataset
        WHERE market_id=$1 AND source_kind='PAPER_EVIDENCE'
        ORDER BY created_at DESC,id DESC`,
      [marketId],
    );
    return result.rows.map((row): EvidenceStageFact => {
      const qualification = object(row.research_qualification);
      const qualified = qualification?.qualified === true;
      const reasons = arrayOfStrings(qualification?.reasons);
      const total = Number.isSafeInteger(row.source_row_count)
        ? row.source_row_count
        : 0;
      return {
        key: "QUALIFICATION",
        marketId,
        scopeId: row.id,
        state: qualified ? "SUCCEEDED" : "WAITING",
        attemptedAt: row.created_at.toISOString(),
        succeededAt: qualified ? row.created_at.toISOString() : null,
        nextCheckAt: null,
        progress:
          total > 0
            ? {
                completed: total,
                total,
                unit: "retained dataset rows",
              }
            : null,
        reasonCodes: qualified
          ? []
          : reasons.length
            ? reasons
            : ["QUALIFICATION_NOT_MET"],
        jobId: null,
        reportId: row.id,
      };
    });
  }

  private async training(marketId: MarketId): Promise<EvidenceStageFact[]> {
    const result = await this.pool.query<JobRow>(
      `SELECT j.id,j.status,j.created_at,j.started_at,j.completed_at,
              j.result_ref_id,j.progress,j.error,j.error_category
         FROM research_job j
         LEFT JOIN statistical_model m ON m.id=j.result_ref_id
         LEFT JOIN statistical_training_dataset d
           ON d.id=CASE
             WHEN j.request_payload->>'trainingDatasetId' ~* '^[0-9a-f-]{36}$'
             THEN (j.request_payload->>'trainingDatasetId')::uuid END
         LEFT JOIN backtest_run b
           ON b.id=CASE
             WHEN j.request_payload->>'backtestRunId' ~* '^[0-9a-f-]{36}$'
             THEN (j.request_payload->>'backtestRunId')::uuid END
        WHERE j.job_type='STATISTICAL_TRAINING'
          AND COALESCE(m.market_id,d.market_id,b.market_id)=$1
        ORDER BY j.created_at DESC,j.id DESC`,
      [marketId],
    );
    return result.rows.map((row): EvidenceStageFact => {
      const state = jobState(row.status);
      const progress = progressValue(row.progress);
      return {
        key: "TRAINING",
        marketId,
        scopeId: row.result_ref_id ?? row.id,
        state,
        attemptedAt: (row.started_at ?? row.created_at).toISOString(),
        succeededAt:
          row.status === "SUCCEEDED"
            ? (row.completed_at?.toISOString() ?? null)
            : null,
        nextCheckAt: null,
        progress,
        reasonCodes: row.error
          ? [row.error_category ?? "RESEARCH_JOB_FAILED"]
          : [],
        jobId: row.id,
        reportId: row.result_ref_id,
      };
    });
  }

  private async forwardObservation(
    marketId: MarketId,
  ): Promise<EvidenceStageFact[]> {
    const result = await this.pool.query<ForwardRow>(
      `SELECT e.id,
              COALESCE(t.state,'REGISTERED') AS state,
              e.starts_at,e.ends_at,e.registered_at,
              MAX(a.recorded_at) AS attempt_at,
              MAX(o.completed_at) FILTER (WHERE o.status='PREDICTED') AS success_at
         FROM challenger_experiment e
         LEFT JOIN LATERAL (
           SELECT state FROM challenger_experiment_transition
            WHERE experiment_id=e.id ORDER BY sequence DESC LIMIT 1
         ) t ON TRUE
         LEFT JOIN challenger_attempt a ON a.experiment_id=e.id
         LEFT JOIN challenger_outcome o
           ON o.experiment_id=a.experiment_id AND o.observation_id=a.observation_id
        WHERE e.market_id=$1
        GROUP BY e.id,t.state,e.starts_at,e.ends_at,e.registered_at
        ORDER BY e.registered_at DESC,e.id DESC`,
      [marketId],
    );
    return result.rows.map((row): EvidenceStageFact => {
      const state: EvidenceAutomationState =
        row.state === "ACTIVE"
          ? "RUNNING"
          : row.state === "PAUSED"
            ? "PAUSED"
            : row.state === "REVOKED"
              ? "CANCELLED"
              : row.state === "ENDED"
                ? "NO_NEW_EVIDENCE"
                : "WAITING";
      return {
        key: "FORWARD_OBSERVATION",
        marketId,
        scopeId: row.id,
        state,
        attemptedAt:
          row.attempt_at?.toISOString() ?? row.registered_at.toISOString(),
        succeededAt: row.success_at?.toISOString() ?? null,
        nextCheckAt:
          row.state === "ACTIVE"
            ? row.ends_at.toISOString()
            : row.state === "REGISTERED"
              ? row.starts_at.toISOString()
              : null,
        progress: null,
        reasonCodes:
          row.state === "REVOKED"
            ? ["EXPERIMENT_REVOKED"]
            : row.state === "ENDED"
              ? ["EXPERIMENT_ENDED"]
              : [],
        jobId: null,
        reportId: row.id,
      };
    });
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function jobState(value: JobRow["status"]): EvidenceAutomationState {
  if (value === "QUEUED") return "QUEUED";
  if (value === "RUNNING" || value === "CANCELLING") return "RUNNING";
  if (value === "SUCCEEDED") return "SUCCEEDED";
  if (value === "FAILED") return "FAILED";
  if (value === "CANCELLED") return "CANCELLED";
  if (value === "INTERRUPTED") return "INTERRUPTED";
  return "UNKNOWN";
}

function jobStateForCoverage(
  value: CoverageRow["job_status"],
): EvidenceAutomationState {
  if (value === "QUEUED") return "QUEUED";
  if (value === "RUNNING" || value === "CANCELLING") return "RUNNING";
  if (value === "FAILED") return "FAILED";
  if (value === "CANCELLED") return "CANCELLED";
  if (value === "INTERRUPTED") return "INTERRUPTED";
  return "UNKNOWN";
}

function progressValue(value: unknown): EvidenceAutomationStage["progress"] {
  const raw = object(value);
  const total = raw?.totalSessions;
  const completed = raw?.completedSessions;
  if (
    typeof total !== "number" ||
    !Number.isInteger(total) ||
    total <= 0 ||
    typeof completed !== "number" ||
    !Number.isInteger(completed) ||
    completed < 0
  )
    return null;
  return {
    completed: Math.min(completed, total),
    total,
    unit: "sessions",
  };
}
