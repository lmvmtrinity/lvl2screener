import {
  fundedHistoricalReplayListSchema,
  type FundedHistoricalReplay,
  type FundedHistoricalReplayList,
  type MarketId,
} from "@tsx-scanner/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getJson } from "../lib/api.js";
import { classes } from "../lib/classes.js";
import { useRefreshOnFocus } from "../lib/use-refresh.js";
import { Tip } from "../ui.js";

const REFRESH_INTERVAL_MS = 10_000;
const IN_FLIGHT_STATUSES = new Set(["RUNNING", "CLOSE_PENDING"]);

const FUNDED_REPLAY_LIVE_BASE =
  "funded-replay-live tw:mx-[22px] tw:mt-0 tw:mb-3 tw:inline-flex tw:gap-2 tw:rounded-full tw:border tw:px-[10px] tw:py-[6px] tw:text-[0.68rem]";
const FUNDED_REPLAY_LIVE_TONES: Record<string, string> = {
  running: "tw:border-line-accent tw:text-accent-tint",
  settled: "tw:border-line tw:text-ink-400",
};
const FUNDED_REPLAY_METRICS =
  "tw:mb-3 tw:grid tw:grid-cols-[repeat(4,1fr)] tw:gap-px tw:overflow-hidden tw:rounded-xl tw:border tw:border-line tw:bg-surface-sunken tw:below-900:grid-cols-[repeat(2,1fr)]";
const FUNDED_REPLAY_ORDER =
  "tw:grid tw:grid-cols-[1fr_1.4fr_1fr_auto] tw:items-center tw:gap-[10px] tw:rounded-[8px] tw:border tw:border-line tw:bg-surface tw:px-3 tw:py-[10px] tw:text-[0.74rem] tw:below-900:grid-cols-[1fr_1fr]";

function money(value: number, currency: "CAD" | "USD"): string {
  return `${currency === "USD" ? "USD" : "CAD"} ${value.toFixed(2)}`;
}

function orderStatusLabel(order: FundedHistoricalReplay["orders"][number]) {
  if (order.status === "FILLED")
    return order.exitReason
      ? `FILLED · ${order.exitReason.replaceAll("_", " ")}`
      : "FILLED · OPEN";
  if (order.status === "REJECTED")
    return `REJECTED · ${(order.reason ?? order.executionStatus ?? "UNKNOWN").replaceAll("_", " ")}`;
  return order.status;
}

/**
 * Funded account replay results. This panel deliberately sits beside the
 * independent signal evidence, never merged with it: only this projection is a
 * simulated account path, and it is not qualified for capital allocation.
 *
 * The list only polls while at least one run is still in flight, so a settled
 * market does not keep refetching. Selected run and expansion state survive
 * refreshes because results are replaced, never remounted.
 */
