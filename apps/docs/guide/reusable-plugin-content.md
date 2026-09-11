# Generator 内复用代码：3D 片场试吃

2026-09-10：本次实现采用 Director 内部协议。此前提出的通用 RecipeType、DocumentLibraryEntry 和 GeneratorEdit 不属于本次实现。

## 存储边界

| 内容                 | 保存位置                                                                                 | 解释者                 |
| -------------------- | ---------------------------------------------------------------------------------------- | ---------------------- |
| 单文件 TS/TSX 源码   | Project 的 `text.plain@1` Document Asset，不可变 revision 的 body 是源码字符串           | Director               |
| 已注册组件           | Director Generator 状态里的 `codeComponents`，保存 ID、名称和精确 Document revision 引用 | Director               |
| 布景、道具、灯光实例 | 同一 Generator 状态的 `objects`，保存组件 ID、JSON 参数和 transform                      | Director               |
| 场景的不同状态       | Project Loro 中的 Generator revisions                                                    | Generator authority    |
| 截图产物             | 既有 capture Action 的 Media Asset、Output Commit 和来源引用                             | Action/Asset authority |

Document 的物理存储复用项目文档设施。组件发现与注册范围是当前 Generator；本次不自动收录个人全局资产库，也不增加平台级 Stage/Recipe 原语。源码的格式、入口和依赖约定均属于 Director。

## Agent 工作流

在已通过 `clash init` 关联项目的工作目录中：

```sh
clash director create --id studio --name 'Code Studio' --json
clash director components register --stage studio --component studio-rig --file studio-rig.tsx --json
clash director components register --stage studio --component sculpture --file kinetic-sculpture.tsx --json
clash director pull --stage studio --file studio.json --json
# 原生编辑 studio.json，添加对象、摄影机或修改参数
clash director apply --stage studio --file studio.json --json
```

注册命令读取当前场景、创建源码 Document，再通过既有 CAS 写入场景。注册相同 component ID 会更新当前状态的引用，保留实例参数；旧 Generator revision 仍引用旧源码。若 CAS 失败，源码 Document 已创建但未注册，命令会报错，不能当作注册成功。重新读取并处理冲突后再注册。

源码编译和渲染发生在浏览器，注册本身只保存内容。语法、导出或运行错误会在预览/截图时报错。

## Director 的单文件协议

入口是默认导出的 React 函数组件，接收 `parameters` 与 `timeSeconds`：

```tsx
import { MathUtils } from "three";

export default function Prop({ parameters, timeSeconds }) {
  const size = MathUtils.clamp(Number(parameters.size ?? 1), 0.1, 10);
  return (
    <mesh rotation={[0, timeSeconds * 0.5, 0]} scale={size} castShadow>
      <boxGeometry />
      <meshStandardMaterial color={parameters.color ?? "orange"} />
    </mesh>
  );
}
```

支持 React、Three.js 导入与 React Three Fiber 原生 JSX 元素。当前不支持相对文件导入、任意 npm 包、动态 import 或 require。代码使用与现有内联 Remotion 相同的受信任创作模式；导入检查是单文件协议约束，不是安全沙箱，不在 Node Host 中执行源码。

为了重现同一状态，组件应以参数和 `timeSeconds` 计算画面，避免依赖系统时钟、随机数和网络副作用。当前实现不会强制使任意代码成为纯函数。

注册后，在拉取的场景 JSON 中保留 `codeComponents`，并添加实例：

```json
{
  "id": "sculpture-left",
  "name": "Copper sculpture",
  "kind": "code",
  "visible": true,
  "transform": {
    "position": [-1.4, 0, 0],
    "rotation": [0, 0, 0],
    "scale": [1, 1, 1]
  },
  "code": {
    "componentId": "sculpture",
    "parameters": { "color": "#da6e33", "speed": 0.5, "phase": 0 }
  }
}
```

同一组件可以被多个对象实例化，也可以在多个场景状态里使用不同参数。实例可包含 mesh、group、材质、光源等。设 `scene.defaultLighting: false` 后，片场照明完全由场景里的光源控制；省略该字段保持既有默认照明。

源码引用同时投影到 Generator 的 `stage:code` persistent input。预览和 capture Action 读取精确 revision，不追踪 Document head。缺失文档、错误类型、未注册组件和渲染错误不能静默变成成功截图。

## 试吃素材与验证

仓库 `plugins/director/examples/` 提供：

- `studio-rig.tsx`：背景、地面、冷暖布光组合，参数 `mood`。
- `kinetic-sculpture.tsx`：带底座的动态道具，参数 `color`、`speed`、`phase`。

注册这两个文件后，可用一个 studio-rig 和两个 sculpture 实例搭建片场；共享源码、独立 transform/参数，再修改 mood 生成另一状态。

测试覆盖源码编译、参数与时间传入、旧源码行为保留、注册 CAS 错误传播、精确文档解码、原生 Generator 引用、Document head 前进后的历史读取、Loro 快照恢复，以及 capture Action 的源码解析。

本次已在独立源码 Host 中通过真实 CLI 完成注册、apply 和 capture，生成暖光 0 秒、暖光 2.5 秒、冷光 0 秒以及更新源码后的冷光画面。浏览器实测确认缺失源码、语法错误、组件运行异常都会拒绝截图。该验证不会自动更新正在运行的旧 Host。

## 当前边界

这是单个 Generator 内的复用协议。组件参数暂由 JSON 文件编辑；没有自动生成参数表单、跨 Generator 组件市场、全局库收录或外部包安装。注册不等于代码已经通过渲染验证，完成创作后应实际预览或 capture。
