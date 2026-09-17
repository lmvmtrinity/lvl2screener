-- Phase 4: the setup score becomes an explainable index. Components and their
-- per-contribution explanation are stored next to the total, under a score version
-- that moves independently from the strategy and configuration versions.
-- Additive only: rows written before Phase 4 keep their score and stay readable as
-- V1 setup records through the contract defaults.
ALTER TABLE strategy_evaluation ADD COLUMN IF NOT EXISTS score_version TEXT NOT NULL DEFAULT 'legacy-v1';
ALTER TABLE strategy_evaluation ADD COLUMN IF NOT EXISTS score_components JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE strategy_evaluation ADD COLUMN IF NOT EXISTS score_explanation JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE strategy_signal ADD COLUMN IF NOT EXISTS score_version TEXT NOT NULL DEFAULT 'legacy-v1';
ALTER TABLE strategy_signal ADD COLUMN IF NOT EXISTS score_components JSONB NOT NULL DEFAULT '{}'::jsonb;

-- A score never promotes a setup: any evaluation in a non-tradeable state stays
-- below the 60 point band the board reads as a live opportunity.
DO $$ BEGIN
  ALTER TABLE strategy_evaluation ADD CONSTRAINT strategy_evaluation_non_tradeable_score_check
    CHECK (state IN ('WATCH','FORMING','READY') OR score < 60) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

INSERT INTO foundation_schema_version(version,description)
VALUES(15,'Phase 4 explainable setup score components and score version')
ON CONFLICT(version) DO NOTHING;
