import { describe, expect, it } from "vitest";
import {
  applyLedgerEvent,
  createFundedLedger,
  type LedgerEvent,
} from "../src/paper-bot/funded-ledger.js";
import {
  FUNDED_SNAPSHOT_EVENT_LIMIT,
  PostgresFundedLedgerStore,
  replayFundedLedgerAt,
  replayFundedLedgerBounded,
  reconstructFundedLedgerAt,
  FundedReconstructionUnavailableError,
  type FundedReconstructionObservation,
} from "../src/paper-bot/funded-ledger-repository.js";
import { fundedAccountStateEvidence } from "../src/paper-bot/funded-decision-evidence.js";

describe("funded ledger account provisioning", () => {
  it("reuses an existing account across a new session without rewriting funding", async () => {
    const initial = createFundedLedger(
      "CAD",
      1_000,
      "2099-02-02",
      "2099-02-02T14:00:00.000Z",
      100,
    );
    const pool = {
      query: async () => ({
        rows: [{ state: initial, initial_state: initial }],
      }),
    } as never;

    await expect(
      new PostgresFundedLedgerStore(pool).ensure("account-1", [
        "CAD",
        1_000,
        "2099-02-03",
        "2099-02-03T14:00:00.000Z",
        100,
      ]),
    ).resolves.toEqual(initial);
  });

  it("rejects changing the immutable funding contract", async () => {
    const initial = createFundedLedger(
      "CAD",
      1_000,
      "2099-02-02",
      "2099-02-02T14:00:00.000Z",
      100,
    );
    const pool = {
      query: async () => ({
        rows: [{ state: initial, initial_state: initial }],
      }),
    } as never;

    await expect(
      new PostgresFundedLedgerStore(pool).ensure("account-1", [
        "CAD",
        1_001,
        "2099-02-03",
        "2099-02-03T14:00:00.000Z",
        100,
      ]),
    ).rejects.toThrow("provisioning is immutable");
  });

  it("compacts duplicated snapshot history without dropping durable events", async () => {
    const first: LedgerEvent = {
      id: "mark-1",
      at: "2099-02-02T14:00:01.000Z",
      currency: "CAD",
      type: "MARK",
      instrumentId: "instrument-1",
      bid: 10,
    };
    const second: LedgerEvent = {
      id: "mark-2",
      at: "2099-02-02T14:00:02.000Z",
      currency: "CAD",
      type: "MARK",
      instrumentId: "instrument-1",
      bid: 10.1,
    };
    const current = applyLedgerEvent(
      applyLedgerEvent(
        createFundedLedger(
          "CAD",
          1_000,
          "2099-02-02",
          "2099-02-02T14:00:00.000Z",
          100,
        ),
        first,
      ),
      second,
    );
    let compactedState = current;
    const client = {
      query: async (text: string, params?: readonly unknown[]) => {
        if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK")
          return { rows: [] };
        if (text.includes("SELECT state FROM paper_funded_account"))
          return { rows: [{ state: compactedState }] };
        if (text.includes("UPDATE paper_funded_account")) {
          compactedState = JSON.parse(String(params?.[1])) as typeof current;
          return { rows: [{ persistedEventCount: 2, stateBytes: 321 }] };
        }
        throw new Error(`Unexpected query: ${text}`);
      },
      release: () => {},
    } as never;
    const result = await new PostgresFundedLedgerStore({
      connect: async () => client,
    } as never).compact("account-1", 1);
    expect(result).toEqual({
      accountId: "account-1",
      previousEventCount: 2,
      retainedEventCount: 1,
      persistedEventCount: 2,
      stateBytes: 321,
    });
    expect(compactedState.events).toEqual([second]);
  });

  it("uses the durable event table for retries after snapshot compaction", async () => {
    const event: LedgerEvent = {
      id: "mark-1",
      at: "2099-02-02T14:00:01.000Z",
      currency: "CAD",
      type: "MARK",
      instrumentId: "instrument-1",
      bid: 10,
    };
    const state = {
      ...createFundedLedger(
        "CAD",
        1_000,
        "2099-02-02",
        "2099-02-02T14:00:00.000Z",
        100,
      ),
      events: [],
      lastEventAt: event.at,
    };
    const queries: string[] = [];
    const client = {
      query: async (text: string) => {
        queries.push(text);
        if (text.includes("FROM paper_funded_account WHERE id=$1 FOR UPDATE"))
          return { rows: [{ state, checkpoint_sequence: 0 }] };
        if (
          text.includes(
            "SELECT event_id,event,fact_run_id,fact_id FROM paper_funded_event",
          )
        )
          return {
            rows: [
              {
                event_id: event.id,
                event,
                fact_run_id: null,
                fact_id: null,
              },
            ],
          };
        throw new Error(`Unexpected query: ${text}`);
      },
      release: () => {},
    } as never;
    const result = await new PostgresFundedLedgerStore({
      connect: async () => client,
    } as never).applyInTransaction(client, "account-1", [event]);
    expect(result).toBe(state);
    expect(queries.some((query) => query.includes("INSERT INTO"))).toBe(false);
    expect(
      queries.some((query) => query.includes("UPDATE paper_funded_account")),
    ).toBe(false);
  });

  it("uses an account-local counter instead of recounting the checkpoint window", async () => {
    const state = createFundedLedger(
      "CAD",
      1_000,
      "2099-02-02",
      "2099-02-02T14:00:00.000Z",
      100,
    );
    const event: LedgerEvent = {
      id: "mark-3",
      at: "2099-02-02T14:00:03.000Z",
      currency: "CAD",
      type: "MARK",
      instrumentId: "instrument-1",
      bid: 10,
    };
    const queries: { text: string; values?: readonly unknown[] }[] = [];
    const client = {
      query: async (text: string, values?: readonly unknown[]) => {
        queries.push({ text, values });
        if (text.includes("FROM paper_funded_account WHERE id=$1 FOR UPDATE"))
          return {
            rows: [
              {
                state,
                checkpoint_sequence: 10,
                events_since_checkpoint: 2,
              },
            ],
          };
        if (
          text.includes(
            "SELECT event_id,event,fact_run_id,fact_id FROM paper_funded_event",
          )
        )
          return { rows: [] };
        if (text.includes("INSERT INTO paper_funded_event"))
          return { rows: [{ event_sequence: 13 }] };
        if (text.includes("INSERT INTO paper_funded_ledger_checkpoint"))
          return { rows: [] };
        if (text.includes("UPDATE paper_funded_account")) return { rows: [] };
        throw new Error(`Unexpected query: ${text}`);
      },
      release: () => {},
    } as never;

    await new PostgresFundedLedgerStore(
      { connect: async () => client } as never,
      3,
    ).applyInTransaction(client, "account-1", [event]);

    expect(
      queries.some(({ text }) =>
        text.includes("SELECT count(*) AS count FROM paper_funded_event"),
      ),
    ).toBe(false);
    const accountUpdate = queries.find(({ text }) =>
      text.includes("UPDATE paper_funded_account"),
    );
    expect(accountUpdate?.text).toContain("events_since_checkpoint");
    expect(accountUpdate?.text).toContain("events_since_checkpoint=0");
  });

  it("replays equal-time ledger events in durable application order", () => {
    const initial = createFundedLedger(
      "CAD",
      1_000,
      "2099-02-02",
      "2099-02-02T14:00:00.000Z",
      100,
    );
    const at = "2099-02-02T14:00:01.000Z";
    const reserve: LedgerEvent = {
      id: "reserve",
      at,
      currency: "CAD",
      type: "RESERVE",
      orderId: "order",
      debit: 500,
      risk: 50,
    };
    const buy: LedgerEvent = {
      id: "buy",
      at,
      currency: "CAD",
      type: "BUY",
      orderId: "order",
      positionId: "position",
      instrumentId: "instrument",
      shares: 50,
      price: 10,
      fee: 0,
      stop: 9,
    };
    const state = replayFundedLedgerAt(initial, [reserve, buy], at);
    expect(state.cash).toBe(500);
    expect(state.positions.position?.shares).toBe(50);
    expect(state.reservations).toEqual({});
  });
});

