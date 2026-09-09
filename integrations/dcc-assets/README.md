# Clash Materials · Blender / Maya

将 Clash 项目素材送入三维软件，并把渲染图、贴图、视频等文件送回 Clash。
同一套插件提供 agent 对 Blender / Maya 的原生控制和 Clash 素材联动。
工具由 **Clash 已有的内置 MCP** 注入，无需安装 `blender-mcp` 或填写第二份 MCP 配置。
素材继续使用现有 Clash CLI 和 Host，不创建新的存储或同步服务。

## 当前能力

| 操作                       | Blender                                          | Maya                                       |
| -------------------------- | ------------------------------------------------ | ------------------------------------------ |
| 列出、搜索当前项目可用素材 | 支持                                             | 支持                                       |
| 发送已保存的素材文件       | 支持                                             | 支持                                       |
| 取回独立本地副本           | 支持                                             | 支持                                       |
| 图片原生导入               | 加载到 Images 数据块，可在图片编辑器或材质中选择 | 创建 file 贴图节点，可在 Hypershade 中连接 |
| GLB 原生导入               | 支持                                             | 仅取回文件；不宣称原生 GLB 支持            |
| 发送选中模型               | 导出自包含 GLB 后发送                            | 不提供 FBX 上传；Clash Host 当前不接收 FBX |
| Agent 场景 / 对象读取      | 支持                                             | 支持                                       |
| Agent 视口截图             | 返回 PNG 给模型                                  | 返回 PNG 给模型                            |
| Agent 原生脚本             | Python + bpy                                     | Python + maya.cmds                         |
| Agent 素材导入与发布       | 与面板共用实现                                   | 与面板共用实现                             |

图片原生导入取决于宿主的解码支持。视频和音频先取回文件，再由宿主支持的方式使用。
Agent 可通过原生脚本控制建模、材质、相机、动画和渲染。独立的自动渲染任务调度、
素材版本替换、后台同步尚未实现。这里提供 Blender MCP 类的核心控制能力，
不宣称复制某个第三方 Blender MCP 的所有外部素材库和生成服务；素材与生成走 Clash 自己的工具。

## 准备

1. 使用包含此次 MCP 改动的 Clash Desktop / Clash 插件及 `clash` CLI，打开 Clash。
   旧版 Clash 仅安装原生 ZIP 不会凭空增加 MCP 工具，需同步更新 Clash。
2. 选择已有 Clash 项目的工作目录。未关联的目录只需在终端执行一次
   `clash init --project <project-id> --json`；插件不要求先执行 `project status`。
3. 插件 Connection 中填写此目录。GUI 启动的软件可能没有终端的 PATH，
   此时把 Executable / Clash executable 设置为 Clash 可执行文件的完整路径。
   该字段是单个程序路径，不是 shell 命令，也不支持附加命令行参数。
4. 点击 **Connect agent**。Clash MCP 自动发现此工作目录中的 Blender / Maya 会话。
   连接期间目录设置固定；切换工程先 Disconnect，再更换工作目录并连接。

无需配置云端 Token。插件调用正常的 `clash assets list/import/link --json`，
由 CLI 发现当前本机 Host 并处理项目身份及 Asset 发布。

## Agent 使用

Clash 原有 `clash_plugin` dispatcher 自动包含 `dcc_*` 操作。
先不带 `operation` 调用它，读取当前契约，再执行所需操作：

```json
{
  "operation": "dcc_scene",
  "arguments": { "app": "blender", "cwd": "/your/project" }
}
```

