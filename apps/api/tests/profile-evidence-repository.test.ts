import { describe, expect, it } from "vitest";
import { PostgresProfileStore } from "../src/profiles/profile-repository.js";
import { AUTHORITATIVE_EXECUTION_MODEL_VERSION } from "../src/backtests/execution-provenance.js";

const profileId = "10000000-0000-4000-8000-000000000081";
const runId = "10000000-0000-4000-8000-000000000080";

describe("profile evidence provenance", () => {
  it("links evidence only through the current exact config, strategy, and version", async () => {
    const queries: Array<{ sql: string; values: unknown[] | undefined }> = [];
    const store = new PostgresProfileStore({
      query: async (sql: string, values?: unknown[]) => {
        queries.push({ sql, values });
        return { rows: [] };
      },
    } as never);
    await store.linkBacktestEvidence(
      {
        id: runId,
        executionModelVersion: AUTHORITATIVE_EXECUTION_MODEL_VERSION,
        strategyVersion: "1.0.0",
        parameters: { scoreCutoff: 70 },
      } as never,
      [
        {
          strategy: "ORB_RETEST",
          evidence: {
            qualification: "EVIDENCE_QUALIFIED",
            generatedAt: "2026-08-28T12:00:00.000Z",
          } as never,
        },
      ],
    );
    expect(queries).toHaveLength(1);
    expect(queries[0]?.sql).toContain("c.parameters=$4::jsonb");
    expect(queries[0]?.sql).toContain("d.strategy_key=$5 AND d.version=$6");
    expect(queries[0]?.values).toEqual([
      runId,
      "EVIDENCE_QUALIFIED",
      expect.any(String),
      JSON.stringify({ scoreCutoff: 70 }),
      "ORB_RETEST",
      "1.0.0",
    ]);
  });

  it("does not grant profile evidence from a legacy execution model", async () => {
    const queries: string[] = [];
    const store = new PostgresProfileStore({
      query: async (sql: string) => {
        queries.push(sql);
        return { rows: [] };
      },
    } as never);

    await store.linkBacktestEvidence(
      {
        id: runId,
        executionModelVersion: "legacy-python-v1",
      } as never,
      [],
    );
    expect(queries).toEqual([]);
  });

  it("aggregates LIVE outcomes by setup instance instead of evaluation polling rows", async () => {
    const queries: string[] = [];
    const store = new PostgresProfileStore({
      query: async (sql: string) => {
        queries.push(sql);
        return {
          rows: [
            {
              profile_id: profileId,
              name: "ORB",
              setup: true,
              false_positive: false,
            },
          ],
        };
      },
    } as never);
    const outcomes = await store.comparisonOutcomes(
      [profileId],
      "LIVE",
      "2026-08-01",
      "2026-08-28",
      "09:30",
      "16:00",
    );
    expect(outcomes).toHaveLength(1);
    expect(queries[0]).toContain(
      "GROUP BY e.profile_id,p.name,e.setup_instance_id",
    );
    expect(queries[0]).toContain("e.setup_instance_id IS NOT NULL");
  });

  it("uses persisted canonical paper-bot executions for PAPER comparisons", async () => {
    const queries: string[] = [];
    const store = new PostgresProfileStore({
      query: async (sql: string) => {
        queries.push(sql);
        return {
          rows: [
            {
              profile_id: profileId,
              name: "ORB",
              net_pnl: "42.5",
              r_multiple: "0.85",
              signal_time: new Date("2026-08-04T13:50:00.000Z"),
              entry_time: new Date("2026-08-04T14:00:00.000Z"),
              exit_time: new Date("2026-08-04T14:20:00.000Z"),
            },
          ],
        };
      },
    } as never);

    const outcomes = await store.comparisonOutcomes(
      [profileId],
      "PAPER",
      "2026-08-01",
      "2026-08-28",
      "09:30",
      "16:00",
    );

    expect(outcomes).toEqual([
      expect.objectContaining({ pnl: 42.5, rMultiple: 0.85, holdMinutes: 20 }),
    ]);
    expect(queries[0]).toContain("FROM paper_execution x");
    expect(queries[0]).toContain("x.model='QUOTE'");
    expect(queries[0]).toContain("r.source='LIVE'");
  });

  it("rejects a persisted outcome whose exit precedes its signal", async () => {
    const store = new PostgresProfileStore({
      query: async () => ({
        rows: [
          {
            profile_id: profileId,
            name: "ORB",
            net_pnl: "42.5",
            r_multiple: "0.85",
            signal_time: new Date("2026-08-04T14:00:00.000Z"),
            entry_time: new Date("2026-08-04T14:05:00.000Z"),
            exit_time: new Date("2026-08-04T13:59:00.000Z"),
          },
        ],
      }),
    } as never);

    await expect(
      store.comparisonOutcomes(
        [profileId],
        "PAPER",
        "2026-08-01",
        "2026-08-28",
        "09:30",
        "16:00",
      ),
    ).rejects.toThrow("Comparison outcome exit precedes signal or entry time");
  });

  it("qualifies only against completed authoritative bot runs", async () => {
    const queries: string[] = [];
    const store = new PostgresProfileStore({
      query: async (sql: string) => {
        queries.push(sql);
        return { rows: [] };
      },
    } as never);

    await store.listProfiles();

    expect(queries[0]).toContain(
      "r.source='LIVE' AND r.status='COMPLETED' AND r.execution_model_version=$1",
    );
    expect(queries[0]).toContain("FROM paper_profile_qualification q");
  });
});
