import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

/**
 * End-to-end acceptance for the automated paper-trading bot
 * (private development record, Phases 3, 5 and 6).
 *
 * The stack runs against the mock adapter, whose session date is long past, so
 * the market is CLOSED for the whole suite. Startup catch-up collects a
 * post-close mock book for recovery. Every outcome below is produced by the
 * durable path -- reconciliation plus the overdue-run sweep -- which is the
 * behaviour that decides whether forward evidence survives restarts. Intrabar
 * quote exits (TARGET/STOP against a live batch) are covered by the unit
 * suite, which can drive a synthetic clock.
 *
 * Fixtures: tests/e2e/fixtures/paper-bot-evidence.sql seeds the scenarios;
 * paper-bot-damage.sql reopens the crash window between two API restarts.
 */

/** Scenario ids follow the fixture: <prefix><suffix><1 signal|2 event|3 setup>. */
const EVENT = (suffix: string) => `50000000-0000-4000-8000-000000000${suffix}2`;

const SESSION_DATE = "2026-08-24";

interface Execution {
  observationId: string;
  model: "QUOTE" | "CANDLE";
  status: string;
  entryPrice: number | null;
  stopPrice: number | null;
  targetPrice: number | null;
  shares: number | null;
  exitPrice: number | null;
  exitReason: string | null;
  noFillReason: string | null;
  entrySizeCoverage: number | null;
}

interface Observation {
  id: string;
  runId: string;
  symbol: string;
  score: number;
  sourceEventId: string;
  sourceSignalId: string | null;
  eligibilityStatus: string;
  eligibilityReason: string | null;
}

async function getJson(request: APIRequestContext, path: string) {
  const response = await request.get(path);
  expect(response.status(), `${path}: ${await response.text()}`).toBe(200);
  return response.json() as Promise<Record<string, unknown>>;
}

async function observations(request: APIRequestContext) {
  const body = await getJson(request, "/api/paper-bot/observations?limit=200");
  return body.observations as Observation[];
}

async function executions(request: APIRequestContext) {
  const body = await getJson(request, "/api/paper-bot/executions?limit=200");
  return body.executions as Execution[];
}

/** The observation created for one seeded scenario, by its source event id. */
async function observationFor(request: APIRequestContext, suffix: string) {
  const found = (await observations(request)).find(
    (observation) => observation.sourceEventId === EVENT(suffix),
  );
  expect(found, `no observation for scenario ${suffix}`).toBeDefined();
  return found as Observation;
}

async function executionsFor(request: APIRequestContext, suffix: string) {
  const observation = await observationFor(request, suffix);
  const rows = (await executions(request)).filter(
    (execution) => execution.observationId === observation.id,
  );
  return {
    observation,
    quote: rows.find((row) => row.model === "QUOTE"),
    candle: rows.find((row) => row.model === "CANDLE"),
  };
}

