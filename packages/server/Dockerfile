# syntax=docker/dockerfile:1
# Build from the repository root:
#   docker build -f packages/server/Dockerfile -t server .
FROM node:24-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Run pnpm once so Corepack downloads the version matching `devEngines`, including
# its native binary, into this layer. `corepack install` alone skips the binary.
RUN corepack enable pnpm && pnpm --version

FROM base AS deploy-env
COPY packages/server/package.json packages/server/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
  pnpm install --frozen-lockfile --prod
COPY packages/server packages/server
# A self-contained copy of the package (its `files`) with only its production dependencies. There is
# no build step: Node.js runs the TypeScript source directly.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
  pnpm --filter @repo/server deploy --prod /out

FROM node:24-alpine AS runner
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deploy-env /out ./
USER node
# Run node directly so it receives SIGTERM from `docker stop` and shuts down gracefully.
CMD ["node", "server.ts"]
