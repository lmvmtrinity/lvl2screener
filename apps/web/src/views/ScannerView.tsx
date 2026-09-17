import {
  type ContextStatus,
  type DataReadiness,
  type ScannerAlert,
  type StrategyState,
} from "@tsx-scanner/contracts";
import { Button } from "../components/ui/Button.js";
import {
  FieldInput,
  FieldSelect,
  FormField,
} from "../components/ui/FormField.js";
import { Panel, PanelHeader, PanelMeta } from "../components/ui/Panel.js";
import { Popover, Tip } from "../ui.js";
import { classes } from "../lib/classes.js";
import {
  STRATEGY_OPTIONS,
  displayStrategy,
  fmt,
  freshness,
  stateClass,
} from "../lib/format.js";
import { type BoardFilters, type BoardRow } from "../types.js";

export function ScannerFilters({
  filters,
  sectors,
  changed,
}: {
  filters: BoardFilters;
  sectors: string[];
  changed: (value: BoardFilters) => void;
}) {
  const update = <K extends keyof BoardFilters>(
    key: K,
    value: BoardFilters[K],
  ) => changed({ ...filters, [key]: value });
  const activeCount = [
    filters.state !== "ALL",
    filters.setup !== "ALL",
    filters.sector !== "ALL",
    filters.context !== "ALL",
    filters.readiness !== "ALL",
    filters.maximumSpread !== "",
  ].filter(Boolean).length;
  return (
    <Popover
      label="Scanner filters"
      triggerClassName={
        activeCount > 0
          ? "tw:shrink-0 tw:grow-0 tw:cursor-pointer tw:rounded-input tw:border tw:border-line-accent tw:bg-surface tw:px-3 tw:py-[9px] tw:font-mono tw:text-[0.62rem] tw:font-bold tw:tracking-[0.07em] tw:text-accent tw:hover:border-line-accent-bright"
          : undefined
      }
      trigger={() => <>FILTERS{activeCount > 0 ? ` · ${activeCount}` : ""}</>}
    >
      <div className="tw:grid tw:w-[min(380px,calc(100vw_-_32px))] tw:grid-cols-2 tw:gap-x-3 tw:gap-y-[11px]">
        <Tip label="Setup lifecycle state. READY means the entry conditions are armed right now; FORMING and WATCH are still building.">
          <FormField label="STATE">
            <FieldSelect
              value={filters.state}
              onChange={(event) =>
                update("state", event.target.value as BoardFilters["state"])
              }
            >
              <option value="ALL">ALL STATES</option>
              {(
                [
                  "READY",
                  "FORMING",
                  "WATCH",
                  "INACTIVE",
                  "INVALIDATED",
                  "EXPIRED",
                  "HALTED",
                  "DATA_STALE",
                ] as StrategyState[]
              ).map((value) => (
                <option value={value} key={value}>
                  {value.replaceAll("_", " ")}
                </option>
              ))}
            </FieldSelect>
          </FormField>
        </Tip>
        <Tip label="Strategy pattern that produced the candidate, e.g. opening-range retest or VWAP hold.">
          <FormField label="SETUP TYPE">
            <FieldSelect
              value={filters.setup}
              onChange={(event) =>
                update("setup", event.target.value as BoardFilters["setup"])
              }
            >
              <option value="ALL">ALL SETUPS</option>
              {STRATEGY_OPTIONS.map((value) => (
                <option value={value} key={value}>
                  {displayStrategy(value)}
                </option>
              ))}
            </FieldSelect>
          </FormField>
        </Tip>
        <Tip label="Sector of the underlying symbol. Useful to avoid stacking correlated names.">
          <FormField label="SECTOR">
            <FieldSelect
              value={filters.sector}
              onChange={(event) => update("sector", event.target.value)}
            >
              <option value="ALL">ALL SECTORS</option>
              {sectors.map((value) => (
                <option value={value} key={value}>
                  {value}
                </option>
              ))}
            </FieldSelect>
          </FormField>
        </Tip>
        <Tip label="Market-context grade for the symbol. Scored separately from setup quality, so it never inflates the setup score.">
          <FormField label="CONTEXT">
            <FieldSelect
              value={filters.context}
              onChange={(event) =>
                update("context", event.target.value as BoardFilters["context"])
              }
            >
              <option value="ALL">ALL CONTEXT</option>
              {(
                [
                  "STRONG",
                  "NEUTRAL",
                  "WEAK",
                  "STALE",
                  "UNAVAILABLE",
                ] as ContextStatus[]
              ).map((value) => (
                <option value={value} key={value}>
                  {value}
                </option>
              ))}
            </FieldSelect>
          </FormField>
        </Tip>
        <Tip label="Per-symbol feed health. Only READY rows are actionable; WARMING, STALE and HALTED rows stay visible but gated.">
          <FormField label="DATA READINESS">
            <FieldSelect
              value={filters.readiness}
              onChange={(event) =>
                update(
                  "readiness",
                  event.target.value as BoardFilters["readiness"],
                )
              }
            >
              <option value="ALL">ALL DATA</option>
              {(
                [
                  "READY",
                  "WARMING",
                  "UNAVAILABLE",
                  "STALE",
                  "DELAYED",
                  "HALTED",
                ] as DataReadiness[]
              ).map((value) => (
                <option value={value} key={value}>
                  {value}
                </option>
              ))}
            </FieldSelect>
          </FormField>
        </Tip>
        <Tip label="Hide symbols whose bid/ask spread is wider than this percentage of price. Leave blank for no limit.">
          <FormField label="MAX SPREAD %">
            <FieldInput
              type="number"
              min="0"
              max="5"
              step="0.01"
              value={filters.maximumSpread}
              onChange={(event) => update("maximumSpread", event.target.value)}
              placeholder="ANY"
            />
          </FormField>
        </Tip>
        <div className="tw:col-span-2">
          <Tip label="Clear every filter back to its default and show the full board.">
            <Button
              variant="control"
              className="tw:w-full"
              onClick={() =>
                changed({
                  state: "ALL",
                  setup: "ALL",
                  sector: "ALL",
                  context: "ALL",
                  readiness: "ALL",
                  maximumSpread: "",
                })
              }
            >
              RESET
            </Button>
          </Tip>
        </div>
      </div>
    </Popover>
  );
}

