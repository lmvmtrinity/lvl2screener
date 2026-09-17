# ADR-008: Automated Paper Fills Are Measurement, Not Execution

**Status:** Superseded in part by ADR-009

## Context

ADR-004 forbids automated order execution. Accumulating forward, out-of-sample
evidence for each scanner profile requires something that records a fill for
every `READY` signal without a human present, which superficially resembles the
automation ADR-004 rejects.

The two are distinct. ADR-004 exists because software that can place orders can
lose real money on a strategy defect. A component that writes simulated fills to
`journal_trade` has no such failure mode: its worst outcome is bad data, which
is visible, correctable, and confined to the research surface.

Left unstated, this distinction is likely to be collapsed in either direction —
into blocking legitimate measurement, or into treating the paper filler as a
step toward live automation.

## Decision

An automated paper filler may open and close simulated trades from the
deterministic `strategy_state_event` stream without human action.

It is a measurement instrument. It consumes state events, applies the execution
assumptions already defined for captured-history backtests, and shares its
financial calculation and fill logic with historical replay rather than
reimplementing them. ADR-009 supersedes this ADR's original `journal_trade` /
`origin = 'AUTO'` storage decision with dedicated immutable paper-bot tables.

Manual journal trades and automated paper evidence remain distinct and are
never aggregated into a single reported figure without that distinction being
available.

## Constraint

The paper filler cannot place, stage, or prepare a broker order, and has no
write path to Questrade. It cannot create, suppress, or modify `READY`,
deterministic scores, reason codes, alerts, or entry/stop/target references. Independent measurement records each eligible READY lifecycle under its versioned
execution rules. It does not promise a fill: unavailable market data and economic
rejections remain explicit outcomes under ADR-009/010. Coordinated selection is a
separate projection and cannot suppress upstream independent evidence.

Forward paper results are confirmatory evidence. Parameter search belongs to the
backtest and calibration layer, which enforces chronological segmentation and
sample gates. A parameter change justified solely by forward paper results
converts the only out-of-sample evidence the system has into in-sample data.

## Consequences

### Positive

- forward, out-of-sample evidence accumulates per profile without risking capital
- discretionary selection is removed from independent measurement; results still
  depend on modeled execution, market data quality and costs
- divergence between forward and backtested expectancy becomes observable
- ADR-004's boundary is stated precisely enough to survive future contributors

### Negative

- row volume scales with signals per session times enabled profiles
- simulated fills remain approximations; they do not prove a real fill was available
- a disciplined filler executing a weak edge produces consistent losses, and the
  research surface must present that as clearly as it presents success