describe("bounded funded ledger replay", () => {
  const initial = createFundedLedger(
    "CAD",
    1_000,
    "2099-02-02",
    "2099-02-02T14:00:00.000Z",
    100,
  );
  const at = "2099-02-02T14:00:10.000Z";
  const events: LedgerEvent[] = [
    {
      id: "reserve",
      at: "2099-02-02T14:00:01.000Z",
      currency: "CAD",
      type: "RESERVE",
      orderId: "order",
      debit: 500,
      risk: 50,
    },
    {
      id: "buy",
      at: "2099-02-02T14:00:01.000Z",
      currency: "CAD",
      type: "BUY",
      orderId: "order",
      positionId: "position",
      instrumentId: "instrument",
      shares: 50,
      price: 10,
      fee: 0,
      stop: 9,
    },
  ];
  for (let index = 0; index < 8; index += 1) {
    events.push({
      id: `mark-${index}`,
      at: "2099-02-02T14:00:02.000Z",
      currency: "CAD",
      type: "MARK",
      instrumentId: "instrument",
      bid: 10 + index * 0.1,
    });
  }
  events.push({
    id: "sell",
    at: "2099-02-02T14:00:03.000Z",
    currency: "CAD",
    type: "SELL",
    positionId: "position",
    shares: 50,
    price: 10.9,
    fee: 1,
  });

  it("produces byte-identical economics and decision evidence as the full replay", () => {
    const full = replayFundedLedgerAt(initial, events, at);
    const bounded = replayFundedLedgerBounded(initial, events, at);
    for (const key of [
      "version",
      "currency",
      "cash",
      "session",
      "openingEquity",
      "dailyLossLimit",
      "realizedPnl",
      "positions",
      "reservations",
      "lastEventAt",
    ] as const)
      expect(bounded[key]).toEqual(full[key]);
    expect(
      fundedAccountStateEvidence(full, at, {
        cooldownActive: false,
        consecutiveStops: 0,
      }),
    ).toStrictEqual(
      fundedAccountStateEvidence(bounded, at, {
        cooldownActive: false,
        consecutiveStops: 0,
      }),
    );
  });

  it("keeps the duplicate-history cache at the snapshot limit", () => {
    const marks: LedgerEvent[] = [];
    for (let index = 0; index < FUNDED_SNAPSHOT_EVENT_LIMIT + 40; index += 1)
      marks.push({
        id: `mark-${index}`,
        at: "2099-02-02T14:00:02.000Z",
        currency: "CAD",
        type: "MARK",
        instrumentId: "instrument",
        bid: 10,
      });
    const state = replayFundedLedgerBounded(initial, marks, at);
    expect(state.events).toHaveLength(FUNDED_SNAPSHOT_EVENT_LIMIT);
    expect(state.events.at(-1)?.id).toBe(
      `mark-${FUNDED_SNAPSHOT_EVENT_LIMIT + 39}`,
    );
  });

  it("replays a large mark-heavy history in linear time without accumulating it", () => {
    const count = 50_000;
    const marks: LedgerEvent[] = [];
    for (let index = 0; index < count; index += 1)
      marks.push({
        id: `mark-${index}`,
        at: "2099-02-02T14:00:02.000Z",
        currency: "CAD",
        type: "MARK",
        instrumentId: "instrument",
        bid: 10,
      });
    const started = performance.now();
    const state = replayFundedLedgerBounded(initial, marks, at);
    const elapsed = performance.now() - started;
    expect(state.events).toHaveLength(FUNDED_SNAPSHOT_EVENT_LIMIT);
    expect(state.cash).toBe(1_000);
    // Quadratic replay of this history (full reducer) takes minutes; linear
    // replay must stay seconds away from that.
    expect(elapsed).toBeLessThan(15_000);
  });
});

