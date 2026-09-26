import { describe, expect, it, vi } from "vitest";
import {
  parseFundedComparisonArgs,
  enqueueFundedComparison,
  runFundedComparisonCli,
  type FundedComparisonCliDependencies,
} from "../src/funded-comparison.js";
import {
  FundedComparisonRepositoryError,
  type FundedComparisonSpecificationReceipt,
} from "../src/paper-bot/funded-comparison-repository.js";
import type { FundedComparisonSpecificationBuild } from "../src/paper-bot/funded-comparison-repository.js";

const ids = {
  baseline: "11111111-1111-4111-8111-111111111111",
  challenger: "22222222-2222-4222-8222-222222222222",
  spec: "33333333-3333-4333-8333-333333333333",
  job: "44444444-4444-4444-8444-444444444444",
};

function dependencies(
  overrides: Partial<FundedComparisonCliDependencies> = {},
): FundedComparisonCliDependencies {
  return {
    resolvePlan: vi.fn().mockResolvedValue({
      marketId: "CA_TSX",
      currency: "CAD",
      baselineRunId: ids.baseline,
      challengerId: ids.challenger,
      sessionCount: 2,
      opportunityCount: 7,
      sessions: ["2026-08-01", "2026-08-02"],
      opportunities: ["opportunity-1", "opportunity-2"],
      champion: {
        sourceRunId: "55555555-5555-4555-8555-555555555555",
        sourceAccountId: "66666666-6666-4666-8666-666666666666",
        policyDigest: "a".repeat(64),
      },
      challenger: {
        modelId: ids.challenger,
        modelVersion: "model-v1",
        policyDigest: "b".repeat(64),
      },
    }),
    freezeAndEnqueue: vi.fn().mockResolvedValue({
      specificationId: ids.spec,
      jobId: ids.job,
      reused: false,
    }),
    read: {
      list: vi.fn(),
      get: vi.fn(),
    },
    ...overrides,
  };
}

