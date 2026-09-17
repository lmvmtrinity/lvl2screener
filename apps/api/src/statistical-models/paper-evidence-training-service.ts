import { createHash } from "node:crypto";
import type {
  PaperEvidenceCohort,
  PaperEvidenceTrainingRow,
  StatisticalTrainingDataset,
  ResearchEvidenceBinding,
} from "@tsx-scanner/contracts";
import type { PaperEvidenceTrainingStore } from "./paper-evidence-training-repository.js";
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
  ) {}

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
