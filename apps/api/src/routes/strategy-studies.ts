import {
  executableFrozenStudyPlanSchema,
  marketIdSchema,
  studyAuthorizationRequestSchema,
  studyAuthorizationRecordSchema,
  strategyStudyReportSchema,
} from "@tsx-scanner/contracts";
import type { FastifyInstance } from "fastify";
import type { BuildAppOptions } from "../api-types.js";
import { requireService, parseLimit, isValidUuid } from "./shared.js";
import { idempotencyKeyFrom } from "./research-jobs.js";

export function registerStrategyStudyRoutes(
  app: FastifyInstance,
  options: BuildAppOptions,
): void {
  app.post<{ Body: unknown }>(
    "/api/strategy-studies",
    async (request, reply) => {
      const service = requireService(
        reply,
        options.strategyStudyService,
        "Strategy study service",
      );
      if (!service) return;
      const parsed = executableFrozenStudyPlanSchema.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({
          error: "Invalid frozen strategy study",
          issues: parsed.error.issues,
        });
      const key = idempotencyKeyFrom(request);
      if (!key)
        return reply.code(400).send({ error: "Idempotency-Key is required" });
      try {
        return reply.code(202).send(await service.create(parsed.data, key));
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "RESEARCH_JOB_IDEMPOTENCY_CONFLICT"
        )
          return reply.code(409).send({ error: error.message });
        if (
          error instanceof Error &&
          error.message === "RESEARCH_RUNTIME_UNAVAILABLE"
        )
          return reply.code(503).send({ error: error.message });
        if (
          error instanceof Error &&
          (error.message.startsWith("STUDY_") ||
            error.message === "COVERAGE_NOT_VERIFIED")
        )
          return reply.code(409).send({ error: error.message });
        throw error;
      }
    },
  );

  app.get<{ Querystring: { marketId?: string; limit?: string } }>(
    "/api/strategy-studies",
    async (request, reply) => {
      const service = requireService(
        reply,
        options.strategyStudyService,
        "Strategy study service",
      );
      if (!service) return;
      const market = marketIdSchema.safeParse(request.query.marketId);
      if (!market.success)
        return reply.code(400).send({ error: "marketId is required" });
      const limit = parseLimit(reply, request.query.limit, 100, 1, 200);
      if (limit === undefined) return;
      return { studies: await service.list(market.data, limit) };
    },
  );

  app.get<{ Querystring: { marketId?: string; limit?: string } }>(
    "/api/strategy-studies/authorizations",
    async (request, reply) => {
      const service = requireService(
        reply,
        options.strategyStudyService,
        "Strategy study service",
      );
      if (!service) return;
      const market = marketIdSchema.safeParse(request.query.marketId);
      if (!market.success)
        return reply.code(400).send({ error: "marketId is required" });
      const limit = parseLimit(reply, request.query.limit, 100, 1, 200);
      if (limit === undefined) return;
      return {
        authorizations: await service.listAuthorizations(market.data, limit),
      };
    },
  );

  app.get<{ Params: { id: string }; Querystring: { marketId?: string } }>(
    "/api/strategy-studies/:id",
    async (request, reply) => {
      const service = requireService(
        reply,
        options.strategyStudyService,
        "Strategy study service",
      );
      if (!service) return;
      if (!isValidUuid(request.params.id))
        return reply.code(400).send({ error: "Invalid strategy study ID" });
      const market = marketIdSchema.safeParse(request.query.marketId);
      if (!market.success)
        return reply.code(400).send({ error: "marketId is required" });
      const study = await service.get(request.params.id);
      if (!study || study.marketId !== market.data)
        return reply.code(404).send({ error: "Strategy study not found" });
      if (study.report) strategyStudyReportSchema.parse(study.report);
      return study;
    },
  );

  app.post<{ Body: unknown }>(
    "/api/strategy-studies/authorizations",
    async (request, reply) => {
      const service = requireService(
        reply,
        options.strategyStudyService,
        "Strategy study service",
      );
      if (!service) return;
      const parsed = studyAuthorizationRequestSchema.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({
          error: "Invalid study authorization",
          issues: parsed.error.issues,
        });
      const key = idempotencyKeyFrom(request);
      if (!key)
        return reply.code(400).send({ error: "Idempotency-Key is required" });
      try {
        const saved = await service.createAuthorization(
          parsed.data.authorization,
          parsed.data.plan,
          key,
        );
        return reply
          .code(201)
          .send(studyAuthorizationRecordSchema.parse(saved));
      } catch (error) {
        if (error instanceof Error && error.message.endsWith("CONFLICT"))
          return reply.code(409).send({ error: error.message });
        if (
          error instanceof Error &&
          error.message === "RESEARCH_RUNTIME_UNAVAILABLE"
        )
          return reply.code(503).send({ error: error.message });
        if (
          error instanceof Error &&
          (error.message.startsWith("STUDY_") ||
            error.message === "COVERAGE_NOT_VERIFIED")
        )
          return reply.code(409).send({ error: error.message });
        throw error;
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/strategy-studies/authorizations/:id/revoke",
    async (request, reply) => {
      const service = requireService(
        reply,
        options.strategyStudyService,
        "Strategy study service",
      );
      if (!service) return;
      if (!isValidUuid(request.params.id))
        return reply.code(400).send({ error: "Invalid authorization ID" });
      const key = idempotencyKeyFrom(request);
      if (!key)
        return reply.code(400).send({ error: "Idempotency-Key is required" });
      const saved = await service.revokeAuthorization(request.params.id, key);
      if (!saved)
        return reply.code(404).send({ error: "Authorization not found" });
      return studyAuthorizationRecordSchema.parse(saved);
    },
  );
}
