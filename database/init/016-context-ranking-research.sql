-- Phase 6 starts by retaining explicit, versioned context evidence. Historical
-- rows remain readable as legacy context scores; new writes include the raw
-- per-horizon inputs, neutral missing-data components, and flags.
ALTER TABLE context_evaluation ADD COLUMN IF NOT EXISTS context_score_version TEXT NOT NULL DEFAULT 'legacy-context-v1';
ALTER TABLE context_evaluation ADD COLUMN IF NOT EXISTS context_score_components JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE context_evaluation ADD COLUMN IF NOT EXISTS missing_data_flags JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Ranking formulas are registered independently from setup and context scoring.
-- Only the lexicographic tie-breaker is active. The other definitions are
-- dormant research candidates until chronological holdout evidence satisfies
-- the Phase 6 activation gate.
CREATE TABLE IF NOT EXISTS ranking_formula (
  version TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('TIE_BREAKER','BOUNDED_CONTEXT','SETUP_INTERACTION')),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','RESEARCH','REJECTED')),
  definition JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ranking_formula_one_active_idx ON ranking_formula(status) WHERE status='ACTIVE';

INSERT INTO ranking_formula(version,mode,status,definition) VALUES
  ('ranking-tiebreak-v1','TIE_BREAKER','ACTIVE',
   '{"ordering":["state","setupScore","contextScore","freshness","symbol"],"retainsSetupScore":true}'::jsonb),
  ('ranking-bounded-context-research-v1','BOUNDED_CONTEXT','RESEARCH',
   '{"contextWeight":0.1,"maxContextAdjustment":5,"retainsSetupScore":true}'::jsonb),
  ('ranking-setup-interaction-research-v1','SETUP_INTERACTION','RESEARCH',
   '{"defaultContextWeight":0,"maxContextAdjustment":5,"requiresPerStrategyWeights":true,"retainsSetupScore":true}'::jsonb)
ON CONFLICT(version) DO NOTHING;

INSERT INTO foundation_schema_version(version,description)
VALUES(16,'Phase 6 versioned context evidence and dormant ranking research formulas')
ON CONFLICT(version) DO NOTHING;
