import asyncio

from httpx import ASGITransport, AsyncClient, Response

from app.config import ScannerConfig
from app.main import create_app


def call(path: str, *, method: str = "GET", token: str | None = None, service_token: str | None = "secret-token") -> Response:
    config = ScannerConfig(service_name="scanner", version="0.1.0", log_level="INFO", service_token=service_token)
    app = create_app(config)

    async def send() -> Response:
        headers = {"x-scanner-token": token} if token is not None else {}
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            if method == "GET":
                return await client.get(path, headers=headers)
            return await client.post(path, json={}, headers=headers)

    return asyncio.run(send())


def test_health_stays_open_without_a_token() -> None:
    # W5: container healthchecks call this with no credential.
    response = call("/health/ready")
    assert response.status_code == 200


def test_internal_route_rejects_missing_token() -> None:
    response = call("/internal/v1/candidates")
    assert response.status_code == 401


def test_internal_route_rejects_wrong_token() -> None:
    response = call("/internal/v1/candidates", token="wrong-token")
    assert response.status_code == 401


def test_internal_route_accepts_matching_token() -> None:
    response = call("/internal/v1/candidates", token="secret-token")
    assert response.status_code == 200


def test_internal_route_open_when_no_token_configured() -> None:
    # Local host-side scanner tests/dev runs never set SCANNER_SERVICE_TOKEN.
    response = call("/internal/v1/candidates", service_token=None)
    assert response.status_code == 200
