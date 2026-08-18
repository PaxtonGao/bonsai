<!-- brief -->

Run one narrow task in a fresh, predefined Bonsai agent profile and return only its bounded result.

<!-- guidance -->

Use `delegate` when a narrow explorer, reviewer, or worker can keep noisy work out of the current node. The child does not create a Spine branch and cannot call `delegate` or any `spine_*` tool. The parent remains responsible for synthesis and the final answer.

Valid inputs:

```json
{"profile":"explorer","task":"Read the reducer implementation and report its three responsibilities with exact file and symbol evidence. Do not edit files."}
```

```json
{"profile":"worker","task":"Implement the accepted parser change only, preserve unrelated edits, and run the focused parser test. Return changed files and verification."}
```

Choose `explorer` for read-only code mapping, `reviewer` for an independent review, and `worker` only when the parent explicitly authorizes edits. Give one self-contained task with scope, permissions, expected output, and verification. Do not use delegate for trivial work or to simulate `spine_spawn` parallel branches.
