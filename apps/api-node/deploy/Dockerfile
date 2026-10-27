# api-node image for every gateway-node role (#374): api, worker, admin and
# the one-shot migrate job run the same image with a different command.
# Build context is the monorepo root:
#   docker build -f apps/api-node/deploy/Dockerfile .
# compose.yaml in this directory builds it for you.
#
# Same layout as apps/render-server/Dockerfile: build the workspace
# dependencies' dist in stage 1, then `pnpm deploy` a prod-only tree.
# api-node itself runs from source through tsx (its `start` script).

# ── Stage 1: build ──────────────────────────────────────────────────────

FROM node:24-slim AS builder
ARG NPM_REGISTRY=https://registry.npmjs.org/

# git: `pnpm deploy` re-resolves git-hosted lockfile dependencies.
RUN apt-get update && \
    apt-get install -y --no-install-recommends git ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .

# --filter-prod: only the runtime dependency graph, so devDependencies such as
# @clash/local-api are neither installed nor built.
RUN COREPACK_NPM_REGISTRY="$NPM_REGISTRY" corepack enable && \
    pnpm config set registry "$NPM_REGISTRY" && \
    pnpm install --frozen-lockfile --filter . --filter-prod "@clash/api-node..."

# Workspace packages export dist/; api-node has no build of its own.
RUN pnpm --filter-prod "@clash/api-node^..." run build
RUN pnpm deploy --filter @clash/api-node --prod --legacy /tmp/deploy

# ── Stage 2: runtime ────────────────────────────────────────────────────

FROM node:24-slim AS runtime
ENV NODE_ENV=production

# Keep the repository layout: timeline-definition.ts reads the bundled
# Timeline plugin at ../../../plugins/remotion/ relative to src/.
WORKDIR /srv/apps/api-node
COPY --from=builder /tmp/deploy/ /srv/apps/api-node/
COPY --from=builder /app/plugins/remotion/manifest.json /srv/plugins/remotion/manifest.json
COPY --from=builder /app/plugins/remotion/generators/timeline.json /srv/plugins/remotion/generators/timeline.json

# Blob directories (CLOUD_ASSET_DIR / CLOUD_CONTENT_DIR); compose mounts one
# shared volume here for every node.
RUN mkdir -p /data/assets /data/content && chown -R node:node /data
USER node

EXPOSE 8080
# Default: the api role. compose.yaml overrides the command per role.
CMD ["node_modules/.bin/tsx", "--tsconfig", "tsconfig.json", "--import", "./src/telemetry.ts", "src/server.ts"]
