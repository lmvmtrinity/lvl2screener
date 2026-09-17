-- Corrected-strategy regeneration is a separate workflow from execution-only
-- fill replay. Both retain immutable source/replacement lineage, but the mode
-- records which source of signals produced the replacement evidence.
ALTER TABLE paper_evidence_regeneration
  DROP CONSTRAINT IF EXISTS paper_evidence_regeneration_mode_check;

ALTER TABLE paper_evidence_regeneration
  ADD CONSTRAINT paper_evidence_regeneration_mode_check
  CHECK (mode IN ('FILL_ONLY', 'CORRECTED_STRATEGY'));
