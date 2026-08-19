# Pi Subagent Packages 与 Bonsai Node Delegate 契约对照

> 调研日期：2026-08-19  
> 范围：只读检查官方 pi.dev 页面、GitHub README/docs/source；未安装 package，未修改运行代码。

## 结论

扫描完整个 pi.dev package 目录后，**不建议 Bonsai 直接依赖任何现成 subagent runtime**。Bonsai 已有 `spawn.ts` 的进程内 child `AgentSession` 生命周期；引入第三方整包会同时带入另一套编排状态、UI、background、worktree 或 context 语义，收益小于适配成本。

最值得参考的是 [`@bacnh85/pi-subagent`](https://pi.dev/packages/@bacnh85/pi-subagent)：它已经实现预定义 Markdown profile、模型 fallback、父级工具清单校验、禁止递归、取消/超时和状态分类，和 Bonsai 的方向最接近。最小 runtime surface 则可参考 [`pi-delegate`](https://pi.dev/packages/pi-delegate)：单个 `delegate` tool + in-memory child session，但它没有 profile registry。

最终方案是：**保留 Bonsai 自己的 runtime，选择性移植 `@bacnh85/pi-subagent` 的 profile/scoping/lifecycle 设计，并由 Bonsai 强制 `node ceiling ∩ profile allowlist − spine.* − delegate tools`、未知 profile fail-closed、bounded receipt/evidence refs。**

## pi.dev 全目录扫描

2026-08-19 对 `https://pi.dev/packages` 的 111 页目录做了两级筛选：

- package 名称直接包含 `subagent` / `sub-agent`：135 个；
- 再纳入描述含 `delegate`、`child agent`、`isolated agent` 等词的 package：331 个；
- 对候选按 runtime 形态、profile、权限、递归、context、输出协议和附带复杂度继续源码核验；fork、单用途 agent、tmux/RPC/process runner 和 workflow/swarm package 不因数量重复计入新架构方案。

### 新候选排序

| 排名 | Package | 与 Bonsai 相符之处 | 关键缺口 | 判断 |
| --- | --- | --- | --- | --- |
| 1 | `@bacnh85/pi-subagent` 0.15.2 | 进程内 `createAgentSession`；Markdown profile 含 prompt/tools/model chain/thinking；工具按 parent inventory 校验；child 固定剥离 `subagent`；有取消、idle/hard timeout、状态分类和并行输出上限 | denylist 只有 `subagent`，没有 `spine.*`；宽权限 profile 可继承所有 parent tools；单任务结果不是统一 bounded receipt；peer range 尚未覆盖 Bonsai 当前 Pi 版本 | **主要源码参考，不直接安装** |
| 2 | `@nerisma/pi-agents`（pi.dev 1.3.2；核验仓库 1.4.0） | Markdown 预定义 agent；固定 prompt/tools/model/thinking/skills；`delegate` 使用进程内 session；child loader 排除自身 extension，因此 runner 不递归 | 整包还包含 activation、agent/skill creator、session reviewer；缺省 tools 会放宽；profile 可声明 delegate；provider guard 有 fail-open 路径 | profile/delegate seam 值得参考，整包过重 |
| 3 | `@router-for-me/pi-subagents-lite` 1.5.4 | 进程内 session；Markdown profile 支持 tools/extensions/skills/model/thinking/turn limit；工具 allowlist 与 active parent tools 求交；child 剥离 `Agent` | 默认 profile 可继承全部 tools/extensions/skills；只剥离 `Agent`，不剥离 `spine.*`；约 10k LOC 的 UI/background/steering/transcript switching 超出需求 | 参考工具和模型作用域，不引入 runtime |
| 补充 | `pi-delegate` 0.6.0 | 单 tool；`SessionManager.inMemory` + `createAgentSession`；禁止 delegate/subagent/status；15 分钟 timeout；输出设上限并保存完整结果 | 没有预定义 profile；denylist 不含 `spine.*`；普通工具/extension 边界仍需 Bonsai 接管 | **最小 tool surface 参考** |

`@tintinweb/pi-subagents` 仍是合格参考，但全目录比较后不再是首选：它的进程内 runtime 和 profile 能复用，然而 background/widget/steering/transcript 等设施较多，且权限与结果协议仍需 Bonsai 重写边界。

### 明确排除

- `pi-subagents`（nicobailon）和 `simple-subagents`：核心是 child process，违反进程内硬约束；
- `@agwab/pi-subagent`、`pi-background-tasks`、`pi-landstrip`：process-oriented 或 process-backed；
- tmux、Herdr、RPC、terminal multiplexer 家族：运行模型不符；
- `pi-fabric`、dynamic workflows、teams/crew/orchestrator：解决 swarm/workflow，不是 node-local 工具型 delegate；
- image/reviewer/explorer 等单用途 package：可参考 prompt，但不是通用 profile runtime；
- `@gotgenes/pi-subagents`、`pi-claude-subagents` 及大量 fork：分别因 background/resume/event bus、默认递归深度或宽权限、附带 worktree/verification 等复杂度而降级；没有提供 Bonsai 尚缺的核心机制。

## Bonsai 基准契约

来自 `docs/bonsai/sdd-node-delegation.md`：

- child 是同一进程内的独立 `AgentSession`；
- 每种工具型 delegate 使用预定义 profile：固定 system prompt、模型策略、工具和最大权限；
- delegate 权限不得超过当前 Spine node；
- delegate 不得拥有任何 `spine.*`，也不得再次 delegate；
- transcript 独立保存；parent 只接收 bounded receipt 和 evidence refs；
- delegate 是 node 的辅助执行，不新增或改变 Spine Task Tree 节点。

## 契约对照

| 维度 | `nicobailon/pi-subagents` 0.50.0 | `@tintinweb/pi-subagents` 0.17.0 | Bonsai 判断 |
| --- | --- | --- | --- |
| Runtime | 文档明确称为 child Pi process；前台执行直接调用 `child_process.spawn` 启动 Pi CLI | 创建独立 `SessionManager`，然后调用 `createAgentSession`；未用 subprocess 启动 child Pi | nicobailon 违反硬约束；tintinweb 符合 |
| 预定义 profile | 成熟。Markdown frontmatter 可定义 prompt、tools、extensions、skills、model、thinking，并有 scout/researcher/worker/reviewer 等角色 | 成熟。内置 `general-purpose`、`Explore`、`Plan`，Markdown frontmatter 可定义 prompt、tools、extensions、skills、model、thinking、max turns、memory | 两者都可参考；Bonsai 应自带更窄的 explorer/worker/reviewer profiles |
| 禁止递归 delegate | 支持嵌套，默认最大深度 2；需通过配置和不暴露工具来关闭 | `allowed_subagents` 默认缺省，不注入 nested tools；但全局默认最大深度仍是 2，可设 `0` 或 `1` 关闭 | 两者都不是 Bonsai 的不可绕过硬禁令；适配层必须 fail-closed |
| 禁止 `spine.*` | 内置角色 allowlist 当前未列出，但没有 Bonsai 专用硬禁令 | 默认排除本 package 的 `Agent`/result/steer 工具，并支持 `extensions:false`、显式 tools、`disallowed_tools`；没有“排除全部 `spine.*`”硬规则 | 不应依赖 profile 文本或当前 allowlist；创建 child 前统一删除 `spine.*` |
| 权限不超过 parent node | child 使用自身 profile/进程配置；不天然表达 Bonsai node capability ceiling | README 明确说明 nested child 使用自己的权限，甚至可能超过 parent；当前 scoping 主要按 profile/extension 配置 | 两者都需要 Bonsai 计算 `effectiveTools = nodeCeiling ∩ profileAllowlist − spine.* − delegateTools` |
| Parent context | 支持 fresh/fork；fork 建真实 branched session，并过滤 orchestration history | `inherit_context` 将 parent branch 渲染为文本，跳过 tool results；不是 immutable prepared-context snapshot | 都需对齐 Bonsai 当前 node 的 prepared/visible context；不可直接继承整个 parent session |
| Transcript / memory | 支持 session、结果文件与 per-agent memory | 独立 in-memory 或持久化 `SessionManager`，可写 transcript，也有 profile memory scope | tintinweb 的 session 生命周期更容易接入；长期 memory 首版应关闭或由 Bonsai 管理 |
| 返回 parent | 最终 assistant text 或 package 自己的 structured result | `AgentRecord.result?: string`，主要返回当前 run 的最终 assistant text | 都不满足 bounded receipt/evidence refs；必须在边界处转换和限长 |
| 对 Spine Tree 的影响 | 维护自己的 jobs/missions/fleet 等 orchestration 状态 | 维护 agent records、background/widget/mentions 等状态 | 首版只复用 child session/profile/scoping，不把第三方 orchestration 模型映射成 Spine 节点 |
| 直接依赖适配成本 | 高：需要替换最核心的 subprocess 执行层，复用收益不足 | 中：核心 runtime 已符合，但仍需收紧边界与结果协议 | 两者都只作参考；Bonsai 不新增第三方 runtime 依赖 |

## 推荐实现边界

不新增第三方 runtime 依赖，也不再做“基于某个 package 的 adapter”。新增独立的 node-local delegate 模块，复用 Bonsai `spawn.ts` 已验证的 child-session 生命周期模式，但不把 delegate 逻辑并入 SpineSpawn：

1. 增加小型 Markdown profile loader，字段只保留 name、system prompt、tool allowlist、model candidates、thinking、deadline 和 result limit；主要参考 `@bacnh85/pi-subagent`。
2. child 创建前计算 `effectiveTools = nodeCeiling ∩ profileAllowlist − spine.* − delegateTools`；profile 未声明 tools 时也不允许默认继承全部。
3. delegate 模块使用同样的进程内 `AgentSession` 和独立 `SessionManager` 模式；不得注册 `spine.*` 或 delegate tool，因此递归在能力层不可达，而不只是 prompt 禁止。
4. 未知 profile、未知工具或模型链全部耗尽时 fail-closed；不 fallback 到 general-purpose。
5. parent 只接收有长度上限的 receipt、summary 和 evidence refs；完整 transcript 独立保存，不进入 Spine node context。
6. 首版不增加 background UI、mentions、scheduling、worktree、长期角色 memory、resume/steer 或第二棵 orchestration tree。

其中 `pi-delegate` 只用于校准最小 tool surface，`@nerisma/pi-agents` 用于参考 profile 与 delegate 的分界，`pi-subagents-lite` 用于参考工具/模型 scoping。三者都不成为 Bonsai 的运行时依赖。

## 源码证据

### `nicobailon/pi-subagents`

检查版本：commit [`ee589b10dffeb2b13935b0e196097822a9e37b42`](https://github.com/nicobailon/pi-subagents/tree/ee589b10dffeb2b13935b0e196097822a9e37b42)，package `0.50.0`。

- Agent Markdown 与 child Pi process 定义：[`docs/agents.md#L1-L13`](https://github.com/nicobailon/pi-subagents/blob/ee589b10dffeb2b13935b0e196097822a9e37b42/docs/agents.md#L1-L13)
- 前台执行调用 `spawn(...)`：[`src/runs/foreground/execution.ts#L481-L493`](https://github.com/nicobailon/pi-subagents/blob/ee589b10dffeb2b13935b0e196097822a9e37b42/src/runs/foreground/execution.ts#L481-L493)
- 默认嵌套深度为 2 及 depth guard：[`src/shared/types.ts#L2124-L2127`](https://github.com/nicobailon/pi-subagents/blob/ee589b10dffeb2b13935b0e196097822a9e37b42/src/shared/types.ts#L2124-L2127)、[`src/shared/types.ts#L2166-L2205`](https://github.com/nicobailon/pi-subagents/blob/ee589b10dffeb2b13935b0e196097822a9e37b42/src/shared/types.ts#L2166-L2205)

### `@tintinweb/pi-subagents`

检查版本：commit [`929d2b680089ef8174ce2254884ff55e7889c3bf`](https://github.com/tintinweb/pi-subagents/tree/929d2b680089ef8174ce2254884ff55e7889c3bf)，package `0.17.0`。

- Profile frontmatter、transcript 和嵌套开关：[`README.md#L281-L311`](https://github.com/tintinweb/pi-subagents/blob/929d2b680089ef8174ce2254884ff55e7889c3bf/README.md#L281-L311)
- 嵌套默认关闭、默认 depth 2、可全局关闭：[`README.md#L315-L335`](https://github.com/tintinweb/pi-subagents/blob/929d2b680089ef8174ce2254884ff55e7889c3bf/README.md#L315-L335)
- 内置 profile 与工具/prompt 配置：[`src/default-agents.ts#L9-L40`](https://github.com/tintinweb/pi-subagents/blob/929d2b680089ef8174ce2254884ff55e7889c3bf/src/default-agents.ts#L9-L40)
- 本 package 自有 orchestration tools 的排除表：[`src/agent-runner.ts#L31-L44`](https://github.com/tintinweb/pi-subagents/blob/929d2b680089ef8174ce2254884ff55e7889c3bf/src/agent-runner.ts#L31-L44)
- Nested tools 仅在 profile 显式允许且未达到 depth cap 时注入：[`src/agent-runner.ts#L782-L809`](https://github.com/tintinweb/pi-subagents/blob/929d2b680089ef8174ce2254884ff55e7889c3bf/src/agent-runner.ts#L782-L809)
- Tool/extension live gating：[`src/agent-runner.ts#L811-L865`](https://github.com/tintinweb/pi-subagents/blob/929d2b680089ef8174ce2254884ff55e7889c3bf/src/agent-runner.ts#L811-L865)
- 独立 `SessionManager` 和进程内 `createAgentSession`：[`src/agent-runner.ts#L868-L921`](https://github.com/tintinweb/pi-subagents/blob/929d2b680089ef8174ce2254884ff55e7889c3bf/src/agent-runner.ts#L868-L921)
- Parent context 是跳过 tool results 的文本投影：[`src/context.ts#L15-L57`](https://github.com/tintinweb/pi-subagents/blob/929d2b680089ef8174ce2254884ff55e7889c3bf/src/context.ts#L15-L57)
- `AgentRecord.result` 是自由文本字符串：[`src/types.ts#L141-L167`](https://github.com/tintinweb/pi-subagents/blob/929d2b680089ef8174ce2254884ff55e7889c3bf/src/types.ts#L141-L167)
- 默认 fallback 为宽权限 `general-purpose`，可设 `none` 变为 fail-closed：[`README.md#L511-L526`](https://github.com/tintinweb/pi-subagents/blob/929d2b680089ef8174ce2254884ff55e7889c3bf/README.md#L511-L526)

## 新增候选源码证据

### `@bacnh85/pi-subagent`

检查版本：commit [`0d0395dea8f1e61cbe8aa3e428ed87e02cadd936`](https://github.com/bacnh85/pi-extensions/tree/0d0395dea8f1e61cbe8aa3e428ed87e02cadd936/pi-subagent)，package `0.15.2`。

- Markdown profile 的 tools、model chain、thinking、sandbox 和 system prompt 字段：[`extensions/agents.ts#L18-L34`](https://github.com/bacnh85/pi-extensions/blob/0d0395dea8f1e61cbe8aa3e428ed87e02cadd936/pi-subagent/extensions/agents.ts#L18-L34)、[`extensions/agents.ts#L162-L235`](https://github.com/bacnh85/pi-extensions/blob/0d0395dea8f1e61cbe8aa3e428ed87e02cadd936/pi-subagent/extensions/agents.ts#L162-L235)
- 进程内 `SessionManager.inMemory` 与 `createAgentSession`：[`extensions/runner.ts#L185-L247`](https://github.com/bacnh85/pi-extensions/blob/0d0395dea8f1e61cbe8aa3e428ed87e02cadd936/pi-subagent/extensions/runner.ts#L185-L247)
- child denylist 当前只有 `subagent`；工具会按 parent inventory 校验：[`extensions/security.ts#L33-L38`](https://github.com/bacnh85/pi-extensions/blob/0d0395dea8f1e61cbe8aa3e428ed87e02cadd936/pi-subagent/extensions/security.ts#L33-L38)、[`extensions/security.ts#L243-L328`](https://github.com/bacnh85/pi-extensions/blob/0d0395dea8f1e61cbe8aa3e428ed87e02cadd936/pi-subagent/extensions/security.ts#L243-L328)
- 未知 profile 与模型链耗尽均返回错误；并行结果有字节上限：[`extensions/index.ts#L723-L754`](https://github.com/bacnh85/pi-extensions/blob/0d0395dea8f1e61cbe8aa3e428ed87e02cadd936/pi-subagent/extensions/index.ts#L723-L754)、[`extensions/security.ts#L555-L566`](https://github.com/bacnh85/pi-extensions/blob/0d0395dea8f1e61cbe8aa3e428ed87e02cadd936/pi-subagent/extensions/security.ts#L555-L566)

### `@nerisma/pi-agents`

检查版本：commit [`eeaa7af0eb877d01fd7b72a65ba85dac7a0d261c`](https://github.com/sebastienservouze/pi-agents/tree/eeaa7af0eb877d01fd7b72a65ba85dac7a0d261c)，仓库 package `1.4.0`；pi.dev 扫描时显示 `1.3.2`。

- Markdown profile 解析 tools、skills、model、thinking、prompt 和 delegate：[`extensions/registry.ts#L210-L253`](https://github.com/sebastienservouze/pi-agents/blob/eeaa7af0eb877d01fd7b72a65ba85dac7a0d261c/extensions/registry.ts#L210-L253)
- child 使用进程内 session，并从 loader 排除 `pi-agents` 自身以阻止 runner 递归：[`extensions/runner.ts#L1-L13`](https://github.com/sebastienservouze/pi-agents/blob/eeaa7af0eb877d01fd7b72a65ba85dac7a0d261c/extensions/runner.ts#L1-L13)、[`extensions/runner.ts#L432-L472`](https://github.com/sebastienservouze/pi-agents/blob/eeaa7af0eb877d01fd7b72a65ba85dac7a0d261c/extensions/runner.ts#L432-L472)
- profile 未声明 tools 时会使用默认工具集；主 agent 的 profile 仍可声明 delegate：[`extensions/registry.ts#L344-L359`](https://github.com/sebastienservouze/pi-agents/blob/eeaa7af0eb877d01fd7b72a65ba85dac7a0d261c/extensions/registry.ts#L344-L359)
- runner 最终把累积 assistant output 作为自由文本结果：[`extensions/runner.ts#L505-L539`](https://github.com/sebastienservouze/pi-agents/blob/eeaa7af0eb877d01fd7b72a65ba85dac7a0d261c/extensions/runner.ts#L505-L539)

### `@router-for-me/pi-subagents-lite`

检查版本：commit [`4dccbe635ed9139361bad5dd1c1b505121f109a9`](https://github.com/luispater/pi-subagents-lite/tree/4dccbe635ed9139361bad5dd1c1b505121f109a9)，package `1.5.4`。

- Markdown profile 支持 tools/extensions/skills/model/thinking/turn 和 token limits：[`src/agents/agent-discovery.ts#L22-L40`](https://github.com/luispater/pi-subagents-lite/blob/4dccbe635ed9139361bad5dd1c1b505121f109a9/src/agents/agent-discovery.ts#L22-L40)
- 进程内 `SessionManager.inMemory`、模型 scope、工具和 thinking 配置：[`src/agents/agent-runner.ts#L547-L584`](https://github.com/luispater/pi-subagents-lite/blob/4dccbe635ed9139361bad5dd1c1b505121f109a9/src/agents/agent-runner.ts#L547-L584)
- 工具 allowlist 与 active parent tools 求交，但硬排除表只有 `Agent`；tools 缺省时继承全部 active tools：[`src/agents/agent-types.ts#L144-L145`](https://github.com/luispater/pi-subagents-lite/blob/4dccbe635ed9139361bad5dd1c1b505121f109a9/src/agents/agent-types.ts#L144-L145)、[`src/agents/agent-types.ts#L187-L267`](https://github.com/luispater/pi-subagents-lite/blob/4dccbe635ed9139361bad5dd1c1b505121f109a9/src/agents/agent-types.ts#L187-L267)
- parent 得到的是 `record.result` 自由文本与状态说明，不是统一 receipt：[`src/agents/tool-execution.ts#L108-L113`](https://github.com/luispater/pi-subagents-lite/blob/4dccbe635ed9139361bad5dd1c1b505121f109a9/src/agents/tool-execution.ts#L108-L113)、[`src/agents/tool-execution.ts#L222-L239`](https://github.com/luispater/pi-subagents-lite/blob/4dccbe635ed9139361bad5dd1c1b505121f109a9/src/agents/tool-execution.ts#L222-L239)

### `pi-delegate`

检查版本：commit [`a53d98a3818a68330c55da28a723d91d740cfaed`](https://codeberg.org/drsh4dow/pi-delegate/src/commit/a53d98a3818a68330c55da28a723d91d740cfaed)，package `0.6.0`。

- 单一 delegate tool 的参数、结果上限与完整输出保存策略：[`extensions/delegate.ts#L75-L146`](https://codeberg.org/drsh4dow/pi-delegate/src/commit/a53d98a3818a68330c55da28a723d91d740cfaed/extensions/delegate.ts#L75-L146)
- child denylist 是 `delegate`、`subagent`、`status`，不含 `spine.*`：[`extensions/delegate.ts#L63-L67`](https://codeberg.org/drsh4dow/pi-delegate/src/commit/a53d98a3818a68330c55da28a723d91d740cfaed/extensions/delegate.ts#L63-L67)
- child tools 从 parent inventory 过滤：[`extensions/delegate.ts#L153-L165`](https://codeberg.org/drsh4dow/pi-delegate/src/commit/a53d98a3818a68330c55da28a723d91d740cfaed/extensions/delegate.ts#L153-L165)
- `DefaultResourceLoader`、`SessionManager.inMemory`、进程内 `createAgentSession` 和 active tool 设置：[`extensions/delegate.ts#L400-L417`](https://codeberg.org/drsh4dow/pi-delegate/src/commit/a53d98a3818a68330c55da28a723d91d740cfaed/extensions/delegate.ts#L400-L417)
