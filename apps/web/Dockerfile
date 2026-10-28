# syntax=docker/dockerfile:1
# Build from the repository root, so the workspace packages are in the context:
#   docker build -f apps/web/Dockerfile -t web .
FROM node:24-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Run pnpm once so Corepack downloads the version matching `devEngines`, including
# its native binary, into this layer. `corepack install` alone skips the binary.
RUN corepack enable pnpm && pnpm --version

FROM base AS build-env
# Manifests first, so the dependency layer is reused while only source changes.
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
  pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter web run build

# Only the static client build at runtime, served by nginx with the SPA fallback.
FROM nginxinc/nginx-unprivileged:stable-alpine AS runner
COPY apps/web/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --from=build-env /repo/apps/web/build/client /usr/share/nginx/html
EXPOSE 8080
