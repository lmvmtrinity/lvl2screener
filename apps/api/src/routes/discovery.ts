import type { FastifyInstance } from "fastify";
import {
  discoveryExclusionChangeSchema,
  discoveryModeChangeSchema,
  discoveryParityCompareSchema,
  discoveryPreviewSchema,
  discoveryQuerySchema,
  marketIdSchema,
} from "@tsx-scanner/contracts";
import type { BuildAppOptions, DiscoveryApi } from "../api-types.js";

function serviceFor(
  options: BuildAppOptions,
  marketId: "CA_TSX" | "US_EQUITIES",
): DiscoveryApi | undefined {
  return (
    options.discoveryServices?.[marketId] ??
    (marketId === "CA_TSX" ? options.discoveryService : undefined)
  );
}

function parseMarket(
  value: unknown,
  reply: { code(statusCode: number): { send(body: unknown): unknown } },
): "CA_TSX" | "US_EQUITIES" | undefined {
  const parsed = marketIdSchema.safeParse(value);
  if (!parsed.success) {
    reply.code(400).send({ error: "marketId must be CA_TSX or US_EQUITIES" });
    return undefined;
  }
  return parsed.data;
}

function actorFor(request: { ip: string }): string {
  return `operator@${request.ip || "local"}`.slice(0, 200);
}

