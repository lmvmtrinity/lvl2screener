import asyncio
import re

from httpx import ASGITransport, AsyncClient

from app.config import ScannerConfig
from app.feature_engine import FEATURE_VERSION
from app.main import create_app


def test_scanner_runtime_identity_reports_actual_source_and_feature_version() -> None:
    async def request() -> None:
        app = create_app(ScannerConfig(service_name="scanner", version="test", log_level="INFO"))
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.post("/internal/v1/system/runtime-identity", json={})
            assert response.status_code == 200
            body = response.json()
            assert re.fullmatch(r"[a-f0-9]{64}", body["sourceHash"])
            assert body["featureVersion"] == FEATURE_VERSION
            assert body["packages"]["fastapi"]
            assert body == (await client.post("/internal/v1/system/runtime-identity", json={})).json()
    asyncio.run(request())
