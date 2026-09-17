import type { HTMLAttributes, ReactNode } from "react";
import { classes } from "../../lib/classes.js";

export type PanelTone = "plain" | "warn" | "attention";

const PANEL_TONE_CLASSES: Record<PanelTone, string> = {
  plain: "tw:border-line tw:bg-surface",
  warn: "tw:border-line-warn tw:bg-surface",
  attention: "tw:border-line-danger-strong tw:bg-surface-danger",
};

export interface PanelProps extends HTMLAttributes<HTMLElement> {
  as?: "section" | "article" | "div";
  tone?: PanelTone;
}

/** Shared card surface: border, radius, background and clipping. Callers own
 *  the body layout and any semantic element choice (`section`/`article`/`div`). */
export function Panel({
  as: Tag = "section",
  tone = "plain",
  className,
  children,
  ...rest
}: PanelProps) {
  return (
    <Tag
      className={classes(
        "tw:overflow-hidden tw:rounded-panel tw:border",
        PANEL_TONE_CLASSES[tone],
        className,
      )}
      {...rest}
    >
      {children}
    </Tag>
  );
}

export type PanelHeaderEmphasis = "default" | "headline" | "muted" | "compact";
export type PanelHeaderDivider = "default" | "danger";

const HEADER_EMPHASIS_CLASSES: Record<
  PanelHeaderEmphasis,
  { title: string; description: string }
> = {
  default: {
    title: "tw:text-[1rem] tw:tracking-[-0.01em]",
    description: "",
  },
  headline: {
    title: "tw:text-[1.18rem] tw:leading-[1.3] tw:tracking-[-0.01em]",
    description: "tw:max-w-[72ch] tw:text-[0.84rem] tw:text-ink-300",
  },
  /* Table headings: the description is a caption, not body copy. */
  muted: {
    title: "tw:text-[1rem] tw:tracking-[-0.01em]",
    description: "tw:m-0 tw:text-ink-550",
  },
  /* Dense panel subtitles, e.g. the alert history description. */
  compact: {
    title: "tw:text-[1rem] tw:tracking-[-0.01em]",
    description: "tw:mt-1 tw:mb-0 tw:text-[0.75rem] tw:text-ink-700",
  },
};

const HEADER_DIVIDER_CLASSES: Record<PanelHeaderDivider, string> = {
  default: "tw:border-line",
  danger: "tw:border-line-danger",
};

export interface PanelHeaderProps {
  level?: 2 | 3 | 4;
  title: ReactNode;
  titleRole?: string;
  description?: ReactNode;
  descriptionClassName?: string;
  actions?: ReactNode;
  align?: "center" | "start";
  emphasis?: PanelHeaderEmphasis;
  divider?: PanelHeaderDivider;
  className?: string;
}

/** Panel header with a caller-selected heading level, optional description and
 *  trailing actions. The description keeps the user-agent paragraph margins the
 *  legacy `.panel-title p` rules relied on unless the caller supplies its own
 *  `descriptionClassName`. */
export function PanelHeader({
  level = 3,
  title,
  titleRole,
  description,
  descriptionClassName,
  actions,
  align = "center",
  emphasis = "default",
  divider = "default",
  className,
}: PanelHeaderProps) {
  const Heading = `h${level}` as "h2" | "h3" | "h4";
  const typography = HEADER_EMPHASIS_CLASSES[emphasis];
  return (
    <div
      className={classes(
        "tw:flex tw:justify-between tw:gap-[18px] tw:border-b tw:px-[22px] tw:py-5",
        align === "start" ? "tw:items-start" : "tw:items-center",
        HEADER_DIVIDER_CLASSES[divider],
        className,
      )}
    >
      <div>
        <Heading
          role={titleRole}
          className={classes("tw:m-0 tw:text-ink-100", typography.title)}
        >
          {title}
        </Heading>
        {description ? (
          <p
            className={classes(
              "tw:leading-[1.5]",
              typography.description,
              descriptionClassName,
            )}
          >
            {description}
          </p>
        ) : null}
      </div>
      {actions}
    </div>
  );
}

/** Small uppercase meta label that occupies the header's trailing slot. */
export function PanelMeta({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={classes(
        "tw:shrink-0 tw:basis-auto tw:font-mono tw:text-[0.63rem] tw:font-bold tw:tracking-[0.1em] tw:text-accent",
        className,
      )}
    >
      {children}
    </span>
  );
}
