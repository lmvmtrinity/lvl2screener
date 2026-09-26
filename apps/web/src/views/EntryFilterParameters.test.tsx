import { expect, it } from "vitest";
import {
  defaultStrategyParameters,
  strategyParameterDescriptors,
} from "@tsx-scanner/contracts";
import { draftFrom, parametersFrom } from "./StrategyLabView.js";

it("round trips optional READY time without converting it to a number", () => {
  const descriptors = [strategyParameterDescriptors.latestReadyTime];
  for (const latestReadyTime of [null, "15:00"]) {
    const parameters = { ...defaultStrategyParameters(), latestReadyTime };
    const draft = draftFrom(descriptors, parameters);
    expect(draft.latestReadyTime).toBe(latestReadyTime ?? "");
    expect(parametersFrom(descriptors, draft).latestReadyTime).toBe(
      latestReadyTime,
    );
  }
});
