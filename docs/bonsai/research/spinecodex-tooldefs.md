# SpineCodex SpineJIT / SpineSpawn ToolDef 源码调研

> 类型：Primary-source research
>
> 上游仓库：[`GhabiX/SpineCodex`](https://github.com/GhabiX/SpineCodex)
>
> 上游固定版本：[`15cfe2d8b00a0338602533ff2c338a16652a06af`](https://github.com/GhabiX/SpineCodex/tree/15cfe2d8b00a0338602533ff2c338a16652a06af)，即 2026-08-18 查询到的 `main`
>
> Bonsai 对照版本：本机 `/Users/paxton/bonsai` 的 `1f67667b8d96008f16e4ed201ce1e0dbfc145a1c`
>
> 范围：只分析上游源码中的模型可见文本、ToolDef、handler、结果和调用链；不修改产品代码，也不把 README 宣传声明当实现证据。

## 1. 结论

上游没有名为 `SpineJIT` 的单一工具。`SpineJit` 是默认开启的 feature，它注册一个 Responses API namespace `spine`，其中的结构控制函数是 `open`、`close`、`next`；完整模型调用名表现为 `spine.open`、`spine.close`、`spine.next`。`spine.spawn` 是依赖 `SpineJit` 的独立实验 feature，默认关闭。[feature 定义](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/features/src/lib.rs#L1270-L1291) [namespace 与函数名](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/core/src/tools/handlers/spine_spec.rs#L9-L14)

上游写给模型看的规则分成三层，不只是 tool description：

1. session base instructions 后追加完整 `<spine_view>`，解释节点边界、context ownership、生命周期、close/next 时机和每轮最多一个结构转换；
2. tool schema 的工具级和字段级 description，尤其是完整 Node Memory contract 与很长的 spawn 适用条件；
3. spawn child 收到的 task envelope，以及 child 偏离任务时注入的 correction message。

这些文本目前都直接嵌在 Rust 文件中，并没有像 Bonsai 一样拆成 Markdown template。[主 guidance](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/core/src/spine/instructions.rs#L1-L86) [schema 文本](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/core/src/tools/handlers/spine_spec.rs#L16-L154) [child envelope](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/core/src/spine/spawn.rs#L975-L1007)

## 2. 精确 ToolDef

### 2.1 公共包装

每个工具由 `ToolSpec::Namespace` 包成同一 namespace：

```text
namespace name: spine
namespace description: Use Spine to shape the work.
exposure: DirectAndCodeMode
supports_parallel_tool_calls: true
```

provider 侧函数名是 `open` / `close` / `next` / `spawn`；host 和 reducer 使用限定名 `spine.open` 等。所有工具均为 `strict: false`、`defer_loading: None`、`output_schema: None`。因此 spawn 虽然实际返回 typed receipt，ToolDef 本身没有声明 output schema。[namespace wrapper](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/core/src/tools/handlers/spine_spec.rs#L156-L162) [handler exposure](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/core/src/tools/handlers/spine.rs#L141-L160)

`supports_parallel_tool_calls: true` 不等于允许多个结构转换生效。direct-tool batch admission 只让第一个合法 open/close/next 成为 winner，其余返回“later response”错误；system guidance 也要求每 turn 最多一次转换。[batch admission](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/core/src/tools/parallel.rs#L67-L124) [system rule](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/core/src/spine/instructions.rs#L68-L79)

### 2.2 `spine.open`

```text
description:
Enter a direct child under the current Spine cursor. The child owns one
independently completable goal and the local working context needed to achieve
it. Co-issued ordinary tools belong to the child; the transition applies to
the current node's prior ReAct history.

input:
{
  "goal": string // required; additionalProperties=false
}

goal description:
Concise, actionable, independently completable outcome owned by the direct
child. The call carrying this goal remains in the child's context.
```

Schema 没有 `minLength`，handler 会 trim 后拒绝空字符串，reducer 重放时再次做同样的非空判断。[ToolDef](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/core/src/tools/handlers/spine_spec.rs#L25-L66) [handler validation](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/core/src/tools/handlers/spine.rs#L84-L130) [reducer classification](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/spine-core/src/reducer.rs#L517-L534)

### 2.3 `spine.close`

```text
description:
Finalize the current node once its owned result is complete or precisely
bounded and continuation can proceed from compact memory and inherited context
without its full local working context, then return to its immediate parent.
Root epochs cannot be closed. Co-issued ordinary tools belong to the parent;
the transition applies to the current node's prior ReAct history.

input:
{
  "memory": string // required; additionalProperties=false
}
```

`memory` 的字段 description 不是“summary”一句话，而是一份完整 contract：只保存 inherited context 之外的 continuation state，包括已确认进度与发现、决策与约束、验证、有限的未知与风险、剩余工作、证据到结论的逻辑；源码要给精确 path/line，命令要给命令和决定性结果。runtime 会独立保留 user messages 和 child memories；`[U#]` 只用来绑定用户批准、纠正、拒绝、澄清等语义变化。[Node Memory description](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/core/src/tools/handlers/spine_spec.rs#L16-L23) [close ToolDef](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/core/src/tools/handlers/spine_spec.rs#L67-L81)

close 在 root 会被 handler 拒绝，错误是 `no open Spine node is available to close`。[state admission](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/core/src/state/session.rs#L374-L395)

### 2.4 `spine.next`

```text
description:
Finalize the current node once its owned result is complete or precisely
bounded and continuation can proceed from compact memory and inherited context
without its full local working context, then enter a true sibling under the
same parent. The sibling owns one independently completable goal and the local
working context needed to achieve it. Co-issued ordinary tools belong to the
sibling; the transition applies to the current node's prior ReAct history.

input:
{
  "goal": string,   // required
  "memory": string  // required
} // additionalProperties=false
```

`goal` 明确属于新 sibling，finalized node 的状态必须写在 `memory`；memory 复用 close 的完整 contract。[next ToolDef](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/core/src/tools/handlers/spine_spec.rs#L26-L26) [next ToolDef](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/core/src/tools/handlers/spine_spec.rs#L82-L102)

### 2.5 `spine.spawn`

```text
input:
{
  "tasks": [
    {
      "summary": string, // concise, unique public branch identity/outcome
      "prompt": string   // complete assignment + shared blackboard line
    }
  ]
} // all objects additionalProperties=false
```

ToolDef 的 JSON Schema 只表达 `tasks` 是必填 array、task 的两个字段必填，没有编码 `minItems` / `maxItems`。数量通过 description 和 runtime 强制：至少 2；上限来自当前 session capacity。默认配置值是 4 个 concurrent threads，扣除 parent 后默认 tool 上限为 3，不是固定 4；用户可以配置。[spawn schema](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/core/src/tools/handlers/spine_spec.rs#L109-L154) [runtime min/unique/non-empty](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/core/src/spine/spawn.rs#L194-L223) [runtime max](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/core/src/tools/handlers/spine.rs#L132-L139) [effective capacity](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/core/src/config/mod.rs#L1196-L1207) [扣除 parent](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/core/src/config/mod.rs#L1466-L1470)

spawn description 的实际策略比 Bonsai 当前一行文本多得多：

- 从当前 full history 并发 fission 成 differentiated peers；每个 branch 必须是语义独立方向，有 scope、evidence boundary 和 completion predicate；
- 每个 summary 在一次调用内唯一，是 branch public identity；
- parent 必须先创建 task-local shared blackboard，并在每个 prompt 重复完全相同的 `Shared blackboard: <path>`；
- inherited analytical conclusions 对探索/审查 branch 只是待验证、细化或证伪的 hypothesis；
- 原 continuation 暂停，没有活跃 supervisory model；join 等全部 branch，在当前 scope 下按输入顺序原子导入 closed nodes，再恢复 parent；
- 每个 model response 最多一次 spawn；只在至少两个 substantial、self-contained、independently completable branches 且并发有实质收益时使用；单个委派或需要 parent supervision 时改用普通 multi-agent；
- shared workspace 和外部副作用不具事务性，写产品文件要么 ownership 不相交，要么指定一个 integration owner。

完整原文见 [`SPAWN_DESCRIPTION`](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/core/src/tools/handlers/spine_spec.rs#L28-L42)。

## 3. System guidance 与 child guidance

### 3.1 Main Agent 的 `<spine_view>`

开启 `SpineJit` 时，session 初始化会把 `SPINE_JIT_INSTRUCTIONS` 追加到 model base instructions；也支持 config override，但 override 必须是单个完整 `<spine_view>`，最多 32 KiB。[注入点](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/core/src/session/mod.rs#L607-L632) [append/override](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/core/src/spine/instructions.rs#L89-L143)

主 guidance 的核心不是“记得调用工具”，而是：

- 所有工作按 context ownership 和 lifecycle 管理；精确细节放在覆盖所有消费者的最低节点；
- child 必须拥有可独立完成、可独立压缩的工作体和 local context；不要为了语义分类或汇报进度硬切节点；
- shared exact context 留在最低共同祖先，单 branch context 下沉；避免导致反复 reload 的边界；
- context ownership 一明确就尽早 open，完成或精确 bounded 且后续不再需要原细节时才 close/next；
- 每轮最多一个 open/next/close，但可和普通工具同批；普通工具归属于转换后的节点；
- node 不是 user-response boundary，能回答用户时就回答。

完整文本见 [`instructions.rs:1-86`](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/core/src/spine/instructions.rs#L1-L86)。源码里有一个值得注意的命名不一致：guidance 写的是 `open(summary)` / `next(summary, memory)`，但真实 schema 和 handler 字段名是 `goal`。

### 3.2 Spawn child envelope

child 不是换一份独立 system prompt。runtime 从 parent 的 effective config 构造 child config，并把 parent base instructions 原样设给 child；child assignment 作为额外 user input 注入。[继承 base instructions](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/core/src/tools/handlers/multi_agents_common.rs#L161-L190) [child request/input](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/core/src/spine/spawn.rs#L393-L470)

child envelope 包含：branch 身份、peer summaries、直接开始 assignment、只为 assignment 内真实 descendant work 使用 open/close/next、使用 shared blackboard、inherited context 只是约束/证据、shared-workspace 变化不自动扩大工作、`<spine_tran_status>` 只是 parser telemetry，以及最终只能返回一个非空、tool-free terminal memory。[完整 envelope](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/core/src/spine/spawn.rs#L975-L1007)

上游没有 Bonsai 当前的 `Do not call spine_spawn` 句子。child config 从 parent config clone，源码所示 spawn path 没有移除 `SpineSpawn` feature；因此上游设计允许递归结构，而实际可用深度仍受共享 capacity admission 限制。这一点来自 config 和注册链，不只来自 README。[config clone](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/core/src/tools/handlers/multi_agents_common.rs#L177-L190) [feature-gated registration](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/core/src/tools/spec_plan.rs#L696-L708)

## 4. Handler、结果与重放

### 4.1 open/close/next

handler 的顺序是：拒绝 Plan mode → 解析 JSON 且 deny unknown fields → trim/非空校验 → 校验当前 tree state → 返回带 `success=true` 的固定 carrier：

```text
Spine open accepted.
Spine close accepted.
Spine next accepted.
```

如果旧 rollout 没有显式 success flag，replay 只有在 body 精确匹配 carrier 时才判定 succeeded。[handler](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/core/src/tools/handlers/spine.rs#L167-L217) [carrier/outcome](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/core/src/spine/tool_response.rs#L30-L85)

工具 request/output 随普通 conversation items 写进 native history 和 `spine_rollout`。下一轮 `clone_history()` 从 rollout 派生 reducer tree 和 projected context；因此 handler success 不是直接修改 tree，持久化 tool facts 才是 reducer 的输入。[record](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/core/src/session/mod.rs#L3043-L3074) [projection entry](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/core/src/state/session.rs#L179-L193)

### 4.2 spawn receipt

direct `spine.spawn` 的即时 tool result 是序列化 JSON：

```text
SpawnReceipt {
  schema: "spine.spawn.result.v1",
  results: [
    {
      ordinal: 0,
      outcome: "completed" | "errored" | "aborted",
      memory_body: "...",
      diagnostic?: "...",
      execution_ref?: "child thread id"
    }
  ]
}
```

receipt 必须与 task 数量和输入顺序一一对应；每项 memory 非空；非 completed 必须有非空 diagnostic；execution ref 若存在必须非空。[types/validation](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/spine-core/src/model.rs#L72-L106) [validation](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/spine-core/src/model.rs#L162-L215) [handler output](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/core/src/tools/handlers/spine.rs#L218-L271)

capacity 不足是一个特殊情况：runtime 不创建任何 child，但生成全部为 `errored` 的合法 receipt，而不是把整个 tool transport 判为失败。child start/runtime/cancel 也会被归一为 completed/errored/aborted terminal result；parent 等所有 branch terminal 后才完成 receipt。[capacity path](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/core/src/spine/spawn.rs#L439-L480) [status mapping](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/core/src/spine/spawn.rs#L1091-L1161) [receipt finalization](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/core/src/spine/spawn.rs#L1164-L1188)

reducer 只消费 outcome succeeded 且 receipt 完整合法的 spawn call，把每个 task/result 原子导入成 input-order 的 Closed child。每个 child 有一份 `SpawnEvidence` 和一份 `Summary(memory_body)`；下一轮 materialize 为 `<spine_spawn_evidence>` 与 `<spine_memory>`。原始 spawn tool output 在 projected context 中缩成 `{"status":"success"}`，避免把 receipt 明细重复留在普通 tool result 里。[replay validation](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/spine-core/src/reducer.rs#L536-L574) [closed children](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/spine-core/src/reducer.rs#L278-L336) [memory materialization](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/core/src/spine/mod.rs#L1009-L1031) [tool-output projection](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/core/src/spine/mod.rs#L1048-L1095)

spawn progress 是 live-only UI event，不进入 rollout；typed receipt 才是唯一 durable/replay source。[progress contract](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/protocol/src/spine_tree.rs#L10-L31)

## 5. 完整调用链

```text
session init
  -> append <spine_view> to base instructions
  -> per-turn ToolPlan checks feature flags
  -> register namespace spine/open|close|next
  -> if SpineJit + SpineSpawn + non-Plan: register spine/spawn(max_tasks)

model tool call
  -> SpineHandler parses and validates arguments/state
  -> open/close/next: return fixed success carrier
  -> spawn: inspect complete response group
       -> reject mixed control / multiple spawn
       -> aggregate capacity admission
       -> clone parent config + full-history-trim-tool-suffix fork request
       -> inject task envelope and run branches concurrently
       -> wait/teardown/quiesce
       -> validate and return typed receipt

record native request + output into rollout
  -> clone_history()
  -> adapter reconstructs complete tool group and outcome
  -> SpineReducer validates persisted args/output again
  -> apply structural transition / import closed spawn children
  -> materialize projected context for next model request
```

注册入口见 [`spec_plan.rs:688-712`](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/core/src/tools/spec_plan.rs#L688-L712)。spawn 的 “current full history” 仍有上游自己的验证 TODO：代码使用 `FullHistoryTrimToolCallSuffix`，但明确要求后续比较 parent effective context、inherited Spine memory 和 cached tokens 后才能强化契约。因此应把“发起 full-history fork”视为源码事实，把“完整有效上下文与缓存一定等价”视为尚未验证。[TODO 与 fork mode](https://github.com/GhabiX/SpineCodex/blob/15cfe2d8b00a0338602533ff2c338a16652a06af/codex-rs/core/src/spine/spawn.rs#L420-L434)

## 6. 与当前 Bonsai 的简明对照

| 维度 | SpineCodex 固定版本 | Bonsai `1f67667b` | 判断 |
| --- | --- | --- | --- |
| 工具名 | namespace `spine` + `open/close/next/spawn`，限定名为 dotted form | `spine_open/close/next/spawn` | runtime API 不同，语义字段相同 |
| prompt 存放 | Rust 内嵌：`instructions.rs`、`spine_spec.rs`、`spawn.rs` | Markdown：`prompts/agents/*`、`prompts/tools/*` | Bonsai 的解耦方向符合当前目标 |
| main Spine guidance | 完整 `<spine_view>`，约 80 行 | tool prompt snippets 各一行，没有同等的 ownership/lifecycle policy | 当前 Bonsai 最大的模型行为缺口 |
| open/close/next description | 工具级 description 解释归属和 precise boundary；字段级 description 解释 goal/memory contract | description 与 promptSnippet 都是一行 | schema 形状保留，语义 guidance 丢失较多 |
| memory contract | 明确进度、发现、决策、约束、验证、风险、剩余工作、证据引用和 `[U#]` | `Close ... compact memory` / `durable memory` | 应优先补全的文本层，不需要改 reducer 才能先对齐 |
| spawn description | 包含适用阈值、blackboard、hypothesis checking、无 supervisor、join、side effects ownership | 一行 description + 一行 promptSnippet | 当前未告诉 parent 如何形成高质量、低冲突 branches |
| spawn schema | schema 无 min/max；runtime min 2，max 动态，默认 3 | TypeBox 显式 `minItems:2,maxItems:4`，runtime 2–4 | Bonsai 更显式，但不是上游原样 |
| child prompt | parent base instructions + 详细 task envelope + shared blackboard | parent system prompt + 较短 `spine-child.md` | 都继承 parent，但 Bonsai 缺 blackboard/telemetry/workspace ownership 文本 |
| nested spawn | 没有从 child config 移除 feature；受共享 capacity 限制 | 创建 child 时显式过滤 `spine_spawn` | 这是 Bonsai 有意的 depth-1 偏离，不应误称上游行为 |
| receipt | `spine.spawn.result.v1`，ordered results，completed/errored/aborted | 同 schema，reducer 也二次验证 | 核心数据契约已基本对齐 |
| immediate output | controls 为固定 carrier；spawn 为 JSON receipt；replay 后 receipt tool output 缩成 status | controls 为 Bonsai 文本；spawn 为 JSON receipt | tree 语义接近，carrier 文案和 replay projection 不同 |

Bonsai 对照源码：[`tools.ts:8-104`](/Users/paxton/bonsai/packages/coding-agent/src/core/bonsai/tools.ts#L8-L104)、[`spawn.ts:30-84`](/Users/paxton/bonsai/packages/coding-agent/src/core/bonsai/spawn.ts#L30-L84)、[`spawn.ts:249-297`](/Users/paxton/bonsai/packages/coding-agent/src/core/bonsai/spawn.ts#L249-L297)、[`reducer.ts:68-168`](/Users/paxton/bonsai/packages/coding-agent/src/core/bonsai/reducer.ts#L68-L168)、[`spine-child.md`](/Users/paxton/bonsai/packages/coding-agent/prompts/agents/spine-child.md)。

## 7. 对下一步 Prompt 解耦的直接含义

如果目标是把上游真正影响 Agent 行为的纯文本迁移成 Bonsai 可编辑 template，最小且完整的集合不是只扩写四个 `*-description.md`，而是：

1. `agents/main.md` 中可插入的一份 Spine main guidance template，对齐 `<spine_view>` 的 ownership/lifecycle/execution policy；
2. `tools/spine-open|close|next|spawn-description.md`，承载上游工具级 description；
3. 字段级 description template，至少包含 `goal`、完整 Node Memory contract、spawn `summary`/`prompt`；当前 TypeBox schema 里字段没有 description；
4. `agents/spine-child.md`，对齐 assignment boundary、peer/blackboard、workspace ownership、terminal-memory contract；
5. 可选 correction template；只有 Bonsai 实现 child 中途向 parent 发消息并纠偏时才需要，当前无需为了文本对齐先造 runtime 机制。

其中第 1–4 项都是上游当前真实存在且模型可见的行为层；第 5 项依赖当前 Bonsai 尚未提供的交互路径，可以后置。