describe("funded comparison CLI", () => {
  it("parses explicit mutation inputs and requires apply for enqueue", () => {
    expect(
      parseFundedComparisonArgs([
        "enqueue",
        `--baseline-run-id=${ids.baseline}`,
        `--challenger-id=${ids.challenger}`,
        "--market=CA_TSX",
        "--evidence-cutoff=2026-09-01T20:00:00.000Z",
        "--max-sessions=20",
      ]),
    ).toMatchObject({
      mode: "enqueue",
      baselineRunId: ids.baseline,
      challengerId: ids.challenger,
      marketId: "CA_TSX",
      apply: false,
      maxSessions: 20,
    });
  });

  it("plan resolves identities and performs no freeze or enqueue write", async () => {
    const deps = dependencies();
    const output = await runFundedComparisonCli(
      [
        "plan",
        `--baseline-run-id=${ids.baseline}`,
        `--challenger-id=${ids.challenger}`,
        "--market=CA_TSX",
        "--evidence-cutoff=2026-09-01T20:00:00.000Z",
        "--max-sessions=20",
      ],
      deps,
    );

    expect(output).toMatchObject({
      mode: "plan",
      marketId: "CA_TSX",
      currency: "CAD",
      sessionCount: 2,
      opportunityCount: 7,
      sessions: ["2026-08-01", "2026-08-02"],
      opportunities: ["opportunity-1", "opportunity-2"],
      champion: { policyDigest: "a".repeat(64) },
      challenger: { modelId: ids.challenger },
    });
    expect(deps.resolvePlan).toHaveBeenCalledTimes(1);
    expect(deps.freezeAndEnqueue).not.toHaveBeenCalled();
  });

  it("enqueue without apply resolves the prospective plan but performs no write", async () => {
    const deps = dependencies();
    const output = await runFundedComparisonCli(
      [
        "enqueue",
        `--baseline-run-id=${ids.baseline}`,
        `--challenger-id=${ids.challenger}`,
        "--market=CA_TSX",
        "--evidence-cutoff=2026-09-01T20:00:00.000Z",
        "--max-sessions=20",
      ],
      deps,
    );

    expect(output).toMatchObject({ mode: "enqueue", apply: false });
    expect(deps.resolvePlan).toHaveBeenCalledTimes(1);
    expect(deps.freezeAndEnqueue).not.toHaveBeenCalled();
  });

  it("enqueue with apply delegates once to the idempotent freeze/enqueue boundary", async () => {
    const deps = dependencies();
    const output = await runFundedComparisonCli(
      [
        "enqueue",
        "--apply",
        `--baseline-run-id=${ids.baseline}`,
        `--challenger-id=${ids.challenger}`,
        "--market=CA_TSX",
        "--evidence-cutoff=2026-09-01T20:00:00.000Z",
        "--max-sessions=20",
      ],
      deps,
    );

    expect(output).toMatchObject({
      mode: "enqueue",
      apply: true,
      specificationId: ids.spec,
      jobId: ids.job,
    });
    expect(deps.freezeAndEnqueue).toHaveBeenCalledTimes(1);
    expect(deps.freezeAndEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        baselineRunId: ids.baseline,
        challengerId: ids.challenger,
        marketId: "CA_TSX",
        maxSessions: 20,
      }),
      expect.objectContaining({
        baselineRunId: ids.baseline,
        challengerId: ids.challenger,
        marketId: "CA_TSX",
      }),
    );
  });

  it("returns the durable specification and job identity on an exact retry", async () => {
    const deps = dependencies({
      freezeAndEnqueue: vi.fn().mockResolvedValue({
        specificationId: ids.spec,
        jobId: ids.job,
        reused: true,
      }),
    });

    const output = await runFundedComparisonCli(
      [
        "enqueue",
        "--apply",
        `--baseline-run-id=${ids.baseline}`,
        `--challenger-id=${ids.challenger}`,
        "--market=CA_TSX",
        "--evidence-cutoff=2026-09-01T20:00:00.000Z",
        "--max-sessions=20",
      ],
      deps,
    );

    expect(output).toMatchObject({
      specificationId: ids.spec,
      jobId: ids.job,
      reused: true,
    });
  });

  it("status reads the immutable availability projection without mutating it", async () => {
    const deps = dependencies();
    const availability = {
      specificationId: ids.spec,
      marketId: "CA_TSX",
      currency: "CAD",
      comparisonSpecDigest: "c".repeat(64),
      status: "READY",
      sessionCount: 20,
      historicalVolumeStatus: "SUFFICIENT_FOR_LATER_G2",
      resultDigest: "d".repeat(64),
      resultAvailable: true,
      failures: [],
      createdAt: "2026-09-01T20:00:00.000Z",
    } as const;
    deps.read.get = vi.fn().mockResolvedValue(availability);

    const output = await runFundedComparisonCli(
      ["status", `--spec-id=${ids.spec}`],
      deps,
    );

    expect(output).toEqual(availability);
    expect(deps.read.get).toHaveBeenCalledWith(ids.spec);
    expect(deps.freezeAndEnqueue).not.toHaveBeenCalled();
  });

  it("surfaces conflicting retries from the freeze/enqueue boundary", async () => {
    const deps = dependencies({
      freezeAndEnqueue: vi
        .fn()
        .mockRejectedValue(new Error("CONFLICTING_RETRY")),
    });

    await expect(
      runFundedComparisonCli(
        [
          "enqueue",
          "--apply",
          `--baseline-run-id=${ids.baseline}`,
          `--challenger-id=${ids.challenger}`,
          "--market=CA_TSX",
          "--evidence-cutoff=2026-09-01T20:00:00.000Z",
          "--max-sessions=20",
        ],
        deps,
      ),
    ).rejects.toThrow("CONFLICTING_RETRY");
  });

  it("reuses a retained freeze timestamp and durable job on exact retry", async () => {
    const repo = new FaithfulComparisonRepositoryFake();
    const jobs = new FaithfulJobRepositoryFake();
    const build = (frozenAt: string): FundedComparisonSpecificationBuild =>
      fakeBuild(frozenAt);

    const first = await enqueueFundedComparison(enqueueInput(), {
      repository: repo,
      jobs,
      build,
    });
    const second = await enqueueFundedComparison(enqueueInput(), {
      repository: repo,
      jobs,
      build,
    });

    expect(first).toMatchObject({
      reused: false,
      specificationId: "spec-1",
      jobId: "job-1",
    });
    expect(second).toMatchObject({
      reused: true,
      specificationId: "spec-1",
      jobId: "job-1",
    });
    expect(repo.saveCalls).toBe(2);
    expect(repo.savedFreezeTimes).toEqual([
      "2026-09-01T20:00:00.000Z",
      "2026-09-01T20:00:00.000Z",
    ]);
    expect(jobs.createCalls).toBe(2);
  });

  it("enqueues after a prior spec-only persistence and exposes conflicting prepared input", async () => {
    const retained = fakeReceipt("2026-09-01T20:00:00.000Z");
    const repo = new FaithfulComparisonRepositoryFake(retained);
    const jobs = new FaithfulJobRepositoryFake();

    const recovered = await enqueueFundedComparison(enqueueInput(), {
      repository: repo,
      jobs,
      build: (frozenAt) => fakeBuild(frozenAt),
    });
    expect(recovered).toMatchObject({ reused: true, jobId: "job-1" });

    await expect(
      enqueueFundedComparison(enqueueInput(), {
        repository: new ConflictingComparisonRepositoryFake(retained),
        jobs: new FaithfulJobRepositoryFake(),
        build: (frozenAt) => fakeBuild(frozenAt, "f".repeat(64)),
      }),
    ).rejects.toMatchObject({ reason: "CONFLICTING_RETRY" });
  });

  it("recovers when a concurrent winner appears after the identity prelookup", async () => {
    const repo = new RacingComparisonRepositoryFake();
    const jobs = new FaithfulJobRepositoryFake();

    const output = await enqueueFundedComparison(enqueueInput(), {
      repository: repo,
      jobs,
      build: (frozenAt) => fakeBuild(frozenAt),
    });

    expect(output).toMatchObject({
      reused: true,
      specificationId: "spec-1",
      jobId: "job-1",
    });
    expect(repo.savedFreezeTimes).toEqual([
      "2026-09-02T20:00:00.000Z",
      "2026-09-01T20:00:00.000Z",
    ]);
  });
});

