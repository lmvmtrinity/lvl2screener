import { describe, expect, it, vi } from "vitest";
import { IdleBackoffGate } from "../src/worker/idle-backoff-gate.js";

describe("idle worker backoff", () => {
  it("limits idle polls per market and resumes immediately while work remains", async () => {
    let now = 0;
    const gate = new IdleBackoffGate(() => now);
    const probe = vi.fn(async () => false);
    await gate.run("CA_TSX", probe);
    await gate.run("CA_TSX", probe);
    await gate.run("US_EQUITIES", probe);
    expect(probe).toHaveBeenCalledTimes(2);
    now = 30_000;
    await gate.run("CA_TSX", async () => true);
    await gate.run("CA_TSX", probe);
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it("backs failed probes off from 30 seconds to at most five minutes", async () => {
    let now = 0;
    const gate = new IdleBackoffGate(() => now);
    const fail = vi.fn(async (): Promise<boolean> => {
      throw new Error("db");
    });
    for (const delay of [30_000, 60_000, 120_000, 240_000, 300_000]) {
      await expect(gate.run("CA_TSX", fail)).rejects.toThrow("db");
      const calls = fail.mock.calls.length;
      now += delay - 1;
      await gate.run("CA_TSX", fail);
      expect(fail).toHaveBeenCalledTimes(calls);
      now += 1;
    }
    expect(fail).toHaveBeenCalledTimes(5);
  });
});
