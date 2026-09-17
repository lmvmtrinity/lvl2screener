-- 054-strategy-retention-optimization.sql
-- Optimizes database storage by reducing high-frequency strategy_evaluation and
-- strategy_signal retention from 90 days to 14 days. Raw 2-second evaluations
-- generate ~1.17M rows per trading day (~4-5 GB/day).
-- Signal state transitions (strategy_state_event) and paper bot evidence remain protected.

UPDATE observability_retention_policy
SET retention_days = 14
WHERE table_name IN ('strategy_evaluation', 'strategy_signal');
