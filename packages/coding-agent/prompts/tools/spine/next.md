<!-- brief -->

Close the current task and enter its next sibling atomically.

<!-- guidance -->

Use `spine_next` when the current node is ready to finalize and the next work belongs to a true sibling under the same parent. `memory` belongs to the finalized node; `goal` belongs to the new sibling.

Valid input:

```json
{"memory":"Reducer responsibilities confirmed in reducer.ts; three focused tests pass.","goal":"Inspect child AgentSession restrictions"}
```

Give the sibling one concrete, independently completable goal. Preserve all continuation-relevant finalized-node state in memory. To return to a higher ancestor, use `spine_close` one level at a time instead. The response may contain exactly one Bonsai structural control. Ordinary tool calls issued with `spine_next` belong to the sibling; the transition applies to the finalized node's prior ReAct history.
