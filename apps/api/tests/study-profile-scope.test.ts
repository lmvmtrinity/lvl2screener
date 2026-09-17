import { expect, it } from "vitest";
import { studyPlan } from "./study-fixture.js";
import { assertStudyProfileScope } from "../src/backtests/study-profile-scope.js";
it("allows only the frozen named ablation, not unrelated economic changes", () => {
  const plan = studyPlan();
  for (const stage of Object.values(plan.inputs))
    stage.challenger.parameters.retestVolumeContractionEnabled = 1;
  const profiles = [
    {
      id: plan.baselineProfileConfigId,
      marketId: "CA_TSX",
      strategy: "ORB_RETEST",
      parameters: plan.inputs.TRAIN.baseline.parameters,
    },
    {
      id: plan.challengerProfileConfigId,
      marketId: "CA_TSX",
      strategy: "ORB_RETEST",
      parameters: plan.inputs.TRAIN.challenger.parameters,
    },
  ];
  expect(() => assertStudyProfileScope(plan, profiles)).not.toThrow();
  plan.inputs.TEST.challenger.feePerTrade = 10;
  expect(() => assertStudyProfileScope(plan, profiles)).toThrow(
    "STUDY_COMPARISON_SCOPE_MISMATCH",
  );
});
