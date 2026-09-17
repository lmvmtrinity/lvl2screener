import { Pool } from "pg";
import { loadConfig } from "./config.js";
import { migrate } from "./database/migrate.js";
import { PostgresBacktestStore } from "./backtests/backtest-repository.js";
import { BacktestService } from "./backtests/backtest-service.js";
import { ScannerFeatureClient } from "./market-data/scanner-client.js";
import { PostgresProfileStore } from "./profiles/profile-repository.js";
import { PostgresCalibrationStore } from "./calibration/calibration-repository.js";
import { CalibrationService } from "./calibration/calibration-service.js";
import { PostgresStatisticalModelStore } from "./statistical-models/statistical-model-repository.js";
import { StatisticalModelService } from "./statistical-models/statistical-model-service.js";
import { PostgresPaperEvidenceTrainingStore } from "./statistical-models/paper-evidence-training-repository.js";
import { PaperEvidenceTrainingService } from "./statistical-models/paper-evidence-training-service.js";
import { PostgresRankingResearchStore } from "./ranking-research/ranking-research-repository.js";
import { RankingResearchService } from "./ranking-research/ranking-research-service.js";
import { EvidenceMigrationRepository } from "./evidence-migration/evidence-migration-repository.js";
import { EvidenceMigrationService } from "./evidence-migration/evidence-migration-service.js";

const config = loadConfig();
const pool = new Pool({ connectionString: config.DATABASE_URL, max: 5 });

try {
  await migrate(pool);
  const store = new PostgresBacktestStore(pool);
  const scanner = new ScannerFeatureClient(
    new URL(config.SCANNER_URL),
    10_000,
    config.SCANNER_SERVICE_TOKEN,
  );
  const policy = {
    timezone: config.SESSION_TIMEZONE,
    openingRange: {
      start: config.OPENING_RANGE_START,
      end: config.OPENING_RANGE_END,
    },
    scanning: { start: config.SCANNING_START, end: config.SCANNING_END },
    entries: {
      preferredStart: config.ENTRY_PREFERRED_START,
      preferredEnd: config.ENTRY_PREFERRED_END,
      hardEnd: config.ENTRY_HARD_END,
    },
    benchmarkMaxStalenessSeconds: config.BENCHMARK_MAX_STALENESS_SECONDS,
  } as const;
  const backtests = new BacktestService(
    store,
    scanner,
    policy,
    new PostgresProfileStore(pool),
  );
  const service = new EvidenceMigrationService(
    new EvidenceMigrationRepository(pool),
    backtests,
    new CalibrationService(
      new PostgresCalibrationStore(pool),
      store,
      scanner,
      policy,
    ),
    new StatisticalModelService(
      new PostgresStatisticalModelStore(pool),
      store,
      scanner,
      new PaperEvidenceTrainingService(
        new PostgresPaperEvidenceTrainingStore(pool),
      ),
    ),
    new RankingResearchService(new PostgresRankingResearchStore(pool), store),
    {
      info: (fields) => console.log(JSON.stringify(fields)),
      error: (fields) => console.error(JSON.stringify(fields)),
    },
  );
  console.log(JSON.stringify(await service.run(), null, 2));
} finally {
  await pool.end();
}
