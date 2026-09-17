import {
  createBacktestSchema,
  createFundedHistoricalAutomationPolicySchema,
  marketIdSchema,
  revokeFundedHistoricalAutomationPolicySchema,
} from "@tsx-scanner/contracts";
import type { FastifyInstance } from "fastify";
import type { BuildAppOptions } from "../api-types.js";
import { sendDomainError } from "../errors.js";
import { nextEasternBoundary } from "../statistical-models/daily-learning-schedule.js";
import { requireService, parseLimit, isValidUuid } from "./shared.js";
import { idempotencyKeyFrom } from "./research-jobs.js";

function marketFromQuery(
  raw: string | undefined,
): "CA_TSX" | "US_EQUITIES" | undefined {
  const parsed = marketIdSchema.safeParse(raw ?? "CA_TSX");
  return parsed.success ? parsed.data : undefined;
}

export function registerBacktestRoutes(
  app: FastifyInstance,
  options: BuildAppOptions,
): void {
  app.get<{ Querystring: { marketId?: string } }>(
    "/api/backtest-automation/status",
    async (request, reply) => {
      const service = requireService(
        reply,
        options.backtestAutomationService,
        "Backtest automation",
      );
      if (!service) return;
      const market = marketFromQuery(request.query.marketId);
      if (!market)
        return reply
          .code(400)
          .send({ error: "marketId must be CA_TSX or US_EQUITIES" });
      return service.status(market, {
        nextCheckAt: nextEasternBoundary(new Date(), "17:00").toISOString(),
      });
    },
  );

  app.post<{ Querystring: { marketId?: string } }>(
    "/api/backtest-automation/refresh",
    async (request, reply) => {
      const service = requireService(
        reply,
        options.backtestAutomationService,
        "Backtest automation",
      );
      if (!service) return;
      const market = marketFromQuery(request.query.marketId);
      if (!market)
        return reply
          .code(400)
          .send({ error: "marketId must be CA_TSX or US_EQUITIES" });
      try {
        return reply.code(202).send(await service.refreshNow(market));
      } catch (error) {
        return sendDomainError(reply, error);
      }
    },
  );

  app.post<{ Querystring: { marketId?: string } }>(
    "/api/backtest-automation/check",
    async (request, reply) => {
      const service = requireService(
        reply,
        options.backtestAutomationService,
        "Backtest automation",
      );
      if (!service) return;
      const market = marketFromQuery(request.query.marketId);
      if (!market)
        return reply
          .code(400)
          .send({ error: "marketId must be CA_TSX or US_EQUITIES" });
      try {
        return reply.code(202).send(await service.checkNow(market));
      } catch (error) {
        return sendDomainError(reply, error);
      }
    },
  );

  app.get<{ Querystring: { marketId?: string } }>(
    "/api/captured-history/availability",
    async (request, reply) => {
      if (!options.backtestService?.getCapturedHistoryAvailability)
        return reply
          .code(503)
          .send({ error: "Captured-history availability is unavailable" });
      const market = marketIdSchema.safeParse(
        request.query.marketId ?? "CA_TSX",
      );
      if (!market.success)
        return reply
          .code(400)
          .send({ error: "marketId must be CA_TSX or US_EQUITIES" });
      return options.backtestService.getCapturedHistoryAvailability(
        market.data,
      );
    },
  );

  app.get<{ Querystring: { marketId?: string } }>(
    "/api/funded-historical-policies",
    async (request, reply) => {
      const service = requireService(
        reply,
        options.fundedHistoricalPolicyService,
        "Funded historical policy service",
      );
      if (!service) return;
      const market = marketFromQuery(request.query.marketId);
      if (!market)
        return reply
          .code(400)
          .send({ error: "marketId must be CA_TSX or US_EQUITIES" });
      return { policies: await service.listPolicies(market) };
    },
  );

  app.post<{ Body: unknown }>(
    "/api/funded-historical-policies",
    async (request, reply) => {
      const service = requireService(
        reply,
        options.fundedHistoricalPolicyService,
        "Funded historical policy service",
      );
      if (!service) return;
      const parsed = createFundedHistoricalAutomationPolicySchema.safeParse(
        request.body,
      );
      if (!parsed.success)
        return reply.code(400).send({
          error: "Invalid funded historical policy approval",
          issues: parsed.error.issues,
        });
      try {
        return reply.code(201).send(await service.requestPolicy(parsed.data));
      } catch (error) {
        return reply.code(422).send({
          error: error instanceof Error ? error.message : "Policy rejected",
        });
      }
    },
  );

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/api/funded-historical-policies/:id/revoke",
    async (request, reply) => {
      const service = requireService(
        reply,
        options.fundedHistoricalPolicyService,
        "Funded historical policy service",
      );
      if (!service) return;
      if (!isValidUuid(request.params.id))
        return reply.code(400).send({ error: "Invalid policy ID" });
      const parsed = revokeFundedHistoricalAutomationPolicySchema.safeParse(
        request.body,
      );
      if (!parsed.success)
        return reply.code(400).send({
          error: "Invalid revocation",
          issues: parsed.error.issues,
        });
      const revoked = await service.revokePolicy(
        request.params.id,
        parsed.data,
      );
      if (!revoked) return reply.code(404).send({ error: "Policy not found" });
      return revoked;
    },
  );

  app.get<{ Querystring: { limit?: string } }>(
    "/api/backtests",
    async (request, reply) => {
      const service = requireService(
        reply,
        options.backtestService,
        "Backtest service",
      );
      if (!service) return;
      const requested = parseLimit(reply, request.query.limit, 100, 1, 200);
      if (requested === undefined) return;
      return { runs: await service.listRuns(requested) };
    },
  );

  app.get<{ Querystring: { ids?: string } }>(
    "/api/backtests/compare",
    async (request, reply) => {
      const service = requireService(
        reply,
        options.backtestService,
        "Backtest service",
      );
      if (!service) return;
      const ids = (request.query.ids ?? "").split(",").filter(Boolean);
      if (
        ids.length < 2 ||
        ids.length > 10 ||
        ids.some((id) => !isValidUuid(id))
      ) {
        return reply.code(400).send({
          error: "ids must contain between 2 and 10 comma-separated run UUIDs",
        });
      }
      try {
        return await service.compare(ids);
      } catch (error) {
        return sendDomainError(reply, error);
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/backtests/:id",
    async (request, reply) => {
      const service = requireService(
        reply,
        options.backtestService,
        "Backtest service",
      );
      if (!service) return;
      if (!isValidUuid(request.params.id))
        return reply.code(400).send({ error: "Invalid backtest run ID" });
      try {
        return await service.getRun(request.params.id);
      } catch (error) {
        return sendDomainError(reply, error);
      }
    },
  );

  app.post<{ Body: unknown }>("/api/backtests", async (request, reply) => {
    const service = requireService(
      reply,
      options.researchJobService,
      "Research job queue",
    );
    if (!service) return;
    const parsed = createBacktestSchema.safeParse(request.body);
    if (!parsed.success)
      return reply
        .code(400)
        .send({ error: "Invalid backtest run", issues: parsed.error.issues });
    return reply
      .code(202)
      .send(
        await service.createJob(
          "BACKTEST",
          parsed.data,
          idempotencyKeyFrom(request),
        ),
      );
  });
}