export function FundedReplayPanel({ marketId }: { marketId: MarketId }) {
  const [list, setList] = useState<FundedHistoricalReplayList>();
  const [selectedId, setSelectedId] = useState<string>();
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const controllerRef = useRef<AbortController | undefined>(undefined);

  const load = useCallback(async () => {
    // Skip while a request is already in flight; intervals and focus events
    // can never stack duplicate fetches.
    if (controllerRef.current) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    setRefreshing(true);
    try {
      const parsed = fundedHistoricalReplayListSchema.parse(
        await getJson(
          `/api/funded-replays?marketId=${encodeURIComponent(marketId)}`,
          controller.signal,
        ),
      );
      setList(parsed);
      setError("");
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === "AbortError")
        return;
      // Keep the previous list visible; a failed refresh must not erase
      // results that are already on screen.
      setError("Funded replay results could not be loaded.");
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = undefined;
        setRefreshing(false);
      }
    }
  }, [marketId]);

  useEffect(() => {
    setList(undefined);
    setSelectedId(undefined);
    setError("");
    void load();
    return () => {
      controllerRef.current?.abort();
      controllerRef.current = undefined;
    };
  }, [marketId, load]);

  const inFlightCount = useMemo(
    () =>
      (list?.runs ?? []).filter((run) => IN_FLIGHT_STATUSES.has(run.runStatus))
        .length,
    [list],
  );

  // Bounded auto-refresh only while a replay is actually in flight.
  useEffect(() => {
    if (!inFlightCount) return;
    const timer = window.setInterval(() => void load(), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [inFlightCount, load]);

  useRefreshOnFocus(() => void load(), 5_000);

  const selected = useMemo(
    () => list?.runs.find((run) => run.runId === selectedId) ?? list?.runs[0],
    [list, selectedId],
  );

  return (
    <section className="panel funded-replay-panel tw:mt-5">
      <div className="panel-title">
        <div>
          <h3>Funded portfolio replay</h3>
          <p>
            Which opportunities this account could actually take. Independent
            signal outcomes above are diagnostic; this is the simulated account
            path, not an investable equity curve.
          </p>
        </div>
        <Tip label="Produced by the funded order, reservation, and ledger machinery over retained history. Simulated fills are not guaranteed, and execution reporting never qualifies a strategy for capital allocation.">
          <span className="funded-replay-badge tw:shrink-0 tw:basis-auto tw:rounded-full tw:border tw:border-line-warn-strong tw:bg-surface-warn tw:px-[9px] tw:py-[5px] tw:font-mono tw:text-[0.63rem] tw:font-bold tw:tracking-[0.1em] tw:text-accent">
            SIMULATED · NOT QUALIFIED
          </span>
        </Tip>
      </div>
      {error && <p className="error-banner">{error}</p>}
      {!list && !error && <div className="empty">Loading funded replays…</div>}
      {list && !list.runs.length && (
        <div className="empty">No funded replays for this market yet.</div>
      )}
      {list && list.runs.length > 0 && (
        <p
          className={classes(
            FUNDED_REPLAY_LIVE_BASE,
            inFlightCount
              ? FUNDED_REPLAY_LIVE_TONES.running
              : FUNDED_REPLAY_LIVE_TONES.settled,
          )}
        >
          {inFlightCount
            ? `${inFlightCount} replay${inFlightCount === 1 ? "" : "s"} in flight · results refresh automatically until it completes`
            : "Replay settled · no automatic refresh is running"}
          {refreshing ? " · refreshing…" : ""}
        </p>
      )}
      {list && selected && (
        <>
          <div className="run-list">
            {list.runs.map((run) => (
              <button
                type="button"
                key={run.runId}
                className={classes(
                  "run-row funded-run-row tw:grid tw:grid-cols-[minmax(0,1fr)_auto] tw:items-center tw:gap-3 tw:border-b tw:border-b-line-subtle tw:px-[18px] tw:py-[14px]",
                  run.runId === selected.runId && "tw:bg-surface-raised",
                )}
                onClick={() => setSelectedId(run.runId)}
              >
                <span>
                  <strong>{run.sessionDate}</strong>
                  <small className="tw:text-[0.64rem] tw:text-ink-350">
                    {run.runStatus} · {run.orderCounts.filled} fills ·{" "}
                    {run.orderCounts.rejected} rejected
                  </small>
                </span>
                <b
                  className={classes(
                    "tw:text-right tw:below-620:hidden",
                    run.summary.realizedPnl >= 0 ? "positive" : "negative",
                  )}
                >
                  {money(run.summary.realizedPnl, run.currency)}
                </b>
              </button>
            ))}
          </div>
          <div className="funded-replay-detail tw:mt-[14px]">
            <div className={FUNDED_REPLAY_METRICS}>
              <div className="tw:bg-surface tw:p-[14px]">
                <span className="tw:mb-[6px] tw:block tw:font-mono tw:text-[0.62rem] tw:font-bold tw:tracking-[0.08em] tw:text-ink-350">
                  ACCOUNT CASH
                </span>
                <strong>
                  {money(selected.summary.cash, selected.currency)}
                </strong>
              </div>
              <div className="tw:bg-surface tw:p-[14px]">
                <span className="tw:mb-[6px] tw:block tw:font-mono tw:text-[0.62rem] tw:font-bold tw:tracking-[0.08em] tw:text-ink-350">
                  EQUITY
                </span>
                <strong>
                  {money(selected.summary.equity, selected.currency)}
                </strong>
              </div>
              <div className="tw:bg-surface tw:p-[14px]">
                <span className="tw:mb-[6px] tw:block tw:font-mono tw:text-[0.62rem] tw:font-bold tw:tracking-[0.08em] tw:text-ink-350">
                  REALIZED P&amp;L
                </span>
                <strong
                  className={
                    selected.summary.realizedPnl >= 0 ? "positive" : "negative"
                  }
                >
                  {money(selected.summary.realizedPnl, selected.currency)}
                </strong>
              </div>
              <div className="tw:bg-surface tw:p-[14px]">
                <span className="tw:mb-[6px] tw:block tw:font-mono tw:text-[0.62rem] tw:font-bold tw:tracking-[0.08em] tw:text-ink-350">
                  OPEN RISK
                </span>
                <strong>
                  {money(selected.summary.openRisk, selected.currency)}
                </strong>
              </div>
            </div>
            <p className="funded-replay-qualification tw:mx-0 tw:mt-0 tw:mb-3 tw:text-[0.72rem] tw:text-ink-350">
              Not qualified for capital allocation ·{" "}
              {selected.qualificationReason} · {selected.executionModelVersion}{" "}
              · {selected.temporalScope.replaceAll("_", " ")}
              {selected.isCurrentAccount ? " · ACCOUNT-WIDE" : ""}
            </p>
            <div className="funded-replay-orders tw:flex tw:flex-col tw:gap-[6px]">
              {selected.orders.map((order) => (
                <div className={FUNDED_REPLAY_ORDER} key={order.orderId}>
                  <strong className="tw:font-mono">
                    {order.instrumentId.slice(0, 8)}
                  </strong>
                  <span>{orderStatusLabel(order)}</span>
                  <span>
                    {order.shares ?? 0} shares
                    {order.entryPrice === null
                      ? ""
                      : ` @ ${order.entryPrice.toFixed(2)}`}
                  </span>
                  <b
                    className={
                      (order.netPnl ?? 0) >= 0 ? "positive" : "negative"
                    }
                  >
                    {order.netPnl === null
                      ? "—"
                      : money(order.netPnl, selected.currency)}
                    {order.rMultiple === null
                      ? ""
                      : ` · ${order.rMultiple.toFixed(2)}R`}
                  </b>
                </div>
              ))}
              {!selected.orders.length && (
                <div className="empty compact tw:p-[25px] tw:text-center tw:text-ink-700">
                  No orders in this replay.
                </div>
              )}
            </div>
            {selected.warnings.map((warning) => (
              <p
                className="research-warning tw:mx-0 tw:mt-0 tw:mb-[9px] tw:rounded-[7px] tw:border tw:border-line-warn-strong tw:bg-surface-warn tw:px-[14px] tw:py-[11px] tw:text-[0.74rem] tw:text-warn-dim"
                key={warning}
              >
                {warning}
              </p>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
