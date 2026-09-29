# View、素材引用与 Generator 协议

状态：2026-09-16。第 1–6 节描述已实现的 `clash.view/v1`、共享引用读取和原生 SDK 契约；第 7 节列出尚未实现的调用扩展。Manifest、SDK 和 Storyboard 插件规范以本文为同一个引用语义入口。

## 1. 对象与数据归属

| 对象                          | 唯一负责的事实                                           |
| ----------------------------- | -------------------------------------------------------- |
| Plugin                        | 分发 View、Generator Definition、执行器等贡献            |
| View 状态                     | 组织条目、素材引用、候选集合及采用版本                   |
| Generator Revision            | 固定实际生成配置及持久输入                               |
| Action Run                    | 固定本次 Action、Revision、调用输入与参数                |
| Output Commit / Project Asset | 记录真实生产者与不可变产物                               |
| Canvas placement / edge       | 呈现这些对象及其关系，不重新生产素材或持有第二份引用清单 |

Storyboard 不定义自己的资产输出契约，因此不是 Generator。插件同时贡献 View 和 Generator，也不意味着 View 是 Generator 实例。Director Stage 的 capture-frame 有真实图片输出，其 Generator 建模不用于推导 Storyboard 的身份。

```mermaid
flowchart LR
  revision[Generator Revision] --> run[Action Run]
  run --> commit[Output Commit]
  commit --> asset[Project Asset]
  state[View 状态中的 Resource] -->|消费 projectAssetId| asset
  state --> refs[协议共享引用读取]
  refs --> graph[Canvas 素材 → View 连线]
  refs --> sdk[Plugin SDK]
  graph --> gui[GUI / CLI / 自动排版]
```

生成来源、View 消费关系、采用版本和生成输入是不同事实：保存候选不会创建 Run；选择候选不会改写生产者；被 View 引用不代表自动成为下一次生成的输入。

## 2. 引用的声明与读取

当前 `clash.view/v1` 只支持 `presentation.type: "storyboard"`。该声明同时选择已发布的结构化状态契约；不按插件名称猜格式，不支持在任意 JSON 字段中藏引用。新的 presentation 或状态格式必须先扩展共享协议及其读取器。

一个资源声明如下：

```json
{
  "id": "lamp-version-a",
  "projectAssetId": "asset-lamp-a",
  "mediaKind": "image"
}
```

- `id` 标识所在集合中的引用项，供候选选择和稳定寻址使用；它不是 Asset ID 或 Canvas node ID。
- `projectAssetId` 是被消费的不可变 Project Asset。文件名、预览 URL、模型名称和节点位置都不能替代它。
- `mediaKind` 必须符合素材槽的类型。
- 导入素材可以没有 `generatedBy`。已生成素材保留实际 `generatorId`、`generatorRevisionId`、`actionRunId`、`outputCommitId` 和可用的 `outputSlot`；这些字段是来源信息，不是另一个消费关系或 Storyboard 父 Run。

以下位置的所有资源都是持久消费引用：

| 状态位置                                 | 引用位置身份                               |
| ---------------------------------------- | ------------------------------------------ |
| `keyElements[].materials[].candidates[]` | section / itemId / materialId / resourceId |
| `shots[].materials[].candidates[]`       | section / itemId / materialId / resourceId |
| `audioLayers[].materials[].candidates[]` | section / itemId / materialId / resourceId |
| `uncategorized[]`                        | section / resourceId                       |

**未采用的候选仍然被引用。** `selectedCandidateId` 只选择同一槽中的候选；改变选择不会删除其他候选的引用。重命名、排序、折叠和预览焦点也不会改变这些关系。

`description` 中的 `entity-reference` 引用 View 内的条目；`promptDraft` 是作者文本；`pendingOutputs` 引用未完成的 Run/输出槽。它们都不能被当成已经存在的 Asset。

引用只存于上述状态。插件不额外保存一份 Asset ID 清单，也不自行写 Canvas 连线来“声明”消费。`PluginViewResourceSchema` 定义资源，`ExecutablePluginViewStateSchema` 定义当前状态，`listPluginViewAssetReferences(state)` 枚举资源及稳定位置。枚举保留同一素材的多处使用，消费者可以按自己的显示需要去重。

