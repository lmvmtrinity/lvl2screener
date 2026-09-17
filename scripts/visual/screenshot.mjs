// Deterministic screenshots of the scanner web app against local fixtures.
//
//   node scripts/visual/screenshot.mjs [--scenarios=healthy,waiting]
//                                      [--pages=SCANNER,BOT]
//                                      [--markets=CA,US]
//                                      [--skip-section] [--keep-shots]
//
// Build the workspace first (`pnpm build`, or at least the contracts package)
// because fixtures import the compiled contracts. Starts the fixture API
// (server.mjs, port 5198) in-process, spawns the real Vite dev server (port
// 5199, config beside this file), drives Edge through playwright, and writes
// PNG/TXT/layout/error evidence under ./shots (gitignored).
//
// US captures require the scenario's fixtures to enable the US runtime; other
// scenarios are skipped for US with a log line. Override the browser path with
// EDGE_PATH when Edge is not installed in the default location.
/* global window, document */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { resolvePnpmCommand } from "../lib/command-resolution.mjs";
import { fixtureSet, FIXTURE_NOW_MS } from "./fixtures.mjs";
import { startVisualServer } from "./server.mjs";

const VISUAL_DIR = dirname(fileURLToPath(import.meta.url));
const SHOTS_DIR = join(VISUAL_DIR, "shots");
const VITE_CONFIG = join(VISUAL_DIR, "vite.visual.config.mjs").replaceAll(
  "\\",
  "/",
);
const EDGE_PATH =
  process.env.EDGE_PATH ??
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const APP_URL = "http://localhost:5199/";
const FIXTURE_API = "http://127.0.0.1:5198";
const APP_DIR = join(VISUAL_DIR, "..", "..");

const PAGES = [
  "SCANNER",
  "DETAIL",
  "DAILY",
  "DISCOVERY",
  "BOT",
  "PERFORMANCE",
  "LEARNING",
  "LAB",
  "BACKTESTS",
];
const SCENARIOS = ["healthy", "waiting", "failure", "empty"];
// Decorative pulses fade on a timer, so two captures of the same state can
// differ by animation phase. Freeze them for deterministic evidence.
const DISABLE_ANIMATIONS_CSS =
  "*, *::before, *::after { animation: none !important; transition: none !important; }";
const MARKETS = { CA: "CA_TSX", US: "US_EQUITIES" };
const VIEWPORTS = [
  { width: "desktop", size: { width: 1440, height: 900 } },
  { width: "narrow", size: { width: 390, height: 844 } },
];

function argValue(name) {
  const prefix = `--${name}=`;
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

const selectedScenarios = (argValue("scenarios") ?? SCENARIOS.join(","))
  .split(",")
  .filter(Boolean);
const selectedPages = (argValue("pages") ?? PAGES.join(","))
  .split(",")
  .map((value) => value.toUpperCase())
  .filter(Boolean);
const selectedMarkets = (argValue("markets") ?? "CA,US")
  .split(",")
  .map((value) => value.toUpperCase())
  .filter(Boolean);
for (const market of selectedMarkets)
  if (!MARKETS[market]) throw new Error(`Unknown market ${market}`);
const skipSection = process.argv.includes("--skip-section");
const keepShots = process.argv.includes("--keep-shots");
// `--with-toast` sends a second live frame carrying a fresh alert after the
// main capture, so the SCANNER alert-popover section also captures the toast
// stack. The default matrix stays unchanged for baseline comparison.
const withToast = process.argv.includes("--with-toast");

async function waitForHttp(url, { timeoutMs = 90_000, child } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null)
      throw new Error(`Vite exited early with code ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`${url} returned HTTP ${response.status}`);
    } catch (reason) {
      lastError = reason;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Timed out waiting for ${url}: ${String(lastError)}`);
}

async function postScenario(name) {
  const response = await fetch(`${FIXTURE_API}/__scenario`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!response.ok)
    throw new Error(`Scenario switch to ${name} failed: ${response.status}`);
}

