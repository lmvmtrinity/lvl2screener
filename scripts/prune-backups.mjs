import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const backupDirectory = join(root, "backups");
const args = new Set(process.argv.slice(2));
const apply = args.delete("--apply");

function integerOption(prefix, fallback) {
  const values = [...args].filter((arg) => arg.startsWith(prefix));
  if (values.length !== 1 && values.length !== 0)
    throw new Error(`Specify ${prefix} once`);
  if (values.length === 0) return fallback;
  const value = Number(values[0].slice(prefix.length));
  args.delete(values[0]);
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${prefix} requires a positive integer`);
  return value;
}

const keepDumps = integerOption("--keep-dumps=", 2);
const keepImages = integerOption("--keep-images=", 1);
if (args.size) throw new Error(`Unknown option: ${[...args].join(", ")}`);

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function regularFile(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error(`Refusing a non-regular file: ${path}`);
  return info;
}

const names = await readdir(backupDirectory);
const verifiedDumps = [];
for (const name of names.filter((value) => value.endsWith(".dump"))) {
  const archive = join(backupDirectory, name);
  const manifestPath = `${archive}.json`;
  if (!names.includes(`${name}.json`)) {
    console.log(`KEEP incomplete or unverified: ${name} (no manifest)`);
    continue;
  }
  try {
    const [info, manifest] = await Promise.all([
      regularFile(archive),
      readFile(manifestPath, "utf8").then(JSON.parse),
    ]);
    await regularFile(manifestPath);
    if (
      manifest.archive !== `backups/${name}` ||
      !/^[a-f0-9]{64}$/.test(manifest.sha256) ||
      (await sha256(archive)) !== manifest.sha256
    ) {
      console.log(`KEEP incomplete or unverified: ${name} (manifest mismatch)`);
      continue;
    }
    verifiedDumps.push({ name, archive, manifestPath, time: info.mtimeMs });
  } catch (error) {
    console.log(`KEEP incomplete or unverified: ${name} (${error.message})`);
  }
}
verifiedDumps.sort((a, b) => b.time - a.time);

const imageSets = [];
for (const name of names.filter((value) => value.endsWith(".tar"))) {
  const path = join(backupDirectory, name);
  const info = await regularFile(path);
  imageSets.push({ name, path, time: info.mtimeMs });
}
imageSets.sort((a, b) => b.time - a.time);

for (const item of verifiedDumps.slice(0, keepDumps))
  console.log(`KEEP verified dump: ${item.name}`);
for (const item of imageSets.slice(0, keepImages))
  console.log(`KEEP rollback image: ${item.name}`);

const staleDumps = verifiedDumps.slice(keepDumps);
const staleImages = imageSets.slice(keepImages);
for (const item of staleDumps)
  console.log(
    `${apply ? "DELETE" : "WOULD DELETE"} verified dump: ${item.name} and manifest`,
  );
for (const item of staleImages)
  console.log(
    `${apply ? "DELETE" : "WOULD DELETE"} rollback image: ${item.name}`,
  );

if (apply) {
  for (const item of staleDumps) {
    await rm(item.archive);
    await rm(item.manifestPath);
  }
  for (const item of staleImages) await rm(item.path);
}
console.log(
  `${apply ? "Deleted" : "Dry run:"} ${staleDumps.length} dump pairs and ${staleImages.length} image sets${apply ? "" : "; pass --apply to prune"}.`,
);
