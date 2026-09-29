# 云端上线 Roadmap：按证据逐阶段放行

创建日期：2026-09-11。审计基线：`1315eb6d`。

目标：先验证个人多设备同步与 BYOK 的受邀内测，再扩展多人协作和托管生成。本文是执行与验收计划，不改变现有领域契约，也不代表生产环境已经验证。

## 当前接续点（2026-09-15）

Node 的 snapshot + append log 纯转发已落地，Local Host 已接入；客户端现使用 `@loro-dev/streams-client` 的 HTTP/snapshot/SSE 能力。下文 materializing gateway/WebSocket 和 eventsource-client 的实现记录是历史过程，当前实现以文末 SDK 与客户端快照记录为准。真实 TCP PG 双网关、故障恢复和每场景 4,000 条持久 writer 回归通过。同步基础设施的本机功能验收已有证据，完整云端产品的 G0–G4 仍未放行。

快照维护现已接入 Node 既有持久 outbox：日志同事务登记延迟任务，合并目标 offset；客户端只做同步；独立客户端计算进程与真实 PG 的小规模链路回归通过。仍需处理 Local Host 初始离线历史超过 8 MiB 的上传限制，以及损坏日志的可诊断恢复策略。生产容量需要将负载产生、客户端合并与网关分别观测，并提前确定目标负载；资源交付、浏览器身份与 readiness 闭环、PG 重启、跨机/TLS 和 Fly/Cloudflare 隔离部署验收仍待完成。不能把下面历史工期当作当前发布承诺。

## 范围与节奏

- 内测范围提案：个人账号、Desktop/CLI/Web 同一项目、多设备同步、BYOK。多人分享与平台付费生成分别通过后续门禁才开放。
- 工期假设：2 名熟悉仓库的工程师全职投入，另有发布验收支持。原受邀内测 2–3 周、公开版 4–6 周估计主要依据 Cloudflare 路径审计；不能直接作为双环境交付承诺。G0 确认 Node 服务端和两端适配器完成度后重新估算。时间从实际开工计算，阶段失败后重新估算，不按日期自动放行。
- 当前仅审计了本仓库。正式部署引用的 `clash-hosted` 仓库、生产 bindings、迁移状态、计费与线上指标未验证；取得这些信息是 G0 的输入。
- 每次推进一个可独立验证的切片：确认复现 → 修复 → 针对性回归 → 真实部署链路验证 → 更新本表。文档完成、单测通过、UI 显示成功都不能单独证明阶段完成。
- 权限、数据完整性、费用控制失败时暂停扩量；其他独立准备工作可继续。禁止在当前共享生产数据的 staging 上做清空、故障注入或恢复演练。

## 两条部署路径（2026-09-11 更新）

部署目标为 Fly.io 与 Cloudflare。Fly.io 是部署平台，Node.js 是运行时，两者不是用户分类。本文暂按“Node 服务端部署到 Fly.io，Workers 服务端部署到 Cloudflare”规划，具体运行时入口在 G0 核验。两者共享产品协议、领域规则和验收场景，分别提供基础设施适配；Node 产品契约不依赖 Fly 专有接口。现有 [cloud-sync 契约](../apps/docs/guide/cloud-sync.md) 已描述存储与调度端口，但端口存在不代表部署实现完成。

| 边界 | 共用契约 | Fly.io / Node 待核验适配 | Cloudflare 待核验适配 |
| --- | --- | --- | --- |
| 准入与授权 | User / Tenant / Project、角色、准入状态 | Node HTTP 服务、PostgreSQL 事务 | Worker HTTP、D1 |
| 项目同步 | Loro 协议、事件持久化、checkpoint、确认语义 | 持久事件日志、WebSocket 会话、跨实例分发 | ProjectRoom DO、事件日志与 checkpoint |
| 资源交付 | Resource 身份、签名能力、摘要与归属 | 对象存储或持久文件系统适配，G0 决定拓扑 | R2、Resource resolver |
| 长任务 | Run 身份、CAS、重试、取消、幂等发布 | PostgreSQL journal 与 scheduler/worker，G0 核验实现 | Workflow、journal、Container |
| 发布恢复 | 同一数据完整性与恢复验收标准 | Node 进程/实例替换、持久存储、滚动升级 | Worker/DO/Workflow 更新、迁移与恢复 |

建议实现顺序：共享契约与权限回归 → 各端最小上云闭环 → 各端故障与发布验收。不得为了两端一致而在 Node 上模拟整套 DO，也不得在两端复制准入、CAS、费用与资源状态机。适配层只承担运行时、存储、传输与调度差异。

每个 Gate 分别记录 `fly-node` 和 `cloudflare` 状态；一端通过不代表另一端通过。允许先放行已通过门禁的平台，但必须注明发布支持范围。暂不要求两个云后端互相复制或跨云迁移；这不属于双部署支持的隐含要求。

- [ ] G0 找到或建立 Node 云服务端入口、镜像与 Fly 部署配置；本次仅查到 render-server Dockerfile，尚未核验 Node 云端完整发布入口。
- [ ] 两端分别建立隔离测试环境，登记 SQL、资源存储、事件日志、调度和秘密管理的实际选型。
- [ ] 同一套黑盒用例通过 base URL/凭证选择平台执行，不能为某平台放宽权限、CAS、资源完整性或重试断言。
- [ ] Node 多实例支持必须额外验证两个实例同时服务同一项目、连接迁移、任务重复领取与跨实例通知；若首版只支持单实例，明确容量与恢复边界后才放行。

## Node 技术选择与解耦要求（2026-09-15 用户确认）

- Node 云端数据库使用 PostgreSQL；不新增 Node 云端 SQLite 路径。Desktop Local Host 的 SQLite 属于本地模型，保持不变。
- 按 ports/adapters 解耦：业务规则依赖领域端口，Cloudflare 与 Node 部署入口注入实现。端口表达授权、准入、资源、副本与任务能力，不能把 D1/DO 类型伪装成通用接口。
- PostgreSQL 的连接池、凭证、迁移和进程生命周期由部署层管理；共享业务模块不自行建立连接，也不按环境名称分支选择存储。
- 当前先落地 Project 授权端口。准入、内容、同步和任务的完整 Node 服务接线仍是后续切片，不能把授权适配通过当作双部署完成。

## 不变的产品约束

遵循根目录 `AGENTS.md`，以及当前 [Asset](../apps/docs/guide/asset-system.md)、[Document](../apps/docs/guide/document-assets.md)、[Generator](../apps/docs/guide/asset-generator-model.md)、[Durable Run](../apps/docs/guide/durable-run-protocol.md) 契约。

- 云端是本地副本的复制与协作层；不增加另一套云端工作目录、Canvas 或 Agent 写入流程。
- 准入、凭证、权限、同步就绪状态由 Host/产品内部管理；`.clash/project.toml` 只承担项目引用。
- CAS、隐式读后写、不可变资源、下游引用与 copy-on-write 在本地和云端保持同一语义。
- 默认不上传原始 Agent trace、工具日志、本地路径和秘密。资源字节走资源交付平面，不放入 Loro。
- 测试断言依据契约、真实响应或行为；遵守 [testing-rules](../apps/docs/guide/testing-rules.md)。不能用手动勾选 readiness 代替同步完成证据。

## 阶段总表

所有阶段初始为待开始，负责人在开工时登记。工时为规划区间，不是完成承诺；可重叠部分不能简单相加。

| Gate | 交付结果 | 依赖 | 估计 | 状态 |
| --- | --- | --- | --- | --- |
| G0 | 明确上线范围、真实入口和隔离验收环境 | hosted 配置可审查 | 1–2 工作日 | 待开始 |
| G1 | 封闭公开入口的权限绕过 | 本地可先开工；部署验收依赖 G0 | 2–4 工作日 | Cloudflare 代码及本地连接撤权回归通过；部署与 Node 待验证 |
| G2 | 准入、文档、元数据、资源、Web 可用性闭环 | G0、G1 | 3–5 工作日 | 待开始 |
| G3 | 多设备故障恢复与数据边界验证 | G2 | 2–4 工作日 | 待开始 |
| G4 | 受邀内测发布与回滚门禁 | G0–G3 | 2–3 工作日准备，加观察期 | 待开始 |
| G5 | 多人角色、撤权与共享闭环 | G1–G3 | 4–7 工作日，G0 后复估 | 待开始 |
| G6 | 托管生成、费用控制与公开发布 | G4；多人范围还需 G5 | 4–7 工作日，hosted 审计后复估 | 待开始 |

