import {
  fundedHistoricalAutomationPolicyListSchema,
  type BacktestAutomationWork,
  type FundedHistoricalAutomationPolicy,
} from "@tsx-scanner/contracts";
import { useCallback, useEffect, useState } from "react";
import { getJson, sendJson } from "../lib/api.js";
import { classes } from "../lib/classes.js";

const AUTOMATION_STATE_BASE =
  "tw:inline-block tw:rounded-full tw:border tw:px-[7px] tw:py-[3px] tw:font-mono tw:text-[0.62rem] tw:font-bold tw:tracking-[0.05em]";
const AUTOMATION_STATE_TONES: Record<string, string> = {
  ok: "tw:border-[rgba(34,197,94,0.3)] tw:bg-[rgba(34,197,94,0.15)] tw:text-[#4ade80]",
  warn: "tw:border-line-warn tw:bg-surface-warn tw:text-warn-soft",
};

const POLICY_LABEL =
  "tw:flex tw:flex-col tw:gap-[3px] tw:font-mono tw:text-[0.65rem] tw:text-ink-350";
const POLICY_CONTROL =
  "tw:rounded-[6px] tw:border tw:border-line tw:bg-surface tw:px-[7px] tw:py-[5px] tw:font-mono tw:text-[0.72rem] tw:text-inherit";

function scopeLabel(
  policy: FundedHistoricalAutomationPolicy,
  works: BacktestAutomationWork[],
): string {
  const match = works.find((work) => work.configId === policy.scope.configId);
  return match?.configName
    ? `${match.configName} · ${policy.scope.configVersion}`
    : policy.scope.configVersion;
}

function policyState(
  policy: FundedHistoricalAutomationPolicy,
  now: number,
): "ACTIVE" | "EXPIRED" | "REVOKED" {
  if (policy.revokedAt) return "REVOKED";
  if (Date.parse(policy.expiresAt) <= now) return "EXPIRED";
  return "ACTIVE";
}

function PolicyRow({
  policy,
  works,
  onRevoked,
}: {
  policy: FundedHistoricalAutomationPolicy;
  works: BacktestAutomationWork[];
  onRevoked: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [revokedBy, setRevokedBy] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const state = policyState(policy, Date.now());
  const revoke = async () => {
    try {
      await sendJson(
        `/api/funded-historical-policies/${policy.policyId}/revoke`,
        "POST",
        { revokedBy, reason },
      );
      setOpen(false);
      onRevoked();
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "Unable to revoke policy",
      );
    }
  };
  return (
    <div className="funded-policy-row tw:grid tw:grid-cols-[1fr_auto_auto] tw:items-center tw:gap-[10px] tw:rounded-[8px] tw:border tw:border-line tw:bg-surface tw:px-3 tw:py-[10px] tw:below-900:grid-cols-[1fr_auto]">
      <div>
        <strong>{scopeLabel(policy, works)}</strong>
        <small className="tw:mt-[3px] tw:block tw:font-mono tw:text-[0.65rem] tw:text-ink-350">
          {policy.marketId} · max {policy.maxSessions} sessions · expires{" "}
          {new Date(policy.expiresAt).toLocaleDateString()} · approved by{" "}
          {policy.approvedBy}
        </small>
      </div>
      <span
        className={classes(
          "automation-state",
          AUTOMATION_STATE_BASE,
          state === "ACTIVE"
            ? AUTOMATION_STATE_TONES.ok
            : AUTOMATION_STATE_TONES.warn,
        )}
      >
        {state}
      </span>
      {state === "ACTIVE" &&
        (open ? (
          <div className="funded-policy-revoke tw:col-span-full tw:flex tw:flex-wrap tw:items-end tw:gap-2">
            <label className={POLICY_LABEL}>
              Revoked by
              <input
                className={POLICY_CONTROL}
                value={revokedBy}
                maxLength={120}
                onChange={(event) => setRevokedBy(event.target.value)}
              />
            </label>
            <label className={POLICY_LABEL}>
              Reason
              <input
                className={POLICY_CONTROL}
                value={reason}
                maxLength={400}
                onChange={(event) => setReason(event.target.value)}
              />
            </label>
            <button
              type="button"
              disabled={revokedBy.trim().length < 2 || reason.trim().length < 4}
              onClick={() => void revoke()}
            >
              CONFIRM REVOKE
            </button>
            <button type="button" onClick={() => setOpen(false)}>
              CANCEL
            </button>
            {error && <span className="error-banner">{error}</span>}
          </div>
        ) : (
          <button type="button" onClick={() => setOpen(true)}>
            REVOKE
          </button>
        ))}
    </div>
  );
}

/**
 * A3 approval surface. Approving is the explicit policy decision: it records
 * the scope, session bound, expiry and approver, and only then can the worker
 * dispatch a funded replay for that configuration. Revocation is immediate.
 */
