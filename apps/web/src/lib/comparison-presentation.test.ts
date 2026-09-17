import { describe, expect, it } from "vitest";
import {
  comparisonHeading,
  formatClosedOutcomeDrawdown,
} from "./comparison-presentation";

describe("profile comparison presentation", () => {
  it("uses honest headings for each evidence status", () => {
    expect(comparisonHeading({ status: "CONTROLLED" })).toBe(
      "Controlled profile comparison",
    );
    expect(comparisonHeading({ status: "UNCONTROLLED" })).toBe(
      "Profiles differ in research scope",
    );
    expect(comparisonHeading({ status: "UNVERIFIED" })).toBe(
      "Comparison evidence incomplete",
    );
  });

  it("does not turn unavailable chronology into a zero drawdown", () => {
    expect(
      formatClosedOutcomeDrawdown(
        {
          maximumDrawdown: null,
          drawdownStatus: "UNAVAILABLE",
          drawdownBasis: "REALIZED_CLOSED_OUTCOMES",
        },
        "CAD",
      ),
    ).toBe("—");
    expect(
      formatClosedOutcomeDrawdown(
        {
          maximumDrawdown: null,
          drawdownStatus: "NO_CLOSED_OUTCOMES",
          drawdownBasis: "REALIZED_CLOSED_OUTCOMES",
        },
        "USD",
      ),
    ).toBe("No outcomes");
    expect(
      formatClosedOutcomeDrawdown(
        {
          maximumDrawdown: 12.5,
          drawdownStatus: "AVAILABLE",
          drawdownBasis: "REALIZED_CLOSED_OUTCOMES",
        },
        "USD",
      ),
    ).toBe("USD 12.50");
  });
});