## G0：锁定真实发布对象

- [ ] 明确本轮开放个人内测还是完整云端产品；登记负责人、目标用户规模与支持边界。
- [ ] 审查两端 hosted 入口、插件注入、Web/API 路由、资源 resolver 与数据库迁移；Cloudflare 核对 DO/Workflow/Container bindings，Node 核对 SQL、事件日志与任务调度适配；标明源码 SHA 与实际部署版本。
- [ ] Cloudflare 建立独立 D1、R2、DO、Workflow；Fly/Node 建立独立应用、数据库、资源存储与任务队列/journal。使用测试账号并确认不会写入生产资源。现有 lane staging 不能作为隔离环境证据。
- [ ] 明确两端公开域名、直接 Worker/Node 入口和内部服务入口；检查生产环境没有 development 认证回退。
- [ ] 制定目标负载、延迟/错误率预算、恢复时间目标、观测期与告警负责人；这些数值在负载验收前登记，不事后迁就结果。

放行证据：不含秘密的部署拓扑、资源隔离检查、迁移清单、范围决策。拿不到 hosted 仓库时保留“未验证”，不可据此宣称平台计费不存在。

## G1：先封权限入口

起点：[公开 sync 转发](../apps/api-cf/src/app.ts)、[ProjectRoom](../apps/api-cf/src/agents/project-room.ts)、[Supervisor](../apps/api-cf/src/agents/supervisor.ts)、[鉴权](../apps/api-cf/src/loro/auth.ts)。

- [x] 用持久化行为测试复现未登录请求到达 ProjectRoom/Supervisor 的问题。先验证测试在旧实现上失败（2026-09-11，Cloudflare 本地代码切片；不代表部署门禁通过）。
- [x] 本仓库公开边界移除客户端伪造的内部身份；内部调用保留不可由公网自证的 DO binding 信任边界，同时鉴权 HTTP handler。部署配置仍由 G0 核验。
- [x] 本仓库 WebSocket 握手鉴权，nodes、loro-dump、update-node、reset-doc 等维护子路径不经公开 sync 转发；内部维护调用保留在 service binding 边界。
- [x] Supervisor 在连接、会话读取和框架处理消息前校验身份及项目权限；匿名失败不能继续使用内部身份访问项目。现有连接在消息和发送前重验。
- [x] 本地 workerd/D1 验证匿名、跨账号、伪造内部头、无效/撤销凭证、删除项目，以及合法拥有者访问；拒绝发生在受测读取、持久化与框架消息副作用之前。未调用付费模型；线上矩阵仍待验证。
- [ ] 两端同时覆盖公开 Web 域名与 API Worker/Node 直接入口；HTTP 和 WebSocket 均需验证。

放行证据：负向用例全部拒绝且无副作用；合法路径可用；隔离部署执行同一权限矩阵。单纯让 mock 返回 401 不算通过。

## G2：完成一次真实的项目上云

起点：[准入入口](../apps/local-api/src/app.ts)、[同步协调器](../packages/shared-runtime/src/project-cloud-sync.ts)、[Web 网关](../apps/web/workers/app.ts)、[资源交付](../apps/api-cf/src/routes/asset-capability.ts)。

- [ ] 串联真实准入、Loro、项目元数据、资源上传与验证；核对现有 coordinator 是否复用，避免引入第二套状态机。
- [ ] 只有三个平面均完成必要同步后才进入 ready；任一步失败有可诊断状态与重试入口，不能仅凭配置开关宣称就绪。
- [ ] 核对 `/loro/*` 经实际公开域名的路由及 Worker assets / Node 静态资源回退规则；响应必须是协议内容，不能是 SPA HTML。
- [ ] 接入真实 Resource Registry resolver 与签名上传/下载；校验字节长度、摘要、归属、过期和跨项目访问。
- [ ] 验证准入重复提交、Host 重启、上传中断和凭证刷新，不重复创建项目或损坏资源；ready 后的新编辑继续同步。
- [ ] 把 Open in Web、分享门禁与实际同步结果接通；尚未开放的能力不展示可执行的假入口。

验收场景：设备 A 创建含媒体、文档和 Timeline 的项目 → 准入 → 上传 → 全新设备 B/Web 读取 → 核对资源字节、内容与引用 → 双向编辑 → 关闭并重启 A/B 后再核对。远端可用性不能依赖 A 仍在线或读取 A 的本地文件。

放行证据：同一项目的准入状态轨迹、脱敏网络记录、资源摘要、跨设备语义读回结果；各失败步骤至少一次恢复验证。

## G3：验证故障下仍保住数据

- [ ] 在真实 Host ↔ 隔离云端链路验证断网、重连、重复/乱序投递、Host 重启、DO 重启、Node 进程/实例替换与 checkpoint 恢复。
- [ ] 并发修改非首个 Timeline Sequence、文档和 Canvas；检查冲突处理、引用及几何/帧坐标语义，不只比较画面是否相似。
- [ ] 验证 stale apply 被 CAS 拒绝，重新读取/合并后可提交；下游已固定的节点及版本不被覆盖，COW 后显式重连才改变引用。
- [ ] 验证删除、恢复、取消准入的传播与重试语义，离线旧副本不能意外复活已删除内容或恢复已撤销云端能力。
- [ ] 检查上传数据中没有秘密、原始 trace、工具日志或机器路径。
- [ ] 从持久化备份/事件日志演练恢复，核对已确认提交的状态与资源；记录实际恢复时间和未恢复内容。

放行证据：故障用例、随机种子/事件顺序、前后语义快照、资源摘要和恢复报告。已有内存/模拟传输 chaos 测试是基础，不替代真实云端链路验收。

## G4：个人受邀内测

- [ ] CI 纳入共享契约、api-cf typecheck/单测/Miniflare、Node 云服务端 typecheck/单测/真实存储集成，以及两端相同的权限和云同步黑盒回归；正式发布使用新鲜执行的关键检查。
- [ ] 部署流程验证迁移顺序、版本兼容性、配置检查、冒烟与回滚；代码回滚不能默认等同于数据回滚。
- [ ] 建立准入失败、同步积压、资源交付失败、工作流失败等观测；日志脱敏，关联 project/run/request 标识。
- [ ] 按 G0 登记的负载与预算测试，记录 p95 延迟、错误率、同步收敛耗时、资源吞吐及单项目成本。
- [ ] 首批仅邀请受控账号；记录真实用户阻塞、数据问题与支持处理时间。观察期长度在 G0 确定。

放行证据：G0–G3 通过、部署及恢复演练完成、负载达到预定预算、观察期内无未解决的权限或数据完整性阻塞项。阶段通过仅授权范围内的个人内测能力。

## G5：多人协作

- [ ] 明确并实现产品实际支持的角色矩阵：读取、编辑、邀请、移除、资源访问、执行生成；所有入口共用授权语义。
- [ ] 实现邀请、接受、撤销、移除与项目生命周期；准入/同步不再仅按 owner 判断。
- [ ] 成员移除后验证已建立的 WebSocket、后台任务和资源能力；明确已签发短期 URL 的有效窗口，不能宣称即时撤销却仍可长期访问。
- [ ] 三账号验证 owner、成员、外部账号；角色变更、离线重连和并发编辑均覆盖。

放行证据：完整角色矩阵、撤权时序和多人端到端读回；不以“能连上 WebSocket”作为协作完成标准。

## G6：托管生成与公开版

- [ ] 从 hosted 实现核对额度/预算预检、费用预留、实际结算、失败释放、重试幂等和并发超额防护。
- [ ] 验证 BYOK 与平台密钥选择、凭证隔离、provider 限流/超时、取消与恢复；同一逻辑执行不能因重试重复发布结果或重复扣费。
- [ ] 只开放真实可执行的模型/Action 路由；本地插件能力不能默认当作云端执行能力。
- [ ] 使用受控测试预算验证至少一条实际媒体生成链路：输入 → Run → provider → 资源发布 → 下游固定引用 → 费用核对。
- [ ] 对照 G0 负载预算扩量，确认告警、客服/故障响应、备份保留和回滚负责人。

