# Node Memory 与 Continuation Schema 对比

> 状态：Phase 1 架构研究，不是实施授权。
>
> 目标：确定哪些状态属于可持久、可重放的任务事实，哪些状态只应在新 epoch 启动时由 runtime 重建。

## 1. 源码基线

本轮沿用 compaction harness 对比的固定版本：

- pi `096b022b15c0dd40734393eaccd06505d84a745f`
- SpineCodex `15cfe2d8b00a0338602533ff2c338a16652a06af`
- Fermi `1d0d4171a6bf9648d2395a5b50a81318a90db298`
- Grok Build `9fabadea800fa6e2ed8ec91c4f45f02b7e2504f4`
- Raven `059e1c1ee30b5273f59ec832771b49e47330a2fe`

结论来自静态源码阅读，没有运行外部项目测试。

## 2. 各实现实际保存什么

| 实现 | 模型生成内容 | runtime 补充内容 | 主要缺口 |
|---|---|---|---|
| SpineCodex | opaque Node Memory string | 真实 user messages、Closed child memories | 无结构化字段、来源和大小契约 |
| pi | Goal、Constraints、Progress、Blocked、Decisions、Next Steps、Critical Context | read/modified files；entry 中保留 cut point、token 与 extension details | Markdown 是主要事实载体；缺少 typed evidence 与 lineage |
| Fermi | 用户意图、发现、进度、决策、artifact 和下一步的 continuation prompt | system prompt、AGENTS.md、plan snapshot 重新注入 | continuation 仍是自然语言；没有强 schema |
| Grok Build | full-replace summary | last real user query、edited paths、running tasks/subagents、MCP servers、todos、project instructions、transcript path | 稳定任务事实与瞬时 harness 状态混在同一 model-facing reminder |
| Raven | Curator working-state 文本 | goals 最多 8、open threads 最多 12、decisions 最多 20；message-id selection 与 archive refs | working state 仍是字符串数组；部分 plan 字段未被 assembler 消费 |

## 3. 可直接采用的 schema 原则

以下属于 correctness，不需要产品取舍：

1. 持久结构必须有 `schemaVersion`，旧 rollout 的 decoder 与迁移行为必须显式。
2. 结构化事实与 model-facing rendering 分离；可读文本不是唯一权威事实。
3. 每个可丢失语义的事实都能携带稳定 `sourceRefs`，至少可定位 rollout entry、tool receipt、artifact 或 verification receipt。
4. 用户约束同时保留 verbatim source 与 normalized view；原文是权威证据，normalized view 用于选择和渲染。
5. artifact、verification 和大工具结果默认只进入短事实与稳定引用，不把原始内容复制进 continuation。
6. provider/tool-call 合法性、权限和 active handle 有效性由 runtime 校验，不能依赖模型文本声明。

## 4. 已确认分层

Node Memory 与 Continuation 共享 versioned `TaskStateCore`，并分别增加自己的 envelope。stable task facts 与 runtime resume snapshot 分层处理。

### 4.1 Stable task facts

由 Node Memory 与 compact continuation 共享：

```text
objective
constraints[]
decisions[]
progress.done[]
progress.active[]
blockers[]
openItems[]
nextActions[]
artifactRefs[]
verificationRefs[]
userMessageRefs[]
```

每项可以携带 `sourceRefs`、简短 rationale 和状态，不保存无界 transcript。

### 4.2 Envelope-specific facts

Node Memory 额外需要：

```text
nodeId
outcome
closedAt
childMemoryRefs[]
```

Continuation 额外需要：

```text
fromEpoch
continuesFrom
createdAt
verbatimUserBundle[]
semanticIntent
```

### 4.3 Runtime resume snapshot

只在新 epoch materialize 时注入，不作为稳定 Task Memory：

```text
activeOperations[]
currentPermissions
currentModel
availableToolProfiles
workspaceInstructionRefs[]
```

MCP catalog、skill listing 和完整 tool definitions 可以从当前 runtime 重建，不应复制进 durable continuation。

## 5. 第四组已确认契约

1. Node Memory 与 Continuation 共享 versioned `TaskStateCore`。Node Memory envelope 增加 node/outcome/child memory 字段；Continuation envelope 增加 epoch lineage、verbatim user bundle 和 semantic intent。
2. stable task facts durable 持久化；runtime resume snapshot 单独生成和渲染。当前 runtime 配置仍是模型、权限、工具和 profile 的权威来源，不把完整 MCP catalog、skill listing 或 tool definitions 复制进 Task Memory。
3. 只有具备 runtime-owned handle，并支持 validate、poll/resume 和 cancel 契约的 active operation 可以跨 epoch。普通未完成 tool call 不能跨越；compaction 必须等待合法边界。
4. bundle 同时使用总预算与类别预算。用户约束、active work、blockers 和 verification facts 优先；可选 narrative 溢出到 refs；受保护事实本身仍无法满足 target headroom 时返回可恢复错误，不静默截断。

## 6. TaskStateCore 字段归一化

### 可直接确定

- 模型只提出 semantic content 与可选 rationale；runtime 分配稳定 ID、source refs、时间和合法状态转换。
- schema 拒绝未知字段。集合可以为空，但不得要求模型编造不存在的事实。
- 非法、缺少受保护事实或仍无法满足大小 guard 的 payload 返回 tool-result error，不产生 close/next 或 compact transition。
- Bonsai payload 自带 `schemaVersion`。decoder 必须显式处理旧版本；不能依赖 pi 当前将旧 session 在内存迁移后整体重写的行为，因为 Bonsai 已选择 append-only rollout 作为权威事实。

### 第六组已确认契约

用户授权后续默认采用推荐方案；只有实现成本明显失衡时才允许选择更简单的 interface，并必须记录偏离原因。第六组全部采用推荐方案：

1. `TaskStateCore` 只有一个 primary objective。子目标进入 `workItems` 或 Task Tree child，不维护并列 objective 数组。
2. progress、blocker、open item 与 next action 统一为有序 `workItems[]`。每项至少包含稳定 `factId`、`revision`、`kind: task | question`、`state: queued | active | blocked | done | cancelled`、semantic content 与 `sourceRefs`。
3. constraints、decisions 和 work items 都是可单独 supersede 的 facts。supersede 指定 `factId` 与预期 revision，产生同一 logical fact 的下一 revision；旧 revision 保留在 rollout。revision 不匹配属于 stale conflict，返回 error 且不改变 projection。
4. runtime 分配 `factId`、revision、source refs、时间与 canonical order。模型不能自行声明 identity 或绕过合法状态转换。
5. schema migration 使用非破坏性 decode chain：保留原始 versioned payload，在读取时生成当前 view，不原地重写历史事实。无法理解的未来版本进入 recovery/read-only。

收敛后的逻辑形状：

```text
TaskStateCore
  schemaVersion
  objective: TaskFact
  constraints: ConstraintFact[]
  decisions: DecisionFact[]
  workItems: WorkItem[]
  artifactRefs: ArtifactRef[]
  verificationRefs: VerificationRef[]
  userMessageRefs: UserMessageRef[]

VersionedFact
  factId
  revision
  content
  sourceRefs[]
  rationale?
```

具体字段使用 bounded text 或 typed reference；不允许无界 transcript、provider-native message 或完整工具输出进入 core。
