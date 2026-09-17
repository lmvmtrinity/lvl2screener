import { contentHash } from "./research-coverage.js";

/** Hash the exact materialized replay object used by verification and study
 * execution. The date is part of the identity even when a session is empty. */
export function hashResearchSession(date: string, session: unknown): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
    throw new Error("INVALID_RESEARCH_SESSION_DATE");
  return contentHash({ date, payload: session });
}