放行证据：Run 与 provider/账务/资源记录可对账；并发、失败、重试场景通过；公开范围内所有前置门禁通过。范围缩小时在发布记录中明确哪些能力仍未开放。

## 审计基线与后续证据

2026-09-11 在 `1315eb6d` 的一次本地审计结果：

- API：412 个测试通过，3 个跳过；Miniflare：8 个测试通过。
- 本地 cloud admission、metadata、replica link 与 chaos 相关测试：10 个通过。
- api-cf typecheck 通过；`make lint` 通过，10 个任务全部命中缓存。它不是云端测试或新鲜全量检查的替代。
- 两个临时负向路由测试失败：匿名 sync/Supervisor 请求仍到达模拟 DO。证明入口未拒绝，未执行线上攻击，也不是完整 DO 端到端复现。临时文件已清理；G1 必须补入可持续运行的回归。
- 上述结果仅为审计历史；所有 Gate 仍待验证。生产运行、真实跨设备资源同步、收费与恢复目标均未验收。

每个切片完成后，在下表新增记录。证据保存在 `artifacts/cloud-launch/<platform>/<gate>/<run-id>/`（platform 为 `fly-node` 或 `cloudflare`） 或稳定 CI 链接中；该路径是约定，当前尚未生成验收包。只保存脱敏结果，不提交 token、用户私有内容或原始秘密日志。

| 日期 | Gate / 切片 | 负责人 | 源码 SHA / 部署版本 | 平台 / 环境 | 验证命令/场景 | 预期与实际 | 证据链接 | 结论/剩余问题 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 待登记 | — | — | — | — | — | — | — | — |

建议从 G1 的公开 sync 权限回归开始，同时完成 G0 的 hosted 入口与隔离环境盘点。每通过一个 Gate 更新阶段状态与剩余工期；失败项保留证据，不用跳过测试或修改预期来放行。

## G1 执行记录：2026-09-11 首个代码切片

平台：Cloudflare 源码，本地 Vitest + Miniflare；Fly/Node 与公开域名未执行。源码为审计基线上的未提交工作区，最终提交 SHA 待登记。

- [回归测试](../apps/api-cf/src/app.project-transport-auth.test.ts) 使用真实 Hono 路由、JWT 签名验证及项目归属逻辑；仅替换外部会话 HTTP、D1 和 DO 传输。它验证请求在公开边界被拒绝，不能替代真实 DO 握手及线上验证。
- 第一轮 12 个用例在旧实现全部失败；入口修复后全部通过。第二轮新增数据库缺失与软删除场景，4 个用例先失败，再修复共享授权逻辑；共 16 个新增用例。
- 公开 sync 仅允许项目根路径的 GET WebSocket；维护子路径不转发。Sync/Supervisor 转发前清理伪造内部身份，并认证项目归属；Supervisor 的公开路由统一保护 HTTP 与 WebSocket。
- 缺少权限数据库时拒绝授权，软删除项目拒绝访问。现有 development 模式回退仍存在，生产配置必须由 G0 独立确认。
- `pnpm --filter @clash/api-cf test`：428 passed / 3 skipped。
- `pnpm --filter @clash/api-cf test:integration`：8 passed。此为现有 Miniflare 集成套件，没有宣称新增权限矩阵已在真实 DO 跑通。
- `pnpm --filter @clash/api-cf typecheck`：通过。

剩余：隔离部署下的 Web/API 直接入口及真实 WebSocket 权限矩阵、凭证撤销、内部服务边界与其他入口完整盘点、Fly/Node 对应实现。G1 保持未放行。

## G1 执行记录：2026-09-12 连接撤权与框架边界

接续上一个代码切片；范围仍是本仓库 Cloudflare 实现和本地 workerd，未部署生产。

- Supervisor 真实 Durable Object 回归先复现了匿名 HTTP 读取、撤销 API token 后旧连接仍能清空历史、删除项目后仍向旧连接广播的问题。
- 在 AIChatAgent/Agent 构造器安装的完整消息处理器外层检查权限，覆盖框架直接处理的历史写入、清空和恢复协议；仅重写业务 `onMessage` 不足以阻止这些副作用。
- Supervisor HTTP/握手验证身份及目标 DO；Project 连接使用共享的非秘密授权证据，休眠恢复后仍须检查当前项目和凭证。发送私有数据前也检查权限。
- 公网拒绝维护子路径，清除客户端伪造的内部身份、路由和框架 props。内部 DO binding 仍是维护调用的信任边界，不向公网新增维护入口。
- JWT 必须有限期；不声称存在逐 JWT 撤销机制。API token 和 Better Auth session 按当前 D1 记录撤销。空闲连接在下一次受保护操作时关闭，不承诺撤销瞬间立即通知。
- Supervisor 内部同步和旧协议测试曾把默认 Blob 消息误当 ArrayBuffer；真实读回先复现内容丢失，再显式设置 binaryType，修复后保留节点内容。旧协议的千次事件/休眠恢复断言也保持通过。
- API 全部单位测试：460 passed / 3 skipped。Miniflare 共 30 个不同用例分批通过：完整执行先有 27 passed / 2 failed（旧测试 Blob 解码）；修复后 14 个相关 WebSocket/恢复用例全部通过，并新增 Supervisor 内部快照读回。512 MiB 资源与 Document 传输在完整执行中通过，未重复运行无关大文件测试。
- 最终 `make lint`：53/53 通过，其中 52 个缓存命中、api-cf 源码类型检查新鲜执行；API 独立 typecheck 也通过。没有运行 release build。
- 验证源码：本记录所在提交；测试见 [公网入口](../apps/api-cf/src/app.project-transport-auth.test.ts)、[ProjectRoom 权限](../apps/api-cf/src/integration/project-websocket-auth.integration.test.ts)、[Supervisor 权限与内部同步](../apps/api-cf/src/integration/supervisor-auth.integration.test.ts)、[持久化恢复](../apps/api-cf/src/integration/project-room-miniflare.integration.test.ts)。

G1 的隔离部署 Web/API 域名验收、Fly/Node 实现，以及 G0 的真实部署入口与生产环境配置检查仍未完成。已执行或已准入的生成任务的取消、费用与结算属于后续 durable-run 验收；本次不把凭证撤销描述为已执行工作的回滚。

## 解耦执行记录：2026-09-15 Project 授权端口

源码基线：`f183525a` 上的本轮未提交改动；未部署。

- 共享 `project-authorization` 拥有身份选择、Project 归属/删除检查、token/session 撤权与 JWT 有效期规则；不导入 Cloudflare 或 Node 平台 API。存储、JWT 签名验证、会话解析由调用者注入。
- Cloudflare 原有公开入口与 DO 调用保持兼容，改为使用 D1 授权适配；Node 云端新增 PostgreSQL 查询适配。本轮曾验证的 Node SQLite 试作已按用户要求移除。
- PostgreSQL 使用参数化查询和原生 `timestamptz`；适配层把日期转换成共享策略的毫秒值。测试夹具仅覆盖读取的列，不是完整 PG 云端迁移方案。
- Node PG 回归使用 PGlite（PostgreSQL WASM）执行 SQL，覆盖关闭重开数据库、跨用户拒绝、Project 删除、token 撤销、session 过期、参数隔离及 usage 更新时间。4 个用例先因适配未实现失败，再全部通过。
- Cloudflare 原有认证/入口测试 33 个通过；全 API 单测 460 个通过、3 个跳过。迁移后的真实 Miniflare D1 新增授权用例 2 个通过，完整集成套件 32 个通过；全套日志出现 workerd 请求挂起诊断，定向授权重跑通过，仍保留该诊断，不作为线上健康证明。
- Docker daemon 本轮未响应；没有验证 TCP PostgreSQL 连接池、TLS、Fly Machines、多实例或生产部署。PGlite 通过不替代这些验收。

下一切片：共享准入服务与 PostgreSQL 事务/迁移，随后接 Node HTTP/WebSocket 和 Project 持久副本。G1 及双部署发布门禁仍未放行。

