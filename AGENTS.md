# Agent guide

## Working approach

- Start with `git status --short` and preserve existing changes.
- Use `rg`/`rg --files` and inspect the owning layer before editing.
- Target public `main`; maintainers integrate accepted changes through the
  canonical private workflow before the next public release.
- Never infer authorization to deploy, activate trading, or change risk and
  learning-policy gates.
- TypeScript uses ESM; local imports commonly end in `.js` even in `.ts` source.
- Run checks relevant to the change and report database-backed skips as skips.

## Architecture entry points

| Area | Start here |
| --- | --- |
| API startup | `apps/api/src/index.ts` |
| HTTP routes | `apps/api/src/app.ts`, `apps/api/src/routes/` |
| Configuration | `apps/api/src/config.ts`, `.env.example`, `docker-compose.yml` |
| Market orchestration | `apps/api/src/market-data/` |
| Broker integration | `apps/api/src/questrade/` |
| Shared contracts | `contracts/src/domains/` |
| Python scanner | `services/scanner/app/` |
| Browser | `apps/web/src/App.tsx`, `apps/web/src/views/` |
| Persistence | `database/init/`, `apps/api/src/database/migrate.ts` |
| Background jobs | `apps/api/src/worker.ts`, `apps/api/src/worker/` |
| Research | `apps/api/src/backtests/`, `apps/api/src/statistical-models/` |
| Operations | `monitoring/`, `scripts/`, `docs/operations/` |

## Invariants

- Preserve `CA_TSX`/`US_EQUITIES`, account, currency, and evidence isolation.
- `ALL` is read-only aggregation and never combines CAD/USD balances.
- Automated execution is simulated paper evidence; broker decisions remain
  human-controlled.
- Learning challengers remain inactive without explicit promotion authority.
- Report tests actually run and database-backed skips as skips.

Useful verification commands include `pnpm format:check`, `pnpm lint`,
`pnpm typecheck`, `pnpm build`, `pnpm test`, and `pnpm verify:docs`.
