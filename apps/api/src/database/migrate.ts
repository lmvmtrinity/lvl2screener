import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient } from "pg";
import { API_VERSION } from "../version.js";

const MIGRATIONS_DIRECTORY = fileURLToPath(
  new URL("../../../../database/init/", import.meta.url),
);
const ADVISORY_LOCK_ID = 748_203_961;
const MIGRATION_FILENAME = /^\d{3}-.+\.sql$/;

type MigrationRequirement = {
  table: string;
  columns?: readonly string[];
  indexes?: readonly string[];
  triggers?: readonly string[];
  constraint?: {
    name: string;
    definitionIncludes: string;
  };
  scheduledProcedure?: string;
  foundationVersion?: number;
};

export type Migration = {
  filename: string;
  sql: string;
  checksum: string;
  requirements?: readonly MigrationRequirement[];
  /**
   * A tightly scoped compatibility list for a migration that was accidentally
   * changed after release. This is intentionally not a general bypass: every
   * other checksum mismatch still prevents startup.
   */
  acceptedChecksums?: readonly string[];
};

export type MigrationResult = {
  applied: readonly string[];
  seeded: readonly string[];
};

export type MigrateOptions = {
  applicationVersion?: string;
  migrations?: readonly Migration[];
};

const requirements: Readonly<Record<string, readonly MigrationRequirement[]>> =
  {
    "132-funded-comparison-records.sql": [
      {
        table: "research_job",
        constraint: {
          name: "research_job_job_type_check",
          definitionIncludes: "FUNDED_COMPARISON",
        },
      },
      {
        table: "backtest_run",
        indexes: ["backtest_run_id_market_unique"],
      },
      {
        table: "funded_comparison_spec",
        columns: [
          "id",
          "market_id",
          "currency",
          "spec_version",
          "baseline_backtest_run_id",
          "baseline_config_version",
          "baseline_start_date",
          "baseline_end_date",
          "baseline_execution_model_version",
          "baseline_replay_input_digest",
          "baseline_result_digest",
          "baseline_completed_at",
          "champion_policy_digest",
          "champion_source_run_id",
          "champion_source_account_id",
          "champion_execution_model_version",
          "champion_account_assumption_digest",
          "challenger_model_id",
          "challenger_model_version",
          "challenger_model_type",
          "challenger_artifact_digest",
          "challenger_feature_version",
          "challenger_cohort_digest",
          "challenger_policy_digest",
          "initial_cash",
          "daily_loss_limit",
          "risk_configuration_digest",
          "evidence_cutoff_at",
          "specification_frozen_at",
          "comparison_spec_digest",
          "specification",
          "created_at",
        ],
        indexes: [
          "funded_comparison_spec_id_market_unique",
          "funded_comparison_spec_id_market_currency_unique",
          "funded_comparison_spec_market_idx",
        ],
        triggers: ["funded_comparison_spec_immutable"],
        constraint: {
          name: "funded_comparison_spec_market_currency_check",
          definitionIncludes: "market_id",
        },
      },
      {
        table: "funded_comparison_spec_session",
        columns: [
          "spec_id",
          "session_date",
          "ordinal",
          "session_start_at",
          "scheduled_close_at",
          "session_timezone",
          "item_count",
          "chunk_count",
          "session_input_digest",
          "created_at",
        ],
        triggers: ["funded_comparison_spec_session_immutable"],
        constraint: {
          name: "funded_comparison_spec_session_window_check",
          definitionIncludes: "scheduled_close_at",
        },
      },
      {
        table: "funded_comparison_spec_opportunity",
        columns: [
          "spec_id",
          "source_opportunity_id",
          "session_date",
          "ordinal",
          "source_event_id",
          "setup_instance_id",
          "instrument_id",
          "profile_config_id",
          "signal_timestamp",
          "source_content_digest",
          "created_at",
        ],
        triggers: ["funded_comparison_spec_opportunity_immutable"],
      },
      {
        table: "funded_comparison_spec_opportunity",
        constraint: {
          name: "funded_comparison_spec_opportunity_session_unique",
          definitionIncludes: "session_date",
        },
      },
      {
        table: "funded_comparison_input_chunk",
        columns: [
          "spec_id",
          "session_date",
          "chunk_ordinal",
          "item_count",
          "first_effective_at",
          "last_effective_at",
          "chunk_digest",
          "payload",
          "created_at",
        ],
        triggers: ["funded_comparison_input_chunk_immutable"],
        constraint: {
          name: "funded_comparison_input_chunk_payload_check",
          definitionIncludes: "jsonb_array_length",
        },
      },
      {
        table: "funded_comparison_provisioning_intent",
        columns: [
          "spec_id",
          "side",
          "session_date",
          "account_id",
          "market_id",
          "currency",
          "policy_digest",
          "execution_model_version",
          "account_assumption_digest",
          "created_at",
        ],
        triggers: ["funded_comparison_provisioning_intent_immutable"],
        constraint: {
          name: "funded_comparison_provisioning_intent_spec_currency_fk",
          definitionIncludes: "funded_comparison_spec",
        },
      },
      {
        table: "funded_comparison_run_binding",
        columns: [
          "spec_id",
          "side",
          "session_date",
          "run_id",
          "account_id",
          "market_id",
          "currency",
          "policy_digest",
          "execution_model_version",
          "account_assumption_digest",
          "bound_at",
        ],
        triggers: ["funded_comparison_run_binding_immutable"],
        constraint: {
          name: "funded_comparison_run_binding_market_currency_check",
          definitionIncludes: "market_id",
        },
      },
      {
        table: "funded_comparison_run_binding",
        constraint: {
          name: "funded_comparison_run_binding_spec_currency_fk",
          definitionIncludes: "funded_comparison_spec",
        },
      },
      {
        table: "funded_comparison_run_binding",
        constraint: {
          name: "funded_comparison_run_binding_run_unique",
          definitionIncludes: "run_id",
        },
      },
      {
        table: "funded_comparison_run_binding",
        constraint: {
          name: "funded_comparison_run_binding_run_id_unique",
          definitionIncludes: "UNIQUE (run_id)",
        },
      },
      {
        table: "funded_comparison_policy_evaluation",
        columns: [
          "spec_id",
          "side",
          "session_date",
          "source_opportunity_id",
          "source_ordinal",
          "signal_timestamp",
          "batch_key",
          "champion_rank",
          "applied_rank",
          "destination_run_id",
          "destination_observation_id",
          "disposition",
          "fallback_reason",
          "prediction",
          "evaluation_digest",
          "created_at",
        ],
        triggers: ["funded_comparison_policy_evaluation_immutable"],
        constraint: {
          name: "funded_comparison_policy_evaluation_prediction_check",
          definitionIncludes: "FALLBACK_CHAMPION_ORDER",
        },
      },
      {
        table: "funded_comparison_policy_evaluation",
        constraint: {
          name: "funded_comparison_policy_evaluation_destination_binding_fk",
          definitionIncludes: "funded_comparison_run_binding",
        },
      },
      {
        table: "funded_comparison_policy_evaluation",
        constraint: {
          name: "funded_comparison_policy_evaluation_source_session_fk",
          definitionIncludes: "session_date",
        },
      },
      {
        table: "funded_comparison_session_metric",
        columns: [
          "spec_id",
          "side",
          "session_date",
          "market_id",
          "currency",
          "valuation",
          "valuation_reason",
          "net_return",
          "max_drawdown",
          "trade_count",
          "unrealized_position_count",
          "unresolved_order_count",
          "unresolved_reservation_count",
          "stale_mark_count",
          "valuation_point_count",
          "metric_digest",
          "created_at",
        ],
        triggers: ["funded_comparison_session_metric_immutable"],
        constraint: {
          name: "funded_comparison_session_metric_proven_check",
          definitionIncludes: "UNION_GRID_MTM",
        },
      },
      {
        table: "funded_comparison_session_metric",
        constraint: {
          name: "funded_comparison_session_metric_spec_currency_fk",
          definitionIncludes: "funded_comparison_spec",
        },
      },
      {
        table: "funded_comparison_result",
        columns: [
          "id",
          "spec_id",
          "market_id",
          "currency",
          "result_version",
          "session_count",
          "historical_volume_status",
          "champion_evaluation_digest",
          "challenger_evaluation_digest",
          "champion_metrics_digest",
          "challenger_metrics_digest",
          "result_digest",
          "result",
          "created_at",
        ],
        triggers: ["funded_comparison_result_immutable"],
        constraint: {
          name: "funded_comparison_result_market_currency_check",
          definitionIncludes: "market_id",
        },
      },
      {
        table: "funded_comparison_failure",
        columns: [
          "id",
          "spec_id",
          "attempt_id",
          "side",
          "session_date",
          "reason",
          "classification",
          "detail",
          "failure_digest",
          "recorded_at",
        ],
        indexes: ["funded_comparison_failure_spec_idx"],
        triggers: ["funded_comparison_failure_immutable"],
        constraint: {
          name: "funded_comparison_failure_resumable_check",
          definitionIncludes: "LEASE_LOST",
        },
      },
      { table: "foundation_schema_version", foundationVersion: 132 },
    ],
    "131-funded-causal-provenance.sql": [
      {
        table: "paper_funded_run",
        triggers: ["paper_funded_run_applied_sequence_counter_guard"],
      },
      {
        table: "paper_funded_fact",
        columns: ["applied_frontier_at"],
        triggers: ["paper_funded_fact_processed_guard"],
      },
      {
        table: "funded_decision_outcome",
        columns: ["source_fact_id"],
        triggers: ["funded_decision_outcome_knowledge_boundary"],
        constraint: {
          name: "funded_decision_outcome_source_fact_fk",
          definitionIncludes: "source_fact_id",
        },
      },
      { table: "paper_entry_order", columns: ["last_fact_id"] },
      { table: "paper_entry_order_history", columns: ["fact_id"] },
      {
        table: "paper_funded_event",
        columns: ["fact_run_id", "fact_id"],
        triggers: [
          "paper_funded_event_causal_identity_validate",
          "paper_funded_event_causal_identity_immutable",
        ],
        constraint: {
          name: "paper_funded_event_fact_fk",
          definitionIncludes: "fact_run_id",
        },
      },
      { table: "foundation_schema_version", foundationVersion: 131 },
    ],
    "130-funded-execution-datasets.sql": [
      {
        table: "research_job",
        constraint: {
          name: "research_job_job_type_check",
          definitionIncludes: "FUNDED_EXECUTION_TRAINING",
        },
      },
      {
        table: "paper_entry_order_history",
        columns: ["recorded_at"],
        triggers: [
          "paper_entry_order_history_immutable",
          "paper_entry_order_history_authority",
        ],
      },
      {
        table: "paper_funded_run",
        columns: ["applied_sequence_counter", "applied_frontier_at"],
        triggers: ["paper_funded_run_applied_sequence_counter_guard"],
      },
      {
        table: "paper_funded_fact",
        columns: ["applied_sequence"],
        indexes: ["paper_funded_fact_applied_sequence_uq"],
        triggers: [
          "paper_funded_fact_applied_sequence",
          "paper_funded_fact_applied_sequence_insert",
        ],
      },
      {
        table: "funded_decision_outcome",
        columns: ["knowledge_applied_sequence", "knowledge_at"],
        triggers: ["funded_decision_outcome_knowledge_boundary"],
        constraint: {
          name: "funded_decision_outcome_knowledge_pairing_check",
          definitionIncludes: "knowledge_applied_sequence",
        },
      },
      {
        table: "funded_execution_dataset",
        columns: [
          "id",
          "market_id",
          "currency",
          "source_kind",
          "evidence_schema_version",
          "cohort_digest",
          "cohort_components",
          "dataset_policy_version",
          "label_mapping_version",
          "feature_version",
          "qualification_policy_version",
          "requested_cutoff",
          "effective_cutoff",
          "membership_digest",
          "dataset_digest",
          "row_count",
          "counts",
          "qualification_receipt",
          "source_watermark",
          "activation_eligible",
          "created_at",
        ],
        indexes: ["funded_execution_dataset_cohort_idx"],
        triggers: ["funded_execution_dataset_immutable"],
        constraint: {
          name: "funded_execution_dataset_market_currency_check",
          definitionIncludes: "market_id",
        },
      },
      {
        table: "funded_execution_dataset_member",
        columns: [
          "dataset_id",
          "ordinal",
          "market_id",
          "currency",
          "run_id",
          "observation_id",
          "account_id",
          "decision_sequence",
          "decision_content_digest",
          "cohort_digest",
          "evidence_schema_version",
          "instrument_id",
          "decision_at",
          "session_date",
          "partition",
          "label_available_at",
          "label_economic_at",
          "source_kind",
          "label_mapping_version",
          "feature_version",
          "features",
          "labels",
          "outcome_sequences",
          "outcome_source_digests",
          "row_digest",
        ],
        indexes: ["funded_execution_member_partition_idx"],
        triggers: ["funded_execution_dataset_member_immutable"],
        constraint: {
          name: "funded_execution_member_outcome_pairing_check",
          definitionIncludes: "outcome_sequences",
        },
      },
      {
        table: "funded_execution_challenger",
        columns: [
          "id",
          "market_id",
          "currency",
          "cohort_digest",
          "cohort_components",
          "dataset_id",
          "dataset_digest",
          "model_version",
          "model_type",
          "artifact_digest",
          "feature_version",
          "label_mapping_version",
          "qualification_policy_version",
          "training_policy_version",
          "training_code_version",
          "runtime_fingerprint",
          "status",
          "eligible_for_activation",
          "active",
          "artifact",
          "metrics",
          "sample_counts",
          "failure_receipt",
          "created_at",
        ],
        indexes: ["funded_execution_challenger_market_idx"],
        triggers: ["funded_execution_challenger_immutable"],
        constraint: {
          name: "funded_execution_challenger_status_check",
          definitionIncludes: "failure_receipt",
        },
      },
      {
        table: "funded_execution_prediction",
        columns: [
          "id",
          "market_id",
          "currency",
          "model_id",
          "model_version",
          "model_type",
          "artifact_digest",
          "cohort_digest",
          "feature_version",
          "source_kind",
          "run_id",
          "observation_id",
          "decision_sequence",
          "decision_input_digest",
          "decision_at",
          "prediction_at",
          "deadline_at",
          "output",
          "warnings",
          "digest",
          "created_at",
        ],
        indexes: [
          "funded_execution_prediction_observation_idx",
          "funded_execution_challenger_prediction_binding_uq",
          "funded_decision_evidence_prediction_binding_uq",
        ],
        triggers: [
          "funded_execution_prediction_immutable",
          "funded_execution_prediction_authority_trigger",
        ],
        constraint: {
          name: "funded_execution_prediction_timing_check",
          definitionIncludes: "prediction_at",
        },
      },
      { table: "foundation_schema_version", foundationVersion: 130 },
    ],
    "129-funded-refusal-inbox-sidecar.sql": [
      {
        table: "paper_funded_fact",
        columns: ["refusal_request"],
        indexes: ["paper_funded_fact_refusal_request_pending_idx"],
        constraint: {
          name: "paper_funded_fact_refusal_request_check",
          definitionIncludes: "refusal_request",
        },
      },
      { table: "foundation_schema_version", foundationVersion: 129 },
    ],
    "128-funded-decision-refusal-source.sql": [
      {
        table: "funded_decision_refusal",
        columns: [
          "run_id",
          "observation_id",
          "sequence_cursor",
          "market_id",
          "currency",
          "account_id",
          "source_kind",
          "action",
          "policy_reason",
          "decision_at",
          "recorded_at",
        ],
        indexes: ["funded_decision_refusal_pending_idx"],
        triggers: ["funded_decision_refusal_immutable"],
        constraint: {
          name: "funded_decision_refusal_market_currency_check",
          definitionIncludes: "market_id",
        },
      },
      { table: "foundation_schema_version", foundationVersion: 128 },
    ],
    "127-funded-decision-intent-boundary.sql": [
      {
        table: "funded_decision_evidence",
        columns: ["evidence_schema_version"],
        indexes: ["funded_decision_evidence_run_sequence_uq"],
      },
      {
        table: "funded_decision_intent",
        columns: [
          "run_id",
          "observation_id",
          "sequence_cursor",
          "market_id",
          "currency",
          "account_id",
          "source_kind",
          "action",
          "policy_reason",
          "decision_at",
          "recorded_at",
        ],
        indexes: ["funded_decision_intent_pending_idx"],
        triggers: ["funded_decision_intent_immutable"],
        constraint: {
          name: "funded_decision_intent_reason_check",
          definitionIncludes: "policy_reason",
        },
      },
      { table: "foundation_schema_version", foundationVersion: 127 },
    ],
    "126-funded-checkpoint-rate-counters.sql": [
      {
        table: "paper_funded_account",
        columns: ["events_since_checkpoint"],
      },
      {
        table: "paper_funded_event",
        triggers: ["paper_funded_event_checkpoint_count"],
      },
      {
        table: "paper_funded_fact_rate_minute",
        columns: ["run_id", "bucket_at", "enqueued_count", "processed_count"],
        indexes: ["paper_funded_fact_rate_minute_pkey"],
      },
      {
        table: "paper_funded_fact",
        triggers: [
          "paper_funded_fact_rate_insert",
          "paper_funded_fact_rate_processed",
        ],
      },
      { table: "foundation_schema_version", foundationVersion: 126 },
    ],
    "125-funded-ledger-checkpoints.sql": [
      {
        table: "paper_funded_account",
        columns: ["checkpoint_sequence"],
      },
      {
        table: "paper_funded_ledger_checkpoint",
        columns: [
          "account_id",
          "event_sequence",
          "boundary_at",
          "kind",
          "state",
          "captured_at",
        ],
        constraint: {
          name: "paper_funded_ledger_checkpoint_kind_check",
          definitionIncludes: "RUN_START",
        },
      },
      { table: "foundation_schema_version", foundationVersion: 125 },
    ],
    "124-funded-event-order-indexes.sql": [
      {
        table: "paper_funded_event",
        indexes: [
          "paper_funded_event_account_order_idx",
          "paper_funded_event_account_position_idx",
        ],
      },
      { table: "foundation_schema_version", foundationVersion: 124 },
    ],
    "123-funded-replay-checkpoints.sql": [
      {
        table: "paper_funded_run_snapshot",
        columns: ["boundary_event_sequence"],
        indexes: ["paper_funded_run_snapshot_account_boundary_idx"],
      },
      { table: "foundation_schema_version", foundationVersion: 123 },
    ],
    "122-funded-learning-evidence.sql": [
      {
        table: "paper_signal_observation",
        indexes: ["paper_signal_observation_run_identity_uq"],
      },
      {
        table: "paper_bot_run",
        indexes: ["paper_bot_run_identity_market_uq"],
      },
      {
        table: "paper_funded_run",
        indexes: ["paper_funded_run_ownership_uq"],
      },
      {
        table: "funded_decision_evidence",
        columns: [
          "run_id",
          "observation_id",
          "sequence",
          "market_id",
          "currency",
          "account_id",
          "funded_policy_version",
          "execution_model_version",
          "feature_version",
          "source_kind",
          "action",
          "decision_at",
          "captured_at",
          "content_digest",
          "decision_content",
          "cohort_digest",
          "cohort_components",
        ],
        indexes: ["funded_decision_evidence_market_idx"],
        constraint: {
          name: "funded_decision_evidence_market_currency_check",
          definitionIncludes: "market_id",
        },
      },
      {
        table: "funded_decision_outcome",
        columns: [
          "run_id",
          "observation_id",
          "sequence",
          "status",
          "source_kind",
          "source_id",
          "source_digest",
          "available_at",
          "recorded_at",
          "supersedes_sequence",
          "reason",
          "detail",
        ],
        indexes: ["funded_decision_outcome_decision_idx"],
        constraint: {
          name: "funded_decision_outcome_resolved_reason_check",
          definitionIncludes: "UNRESOLVED",
        },
      },
      { table: "foundation_schema_version", foundationVersion: 122 },
    ],
    "121-statistical-dataset-derivation.sql": [
      {
        table: "statistical_training_dataset",
        columns: ["research_derivation"],
        constraint: {
          name: "statistical_training_dataset_derivation_check",
          definitionIncludes: "research_derivation",
        },
      },
      { table: "foundation_schema_version", foundationVersion: 121 },
    ],
    "120-discovery-attempt-diagnostics.sql": [
      {
        table: "discovery_run_diagnostic",
        columns: [
          "run_id",
          "market_id",
          "attempt_id",
          "schema_version",
          "captured_at",
          "payload",
        ],
        indexes: [
          "discovery_run_diagnostic_market_idx",
          "discovery_run_diagnostic_run_idx",
        ],
      },
      { table: "foundation_schema_version", foundationVersion: 120 },
    ],
    "119-drop-manual-journal.sql": [
      { table: "foundation_schema_version", foundationVersion: 119 },
    ],
    "088-funded-fact-lookup-indexes.sql": [
      {
        table: "paper_funded_fact",
        indexes: [
          "paper_funded_fact_processed_time",
          "paper_funded_fact_pre_submission_order",
          "paper_funded_fact_collection_clock",
        ],
      },
    ],
    "089-research-evidence-lineage.sql": [
      {
        table: "research_manifest",
        columns: ["hash", "market_id", "manifest"],
      },
      {
        table: "research_coverage_report",
        columns: ["hash", "market_id", "input_hash", "status", "report"],
      },
      {
        table: "research_evidence_binding",
        columns: [
          "owner_kind",
          "owner_id",
          "market_id",
          "manifest_hash",
          "coverage_report_hash",
          "input_hash",
          "binding",
        ],
      },
      { table: "research_job", columns: ["research_evidence"] },
      { table: "backtest_run", columns: ["research_evidence"] },
      { table: "calibration_run", columns: ["research_evidence"] },
      {
        table: "statistical_training_dataset",
        columns: ["research_evidence"],
      },
      { table: "statistical_model", columns: ["research_evidence"] },
    ],
    "090-evidence-automation.sql": [
      {
        table: "research_evidence_work",
        columns: [
          "work_key",
          "kind",
          "market_id",
          "scope_hash",
          "input_identity_hash",
          "processor_version",
          "job_id",
          "identity",
        ],
      },
      {
        table: "research_evidence_work_receipt",
        columns: ["work_key", "receipt_hash", "receipt", "recorded_at"],
      },
      { table: "research_job", columns: ["research_evidence"] },
    ],
    "091-evidence-source-watermark.sql": [
      {
        table: "research_evidence_source_watermark",
        columns: [
          "market_id",
          "last_completed_at",
          "last_source_id",
          "updated_at",
        ],
      },
    ],
    "092-strategy-study.sql": [
      {
        table: "strategy_study",
        columns: ["market_id", "spec_hash", "spec"],
      },
      {
        table: "strategy_study_receipt",
        columns: ["study_id", "receipt_key", "payload", "created_at"],
      },
      { table: "backtest_trade", columns: ["sampled_excursion"] },
    ],
    "093-study-execution-authorization.sql": [
      {
        table: "study_execution_authorization",
        columns: [
          "market_id",
          "frozen_plan_hash",
          "prerequisite_policy_hash",
          "source_window_start",
          "source_window_end",
          "engine_revision",
          "runtime_fingerprint",
          "expires_at",
          "max_studies",
          "max_session_executions",
          "mode",
          "plan",
          "granted_at",
          "revoked_at",
          "dispatched_job_id",
          "idempotency_key",
          "revoke_idempotency_key",
        ],
      },
    ],
    "094-strategy-study-report-prerequisite.sql": [
      {
        table: "strategy_study_receipt",
        columns: ["study_id", "receipt_key", "payload", "created_at"],
      },
    ],
    "095-challenger-observation.sql": [
      {
        table: "challenger_experiment",
        columns: [
          "id",
          "model_id",
          "artifact_hash",
          "market_id",
          "scope",
          "research_evidence",
          "starts_at",
          "ends_at",
          "max_prediction_lag_ms",
          "registration_request_id",
          "registration_request_hash",
        ],
      },
      { table: "foundation_schema_version", foundationVersion: 95 },
      {
        table: "challenger_experiment_transition",
        columns: ["experiment_id", "sequence", "request_id", "state"],
      },
      {
        table: "challenger_attempt",
        columns: [
          "experiment_id",
          "observation_id",
          "input_hash",
          "recorded_at",
          "deadline_at",
          "input_snapshot",
        ],
        indexes: ["challenger_unfinished_deadline"],
      },
      {
        table: "challenger_outcome",
        columns: ["experiment_id", "observation_id", "status", "completed_at"],
      },
      { table: "paper_signal_observation", columns: ["captured_at"] },
    ],
    "085-discovery-evidence.sql": [
      {
        table: "discovery_policy",
        columns: ["market_id", "version", "definition", "effective_at"],
      },
      {
        table: "discovery_catalog_snapshot",
        columns: ["market_id", "digest", "snapshot", "row_count", "fetched_at"],
      },
      {
        table: "discovery_catalog_member",
        columns: ["snapshot_id", "provider_exchange", "provider_code"],
      },
      {
        table: "discovery_run",
        columns: [
          "market_id",
          "policy_version",
          "status",
          "coverage",
          "idempotency_key",
        ],
      },
      {
        table: "discovery_evaluation",
        columns: [
          "run_id",
          "market_id",
          "catalog_snapshot_id",
          "result",
          "input_digest",
        ],
      },
      {
        table: "discovery_evaluation_input",
        columns: ["evaluation_id", "payload"],
      },
      {
        table: "discovery_evidence_hold",
        columns: ["evaluation_id", "reason"],
      },
    ],
    "096-execution-diagnostics.sql": [
      {
        table: "execution_diagnostic_report",
        columns: [
          "id",
          "run_id",
          "account_id",
          "market_id",
          "currency",
          "temporal_scope",
          "as_of",
          "report_version",
          "source_digest",
          "identity_hash",
          "report",
          "created_at",
        ],
      },
      { table: "foundation_schema_version", foundationVersion: 96 },
    ],
    "097-research-evidence-owner-consistency.sql": [
      {
        table: "research_evidence_binding",
        columns: ["owner_kind", "owner_id", "market_id"],
      },
      { table: "foundation_schema_version", foundationVersion: 97 },
    ],
    "098-research-coverage-requests.sql": [
      {
        table: "research_coverage_request",
        columns: [
          "id",
          "market_id",
          "request_hash",
          "request",
          "idempotency_key",
          "latest_job_id",
        ],
      },
      {
        table: "research_coverage_source_receipt",
        columns: [
          "request_id",
          "source_identity_hash",
          "source_descriptor",
          "captured_at",
        ],
      },
      {
        table: "research_coverage_request_result",
        columns: ["work_key", "request_id", "job_id", "report_hash", "status"],
      },
      { table: "foundation_schema_version", foundationVersion: 98 },
    ],
    "099-study-session-authority.sql": [
      {
        table: "study_session_plan",
        columns: [
          "authorization_id",
          "plan_hash",
          "plan",
          "admitted_executions",
        ],
      },
      {
        table: "study_session_receipt",
        columns: [
          "authority_id",
          "experiment_id",
          "stage",
          "side",
          "session_date",
          "state",
          "job_id",
        ],
      },
      { table: "foundation_schema_version", foundationVersion: 99 },
    ],
    "100-challenger-acceptance-records.sql": [
      {
        table: "challenger_model_scope",
        columns: ["model_id", "scope_hash", "scope"],
      },
      {
        table: "challenger_baseline_record",
        columns: ["identity_hash", "market_id", "record"],
      },
      {
        table: "challenger_acceptance_plan",
        columns: ["identity_hash", "market_id", "record"],
      },
      {
        table: "challenger_condition_definition",
        columns: ["identity_hash", "market_id", "record"],
      },
      { table: "foundation_schema_version", foundationVersion: 100 },
    ],
    "101-challenger-label-availability.sql": [
      {
        table: "challenger_label_evidence",
        columns: [
          "execution_id",
          "observation_id",
          "market_id",
          "model",
          "exit_at",
          "label_available_at",
          "source_revision",
          "label",
        ],
      },
      { table: "foundation_schema_version", foundationVersion: 101 },
    ],
    "102-study-session-acceptance.sql": [
      {
        table: "study_session_acceptance",
        columns: [
          "authority_id",
          "experiment_id",
          "stage",
          "side",
          "session_date",
          "result_hash",
          "job_id",
          "attempt_count",
          "accepted_at",
        ],
      },
      { table: "foundation_schema_version", foundationVersion: 102 },
    ],
    "103-challenger-integrity.sql": [
      {
        table: "challenger_model_scope",
        columns: [
          "source_kind",
          "source_id",
          "source_digest",
          "artifact_hash",
          "training_label_cutoff_at",
        ],
      },
      {
        table: "challenger_capture_failure",
        columns: ["experiment_id", "observation_id", "reason", "captured_at"],
      },
      { table: "foundation_schema_version", foundationVersion: 103 },
    ],
    "104-study-execution-grants.sql": [
      {
        table: "study_execution_grant",
        columns: [
          "id",
          "kind",
          "job_id",
          "experiment_id",
          "plan_hash",
          "plan",
          "admitted_executions",
        ],
      },
      { table: "foundation_schema_version", foundationVersion: 104 },
    ],
    "106-coverage-request-identity.sql": [
      {
        table: "research_coverage_request_key",
        columns: ["idempotency_key", "request_id", "request_hash"],
      },
      {
        table: "research_coverage_session",
        columns: ["report_hash", "session_date", "payload_hash", "payload"],
      },
    ],
    "107-study-authority-revocation.sql": [
      { table: "foundation_schema_version", foundationVersion: 107 },
    ],
    "108-research-evidence-write-guards.sql": [
      { table: "foundation_schema_version", foundationVersion: 108 },
    ],
    "109-research-owner-market-immutability.sql": [
      { table: "foundation_schema_version", foundationVersion: 109 },
    ],
    "110-discovery-tradingview-parity.sql": [
      {
        table: "discovery_parity_audit",
        columns: [
          "id",
          "market_id",
          "trading_date",
          "audited_at",
          "overlap_count",
          "overlap_ratio",
        ],
      },
      { table: "foundation_schema_version", foundationVersion: 110 },
    ],
    "111-discovery-parity-market-binding.sql": [
      {
        table: "discovery_run",
        constraint: {
          name: "discovery_run_id_market_unique",
          definitionIncludes: "UNIQUE (id, market_id)",
        },
      },
      {
        table: "discovery_parity_audit",
        constraint: {
          name: "discovery_parity_audit_run_market_fkey",
          definitionIncludes: "FOREIGN KEY (run_id, market_id)",
        },
      },
      { table: "foundation_schema_version", foundationVersion: 111 },
    ],
    "112-funded-diagnostics-catchup-indexes.sql": [
      {
        table: "paper_funded_fact",
        indexes: ["paper_funded_fact_boundary_revision_idx"],
      },
      {
        table: "paper_funded_event",
        indexes: ["paper_funded_event_account_recorded_idx"],
      },
      { table: "foundation_schema_version", foundationVersion: 112 },
    ],
    "113-funded-fact-outcome-status-index.sql": [
      {
        table: "paper_funded_fact",
        indexes: ["paper_funded_fact_outcome_status_idx"],
      },
      { table: "foundation_schema_version", foundationVersion: 113 },
    ],
    "114-backtest-automation.sql": [
      {
        table: "backtest_automation_control",
        columns: [
          "market_id",
          "enabled",
          "cadence",
          "max_outstanding",
          "updated_at",
        ],
      },
      {
        table: "backtest_automation_work",
        columns: [
          "work_key",
          "market_id",
          "kind",
          "config_id",
          "config_version",
          "strategy_key",
          "identity",
          "state",
          "trigger_origin",
          "attempt_key",
          "input_fingerprint",
          "dispatched_fingerprint",
          "consumed_fingerprint",
          "blocker_reason",
          "job_id",
          "run_id",
          "retry_count",
          "next_attempt_at",
          "failure_message",
          "last_dispatched_at",
          "last_success_at",
          "last_failure_at",
        ],
      },
      {
        table: "backtest_automation_cycle",
        columns: [
          "cycle_id",
          "market_id",
          "trigger_origin",
          "outcome",
          "evaluated",
          "dispatched",
          "coalesced",
          "blocked",
          "retried",
          "succeeded",
          "failed",
          "changes",
          "started_at",
          "finished_at",
        ],
      },
      { table: "research_job", columns: ["priority"] },
      { table: "foundation_schema_version", foundationVersion: 114 },
    ],
    "115-backtest-automation-stages.sql": [
      {
        table: "backtest_automation_stage",
        columns: [
          "stage_key",
          "work_key",
          "market_id",
          "state",
          "authorization_scope",
          "input_identity_hash",
          "reason_codes",
          "job_id",
          "retry_count",
          "next_attempt_at",
          "failure_message",
          "last_evaluated_at",
          "completed_at",
          "updated_at",
        ],
      },
      { table: "foundation_schema_version", foundationVersion: 115 },
    ],
    "116-funded-historical-automation-policy.sql": [
      {
        table: "funded_historical_automation_policy",
        columns: [
          "policy_id",
          "policy_hash",
          "market_id",
          "scope",
          "max_sessions",
          "approved_by",
          "approval_note",
          "approved_at",
          "expires_at",
          "revoked_at",
          "revoked_by",
          "revoked_reason",
        ],
      },
      { table: "foundation_schema_version", foundationVersion: 116 },
    ],
    "117-backtest-automation-completion-trigger.sql": [
      {
        table: "backtest_automation_work",
        columns: ["waiting_since"],
        constraint: {
          name: "backtest_automation_work_trigger_origin_check",
          definitionIncludes: "JOB_COMPLETION",
        },
      },
      {
        table: "backtest_automation_cycle",
        constraint: {
          name: "backtest_automation_cycle_trigger_origin_check",
          definitionIncludes: "JOB_COMPLETION",
        },
      },
      { table: "foundation_schema_version", foundationVersion: 117 },
    ],
    "118-backtest-automation-candidate-blocker.sql": [
      {
        table: "backtest_automation_work",
        constraint: {
          name: "backtest_automation_work_blocker_reason_check",
          definitionIncludes: "NO_REPLAY_CANDIDATES",
        },
      },
      { table: "foundation_schema_version", foundationVersion: 118 },
    ],
    "086-discovery-shadow-control.sql": [
      {
        table: "discovery_mode",
        columns: ["market_id", "mode", "revision", "updated_at"],
      },
      {
        table: "discovery_mode_audit",
        columns: ["market_id", "previous_mode", "mode", "revision", "actor"],
      },
      {
        table: "discovery_schedule_lease",
        columns: [
          "market_id",
          "trading_date",
          "completed_bar_end",
          "owner_token",
          "fencing_generation",
          "lease_expires_at",
        ],
      },
    ],
    "087-discovery-intake.sql": [
      {
        table: "discovery_intake_exclusion",
        columns: ["market_id", "trading_date", "normalized_symbol", "reason"],
      },
      {
        table: "discovery_intake_outbox",
        columns: [
          "evaluation_id",
          "market_id",
          "mode_revision",
          "normalized_symbol",
          "status",
          "sync_status",
        ],
      },
    ],
    "084-discovery-provider-budget.sql": [
      {
        table: "questrade_request_budget",
        columns: [
          "namespace",
          "blocked_until",
          "last_started_at",
          "last_discovery_at",
        ],
      },
      {
        table: "questrade_request_grant",
        columns: ["namespace", "started_at", "discovery"],
      },
      {
        table: "discovery_catalog_cache",
        columns: ["market_id", "trading_date", "snapshot"],
      },
      {
        table: "discovery_catalog_attempt",
        columns: ["market_id", "failure_code"],
      },
      {
        table: "discovery_symbol_mapping",
        columns: [
          "market_id",
          "provider_code",
          "catalog_fingerprint",
          "decision",
          "expires_at",
        ],
      },
    ],
    "001-foundation.sql": [{ table: "foundation_schema_version" }],
    "002-phase2.sql": [
      {
        table: "market_data_auth",
        columns: ["encrypted_previous_refresh_token", "rotation_started_at"],
      },
      { table: "instrument" },
      { table: "quote_snapshot" },
      { table: "candle" },
    ],
    "003-phase3.sql": [{ table: "feature_snapshot" }],
    "004-phase4.sql": [
      { table: "strategy_config" },
      { table: "strategy_signal" },
      { table: "strategy_state_event" },
    ],
    "005-phase6.sql": [{ table: "scanner_alert" }],
    // 006 created journal_trade, dropped by 119-drop-manual-journal.sql. The
    // surviving evidence of 006 in a ledger-less schema is its foundation
    // version row; keeping a requirement here preserves legacy reconciliation
    // ordering without expecting the dropped table.
    "006-phase7.sql": [
      { table: "foundation_schema_version", foundationVersion: 6 },
    ],
    "007-phase8.sql": [{ table: "backtest_run" }, { table: "backtest_trade" }],
    "008-phase8a.sql": [
      { table: "strategy_definition" },
      { table: "scanner_profile" },
      { table: "strategy_evaluation" },
    ],
    "009-phase9.sql": [{ table: "calibration_run" }],
    "010-phase10.sql": [
      { table: "universe_refresh_run" },
      { table: "universe_watchlist" },
    ],
    "011-phase11.sql": [{ table: "strategy_definition" }],
    "012-phase12.sql": [{ table: "statistical_model" }],
    "013-analysis-context.sql": [
      { table: "context_evaluation" },
      { table: "instrument", columns: ["benchmark_kind"] },
    ],
    "014-strategy-lab.sql": [{ table: "scanner_profile_config" }],
    "015-explainable-scoring.sql": [
      {
        table: "strategy_evaluation",
        columns: ["score_version", "score_components", "score_explanation"],
      },
      {
        table: "strategy_signal",
        columns: ["score_version", "score_components"],
      },
    ],
    "016-context-ranking-research.sql": [
      {
        table: "context_evaluation",
        columns: ["context_score_version", "context_score_components"],
      },
      { table: "ranking_formula" },
    ],
    "017-phase6-ranking-studies.sql": [{ table: "ranking_research_run" }],
    "018-phase7-daily-workflow.sql": [
      { table: "universe_watchlist", columns: ["candidates"] },
      {
        table: "scanner_alert",
        columns: ["setup_instance_id", "deduplication_key"],
      },
    ],
    "019-phase8-evidence-risk.sql": [
      { table: "backtest_run", columns: ["evidence"] },
      { table: "backtest_trade", columns: ["setup_instance_id"] },
    ],
    "020-phase9-observability.sql": [
      { table: "observability_retention_policy" },
    ],
    "021-market-data-auth-correction.sql": [
      {
        table: "market_data_auth",
        columns: ["encrypted_previous_refresh_token", "rotation_started_at"],
        foundationVersion: 21,
      },
    ],
    "022-captured-history-availability.sql": [
      { table: "backtest_run", columns: ["captured_history_availability"] },
      {
        table: "calibration_run",
        columns: ["captured_history_availability"],
      },
    ],
    "023-replay-input-snapshots.sql": [
      { table: "backtest_run", columns: ["replay_input"] },
    ],
    "024-profile-config-evidence.sql": [{ table: "profile_config_evidence" }],
    // 025 and 026 both establish the same observable invariant. 026 is an
    // idempotent corrective backstop, so the final constraint is the only
    // safe predicate available when reconciling a pre-ledger database.
    "025-operational-status.sql": [
      {
        table: "backtest_run",
        constraint: {
          name: "backtest_run_status_check",
          definitionIncludes: "'INTERRUPTED'",
        },
      },
    ],
    "026-operational-status-constraint-fix.sql": [
      {
        table: "backtest_run",
        constraint: {
          name: "backtest_run_status_check",
          definitionIncludes: "'INTERRUPTED'",
        },
      },
    ],
    "027-research-jobs.sql": [{ table: "research_job" }],
    "028-retention-correction.sql": [
      { table: "retention_job_run" },
      {
        table: "observability_retention_policy",
        columns: ["time_column"],
      },
    ],
    "029-schedule-retention.sql": [
      {
        table: "retention_job_run",
        scheduledProcedure: "run_scheduled_retention",
      },
    ],
    "030-paper-bot.sql": [
      { table: "paper_bot_run" },
      { table: "paper_signal_observation" },
      { table: "paper_execution" },
    ],
    "031-execution-provenance.sql": [
      {
        table: "backtest_run",
        columns: [
          "execution_model_version",
          "execution_assumptions",
          "supersedes_backtest_run_id",
        ],
      },
      {
        table: "calibration_run",
        columns: ["execution_model_version", "execution_assumptions"],
      },
      {
        table: "scanner_profile_config",
        columns: ["source_calibration_run_id"],
      },
      {
        table: "ranking_formula",
        columns: ["activation_research_run_id"],
      },
    ],
    "032-authoritative-backtest-exits.sql": [
      {
        table: "backtest_trade",
        constraint: {
          name: "backtest_trade_exit_reason_check",
          definitionIncludes: "'SESSION_CLOSE_DELAYED'",
        },
      },
    ],
    "033-existing-evidence-migration.sql": [
      { table: "execution_evidence_migration" },
      { table: "calibration_evidence_migration" },
      {
        table: "ranking_research_run",
        columns: ["execution_model_version"],
      },
    ],
    "034-paper-reporting-indexes.sql": [
      { table: "paper_bot_run" },
      { table: "paper_signal_observation" },
      { table: "paper_execution" },
    ],
    "035-paper-execution-recovery.sql": [
      { table: "paper_execution", columns: ["last_fact_timestamp"] },
    ],
    "036-paper-close-horizon.sql": [
      {
        table: "paper_execution",
        columns: ["close_abandoned_at", "unresolved_reason"],
      },
    ],
    "037-paper-bot-activity-journal.sql": [
      { table: "paper_bot_activity", foundationVersion: 37 },
    ],
    "038-remaining-setup-profiles.sql": [
      { table: "scanner_profile", foundationVersion: 38 },
    ],
    "039-paper-profile-qualification-history.sql": [
      { table: "paper_profile_qualification", foundationVersion: 39 },
    ],
    "040-paper-qualification-policy-v2.sql": [
      { table: "paper_profile_qualification", foundationVersion: 40 },
    ],
    "041-paper-evidence-model-training.sql": [
      { table: "statistical_training_dataset", foundationVersion: 41 },
      { table: "statistical_training_dataset_member" },
    ],
    "042-paper-evidence-model-source.sql": [
      {
        table: "statistical_model",
        columns: ["source_kind", "training_dataset_id"],
      },
    ],
    "043-paper-model-prediction-snapshots.sql": [
      { table: "paper_model_prediction_snapshot", foundationVersion: 43 },
    ],
    "050-paper-coordination-context-exposure.sql": [
      {
        table: "paper_coordination_decision",
        columns: ["context_snapshot"],
        foundationVersion: 50,
      },
    ],
    "051-paper-coordination-cross-run-recovery.sql": [
      {
        table: "paper_coordination_position",
        columns: ["symbol"],
        foundationVersion: 51,
      },
    ],
    "052-quote-size-unit-contract.sql": [
      {
        table: "quote_snapshot",
        columns: [
          "bid_size_raw",
          "ask_size_raw",
          "size_unit",
          "size_multiplier",
        ],
        foundationVersion: 52,
      },
    ],
    "053-paper-coordination-portfolio-remediation.sql": [
      { table: "paper_portfolio", foundationVersion: 53 },
      {
        table: "paper_coordination_decision",
        columns: ["portfolio_id"],
      },
      {
        table: "paper_coordination_position",
        columns: [
          "portfolio_id",
          "session_date",
          "recovery_source",
          "recovery_boundary",
          "recovery_fact_timestamp",
          "recovery_delay_ms",
        ],
      },
    ],
    "049-paper-execution-economics-gate.sql": [
      {
        table: "paper_execution",
        columns: ["economics_reason", "economics", "sizing"],
        foundationVersion: 49,
      },
    ],
    "055-model-informed-coordination.sql": [
      { table: "learning_automation_run", foundationVersion: 55 },
      {
        table: "paper_coordination_decision",
        columns: ["shadow_decision"],
      },
    ],
    "056-market-identity.sql": [
      { table: "instrument", columns: ["market_id"] },
      { table: "universe_refresh_run", columns: ["market_id"] },
      { table: "paper_portfolio", columns: ["market_id"] },
      {
        table: "learning_automation_run",
        columns: ["market_id"],
        foundationVersion: 56,
      },
    ],
    "057-z-paper-portfolio-constraint-bridge.sql": [
      { table: "paper_portfolio", columns: ["market_id", "currency"] },
    ],
    "059-statistical-model-market-isolation.sql": [
      { table: "statistical_training_dataset", columns: ["market_id"] },
      { table: "statistical_model", columns: ["market_id"] },
      { table: "foundation_schema_version", foundationVersion: 59 },
    ],
    "060-paper-qualification-market-isolation.sql": [
      { table: "paper_profile_qualification", columns: ["market_id"] },
      { table: "foundation_schema_version", foundationVersion: 60 },
    ],
    "061-market-scoped-persistence-indexes.sql": [
      { table: "strategy_signal", columns: ["market_id"] },
      { table: "strategy_evaluation", columns: ["market_id"] },
      { table: "feature_snapshot", columns: ["market_id"] },
      { table: "foundation_schema_version", foundationVersion: 61 },
    ],
    "062-market-scoped-profiles.sql": [
      { table: "scanner_profile", columns: ["market_id"] },
      { table: "scanner_profile_config", columns: ["market_id"] },
      { table: "strategy_evaluation", columns: ["market_id"] },
      { table: "foundation_schema_version", foundationVersion: 62 },
    ],
    "081-strategy-formation-evidence.sql": [
      { table: "strategy_signal", columns: ["formation_evidence"] },
      { table: "strategy_evaluation", columns: ["formation_evidence"] },
      { table: "strategy_state_event", columns: ["formation_evidence"] },
      { table: "foundation_schema_version", foundationVersion: 81 },
    ],
    "082-paper-coordination-model-facts-update.sql": [
      { table: "paper_coordination_decision" },
      { table: "foundation_schema_version", foundationVersion: 82 },
    ],
    "083-calibration-holdout-selection.sql": [
      {
        table: "calibration_run",
        columns: ["research_job_id", "holdout_selection"],
      },
      { table: "foundation_schema_version", foundationVersion: 83 },
    ],
  };

