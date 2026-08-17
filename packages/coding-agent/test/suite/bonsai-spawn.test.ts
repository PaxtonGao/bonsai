import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Context, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

describe("Bonsai SpineSpawn integration", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("runs ordered in-process children from one projected prefix without nested spawn", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", (event) => ({
						systemPrompt: `${event.systemPrompt}\nparent prompt marker`,
					}));
					pi.on("context", (event) => ({
						messages: [
							...event.messages,
							{
								role: "custom",
								customType: "parent-context-marker",
								content: "parent context marker",
								display: false,
								timestamp: Date.now(),
							},
						],
					}));
				},
			],
		});
		harnesses.push(harness);
		const extensionDir = join(harness.tempDir, ".pi", "extensions");
		const loadedMarker = join(harness.tempDir, "child-extension-loaded");
		mkdirSync(extensionDir, { recursive: true });
		writeFileSync(
			join(extensionDir, "reapply-markers.ts"),
			`import { writeFileSync } from "node:fs";
export default function reapplyMarkers(pi) {
	writeFileSync(${JSON.stringify(loadedMarker)}, "loaded");
	pi.on("before_agent_start", (event) => ({ systemPrompt: event.systemPrompt + "\\nparent prompt marker" }));
	pi.on("context", (event) => ({ messages: [...event.messages, {
		role: "custom", customType: "parent-context-marker", content: "parent context marker",
		display: false, timestamp: Date.now()
	}] }));
}
`,
		);
		const tasks = [
			{ summary: "alpha", prompt: "inspect alpha" },
			{ summary: "beta", prompt: "inspect beta" },
		];
		const prefixes: string[][] = [];
		const childTools: string[][] = [];
		const childSystemPrompts: string[] = [];
		let parentPrefix: string[] = [];
		let parentSystemPrompt = "";
		let parentContext = "";
		const childResponse = (context: Context) => {
			const texts = context.messages.map(getMessageText);
			if (!context.systemPrompt) throw new Error("Missing child system prompt");
			prefixes.push(texts.slice(0, -1));
			childTools.push(context.tools?.map((tool) => tool.name) ?? []);
			childSystemPrompts.push(context.systemPrompt);
			return texts.at(-1)?.includes("You are: beta")
				? fauxAssistantMessage("", { stopReason: "error", errorMessage: "beta failed" })
				: fauxAssistantMessage(`memory:${texts.at(-1)}`);
		};
		harness.setResponses([
			(context) => {
				if (!context.systemPrompt) throw new Error("Missing parent system prompt");
				parentSystemPrompt = context.systemPrompt;
				parentPrefix = context.messages.map(getMessageText);
				return fauxAssistantMessage(fauxToolCall("spine_spawn", { tasks }, { id: "spawn-1" }), {
					stopReason: "toolUse",
				});
			},
			childResponse,
			childResponse,
			(context) => {
				parentContext = context.messages.map(getMessageText).join("\n");
				return fauxAssistantMessage("parent resumed");
			},
		]);

		await harness.session.prompt("divide work");

		const result = harness.session.messages.find(
			(message) => message.role === "toolResult" && message.toolCallId === "spawn-1",
		);
		expect(result?.role).toBe("toolResult");
		if (result?.role !== "toolResult") throw new Error("Missing spine.spawn result");
		expect(result.isError).toBe(false);
		const receipt = JSON.parse(getMessageText(result)) as {
			schema: string;
			results: Array<{
				ordinal: number;
				outcome: string;
				memory_body: string;
				diagnostic?: string;
				execution_ref?: string;
			}>;
		};
		expect(receipt.schema).toBe("spine.spawn.result.v1");
		expect(receipt.results.map((entry) => entry.ordinal)).toEqual([0, 1]);
		expect(receipt.results[0]?.memory_body).toContain("inspect alpha");
		expect(receipt.results[0]?.memory_body).toContain("You are: alpha");
		expect(receipt.results[0]?.memory_body).not.toContain("Assignment:\ninspect beta");
		expect(receipt.results[1]).toMatchObject({ outcome: "errored", diagnostic: "beta failed" });
		expect(new Set(receipt.results.map((entry) => entry.execution_ref)).size).toBe(2);
		expect(prefixes).toHaveLength(2);
		expect(existsSync(loadedMarker)).toBe(true);
		expect(prefixes[0]).toEqual(prefixes[1]);
		expect(prefixes[0]).toEqual(parentPrefix);
		expect(prefixes[0]).toContain("parent context marker");
		expect(parentSystemPrompt).toContain("parent prompt marker");
		expect(childSystemPrompts).toEqual([parentSystemPrompt, parentSystemPrompt]);
		expect(childTools.every((names) => !names.includes("spine_spawn"))).toBe(true);
		expect(childTools.every((names) => names.includes("spine_close"))).toBe(true);
		expect(parentContext).toContain("<spine_spawn_evidence");
		expect(parentContext).not.toContain('"memory_body"');
	});

	it("propagates parent cancellation to every active child", async () => {
		let started = 0;
		let resolveStarted: (() => void) | undefined;
		const allStarted = new Promise<void>((resolve) => {
			resolveStarted = resolve;
		});
		const childSignals: AbortSignal[] = [];
		const waitTool: AgentTool = {
			name: "wait-child",
			label: "Wait child",
			description: "Block until cancelled",
			parameters: Type.Object({}),
			execute: async (_toolCallId, _params, signal) => {
				if (!signal) throw new Error("Missing child abort signal");
				childSignals.push(signal);
				started++;
				if (started === 2) resolveStarted?.();
				await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
				return { content: [{ type: "text", text: "cancelled" }], details: {} };
			},
		};
		const harness = await createHarness({ tools: [waitTool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall(
					"spine_spawn",
					{
						tasks: [
							{ summary: "one", prompt: "wait one" },
							{ summary: "two", prompt: "wait two" },
						],
					},
					{ id: "spawn-cancel" },
				),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxToolCall("wait-child", {}, { id: "wait" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("wait-child", {}, { id: "wait" }), { stopReason: "toolUse" }),
		]);

		const prompt = harness.session.prompt("start cancellable children");
		await allStarted;
		await harness.session.abort();
		await prompt;

		expect(childSignals).toHaveLength(2);
		expect(childSignals.every((signal) => signal.aborted)).toBe(true);
	});

	it("returns an errored receipt when a child exceeds its execution deadline", async () => {
		let resolveStarted: (() => void) | undefined;
		const waitStarted = new Promise<void>((resolve) => {
			resolveStarted = resolve;
		});
		const waitTool: AgentTool = {
			name: "wait-child",
			label: "Wait child",
			description: "Block until cancelled",
			parameters: Type.Object({}),
			execute: async (_toolCallId, _params, signal) => {
				if (!signal) throw new Error("Missing child abort signal");
				resolveStarted?.();
				await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
				return { content: [{ type: "text", text: "cancelled" }], details: {} };
			},
		};
		const harness = await createHarness({ bonsaiChildExecutionDeadlineMs: 100, tools: [waitTool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall(
					"spine_spawn",
					{
						tasks: [
							{ summary: "one", prompt: "wait one" },
							{ summary: "two", prompt: "wait two" },
						],
					},
					{ id: "spawn-timeout" },
				),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("first child complete"),
			fauxAssistantMessage(fauxToolCall("wait-child", {}, { id: "wait-two" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("parent resumed"),
		]);

		const prompt = harness.session.prompt("start deadline children");
		await waitStarted;
		const outcome = await Promise.race([
			prompt.then(() => "completed" as const),
			new Promise<"stuck">((resolve) => setTimeout(() => resolve("stuck"), 500)),
		]);
		if (outcome === "stuck") {
			await harness.session.abort();
			await prompt;
		}
		expect(outcome).toBe("completed");

		const result = harness.session.messages.find(
			(message) => message.role === "toolResult" && message.toolCallId === "spawn-timeout",
		);
		if (result?.role !== "toolResult") throw new Error("Missing timed out spine.spawn result");
		const receipt = JSON.parse(getMessageText(result)) as {
			results: Array<{ outcome: string; diagnostic?: string }>;
		};
		expect(receipt.results).toHaveLength(2);
		expect(receipt.results[0]?.outcome).toBe("completed");
		expect(receipt.results[1]).toMatchObject({ outcome: "errored" });
		expect(receipt.results[1]?.diagnostic).toContain("execution deadline");
	});

	it("rejects an oversized batch before starting any child", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall(
					"spine_spawn",
					{
						tasks: Array.from({ length: 5 }, (_, index) => ({
							summary: `task ${index}`,
							prompt: `run ${index}`,
						})),
					},
					{ id: "spawn-too-large" },
				),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("batch rejected"),
		]);

		await harness.session.prompt("spawn too much");

		const result = harness.session.messages.find(
			(message) => message.role === "toolResult" && message.toolCallId === "spawn-too-large",
		);
		expect(result?.role === "toolResult" && result.isError).toBe(true);
	});
});
