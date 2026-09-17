import { createWriteStream, existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const project = process.env.COMPOSE_PROJECT_NAME ?? "tsx-scanner";
const database = process.env.POSTGRES_DB ?? "tsx_scanner";
const user = process.env.POSTGRES_USER ?? "tsx_scanner";
const postgresImage =
  process.env.POSTGRES_IMAGE ?? "timescale/timescaledb:2.29.2-pg17";
const volume = process.env.POSTGRES_VOLUME ?? `${project}_postgres_data`;
/** Isolated-target override used by the regression harness. When set, the
 * helper talks to this container instead of the Compose postgres service. */
const containerOverride = process.env.BACKUP_PG_CONTAINER;

function usage() {
  console.log(
    "Usage: node scripts/backup-volume.mjs [backups/postgres-YYYYMMDDTHHMMSS.dump]",
  );
}

function assertSafeDockerName(value, label) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value))
    throw new Error(`${label} contains unsupported characters: ${value}`);
}

function workspacePath(value) {
  const target = resolve(root, value);
  const pathFromRoot = relative(root, target);
  if (isAbsolute(pathFromRoot) || pathFromRoot.startsWith(".."))
    throw new Error("Backup output must stay inside the repository.");
  return target;
}

function commandOutput(command, args, options = {}) {
  return new Promise((resolveOutput, rejectOutput) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: ["ignore", "pipe", "inherit"],
      ...options,
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

function commandToFile(command, args, target) {
  return new Promise((resolveFile, rejectFile) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: ["ignore", "pipe", "inherit"],
    });
    const output = createWriteStream(target, { flags: "wx" });
    const hash = createHash("sha256");
    let childCode;
    let outputFinished = false;
    let failed = false;
    const complete = () => {
      if (failed || childCode === undefined || !outputFinished) return;
      if (childCode !== 0)
        return rejectFile(
          new Error(
            `${command} ${args.join(" ")} exited with status ${childCode}`,
          ),
        );
      resolveFile(hash.digest("hex"));
    };
    const fail = (error) => {
      if (failed) return;
      failed = true;
      rejectFile(error);
    };
    child.stdout.on("data", (chunk) => hash.update(chunk));
    child.stdout.pipe(output);
    child.on("error", fail);
    output.on("error", fail);
    child.on("close", (code) => {
      childCode = code;
      complete();
    });
    output.on("finish", () => {
      outputFinished = true;
      complete();
    });
  });
}

function postgresExecArgs(...args) {
  return containerOverride
    ? ["exec", "-i", containerOverride, ...args]
    : ["compose", "-p", project, "exec", "-T", "postgres", ...args];
}

function psqlArgs(sql) {
  return postgresExecArgs(
    "psql",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    user,
    "-d",
    database,
    "-At",
    "-q",
    "-F",
    "\t",
    "-c",
    sql,
  );
}

function queryRows(sql) {
  return commandOutput("docker", psqlArgs(sql)).then((output) =>
    output
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => line.split("\t")),
  );
}

/**
 * Hold one exported snapshot open for the whole capture. Counts and `pg_dump`
 * both import this snapshot, so the manifest describes exactly the archive
 * even while writers keep committing. The holder transaction is terminated
 * once every consumer has finished.
 */
function startSnapshotHolder() {
  return new Promise((resolveHolder, rejectHolder) => {
    const child = spawn(
      "docker",
      postgresExecArgs(
        "psql",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        user,
        "-d",
        database,
        "-At",
        "-q",
      ),
      { cwd: root, stdio: ["pipe", "pipe", "pipe"] },
    );
    let buffered = "";
    let snapshotId;
    let backendPid;
    let stderr = "";
    const finish = () => {
      if (snapshotId && backendPid) {
        child.stdout.removeListener("data", onStdout);
        resolveHolder({ child, snapshotId, backendPid });
      }
    };
    const onStdout = (chunk) => {
      buffered += chunk.toString("utf8");
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        const value = line.trim();
        if (!snapshotId && /^[0-9A-Fa-f-]+-\d+$/.test(value)) {
          snapshotId = value;
          continue;
        }
        if (snapshotId && !backendPid && /^\d+$/.test(value))
          backendPid = Number(value);
      }
      finish();
    };
    child.stdout.on("data", onStdout);
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-2_000);
    });
    child.on("error", rejectHolder);
    child.on("close", (code) => {
      if (!snapshotId || !backendPid)
        rejectHolder(
          new Error(
            `Snapshot holder exited (status ${code}): ${stderr.trim()}`,
          ),
        );
    });
    child.stdin.write(
      "BEGIN ISOLATION LEVEL REPEATABLE READ;\nSELECT pg_export_snapshot();\nSELECT pg_backend_pid();\nSELECT pg_sleep(3600);\n",
    );
  });
}

async function stopSnapshotHolder(holder) {
  if (!holder) return;
  try {
    await commandOutput(
      "docker",
      psqlArgs(`SELECT pg_terminate_backend(${holder.backendPid})`),
    );
  } catch {
    // The holder may already be gone; the child kill below is best effort.
  }
  holder.child.stdin.end();
  holder.child.kill();
}

