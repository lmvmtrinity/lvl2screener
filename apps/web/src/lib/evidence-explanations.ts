export const evidenceExplanations = {
  "Verified coverage":
    "Required members, sessions and benchmarks passed the declared input checks. This does not prove the strategy is profitable.",
  "Unknown coverage":
    "The retained evidence cannot establish what should have been observed or when it was available.",
  "No opportunities":
    "The verified observation window produced no eligible setups. Missing data is reported separately.",
  "Closed QUOTE outcomes":
    "Completed simulated outcomes using captured quote execution. These are not broker fills.",
  "Qualified rows":
    "Rows retained after the configured scope, chronology and research checks. Raw observations are a different count.",
  "Counts met":
    "The initial count threshold is met. Other qualification checks can still prevent training.",
  "Excluded rows":
    "Rows omitted from this dataset, with recorded reasons such as overlapping labels or incompatible evidence.",
  "Inactive challenger":
    "A trained candidate being evaluated separately. It has not replaced the deterministic baseline.",
  "Timely prediction":
    "The prediction was recorded before its original deadline using the frozen model and observation input.",
  "Missed deadline":
    "No valid prediction was recorded in time. A later prediction cannot repair this prospective result.",
  "Brier score":
    "Average squared probability error on the displayed timely, closed outcomes. Lower is better on the same population; it is not a return measure.",
  "Paired interval":
    "Uncertainty in challenger-minus-baseline performance on aligned covered sessions, using the displayed method and settings.",
  "Closed-outcome drawdown":
    "Peak-to-trough decline in chronological closed outcomes. This is not a funded-account equity curve.",
  "Waiting for evidence":
    "The automatic check ran, but the declared prerequisites are not met. Collection continues under the existing policy.",
  "No new evidence":
    "The check completed without finding a new qualifying input set. No duplicate job was created.",
  "Replenishment unverified":
    "Later snapshots provided modeled capacity, but the observations do not prove how exchange liquidity replenished.",
  "Sampled excursion":
    "The observed price movement within the supported holding interval. Gaps and unobserved extrema are not reconstructed.",
  "Evidence available at":
    "The earliest retained time this evidence could support a decision. Its chart origin may be earlier.",
} as const;

export type EvidenceExplanationKey = keyof typeof evidenceExplanations;

export function evidenceExplanation(key: EvidenceExplanationKey): string {
  return evidenceExplanations[key];
}
