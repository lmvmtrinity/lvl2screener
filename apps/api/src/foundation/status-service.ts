import type { DependencyStatus, SystemStatus } from "@tsx-scanner/contracts";
import type { DependencyProbe } from "./probes.js";
import {
  computeOperationalStatus,
  type OperationalStatusInput,
} from "./operational-status.js";
import { API_VERSION } from "../version.js";

export interface FoundationProbes {
  database: DependencyProbe;
  scanner: DependencyProbe;
  marketData: DependencyProbe;
}

/** Supplies the business-facing half of the operational-status contract. Kept as a narrow
 *  interface (rather than importing `QuestradeDataService` directly) so this module has no
 *  dependency on Postgres, Questrade, or the scanner client. */
export interface OperationalStatusSource {
  getOperationalStatusInput(): Omit<
    OperationalStatusInput,
    "databaseReady" | "scannerReady" | "marketDataMode"
  >;
}

export class FoundationStatusService {
  constructor(
    private readonly probes: FoundationProbes,
    private readonly clock: () => Date = () => new Date(),
    private readonly mode: SystemStatus["mode"] = "mock",
    private readonly operationalSource?: OperationalStatusSource,
  ) {}

  async getStatus(): Promise<SystemStatus> {
    const [database, scanner, marketData] = await Promise.all([
      safeCheck(this.probes.database),
      safeCheck(this.probes.scanner),
      safeCheck(this.probes.marketData),
    ]);
    const checks = {
      database,
      scanner,
      config: { status: "ok" as const, detail: "Configuration loaded" },
      marketData,
    };
    // /health/ready stays scoped to "can this service serve the operator UI": only the
    // dependencies the API itself needs (database, scanner reachability, config) gate it.
    // Market-data business state (auth required, market closed, empty universe, ...) is
    // reported through `operational` below and never turns this into a 503 on its own.
    const status = [checks.database, checks.scanner, checks.config].every(
      (check) => check.status === "ok",
    )
      ? "ok"
      : "degraded";

    const operationalInput =
      this.operationalSource?.getOperationalStatusInput();
    const operational = computeOperationalStatus({
      databaseReady: database.status === "ok",
      scannerReady: scanner.status === "ok",
      marketDataMode: this.mode,
      auth: operationalInput?.auth ?? "UNKNOWN",
      marketStatus: operationalInput?.marketStatus ?? null,
      phase: operationalInput?.phase ?? null,
      quoteAgeMs: operationalInput?.quoteAgeMs ?? null,
      candleAgeMs: operationalInput?.candleAgeMs ?? null,
      benchmarkAgeMs: operationalInput?.benchmarkAgeMs ?? null,
      evaluationAgeMs: operationalInput?.evaluationAgeMs ?? null,
      universeConfigured: operationalInput?.universeConfigured ?? 0,
      universeResolved: operationalInput?.universeResolved ?? 0,
      universeEvaluated: operationalInput?.universeEvaluated ?? 0,
      benchmarkReady: operationalInput?.benchmarkReady ?? false,
      scannerSynchronized: operationalInput?.scannerSynchronized ?? false,
    });

    return {
      service: "api",
      status,
      version: API_VERSION,
      timestamp: this.clock().toISOString(),
      mode: this.mode,
      checks,
      operational,
    };
  }
}

async function safeCheck(probe: DependencyProbe): Promise<DependencyStatus> {
  try {
    return await probe.check();
  } catch (error) {
    return {
      status: "error",
      detail:
        error instanceof Error ? error.message : "Unknown dependency error",
    };
  }
}
