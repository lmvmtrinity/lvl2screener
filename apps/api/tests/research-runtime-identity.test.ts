import { describe, expect, it } from "vitest";
import {
  runtimeFingerprint,
  assertStudyIdentity,
} from "../src/backtests/research-runtime-identity.js";
import type {
  FrozenStudyPlan,
  StudyExecutionAuthorization,
} from "@tsx-scanner/contracts";

describe("research runtime identity", () => {
  it("hashes a normalized allowlist independent of key order", () => {
    expect(runtimeFingerprint({ node: "22", scanner: "1" })).toBe(
      runtimeFingerprint({ scanner: "1", node: "22" }),
    );
  });

  it("rejects runtime drift", () => {
    const plan = {
      binding: {
        engineRevision: "a".repeat(40),
        runtimeFingerprint: "b".repeat(64),
      },
    } as unknown as FrozenStudyPlan;
    const authorization = {
      engineRevision: plan.binding.engineRevision,
      runtimeFingerprint: plan.binding.runtimeFingerprint,
    } as unknown as StudyExecutionAuthorization;
    expect(() =>
      assertStudyIdentity({
        authorization,
        plan,
        runtime: {
          engineRevision: "c".repeat(40),
          runtimeFingerprint: "b".repeat(64),
        },
      }),
    ).toThrow("STUDY_RUNTIME_MISMATCH");
  });
});
