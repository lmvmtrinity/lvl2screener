# TSX and US Equities Intraday Scanner

> This project is for research and educational use. It is not financial advice.
> It evaluates market data and simulates paper execution; it does not submit
> live broker orders. Trading involves risk, and simulated results do not
> guarantee future performance.

A human-in-the-loop intraday scanner for Canadian and US equities. Questrade
supplies market data, deterministic strategies identify candidates, and the
operator retains control of every real trading decision.

The system is intentionally allowed to return zero opportunities. Canadian and
US markets, currencies, accounts, runtimes, and learning evidence remain
isolated. Automated execution in this codebase is paper simulation only.

## Requirements

- Node.js 22+
- pnpm 10+
- Python 3.12+
- Docker Desktop or another Docker Compose environment for the complete stack

## Quick start

Copy `.env.example` to an ignored `.env`, review the development defaults, then
start the complete mock-data stack:

```bash
docker compose up --build
```

Open `http://localhost:5173`.

For host-side development:

```bash
pnpm install --frozen-lockfile
python -m venv .venv
# Activate the virtual environment, then:
python -m pip install -e "services/scanner[dev]"
pnpm build
pnpm test
pnpm typecheck
```

Live market-data access requires your own provider authorization and local
secrets. Never commit tokens, keys, local environment files, database exports,
or captured market data.

## Documentation

- [Architecture decision records](docs/adr/README.md)
- [Baseline product and architecture](docs/baseline/README.md)
- [Operations](docs/operations/README.md)

## Public release mirror

Development and acceptance occur in a private canonical repository. This
repository receives reviewed, sanitized version releases with independent
public history. Public contributions are reproduced and tested through the
canonical workflow before appearing in a later release.

## License

Licensed under the [MIT License](LICENSE).
