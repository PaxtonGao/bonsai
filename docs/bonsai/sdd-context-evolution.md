# Bonsai Context Evolution SDD

> 状态：Deferred / Incubating
>
> 实施授权：无。本文不属于 Phase 1 SpineJIT/SpineSpawn 交付。

## 1. 目的

本 SDD 收纳 Phase 1 之后的 context、memory、evidence 和 recovery 增强，避免这些能力扩大 Spine parity 的首版实现面。

启动本 SDD 前必须具备：

1. Phase 1A SpineJIT 已通过真实 AgentSession 验收。
2. 已记录 pi 原生 compaction 对 Bonsai 的实际失败 trace、token 数据或任务质量问题。
3. 已确认 string Node Memory 的具体不足，而不是仅凭预期设计结构化 schema。

## 2. 候选模块

### 2.1 Structured Node Memory

候选能力：

- versioned task state
- objective、constraints、decisions 与 work items
- artifact、verification 和 user-message refs
- bounded model-facing rendering
- schema migration

Phase 1 的 NodeMemory = string 是兼容起点。只有测量证明 string memory 无法可靠保留任务状态时才升级。

### 2.2 Native compaction

候选能力：

- Spine-aware selection
- soft/hard pressure 与 hysteresis
- target output headroom
- structured continuation
- staged validation 与 epoch transition
- archive 与 rewind

已确认的长期原则：

- compactor 位于 Spine projection 之后。
- append-only session log 仍是 lossless archive。
- compaction 不能拆开 assistant/tool-result group。
- compaction 失败不得破坏当前有效 epoch。

默认阈值、预算和 fit ladder 在本 SDD 进入 Review 时重新基于 Phase 1 trace 校准。

### 2.3 Evidence 与 revision

候选能力：

- typed evidence refs
- per-fact source association
- fact identity 与 revision
- append-only supersede
- verified tool receipt adapters

这些能力不得改变原始 receipt、NodeId、topology 或 Closed 已发生的事实。

### 2.4 Persistence 与 recovery

候选能力：

- durable control commit
- tool-start journal
- indeterminate external effects
- corrupt-tail quarantine
- spawn salvage/rejoin
- recovery branch 与 rewind

Phase 1 只使用 pi 当前 persistence semantics。本模块若启动，应优先复用完成后的 AgentHarness，而不是在 coding-agent 复制第二套执行日志。

## 3. 研究依据

- research/compaction-harness-comparison.md
- research/continuation-schema-comparison.md
- research/persistence-recovery.md
- research/phase1a-projection-compaction-contract.md

这些文档保存此前较完整的候选设计，但当前都不是实施契约。

## 4. 非目标

- 不修改 Phase 1 的 Spine reducer topology。
- 不把 node-local delegate 混入 context engine。
- 不提前创建 compactor、evidence 或 recovery placeholder interface。
- 不因未来 GUI 需要而改变 session 权威事实。
