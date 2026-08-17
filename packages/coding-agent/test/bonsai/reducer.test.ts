import { fauxAssistantMessage, fauxToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { projectSpine } from "../../src/core/bonsai/projection.ts";
import { reduceSpine, validateTrimRequest } from "../../src/core/bonsai/reducer.ts";
import { convertToLlm } from "../../src/core/messages.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

function appendControl(
	session: SessionManager,
	name: "spine.open" | "spine.close" | "spine.next",
	input: Record<string, string>,
	callId: string,
): void {
	session.appendMessage(fauxAssistantMessage(fauxToolCall(name, input, { id: callId }), { stopReason: "toolUse" }));
	const result: ToolResultMessage = {
		role: "toolResult",
		toolCallId: callId,
		toolName: name,
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp: Date.now(),
	};
	session.appendMessage(result);
}

function messageText(message: { content: string | Array<{ type: string; text?: string }> }): string {
	return typeof message.content === "string"
		? message.content
		: message.content.flatMap((part) => (part.type === "text" ? [part.text ?? ""] : [])).join("\n");
}

describe("Bonsai Spine reducer", () => {
	it("closes a child deterministically and projects only user evidence plus node memory", () => {
		const session = SessionManager.inMemory();
		session.appendMessage({ role: "user", content: "root request", timestamp: 1 });
		appendControl(session, "spine.open", { goal: "inspect subsystem" }, "open-1");
		session.appendMessage({ role: "user", content: "child evidence", timestamp: 2 });
		session.appendMessage(fauxAssistantMessage("private working detail"));
		appendControl(session, "spine.close", { memory: "inspection complete" }, "close-1");

		const entries = session.getBranch();
		const first = reduceSpine(entries);
		const second = reduceSpine(entries);

		expect(second).toEqual(first);
		expect(first.cursor).toEqual([1]);
		expect(first.nodes.map((node) => ({ id: node.id, status: node.status }))).toEqual([
			{ id: [1], status: "live" },
			{ id: [1, 1], status: "closed" },
		]);

		const projected = convertToLlm(projectSpine(entries, first, session.buildSessionContext().messages));
		const text = projected.map((message) => messageText(message)).join("\n");
		expect(text).toContain("[U1]\nroot request");
		expect(text).toContain("[U2]\nchild evidence");
		expect(text).toContain('<spine_memory node_id="1.1">\ninspection complete\n</spine_memory>');
		expect(text).not.toContain("private working detail");
	});

	it("starts a new deterministic root epoch from pi compaction replacement", () => {
		const session = SessionManager.inMemory();
		session.appendMessage({ role: "user", content: "old request", timestamp: 1 });
		session.appendMessage(fauxAssistantMessage("old answer"));
		const firstKeptEntryId = session.appendMessage({ role: "user", content: "kept request", timestamp: 2 });
		session.appendCompaction("compact baseline", firstKeptEntryId, 100);
		appendControl(session, "spine.open", { goal: "post-compact task" }, "open-2");

		const entries = session.getBranch();
		const snapshot = reduceSpine(entries);
		expect(snapshot.epoch).toBe(2);
		expect(snapshot.cursor).toEqual([2, 1]);
		expect(snapshot.nodes.map((node) => node.id)).toEqual([[1], [2], [2, 1]]);

		const text = convertToLlm(projectSpine(entries, snapshot, session.buildSessionContext().messages))
			.map((message) => messageText(message))
			.join("\n");
		expect(text).toContain("compact baseline");
		expect(text).toContain("kept request");
		expect(text).not.toContain("old answer");
	});

	it("atomically imports a valid spawn receipt as ordered closed children", () => {
		const session = SessionManager.inMemory();
		const tasks = [
			{ summary: "alpha", prompt: "inspect alpha" },
			{ summary: "beta", prompt: "inspect beta" },
		];
		session.appendMessage(
			fauxAssistantMessage(fauxToolCall("spine.spawn", { tasks }, { id: "spawn-1" }), { stopReason: "toolUse" }),
		);
		const receipt = {
			schema: "spine.spawn.result.v1",
			results: [
				{ ordinal: 0, outcome: "completed", memory_body: "alpha done", execution_ref: "child-a" },
				{ ordinal: 1, outcome: "errored", memory_body: "beta failed", diagnostic: "failure" },
			],
		};
		session.appendMessage({
			role: "toolResult",
			toolCallId: "spawn-1",
			toolName: "spine.spawn",
			content: [{ type: "text", text: JSON.stringify(receipt) }],
			isError: false,
			timestamp: 2,
		});

		const snapshot = reduceSpine(session.getBranch());
		expect(snapshot.cursor).toEqual([1]);
		expect(snapshot.nodes.map((node) => ({ id: node.id, status: node.status, goal: node.goal }))).toEqual([
			{ id: [1], status: "live", goal: "root" },
			{ id: [1, 1], status: "closed", goal: "alpha" },
			{ id: [1, 2], status: "closed", goal: "beta" },
		]);
	});

	it("treats a malformed spawn receipt as a whole-batch tree no-op", () => {
		const session = SessionManager.inMemory();
		const tasks = [
			{ summary: "alpha", prompt: "inspect alpha" },
			{ summary: "beta", prompt: "inspect beta" },
		];
		session.appendMessage(
			fauxAssistantMessage(fauxToolCall("spine.spawn", { tasks }, { id: "spawn-bad" }), {
				stopReason: "toolUse",
			}),
		);
		session.appendMessage({
			role: "toolResult",
			toolCallId: "spawn-bad",
			toolName: "spine.spawn",
			content: [
				{
					type: "text",
					text: JSON.stringify({
						schema: "spine.spawn.result.v1",
						results: [{ ordinal: 0, outcome: "completed", memory_body: "only one" }],
					}),
				},
			],
			isError: false,
			timestamp: 2,
		});

		expect(reduceSpine(session.getBranch()).nodes.map((node) => node.id)).toEqual([[1]]);
	});

	it("rejects oversized or duplicate spawn tasks during replay", () => {
		for (const tasks of [
			Array.from({ length: 5 }, (_, index) => ({ summary: `task ${index}`, prompt: `run ${index}` })),
			[
				{ summary: "same", prompt: "first" },
				{ summary: " same ", prompt: "second" },
			],
		]) {
			const session = SessionManager.inMemory();
			session.appendMessage(
				fauxAssistantMessage(fauxToolCall("spine.spawn", { tasks }, { id: "spawn-invalid-tasks" }), {
					stopReason: "toolUse",
				}),
			);
			session.appendMessage({
				role: "toolResult",
				toolCallId: "spawn-invalid-tasks",
				toolName: "spine.spawn",
				content: [
					{
						type: "text",
						text: JSON.stringify({
							schema: "spine.spawn.result.v1",
							results: tasks.map((_, ordinal) => ({ ordinal, outcome: "completed", memory_body: "done" })),
						}),
					},
				],
				isError: false,
				timestamp: 2,
			});

			expect(reduceSpine(session.getBranch()).nodes.map((node) => node.id)).toEqual([[1]]);
		}
	});

	it("keeps mismatched or duplicate tool results as ordinary history", () => {
		for (const toolNames of [["spine.close"], ["spine.open", "spine.open"]]) {
			const session = SessionManager.inMemory();
			session.appendMessage(
				fauxAssistantMessage(fauxToolCall("spine.open", { goal: "must not open" }, { id: "invalid-pair" }), {
					stopReason: "toolUse",
				}),
			);
			for (const toolName of toolNames) {
				session.appendMessage({
					role: "toolResult",
					toolCallId: "invalid-pair",
					toolName,
					content: [{ type: "text", text: "invalid pair" }],
					isError: false,
					timestamp: 2,
				});
			}

			expect(reduceSpine(session.getBranch()).nodes.map((node) => node.id)).toEqual([[1]]);
		}
	});

	it("rejects trim identities from an incomplete previous tool group", () => {
		const session = SessionManager.inMemory();
		session.appendMessage(
			fauxAssistantMessage(
				[fauxToolCall("big", {}, { id: "big-complete" }), fauxToolCall("missing", {}, { id: "missing-result" })],
				{ stopReason: "toolUse" },
			),
		);
		session.appendMessage({
			role: "toolResult",
			toolCallId: "big-complete",
			toolName: "big",
			content: [{ type: "text", text: "x".repeat(10_001) }],
			isError: false,
			timestamp: 2,
		});

		expect(() => validateTrimRequest(session.getBranch(), "future-trim", { TRIM_ID: "trim_1", op: "snip" })).toThrow(
			"previous completed toolcall",
		);
		session.appendMessage(
			fauxAssistantMessage(fauxToolCall("spine.trim", { TRIM_ID: "trim_1", op: "snip" }, { id: "forged-trim" }), {
				stopReason: "toolUse",
			}),
		);
		session.appendMessage({
			role: "toolResult",
			toolCallId: "forged-trim",
			toolName: "spine.trim",
			content: [{ type: "text", text: "accepted" }],
			isError: false,
			timestamp: 3,
		});
		expect(reduceSpine(session.getBranch()).trimEdits).toEqual([]);
	});

	it("closes the current task and enters its sibling atomically on next", () => {
		const session = SessionManager.inMemory();
		appendControl(session, "spine.open", { goal: "first" }, "open-next");
		session.appendMessage({ role: "user", content: "first evidence", timestamp: 1 });
		appendControl(session, "spine.next", { goal: "second", memory: "first done" }, "next-1");

		const snapshot = reduceSpine(session.getBranch());
		expect(snapshot.cursor).toEqual([1, 2]);
		expect(snapshot.nodes.map((node) => ({ id: node.id, status: node.status }))).toEqual([
			{ id: [1], status: "opened" },
			{ id: [1, 1], status: "closed" },
			{ id: [1, 2], status: "live" },
		]);
	});

	it("keeps an incomplete control group as ordinary history without changing the tree", () => {
		const session = SessionManager.inMemory();
		session.appendMessage(
			fauxAssistantMessage(fauxToolCall("spine.open", { goal: "incomplete" }, { id: "open-incomplete" }), {
				stopReason: "toolUse",
			}),
		);

		const snapshot = reduceSpine(session.getBranch());
		expect(snapshot.cursor).toEqual([1]);
		expect(snapshot.nodes.map((node) => node.id)).toEqual([[1]]);
		expect(snapshot.visibleContext).toHaveLength(1);
	});

	it("treats mixed successful and failed structural controls as ambiguous", () => {
		const session = SessionManager.inMemory();
		session.appendMessage(
			fauxAssistantMessage(
				[
					fauxToolCall("spine.open", { goal: "must not open" }, { id: "open-mixed" }),
					fauxToolCall("spine.close", { memory: "must not close" }, { id: "close-mixed" }),
				],
				{ stopReason: "toolUse" },
			),
		);
		for (const [toolCallId, toolName, isError] of [
			["open-mixed", "spine.open", false],
			["close-mixed", "spine.close", true],
		] as const) {
			session.appendMessage({
				role: "toolResult",
				toolCallId,
				toolName,
				content: [{ type: "text", text: isError ? "failed" : "ok" }],
				isError,
				timestamp: 2,
			});
		}

		expect(reduceSpine(session.getBranch()).nodes.map((node) => node.id)).toEqual([[1]]);
	});
});
