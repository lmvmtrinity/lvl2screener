"""Read-only content identity of the actual scanner source and installed runtime."""
import hashlib
import importlib.metadata
import json
import platform
from pathlib import Path

from .feature_engine import FEATURE_VERSION


def runtime_identity() -> dict[str, object]:
    root = Path(__file__).parent
    entries = [[str(file.relative_to(root)).replace("\\", "/"), hashlib.sha256(file.read_bytes()).hexdigest()]
               for file in sorted(root.rglob("*.py")) if "__pycache__" not in file.parts]
    source_hash = hashlib.sha256(json.dumps(entries, separators=(",", ":")).encode()).hexdigest()
    packages = {distribution.metadata["Name"].lower(): distribution.version
                for distribution in importlib.metadata.distributions() if distribution.metadata["Name"]}
    return {"sourceHash": source_hash, "featureVersion": FEATURE_VERSION, "python": platform.python_version(), "packages": dict(sorted(packages.items()))}
