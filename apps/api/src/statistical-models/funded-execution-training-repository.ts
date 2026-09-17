import type { Pool } from "pg";
import {
  FUNDED_EXECUTION_FEATURE_VERSION,
  FUNDED_EXECUTION_LABEL_MAPPING_VERSION,
  FUNDED_EXECUTION_QUALIFICATION_POLICY_VERSION,
  fundedCohortComponentsSchema,
  fundedCohortIdentitySchema,
  fundedDecisionTimeInputSchema,
  fundedExecutionChallengerSchema,
  fundedExecutionDatasetManifestSchema,
  fundedExecutionDatasetMemberSchema,
  fundedExecutionFeatureVectorSchema,
  fundedExecutionLabelsSchema,
  fundedExecutionQualificationReceiptSchema,
  fundedExecutionSourceWatermarkSchema,
  fundedOutcomeStatusSchema,
  type FundedCohortIdentity,
  type FundedExecutionChallenger,
  type FundedExecutionDatasetCounts,
  type FundedExecutionDatasetManifest,
  type FundedExecutionDatasetMember,
  type FundedExecutionExclusionReason,
  type FundedExecutionPartition,
  type FundedExecutionQualificationReceipt,
  type FundedExecutionSourceWatermark,
  type FundedExecutionTerminalityProof,
  type FundedSourceKind,
} from "@tsx-scanner/contracts";
import {
  assembleFundedExecutionLabel,
  type FundedExecutionEntryTerminality,
  type FundedExecutionOutcomeEvidence,
  type FundedExecutionReplayChronology,
  type FundedExecutionTerminalityProvenance,
} from "./funded-execution-label-assembler.js";
import { contentHash } from "./funded-execution-digest.js";
import {
  extractFundedExecutionFeatures,
  fundedExecutionSessionDate,
} from "./funded-execution-features.js";
import type { FundedExecutionAssembledRow } from "./funded-execution-qualification.js";

/**
 * Read-only funded-execution evidence source and immutable dataset/challenger
 * store (FP02). Reads consume only validated version-2 decisions, their
 * append-only outcomes and immutable entry-order history revisions recorded at
 * or before the requested cutoff. Writes are limited to funded-execution
 * learning rows; this module never touches an order, ledger, reservation,
 * profile, policy or activation table.
 */

export interface FundedExecutionCohortSummary {
  readonly cohort: FundedCohortIdentity;
  readonly sourceKind: FundedSourceKind;
  readonly decisionCount: number;
  readonly completedLiveCount: number;
  readonly firstDecisionAt: string | null;
  readonly lastDecisionAt: string | null;
}

export interface FundedExecutionMemberDraft {
  readonly ordinal: number;
  readonly marketId: "CA_TSX" | "US_EQUITIES";
  readonly currency: "CAD" | "USD";
  readonly runId: string;
  readonly observationId: string;
  readonly accountId: string;
  readonly decisionSequence: number;
  readonly decisionContentDigest: string;
  readonly cohortDigest: string;
  readonly instrumentId: string | null;
  readonly decisionAt: string;
  readonly sessionDate: string;
  readonly partition: FundedExecutionPartition;
  readonly labelAvailableAt: string;
  /** Economic time of the terminal outcome that produced the label. */
  readonly labelEconomicAt: string;
  readonly sourceKind: FundedSourceKind;
  readonly features: unknown;
  readonly labels: unknown;
  readonly outcomeSequences: readonly number[];
  readonly outcomeSourceDigests: readonly string[];
  readonly rowDigest: string;
}

export interface FundedExecutionDatasetDraft {
  readonly requestedCutoff: Date;
  readonly effectiveCutoff: Date;
  readonly cohort: FundedCohortIdentity;
  readonly sourceKind: FundedSourceKind;
  readonly datasetDigest: string;
  readonly membershipDigest: string;
  readonly datasetPolicyVersion: string;
  readonly labelMappingVersion: string;
  readonly featureVersion: string;
  readonly qualificationPolicyVersion: string;
  readonly counts: FundedExecutionDatasetCounts;
  readonly receipt: FundedExecutionQualificationReceipt;
  readonly sourceWatermark: FundedExecutionSourceWatermark;
  readonly activationEligible: boolean;
  readonly members: readonly FundedExecutionMemberDraft[];
}

export interface FundedExecutionChallengerDraft {
  readonly marketId: "CA_TSX" | "US_EQUITIES";
  readonly currency: "CAD" | "USD";
  readonly cohort: FundedCohortIdentity;
  readonly datasetId: string;
  readonly datasetDigest: string;
  readonly modelVersion: string;
  readonly artifactDigest: string;
  readonly trainingCodeVersion: string;
  readonly runtimeFingerprint: string | null;
  readonly status: "INACTIVE" | "FAILED";
  readonly artifact: unknown | null;
  readonly metrics: Record<string, unknown> | null;
  readonly sampleCounts: Record<string, number>;
  readonly failureReceipt: string | null;
}

