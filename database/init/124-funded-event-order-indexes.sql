-- Per-order and per-position event lookup indexes.
--
-- The FP01 outcome projector and the funded decision reconstruction look up
-- ledger events by `event->>'orderId'` / `event->>'positionId'` for one order
-- at a time. Without an index each lookup sequentially scans the account's
-- full event history, which reached ~1M rows per shared live account; the
-- projector runs two such queries per funded cycle, dominating the cycle
-- latency and starving the inbox drain. Both indexes are partial: only the
-- handful of RESERVE/RELEASE/BUY/SELL rows carry these keys, so the indexes
-- stay tiny against the MARK-dominated table.

CREATE INDEX IF NOT EXISTS paper_funded_event_account_order_idx
  ON paper_funded_event(account_id, (event->>'orderId'))
  WHERE event->>'orderId' IS NOT NULL;

CREATE INDEX IF NOT EXISTS paper_funded_event_account_position_idx
  ON paper_funded_event(account_id, (event->>'positionId'))
  WHERE event->>'positionId' IS NOT NULL;

INSERT INTO foundation_schema_version(version, description)
VALUES(124, 'Funded event order/position lookup indexes for bounded reconstruction')
ON CONFLICT(version) DO NOTHING;