test.describe("paper bot: observation and execution lifecycle", () => {
  test("opens exactly one live run for the session and settles it", async ({
    request,
  }) => {
    const body = await getJson(request, "/api/paper-bot/runs?limit=50");
    const runs = body.runs as Array<{
      source: string;
      sessionDate: string;
      status: string;
      executionModelVersion: string;
    }>;

    const live = runs.filter(
      (run) => run.source === "LIVE" && run.sessionDate === SESSION_DATE,
    );
    // The unique live-session index plus resume-on-restart: two API starts
    // must not produce two runs for one session.
    expect(live).toHaveLength(1);
    expect(live[0]?.executionModelVersion).toBe("paper-execution-v7");
    // Its regular close has long passed and nothing canonical is still resolvable, so
    // the sweep must not leave it RUNNING.
    expect(["COMPLETED", "CLOSE_PENDING"]).toContain(live[0]?.status);
  });

  test("every eligible READY lifecycle produces one observation and two executions", async ({
    request,
  }) => {
    for (const suffix of ["01", "02", "03", "04", "05", "06", "07", "08"]) {
      const { observation, quote, candle } = await executionsFor(
        request,
        suffix,
      );
      expect(observation.eligibilityStatus, `scenario ${suffix}`).toBe(
        "ELIGIBLE",
      );
      expect(quote, `scenario ${suffix} QUOTE execution`).toBeDefined();
      expect(candle, `scenario ${suffix} CANDLE execution`).toBeDefined();
    }
  });

  test("records source-signal provenance on every observation", async ({
    request,
  }) => {
    for (const suffix of ["01", "02", "03"]) {
      const observation = await observationFor(request, suffix);
      // Reconciliation reads the event only once its signal is durable, so a
      // null here means the observation lost its link to the evaluation that
      // produced it.
      expect(observation.sourceSignalId, `scenario ${suffix}`).not.toBeNull();
    }
  });

  test("fills the canonical quote model from the decision-time ask", async ({
    request,
  }) => {
    const { quote } = await executionsFor(request, "01");
    // v4 sizes from the configured risk budget against the cost-inclusive stop.
    expect(Number(quote?.entryPrice)).toBeCloseTo(7.90158, 5);
    expect(Number(quote?.shares)).toBe(164);
    expect(Number(quote?.stopPrice)).toBeCloseTo(7.6, 6);
    expect(Number(quote?.targetPrice)).toBeCloseTo(8.5, 6);
    expect(quote?.noFillReason).toBeNull();
    // The mock provider explicitly supplies shares, retained as coverage.
    expect(Number(quote?.entrySizeCoverage)).toBeCloseTo(900 / 164, 4);
    // Closed-market startup recovery collects one actual mock book. Preserve
    // its delayed-close provenance instead of pretending it filled at 16:00.
    expect(quote?.status).toBe("CLOSED");
    expect(quote?.exitReason).toBe("SESSION_CLOSE_DELAYED");
    expect(Number(quote?.exitPrice)).toBeCloseTo(7.818436, 5);
  });

  test("records a precise NO_FILL reason for every unavailable decision", async ({
    request,
  }) => {
    const expected: Record<string, string> = {
      "02": "MISSING_QUOTE",
      "03": "HALTED",
      "04": "STALE",
      "05": "SHARES_BELOW_ONE",
      "06": "DELAYED",
      "07": "EXECUTABLE_PRICE_OUTSIDE_LEVELS",
      "08": "MISSING_REFERENCE",
    };
    for (const [suffix, reason] of Object.entries(expected)) {
      const { quote } = await executionsFor(request, suffix);
      expect(quote?.status, `scenario ${suffix}`).toBe("NO_FILL");
      expect(quote?.noFillReason, `scenario ${suffix}`).toBe(reason);
      expect(quote?.entryPrice, `scenario ${suffix}`).toBeNull();
    }
  });

  test("closes the candle model on the regular-close bar from persisted history", async ({
    request,
  }) => {
    // The bar ending at the boundary exists only in the candle table; a live
    // collection batch never re-delivers it.
    const { candle } = await executionsFor(request, "01");
    expect(candle?.status).toBe("CLOSED");
    expect(candle?.exitReason).toBe("SESSION_CLOSE");
    // close 8.12 with 2bps exit slippage.
    expect(Number(candle?.exitPrice)).toBeCloseTo(8.118376, 5);
  });

  test("keeps the candle model independent of the quote feed", async ({
    request,
  }) => {
    // Scenario 02 has no decision-time quote at all, so the canonical model
    // records NO_FILL while the supplementary model still fills and closes.
    const { quote, candle } = await executionsFor(request, "02");
    expect(quote?.status).toBe("NO_FILL");
    expect(candle?.status).toBe("CLOSED");
    expect(candle?.exitReason).toBe("SESSION_CLOSE");
  });

  test("observes a below-cutoff signal without creating executions", async ({
    request,
  }) => {
    const observation = await observationFor(request, "09");
    expect(observation.eligibilityStatus).toBe("BELOW_SCORE_CUTOFF");
    expect(observation.eligibilityReason).toContain("70");

    const rows = (await executions(request)).filter(
      (execution) => execution.observationId === observation.id,
    );
    expect(rows).toHaveLength(0);
  });

  test("never observes a lifecycle that did not reach READY", async ({
    request,
  }) => {
    const found = (await observations(request)).find(
      (observation) => observation.sourceEventId === EVENT("10"),
    );
    expect(found).toBeUndefined();
  });

  test("repairs an observation whose execution child was lost to a crash", async ({
    request,
  }) => {
    // paper-bot-damage.sql deleted this CANDLE row between two API restarts.
    // Reconciliation skips events whose evidence is already complete, so this
    // only comes back if it also detects a missing child.
    const { quote, candle } = await executionsFor(request, "01");
    expect(
      candle,
      "CANDLE execution was not repaired on restart",
    ).toBeDefined();
    expect(candle?.status).toBe("CLOSED");
    // Repair must not reset the sibling that survived.
    expect(Number(quote?.entryPrice)).toBeCloseTo(7.90158, 5);
  });
});

