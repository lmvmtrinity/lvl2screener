import { createHash, randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";

/** Latest additive migration. Never roll back migrations destructively. */
export const EXPECTED_SCHEMA_VERSION = 156;

/** Bounded retention for prior deployment images. */
export const ROLLBACK_RETENTION_COUNT = 5;

/** Services whose immutable image identities must be retained independently. */
export const DEPLOYMENT_SERVICES = ["api", "worker", "scanner", "web"];

export function candidateTag(service, sha) {
  assertSha(sha);
  return `tsx-${service}:${sha}`;
}

export function rollbackTag(service, sha, capturedAt) {
  assertSha(sha);
  const stamp = new Date(capturedAt).toISOString().replaceAll(/[:.]/g, "-");
  return `tsx-${service}:rollback-${sha.slice(0, 12)}-${stamp}`;
}

export function assertSha(sha) {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("DEPLOYMENT_SHA_REQUIRED");
}

export function assertDigest(digest) {
  if (!/^sha256:[a-f0-9]{64}$/.test(digest))
    throw new Error("DEPLOYMENT_DIGEST_REQUIRED");
}

export function assertSchemaVersion(schemaVersion) {
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1)
    throw new Error("DEPLOYMENT_SCHEMA_VERSION_REQUIRED");
  return schemaVersion;
}

/** Parse a schema version observed from the running database. */
export function parseObservedSchemaVersion(value) {
  if (value === undefined || value === null || String(value).trim() === "")
    throw new Error("DEPLOYMENT_SCHEMA_OBSERVED_REQUIRED");
  return assertSchemaVersion(Number(value));
}

/** Parse Docker Compose's array, object, or newline-delimited JSON output. */
export function parseComposePsOutput(output) {
  if (typeof output !== "string" || output.trim() === "")
    throw new Error("COMPOSE_PS_OUTPUT_EMPTY");
  const text = output.trim();
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === "object") return [parsed];
  } catch {
    // Docker emits one JSON object per line on some Compose versions.
  }
  const rows = text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  if (
    !rows.every((row) => row && typeof row === "object" && !Array.isArray(row))
  )
    throw new Error("COMPOSE_PS_OUTPUT_INVALID");
  return rows;
}

/** Validate all required running containers before any capture side effect. */
export function validateContainerImages(rows, imagesByService) {
  const services = new Set(
    rows
      .map((row) => String(row?.Service ?? row?.service ?? ""))
      .filter(Boolean),
  );
  for (const service of DEPLOYMENT_SERVICES) {
    if (!services.has(service))
      throw new Error(
        `ROLLBACK_CAPTURE_${service.toUpperCase()}_IMAGE_MISSING`,
      );
    const image = imagesByService?.[service]?.image;
    if (!image)
      throw new Error(
        `ROLLBACK_CAPTURE_${service.toUpperCase()}_IMAGE_MISSING`,
      );
    assertDigest(image);
  }
  if (imagesByService?.["scanner-research"]) {
    assertDigest(imagesByService["scanner-research"].image);
    if (
      imagesByService["scanner-research"].image !==
      imagesByService.scanner.image
    )
      throw new Error("ROLLBACK_CAPTURE_RESEARCH_SCANNER_IMAGE_MISMATCH");
  }
  return imagesByService;
}

/** Require an exact, clean source tree before building a candidate image. */
export function validateBuildSource({ requestedSha, headSha, status }) {
  assertSha(requestedSha);
  if (headSha !== requestedSha) throw new Error("DEPLOYMENT_SHA_HEAD_MISMATCH");
  if (typeof status !== "string")
    throw new Error("DEPLOYMENT_SOURCE_STATUS_UNKNOWN");
  if (status.trim() !== "") throw new Error("DEPLOYMENT_SOURCE_DIRTY");
}

/** Ensure the image's own revision label names the tested source commit. */
export function validateImageRevision({ sha, labels }) {
  assertSha(sha);
  if (labels?.["org.opencontainers.image.revision"] !== sha)
    throw new Error("DEPLOYMENT_IMAGE_REVISION_MISMATCH");
}

/**
 * Deployment receipt. Contains only non-secret evidence: source SHA,
 * immutable image digests, schema version and verification timestamps.
 * Never store secrets or raw environment values here.
 */
export function buildReceipt({
  sha,
  digests,
  schemaVersion,
  builtAt,
  verifiedAt = null,
}) {
  assertSha(sha);
  assertSchemaVersion(schemaVersion);
  const normalizedDigests = {
    ...digests,
    worker: digests.worker ?? digests.api,
  };
  for (const service of DEPLOYMENT_SERVICES) {
    if (!normalizedDigests[service])
      throw new Error(`DEPLOYMENT_DIGEST_MISSING:${service}`);
    assertDigest(normalizedDigests[service]);
  }
  if (normalizedDigests["scanner-research"]) {
    assertDigest(normalizedDigests["scanner-research"]);
    if (normalizedDigests["scanner-research"] !== normalizedDigests.scanner)
      throw new Error("DEPLOYMENT_RESEARCH_SCANNER_IMAGE_MISMATCH");
  }
  const receipt = {
    version: "deployment-receipt-v1",
    sha,
    digests: normalizedDigests,
    workerDigest: normalizedDigests.worker,
    schemaVersion,
    builtAt: new Date(builtAt).toISOString(),
    verifiedAt: verifiedAt ? new Date(verifiedAt).toISOString() : null,
  };
  return receipt;
}

