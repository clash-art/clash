# Home / Marketplace GUI 修复记录

日期：2026-09-09。来源：用户在 Clash Dev 中提供的三张截图和反馈。

## 目标

完成以下三项 GUI 修复，在运行中的桌面开发环境验证；保留真实的导航、安装、搜索、过滤与安装状态行为，复用共享组件和页面布局契约。

## 问题与验收

### 1. Marketplace 卡片悬停样式割裂

- 现象：内容区变灰，底部安装状态区仍为白色；普通悬停出现突兀的蓝色边框。
- 已确认原因：`MarketplaceItemCard.tsx` 的 Link 独立设置 hover 背景，外层独立设置 `hover:border-ring`。
- 修复方向：整卡使用共享 Card 的中性 surface 悬停；保留键盘可见焦点，详情链接与安装按钮互不嵌套。
- 验收：默认、悬停、键盘焦点、已安装/未安装状态一致；不再出现上下两段背景或悬停蓝框。
- 进度：已改用共享 Card surface，移除 Link 的独立 hover 背景、外层蓝色 hover 边框和浮起动效。真实页面已观察到中性整卡背景，内容和底部均透明；键盘焦点仍可见。

### 2. 首页 From Marketplace 改为卡片 feed

- 现象：目前是横向分隔线加图文行，用户要求独立卡片 feed。
- 修复方向：共享 Card 承载每条推荐，展示图标、名称、两行简介、真实安装状态；整卡进入详情，保留 View Marketplace 入口。
- 验收：宽屏与窄窗口均正常排布；长描述不挤压相邻卡片；安装状态及详情路由正确；不新增无行为的控件。
- 进度：已实现独立可点击卡片，响应式一/二/三列、两行简介及安装状态。桌面首页已观察到三列 feed；760px 独立验证页面为两列，无横向溢出，键盘焦点可见。

### 3. Marketplace 页面密度与左右留白不一致

- 现象：页面左右空白偏大，内容密度与其他页面不一致。
- 初步定位：Marketplace 使用 `AppPage width="narrow"`；AppPage 除统一 inline inset 外，还通过不同 max-width 和居中产生额外留白。需对照首页、Projects、Assets 在同一窗口和侧栏状态下确认。
- 修复方向：按用户要求统一对应页面的内容边界与密度，调整语义宽度/布局契约，避免局部硬编码 padding。现有 DESIGN.md 将 Marketplace 定义为 narrow，实施时需同步更新这条过时约定。
- 验收：在相同窗口、相同侧栏展开/收起状态下，标题、搜索栏、卡片网格左右边界与参照页面一致；窄窗口无横向溢出。
- 进度：已改用与 Projects、Assets 相同的 `AppPage width="wide"`，同步更新 DESIGN.md。1440px 验证页面、侧栏展开时，三页 AppPage 均为 x=256、width=1173、inline padding=43.2px。760px Marketplace 为单列，侧栏展开与收起均无横向溢出。首页仍保留既有 standard 语义宽度，没有为修 Marketplace 扩改首页整体布局。

## 完成条件

- 三项逐一完成并记录结果。
- 在 Clash Dev 检查首页和 Marketplace 的真实界面，覆盖默认/悬停/键盘焦点及窗口宽度变化。
- 运行相关现有交互/布局测试；纠正旧测试对已废弃外观实现的绑定，不添加自证式样式断言。
- 运行 `make lint`，不运行 `make build`。
- 当前修改未提交。此前提交整理中的 5 项 CLI/local-api 测试失败独立于本 GUI 目标，不应被本轮结果掩盖。

## 2026-09-09 验证记录

- `MarketplaceClient.layout.test.tsx`、`MarketplaceClient.interactions.test.tsx`、`HomeMarketplaceRecommendations.test.tsx`：3 个文件、27 项测试通过。覆盖搜索、过滤、安装状态、安装/引用交互、详情路由及首页推荐内容。
- `make lint`：10 个任务成功（缓存命中）。未运行 build。
- 已在运行中的 Clash Dev 检查首页 feed、Marketplace 默认外观。桌面窗口后续被使用，剩余检查切换到同一 Vite 和本地 Host 的临时浏览器验证入口。
- 独立页面检查了 Marketplace 整卡 hover、键盘焦点、已安装/未安装状态、成功进入 Codex ImageGen 详情；对比了 Projects/Assets 的宽屏边界；检查了 760px 下 Marketplace 侧栏展开/收起、首页 feed 排布和焦点。
- 首页键盘进入详情的一次验证返回了 `Plugin not found`，随后 Go home 返回 HTML/JSON 解析错误。发生于临时入口环境，原因未确认，不能视为导航验证全部通过，也未据此修改产品路由。
- 临时 `apps/web/gui-check.html` 和 `gui-check.ts` 已删除。

## 最终验收（用户确认继续后）

- 用户已确认继续。三项 GUI 修复完成，代码仍未提交。
- 真实 Clash Dev：首页鼠标点击 Codex ImageGen 卡片，进入正确详情，显示 Installed 和插件声明；首页通过 Tab 聚焦 Storyboard 卡片，焦点清晰，Return 成功进入 Storyboard 详情。
- 真实 Clash Dev：缩窄窗口后，首页 feed 自动从三列变为两列；两行描述截断、安装状态、详情入口均正常。页面可滚动到完整卡片，未观察到横向溢出；已检查首页卡片鼠标悬停。
- 真实 Clash Dev：Marketplace 窄窗口下卡片、安装按钮和状态保持可见；Tab 能从搜索、过滤进入卡片详情，焦点清晰。较窄的 760px 单列及侧栏收起场景已有独立 Vite 页面验证。
- Marketplace、Projects、Assets 使用同一 wide AppPage 契约，1440px 下实测边界与 padding 完全相同。首页保留 standard 内容宽度和共同的 responsive inset。
- 临时验证入口曾出现的详情/JSON 错误未在真实桌面导航复核中复现，原因未确定；本次不修改未证实有问题的路由逻辑。
- 最终重跑相关三份测试：27 项通过（22:44）；`make lint`：10 个任务成功；`git diff --check` 通过。没有运行 build。
- 临时验证入口已删除，独立浏览器尺寸已恢复，桌面窗口也已恢复至验收前尺寸。
- 目标完成。其他并行工作产生的 ChatbotCopilot / RuntimeSessionTimeline 修改不属于本记录，未作改动。
