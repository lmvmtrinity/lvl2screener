import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  PostgresPaperBotStore,
  type InsertObservationInput,
} from "../src/paper-bot/paper-bot-repository.js";

const observationId = randomUUID();
const runId = randomUUID();
const instrumentId = randomUUID();
const profileId = randomUUID();
const profileConfigId = randomUUID();

const input: InsertObservationInput = {
  runId,
  sourceEventId: randomUUID(),
  sourceSignalId: null,
  setupInstanceId: null,
  instrumentId,
  symbol: "BTO.TO",
  profileId,
  profileName: "Isolation test",
  profileConfigId,
  configVersion: "test",
  profileParameters: {},
  strategyKey: "VWAP_RECLAIM",
  strategyVersion: "1.0.0",
  signalTimestamp: "2026-09-10T14:00:00.000Z",
  score: 80,
  entryReference: 8,
  stopReference: 7.8,
  targetReference: 8.4,
  atr14: 0.25,
  featureSnapshot: {},
  reasonCodes: [],
  sourceEventPayload: {},
  eligibilityStatus: "ELIGIBLE",
  eligibilityReason: null,
};

describe("paper observation challenger isolation", () => {
  it("commits the authoritative observation when optional capture fails inside its savepoint", async () => {
    const queries: string[] = [];
    const observationRow = {
      id: observationId,
      marketId: "CA_TSX" as const,
      runId,
      sourceEventId: input.sourceEventId,
      sourceSignalId: null,
      setupInstanceId: null,
      instrumentId,
      symbol: input.symbol,
      profileId,
      profileName: input.profileName,
      profileConfigId,
      configVersion: input.configVersion,
      profileParameters: {},
      strategyKey: input.strategyKey,
      strategyVersion: input.strategyVersion,
      signalTimestamp: new Date(input.signalTimestamp),
      score: input.score,
      entryReference: "8",
      stopReference: "7.8",
      targetReference: "8.4",
      atr14: "0.25",
      featureSnapshot: {},
      reasonCodes: [],
      sourceEventPayload: {},
      eligibilityStatus: "ELIGIBLE" as const,
      eligibilityReason: null,
      createdAt: new Date("2026-09-10T14:00:00.100Z"),
      capturedAt: new Date("2026-09-10T14:00:00.101Z"),
    };
    const client = {
      query: vi.fn(async (text: string) => {
        queries.push(text);
        if (text.includes("current_setting"))
          return {
            rows: [{ lock_timeout: "0", statement_timeout: "0" }],
            rowCount: 1,
          };
        if (text.startsWith("INSERT INTO paper_signal_observation"))
          return { rows: [{ id: observationId }], rowCount: 1 };
        if (text.includes("FROM paper_signal_observation o"))
          return { rows: [observationRow], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(async () => client),
    } as never;
    const challengerCapture = {
      captureForObservation: vi.fn(async () => {
        throw new Error("challenger inference unavailable");
      }),
    };
    const store = new PostgresPaperBotStore(pool, challengerCapture);

    const result = await store.insertObservation(input);

    expect(result.created).toBe(true);
    expect(result.observation.id).toBe(observationId);
    expect(challengerCapture.captureForObservation).toHaveBeenCalledOnce();
    expect(queries).toContain("SAVEPOINT challenger_attempt_capture");
    expect(queries).toContain(
      "ROLLBACK TO SAVEPOINT challenger_attempt_capture",
    );
    expect(queries).toContain("RELEASE SAVEPOINT challenger_attempt_capture");
    expect(queries).toContain("COMMIT");
    expect(queries).not.toContain("ROLLBACK");
  });
});
