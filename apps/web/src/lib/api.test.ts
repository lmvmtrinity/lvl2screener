import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError, getJson } from "./api";

describe("getJson", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("preserves structured comparison errors for callers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: "Select one cohort",
            code: "COMPARISON_COHORT_REQUIRED",
            issues: { availableCohorts: [] },
          }),
          { status: 409 },
        ),
      ),
    );

    await expect(getJson("/api/comparisons")).rejects.toMatchObject({
      name: "ApiRequestError",
      status: 409,
      code: "COMPARISON_COHORT_REQUIRED",
      payload: { issues: { availableCohorts: [] } },
    } satisfies Partial<ApiRequestError>);
  });
});
