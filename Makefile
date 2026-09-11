.PHONY: install dev dev-desktop dev-web dev-api-cf dev-full build test lint typecheck clean format setup db-web-local check-tools help bundle remotion-bundle remotion-render deploy deploy-api deploy-web predeploy-check wrangler-whoami deploy-staging deploy-api-staging deploy-web-staging

# Use interactive shell to load .zshrc environment

#==============================================================================
# Configuration
#==============================================================================

# Proxy settings (disabled by default; set via environment or CLI if needed)
HTTP_PROXY ?=
HTTPS_PROXY ?=
NO_PROXY ?=

# Service ports (single source of truth)
# apps/web (Vite + RR7 + CF Vite plugin) is the user-facing entry point on :3000.
# It absorbed the gateway's proxy logic; there is no separate gateway worker
# anymore. /sync/*, /agents/*, signed capability /assets/*, /api/v1/*,
# /api/tasks/*, /api/describe, /api/generate/* are proxied to api-cf via the
# service binding (or API_CF_URL fallback).
WEB_PORT ?= 3000
DESKTOP_RENDERER_PORT ?= 3001
API_CF_PORT ?= 8789
RENDER_PORT ?= 8080

# Color output
BLUE := \033[0;34m
GREEN := \033[0;32m
YELLOW := \033[1;33m
RED := \033[0;31m
NC := \033[0m # No Color

#==============================================================================
# Help
#==============================================================================

help: ## Show this help message
	@echo "$(BLUE)Clash - Development Commands$(NC)"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  $(GREEN)%-20s$(NC) %s\n", $$1, $$2}'
	@echo ""
	@echo "$(YELLOW)Environment Variables:$(NC)"
	@echo "  HTTP_PROXY   - Proxy for HTTP requests (default: $(HTTP_PROXY))"
	@echo "  HTTPS_PROXY  - Proxy for HTTPS requests (default: $(HTTPS_PROXY))"
	@echo "  NO_PROXY     - Comma-separated list of bypassed hosts (default: $(NO_PROXY))"

#==============================================================================
# Prerequisites
#==============================================================================

check-tools: ## Verify required tools are installed
	@echo "$(BLUE)Checking required tools...$(NC)"
	@command -v node >/dev/null 2>&1 || { echo "$(RED)Error: Node.js not found.$(NC)"; exit 1; }
	@[ "$$(node -p 'process.versions.node.split(".")[0]')" = "24" ] || { \
		echo "$(RED)Error: Clash requires Node.js 24.x (found $$(node --version)).$(NC)"; \
		echo "$(YELLOW)Run 'nvm use' from the repository root.$(NC)"; \
		exit 1; \
	}
	@command -v pnpm >/dev/null 2>&1 || { echo "$(RED)Error: pnpm not found.$(NC)"; echo "$(YELLOW)Install: brew install pnpm$(NC)"; exit 1; }
	@echo "$(GREEN)✓ All required tools are installed$(NC)"

#==============================================================================
# Installation
#==============================================================================

install: check-tools ## Install all dependencies
	@echo "$(BLUE)Installing TypeScript dependencies...$(NC)"
	@pnpm install
	@echo "$(GREEN)✓ Installation complete$(NC)"

#==============================================================================
# Database
#==============================================================================

db-web-local: ## Setup/migrate local D1 database for web app
	@echo "$(BLUE)Setting up local D1 database for web...$(NC)"
	@cd apps/web && pnpm db:migrate:local

db-local: db-web-local ## Setup all local D1 databases

#==============================================================================
# Development Servers
#==============================================================================

dev-desktop: check-tools ## Start Electron with Desktop HMR (prefers :3001)
	@echo "$(BLUE)Starting Clash Desktop with HMR (preferred port: $(DESKTOP_RENDERER_PORT))...$(NC)"
	@CLASH_DESKTOP_RENDERER_PORT=$(DESKTOP_RENDERER_PORT) pnpm --filter @clash/desktop dev

dev-web: ## Start web app (Vite + RR7 + Cloudflare Vite plugin) on :3000
	@echo "$(BLUE)Starting web on http://localhost:$(WEB_PORT)...$(NC)"
	@HTTP_PROXY=$(HTTP_PROXY) HTTPS_PROXY=$(HTTPS_PROXY) NO_PROXY=$(NO_PROXY) \
		pnpm dev:package @clash/web

dev-api-cf: ## (Deprecated) api-cf is started by vite as an auxiliary worker
	@echo "$(YELLOW)api-cf is spawned by apps/web's vite config (auxiliaryWorkers).$(NC)"
	@echo "$(YELLOW)Running it separately will collide on ports/DO state.$(NC)"
	@echo "$(YELLOW)Use 'make dev-web' (or 'make dev') only.$(NC)"

dev-api-cf-standalone: ## Rare: run api-cf on its own for tests/debugging
	@echo "$(BLUE)Starting api-cf on http://localhost:$(API_CF_PORT)...$(NC)"
	@HTTP_PROXY=$(HTTP_PROXY) HTTPS_PROXY=$(HTTPS_PROXY) NO_PROXY=$(NO_PROXY) \
		pnpm dev:package @clash/api-cf

dev-render: ## Start render server (runs outside wrangler — ffmpeg/remotion)
	@echo "$(BLUE)Starting render server on http://localhost:$(RENDER_PORT)...$(NC)"
	@HTTP_PROXY=$(HTTP_PROXY) HTTPS_PROXY=$(HTTPS_PROXY) NO_PROXY=$(NO_PROXY) PORT=$(RENDER_PORT) \
		pnpm dev:package @clash/render-server

#==============================================================================
# Combined Development
#==============================================================================

dev: ## Start web (with api-cf as aux worker) + render-server in parallel
	@echo "$(BLUE)Starting development environment...$(NC)"
	@echo ""
	@echo "   ┌─────────────────────────────────────────────┐"
	@echo "   │  $(GREEN)Web:$(NC)     http://localhost:$(WEB_PORT)              │"
	@echo "   │  (Vite + RR7 + @cloudflare/vite-plugin)    │"
	@echo "   │  Vite also spawns api-cf as aux worker;    │"
	@echo "   │  service binding env.API_CF is wired in.    │"
	@echo "   │  ├─ /          → RR7 SPA                    │"
	@echo "   │  ├─ /sync/*    → api-cf ProjectRoom        │"
	@echo "   │  ├─ /agents/*  → api-cf SupervisorAgent    │"
	@echo "   │  ├─ /assets/*  → signed delivery transport │"
	@echo "   │  └─ /api/v1/*  → api-cf REST (auth-gated)  │"
	@echo "   │                                             │"
	@echo "   │  $(GREEN)Render:$(NC)  http://localhost:$(RENDER_PORT)              │"
	@echo "   │  (ffmpeg: thumbnails + timeline render)    │"
	@echo "   └─────────────────────────────────────────────┘"
	@echo ""
	@$(MAKE) -j2 dev-web dev-render

dev-full: dev ## Alias for dev

#==============================================================================
# Build & Test
#==============================================================================

build: check-tools ## Build all packages
	@echo "$(BLUE)Building TypeScript packages...$(NC)"
	@pnpm build

test: check-tools ## Run all tests
	@echo "$(BLUE)Running TypeScript tests...$(NC)"
	@pnpm test

test-web: ## Run frontend tests only
	@echo "$(BLUE)Running frontend tests...$(NC)"
	@pnpm test:package @clash/web

#==============================================================================
# Remotion Bundle & Render
#==============================================================================

remotion-bundle: ## Build Remotion bundle for server-side rendering
	@echo "$(BLUE)Building Remotion bundle...$(NC)"
	@cd packages/remotion-components && npx remotion bundle src/Root.tsx
	@echo "$(GREEN)✓ Bundle created at packages/remotion-components/build$(NC)"

remotion-render: ## Render video using Remotion CLI (for local testing)
	@echo "$(BLUE)Rendering video...$(NC)"
	@echo "$(YELLOW)Usage: make remotion-render PROPS='{\"tracks\":[...]}' OUTPUT=output.mp4$(NC)"
	@[ -n "$(PROPS)" ] || { echo "$(RED)Error: PROPS is required$(NC)"; exit 1; }
	@[ -n "$(OUTPUT)" ] || { echo "$(RED)Error: OUTPUT is required$(NC)"; exit 1; }
	@cd packages/remotion-components && npx remotion render src/Root.tsx VideoComposition --props='$(PROPS)' --output="$(OUTPUT)"
	@echo "$(GREEN)✓ Video rendered to $(OUTPUT)$(NC)"

bundle: remotion-bundle ## Alias for remotion-bundle

#==============================================================================
# Code Quality
#==============================================================================

lint: check-tools ## Check workspace TypeScript source and existing ESLint rules
	@echo "$(BLUE)Checking TypeScript source and ESLint...$(NC)"
	@pnpm lint

typecheck: check-tools ## Type-check workspace source without release builds
	@echo "$(BLUE)Type-checking TypeScript...$(NC)"
	@pnpm typecheck

lint-web: ## Lint frontend only
	@echo "$(BLUE)Linting frontend...$(NC)"
	@pnpm lint:package @clash/web

format: check-tools ## Format all code
	@echo "$(BLUE)Formatting TypeScript...$(NC)"
	@pnpm prettier --write "**/*.{ts,tsx,json,md}"

format-check: ## Check if code is formatted (CI use)
	@echo "$(BLUE)Checking TypeScript formatting...$(NC)"
	@pnpm prettier --check "**/*.{ts,tsx,json,md}"

#==============================================================================
# Deployment (Cloudflare Workers / Pages)
#==============================================================================
#
# What deploys where (per apps/*/wrangler.toml):
#   - api-cf      : Cloudflare Worker `clash-api`. Includes the
#                   RenderContainer DO whose image is built from
#                   apps/render-server/Dockerfile.cf during deploy. So
#                   deploying api-cf also updates the render container.
#                   render-server itself is NOT deployed standalone.
#   - web         : Cloudflare Pages/Worker `clash-web` (built by Vite +
#                   @cloudflare/vite-plugin). Has a `pnpm build` step
#                   before wrangler deploy.
#   - loro-sync   : Legacy worker. Functionality merged into api-cf —
#                   only deploy on explicit request.
#
# Order matters: deploy api-cf BEFORE web so web's runtime sees the new
# bindings/DO classes. The combined `make deploy` enforces this.
#
# Pre-deploy gates:
#   - `make lint` runs first (unless SKIP_CHECKS=1)
#   - wrangler must be authenticated; we surface `wrangler whoami` early
#     so failures don't happen mid-deploy.

WRANGLER ?= pnpm --silent dlx wrangler

wrangler-whoami: ## Confirm wrangler is logged in (warns, doesn't fail)
	@echo "$(BLUE)Checking wrangler auth...$(NC)"
	@cd apps/api-cf && pnpm exec wrangler whoami 2>&1 | tail -3 || \
		echo "$(YELLOW)Not logged in. Run: pnpm exec wrangler login$(NC)"

predeploy-check: ## Run lint before any deploy (skip with SKIP_CHECKS=1)
	@if [ "$(SKIP_CHECKS)" = "1" ]; then \
		echo "$(YELLOW)⚠ SKIP_CHECKS=1 — skipping pre-deploy lint$(NC)"; \
	else \
		echo "$(BLUE)Pre-deploy lint...$(NC)"; \
		$(MAKE) lint || { echo "$(RED)Pre-deploy lint failed. Fix or set SKIP_CHECKS=1 to override.$(NC)"; exit 1; }; \
	fi

deploy-api: predeploy-check ## Deploy api-cf (Workers + RenderContainer image)
	@echo "$(BLUE)Deploying clash-api → Cloudflare Workers...$(NC)"
	@# `pnpm run deploy` (not `pnpm deploy`) — the latter is pnpm's built-in
	@# workspace-deployment command and does NOT execute package.json scripts.
	@cd apps/api-cf && pnpm run deploy
	@echo "$(GREEN)✓ api-cf deployed$(NC)"

deploy-web: predeploy-check ## Build + deploy web (Pages/Worker)
	@echo "$(BLUE)Deploying clash-web → Cloudflare...$(NC)"
	@pnpm build:package @clash/web
	@pnpm --filter @clash/web run deploy
	@echo "$(GREEN)✓ web deployed$(NC)"

deploy: predeploy-check ## Deploy api-cf then web (the standard production path)
	@echo "$(BLUE)Deploying api-cf + web (in order)...$(NC)"
	@$(MAKE) deploy-api SKIP_CHECKS=1
	@$(MAKE) deploy-web SKIP_CHECKS=1
	@echo ""
	@echo "$(GREEN)✓ Standard deploy complete (api-cf + web)$(NC)"

# ─── Staging ──────────────────────────────────────────────────────────
# `[env.staging]` in each app's wrangler.toml binds staging workers to
# PRODUCTION data (real D1 / R2). Worker names get a `-staging` suffix so
# they don't collide with the prod workers. The wrangler.toml staging
# sections must NOT be committed (they contain real resource IDs).

deploy-api-staging: predeploy-check ## Deploy clash-api-staging (uses prod data)
	@echo "$(BLUE)Deploying clash-api-staging → Cloudflare Workers...$(NC)"
	@cd apps/api-cf && pnpm exec wrangler deploy --env staging
	@echo "$(GREEN)✓ api-cf staging deployed$(NC)"

deploy-web-staging: predeploy-check ## Build + deploy clash-web-staging (uses prod data)
	@echo "$(BLUE)Deploying clash-web-staging → Cloudflare...$(NC)"
	@pnpm build:package @clash/web
	@pnpm --filter @clash/web exec wrangler deploy --env staging
	@echo "$(GREEN)✓ web staging deployed$(NC)"

deploy-staging: predeploy-check ## Deploy api-cf + web staging (in order)
	@echo "$(BLUE)Deploying staging (api-cf → web)...$(NC)"
	@$(MAKE) deploy-api-staging SKIP_CHECKS=1
	@$(MAKE) deploy-web-staging SKIP_CHECKS=1
	@echo ""
	@echo "$(GREEN)✓ Staging deploy complete$(NC)"
	@echo "$(YELLOW)Reminder: set MEDIA_GATEWAY_URL on api-cf-staging if rendering.$(NC)"
	@echo "$(YELLOW)  → wrangler secret put MEDIA_GATEWAY_URL --env staging$(NC)"

#==============================================================================
# Cleanup
#==============================================================================

clean: ## Clean all build artifacts and dependencies
	@echo "$(BLUE)Cleaning TypeScript artifacts...$(NC)"
	@pnpm clean || true
	@rm -rf node_modules .turbo
	@rm -f apps/web/local.db*
	@echo "$(GREEN)✓ Cleanup complete$(NC)"

clean-all: clean ## Clean everything including all .wrangler directories
	@echo "$(BLUE)Cleaning Wrangler caches...$(NC)"
	@find . -type d -name ".wrangler" -exec rm -rf {} + 2>/dev/null || true
	@echo "$(GREEN)✓ Deep cleanup complete$(NC)"

#==============================================================================
# Utilities
#==============================================================================

deps-tree: ## Show dependency tree for all packages
	@echo "$(BLUE)TypeScript dependencies:$(NC)"
	@pnpm list --depth 0

update-deps: ## Update all dependencies
	@echo "$(BLUE)Updating TypeScript dependencies...$(NC)"
	@pnpm update --latest

info: ## Show project information
	@echo "$(BLUE)Clash - Project Information$(NC)"
	@echo ""
	@echo "Project Root: $(shell pwd)"
	@echo "Git Branch: $$(git branch --show-current 2>/dev/null || echo 'Not a git repo')"
	@echo "Git Status: $$(git status --short 2>/dev/null | wc -l | tr -d ' ') files modified"
	@echo ""
	@echo "$(BLUE)Node Version:$(NC) $$(node --version 2>/dev/null || echo 'Not installed')"
	@echo "$(BLUE)PNPM Version:$(NC) $$(pnpm --version 2>/dev/null || echo 'Not installed')"
	@echo ""
	@echo "$(BLUE)Environment:$(NC)"
	@echo "  HTTP_PROXY=$(HTTP_PROXY)"
	@echo "  HTTPS_PROXY=$(HTTPS_PROXY)"
	@echo "  NO_PROXY=$(NO_PROXY)"
