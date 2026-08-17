# SpineJIT close/next memory 源码复核

> 类型：Primary-source research
>
> 上游仓库：`GhabiX/SpineCodex`
>
> 固定版本：`15cfe2d8b00a0338602533ff2c338a16652a06af`
>
> 范围：只复核 `spine.close` / `spine.next` 的 memory 校验、持久化、reducer 和 projection，以及 compact epoch 语义；不以 README 或 benchmark 声明为证据。

## 1. 结论

### 源码事实

SpineCodex 没有把 Node Memory 作为独立可变记录保存。权威事实仍是 native rollout 中的 tool request 和 tool output；每次投影时，adapter 从 rollout 重新组成完整 tool group，确认调用成功，再由 reducer 解析原始 arguments、执行状态转换和组装 memory slots。

`close` / `next` 的模型输入是一个经过 trim 后非空的普通字符串。它有两层校验，但没有结构化内容校验、显式字节上限或质量验证。runtime 会在模型字符串之外，自动保留当前节点中的真实用户消息和已经关闭的 child memories。

compact marker 会结束当前 epoch：所有尚未 Closed 的当前 epoch 节点变为 `Compacted`，cursor 切到以 native replacement history 为 baseline 的新 root epoch。旧 epoch 的 Closed memories 不会被 Spine 自动重新投影；需要继续保留的状态必须已经进入 replacement history。

### 对 Bonsai 的含义

Bonsai 应直接移植“rollout 是权威事实、reducer 决定合法性、runtime 保留用户证据和 child memory、Closed 不 reopen、compact 开新 epoch”这些语义。两处值得明确偏离上游：使用结构化 `MemoryEntry`，以及只有在控制事实持久化成功后才确认 `close` 成功。

## 2. 从 memory 输入到下一轮 projection

```text
model emits spine.close/next(arguments)
  -> handler parses JSON and rejects empty memory
  -> handler checks close/next is not at root
  -> successful tool output is recorded with the original request
  -> native request/output items append to rollout
  -> adapter reconstructs a complete ToolCallGroup
  -> output carrier determines Succeeded/Failed/Unknown
  -> reducer parses and trims arguments again
  -> valid close/next updates tree and assembles MemorySlot[]
  -> closed node renders only preserved user/child slots + summary
  -> adapter materializes provider-native items for next request
```

入口和投影路径：

