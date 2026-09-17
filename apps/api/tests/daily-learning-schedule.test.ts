import { describe, expect, it } from "vitest";
import { nextLearningCheck } from "../src/statistical-models/daily-learning-schedule.js";

describe("daily post-close learning schedule", () => {
  it.each([
    ["2026-09-08T19:00:00Z", "2026-09-08T21:00:00.000Z"],
    ["2026-09-08T21:00:00Z", "2026-09-09T21:00:00.000Z"],
    ["2026-09-08T23:30:00Z", "2026-09-09T21:00:00.000Z"],
    ["2026-03-07T22:00:00Z", "2026-03-08T21:00:00.000Z"],
    ["2026-10-31T21:00:00Z", "2026-11-01T22:00:00.000Z"],
  ])("schedules from %s at %s", (now, expected) => {
    expect(nextLearningCheck(new Date(now)).toISOString()).toBe(expected);
  });
});
