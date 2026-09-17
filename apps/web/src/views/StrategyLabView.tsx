import {
  backtestAutomationStatusSchema,
  type BacktestAutomationStatus,
  type BacktestAutomationWork,
  type ParameterDescriptor,
  type ParameterIssue,
  type ComparisonCohort,
  type ProfileComparison,
  type ProfileConfigHistory,
  type ScannerProfile,
  type StrategyDefinition,
  type StrategyParameters,
  defaultStrategyParameters,
  defaultStopPolicyForStrategy,
  descriptorsForDefinition,
  fixedParameterDescriptors,
  profileComparisonSchema,
  profileConfigHistorySchema,
  scannerProfileListSchema,
  scannerProfileSchema,
  validateStrategyParameters,
} from "@tsx-scanner/contracts";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ApiRequestError, getJson, sendJson } from "../lib/api.js";
import { classes } from "../lib/classes.js";
import {
  comparisonHeading,
  formatClosedOutcomeDrawdown,
} from "../lib/comparison-presentation.js";
import { dateInput, displayStrategy } from "../lib/format.js";
import { useRefreshOnFocus } from "../lib/use-refresh.js";
import { Panel, PanelHeader, PanelMeta } from "../components/ui/Panel.js";
import { Tip } from "../ui.js";

const LABEL_CLASSES =
  "tw:grid tw:gap-[7px] tw:font-mono tw:text-[0.64rem] tw:font-bold tw:tracking-[0.07em] tw:text-ink-600";
const CONTROL_CLASSES =
  "tw:w-full tw:rounded-input tw:border tw:border-line-input tw:bg-bg tw:px-[11px] tw:py-[10px] tw:text-ink-100";
const SMALL_BUTTON_CLASSES =
  "tw:cursor-pointer tw:rounded-input tw:border tw:bg-surface tw:px-[10px] tw:py-2 tw:font-mono tw:text-[0.58rem] tw:font-bold";
const LAB_BUTTON_CLASSES = classes(
  SMALL_BUTTON_CLASSES,
  "tw:border-line-accent-dim tw:text-ink-550",
);
const LAB_BUTTON_ENABLED_CLASSES = classes(
  SMALL_BUTTON_CLASSES,
  "tw:border-line-accent tw:text-accent",
);
const PROFILE_ROW_CLASSES =
  "tw:grid tw:grid-cols-[20px_minmax(0,1fr)_58px_auto_auto_auto] tw:items-center tw:gap-[10px] tw:border-b tw:border-line-subtle tw:px-[18px] tw:py-[13px] tw:below-980:grid-cols-[20px_minmax(0,1fr)_55px] tw:below-980:[&>button]:row-start-2";
const PROFILE_LINK_CLASSES =
  "tw:cursor-pointer tw:border-0 tw:bg-transparent tw:p-0 tw:font-mono tw:text-[0.58rem] tw:font-bold tw:leading-[1.5] tw:tracking-[0.04em] tw:text-accent tw:hover:text-accent-hover tw:hover:underline";
const CHIP_BASE =
  "tw:inline-block tw:whitespace-nowrap tw:rounded-full tw:border tw:px-2 tw:py-[3px] tw:font-mono tw:text-[0.58rem] tw:font-bold tw:leading-[1.5] tw:tracking-[0.04em]";
const CHIP_TONE: Record<string, string> = {
  default: "tw:border-line tw:bg-surface tw:text-ink-400",
  pending: "tw:border-line-accent-mid tw:bg-surface-raised tw:text-accent-tint",
  waiting: "tw:border-line-warn tw:bg-surface-warn tw:text-warn-soft",
  ok: "tw:border-[rgba(34,197,94,0.3)] tw:bg-[rgba(34,197,94,0.15)] tw:text-[#4ade80]",
  bad: "tw:border-line-danger tw:bg-surface-danger tw:text-danger-tint-soft",
  none: "tw:border-dashed tw:border-line tw:bg-transparent tw:text-ink-600",
};
const SCOPE_STATUS_CLASSES =
  "tw:mx-[18px] tw:mt-0 tw:mb-3 tw:grid tw:gap-2 tw:rounded-[8px] tw:p-3 tw:text-ink-700";
const SCOPE_STATUS_STRONG_CLASSES =
  "tw:font-mono tw:text-[0.68rem] tw:font-bold tw:tracking-[0.06em] tw:text-ink-100";
const COMPARE_ROW_BASE =
  "tw:grid tw:min-w-[880px] tw:grid-cols-[1.5fr_repeat(7,0.7fr)] tw:gap-[10px] tw:border-b tw:border-line-subtle tw:px-[18px] tw:py-[13px]";
const EMPTY_COMPACT_CLASSES = "tw:p-[25px] tw:text-center tw:text-ink-700";
const RUN_BUTTON_CLASSES =
  "tw:cursor-pointer tw:rounded-[7px] tw:border tw:border-accent tw:bg-accent tw:px-[14px] tw:py-[11px] tw:font-mono tw:text-[0.65rem] tw:font-[750] tw:tracking-[0.08em] tw:text-on-accent tw:disabled:cursor-wait tw:disabled:opacity-45";

const QUALIFICATION_BADGE_BASE =
  "qualification-badge tw:ml-[5px] tw:inline-block tw:rounded-[4px] tw:border tw:px-[5px] tw:py-[3px] tw:align-middle tw:font-mono tw:text-[0.5rem] tw:font-bold tw:not-italic";
