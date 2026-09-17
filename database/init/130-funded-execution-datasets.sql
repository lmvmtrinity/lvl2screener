-- FP02: immutable funded-execution learning persistence.
--
-- This schema is separate from the signal-quality training tables
-- (`statistical_training_dataset` and `statistical_training_dataset_member`).
-- A funded-execution dataset freezes qualified execution-quality rows from
-- validated version-2 funded decision evidence; a funded-execution challenger
-- is always inactive and never activation-eligible; a forward prediction binds
-- the exact model, artifact, observation and decision-input identity. Dataset,
-- member, challenger and prediction rows reject UPDATE and DELETE.
--
-- Amended in place during FP02-R1, FP02-R2, FP02-R3 and FP02-R4 after verifying
-- each time that migration 130 had only ever been applied to disposable test
-- databases (the retained application database remains at schema version 129).
-- FP02-R4 adds database-authoritative order-history capture, a database-owned
-- per-run applied-fact counter with complete/immutable `applied_sequence`
-- assignment, and an immutable causal replay knowledge boundary for each
-- historical-replay outcome version.

-- The funded-execution trainer is a distinct research job type so it can use
-- the existing durable queue, lease and idempotency-key deduplication.
ALTER TABLE research_job DROP CONSTRAINT IF EXISTS research_job_job_type_check;
ALTER TABLE research_job ADD CONSTRAINT research_job_job_type_check
  CHECK (job_type IN ('BACKTEST', 'CALIBRATION', 'RANKING_RESEARCH', 'STATISTICAL_TRAINING', 'COVERAGE_VERIFICATION', 'STRATEGY_STUDY', 'EXECUTION_DIAGNOSTICS', 'FUNDED_HISTORICAL_REPLAY', 'FUNDED_EXECUTION_TRAINING'));

-- Point-in-time entry terminality (FP02-R2) and immutable revision identity
-- (FP02-R3). A partial fill is only final when an immutable entry-order revision
-- proves further entry execution was impossible at the dataset cutoff. A
-- revision's `fact_at` alone cannot prove when it became known, so the capture
-- trigger records the database wall-clock `recorded_at` of each revision. Rows
-- written before this migration keep a NULL recording time: their knowledge time
-- is not provable and is never fabricated, so they cannot finalize a partial
-- fill.
--
-- An existing (order_id, revision) row is immutable: re-observing the exact
-- same fact/state is an idempotent no-op that preserves the original
-- `recorded_at`, while reusing the revision with different content fails
-- visibly. Direct UPDATE and DELETE are rejected by a database trigger.
--
-- FP02-R4: a row can only be captured through the production trigger on
-- `paper_entry_order`, or by an explicit insert that exactly matches the
-- current locked parent order revision. Caller-supplied `recorded_at`,
-- fabricated lower/higher revisions, backdated fact times and stale states are
-- rejected, and the recording time is always the database clock. Pre-130 rows
-- keep a NULL recording time and are never backfilled.
ALTER TABLE paper_entry_order_history
  ADD COLUMN IF NOT EXISTS recorded_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION capture_paper_entry_order_history() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  existing paper_entry_order_history%ROWTYPE;
BEGIN
  SELECT * INTO existing
    FROM paper_entry_order_history
   WHERE order_id=NEW.order_id AND revision=NEW.revision;
  IF FOUND THEN
    -- The exact revision already exists. An identical re-observation is a
    -- no-op; any different fact or state is a conflicting replay and fails.
    IF existing.fact_at IS DISTINCT FROM NEW.last_fact_at
       OR existing.state IS DISTINCT FROM NEW.state THEN
      RAISE EXCEPTION
        'Paper entry order revision % for order % already exists with different content',
        NEW.revision, NEW.order_id;
    END IF;
    RETURN NEW;
  END IF;
  -- The recording time is left to the history authority trigger, which always
  -- assigns the database clock and rejects a caller-supplied value.
  INSERT INTO paper_entry_order_history(order_id,revision,fact_at,state)
  VALUES(NEW.order_id,NEW.revision,NEW.last_fact_at,NEW.state);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION reject_paper_entry_order_history_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Paper entry order history is immutable';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS paper_entry_order_history_immutable
  ON paper_entry_order_history;
