import { marketIdSchema } from "@tsx-scanner/contracts";
import type { FastifyInstance } from "fastify";
import type { BuildAppOptions } from "../api-types.js";
import { sendDomainError } from "../errors.js";
import { requireService, parseLimit, isValidUuid } from "./shared.js";

export function registerFundedReplayRoutes(
  app: FastifyInstance,
  options: BuildAppOptions,
): void {
  app.get<{ Querystring: { marketId?: string; limit?: string } }>(
    "/api/funded-replays",
    async (request, reply) => {
      const service = requireService(
        reply,
        options.fundedHistoricalService,
        "Funded historical replay service",
      );
      if (!service) return;
      const market = marketIdSchema.safeParse(
        request.query.marketId ?? "CA_TSX",
      );
      if (!market.success)
        return reply
          .code(400)
          .send({ error: "marketId must be CA_TSX or US_EQUITIES" });
      const limit = parseLimit(reply, request.query.limit, 50, 1, 200);
      if (limit === undefined) return;
      try {
        return await service.list(market.data, limit);
      } catch (error) {
        return sendDomainError(reply, error);
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/funded-replays/:id",
    async (request, reply) => {
      const service = requireService(
        reply,
        options.fundedHistoricalService,
        "Funded historical replay service",
      );
      if (!service) return;
      if (!isValidUuid(request.params.id))
        return reply.code(400).send({ error: "Invalid funded replay run ID" });
      try {
        return await service.get(request.params.id);
      } catch (error) {
        return sendDomainError(reply, error);
      }
    },
  );

  app.get<{ Querystring: { marketId?: string } }>(
    "/api/paper-bot/funded-account",
    async (request, reply) => {
      const service = requireService(
        reply,
        options.fundedHistoricalService,
        "Funded historical replay service",
      );
      if (!service) return;
      const market = marketIdSchema.safeParse(
        request.query.marketId ?? "CA_TSX",
      );
      if (!market.success)
        return reply
          .code(400)
          .send({ error: "marketId must be CA_TSX or US_EQUITIES" });
      try {
        return await service.liveAccount(market.data);
      } catch (error) {
        return sendDomainError(reply, error);
      }
    },
  );
}
