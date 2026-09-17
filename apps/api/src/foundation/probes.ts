import {
  scannerReadinessSchema,
  type DependencyStatus,
} from "@tsx-scanner/contracts";
import { Pool } from "pg";

export interface DependencyProbe {
  check(): Promise<DependencyStatus>;
}

export class DatabaseProbe implements DependencyProbe {
  constructor(private readonly pool: Pool) {}

  async check(): Promise<DependencyStatus> {
    try {
      const result = await this.pool.query<{ extversion: string }>(
        "SELECT extversion FROM pg_extension WHERE extname = 'timescaledb'",
      );
      const version = result.rows[0]?.extversion;
      if (!version)
        return {
          status: "error",
          detail: "TimescaleDB extension is not installed",
        };
      return { status: "ok", detail: `TimescaleDB ${version}` };
    } catch (error) {
      return { status: "error", detail: errorMessage(error) };
    }
  }
}

export class ScannerProbe implements DependencyProbe {
  constructor(
    private readonly scannerUrl: URL,
    private readonly timeoutMs = 2_000,
  ) {}

  async check(): Promise<DependencyStatus> {
    try {
      const response = await fetch(new URL("/health/ready", this.scannerUrl), {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok)
        return {
          status: "error",
          detail: `Scanner returned HTTP ${response.status}`,
        };
      const readiness = scannerReadinessSchema.parse(await response.json());
      if (readiness.status !== "ok")
        return {
          status: "error",
          detail: "Scanner reported degraded readiness",
        };
      return {
        status: "ok",
        detail: `${readiness.service} ${readiness.version}`,
      };
    } catch (error) {
      return { status: "error", detail: errorMessage(error) };
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown dependency error";
}
