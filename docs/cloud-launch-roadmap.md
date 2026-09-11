# 云端上线 Roadmap：按证据逐阶段放行

创建日期：2026-09-11。审计基线：`1315eb6d`。

目标：先验证个人多设备同步与 BYOK 的受邀内测，再扩展多人协作和托管生成。本文是执行与验收计划，不改变现有领域契约，也不代表生产环境已经验证。

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
| 准入与授权 | User / Tenant / Project、角色、准入状态 | Node HTTP 服务、SQL 事务 | Worker HTTP、D1 |
| 项目同步 | Loro 协议、事件持久化、checkpoint、确认语义 | 持久事件日志、WebSocket 会话、跨实例分发 | ProjectRoom DO、事件日志与 checkpoint |
| 资源交付 | Resource 身份、签名能力、摘要与归属 | 对象存储或持久文件系统适配，G0 决定拓扑 | R2、Resource resolver |
| 长任务 | Run 身份、CAS、重试、取消、幂等发布 | 持久 journal 与 scheduler/worker，G0 核验实现 | Workflow、journal、Container |
| 发布恢复 | 同一数据完整性与恢复验收标准 | Node 进程/实例替换、持久存储、滚动升级 | Worker/DO/Workflow 更新、迁移与恢复 |

建议实现顺序：共享契约与权限回归 → 各端最小上云闭环 → 各端故障与发布验收。不得为了两端一致而在 Node 上模拟整套 DO，也不得在两端复制准入、CAS、费用与资源状态机。适配层只承担运行时、存储、传输与调度差异。

每个 Gate 分别记录 `fly-node` 和 `cloudflare` 状态；一端通过不代表另一端通过。允许先放行已通过门禁的平台，但必须注明发布支持范围。暂不要求两个云后端互相复制或跨云迁移；这不属于双部署支持的隐含要求。

- [ ] G0 找到或建立 Node 云服务端入口、镜像与 Fly 部署配置；本次仅查到 render-server Dockerfile，尚未核验 Node 云端完整发布入口。
- [ ] 两端分别建立隔离测试环境，登记 SQL、资源存储、事件日志、调度和秘密管理的实际选型。
- [ ] 同一套黑盒用例通过 base URL/凭证选择平台执行，不能为某平台放宽权限、CAS、资源完整性或重试断言。
- [ ] Node 多实例支持必须额外验证两个实例同时服务同一项目、连接迁移、任务重复领取与跨实例通知；若首版只支持单实例，明确容量与恢复边界后才放行。

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
