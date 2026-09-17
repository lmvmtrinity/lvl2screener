import { randomUUID } from "node:crypto";
import {
  challengerExperimentSchema,
  registerChallengerSchema,
  type ChallengerExperiment,
  type ChallengerScope,
  type ExperimentAction,
  type RegisterChallenger,
} from "@tsx-scanner/contracts";
import { contentHash } from "../backtests/research-coverage.js";
import { DomainError } from "../errors.js";
import { sameChallengerScope } from "./challenger-scope.js";
import { type ChallengerAcceptanceRecords } from "./challenger-acceptance-repository.js";

export type ChallengerModelSnapshot = {
  id: string;
  marketId: ChallengerScope["marketId"];
  strategy: ChallengerScope["strategy"];
  modelVersion: string;
  status: string;
  active: boolean;
  artifact: unknown;
  completedAt: string | null;
  researchEvidence?: unknown;
  researchEvidenceVerified: boolean;
  scope: ChallengerScope | null;
  trainingLabelCutoffAt: string | null;
};

export interface ChallengerExperimentStore {
  getAcceptance?(
    baselineHash: string,
    planHash: string,
    marketId: ChallengerScope["marketId"],
  ): Promise<ChallengerAcceptanceRecords | null>;
  getRegistration?(
    requestId: string,
    requestHash: string,
  ): Promise<ChallengerExperiment | null>;
  getModel(id: string): Promise<ChallengerModelSnapshot | null | undefined>;
  register(
    input: ChallengerExperiment,
    requestId?: string,
    requestHash?: string,
  ): Promise<ChallengerExperiment>;
  get(id: string): Promise<ChallengerExperiment | null>;
  transition(
    id: string,
    action: ExperimentAction,
    requestId: string,
  ): Promise<ChallengerExperiment>;
  registerWithAcceptance?(
    input: ChallengerExperiment,
    records: ChallengerAcceptanceRecords,
    requestId?: string,
    requestHash?: string,
  ): Promise<ChallengerExperiment>;
}

export interface ChallengerActivationBoundary {
  activate(id: string): Promise<unknown>;
  now?: () => Date;
}

export class ChallengerExperimentError extends DomainError {
  constructor(
    readonly code:
      | "EXPERIMENT_MODEL_NOT_FOUND"
      | "EXPERIMENT_MODEL_NOT_READY"
      | "EXPERIMENT_MODEL_ACTIVE"
      | "EXPERIMENT_MODEL_SCOPE"
      | "EXPERIMENT_MODEL_SCOPE_UNPROVEN"
      | "EXPERIMENT_LABEL_CUTOFF_UNPROVEN"
      | "EXPERIMENT_ACCEPTANCE_PLAN_NOT_FOUND"
      | "EXPERIMENT_MODEL_EVIDENCE"
      | "EXPERIMENT_ARTIFACT_MISMATCH"
      | "EXPERIMENT_START_NOT_PROSPECTIVE"
      | "EXPERIMENT_NOT_FOUND"
      | "EXPERIMENT_STATE_CONFLICT",
    message: string,
  ) {
    super(code, message, code === "EXPERIMENT_NOT_FOUND" ? 404 : 409);
  }
}

export class ChallengerExperimentService {
  constructor(
    private readonly store: ChallengerExperimentStore,
    readonly activation: ChallengerActivationBoundary,
    private readonly options: { now?: () => Date } = {},
  ) {
    this.options = { now: options.now ?? activation.now };
  }

