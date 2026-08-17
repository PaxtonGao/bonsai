# Bonsai Phase 1 SDD

> 状态：Implemented，等待 feature branch 人工验收
>
> 实施授权：已获 Phase 1 开发与 feature branch 推送授权；未获 main 合并或部署授权。
>
> 证据基线：实现基线 pi 096b022b15c0dd40734393eaccd06505d84a745f；兼容性基线 pi 87205484bf749c2140fef5d1bea68995d57e739c；SpineCodex 15cfe2d8b00a0338602533ff2c338a16652a06af。
>
> 源码结论来自固定版本静态分析；SpineCodex 测试未在本环境运行。

## 1. 目标

Phase 1 只完成 Bonsai 最核心的两项能力：

1. Phase 1A：把 SpineJIT 的任务树、控制事件、reducer、projection、epoch 和 trim 行为完整移植到 pi coding-agent。
2. Phase 1B：把 SpineSpawn 移植为进程内 AgentSession 并发分支。

Phase 1 不建设独立 Bonsai runtime。pi 仍负责模型调用、AgentSession、SessionManager、工具执行、权限、provider 转换和原生 compaction。

## 2. 非目标

以下能力已拆到独立未来 SDD，不阻塞 Phase 1：

- 自研 native compactor、结构化 Node Memory、evidence refs、supersede、rewind 和 crash-safe execution journal：见 sdd-context-evolution.md。
- node-local delegate profiles 与 receipt runtime：见 sdd-node-delegation.md。
- MCP 重构、trace GUI、workspace isolation 和其他尚未充分讨论的模块：见 future-sdds.md。

Phase 1 不实现自动 spawn rejoin、事务化外部副作用、独立 prompt-cache identity 或通用 multi-agent scheduler。

## 3. 设计原则

- 完整移植 SpineJIT/SpineSpawn 已实现行为，不重新发明其核心状态机。
- 模块化依靠纯函数、单向依赖和职责隔离，不为单一实现创建 factory、manager 或空 interface。
- 原始 pi session log 是权威事实；Bonsai Task Tree 是可重放派生状态。
- invalid、failed、incomplete 或 ambiguous control group 对 Task Tree 必须是 no-op。
- 与 pi 现有机制没有冲突时直接复用；发生冲突时由 Spine projection 结果优先。

## 4. 模块与依赖

逻辑模块建议映射到 packages/coding-agent/src/core/bonsai/：

~~~text
model.ts         Task Tree、epoch、cursor、node 和 control event
reducer.ts       从 canonical events 确定性重放 Task Tree
projection.ts    把 Task Tree 投影为下一次模型上下文
tools.ts         open、close、next、trim 的工具定义与输入校验
spawn.ts         唯一直接管理 Phase 1B child AgentSession 与 typed receipt 的模块
integration.ts   pi SessionManager、tool 注册和 transformContext 接入
~~~

依赖方向固定为：

~~~text
model <- reducer
model <- projection
model <- tools       <- integration
model <- spawn       <- integration
reducer/projection   <- integration
~~~

- model、reducer 和 projection 不引用 AgentSession、provider、filesystem 或 UI。
- tools 是 control tool adapter，只把合法调用编码成 model 中的 canonical facts。
- spawn 是唯一直接管理 child AgentSession 的模块。
- integration 负责读取 session facts、注册 tools/spawn 并安装 projection。
- reducer 不依赖 tools、spawn 或 child runtime。
- 文件可以在实现时按现有代码规模合并；模块职责和依赖方向不能混合。

## 5. Phase 1A：SpineJIT parity

### 5.1 Control tools

Phase 1A 注册以下工具并沿用上游参数语义：

~~~text
spine_open(goal)
spine_close(memory)
spine_next(goal, memory)
spine_trim(...)  // 参数 schema 与固定版本上游保持一致
~~~

