# Timeline 坐标系参考

编辑器里同时存在 **3 套独立的坐标系**。它们看着都是数字，但互不兼容——历史上我们在每套里各踩过一个大坑，每次都是"肉眼看好像没问题、实际 drop/播放挂掉"。新增代码时务必搞清楚当前在哪套里。

相关文件：
- `packages/remotion-ui/src/components/Timeline.tsx`
- `packages/remotion-ui/src/components/timeline/dnd/itemDragLogic.ts`
- `packages/remotion-ui/src/components/timeline/TimelineTracksContainer.tsx`
- `packages/remotion-components/src/VideoComposition.tsx`

---

## 1. 垂直像素坐标（`.tracks-viewport` 内容系）

含 y-up/y-down 像素，原点 = 第一条 track 的顶部，单位 px。

**换算**：`topY = clientY - viewportRect.top + viewportEl.scrollTop`

- `clientY`：viewport（window）坐标，来自 DnD 事件或 `e.clientY`
- `viewportEl`：`.tracks-viewport` DOM 节点
- **必须每次 `document.querySelector('.tracks-viewport')` 现拿**，不能把 ref 缓存下来。见下面 "坑 A"。

`buildPreview` 里所有 `itemTop/itemBottom/trackHeight/bandIdx` 都在这个系里。`bandIdx = Math.floor(itemCenterY / trackHeight)` 给出目标 track 索引。

### 坑 A：缓存 `.tracks-viewport` ref

```ts
// ❌ 不要这么写
const viewportElRef = useRef<HTMLDivElement | null>(null);
useEffect(() => {
  setLabelsPortalEl(...);
  viewportElRef.current = containerRef.current?.querySelector('.tracks-viewport');
}, []);
```

`setLabelsPortalEl` 触发 `TracksContainer` 重渲染，portal 条件变化会把旧 `.tracks-viewport` 节点 unmount、建新节点。`viewportElRef.current` 指着的是旧 detached 节点，`getBoundingClientRect()` 返回 `{top:0, height:0}`，`scrollTop=0`，导致 `topY = clientY - 0 + 0 = clientY`——直接变成"鼠标在屏幕上的绝对 y"。后续 `Math.floor(y / 72)` 算出 `bandIdx=7/8`，而 track 总数只有 2，路由全错。

**规则**：DnD 回调里现 querySelector，别优化这一下。

---

## 2. 合成帧（composition-absolute frames）

时间线的统一时间轴，单位帧，原点 = 合成起点。

- `item.from`、`item.durationInFrames`、`currentFrame` 都是合成绝对帧
- `<Sequence from={X}>` 的 `from` 是合成绝对帧

---

## 3. Sequence 相对帧（sequence-relative frames）

**`<Sequence from=X>` 内部，`useCurrentFrame()` 返回相对 X 的帧数**（即 Sequence 开始时为 0）。`<OffthreadVideo startFrom=N>` 的 N 也是相对 Sequence 的（再叠加 `sourceStartInFrames` 作为源媒体偏移）。

### 坑 B：Sequence 内把相对帧和绝对帧做比较

```ts
// ❌ 历史版本
const frame = useCurrentFrame();                 // sequence-relative
const visibleFrom = item.from;                   // composition-absolute (!)
const isBeforeVisible = frame < visibleFrom;     // 两个坐标系的数比大小
const hidden = isBeforeVisible || ...;
```

结果：除了 `item.from === 0` 的那个 item（恰好两套值都是 0 蒙混过关），**所有 `item.from > 0` 的 item `hidden` 恒为 true**，外层黑底盖掉视频——症状是"最左边（from=0）那个 item 能播，后面所有的整段黑屏或一半黑屏"。

**规则**：传给 Sequence 内部组件的帧参数都要**先转成 Sequence 相对**：

```ts
const seqFrom = isPrevContiguous ? item.from - 1 : item.from;
const visibleFromRel = item.from - seqFrom;                              // 0 或 1
const endFrameRel = (item.from + item.durationInFrames - 1) - seqFrom;
const isGlobalEndItem = (item.from + item.durationInFrames - 1) === globalEndFrame;

<Sequence from={seqFrom} durationInFrames={item.durationInFrames}>
  <ItemComponent visibleFrom={visibleFromRel} endFrame={endFrameRel} isGlobalEndItem={isGlobalEndItem} />
</Sequence>
```

`globalEndFrame` 是合成绝对值，不能传进 Sequence 内部直接和 `useCurrentFrame()` 比；要在外面算成布尔 `isGlobalEndItem` 传进去。

---

## Drop 路由：对齐素材栏的心智模型

之前 `buildPreview` 有 A0 / A / B / C / D / E 六分支 3-zone 决策树，每补一个 case 就冒出下一个漏洞（item 底部一碰 boundary 就创建新 track、item 中心压在下半条带无法路由到该 track……）。

现在是一句话路由，和素材栏 drop（"鼠标在哪个 track DOM 上就是哪个"）同一个心智：

```ts
const itemCenterY = (itemTop + itemBottom) / 2;
const bandIdx = Math.floor(itemCenterY / trackHeight);
if (bandIdx < 0) → create track at top
else if (bandIdx >= tracks.length) → create track at bottom
else → target = tracks[bandIdx]
```

下游按 `preferItemEdgeSnap`（横向吸附）→ `resolveNonOverlapInTrack`（目标 track 内最近的合法空位）→ `finalizeDrop`（drop action 分类）处理。避让不改写相邻片段；不要只向后推挤，否则短距离拖动会跳过整串连续片段。2026-09-29 的实际工程回归：100 帧片段从 44 拖向 84，应停在最近空位 44，不能跳到 1587。

**不要再引入"item 某区域横跨 boundary 就怎样"这类 zone 规则**——如果真要加（比如"拖到两 track 缝隙插入新 track"），单独做成显式的阈值判定，不要和基础路由搅在一起。

---

## 排查顺序

如果下次又遇到类似"拖/播看起来挂了、console 不报错"：

1. **拖动挂** → 在 `buildPreview` 和 `updatePreviewFromDnd` 入口打 log，看三个值：
   - `viewportRect.top / height`（应该是非 0 的正常值）
   - `scrollTop`（通常 0）
   - `bandIdx`（必须落在 `[0, tracks.length)` 或恰好为外部）

   如果 `viewportRect.top===0 && height===0` → 撞到坑 A，某个地方在用 stale 的 `.tracks-viewport` 引用。

2. **播放黑屏** → 在 `ItemComponent` 入口打 `{frame, visibleFrom, endFrame, hidden, resolvedSrc}`：
   - `frame < visibleFrom` 是不是几乎永远成立 → 撞到坑 B，坐标系错配
   - `resolvedSrc` 空串 → `allNodesMap` 没解析到 assetId，查 `CanvasPreview.tsx` 的 map 构建
   - `hidden=true` 整段 → 要么坑 B 要么 `isGlobalEndItem` 判定错
