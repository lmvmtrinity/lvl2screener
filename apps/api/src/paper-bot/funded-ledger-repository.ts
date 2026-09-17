import { isDeepStrictEqual } from "node:util";
import type { Pool, PoolClient } from "pg";
import {
  applyLedgerEvent,
  createFundedLedger,
  type FundedLedger,
  type LedgerEvent,
} from "./funded-ledger.js";

export const FUNDED_SNAPSHOT_EVENT_LIMIT = 256;

/** Applied events between periodic ledger checkpoints. A run-start anchor is
 *  written on every session rollover regardless; this bound keeps first-session
 *  and Mark-heavy windows short between those rollovers. */
export const FUNDED_CHECKPOINT_EVENT_INTERVAL = 20_000;

/**
 * Hard bound on the events one reconstruction may process. With the bounded
 * duplicate-history cache the replay is linear, but a pathological window
 * (for example a first session with no earlier checkpoint) must fail visibly
 * instead of silently consuming unbounded time and memory. Established
 * accounts checkpoint at every completed run boundary, so windows stay far
 * below this; hitting it means a new checkpoint strategy is required, not a
 * larger constant.
 */
export const FUNDED_REPLAY_EVENT_BUDGET = 250_000;

/** Rows fetched per replay page. Between pages the loop yields the event loop,
 * so a long reconstruction cannot starve health checks or other requests. */
const FUNDED_REPLAY_PAGE_SIZE = 2_000;

/** Reconstruction cannot be proven from durable sources; callers must surface
 *  this as an explicit capture or report failure rather than retrying blindly.
 *  The code distinguishes the fail-closed reasons so operational metrics can
 *  alert on the capacity guard (budget) separately from evidence gaps. */
export type FundedReconstructionFailureCode =
  | "BUDGET_EXCEEDED"
  | "UNVERIFIED_ORDERING"
  | "CHECKPOINT_UNPROVEN"
  | "ACCOUNT_UNAVAILABLE"
  | "BOUNDARY_BEFORE_CREATION"
  | "BOUNDARY_UNPROVEN";

export class FundedReconstructionUnavailableError extends Error {
  constructor(
    // `undefined` keeps legacy call shapes valid for non-coded failures.
    readonly code: FundedReconstructionFailureCode | undefined,
    reason: string,
  ) {
    super(reason);
    this.name = "FundedReconstructionUnavailableError";
  }
}

/** One reconstruction attempt, for operational metrics. Duration is wall time
 *  of the whole attempt; checkpointAgeMs is the replayed window span
 *  (boundary minus checkpoint boundary), not wall-clock age. */
export interface FundedReconstructionObservation {
  readonly outcome: "CHECKPOINTED" | "FULL" | "UNAVAILABLE";
  readonly failureCode?: FundedReconstructionFailureCode;
  readonly durationMs: number;
  readonly replayedEventCount: number;
  readonly pages: number;
  readonly checkpointRunId: string | null;
  readonly checkpointBoundaryAt: string | null;
  readonly checkpointAgeMs: number | null;
}

function observeReconstruction(
  onReconstruction:
    ((observation: FundedReconstructionObservation) => void) | undefined,
  observation: FundedReconstructionObservation,
): void {
  if (!onReconstruction) return;
  try {
    onReconstruction(observation);
  } catch {
    // Metrics must never change reconstruction semantics.
  }
}

export interface FundedLedgerCheckpoint {
  /** Snapshot the checkpoint came from; null for a full replay. */
  readonly runId: string | null;
  /** Snapshot boundary; null for a full replay. */
  readonly boundaryAt: string | null;
  /**
   * Durable event sequence the checkpoint state already reflects. Every
   * retained event in the checkpoint state has a sequence at or below this
   * value; reconstruction applies only later events.
   */
  readonly anchorEventSequence: number;
}

export interface FundedLedgerReconstruction {
  readonly ledger: FundedLedger;
  readonly checkpoint: FundedLedgerCheckpoint | null;
  readonly replayedEventCount: number;
  /** Post-anchor event pages fetched; zero for an empty window. */
  readonly pages: number;
}

