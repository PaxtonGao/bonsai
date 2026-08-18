import { describe, expect, it } from "vitest";
import { createSpineSpawnTool } from "../../src/core/bonsai/spawn.ts";
import { createSpineJitTools } from "../../src/core/bonsai/tools.ts";

describe("Bonsai tool guidance", () => {
	it("exposes the Spine contracts to the model", () => {
		const tools = createSpineJitTools();
		const open = tools.find((tool) => tool.name === "spine_open");
		const close = tools.find((tool) => tool.name === "spine_close");
		const trim = tools.find((tool) => tool.name === "spine_trim");
		const spawn = createSpineSpawnTool(() => undefined);

		expect(open?.description).toContain("independently completable goal");
		expect(open?.promptSnippet).toContain("context ownership");
		expect(open?.parameters).toMatchObject({
			properties: { goal: { description: expect.stringContaining("direct child") } },
		});
		expect(close?.parameters).toMatchObject({
			properties: {
				memory: {
					description: expect.stringMatching(/continuation state.*validation results.*remaining work/),
				},
			},
		});
		expect(trim?.parameters).toMatchObject({
			properties: {
				TRIM_ID: { description: expect.stringMatching(/immediately previous.*expires/) },
			},
		});
		expect(spawn.description).toMatch(/at most once.*independent.*ownership/i);
		expect(spawn.promptSnippet).toMatch(/child sessions cannot call spine_spawn/i);
		expect(spawn.parameters).toMatchObject({
			properties: {
				tasks: {
					description: expect.stringContaining("Ordered differentiated branch assignments"),
					items: {
						properties: {
							summary: { description: expect.stringContaining("branch label") },
							prompt: { description: expect.stringContaining("Complete initial branch assignment") },
						},
					},
				},
			},
		});
	});
});