describe("reconstructFundedLedgerAt", () => {
  const initial = createFundedLedger(
    "CAD",
    1_000,
    "2099-02-02",
    "2099-02-02T14:00:00.000Z",
    100,
  );
  const event = (id: string, at: string): LedgerEvent => ({
    id,
    at,
    currency: "CAD",
    type: "MARK",
    instrumentId: "instrument",
    bid: 10,
  });

  function fakeClient(rows: {
    checkpoints?: {
      run_id: string;
      boundary_at: string;
      boundary_event_sequence: number;
      state: unknown;
    }[];
    ledgerCheckpoints?: {
      event_sequence: number;
      boundary_at: string;
      state: unknown;
    }[];
    initial?: unknown;
    pages?: {
      event: unknown;
      event_sequence: number;
      event_sequence_verified: boolean;
    }[][];
  }) {
    const queries: { text: string; values?: readonly unknown[] }[] = [];
    const pages = [...(rows.pages ?? [])];
    return {
      queries,
      client: {
        query: async <T>(
          text: string,
          values?: readonly unknown[],
        ): Promise<{ rows: T[] }> => {
          queries.push({ text, values });
          if (text.includes("event_sequence > $2"))
            return { rows: (pages.shift() ?? []) as T[] };
          if (text.includes("FROM paper_funded_run_snapshot")) {
            // Honor the SQL contract: boundary_at <= $2, cursor not null and
            // <= $3, newest first, LIMIT 1.
            const atMs = Date.parse(String(values?.[1]));
            const maxAnchor = Number(values?.[2]);
            const usable = (rows.checkpoints ?? [])
              .filter(
                (candidate) =>
                  candidate.boundary_event_sequence <= maxAnchor &&
                  Date.parse(candidate.boundary_at) <= atMs,
              )
              .sort(
                (left, right) =>
                  Date.parse(right.boundary_at) -
                    Date.parse(left.boundary_at) ||
                  right.boundary_event_sequence - left.boundary_event_sequence,
              );
            return { rows: usable.slice(0, 1) as T[] };
          }
          if (text.includes("FROM paper_funded_ledger_checkpoint")) {
            const atMs = Date.parse(String(values?.[1]));
            const maxAnchor = Number(values?.[2]);
            const usable = (rows.ledgerCheckpoints ?? [])
              .filter(
                (candidate) =>
                  candidate.event_sequence <= maxAnchor &&
                  Date.parse(candidate.boundary_at) <= atMs,
              )
              .sort(
                (left, right) => right.event_sequence - left.event_sequence,
              );
            return { rows: usable.slice(0, 1) as T[] };
          }
          if (text.includes("FROM paper_funded_account"))
            return {
              rows: (rows.initial !== undefined ? [rows.initial] : []) as T[],
            };
          throw new Error(`Unexpected query: ${text}`);
        },
      },
    };
  }

  it("replays from the newest provable checkpoint and counts replayed events", async () => {
    const checkpointState = {
      ...initial,
      lastEventAt: "2099-02-02T14:00:01.000Z",
      events: [{ ...event("mark-0", "2099-02-02T14:00:01.000Z") }],
    };
    const { client, queries } = fakeClient({
      checkpoints: [
        {
          run_id: "run-2",
          boundary_at: "2099-02-02T14:00:01.000Z",
          boundary_event_sequence: 12,
          state: checkpointState,
        },
      ],
      pages: [
        [
          {
            event: event("mark-1", "2099-02-02T14:00:02.000Z"),
            event_sequence: 13,
            event_sequence_verified: true,
          },
        ],
        [],
      ],
    });
    const observations: FundedReconstructionObservation[] = [];
    const reconstruction = await reconstructFundedLedgerAt(
      client,
      "account",
      "2099-02-02T14:00:02.000Z",
      { onReconstruction: (observation) => observations.push(observation) },
    );
    expect(reconstruction.checkpoint).toEqual({
      runId: "run-2",
      boundaryAt: "2099-02-02T14:00:01.000Z",
      anchorEventSequence: 12,
    });
    expect(reconstruction.replayedEventCount).toBe(1);
    expect(reconstruction.pages).toBe(1);
    expect(
      queries.some((entry) => entry.text.includes("paper_funded_account")),
    ).toBe(false);
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      outcome: "CHECKPOINTED",
      replayedEventCount: 1,
      pages: 1,
      checkpointRunId: "run-2",
      checkpointBoundaryAt: "2099-02-02T14:00:01.000Z",
      checkpointAgeMs: 1000,
    });
    expect(observations[0]!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("prefers the newer generic ledger checkpoint over the run snapshot", async () => {
    const snapshotState = {
      ...initial,
      lastEventAt: "2099-02-02T14:00:01.000Z",
      events: [event("mark-0", "2099-02-02T14:00:01.000Z")],
    };
    const ledgerState = {
      ...initial,
      lastEventAt: "2099-02-02T14:00:03.000Z",
      events: [
        event("mark-2", "2099-02-02T14:00:02.000Z"),
        event("mark-3", "2099-02-02T14:00:03.000Z"),
      ],
    };
    const { client } = fakeClient({
      checkpoints: [
        {
          run_id: "run-2",
          boundary_at: "2099-02-02T14:00:01.000Z",
          boundary_event_sequence: 12,
          state: snapshotState,
        },
      ],
      ledgerCheckpoints: [
        {
          event_sequence: 15,
          boundary_at: "2099-02-02T14:00:03.000Z",
          state: ledgerState,
        },
      ],
      pages: [
        [
          {
            event: event("mark-4", "2099-02-02T14:00:04.000Z"),
            event_sequence: 16,
            event_sequence_verified: true,
          },
        ],
        [],
      ],
    });
    const reconstruction = await reconstructFundedLedgerAt(
      client,
      "account",
      "2099-02-02T14:00:04.000Z",
    );
    expect(reconstruction.checkpoint).toEqual({
      runId: null,
      boundaryAt: "2099-02-02T14:00:03.000Z",
      anchorEventSequence: 15,
    });
    expect(reconstruction.replayedEventCount).toBe(1);
  });

  it("rejects a checkpoint that lies after the proven decision boundary", async () => {
    const checkpointState = {
      ...initial,
      lastEventAt: "2099-02-02T14:00:05.000Z",
      events: [event("reserve:obs-1", "2099-02-02T14:00:05.000Z")],
    };
    const { client, queries } = fakeClient({
      checkpoints: [
        {
          run_id: "run-2",
          boundary_at: "2099-02-02T14:00:05.000Z",
          boundary_event_sequence: 20,
          state: checkpointState,
        },
      ],
      initial: { initial_state: initial },
      pages: [],
    });
    const reconstruction = await reconstructFundedLedgerAt(
      client,
      "account",
      "2099-02-02T14:00:06.000Z",
      { maxEventSequence: 19 },
    );
    expect(reconstruction.checkpoint).toBeNull();
    expect(reconstruction.replayedEventCount).toBe(0);
    expect(reconstruction.ledger.reservations).toEqual({});
    // The bound reaches the durable query, so checkpoint selection and replay
    // are both capped strictly before the proven boundary.
    const page = queries.find((entry) =>
      entry.text.includes("event_sequence <= $4"),
    );
    expect(page?.values?.[3]).toBe(19);
  });

  it("fails closed on unverified durable ordering", async () => {
    const { client } = fakeClient({
      initial: { initial_state: initial },
      pages: [
        [
          {
            event: event("mark-1", "2099-02-02T14:00:02.000Z"),
            event_sequence: 2,
            event_sequence_verified: false,
          },
        ],
      ],
    });
    const failure = reconstructFundedLedgerAt(
      client,
      "account",
      "2099-02-02T14:00:02.000Z",
    );
    await expect(failure).rejects.toThrow(FundedReconstructionUnavailableError);
    await expect(failure).rejects.toThrow(
      "event order predates temporal sequencing",
    );
  });

  it("fails closed when the reconstruction exceeds its event budget", async () => {
    const { client } = fakeClient({
      initial: { initial_state: initial },
      pages: [
        [
          {
            event: event("mark-1", "2099-02-02T14:00:02.000Z"),
            event_sequence: 2,
            event_sequence_verified: true,
          },
        ],
      ],
    });
    const observations: FundedReconstructionObservation[] = [];
    await expect(
      reconstructFundedLedgerAt(client, "account", "2099-02-02T14:00:02.000Z", {
        maxEvents: 0,
        onReconstruction: (observation) => observations.push(observation),
      }),
    ).rejects.toThrow(/event budget/);
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      outcome: "UNAVAILABLE",
      failureCode: "BUDGET_EXCEEDED",
      replayedEventCount: 1,
      pages: 1,
      checkpointRunId: null,
    });
  });

  it("bounds replay at the caller-proven event cursor", async () => {
    const { client, queries } = fakeClient({
      initial: { initial_state: initial },
      pages: [
        [
          {
            event: event("mark-1", "2099-02-02T14:00:02.000Z"),
            event_sequence: 13,
            event_sequence_verified: true,
          },
        ],
        [],
      ],
    });
    const reconstruction = await reconstructFundedLedgerAt(
      client,
      "account",
      "2099-02-02T14:00:02.000Z",
      { maxEventSequence: 13 },
    );
    expect(reconstruction.replayedEventCount).toBe(1);
    const page = queries.find((entry) =>
      entry.text.includes("event_sequence <= $4"),
    );
    expect(page?.values?.[3]).toBe(13);
  });

  it("fails closed when a checkpoint state does not prove its own boundary", async () => {
    const { client } = fakeClient({
      checkpoints: [
        {
          run_id: "run-2",
          boundary_at: "2099-02-02T14:00:01.000Z",
          boundary_event_sequence: 12,
          state: { ...initial, lastEventAt: "2099-02-02T14:00:09.000Z" },
        },
      ],
    });
    await expect(
      reconstructFundedLedgerAt(client, "account", "2099-02-02T14:00:02.000Z"),
    ).rejects.toThrow(/does not prove its own boundary/);
  });
});
