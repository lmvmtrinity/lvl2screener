import {
  challengerObservationReportSchema,
  experimentActionSchema,
  marketIdSchema,
  registerChallengerSchema,
} from "@tsx-scanner/contracts";
import type { FastifyInstance } from "fastify";
import type { BuildAppOptions } from "../api-types.js";
import { sendDomainError } from "../errors.js";
import { idempotencyKeyFrom } from "./research-jobs.js";
import { isValidUuid, parseLimit, requireService } from "./shared.js";

export function registerChallengerExperimentRoutes(
  app: FastifyInstance,
  options: BuildAppOptions,
): void {
  app.get<{ Querystring: { marketId?: string; limit?: string } }>(
    "/api/challenger-experiments",
    async (request, reply) => {
      const service = requireService(
        reply,
        options.challengerExperimentService,
        "Challenger experiment service",
      );
      if (!service) return;
      const market = marketIdSchema.safeParse(request.query.marketId);
      if (!market.success)
        return reply.code(400).send({ error: "marketId is required" });
      const limit = parseLimit(reply, request.query.limit, 100, 1, 200);
      if (limit === undefined) return;
      return { experiments: await service.list(market.data, limit) };
    },
  );

  app.get<{ Params: { id: string }; Querystring: { marketId?: string } }>(
    "/api/challenger-experiments/:id",
    async (request, reply) => {
      const service = requireService(
        reply,
        options.challengerExperimentService,
        "Challenger experiment service",
      );
      if (!service) return;
      if (!isValidUuid(request.params.id))
        return reply
          .code(400)
          .send({ error: "Invalid challenger experiment ID" });
      const market = marketIdSchema.safeParse(request.query.marketId);
      if (!market.success)
        return reply.code(400).send({ error: "marketId is required" });
      const experiment = await service.get(request.params.id);
      if (!experiment || experiment.scope.marketId !== market.data)
        return reply
          .code(404)
          .send({ error: "Challenger experiment not found" });
      return experiment;
    },
  );

  app.get<{
    Params: { id: string };
    Querystring: { asOf?: string; marketId?: string };
  }>("/api/challenger-experiments/:id/report", async (request, reply) => {
    const service = requireService(
      reply,
      options.challengerExperimentService,
      "Challenger experiment service",
    );
    if (!service) return;
    if (!isValidUuid(request.params.id))
      return reply
        .code(400)
        .send({ error: "Invalid challenger experiment ID" });
    const market = marketIdSchema.safeParse(request.query.marketId);
    if (!market.success)
      return reply.code(400).send({ error: "marketId is required" });
    const experiment = await service.get(request.params.id);
    if (!experiment || experiment.scope.marketId !== market.data)
      return reply.code(404).send({ error: "Challenger experiment not found" });
    try {
      const report = challengerObservationReportSchema.parse(
        await service.report(request.params.id, request.query.asOf),
      );
      return { experiment, report };
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  app.post<{ Body: unknown }>(
    "/api/challenger-experiments",
    async (request, reply) => {
      const service = requireService(
        reply,
        options.challengerExperimentService,
        "Challenger experiment service",
      );
      if (!service) return;
      const parsed = registerChallengerSchema.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({
          error: "Invalid challenger experiment",
          issues: parsed.error.issues,
        });
      const key = idempotencyKeyFrom(request);
      if (!key)
        return reply.code(400).send({ error: "Idempotency-Key is required" });
      try {
        return reply.code(201).send(await service.register(parsed.data, key));
      } catch (error) {
        return sendDomainError(reply, error);
      }
    },
  );

  app.post<{
    Params: { id: string };
    Body: unknown;
  }>("/api/challenger-experiments/:id/transitions", async (request, reply) => {
    const service = requireService(
      reply,
      options.challengerExperimentService,
      "Challenger experiment service",
    );
    if (!service) return;
    if (!isValidUuid(request.params.id))
      return reply
        .code(400)
        .send({ error: "Invalid challenger experiment ID" });
    const parsed = experimentActionSchema.safeParse(
      (request.body as { action?: unknown } | null)?.action,
    );
    if (!parsed.success)
      return reply
        .code(400)
        .send({ error: "A valid lifecycle action is required" });
    const key = idempotencyKeyFrom(request);
    if (!key)
      return reply.code(400).send({ error: "Idempotency-Key is required" });
    try {
      return await service.transition(request.params.id, parsed.data, key);
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });
}
