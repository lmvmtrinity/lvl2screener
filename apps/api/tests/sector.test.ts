import { describe, expect, it } from "vitest";
import { normalizeSectorKey } from "../src/questrade/sector.js";

describe("normalizeSectorKey", () => {
  it.each([
    ["Basic Materials", "BASIC_MATERIALS"],
    ["BasicMaterials", "BASIC_MATERIALS"],
    [" financial-services ", "FINANCIAL_SERVICES"],
  ])("maps %s to %s", (input, expected) => {
    expect(normalizeSectorKey(input)).toBe(expected);
  });

  it("preserves a missing sector", () => {
    expect(normalizeSectorKey(null)).toBeNull();
  });
});
