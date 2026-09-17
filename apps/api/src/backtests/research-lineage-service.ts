import type {
  DatasetResearchDerivation,
  MarketId,
  ResearchEvidenceBinding,
} from "@tsx-scanner/contracts";
import type { Pool } from "pg";
import type { ReplaySessionPolicy } from "./backtest-repository.js";
import type { ResearchRuntimeIdentityProvider } from "./research-runtime-identity.js";
import { contentHash } from "./research-coverage.js";
import { PostgresCoverageRequestRepository } from "./coverage-request-repository.js";
import { PostgresResearchEvidenceStore } from "./research-evidence-repository.js";
import {
  evidenceWorkKey,
  PostgresEvidenceAutomationRepository,
} from "../statistical-models/evidence-automation-repository.js";

export type ArtifactCoverageScope = {
  kind: "DATASET" | "BACKTEST" | "CALIBRATION";
  marketId: MarketId;
  scope: unknown;
  sessionDates: string[];
  inputCutoff: string;
  sessionPayloadHashes?: Record<string, string>;
};
export type ArtifactResearchResolution = {
  binding?: ResearchEvidenceBinding;
  /**
   * The dataset derivation record, when the caller is a dataset producer.
   * Non-dataset producers keep null.
   */
  derivation: DatasetResearchDerivation | null;
};
export interface ArtifactResearchLineage {
  resolve(
    input: ArtifactCoverageScope,
  ): Promise<ResearchEvidenceBinding | undefined>;
  /**
   * Full resolution including the first-class dataset derivation record.
   * `resolve` remains the compatibility surface for backtest, calibration and
   * model producers; dataset materialization persists what this returns.
   */
  resolveArtifact?(
    input: ArtifactCoverageScope,
  ): Promise<ArtifactResearchResolution>;
}

/** Routine preparation never fetches provider data or changes training eligibility.
 * A missing proof leaves the baseline artifact unverified and creates inspectable work. */
export class ResearchLineageService implements ArtifactResearchLineage {
  constructor(
    private readonly pool: Pool,
    private readonly runtime: ResearchRuntimeIdentityProvider,
    private readonly policies: Readonly<Record<MarketId, ReplaySessionPolicy>>,
  ) {}

  async resolve(
    input: ArtifactCoverageScope,
  ): Promise<ResearchEvidenceBinding | undefined> {
    return (await this.resolveArtifact(input)).binding;
  }

  async resolveArtifact(
    input: ArtifactCoverageScope,
  ): Promise<ArtifactResearchResolution> {
    // Optional evidence processing must not veto ordinary baseline artifacts.
    try {
      return await this.resolveExact(stableArtifactScope(input));
    } catch {
      const scopeHash = contentHash(stableArtifactScope(input));
      const identity = {
        kind: "COVERAGE" as const,
        marketId: input.marketId,
        scopeHash,
        inputIdentityHash: scopeHash,
        processorVersion: "artifact-coverage-v1",
      };
      await new PostgresEvidenceAutomationRepository(this.pool)
        .record(identity, {
          workKey: evidenceWorkKey(identity),
          identity,
          state: "WAITING",
          jobId: null,
          reasonCodes: ["COVERAGE_PREPARATION_FAILED"],
          recordedAt: new Date().toISOString(),
        })
        .catch(() => undefined);
      return {
        derivation:
          input.kind === "DATASET"
            ? this.datasetDerivation(
                stableArtifactScope(input),
                undefined,
                undefined,
                undefined,
              )
            : null,
      };
    }
  }

