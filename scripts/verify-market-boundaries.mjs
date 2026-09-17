import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const root = process.cwd();
const roots = ["apps/api/src", "contracts/src", "services/scanner/app"];
const permittedLegacyFiles = new Set([
  "apps/api/src/config.ts",
  "apps/api/src/phase0.ts",
  "apps/api/src/universe/universe-service.ts",
  "apps/api/src/routes/market-data.ts",
  "services/scanner/app/models.py",
]);
const prohibited = [
  {
    expression: /z\.literal\(["']TSX["']\)/,
    reason:
      "use MarketId and allowedExchangeCodes instead of a TSX-only contract literal",
  },
  {
    expression: /z\.literal\(["']CAD["']\)/,
    reason: "use a market currency contract instead of a CAD-only literal",
  },
  {
    expression:
      /WHERE\s+\(?active\s*=\s*TRUE\s+OR\s+universe_eligible\s*=\s*TRUE\)?/i,
    reason: "universe activation must be scoped by market_id",
  },
  {
    expression: /WHERE\s+benchmark_kind\s+IS\s+NOT\s+NULL\s+AND\s+NOT/i,
    reason: "benchmark replacement must be scoped by market_id",
  },
];

async function files(directory) {
  const entries = await readdir(join(root, directory), { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return files(path);
      return /\.(ts|py)$/.test(entry.name) ? [path] : [];
    }),
  );
  return nested.flat();
}

const violations = [];
for (const directory of roots) {
  for (const file of await files(directory)) {
    const normalized = relative(root, join(root, file)).replaceAll("\\", "/");
    if (permittedLegacyFiles.has(normalized)) continue;
    const source = await readFile(join(root, file), "utf8");
    for (const rule of prohibited) {
      if (rule.expression.test(source))
        violations.push(`${normalized}: ${rule.reason}`);
    }
  }
}

if (violations.length > 0) {
  console.error(
    "Market-boundary regression check failed:\n" + violations.join("\n"),
  );
  process.exitCode = 1;
} else {
  console.log("Market-boundary regression check passed.");
}
