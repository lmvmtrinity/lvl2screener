import type {
  BacktestAutomationStageKey,
  CapturedHistoryAvailability,
  MarketId,
  ResearchJobType,
} from "@tsx-scanner/contracts";
import type {
  BacktestAutomationControlRecord,
  BacktestAutomationCycleRecord,
  BacktestAutomationDispatcher,
  BacktestAutomationInputs,
  BacktestAutomationJobSnapshot,
  BacktestAutomationStageRecord,
  BacktestAutomationStore,
  BacktestAutomationWorkRecord,
} from "../src/backtests/backtest-automation.js";
import type { ReplayCandidatePlan } from "../src/backtests/replay-candidate-plan.js";

/** Deterministic in-memory automation store for scheduling-semantics tests. It
 * mirrors the durable Postgres contract (including live-job counting) so the
 * same engine behavior is exercised without a database. */
export class InMemoryBacktestAutomationStore implements BacktestAutomationStore {
  readonly controls = new Map<MarketId, BacktestAutomationControlRecord>();
  readonly works = new Map<string, BacktestAutomationWorkRecord>();
  readonly stages = new Map<string, BacktestAutomationStageRecord>();
  readonly cycles: BacktestAutomationCycleRecord[] = [];
  readonly jobs = new Map<string, BacktestAutomationJobSnapshot>();
  readonly runEnds = new Map<string, string>();
  readonly runCandidates = new Map<string, number>();

  async getControl(
    marketId: MarketId,
  ): Promise<BacktestAutomationControlRecord | undefined> {
    return this.controls.get(marketId);
  }

  async upsertControl(control: BacktestAutomationControlRecord): Promise<void> {
    this.controls.set(control.marketId, control);
  }

  async getWork(
    workKey: string,
  ): Promise<BacktestAutomationWorkRecord | undefined> {
    return this.works.get(workKey);
  }

  async listWork(marketId: MarketId): Promise<BacktestAutomationWorkRecord[]> {
    return [...this.works.values()].filter(
      (work) => work.marketId === marketId,
    );
  }

  async saveWork(record: BacktestAutomationWorkRecord): Promise<void> {
    this.works.set(record.workKey, record);
  }

  async countLiveWork(marketId: MarketId): Promise<number> {
    let count = 0;
    for (const work of this.works.values()) {
      if (work.marketId !== marketId || !work.jobId) continue;
      const status = this.jobs.get(work.jobId)?.status;
      if (
        status === "QUEUED" ||
        status === "RUNNING" ||
        status === "CANCELLING"
      )
        count += 1;
    }
    return count;
  }

  async jobSnapshots(
    jobIds: readonly string[],
  ): Promise<Map<string, BacktestAutomationJobSnapshot>> {
    const snapshots = new Map<string, BacktestAutomationJobSnapshot>();
    for (const id of jobIds) {
      const snapshot = this.jobs.get(id);
      if (snapshot) snapshots.set(id, snapshot);
    }
    return snapshots;
  }

  async runEndDates(runIds: readonly string[]): Promise<Map<string, string>> {
    const endDates = new Map<string, string>();
    for (const id of runIds) {
      const endDate = this.runEnds.get(id);
      if (endDate) endDates.set(id, endDate);
    }
    return endDates;
  }

