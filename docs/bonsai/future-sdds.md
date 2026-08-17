# Bonsai Future SDD Index

> 状态：索引，不是实施授权。

## 已有独立 SDD

- sdd-context-evolution.md：structured memory、native compaction、evidence、revision、persistence、recovery 和 rewind。
- sdd-node-delegation.md：explorer/worker 等 node-local delegate。

## 尚未创建独立 SDD

以下方向只记录名称。用户继续讨论并形成明确目标后再创建规格：

- trace GUI 与上下文可视化
- MCP/context catalog 重构
- workspace isolation、worktree 和 merge
- prompt-cache affinity 优化
- 通用 multi-agent coordination
- deployment、packaging 和 release

## 规则

- 未进入独立 SDD Review 的能力不得加入 Phase 1 实施计划。
- 不创建 placeholder package、class、interface 或配置。
- 新模块必须说明它依赖哪些现有模块，以及删除它是否会影响 Spine core。
