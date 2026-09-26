import { describe, expect, it } from "vitest";
import {
  boundedRuleSearchSpaceSchema,
  type BoundedRuleSearchSpace,
} from "@tsx-scanner/contracts";
import { contentHash } from "../src/backtests/research-coverage.js";
import { studyPlan } from "./study-fixture.js";
import {
  buildUnadmittedToggleCandidateStudyDraft,
  boundedRuleCandidateLedgerSpec,
  enumerateBoundedRuleCandidates,
} from "../src/backtests/bounded-rule-candidates.js";
import { assertStudyProfileScope } from "../src/backtests/study-profile-scope.js";

const searchSpace: BoundedRuleSearchSpace = {
  version: "bounded-rule-search-space-v1",
  strategy: "ORB_RETEST",
  marketId: "CA_TSX",
  baselineParameters: studyPlan().inputs.TRAIN.baseline.parameters,
  dimensions: [
    { key: "retestVolumeContractionEnabled", values: [1] },
    { key: "scoreCutoff", values: [10, 20] },
  ],
  maxCandidates: 5,
};

describe("bounded rule candidates", () => {
  it("enumerates stable identities and descriptions in declared order", () => {
    const first = enumerateBoundedRuleCandidates(searchSpace);
    const second = enumerateBoundedRuleCandidates(searchSpace);
    expect(first).toHaveLength(5);
    expect(first).toEqual(second);
    expect(
      new Set(first.map((candidate) => candidate.candidateHash)).size,
    ).toBe(5);
    expect(first[0]?.neighborDescription).toBe("scoreCutoff 0 -> 10");
    expect(first[0]?.candidateHash).toBe(
      contentHash({
        searchSpaceHash: first[0]?.searchSpaceHash,
        strategy: first[0]?.strategy,
        marketId: first[0]?.marketId,
        parameters: first[0]?.parameters,
      }),
    );
    expect(
      first.some(
        (candidate) =>
          candidate.neighborDescription ===
          "retestVolumeContractionEnabled 0 -> 1",
      ),
    ).toBe(true);
    expect(
      first.some((candidate) => candidate.parameters.scoreCutoff === 20),
    ).toBe(true);
  });

  it("rejects unknown dimensions, out of bounds values, and an undersized budget", () => {
    expect(() =>
      boundedRuleSearchSpaceSchema.parse({
        ...searchSpace,
        dimensions: [{ key: "unlistedParameter", values: [1] }],
      }),
    ).toThrow();
    expect(() =>
      boundedRuleSearchSpaceSchema.parse({
        ...searchSpace,
        dimensions: [{ key: "scoreCutoff", values: [101] }],
      }),
    ).toThrow();
    expect(() =>
      enumerateBoundedRuleCandidates({ ...searchSpace, maxCandidates: 4 }),
    ).toThrow();
    expect(() =>
      boundedRuleSearchSpaceSchema.parse({
        ...searchSpace,
        baselineParameters: { retestVolumeContractionEnabled: 0, injected: 5 },
      }),
    ).toThrow();
    expect(() =>
      boundedRuleSearchSpaceSchema.parse({
        ...searchSpace,
        dimensions: [{ key: "scoreCutoff", values: [10, 10] }],
      }),
    ).toThrow();
    expect(() =>
      boundedRuleSearchSpaceSchema.parse({
        ...searchSpace,
        dimensions: [{ key: "retestVolumeContractionEnabled", values: [0] }],
      }),
    ).toThrow();
  });

  it("builds only an unadmitted draft for an approved single toggle with matching stage inputs", () => {
    const candidate = enumerateBoundedRuleCandidates({
      ...searchSpace,
      dimensions: [{ key: "retestVolumeContractionEnabled", values: [1] }],
      maxCandidates: 1,
    })[0]!;
    const plan = studyPlan();
    for (const stage of Object.values(plan.inputs)) {
      stage.baseline.parameters.retestVolumeContractionEnabled = 0;
      stage.challenger.parameters.retestVolumeContractionEnabled = 1;
    }
    const draft = buildUnadmittedToggleCandidateStudyDraft(
      { ...candidate, approvalStatus: "APPROVED" },
      plan,
    );
    if (draft.state !== "READY_UNADMITTED")
      throw new Error("EXPECTED_READY_UNADMITTED_DRAFT");
    expect(draft.candidateHash).toBe(candidate.candidateHash);
    const adapted = draft.plan;
    expect(adapted.boundedRuleCandidate).toEqual({
      ...candidate,
      approvalStatus: "APPROVED",
    });
    expect(contentHash(boundedRuleCandidateLedgerSpec(candidate))).not.toBe(
      candidate.candidateHash,
    );
    expect(adapted.variant).toBe("RETEST_CONTRACTION");
    expect(adapted.baselineProfileConfigId).toBe(plan.baselineProfileConfigId);
    expect(adapted.challengerProfileConfigId).toBe(
      plan.challengerProfileConfigId,
    );
    expect(
      adapted.inputs.TEST.challenger.parameters.retestVolumeContractionEnabled,
    ).toBe(1);
    expect(() =>
      buildUnadmittedToggleCandidateStudyDraft(candidate, plan),
    ).toThrow();
    expect(() =>
      buildUnadmittedToggleCandidateStudyDraft(
        { ...candidate, approvalStatus: "APPROVED", marketId: "US_EQUITIES" },
        plan,
      ),
    ).toThrow("STUDY_CANDIDATE_MARKET_MISMATCH");
    expect(() =>
      buildUnadmittedToggleCandidateStudyDraft(
        {
          ...candidate,
          approvalStatus: "APPROVED",
          parameters: { ...candidate.parameters, scoreCutoff: 50 },
        },
        plan,
      ),
    ).toThrow("STUDY_CANDIDATE_IDENTITY_MISMATCH");
    const mismatchedStage = studyPlan();
    for (const stage of Object.values(mismatchedStage.inputs)) {
      stage.baseline.parameters.retestVolumeContractionEnabled = 0;
      stage.challenger.parameters.retestVolumeContractionEnabled = 1;
    }
    mismatchedStage.inputs.VALIDATION.challenger.parameters.scoreCutoff = 5;
    expect(() =>
      buildUnadmittedToggleCandidateStudyDraft(
        { ...candidate, approvalStatus: "APPROVED" },
        mismatchedStage,
      ),
    ).toThrow("STUDY_CANDIDATE_PROFILE_STAGE_MISMATCH");

    const persistedProfiles = [
      {
        id: plan.baselineProfileConfigId,
        marketId: "CA_TSX",
        strategy: "ORB_RETEST",
        parameters: {
          ...adapted.inputs.TRAIN.baseline.parameters,
          scoreCutoff: 5,
        },
      },
      {
        id: plan.challengerProfileConfigId,
        marketId: "CA_TSX",
        strategy: "ORB_RETEST",
        parameters: {
          ...adapted.inputs.TRAIN.challenger.parameters,
          scoreCutoff: 5,
        },
      },
    ];
    expect(() => assertStudyProfileScope(adapted, persistedProfiles)).toThrow(
      "STUDY_PROFILE_CONFIG_MISMATCH",
    );
    expect(() =>
      assertStudyProfileScope(
        adapted,
        persistedProfiles.filter(
          (profile) => profile.id !== adapted.challengerProfileConfigId,
        ),
      ),
    ).toThrow("STUDY_PROFILE_CONFIG_NOT_FOUND");
  });

  it("admits a numeric candidate only against its exact inactive profile config and matching strategy version", () => {
    const candidate = enumerateBoundedRuleCandidates({
      ...searchSpace,
      dimensions: [{ key: "scoreCutoff", values: [10] }],
      maxCandidates: 1,
    })[0]!;
    const plan = studyPlan();
    plan.variant = "NUMERIC_PARAMETER";
    for (const stage of Object.values(plan.inputs)) {
      stage.baseline.parameters.scoreCutoff = candidate.changes[0]!.from;
      stage.challenger.parameters = candidate.parameters;
    }
    const result = buildUnadmittedToggleCandidateStudyDraft(
      { ...candidate, approvalStatus: "APPROVED" },
      plan,
    );
    expect(result.state).toBe("READY_UNADMITTED");
    if (result.state !== "READY_UNADMITTED") return;
    const profiles = [
      {
        id: plan.baselineProfileConfigId,
        profileId: "10000000-0000-4000-8000-000000000201",
        marketId: "CA_TSX",
        strategy: "ORB_RETEST",
        strategyVersion: "1.0.0",
        parameters: result.plan.inputs.TRAIN.baseline.parameters,
        isCurrent: true,
      },
      {
        id: plan.challengerProfileConfigId,
        profileId: "10000000-0000-4000-8000-000000000201",
        marketId: "CA_TSX",
        strategy: "ORB_RETEST",
        strategyVersion: "1.0.0",
        parameters: result.plan.inputs.TRAIN.challenger.parameters,
        isCurrent: false,
      },
    ];
    expect(() => assertStudyProfileScope(result.plan, profiles)).not.toThrow();
    expect(() =>
      assertStudyProfileScope(
        result.plan,
        profiles.map((profile) => ({
          ...profile,
          isCurrent: true,
        })),
      ),
    ).toThrow("STUDY_NUMERIC_CHALLENGER_CONFIG_ACTIVE");
    expect(() =>
      assertStudyProfileScope(
        result.plan,
        profiles.map((profile, index) =>
          index === 1
            ? {
                ...profile,
                parameters: { ...profile.parameters, scoreCutoff: 20 },
              }
            : profile,
        ),
      ),
    ).toThrow("STUDY_VARIANT_MISMATCH");
    expect(() =>
      assertStudyProfileScope(
        result.plan,
        profiles.map((profile, index) =>
          index === 1
            ? { ...profile, profileId: "10000000-0000-4000-8000-000000000202" }
            : profile,
        ),
      ),
    ).toThrow("STUDY_VARIANT_MISMATCH");
    expect(() =>
      assertStudyProfileScope(
        result.plan,
        profiles.map((profile, index) =>
          index === 1 ? { ...profile, strategyVersion: "2.0.0" } : profile,
        ),
      ),
    ).toThrow("STUDY_VARIANT_MISMATCH");
    expect(() =>
      assertStudyProfileScope(
        result.plan,
        profiles.map((profile) => ({
          ...profile,
          marketId: "US_EQUITIES",
        })),
      ),
    ).toThrow("STUDY_PROFILE_CONFIG_MISMATCH");
    expect(() =>
      assertStudyProfileScope(
        result.plan,
        profiles.filter(
          (profile) => profile.id !== result.plan.challengerProfileConfigId,
        ),
      ),
    ).toThrow("STUDY_PROFILE_CONFIG_NOT_FOUND");
  });
});