const QUALIFICATION_BADGE_TONES: Record<string, string> = {
  evidence_qualified:
    "tw:border-line-accent tw:bg-surface-raised tw:text-accent-hover",
  paper_qualified:
    "tw:border-line-accent tw:bg-surface-raised tw:text-accent-hover",
  exploratory: "tw:border-line-warn-strong tw:bg-surface-warn tw:text-warn-dim",
};

export function parametersFrom(
  descriptors: ParameterDescriptor[],
  draft: Record<string, string>,
): StrategyParameters {
  const values: Record<string, string | number | undefined> = {
    ...defaultStrategyParameters(),
  };
  for (const descriptor of descriptors)
    values[descriptor.key] = Number(draft[descriptor.key]);
  return {
    ...values,
    stopPolicy: draft.stopPolicy as StrategyParameters["stopPolicy"],
  } as StrategyParameters;
}

export function draftFrom(
  descriptors: ParameterDescriptor[],
  parameters: StrategyParameters,
): Record<string, string> {
  return {
    stopPolicy: parameters.stopPolicy ?? "HYBRID",
    ...Object.fromEntries(
      descriptors.map((descriptor) => [
        descriptor.key,
        String(
          (parameters as unknown as Record<string, number>)[descriptor.key],
        ),
      ]),
    ),
  };
}

export function comparisonRequestUrl(
  profileIds: readonly string[],
  source: "LIVE" | "PAPER" | "BACKTEST",
  startDate: string,
  endDate: string,
  marketId: "CA_TSX" | "US_EQUITIES",
  cohortKeys?: Record<string, string>,
): string {
  const query = new URLSearchParams({
    profileIds: profileIds.join(","),
    source,
    startDate,
    endDate,
    marketId,
  });
  if (cohortKeys && Object.keys(cohortKeys).length)
    query.set("cohortKeys", JSON.stringify(cohortKeys));
  return `/api/comparisons?${query.toString()}`;
}

const AUTOMATION_BLOCKER_LABELS: Record<string, string> = {
  NO_CAPTURED_HISTORY: "not enough captured history yet",
  HISTORY_RANGE_UNAVAILABLE: "requested range is not fully captured",
  POLICY_VIOLATION: "policy input rejected",
  CAPACITY_LIMIT: "queued behind outstanding replays",
  NO_REPLAY_CANDIDATES: "waiting for replay candidates",
};

const AUTOMATION_ORIGIN_LABELS: Record<string, string> = {
  PROFILE_SAVE: "a profile save",
  SCHEDULED_CATCH_UP: "the scheduled check",
  REFRESH_NOW: "a forced rerun",
  EXPLICIT_EXPERIMENT: "an experiment",
  JOB_COMPLETION: "a completed replay",
};

/** Bounded post-save status confirmation: three attempts over about six seconds. */
const SAVE_STATUS_CHECKS = 3;
const SAVE_STATUS_RETRY_MS = 3_000;

interface SavedConfigIdentity {
  configId: string;
  configVersion: string;
}

interface SaveAcknowledgement extends SavedConfigIdentity {
  checking: boolean;
}

function savedConfigIdentity(value: unknown): SavedConfigIdentity | null {
  const parsed = scannerProfileSchema.safeParse(value);
  if (parsed.success)
    return {
      configId: parsed.data.configId,
      configVersion: parsed.data.configVersion,
    };
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (
      typeof record.configId === "string" &&
      typeof record.configVersion === "string"
    )
      return {
        configId: record.configId,
        configVersion: record.configVersion,
      };
  }
  return null;
}

function profileConfigIdentity(profile: ScannerProfile): SavedConfigIdentity {
  return { configId: profile.configId, configVersion: profile.configVersion };
}

function automationState(work: BacktestAutomationWork) {
  if (work.jobStatus === "RUNNING") return "RUNNING" as const;
  if (work.jobStatus === "QUEUED" || work.jobStatus === "CANCELLING")
    return "QUEUED" as const;
  return work.state;
}

function blockerExplanation(work: BacktestAutomationWork): string {
  return work.blockerReason
    ? (AUTOMATION_BLOCKER_LABELS[work.blockerReason] ?? work.blockerReason)
    : "automation unavailable";
}

