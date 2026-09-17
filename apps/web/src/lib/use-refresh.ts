import { useEffect, useRef } from "react";

/** Re-runs `reload` when the tab becomes visible or the window regains focus,
 * throttled so rapid focus changes cannot cause overlapping fetch storms.
 * Views keep their existing AbortController/request-generation patterns; this
 * only decides when to trigger the same reload they already expose. */
export function useRefreshOnFocus(
  reload: () => void,
  minimumIntervalMs = 5_000,
): void {
  const lastRun = useRef(0);
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  useEffect(() => {
    const trigger = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - lastRun.current < minimumIntervalMs) return;
      lastRun.current = now;
      reloadRef.current();
    };
    window.addEventListener("focus", trigger);
    document.addEventListener("visibilitychange", trigger);
    return () => {
      window.removeEventListener("focus", trigger);
      document.removeEventListener("visibilitychange", trigger);
    };
  }, [minimumIntervalMs]);
}