共享 Canvas 创建/更新和 Project View 创建路径在写入前校验状态；无效状态不能替换现有引用。已有原始数据若不能通过解析，图读取不猜测字段或补造引用；这不等于该数据有效。结构校验和图投影均不授予 Asset 访问权，也不替代 Host 的资产解析和权限检查。

## 3. Canvas 投影规则

Canvas 的公共边读取与节点 upstream 读取必须使用协议引用枚举，GUI、CLI、不可变性检查和自动排版看到同一关系图。

1. 按 `projectAssetId` 匹配 View 所在 Canvas 上已存在的 image/video/audio/model placement。
2. 方向为 **素材 placement → View**，类型为 `reference`。每个 source/target 对仅出现一次；同一 Asset 的多个实际 placement 各自形成对应连接。
3. 已有显式连接优先展示，不能叠加重复线。删除该显式线不会消除仍存在的 View 素材引用。
4. 缺少 placement 或仅在其他 Canvas 上有 placement 时，状态中的引用继续存在，但不虚构节点、不跨 Canvas 连线。以后出现匹配 placement 时即可投影。
5. 增删引用在下一次读取中反映；删除 View 后其消费投影消失。候选选择或排序不影响连线身份。
6. 投影边 ID 使用保留前缀 `view-asset-reference:`。它是图的派生身份，不得写入 `nodeUpstreams` / `edgeIdentity`，也不参与存储边迁移。
7. 派生线不能独立删除或重接。需要变更消费关系时编辑 View 状态；GUI 禁用这些边的删除与重接，Canvas 写入路径也拒绝该操作。

共享图中这些边同样参与已有 downstream/COW 规则。编辑消费方仍遵守既有读观察和 CAS；不能用直接删线绕过引用保护。自动排版只改变 placement 几何信息，不能修改素材、View 状态或生产关系。

当前已存的 v1 项目可以直接读取，无需重写资源、重跑生成或补写边。撤销/重做和重新打开项目都从当时的状态重建投影。

## 4. SDK 与生成生命周期

无 React 的插件代码使用现有 `@clash/action-sdk/browser` 入口：

```ts
import {
  ExecutablePluginViewStateSchema,
  listPluginViewAssetReferences,
} from "@clash/action-sdk/browser";

const state = ExecutablePluginViewStateSchema.parse(savedState);
const references = listPluginViewAssetReferences(state);
// reference.resource.projectAssetId 是消费身份；location 用于定位原引用项。
```

该入口和 Node SDK 导出同一份共享契约；不存在第二套 SDK 素材结构。`StoryboardViewResourceSchema` 是保留兼容名称，指向 `PluginViewResourceSchema`。

React 集成从 `@clash/action-sdk/ui` 使用 Host 提供的 `GeneratorComposer` 和 `GeneratorOutput`。执行器/stdio 插件不导入 React。

- `GeneratorComposer` 接收 `generatorId`、可选 `actionId` / `onClose` 和 `onExecuteRevision`。Host 保存编辑后的 Revision，再回调 `{ generatorId, generatorRevisionId }`。参考缩略图、提示词及参数控件由原生 Composer 提供；打开编辑器不创建 Canvas placement。
- `GeneratorOutput` 接收 `PendingGeneratorOutput`：实际 Generator、Revision、Run、输出槽与媒体类型。提交得到 Run 回执后可以持久保存该引用，但不得制造临时 Project Asset ID。
- `onReady` 只返回已提交的媒体资源，复用 `PluginViewResource` 契约且携带完整生成来源。当前集成追加候选、移除匹配的 pending 引用，不改变已采用版本。此时共享关系读取才能得到新增 Asset 消费关系。
- Pending 缩略图支持 `onPreview`，`presentation="preview"` 展示同一 Run。提交后聚焦 pending，完成后仅在仍预览该 Run 时切换到结果，避免覆盖用户后续导航。

原生 Run 提交的可选 `canvasPlacement: { canvasId, nodeId, actionCardId?, label? }` 负责生成链的 Canvas 呈现。Host 校验实际 Generator/Action 与 Action Card，在 Run checkpoint 中组织输入 placement、Generator placement 和 pending 输出。发布时按真实 Output Commit 解析，重放提交不重新生成，也不重复创建已有节点。它与 **素材 → View** 的消费投影是两种关系，不能相互代替。