export interface FundedExecutionTrainingStore {
  listCohorts(): Promise<FundedExecutionCohortSummary[]>;
  assembledRowsFor(
    cohortDigest: string,
    cutoff: Date,
  ): Promise<FundedExecutionAssembledRow[]>;
  countDatasets(): Promise<number>;
  createDataset(
    draft: FundedExecutionDatasetDraft,
  ): Promise<FundedExecutionDatasetManifest>;
  getDataset(id: string): Promise<FundedExecutionDatasetManifest | undefined>;
  latestDatasetFor(
    cohortDigest: string,
  ): Promise<FundedExecutionDatasetManifest | undefined>;
  listDatasetMembers(id: string): Promise<FundedExecutionDatasetMember[]>;
  findChallengerByDatasetDigest(
    datasetDigest: string,
  ): Promise<FundedExecutionChallenger | undefined>;
  listChallengers(marketId?: string): Promise<FundedExecutionChallenger[]>;
  persistChallenger(
    draft: FundedExecutionChallengerDraft,
  ): Promise<FundedExecutionChallenger>;
}

interface CohortRow {
  cohort_digest: string;
  market_id: "CA_TSX" | "US_EQUITIES";
  currency: "CAD" | "USD";
  source_kind: FundedSourceKind;
  cohort_components: unknown;
  decision_count: number;
  completed_live_count: number;
  first_decision_at: Date | null;
  last_decision_at: Date | null;
}

interface DecisionRow {
  run_id: string;
  observation_id: string;
  sequence: number;
  market_id: "CA_TSX" | "US_EQUITIES";
  currency: "CAD" | "USD";
  account_id: string;
  evidence_schema_version: number;
  action: "SUBMIT" | "DECLINE" | "DEFER";
  source_kind: FundedSourceKind;
  content_digest: string;
  cohort_digest: string;
  decision_content: unknown;
  decision_at: Date | string;
  instrument_id: string | null;
  run_source: string;
  run_status: string;
}

interface OutcomeRow {
  run_id: string;
  observation_id: string;
  sequence: number;
  status: string;
  available_at: Date | string;
  recorded_at: Date | string;
  source_id: string;
  source_digest: string;
  reason: string | null;
  detail: unknown;
  supersedes_sequence: number | null;
  source_fact_id: string | null;
  knowledge_applied_sequence: string | number | null;
  knowledge_at: Date | string | null;
}

interface OrderHistoryRow {
  order_id: string;
  revision: string | number;
  fact_at: Date | string;
  recorded_at: Date | string;
  state: unknown;
  fact_id: string | null;
}

interface AppliedFactRow {
  run_id: string;
  fact_id: string;
  fact_at: Date | string;
  applied_sequence: string | number | null;
  outcome: unknown;
  frontier_at: Date | string | null;
  stored_frontier_at: Date | string | null;
}

interface RunSequenceRow {
  run_id: string;
  applied_sequence_counter: string | number;
  applied_frontier_at: Date | string | null;
}

interface CausalFactRow {
  run_id: string;
  fact_id: string;
  outcome: unknown;
  applied_sequence: string | number | null;
  applied_frontier_at: Date | string | null;
}

interface DatasetRow {
  id: string;
  market_id: "CA_TSX" | "US_EQUITIES";
  currency: "CAD" | "USD";
  source_kind: FundedSourceKind;
  evidence_schema_version: number;
  cohort_digest: string;
  cohort_components: unknown;
  dataset_policy_version: string;
  label_mapping_version: string;
  feature_version: string;
  qualification_policy_version: string;
  requested_cutoff: Date | string;
  effective_cutoff: Date | string;
  membership_digest: string;
  dataset_digest: string;
  row_count: number;
  counts: unknown;
  qualification_receipt: unknown;
  source_watermark: unknown;
  activation_eligible: boolean;
  created_at: Date | string;
}

interface MemberRow {
  ordinal: number;
  market_id: "CA_TSX" | "US_EQUITIES";
  currency: "CAD" | "USD";
  run_id: string;
  observation_id: string;
  account_id: string;
  decision_sequence: number;
  decision_content_digest: string;
  cohort_digest: string;
  instrument_id: string | null;
  decision_at: Date | string;
  session_date: Date | string;
  partition: FundedExecutionPartition;
  label_available_at: Date | string;
  label_economic_at: Date | string;
  source_kind: FundedSourceKind;
  features: unknown;
  labels: unknown;
  outcome_sequences: number[];
  outcome_source_digests: string[];
  row_digest: string;
}

interface ChallengerRow {
  id: string;
  market_id: "CA_TSX" | "US_EQUITIES";
  currency: "CAD" | "USD";
  cohort_digest: string;
  cohort_components: unknown;
  dataset_id: string;
  dataset_digest: string;
  model_version: string;
  artifact_digest: string;
  feature_version: string;
  label_mapping_version: string;
  qualification_policy_version: string;
  training_policy_version: string;
  training_code_version: string;
  runtime_fingerprint: string | null;
  status: "INACTIVE" | "FAILED";
  artifact: unknown;
  metrics: unknown;
  sample_counts: unknown;
  failure_receipt: string | null;
  created_at: Date | string;
}

