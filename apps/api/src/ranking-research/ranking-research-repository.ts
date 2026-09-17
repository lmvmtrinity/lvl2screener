import {
  ACTIVE_RANKING_FORMULA_VERSION,
  rankingResearchRunSchema,
  type CreateRankingResearch,
  type RankingResearchFormulaResult,
  type RankingResearchRun,
} from "@tsx-scanner/contracts";
import type { Pool } from "pg";
import type { MarketId } from "@tsx-scanner/contracts";
import type { RankingResearchStore } from "./ranking-research-service.js";

interface Row {
  id: string;
  market_id: MarketId;
  name: string;
  status: string;
  backtest_run_id: string;
  execution_model_version: string | null;
  input: unknown;
  active_formula_version_at_start: string;
  chronological_split_at: Date | null;
  results: unknown;
  warnings: unknown;
  error: string | null;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
}
const columns =
  "id,market_id,name,status,backtest_run_id,execution_model_version,input,active_formula_version_at_start,chronological_split_at,results,warnings,error,created_at,started_at,completed_at";

export class PostgresRankingResearchStore implements RankingResearchStore {
  constructor(private readonly pool: Pool) {}
  async create(
    input: CreateRankingResearch,
    executionModelVersion: string,
  ): Promise<RankingResearchRun> {
    const result = await this.pool.query<Row>(
      `INSERT INTO ranking_research_run(market_id,name,status,backtest_run_id,execution_model_version,input,active_formula_version_at_start)
      VALUES($1,$2,'PENDING',$3,$4,$5::jsonb,$6) RETURNING ${columns}`,
      [
        input.marketId,
        input.name,
        input.backtestRunId,
        executionModelVersion,
        JSON.stringify(input),
        ACTIVE_RANKING_FORMULA_VERSION,
      ],
    );
    return map(result.rows[0]!);
  }
  async markRunning(id: string): Promise<void> {
    await this.pool.query(
      "UPDATE ranking_research_run SET status='RUNNING',started_at=now(),error=null WHERE id=$1",
      [id],
    );
  }
  async complete(
    id: string,
    splitAt: string | null,
    results: RankingResearchFormulaResult[],
    warnings: string[],
  ): Promise<RankingResearchRun> {
    const result = await this.pool.query<Row>(
      `UPDATE ranking_research_run SET status='COMPLETED',chronological_split_at=$2,results=$3::jsonb,warnings=$4::jsonb,completed_at=now()
      WHERE id=$1 RETURNING ${columns}`,
      [id, splitAt, JSON.stringify(results), JSON.stringify(warnings)],
    );
    return map(result.rows[0]!);
  }
  async fail(id: string, error: string): Promise<void> {
    await this.pool.query(
      "UPDATE ranking_research_run SET status='FAILED',error=$2,completed_at=now() WHERE id=$1",
      [id, error.slice(0, 5000)],
    );
  }
  async list(limit = 50): Promise<RankingResearchRun[]> {
    const result = await this.pool.query<Row>(
      `SELECT ${columns} FROM ranking_research_run ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
    return result.rows.map(map);
  }
  async get(id: string): Promise<RankingResearchRun | undefined> {
    const result = await this.pool.query<Row>(
      `SELECT ${columns} FROM ranking_research_run WHERE id=$1`,
      [id],
    );
    return result.rows[0] ? map(result.rows[0]) : undefined;
  }
}

function map(row: Row): RankingResearchRun {
  return rankingResearchRunSchema.parse({
    id: row.id,
    marketId: row.market_id,
    name: row.name,
    status: row.status,
    backtestRunId: row.backtest_run_id,
    executionModelVersion: row.execution_model_version,
    input: row.input,
    activeFormulaVersionAtStart: row.active_formula_version_at_start,
    chronologicalSplitAt: row.chronological_split_at?.toISOString() ?? null,
    results: row.results,
    warnings: row.warnings,
    error: row.error,
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    completedAt: row.completed_at?.toISOString() ?? null,
  });
}
