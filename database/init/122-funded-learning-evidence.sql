-- FP01: immutable funded decision evidence and append-only outcome versions.
-- This is a read model. It describes funded decisions and their later outcomes;
-- it cannot create, change or reverse an order or ledger effect. Both tables
-- reject UPDATE and DELETE so evidence history is append-only.

-- Composite ownership keys required by the evidence foreign keys. The primary
-- key on id remains authoritative; these only let the schema prove that a
-- decision's run, market, account, currency and observation all agree with the
-- existing funded and paper-bot ownership rows.
CREATE UNIQUE INDEX IF NOT EXISTS paper_signal_observation_run_identity_uq
  ON paper_signal_observation(run_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS paper_bot_run_identity_market_uq
  ON paper_bot_run(id, market_id);
CREATE UNIQUE INDEX IF NOT EXISTS paper_funded_run_ownership_uq
  ON paper_funded_run(run_id, account_id, currency);

CREATE TABLE IF NOT EXISTS funded_decision_evidence (
  run_id UUID NOT NULL,
  observation_id UUID NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence > 0),
  market_id TEXT NOT NULL CHECK(market_id IN ('CA_TSX','US_EQUITIES')),
  currency TEXT NOT NULL CHECK(currency IN ('CAD','USD')),
  account_id UUID NOT NULL,
  funded_policy_version TEXT NOT NULL,
  execution_model_version TEXT NOT NULL,
  feature_version TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('LIVE_PAPER','HISTORICAL_REPLAY')),
  action TEXT NOT NULL CHECK(action IN ('SUBMIT','DECLINE','DEFER')),
  decision_at TIMESTAMPTZ NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  content_digest TEXT NOT NULL CHECK(content_digest ~ '^[a-f0-9]{64}$'),
  decision_content JSONB NOT NULL,
  cohort_digest TEXT NOT NULL CHECK(cohort_digest ~ '^[a-f0-9]{64}$'),
  cohort_components JSONB NOT NULL,
  PRIMARY KEY (run_id, observation_id, sequence),
  UNIQUE (run_id, observation_id),
  CONSTRAINT funded_decision_evidence_market_currency_check CHECK(
    (market_id = 'CA_TSX' AND currency = 'CAD') OR
    (market_id = 'US_EQUITIES' AND currency = 'USD')
  ),
  CONSTRAINT funded_decision_evidence_captured_check CHECK(captured_at >= decision_at),
  CONSTRAINT funded_decision_evidence_content_check CHECK(jsonb_typeof(decision_content) = 'object'),
  CONSTRAINT funded_decision_evidence_cohort_check CHECK(jsonb_typeof(cohort_components) = 'object'),
  FOREIGN KEY (run_id, market_id)
    REFERENCES paper_bot_run(id, market_id),
  FOREIGN KEY (run_id, account_id, currency)
    REFERENCES paper_funded_run(run_id, account_id, currency),
  FOREIGN KEY (run_id, observation_id)
    REFERENCES paper_signal_observation(run_id, id)
);

CREATE INDEX IF NOT EXISTS funded_decision_evidence_market_idx
  ON funded_decision_evidence(market_id, cohort_digest, decision_at);

CREATE TABLE IF NOT EXISTS funded_decision_outcome (
  run_id UUID NOT NULL,
  observation_id UUID NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence > 0),
  status TEXT NOT NULL CHECK(status IN (
    'DECISION_ACCEPTED','POLICY_DECLINED','POLICY_DEFERRED','RISK_VETOED',
    'EXPIRED','NO_EXECUTABLE_QUOTE','NO_FILL','PARTIAL_FILL','FILLED','CLOSED',
    'UNRESOLVED'
  )),
  source_kind TEXT NOT NULL CHECK(source_kind IN ('LIVE_PAPER','HISTORICAL_REPLAY')),
  source_id TEXT NOT NULL,
  source_digest TEXT NOT NULL CHECK(source_digest ~ '^[a-f0-9]{64}$'),
  available_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  supersedes_sequence INTEGER CHECK(supersedes_sequence > 0),
  reason TEXT,
  detail JSONB,
  PRIMARY KEY (run_id, observation_id, sequence),
  UNIQUE (run_id, observation_id, source_kind, source_id),
  CONSTRAINT funded_decision_outcome_resolved_reason_check CHECK(
    status <> 'UNRESOLVED' OR (reason IS NOT NULL AND length(btrim(reason)) > 0)
  ),
  CONSTRAINT funded_decision_outcome_recorded_check CHECK(recorded_at >= available_at),
  CONSTRAINT funded_decision_outcome_supersedes_check CHECK(
    supersedes_sequence IS NULL OR supersedes_sequence < sequence
  ),
  CONSTRAINT funded_decision_outcome_detail_check CHECK(
    detail IS NULL OR jsonb_typeof(detail) = 'object'
  ),
  FOREIGN KEY (run_id, observation_id)
    REFERENCES funded_decision_evidence(run_id, observation_id),
  FOREIGN KEY (run_id, observation_id, supersedes_sequence)
    REFERENCES funded_decision_outcome(run_id, observation_id, sequence)
);

CREATE INDEX IF NOT EXISTS funded_decision_outcome_decision_idx
  ON funded_decision_outcome(run_id, observation_id, sequence);

CREATE OR REPLACE FUNCTION reject_funded_learning_evidence_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Funded learning evidence is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS funded_decision_evidence_immutable ON funded_decision_evidence;
CREATE TRIGGER funded_decision_evidence_immutable
  BEFORE UPDATE OR DELETE ON funded_decision_evidence
  FOR EACH ROW EXECUTE FUNCTION reject_funded_learning_evidence_mutation();

DROP TRIGGER IF EXISTS funded_decision_outcome_immutable ON funded_decision_outcome;
CREATE TRIGGER funded_decision_outcome_immutable
  BEFORE UPDATE OR DELETE ON funded_decision_outcome
  FOR EACH ROW EXECUTE FUNCTION reject_funded_learning_evidence_mutation();

INSERT INTO foundation_schema_version(version, description)
VALUES(122, 'Funded decision evidence and append-only outcome versions')
ON CONFLICT(version) DO NOTHING;
