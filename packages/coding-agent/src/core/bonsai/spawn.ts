import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { AgentSession } from "../agent-session.ts";
import {
	type AgentSessionServices,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "../agent-session-services.ts";
import { defineTool, type ToolDefinition } from "../extensions/types.ts";
import { loadPromptTemplate, loadToolPromptDoc } from "../prompt-template.ts";
import {
	type AgentProfile,
	loadAgentProfile,
	resolveProfileModels,
	resolveProfileThinking,
	resolveProfileTools,
} from "./agent-profile.ts";
import { type BonsaiExecutionHandle, createBonsaiChildSessionManager, registerBonsaiExecution } from "./executions.ts";
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
	return loadPromptTemplate("agents/spine-child", {
		BONSAI_TASK_SUMMARY: task.summary,
		BONSAI_PEER_TASKS: tasks
			.filter((peer) => peer !== task)
			.map((peer) => `- ${peer.summary}`)
			.join("\n"),
		BONSAI_TASK_PROMPT: task.prompt,
	});
}

async function createChild(
	runtime: SpawnRuntime,
	prefix: AgentMessage[],
	profile: AgentProfile,
	systemPrompt: string,
	model: Model<any>,
) {
	const parent = runtime.parent;
	const activeToolNames = resolveProfileTools(profile, parent.getActiveToolNames());
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
	const sessionManager = createBonsaiChildSessionManager(runtime.parent.sessionManager, runtime.services.cwd);
	const level = resolveProfileThinking(profile, parent.thinkingLevel, model);
	sessionManager.appendModelChange(model.provider, model.id);
	sessionManager.appendThinkingLevelChange(level);
	const { session } = await createAgentSessionFromServices({
		services,
		sessionManager,
		model,
		thinkingLevel: level,
		tools: activeToolNames,
		customTools,
		fixedSystemPrompt: systemPrompt,
		sessionStartEvent: { type: "session_start", reason: "startup" },
	});
	try {
		await session.bindExtensions({ mode: "print" });
		session.agent.state.messages = prefix.slice();
		session.agent.transformContext = async (messages) => {
			const entries = sessionManager.getBranch();
			return [...prefix, ...projectSpine(entries, reduceSpine(entries), messages)];
		};
		return session;
	} catch (error) {
		session.dispose();
		throw error;
	}
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
	signal: AbortSignal | undefined,
	executionDeadlineMs: number,
): Promise<"settled" | "timed_out"> {
	if (signal?.aborted) return "settled";
	const prompt = child.prompt(task.prompt, { expandPromptTemplates: false, source: "extension" });
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

function childHasOutputOrToolCall(child: AgentSession, inheritedMessageCount: number): boolean {
	return child.messages
		.slice(inheritedMessageCount)
		.some(
			(message) =>
				message?.role === "assistant" &&
				message.content.some(
					(part) => (part.type === "text" && Boolean(part.text.trim())) || part.type === "toolCall",
				),
		);
}

async function runSpawn(
	runtime: SpawnRuntime,
	tasks: SpawnTask[],
	operationId: string,
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
		const profile = loadAgentProfile("spine-child", "spine-child");
		const executionDeadlineMs = runtime.childExecutionDeadlineMs ?? profile.deadlineMs ?? CHILD_EXECUTION_DEADLINE_MS;
		const models = resolveProfileModels(profile, runtime.parent.model, runtime.services.modelRuntime);
		if (models.length === 0) throw new Error("spine-child profile has no available model");
		let lastError: unknown;
		for (let modelIndex = 0; modelIndex < models.length; modelIndex++) {
			const model = models[modelIndex]!;
			const executionHandles: BonsaiExecutionHandle[] = [];
			try {
				const nodeId = reduceSpine(runtime.parent.sessionManager.getBranch()).cursor;
				for (let ordinal = 0; ordinal < tasks.length; ordinal++) {
					const task = tasks[ordinal]!;
					const child = await createChild(runtime, prefix, profile, taskEnvelope(task, tasks), model);
					children.push(child);
					executionHandles.push(
						registerBonsaiExecution(runtime.parent, child, {
							operationId,
							kind: "spine_spawn",
							label: task.summary,
							nodeId,
							profile: profile.name,
							ordinal,
						}),
					);
					if (parentAborted) await child.abort();
				}
				const outcomes = await Promise.allSettled(
					children.map((child, ordinal) =>
						promptChild(child, tasks[ordinal] ?? tasks[0]!, signal, executionDeadlineMs),
					),
				);
				const receipt: SpawnReceipt = {
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
				for (let ordinal = 0; ordinal < receipt.results.length; ordinal++) {
					executionHandles[ordinal]?.finish(receipt.results[ordinal]!.outcome);
				}
				const canRetry =
					modelIndex + 1 < models.length &&
					!parentAborted &&
					receipt.results.every((result) => result.outcome === "errored") &&
					children.every((child) => !childHasOutputOrToolCall(child, prefix.length));
				if (!canRetry) return receipt;
			} catch (error) {
				lastError = error;
				for (const handle of executionHandles) handle.finish(parentAborted ? "aborted" : "errored");
				if (modelIndex + 1 === models.length) throw error;
			} finally {
				for (const child of children) child.dispose();
				children.length = 0;
			}
		}
		throw lastError instanceof Error ? lastError : new Error("spine-child model candidates exhausted");
	} finally {
		signal?.removeEventListener("abort", abortChildren);
		const remaining = (activeChildCounts.get(runtime.parent) ?? tasks.length) - tasks.length;
		if (remaining > 0) activeChildCounts.set(runtime.parent, remaining);
		else activeChildCounts.delete(runtime.parent);
	}
}

export function createSpineSpawnTool(getRuntime: () => SpawnRuntime | undefined): ToolDefinition {
	const prompt = loadToolPromptDoc("tools/spine/spawn");
	return defineTool({
		name: "spine_spawn",
		label: "Spawn tasks",
		description: prompt.brief,
		promptSnippet: prompt.brief,
		promptGuidelines: [prompt.guidance],
		parameters: Type.Object(
			{
				tasks: Type.Array(
					Type.Object(
						{
							summary: Type.String({ minLength: 1 }),
							prompt: Type.String({ minLength: 1 }),
						},
						{ additionalProperties: false },
					),
					{
						minItems: 2,
						maxItems: 4,
					},
				),
			},
			{ additionalProperties: false },
		),
		executionMode: "sequential",
		execute: async (toolCallId, params, signal, _onUpdate, ctx) => {
			admitStructuralControl(ctx.sessionManager, "spine_spawn");
			const tasks = params.tasks.map((task) => ({ summary: task.summary.trim(), prompt: task.prompt.trim() }));
			if (tasks.some((task) => !task.summary || !task.prompt))
				throw new Error("spine.spawn tasks must be non-empty");
			if (new Set(tasks.map((task) => task.summary)).size !== tasks.length) {
				throw new Error("spine.spawn task summaries must be unique");
			}
			const runtime = getRuntime();
			if (!runtime) throw new Error("spine.spawn runtime is not bound");
			const receipt = await runSpawn(runtime, tasks, toolCallId, signal);
			return { content: [{ type: "text", text: JSON.stringify(receipt) }], details: receipt };
		},
		renderResult: (result, _options, theme, context) => {
			const receipt = result.details as SpawnReceipt | undefined;
			if (!receipt) {
				const content = result.content[0];
				return new Text(content?.type === "text" ? content.text : "", 0, 0);
			}
			const tasks = (context.args as { tasks: SpawnTask[] }).tasks;
			const lines = [theme.fg("toolTitle", theme.bold(`Spawn finished (${receipt.results.length} branches)`))];
			for (const branch of receipt.results) {
				const color =
					branch.outcome === "completed" ? "success" : branch.outcome === "errored" ? "error" : "warning";
				const summary = tasks[branch.ordinal]?.summary ?? `branch ${branch.ordinal + 1}`;
				lines.push(theme.fg(color, `[${branch.outcome}] ${branch.ordinal + 1}. ${summary}`));
			}
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