CREATE TRIGGER paper_entry_order_history_immutable
  BEFORE UPDATE OR DELETE ON paper_entry_order_history
  FOR EACH ROW EXECUTE FUNCTION reject_paper_entry_order_history_mutation();

-- Database-authoritative capture (FP02-R4). Every new history row must
-- represent the current locked parent order revision, fact time and state, and
-- its recording time is assigned from the database clock. A direct caller
-- cannot backdate a proof, fabricate a revision or supply a recording time.
CREATE OR REPLACE FUNCTION authorize_paper_entry_order_history_insert()
RETURNS trigger AS $$
DECLARE
  current_order paper_entry_order%ROWTYPE;
BEGIN
  IF NEW.recorded_at IS NOT NULL THEN
    RAISE EXCEPTION 'Paper entry order history recording time is database-owned';
  END IF;
  SELECT * INTO current_order
    FROM paper_entry_order
   WHERE order_id=NEW.order_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Paper entry order history requires its parent order';
  END IF;
  IF NEW.revision IS DISTINCT FROM current_order.revision
     OR NEW.fact_at IS DISTINCT FROM current_order.last_fact_at
     OR NEW.state IS DISTINCT FROM current_order.state THEN
    RAISE EXCEPTION
      'Paper entry order history must match the current locked order revision for order %',
      NEW.order_id;
  END IF;
  NEW.recorded_at := clock_timestamp();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS paper_entry_order_history_authority
  ON paper_entry_order_history;
CREATE TRIGGER paper_entry_order_history_authority
  BEFORE INSERT ON paper_entry_order_history
  FOR EACH ROW EXECUTE FUNCTION authorize_paper_entry_order_history_insert();

-- A replay's knowledge coordinate is the proven order in which its funded facts
-- were applied. FP02-R4 makes the sequence complete and database-owned: exactly
-- one per-run sequence is assigned in the same transaction in which a non-LATE
-- fact transitions to a processed outcome, covering the ordered drain's
-- acknowledgement, enqueue-side suppression, pre-submission reconciliation and
-- any recovered retry. A refused LATE_FACT stays unsequenced. Callers cannot
-- supply, change or clear a sequence.
--
-- The counter and its monotone knowledge frontier (the greatest fact time
-- applied so far) live on the run row and are advanced in the same transaction
-- as the fact they describe. A single-row transition advances them directly.
-- A bulk insert advances them once per run in a statement-level trigger and
-- assigns every inserted processed row in one set-based UPDATE; updating the
-- run row once per inserted row would build a quadratic HOT chain on the large
-- retained-history fixtures.
ALTER TABLE paper_funded_run
  ADD COLUMN IF NOT EXISTS applied_sequence_counter BIGINT NOT NULL DEFAULT 0
  CHECK(applied_sequence_counter >= 0);
ALTER TABLE paper_funded_run
  ADD COLUMN IF NOT EXISTS applied_frontier_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION guard_paper_funded_run_applied_sequence_counter()
RETURNS trigger AS $$
BEGIN
  IF NEW.applied_sequence_counter < OLD.applied_sequence_counter THEN
    RAISE EXCEPTION 'Funded run applied sequence counter cannot decrease';
  END IF;
  IF NEW.applied_frontier_at IS DISTINCT FROM OLD.applied_frontier_at THEN
    IF OLD.applied_frontier_at IS NOT NULL
       AND NEW.applied_frontier_at IS NOT NULL
       AND NEW.applied_frontier_at < OLD.applied_frontier_at THEN
      RAISE EXCEPTION 'Funded run applied fact frontier cannot decrease';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS paper_funded_run_applied_sequence_counter_guard
  ON paper_funded_run;
CREATE TRIGGER paper_funded_run_applied_sequence_counter_guard
  BEFORE UPDATE OF applied_sequence_counter, applied_frontier_at
  ON paper_funded_run
  FOR EACH ROW EXECUTE FUNCTION guard_paper_funded_run_applied_sequence_counter();