/**
 * These migrations were changed after release. Databases that applied the
 * released bodies have these exact historical digests in their ledgers.
 * Keep every exception tied to a known released body so arbitrary edits still
 * fail checksum validation.
 *
 * 025 was corrected after release; 026 repairs the resulting constraint state.
 * 030 later received comment-only documentation path updates when its plan was
 * archived; its executable SQL was unchanged.
 */
const acceptedHistoricalChecksums: Readonly<Record<string, readonly string[]>> =
  {
    "004-phase4.sql": [
      "77979b98be8e8fe644a48f8b5bc76ef5270d7d1c499249107bf7819c9ea46806",
    ],
    "013-analysis-context.sql": [
      "f6bf24d390a951478a0ce9d320640720fbd5a9720551961a5c78e1852de0796f",
    ],
    "025-operational-status.sql": [
      "d6232c6285e28f3ddf31f26cadc8ccaf8fa59311f2c7a28ac15dbcbe9ffc9370",
    ],
    "030-paper-bot.sql": [
      "63cf83195c36cf8dddd5ff16d54b5bb80064214b322cdd20be58dd0d903cb2b7",
    ],
  };

export class MigrationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MigrationError";
  }
}

function checksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

export async function loadMigrations(): Promise<readonly Migration[]> {
  const filenames = (await readdir(MIGRATIONS_DIRECTORY))
    .filter((filename) => MIGRATION_FILENAME.test(filename))
    .sort();

  if (filenames.length === 0)
    throw new MigrationError(`No migrations found in ${MIGRATIONS_DIRECTORY}.`);

  return Promise.all(
    filenames.map(async (filename) => {
      const sql = await readFile(`${MIGRATIONS_DIRECTORY}/${filename}`, "utf8");
      return {
        filename,
        sql,
        checksum: checksum(sql),
        requirements: requirements[filename],
        acceptedChecksums: acceptedHistoricalChecksums[filename],
      };
    }),
  );
}

