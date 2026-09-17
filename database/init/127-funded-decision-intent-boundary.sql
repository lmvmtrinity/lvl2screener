-- FP01 remediation R3:
-- 1. Run-local decision-sequence uniqueness is database-owned. Repository
--    locking normally serializes allocation, but the frozen contract says the
--    database owns the sequence, so the constraint proves it.
-- 2. A versioned evidence schema marker separates v2 rows (which retain the
--    exact requested capital constraints and the durable decision boundary)
--    from immutable v1 rows. Existing v1 rows stay unchanged and unavailable
--    to learning consumers; they are never rewritten or defaulted.
-- 3. Durable decision intents retain action, exact reason, decision time,
--    ownership and the per-decision ledger sequence cursor before any
--    best-effort projection. A restart can therefore repair a lost decision
--    with the exact original action, reason, timestamp and boundary.

-- Fail closed with an explicit diagnostic when duplicate run-local sequences
-- already exist. Immutable evidence is never renumbered or deleted.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM funded_decision_evidence
     GROUP BY run_id, sequence
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'funded_decision_evidence contains duplicate run-local decision sequences; resolve before applying migration 127';
  END IF;
END $$;

ALTER TABLE funded_decision_evidence
  ADD CONSTRAINT funded_decision_evidence_run_sequence_uq
  UNIQUE (run_id, sequence);

-- Existing rows predate retention of the requested capital constraints and the
-- durable boundary, so the column default is the legacy version. New rows are
-- inserted explicitly with version 2 by the capture boundary.
ALTER TABLE funded_decision_evidence
  ADD COLUMN IF NOT EXISTS evidence_schema_version INTEGER NOT NULL DEFAULT 1
    CHECK (evidence_schema_version IN (1, 2));

CREATE TABLE IF NOT EXISTS funded_decision_intent (
  run_id UUID NOT NULL,
  observation_id UUID NOT NULL,
  sequence_cursor BIGINT NOT NULL CHECK(sequence_cursor >= 0),
  market_id TEXT NOT NULL CHECK(market_id IN ('CA_TSX','US_EQUITIES')),
  currency TEXT NOT NULL CHECK(currency IN ('CAD','USD')),
  account_id UUID NOT NULL,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('LIVE_PAPER','HISTORICAL_REPLAY')),
  action TEXT NOT NULL CHECK(action IN ('SUBMIT','DECLINE','DEFER')),
  policy_reason TEXT,
  decision_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, observation_id),
  CONSTRAINT funded_decision_intent_reason_check CHECK(
    (action = 'SUBMIT') = (policy_reason IS NULL)
  ),
  CONSTRAINT funded_decision_intent_market_currency_check CHECK(
    (market_id = 'CA_TSX' AND currency = 'CAD') OR
    (market_id = 'US_EQUITIES' AND currency = 'USD')
  ),
  CONSTRAINT funded_decision_intent_recorded_check CHECK(recorded_at >= decision_at),
  FOREIGN KEY (run_id, market_id)
    REFERENCES paper_bot_run(id, market_id),
  FOREIGN KEY (run_id, account_id, currency)
    REFERENCES paper_funded_run(run_id, account_id, currency),
  FOREIGN KEY (run_id, observation_id)
    REFERENCES paper_signal_observation(run_id, id)
);

CREATE INDEX IF NOT EXISTS funded_decision_intent_pending_idx
  ON funded_decision_intent(run_id, decision_at, observation_id);

DROP TRIGGER IF EXISTS funded_decision_intent_immutable ON funded_decision_intent;
CREATE TRIGGER funded_decision_intent_immutable
  BEFORE UPDATE OR DELETE ON funded_decision_intent
  FOR EACH ROW EXECUTE FUNCTION reject_funded_learning_evidence_mutation();

INSERT INTO foundation_schema_version(version, description)
VALUES(127, 'Funded decision intents, sequence uniqueness and evidence schema version')
ON CONFLICT(version) DO NOTHING;
