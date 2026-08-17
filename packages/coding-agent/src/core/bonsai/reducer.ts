import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import {
	buildContextEntries,
	type SessionEntry,
	type SessionMessageEntry,
	sessionEntryToContextMessages,
} from "../session-manager.ts";
import type {
	MemorySlot,
	NodeId,
	ProjectionItem,
	SpawnReceipt,
	SpawnTask,
	SpineEvent,
	SpineNode,
	SpineSnapshot,
	SpineToolCall,
	SpineToolGroup,
	TrimEdit,
	TrimOperation,
	TrimRequest,
} from "./model.ts";
import { TRIM_THRESHOLD_BYTES } from "./model.ts";

type NodeEntry = { kind: "item"; item: ProjectionItem } | { kind: "child"; nodeId: NodeId };

interface RuntimeNode extends SpineNode {
	baseline: ProjectionItem[];
	entries: NodeEntry[];
}

type StructuralControl =
	| { kind: "open"; goal: string }
	| { kind: "close"; memory: string }
	| { kind: "next"; goal: string; memory: string }
	| { kind: "spawn"; tasks: SpawnTask[]; receipt: SpawnReceipt };

function textContent(message: AgentMessage): string {
	if (!("content" in message)) return "";
	if (typeof message.content === "string") return message.content;
	return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

function toolCalls(
	message: AssistantMessage,
): Array<Extract<AssistantMessage["content"][number], { type: "toolCall" }>> {
	return message.content.filter(
		(part): part is Extract<AssistantMessage["content"][number], { type: "toolCall" }> => part.type === "toolCall",
	);
}

function strictStrings(value: unknown, keys: string[]): Record<string, string> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (Object.keys(record).length !== keys.length || keys.some((key) => typeof record[key] !== "string")) {
		return undefined;
	}
	const parsed: Record<string, string> = {};
	for (const key of keys) {
		const trimmed = (record[key] as string).trim();
		if (!trimmed) return undefined;
		parsed[key] = trimmed;
	}
	return parsed;
}

function classifyControl(group: SpineToolGroup): StructuralControl | undefined {
	if (group.calls.some((call) => call.outcome === "unknown")) return undefined;
	const structuralCalls = group.calls.filter((call) =>
		["spine_open", "spine_close", "spine_next", "spine_spawn"].includes(call.name),
	);
	if (structuralCalls.length !== 1) return undefined;
	const call = structuralCalls[0];
	if (!call || call.outcome !== "succeeded") return undefined;
	if (call.name === "spine_spawn") {
		const tasks = parseSpawnTasks(call?.arguments);
		const receipt = parseSpawnReceipt(call.output, tasks);
		return tasks && receipt ? { kind: "spawn", tasks, receipt } : undefined;
	}
	if (call.name === "spine_open") {
		const args = strictStrings(call.arguments, ["goal"]);
		return args ? { kind: "open", goal: args.goal } : undefined;
	}
	if (call.name === "spine_close") {
		const args = strictStrings(call.arguments, ["memory"]);
		return args ? { kind: "close", memory: args.memory } : undefined;
	}
	const args = strictStrings(call.arguments, ["goal", "memory"]);
	return args ? { kind: "next", goal: args.goal, memory: args.memory } : undefined;
}

function parseSpawnTasks(value: unknown): SpawnTask[] | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (
		Object.keys(record).length !== 1 ||
		!Array.isArray(record.tasks) ||
		record.tasks.length < 2 ||
		record.tasks.length > 4
	) {
		return undefined;
	}
	const tasks: SpawnTask[] = [];
	for (const value of record.tasks) {
		if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
		const task = value as Record<string, unknown>;
		if (
			Object.keys(task).length !== 2 ||
			typeof task.summary !== "string" ||
			!task.summary.trim() ||
			typeof task.prompt !== "string" ||
			!task.prompt.trim()
		) {
			return undefined;
		}
		tasks.push({ summary: task.summary.trim(), prompt: task.prompt.trim() });
	}
	return new Set(tasks.map((task) => task.summary)).size === tasks.length ? tasks : undefined;
}

