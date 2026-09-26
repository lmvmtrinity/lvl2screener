import type { FastifyInstance } from "fastify";
import {
  marketIdSchema,
  evidenceAutomationStageKeySchema,
  paperEvidenceFiltersSchema,
  strategyLearningScopeSchema,
} from "@tsx-scanner/contracts";
import type { BuildAppOptions } from "../api-types.js";
import { isValidUuid, parseLimit, requireService } from "./shared.js";
import { sendDomainError } from "../errors.js";

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
    Params: { runId: string };
    Querystring: { strategyKey?: string; marketId?: string };
  }>(
    "/api/learning/backtest-runs/:runId/strategy-readiness",
    async (request, reply) => {
      const service = options.learningDashboardService;
      if (!service?.backtestStrategyLearningReadiness)
        return reply
          .code(501)
          .send({ error: "Strategy readiness unavailable" });
      const market = marketIdSchema.safeParse(request.query.marketId);
      const strategyKey = request.query.strategyKey?.trim();
      if (!isValidUuid(request.params.runId) || !market.success || !strategyKey)
        return reply.code(400).send({
          error:
            "A valid run ID, strategyKey and concrete marketId are required",
        });
      try {
        return await service.backtestStrategyLearningReadiness(
          request.params.runId,
          strategyKey,
          market.data,
        );
      } catch (error) {
        return sendDomainError(reply, error);
      }
    },
  );

  app.get<{
    Querystring: {
      marketId?: string;
      strategyKey?: string;
      profileConfigId?: string;
      strategyVersion?: string;
      configVersion?: string;
      executionModelVersion?: string;
      executionAssumptions?: string;
      cutoff?: string;
    };
  }>("/api/learning/strategy-readiness", async (request, reply) => {
    let assumptions: unknown;
    try {
      assumptions = JSON.parse(request.query.executionAssumptions ?? "");
    } catch {
      return reply
        .code(400)
        .send({ error: "executionAssumptions must be JSON" });
    }
    const parsed = strategyLearningScopeSchema.safeParse({
      marketId: request.query.marketId,
      strategyKey: request.query.strategyKey,
      profileConfigId: request.query.profileConfigId,
      strategyVersion: request.query.strategyVersion,
      configVersion: request.query.configVersion,
      executionModelVersion: request.query.executionModelVersion,
      executionAssumptions: assumptions,
    });
    const cutoff = request.query.cutoff;
    if (
      !parsed.success ||
      (cutoff !== undefined && !Number.isFinite(Date.parse(cutoff)))
    )
      return reply.code(400).send({
        error: "A complete strategy scope and valid cutoff are required",
        issues: parsed.success ? undefined : parsed.error.issues,
      });
    const service = requireService(
      reply,
      options.learningDashboardService,
      "Learning dashboard service",
    );
    if (!service) return;
    if (!service.strategyLearningReadiness) {
      return reply.code(501).send({ error: "Strategy readiness unavailable" });
    }
    return service.strategyLearningReadiness(parsed.data, cutoff);
  });

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
