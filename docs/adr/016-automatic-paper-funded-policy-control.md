# ADR-016: Automatic paper-funded policy control

**Status:** Accepted at Stage A on September 15, 2026 after FP00-R4 review. This
accepts the design and authorizes only dependency-gated implementation with all
control authority disabled. It grants no funded policy approval, model activation
or running-stack change. This record would narrowly supersede one clause of
[ADR-011](011-learning-evidence-and-promotion-discipline.md) only later, at Stage B
per-market automatic-policy approval. Stage B and Stage C remain separate, later
authorizations. This record must be read together with
[ADR-007](007-statistical-models-are-supplemental.md),
[ADR-010](010-coordinated-portfolio-is-a-separate-projection.md),
[ADR-012](012-durable-paper-effects-and-temporal-reporting.md) and the
funded portfolio learning and control
design.

## Context

The user directed the simulated funded portfolios for `CA_TSX`/CAD and
`US_EQUITIES`/USD to become the primary portfolios the product measures and
improves, and accepted that a validated challenger may eventually control a
paper-funded portfolio automatically after predetermined gates pass. ADR-011
currently requires explicit user authorization for every activation and permits
automation to train inactive challengers only. The existing implementation is
consistent with that limit: model activation is an explicit HTTP action, and the
challenger activation boundary throws
`MODEL_ACTIVATION_NOT_AUTHORIZED_BY_CHALLENGER_WORKFLOW`.

Automatic authority cannot be granted by relaxing existing learning or risk rules.
It requires a separate, narrow decision that freezes exact gates before any
evaluation data is inspected, preserves every deterministic veto, and remains
paper-only. This record supplies that decision for review.

Retained evidence at the time of writing (September 14–15, 2026):

- The largest compatible learning cohorts hold 12/200 (CA) and 29/200 (US) closed
  QUOTE outcomes. Aggregate count is not poolable, and no statistical model or
  frozen paper dataset exists.
- Six completed funded runs exist on two accounts; funded replay evidence covers
  1–2 sessions, and the first automated captured-history baseline covered 9
  sessions (2026-08-31 to 2026-09-11).
- No promotion, canary, hysteresis or rollback constants exist in application
  code. The current risk-policy units are: initial cash 10,000 CAD/USD, daily loss
  limit 200 CAD/100 USD, per-trade risk budget 50 CAD/25 USD, maximum 3 open
  positions, total open risk 150 CAD/75 USD, symbol notional 3,000 CAD/1,500 USD,
  sector notional 5,000 CAD/2,500 USD, 15-minute post-stop cooldown, 3 consecutive
  stops, displayed-size participation 0.25 and 2 bps slippage.

Because funded portfolio evidence is thin, this record's numerical thresholds are
deliberately harder to satisfy than the current evidence could satisfy. Where the
current evidence cannot justify a permissive number, the gate is defined so that
it cannot promote on thin evidence and the exact replacement evidence is named.

The same evidence gap changes what can be approved when. The repository currently
retains fewer than the required 40 non-overlapping reference sessions, so the
numeric market-specific `M` of section 4.1 **cannot be frozen today**. This record
therefore separates design approval and implementation from automatic-policy
approval: Stage A (section 11) can be approved now with all control authority
disabled, while Stage B per-market automatic-policy approval is blocked until the
reference series and its receipts exist, and Stage C running-stack activation
remains separately withheld.

## Decision

### 1. Authority is limited to simulated funded portfolios

1. An automatic policy may influence only funded ranking and voluntary deferral
   among observations that deterministic strategies have already emitted as
   eligible in one market's paper-funded runtime. It may never create a candidate.
2. No broker write path, order staging, submission, cancellation or modification
   is added. The policy controls the simulated funded ledger the same way the
   existing funded policy does, and nothing else.
3. The policy cannot alter independent observations, canonical QUOTE executions,
   deterministic strategy state, scores, reason codes, `READY` transitions,
   entry/stop/target references, cost assumptions or risk limits.
4. Every deterministic funded control remains a final, transactional veto at the
   funded order service: cash and commission-inclusive reservation, daily loss
   limit, `maxTotalOpenRisk`, `maxOpenPositions`, symbol and sector notional caps,
   context freshness, post-stop cooldown, consecutive-stop limit, holding/stall
   limits, displayed-size participation and liquidity capacity. A policy may only
   choose among passing candidates or decline one; it may never bypass or weaken a
   veto.
