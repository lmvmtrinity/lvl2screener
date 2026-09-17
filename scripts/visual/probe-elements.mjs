// One-off diagnostic: print bounding boxes and computed styles for selectors.
//
//   node scripts/visual/probe-elements.mjs [scenario] [PAGE] [CA|US] selector...
//
// The navigation always opens the page fresh, matching screenshot.mjs, so a
// candidate layout can be compared with the preserved baseline captures.
/* global document, getComputedStyle */
import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { resolvePnpmCommand } from "../lib/command-resolution.mjs";
import { startVisualServer } from "./server.mjs";

const VISUAL_DIR = dirname(fileURLToPath(import.meta.url));
const APP_URL = "http://localhost:5199/";
const EDGE =
  process.env.EDGE_PATH ??
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PNPM = resolvePnpmCommand();

const scenario = process.argv[2] ?? "healthy";
const pageName = (process.argv[3] ?? "SCANNER").toUpperCase();
const market = (process.argv[4] ?? "CA").toUpperCase();
const selectors = process.argv.slice(5);

const server = await startVisualServer({ port: 5198 });
await fetch("http://127.0.0.1:5198/__scenario", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: scenario }),
});
const vite = spawn(
  PNPM,
  [
    "--filter",
    "@tsx-scanner/web",
    "exec",
    "vite",
    "--config",
    join(VISUAL_DIR, "vite.visual.config.mjs").replaceAll("\\", "/"),
    "--port",
    "5199",
    "--strictPort",
  ],
  {
    cwd: join(VISUAL_DIR, "..", ".."),
    shell: true,
    windowsHide: true,
    stdio: "ignore",
  },
);

const NAV_MATCHERS = {
  SCANNER: [{ role: "button", name: "SCANNER", exact: true }],
  DETAIL: [{ role: "button", name: "SCANNER", exact: true }],
  DAILY: [{ role: "button", name: /^DAILY LIST/ }],
  DISCOVERY: [{ role: "button", name: "DISCOVERY", exact: true }],
  BOT: [{ role: "button", name: /^BOT · / }],
  PERFORMANCE: [{ role: "button", name: "BOT PERFORMANCE", exact: true }],
  LEARNING: [{ role: "button", name: "LEARNING", exact: true }],
  LAB: [{ role: "button", name: "STRATEGY LAB", exact: true }],
  BACKTESTS: [{ role: "button", name: "BACKTESTS", exact: true }],
};

try {
  for (let i = 0; i < 200; i += 1) {
    try {
      const response = await fetch(APP_URL);
      if (response.ok) break;
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  const browser = await chromium.launch({
    executablePath: EDGE,
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  const matcher = NAV_MATCHERS[pageName]?.[0];
  if (!matcher) throw new Error(`Unknown page ${pageName}`);
  await page.goto(APP_URL, { waitUntil: "domcontentloaded" });
  await page.locator('nav[aria-label="Sections"]').waitFor({ timeout: 45_000 });
  if (market === "US") {
    await page.getByLabel("Market").selectOption("US_EQUITIES");
    await page.waitForTimeout(600);
  }
  await page.getByRole(matcher.role, { name: matcher.name }).first().click();
  await page.waitForTimeout(900);
  if (process.env.PROBE_CLICK) {
    await page.locator(process.env.PROBE_CLICK).first().click();
    await page.waitForTimeout(900);
  }
  const result = await page.evaluate((requested) => {
    const output = [];
    for (const selector of requested) {
      const element = document.querySelector(selector);
      if (!element) {
        output.push({ selector, missing: true });
        continue;
      }
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      output.push({
        selector,
        rect: {
          top: Math.round(rect.top * 100) / 100,
          left: Math.round(rect.left * 100) / 100,
          width: Math.round(rect.width * 100) / 100,
          height: Math.round(rect.height * 100) / 100,
        },
        style: {
          display: style.display,
          padding: style.padding,
          margin: style.margin,
          gap: style.gap,
          font: `${style.fontSize}/${style.lineHeight}`,
          fontWeight: style.fontWeight,
          fontFamily: style.fontFamily.slice(0, 40),
          textTransform: style.textTransform,
          overflowX: style.overflowX,
          overflowY: style.overflowY,
        },
      });
    }
    return output;
  }, selectors);
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
} finally {
  spawnSync("taskkill", ["/pid", String(vite.pid), "/T", "/F"], {
    stdio: "ignore",
    windowsHide: true,
  });
  await server.close();
}