export class PostgresFundedExecutionTrainingStore implements FundedExecutionTrainingStore {
  constructor(
    private readonly pool: Pool,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async listCohorts(): Promise<FundedExecutionCohortSummary[]> {
    const result = await this.pool.query<CohortRow>(COHORT_SQL);
    return result.rows.map((row) => ({
      cohort: fundedCohortIdentitySchema.parse({
        ...fundedCohortComponentsSchema.parse(row.cohort_components),
        cohortDigest: row.cohort_digest,
      }),
      sourceKind: row.source_kind,
      decisionCount: Number(row.decision_count),
      completedLiveCount: Number(row.completed_live_count),
      firstDecisionAt: iso(row.first_decision_at),
      lastDecisionAt: iso(row.last_decision_at),
    }));
  }

  async assembledRowsFor(
    cohortDigest: string,
    cutoff: Date,
  ): Promise<FundedExecutionAssembledRow[]> {
    const decisions = await this.pool.query<DecisionRow>(DECISION_SQL, [
      cohortDigest,
      cutoff,
    ]);
    const outcomes = await this.pool.query<OutcomeRow>(OUTCOME_SQL, [
      cohortDigest,
      cutoff,
    ]);
    const outcomesByDecision = new Map<string, OutcomeRow[]>();
    for (const row of outcomes.rows) {
      const key = `${row.run_id}:${row.observation_id}`;
      const list = outcomesByDecision.get(key);
      if (list) list.push(row);
      else outcomesByDecision.set(key, [row]);
    }
    const orderTerminality = await this.orderTerminality(
      decisions.rows,
      cutoff,
    );
    const replayChronologies = await this.replayChronologies(decisions.rows);
    return decisions.rows.map((row) => {
      const key = `${row.run_id}:${row.observation_id}`;
      const decisionOutcomes = outcomesByDecision.get(key) ?? [];
      const decisionContent = (() => {
        const parsed = fundedDecisionTimeInputSchema.safeParse(
          row.decision_content,
        );
        return parsed.success ? parsed.data : null;
      })();
      const outcomeEvidence: FundedExecutionOutcomeEvidence[] =
        decisionOutcomes.map((outcome) => ({
          sequence: Number(outcome.sequence),
          status: fundedOutcomeStatusSchema.parse(outcome.status),
          availableAt: iso(outcome.available_at)!,
          recordedAt: iso(outcome.recorded_at)!,
          sourceId: outcome.source_id,
          sourceDigest: outcome.source_digest,
          reason: outcome.reason,
          detail: outcome.detail,
          supersedesSequence:
            outcome.supersedes_sequence === null
              ? null
              : Number(outcome.supersedes_sequence),
          knowledge:
            (row.source_kind === "HISTORICAL_REPLAY" &&
              outcome.source_fact_id === null) ||
            outcome.knowledge_applied_sequence === null ||
            outcome.knowledge_at === null
              ? null
              : {
                  runId: outcome.run_id,
                  sequence: Number(outcome.knowledge_applied_sequence),
                  at: iso(outcome.knowledge_at)!,
                },
        }));
      const decisionAt = iso(row.decision_at)!;
      const marketId = row.market_id;
      const terminality = orderTerminality.get(key) ?? {
        state: "UNKNOWN" as const,
        knownAt: null,
        proof: null,
        replayProvenance: null,
      };
      const assembly = assembleFundedExecutionLabel({
        decision: {
          runId: row.run_id,
          observationId: row.observation_id,
          accountId: row.account_id,
          marketId,
          currency: row.currency,
          decisionSequence: Number(row.sequence),
          decisionContentDigest: row.content_digest,
          cohortDigest: row.cohort_digest,
          evidenceSchemaVersion: Number(row.evidence_schema_version),
          sourceKind: row.source_kind,
          action: row.action,
          decisionAt,
          runSource: row.run_source,
          runStatus: row.run_status,
          instrumentId: row.instrument_id,
          decisionContent,
          outcomes: outcomeEvidence,
          entryTerminality: terminality,
          replayChronology:
            row.source_kind === "HISTORICAL_REPLAY"
              ? (replayChronologies.get(row.run_id) ?? null)
              : null,
        },
        cutoff,
      });
      const sessionDate = fundedExecutionSessionDate(decisionAt, marketId);
      const availableOutcomes = outcomeEvidence.filter(
        (outcome) =>
          Date.parse(outcome.availableAt) <= cutoff.getTime() &&
          Date.parse(outcome.recordedAt) <= cutoff.getTime(),
      );
      return {
        marketId,
        currency: row.currency,
        accountId: row.account_id,
        runId: row.run_id,
        observationId: row.observation_id,
        decisionSequence: Number(row.sequence),
        decisionContentDigest: row.content_digest,
        cohortDigest: row.cohort_digest,
        sourceKind: row.source_kind,
        action: row.action,
        decisionAt,
        runSource: row.run_source,
        runStatus: row.run_status,
        instrumentId: row.instrument_id,
        sessionDate,
        verdict: assembly.verdict,
        exclusionReason:
          assembly.verdict === "EXCLUDED"
            ? (assembly.reason as FundedExecutionExclusionReason)
            : null,
        unknown: assembly.verdict === "EXCLUDED" ? assembly.unknown : false,
        features: decisionContent
          ? extractFundedExecutionFeatures({
              decision: decisionContent,
              marketId,
            })
          : null,
        labels: assembly.verdict === "INCLUDED" ? assembly.labels : null,
        outcomeSequences:
          assembly.verdict === "INCLUDED"
            ? assembly.selectedOutcomeSequences
            : [],
        outcomeSourceDigests:
          assembly.verdict === "INCLUDED"
            ? assembly.selectedOutcomeSourceDigests
            : [],
        exposureEndAt: exposureEnd({
          assembly,
          availableOutcomes,
          decisionAt,
          cutoff,
        }),
      } satisfies FundedExecutionAssembledRow;
    });
  }

  async countDatasets(): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      "SELECT count(*) AS count FROM funded_execution_dataset",
    );
    return Number(result.rows[0]!.count);
  }

  async createDataset(
    draft: FundedExecutionDatasetDraft,
  ): Promise<FundedExecutionDatasetManifest> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query<DatasetRow>(
        `INSERT INTO funded_execution_dataset(
           market_id,currency,source_kind,evidence_schema_version,cohort_digest,cohort_components,
           dataset_policy_version,label_mapping_version,feature_version,qualification_policy_version,
           requested_cutoff,effective_cutoff,membership_digest,dataset_digest,row_count,counts,
           qualification_receipt,source_watermark,activation_eligible)
         VALUES($1,$2,$3,2,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb,$17::jsonb,$18)
         ON CONFLICT DO NOTHING
         RETURNING ${DATASET_COLUMNS}`,
        [
          draft.cohort.marketId,
          draft.cohort.currency,
          draft.sourceKind,
          draft.cohort.cohortDigest,
          JSON.stringify(withoutDigest(draft.cohort)),
          draft.datasetPolicyVersion,
          draft.labelMappingVersion,
          draft.featureVersion,
          draft.qualificationPolicyVersion,
          draft.requestedCutoff,
          draft.effectiveCutoff,
          draft.membershipDigest,
          draft.datasetDigest,
          draft.members.length,
          JSON.stringify(draft.counts),
          JSON.stringify(draft.receipt),
          JSON.stringify(draft.sourceWatermark),
          draft.activationEligible,
        ],
      );
      if (!inserted.rows[0]) {
        const existing = await client.query<DatasetRow>(
          `SELECT ${DATASET_COLUMNS} FROM funded_execution_dataset WHERE dataset_digest=$1`,
          [draft.datasetDigest],
        );
        if (!existing.rows[0]) {
          const conflicting = await client.query<{ dataset_digest: string }>(
            `SELECT dataset_digest FROM funded_execution_dataset
              WHERE market_id=$1 AND cohort_digest=$2 AND effective_cutoff=$3`,
            [
              draft.cohort.marketId,
              draft.cohort.cohortDigest,
              draft.effectiveCutoff,
            ],
          );
          throw new Error(
            conflicting.rows[0]
              ? `CONFLICTING_FUNDED_EXECUTION_DATASET: ${conflicting.rows[0].dataset_digest}`
              : "FUNDED_EXECUTION_DATASET_WRITE_CONFLICT",
          );
        }
        await client.query("COMMIT");
        return mapDataset(existing.rows[0]);
      }
      for (const member of draft.members)
        await client.query(
          `INSERT INTO funded_execution_dataset_member(
             dataset_id,ordinal,market_id,currency,run_id,observation_id,account_id,decision_sequence,
             decision_content_digest,cohort_digest,evidence_schema_version,instrument_id,decision_at,
             session_date,partition,label_available_at,label_economic_at,source_kind,label_mapping_version,
             feature_version,features,labels,outcome_sequences,outcome_source_digests,row_digest)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,2,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,$21::jsonb,$22,$23,$24)`,
          [
            inserted.rows[0].id,
            member.ordinal,
            member.marketId,
            member.currency,
            member.runId,
            member.observationId,
            member.accountId,
            member.decisionSequence,
            member.decisionContentDigest,
            member.cohortDigest,
            member.instrumentId,
            member.decisionAt,
            member.sessionDate,
            member.partition,
            member.labelAvailableAt,
            member.labelEconomicAt,
            member.sourceKind,
            FUNDED_EXECUTION_LABEL_MAPPING_VERSION,
            FUNDED_EXECUTION_FEATURE_VERSION,
            JSON.stringify(member.features),
            JSON.stringify(member.labels),
            [...member.outcomeSequences],
            [...member.outcomeSourceDigests],
            member.rowDigest,
          ],
        );
      await client.query("COMMIT");
      return mapDataset(inserted.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async getDataset(
    id: string,
  ): Promise<FundedExecutionDatasetManifest | undefined> {
    const result = await this.pool.query<DatasetRow>(
      `SELECT ${DATASET_COLUMNS} FROM funded_execution_dataset WHERE id=$1`,
      [id],
    );
    return result.rows[0] ? mapDataset(result.rows[0]) : undefined;
  }

  async latestDatasetFor(
    cohortDigest: string,
  ): Promise<FundedExecutionDatasetManifest | undefined> {
    const result = await this.pool.query<DatasetRow>(
      `SELECT ${DATASET_COLUMNS} FROM funded_execution_dataset
        WHERE cohort_digest=$1 ORDER BY effective_cutoff DESC, created_at DESC LIMIT 1`,
      [cohortDigest],
    );
    return result.rows[0] ? mapDataset(result.rows[0]) : undefined;
  }

  async listDatasetMembers(
    id: string,
  ): Promise<FundedExecutionDatasetMember[]> {
    const result = await this.pool.query<MemberRow>(
      `SELECT ordinal,market_id,currency,run_id,observation_id,account_id,decision_sequence,
              decision_content_digest,cohort_digest,instrument_id,decision_at,session_date,
              partition,label_available_at,label_economic_at,source_kind,features,labels,outcome_sequences,
              outcome_source_digests,row_digest
         FROM funded_execution_dataset_member WHERE dataset_id=$1 ORDER BY ordinal`,
      [id],
    );
    return result.rows.map((row) =>
      fundedExecutionDatasetMemberSchema.parse({
        ordinal: Number(row.ordinal),
        marketId: row.market_id,
        currency: row.currency,
        identity: {
          marketId: row.market_id,
          currency: row.currency,
          accountId: row.account_id,
          runId: row.run_id,
          observationId: row.observation_id,
          decisionSequence: Number(row.decision_sequence),
          decisionContentDigest: row.decision_content_digest,
          cohortDigest: row.cohort_digest,
          evidenceSchemaVersion: 2,
          outcomeSequences: row.outcome_sequences.map(Number),
          outcomeSourceDigests: row.outcome_source_digests,
        },
        instrumentId: row.instrument_id,
        decisionAt: iso(row.decision_at)!,
        sessionDate: dateOnly(row.session_date),
        partition: row.partition,
        features: fundedExecutionFeatureVectorSchema.parse(row.features),
        labels: fundedExecutionLabelsSchema.parse(row.labels),
        sourceKind: row.source_kind,
        labelMappingVersion: FUNDED_EXECUTION_LABEL_MAPPING_VERSION,
        featureVersion: FUNDED_EXECUTION_FEATURE_VERSION,
        rowDigest: row.row_digest,
      }),
    );
  }

  async findChallengerByDatasetDigest(
    datasetDigest: string,
  ): Promise<FundedExecutionChallenger | undefined> {
    const result = await this.pool.query<ChallengerRow>(
      `${CHALLENGER_SELECT} WHERE dataset_digest=$1`,
      [datasetDigest],
    );
    return result.rows[0] ? mapChallenger(result.rows[0]) : undefined;
  }

  async listChallengers(
    marketId?: string,
  ): Promise<FundedExecutionChallenger[]> {
    const result = await this.pool.query<ChallengerRow>(
      marketId
        ? `${CHALLENGER_SELECT} WHERE market_id=$1 ORDER BY created_at DESC`
        : `${CHALLENGER_SELECT} ORDER BY created_at DESC`,
      marketId ? [marketId] : [],
    );
    return result.rows.map(mapChallenger);
  }

  async persistChallenger(
    draft: FundedExecutionChallengerDraft,
  ): Promise<FundedExecutionChallenger> {
    const existing = await this.findChallengerByDatasetDigest(
      draft.datasetDigest,
    );
    if (existing) {
      if (existing.artifactDigest !== draft.artifactDigest)
        throw new Error("CONFLICTING_FUNDED_EXECUTION_CHALLENGER");
      return existing;
    }
    const inserted = await this.pool.query<ChallengerRow>(
      `INSERT INTO funded_execution_challenger(
         market_id,currency,cohort_digest,cohort_components,dataset_id,dataset_digest,
         model_version,model_type,artifact_digest,feature_version,label_mapping_version,
         qualification_policy_version,training_policy_version,training_code_version,
         runtime_fingerprint,status,artifact,metrics,sample_counts,failure_receipt)
       VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,'FUNDED_EXECUTION_QUALITY',$8,$9,$10,$11,$12,$13,$14,$15,
              $16::jsonb,$17::jsonb,$18::jsonb,$19)
       ON CONFLICT (dataset_digest) DO NOTHING
       RETURNING ${CHALLENGER_COLUMNS}`,
      [
        draft.marketId,
        draft.currency,
        draft.cohort.cohortDigest,
        JSON.stringify(withoutDigest(draft.cohort)),
        draft.datasetId,
        draft.datasetDigest,
        draft.modelVersion,
        draft.artifactDigest,
        FUNDED_EXECUTION_FEATURE_VERSION,
        FUNDED_EXECUTION_LABEL_MAPPING_VERSION,
        FUNDED_EXECUTION_QUALIFICATION_POLICY_VERSION,
        "funded-execution-training-v1",
        draft.trainingCodeVersion,
        draft.runtimeFingerprint,
        draft.status,
        draft.artifact === null ? null : JSON.stringify(draft.artifact),
        draft.metrics === null ? null : JSON.stringify(draft.metrics),
        JSON.stringify(draft.sampleCounts),
        draft.failureReceipt,
      ],
    );
    if (!inserted.rows[0]) {
      const raced = await this.findChallengerByDatasetDigest(
        draft.datasetDigest,
      );
      if (!raced) throw new Error("FUNDED_EXECUTION_CHALLENGER_WRITE_CONFLICT");
      if (raced.artifactDigest !== draft.artifactDigest)
        throw new Error("CONFLICTING_FUNDED_EXECUTION_CHALLENGER");
      return raced;
    }
    return mapChallenger(inserted.rows[0]);
  }

  /**
   * Load the proven replay application order for each run that owns a
   * HISTORICAL_REPLAY decision. `applied_sequence` and the per-fact frontier
   * are database-assigned in the transaction that processes a non-LATE fact and
   * refused LATE_FACT rows keep both NULL, so the resulting points are the
   * replay's own chronology.
   *
   * The chronology is only provable when it is complete and agrees with the
   * durable run counter and frontier: every processed non-LATE fact has a
   * contiguous sequence from 1 through the counter, the count and maximum
   * sequence equal the counter, each stored frontier equals the computed
   * monotone frontier at that sequence, and pending/refused rows carry no
   * coordinate. Any disagreement fails the whole run closed rather than
   * silently dropping a fact from the replay timeline.
   */
  private async replayChronologies(
    decisions: readonly DecisionRow[],
  ): Promise<Map<string, FundedExecutionReplayChronology>> {
    const replays = new Map<string, FundedExecutionReplayChronology>();
    const runIds = [
      ...new Set(
        decisions
          .filter((row) => row.source_kind === "HISTORICAL_REPLAY")
          .map((row) => row.run_id),
      ),
    ];
    if (runIds.length === 0) return replays;
    const runs = await this.pool.query<RunSequenceRow>(
      `SELECT run_id,applied_sequence_counter,applied_frontier_at
         FROM paper_funded_run WHERE run_id = ANY($1::uuid[])`,
      [runIds],
    );
    const runByRunId = new Map(runs.rows.map((row) => [row.run_id, row]));
    const facts = await this.pool.query<AppliedFactRow>(
      `SELECT run_id,fact_id,fact_at,applied_sequence,
              applied_frontier_at AS stored_frontier_at,outcome,
              max(fact_at) OVER (
                PARTITION BY run_id ORDER BY applied_sequence
              ) AS frontier_at
         FROM paper_funded_fact
        WHERE run_id = ANY($1::uuid[])
        ORDER BY run_id,applied_sequence NULLS LAST`,
      [runIds],
    );
    const pointsByRun = new Map<string, { at: string; sequence: number }[]>();
    const incompleteRuns = new Set<string>();
    for (const fact of facts.rows) {
      const outcome = outcomeRecordOf(fact.outcome);
      const status =
        outcome && typeof outcome.status === "string" ? outcome.status : null;
      const sequence =
        fact.applied_sequence === null ? null : Number(fact.applied_sequence);
      const storedFrontier = iso(fact.stored_frontier_at);
      if (outcome === null) {
        // A pending fact carries no applied coordinate.
        if (sequence !== null || storedFrontier !== null)
          incompleteRuns.add(fact.run_id);
        continue;
      }
      if (status === null) {
        incompleteRuns.add(fact.run_id);
        continue;
      }
      if (status === "LATE_FACT") {
        if (sequence !== null || storedFrontier !== null)
          incompleteRuns.add(fact.run_id);
        continue;
      }
      const computedFrontier = iso(fact.frontier_at);
      if (
        sequence === null ||
        storedFrontier === null ||
        computedFrontier === null ||
        computedFrontier !== storedFrontier
      ) {
        incompleteRuns.add(fact.run_id);
        continue;
      }
      const points = pointsByRun.get(fact.run_id) ?? [];
      points.push({ at: storedFrontier, sequence });
      pointsByRun.set(fact.run_id, points);
    }
    for (const [runId, points] of pointsByRun) {
      if (incompleteRuns.has(runId)) continue;
      const run = runByRunId.get(runId);
      if (!run) continue;
      const counter = Number(run.applied_sequence_counter);
      const runFrontier = iso(run.applied_frontier_at);
      let valid =
        Number.isSafeInteger(counter) && counter > 0 && runFrontier !== null;
      if (valid && points.length !== counter) valid = false;
      if (valid) {
        for (const [index, point] of points.entries()) {
          if (point.sequence !== index + 1) {
            valid = false;
            break;
          }
        }
      }
      if (valid && points[points.length - 1]!.at !== runFrontier) valid = false;
      if (valid) replays.set(runId, { runId, points });
    }
    return replays;
  }

  /**
   * Resolve the immutable entry-order revision at or before the cutoff. Both
   * the revision's fact time and its recording time must be at or before the
   * cutoff, so a later close, recovery or reconciliation cannot finalize an
   * earlier partial fill. No selectable revision means unknown terminality,
   * which fails closed for a partial fill. The proof identity, revision, state
   * digest and both times are returned so the caller can bind them into the
   * label and row identity.
   *
   * Each selected revision also resolves its exact causal fact to an applied
   * sequence and frontier. A revision whose causal fact is missing,
   * unprocessed, refused, cross-run or without a durable coordinate returns no
   * replay provenance and fails replay terminality closed.
   */
  private async orderTerminality(
    decisions: readonly DecisionRow[],
    cutoff: Date,
  ): Promise<Map<string, FundedExecutionEntryTerminality>> {
    const result = new Map<string, FundedExecutionEntryTerminality>();
    if (decisions.length === 0) return result;
    const runIds = [...new Set(decisions.map((row) => row.run_id))];
    const orderIds = [...new Set(decisions.map((row) => row.observation_id))];
    const orders = await this.pool.query<OrderHistoryRow>(
      `SELECT DISTINCT ON (h.order_id)
              h.order_id,h.revision,h.fact_at,h.recorded_at,h.state,h.fact_id
         FROM paper_entry_order_history h
         JOIN paper_entry_order o ON o.order_id=h.order_id
        WHERE o.run_id = ANY($1::uuid[])
          AND h.order_id = ANY($2::text[])
          AND h.recorded_at IS NOT NULL
          AND h.fact_at <= $3::timestamptz
          AND h.recorded_at <= $3::timestamptz
        ORDER BY h.order_id,h.revision DESC`,
      [runIds, orderIds, cutoff],
    );
    const runByOrderId = new Map(
      decisions.map((row) => [row.observation_id, row.run_id]),
    );
    const factIds = [
      ...new Set(
        orders.rows
          .map((row) => row.fact_id)
          .filter((value): value is string => value !== null),
      ),
    ];
    const causalFacts =
      factIds.length === 0
        ? []
        : (
            await this.pool.query<CausalFactRow>(
              `SELECT run_id,fact_id,outcome,applied_sequence,applied_frontier_at
                 FROM paper_funded_fact
                WHERE run_id = ANY($1::uuid[]) AND fact_id = ANY($2::text[])`,
              [runIds, factIds],
            )
          ).rows;
    const factByKey = new Map(
      causalFacts.map((row) => [`${row.run_id}:${row.fact_id}`, row]),
    );
    for (const order of orders.rows) {
      const runId = runByOrderId.get(order.order_id);
      if (runId === undefined) continue;
      const provenance = causalProvenanceOf(
        order.fact_id === null
          ? undefined
          : factByKey.get(`${runId}:${order.fact_id}`),
      );
      result.set(
        `${runId}:${order.order_id}`,
        terminalityOfRevision(order, cutoff, provenance),
      );
    }
    return result;
  }
}

