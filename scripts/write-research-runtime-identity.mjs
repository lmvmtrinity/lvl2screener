import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hash = (value, algorithm = "sha256") =>
  createHash(algorithm).update(value).digest("hex");
async function tree(directory, extension) {
  const entries = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "__pycache__") continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (!extension || file.endsWith(extension))
        entries.push([
          path.relative(directory, file).replaceAll("\\", "/"),
          hash(await readFile(file)),
        ]);
    }
  }
  await walk(directory);
  return hash(
    JSON.stringify(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  );
}
const sources = {
  api: await tree(path.join(root, "apps/api/src"), ".ts"),
  contracts: await tree(path.join(root, "contracts/src"), ".ts"),
  scanner: await tree(path.join(root, "services/scanner/app"), ".py"),
  lock: hash(await readFile(path.join(root, "pnpm-lock.yaml"))),
  scannerProject: hash(
    await readFile(path.join(root, "services/scanner/pyproject.toml")),
  ),
};
const metadata = {
  version: "research-build-v1",
  engineRevision: hash(JSON.stringify(sources), "sha1"),
  sources,
  compiledApi: await tree(path.join(root, "apps/api/dist"), ".js"),
  compiledContracts: await tree(path.join(root, "contracts/dist"), ".js"),
};
await writeFile(
  path.join(root, "apps/api/research-runtime.json"),
  JSON.stringify(metadata),
);