ALTER TABLE paper_funded_fact
  ADD COLUMN IF NOT EXISTS applied_sequence BIGINT CHECK(applied_sequence >= 1);

CREATE UNIQUE INDEX IF NOT EXISTS paper_funded_fact_applied_sequence_uq
  ON paper_funded_fact(run_id, applied_sequence)
  WHERE applied_sequence IS NOT NULL;

CREATE OR REPLACE FUNCTION assign_paper_funded_fact_applied_sequence()
RETURNS trigger AS $$
DECLARE
  processed_status TEXT;
  assigned BIGINT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- A caller may never choose a sequence; the statement-level trigger below
    -- assigns it from the locked run counter in this same transaction.
    IF NEW.applied_sequence IS NOT NULL THEN
      RAISE EXCEPTION 'Funded fact applied sequence is database-owned';
    END IF;
    RETURN NEW;
  END IF;

  -- The bulk insert assignment (statement-level trigger) fills sequences that
  -- were still unassigned; a direct caller never reaches this depth.
  IF pg_trigger_depth() > 1
     AND OLD.applied_sequence IS NULL
     AND NEW.applied_sequence IS NOT NULL
     AND NEW.outcome IS NOT DISTINCT FROM OLD.outcome THEN
    RETURN NEW;
  END IF;

  -- A previously assigned sequence is immutable, and a processed outcome may
  -- not be cleared or rewritten.
  IF NEW.applied_sequence IS DISTINCT FROM OLD.applied_sequence THEN
    RAISE EXCEPTION 'Funded fact applied sequence is immutable';
  END IF;
  IF OLD.outcome IS NULL AND NEW.outcome IS NOT NULL THEN
    processed_status := NEW.outcome->>'status';
    IF processed_status IS NOT NULL AND processed_status <> 'LATE_FACT' THEN
      UPDATE paper_funded_run
         SET applied_sequence_counter = applied_sequence_counter + 1,
             applied_frontier_at = GREATEST(
               COALESCE(applied_frontier_at, 'epoch'::timestamptz),
               NEW.fact_at
             )
       WHERE run_id = NEW.run_id
      RETURNING applied_sequence_counter INTO assigned;
      IF assigned IS NULL THEN
        RAISE EXCEPTION 'Funded fact % has no durable run counter', NEW.fact_id;
      END IF;
      NEW.applied_sequence := assigned;
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.outcome IS NOT NULL AND NEW.outcome IS DISTINCT FROM OLD.outcome THEN
    RAISE EXCEPTION 'Processed funded fact outcome is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS paper_funded_fact_applied_sequence
  ON paper_funded_fact;
CREATE TRIGGER paper_funded_fact_applied_sequence
  BEFORE INSERT OR UPDATE ON paper_funded_fact
  FOR EACH ROW EXECUTE FUNCTION assign_paper_funded_fact_applied_sequence();

CREATE OR REPLACE FUNCTION assign_inserted_paper_funded_fact_sequences()
RETURNS trigger AS $$
BEGIN
  WITH targets AS (
    SELECT run_id, fact_id, fact_at,
           row_number() OVER (
             PARTITION BY run_id
             ORDER BY fact_at, priority, sort_key COLLATE "C",
                      fact_id COLLATE "C"
           ) AS ordinal
      FROM new_facts
     WHERE outcome IS NOT NULL
       AND COALESCE(outcome->>'status', '') <> 'LATE_FACT'
  ),
  counted AS (
    SELECT run_id, count(*)::bigint AS assigned_count,
           max(fact_at) AS frontier_at
      FROM targets
     GROUP BY run_id
  ),
  locked AS (
    UPDATE paper_funded_run b
       SET applied_sequence_counter =
             b.applied_sequence_counter + counted.assigned_count,
           applied_frontier_at = GREATEST(
             COALESCE(b.applied_frontier_at, 'epoch'::timestamptz),
             counted.frontier_at
           )
      FROM counted
     WHERE b.run_id = counted.run_id
    RETURNING b.run_id, b.applied_sequence_counter AS counter_after
  )
  UPDATE paper_funded_fact f
     SET applied_sequence =
           locked.counter_after - counted.assigned_count + targets.ordinal
    FROM targets
    JOIN counted ON counted.run_id = targets.run_id
    JOIN locked ON locked.run_id = targets.run_id
   WHERE f.run_id = targets.run_id AND f.fact_id = targets.fact_id;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS paper_funded_fact_applied_sequence_insert
  ON paper_funded_fact;