/** Reconstructs a ledger from its immutable initial state and ordered events. */
export function replayFundedLedgerAt(
  initial: FundedLedger,
  events: readonly LedgerEvent[],
  at: string,
  maxMarkAgeMs = 30000,
): FundedLedger {
  const boundary = Date.parse(at);
  if (!Number.isFinite(boundary)) throw new Error("Invalid funded report time");
  if (boundary < Date.parse(initial.lastEventAt))
    throw new Error("Historical funded state precedes account creation");
  let state = initial;
  for (const event of events) {
    if (Date.parse(event.at) > boundary) break;
    state = applyLedgerEvent(state, event, maxMarkAgeMs);
  }
  return state;
}

/**
 * Same economics as {@link replayFundedLedgerAt} with a bounded representation:
 * the duplicate-history cache is trimmed to {@link FUNDED_SNAPSHOT_EVENT_LIMIT}
 * after every applied event, exactly like the live account snapshot, so replay
 * cost is linear in event count instead of quadratic. Sequence order is the
 * durable application order; equal-time events must already arrive in that
 * order. Synthetic callers that cannot prove uniqueness must pre-deduplicate.
 */
export function replayFundedLedgerBounded(
  initial: FundedLedger,
  events: readonly LedgerEvent[],
  at: string,
  maxMarkAgeMs = 30000,
): FundedLedger {
  const boundary = Date.parse(at);
  if (!Number.isFinite(boundary)) throw new Error("Invalid funded report time");
  if (boundary < Date.parse(initial.lastEventAt))
    throw new Error("Historical funded state precedes account creation");
  let state = initial;
  for (const event of events) {
    if (Date.parse(event.at) > boundary) break;
    const next = applyLedgerEvent(state, event, maxMarkAgeMs);
    // An identical retry returns the same state object; trimming is then
    // unnecessary and the existing representation is preserved.
    if (next === state) continue;
    state =
      next.events.length > FUNDED_SNAPSHOT_EVENT_LIMIT
        ? { ...next, events: next.events.slice(-FUNDED_SNAPSHOT_EVENT_LIMIT) }
        : next;
  }
  return state;
}

interface EventSequenceRow {
  readonly event: LedgerEvent;
  readonly event_sequence: number | string;
  readonly event_sequence_verified: boolean;
}

interface CheckpointRow {
  readonly run_id: string;
  readonly boundary_at: Date | string;
  readonly boundary_event_sequence: number | string;
  readonly state: FundedLedger;
}

interface LedgerCheckpointRow {
  readonly event_sequence: number | string;
  readonly boundary_at: Date | string;
  readonly state: FundedLedger;
}

export interface ReconstructFundedLedgerOptions {
  /**
   * Inclusive durable event-sequence cap. A decision boundary proves this
   * cursor, so events after it (including events that share the boundary
   * timestamp) must not appear in the reconstructed state. The caller owns
   * proof of the cursor; a bound that cannot be proven fails closed.
   */
  readonly maxEventSequence?: number;
  /** Override for {@link FUNDED_REPLAY_EVENT_BUDGET}; tests only. */
  readonly maxEvents?: number;
  /** Optional operational observation. Never allowed to change reconstruction
   *  semantics: a throwing observer is ignored. */
  readonly onReconstruction?: (
    observation: FundedReconstructionObservation,
  ) => void;
}

/** Minimal transaction-bound query surface, matching the shared evidence
 * queryable so the reconstruction runs inside the caller's transaction. */
export interface FundedReplayQueryable {
  query<T>(text: string, values?: readonly unknown[]): Promise<{ rows: T[] }>;
}

interface FundedReconstructionProgress {
  pages: number;
  replayedEventCount: number;
  checkpoint: FundedLedgerCheckpoint | null;
}

