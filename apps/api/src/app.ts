import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyServerOptions } from "fastify";
import type { BuildAppOptions } from "./api-types.js";
import { registerRemoteAuth } from "./auth/remote-auth-plugin.js";
import { registerSystemRoutes } from "./routes/system.js";
import { registerMarketDataRoutes } from "./routes/market-data.js";
import { registerProfileRoutes } from "./routes/profiles.js";
import { registerBacktestRoutes } from "./routes/backtests.js";
import { registerFundedReplayRoutes } from "./routes/funded-replays.js";
import { registerCalibrationRoutes } from "./routes/calibrations.js";
import { registerStatisticalModelRoutes } from "./routes/statistical-models.js";
import { registerRankingResearchRoutes } from "./routes/ranking-research.js";
import { registerResearchJobRoutes } from "./routes/research-jobs.js";
import { registerResearchEvidenceRoutes } from "./routes/research-evidence.js";
import { registerPaperReportingRoutes } from "./routes/paper-reporting.js";
import { registerLearningRoutes } from "./routes/learning.js";
import { registerDiscoveryRoutes } from "./routes/discovery.js";
import { registerStrategyStudyRoutes } from "./routes/strategy-studies.js";
import { registerChallengerExperimentRoutes } from "./routes/challenger-experiments.js";

// W9: app.ts is a navigation/composition layer, not a route implementation file. Each vertical's
// route handlers, request/response shapes, and error mapping live in ./routes/<vertical>.ts and
// the corresponding *-service.ts DomainError subclass; this file only wires Fastify plugins and
// registers each vertical's routes against the shared `options`. See ./api-types.ts for the
// service-facing interfaces (MarketDataApi, ProfileApi, ...) that `options` is built from, and
// ./errors.ts for the uniform DomainError model every route's catch block relies on.
export type {
  MarketDataApi,
  DiscoveryApi,
  BuildAppOptions,
  ProfileApi,
  BacktestApi,
  BacktestAutomationApi,
  FundedHistoricalReplayApi,
  FundedHistoricalPolicyApi,
  CalibrationApi,
  StatisticalModelApi,
  PaperEvidenceTrainingApi,
  PredictionMonitoringApi,
  RankingResearchApi,
  ResearchJobApi,
  ResearchEvidenceApi,
  CoverageRequestApi,
  StrategyStudyApi,
  ChallengerExperimentApi,
  PaperReportingApi,
  FundedReportingApi,
} from "./api-types.js";
export type { FastifyServerOptions };

export async function buildApp(options: BuildAppOptions) {
  const remoteAccess = options.remoteAccess?.enabled ?? false;
  const app = Fastify({
    logger: options.logger ?? false,
    // W5: the remote profile always sits behind nginx TLS termination, so trust its
    // X-Forwarded-* headers for rate limiting/audit IPs. The default (Phase A) profile has no
    // reverse proxy in front of a directly-published port, so trusting forwarded headers there
    // would let a client spoof its own IP against the (disabled) rate limiter for nothing.
    trustProxy: remoteAccess,
    // W5: the remote profile's request-rate/body-size limits (plan Phase B item 4). The default
    // profile keeps Fastify's normal 1 MiB limit -- it's a trusted single-operator workstation.
    bodyLimit: remoteAccess ? 256 * 1024 : undefined,
  });
  const clock = options.clock ?? (() => new Date());

  await app.register(cors, {
    origin: options.webOrigin ?? "http://localhost:5173",
  });
  await app.register(websocket);

  if (remoteAccess && options.remoteAccess) {
    registerRemoteAuth(app, {
      passwordHash: options.remoteAccess.passwordHash,
      logger: options.logger ? app.log : undefined,
    });
  }

  registerSystemRoutes(app, options, clock);
  registerMarketDataRoutes(app, options);
  registerProfileRoutes(app, options);
  registerBacktestRoutes(app, options);
  registerFundedReplayRoutes(app, options);
  registerCalibrationRoutes(app, options);
  registerStatisticalModelRoutes(app, options);
  registerRankingResearchRoutes(app, options);
  registerResearchJobRoutes(app, options);
  registerResearchEvidenceRoutes(app, options);
  registerPaperReportingRoutes(app, options);
  registerLearningRoutes(app, options);
  registerDiscoveryRoutes(app, options);
  registerStrategyStudyRoutes(app, options);
  registerChallengerExperimentRoutes(app, options);

  return app;
}
