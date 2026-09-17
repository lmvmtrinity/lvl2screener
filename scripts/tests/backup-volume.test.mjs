import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
} from "node:fs";
import { copyFile, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Isolated regression harness for the backup/restore pipeline. It creates a
 * task-owned TimescaleDB container, runs the real `backup-volume.mjs` and
 * `verify-backup-volume.mjs` helpers against it, exercises a concurrent
 * writer, and checks that corrupt or legacy manifests fail visibly. The
 * container, temporary databases and generated archives are removed at the
 * end. Run with: node scripts/tests/backup-volume.test.mjs
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const suffix = `${process.pid}-${Date.now()}`;
const container = `tsx-scanner-backup-src-${suffix}`;
const image = process.env.POSTGRES_IMAGE ?? "timescale/timescaledb:2.29.2-pg17";
const user = "postgres";
const sourceDb = "tsx_scanner_test_backup";
const backupsDir = join(root, "backups");
const archiveName = `backups/backup-harness-${suffix}.dump`;
const archivePath = join(root, archiveName);
const manifestPath = `${archivePath}.json`;

function log(message) {
  console.log(`[backup-harness] ${message}`);
}

function run(command, args, options = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? root,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));
    child.on("error", (error) =>
      resolveRun({ code: 127, stdout, stderr: `${stderr}${error.message}` }),
    );
    child.on("close", (code) =>
      resolveRun({ code: code ?? 1, stdout, stderr }),
    );
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

function docker(args) {
  return run("docker", args);
}

async function psql(sql, database = sourceDb) {
  return docker([
    "exec",
    "-i",
    container,
    "psql",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    user,
    "-d",
    database,
    "-At",
    "-c",
    sql,
  ]);
}

async function waitForPostgres() {
  // The official image briefly runs an initialization server that listens on
  // the unix socket only. Probe over TCP (with its password) and require a
  // stable postmaster start time so startup can never continue against the
  // temporary server, which later exits and would make setup fail.
  let stableChecks = 0;
  let startTime = "";
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const probe = await docker([
      "exec",
      "-e",
      "PGPASSWORD=backup_harness_only",
      container,
      "psql",
      "-h",
      "127.0.0.1",
      "-U",
      user,
      "-d",
      "postgres",
      "-At",
      "-c",
      "SELECT pg_postmaster_start_time()::text",
    ]);
    const observed = probe.stdout.trim();
    if (probe.code === 0 && observed) {
      if (observed === startTime) {
        stableChecks += 1;
        if (stableChecks >= 2) return;
      } else {
        startTime = observed;
        stableChecks = 0;
      }
    } else {
      stableChecks = 0;
      startTime = "";
    }
    await new Promise((delay) => setTimeout(delay, 1_000));
  }
  throw new Error("Task-owned TimescaleDB container did not become ready");
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

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

