/** W9: one DomainError model carrying an HTTP status and a stable machine-readable code, so
 * route handlers stop hand-mapping `error.code` to a status per vertical. Each domain's error
 * class (BacktestError, ProfileError, CalibrationError, StatisticalModelError,
 * RankingResearchError) extends this and computes its own `status` from its `code` at
 * construction time — the mapping lives next to the code enum it interprets, not scattered
 * across app.ts. */
export type DomainErrorStatus = 400 | 404 | 409 | 422 | 502;

export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: DomainErrorStatus,
    readonly issues?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }

  /** The uniform error envelope: `{ error, code }`, plus `issues` when present. Every route's
   * catch block sends this same shape for every DomainError, so error envelopes are uniform
   * across verticals. */
  toResponse(): { error: string; code: string; issues?: unknown } {
    return this.issues === undefined
      ? { error: this.message, code: this.code }
      : { error: this.message, code: this.code, issues: this.issues };
  }
}

/** Shared reply type covering the subset of Fastify's reply used by route helpers below. */
export interface DomainErrorReply {
  code(statusCode: number): { send(payload: unknown): unknown };
}

/** Sends the uniform DomainError envelope if `error` is one; otherwise rethrows so Fastify's
 * default error handler logs and reports it as a 500. Use in every route catch block instead of
 * a per-route `instanceof` check. */
export function sendDomainError(
  reply: DomainErrorReply,
  error: unknown,
): unknown {
  if (error instanceof DomainError)
    return reply.code(error.status).send(error.toResponse());
  throw error;
}
