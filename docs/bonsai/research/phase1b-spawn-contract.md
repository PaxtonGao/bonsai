# Phase 1B SpineSpawn 契约

> 状态：Phase 1 架构研究，不是实施授权。
>
> 证据基线：pi `096b022b15c0dd40734393eaccd06505d84a745f`；SpineCodex `15cfe2d8b00a0338602533ff2c338a16652a06af`。

## 1. 源码事实

### SpineCodex

- 一个 model response 最多一个 `spine.spawn`，不能与 open/close/next 混用。
- task 至少两个，summary/prompt 必须非空且 summary 不重复。
- host 先做整批 capacity admission，再并发创建 child。容量不足时不创建任何 child。
- 任一 child start 失败后会 teardown 已启动 children；运行期取消会传播并等待 teardown/quiesce。
- parent 等待全部 child 到终态，再生成顺序稳定、schema-versioned 的 typed receipt。
- receipt 校验 task 数量、ordinal、memory、非成功 diagnostic 与 execution ref；reducer 只消费完整合法 receipt。
- child 使用 full-history fork 目标，但源码保留 TODO，尚未验证完整父投影继承与 prompt-cache 命中。
- 上游没有进程崩溃后的自动 rejoin。

### pi

- `createAgentSessionFromServices()` 可以在同进程中基于已有 cwd-bound services 创建新的 AgentSession，并单独注入 session manager、model、thinking 和 tool selections。
- `AgentSession` 已支持 allowed/excluded tools、abort、独立 session persistence 与 faux-provider 测试。
- `Agent.sessionId` 同时进入 provider affinity/header、prompt cache key、WebSocket connection cache 和 session resource cleanup。它不是单纯的生命周期 ID。
- 新 `AgentHarness` durable schema 已定义 operation/tool started records 与 `replay: never | safe`，但执行与 resume 方法尚未实现。

## 2. Spawn 模块 interface

Phase 1B 只暴露一个外部 interface：

```text
spawnBatch(parentSnapshot, tasks, policy, cancellation)
  -> SpawnReceipt | SpawnError
```

模块内部负责 admission、child construction、lifecycle、join、receipt validation、durable commit 和 crash salvage。父 AgentSession 不直接管理 child arrays、poll loops 或部分 receipts。

## 3. Child fission

每个 child：

- 是独立、进程内 AgentSession，不启动额外 pi 进程。
- 从同一个 immutable parent `PreparedRequestContext` snapshot 创建；所有 sibling 共享完全相同的父前缀，只在尾部追加各自 task envelope。
- 继承创建时的 system prompt、model、thinking、active tools、runtime instructions 和有效权限上限。
- 拥有独立 session manager、session ID、trace、取消 token 和 execution ref。
- 权限采用 creation snapshot 加单调收窄：父级或全局后续撤销会传播，后续扩权和新增工具不会传播。

Phase 1 默认最大 spawn 深度为 1。child 可以使用 SpineJIT 的 open/close/next 管理自身上下文，但不暴露 `spine.spawn`。这是有意简化：避免在首版同时实现递归 capacity accounting、跨层取消、嵌套 crash salvage 和指数级 side effects。

## 4. Admission 与资源 policy v1

- 每次 spawn 最少 2、最多 4 个 tasks。
- 每个 parent session 最多 4 个 active SpineSpawn children；admission 计算当前已占用槽位。
- capacity 必须整批预留。容量不足返回 `spawn_capacity_exceeded` tool error，零 child 创建、零 Task Tree 导入。
- child start 属于 admission transaction。任一 child 无法启动时，取消并清理已经启动的 siblings，返回 `spawn_start_failed` tool error，零 Task Tree 导入。
- batch 默认 wall-clock timeout 为 30 分钟；单 child 连续 5 分钟没有 model、tool 或 trace progress 时可以单独取消并标记 `cancelled`。policy 可配置，但必须写入 batch trace。
- Phase 1 不增加独立 token quota scheduler；child 使用模型自身 context/output limits，runtime 记录每个 child 的 token、tool-call 和 wall-clock usage。

## 5. Join 与 receipt

parent 在 receipt durable commit 前保持等待。progress event 只用于 trace/UI，不是 reducer 事实。

```text
SpawnReceipt
  schemaVersion
  batchId
  parentNodeId
  results[]  // exact task order

SpawnResult
  ordinal
  childSessionId
  outcome: succeeded | partial | failed | cancelled
  memory: NodeMemoryEnvelope
  diagnostic?
  executionRef
  artifactRefs[]
  verificationRefs[]
```

