import type { ReactNode } from "react";
import { classes } from "../../lib/classes.js";

/** Small bordered status chip used by the navigation and scanner automation
 *  strips. The parent owns typography and layout. */
export function Chip({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={classes(
        "tw:whitespace-nowrap tw:rounded-[5px] tw:border tw:border-line tw:bg-surface tw:px-[7px] tw:py-[3px] tw:text-ink-500",
        className,
      )}
    >
      {children}
    </span>
  );
}
