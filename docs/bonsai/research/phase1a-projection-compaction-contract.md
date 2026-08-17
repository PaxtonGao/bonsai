# Phase 1A Projection 与 Compaction 契约

> 状态：Phase 1 架构研究，不是实施授权。
>
> 证据基线：pi `096b022b15c0dd40734393eaccd06505d84a745f`；SpineCodex `15cfe2d8b00a0338602533ff2c338a16652a06af`。

## 1. 源码事实

### pi

- provider 请求顺序是 `AgentMessage[] -> transformContext -> convertToLlm -> provider Context`。`transformContext` 是 Bonsai projection 的现有宿主接缝。
- agent loop 要求最终上下文能够转换成以 user 或 tool result 结尾的合法 provider history。
- `transformMessages` 会为 orphaned tool call 合成 `isError: true` 的 `No result provided`，用于满足 provider 配对要求。该 synthetic result 不是持久控制事实。
- 当前 compaction 默认 `reserveTokens=16384`、`keepRecentTokens=20000`，并以 suffix cut point 为主；原始 JSONL entry 不删除。
- 新 `AgentHarness` session schema 已定义 `ToolStartedRecord`，在执行前记录 tool identity、预留 result entry 与 `replay: never | safe`。但当前 `AgentHarness.prompt/resume/compact` 仍未实现，Phase 1 不能假设它已经替代 coding-agent host。

### SpineCodex

- reducer 先从完整 rollout 重建 `visible_context`，adapter 再按 reducer 顺序 materialize provider-native items。
- 完整 `ToolCallGroup` 按 raw span 原子投影；Closed node 的 user memory、Closed child memory 与 summary 按确定顺序 materialize。
- compact replacement baseline 只 materialize 一次；新 epoch 不自动回注旧 epoch memory。

## 2. 单一上下文模块

Phase 1A 使用一个外部 interface：

```text
prepareRequest(durablePrefix, runtimeSnapshot, modelLimits)
  -> PreparedRequestContext | ContextPreparationError
```

该模块内部负责 replay、Spine projection、pressure evaluation、必要 compaction、runtime snapshot materialization 和 provider legality validation。调用者不需要分别理解 reducer、Node Memory、epoch、fit ladder 或 provider pairing。

持久化 control commit 仍由 session/control transaction 接口负责，不塞入 `prepareRequest`。这样 request preparation 保持可重复计算，持久化副作用集中在一个提交接缝。

## 3. 严格 projection 顺序

每次 provider 请求按以下顺序组装：

1. 读取并验证最长合法 durable prefix；recovery/read-only session 不允许正常采样。
2. 从完整、成功、唯一的 canonical control groups replay Task Tree 与 supersede revisions。
3. materialize active epoch baseline；compact replacement history 只出现一次。
4. 按 raw rollout 顺序投影 active path。Live/Opened node 保留详细 history；Closed node 在原 child 位置替换为 preserved user facts、Closed child memories 与当前 Node Memory rendering。
5. node-local runtime evidence 只从 durable、typed、已注册 adapter 的 tool receipt 附加。未知或自由文本 tool result 可以保留 source ref，但不能自动升级为 verified fact。
6. 在 Spine projection 后评估 native compaction。若 compact commit 成功，重新从新 epoch materialize；失败则继续使用旧 epoch。
7. materialize 当前 runtime snapshot。模型、thinking、权限、工具、MCP 和 profiles 以当前 runtime 为权威，不从旧 Task Memory 恢复。
8. 运行 provider legality validator，确认 assistant/tool-result closure、call id、消息角色和最终 turn trigger 合法，再进入 `convertToLlm`。

当前 turn trigger 是最后一个真实 user message，或完整 assistant/tool-result group。synthetic memory、continuation 与 runtime snapshot 不得插入 assistant tool call 与其 results 之间，也不得把 provider history 留在 assistant-only 尾部。

pi 的 orphan synthetic tool result 保留为最后防线，但正常 Bonsai projection 不应依赖它。触发该修复时必须产生 trace diagnostic；synthetic result 永远不进入 Spine reducer 或 durable Task Tree facts。

## 4. Node Memory 失败语义

`close/next` 的结构化 payload 必须通过 schema、fact revision、source ref、category cardinality、总预算与 durable commit 校验。失败统一返回 `ToolResultMessage` error，node 保持 Live，cursor 与 projection 不变。

稳定错误码至少包括：

```text
invalid_task_state
invalid_source_ref
stale_fact_revision
memory_over_budget
durable_commit_failed
```

