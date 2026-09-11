# Clash — Creative Platform for Agents

[English](./README.md) · [简体中文](./README.zh-CN.md)

> **Where agents co-create, humans are welcome too.**

Clash is a source-available, self-hostable **creative platform for agents**.
It gives agents a real project they can understand, a growing set of tools
they can use, and an explicit path for bringing work back to human taste,
judgment, and permission.

Today, Clash lives on the desktop. Canvas, Timeline, Director Stage, Codex,
ACP, MCP, and the CLI are tools inside that environment—not the definition of
the product.

**[Website](https://clash.video)** ·
**[Quick start](#quick-start)** ·
**[Self-hosting](#self-hosting)** ·
**[Architecture](#architecture)**

![Clash creative platform for agents with its desktop tools](./.github/social-preview.png)

## The creative environment

| Surface               | What it gives you                                                                                                            |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Canvas**            | A collaborative node graph for ideas, references, assets, generation pipelines, and agent annotations.                       |
| **Timeline**          | Multi-track video editing with transcripts, captions, keyframes, transitions, effects, audio ducking, and production export. |
| **Director Stage**    | 3D characters, props, cameras, action clips, panoramic environments, shot blocking, and preview generation.                  |
| **Agent runtime**     | Real Codex/ACP sessions, typed MCP tools, installable Codex plugins, CLI projections, and revision-aware apply paths.        |
| **Models and assets** | Local ASR/TTS plus routed image, video, audio, and text providers in a project-scoped asset workspace.                       |
| **Deploy anywhere**   | Electron desktop and local-first workflows, or a Cloudflare stack using Workers, Durable Objects, D1, R2, and Workflows.     |

Clash is designed around agent creation rather than a chat panel bolted onto a
traditional editor. Direct GUI edits stay interactive and undoable; agent
changes travel through explicit project contracts that can be validated before
they are applied.

## Work with Clash

- **Desktop and web:** edit projects visually with Canvas, Timeline, Director,
  Assets, and Copilot surfaces.
- **CLI:** inspect and operate projects, assets, Canvas, Timeline, Director,
  models, tasks, text, and production workflows from the terminal.
- **MCP and Codex plugins:** open focused Studio, Canvas, Timeline, and Director
  apps backed by typed tools instead of a hidden browser automation layer.
- **JavaScript and Python SDKs:** integrate project operations and local model
  runtimes into custom agents and pipelines.

## Quick start

Clash uses Node.js 24.18+ (Node 24.x) and pnpm 10+.

Install the unified command package for CLI and MCP use:

```bash
npm install -g clash
clash --help
# MCP clients run: npx -y clash mcp
```

For repository development:

```bash
git clone https://github.com/clash-space/clash.git
cd clash
corepack enable
pnpm install
pnpm dev
```

Run the Electron app during local development:

```bash
pnpm dev:package @clash/desktop
```

`clash.video` runs from a private overlay
([`clash-space/clash-hosted`](https://github.com/clash-space/clash-hosted))
that vendors this repository as a submodule and adds billing. Everything in
this repository runs without that overlay.

---

## Architecture

### Local-first agent path

```
Human editor ──▶ Electron / Web ───────────────┐
                                               ▼
Codex / ACP / MCP / CLI ─────────────▶ local-api + project workspace
                                               │
                    ┌──────────┬───────────┬────┴─────┬──────────┐
                    ▼          ▼           ▼          ▼          ▼
                  Canvas    Timeline    Director    Assets    Models
                 (Loro)   (projection)   (3D)      (media)  (local/cloud)
```

### Cloud collaboration path

```
                        ┌──────────────────────────────┐
                        │  clash-web Worker            │
   Browser ─── WS ─────▶│  Vite SPA + Better Auth      │
                        │  proxies /api /sync /agents  │
                        └─────────────┬────────────────┘
                                      │ service binding
                                      ▼
                        ┌──────────────────────────────┐
                        │  clash-api Worker            │
                        │   • Hono routes              │
                        │   • DO ProjectRoom (Loro)    │
                        │   • DO SupervisorAgent (chat)│
                        │   • DO RenderContainer       │
                        │   • Workflow generation-*    │
                        └────┬────────────┬────────────┘
                             │            │
                       D1 clash-d1   R2 clash-r2
                       users / projects     all generated
                       assets / asset_refs  media + covers
```

**Key invariants**

- **Project contracts are the agent boundary.** CLI and MCP mutations use typed,
  revision-aware projections rather than directly reaching into GUI state.
- **Loro is Canvas truth.** Edges, nodes, statuses live in Loro; D1 holds
  asset rows + auth + project metadata. The two never duplicate the same
  field.
- **`assetId` resolves to R2 server-side.** Pending nodes carry `assetId`
  only; the workflow batch-resolves IDs to R2 keys via D1. `node.data.src`
  does not exist.
- **Generation runs on Cloudflare Workflows.** Long tasks are restartable
  per step; the frontend just watches node status.

### Generation path

```
canvas Run
  → frontend writes pending node { status, modelId, referenceImageAssetIds }
  → ProjectRoom DO sees pending → NodeProcessor
  → batch SELECT assets WHERE id IN (...) → R2 keys
  → env.GENERATION_WORKFLOW.create({ params: { referenceImageR2Keys, ... } })
  → resolveProvider → google-image | fal-image | veo | fal-video | ...
  → step("generate"): R2 read → upstream API → upload result → D1 asset row
  → POST /sync/<projectId>/update-node { status:'completed', assetId }
  → Loro broadcast → ImageNode reads via useAsset(assetId).srcR2Key
```

### Tech

| Layer           | Tech                                                                          |
| --------------- | ----------------------------------------------------------------------------- |
| Desktop and web | Electron, Vite, React 19, Tailwind v4, @xyflow/react, Framer Motion           |
| Agent runtime   | ACP, Model Context Protocol (MCP), Codex plugins, CLI, JavaScript/Python SDKs |
| Video           | Remotion 4, FFmpeg, transcript/caption tooling, effects and export pipelines  |
| 3D direction    | Three.js, React Three Fiber, Drei                                             |
| Cloud           | Cloudflare Workers (Hono), Durable Objects, Workflows, Containers             |
| Real-time       | Loro CRDT over binary WebSocket                                               |
| Data            | Local project storage, D1 + Drizzle, R2                                       |
| Auth            | Better Auth (cookie session + opaque API tokens)                              |
| AI providers    | Local models, Google Gemini/Veo, fal.ai, OpenAI, Kling, ModelArk, and more    |
| Build           | pnpm workspaces, Turborepo, Vite, tsup                                        |

### Layout

```
apps/
  desktop/              Electron shell, local export, NLE handoff, ACP harnesses
  local-api/            local-first project, model, asset, and agent runtime
  web/                  Vite SPA + Cloudflare Worker entry
  api-cf/               Hono + DOs + Workflow + container DO
  render-server/        Remotion image (built once → GHCR, pulled by Container DO)
packages/
  director-{core,ui}/   3D Director Stage state and interface
  mcp-server/           internal typed peer capability surface for the plugin MCP
  clash-sdk/            JavaScript and Python agent/model SDKs
  shared-types/         Zod schemas, model cards, ref/capability helpers
  shared-layout/        canvas auto-layout
  gui/                  platform-neutral React views and typed UI ports
  web-ui/               Web product controllers and compatibility exports
  cli/                  terminal CLI
  claude-code-plugin/   Claude Code integration
  remotion-effects/     reusable video effects
  remotion-{core,components,ui}/  video editor
plugins/
  clash/                complete installable Clash Codex plugin
  clash-timeline/       focused Timeline Codex plugin
  clash-director/       focused Director Stage Codex plugin
```

---

## Self-hosting

The `wrangler.toml` files in this repo use neutral resource names
(`clash-api`, `clash-d1`, `clash-r2`) with placeholder UUIDs. Create your
own Cloudflare resources and paste the IDs back in.

### Prerequisites

- Node 24.18+ (Node 24.x), pnpm 10+, wrangler 4+
- Cloudflare Workers Paid plan (DO + Workflows + Containers all need it)

### One-time setup

```bash
wrangler login

wrangler d1 create clash-d1
# Copy the printed `database_id` into apps/{api-cf,web}/wrangler.toml

wrangler r2 bucket create clash-r2

cd apps/web
pnpm wrangler d1 migrations apply clash-d1 --remote
```

### Secrets

`apps/api-cf/.dev.vars.example` lists every secret. Copy and fill:

```bash
cp apps/api-cf/.dev.vars.example apps/api-cf/.dev.vars
# fill in real values, then for production:
cd apps/api-cf
wrangler secret bulk .dev.vars
```

| Secret                                                                                          | Notes                                    |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `BETTER_AUTH_SECRET`                                                                            | `openssl rand -base64 32`                |
| `BETTER_AUTH_URL`                                                                               | Public origin, e.g. `https://your.app`   |
| `GOOGLE_API_KEY`                                                                                | Google AI Studio                         |
| `GOOGLE_CLIENT_EMAIL` / `GOOGLE_PRIVATE_KEY` / `GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_LOCATION` | Vertex AI service account                |
| `FAL_API_KEY`                                                                                   | fal.ai dashboard                         |
| `KLING_ACCESS_KEY` / `KLING_SECRET_KEY`                                                         | Kuaishou Kling                           |
| `R2_PUBLIC_URL`                                                                                 | Public bucket URL or signed-URL host     |
| `CF_AIG_TOKEN` / `CF_AIG_OPENAI_URL` / `GOOGLE_AI_STUDIO_BASE_URL` / `FAL_GATEWAY_URL`          | CF AI Gateway (optional but recommended) |
| `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET`                                                         | Google OAuth (optional)                  |

### Deploy

```bash
cd apps/web    && pnpm run deploy
cd apps/api-cf && pnpm run deploy
```

Render container: build the heavy image once (chromium + ffmpeg + node
prod deps) and push to a registry. `apps/render-server/Dockerfile.cf`
is just `FROM <your-registry>/clash-render:latest`, so subsequent
`wrangler deploy` runs only pull.

```bash
docker build -f apps/render-server/Dockerfile -t ghcr.io/<you>/clash-render:latest .
docker push ghcr.io/<you>/clash-render:latest
# Edit apps/render-server/Dockerfile.cf to FROM your image.
```

### CI

`.github/workflows/deploy.yml` is a working template. To enable, add
to repo Settings → Secrets:

- `CLOUDFLARE_API_TOKEN` — token with `Workers Scripts(Edit)`, `Workers KV(Edit)`, `D1(Edit)`, `R2(Edit)`, `Workflows(Edit)`
- `CLOUDFLARE_ACCOUNT_ID`
- The same secret list as above (CI uses `wrangler-action` to push them to the Worker on every deploy)

---

## Local dev

```bash
pnpm install
pnpm -w dev
```

Vite dev server on `:3000` proxies `/api/*`, `/sync/*`, `/agents/*` to
`apps/api-cf` running under wrangler dev on `:8789`. D1 and R2 use the
shared `.wrangler/state/` so all services see the same local data.

### CLI

```bash
cd packages/cli && pnpm link --global
clash auth login
clash projects list
clash canvas execute --project <id> --node <id>
```

### Tests

```bash
pnpm test          # unit (vitest)
pnpm typecheck     # tsc --noEmit across all packages
```

For the source development checks, run the package command directly:

```bash
pnpm --dir packages/web-ui typecheck
pnpm --dir apps/local-api typecheck
pnpm --dir plugins/clash typecheck
```

These checks retain strict source and test validation and cache TypeScript's
incremental state in each package's ignored `.cache/typecheck.tsbuildinfo`.
Repeated checks reuse unchanged diagnostics; edits to an imported source
contract invalidate its consumers. The Local API command uses the development
workspace aliases so it checks current source contracts. No JavaScript or
declarations are emitted. Removing the package's cache file requests a fresh
full check; caches are optional and are not release artifacts.

---

## License

[PolyForm Shield 1.0.0](./LICENSE). Source-available, never converts.

You can fork, modify, distribute, run internally, contribute back, study,
benchmark — anything except provide a product that competes with this
software (i.e. don't host clash-clone.com as a paid service).
