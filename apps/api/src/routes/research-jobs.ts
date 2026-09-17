import type { FastifyInstance } from "fastify";
import type { BuildAppOptions } from "../api-types.js";
import { requireService, isValidUuid } from "./shared.js";

/** W8: an `Idempotency-Key` header lets a client that never saw the 202 response (dropped
 * connection, retried submit) fetch the job it already created instead of enqueueing a duplicate
 * run. Fastify lower-cases header names. */
export function idempotencyKeyFrom(request: {
  headers: Record<string, unknown>;
}): string | undefined {
  const value = request.headers["idempotency-key"];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function registerResearchJobRoutes(
  app: FastifyInstance,
  options: BuildAppOptions,
): void {
  app.get<{ Params: { id: string } }>(
    "/api/research-jobs/:id",
    async (request, reply) => {
      const service = requireService(
        reply,
        options.researchJobService,
        "Research job queue",
      );
      if (!service) return;
      if (!isValidUuid(request.params.id))
        return reply.code(400).send({ error: "Invalid research job ID" });
      const job = await service.get(request.params.id);
      if (!job)
        return reply.code(404).send({ error: "Research job not found" });
      return job;
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/research-jobs/:id/cancel",
    async (request, reply) => {
      const service = requireService(
        reply,
        options.researchJobService,
        "Research job queue",
      );
      if (!service) return;
      if (!isValidUuid(request.params.id))
        return reply.code(400).send({ error: "Invalid research job ID" });
      const job = await service.requestCancellation(request.params.id);
      if (!job)
        return reply.code(404).send({ error: "Research job not found" });
      return job;
    },
  );
}