所有 tasks 启动成功后，业务失败属于 child outcome，而不是 spawn tool transport failure。完整合法 receipt 可以同时包含 succeeded、partial、failed 和 cancelled，并作为一个成功 tool result 原子导入全部 Closed children。失败 children 仍必须提供 bounded memory 与 diagnostic。

receipt 缺项、ordinal 错误、schema 错误、非法 refs 或 durable commit 失败时，整个 spawn tool result 为 Error，零 child 导入；child sessions 和 trace 保留供审计。

## 6. 取消

- parent abort 传播到 batch 和所有 active children。
- child 先进入 cancelling，再由其 AgentSession abort tool/model work；coordinator 等待 terminal 或 teardown deadline。
- 父级取消后仍要 durable 写入可恢复的 batch terminal metadata。已形成完整 receipt 时可以在 replay 中导入 cancelled/partial children；没有合法 receipt 时 control group 是 tree no-op。
- 取消不会回滚 filesystem、database、MCP 或外部 API 副作用。

## 7. Crash recovery

Phase 1 不实现自动 rejoin 或自动继续 child 执行。该能力需要恢复 provider stream、工具进程、权限批准和并发槽位，成本超过首版收益。

采用 bounded salvage：

1. child 创建前，在 parent session JSONL durable 记录 batch intent、tasks、policy 和预留 child identities。该 metadata 兼容 pi `operation_started/tool_started` 的 identity 与 replay-policy 语义，但最终 spawn receipt 仍是唯一 Task Tree 控制事实。
2. 每个 child 使用独立 durable session log。
3. 重启发现 running batch 且没有 final receipt 时，读取 child durable prefixes。已 committed terminal memory 的 child 可以恢复为原 outcome。
4. 未终态 child 不自动重执行。若没有 replay-never tool intent，可标记 cancelled；若存在已开始但无 result 的 replay-never tool，则标记 partial，并附 `indeterminate_external_effect` diagnostic。
5. 能组成完整合法 receipt 时，durable commit 后原子导入全部 recovered children。metadata 缺失、child identity 冲突或 receipt 无法验证时，返回 `spawn_recovery_failed` error，零导入并进入显式 recovery 状态。

## 8. Workspace 与外部副作用

Phase 1 保持 pi 当前共享 workspace 与工具语义，不创建 per-child worktree、事务式数据库或自动 merge。Task Tree import 的批次原子性不代表外部副作用原子性。

并行任务应由模型声明为差异化任务；runtime 记录每个 mutating tool receipt 的 artifact refs。冲突检测、isolated worktree 和自动 merge 属于后续能力。发生不确定副作用时使用 Phase 1A 的 `indeterminate_external_effect` 契约，禁止自动重试。

## 9. Session identity 与 prompt cache

每个 child 使用唯一 session ID。Phase 1 不拆分 lifecycle identity 与 prompt-cache identity，因为 pi 的 session ID 横跨 provider affinity、WebSocket cache、prompt cache 和资源清理，修改会穿透 provider stack；SpineCodex 固定版本也没有验证共享 cache key 的命中收益。

父前缀相同仍可能获得 provider 的自动 prefix caching。trace 必须记录 child 首次请求的 cache-read/cache-write tokens。只有测量证明独立 session ID 显著损害命中率时，后续版本才增加独立 `cacheAffinityKey`。

## 10. 权限

- child effective permissions = parent creation snapshot intersect child policy intersect current global revocations。
- child 不能扩大 filesystem roots、shell/MCP approval、credential access、tool allowlist 或网络权限。
- parent 后续扩权不传播；撤权传播并可以取消受影响的 active operation。
- depth-1 child 的 tool set 移除 `spine.spawn`。node-local delegate 规则不属于本模块。

## 11. 测试 interface

最高测试 interface 使用真实 parent/child AgentSession、faux provider 和独立 session managers。测试断言：

- siblings 的首次 provider payload 拥有相同父前缀和不同 task tail。
- capacity/start failure 创建零 imported child。
- runtime child failure形成合法 receipt 并原子导入全部 outcomes。
- parent abort 传播且最终状态可 replay。
- crash salvage 不自动重执行 replay-never tool。
- child 不能扩权或调用 nested spawn。
- unique session IDs 不共享生命周期资源；cache usage 进入 trace。

纯 coordinator/reducer tests 负责穷举 ordinal、receipt 和状态机，但不能替代真实 AgentSession 链路。
