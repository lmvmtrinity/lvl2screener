import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  EXPECTED_SCHEMA_VERSION,
  assertOutsideMarketHours,
  assertRollbackAvailable,
  assertRollbackSchemaCompatible,
  buildReceipt,
  candidateTag,
  parseComposePsOutput,
  parseObservedSchemaVersion,
  parseRollbackReceipt,
  parseReceipt,
  validateBuildSource,
  validateContainerImages,
  validateImageRevision,
  writeAtomicFile,
  retentionKeep,
} from "../deployment/lib.mjs";

const sha = "a".repeat(40);
const digests = {
  api: `sha256:${"1".repeat(64)}`,
  worker: `sha256:${"4".repeat(64)}`,
  scanner: `sha256:${"2".repeat(64)}`,
  web: `sha256:${"3".repeat(64)}`,
};

test("Compose output accepts arrays, objects, and newline-delimited JSON", () => {
  assert.deepEqual(parseComposePsOutput(JSON.stringify([{ Service: "api" }])), [
    { Service: "api" },
  ]);
  assert.deepEqual(parseComposePsOutput(JSON.stringify({ Service: "api" })), [
    { Service: "api" },
  ]);
  assert.deepEqual(
    parseComposePsOutput(
      `${JSON.stringify({ Service: "api" })}\n${JSON.stringify({ Service: "worker" })}\n`,
    ),
    [{ Service: "api" }, { Service: "worker" }],
  );
});

test("candidate tags are commit-addressed and can explicitly share the api digest", () => {
  assert.equal(candidateTag("api", sha), `tsx-api:${sha}`);
  const receipt = buildReceipt({
    sha,
    digests: { ...digests, worker: digests.api },
    schemaVersion: EXPECTED_SCHEMA_VERSION,
    builtAt: "2026-09-22T00:00:00.000Z",
  });
  assert.equal(receipt.workerDigest, digests.api);
  assert.equal(receipt.schemaVersion, 156);
});

test("receipts never carry secrets and survive a parse round-trip", () => {
  const receipt = buildReceipt({
    sha,
    digests,
    schemaVersion: EXPECTED_SCHEMA_VERSION,
    builtAt: "2026-09-22T00:00:00.000Z",
  });
  const text = JSON.stringify(receipt);
  assert.ok(!/token|password|secret/i.test(text));
  assert.deepEqual(parseReceipt(text), receipt);
});

test("candidate receipts stay on the current schema while rollback compatibility is explicit", () => {
  const rollback = buildReceipt({
    sha,
    digests,
    schemaVersion: EXPECTED_SCHEMA_VERSION - 1,
    builtAt: "2026-09-22T00:00:00.000Z",
  });
  rollback.schemaCompatibilityVerified = true;
  assert.throws(() => parseReceipt(rollback), /DEPLOYMENT_SCHEMA_MISMATCH/);
  assert.throws(
    () =>
      parseRollbackReceipt({
        ...rollback,
        schemaCompatibilityVerified: false,
      }),
    /ROLLBACK_SCHEMA_COMPATIBILITY_UNVERIFIED/,
  );
  assert.doesNotThrow(() => parseRollbackReceipt(rollback));
});

test("receipt schemas must be finite positive integers", () => {
  for (const schemaVersion of [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    137.5,
    0,
  ]) {
    assert.throws(
      () =>
        buildReceipt({
          sha,
          digests,
          schemaVersion,
          builtAt: "2026-09-22T00:00:00.000Z",
        }),
      /DEPLOYMENT_SCHEMA_VERSION_REQUIRED/,
    );
  }
});

test("rollback capture requires an explicitly observed schema version", () => {
  assert.throws(
    () => parseObservedSchemaVersion(undefined),
    /DEPLOYMENT_SCHEMA_OBSERVED_REQUIRED/,
  );
  assert.equal(parseObservedSchemaVersion("137"), 137);
  assert.equal(parseObservedSchemaVersion(138), 138);
});

test("atomic receipt replacement preserves the prior current receipt on failure", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "deployment-receipt-"),
  );
  const target = path.join(directory, "current.json");
  try {
    await writeFile(target, "prior receipt\n");
    await assert.rejects(
      () =>
        writeAtomicFile(target, "new receipt\n", {
          renameImpl: async () => {
            throw new Error("rename failed");
          },
        }),
      /rename failed/,
    );
    assert.equal(await readFile(target, "utf8"), "prior receipt\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("preflight fails when the rollback image is unavailable", () => {
  const receipt = buildReceipt({
    sha,
    digests,
    schemaVersion: EXPECTED_SCHEMA_VERSION,
    builtAt: "2026-09-22T00:00:00.000Z",
  });
  assert.throws(
    () =>
      assertRollbackAvailable({
        rollbackReceipt: receipt,
        imagesAvailable: { api: [], scanner: [], web: [] },
      }),
    /ROLLBACK_IMAGE_UNAVAILABLE/,
  );
  assert.throws(
    () =>
      assertRollbackAvailable({ rollbackReceipt: null, imagesAvailable: {} }),
    /ROLLBACK_REFERENCE_UNAVAILABLE/,
  );
});

