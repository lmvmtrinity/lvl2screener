import { expect, it } from "vitest";
import { featureLevelSchema } from "../src/domains/market-data.js";

const level = {
  price: 105,
  type: "SWING_HIGH",
  strength: 0.53,
  tests: 1,
  ageBars: 2,
};

it("keeps legacy provenance unknown and preserves new JSON fields", () => {
  expect(featureLevelSchema.parse(level).provenance ?? null).toBeNull();
  const provenance = {
    levelId: "swing-a",
    originAt: "2026-09-08T14:15:00.000Z",
    availableAt: "2026-09-08T14:25:00.000Z",
  };
  expect(
    featureLevelSchema.parse(
      JSON.parse(JSON.stringify({ ...level, provenance })),
    ).provenance,
  ).toEqual(provenance);
});

it("rejects confirmation before origin", () => {
  expect(
    featureLevelSchema.safeParse({
      ...level,
      provenance: {
        levelId: "swing-a",
        originAt: "2026-09-08T14:25:00.000Z",
        availableAt: "2026-09-08T14:15:00.000Z",
      },
    }).success,
  ).toBe(false);
});
