import {
  coverageVerificationJobPayloadSchema,
  coverageVerificationJobPayloadV2Schema,
  researchEvidenceBindingSchema,
  researchOwnerSchema,
  type ResearchEvidenceBinding,
} from "@tsx-scanner/contracts";
import { ResearchCoverageService } from "../../backtests/research-coverage-service.js";
import type { ResearchEvidenceStore } from "../../backtests/research-evidence-repository.js";
import {
  contentHash,
  coverageReportHash,
  CoverageInputLimitError,
  type ResearchCoverageReport,
} from "../../backtests/research-coverage.js";
import {
  CategorizedError,
  type ClaimedResearchJob,
  type JobContext,
  type ResearchJobHandler,
} from "../research-worker.js";
import type { ResearchJobRepository } from "../../research-jobs/research-job-repository.js";
import type { PostgresCoverageRequestRepository } from "../../backtests/coverage-request-repository.js";
import type { ResearchRuntimeIdentityProvider } from "../../backtests/research-runtime-identity.js";

export class CoverageVerificationJobHandler implements ResearchJobHandler {
  constructor(
    private readonly coverage: ResearchCoverageService,
    private readonly evidence: ResearchEvidenceStore,
    private readonly jobs: ResearchJobRepository,
    private readonly coverageRequests?: PostgresCoverageRequestRepository,
    private readonly identityProvider?: ResearchRuntimeIdentityProvider,
  ) {}

