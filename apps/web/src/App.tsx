import {
  browserEventSchema,
  alertPolicySchema,
  type AlertPolicy,
  type BacktestRun,
  type ContextEvaluation,
  type ScannerAlert,
  type ScannerProfile,
  type StatisticalPrediction,
  type StrategyDefinition,
  type StrategyEvaluation,
  type SystemStatus,
  type UniverseAutomation,
} from "@tsx-scanner/contracts";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Popover, Tip } from "./ui.js";
import { Button } from "./components/ui/Button.js";
import {
  FieldInput,
  FieldSelect,
  FormField,
} from "./components/ui/FormField.js";
import { classes } from "./lib/classes.js";
import { HeaderStatus } from "./components/HeaderStatus.js";
import { ToastStack } from "./components/ToastStack.js";
import { sendJson, ApiRequestError } from "./lib/api.js";
import { alertDedupeKey, partitionUnseenAlerts } from "./lib/alerts.js";
import { emptyBoardMessage } from "./lib/automation-status.js";
import { displayStrategy } from "./lib/format.js";
import { mergeMarketStatus } from "./lib/market-merge.js";
import {
  allNotificationsSupported,
  playAlertSound,
} from "./lib/notifications.js";
import { derivePaperBotIndicator } from "./lib/paper-bot-status.js";
import type { PaperBotIndicator } from "./lib/paper-bot-status.js";
import { buildRankedRows } from "./lib/ranking.js";
import {
  loadActivePredictions,
  loadBootstrap,
  loadMarketStatus,
  loadSystemStatus,
} from "./lib/resources.js";
import { createStatusPoller } from "./lib/status-poller.js";
import type {
  BoardFilters,
  MarketStatus,
  NotificationPreference,
} from "./types.js";
import { Detail } from "./views/DetailView.js";
import {
  AlertHistory,
  ScannerBoard,
  ScannerFilters,
} from "./views/ScannerView.js";
import { UniverseView } from "./views/UniverseView.js";
import { DiscoveryView } from "./views/DiscoveryView.js";

// W9: the four research workspaces below are large, code-split from the eagerly loaded scanner
// board so a session that never opens Strategy Lab / Backtests / Calibration / Models doesn't pay
// to parse and execute them. `React.lazy` needs a `{ default }` module; each view module exports
// its component by name (not `default`), so the loader picks it out of the resolved module.
const StrategyLab = lazy(() =>
  import("./views/StrategyLabView.js").then((module) => ({
    default: module.StrategyLab,
  })),
);
const BacktestView = lazy(() =>
  import("./views/BacktestView.js").then((module) => ({
    default: module.BacktestView,
  })),
);
const LearningView = lazy(() =>
  import("./views/LearningView.js").then((module) => ({
    default: module.LearningView,
  })),
);
const BotView = lazy(() =>
  import("./views/BotView.js").then((module) => ({
    default: module.BotView,
  })),
);
const BotPerformanceView = lazy(() =>
  import("./views/BotPerformanceView.js").then((module) => ({
    default: module.BotPerformanceView,
  })),
);

type AppView =
  | "scanner"
  | "universe"
  | "discovery"
  | "bot"
  | "botPerformance"
  | "learning"
  | "lab"
  | "backtests";

const PAGE_COPY: Record<AppView, { title: string; lede: string }> = {
  scanner: {
    title: "Live candidates",
    lede: "One shared stream, independently ranked profile views.",
  },
  universe: {
    title: "Daily candidate list",
    lede: "Today's symbols and their warm-up progress; the list refreshes automatically at each new session.",
  },
  discovery: {
    title: "Candidate discovery",
    lede: "Shadow evaluation of the provider catalog. Nothing is added to the daily list automatically while intake is disabled.",
  },
  bot: {
    title: "BOT evidence",
    lede: "What the unattended bot is doing now, and the forward evidence it has produced.",
  },
  botPerformance: {
    title: "Bot performance",
    lede: "Retained paper results by session, including positions that have not finished.",
  },
  lab: {
    title: "Strategy Lab",
    lede: "Version profiles and compare them on controlled evidence.",
  },
  learning: {
    title: "Learning & Coordination",
    lede: "What evidence is accumulating, what is waiting, and what needs review.",
  },
  backtests: {
    title: "Backtest & Studies",
    lede: "Automation state, waiting reasons, and retained study results.",
  },
};

