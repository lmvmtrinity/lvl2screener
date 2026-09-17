import { createCalibrationSchema } from "@tsx-scanner/contracts";
import type { FastifyInstance } from "fastify";
import type { BuildAppOptions } from "../api-types.js";
import { sendDomainError } from "../errors.js";
import { requireService, parseLimit, isValidUuid } from "./shared.js";
import { idempotencyKeyFrom } from "./research-jobs.js";

export function registerCalibrationRoutes(
  app: FastifyInstance,
  options: BuildAppOptions,
): void {
  app.get<{ Querystring: { limit?: string } }>(
    "/api/calibrations",
    async (request, reply) => {
      const service = requireService(
        reply,
        options.calibrationService,
        "Calibration service",
      );
      if (!service) return;
      const limit = parseLimit(reply, request.query.limit, 50, 1, 100);
      if (limit === undefined) return;
      return { calibrations: await service.list(limit) };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/calibrations/:id",
    async (request, reply) => {
      const service = requireService(
        reply,
        options.calibrationService,
        "Calibration service",
      );
      if (!service) return;
      if (!isValidUuid(request.params.id))
        return reply.code(400).send({ error: "Invalid calibration run ID" });
      try {
        return await service.get(request.params.id);
      } catch (error) {
        return sendDomainError(reply, error);
      }
    },
  );

  app.post<{ Body: unknown }>("/api/calibrations", async (request, reply) => {
    const service = requireService(
      reply,
      options.researchJobService,
      "Research job queue",
    );
    if (!service) return;
    const parsed = createCalibrationSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({
        error: "Invalid calibration run",
        issues: parsed.error.issues,
      });
    return reply
      .code(202)
      .send(
        await service.createJob(
          "CALIBRATION",
          parsed.data,
          idempotencyKeyFrom(request),
        ),
      );
  });
}
