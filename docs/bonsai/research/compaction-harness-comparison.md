# Compaction Harness 源码对比

> 状态：Phase 1 架构研究，不是实施授权。
>
> 结论类型：本文将源码事实、Bonsai 直接采用项和待决产品契约分开。

## 1. 研究范围与版本

本轮只比较 coding-agent harness 的会话压缩，不比较长期记忆检索或 Task Tree 调度本身。

| Harness | 固定版本 | 主要源码 |
|---|---|---|
| pi / Bonsai host | `096b022b15c0dd40734393eaccd06505d84a745f` | `packages/coding-agent/src/core/compaction/`、`agent-session.ts`、`session-manager.ts` |
| Fermi | `1d0d4171a6bf9648d2395a5b50a81318a90db298` | `src/session/context-manager.ts`、`compact-prompts.ts`、`active-context.ts`、`log-projection.ts`、`session.ts` |
| Grok Build | `9fabadea800fa6e2ed8ec91c4f45f02b7e2504f4` | `crates/common/xai-grok-compaction/`、`crates/codegen/xai-grok-shell/src/session/compaction.rs`、`two_pass.rs` |
| Raven | `059e1c1ee30b5273f59ec832771b49e47330a2fe` | `raven/context_engine/curator.py`、`history_trimmer.py`、`segments/curator.py` |

当前结论来自静态源码与测试代码阅读。本轮没有运行这些外部项目的测试，也没有用二手文章补充源码空白。

## 2. 结论摘要

没有一套实现可以整体搬进 Bonsai：

- pi 的 append-only session 与投影入口适合保留，但固定 `keepRecentTokens` cut point 不适合作为 Bonsai 的核心选择策略。
- Fermi 最值得采用的是 output headroom、两级压力提醒、hysteresis、自然边界收尾和可恢复窗口；其 continuation 仍主要依赖自然语言。
- Grok Build 最值得采用的是 summarizer 输入降级、tool-pair safe split、失败分类、stale prefire cache 校验和压缩收益检查；其 checkpoint 通过异步 channel best-effort 持久化，不能满足 Bonsai 的 durable-commit 契约。
- Raven 最值得采用的是 manifest、lossless archive、结构校验和 deterministic fallback；Phase 1 不应再引入一个可自治的 Curator agent 来决定主 node 的硬事实。

Bonsai compaction 应在 Spine projection 之后运行：先利用 Task Tree 把 Closed subtree 降为 Node Memory，再处理仍然增长的 active path。否则 compactor 会重复解决 SpineJIT 已经解决的问题，并可能破坏 node ownership。

## 3. 对比表

| 维度 | pi | Fermi | Grok Build | Raven | 对 Bonsai 的含义 |
|---|---|---|---|---|---|
| 触发与 headroom | `contextTokens > contextWindow - reserveTokens`；默认 reserve 16384 | 提示约 50%/75%，before-turn 85%，mid-turn 90%；预算考虑输出空间 | 默认约 85%；pre-sampling、tool backfill 后和 overflow 都检查 | history 超过可用预算约 60% 才进入 slow path | 使用有效 prompt budget 与 soft/hard pressure；具体百分比留给 trace 校准 |
| 安全边界 | cut point 不落在 tool result；可拆 oversized turn | mid-turn 只在 tool-call 路径；child 高压优先收尾 | split 会吸附到完整 tool request/result 边界 | adjacency closure 补齐 call/result，再验证结构 | assistant 输出与完整 tool group 是最小原子单元 |
| 选择与裁剪 | 从尾部按 `keepRecentTokens` 保留 suffix | 模型在 compact phase 生成定向 continuation；真实 user messages 受保护 | full-replace；输入过大时按有序 ladder 丢旧 history、截大 tool result、丢旧 step、最后 emergency | fast path 原样通过；slow path 从 manifest 选择 message ids，并可 lossless archive | 先按 Spine node 语义选择，再在 active path 内做 message-level cleanup |
| 摘要与 continuation | 固定 Markdown summary，迭代时合并 previous summary | 最多 10 轮 compact phase，可用工具；输出 continuation prompt | summary turn + runtime reminder；可加入 active task/subagent/MCP/todo 状态 | 独立 working state + selected history，不要求把一切改写成 summary | runtime 组装结构化硬事实，模型只补语义与 intent |
| 原始事实与恢复 | compaction entry 改投影，旧 JSONL entries 保留 | 旧窗口 gzip archive；rewind 可恢复 | checkpoint 与 `updates.jsonl` 支持 replay/rewind | JSONL archive、manifest 与每轮 trace | append-only rollout 是唯一权威 archive；其他索引必须可重建 |
| 失败与 commit | overflow compact 后最多重试一次 | 失败不应产生新窗口；自然边界优先 | transient 最多重试；deterministic failure 会分类抑制；checkpoint 发送后替换 live conversation | slow path 异常走 deterministic fallback | 失败或取消必须保持旧 epoch；durable commit 成功后才切换 epoch |
| 延迟与 cache | 同步单次 summary | 同步 compact phase | 可在阈值前后台做 pass 1；用 prefix fingerprint + model slug 拒绝 stale cache | slow path 是额外有界 agent loop | Phase 1 保持同步；预计算只保留接口，测量证明收益后再启用 |

