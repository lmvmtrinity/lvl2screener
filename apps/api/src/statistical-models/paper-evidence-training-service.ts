import { createHash } from "node:crypto";
import type {
  PaperEvidenceCohort,
  PaperEvidenceTrainingRow,
  StatisticalTrainingDataset,
  ResearchEvidenceBinding,
} from "@tsx-scanner/contracts";
import type { PaperEvidenceTrainingStore } from "./paper-evidence-training-repository.js";
import type {
  DatasetPreparation,
  DatasetPreparationStore,
} from "./dataset-preparation-repository.js";
import {
  researchSessionDates,
  type ArtifactResearchLineage,
} from "../backtests/research-lineage-service.js";
import {
  qualifyPaperEvidence,
  type PaperEvidenceQualificationResult,
} from "./paper-evidence-qualification.js";

/** Versioned policy identifier, not a user-configurable training input. */
export const PAPER_EVIDENCE_POLICY_VERSION = "paper-evidence-v1";

export class PaperEvidenceTrainingService {
  constructor(
    private readonly store: PaperEvidenceTrainingStore,
    private readonly lineage?: ArtifactResearchLineage,
    private readonly preparations?: DatasetPreparationStore,
  ) {}

  async pendingPreparationFor(cohort: PaperEvidenceCohort): Promise<boolean> {
    return Boolean(await this.preparations?.findPending(cohort));
  }

  async pendingPreparations(): Promise<DatasetPreparation[]> {
    return (await this.preparations?.listPending()) ?? [];
  }

  /** Freeze the exact qualified input before dispatching asynchronous coverage.
   * A later scheduler pass resumes this preparation and never recomputes its
   * cutoff, membership, or source digest. */
  async prepareAndMaterialize(
    cohort: PaperEvidenceCohort,
    requestedCutoff: Date,
    qualified?: PaperEvidenceQualificationResult,
  ): Promise<{
    dataset: StatisticalTrainingDataset | undefined;
    pending: boolean;
  }> {
    if (!this.preparations)
      return {
        dataset: await this.materialize(cohort, requestedCutoff),
        pending: false,
      };
    let preparation = await this.preparations.findPending(cohort);
    if (!preparation) {
      const result = qualified ?? (await this.qualify(cohort, requestedCutoff));
      if (!result.qualification.qualified)
        return { dataset: undefined, pending: false };
      const effectiveCutoff = result.qualifiedRows.at(-1)
        ? new Date(result.qualifiedRows.at(-1)!.signalTimestamp)
        : requestedCutoff;
      preparation = await this.preparations.create({
        marketId: cohort.marketId,
        cohort,
        requestedCutoff,
        effectiveCutoff,
        sourceDigest: digest({
          policyVersion: PAPER_EVIDENCE_POLICY_VERSION,
          cohort,
          requestedCutoff: requestedCutoff.toISOString(),
          qualification: result.qualification,
          rows: result.qualifiedRows,
        }),
        excludedCounts: {
          OPEN_OR_UNRESOLVED: 0,
          NO_FILL: 0,
          FEATURE_FAILURE: 0,
          ...result.qualification.excludedCounts,
        },
        researchQualification: result.qualification,
        rows: result.qualifiedRows,
      });
    }
    const resolution = this.lineage?.resolveArtifact
      ? await this.lineage.resolveArtifact({
          kind: "DATASET",
          marketId: preparation.marketId,
          preparationId: preparation.id,
          scope: {
            cohort: preparation.cohort,
            rows: preparation.rows,
            sourceDigest: preparation.sourceDigest,
          },
          sessionDates: researchSessionDates(
            preparation.rows.map((row) => row.signalTimestamp),
            preparation.marketId,
          ),
          inputCutoff: preparation.requestedCutoff,
        })
      : { derivation: null };
    if (!resolution.derivation?.complete && !resolution.coverageStatus)
      return { dataset: undefined, pending: true };
    const dataset = await this.store.createDataset({
      policyVersion: PAPER_EVIDENCE_POLICY_VERSION,
      cohort: preparation.cohort,
      requestedCutoff: new Date(preparation.requestedCutoff),
      effectiveCutoff: new Date(preparation.effectiveCutoff),
      sourceDigest: preparation.sourceDigest,
      excludedCounts: preparation.excludedCounts,
      researchQualification: preparation.researchQualification,
      researchEvidence: resolution.binding,
      researchDerivation: resolution.derivation,
      rows: preparation.rows,
    });
    return { dataset, pending: false };
  }