## 5. GUI 与 Agent 的语义

Storyboard 列表组织条目和候选；素材生成/编辑集中在 Preview。Edit 在现有 Preview 下方展开原生 Composer；Prompt 从实际生成版本恢复配置；Regenerate 直接提交记录的原始 Revision，保留该次调用输入与参数。

View 素材成为生成参考必须通过显式输入映射进入实际 Generator。既不能把所有候选都传给生成器，也不能仅因存在 Canvas 连线就推导输入。浏览、采用、消费和生成输入必须分别处理。

聊天引用的协议要求是：把结构化素材引用加入输入，不自动发送消息，不改变 View 消费关系，也不声称 Agent 发起了原生成。Storyboard Preview 的 `Reference` 通过 Host UI 回调，把当前 `projectAssetId`、素材类型和名称加入当前 Project/聊天会话的未发送草稿，同时展开聊天。它独立于 Generator 是否安装，已归类与未归类素材均可使用。延迟挂载聊天编辑器不能丢失引用，切换 Project/会话不能把引用写入另一个草稿；发送时转换为 `CopilotProjectAssetReference`。View 的素材来源记录与当前聊天是否展示结果卡片也是两回事。

Agent 可以通过共享 Canvas 读取状态和 upstream；SDK 可枚举引用及所在位置。这不代表已经有“枚举该 View 可用生成操作”的 Host API。不同入口不能通过猜测当前 GUI 焦点选择目标或伪造父 Generator。

## 6. 协议验收

验证应贯穿状态、SDK、共享图和实际安装版，而不是各自维护一份预期关系清单：

- 候选、音频层和 uncategorized 引用进入共享图；未选中的候选不能漏掉。
- 同一素材多处使用不产生重叠边；重命名、排序和采用版本切换不改变引用。
- Pending、实体提及和文本不伪造 Asset；缺失 placement 不伪造节点。
- 引用增删、跨 Canvas、旧显式边、重开项目、撤销/重做保持上述语义；生成链保留。
- 结构无效的创建/更新失败前不改变项目，边级删除/重接不能脱离资源状态。
- SDK 与 Canvas 使用同一枚举器；公共 graph / upstream / layout 读取不形成第二份存储权威。

源码契约在 `packages/shared-types/src/executable-plugin.ts`；Canvas 投影在 `canvas-view-references.ts`，公共图读取在 `node-upstreams.ts`。行为验收在 `canvas-view-references.test.ts`、GUI 同步测试和安装版验收记录中。

## 7. 尚未实现的调用扩展

以下是后续协议工作的边界，**不是当前 v1 可填的 manifest 字段，也不是已经开放的 API**：

- 机器可读的 View 操作声明：稳定 operation ID、目标 section/itemId/materialId、真实 Definition/Action、输入映射与输出槽。插件激活和提交均需校验依赖与端口；GUI 和 Agent 使用同一 Host 解析路径。
- 目标与实际 Generator 实例的显式关联；不能从当前预览候选猜下次调用配置。执行时固定 Revision、输入和参数，运行中不重读可变 View。
- Host 持久记录提交与目标关联，完成后幂等回填。当前 Storyboard 通过已保存 pending 引用在页面挂载/重开后恢复；页面始终关闭或已删除时，Host 不会独立完成素材槽分配。Canvas 输出发布已由 Host 处理，两者不能混称。
- 持久关联需覆盖并发、CAS/COW、重命名/重排、删除目标、Host 重启和重复事件。关联失败只重试关联，不再次生成，不把结果交给同名目标或副本。
- 会话主动发起或明确订阅的活动才自动进入该会话；不能注入任意打开的聊天。原始 trace、凭据和机器私有信息不写入共享 View 状态。

这些扩展继续调用原生 Generator，不引入另一套 View Run、输出资产、执行器或生产者。落实时必须同时交付共享 schema、Host、SDK、CLI/MCP 和 GUI，而不是把自然语言说明当作可执行契约。
