import type { FastifyInstance } from "fastify";
import {
  marketIdSchema,
  evidenceAutomationStageKeySchema,
  paperEvidenceFiltersSchema,
} from "@tsx-scanner/contracts";
import type { BuildAppOptions } from "../api-types.js";
import { parseLimit, requireService } from "./shared.js";

type Query = Record<string, string | undefined> & { limit?: string };

function parseFilters(reply: Parameters<typeof parseLimit>[0], query: Query) {
  const { limit: _limit, ...raw } = query;
  const parsed = paperEvidenceFiltersSchema.safeParse(raw);
  if (!parsed.success) {
    reply.code(400).send({
      error: "Invalid paper-evidence filters",
      issues: parsed.error.issues,
    });
    return undefined;
  }
  return parsed.data;
}

export function registerLearningRoutes(
  app: FastifyInstance,
  options: BuildAppOptions,
): void {
  app.get<{
    Params: { kind: string; id: string };
    Querystring: { marketId?: string };
  }>("/api/learning/evidence-artifacts/:kind/:id", async (request, reply) => {
    const market = marketIdSchema.safeParse(request.query.marketId);
    const kind = evidenceAutomationStageKeySchema.safeParse(
      request.params.kind,
    );
    if (
      !market.success ||
      !kind.success ||
      !/^([a-f0-9]{64}|[a-f0-9-]{36})$/i.test(request.params.id)
    )
      return reply.code(400).send({
        error: "A valid artifact, stage and concrete market are required",
      });
    const service = options.learningDashboardService;
    if (!service?.evidenceArtifact)
      return reply.code(501).send({ error: "Evidence details unavailable" });
    const artifact = await service.evidenceArtifact(
      kind.data,
      request.params.id,
      market.data,
    );
    return (
      artifact ??
      reply
        .code(404)
        .send({ error: "Retained artifact not found in this market" })
    );
  });

  app.get("/api/learning/overview", async (_request, reply) => {
    const service = requireService(
      reply,
      options.learningDashboardService,
      "Learning dashboard service",
    );
    if (!service) return;
    return await service.overview();
  });

  app.get<{ Querystring: { marketId?: string } }>(
    "/api/learning/evidence-automation",
    async (request, reply) => {
      const service = requireService(
        reply,
        options.learningDashboardService,
        "Learning dashboard service",
      );
      if (!service?.evidenceAutomation) {
        if (service)
          reply.code(501).send({ error: "Evidence automation service" });
        return;
      }
      const parsed = marketIdSchema.safeParse(request.query.marketId);
      if (!parsed.success) {
        reply.code(400).send({ error: "A concrete marketId is required" });
        return;
      }
      return { stages: await service.evidenceAutomation(parsed.data) };
    },
  );

  app.get<{ Querystring: { limit?: string } }>(
    "/api/learning/automation-runs",
    async (request, reply) => {
      const service = requireService(
        reply,
        options.learningDashboardService,
        "Learning dashboard service",
      );
      if (!service) return;
      const limit = parseLimit(reply, request.query.limit, 50, 1, 200);
      if (limit === undefined) return;
      return { runs: await service.automationRuns(limit) };
    },
  );

  app.get<{ Querystring: Query }>(
    "/api/learning/coordination-decisions",
    async (request, reply) => {
      const reporting = requireService(
        reply,
        options.paperReportingService,
        "Paper reporting service",
      );
      if (!reporting) return;
      const filters = parseFilters(reply, request.query);
      if (!filters) return;
      const limit = parseLimit(reply, request.query.limit, 200, 1, 500);
      if (limit === undefined) return;
      return {
        decisions: await reporting.coordinationDecisions(filters, limit),
      };
    },
  );
}