本轮质量门禁：首次 `make lint` 因磁盘耗尽中断；清理约 202 MiB、超过一小时的 Turbo 可重建缓存后重跑。第二次 50 个任务成功，但工作区其他并行修改中的 `packages/web-ui/src/components/nodes/ActionBadge.tsx:5173` 报 TS1128，阻断全仓通过。本轮不修改该文件，也不把全仓 lint 标为通过。

随后单独执行 `pnpm --filter @clash/shared-runtime typecheck` 与 `pnpm --filter @clash/api-cf typecheck`，均通过；本轮改动范围内的 `git diff --check` 通过。

## 解耦执行记录：2026-09-15 Project 准入与 PG 事务

- 新增共享 `project-cloud-admission` 服务：请求和 Project metadata 身份检查、个人租户身份、能力声明、响应校验由共享层负责。数据库通过原子准入持久化端口接入，D1 保留 batch，PG 使用调用者提供的独占连接事务。
- D1 与 PG 都拒绝其他 owner、已删除项目和不同 tenant 的既有项目；D1 写入也在 SQL 内重新检查当前归属，避免仅依赖写入前读取。重复准入保留既有同步地址、ready 状态和 admittedAt，响应地址来自已持久化记录。
- 新增 `packages/shared-cloud-schema/postgres/0001_project_admission.sql`，只覆盖 tenant、membership、project 和 admission；没有 SQL 外键。不是完整 Better Auth/计费/资源迁移，也未执行 D1 数据转换或生产迁移。
- PG 实现用参数化 UPSERT 对首次 project claim 仲裁。事务端口必须使用同一条独占连接，失败时整体回滚；尚未提供 Node pg 连接池装配或生产 migration runner。
- PGlite 授权与准入 5 个测试通过，覆盖重复准入、跨 owner/tenant 拒绝、删除、竞争首次 claim 和人为约束失败后的项目/租户回滚。PGlite 的竞争验证不等于多进程网络 PG 验收。
- Miniflare D1 准入集成测试通过，覆盖重复 ready、同步地址一致、其他用户和删除拒绝，以及触发器注入失败后的 batch 回滚。API 全部单测 460 passed / 3 skipped。
- PG 与全仓 lint 同时运行时发生默认 5 秒超时；单 worker 默认超时下也有授权初始化超时。以 `--maxWorkers=1 --testTimeout=60000` 重跑后 5 个通过，耗时约 21 秒。保留耗时问题，不把调高超时视为吞吐验证。
- 本轮曾误用 `pnpm test -- ...` 导致 shared-runtime 全套收集，暴露 2 个 node:test 文件无 Vitest suite，以及 project-asset-client 的 5 个 workspaceRoot 预期差异；这些不属于本次准入改动，未修改或宣称全套通过。定向 PG 测试和 API 全套结果如上。
- `make lint` 全仓 53/53 通过；本轮范围 `git diff --check` 通过。未运行 release build，未部署。

下一切片：Node 云端 HTTP/WebSocket 入口与 PostgreSQL 连接池装配、身份存储及 Project 副本持久化。随后做 TCP/TLS、重启恢复、多实例与 Fly 验收。G1 和双部署发布门禁仍未放行。

## 解耦执行记录：2026-09-15 Node 控制面入口

- 新增 `apps/api-node`，独立于本机 `local-api`。Hono HTTP 准入路由复用共享 token 身份解析与 PG admission 适配；公网身份头没有授权能力。只支持管理员已配置的 API token，尚无 Better Auth 登录或 token 签发接口。
- 新增 pg pool 装配：事务借用同一个 client，commit/rollback 后 finally release；rollback 失败则销毁连接。连接与 SQL 有限超时，关闭时先排空 HTTP，再关闭 pool；没有关闭 TLS 证书验证。
- 新增 `0002_api_tokens.sql` 及显式 migration 命令，事务 advisory lock 串行执行迁移，保存 checksum，拒绝篡改已执行的迁移。服务启动不自动迁移。`CLOUD_PUBLIC_URL` 必须显式配置为 origin，HOST 默认 loopback。
- 新 app 4 个测试通过：真实 HTTP/PGlite 鉴权与准入、迁移失败回滚及 checksum 检查、PGlite-backed 测试连接上的事务回滚/释放、启动配置检查。共享 PG 授权/准入 5 个通过；CF 授权/入口回归 33 个通过。Node 单独 typecheck 通过；无配置 start smoke 按预期拒绝启动。
- 没有连接实际网络 PG，没有执行远端迁移或部署。测试连接池替身不证明 pg TCP/TLS、多进程锁或 Fly 行为。`/ready` 只检查控制面数据表访问，不证明副本同步就绪。

本轮经用户提醒重新核对了已存在的非 DO 设计：
[distributed-loro-sync-backend-research.md](distributed-loro-sync-backend-research.md)。
已有实现是共享 ReplicaEngine、Loro 协议与 local/DO 适配；PG/outbox、Redis 和多网关仍是待实现部分。

下一切片改为沿用该设计：PG 持久事件日志 + 同事务 outbox、按 Project 游标补放；随后 dispatcher/Redis PubSub、多网关 WebSocket、checkpoint worker。客户端 ACK 必须晚于持久化，漏通知从持久日志恢复。不另造单进程 room owner。G1 与双部署上线门禁仍未放行。

本切片最终质量门禁：`make lint` 54/54 通过（包含新增 api-node）；本轮范围 `git diff --check` 通过。没有运行 build 或部署。

## 解耦执行记录：2026-09-15 PG 队列、通知与 Loro checkpoint

用户确认优先使用 DB as queue。本切片把初期通知方案由额外 Redis 改为 PG NOTIFY；广播仍通过可替换端口解耦。PG pool 已按进程复用，尚未实现网关侧 Project 订阅复用、专用 LISTEN 连接与 WebSocket 补放。

- `0003_replica_log.sql`：Project 事务游标、二进制更新日志和 outbox。append 在同一事务写事件、任务和游标，返回发生在 commit 后；相同事件 ID/内容幂等，ID 换内容拒绝。Project 游标按提交顺序推进，回滚不留游标洞。
- outbox 使用 `FOR UPDATE SKIP LOCKED` 批量领取，租约 ID 和到期时间共同约束 ack。通知发布成功后才确认；失败或崩溃保留重试资格，迟到 worker 不能删除新租约。允许重复通知，不宣称 exactly-once。
- `worker:outbox` 是独立的原生 Node 24 进程，发布 PG NOTIFY 的 Project/cursor，不携带 Loro 字节。队列消费与网关广播语义分开：一个 worker 领走任务不代表所有网关已读到。未来网关必须通过 PG 日志补放和周期对账恢复漏通知。
- `0004_replica_checkpoint.sql` 与 `worker:checkpoint`：扫描有新日志的 Project，从完整快照和分页日志构建 LoroDoc，捕获目标 cursor 后在写事务外计算快照，原子发布二进制 snapshot/cursor，仅允许游标前进。多个 worker 可重复计算，过期结果不能覆盖新快照。
- checkpoint 使用共享 LoroStateAdapter 的 full snapshot。检查乱序更新的 pending dependencies 和事件游标缺口；未完整纳入目标前缀时拒绝发布。空更新保留 no-op 语义；一个损坏项目不阻塞其他项目。暂不截断事件或幂等历史，不引入 shallow snapshot。
- Node 14 个测试通过：事件/outbox 原子回滚、幂等、跨 Project 补放、租约恢复/迟到 ack、发布失败、PG 通知、worker 中止、数据库关闭重开、Loro 快照 + tail 恢复、离线编辑、缺依赖/乱序及损坏项目隔离。共享副本 13 个测试通过；两个 worker 的原生 Node 模块加载通过，无需 build。
- 这些是 PGlite SQL/Loro 和本机进程验证。没有网络 PostgreSQL 的多连接竞争、LISTEN 重连、Fly 部署或持续吞吐数据；不能用单进程测试时长推出上线容量。

后续顺序：每进程复用监听连接和 Project 本地订阅 → 接官方 Loro WebSocket 协议与授权 → checkpoint + tail 初始恢复、漏通知补放、跨网关验证 → 实际 PG 负载与故障测试。重点观测 durable ACK p95/p99、队列积压与最老任务年龄、热门 Project 锁等待、WAL/磁盘/CPU、清理开销和补放耗时，再决定是否需要独立消息总线。

