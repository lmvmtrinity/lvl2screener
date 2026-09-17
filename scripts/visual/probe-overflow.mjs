// One-off diagnostic: list elements wider than the narrow viewport.
//
//   node scripts/visual/probe-overflow.mjs [scenario] [PAGE] [CA|US]
/* global window, document */
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
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.addInitScript({
    content: `class F{constructor(){this.readyState=1;this._l={open:[],message:[],close:[],error:[]};}addEventListener(t,f){(this._l[t]??=[]).push(f);}removeEventListener(){}send(){}close(){}};window.WebSocket=F;`,
  });
  await page.goto(APP_URL, { waitUntil: "domcontentloaded" });
  await page.locator('nav[aria-label="Sections"]').waitFor({ timeout: 45_000 });
  if (market === "US") {
    await page.getByLabel("Market").selectOption("US_EQUITIES");
    await page.waitForTimeout(600);
  }
  await page
    .locator('nav[aria-label="Sections"]')
    .getByRole("button", { name: pageName, exact: true })
    .click();
  await page.waitForTimeout(900);
  const offenders = await page.evaluate(() => {
    const innerWidth = window.innerWidth;
    const rows = [];
    for (const element of document.querySelectorAll("body *")) {
      const rect = element.getBoundingClientRect();
      if (rect.right > innerWidth + 0.5 && rect.width > 0) {
        rows.push({
          tag: element.tagName.toLowerCase(),
          className: String(element.className).slice(0, 90),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
          text: (element.textContent ?? "").trim().slice(0, 60),
        });
      }
    }
    return {
      innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      offenders: rows.slice(0, 40),
    };
  });
  console.log(JSON.stringify(offenders, null, 2));
  await browser.close();
} finally {
  spawnSync("taskkill", ["/pid", String(vite.pid), "/T", "/F"], {
    stdio: "ignore",
    windowsHide: true,
  });
  await server.close();
}
