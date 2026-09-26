# Strategy specification

Reviewed against the Python engine on September 10, 2026. This describes implemented
rules, not validated trading edges. Exact numeric controls come from the immutable
profile configuration and `StrategyParameters` in Python/shared contracts. Do not
substitute the historical discovery YAML for runtime strategy configuration.

## Shared inputs and identity

`feature_engine.py` computes one shared snapshot per instrument/timestamp;
`strategy_engine.py` evaluates enabled profiles and the registry in `strategies/`.
Profiles identify strategy/version and immutable configuration. Setup identity and
formation evidence retain selected bars, levels and timestamps across scans and
replay. Repeated scans cannot manufacture a new independent setup.

CA and US use separate market sessions and benchmark catalogs. Benchmark features
are not derived from candidate lists. Context signals have no entry authority.
The current feature identity is `1.2.0`; score identity is `setup-score-v1`.
Changing features, scores, rules or execution assumptions requires the applicable
provenance/version treatment, not historical relabeling.

## Features and chronology

- Session VWAP uses volume-weighted typical price. Completed-bar VWAP is retained
  separately for completed-bar confirmations; a changing live quote must not
  rewrite the VWAP input used by a closed candle.
- Wilder ATR(14) uses completed daily history with an arithmetic seed and Wilder
  smoothing. ATR% is ATR divided by current price, times 100.
- RVOL-at-Time compares cumulative volume with prior completed sessions at the
  same elapsed time; it is not interchangeable with single-bar volume ratios.
- The opening range is bounded by the market session configuration (default
  09:30–09:45). Support/resistance uses available confirmed levels.
- Pivots are available only after their confirmation bars close. RSI(14), daily
  EMA(13/21), rejection geometry and contraction calculations are centralized in
  `feature_indicators.py`; incomplete/future bars cannot supply evidence.
- Breakout volume divides the latest completed bar's volume by the mean of up to
  three preceding completed bars. At least one prior bar and a positive baseline
  are required. The current bar is excluded from its denominator.

Formation markers use retained records and exact state-event timestamps. Origin
annotations do not backdate eligibility; unavailable provenance remains unknown.
Current VWAP is a snapshot reference, not a historical curve. The Detail chart
clips markers to the displayed as-of candles without changing axis bounds.

Feature `1.2.0` adds nullable confirmed-swing provenance. Legacy `1.1.0` records
retain unknown provenance. Existing price/strength/confluence/stop selection and
strategy state rules are unchanged.

## Common setup gates and states

The engine checks halted status, real-time/actionable data, spread hard maximum,
feature warm-up, ATR and RVOL availability/minima before strategy-specific logic.
An enabled daily-EMA filter requires available bullish daily context. These are
hard gates, unlike score contributions. Delayed/stale data cannot produce READY.

The spread gate is evaluated per instrument and profile. It blocks a setup (to
`INACTIVE`, or `INVALIDATED` for a `FORMING`/`READY` formation, with
`SPREAD_TOO_WIDE`) once the spread has stayed above the limit for
`spreadConfirmQuotes` consecutive quotes and `spreadConfirmSeconds` seconds. The
limit is `spreadHardMaxPct`, raised to `spreadMinTicks` price ticks when that is
wider. A wide quote that is not yet confirmed adds `SPREAD_WIDE_UNCONFIRMED` and
cannot promote a setup to `READY` (`WAITING_FOR_SPREAD`). After a block the setup
stays out (`SPREAD_RECOVERING`) until the spread is at or below
`spreadRecoveryPct` percent of the limit. The parameter defaults (1 quote,
0 seconds, 100%, 0 ticks) reproduce the original single-quote gate exactly.
Profile configuration versions ending `+spread-stable-v1` (migration 153) use
3 quotes, 5 seconds, 80% and 3 ticks.

Trade references: the stop is the configured stop policy's level, widened to
at least `stopMinAtrFraction` × daily ATR14 and `stopMinSpreads` × the quoted
spread (`stopSelectionReason` `MINIMUM_DISTANCE`). The target is the nearest
resistance above entry (or 2 R for strategies that fall back when none exists),
raised to `targetMinR` × risk when closer. Defaults of 0 keep the structural stop
and nearest-resistance target. Versions ending `+levels-v1` (migration 154) use
0.15, 4 and 1.5.

States are `INACTIVE`, `WATCH`, `FORMING`, `READY`, `INVALIDATED`, `EXPIRED`,
`HALTED`, `DATA_STALE`. Transitions are persisted; a high score cannot cause READY.
The engine applies market/profile entry windows after strategy evaluation. Before
scan start the state is inactive; READY before preferred start remains forming;
after preferred end it may remain READY with an explanatory reason. Hard entry
end expires eligibility. Defaults are scan 09:45–16:00, preferred 10:00–11:30,
hard end 16:00 in the market timezone. Exit processing is separate.

Opt-in research entry filters run after those gates and only prevent a transition
into READY. They leave an already-READY evaluation and trade-reference computation
alone. `latestReadyTime` is a market-local `HH:MM` cutoff (null disables it);
new READY evaluations at or after it stay FORMING with `READY_WINDOW_CLOSED`.
An enabled cutoff without session timezone context waits with
`READY_WINDOW_UNAVAILABLE`.

