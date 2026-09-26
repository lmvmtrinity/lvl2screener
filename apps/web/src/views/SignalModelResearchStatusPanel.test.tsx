import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SignalModelResearchStatusPanel } from "./SignalModelResearchStatusPanel.js";

const { getJsonMock } = vi.hoisted(() => ({ getJsonMock: vi.fn() }));
vi.mock("../lib/api.js", () => ({ getJson: getJsonMock }));

const CA_ID = "11111111-1111-4111-8111-111111111111";
const US_ID = "22222222-2222-4222-8222-222222222222";
const EXPERIMENT_ID = "44444444-4444-4444-8444-444444444444";
const HASH = "a".repeat(64);

function authorization(id: string, marketId: "CA_TSX" | "US_EQUITIES") {
  return {
    id,
    marketId,
    frozenPlanHash: HASH,
    sourceDigest: HASH,
    sourceBindingHash: HASH,
    expiresAt: "2026-10-01T00:00:00.000Z",
    trialBudget: 10,
    mode: "EXECUTE_WHEN_READY",
    grantedAt: "2026-09-22T12:00:00.000Z",
    revokedAt: null,
    dispatchedJobId: null,
  };
}

function detail(id: string, marketId: "CA_TSX" | "US_EQUITIES") {
  const item = authorization(id, marketId);
  return {
    authorization: item,
    readiness: {
      authorizationId: id,
      mode: item.mode,
      status: "WAITING",
      blockers: [`${marketId} source is waiting`],
      lastCheckedAt: null,
      nextAction: `${marketId} next action`,
    },
    report: null,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

afterEach(() => {
  cleanup();
  getJsonMock.mockReset();
});

describe("SignalModelResearchStatusPanel", () => {
  it("discards a late response from the previous market after switching", async () => {
    const canadianList = deferred<{ authorizations: unknown[] }>();
    getJsonMock.mockImplementation((url: string) => {
      if (url.includes("authorizations?marketId=CA_TSX"))
        return canadianList.promise;
      if (url.includes("authorizations?marketId=US_EQUITIES"))
        return Promise.resolve({
          authorizations: [authorization(US_ID, "US_EQUITIES")],
        });
      if (url.endsWith(US_ID))
        return Promise.resolve(detail(US_ID, "US_EQUITIES"));
      if (url.endsWith(CA_ID)) return Promise.resolve(detail(CA_ID, "CA_TSX"));
      throw new Error(`Unexpected request ${url}`);
    });

    const view = render(<SignalModelResearchStatusPanel marketId="CA_TSX" />);
    view.rerender(<SignalModelResearchStatusPanel marketId="US_EQUITIES" />);

    expect(await screen.findByText("US_EQUITIES next action")).toBeTruthy();
    await act(async () => {
      canadianList.resolve({
        authorizations: [authorization(CA_ID, "CA_TSX")],
      });
      await canadianList.promise;
    });

    await waitFor(() => {
      expect(screen.getByText("US_EQUITIES next action")).toBeTruthy();
      expect(screen.queryByText("CA_TSX next action")).toBeNull();
      expect(
        screen.getByLabelText("Signal-model research status").textContent,
      ).toContain("US_EQUITIES");
    });
  });

  it("keeps waiting, insufficient, and failed outcomes distinct with reports", async () => {
    const ids = [CA_ID, US_ID, "33333333-3333-4333-8333-333333333333"];
    const statuses = ["WAITING", "INSUFFICIENT", "FAILED"] as const;
    getJsonMock.mockImplementation((url: string) => {
      if (url.includes("authorizations?marketId=CA_TSX"))
        return Promise.resolve({
          authorizations: ids.map((id) => authorization(id, "CA_TSX")),
        });
      const id = ids.find((candidate) => url.endsWith(candidate));
      if (!id) throw new Error(`Unexpected request ${url}`);
      const index = ids.indexOf(id);
      const item = authorization(id, "CA_TSX");
      return Promise.resolve({
        authorization: item,
        readiness: {
          authorizationId: id,
          mode: item.mode,
          status: statuses[index],
          blockers: [],
          lastCheckedAt: null,
          nextAction: `${statuses[index]} next action`,
        },
        report:
          statuses[index] === "INSUFFICIENT"
            ? {
                experimentId: EXPERIMENT_ID,
                authorizationId: id,
                sourceDigest: HASH,
                planHash: HASH,
                status: "INSUFFICIENT",
                selectedCandidateIdentity: null,
                selectedThreshold: null,
                evaluation: null,
                reasonCodes: ["TOO_FEW_CLOSED_OUTCOMES"],
              }
            : null,
      });
    });

    render(<SignalModelResearchStatusPanel marketId="CA_TSX" />);

    expect(await screen.findByText("WAITING")).toBeTruthy();
    expect(screen.getByText("INSUFFICIENT")).toBeTruthy();
    expect(screen.getByText("FAILED")).toBeTruthy();
    expect(screen.getByText("TOO_FEW_CLOSED_OUTCOMES")).toBeTruthy();
    expect(
      screen
        .getByRole("region", { name: "Signal-model research status" })
        .querySelectorAll("button"),
    ).toHaveLength(0);
  });
});