5. Independent paper evidence stays unsuppressed and remains the control
   population. Funded declines and vetoes are retained with explicit reasons so
   selection cost stays measurable.

### 2. Outcomes are market-isolated

1. `CA_TSX`/CAD and `US_EQUITIES`/USD own separate authority rows, gate versions,
   evidence, canary budgets, transitions and rollback history. No value, budget,
   threshold or verdict is shared or pooled across markets.
2. `ALL` is read-only. It may present per-market cards and never aggregates
   currencies, holds an authority row, or accepts a transition.
3. Historical evaluation uses dedicated policy-derived replay accounts. A live
   funded account ID is never a replay target, consistent with ADR-012 and the
   existing funded replay provisioning.

### 3. One market authority with explicit lifecycle states

Each market has at most one active funded authority, identified by a monotonic
sequence. A challenger artifact moves through these immutable, append-only states:

| State              | Meaning                                                                                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `INACTIVE`         | A frozen, inactive artifact or gate policy exists with no funded decision authority.                                                                                            |
| `SHADOW`           | Predictions and counterfactual funded decisions are recorded against the same decision-time inputs; only the retained champion controls the funded account.                     |
| `CANARY`           | The challenger controls the funded account under the frozen canary slice and duration; the retained champion remains bound as the rollback target.                              |
| `ACTIVE`           | The challenger controls funded ranking and deferral for exactly one market under the approved gate policy.                                                                      |
| `REJECTED`         | A frozen gate returned a non-passing verdict; the artifact cannot automatically re-enroll against the same exposed evidence.                                                    |
| `AUTO_ROLLED_BACK` | A frozen rollback rule or disqualifying integrity/risk condition revoked authority; the retained champion was restored and the artifact is blocked from automatic reactivation. |

Transitions are append-only with database-owned sequencing and clock authority.
`ACTIVE` is never entered or left outside the transactional rules in section 8.

### 4. Promotion gates and exact frozen thresholds

Promotion requires every gate below under one immutable gate-policy version
identified by hash. Any missing, stale, unprovable or mismatched input fails that
gate closed; it is never estimated, defaulted or waived.

| Gate                         | Exact requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1 evidence sufficiency      | The challenger's compatible cohort has at least 200 usable closed outcomes from completed LIVE canonical QUOTE runs, both outcome classes, verified immutable provenance, overlap purging, chronological label availability, and at least 50 new outcomes since the prior frozen dataset for that cohort.                                                                                                                                                                                                        |
| G2 historical funded replay  | Champion and challenger replay the same retained opportunity stream over at least 20 identical retained market sessions on distinct dedicated replay accounts with frozen identities. Every decision is labeled; no missing, partial-recovery or unprovable termination remains.                                                                                                                                                                                                                                 |
| G3 historical return test    | The paired per-session net return after modeled costs and fees (challenger minus champion) must show a positive mean delta whose 95% one-sided bootstrap lower bound exceeds the frozen market-specific `M` (section 4.1).                                                                                                                                                                                                                                                                                       |
| G4 historical drawdown test  | The challenger's maximum mark-to-market equity drawdown may not exceed the champion's observed maximum for the same sessions, on the shared exogenous-input and union valuation-grid basis in section 4.2.                                                                                                                                                                                                                                                                                                       |
| G5 prospective return test   | The same paired per-session test over at least 20 later, unseen, eligible sessions and at least 40 closed funded decisions with all deadlines met and zero fallbacks.                                                                                                                                                                                                                                                                                                                                            |
| G6 prospective drawdown test | The prospective challenger drawdown may not exceed the prospective champion drawdown for the same sessions, on the same section 4.2 shared-input and union-grid basis.                                                                                                                                                                                                                                                                                                                                           |
| G7 risk integrity            | Zero proven deterministic risk-control violations: no executed exposure above a frozen cap, no order outside a durable reservation or ledger transaction, no daily-loss or reserve breach, no unresolved recovery attributable to the challenger.                                                                                                                                                                                                                                                                |
| G8 evidence integrity        | Zero disqualifying ownership, lineage, temporal-integrity, look-ahead or provenance findings. A finding that cannot be proven benign halts enrollment and pauses new entries.                                                                                                                                                                                                                                                                                                                                    |
| G9 operational               | Zero challenger-attributable blocking operational conditions inside any evaluation window after its transition grace period; warnings clear within the same market session and may not recur on three or more sessions. Platform or evidence alerts pause enrollment or make the window `UNAVAILABLE` and are never direct rollback triggers; a durably attributed challenger incident is recorded as a category-1 blocker. Excluded risk-veto behavior and exact alert ownership are enumerated in section 6.4. |
| G10 canary completion        | The bounded canary slice in section 5 closes at the earlier of 20 eligible market sessions or 30 calendar days, or terminates immediately for a breach, and completes a normal verdict without a budget breach, challenger-attributable risk-control violation or challenger-linked unresolved recovery failure. A 10/10 count never closes the canary early; only a breach fails the gate and rolls back.                                                                                                       |