async function tableExists(
  client: PoolClient,
  table: string,
): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
    "SELECT to_regclass($1) IS NOT NULL AS exists",
    [`public.${table}`],
  );
  return result.rows[0]?.exists === true;
}

async function requirementIsMet(
  client: PoolClient,
  requirement: MigrationRequirement,
): Promise<boolean> {
  if (!(await tableExists(client, requirement.table))) return false;
  if (requirement.indexes?.length) {
    const result = await client.query<{ index_name: string }>(
      `SELECT i.relname AS index_name FROM pg_index x
       JOIN pg_class i ON i.oid=x.indexrelid
       JOIN pg_class t ON t.oid=x.indrelid
       JOIN pg_namespace n ON n.oid=t.relnamespace
       WHERE n.nspname='public' AND t.relname=$1
         AND i.relname=ANY($2::text[]) AND x.indisvalid AND x.indisready`,
      [requirement.table, requirement.indexes],
    );
    if (result.rows.length !== requirement.indexes.length) return false;
  }
  if (requirement.triggers?.length) {
    const result = await client.query<{ trigger_name: string }>(
      `SELECT x.tgname AS trigger_name FROM pg_trigger x
       JOIN pg_class t ON t.oid=x.tgrelid
       JOIN pg_namespace n ON n.oid=t.relnamespace
       WHERE n.nspname='public' AND t.relname=$1
         AND NOT x.tgisinternal AND x.tgname=ANY($2::text[])`,
      [requirement.table, requirement.triggers],
    );
    if (result.rows.length !== requirement.triggers.length) return false;
  }
  if (requirement.columns?.length) {
    const result = await client.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = $1
         AND column_name = ANY($2::text[])`,
      [requirement.table, requirement.columns],
    );
    if (result.rows.length !== requirement.columns.length) return false;
  }
  if (requirement.constraint) {
    const result = await client.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(c.oid) AS definition
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = 'public'
         AND t.relname = $1
         AND c.conname = $2`,
      [requirement.table, requirement.constraint.name],
    );
    if (
      !result.rows[0]?.definition.includes(
        requirement.constraint.definitionIncludes,
      )
    )
      return false;
  }
  if (requirement.scheduledProcedure) {
    const result = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM timescaledb_information.jobs
         WHERE proc_name = $1
       ) AS exists`,
      [requirement.scheduledProcedure],
    );
    if (result.rows[0]?.exists !== true) return false;
  }
  if (requirement.foundationVersion !== undefined) {
    const result = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM foundation_schema_version WHERE version = $1
       ) AS exists`,
      [requirement.foundationVersion],
    );
    if (result.rows[0]?.exists !== true) return false;
  }
  return true;
}

