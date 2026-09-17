# Paper bot monitoring

Load `monitoring/paper-bot-alerts.yml` through the collector's `rule_files` setting. The optional `docker-compose.monitoring.yml` overlay supplies a pinned Prometheus/Alertmanager pair on the private Compose network; it is not enabled by default and requires an explicitly rendered receiver config. Do not expose the API, database, Prometheus or Alertmanager publicly for monitoring. The webhook receiver remains deployment-owned.

For a multi-market deployment, scrape `/metrics?marketId=CA_TSX` and `/metrics?marketId=US_EQUITIES` as separate targets. Market-scoped samples carry a `market_id` label; process-wide broker, WebSocket, persistence and retention samples remain unlabelled so they are not duplicated per market. The legacy `/metrics` URL remains an unlabelled default-market compatibility view. An unconfigured selected market returns 404 and an unsupported market id returns 400.

The rules cover stale or missing feed timestamps during active/degraded scanning, overdue recovery, completed runs with unresolved positions, unknown quote-size units, funded close-pending age, repeated funded risk vetoes, funded recovery failures, funded input coverage gaps, retention job failures and persistence p95 above 500 ms. Discovery rules additionally cover enabled-without-provider, degraded scheduler, unavailable catalog, queue age beyond the 120-second expiry boundary, deferred coverage above the explicit one-percent threshold, failed runs and cycle/queue p95 above the 120-second commissioning budget. Discovery rules require a non-OFF market mode and carry the explicit `market_id` label, so the default OFF posture does not page and CA/US state cannot be conflated. Rules use their configured `for` windows; closed-market feed staleness is suppressed. Alert annotations describe the investigation and explicitly prohibit manufacturing fills to clear unresolved states.

Interpret persistence alerts using all three process-wide, per-entity metrics: `scanner_persistence_p95_latency_ms`, `scanner_persistence_writes_total` and `scanner_persistence_last_latency_ms`. The p95 is computed from a rolling window of at most 500 bulk writes, or fewer after process start. With a small sample, p95 can equal the slowest write and remain high until later writes replace it; the alert's `for` duration observes the gauge and does not prove that new slow writes occurred throughout that interval. Check the write count and latest latency alongside p95 before concluding that database latency is sustained. These metrics are process-wide and will appear on both market scrape targets; do not interpret them as market-specific.

`monitoring/paper-bot-alerts.test.yml` exercises stale-feed firing, closed-market suppression, funded operational alerts and market-scoped discovery failure/coverage/latency alerts with promtool. `monitoring/paper-bot-critical.test.yml` covers severe backlog and persistence thresholds, persistence windows and after-hours backlog detection. CI runs both rule files using the pinned Prometheus v3.5.0 image; the rules also receive PromQL syntax validation during loading. Local validation:

```powershell
docker run --rm --entrypoint /bin/promtool --mount "type=bind,source=${PWD}\monitoring,target=/rules,readonly" --workdir /rules prom/prometheus:v3.5.0 test rules paper-bot-alerts.test.yml paper-bot-critical.test.yml
```

## Local setup without a notification receiver

For this single-user workstation, start with the local dashboards. Prometheus collects
metrics every 15 seconds and evaluates the alert rules. Alertmanager groups active alerts.
The local receiver deliberately sends no email or webhook notifications; inspect the
dashboard while external delivery is unconfigured.

From `E:\lvl2screener` in PowerShell:

```powershell
docker compose -f docker-compose.yml -f docker-compose.monitoring.yml -f docker-compose.monitoring.local.yml --profile monitoring up -d --no-deps prometheus alertmanager
```

1. Open <http://localhost:9090/targets>. Both `paper-bot-ca` and `paper-bot-us` should be UP.
2. Open <http://localhost:9090/alerts> to see pending and firing rules.
3. Open <http://localhost:9093> for grouped firing alerts. An empty dashboard is valid only
   after checking the two scrape targets; it does not by itself prove collection works.
4. In Prometheus, query `scanner_quote_age_ms`, `scanner_paper_bot_funded_pending_facts`,
   and `scanner_paper_bot_last_success_timestamp_seconds` to inspect processing progress.

These ports bind to `127.0.0.1` only. Metrics and Alertmanager state use persistent Docker
volumes. Use the same three Compose files for future monitoring updates; omit `down -v`
to preserve both application and monitoring data.

For unattended use, add email delivery using an SMTP account with an application password,
or an existing approved HTTPS webhook. Store credentials in a Git-ignored config or mounted
secret, replace the local receiver, and verify a synthetic firing and resolved notification
arrives before relying on it. The webhook workflow below is already supported by the repository.
Do not enable the dashboard-only overlay when deploying the generated webhook receiver: its
volume deliberately replaces the generated config.

The additional processing alerts detect unavailable scrape targets, independent paper cycles
that stop completing during active scanning, and old pending funded facts. A successful funded
batch timestamp means that one bounded batch completed; pending-fact count proves whether
catch-up is finished. Recovery-only instruments receive quotes without entering candidate lists.

## Email delivery for critical incidents

