import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { clampThinkingLevel } from "@earendil-works/pi-ai/compat";
import { getPackageDir } from "../../config.ts";
import { parseFrontmatter } from "../../utils/frontmatter.ts";
import type { ModelRuntime } from "../model-runtime.ts";

export type AgentProfileKind = "main" | "spine-child" | "delegate";
export type AgentThinking = "inherit" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface AgentProfile {
	name: string;
	kind: AgentProfileKind;
	description: string;
	model: "inherit" | string[];
	thinking: AgentThinking;
	tools: "inherit" | string[];
	deadlineMs?: number;
	resultMaxBytes?: number;
	prompt: string;
}

const PROFILE_FIELDS = new Set([
	"name",
	"kind",
	"description",
	"model",
	"thinking",
	"tools",
	"deadline_ms",
	"result_max_bytes",
]);
const PROFILE_KINDS = new Set<AgentProfileKind>(["main", "spine-child", "delegate"]);
const THINKING_LEVELS = new Set<AgentThinking>(["inherit", "off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const DELEGATION_TOOLS = new Set(["agent", "delegate", "spawn_agent", "subagent", "subagent_status", "task"]);

function requiredString(frontmatter: Record<string, unknown>, field: string): string {
	const value = frontmatter[field];
	if (typeof value !== "string" || !value.trim()) throw new Error(`Agent profile ${field} must be a non-empty string`);
	return value.trim();
}

function stringList(value: unknown, field: string): string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
		throw new Error(`Agent profile ${field} must be a non-empty string array`);
	}
	const values = value.map((item) => (item as string).trim());
	if (values.length === 0) throw new Error(`Agent profile ${field} must not be empty`);
	if (new Set(values).size !== values.length)
		throw new Error(`Agent profile ${field} contains a duplicate tool or value`);
	return values;
}

function optionalInteger(frontmatter: Record<string, unknown>, field: string): number | undefined {
	const value = frontmatter[field];
	if (value === undefined) return undefined;
	if (!Number.isInteger(value) || (value as number) <= 0)
		throw new Error(`Agent profile ${field} must be a positive integer`);
	return value as number;
}

export function parseAgentProfile(content: string, expectedName: string, expectedKind: AgentProfileKind): AgentProfile {
	const { frontmatter, body } = parseFrontmatter(content);
	for (const field of Object.keys(frontmatter)) {
		if (!PROFILE_FIELDS.has(field)) throw new Error(`Agent profile contains unknown field "${field}"`);
	}

	const name = requiredString(frontmatter, "name");
	if (name !== expectedName) throw new Error(`Agent profile name "${name}" does not match "${expectedName}"`);
	const kind = requiredString(frontmatter, "kind");
	if (!PROFILE_KINDS.has(kind as AgentProfileKind) || kind !== expectedKind) {
		throw new Error(`Agent profile kind "${kind}" does not match "${expectedKind}"`);
	}
	const description = requiredString(frontmatter, "description");
	if (!body.trim()) throw new Error("Agent profile prompt body must be non-empty");

	const rawModel = frontmatter.model ?? "inherit";
	const model = rawModel === "inherit" ? "inherit" : stringList(rawModel, "model");
	if (model !== "inherit" && model.includes("inherit") && model.at(-1) !== "inherit") {
		throw new Error('Agent profile model candidate "inherit" must be last');
	}

	const thinking = frontmatter.thinking ?? "inherit";
	if (typeof thinking !== "string" || !THINKING_LEVELS.has(thinking as AgentThinking)) {
		throw new Error(`Agent profile thinking is invalid: ${String(thinking)}`);
	}

	const rawTools = frontmatter.tools;
	if (rawTools === undefined) throw new Error("Agent profile tools is required");
	if (expectedKind === "delegate" && rawTools === "inherit") throw new Error("Delegate profile cannot inherit tools");
	const tools = rawTools === "inherit" ? "inherit" : stringList(rawTools, "tools");

	const configuredDeadline = optionalInteger(frontmatter, "deadline_ms");
	if (expectedKind === "main" && configuredDeadline !== undefined)
		throw new Error("Main profile cannot set deadline_ms");
	if (configuredDeadline !== undefined && configuredDeadline > 1_200_000) {
		throw new Error("Agent profile deadline_ms exceeds 1200000");
	}
	const resultMaxBytes = optionalInteger(frontmatter, "result_max_bytes");
	if (expectedKind !== "delegate" && resultMaxBytes !== undefined) {
		throw new Error(`${expectedKind} profile cannot set result_max_bytes`);
	}
	if (resultMaxBytes !== undefined && (resultMaxBytes < 1_024 || resultMaxBytes > 32_768)) {
		throw new Error("Agent profile result_max_bytes must be between 1024 and 32768");
	}

	return {
		name,
		kind: expectedKind,
		description,
		model,
		thinking: thinking as AgentThinking,
		tools,
		deadlineMs: expectedKind === "main" ? undefined : (configuredDeadline ?? 120_000),
		resultMaxBytes: expectedKind === "delegate" ? (resultMaxBytes ?? 12_000) : undefined,
		prompt: body.trim(),
	};
}

