// Curated barrel: contracts/src/index.ts stays a thin re-export surface so existing imports
// (`import { X } from "@tsx-scanner/contracts"`) keep working unchanged. The actual schema/type
// definitions live in contracts/src/domains/*.ts, one module per business domain. When adding a
// new contract, add it to the relevant domain module (or a new one) and re-export it here — do
// not add schema definitions directly to this file.
export * from "./domains/system-status.js";
export * from "./domains/market-data.js";
export * from "./domains/strategies.js";
export * from "./domains/scoring.js";
export * from "./domains/engine.js";
export * from "./domains/candidates.js";
export * from "./domains/profiles.js";
export * from "./domains/alerts.js";
export * from "./domains/backtests.js";
export * from "./domains/ranking-research.js";
export * from "./domains/calibration.js";
export * from "./domains/statistical-models.js";
export * from "./domains/paper-evidence-training.js";
export * from "./domains/paper-bot.js";
export * from "./domains/universe.js";
export * from "./domains/discovery.js";
export * from "./domains/discovery-evidence.js";
export * from "./domains/markets.js";
export * from "./domains/events-jobs.js";
export * from "./domains/research-evidence.js";
export * from "./domains/strategy-studies.js";
export * from "./domains/evidence-automation.js";
export * from "./domains/challenger-observation.js";
export * from "./domains/execution-diagnostics.js";
export * from "./domains/backtest-automation.js";
export * from "./domains/funded-learning-evidence.js";
export * from "./domains/funded-execution-training.js";
export * from "./domains/funded-comparison.js";