最终 `make lint` 54/54 通过。首轮发现 checkpoint 扫描循环的 TypeScript 推断错误，补充结果类型后重跑通过。本轮范围 `git diff --check` 通过；未运行 build、远端迁移或部署。

## 解耦执行记录：2026-09-15 通用 Loro gateway 与 Node 接线

- `shared-replica/loro-gateway` 统一管理 Project 本地副本复用、协议会话、更新验证、持久化后读回与游标补放。`GatewayStore`、`GatewayPeer`、`GatewayNotificationSource` 不含 Node/PG 类型；存储、授权、传输与通知实现从外部注入。仍明确依赖 Loro，不另造全 CRDT 抽象。CF ProjectRoom 本轮未迁移到该核心。
- Node 装配真实 `/sync/:projectId?protocol=loro-v1` WebSocket，查询 pool 按进程复用，另有一条专用 LISTEN 连接。同 Project 的本地客户端共享副本，最后一个离开后释放；其他实例从同一日志补放，不依赖某个常驻 owner。
- `0005_replica_batch.sql` 保存协议批次指纹。一次批次的所有 update、outbox、幂等记录同事务提交，重试换内容/数量拒绝，失败不留部分更新；ACK 在持久化和读回后发送。
- 授权在升级、命令、提交与发送前重查，并通过周期对账关闭撤销访问的连接。授权重查与 append 不是同一 SQL 事务，不宣称撤权的线性化边界。当前仅 API token + caller/Project 有效准入，不细分具体 localReplicaId；尚无浏览器 cookie、JSON presence/activity 或资源就绪闭环。
- NOTIFY 只唤醒相关缓存；LISTEN 成功/重连后以及周期对账都按游标补放。checkpoint worker 保持独立，gateway 从 full snapshot + tail 启动。通知总线可更换，持久日志仍是事实来源。
- 共享协议补充会话累计分片预留与实际字节限制、未完成批次数和分片数上限。超限/慢连接关闭；这些是资源策略而非容量证明。gateway tail 仍整批查询，完整文档大小、总内存、热点 Project 和大快照需要真实负载验收。
- Node 17 个测试、共享副本 17 个测试通过。覆盖双本机 HTTP/WS 网关、漏通知补放、token 撤销、伪造身份/内部路径拒绝、全新 gateway 从 checkpoint 恢复、批次回滚/重试以及分片越界。LISTEN 生命周期使用注入连接测试；两个网关共享 PGlite，未验证网络 PG 的独立事务连接或跨进程竞争。

下一验证边界：隔离网络 PostgreSQL 上的双进程、LISTEN 中断/重连、提交后断连接、worker 崩溃与租约恢复、大快照/热点 Project 吞吐；随后 Fly 环境验收。浏览器身份、资源交付与 readiness 仍是独立未完成门禁。未执行 build、远端迁移或部署。

本切片最终验证：CF 同步/远端持久化/别名回归 15 个通过；`make lint` 全仓 54/54 通过；本轮范围 `git diff --check` 通过。CF 故障注入用例中记录的 event-log-unavailable 是预期失败路径。

## 本地集群验收：2026-09-15 真实 TCP PostgreSQL

用户授权本地起集群验收。Docker Desktop daemon 无响应，改为安装 Homebrew PostgreSQL 17.11，使用独立临时数据目录、随机 loopback 端口；未注册系统服务。拓扑为一个 PG、两个独立 Node gateway、两个 outbox worker 和一个 checkpoint worker。不是 PostgreSQL HA，也不是多主机。`fsync`、`synchronous_commit`、`full_page_writes` 均为 on；无 TLS/跨机延迟。

可复跑：`PG_BIN=/opt/homebrew/opt/postgresql@17/bin pnpm --filter @clash/api-node test:cluster`。runner 原生 Node 24，自动初始化/关闭/清理自己的 PG cluster，测试再创建/删除独立数据库。网络测试单独配置，不加入默认 PGlite 单测。

验证通过：

- 两个独立进程通过真实 PG NOTIFY 扇出；fixture 的周期补放设为 60 秒，恢复断言限时 15 秒，避免由 polling 掩盖通知断路。
- SIGSTOP gateway B，终止其专属 LISTEN backend，gateway A 提交并等 outbox 清空，然后 SIGCONT B；新 LISTEN 建立并从日志恢复已错过的更新。
- checkpoint worker 捕获快照后停止，追加 tail，SIGKILL gateway A；新进程恢复 snapshot + tail。重发同批次得到 ACK，持久游标不增加。
- 独立 claimant 取得 PG 租约后 SIGKILL，租约过期后可重新领取；旧 lease ack 被拒绝，新 lease 可确认。
- 并发写入后检查客户端收敛和 outbox 清空。负载每个 writer 同时只等待一个 ACK，包含协议验证、授权、提交、读回和传输成本。

| 场景 | 更新数 | 平均 ACK/s | ACK p95 | ACK p99 |
| --- | ---: | ---: | ---: | ---: |
| 1 KiB 随机文本，单热点 Project | 1000 | 72.9 | 94.2 ms | 112.1 ms |
| 1 KiB 随机文本，4 Projects | 1000 | 327.7 | 18.9 ms | 21.4 ms |
| 64 KiB 随机文本，单热点 Project | 200 | 36.8 | 205.6 ms | 520.3 ms |
| 64 KiB 随机文本，4 Projects | 200 | 75.0 | 150.3 ms | 233.0 ms |

以上均为 4 个 writer。payload 是文本值大小，不是精确 wire bytes；每次生成独立有效 Loro history，会增加 peer 数，比四个长期设备更强调 peer/history 增长。原始记录：[1 KiB](validation/cloud-node-2026-09-15/random-1k.json)、[64 KiB](validation/cloud-node-2026-09-15/random-64k.json)。短跑数据不是最大持续吞吐；测试时同机还有其他开发进程，未做 CPU/IO 隔离。

保留失败证据：第一次扩展随机 payload 时测试脚本引用了已改名变量，运行失败；修正并 typecheck 后重跑。一次每 writer 1000 条（每场景共 4000 条）的长测在 300 秒超时，没有生成结果，当时无阶段日志，不能断言卡在 PG、Loro 或清理。新增阶段记录后，1000 条/场景与 200 条大 payload/场景均通过；4000 条边界仍未通过，不能外推容量。早期 400 条重复字符短测的较高数字不作为正式容量依据。

本轮只增加验收工具和文档，没有修改同步生产逻辑。`make lint` 54/54 通过；Node typecheck、runner `node --check`、本轮 `git diff --check` 通过。临时 PG 和子进程已关闭，测试数据库已删除，Homebrew PG 工具保留。未 build、远端迁移或部署。

下一门禁：定位长测超时，使用持久 writer Loro peer 的真实编辑模型做增长曲线；采集 gateway CPU/heap、PG 锁等待/IO/WAL、队列年龄与排空速度。之后再做 PG 整体重启、跨主机/TLS 和 Fly 验收。当前证据支持小规模本机多进程功能闭环，不放行生产容量门禁。

## 长测超时定位：2026-09-15

复跑加阶段日志后，故障恢复完成，耗时集中在单热点 Project 写入。writer 0 的累计进度：100 条约 4.5 秒、300 条约 29 秒、500 条约 76 秒、700 条约 152 秒（另外三个 writer 同时写入同 Project）。不是任务队列停止消费或清理阶段卡死。两个 gateway 进程 CPU 较高；一次 PG 采样的 8 个会话均为 idle/ClientRead，无锁等待。单次采样不能排除所有 SQL 成本。

确认的成本来源：`loro-gateway.ts` 提交验证使用 `room.doc.fork()`，持久日志补放也 fork 后 import，再替换原 doc。每次复制成本随整个文档的历史和 peer 数增长。压测默认每条更新创建新 LoroDoc/peer，把这个成本进一步放大。

