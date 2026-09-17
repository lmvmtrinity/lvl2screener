import {
  paperEvidenceFiltersSchema,
  paperJournalProjectionSchema,
  paperPerformanceQuerySchema,
  executionDiagnosticsQuerySchema,
} from "@tsx-scanner/contracts";
import type { FastifyInstance } from "fastify";
import type { BuildAppOptions } from "../api-types.js";
import { sendDomainError } from "../errors.js";
import { parseLimit, requireService } from "./shared.js";

type Query = Record<string, string | undefined> & { limit?: string };
type DiagnosticQuery = Record<string, string | undefined>;

function filters(reply: Parameters<typeof parseLimit>[0], query: Query) {
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

export function registerPaperReportingRoutes(
  app: FastifyInstance,
  options: BuildAppOptions,
): void {
  app.get<{ Querystring: Query }>(
    "/api/paper-bot/activities",
    async (request, reply) => {
      const service = requireService(
        reply,
        options.paperReportingService,
        "Paper reporting service",
      );
      if (!service) return;
      const value = filters(reply, request.query);
      const limit = parseLimit(reply, request.query.limit, 100, 1, 500);
      if (!value || limit === undefined) return;
      return { activities: await service.listActivities(value, limit) };
    },
  );
  app.get<{ Querystring: Query }>(
    "/api/paper-bot/runs",
    async (request, reply) => {
      const service = requireService(
        reply,
        options.paperReportingService,
        "Paper reporting service",
      );
      if (!service) return;
      const value = filters(reply, request.query);
      const limit = parseLimit(reply, request.query.limit, 100, 1, 500);
      if (!value || limit === undefined) return;
      return { runs: await service.listRuns(value, limit) };
    },
  );
  app.get<{ Params: { id: string }; Querystring: DiagnosticQuery }>(
    "/api/paper-bot/runs/:id/execution-diagnostics",
    async (request, reply) => {
      const service = requireService(
        reply,
        options.fundedReportingService,
        "Funded reporting service",
      );
      if (!service) return;
      const parsed = executionDiagnosticsQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        reply.code(400).send({
          error: "Invalid execution diagnostics query",
          issues: parsed.error.issues,
        });
        return;
      }
      const diagnosticRequest =
        parsed.data.mode === "AS_OF"
          ? {
              mode: "AS_OF" as const,
              at: parsed.data.asOf!,
              marketId: parsed.data.marketId,
            }
          : { mode: parsed.data.mode, marketId: parsed.data.marketId };
      try {
        return await service.getExecutionDiagnostics(
          request.params.id,
          diagnosticRequest,
        );
      } catch (error) {
        if (error instanceof Error) {
          const status =
            error.message === "EXECUTION_DIAGNOSTIC_MARKET_MISMATCH"
              ? 409
              : error.message ===
                  "EXECUTION_DIAGNOSTIC_MARKET_CURRENCY_MISMATCH"
                ? 409
                : error.message === "Run has no funded account binding"
                  ? 404
                  : error.message.includes("after the completed run boundary")
                    ? 422
                    : undefined;
          if (status)
            return reply.code(status).send({
              error: error.message,
              code: error.message,
            });
        }
        return sendDomainError(reply, error);
      }
    },
  );
  app.get<{ Querystring: Query }>(
    "/api/paper-bot/commission-sensitivity",
    async (request, reply) => {
      const service = requireService(
        reply,
        options.paperReportingService,
        "Paper reporting service",
      );
      if (!service) return;
      const { commissions, ...rest } = request.query;
      const value = filters(reply, rest);
      if (!value) return;
      const scenarios =
        commissions === undefined
          ? undefined
          : commissions.split(",").map((entry) => Number(entry.trim()));
      if (scenarios?.some((entry) => Number.isNaN(entry))) {
        reply.code(400).send({
          error: "Invalid commission scenarios",
          issues: [
            {
              message: "commissions must be a comma-separated list of amounts",
            },
          ],
        });
        return;
      }
      try {
        return {
          sensitivities: await service.commissionSensitivity(value, scenarios),
        };
      } catch (error) {
        return sendDomainError(reply, error);
      }
    },
  );
  app.get<{ Querystring: Query }>(
    "/api/paper-bot/coordination/decisions",
    async (request, reply) => {
      const service = requireService(
        reply,
        options.paperReportingService,
        "Paper reporting service",
      );
      if (!service) return;
      const value = filters(reply, request.query);
      const limit = parseLimit(reply, request.query.limit, 200, 1, 500);
      if (!value || limit === undefined) return;
      return { decisions: await service.coordinationDecisions(value, limit) };
    },
  );
  app.get<{ Querystring: Query }>(
    "/api/paper-bot/coordination/summary",
    async (request, reply) => {
      const service = requireService(
        reply,
        options.paperReportingService,
        "Paper reporting service",
      );
      if (!service) return;
      const value = filters(reply, request.query);
      if (!value) return;
      return { summary: await service.coordinationSummary(value) };
    },
  );
  app.get<{ Querystring: Query }>(
    "/api/paper-bot/observations",
    async (request, reply) => {
      const service = requireService(
        reply,
        options.paperReportingService,
        "Paper reporting service",
      );
      if (!service) return;
      const value = filters(reply, request.query);
      const limit = parseLimit(reply, request.query.limit, 200, 1, 500);
      if (!value || limit === undefined) return;
      return { observations: await service.listObservations(value, limit) };
    },
  );
  app.get<{ Querystring: Query }>(
    "/api/paper-bot/executions",
    async (request, reply) => {
      const service = requireService(
        reply,
        options.paperReportingService,
        "Paper reporting service",
      );
      if (!service) return;
      const value = filters(reply, request.query);
      const limit = parseLimit(reply, request.query.limit, 200, 1, 500);
      if (!value || limit === undefined) return;
      return { executions: await service.listExecutions(value, limit) };
    },
  );
  app.get<{ Querystring: Query }>(
    "/api/paper-bot/journal",
    async (request, reply) => {
      // The projection is not an evidence filter: it selects which ledger is
      // being read, and one ledger is served per request (ADR-010). FUNDED is
      // owned by the funded reporting service; the shadow projections belong
      // to the paper reporting service.
      const { projection, ...rest } = request.query;
      const value = filters(reply, rest);
      const limit = parseLimit(reply, request.query.limit, 200, 1, 500);
      if (!value || limit === undefined) return;
      const selected = paperJournalProjectionSchema.safeParse(
        projection ?? "COORDINATED",
      );
      if (!selected.success) {
        reply.code(400).send({
          error: "Invalid journal projection",
          issues: selected.error.issues,
        });
        return;
      }
      if (selected.data === "FUNDED") {
        const funded = requireService(
          reply,
          options.fundedReportingService,
          "Funded reporting service",
        );
        if (!funded) return;
        return funded.journal(value, limit);
      }
      const service = requireService(
        reply,
        options.paperReportingService,
        "Paper reporting service",
      );
      if (!service) return;
      return service.journal(value, selected.data, limit);
    },
  );
  app.get<{ Querystring: Query }>(
    "/api/paper-bot/aggregates",
    async (request, reply) => {
      const service = requireService(
        reply,
        options.paperReportingService,
        "Paper reporting service",
      );
      if (!service) return;
      const value = filters(reply, request.query);
      if (!value) return;
      return { aggregates: await service.aggregates(value) };
    },
  );
  app.get<{ Querystring: Query }>(
    "/api/paper-bot/curves",
    async (request, reply) => {
      const service = requireService(
        reply,
        options.paperReportingService,
        "Paper reporting service",
      );
      if (!service) return;
      const value = filters(reply, request.query);
      if (!value) return;
      return { points: await service.curves(value) };
    },
  );
  app.get<{ Querystring: Query }>(
    "/api/paper-bot/performance",
    async (request, reply) => {
      const parsed = paperPerformanceQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        reply.code(400).send({
          error: "Invalid performance curve query",
          issues: parsed.error.issues,
        });
        return;
      }
      // The account selects one ledger owner. It is never a filter value that
      // both services could interpret differently, and the two curves are
      // never combined in one response (ADR-010).
      const { startDate, endDate, granularity, account, ...filters } =
        parsed.data;
      if (account === "FUNDED") {
        const funded = requireService(
          reply,
          options.fundedReportingService,
          "Funded reporting service",
        );
        if (!funded) return;
        return funded.performanceCurve(
          filters.marketId,
          { startDate, endDate },
          filters.source,
        );
      }
      const service = requireService(
        reply,
        options.paperReportingService,
        "Paper reporting service",
      );
      if (!service) return;
      return service.performanceCurve(
        filters,
        { startDate, endDate },
        granularity,
      );
    },
  );
  app.get<{ Querystring: Query }>(
    "/api/paper-bot/qualifications",
    async (request, reply) => {
      const service = requireService(
        reply,
        options.paperReportingService,
        "Paper reporting service",
      );
      if (!service) return;
      const value = filters(reply, request.query);
      if (!value) return;
      return { qualifications: await service.qualifications(value) };
    },
  );
  app.get<{ Querystring: Query }>(
    "/api/paper-bot/divergences",
    async (request, reply) => {
      const service = requireService(
        reply,
        options.paperReportingService,
        "Paper reporting service",
      );
      if (!service) return;
      const value = filters(reply, request.query);
      if (!value) return;
      return { divergences: await service.divergences(value) };
    },
  );
  app.get<{ Querystring: Query }>(
    "/api/paper-bot/comparisons",
    async (request, reply) => {
      const service = requireService(
        reply,
        options.paperReportingService,
        "Paper reporting service",
      );
      if (!service) return;
      const value = filters(reply, request.query);
      if (!value) return;
      try {
        return { comparisons: await service.comparisons(value) };
      } catch (error) {
        return sendDomainError(reply, error);
      }
    },
  );
}