export function parseReceipt(
  value,
  { allowOlderSchema = false, compatibilityEvidence = false } = {},
) {
  const receipt = typeof value === "string" ? JSON.parse(value) : value;
  if (receipt?.version !== "deployment-receipt-v1")
    throw new Error("DEPLOYMENT_RECEIPT_VERSION_MISMATCH");
  assertSha(receipt.sha);
  for (const service of DEPLOYMENT_SERVICES)
    assertDigest(receipt.digests[service]);
  if (receipt.digests["scanner-research"]) {
    assertDigest(receipt.digests["scanner-research"]);
    if (receipt.digests["scanner-research"] !== receipt.digests.scanner)
      throw new Error("DEPLOYMENT_RESEARCH_SCANNER_IMAGE_MISMATCH");
  }
  assertDigest(receipt.digests.worker);
  if (receipt.workerDigest !== receipt.digests.worker)
    throw new Error("DEPLOYMENT_WORKER_DIGEST_MISMATCH");
  assertSchemaVersion(receipt.schemaVersion);
  if (receipt.schemaVersion > EXPECTED_SCHEMA_VERSION)
    throw new Error(
      `DEPLOYMENT_SCHEMA_MISMATCH:expected ${EXPECTED_SCHEMA_VERSION}, got ${receipt.schemaVersion}`,
    );
  if (
    receipt.schemaVersion < EXPECTED_SCHEMA_VERSION &&
    !(allowOlderSchema && compatibilityEvidence === true)
  )
    throw new Error(
      allowOlderSchema
        ? "ROLLBACK_SCHEMA_COMPATIBILITY_UNVERIFIED"
        : `DEPLOYMENT_SCHEMA_MISMATCH:expected ${EXPECTED_SCHEMA_VERSION}, got ${receipt.schemaVersion}`,
    );
  return receipt;
}

export function parseRollbackReceipt(value) {
  const receipt = typeof value === "string" ? JSON.parse(value) : value;
  return parseReceipt(receipt, {
    allowOlderSchema: true,
    compatibilityEvidence: receipt?.schemaCompatibilityVerified === true,
  });
}

/** Fail closed when the rollback reference is missing or unresolvable. */
export function assertRollbackAvailable({ rollbackReceipt, imagesAvailable }) {
  if (!rollbackReceipt) throw new Error("ROLLBACK_REFERENCE_UNAVAILABLE");
  const parsed = parseRollbackReceipt(rollbackReceipt);
  for (const service of DEPLOYMENT_SERVICES) {
    const digest = parsed.digests[service];
    if (!imagesAvailable[service]?.includes(digest))
      throw new Error(`ROLLBACK_IMAGE_UNAVAILABLE:${service}`);
  }
  return parsed;
}

/**
 * Schema compatibility before rollback. Migrations are never rolled back
 * destructively. Numeric ordering alone cannot prove that an older binary can
 * read the current schema, so an explicit compatibility receipt is required.
 */
export function assertRollbackSchemaCompatible({
  currentSchema,
  rollbackSchema,
  compatibilityEvidence = false,
}) {
  if (
    !Number.isInteger(currentSchema) ||
    currentSchema < 1 ||
    !Number.isInteger(rollbackSchema) ||
    rollbackSchema < 1
  )
    throw new Error("ROLLBACK_SCHEMA_UNKNOWN");
  if (rollbackSchema > currentSchema)
    throw new Error("ROLLBACK_SCHEMA_NEWER_THAN_CURRENT");
  if (rollbackSchema < currentSchema && compatibilityEvidence !== true)
    throw new Error("ROLLBACK_SCHEMA_COMPATIBILITY_UNVERIFIED");
  return true;
}

export async function writeAtomicFile(
  targetPath,
  contents,
  { writeFileImpl = writeFile, renameImpl = rename, rmImpl = rm } = {},
) {
  const temporaryPath = `${targetPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFileImpl(temporaryPath, contents, {
      encoding: "utf8",
      flag: "wx",
    });
    await renameImpl(temporaryPath, targetPath);
  } catch (error) {
    try {
      await rmImpl(temporaryPath, { force: true });
    } catch {
      // Preserve the original write or rename failure.
    }
    throw error;
  }
}

/** Bounded retention: keep the newest N rollback refs, prune the rest. */
export function retentionKeep(refs, keep = ROLLBACK_RETENTION_COUNT) {
  const sorted = [...refs].sort((a, b) =>
    b.capturedAt.localeCompare(a.capturedAt),
  );
  return {
    keep: sorted.slice(0, keep),
    prune: sorted.slice(keep),
  };
}

/** Hash of approved non-secret config for receipts (never raw secrets). */
export function nonSecretConfigHash(allowlist) {
  const sorted = Object.fromEntries(
    Object.entries(allowlist).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

/**
 * Deployments during a regular session stop collection and leave open paper
 * positions unmanaged until the stack restarts (September 10, 21 and 23, 2026).
 * Weekday 09:30-16:10 America/New_York covers both markets' sessions and the
 * post-close collection window; holidays are treated as sessions, which only
 * errs toward refusing.
 */
export function assertOutsideMarketHours(now = new Date(), allow = false) {
  if (allow) return;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((part) => [part.type, part.value]),
  );
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  const weekday = !["Sat", "Sun"].includes(parts.weekday);
  if (weekday && minutes >= 9 * 60 + 30 && minutes < 16 * 60 + 10)
    throw new Error(
      "DEPLOYMENT_DURING_MARKET_HOURS: deploy after 16:10 ET or pass --allow-market-hours",
    );
}