function parseSpawnReceipt(output: string | undefined, tasks: SpawnTask[] | undefined): SpawnReceipt | undefined {
	if (!output || !tasks) return undefined;
	let value: unknown;
	try {
		value = JSON.parse(output);
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const receipt = value as Record<string, unknown>;
	if (
		Object.keys(receipt).length !== 2 ||
		receipt.schema !== "spine.spawn.result.v1" ||
		!Array.isArray(receipt.results) ||
		receipt.results.length !== tasks.length
	) {
		return undefined;
	}
	const results: SpawnReceipt["results"] = [];
	for (let ordinal = 0; ordinal < receipt.results.length; ordinal++) {
		const value = receipt.results[ordinal];
		if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
		const result = value as Record<string, unknown>;
		const allowed = new Set(["ordinal", "outcome", "memory_body", "diagnostic", "execution_ref"]);
		if (Object.keys(result).some((key) => !allowed.has(key))) return undefined;
		if (
			result.ordinal !== ordinal ||
			(result.outcome !== "completed" && result.outcome !== "errored" && result.outcome !== "aborted") ||
			typeof result.memory_body !== "string" ||
			!result.memory_body.trim() ||
			(result.diagnostic !== undefined && (typeof result.diagnostic !== "string" || !result.diagnostic.trim())) ||
			(result.execution_ref !== undefined &&
				(typeof result.execution_ref !== "string" || !result.execution_ref.trim())) ||
			(result.outcome !== "completed" && typeof result.diagnostic !== "string")
		) {
			return undefined;
		}
		results.push({
			ordinal,
			outcome: result.outcome,
			memory_body: result.memory_body,
			...(typeof result.diagnostic === "string" ? { diagnostic: result.diagnostic } : {}),
			...(typeof result.execution_ref === "string" ? { execution_ref: result.execution_ref } : {}),
		});
	}
	return { schema: "spine.spawn.result.v1", results };
}

function isSessionMessage(entry: SessionEntry): entry is SessionMessageEntry {
	return entry.type === "message";
}

function groupAt(entries: SessionEntry[], start: number): { group: SpineToolGroup; next: number } | undefined {
	const entry = entries[start];
	if (!isSessionMessage(entry) || entry.message.role !== "assistant") return undefined;
	const calls = toolCalls(entry.message);
	if (calls.length === 0) return undefined;

	let canonical = true;
	const expectedNames = new Map<string, string>();
	for (const call of calls) {
		if (expectedNames.has(call.id)) canonical = false;
		expectedNames.set(call.id, call.name);
	}
	const results = new Map<string, { message: ToolResultMessage; boundary: number }>();
	let next = start + 1;
	while (next < entries.length) {
		const candidate = entries[next];
		if (!isSessionMessage(candidate) || candidate.message.role !== "toolResult") break;
		if (
			results.has(candidate.message.toolCallId) ||
			expectedNames.get(candidate.message.toolCallId) !== candidate.message.toolName
		) {
			canonical = false;
		} else {
			results.set(candidate.message.toolCallId, { message: candidate.message, boundary: next });
		}
		next++;
	}
	if (results.size !== calls.length) canonical = false;
	const messages = entries.slice(start, next).flatMap(sessionEntryToContextMessages);
	const parsedCalls: SpineToolCall[] = calls.map((call, ordinal) => {
		const result = results.get(call.id);
		return {
			callId: call.id,
			name: call.name,
			arguments: call.arguments,
			ordinal,
			outcome: canonical && result ? (result.message.isError ? "failed" : "succeeded") : "unknown",
			output: result ? textContent(result.message) : undefined,
			outputBoundary: result?.boundary,
		};
	});
	return {
		group: { start, end: next - 1, messages, calls: parsedCalls },
		next,
	};
}

export function lexSpineEntries(entries: SessionEntry[]): SpineEvent[] {
	const events: SpineEvent[] = [];
	for (let index = 0; index < entries.length; ) {
		const entry = entries[index];
		if (entry.type === "compaction") {
			const prefix = entries.slice(0, index + 1);
			events.push({
				kind: "compact",
				boundary: index,
				replacementHistory: buildContextEntries(prefix, entry.id).flatMap(sessionEntryToContextMessages),
			});
			index++;
			continue;
		}
		const grouped = groupAt(entries, index);
		if (grouped) {
			events.push({ kind: "tool-group", group: grouped.group });
			index = grouped.next;
			continue;
		}
		const messages = sessionEntryToContextMessages(entry);
		for (const message of messages) {
			events.push({ kind: "message", boundary: index, message });
		}
		index++;
	}
	return events;
}

export function reduceSpine(entries: SessionEntry[]): SpineSnapshot {
	return reduceSpineEvents(lexSpineEntries(entries));
}

export function reduceSpineEvents(events: SpineEvent[]): SpineSnapshot {
	const rootId: NodeId = [1];
	const nodes: RuntimeNode[] = [
		{
			id: rootId,
			children: [],
			kind: "root",
			status: "live",
			goal: "root",
			start: 0,
			baseline: [],
			entries: [],
		},
	];
	let cursor = rootId;
	let epoch = 1;
	let nextUserAnchor = 1;

	const findNode = (id: NodeId): RuntimeNode => {
		const node = nodes.find(
			(candidate) => candidate.id.length === id.length && candidate.id.every((part, i) => part === id[i]),
		);
		if (!node) throw new Error(`Missing Bonsai node ${id.join(".")}`);
		return node;
	};
	const push = (item: ProjectionItem): void => {
		findNode(cursor).entries.push({ kind: "item", item });
	};
	const assembleMemory = (node: RuntimeNode, body: string): MemorySlot[] => {
		const memory: MemorySlot[] = [];
		for (const entry of node.entries) {
			if (entry.kind === "child") {
				memory.push(...(findNode(entry.nodeId).memory ?? []));
				continue;
			}
			if (entry.item.kind !== "raw") continue;
			entry.item.messages.forEach((message, index) => {
				const anchor = entry.item.kind === "raw" ? entry.item.userAnchors[index] : undefined;
				if (message.role === "user" && anchor !== undefined) {
					memory.push({ kind: "user", ownerNode: node.id, message, anchor });
				}
			});
		}
		memory.push({ kind: "summary", ownerNode: node.id, body });
		return memory;
	};

	for (const event of events) {
		if (event.kind === "message") {
			const anchor = event.message.role === "user" ? nextUserAnchor++ : undefined;
			push({ kind: "raw", messages: [event.message], boundaries: [event.boundary], userAnchors: [anchor] });
			continue;
		}
		if (event.kind === "compact") {
			for (const node of nodes.filter((candidate) => candidate.id[0] === epoch && candidate.status !== "closed")) {
				node.status = "compacted";
				node.end ??= event.boundary;
			}
			epoch++;
			cursor = [epoch];
			nodes.push({
				id: cursor,
				children: [],
				kind: "root",
				status: "live",
				goal: "root",
				start: event.boundary,
				baseline: event.replacementHistory.map((message) => ({
					kind: "raw",
					messages: [message],
					boundaries: [undefined],
					userAnchors: [undefined],
				})),
				entries: [],
			});
			continue;
		}

		const raw: ProjectionItem = {
			kind: "raw",
			messages: event.group.messages,
			boundaries: event.group.messages.map((_, index) => event.group.start + index),
			userAnchors: event.group.messages.map(() => undefined),
		};
		const control = classifyControl(event.group);
		const current = findNode(cursor);
		if (control?.kind === "open") {
			const childId = [...current.id, current.children.length + 1];
			current.children.push(childId);
			current.entries.push({ kind: "child", nodeId: childId });
			current.status = "opened";
			nodes.push({
				id: childId,
				parent: current.id,
				children: [],
				kind: "task",
				status: "live",
				goal: control.goal,
				start: event.group.start,
				baseline: [],
				entries: [{ kind: "item", item: raw }],
			});
			cursor = childId;
			continue;
		}
		if (control?.kind === "close" && current.kind === "task" && current.parent) {
			current.memory = assembleMemory(current, control.memory);
			current.status = "closed";
			current.end = event.group.start;
			const parent = findNode(current.parent);
			parent.status = "live";
			parent.entries.push({ kind: "item", item: raw });
			cursor = parent.id;
			continue;
		}
		if (control?.kind === "next" && current.kind === "task" && current.parent) {
			current.memory = assembleMemory(current, control.memory);
			current.status = "closed";
			current.end = event.group.start;
			const parent = findNode(current.parent);
			const siblingId = [...parent.id, parent.children.length + 1];
			parent.children.push(siblingId);
			parent.entries.push({ kind: "child", nodeId: siblingId });
			parent.status = "opened";
			nodes.push({
				id: siblingId,
				parent: parent.id,
				children: [],
				kind: "task",
				status: "live",
				goal: control.goal,
				start: event.group.start,
				baseline: [],
				entries: [{ kind: "item", item: raw }],
			});
			cursor = siblingId;
			continue;
		}
		if (control?.kind === "spawn") {
			current.entries.push({ kind: "item", item: raw });
			for (let ordinal = 0; ordinal < control.tasks.length; ordinal++) {
				const task = control.tasks[ordinal];
				const result = control.receipt.results[ordinal];
				if (!task || !result) throw new Error("Validated spawn receipt lost task/result alignment");
				const childId = [...current.id, current.children.length + 1];
				const memory: MemorySlot[] = [
					{
						kind: "spawn-evidence",
						ownerNode: childId,
						task,
						outcome: result.outcome,
						...(result.diagnostic ? { diagnostic: result.diagnostic } : {}),
						...(result.execution_ref ? { executionRef: result.execution_ref } : {}),
					},
					{ kind: "summary", ownerNode: childId, body: result.memory_body },
				];
				current.children.push(childId);
				current.entries.push({ kind: "child", nodeId: childId });
				nodes.push({
					id: childId,
					parent: current.id,
					children: [],
					kind: "task",
					status: "closed",
					goal: task.summary,
					memory,
					start: event.group.start,
					end: event.group.end,
					baseline: [],
					entries: [],
				});
			}
			continue;
		}
		push(raw);
	}

	const visibleContext: ProjectionItem[] = [];
	const renderEntries = (entries: NodeEntry[]): void => {
		for (const entry of entries) {
			if (entry.kind === "item") {
				visibleContext.push(entry.item);
				continue;
			}
			const child = findNode(entry.nodeId);
			if (child.status === "closed") {
				visibleContext.push(...(child.memory ?? []).map((slot): ProjectionItem => ({ kind: "memory", slot })));
			} else if (child.status === "live" || child.status === "opened") {
				visibleContext.push({ kind: "node", nodeId: child.id, goal: child.goal });
				renderEntries(child.entries);
			}
		}
	};
	const root = findNode([epoch]);
	visibleContext.push(...root.baseline);
	renderEntries(root.entries);

	return {
		nodes: nodes.map(({ baseline: _baseline, entries: _entries, ...node }) => node),
		cursor: [...cursor],
		epoch,
		visibleContext,
		trimEdits: deriveTrimProjection(events),
	};
}

function parseNonNegativeInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

export function parseTrimRequest(value: unknown): TrimRequest | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const args = value as Record<string, unknown>;
	const trimId = typeof args.TRIM_ID === "string" ? args.TRIM_ID.trim() : "";
	if (!trimId || (args.op !== "snip" && args.op !== "slice")) return undefined;
	if (args.op === "snip") {
		return Object.keys(args).length === 2 ? { TRIM_ID: trimId, operation: { op: "snip" } } : undefined;
	}
	const shapes = ["head", "tail", "anchor"].filter((key) => args[key] !== undefined);
	if (shapes.length !== 1) return undefined;
	if (shapes[0] === "head" && Object.keys(args).length === 3) {
		const head = parseNonNegativeInteger(args.head);
		return head === undefined ? undefined : { TRIM_ID: trimId, operation: { op: "slice", head } };
	}
	if (shapes[0] === "tail" && Object.keys(args).length === 3) {
		const tail = parseNonNegativeInteger(args.tail);
		return tail === undefined ? undefined : { TRIM_ID: trimId, operation: { op: "slice", tail } };
	}
	if (Object.keys(args).length !== 5 || typeof args.anchor !== "string" || !args.anchor.trim()) return undefined;
	const preceding = parseNonNegativeInteger(args.preceding);
	const following = parseNonNegativeInteger(args.following);
	return preceding === undefined || following === undefined
		? undefined
		: { TRIM_ID: trimId, operation: { op: "slice", anchor: args.anchor.trim(), preceding, following } };
}