function elapsedLabel(value: string | null, now: number): string {
  if (!value) return "under a minute";
  const totalMinutes = Math.floor(
    Math.max(0, now - Date.parse(value)) / 60_000,
  );
  if (totalMinutes < 1) return "under a minute";
  if (totalMinutes < 60) return `${totalMinutes} min`;
  return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`;
}

function timestamp(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "—";
}

function automationChip(
  work: BacktestAutomationWork,
  now: number,
): { label: string; tone: string; detail: string } {
  const state = automationState(work);
  const detail = [
    `Triggered by ${AUTOMATION_ORIGIN_LABELS[work.triggerOrigin] ?? work.triggerOrigin}`,
    work.jobStatus ? `job ${work.jobStatus.toLowerCase()}` : "no job yet",
    work.lastSuccessAt ? `last success ${timestamp(work.lastSuccessAt)}` : "",
    work.blockerReason ? `blocker: ${blockerExplanation(work)}` : "",
    work.failureMessage ?? "",
    `version ${work.configVersion}`,
  ]
    .filter(Boolean)
    .join(" · ");
  if (state === "RUNNING") {
    const total = work.progress?.totalSessions ?? null;
    const completed = work.progress?.completedSessions ?? null;
    if (total !== null && completed !== null)
      return {
        label: `Running ${completed}/${total}`,
        tone: "pending",
        detail,
      };
    if (work.progress?.message)
      return {
        label: `Running · ${work.progress.message}`,
        tone: "pending",
        detail,
      };
    return {
      label: `Running · started ${elapsedLabel(
        work.startedAt ?? work.lastDispatchedAt,
        now,
      )}`,
      tone: "pending",
      detail,
    };
  }
  if (state === "QUEUED") return { label: "Queued", tone: "pending", detail };
  if (state === "WAITING")
    return {
      label: `Waiting · ${blockerExplanation(work)}`,
      tone: "waiting",
      detail,
    };
  if (state === "RETRY_SCHEDULED")
    return {
      label: work.nextAttemptAt
        ? `Retrying · next attempt ${timestamp(work.nextAttemptAt)}`
        : "Retrying · next attempt scheduled",
      tone: "waiting",
      detail,
    };
  if (state === "FAILED")
    return { label: "Failed · needs attention", tone: "bad", detail };
  if (state === "BLOCKED")
    return {
      label: `Needs attention · ${blockerExplanation(work)}`,
      tone: "bad",
      detail,
    };
  if (state === "CANCELLED")
    return { label: "Cancelled", tone: "waiting", detail };
  return {
    label: work.evaluatedThrough
      ? `Up to date · evidence through ${work.evaluatedThrough}`
      : "Up to date",
    tone: "ok",
    detail,
  };
}

function acknowledgementText(work: BacktestAutomationWork): string {
  const state = automationState(work);
  if (state === "QUEUED") return "qualification queued";
  if (state === "RUNNING") return "qualification running";
  if (state === "WAITING")
    return `qualification waiting: ${blockerExplanation(work)}`;
  if (state === "RETRY_SCHEDULED")
    return `qualification waiting: retry ${
      work.nextAttemptAt
        ? `scheduled for ${timestamp(work.nextAttemptAt)}`
        : "scheduled"
    }`;
  if (state === "FAILED") return "qualification failed · needs attention";
  if (state === "BLOCKED")
    return `qualification blocked: ${blockerExplanation(work)}`;
  if (state === "CANCELLED") return "qualification cancelled";
  return "already current";
}

export function ParameterFields({
  descriptors,
  draft,
  issues,
  onChange,
}: {
  descriptors: ParameterDescriptor[];
  draft: Record<string, string>;
  issues: ParameterIssue[];
  onChange: (key: string, value: string) => void;
}) {
  return (
    <>
      <label className={LABEL_CLASSES}>
        <span>Stop policy</span>
        <select
          className={CONTROL_CLASSES}
          value={draft.stopPolicy ?? "HYBRID"}
          onChange={(event) => onChange("stopPolicy", event.target.value)}
        >
          <option value="HYBRID">Hybrid support</option>
          <option value="PATTERN_INVALIDATION">Pattern invalidation</option>
          <option value="NEAREST_SUPPORT">Nearest support</option>
        </select>
      </label>
      {(["COMMON", "STRATEGY"] as const).map((group) => {
        const fields = descriptors.filter(
          (descriptor) => descriptor.group === group,
        );
        if (!fields.length) return null;
        return (
          <fieldset
            className="tw:m-0 tw:grid tw:gap-[14px] tw:rounded-[8px] tw:border tw:border-line-bar tw:p-[14px]"
            key={group}
          >
            <legend className="tw:px-[6px] tw:font-mono tw:text-[0.58rem] tw:font-bold tw:tracking-[0.08em] tw:text-accent">
              {group === "COMMON" ? "Common gates" : "Strategy specific"}
            </legend>
            {fields.map((descriptor) => (
              <label className={LABEL_CLASSES} key={descriptor.key}>
                <span>
                  {descriptor.label}
                  {descriptor.unit ? ` (${descriptor.unit})` : ""}
                  {descriptor.fixed ? " · FIXED" : ""}
                </span>
                <input
                  className={classes(
                    CONTROL_CLASSES,
                    descriptor.fixed && "tw:cursor-not-allowed tw:opacity-55",
                  )}
                  type="number"
                  step={descriptor.step}
                  min={descriptor.minimum}
                  max={descriptor.maximum}
                  value={
                    descriptor.fixed
                      ? descriptor.default
                      : (draft[descriptor.key] ?? "")
                  }
                  readOnly={descriptor.fixed}
                  disabled={descriptor.fixed}
                  onChange={(event) =>
                    onChange(descriptor.key, event.target.value)
                  }
                />
                <small className="tw:font-mono tw:text-[0.62rem] tw:font-normal tw:leading-[1.45] tw:tracking-normal tw:text-ink-700">
                  {descriptor.description}
                </small>
                {issues
                  .filter((issue) => issue.key === descriptor.key)
                  .map((issue) => (
                    <em
                      className="tw:font-mono tw:text-[0.6rem] tw:font-bold tw:not-italic tw:text-danger-bright"
                      key={issue.message}
                    >
                      {issue.message}
                    </em>
                  ))}
              </label>
            ))}
            {group === "COMMON" &&
              fixedParameterDescriptors.map((descriptor) => (
                <label className={LABEL_CLASSES} key={descriptor.key}>
                  <span>
                    {descriptor.label} ({descriptor.unit}) · FIXED
                  </span>
                  <input
                    className={classes(
                      CONTROL_CLASSES,
                      "tw:cursor-not-allowed tw:opacity-55",
                    )}
                    type="number"
                    value={descriptor.default}
                    readOnly
                    disabled
                  />
                  <small className="tw:font-mono tw:text-[0.62rem] tw:font-normal tw:leading-[1.45] tw:tracking-normal tw:text-ink-700">
                    {descriptor.description}
                  </small>
                </label>
              ))}
          </fieldset>
        );
      })}
    </>
  );
}

export function StrategyLab({
  profiles,
  definitions,
  updated,
  marketId: statusMarketId = "CA_TSX",
  onOpenBacktests,
}: {
  profiles: ScannerProfile[];
  definitions: StrategyDefinition[];
  updated: (profiles: ScannerProfile[]) => void;
  marketId?: "CA_TSX" | "US_EQUITIES";
  onOpenBacktests?: () => void;
}) {
  const [name, setName] = useState("ORB Experiment"),
    [marketId, setMarketId] = useState<"CA_TSX" | "US_EQUITIES">("CA_TSX"),
    [definitionId, setDefinitionId] = useState(definitions[0]?.id ?? ""),
    [draft, setDraft] = useState<Record<string, string>>({}),
    [editId, setEditId] = useState(""),
    [editDraft, setEditDraft] = useState<Record<string, string>>({}),
    [history, setHistory] = useState<ProfileConfigHistory>(),
    [selectedIds, setSelectedIds] = useState<string[]>([]),
    [source, setSource] = useState<"LIVE" | "PAPER" | "BACKTEST">("LIVE"),
    [startDate, setStartDate] = useState(() =>
      dateInput(new Date(Date.now() - 30 * 86400000)),
    ),
    [endDate, setEndDate] = useState(() => dateInput()),
    [comparison, setComparison] = useState<ProfileComparison>(),
    [cohortKeys, setCohortKeys] = useState<Record<string, string>>({}),
    [availableCohorts, setAvailableCohorts] = useState<ComparisonCohort[]>([]),
    [automationStatus, setAutomationStatus] =
      useState<BacktestAutomationStatus | null>(null),
    [automationError, setAutomationError] = useState(""),
    [saveAcknowledgement, setSaveAcknowledgement] =
      useState<SaveAcknowledgement | null>(null),
    [now, setNow] = useState(() => Date.now()),
    [error, setError] = useState("");
  const automationRequest = useRef(0);
  const automationController = useRef<AbortController | null>(null);
  const acknowledgementPoll = useRef<{
    identity: SavedConfigIdentity;
    attempts: number;
  } | null>(null);
  const acknowledgementTimer = useRef<number | null>(null);
  const clearAcknowledgementTimer = useCallback(() => {
    if (acknowledgementTimer.current !== null) {
      window.clearTimeout(acknowledgementTimer.current);
      acknowledgementTimer.current = null;
    }
  }, []);
  const loadAutomation =
    useCallback(async (): Promise<BacktestAutomationStatus | null> => {
      const generation = ++automationRequest.current;
      automationController.current?.abort();
      const controller = new AbortController();
      automationController.current = controller;
      try {
        const parsed = backtestAutomationStatusSchema.parse(
          await getJson(
            `/api/backtest-automation/status?marketId=${encodeURIComponent(
              statusMarketId,
            )}`,
            controller.signal,
          ),
        );
        if (generation !== automationRequest.current) return null;
        setAutomationStatus(parsed);
        setAutomationError("");
        return parsed;
      } catch (reason) {
        if (
          controller.signal.aborted ||
          generation !== automationRequest.current
        )
          return null;
        setAutomationError(
          reason instanceof Error
            ? reason.message
            : "Unable to load automation status",
        );
        return null;
      }
    }, [statusMarketId]);
  const confirmSaveAcknowledgement = useCallback(
    async (identity: SavedConfigIdentity) => {
      const status = await loadAutomation();
      const polling = acknowledgementPoll.current;
      if (
        !polling ||
        polling.identity.configId !== identity.configId ||
        polling.identity.configVersion !== identity.configVersion
      )
        return;
      const confirmed = (status?.works ?? []).some(
        (work) =>
          work.configId === identity.configId &&
          work.configVersion === identity.configVersion,
      );
      if (confirmed || polling.attempts + 1 >= SAVE_STATUS_CHECKS) {
        acknowledgementPoll.current = null;
        setSaveAcknowledgement((current) =>
          current &&
          current.configId === identity.configId &&
          current.configVersion === identity.configVersion
            ? { ...current, checking: false }
            : current,
        );
        return;
      }
      acknowledgementPoll.current = {
        identity,
        attempts: polling.attempts + 1,
      };
      acknowledgementTimer.current = window.setTimeout(
        () => void confirmSaveAcknowledgement(identity),
        SAVE_STATUS_RETRY_MS,
      );
    },
    [loadAutomation],
  );
  const beginSaveAcknowledgement = useCallback(
    (identity: SavedConfigIdentity) => {
      clearAcknowledgementTimer();
      acknowledgementPoll.current = { identity, attempts: 0 };
      setSaveAcknowledgement({ ...identity, checking: true });
      void confirmSaveAcknowledgement(identity);
    },
    [clearAcknowledgementTimer, confirmSaveAcknowledgement],
  );
  useEffect(() => {
    void loadAutomation();
  }, [loadAutomation]);
  useEffect(() => {
    return () => automationController.current?.abort();
  }, []);
  useEffect(() => {
    setSaveAcknowledgement(null);
    acknowledgementPoll.current = null;
    clearAcknowledgementTimer();
  }, [statusMarketId, clearAcknowledgementTimer]);
  useEffect(() => clearAcknowledgementTimer, [clearAcknowledgementTimer]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(timer);
  }, []);
  useRefreshOnFocus(() => void loadAutomation());
  useEffect(() => {
    if (!definitionId && definitions[0]) setDefinitionId(definitions[0].id);
  }, [definitionId, definitions]);
  const definition = useMemo(
    () => definitions.find((value) => value.id === definitionId),
    [definitions, definitionId],
  );
  const descriptors = useMemo(
    () => (definition ? descriptorsForDefinition(definition) : []),
    [definition],
  );
  useEffect(() => {
    const parameters = defaultStrategyParameters();
    parameters.stopPolicy = defaultStopPolicyForStrategy(
      definition?.strategyKey,
    );
    setDraft(draftFrom(descriptors, parameters));
  }, [definition?.strategyKey, descriptors]);
  const issues = useMemo(
    () =>
      definition && Object.keys(draft).length
        ? validateStrategyParameters(
            definition,
            parametersFrom(descriptors, draft),
          )
        : [],
    [definition, descriptors, draft],
  );
  const editProfile = useMemo(
    () => profiles.find((value) => value.id === editId),
    [profiles, editId],
  );
  const editDefinition = useMemo(
    () =>
      definitions.find(
        (value) => value.id === editProfile?.strategyDefinitionId,
      ),
    [definitions, editProfile],
  );
  const editDescriptors = useMemo(
    () => (editDefinition ? descriptorsForDefinition(editDefinition) : []),
    [editDefinition],
  );
  const editIssues = useMemo(
    () =>
      editDefinition && Object.keys(editDraft).length
        ? validateStrategyParameters(
            editDefinition,
            parametersFrom(editDescriptors, editDraft),
          )
        : [],
    [editDefinition, editDescriptors, editDraft],
  );
  const refresh = async () => {
    const list = scannerProfileListSchema.parse(
      await getJson("/api/scanner-profiles"),
    ).profiles;
    updated(list);
    return list;
  };
  const loadHistory = async (id: string) => {
    try {
      setHistory(
        profileConfigHistorySchema.parse(
          await getJson(`/api/scanner-profiles/${id}/configs`),
        ),
      );
    } catch {
      setHistory(undefined);
    }
  };
  const openEditor = async (profile: ScannerProfile) => {
    const target = definitions.find(
      (value) => value.id === profile.strategyDefinitionId,
    );
    setEditId(profile.id);
    setEditDraft(
      draftFrom(
        target ? descriptorsForDefinition(target) : [],
        profile.parameters,
      ),
    );
    await loadHistory(profile.id);
  };
  const create = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    if (issues.length) return;
    try {
      const response = await sendJson("/api/scanner-profiles", "POST", {
        name,
        marketId,
        strategyDefinitionId: definitionId,
        parameters: parametersFrom(descriptors, draft),
      });
      const list = await refresh();
      const fallback = list.find((value) => value.name === name);
      const saved =
        savedConfigIdentity(response) ??
        (fallback ? profileConfigIdentity(fallback) : null);
      if (saved) beginSaveAcknowledgement(saved);
      else await loadAutomation();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Unable to create profile",
      );
    }
  };
  const update = async (
    profile: ScannerProfile,
    changes: Record<string, unknown>,
  ) => {
    setError("");
    try {
      const response = await sendJson(
        `/api/scanner-profiles/${profile.id}`,
        "PUT",
        changes,
      );
      const list = await refresh();
      if (editId === profile.id) await loadHistory(profile.id);
      if (!changes.parameters) {
        await loadAutomation();
        return;
      }
      const fallback = list.find((value) => value.id === profile.id);
      const saved =
        savedConfigIdentity(response) ??
        (fallback ? profileConfigIdentity(fallback) : null);
      if (saved) beginSaveAcknowledgement(saved);
      else await loadAutomation();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Unable to update profile",
      );
    }
  };
  const saveParameters = async (event: FormEvent) => {
    event.preventDefault();
    if (!editProfile || editIssues.length) return;
    await update(editProfile, {
      parameters: parametersFrom(editDescriptors, editDraft),
    });
  };
  const duplicate = async (profile: ScannerProfile) => {
    setError("");
    try {
      await sendJson(`/api/scanner-profiles/${profile.id}/duplicate`, "POST", {
        name: `${profile.name} Copy`,
      });
      await refresh();
      await loadAutomation();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Unable to duplicate profile",
      );
    }
  };
  const compare = async () => {
    setError("");
    try {
      setComparison(
        profileComparisonSchema.parse(
          await getJson(
            comparisonRequestUrl(
              selectedIds,
              source,
              startDate,
              endDate,
              marketId,
              cohortKeys,
            ),
          ),
        ),
      );
      setAvailableCohorts([]);
    } catch (reason) {
      if (
        reason instanceof ApiRequestError &&
        reason.code === "COMPARISON_COHORT_REQUIRED" &&
        Array.isArray(reason.payload.availableCohorts)
      ) {
        const values = reason.payload.availableCohorts;
        if (Array.isArray(values)) {
          setAvailableCohorts(values as ComparisonCohort[]);
          setError(reason.message);
          return;
        }
      }
      setError(
        reason instanceof Error ? reason.message : "Unable to compare profiles",
      );
    }
  };
  const acknowledgementWork = saveAcknowledgement
    ? automationStatus?.works.find(
        (work) =>
          work.configId === saveAcknowledgement.configId &&
          work.configVersion === saveAcknowledgement.configVersion,
      )
    : undefined;
  const acknowledgementLabel = saveAcknowledgement
    ? acknowledgementWork
      ? acknowledgementText(acknowledgementWork)
      : saveAcknowledgement.checking
        ? "checking automation status…"
        : "automation status not confirmed yet"
    : "";
  return (
    <>
      <section className="tw:mb-4 tw:grid tw:grid-cols-[minmax(320px,0.7fr)_minmax(600px,1.3fr)] tw:gap-4 tw:below-980:grid-cols-1">
        <form
          className="lab-form tw:overflow-hidden tw:rounded-panel tw:border tw:border-line tw:bg-surface"
          onSubmit={(event) => void create(event)}
        >
          <PanelHeader
            title="Create profile"
            description="Only the parameters this strategy declares · immutable configuration versions."
            actions={<PanelMeta>SHARED UNIVERSE</PanelMeta>}
          />
          <div className="lab-fields tw:grid tw:gap-[14px] tw:p-5">
            <label className={LABEL_CLASSES}>
              Name
              <input
                className={CONTROL_CLASSES}
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label className={LABEL_CLASSES}>
              Strategy
              <select
                className={CONTROL_CLASSES}
                required
                value={definitionId}
                onChange={(e) => setDefinitionId(e.target.value)}
              >
                {definitions
                  .filter((v) => v.enabled)
                  .map((v) => (
                    <option value={v.id} key={v.id}>
                      {v.name} · v{v.version}
                    </option>
                  ))}
              </select>
            </label>
            <label className={LABEL_CLASSES}>
              Market
              <select
                className={CONTROL_CLASSES}
                required
                value={marketId}
                onChange={(event) =>
                  setMarketId(event.target.value as "CA_TSX" | "US_EQUITIES")
                }
              >
                <option value="CA_TSX">TSX (CAD)</option>
                <option value="US_EQUITIES">US equities (USD)</option>
              </select>
            </label>
            {definition && (
              <p className="tw:m-0 tw:font-mono tw:text-[0.66rem] tw:font-normal tw:leading-[1.5] tw:text-ink-600">
                {definition.description}
              </p>
            )}
            <ParameterFields
              descriptors={descriptors}
              draft={draft}
              issues={issues}
              onChange={(key, value) =>
                setDraft((current) => ({ ...current, [key]: value }))
              }
            />
            <button
              className={classes("run-backtest", RUN_BUTTON_CLASSES)}
              disabled={issues.length > 0}
            >
              CREATE PROFILE
            </button>
          </div>
        </form>
        <Panel as="section" className="profile-list">
          <PanelHeader
            title="Scanner profiles"
            description="Qualification is explicit; a high in-sample score is never validation."
            actions={
              <PanelMeta>
                {profiles.filter((v) => v.enabled).length} ENABLED
              </PanelMeta>
            }
          />
          {saveAcknowledgement && (
            <div
              className="profile-save-ack tw:mx-[18px] tw:mt-0 tw:mb-2 tw:flex tw:flex-wrap tw:items-center tw:gap-[10px] tw:rounded-[8px] tw:border tw:border-line-accent-mid tw:bg-surface-raised tw:px-3 tw:py-[9px] tw:font-mono tw:text-[0.68rem] tw:font-normal tw:text-ink-250"
              role="status"
            >
              <span className="tw:text-accent-tint">
                Saved {saveAcknowledgement.configVersion} ·{" "}
                {acknowledgementLabel}
              </span>
              {onOpenBacktests && (
                <button
                  type="button"
                  className={PROFILE_LINK_CLASSES}
                  onClick={onOpenBacktests}
                >
                  View in Backtests
                </button>
              )}
            </div>
          )}
          {automationError && (
            <p className="automation-soft-error tw:mx-[18px] tw:mt-0 tw:mb-2 tw:font-mono tw:text-[0.64rem] tw:font-normal tw:leading-[1.5] tw:text-warn-soft">
              Automation status unavailable · {automationError} · showing the
              last loaded state.
            </p>
          )}
          {profiles.map((profile) => {
            const work = automationStatus?.works.find(
              (value) =>
                value.configId === profile.configId &&
                value.configVersion === profile.configVersion,
            );
            const chip = work ? automationChip(work, now) : null;
            return (
              <article
                className={classes(
                  "profile-row",
                  PROFILE_ROW_CLASSES,
                  editId === profile.id && "tw:bg-surface",
                )}
                key={profile.id}
              >
                <input
                  type="checkbox"
                  checked={selectedIds.includes(profile.id)}
                  onChange={() =>
                    setSelectedIds((ids) =>
                      ids.includes(profile.id)
                        ? ids.filter((id) => id !== profile.id)
                        : ids.length < 10
                          ? [...ids, profile.id]
                          : ids,
                    )
                  }
                  aria-label={`Compare ${profile.name}`}
                />
                <div className="tw:grid tw:gap-1">
                  <strong>
                    <span>{profile.name}</span>{" "}
                    <i
                      className={classes(
                        QUALIFICATION_BADGE_BASE,
                        (profile.qualification ?? "EXPLORATORY").toLowerCase(),
                        QUALIFICATION_BADGE_TONES[
                          (profile.qualification ?? "EXPLORATORY").toLowerCase()
                        ] ?? QUALIFICATION_BADGE_TONES.exploratory,
                      )}
                      title={profile.qualificationReason}
                    >
                      {(profile.qualification ?? "EXPLORATORY").replaceAll(
                        "_",
                        " ",
                      )}
                    </i>
                  </strong>
                  <small className="tw:text-[0.62rem] tw:text-ink-700">
                    {displayStrategy(profile.strategyKey)} · {profile.marketId}{" "}
                    · {profile.configVersion}
                    {profile.qualificationEvidence
                      ? ` · evidence ${profile.qualificationEvidence.id.slice(0, 8)} / run ${profile.qualificationEvidence.backtestRunId.slice(0, 8)}`
                      : " · no exact evidence link"}
                  </small>
                  <div className="profile-automation-line tw:flex tw:flex-wrap tw:items-center tw:gap-2">
                    {chip ? (
                      <Tip label={chip.detail}>
                        <span
                          className={classes(
                            "profile-automation-chip",
                            CHIP_BASE,
                            CHIP_TONE[chip.tone] ?? CHIP_TONE.default,
                          )}
                        >
                          {chip.label}
                        </span>
                      </Tip>
                    ) : (
                      <Tip
                        label={`No qualification replay is recorded for this configuration in the ${
                          statusMarketId === "US_EQUITIES" ? "US" : "CA"
                        } automation status. Saving parameters queues one.`}
                      >
                        <span
                          className={classes(
                            "profile-automation-chip",
                            CHIP_BASE,
                            CHIP_TONE.none,
                          )}
                        >
                          No automation record yet
                        </span>
                      </Tip>
                    )}
                    {onOpenBacktests && (
                      <button
                        type="button"
                        className={PROFILE_LINK_CLASSES}
                        onClick={onOpenBacktests}
                      >
                        View in Backtests
                      </button>
                    )}
                  </div>
                </div>
                <input
                  className="order-input tw:w-[54px] tw:rounded-[6px] tw:border tw:border-line-input tw:bg-bg tw:p-[7px] tw:text-ink-100"
                  type="number"
                  min="0"
                  value={profile.displayOrder}
                  onChange={(e) =>
                    void update(profile, {
                      displayOrder: Number(e.target.value),
                    })
                  }
                />
                <button
                  className={LAB_BUTTON_CLASSES}
                  onClick={() => void openEditor(profile)}
                >
                  EDIT
                </button>
                <button
                  className={LAB_BUTTON_CLASSES}
                  onClick={() => void duplicate(profile)}
                >
                  DUPLICATE
                </button>
                <button
                  className={
                    profile.enabled
                      ? LAB_BUTTON_ENABLED_CLASSES
                      : LAB_BUTTON_CLASSES
                  }
                  onClick={() =>
                    void update(profile, { enabled: !profile.enabled })
                  }
                >
                  {profile.enabled ? "ENABLED" : "DISABLED"}
                </button>
              </article>
            );
          })}
        </Panel>
      </section>
      {error && <p className="error-banner">{error}</p>}
      {editProfile && (
        <section className="tw:mb-4 tw:grid tw:grid-cols-[minmax(320px,0.7fr)_minmax(600px,1.3fr)] tw:gap-4 tw:below-980:grid-cols-1">
          <form
            className="lab-form tw:overflow-hidden tw:rounded-panel tw:border tw:border-line tw:bg-surface"
            onSubmit={(event) => void saveParameters(event)}
          >
            <PanelHeader
              title={`Edit ${editProfile.name}`}
              description={`${displayStrategy(editProfile.strategyKey)} · saving publishes a new immutable configuration version.`}
              actions={<PanelMeta>{editProfile.configVersion}</PanelMeta>}
            />
            <div className="lab-fields tw:grid tw:gap-[14px] tw:p-5">
              <ParameterFields
                descriptors={editDescriptors}
                draft={editDraft}
                issues={editIssues}
                onChange={(key, value) =>
                  setEditDraft((current) => ({ ...current, [key]: value }))
                }
              />
              <button
                className={classes("run-backtest", RUN_BUTTON_CLASSES)}
                disabled={editIssues.length > 0}
              >
                SAVE NEW VERSION
              </button>
            </div>
          </form>
          <section className="config-history tw:max-h-[640px] tw:overflow-y-auto tw:rounded-panel tw:border tw:border-line tw:bg-surface">
            <PanelHeader
              title="Configuration history"
              description="Every saved version with the exact parameter changes it introduced."
              actions={
                <PanelMeta>{history?.versions.length ?? 0} VERSIONS</PanelMeta>
              }
            />
            {[...(history?.versions ?? [])].reverse().map((version) => (
              <article
                className={classes(
                  "config-version tw:grid tw:gap-[6px] tw:border-b tw:border-line-subtle tw:px-[18px] tw:py-[13px]",
                  version.current && "current tw:border-l-2 tw:border-l-accent",
                )}
                key={version.configId}
              >
                <div>
                  <strong>{version.configVersion}</strong>
                  <small className="tw:text-[0.62rem] tw:text-ink-700">
                    {new Date(version.createdAt).toLocaleString()}
                    {version.current ? " · CURRENT" : ""}
                  </small>
                </div>
                {version.changes.length ? (
                  <ul className="tw:m-0 tw:pl-[18px] tw:font-mono tw:text-[0.68rem] tw:font-normal tw:leading-[1.7] tw:text-ink-250">
                    {version.changes.map((change) => (
                      <li key={change.key}>
                        {change.label}:{" "}
                        <b className="tw:text-accent">
                          {change.previous}
                          {change.unit ?? ""}
                        </b>{" "}
                        →{" "}
                        <b className="tw:text-accent">
                          {change.next}
                          {change.unit ?? ""}
                        </b>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <small
                    className={classes(
                      "empty compact",
                      EMPTY_COMPACT_CLASSES,
                      "tw:text-[0.62rem]",
                    )}
                  >
                    Initial version
                  </small>
                )}
              </article>
            ))}
            {!history?.versions.length && (
              <div className={classes("empty compact", EMPTY_COMPACT_CLASSES)}>
                No configuration history yet.
              </div>
            )}
          </section>
        </section>
      )}
      <Panel as="section" className="lab-comparison tw:mb-4">
        <PanelHeader
          title={
            comparison ? comparisonHeading(comparison) : "Profile comparison"
          }
          description="Compare selected profiles using retained evidence. Scope and missingness are reported with the result."
          align="center"
          actions={
            <div className="compare-controls tw:flex tw:items-end tw:gap-2">
              <select
                className={CONTROL_CLASSES}
                value={source}
                onChange={(e) => setSource(e.target.value as typeof source)}
              >
                <option>LIVE</option>
                <option value="PAPER">PAPER BOT</option>
                <option>BACKTEST</option>
              </select>
              <label className="tw:grid tw:gap-1 tw:font-mono tw:text-[0.56rem] tw:font-bold tw:tracking-[0.06em] tw:text-ink-700">
                FROM
                <input
                  className="tw:rounded-input tw:border tw:border-line-input tw:bg-bg tw:px-2 tw:py-[9px] tw:font-mono tw:text-[0.68rem] tw:font-normal tw:text-ink-100"
                  type="date"
                  value={startDate}
                  onChange={(event) => setStartDate(event.target.value)}
                />
              </label>
              <label className="tw:grid tw:gap-1 tw:font-mono tw:text-[0.56rem] tw:font-bold tw:tracking-[0.06em] tw:text-ink-700">
                TO
                <input
                  className="tw:rounded-input tw:border tw:border-line-input tw:bg-bg tw:px-2 tw:py-[9px] tw:font-mono tw:text-[0.68rem] tw:font-normal tw:text-ink-100"
                  type="date"
                  value={endDate}
                  onChange={(event) => setEndDate(event.target.value)}
                />
              </label>
              <button
                className={LAB_BUTTON_CLASSES}
                disabled={selectedIds.length < 2}
                onClick={() => void compare()}
              >
                COMPARE · {selectedIds.length}
              </button>
            </div>
          }
        />
        {availableCohorts.length > 0 && (
          <div
            className={classes(
              SCOPE_STATUS_CLASSES,
              "tw:border tw:border-accent",
            )}
          >
            <strong className={SCOPE_STATUS_STRONG_CLASSES}>
              Choose one evidence cohort per affected profile.
            </strong>
            <p>
              A profile spans incompatible execution evidence. The server will
              not pool those cohorts automatically.
            </p>
            {selectedIds.map((profileId) => {
              const choices = availableCohorts.filter(
                (value) => value.profileId === profileId,
              );
              if (choices.length < 2) return null;
              return (
                <label
                  className="tw:grid tw:gap-1 tw:text-ink-100"
                  key={profileId}
                >
                  {profiles.find((value) => value.id === profileId)?.name ??
                    profileId}
                  <select
                    className={classes(CONTROL_CLASSES, "tw:max-w-[420px]")}
                    value={cohortKeys[profileId] ?? ""}
                    onChange={(event) =>
                      setCohortKeys((current) => ({
                        ...current,
                        [profileId]: event.target.value,
                      }))
                    }
                  >
                    <option value="">Select cohort</option>
                    {choices.map((value) => (
                      <option value={value.cohortKey} key={value.cohortKey}>
                        {value.executionModelVersion ?? "unknown execution"} ·{" "}
                        {value.outcomeCount} outcomes
                      </option>
                    ))}
                  </select>
                </label>
              );
            })}
          </div>
        )}
        {comparison ? (
          <>
            <div
              className={classes(
                SCOPE_STATUS_CLASSES,
                "tw:border tw:border-line-bar",
              )}
            >
              <strong className={SCOPE_STATUS_STRONG_CLASSES}>
                {comparison.status}
              </strong>
              <span>
                {comparison.marketId === "US_EQUITIES" ? "USD" : "CAD"} ·{" "}
                {comparison.startDate} to {comparison.endDate} ·{" "}
                {comparison.marketId === "US_EQUITIES"
                  ? "America/New_York"
                  : "America/Toronto"}{" "}
                · closed-outcome drawdown only; not a funded-account equity
                curve.
              </span>
              {comparison.differences.length > 0 && (
                <ul className="tw:m-0 tw:pl-[18px]">
                  {comparison.differences.map((difference) => (
                    <li key={difference}>{difference}</li>
                  ))}
                </ul>
              )}
            </div>
            <div className="comparison-table tw:overflow-x-auto">
              <div
                className={classes(
                  "comparison-row comparison-header",
                  COMPARE_ROW_BASE,
                  "tw:font-mono tw:text-[0.6rem] tw:font-bold tw:tracking-[0.06em] tw:text-ink-700",
                )}
              >
                <span>PROFILE</span>
                <span>SETUPS</span>
                <span>TRADES</span>
                <span>WIN RATE</span>
                <span>AVG R</span>
                <span>EXPECTANCY</span>
                <span>CLOSED DD</span>
                <span>FALSE +</span>
              </div>
              {comparison.metrics.map((metric) => (
                <div
                  className={classes(
                    "comparison-row",
                    COMPARE_ROW_BASE,
                    "tw:text-[0.72rem]",
                  )}
                  key={metric.profileId}
                >
                  <strong>{metric.profileName}</strong>
                  <span>{metric.setupCount}</span>
                  <span>{metric.trades}</span>
                  <span>{metric.winRate.toFixed(1)}%</span>
                  <span>{metric.averageR.toFixed(2)}R</span>
                  <span>
                    {comparison.marketId === "US_EQUITIES" ? "USD" : "CAD"}{" "}
                    {metric.expectancy.toFixed(2)}
                  </span>
                  <span>
                    {formatClosedOutcomeDrawdown(
                      metric,
                      comparison.marketId === "US_EQUITIES" ? "USD" : "CAD",
                    )}
                  </span>
                  <span>{metric.falsePositiveRate.toFixed(1)}%</span>
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className={classes("empty compact", EMPTY_COMPACT_CLASSES)}>
            Select two or more profiles to compare.
          </div>
        )}
      </Panel>
    </>
  );
}