/**
 * Bounded decision-time ledger reconstruction shared by the FP01 decision
 * capture and funded reporting. It selects the newest provable checkpoint at
 * or before the boundary, fetches only the events after that anchor in durable
 * sequence order, requires verified ordering, replays with the bounded
 * reducer, and fails visibly when the window cannot be proven or exceeds the
 * event budget. It never mutates durable state and never fabricates history:
 * an account without a usable checkpoint replays from its immutable initial
 * state within the budget, and beyond that reconstruction fails closed.
 */
export async function reconstructFundedLedgerAt(
  client: FundedReplayQueryable,
  accountId: string,
  at: string,
  options: ReconstructFundedLedgerOptions = {},
  maxMarkAgeMs = 30000,
): Promise<FundedLedgerReconstruction> {
  const startedAt = performance.now();
  const progress: FundedReconstructionProgress = {
    pages: 0,
    replayedEventCount: 0,
    checkpoint: null,
  };
  const checkpointAgeMs = (): number | null => {
    const boundaryAt = progress.checkpoint?.boundaryAt;
    return boundaryAt ? Date.parse(at) - Date.parse(boundaryAt) : null;
  };
  try {
    const result = await reconstructFundedLedgerAtInternal(
      client,
      accountId,
      at,
      options,
      maxMarkAgeMs,
      progress,
    );
    observeReconstruction(options.onReconstruction, {
      outcome: progress.checkpoint ? "CHECKPOINTED" : "FULL",
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      replayedEventCount: progress.replayedEventCount,
      pages: progress.pages,
      checkpointRunId: progress.checkpoint?.runId ?? null,
      checkpointBoundaryAt: progress.checkpoint?.boundaryAt ?? null,
      checkpointAgeMs: checkpointAgeMs(),
    });
    return result;
  } catch (error) {
    observeReconstruction(options.onReconstruction, {
      outcome: "UNAVAILABLE",
      ...(error instanceof FundedReconstructionUnavailableError
        ? { failureCode: error.code }
        : {}),
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      replayedEventCount: progress.replayedEventCount,
      pages: progress.pages,
      checkpointRunId: progress.checkpoint?.runId ?? null,
      checkpointBoundaryAt: progress.checkpoint?.boundaryAt ?? null,
      checkpointAgeMs: checkpointAgeMs(),
    });
    throw error;
  }
}