| operation                  | 用途                                                              |
| -------------------------- | ----------------------------------------------------------------- |
| `dcc_capabilities`         | 查询当前软件版本及可用操作                                        |
| `dcc_scene` / `dcc_object` | 读取场景、选择、变换、材质等                                      |
| `dcc_screenshot`           | 获取原生视口 PNG，作为 MCP image content 返回                     |
| `dcc_execute`              | 在软件内执行 Python；通过 `result` 返回 JSON 值，打印输出一并返回 |
| `dcc_import_asset`         | 以 Clash Project Asset ID 取回并原生导入                          |
| `dcc_publish_file`         | 将工作目录中的已保存素材发布到 Clash                              |
| `dcc_export_selection`     | Blender 选中物体 → GLB → Clash Asset                              |

示例：先用 `clash_assets` 找到素材，`dcc_import_asset` 导入，然后通过
`dcc_execute` 调整对象或材质，`dcc_screenshot` 检查结果，最后发布输出。
Maya 可优先使用下述具名操作库，其他原生操作走 `dcc_execute`；GLB 直接导入不在当前 Maya 适配器能力内。

### MayaMCP 操作库

Maya 安装包已内置来自 [clash-art/MayaMCP](https://github.com/clash-art/MayaMCP)
的操作脚本，原作者 Patrick Palmer，MIT 许可。先调用 `dcc_maya_tools`
（`app: "maya"`）读取每项操作的说明、参数 JSON Schema 和读写属性，再调用：

```json
{
  "operation": "dcc_maya_call",
  "arguments": {
    "app": "maya",
    "cwd": "/your/project",
    "tool": "create_object",
    "toolArguments": {
      "name": "Product",
      "object_type": "cube",
      "translate": [0, 0, 0]
    }
  }
}
```

工具包括对象创建/查询/属性/变换、选择与视口聚焦、场景新建/打开/保存、
网格操作、材质、曲线及曲线建模、对象组织和参数化模型。具体以连接后的目录为准。
`dcc_maya_call` 保守标记为可修改操作；参数按实际函数契约验证后直接传值，
不会拼入 Python 源码。文件操作不会自动发布 Clash 素材；发布仍走 `dcc_publish_file`。

上游 `generate_scene.py` 在引入版本存在语法错误和缺失依赖，已排除，不能调用。
已修复灯光创建返回值处理。完整来源版本、许可证及差异随安装包保存在
`scripts/clash_assets_maya/mayatools/UPSTREAM.md` 和 `LICENSE`。
操作库已完成桥接测试，但各建模配方尚未在真实 Maya 中逐项验收。

Connect agent 开启完整的本机原生 Python 能力，具有与当前软件进程相同的文件和执行权限，
不是沙箱。连接只监听 loopback，并要求自动生成的会话凭据。凭据保存在当前用户的
`~/.clash/dcc-connections/`，不写入工程、不随素材同步，也无需 agent 手动传递。
所有宿主 API 操作都在 UI 线程执行；较长的同步脚本会占用软件主线程，应拆分任务并检查结果。
超时或连接中断后操作可能已经执行，不自动重试；先读取场景和素材状态。

## 生成安装包

开发环境需要项目所用 Node 24 和 Python 3.9+，不需要额外 Python 包：

```bash
node integrations/dcc-assets/package.ts
```

生成 `dist/clash-blender.zip` 与 `dist/clash-maya.zip`。
打包器会将共享 transport 放入各包内；两款插件可以独立安装。

### Blender

面向 Blender 4.2+ 原生 API。Preferences → Add-ons → Install from Disk，
选择 `clash-blender.zip` 并启用 Clash Materials。
在 3D View 按 `N`，打开 Clash 标签，展开 Connection 设置工作目录。

- Refresh：读取项目中的可用素材；列表内可搜索。
- Receive copy：保存到工作目录 `assets/dcc/`。
- Import：GLB 加入当前场景；图片加载到 Images 数据块。
- Send a file：将已经保存的渲染图、视频、贴图等文件发布到 Clash。
- Send selected as GLB：Object Mode 下导出选中对象，再发布到 Clash。
  导出文件保留在 `assets/dcc/exports/`，失败时可用 Send a file 重试同一文件。

### Maya

面向 PySide6 的 Maya 2025+，保留 PySide2 导入兼容路径，但未据此宣称旧版本验证通过。
解压 `clash-maya.zip` 到一个持久目录。选择一种安装方式：

- 将其中 `scripts/clash_assets_maya` 文件夹复制到 Maya 用户 `scripts` 目录；或
- 将解压目录加入 `MAYA_MODULE_PATH`，重启 Maya，由 `ClashMaterials.mod` 注册 scripts 路径。

在 Script Editor 的 Python 页执行，并可保存为 Shelf 按钮：

```python
import clash_assets_maya
clash_assets_maya.show()
```

填写 Connection 后 Refresh。Receive copy 保存文件；Create texture 为图片创建
可撤销的 Maya file 贴图节点，并记录 `clashAssetId`。它不会自动替换当前物体材质。

## 文件与失败处理

- Clash 原资产保持不可变。每次 Receive 都产生新副本，已有本地编辑不会被覆盖。
- 工作目录中的副本不会自动回写。编辑后用 Send a file 显式发布。
- 上传时先复制快照，再计算稳定 Asset ID。相同工作目录、源路径和字节重试时使用同一 ID；
  文件内容改变后使用新 ID。超时后请重发同一文件，不要假定 Host 没有完成上一请求。
- 插件不转码；Host 校验实际字节及支持格式。多文件 `.gltf` 应先导出成自包含 `.glb`，
  避免遗漏外部纹理与 buffer。EXR、FBX 等未被 Host 支持的格式不做虚假转换。
- 关闭面板或禁用插件会终止本地 CLI 等待，**不表示撤销已发布的 Host 资产**。

## 验证

```bash
node --test integrations/dcc-assets/tests/*.test.ts
make lint
```

自动测试验证公开 CLI 命令契约、失败重试身份、修改后的新身份、独立副本和安装包完整性。
CLI 进程响应使用测试 fixture；这些测试不等于实际 Host 或 DCC 端到端验证。
`packages/mcp-server/src/dcc-transport.test.ts` 另外验证真实 Node ↔ Python loopback 通信；
`dcc.test.ts` 验证控制和素材操作通过同一个 Clash MCP dispatcher 调用。

发布前在真实软件中完成：

1. 用已关联测试项目 Refresh，发送 PNG 并在 Clash 中确认可见。
2. Receive 后修改副本，再 Receive，确认原副本和 Clash 原资产不变。
3. Blender 导出选中模型，在 Clash 查看，然后取回并导入新场景。
4. Maya 创建贴图，在 Hypershade 检查文件路径并测试 Undo。
5. 切换工作目录，确认旧列表清空；错误 CLI 路径、Host 关闭时检查提示和面板可继续操作。
6. 在宿主明暗主题及窄面板下检查布局、文字可读性、键盘焦点和文件对话框。
7. Connect agent 后从 Clash 调用 `dcc_scene`、修改一个测试物体、截图，并验证素材导入/发布；
   Disconnect 后控制请求必须失败。测试脚本异常后的场景状态，确认 agent 不盲目重试。

当前开发机没有 Blender / Maya，因此原生加载、实际文件解码、视觉布局和真实 Host
互通尚未在两款宿主中验收，安装包应按开发预览使用。

## 上游接口依据

- [Blender Panel API](https://docs.blender.org/api/4.2/bpy.types.Panel.html)
- [Blender glTF 导入](https://docs.blender.org/api/main/bpy.ops.import_scene.html)
- [Blender glTF 导出](https://docs.blender.org/api/main/bpy.ops.export_scene.html)
- [Maya PySide](https://help.autodesk.com/cloudhelp/2026/ENU/Maya-DEVHELP/files/Maya-Python-API/Maya_DEVHELP_Maya_Python_API_Working_with_PySide_in_Maya_html.html)
- Host 格式权威：`packages/shared-runtime/src/project-asset-client.ts`。
