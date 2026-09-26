const STORAGE_KEY = "tsx-scanner-nav-order";

/** Applies a saved order to the current section keys. Unknown saved keys are
 * dropped and sections added since the order was saved keep their default
 * place at the end, so a stale or edited value can never hide a section. */
export function normalizeNavOrder<T extends string>(
  saved: unknown,
  defaults: readonly T[],
): T[] {
  if (!Array.isArray(saved)) return [...defaults];
  const known = new Set<string>(defaults);
  const kept = [
    ...new Set(
      saved.filter(
        (value): value is T => typeof value === "string" && known.has(value),
      ),
    ),
  ];
  return [...kept, ...defaults.filter((key) => !kept.includes(key))];
}

/** Returns a copy with the item at `from` moved to index `to`. */
export function moveNavItem<T>(order: readonly T[], from: number, to: number) {
  const next = [...order];
  const clamped = Math.max(0, Math.min(to, next.length - 1));
  if (from < 0 || from >= next.length || from === clamped) return next;
  const [item] = next.splice(from, 1);
  next.splice(clamped, 0, item!);
  return next;
}

export function loadNavOrder<T extends string>(defaults: readonly T[]): T[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return normalizeNavOrder(raw ? JSON.parse(raw) : null, defaults);
  } catch {
    return [...defaults];
  }
}

/** Saves the order, or clears it when it matches the default. */
export function saveNavOrder<T extends string>(
  order: readonly T[],
  defaults: readonly T[],
) {
  try {
    if (order.every((key, index) => key === defaults[index]))
      localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(order));
  } catch {
    // Storage can be blocked; the order still applies for this session.
  }
}
