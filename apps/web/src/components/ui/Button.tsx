import { forwardRef, type ButtonHTMLAttributes } from "react";
import { classes } from "../../lib/classes.js";

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "segmented"
  | "tab"
  | "profile"
  | "nav"
  | "control"
  | "link";

/**
 * Complete utility strings per variant. Tailwind detects classes statically in
 * source files, so variants must stay as full literal strings (never build
 * names like `bg-${tone}`), and callers must not try to override a declaration
 * another variant class already sets — CSS order decides that, not JSX order.
 */
const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    "tw:cursor-pointer tw:rounded-[7px] tw:border tw:border-accent tw:bg-accent tw:px-[14px] tw:py-[11px] tw:font-mono tw:text-[0.65rem] tw:font-[750] tw:tracking-[0.08em] tw:text-on-accent tw:disabled:cursor-wait tw:disabled:opacity-45",
  secondary:
    "tw:cursor-pointer tw:rounded-[5px] tw:border tw:border-line tw:bg-transparent tw:px-[10px] tw:py-2 tw:font-mono tw:text-[0.62rem] tw:font-bold tw:tracking-[0.08em] tw:text-ink-550 tw:not-disabled:hover:border-line-accent tw:not-disabled:hover:text-accent",
  segmented:
    "tw:cursor-pointer tw:rounded-[5px] tw:border tw:border-line tw:bg-transparent tw:px-[10px] tw:py-2 tw:font-mono tw:text-[0.62rem] tw:font-bold tw:tracking-[0.08em] tw:text-ink-550 tw:not-disabled:hover:border-line-accent tw:not-disabled:hover:bg-surface-raised tw:not-disabled:hover:text-accent tw:aria-pressed:border-line-accent tw:aria-pressed:bg-surface-raised tw:aria-pressed:text-accent tw:disabled:cursor-not-allowed tw:disabled:opacity-45",
  tab: "tw:cursor-pointer tw:rounded-[7px] tw:border tw:border-transparent tw:bg-transparent tw:px-3 tw:py-2 tw:font-sans tw:text-[0.78rem] tw:font-[650] tw:text-ink-300 tw:hover:text-ink-50 tw:aria-pressed:border-line-accent tw:aria-pressed:bg-surface-raised tw:aria-pressed:text-ink-50",
  /* Scanner profile tabs use role="tab"/aria-selected rather than aria-pressed. */
  profile:
    "tw:shrink-0 tw:grow-0 tw:cursor-pointer tw:rounded-[6px] tw:border-0 tw:bg-transparent tw:px-[13px] tw:py-[9px] tw:font-mono tw:text-[0.63rem] tw:font-bold tw:tracking-[0.06em] tw:text-ink-650 tw:aria-selected:bg-accent tw:aria-selected:text-on-accent",
  nav: "tw:cursor-pointer tw:whitespace-nowrap tw:rounded-[7px] tw:border-0 tw:bg-transparent tw:px-[11px] tw:py-2 tw:font-mono tw:text-[0.62rem] tw:font-bold tw:tracking-[0.075em] tw:text-ink-550 tw:hover:bg-surface-raised tw:hover:text-ink-100 tw:aria-[current=page]:bg-accent tw:aria-[current=page]:text-on-accent tw:below-md:px-[10px]",
  /* Filter/clear controls that sit beside a field. */
  control:
    "tw:min-h-[34px] tw:cursor-pointer tw:rounded-input tw:border tw:border-line-input tw:bg-bg tw:px-[11px] tw:py-[7px] tw:font-mono tw:text-[0.58rem] tw:font-bold tw:text-ink-550",
  /* Text-only navigation, e.g. the candidate detail back link. */
  link: "tw:cursor-pointer tw:border-0 tw:bg-transparent tw:p-0 tw:text-ink-550 tw:hover:text-accent",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

/** Native button with a small presentation API. Defaults to `type="button"`
 *  so it never submits an enclosing form by accident; explicit `type="submit"`
 *  and refs pass through unchanged. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    { variant = "secondary", type = "button", className, children, ...rest },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type={type}
        className={classes(VARIANT_CLASSES[variant], className)}
        {...rest}
      >
        {children}
      </button>
    );
  },
);
