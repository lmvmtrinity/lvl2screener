import {
  FUNDED_EXECUTION_LABEL_MAPPING_VERSION,
  fundedOutcomeDetailSchema,
  type FundedDecisionTimeInput,
  type FundedExecutionExclusionReason,
  type FundedExecutionKnowledgeCoordinate,
  type FundedExecutionLabels,
  type FundedExecutionTerminalityProof,
  type FundedOutcomeStatus,
} from "@tsx-scanner/contracts";

/**
 * Point-in-time label mapping for funded-execution learning (FP02).
 *
 * The mapping consumes only immutable version-2 funded decisions and
 * append-only outcome versions. It freezes:
 *
 * - `POLICY_DECLINED`/`POLICY_DEFERRED` and `RISK_VETOED` are policy/portfolio
 *   outcomes, never execution failures;
 * - `DECISION_ACCEPTED`/`UNRESOLVED` and `NO_EXECUTABLE_QUOTE` are unknown or
 *   incomplete evidence, never losses and never zero fills;
 * - a terminal `NO_FILL`/`EXPIRED` proves fill 0 only when the durable order
 *   state shows the entry opportunity has ended;
 * - a `PARTIAL_FILL` is final only when an immutable order revision selected at
 *   the cutoff provably established that further entry execution was
 *   impossible, and the proof identity/revision/digest/times are bound into the
 *   label;
 * - cost/slippage labels require retained fill evidence and stay null
 *   otherwise.
 *
 * A version is selectable only when both `availableAt` and the database-owned
 * `recordedAt` are at or before the dataset cutoff, and supersession is
 * evaluated only among versions selectable at that cutoff, so a later
 * correction can neither enter nor retroactively erase an earlier dataset. The
 * same rule applies to the order-history terminality proof: only a revision
 * whose fact time and recording time were both at or before the cutoff can
 * finalize a label, so a later close, recovery or reconciliation never changes
 * an earlier cutoff's assembled row, membership or dataset digest.
 *
 * Chronology is separate from audit capture. A live label's chronology is its
 * database capture knowledge time. A historical replay binds the persisted
 * causal knowledge boundary of the selected outcome version — the exact run
 * and applied funded fact that made that version knowable when it was recorded
 * — plus, when the disposition depends on entry terminality, the terminality
 * boundary, using the later of the two. Economic timestamps are never used to
 * infer replay chronology, so a correction recorded after a holdout cannot
 * backdate itself to its earlier economic event. A replay label whose causal
 * boundary is missing, cross-run or not provable fails closed as
 * `REPLAY_CHRONOLOGY_UNPROVEN`.
 */

export const FUNDED_EXECUTION_LABEL_MAPPING_VERSION_VALUE =
  FUNDED_EXECUTION_LABEL_MAPPING_VERSION;

/**
 * The persisted causal knowledge boundary of one outcome version. It binds the
 * owning run and the proven applied funded fact that made the version knowable
 * at the moment it was recorded. A replay version without a boundary cannot be
 * ordered on the replay timeline and the row fails closed; live versions carry
 * null and use their database capture knowledge time.
 */
export interface FundedExecutionOutcomeKnowledge {
  readonly runId: string;
  readonly sequence: number;
  readonly at: string;
}

export interface FundedExecutionOutcomeEvidence {
  readonly sequence: number;
  readonly status: FundedOutcomeStatus;
  readonly availableAt: string;
  readonly recordedAt: string;
  readonly sourceId: string;
  readonly sourceDigest: string;
  readonly reason: string | null;
  readonly detail: unknown;
  readonly supersedesSequence: number | null;
  /** Immutable replay boundary; null for live capture. */
  readonly knowledge: FundedExecutionOutcomeKnowledge | null;
}

/**
 * Exact applied-fact provenance of a replay order revision. `factId` is the
 * durable funded fact that caused the revision; `appliedSequence` and `at` are
 * derived by the database from that fact once it is acknowledged. It is never
 * inferred from the revision's fact time.
 */
export interface FundedExecutionTerminalityProvenance {
  readonly factId: string;
  readonly appliedSequence: number;
  readonly at: string;
}

/**
 * Durable proof about whether further entry execution is still possible. The
 * proof is the immutable order revision selected at or before the dataset
 * cutoff; it carries its own identity, state digest and both times so row
 * identity changes only while the same revision was provable. `state UNKNOWN`
 * (no selectable revision) fails closed for an intermediate partial fill.
 * `knownAt` is the latest of the proof's fact and recording times, so a
 * terminality proof recorded after the dataset cutoff cannot finalize a partial
 * fill at that cutoff. `replayProvenance` binds the exact causal fact that
 * produced the revision; a replay label that depends on the proof requires it.
 */
