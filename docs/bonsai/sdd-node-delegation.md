# Bonsai Agent Profiles 与 Node Delegation SDD

> 状态：Implemented / Focused Verification Complete
>
> 实施位置：`packages/coding-agent/src/core/bonsai/agent-profile.ts` 与 `delegate.ts`。
>
> 实施范围：统一 Agent Profile、node-local delegate、首批预定义 delegates。

## 1. 目标

Bonsai 使用统一的 Agent Profile 描述 main agent、SpineSpawn child 和 node-local delegate。Profile 由 YAML frontmatter 提供运行约束，由 Markdown body 提供 system prompt。

node-local delegate 是当前 Bonsai Task Tree node 内部的上下文外包工具，例如 explorer、worker 和 reviewer。它使用独立的进程内 `AgentSession` 完成窄任务，只向调用 node 返回有界 receipt，不创建 Task Tree child，也不改变 Spine 树结构。

本设计吸收两个开源实现中已验证的部分，但不增加第三方 runtime 依赖：

- `@bacnh85/pi-subagent`：Markdown profile、模型候选、工具校验、取消/超时和结果分类。
- `pi-delegate`：单一 delegate tool、in-memory child、紧凑结果和最小运行 surface。

Bonsai 保留自己的 runtime、上下文投影和权限语义。

固定参考版本：

- `@bacnh85/pi-subagent` 0.15.2，`bacnh85/pi-extensions@0d0395dea8f1e61cbe8aa3e428ed87e02cadd936`。
- `pi-delegate` 0.6.0，`drsh4dow/pi-delegate@a53d98a3818a68330c55da28a723d91d740cfaed`。

`@bacnh85/pi-subagent` 声明 MIT；固定版本的 `pi-delegate` 未提供 LICENSE 文件或 package license 字段，因此 Bonsai 只参考其公开行为，不复制源码。Bonsai 未增加第三方 runtime 依赖，也未引入 background、chain、worktree 或 Fleet 管理层。

## 2. 核心区分

~~~text
Main Agent
  当前 Bonsai 会话的 owner
  使用当前 Task Tree node 的可见上下文
  可以调用普通工具、Spine 控制工具和 delegate

SpineSpawn child
  创建 Task Tree child branch
  可以使用 SpineJIT 管理自己的 branch 上下文
  永远不能调用 spine_spawn 或 delegate

Node-local delegate
  当前 node 的普通工具调用
  不创建 Task Tree branch
  永远不能使用任何 spine_* 或 delegate 工具
  只返回 bounded receipt
~~~

`spine_spawn` 解决可观察的 peer branch 并行；`delegate` 解决局部上下文隔离。两者不得共享调度状态或互相模拟。

## 3. 目录与模块 seam

~~~text
packages/coding-agent/src/core/bonsai/
  agent-profile.ts   读取、校验并解析统一 Agent Profile
  delegate.ts        delegate tool、child 生命周期和 receipt
  integration.ts     注册 Bonsai tools；prepared context snapshot 只供 SpineSpawn
  model.ts           公共 receipt 类型和 schema 常量
  spawn.ts           只负责 SpineSpawn

packages/coding-agent/prompts/
  agents/
    main.md
    spine-child.md
    delegates/
      explorer.md
      worker.md
      reviewer.md
  tools/
    delegate.md
~~~

模块要求：

- `agent-profile.ts` 是 main、SpineSpawn child 和 delegate 共用的 profile seam；复用现有 `parseFrontmatter`，不引入 YAML 依赖或第二套 parser。
- `delegate.ts` 是独立深模块。它可以复用 `spawn.ts` 已验证的进程内 child-session 创建模式，但不得导入或修改 Spine reducer、projection 或 structural control。
- `spawn.ts` 不承载 profile registry、delegate receipt 或 delegate 调度。
- 不创建 manager、factory、DI container 或通用 agent graph。

对外保持两个小接口：

~~~ts
loadAgentProfile(name, expectedKind) -> AgentProfile
createDelegateTool(getRuntime) -> ToolDefinition
~~~

