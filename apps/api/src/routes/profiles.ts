import {
  comparisonCohortSelectionSchema,
  marketIdSchema,
} from "@tsx-scanner/contracts";
import {
  createScannerProfileSchema,
  duplicateScannerProfileSchema,
  updateScannerProfileSchema,
} from "@tsx-scanner/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { BuildAppOptions } from "../api-types.js";
import { sendDomainError } from "../errors.js";
import { requireService, parseLimit, isValidUuid } from "./shared.js";

export function registerProfileRoutes(
  app: FastifyInstance,
  options: BuildAppOptions,
): void {
  app.get("/api/strategies", async (_request, reply) => {
    const service = requireService(
      reply,
      options.profileService,
      "Profile service",
    );
    if (!service) return;
    return { strategies: await service.listDefinitions() };
  });

  app.get("/api/scanner-profiles", async (_request, reply) => {
    const service = requireService(
      reply,
      options.profileService,
      "Profile service",
    );
    if (!service) return;
    return { profiles: await service.listProfiles() };
  });

  app.post<{ Body: unknown }>(
    "/api/scanner-profiles",
    async (request, reply) => {
      const service = requireService(
        reply,
        options.profileService,
        "Profile service",
      );
      if (!service) return;
      const parsed = createScannerProfileSchema.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({
          error: "Invalid scanner profile",
          issues: parsed.error.issues,
        });
      try {
        return reply.code(201).send(await service.create(parsed.data));
      } catch (error) {
        return sendDomainError(reply, error);
      }
    },
  );

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/api/scanner-profiles/:id/duplicate",
    async (request, reply) => {
      const service = requireService(
        reply,
        options.profileService,
        "Profile service",
      );
      if (!service) return;
      if (!isValidUuid(request.params.id))
        return reply.code(400).send({ error: "Invalid profile ID" });
      const body = duplicateScannerProfileSchema.safeParse(request.body ?? {});
      if (!body.success)
        return reply.code(400).send({ error: "Invalid profile duplication" });
      try {
        return reply
          .code(201)
          .send(
            await service.duplicate(
              request.params.id,
              body.data.name,
              body.data.sourceCalibrationRunId,
            ),
          );
      } catch (error) {
        return sendDomainError(reply, error);
      }
    },
  );

  app.put<{ Params: { id: string }; Body: unknown }>(
    "/api/scanner-profiles/:id",
    async (request, reply) => {
      const service = requireService(
        reply,
        options.profileService,
        "Profile service",
      );
      if (!service) return;
      const id = z.string().uuid().safeParse(request.params.id),
        body = updateScannerProfileSchema.safeParse(request.body);
      if (!id.success || !body.success)
        return reply.code(400).send({ error: "Invalid profile update" });
      try {
        return await service.update(id.data, body.data);
      } catch (error) {
        return sendDomainError(reply, error);
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/scanner-profiles/:id/configs",
    async (request, reply) => {
      const service = requireService(
        reply,
        options.profileService,
        "Profile service",
      );
      if (!service) return;
      if (!isValidUuid(request.params.id))
        return reply.code(400).send({ error: "Invalid profile ID" });
      try {
        return await service.configHistory(request.params.id);
      } catch (error) {
        return sendDomainError(reply, error);
      }
    },
  );

  // @supported (decision-gated, defaulted per private development record W10):
  // /api/evaluations is an audit/history API. Keep while it serves that role; remove once
  // replaced by a scoped audit endpoint. No removal decision was recorded, so the default is
  // keep. Covered by apps/api/tests/profile-api.test.ts.
  app.get<{ Querystring: { profileId?: string; limit?: string } }>(
    "/api/evaluations",
    async (request, reply) => {
      const service = requireService(
        reply,
        options.profileService,
        "Profile service",
      );
      if (!service) return;
      if (request.query.profileId && !isValidUuid(request.query.profileId))
        return reply.code(400).send({ error: "Invalid profileId" });
      const limit = parseLimit(reply, request.query.limit, 1000, 1, 5000);
      if (limit === undefined) return;
      return {
        evaluations: await service.listEvaluations(
          request.query.profileId,
          limit,
        ),
      };
    },
  );

  // @supported (decision-gated, defaulted per private development record W10):
  // /api/opportunities is a server-authoritative ALL-projection API. React (apps/web) does NOT
  // currently consume this endpoint (see docs reconciliation note in W10) — the frontend derives
  // its own opportunity view client-side. Keep while the server projection remains authoritative
  // for non-frontend consumers; remove once React stays authoritative and docs are corrected
  // to stop implying frontend ownership. No removal decision was recorded, so the default is
  // keep. Covered by apps/api/tests/profile-api.test.ts.
  app.get("/api/opportunities", async (_request, reply) => {
    const service = requireService(
      reply,
      options.profileService,
      "Profile service",
    );
    if (!service) return;
    return { opportunities: await service.opportunities() };
  });

  app.get<{
    Querystring: {
      profileIds?: string;
      source?: string;
      startDate?: string;
      endDate?: string;
      timeStart?: string;
      timeEnd?: string;
      marketId?: string;
      cohortKeys?: string;
    };
  }>("/api/comparisons", async (request, reply) => {
    const service = requireService(
      reply,
      options.profileService,
      "Profile service",
    );
    if (!service) return;
    const ids = (request.query.profileIds ?? "").split(",").filter(Boolean),
      source = z
        .enum(["LIVE", "PAPER", "BACKTEST"])
        .safeParse(request.query.source ?? "LIVE"),
      today = new Date().toISOString().slice(0, 10),
      start =
        request.query.startDate ??
        new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10),
      end = request.query.endDate ?? today;
    const timeStart = request.query.timeStart ?? "09:30",
      timeEnd = request.query.timeEnd ?? "16:00",
      timeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
    const market = marketIdSchema.safeParse(request.query.marketId ?? "CA_TSX");
    let cohortKeys;
    if (request.query.cohortKeys) {
      try {
        cohortKeys = comparisonCohortSelectionSchema.safeParse(
          JSON.parse(request.query.cohortKeys),
        );
      } catch {
        cohortKeys = { success: false } as const;
      }
    }
    if (
      ids.some((id) => !isValidUuid(id)) ||
      !source.success ||
      !market.success ||
      !z.string().date().safeParse(start).success ||
      !z.string().date().safeParse(end).success ||
      !timeSchema.safeParse(timeStart).success ||
      !timeSchema.safeParse(timeEnd).success ||
      cohortKeys?.success === false
    )
      return reply.code(400).send({ error: "Invalid comparison filters" });
    try {
      return await service.compare(
        ids,
        source.data,
        start,
        end,
        timeStart,
        timeEnd,
        market.data,
        cohortKeys?.success ? cohortKeys.data : undefined,
      );
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });
}
