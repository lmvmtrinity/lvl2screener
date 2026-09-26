import { describe, expect, it } from "vitest";
import { regularSessionOpen } from "../src/worker/market-session-pause.js";

const both = ["CA_TSX", "US_EQUITIES"] as const;

describe("research session pause window", () => {
  it("covers the regular session and ten minutes after the close", () => {
    // 2026-09-25 is a Friday; Eastern time is UTC-4.
    expect(regularSessionOpen(both, new Date("2026-09-25T13:29:00Z"))).toBe(
      false,
    );
    expect(regularSessionOpen(both, new Date("2026-09-25T13:30:00Z"))).toBe(
      true,
    );
    expect(regularSessionOpen(both, new Date("2026-09-25T20:09:00Z"))).toBe(
      true,
    );
    expect(regularSessionOpen(both, new Date("2026-09-25T20:10:00Z"))).toBe(
      false,
    );
  });

  it("stays clear on weekends and exchange holidays", () => {
    expect(regularSessionOpen(both, new Date("2026-09-26T15:00:00Z"))).toBe(
      false,
    );
    expect(regularSessionOpen(both, new Date("2026-12-25T15:00:00Z"))).toBe(
      false,
    );
  });

  it("follows each market's early close", () => {
    // US closes at 13:00 ET the day after Thanksgiving; TSX trades a full day.
    const afterUsEarlyClose = new Date("2026-11-27T18:30:00Z");
    expect(regularSessionOpen(["US_EQUITIES"], afterUsEarlyClose)).toBe(false);
    expect(regularSessionOpen(["CA_TSX"], afterUsEarlyClose)).toBe(true);
  });
});
