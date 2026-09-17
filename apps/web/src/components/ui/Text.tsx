import type { ReactNode } from "react";
import { classes } from "../../lib/classes.js";

export type TextVariant = "body" | "note" | "danger";

const VARIANT_CLASSES: Record<TextVariant, string> = {
  body: "tw:m-0 tw:text-[0.84rem] tw:leading-[1.55] tw:text-ink-200",
  note: "tw:m-0 tw:text-[0.76rem] tw:leading-[1.5] tw:text-ink-450",
  danger: "tw:m-0 tw:text-[0.8rem] tw:leading-[1.5] tw:text-danger-tint-soft",
};

/** Paragraph copy with the panel body's text variants. */
export function Text({
  variant = "body",
  className,
  children,
}: {
  variant?: TextVariant;
  className?: string;
  children: ReactNode;
}) {
  return (
    <p className={classes(VARIANT_CLASSES[variant], className)}>{children}</p>
  );
}
