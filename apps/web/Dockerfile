FROM node:22.23.2-alpine AS build

RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY contracts/package.json contracts/package.json
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile --filter @tsx-scanner/web...

COPY contracts contracts
COPY apps/web apps/web
RUN pnpm --filter @tsx-scanner/contracts build && pnpm --filter @tsx-scanner/web build

# W5: the unprivileged nginx image runs entirely as a non-root user (no capability needed to bind
# its default port) instead of the official image's root-master/nginx-worker split, so this
# container can run with `cap_drop: [ALL]` and a read-only root filesystem (see docker-compose.yml).
FROM nginxinc/nginx-unprivileged:1.29-alpine
# Pick up Alpine security patches published since the base image was cut. The unprivileged image
# already runs as the `nginx` user, so step up to root for the upgrade and step straight back --
# the final image still runs unprivileged.
USER root
RUN apk upgrade --no-cache
USER nginx

COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY apps/web/security-headers.conf /etc/nginx/security-headers.conf
COPY apps/web/security-headers.remote.conf /etc/nginx/security-headers.remote.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html

EXPOSE 8080
