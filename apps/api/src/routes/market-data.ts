import { z } from "zod";
import {
  alertPolicySchema,
  marketFilterSchema,
  updateCandidateIntakeSchema,
} from "@tsx-scanner/contracts";
import type { FastifyInstance } from "fastify";
import type { BuildAppOptions } from "../api-types.js";
import type { MarketDataApi } from "../api-types.js";
import type { UniverseAutomation } from "@tsx-scanner/contracts";
import { requireService, parseLimit } from "./shared.js";

function normalizeTsxSymbol(value: string): string {
  let symbol = value
    .trim()
    .toUpperCase()
    .replace(/^\$/, "")
    .replace(/^TSX:/, "");
  if (symbol && !symbol.endsWith(".TO")) symbol += ".TO";
  return symbol;
}

function parseMarketFilter(
  reply: { code(code: number): { send(value: unknown): unknown } },
  value: string | undefined,
): "CA_TSX" | "US_EQUITIES" | "ALL" | undefined {
  const parsed = marketFilterSchema.safeParse(value ?? "ALL");
  if (parsed.success) return parsed.data;
  reply
    .code(400)
    .send({ error: "marketId must be CA_TSX, US_EQUITIES, or ALL" });
  return undefined;
}

function marketService(
  options: BuildAppOptions,
  reply: { code(code: number): { send(value: unknown): unknown } },
  marketId: "CA_TSX" | "US_EQUITIES",
): MarketDataApi | undefined {
  const service =
    options.marketDataServices?.[marketId] ??
    (marketId === "CA_TSX" ? options.marketDataService : undefined);
  if (service) return service;
  reply
    .code(409)
    .send({ error: `${marketId} is not active in this runtime`, marketId });
  return undefined;
}

function servicesForFilter(
  options: BuildAppOptions,
  reply: { code(code: number): { send(value: unknown): unknown } },
  marketId: "CA_TSX" | "US_EQUITIES" | "ALL",
): MarketDataApi[] | undefined {
  if (marketId !== "ALL") {
    const service = marketService(options, reply, marketId);
    return service ? [service] : undefined;
  }
  const services = ["CA_TSX", "US_EQUITIES"] as const;
  return services.flatMap((id) => {
    const service =
      options.marketDataServices?.[id] ??
      (id === "CA_TSX" ? options.marketDataService : undefined);
    return service ? [service] : [];
  });
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : { value };
}

async function universeAutomationFor(
  service: MarketDataApi,
): Promise<UniverseAutomation | undefined> {
  const automation = service.getUniverseAutomation?.();
  if (!automation) return undefined;
  const statuses = await service.getUniverseCandidateStatuses?.();
  return statuses === undefined
    ? automation
    : { ...automation, candidateStatuses: statuses };
}

/** Market snapshot, universe, feature-snapshot, candidate/context/signal, and alert routes — all
 * backed by MarketDataApi. */
