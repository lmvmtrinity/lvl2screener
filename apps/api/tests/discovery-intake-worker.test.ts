import { describe, expect, it, vi } from "vitest";
import {
  DiscoveryIntakeWorker,
  type DiscoveryIntakeAction,
  type DiscoveryIntakeRepository,
} from "../src/universe/discovery-intake-repository.js";

const action: DiscoveryIntakeAction = {
  id: "00000000-0000-4000-8000-000000000001",
  marketId: "CA_TSX",
  syncOnly: false,
  symbol: "TEST.TO",
  instrument: {
    id: "00000000-0000-4000-8000-000000000002",
    marketId: "CA_TSX",
    symbolId: 123,
    symbol: "TEST.TO",
    description: "Test",
    securityType: "Common Stock",
    exchange: "TSX",
    currency: "CAD",
    isQuotable: true,
    isTradable: true,
    active: true,
  },
};

function repository(): DiscoveryIntakeRepository {
  return {
    enqueuePass: vi.fn(),
    claimNext: vi.fn(async () => action),
    markSynchronized: vi.fn(async () => undefined),
    markSynchronizationFailed: vi.fn(async () => undefined),
    expireUndelivered: vi.fn(async () => 0),
    applyManualCandidates: vi.fn(),
    setExclusion: vi.fn(),
  } as unknown as DiscoveryIntakeRepository;
}

describe("discovery intake worker", () => {
  it("keeps the production gate closed", async () => {
    const repo = repository();
    const worker = new DiscoveryIntakeWorker({
      repository: repo,
      marketId: "CA_TSX",
      tradingDate: () => "2026-09-09",
      synchronize: vi.fn(),
    });
    await worker.drainOnce();
    expect(repo.claimNext).not.toHaveBeenCalled();
  });

  it("acknowledges only after runtime synchronization", async () => {
    const repo = repository();
    const synchronize = vi.fn(async () => undefined);
    const worker = new DiscoveryIntakeWorker({
      repository: repo,
      marketId: "CA_TSX",
      tradingDate: () => "2026-09-09",
      synchronize,
      enabled: true,
    });
    await worker.drainOnce();
    expect(synchronize).toHaveBeenCalledWith(action);
    expect(repo.markSynchronized).toHaveBeenCalledWith(action.id);
  });

  it("keeps committed membership retryable when runtime synchronization fails", async () => {
    const repo = repository();
    const worker = new DiscoveryIntakeWorker({
      repository: repo,
      marketId: "CA_TSX",
      tradingDate: () => "2026-09-09",
      synchronize: async () => {
        throw new Error("scanner unavailable");
      },
      enabled: true,
    });
    await worker.drainOnce();
    expect(repo.markSynchronized).not.toHaveBeenCalled();
    expect(repo.markSynchronizationFailed).toHaveBeenCalledWith(
      action.id,
      "scanner unavailable",
    );
  });
});