Profile 解析、模型解析、工具求交、deadline、child teardown 和 receipt 组装均隐藏在模块内部。

## 4. Agent Profile 格式

所有 agent prompt 使用 YAML frontmatter + Markdown body：

~~~md
---
name: explorer
kind: delegate
description: 快速定位代码、调用链和相关证据
model:
  - provider/fast-model
  - inherit
thinking: low
tools:
  - read
  - grep
  - find
  - ls
deadline_ms: 120000
result_max_bytes: 12000
---

你是 Bonsai 的 explorer……
~~~

Markdown body 是 system prompt。Frontmatter 不进入模型上下文。

### 4.1 字段契约

| 字段 | 类型 | 规则 |
| --- | --- | --- |
| `name` | 非空字符串 | 必填；必须与固定 profile 名或 delegates 文件名一致 |
| `kind` | `main \| spine-child \| delegate` | 必填；加载方传入 expected kind，文件不能冒充其他 kind |
| `description` | 非空字符串 | 必填；供 tool guidance 和 profile 列表使用 |
| `model` | `inherit` 或有序字符串数组 | 可选，默认 `inherit`；数组按顺序解析，允许最后一项为 `inherit` |
| `thinking` | `inherit \| off \| minimal \| low \| medium \| high \| xhigh \| max` | 可选，默认 `inherit` |
| `tools` | `inherit` 或工具名数组 | 必填；delegate 不允许 `inherit` |
| `deadline_ms` | 正整数 | child 可选；默认 120000，最大 1200000；main 禁止设置 |
| `result_max_bytes` | 正整数 | delegate 可选；默认 12000，范围 1024–32768；其他 kind 禁止设置 |

未知字段、重复工具名、空 prompt body、非法枚举、超出范围的数值均视为 profile 配置错误。不得静默忽略或自动修复。

MVP 不支持 frontmatter 中配置 skills、extensions、background、worktree、memory、resume 或 nested agents。

### 4.2 Profile 发现

- `main` 固定读取 `prompts/agents/main.md`。
- SpineSpawn child 固定读取 `prompts/agents/spine-child.md`。
- delegate 从 `prompts/agents/delegates/*.md` 发现；首批只内置 explorer、worker、reviewer。
- delegate tool 只能调用成功加载且校验通过的 profile。
- 未知或无效 profile 直接返回工具错误，不 fallback 到 general-purpose。
- MVP 不读取项目仓库提供的 `.pi/agents`，避免不受信任项目扩大 child 权限。项目级 profile override 另行设计。

## 5. 初始 Profiles

### 5.1 main

~~~yaml
name: main
kind: main
description: Bonsai main agent
model: inherit
thinking: inherit
tools: inherit
~~~

`main` 继续服从 CLI/model selector、settings 和当前 session 的 active tools。Profile 只能进一步收紧，不能恢复 runtime 已禁用的工具。

### 5.2 spine-child

~~~yaml
name: spine-child
kind: spine-child
description: Bonsai SpineSpawn execution branch
model: inherit
thinking: inherit
tools: inherit
deadline_ms: 120000
~~~

SpineSpawn child 继承 parent model、thinking 和当前有效工具，但 runtime 永久删除 `spine_spawn`、`delegate` 以及任何等价 delegation tool。它仍可使用 `spine_open`、`spine_close`、`spine_next` 和 `spine_trim`。

### 5.3 explorer

- 目标：定位文件、调用链、实现事实和证据。
- 默认 thinking：`low`。
- 默认 tools：`read`、`grep`、`find`、`ls`。
- 默认 model：`inherit`；用户可在 profile 中配置更低成本的有序候选。
- 只读，不拥有 `bash`、`edit`、`write`。

### 5.4 reviewer

- 目标：独立审查 diff、实现和验证证据。
- 默认 thinking：`medium`。
- 默认 tools：`read`、`grep`、`find`、`ls`、`bash`。
- 默认 model：`inherit`。
- Prompt 明确禁止编辑；MVP 承认 `bash` 不是安全沙箱，因此只把 reviewer 用于可信模型和可信 workspace。

