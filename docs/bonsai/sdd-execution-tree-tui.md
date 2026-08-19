# Bonsai Execution Tree TUI SDD

> 状态：Implementation Approved
>
> 范围：当前 root session 内的 Spine 节点、delegate 与 SpineSpawn child 可观察性。

## 1. 目标

- `/resume` 只列出可恢复的 root sessions，不把内部 child execution 当作顶层会话。
- `/treeview` 在当前 root session 内展示可导航的执行树。
- 用户可以从树进入 child transcript，并返回主 transcript。
- active、waiting 和 terminal 状态在普通 tool、Agents 与 treeview 中保持一致。
- reasoning 流式时展开，完成后折叠为可重新展开的 `Thinking` 行。

## 2. 领域边界

~~~text
Root session
├─ Spine node                 // 同一 root AgentSession 内的上下文节点
│  ├─ delegate execution     // 独立 child AgentSession，不改变 Spine 树
│  └─ spine_spawn operation  // Spine control group
│     ├─ child execution     // 独立 child AgentSession + Closed Spine child
│     └─ child execution
└─ Spine node
~~~

- Spine node 不是 session，点击后定位 root transcript 中对应的消息区间。
- delegate 与 SpineSpawn child 是独立 AgentSession，拥有独立 transcript。
- delegate 挂在调用时的 Spine node 下，但不成为 Spine child。
- `execution_ref` 是 receipt、运行时 snapshot 与 transcript 的稳定关联键。

## 3. Persistence 与恢复

- child transcript 位于 root session 专属的 `agents/<execution_ref>/` 路径，不参与 `SessionManager.list()` 的 root session 扫描。
- root session log 继续作为 Spine tree 的权威事实。
- root session 持久化足够的 execution metadata，使 `/resume` 后可以重建 treeview 并按需读取 child transcript。
- 运行中的 child 由 root-local registry 暴露 snapshot；终态 child 释放 AgentSession，但保留 metadata 与磁盘 transcript。
- 缺失或损坏的 child transcript 只影响该 child 的查看，不影响 root session 恢复。

## 4. `/treeview`

- `/tree` 保留现有的 JSONL branch 导航语义；新命令固定为 `/treeview`。
- treeview 复用现有 Unicode tree、扁平化、滚动、键盘选择与 overlay 能力。
- 默认展开当前路径和 active executions；用户可以展开/收起 operation 节点。
- 上下键移动，左右键展开/收起，Enter 打开选中项，Esc 关闭或返回主 transcript。
- 点击行为与 Enter 等价；键盘路径始终完整可用。
- child transcript 第一版只读。运行中允许中断，不允许继续发送消息。

## 5. 状态与动画

~~~text
active       青色 shimmer，显示累计耗时
waiting      琥珀色慢速 shimmer
completed    静态绿色
failed       静态红色
interrupted  静态灰色
~~~

- shimmer 只扫过状态标记或动作标题，背景和树枝保持静态。
- 动画由 runtime 状态驱动，不调用模型。
- 没有 active/waiting 项时停止 timer。
- terminal 状态一旦写入立即停止动画。
- 普通 tool、Agents 面板和 treeview 共享同一状态语义。

## 6. Thinking

- reasoning 流式到达时自动展开并持续更新。
- assistant message 结束后自动折叠成 `Thinking` 行。
- 点击或键盘操作只切换该 thinking run，不修改全局设置。
- 现有全局 hide-thinking 设置继续作为总开关；开启时逐块交互不可见。

## 7. 模块职责

- Bonsai core：child 路径、execution registry、snapshot、tree projection。
- coding-agent interactive mode：`/treeview`、transcript 数据源切换、Agents 展示、thinking 状态。
- pi-tui：最小普通 Component mouse dispatch 与通用 shimmer primitive。
- 不引入 OpenTUI、React、原生 hit grid、通用 scheduler 或新的持久化数据库。

## 8. 验收 seam

1. `SessionManager.list()` 不返回 child transcript。
2. root session 恢复后 tree projection 保持 Spine/execution 归属和顺序。
3. `/treeview` 的键盘选择可以打开 root、Spine node 与 child transcript。
4. mouse click 与 Enter 触发相同导航，拖动选择文字不误触发 click。
5. active 与 waiting shimmer 会刷新；进入 terminal 后 timer 停止且颜色固定。
6. thinking 在流式期间展开，结束后折叠，并能逐块重新展开。
7. child transcript 损坏时 treeview 保持可用并显示局部错误。

## 9. 非目标

- 不迁移到 OpenTUI。
- 不实现 persistent subagent 对话。
- 不实现 GUI trace、时间线筛选或跨 root session 全局 execution 搜索。
- 不绘制像素级曲线；TUI 使用 Unicode 连接线、颜色和状态动画表达层级。
