# W5: multi-stage build. `build` compiles TypeScript with full devDependencies (tsc, vitest
# types, etc); `prod-deps` installs only what apps/api needs at runtime; `runtime` copies just the
# compiled output, production node_modules, and the migration SQL into a minimal, non-root image.
# No test files, Playwright, TypeScript, or source ever reach the runtime image.
FROM node:22.23.2-alpine AS build

RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY contracts/package.json contracts/package.json
COPY apps/api/package.json apps/api/package.json
RUN pnpm install --frozen-lockfile --filter @tsx-scanner/api...

COPY contracts contracts
COPY apps/api apps/api
COPY database database
COPY services/scanner/app services/scanner/app
COPY services/scanner/pyproject.toml services/scanner/pyproject.toml
COPY scripts/write-research-runtime-identity.mjs scripts/write-research-runtime-identity.mjs
RUN pnpm --filter @tsx-scanner/contracts build && pnpm --filter @tsx-scanner/api build && node scripts/write-research-runtime-identity.mjs

FROM node:22.23.2-alpine AS prod-deps

RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY contracts/package.json contracts/package.json
COPY apps/api/package.json apps/api/package.json
RUN pnpm install --frozen-lockfile --filter @tsx-scanner/api... --prod

FROM node:22.23.2-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production
# Pick up Alpine security patches published since the base image was cut, and drop the bundled npm
# CLI. The runtime entrypoint is `node`, so npm/npx are never invoked here -- but Trivy still reads
# the CVEs of npm's own vendored node_modules (tar, pacote, sigstore, ...) out of the image, and
# they are not upgradeable independently of npm. Deleting the CLI removes both the finding and the
# attack surface. corepack is left alone; it is a bare shim with no vendored tree.
RUN apk upgrade --no-cache     && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
RUN addgroup -S tsxscanner && adduser -S tsxscanner -G tsxscanner

COPY --from=prod-deps --chown=tsxscanner:tsxscanner /app/node_modules ./node_modules
COPY --from=prod-deps --chown=tsxscanner:tsxscanner /app/contracts/node_modules ./contracts/node_modules
COPY --from=prod-deps --chown=tsxscanner:tsxscanner /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build --chown=tsxscanner:tsxscanner /app/contracts/dist ./contracts/dist
COPY --from=build --chown=tsxscanner:tsxscanner /app/contracts/package.json ./contracts/package.json
COPY --from=build --chown=tsxscanner:tsxscanner /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=tsxscanner:tsxscanner /app/apps/api/package.json ./apps/api/package.json
COPY --from=build --chown=tsxscanner:tsxscanner /app/database ./database

COPY --from=build --chown=tsxscanner:tsxscanner /app/apps/api/research-runtime.json ./apps/api/research-runtime.json

USER tsxscanner
EXPOSE 3000

CMD ["node", "apps/api/dist/index.js"]