function websocketInitScript(scenario, includeToast) {
  const frame =
    scenario === "failure"
      ? {
          type: "snapshot",
          timestamp: new Date().toISOString(),
          market: {
            state: "DEGRADED",
            dataStatus: "STALE",
            lastError: "quote feed delayed for 3 symbols",
          },
          seq: 1,
          version: 1,
        }
      : {
          type: "snapshot",
          timestamp: new Date().toISOString(),
          market: {
            state: scenario === "waiting" ? "CLOSED" : "ACTIVE",
            dataStatus: scenario === "waiting" ? "DELAYED" : "REALTIME",
          },
          seq: 1,
          version: 1,
        };
  let toastFrame = null;
  if (includeToast) {
    const existing = fixtureSet(scenario).alerts.alerts;
    const template = existing[0];
    if (template)
      toastFrame = {
        ...frame,
        seq: 2,
        timestamp: new Date().toISOString(),
        alerts: [
          {
            ...template,
            alertId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
            eventId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            setupInstanceId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
            timestamp: new Date().toISOString(),
          },
        ],
      };
  }
  return `(() => {
    const frame = ${JSON.stringify(frame)};
    const toastFrame = ${JSON.stringify(toastFrame)};
    window.__wsFrame = frame;
    class FakeWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      constructor(url) {
        this.url = String(url);
        this.readyState = 0;
        this.onopen = null;
        this.onmessage = null;
        this.onclose = null;
        this.onerror = null;
        this._listeners = { open: [], message: [], close: [], error: [] };
        const isScannerSocket = this.url.includes("/ws?") || this.url.includes("marketId=");
        if (isScannerSocket) {
          setTimeout(() => {
            if (this.readyState === 3) return;
            this.readyState = 1;
            const openEvent = {};
            this._emit("open", openEvent);
            if (this.onopen) this.onopen(openEvent);
            setTimeout(() => {
              if (this.readyState === 3) return;
              const messageEvent = { data: JSON.stringify(frame) };
              this._emit("message", messageEvent);
              if (this.onmessage) this.onmessage(messageEvent);
            }, 30);
            if (toastFrame) {
              setTimeout(() => {
                if (this.readyState === 3) return;
                const messageEvent = { data: JSON.stringify(toastFrame) };
                this._emit("message", messageEvent);
                if (this.onmessage) this.onmessage(messageEvent);
              }, 1600);
            }
          }, 10);
        }
      }
      _emit(type, event) {
        for (const listener of this._listeners[type] ?? []) {
          try { listener(event); } catch (error) { void error; }
        }
      }
      addEventListener(type, listener) {
        (this._listeners[type] ??= []).push(listener);
      }
      removeEventListener(type, listener) {
        this._listeners[type] = (this._listeners[type] ?? []).filter((item) => item !== listener);
      }
      send() {}
      close() {
        if (this.readyState === 3) return;
        this.readyState = 3;
        const event = {};
        this._emit("close", event);
        if (this.onclose) this.onclose(event);
      }
    }
    window.WebSocket = FakeWebSocket;
  })();`;
}

const NAV_MATCHERS = {
  SCANNER: [{ role: "button", name: "SCANNER", exact: true }],
  DETAIL: [{ role: "button", name: "SCANNER", exact: true }],
  DAILY: [{ role: "button", name: /^DAILY LIST/ }],
  DISCOVERY: [{ role: "button", name: "DISCOVERY", exact: true }],
  BOT: [
    { role: "button", name: /^BOT · / },
    { role: "button", name: "BOT", exact: true },
  ],
  PERFORMANCE: [{ role: "button", name: "BOT PERFORMANCE", exact: true }],
  LEARNING: [{ role: "button", name: "LEARNING", exact: true }],
  LAB: [{ role: "button", name: "STRATEGY LAB", exact: true }],
  BACKTESTS: [{ role: "button", name: "BACKTESTS", exact: true }],
};