  async register(
    raw: RegisterChallenger,
    requestId: string = randomUUID(),
  ): Promise<ChallengerExperiment> {
    const input = registerChallengerSchema.parse(raw);
    let existing: ChallengerExperiment | null | undefined;
    try {
      existing = await this.store.getRegistration?.(
        requestId,
        contentHash(input),
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "EXPERIMENT_REGISTRATION_IDEMPOTENCY_CONFLICT"
      )
        throw new ChallengerExperimentError(
          "EXPERIMENT_STATE_CONFLICT",
          "The registration key was used with different input",
        );
      throw error;
    }
    if (existing) return existing;
    if (input.version === "register-challenger-v2") {
      if (
        !input.baseline ||
        !input.acceptancePlan ||
        !input.conditionDefinition ||
        contentHash(input.baseline) !== input.baselineIdentityHash ||
        contentHash(input.acceptancePlan) !== input.acceptancePlanHash ||
        contentHash(input.conditionDefinition) !==
          input.acceptancePlan.conditionDefinitionHash
      )
        throw new ChallengerExperimentError(
          "EXPERIMENT_STATE_CONFLICT",
          "Complete acceptance records do not match their declared identities",
        );
      if (
        !sameChallengerScope(input.baseline.scope, input.scope) ||
        !sameChallengerScope(input.acceptancePlan.scope, input.scope) ||
        input.baseline.researchEvidence.inputHash !==
          input.researchEvidence.inputHash ||
        input.acceptancePlan.startsAt !== input.startsAt ||
        input.acceptancePlan.endsAt !== input.endsAt ||
        input.acceptancePlan.baselineIdentityHash !==
          input.baselineIdentityHash ||
        input.conditionDefinition.marketId !== input.scope.marketId
      )
        throw new ChallengerExperimentError(
          "EXPERIMENT_STATE_CONFLICT",
          "Acceptance records do not match the frozen challenger scope",
        );
    }
    const now = (this.options.now ?? (() => new Date()))();
    const model = await this.store.getModel(input.modelId);
    if (!model)
      throw new ChallengerExperimentError(
        "EXPERIMENT_MODEL_NOT_FOUND",
        "The challenger model does not exist",
      );
    if (model.status !== "COMPLETED" || !model.artifact || !model.completedAt)
      throw new ChallengerExperimentError(
        "EXPERIMENT_MODEL_NOT_READY",
        "Only completed models with an immutable artifact can be observed",
      );
    if (model.active)
      throw new ChallengerExperimentError(
        "EXPERIMENT_MODEL_ACTIVE",
        "Active models use the existing snapshot path and cannot be enrolled as challengers",
      );
    if (
      model.marketId !== input.scope.marketId ||
      model.strategy !== input.scope.strategy ||
      model.modelVersion !== input.modelVersion
    )
      throw new ChallengerExperimentError(
        "EXPERIMENT_MODEL_SCOPE",
        "The model identity does not match the frozen challenger scope",
      );
    if (contentHash(model.artifact) !== input.artifactHash)
      throw new ChallengerExperimentError(
        "EXPERIMENT_ARTIFACT_MISMATCH",
        "The artifact hash does not match the completed model artifact",
      );
    if (
      !model.researchEvidence ||
      contentHash(model.researchEvidence) !==
        contentHash(input.researchEvidence)
    )
      throw new ChallengerExperimentError(
        "EXPERIMENT_MODEL_EVIDENCE",
        "The model is missing the exact verified research-evidence binding",
      );
    if (model.researchEvidenceVerified !== true)
      throw new ChallengerExperimentError(
        "EXPERIMENT_MODEL_EVIDENCE",
        "The model does not have a persisted VERIFIED research-evidence binding",
      );
    if (!model.scope)
      throw new ChallengerExperimentError(
        "EXPERIMENT_MODEL_SCOPE_UNPROVEN",
        "The completed model has no complete immutable challenger scope",
      );
    if (
      model.scope &&
      !sameChallengerScope(model.scope as ChallengerScope, input.scope)
    )
      throw new ChallengerExperimentError(
        "EXPERIMENT_MODEL_SCOPE",
        "The model scope does not match the frozen challenger scope",
      );

    if (
      !model.trainingLabelCutoffAt ||
      !Number.isFinite(Date.parse(model.trainingLabelCutoffAt))
    )
      throw new ChallengerExperimentError(
        "EXPERIMENT_LABEL_CUTOFF_UNPROVEN",
        "The source has no proved training-label availability cutoff",
      );

    const earliest = Math.max(
      now.getTime(),
      Date.parse(model.completedAt),
      model.trainingLabelCutoffAt
        ? Date.parse(model.trainingLabelCutoffAt)
        : Number.NEGATIVE_INFINITY,
    );
    if (Date.parse(input.startsAt) < earliest)
      throw new ChallengerExperimentError(
        "EXPERIMENT_START_NOT_PROSPECTIVE",
        "Challenger observation must start after registration, model completion and label availability",
      );

    const records =
      input.version === "register-challenger-v2"
        ? {
            baseline: input.baseline!,
            acceptancePlan: input.acceptancePlan!,
            conditionDefinition: input.conditionDefinition!,
          }
        : await this.store.getAcceptance?.(
            input.baselineIdentityHash,
            input.acceptancePlanHash,
            input.scope.marketId,
          );
    if (!records)
      throw new ChallengerExperimentError(
        "EXPERIMENT_ACCEPTANCE_PLAN_NOT_FOUND",
        "Complete immutable baseline, acceptance and condition records are required",
      );
    validateAcceptance(input, records);

    const {
      version: _version,
      baseline: _baseline,
      acceptancePlan: _acceptancePlan,
      conditionDefinition: _conditionDefinition,
      ...experimentInput
    } = input;
    const experiment = challengerExperimentSchema.parse({
      ...experimentInput,
      id: randomUUID(),
      registeredAt: now.toISOString(),
      state: "REGISTERED",
    });
    try {
      const requestHash = contentHash(input);
      if (this.store.registerWithAcceptance)
        return await this.store.registerWithAcceptance(
          experiment,
          records,
          requestId,
          requestHash,
        );
      return await this.store.register(experiment, requestId, requestHash);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "EXPERIMENT_REGISTRATION_IDEMPOTENCY_CONFLICT"
      ) {
        throw new ChallengerExperimentError(
          "EXPERIMENT_STATE_CONFLICT",
          "The registration idempotency key was already used with different input",
        );
      }
      throw error;
    }
  }

  async transition(
    id: string,
    action: ExperimentAction,
    requestId: string,
  ): Promise<ChallengerExperiment> {
    const current = await this.store.get(id);
    if (!current)
      throw new ChallengerExperimentError(
        "EXPERIMENT_NOT_FOUND",
        "Challenger experiment not found",
      );
    if (action === "START" || action === "RESUME") {
      const now = (this.options.now ?? (() => new Date()))();
      const model = await this.store.getModel(current.modelId);
      if (!model || model.status !== "COMPLETED" || !model.artifact)
        throw new ChallengerExperimentError(
          "EXPERIMENT_MODEL_NOT_READY",
          "Completed source model is required",
        );
      if (model.active)
        throw new ChallengerExperimentError(
          "EXPERIMENT_MODEL_ACTIVE",
          "Active models cannot start inactive observations",
        );
      if (
        !model.scope ||
        !sameChallengerScope(model.scope, current.scope) ||
        model.modelVersion !== current.modelVersion ||
        contentHash(model.artifact) !== current.artifactHash
      )
        throw new ChallengerExperimentError(
          "EXPERIMENT_MODEL_SCOPE",
          "Frozen model identity no longer matches",
        );
      if (
        model.researchEvidenceVerified !== true ||
        contentHash(model.researchEvidence) !==
          contentHash(current.researchEvidence)
      )
        throw new ChallengerExperimentError(
          "EXPERIMENT_MODEL_EVIDENCE",
          "Verified model evidence is required",
        );
      if (
        !model.trainingLabelCutoffAt ||
        Date.parse(model.trainingLabelCutoffAt) > Date.parse(current.startsAt)
      )
        throw new ChallengerExperimentError(
          "EXPERIMENT_LABEL_CUTOFF_UNPROVEN",
          "Prospective label cutoff is unproved",
        );
      const records = await this.store.getAcceptance?.(
        current.baselineIdentityHash,
        current.acceptancePlanHash,
        current.scope.marketId,
      );
      if (!records)
        throw new ChallengerExperimentError(
          "EXPERIMENT_ACCEPTANCE_PLAN_NOT_FOUND",
          "Complete immutable acceptance records are required",
        );
      validateAcceptance(current, records);
      if (now.getTime() >= Date.parse(current.endsAt))
        throw new ChallengerExperimentError(
          "EXPERIMENT_STATE_CONFLICT",
          "The observation window has ended",
        );
      if (now.getTime() < Date.parse(current.startsAt))
        throw new ChallengerExperimentError(
          "EXPERIMENT_START_NOT_PROSPECTIVE",
          "The explicit start cannot precede the frozen observation window",
        );
    }
    try {
      return await this.store.transition(id, action, requestId);
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message === "EXPERIMENT_STATE_CONFLICT" ||
          error.message === "EXPERIMENT_TRANSITION_IDEMPOTENCY_CONFLICT")
      ) {
        throw new ChallengerExperimentError(
          "EXPERIMENT_STATE_CONFLICT",
          "The challenger lifecycle action conflicts with its durable state or idempotency key",
        );
      }
      throw error;
    }
  }
}

