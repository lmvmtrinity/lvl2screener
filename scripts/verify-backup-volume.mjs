import { createReadStream, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  console.log(
    "Usage: node scripts/verify-backup-volume.mjs backups/postgres-YYYYMMDDTHHMMSS.dump",
  );
}

function workspacePath(value) {
  const target = resolve(root, value);
  const pathFromRoot = relative(root, target);
  if (isAbsolute(pathFromRoot) || pathFromRoot.startsWith(".."))
    throw new Error("Backup archive must stay inside the repository.");
  return target;
}

function commandOutput(command, args) {
  return new Promise((resolveOutput, rejectOutput) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: ["ignore", "pipe", "inherit"],
    });
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.on("error", rejectOutput);
    child.on("close", (code) =>
      code === 0
        ? resolveOutput(Buffer.concat(chunks).toString("utf8"))
        : rejectOutput(
            new Error(
              `${command} ${args.join(" ")} exited with status ${code}`,
            ),
          ),
    );
  });
}

function commandStatus(command, args) {
  return new Promise((resolveStatus) => {
    const child = spawn(command, args, { cwd: root, stdio: "ignore" });
    child.on("error", () => resolveStatus(false));
    child.on("close", (code) => resolveStatus(code === 0));
  });
}

function restoreSection(archive, container, database, user, section) {
  return new Promise((resolveRestore, rejectRestore) => {
    const child = spawn(
      "docker",
      [
        "exec",
        "-i",
        container,
        "pg_restore",
        "-U",
        user,
        "-d",
        database,
        "--no-owner",
        "--no-privileges",
        "--exit-on-error",
        `--section=${section}`,
      ],
      {
        cwd: root,
        stdio: ["pipe", "inherit", "inherit"],
      },
    );
    const input = createReadStream(archive);
    input.pipe(child.stdin);
    input.on("error", rejectRestore);
    child.on("error", rejectRestore);
    child.on("close", (code) =>
      code === 0
        ? resolveRestore()
        : rejectRestore(
            new Error(
              `pg_restore --section=${section} exited with status ${code}`,
            ),
          ),
    );
  });
}

/**
 * Post-data contains both indexes/primary keys, which must be created while
 * `timescaledb_pre_restore()` is in effect, and foreign keys, which can only
 * validate after `timescaledb_post_restore()` re-attaches chunks to their
 * hypertables. Split the archive's own table of contents into those two phases
 * so neither ordering has to drop checks, leave constraints NOT VALID or
 * ignore restore errors.
 */
async function buildPostDataLists(archive, container, manifest) {
  const toc = await new Promise((resolveList, rejectList) => {
    const child = spawn(
      "docker",
      ["exec", "-i", container, "pg_restore", "--list"],
      {
        cwd: root,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const chunks = [];
    let stderr = "";
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));
    child.on("error", rejectList);
    child.on("close", (code) =>
      code === 0
        ? resolveList(Buffer.concat(chunks).toString("utf8"))
        : rejectList(
            new Error(
              `pg_restore --list exited with status ${code}: ${stderr.trim()}`,
            ),
          ),
    );
    const input = createReadStream(archive);
    input.pipe(child.stdin);
    input.on("error", rejectList);
  });
  const foreignKeys = new Set(
    manifest.foreignKeys.map(
      (value) => `${value.schema}\t${value.table}\t${value.name}`,
    ),
  );
  const phaseA = [];
  const phaseB = [];
  const postDataTags = new Set([
    "INDEX",
    "INDEX ATTACH",
    "TABLE ATTACH",
    "TRIGGER",
    "RULE",
    "CONSTRAINT",
    "EVENT TRIGGER",
    "PUBLICATION TABLE",
  ]);
  for (const line of toc.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(";")) {
      phaseA.push(line);
      phaseB.push(line);
      continue;
    }
    const tokens = trimmed.split(/\s+/);
    if (tokens[3] === "FK" && tokens[4] === "CONSTRAINT") {
      const key = `${tokens[5]}\t${tokens[6]}\t${tokens[7]}`;
      if (foreignKeys.has(key)) phaseB.push(line);
      else phaseA.push(line);
      continue;
    }
    if (postDataTags.has(tokens[3])) phaseA.push(line);
  }
  return {
    phaseA: `${phaseA.join("\n")}\n`,
    phaseB: `${phaseB.join("\n")}\n`,
  };
}

function writeContainerFile(container, path, content) {
  return new Promise((resolveWrite, rejectWrite) => {
    const child = spawn(
      "docker",
      ["exec", "-i", container, "sh", "-c", `cat > ${path}`],
      { cwd: root, stdio: ["pipe", "ignore", "inherit"] },
    );
    child.on("error", rejectWrite);
    child.on("close", (code) =>
      code === 0
        ? resolveWrite()
        : rejectWrite(new Error(`Writing ${path} exited with status ${code}`)),
    );
    child.stdin.end(content);
  });
}