/** WP4: market-scoped shadow discovery status, history, preview and mode authority. */
export function registerDiscoveryRoutes(
  app: FastifyInstance,
  options: BuildAppOptions,
): void {
  app.get<{ Querystring: { marketId?: string } }>(
    "/api/discovery/status",
    async (request, reply) => {
      const marketId = parseMarket(request.query.marketId, reply);
      if (!marketId) return;
      const service = serviceFor(options, marketId);
      if (!service)
        return reply
          .code(503)
          .send({ error: "Discovery service is unavailable" });
      return service.status(marketId);
    },
  );

  app.get<{
    Querystring: { marketId?: string; limit?: string; before?: string };
  }>("/api/discovery/runs", async (request, reply) => {
    const parsed = discoveryQuerySchema.safeParse(request.query);
    if (!parsed.success)
      return reply.code(400).send({
        error: "Provide a marketId and valid pagination parameters",
        issues: parsed.error.issues,
      });
    const service = serviceFor(options, parsed.data.marketId);
    if (!service)
      return reply
        .code(503)
        .send({ error: "Discovery service is unavailable" });
    const runs = await service.listRuns(parsed.data.marketId, {
      limit: parsed.data.limit,
      before: parsed.data.before,
    });
    return {
      runs,
      nextBefore:
        runs.length === parsed.data.limit
          ? (runs.at(-1)?.evaluationAt ?? null)
          : null,
    };
  });

  app.get<{
    Querystring: {
      marketId?: string;
      runId?: string;
      limit?: string;
      afterExchange?: string;
      afterCode?: string;
    };
  }>("/api/discovery/evaluations", async (request, reply) => {
    const marketId = parseMarket(request.query.marketId, reply);
    if (!marketId) return;
    const query = discoveryQuerySchema.safeParse({
      marketId,
      limit: request.query.limit,
    });
    if (!query.success || !request.query.runId)
      return reply.code(400).send({
        error: "Provide a marketId, runId and valid limit",
        issues: query.success ? [] : query.error.issues,
      });
    const service = serviceFor(options, marketId);
    if (!service)
      return reply
        .code(503)
        .send({ error: "Discovery service is unavailable" });
    const evaluations = await service.listEvaluations(
      marketId,
      request.query.runId,
      {
        limit: query.data.limit,
        after:
          request.query.afterExchange && request.query.afterCode
            ? {
                exchange: request.query.afterExchange,
                code: request.query.afterCode,
              }
            : undefined,
        includeInput: false,
      },
    );
    const last = evaluations.at(-1)?.result;
    return {
      evaluations,
      nextAfter:
        evaluations.length === query.data.limit && last
          ? { exchange: last.providerExchange, code: last.providerCode }
          : null,
    };
  });

  app.post<{ Body: unknown }>(
    "/api/discovery/preview",
    async (request, reply) => {
      const parsed = discoveryPreviewSchema.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({
          error: "Invalid discovery preview request",
          issues: parsed.error.issues,
        });
      const service = serviceFor(options, parsed.data.marketId);
      if (!service)
        return reply
          .code(503)
          .send({ error: "Discovery service is unavailable" });
      const run = await service.preview(
        parsed.data.marketId,
        parsed.data.completedBarEnd,
      );
      if (!run)
        return reply.code(409).send({
          error:
            "Discovery preview could not run outside an active regular session or without provider access",
        });
      return reply.code(201).send(run);
    },
  );

  app.put<{ Body: unknown }>("/api/discovery/mode", async (request, reply) => {
    const parsed = discoveryModeChangeSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({
        error: "Invalid discovery mode change",
        issues: parsed.error.issues,
      });
    if (parsed.data.mode === "AUTO_ADD")
      return reply.code(409).send({
        error:
          "AUTO_ADD is unavailable until market-specific commissioning approval",
      });
    const service = serviceFor(options, parsed.data.marketId);
    if (!service)
      return reply
        .code(503)
        .send({ error: "Discovery service is unavailable" });
    try {
      return await service.changeMode({
        ...parsed.data,
        actor: actorFor(request),
      });
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error as { code?: string }).code === "DISCOVERY_CONTROL_CONFLICT"
      )
        return reply.code(409).send({ error: error.message });
      throw error;
    }
  });

  app.put<{ Body: unknown }>(
    "/api/discovery/exclusion",
    async (request, reply) => {
      const parsed = discoveryExclusionChangeSchema.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({
          error: "Invalid discovery exclusion change",
          issues: parsed.error.issues,
        });
      const service = serviceFor(options, parsed.data.marketId);
      if (!service)
        return reply
          .code(503)
          .send({ error: "Discovery service is unavailable" });
      if (!service.changeExclusion)
        return reply
          .code(503)
          .send({ error: "Discovery intake is unavailable" });
      try {
        await service.changeExclusion({
          ...parsed.data,
          actor: actorFor(request),
        });
        return reply.code(204).send();
      } catch (error) {
        if (error instanceof Error && error.message.includes("selected market"))
          return reply.code(409).send({ error: error.message });
        throw error;
      }
    },
  );

  app.get<{ Querystring: { marketId?: string; limit?: string } }>(
    "/api/discovery/parity",
    async (request, reply) => {
      const marketId = parseMarket(request.query.marketId, reply);
      if (!marketId) return;
      const service = serviceFor(options, marketId);
      if (!service)
        return reply
          .code(503)
          .send({ error: "Discovery service is unavailable" });
      if (!service.parityStatus || !service.listParityAudits)
        return reply
          .code(503)
          .send({ error: "Discovery parity service is unavailable" });

      const limit = request.query.limit
        ? Math.min(
            Math.max(1, Number.parseInt(request.query.limit, 10) || 50),
            200,
          )
        : 50;

      const [status, audits] = await Promise.all([
        service.parityStatus(marketId),
        service.listParityAudits(marketId, limit),
      ]);

      return { status, audits };
    },
  );

  app.post<{ Body: unknown }>(
    "/api/discovery/parity/compare",
    async (request, reply) => {
      const parsed = discoveryParityCompareSchema.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({
          error: "Invalid discovery parity comparison request",
          issues: parsed.error.issues,
        });
      const service = serviceFor(options, parsed.data.marketId);
      if (!service)
        return reply
          .code(503)
          .send({ error: "Discovery service is unavailable" });
      if (!service.compareParity)
        return reply
          .code(503)
          .send({ error: "Discovery parity comparator is unavailable" });

      try {
        const audit = await service.compareParity(
          parsed.data.marketId,
          parsed.data.runId,
        );
        return reply.code(201).send(audit);
      } catch (error) {
        return reply.code(409).send({
          error:
            error instanceof Error
              ? error.message
              : "Discovery parity comparison failed",
        });
      }
    },
  );

  app.get<{ Querystring: { marketId?: string } }>(
    "/api/discovery/fast-funnel",
    async (request, reply) => {
      const marketId = parseMarket(request.query.marketId, reply);
      if (!marketId) return;
      const service = serviceFor(options, marketId);
      if (!service)
        return reply
          .code(503)
          .send({ error: "Discovery service is unavailable" });
      if (!service.fastFunnelStatus)
        return reply
          .code(503)
          .send({ error: "Fast Funnel accelerator is unavailable" });

      return service.fastFunnelStatus(marketId);
    },
  );
}
