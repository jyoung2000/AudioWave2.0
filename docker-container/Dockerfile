# syntax=docker/dockerfile:1.7
#
# Now Playing Hub.
#
# Built from the monorepo root (the compose file sets the context), because the hub depends on the
# workspace packages. The runtime stage carries only the bundle, the migrations and the native
# modules — no source, no toolchain, no pnpm store.
#
# The image runs as a non-root user and declares no VOLUME of its own: the operator mounts /data,
# so they decide where their music and database actually live.

# ---------------------------------------------------------------- build stage
FROM node:22-bookworm-slim AS build
WORKDIR /repo

RUN corepack enable

# Manifests first, so a source-only change reuses the dependency layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/domain/package.json packages/domain/
COPY packages/audio-core/package.json packages/audio-core/
COPY packages/recommendations/package.json packages/recommendations/
COPY packages/aqua-ui/package.json packages/aqua-ui/
COPY packages/test-fixtures/package.json packages/test-fixtures/
COPY docker-container/package.json docker-container/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && \
    pnpm install --frozen-lockfile --filter @now-playing/hub... --filter @now-playing/hub

COPY packages/ packages/
COPY docker-container/ docker-container/

# Typecheck before bundling: a broken build should fail here, not at container start.
RUN pnpm --filter @now-playing/hub exec tsc -p tsconfig.json --noEmit
RUN pnpm --filter @now-playing/hub exec node scripts/build.mjs
RUN pnpm --filter @now-playing/hub exec vite build --config src/web/vite.config.ts

# Install the runtime dependencies (native modules compile here, against this exact Node).
WORKDIR /repo/docker-container/dist
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --prod --no-frozen-lockfile

# -------------------------------------------------------------- runtime stage
FROM node:22-bookworm-slim AS runtime

# Standard image labels. `nowplaying update` prunes superseded layers by the title label, so it can
# reclaim space from its own old builds without touching anything else on the machine.
LABEL org.opencontainers.image.title="Now Playing Hub" \
      org.opencontainers.image.description="Self-hosted music hub: library, group listening, pairing, sync and a Discord bot." \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="https://github.com/jyoung2000/AudioWave2.0"

# FFmpeg is optional at runtime: without it only byte-for-byte copies are possible, and the API
# says so. It is included because converting a file the user owns is a normal thing to want.
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg ca-certificates tini && \
    rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    NP_DATA_DIR=/data \
    NP_PORT=4546 \
    NP_BIND_MODE=localhost

WORKDIR /app
COPY --from=build /repo/docker-container/dist ./

# The `node` user ships with the base image; /data is created and owned before dropping to it.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 4546
VOLUME ["/data"]

# tini reaps zombies and forwards SIGTERM, so the hub's own graceful shutdown actually runs.
ENTRYPOINT ["/usr/bin/tini", "--"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.NP_PORT||4546)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
