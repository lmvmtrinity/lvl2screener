# Isolated persistence benchmark

Use `pnpm benchmark:persistence` with PERSISTENCE_TEST_DATABASE_URL pointing to a disposable database named tsx_scanner_test (or tsx_scanner_test_*). Never use an application database. The wrapper requires explicit configuration and runs only the persistence fixture, without file-level parallel test contention. Defaults are 200 symbols and 20 cycles; BENCHMARK_SYMBOLS accepts 4–2000, BENCHMARK_CYCLES accepts 5–100. Large probes remain subject to the fixture timeout rather than silently relaxing it.

Set BENCHMARK_NOTES to describe other services, market/session conditions, disk and host restrictions. Output includes CPU, logical CPUs, memory, OS, revision/worktree state, running containers, per-cycle durations and per-entity latency. Redirect stdout to an artifact when retaining complete samples. URLs and credentials are not included in the wrapper metadata. Do not run multiple instances against the same test database: fixtures use reserved identifiers and clean up their rows.

## Validation guidance

Capture representative peak-service load, database wait events, locks, I/O latency and statement execution plans for strategy-result writes. Repeat on intended deployment hardware. Extend the funded snapshot probe to long-running event histories and evaluate compaction before high-volume deployment. Compare identical symbol/strategy counts and input density before changing capacity limits. Do not interpret these isolated passes as production latency certification or relax the 500 ms target to hide an attributed miss.