export function ScannerBoard({
  rows,
  modelRanks,
  select,
  emptyMessage,
}: {
  rows: BoardRow[];
  modelRanks: Map<string, number>;
  select: (symbol: string) => void;
  /** Automation-state explanation for an empty board, e.g. market closed or
   * empty universe. Falls back to filter copy when automation is healthy. */
  emptyMessage?: string;
}) {
  return (
    <Panel>
      <PanelHeader
        level={2}
        title="Best setup per symbol"
        description="State-first ranking · setup and context remain separate · unavailable symbols stay visible"
        emphasis="muted"
        actions={
          <PanelMeta className="tw:below-md:hidden">
            {rows.length} VISIBLE
          </PanelMeta>
        }
      />
      <div className="candidate-table" role="table">
        <div
          className="operator-row tw:grid tw:min-w-[1180px] tw:grid-cols-[1fr_0.65fr_1.35fr_0.72fr_0.72fr_0.65fr_1fr_0.75fr_1.1fr] tw:items-center tw:gap-4 tw:border-b tw:border-line-subtle tw:px-[22px] tw:py-3 tw:font-mono tw:text-[0.61rem] tw:font-bold tw:tracking-[0.1em] tw:text-ink-750"
          role="row"
        >
          <span>SYMBOL</span>
          <span>PRICE</span>
          <span>SETUP</span>
          <span>SETUP SCORE</span>
          <span>CONTEXT</span>
          <span>SPREAD</span>
          <span>SECTOR</span>
          <span>FRESHNESS</span>
          <span>STATE / DATA</span>
        </div>
        {rows.map((row) => {
          const setup = row.setup,
            modelRank = setup
              ? modelRanks.get(`${setup.profileId}:${setup.symbol}`)
              : undefined;
          return (
            <button
              type="button"
              className={classes(
                "operator-row tw:grid tw:w-full tw:min-w-[1180px] tw:grid-cols-[1fr_0.65fr_1.35fr_0.72fr_0.72fr_0.65fr_1fr_0.75fr_1.1fr] tw:items-center tw:gap-4 tw:border-0 tw:border-b tw:border-line-subtle tw:px-[22px] tw:py-[15px] tw:text-left tw:text-ink-250 tw:cursor-pointer tw:hover:bg-surface-raised",
                setup
                  ? "tw:bg-transparent"
                  : "tw:bg-[color-mix(in_srgb,var(--surface-danger)_45%,transparent)]",
              )}
              role="row"
              key={row.symbol}
              title={
                setup
                  ? `Setup ${setup.setupScore} · context ${row.contextScore}${modelRank !== undefined ? ` · model annotation ${modelRank}` : ""}`
                  : row.reason
              }
              onClick={() => select(row.symbol)}
            >
              <strong className={setup ? undefined : "tw:text-warn"}>
                {row.symbol}
                <small className="tw:block tw:mt-1 tw:text-[0.62rem] tw:text-ink-700">
                  {setup ? "" : row.reason}
                </small>
              </strong>
              <span>
                {setup ? `$${setup.featureSnapshot.price.toFixed(2)}` : "—"}
              </span>
              <span>
                <b className="tw:block">
                  {setup ? setup.profileName : "NO SETUP"}
                </b>
                <small className="tw:block tw:mt-1 tw:text-[0.62rem] tw:text-ink-700">
                  {setup
                    ? `${displayStrategy(setup.strategy)} · ${row.otherActiveSetups} other active`
                    : "Visible for diagnosis"}
                </small>
              </span>
              <strong className="tw:font-mono tw:text-[1.05rem] tw:text-ink-50">
                {setup?.setupScore ?? "—"}
              </strong>
              <span>
                <b className="tw:block">{row.contextScore}</b>
                <small className="tw:block tw:mt-1 tw:text-[0.62rem] tw:text-ink-700">
                  {row.contextStatus}
                </small>
              </span>
              <span>
                {setup ? fmt(setup.featureSnapshot.spreadPct, "%") : "—"}
              </span>
              <span>{row.sector ?? "—"}</span>
              <time
                className="tw:font-mono tw:text-[0.67rem] tw:font-[650] tw:text-ink-550"
                dateTime={row.latestAt ?? undefined}
                title={
                  row.latestAt
                    ? new Date(row.latestAt).toLocaleString()
                    : row.reason
                }
              >
                {freshness(row.latestAt)}
              </time>
              <span>
                <i className={stateClass(setup?.state ?? row.status)}>
                  {setup?.state ?? row.status}
                </i>
                <small className="tw:block tw:mt-1 tw:text-[0.62rem] tw:text-ink-700">
                  {row.readiness}
                </small>
              </span>
            </button>
          );
        })}
        {!rows.length && (
          <div
            className={classes(
              "empty",
              emptyMessage &&
                "tw:text-[0.78rem] tw:leading-[1.6] tw:text-warn-soft",
            )}
          >
            {emptyMessage ??
              "No symbols match these filters. Clearing filters will restore unavailable and warming candidates."}
          </div>
        )}
      </div>
    </Panel>
  );
}

