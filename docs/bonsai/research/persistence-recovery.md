# 控制事实持久化与恢复边界

> 状态：Phase 1 架构研究，不是实施授权。
>
> 范围：Spine control group、pi session JSONL、durable success、crash recovery 与 supersede；不讨论外部系统事务实现。

## 1. 源码事实

### 1.1 SpineCodex

- 权威输入是 native rollout 中完整的 tool request/output group；Task Tree 每次由 reducer 重放得到。
- 只有完整、成功且结构控制唯一的 group 才改变树。失败、不完整、冲突或 malformed control 都是 tree no-op。
- 上游会先更新内存 rollout，再调用 persistence；append 错误只记日志，仍可能让模型看到 success carrier。
- 上游没有 `supersede` transition；Closed node 不 reopen。

### 1.2 pi

- `SessionManager` 把 message、compaction、custom 等 entry 保存在同一 parent-linked JSONL session tree。
- `CustomEntry` 只用于 extension state，不进入模型上下文；它不是 Spine control 的必要权威层。
- `_appendEntry` 先更新内存中的 entries/byId/leaf，再调用 `_persist`。
- 没有 assistant entry 时，初始 entries 可能保持未 flush，直到后续条件满足才创建并重写 session file。
- 已创建文件后的追加使用 `appendFileSync`，重写使用 `writeFileSync`，但没有显式 `fsync` durable barrier。
- 写入错误会从同步 fs API 抛出，但内存 entry 已先加入，没有 rollback。
- 新 `AgentHarness` session schema 已定义 `OperationStartedRecord` 与 `ToolStartedRecord`。其中 `ToolStartedRecord` 持久化 `runId`、`assistantEntryId`、`toolIndex`、`toolCallId`、`toolName`、`effectiveArgs`、预留 `resultEntryId` 和 `replay: never | safe`，已经覆盖 Bonsai 所需的执行前 identity、参数和 replay policy 语义。
- 当前 `AgentHarness.create()` 仍拒绝恢复已有 records，`prompt()`、`compact()`、`resume()`、`abort()` 等执行方法也仍返回 `HarnessNotImplemented`。Phase 1 不能把它作为 coding-agent 的执行宿主。

## 2. Bonsai 直接采用与加强

以下属于 correctness，不形成产品选择题：

1. 完整 assistant/tool-result group 仍是权威控制事实；不额外建立第二份可变 Task Tree 数据库。
2. reducer 只接受完整、成功、唯一的 Spine control。物理尾部缺失、失败 receipt 或冲突 control 不改变 tree。
3. accepted control 必须带稳定 source entry refs；Task Tree、projection 和可选索引都能从 session log 重建。
4. control success 顺序固定为 `validate complete group -> append final canonical receipt -> durable flush -> expose success -> derive/replay tree`。
5. durable flush 失败时不得向模型返回 control success；内存派生状态必须回到 durable prefix。
6. incomplete group 保留为 trace/provenance，但不进入当前 Task Tree 投影。
7. `CustomEntry` 可承载可重建诊断或 cache metadata，不能成为唯一控制事实。

具体 durable store API、group framing、checksum 和 fsync 策略属于实施设计，但验收必须包含进程在每个 append 边界崩溃的 fault-injection trace。

## 3. 不可事务化外部副作用

同一 tool group 可以同时包含普通工具和 Spine control。文件写入、数据库调用或外部 API 可能已经成功，但最终 receipt 尚未 durable commit。重启后 tree 必须按 durable log 判断 control 未发生，却不能据此推断外部副作用也未发生。

因此恢复状态至少需要区分：

```text
committed
not_committed
indeterminate_external_effect
```

### 已确认契约

- crash 落在“外部副作用可能已完成、最终 receipt 未 durable commit”之间时，状态为 `indeterminate_external_effect`，禁止自动重执行。
- SpineJIT 已有的失败语义直接复用：显式失败输出归类为 `Failed`，reducer 只接受 `Succeeded` control；失败、不完整或歧义 group 对 Task Tree 是 no-op，但原始记录仍可审计。
- 在 pi 中，若 durable log 中存在匹配的 tool call，恢复结果必须写成 `ToolResultMessage`，设置 `isError: true`，并在模型可见内容中携带稳定的 `code: indeterminate_external_effect` 与 `retryable: false`。不能只在 UI 或 `details` 中标错，因为 provider 不一定传递独立错误位。
- 若不存在可合法配对的 durable tool call，不得伪造孤立 tool result；session 直接进入 recovery/read-only 状态。
- runtime 必须先验证外部实际状态。若 verifier 证明副作用已经完成，则追加恢复事实并在不重执行的情况下继续；只有证明副作用未发生，或该 operation 具有可验证的幂等键时，才允许重新执行；无法验证时请求用户处理。
- 为使 crash 后能够识别该窗口，工具在执行前必须 durable 写入与 pi `ToolStartedRecord` 兼容的 started record，并预留稳定 result identity。默认 `replay: never`；只有工具声明和当前注册都确认可安全重放时才允许 `replay: safe`。该记录是恢复元数据，不是第二份 Task Tree 权威来源。

Phase 1 在现有 coding-agent session host 内增加 adapter，复用上述字段、identity matching 和 replay policy，不另造 Bonsai 专用 operation-intent 协议。未来 `AgentHarness` 执行与恢复链路完成后，可以替换 adapter，但不能改变持久语义。

外部 verifier 采用注册式接口：

```text
verify(startedRecord) -> completed | not_started | unknown
```

- `completed`：追加匹配的恢复 result，不重新执行。
- `not_started`：只有 `replay: safe` 或存在可验证幂等键时才允许重新执行。
- `unknown`：返回 `indeterminate_external_effect`，`retryable: false`。

Phase 1 不要求所有工具提供 verifier。没有 verifier 或 verifier 失败等价于 `unknown`。

`indeterminate_external_effect` 是 tool execution error，不自动等同于 task outcome。node 只有在后续合法 `close/next` 中显式提交 `failed` 或 `partial`，才改变 outcome。

## 4. Supersede 边界

append-only supersede 的目的是修正后续 projection，不是改写历史。它可以替换 projected `TaskStateCore` semantic facts、outcome、artifact/evidence refs 和 rationale。它不能修改原始 tool receipt、NodeId、parent/child topology、cursor 历史或 `Closed` 已发生这一事实，也不能 reopen node。

## 5. Torn/corrupt tail 恢复

session JSONL 出现 torn/corrupt tail 时：

1. 恢复最长合法 durable prefix。
2. 隔离损坏 tail，不得静默跳过坏 entry 后继续 replay。
3. session 进入明确的 recovery/read-only 状态；用户和 trace 必须能看到损坏位置与当前有效 prefix。
4. 修复或从有效 prefix 派生新分支之前，不允许继续追加正常执行事实。

Phase 1 不做原文件内修复。recovery 退出只允许两种方式：验证并接受隔离 tail 后，从最长合法 durable prefix 创建新 branch；或明确放弃该 session。隔离记录至少保存 session identity、首个非法 byte/entry 位置、原 tail hash、有效 prefix identity 和诊断。原损坏文件保持只读，防止修复过程改写证据。

具体存储路径和 UI 呈现属于实施细节，不改变上述恢复 interface。