const PAGE_SECTIONS = {
  SCANNER: [
    {
      name: "alerts",
      matchers: [{ role: "button", name: "Alert settings" }],
    },
  ],
  DETAIL: [
    { name: "back", matchers: [{ role: "button", name: "← All candidates" }] },
  ],
  DAILY: [
    {
      name: "warmup",
      optional: true,
      matchers: [{ role: "button", name: "Warm-up stages for TD.TO" }],
    },
    {
      name: "paste",
      action: async (page) => {
        await page
          .getByLabel("TradingView symbols")
          .fill("SHOP.TO, TSX:RY\nTD.TO, BTC:USD");
        await page.getByRole("button", { name: "ADD CANDIDATES" }).click();
      },
    },
  ],
  DISCOVERY: [
    { name: "results", matchers: [{ role: "button", name: /^results$/i }] },
  ],
  BOT: [
    { name: "results", matchers: [{ role: "button", name: /^results$/i }] },
    {
      name: "diagnostics",
      matchers: [{ role: "button", name: /^diagnostics$/i }],
    },
  ],
  PERFORMANCE: [
    {
      name: "independent",
      matchers: [{ role: "button", name: "INDEPENDENT", exact: true }],
    },
  ],
  LEARNING: [
    { name: "processes", matchers: [{ role: "button", name: /^processes$/i }] },
    { name: "results", matchers: [{ role: "button", name: /^results$/i }] },
    {
      name: "diagnostics",
      matchers: [{ role: "button", name: /^diagnostics$/i }],
    },
  ],
  LAB: [
    {
      name: "edit",
      optional: true,
      action: async (page) => {
        await page
          .locator(".profile-row")
          .first()
          .getByRole("button", { name: "EDIT", exact: true })
          .click();
      },
    },
    {
      name: "compare",
      optional: true,
      action: async (page) => {
        const compareBoxes = page.getByRole("checkbox", { name: /^Compare / });
        await compareBoxes.nth(0).check();
        await compareBoxes.nth(1).check();
        await page.getByRole("button", { name: /^COMPARE · 2$/ }).click();
      },
    },
  ],
  BACKTESTS: [
    { name: "results", matchers: [{ role: "tab", name: /^results$/i }] },
    { name: "history", matchers: [{ role: "tab", name: /^history$/i }] },
    {
      name: "detail",
      optional: true,
      action: async (page) => {
        await page.getByRole("tab", { name: /^results$/i }).click();
        await page.waitForTimeout(300);
        await page.locator(".result-main button").first().click();
      },
    },
    {
      name: "manual",
      optional: true,
      matchers: [{ role: "button", name: "Manual replay", exact: true }],
    },
    {
      name: "settings",
      optional: true,
      action: async (page) => {
        await page.keyboard.press("Escape");
        await page.waitForTimeout(300);
        await page.getByRole("tab", { name: /^overview$/i }).click();
        await page.waitForTimeout(300);
        await page
          .getByRole("button", { name: "Automation settings", exact: true })
          .click();
      },
    },
  ],
};

async function clickFirstMatch(scope, matchers) {
  let lastError;
  for (const matcher of matchers) {
    const locator = scope.getByRole(matcher.role, {
      name: matcher.name,
      ...(matcher.exact ? { exact: true } : {}),
    });
    const count = await locator.count();
    if (count > 0) {
      await locator.first().click();
      return true;
    }
    lastError = new Error(`no match for ${String(matcher.name)}`);
  }
  throw lastError;
}

const evidence = {
  generatedAt: new Date().toISOString(),
  captures: [],
  navigationErrors: [],
  pageErrors: [],
  consoleErrors: [],
  failedRequests: [],
  badResponses: [],
  bannerMatches: [],
  overflow: [],
};

const BANNER_PATTERNS = [
  "Unable to load",
  "Failed to load",
  "Dashboard unavailable",
  "could not be validated",
];

function attachDiagnostics(page, context) {
  page.on("pageerror", (error) => {
    evidence.pageErrors.push({
      ...context,
      message: String(error?.message ?? error),
    });
  });
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    if (message.text().includes("Download the React DevTools")) return;
    const location = message.location();
    evidence.consoleErrors.push({
      ...context,
      message: message.text(),
      sourceUrl: location.url || undefined,
    });
  });
  page.on("requestfailed", (request) => {
    const failure = request.failure();
    const error = failure?.errorText ?? "request failed";
    evidence.failedRequests.push({
      ...context,
      url: request.url(),
      method: request.method(),
      error,
      // React StrictMode double-mounts effects in the dev server, so the first
      // bootstrap round is aborted on purpose; page teardown also aborts
      // in-flight polling. Record them, but do not treat them as failures.
      expectedAbort: error === "net::ERR_ABORTED",
    });
  });
  page.on("response", (response) => {
    if (response.status() < 400) return;
    evidence.badResponses.push({
      ...context,
      url: response.url(),
      status: response.status(),
    });
  });
}