function restoreWithList(archive, container, database, user, listPath, label) {
  return new Promise((resolveRestore, rejectRestore) => {
    const child = spawn(
      "docker",
      [
        "exec",
        "-i",
        container,
        "pg_restore",
        "-U",
        user,
        "-d",
        database,
        "--no-owner",
        "--no-privileges",
        "--exit-on-error",
        "-L",
        listPath,
      ],
      {
        cwd: root,
        stdio: ["pipe", "inherit", "inherit"],
      },
    );
    const input = createReadStream(archive);
    input.pipe(child.stdin);
    input.on("error", rejectRestore);
    child.on("error", rejectRestore);
    child.on("close", (code) =>
      code === 0
        ? resolveRestore()
        : rejectRestore(
            new Error(`${label} restore exited with status ${code}`),
          ),
    );
  });
}

function sha256(path) {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash("sha256");
    const input = createReadStream(path);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("error", rejectHash);
    input.on("end", () => resolveHash(hash.digest("hex")));
  });
}

async function waitForPostgres(container, database, user) {
  // Probe over TCP (with the container's password) so the socket-only
  // initialization server is never mistaken for the final server, and require
  // a stable postmaster start time across three consecutive probes. Expected
  // connection refusals are captured rather than printed.
  const probeStartTime = () =>
    new Promise((resolveProbe) => {
      const child = spawn(
        "docker",
        [
          "exec",
          "-e",
          "PGPASSWORD=backup_verification_only",
          container,
          "psql",
          "-h",
          "127.0.0.1",
          "-U",
          user,
          "-d",
          database,
          "-At",
          "-c",
          "SELECT pg_postmaster_start_time()::text",
        ],
        { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
      );
      const chunks = [];
      child.stdout.on("data", (chunk) => chunks.push(chunk));
      child.on("error", () => resolveProbe(""));
      child.on("close", (code) =>
        resolveProbe(
          code === 0 ? Buffer.concat(chunks).toString("utf8").trim() : "",
        ),
      );
    });
  let consecutiveReadyChecks = 0;
  let startTime = "";
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const observed = await probeStartTime();
    if (observed) {
      if (observed === startTime) {
        consecutiveReadyChecks += 1;
        if (consecutiveReadyChecks >= 2) return;
      } else {
        startTime = observed;
        consecutiveReadyChecks = 0;
      }
    } else {
      startTime = "";
      consecutiveReadyChecks = 0;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
  }
  throw new Error(
    "Disposable PostgreSQL database did not become stable within 60 seconds.",
  );
}

function psql(container, database, user, sql) {
  return commandOutput("docker", [
    "exec",
    container,
    "psql",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    user,
    "-d",
    database,
    "-At",
    "-F",
    "\t",
    "-c",
    sql,
  ]);
}

async function queryRows(container, database, user, sql) {
  const output = await psql(container, database, user, sql);
  return output
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.split("\t"));
}

async function tableRowCounts(container, database, user) {
  const tableList = await queryRows(
    container,
    database,
    user,
    "SELECT schemaname, tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public' ORDER BY tablename",
  );
  const entries = tableList
    .map(([schema, table]) => ({ schema, table }))
    .filter((entry) => entry.schema && entry.table);
  const counts = {};
  if (entries.length === 0) return counts;
  const quoted = (identifier) => `"${identifier.replaceAll('"', '""')}"`;
  const union = entries
    .map(
      (entry, index) =>
        `SELECT ${index} AS ordinal, count(*)::text AS count FROM ${quoted(entry.schema)}.${quoted(entry.table)}`,
    )
    .join(" UNION ALL ");
  const rows = await queryRows(container, database, user, union);
  for (const [ordinal, count] of rows) {
    const entry = entries[Number(ordinal)];
    if (!entry || !/^\d+$/.test(count ?? ""))
      throw new Error(
        `Unable to read restored row count for ${entry?.schema}.${entry?.table}`,
      );
    counts[`${entry.schema}.${entry.table}`] = count;
  }
  return counts;
}