async function main() {
  const dockerProbe = await docker([
    "version",
    "--format",
    "{{.Server.Version}}",
  ]);
  if (dockerProbe.code !== 0) {
    log("Docker is unavailable; skipping the isolated backup regression.");
    return;
  }
  if (!existsSync(backupsDir)) mkdirSync(backupsDir, { recursive: true });

  let containerStarted = false;
  try {
    log(`starting task-owned source container ${container}`);
    const started = await docker([
      "run",
      "--detach",
      "--name",
      container,
      "--env",
      `POSTGRES_DB=postgres`,
      "--env",
      `POSTGRES_PASSWORD=backup_harness_only`,
      "--env",
      `POSTGRES_USER=${user}`,
      image,
    ]);
    assert(started.code === 0, `docker run failed: ${started.stderr}`);
    containerStarted = true;
    await waitForPostgres();

    const created = await docker([
      "exec",
      container,
      "createdb",
      "-U",
      user,
      "-T",
      "template0",
      sourceDb,
    ]);
    assert(created.code === 0, `createdb failed: ${created.stderr}`);

    const seeded = await psql(`
      CREATE EXTENSION timescaledb;
      CREATE TABLE feature (
        id integer NOT NULL,
        ts timestamptz NOT NULL,
        value integer,
        PRIMARY KEY (id, ts)
      );
      SELECT create_hypertable('feature', by_range('ts'));
      INSERT INTO feature VALUES (1, '2026-08-31 13:32:45+00', 7);
      INSERT INTO feature VALUES (2, '2026-01-05 15:00:00+00', 3);
      CREATE TABLE context (
        feature_id integer,
        ts timestamptz,
        FOREIGN KEY (feature_id, ts) REFERENCES feature(id, ts)
      );
      INSERT INTO context VALUES (1, '2026-08-31 13:32:45+00');
      CREATE TABLE probe_audit (
        id integer PRIMARY KEY,
        inserted_at timestamptz NOT NULL DEFAULT clock_timestamp()
      );
      CREATE SEQUENCE probe_seq;
      CREATE FUNCTION insert_probe_row(job_id integer, config jsonb)
      RETURNS void LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO probe_audit(id) VALUES (nextval('probe_seq')::integer);
      END $$;
      SELECT add_job('insert_probe_row', INTERVAL '1 second');
      SELECT add_retention_policy('feature', INTERVAL '365 days');
    `);
    assert(seeded.code === 0, `source schema setup failed: ${seeded.stderr}`);

    const before = await psql("SELECT count(*) FROM feature");
    assert(before.code === 0, "source count failed");
    log("running the real backup helper with a concurrent writer");
    let writerRunning = true;
    const writer = (async () => {
      let inserted = 0;
      while (writerRunning) {
        const result = await psql(
          `INSERT INTO feature VALUES (${100000 + inserted}, '2026-09-14 12:00:00+00', ${inserted})`,
        );
        if (result.code !== 0) break;
        inserted += 1;
        await new Promise((delay) => setTimeout(delay, 5));
      }
      return inserted;
    })();

    const backup = await run(
      "node",
      ["scripts/backup-volume.mjs", archiveName],
      {
        env: {
          ...process.env,
          COMPOSE_PROJECT_NAME: "tsx-scanner",
          BACKUP_PG_CONTAINER: container,
          POSTGRES_DB: sourceDb,
          POSTGRES_USER: user,
          POSTGRES_IMAGE: image,
        },
      },
    );
    writerRunning = false;
    const written = await writer;
    assert(
      backup.code === 0,
      `backup helper failed: ${backup.stderr || backup.stdout}`,
    );
    assert(written > 0, "concurrent writer committed no rows");
    assert(
      existsSync(archivePath) && existsSync(manifestPath),
      "backup helper did not produce the archive and manifest",
    );
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    assert(manifest.schemaVersion === 2, "manifest is not schemaVersion 2");
    assert(
      Array.isArray(manifest.hypertables) && manifest.hypertables.length === 1,
      "manifest did not capture the registered hypertable",
    );
    assert(
      manifest.foreignKeys.some((value) => value.validated === true),
      "manifest did not capture a validated foreign key",
    );
    assert(
      manifest.jobs.some((value) => value.procName === "policy_retention"),
      "manifest did not capture the retention policy job",
    );
    assert(
      manifest.jobs.some((value) => value.procName === "insert_probe_row"),
      "manifest did not capture the mutating probe job",
    );
    const after = await psql("SELECT count(*) FROM feature");
    const liveRows = Number(after.stdout.trim());
    const capturedRows = Number(manifest.tableRowCounts["public.feature"]);
    assert(
      liveRows > capturedRows,
      `rows committed after the captured snapshot must be excluded from the manifest (live ${liveRows}, captured ${capturedRows})`,
    );
    const auditAfter = await psql("SELECT count(*) FROM probe_audit");
    const liveAuditRows = Number(auditAfter.stdout.trim());
    const capturedAuditRows = Number(
      manifest.tableRowCounts["public.probe_audit"],
    );
    assert(
      liveAuditRows > capturedAuditRows,
      `the mutating probe job must be active in the source (live ${liveAuditRows}, captured ${capturedAuditRows})`,
    );

    log("verifying the synthetic archive with the real restore helper");
    const verified = await run("node", [
      "scripts/verify-backup-volume.mjs",
      archiveName,
    ]);
    assert(
      verified.code === 0,
      `backup verification failed: ${verified.stderr || verified.stdout}`,
    );
    assert(
      verified.stdout.includes("validated foreign key"),
      "verifier did not report validated foreign keys",
    );

    log("checking that a corrupt archive fails visibly");
    const corruptName = `backups/backup-harness-${suffix}-corrupt.dump`;
    const corruptPath = join(root, corruptName);
    const original = await stat(archivePath);
    const truncatedBytes = Math.floor(original.size / 2);
    await new Promise((resolvePipe, rejectPipe) => {
      const input = createReadStream(archivePath, { end: truncatedBytes - 1 });
      const output = createWriteStream(corruptPath);
      input.pipe(output);
      input.on("error", rejectPipe);
      output.on("error", rejectPipe);
      output.on("finish", resolvePipe);
    });
    await writeFile(
      `${corruptPath}.json`,
      `${JSON.stringify(
        { ...manifest, sha256: await sha256(corruptPath) },
        null,
        2,
      )}\n`,
    );
    const corrupt = await run("node", [
      "scripts/verify-backup-volume.mjs",
      `backups/backup-harness-${suffix}-corrupt.dump`,
    ]);
    assert(corrupt.code !== 0, "corrupt archive did not fail verification");

    log("checking that a legacy schemaVersion 1 manifest is diagnosed");
    const legacyName = `backups/backup-harness-${suffix}-legacy.dump`;
    const legacyPath = join(root, legacyName);
    await copyFile(archivePath, legacyPath);
    await writeFile(
      `${legacyPath}.json`,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          archive: legacyName,
          database: sourceDb,
          user,
          postgresImage: image,
          sha256: await sha256(legacyPath),
          tableRowCounts: manifest.tableRowCounts,
        },
        null,
        2,
      )}\n`,
    );
    const legacy = await run("node", [
      "scripts/verify-backup-volume.mjs",
      `backups/backup-harness-${suffix}-legacy.dump`,
    ]);
    assert(legacy.code !== 0, "legacy manifest did not fail verification");
    assert(
      `${legacy.stderr}${legacy.stdout}`.includes("schemaVersion 1"),
      "legacy manifest failure did not explain the unsupported format",
    );

    log("PASS: backup, concurrent write, restore and failure diagnostics");
  } finally {
    const cleanupFiles = [
      archivePath,
      manifestPath,
      join(root, `backups/backup-harness-${suffix}-corrupt.dump`),
      join(root, `backups/backup-harness-${suffix}-corrupt.dump.json`),
      join(root, `backups/backup-harness-${suffix}-legacy.dump`),
      join(root, `backups/backup-harness-${suffix}-legacy.dump.json`),
    ];
    for (const file of cleanupFiles) await rm(file, { force: true });
    if (containerStarted) {
      await docker(["rm", "--force", "-v", container]);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
