import { type ScannerAlert } from "@tsx-scanner/contracts";
import { classes } from "../lib/classes.js";

/* Complete class strings per alert tone so border and background
 * declarations never conflict. */
const TOAST_TONE_CLASSES: Record<"ready" | "invalidation", string> = {
  ready: "tw:border-line-accent-strong tw:border-l-accent tw:bg-surface-raised",
  invalidation:
    "tw:border-line-danger-strong tw:border-l-danger tw:bg-surface-danger",
};

export function ToastStack({
  alerts,
  dismiss,
}: {
  alerts: ScannerAlert[];
  dismiss: (alertId: string) => void;
}) {
  return (
    <div
      className="tw:fixed tw:z-10 tw:top-5 tw:right-5 tw:grid tw:w-[min(390px,calc(100vw_-_40px))] tw:gap-[10px]"
      aria-live="assertive"
    >
      {alerts.map((alert) => (
        <article
          key={alert.alertId}
          className={classes(
            "tw:flex tw:justify-between tw:gap-[15px] tw:rounded-panel tw:border tw:border-l-4 tw:p-[17px] tw:shadow-[0_16px_44px_rgba(0,0,0,0.4)]",
            alert.type === "INVALIDATION"
              ? TOAST_TONE_CLASSES.invalidation
              : TOAST_TONE_CLASSES.ready,
          )}
        >
          <div>
            <strong className="tw:text-[0.9rem]">{alert.title}</strong>
            <p className="tw:mt-[5px] tw:mr-0 tw:mb-0 tw:ml-0 tw:text-[0.76rem] tw:text-ink-450">
              {alert.message}
            </p>
          </div>
          <button
            type="button"
            className="tw:cursor-pointer tw:self-start tw:border-0 tw:bg-transparent tw:p-0 tw:text-[1.3rem] tw:text-ink-550"
            aria-label={`Dismiss ${alert.title}`}
            onClick={() => dismiss(alert.alertId)}
          >
            ×
          </button>
        </article>
      ))}
    </div>
  );
}