#### 4.1 Minimum meaningful improvement `M` (practical effect, frozen before exposure)

`M` is a numeric, market-specific per-session net return threshold frozen at Stage B
automatic-policy approval, before any challenger is enrolled and before any
evidence in an evaluation window is inspected. It is computed from a **prior,
non-overlapping reference window**:

```text
M_market = 0.25 × SD_reference
```

where `SD_reference` is the champion's observed standard deviation of per-session
net return over at least 40 retained, reconciled funded sessions that all ended
before the automatic-policy approval that would use it. The reference window
identity, session count, observed `SD_reference` and resulting numeric `M_market`
are recorded in the gate-policy record and its receipts. `M` is never recalculated
from the evaluation window, the canary window or the active trailing windows.

`0.25 × SD_reference` is a **smallest effect of practical interest**: one quarter
of observed session-to-session variability is the smallest improvement the product
would treat as worth deploying, chosen for product significance rather than
derived from the test's power. A one-sided 95% confidence-bound half-width at 20
paired sessions is roughly `0.36 × SD`, which is larger than `0.25`; the gate
therefore demands stronger evidence than the practical threshold alone. It may
correctly return `INCONCLUSIVE` even when an effect of that size is real, because
its purpose is to refuse credit for unproven improvement, not to guarantee
detection at the practical threshold. Deferred power analysis from realized funded
variance may inform a future gate-policy version, and a larger sample improves
detection, but detection power is not claimed here.

Failure to freeze: if the reference window does not exist, is shorter than 40
sessions, overlaps any evaluation window, or its sessions are unreconciled or
unprovable, `M` cannot be frozen and no challenger may enroll. The gate stays
closed rather than substituting a permissive number. At the time of writing this
record's Stage B is blocked for exactly that reason in both markets.

A future gate-policy version may refreeze `M` from a new prior reference window,
but it may only evaluate evidence collected after that refreeze; it may not
re-evaluate a window that an earlier version already observed.

#### 4.2 Drawdown basis (mark-to-market equity, defined effective event streams)

Drawdown means peak-to-trough decline on funded account equity marked to market
over a defined valuation grid, so unrealized and intraday equity movement counts.
The champion and challenger share exogenous market inputs but retain separate
account-bound economic effects:

1. **Shared exogenous market inputs:** both curves consume the identical retained
   opportunity, quote/mark, market-clock and session/halt-boundary stream for the
   market and sessions under evaluation. It includes every temporally valid mark
   that changes the valuation of an open position on either curve and the last
   valid valuation of still-open positions at each session boundary.
2. **Champion endogenous effects:** the champion retains its own decisions,
   reservations, submissions, cancellations, fills, exits, commissions, fees,
   realized-P&L postings and funded ledger transitions.
3. **Challenger endogenous effects:** the challenger retains the corresponding
   effects produced by its own policy and dedicated account. These effects may
   differ from the champion's and remain bound to their market, account, currency,
   run and policy/artifact identity.

The comparison grid is the ordered union of the shared exogenous stream, the
champion's endogenous stream and the challenger's endogenous stream. At every grid
point both portfolios are valued, even when the event changes only one portfolio.