export function registerMarketDataRoutes(
  app: FastifyInstance,
  options: BuildAppOptions,
): void {
  app.get<{ Querystring: { marketId?: string } }>(
    "/api/market/status",
    async (request, reply) => {
      const marketId = parseMarketFilter(
        reply,
        request.query.marketId ?? "CA_TSX",
      );
      if (!marketId) return;
      const services = servicesForFilter(options, reply, marketId);
      if (!services) return;
      if (marketId !== "ALL") return services[0]!.getSnapshot();
      return {
        markets: (["CA_TSX", "US_EQUITIES"] as const).flatMap((id) => {
          const service =
            options.marketDataServices?.[id] ??
            (id === "CA_TSX" ? options.marketDataService : undefined);
          return service
            ? [{ marketId: id, ...asObject(service.getSnapshot()) }]
            : [];
        }),
      };
    },
  );

  app.get<{ Querystring: { marketId?: string } }>(
    "/api/universe",
    async (request, reply) => {
      const marketId = parseMarketFilter(
        reply,
        request.query.marketId ?? "CA_TSX",
      );
      if (!marketId) return;
      const services = servicesForFilter(options, reply, marketId);
      if (!services) return;
      const automations = await Promise.all(
        services.map((service) => universeAutomationFor(service)),
      );
      return {
        instruments: services.flatMap((service) => service.getInstruments()),
        // `automation` remains singular for the legacy no-filter dashboard. A
        // mixed response carries the complete per-market set in `automations`.
        automation: automations[0],
        ...(marketId === "ALL"
          ? {
              automations: automations.filter(
                (automation): automation is UniverseAutomation =>
                  Boolean(automation),
              ),
            }
          : {}),
      };
    },
  );

  app.get<{ Querystring: { limit?: string; marketId?: string } }>(
    "/api/universe/runs",
    async (request, reply) => {
      const marketId = parseMarketFilter(
        reply,
        request.query.marketId ?? "CA_TSX",
      );
      if (!marketId) return;
      const services = servicesForFilter(options, reply, marketId);
      if (!services) return;
      if (services.some((service) => !service.listUniverseRuns))
        return reply
          .code(503)
          .send({ error: "Universe automation is unavailable" });
      const limit = parseLimit(reply, request.query.limit, 20, 1, 100);
      if (limit === undefined) return;
      return {
        runs: (
          await Promise.all(
            services.map((service) => service.listUniverseRuns!(limit)),
          )
        )
          .flat()
          .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
          .slice(0, limit),
      };
    },
  );

  app.post<{ Querystring: { marketId?: string } }>(
    "/api/universe/refresh",
    async (request, reply) => {
      const marketId = parseMarketFilter(
        reply,
        request.query.marketId ?? "CA_TSX",
      );
      if (!marketId || marketId === "ALL")
        return reply.code(400).send({ error: "A single marketId is required" });
      const service = marketService(options, reply, marketId);
      if (!service?.refreshUniverse)
        return reply
          .code(503)
          .send({ error: "Universe automation is unavailable" });
      try {
        await service.refreshUniverse();
        return reply.code(201).send({
          instruments: service.getInstruments(),
          automation: await universeAutomationFor(service),
        });
      } catch (error) {
        return reply.code(502).send({
          error:
            error instanceof Error ? error.message : "Universe refresh failed",
        });
      }
    },
  );

  app.put<{ Body: unknown; Querystring: { marketId?: string } }>(
    "/api/universe/watchlist",
    async (request, reply) => {
      const marketId = parseMarketFilter(
        reply,
        request.query.marketId ?? "CA_TSX",
      );
      if (!marketId || marketId === "ALL")
        return reply.code(400).send({ error: "A single marketId is required" });
      const service = marketService(options, reply, marketId);
      if (!service?.replaceUniverseSymbols)
        return reply
          .code(503)
          .send({ error: "Universe watchlist editing is unavailable" });
      const parsed = z
        .object({
          symbols: z
            .array(
              z
                .string()
                .trim()
                .regex(
                  /^[A-Za-z0-9][A-Za-z0-9:.-]{0,39}$/,
                  "Invalid market symbol",
                ),
            )
            .max(200),
        })
        .safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({
          error: "Provide up to 200 valid market symbols",
          issues: parsed.error.issues,
        });
      const symbols = [
        ...new Set(
          parsed.data.symbols.map((symbol) =>
            marketId === "CA_TSX"
              ? normalizeTsxSymbol(symbol)
              : symbol.toUpperCase(),
          ),
        ),
      ];
      try {
        await service.replaceUniverseSymbols(symbols);
        return {
          instruments: service.getInstruments(),
          automation: await universeAutomationFor(service),
        };
      } catch (error) {
        return reply.code(502).send({
          error:
            error instanceof Error ? error.message : "Watchlist update failed",
        });
      }
    },
  );

  // Pre-market daily-list seed (daily-seed-v1). Reads are cheap; preview and
  // run start in the background (a US ranking outlasts proxy timeouts) and
  // report progress through the status read. Preview never edits the list;
  // run applies the same empty-list rule as the schedule.
  const seederFor = (
    reply: { code(code: number): { send(value: unknown): unknown } },
    value: string | undefined,
  ) => {
    const marketId = parseMarketFilter(reply, value ?? "CA_TSX");
    if (!marketId) return undefined;
    if (marketId === "ALL") {
      reply.code(400).send({ error: "A single marketId is required" });
      return undefined;
    }
    const seeder = options.dailySeeders?.[marketId];
    if (!seeder) {
      reply.code(503).send({ error: "The daily-list seed is unavailable" });
      return undefined;
    }
    return seeder;
  };

  app.get<{ Querystring: { marketId?: string } }>(
    "/api/universe/daily-seed",
    async (request, reply) => {
      const marketId = parseMarketFilter(
        reply,
        request.query.marketId ?? "CA_TSX",
      );
      if (!marketId) return;
      const seeders = Object.entries(options.dailySeeders ?? {}).filter(
        ([id]) => marketId === "ALL" || id === marketId,
      );
      return {
        seeders: await Promise.all(
          seeders.map(([, seeder]) => seeder!.status()),
        ),
      };
    },
  );

  for (const action of ["preview", "run"] as const)
    app.post<{ Querystring: { marketId?: string } }>(
      `/api/universe/daily-seed/${action}`,
      async (request, reply) => {
        const seeder = seederFor(reply, request.query.marketId);
        if (!seeder) return;
        const started =
          action === "preview" ? seeder.preview() : seeder.runNow();
        started.catch(() => undefined);
        return reply.code(202).send(await seeder.status());
      },
    );

  app.post<{ Querystring: { marketId?: string } }>(
    "/api/universe/daily-seed/rescan",
    async (request, reply) => {
      const seeder = seederFor(reply, request.query.marketId);
      if (!seeder) return;
      const rescan =
        options.dailySeedRescans?.[
          request.query.marketId as "CA_TSX" | "US_EQUITIES"
        ];
      if (!rescan)
        return reply.code(503).send({
          error: "The early-session rescan is not configured for this market",
        });
      rescan.runNow().catch(() => undefined);
      return reply.code(202).send(await seeder.status());
    },
  );

  app.post<{ Querystring: { marketId?: string; count?: string } }>(
    "/api/universe/daily-seed/add-top",
    async (request, reply) => {
      const seeder = seederFor(reply, request.query.marketId);
      if (!seeder) return;
      const count = parseLimit(reply, request.query.count, 5, 1, 50);
      if (count === undefined) return;
      try {
        return { added: await seeder.addTop(count) };
      } catch (error) {
        return reply.code(409).send({
          error: error instanceof Error ? error.message : "Add failed",
        });
      }
    },
  );

  app.get<{ Querystring: { marketId?: string; limit?: string } }>(
    "/api/universe/daily-seed/history",
    async (request, reply) => {
      const marketId = parseMarketFilter(
        reply,
        request.query.marketId ?? "CA_TSX",
      );
      if (!marketId) return;
      if (marketId === "ALL")
        return reply.code(400).send({ error: "A single marketId is required" });
      if (!options.dailySeedRepository)
        return reply
          .code(503)
          .send({ error: "Daily-seed history is unavailable" });
      const limit = parseLimit(reply, request.query.limit, 30, 1, 120);
      if (limit === undefined) return;
      return {
        entries: await options.dailySeedRepository.history(marketId, limit),
      };
    },
  );

  app.get("/api/universe/daily-seed/legacy", async (_request, reply) => {
    if (!options.dailySeedRepository)
      return reply
        .code(503)
        .send({ error: "Legacy discovery facts are unavailable" });
    const poolSizes: Partial<Record<"CA_TSX" | "US_EQUITIES", number>> = {};
    await Promise.all(
      Object.entries(options.dailySeeders ?? {}).map(async ([id, seeder]) => {
        poolSizes[id as "CA_TSX" | "US_EQUITIES"] = await seeder!.poolSize();
      }),
    );
    return options.dailySeedRepository.legacy(poolSizes);
  });

  // @supported (decision-gated, defaulted per private development record W10):
  // /api/features and /api/features/:symbol are a documented diagnostic API. Keep while that
  // remains true; remove once candidate detail (/api/candidates/:symbol) is the only supported
  // surface for feature data. No removal decision was recorded, so the default is keep.
  // Covered by apps/api/tests/foundation.test.ts.
  app.get<{ Querystring: { marketId?: string } }>(
    "/api/features",
    async (request, reply) => {
      const marketId = parseMarketFilter(
        reply,
        request.query.marketId ?? "CA_TSX",
      );
      if (!marketId) return;
      const services = servicesForFilter(options, reply, marketId);
      if (!services) return;
      return {
        snapshots: services.flatMap((service) => service.getFeatureSnapshots()),
      };
    },
  );

  app.get<{ Params: { symbol: string } }>(
    "/api/features/:symbol",
    async (request, reply) => {
      const service = requireService(
        reply,
        options.marketDataService,
        "Market data service",
      );
      if (!service) return;
      const snapshot = service.getFeatureSnapshot(request.params.symbol);
      if (!snapshot)
        return reply.code(404).send({ error: "Feature snapshot not found" });
      return snapshot;
    },
  );

  app.get<{ Querystring: { marketId?: string } }>(
    "/api/candidates",
    async (request, reply) => {
      const marketId = parseMarketFilter(
        reply,
        request.query.marketId ?? "CA_TSX",
      );
      if (!marketId) return;
      const services = servicesForFilter(options, reply, marketId);
      if (!services) return;
      return {
        candidates: services.flatMap(
          (service) => service.getCandidates?.() ?? [],
        ),
      };
    },
  );

  app.get<{ Querystring: { marketId?: string } }>(
    "/api/contexts",
    async (request, reply) => {
      const marketId = parseMarketFilter(
        reply,
        request.query.marketId ?? "CA_TSX",
      );
      if (!marketId) return;
      const services = servicesForFilter(options, reply, marketId);
      if (!services) return;
      return {
        contexts: services.flatMap((service) => service.getContexts?.() ?? []),
      };
    },
  );

  app.get<{ Params: { symbol: string }; Querystring: { marketId?: string } }>(
    "/api/candidates/:symbol",
    async (request, reply) => {
      const defaultService = options.marketDataService;
      const allServices: MarketDataApi[] = options.marketDataServices
        ? (Object.values(options.marketDataServices).filter(
            Boolean,
          ) as MarketDataApi[])
        : defaultService
          ? [defaultService]
          : [];
      if (allServices.length === 0) {
        reply.code(503).send({ error: "Market data service is unavailable" });
        return;
      }
      const rawSymbol = request.params.symbol;
      const symbol = rawSymbol.toUpperCase();
      const requestedMarket = request.query.marketId;
      const explicitService =
        requestedMarket && requestedMarket !== "ALL"
          ? (options.marketDataServices?.[
              requestedMarket as "CA_TSX" | "US_EQUITIES"
            ] ?? (requestedMarket === "CA_TSX" ? defaultService : undefined))
          : undefined;
      const service =
        explicitService ??
        allServices.find(
          (s) =>
            (s.getCandidate?.(rawSymbol) ?? []).length > 0 ||
            (s.getCandidate?.(symbol) ?? []).length > 0 ||
            s
              .getUniverseAutomation?.()
              ?.members.some((m) => m.symbol.toUpperCase() === symbol) ||
            s
              .getUniverseAutomation?.()
              ?.coverage?.some((c) => c.symbol.toUpperCase() === symbol) ||
            Boolean(s.getFeatureSnapshot(symbol)),
        ) ??
        defaultService ??
        allServices[0]!;
      const strategies =
        service.getCandidate?.(rawSymbol) ??
        service.getCandidate?.(symbol) ??
        [];
      const feature = service.getFeatureSnapshot(symbol) ?? null;
      const automation = service.getUniverseAutomation?.();
      const member =
        automation?.members.find(
          (value) => value.symbol.toUpperCase() === symbol,
        ) ?? null;
      const coverage =
        automation?.coverage?.find(
          (value) => value.symbol.toUpperCase() === symbol,
        ) ?? null;
      if (strategies.length === 0 && !member && !coverage)
        return reply.code(404).send({ error: "Candidate not found" });
      const candles = (service.getCandles?.(symbol) ?? []).map((candle) => ({
        ...candle,
        start: candle.start.toISOString(),
        end: candle.end.toISOString(),
      }));
      const events = (service.getSignals?.() ?? []).filter(
        (value) =>
          typeof value === "object" &&
          value !== null &&
          "symbol" in value &&
          value.symbol === symbol,
      );
      const contexts = service.getContexts?.(symbol) ?? [];
      return {
        symbol,
        strategies,
        contexts,
        feature,
        candles,
        events,
        member,
        coverage,
      };
    },
  );

  // @supported (decision-gated, defaulted per private development record W10):
  // /api/signals is an operator timeline/debug API (list only — there is no GET /api/signals/:id,
  // and none is documented). Keep while it serves that role; remove once all consumers use the
  // alerts/detail events instead. No removal decision was recorded, so the default is keep.
  // Covered by apps/api/tests/foundation.test.ts.
  app.get<{ Querystring: { marketId?: string } }>(
    "/api/signals",
    async (request, reply) => {
      const marketFilter = parseMarketFilter(
        reply,
        request.query.marketId ?? "ALL",
      );
      if (!marketFilter) return;
      const services = servicesForFilter(options, reply, marketFilter);
      if (!services) return;
      return { signals: services.flatMap((s) => s.getSignals?.() ?? []) };
    },
  );

  app.get<{ Querystring: { limit?: string; marketId?: string } }>(
    "/api/alerts",
    async (request, reply) => {
      const marketFilter = parseMarketFilter(
        reply,
        request.query.marketId ?? "ALL",
      );
      if (!marketFilter) return;
      const services = servicesForFilter(options, reply, marketFilter);
      if (!services) return;
      const requested = parseLimit(reply, request.query.limit, 100, 1, 200);
      if (requested === undefined) return;
      const alerts = (
        services.flatMap((s) => s.getAlerts?.() ?? []) as Array<{
          timestamp: string;
        }>
      )
        .sort(
          (a, b) =>
            new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
        )
        .slice(0, requested);
      return { alerts };
    },
  );

  app.get<{ Querystring: { marketId?: string } }>(
    "/api/alerts/policy",
    async (request, reply) => {
      const marketFilter = parseMarketFilter(
        reply,
        request.query.marketId ?? "CA_TSX",
      );
      if (!marketFilter) return;
      if (marketFilter === "ALL") {
        return reply
          .code(400)
          .send({ error: "marketId must be CA_TSX or US_EQUITIES" });
      }
      const service = marketService(options, reply, marketFilter);
      if (!service) return;
      if (!service.getAlertPolicy)
        return reply.code(503).send({ error: "Alert policy is unavailable" });
      return service.getAlertPolicy();
    },
  );

  app.put<{ Querystring: { marketId?: string }; Body: unknown }>(
    "/api/alerts/policy",
    async (request, reply) => {
      const marketFilter = parseMarketFilter(
        reply,
        request.query.marketId ?? "CA_TSX",
      );
      if (!marketFilter) return;
      if (marketFilter === "ALL") {
        return reply
          .code(400)
          .send({ error: "marketId must be CA_TSX or US_EQUITIES" });
      }
      const service = marketService(options, reply, marketFilter);
      if (!service) return;
      if (!service.updateAlertPolicy)
        return reply.code(503).send({ error: "Alert policy is unavailable" });
      const parsed = alertPolicySchema.safeParse(request.body);
      if (!parsed.success)
        return reply
          .code(400)
          .send({ error: "Invalid alert policy", issues: parsed.error.issues });
      return alertPolicySchema.parse(
        await service.updateAlertPolicy(parsed.data),
      );
    },
  );

  app.post<{ Querystring: { marketId?: string }; Body: unknown }>(
    "/api/universe/candidates",
    async (request, reply) => {
      const marketFilter = parseMarketFilter(
        reply,
        request.query.marketId ?? "CA_TSX",
      );
      if (!marketFilter) return;
      if (marketFilter === "ALL") {
        return reply
          .code(400)
          .send({ error: "marketId must be CA_TSX or US_EQUITIES" });
      }
      const service = marketService(options, reply, marketFilter);
      if (!service) return;
      if (!service.updateUniverseCandidates)
        return reply
          .code(503)
          .send({ error: "Candidate intake metadata is unavailable" });
      const parsed = updateCandidateIntakeSchema.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({
          error: "Invalid candidate intake",
          issues: parsed.error.issues,
        });
      try {
        const result = await service.updateUniverseCandidates(parsed.data);
        return {
          instruments: result.instruments,
          automation: await universeAutomationFor(service),
          pasteReport: result.pasteReport,
          ...(result.refreshError ? { refreshError: result.refreshError } : {}),
        };
      } catch (error) {
        return reply.code(502).send({
          error:
            error instanceof Error ? error.message : "Candidate intake failed",
        });
      }
    },
  );
}