- summary 和 memory trim 后必须非空。
- handler admission 与 reducer replay 都必须校验 control。
- 一次 assistant response 最多接受一个结构控制调用；非法组合返回 tool Error。
- tool Error、缺失 tool result、重复 control 或 malformed payload 不改变 Task Tree。
- `spine_trim` 只裁剪仍可由相邻合法 trim identity 定位的普通 tool result，不创建 node 或 Node Memory。

### 5.2 Task Tree

- Node 分为 root epoch 与 task node。
- 每个 epoch 只有一个 cursor。
- open 在当前 node 下创建并进入 child。
- close 保存当前 node memory，将其标记 Closed，并返回 parent。
- next 原子 close 当前 node，再创建并进入 sibling。
- Closed node 不 reopen。
- NodeId 由 epoch 与 append-only child ordinal 确定；同一 canonical event 序列必须生成相同 NodeId。
- 完整 assistant/tool-result group 只能归属于一个 node，不能跨 node 拆分。

模型提交的 Node Memory 第一版使用上游字符串语义：

~~~text
type NodeMemory = string
~~~

reducer 另外按原始位置维护有序 projection slots：真实 user messages、Closed child memories、最后是当前 node 的 Node Memory。它们只用于复现上游投影，不构成结构化 task-memory schema。

不在 Phase 1A 增加 outcome、fact revision、source refs 或结构化 memory schema。

### 5.3 Reducer

reducer 输入是从 pi session entries 提取的 canonical Spine events，输出完整 Task Tree snapshot：

~~~text
reduceSpine(events) -> SpineSnapshot
~~~

- reducer 必须是纯函数，不读取 AgentSession、provider、filesystem 或全局配置。
- replay 从头计算；Phase 1 不实现增量 reducer 或派生数据库。
- failed、incomplete、ambiguous 和 unsupported events 保留在原 session trace，但不改变 tree。
- session branch 或恢复后使用同一 reducer 重新得到 tree。

### 5.4 Projection

~~~text
projectSpine(entries, snapshot) -> AgentMessage[]
~~~

- Live/Opened node 保留详细工作历史。
- Closed node 在原位置使用真实 user messages、全部 Closed child memories 和当前 node memory 替换详细工作历史。
- 投影保持原始 rollout 顺序和完整 assistant/tool-result pairing。
- projection 不修改 session entries。
- projection 结果通过 pi 现有 transformContext 进入 provider pipeline。
- pi 的 orphan tool-result repair 只作为最后防线；正常 Spine projection 不得依赖它。

### 5.5 Epoch 与 pi compaction

Phase 1 不实现 Bonsai native compactor。pi 原生 compaction 继续作为 root/live task 的兜底。

- integration 把当前有效 pi compaction replacement 映射为新的 Spine root epoch。
- 新 epoch 只投影其 baseline 与之后的 canonical events；旧 epoch 保留在 session log 供审计。
- Spine projection 在 provider 请求前运行；不得建立双 compactor 或 fallback coordinator。
- 如果实现测试证明 pi compaction 破坏 projection correctness，只修复该冲突；完整 compactor 替换属于未来 SDD。

## 6. Phase 1B：SpineSpawn parity

### 6.1 Spawn control

~~~text
spine_spawn(tasks[]) -> SpawnReceipt | ToolError
~~~

- 一次 spawn 至少 2 个、最多 4 个 tasks；task prompt 必须非空，summary 不得重复。
- 每个 parent 同时最多运行 4 个 SpineSpawn children。
- 一次 assistant response 最多一个 spawn，且不能与 open/close/next 混用。
- capacity admission 必须整批完成；容量不足时不创建任何 child。
- parent cursor 不移动。只有完整合法 receipt 才导入 Closed children。

### 6.2 Child AgentSession

- child 使用现有 createAgentSessionFromServices() 在同一进程内创建，不启动额外 pi 进程。
- 所有 siblings 继承生成当前 spawn call 时使用的同一份 pre-response projected context。
- 该 prefix 不包含 assistant 的 spawn tool call 或当前 spawn tool result；task 作为新的尾部 user message。
- child 继承创建时的 model、thinking、system prompt、cwd、active tools 和有效权限。
- child 使用独立 SessionManager、session ID、abort signal 和 trace。
- child tool set 删除 `spine_spawn`；child 仍可使用 open/close/next/trim 管理自身上下文。
- child 不得扩大 parent 权限或工具 allowlist。

