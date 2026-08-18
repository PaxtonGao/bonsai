import { getModel } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import {
	loadAgentProfile,
	parseAgentProfile,
	resolveProfileThinking,
	resolveProfileTools,
} from "../../src/core/bonsai/agent-profile.ts";

describe("Bonsai Agent Profiles", () => {
	it("loads main, SpineSpawn child, and bundled delegate profiles", () => {
		const main = loadAgentProfile("main", "main");
		const spineChild = loadAgentProfile("spine-child", "spine-child");
		const explorer = loadAgentProfile("explorer", "delegate");

		expect(main).toMatchObject({ name: "main", kind: "main", tools: "inherit" });
		expect(spineChild).toMatchObject({
			name: "spine-child",
			kind: "spine-child",
			deadlineMs: 120_000,
		});
		expect(explorer).toMatchObject({
			name: "explorer",
			kind: "delegate",
			thinking: "low",
			tools: ["read", "grep", "find", "ls"],
			resultMaxBytes: 12_000,
		});
		expect(main.prompt).toContain("You are Bonsai");
		expect(main.prompt).not.toContain("kind: main");
	});

	it("rejects malformed, mismatched, and unknown profile fields", () => {
		const valid = `---
name: explorer
kind: delegate
description: Inspect code
model: inherit
thinking: low
tools: [read]
---
Inspect only.`;

		expect(() => parseAgentProfile(valid.replace("kind: delegate", "kind: main"), "explorer", "delegate")).toThrow(
			"kind",
		);
		expect(() => parseAgentProfile(valid.replace("tools: [read]", "tools: inherit"), "explorer", "delegate")).toThrow(
			"cannot inherit tools",
		);
		expect(() =>
			parseAgentProfile(valid.replace("tools: [read]", "tools: [read, read]"), "explorer", "delegate"),
		).toThrow("duplicate tool");
		expect(() =>
			parseAgentProfile(valid.replace("thinking: low", "thinking: low\nunknown: true"), "explorer", "delegate"),
		).toThrow("unknown field");
		expect(() => loadAgentProfile("../main", "delegate")).toThrow("Invalid agent profile name");
	});

	it("computes effective child tools without permitting delegation or Spine escalation", () => {
		const explorer = loadAgentProfile("explorer", "delegate");
		expect(
			resolveProfileTools(explorer, ["read", "grep", "find", "ls", "spine_open", "spine_spawn", "delegate"]),
		).toEqual(["read", "grep", "find", "ls"]);
		expect(() => resolveProfileTools(explorer, ["read", "grep", "find"])).toThrow("unavailable tool");

		const malicious = parseAgentProfile(
			`---
name: malicious
kind: delegate
description: Invalid permissions
tools: [read, spine_open, spine_spawn, delegate]
---
Try to escalate.`,
			"malicious",
			"delegate",
		);
		expect(() => resolveProfileTools(malicious, ["read", "spine_open", "spine_spawn", "delegate"])).toThrow(
			"hard-denied",
		);
		const alias = parseAgentProfile(
			`---
name: alias
kind: delegate
description: Alias escalation
tools: [read, spawn_agent]
---
Try an alias.`,
			"alias",
			"delegate",
		);
		expect(() => resolveProfileTools(alias, ["read", "spawn_agent"])).toThrow("hard-denied");
	});

	it("routes an unsupported child thinking preference without exceeding the parent", () => {
		const profile = parseAgentProfile(
			`---
name: reviewer
kind: delegate
description: Review code
thinking: medium
tools: [read]
---
Review only.`,
			"reviewer",
			"delegate",
		);
		const model = getModel("deepseek", "deepseek-v4-flash");
		if (!model) throw new Error("Missing DeepSeek regression model");

		expect(resolveProfileThinking(profile, "medium", model)).toBe("low");
		expect(resolveProfileThinking(profile, "low", model)).toBe("low");
	});
});
