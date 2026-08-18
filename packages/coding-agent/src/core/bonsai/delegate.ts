import { basename } from "node:path";
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
import { SessionManager } from "../session-manager.ts";
import { buildSystemPrompt } from "../system-prompt.ts";
import {
	type AgentProfile,
	loadAgentProfile,
	resolveProfileModels,
	resolveProfileThinking,
	resolveProfileTools,
} from "./agent-profile.ts";
import { DELEGATE_RECEIPT_SCHEMA, type DelegateReceipt } from "./model.ts";

export interface DelegateRuntime {
	parent: AgentSession;
	services: AgentSessionServices;
	childExecutionDeadlineMs?: number;
}

const CHILD_TEARDOWN_DEADLINE_MS = 5_000;

function childSessionManager(runtime: DelegateRuntime): SessionManager {
	const options = runtime.parent.sessionFile ? { parentSession: runtime.parent.sessionFile } : undefined;
	return runtime.parent.sessionManager.isPersisted()
		? SessionManager.create(runtime.services.cwd, runtime.parent.sessionManager.getSessionDir(), options)
		: SessionManager.inMemory(runtime.services.cwd, options);
}

async function createChild(runtime: DelegateRuntime, profile: AgentProfile, model: Model<any>): Promise<AgentSession> {
	const parent = runtime.parent;
	const permittedToolNames = parent
		.getAllTools()
		.filter((tool) => tool.sourceInfo.source === "builtin")
		.map((tool) => tool.name);
	const activeToolNames = resolveProfileTools(profile, permittedToolNames);
	const services = await createAgentSessionServices({
		cwd: runtime.services.cwd,
		agentDir: runtime.services.agentDir,
		modelRuntime: runtime.services.modelRuntime,
		settingsManager: runtime.services.settingsManager,
		resourceLoaderOptions: {
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: false,
		},
	});
	const sessionManager = childSessionManager(runtime);
	const level = resolveProfileThinking(profile, parent.thinkingLevel, model);
	const toolGuidance = Array.from(
		new Set(
			activeToolNames
				.flatMap((name) => parent.getToolDefinition(name)?.promptGuidelines ?? [])
				.map((guideline) => guideline.trim())
				.filter(Boolean),
		),
	).join("\n\n");
	const systemPrompt = buildSystemPrompt({
		customPrompt: profile.prompt,
		cwd: services.cwd,
		contextFiles: services.resourceLoader
			.getAgentsFiles()
			.agentsFiles.filter((file) => /^AGENTS(?:\.override)?\.md$/i.test(basename(file.path))),
		skills: [],
		appendSystemPrompt: loadPromptTemplate("internal/delegate-runtime", {
			BONSAI_DELEGATE_TOOL_GUIDANCE: toolGuidance || "No additional tool guidance.",
		}),
	});
	sessionManager.appendModelChange(model.provider, model.id);
	sessionManager.appendThinkingLevelChange(level);
	const { session } = await createAgentSessionFromServices({
		services,
		sessionManager,
		model,
		thinkingLevel: level,
		tools: activeToolNames,
		fixedSystemPrompt: systemPrompt,
		sessionStartEvent: { type: "session_start", reason: "startup" },
	});
	try {
		await session.bindExtensions({ mode: "print" });
		session.agent.transformContext = async (messages) => messages;
		return session;
	} catch (error) {
		session.dispose();
		throw error;
	}
}

function lastAssistant(session: AgentSession): AssistantMessage | undefined {
	for (let index = session.messages.length - 1; index >= 0; index--) {
		const message = session.messages[index];
		if (message?.role === "assistant") return message;
	}
	return undefined;
}

function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, truncated: false };
	const marker = "\n\n[Output truncated]";
	const budget = maxBytes - Buffer.byteLength(marker, "utf8");
	let bytes = 0;
	let output = "";
	for (const character of text) {
		const size = Buffer.byteLength(character, "utf8");
		if (bytes + size > budget) break;
		output += character;
		bytes += size;
	}
	return { text: `${output}${marker}`, truncated: true };
}

async function promptChild(
	child: AgentSession,
	task: string,
	signal: AbortSignal | undefined,
	deadlineMs: number,
): Promise<{ timedOut: boolean; parentAborted: boolean }> {
	let timedOut = false;
	let parentAborted = signal?.aborted ?? false;
	let abortTimeout: ReturnType<typeof setTimeout> | undefined;
	let resolveAbortDeadline: () => void = () => {};
	const abortDeadline = new Promise<void>((resolve) => {
		resolveAbortDeadline = resolve;
	});
	const abortChild = () => {
		parentAborted = true;
		void child.abort().then(resolveAbortDeadline, resolveAbortDeadline);
		abortTimeout ??= setTimeout(resolveAbortDeadline, CHILD_TEARDOWN_DEADLINE_MS);
	};
	if (parentAborted) {
		abortChild();
		await abortDeadline;
		return { timedOut, parentAborted };
	}
	signal?.addEventListener("abort", abortChild, { once: true });
	const prompt = child.prompt(task, { expandPromptTemplates: false, source: "extension" });
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<void>((resolve) => {
		timeout = setTimeout(() => {
			timedOut = true;
			void child.abort();
			resolve();
		}, deadlineMs);
	});
	try {
		await Promise.race([prompt, deadline, abortDeadline]);
		if (timedOut) {
			await Promise.race([
				Promise.allSettled([prompt]),
				new Promise<void>((resolve) => setTimeout(resolve, CHILD_TEARDOWN_DEADLINE_MS)),
			]);
		}
		return { timedOut, parentAborted };
	} finally {
		if (abortTimeout) clearTimeout(abortTimeout);
		if (timeout) clearTimeout(timeout);
		signal?.removeEventListener("abort", abortChild);
	}
}

