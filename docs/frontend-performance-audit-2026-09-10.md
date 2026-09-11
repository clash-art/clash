# 前端性能检查 — 2026-09-10

本轮沿着工作区切换、画布更新、协作广播、浏览器页签、插件发现和媒体资源生命周期检查。约束是保持现有外观、预览内容、交互、后台任务和状态恢复行为。没有引入缩小时的内容降级，也没有修改布局、缩略图画质或播放策略。

## 已修复

| 位置 | 原有开销 | 本轮处理及验证 |
| --- | --- | --- |
| `PresenceAwarenessContext.tsx`、`nodes/AttributionLine.tsx` | 光标广播更新整个 Context，使无关卡片和作者标签重渲染 | Context 保持稳定，订阅节点对应的参与者或单个作者名；光标、选区、名称变化仍正常发布。1,000 卡片测试中，连续三次光标广播不再重渲染无关卡片。 |
| `hooks/useLoroSync.ts` | 写入虽延迟，但每次修改都立即导出全量快照；全局定时器还会让不同项目互相取消保存 | 序列化和写入一起合并，定时器归属单个文档，切走前导出待保存状态。测试中三次连续修改从三次立即导出变为一次延迟导出；切走前导出的真实 Loro 快照能恢复最后内容，两个项目各自保存。 |
| `hooks/useExecutablePluginActions.ts`、`useExecutablePluginViews.ts` | 每次轮询都发布新数组，即使目录相同，工作区仍刷新 | 保留刷新频率、验证和失败后保留旧目录的行为，仅内容变化时更新状态；测试覆盖重复响应和真实名称更新。 |
| `ProjectBrowserSurfaces.tsx` | 工作区更新或切换页签，会重渲染所有网页外壳并反复移除、添加事件监听 | 对每个页签独立 memo，并稳定事件回调。测试验证原 webview、未完成的地址输入和隐藏页签的标题事件均保留；切换不再重绑监听。 |
| `copilot/CanvasAnnotationPinLayer.tsx` | 离开画布后，标注仍逐帧查询元素和读取布局 | 非画布视图停止测量，返回时立即恢复。测试验证隐藏期间没有布局读取，返回后标注位置和点击仍工作。 |

## 生命周期检查结果

- **画布**：React Flow 的视窗裁剪已经开启。非画布视图通过 CSS 隐藏画布，其内部还包含 `CascadeRunnerMount`。直接卸载会同时卸载生成调度，因此本轮保留该生命周期，单独停掉不必要的展示层测量。
- **时间线、导演视图**：只为当前选中视图挂载。时间线退出时执行保存清理；导演动画循环有清理。没有再添加一层卸载机制。
- **浏览器**：所有已打开页签保留 webview 是现有产品合同。直接卸载会重新加载网页，丢失页面内输入、滚动及运行状态；本轮消除 React 层重复工作，保留网页生命周期。
- **音频、视频预览**：检查了音频按需波形解码、请求取消、媒体监听清理及视频封面的对象 URL 回收。保留现有播放和封面生命周期。
- **Agent 与同步**：未暂停生成调度、流式消息、WebSocket 心跳和项目同步。切走视图不应影响后台工作。
- **应用外壳、资源列表和提示**：进行了代码检查，没有凭静态代码推断就改为列表卸载、清空资源缓存或暂停通知计时；这些操作需要分别验证滚动、拖放、键盘导航和状态恢复。

## 验证

- 本轮直接相关的 8 个测试文件：57 项通过。
- 扩展回归：61 项通过，1 条既有的菜单源码断言失败。该断言仍要求 `DropdownMenu` 包含旧的 `key={item.id}` 结构；移除本轮对 `ProjectEditor` 的唯一新增属性后，断言仍失败。本轮未修改菜单以迎合旧测试。
- `@clash/web-ui` TypeScript 检查通过，`make lint` 通过，`git diff --check` 通过。
- Impeccable 对本轮组件改动的机械检查没有发现问题。
- Chromium 基准页：320 节点在同一视窗挂载 21 个节点、6 个完整文本预览；本轮修改前后截图 SHA-256 完全一致。
- 浏览器测试是合成场景，不能代表所有真实媒体、真实协作网络或 Electron 页面的性能。没有将本轮结果换算成未经测量的 FPS 或总体提速百分比。

