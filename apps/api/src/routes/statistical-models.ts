import {
  createStatisticalModelSchema,
  strategyEvaluationSchema,
} from "@tsx-scanner/contracts";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { BuildAppOptions } from "../api-types.js";
import { sendDomainError } from "../errors.js";
import { requireService, parseLimit, isValidUuid } from "./shared.js";
import { idempotencyKeyFrom } from "./research-jobs.js";

export function registerStatisticalModelRoutes(
  app: FastifyInstance,
  options: BuildAppOptions,
): void {
  app.get(
    "/api/statistical-models/forward-monitoring",
    async (_request, reply) => {
      const service = requireService(
        reply,
        options.predictionMonitoringService,
        "Prediction monitoring service",
      );
      if (!service) return;
      return { monitoring: await service.monitoring() };
    },
  );
  app.get(
    "/api/statistical-models/paper-evidence/cohorts",
    async (_request, reply) => {
      const service = requireService(
        reply,
        options.paperEvidenceTrainingService,
        "Paper evidence training service",
      );
      if (!service) return;
      return { cohorts: await service.listCohorts() };
    },
  );

  app.get<{ Querystring: { limit?: string } }>(
    "/api/statistical-models",
    async (request, reply) => {
      const service = requireService(
        reply,
        options.statisticalModelService,
        "Statistical model service",
      );
      if (!service) return;
      const limit = parseLimit(reply, request.query.limit, 50, 1, 100);
      if (limit === undefined) return;
      return { models: await service.list(limit) };
    },
  );

  app.post<{ Body: unknown }>(
    "/api/statistical-models",
    async (request, reply) => {
      const service = requireService(
        reply,
        options.researchJobService,
        "Research job queue",
      );
      if (!service) return;
      const parsed = createStatisticalModelSchema.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({
          error: "Invalid statistical model",
          issues: parsed.error.issues,
        });
      return reply
        .code(202)
        .send(
          await service.createJob(
            "STATISTICAL_TRAINING",
            parsed.data,
            idempotencyKeyFrom(request),
          ),
        );
    },
  );

  app.get(
    "/api/statistical-models/active/predictions",
    async (_request, reply) => {
      const service = requireService(
        reply,
        options.statisticalModelService,
        "Statistical model service",
      );
      if (!service) return;
      const evaluations = z
        .array(strategyEvaluationSchema)
        .parse(options.marketDataService?.getCandidates?.() ?? []);
      return service.activePredictions(evaluations);
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/statistical-models/:id/predictions",
    async (request, reply) => {
      const service = requireService(
        reply,
        options.statisticalModelService,
        "Statistical model service",
      );
      if (!service) return;
      if (!isValidUuid(request.params.id))
        return reply.code(400).send({ error: "Invalid statistical model ID" });
      try {
        const evaluations = z
          .array(strategyEvaluationSchema)
          .parse(options.marketDataService?.getCandidates?.() ?? []);
        return await service.predictions(request.params.id, evaluations);
      } catch (error) {
        return sendDomainError(reply, error);
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/statistical-models/:id/activate",
    async (request, reply) => {
      const service = requireService(
        reply,
        options.statisticalModelService,
        "Statistical model service",
      );
      if (!service) return;
      if (!isValidUuid(request.params.id))
        return reply.code(400).send({ error: "Invalid statistical model ID" });
      try {
        return await service.activate(request.params.id);
      } catch (error) {
        return sendDomainError(reply, error);
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/statistical-models/:id/deactivate",
    async (request, reply) => {
      const service = requireService(
        reply,
        options.statisticalModelService,
        "Statistical model service",
      );
      if (!service) return;
      if (!isValidUuid(request.params.id))
        return reply.code(400).send({ error: "Invalid statistical model ID" });
      try {
        return await service.deactivate(request.params.id);
      } catch (error) {
        return sendDomainError(reply, error);
      }
    },
  );

  // @supported (decision-gated, defaulted per private development record W10):
  // GET /api/statistical-models/:id is a supported resource API. Keep while that remains true;
  // remove only if the list objects returned by GET /api/statistical-models become complete
  // enough that detail is deliberately left unsupported. No removal decision was recorded, so
  // the default is keep. Covered by apps/api/tests/statistical-model-api.test.ts.
  app.get<{ Params: { id: string } }>(
    "/api/statistical-models/:id",
    async (request, reply) => {
      const service = requireService(
        reply,
        options.statisticalModelService,
        "Statistical model service",
      );
      if (!service) return;
      if (!isValidUuid(request.params.id))
        return reply.code(400).send({ error: "Invalid statistical model ID" });
      try {
        return await service.get(request.params.id);
      } catch (error) {
        return sendDomainError(reply, error);
      }
    },
  );
}
