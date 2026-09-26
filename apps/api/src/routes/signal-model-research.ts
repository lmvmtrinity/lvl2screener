import {
  marketIdSchema,
  signalModelResearchAuthorizationRecordSchema,
  signalModelResearchAuthorizationRequestSchema,
  signalModelResearchDispatchSchema,
  signalModelResearchPlanSchema,
  signalModelResearchPreflightSchema,
  signalModelResearchReadinessSchema,
  signalModelResearchReportSchema,
} from "@tsx-scanner/contracts";
import type { FastifyInstance } from "fastify";
import type { BuildAppOptions } from "../api-types.js";
import { requireService, parseLimit, isValidUuid } from "./shared.js";
import { idempotencyKeyFrom } from "./research-jobs.js";

export function registerSignalModelResearchRoutes(
  app: FastifyInstance,
  options: BuildAppOptions,
): void {
  app.post<{ Body: unknown }>(
    "/api/signal-model-research/preflight",
    async (request, reply) => {
      const service = requireService(
        reply,
        options.signalModelResearchService,
        "Signal-model research service",
      );
      if (!service) return;
      const parsed = signalModelResearchPlanSchema.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({
          error: "Invalid frozen model-research plan",
          issues: parsed.error.issues,
        });
      return signalModelResearchPreflightSchema.parse(
        await service.preflight(parsed.data),
      );
    },
  );

  app.post<{ Body: unknown }>(
    "/api/signal-model-research/authorizations",
    async (request, reply) => {
      const service = requireService(
        reply,
        options.signalModelResearchService,
        "Signal-model research service",
      );
      if (!service) return;
      const parsed = signalModelResearchAuthorizationRequestSchema.safeParse(
        request.body,
      );
      if (!parsed.success)
        return reply.code(400).send({
          error: "Invalid model-research authorization",
          issues: parsed.error.issues,
        });
      const key = idempotencyKeyFrom(request);
      if (!key)
        return reply.code(400).send({ error: "Idempotency-Key is required" });
      try {
        return reply
          .code(201)
          .send(
            signalModelResearchAuthorizationRecordSchema.parse(
              await service.authorize(
                parsed.data.authorization,
                parsed.data.plan,
                key,
              ),
            ),
          );
      } catch (error) {
        if (
          error instanceof Error &&
          (error.message.startsWith("SIGNAL_MODEL_") ||
            error.message === "IDEMPOTENCY_KEY_REQUIRED")
        )
          return reply.code(409).send({ error: error.message });
        throw error;
      }
    },
  );

  app.get<{ Querystring: { marketId?: string; limit?: string } }>(
    "/api/signal-model-research/authorizations",
    async (request, reply) => {
      const service = requireService(
        reply,
        options.signalModelResearchService,
        "Signal-model research service",
      );
      if (!service) return;
      const market = marketIdSchema.safeParse(request.query.marketId);
      if (!market.success)
        return reply.code(400).send({ error: "marketId is required" });
      const limit = parseLimit(reply, request.query.limit, 100, 1, 200);
      if (limit === undefined) return;
      return { authorizations: await service.list(market.data, limit) };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/signal-model-research/authorizations/:id",
    async (request, reply) => {
      const service = requireService(
        reply,
        options.signalModelResearchService,
        "Signal-model research service",
      );
      if (!service) return;
      if (!isValidUuid(request.params.id))
        return reply.code(400).send({ error: "Invalid authorization ID" });
      const authorization = await service.get(request.params.id);
      const readiness = await service.readiness(request.params.id);
      if (!authorization || !readiness)
        return reply.code(404).send({ error: "Authorization not found" });
      const report = await service.report(request.params.id);
      return {
        authorization:
          signalModelResearchAuthorizationRecordSchema.parse(authorization),
        readiness: signalModelResearchReadinessSchema.parse(readiness),
        report: report ? signalModelResearchReportSchema.parse(report) : null,
      };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/signal-model-research/authorizations/:id/revoke",
    async (request, reply) => {
      const service = requireService(
        reply,
        options.signalModelResearchService,
        "Signal-model research service",
      );
      if (!service) return;
      if (!isValidUuid(request.params.id))
        return reply.code(400).send({ error: "Invalid authorization ID" });
      const key = idempotencyKeyFrom(request);
      if (!key)
        return reply.code(400).send({ error: "Idempotency-Key is required" });
      const result = await service.revoke(request.params.id, key);
      if (!result)
        return reply.code(404).send({ error: "Authorization not found" });
      return signalModelResearchAuthorizationRecordSchema.parse(result);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/signal-model-research/authorizations/:id/dispatch",
    async (request, reply) => {
      const service = requireService(
        reply,
        options.signalModelResearchService,
        "Signal-model research service",
      );
      if (!service) return;
      if (!isValidUuid(request.params.id))
        return reply.code(400).send({ error: "Invalid authorization ID" });
      const key = idempotencyKeyFrom(request);
      if (!key)
        return reply.code(400).send({ error: "Idempotency-Key is required" });
      try {
        return reply
          .code(202)
          .send(
            signalModelResearchDispatchSchema.parse(
              await service.dispatch(request.params.id, key),
            ),
          );
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("SIGNAL_MODEL_"))
          return reply.code(409).send({ error: error.message });
        throw error;
      }
    },
  );
}