export function validateAcceptance(
  input: RegisterChallenger,
  records: ChallengerAcceptanceRecords,
): void {
  const {
    baseline,
    acceptancePlan: plan,
    conditionDefinition: conditions,
  } = records;
  if (
    contentHash(baseline) !== input.baselineIdentityHash ||
    contentHash(plan) !== input.acceptancePlanHash ||
    contentHash(conditions) !== plan.conditionDefinitionHash ||
    plan.baselineIdentityHash !== input.baselineIdentityHash ||
    !sameChallengerScope(baseline.scope, input.scope) ||
    !sameChallengerScope(plan.scope, input.scope) ||
    contentHash(baseline.executionAssumptions) !==
      input.scope.executionAssumptionsHash ||
    contentHash(baseline.researchEvidence) !==
      contentHash(input.researchEvidence) ||
    plan.startsAt !== input.startsAt ||
    plan.endsAt !== input.endsAt ||
    conditions.marketId !== input.scope.marketId ||
    conditions.featureVersion !== baseline.featureVersion
  )
    throw new ChallengerExperimentError(
      "EXPERIMENT_STATE_CONFLICT",
      "Acceptance records do not match the complete frozen identity",
    );
}

export function nextExperimentState(
  state: ChallengerExperiment["state"],
  action: ExperimentAction,
): ChallengerExperiment["state"] {
  const transitions: Partial<
    Record<
      ChallengerExperiment["state"],
      Partial<Record<ExperimentAction, ChallengerExperiment["state"]>>
    >
  > = {
    REGISTERED: { START: "ACTIVE", END: "ENDED", REVOKE: "REVOKED" },
    ACTIVE: { PAUSE: "PAUSED", END: "ENDED", REVOKE: "REVOKED" },
    PAUSED: { RESUME: "ACTIVE", END: "ENDED", REVOKE: "REVOKED" },
    ENDED: { REVOKE: "REVOKED" },
  };
  const next = transitions[state]?.[action];
  if (!next) throw new Error("EXPERIMENT_STATE_CONFLICT");
  return next;
}