export function AlertHistory({
  alerts,
  select,
}: {
  alerts: ScannerAlert[];
  select: (symbol: string) => void;
}) {
  return (
    <Panel className="tw:mt-4">
      <PanelHeader
        title="Alert history"
        description="READY and READY → INVALIDATED transitions"
        emphasis="compact"
        actions={<PanelMeta>{alerts.length} RECENT</PanelMeta>}
      />
      <div className="tw:max-h-[410px] tw:overflow-auto">
        {alerts.map((alert) => (
          <article
            key={alert.alertId}
            className={classes(
              "alert-row tw:grid tw:w-full tw:grid-cols-[minmax(0,1fr)_auto] tw:items-center tw:gap-[13px] tw:border-b tw:border-line-subtle tw:px-5 tw:py-[14px] tw:text-left tw:text-ink-250 tw:bg-transparent tw:cursor-pointer tw:hover:bg-surface-raised tw:below-md:px-[14px]",
              `alert-${alert.type.toLowerCase()}`,
            )}
          >
            <button
              type="button"
              className="alert-summary tw:grid tw:grid-cols-[36px_minmax(0,1fr)] tw:items-center tw:gap-[13px] tw:border-0 tw:bg-transparent tw:p-0 tw:text-inherit tw:text-left tw:cursor-pointer"
              onClick={() => select(alert.symbol)}
            >
              <span
                className={
                  alert.type === "INVALIDATION"
                    ? "alert-icon tw:grid tw:h-[30px] tw:w-[30px] tw:place-items-center tw:rounded-full tw:border tw:border-line-danger tw:bg-surface-danger tw:font-extrabold tw:text-danger-tint"
                    : "alert-icon tw:grid tw:h-[30px] tw:w-[30px] tw:place-items-center tw:rounded-full tw:border tw:border-line-accent-mid tw:bg-surface-raised tw:font-extrabold tw:text-accent"
                }
              >
                {alert.type === "READY" ? "↑" : "×"}
              </span>
              <span>
                <strong className="tw:block">{alert.title}</strong>
                <small className="tw:block tw:mt-1 tw:text-ink-700 tw:below-md:hidden">
                  {alert.message}
                </small>
              </span>
            </button>
            <span className="tw:flex tw:flex-col tw:items-end tw:gap-[3px]">
              <b className="tw:text-base">{alert.score}</b>
              <time
                className="tw:font-mono tw:text-[0.64rem] tw:font-[650] tw:text-ink-700"
                dateTime={alert.timestamp}
              >
                {new Date(alert.timestamp).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                })}
              </time>
            </span>
          </article>
        ))}
        {alerts.length === 0 && (
          <div className="empty">No actionable alerts yet.</div>
        )}
      </div>
    </Panel>
  );
}
