export type QuestradeRequestOperation =
  "MAPPING" | "FUNDAMENTALS" | "QUOTE" | "DAILY_HISTORY" | "SLOT_HISTORY";

export type QuestradeRequestPhase =
  "QUEUED" | "DISPATCHED" | "SETTLED" | "HTTP_401_RETRY";

export type QuestradeRequestOutcome =
  "COMPLETED" | "FAILED" | "CANCELLED" | "EXPIRED" | "QUEUE_FULL";

export interface QuestradeRequestObservation {
  attemptId: string;
  operation: QuestradeRequestOperation;
  requestedItems: number;
  phase: QuestradeRequestPhase;
  at: Date;
  outcome?: QuestradeRequestOutcome;
  queueWaitMs?: number;
  executionMs?: number;
}

export interface QuestradeRequestObserver {
  observe(event: QuestradeRequestObservation): void;
}

/** Opaque caller-owned diagnostic identity; no broker request data belongs here. */
export interface QuestradeRequestObservationContext {
  attemptId: string;
  observer: QuestradeRequestObserver;
}

/** Scheduler metadata supplied by the adapter after request shape is known. */
export interface QuestradeScheduledRequestObservation extends QuestradeRequestObservationContext {
  operation: QuestradeRequestOperation;
  requestedItems: number;
}
