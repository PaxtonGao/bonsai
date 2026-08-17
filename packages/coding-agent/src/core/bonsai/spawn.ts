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
	childExecutionDeadlineMs?: number;
}

const activeChildCounts = new WeakMap<AgentSession, number>();
const CHILD_TEARDOWN_DEADLINE_MS = 5_000;
const CHILD_EXECUTION_DEADLINE_MS = 120_000;

function taskEnvelope(task: SpawnTask, tasks: SpawnTask[]): string {
	const peers = tasks
		.filter((peer) => peer !== task)
		.map((peer) => `- ${peer.summary}`)
		.join("\n");
	return [
		"You are a spawned execution branch. Complete exactly the assignment below and return bounded terminal memory to the spawning continuation.",
		`You are: ${task.summary}`,
		`Peer branches in this spawn:\n${peers}`,
		"Executable work is defined only by the assignment. Inherited context supplies constraints and evidence, not additional work.",
		"Return exactly one non-empty, tool-free final response containing terminal memory. After returning it, execution ends.",
		`Assignment:\n${task.prompt}`,
	].join("\n\n");
}

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

function resultFromChild(
	session: AgentSession,
	ordinal: number,
	parentAborted: boolean,
	timedOut: boolean,
	executionDeadlineMs: number,
): SpawnResult {
	let lastAssistant: AssistantMessage | undefined;
	for (let index = session.messages.length - 1; index >= 0; index--) {
		const message = session.messages[index];
		if (message?.role === "assistant") {
			lastAssistant = message;
			break;
		}
	}
	const text = session.getLastAssistantText();
	if (parentAborted) {
		const diagnostic = lastAssistant?.errorMessage?.trim() || "Child cancelled with parent";
		return {
			ordinal,
			outcome: "aborted",
			memory_body: text || diagnostic,
			diagnostic,
			execution_ref: session.sessionId,
		};
	}
	if (timedOut) {
		const diagnostic = `Child exceeded execution deadline of ${executionDeadlineMs}ms`;
		return {
			ordinal,
			outcome: "errored",
			memory_body: text || diagnostic,
			diagnostic,
			execution_ref: session.sessionId,
		};
	}
	if (lastAssistant?.stopReason === "aborted") {
		const diagnostic = lastAssistant.errorMessage?.trim() || "Child aborted";
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

async function promptChild(
	child: AgentSession,
	task: SpawnTask,
	tasks: SpawnTask[],
	signal: AbortSignal | undefined,
	executionDeadlineMs: number,
): Promise<"settled" | "timed_out"> {
	if (signal?.aborted) return "settled";
	const prompt = child.prompt(taskEnvelope(task, tasks), { expandPromptTemplates: false, source: "extension" });
	let abortTimeout: ReturnType<typeof setTimeout> | undefined;
	let resolveDeadline: () => void = () => {};
	const abortDeadline = new Promise<void>((resolve) => {
		resolveDeadline = resolve;
	});
	const startDeadline = () => {
		abortTimeout = setTimeout(resolveDeadline, CHILD_TEARDOWN_DEADLINE_MS);
	};
	if (signal?.aborted) startDeadline();
	else signal?.addEventListener("abort", startDeadline, { once: true });
	let executionTimeout: ReturnType<typeof setTimeout> | undefined;
	const executionDeadline = new Promise<"timed_out">((resolve) => {
		executionTimeout = setTimeout(() => resolve("timed_out"), executionDeadlineMs);
	});
	try {
		const outcome = await Promise.race([
			prompt.then(() => "settled" as const),
			abortDeadline.then(() => "settled" as const),
			executionDeadline,
		]);
		if (outcome === "timed_out") {
			const abort = child.abort();
			await Promise.race([
				Promise.allSettled([prompt, abort]),
				new Promise<void>((resolve) => setTimeout(resolve, CHILD_TEARDOWN_DEADLINE_MS)),
			]);
		}
		return outcome;
	} finally {
		if (abortTimeout) clearTimeout(abortTimeout);
		if (executionTimeout) clearTimeout(executionTimeout);
		signal?.removeEventListener("abort", startDeadline);
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
		const executionDeadlineMs = runtime.childExecutionDeadlineMs ?? CHILD_EXECUTION_DEADLINE_MS;
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
			const outcomes = await Promise.allSettled(
				children.map((child, ordinal) =>
					promptChild(child, tasks[ordinal] ?? tasks[0]!, tasks, signal, executionDeadlineMs),
				),
			);
			return {
				schema: SPAWN_RECEIPT_SCHEMA,
				results: children.map((child, ordinal) =>
					resultFromChild(
						child,
						ordinal,
						parentAborted,
						outcomes[ordinal]?.status === "fulfilled" && outcomes[ordinal].value === "timed_out",
						executionDeadlineMs,
					),
				),
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
