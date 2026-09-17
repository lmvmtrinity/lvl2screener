# Paper-bot deployment acceptance

Run the repository preflight from the workspace root before commissioning a
funded paper account:

```powershell
pnpm verify:paper-bot
```

The preflight resolves the default Compose configuration and verifies that:

- funded account identities and immutable funding controls are owned by the API
  process; the worker cannot accidentally start market-data funded processing;
- funded account identities are blank by default;
- migrations are present through migration 111 (105 was reserved but never created), including the durable fact,
  research-qualification, observability, provenance, temporal-reporting,
  formation-evidence, coordination model-fact, discovery, funded lookup indexes,
  research coverage/lineage, evidence-automation receipts and inactive
  challenger observation evidence, direct study grants, persisted replay sessions,
  immutable owner bindings, coverage result ownership, TradingView discovery parity audit,
  and parity audit market binding;
- the four funded operational alerts, both explicit market scrapes, and the
  Alertmanager receiver placeholder are present;
- both discovery schedulers and intake workers remain disabled, and the
  discovery route still rejects `AUTO_ADD` pending market-specific commissioning;
- the market-boundary and Compose trust-boundary checks pass.

The command is read-only. It does not migrate a database, start containers,
contact a broker, or send an alert. A passing result is a repository/deployment
contract check, not proof that credentials, retained production feed coverage,
receiver delivery, or deployment hardware have been accepted.

## Funded snapshot maintenance

Funded account events remain in `paper_funded_event` for audit and exact retry
detection. The duplicated event list in the account JSON snapshot can be
compacted after reviewing the account report:

```powershell
pnpm --filter @tsx-scanner/api paper-evidence funded-compact <account-uuid> --retain-events=32
pnpm --filter @tsx-scanner/api paper-evidence funded-compact <account-uuid> --retain-events=32 --apply
```

The first command is a preview. The apply command locks the account row and
updates only the snapshot copy; it does not delete durable event rows or alter
funding, positions, reservations, or ledger timestamps. Retries remain
idempotent after compaction because the repository checks the durable event
table before applying a ledger event.

## External commissioning gates

After the local preflight, deployment ownership must still confirm:

1. the selected live feed has retained quote/candle coverage and actionable
   share-sized quote units for the replay interval;
2. funded account identity, currency, immutable initial cash, and daily-loss
   limits match the approved configuration;
3. the approved Alertmanager notification route accepts both firing and resolved
   notifications, and the recipient confirms delivery (the deployed SMTP email
   route completed this check September 9; see the monitoring runbook);
4. representative peak-load measurements on deployment hardware meet the
   agreed persistence and lock budgets.

Do not enable a funded identity or treat the paper evidence as qualified until
those checks are recorded against the deployed revision.

Inactive challenger observation is a separate observation-only workflow. Migration
095 records database-clock capture times and immutable experiment transitions,
attempts and outcomes. Registration and START/PAUSE/RESUME/END/REVOKE are explicit
API actions; the Learning view is read-only. A passing preflight does not enroll an
experiment, activate a model, or establish prospective evidence.
