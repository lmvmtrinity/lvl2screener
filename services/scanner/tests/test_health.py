import asyncio

from httpx import ASGITransport, AsyncClient, Response

from app.config import ScannerConfig
from app.main import create_app


def request(path: str) -> Response:
    config = ScannerConfig(service_name="scanner", version="0.1.0", log_level="INFO")
    app = create_app(config)

    async def send() -> Response:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            return await client.get(path)

    return asyncio.run(send())


def test_liveness_contract() -> None:
    response = request("/health/live")

    assert response.status_code == 200
    assert response.json()["service"] == "scanner"
    assert response.json()["status"] == "ok"


def test_readiness_confirms_configuration() -> None:
    response = request("/health/ready")

    assert response.status_code == 200
    assert response.json()["checks"] == {"config": "ok", "featureEngine": "ok"}