### 5.5 worker

- 目标：执行 parent 明确授权的窄实现或验证任务。
- 默认 thinking：`medium`。
- 默认 tools：`read`、`grep`、`find`、`ls`、`bash`、`edit`、`write`。
- 默认 model：`inherit`。
- 共享 parent workspace；delegate tool 串行执行，MVP 不允许多个 worker 并发写入。

## 6. 权限模型

Profile 是权限请求，不是权限来源。最终工具集由 runtime 计算：

~~~text
effectiveTools =
  runtimeAvailableTools
  ∩ profileRequestedTools
  ∩ parentEffectiveTools
  − kindHardDenylist
~~~

`parentEffectiveTools` 指经过 CLI/settings allowlist 与 denylist 后仍获许可的注册工具，不等同于 main 当前为节省 tooldef token 而激活的工具子集。delegate 的显式 profile 可以启用获许可但 main 当前未激活的工具，不能恢复 CLI/settings 已禁用的工具。

当 `tools: inherit` 时，`profileRequestedTools` 等于 parent 当前有效工具；delegate 禁止使用 inherit。

### 6.1 Hard denylists

| kind | 永久禁止 |
| --- | --- |
| `main` | 仅 runtime/settings 已禁用的工具 |
| `spine-child` | `spine_spawn`、`delegate`、所有等价 subagent/delegation tools |
| `delegate` | 所有 `spine_*`、`delegate`、所有等价 subagent/delegation tools |

Hard denylist 由代码定义，YAML、prompt、extension 或 parent 不能覆盖。工具名比较使用注册后的真实工具名；另外对 `spine_` 前缀执行 fail-closed 排除。

如果 profile 请求 parent 不拥有或 runtime 未注册的工具，profile 加载成功，但调用该 profile 时返回明确配置错误；不得静默降级到更宽或更窄的工具集。

## 7. 模型与 Thinking 解析

### 7.1 模型候选

- `inherit` 表示调用 session 当前模型。
- 字符串模型引用使用 Pi 当前 provider/model 解析机制，不建立 Bonsai model registry。
- 有序数组从前到后选择第一个已配置、可用且可认证的模型。
- 所有候选不可用时调用失败，不 fallback 到未声明模型。
- 只有 child 在首次模型调用、零 assistant output、零 tool call 时失败，才允许尝试下一个候选。
- child 一旦执行工具或产生 assistant output，不得换模型重试，避免重复 side effects。

### 7.2 Thinking

- `inherit` 使用 parent 当前 thinking level。
- 显式值是 child 的偏好上限，不得高于 parent 当前 thinking level。
- 如果目标模型不支持该档位，选择模型支持且不高于该上限的最高档位；例如 DeepSeek Flash 的 `medium` 自动降为 `low`。
- thinking 降级由 runtime 确定，不要求用户为每个 provider 修改 profile。

## 8. Delegate Tool 接口

模型可见接口保持最小：

~~~ts
delegate({
  profile: string,
  task: string
})
~~~

- `profile` 必须是已加载的 delegate profile。
- `task` 必须是非空、自包含的窄任务，说明只读或允许编辑、期望输出和验证要求。
- 单次 tool call 只启动一个 child。
- tool 使用 sequential execution；MVP 无 background、parallel、chain、steer、resume 或 status tool。
- delegate 是普通工具，不调用 `admitStructuralControl`，也不产生 Spine structural event。

Tool brief、guidance 和 few-shot 位于 `prompts/tools/delegate.md`；JSON Schema 仍由 TypeBox 定义并交给 provider。

## 9. Context 与 Session 生命周期