  async runCandidateCounts(
    runIds: readonly string[],
  ): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    for (const id of runIds) {
      const count = this.runCandidates.get(id);
      if (count !== undefined) counts.set(id, count);
      else if (this.runEnds.has(id)) counts.set(id, 1);
    }
    return counts;
  }

  async listCycles(
    marketId: MarketId,
    limit: number,
  ): Promise<BacktestAutomationCycleRecord[]> {
    return this.cycles
      .filter((cycle) => cycle.marketId === marketId)
      .slice(-limit)
      .reverse();
  }

  async insertCycle(record: BacktestAutomationCycleRecord): Promise<void> {
    this.cycles.push(record);
  }

  async getStage(
    stageKey: BacktestAutomationStageKey,
    workKey: string,
  ): Promise<BacktestAutomationStageRecord | undefined> {
    return this.stages.get(`${stageKey}:${workKey}`);
  }

  async listStages(
    marketId: MarketId,
  ): Promise<BacktestAutomationStageRecord[]> {
    return [...this.stages.values()].filter(
      (stage) => stage.marketId === marketId,
    );
  }

  async saveStage(record: BacktestAutomationStageRecord): Promise<void> {
    this.stages.set(`${record.stageKey}:${record.workKey}`, record);
  }

  async clearStages(workKey: string): Promise<void> {
    for (const key of [...this.stages.keys()])
      if (this.stages.get(key)?.workKey === workKey) this.stages.delete(key);
  }
}

export class RecordingBacktestAutomationInputs implements BacktestAutomationInputs {
  availability: CapturedHistoryAvailability;
  fingerprint = "a".repeat(64);
  availabilityCalls: MarketId[] = [];
  fingerprintCalls: MarketId[] = [];
  fingerprintMembership: (string | undefined)[] = [];
  candidatePlan: ReplayCandidatePlan = {
    provenance: "HISTORICAL_MEMBERSHIP",
    sessions: [],
    candidateInstruments: [
      {
        instrumentId: "11111111-1111-4111-8111-111111111111",
        symbol: "TEST.TO",
        sector: null,
      },
    ],
    universeRefreshRunId: null,
    warnings: [],
    digest: "b".repeat(64),
  };
  candidatePlanCalls: {
    marketId: MarketId;
    startDate: string;
    endDate: string;
  }[] = [];

  constructor(availability?: Partial<CapturedHistoryAvailability>) {
    this.availability = {
      source: "CAPTURED_QUOTES",
      observedAt: "2026-09-10T20:00:00.000Z",
      tables: {
        quoteSnapshot: {
          earliest: "2026-09-01T13:30:00.000Z",
          latest: "2026-09-10T20:00:00.000Z",
        },
        candle: {
          earliest: "2026-08-01T13:30:00.000Z",
          latest: "2026-09-10T20:00:00.000Z",
        },
      },
      replay: { earliestDate: "2026-09-01", latestDate: "2026-09-10" },
      ...availability,
    };
  }

  async getCapturedHistoryAvailability(
    marketId: MarketId,
  ): Promise<CapturedHistoryAvailability> {
    this.availabilityCalls.push(marketId);
    return this.availability;
  }

  async captureInputFingerprint(
    marketId: MarketId,
    _now?: Date,
    membership?: string,
  ): Promise<string> {
    this.fingerprintCalls.push(marketId);
    this.fingerprintMembership.push(membership);
    return this.fingerprint;
  }

  async resolveReplayCandidatePlan(input: {
    marketId: MarketId;
    startDate: string;
    endDate: string;
  }): Promise<ReplayCandidatePlan> {
    this.candidatePlanCalls.push({
      marketId: input.marketId,
      startDate: input.startDate,
      endDate: input.endDate,
    });
    return this.candidatePlan;
  }
}

export class RecordingBacktestAutomationDispatcher implements BacktestAutomationDispatcher {
  readonly calls: {
    type: string;
    payload: unknown;
    idempotencyKey: string;
    priority: number | undefined;
  }[] = [];
  private nextJob = 1;

  constructor(private readonly store?: InMemoryBacktestAutomationStore) {}

  async createJob(
    type: ResearchJobType,
    payload: unknown,
    idempotencyKey: string,
    priority?: number,
  ): Promise<{ id: string }> {
    this.calls.push({ type, payload, idempotencyKey, priority });
    const id = `00000000-0000-4000-8000-${String(this.nextJob).padStart(12, "0")}`;
    this.nextJob += 1;
    this.store?.jobs.set(id, {
      id,
      status: "QUEUED",
      resultRefId: null,
      error: null,
      errorCategory: null,
      completedAt: null,
    });
    return { id };
  }
}
