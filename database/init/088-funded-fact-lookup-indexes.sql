-- Funded intake repeats these lookups for every observation/new fact. The
-- pending-only chronology index cannot serve acknowledged-history lookups.
CREATE INDEX paper_funded_fact_processed_time
  ON paper_funded_fact (run_id, fact_at DESC)
  WHERE outcome IS NOT NULL;

-- Keep both branches of the signal/suppression lookup indexable; the signal
-- branch already uses the primary key. Preserve the exact suppression predicate.
CREATE INDEX paper_funded_fact_pre_submission_order
  ON paper_funded_fact (run_id, (fact->>'orderId'))
  WHERE fact->>'type'='CANCEL' AND fact->'preSubmissionEventId' IS NOT NULL;

-- The collection watermark includes enqueued clocks, even before acknowledgement.
CREATE INDEX paper_funded_fact_collection_clock
  ON paper_funded_fact (run_id, fact_at DESC)
  WHERE fact->>'type'='CLOCK' AND fact_id LIKE 'funded-clock:%';