### 6.3 Join 与 receipt

parent 等待全部 child 进入终态，再生成顺序稳定的 receipt：

~~~text
SpawnReceipt
  schema: "spine.spawn.result.v1"
  results[]  // exact task order

SpawnResult
  ordinal
  outcome: completed | errored | aborted
  memory_body: string
  diagnostic?
  execution_ref?
~~~

- 业务失败属于 child outcome，不自动变成 spawn transport error。
- errored 或 aborted child 必须提供非空 memory_body 和 diagnostic。
- receipt 必须校验 schema、数量、ordinal、identity、memory_body 和 diagnostic；execution_ref 存在时必须非空。
- receipt 完整合法时，reducer 按请求顺序一次性导入全部 Closed children。
- receipt 缺失、malformed 或无法配对时，整个 spawn control 是 tree no-op；child logs 保留。

### 6.4 Cancellation 与进程崩溃

- parent abort 传播到全部 active children，并等待 child terminal 或 teardown deadline。
- 取消不回滚 filesystem、database、MCP 或外部 API 副作用。
- Phase 1 不实现自动 rejoin、自动 replay 或 crash salvage。
- 进程崩溃前没有在 pi session log 中形成完整 receipt 的 batch 不导入 Task Tree；独立 child session log 保留供人工检查。

### 6.5 Workspace 与 cache

- children 共享当前 workspace；Phase 1 不创建 worktree、事务或自动 merge。
- 每个 child 使用唯一 pi session ID，不拆分 prompt-cache identity。
- prefix cache 是否命中只作为 provider 观测指标，不属于 correctness 验收条件。

## 7. pi integration

- integration 从 SessionManager 当前 branch path 读取原始 entries。
- canonical event parser 只接受完整 assistant tool-call 与匹配 tool-result group。
- control tool success 使用普通 pi ToolResultMessage 持久化；不建立第二份 Task Tree 数据库。
- projection 安装到 Agent.transformContext，并在 convertToLlm 之前执行。
- Spine tools 使用 pi 现有 tool registration、argument validation、allowed/excluded tools 和 abort signal。
- Bonsai 启用方式由 integration 注册决定，不增加两套运行时 feature flags。
- Phase 1 使用 pi 当前 persistence semantics，不增加 fsync transaction、result-ID reservation 或 execution journal。

## 8. 错误语义

- handler validation failure：返回 tool Error，tree 不变。
- incomplete 或 unmatched tool group：tree no-op，原始 entries 保留。
- reducer invariant failure：当前请求失败并产生 diagnostic，不使用部分 tree。
- projection 产生非法 provider history：当前请求失败，不回退到未经投影的 raw history。
- spawn capacity/start failure：tool Error，零 child 导入。
- child business failure：进入 SpawnResult outcome；完整 receipt 仍可导入。
- parent cancellation：取消 active children；已有外部副作用不回滚。
- process crash：只信任重启后可从 pi session log 读取的 entries；不自动重放工具或 unfinished spawn。

## 9. 验收测试

最高测试 interface 使用真实 coding-agent AgentSession、faux provider 和 SessionManager。纯 reducer tests 只补充状态穷举。

Phase 1A 必须覆盖：

1. 相同 entries replay 得到相同 tree、cursor 和 NodeId。
2. open 创建 child 并移动 cursor。
3. close 保存 memory、关闭 node 并返回 parent。
4. next 原子关闭当前 node并进入 sibling。
5. failed、incomplete、重复或 ambiguous control group 是 tree no-op。
6. Closed history 从 provider payload 消失，但真实 user messages、child memories 和 node memory 保留。
7. projection 保持 assistant/tool-result pairing。
8. session branch replay 只使用当前 branch path。
9. pi compaction replacement 创建新 epoch，旧 epoch 不进入当前 projection。
10. `spine_trim` 只裁剪合法目标；stale/invalid trim identity 返回 Error。