  countDatasets(): Promise<number> {
    return this.store.countDatasets();
  }

  listCohorts(): Promise<PaperEvidenceCohort[]> {
    return this.store.listCohorts();
  }
  getDataset(id: string): Promise<StatisticalTrainingDataset | undefined> {
    return this.store.getDataset(id);
  }
  latestDatasetFor(cohort: PaperEvidenceCohort) {
    return this.store.latestDatasetFor(cohort);
  }
  prospectiveRows(
    cohort: PaperEvidenceCohort,
    cutoff: Date,
  ): Promise<PaperEvidenceTrainingRow[]> {
    return this.store.rowsFor(cohort, cutoff);
  }
  datasetRows(id: string) {
    return this.store.listDatasetRows(id);
  }

  async qualify(
    cohort: PaperEvidenceCohort,
    requestedCutoff: Date,
  ): Promise<PaperEvidenceQualificationResult> {
    const rows = await this.store.rowsFor(cohort, requestedCutoff);
    return qualifyPaperEvidence({ cohort, rows, requestedCutoff });
  }

  /**
   * Used by future policy-driven jobs. It has no route and cannot activate or
   * train a model; it just freezes an ordered evidence membership list.
   */
  async materialize(
    cohort: PaperEvidenceCohort,
    requestedCutoff: Date,
    researchEvidence?: ResearchEvidenceBinding,
  ): Promise<StatisticalTrainingDataset> {
    const rows = await this.store.rowsFor(cohort, requestedCutoff);
    if (rows.some((row) => row.marketId !== cohort.marketId)) {
      throw new Error("Paper evidence rows must match the cohort market");
    }
    const result = qualifyPaperEvidence({
      cohort,
      rows,
      requestedCutoff,
    });
    const effectiveCutoff = result.qualifiedRows.at(-1)
      ? new Date(result.qualifiedRows.at(-1)!.signalTimestamp)
      : requestedCutoff;
    const sourceDigest = digest({
      policyVersion: PAPER_EVIDENCE_POLICY_VERSION,
      cohort,
      requestedCutoff: requestedCutoff.toISOString(),
      qualification: result.qualification,
      rows: result.qualifiedRows,
    });
    const lineageInput = {
      kind: "DATASET" as const,
      marketId: cohort.marketId,
      scope: { cohort, rows: result.qualifiedRows, sourceDigest },
      sessionDates: researchSessionDates(
        result.qualifiedRows.map((row) => row.signalTimestamp),
        cohort.marketId,
      ),
      inputCutoff: requestedCutoff.toISOString(),
    };
    const resolution = this.lineage?.resolveArtifact
      ? await this.lineage.resolveArtifact(lineageInput)
      : {
          binding: await this.lineage?.resolve(lineageInput),
          derivation: null,
        };
    return this.store.createDataset({
      policyVersion: PAPER_EVIDENCE_POLICY_VERSION,
      cohort,
      requestedCutoff,
      effectiveCutoff,
      sourceDigest,
      excludedCounts: {
        OPEN_OR_UNRESOLVED: 0,
        NO_FILL: 0,
        FEATURE_FAILURE: 0,
        ...result.qualification.excludedCounts,
      },
      researchQualification: result.qualification,
      researchEvidence: resolution.binding ?? researchEvidence,
      researchDerivation: resolution.derivation ?? null,
      rows: result.qualifiedRows,
    });
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