CREATE TRIGGER paper_funded_fact_applied_sequence_insert
  AFTER INSERT ON paper_funded_fact
  REFERENCING NEW TABLE AS new_facts
  FOR EACH STATEMENT
  EXECUTE FUNCTION assign_inserted_paper_funded_fact_sequences();

-- The immutable causal knowledge boundary of every historical-replay outcome
-- version used by training. It binds the exact owning run and the proven
-- applied fact that made the version knowable at the moment it was recorded,
-- never an economic timestamp inferred from the outcome. A superseding
-- correction receives its own boundary, so a correction learned after a
-- holdout is excluded even when its economic time predates the holdout. Live
-- capture keeps both columns NULL: its knowledge is the database capture time.
ALTER TABLE funded_decision_outcome
  ADD COLUMN IF NOT EXISTS knowledge_applied_sequence BIGINT
    CHECK(knowledge_applied_sequence >= 1);
ALTER TABLE funded_decision_outcome
  ADD COLUMN IF NOT EXISTS knowledge_at TIMESTAMPTZ;

ALTER TABLE funded_decision_outcome
  DROP CONSTRAINT IF EXISTS funded_decision_outcome_knowledge_pairing_check;
ALTER TABLE funded_decision_outcome
  ADD CONSTRAINT funded_decision_outcome_knowledge_pairing_check CHECK(
    (knowledge_applied_sequence IS NULL AND knowledge_at IS NULL) OR
    (knowledge_applied_sequence IS NOT NULL AND knowledge_at IS NOT NULL)
  );

CREATE OR REPLACE FUNCTION assign_funded_decision_outcome_knowledge_boundary()
RETURNS trigger AS $$
DECLARE
  decision_source TEXT;
  assigned BIGINT;
  matched BIGINT;
  boundary_at TIMESTAMPTZ;
