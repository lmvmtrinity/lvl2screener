import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MigrationError,
  type Migration,
  loadMigrations,
  migrate,
} from "../src/database/migrate.js";

function migration(
  filename: string,
  sql = `-- ${filename}`,
  requirements: Migration["requirements"] = [],
): Migration {
  return {
    filename,
    sql,
    checksum: createHash("sha256").update(sql).digest("hex"),
    requirements,
  };
}

type LedgerRecord = {
  filename: string;
  checksum: string;
  seeded: boolean;
};

class FakeClient {
  readonly tables = new Set<string>();
  readonly columns = new Map<string, Set<string>>();
  readonly indexes = new Map<string, Set<string>>();
  readonly triggers = new Map<string, Set<string>>();
  readonly constraints = new Map<string, string>();
  readonly scheduledProcedures = new Set<string>();
  readonly executed: string[] = [];
  readonly queries: string[] = [];
  ledger: LedgerRecord[] = [];
  legacy = false;
  released = false;

  async query<T>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<{ rows: T[] }> {
    this.queries.push(text);
    if (text.includes("FROM pg_index")) {
      const present = this.indexes.get(String(values[0])) ?? new Set<string>();
      return {
        rows: (values[1] as string[])
          .filter((name) => present.has(name))
          .map((index_name) => ({ index_name }) as T),
      };
    }
    if (text.includes("FROM pg_trigger")) {
      const present = this.triggers.get(String(values[0])) ?? new Set<string>();
      return {
        rows: (values[1] as string[])
          .filter((name) => present.has(name))
          .map((trigger_name) => ({ trigger_name }) as T),
      };
    }
    if (text.includes("to_regclass")) {
      const relation = String(values[0]).replace("public.", "");
      return { rows: [{ exists: this.tables.has(relation) } as T] };
    }
    if (text.includes("information_schema.columns")) {
      const table = String(values[0]);
      const required = values[1] as readonly string[];
      const present = this.columns.get(table) ?? new Set<string>();
      return {
        rows: required
          .filter((column) => present.has(column))
          .map((column) => ({ column_name: column }) as T),
      };
    }
    if (text.includes("pg_get_constraintdef")) {
      const [table, constraint] = values as [string, string];
      const definition = this.constraints.get(`${table}.${constraint}`);
      return { rows: definition ? [{ definition } as T] : [] };
    }
    if (text.includes("timescaledb_information.jobs")) {
      return {
        rows: [
          { exists: this.scheduledProcedures.has(String(values[0])) } as T,
        ],
      };
    }
    if (text.includes("information_schema.tables"))
      return { rows: [{ exists: this.legacy } as T] };
    if (text.includes("SELECT filename, checksum, seeded"))
      return { rows: this.ledger as T[] };
    if (text.includes("INSERT INTO schema_migration")) {
      this.ledger.push({
        filename: String(values[0]),
        checksum: String(values[1]),
        seeded: values[3] === true,
      });
      return { rows: [] };
    }
    if (text.startsWith("-- FAIL")) throw new Error("fixture failure");
    if (text.startsWith("-- ")) this.executed.push(text);
    return { rows: [] };
  }

  release(): void {
    this.released = true;
  }
}

function fakePool(client: FakeClient) {
  return {
    connect: async () => client,
  };
}

