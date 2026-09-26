# ADR-019: Historical archive as an exploratory backtest source

**Status:** Accepted September 25, 2026, at the user's request. It adds a second,
exploratory replay input for US backtests. It changes no strategy threshold,
execution assumption, qualification gate or learning rule.

## Context

Historical archives extend exploratory coverage beyond retained broker history.
Provider differences prevent treating imported data as equivalent commissioned
evidence.


## Decision

1. **Separate archive tables.** Provider history lives in `historical_bar`
   (Massive one-minute and daily bars), `historical_quote_minute` (Databento
   regular-session bid/ask samples) and `historical_archive_import` (one manifest
   row per provider response with its SHA-256, byte count, record counts and
   cost), created by migration 156. Imports never overwrite a stored row; a
   reimport that differs is counted in `conflicting_count`. Captured `candle` and
   `quote_snapshot` rows are never written.
2. **Explicit source per run.** `CreateBacktest.dataSource` accepts
   `HISTORICAL_ARCHIVE` for `US_EQUITIES`. The frozen replay input records the
   source through `capturedHistoryAvailability.source`, and every replay path
   reads exactly one source. A replay input whose availability does not match its
   requested source is rejected.
3. **Replay synthesis.** Each session reuses `buildSessionPayload` and the
   production engines. One quote is synthesized per minute sample T from the
   bid/ask sampled at T and the minute bars that ended by T. Quotes start after the
   first regular-session bar closes. Five-minute bars are aggregated from minute
   bars. Fractional provider volume is rounded once per minute bar. The published
   calendar sets session bounds, including early closes.
4. **Candidates.** Archive runs require explicit symbols and freeze them as a
   labeled explicit cohort. There is no retained point-in-time membership for
   imported history, so an empty list resolves no candidates (ADR-015).
5. **Exploratory only.** Archive results carry `dataQuality.spread = "ARCHIVED"`,
   an archive warning and `qualification = "EXPLORATORY"`. They bind no research
   lineage, link no profile evidence and create no opportunity captures.
   Statistical training and signal-model research keep rejecting them through
   their existing `CAPTURED` and `CAPTURED_QUOTES` checks.
6. **Operator-run imports.** The `historical-import` command imports bars and
   quotes for existing US instruments, skips covered ranges, prices the whole
   Databento plan before downloading and stops above `--max-cost` (default $5).
   Nothing imports automatically.

## Consequences

- US strategies can be replayed over about two years instead of a few weeks,
  for symbols already in the instrument table.
- Volume-based features (RVOL, VWAP, volume gates) follow Massive's trade rules
  and are not directly comparable with Questrade-derived runs. Compare archive
  runs only with other archive runs.
- One quote per minute is coarser than live polling. Time-based spread
  confirmation and quote-driven fills are approximated at minute resolution.
- The Massive free window rolls forward; history older than two years becomes
  unavailable unless it was imported before then.
- Later steps each need their own decision: reconstructing historical daily-seed
  membership from Massive grouped daily bars, adding a TSX provider, compressing
  archive chunks, or letting archive evidence contribute to any qualification.