async function migrationIsPresent(
  client: PoolClient,
  migration: Migration,
): Promise<boolean> {
  if (!migration.requirements?.length) return false;
  for (const requirement of migration.requirements) {
    if (!(await requirementIsMet(client, requirement))) return false;
  }
  return true;
}

async function hasLegacyApplicationSchema(
  client: PoolClient,
): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])
     ) AS exists`,
    [["foundation_schema_version", "instrument", "strategy_evaluation"]],
  );
  return result.rows[0]?.exists === true;
}

async function createLedger(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migration (
      filename TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      application_version TEXT NOT NULL,
      seeded BOOLEAN NOT NULL DEFAULT FALSE
    )
  `);
}

type AppliedMigration = { filename: string; checksum: string; seeded: boolean };

async function readAppliedMigrations(
  client: PoolClient,
): Promise<readonly AppliedMigration[]> {
  const result = await client.query<AppliedMigration>(
    "SELECT filename, checksum, seeded FROM schema_migration ORDER BY filename",
  );
  return result.rows;
}

function validateAppliedMigrations(
  migrations: readonly Migration[],
  applied: readonly AppliedMigration[],
): void {
  const expected = new Map(
    migrations.map((migration) => [migration.filename, migration]),
  );
  let previousIndex = -1;
  for (const record of applied) {
    const index = migrations.findIndex(
      (migration) => migration.filename === record.filename,
    );
    const migration = expected.get(record.filename);
    if (!migration)
      throw new MigrationError(
        `Database ledger contains unknown migration ${record.filename}; refusing to guess its ordering.`,
      );
    if (
      record.checksum !== migration.checksum &&
      !migration.acceptedChecksums?.includes(record.checksum)
    )
      throw new MigrationError(
        `Checksum mismatch for ${record.filename}. The applied migration was modified; restore its original contents or create a new corrective migration.`,
      );
    if (index !== previousIndex + 1)
      throw new MigrationError(
        `Migration ledger skips an earlier migration before ${record.filename}; refusing to apply out of order.`,
      );
    previousIndex = index;
  }
}