async function capture(
  page,
  pageName,
  scenario,
  market,
  width,
  stage,
  fileBase,
) {
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    text: document.body.innerText,
  }));
  const overflowX = metrics.scrollWidth > metrics.innerWidth + 2;
  const record = {
    page: pageName,
    scenario,
    market,
    width,
    stage,
    screenshot: `${fileBase}.png`,
    text: `${fileBase}.txt`,
    scrollWidth: metrics.scrollWidth,
    innerWidth: metrics.innerWidth,
    overflowX,
  };
  evidence.captures.push(record);
  if (overflowX) evidence.overflow.push(record);
  evidence.bannerMatches.push(
    ...BANNER_PATTERNS.filter((pattern) => metrics.text.includes(pattern)).map(
      (pattern) => ({
        page: pageName,
        scenario,
        market,
        width,
        stage,
        pattern,
      }),
    ),
  );
  await page.screenshot({
    path: join(SHOTS_DIR, `${fileBase}.png`),
    fullPage: true,
  });
  writeFileSync(join(SHOTS_DIR, `${fileBase}.txt`), metrics.text, "utf8");
}

async function openPage(page, pageName, market) {
  await page.goto(APP_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const nav = page.locator('nav[aria-label="Sections"]');
  await nav.waitFor({ state: "visible", timeout: 45_000 });
  await page.addStyleTag({ content: DISABLE_ANIMATIONS_CSS });
  if (market === "US") {
    await page.getByLabel("Market").selectOption(MARKETS[market]);
    await page.waitForTimeout(600);
  }
  await clickFirstMatch(nav, NAV_MATCHERS[pageName]);
  if (pageName === "DETAIL") {
    const row = page.locator("button.operator-row").first();
    await row.waitFor({ state: "visible", timeout: 30_000 });
    await row.click();
  }
  await page.waitForTimeout(900);
}

async function main() {
  if (!existsSync(EDGE_PATH)) throw new Error(`Edge not found at ${EDGE_PATH}`);
  if (!keepShots) rmSync(SHOTS_DIR, { recursive: true, force: true });
  mkdirSync(SHOTS_DIR, { recursive: true });

  const serverHandle = await startVisualServer({ port: 5198 });
  const pnpm = resolvePnpmCommand();
  const vite = spawn(
    pnpm,
    [
      "--filter",
      "@tsx-scanner/web",
      "exec",
      "vite",
      "--config",
      VITE_CONFIG,
      "--port",
      "5199",
      "--strictPort",
    ],
    {
      cwd: APP_DIR,
      shell: true,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let viteOutput = "";
  vite.stdout.on("data", (chunk) => (viteOutput += chunk.toString()));
  vite.stderr.on("data", (chunk) => (viteOutput += chunk.toString()));

  let browser;
  const stopVite = () => {
    if (vite.exitCode === null && vite.pid) {
      spawnSync("taskkill", ["/pid", String(vite.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    }
  };
  const cleanup = async () => {
    try {
      if (browser) await browser.close();
    } catch {
      // best effort only
    }
    stopVite();
    await serverHandle.close();
  };
  process.on("SIGINT", () => {
    void cleanup().then(() => process.exit(130));
  });
  process.on("SIGTERM", () => {
    void cleanup().then(() => process.exit(143));
  });

  try {
    await waitForHttp(APP_URL, { child: vite });
    console.log(`Vite ready at ${APP_URL}`);

    browser = await chromium.launch({
      executablePath: EDGE_PATH,
      headless: true,
    });

    for (const scenario of selectedScenarios) {
      await postScenario(scenario);
      const usEnabled = fixtureSet(scenario).usEnabled === true;
      for (const market of selectedMarkets) {
        if (market === "US" && !usEnabled) {
          console.log(`skipped US for ${scenario}: fixture runtime disabled`);
          continue;
        }
        for (const pageName of selectedPages) {
          if (
            pageName === "DETAIL" &&
            (market === "US" || !fixtureSet(scenario).candidateDetails)
          ) {
            console.log(`skipped DETAIL for ${scenario} ${market}: no rows`);
            continue;
          }
          for (const viewport of VIEWPORTS) {
            const context = await browser.newContext({
              viewport: viewport.size,
              deviceScaleFactor: 1,
            });
            // The app ships no favicon; swallow the dev-server 404 so the only
            // console errors reported are real application ones.
            await context.route("**/favicon.ico", (route) =>
              route.fulfill({ status: 204, body: "" }),
            );
            const page = await context.newPage();
            // Freeze the browser clock to the fixture anchor so relative
            // timestamps and countdowns render the same in every capture.
            await page.clock.setFixedTime(new Date(FIXTURE_NOW_MS));
            await page.addInitScript({
              content: websocketInitScript(scenario, withToast),
            });
            const diagnostics = {
              page: pageName,
              scenario,
              market,
              width: viewport.width,
            };
            attachDiagnostics(page, diagnostics);
            try {
              await openPage(page, pageName, market);
              const prefix = `${pageName.toLowerCase()}-${scenario}-${market.toLowerCase()}`;
              await capture(
                page,
                pageName,
                scenario,
                market,
                viewport.width,
                "main",
                `${prefix}-${viewport.width}`,
              );
              if (viewport.width === "desktop" && !skipSection) {
                for (const section of PAGE_SECTIONS[pageName]) {
                  try {
                    if (section.action) await section.action(page);
                    else await clickFirstMatch(page, section.matchers);
                  } catch (reason) {
                    if (section.optional) {
                      console.log(
                        `skipped ${pageName} section ${section.name} for ${scenario} ${market}: ${String(reason?.message ?? reason)}`,
                      );
                      continue;
                    }
                    throw reason;
                  }
                  await page.waitForTimeout(900);
                  await capture(
                    page,
                    pageName,
                    scenario,
                    market,
                    viewport.width,
                    `section-${section.name}`,
                    `${prefix}-section-${section.name}`,
                  );
                }
              }
            } catch (reason) {
              evidence.navigationErrors.push({
                ...diagnostics,
                message: String(reason?.message ?? reason),
              });
            } finally {
              await context.close();
            }
          }
        }
        console.log(`captured ${scenario} ${market}`);
      }
    }
  } catch (reason) {
    console.error(`harness failure: ${String(reason?.stack ?? reason)}`);
    if (viteOutput.trim()) {
      console.error("--- vite output (tail) ---");
      console.error(viteOutput.trim().split(/\r?\n/).slice(-20).join("\n"));
    }
    process.exitCode = 1;
  } finally {
    await cleanup();
  }

  writeFileSync(
    join(SHOTS_DIR, "layout.json"),
    JSON.stringify(
      {
        generatedAt: evidence.generatedAt,
        viewports: Object.fromEntries(
          VIEWPORTS.map((entry) => [entry.width, entry.size]),
        ),
        captures: evidence.captures,
        overflow: evidence.overflow,
      },
      null,
      2,
    ),
    "utf8",
  );
  writeFileSync(
    join(SHOTS_DIR, "errors.json"),
    JSON.stringify(
      {
        generatedAt: evidence.generatedAt,
        pageErrors: evidence.pageErrors,
        consoleErrors: evidence.consoleErrors,
        badResponses: evidence.badResponses,
        failedRequests: evidence.failedRequests,
        navigationErrors: evidence.navigationErrors,
        bannerMatches: evidence.bannerMatches,
      },
      null,
      2,
    ),
    "utf8",
  );

  const failed =
    evidence.pageErrors.length +
    evidence.navigationErrors.length +
    evidence.bannerMatches.length;
  if (evidence.pageErrors.length || evidence.navigationErrors.length)
    process.exitCode = 1;

  console.log("");
  console.log(`screenshots: ${evidence.captures.length} in ${SHOTS_DIR}`);
  const unexpectedFailures = evidence.failedRequests.filter(
    (item) => !item.expectedAbort,
  ).length;
  console.log(
    `page errors: ${evidence.pageErrors.length} | console errors: ${evidence.consoleErrors.length} | bad responses: ${evidence.badResponses.length} | failed requests: ${evidence.failedRequests.length} (${unexpectedFailures} unexpected)`,
  );
  console.log(
    `navigation errors: ${evidence.navigationErrors.length} | error banners in text: ${evidence.bannerMatches.length}`,
  );
  const overflowByPage = new Map();
  for (const item of evidence.overflow) {
    const key = `${item.page}/${item.width}/${item.stage}`;
    overflowByPage.set(key, (overflowByPage.get(key) ?? 0) + 1);
  }
  console.log(
    overflowByPage.size
      ? `overflowX: ${[...overflowByPage.entries()].map(([key, count]) => `${key}=${count}`).join(", ")}`
      : "overflowX: none",
  );
  for (const item of evidence.navigationErrors.slice(0, 5))
    console.log(`nav error ${item.page}/${item.scenario}: ${item.message}`);
  for (const item of evidence.bannerMatches.slice(0, 10))
    console.log(
      `banner ${item.page}/${item.scenario}/${item.width}/${item.stage}: "${item.pattern}"`,
    );
  if (failed) console.log(`FAILURES RECORDED (see shots/errors.json)`);
}

await main();