async function restoredMetadata(container, database, user) {
  const extensions = (
    await queryRows(
      container,
      database,
      user,
      "SELECT extname, extversion FROM pg_extension ORDER BY extname",
    )
  ).map(([name, version]) => ({ name, version }));
  const hasTimescale = extensions.some((value) => value.name === "timescaledb");
  const hypertables = hasTimescale
    ? (
        await queryRows(
          container,
          database,
          user,
          `SELECT h.hypertable_schema, h.hypertable_name,
                  (SELECT count(*)::int FROM timescaledb_information.chunks c
                    WHERE c.hypertable_schema = h.hypertable_schema
                      AND c.hypertable_name = h.hypertable_name) AS chunks
             FROM timescaledb_information.hypertables h
            ORDER BY h.hypertable_schema, h.hypertable_name`,
        )
      ).map(([schema, table, chunks]) => ({
        schema,
        table,
        chunks: Number(chunks ?? 0),
      }))
    : [];
  const foreignKeys = (
    await queryRows(
      container,
      database,
      user,
      `SELECT n.nspname, c.relname, con.conname,
              pg_get_constraintdef(con.oid), con.convalidated::text
         FROM pg_constraint con
         JOIN pg_class c ON c.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE con.contype = 'f' AND n.nspname = 'public'
        ORDER BY n.nspname, c.relname, con.conname`,
    )
  ).map(([schema, table, name, definition, validated]) => ({
    schema,
    table,
    name,
    definition,
    validated: validated === "true",
  }));
  const jobs = hasTimescale
    ? (
        await queryRows(
          container,
          database,
          user,
          `SELECT application_name, proc_name,
                  COALESCE(hypertable_schema, ''), COALESCE(hypertable_name, ''),
                  COALESCE(schedule_interval::text, '')
             FROM timescaledb_information.jobs
            ORDER BY application_name, proc_name, 3, 4`,
        )
      ).map(
        ([
          applicationName,
          procName,
          hypertableSchema,
          hypertableName,
          scheduleInterval,
        ]) => ({
          applicationName,
          procName,
          hypertableSchema,
          hypertableName,
          scheduleInterval,
        }),
      )
    : [];
  return { extensions, hypertables, foreignKeys, jobs };
}

function signature(value) {
  return JSON.stringify(value);
}

/**
 * Keep restored Timescale background jobs paused for the whole verification.
 * `timescaledb_post_restore()` re-enables the job scheduler, and a restored
 * policy must not mutate the target while row counts and integrity are being
 * checked. Only the `scheduled` flag is cleared; the recorded job
 * configuration (name, procedure, schedule, hypertable, config) is preserved
 * and still compared against the manifest.
 */
async function pauseTimescaleJobs(container, database, user) {
  await psql(
    container,
    database,
    user,
    `DO $$
     BEGIN
       IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb')
          AND EXISTS (
            SELECT 1 FROM information_schema.tables
             WHERE table_schema = '_timescaledb_config'
               AND table_name = 'bgw_job'
          )
       THEN
         UPDATE _timescaledb_config.bgw_job SET scheduled = FALSE WHERE scheduled;
       END IF;
     END $$;`,
  );
}

async function assertNoScheduledJobs(container, database, user) {
  const rows = await queryRows(
    container,
    database,
    user,
    "SELECT count(*)::text FROM timescaledb_information.jobs WHERE scheduled",
  );
  const scheduled = Number(rows[0]?.[0] ?? "0");
  if (scheduled > 0)
    throw new Error(
      `Restored Timescale jobs are still enabled (${scheduled}); refusing to verify while a policy can mutate the restore target.`,
    );
}

function assertManifest(manifest) {
  if (manifest.schemaVersion === 1)
    throw new Error(
      "Backup manifest schemaVersion 1 predates Timescale metadata capture and cannot certify a hypertable restore. Create a new backup with pnpm backup:db.",
    );
  if (
    manifest.schemaVersion !== 2 ||
    typeof manifest.database !== "string" ||
    typeof manifest.user !== "string" ||
    typeof manifest.postgresImage !== "string" ||
    typeof manifest.sha256 !== "string" ||
    typeof manifest.tableRowCounts !== "object" ||
    !Array.isArray(manifest.extensions) ||
    !Array.isArray(manifest.hypertables) ||
    !Array.isArray(manifest.foreignKeys) ||
    !Array.isArray(manifest.jobs)
  ) {
    throw new Error("Backup manifest is invalid or unsupported.");
  }
}

