import {
  autoUpdate,
  flip,
  FloatingFocusManager,
  FloatingPortal,
  offset,
  shift,
  useClick,
  useDismiss,
  useFloating,
  useFocus,
  useHover,
  useInteractions,
  useRole,
  type Placement,
} from "@floating-ui/react";
import {
  cloneElement,
  useEffect,
  useRef,
  type Dispatch,
  type ReactElement,
  type ReactNode,
  type SetStateAction,
  useState,
} from "react";

/** Escape must dismiss any transient overlay. useDismiss delivers escape through the floating
 *  element's React props, which never reach content rendered in a FloatingPortal here, and a
 *  bubble-phase listener never sees the key either — something upstream stops propagation. So
 *  listen on the document in the capture phase, which always runs first. */
function useEscape(open: boolean, setOpen: Dispatch<SetStateAction<boolean>>) {
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", dismiss, true);
    return () => document.removeEventListener("keydown", dismiss, true);
  }, [open, setOpen]);
}

/** Hover/focus explanation bubble. Wraps a single element child and adds no node of its own,
 *  so it can sit inside a grid or flex row without disturbing the layout. */
export function Tip({
  label,
  placement = "bottom",
  children,
}: {
  label: ReactNode;
  placement?: Placement;
  children: ReactElement<Record<string, unknown>>;
}) {
  const [open, setOpen] = useState(false);
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement,
    middleware: [offset(8), flip({ padding: 8 }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });
  const { getReferenceProps, getFloatingProps } = useInteractions([
    useHover(context, { move: false, delay: { open: 140, close: 40 } }),
    useFocus(context),
    useDismiss(context),
    useRole(context, { role: "tooltip" }),
  ]);
  useEscape(open, setOpen);
  return (
    <>
      {cloneElement(
        children,
        getReferenceProps({ ...children.props, ref: refs.setReference }),
      )}
      {open && (
        <FloatingPortal>
          <div
            className="tw:z-40 tw:w-max tw:max-w-[min(300px,calc(100vw_-_24px))] tw:rounded-input tw:border tw:border-line-accent-dim tw:bg-surface tw:px-[11px] tw:py-[9px] tw:text-[0.74rem] tw:leading-[1.45] tw:text-ink-150 tw:shadow-[0_14px_34px_rgba(0,0,0,0.45)] tw:[&_b]:text-accent"
            ref={refs.setFloating}
            style={floatingStyles}
            {...getFloatingProps()}
          >
            {label}
          </div>
        </FloatingPortal>
      )}
    </>
  );
}

/** Click-to-open panel anchored to its trigger button. */
export function Popover({
  trigger,
  label,
  placement = "bottom-end",
  triggerClassName,
  children,
}: {
  trigger: (open: boolean) => ReactNode;
  label: string;
  placement?: Placement;
  /** Replaces the default trigger classes when the trigger has its own layout. */
  triggerClassName?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement,
    middleware: [offset(8), flip({ padding: 8 }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });
  const { getReferenceProps, getFloatingProps } = useInteractions([
    useClick(context),
    useDismiss(context),
    useRole(context, { role: "dialog" }),
  ]);
  useEscape(open, setOpen);
  return (
    <>
      <button
        type="button"
        className={
          triggerClassName ??
          `tw:shrink-0 tw:grow-0 tw:cursor-pointer tw:rounded-input tw:border tw:bg-surface tw:px-3 tw:py-[9px] tw:font-mono tw:text-[0.62rem] tw:font-bold tw:tracking-[0.07em] tw:hover:border-line-accent tw:hover:text-accent ${
            open
              ? "tw:border-line-accent tw:text-accent"
              : "tw:border-line-input tw:text-ink-550"
          }`
        }
        aria-label={label}
        ref={refs.setReference}
        {...getReferenceProps()}
      >
        {trigger(open)}
      </button>
      {open && (
        <FloatingPortal>
          <FloatingFocusManager context={context} modal={false}>
            <div
              className="tw:z-30 tw:rounded-panel tw:border tw:border-line-input tw:bg-surface tw:p-[14px] tw:shadow-[0_20px_50px_rgba(0,0,0,0.5)]"
              ref={refs.setFloating}
              style={floatingStyles}
              aria-label={label}
              {...getFloatingProps()}
            >
              {children}
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      )}
    </>
  );
}

/** Right-side drawer for secondary controls that should not occupy the default
 * page. Escape and the scrim dismiss it; focus moves into the panel while open. */
export function Drawer({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  useEscape(open, () => onClose());
  useEffect(() => {
    if (open) ref.current?.focus();
  }, [open]);
  if (!open) return null;
  return (
    <div
      className="tw:fixed tw:z-50 tw:inset-0 tw:flex tw:justify-end tw:bg-[rgba(0,0,0,0.55)]"
      onClick={onClose}
      data-testid="drawer-scrim"
    >
      <aside
        className="tw:flex tw:h-full tw:w-[min(560px,100vw)] tw:flex-col tw:border-l tw:border-line-input tw:bg-surface tw:shadow-[-20px_0_50px_rgba(0,0,0,0.5)] tw:outline-none"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={ref}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="tw:flex tw:items-center tw:justify-between tw:gap-3 tw:border-b tw:border-line tw:px-[18px] tw:py-4">
          <h3 className="tw:m-0 tw:text-[0.95rem] tw:text-ink-100">{title}</h3>
          <button
            type="button"
            className="tw:cursor-pointer tw:rounded-input tw:border tw:border-line-input tw:bg-surface tw:px-[10px] tw:py-[7px] tw:font-mono tw:text-[0.6rem] tw:font-bold tw:tracking-[0.07em] tw:text-ink-400 tw:hover:border-line-accent tw:hover:text-accent"
            aria-label="Close"
            onClick={onClose}
          >
            CLOSE
          </button>
        </header>
        <div className="tw:flex-1 tw:overflow-y-auto tw:p-[18px]">
          {children}
        </div>
      </aside>
    </div>
  );
}

/** Small inline control for identifiers and hashes. Confirms only a successful
 * write; a denied clipboard leaves the label unchanged. */
export function CopyButton({
  value,
  label = "COPY",
}: {
  value: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        const area = document.createElement("textarea");
        area.value = value;
        document.body.append(area);
        area.select();
        document.execCommand("copy");
        area.remove();
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      // Clipboard access can be denied; leave the control unacknowledged.
    }
  };
  return (
    <button
      type="button"
      className="tw:cursor-pointer tw:rounded-[5px] tw:border tw:border-line-input tw:bg-surface tw:px-[7px] tw:py-[3px] tw:font-mono tw:text-[0.56rem] tw:font-bold tw:tracking-[0.06em] tw:text-ink-250 tw:hover:border-line-accent tw:hover:text-accent"
      aria-label={`${label} ${value}`}
      onClick={() => void copy()}
    >
      {copied ? "COPIED" : label}
    </button>
  );
}
