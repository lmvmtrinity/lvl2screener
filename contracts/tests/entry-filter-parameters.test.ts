import { expect, it } from "vitest";
import {
  defaultStrategyParameters,
  parameterChangeSchema,
  strategyParametersSchema,
  validateStrategyParameters,
} from "../src/index.js";

it("keeps entry filters disabled and accepts an opt-in market clock", () => {
  expect(defaultStrategyParameters()).toMatchObject({
    latestReadyTime: null,
    maxVwapDistanceAtr: 0,
    maxChangeFromOpenAtr: 0,
    minSectorRelativeStrengthPct: 0,
  });
  expect(
    strategyParametersSchema.parse({ latestReadyTime: "15:00" })
      .latestReadyTime,
  ).toBe("15:00");
  for (const value of ["24:00", "15:60", "9:00", "15:00:01"])
    expect(
      strategyParametersSchema.safeParse({ latestReadyTime: value }).success,
    ).toBe(false);
});

it("preserves a time parameter in immutable configuration history", () => {
  expect(
    parameterChangeSchema.parse({
      key: "latestReadyTime",
      label: "Latest READY",
      unit: null,
      previous: null,
      next: "15:00",
    }).next,
  ).toBe("15:00");
});

it("requires declaration for enabled filters but permits disabled legacy defaults", () => {
  const defaults = defaultStrategyParameters();
  expect(validateStrategyParameters({ parameterSchema: {} }, defaults)).toEqual(
    [],
  );
  const enabled = { ...defaults, latestReadyTime: "15:00" };
  expect(validateStrategyParameters({ parameterSchema: {} }, enabled)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ key: "latestReadyTime" }),
    ]),
  );
  expect(
    validateStrategyParameters(
      { parameterSchema: { latestReadyTime: "time" } },
      enabled,
    ),
  ).toEqual([]);
});
