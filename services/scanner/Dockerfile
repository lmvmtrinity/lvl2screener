# W5: multi-stage build. `build` resolves and installs the package (and any wheel-build
# toolchain it needs) into a venv; `runtime` copies only that venv and the application source into
# a minimal, non-root image -- pip, build tooling, and any dev extras never reach it.
FROM python:3.13-slim AS build

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# The interpreter image ships an older pip/setuptools pair than the one Trivy wants (setuptools
# <78.1.1 is CVE-2025-47273). `python -m venv` seeds the venv from those, so the venv we copy into
# the runtime image inherits them unless we upgrade first.
RUN pip install --no-cache-dir --upgrade pip setuptools

COPY services/scanner/pyproject.toml ./pyproject.toml
COPY services/scanner/app ./app
RUN pip install --no-cache-dir .

FROM python:3.13-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/opt/venv/bin:$PATH"

# Pick up Debian security patches published since the base image was cut (openssl in particular).
RUN apt-get update     && apt-get upgrade -y --no-install-recommends     && rm -rf /var/lib/apt/lists/*

RUN addgroup --system tsxscanner && adduser --system --ingroup tsxscanner tsxscanner

WORKDIR /app
COPY --from=build /opt/venv /opt/venv

# The runtime never installs anything -- it just runs uvicorn out of the venv. Dropping pip (and
# the ensurepip wheel it is restored from) removes its large vendored dependency tree, which Trivy
# reads as part of the image even though none of it is importable by the application.
RUN rm -rf /opt/venv/lib/python3.13/site-packages/pip            /opt/venv/lib/python3.13/site-packages/pip-*.dist-info            /opt/venv/bin/pip*            /usr/local/lib/python3.13/site-packages/pip            /usr/local/lib/python3.13/site-packages/pip-*.dist-info            /usr/local/lib/python3.13/ensurepip            /usr/local/bin/pip*
COPY --from=build --chown=tsxscanner:tsxscanner /app/app ./app

USER tsxscanner
EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]