**Temporal identity.** A shared exogenous input is identified by market, session,
effective timestamp, source kind, immutable source identity and content digest
where retained; destination account is not part of that shared input identity. An
endogenous effect additionally carries its owning account, currency, run,
policy/artifact and durable fact/effect identity. Both curves therefore consume the
same retained **exogenous inputs**, not the same account-bound effects. Neither
stream may be advanced from later-captured or retroactively revised data. Database
capture/processing timestamps are audit and receipt evidence only and never order
or select events for the gate.

**Deterministic ordering.** Events that share an effective timestamp require a
retained causal or source sequence. A frozen domain precedence may substitute only
where it preserves existing funded semantics, including pre-submission
invalidation or cancellation before execution and reconciliation before a
same-time quote can drain. An opaque UUID, content digest or database insertion
order does not establish economic causality. Immutable identity may break a tie
only for events proven commutative; if material order remains unprovable, the
window is `UNAVAILABLE` rather than guessed.

Each point is valued using only information effective at or before its own
effective timestamp; no later mark may value an earlier point. Immediate
successive marks may be compacted only when they are identical valuations; dropped
marks must not hide a change.

A valuation fails to qualify when its mark is missing, stale beyond the ledger
bound (currently 30,000 ms for live evidence), or unprovable in retained replay
output. If any required event or its temporal identity cannot be valued on either
side, the drawdown gate is `UNAVAILABLE` for that window and fails closed; a
partial, realized-only or session-boundary-only substitute is never computed in its
place. Boundary snapshots and run-boundary snapshots are anchors, not a sufficient
event stream for an intraday drawdown gate. Realized-closed-outcome drawdown may be
reported as supplementary context but is not the gate basis.

### 5. Canary bound and duration

1. During `CANARY` the challenger controls only a predeclared slice of the funded
   account, and the slice is an additional ceiling that never relaxes an existing
   cap.
2. Budget: cumulative net loss attributable to the canary slice may not exceed
   **10% of the market's configured funded initial cash** (on current defaults,
   1,000 CAD or 1,000 USD), measured on realized closed canary outcomes at
   database-clock time. This is an absolute dollar cap derived only from existing
   configured capital; it does not pool currencies. Ten percent of initial cash is
   five times the CAD daily-loss limit and ten times the USD daily-loss limit
   (200 CAD/100 USD), so a single normal session cannot exhaust it while a
   persistent adverse edge still reaches it in weeks rather than months at current
   per-trade risk budgets.
3. Additional open-risk ceiling: the canary slice may hold at most one open
   position at a time, and its open plus reserved risk may not exceed the market's
   existing per-trade risk budget (50 CAD/25 USD, 1R). The slice is therefore
   strictly smaller than the full portfolio capacity: 1R versus the existing
   `maxTotalOpenRisk` of 150 CAD/75 USD, with `maxOpenPositions` 3. The existing
   `maxTotalOpenRisk` and daily-loss limits remain absolute ceilings as well, so
   the slice is never the whole portfolio.
4. Termination: the canary closes and rolls back **immediately** on a loss-budget
   breach or a proven deterministic risk-control violation, at any session or
   decision count. An unbreached canary closes only at the earlier of 20 eligible
   market sessions or 30 calendar days; reaching 10 sessions and 10 decisions does
   not close it early. At that normal closure, a pass is eligible only when at
   least 10 eligible sessions and at least 10 closed canary decisions were
   completed; if either minimum is short, the verdict is `INCONCLUSIVE` under
   section 6. The canary therefore always runs to its full horizon unless breached,
   and only insufficient completed evidence at that point can make the normal
   verdict inconclusive.
5. Verdict: a normal pass requires completion with zero budget breach, zero proven
   risk-control violation, drawdown no worse than the champion's over the same
   sessions on the section 4.2 shared-input and union-grid basis, and a non-negative
   paired per-session delta against the champion's observed per-session result. The
   paired delta is descriptive at canary size; the promotion test remains the frozen
   confidence-bound requirement in G3–G6. An incomplete window or insufficient
   decisions is `INCONCLUSIVE`; it neither promotes nor rolls back, and authority
   stays with the champion.

### 6. Observation windows, hysteresis and inconclusive outcomes

#### 6.1 Windows

Each evaluation consumes one frozen window with both a minimum and a horizon, and
closes at the earliest reached bound:

| Evaluation                | Minimum evidence for a normal verdict                         | Horizon (normal closure)        |
| ------------------------- | ------------------------------------------------------------- | ------------------------------- |
| Historical replay (G2–G4) | 20 sessions                                                   | 20 sessions                     |
| SHADOW (G5–G9)            | 40 decisions and 20 unseen eligible sessions                  | 40 sessions or 90 calendar days |
| CANARY (G10)              | 10 decisions and 10 sessions at normal closure                | 20 sessions or 30 calendar days |
| ACTIVE trailing rollback  | 20 closed decisions and 10 sessions, in 2 consecutive windows | 60 calendar days                |

A canary breach under section 5.4 terminates at any count. A normal window that
closes at its horizon without its minimum evidence is `INCONCLUSIVE` by definition.

#### 6.2 Hysteresis and the rollback deterioration condition

- Promotion is a single-pass all-gates verdict.
- Automatic rollback from `ACTIVE` requires a defined **deterioration condition** to
  hold in **two consecutive ACTIVE trailing windows**. One qualifying window
  produces a warning and, when the cause is operational, a pause on new entries;
  it never rolls back alone. Immediate rollback, without hysteresis, applies to
  section 7 disqualifying conditions.
- The deterioration condition in a trailing window is met when **both** of the
  following hold, computed over that window's paired sessions and decisions:
  1. **Return condition:** the paired per-session mean net return delta
     (challenger minus champion, after costs) has a 95% one-sided bootstrap upper
     bound below the negative of the frozen `M` from section 4.1. The challenger
     must be credibly worse than the reference threshold, not merely noisy.
  2. **Risk condition (at least one):**
     - **Drawdown:** the challenger's mark-to-market equity drawdown on the
       section 4.2 basis exceeds the champion's over the same window by more than
       the frozen rollback drawdown tolerance (interim value: zero); or
     - **Consistency:** the challenger underperforms the champion on the paired
       per-session net return in at least 60% of the window's comparable sessions.
- If the drawdown valuation required by the risk condition is missing, stale or
  unprovable, the window cannot qualify unless the consistency condition holds;
  it is never assumed benign.
- The trailing windows are successive, non-overlapping, and never re-evaluate
  evidence an earlier verdict already judged.

#### 6.3 Inconclusive outcomes

An inconclusive verdict is recorded, conserved and reported. It does not
authorize promotion, does not force rollback of a retained champion, and does not
permit re-evaluating the same window. The challenger returns to `INACTIVE`; a
further attempt requires a newly frozen artifact and a new window opened on
evidence collected after the previous verdict.

#### 6.4 Operational thresholds, ownership and grace

Only funded, challenger-attributable operational alerts can block promotion or
trigger rollback. Each retains its existing expression, duration and severity from
`monitoring/paper-bot-alerts.yml`; promotion/rollback policy adds no thresholds to
the monitoring rules.

1. **Challenger-attributable blockers (critical):** `FundedBacklogCritical`
   (above 1,000 pending funded facts and oldest pending age above 300,000 ms) and
   `FundedClosePendingStalled` (close-pending orders with oldest age >300,000 ms)
   when raised for the challenger-controlled market and linked to its control path,
   and `FundedRecoveryFailure` when the failed recovery is durably linked to the
   challenger. A blocking condition after the grace period blocks promotion and, if
   the challenger is already `ACTIVE`, triggers rollback once it persists beyond
   its alert duration plus one full market session, or once the same condition
   recurs on three separate sessions.
2. **Challenger-attributable warnings:** `FundedBacklogStalled` (oldest pending age
   above 120,000 ms) and `FundedCoverageGap` (any increase in coverage gaps), assessed
   for the challenger-controlled market. Warning conditions must clear within the
   same market session and may not recur on three or more sessions.
3. **Platform or evidence alerts — never a direct rollback trigger:**
   `ScannerPersistenceOverBudget` (scanner persistence p95 >500 ms) is process-wide
   and not market- or challenger-specific; `PaperRunRecoveryOverdue` (overdue runs
   above 0) may affect a market and block its evidence. When either condition affects
   funded evidence or the evaluation's inputs, it pauses new enrollment,
   reconciles first, and makes the affected evaluation window `UNAVAILABLE`. The
   platform alert itself can never roll back the challenger and is never counted as
   a challenger recurrence. If durable evidence attributes a specific incident to
   the challenger control path, that incident is recorded separately as a
   challenger-attributable blocker under category 1 and evaluated there; the
   original platform alert is not re-described as conditionally rolling back.
