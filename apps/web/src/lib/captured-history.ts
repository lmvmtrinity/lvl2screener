import {
  capturedHistoryAvailabilitySchema,
  type BacktestDataSource,
  type CapturedHistoryAvailability,
  type CapturedHistoryLimitation,
  type MarketId,
} from "@tsx-scanner/contracts";
import { useEffect, useMemo, useState } from "react";
import { getJson } from "./api.js";

function limitationBounds(limitation: CapturedHistoryLimitation): string {
  return `${new Date(limitation.startAt).toLocaleString()} through ${new Date(
    limitation.endAt,
  ).toLocaleString()}`;
}

/**
 * Plain-language interior limitation notice. An absent `limitations` field is
 * an old snapshot where the assessment was not recorded, not a clean history;
 * an empty array means the evaluated window found no interior no-quote gap.
 */
function interiorLimitationNotice(
  availability: CapturedHistoryAvailability,
): string | null {
  if (availability.limitations === undefined)
    return "Interior quote-gap limits were not recorded for this availability snapshot.";
  if (availability.limitations.length === 0) return null;
  const first = availability.limitations[0]!;
  const sessions = first.sessionDates.length
    ? ` (${first.sessionDates.join(", ")})`
    : "";
  const extra =
    availability.limitations.length > 1
      ? ` ${availability.limitations.length - 1} further no-quote interval(s) are retained.`
      : "";
  return `Forward quotes are missing ${limitationBounds(first)}${sessions} although completed candles exist there. Backfilled candles do not replace the missing quotes, so replay for those sessions has a known capture limitation.${extra}`;
}

function sourceLabel(source: BacktestDataSource): string {
  return source === "HISTORICAL_ARCHIVE"
    ? "Archived quotes"
    : "Captured quotes";
}

function useCapturedHistoryAvailability(
  startDate: string,
  endDate: string,
  marketId: MarketId,
  source: BacktestDataSource,
) {
  const [availability, setAvailability] =
    useState<CapturedHistoryAvailability>();
  const [error, setError] = useState("");
  useEffect(() => {
    let stopped = false;
    setAvailability(undefined);
    setError("");
    void getJson(
      `/api/captured-history/availability?marketId=${encodeURIComponent(marketId)}${
        source === "CAPTURED_QUOTES" ? "" : `&source=${source}`
      }`,
    )
      .then((payload) => {
        if (!stopped)
          setAvailability(capturedHistoryAvailabilitySchema.parse(payload));
      })
      .catch(() => {
        if (!stopped)
          setError("Captured-history availability could not be loaded.");
      });
    return () => {
      stopped = true;
    };
  }, [marketId, source]);
  return useMemo(() => {
    const earliestDate = availability?.replay.earliestDate ?? null;
    const latestDate = availability?.replay.latestDate ?? null;
    if (error)
      return {
        earliestDate,
        latestDate,
        rangeAvailable: false,
        message: error,
      };
    if (!availability)
      return {
        earliestDate,
        latestDate,
        rangeAvailable: false,
        message: "Loading captured-history availability…",
      };
    if (!earliestDate || !latestDate)
      return {
        earliestDate,
        latestDate,
        rangeAvailable: false,
        message:
          source === "HISTORICAL_ARCHIVE"
            ? "The historical archive is empty; run historical-import first."
            : "No captured quote history is available yet.",
      };
    const rangeAvailable = startDate >= earliestDate && endDate <= latestDate;
    const limitation = interiorLimitationNotice(availability);
    return {
      earliestDate,
      latestDate,
      rangeAvailable,
      limitations: availability.limitations,
      message: [
        rangeAvailable
          ? `${sourceLabel(source)} available ${earliestDate} through ${latestDate}.`
          : `Choose a range within ${sourceLabel(source).toLowerCase()}: ${earliestDate} through ${latestDate}.`,
        limitation,
      ]
        .filter(Boolean)
        .join(" "),
    };
  }, [availability, endDate, error, source, startDate]);
}

function capturedHistorySummary(
  availability: CapturedHistoryAvailability | null,
): string | null {
  if (!availability) return null;
  const { earliestDate, latestDate } = availability.replay;
  const bounds =
    earliestDate && latestDate
      ? `${sourceLabel(availability.source)} available at run start: ${earliestDate} through ${latestDate}.`
      : "No quote history was available when this run started.";
  const limitation = interiorLimitationNotice(availability);
  return [bounds, limitation].filter(Boolean).join(" ");
}

export function useCapturedHistoryFormGuard(
  startDate: string,
  endDate: string,
  marketId: MarketId = "CA_TSX",
  active = true,
  source: BacktestDataSource = "CAPTURED_QUOTES",
): void {
  const history = useCapturedHistoryAvailability(
    startDate,
    endDate,
    marketId,
    source,
  );
  useEffect(() => {
    // A deferred form (for example inside a closed drawer) mounts after the
    // availability load; `active` re-runs this once its fields exist.
    if (!active) return;
    const form = document.querySelector<HTMLFormElement>(".backtest-form");
    if (!form) return;
    form.dataset.capturedHistory = history.message;
    for (const input of form.querySelectorAll<HTMLInputElement>(
      'input[type="date"]',
    )) {
      if (history.earliestDate) input.min = history.earliestDate;
      else input.removeAttribute("min");
      if (history.latestDate) input.max = history.latestDate;
      else input.removeAttribute("max");
    }
    const submit = form.querySelector<HTMLButtonElement>(".run-backtest");
    if (submit) {
      submit.disabled = !history.rangeAvailable;
      submit.title = history.rangeAvailable ? "" : history.message;
    }
  }, [active, history]);
}

export function useCapturedHistoryRunSummary(
  availability: CapturedHistoryAvailability | null,
  selector: string,
): void {
  const summary = capturedHistorySummary(availability);
  useEffect(() => {
    const target = document.querySelector<HTMLElement>(selector);
    if (!target) return;
    if (summary) target.dataset.capturedHistory = summary;
    else delete target.dataset.capturedHistory;
  }, [selector, summary]);
}
