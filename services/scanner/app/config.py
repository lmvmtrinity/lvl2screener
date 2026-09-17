from dataclasses import dataclass
from importlib.metadata import PackageNotFoundError, version as installed_version
import os


@dataclass(frozen=True)
class ScannerConfig:
    service_name: str
    version: str
    log_level: str
    # W5: shared internal credential the api/worker present on every /internal/v1/* call (see
    # apps/api/src/market-data/scanner-client.ts). When unset, no check is enforced -- this keeps
    # host-side scanner tests and any local `uvicorn app.main:app` run working without extra setup.
    # docker-compose.yml always sets this (a documented local-development default in the default
    # profile; a required real secret in the remote profile).
    service_token: str | None = None


def _resolve_version() -> str:
    """Reads the running version from the installed package's own metadata
    (sourced from pyproject.toml's `[project] version`) instead of a second,
    hand-maintained literal that can silently drift from it."""
    try:
        return installed_version("tsx-scanner-engine")
    except PackageNotFoundError:
        return "0.0.0-dev"


def load_config() -> ScannerConfig:
    log_level = os.getenv("LOG_LEVEL", "info").upper()
    valid_levels = {"CRITICAL", "ERROR", "WARNING", "INFO", "DEBUG"}
    if log_level not in valid_levels:
        raise ValueError(f"Unsupported LOG_LEVEL: {log_level}")
    return ScannerConfig(
        service_name="scanner",
        version=_resolve_version(),
        log_level=log_level,
        service_token=os.getenv("SCANNER_SERVICE_TOKEN") or None,
    )
