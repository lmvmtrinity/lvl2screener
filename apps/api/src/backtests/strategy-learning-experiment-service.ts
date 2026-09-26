import {
  strategyLearningExperimentIdentitySchema,
  strategyLearningTrialAttemptSchema,
  strategyLearningTrialClaimRequestSchema,
  type StrategyLearningExperimentIdentity,
  type StrategyLearningFinalTestLink,
  type StrategyLearningTrialAttempt,
  type StrategyLearningTrialClaim,
  type StrategyLearningTrialClaimRequest,
} from "@tsx-scanner/contracts";
import type { StudyExecutionFence } from "./strategy-study-service.js";

export interface StrategyLearningExperimentStore {
  freeze(
    identity: StrategyLearningExperimentIdentity,
  ): Promise<StrategyLearningExperimentIdentity>;
  get(studyId: string): Promise<StrategyLearningExperimentIdentity | null>;
  claim(
    studyId: string,
    claim: StrategyLearningTrialClaimRequest,
    fence: StudyExecutionFence,
  ): Promise<StrategyLearningTrialClaim>;
  append(
    studyId: string,
    attempt: StrategyLearningTrialAttempt,
    fence: StudyExecutionFence,
  ): Promise<StrategyLearningTrialAttempt>;
  linkFinalTest(
    studyId: string,
    testClaimId: string,
  ): Promise<StrategyLearningFinalTestLink>;
}

export class StrategyLearningExperimentService {
  constructor(private readonly store: StrategyLearningExperimentStore) {}

  async freeze(
    rawIdentity: StrategyLearningExperimentIdentity,
  ): Promise<StrategyLearningExperimentIdentity> {
    const identity =
      strategyLearningExperimentIdentitySchema.parse(rawIdentity);
    const stored = await this.store.freeze(identity);
    if (JSON.stringify(stored) !== JSON.stringify(identity))
      throw new Error("STRATEGY_STUDY_LEDGER_IDENTITY_CONFLICT");
    return stored;
  }

  async recordTrial(
    studyId: string,
    studySpecHash: string,
    rawAttempt: StrategyLearningTrialAttempt,
    fence: StudyExecutionFence,
  ): Promise<StrategyLearningTrialAttempt> {
    const attempt = strategyLearningTrialAttemptSchema.parse(rawAttempt);
    const identity = await this.store.get(studyId);
    if (!identity || identity.studyId !== studyId)
      throw new Error("STRATEGY_STUDY_LEDGER_NOT_FOUND");
    if (identity.studySpecHash !== studySpecHash)
      throw new Error("STRATEGY_STUDY_SPEC_HASH_MISMATCH");
    return this.store.append(studyId, attempt, fence);
  }

  async claimTrial(
    studyId: string,
    studySpecHash: string,
    rawClaim: StrategyLearningTrialClaimRequest,
    fence: StudyExecutionFence,
  ): Promise<StrategyLearningTrialClaim> {
    const claim = strategyLearningTrialClaimRequestSchema.parse(rawClaim);
    const identity = await this.store.get(studyId);
    if (!identity || identity.studyId !== studyId)
      throw new Error("STRATEGY_STUDY_LEDGER_NOT_FOUND");
    if (identity.studySpecHash !== studySpecHash)
      throw new Error("STRATEGY_STUDY_SPEC_HASH_MISMATCH");
    return this.store.claim(studyId, claim, fence);
  }

  async linkFinalTest(
    studyId: string,
    studySpecHash: string,
    testClaimId: string,
  ): Promise<StrategyLearningFinalTestLink> {
    const identity = await this.store.get(studyId);
    if (!identity) throw new Error("STRATEGY_STUDY_LEDGER_NOT_FOUND");
    if (identity.studySpecHash !== studySpecHash)
      throw new Error("STRATEGY_STUDY_SPEC_HASH_MISMATCH");
    return this.store.linkFinalTest(studyId, testClaimId);
  }
}
