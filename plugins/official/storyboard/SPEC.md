# Storyboard 插件规范

本插件遵循 [View、素材引用与 Generator 协议](../../../apps/docs/plugins/view-generator-spec.md)。该文档是引用语义、Canvas 投影、SDK 和生成生命周期的唯一协议入口；不在此复制另一份规则。

## 本包声明

- Manifest 的唯一贡献是 `views/storyboard.json`，协议为 `clash.view/v1`，`presentation.type` 为 `storyboard`。
- View 初始状态包含空的 `keyElements`、`shots`、`audioLayers`、`uncategorized`。结构和资源引用由共享 schema 校验。
- 本包不贡献 Generator 或执行器，也不捏造 Storyboard 父 Run。素材由实际 Generator 产出或导入后引用。
- 资源直接存于素材槽的 `candidates` 或 `uncategorized`，使用 `PluginViewResourceSchema`。所有候选都是消费引用，`selectedCandidateId` 只表示采用版本。
- 插件不保存第二份引用数组、不自行写 Canvas 关系边。Host/客户端通过共享协议枚举引用，再投影同 Canvas 的素材 → View 连线。

## 原生界面集成

列表展示条目、描述和候选；生成与素材编辑放在 Preview。通过 `@clash/action-sdk/ui` 复用 `GeneratorComposer`、`GeneratorOutput`，不重造参考输入、参数面板、pending 状态或完成资源结构。

Edit 在当前 Preview 下半部分展开 Composer，保留上方预览和组件自身边界；Prompt 恢复实际生成配置；Regenerate 直接重新提交。Reference 通过 Host 将当前 Asset 的结构化引用加入该 Project/会话的聊天草稿并展开 Chat；不提交消息，不改变素材槽，不依赖已安装的 Generator。条目编辑只修改组织状态。

“添加素材”只提供生成和打开现有素材面板两条路径。打开入口、选择生成类型、关闭 Composer 或取消选择都不创建素材槽；只有选中真实 Asset 或生成提交成功、取得 pending Run 引用后才写入目标条目。新增素材的类型来自所选 Asset 或真实 Generator 输出，不能把图片条目的默认类型强加给视频。选择器复用宿主的 `ScopedAssetPicker`（含本地导入），生成复用 SDK Composer。已有候选的“新版本”仍追加到原槽，并限制为该槽的素材类型。

空 Preview 只提示选择素材，不展示无目标的 New version、Prompt 或 Regenerate。旧界面误存的无内容默认槽不展示为空行，也不因此删除持久化数据；有自定义名称或提示词的计划槽保留可执行的添加入口。选择已有资源保留其真实生成来源，取消操作不改变已选预览或引用。

提交后保存 pending Run/输出槽引用，选中 pending 可预览。结果提交后追加资源候选，保留真实生成来源，不覆盖其他候选或采用版本。当前素材槽回填在页面挂载/重开时恢复；持续关闭页面的 Host 后台关联仍属于协议第 7 节的未实现扩展。

## Agent 与 GUI 的同一执行路径

Harness 使用随 Clash 插件交付的 generation/views 指引发现实时 Definition 和请求 schema。通过公开 MCP 或同等 CLI 读取 View 与素材，向真实 Generator Revision 提交 Action，跟踪原 Run，再读取 Output Commit 与 Asset。只有已提交的 Asset 才写入候选，保留 `generatedBy` 的完整身份链；采用版本是单独的 View 状态更新。不能让 agent 通过全局生成工具或直接写持久层制造看似相同的结果。

Shots 的结构化 `entity-reference.entityId` 保持稳定；GUI 以当前条目名称展示，重命名不会破坏引用，无法解析的旧引用保留 ID 以便识别。Audio layers 的素材引用、说明和采用版本不等同于已执行混音或 Timeline 编排。

验收必须独立覆盖 Key elements、Shots、Audio layers 和 Uncategorized，并包括至少一次真实 harness 的引用输入 → Run → Output Commit → Asset → 候选/采用 → Canvas 投影回读。记录真实时长等媒体元数据，不能仅凭 Run 成功判断结果符合请求；未执行的生成、混音或 Timeline 流程明确标记未验收。

## 变更验收

遵守协议第 6 节，特别检查人物与道具不串槽、未选中候选仍有引用、pending 不变成假 Asset、引用增删与 Canvas 一致、重开后的状态与来源保留。插件发布必须通过包校验，不能把第 7 节的设计字段提前写入严格 v1 声明。