test.describe("paper bot: close horizon and multi-session recovery", () => {
  test("abandons an unresolved close past the horizon", async ({ request }) => {
    const runs = (await getJson(request, "/api/paper-bot/runs?limit=50"))
      .runs as Array<{ sessionDate: string; status: string }>;
    const stale = runs.find((run) => run.sessionDate === "2026-08-10");
    expect(stale, "seeded 2026-08-10 run is missing").toBeDefined();
    // Two later sessions exist, so it can no longer be filled from an
    // unrelated session and must stop holding its run open.
    expect(stale?.status).toBe("COMPLETED");

    const rows = (await executions(request)).filter(
      (execution) =>
        execution.observationId === "50000000-0000-4000-8000-0000000000a1",
    );
    expect(rows).toHaveLength(1);
    // Abandoned, not closed: it keeps CLOSE_PENDING so it stays out of every
    // closed-trade statistic and is reported as unresolved.
    expect(rows[0]?.status).toBe("CLOSE_PENDING");
    expect(rows[0]?.exitReason).toBeNull();
    expect(rows[0]?.exitPrice).toBeNull();
  });

  test("keeps a run within the horizon eligible for a later actionable bid", async ({
    request,
  }) => {
    const runs = (await getJson(request, "/api/paper-bot/runs?limit=50"))
      .runs as Array<{ sessionDate: string; status: string }>;
    const waiting = runs.find((run) => run.sessionDate === "2026-08-17");
    expect(waiting?.status).toBe("COMPLETED");

    const rows = (await executions(request)).filter(
      (execution) =>
        execution.observationId === "50000000-0000-4000-8000-0000000000b1",
    );
    expect(rows[0]?.status).toBe("CLOSED");
    expect(rows[0]?.exitReason).toBe("SESSION_CLOSE_DELAYED");
  });
});

test.describe("paper bot: operational visibility", () => {
  test("reports paper lifecycle health on the market status snapshot", async ({
    request,
  }) => {
    const market = await getJson(request, "/api/market/status");
    const paperBot = market.paperBot as Record<string, unknown>;
    expect(paperBot, "market status carries no paperBot block").toBeDefined();
    expect(paperBot.executionModelVersion).toBe("paper-execution-v7");
    expect(paperBot.sessionDate).toBe(SESSION_DATE);
    // A healthy process must not be able to hide a stuck paper lifecycle.
    for (const key of [
      "reconciliationBacklog",
      "unreconcilableEvents",
      "overdueRuns",
      "unresolvedCoordinatedPositions",
      "completedRunsWithUnresolvedCoordinatedPositions",
      "oldestUnresolvedCoordinatedAgeMs",
      "unknownQuoteSizeUnits",
      "abandonedExecutions",
      "closePendingExecutions",
      "lastError",
    ]) {
      expect(paperBot, `missing operational signal ${key}`).toHaveProperty(key);
    }
    expect(paperBot.lastError).toBeNull();
  });
});