## 4. 各实现的源码事实

### 4.1 pi

- 默认 `reserveTokens=16384`、`keepRecentTokens=20000`。
- 触发主要由 context window 与 reserve 的固定差值决定。
- cut point 从尾部按预算反向选择，不从 tool result 开始；必要时可在 assistant 后拆分一个 turn，并单独总结被切走的 prefix。
- 单个 tool result 进入 summary prompt 前截断到 2000 字符。
- `CompactionEntry` 持久化 summary 与 `firstKeptEntryId`；当前投影变成 summary、kept suffix 和 compact 后的新消息，原 session entries 保留。
- overflow 可 compact 后自动重试一次；普通 threshold compact 不等同于同一 turn 的无界重试。

判断：pi 的持久化事实与 extension 接缝可复用，但固定 suffix 是语法型保留，不理解 node、约束、验证和未完成工作。

### 4.2 Fermi

- 压力评估扣除 output headroom，并用两级提示与 hysteresis 避免在阈值附近反复提示。
- soft pressure 鼓励 agent 在自然边界先调用 `summarize_context`；root 可自动 compact，child 高压时优先要求收尾。
- mid-turn compact 只在 tool-call 路径发生，text-only 响应留到下一轮前处理。
- compact phase 最多运行 10 轮且可以使用工具，最终生成 continuation prompt。
- `compact_marker + compact_context` 建立新窗口；旧窗口归档，rewind 可恢复；plan snapshot 会跨 compact 注入。

判断：Fermi 给出了比 pi 更好的 pressure 与 continuation 生命周期，但自然语言 continuation 不能单独承担 Bonsai 的事实恢复。

### 4.3 Grok Build

- 同时存在 turn 间 full-replace 和 turn 内 history/step compaction，不能把两者的 guard 混为一谈。
- full-replace summarizer 输入 overflow 时按 `verbatim -> fitted verbatim -> lossy` 降级；fitted 输入会给 summary 和 tool definitions 预留空间。
- safe split、sanitize 与 validation 都围绕完整 tool call/result pair；无法修复时回退到不带 recent messages 的最小合法 history。
- intra-compaction 默认要求至少约 20% reduction（`max_reduction_ratio=0.8`）；full-replace 主要拒绝 empty 或过短的 degenerate summary，不是同一个 guard。
- two-pass prefire 在正式阈值前约 10 个百分点总结约 95% prefix。正式 pass 2 前会等待进行中的 pass 1，并校验 prefix length、fingerprint 与 model slug；过期或失败则回退 single-pass。
- deterministic failure 会按 size、schema、auth、credit 或 other 分类，并使用不同抑制周期，避免每轮重复触发同一失败。
- 成功路径先向 persistence channel 发送 segment/checkpoint，再调用 `replace_conversation_for_compaction`。发送失败只记日志，因此不是 durable commit barrier。