export interface FundedExecutionEntryTerminality {
  readonly state: "TERMINAL" | "OPEN" | "UNKNOWN";
  readonly knownAt: string | null;
  readonly proof: FundedExecutionTerminalityProof | null;
  readonly replayProvenance: FundedExecutionTerminalityProvenance | null;
}

/**
 * One proven replay application point. `sequence` is the applied sequence and
 * `at` is the run's monotone applied-fact frontier (the greatest fact time
 * applied at or before that sequence), so enqueue-side reconciliation that is
 * processed out of fact-time order cannot make the chronology non-monotone.
 * Sequences must be strictly increasing and times non-decreasing; an invalid
 * set is unprovable and fails closed.
 */
export interface FundedExecutionReplayFactPoint {
  readonly at: string;
  readonly sequence: number;
}

/**
 * The replay chronology of one decision's run. `runId` must match the decision
 * run; the points are the run's acknowledged facts in application order.
 */
export interface FundedExecutionReplayChronology {
  readonly runId: string;
  readonly points: readonly FundedExecutionReplayFactPoint[];
}

export interface FundedExecutionDecisionRecord {
  readonly runId: string;
  readonly observationId: string;
  readonly accountId: string;
  readonly marketId: "CA_TSX" | "US_EQUITIES";
  readonly currency: "CAD" | "USD";
  readonly decisionSequence: number;
  readonly decisionContentDigest: string;
  readonly cohortDigest: string;
  readonly evidenceSchemaVersion: number;
  readonly sourceKind: "LIVE_PAPER" | "HISTORICAL_REPLAY";
  readonly action: "SUBMIT" | "DECLINE" | "DEFER";
  readonly decisionAt: string;
  readonly runSource: string;
  readonly runStatus: string;
  readonly instrumentId: string | null;
  readonly decisionContent: FundedDecisionTimeInput | null;
  readonly outcomes: readonly FundedExecutionOutcomeEvidence[];
  readonly entryTerminality: FundedExecutionEntryTerminality;
  /** Required for a HISTORICAL_REPLAY row; null means unprovable replay chronology. */
  readonly replayChronology: FundedExecutionReplayChronology | null;
}

export type FundedExecutionAssembly =
  | {
      readonly verdict: "INCLUDED";
      readonly labels: FundedExecutionLabels;
      readonly selectedOutcomeSequences: number[];
      readonly selectedOutcomeSourceDigests: string[];
    }
  | {
      readonly verdict: "EXCLUDED";
      readonly reason: FundedExecutionExclusionReason;
      /** True when the exclusion is incomplete/unknown evidence, not a verdict. */
      readonly unknown: boolean;
    };

const UNKNOWN_EXCLUSIONS = new Set<FundedExecutionExclusionReason>([
  "UNRESOLVED",
  "DECISION_ACCEPTED_NOT_EXECUTED",
  "NO_EXECUTABLE_QUOTE_MISSING_MARKET",
  "INTERMEDIATE_PARTIAL_FILL",
  "COST_EVIDENCE_MISSING",
  "LABEL_NOT_AVAILABLE_AT_CUTOFF",
  "REPLAY_CHRONOLOGY_UNPROVEN",
]);

