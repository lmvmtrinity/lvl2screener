import { describe, expect, it } from "vitest";
import { zonedSessionBoundary } from "../src/paper-bot/session-time.js";

describe("zonedSessionBoundary", () => {
  it("uses the Toronto regular close across daylight-saving offsets", () => {
    expect(zonedSessionBoundary("2026-08-25", "16:00", "America/Toronto")).toBe(
      "2026-08-25T20:00:00.000Z",
    );
    expect(zonedSessionBoundary("2026-01-15", "16:00", "America/Toronto")).toBe(
      "2026-01-15T21:00:00.000Z",
    );
  });

  it("rejects malformed local boundaries", () => {
    expect(() =>
      zonedSessionBoundary("2026-08-25", "25:00", "America/Toronto"),
    ).toThrow("Invalid session boundary");
  });
});