判断：输入 fit ladder、safe pair、失败分类和 cache staleness 校验值得采用；提交顺序必须加强。

### 4.4 Raven

- `ContextAssembler` 每轮重建上下文，Curator 独占 history slot 和 Working State segment。
- history 低于 `available_history * fast_path_threshold`（默认 0.60）时不调用 Curator 模型。
- slow path 是有界内部 loop，只能读取 manifest/memory、更新 relevance/working state、归档/取回消息并提交 structured context plan，不能调用主 agent 的用户工具。
- `CuratorBuildContextTool` 只有在 deterministic assembler 通过 token budget 和 tool closure 校验后才接受 plan。
- slow path 异常或未提交合法 plan 时，fallback 选择 protected、relevant 与 recent messages，再由相同 trimmer 收敛到预算内。
- archive 是 lossless JSONL；manifest、working state 和 trace 分开持久化。
- 当前 revision 中 `memory_sections` 与 `include_archive_refs` 进入 plan schema，但 assembler 的最终 history build 并没有消费它们。
- archive、relevance 和 working state 工具会在 final plan 接受前直接落盘，因此这些辅助状态不是一个完整的 staged transaction。

判断：manifest、deterministic validation 与 fallback 可借鉴；把 slow-path Curator 作为 Bonsai 必需 agent 会增加成本、状态写入顺序和第二套自治决策面。

## 5. Bonsai 直接采用项

以下属于 correctness 或可测量的工程机制，不需要单独形成产品选择题：

1. Pressure 使用有效 prompt budget，明确扣除 output headroom、system/tool definitions 与安全 reserve。
2. soft pressure 只发一次 checkpoint/收尾请求，使用 hysteresis；hard pressure 在下一个合法边界执行。
3. 完整 assistant response 与 tool call/result group 是不可拆分原子单元。
4. summarizer 输入必须有 deterministic fit ladder，避免“因为待压缩内容本身过大而永远无法压缩”。
5. compact 产物先进入 staged state；schema、引用、结构、预算与 lineage 全部校验通过并 durable commit 后，才追加 marker 并切换 live epoch。
6. 失败、取消或 stale background result 不改变当前 epoch。
7. append-only rollout 是 lossless archive 和 replay 权威；manifest、压缩缓存和索引都是可重建派生物。
8. Phase 1 不默认启用 two-pass prefire。接口可保留 `epoch/cursor + prefix fingerprint + model id + policy version`，待 trace 证明延迟收益大于额外成本后再启用。

## 6. 明确不直接采用

- 不以 pi 的固定 recent suffix 作为主要语义选择器。
- 不让 Fermi 风格的自然语言 continuation 成为唯一恢复事实。
- 不采用 Grok Build 的 checkpoint best-effort send 后立即替换 live history 的提交顺序。
- 不在 Phase 1 引入 Raven Curator 作为另一名自治 agent；模型不能单独决定哪些用户约束、验证事实或 evidence refs 消失。
- 不把 Grok intra-compaction 的固定 20% reduction guard 未经调整地套到整个 epoch transition。system prompt、工具定义和不可裁剪 continuation 会让相同比率对不同模型失真。

## 7. 第三组已确认契约

1. semantic selection 使用 Spine-aware deterministic policy。runtime 决定必须保留的 active path、约束、验证与 evidence refs；模型只做语义综合，不能单独决定硬事实消失。
2. 新 epoch 保留有界 verbatim user bundle：当前任务、仍有效约束与后续更正保留原文，其他消息留在 append-only rollout 并通过 refs 追溯。不会把全部历史 user messages 重新注入新 epoch。
3. compaction 成功使用 target-headroom guard：产物必须通过 schema、tool-pair、引用和 lineage 校验，并为下一轮恢复目标 output headroom。固定 reduction ratio 只作为观测指标。
4. hard pressure 下模型 synthesis 失败时，runtime 可以从结构化硬事实生成 runtime-only continuation。它仍须通过相同成功 guard；否则旧 epoch 保持不变并返回可恢复错误。