## 后续需要单独测量的方向

若仍需降低多视图驻留内存，应先把画布中的后台调度与展示树解耦，再验证缩放、选区、未提交输入、撤销历史、弹层和媒体状态恢复。只有这些行为保持后，才适合卸载非活动画布。浏览器网页销毁不属于无体验变化的优化。

## 追加执行 Impeccable optimize

- `GroupNode.tsx`：分组仅在选中时订阅缩放值，不再订阅平移坐标。真实 React Flow store 与 React Profiler 测试中，100 个分组连续平移三次的组件提交从修改前 300 次降至 0 次；选中后的按钮尺寸、布局及解组行为仍正常。
- `useAsset.ts`：资源刷新返回相同的 Host JSON 时保留缓存对象并跳过通知。URL、元数据、状态和错误变化仍立即发布；测试验证未变化资源的消费者不重渲染。
- 本次直接回归 3 个测试文件、31 项通过；TypeScript 检查、`make lint` 和 `git diff --check` 通过。Impeccable 机械检查无发现。
- 同一 Chromium 分组基准场景前后截图 SHA-256 完全一致。该场景只验证分组外观，组件提交计数不等同于实际 FPS 或全应用提速比例。

## 重新按 optimize 流程检查代码

`optimize` 是检查、修改和测量的工作流程，不是运行检测器就能自动完成的优化命令。此前对整体优化和体验验证的表述过宽。本次从代码调用链区分已证明的问题与静态检查发现。

| 检查路径 | 代码结论 | 本次处理 |
| --- | --- | --- |
| `ProjectEditor.tsx` → React Flow → 节点组件 | 视窗裁剪已开启；节点引用协调、Copilot 数据投影和几何计算已有优化。分组订阅已经仅在选中时响应缩放。 | 保持现有裁剪、预览与交互行为。 |
| `DraftPlaceholder.tsx` → `buildPlan.ts` → `computeActionBuildPlan` | selector 每次收到 React Flow 状态都会遍历上游 DAG，随后才比较计划是否相同；React 没有提交不代表没有计算。 | 按节点、连线数组的引用缓存计划。核对了已安装 React Flow 的 `setNodes`、`setEdges`：lookup Map 原地更新，因此不能用 Map 引用作为缓存依据。 |
| `useLoroSync.ts` → `LoroSyncContext.tsx` → 卡片 | hook 返回值已 memo；快照序列化合并，卸载会处理待保存状态。整个同步 Context 仍包含连接、撤销、时间线等字段。 | 本次未拆分 Context；没有完整的消费者更新测量，不能据此宣称这里已经没有开销。 |
| `ProjectEditor.tsx` → 资源补全 effect、资源关系图 | 资源补全 effect 依赖整个 `nodes`，几何变化也会触发清理和重新监听；关系图的全量文档读取同样依赖 `nodes`/`edges`。 | 记录为后续优先测量项。本次未调整通知时机，尚无请求计数或完整编辑器性能数据证明影响程度。 |
| `ProjectWorkspaceSurfaces.tsx`、`ProjectBrowserSurfaces.tsx`、`BrowserSurface.tsx` | 时间线按选择挂载、延迟加载并处理保存；浏览器保留页面状态且清理原生监听。隐藏画布仍承载后台调度。 | 保持生命周期；无足够证据支持额外卸载。 |
| `ImageNode.tsx`、`VideoNode.tsx`、`AudioNode.tsx`、`VideoPoster.tsx` | 图片走 Asset 投影；视频优先 Host 封面并回收临时 URL；音频采用 Host 波形，回退解码可取消并关闭 AudioContext。 | 保留媒体内容、画质、播放和解码时机。 |
| `useAsset.ts`、插件目录 hooks、Presence store | 相同资源投影和相同插件目录已有去重；参与者按节点或作者订阅。 | 本次回归覆盖前一轮资源和分组优化。 |

