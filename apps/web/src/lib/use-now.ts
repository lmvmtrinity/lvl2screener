import { useEffect, useState } from "react";

/** Re-renders on an interval so relative ages ("12s ago") stay honest without
 * fetching anything. Every consumer that shows freshness uses this so the
 * timestamps freeze only when the tab is hidden. */
export function useNow(intervalMs = 1_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}