BEGIN
  SELECT d.source_kind INTO decision_source
    FROM funded_decision_evidence d
   WHERE d.run_id=NEW.run_id AND d.observation_id=NEW.observation_id;
  IF decision_source IS NULL THEN
    RAISE EXCEPTION 'Funded outcome has no owning decision';
  END IF;
  IF decision_source <> 'HISTORICAL_REPLAY' THEN
    IF NEW.knowledge_applied_sequence IS NOT NULL OR NEW.knowledge_at IS NOT NULL THEN
      RAISE EXCEPTION 'Live funded outcome knowledge is database capture, not a replay boundary';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.knowledge_applied_sequence IS NOT NULL OR NEW.knowledge_at IS NOT NULL THEN
    RAISE EXCEPTION 'Replay funded outcome boundary is database-owned';
  END IF;
  SELECT b.applied_sequence_counter, b.applied_frontier_at
    INTO assigned, boundary_at
    FROM paper_funded_run b
   WHERE b.run_id=NEW.run_id
   FOR UPDATE;
  IF assigned IS NULL OR assigned < 1 OR boundary_at IS NULL THEN
    RAISE EXCEPTION 'Replay funded outcome has no proven applied fact boundary';
  END IF;
  -- The boundary is the run's monotone knowledge frontier of every fact
  -- applied up to that sequence. Enqueue-side reconciliation can assign a
  -- sequence before an earlier-timestamped pending fact is drained, so the
  -- frontier (not the counter fact's own time) is the provable causal
  -- boundary. The exact counter fact must still exist, proving the sequence
  -- itself is durable.
  SELECT count(*) INTO matched
    FROM paper_funded_fact f
   WHERE f.run_id=NEW.run_id AND f.applied_sequence=assigned;
  IF matched = 0 THEN
    RAISE EXCEPTION 'Replay funded outcome applied fact boundary is not durable';
  END IF;
  NEW.knowledge_applied_sequence := assigned;
  NEW.knowledge_at := boundary_at;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS funded_decision_outcome_knowledge_boundary
  ON funded_decision_outcome;
CREATE TRIGGER funded_decision_outcome_knowledge_boundary
  BEFORE INSERT ON funded_decision_outcome
  FOR EACH ROW EXECUTE FUNCTION assign_funded_decision_outcome_knowledge_boundary();

CREATE TABLE IF NOT EXISTS funded_execution_dataset (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id TEXT NOT NULL CHECK(market_id IN ('CA_TSX','US_EQUITIES')),
  currency TEXT NOT NULL CHECK(currency IN ('CAD','USD')),
  source_kind TEXT NOT NULL CHECK(source_kind IN ('LIVE_PAPER','HISTORICAL_REPLAY')),
  evidence_schema_version INTEGER NOT NULL CHECK(evidence_schema_version = 2),
  cohort_digest TEXT NOT NULL CHECK(cohort_digest ~ '^[a-f0-9]{64}$'),
  cohort_components JSONB NOT NULL,
  dataset_policy_version TEXT NOT NULL,
  label_mapping_version TEXT NOT NULL,
  feature_version TEXT NOT NULL,
  qualification_policy_version TEXT NOT NULL,
  requested_cutoff TIMESTAMPTZ NOT NULL,
  effective_cutoff TIMESTAMPTZ NOT NULL,
  membership_digest TEXT NOT NULL CHECK(membership_digest ~ '^[a-f0-9]{64}$'),
  dataset_digest TEXT NOT NULL CHECK(dataset_digest ~ '^[a-f0-9]{64}$'),
  row_count INTEGER NOT NULL CHECK(row_count >= 0),
  counts JSONB NOT NULL,
  qualification_receipt JSONB NOT NULL,
  source_watermark JSONB NOT NULL,
  activation_eligible BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (dataset_digest),
  -- Reusing the same market/cohort/cutoff with different frozen content is a
  -- conflicting retry, never a second dataset.
  UNIQUE (market_id, cohort_digest, effective_cutoff),
  UNIQUE (id, market_id),
  UNIQUE (id, currency),
  UNIQUE (id, cohort_digest),
  CONSTRAINT funded_execution_dataset_market_currency_check CHECK(
    (market_id = 'CA_TSX' AND currency = 'CAD') OR
    (market_id = 'US_EQUITIES' AND currency = 'USD')
  ),
  CONSTRAINT funded_execution_dataset_cutoff_check CHECK(
    effective_cutoff <= requested_cutoff
  ),
  CONSTRAINT funded_execution_dataset_cohort_check CHECK(
    jsonb_typeof(cohort_components) = 'object'
  ),
  CONSTRAINT funded_execution_dataset_counts_check CHECK(
    jsonb_typeof(counts) = 'object'
  ),
  CONSTRAINT funded_execution_dataset_receipt_check CHECK(
    jsonb_typeof(qualification_receipt) = 'object'
  ),
  CONSTRAINT funded_execution_dataset_watermark_check CHECK(
    jsonb_typeof(source_watermark) = 'object'
  )
);

CREATE INDEX IF NOT EXISTS funded_execution_dataset_cohort_idx
  ON funded_execution_dataset(market_id, cohort_digest, effective_cutoff DESC);

CREATE TABLE IF NOT EXISTS funded_execution_dataset_member (
  dataset_id UUID NOT NULL REFERENCES funded_execution_dataset(id) ON DELETE RESTRICT,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  market_id TEXT NOT NULL CHECK(market_id IN ('CA_TSX','US_EQUITIES')),
  currency TEXT NOT NULL CHECK(currency IN ('CAD','USD')),
  run_id UUID NOT NULL,
  observation_id UUID NOT NULL,
  account_id UUID NOT NULL,
  decision_sequence INTEGER NOT NULL CHECK(decision_sequence > 0),
  decision_content_digest TEXT NOT NULL CHECK(decision_content_digest ~ '^[a-f0-9]{64}$'),
  cohort_digest TEXT NOT NULL CHECK(cohort_digest ~ '^[a-f0-9]{64}$'),
  evidence_schema_version INTEGER NOT NULL CHECK(evidence_schema_version = 2),
  instrument_id UUID,
  decision_at TIMESTAMPTZ NOT NULL,
  session_date DATE NOT NULL,
  partition TEXT NOT NULL CHECK(partition IN ('TRAIN','TEST')),
  label_available_at TIMESTAMPTZ NOT NULL,
  label_economic_at TIMESTAMPTZ NOT NULL,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('LIVE_PAPER','HISTORICAL_REPLAY')),
  label_mapping_version TEXT NOT NULL,
  feature_version TEXT NOT NULL,
  features JSONB NOT NULL,
  labels JSONB NOT NULL,
  outcome_sequences INTEGER[] NOT NULL,
  outcome_source_digests TEXT[] NOT NULL,
  row_digest TEXT NOT NULL CHECK(row_digest ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (dataset_id, ordinal),
  UNIQUE (dataset_id, run_id, observation_id),
  UNIQUE (dataset_id, row_digest),
  CONSTRAINT funded_execution_member_market_currency_check CHECK(
    (market_id = 'CA_TSX' AND currency = 'CAD') OR
    (market_id = 'US_EQUITIES' AND currency = 'USD')
  ),
  CONSTRAINT funded_execution_member_features_check CHECK(
    jsonb_typeof(features) = 'object'
  ),
  CONSTRAINT funded_execution_member_labels_check CHECK(
    jsonb_typeof(labels) = 'object'
  ),
  CONSTRAINT funded_execution_member_outcome_pairing_check CHECK(
    cardinality(outcome_sequences) = cardinality(outcome_source_digests)
  ),
  FOREIGN KEY (dataset_id, market_id)
    REFERENCES funded_execution_dataset(id, market_id),
  FOREIGN KEY (dataset_id, currency)
    REFERENCES funded_execution_dataset(id, currency),
  FOREIGN KEY (run_id, market_id)
    REFERENCES paper_bot_run(id, market_id),
  FOREIGN KEY (run_id, account_id, currency)
    REFERENCES paper_funded_run(run_id, account_id, currency),
  FOREIGN KEY (run_id, observation_id)
    REFERENCES funded_decision_evidence(run_id, observation_id)
);

CREATE INDEX IF NOT EXISTS funded_execution_member_partition_idx
  ON funded_execution_dataset_member(dataset_id, partition, ordinal);

CREATE TABLE IF NOT EXISTS funded_execution_challenger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id TEXT NOT NULL CHECK(market_id IN ('CA_TSX','US_EQUITIES')),
  currency TEXT NOT NULL CHECK(currency IN ('CAD','USD')),
  cohort_digest TEXT NOT NULL CHECK(cohort_digest ~ '^[a-f0-9]{64}$'),
  cohort_components JSONB NOT NULL,
  dataset_id UUID NOT NULL REFERENCES funded_execution_dataset(id) ON DELETE RESTRICT,
  dataset_digest TEXT NOT NULL CHECK(dataset_digest ~ '^[a-f0-9]{64}$'),
  model_version TEXT NOT NULL,
  model_type TEXT NOT NULL CHECK(model_type = 'FUNDED_EXECUTION_QUALITY'),
  artifact_digest TEXT NOT NULL CHECK(artifact_digest ~ '^[a-f0-9]{64}$'),
  feature_version TEXT NOT NULL,
  label_mapping_version TEXT NOT NULL,
  qualification_policy_version TEXT NOT NULL,
  training_policy_version TEXT NOT NULL,
  training_code_version TEXT NOT NULL,
  runtime_fingerprint TEXT,
  status TEXT NOT NULL CONSTRAINT funded_execution_challenger_status_enum_check CHECK(status IN ('INACTIVE','FAILED')),
  eligible_for_activation BOOLEAN NOT NULL DEFAULT false CHECK(eligible_for_activation = false),
  active BOOLEAN NOT NULL DEFAULT false CHECK(active = false),
  artifact JSONB,
  metrics JSONB,
  sample_counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  failure_receipt TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One training attempt per frozen dataset digest. A failed attempt stays
  -- visible and is never silently retried into a second artifact.
  UNIQUE (dataset_digest),
  CONSTRAINT funded_execution_challenger_market_currency_check CHECK(
    (market_id = 'CA_TSX' AND currency = 'CAD') OR
    (market_id = 'US_EQUITIES' AND currency = 'USD')
  ),
  CONSTRAINT funded_execution_challenger_status_check CHECK(
    (status = 'INACTIVE' AND artifact IS NOT NULL AND failure_receipt IS NULL) OR
    (status = 'FAILED' AND failure_receipt IS NOT NULL)
  ),
  CONSTRAINT funded_execution_challenger_cohort_check CHECK(
    jsonb_typeof(cohort_components) = 'object'
  ),
  CONSTRAINT funded_execution_challenger_artifact_check CHECK(
    artifact IS NULL OR jsonb_typeof(artifact) = 'object'
  ),
  CONSTRAINT funded_execution_challenger_sample_counts_check CHECK(
    jsonb_typeof(sample_counts) = 'object'
  ),
  FOREIGN KEY (dataset_id, cohort_digest)
    REFERENCES funded_execution_dataset(id, cohort_digest),
  FOREIGN KEY (dataset_id, market_id)
    REFERENCES funded_execution_dataset(id, market_id),
  FOREIGN KEY (dataset_id, currency)
    REFERENCES funded_execution_dataset(id, currency)
);