function causalProvenanceOf(
  row: CausalFactRow | undefined,
): FundedExecutionTerminalityProvenance | null {
  if (!row) return null;
  const outcome = outcomeRecordOf(row.outcome);
  const status =
    outcome && typeof outcome.status === "string" ? outcome.status : null;
  if (outcome === null || status === null || status === "LATE_FACT")
    return null;
  if (row.applied_sequence === null || row.applied_frontier_at === null)
    return null;
  return {
    factId: row.fact_id,
    appliedSequence: Number(row.applied_sequence),
    at: iso(row.applied_frontier_at)!,
  };
}

function terminalityOfRevision(
  row: OrderHistoryRow,
  cutoff: Date,
  replayProvenance: FundedExecutionTerminalityProvenance | null,
): FundedExecutionEntryTerminality {
  const factAt = iso(row.fact_at)!;
  const recordedAt = iso(row.recorded_at)!;
  const knownAt = latestOf([factAt, recordedAt]);
  const proof: FundedExecutionTerminalityProof = {
    orderId: row.order_id,
    revision: Number(row.revision),
    stateDigest: contentHash(row.state),
    factAt,
    recordedAt,
  };
  // The query already bounds both times by the cutoff; re-checking here keeps
  // the assembler's fail-closed cutoff check meaningful for direct callers.
  if (
    knownAt === null ||
    Date.parse(factAt) > cutoff.getTime() ||
    Date.parse(recordedAt) > cutoff.getTime()
  )
    return {
      state: "UNKNOWN",
      knownAt: null,
      proof: null,
      replayProvenance: null,
    };
  return {
    state: classifyOrderState(row.state),
    knownAt,
    proof,
    replayProvenance,
  };
}