test.describe("paper bot: evidence reporting", () => {
  test("every reporting resource answers with production-shaped rows", async ({
    request,
  }) => {
    for (const resource of [
      "runs",
      "observations",
      "executions",
      "aggregates",
      "curves",
      "divergences",
      "comparisons",
      "qualifications",
      "commission-sensitivity",
      "coordination/decisions",
      "coordination/summary",
      "journal",
    ]) {
      const response = await request.get(`/api/paper-bot/${resource}`);
      expect(response.status(), `${resource}: ${await response.text()}`).toBe(
        200,
      );
    }
  });

  test("keeps the coordinated projection separate from independent evidence", async ({
    request,
  }) => {
    // ADR-010: the two projections answer different questions and are never
    // summed. The coordinated surface must therefore exist on its own and
    // carry its own totals, even when the shadow portfolio traded nothing.
    const summary = (
      await getJson(request, "/api/paper-bot/coordination/summary?source=LIVE")
    ).summary as Record<string, unknown>;
    for (const key of [
      "decisions",
      "approved",
      "deferred",
      "rejected",
      "reasons",
      "openPositions",
      "closedTrades",
      "netPnl",
      "cumulativeR",
      "repeatedSymbolEntries",
    ]) {
      expect(summary, `coordination summary is missing ${key}`).toHaveProperty(
        key,
      );
    }
    const decisions = (
      await getJson(
        request,
        "/api/paper-bot/coordination/decisions?source=LIVE&limit=50",
      )
    ).decisions as Array<{ outcome: string; selectedObservationId: unknown }>;
    for (const decision of decisions) {
      expect(["APPROVED", "REJECTED", "DEFERRED"]).toContain(decision.outcome);
      // Only an approval owns a position; a suppression must select nothing.
      if (decision.outcome !== "APPROVED")
        expect(decision.selectedObservationId).toBeNull();
    }
  });

  test("serves one P&L journal projection at a time", async ({ request }) => {
    // ADR-010: each projection is its own ledger with its own totals, and only
    // the coordinated one is readable as a single account's running balance.
    for (const projection of ["COORDINATED", "INDEPENDENT"] as const) {
      const body = (await getJson(
        request,
        `/api/paper-bot/journal?source=LIVE&projection=${projection}&limit=100`,
      )) as {
        projection: string;
        entries: Array<{
          status: string;
          netPnl: number | null;
          runningNetPnl: number | null;
        }>;
        totals: Record<string, unknown>;
      };
      expect(body.projection).toBe(projection);
      for (const key of [
        "closedTrades",
        "openPositions",
        "wins",
        "losses",
        "netPnl",
        "costs",
        "cumulativeR",
      ]) {
        expect(
          body.totals,
          `${projection} totals is missing ${key}`,
        ).toHaveProperty(key);
      }
      for (const entry of body.entries) {
        // The journal reports trades: no-fills and declined candidates are not
        // P&L lines and must never appear in it.
        expect(["OPEN", "CLOSE_PENDING", "CLOSED"]).toContain(entry.status);
        if (entry.status !== "CLOSED") expect(entry.netPnl).toBeNull();
        // A running balance exists only where one account held the positions.
        if (projection === "INDEPENDENT" || entry.status !== "CLOSED")
          expect(entry.runningNetPnl).toBeNull();
      }
    }

    const invalid = await request.get("/api/paper-bot/journal?projection=BOTH");
    expect(invalid.status()).toBe(400);
  });

  test("commission sensitivity re-prices closed evidence without rewriting it", async ({
    request,
  }) => {
    const before = (
      await getJson(request, "/api/paper-bot/executions?limit=200")
    ).executions as Array<{ id: string; netPnl: number | null }>;
    const body = await getJson(
      request,
      "/api/paper-bot/commission-sensitivity?source=LIVE&commissions=0,9.95",
    );
    for (const sensitivity of body.sensitivities as Array<{
      scenarios: Array<{ roundTripCommission: number; netPnl: number }>;
    }>) {
      expect(
        sensitivity.scenarios.map((value) => value.roundTripCommission),
      ).toEqual([0, 9.95]);
      // A costlier schedule can never improve a closed cohort's net result.
      expect(sensitivity.scenarios[1]!.netPnl).toBeLessThanOrEqual(
        sensitivity.scenarios[0]!.netPnl,
      );
    }
    // The live bot may open or close further executions between the two
    // reads, so compare the rows present in both: re-pricing is a report, and
    // must never write back to the evidence it re-prices.
    const priorNetPnl = new Map(before.map((row) => [row.id, row.netPnl]));
    const after = (
      await getJson(request, "/api/paper-bot/executions?limit=200")
    ).executions as Array<{ id: string; netPnl: number | null }>;
    for (const row of after) {
      if (!priorNetPnl.has(row.id)) continue;
      expect(row.netPnl, `execution ${row.id} was rewritten`).toEqual(
        priorNetPnl.get(row.id),
      );
    }
  });

  test("aggregates report numerators and denominators and exclude unresolved trades", async ({
    request,
  }) => {
    const body = await getJson(
      request,
      "/api/paper-bot/aggregates?source=LIVE&model=QUOTE",
    );
    const aggregates = body.aggregates as Array<{
      cohort: {
        profileName: string;
        executionModelVersion: string;
        assumptions: { positionSize: number };
      };
      signalCount: number;
      noFills: number;
      closedTrades: number;
      unresolvedExecutions: number;
      fillRate: { numerator: number; denominator: number };
    }>;
    expect(aggregates.length).toBeGreaterThan(0);

    // A cohort is an exact (profile configuration, model version, assumptions)
    // tuple, so the earlier stranded runs -- seeded with different assumptions
    // -- are a separate cohort from this session's. Select by position size to
    // pin the one the live processor produced rather than whichever sorts
    // first, which is the whole point of cohort-exact aggregation.
    const cohort = aggregates.find(
      (aggregate) =>
        aggregate.cohort.profileName === "ORB Standard" &&
        aggregate.cohort.assumptions.positionSize === 3_000,
    );
    expect(cohort, "no cohort for this session's assumptions").toBeDefined();
    // Every rate carries its own denominator, so a small sample is legible
    // rather than being presented as a bare percentage.
    expect(cohort?.fillRate.denominator).toBeGreaterThan(0);
    expect(cohort?.noFills).toBeGreaterThan(0);
    // The current session recovered one quote close. Of the two older runs,
    // the eligible one recovers and the abandoned one stays unresolved.
    expect(cohort?.closedTrades).toBe(1);
    expect(cohort?.unresolvedExecutions).toBe(0);
    const stranded = aggregates.filter(
      (aggregate) =>
        aggregate.cohort.executionModelVersion === "paper-execution-v1",
    );
    expect(stranded).toHaveLength(1);
    expect(stranded[0]?.closedTrades).toBe(1);
    expect(stranded[0]?.unresolvedExecutions).toBe(1);
  });

  test("divergence entry samples count only comparable quote/candle pairs", async ({
    request,
  }) => {
    const body = await getJson(request, "/api/paper-bot/divergences");
    const divergences = body.divergences as Array<{
      cohort: { profileName: string };
      pairedExecutions: number;
      entryPriceDifference: { sampleCount: number; average: number | null };
    }>;
    const cohort = divergences.find(
      (divergence) =>
        divergence.cohort.profileName === "ORB Standard" &&
        divergence.pairedExecutions > 1,
    );
    expect(cohort).toBeDefined();
    // Scenario 02 pairs a NO_FILL quote with a filled candle: it is a paired
    // execution but not a comparable entry, so it must not inflate the sample
    // count behind the average.
    expect(cohort!.entryPriceDifference.sampleCount).toBeLessThan(
      cohort!.pairedExecutions,
    );
  });
});