test("rollback never destructively downgrades the schema", () => {
  assert.equal(
    assertRollbackSchemaCompatible({ currentSchema: 138, rollbackSchema: 138 }),
    true,
  );
  assert.throws(
    () =>
      assertRollbackSchemaCompatible({
        currentSchema: 138,
        rollbackSchema: 137,
      }),
    /ROLLBACK_SCHEMA_COMPATIBILITY_UNVERIFIED/,
  );
  assert.equal(
    assertRollbackSchemaCompatible({
      currentSchema: 138,
      rollbackSchema: 137,
      compatibilityEvidence: true,
    }),
    true,
  );
  assert.throws(
    () =>
      assertRollbackSchemaCompatible({
        currentSchema: 136,
        rollbackSchema: 137,
      }),
    /ROLLBACK_SCHEMA_NEWER_THAN_CURRENT/,
  );
});

test("rollback receipts preserve distinct api and worker images", () => {
  const receipt = buildReceipt({
    sha,
    digests,
    schemaVersion: EXPECTED_SCHEMA_VERSION,
    builtAt: "2026-09-22T00:00:00.000Z",
  });
  assert.equal(receipt.workerDigest, digests.worker);
  assert.notEqual(receipt.workerDigest, receipt.digests.api);
  assert.doesNotThrow(() => parseReceipt(receipt));
});

test("image validation is fail-closed before any capture side effect", () => {
  const rows = [
    { Service: "api", Name: "api-1" },
    { Service: "worker", Name: "worker-1" },
    { Service: "scanner", Name: "scanner-1" },
    { Service: "web", Name: "web-1" },
  ];
  assert.throws(
    () =>
      validateContainerImages(rows, {
        api: { image: digests.api },
        worker: { image: digests.worker },
        web: { image: digests.web },
      }),
    /ROLLBACK_CAPTURE_SCANNER_IMAGE_MISSING/,
  );
});

test("container image validation uses immutable container images, not Compose tags", () => {
  const rows = [
    { Service: "api", Name: "api-1", Image: "tsx-api:latest" },
    { Service: "worker", Name: "worker-1", Image: "tsx-api:latest" },
    { Service: "scanner", Name: "scanner-1", Image: "tsx-scanner:latest" },
    { Service: "web", Name: "web-1", Image: "tsx-web:latest" },
  ];
  const images = {
    api: { image: digests.api },
    worker: { image: digests.worker },
    scanner: { image: digests.scanner },
    web: { image: digests.web },
  };
  assert.equal(validateContainerImages(rows, images), images);
});

test("research scanner capture must use the live scanner image", () => {
  const rows = [
    { Service: "api", Name: "api-1" },
    { Service: "worker", Name: "worker-1" },
    { Service: "scanner", Name: "scanner-1" },
    { Service: "scanner-research", Name: "scanner-research-1" },
    { Service: "web", Name: "web-1" },
  ];
  const images = {
    api: { image: digests.api },
    worker: { image: digests.worker },
    scanner: { image: digests.scanner },
    "scanner-research": { image: digests.api },
    web: { image: digests.web },
  };
  assert.throws(
    () => validateContainerImages(rows, images),
    /RESEARCH_SCANNER_IMAGE_MISMATCH/,
  );
  images["scanner-research"].image = digests.scanner;
  assert.equal(validateContainerImages(rows, images), images);
});

test("build source must match the requested sha and be clean", () => {
  assert.doesNotThrow(() =>
    validateBuildSource({ requestedSha: sha, headSha: sha, status: "" }),
  );
  assert.throws(
    () =>
      validateBuildSource({
        requestedSha: sha,
        headSha: "b".repeat(40),
        status: "",
      }),
    /DEPLOYMENT_SHA_HEAD_MISMATCH/,
  );
  assert.throws(
    () =>
      validateBuildSource({
        requestedSha: sha,
        headSha: sha,
        status: "?? source.ts",
      }),
    /DEPLOYMENT_SOURCE_DIRTY/,
  );
});

test("built image revision must be the tested sha, not an inherited label", () => {
  assert.doesNotThrow(() =>
    validateImageRevision({
      sha,
      labels: { "org.opencontainers.image.revision": sha },
    }),
  );
  assert.throws(
    () =>
      validateImageRevision({
        sha,
        labels: { "org.opencontainers.image.revision": "c".repeat(40) },
      }),
    /DEPLOYMENT_IMAGE_REVISION_MISMATCH/,
  );
});

test("retention keeps a bounded set of prior images", () => {
  const refs = Array.from({ length: 7 }, (_, index) => ({
    capturedAt: `2026-09-2${index}T00:00:00.000Z`,
  }));
  const { keep, prune } = retentionKeep(refs, 5);
  assert.equal(keep.length, 5);
  assert.equal(prune.length, 2);
});

test("preflight refuses a deployment during market hours unless explicitly allowed", () => {
  // Friday 2026-09-25: 11:00 ET, 16:05 ET, 16:15 ET; Saturday 11:00 ET.
  assert.throws(
    () => assertOutsideMarketHours(new Date("2026-09-25T15:00:00Z")),
    /DEPLOYMENT_DURING_MARKET_HOURS/,
  );
  assert.throws(
    () => assertOutsideMarketHours(new Date("2026-09-25T20:05:00Z")),
    /DEPLOYMENT_DURING_MARKET_HOURS/,
  );
  assertOutsideMarketHours(new Date("2026-09-25T20:15:00Z"));
  assertOutsideMarketHours(new Date("2026-09-26T15:00:00Z"));
  assertOutsideMarketHours(new Date("2026-09-25T15:00:00Z"), true);
});