- 独立 fork 实验：1000/2000/4000 个 fresh-peer 更新时，单次 fork 约 16/29/102 ms；单一持久 peer 的同等更新量约 3/4/7 ms（各点重复 10 次）。诊断时存在同机竞争，不能视为稳定绝对耗时。
- 实际 gateway fixture 计时：两个场景各 1000 条，共 2000 条更新，两活跃网关共 4505 次 fork，累计同步调用耗时 22.6 秒；importBatch 累计约 10.4 秒。原始 [方法计时](validation/cloud-node-2026-09-15/gateway-costs.json) 与 [诊断跑](validation/cloud-node-2026-09-15/profiled-fresh-peers.json) 已保存。计时是 wall duration，不以它除以进程 CPU 时间伪称 CPU 百分比。

结论：主要瓶颈是随状态增长的 Loro 复制/import 工作，默认 fresh-peer 负载进一步放大；目前无证据把超时归因于 PG 队列吞吐。优化方向是复用验证状态、减少成功路径的整份副本复制，同时保留无效更新/持久化失败不能污染已确认副本的保证。单纯提高测试超时或换通知总线不解决该热点。本轮是定位，不修改生产同步逻辑。

fresh-peer 4000 条复现再次在 300 秒超时：[阶段记录](validation/cloud-node-2026-09-15/fresh-peer-timeout.log) 最后为热点 writer 0 完成约 800 条时（四 writer 合计约 3200 条），尚未进入多 Project 场景或 cleanup。期间还运行了方法计时实验和类型检查，存在竞争，因此不能把该时长当独占机器容量；但阶段记录和调用计时已把超时路径定位到增长中的 Loro 写入工作。runner 已停止并清理临时 PG；相关网关/worker 进程已退出。

## 按用户修正落地：snapshot + append log 纯转发（2026-09-15）

删除未发布的 Node materializing WebSocket gateway。共享 `replica-relay` 仅定义不透明字节存储和持久游标；Node `relay-http` 不 import Loro、不构建 LoroDoc、不 fork、不计算 VersionVector 差分。checkpoint 存储从 Loro 计算模块拆出，只有 checkpoint worker 和客户端进行 CRDT 合并。

- 冷启动：GET 最新 snapshot 字节和同一条记录的 covered cursor，再读取 `after=cursor` 的日志。每页捕获已提交 head，按行数/字节上限分页，拒绝缺口。
- 重连：从最后本地持久化成功的游标读取日志。410 表示需要重新 snapshot；游标大于服务端 head 返回 409，不静默跳过。当前仍保留完整日志，没有启用 GC。
- 写入：单条二进制 POST + Idempotency-Key，同事务写 PG event/head/outbox 后返回 cursor。ACK 仅表示已存储。无效 CRDT 字节不会被网关偷偷合并或丢弃；客户端 apply 和 checkpoint worker 失败时不前移其游标/快照。poisoned log 的修复策略仍未实现。
- 通知：PG LISTEN/NOTIFY 到 SSE 仅发送变更提示。SSE SDK 收到事件不能推进应用游标；客户端必须拉日志并完成本地 apply。断线重连和周期拉取覆盖漏通知。
- SDK：采用 `eventsource-client@1.2.0`，复用跨 Node/浏览器 SSE 解析、认证头和重连。普通 fetch 承担 snapshot/log 和 append。评估过 Durable Streams，但本轮不扩展到实现其整个服务端协议，也不声称本服务兼容 Durable Streams。
- Local Host 自动识别 `snapshot-log-v1` 服务声明，选择游标复制适配器；既有 Cloudflare/Loro WebSocket 服务回退保持。Host 原有 ReplicaEngine/commit 仍是本地持久化 authority，不新增工作目录或 Agent API。游标当前在 link 中保留以支持连接重建；Host 进程重启会重新 snapshot + tail。初始离线本地历史的上传仍受 8 MiB 请求上限约束，大项目分块上传是后续门禁。

测试证据：Node 单测 16 passed；共享副本 17 passed；Local Host 既有 WebSocket/link 确定性故障回归 4 passed。新增 HTTP SDK 集成覆盖 snapshot+tail、只按 cursor 重连、本地 apply 失败不前移、内容幂等、非法字节阻止 checkpoint、真实 Local Host 自动发现和离线本地内容上传。

真实 PG 双进程 `[fresh peer]` 每场景 4000 条通过，故障步骤也通过：[原始结果](validation/cloud-node-2026-09-15/relay-4000.json)。单热点场景 207.4 秒、4 Projects 11.3 秒；测试客户端仍合并全部 Loro 更新，每条创建新 peer，且同机并行质量检查带来竞争。网关进程采样约 5% CPU；不能把整套客户端场景耗时当纯转发服务容量。旧 materializing gateway 的持久 peer 对照也已结束并通过（热点约 185 秒）：[历史对照](validation/cloud-node-2026-09-15/materializing-persistent-4000.json)。两者 peer 模型与机器竞争不同，不计算改善倍数。

所有临时 cluster 和子进程已清理。未执行 build、远端迁移或部署。仍需独立负载产生/客户端合并进程的容量测试、poisoned log 修复与大项目上传、TLS/跨机/Fly 验收；双部署上线门禁未放行。

最终收尾：Local Host 关闭会等待游标客户端当前 apply 完成，并忽略已替换连接的迟到错误。HTTP/Host 集成重跑通过；最终 `make lint` 54/54、范围 `git diff --check` 和新增存储脚本语法检查通过。

## 会话接续验收：2026-09-15 持久 writer 与 checkpoint/追加日志

原任务最近两轮没有可见回复，但纯转发实现及其验证已落盘；本轮从现有工作树接续，没有重做实现。先复跑原有真实 TCP PostgreSQL 集群测试：四个 writer 各自复用 Loro peer，每场景 4,000 条、每条 1 KiB 随机文本。热点 Project 34.85 秒（114.8 ACK/s，p95 64.7 ms，p99 87.4 ms）；四 Projects 7.77 秒（514.5 ACK/s，p95 14.5 ms，p99 20.2 ms）。通知恢复、网关崩溃重试、outbox 租约恢复、客户端收敛与队列排空通过。[原始结果](validation/cloud-node-2026-09-15/relay-persistent-4000.json)。

这一轮沿用旧 fixture，checkpoint worker 在故障步骤后停止，因此这些数字不包含压测期间生成快照的成本；不能作为完整链路容量。客户端仍在同一测试进程生成和合并 Loro，未做机器隔离，也不与 fresh-peer 结果计算性能改善倍数。

用户补充 checkpoint 和追加日志后，新增确定性回归：中断 checkpoint 不替换已发布快照；恢复构建时，在捕获 head 后插入的新日志不被错误纳入 snapshot cursor，仍能通过 snapshot + tail 完整恢复；下一次构建再覆盖新 tail。Node 单测 17 passed。真实 PG fixture 同步扩展为 SIGKILL checkpoint worker 后重新启动，在负载期间持续生成快照，并等待其追上 committed head、导入快照与收敛客户端逐项比较。单测中的中断是 AbortSignal 注入，不能冒充进程在发布中途被杀的证据。

扩展的真实 PG 验收通过：[checkpoint 并行结果](validation/cloud-node-2026-09-15/relay-checkpoint-persistent-4000.json)。热点 Project 4,000 条写入 70.79 秒，p95 83.8 ms、p99 221.7 ms；四 Projects 共 4,000 条写入 5.09 秒，p95 8.4 ms、p99 11.2 ms。写完并确认客户端收敛后，等待快照追平及内容校验分别耗时 7.77 秒、5.00 秒；该数值包含 worker 的 10 秒调度周期等待，不是纯快照计算时间。两种场景均验证 snapshot 内容与 committed head 对应的客户端内容一致，之前的故障恢复与幂等回归也通过。

热点结果比关闭 checkpoint 的上一轮更慢，而多 Project 更快，说明两次单机运行不能直接用于量化 checkpoint 开销。下一次容量调查须独立采集 checkpoint 计算/发布耗时、日志追赶距离与年龄、PG WAL/IO、各进程 CPU，并重复相同负载；本轮仅放行这些功能回归。临时 PG 和子进程已退出，未 build 或部署。

本轮最终验证：Node 单测 17 passed、共享副本单测 17 passed、扩展真实 PG 集群验收 passed；`make lint` 54/54 通过（api-node 重新检查，其余命中缓存），范围 `git diff --check` 通过。

## SDK 接入：2026-09-15 Loro Streams HTTP/SSE