async function recordMigration(
  client: PoolClient,
  migration: Migration,
  applicationVersion: string,
  seeded: boolean,
): Promise<void> {
  await client.query(
    `INSERT INTO schema_migration (filename, checksum, application_version, seeded)
     VALUES ($1, $2, $3, $4)`,
    [migration.filename, migration.checksum, applicationVersion, seeded],
  );
}

async function reconcileLegacySchema(
  client: PoolClient,
  migrations: readonly Migration[],
  applicationVersion: string,
): Promise<readonly string[]> {
  const present: boolean[] = [];
  for (const migration of migrations)
    present.push(await migrationIsPresent(client, migration));
  const firstMissing = present.findIndex((value) => !value);
  const seeded =
    firstMissing === -1 ? migrations : migrations.slice(0, firstMissing);
  if (firstMissing !== -1) {
    const laterPresent = present.slice(firstMissing + 1).findIndex(Boolean);
    if (laterPresent !== -1) {
      const missing = migrations[firstMissing]?.filename;
      const later = migrations[firstMissing + laterPresent + 1]?.filename;
      throw new MigrationError(
        `Legacy schema is inconsistent: ${missing} is not present but later migration ${later} is. Restore a consistent backup or repair the schema manually before starting the API.`,
      );
    }
  }

  await client.query("BEGIN");
  try {
    for (const migration of seeded)
      await recordMigration(client, migration, applicationVersion, true);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw new MigrationError(
      "Could not reconcile the legacy migration ledger.",
      {
        cause: error,
      },
    );
  }
  return seeded.map((migration) => migration.filename);
}

