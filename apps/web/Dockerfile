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
COPY packages/server/package.json packages/server/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
  pnpm install --frozen-lockfile
COPY . .
# SSR=false builds a SPA instead (see react-router.config.ts): docker build --build-arg SSR=false ...
ARG SSR=true
ENV SSR=$SSR
RUN pnpm --filter web run build
# A self-contained copy of the app (its `files`) with only its production dependencies, workspace
# packages included.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
  pnpm --filter web deploy --prod /out

# Plain Node.js at runtime: pnpm is only needed to install and build.
FROM node:24-alpine AS runner
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build-env /out ./
USER node
# Run node directly so it receives SIGTERM from `docker stop` and shuts down gracefully.
CMD ["node", "server.ts"]
