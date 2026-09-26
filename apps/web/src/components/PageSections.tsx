import { type ReactNode, useEffect, useRef, useState } from "react";
import { classes } from "../lib/classes.js";

/* Shared presentation for the summary pages (Backtests, Learning). */
export const CARD = "tw:rounded-[14px] tw:border tw:border-line tw:bg-surface";
export const LABEL =
  "tw:font-sans tw:text-[0.68rem] tw:font-semibold tw:tracking-[0.09em] tw:uppercase tw:text-ink-400";
export const LINK_BUTTON =
  "tw:cursor-pointer tw:border-0 tw:bg-transparent tw:p-0 tw:font-sans tw:text-[0.78rem] tw:text-accent tw:hover:text-accent-hover";
export const SECONDARY_BUTTON =
  "tw:cursor-pointer tw:rounded-[9px] tw:border tw:border-line tw:bg-surface tw:px-[14px] tw:py-[9px] tw:font-sans tw:text-[0.8rem] tw:font-medium tw:text-ink-100 tw:hover:border-line-accent tw:disabled:cursor-wait tw:disabled:opacity-50";

const BADGE_BASE =
  "tw:inline-block tw:whitespace-nowrap tw:rounded-full tw:border tw:px-[9px] tw:py-[3px] tw:font-sans tw:text-[0.7rem] tw:font-medium";
const BADGE_TONES: Record<string, string> = {
  ok: "tw:border-[rgba(111,207,143,0.4)] tw:bg-[rgba(111,207,143,0.14)] tw:text-gain",
  warn: "tw:border-line-warn tw:bg-surface-warn tw:text-warn-soft",
  bad: "tw:border-line-danger tw:bg-surface-danger tw:text-danger-tint-soft",
  pending: "tw:border-line-accent tw:bg-surface-raised tw:text-accent",
  waiting: "tw:border-line tw:bg-transparent tw:text-ink-300",
};

export function badge(tone: string): string {
  return classes(BADGE_BASE, BADGE_TONES[tone] ?? BADGE_TONES.waiting);
}

export function SectionHead({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="tw:mx-[2px] tw:mb-3 tw:flex tw:flex-wrap tw:items-baseline tw:justify-between tw:gap-x-4 tw:gap-y-1">
      <h2 className="tw:m-0 tw:font-sans tw:text-[0.95rem] tw:font-semibold tw:tracking-normal tw:text-ink-50">
        {title}
      </h2>
      {children && (
        <span className="tw:text-[0.78rem] tw:text-ink-400">{children}</span>
      )}
    </div>
  );
}

export const DOT_TONES: Record<string, string> = {
  ok: "tw:bg-gain tw:shadow-[0_0_0_4px_rgba(111,207,143,0.16)]",
  pending: "tw:bg-accent tw:shadow-[0_0_0_4px_rgba(245,158,11,0.16)]",
  bad: "tw:bg-danger tw:shadow-[0_0_0_4px_rgba(248,113,113,0.16)]",
  waiting: "tw:bg-ink-500",
};

export type StepTone = "done" | "active" | "wait" | "lock" | "bad" | "none";

export interface PipelineStep {
  key: string;
  label: string;
  tone: StepTone;
  detail: string;
}

const RING_TONES: Record<StepTone, string> = {
  done: "tw:border-gain tw:bg-gain tw:text-bg",
  active: "tw:border-accent tw:bg-accent tw:text-on-accent",
  wait: "tw:border-accent tw:bg-surface",
  lock: "tw:border-ink-500 tw:bg-surface tw:text-ink-400",
  bad: "tw:border-danger tw:bg-danger tw:text-bg",
  none: "tw:border-line-input tw:border-dashed tw:bg-surface",
};

const RING_GLYPHS: Record<StepTone, string> = {
  done: "✓",
  active: "•",
  wait: "",
  lock: "🔒",
  bad: "!",
  none: "",
};

export function PipelineStrip({
  steps,
  label = "Strategy pipeline",
}: {
  steps: PipelineStep[];
  label?: string;
}) {
  return (
    <ol
      className="tw:m-0 tw:grid tw:list-none tw:grid-cols-[repeat(6,minmax(0,1fr))] tw:gap-3 tw:border-t tw:border-line tw:px-[22px] tw:pt-4 tw:pb-[18px] tw:below-1000:grid-cols-[repeat(3,minmax(0,1fr))] tw:below-620:grid-cols-[repeat(2,minmax(0,1fr))]"
      aria-label={label}
    >
      {steps.map((step, index) => (
        <li className="tw:relative tw:min-w-0" key={step.key}>
          {index < steps.length - 1 && (
            <span
              className={classes(
                "tw:absolute tw:top-[9px] tw:left-[26px] tw:-right-2 tw:h-[2px] tw:below-1000:hidden",
                step.tone === "done" ? "tw:bg-gain/60" : "tw:bg-line",
              )}
              aria-hidden="true"
            />
          )}
          <div className="tw:relative tw:flex tw:items-center tw:gap-2">
            <span
              className={classes(
                "tw:grid tw:h-[18px] tw:w-[18px] tw:shrink-0 tw:place-items-center tw:rounded-full tw:border-2 tw:text-[0.6rem] tw:font-bold",
                RING_TONES[step.tone],
              )}
              aria-hidden="true"
            >
              {RING_GLYPHS[step.tone]}
            </span>
            <strong className="tw:bg-surface tw:pr-2 tw:text-[0.82rem] tw:font-semibold tw:text-ink-100">
              {step.label}
            </strong>
          </div>
          <p className="tw:m-0 tw:mt-[6px] tw:ml-[26px] tw:text-[0.75rem] tw:leading-[1.4] tw:text-ink-400">
            {step.detail}
          </p>
        </li>
      ))}
    </ol>
  );
}

export function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="tw:border-r tw:border-line-subtle tw:px-[22px] tw:py-[18px] tw:last:border-r-0 tw:below-900:border-b tw:below-900:[&:nth-child(2n)]:border-r-0">
      <dt className={LABEL}>{label}</dt>
      <dd className="tw:m-0 tw:mt-2 tw:text-[1.35rem] tw:font-semibold tw:tracking-[-0.01em] tw:text-ink-50">
        {value}
      </dd>
      <dd className="tw:m-0 tw:mt-1 tw:text-[0.75rem] tw:text-ink-400">
        {hint}
      </dd>
    </div>
  );
}

export function MoreMenu({
  label,
  items,
}: {
  label: string;
  items: { label: string; onSelect: () => void }[];
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  return (
    <div className="tw:relative" ref={ref}>
      <button
        type="button"
        className={SECONDARY_BUTTON}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        •••
      </button>
      {open && (
        <ul
          className="tw:absolute tw:top-[calc(100%+6px)] tw:right-0 tw:z-30 tw:m-0 tw:grid tw:min-w-[230px] tw:list-none tw:gap-[2px] tw:rounded-[10px] tw:border tw:border-line-input tw:bg-surface tw:p-1 tw:shadow-[0_20px_50px_rgba(0,0,0,0.5)]"
          role="menu"
        >
          {items.map((item) => (
            <li role="none" key={item.label}>
              <button
                type="button"
                role="menuitem"
                className="tw:w-full tw:cursor-pointer tw:rounded-[7px] tw:border-0 tw:bg-transparent tw:px-3 tw:py-2 tw:text-left tw:font-sans tw:text-[0.82rem] tw:text-ink-150 tw:hover:bg-surface-raised tw:hover:text-ink-50"
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
              >
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