function sliceText(body: string, operation: Exclude<TrimOperation, { op: "snip" }>): string | undefined {
	if ("head" in operation) return Array.from(body).slice(0, operation.head).join("");
	if ("tail" in operation) return operation.tail === 0 ? "" : Array.from(body).slice(-operation.tail).join("");
	const lines = body.match(/.*(?:\n|$)/g)?.filter(Boolean) ?? [];
	const anchorLine = lines.findIndex((line) => line.includes(operation.anchor));
	if (anchorLine < 0) return undefined;
	return lines.slice(Math.max(0, anchorLine - operation.preceding), anchorLine + operation.following + 1).join("");
}

export function deriveTrimProjection(events: SpineEvent[]): TrimEdit[] {
	const edits = new Map<number, TrimEdit>();
	let active: number[] = [];
	for (const event of events) {
		if (event.kind !== "tool-group") continue;
		for (const call of event.group.calls.filter(
			(candidate) => candidate.name === "spine_trim" && candidate.outcome === "succeeded",
		)) {
			const request = parseTrimRequest(call.arguments);
			if (!request) continue;
			const boundary = active.find((candidate) => {
				const edit = edits.get(candidate);
				return edit?.kind === "tagged" && edit.trimId === request.TRIM_ID;
			});
			if (boundary === undefined) continue;
			const previous = edits.get(boundary);
			if (!previous || previous.kind !== "tagged") continue;
			if (request.operation.op === "snip") {
				edits.set(boundary, { boundary, callId: previous.callId, kind: "snipped" });
				continue;
			}
			const body = sliceText(previous.body, request.operation);
			if (body !== undefined) edits.set(boundary, { boundary, callId: previous.callId, kind: "sliced", body });
		}
		active = [];
		if (event.group.calls.some((call) => call.outcome === "unknown")) continue;
		for (const call of event.group.calls) {
			if (call.name.startsWith("spine_") || call.outputBoundary === undefined || call.output === undefined) continue;
			if (new TextEncoder().encode(call.output).byteLength <= TRIM_THRESHOLD_BYTES) continue;
			const edit: TrimEdit = {
				boundary: call.outputBoundary,
				callId: call.callId,
				kind: "tagged",
				trimId: `trim_${call.outputBoundary}`,
				body: call.output,
			};
			edits.set(call.outputBoundary, edit);
			active.push(call.outputBoundary);
		}
	}
	return [...edits.values()];
}

