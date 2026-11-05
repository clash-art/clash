# ADR 0001: Clash cloud-hosted agent 复用 openma 部署作为上游产品

**Status**: Proposed (2026-11-03)
**Related**: clash issue #150, clash PR #467, [`docs/agent-first-local-v1-remote-compatibility-boundary.md`](../agent-first-local-v1-remote-compatibility-boundary.md), openma `docs/adr/0006-session-execution-authority.md`, openma `docs/self-host.md`

> 编号说明：clash `origin/master` 目前没有 `docs/adr/` 目录，本文按 openma `docs/adr/` 的格式起草，暂定 0001。目录位置和编号在合入前确认。

## Context

clash 现在没有在线的 cloud-hosted agent。agent 跑在用户本机，由 daemon 通过 ACP 驱动。

云端和 agent 相关的只有 BYO-bridge 时期留下的 relay：`apps/api-cf/src/agents/runtime-room.ts` 里的 `RuntimeRoom` DO，按 `runtime_id` 寻址，把 browser WS 和本地 `clash bridge` daemon 的 WS 连起来转发 `session.event` / `prompt` / `cancel`。持久化走 D1 `chat_message` 表（`apps/web/drizzle/0010_chat_message.sql`），agent 每个 turn 的原始 ACP event 流在 `session.complete` 时拼成一个 JSON array 写进 `events_json` 一行，历史读取在 `apps/api-cf/src/routes/v1/sessions-runtime.ts` 里整行 `JSON.parse`。一个长 turn 的 blob 会超过 D1 单行 2MB 上限，这就是 issue #150。

openma（`openma-ai/open-managed-agents`）是开源的 managed-agent 实现，这些问题它已经在产品层面处理过：

- event log 一个 event 一行（`packages/event-log`），单个 event JSON 超过 `SPILL_THRESHOLD_BYTES = 500_000` 时正文落 R2，行里留引用（`packages/event-log/src/cf-do/index.ts`）。
- harness 对单个 tool result 截断到 `MAX_TOOL_RESULT_CHARS = 50000`（`apps/agent/src/harness/tools.ts`）。
- session turn 有单一的 fenced execution authority（lease、generation、recovery），见 openma ADR 0006。
- sandbox 有多家 provider（`packages/managed-runtime-*`、`packages/sandbox-adapter-*`），harness 可以在 sandbox 里通过 ACP 跑 Claude Code 等 agent（`packages/harness-runtime-acp`）。
- 支持 custom tools（`packages/api-types/src/types.ts` 中 `type: "custom"`、`agent.custom_tool_use`、`user.custom_tool_result`）。
- 计费和成本归属有独立包（`packages/cf-billing`、`packages/cost-attribution*`），目前都是 `private: true`。
- 公开 SDK `@openma/sdk`（`packages/sdk`）已经发布到 npm，latest 是 1.1.0（npm `time.modified` 为 2026-11-02）。它组合官方 `@anthropic-ai/sdk` 的 Managed Agents resource tree（`client.beta.agents`、`client.beta.sessions`），openma 自己的扩展挂在 `client.oma` 下（`packages/sdk/README.md`）。所以 clash 不需要“等 openma 变成 SDK”，现在就可以按 npm semver 依赖。
- 部署拓扑见下文“部署选项”。

clash 已经通过 npm 消费 `@openma/common`。PR #467 卡住的原因是 `@openma/common` 被钉在 git SHA 上，release guard 要求 npm semver。现在 `origin/master` 的 `.github/actions/setup-common/pin.env` 按 `@openma/common@0.12.0` 的 npm tarball 校验。

## Decision

clash 将来的 cloud-hosted agent 不自建 runtime，直接使用一个标准 openma 部署作为上游产品。对 self-hoster 的说法是：clash cloud agent = 标准 openma deployment + clash 的 tools / skills 配置。

### 为什么

1. openma 已经有 session、event log、sandboxed harness、recovery、billing hooks。clash 自己再做一遍，大概率重复 `RuntimeRoom` + `chat_message` 这条路上已经踩过的问题（turn 级 blob、单表单行上限、relay 和持久化混在一个 DO 里）。
2. clash 会成为 openma 第一个真实的外部 dogfood 用户。外部产品只通过公开 API 跑在 openma 上，能直接检验 openma 的开源边界是否成立。
3. self-hoster 的边界清楚：部署 openma 按 openma 的文档走，clash 只额外提供配置和 tools。

### 边界

- **依赖方向只有 clash → openma。** openma 仓库里不出现 clash 概念。clash 的需求要先抽象成通用扩展点再进 openma，例如 custom tools、媒体类 event type、billing adapter。
- **只通过公开接口集成**：openma public HTTP API、`@openma/sdk`、部署配置。不读写 openma 的表，不 import openma 的内部包（例如 `private: true` 的 `cf-billing`、`cost-attribution`）。按用户规则，用 vendor 官方 SDK，不手写 client。openma #353 那种只在 mock 上验证过的手写 client 是反例。
- **数据归属**：openma 持有 agent session 和 session events。clash 的产物（timeline、canvas、MG、assets）留在 clash 自己的存储，agent 通过 clash 提供的 tools 读写它们。
- **版本**：只消费 openma 已发布的版本（npm semver 包，例如 `@openma/sdk@1.1.0`；tag 过的部署镜像或 release），任何情况下都不钉 git SHA。PR #467 的问题不再重复。