### 本次修改及证据

- 40 张串联草稿卡片，在真实 React Flow store 中执行 60 次平移/缩放和一次选区模式更新：修改前调用真实构建计划函数 2,440 次，修改后为 0。spy 仅记录调用，未替换计划计算。
- 行为测试使用真实卡片、对话框和 React Flow store，验证上游完成、提示词清空与恢复、循环连线的添加与移除、卡片目标切换，以及确认构建只提交剩余草稿。
- 相关 6 个测试文件共 39 项通过。这是组件与 store 集成测试，不是完整编辑器的 FPS、内存或网络基准。
- 当前 `@clash/web-ui` TypeScript 检查、`make lint`、`git diff --check` 均通过；Impeccable 对本次改动的机械检测无发现。
- 重新检查原基准页发现：其中“已完成图片”只有 `previewUrl`，缺少实际 `assetId`；当前图片节点从 Asset 投影读取内容。该场景不能作为真实图片预览或解码性能的证据。此前仅分组场景的截图一致结论仍成立。

## Follow-up: membership, hydration and diagnostic overhead

This pass leaves node markup, preview resolution, interactions, playback and workspace retention behavior unchanged.

- `liveProjectAssets` subscribes to the Project Asset membership container rather than every document commit. On an actual Loro document, 60 unrelated node commits previously serialized Asset membership 60 times; the updated behavioral test observes zero. Membership changes, imports, checkout/attach and disposal remain covered.
- `useProjectAssetHydration` owns in-flight projection watches per Project/document and Asset ID. Thirty geometry updates previously restarted 30 HTTP reads; the updated hook test observes zero additional reads while the existing readiness poll still publishes the completed Asset. Adding/removing targets, metadata changes, project switches, late responses, error retries and unmount cleanup are covered.
- JSONL sinks no longer scan the directory for each record. The real-file test writes 30 further records into an open segment and observes zero additional directory scans, while preserving rotation, retention and process run identity.
- Canvas, sync, resource, desktop and Host lifecycle diagnostics now share a record contract and bounded duplicate handling. The offline `clash logs` command was exercised against the current development profile. See [local logging](local-logging.md) for directory and query details.

These measurements establish removed computation/requests/filesystem work, not an end-to-end FPS improvement. This pass did not change the asset relation graph projection or unload stateful browser/workspace views; those need separate evidence before lifecycle changes are justified.

Validation for this follow-up:

- Shared logging/query/capture: 15 tests passed; desktop logging/path/window integration: 25 passed; CLI offline query: 3 passed; dispatcher: 7 passed; Host action-loader behavior: 20 passed.
- The 149-test web batch initially had two failures: a new hydration retry fixture and the pre-existing menu source assertion. The fixture now uses a terminal HTTP rejection because network failures are retried inside the SDK; all six hydration tests and both ReactFlow diagnostic tests then passed. The stale `ProjectEditor.performance.test.ts:104` assertion still expects a keyed per-item dropdown that the current menu no longer contains. No product UI was changed to satisfy it.
- Web UI typecheck, focused shared logging typecheck, browser-only logger bundle smoke check, and required `make lint` passed. The general Host/shared-runtime typecheck also encounters existing dependency declaration drift outside these logging modules; no build was run.
- The newest live development Host segment contained four versioned records, all with process run IDs (`process.started`, `plugins.rebuilt`, `host.listening`, `server.ready`). The running desktop main process still uses its previous logger until the next application launch. No window restart was performed for this pass.