模型可以在下一轮修正 payload。不得静默截断 protected facts，也不得以 runtime-only memory 假装 close 成功。hard pressure 下如果 node 无法合法 close，由 native compaction 续接 active task，不改变 task outcome。

默认 cardinality guard：constraints 最多 32、decisions 最多 32、work items 最多 64；artifact、verification、user-message refs 各最多 64。更大集合必须聚合或外置为 typed refs。

单个 Node Memory 的默认 model-facing budget 是 `min(4096 tokens, effectivePromptBudget * 0.04)`，且不得低于 schema 和 protected facts 的实际需要。无法满足时返回 `memory_over_budget`，不截断。

## 5. Compaction policy v1

### 有效预算

```text
targetOutputTokens = min(
  model.maxOutputTokens,
  clamp(contextWindow * 0.125, 4096, 16384)
)

safetyReserve = max(2048, contextWindow * 0.02)

effectivePromptBudget =
  contextWindow
  - targetOutputTokens
  - estimatedSystemAndToolTokens
  - safetyReserve
```

所有估算在最终 provider payload 上复核；字符数或字节数只作预检。

### 压力状态

- soft pressure：projected prompt 达到 effective budget 的 75%。同一 epoch/cursor 只提示一次 checkpoint 或自然收尾。
- hard pressure：达到 90%，或 runtime 预测下一次合法请求无法保留 target output headroom。在下一个完整 assistant/tool-result group 边界强制 compact。
- hysteresis rearm：占用降到 65% 以下，或切换 epoch/cursor 后，soft pressure 才重新激活。

阈值属于 versioned `CompactionPolicy`，不是 session fact。trace 可支持后续校准，但 Phase 1 默认值固定，避免运行时自适应产生不可重放行为。

### Continuation budget

continuation 的默认总预算是 `min(8192 tokens, effectivePromptBudget * 0.08)`。verbatim user bundle 最多使用其中 40%；runtime resume snapshot 最多 20%；其余用于 `TaskStateCore`、lineage 与必要 rendering。

fit ladder 固定为：

1. 完整 hard facts、refs 与 optional narrative。
2. 移除 optional narrative 和 rationale。
3. 将 completed、低优先级或可重新提取的 facts 外置为 refs。
4. 使用 runtime-only continuation，只保留 protected hard facts。
5. 若仍无法达到 target headroom，返回 `uncompactable_context`，旧 epoch 保持不变。

首版不注册可跨 epoch 的 active-operation adapter。接口保留，但所有普通未完成 tool call 都必须先到合法边界；这比在 Phase 1A 同时实现进程恢复更简单。后续 adapter 必须提供 validate、poll/resume 和 cancel。

## 6. Archive 与 rewind

- append-only session log 是 lossless archive；compact marker、manifest、cache 和索引都可重建。
- evidence ref 的读取是只读操作，不会自动把 archive 内容重新注入模型上下文。
- `rewind(target)` 不截断或改写原 session，而是从目标 durable prefix 创建新 branch lineage。原 session、旧 epoch 和外部副作用记录保持不变。
- rewind 到 compact 之前时，从 raw log 重新 replay 当时的 Task Tree 与 provider-legal context。
- rewind 不回滚文件、数据库或外部 API 副作用；trace 和用户界面必须明确显示这一点。
- Closed node 在原 lineage 中仍不 reopen。需要重做时，新 branch 使用 `rewindsFrom` 或 successor lineage 表达。

## 7. 最小 trace 与测试 interface

Phase 1 不实现 GUI。最小可观察性由同一上下文模块提供：

```text
inspect() -> BonsaiSnapshot
subscribeTrace() -> BonsaiTraceEvent stream
```

trace 至少覆盖 control accepted/rejected、projection built、memory validation、pressure state、compaction staged/committed/failed、provider repair 和 recovery state。trace 可以持久化为可重建 custom metadata，但不是 Task Tree 权威来源。

最高测试 interface 是真实 coding-agent `AgentSession` 配合 faux provider 和 session store：测试断言最终 provider payload、持久 entries、恢复后 snapshot 与用户可见 error。纯 reducer tests 用于穷举状态转换，但不能替代该链路测试。

## 8. 明确简化

- 不引入第二套可变 Task Tree 数据库。
- 不引入自治 Curator、two-pass prefire 或运行时学习阈值。
- 不为 Node Memory 失败生成隐藏 fallback summary。
- 不直接依赖尚未完成的 `AgentHarness` 执行层；只复用它已定义的 durable record 与 replay-policy语义，保持未来迁移兼容。