### Local-first

本地仍然是主路径。cloud 只是可选的远程运行位置。目标是客户端看到的 event 格式和本地一致，客户端不关心 agent 跑在哪里，clash 内部也不维护两套 session 模型。

ACP event 和 openma session events 之间需要映射。目前查到的情况：

- openma 已有 ACP → managed session event 的 projector，`packages/harness-runtime-acp/src/managed-event-projector.ts` 只是 re-export `@openma/common/managed-runtime`，实现和 desktop 共用。clash 已经依赖 `@openma/common`，本地路径有机会复用同一个 projector，让本地和云端都产出 openma 的 session event 形状。
- openma 公开的 event 类型有 `agent.message`、`agent.tool_use`、`agent.tool_result`、`agent.custom_tool_use`、`session.status_idle` 等（`packages/api-types/src/types.ts`，`docs/self-host.md` 的 SSE 示例）。

没有核实、需要回答的缺口：

- projector 对 ACP 流式 chunk（message / thought）、`tool_call_update`、plan、permission request 的覆盖程度，是否有信息丢失。
- clash 特有的媒体产物 event（生成图片、视频、timeline 改动）在 openma 里用哪种通用 event type 表达。如果没有，要在 openma 提通用扩展点。
- 现在 clash 前端消费的是原始 ACP event，换成 session event 形状后前端改动的范围。

### 部署选项

docker compose 不是必须的。按 openma `docs/deployment.md` 和 README，可选拓扑有：

- **Self-host Node**：镜像 `openma/main-node`。`docker-compose.yml` 是 SQLite 版；`docker-compose.postgres.yml` 是 PG 版，包含 postgres + `oma-server` + `oma-vault` sidecar。`docs/self-host.md` 标注为 “Working PoC”。也可以不用 Docker，直接原生 Node 跑（`pnpm --filter main-node start`）。
- **Cloudflare**：setup wizard，分 CF Local（`wrangler dev` + 本地 D1/KV/R2/DO 模拟）和 CF Prod（Workers、Durable Objects、D1、R2，资源建在自己的 CF 账号里）。
- **Fly.io**、**Vercel（Beta）**。

不管哪种拓扑，都必须显式配置一个隔离的 sandbox provider（E2B、Daytona、LiteBox、Cloudflare Sandbox 等），openma 不会回退到在宿主机上无隔离地跑 agent 命令。

**对 clash 的建议**：clash 托管的 openma 部署在 clash 自己的 CF 账号上，和现有 `apps/api-cf` 同一套栈，运维和资源都在一处。compose 保留为开源 self-host 路径，“clash + openma 一个 compose 起来”对开源用户是个好讲的故事。最终部署目标仍是 open question，见下文。

## Consequences

- `RuntimeRoom` 和 `chat_message` 这条云端历史路径进入 deprecate，云端 agent 上线后退役。本 ADR 不包含实现。
- #150 的 `events_json` 上限问题在云端路径上不再存在，因为 event 改由 openma event log 按单条存储。本地 bridge 场景在退役前是否还需要临时修 #150，另行决定。
- clash 的发布节奏受 openma 公开 API 稳定性约束。

### 风险

- openma public API / SDK 的稳定性和 breaking change 策略。
- 多租户：clash 用户和 openma workspace / tenant 的对应关系，鉴权怎么串。
- 计费：clash 的计费如何经 openma 的 billing hooks 拿到用量，而不碰内部包。
- 延迟：browser → clash → openma → sandbox 多一跳，实际影响要在真实部署上测。
- 运维归属：openma 部署由谁运维、出问题时的分层排查。

### Open questions

- clash 托管的 openma 最终部署目标：倾向 clash 自己 CF 账号上的 Cloudflare 部署（见“部署选项”），还是 Node 自部署 / Fly.io？未定。
- openma 的 billing / cost attribution 要以什么公开形式暴露给 clash？目前相关包是 private。
- 云端 session 的历史，clash 是直接从 openma 读，还是要镜像一份？倾向于直接读，未定。
- 模型选择：如果使用 DeepSeek，只用 Flash 模型。

## Rollout（草案）

每个阶段都在真实 openma 部署上验证，不以 mock 通过作为完成标准。

1. **Spike**：在一个按 `docs/self-host.md` 起的 openma 部署上，用 `@openma/sdk` 创建 agent、session，跑通 SSE，记录 event 形状。
2. **Clash tools**：把 clash 的 timeline / canvas / asset 操作做成 custom tools，在真实部署上让 agent 完成一次读写 clash 产物的任务。
3. **Event 统一**：确认 ACP ↔ session event 映射，补齐缺口（必要时在 openma 提通用扩展点并等发版），前端用同一套渲染接本地和云端。
4. **鉴权与计费**：打通 clash 用户到 openma tenant 的映射和用量回传，在真实部署上对账。
5. **退役**：云端 agent 可用后，停止 `RuntimeRoom` / `chat_message` 云端历史写入，并制定数据迁移或保留策略。