For `PRIOR_DAY_HIGH_BREAKOUT` and `HIGH_OF_DAY_BREAKOUT`, `maxVwapDistanceAtr`
and `maxChangeFromOpenAtr` reject values strictly above their caps with
`OVEREXTENDED_ENTRY`. Zero disables each cap. Missing or nonfinite enabled
features wait with `ENTRY_EXTENSION_UNAVAILABLE`. For `VWAP_HOLD`,
`minSectorRelativeStrengthPct` requires stock return since open minus sector
benchmark return since open to meet the floor in percentage points; zero
disables it. A below-floor observation reports
`SECTOR_RELATIVE_STRENGTH_BELOW_MINIMUM`; unavailable, nonactionable, stale or
future benchmark observations report `SECTOR_ENTRY_UNAVAILABLE`. This uses the
current strategy context with no historical reconstruction. A blocked formation
can become READY later if its data qualifies and the existing strategy still
allows it.

All four defaults preserve earlier strategy behavior. These controls are research
capabilities; enabling them on existing profiles requires a new immutable
configuration version and separately authorized rollout. No migration declares
or enables them yet. Full backtest responses include `entryFilterDiagnostics`
per strategy/reason: blocked evaluation count and distinct blocked formation
count. These are attempted promotions, can overlap across reasons, and are not
counts of removed trades. Live evaluation does not collect these counters.

Manual intake does not apply every reference universe threshold as a hard strategy
gate. In particular, the old universal +0.75% change-from-open and discovery ATR
thresholds are not substitutes for each profile's actual rules.

## Entry modules

| Module                  | Implemented formation and confirmation                                                                                                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ORB_RETEST              | Completed volume-confirmed close above buffered opening-range high; a later bar retests within tolerance and closes at/above the level. Support loss invalidates; unconfirmed timeout expires.                                  |
| VWAP_HOLD               | Bullish completed-bar structure (at least two of the last three closes above VWAP), a touch/close back above VWAP, then a later completed-bar rejection, prior-high break or higher low. VWAP loss invalidates an active setup. |
| VWAP_RECLAIM            | Shared completed-bar reclaim feature starts formation; a later bar closes above completed-bar VWAP with its low within the allowed tolerance. Loss/timeout fails the setup.                                                     |
| HIGH_OF_DAY_BREAKOUT    | Prior completed current-session high, a bounded consolidation window, then buffered completed close and volume confirmation. Formation retains its level; loss and timeout are checked.                                         |
| PRIOR_DAY_HIGH_BREAKOUT | Last completed daily high, buffered completed close and volume confirmation, with active-formation invalidation and timeout.                                                                                                    |
| BULL_FLAG               | Directional three-bar impulse meeting ATR/slope controls, configurable flag duration, bounded retracement and contracting volume, then volume-confirmed break. Pullback low defines structural failure.                         |
| RSI_VWAP_RECLAIM        | Experimental ordered sequence: two confirmed current-session price lows with sampled RSI divergence, later VWAP reclaim, later hold, then break of frozen resistance. No retrospective pairing of independent RSI pivots.       |

The registry contains these modules; enabled instances are database profiles, not
a claim that every definition is enabled by default. Migration 038 added profiles
for previously registry-only setups. Migration 080 adds the RSI research definition
without an enabled profile; 081 retains formation evidence.

Optional ORB/VWAP retest contraction, rejection and later high-break controls are
explicit ablations. Disabled controls preserve the existing baseline. Bound
formation evidence and confirmation order must survive replay/repeated rescans.
The research implementation and remaining empirical gates are in
the strategy research plan.

## References and stops

READY trade references come from `BaseStrategy.trade_references`. Entry uses the
snapshot price. `PATTERN_INVALIDATION`, `NEAREST_SUPPORT`, and `HYBRID` select
available valid stop references; HYBRID chooses the nearest valid candidate below
entry. A resistance above entry supplies a target, with a two-R fallback only for
modules that opt into it. Missing references remain missing; paper execution
separately validates economic viability and sizes the trade.

Breakout buffers use the shared helper's price/tick floor. The strategy helper
currently encodes a TSX-style minimum tick; it is not proof that every US price
increment policy is implemented identically. Quote execution has its own versioned
market policy. Preserve this distinction during a future tick-policy review.

## Context and scoring

Market/sector context compares candidate and benchmark returns with timestamp,
availability and staleness evidence. It reports `UNAVAILABLE`, `STALE`, `WEAK`,
`NEUTRAL`, or `STRONG`, with 50 neutral. Missing data does not become a fabricated
zero return. Context has no READY state, trade references or trade alerts.

Setup score components have these caps:

| Component             |       Maximum |
| --------------------- | ------------: |
| Strategy pattern      |            25 |
| Strategy confirmation |            20 |
| Shared structure      |            20 |
| Shared liquidity      |            20 |
| Shared timing         |            15 |
| Penalties             | 0 (floor −40) |

The centralized scorer owns shared inputs exactly once; strategy modules own
pattern/confirmation awards. Non-tradeable states have a score ceiling of 59.
The total is a quality index with reason/component explanations, not a probability
or a WATCH/FORMING state classifier. Deterministic ranking uses state, setup score,
then applicable neutral-or-observed context as a tie-breaker. Statistical ranking
is a separately labeled, explicitly activated supplement.

## Research discipline

Use unchanged shared inputs, chronological splits, realistic costs and versioned
profiles for comparisons. Never raise frequency or alter exits merely to obtain
more training rows. [ADR-011](../adr/011-learning-evidence-and-promotion-discipline.md)
requires forward validation and explicit authorization for promotion. No current
threshold or implemented pattern is a claim of profitability.
