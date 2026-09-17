# Isolated persistence benchmark

Use `pnpm benchmark:persistence` with PERSISTENCE_TEST_DATABASE_URL pointing to a disposable database named tsx_scanner_test (or tsx_scanner_test_*). Never use an application database. The wrapper requires explicit configuration and runs only the persistence fixture, without file-level parallel test contention. Defaults are 200 symbols and 20 cycles; BENCHMARK_SYMBOLS accepts 4–2000, BENCHMARK_CYCLES accepts 5–100. Large probes remain subject to the fixture timeout rather than silently relaxing it.

Set BENCHMARK_NOTES to describe other services, market/session conditions, disk and host restrictions. Output includes CPU, logical CPUs, memory, OS, revision/worktree state, running containers, per-cycle durations and per-entity latency. Redirect stdout to an artifact when retaining complete samples. URLs and credentials are not included in the wrapper metadata. Do not run multiple instances against the same test database: fixtures use reserved identifiers and clean up their rows.

## September 5 local measurements

Windows 11 host (10.0.26200), Ryzen 5 5600X, 12 logical CPUs, approximately 32 GiB RAM. TimescaleDB 2.29.2/PostgreSQL 17 in an isolated container; the application web/API/worker/scanner/database containers remained running unchanged. Their running state does not prove representative peak market load.

| Probe                   | Persistence p95 | Fixture cycle p95 | Result                          |
| ----------------------- | --------------: | ----------------: | ------------------------------- |
| 200 symbols × 20 cycles |        344.0 ms |          344.2 ms | Below 500 ms persistence target |
| 400 symbols × 20 cycles |        579.3 ms |          579.6 ms | Above 500 ms persistence target |

Both passed the existing broad 2000 ms persistence regression guard. No guard was relaxed. These numbers use the fixture's existing conservative order-statistic estimator; retain the printed samples when comparing percentile conventions. The fixture cycle includes synthetic construction and persistence, not broker fetch time or Python strategy evaluation.

## September 6 final database-suite measurements

The latest clean database-enabled API run used 200 instruments × five cycles and reported 637.063628 ms persistence p95 and 637.112889 ms full-cycle p95. Persistence is above the unchanged 500 ms informational target but below the 2000 ms broad regression guard. Prior clean five-cycle runs reported 530.152140/530.534292 ms and 344.820684/344.990550 ms, demonstrating run-to-run host variability. No threshold was relaxed; these results are not a production capacity certification.

The separate funded fixture used eight concurrent account-lock operations, eight run-lock probes, and 20 sequential quote cycles. It reported account-lock p95 99.862114 ms, run-lock p95 10.220160 ms and funded-cycle p95 372.458516 ms. The resulting 48 durable event rows matched the 48 events retained in the account snapshot, whose JSONB size was 1,426 bytes. This validates the measurement path and exposes the snapshot-growth shape; it does not establish long-run compaction requirements.

The combined strategy-results transaction was the largest measured component: approximately 208 ms p95 at 200 symbols and 404 ms at 400. Its time is attributed to multiple entity counters representing one shared transaction, so those counters must not be summed as independent costs. The earlier 2.27-second parallel-suite failure does not recur in these standalone probes; resource contention is a plausible contributor, not a proven root cause. A 400-symbol workload already misses the tighter target without competing test files.

## September 6 post-hardening rerun

A fresh disposable TimescaleDB run after funded snapshot compaction and bounded
fixture startup retries measured 530.0483 ms persistence p95 and 530.3288 ms
full-cycle p95 for 200 instruments × five cycles. This remains above the
unchanged 500 ms informational target and below the 2000 ms broad regression
guard; no threshold was relaxed.

The funded fixture measured account-lock p95 74.5630 ms, run-lock p95 7.2089
ms, and funded-cycle p95 62.0312 ms. It retained 48 durable event rows while
the account snapshot copy was bounded from 48 events to eight. Physical JSONB
size is reported before/after but is not used as a monotonic assertion because
PostgreSQL compression can make a shorter, less repetitive document occupy
more bytes.

## Remaining investigation

The September 9 closure review
adds current mandatory-database acceptance, 400-symbol measurements (685.46 ms
and 681.04 ms p95), statement-level timings and analyzed plans from disposable
databases. Context writes dominate measured database time; feature-snapshot
lookups in the fresh fixture filter many rows despite an existing composite
index. Investigate statistics/access paths under representative retained history
before choosing an optimization. These measurements keep the 500 ms target open.

Capture representative peak-service load, database wait events, locks, I/O latency and statement execution plans for strategy-result writes. Repeat on intended deployment hardware. Extend the funded snapshot probe to long-running event histories and evaluate compaction before high-volume deployment. Compare identical symbol/strategy counts and input density before changing capacity limits. Do not interpret these isolated passes as production latency certification or relax the 500 ms target to hide an attributed miss.
