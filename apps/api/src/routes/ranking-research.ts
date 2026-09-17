import { createRankingResearchSchema } from "@tsx-scanner/contracts";
import type { FastifyInstance } from "fastify";
import type { BuildAppOptions } from "../api-types.js";
import { sendDomainError } from "../errors.js";
import { requireService, parseLimit, isValidUuid } from "./shared.js";
import { idempotencyKeyFrom } from "./research-jobs.js";

export function registerRankingResearchRoutes(
  app: FastifyInstance,
  options: BuildAppOptions,
): void {
  app.get<{ Querystring: { limit?: string } }>(
    "/api/ranking-research",
    async (request, reply) => {
      const service = requireService(
        reply,
        options.rankingResearchService,
        "Ranking research service",
      );
      if (!service) return;
      const limit = parseLimit(reply, request.query.limit, 50, 1, 100);
      if (limit === undefined) return;
      return { studies: await service.list(limit) };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/ranking-research/:id",
    async (request, reply) => {
      const service = requireService(
        reply,
        options.rankingResearchService,
        "Ranking research service",
      );
      if (!service) return;
      if (!isValidUuid(request.params.id))
        return reply
          .code(400)
          .send({ error: "Invalid ranking research study ID" });
      try {
        return await service.get(request.params.id);
      } catch (error) {
        return sendDomainError(reply, error);
      }
    },
  );

  app.post<{ Body: unknown }>(
    "/api/ranking-research",
    async (request, reply) => {
      const service = requireService(
        reply,
        options.researchJobService,
        "Research job queue",
      );
      if (!service) return;
      const parsed = createRankingResearchSchema.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({
          error: "Invalid ranking research study",
          issues: parsed.error.issues,
        });
      return reply
        .code(202)
        .send(
          await service.createJob(
            "RANKING_RESEARCH",
            parsed.data,
            idempotencyKeyFrom(request),
          ),
        );
    },
  );
}
