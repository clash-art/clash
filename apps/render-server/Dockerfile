# Multi-stage build — runtime image excludes the monorepo's full devDeps.
# Single-stage was 2.2 GB (over CF Containers' 2 GB cap on standard plan);
# this layout aims for ~800 MB by:
#   - building in stage 1 with full deps
#   - copying only `dist/` + a prod-only node_modules into stage 2
#   - using `pnpm deploy` to flatten workspace deps so we don't need to
#     ship the rest of the monorepo
#
# Mirrors are overridable via build args for slow / region-specific networks.

# ── Stage 1: build ──────────────────────────────────────────────────────

FROM node:24-slim AS builder
ARG NPM_REGISTRY=https://registry.npmjs.org/

# git: `pnpm deploy` re-resolves git-hosted dependencies (the root workspace
# depends on github:openma-ai/openma-common) with `git ls-remote`, which the
# slim image lacks. Builder stage only; the runtime image does not get git.
RUN apt-get update && \
    apt-get install -y --no-install-recommends git ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Workspace topology so pnpm can resolve the deps graph.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY packages/shared-layout/package.json packages/shared-layout/
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/remotion-core/package.json packages/remotion-core/
COPY packages/remotion-effects/package.json packages/remotion-effects/
COPY packages/remotion-components/package.json packages/remotion-components/
# Telemetry (bundled into dist by tsup) and the workspace packages it builds on.
COPY packages/shared-telemetry/package.json packages/shared-telemetry/
COPY packages/shared-runtime/package.json packages/shared-runtime/
COPY packages/action-sdk/package.json packages/action-sdk/
COPY packages/asset-sdk/package.json packages/asset-sdk/
COPY apps/render-server/package.json apps/render-server/

# Bootstrap pnpm via corepack against the configured mirror.
RUN COREPACK_NPM_REGISTRY="$NPM_REGISTRY" corepack enable && \
    pnpm config set registry "$NPM_REGISTRY" && \
    pnpm install --frozen-lockfile --filter . --filter @clash/render-server...

# Source.
COPY packages/shared-layout/ packages/shared-layout/
COPY packages/shared-types/ packages/shared-types/
COPY packages/remotion-core/ packages/remotion-core/
COPY packages/remotion-effects/ packages/remotion-effects/
COPY packages/remotion-components/ packages/remotion-components/
COPY packages/shared-telemetry/ packages/shared-telemetry/
COPY packages/shared-runtime/ packages/shared-runtime/
COPY packages/action-sdk/ packages/action-sdk/
COPY packages/asset-sdk/ packages/asset-sdk/
COPY apps/render-server/ apps/render-server/

RUN pnpm build:package @clash/render-server

# pnpm deploy: copies only prod deps + the workspace deps the target needs,
# inlined into a self-contained tree at /tmp/deploy that we can copy as-is.
RUN pnpm deploy --filter @clash/render-server --prod --legacy /tmp/deploy

# ── Stage 2: runtime ────────────────────────────────────────────────────

FROM node:24-slim AS runtime
ARG DEBIAN_MIRROR=

# Optional Debian mirror for slow networks.
RUN if [ -n "$DEBIAN_MIRROR" ]; then \
      sed -i "s|deb.debian.org|${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources; \
    fi

# Chromium for Remotion + CJK fonts for international captions.
RUN apt-get update && \
    apt-get install -y --no-install-recommends chromium fonts-noto-cjk && \
    rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV NODE_ENV=production

WORKDIR /app

# Self-contained deployment from stage 1: dist/, package.json, prod-only
# node_modules with workspace deps already inlined.
COPY --from=builder /tmp/deploy/ /app/

# Package-owned Remotion webpack bundle from stage 1 (see prebundle.ts).
# Runtime resolves ../.remotion-bundle from dist/index.js.
COPY --from=builder /app/apps/render-server/.remotion-bundle /app/.remotion-bundle

EXPOSE 8080
# OpenTelemetry loads first so node:http and fetch are instrumented. Export
# uses the standard OTEL_* environment; OTEL_SDK_DISABLED=true turns it off.
CMD ["node", "--import", "./dist/telemetry.js", "dist/index.js"]
