<!-- brief -->

Trim one oversized result from the immediately previous tool batch.

<!-- guidance -->

Use `spine_trim` only on a tagged result in the immediately previous completed tool batch. A `TRIM_ID` expires after the next assistant tool request; after an expired or rejected id, do not retry it. Example ids and sizes below demonstrate structure only: use the id and evidence range from the current result.

Remove the whole visible body only after useful facts are preserved elsewhere:

```json
{"TRIM_ID":"trim_12","op":"snip"}
```

Keep characters from exactly one end:

```json
{"TRIM_ID":"trim_27","op":"slice","head":800}
```

```json
{"TRIM_ID":"trim_28","op":"slice","tail":600}
```

Keep complete lines around a non-empty anchor:

```json
{"TRIM_ID":"trim_31","op":"slice","anchor":"Error: connection refused","preceding":3,"following":8}
```

For `slice`, choose exactly one shape: `head`, `tail`, or `anchor` together with both `preceding` and `following`. Do not mix shapes. Prefer the smallest slice that preserves continuation-relevant evidence; otherwise leave the result unchanged. `spine_trim` changes only the visible tool-result projection, not the Bonsai tree or memory.