4. **Explicitly excluded:** `FundedRiskVetoPersistent`
   (`scanner_paper_bot_funded_risk_vetoes_total` increases). Deterministic risk
   vetoes are expected controller behavior, not a control failure, and can never
   block promotion or trigger rollback by themselves.
5. **System-wide conditions** that are not funded-specific
   (`ScannerMetricsUnavailable`, `PaperProcessingStalled`, `ScannerFeedStale`,
   `ScannerFeedTimestampMissing`, `ScannerPersistenceSeverelyDelayed`, discovery
   and retention alerts) are recorded for operator triage and handled by their own
   operational procedures; they are not attributed to the challenger.
6. A transition grants a 30-minute stabilization grace; conditions inside it are
   recorded but do not fail a gate. Reconciliation and exits are never blocked by
   pause conditions.

### 7. Integrity failures: pause versus immediate rollback

Immediate rollback (no hysteresis) applies to:

- a proven deterministic risk-control violation: executed exposure, notional, open
  risk, daily loss or reservation outside a frozen cap;
- canary net loss beyond the frozen budget slice;
- a funded order or ledger effect not owned by a durable transaction, conflicting
  fact identity, or duplicate effect;
- proven look-ahead, ownership, lineage or temporal-integrity corruption in
  evaluation evidence, or a mismatch between the evaluated and activated artifact;
- failure of automatic reconciliation or exits attributable to the challenger
  control path;
- evidence of any broker write capability.

Pause of new entries, without immediate rollback, applies to:

- an unproven but plausible integrity concern (pending investigation), retaining
  the champion as the active authority while observation, reconciliation and exits
  continue;
- warning-level operational conditions under section 6.4;
- missing or stale challenger predictions: behavior falls back to the current
  deterministic champion behavior and the fallback is recorded. A fallback
  invalidates the affected decision for comparison, and a fallback rate above zero
  fails the covering gate closed rather than being estimated around.

If a disqualifying condition is later proven benign and within its frozen window,
the pause is lifted explicitly and the deviation is recorded. It is never
silently ignored.

### 8. Transactional activation, retained champion and recovery

1. Activation or rollback locks the market authority row and, in one transaction:
   verifies the expected current champion, the eligible challenger transition and
   the gate-policy version and hash; rechecks evidence cutoff, required approvals
   and revocation/expiry; appends the transition and audit reason; atomically
   replaces the active funded policy pointer; and retains the previous verified
   champion as the rollback target.
2. At most one active policy exists per market. A conflicting concurrent
   transition fails visibly. A retry with the same transition identity returns the
   committed result.
3. Rollback is a safety transition, not a deletion. It restores the retained
   champion in the same transaction, records the exact evidence boundary, and
   blocks the failed artifact from automatic reactivation. The failed artifact and
   its evidence remain visible.
4. Reactivation of a rejected or rolled-back artifact requires a new artifact,
   evidence collected after the verdict, and explicit user direction; it can only
   re-enter at `INACTIVE` or `SHADOW`.
5. If no verified prior champion exists, the market enters fail-closed state:
   new funded entries are disabled while observation, reconciliation and exits
   continue. Promotion stays closed until a verified champion or an explicitly
   approved replacement exists.
6. Recovery expectations: after a crash the database state reflects either the
   full transition or none of it; startup reconciles the funded backlog first and
   applies pending idempotent transitions within the next normal worker cycle,
   without duplicating an economic effect and without blocking exits. Database
   clock authority and the existing durable-fact, inflight-barrier and
   effects-before-acknowledgement rules remain in force.

### 9. No tuning after exposure

1. Every numeric threshold, window, canary budget and hysteresis value is frozen
   into a gate-policy version before a challenger is enrolled.
2. A change to any of those values creates a new gate-policy version. The new
   version may not evaluate evidence that any prior version already observed for
   the same cohort and artifact; it must open a new window on later evidence.
3. A rejected or inconclusive challenger cannot be retried against the same
   exposed window under altered thresholds, and no automatic threshold adjustment
   exists in any control path.
