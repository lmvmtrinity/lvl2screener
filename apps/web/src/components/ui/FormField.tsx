import {
  forwardRef,
  type InputHTMLAttributes,
  type LabelHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react";
import { classes } from "../../lib/classes.js";

const LABEL_CLASSES =
  "tw:flex tw:flex-col tw:gap-[5px] tw:font-mono tw:text-[0.57rem] tw:font-bold tw:tracking-[0.07em] tw:text-ink-700";

const CONTROL_CLASSES =
  "tw:min-h-[34px] tw:w-full tw:rounded-input tw:border tw:border-line-input tw:bg-bg tw:px-2 tw:py-[7px] tw:text-ink-150 tw:outline-none";

export interface FormFieldProps extends LabelHTMLAttributes<HTMLLabelElement> {
  label: ReactNode;
}

/** Label and control pair. Owns presentation only; validation and form state
 *  stay with the caller. Native label props are forwarded so overlay triggers
 *  such as Tip keep their injected focus handlers and aria attributes. Forwards
 *  its ref so overlay triggers can anchor to it. */
export const FormField = forwardRef<HTMLLabelElement, FormFieldProps>(
  function FormField({ label, children, className, ...rest }, ref) {
    return (
      <label ref={ref} className={classes(LABEL_CLASSES, className)} {...rest}>
        {label}
        {children}
      </label>
    );
  },
);

export const FieldSelect = forwardRef<
  HTMLSelectElement,
  SelectHTMLAttributes<HTMLSelectElement>
>(function FieldSelect({ className, children, ...rest }, ref) {
  return (
    <select ref={ref} className={classes(CONTROL_CLASSES, className)} {...rest}>
      {children}
    </select>
  );
});

export const FieldInput = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement>
>(function FieldInput({ className, ...rest }, ref) {
  return (
    <input
      ref={ref}
      className={classes(CONTROL_CLASSES, className)}
      {...rest}
    />
  );
});