用户明确可用 WS 或 SSE，优先复用 SDK，目标是 checkpoint + 追加日志 + 游标恢复，而非继续以热点压测替代实现。核对已发布包后，选择 [`@loro-dev/streams-client@0.7.0`](https://www.npmjs.com/package/@loro-dev/streams-client)。其包含 snapshot、append、offset catch-up、SSE/long-poll API；相较通用 `@durable-streams/client`，snapshot 扩展更贴合本项目。公开仓库 URL 当前返回 404，依据来自 npm 发布包的 README、类型、实现和随包 `docs/ds-protocol.md` / `docs/ds-extensions.md`，不将“官方包”视为完整生产成熟度证据。

- 删除 `eventsource-client` 依赖，自写客户端改为 Loro Streams SDK 适配；SDK 负责 HTTP 读写、SSE 解码、传输重试和重连。Clash 仍负责本地整批持久化成功后保存 opaque offset，以及 Host 故障后的重建。offset 不解析成 Loro 版本或数字。
- Node gateway 实现产品使用的 SDK profile：HEAD、JSON record append/catch-up、latest/specific snapshot、SSE live data。SSE 直接携带日志批次和 control offset，替换原先 hint 后再 fetch 的私有 `/events`/`/log`。Host 通过 `loro-streams-v1` 自动发现；CF 原有 Loro WebSocket 路径保留。
- JSON record 保存 id/base64 更新，PG 中仍存原始二进制。decoded update 上限保持 8 MiB，HTTP body 上限为 12 MiB 以容纳编码；初始大历史分块仍未完成。日志、outbox、checkpoint worker 和鉴权仍是本仓库 PG 适配，并未替换成外部服务。
- 这是所用 SDK 操作的适配，不是完整 Durable Streams 服务。未实现 producer epoch/seq、流创建/关闭/删除、multipart bootstrap 和 long-poll；相关写入头明确拒绝，不能误称已支持 SDK 幂等 producer。重试仍由已有内容校验的 Idempotency-Key 事务保证。checkpoint 发布仅对内部 worker 开放。
- 真实 SDK 集成覆盖直接 append/read、snapshot + tail、已保存 offset 重连、本地 apply 失败不推进、Host 离线历史上传、损坏日志拒绝 checkpoint；隔离测试库模拟已覆盖日志被清理，410 后重新取快照恢复。该模拟不启用生产 GC，也不证明清理后的写入去重策略。

SDK 版真实 PG 双进程验收通过：[结果](validation/cloud-node-2026-09-15/loro-sdk-checkpoint-4000.json)。checkpoint worker 在 SIGKILL 后重启并参与负载；热点/多 Project 每场景各 4,000 条均收敛，快照内容与 committed head 对应的客户端一致，LISTEN 恢复、网关崩溃重试、租约恢复通过。仍是单机功能证据，不做跨轮性能倍数结论。临时 PG 与子进程已关闭，未 build、迁移远端或部署。

SDK 切片最终验证：Node 17、共享副本 17、Local Host 原有链路/故障 4 个测试通过；`make lint` 54/54 通过，范围 `git diff --check` 通过。实际回归使用发布的 SDK 与真实 HTTP/PG，而非仅验证自写协议两端互相匹配。


## 客户端快照计算：2026-09-15

按 Remote Compaction 的职责分工实现：云端 `POST /checkpoint-task` 从 dirty head
捕获 base/target；Local Host 在线后每 10 秒领取，独立 LoroDoc 重放指定前缀，
复用官方 Streams SDK readSnapshot/read/putSnapshot 上传结果。SDK 不负责 PG
租约或发布权限；这些仍由服务端实现。

新增 0006 PG 迁移：每 Project 一个 5 分钟租约，按 task ID、用户和到期时间
隔离旧结果。客户端 4 分钟超时、关闭时取消。没有在线 client 时积压日志，
不阻塞 append。快照与覆盖 cursor 同事务发布，只允许前进；重复完成相同
结果可安全重试。已过期或被替代的任务返回 409。原云端构建器只保留为
`maintenance:checkpoint` 显式维护命令，正常部署无需云端 Loro worker。

客户端使用独立文档，未上传的本地修改不会进入快照。缺口、坏字节和未满足
因果依赖拒绝上传；并发新增日志留在 target 后。云端仍是 opaque store，
信任已准入的快照生产者，不能证明上传内容等于声明的前缀。日志及幂等历史
继续保留，不把上传成功当作日志清理授权。快照上传受现有 12 MiB body limit
限制；大快照分块、恶意生产者验证和修复策略尚未实现。

验证：Node 18 项与共享副本 17 项通过，含真实 SDK/HTTP Host 自动快照、未上传
本地编辑隔离、固定前缀加并发 tail、重复/过期结果、中断和依赖缺失。
真实 PostgreSQL 17.11 双网关验收改用无数据库连接的独立 HTTP 客户端计算进程，
SIGKILL 后重启；热点和多 Project 各 200 条写入，快照内容均与 committed head
对应的收敛客户端一致。[验收结果](validation/cloud-node-2026-09-15/client-checkpoint-200.json)。
这是单机功能回归，不是容量结论。临时 PG 和子进程已清理；未部署或迁移远端。

最终 `make lint` 54/54、Local Host 既有同步/故障回归 4 项通过，`git diff --check`
通过。首轮 lint 发现测试 HTTP body 的 ArrayBufferLike 类型不兼容，改为独立
ArrayBuffer 后重跑通过。未运行 build。

## 多客户端竞争与多网关模拟：2026-09-15

扩展为三个独立 gateway、三个仅通过 HTTP 的快照计算进程、四个并发 writer
会话（独立 Loro 副本，运行在测试进程），共享一个隔离 PostgreSQL。
客户端领取任务后保留活进程，确认 SIGKILL；仅在测试库推进该租约到期时间，
由另一客户端接手，通过另一网关提交旧任务结果必须返回 409。

这轮首次发现真实并发缺陷：claim 的 INSERT/ON CONFLICT 在等待发布事务时，
SELECT 可能已读到旧 base cursor，解锁后仍授予已被替换的快照位置，导致下载
404、快照进度停在未完成租约。修复为按项目共享事务 advisory lock，claim
先获得锁再执行读取 base/head 的语句，publish 使用相同锁；不锁 append 路径。
两个修复前运行均在快照追赶断言失败，不能计入通过证据。

修复后相同规模通过：[完整结果](validation/cloud-node-2026-09-15/multi-client-checkpoint-4000.json)。
热点/多项目各 4,000 次写入，所有会话收敛且快照内容匹配 committed head；
分别耗时 26.76 / 7.50 秒，写完后快照追平约 0.77 / 0.78 秒。运行同时包含
本机测试和质量检查竞争，不用作容量指标。客户端任务接手、旧结果拒绝、
网关 SIGKILL 恢复、LISTEN 中断和 outbox 租约恢复均通过。
Node 18 项测试及 make lint 54/54 通过，临时数据库及所有子进程已清理。
未运行 build 或部署。租约到期通过测试库调整时间模拟，没有实际等待五分钟；
机器断电、PG 高可用、跨机网络/TLS 不在此次验收范围。

## 自主快照发布：2026-09-15（取代任务下发）

用户确认简化为客户端定期主动发布。Local Host 每 10–15 秒（随机延迟）检查
远端日志，已被快照覆盖则跳过；否则在独立 LoroDoc 中恢复 snapshot + 完整
日志页。先观察的 head 只用于结束本轮追赶，最后一页可包含更新日志，上传
cursor 始终使用实际完整导入的页末位置，避免内容与标记不一致。

服务端仅保留准入鉴权、拒绝超过 committed head 的位置，以及原子单调 upsert。
相同/旧位置上传返回成功但不替换现有结果。删除任务接口、租约和 advisory
lock；新增 0007 删除旧任务表，0006 保持历史校验和。重试无需等租约，无客户端
时日志仍可追加。未上传本地编辑隔离、依赖验证、4 分钟超时、12 MiB 快照限制、
准入生产者信任边界和日志保留策略保持不变。

自主版本验证：Node 18 项测试、make lint 54/54 通过。三个网关、三个独立自主
快照进程、四个 writer 会话，热点/多项目各 4,000 次写入全部收敛且快照匹配。
SIGKILL 上传前的客户端后，其他客户端无需等租约即可发布；旧结果通过其他
网关上传被忽略，不回退快照。[结果](validation/cloud-node-2026-09-15/autonomous-snapshot-4000.json)。
测试期间并行运行质量检查，耗时不用于比较架构性能。隔离 PG 与子进程已清理；
未 build、远端迁移或部署。

### Timing 与建模边界

自主快照建模为调度器 + 一次候选生成/发布尝试 + 服务端单调存储。
候选只有 bytes 与实际完整应用的 coveredOffset。周期仍为 10–15 秒；每次尝试
在初次 HEAD 前和候选生成后各增加 0–1 秒可取消随机延迟，上传前再次 HEAD，
若远端快照已覆盖候选则不传输 body。检查后发生竞争仍由服务端原子 upsert
保证不回退。扰动只降低重复计算/上传，不参与正确性与权限。

本次 Node 18 项、共享副本 19 项通过；新增假时钟回归覆盖延迟生效、竞争者
已发布后跳过 PUT、等待期间取消不发送请求。既有真实 HTTP 测试覆盖正常上传。


### 降低快照维护频率

按用户要求进一步降低服务端维护状态和请求频率：常态客户端检查间隔由
10–15 秒改为随机 4–6 分钟，首次连接仍尝试一次。周期由客户端计时，不新增
服务端 scheduler、任务归属或 last-run 状态。快照用于缩短恢复重放；日志追加
与持久性不等待下一次快照。生成前与上传前的 HEAD、短扰动和原子单调发布保持。


用户继续要求降低频率，最终常态间隔为随机 30–60 分钟（取代上面的 4–6 分钟）。
首次连接检查及有新增才计算保持；日志仍实时持久化，取舍是快照间的恢复重放量更大。


用户最终指定 10 分钟起步：常态间隔确定为随机 10–15 分钟。日志量按实际
追加速率与序列化字节数评估，不能把随机 1 KiB 压测 payload 等同于生产日志大小。


## 最终收敛：Node 后台异步快照（2026-09-15）

用户选择开发与状态管理更简单的后台合并方案。恢复 `worker:checkpoint` 正常
入口，启动后扫一次 dirty heads，此后默认每 10 分钟扫一次；
`CHECKPOINT_INTERVAL_MS` 显式覆盖间隔，集群测试使用 1 秒。
复用既有 buildProjectCheckpoint：旧快照 + 捕获目标以内的分页日志，检查
游标缺口和未满足因果依赖，原子发布 snapshot/cursor，仅允许位置前进。
多个 worker 可以重复计算，不新增任务表、租约或计算者归属。失败项目不会
阻塞其他项目，追加日志不等待快照；历史与幂等事件仍保留。

移除客户端快照生产函数、计时器、随机扰动、上传前握手和公开 snapshot PUT。
SDK 保留 append/read/SSE/snapshot bootstrap；本地工作副本的持久化与权限模型
不变。0006/0007 保留历史校验和，任务表已由 0007 清除，无新 schema 迁移。

验证：Node 17 项、共享副本 17 项通过。新增/调整 HTTP 回归确保 admitted client
也不能直接上传覆盖云端 checkpoint。已有后台测试继续验证并发 tail、中断、
缺口/依赖失败和快照不回退。真实 PG 17.11 三网关、两个后台 checkpoint worker、
四个 writer 会话，热点/多项目各 4,000 次写入收敛且快照内容与 committed head
一致。worker SIGKILL 后重启、网关恢复、LISTEN 和 outbox 故障路径通过。
[后台版结果](validation/cloud-node-2026-09-15/backend-snapshot-4000.json)。
测试是单机功能验收，运行时使用 1 秒扫描间隔，不是生产容量或十分钟等待验收。
临时 PG 和子进程已退出；未 build、远端迁移或部署。

最终 make lint 54/54、Local Host 既有同步/故障回归 4 项、git diff --check 通过。


## 接入现有持久任务执行器（2026-09-16）

用户要求复用 durable 调度，选择其允许的“追加日志时按 offset 发起任务”路径。
仓库已接通的 cron 是 CF scheduled；Node 本轮复用既有 PG outbox，不冒称接上
CF Workflows 或生成专用 DurableRunEngine，也不声称提供通用 Node cron 注册 API。

0008 扩展现有 outbox 的 kind，并对 checkpoint 建每项目唯一索引。日志、通知、
checkpoint 意图同事务提交。每项目仅一条待处理 checkpoint，后续追加只推进
cursor，不延后首个任务的十分钟到期时间。迁移同时为已有 dirty heads 补任务。
既有 worker:outbox 分别领取通知和 checkpoint；后者单项 claim、五分钟执行租约。
失败保留任务，重启后重新领取；完成后用实际覆盖 cursor 与 lease ID fenced ack。
并发 tail 未覆盖时保留 successor，延迟十分钟再次执行。删除 checkpoint-worker.ts
及 worker:checkpoint 命令，不再维护独立扫描循环。事件及幂等历史继续保留。

验证：Node 18 项通过，新增回归验证延迟合并、计算期间追加、旧 lease ack 拒绝、
失败保留及 checkpoint 意图写失败导致整个 append 回滚。make lint 54/54 通过。
真实 PG 三网关、两个现有 outbox 执行进程、四 writer 会话，热点/多项目各
4,000 次写入收敛，快照内容匹配 committed head；网关、LISTEN、执行器重启及
租约恢复通过。[结果](validation/cloud-node-2026-09-16/durable-checkpoint-4000.json)。
测试仅推进未领取 checkpoint 的 due time，不缩短活动租约；不声称实际等待
十分钟。临时 PG/子进程已清理，未 build、部署或执行远端迁移。

## BullMQ PostgreSQL 执行适配（2026-09-17）

Node 已接入 BullMQ 6.3.6 的 PostgreSQL backend，无 Redis/DBOS/Conductor。
CF 与 Node 复用共享 cloud coordinator、journal 校验和 DurableRunEngine；
Local 继续使用自己的 coordinator 驱动同一业务引擎。Node Flow 分为 provider、
stage、publish，初始 run 与 dispatch intent 同事务落库，稳定任务 ID 覆盖重复交付。
BullMQ 管调度与依赖，业务 journal 管 CAS、恢复和产品终态。

现有 worker:outbox 已把 checkpoint 意图交给 BullMQ，worker thread 负责 Loro
合并；通知 outbox 保留。日志仍按首个待处理追加延迟十分钟，后续追加推进目标，
不持续推迟到期。handoff ACK 表示入队成功，实际覆盖以 checkpoint cursor 为准。

Node 19 项、共享引擎 23 项、CF coordinator 7 项、D1 journal 2 项、真实 PG
BullMQ 2 项通过。三网关、两 worker、四 writer 的 8,000 次追加及故障恢复验收通过。
生成验证包括重复 dispatch、延迟轮询、失败投影重试和 staging 后 SIGKILL 恢复；
快照验证包括存储失败后无新追加的自动重试。详见
[验证与边界](validation/cloud-node-2026-09-17/README.md)。

Node 生成执行适配器尚未接入真实 Provider 凭据、对象存储、Project publisher 和
授权 HTTP admission；当前 CLI 启动的是 checkpoint consumers。不能据此宣称
整个 Node 生成产品可上线。有限重试后的运维恢复与任务保留策略也仍待接线。

本轮最终 `make lint` 54/54、目标文件格式检查与 `git diff --check` 通过。

## 账号入口与生成业务流程解耦（2026-09-17）

共享层进一步接管 hosted generation 冻结输入/路由、准入顺序、重试分类和
lifecycle hooks；CF runtime 改为平台适配，Node generation service 绑定同一流程
与 PG journal/outbox。Node 实际 HTTP 入口已接 Better Auth PG 邮箱密码登录和
session-only token 管理。真实账号签发两枚设备 token 后，项目准入与 Loro 跨设备
更新回归通过；跨站、跨账号与撤销/退出验证通过。CF 15 项、Node 20 项、共享
pipeline 1 项、make lint 54/54 通过。

仍未完成 Node 真实 Provider/输出存储/Project 发布及生成 HTTP 接线，未部署。
[本轮证据与边界](validation/cloud-node-2026-09-17/launch-wiring.md)。
