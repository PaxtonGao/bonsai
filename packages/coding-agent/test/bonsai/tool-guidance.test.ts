import { describe, expect, it } from "vitest";
import { createSpineSpawnTool } from "../../src/core/bonsai/spawn.ts";
import { createSpineJitTools } from "../../src/core/bonsai/tools.ts";
import { loadToolPromptDoc } from "../../src/core/prompt-template.ts";
import { buildSystemPrompt } from "../../src/core/system-prompt.ts";

describe("Bonsai tool guidance", () => {
	it("loads brief and guidance from one tool document", () => {
		const prompt = loadToolPromptDoc("tools/spine/open");

		expect(prompt.brief).toBe("Open and enter a focused direct child task.");
		expect(prompt.guidance).toContain('{"goal":"Inspect reducer behavior"}');
	});

	it("injects each enabled Spine tool brief and guidance", () => {
		const tools = createSpineJitTools();
		const open = tools.find((tool) => tool.name === "spine_open");
		const close = tools.find((tool) => tool.name === "spine_close");
		const next = tools.find((tool) => tool.name === "spine_next");
		const trim = tools.find((tool) => tool.name === "spine_trim");
		const spawn = createSpineSpawnTool(() => undefined);

		for (const tool of [open, close, next, trim, spawn]) {
			expect(tool?.promptSnippet).toBe(tool?.description);
			expect(tool?.promptGuidelines).toHaveLength(1);
		}
		expect(open?.promptGuidelines?.[0]).toContain('{"goal":"Inspect reducer behavior"}');
		expect(close?.promptGuidelines?.[0]).toContain(
			'{"memory":"Implemented parser in src/parser.ts; focused parser tests pass. Remaining: run npm run check."}',
		);
		expect(next?.promptGuidelines?.[0]).toContain(
			'{"memory":"Reducer responsibilities confirmed in reducer.ts; three focused tests pass.","goal":"Inspect child AgentSession restrictions"}',
		);
		expect(trim?.promptGuidelines?.[0]).toContain('{"TRIM_ID":"trim_12","op":"snip"}');
		expect(trim?.promptGuidelines?.[0]).toContain('{"TRIM_ID":"trim_27","op":"slice","head":800}');
		expect(trim?.promptGuidelines?.[0]).toContain('{"TRIM_ID":"trim_28","op":"slice","tail":600}');
		expect(trim?.promptGuidelines?.[0]).toContain(
			'{"TRIM_ID":"trim_31","op":"slice","anchor":"Error: connection refused","preceding":3,"following":8}',
		);
		expect(spawn.promptGuidelines?.[0]).toMatch(/child sessions cannot call `?spine_spawn`?/i);
		expect(spawn.promptGuidelines?.[0]).toMatch(/at most once.*unique.*input order.*synthesizes/is);
		expect(spawn.promptGuidelines?.[0]).toMatch(/must not depend on another branch's result/i);
		expect(spawn.parameters).toMatchObject({
			properties: {
				tasks: {
					items: {
						properties: {
							summary: { minLength: 1 },
							prompt: { minLength: 1 },
						},
					},
				},
			},
		});
	});

	it("renders the enabled Spine brief and full guidance into the system prompt", () => {
		const open = createSpineJitTools().find((tool) => tool.name === "spine_open");
		expect(open).toBeDefined();

		const systemPrompt = buildSystemPrompt({
			cwd: "/workspace",
			selectedTools: [open!.name],
			toolSnippets: { [open!.name]: open!.promptSnippet! },
			promptGuidelines: open!.promptGuidelines,
		});

		expect(systemPrompt).toContain("- spine_open: Open and enter a focused direct child task.");
		expect(systemPrompt).toContain('{"goal":"Inspect reducer behavior"}');
	});
});