export function assembleFundedExecutionLabel(input: {
  decision: FundedExecutionDecisionRecord;
  cutoff: Date;
}): FundedExecutionAssembly {
  const { decision, cutoff } = input;
  const exclude = (
    reason: FundedExecutionExclusionReason,
  ): FundedExecutionAssembly => ({
    verdict: "EXCLUDED",
    reason,
    unknown: UNKNOWN_EXCLUSIONS.has(reason),
  });

  if (decision.evidenceSchemaVersion !== 2 || decision.decisionContent === null)
    return exclude("EVIDENCE_SCHEMA_VERSION_UNSUPPORTED");

  // Policy refusals are decisions, not execution outcomes.
  if (decision.action === "DECLINE") return exclude("POLICY_DECLINED");
  if (decision.action === "DEFER") return exclude("POLICY_DEFERRED");

  const cutoffMs = cutoff.getTime();
  const available = decision.outcomes.filter(
    (outcome) =>
      Date.parse(outcome.availableAt) <= cutoffMs &&
      Date.parse(outcome.recordedAt) <= cutoffMs,
  );
  if (available.length === 0)
    return decision.outcomes.length > 0
      ? exclude("LABEL_NOT_AVAILABLE_AT_CUTOFF")
      : exclude("UNRESOLVED");

  // Supersession is evaluated only among versions selectable at the cutoff, so
  // a correction recorded later cannot invalidate an earlier dataset.
  const superseded = new Set<number>();
  for (const outcome of available)
    if (outcome.supersedesSequence !== null)
      superseded.add(outcome.supersedesSequence);
  const effective = available
    .filter((outcome) => !superseded.has(outcome.sequence))
    .sort((left, right) => left.sequence - right.sequence);

  const hasStatus = (status: FundedOutcomeStatus) =>
    effective.some((outcome) => outcome.status === status);
  const latestWithStatuses = (...statuses: FundedOutcomeStatus[]) =>
    effective
      .filter((outcome) => statuses.includes(outcome.status))
      .sort((left, right) => right.sequence - left.sequence)[0];

  if (hasStatus("POLICY_DECLINED")) return exclude("POLICY_DECLINED");
  if (hasStatus("POLICY_DEFERRED")) return exclude("POLICY_DEFERRED");
  if (hasStatus("RISK_VETOED")) return exclude("RISK_VETOED");
  if (hasStatus("NO_EXECUTABLE_QUOTE"))
    return exclude("NO_EXECUTABLE_QUOTE_MISSING_MARKET");
  if (hasStatus("UNRESOLVED")) return exclude("UNRESOLVED");

  // A trainable replay version can only be ordered by its persisted causal
  // boundary. Any effective version without an own-run boundary makes the
  // chronology unprovable rather than letting it be silently dropped or
  // backdated. Policy refusals above keep their own exclusion reason.
  if (
    decision.sourceKind === "HISTORICAL_REPLAY" &&
    effective.some(
      (outcome) =>
        outcome.knowledge === null ||
        outcome.knowledge.runId !== decision.runId,
    )
  )
    return exclude("REPLAY_CHRONOLOGY_UNPROVEN");

  const selection = effective.map((outcome) => ({
    sequence: outcome.sequence,
    sourceDigest: outcome.sourceDigest,
  }));

  const fillVersion = latestWithStatuses("FILLED", "PARTIAL_FILL");
  if (fillVersion) {
    let proof: FundedExecutionTerminalityProof | null = null;
    if (fillVersion.status === "PARTIAL_FILL") {
      // A partial fill is final only when an immutable order revision selected
      // at the cutoff provably established entry terminality. Missing or
      // unprovable terminality stays intermediate, and the proof identity,
      // revision, state digest and both times are bound into the label.
      proof = terminalityProofAt(decision, cutoffMs);
      if (!proof) return exclude("INTERMEDIATE_PARTIAL_FILL");
    }
    const fill = fillDetailOf(fillVersion);
    if (!fill) return exclude("COST_EVIDENCE_MISSING");
    const knowledge = labelKnowledge({
      decision,
      version: fillVersion,
      proof,
    });
    if (!knowledge) return exclude("REPLAY_CHRONOLOGY_UNPROVEN");
    return {
      verdict: "INCLUDED",
      labels: {
        fillProbability: 1,
        fillFraction: fill.filledFraction,
        slippagePerShare: fill.slippagePerShare,
        totalExecutionCost: fill.totalExecutionCost,
        labelAvailableAt: knowledge.labelAvailableAt,
        knowledge: knowledge.knowledge,
        economicOutcomeAt: fillVersion.availableAt,
        terminalityProof: proof,
        terminalOutcomeStatus: fillVersion.status,
        terminalOutcomeSequence: fillVersion.sequence,
        terminalOutcomeSourceDigest: fillVersion.sourceDigest,
        fillLabelAvailable: true,
        costLabelAvailable:
          fill.slippagePerShare !== null && fill.totalExecutionCost !== null,
      },
      selectedOutcomeSequences: selection.map((item) => item.sequence),
      selectedOutcomeSourceDigests: selection.map((item) => item.sourceDigest),
    };
  }

  const zeroFill = latestWithStatuses("NO_FILL", "EXPIRED");
  if (zeroFill) {
    // A pending order cannot prove a terminal zero fill; the projected status
    // already requires a terminal order state, so only an explicitly open
    // order revision at the cutoff fails closed here.
    if (decision.entryTerminality.state === "OPEN")
      return exclude("INTERMEDIATE_PARTIAL_FILL");
    const proof = terminalityProofAt(decision, cutoffMs);
    const knowledge = labelKnowledge({ decision, version: zeroFill, proof });
    if (!knowledge) return exclude("REPLAY_CHRONOLOGY_UNPROVEN");
    return {
      verdict: "INCLUDED",
      labels: {
        fillProbability: 0,
        fillFraction: 0,
        slippagePerShare: null,
        totalExecutionCost: null,
        labelAvailableAt: knowledge.labelAvailableAt,
        knowledge: knowledge.knowledge,
        economicOutcomeAt: zeroFill.availableAt,
        terminalityProof: proof,
        terminalOutcomeStatus: zeroFill.status,
        terminalOutcomeSequence: zeroFill.sequence,
        terminalOutcomeSourceDigest: zeroFill.sourceDigest,
        fillLabelAvailable: true,
        costLabelAvailable: false,
      },
      selectedOutcomeSequences: selection.map((item) => item.sequence),
      selectedOutcomeSourceDigests: selection.map((item) => item.sourceDigest),
    };
  }

  const closed = latestWithStatuses("CLOSED");
  if (closed) {
    const detail = recordOf(closed.detail);
    const fraction = finiteNumber(detail?.filledFraction);
    if (fraction !== null && fraction > 0 && fraction <= 1) {
      if (decision.entryTerminality.state === "OPEN")
        return exclude("INTERMEDIATE_PARTIAL_FILL");
      const proof = terminalityProofAt(decision, cutoffMs);
      const knowledge = labelKnowledge({ decision, version: closed, proof });
      if (!knowledge) return exclude("REPLAY_CHRONOLOGY_UNPROVEN");
      return {
        verdict: "INCLUDED",
        labels: {
          fillProbability: 1,
          fillFraction: fraction,
          slippagePerShare: null,
          totalExecutionCost: null,
          labelAvailableAt: knowledge.labelAvailableAt,
          knowledge: knowledge.knowledge,
          economicOutcomeAt: closed.availableAt,
          terminalityProof: proof,
          terminalOutcomeStatus: "CLOSED",
          terminalOutcomeSequence: closed.sequence,
          terminalOutcomeSourceDigest: closed.sourceDigest,
          fillLabelAvailable: true,
          costLabelAvailable: false,
        },
        selectedOutcomeSequences: selection.map((item) => item.sequence),
        selectedOutcomeSourceDigests: selection.map(
          (item) => item.sourceDigest,
        ),
      };
    }
    return exclude("UNRESOLVED");
  }

  if (hasStatus("DECISION_ACCEPTED"))
    return exclude("DECISION_ACCEPTED_NOT_EXECUTED");
  return exclude("UNRESOLVED");
}