CREATE INDEX IF NOT EXISTS funded_execution_challenger_market_idx
  ON funded_execution_challenger(market_id, cohort_digest, created_at DESC);

-- A forward prediction must bind the actual immutable challenger and funded
-- decision evidence row. These unique indexes let the prediction table prove
-- that relationship with composite foreign keys instead of trusting caller
-- identity values.
CREATE UNIQUE INDEX IF NOT EXISTS funded_execution_challenger_prediction_binding_uq
  ON funded_execution_challenger(
    id, model_version, model_type, artifact_digest, feature_version,
    cohort_digest, market_id, currency
  );

CREATE UNIQUE INDEX IF NOT EXISTS funded_decision_evidence_prediction_binding_uq
  ON funded_decision_evidence(
    run_id, observation_id, sequence, content_digest, market_id, currency,
    source_kind, decision_at
  );

CREATE TABLE IF NOT EXISTS funded_execution_prediction (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id TEXT NOT NULL CHECK(market_id IN ('CA_TSX','US_EQUITIES')),
  currency TEXT NOT NULL CHECK(currency IN ('CAD','USD')),
  model_id UUID NOT NULL,
  model_version TEXT NOT NULL,
  model_type TEXT NOT NULL CHECK(model_type = 'FUNDED_EXECUTION_QUALITY'),
  artifact_digest TEXT NOT NULL CHECK(artifact_digest ~ '^[a-f0-9]{64}$'),
  cohort_digest TEXT NOT NULL CHECK(cohort_digest ~ '^[a-f0-9]{64}$'),
  feature_version TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('LIVE_PAPER','HISTORICAL_REPLAY')),
  run_id UUID NOT NULL,
  observation_id UUID NOT NULL,
  decision_sequence INTEGER NOT NULL CHECK(decision_sequence > 0),
  decision_input_digest TEXT NOT NULL CHECK(decision_input_digest ~ '^[a-f0-9]{64}$'),
  decision_at TIMESTAMPTZ NOT NULL,
  -- Database-owned prediction time. The authority trigger overwrites any
  -- caller-supplied value with the actual wall-clock time at the insert
  -- (`clock_timestamp()`), not the transaction start time, so a transaction
  -- that began before the deadline cannot insert after it.
  prediction_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  deadline_at TIMESTAMPTZ NOT NULL,
  output JSONB NOT NULL,
  warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
  digest TEXT NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (model_id, run_id, observation_id, decision_sequence),
  CONSTRAINT funded_execution_prediction_market_currency_check CHECK(
    (market_id = 'CA_TSX' AND currency = 'CAD') OR
    (market_id = 'US_EQUITIES' AND currency = 'USD')
  ),
  CONSTRAINT funded_execution_prediction_timing_check CHECK(
    decision_at <= prediction_at AND prediction_at <= deadline_at
  ),
  CONSTRAINT funded_execution_prediction_output_check CHECK(
    jsonb_typeof(output) = 'object'
  ),
  CONSTRAINT funded_execution_prediction_warnings_check CHECK(
    jsonb_typeof(warnings) = 'array'
  ),
  -- The challenger columns must match the persisted challenger row exactly.
  FOREIGN KEY (
    model_id, model_version, model_type, artifact_digest, feature_version,
    cohort_digest, market_id, currency
  ) REFERENCES funded_execution_challenger(
    id, model_version, model_type, artifact_digest, feature_version,
    cohort_digest, market_id, currency
  ),
  -- The decision columns must match the persisted version-2 evidence row
  -- exactly: run/observation ownership, sequence, content digest, market,
  -- currency, source and decision time.
  FOREIGN KEY (
    run_id, observation_id, decision_sequence, decision_input_digest,
    market_id, currency, source_kind, decision_at
  ) REFERENCES funded_decision_evidence(
    run_id, observation_id, sequence, content_digest, market_id, currency,
    source_kind, decision_at
  )
);

