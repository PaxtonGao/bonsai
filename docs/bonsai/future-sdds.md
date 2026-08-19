# Bonsai Future SDD Index

> 状态：索引，不是实施授权。

## 已有独立 SDD

- sdd-context-evolution.md：structured memory、native compaction、evidence、revision、persistence、recovery 和 rewind。
- sdd-node-delegation.md：explorer/worker 等 node-local delegate。
- sdd-execution-tree-tui.md：root-local execution tree、child transcript、状态动画和 thinking 折叠。

## 尚未创建独立 SDD

以下方向只记录名称。用户继续讨论并形成明确目标后再创建规格：

- trace GUI、时间线筛选与跨 session 可视化
- TUI tool detail interaction：为 transcript 增加组件级鼠标命中测试，点击单个 tool 摘要时打开详情 overlay；需定义滚动坐标映射、选择冲突、焦点、关闭行为和无鼠标终端的键盘等价路径。
- Resume/trace 的 Bonsai-aware 树视图：按 spawn call 聚合 child session，并显示 task summary、ordinal、outcome 和 execution reference；区分 Spine 节点、spawn 分支与普通 session fork。需要先定义 session metadata，再改 session selector，不在 Phase 1 增加 synthetic batch entity。
- MCP/context catalog 重构
- workspace isolation、worktree 和 merge
- prompt-cache affinity 优化
- 通用 multi-agent coordination
- deployment、packaging 和 release

## 规则

- 未进入独立 SDD Review 的能力不得加入 Phase 1 实施计划。
- 不创建 placeholder package、class、interface 或配置。
- 新模块必须说明它依赖哪些现有模块，以及删除它是否会影响 Spine core。