export function loadAgentProfile(name: string, expectedKind: AgentProfileKind): AgentProfile {
	if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) throw new Error(`Invalid agent profile name "${name}"`);
	const relative =
		expectedKind === "delegate" ? join("agents", "delegates", `${name}.md`) : join("agents", `${name}.md`);
	const content = readFileSync(join(getPackageDir(), "prompts", relative), "utf8");
	return parseAgentProfile(content, name, expectedKind);
}

export function resolveProfileModels(
	profile: AgentProfile,
	parentModel: Model<any> | undefined,
	modelRuntime: ModelRuntime,
): Model<any>[] {
	const candidates = profile.model === "inherit" ? ["inherit"] : profile.model;
	const available = new Set(modelRuntime.getAvailableSnapshot().map((model) => `${model.provider}/${model.id}`));
	const resolved: Model<any>[] = [];
	for (const candidate of candidates) {
		const inherited = candidate === "inherit";
		const slash = candidate.indexOf("/");
		const model = inherited
			? parentModel
			: slash > 0
				? modelRuntime.getModel(candidate.slice(0, slash), candidate.slice(slash + 1))
				: undefined;
		if (!model || (!inherited && !available.has(`${model.provider}/${model.id}`))) continue;
		if (!resolved.some((entry) => entry.provider === model.provider && entry.id === model.id)) resolved.push(model);
	}
	return resolved;
}

export function resolveProfileThinking(
	profile: AgentProfile,
	parentThinking: ThinkingLevel,
	model: Model<any>,
): ThinkingLevel {
	const requested = profile.thinking === "inherit" ? parentThinking : profile.thinking;
	const effective = clampThinkingLevel(model, requested) as ThinkingLevel;
	if (profile.thinking !== "inherit" && effective !== requested) {
		throw new Error(`Model ${model.provider}/${model.id} does not support thinking level ${requested}`);
	}
	return effective;
}

function isHardDenied(kind: AgentProfileKind, tool: string): boolean {
	if (kind === "main") return false;
	const normalized = tool.toLowerCase();
	if (DELEGATION_TOOLS.has(normalized)) return true;
	if (kind === "spine-child") return normalized === "spine_spawn";
	return normalized.startsWith("spine_");
}

export function resolveProfileTools(
	profile: AgentProfile,
	parentEffectiveTools: readonly string[],
	runtimeAvailableTools: readonly string[] = parentEffectiveTools,
): string[] {
	if (profile.tools !== "inherit") {
		const denied = profile.tools.find((tool) => isHardDenied(profile.kind, tool));
		if (denied) throw new Error(`Agent profile requests hard-denied tool "${denied}"`);
	}
	const requested = profile.tools === "inherit" ? parentEffectiveTools : profile.tools;
	const parent = new Set(parentEffectiveTools);
	const available = new Set(runtimeAvailableTools);
	if (profile.tools !== "inherit") {
		const unavailable = profile.tools.find((tool) => !parent.has(tool) || !available.has(tool));
		if (unavailable) throw new Error(`Agent profile requests unavailable tool "${unavailable}"`);
	}
	return requested.filter((tool) => parent.has(tool) && available.has(tool) && !isHardDenied(profile.kind, tool));
}