Phase 1B 必须覆盖：

11. siblings 使用相同 pre-response prefix 和不同 task tail。
12. capacity 或任一 child start 失败时零 child 导入。
13. mixed child outcomes 形成完整 receipt，并按请求顺序原子导入。
14. malformed receipt 导致整批 tree no-op。
15. parent abort 传播到所有 active children。
16. child 无法调用 nested `spine_spawn` 或扩大权限。
17. 进程恢复时没有完整 receipt 的 batch 不导入。

## 10. 实施顺序

1. model 与 canonical event types。
2. reducer 与纯状态测试。
3. projection 与 provider-pairing 测试。
4. open/close/next/trim tools。
5. integration 与真实 AgentSession faux-provider 测试。
6. spawn child construction、join、receipt 和 cancellation。
7. Phase 1B 真实 AgentSession 测试。

Phase 1B 依赖 Phase 1A 的 projection 和 reducer 已通过验收；两阶段不并行实现。

## 11. Deferred SDD

- sdd-context-evolution.md：context 与 memory 的后续增强。
- sdd-node-delegation.md：node-local delegate。
- future-sdds.md：尚未成熟到独立规格的模块索引。

research/ 下的既有文档继续保存源码比较、复杂方案和历史判断，但不自动成为 Phase 1 实施契约。

## 12. Review 闸门

本文进入 Review 前必须满足：

1. SpineJIT parity 清单无高优先级未决项。
2. SpineSpawn snapshot、receipt、取消和权限语义冻结。
3. 模块职责和依赖方向冻结。
4. pi compaction 只作为明确兜底，不混入自研 compactor。
5. 验收测试覆盖正常、非法、取消和恢复路径。
6. 所有未来增强已移出 Phase 1 实施范围。

Review 经用户确认后才能生成实施计划；状态提升本身不授权提交或部署。

### 12.1 实施与验证结果

- Phase 1 已按第 4 节模块边界实现在 packages/coding-agent/src/core/bonsai/，并接入 coding-agent SDK。
- 当前实现基线的 3 个目标测试文件共 17 项通过；npm run check 通过。
- 同一 Bonsai diff 在 pi 87205484b 上的 17 项目标测试通过，未发现 API 或行为级破坏。
- 新 main 临时 worktree 的全仓 check 因 models.dev 连续 ECONNRESET 无法刷新 gitignored provider catalog；其余检查阶段及 Bonsai 目标测试通过。
- Phase 1 将在 `Exploration-of-Recursive-Working` 合并当前 origin/main 后接受人工验收；通过前不合入 main。

## 13. 变更记录

### 2026-08-18

- 将上游 dotted tool names 映射为 pi transport 可接受的 `spine_open`、`spine_close`、`spine_next`、`spine_trim`、`spine_spawn`；receipt schema 不变。
- 将 `spine_trim` 的 transport schema 收敛为顶层 object；具体操作字段组合仍由 reducer 严格校验。

### 2026-08-17

- 将 Phase 1 收敛为完整 SpineJIT 与 SpineSpawn parity。
- 增加 model、reducer、projection、tools、spawn、integration 的模块职责和单向依赖。
- Node Memory 恢复为上游 string 语义；结构化 schema、supersede 和 evidence refs 下放。
- 保留 pi 原生 compaction 作为 Phase 1 兜底；自研 compactor 下放。
- 删除 Phase 1 的自动 rejoin、crash salvage、execution journal 和 cache identity 拆分。
- 将未来 context 与 node delegation 能力拆到独立 SDD。
- 完成范围与职责审计，状态提升为 Review；仍未授权实现或部署。
- 完成 Phase 1 SpineJIT 与 SpineSpawn 实现、审阅修复及 17 项目标测试。
- 验证 pi 87205484b 兼容性；本地 main 已快进，feature 分支整合仍待提交阶段处理。