Use `monitoring/alertmanager.email.yml.template` and
`pnpm monitoring:render-email` for authenticated SMTP with required STARTTLS.
Configure `ALERTMANAGER_SMTP_SMARTHOST`, `ALERTMANAGER_SMTP_FROM`,
`ALERTMANAGER_SMTP_USERNAME` and `ALERTMANAGER_EMAIL_TO` in the Git-ignored
`.env.monitoring` file. Save the SMTP app password, without spaces for Gmail,
as one line in `monitoring/secrets/smtp-password`. Both that directory and the
generated email config are ignored by Git. The generated YAML references the
mounted password file rather than embedding it. Never paste credentials into chat
or commit them. Gmail requires an app password with 2-Step Verification; see
[Google's instructions](https://support.google.com/accounts/answer/185833).

After rendering, validate and enable only Alertmanager with the email overlay last:

```powershell
pnpm monitoring:render-email
docker compose -f docker-compose.yml -f docker-compose.monitoring.yml -f docker-compose.monitoring.local.yml -f docker-compose.monitoring.email.yml --profile monitoring up -d --no-deps alertmanager
```

The email route sends only `severity=critical`: scrape outages, stale/missing active
feeds, stalled paper processing, repeated funded failures and other existing
critical operational rules. Severe funded backlog means more than 1,000 pending
facts with the oldest over five minutes, sustained for two minutes, including
after-hours. Severe database latency means persistence p95 over two seconds for
five minutes. These are notification thresholds, not changes to trading or execution.
Warnings such as routine risk vetoes remain visible in the dashboard without email.
Emails are grouped by alert and market, initially wait 30 seconds, repeat hourly
while unresolved, and send a recovery notification. Local dashboards retain their
localhost-only bindings. Reapplying the dashboard-only overlay last disables email.

Verify an expiring synthetic critical alert through Alertmanager and SMTP acceptance,
then confirm receipt before relying on delivery. A valid config does not prove that
Gmail accepted mail. Monitoring on this workstation cannot email during a complete
workstation or outbound-network outage; that requires an external monitor.

September 9 local deployment: critical email routing was enabled with the email
overlay and the user-selected Gmail sender/recipient. Alertmanager accepted the
synthetic `MonitoringEmailTest`; its SMTP notification counter advanced to four
with zero email failures (including current critical alerts). After the test was
resolved and the normal five-minute grouping interval elapsed, the counter advanced
to five, all email failure counters remained zero and the test disappeared from
active alerts at 16:42 Eastern. Secrets remain in ignored local files. SMTP
acceptance does not itself establish inbox placement.

September 9 closure continuation: the recipient explicitly confirmed receiving
the monitoring emails. Together with the firing/resolved SMTP acceptance above,
this closes delivery acceptance for the deployed email route. This does not
establish coverage during a complete workstation or outbound-network outage.

## Optional monitoring overlay with webhook delivery

Set `ALERTMANAGER_WEBHOOK_URL` to the approved HTTPS receiver, then start only the monitoring
profile alongside the existing stack:

```powershell
$env:ALERTMANAGER_WEBHOOK_URL = 'https://<approved-receiver>/paper-bot'
pnpm monitoring:render
docker compose -f docker-compose.yml -f docker-compose.monitoring.yml --profile monitoring up -d prometheus alertmanager
```

`monitoring/prometheus.yml` scrapes the private API separately for `CA_TSX` and `US_EQUITIES`.
An unconfigured US runtime returns 404 and stays visibly unavailable rather than silently falling
back to TSX. `monitoring/alertmanager.yml.template` groups alerts by market where present and
sends both firing and resolved notifications to the generated receiver config. The render command
refuses non-HTTP(S) URLs and refuses plain HTTP unless `ALLOW_INSECURE_ALERT_WEBHOOK=true` is
explicitly set for a local test. The generated file is ignored by Git, and the overlay publishes
no host ports.

To validate Alertmanager delivery without contacting a real destination, use a separate temporary
Compose project and the test-only receiver. The short `group_wait` in the test config makes the
result deterministic:

```powershell
$testProject = 'paper-bot-monitoring-smoke'
docker compose -p $testProject -f docker-compose.yml -f docker-compose.monitoring.yml -f docker-compose.monitoring-test.yml --profile monitoring --profile monitoring-test up -d alertmanager alert-receiver
docker run --rm --network "${testProject}_default" curlimages/curl:8.12.1 -fsS -X POST http://alertmanager:9093/api/v2/alerts -H 'content-type: application/json' --data '[{"labels":{"alertname":"ReceiverSmoke","severity":"warning"},"annotations":{"summary":"receiver smoke"},"startsAt":"2026-09-06T00:00:00Z"}]'
Start-Sleep -Seconds 3
docker compose -p $testProject -f docker-compose.yml -f docker-compose.monitoring.yml -f docker-compose.monitoring-test.yml logs --no-color alert-receiver
docker compose -p $testProject -f docker-compose.yml -f docker-compose.monitoring.yml -f docker-compose.monitoring-test.yml down -v --remove-orphans
```

The receiver log must contain one `ALERT_RECEIVER_SMOKE` payload with `ReceiverSmoke`. This
validates Alertmanager-to-webhook delivery only; it does not commission the production receiver
or prove that the deployment's Prometheus scrape is healthy.

Funded metrics are emitted only when an opt-in funded account is configured. Migration 076 persists `paper_entry_order.close_pending_at`; migration 077 protects funded account and run provenance; migration 079 adds temporal reporting boundaries. The funded live adapter reports account-scoped close-pending count/age across current and recovery runs, plus veto/late-fact totals, process-lifetime recovery failures and skipped-input coverage gaps. Use the explicit `marketId` scrapes for market-scoped funded labels; the local smoke harness verifies webhook delivery, while production receiver commissioning remains required. Retention-job success is not evidence that a requested replay interval is complete. An overdue-run alert is not a count of recovery failures.