1. delegate child 从空 history 启动；不得复制或共享 main agent 的对话历史。
2. main agent 委派的 `task` 是 child 唯一的 user message，也是唯一可执行任务。
3. child system prompt 由选中 profile 的 Markdown body、global/project `AGENTS.md`、实际启用工具的 guidance 和固定 delegate runtime contract 组成；不复制 main system prompt。
4. `spine_spawn` 与 delegate 保持不同语义：SpineSpawn child 继续继承当前 node 的 projected prepared context。
5. child 使用进程内 `AgentSession`、独立 `SessionManager` 和独立 session id。
6. skills、extensions、MCP、prompt templates 和 themes 默认不继承；AGENTS.md 是 parent 与 delegate 共享稳定项目知识的唯一入口。
7. parent 持久化时，child session 记录 parent session 引用；parent 为 in-memory 时 child 也为 in-memory。
8. child transcript 不投影进 Task Tree，不自动追加为 node memory。
9. parent abort 必须级联 child；deadline 到期 abort child，并使用最多 5 秒 teardown deadline。
10. 无论 completed、errored、aborted 或 timed out，child 最终都必须 dispose，active accounting 必须释放。

delegate 的工具调用和 receipt 作为当前 node 的普通 tool group 保留。关闭 node 时，它和其他普通工具一样参与当前 node memory，不生成 child memory slot。

## 10. Receipt

MVP receipt 使用现有基础设施可可靠生成的字段，不提前引入 evidence store：

~~~ts
interface DelegateReceipt {
  schema: "bonsai.delegate.result.v1";
  profile: string;
  outcome: "completed" | "errored" | "aborted";
  memory_body: string;
  execution_ref: string;
  truncated?: true;
  diagnostic?: string;
}
~~~

规则：

- `memory_body` 来自最后一个非空 assistant final text。
- Profile prompt 要求“结论优先”，并在正文中列出文件、符号、命令和验证证据。
- `memory_body` 超过 `result_max_bytes` 时按 UTF-8 字节安全截断，追加明确 marker，设置 `truncated: true`；完整内容保留在 child transcript。
- 没有 final text、最终 stop reason 为 error、deadline 或模型链耗尽时返回 `errored` 并提供 diagnostic。
- parent abort 或 child stop reason 为 aborted 时返回 `aborted`。
- `execution_ref` 使用 child session id，供未来 trace UI 查找完整 transcript。
- `evidence_refs` 等待统一 evidence store 后再加入 v2；MVP 不解析模型自报 JSON，也不伪造结构化引用。

TUI 默认只显示：

~~~text
Delegate finished · explorer · completed
<memory_body 的前 2–3 行预览>
~~~

展开后显示完整 parent-facing receipt；不把 child transcript 或原始 JSON 刷入主 TUI。

## 11. 失败语义

| 情况 | 行为 |
| --- | --- |
| Profile 不存在或 YAML 非法 | tool error；不启动 child |
| kind 不匹配 | tool error；不启动 child |
| 请求未知、越权或 hard-denied tool | tool error；不启动 child |
| 模型候选全部不可用 | `errored` receipt |
| Thinking 档位不受模型支持 | 自动降到模型支持且不高于 parent 的最高档位 |
| Parent 已 abort | `aborted` receipt；不开始模型调用 |
| Deadline | abort child；`errored` receipt，diagnostic 标记 timeout |
| Child 无 final text | `errored` receipt |
| Receipt 超限 | 安全截断并设置 `truncated`，不把超限正文注入 parent |
| Child dispose 失败 | 记录 diagnostic；仍释放 parent active accounting |

配置错误使用工具 Error，让模型和用户能区分“调用无效”与“child 执行失败”。不得自动改 profile、扩大权限或重试同一副作用任务。

## 12. 与 Main/SpineSpawn Profile 的迁移

统一 profile 支持分两步落地，但最终必须使用同一个 parser 和字段契约：

1. 给现有 `main.md` 与 `spine-child.md` 增加 YAML frontmatter；prompt body 保持现有动态 `{{BONSAI_*}}` 渲染。
2. system prompt loader 在渲染前剥离 frontmatter，并把解析后的 model/thinking/tools 交给 session 创建逻辑执行。

YAML 不是模型 guidance。模型看不到 frontmatter；runtime 必须真实设置模型、thinking 和 active tools。

## 13. SpineSpawn 自动 Guidance

