import type { SystemStatus } from "@tsx-scanner/contracts";
import { ago, agoFromMs } from "../lib/format.js";
import {
  deriveAutomationStatus,
  type AutomationStatusView,
} from "../lib/automation-status.js";
import { useNow } from "../lib/use-now.js";
import type { PaperBotIndicator } from "../lib/paper-bot-status.js";
import type { MarketStatus } from "../types.js";
import { Popover, Tip } from "../ui.js";
import { Chip } from "./ui/Chip.js";

const DOT_TONE_CLASSES: Record<AutomationStatusView["tone"], string> = {
  ok: "tw:bg-accent tw:shadow-[0_0_9px_color-mix(in_srgb,var(--accent)_60%,transparent)] tw:animate-status-pulse-slow",
  waiting: "tw:bg-ink-500",
  attention: "tw:bg-warn",
  error:
    "tw:bg-danger tw:shadow-[0_0_9px_color-mix(in_srgb,var(--danger)_60%,transparent)]",
};

const PILL_TONE_CLASSES: Record<AutomationStatusView["tone"], string> = {
  ok: "tw:border-line-accent tw:text-accent",
  waiting: "tw:border-line tw:text-ink-450",
  attention: "tw:border-line-warn tw:text-warn",
  error: "tw:border-line-danger tw:text-danger",
};

const PILL_BASE =
  "system-pill tw:flex tw:grow-0 tw:shrink-0 tw:cursor-pointer tw:items-center tw:gap-2 tw:whitespace-nowrap tw:rounded-input tw:border tw:bg-surface-olive tw:px-3 tw:py-2 tw:font-mono tw:text-[0.66rem] tw:font-bold tw:leading-none tw:tracking-[0.1em] tw:hover:border-line-accent-bright tw:below-md:ml-auto";

function Freshness({
  label,
  value,
  tip,
}: {
  label: string;
  value: string;
  tip: string;
}) {
  return (
    <Tip label={tip}>
      <span className="tw:inline-flex tw:cursor-help tw:gap-[5px] tw:whitespace-nowrap tw:text-ink-500">
        <b className="tw:font-mono tw:text-[0.57rem] tw:font-bold tw:leading-[1.5] tw:tracking-[0.07em] tw:text-ink-700">
          {label}
        </b>
        {value}
      </span>
    </Tip>
  );
}

