import { describe, expect, it } from "vitest";
import { costPolicyForMarket } from "../src/paper-bot/cost-policy.js";

describe("market paper cost policy", () => {
  it("creates native-currency immutable snapshots", () => {
    expect(costPolicyForMarket("CA_TSX").currency).toBe("CAD");
    expect(costPolicyForMarket("US_EQUITIES").currency).toBe("USD");
  });
});