function enqueueInput() {
  return {
    marketId: "CA_TSX" as const,
    baselineBacktestRunId: ids.baseline,
    championPolicyDigest: "a".repeat(64),
    challengerPolicyDigest: "b".repeat(64),
    evidenceCutoffAt: "2026-09-01T19:00:00.000Z",
    maxSessions: 2,
  };
}

function fakeBuild(frozenAt: string, digest = "e".repeat(64)) {
  return {
    specification: {
      comparisonSpecDigest: digest,
      specificationFrozenAt: frozenAt,
      marketId: "CA_TSX",
      currency: "CAD",
    },
    sessions: [],
  } as unknown as FundedComparisonSpecificationBuild;
}

function fakeReceipt(frozenAt: string): FundedComparisonSpecificationReceipt {
  return {
    specification: fakeBuild(frozenAt).specification,
    specId: "spec-1",
    sessions: [],
    opportunities: [],
  } as unknown as FundedComparisonSpecificationReceipt;
}

class FaithfulComparisonRepositoryFake {
  private retained?: FundedComparisonSpecificationReceipt;
  saveCalls = 0;
  savedFreezeTimes: string[] = [];

  constructor(initial?: FundedComparisonSpecificationReceipt) {
    this.retained = initial;
  }

  async findSpecificationIdByFrozenIdentity(): Promise<string | undefined> {
    return this.retained?.specId;
  }

  async loadSpecification(specId: string) {
    return this.retained?.specId === specId ? this.retained : undefined;
  }

  async saveSpecification(freeze: {
    build(specificationFrozenAt: string): FundedComparisonSpecificationBuild;
  }) {
    this.saveCalls += 1;
    const requestedAt =
      this.saveCalls === 1
        ? "2026-09-01T20:00:00.000Z"
        : "2026-09-02T20:00:00.000Z";
    const built = freeze.build(requestedAt);
    this.savedFreezeTimes.push(built.specification.specificationFrozenAt);
    if (
      this.retained &&
      (built.specification.comparisonSpecDigest !==
        this.retained.specification.comparisonSpecDigest ||
        built.specification.specificationFrozenAt !==
          this.retained.specification.specificationFrozenAt)
    )
      throw new FundedComparisonRepositoryError(
        "CONFLICTING_RETRY",
        "retained specification differs",
      );
    if (!this.retained) this.retained = fakeReceipt(requestedAt);
    return this.retained;
  }
}

class ConflictingComparisonRepositoryFake extends FaithfulComparisonRepositoryFake {
  async saveSpecification(freeze: {
    build(specificationFrozenAt: string): FundedComparisonSpecificationBuild;
  }): Promise<FundedComparisonSpecificationReceipt> {
    const built = freeze.build("2026-09-02T20:00:00.000Z");
    throw new FundedComparisonRepositoryError(
      "CONFLICTING_RETRY",
      `conflicting ${built.specification.comparisonSpecDigest}`,
    );
  }
}

class FaithfulJobRepositoryFake {
  createCalls = 0;

  async createStrictJob() {
    this.createCalls += 1;
    return { id: "job-1" };
  }
}

class RacingComparisonRepositoryFake extends FaithfulComparisonRepositoryFake {
  private winner: FundedComparisonSpecificationReceipt | undefined;

  override async findSpecificationIdByFrozenIdentity(): Promise<
    string | undefined
  > {
    return this.winner?.specId;
  }

  override async loadSpecification(specId: string) {
    return this.winner?.specId === specId ? this.winner : undefined;
  }

  override async saveSpecification(freeze: {
    build(specificationFrozenAt: string): FundedComparisonSpecificationBuild;
  }): Promise<FundedComparisonSpecificationReceipt> {
    if (!this.winner) {
      const built = freeze.build("2026-09-02T20:00:00.000Z");
      this.savedFreezeTimes.push(built.specification.specificationFrozenAt);
      this.winner = fakeReceipt("2026-09-01T20:00:00.000Z");
      throw new FundedComparisonRepositoryError(
        "CONFLICTING_RETRY",
        `concurrent winner ${built.specification.comparisonSpecDigest}`,
      );
    }
    return super.saveSpecification(freeze);
  }
}