  private async resolveExact(
    input: ArtifactCoverageScope,
  ): Promise<ArtifactResearchResolution> {
    const scopeHash = contentHash(input);
    const runtime = await this.runtime.current();
    if (!runtime?.featureVersion || input.sessionDates.length === 0) {
      const identity = {
        kind: "COVERAGE" as const,
        marketId: input.marketId,
        scopeHash,
        inputIdentityHash: scopeHash,
        processorVersion: "artifact-coverage-v1",
      };
      await new PostgresEvidenceAutomationRepository(this.pool).record(
        identity,
        {
          workKey: evidenceWorkKey(identity),
          identity,
          jobId: null,
          state: "WAITING",
          reasonCodes: [
            !runtime?.featureVersion
              ? "RESEARCH_RUNTIME_IDENTITY_UNAVAILABLE"
              : "COVERAGE_SESSION_SCOPE_UNAVAILABLE",
          ],
          recordedAt: new Date().toISOString(),
        },
      );
      return {
        derivation:
          input.kind === "DATASET"
            ? this.datasetDerivation(input, runtime, undefined, undefined)
            : null,
      };
    }
    const policy = {
      ...this.policies[input.marketId],
      marketId: input.marketId,
    };
    const manifest = {
      version: "artifact-coverage-v1",
      purpose: input,
      plan: { expectedSessions: input.sessionDates },
    };
    const request = await new PostgresCoverageRequestRepository(
      this.pool,
    ).create(
      {
        manifest: {
          hash: contentHash(manifest),
          marketId: input.marketId,
          manifest,
        },
        recipe: {
          version: "research-coverage-recipe-v2",
          marketId: input.marketId,
          ...runtime,
          featureVersion: runtime.featureVersion,
          sessionDates: input.sessionDates,
          inputCutoff: input.inputCutoff,
          streamRequirements: [
            {
              timeframe: "Daily",
              warmupDays: 45,
              requiredWarmupBars: 20,
              includeInSession: false,
            },
            {
              timeframe: "OneMinute",
              warmupDays: 20,
              requiredWarmupBars: 20,
              includeInSession: true,
            },
            {
              timeframe: "FiveMinutes",
              warmupDays: 1,
              requiredWarmupBars: 0,
              includeInSession: true,
            },
          ],
          maxQuoteGapMs: 30000,
          replayPolicy: policy,
          replayPolicyHash: contentHash(policy),
          membershipPolicyHash: contentHash({
            policy: "retained-universe-membership-v1",
            marketId: input.marketId,
          }),
          calendarPolicyHash: contentHash({
            policy: "retained-session-calendar-v1",
            timezone: policy.timezone,
          }),
        },
      },
      `artifact-coverage:${scopeHash}:${contentHash(runtime)}`,
    );
    const evidence = new PostgresResearchEvidenceStore(this.pool);
    const binding = request.latestJobId
      ? await evidence.getBinding({
          kind: "JOB",
          id: request.latestJobId,
          marketId: input.marketId,
        })
      : undefined;
    const report = binding
      ? await evidence.getReport(binding.coverageReportHash)
      : undefined;
    if (input.kind === "DATASET") {
      const derivation = this.datasetDerivation(
        input,
        runtime,
        binding,
        report,
      );
      if (!derivation.complete) {
        // A market/session report alone does not prove which raw inputs
        // produced the frozen statistical features. The derivation record is
        // retained on the dataset; while incomplete the owner binding stays
        // absent and the prerequisite remains visible.
        const identity = {
          kind: "COVERAGE" as const,
          marketId: input.marketId,
          scopeHash,
          inputIdentityHash: scopeHash,
          processorVersion: "dataset-derivation-v1",
        };
        await new PostgresEvidenceAutomationRepository(this.pool).record(
          identity,
          {
            workKey: evidenceWorkKey(identity),
            identity,
            jobId: null,
            state: "WAITING",
            reasonCodes: ["DATASET_DERIVATION_UNPROVEN"],
            recordedAt: new Date().toISOString(),
          },
        );
        return { derivation };
      }
      return { binding: binding ?? undefined, derivation };
    }
    if (
      !binding ||
      !report ||
      report.status !== "VERIFIED" ||
      binding.engineRevision !== runtime.engineRevision ||
      binding.runtimeFingerprint !== runtime.runtimeFingerprint
    )
      return { derivation: null };
    if (
      !input.sessionPayloadHashes ||
      contentHash(input.sessionPayloadHashes) !==
        contentHash(report.sessionPayloadHashes)
    )
      return { derivation: null };
    return { binding, derivation: null };
  }