const DATASET_COLUMNS = `id,market_id,currency,source_kind,evidence_schema_version,cohort_digest,
  cohort_components,dataset_policy_version,label_mapping_version,feature_version,
  qualification_policy_version,requested_cutoff,effective_cutoff,membership_digest,dataset_digest,
  row_count,counts,qualification_receipt,source_watermark,activation_eligible,created_at`;

const CHALLENGER_COLUMNS = `id,market_id,currency,cohort_digest,cohort_components,dataset_id,
  dataset_digest,model_version,artifact_digest,feature_version,label_mapping_version,
  qualification_policy_version,training_policy_version,training_code_version,runtime_fingerprint,
  status,artifact,metrics,sample_counts,failure_receipt,created_at`;

const CHALLENGER_SELECT = `SELECT ${CHALLENGER_COLUMNS} FROM funded_execution_challenger`;

const COHORT_SQL = `
  SELECT d.cohort_digest,d.market_id,d.currency,d.source_kind,d.cohort_components,
         count(*)::int AS decision_count,
         count(*) FILTER (WHERE r.source='LIVE' AND r.status='COMPLETED')::int AS completed_live_count,
         min(d.decision_at) AS first_decision_at,
         max(d.decision_at) AS last_decision_at
    FROM funded_decision_evidence d
    JOIN paper_bot_run r ON r.id=d.run_id
   WHERE d.evidence_schema_version=2
   GROUP BY d.cohort_digest,d.market_id,d.currency,d.source_kind,d.cohort_components
   ORDER BY max(d.decision_at) DESC`;

