-- The funded operational snapshot counts pending, vetoed and late facts per
-- account every live cycle. Those aggregates filter by run and outcome status;
-- without a status index each poll scanned every processed fact for the account.
CREATE INDEX paper_funded_fact_outcome_status_idx
  ON paper_funded_fact (run_id, (outcome->>'status'))
  WHERE outcome IS NOT NULL;

INSERT INTO foundation_schema_version(version, description)
VALUES(113, 'Funded operational snapshot outcome-status index')
ON CONFLICT (version) DO NOTHING;
