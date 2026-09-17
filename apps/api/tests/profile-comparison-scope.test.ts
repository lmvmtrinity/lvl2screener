import { describe, expect, it } from "vitest";
import {
  assessComparisonScopes,
  type ComparisonScope,
} from "../src/profiles/comparison-scope.js";

const scope: ComparisonScope = {
  profileId: "10000000-0000-4000-8000-000000000001",
  marketId: "CA_TSX",
  windowHash: "window",
  universeHash: "universe",
  featureVersion: "features",
  executionModelVersion: "execution",
  executionAssumptionsHash: "costs",
  inputHash: "inputs",
  coverageReportHash: "coverage",
  coverageComplete: true,
};

describe("profile comparison scope assessment", () => {
  it("controls profiles with complete matching evidence", () => {
    expect(
      assessComparisonScopes([
        scope,
        { ...scope, profileId: "10000000-0000-4000-8000-000000000002" },
      ]),
    ).toEqual({ status: "CONTROLLED", controlled: true, differences: [] });
  });

  it("does not treat equal missing evidence as comparable proof", () => {
    const missing = {
      ...scope,
      coverageReportHash: null,
      inputHash: null,
      coverageComplete: false,
    };
    expect(
      assessComparisonScopes([
        missing,
        { ...missing, profileId: "10000000-0000-4000-8000-000000000002" },
      ]),
    ).toEqual({
      status: "UNVERIFIED",
      controlled: false,
      differences: [
        "unverified inputHash",
        "unverified coverageReportHash",
        "coverage incomplete or unverified",
      ],
    });
  });

  it("reports known execution differences as uncontrolled", () => {
    expect(
      assessComparisonScopes([
        scope,
        {
          ...scope,
          profileId: "10000000-0000-4000-8000-000000000002",
          executionAssumptionsHash: "other-costs",
        },
      ]).status,
    ).toBe("UNCONTROLLED");
  });

  it("keeps missing and known differences visible together", () => {
    expect(
      assessComparisonScopes([
        {
          ...scope,
          inputHash: null,
          coverageReportHash: null,
          coverageComplete: false,
        },
        {
          ...scope,
          profileId: "10000000-0000-4000-8000-000000000002",
          executionModelVersion: "other-execution",
          inputHash: null,
          coverageReportHash: null,
          coverageComplete: false,
        },
      ]),
    ).toEqual({
      status: "UNCONTROLLED",
      controlled: false,
      differences: [
        "different executionModelVersion",
        "unverified inputHash",
        "unverified coverageReportHash",
        "coverage incomplete or unverified",
      ],
    });
  });
});
