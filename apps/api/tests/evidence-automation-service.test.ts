import { describe, expect, it } from "vitest";
import type {
  EvidenceAutomationRepository,
  EvidenceAutomationWorkRecord,
} from "../src/statistical-models/evidence-automation-repository.js";
import { EvidenceAutomationService } from "../src/statistical-models/evidence-automation-service.js";
import type {
  EvidenceWorkIdentity,
  EvidenceWorkReceipt,
} from "@tsx-scanner/contracts";
import type { EvidenceStageFact } from "../src/statistical-models/evidence-automation-read-repository.js";

class FakeRepository implements EvidenceAutomationRepository {
  records: EvidenceAutomationWorkRecord[] = [];
  async record(identity: EvidenceWorkIdentity, receipt: EvidenceWorkReceipt) {
    this.records.push({
      workKey: receipt.workKey,
      identity,
      jobId: receipt.jobId,
      receipt,
    });
  }
  async list(): Promise<EvidenceAutomationWorkRecord[]> {
    return this.records;
  }
}

const identity: EvidenceWorkIdentity = {
  kind: "COVERAGE",
  marketId: "CA_TSX",
  scopeHash: "a".repeat(64),
  inputIdentityHash: "b".repeat(64),
  processorVersion: "coverage-v1",
};

describe("EvidenceAutomationService", () => {
  it("shows a newer failed attempt without losing the earlier successful coverage", async () => {
    const fact: EvidenceStageFact = {
      key: "COVERAGE",
      marketId: "CA_TSX",
      scopeId: "old",
      state: "SUCCEEDED",
      attemptedAt: "2026-09-09T17:00:00.000Z",
      succeededAt: "2026-09-09T17:01:00.000Z",
      nextCheckAt: null,
      progress: null,
      reasonCodes: [],
      jobId: "10000000-0000-4000-8000-000000000980",
      reportId: "a".repeat(64),
    };
    const repository = new FakeRepository();
    const service = new EvidenceAutomationService(
      repository,
      {
        list: async () => [
          {
            id: "10000000-0000-4000-8000-000000000981",
            jobType: "COVERAGE_VERIFICATION",
            status: "FAILED",
            createdAt: "2026-09-10T17:00:00.000Z",
            startedAt: "2026-09-10T17:01:00.000Z",
            completedAt: "2026-09-10T17:02:00.000Z",
            requestPayload: {
              request: {
                marketId: "CA_TSX",
                manifestHash: "a".repeat(64),
                inputCutoff: "2026-09-10T17:00:00.000Z",
                sessionDates: ["2026-09-10"],
              },
              manifest: {
                hash: "a".repeat(64),
                marketId: "CA_TSX",
                manifest: {},
              },
              engineRevision: "b".repeat(40),
              runtimeFingerprint: "a".repeat(64),
            },
            progress: {},
            resultRefId: null,
            error: "failed",
            errorCategory: "VALIDATION",
          },
        ],
      } as never,
      () => new Date("2026-09-10T18:00:00.000Z"),
      { listStageFacts: async () => [fact] },
    );
    await service.record(identity, {
      state: "WAITING",
      jobId: null,
      reasonCodes: ["UNRELATED_SCOPE_WAITING"],
      recordedAt: "2026-09-10T17:59:00.000Z",
    });
    expect((await service.stages("CA_TSX"))[0]).toMatchObject({
      state: "FAILED",
      jobId: "10000000-0000-4000-8000-000000000981",
      lastAttemptAt: "2026-09-10T17:01:00.000Z",
      lastSuccessAt: fact.succeededAt,
    });
  });
  it("keeps a current retry visible ahead of a historical failure", async () => {
    const succeededFact: EvidenceStageFact = {
      key: "COVERAGE",
      marketId: "CA_TSX",
      scopeId: "previous-success",
      state: "SUCCEEDED",
      attemptedAt: "2026-09-08T17:00:00.000Z",
      succeededAt: "2026-09-08T17:01:00.000Z",
      nextCheckAt: null,
      progress: null,
      reasonCodes: [],
      jobId: "10000000-0000-4000-8000-000000000982",
      reportId: "c".repeat(64),
    };
    const failedFact: EvidenceStageFact = {
      key: "COVERAGE",
      marketId: "CA_TSX",
      scopeId: "previous-failure",
      state: "FAILED",
      attemptedAt: "2026-09-12T12:00:00.000Z",
      succeededAt: null,
      nextCheckAt: null,
      progress: null,
      reasonCodes: ["EVIDENCE_RUNTIME_MISMATCH"],
      jobId: "10000000-0000-4000-8000-000000000983",
      reportId: "d".repeat(64),
    };
    const retryJobId = "10000000-0000-4000-8000-000000000984";
    const service = new EvidenceAutomationService(
      new FakeRepository(),
      {
        list: async () => [
          {
            id: retryJobId,
            jobType: "COVERAGE_VERIFICATION",
            status: "RUNNING",
            createdAt: "2026-09-14T19:30:00.000Z",
            startedAt: "2026-09-14T19:31:00.000Z",
            completedAt: null,
            requestPayload: {
              request: {
                marketId: "CA_TSX",
                manifestHash: "e".repeat(64),
                inputCutoff: "2026-09-14T19:30:00.000Z",
                sessionDates: ["2026-09-14"],
              },
              manifest: {
                hash: "e".repeat(64),
                marketId: "CA_TSX",
                manifest: {},
              },
              engineRevision: "f".repeat(40),
              runtimeFingerprint: "a".repeat(64),
            },
            progress: { completedSessions: 3, totalSessions: 10 },
            resultRefId: null,
            error: null,
            errorCategory: null,
          },
        ],
      } as never,
      () => new Date("2026-09-14T19:40:00.000Z"),
      {
        listStageFacts: async () => [succeededFact, failedFact],
      },
    );

    const coverage = (await service.stages("CA_TSX")).find(
      (stage) => stage.key === "COVERAGE",
    );

    expect(coverage).toMatchObject({
      state: "RUNNING",
      jobId: retryJobId,
      lastAttemptAt: "2026-09-14T19:31:00.000Z",
      progress: { completed: 3, total: 10, unit: "sessions" },
      lastSuccessAt: "2026-09-08T17:01:00.000Z",
      relatedScopes: [
        {
          scopeId: "previous-failure",
          state: "FAILED",
          lastAttemptAt: "2026-09-12T12:00:00.000Z",
          reasonCodes: ["EVIDENCE_RUNTIME_MISMATCH"],
        },
        expect.objectContaining({
          scopeId: "previous-success",
          state: "SUCCEEDED",
          lastAttemptAt: "2026-09-08T17:00:00.000Z",
        }),
      ],
    });
  });
  it("deduplicates identical work identities by a stable content key", async () => {
    const repository = new FakeRepository();
    const service = new EvidenceAutomationService(
      repository,
      undefined,
      () => new Date("2026-09-10T00:00:00.000Z"),
    );
    await service.record(identity, {
      state: "NO_NEW_EVIDENCE",
      jobId: null,
      reasonCodes: ["UNCHANGED_INPUTS"],
    });
    await service.record(identity, {
      state: "NO_NEW_EVIDENCE",
      jobId: null,
      reasonCodes: ["UNCHANGED_INPUTS"],
    });
    expect(repository.records[0]?.workKey).toBe(repository.records[1]?.workKey);
    expect(repository.records[0]?.workKey).toHaveLength(64);
  });

  it("exposes six unknown lanes without inventing history", async () => {
    const service = new EvidenceAutomationService(
      new FakeRepository(),
      undefined,
      () => new Date("2026-09-10T00:00:00.000Z"),
    );
    const stages = await service.stages("US_EQUITIES");
    expect(stages).toHaveLength(6);
    expect(stages.every((stage) => stage.state === "UNKNOWN")).toBe(true);
    expect(stages.every((stage) => stage.lastAttemptAt === null)).toBe(true);
    expect(stages.every((stage) => stage.marketId === "US_EQUITIES")).toBe(
      true,
    );
  });
  it("retains UNKNOWN report scopes in related history while the running attempt stays primary", async () => {
    const running: EvidenceStageFact = {
      key: "COVERAGE",
      marketId: "CA_TSX",
      scopeId: "current-retry",
      state: "RUNNING",
      attemptedAt: "2026-09-14T19:31:00.000Z",
      succeededAt: null,
      nextCheckAt: null,
      progress: { completed: 3, total: 10, unit: "sessions" },
      reasonCodes: [],
      jobId: "10000000-0000-4000-8000-000000000990",
      reportId: null,
    };
    const unknownReport = (
      scopeId: string,
      reportId: string,
      attemptedAt: string,
    ): EvidenceStageFact => ({
      key: "COVERAGE",
      marketId: "CA_TSX",
      scopeId,
      state: "UNKNOWN",
      attemptedAt,
      succeededAt: null,
      nextCheckAt: null,
      progress: null,
      reasonCodes: ["COVERAGE_UNKNOWN"],
      jobId: null,
      reportId,
    });
    const service = new EvidenceAutomationService(
      new FakeRepository(),
      undefined,
      () => new Date("2026-09-14T19:40:00.000Z"),
      {
        listStageFacts: async () => [
          running,
          unknownReport(
            "coverage-a",
            "a".repeat(64),
            "2026-09-13T17:00:00.000Z",
          ),
          unknownReport(
            "coverage-b",
            "b".repeat(64),
            "2026-09-12T17:00:00.000Z",
          ),
        ],
      },
    );

    const coverage = (await service.stages("CA_TSX")).find(
      (stage) => stage.key === "COVERAGE",
    );
    expect(coverage).toMatchObject({
      state: "RUNNING",
      scopeId: "current-retry",
      progress: { completed: 3, total: 10, unit: "sessions" },
    });
    expect(coverage?.relatedScopes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scopeId: "coverage-a",
          state: "UNKNOWN",
          reportId: "a".repeat(64),
        }),
        expect.objectContaining({
          scopeId: "coverage-b",
          state: "UNKNOWN",
          reportId: "b".repeat(64),
        }),
      ]),
    );
  });

  it("keeps every retained UNKNOWN report reachable when no attempt is current", async () => {
    const unknownReport = (
      scopeId: string,
      reportId: string,
      attemptedAt: string,
    ): EvidenceStageFact => ({
      key: "COVERAGE",
      marketId: "CA_TSX",
      scopeId,
      state: "UNKNOWN",
      attemptedAt,
      succeededAt: null,
      nextCheckAt: null,
      progress: null,
      reasonCodes: ["COVERAGE_UNKNOWN"],
      jobId: null,
      reportId,
    });
    const service = new EvidenceAutomationService(
      new FakeRepository(),
      undefined,
      () => new Date("2026-09-14T19:40:00.000Z"),
      {
        listStageFacts: async () => [
          unknownReport(
            "coverage-a",
            "a".repeat(64),
            "2026-09-13T17:00:00.000Z",
          ),
          unknownReport(
            "coverage-b",
            "b".repeat(64),
            "2026-09-12T17:00:00.000Z",
          ),
          unknownReport(
            "coverage-c",
            "c".repeat(64),
            "2026-09-11T17:00:00.000Z",
          ),
        ],
      },
    );

    const coverage = (await service.stages("CA_TSX")).find(
      (stage) => stage.key === "COVERAGE",
    );
    expect(coverage).toMatchObject({
      state: "UNKNOWN",
      scopeId: "coverage-a",
      reportId: "a".repeat(64),
    });
    expect(coverage?.relatedScopes?.map((scope) => scope.scopeId)).toEqual([
      "coverage-b",
      "coverage-c",
    ]);
    expect(
      coverage?.relatedScopes?.every(
        (scope) => scope.state === "UNKNOWN" && scope.reportId,
      ),
    ).toBe(true);
  });

  it("does not repeat the same retained job and report identity", async () => {
    const fact = (
      attemptedAt: string,
      overrides: Partial<EvidenceStageFact> = {},
    ): EvidenceStageFact => ({
      key: "COVERAGE",
      marketId: "CA_TSX",
      scopeId: "shared-scope",
      state: "UNKNOWN",
      attemptedAt,
      succeededAt: null,
      nextCheckAt: null,
      progress: null,
      reasonCodes: ["COVERAGE_UNKNOWN"],
      jobId: "10000000-0000-4000-8000-000000000991",
      reportId: "a".repeat(64),
      ...overrides,
    });
    const service = new EvidenceAutomationService(
      new FakeRepository(),
      undefined,
      () => new Date("2026-09-14T19:40:00.000Z"),
      {
        listStageFacts: async () => [
          fact("2026-09-13T17:00:00.000Z"),
          fact("2026-09-12T17:00:00.000Z"),
        ],
      },
    );
    const coverage = (await service.stages("CA_TSX")).find(
      (stage) => stage.key === "COVERAGE",
    );
    expect(coverage?.relatedScopes).toEqual([]);
  });

  it("keeps distinct jobs with the same fallback scope in related history", async () => {
    const running = {
      id: "10000000-0000-4000-8000-000000000a01",
      jobType: "COVERAGE_VERIFICATION",
      status: "RUNNING",
      createdAt: "2026-09-14T19:30:00.000Z",
      startedAt: "2026-09-14T19:31:00.000Z",
      completedAt: null,
      requestPayload: {
        request: {
          marketId: "CA_TSX",
          manifestHash: "e".repeat(64),
          inputCutoff: "2026-09-14T19:30:00.000Z",
          sessionDates: ["2026-09-14"],
        },
        manifest: { hash: "e".repeat(64), marketId: "CA_TSX", manifest: {} },
        engineRevision: "f".repeat(40),
        runtimeFingerprint: "a".repeat(64),
      },
      progress: { completedSessions: 3, totalSessions: 10 },
      resultRefId: null,
      error: null,
      errorCategory: null,
    };
    const failed = {
      ...running,
      id: "10000000-0000-4000-8000-000000000a02",
      status: "FAILED",
      createdAt: "2026-09-13T19:30:00.000Z",
      startedAt: "2026-09-13T19:31:00.000Z",
      completedAt: "2026-09-13T19:32:00.000Z",
      progress: {},
      error: "verification failed",
      errorCategory: "VALIDATION",
    };
    const succeeded = {
      ...running,
      id: "10000000-0000-4000-8000-000000000a03",
      status: "SUCCEEDED",
      createdAt: "2026-09-12T19:30:00.000Z",
      startedAt: "2026-09-12T19:31:00.000Z",
      completedAt: "2026-09-12T19:32:00.000Z",
      progress: {},
      resultRefId: "b".repeat(64),
    };
    const service = new EvidenceAutomationService(
      new FakeRepository(),
      { list: async () => [running, failed, succeeded] } as never,
      () => new Date("2026-09-14T19:40:00.000Z"),
      { listStageFacts: async () => [] },
    );

    const coverage = (await service.stages("CA_TSX")).find(
      (stage) => stage.key === "COVERAGE",
    );
    expect(coverage).toMatchObject({
      state: "RUNNING",
      scopeId: "CA_TSX:coverage:job",
      jobId: running.id,
      progress: { completed: 3, total: 10, unit: "sessions" },
    });
    expect(coverage?.relatedScopes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scopeId: "CA_TSX:coverage:job",
          state: "FAILED",
          jobId: failed.id,
        }),
        expect.objectContaining({
          scopeId: "CA_TSX:coverage:job",
          state: "SUCCEEDED",
          jobId: succeeded.id,
          reportId: "b".repeat(64),
        }),
      ]),
    );
  });

  it("projects qualification and forward-observation facts into their real lanes", async () => {
    const facts: EvidenceStageFact[] = [
      {
        key: "COVERAGE",
        marketId: "CA_TSX",
        scopeId: "10000000-0000-4000-8000-000000000980",
        state: "UNKNOWN",
        attemptedAt: "2026-09-10T17:00:00.000Z",
        succeededAt: null,
        nextCheckAt: null,
        progress: null,
        reasonCodes: ["COVERAGE_UNKNOWN"],
        jobId: "10000000-0000-4000-8000-000000000983",
        reportId: "a".repeat(64),
      },
      {
        key: "QUALIFICATION",
        marketId: "CA_TSX",
        scopeId: "10000000-0000-4000-8000-000000000981",
        state: "WAITING",
        attemptedAt: "2026-09-10T17:00:00.000Z",
        succeededAt: null,
        nextCheckAt: null,
        progress: {
          completed: 20,
          total: 200,
          unit: "qualified evidence rows",
        },
        reasonCodes: ["INSUFFICIENT_CLOSED_QUOTES"],
        jobId: null,
        reportId: "10000000-0000-4000-8000-000000000981",
      },
      {
        key: "FORWARD_OBSERVATION",
        marketId: "CA_TSX",
        scopeId: "10000000-0000-4000-8000-000000000982",
        state: "RUNNING",
        attemptedAt: "2026-09-10T13:00:00.000Z",
        succeededAt: null,
        nextCheckAt: "2026-09-17T20:00:00.000Z",
        progress: null,
        reasonCodes: [],
        jobId: null,
        reportId: "10000000-0000-4000-8000-000000000982",
      },
    ];
    const service = new EvidenceAutomationService(
      new FakeRepository(),
      undefined,
      () => new Date("2026-09-10T18:00:00.000Z"),
      { listStageFacts: async () => facts },
    );
    const stages = await service.stages("CA_TSX");
    expect(stages.find((stage) => stage.key === "COVERAGE")).toMatchObject({
      state: "UNKNOWN",
      reasonCodes: ["COVERAGE_UNKNOWN"],
      nextAction: { kind: "USER_REVIEW" },
      reportId: facts[0]!.reportId,
    });
    expect(stages.find((stage) => stage.key === "QUALIFICATION")).toMatchObject(
      {
        state: "WAITING",
        reportId: facts[1]!.reportId,
        progress: facts[1]!.progress,
      },
    );
    expect(
      stages.find((stage) => stage.key === "FORWARD_OBSERVATION"),
    ).toMatchObject({
      state: "RUNNING",
      reportId: facts[2]!.reportId,
      nextCheckAt: facts[2]!.nextCheckAt,
    });
  });
});
