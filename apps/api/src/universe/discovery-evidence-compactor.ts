import type { PostgresDiscoveryEvidenceStore } from "./discovery-evidence-repository.js";

export interface DiscoveryEvidenceCompactionResult {
  inputs: number;
  runs: number;
}

export interface DiscoveryEvidenceCompactionLogger {
  info(fields: Record<string, unknown>): void;
  error(fields: Record<string, unknown>): void;
}

export interface DiscoveryEvidenceCompactorOptions {
  enabled?: boolean;
  intervalMs?: number;
  inputDays?: number;
  summaryDays?: number;
  logger?: DiscoveryEvidenceCompactionLogger;
}

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_INPUT_DAYS = 30;
const DEFAULT_SUMMARY_DAYS = 365;
const SILENT_LOGGER: DiscoveryEvidenceCompactionLogger = {
  info: () => {},
  error: () => {},
};

/**
 * API-owned maintenance loop for discovery evidence. It only removes payloads
 * and terminal summaries through the repository's bounded, hold-aware method;
 * it never starts a discovery cycle or changes intake state.
 */
export class DiscoveryEvidenceCompactor {
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly inputDays: number;
  private readonly summaryDays: number;
  private readonly logger: DiscoveryEvidenceCompactionLogger;
  private timer: NodeJS.Timeout | undefined;
  private active?: Promise<DiscoveryEvidenceCompactionResult>;

  constructor(
    private readonly store: Pick<PostgresDiscoveryEvidenceStore, "compact">,
    options: DiscoveryEvidenceCompactorOptions = {},
  ) {
    this.enabled = options.enabled ?? true;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.inputDays = options.inputDays ?? DEFAULT_INPUT_DAYS;
    this.summaryDays = options.summaryDays ?? DEFAULT_SUMMARY_DAYS;
    this.logger = options.logger ?? SILENT_LOGGER;
    if (!Number.isInteger(this.intervalMs) || this.intervalMs < 60_000)
      throw new Error(
        "Discovery evidence compaction interval must be at least 60 seconds",
      );
    if (!Number.isInteger(this.inputDays) || this.inputDays < 1)
      throw new Error("Discovery input retention must be a positive day count");
    if (
      !Number.isInteger(this.summaryDays) ||
      this.summaryDays < this.inputDays
    )
      throw new Error(
        "Discovery summary retention must not be shorter than input retention",
      );
  }

  start(): void {
    if (!this.enabled || this.timer) return;
    this.timer = setInterval(() => {
      void this.runOnce().catch(() => {
        // runOnce records the failure; the maintenance loop must remain alive.
      });
    }, this.intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.active) await this.active;
  }

  /** Run one bounded pass, coalescing a timer tick with an already active pass. */
  runOnce(): Promise<DiscoveryEvidenceCompactionResult> {
    if (!this.enabled)
      return Promise.reject(
        new Error("Discovery evidence compaction is disabled"),
      );
    if (this.active) return this.active;
    const operation = this.store
      .compact(this.inputDays, this.summaryDays)
      .then((result) => {
        this.logger.info({
          event: "DISCOVERY_EVIDENCE_COMPACTION_COMPLETED",
          ...result,
          inputDays: this.inputDays,
          summaryDays: this.summaryDays,
        });
        return result;
      })
      .catch((error: unknown) => {
        this.logger.error({
          event: "DISCOVERY_EVIDENCE_COMPACTION_FAILED",
          inputDays: this.inputDays,
          summaryDays: this.summaryDays,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      })
      .finally(() => {
        this.active = undefined;
      });
    this.active = operation;
    return operation;
  }
}
