import {
  type CandidateDetail,
  SETUP_SCORE_GROUPS,
  SETUP_SCORE_GROUP_LABEL,
  SETUP_SCORE_GROUP_MAXIMUM,
  type StrategyEvaluation,
  candidateDetailSchema,
  compareOpportunities,
  contextScoreForSymbol,
} from "@tsx-scanner/contracts";
import { useEffect, useState, type ReactNode } from "react";
import { Button } from "../components/ui/Button.js";
import { Panel, PanelHeader, PanelMeta } from "../components/ui/Panel.js";
import { getJson } from "../lib/api.js";
import { classes } from "../lib/classes.js";
import { displayStrategy, fmt, stateClass } from "../lib/format.js";
import {
  buildFormationMarkers,
  layoutFormationMarkers,
} from "../lib/formation-markers.js";
import { FormationMarkers } from "./FormationMarkers.js";

function CandleChart({
  detail,
  setups,
}: {
  detail: CandidateDetail;
  setups: StrategyEvaluation[];
}) {
  const records = [
    ...setups.map((setup) => ({ ...setup })),
    ...detail.events.map((event) => ({
      ...event,
      event: { eventId: event.eventId, state: event.state },
    })),
  ];
  const anchor = detail.feature ?? setups[0] ?? detail.events[0];
  const asOf =
    detail.feature?.timestamp ??
    records
      .map((record) => record.timestamp)
      .sort((left, right) => Date.parse(left) - Date.parse(right))
      .at(-1);
  const width = 900,
    height = 340,
    pad = 30,
    candles = detail.candles
      .filter((candle) => !asOf || Date.parse(candle.end) <= Date.parse(asOf))
      .slice(-60),
    feature = detail.feature;
  const overlays: [string, number | undefined | null, string, string][] = [
    ["CURRENT VWAP", feature?.vwap, "#56c7ff", "6 5"],
    ["ORH", feature?.openingRange?.high, "#f0b65a", "6 5"],
    ["ORL", feature?.openingRange?.low, "#f0b65a", "6 5"],
    ...setups.flatMap((setup, index) => {
      const hue = [
        "#f59e0b",
        "#c693ff",
        "#ff8c95",
        "#67d6cc",
        "#ffd166",
        "#8cb4ff",
      ][index % 6]!;
      const name =
        setup.profileName.length > 16
          ? `${setup.profileName.slice(0, 14)}…`
          : setup.profileName;
      return [
        [`${name} ENTRY`, setup.entryReference, hue, ""],
        [`${name} STOP`, setup.stopReference, "#f06f78", "3 4"],
        [`${name} TARGET`, setup.targetReference, "#f59e0b", "3 4"],
      ] as [string, number | null, string, string][];
    }),
  ];
  const levels = overlays.flatMap(([, value]) =>
    value == null ? [] : [value],
  );
  const values = [...candles.flatMap((c) => [c.high, c.low]), ...levels];
  if (!candles.length || !values.length)
    return <div className="chart-empty">Waiting for 5-minute candles…</div>;
  const min = Math.min(...values),
    max = Math.max(...values),
    range = max - min || 1;
  const y = (value: number) =>
      pad + ((max - value) / range) * (height - pad * 2),
    slot = (width - pad * 2) / candles.length;
  const rawMarkers =
    anchor && asOf ? buildFormationMarkers(records, anchor, asOf) : [];
  const markers = layoutFormationMarkers(rawMarkers, candles, {
    width,
    height,
    pad,
    min,
    max,
  });
  return (
    <div className="chart-wrap">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`${detail.symbol} five minute chart`}
      >
        {overlays.map(([label, value, color, dash]) =>
          value == null ? null : (
            <g key={`${label}:${value}`}>
              <line
                x1={pad}
                x2={width - pad}
                y1={y(value)}
                y2={y(value)}
                stroke={color}
                strokeDasharray={dash}
                opacity=".75"
              />
              <text x={width - pad + 3} y={y(value) + 4} fill={color}>
                {label}
              </text>
            </g>
          ),
        )}
        {candles.map((c, index) => {
          const x = pad + slot * index + slot / 2,
            color = c.close >= c.open ? "#f59e0b" : "#f06f78";
          return (
            <g key={c.start}>
              <line x1={x} x2={x} y1={y(c.high)} y2={y(c.low)} stroke={color} />
              <rect
                x={x - Math.max(2, slot * 0.27)}
                width={Math.max(4, slot * 0.54)}
                y={Math.min(y(c.open), y(c.close))}
                height={Math.max(1.5, Math.abs(y(c.open) - y(c.close)))}
                fill={color}
                rx="1"
              />
            </g>
          );
        })}
        <FormationMarkers markers={markers} />
      </svg>
      <p>
        Markers describe retained evidence. Missing historical evidence is
        unavailable. Current VWAP is a horizontal snapshot reference.
      </p>
    </div>
  );
}