  async execute(
    job: ClaimedResearchJob,
    context: JobContext,
  ): Promise<{ resultRefId: string }> {
    const legacy = coverageVerificationJobPayloadSchema.safeParse(
      job.requestPayload,
    );
    const v2 = coverageVerificationJobPayloadV2Schema.safeParse(
      job.requestPayload,
    );
    if (!legacy.success && !v2.success)
      throw new CategorizedError("VALIDATION", legacy.error.message);
    const normalized = legacy.success
      ? {
          request: legacy.data.request,
          manifest: legacy.data.manifest,
          engineRevision: legacy.data.engineRevision,
          runtimeFingerprint: legacy.data.runtimeFingerprint,
          recipe: undefined,
        }
      : (() => {
          if (!v2.success)
            throw new CategorizedError("VALIDATION", legacy.error.message);
          return {
            request: {
              marketId: v2.data.request.recipe.marketId,
              manifestHash: v2.data.request.manifest.hash,
              inputCutoff: v2.data.request.recipe.inputCutoff,
              sessionDates: v2.data.request.recipe.sessionDates,
            },
            manifest: v2.data.request.manifest,
            engineRevision: v2.data.request.recipe.engineRevision,
            runtimeFingerprint: v2.data.request.recipe.runtimeFingerprint,
            recipe: v2.data.request.recipe,
          };
        })();
    const { cancellationRequested } = await context.heartbeat({
      message: "Verifying retained research inputs",
    });
    if (cancellationRequested)
      throw new CategorizedError("CANCELLED", "Cancelled by request");
    if (normalized.request.manifestHash !== normalized.manifest.hash)
      throw new CategorizedError(
        "VALIDATION",
        "EVIDENCE_MANIFEST_HASH_MISMATCH",
      );
    if (normalized.request.marketId !== normalized.manifest.marketId)
      throw new CategorizedError(
        "VALIDATION",
        "EVIDENCE_MANIFEST_MARKET_MISMATCH",
      );
    const expectedIdentity = await this.identityProvider?.current();
    if (
      this.identityProvider &&
      (!expectedIdentity ||
        normalized.engineRevision !== expectedIdentity.engineRevision ||
        normalized.runtimeFingerprint !== expectedIdentity.runtimeFingerprint)
    )
      throw new CategorizedError("VALIDATION", "EVIDENCE_RUNTIME_MISMATCH");

    await this.evidence.saveManifest(normalized.manifest);
    let verified: Awaited<ReturnType<ResearchCoverageService["verifyInputs"]>>;
    try {
      verified = await this.coverage.verifyInputs(
        {
          ...normalized.request,
          ...(normalized.recipe ? { recipe: normalized.recipe } : {}),
        },
        {
          onSessionVerified: async (completedSessions, totalSessions) => {
            const progress = await context.heartbeat({
              completedSessions,
              totalSessions,
              message: `Verified ${completedSessions}/${totalSessions} retained sessions`,
            });
            if (progress.cancellationRequested)
              throw new CategorizedError("CANCELLED", "Cancelled by request");
          },
        },
      );
    } catch (error) {
      // An over-scoped coverage request is deterministic; VALIDATION fails it
      // immediately instead of letting the worker retry a multi-minute job.
      if (error instanceof CoverageInputLimitError)
        throw new CategorizedError("VALIDATION", error.message);
      throw error;
    }
    const { report: computed, sessions } = verified;
    const reportHash = await this.evidence.saveReport(computed);
    await this.evidence.saveSessions?.(reportHash, sessions);
    const report = await this.evidence.getReport(reportHash);
    if (!report) throw new Error("COVERAGE_REPORT_MISSING_AFTER_SAVE");
    const requestId = v2.success ? v2.data.requestId : null;
    // UNKNOWN/INCOMPLETE is a completed verification with a truthful report,
    // not a worker failure. Only VERIFIED reports can become evidence
    // bindings, but every result remains inspectable through the request link.
    if (report.status !== "VERIFIED") {
      if (requestId && this.coverageRequests) {
        if (!this.evidence.withTransaction)
          throw new Error("EVIDENCE_TRANSACTION_REQUIRED");
        await this.evidence.withTransaction(async (client) => {
          await this.jobs
            .withClient(client)
            .lockEvidenceLease(job.id, job.leaseOwner, job.attemptCount);
          await this.coverageRequests!.recordResultWithClient(
            client,
            requestId,
            job.id,
            reportHash,
            report.status,
          );
        });
      }
      await context.heartbeat({
        message: `Coverage retained as ${report.status}`,
      });
      return { resultRefId: requestId ?? job.id };
    }
    const binding: ResearchEvidenceBinding =
      researchEvidenceBindingSchema.parse({
        manifestHash: report.manifestHash,
        coverageReportHash: coverageReportHash(report),
        inputHash: report.inputHash,
        engineRevision: normalized.engineRevision,
        runtimeFingerprint: normalized.runtimeFingerprint,
        verifiedAt: report.verifiedAt,
      });
    const owner = researchOwnerSchema.parse({
      kind: "JOB",
      id: job.id,
      marketId: report.marketId,
    });
    if (this.evidence.withTransaction && this.evidence.bindWithClient) {
      await this.evidence.withTransaction(async (client) => {
        await this.jobs
          .withClient(client)
          .lockEvidenceLease(job.id, job.leaseOwner, job.attemptCount);
        await this.evidence.bindWithClient!(client, owner, binding);
        await this.jobs
          .withClient(client)
          .attachResearchEvidence(job.id, job.leaseOwner, binding);
        if (requestId && this.coverageRequests)
          await this.coverageRequests.recordResultWithClient(
            client,
            requestId,
            job.id,
            reportHash,
            report.status,
          );
      });
    } else {
      await this.evidence.bind(owner, binding);
      await this.jobs.attachResearchEvidence(job.id, job.leaseOwner, binding);
      if (requestId && this.coverageRequests)
        await this.coverageRequests.recordResult(
          requestId,
          job.id,
          reportHash,
          report.status,
        );
    }
    await context.heartbeat({ message: "Retained research inputs verified" });
    return { resultRefId: requestId ?? job.id };
  }
}

export function coverageJobInputHash(payload: unknown): string {
  return contentHash(coverageVerificationJobPayloadSchema.parse(payload));
}

export type CoverageJobReport = ResearchCoverageReport;