  /**
   * Manifest-defined derivation facts captured when the dataset is frozen.
   * `complete` requires a verified coverage report for the exact scope, a
   * stable runtime identity, exact row membership and matching session payload
   * coverage. Anything less keeps the record and the missing reasons visible
   * instead of asserting verified lineage.
   */
  private datasetDerivation(
    input: ArtifactCoverageScope,
    runtime:
      | Awaited<ReturnType<ResearchRuntimeIdentityProvider["current"]>>
      | undefined,
    binding: ResearchEvidenceBinding | null | undefined,
    report:
      | Awaited<ReturnType<PostgresResearchEvidenceStore["getReport"]>>
      | undefined,
  ): DatasetResearchDerivation {
    const scope = (input.scope ?? {}) as {
      rows?: unknown;
      sourceDigest?: unknown;
    };
    const rows = Array.isArray(scope.rows) ? scope.rows : [];
    const reasons: string[] = [];
    if (!runtime?.featureVersion)
      reasons.push("RESEARCH_RUNTIME_IDENTITY_UNAVAILABLE");
    if (!binding || !report || report.status !== "VERIFIED")
      reasons.push("COVERAGE_REPORT_UNVERIFIED");
    if (binding && runtime) {
      if (binding.engineRevision !== runtime.engineRevision)
        reasons.push("ENGINE_REVISION_MISMATCH");
      if (binding.runtimeFingerprint !== runtime.runtimeFingerprint)
        reasons.push("RUNTIME_FINGERPRINT_MISMATCH");
    }
    const sourceDigest =
      typeof scope.sourceDigest === "string" && scope.sourceDigest.length > 0
        ? scope.sourceDigest
        : null;
    if (!sourceDigest) reasons.push("SOURCE_DIGEST_UNAVAILABLE");
    const rowKeys = rows.map(rowIdentity);
    if (rowKeys.some((key) => key === null))
      reasons.push("ROW_IDENTITY_UNAVAILABLE");
    const rowsDigest =
      rowKeys.length > 0 && rowKeys.every((key) => key !== null)
        ? contentHash(rowKeys)
        : null;
    const sessionPayloadHashes = report?.sessionPayloadHashes ?? null;
    const rowSessions = researchSessionDates(
      rows
        .map((row) =>
          typeof row === "object" &&
          row !== null &&
          "signalTimestamp" in row &&
          typeof (row as { signalTimestamp?: unknown }).signalTimestamp ===
            "string"
            ? (row as { signalTimestamp: string }).signalTimestamp
            : "",
        )
        .filter((value) => value.length > 0),
      input.marketId,
    );
    if (
      !sessionPayloadHashes ||
      contentHash(rowSessions) !==
        contentHash(Object.keys(sessionPayloadHashes).sort())
    )
      reasons.push("SESSION_PAYLOAD_COVERAGE_MISMATCH");
    return {
      version: "dataset-derivation-v1",
      complete: reasons.length === 0,
      featureVersion: runtime?.featureVersion ?? null,
      engineRevision: runtime?.engineRevision ?? null,
      runtimeFingerprint: runtime?.runtimeFingerprint ?? null,
      sourceDigest,
      rowsDigest,
      rowCount: rows.length,
      sessionPayloadHashes,
      coverageManifestHash: binding?.manifestHash ?? null,
      coverageReportHash: binding?.coverageReportHash ?? null,
      reasons,
      capturedAt: new Date().toISOString(),
    };
  }
}

function rowIdentity(row: unknown): string | null {
  if (typeof row !== "object" || row === null) return null;
  const sourceKey = (row as { sourceKey?: unknown }).sourceKey;
  if (typeof sourceKey === "string" && sourceKey.length > 0) return sourceKey;
  const observationId = (row as { observationId?: unknown }).observationId;
  const executionId = (row as { executionId?: unknown }).executionId;
  return typeof observationId === "string" && typeof executionId === "string"
    ? `${observationId}:${executionId}`
    : null;
}

export function researchSessionDates(
  timestamps: readonly string[],
  marketId: MarketId,
): string[] {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: marketId === "CA_TSX" ? "America/Toronto" : "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return [
    ...new Set(
      timestamps.map((value) => {
        const parts = Object.fromEntries(
          formatter
            .formatToParts(new Date(value))
            .map((part) => [part.type, part.value]),
        );
        return `${parts.year}-${parts.month}-${parts.day}`;
      }),
    ),
  ].sort();
}

/** Replay resolution time is audit metadata, never part of retained input identity. */
export function stableArtifactScope(
  input: ArtifactCoverageScope,
): ArtifactCoverageScope {
  if (
    input.kind === "DATASET" ||
    !input.scope ||
    typeof input.scope !== "object"
  )
    return input;
  const scope = input.scope as Record<string, unknown>;
  if (!scope.replayInput || typeof scope.replayInput !== "object") return input;
  const {
    resolvedAt: _resolvedAt,
    inputHash: _auditHash,
    ...replayInput
  } = scope.replayInput as Record<string, unknown>;
  // Legacy descriptor inputHash includes observedAt. Retain its full source
  // descriptor and payload hashes, but exclude the derived audit-clock hash.
  if (
    replayInput.capturedHistoryAvailability &&
    typeof replayInput.capturedHistoryAvailability === "object"
  ) {
    const { observedAt: _observedAt, ...availability } =
      replayInput.capturedHistoryAvailability as Record<string, unknown>;
    replayInput.capturedHistoryAvailability = availability;
  }
  return { ...input, scope: { ...scope, replayInput } };
}