/** Phase 4: every point is attributed, so the board can say why this scored 78 and not 68. */

function ScoreHeading({ children }: { children: ReactNode }) {
  return (
    <h4 className="tw:mt-[22px] tw:mb-2 tw:text-[0.72rem] tw:tracking-[0.1em] tw:text-ink-600 tw:uppercase">
      {children}
    </h4>
  );
}

function ScoreBreakdown({ setup }: { setup: StrategyEvaluation }) {
  if (!setup.scoreExplanation.length)
    return (
      <>
        <ScoreHeading>Score</ScoreHeading>
        <p className="tw:mt-0 tw:mr-0 tw:mb-[10px] tw:ml-0 tw:font-mono tw:text-[0.62rem] tw:font-normal tw:leading-[1.5] tw:text-ink-700">
          Recorded before explainable scoring ({setup.scoreVersion}); only the
          total is available.
        </p>
      </>
    );
  return (
    <>
      <ScoreHeading>Why this score is {setup.setupScore}</ScoreHeading>
      <p className="tw:mt-0 tw:mr-0 tw:mb-[10px] tw:ml-0 tw:font-mono tw:text-[0.62rem] tw:font-normal tw:leading-[1.5] tw:text-ink-700">
        Score version {setup.scoreVersion} · independent of strategy v
        {setup.strategyVersion} and {setup.configVersion}. A score never creates
        READY.
      </p>
      <div className="tw:mb-3 tw:grid tw:gap-[6px]">
        {SETUP_SCORE_GROUPS.map((group) => {
          const points = setup.scoreComponents[group],
            maximum = SETUP_SCORE_GROUP_MAXIMUM[group];
          const width = maximum
            ? Math.max(0, Math.min(100, (points / maximum) * 100))
            : Math.min(100, Math.abs(points) * 2.5);
          return (
            <div
              className={classes(
                "tw:grid tw:grid-cols-[96px_minmax(0,1fr)_62px] tw:items-center tw:gap-[9px] tw:font-mono tw:text-[0.6rem] tw:font-bold tw:tracking-[0.05em]",
                points < 0 ? "tw:text-danger" : "tw:text-ink-600",
              )}
              key={group}
            >
              <span>{SETUP_SCORE_GROUP_LABEL[group]}</span>
              <i className="tw:h-[6px] tw:rounded-[3px] tw:bg-surface-raised">
                <b
                  className={classes(
                    "tw:block tw:h-full tw:rounded-[3px]",
                    points < 0 ? "tw:bg-danger" : "tw:bg-accent",
                  )}
                  style={{ width: `${width}%` }}
                />
              </i>
              <b
                className={classes(
                  "tw:text-right",
                  points < 0 ? "tw:text-danger" : "tw:text-ink-100",
                )}
              >
                {points > 0 ? `+${points}` : points}
                {maximum ? (
                  <small className="tw:text-ink-700">/{maximum}</small>
                ) : null}
              </b>
            </div>
          );
        })}
      </div>
      <ul className="tw:m-0 tw:grid tw:list-none tw:gap-[7px] tw:pl-[19px] tw:text-ink-350">
        {setup.scoreExplanation.map((value) => (
          <li
            className="tw:my-[7px] tw:grid tw:grid-cols-[38px_minmax(0,1fr)] tw:items-baseline tw:gap-[9px] tw:text-[0.84rem]"
            key={`${value.group}:${value.key}`}
          >
            <strong className="tw:text-right tw:font-mono tw:text-[0.66rem] tw:font-bold tw:text-accent">
              {value.points > 0 ? `+${value.points}` : value.points}
            </strong>
            <span className="tw:grid tw:gap-[2px] tw:font-mono tw:text-[0.68rem] tw:font-normal tw:leading-[1.4] tw:text-ink-250">
              {value.label}
              <small className="tw:text-[0.61rem] tw:text-ink-700">
                {value.detail}
              </small>
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

function ReadinessCell({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <span className="tw:bg-surface tw:p-4 tw:font-mono tw:text-[0.58rem] tw:font-bold tw:text-ink-700">
      {label}{" "}
      <b className="tw:mt-[7px] tw:block tw:text-[0.72rem] tw:text-ink-150">
        {children}
      </b>
    </span>
  );
}

function MetricTile({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="tw:bg-surface tw:px-5 tw:py-[18px]">
      <span className="tw:mb-2 tw:block tw:font-mono tw:text-[0.62rem] tw:font-bold tw:tracking-[0.1em] tw:text-ink-700">
        {label}
      </span>
      <strong className="tw:text-[1.15rem]">{children}</strong>
    </div>
  );
}

export function Detail({
  symbol,
  profileId,
  close,
}: {
  symbol: string;
  profileId: string;
  close: () => void;
}) {
  const [detail, setDetail] = useState<CandidateDetail>();
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void getJson(
      `/api/candidates/${encodeURIComponent(symbol)}`,
      controller.signal,
    )
      .then((v) => setDetail(candidateDetailSchema.parse(v)))
      .catch((reason: unknown) => {
        if (!(reason instanceof DOMException && reason.name === "AbortError"))
          setError(
            reason instanceof Error
              ? reason.message
              : "Unable to load candidate",
          );
      });
    return () => controller.abort();
  }, [symbol]);
  const strategies = (
    detail?.strategies.filter(
      (value) => profileId === "ALL" || value.profileId === profileId,
    ) ?? []
  ).sort((left, right) =>
    compareOpportunities(
      {
        setup: left,
        contextScore: contextScoreForSymbol(
          detail?.contexts ?? [],
          left.symbol,
        ),
      },
      {
        setup: right,
        contextScore: contextScoreForSymbol(
          detail?.contexts ?? [],
          right.symbol,
        ),
      },
    ),
  );
  const feature = detail?.feature,
    coverage = detail?.coverage;
  return (
    <section className="detail">
      <Button variant="link" className="tw:mb-[26px]" onClick={close}>
        ← All candidates
      </Button>
      {!detail ? (
        <p className="panel loading">{error || "Loading candidate…"}</p>
      ) : (
        <>
          <div className="tw:mb-[30px] tw:flex tw:items-center tw:justify-between tw:gap-7">
            <div>
              <p className="tw:m-0 tw:font-mono tw:text-[0.68rem] tw:font-bold tw:leading-[1.4] tw:tracking-[0.18em] tw:text-accent">
                CANDIDATE DETAIL ·{" "}
                {strategies[0]?.profileName ?? "NO ACTIVE SETUP"}
              </p>
              <h2 className="tw:text-[3.5rem]">{detail.symbol}</h2>
            </div>
            <div
              className={stateClass(
                strategies[0]?.state ?? coverage?.status ?? "WATCH",
              )}
            >
              {strategies[0]?.state ?? coverage?.status ?? "UNAVAILABLE"}
            </div>
          </div>
          <Panel as="article" className="tw:mt-4">
            <PanelHeader
              title="Data readiness"
              description="Resolution, freshness, warm-up, and analysis coverage"
              actions={
                <PanelMeta>
                  {coverage?.dataReadiness ??
                    feature?.dataStatus ??
                    "UNAVAILABLE"}
                </PanelMeta>
              }
            />
            <div className="tw:grid tw:grid-cols-6 tw:gap-px tw:bg-surface-sunken tw:below-lg:grid-cols-3 tw:below-md:grid-cols-2">
              <ReadinessCell label="MARKET DATA">
                {feature?.dataStatus ?? "UNAVAILABLE"}
              </ReadinessCell>
              <ReadinessCell label="FEATURE VERSION">
                {feature?.featureVersion ?? "—"}
              </ReadinessCell>
              <ReadinessCell label="UPDATED">
                {feature
                  ? new Date(feature.timestamp).toLocaleTimeString()
                  : "—"}
              </ReadinessCell>
              <ReadinessCell label="SECTOR">
                {detail.member?.sector ?? "—"}
              </ReadinessCell>
              <ReadinessCell label="SETUPS">
                {coverage?.setupCount ?? strategies.length}
              </ReadinessCell>
              <ReadinessCell label="CONTEXT">
                {coverage?.contextCount ?? detail.contexts.length}
              </ReadinessCell>
            </div>
            {coverage?.reasons.length || feature?.warmingUp.length ? (
              <ul className="tw:m-0 tw:bg-surface-olive tw:px-10 tw:py-[15px] tw:text-[0.75rem] tw:text-warn">
                {coverage?.reasons.map((value) => (
                  <li key={value}>{value}</li>
                ))}
                {feature?.warmingUp.map((value) => (
                  <li key={value}>Waiting for {value}</li>
                ))}
              </ul>
            ) : null}
          </Panel>
          {feature && (
            <div className="tw:mb-4 tw:grid tw:grid-cols-5 tw:gap-px tw:overflow-hidden tw:rounded-[12px] tw:border tw:border-line tw:bg-surface-sunken tw:below-md:grid-cols-2">
              <MetricTile label="LAST">${feature.price.toFixed(2)}</MetricTile>
              <MetricTile label="VWAP">${fmt(feature.vwap)}</MetricTile>
              <MetricTile label="RVOL">
                {fmt(feature.rvolAtTime, "×")}
              </MetricTile>
              <MetricTile label="SPREAD">
                {fmt(feature.spreadPct, "%")}
              </MetricTile>
              <MetricTile label="ATR">{fmt(feature.atrPct, "%")}</MetricTile>
              <MetricTile label="RSI 14">
                {fmt(feature.rsi14 ?? null)}
              </MetricTile>
              <MetricTile label="DAILY EMA">
                {feature.dailyEmaContext?.status ?? "—"}
              </MetricTile>
            </div>
          )}
          <Panel as="article" className="tw:mt-4">
            <PanelHeader
              title="Exact setup levels"
              description="Each profile’s entry, stop, and target references over completed five-minute candles"
              actions={<PanelMeta>{strategies.length} SETUPS</PanelMeta>}
            />
            <CandleChart detail={detail} setups={strategies} />
          </Panel>
          <section className="tw:mt-4">
            <div className="tw:flex tw:items-baseline tw:justify-between tw:px-0.5 tw:py-[6px] tw:below-md:flex-col tw:below-md:items-start tw:below-md:gap-[5px]">
              <h3 className="tw:m-0 tw:text-[1rem]">Setup evaluations</h3>
              <span className="tw:text-[0.7rem] tw:text-ink-700">
                Setup score remains separate from context
              </span>
            </div>
            <div className="tw:mt-4 tw:grid tw:grid-cols-2 tw:gap-4 tw:below-md:grid-cols-1">
              {strategies.map((strategy) => (
                <Panel as="article" className="tw:p-6" key={strategy.profileId}>
                  <div className="tw:mb-[15px] tw:flex tw:items-start tw:justify-between">
                    <div>
                      <h3 className="tw:m-0">{strategy.profileName}</h3>
                      <small className="tw:text-ink-700">
                        {displayStrategy(strategy.strategy)} · strategy v
                        {strategy.strategyVersion}
                      </small>
                    </div>
                    <strong className="tw:font-mono tw:text-[1.05rem] tw:text-ink-50">
                      {strategy.setupScore}
                    </strong>
                  </div>
                  <div className="tw:mb-1 tw:flex tw:flex-wrap tw:items-center tw:gap-2">
                    <i className={stateClass(strategy.state)}>
                      {strategy.state}
                    </i>
                    <span className="tw:rounded-[5px] tw:bg-bg tw:px-[9px] tw:py-[7px] tw:font-mono tw:text-[0.55rem] tw:font-bold tw:text-ink-700">
                      CONFIG{" "}
                      <b className="tw:mt-[3px] tw:block tw:max-w-[220px] tw:overflow-hidden tw:text-ellipsis tw:text-ink-350">
                        {strategy.configVersion}
                      </b>
                    </span>
                    <span className="tw:rounded-[5px] tw:bg-bg tw:px-[9px] tw:py-[7px] tw:font-mono tw:text-[0.55rem] tw:font-bold tw:text-ink-700">
                      INSTANCE{" "}
                      <b
                        className="tw:mt-[3px] tw:block tw:max-w-[220px] tw:overflow-hidden tw:text-ellipsis tw:text-ink-350"
                        title={
                          strategy.setupInstanceId ?? "No formation assigned"
                        }
                      >
                        {strategy.setupInstanceId ?? "NOT ASSIGNED"}
                      </b>
                    </span>
                    <span className="tw:rounded-[5px] tw:bg-bg tw:px-[9px] tw:py-[7px] tw:font-mono tw:text-[0.55rem] tw:font-bold tw:text-ink-700">
                      UPDATED{" "}
                      <b className="tw:mt-[3px] tw:block tw:max-w-[220px] tw:overflow-hidden tw:text-ellipsis tw:text-ink-350">
                        {new Date(strategy.timestamp).toLocaleTimeString()}
                      </b>
                    </span>
                  </div>
                  <ScoreBreakdown setup={strategy} />
                  <ScoreHeading>State reasons</ScoreHeading>
                  <ul className="tw:m-0 tw:pl-[19px] tw:text-ink-350">
                    {strategy.reasonCodes.map((reason) => (
                      <li
                        className="tw:my-[7px] tw:text-[0.84rem]"
                        key={reason}
                      >
                        {reason.replaceAll("_", " ")}
                      </li>
                    ))}
                  </ul>
                </Panel>
              ))}
              {!strategies.length && (
                <Panel className="empty">
                  No setup evaluation is available. Data-readiness reasons
                  remain authoritative.
                </Panel>
              )}
            </div>
          </section>
          <Panel as="article" className="tw:mt-4">
            <PanelHeader
              title="Context"
              description="Displayed separately for ranking provenance · never an entry trigger"
              actions={<PanelMeta>{detail.contexts.length} SIGNALS</PanelMeta>}
            />
            <div className="context-list">
              {detail.contexts.map((context) => (
                <div
                  className="tw:grid tw:grid-cols-[1fr_auto_auto] tw:items-center tw:gap-4 tw:border-b tw:border-line-subtle tw:px-[22px] tw:py-[18px] tw:last:border-b-0"
                  key={context.profileId}
                >
                  <span>
                    <strong className="tw:block">{context.profileName}</strong>
                    <small className="tw:mt-1 tw:block tw:text-ink-700">
                      {context.benchmarkSymbol
                        ? `${context.observedValue == null ? "—" : `${context.observedValue.toFixed(2)}%`} vs ${context.benchmarkSymbol}`
                        : "Benchmark unavailable"}
                    </small>
                    <small className="tw:mt-1 tw:block tw:text-ink-700">
                      {context.lookback.replaceAll("_", " ")} · benchmark{" "}
                      {context.benchmarkTimestamp
                        ? new Date(
                            context.benchmarkTimestamp,
                          ).toLocaleTimeString()
                        : "—"}
                    </small>
                    <small className="tw:mt-1 tw:block tw:text-ink-700">
                      {context.configVersion} · {context.contextScoreVersion}
                    </small>
                  </span>
                  <b>{context.contextScore}</b>
                  <i className={stateClass(context.status)}>{context.status}</i>
                </div>
              ))}
              {!detail.contexts.length && (
                <div className="empty compact tw:p-[25px] tw:text-center tw:text-ink-700">
                  No context profiles are enabled or available.
                </div>
              )}
            </div>
          </Panel>
          <Panel as="article" className="tw:mt-4">
            <PanelHeader
              title="Risk structure"
              description="References are descriptive; manual execution remains authoritative"
              actions={
                <PanelMeta>
                  {
                    strategies.filter(
                      (value) =>
                        value.entryReference &&
                        value.stopReference &&
                        value.targetReference,
                    ).length
                  }{" "}
                  COMPLETE
                </PanelMeta>
              }
            />
            <div>
              {strategies.map((strategy) => (
                <div
                  className="tw:grid tw:grid-cols-[1.4fr_repeat(4,1fr)] tw:gap-[10px] tw:border-b tw:border-line-subtle tw:px-[22px] tw:py-[15px] tw:below-md:grid-cols-2"
                  key={strategy.profileId}
                >
                  <strong>{strategy.profileName}</strong>
                  <span className="tw:font-mono tw:text-[0.58rem] tw:font-bold tw:text-ink-700">
                    ENTRY{" "}
                    <b className="tw:mt-1 tw:block tw:text-[0.75rem] tw:text-ink-150">
                      {fmt(strategy.entryReference)}
                    </b>
                  </span>
                  <span className="tw:font-mono tw:text-[0.58rem] tw:font-bold tw:text-ink-700">
                    STOP{" "}
                    <b className="tw:mt-1 tw:block tw:text-[0.75rem] tw:text-ink-150">
                      {fmt(strategy.stopReference)}
                    </b>
                  </span>
                  <span className="tw:font-mono tw:text-[0.58rem] tw:font-bold tw:text-ink-700">
                    TARGET{" "}
                    <b className="tw:mt-1 tw:block tw:text-[0.75rem] tw:text-ink-150">
                      {fmt(strategy.targetReference)}
                    </b>
                  </span>
                  <span className="tw:font-mono tw:text-[0.58rem] tw:font-bold tw:text-ink-700">
                    R:R{" "}
                    <b className="tw:mt-1 tw:block tw:text-[0.75rem] tw:text-ink-150">
                      {fmt(strategy.estimatedRr)}
                    </b>
                  </span>
                </div>
              ))}
              {!strategies.length && (
                <div className="empty compact tw:grid tw:grid-cols-[1.4fr_repeat(4,1fr)] tw:gap-[10px] tw:border-b tw:border-line-subtle tw:p-[25px] tw:text-center tw:text-ink-700 tw:below-md:grid-cols-2">
                  No setup risk geometry is available.
                </div>
              )}
            </div>
          </Panel>
          <Panel as="article" className="tw:mt-4">
            <PanelHeader
              title="State timeline and reasons"
              description="Chronological transitions for this symbol"
              actions={<PanelMeta>{detail.events.length} EVENTS</PanelMeta>}
            />
            <div className="tw:px-[22px] tw:pt-2 tw:pb-[18px]">
              {[...detail.events]
                .sort(
                  (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp),
                )
                .map((event) => (
                  <div
                    className="tw:grid tw:grid-cols-[85px_165px_1.1fr_1.8fr] tw:items-center tw:gap-3 tw:border-b tw:border-line-subtle tw:py-3 tw:below-md:grid-cols-2"
                    key={event.eventId}
                  >
                    <time
                      className="tw:font-mono tw:text-[0.65rem] tw:font-[650] tw:text-ink-700"
                      dateTime={event.timestamp}
                    >
                      {new Date(event.timestamp).toLocaleTimeString()}
                    </time>
                    <i className={stateClass(event.state)}>
                      {event.previousState} → {event.state}
                    </i>
                    <strong>
                      {event.profileName}
                      <small className="tw:mt-[3px] tw:block tw:text-[0.6rem] tw:font-medium tw:text-ink-750">
                        {displayStrategy(event.strategy)} ·{" "}
                        {event.setupInstanceId ?? "no setup instance"}
                      </small>
                    </strong>
                    <span className="tw:text-[0.7rem] tw:text-ink-550 tw:below-md:col-span-full">
                      {event.reasonCodes
                        .map((value) => value.replaceAll("_", " "))
                        .join(" · ")}
                    </span>
                  </div>
                ))}
              {!detail.events.length && (
                <div className="empty compact tw:grid tw:grid-cols-[85px_165px_1.1fr_1.8fr] tw:items-center tw:gap-3 tw:border-b tw:border-line-subtle tw:p-[25px] tw:text-center tw:text-ink-700 tw:below-md:grid-cols-2">
                  No state transition has been recorded in this process session.
                </div>
              )}
            </div>
          </Panel>
        </>
      )}
    </section>
  );
}