4. The gate receipt records the exact identities, thresholds, evidence cutoff,
   observed values and pass/fail/unknown reason for every gate, so a verdict can
   be audited without rerunning it.

### 10. ADR-011 compatibility

The following clauses remain fully in force with no change:

- Preserve the baseline: strategy rules, execution assumptions, risk limits and
  evidence identity stay stable; this record does not authorize any change to
  them.
- Keep daily learning checks at worker startup and 17:00
  America/New_York.
- Do not weaken qualification: the 200-outcome floor, 50-new-outcome gate,
  completed LIVE runs, closed QUOTE labels, chronology, overlap purging, class
  balance, provenance and validation requirements are unchanged. G1 restates them
  as a promotion prerequisite and does not replace or lower them.
- Require prospective evidence of added value: prediction-time recording,
  pre-declared comparison criteria, costs, drawdown, consistency and calibration
  are unchanged and expanded by G5–G6.
- Report evidence honestly and preserve unsuccessful outcomes.

Narrowly superseded on Stage B approval: ADR-011 rule 4's automatic-training-only
limit and its requirement that a separate manual activation action occur, but
**only** for a funded paper policy that satisfies all of the following: the target
is a simulated funded portfolio; a market-specific gate policy was explicitly
approved by the user in advance with its numeric `M_market` and receipts; exact
gates, windows, canary bounds and rollback behavior were frozen before evaluation;
promotion runs through the transactional state machine in this record; and no
brokerage capability is introduced. Stage A design acceptance alone does not
supersede the clause. ADR-007's manual or explicit activation requirement remains
in force for signal-quality and other statistical models, and this record does not
authorize automatic promotion of a model outside the funded policy lifecycle.

Change control remains: any later change to collection policy, qualification
gates, scheduling or promotion requirements requires an explicit user instruction
and an updated decision record.

### 11. Three separate authorization stages

| Stage                                              | What it authorizes                                                                                                                                                                                                                                                                                                                                        | What it does not authorize                                                                                                                             |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Stage A — Design and implementation**            | Accepts this record and authorizes design and authority-disabled implementation of the named packages (contracts, migrations, services, UI and tests). Each package still starts only through its dependency-gated, reviewer-issued handoff. The design, gate structure, window definitions, canary bounds and rollback rules are approved at this stage. | Creating a per-market automatic-policy approval, enrolling a challenger, freezing `M`, promotion, rollback authority, or any running-stack activation. |
| **Stage B — Per-market automatic-policy approval** | A per-market, frozen, revocable user approval of one gate-policy version, requiring a frozen numeric `M_market` from the section 4.1 reference window and all referenced gate receipts. This approval is what activates the ADR-011 clause supersession.                                                                                                  | Running-stack activation, or any broker authority.                                                                                                     |
| **Stage C — Running-stack activation**             | Applying and enabling an approved policy in a deployed market runtime, after operational commissioning of that market.                                                                                                                                                                                                                                    | Any market or gate policy lacking a current Stage B approval, and any currency or account not named in the approval.                                   |

Stage A approval is available **now** and does not depend on the reference series:
implementation can proceed while authority is disabled. Stage B is **blocked until
the section 4.1 reference window exists** (at least 40 prior, non-overlapping,
reconciled funded sessions per market) and the numeric `M_market` plus all
referenced receipts can be frozen. At the time of writing, fewer than 40 reference
sessions are retained, so Stage B cannot occur. Stage B approval remains revocable
at any time.

Deployment of schema and read paths with authority disabled may precede Stage B.
No policy approval may be inferred from a merged implementation, a passing test
suite or an elapsed observation calendar.

## Consequences

Positive:

- A challenger can improve the primary paper portfolio without a human in the
  loop, while every deterministic veto and every independent observation is
  preserved exactly as before.
- The gate structure, windows, canary bounds, rollback rules and the reference-
  window requirement freeze at Stage A, and the numeric `M_market` freezes from a
  prior window at Stage B, so a verdict is evidence, not a tuning opportunity.
- Rollback is bounded, transactional and visible, and the champion is always a
  named, retained target.

Negative and residual:

- Funded evidence is thin: no numeric `M_market` can be frozen yet, Stage B is
  blocked in both markets, and no realistic challenger could pass the gates today.
  That is the correct interim behavior. Stage A implementation remains
  authority-disabled and cannot control a portfolio; funded accounting and
  observation continue under the existing deterministic policy.
