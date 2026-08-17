# Bonsai Node Delegation SDD

> 状态：Deferred / Incubating
>
> 实施授权：无。本文不属于 Phase 1 SpineJIT/SpineSpawn 交付。

## 1. 目的

node-local delegate 是当前 Task Tree node 内部的上下文外包工具，例如 explorer 或 worker。它与 SpineSpawn 正交，不创建 Bonsai Task Tree 分支。

## 2. 已确认约束

- delegate 使用进程内 AgentSession。
- delegate 由预定义 profile 提供 system prompt、模型策略、工具和最大权限。
- delegate 可以使用较低成本模型，但不得低于 profile 的最低能力要求。
- delegate 不拥有任何 spine.* 工具。
- delegate 不允许再次调用 delegate。
- delegate 权限不得超过调用 node 的有效权限。
- 完整 transcript 保存在独立 session/trace。
- parent node 只接收 bounded receipt 和必要 evidence refs。
- delegate 的取消、超时和资源使用归属于调用 node。

## 3. 与 SpineSpawn 的区别

~~~text
SpineSpawn
  创建 Task Tree child
  parent 等待 typed batch receipt
  child 可以 open/close/next

Node delegate
  不改变 Task Tree
  只是当前 node 的工具调用
  禁止所有 spine.* 与递归 delegate
~~~

## 4. 进入 Review 前需要决定

- 首批 profiles 与最低模型能力。
- receipt schema 与大小上限。
- evidence reference 选择方式。
- profile 注册和用户配置。
- timeout、部分结果和模型升级语义。
- 与未来 context engine 的 receipt projection 规则。

## 5. 非目标

- 不在 Phase 1 创建 delegate tool、profile registry 或空实现。
- 不把 delegate transcript 自动注入 Task Tree。
- 不构建隐藏的递归 delegation graph。