function receiptFromChild(
	profile: AgentProfile,
	child: AgentSession,
	state: { timedOut: boolean; parentAborted: boolean },
): DelegateReceipt {
	const assistant = lastAssistant(child);
	const text = child.getLastAssistantText()?.trim() ?? "";
	let outcome: DelegateReceipt["outcome"] = "completed";
	let diagnostic: string | undefined;
	if (state.parentAborted) {
		outcome = "aborted";
		diagnostic = assistant?.errorMessage?.trim() || "Delegate cancelled with parent";
	} else if (state.timedOut) {
		outcome = "errored";
		diagnostic = `Delegate exceeded execution deadline of ${profile.deadlineMs}ms`;
	} else if (assistant?.stopReason === "aborted") {
		outcome = "aborted";
		diagnostic = assistant.errorMessage?.trim() || "Delegate aborted";
	} else if (!assistant || assistant.stopReason === "error" || !text) {
		outcome = "errored";
		diagnostic = assistant?.errorMessage?.trim() || "Delegate produced no final result";
	}
	if (diagnostic) diagnostic = truncateUtf8(diagnostic, Math.min(profile.resultMaxBytes ?? 12_000, 2_048)).text;
	const bounded = truncateUtf8(text || diagnostic || "Delegate failed", profile.resultMaxBytes ?? 12_000);
	return {
		schema: DELEGATE_RECEIPT_SCHEMA,
		profile: profile.name,
		outcome,
		memory_body: bounded.text,
		execution_ref: child.sessionId,
		...(bounded.truncated ? { truncated: true as const } : {}),
		...(diagnostic ? { diagnostic } : {}),
	};
}

function preflightFailure(runtime: DelegateRuntime, profile: AgentProfile, error: unknown): DelegateReceipt {
	const bounded = truncateUtf8(
		error instanceof Error ? error.message : String(error),
		Math.min(profile.resultMaxBytes ?? 12_000, 2_048),
	);
	return {
		schema: DELEGATE_RECEIPT_SCHEMA,
		profile: profile.name,
		outcome: "errored",
		memory_body: bounded.text,
		execution_ref: SessionManager.inMemory(runtime.services.cwd).getSessionId(),
		...(bounded.truncated ? { truncated: true as const } : {}),
		diagnostic: bounded.text,
	};
}

async function runDelegate(
	runtime: DelegateRuntime,
	profile: AgentProfile,
	task: string,
	signal: AbortSignal | undefined,
): Promise<DelegateReceipt> {
	const models = resolveProfileModels(profile, runtime.parent.model, runtime.services.modelRuntime);
	if (models.length === 0)
		return preflightFailure(runtime, profile, `Delegate profile "${profile.name}" has no available model`);
	let lastReceipt: DelegateReceipt | undefined;
	for (const model of models) {
		let child: AgentSession;
		try {
			child = await createChild(runtime, profile, model);
		} catch (error) {
			lastReceipt = preflightFailure(runtime, profile, error);
			continue;
		}
		let toolCalls = 0;
		const unsubscribe = child.subscribe((event) => {
			if (event.type === "tool_execution_start") toolCalls++;
		});
		try {
			try {
				const state = await promptChild(
					child,
					task,
					signal,
					runtime.childExecutionDeadlineMs ?? profile.deadlineMs ?? 120_000,
				);
				lastReceipt = receiptFromChild(profile, child, state);
			} catch (error) {
				lastReceipt = {
					...preflightFailure(runtime, profile, error),
					execution_ref: child.sessionId,
				};
			}
			if (lastReceipt.outcome !== "errored" || child.getLastAssistantText()?.trim() || toolCalls > 0)
				return lastReceipt;
		} finally {
			unsubscribe();
			child.dispose();
		}
	}
	if (!lastReceipt) throw new Error(`Delegate profile "${profile.name}" did not start`);
	return lastReceipt;
}

export function createDelegateTool(getRuntime: () => DelegateRuntime | undefined): ToolDefinition {
	const prompt = loadToolPromptDoc("tools/delegate");
	return defineTool({
		name: "delegate",
		label: "Delegate",
		description: prompt.brief,
		promptSnippet: prompt.brief,
		promptGuidelines: [prompt.guidance],
		parameters: Type.Object(
			{
				profile: Type.String({ minLength: 1 }),
				task: Type.String({ minLength: 1 }),
			},
			{ additionalProperties: false },
		),
		executionMode: "sequential",
		execute: async (_toolCallId, params, signal) => {
			const profileName = params.profile.trim();
			const task = params.task.trim();
			if (!profileName || !task) throw new Error("delegate requires non-empty profile and task");
			const profile = loadAgentProfile(profileName, "delegate");
			const runtime = getRuntime();
			if (!runtime) throw new Error("delegate runtime is not bound");
			const receipt = await runDelegate(runtime, profile, task, signal);
			return { content: [{ type: "text", text: JSON.stringify(receipt) }], details: receipt };
		},
		renderResult: (result, options, theme) => {
			const receipt = result.details as DelegateReceipt | undefined;
			if (!receipt) {
				const content = result.content[0];
				return new Text(content?.type === "text" ? content.text : "", 0, 0);
			}
			const heading = theme.fg(
				receipt.outcome === "completed" ? "success" : receipt.outcome === "aborted" ? "warning" : "error",
				`Delegate finished · ${receipt.profile} · ${receipt.outcome}${receipt.truncated ? " · truncated" : ""}`,
			);
			const body = options.expanded
				? receipt.memory_body
				: receipt.memory_body.split(/\r?\n/).filter(Boolean).slice(0, 3).join("\n");
			return new Text(`${heading}${body ? `\n${theme.fg("toolOutput", body)}` : ""}`, 0, 0);
		},
	});
}