SpineSpawn 的 parent guidance 继续自动表达以下规则，用户不必重复输入：

~~~text
只调用一次 spine_spawn，并行执行给定任务。
子任务不得调用 spine_spawn。父节点按任务原顺序汇总结论。
~~~

这段 guidance 不替代 runtime 的 structural-control、child tool denylist 和 receipt ordinal 校验。它属于 SpineSpawn，不属于 delegate tool。

## 14. 验收标准

### 14.1 Profile

- main、spine-child、explorer、worker、reviewer 均由 YAML frontmatter + Markdown body 加载。
- Frontmatter 不出现在模型 system prompt。
- 缺字段、未知字段、非法 kind、非法模型/工具/thinking/deadline/result limit 均有确定错误。
- 修改 Markdown body 无需修改 TypeScript。

### 14.2 权限

- delegate child 的工具集严格等于三方交集减 hard denylist。
- profile 即使声明 `spine_spawn`、`spine_open` 或 `delegate` 也无法获得。
- SpineSpawn child 可以使用 SpineJIT，但无法使用 `spine_spawn` 或 delegate。
- delegate 不能递归 delegate，也不会创建 Task Tree child。

### 14.3 Runtime

- child 是同进程独立 `AgentSession`，拥有独立 session id。
- child history 为空，且唯一 user message 是 parent 提供的 task；parent 对话历史不可见。
- child system prompt 包含 profile、AGENTS.md 和实际工具 guidance，不包含 parent system prompt、skills、extensions 或 MCP。
- model candidate、thinking、deadline、abort 和 teardown 按契约工作。
- worker 串行执行；不存在并发写入路径。
- 所有 outcome 都 dispose child 并释放 active accounting。

### 14.4 Receipt 与 UI

- receipt schema、outcome、profile、memory body 和 execution ref 可重放验证。
- 超限输出不会进入 parent context，且 TUI 明确显示截断。
- 默认 TUI 紧凑；展开才显示完整 parent-facing receipt。
- child transcript 不自动进入 Spine projection 或 node memory slot。

### 14.5 回归测试

至少覆盖：

- profile parser/validation；
- profile tool intersection 与 hard denylist；
- main/spine-child frontmatter stripping；
- delegate completed/errored/aborted/timeout/truncated；
- model preflight fallback 与 side-effect 后禁止重试；
- fresh child context 与唯一 task message；
- AGENTS.md 和实际工具 guidance 注入；
- no recursive delegate/no Spine tools；
- child disposal 与 active accounting；
- reducer 将 delegate 视为普通 tool group；
- compact/expanded TUI rendering。

测试使用 faux provider，不调用真实 provider，不消耗付费 token。

## 15. 实施顺序

1. 实现并测试统一 `agent-profile.ts`；迁移 main/spine-child frontmatter。
2. 添加三个 bundled delegate profiles 和 `tools/delegate.md`。
3. 实现 `delegate.ts` 的单 child runtime、权限求交、模型解析、deadline 和 receipt。
4. 在 `integration.ts` 注册 delegate；prepared context snapshot 继续只供 SpineSpawn。
5. 添加紧凑 TUI renderer 和 faux-provider 回归测试。
6. 运行 focused tests 与 `npm run check`；既有生成模型目录错误若仍存在，单独报告，不把它归因于 delegate。

每一步只增加当前步骤所需的代码；不预建 background manager、profile marketplace 或未来 evidence store。

## 16. 非目标

- 不把 delegate 建模成 Spine Task Tree child。
- 不允许递归 delegation。
- 不允许 delegate 使用任何 Spine 工具。
- 不引入第三方 subagent runtime 依赖。
- 不实现 background、parallel、chain、steer、resume、missions、scheduling 或 Fleet UI。
- 不实现长期角色 memory、跨会话 delegate 恢复或隐藏的 delegation graph。
- 不实现项目级不受信任 profile、自动 profile 生成或 profile marketplace。
- 不引入 evidence store；v1 只保留 execution ref 和正文内证据。
- 不修改 SpineJIT reducer/projection 语义。