CREATE INDEX IF NOT EXISTS funded_execution_prediction_observation_idx
  ON funded_execution_prediction(market_id, cohort_digest, run_id, observation_id);

CREATE OR REPLACE FUNCTION funded_execution_prediction_authority()
RETURNS trigger AS $$
DECLARE
  challenger_created_at TIMESTAMPTZ;
BEGIN
  SELECT created_at INTO challenger_created_at
    FROM funded_execution_challenger WHERE id = NEW.model_id;
  IF challenger_created_at IS NULL THEN
    RAISE EXCEPTION 'Prediction challenger does not exist';
  END IF;
  IF challenger_created_at > NEW.decision_at THEN
    RAISE EXCEPTION 'Prediction cannot precede its challenger';
  END IF;
  -- Database-owned wall clock: a caller-supplied prediction time is discarded,
  -- and the actual time immediately before insert is what the deadline check
  -- compares against.
  NEW.prediction_at := clock_timestamp();
  IF NEW.prediction_at < NEW.decision_at THEN
    RAISE EXCEPTION 'Prediction cannot precede the decision';
  END IF;
  IF NEW.prediction_at > NEW.deadline_at THEN
    RAISE EXCEPTION 'Prediction is after its deadline';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS funded_execution_prediction_authority_trigger ON funded_execution_prediction;
