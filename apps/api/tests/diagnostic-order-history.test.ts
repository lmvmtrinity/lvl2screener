import { describe, expect, it } from "vitest";
import { resolvePreAllocationState } from "../src/paper-bot/diagnostic-order-history.js";

describe("diagnostic order history", () => {
  it("does not treat the sole post-fill revision at a quote time as its predecessor", () => {
    expect(
      resolvePreAllocationState({
        history: [
          {
            revision: 0,
            factAt: "2026-09-10T13:59:59.000Z",
            state: { status: "PENDING" },
          },
          {
            revision: 1,
            factAt: "2026-09-10T14:00:00.000Z",
            state: { status: "FILLED" },
          },
        ],
        quoteAt: "2026-09-10T14:00:00.000Z",
        appliedRevision: null,
      }),
    ).toMatchObject({ completeness: "PARTIAL", state: null });
  });
  it("keeps a same-time winner's proven pre-allocation state", () => {
    expect(
      resolvePreAllocationState({
        history: [
          {
            revision: 1,
            factAt: "2026-09-10T14:00:00.000Z",
            state: { status: "PENDING" },
          },
          {
            revision: 2,
            factAt: "2026-09-10T14:00:00.000Z",
            state: { status: "FILLED" },
          },
        ],
        quoteAt: "2026-09-10T14:00:00.000Z",
        appliedRevision: 2,
      }),
    ).toEqual({
      state: { status: "PENDING" },
      completeness: "EXACT",
      reason: null,
    });
  });

  it("fails closed when equal-time order facts have no durable link", () => {
    expect(
      resolvePreAllocationState({
        history: [
          {
            revision: 1,
            factAt: "2026-09-10T14:00:00.000Z",
            state: { status: "PENDING" },
          },
          {
            revision: 2,
            factAt: "2026-09-10T14:00:00.000Z",
            state: { status: "FILLED" },
          },
        ],
        quoteAt: "2026-09-10T14:00:00.000Z",
        appliedRevision: null,
      }),
    ).toMatchObject({
      state: null,
      completeness: "PARTIAL",
      reason: "UNVERIFIED_EVENT_SEQUENCE",
    });
  });
});