async function reconstructFundedLedgerAtInternal(
  client: FundedReplayQueryable,
  accountId: string,
  at: string,
  options: ReconstructFundedLedgerOptions,
  maxMarkAgeMs: number,
  progress: FundedReconstructionProgress,
): Promise<FundedLedgerReconstruction> {
  const boundary = Date.parse(at);
  if (!Number.isFinite(boundary)) throw new Error("Invalid funded report time");
  const budget = options.maxEvents ?? FUNDED_REPLAY_EVENT_BUDGET;
  const maxAnchorSequence = options.maxEventSequence ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(maxAnchorSequence) || maxAnchorSequence < 0)
    throw new Error("Invalid funded reconstruction event bound");

  // Two checkpoint sources share the reconstruction boundary: completed run
  // boundaries (immutable evidence) and generic live ledger checkpoints
  // (run-start and periodic anchors). The newest provable anchor wins.
  const snapshotRow = await client.query<CheckpointRow>(
    `SELECT run_id,boundary_at,boundary_event_sequence,state
       FROM paper_funded_run_snapshot
      WHERE account_id=$1
        AND boundary_at <= $2::timestamptz
        AND boundary_event_sequence IS NOT NULL
        AND boundary_event_sequence <= $3
      ORDER BY boundary_at DESC, boundary_event_sequence DESC
      LIMIT 1`,
    [accountId, at, maxAnchorSequence],
  );
  const ledgerCheckpointRow = await client.query<LedgerCheckpointRow>(
    `SELECT event_sequence,boundary_at,state
       FROM paper_funded_ledger_checkpoint
      WHERE account_id=$1
        AND boundary_at <= $2::timestamptz
        AND event_sequence <= $3
      ORDER BY event_sequence DESC
      LIMIT 1`,
    [accountId, at, maxAnchorSequence],
  );
  const candidates: {
    runId: string | null;
    boundaryAt: string;
    anchorEventSequence: number;
    state: FundedLedger;
  }[] = [];
  const snapshot = snapshotRow.rows[0];
  if (snapshot)
    candidates.push({
      runId: snapshot.run_id,
      boundaryAt: isoTime(snapshot.boundary_at),
      anchorEventSequence: Number(snapshot.boundary_event_sequence),
      state: snapshot.state,
    });
  const ledgerCheckpoint = ledgerCheckpointRow.rows[0];
  if (ledgerCheckpoint)
    candidates.push({
      runId: null,
      boundaryAt: isoTime(ledgerCheckpoint.boundary_at),
      anchorEventSequence: Number(ledgerCheckpoint.event_sequence),
      state: ledgerCheckpoint.state,
    });
  for (const candidate of candidates)
    if (
      !Number.isSafeInteger(candidate.anchorEventSequence) ||
      candidate.anchorEventSequence < 1
    )
      throw new FundedReconstructionUnavailableError(
        "CHECKPOINT_UNPROVEN",
        "Funded reconstruction checkpoint has an invalid event cursor",
      );
  const checkpoint = candidates.sort(
    (left, right) => right.anchorEventSequence - left.anchorEventSequence,
  )[0];
  let anchor: number;
  let initial: FundedLedger;
  let checkpointIdentity: FundedLedgerCheckpoint | null;
  if (checkpoint) {
    anchor = checkpoint.anchorEventSequence;
    initial = checkpoint.state;
    if (
      Date.parse(initial.lastEventAt) > boundary ||
      initial.lastEventAt !== checkpoint.boundaryAt
    )
      throw new FundedReconstructionUnavailableError(
        "CHECKPOINT_UNPROVEN",
        "Funded reconstruction checkpoint does not prove its own boundary",
      );
    checkpointIdentity = {
      runId: checkpoint.runId,
      boundaryAt: checkpoint.boundaryAt,
      anchorEventSequence: anchor,
    };
  } else {
    const account = await client.query<{ initial_state: FundedLedger }>(
      "SELECT initial_state FROM paper_funded_account WHERE id=$1",
      [accountId],
    );
    const pristine = account.rows[0]?.initial_state;
    if (!pristine)
      throw new FundedReconstructionUnavailableError(
        "ACCOUNT_UNAVAILABLE",
        "Funded reconstruction account not found",
      );
    initial = pristine;
    anchor = 0;
    checkpointIdentity = null;
  }
  if (Date.parse(initial.lastEventAt) > boundary)
    throw new FundedReconstructionUnavailableError(
      "BOUNDARY_BEFORE_CREATION",
      "Historical funded state precedes account creation",
    );
  progress.checkpoint = checkpointIdentity;

  let state = initial;
  let lastSequence = anchor;
  let seen = 0;
  for (;;) {
    const page = await client.query<EventSequenceRow>(
      `SELECT event,event_sequence,event_sequence_verified
         FROM paper_funded_event
        WHERE account_id=$1
          AND event_sequence > $2
          AND event_sequence <= $4
          AND (event->>'at')::timestamptz <= $3::timestamptz
        ORDER BY event_sequence
        LIMIT $5`,
      [accountId, lastSequence, at, maxAnchorSequence, FUNDED_REPLAY_PAGE_SIZE],
    );
    if (page.rows.length === 0) break;
    if (
      page.rows.some(
        (row) =>
          !row.event_sequence_verified ||
          !Number.isSafeInteger(Number(row.event_sequence)),
      )
    )
      throw new FundedReconstructionUnavailableError(
        "UNVERIFIED_ORDERING",
        "Historical funded report is unavailable: event order predates temporal sequencing",
      );
    progress.pages += 1;
    lastSequence = Number(page.rows.at(-1)!.event_sequence);
    state = replayFundedLedgerBounded(
      state,
      page.rows.map((row) => row.event),
      at,
      maxMarkAgeMs,
    );
    // The page query already bounds `at`; counting every row it returned,
    // including excluded effects, keeps the budget honest about real work.
    seen += page.rows.length;
    progress.replayedEventCount = seen;
    if (seen > budget)
      throw new FundedReconstructionUnavailableError(
        "BUDGET_EXCEEDED",
        `Funded reconstruction exceeded the ${FUNDED_REPLAY_EVENT_BUDGET} event budget; a newer checkpoint is required`,
      );
    // Defense in depth: a page boundary returns control to the event loop so a
    // long reconstruction cannot block health checks. The checkpoint select,
    // the bounded query and the linear reducer remain the actual fix.
    await new Promise((resolve) => setImmediate(resolve));
  }
  return {
    ledger: state,
    checkpoint: checkpointIdentity,
    replayedEventCount: seen,
    pages: progress.pages,
  };
}

