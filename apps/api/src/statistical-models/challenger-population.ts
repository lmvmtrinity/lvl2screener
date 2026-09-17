/** The same retained, complete-scope predicate is used by capture and reporting.
 * Aliases: e=experiment, o=observation, r=paper run, b=baseline, t=ACTIVE interval.
 * Comparing the canonical baseline JSONB costs avoids hashing PostgreSQL's
 * non-canonical JSON text and preserves identical economics across readers. */
export const challengerPopulationPredicate = `
 o.eligibility_status='ELIGIBLE' AND r.source='LIVE'
 AND r.market_id=e.market_id
 AND o.strategy_key=e.scope->>'strategy'
 AND o.strategy_version=e.scope->>'strategyVersion'
 AND o.profile_config_id::text=e.scope->>'profileConfigId'
 AND o.config_version=e.scope->>'configVersion'
 AND r.execution_model_version=e.scope->>'executionModelVersion'
 AND b.record->'scope'=e.scope
 AND r.assumptions=b.record->'executionAssumptions'
 AND o.source_event_payload->>'signalSemanticsVersion'=e.scope->>'signalSemanticsVersion'
 AND r.assumptions->>'evidenceScope'=e.scope->>'replayScope'
 AND t.state='ACTIVE'
 AND o.signal_timestamp>=GREATEST(e.starts_at,t.active_from)
 AND o.signal_timestamp<LEAST(e.ends_at,COALESCE(t.active_to,e.ends_at))`;

export const challengerActiveBoundaries = `SELECT experiment_id,state,effective_at AS active_from,
 LEAD(effective_at) OVER(PARTITION BY experiment_id ORDER BY sequence) AS active_to
 FROM challenger_experiment_transition`;

export const challengerTimelyCapturePredicate = `o.captured_at IS NOT NULL
 AND o.captured_at>=GREATEST(e.registered_at,t.active_from)
 AND o.captured_at<LEAST(e.ends_at,COALESCE(t.active_to,e.ends_at))
 AND o.captured_at<o.signal_timestamp+e.max_prediction_lag_ms*interval '1 millisecond'`;
