import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "../extensions/types.ts";
import { loadPromptTemplate } from "../prompt-template.ts";
import type { ReadonlySessionManager, SessionEntry } from "../session-manager.ts";
import { reduceSpine, validateTrimRequest } from "./reducer.ts";

const structuralNames = new Set(["spine_open", "spine_close", "spine_next", "spine_spawn"]);

function lastAssistant(entries: SessionEntry[]): AssistantMessage | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type === "message" && entry.message.role === "assistant") return entry.message;
	}
	return undefined;
}

export function admitStructuralControl(sessionManager: ReadonlySessionManager, expectedName: string): void {
	const entries = sessionManager.getBranch();
	const assistant = lastAssistant(entries);
	const controls =
		assistant?.content.flatMap((part) =>
			part.type === "toolCall" && structuralNames.has(part.name) ? [part] : [],
		) ?? [];
	if (controls.length !== 1 || controls[0]?.name !== expectedName) {
		throw new Error("A response may contain exactly one Bonsai structural control");
	}
	if ((expectedName === "spine_close" || expectedName === "spine_next") && reduceSpine(entries).cursor.length === 1) {
		throw new Error(`${expectedName} requires an open task node`);
	}
}

function success(message: string) {
	return { content: [{ type: "text" as const, text: message }], details: {} };
}

export function createSpineJitTools(): ToolDefinition[] {
	const nodeMemoryDescription = loadPromptTemplate("tools/fields/node-memory");
	const open = defineTool({
		name: "spine_open",
		label: "Open task",
		description: loadPromptTemplate("tools/spine-open-description"),
		promptSnippet: loadPromptTemplate("tools/spine-open"),
		parameters: Type.Object(
			{
				goal: Type.String({
					minLength: 1,
					description: loadPromptTemplate("tools/fields/open-goal"),
				}),
			},
			{ additionalProperties: false },
		),
		executionMode: "sequential",
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			if (!params.goal.trim()) throw new Error("spine.open requires a non-empty goal");
			admitStructuralControl(ctx.sessionManager, "spine_open");
			return success("Opened Bonsai task node");
		},
	});
	const close = defineTool({
		name: "spine_close",
		label: "Close task",
		description: loadPromptTemplate("tools/spine-close-description"),
		promptSnippet: loadPromptTemplate("tools/spine-close"),
		parameters: Type.Object(
			{ memory: Type.String({ minLength: 1, description: nodeMemoryDescription }) },
			{ additionalProperties: false },
		),
		executionMode: "sequential",
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			if (!params.memory.trim()) throw new Error("spine.close requires non-empty memory");
			admitStructuralControl(ctx.sessionManager, "spine_close");
			return success("Closed Bonsai task node");
		},
	});
	const next = defineTool({
		name: "spine_next",
		label: "Next task",
		description: loadPromptTemplate("tools/spine-next-description"),
		promptSnippet: loadPromptTemplate("tools/spine-next"),
		parameters: Type.Object(
			{
				goal: Type.String({
					minLength: 1,
					description: loadPromptTemplate("tools/fields/next-goal"),
				}),
				memory: Type.String({ minLength: 1, description: nodeMemoryDescription }),
			},
			{ additionalProperties: false },
		),
		executionMode: "sequential",
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			if (!params.goal.trim() || !params.memory.trim())
				throw new Error("spine.next requires non-empty goal and memory");
			admitStructuralControl(ctx.sessionManager, "spine_next");
			return success("Advanced to next Bonsai task node");
		},
	});
	const trim = defineTool({
		name: "spine_trim",
		label: "Trim result",
		description: loadPromptTemplate("tools/spine-trim-description"),
		promptSnippet: loadPromptTemplate("tools/spine-trim"),
		parameters: Type.Object(
			{
				TRIM_ID: Type.String({ minLength: 1, description: loadPromptTemplate("tools/fields/trim-id") }),
				op: Type.String({ enum: ["snip", "slice"], description: loadPromptTemplate("tools/fields/trim-op") }),
				head: Type.Optional(
					Type.Integer({ minimum: 0, description: loadPromptTemplate("tools/fields/trim-head") }),
				),
				tail: Type.Optional(
					Type.Integer({ minimum: 0, description: loadPromptTemplate("tools/fields/trim-tail") }),
				),
				anchor: Type.Optional(
					Type.String({ minLength: 1, description: loadPromptTemplate("tools/fields/trim-anchor") }),
				),
				preceding: Type.Optional(
					Type.Integer({ minimum: 0, description: loadPromptTemplate("tools/fields/trim-preceding") }),
				),
				following: Type.Optional(
					Type.Integer({ minimum: 0, description: loadPromptTemplate("tools/fields/trim-following") }),
				),
			},
			{ additionalProperties: false },
		),
		executionMode: "sequential",
		execute: async (toolCallId, params, _signal, _onUpdate, ctx) => {
			validateTrimRequest(ctx.sessionManager.getBranch(), toolCallId, params);
			return success("Trim accepted");
		},
	});
	return [open, close, next, trim];
}
