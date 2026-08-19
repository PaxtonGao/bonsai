import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { projectBonsaiExecutionTree } from "../src/core/bonsai/execution-tree.ts";
import type { BonsaiExecutionSnapshot } from "../src/core/bonsai/executions.ts";
import { SessionManager } from "../src/core/session-manager.ts";

function appendResult(session: SessionManager, callId: string, toolName: string, value: unknown): void {
	session.appendMessage({
		role: "toolResult",
		toolCallId: callId,
		toolName,
		content: [{ type: "text", text: JSON.stringify(value) }],
		isError: false,
		timestamp: Date.now(),
	});
}

describe("Bonsai execution tree projection", () => {
	it("groups spawn children and attaches delegates to their owning Spine node", () => {
		const session = SessionManager.inMemory();
		session.appendMessage(
			fauxAssistantMessage(fauxToolCall("spine_open", { goal: "inspect parser" }, { id: "open-1" }), {
				stopReason: "toolUse",
			}),
		);
		appendResult(session, "open-1", "spine_open", "ok");
		session.appendMessage(
			fauxAssistantMessage(
				fauxToolCall("delegate", { profile: "explorer", task: "map parser" }, { id: "delegate-1" }),
				{ stopReason: "toolUse" },
			),
		);
		appendResult(session, "delegate-1", "delegate", {
			schema: "bonsai.delegate.result.v1",
			profile: "explorer",
			outcome: "completed",
			memory_body: "mapped",
			execution_ref: "delegate-child",
		});
		const tasks = [
			{ summary: "alpha", prompt: "inspect alpha" },
			{ summary: "beta", prompt: "inspect beta" },
		];
		session.appendMessage(
			fauxAssistantMessage(fauxToolCall("spine_spawn", { tasks }, { id: "spawn-1" }), {
				stopReason: "toolUse",
			}),
		);
		appendResult(session, "spawn-1", "spine_spawn", {
			schema: "spine.spawn.result.v1",
			results: [
				{ ordinal: 0, outcome: "completed", memory_body: "a", execution_ref: "spawn-a" },
				{ ordinal: 1, outcome: "errored", memory_body: "b", diagnostic: "failed", execution_ref: "spawn-b" },
			],
		});

		const tree = projectBonsaiExecutionTree(session.getBranch());
		expect(tree).toMatchObject({
			kind: "root",
			label: "Main Session",
			children: [
				{
					kind: "spine",
					label: "inspect parser",
					nodeId: [1, 1],
					children: [
						{ kind: "execution", executionRef: "delegate-child", label: "explorer: map parser" },
						{
							kind: "operation",
							operationId: "spawn-1",
							children: [
								{ executionRef: "spawn-a", status: "completed" },
								{ executionRef: "spawn-b", status: "errored" },
							],
						},
					],
				},
			],
		});
	});

	it("adds live executions before their receipts exist", () => {
		const runtime: BonsaiExecutionSnapshot[] = [
			{
				executionRef: "live-child",
				operationId: "delegate-live",
				kind: "delegate",
				label: "inspect runtime",
				nodeId: [1],
				status: "running",
				startedAt: 10,
				profile: "explorer",
				toolCalls: 2,
			},
		];

		expect(projectBonsaiExecutionTree([], runtime).children).toMatchObject([
			{
				kind: "execution",
				executionRef: "live-child",
				status: "running",
				label: "explorer: inspect runtime",
			},
		]);
	});
});