/**
 * Returns the immutable terminality proof only when the selected order revision
 * is terminal and was fully known at the cutoff. Anything else is unprovable at
 * that cutoff.
 */
function terminalityProofAt(
  decision: FundedExecutionDecisionRecord,
  cutoffMs: number,
): FundedExecutionTerminalityProof | null {
  const terminality = decision.entryTerminality;
  if (terminality.state !== "TERMINAL" || terminality.proof === null)
    return null;
  if (
    terminality.knownAt === null ||
    Date.parse(terminality.knownAt) > cutoffMs
  )
    return null;
  return terminality.proof;
}

/**
 * Knowledge time at which the label was fully determinable: the latest of the
 * terminal version's economic and recorded times plus, when the disposition
 * depends on it, the terminality proof's own fact and recording times.
 */
function knowledgeTime(
  version: FundedExecutionOutcomeEvidence,
  proof: FundedExecutionTerminalityProof | null,
): string {
  let latest = Math.max(
    Date.parse(version.availableAt),
    Date.parse(version.recordedAt),
  );
  if (proof)
    latest = Math.max(
      latest,
      Date.parse(proof.factAt),
      Date.parse(proof.recordedAt),
    );
  return new Date(latest).toISOString();
}

/**
 * Chronology coordinate for one label. Live capture uses its audit knowledge
 * time. A historical replay binds the selected outcome version's persisted
 * causal boundary; when the disposition also depends on entry terminality, the
 * label binds both boundaries and uses the later proven one. A missing,
 * cross-run, non-monotone or empty chronology is unprovable and fails closed.
 */
