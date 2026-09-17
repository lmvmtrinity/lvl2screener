import {
  createCoverageRequestSchema,
  marketIdSchema,
  researchCoverageReportSchema,
} from "@tsx-scanner/contracts";
import type { FastifyInstance } from "fastify";
import type { BuildAppOptions } from "../api-types.js";
import { requireService } from "./shared.js";
import { isValidUuid } from "./shared.js";

export function registerResearchEvidenceRoutes(
  app: FastifyInstance,
  options: BuildAppOptions,
): void {
  app.post<{ Body: unknown }>(
    "/api/research-evidence/requests",
    async (request, reply) => {
      const service = requireService(
        reply,
        options.coverageRequestService,
        "Coverage request service",
      );
      if (!service) return;
      const parsed = createCoverageRequestSchema.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({
          error: "Invalid coverage request",
          issues: parsed.error.issues,
        });
      const key = request.headers["idempotency-key"];
      if (typeof key !== "string" || !key.trim())
        return reply
          .code(400)
          .send({ error: "Idempotency-Key header is required" });
      try {
        return reply.code(202).send(await service.create(parsed.data, key));
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "COVERAGE_MANIFEST_HASH_MISMATCH"
        )
          return reply.code(400).send({ error: error.message });
        if (
          error instanceof Error &&
          error.message.includes("IDEMPOTENCY_CONFLICT")
        )
          return reply.code(409).send({ error: error.message });
        throw error;
      }
    },
  );
  app.get<{ Params: { id: string }; Querystring: { marketId?: string } }>(
    "/api/research-evidence/requests/:id",
    async (request, reply) => {
      const service = requireService(
        reply,
        options.coverageRequestService,
        "Coverage request service",
      );
      if (!service) return;
      if (!isValidUuid(request.params.id))
        return reply.code(400).send({ error: "Invalid coverage request ID" });
      const market = marketIdSchema.safeParse(request.query.marketId);
      if (!market.success)
        return reply
          .code(400)
          .send({ error: "marketId must be CA_TSX or US_EQUITIES" });
      const record = await service.get(request.params.id, market.data);
      return record
        ? record
        : reply.code(404).send({ error: "Coverage request not found" });
    },
  );
  app.get<{ Params: { hash: string }; Querystring: { marketId?: string } }>(
    "/api/research-evidence/:hash",
    async (request, reply) => {
      const service = requireService(
        reply,
        options.researchEvidenceService,
        "Research evidence service",
      );
      if (!service) return;
      if (!/^[a-f0-9]{64}$/.test(request.params.hash))
        return reply
          .code(400)
          .send({ error: "Invalid research evidence hash" });
      const market = marketIdSchema.safeParse(request.query.marketId);
      if (!market.success)
        return reply
          .code(400)
          .send({ error: "marketId must be CA_TSX or US_EQUITIES" });
      const report = await service.getReport(request.params.hash);
      if (!report || report.marketId !== market.data)
        return reply.code(404).send({ error: "Research evidence not found" });
      return researchCoverageReportSchema.parse(report);
    },
  );
}
