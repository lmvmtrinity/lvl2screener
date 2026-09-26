function sortedKeys(value) {
  return Object.keys(value ?? {}).sort((left, right) =>
    left.localeCompare(right),
  );
}

export function compareTableRowCounts(expected, actual) {
  const expectedValue = expected;
  const actualValue = actual;
  if (
    expectedValue === null ||
    typeof expectedValue !== "object" ||
    Array.isArray(expectedValue) ||
    actualValue === null ||
    typeof actualValue !== "object" ||
    Array.isArray(actualValue)
  ) {
    return {
      equal: false,
      missing: [],
      extra: [],
      different: [
        {
          table: "<tableRowCounts>",
          expected: expectedValue,
          actual: actualValue,
        },
      ],
    };
  }
  const expectedKeys = new Set(sortedKeys(expectedValue));
  const actualKeys = new Set(sortedKeys(actualValue));
  const missing = [...expectedKeys].filter((key) => !actualKeys.has(key));
  const extra = [...actualKeys].filter((key) => !expectedKeys.has(key));
  const different = [...expectedKeys]
    .filter(
      (key) => actualKeys.has(key) && expectedValue[key] !== actualValue[key],
    )
    .map((table) => ({
      table,
      expected: expectedValue[table],
      actual: actualValue[table],
    }));

  return {
    equal: missing.length === 0 && extra.length === 0 && different.length === 0,
    missing,
    extra,
    different,
  };
}

export function describeTableRowCountMismatch(comparison) {
  const details = [];
  if (comparison.missing.length > 0)
    details.push(`missing tables: ${comparison.missing.join(", ")}`);
  if (comparison.extra.length > 0)
    details.push(`extra tables: ${comparison.extra.join(", ")}`);
  if (comparison.different.length > 0) {
    details.push(
      `different counts: ${comparison.different
        .map(
          ({ table, expected, actual }) =>
            `${table} expected ${String(expected)} restored ${String(actual)}`,
        )
        .join(", ")}`,
    );
  }
  return details.join("; ");
}
