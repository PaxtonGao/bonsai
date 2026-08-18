import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Context, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { createDelegateTool } from "../../src/core/bonsai/delegate.ts";
import { ToolExecutionComponent } from "../../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

describe("Bonsai node delegation", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("renders a compact preview and expands the bounded receipt", () => {
		initTheme("dark");
		const receipt = {
			schema: "bonsai.delegate.result.v1" as const,
			profile: "explorer",
			outcome: "completed" as const,
			memory_body: "first\nsecond\nthird\nfourth",
			execution_ref: "child-1",
		};
		const component = new ToolExecutionComponent(
			"delegate",
			"delegate-render",
			{ profile: "explorer", task: "Inspect" },
			{},
			createDelegateTool(() => undefined),
			{ requestRender: () => {} } as unknown as TUI,
			process.cwd(),
		);
		component.updateResult({
			content: [{ type: "text", text: JSON.stringify(receipt) }],
			details: receipt,
			isError: false,
		});
		const collapsed = stripAnsi(component.render(120).join("\n"));
		expect(collapsed).toContain("Delegate finished · explorer · completed");
		expect(collapsed).not.toContain("fourth");
		component.setExpanded(true);
		expect(stripAnsi(component.render(120).join("\n"))).toContain("fourth");
	});

	it("runs a predefined in-process profile with bounded tools and fresh context", async () => {
		const harness = await createHarness({ models: [{ id: "faux-1", reasoning: true }] });
		harnesses.push(harness);
		writeFileSync(join(harness.tempDir, "AGENTS.md"), "delegate project rule marker");
		let childContext: Context | undefined;
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall(
					"delegate",
					{ profile: "explorer", task: "Inspect the parser without edits." },
					{ id: "delegate-1" },
				),
				{ stopReason: "toolUse" },
			),
			(context) => {
				childContext = context;
				return fauxAssistantMessage("Parser evidence");
			},
			fauxAssistantMessage("Parent synthesis"),
		]);

		await harness.session.prompt("Need isolated parser evidence");

		const result = harness.session.messages.find(
			(message) => message.role === "toolResult" && message.toolCallId === "delegate-1",
		);
		if (result?.role !== "toolResult") throw new Error("Missing delegate result");
		const receipt = JSON.parse(getMessageText(result)) as {
			schema: string;
			profile: string;
			outcome: string;
			memory_body: string;
			execution_ref: string;
		};
		expect(receipt).toMatchObject({
			schema: "bonsai.delegate.result.v1",
			profile: "explorer",
			outcome: "completed",
			memory_body: "Parser evidence",
		});
		expect(receipt.execution_ref).toBeTruthy();
		expect(childContext?.systemPrompt).toContain("Bonsai's explorer");
		expect(childContext?.systemPrompt).toContain("delegate project rule marker");
		expect(childContext?.systemPrompt).toContain("Tool guidance for this child");
		expect(childContext?.systemPrompt).toContain("Use read to examine files instead of cat or sed.");
		expect(childContext?.systemPrompt).not.toContain("You are a test assistant.");
		const childMessages = childContext?.messages.map(getMessageText) ?? [];
		expect(childMessages).toHaveLength(1);
		expect(childMessages[0]).toBe("Inspect the parser without edits.");
		expect(childMessages.join("\n")).not.toContain("Need isolated parser evidence");
		const childTools = childContext?.tools?.map((tool) => tool.name) ?? [];
		expect(childTools).toContain("read");
		expect(childTools.some((name) => name === "delegate" || name.startsWith("spine_"))).toBe(false);
	});

	it("truncates oversized child output at the profile byte limit", async () => {
		const harness = await createHarness({ models: [{ id: "faux-1", reasoning: true }] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall(
					"delegate",
					{ profile: "explorer", task: "Return bounded evidence." },
					{ id: "delegate-large" },
				),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("树".repeat(10_000)),
			fauxAssistantMessage("Parent resumed"),
		]);
		await harness.session.prompt("Bound this output");
		const result = harness.session.messages.find(
			(message) => message.role === "toolResult" && message.toolCallId === "delegate-large",
		);
		if (result?.role !== "toolResult") throw new Error("Missing delegate result");
		const receipt = JSON.parse(getMessageText(result)) as { memory_body: string; truncated?: boolean };
		expect(receipt.truncated).toBe(true);
		expect(Buffer.byteLength(receipt.memory_body, "utf8")).toBeLessThanOrEqual(12_000);
		expect(receipt.memory_body).toContain("[Output truncated]");
	});

	it("aborts a child at its execution deadline and returns an errored receipt", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", reasoning: true }],
			bonsaiDelegateExecutionDeadlineMs: 50,
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall(
					"delegate",
					{ profile: "worker", task: "Run the bounded verification command." },
					{ id: "delegate-timeout" },
				),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				fauxToolCall("bash", { command: 'node -e "setTimeout(() => {}, 10000)"' }, { id: "slow-command" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Parent resumed"),
		]);

		const run = harness.session.prompt("Verify with a deadline");
		const settled = await Promise.race([
			run.then(() => true),
			new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_000)),
		]);
		if (!settled) await harness.session.abort();
		expect(settled).toBe(true);
		const result = harness.session.messages.find(
			(message) => message.role === "toolResult" && message.toolCallId === "delegate-timeout",
		);
		if (result?.role !== "toolResult") throw new Error("Missing deadline receipt");
		const receipt = JSON.parse(getMessageText(result)) as { outcome: string; diagnostic?: string };
		expect(receipt.outcome).toBe("errored");
		expect(receipt.diagnostic).toContain("execution deadline");
	});
});