export function FundedReplayPolicyPanel({
  marketId = "CA_TSX",
  works,
  onChanged,
}: {
  marketId?: "CA_TSX" | "US_EQUITIES";
  works: BacktestAutomationWork[];
  onChanged?: () => void;
}) {
  const [policies, setPolicies] = useState<FundedHistoricalAutomationPolicy[]>(
    [],
  );
  const [error, setError] = useState("");
  const [configId, setConfigId] = useState("");
  const [maxSessions, setMaxSessions] = useState("5");
  const [expiresAt, setExpiresAt] = useState("");
  const [approvedBy, setApprovedBy] = useState("");
  const [approvalNote, setApprovalNote] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const parsed = fundedHistoricalAutomationPolicyListSchema.parse(
        await getJson(
          `/api/funded-historical-policies?marketId=${encodeURIComponent(marketId)}`,
        ),
      );
      setPolicies(parsed.policies);
      setError("");
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "Unable to load policies",
      );
    }
  }, [marketId]);

  useEffect(() => {
    void load();
  }, [load]);

  const approve = async () => {
    const work = works.find((entry) => entry.configId === configId);
    if (!work || !work.runId) {
      setError("Select a configuration with a completed baseline replay");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await sendJson("/api/funded-historical-policies", "POST", {
        marketId,
        scope: {
          kind: "PROFILE_CONFIG",
          configId: work.configId,
          configVersion: work.configVersion,
        },
        maxSessions: Number(maxSessions),
        approvedBy,
        approvalNote,
        expiresAt: new Date(expiresAt).toISOString(),
      });
      setApprovedBy("");
      setApprovalNote("");
      await load();
      onChanged?.();
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "Unable to approve policy",
      );
    } finally {
      setSaving(false);
    }
  };

  const completed = works.filter((work) => work.state === "SUCCEEDED");
  const canApprove =
    Boolean(configId) &&
    Number.isInteger(Number(maxSessions)) &&
    Number(maxSessions) >= 1 &&
    approvedBy.trim().length >= 2 &&
    approvalNote.trim().length >= 4 &&
    expiresAt.length > 0;

  return (
    <section
      className="automation-funded-policy tw:text-[0.76rem]"
      aria-label="Funded replay policy"
    >
      <strong>Funded replay policy</strong>
      <p className="automation-stages-note tw:mx-0 tw:mt-0 tw:mb-[10px] tw:text-[0.74rem] tw:leading-[1.5] tw:text-ink-300">
        Automatic simulated order and ledger writes require an explicit, bounded
        approval for one configuration and a dedicated replay account. Live
        funded accounts and promotion remain out of scope.
      </p>
      {error && <p className="error-banner">{error}</p>}
      {policies.length ? (
        <div className="funded-policy-list tw:mb-[10px] tw:flex tw:flex-col tw:gap-2">
          {policies.map((policy) => (
            <PolicyRow
              key={policy.policyId}
              policy={policy}
              works={works}
              onRevoked={() => void load()}
            />
          ))}
        </div>
      ) : (
        <p className="empty tw:mx-0 tw:mt-0 tw:mb-[10px] tw:text-[0.74rem] tw:leading-[1.5] tw:text-ink-300">
          No funded replay policy is approved.
        </p>
      )}
      <div className="funded-policy-form tw:flex tw:flex-wrap tw:items-end tw:gap-[10px]">
        <label className={POLICY_LABEL}>
          Configuration
          <select
            className={POLICY_CONTROL}
            value={configId}
            onChange={(event) => setConfigId(event.target.value)}
          >
            <option value="">Select a completed configuration…</option>
            {completed.map((work) => (
              <option key={work.workKey} value={work.configId}>
                {work.configName ?? work.configVersion}
              </option>
            ))}
          </select>
        </label>
        <label className={POLICY_LABEL}>
          Max sessions
          <input
            className={POLICY_CONTROL}
            type="number"
            min={1}
            max={60}
            value={maxSessions}
            onChange={(event) => setMaxSessions(event.target.value)}
          />
        </label>
        <label className={POLICY_LABEL}>
          Expires
          <input
            className={POLICY_CONTROL}
            type="datetime-local"
            value={expiresAt}
            onChange={(event) => setExpiresAt(event.target.value)}
          />
        </label>
        <label className={POLICY_LABEL}>
          Approved by
          <input
            className={POLICY_CONTROL}
            value={approvedBy}
            maxLength={120}
            onChange={(event) => setApprovedBy(event.target.value)}
          />
        </label>
        <label
          className={classes(
            "funded-policy-note",
            POLICY_LABEL,
            "tw:flex-[1_1_220px]",
          )}
        >
          Approval note
          <input
            className={POLICY_CONTROL}
            value={approvalNote}
            maxLength={400}
            onChange={(event) => setApprovalNote(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="refresh-automation tw:cursor-pointer tw:rounded-[7px] tw:border tw:border-accent tw:bg-accent tw:px-[13px] tw:py-[10px] tw:font-mono tw:text-[0.63rem] tw:font-[750] tw:tracking-[0.07em] tw:text-on-accent tw:disabled:cursor-wait tw:disabled:opacity-50"
          disabled={!canApprove || saving}
          onClick={() => void approve()}
        >
          {saving ? "APPROVING…" : "APPROVE POLICY"}
        </button>
      </div>
    </section>
  );
}
