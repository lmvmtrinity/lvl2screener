// Validates every routed payload of every scenario against the same Zod
// contracts the browser app parses with.
import * as C from "../../contracts/dist/index.js";
import { SCENARIOS, fixtureSet, resolveRequest } from "./fixtures.mjs";

const CHECKS = [
  ["/api/system/status", C.systemStatusSchema, (b) => b],
  ["/api/universe", C.universeResponseSchema, (b) => b],
  ["/api/universe/runs", C.universeRefreshRunListSchema, (b) => b],
  ["/api/candidates", C.candidateListSchema, (b) => b],
  ["/api/contexts", C.contextEvaluationListSchema, (b) => b],
  ["/api/alerts", C.alertListSchema, (b) => b],
  ["/api/alerts/policy", C.alertPolicySchema, (b) => b],
  ["/api/backtests", C.backtestRunListSchema, (b) => b],
  ["/api/scanner-profiles", C.scannerProfileListSchema, (b) => b],
  ["/api/strategies", C.strategyDefinitionListSchema, (b) => b],
  [
    "/api/statistical-models/active/predictions",
    C.activeStatisticalPredictionsSchema,
    (b) => b,
  ],
  ["/api/discovery/status", C.discoveryStatusSchema, (b) => b],
  ["/api/discovery/runs", C.discoveryRunListSchema, (b) => b],
  ["/api/discovery/evaluations", C.discoveryEvidenceListSchema, (b) => b],
  ["/api/paper-bot/aggregates", C.paperCohortAggregateListSchema, (b) => b],
  ["/api/paper-bot/curves", C.paperCohortCurveListSchema, (b) => b],
  ["/api/paper-bot/divergences", C.paperModelDivergenceListSchema, (b) => b],
  ["/api/paper-bot/comparisons", C.paperEvidenceComparisonListSchema, (b) => b],
  ["/api/paper-bot/runs", C.paperBotRunListSchema, (b) => b],
  [
    "/api/paper-bot/qualifications",
    C.paperProfileQualificationListSchema,
    (b) => b,
  ],
  [
    "/api/paper-bot/coordination/summary",
    C.paperCoordinationSummarySchema,
    (b) => b.summary,
  ],
  [
    "/api/paper-bot/coordination/decisions",
    C.paperCoordinationDecisionListSchema,
    (b) => b,
  ],
  ["/api/paper-bot/activities", C.paperBotActivityListSchema, (b) => b],
  ["/api/paper-bot/performance", C.paperPerformanceCurveSchema, (b) => b],
  [
    "/api/paper-bot/funded-account",
    C.fundedLiveAccountResponseSchema,
    (b) => b,
  ],
  ["/api/learning/overview", C.learningDashboardOverviewSchema, (b) => b],
  [
    "/api/learning/automation-runs",
    C.learningAutomationRunListSchema,
    (b) => b,
  ],
  [
    "/api/learning/coordination-decisions",
    C.paperCoordinationDecisionListSchema,
    (b) => b,
  ],
  ["/api/statistical-models", C.statisticalModelListSchema, (b) => b],
  [
    "/api/learning/evidence-automation",
    C.evidenceAutomationResponseSchema,
    (b) => b,
  ],
  ["/api/challenger-experiments", C.challengerExperimentListSchema, (b) => b],
  ["/api/calibrations", C.calibrationRunListSchema, (b) => b],
  [
    "/api/backtest-automation/status",
    C.backtestAutomationStatusSchema,
    (b) => b,
  ],
  [
    "/api/funded-historical-policies",
    C.fundedHistoricalAutomationPolicyListSchema,
    (b) => b,
  ],
  ["/api/funded-replays", C.fundedHistoricalReplayListSchema, (b) => b],
  [
    "/api/captured-history/availability",
    C.capturedHistoryAvailabilitySchema,
    (b) => b,
  ],
];

let failures = 0;
for (const scenario of SCENARIOS) {
  fixtureSet(scenario);
  for (const [path, schema, pick] of CHECKS) {
    const params = new URLSearchParams(
      path === "/api/statistical-models/active/predictions"
        ? ""
        : "marketId=CA_TSX",
    );
    const result = resolveRequest(scenario, path, params);
    if (result.status !== 200) {
      console.error(`${scenario} ${path}: HTTP ${result.status}`);
      failures += 1;
      continue;
    }
    const parsed = schema.safeParse(pick(result.body));
    if (!parsed.success) {
      failures += 1;
      console.error(
        `${scenario} ${path}: ${JSON.stringify(parsed.error.issues.slice(0, 3))}`,
      );
    }
  }
  // Today-scoped variants and the challenger detail route.
  for (const path of [
    "/api/paper-bot/aggregates",
    "/api/paper-bot/runs",
    "/api/paper-bot/coordination/summary",
  ]) {
    resolveRequest(
      scenario,
      path,
      new URLSearchParams(
        "marketId=CA_TSX&startDate=2026-09-10&endDate=2026-09-10",
      ),
    );
  }
  if (scenario === "healthy") {
    const detail = resolveRequest(
      scenario,
      "/api/challenger-experiments/22222222-2222-4222-8222-222222222222/report",
      new URLSearchParams("marketId=CA_TSX"),
    );
    const parsed = C.challengerExperimentDetailSchema.safeParse(detail.body);
    if (!parsed.success) {
      failures += 1;
      console.error(
        `healthy challenger report: ${JSON.stringify(parsed.error.issues.slice(0, 3))}`,
      );
    }
    for (const [path, schema] of [
      ["/api/paper-bot/journal", C.paperTradeJournalSchema],
      [
        "/api/scanner-profiles/9c2f3a10-4b5c-4d6e-8f70-1a2b3c4d5e6f/configs",
        C.profileConfigHistorySchema,
      ],
      ["/api/comparisons", C.profileComparisonSchema],
    ]) {
      const result = resolveRequest(
        scenario,
        path,
        new URLSearchParams("marketId=CA_TSX"),
      );
      const check = schema.safeParse(result.body);
      if (result.status !== 200 || !check.success) {
        failures += 1;
        console.error(
          `healthy ${path}: HTTP ${result.status} ${JSON.stringify(check.error?.issues.slice(0, 3) ?? [])}`,
        );
      }
    }
  }
}

// US-scoped status must follow the scenario's runtime gate: enabled scenarios
// answer 200 with US operational counts; disabled ones keep the 409 guard the
// market-isolation policy requires instead of silently serving CA data.
for (const scenario of SCENARIOS) {
  const set = fixtureSet(scenario);
  for (const path of ["/api/system/status", "/api/market/status"]) {
    const result = resolveRequest(
      scenario,
      path,
      new URLSearchParams("marketId=US_EQUITIES"),
    );
    const expected = set.usEnabled ? 200 : 409;
    if (result.status !== expected) {
      failures += 1;
      console.error(
        `${scenario} ${path} (US): expected HTTP ${expected}, got ${result.status}`,
      );
    }
  }
}

if (failures) {
  console.error(`${failures} fixture validation failure(s)`);
  process.exit(1);
}
console.log(
  `fixtures valid: ${SCENARIOS.length} scenarios x ${CHECKS.length} endpoints`,
);