describe("migration runner", () => {
  it("loads every SQL migration in filename order, including the auth correction", async () => {
    const migrations = await loadMigrations();
    expect(migrations.map(({ filename }) => filename)).toEqual(
      [...migrations.map(({ filename }) => filename)].sort(),
    );
    expect(migrations).toHaveLength(132);
    expect(migrations.at(-1)?.filename).toBe(
      "132-funded-comparison-records.sql",
    );
    const causal = migrations.find(
      (migration) => migration.filename === "131-funded-causal-provenance.sql",
    );
    expect(causal?.requirements).toEqual([
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
    ]);
    expect(causal?.sql).toContain(
      "ADD COLUMN IF NOT EXISTS source_fact_id TEXT",
    );
    expect(causal?.sql).toContain("funded_decision_outcome_source_fact_fk");
    expect(causal?.sql).toContain(
      "ADD COLUMN IF NOT EXISTS applied_frontier_at TIMESTAMPTZ",
    );
    expect(causal?.sql).toContain("paper_funded_fact_processed_guard");
    expect(causal?.sql).toContain(
      "Funded run applied sequence ownership is database-internal",
    );
    expect(causal?.sql).toContain(
      "Replay funded outcome source fact is not processed",
    );
    expect(causal?.sql).toContain("ADD COLUMN IF NOT EXISTS last_fact_id TEXT");
    expect(causal?.sql).toContain("ADD COLUMN IF NOT EXISTS fact_id TEXT");
    expect(causal?.sql).toContain("ADD COLUMN IF NOT EXISTS fact_run_id UUID");
    expect(causal?.sql).toContain("paper_funded_event_fact_fk");
    expect(causal?.sql).toContain(
      "paper_funded_event_causal_identity_immutable",
    );
    expect(causal?.sql).toContain(
      "Paper entry order history causal fact is not durable",
    );
    // Migration 130 remains published and unmodified.
    const datasets = migrations.find(
      (migration) => migration.filename === "130-funded-execution-datasets.sql",
    );
    expect(datasets?.requirements).toEqual([
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
    ]);
    expect(datasets?.sql).toContain(
      "CREATE TABLE IF NOT EXISTS funded_execution_dataset",
    );
    expect(datasets?.sql).toContain(
      "CREATE TABLE IF NOT EXISTS funded_execution_dataset_member",
    );
    expect(datasets?.sql).toContain(
      "CREATE TABLE IF NOT EXISTS funded_execution_challenger",
    );
    expect(datasets?.sql).toContain(
      "CREATE TABLE IF NOT EXISTS funded_execution_prediction",
    );
    expect(datasets?.sql).toContain("CHECK(eligible_for_activation = false)");
    expect(datasets?.sql).toContain("UNIQUE (dataset_digest)");
    expect(datasets?.sql).toContain("prediction_at <= deadline_at");
    expect(datasets?.sql).toContain("decision_at <= prediction_at");
    expect(datasets?.sql).toContain(
      "funded_execution_prediction_authority_trigger",
    );
    expect(datasets?.sql).toContain(
      "funded_decision_evidence_prediction_binding_uq",
    );
    expect(datasets?.sql).toContain("label_economic_at");
    expect(datasets?.sql).toContain("FUNDED_EXECUTION_TRAINING");
    expect(datasets?.sql).toContain(
      "ADD COLUMN IF NOT EXISTS recorded_at TIMESTAMPTZ",
    );
    expect(datasets?.sql).toContain("clock_timestamp()");
    expect(datasets?.sql).toContain("NEW.prediction_at := clock_timestamp();");
    expect(datasets?.sql).toContain("paper_entry_order_history_immutable");
    expect(datasets?.sql).toContain("already exists with different content");
    expect(datasets?.sql).toContain(
      "ADD COLUMN IF NOT EXISTS applied_sequence BIGINT",
    );
    expect(datasets?.sql).toContain("paper_funded_fact_applied_sequence_uq");
    expect(datasets?.sql).toContain(
      "ADD COLUMN IF NOT EXISTS applied_sequence_counter BIGINT NOT NULL DEFAULT 0",
    );
    expect(datasets?.sql).toContain(
      "ADD COLUMN IF NOT EXISTS applied_frontier_at TIMESTAMPTZ",
    );
    expect(datasets?.sql).toContain("REFERENCING NEW TABLE AS new_facts");
    expect(datasets?.sql).toContain("paper_entry_order_history_authority");
    expect(datasets?.sql).toContain(
      "Paper entry order history recording time is database-owned",
    );
    expect(datasets?.sql).toContain(
      "Paper entry order history must match the current locked order revision",
    );
    expect(datasets?.sql).toContain("paper_funded_fact_applied_sequence");
    expect(datasets?.sql).toContain(
      "Funded fact applied sequence is database-owned",
    );
    expect(datasets?.sql).toContain(
      "Funded fact applied sequence is immutable",
    );
    expect(datasets?.sql).toContain(
      "ADD COLUMN IF NOT EXISTS knowledge_applied_sequence BIGINT",
    );
    expect(datasets?.sql).toContain(
      "funded_decision_outcome_knowledge_boundary",
    );
    expect(datasets?.sql).toContain(
      "Replay funded outcome has no proven applied fact boundary",
    );
    // Pre-130 recording times stay NULL: the migration never backfills them.
    expect(datasets?.sql).not.toContain("UPDATE paper_entry_order_history");
    expect(datasets?.sql).not.toContain("SET recorded_at");

    // Migration 132 adds the immutable FP03 comparison records additively and
    // never rewrites 130 or 131.
    const comparison = migrations.at(-1);
    expect(comparison?.sql).toContain("FUNDED_COMPARISON");
    expect(comparison?.sql).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS backtest_run_id_market_unique",
    );
    for (const table of [
      "funded_comparison_spec",
      "funded_comparison_spec_session",
      "funded_comparison_spec_opportunity",
      "funded_comparison_input_chunk",
      "funded_comparison_provisioning_intent",
      "funded_comparison_run_binding",
      "funded_comparison_policy_evaluation",
      "funded_comparison_session_metric",
      "funded_comparison_result",
      "funded_comparison_failure",
    ]) {
      expect(comparison?.sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
      expect(comparison?.sql).toContain(`CREATE TRIGGER ${table}_immutable`);
      expect(comparison?.sql).toContain(`BEFORE UPDATE OR DELETE ON ${table}`);
    }
    expect(comparison?.sql).toContain("CHECK(item_count BETWEEN 1 AND 1000)");
    expect(comparison?.sql).toContain(
      "jsonb_array_length(payload) = item_count",
    );
    expect(comparison?.sql).toContain("UNIQUE (comparison_spec_digest)");
    expect(comparison?.sql).toContain("UNIQUE (spec_id, ordinal)");
    expect(comparison?.sql).toContain(
      "UNIQUE (spec_id, session_date, ordinal)",
    );
    expect(comparison?.sql).toContain("PRIMARY KEY (spec_id, session_date)");
    expect(comparison?.sql).toContain(
      "PRIMARY KEY (spec_id, source_opportunity_id)",
    );
    expect(comparison?.sql).toContain(
      "PRIMARY KEY (spec_id, session_date, chunk_ordinal)",
    );
    expect(comparison?.sql).toContain(
      "PRIMARY KEY (spec_id, side, session_date)",
    );
    expect(comparison?.sql).toContain(
      "CONSTRAINT funded_comparison_run_binding_run_id_unique\n    UNIQUE (run_id)",
    );
    expect(comparison?.sql).toContain(
      "PRIMARY KEY (spec_id, side, session_date, source_opportunity_id)",
    );
    expect(comparison?.sql).toContain(
      "UNIQUE NULLS NOT DISTINCT (spec_id, attempt_id, reason, side, session_date)",
    );
    expect(comparison?.sql).toContain("UNIQUE (result_digest)");
    expect(comparison?.sql).toContain("UNIQUE (spec_id)");
    expect(comparison?.sql).toContain(
      "REFERENCES funded_execution_challenger(",
    );
    expect(comparison?.sql).toContain(
      "INSERT INTO foundation_schema_version(version, description)",
    );
    expect(comparison?.sql).toContain(
      "VALUES(132, 'Immutable funded historical-comparison records')",
    );
    expect(comparison?.sql).not.toContain(
      "ALTER TABLE funded_execution_dataset",
    );
    expect(comparison?.sql).not.toContain(
      "ALTER TABLE funded_decision_outcome",
    );
    const comparisonRequirements = comparison?.requirements ?? [];
    for (const table of [
      "funded_comparison_spec",
      "funded_comparison_spec_session",
      "funded_comparison_spec_opportunity",
      "funded_comparison_input_chunk",
      "funded_comparison_provisioning_intent",
      "funded_comparison_run_binding",
      "funded_comparison_policy_evaluation",
      "funded_comparison_session_metric",
      "funded_comparison_result",
      "funded_comparison_failure",
    ]) {
      expect(comparisonRequirements).toContainEqual(
        expect.objectContaining({ table }),
      );
    }
    expect(comparisonRequirements).toContainEqual({
      table: "foundation_schema_version",
      foundationVersion: 132,
    });
    expect(
      comparisonRequirements.find(
        (requirement) => requirement.table === "funded_comparison_spec",
      )?.columns,
    ).toContain("comparison_spec_digest");
    expect(
      comparisonRequirements.find(
        (requirement) => requirement.table === "funded_comparison_result",
      )?.columns,
    ).toContain("result_digest");
    expect(comparisonRequirements).toContainEqual({
      table: "funded_comparison_run_binding",
      constraint: {
        name: "funded_comparison_run_binding_run_id_unique",
        definitionIncludes: "UNIQUE (run_id)",
      },
    });
    const refusalSidecar = migrations.find(
      (migration) =>
        migration.filename === "129-funded-refusal-inbox-sidecar.sql",
    );
    expect(refusalSidecar?.requirements).toEqual([
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
    ]);
    expect(refusalSidecar?.sql).toContain(
      "ADD COLUMN IF NOT EXISTS refusal_request JSONB",
    );
    expect(refusalSidecar?.sql).toContain(
      "paper_funded_fact_refusal_request_pending_idx",
    );
    const refusalSource = migrations.find(
      (migration) =>
        migration.filename === "128-funded-decision-refusal-source.sql",
    );
    expect(refusalSource?.requirements).toEqual([
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
    ]);
    expect(refusalSource?.sql).toContain(
      "CREATE TABLE IF NOT EXISTS funded_decision_refusal",
    );
    expect(refusalSource?.sql).toContain(
      "CREATE TRIGGER funded_decision_refusal_immutable",
    );
    expect(refusalSource?.sql).toContain(
      "CHECK(length(btrim(policy_reason)) > 0)",
    );
    const intentBoundary = migrations.find(
      (migration) =>
        migration.filename === "127-funded-decision-intent-boundary.sql",
    );
    expect(intentBoundary?.requirements).toEqual([
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
    ]);
    expect(intentBoundary?.sql).toContain(
      "ADD CONSTRAINT funded_decision_evidence_run_sequence_uq",
    );
    expect(intentBoundary?.sql).toContain(
      "ADD COLUMN IF NOT EXISTS evidence_schema_version",
    );
    expect(intentBoundary?.sql).toContain(
      "CREATE TABLE IF NOT EXISTS funded_decision_intent",
    );
    expect(intentBoundary?.sql).toContain(
      "CREATE TRIGGER funded_decision_intent_immutable",
    );
    expect(intentBoundary?.sql).toContain("duplicate run-local");
    expect(intentBoundary?.sql).not.toContain("UPDATE paper_funded_fact\n");
    expect(
      migrations.find(
        (migration) =>
          migration.filename === "122-funded-learning-evidence.sql",
      )?.requirements,
    ).toEqual([
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
    ]);
    expect(
      migrations
        .find(
          (migration) => migration.filename === "085-discovery-evidence.sql",
        )
        ?.requirements?.map((entry) => entry.table),
    ).toEqual([
      "discovery_policy",
      "discovery_catalog_snapshot",
      "discovery_catalog_member",
      "discovery_run",
      "discovery_evaluation",
      "discovery_evaluation_input",
      "discovery_evidence_hold",
    ]);
    expect(
      migrations
        .find(
          (migration) =>
            migration.filename === "086-discovery-shadow-control.sql",
        )
        ?.requirements?.map((entry) => entry.table),
    ).toEqual([
      "discovery_mode",
      "discovery_mode_audit",
      "discovery_schedule_lease",
    ]);
    expect(
      migrations
        .find((entry) => entry.filename === "087-discovery-intake.sql")
        ?.requirements?.map((entry) => entry.table),
    ).toEqual(["discovery_intake_exclusion", "discovery_intake_outbox"]);
  });

  it("does not seed an index migration from the table alone", async () => {
    for (const indexesPresent of [false, true]) {
      const client = new FakeClient();
      client.legacy = true;
      client.tables.add("paper_funded_fact");
      if (indexesPresent)
        client.indexes.set("paper_funded_fact", new Set(["fact_lookup"]));
      const result = await migrate(fakePool(client) as never, {
        migrations: [
          migration("001-lookup.sql", "-- lookup", [
            { table: "paper_funded_fact", indexes: ["fact_lookup"] },
          ]),
        ],
      });
      expect(result.seeded).toEqual(indexesPresent ? ["001-lookup.sql"] : []);
      expect(result.applied).toEqual(indexesPresent ? [] : ["001-lookup.sql"]);
    }
  });

  it("applies each pending migration once and records it after success", async () => {
    const client = new FakeClient();
    const migrations = [migration("001-one.sql"), migration("002-two.sql")];

    const first = await migrate(fakePool(client) as never, { migrations });
    const second = await migrate(fakePool(client) as never, { migrations });

    expect(first).toEqual({
      applied: ["001-one.sql", "002-two.sql"],
      seeded: [],
    });
    expect(second).toEqual({ applied: [], seeded: [] });
    expect(client.ledger).toEqual([
      expect.objectContaining({ filename: "001-one.sql", seeded: false }),
      expect.objectContaining({ filename: "002-two.sql", seeded: false }),
    ]);
    expect(client.queries).toContain("SELECT pg_advisory_lock($1::bigint)");
    expect(client.released).toBe(true);
  });

  it("rolls back a failed migration without advancing the ledger", async () => {
    const client = new FakeClient();
    const migrations = [migration("001-fails.sql", "-- FAIL fixture")];

    await expect(
      migrate(fakePool(client) as never, { migrations }),
    ).rejects.toThrow("Migration 001-fails.sql failed");

    expect(client.ledger).toEqual([]);
    expect(client.queries).toContain("BEGIN");
    expect(client.queries).toContain("ROLLBACK");
  });

  it("fails loudly if an applied migration checksum changes", async () => {
    const client = new FakeClient();
    client.tables.add("schema_migration");
    client.ledger = [
      { filename: "001-one.sql", checksum: "changed", seeded: false },
    ];

    await expect(
      migrate(fakePool(client) as never, {
        migrations: [migration("001-one.sql")],
      }),
    ).rejects.toThrow("Checksum mismatch for 001-one.sql");
  });

  it("accepts only the documented historical checksum for the corrected 025 migration", async () => {
    const client = new FakeClient();
    client.tables.add("schema_migration");
    client.ledger = [
      {
        filename: "001-released.sql",
        checksum: "released-checksum",
        seeded: false,
      },
    ];
    const released = migration("001-released.sql", "-- corrected body");
    released.acceptedChecksums = ["released-checksum"];

    await expect(
      migrate(fakePool(client) as never, { migrations: [released] }),
    ).resolves.toEqual({ applied: [], seeded: [] });
  });

  it("declares only known released digests as production compatibility exceptions", async () => {
    const migrations = await loadMigrations();
    expect(
      migrations.find((value) => value.filename === "004-phase4.sql")
        ?.acceptedChecksums,
    ).toEqual([
      "77979b98be8e8fe644a48f8b5bc76ef5270d7d1c499249107bf7819c9ea46806",
    ]);
    expect(
      migrations.find((value) => value.filename === "013-analysis-context.sql")
        ?.acceptedChecksums,
    ).toEqual([
      "f6bf24d390a951478a0ce9d320640720fbd5a9720551961a5c78e1852de0796f",
    ]);
    expect(
      migrations.find(
        (value) => value.filename === "025-operational-status.sql",
      )?.acceptedChecksums,
    ).toEqual([
      "d6232c6285e28f3ddf31f26cadc8ccaf8fa59311f2c7a28ac15dbcbe9ffc9370",
    ]);
    expect(
      migrations.find((value) => value.filename === "030-paper-bot.sql")
        ?.acceptedChecksums,
    ).toEqual([
      "63cf83195c36cf8dddd5ff16d54b5bb80064214b322cdd20be58dd0d903cb2b7",
    ]);
  });

  it("can seed an idempotent corrective migration from its final constraint invariant", async () => {
    const client = new FakeClient();
    client.legacy = true;
    client.tables.add("foundation_schema_version");
    client.tables.add("backtest_run");
    client.constraints.set(
      "backtest_run.backtest_run_status_check",
      "CHECK ((status = ANY (ARRAY['PENDING', 'INTERRUPTED'])))",
    );
    const migrations = [
      migration("001-foundation.sql", "-- 001", [
        { table: "foundation_schema_version" },
      ]),
      migration("002-constraint-fix.sql", "-- 002", [
        {
          table: "backtest_run",
          constraint: {
            name: "backtest_run_status_check",
            definitionIncludes: "'INTERRUPTED'",
          },
        },
      ]),
    ];

    await expect(
      migrate(fakePool(client) as never, { migrations }),
    ).resolves.toEqual({
      applied: [],
      seeded: ["001-foundation.sql", "002-constraint-fix.sql"],
    });
  });

  it("verifies a scheduled Timescale procedure before seeding its migration", async () => {
    const client = new FakeClient();
    client.legacy = true;
    client.tables.add("foundation_schema_version");
    client.tables.add("retention_job_run");
    client.scheduledProcedures.add("run_scheduled_retention");
    const migrations = [
      migration("001-foundation.sql", "-- 001", [
        { table: "foundation_schema_version" },
      ]),
      migration("002-schedule.sql", "-- 002", [
        {
          table: "retention_job_run",
          scheduledProcedure: "run_scheduled_retention",
        },
      ]),
    ];

    await expect(
      migrate(fakePool(client) as never, { migrations }),
    ).resolves.toEqual({
      applied: [],
      seeded: ["001-foundation.sql", "002-schedule.sql"],
    });
  });

  it("does not seed a legacy migration when a required trigger is absent", async () => {
    const client = new FakeClient();
    client.legacy = true;
    client.tables.add("foundation_schema_version");
    client.tables.add("paper_funded_event");
    const migrations = [
      migration("001-foundation.sql", "-- 001", [
        { table: "foundation_schema_version" },
      ]),
      migration("002-trigger.sql", "-- 002", [
        {
          table: "paper_funded_event",
          triggers: ["paper_funded_event_checkpoint_count"],
        },
      ]),
    ];

    await expect(
      migrate(fakePool(client) as never, { migrations }),
    ).resolves.toEqual({
      applied: ["002-trigger.sql"],
      seeded: ["001-foundation.sql"],
    });
  });

  it("seeds only a verified legacy prefix, ignoring foundation version claims", async () => {
    const client = new FakeClient();
    client.legacy = true;
    client.tables.add("foundation_schema_version");
    const migrations = [
      migration("001-foundation.sql", "-- 001", [
        { table: "foundation_schema_version" },
      ]),
      migration("002-phase2.sql", "-- 002", [{ table: "instrument" }]),
    ];

    const result = await migrate(fakePool(client) as never, { migrations });

    expect(result).toEqual({
      applied: ["002-phase2.sql"],
      seeded: ["001-foundation.sql"],
    });
    expect(client.ledger).toEqual([
      expect.objectContaining({ filename: "001-foundation.sql", seeded: true }),
      expect.objectContaining({ filename: "002-phase2.sql", seeded: false }),
    ]);
  });

  it("refuses legacy schemas that have a later migration but miss an earlier one", async () => {
    const client = new FakeClient();
    client.legacy = true;
    client.tables.add("instrument");
    const migrations = [
      migration("001-foundation.sql", "-- 001", [
        { table: "foundation_schema_version" },
      ]),
      migration("002-phase2.sql", "-- 002", [{ table: "instrument" }]),
    ];

    const result = migrate(fakePool(client) as never, { migrations });
    await expect(result).rejects.toBeInstanceOf(MigrationError);
    await result.catch((error: unknown) =>
      expect(error).toHaveProperty(
        "message",
        expect.stringContaining("Legacy schema is inconsistent"),
      ),
    );
  });
});
