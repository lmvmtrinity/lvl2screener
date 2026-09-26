import assert from "node:assert/strict";
import test from "node:test";

import {
  compareTableRowCounts,
  describeTableRowCountMismatch,
} from "../backup-manifest.mjs";

test("table row count comparison ignores capture and restore insertion order", () => {
  const tinyHarnessManifest = {
    "public.candle": "2",
    "public.context": "1",
    "public.feature": "2",
    "public.instrument": "2",
    "public.probe_audit": "1",
  };
  const reversedRestoreCounts = Object.fromEntries(
    Object.entries(tinyHarnessManifest).reverse(),
  );

  assert.deepEqual(
    compareTableRowCounts(tinyHarnessManifest, reversedRestoreCounts),
    { equal: true, missing: [], extra: [], different: [] },
  );
});

test("table row count comparison reports missing, extra, and changed tables", () => {
  const comparison = compareTableRowCounts(
    { "public.candle": "2", "public.feature": "2" },
    { "public.candle": "3", "public.instrument": "1" },
  );
  assert.deepEqual(comparison, {
    equal: false,
    missing: ["public.feature"],
    extra: ["public.instrument"],
    different: [{ table: "public.candle", expected: "2", actual: "3" }],
  });
  assert.match(
    describeTableRowCountMismatch(comparison),
    /missing tables: public\.feature; extra tables: public\.instrument; different counts: public\.candle expected 2 restored 3/u,
  );
});
