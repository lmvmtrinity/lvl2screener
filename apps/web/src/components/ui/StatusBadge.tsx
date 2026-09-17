import type { HTMLAttributes } from "react";
import { classes } from "../../lib/classes.js";

export type StatusTone = "ok" | "warn" | "danger" | "neutral" | "muted";
export type StatusSize = "default" | "header";

/* Each tone supplies its own text and border color so no two utility classes
 * in the component ever target the same declaration (CSS order, not JSX order,
 * decides which wins). */
const TONE_CLASSES: Record<StatusTone, string> = {
  ok: "tw:border-line-accent tw:text-accent",
  warn: "tw:border-line-warn tw:text-warn",
  danger: "tw:border-line-danger tw:text-danger-tint-soft",
  neutral: "tw:border-line-accent-dim tw:text-ink-400",
  muted: "tw:border-line-accent-dim tw:text-ink-500",
};

/* `header` matches the typography the legacy `.panel-title > span` rule gave
 * badges placed in a panel header; `default` matches table badges. */
const SIZE_CLASSES: Record<StatusSize, string> = {
  default:
    "tw:text-[0.59rem] tw:font-[750] tw:leading-none tw:tracking-[0.08em]",
  header:
    "tw:shrink-0 tw:basis-auto tw:text-[0.63rem] tw:font-bold tw:leading-[normal] tw:tracking-[0.1em]",
};

const BASE_CLASSES =
  "tw:inline-flex tw:w-max tw:rounded-[5px] tw:border tw:bg-surface-raised tw:px-2 tw:py-[5px] tw:font-mono";

export interface StatusBadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: StatusTone;
  size?: StatusSize;
}

/** Status label with a visual tone. The caller maps domain state to a tone; the
 *  component never infers trading or system meaning from the label. */
export function StatusBadge({
  tone = "neutral",
  size = "default",
  className,
  children,
  ...rest
}: StatusBadgeProps) {
  return (
    <span
      className={classes(
        BASE_CLASSES,
        SIZE_CLASSES[size],
        TONE_CLASSES[tone],
        className,
      )}
      {...rest}
    >
      {children}
    </span>
  );
}
