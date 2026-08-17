# SpineJIT reducer 与 epoch 语义研究

> 研究对象：[`GhabiX/SpineCodex`](https://github.com/GhabiX/SpineCodex/tree/15cfe2d8b00a0338602533ff2c338a16652a06af)，固定提交 `15cfe2d8b00a0338602533ff2c338a16652a06af`
> 本地证据副本：`/private/tmp/spinecodex-research-20260817`
> 研究方式：静态源码分析。当前环境没有 `cargo`，本文不声称 Rust 测试或运行时验证已经通过。

## 1. 结论

SpineJIT 值得 Bonsai 采用的核心不是某个 prompt 技巧，而是一套可重放的树状态机：持久化消息流是事实源，`SpineReducer` 按顺序重放消息和完整 tool group，恢复节点、父子关系、cursor、状态与 epoch；投影层再从该状态生成下一轮模型上下文。

Bonsai 可以直接采用这套 reducer 骨架，但不应照搬它对“任务完成”的表达。两者应遵守以下契约：

```text
lifecycle = Open | Closed
outcome   = succeeded | partial | failed | cancelled | null

Closed 只表示“不再执行”，不蕴含 succeeded。
```

这不是兼容性装饰。若把 `Closed` 等同于成功，失败分支、部分交付和取消任务都会被压成同一种状态，随后 compact、恢复和评估都无法可靠地区分它们。

## 2. 证据边界

本文只把固定提交中的 Rust 实现视为 SpineCodex 事实源，不采用 README 的性能或产品宣称。

- reducer 数据模型与节点状态：[`model.rs:14-43`](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/spine-core/src/model.rs#L14-L43)、[`model.rs:410-458`](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/spine-core/src/model.rs#L410-L458)
- tool outcome 与 spawn receipt 类型：[`model.rs:509-532`](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/spine-core/src/model.rs#L509-L532)
- 初始状态、消息重放和上下文投影：[`reducer.rs:69-180`](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/spine-core/src/reducer.rs#L69-L180)
- `open` / `close` / `next` / `spawn` / `compact`：[`reducer.rs:183-370`](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/spine-core/src/reducer.rs#L183-L370)
- 节点渲染：[`reducer.rs:407-447`](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/spine-core/src/reducer.rs#L407-L447)
- 控制调用分类：[`reducer.rs:466-579`](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/spine-core/src/reducer.rs#L466-L579)
- tool group 构造与 materialization：[`spine/mod.rs:453-578`](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/core/src/spine/mod.rs#L453-L578)、[`spine/mod.rs:936-1046`](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/core/src/spine/mod.rs#L936-L1046)
- compact marker 识别：[`spine/mod.rs:411-440`](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/core/src/spine/mod.rs#L411-L440)

下文的“源码事实”均限于该提交；“Bonsai 建议”是设计判断，不代表 SpineCodex 已实现。

## 3. 源码事实：结构与不变量

### 3.1 节点模型

`NodeKind` 只有两类：`RootEpoch` 与 `Task`；`NodeStatus` 有 `Live`、`Opened`、`Closed`、`Compacted` 四种。`NodeId` 是结构化地址，由 epoch 与逐级 child ordinal 构成，而不是随机 ID。[`model.rs:14-43`](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/spine-core/src/model.rs#L14-L43)

固定提交体现出以下不变量：

1. 初始状态只有一个 `Live` 的 root epoch，cursor 指向该 root。
2. root 没有 parent；每个 task 恰有一个 parent。
3. 新 child 的 ordinal 取 parent 当前 children 长度，因此同一 parent 下的 ID 只追加、不重排。
4. cursor 指向当前 epoch 中唯一接受普通消息的活动 root 或 task。
5. `Closed` 节点不会被 `open`、`next` 或 `compact` 改回活动状态。
6. compact 会创建新 root epoch，而不是原地改写当前 root。

前三项来自模型和 child 创建逻辑；cursor 与 epoch 行为来自初始状态及各 transition。[`reducer.rs:69-145`](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/spine-core/src/reducer.rs#L69-L145)

### 3.2 状态转换

| 输入 | 有效前提 | 节点变化 | cursor 变化 | 完整 tool group 归属 |
|---|---|---|---|---|
| `spine.open` | 当前 cursor 可打开 child，且本组只有一个有效结构控制 | 当前节点 `Opened`；追加一个 `Live` child | 进入新 child | 新 child |
| `spine.close` | cursor 是可关闭的 task，且本组只有一个有效结构控制 | 当前 task `Closed`；parent `Live` | 返回 parent | parent |
| `spine.next` | cursor 是可结束的 task，且本组只有一个有效结构控制 | 当前 task `Closed`；parent `Opened`；追加一个 `Live` sibling | 进入新 sibling | 新 sibling |
| `spine.spawn` | receipt 有效，且未与结构控制混用 | 导入 receipt 中按序排列的 `Closed` children | 不变 | 当前节点 |
| compact marker | marker 有效 | 当前 epoch 的非 `Closed` 节点变成 `Compacted`；建立新 `Live` root | 新 root | 新 epoch baseline |

`open`、`close` 和 `next` 的精确写入顺序见 [`reducer.rs:183-276`](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/spine-core/src/reducer.rs#L183-L276)；spawn child 导入见 [`reducer.rs:278-336`](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/spine-core/src/reducer.rs#L278-L336)；compact 见 [`reducer.rs:338-370`](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/spine-core/src/reducer.rs#L338-L370)。

这里的“归属”不是仅移动控制调用本身。一个完整 tool group 中可以同时有普通工具调用；只要恰好有一个有效的 `open`、`close` 或 `next`，整个 group 都随该 transition 写入目标节点。

### 3.3 控制组判定与失败语义

reducer 先把 assistant tool calls 与对应 results 组成完整 group，再分类控制调用。决定结构转换的是成功、可解析且满足当前结构前提的控制，不是仅凭 tool name。[`spine/mod.rs:453-578`](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/core/src/spine/mod.rs#L453-L578)

其保守规则是：

- 恰好一个有效 `open` / `close` / `next`：执行相应 transition。
- 零个有效结构控制：不做结构 transition，group 留在当前 cursor。
- 多个成功结构控制：视为歧义，不做 transition。
- 失败、未知、不完整、参数畸形或不满足当前节点前提的控制：只保留为普通 tool history。
- 普通工具调用可与唯一有效结构控制共存，整个 group 按控制的归属规则移动。
- spawn 与 `open` / `close` / `next` 混用时，不导入 spawn children。

这些规则集中在 [`reducer.rs:466-579`](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/spine-core/src/reducer.rs#L466-L579)。它们的价值是让畸形模型输出退化为可审计历史，而不是让树进入部分更新状态。

## 4. 源码事实：compact 与 epoch

compact 不是“把当前节点的 detail 替换成 memory”。它是全局的 epoch 边界：

1. reducer 识别 compact marker 及其 replacement baseline。
2. 当前 epoch 中所有非 `Closed` 节点标记为 `Compacted`；已经 `Closed` 的节点保持 `Closed`。
3. 新建下一个 `RootEpoch`，把 replacement baseline 写入新 root。
4. cursor 重置到新 root。
5. 旧 epoch 节点仍保留在 reducer snapshot 中，但下一轮投影只渲染最新 root epoch。

marker 识别和状态转换分别见 [`spine/mod.rs:411-440`](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/core/src/spine/mod.rs#L411-L440) 与 [`reducer.rs:338-370`](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/spine-core/src/reducer.rs#L338-L370)。只投影最新 root 的行为见 [`reducer.rs:113-145`](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/spine-core/src/reducer.rs#L113-L145)。

因此，epoch 同时解决两个问题：为 native compaction 之后的上下文提供清晰起点，并避免旧活动路径在 replacement history 上继续接受消息。它没有删除旧状态，审计快照与模型可见上下文是两个不同层次。

## 5. 源码事实：task lifecycle 不等于 outcome

手工创建的 `Task` 节点没有任务结果字段。`NodeStatus::Closed` 只记录结构生命周期已经结束；`ToolOutcome` 记录的是某次控制或工具调用成功与否，也不是任务结果。[`model.rs:410-458`](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/spine-core/src/model.rs#L410-L458)

`SpawnOutcome` 只存在于 spawned branch 的证据与 receipt 中，不能为普通 `open` / `close` task 提供统一 outcome。[`model.rs:509-532`](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/spine-core/src/model.rs#L509-L532)

在该固定提交中未找到 `reopen` 或 `supersede` transition。于是可确认的边界是：

- `Closed` 不代表成功，只代表该节点不再执行。
- task 的成功、部分完成、失败或取消无法从 `NodeStatus` 无损推出。
- 一个 closed task 可以保留 memory，但 memory 的存在也不证明目标已经成功完成。

## 6. 对 Bonsai 的设计判断

### 6.1 直接采用

以下机制应作为 Bonsai reducer 的基础约束：

| 机制 | 采用原因 | 最低验收条件 |
|---|---|---|
| 持久事件流 + 确定性 replay | 恢复、审计和投影共享同一事实源 | 同一事件序列多次 replay 得到相同 snapshot |
| 结构化 NodeId | parent/child 关系可检查，child 顺序稳定 | ID 由 epoch 与 append-only ordinal 组成 |
| 单 cursor 与 parent 不变量 | 消除“消息究竟属于哪个任务”的歧义 | 每次 append 前后均可校验 cursor |
| 完整 control group 原子归属 | 普通调用和控制调用不会被拆到不同节点 | 每个 group 只能整体归属于一个节点 |
| 无效或歧义控制 no-op | 模型畸形输出不会部分修改树 | 状态不变，但原始 group 仍可审计 |
| `Closed` 不可变 | 保持历史与 memory 语义稳定 | 不提供隐式 reopen transition |
| native compact 创建新 epoch | replacement history 不污染旧活动路径 | compact 后 cursor 只指向新 root |

这里的 no-op 指“不改变树结构”，不是丢弃记录。

### 6.2 明确有收益的偏离

**独立 outcome。** Bonsai 应把 task lifecycle 与交付结果拆成正交字段：

```text
status:  open | closed
outcome: null | succeeded | partial | failed | cancelled
```

推荐约束：`open` 时 outcome 必须为 `null`；`close` 时必须显式提交 outcome；所有终态都允许 memory 和 evidence。这样失败分支仍能贡献可复用事实，评估器也无需从自由文本猜结果。

**结构化 compact continuation。** SpineCodex 接受 replacement baseline 并建立新 epoch；Bonsai 应进一步把 continuation 分成机器可读的最小状态和模型可读摘要。至少保留 objective、未决约束、关键 evidence 引用、已关闭任务摘要与当前 continuation intent。这样既继承 epoch 隔离，又能验证 compact 是否丢失必要状态。

这两项偏离直接服务于 Bonsai 已确认的契约，不需要先证明性能收益。

### 6.3 只在测量后采用

以下设计可能有价值，但当前没有证据支持提前增加复杂度：

| 候选设计 | 先测什么 | 采用门槛 |
|---|---|---|
| 增量 reducer 或 snapshot index | 长会话完整 replay 的 p50/p95 延迟与内存 | replay 已成为可观测瓶颈 |
| 提前删除旧 epoch | snapshot 存储增长、审计和恢复需求 | 保留旧 epoch 的成本高于可追溯价值 |
| 自动推断 outcome | 与人工标注对比的错误率，尤其 `partial` / `failed` | 不会把失败误报为成功，并保留人工覆盖 |
| `reopen` | 实际需要恢复 closed task 的频率 | 新 task + lineage 无法表达真实工作流 |
| 跨 epoch 自动回注 memory | 回注命中率、token 成本和错误上下文率 | 明显优于显式 evidence 引用 |

默认方案应保持简单：完整 replay、保留旧 epoch、显式 outcome、closed task 不 reopen、按 continuation 明确引用旧证据。

## 7. 建议的 Bonsai reducer 契约

```text
reduce(events) -> snapshot

snapshot:
  epochs: ordered<Epoch>
  active_epoch: EpochId
  cursor: NodeId

task:
  id: epoch + child ordinals
  parent: NodeId
  status: open | closed
  outcome: null | succeeded | partial | failed | cancelled
  memory: optional structured payload
  evidence: ordered references

rules:
  - event order is authoritative
  - each complete group is applied atomically
  - exactly one valid structural control may transition the tree
  - invalid or ambiguous control preserves history but does not mutate structure
  - closed nodes never become open
  - compact closes the old execution surface and creates a new epoch root
  - projection reads only the active epoch unless continuation explicitly references old evidence
```

这里把 SpineCodex 的 `Live` / `Opened` 收敛为 Bonsai 外部契约里的 `open`，不要求内部实现丢失二者的区别。内部如果需要区分“当前叶子”和“有活动 child 的祖先”，可以保留派生 phase；但它不应与 task outcome 混在同一字段。

## 8. 必须验证的行为

实现前应把以下 trace 固化为 reducer tests：

1. `open -> ordinary tool -> close`：tool group 分别进入 child、child、parent，cursor 最终回到 parent。
2. `open -> next`：原 task 为 `closed`，新 sibling 为 `open`，parent 保持活动祖先语义。
3. 一个 group 含普通调用和一个有效控制：整个 group 只有一个 owner。
4. 一个 group 含两个成功结构控制：树 snapshot 不变，原始 group 仍存在。
5. failed / incomplete / malformed control：不改变 cursor 或节点状态。
6. spawn receipt：cursor 不变，只导入有序 closed children；与结构控制混用时不导入。
7. compact：旧 open 节点不再可写，新 root 接受后续消息，projection 不渲染旧 epoch。
8. `close(outcome=failed)`：节点 closed 且 outcome failed，不能被投影或评估误判为成功。
9. replay determinism：冷启动全量 replay 与连续在线 reduce 的 snapshot 完全一致。

## 9. 未知项

这些问题不能从固定提交的静态分析中回答，需要 Bonsai 原型或运行数据：

- 实际模型输出中，多控制、缺 result 或 malformed group 的发生率是多少。
- 全量 replay 在 Bonsai 目标会话长度下何时成为瓶颈。
- structured compact continuation 的最小必需字段集合是什么。
- spawn branch 的 `partial` 与 parent task 的聚合 outcome 应采用何种确定规则。
- 是否存在必须恢复原 closed task 身份、而不能新建 successor task 的真实工作流。
- 只投影 active epoch 时，跨 epoch evidence 丢失率与显式引用成本分别是多少。

在这些数据出现前，不应引入自动 outcome 推断、reopen、旧 epoch 删除或隐式跨 epoch memory 回注。