const DECISION_SQL = `
  SELECT d.run_id,d.observation_id,d.sequence,d.market_id,d.currency,d.account_id,
         d.evidence_schema_version,d.action,d.source_kind,d.content_digest,d.cohort_digest,
         d.decision_content,d.decision_at,o.instrument_id,r.source AS run_source,r.status AS run_status
    FROM funded_decision_evidence d
    JOIN paper_signal_observation o ON o.run_id=d.run_id AND o.id=d.observation_id
    JOIN paper_bot_run r ON r.id=d.run_id
   WHERE d.cohort_digest=$1 AND d.evidence_schema_version=2 AND d.decision_at <= $2
   ORDER BY d.decision_at,d.run_id,d.sequence`;

const OUTCOME_SQL = `
  SELECT o.run_id,o.observation_id,o.sequence,o.status,o.available_at,o.recorded_at,
         o.source_id,o.source_digest,o.reason,o.detail,o.supersedes_sequence,
         o.source_fact_id,o.knowledge_applied_sequence,o.knowledge_at
    FROM funded_decision_outcome o
    JOIN funded_decision_evidence d ON d.run_id=o.run_id AND d.observation_id=o.observation_id
   WHERE d.cohort_digest=$1 AND d.evidence_schema_version=2 AND d.decision_at <= $2
   ORDER BY o.run_id,o.observation_id,o.sequence`;

function outcomeRecordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function classifyOrderState(
  stateValue: unknown,
): "TERMINAL" | "OPEN" | "UNKNOWN" {
  const state = stateValue;
  if (typeof state !== "object" || state === null) return "UNKNOWN";
  const record = state as Record<string, unknown>;
  const status = record.status;
  if (status === "CANCELLED" || status === "REJECTED") return "TERMINAL";
  if (status === "FILLED") return "TERMINAL";
  const execution = record.execution;
  if (typeof execution === "object" && execution !== null) {
    const executionStatus = (execution as Record<string, unknown>).status;
    if (executionStatus === "CLOSED") return "TERMINAL";
    if (
      executionStatus === "NO_FILL" ||
      executionStatus === "REJECTED_ECONOMICS"
    )
      return "TERMINAL";
  }
  if (status === "PENDING") return "OPEN";
  return "UNKNOWN";
}

function latestOf(values: readonly (Date | string | null)[]): string | null {
  let latest: number | null = null;
  for (const value of values) {
    if (value === null) continue;
    const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
    if (!Number.isFinite(parsed)) continue;
    if (latest === null || parsed > latest) latest = parsed;
  }
  return latest === null ? null : new Date(latest).toISOString();
}

function exposureEnd(input: {
  assembly: ReturnType<typeof assembleFundedExecutionLabel>;
  availableOutcomes: readonly FundedExecutionOutcomeEvidence[];
  decisionAt: string;
  cutoff: Date;
}): string {
  if (input.assembly.verdict === "EXCLUDED") return input.decisionAt;
  const status = input.assembly.labels.terminalOutcomeStatus;
  if (status === "FILLED" || status === "PARTIAL_FILL") {
    const closed = input.availableOutcomes
      .filter((outcome) => outcome.status === "CLOSED")
      .sort((left, right) => right.sequence - left.sequence)[0];
    return closed ? closed.availableAt : input.cutoff.toISOString();
  }
  const latest = input.availableOutcomes
    .slice()
    .sort((left, right) => right.sequence - left.sequence)[0];
  return latest && Date.parse(latest.availableAt) > Date.parse(input.decisionAt)
    ? latest.availableAt
    : input.decisionAt;
}