function isoTime(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

export interface FundedLedgerCompactionResult {
  readonly accountId: string;
  readonly previousEventCount: number;
  readonly retainedEventCount: number;
  readonly persistedEventCount: number;
  readonly stateBytes: number;
}

export class PostgresFundedLedgerStore {
  constructor(
    private readonly pool: Pool,
    /** Periodic checkpoint interval override; tests only. */
    private readonly checkpointEventInterval = FUNDED_CHECKPOINT_EVENT_INTERVAL,
  ) {}

  /**
   * Provision an account once, then verify that later process starts still use
   * the same immutable funding contract. Session and event timestamps belong
   * to the first account snapshot only; a new live run rolls the existing
   * ledger through FundedOrderService.bind instead of recreating the account.
   */
  async ensure(
    accountId: string,
    input: Parameters<typeof createFundedLedger>,
  ): Promise<FundedLedger> {
    const expected = createFundedLedger(...input);
    const existing = await this.pool.query<{
      state: FundedLedger;
      initial_state: FundedLedger;
    }>("SELECT state,initial_state FROM paper_funded_account WHERE id=$1", [
      accountId,
    ]);
    const row = existing.rows[0];
    if (row) {
      if (
        row.initial_state.currency !== expected.currency ||
        row.initial_state.cash !== expected.cash ||
        row.initial_state.dailyLossLimit !== expected.dailyLossLimit
      )
        throw new Error("Funded account provisioning is immutable");
      return row.state;
    }
    return this.create(accountId, input);
  }

  async create(
    accountId: string,
    input: Parameters<typeof createFundedLedger>,
  ): Promise<FundedLedger> {
    const initial = createFundedLedger(...input);
    const result = await this.pool.query<{ state: FundedLedger }>(
      `INSERT INTO paper_funded_account(id,initial_state,state) VALUES($1,$2::jsonb,$2::jsonb)
       ON CONFLICT(id) DO UPDATE SET id=EXCLUDED.id
       WHERE paper_funded_account.initial_state=EXCLUDED.initial_state RETURNING state`,
      [accountId, JSON.stringify(initial)],
    );
    if (!result.rows[0])
      throw new Error("Account ID reused with different funding");
    return result.rows[0].state;
  }

  async read(accountId: string): Promise<FundedLedger> {
    const result = await this.pool.query<{ state: FundedLedger }>(
      "SELECT state FROM paper_funded_account WHERE id=$1",
      [accountId],
    );
    if (!result.rows[0]) throw new Error("Funded account not found");
    return result.rows[0].state;
  }

  async applyInTransaction(
    client: PoolClient,
    accountId: string,
    events: readonly LedgerEvent[],
    options: {
      readonly maxMarkAgeMs?: number;
      /** Durable funded fact whose processing produced these events. */
      readonly causeRunId?: string;
      readonly causeFactId?: string;
    } = {},
  ): Promise<FundedLedger> {
    const maxMarkAgeMs = options.maxMarkAgeMs ?? 30000;
    const causeRunId = options.causeRunId ?? null;
    const causeFactId = options.causeFactId ?? null;
    if ((causeRunId === null) !== (causeFactId === null))
      throw new Error("Ledger event cause requires both run and fact identity");
    const result = await client.query<{
      state: FundedLedger;
      events_since_checkpoint: number | string;
    }>(
      "SELECT state,events_since_checkpoint FROM paper_funded_account WHERE id=$1 FOR UPDATE",
      [accountId],
    );
    const initial = result.rows[0]?.state;
    if (!initial) throw new Error("Funded account not found");
    const eventsSinceCheckpoint = Number(
      result.rows[0]?.events_since_checkpoint ?? 0,
    );
    if (
      !Number.isSafeInteger(eventsSinceCheckpoint) ||
      eventsSinceCheckpoint < 0
    )
      throw new Error("Invalid funded checkpoint event count");
    const existingEvents = new Map<
      string,
      {
        event: LedgerEvent;
        causeRunId: string | null;
        causeFactId: string | null;
      }
    >();
    if (events.length > 0) {
      const persisted = await client.query<{
        event_id: string;
        event: LedgerEvent;
        fact_run_id: string | null;
        fact_id: string | null;
      }>(
        "SELECT event_id,event,fact_run_id,fact_id FROM paper_funded_event WHERE account_id=$1 AND event_id=ANY($2::text[])",
        [accountId, [...new Set(events.map((event) => event.id))]],
      );
      for (const row of persisted.rows)
        existingEvents.set(row.event_id, {
          event: row.event,
          causeRunId: row.fact_run_id,
          causeFactId: row.fact_id,
        });
    }
    let state = initial;
    let lastAppliedSequence: number | null = null;
    let appliedEventCount = 0;
    let appliedSessionEvent = false;
    for (const event of events) {
      const persisted = existingEvents.get(event.id);
      if (persisted) {
        if (!isDeepStrictEqual(persisted.event, event))
          throw new Error("Conflicting ledger event retry");
        if (
          persisted.causeRunId !== causeRunId ||
          persisted.causeFactId !== causeFactId
        )
          throw new Error("Conflicting ledger event causal provenance");
        continue;
      }
      const next = applyLedgerEvent(state, event, maxMarkAgeMs);
      if (next !== state) {
        const inserted = await client.query<{
          event_sequence: string | number;
        }>(
          `INSERT INTO paper_funded_event(
             account_id,event_id,event,event_sequence_verified,fact_run_id,fact_id)
           VALUES($1,$2,$3::jsonb,TRUE,$4,$5) RETURNING event_sequence`,
          [accountId, event.id, JSON.stringify(event), causeRunId, causeFactId],
        );
        lastAppliedSequence = Number(inserted.rows[0]?.event_sequence);
        appliedEventCount += 1;
        if (event.type === "SESSION") appliedSessionEvent = true;
        existingEvents.set(event.id, {
          event,
          causeRunId,
          causeFactId,
        });
        state = next;
      }
    }
    if (state !== initial) {
      // Full immutable history and retry identity live in paper_funded_event.
      // Bound the duplicate snapshot cache so every quote does not rewrite an
      // ever-growing history. This is the same representation as compact().
      if (state.events.length > FUNDED_SNAPSHOT_EVENT_LIMIT) {
        const evicted = state.events.slice(0, -FUNDED_SNAPSHOT_EVENT_LIMIT);
        const durable = await client.query<{ event: LedgerEvent }>(
          "SELECT event FROM paper_funded_event WHERE account_id=$1 AND event_id=ANY($2::text[])",
          [accountId, evicted.map((event) => event.id)],
        );
        const verified = new Map(
          durable.rows.map((row) => [row.event.id, row.event]),
        );
        // Legacy snapshots may contain history without a provable durable copy.
        if (
          evicted.every((event) =>
            isDeepStrictEqual(verified.get(event.id), event),
          )
        )
          state = {
            ...state,
            events: state.events.slice(-FUNDED_SNAPSHOT_EVENT_LIMIT),
          };
      }
      // A session rollover is a natural run-start anchor; otherwise anchor
      // every FUNDED_CHECKPOINT_EVENT_INTERVAL applied events. The count is an
      // account-local counter updated in this same transaction, avoiding a
      // growing range count on every quote while still measuring this account
      // rather than gaps in the shared identity sequence. The checkpoint is
      // written from the same transaction as the events it reflects, so its
      // sequence is proven rather than assumed.
      if (lastAppliedSequence !== null) {
        const pendingEventCount = eventsSinceCheckpoint + appliedEventCount;
        const due =
          appliedSessionEvent ||
          pendingEventCount >= this.checkpointEventInterval;
        if (due) {
          await client.query(
            `INSERT INTO paper_funded_ledger_checkpoint(account_id,event_sequence,boundary_at,kind,state)
             VALUES($1,$2,$3::timestamptz,$4,$5::jsonb)
             ON CONFLICT (account_id,event_sequence) DO NOTHING`,
            [
              accountId,
              lastAppliedSequence,
              state.lastEventAt,
              appliedSessionEvent ? "RUN_START" : "PERIODIC",
              JSON.stringify(state),
            ],
          );
          await client.query(
            `UPDATE paper_funded_account
             SET state=$2::jsonb,revision=revision+1,updated_at=now(),
                 checkpoint_sequence=GREATEST(checkpoint_sequence,$3),
                 events_since_checkpoint=0
             WHERE id=$1`,
            [accountId, JSON.stringify(state), lastAppliedSequence],
          );
        } else
          await client.query(
            `UPDATE paper_funded_account
             SET state=$2::jsonb,revision=revision+1,updated_at=now(),
                 events_since_checkpoint=$3
             WHERE id=$1`,
            [accountId, JSON.stringify(state), pendingEventCount],
          );
      }
    }
    return state;
  }

  /**
   * Removes duplicated event payloads from the account snapshot while
   * retaining every event in paper_funded_event for exact retry detection and
   * audit. The account row is locked so compaction cannot race a fill batch.
   */
  async compact(
    accountId: string,
    retainEvents = 0,
  ): Promise<FundedLedgerCompactionResult> {
    if (!Number.isSafeInteger(retainEvents) || retainEvents < 0)
      throw new Error("retainEvents must be a non-negative safe integer");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const account = await client.query<{ state: FundedLedger }>(
        "SELECT state FROM paper_funded_account WHERE id=$1 FOR UPDATE",
        [accountId],
      );
      const current = account.rows[0]?.state;
      if (!current) throw new Error("Funded account not found");
      const retained = current.events.slice(
        Math.max(0, current.events.length - retainEvents),
      );
      const compacted = { ...current, events: retained };
      const updated = await client.query<{
        persistedEventCount: string | number;
        stateBytes: string | number;
      }>(
        `UPDATE paper_funded_account
         SET state=$2::jsonb,revision=revision+1,updated_at=now()
         WHERE id=$1
         RETURNING (SELECT count(*) FROM paper_funded_event WHERE account_id=$1) AS "persistedEventCount",
                   pg_column_size(state) AS "stateBytes"`,
        [accountId, JSON.stringify(compacted)],
      );
      await client.query("COMMIT");
      const row = updated.rows[0];
      if (!row)
        throw new Error("Funded account compaction did not update account");
      return {
        accountId,
        previousEventCount: current.events.length,
        retainedEventCount: retained.length,
        persistedEventCount: Number(row.persistedEventCount),
        stateBytes: Number(row.stateBytes),
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async apply(
    accountId: string,
    events: readonly LedgerEvent[],
    options: {
      readonly maxMarkAgeMs?: number;
      readonly causeRunId?: string;
      readonly causeFactId?: string;
    } = {},
  ): Promise<FundedLedger> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const state = await this.applyInTransaction(
        client,
        accountId,
        events,
        options,
      );
      await client.query("COMMIT");
      return state;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
}