async function main() {
  const input = process.argv[2];
  if (input === "--help" || input === "-h") return usage();
  if (!input || input.startsWith("-"))
    throw new Error("A backup archive path is required.");
  const archive = workspacePath(input);
  const manifestPath = `${archive}.json`;
  if (!existsSync(archive) || !existsSync(manifestPath))
    throw new Error("Backup archive and its .json manifest must both exist.");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assertManifest(manifest);
  if ((await sha256(archive)) !== manifest.sha256)
    throw new Error("Backup archive checksum does not match its manifest.");

  const suffix = `${process.pid}-${Date.now()}`;
  const volume = `tsx-scanner-backup-verify-${suffix}`;
  const container = `tsx-scanner-backup-verify-${suffix}`;
  const restoreDatabase = "backup_verification";
  let volumeCreated = false;
  let containerCreated = false;
  try {
    await commandOutput("docker", ["volume", "create", volume]);
    volumeCreated = true;
    await commandOutput("docker", [
      "run",
      "--detach",
      "--name",
      container,
      "--volume",
      `${volume}:/var/lib/postgresql/data`,
      "--env",
      `POSTGRES_DB=${manifest.database}`,
      "--env",
      `POSTGRES_USER=${manifest.user}`,
      "--env",
      "POSTGRES_PASSWORD=backup_verification_only",
      manifest.postgresImage,
    ]);
    containerCreated = true;
    await waitForPostgres(container, manifest.database, manifest.user);
    await commandOutput("docker", [
      "exec",
      container,
      "createdb",
      "-U",
      manifest.user,
      "-T",
      "template0",
      restoreDatabase,
    ]);
    await psql(
      container,
      restoreDatabase,
      manifest.user,
      "CREATE EXTENSION timescaledb",
    );
    await psql(
      container,
      restoreDatabase,
      manifest.user,
      "SELECT timescaledb_pre_restore()",
    );
    // Timescale metadata (including hypertable/chunk/policy catalog rows) is in
    // the archive, so schema and data restore inside the pre/post window...
    await restoreSection(
      archive,
      container,
      restoreDatabase,
      manifest.user,
      "pre-data",
    );
    await restoreSection(
      archive,
      container,
      restoreDatabase,
      manifest.user,
      "data",
    );
    // Pause every restored job while still inside the restore window. The
    // scheduler starts when post_restore() leaves restore mode, so jobs must
    // already be disabled by then, and they stay paused through verification.
    await pauseTimescaleJobs(container, restoreDatabase, manifest.user);
    const lists = await buildPostDataLists(archive, container, manifest);
    await writeContainerFile(
      container,
      "/tmp/tsx-backup-post-indexes.list",
      lists.phaseA,
    );
    await writeContainerFile(
      container,
      "/tmp/tsx-backup-post-fkeys.list",
      lists.phaseB,
    );
    // ...indexes and primary keys while chunks are still detached, then leave
    // restore mode before foreign keys validate against re-attached chunks.
    await restoreWithList(
      archive,
      container,
      restoreDatabase,
      manifest.user,
      "/tmp/tsx-backup-post-indexes.list",
      "post-data (indexes and constraints)",
    );
    await psql(
      container,
      restoreDatabase,
      manifest.user,
      "SELECT timescaledb_post_restore()",
    );
    await pauseTimescaleJobs(container, restoreDatabase, manifest.user);
    await assertNoScheduledJobs(container, restoreDatabase, manifest.user);
    await restoreWithList(
      archive,
      container,
      restoreDatabase,
      manifest.user,
      "/tmp/tsx-backup-post-fkeys.list",
      "post-data (foreign keys)",
    );

    const restoredCounts = await tableRowCounts(
      container,
      restoreDatabase,
      manifest.user,
    );
    if (signature(restoredCounts) !== signature(manifest.tableRowCounts)) {
      throw new Error(
        `Restored row counts do not match ${relative(root, manifestPath)}.`,
      );
    }
    const metadata = await restoredMetadata(
      container,
      restoreDatabase,
      manifest.user,
    );
    if (signature(metadata.extensions) !== signature(manifest.extensions)) {
      throw new Error(
        "Restored extension versions do not match the backup manifest.",
      );
    }
    if (signature(metadata.hypertables) !== signature(manifest.hypertables)) {
      throw new Error(
        "Restored hypertables/chunks do not match the backup manifest.",
      );
    }
    if (signature(metadata.foreignKeys) !== signature(manifest.foreignKeys)) {
      throw new Error(
        "Restored foreign keys do not match the backup manifest (definitions must be present and validated).",
      );
    }
    if (signature(metadata.jobs) !== signature(manifest.jobs)) {
      throw new Error(
        "Restored Timescale policies/jobs do not match the backup manifest.",
      );
    }
    console.log(
      `Verified ${relative(root, archive)}: schema and data restored with ${Object.keys(restoredCounts).length} public table row counts, ${metadata.hypertables.length} hypertable(s), ${metadata.foreignKeys.length} validated foreign key(s) and ${metadata.jobs.length} Timescale job(s) matching the manifest.`,
    );
  } finally {
    if (containerCreated)
      await commandStatus("docker", ["rm", "--force", container]);
    if (volumeCreated) await commandStatus("docker", ["volume", "rm", volume]);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
