import { z } from "zod";
import type { FastifyReply } from "fastify";

/** W9: centralizes the "service X is unavailable" 503 pattern that used to be re-typed at the
 * top of every route handler (`if (!options.marketDataService) return reply.code(503)...`).
 * Returns the service when present, or sends a uniform 503 envelope and returns undefined so the
 * caller can `if (!service) return;`. */
export function requireService<T>(
  reply: FastifyReply,
  service: T | undefined,
  label: string,
): T | undefined {
  if (service === undefined) {
    reply.code(503).send({ error: `${label} is unavailable` });
    return undefined;
  }
  return service;
}

/** W9: centralizes limit-querystring validation. Every list route previously repeated the same
 * `Number(...)`, `Number.isInteger`, min/max bounds check with its own inline error message; this
 * keeps that behavior (same parsing, same 400 status, same bounds semantics) but in one place. */
export function parseLimit(
  reply: FastifyReply,
  raw: string | undefined,
  defaultValue: number,
  min: number,
  max: number,
): number | undefined {
  const limit = raw === undefined ? defaultValue : Number(raw);
  if (!Number.isInteger(limit) || limit < min || limit > max) {
    reply
      .code(400)
      .send({ error: `limit must be an integer between ${min} and ${max}` });
    return undefined;
  }
  return limit;
}

export const uuidSchema = z.string().uuid();

export function isValidUuid(value: string): boolean {
  return uuidSchema.safeParse(value).success;
}