function labelKnowledge(input: {
  decision: FundedExecutionDecisionRecord;
  version: FundedExecutionOutcomeEvidence;
  proof: FundedExecutionTerminalityProof | null;
}): {
  readonly labelAvailableAt: string;
  readonly knowledge: FundedExecutionKnowledgeCoordinate;
} | null {
  const labelAvailableAt = knowledgeTime(input.version, input.proof);
  if (input.decision.sourceKind !== "HISTORICAL_REPLAY")
    return {
      labelAvailableAt,
      knowledge: {
        provenance: "DATABASE_CAPTURE",
        runId: null,
        sequence: null,
        at: labelAvailableAt,
      },
    };
  const chronology = input.decision.replayChronology;
  if (
    !chronology ||
    chronology.runId !== input.decision.runId ||
    input.decision.runSource !== "BACKTEST"
  )
    return null;
  const versionBoundary = input.version.knowledge;
  if (
    !versionBoundary ||
    versionBoundary.runId !== input.decision.runId ||
    !Number.isSafeInteger(versionBoundary.sequence) ||
    versionBoundary.sequence < 1 ||
    !Number.isFinite(Date.parse(versionBoundary.at))
  )
    return null;
  // The persisted boundary must itself be provable in the run's applied-fact
  // chronology: an empty or inconsistent chronology, or a boundary that is not
  // covered by it, fails closed even when no terminality proof is involved.
  const versionPoint = replayPointAt(
    chronology.points,
    Date.parse(versionBoundary.at),
  );
  if (versionPoint === null || versionPoint.sequence < versionBoundary.sequence)
    return null;
  let boundary = {
    sequence: versionBoundary.sequence,
    at: versionBoundary.at,
  };
  if (input.proof) {
    // The terminality proof must resolve to its exact causal fact's applied
    // sequence. The later of the outcome-version and terminality sequences by
    // applied order governs the label, so a correction or a late close can
    // never backdate it. A proof that cannot name its exact causal fact fails
    // closed instead of being inferred from its fact time.
    const provenance = input.decision.entryTerminality.replayProvenance;
    if (
      !provenance ||
      !Number.isSafeInteger(provenance.appliedSequence) ||
      provenance.appliedSequence < 1 ||
      !Number.isFinite(Date.parse(provenance.at))
    )
      return null;
    if (provenance.appliedSequence > boundary.sequence)
      boundary = {
        sequence: provenance.appliedSequence,
        at: provenance.at,
      };
  }
  return {
    labelAvailableAt,
    knowledge: {
      provenance: "HISTORICAL_REPLAY_FACT_SEQUENCE",
      runId: input.decision.runId,
      sequence: boundary.sequence,
      at: boundary.at,
    },
  };
}

/**
 * The proven applied-fact point with the highest applied sequence whose fact
 * time is at or before the given replay time. Points must be ordered by the
 * applied sequence and non-decreasing in time; anything else is an inconsistent
 * replay chronology and fails closed.
 */
function replayPointAt(
  points: readonly FundedExecutionReplayFactPoint[],
  atMs: number,
): FundedExecutionReplayFactPoint | null {
  if (!Number.isFinite(atMs) || points.length === 0) return null;
  let previousAt = Number.NEGATIVE_INFINITY;
  let previousSequence = 0;
  let found: FundedExecutionReplayFactPoint | null = null;
  for (const point of points) {
    const pointAt = Date.parse(point.at);
    if (!Number.isFinite(pointAt)) return null;
    if (
      !Number.isSafeInteger(point.sequence) ||
      point.sequence <= previousSequence ||
      pointAt < previousAt
    )
      return null;
    previousAt = pointAt;
    previousSequence = point.sequence;
    if (pointAt <= atMs) found = point;
  }
  return found;
}

interface ParsedFillDetail {
  readonly filledFraction: number;
  readonly slippagePerShare: number | null;
  readonly totalExecutionCost: number | null;
}

/**
 * Cost labels exist only when the retained fill detail proves them. An invalid
 * or absent detail leaves the cost labels unknown rather than zero.
 */
function fillDetailOf(
  outcome: FundedExecutionOutcomeEvidence,
): ParsedFillDetail | null {
  if (outcome.status !== "FILLED" && outcome.status !== "PARTIAL_FILL")
    return null;
  const parsed = fundedOutcomeDetailSchema.safeParse({
    status: outcome.status,
    detail: outcome.detail,
  });
  if (!parsed.success) return null;
  if (parsed.data.status !== "FILLED" && parsed.data.status !== "PARTIAL_FILL")
    return null;
  const detail = parsed.data.detail;
  const slippagePerShare = finiteNumber(detail.slippage);
  const fees = finiteNumber(detail.fees);
  const filledShares = finiteNumber(detail.filledShares);
  const totalExecutionCost =
    slippagePerShare !== null &&
    fees !== null &&
    filledShares !== null &&
    slippagePerShare >= 0 &&
    fees >= 0 &&
    filledShares >= 0
      ? round(fees + slippagePerShare * filledShares, 10)
      : null;
  return {
    filledFraction: detail.filledFraction,
    slippagePerShare:
      slippagePerShare !== null && slippagePerShare >= 0
        ? slippagePerShare
        : null,
    totalExecutionCost,
  };
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
