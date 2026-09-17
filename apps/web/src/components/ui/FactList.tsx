import type { ReactNode } from "react";

/** Two-column definition list for label/value pairs. Used by the card surfaces
 *  that report counts, timings and coverage. */
export function FactList({ children }: { children: ReactNode }) {
  return (
    <dl className="tw:m-0 tw:grid tw:grid-cols-2 tw:gap-x-[18px] tw:gap-y-[10px]">
      {children}
    </dl>
  );
}

export function Fact({
  label,
  children,
}: {
  label: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="tw:min-w-0">
      <dt className="tw:font-mono tw:text-[0.59rem] tw:font-bold tw:tracking-[0.08em] tw:uppercase tw:text-ink-550">
        {label}
      </dt>
      <dd className="tw:mt-1 tw:mx-0 tw:mb-0 tw:font-mono tw:text-[0.8rem] tw:font-[650] tw:text-ink-100 tw:wrap-anywhere">
        {children}
      </dd>
    </div>
  );
}