test.describe("paper bot: at-a-glance status indicator", () => {
  test("shows bot health in the header nav on every view", async ({ page }) => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "Live candidates" }),
    ).toBeVisible();

    const indicator = page.locator(".nav-bot-status");
    await expect(indicator).toBeVisible();
    // The old run now closes from its first persisted actionable bid. Any
    // remaining repair backlog must still read as attention, never healthy.
    await expect(indicator).toContainText("BOT · CATCHING UP");
    await expect(indicator.locator(".bot-dot.attention")).toHaveCount(1);

    // The nav is chrome, not a view: it has to stay put when the operator
    // moves elsewhere, which is what makes it at-a-glance.
    await page.getByRole("button", { name: /^DAILY LIST/ }).click();
    await expect(
      page.getByRole("heading", { name: "Daily candidate list" }),
    ).toBeVisible();
    await expect(indicator).toContainText("BOT · CATCHING UP");
  });

  test("carries the run's cohort identity and counts in its tooltip", async ({
    request,
  }) => {
    // The indicator is derived from this block, so the counts behind it must
    // be populated even though the market is closed and no cycle is running.
    const market = await getJson(request, "/api/market/status");
    const paperBot = market.paperBot as Record<string, number | string | null>;
    expect(paperBot.sessionDate).toBe(SESSION_DATE);
    expect(paperBot.executionModelVersion).toBe("paper-execution-v7");
    expect(Number(paperBot.noFillExecutions)).toBeGreaterThan(0);
    expect(Number(paperBot.closedExecutions)).toBeGreaterThan(0);
    expect(paperBot.reconciliationBacklog).not.toBeNull();
  });
});

test.describe("paper bot: BOT dashboard", () => {
  async function openBot(page: Page) {
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "Live candidates" }),
    ).toBeVisible();
    await page.getByRole("button", { name: /^BOT ·/ }).click();
    await expect(
      page.getByRole("heading", { name: "BOT evidence", exact: true }),
    ).toBeVisible();
  }

  test("renders accumulated forward evidence without errors", async ({
    page,
  }) => {
    await openBot(page);
    await expect(page.locator(".error-banner")).toHaveCount(0);
    await expect(page.getByText("Forward paper evidence")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: /Canonical performance/ }),
    ).toBeVisible();
    // Panels are driven by real accumulated rows, not fixtures baked into the
    // component.
    await expect(page.locator(".bot-cohort").first()).toContainText(
      "ORB Standard",
    );
  });

  test("shows no-fill and unresolved evidence rather than hiding it", async ({
    page,
  }) => {
    await openBot(page);
    await expect(
      page.getByRole("heading", { name: /Fillability and data quality/ }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: /Fillability and data quality/ })
      .click();
    const quality = page.locator(".bot-quality");
    await expect(quality).toBeVisible();
    // The reasons a fill was unavailable are the point of the panel. Reason
    // codes are rendered with spaces rather than underscores.
    await expect(quality).toContainText("MISSING QUOTE");
    await expect(quality).toContainText("HALTED");
    await expect(quality).toContainText("STALE");
    // Size coverage below one is fidelity evidence that must stay visible.
    await expect(quality).toContainText("BELOW ONE");
    await expect(page.locator(".error-banner")).toHaveCount(0);
  });
});