const NAV_TIPS: Record<AppView, string> = {
  scanner:
    "Live board. Setup candidates from the shared real-time stream, ranked state-first.",
  universe:
    "The symbols scanned today. Paste a TradingView scan here; the count is how many symbols are configured.",
  discovery:
    "Shadow discovery evidence, catalog freshness, fenced scheduler state, and the durable mode authority.",
  lab: "Build and version scanner profiles, then compare two configurations on the same evidence.",
  bot: "Automated forward paper evidence. Counts and performance remain separated by immutable profile configuration.",
  botPerformance:
    "Persistent paper-bot trade history, grouped by market session. Historical records remain available after market close.",
  learning:
    "Centralized machine learning lifecycle, evidence readiness, forward calibration monitoring, and shadow coordination experiments.",
  backtests:
    "Run explicit captured-history studies and inspect their durable evidence; nothing here activates a strategy.",
};

/* Explicit tone maps: each entry supplies complete class strings so no two
 * utilities in the same element target the same declaration. */
const BOT_DOT_TONE_CLASSES: Record<PaperBotIndicator["tone"], string> = {
  ok: "tw:bg-accent tw:shadow-[0_0_9px_color-mix(in_srgb,var(--accent)_60%,transparent)] tw:animate-status-pulse",
  attention: "tw:bg-warn",
  error:
    "tw:bg-danger tw:shadow-[0_0_9px_color-mix(in_srgb,var(--danger)_60%,transparent)]",
  idle: "tw:bg-ink-650",
};

/* Alert-preference toggles: complete class strings per state so only one
 * declaration set for border/text color is present at a time. */
const ALERT_TOGGLE_BASE =
  "tw:flex-auto tw:cursor-pointer tw:rounded-input tw:border tw:bg-surface tw:px-[10px] tw:py-2 tw:font-mono tw:text-[0.61rem] tw:font-bold tw:tracking-[0.07em] tw:disabled:cursor-not-allowed tw:disabled:opacity-55";
const ALERT_TOGGLE_CLASSES = {
  active: classes(ALERT_TOGGLE_BASE, "tw:border-line-accent tw:text-accent"),
  inactive: classes(ALERT_TOGGLE_BASE, "tw:border-line-input tw:text-ink-600"),
  disabled: classes(ALERT_TOGGLE_BASE, "tw:border-line-input tw:text-ink-600"),
} as const;

