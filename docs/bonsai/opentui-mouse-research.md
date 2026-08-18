# OpenTUI 鼠标事件实现调研

## 调研边界

- OpenTUI 官方仓库：[`sst/opentui`](https://github.com/sst/opentui)
- 固定版本：`v0.5.4`
- 固定提交：[`7f5b19b640de50d5665c88d4bc1cfbb884dd0f49`](https://github.com/sst/opentui/tree/7f5b19b640de50d5665c88d4bc1cfbb884dd0f49)
- 提交时间：2026-08-18
- Bonsai 对照提交：`a026352eb4635b7260bacd7e5b6f5de91e036aa3`
- 资料范围：只使用 OpenTUI 官方源码、官方 README 和官方测试；没有引用第三方文章。

## 结论

OpenTUI 的鼠标支持由四层组成：

```text
终端 SGR/X10 字节流
        ↓
MouseParser：down/up/move/drag/scroll + 坐标/修饰键
        ↓
渲染期 hit grid：每个终端单元格记录最上层 Renderable ID
        ↓
MouseEvent：命中节点 → 父节点冒泡，支持 stopPropagation/preventDefault
```

对 Bonsai 最有价值的不是迁移 OpenTUI 或照搬 Zig hit grid，而是复用这三个边界：

1. 鼠标协议解析、命中测试和组件处理互相分离。
2. 命中后从最具体组件向父组件冒泡，并允许组件停止传播。
3. 文本选择、拖拽、滚动和点击在统一路由器中决定优先级。

`pi-tui` 已经拥有 SGR 鼠标捕获、`LayoutFrame/LayoutBox`、裁剪坐标、滚动视图、文本选择和 overlay stack。当前缺口只是“普通 Component 的鼠标事件接口和通用命中分发”。因此没有必要为 Bonsai 引入 OpenTUI，也没有必要先造原生命中网格。

## 1. 终端鼠标协议

OpenTUI 启用以下 DEC 私有模式：

- `?1000h`：按钮按下/释放；
- `?1002h`：按钮拖动；
- 可选 `?1003h`：所有指针移动，用于 hover；
- `?1006h`：SGR 扩展坐标格式。

关闭时按相反方向全部清理。`enableMouseMovement` 控制是否启用 `1003`，而 `useMouse` 和 `enableMouseMovement` 在 `CliRenderer` 配置中分别控制总开关和 hover/move 流量。

来源：

- [terminal.zig：设置和清理鼠标模式](https://github.com/sst/opentui/blob/7f5b19b640de50d5665c88d4bc1cfbb884dd0f49/packages/core/src/zig/terminal.zig#L928-L970)
- [ansi.zig：具体转义序列](https://github.com/sst/opentui/blob/7f5b19b640de50d5665c88d4bc1cfbb884dd0f49/packages/core/src/zig/ansi.zig#L301-L310)
- [renderer.ts：`useMouse`、`enableMouseMovement`、`autoFocus`](https://github.com/sst/opentui/blob/7f5b19b640de50d5665c88d4bc1cfbb884dd0f49/packages/core/src/renderer.ts#L170-L184)

这和 Bonsai fullscreen 当前做法基本一致：非 multiplexer 环境启用 `1003`，tmux/zellij/screen 中只启用 button-motion，避免每次移动都穿过 multiplexer 造成延迟。OpenTUI 默认启用所有 movement；Bonsai 现有的环境降级策略更适合保留。

## 2. 协议解析和 MouseEvent 类型

`MouseParser` 同时解析：

- SGR：`CSI < Cb ; Cx ; Cy M/m`；
- 旧式 X10/basic：`CSI M` 加三个编码字节。

解析结果统一为零基终端坐标，并解码：

- `button`；
- `shift/alt/ctrl`；
- `down/up/move/drag/scroll`；
- 滚轮方向与 `delta`。

parser 内部维护已按下按钮集合，用 motion 位和按钮状态区分 `move` 与 `drag`。框架随后额外合成 `over/out/drag-end/drop`。完整事件联合类型是：

```ts
"down" | "up" | "move" | "drag" | "drag-end" |
"drop" | "over" | "out" | "scroll"
```

`MouseEvent` 保留屏幕绝对坐标、初始 `target`、当前冒泡节点 `currentTarget`、拖拽源 `source`、修饰键、scroll 信息，并提供 `stopPropagation()` 和 `preventDefault()`。

来源：

- [parse.mouse.ts：协议解析和统一 RawMouseEvent](https://github.com/sst/opentui/blob/7f5b19b640de50d5665c88d4bc1cfbb884dd0f49/packages/core/src/lib/parse.mouse.ts#L1-L232)
- [renderer.ts：MouseEvent 定义](https://github.com/sst/opentui/blob/7f5b19b640de50d5665c88d4bc1cfbb884dd0f49/packages/core/src/renderer.ts#L635-L680)

### OpenTUI 没有独立的 `click` 事件

官方事件类型没有 `click`。测试辅助方法 `mockMouse.click()` 只是依次发送 `down` 和 `up`。官方示例里的按钮也通常把业务 `onClick` 映射到 `onMouseDown`。

来源：

- [mock-mouse.ts：click 等于 down + up](https://github.com/sst/opentui/blob/7f5b19b640de50d5665c88d4bc1cfbb884dd0f49/packages/core/src/testing/mock-mouse.ts#L124-L148)
- [VNode 示例：业务 onClick 映射到 onMouseDown](https://github.com/sst/opentui/blob/7f5b19b640de50d5665c88d4bc1cfbb884dd0f49/packages/examples/src/vnode-composition-demo.ts#L51-L61)

对 Bonsai 来说，不必复制这一点。打开 tool detail 更适合定义为“同一目标上按下并释放且没有拖动”后触发，避免按下时误开详情；底层仍然只需要 down/up/move。

## 3. 命中测试：渲染期 hit grid

OpenTUI 不是在点击时递归计算矩形，而是在每帧渲染时维护一张与屏幕等大的 `u32` 网格：每个单元格存一个 Renderable ID。

关键性质：

- 每个可见 Renderable 渲染后把自己的屏幕矩形写入 hit grid；
- 后渲染的元素覆盖前面的 ID，因此自然得到视觉最上层目标；
- 两张网格双缓冲，点击读取上一张完整帧，不会读到半帧状态；
- `overflow:hidden` 使用 scissor stack 裁剪命中区域；
- scroll/translate 可直接同步当前 hit grid，使 hover 不必等待下一帧；
- `checkHit(x,y)` 是 O(1) 数组查询。

来源：

- [renderer.zig：hit grid 的设计说明](https://github.com/sst/opentui/blob/7f5b19b640de50d5665c88d4bc1cfbb884dd0f49/packages/core/src/zig/renderer.zig#L257-L272)
- [Renderable.ts：每个 Renderable 将屏幕矩形写入网格](https://github.com/sst/opentui/blob/7f5b19b640de50d5665c88d4bc1cfbb884dd0f49/packages/core/src/Renderable.ts#L1475-L1495)
- [renderer.zig：覆盖写入和 O(1) checkHit](https://github.com/sst/opentui/blob/7f5b19b640de50d5665c88d4bc1cfbb884dd0f49/packages/core/src/zig/renderer.zig#L2806-L2865)
- [renderer.zig：嵌套 scissor 与即时同步](https://github.com/sst/opentui/blob/7f5b19b640de50d5665c88d4bc1cfbb884dd0f49/packages/core/src/zig/renderer.zig#L2904-L2968)

### z-index 与 overlay

Renderable 子节点按 `zIndex` 升序渲染；后画的高 z-index 元素覆盖 hit grid，因此视觉顺序和点击顺序来自同一条渲染顺序。官方测试验证 z-index 变化后，即使鼠标不动，也会重算 hover；也验证高 z-index 的全屏 overlay 会接住滚动列表外部的点击。

OpenTUI core 没有一个完整的 modal/overlay manager。Solid 的 `Portal` 只是把子树挂到另一个 mount node（通常是 root），真正的层级仍靠绝对定位、`zIndex`、焦点和业务代码管理。React 的 `createPortal` 也只是 reconciler portal。

来源：

- [Renderable.ts：子节点按 zIndex 排序](https://github.com/sst/opentui/blob/7f5b19b640de50d5665c88d4bc1cfbb884dd0f49/packages/core/src/Renderable.ts#L661-L684)
- [scrollbox-hitgrid.test.ts：z-index hover 和 overlay 点击](https://github.com/sst/opentui/blob/7f5b19b640de50d5665c88d4bc1cfbb884dd0f49/packages/core/src/tests/scrollbox-hitgrid.test.ts#L765-L909)
- [Solid README：Portal 用于 overlay/tooltip](https://github.com/sst/opentui/blob/7f5b19b640de50d5665c88d4bc1cfbb884dd0f49/packages/solid/README.md#L139-L148)
- [Solid Portal 实现](https://github.com/sst/opentui/blob/7f5b19b640de50d5665c88d4bc1cfbb884dd0f49/packages/solid/src/elements/extras.ts#L8-L51)

## 4. 事件传播、hover、拖拽和 focus

命中目标后，`Renderable.processMouseEvent()` 依次调用：

1. 通用 `onMouse`；
2. 当前类型的 `onMouseDown/onMouseUp/...`；
3. 子类覆写的 `onMouseEvent()`；
4. 若没有 `stopPropagation()`，继续递归给 parent。

这只有冒泡阶段，没有 DOM 式 capture phase。

来源：[Renderable.ts：鼠标监听器与向父节点冒泡](https://github.com/sst/opentui/blob/7f5b19b640de50d5665c88d4bc1cfbb884dd0f49/packages/core/src/Renderable.ts#L1597-L1660)

hover 由命中 ID 的变化产生 `out/over`。渲染导致元素移动或 z-index 改变时，框架也会在帧后重新检查当前指针位置，因此无需等下一次 mouse-move。

左键 drag 会把源 Renderable 设为 captured target：后续 drag 即便跨过其他组件仍发给源；释放时源依次收到 `drag-end` 和 `up`，当前命中目标收到 `drop`，并通过 `event.source` 得到拖拽源。

来源：[renderer.ts：hover、pointer capture、drag-end/drop](https://github.com/sst/opentui/blob/7f5b19b640de50d5665c88d4bc1cfbb884dd0f49/packages/core/src/renderer.ts#L3585-L3760)

`autoFocus` 默认开启。左键 down 冒泡结束后，如果没有 `preventDefault()`，框架从命中节点向上寻找第一个 `focusable` Renderable 并调用 `focus()`。所以：

- `stopPropagation()` 只控制事件是否继续到父组件；
- `preventDefault()` 控制自动聚焦和部分默认行为；
- 两者不是同一个开关。

来源：

- [renderer.ts：左键自动聚焦最近的 focusable ancestor](https://github.com/sst/opentui/blob/7f5b19b640de50d5665c88d4bc1cfbb884dd0f49/packages/core/src/renderer.ts#L3510-L3529)
- [renderer.focus.test.ts：preventDefault 阻止自动聚焦](https://github.com/sst/opentui/blob/7f5b19b640de50d5665c88d4bc1cfbb884dd0f49/packages/core/src/tests/renderer.focus.test.ts#L78-L96)

## 5. 滚动容器和坐标

OpenTUI 事件中的 `x/y` 始终是屏幕绝对坐标，不会为每一级父组件转换成本地坐标。组件需要用自身绝对 `x/y` 计算局部偏移。

`ScrollBoxRenderable` 通过改变 content 的 `translateX/translateY` 移动内容。因为每个子项最后按更新后的 `screenX/screenY` 写入 hit grid，并受到 viewport scissor 裁剪，所以：

- 滚动后命中的仍是屏幕当前位置真正可见的子项；
- 被裁出 viewport 的子项不会截获点击；
- 嵌套滚动容器的滚轮事件从命中子项向父级冒泡，内层可消费或继续向外层传播。

滚轮由 `ScrollBoxRenderable.onMouseEvent()` 处理；Shift 会交换纵横方向；拖选文字越过 viewport 边缘时，ScrollBox 启动定时自动滚动，并请求 selection 重新计算。

来源：

- [ScrollBox.ts：scroll 事件处理](https://github.com/sst/opentui/blob/7f5b19b640de50d5665c88d4bc1cfbb884dd0f49/packages/core/src/renderables/ScrollBox.ts#L542-L591)
- [ScrollBox.ts：拖选自动滚动](https://github.com/sst/opentui/blob/7f5b19b640de50d5665c88d4bc1cfbb884dd0f49/packages/core/src/renderables/ScrollBox.ts#L620-L695)
- [scrollbox-hitgrid.test.ts：滚动、裁剪和 overlay 命中回归](https://github.com/sst/opentui/blob/7f5b19b640de50d5665c88d4bc1cfbb884dd0f49/packages/core/src/tests/scrollbox-hitgrid.test.ts)

## 6. 文本选择与点击冲突

OpenTUI 在统一鼠标路由中显式决定选择优先级：

1. 左键 down 命中 `selectable` 且 `shouldStartSelection()` 返回 true 的 Renderable 时，先开始 selection；
2. drag 时更新 selection，事件带 `isDragging: true`；
3. up 时完成 selection 并发出 renderer-level `selection`；
4. Ctrl+click 用于扩展已有 selection；
5. 右键不会启动 selection；
6. 普通点击非选择区域会清除旧 selection，除非事件调用 `preventDefault()`。

来源：

- [renderer.ts：选择与普通鼠标事件的路由顺序](https://github.com/sst/opentui/blob/7f5b19b640de50d5665c88d4bc1cfbb884dd0f49/packages/core/src/renderer.ts#L3585-L3644)
- [renderer.mouse.test.ts：selection drag、Ctrl+click、右键和 preventDefault](https://github.com/sst/opentui/blob/7f5b19b640de50d5665c88d4bc1cfbb884dd0f49/packages/core/src/tests/renderer.mouse.test.ts#L346-L560)

这条规则不能原样搬进 Bonsai：`pi-tui` 的 transcript 原本全屏可选，而新的 tool 行和欢迎页卡片需要点击。更安全的 Bonsai 规则应是：

- 先命中可交互组件；
- 组件如果明确消费 down/up，则不启动文本选择；
- 没有组件消费时，继续走现有选择逻辑；
- 拖动超过阈值后一定转为选择/拖拽，不触发 click；
- 键盘等价路径始终保留。

## 7. React/Solid 是否拥有独立鼠标实现

没有。React 和 Solid 只是声明式适配层，真正的鼠标解析、命中、冒泡、选择和 focus 都在 `@opentui/core`。

React：

- JSX tag 直接对应 core 的 `BoxRenderable/TextRenderable/ScrollBoxRenderable/...`；
- reconciler 把子节点调用 `parent.add(child)` 挂到 core 树；
- 未特殊处理的 props（包括 `onMouseDown` 等）直接赋值到 core Renderable 的 setter。

Solid：

- `createElement` 从 catalogue 实例化 core Renderable；
-普通 props 同样直接赋值到实例；
- `on:event` 只是映射到实例的 EventEmitter。

来源：

- [React component catalogue](https://github.com/sst/opentui/blob/7f5b19b640de50d5665c88d4bc1cfbb884dd0f49/packages/react/src/components/index.ts#L1-L50)
- [React reconciler：挂载 core 子树](https://github.com/sst/opentui/blob/7f5b19b640de50d5665c88d4bc1cfbb884dd0f49/packages/react/src/reconciler/host-config.ts#L70-L100)
- [React props：默认直接写入 core 实例](https://github.com/sst/opentui/blob/7f5b19b640de50d5665c88d4bc1cfbb884dd0f49/packages/react/src/utils/index.ts#L49-L97)
- [Solid reconciler：实例化 core Renderable](https://github.com/sst/opentui/blob/7f5b19b640de50d5665c88d4bc1cfbb884dd0f49/packages/solid/src/reconciler.ts#L192-L213)
- [Solid props：事件和普通属性适配](https://github.com/sst/opentui/blob/7f5b19b640de50d5665c88d4bc1cfbb884dd0f49/packages/solid/src/reconciler.ts#L229-L362)

## 8. Bonsai/pi-tui 当前边界

当前 `pi-tui` 已经具备：

- fullscreen 中的 `1000/1002/1003/1004/1006` 捕获和 SGR 解析；
- `LayoutFrame → LayoutBox` 树，每个 box 有 component、rect、clip、children、parent、scrollView；
- nested ScrollView 的坐标、裁剪和从内到外的 wheel 路由；
- 单击/双击/三击文本、拖选、自动滚动、OSC 8 链接；
- scrollbar hover/drag；
- 独立的 overlay stack 和 focus 恢复。

相关本地源码：

- `packages/tui/src/tui-alt-screen.ts`
- `packages/tui/src/layout.ts`
- `packages/tui/src/tui.ts`

缺少的是：

```ts
interface Component {
  handleMouse?(event: MouseEvent): void
}
```

以及从当前 `LayoutFrame` 找到最上层 component 的通用 hit-test。现在 `getScrollViewsAt()` 只对 ScrollView 做深度命中，不会把点击分发给普通 Component；overlay 也只有整体 focus/input 路由，没有组件级鼠标路由。

## 9. 建议 Bonsai 借鉴到什么程度

### 第一阶段：只补最小通用点击能力

建议范围：

1. 仅 fullscreen 启用，main-screen 不捕获鼠标，避免破坏终端原生 scrollback 和选字。
2. 复用现有 `LayoutBox.rect/clip/children` 做一次反向深度遍历命中，不引入 Zig/native hit grid。
3. Component 增加可选 `handleMouse`；事件先支持 `down/up/move`、绝对坐标、button、修饰键、`stopPropagation/preventDefault`。
4. 从命中叶子向 `LayoutBox.parent` 冒泡。
5. 同一目标 down/up 且未拖动时，才触发 Bonsai 语义上的 click。
6. 点击事件未被消费时，回落到现有 scrollbar、链接和文本选择流程。
7. 保留 `Ctrl+O` 等键盘路径。

这个范围已经足够支持：

- 欢迎页 Skills/Extensions 展开；
- 点击 tool 摘要打开详情。

### 暂不借鉴

- 原生 `u32` hit grid：当前 pi-tui 已计算 LayoutBox，组件数量和帧率没有证据要求 O(1) 原生命中；先做 JS 反向遍历更小、更容易测试。
- 完整 pointer capture、drop、drag source：当前两个 Bonsai 场景都不需要。
- 通用 Portal/modal 新系统：pi-tui 已有 overlay stack，应该扩展现有系统。
- React/Solid wrapper：Bonsai 没有采用这些声明式前端层的必要。
- main-screen mouse capture：会改变用户终端的原生交互，应等明确需求。

### 何时升级成 OpenTUI 式 hit grid

只有在以下任一条件出现并被 profile 证实时再升级：

- 一个 frame 中有数千个可命中组件；
- 深层滚动/overlay 下的 JS hit-test 成为可测量热点；
- hover 动画需要高频命中且反向遍历产生卡顿；
- 渲染顺序和 layout tree 顺序无法再可靠对应。

在此之前，OpenTUI 最值得借鉴的是事件边界和测试思路，不是它的 Zig 数据结构。
