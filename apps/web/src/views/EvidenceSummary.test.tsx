import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getJson } from "../lib/api.js";
import { EvidenceSummary } from "./EvidenceSummary.js";

vi.mock("../lib/api.js", () => ({
  getJson: vi.fn(),
}));

const binding = {
  manifestHash: "a".repeat(64),
  coverageReportHash: "b".repeat(64),
  inputHash: "c".repeat(64),
  engineRevision: "d".repeat(40),
  runtimeFingerprint: "e".repeat(64),
  verifiedAt: "2026-09-10T00:00:00.000Z",
} as const;

describe("EvidenceSummary", () => {
  afterEach(cleanup);

  it("keeps legacy null evidence unverified without inventing a report request", () => {
    render(<EvidenceSummary marketId="CA_TSX" binding={null} />);
    expect(screen.getByText("Unverified coverage")).toBeInTheDocument();
    expect(getJson).not.toHaveBeenCalled();
  });

  it("renders retained coverage, reasons and a verified zero-opportunity result", async () => {
    vi.mocked(getJson).mockResolvedValue({
      version: "research-coverage-v1",
      marketId: "CA_TSX",
      manifestHash: binding.manifestHash,
      expectedInputsHash: "f".repeat(64),
      inputHash: binding.inputHash,
      sessionPayloadHashes: { "2026-09-09": "1".repeat(64) },
      verifiedAt: binding.verifiedAt,
      status: "VERIFIED",
      cells: [
        {
          cellId: "member",
          status: "VERIFIED",
          validQuotes: 10,
          validWarmupBars: 20,
          maximumGapMs: 30_000,
          reasons: [],
        },
        {
          cellId: "benchmark",
          status: "INCOMPLETE",
          validQuotes: 0,
          validWarmupBars: 0,
          maximumGapMs: null,
          reasons: ["QUOTE_MISSING"],
        },
      ],
    });
    render(
      <EvidenceSummary marketId="CA_TSX" binding={binding} opportunities={0} />,
    );
    expect(await screen.findByText("Coverage verified")).toBeInTheDocument();
    expect(screen.getByText("0 eligible opportunities")).toBeInTheDocument();
    expect(
      screen.getByText(/1 of 2 required cells covered/),
    ).toBeInTheDocument();
    expect(screen.getByText("QUOTE_MISSING")).toBeInTheDocument();
    await waitFor(() =>
      expect(getJson).toHaveBeenCalledWith(
        `/api/research-evidence/${binding.coverageReportHash}?marketId=CA_TSX`,
        expect.any(AbortSignal),
      ),
    );
  });
});
