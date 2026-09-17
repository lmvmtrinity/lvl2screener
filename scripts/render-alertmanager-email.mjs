import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
try {
  process.loadEnvFile(resolve(root, ".env.monitoring"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const values = {
  SMTP_SMARTHOST: process.env.ALERTMANAGER_SMTP_SMARTHOST,
  SMTP_FROM: process.env.ALERTMANAGER_SMTP_FROM,
  SMTP_USERNAME: process.env.ALERTMANAGER_SMTP_USERNAME,
  EMAIL_TO: process.env.ALERTMANAGER_EMAIL_TO,
};
for (const [key, value] of Object.entries(values)) {
  if (!value || /[\r\n]/.test(value))
    throw new Error(`ALERTMANAGER_${key} must be configured as one line`);
}
if (!/^[a-zA-Z0-9.-]+:\d+$/.test(values.SMTP_SMARTHOST))
  throw new Error("SMTP smarthost must be hostname:port");
for (const key of ["SMTP_FROM", "EMAIL_TO"])
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(values[key]))
    throw new Error(`${key} must be one email address`);

const secret = await readFile(
  resolve(root, "monitoring/secrets/smtp-password"),
  "utf8",
);
if (!secret.trim() || /[\r\n]/.test(secret.trim()))
  throw new Error(
    "Save the SMTP app password as one line in monitoring/secrets/smtp-password; never paste it in chat",
  );
let config = await readFile(
  resolve(root, "monitoring/alertmanager.email.yml.template"),
  "utf8",
);
for (const [key, value] of Object.entries(values))
  config = config.replaceAll(`__${key}__`, value.replaceAll("'", "''"));
await writeFile(
  resolve(root, "monitoring/alertmanager.email.generated.yml"),
  config,
  { mode: 0o600 },
);
console.log(
  "Rendered email alert configuration; credentials are read from the mounted secret file.",
);
