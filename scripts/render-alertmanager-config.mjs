import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const webhook = process.env.ALERTMANAGER_WEBHOOK_URL;
if (!webhook) {
  throw new Error(
    "Set ALERTMANAGER_WEBHOOK_URL to an approved http(s) receiver before rendering Alertmanager configuration",
  );
}
if (/[\r\n]/.test(webhook))
  throw new Error("ALERTMANAGER_WEBHOOK_URL must be a single-line URL");
const parsed = new URL(webhook);
if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
  throw new Error("ALERTMANAGER_WEBHOOK_URL must use http or https");
if (
  parsed.protocol !== "https:" &&
  process.env.ALLOW_INSECURE_ALERT_WEBHOOK !== "true"
)
  throw new Error(
    "ALERTMANAGER_WEBHOOK_URL must use HTTPS outside an explicitly enabled local test",
  );

const root = resolve(import.meta.dirname, "..");
const templatePath = resolve(root, "monitoring/alertmanager.yml.template");
const outputPath = resolve(
  root,
  process.env.ALERTMANAGER_CONFIG_OUTPUT ??
    "monitoring/alertmanager.generated.yml",
);
const template = await readFile(templatePath, "utf8");
if (!template.includes("__ALERTMANAGER_WEBHOOK_URL__"))
  throw new Error("Alertmanager template is missing its receiver placeholder");
const rendered = template.replaceAll(
  "__ALERTMANAGER_WEBHOOK_URL__",
  webhook.replaceAll("'", "''"),
);
await writeFile(outputPath, rendered, { encoding: "utf8", mode: 0o644 });
console.log(`Rendered Alertmanager configuration to ${outputPath}`);
