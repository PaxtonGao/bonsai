import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { AgentSession } from "../agent-session.ts";
import {
	type AgentSessionServices,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "../agent-session-services.ts";
import { defineTool, type ToolDefinition } from "../extensions/types.ts";
import { SessionManager } from "../session-manager.ts";
import { SPAWN_RECEIPT_SCHEMA, type SpawnReceipt, type SpawnResult, type SpawnTask } from "./model.ts";
import { projectSpine } from "./projection.ts";
import { reduceSpine } from "./reducer.ts";
import { admitStructuralControl } from "./tools.ts";

export interface SpawnRuntime {
	parent: AgentSession;
	services: AgentSessionServices;
	getPreResponseContext: () => AgentMessage[];
}

const activeChildCounts = new WeakMap<AgentSession, number>();
const CHILD_TEARDOWN_DEADLINE_MS = 5_000;

function childSessionManager(runtime: SpawnRuntime): SessionManager {
	const options = runtime.parent.sessionFile ? { parentSession: runtime.parent.sessionFile } : undefined;
	return runtime.parent.sessionManager.isPersisted()
		? SessionManager.create(runtime.services.cwd, runtime.parent.sessionManager.getSessionDir(), options)
		: SessionManager.inMemory(runtime.services.cwd, options);
}

async function createChild(runtime: SpawnRuntime, prefix: AgentMessage[], systemPrompt: string) {
	const parent = runtime.parent;
	const activeToolNames = parent.getActiveToolNames().filter((name) => name !== "spine_spawn");
	const services = await createAgentSessionServices({
		cwd: runtime.services.cwd,
		agentDir: runtime.services.agentDir,
		modelRuntime: runtime.services.modelRuntime,
		settingsManager: runtime.services.settingsManager,
	});
	const childExtensionToolNames = new Set(
		services.resourceLoader.getExtensions().extensions.flatMap((extension) => [...extension.tools.keys()]),
	);
	const customTools = activeToolNames.flatMap((name) => {
		if (childExtensionToolNames.has(name)) return [];
		const definition = parent.getToolDefinition(name);
		return definition ? [definition] : [];
	});
	const sessionManager = childSessionManager(runtime);
	if (parent.model) sessionManager.appendModelChange(parent.model.provider, parent.model.id);
	sessionManager.appendThinkingLevelChange(parent.thinkingLevel);
	const { session } = await createAgentSessionFromServices({
		services,
		sessionManager,
		model: parent.model,
		thinkingLevel: parent.thinkingLevel,
		tools: activeToolNames,
		customTools,
		fixedSystemPrompt: systemPrompt,
		sessionStartEvent: { type: "session_start", reason: "startup" },
	});
	await session.bindExtensions({ mode: "print" });
	session.agent.state.messages = prefix.slice();
	session.agent.transformContext = async (messages) => {
		const entries = sessionManager.getBranch();
		return [...prefix, ...projectSpine(entries, reduceSpine(entries), messages.slice(prefix.length))];
	};
	return session;
}

function resultFromChild(session: AgentSession, ordinal: number, parentAborted: boolean): SpawnResult {
	let lastAssistant: AssistantMessage | undefined;
	for (let index = session.messages.length - 1; index >= 0; index--) {
		const message = session.messages[index];
		if (message?.role === "assistant") {
			lastAssistant = message;
			break;
		}
	}
	const text = session.getLastAssistantText();
	if (parentAborted || lastAssistant?.stopReason === "aborted") {
		const diagnostic = lastAssistant?.errorMessage?.trim() || "Child cancelled with parent";
		return {
			ordinal,
			outcome: "aborted",
			memory_body: text || diagnostic,
			diagnostic,
			execution_ref: session.sessionId,
		};
	}
	if (!lastAssistant || lastAssistant.stopReason === "error" || !text) {
		const diagnostic = lastAssistant?.errorMessage?.trim() || "Child produced no final memory";
		return {
			ordinal,
			outcome: "errored",
			memory_body: text || diagnostic,
			diagnostic,
			execution_ref: session.sessionId,
		};
	}
	return { ordinal, outcome: "completed", memory_body: text, execution_ref: session.sessionId };
}

async function promptChild(child: AgentSession, task: SpawnTask, signal: AbortSignal | undefined): Promise<void> {
	if (signal?.aborted) return;
	const prompt = child.prompt(task.prompt, { expandPromptTemplates: false, source: "extension" });
	if (!signal) {
		await prompt;
		return;
	}
	let timeout: ReturnType<typeof setTimeout> | undefined;
	let resolveDeadline: () => void = () => {};
	const deadline = new Promise<void>((resolve) => {
		resolveDeadline = resolve;
	});
	const startDeadline = () => {
		timeout = setTimeout(resolveDeadline, CHILD_TEARDOWN_DEADLINE_MS);
	};
	if (signal.aborted) startDeadline();
	else signal.addEventListener("abort", startDeadline, { once: true });
	try {
		await Promise.race([prompt, deadline]);
	} finally {
		if (timeout) clearTimeout(timeout);
		signal.removeEventListener("abort", startDeadline);
	}
}

async function runSpawn(
	runtime: SpawnRuntime,
	tasks: SpawnTask[],
	signal: AbortSignal | undefined,
): Promise<SpawnReceipt> {
	const active = activeChildCounts.get(runtime.parent) ?? 0;
	if (active + tasks.length > 4) throw new Error("spine.spawn capacity exceeded");
	activeChildCounts.set(runtime.parent, active + tasks.length);
	const children: AgentSession[] = [];
	let parentAborted = signal?.aborted ?? false;
	const abortChildren = () => {
		parentAborted = true;
		void Promise.allSettled(children.map((child) => child.abort()));
	};
	signal?.addEventListener("abort", abortChildren, { once: true });
	try {
		const prefix = runtime.getPreResponseContext();
		if (prefix.length === 0) throw new Error("spine.spawn has no pre-response context snapshot");
		const systemPrompt = runtime.parent.systemPrompt;
		try {
			for (const _task of tasks) {
				const child = await createChild(runtime, prefix, systemPrompt);
				children.push(child);
				if (parentAborted) await child.abort();
			}
		} catch (error) {
			for (const child of children) child.dispose();
			throw error;
		}
		try {
			await Promise.allSettled(
				children.map((child, ordinal) => promptChild(child, tasks[ordinal] ?? tasks[0]!, signal)),
			);
			return {
				schema: SPAWN_RECEIPT_SCHEMA,
				results: children.map((child, ordinal) => resultFromChild(child, ordinal, parentAborted)),
			};
		} finally {
			for (const child of children) child.dispose();
		}
	} finally {
		signal?.removeEventListener("abort", abortChildren);
		const remaining = (activeChildCounts.get(runtime.parent) ?? tasks.length) - tasks.length;
		if (remaining > 0) activeChildCounts.set(runtime.parent, remaining);
		else activeChildCounts.delete(runtime.parent);
	}
}

export function createSpineSpawnTool(getRuntime: () => SpawnRuntime | undefined): ToolDefinition {
	return defineTool({
		name: "spine_spawn",
		label: "Spawn tasks",
		description: "Run two to four independent child tasks concurrently and import their typed receipt.",
		promptSnippet: "Split independent work into in-process Bonsai child sessions.",
		parameters: Type.Object(
			{
				tasks: Type.Array(
					Type.Object(
						{ summary: Type.String({ minLength: 1 }), prompt: Type.String({ minLength: 1 }) },
						{ additionalProperties: false },
					),
					{ minItems: 2, maxItems: 4 },
				),
			},
			{ additionalProperties: false },
		),
		executionMode: "sequential",
		execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
			admitStructuralControl(ctx.sessionManager, "spine_spawn");
			const tasks = params.tasks.map((task) => ({ summary: task.summary.trim(), prompt: task.prompt.trim() }));
			if (tasks.some((task) => !task.summary || !task.prompt))
				throw new Error("spine.spawn tasks must be non-empty");
			if (new Set(tasks.map((task) => task.summary)).size !== tasks.length) {
				throw new Error("spine.spawn task summaries must be unique");
			}
			const runtime = getRuntime();
			if (!runtime) throw new Error("spine.spawn runtime is not bound");
			const receipt = await runSpawn(runtime, tasks, signal);
			return { content: [{ type: "text", text: JSON.stringify(receipt) }], details: receipt };
		},
	});
}