CREATE TRIGGER funded_execution_prediction_authority_trigger
  BEFORE INSERT ON funded_execution_prediction
  FOR EACH ROW EXECUTE FUNCTION funded_execution_prediction_authority();

CREATE OR REPLACE FUNCTION reject_funded_execution_learning_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Funded execution learning rows are immutable';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS funded_execution_dataset_immutable ON funded_execution_dataset;
CREATE TRIGGER funded_execution_dataset_immutable
  BEFORE UPDATE OR DELETE ON funded_execution_dataset
  FOR EACH ROW EXECUTE FUNCTION reject_funded_execution_learning_mutation();

DROP TRIGGER IF EXISTS funded_execution_dataset_member_immutable ON funded_execution_dataset_member;
CREATE TRIGGER funded_execution_dataset_member_immutable
  BEFORE UPDATE OR DELETE ON funded_execution_dataset_member
  FOR EACH ROW EXECUTE FUNCTION reject_funded_execution_learning_mutation();

DROP TRIGGER IF EXISTS funded_execution_challenger_immutable ON funded_execution_challenger;
CREATE TRIGGER funded_execution_challenger_immutable
  BEFORE UPDATE OR DELETE ON funded_execution_challenger
  FOR EACH ROW EXECUTE FUNCTION reject_funded_execution_learning_mutation();

DROP TRIGGER IF EXISTS funded_execution_prediction_immutable ON funded_execution_prediction;
CREATE TRIGGER funded_execution_prediction_immutable
  BEFORE UPDATE OR DELETE ON funded_execution_prediction
  FOR EACH ROW EXECUTE FUNCTION reject_funded_execution_learning_mutation();

INSERT INTO foundation_schema_version(version, description)
VALUES(130, 'Funded execution datasets, inactive challengers and forward predictions')
ON CONFLICT(version) DO NOTHING;
