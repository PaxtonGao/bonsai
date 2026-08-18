<!-- brief -->

Run two to four independent child tasks concurrently and import their ordered results.

<!-- guidance -->

Use `spine_spawn` only when at least two substantial, self-contained branches gain materially from concurrency. Call it at most once in one model response and place every ready branch in the same ordered `tasks` array.

Valid input:

```json
{"tasks":[{"summary":"Reducer responsibilities","prompt":"Read reducer.ts and return its three main responsibilities with file evidence."},{"summary":"Child session limits","prompt":"Read spawn.ts and return three child AgentSession restrictions with file evidence."}]}
```

Branches start from the current full history. Give every branch a unique concise `summary`. Each `prompt` must define a distinct scope, evidence boundary, completion predicate, and bounded fallback. Tasks must not depend on another branch's result, and every branch must return one terminal memory. Results are imported in input order after every branch settles; the parent then evaluates and synthesizes them in that order.

Child sessions cannot call `spine_spawn`. The parent is suspended while children run, so it cannot supervise them. If branches require coordination, create a task-local shared blackboard first and repeat the same `Shared blackboard: <path>` line in every prompt. Shared-workspace effects are non-transactional: production-file writes require disjoint ownership or one explicitly named integration owner. Do not create paraphrased branches over one tightly coupled question unless they are independent replication or falsification.