- Requiring 20 identical historical sessions, a 40-session prior reference window
  and 20 prospective sessions delays any automatic control by months at current
  collection rates; the alternative would be promoting on statistically
  meaningless samples.
- The 0.25 practical-effect fraction is deliberately demanding relative to the
  confidence-bound sample size, so correctly sized but noisy improvements may be
  `INCONCLUSIVE` rather than promoted. That is accepted: the gate prefers missing
  a small edge to crediting an unproven one.
- Warning and pause states add operator actions that must be documented in the
  product surface so the portfolio never appears silently uncontrolled.
- This record's gates cannot be automatically enforced until FP01–FP05 implement
  and pass persistence acceptance. Until then it is an agent instruction, not
  runtime behavior, and it must not be described as automated enforcement.

## Required replacement evidence

The following values remain conservative placeholders and are named so they are
not mistaken for validated defaults. Each can be replaced only by the stated
evidence, frozen in a new gate-policy version and approved by the user before any
enrollment that would use it:

| Value                                | Proposed interim                                                                  | Evidence required to replace                                                                                                                             |
| ------------------------------------ | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Minimum meaningful effect `M`        | `0.25 × SD_reference` per market, a practical-effect floor frozen only at Stage B | ≥ 40 non-overlapping prior reference sessions per market with computable `SD_reference`; deferred power analysis may inform a later gate-policy version. |
| Drawdown tolerance                   | 0% above the champion's observed mark-to-market drawdown                          | Realized plus mark-to-market funded equity curves by market and a pre-declared tolerance rationale.                                                      |
| Canary loss budget                   | 10% of configured funded initial cash                                             | A user-approved per-market risk-appetite statement; still never above existing caps.                                                                     |
| Canary open-risk ceiling             | 1R (one per-trade risk budget, one open position)                                 | Funded replay measurement of canary exposure; may only be tightened, never raised to full portfolio capacity.                                            |
| Canary decision/session minimums     | 10 decisions and 10 sessions (normal pass only)                                   | Funded decision arrival-rate measurements per market; may increase, never decrease.                                                                      |
| Prospective session minimum          | 20 unseen sessions                                                                | Measured per-session effect variance and power analysis from realized funded sessions.                                                                   |
| Rollback return/consistency criteria | 95% upper bound below −`M`; 60% session inferiority                               | Paired per-session delta distribution from realized funded sessions per market.                                                                          |
| Operational pause/rollback durations | Existing funded alert expressions plus 30-minute grace                            | Recorded incident history showing false-positive and detection-latency trade-offs.                                                                       |

## Review and approval record

- Recorded September 15, 2026: FP00 documentation review. Findings: `M`-freeze
  independence, canary risk bound, rollback trigger, drawdown basis, canary
  termination and operational alert exactness. Corrected in the same revision.
- Recorded September 15, 2026 (FP00-R2): corrected the `M` statistical rationale to
  a practical-effect floor, separated Stage A/B/C authorization, defined the
  synchronized drawdown point set, made canary breaches immediately terminal,
  corrected operational alert ownership, and recorded that Stage B is currently
  blocked by the missing 40-session reference series.
- Recorded September 15, 2026 (FP00-R3): replaced database-timestamp drawdown
  synchronization with retained effective timestamps plus immutable input identity
  and deterministic tie ordering; corrected canary normal closure to 20 sessions or
  30 days with 10/10 required only for a normal pass; made platform/evidence alerts
  non-rollback with durably attributed challenger incidents recorded as category-1
  blockers; removed accidental Markdown blockquotes.
- Recorded September 15, 2026 (FP00-R4): separated the identical exogenous
  market-input stream from champion and challenger account-bound endogenous
  effects; defined the drawdown grid as their ordered union; prohibited opaque
  identity from establishing material causal order and made unprovable ordering
  fail closed.
- Recorded September 15, 2026: the user explicitly approved Stage A after the
  reviewer accepted FP00-R4. This accepts the design and permits authority-disabled
  implementation through dependency-gated, reviewer-issued handoffs. Stage B was
  not approved, no numeric `M_market` was frozen, and Stage C/running-stack
  activation remains withheld.
