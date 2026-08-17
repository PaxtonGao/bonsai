import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { reduceSpine } from "../../src/core/bonsai/reducer.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

describe("Bonsai SpineJIT integration", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("registers the SpineJIT tools on a normal AgentSession", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const toolNames = harness.session.getActiveToolNames();

		expect(toolNames).toEqual(expect.arrayContaining(["spine_open", "spine_close", "spine_next", "spine_trim"]));
		expect(toolNames.filter((name) => name.startsWith("spine_"))).toEqual(
			expect.arrayContaining(["spine_open", "spine_close", "spine_next", "spine_trim", "spine_spawn"]),
		);
		expect(toolNames.every((name) => /^[a-zA-Z0-9_-]+$/.test(name))).toBe(true);
	});

	it("projects a closed child to user evidence and node memory before the next provider request", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let closedContext = "";
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("spine_open", { goal: "inspect" }, { id: "open-1" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("private working detail"),
			fauxAssistantMessage(fauxToolCall("spine_close", { memory: "inspection complete" }, { id: "close-1" }), {
				stopReason: "toolUse",
			}),
			(context) => {
				closedContext = context.messages.map(getMessageText).join("\n");
				return fauxAssistantMessage("root resumed");
			},
		]);

		await harness.session.prompt("start");
		await harness.session.prompt("finish child");

		expect(closedContext).toContain("finish child");
		expect(closedContext).toContain('<spine_memory node_id="1.1">\ninspection complete\n</spine_memory>');
		expect(closedContext).not.toContain("private working detail");
		expect(closedContext).not.toContain("open-1");
	});

	it("snips only the oversized result identified by the adjacent TRIM_ID", async () => {
		const oversized = "x".repeat(10_001);
		const bigTool: AgentTool = {
			name: "big",
			label: "Big",
			description: "Return an oversized result",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: oversized }], details: {} }),
		};
		const harness = await createHarness({ tools: [bigTool] });
		harnesses.push(harness);
		let trimId = "";
		let finalContext = "";
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("big", {}, { id: "big-1" }), { stopReason: "toolUse" }),
			(context) => {
				const text = context.messages.map(getMessageText).join("\n");
				trimId = text.match(/\[TRIM_ID: (trim_\d+)\]/)?.[1] ?? "";
				return fauxAssistantMessage("oversized result observed");
			},
			() =>
				fauxAssistantMessage(fauxToolCall("spine_trim", { TRIM_ID: trimId, op: "snip" }, { id: "trim-1" }), {
					stopReason: "toolUse",
				}),
			(context) => {
				finalContext = context.messages.map(getMessageText).join("\n");
				return fauxAssistantMessage("trimmed");
			},
		]);

		await harness.session.prompt("get large output");
		await harness.session.prompt("trim it");

		expect(trimId).toMatch(/^trim_\d+$/);
		expect(finalContext).toContain("[Old tool result content cleared]");
		expect(finalContext).not.toContain(oversized);
	});

	it("returns Error for every structural control in an ambiguous assistant response", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("spine_open", { goal: "one" }, { id: "open-a" }),
					fauxToolCall("spine_open", { goal: "two" }, { id: "open-b" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("controls rejected"),
		]);

		await harness.session.prompt("open twice");

		const results = harness.session.messages.filter((message) => message.role === "toolResult");
		expect(results).toHaveLength(2);
		expect(results.every((message) => message.isError)).toBe(true);
		expect(reduceSpine(harness.sessionManager.getBranch()).nodes.map((node) => node.id)).toEqual([[1]]);
	});
});