export function HeaderStatus({
  system,
  market,
  connection,
  botIndicator,
  candidateCount,
  checkedAt,
  pollError,
  marketInactive,
}: {
  system?: SystemStatus;
  market?: MarketStatus;
  connection: "LIVE" | "RECONNECTING";
  botIndicator: PaperBotIndicator;
  candidateCount: number;
  checkedAt: string | null;
  pollError: string | null;
  marketInactive?: string | null;
}) {
  const now = useNow();
  const view: AutomationStatusView = deriveAutomationStatus({
    system,
    market,
    connection,
    botIndicator,
    candidateCount,
    pollError,
    marketInactive,
  });
  const checkedMs = checkedAt ? Date.parse(checkedAt) : null;
  const elapsedMs =
    checkedMs === null ? 0 : Math.max(0, now.getTime() - checkedMs);
  const evidenceAgeMs =
    view.evidenceAgeMs === null ? null : view.evidenceAgeMs + elapsedMs;
  const ageWith = (baseMs: number | null | undefined) =>
    baseMs === null || baseMs === undefined
      ? null
      : agoFromMs(baseMs + elapsedMs);
  const operational = system?.operational;
  const reasons = operational?.reasonCodes ?? [];
  const quotes = ageWith(operational?.dataFreshness.quoteAgeMs);
  const candles = ageWith(operational?.dataFreshness.candleAgeMs);
  const engine = ageWith(operational?.dataFreshness.evaluationAgeMs);
  const benchmarks = operational
    ? operational.benchmarkReady
      ? "READY"
      : "RESOLVING"
    : null;

  return (
    <Popover
      label="System status"
      triggerClassName={`${PILL_BASE} ${PILL_TONE_CLASSES[view.tone]} tone-${view.tone}`}
      trigger={() => (
        <>
          <span
            className={`tw:h-[7px] tw:w-[7px] tw:shrink-0 tw:rounded-full ${DOT_TONE_CLASSES[view.tone]}`}
            aria-hidden="true"
          />
          {connection}
          {view.pillLabel ? ` · ${view.pillLabel}` : ""}
        </>
      )}
    >
      <div
        className="tw:flex tw:w-[min(340px,calc(100vw_-_32px))] tw:flex-col tw:items-stretch tw:gap-[10px] tw:font-mono tw:text-[0.66rem] tw:leading-[1.5] tw:text-ink-450"
        aria-label="Automation status"
      >
        <div className="tw:flex tw:items-start tw:gap-[9px]">
          <span
            className={`tw:mt-[5px] tw:h-2 tw:w-2 tw:shrink-0 tw:rounded-full ${DOT_TONE_CLASSES[view.tone]}`}
            aria-hidden="true"
          />
          <div className="tw:grid tw:gap-[3px]">
            <strong className="tw:font-mono tw:text-[0.7rem] tw:font-[650] tw:leading-[1.45] tw:text-ink-150">
              {view.headline}
            </strong>
            {view.next ? (
              <span className="tw:text-ink-550">NEXT · {view.next}</span>
            ) : null}
          </div>
        </div>
        <div className="tw:flex tw:flex-wrap tw:gap-[6px]">
          {view.session ? <Chip>SESSION · {view.session}</Chip> : null}
          {view.universe ? <Chip>UNIVERSE · {view.universe}</Chip> : null}
          <Chip>BOT · {view.bot}</Chip>
          {operational ? (
            reasons.length > 0 ? (
              <Chip className="tw:border-line-warn tw:text-warn">
                SIGNALS · GATED
              </Chip>
            ) : (
              <Chip className="tw:border-line-accent tw:text-accent">
                SIGNALS · READY
              </Chip>
            )
          ) : null}
        </div>
        <div className="tw:flex tw:flex-wrap tw:gap-x-[13px] tw:gap-y-[5px] tw:border-t tw:border-line tw:pt-[10px]">
          <Freshness
            label="STATUS"
            value={checkedAt ? ago(now, checkedAt) : "not checked yet"}
            tip="When this page last fetched a full status snapshot. WebSocket frames suppress unchanged content, so this is the proof of a fresh check — not of market activity."
          />
          <Freshness
            label="LAST CYCLE"
            value={ago(now, view.lastCycleAt)}
            tip="When the automation last completed a processing cycle successfully. A screen refresh does not prove this ran."
          />
          <Freshness
            label="EVIDENCE"
            value={agoFromMs(evidenceAgeMs)}
            tip="Age of the newest strategy evaluation that the candidate board is based on. Separate from both the screen refresh and the process cycle."
          />
          {quotes ? (
            <Freshness
              label="QUOTES"
              value={quotes}
              tip="Age of the newest quote this market's collector accepted. Stale quotes gate signals regardless of how fresh the page or the engine is."
            />
          ) : null}
          {candles ? (
            <Freshness
              label="CANDLES"
              value={candles}
              tip="Age of the newest completed candle used to derive features."
            />
          ) : null}
          {engine ? (
            <Freshness
              label="ENGINE"
              value={engine}
              tip="Age of the newest strategy evaluation. This is what the candidate board is based on."
            />
          ) : null}
          {benchmarks ? (
            <Freshness
              label="BENCHMARKS"
              value={benchmarks}
              tip="Whether the benchmark context needed for relative evaluations has resolved. Context stays gated until it does."
            />
          ) : null}
        </div>
        {view.attention.length > 0 ? (
          <ul className="tw:m-0 tw:grid tw:gap-[2px] tw:border-t tw:border-line tw:pt-[9px] tw:text-[0.66rem] tw:text-warn-soft">
            {view.attention.map((line) => (
              <li className="tw:m-0" key={line}>
                {line}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </Popover>
  );
}