function withoutDigest(cohort: FundedCohortIdentity): Record<string, unknown> {
  const components = { ...cohort } as Record<string, unknown>;
  delete components.cohortDigest;
  return components;
}

function mapDataset(row: DatasetRow): FundedExecutionDatasetManifest {
  return fundedExecutionDatasetManifestSchema.parse({
    id: row.id,
    marketId: row.market_id,
    currency: row.currency,
    cohort: fundedCohortIdentitySchema.parse({
      ...fundedCohortComponentsSchema.parse(row.cohort_components),
      cohortDigest: row.cohort_digest,
    }),
    sourceKind: row.source_kind,
    requestedCutoff: iso(row.requested_cutoff),
    effectiveCutoff: iso(row.effective_cutoff),
    datasetPolicyVersion: row.dataset_policy_version,
    labelMappingVersion: row.label_mapping_version,
    featureVersion: row.feature_version,
    qualificationPolicyVersion: row.qualification_policy_version,
    membershipDigest: row.membership_digest,
    datasetDigest: row.dataset_digest,
    qualificationReceipt: fundedExecutionQualificationReceiptSchema.parse(
      row.qualification_receipt,
    ),
    sourceWatermark: fundedExecutionSourceWatermarkSchema.parse(
      row.source_watermark,
    ),
    activationEligible: row.activation_eligible,
    createdAt: iso(row.created_at),
  });
}

function mapChallenger(row: ChallengerRow): FundedExecutionChallenger {
  return fundedExecutionChallengerSchema.parse({
    id: row.id,
    marketId: row.market_id,
    currency: row.currency,
    cohort: fundedCohortIdentitySchema.parse({
      ...fundedCohortComponentsSchema.parse(row.cohort_components),
      cohortDigest: row.cohort_digest,
    }),
    datasetId: row.dataset_id,
    datasetDigest: row.dataset_digest,
    modelVersion: row.model_version,
    modelType: "FUNDED_EXECUTION_QUALITY",
    artifactDigest: row.artifact_digest,
    featureVersion: row.feature_version,
    labelMappingVersion: row.label_mapping_version,
    qualificationPolicyVersion: row.qualification_policy_version,
    trainingPolicyVersion: row.training_policy_version,
    trainingCodeVersion: row.training_code_version,
    runtimeFingerprint: row.runtime_fingerprint,
    status: row.status,
    eligibleForActivation: false,
    active: false,
    artifact: row.artifact ?? null,
    metrics:
      row.metrics === null || row.metrics === undefined
        ? null
        : (row.metrics as Record<string, unknown>),
    sampleCounts: (row.sample_counts ?? {}) as Record<string, number>,
    failureReceipt: row.failure_receipt,
    createdAt: iso(row.created_at),
  });
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function dateOnly(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString().slice(0, 10)
    : String(value).slice(0, 10);
}
