-- FP01-R4: durable decision refusal source and chronological boundary.
--
-- A refusal (DECLINE/DEFER) is determined before its intent can be written.
-- This table retains the exact action, reason, decision time and ownership
-- plus the proven chronological ledger cursor in its own committed
-- transaction, so a failure before the intent INSERT never consumes the
-- opportunity: repair reconstructs the intent and decision from this row.
--
-- Historical refusals are written when the funded inbox reaches their
-- pre-submission cancellation in the same ordered chronology used for
-- execution, so the cursor already reflects every earlier funded effect and
-- none of the later facts. Live refusals write the row at determination time.
-- The row is immutable: it is never rewritten, renumbered or deleted.

CREATE TABLE IF NOT EXISTS funded_decision_refusal (
  run_id UUID NOT NULL,
  observation_id UUID NOT NULL,
  sequence_cursor BIGINT NOT NULL CHECK(sequence_cursor >= 0),
  market_id TEXT NOT NULL CHECK(market_id IN ('CA_TSX','US_EQUITIES')),
  currency TEXT NOT NULL CHECK(currency IN ('CAD','USD')),
  account_id UUID NOT NULL,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('LIVE_PAPER','HISTORICAL_REPLAY')),
  action TEXT NOT NULL CHECK(action IN ('DECLINE','DEFER')),
  policy_reason TEXT NOT NULL CHECK(length(btrim(policy_reason)) > 0),
  decision_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, observation_id),
  CONSTRAINT funded_decision_refusal_market_currency_check CHECK(
    (market_id = 'CA_TSX' AND currency = 'CAD') OR
    (market_id = 'US_EQUITIES' AND currency = 'USD')
  ),
  CONSTRAINT funded_decision_refusal_recorded_check CHECK(recorded_at >= decision_at),
  FOREIGN KEY (run_id, market_id)
    REFERENCES paper_bot_run(id, market_id),
  FOREIGN KEY (run_id, account_id, currency)
    REFERENCES paper_funded_run(run_id, account_id, currency),
  FOREIGN KEY (run_id, observation_id)
    REFERENCES paper_signal_observation(run_id, id)
);

CREATE INDEX IF NOT EXISTS funded_decision_refusal_pending_idx
  ON funded_decision_refusal(run_id, decision_at, observation_id);

DROP TRIGGER IF EXISTS funded_decision_refusal_immutable ON funded_decision_refusal;
CREATE TRIGGER funded_decision_refusal_immutable
  BEFORE UPDATE OR DELETE ON funded_decision_refusal
  FOR EACH ROW EXECUTE FUNCTION reject_funded_learning_evidence_mutation();

INSERT INTO foundation_schema_version(version, description)
VALUES(128, 'Durable funded decision refusal source and chronological boundary')
ON CONFLICT(version) DO NOTHING;