function snapshotQuery(snapshotId, sql) {
  if (!/^[0-9A-Fa-f-]+-\d+$/.test(snapshotId))
    throw new Error("Unexpected exported snapshot identifier.");
  return `BEGIN ISOLATION LEVEL REPEATABLE READ;\nSET TRANSACTION SNAPSHOT '${snapshotId}';\n${sql};\nCOMMIT;`;
}

async function tableRowCounts(snapshotId) {
  const tables = await queryRows(
    snapshotQuery(
      snapshotId,
      "SELECT schemaname, tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public' ORDER BY tablename",
    ),
  );
  const entries = tables
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
  const rows = await queryRows(snapshotQuery(snapshotId, union));
  for (const [ordinal, count] of rows) {
    const entry = entries[Number(ordinal)];
    if (!entry || !/^\d+$/.test(count ?? ""))
      throw new Error("Unable to read row counts from the captured snapshot");
    counts[`${entry.schema}.${entry.table}`] = count;
  }
  if (Object.keys(counts).length !== entries.length)
    throw new Error("Row counts are incomplete for the captured snapshot");
  return counts;
}

async function captureMetadata(snapshotId) {
  const extensions = (
    await queryRows(
      snapshotQuery(
        snapshotId,
        "SELECT extname, extversion FROM pg_extension ORDER BY extname",
      ),
    )
  ).map(([name, version]) => ({ name, version }));
  const hasTimescale = extensions.some((value) => value.name === "timescaledb");
  const hypertables = hasTimescale
    ? (
        await queryRows(
          snapshotQuery(
            snapshotId,
            `SELECT h.hypertable_schema, h.hypertable_name,
                    (SELECT count(*)::int FROM timescaledb_information.chunks c
                      WHERE c.hypertable_schema = h.hypertable_schema
                        AND c.hypertable_name = h.hypertable_name) AS chunks
               FROM timescaledb_information.hypertables h
              ORDER BY h.hypertable_schema, h.hypertable_name`,
          ),
        )
      ).map(([schema, table, chunks]) => ({
        schema,
        table,
        chunks: Number(chunks ?? 0),
      }))
    : [];
  const foreignKeys = (
    await queryRows(
      snapshotQuery(
        snapshotId,
        `SELECT n.nspname, c.relname, con.conname,
                pg_get_constraintdef(con.oid), con.convalidated::text
           FROM pg_constraint con
           JOIN pg_class c ON c.oid = con.conrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE con.contype = 'f' AND n.nspname = 'public'
          ORDER BY n.nspname, c.relname, con.conname`,
      ),
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
          snapshotQuery(
            snapshotId,
            `SELECT application_name, proc_name,
                    COALESCE(hypertable_schema, ''), COALESCE(hypertable_name, ''),
                    COALESCE(schedule_interval::text, '')
               FROM timescaledb_information.jobs
              ORDER BY application_name, proc_name, 3, 4`,
          ),
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

async function main() {
  const input = process.argv[2];
  if (input === "--help" || input === "-h") return usage();
  if (input?.startsWith("-")) throw new Error(`Unknown option: ${input}`);
  if (containerOverride) {
    assertSafeDockerName(containerOverride, "Backup container");
  } else {
    assertSafeDockerName(project, "Compose project");
    assertSafeDockerName(volume, "Postgres volume");
    await commandOutput("docker", ["volume", "inspect", volume]);
  }

  const timestamp = new Date()
    .toISOString()
    .replaceAll(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  const archive = workspacePath(input ?? `backups/postgres-${timestamp}.dump`);
  const manifest = `${archive}.json`;
  if (existsSync(archive) || existsSync(manifest))
    throw new Error(`Refusing to overwrite an existing backup: ${archive}`);
  await mkdir(dirname(archive), { recursive: true });

  let holder;
  let written = false;
  try {
    holder = await startSnapshotHolder();
    const counts = await tableRowCounts(holder.snapshotId);
    const metadata = await captureMetadata(holder.snapshotId);
    const sha256 = await commandToFile(
      "docker",
      postgresExecArgs(
        "pg_dump",
        "-U",
        user,
        "-d",
        database,
        "--format=custom",
        "--no-owner",
        "--no-privileges",
        `--snapshot=${holder.snapshotId}`,
      ),
      archive,
    );
    written = true;
    await writeFile(
      manifest,
      `${JSON.stringify(
        {
          schemaVersion: 2,
          archive: relative(root, archive).replaceAll("\\", "/"),
          createdAt: new Date().toISOString(),
          target: containerOverride
            ? { kind: "container", container: containerOverride }
            : { kind: "compose", composeProject: project },
          postgresVolume: containerOverride ? null : volume,
          postgresImage,
          database,
          user,
          snapshot: { id: holder.snapshotId, consistent: true },
          sha256,
          extensions: metadata.extensions,
          hypertables: metadata.hypertables,
          foreignKeys: metadata.foreignKeys,
          jobs: metadata.jobs,
          tableRowCounts: counts,
        },
        null,
        2,
      )}\n`,
      { flag: "wx" },
    );
  } catch (error) {
    if (written) await rm(archive, { force: true });
    await rm(manifest, { force: true });
    throw error;
  } finally {
    await stopSnapshotHolder(holder);
  }
  console.log(`Backup written: ${relative(root, archive)}`);
  console.log(`Manifest written: ${relative(root, manifest)}`);
  console.log(`Verify with: pnpm backup:verify -- ${relative(root, archive)}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