export function App() {
  const [system, setSystem] = useState<SystemStatus>();
  const [market, setMarket] = useState<MarketStatus>();
  const [selectedMarket, setSelectedMarket] = useState<
    "CA_TSX" | "US_EQUITIES"
  >("CA_TSX");
  const [universe, setUniverse] = useState<UniverseAutomation>();
  const [candidates, setCandidates] = useState<StrategyEvaluation[]>([]);
  const [contexts, setContexts] = useState<ContextEvaluation[]>([]);
  const [alerts, setAlerts] = useState<ScannerAlert[]>([]);
  const [profiles, setProfiles] = useState<ScannerProfile[]>([]);
  const [backtests, setBacktests] = useState<BacktestRun[]>([]);
  const [definitions, setDefinitions] = useState<StrategyDefinition[]>([]);
  const [activeProfile, setActiveProfile] = useState<string>("ALL");
  const [toasts, setToasts] = useState<ScannerAlert[]>([]);
  const [selected, setSelected] = useState<string>();
  const [view, setView] = useState<AppView>("scanner");
  const [connection, setConnection] = useState<"LIVE" | "RECONNECTING">(
    "RECONNECTING",
  );
  const [error, setError] = useState("");
  const [statusCheckedAt, setStatusCheckedAt] = useState<string | null>(null);
  const [statusPollError, setStatusPollError] = useState<string | null>(null);
  const [marketInactive, setMarketInactive] = useState<string | null>(null);
  const [activePredictions, setActivePredictions] = useState<
    StatisticalPrediction[]
  >([]);
  const [alertPolicy, setAlertPolicy] = useState<AlertPolicy>({
    cooldownMinutes: 5,
    rearmRule: "NEW_SETUP_INSTANCE",
    contextNotificationsEnabled: false,
  });
  const [boardFilters, setBoardFilters] = useState<BoardFilters>({
    state: "ALL",
    setup: "ALL",
    sector: "ALL",
    context: "ALL",
    readiness: "ALL",
    maximumSpread: "",
  });
  const initialNotificationPreference = (): NotificationPreference =>
    !allNotificationsSupported()
      ? "unsupported"
      : Notification.permission === "denied"
        ? "blocked"
        : localStorage.getItem("tsx-scanner-browser-alerts") === "true" &&
            Notification.permission === "granted"
          ? "enabled"
          : "disabled";
  const [notificationPreference, setNotificationPreference] =
    useState<NotificationPreference>(initialNotificationPreference);
  const [soundEnabled, setSoundEnabled] = useState(
    () => localStorage.getItem("tsx-scanner-alert-sound") === "true",
  );
  const notificationRef = useRef(notificationPreference);
  const soundRef = useRef(soundEnabled);
  const seenAlerts = useRef(new Set<string>());
  const alertsInitialized = useRef(false);
  const audioContext = useRef<AudioContext | undefined>(undefined);
  // W6b: every WS frame is still a full snapshot (candidates/contexts/alerts/market are
  // replaced wholesale below, never merged), so `seq` never gates a state update — a gap
  // just means the server suppressed byte-identical frames while nothing changed, and a
  // reset to a lower value just means a fresh connection sent its own full snapshot. This
  // ref only tracks the value so a dropped-frame regression (seq going backward without a
  // socket reconnect) is visible to instrumentation without changing render behavior.
  const lastFrameSeqRef = useRef<number>(undefined);
  notificationRef.current = notificationPreference;
  soundRef.current = soundEnabled;

  const deliverAlerts = (incoming: ScannerAlert[]) => {
    const { unseen } = partitionUnseenAlerts(incoming, seenAlerts.current);
    if (!alertsInitialized.current) {
      alertsInitialized.current = true;
      return;
    }
    if (unseen.length === 0) return;
    setToasts((current) => [...unseen, ...current].slice(0, 4));
    for (const alert of unseen) {
      if (
        notificationRef.current === "enabled" &&
        Notification.permission === "granted"
      )
        new Notification(alert.title, {
          body: alert.message,
          tag: alertDedupeKey(alert),
        });
      if (soundRef.current && audioContext.current)
        playAlertSound(audioContext.current, alert.type);
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    setMarket(undefined);
    setUniverse(undefined);
    setCandidates([]);
    setContexts([]);
    setAlerts([]);
    setSelected(undefined);
    setError("");
    setStatusCheckedAt(null);
    setStatusPollError(null);
    setMarketInactive(null);
    alertsInitialized.current = false;

    loadBootstrap(controller.signal, selectedMarket)
      .then((result) => {
        if (controller.signal.aborted) return;
        setSystem(result.critical.system);
        setMarket(result.critical.market);
        setUniverse(result.critical.universe);
        setCandidates(result.critical.candidates);
        setContexts(result.critical.contexts);
        setAlerts(result.critical.alerts);
        deliverAlerts(result.critical.alerts);
        // W9: the research verticals below (backtests, profiles/definitions,
        // alert policy) are the "optional" bootstrap group — one
        // of them failing leaves that piece of state at its default instead of blocking the
        // scanner board above, which only needs the critical group. Calibrations and
        // statistical models are not fetched here: Learning fetches them on demand, so
        // bootstrap no longer pulls data no mounted view retains.
        if (result.optional.profiles) setProfiles(result.optional.profiles);
        if (result.optional.backtests) setBacktests(result.optional.backtests);
        if (result.optional.definitions)
          setDefinitions(result.optional.definitions);
        if (result.optional.alertPolicy)
          setAlertPolicy(result.optional.alertPolicy);
        if (result.optionalFailures.length > 0)
          setError(
            `Some research data didn’t load: ${result.optionalFailures.join(", ")}. The live board is unaffected.`,
          );
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setError(
          reason instanceof Error ? reason.message : "Dashboard unavailable",
        );
      });

    let socket: WebSocket | undefined;
    let reconnect: number | undefined;
    let stopped = false;
    let attempt = 0;
    const WS_RECONNECT_BASE_MS = 1_000;
    const WS_RECONNECT_MAX_MS = 30_000;
    const scheduleReconnect = () => {
      if (stopped) return;
      const backoff = Math.min(
        WS_RECONNECT_MAX_MS,
        WS_RECONNECT_BASE_MS * 2 ** attempt,
      );
      attempt += 1;
      reconnect = window.setTimeout(
        connect,
        backoff * (0.5 + Math.random() * 0.5),
      );
    };
    const connect = () => {
      socket = new WebSocket(
        `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws?marketId=${selectedMarket}`,
      );
      socket.onopen = () => {
        attempt = 0;
        lastFrameSeqRef.current = undefined;
        setConnection("LIVE");
      };
      socket.onmessage = (message) => {
        let raw: unknown;
        try {
          raw = JSON.parse(String(message.data));
        } catch {
          return;
        }
        const parsed = browserEventSchema.safeParse(raw);
        if (!parsed.success) return;
        if (typeof parsed.data.seq === "number")
          lastFrameSeqRef.current = parsed.data.seq;
        if (parsed.data.market) {
          const incoming = parsed.data.market as MarketStatus;
          // Merge rather than replace: the WS frame intentionally strips
          // per-cycle telemetry, so a later REST status check can fill fields
          // the stream does not carry. Optional failure/freshness fields the
          // frame omits are cleared so a recovered error stops rendering.
          setMarket((current) => mergeMarketStatus(current, incoming));
        }
        if (parsed.data.universe) {
          const incoming = parsed.data.universe;
          setUniverse((current) => {
            // WebSocket snapshots are intentionally synchronous and do not
            // query the durable intake tables every two seconds. Preserve the
            // status-enriched REST bootstrap/mutation payload until the next
            // explicit status refresh instead of letting a status-less live
            // frame erase lifecycle visibility.
            if (
              incoming.candidateStatuses === undefined &&
              current?.policy.marketId === incoming.policy.marketId
            )
              return {
                ...incoming,
                candidateStatuses: current.candidateStatuses,
              };
            return incoming;
          });
        }
        if (parsed.data.candidates) setCandidates(parsed.data.candidates);
        if (parsed.data.contexts) setContexts(parsed.data.contexts);
        if (parsed.data.alerts) {
          setAlerts(parsed.data.alerts);
          deliverAlerts(parsed.data.alerts);
        }
      };
      socket.onerror = () => socket?.close();
      socket.onclose = () => {
        if (!stopped) {
          setConnection("RECONNECTING");
          scheduleReconnect();
        }
      };
    };
    connect();
    return () => {
      stopped = true;
      controller.abort();
      if (reconnect) clearTimeout(reconnect);
      socket?.close();
    };
  }, [selectedMarket]);

  useEffect(() => {
    let stopped = false;
    const refresh = async () => {
      const value = await loadActivePredictions();
      if (!stopped) setActivePredictions(value);
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);

  // Full status check every 15s. WebSocket frames deliberately suppress
  // unchanged content (ws-frame.ts), so the automation row needs its own REST
  // read to know when the status it shows was actually verified, and to pull
  // fields the broadcast frame strips. The shared poller skips ticks while a
  // check is pending, and the generation counter discards any response from a
  // previous market after the selection changed. The "checked at" clock is set
  // only when the system-status read succeeds: a successful market-only read
  // must not make a failed health check look fresh.
  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;
    let generation = 0;
    const check = async () => {
      const currentGeneration = ++generation;
      const [systemResult, marketResult] = await Promise.allSettled([
        loadSystemStatus(selectedMarket, controller.signal),
        loadMarketStatus(selectedMarket, controller.signal),
      ]);
      if (stopped || currentGeneration !== generation) return;
      if (systemResult.status === "fulfilled") {
        setSystem(systemResult.value);
        setStatusCheckedAt(new Date().toISOString());
      }
      // The REST snapshot is the full, authoritative market status: replace
      // rather than merge so omitted failure fields actually clear.
      if (marketResult.status === "fulfilled") setMarket(marketResult.value);
      // A 409 means the selected market is intentionally absent from this
      // runtime (market-data and system-status route guards), not that status
      // checking broke.
      const inactive = [systemResult, marketResult].some(
        (result) =>
          result.status === "rejected" &&
          result.reason instanceof ApiRequestError &&
          result.reason.status === 409,
      );
      setMarketInactive(inactive ? selectedMarket : null);
      const systemFailure =
        !inactive && systemResult.status === "rejected"
          ? systemResult.reason instanceof Error
            ? systemResult.reason.message
            : "system status unavailable"
          : null;
      const marketFailure =
        !inactive && marketResult.status === "rejected"
          ? marketResult.reason instanceof Error
            ? marketResult.reason.message
            : "market status unavailable"
          : null;
      setStatusPollError(systemFailure ?? marketFailure);
    };
    const poller = createStatusPoller(check, 15_000);
    poller.start();
    return () => {
      stopped = true;
      generation += 1;
      poller.stop();
      controller.abort();
    };
  }, [selectedMarket]);

  useEffect(() => {
    if (!soundEnabled) return;
    const arm = () => {
      audioContext.current ??= new AudioContext();
      void audioContext.current.resume();
    };
    window.addEventListener("pointerdown", arm, { once: true });
    return () => window.removeEventListener("pointerdown", arm);
  }, [soundEnabled]);

  const toggleNotifications = async () => {
    if (!allNotificationsSupported()) {
      setNotificationPreference("unsupported");
      return;
    }
    if (notificationPreference === "enabled") {
      localStorage.setItem("tsx-scanner-browser-alerts", "false");
      setNotificationPreference("disabled");
      return;
    }
    const permission = await Notification.requestPermission();
    const next = permission === "granted" ? "enabled" : "blocked";
    localStorage.setItem(
      "tsx-scanner-browser-alerts",
      String(next === "enabled"),
    );
    setNotificationPreference(next);
  };
  const toggleSound = async () => {
    const next = !soundEnabled;
    if (next) {
      audioContext.current ??= new AudioContext();
      await audioContext.current.resume();
      playAlertSound(audioContext.current, "READY");
    }
    setSoundEnabled(next);
    soundRef.current = next;
    localStorage.setItem("tsx-scanner-alert-sound", String(next));
  };
  const saveAlertPolicy = async (next: AlertPolicy) => {
    setAlertPolicy(next);
    setError("");
    try {
      setAlertPolicy(
        alertPolicySchema.parse(
          await sendJson("/api/alerts/policy", "PUT", next),
        ),
      );
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Unable to update alert policy",
      );
    }
  };
  // Phase 4 ranking policy: setup state, then setup score, then context as a
  // deterministic tie-breaker. The optional statistical model annotates rows but
  // never reorders them.
  const modelRanks = useMemo(
    () =>
      new Map(
        activePredictions.map((value) => [
          `${value.profileId}:${value.symbol}`,
          value.rankingScore,
        ]),
      ),
    [activePredictions],
  );
  const sectorOptions = useMemo(
    () =>
      [
        ...new Set(
          (universe?.members ?? []).flatMap((value) =>
            value.sector ? [value.sector] : [],
          ),
        ),
      ].sort(),
    [universe],
  );
  const ranked = useMemo(
    () =>
      buildRankedRows(
        candidates,
        contexts,
        universe,
        activeProfile,
        boardFilters,
        selectedMarket,
      ),
    [
      candidates,
      contexts,
      universe,
      activeProfile,
      boardFilters,
      selectedMarket,
    ],
  );
  const dismissToast = (alertId: string) =>
    setToasts((current) =>
      current.filter((value) => value.alertId !== alertId),
    );
  const botIndicator = derivePaperBotIndicator(market?.paperBot);

  if (selected)
    return (
      <main>
        <ToastStack alerts={toasts} dismiss={dismissToast} />
        <Detail
          symbol={selected}
          profileId={activeProfile}
          close={() => setSelected(undefined)}
        />
      </main>
    );

  return (
    <main>
      <ToastStack alerts={toasts} dismiss={dismissToast} />
      <header className="tw:-mx-8 tw:below-md:-mx-[14px]">
        <div className="tw:relative tw:z-20 tw:flex tw:min-h-14 tw:items-center tw:justify-between tw:gap-[18px] tw:border-b tw:border-line tw:bg-bg tw:px-5 tw:py-[7px] tw:below-md:flex-wrap tw:below-md:gap-x-3 tw:below-md:gap-y-[7px] tw:below-md:px-[14px] tw:below-md:py-[10px]">
          <Tip
            label="TSX intraday setup scanner. One shared market stream is evaluated by every enabled profile; each profile ranks it independently."
            placement="bottom-start"
          >
            <p className="tw:m-0 tw:shrink-0 tw:cursor-help tw:font-mono tw:text-[0.69rem] tw:font-bold tw:leading-[1.4] tw:tracking-[0.14em] tw:text-ink-100 tw:below-sm:text-[0.63rem]">
              TSX INTRADAY SCANNER
            </p>
          </Tip>
          <label className="tw:grid tw:gap-[2px] tw:font-mono tw:text-[0.55rem] tw:font-bold tw:tracking-[0.08em] tw:text-ink-550">
            MARKET
            <select
              className="tw:rounded-[5px] tw:border tw:border-line tw:bg-bg tw:px-[5px] tw:py-[3px] tw:font-mono tw:text-[0.62rem] tw:font-bold tw:text-ink-100"
              aria-label="Market"
              value={selectedMarket}
              onChange={(event) =>
                setSelectedMarket(
                  event.target.value as "CA_TSX" | "US_EQUITIES",
                )
              }
            >
              <option value="CA_TSX">TSX · CAD</option>
              <option value="US_EQUITIES">US · USD</option>
            </select>
          </label>
          <nav
            className="tw:flex tw:flex-auto tw:min-w-0 tw:justify-start tw:gap-[3px] tw:below-md:order-3 tw:below-md:basis-full tw:below-md:overflow-x-auto tw:below-md:pb-[2px]"
            aria-label="Sections"
          >
            {(
              [
                ["scanner", "SCANNER"],
                ["discovery", "DISCOVERY"],
                [
                  "universe",
                  `DAILY LIST · ${universe?.configuredSymbols?.length ?? 0}`,
                ],
                ["bot", "BOT"],
                ["botPerformance", "BOT PERFORMANCE"],
                ["learning", "LEARNING"],
                ["lab", "STRATEGY LAB"],
                ["backtests", "BACKTESTS"],
              ] as [AppView, string][]
            ).map(([key, label]) => {
              const active = view === key;
              const botDotClasses = active
                ? classes(
                    "tw:bg-on-accent tw:shadow-none",
                    botIndicator.tone === "ok" && "tw:animate-status-pulse",
                  )
                : BOT_DOT_TONE_CLASSES[botIndicator.tone];
              return (
                <Tip
                  label={
                    key === "bot"
                      ? `${botIndicator.summary}${botIndicator.detail.length ? ` (${botIndicator.detail.join("; ")})` : ""}`
                      : NAV_TIPS[key]
                  }
                  key={key}
                >
                  <Button
                    variant="nav"
                    aria-current={active ? "page" : undefined}
                    onClick={() => setView(key)}
                  >
                    {key === "bot" ? (
                      <span className="nav-bot-status tw:inline-flex tw:items-center tw:gap-[7px]">
                        <span
                          className={`market-dot bot-dot ${botIndicator.tone} tw:h-[7px] tw:w-[7px] tw:rounded-full ${botDotClasses}`}
                        />
                        BOT · {botIndicator.label}
                      </span>
                    ) : (
                      label
                    )}
                  </Button>
                </Tip>
              );
            })}
          </nav>
          <HeaderStatus
            system={system}
            market={market}
            connection={connection}
            botIndicator={botIndicator}
            candidateCount={candidates.length}
            checkedAt={statusCheckedAt}
            pollError={statusPollError}
            marketInactive={marketInactive}
          />
        </div>
      </header>
      <div className="tw:flex tw:flex-wrap tw:items-baseline tw:gap-x-[14px] tw:gap-y-2 tw:pt-[18px] tw:pb-[15px] tw:below-md:flex-col tw:below-md:items-start tw:below-md:gap-1 tw:below-md:pt-[15px] tw:below-md:pb-[13px]">
        <h1>{PAGE_COPY[view].title}</h1>
        <p className="tw:m-0 tw:text-[0.8rem] tw:text-ink-550">
          {PAGE_COPY[view].lede}
        </p>
      </div>
      {error && <p className="error-banner">{error}</p>}
      {view === "scanner" ? (
        <>
          <section
            className="tw:mb-3 tw:flex tw:items-center tw:gap-[9px] tw:rounded-input tw:border tw:border-line-bar tw:bg-surface tw:p-[5px]"
            aria-label="Profile views and alerts"
          >
            <div
              className="tw:flex tw:min-w-0 tw:flex-auto tw:gap-[7px] tw:overflow-x-auto"
              role="tablist"
            >
              <Tip
                label="Merged view: the single best setup per symbol across every enabled profile."
                placement="bottom-start"
              >
                <Button
                  variant="profile"
                  role="tab"
                  aria-selected={activeProfile === "ALL"}
                  onClick={() => setActiveProfile("ALL")}
                >
                  ALL
                </Button>
              </Tip>
              {profiles
                .filter(
                  (value) =>
                    value.enabled &&
                    (value.analysisKind ?? "SETUP") === "SETUP",
                )
                .map((profile) => (
                  <Tip
                    key={profile.id}
                    label={
                      <>
                        <b>
                          {displayStrategy(profile.strategyKey)}
                          {profile.strategyVersion
                            ? ` v${profile.strategyVersion}`
                            : ""}
                        </b>
                        <br />
                        {profile.configVersion
                          ? `Config ${profile.configVersion} · `
                          : ""}
                        {(profile.qualification ?? "EXPLORATORY").replaceAll(
                          "_",
                          " ",
                        )}
                        <br />
                        {profile.qualificationReason ??
                          "No qualifying evidence is linked to this profile configuration."}
                      </>
                    }
                  >
                    <Button
                      variant="profile"
                      role="tab"
                      aria-selected={activeProfile === profile.id}
                      onClick={() => setActiveProfile(profile.id)}
                    >
                      {profile.name}
                    </Button>
                  </Tip>
                ))}
            </div>
            <ScannerFilters
              filters={boardFilters}
              sectors={sectorOptions}
              changed={setBoardFilters}
            />
            <Popover
              label="Alert settings"
              trigger={() => (
                <>
                  ALERTS · {notificationPreference === "enabled" ? "ON" : "OFF"}
                  {soundEnabled ? " · SOUND" : ""}
                </>
              )}
            >
              <div
                className="tw:flex tw:w-[min(310px,calc(100vw_-_32px))] tw:flex-col tw:items-stretch tw:gap-[11px]"
                aria-label="Alert preferences"
              >
                <div className="tw:flex tw:flex-1 tw:flex-col tw:gap-[3px]">
                  <strong className="tw:text-[0.76rem]">
                    Setup-instance alerts
                  </strong>
                  <span className="tw:text-[0.7rem] tw:text-ink-700">
                    READY is durable and delivered once per setup instance.
                    Context notifications stay off.
                  </span>
                </div>
                <Tip
                  label="Minimum minutes before the same setup instance may alert again. Set 0 for no cooldown."
                  placement="left"
                >
                  <FormField
                    className="tw:relative tw:min-w-0"
                    label="COOLDOWN"
                  >
                    <FieldInput
                      className="tw:[appearance:textfield] tw:[&::-webkit-outer-spin-button]:appearance-none tw:[&::-webkit-inner-spin-button]:appearance-none tw:[&::-webkit-inner-spin-button]:m-0 tw:pr-[46px]"
                      aria-label="Alert cooldown minutes"
                      type="number"
                      min="0"
                      max="120"
                      value={alertPolicy.cooldownMinutes}
                      onChange={(event) =>
                        void saveAlertPolicy({
                          ...alertPolicy,
                          cooldownMinutes: Math.max(
                            0,
                            Math.min(120, Number(event.target.value)),
                          ),
                        })
                      }
                    />
                    <small className="tw:absolute tw:right-[11px] tw:bottom-[10px] tw:m-0 tw:font-mono tw:text-[0.58rem] tw:font-bold tw:tracking-[0.08em] tw:text-ink-750">
                      MIN
                    </small>
                  </FormField>
                </Tip>
                <Tip
                  label="When a setup may alert a second time. NEW INSTANCE: once per setup instance only. AFTER INVALIDATION: alert again if it invalidates and re-forms."
                  placement="left"
                >
                  <FormField className="tw:relative tw:min-w-0" label="RE-ARM">
                    <FieldSelect
                      className="tw:min-w-[150px]"
                      aria-label="Alert re-arm rule"
                      value={alertPolicy.rearmRule}
                      onChange={(event) =>
                        void saveAlertPolicy({
                          ...alertPolicy,
                          rearmRule: event.target
                            .value as AlertPolicy["rearmRule"],
                        })
                      }
                    >
                      <option value="NEW_SETUP_INSTANCE">NEW INSTANCE</option>
                      <option value="AFTER_INVALIDATION">
                        AFTER INVALIDATION
                      </option>
                    </FieldSelect>
                  </FormField>
                </Tip>
                <div className="tw:flex tw:flex-row tw:flex-wrap tw:gap-[7px]">
                  <Tip
                    label="Context changes never raise notifications. Fixed by design, so context stays a filter rather than a trigger."
                    placement="left"
                  >
                    <button
                      type="button"
                      className={ALERT_TOGGLE_CLASSES.disabled}
                      disabled
                    >
                      CONTEXT · OFF
                    </button>
                  </Tip>
                  <Tip
                    label="Desktop notifications when a setup turns READY. Needs browser permission; blocked or unsupported browsers stay off."
                    placement="left"
                  >
                    <button
                      type="button"
                      className={
                        notificationPreference === "enabled"
                          ? ALERT_TOGGLE_CLASSES.active
                          : ALERT_TOGGLE_CLASSES.inactive
                      }
                      disabled={
                        notificationPreference === "unsupported" ||
                        notificationPreference === "blocked"
                      }
                      onClick={() => void toggleNotifications()}
                    >
                      BROWSER · {notificationPreference.toUpperCase()}
                    </button>
                  </Tip>
                  <Tip
                    label="Play a short tone when a READY alert fires. Requires one click on the page first, per browser autoplay rules."
                    placement="left"
                  >
                    <button
                      type="button"
                      className={
                        soundEnabled
                          ? ALERT_TOGGLE_CLASSES.active
                          : ALERT_TOGGLE_CLASSES.inactive
                      }
                      onClick={() => void toggleSound()}
                    >
                      SOUND · {soundEnabled ? "ON" : "OFF"}
                    </button>
                  </Tip>
                </div>
              </div>
            </Popover>
          </section>
          <ScannerBoard
            rows={ranked}
            modelRanks={modelRanks}
            select={setSelected}
            emptyMessage={
              emptyBoardMessage(system?.operational.reasonCodes ?? []) ??
              undefined
            }
          />
          <AlertHistory alerts={alerts} select={setSelected} />
        </>
      ) : view === "universe" && universe ? (
        <UniverseView
          automation={universe}
          updated={setUniverse}
          marketId={selectedMarket}
          marketChanged={setSelectedMarket}
        />
      ) : view === "discovery" ? (
        <DiscoveryView marketId={selectedMarket} />
      ) : (
        // W9: research workspaces are code-split (see the `lazy(...)` declarations above), so
        // switching into one of them for the first time triggers its chunk fetch here; `Suspense`
        // just needs a fallback for that one moment, not a skeleton UI.
        <Suspense fallback={<p className="tw:m-0 tw:text-ink-550">Loading…</p>}>
          {view === "lab" ? (
            <StrategyLab
              profiles={profiles}
              definitions={definitions}
              updated={setProfiles}
              marketId={selectedMarket}
              onOpenBacktests={() => setView("backtests")}
            />
          ) : view === "backtests" ? (
            <BacktestView
              runs={backtests.filter((run) => run.marketId === selectedMarket)}
              updateRuns={(updated) =>
                setBacktests((current) => [
                  ...updated,
                  ...current.filter((run) => run.marketId !== selectedMarket),
                ])
              }
              marketId={selectedMarket}
              onOpenUniverse={() => setView("universe")}
            />
          ) : view === "bot" ? (
            <BotView
              marketId={selectedMarket}
              paperBot={market?.paperBot}
              onOpenPerformance={() => setView("botPerformance")}
            />
          ) : view === "botPerformance" ? (
            <BotPerformanceView marketId={selectedMarket} />
          ) : (
            <LearningView marketId={selectedMarket} />
          )}
        </Suspense>
      )}
      <footer className="tw:mt-[22px] tw:-mx-8 tw:-mb-[18px] tw:flex tw:flex-wrap tw:gap-7 tw:border-t tw:border-line tw:px-8 tw:py-[9px] tw:font-mono tw:text-[0.62rem] tw:font-[650] tw:tracking-[0.1em] tw:text-ink-750 tw:below-md:-mx-[14px] tw:below-md:px-[14px]">
        <Tip
          label={
            system
              ? "The live market-data mode this API was started with. Never inferred client-side."
              : "Mode has not loaded yet."
          }
          placement="top-start"
        >
          <span>MODE · {system ? system.mode.toUpperCase() : "—"}</span>
        </Tip>
        <span>API · {system?.version ?? "—"}</span>
        <Tip
          label={
            system?.operational
              ? system.operational.actionable
                ? "Every actionability condition (auth, session, universe, benchmarks, engine sync, data freshness) is satisfied."
                : `Not actionable: ${system.operational.reasonCodes.join(", ") || "waiting on dependencies"}.`
              : "Actionability has not loaded yet."
          }
          placement="top-end"
        >
          <span>
            SAFETY ·{" "}
            {system?.operational
              ? system.operational.actionable
                ? "ACTIONABLE"
                : "SIGNALS GATED"
              : "—"}
          </span>
        </Tip>
      </footer>
    </main>
  );
}