- Handler 注册的 `CloseArgs` / `NextArgs` 使用 `serde(deny_unknown_fields)`；`close` 要求 `memory`，`next` 同时要求 `goal` 和 `memory`。[`codex-rs/core/src/tools/handlers/spine.rs:84-130`](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/core/src/tools/handlers/spine.rs#L84-L130)
- Handler 完成 arguments 校验后调用 session 状态校验；只有通过才返回 success carrier。[`codex-rs/core/src/tools/handlers/spine.rs:167-217`](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/core/src/tools/handlers/spine.rs#L167-L217)
- `close` / `next` 只能作用于 Task cursor，root 上会返回 `no open Spine node is available to close`。[`codex-rs/core/src/state/session.rs:374-395`](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/core/src/state/session.rs#L374-L395)
- 成功输出带 `success=true` 和固定 carrier；重放时 `success=false` 明确为 Failed，缺少 success 字段时只有 carrier 精确匹配才算 Succeeded。[`codex-rs/core/src/spine/tool_response.rs:30-52`](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/core/src/spine/tool_response.rs#L30-L52) [`codex-rs/core/src/spine/tool_response.rs:83-89`](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/core/src/spine/tool_response.rs#L83-L89)
- Adapter 从相邻 request/output 重新组成 `ToolCallGroup`，把 output 与 `call_id` 对齐并分类 outcome。[`codex-rs/core/src/spine/mod.rs:453-578`](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/core/src/spine/mod.rs#L453-L578) [`codex-rs/core/src/spine/mod.rs:581-632`](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/core/src/spine/mod.rs#L581-L632)
- 普通 Spine 控制调用的 outcome 最终交给 `SpineToolResponse::outcome`；Code Mode carrier 损坏时整组调用被标为 Failed。[`codex-rs/core/src/spine/mod.rs:510-564`](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/core/src/spine/mod.rs#L510-L564) [`codex-rs/core/src/spine/mod.rs:854-870`](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/core/src/spine/mod.rs#L854-L870)

## 3. Memory 输入校验

### 3.1 Handler 层

### 源码事实

Handler 的 `non_empty` 对字符串执行 `trim()`，仅用结果判断是否为空；校验通过后没有把 trim 后的值写回原始 tool arguments。JSON 格式错误、未知字段、缺失字段以及纯空白 memory 都会变成返回给模型的工具错误。[`codex-rs/core/src/tools/handlers/spine.rs:84-130`](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/core/src/tools/handlers/spine.rs#L84-L130)

工具 schema 对 memory 的语义要求很强，要求保留进度、发现、决策、约束、验证、风险、剩余工作及精确证据引用；但参数类型仍只是 JSON string，`strict` 为 false，runtime 不解析这些语义字段。[`codex-rs/core/src/tools/handlers/spine_spec.rs:16-22`](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/core/src/tools/handlers/spine_spec.rs#L16-L22) [`codex-rs/core/src/tools/handlers/spine_spec.rs:67-101`](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/core/src/tools/handlers/spine_spec.rs#L67-L101)

### 3.2 Reducer 层

### 源码事实

Reducer 不信任 Handler 的内存态判断，而是再次从持久化 arguments 反序列化。只有满足以下全部条件的 group 才会产生控制转换：

1. group 已完整收到所有输出；
2. 对应调用 outcome 为 `Succeeded`；
3. arguments 符合 deny-unknown-fields schema；
4. memory trim 后非空；
5. group 中只得到一个合法的 open/close/next 控制。

Reducer 存入 `Control::Close` / `Control::Next` 的是 trim 后字符串。因此 raw rollout 保留模型原始 arguments，派生 tree memory 使用规范化后的字符串。[`codex-rs/spine-core/src/reducer.rs:159-180`](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/spine-core/src/reducer.rs#L159-L180) [`codex-rs/spine-core/src/reducer.rs:466-534`](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/spine-core/src/reducer.rs#L466-L534) [`codex-rs/spine-core/src/reducer.rs:576-579`](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/spine-core/src/reducer.rs#L576-L579)

### 3.3 空、失败和超长 memory

### 源码事实

| 输入或结果 | Handler 行为 | Reducer 重放行为 |
| --- | --- | --- |
| 缺少 memory、错误 JSON、未知字段 | 返回工具错误 | 无合法 control，group 保留为普通历史 |
| `""` 或纯空白 | 返回工具错误 | `non_empty` 返回 None，不改变 tree |
| 工具输出 `success=false` | 调用失败 | outcome 不是 Succeeded，不改变 tree |
| 输出缺失，group 不完整 | 尚不能形成成功事实 | 整组作为普通 `ToolCall` 进入当前 cursor |
| 同组有多个合法 open/close/next | 各调用可能分别通过并返回 success carrier | reducer 拒绝歧义，不执行任何转换，整组保留为普通历史 |
| 超长但非空 memory | 本路径没有显式长度校验 | 完整字符串进入 Summary slot，并在后续 projection 原样展开 |

最后一项是对所列 memory 专用路径的限定性结论：tool schema、Handler 和 reducer 都没有 `maxLength`、字节数或 token 数检查。provider、通用请求层或存储层是否另有整体限制，不在这些文件中确定。

## 4. 持久化模型

### 源码事实

SpineCodex 持久化的不是独立 `CloseEvent` 或 memory 表，而是原生 `ResponseItem::FunctionCall` / `CustomToolCall` 及对应 output。`normalized_tool_request` 在重放时直接读取其中的 `arguments` 和 `call_id`。[`codex-rs/core/src/spine/mod.rs:581-632`](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/core/src/spine/mod.rs#L581-L632)

`record_conversation_items` 的顺序是：

1. 写入 native history；
2. 把同一批 item append 到内存中的 `spine_rollout`；
3. 调用 rollout persistence；
4. 发送 raw items、tree update 和可选 Markdown projection。

见 [`codex-rs/core/src/session/mod.rs:3043-3074`](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/core/src/session/mod.rs#L3043-L3074) 和 [`codex-rs/core/src/session/mod.rs:3372-3379`](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/core/src/session/mod.rs#L3372-L3379)。

但 `persist_rollout_items` 遇到 append 错误只记录 error 日志，不把错误返回给调用者。[`codex-rs/core/src/session/mod.rs:3801-3807`](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/core/src/session/mod.rs#L3801-L3807)

因此，上游可以在内存 tree 已发生转换、模型也将看到 success carrier 的情况下，没有得到严格的 durable commit 保证。重启后能否重建该转换取决于相应 request/output 是否实际写入 rollout。

## 5. Reducer 的 close / next 语义

### 5.1 close

### 源码事实

`close`：

- 读取当前 cursor 对应 Task；
- 用当前 group 的 `start..end` 作为 Summary 来源 span；
- 调用 `assemble_memory`；
- 把节点设为 `Closed`；
- 把 node `end` 设为 `group.start`；
- 把父节点设回 `Live`；
- 把整个 close tool group 追加到父节点；
- cursor 返回父节点。

这表达了“转换作用于本次 sampling 之前的当前节点历史；close 调用及其同批普通工具属于转换后的 parent”。[`codex-rs/spine-core/src/reducer.rs:209-233`](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/spine-core/src/reducer.rs#L209-L233)

### 5.2 next

### 源码事实

`next` 先执行相同的关闭和 memory 组装，再在同一 parent 下创建新 sibling。`next` tool group 成为 sibling 的第一个 entry，cursor 移入 sibling。[`codex-rs/spine-core/src/reducer.rs:235-276`](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/spine-core/src/reducer.rs#L235-L276)

### 5.3 自动保留的 memory

### 源码事实

`assemble_memory` 按当前节点 `entries` 的原始顺序扫描：

1. 对直接属于当前节点、role 为真实 `User` 且有 anchor 的 message，生成 `MemorySlot::User`；
2. 遇到 child entry，复制该 child 的全部 memory slots；
3. 最后追加当前节点的 `MemorySlot::Summary`，body 是模型提供的 memory。

[`codex-rs/spine-core/src/reducer.rs:372-405`](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/spine-core/src/reducer.rs#L372-L405)

具体边界：

- `MessageRole::User` 才获得稳定 anchor；host 生成的 `ContextualUser`、assistant、developer 和 system message 不会成为 User slot。[`codex-rs/spine-core/src/model.rs:45-63`](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/spine-core/src/model.rs#L45-L63) [`codex-rs/spine-core/src/reducer.rs:147-157`](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/spine-core/src/reducer.rs#L147-L157)
- child memory 被完整复制，不只是 child 的模型摘要；其中可能包含 descendant user slots、descendant summaries 和 spawn evidence。[`codex-rs/spine-core/src/model.rs:460-480`](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/spine-core/src/model.rs#L460-L480)
- runtime 不解析 memory 文本中的 `[U#]` 来选择用户证据。真实 User slots 根据 tree entries 自动保留，文本引用只是给模型使用的语义指针。
- assistant 推理、普通工具详情和 developer/contextual-user 内容不会自动进入 closed memory；如果 continuation 仍需要这些事实，模型 Summary 必须显式记录结果或可恢复引用。

## 6. 最终 projection

### 源码事实

Reducer 渲染规则：

- `Closed`：只展开 `node.memory` 中的每个 slot；
- `Live` / `Opened`：输出 synthetic node marker，再递归输出详细 entries；
- `Compacted`：不输出。

[`codex-rs/spine-core/src/reducer.rs:407-447`](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/spine-core/src/reducer.rs#L407-L447)

Adapter materialization 时：

- User slot 从原 rollout boundary 重新取得原始 user item，并添加 `[U#]` anchor；
- Summary slot 转为 user-role 的 contextual fragment：`<spine_memory node_id="...">...`；
- SpawnEvidence 转为独立的 `<spine_spawn_evidence>` contextual fragment。

[`codex-rs/core/src/spine/mod.rs:936-1046`](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/core/src/spine/mod.rs#L936-L1046)

closed node 的详细工作历史仍保留在 native rollout，只是不进入下一轮 provider context。

## 7. Compact marker 与 epoch

### 源码事实

Adapter 遇到 `RolloutItem::Compacted` 时：

- 若 marker 带 `replacement_history`，每个 replacement item 成为新 baseline 的 `Native` 引用；
- 否则使用 compacted message 构造一个 assistant message；
- 产生带原始 boundary 的 `RolloutEvent::Compact`。

[`codex-rs/core/src/spine/mod.rs:411-440`](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/core/src/spine/mod.rs#L411-L440)

Reducer 应用 compact 时：

1. 找到当前最后一个 root epoch；
2. 把该 epoch 中所有非 `Closed` 节点设为 `Compacted`，并补齐 end boundary；
3. 保留旧节点快照，Closed 节点状态不变；
4. 创建下一个 `RootEpoch`，状态为 `Live`；
5. 把 replacement history 安装为新 root baseline；
6. cursor 重置到新 root。

[`codex-rs/spine-core/src/reducer.rs:338-370`](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/spine-core/src/reducer.rs#L338-L370)

`render_current_epoch` 只从最后一个 root epoch 的 baseline 和 entries 生成 context。[`codex-rs/spine-core/src/reducer.rs:407-416`](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/spine-core/src/reducer.rs#L407-L416)

所以 compact 不是“在旧 Spine tree 上继续渲染”。它建立新的 projection baseline，旧 epoch 的 user slots、closed summaries 和工作详情都不会由 reducer 自动重新注入。Bonsai compactor 必须把需要跨 epoch 延续的用户约束、未完成工作、验证状态和 evidence refs 写入 replacement/continuation bundle。

## 8. Bonsai 取舍

### 8.1 可直接移植

| 机制 | 建议 | 理由 |
| --- | --- | --- |
| native rollout 为权威事实 | 直接移植 | tree 和 projection 可由同一事实重放，无双写权威状态 |
| Handler admission + reducer replay validation | 直接移植 | 前者给模型及时反馈，后者抵抗恢复、损坏和历史版本输入 |
| 只有完整、成功、唯一控制才改变 tree | 直接移植 | 非法事件仍可审计，但不污染状态机 |
| close/next 的 sampling-boundary ownership | 直接移植 | 能确定同批普通工具属于 parent 还是 sibling，避免含糊上下文归属 |
| runtime 自动保留真实 user evidence | 直接移植 | 用户约束不能依赖模型摘要是否记得 |
| runtime 递归保留 Closed child memories | 直接移植 | parent 不需要重新总结已经稳定的 child continuation state |
| Closed 不 reopen | 直接移植 | 修正用 append-only supersede，保持重放单调和来源可解释 |
| compact 创建新 epoch | 直接移植 | 将底层窗口替换与 task close 分开，避免长期 live/root 无限增长 |

### 8.2 收益已经明确，值得偏离上游

1. **结构化 `MemoryEntry`**：上游 opaque string 只能做空值检查。Bonsai 需要对结论、决策、验证、未解决风险、artifact/evidence refs 和下一步做 schema 校验及大小预算。保留可读 body 可以作为渲染层，不应成为唯一事实结构。
2. **持久化成功后再确认控制成功**：上游吞掉 rollout append 错误，不满足 Bonsai SDD 的 durable control contract。建议顺序是 `validate -> append canonical fact -> durable flush/commit -> expose success -> derive projection`。
3. **显式 compact continuation schema**：由于新 epoch 不自动继承旧 closed memories，replacement bundle 必须有强制字段和来源引用，不能只依赖自由文本摘要。

### 8.3 只有收益被测量后才偏离

1. **Memory 硬上限**：先记录投影 token/byte 压力和任务质量。过早截断可能破坏 continuation；若增加上限，应返回可恢复错误或使用 evidence/artifact 引用，而不是静默截断。
2. **同一 Spine epoch 内选择性丢弃或去重用户原文**：Spine projection 默认保留该 epoch 的全部真实 user messages。native compaction 跨 epoch 时使用 SDD 已确认的有界 verbatim user bundle；未注入新 epoch 的原文仍保留在 append-only rollout 并通过稳定 refs 追溯。
3. **额外的派生 tree/memory 数据库**：先从 rollout 重放。只有启动时间或查询性能形成可测瓶颈时，再加可删除、可重建的索引。
4. **增量 reducer/context patch**：先实现纯函数式全量 replay，建立确定性基线；只有 profiling 证明 replay 成本明显时再引入增量缓存。
5. **第二次模型调用审核 memory**：它增加延迟、成本和新的失败点。先用 schema、引用校验和验收测试；只有实测 memory 质量仍是主要失败源时再考虑。
6. **reopen**：目前没有明确收益足以覆盖 memory 失效、descendant 状态、cache prefix 和重放语义复杂度；继续使用 supersede。

## 9. 未知与验证边界

### 未知

- provider 或通用 tool-call/request 层对 memory arguments 的实际最大长度；memory 专用路径没有给出答案。
- 模型是否稳定遵守 Node Memory 描述中的证据和 continuation 要求；源码只验证非空。
- rollout append 已返回但尚未 durable flush 时，底层存储面对进程崩溃的精确保证。
- native compactor 如何选择 replacement history；本文件只确认 Spine 如何消费 compact marker。
- 结构化 memory 的最佳字段上限和 evidence reference 粒度，需要 Bonsai 自己的任务回放与质量评估。

### 本轮验证边界

- 所有结论来自固定 commit 的实现源码，不依赖 README 宣传。
- 当前环境没有 `cargo`，未运行 SpineCodex Rust 测试；这是静态源码复核，不是动态通过声明。
- 未修改或运行 Bonsai 功能代码。