async function applyMigration(
  client: PoolClient,
  migration: Migration,
  applicationVersion: string,
): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(migration.sql);
    await recordMigration(client, migration, applicationVersion, false);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw new MigrationError(`Migration ${migration.filename} failed.`, {
      cause: error,
    });
  }
}

export async function migrate(
  pool: Pool,
  options: MigrateOptions = {},
): Promise<MigrationResult> {
  const migrations = options.migrations ?? (await loadMigrations());
  const applicationVersion = options.applicationVersion ?? API_VERSION;
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1::bigint)", [
      ADVISORY_LOCK_ID,
    ]);
    const ledgerExisted = await tableExists(client, "schema_migration");
    await createLedger(client);
    let appliedRecords = await readAppliedMigrations(client);
    validateAppliedMigrations(migrations, appliedRecords);

    const seeded =
      !ledgerExisted &&
      appliedRecords.length === 0 &&
      (await hasLegacyApplicationSchema(client))
        ? await reconcileLegacySchema(client, migrations, applicationVersion)
        : [];
    if (seeded.length > 0) appliedRecords = await readAppliedMigrations(client);

    const appliedFilenames = new Set(
      appliedRecords.map((record) => record.filename),
    );
    const applied: string[] = [];
    for (const migration of migrations) {
      if (appliedFilenames.has(migration.filename)) continue;
      await applyMigration(client, migration, applicationVersion);
      applied.push(migration.filename);
    }
    return { applied, seeded };
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock($1::bigint)", [
        ADVISORY_LOCK_ID,
      ]);
    } finally {
      client.release();
    }
  }
}
