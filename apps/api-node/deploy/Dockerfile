# syntax=docker/dockerfile:1.7
#
# gateway-node multi-stage image (#373): one image, GATEWAY_ROLE selects
# api | admin | all | migrate. No gateway `worker` role and no BullMQ/Redis
# sidecar in this matrix (outbox worker is a separate process/command).
#
# Build (monorepo root):
#   docker build -f apps/api-node/deploy/Dockerfile .
# compose.yaml in this directory builds it for you.
#
# Layout: same as apps/render-server/Dockerfile — build workspace deps' dist
# in stage 1, then `pnpm deploy --prod` a runtime tree. **Deliberate tsx ship:**
# api-node itself has no `build`/`dist` yet; the start path runs source through
# tsx (package `start` script). Documented here so operators do not expect a
# compiled JS entry. A future production build can replace the CMD without
# changing GATEWAY_ROLE.
#
# Hardening: non-root `node`, tini as PID 1, HEALTHCHECK /healthz, base image
# pinned by digest, no secrets in layers (compose injects them at run time).
# Compose sets `read_only: true` + tmpfs for /tmp (and keeps /data on a volume).

# Pin node:24-slim (bookworm) multi-arch index; bump deliberately.
ARG NODE_IMAGE=node:24-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205

# ── Stage 1: build ──────────────────────────────────────────────────────

FROM ${NODE_IMAGE} AS builder
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

# Workspace packages export dist/; api-node has no build of its own (tsx ship).
RUN pnpm --filter-prod "@clash/api-node^..." run build
RUN pnpm deploy --filter @clash/api-node --prod --legacy /tmp/deploy

# ── Stage 2: runtime ────────────────────────────────────────────────────

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    # Writable under read-only rootfs (compose tmpfs /tmp).
    TMPDIR=/tmp \
    HOME=/tmp

# tini: forward signals to the drain handler and reap zombies when not using
# compose `init: true` (k8s / bare docker run).
RUN apt-get update && \
    apt-get install -y --no-install-recommends tini && \
    rm -rf /var/lib/apt/lists/*

# Keep the repository layout: timeline-definition.ts reads the bundled
# Timeline plugin at ../../../plugins/remotion/ relative to src/.
WORKDIR /srv/apps/api-node
COPY --from=builder /tmp/deploy/ /srv/apps/api-node/
COPY --from=builder /app/plugins/remotion/manifest.json /srv/plugins/remotion/manifest.json
COPY --from=builder /app/plugins/remotion/generators/timeline.json /srv/plugins/remotion/generators/timeline.json
COPY apps/api-node/deploy/entrypoint.sh /usr/local/bin/gateway-entrypoint
# Placeholder console so GATEWAY_ROLE=admin|all can boot; replace by mounting a
# real `pnpm --filter @clash/web build` output at GATEWAY_ADMIN_WEB_DIR (#372).
RUN chmod 755 /usr/local/bin/gateway-entrypoint && \
    mkdir -p /data/assets /data/content /srv/apps/web/dist/client && \
    printf '%s\n' \
      '<!doctype html><meta charset=utf-8><title>Clash admin</title>' \
      '<p>Mount a built apps/web/dist/client at GATEWAY_ADMIN_WEB_DIR (#372).</p>' \
      > /srv/apps/web/dist/client/index.html && \
    chown -R node:node /data /srv/apps/api-node /srv/apps/web

USER node

# Public data-plane / healthz (PORT). Admin listener is GATEWAY_ADMIN_PORT.
EXPOSE 8080
ENV GATEWAY_ROLE=api \
    PORT=8080 \
    HOST=0.0.0.0 \
    GATEWAY_ADMIN_WEB_DIR=/srv/apps/web/dist/client

# Liveness only; readiness is GET /readyz (compose / LB).
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/gateway-entrypoint"]
# Default: api role via entrypoint (GATEWAY_ROLE). Override command for the
# outbox worker / mock-upstream; set GATEWAY_ROLE=migrate|admin|all for those.
CMD []