export function validateTrimRequest(entries: SessionEntry[], toolCallId: string, value: unknown): TrimRequest {
	const request = parseTrimRequest(value);
	if (!request) throw new Error("Invalid spine.trim arguments");
	const events = lexSpineEntries(entries);
	const currentIndex = events.findIndex(
		(event) => event.kind === "tool-group" && event.group.calls.some((call) => call.callId === toolCallId),
	);
	const priorEvents = currentIndex < 0 ? events : events.slice(0, currentIndex);
	let previousGroup: SpineToolGroup | undefined;
	for (let index = priorEvents.length - 1; index >= 0; index--) {
		const event = priorEvents[index];
		if (event?.kind === "tool-group") {
			previousGroup = event.group;
			break;
		}
	}
	const activeBoundaries = new Set(
		previousGroup?.calls.every((call) => call.outcome !== "unknown")
			? previousGroup.calls.flatMap((call) =>
					!call.name.startsWith("spine_") && call.outputBoundary !== undefined ? [call.outputBoundary] : [],
				)
			: [],
	);
	const edit = deriveTrimProjection(priorEvents).find(
		(candidate) =>
			activeBoundaries.has(candidate.boundary) &&
			candidate.kind === "tagged" &&
			candidate.trimId === request.TRIM_ID,
	);
	if (!edit || edit.kind !== "tagged") {
		throw new Error(
			`spine.trim failed: previous completed toolcall does not contain TRIM_ID ${request.TRIM_ID}; do not retry`,
		);
	}
	if (request.operation.op !== "snip" && sliceText(edit.body, request.operation) === undefined) {
		throw new Error("trim slice anchor was not found; do not retry");
	}
	return request;
}
