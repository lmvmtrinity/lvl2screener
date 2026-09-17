import { describe, expect, it } from "vitest";
import { DiscoveryWritePerformanceAttempt } from "../src/universe/discovery-evidence-repository.js";

describe("discovery write-performance attempt", () => {
  it("ignores late writes after finalization and keeps retry timings isolated", () => {
    const failedAttempt = new DiscoveryWritePerformanceAttempt();
    failedAttempt.record(777, 888);

    expect(failedAttempt.take()).toEqual({
      serializationMs: 777,
      persistenceMs: 888,
    });

    // An in-flight sibling may settle after the failed attempt has finalized.
    failedAttempt.record(500, 600);
    expect(failedAttempt.take()).toBeNull();

    const retryAttempt = new DiscoveryWritePerformanceAttempt();
    retryAttempt.record(10, 20);
    expect(retryAttempt.take()).toEqual({
      serializationMs: 10,
      persistenceMs: 20,
    });
  });
});
