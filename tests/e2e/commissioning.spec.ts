import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

const scannerUrl = process.env.E2E_SCANNER_URL ?? "http://127.0.0.1:8100";

async function expectJsonOk(request: APIRequestContext, path: string) {
  const response = await request.get(path);
  expect(response.status(), `${path}: ${await response.text()}`).toBe(200);
  return response.json() as Promise<Record<string, unknown>>;
}

async function openDashboard(page: Page) {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Live candidates" }),
  ).toBeVisible();
  await expect(page.locator(".system-pill")).toContainText("LIVE");
  await expect(page.locator(".error-banner")).toHaveCount(0);
}

test.describe("pre-commissioning operator workflow", () => {
  test("all services are ready and expose coherent core resources", async ({
    request,
  }) => {
    const live = await expectJsonOk(request, "/health/live");
    expect(live).toMatchObject({ service: "api", status: "ok" });

    // API readiness intentionally precedes asynchronous market initialization.
    // Wait for the mock market's first cycle without weakening its checks.
    await expect(async () => {
      const ready = await expectJsonOk(request, "/health/ready");
      expect(ready).toMatchObject({ service: "api", status: "ok" });
      expect(ready.checks).toMatchObject({
        database: { status: "ok" },
        scanner: { status: "ok" },
        marketData: { status: "ok" },
      });
    }).toPass({ timeout: 10_000 });

    const scanner = await request.get(`${scannerUrl}/health/ready`);
    expect(scanner.status(), await scanner.text()).toBe(200);
    await expect(scanner.json()).resolves.toMatchObject({
      service: "scanner",
      status: "ok",
    });

    const market = await expectJsonOk(request, "/api/market/status");
    expect(market.auth).toBe("CONNECTED");
    expect(["READY", "MARKET_CLOSED"]).toContain(market.state);
    expect(["UNKNOWN", "REALTIME", "DELAYED", "HALTED"]).toContain(
      market.dataStatus,
    );

    const universe = await expectJsonOk(request, "/api/universe");
    expect(universe.automation).toMatchObject({ provider: "MOCK_TSX_CATALOG" });
    expect((universe.instruments as unknown[]).length).toBeGreaterThan(0);

    const strategies = await expectJsonOk(request, "/api/strategies");
    const profiles = await expectJsonOk(request, "/api/scanner-profiles");
    expect((strategies.strategies as unknown[]).length).toBeGreaterThanOrEqual(
      2,
    );
    expect((profiles.profiles as unknown[]).length).toBeGreaterThanOrEqual(3);
  });

  test("dashboard loads its initial snapshot and every operator workspace", async ({
    page,
  }) => {
    await openDashboard(page);
    // The market-status bar was folded into the header nav, where the BOT
    // pill is the one piece of chrome still rendered straight from
    // /api/market/status. It reads "OFF" only when that snapshot never
    // reached the client, so asserting it is anything else is the same
    // check the old `.market-bar` "DATA" assertion made: the dashboard
    // hydrated from the live API rather than rendering empty chrome.
    const botStatus = page.locator(".nav-bot-status");
    await expect(botStatus).toBeVisible();
    await expect(botStatus).not.toContainText("OFF");
    await expect(page.locator("footer")).toContainText("MODE · MOCK");
    await expect(page.getByText("BTO.TO READY (E2E)")).toBeVisible();

    const workspaces = [
      [/^DAILY LIST/, "Daily candidate list"],
      [/^STRATEGY LAB$/, "Strategy Lab"],
      [/^LEARNING/, "Learning & Coordination"],
      [/^SCANNER$/, "Live candidates"],
    ] as const;

    for (const [button, heading] of workspaces) {
      await page.getByRole("button", { name: button }).click();
      await expect(
        page.getByRole("heading", { name: heading, exact: true }),
      ).toBeVisible();
      await expect(page.locator(".error-banner")).toHaveCount(0);
    }
  });

  test("manual universe refresh persists and returns its audit evidence", async ({
    page,
    request,
  }) => {
    await openDashboard(page);
    await page.getByRole("button", { name: /^DAILY LIST/ }).click();

    const refreshResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/universe/refresh" &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "REFRESH NOW" }).click();
    expect((await refreshResponse).status()).toBe(201);

    await expect(page.locator(".universe-health")).toContainText("COMPLETED");
    await expect(
      page.locator(".universe-history .universe-run").first(),
    ).toContainText("COMPLETED");

    const runs = await expectJsonOk(request, "/api/universe/runs?limit=20");
    expect((runs.runs as Array<{ status: string }>)[0]?.status).toBe(
      "COMPLETED",
    );
  });

  test("Phase 7 board filters, unavailable detail, and alert policy are operational", async ({
    page,
    request,
  }) => {
    const updated = await request.put("/api/alerts/policy", {
      data: {
        cooldownMinutes: 12,
        rearmRule: "AFTER_INVALIDATION",
        contextNotificationsEnabled: false,
      },
    });
    expect(updated.status(), await updated.text()).toBe(200);
    await openDashboard(page);

    // Alert settings live behind the header's ALERTS popover.
    await page.getByRole("button", { name: "Alert settings" }).click();
    await expect(page.getByLabel("Alert cooldown minutes")).toHaveValue("12");
    await expect(page.getByLabel("Alert re-arm rule")).toHaveValue(
      "AFTER_INVALIDATION",
    );
    await expect(
      page.getByText("CONTEXT · OFF", { exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByLabel("Scanner filters")).toBeVisible();
    await page.getByLabel("Scanner filters").click();
    await page.getByLabel("DATA READINESS").selectOption("WARMING");
    await expect(
      page
        .locator(".candidate-table .operator-row")
        .filter({ hasText: "BTO.TO" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "RESET" }).click();

    await page
      .locator(".candidate-table .operator-row")
      .filter({ hasText: "BTO.TO" })
      .click();
    await expect(
      page.getByRole("heading", { name: "Data readiness" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "State timeline and reasons" }),
    ).toBeVisible();
  });

  test("profile creation, duplication, and disablement stay synchronized", async ({
    page,
    request,
  }) => {
    await openDashboard(page);
    await page.getByRole("button", { name: "STRATEGY LAB" }).click();

    const profileName = "E2E Momentum Profile";
    await page.getByLabel("Name").fill(profileName);
    const createdResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/scanner-profiles") &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "CREATE PROFILE" }).click();
    expect((await createdResponse).status()).toBe(201);

    const createdRow = page
      .locator(".profile-row")
      .filter({ has: page.getByText(profileName, { exact: true }) });
    await expect(createdRow).toHaveCount(1);

    const duplicateResponse = page.waitForResponse(
      (response) =>
        response.url().includes("/duplicate") &&
        response.request().method() === "POST",
    );
    await createdRow.getByRole("button", { name: "DUPLICATE" }).click();
    expect((await duplicateResponse).status()).toBe(201);
    await expect(
      page.locator(".profile-row").filter({
        has: page.getByText(`${profileName} Copy`, { exact: true }),
      }),
    ).toHaveCount(1);

    const updateResponse = page.waitForResponse(
      (response) =>
        response.url().includes("/api/scanner-profiles/") &&
        response.request().method() === "PUT",
    );
    await createdRow.getByRole("button", { name: "ENABLED" }).click();
    expect((await updateResponse).status()).toBe(200);
    await expect(
      createdRow.getByRole("button", { name: "DISABLED" }),
    ).toBeVisible();

    const body = await expectJsonOk(request, "/api/scanner-profiles");
    const profiles = body.profiles as Array<{ name: string; enabled: boolean }>;
    expect(profiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: profileName, enabled: false }),
        expect.objectContaining({
          name: `${profileName} Copy`,
          enabled: false,
        }),
      ]),
    );
  });
});
