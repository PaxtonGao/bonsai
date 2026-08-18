<!-- brief -->

Close the current task with durable memory and return to its parent.

<!-- guidance -->

Use `spine_close` only when the current node's result is stable or precisely bounded and later work no longer needs its full local working context. Root epochs cannot be closed. Close one level at a time when returning to a higher ancestor.

Valid input:

```json
{"memory":"Implemented parser in src/parser.ts; focused parser tests pass. Remaining: run npm run check."}
```

Memory replaces the finalized node's local working context. Preserve only continuation-relevant completed work, confirmed findings, decisions and constraints, validation results, bounded unresolved gaps or risks, remaining work, and the logic linking evidence to decisions and next steps. Include precise file references and decisive command results when later work would otherwise need to reconstruct them. Runtime preserves user messages and child memories independently. Use existing `[U#]` anchors only to bind approvals, corrections, rejections, clarifications, or elliptical replies to their referents; do not restate the preserved user messages. The response may contain exactly one Bonsai structural control; co-issued ordinary tools belong to the parent.
